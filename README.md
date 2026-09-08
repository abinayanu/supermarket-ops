# Supermarket Ops Bot

A Telegram bot for managing supermarket operations: billing, inventory, khata (credit), and analytics.

## Features

### High Priority (Completed)

- ✅ **Bill Editing**: Remove items, update quantities mid-bill
- ✅ **Stock Query**: Check stock levels, get low-stock alerts
- ✅ **Khata Full Flow**: Add credit, add payment/settlement, check balance, view history
- ✅ **Payment Details**: Support for cash, UPI, card payments with UPI reference
- ✅ **Preferences Memory**: Persist shop name, GSTIN, default UPI, default brands
- ✅ **Weekly Sales PPTX**: Generate sales analysis deck with charts
- ✅ **LLM Agent Harness**: Multi-step tool calls via Groq/GPT
- ✅ **Stock Safety**: Atomic stock decrement on bill finalization
- ✅ **Idempotency**: Prevent duplicate billing on retries

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **LLM**: Groq API (GPT-OSS-120B)
- **Database**: PostgreSQL
- **Telegram**: Telegraf bot framework
- **PDF**: PDFKit for invoices
- **PPTX**: pptx package for reports

## Project Structure


## Tools Design

The LLM agent uses these tools:

| Tool | Purpose |
|------|---------|
| `createDraftBill` | Start a new bill |
| `addLineItem` | Add product to bill |
| `removeLineItem` | Remove item from bill |
| `updateLineItemQuantity` | Change quantity |
| `setBillCustomer` | Link bill to khata customer |
| `finalizeBill` | Complete bill, deduct stock |
| `getProductStock` | Check stock level |
| `getLowStockItems` | Get items below threshold |
| `addKhataCredit` | Add credit to customer |
| `addKhataPayment` | Add settlement/payment |
| `getKhataBalance` | Check customer balance |
| `getKhataHistory` | View transaction history |
| `setPreference` | Save shop preference |
| `getPreference` | Retrieve preference |
| `generateInvoice` | Create GST PDF |
| `generateAnalysisDeck` | Create PPTX report |

## Control Loop

1. Telegram message → `llm-agent.ts`
2. LLM parses intent, selects tools
3. Tools execute sequentially
4. Results fed back to LLM
5. Final response sent to Telegram

## Hard Parts Implementation

### Idempotency
- Each bill finalize has `idempotency_key`
- Duplicate key returns existing bill
- Prevents double stock deduction

### Atomic Stock Decrement
- `finalizeBill` runs in transaction
- Stock locked with `FOR UPDATE`
- All items checked before any decrement
- Rollback on any failure

### Clarification Behavior
- LLM asks "Which atta?" if multiple matches
- Ambiguity logged to `shortcut_candidates`
- Repeated resolutions become shortcuts

## Setup

1. Install dependencies: `npm install`
2. Set env vars in `.env`:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
   - `DATABASE_URL`
3. Compile: `tsc ... --outDir dist`
4. Run: `node dist/agent/telegram-bot.js`

## Demo Recording (Pending)

Record 4-5 mins:
- Stock-in → Bill → Edit → Oversell → Khata → Invoice PDF → PPTX → Preference persistence

## Deployment

Deploy to Render/Railway/Fly.io:
- Set env vars
- Ensure public URL for webhook
- Bot username: `@your_bot_username`