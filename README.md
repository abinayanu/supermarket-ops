# Supermarket Ops Bot

A Telegram-based supermarket operations assistant for Indian kirana stores. The bot handles billing, inventory, GST, khata credit, payments, invoices, sales summaries, and weekly business analysis through natural-language Telegram conversations.

## Telegram Bot

**Bot:** `@abinaya_supermarket_bot`

## Features

- **Product & Inventory**
  - Search products using natural-language queries
  - Handle product ambiguity with clarification
  - Receive stock
  - Check current stock
  - Low-stock alerts

- **Billing**
  - Create draft bills
  - Add multiple products and quantities
  - Edit quantities
  - Remove items
  - Set customer reference
  - Finalize bills only after confirmation
  - Prevent overselling at the database/tool layer
  - Idempotent bill finalization

- **GST**
  - Product-level GST rates
  - HSN code support
  - CGST + SGST calculation
  - Rounded invoice totals
  - GST invoice PDF generation

- **Payments**
  - CASH
  - UPI with transaction reference
  - CARD
  - CREDIT / Khata

- **Khata**
  - Add customer credit
  - Record settlements/payments
  - Check customer balance
  - Maintain transaction history

- **Reports**
  - Daily sales summary
  - Sales split by payment mode
  - Low-stock information
  - Weekly sales analysis PPTX

- **Preferences**
  - Persist shop preferences in PostgreSQL
  - Store values such as shop name, GSTIN, default UPI, and default brands

## Safety & Reliability

- Stock is locked with `FOR UPDATE` during finalization
- Stock checks and decrements happen inside a database transaction
- Overselling is rejected
- Draft bills do not decrement stock
- Stock is decremented only when a bill is finalized
- Finalization requires explicit confirmation
- Bill finalization uses idempotency keys to prevent duplicate billing
- Core business rules are implemented in application services/tools rather than relying only on prompts

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Agent:** LLM-based tool-calling agent
- **LLM:** Groq API (`openai/gpt-oss-120b`)
- **Database:** PostgreSQL
- **Telegram:** Telegraf
- **PDF:** PDFKit
- **PPTX:** PptxGenJS

## Architecture

```text
Telegram
   |
   v
agent/telegram-bot.ts
   |
   v
agent/llm-agent.ts
   |
   +--------------------+
   |                    |
   v                    v
Agent Tools          Session / Memory
   |                    |
   v                    v
Services             PostgreSQL
   |
   +--> Billing
   +--> Stock
   +--> Khata
   +--> PDF Invoice
   +--> PPTX Reports

The LLM is responsible for understanding the user's request and orchestrating tools. Core business rules such as stock safety, GST calculations, transactions, and idempotency are enforced in the application and database layer.

Project Structure
supermarket-ops/
├── agent/
│   ├── llm-agent.ts
│   ├── session.service.ts
│   ├── telegram-bot.ts
│   ├── tools.ts
│   └── vercel-agent.ts
│
├── services/
│   ├── billing.service.ts
│   ├── db.ts
│   ├── khata.service.ts
│   ├── pdf-invoice.ts
│   ├── pptx-report.ts
│   ├── schema.sql
│   └── stock.service.ts
│
├── .env
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
Tools
Tool	Purpose
createDraftBill	Start a new draft bill
addLineItem	Add a product to a bill
removeLineItem	Remove a bill item
updateLineItemQuantity	Change item quantity
setBillCustomer	Set customer reference
finalizeBill	Finalize bill and deduct stock
getProductStock	Check stock level
getLowStockItems	Find low-stock products
addKhataCredit	Add customer credit
addKhataPayment	Record customer settlement
getKhataBalance	Check customer balance
setPreference	Persist shop preference
getPreference	Retrieve shop preference
generateInvoice	Generate GST invoice PDF
generateAnalysisDeck	Generate weekly PPTX analysis
Control Loop
User sends a message in Telegram.
telegram-bot.ts receives the message.
llm-agent.ts interprets the request.
The agent selects and calls the required tools.
Tools execute business operations through PostgreSQL-backed services.
Tool results are returned to the agent.
The agent continues the control loop when additional actions are required.
The final response or generated artifact is sent back through Telegram.
Hard Parts Implementation
Idempotency

Each bill finalization uses an idempotency key. If the same key is submitted again, the existing finalized bill is returned instead of creating a duplicate transaction.

Atomic Stock Decrement

Bill finalization runs inside a database transaction. Products are locked using FOR UPDATE, all stock levels are checked before decrementing, and the transaction rolls back if any item cannot be fulfilled.

Stock Safety

Stock is not reduced while a bill is still a draft. Stock is reduced only after the bill is successfully finalized.

Clarification Behavior

When multiple products match a request, the agent asks the user to select the correct product before adding it to the bill or receiving stock.

Confirmation

Finalization and cancellation require explicit user confirmation to avoid accidental financial or inventory operations.

Setup
Requirements
Node.js
PostgreSQL
Telegram Bot Token
Groq API Key
Install Dependencies
npm install
Environment Variables

Create a .env file:

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
GROQ_API_KEY=your_groq_api_key
DATABASE_URL=postgresql://localhost/supermarket_ops


Never commit .env or API keys to GitHub.

Database Setup

Create the PostgreSQL database and apply the schema:

psql -d supermarket_ops -f services/schema.sql
TypeScript Check
npx tsc --noEmit
Run the Bot
npx tsx agent/telegram-bot.ts
Example Conversations
Product Search and Billing
User: Add 2 Maggi 70g

Bot: Which Maggi would you like?
1. Maggi 70g
2. Maggi Masala 6-pack

User: 1

Bot: Added 2 Maggi 70g to the draft bill.
Stock Query
User: Show low stock items below 10

Bot: Returns active products whose current stock is below the requested threshold.
Payment
User: Finalize this bill with UPI reference TXN9999

Bot: Shows the bill details and asks for confirmation before finalization.
Generated Artifacts

The bot can generate real business artifacts through Telegram:

GST invoice PDF
Weekly sales analysis PPTX
Deployment

The production bot handle is:

@abinaya_supermarket_bot

Required environment variables:

TELEGRAM_BOT_TOKEN
GROQ_API_KEY
DATABASE_URL

PostgreSQL must use persistent storage in production.

Demo Flow

Recommended demonstration flow:

Receive stock
Search/select a product
Create a multi-item bill
Edit a quantity
Demonstrate oversell protection
Finalize with payment mode
Generate invoice PDF
Add/check Khata credit
Show daily sales summary
Generate weekly PPTX
Demonstrate persistent preferences