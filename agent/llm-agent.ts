import 'dotenv/config';
import OpenAI from 'openai';
import * as crypto from 'crypto';

import {
  getActiveBillId,
  setActiveBillId,
  setPendingFinalization,
  getPendingFinalization,
  clearPendingFinalization,
  setLastFinalizedBillId,
  getLastFinalizedBillId,
  setPendingProductChoices,
  getPendingProductChoices,
  clearPendingProductChoices,
  setPendingCancellation,
  getPendingCancellation,
  clearPendingCancellation
} from './session.service';

import {
  toolAddLineItem,
  toolCreateDraftBill,
  toolFinalizeBill,
  toolFindProduct,
  toolGetCustomerBalance,
  toolGetDraftBill,
  toolSetBillCustomer,
  toolGenerateInvoice,
  toolRemoveLineItem,
  toolUpdateLineItemQuantity,
  toolGetStockLevel,
  toolGetLowStockItems,
  toolAddKhataCredit,
  toolAddKhataPayment,
  toolSetPreference as toolSetPref,
  toolGetPreference as toolGetPref,
  toolGetDailySalesSummary,
  toolGenerateAnalysisDeck,
  toolReceiveStock
} from './tools';


// ============================================================
// GROQ CONFIGURATION
// ============================================================

const apiKey = process.env.GROQ_API_KEY;

const model =
  process.env.GROQ_MODEL ||
  'openai/gpt-oss-120b';

if (!apiKey) {
  throw new Error(
    'GROQ_API_KEY is missing from .env'
  );
}

const openai = new OpenAI({
  apiKey,
  baseURL:
    'https://api.groq.com/openai/v1'
});


// ============================================================
// CONFIRMATION / CANCELLATION PHRASES
// ============================================================

const YES_PHRASES = new Set([
  'yes',
  'y',
  'confirm',
  'confirmed',
  'seri',
  'சரி',
  'ஆம்',
  'ஆமா'
]);

const NO_PHRASES = new Set([
  'no',
  'n',
  'vendam',
  'venam',
  'வேண்டாம்',
  'வேண்டா'
]);

const CANCEL_REQUEST_PHRASES = new Set([
  'cancel',
  'cancel bill',
  'cancel the bill',
  'discard bill',
  'discard the bill',
  'delete bill',
  'stop bill',
  'bill cancel',
  'bill cancel pannu',
  'bill ah cancel pannu',
  'cancel this bill'
]);


// ============================================================
// SYSTEM PROMPT
// ============================================================

const systemPrompt = `
You are a supermarket operations assistant for a shop owner.

The owner may write in English, Tamil, or Tanglish.

You must use tools to read or change business data.
Never invent product, stock, bill, price, GST, customer balance,
payment, or order details.

Rules:

1. Use find_product before adding a product to a bill.

2. Use find_product before receiving stock when the product
   is specified by name.

3. When calling find_product, always specify the operation:
   - ADD_TO_BILL when the owner wants to sell/add an item to a bill.
   - RECEIVE_STOCK when the owner wants to receive stock.

4. If multiple plausible products are returned, ask the owner
   to choose the correct product.

5. For ADD_TO_BILL:
   - A draft bill is required before adding a line item.
   - If there is no active bill, create a draft bill first.

6. For RECEIVE_STOCK:
   - Do NOT create a draft bill.
   - Do NOT require an active draft bill.
   - Receive stock directly using receive_stock.

7. After adding or editing items, use get_draft_bill when
   the owner asks to see the current bill.

8. Before finalization, call get_draft_bill and show a clear
   bill summary.

9. When the owner asks to finalize, call only
   request_finalize_confirmation.

10. When the owner asks to cancel, discard, or stop the active
    draft bill, call only request_cancel_confirmation.

11. Never finalize automatically.

12. Never cancel a draft automatically.

13. The owner must explicitly confirm finalization with
    Yes, Confirm, Seri, or equivalent.

14. The owner must explicitly confirm cancellation with
    Yes, Confirm, Seri, or equivalent.

15. If cancellation confirmation is pending, do not finalize
    the bill.

16. If finalization confirmation is pending, do not finalize
    until the owner explicitly confirms.

17. For customer balance requests, use get_customer_balance.

18. For PDF invoice requests, use generate_invoice.
    If no bill_id is supplied, use the most recent finalized bill.

19. For stock queries, use get_stock_level or
    get_low_stock_items.

20. For receiving stock, use receive_stock.

21. For khata credit, use add_khata_credit.

22. For khata payment/settlement, use add_khata_payment.

23. For preferences, use set_preference and get_preference.

24. For daily sales, use get_daily_sales_summary.

25. For weekly/monthly analysis, use generate_analysis_deck.

26. Never invent values that should come from the database.

27. Keep responses concise and friendly.

28. Do not finalize a bill unless the confirmation state
    has already been created and the owner explicitly confirms.

29. If a tool returns an error, explain the error safely
    without exposing secrets.

30. Understand English, Tamil, and Tanglish naturally.
`;


// ============================================================
// OPENAI-COMPATIBLE TOOL DEFINITIONS
// ============================================================

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [

  // ----------------------------------------------------------
  // REQUEST CANCELLATION CONFIRMATION
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'request_cancel_confirmation',

      description:
        'Prepare cancellation confirmation for the active draft bill. This does not cancel the bill immediately.',

      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // REQUEST FINALIZATION
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'request_finalize_confirmation',

      description:
        'Prepare finalization confirmation. This does not finalize the bill.',

      parameters: {
        type: 'object',

        properties: {

          payment_mode: {
            type: 'string',
            enum: [
              'CASH',
              'UPI',
              'CARD',
              'CREDIT'
            ],
            description:
              'Payment mode for the bill. Use CREDIT for khata credit.'
          },

          upi_reference: {
            type: ['string', 'null'],
            description:
              'UPI transaction/reference ID. Required when payment_mode is UPI, otherwise null.'
          }
        },

        required: [
          'payment_mode',
          'upi_reference'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // CREATE DRAFT BILL
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'create_draft_bill',

      description:
        'Create a new draft bill for the current Telegram chat.',

      parameters: {
        type: 'object',

        properties: {

          customer_name: {
            type: ['string', 'null'],
            description:
              'Customer name if known, otherwise null.'
          }
        },

        required: [
          'customer_name'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // SET CUSTOMER
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'set_bill_customer',

      description:
        'Set or update the customer for the current draft bill.',

      parameters: {
        type: 'object',

        properties: {

          customer_name: {
            type: 'string',
            description:
              'Customer name.'
          }
        },

        required: [
          'customer_name'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // FIND PRODUCT
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'find_product',

      description:
        'Search active supermarket products by name before adding to a bill or receiving stock.',

      parameters: {
        type: 'object',

        properties: {

          product_query: {
            type: 'string',
            description:
              'Product name or partial product name.'
          },

          quantity: {
            type: 'number',
            description:
              'Quantity involved in the operation.'
          },

          operation: {
            type: 'string',
            enum: [
              'ADD_TO_BILL',
              'RECEIVE_STOCK'
            ],
            description:
              'ADD_TO_BILL when selling/adding to a bill. RECEIVE_STOCK when receiving inventory.'
          }
        },

        required: [
          'product_query',
          'quantity',
          'operation'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // ADD LINE ITEM
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'add_line_item',

      description:
        'Add a selected product and quantity to the active draft bill.',

      parameters: {
        type: 'object',

        properties: {

          product_id: {
            type: 'string',
            description:
              'UUID of the selected product.'
          },

          quantity: {
            type: 'number',
            description:
              'Quantity to add. Must be greater than zero.'
          }
        },

        required: [
          'product_id',
          'quantity'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // REMOVE LINE ITEM
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'remove_line_item',

      description:
        'Remove a product from the active draft bill.',

      parameters: {
        type: 'object',

        properties: {

          product_id: {
            type: 'string',
            description:
              'UUID of the product to remove.'
          }
        },

        required: [
          'product_id'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // UPDATE LINE ITEM QUANTITY
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'update_line_item_quantity',

      description:
        'Update quantity of a product in the active draft bill.',

      parameters: {
        type: 'object',

        properties: {

          product_id: {
            type: 'string',
            description:
              'UUID of the product.'
          },

          quantity: {
            type: 'number',
            description:
              'New quantity. Must be greater than zero.'
          }
        },

        required: [
          'product_id',
          'quantity'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // GET DRAFT BILL
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_draft_bill',

      description:
        'Get the active draft bill with items and totals.',

      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // FINALIZE BILL
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'finalize_bill',

      description:
        'Finalize the current draft bill. Only use after explicit owner confirmation.',

      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // CUSTOMER BALANCE
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_customer_balance',

      description:
        'Get a customer khata balance.',

      parameters: {
        type: 'object',

        properties: {

          customer_name: {
            type: 'string',
            description:
              'Customer name.'
          }
        },

        required: [
          'customer_name'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // PDF INVOICE
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'generate_invoice',

      description:
        'Generate a GST-correct PDF invoice for a finalized bill.',

      parameters: {
        type: 'object',

        properties: {

          bill_id: {
            type: 'string',
            description:
              'UUID of finalized bill. Use most recent finalized bill if available.'
          }
        },

        required: [
          'bill_id'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // STOCK LEVEL
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_stock_level',

      description:
        'Get current stock level for a product.',

      parameters: {
        type: 'object',

        properties: {

          product_id: {
            type: 'string',
            description:
              'Product UUID or product name.'
          }
        },

        required: [
          'product_id'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // LOW STOCK
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_low_stock_items',

      description:
        'Get products below the stock threshold.',

      parameters: {
        type: 'object',

        properties: {

          threshold: {
            type: 'number',
            description:
              'Stock threshold. Default is 10.'
          }
        },

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // RECEIVE STOCK
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'receive_stock',

      description:
        'Receive new stock into supermarket inventory. This does not require a draft bill.',

      parameters: {
        type: 'object',

        properties: {

          product_id: {
            type: 'string',
            description:
              'UUID or selected product ID.'
          },

          quantity: {
            type: 'number',
            description:
              'Quantity received.'
          }
        },

        required: [
          'product_id',
          'quantity'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // KHATA CREDIT
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'add_khata_credit',

      description:
        'Add credit to a customer khata.',

      parameters: {
        type: 'object',

        properties: {

          customer_name: {
            type: 'string',
            description:
              'Customer name.'
          },

          amount: {
            type: 'number',
            description:
              'Credit amount in INR.'
          },

          note: {
            type: 'string',
            description:
              'Optional note.'
          }
        },

        required: [
          'customer_name',
          'amount'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // KHATA PAYMENT
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'add_khata_payment',

      description:
        'Record a customer khata payment.',

      parameters: {
        type: 'object',

        properties: {

          customer_name: {
            type: 'string',
            description:
              'Customer name.'
          },

          amount: {
            type: 'number',
            description:
              'Payment amount in INR.'
          },

          payment_mode: {
            type: 'string',
            description:
              'Payment mode: cash, upi, or card.'
          },

          reference: {
            type: 'string',
            description:
              'Payment reference such as UPI transaction ID.'
          }
        },

        required: [
          'customer_name',
          'amount'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // SET PREFERENCE
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'set_preference',

      description:
        'Persist a user preference.',

      parameters: {
        type: 'object',

        properties: {

          key: {
            type: 'string',
            description:
              'Preference key.'
          },

          value: {
            type: 'string',
            description:
              'Preference value.'
          }
        },

        required: [
          'key',
          'value'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // GET PREFERENCE
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_preference',

      description:
        'Get a saved user preference.',

      parameters: {
        type: 'object',

        properties: {

          key: {
            type: 'string',
            description:
              'Preference key.'
          }
        },

        required: [
          'key'
        ],

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // DAILY SALES
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'get_daily_sales_summary',

      description:
        'Get daily sales, GST, payment split and sales information.',

      parameters: {
        type: 'object',

        properties: {

          date: {
            type: ['string', 'null'],
            description:
              'Optional date in YYYY-MM-DD format. Use null for today.'
          }
        },

        additionalProperties: false
      }
    }
  },


  // ----------------------------------------------------------
  // ANALYSIS DECK
  // ----------------------------------------------------------

  {
    type: 'function',
    function: {
      name: 'generate_analysis_deck',

      description:
        'Generate a PPTX analysis deck for supermarket sales and stock.',

      parameters: {
        type: 'object',

        properties: {

          period: {
            type: 'string',
            description:
              'Period: day, week, or month.'
          }
        },

        additionalProperties: false
      }
    }
  }
];


// ============================================================
// TOOL EXECUTION
// ============================================================

async function executeTool(
  toolName: string,
  rawArguments: string,
  chatId: number
): Promise<unknown> {

  let args: Record<string, unknown> = {};

  if (rawArguments) {

    try {

      const parsed =
        JSON.parse(rawArguments);

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        args =
          parsed as Record<string, unknown>;
      }

    } catch {

      throw new Error(
        'Invalid tool arguments returned by the model.'
      );
    }
  }


  // ==========================================================
  // REQUEST CANCELLATION CONFIRMATION
  // ==========================================================

  if (
    toolName ===
    'request_cancel_confirmation'
  ) {

    const billId =
      getActiveBillId(chatId);

    if (!billId) {

      return {
        ready: false,
        message:
          'There is no active draft bill to cancel.'
      };
    }

    // Cancellation takes priority.
    clearPendingFinalization(chatId);

    setPendingCancellation(
      chatId,
      billId
    );

    return {
      ready: true,
      billId,
      confirmationRequired: true,
      confirmationMessage:
        'Are you sure you want to cancel this draft bill? Reply Yes to cancel or No to keep it.'
    };
  }


  // ==========================================================
  // FIND PRODUCT
  // ==========================================================

  if (toolName === 'find_product') {

    const query =
      String(
        args.product_query ?? ''
      ).trim();

    const quantity =
      Number(
        args.quantity
      );

    const operation =
      String(
        args.operation ?? ''
      ).trim() as
        | 'ADD_TO_BILL'
        | 'RECEIVE_STOCK';

    if (!query) {

      throw new Error(
        'Product name is required.'
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {

      throw new Error(
        'Quantity must be greater than zero.'
      );
    }

    if (
      operation !== 'ADD_TO_BILL' &&
      operation !== 'RECEIVE_STOCK'
    ) {

      throw new Error(
        'Product operation must be ADD_TO_BILL or RECEIVE_STOCK.'
      );
    }

    const products =
      await toolFindProduct(
        query
      );

    if (products.length === 0) {

      return {
        found: false,
        message:
          `No active product found for "${query}".`
      };
    }


    // --------------------------------------------------------
    // EXACTLY ONE PRODUCT
    // --------------------------------------------------------

    if (products.length === 1) {

      const product =
        products[0];

      return {
        found: true,
        operation,
        product
      };
    }


    // --------------------------------------------------------
    // MULTIPLE PRODUCTS
    // --------------------------------------------------------

    setPendingProductChoices(
      chatId,
      operation,
      products.map(
        product => ({
          productId:
            product.id,

          productName:
            product.name,

          quantity
        })
      )
    );

    return {
      found: true,
      multipleMatches: true,
      operation,

      products:
        products.map(
          product => ({
            id: product.id,
            name: product.name,
            unit: product.unit,
            mrp: product.mrp,
            gstRate: product.gstRate,
            currentStock:
              product.currentStock
          })
        ),

      message:
        'Multiple products matched. Ask the owner to choose one by number.'
    };
  }


  // ==========================================================
  // CREATE DRAFT BILL
  // ==========================================================

  if (
    toolName ===
    'create_draft_bill'
  ) {

    const currentBillId =
      getActiveBillId(chatId);

    if (currentBillId) {

      return {
        ok: true,
        billId:
          currentBillId,
        status:
          'already_exists'
      };
    }

    const customerName =
      args.customer_name === null ||
      args.customer_name === undefined
        ? null
        : String(
            args.customer_name
          );

    const bill =
      await toolCreateDraftBill(
        customerName,
        chatId
      );

    setActiveBillId(
      chatId,
      bill.billId
    );

    return {
      ok: true,
      billId:
        bill.billId,
      customerName:
        bill.customerName,
      status:
        'draft_created'
    };
  }


  // ==========================================================
  // SET BILL CUSTOMER
  // ==========================================================

  if (
    toolName ===
    'set_bill_customer'
  ) {

    const billId =
      getActiveBillId(chatId);

    if (!billId) {

      throw new Error(
        'There is no active draft bill. Create a bill first.'
      );
    }

    const customerName =
      String(
        args.customer_name ?? ''
      ).trim();

    if (!customerName) {

      throw new Error(
        'Customer name is required.'
      );
    }

    return toolSetBillCustomer(
      billId,
      customerName
    );
  }


  // ==========================================================
  // ADD LINE ITEM
  // ==========================================================

  if (
    toolName ===
    'add_line_item'
  ) {

    let billId =
      getActiveBillId(chatId);

    if (!billId) {

      const newBill =
        await toolCreateDraftBill(
          null,
          chatId
        );

      billId =
        newBill.billId;

      setActiveBillId(
        chatId,
        billId
      );
    }

    const productId =
      String(
        args.product_id ?? ''
      ).trim();

    const quantity =
      Number(
        args.quantity
      );

    if (!productId) {

      throw new Error(
        'Product ID is required.'
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {

      throw new Error(
        'Quantity must be greater than zero.'
      );
    }

    return toolAddLineItem(
      billId,
      productId,
      quantity
    );
  }


  // ==========================================================
  // REMOVE LINE ITEM
  // ==========================================================

  if (
    toolName ===
    'remove_line_item'
  ) {

    const billId =
      getActiveBillId(chatId);

    if (!billId) {

      throw new Error(
        'There is no active draft bill.'
      );
    }

    const productId =
      String(
        args.product_id ?? ''
      ).trim();

    if (!productId) {

      throw new Error(
        'Product ID is required.'
      );
    }

    return toolRemoveLineItem(
      billId,
      productId
    );
  }


  // ==========================================================
  // UPDATE LINE ITEM QUANTITY
  // ==========================================================

  if (
    toolName ===
    'update_line_item_quantity'
  ) {

    const billId =
      getActiveBillId(chatId);

    if (!billId) {

      throw new Error(
        'There is no active draft bill.'
      );
    }

    const productId =
      String(
        args.product_id ?? ''
      ).trim();

    const quantity =
      Number(
        args.quantity
      );

    if (!productId) {

      throw new Error(
        'Product ID is required.'
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {

      throw new Error(
        'Quantity must be greater than zero.'
      );
    }

    return toolUpdateLineItemQuantity(
      billId,
      productId,
      quantity
    );
  }


  // ==========================================================
  // GET DRAFT BILL
  // ==========================================================

  if (
    toolName ===
    'get_draft_bill'
  ) {

    const billId =
      getActiveBillId(chatId);

    if (!billId) {

      return {
        activeBill: false,
        message:
          'No active draft bill exists.'
      };
    }

    return toolGetDraftBill(
      billId
    );
  }


  // ==========================================================
  // REQUEST FINALIZATION CONFIRMATION
  // ==========================================================

  if (
    toolName ===
    'request_finalize_confirmation'
  ) {

    const billId =
      getActiveBillId(chatId);

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
      !bill ||
      !bill.items ||
      bill.items.length === 0
    ) {

      return {
        ready: false,
        message:
          'The draft bill has no items.'
      };
    }

    const paymentMode =
      args.payment_mode as
        | 'CASH'
        | 'UPI'
        | 'CARD'
        | 'CREDIT';

    const upiReference =
      args.upi_reference === null ||
      args.upi_reference === undefined
        ? undefined
        : String(
            args.upi_reference
          ).trim();

    if (
      paymentMode !== 'CASH' &&
      paymentMode !== 'UPI' &&
      paymentMode !== 'CARD' &&
      paymentMode !== 'CREDIT'
    ) {

      throw new Error(
        'Invalid payment mode.'
      );
    }

    if (
      paymentMode === 'UPI' &&
      !upiReference
    ) {

      throw new Error(
        'UPI reference is required for UPI payments.'
      );
    }

    // Finalization and cancellation must never
    // be pending simultaneously.
    clearPendingCancellation(chatId);

    const idempotencyKey =
      crypto.randomUUID();

    setPendingFinalization(
      chatId,
      billId,
      idempotencyKey,
      paymentMode,
      upiReference
    );

    return {
      ready: true,
      bill,
      paymentMode,
      upiReference:
        upiReference ?? null,
      confirmationRequired: true,

      confirmationMessage:
        'Please confirm finalization. Reply Yes or Confirm to complete this bill.'
    };
  }


  // ==========================================================
  // FINALIZE BILL
  // ==========================================================

  if (
    toolName ===
    'finalize_bill'
  ) {

    // Never allow finalization if cancellation
    // confirmation is pending.
    const pendingCancellation =
      getPendingCancellation(chatId);

    if (pendingCancellation) {

      return {
        ok: false,
        message:
          'Cancellation confirmation is pending. The bill cannot be finalized.'
      };
    }

    const pending =
      getPendingFinalization(
        chatId
      );

    if (
      !pending.billId ||
      !pending.idempotencyKey ||
      !pending.paymentMode
    ) {

      return {
        ok: false,
        message:
          'No pending finalization. Please request finalization first and then confirm.'
      };
    }

    const finalized =
      await toolFinalizeBill(
        pending.billId,
        pending.idempotencyKey,
        chatId,
        pending.paymentMode,
        pending.upiReference ??
          undefined
      );

    clearPendingFinalization(
      chatId
    );

    clearPendingCancellation(
      chatId
    );

    clearPendingProductChoices(
      chatId
    );

    setActiveBillId(
      chatId,
      null
    );

    setLastFinalizedBillId(
      chatId,
      finalized.billId
    );

    return {
      ok: true,
      billId:
        finalized.billId,
      totalAmount:
        finalized.totalAmount,
      paymentMode:
        finalized.paymentMode,
      upiReference:
        finalized.upiReference,
      message:
        'Bill finalized successfully.'
    };
  }


  // ==========================================================
  // CUSTOMER BALANCE
  // ==========================================================

  if (
    toolName ===
    'get_customer_balance'
  ) {

    const customerName =
      String(
        args.customer_name ?? ''
      ).trim();

    if (!customerName) {

      throw new Error(
        'Customer name is required.'
      );
    }

    return toolGetCustomerBalance(
      customerName
    );
  }


  // ==========================================================
  // GENERATE PDF INVOICE
  // ==========================================================

  if (
    toolName ===
    'generate_invoice'
  ) {

    const suppliedBillId =
      typeof args.bill_id ===
      'string'
        ? args.bill_id.trim()
        : '';

    const billId =
      suppliedBillId ||
      getLastFinalizedBillId(
        chatId
      );

    if (!billId) {

      throw new Error(
        'No finalized bill is available. Finalize a bill first.'
      );
    }

    const pdfBuffer =
      await toolGenerateInvoice(
        billId
      );

    return {
      ok: true,

      billId,

      pdfBase64:
        pdfBuffer.toString(
          'base64'
        ),

      fileName:
        `invoice-${billId.slice(0, 8)}.pdf`,

      mimeType:
        'application/pdf'
    };
  }


  // ==========================================================
  // STOCK LEVEL
  // ==========================================================

  if (
    toolName ===
    'get_stock_level'
  ) {

    const productId =
      String(
        args.product_id ?? ''
      ).trim();

    if (!productId) {

      throw new Error(
        'Product ID or product name is required.'
      );
    }

    return toolGetStockLevel(
      productId
    );
  }


  // ==========================================================
  // LOW STOCK
  // ==========================================================

  if (
    toolName ===
    'get_low_stock_items'
  ) {

    const threshold =
      args.threshold === undefined
        ? undefined
        : Number(
            args.threshold
          );

    if (
      threshold !== undefined &&
      (
        !Number.isFinite(
          threshold
        ) ||
        threshold < 0
      )
    ) {

      throw new Error(
        'Stock threshold must be a valid non-negative number.'
      );
    }

    return toolGetLowStockItems(
      threshold as number
    );
  }


  // ==========================================================
  // RECEIVE STOCK
  // ==========================================================

  if (
    toolName ===
    'receive_stock'
  ) {

    const productId =
      String(
        args.product_id ?? ''
      ).trim();

    const quantity =
      Number(
        args.quantity
      );

    if (!productId) {

      throw new Error(
        'Product ID or product name is required.'
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {

      throw new Error(
        'Received quantity must be greater than zero.'
      );
    }

    return toolReceiveStock(
      productId,
      quantity
    );
  }


  // ==========================================================
  // KHATA CREDIT
  // ==========================================================

  if (
    toolName ===
    'add_khata_credit'
  ) {

    const customerName =
      String(
        args.customer_name ?? ''
      ).trim();

    const amount =
      Number(
        args.amount
      );

    const note =
      args.note === undefined
        ? undefined
        : String(
            args.note
          );

    if (!customerName) {

      throw new Error(
        'Customer name is required.'
      );
    }

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      throw new Error(
        'Credit amount must be greater than zero.'
      );
    }

    return toolAddKhataCredit(
      customerName,
      amount,
      note as string
    );
  }


  // ==========================================================
  // KHATA PAYMENT
  // ==========================================================

  if (
    toolName ===
    'add_khata_payment'
  ) {

    const customerName =
      String(
        args.customer_name ?? ''
      ).trim();

    const amount =
      Number(
        args.amount
      );

    const paymentMode =
      args.payment_mode === undefined
        ? undefined
        : String(
            args.payment_mode
          );

    const reference =
      args.reference === undefined
        ? undefined
        : String(
            args.reference
          );

    if (!customerName) {

      throw new Error(
        'Customer name is required.'
      );
    }

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      throw new Error(
        'Payment amount must be greater than zero.'
      );
    }

    return toolAddKhataPayment(
      customerName,
      amount,
      paymentMode as string,
      reference as string
    );
  }


  // ==========================================================
  // SET PREFERENCE
  // ==========================================================

  if (
    toolName ===
    'set_preference'
  ) {

    const key =
      String(
        args.key ?? ''
      ).trim();

    const value =
      String(
        args.value ?? ''
      );

    if (!key) {

      throw new Error(
        'Preference key is required.'
      );
    }

    return toolSetPref(
      chatId,
      key,
      value
    );
  }


  // ==========================================================
  // GET PREFERENCE
  // ==========================================================

  if (
    toolName ===
    'get_preference'
  ) {

    const key =
      String(
        args.key ?? ''
      ).trim();

    if (!key) {

      throw new Error(
        'Preference key is required.'
      );
    }

    return toolGetPref(
      chatId,
      key
    );
  }


  // ==========================================================
  // DAILY SALES
  // ==========================================================

  if (
    toolName ===
    'get_daily_sales_summary'
  ) {

    const date =
      args.date === null ||
      args.date === undefined
        ? undefined
        : String(
            args.date
          );

    return toolGetDailySalesSummary(
      date
    );
  }


  // ==========================================================
  // ANALYSIS DECK
  // ==========================================================

  if (
    toolName ===
    'generate_analysis_deck'
  ) {

    const period =
      args.period === undefined
        ? 'week'
        : String(
            args.period
          );

    const pptxBuffer =
      await toolGenerateAnalysisDeck(
        chatId,
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


  throw new Error(
    `Unsupported tool: ${toolName}`
  );
}


// ============================================================
// MAIN OWNER MESSAGE HANDLER
// ============================================================

export async function handleOwnerMessage(
  chatId: number,
  text: string
): Promise<string> {

  console.log(
    '=== LLM DEBUG ===',
    {
      chatId,
      text
    }
  );

  const normalized =
    text.trim().toLowerCase();
    // ==========================================================
// HARD GUARD: FINALIZE WITH NO ACTIVE BILL
// ==========================================================

if (
  normalized === 'finalize' ||
  normalized === 'finalise' ||
  normalized === 'finalize now' ||
  normalized === 'finalise now'
) {
  const activeBillId = getActiveBillId(chatId);

  if (!activeBillId) {
    return 'No active draft bill to finalize.';
  }
}


  // ==========================================================
  // HANDLE PENDING CANCELLATION FIRST
  // ==========================================================

  const pendingCancellation =
    getPendingCancellation(chatId);

  if (pendingCancellation) {

    // --------------------------------------------------------
    // CONFIRM CANCELLATION
    // --------------------------------------------------------

    if (
      YES_PHRASES.has(normalized)
    ) {

      try {

        const activeBillId =
          getActiveBillId(chatId);

        // Safety check:
        // Only discard the bill if the active bill
        // is the exact bill awaiting cancellation.
        if (
          activeBillId ===
          pendingCancellation
        ) {

          setActiveBillId(
            chatId,
            null
          );

          clearPendingProductChoices(
            chatId
          );

          clearPendingFinalization(
            chatId
          );

          clearPendingCancellation(
            chatId
          );

          return (
            'Bill cancelled successfully. ' +
            'The draft bill has been discarded.'
          );
        }

        clearPendingCancellation(
          chatId
        );

        return (
          'The draft bill changed while cancellation was pending. ' +
          'Nothing was cancelled.'
        );

      } catch (
        error: unknown
      ) {

        console.error(
          'Bill cancellation error:',
          error
        );

        return (
          'I could not cancel the bill right now. ' +
          'Please try again.'
        );
      }
    }


    // --------------------------------------------------------
    // REJECT CANCELLATION
    // --------------------------------------------------------

    if (
      NO_PHRASES.has(normalized)
    ) {

      clearPendingCancellation(
        chatId
      );

      return (
        'Cancellation cancelled. ' +
        'Your draft bill is still available.'
      );
    }


    // --------------------------------------------------------
    // DO NOT ALLOW FINALIZATION WHILE CANCELLATION
    // IS WAITING
    // --------------------------------------------------------

    if (
      normalized === 'finalize' ||
      normalized === 'finalise' ||
      normalized === 'finalize now' ||
      normalized === 'finalise now'
    ) {

      return (
        'Cancellation confirmation is still pending. ' +
        'Reply Yes to cancel the bill or No to keep it.'
      );
    }


    return (
      'Please reply Yes / Confirm to cancel the bill, ' +
      'or No to keep the draft bill.'
    );
  }


  // ==========================================================
  // HANDLE PENDING FINALIZATION
  // ==========================================================

  const pending =
    getPendingFinalization(chatId);

  if (
    pending &&
    pending.billId &&
    pending.idempotencyKey &&
    pending.paymentMode
  ) {

    // --------------------------------------------------------
    // CONFIRM FINALIZATION
    // --------------------------------------------------------

    if (
      YES_PHRASES.has(normalized)
    ) {

      try {

        const finalized =
          await toolFinalizeBill(
            pending.billId,
            pending.idempotencyKey,
            chatId,
            pending.paymentMode,
            pending.upiReference ??
              undefined
          );

        setActiveBillId(
          chatId,
          null
        );

        clearPendingFinalization(
          chatId
        );

        clearPendingCancellation(
          chatId
        );

        clearPendingProductChoices(
          chatId
        );

        setLastFinalizedBillId(
          chatId,
          finalized.billId
        );

        return (
          'Bill finalized successfully. ' +
          'You can now say: send me that bill as PDF.'
        );

      } catch (
        error: unknown
      ) {

        console.error(
          'Bill finalization error:',
          error
        );

        return (
          'I could not finalize the bill right now. ' +
          'Nothing has changed. Please reply Yes again in a moment.'
        );
      }
    }


    // --------------------------------------------------------
    // REJECT FINALIZATION
    // --------------------------------------------------------

    if (
      NO_PHRASES.has(normalized)
    ) {

      clearPendingFinalization(
        chatId
      );

      return (
        'Finalization cancelled. ' +
        'Your draft bill is still available.'
      );
    }


    // --------------------------------------------------------
    // EXPLICIT CANCEL REQUEST DURING FINALIZATION
    // --------------------------------------------------------

    if (
      CANCEL_REQUEST_PHRASES.has(normalized)
    ) {

      clearPendingFinalization(
        chatId
      );

      setPendingCancellation(
        chatId,
        pending.billId
      );

      return (
        'Are you sure you want to cancel this draft bill? ' +
        'Reply Yes to cancel or No to keep it.'
      );
    }


    return (
      'Please reply Yes / Confirm to finalize, ' +
      'or No / Cancel to keep the draft bill.'
    );
  }


  // ==========================================================
  // HANDLE PENDING PRODUCT SELECTION
  // ==========================================================

  const pendingProductState =
    getPendingProductChoices(chatId);

  const pendingProducts =
    pendingProductState.choices;


  // ----------------------------------------------------------
  // CANCEL WHILE PRODUCT SELECTION IS PENDING
  // ----------------------------------------------------------

  if (
    pendingProducts.length > 0 &&
    CANCEL_REQUEST_PHRASES.has(normalized)
  ) {

    clearPendingProductChoices(
      chatId
    );

    const activeBillId =
      getActiveBillId(chatId);

    if (!activeBillId) {

      return (
        'There is no active draft bill to cancel.'
      );
    }

    setPendingCancellation(
      chatId,
      activeBillId
    );

    return (
      'Are you sure you want to cancel this draft bill? ' +
      'Reply Yes to cancel or No to keep it.'
    );
  }


  if (
    pendingProducts.length > 0
  ) {

    const selection =
      text.trim();

    const selectedIndex =
      Number(selection) - 1;


    if (
      Number.isInteger(selectedIndex) &&
      selectedIndex >= 0 &&
      selectedIndex < pendingProducts.length
    ) {

      const selectedProduct =
        pendingProducts[selectedIndex];


      try {

        // ----------------------------------------------------
        // RECEIVE STOCK
        // ----------------------------------------------------

        if (
          pendingProductState.operation ===
          'RECEIVE_STOCK'
        ) {

          const result =
            await toolReceiveStock(
              selectedProduct.productId,
              selectedProduct.quantity
            );

          clearPendingProductChoices(
            chatId
          );

          return (
            `Received ${selectedProduct.quantity} x ` +
            `${selectedProduct.productName} into stock.`
          );
        }


        // ----------------------------------------------------
        // ADD TO BILL
        // ----------------------------------------------------

        const billId =
          getActiveBillId(chatId);

        if (!billId) {

          clearPendingProductChoices(
            chatId
          );

          return (
            'There is no active draft bill. ' +
            'Please create a bill first.'
          );
        }


        await toolAddLineItem(
          billId,
          selectedProduct.productId,
          selectedProduct.quantity
        );


        clearPendingProductChoices(
          chatId
        );


        const updatedBill =
          await toolGetDraftBill(
            billId
          );


        return (
          `Added ${selectedProduct.quantity} x ` +
          `${selectedProduct.productName} to the bill.\n\n` +
          `${JSON.stringify(updatedBill)}`
        );

      } catch (
        error: unknown
      ) {

        console.error(
          'Product selection error:',
          error
        );

        return (
          'Product selection error: ' +
          (
            error instanceof Error
              ? error.message
              : String(error)
          )
        );
      }
    }


    return (
      `Please choose a valid option from 1 to ${pendingProducts.length}.`
    );
  }


  // ==========================================================
  // LLM TOOL-CALL LOOP
  // ==========================================================

  const messages:
    OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [

      {
        role: 'system',
        content:
          systemPrompt
      },

      {
        role: 'user',
        content:
          text
      }
    ];


  // Maximum 8 model/tool iterations.
  for (
    let step = 0;
    step < 8;
    step += 1
  ) {

    try {

      const response =
        await openai.chat.completions.create({

          model,

          messages,

          tools,

          tool_choice:
            'auto',

          parallel_tool_calls:
            false,

          temperature:
            0.2
        });


      const message =
        response
          .choices[0]
          ?.message;


      if (!message) {

        return (
          'I could not process that request safely. Please try again.'
        );
      }


      messages.push(
        message
      );


      // ------------------------------------------------------
      // NORMAL TEXT RESPONSE
      // ------------------------------------------------------

      if (
        !message.tool_calls ||
        message.tool_calls.length === 0
      ) {

        return (
          message.content ||
          'I could not understand that. Please try again.'
        );
      }


      // ------------------------------------------------------
      // EXECUTE TOOL CALLS
      // ------------------------------------------------------

      for (
        const toolCall of
          message.tool_calls
      ) {

        try {

          const toolFunction =
            (toolCall as any)
              .function;


          if (
            !toolFunction ||
            typeof toolFunction.name !==
              'string' ||
            typeof toolFunction.arguments !==
              'string'
          ) {

            throw new Error(
              'The model returned an invalid tool call.'
            );
          }


          const result =
            await executeTool(
              toolFunction.name,
              toolFunction.arguments,
              chatId
            );


          // --------------------------------------------------
          // ARTIFACTS
          // --------------------------------------------------

          if (
            toolFunction.name ===
              'generate_invoice' ||
            toolFunction.name ===
              'generate_analysis_deck'
          ) {

            return JSON.stringify(
              result
            );
          }


          // --------------------------------------------------
          // NORMAL TOOL RESULT
          // --------------------------------------------------

          messages.push({

            role: 'tool',

            tool_call_id:
              toolCall.id,

            content:
              JSON.stringify(
                result
              )
          });

        } catch (
          error: unknown
        ) {

          const errorMessage =
            error instanceof Error
              ? error.message
              : 'Tool execution failed.';


          messages.push({

            role: 'tool',

            tool_call_id:
              toolCall.id,

            content:
              JSON.stringify({
                error:
                  errorMessage
              })
          });
        }
      }

    } catch (
      error: unknown
    ) {

      console.error(
        'LLM request error:',
        error
      );

      return (
        'Sorry, I could not process that request safely. Please try again.'
      );
    }
  }


  // ==========================================================
  // MAX LOOP REACHED
  // ==========================================================

  return (
    'I could not complete the request safely. Please try again.'
  );
}