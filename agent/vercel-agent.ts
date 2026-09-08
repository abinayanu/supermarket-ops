import 'dotenv/config';

import {
  generateText,
  tool,
  stepCountIs
} from 'ai';

import { openai } from '@ai-sdk/openai';

import { z } from 'zod';

import {
  toolFindProduct,
  toolCreateDraftBill,
  toolSetBillCustomer,
  toolAddLineItem,
  toolGetDraftBill,
  toolFinalizeBill,
  toolRemoveLineItem,
  toolUpdateLineItemQuantity,
  toolGetStockLevel,
  toolGetLowStockItems,
  toolReceiveStock,
  toolAddKhataCredit,
  toolAddKhataPayment,
  toolGetCustomerBalance,
  toolGenerateInvoice,
  toolSetPreference,
  toolGetPreference,
  toolGetDailySalesSummary,
  toolGenerateAnalysisDeck
} from './tools';

import {
  getActiveBillId,
  setActiveBillId,
  getPendingFinalization,
  setPendingFinalization,
  clearPendingFinalization,
  getLastFinalizedBillId,
  setLastFinalizedBillId
} from './session.service';

/* =========================================================
   SYSTEM PROMPT
   ========================================================= */

const SYSTEM_PROMPT = `
You are a supermarket operations assistant for an Indian kirana store.

You operate the store through real database-backed tools.

CORE RULES:

1. Always use tools for product, price, stock and bill information.
2. Never invent product prices, stock quantities or GST rates.
3. If a product name is ambiguous, ask the owner which product they mean.
4. Never oversell stock.
5. Stock must be decremented only when a bill is finalized.
6. Bills can be created across multiple turns.
7. Bills can be edited before finalization.
8. GST must come from the product/database information.
9. For Tamil Nadu intra-state sales, GST is split into CGST and SGST by the billing service.
10. Payment modes are cash, UPI and card.
11. UPI payments may include a reference.
12. Khata means customer credit owed to the store.
13. Never claim that a bill is finalized unless the finalize tool succeeds.
14. Never claim an invoice exists unless the invoice tool succeeds.
15. Preferences must be persisted using the preference tools.
16. Never perform business calculations when the database/service can provide the result.
17. Before finalization, show the bill and request confirmation from the owner.

AVAILABLE CAPABILITIES:

- Find products
- Create draft bills
- Set bill customer
- Add items
- Remove items
- Change item quantity
- View draft bill
- Finalize bill
- Receive stock
- Check stock
- Check low-stock items
- Add khata credit
- Record khata payment
- Check khata balance
- Generate PDF invoice
- Get daily sales summary
- Generate analysis deck
- Set preferences
- Read preferences

When a request requires a tool, call the appropriate tool instead of guessing.
`;

/* =========================================================
   TOOL DEFINITIONS
   ========================================================= */

const tools = {

  /* -------------------------------------------------------
     PRODUCT SEARCH
     ------------------------------------------------------- */

  find_product: tool({
    description:
      'Find products by name, SKU or product description. Use this before selling when the exact product is not known.',

    inputSchema: z.object({
      product_query: z
        .string()
        .min(1)
        .describe(
          'Product name, SKU or search text'
        )
    }),

    execute: async ({
      product_query
    }) => {
      return await toolFindProduct(
        product_query
      );
    }
  }),

  /* -------------------------------------------------------
     CREATE BILL
     ------------------------------------------------------- */

  create_draft_bill: tool({
    description:
      'Create a new draft bill. Do not finalize it.',

    inputSchema: z.object({
      customer_name: z
        .string()
        .optional()
        .describe(
          'Customer name. Leave empty for Cash customer.'
        )
    }),

    execute: async ({
      customer_name
    }, { toolCallId }) => {
      void toolCallId;

      const existingBillId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (existingBillId) {
        return {
          billId: existingBillId,
          status: 'already_exists'
        };
      }

      const result =
        await toolCreateDraftBill(
          customer_name ?? null,
          CURRENT_CHAT_ID
        );

      setActiveBillId(
        CURRENT_CHAT_ID,
        result.billId
      );

      return result;
    }
  }),

  /* -------------------------------------------------------
     SET CUSTOMER
     ------------------------------------------------------- */

  set_bill_customer: tool({
    description:
      'Set or change the customer name on the current draft bill.',

    inputSchema: z.object({
      customer_name: z
        .string()
        .min(1)
        .describe(
          'Customer name'
        )
    }),

    execute: async ({
      customer_name
    }) => {

      const billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {
        return {
          error:
            'There is no active draft bill.'
        };
      }

      return await toolSetBillCustomer(
        billId,
        customer_name
      );
    }
  }),

  /* -------------------------------------------------------
     ADD LINE ITEM
     ------------------------------------------------------- */

  add_line_item: tool({
    description:
      'Add a product and quantity to the current draft bill. Product must be identified using the product search tool if necessary.',

    inputSchema: z.object({
      product_id: z
        .string()
        .describe(
          'Exact product UUID returned by find_product'
        ),

      quantity: z
        .number()
        .positive()
        .describe(
          'Quantity to add'
        )
    }),

    execute: async ({
      product_id,
      quantity
    }) => {

      let billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {

        const newBill =
          await toolCreateDraftBill(
            null,
            CURRENT_CHAT_ID
          );

        billId =
          newBill.billId;

        setActiveBillId(
          CURRENT_CHAT_ID,
          billId
        );
      }

      return await toolAddLineItem(
        billId,
        product_id,
        quantity
      );
    }
  }),

  /* -------------------------------------------------------
     REMOVE LINE ITEM
     ------------------------------------------------------- */

  remove_line_item: tool({
    description:
      'Remove an item from the current draft bill.',

    inputSchema: z.object({
      product_id: z
        .string()
        .describe(
          'Exact product UUID'
        )
    }),

    execute: async ({
      product_id
    }) => {

      const billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {
        return {
          error:
            'There is no active draft bill.'
        };
      }

      return await toolRemoveLineItem(
        billId,
        product_id
      );
    }
  }),

  /* -------------------------------------------------------
     UPDATE QUANTITY
     ------------------------------------------------------- */

  update_line_item_quantity: tool({
    description:
      'Change the quantity of an existing item in the draft bill.',

    inputSchema: z.object({
      product_id: z
        .string()
        .describe(
          'Exact product UUID'
        ),

      quantity: z
        .number()
        .positive()
        .describe(
          'New quantity'
        )
    }),

    execute: async ({
      product_id,
      quantity
    }) => {

      const billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {
        return {
          error:
            'There is no active draft bill.'
        };
      }

      return await toolUpdateLineItemQuantity(
        billId,
        product_id,
        quantity
      );
    }
  }),

  /* -------------------------------------------------------
     GET DRAFT BILL
     ------------------------------------------------------- */

  get_draft_bill: tool({
    description:
      'Show the current draft bill including items and total.',

    inputSchema: z.object({}),

    execute: async () => {

      const billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {
        return {
          activeBill: false,
          message:
            'No active draft bill exists.'
        };
      }

      return await toolGetDraftBill(
        billId
      );
    }
  }),

  /* -------------------------------------------------------
     FINALIZE BILL
     ------------------------------------------------------- */

  request_finalize_confirmation: tool({
    description:
      'Prepare the current draft bill for owner confirmation. This does NOT finalize the bill.',

    inputSchema: z.object({}),

    execute: async () => {

      const billId =
        getActiveBillId(
          CURRENT_CHAT_ID
        );

      if (!billId) {
        return {
          ready: false,
          message:
            'No active draft bill exists.'
        };
      }

      const bill =
        await toolGetDraftBill(
          billId
        );

      if (
        !bill.activeBill ||
        !bill.items ||
        bill.items.length === 0
      ) {
        return {
          ready: false,
          message:
            'The draft bill has no items.'
        };
      }

      const idempotencyKey =
        crypto.randomUUID();

      setPendingFinalization(
  CURRENT_CHAT_ID,
  billId,
  idempotencyKey,
  'CASH',
  undefined
);

      return {
        ready: true,
        bill,
        confirmationMessage:
          'Please confirm finalization. Reply Yes or Confirm to complete this bill.'
      };
    }
  }),

  /* -------------------------------------------------------
     STOCK
     ------------------------------------------------------- */

  get_stock_level: tool({
    description:
      'Check the current stock level for a product.',

    inputSchema: z.object({
      product_id: z
        .string()
        .describe(
          'Exact product UUID'
        )
    }),

    execute: async ({
      product_id
    }) => {

      return await toolGetStockLevel(
        product_id
      );
    }
  }),

  get_low_stock_items: tool({
    description:
      'Find products whose stock is at or below the requested threshold.',

    inputSchema: z.object({
      threshold: z
        .number()
        .positive()
        .optional()
        .describe(
          'Stock threshold'
        )
    }),

    execute: async ({
      threshold
    }) => {

      return await toolGetLowStockItems(
        threshold ?? 10
      );
    }
  }),

  receive_stock: tool({
    description:
      'Record newly received stock for an existing product.',

    inputSchema: z.object({
      product_id: z
        .string()
        .describe(
          'Exact product UUID'
        ),

      quantity: z
        .number()
        .positive()
        .describe(
          'Quantity received'
        )
    }),

    execute: async ({
      product_id,
      quantity
    }) => {

      return await toolReceiveStock(
        product_id,
        quantity
      );
    }
  }),

  /* -------------------------------------------------------
     KHATA
     ------------------------------------------------------- */

  add_khata_credit: tool({
    description:
      'Add a credit amount to a customer khata.',

    inputSchema: z.object({
      customer_name: z
        .string()
        .min(1),

      amount: z
        .number()
        .positive(),

      note: z
        .string()
        .optional()
    }),

    execute: async ({
      customer_name,
      amount,
      note
    }) => {

      return await toolAddKhataCredit(
        customer_name,
        amount,
        note
      );
    }
  }),

  add_khata_payment: tool({
    description:
      'Record a payment made by a customer toward their khata balance.',

    inputSchema: z.object({
      customer_name: z
        .string()
        .min(1),

      amount: z
        .number()
        .positive(),

      payment_mode: z
        .enum([
          'cash',
          'upi',
          'card'
        ])
        .default('cash'),

      reference: z
        .string()
        .optional()
    }),

    execute: async ({
      customer_name,
      amount,
      payment_mode,
      reference
    }) => {

      return await toolAddKhataPayment(
        customer_name,
        amount,
        payment_mode,
        reference
      );
    }
  }),

  get_customer_balance: tool({
    description:
      'Get the current khata balance for a customer.',

    inputSchema: z.object({
      customer_name: z
        .string()
        .min(1)
    }),

    execute: async ({
      customer_name
    }) => {

      return await toolGetCustomerBalance(
        customer_name
      );
    }
  }),

  /* -------------------------------------------------------
     PDF
     ------------------------------------------------------- */

  generate_invoice: tool({
    description:
      'Generate a PDF invoice for the last finalized bill or a specified finalized bill.',

    inputSchema: z.object({
      bill_id: z
        .string()
        .optional()
        .describe(
          'Finalized bill ID. If omitted, use the last finalized bill.'
        )
    }),

    execute: async ({
      bill_id
    }) => {

      const actualBillId =
        bill_id ||
        getLastFinalizedBillId(
          CURRENT_CHAT_ID
        );

      if (!actualBillId) {
        return {
          error:
            'No finalized bill found.'
        };
      }

      const pdfBuffer =
        await toolGenerateInvoice(
          actualBillId
        );

      return {
        ok: true,
        billId: actualBillId,
        pdfBase64:
          pdfBuffer.toString(
            'base64'
          ),
        fileName:
          `invoice-${actualBillId.slice(
            0,
            8
          )}.pdf`,
        mimeType:
          'application/pdf'
      };
    }
  }),

  /* -------------------------------------------------------
     PREFERENCES
     ------------------------------------------------------- */

  set_preference: tool({
    description:
      'Persist a store-owner preference so it survives future chats.',

    inputSchema: z.object({
      key: z
        .string()
        .min(1),

      value: z
        .string()
        .min(1)
    }),

    execute: async ({
      key,
      value
    }) => {

      return await toolSetPreference(
        CURRENT_CHAT_ID,
        key,
        value
      );
    }
  }),

  get_preference: tool({
    description:
      'Read a previously stored owner preference.',

    inputSchema: z.object({
      key: z
        .string()
        .min(1)
    }),

    execute: async ({
      key
    }) => {

      return await toolGetPreference(
        CURRENT_CHAT_ID,
        key
      );
    }
  }),

  /* -------------------------------------------------------
     DAILY SALES
     ------------------------------------------------------- */

  get_daily_sales_summary: tool({
    description:
      'Get the daily sales summary.',

    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe(
          'Date in YYYY-MM-DD format'
        )
    }),

    execute: async ({
      date
    }) => {

      return await toolGetDailySalesSummary(
        date
      );
    }
  }),

  /* -------------------------------------------------------
     PPTX
     ------------------------------------------------------- */

  generate_analysis_deck: tool({
    description:
      'Generate a PowerPoint analysis deck for the requested sales period.',

    inputSchema: z.object({
      period: z
        .enum([
          'day',
          'week',
          'month'
        ])
        .default('week')
    }),

    execute: async ({
      period
    }) => {

      const pptxBuffer =
        await toolGenerateAnalysisDeck(
          CURRENT_CHAT_ID,
          period
        );

      return {
        ok: true,
        pptxBase64:
          pptxBuffer.toString(
            'base64'
          ),
        fileName:
          `analysis-${period}.pptx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      };
    }
  })
};

/* =========================================================
   CURRENT CHAT CONTEXT
   ========================================================= */

let CURRENT_CHAT_ID = 0;

/* =========================================================
   MAIN AGENT HANDLER
   ========================================================= */

export async function handleWithVercelAgent(
  chatId: number,
  message: string
): Promise<string> {

  CURRENT_CHAT_ID = chatId;

  try {

    const result =
      await generateText({
        model: openai(
          'gpt-4o-mini'
        ),

        system:
          SYSTEM_PROMPT,

        messages: [
          {
            role: 'user',
            content: message
          }
        ],

        tools,

        stopWhen:
          stepCountIs(8)
      });

    return (
      result.text ||
      'I could not understand that request.'
    );

  } catch (error: unknown) {

    console.error(
      'Vercel agent error:',
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : 'Could not process request';

    return `Error: ${message}`;
  }
}