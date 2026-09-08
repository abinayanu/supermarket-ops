import 'dotenv/config';
import OpenAI from 'openai';
import * as crypto from 'crypto';
import {
  getActiveBillId,
  getPendingFinalization,
  setActiveBillId,
  setPendingFinalization,
  clearPendingFinalization,
  setLastFinalizedBillId,
  getLastFinalizedBillId,
  getPreference,
  setPreference
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


const apiKey = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';


if (!apiKey) {
  throw new Error('GROQ_API_KEY is missing from .env');
}


const openai = new OpenAI({
  apiKey,
  baseURL: 'https://api.groq.com/openai/v1'
});


const CONFIRM_PHRASES = new Set([
  'yes',
  'y',
  'confirm',
  'confirmed',
  'finalize',
  'finalize now',
  'ok finalize',
  'okay finalize',
  'seri',
  'சரி',
  'ஆம்',
  'ஆமா'
]);


const CANCEL_PHRASES = new Set([
  'no',
  'n',
  'cancel',
  'stop',
  'vendam',
  'வேண்டாம்',
  'வேண்டா'
]);


const systemPrompt = `
You are a supermarket operations assistant for a shop owner.


The owner may write in English, Tamil, or Tanglish.


You must use tools to read or change business data. Never invent product, stock,
bill, price, GST, customer balance, or order details.


Rules:
1. Use find_product before adding a product.
2. If there are multiple plausible product matches, ask the owner to choose.
3. A draft bill is required before adding a line item.
4. If there is no active bill, create one before adding the first item.
5. Before finalizing, call get_draft_bill and show a clear bill summary.
6. When the owner confirms with Yes/Confirm, call finalize_bill to complete the bill.
7. When the owner asks to finalize, only call request_finalize_confirmation.
8. For balance requests, use get_customer_balance.
9. When the owner asks for a PDF invoice ("send me that bill as PDF", "last bill PDF", etc.),
    ALWAYS call generate_invoice tool. If no bill_id is provided, use the most recent finalized bill.
10. Be concise and friendly.
11. For tool results, return ONLY the raw JSON result. Do NOT add any text, explanations, or Markdown formatting.
12. For stock queries, use get_stock_level or get_low_stock_items.
13. For khata credit, use add_khata_credit. For payments, use add_khata_payment.
14. For preferences, use set_preference and get_preference.
15. For daily sales, use get_daily_sales_summary.
16. For analysis deck, use generate_analysis_deck.
17. For receiving stock, use receive_stock.
`;


const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'find_product',
      description: 'Search active supermarket products by name.',
      parameters: {
        type: 'object',
        properties: {
          product_query: {
            type: 'string',
            description: 'Product name or partial product name from the owner.'
          }
        },
        required: ['product_query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_draft_bill',
      description: 'Create a new draft bill for the current Telegram chat.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: ['string', 'null'],
            description: 'Customer name if known, otherwise null.'
          }
        },
        required: ['customer_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_bill_customer',
      description: 'Set or update the customer for the current draft bill.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name.'
          }
        },
        required: ['customer_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_line_item',
      description: 'Add a selected product and quantity to the active draft bill.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'UUID of the selected product returned by find_product.'
          },
          quantity: {
            type: 'number',
            description: 'Quantity to add. Must be greater than zero.'
          }
        },
        required: ['product_id', 'quantity'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_line_item',
      description: 'Remove a product from the active draft bill.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'UUID of the product to remove.'
          }
        },
        required: ['product_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_line_item_quantity',
      description: 'Update quantity of a product in the active draft bill.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'UUID of the product.'
          },
          quantity: {
            type: 'number',
            description: 'New quantity. Must be greater than zero.'
          }
        },
        required: ['product_id', 'quantity'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_draft_bill',
      description: 'Get the active draft bill with items and estimated GST total.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_finalize_confirmation',
      description:
        'Prepare finalization confirmation after the owner asks to finalize. This does not change data.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_bill',
      description: 'Finalize the current draft bill. Call this only after the user confirms with Yes/Confirm.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_customer_balance',
      description: 'Get a customer khata balance.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name.'
          }
        },
        required: ['customer_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_invoice',
      description: 'Generate a GST-correct PDF invoice for a finalized bill.',
      parameters: {
        type: 'object',
        properties: {
          bill_id: {
            type: 'string',
            description: 'UUID of a finalized bill. Use the most recent finalized bill if not specified.'
          }
        },
        required: ['bill_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_level',
      description: 'Get current stock level for a product.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'Product UUID or product name to search.'
          }
        },
        required: ['product_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_low_stock_items',
      description: 'Get list of items with stock below threshold.',
      parameters: {
        type: 'object',
        properties: {
          threshold: {
            type: 'number',
            description: 'Stock threshold. Default is 10.'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'receive_stock',
      description: 'Receive new stock for a product (purchase/inventory).',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'Product UUID or name.'
          },
          quantity: {
            type: 'number',
            description: 'Quantity received.'
          }
        },
        required: ['product_id', 'quantity'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_khata_credit',
      description: 'Add credit to a customer khata (customer bought on credit).',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name.'
          },
          amount: {
            type: 'number',
            description: 'Credit amount in INR.'
          },
          note: {
            type: 'string',
            description: 'Optional note.'
          }
        },
        required: ['customer_name', 'amount'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_khata_payment',
      description: 'Record a khata payment/settlement from a customer.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name.'
          },
          amount: {
            type: 'number',
            description: 'Payment amount in INR.'
          },
          payment_mode: {
            type: 'string',
            description: 'Payment mode: cash, upi, card.'
          },
          reference: {
            type: 'string',
            description: 'Payment reference (e.g., UPI txn ID).'
          }
        },
        required: ['customer_name', 'amount'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_preference',
      description: 'Set a user preference (persisted across sessions).',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Preference key (e.g., default_payment_mode, default_atta_brand).'
          },
          value: {
            type: 'string',
            description: 'Preference value.'
          }
        },
        required: ['key', 'value'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_preference',
      description: 'Get a user preference.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Preference key.'
          }
        },
        required: ['key'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_sales_summary',
      description: 'Get daily sales summary (total, GST, payment split, top items).',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format. Default is today.'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_analysis_deck',
      description: 'Generate a PPTX analysis deck for sales/stock/GST.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period: day, week, month. Default is week.'
          }
        },
        additionalProperties: false
      }
    }
  }
];


async function executeTool(
  toolName: string,
  rawArguments: string,
  chatId: number
): Promise<unknown> {
  let args: Record<string, unknown> = {};


  if (rawArguments) {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      args = {};
    }
  }


  if (toolName === 'find_product') {
    return toolFindProduct(args.product_query as string);
  }


  if (toolName === 'create_draft_bill') {
    const currentBillId = getActiveBillId(chatId);


    if (currentBillId) {
      return {
        billId: currentBillId,
        status: 'already_exists'
      };
    }


    const bill = await toolCreateDraftBill(
      (args.customer_name as string | undefined) ?? null,
      chatId
    );


setLastFinalizedBillId(chatId, bill.billId);

    return {
      ok: true,
      billId: bill.billId,
      totalAmount: 0,
      message: 'Bill finalized successfully.'
    };

  }


  if (toolName === 'set_bill_customer') {
    const billId = getActiveBillId(chatId);


    if (!billId) {
      throw new Error('There is no active draft bill.');
    }


    return toolSetBillCustomer(billId, args.customer_name as string);
  }


  if (toolName === 'add_line_item') {
    let billId = getActiveBillId(chatId);


    if (!billId) {
      const newBill = await toolCreateDraftBill(null, chatId);
      billId = newBill.billId;
      setActiveBillId(chatId, billId);
    }


    return toolAddLineItem(
      billId,
      args.product_id as string,
      Number(args.quantity)
    );
  }


  if (toolName === 'remove_line_item') {
    const billId = getActiveBillId(chatId);


    if (!billId) {
      throw new Error('There is no active draft bill.');
    }


    return toolRemoveLineItem(billId, args.product_id as string);
  }


  if (toolName === 'update_line_item_quantity') {
    const billId = getActiveBillId(chatId);


    if (!billId) {
      throw new Error('There is no active draft bill.');
    }


    return toolUpdateLineItemQuantity(
      billId,
      args.product_id as string,
      Number(args.quantity)
    );
  }


  if (toolName === 'get_draft_bill') {
    const billId = getActiveBillId(chatId);


    if (!billId) {
      return {
        activeBill: false,
        message: 'No active draft bill exists.'
      };
    }


    return toolGetDraftBill(billId);
  }


  if (toolName === 'request_finalize_confirmation') {
    const billId = getActiveBillId(chatId);


    if (!billId) {
      return {
        ready: false,
        message: 'No active draft bill exists.'
      };
    }


    const bill = await toolGetDraftBill(billId);


    if (!bill || !bill.items || bill.items.length === 0) {
      return {
        ready: false,
        message: 'The draft bill has no items.'
      };
    }


    const idempotencyKey = crypto.randomUUID();


    setPendingFinalization(chatId, billId, idempotencyKey);


    return {
      ready: true,
      bill,
      confirmationMessage:
        'Please confirm finalization. Reply Yes or Confirm to complete this bill.'
    };
  }


  if (toolName === 'finalize_bill') {
    const pending = getPendingFinalization(chatId);


    if (!pending) {
      return {
        ok: false,
        message: 'No pending finalization. Please request finalization first.'
      };
    }


    const bill = await toolFinalizeBill(
      pending.billId,
      pending.idempotencyKey,
      chatId
    );


    clearPendingFinalization(chatId);
    setActiveBillId(chatId, null);
        setLastFinalizedBillId(chatId, bill.billId);

    return {
      ok: true,
      billId: bill.billId,
      totalAmount: bill.totalAmount,
      message: 'Bill finalized successfully.'
    };
  }


  if (toolName === 'get_customer_balance') {
    return toolGetCustomerBalance(args.customer_name as string);
  }


  if (toolName === 'generate_invoice') {
    const billId = (args.bill_id as string | undefined) || getLastFinalizedBillId(chatId);


    if (!billId) {
      throw new Error(
        'No finalized bill is available. Finalize a bill first, then request its PDF invoice.'
      );
    }


    const pdfBuffer = await toolGenerateInvoice(billId);


    return {
      ok: true,
      billId,
      pdfBase64: pdfBuffer.toString('base64'),
      fileName: `invoice-${billId.slice(0, 8)}.pdf`,
      mimeType: 'application/pdf'
    };
  }


  if (toolName === 'get_stock_level') {
    return toolGetStockLevel(args.product_id as string);
  }


  if (toolName === 'get_low_stock_items') {
    return toolGetLowStockItems(args.threshold as number);
  }


  if (toolName === 'receive_stock') {
    return toolReceiveStock(
      args.product_id as string,
      Number(args.quantity)
    );
  }


  if (toolName === 'add_khata_credit') {
    return toolAddKhataCredit(
      args.customer_name as string,
      Number(args.amount),
      args.note as string
    );
  }


  if (toolName === 'add_khata_payment') {
    return toolAddKhataPayment(
      args.customer_name as string,
      Number(args.amount),
      args.payment_mode as string,
      args.reference as string
    );
  }


  if (toolName === 'set_preference') {
    return toolSetPref(
      chatId,
      args.key as string,
      args.value as string
    );
  }


  if (toolName === 'get_preference') {
    return toolGetPref(chatId, args.key as string);
  }


  if (toolName === 'get_daily_sales_summary') {
    return toolGetDailySalesSummary(args.date as string);
  }


  if (toolName === 'generate_analysis_deck') {
    const pptxBuffer = await toolGenerateAnalysisDeck(
      chatId,
      args.period as string
    );


    return {
      ok: true,
      pptxBase64: pptxBuffer.toString('base64'),
      fileName: `analysis-${args.period || 'week'}.pptx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
  }


  throw new Error(`Unsupported tool: ${toolName}`);
}

async function toolFinalizeBill(
  billId: string,
  idempotencyKey: string,
  chatId: number
): Promise<{ billId: string; totalAmount: number }> {
  const finalized = await finalizeBill(
    billId,
    idempotencyKey,
    `chat-${chatId}`,
    'cash'
  );

  return {
    billId: finalized.billId,
    totalAmount: finalized.totalAmount
  };
}
export async function handleOwnerMessage(
  chatId: number,
  text: string
): Promise<string> {
  console.log('=== LLM DEBUG ===', { chatId, text });
  const pending = getPendingFinalization(chatId);


  if (pending && pending.billId && pending.idempotencyKey) {
    const normalized = text.trim().toLowerCase();


    if (CONFIRM_PHRASES.has(normalized)) {
      try {
        await toolFinalizeBill(
          pending.billId,
          pending.idempotencyKey,
          chatId
        );


        setActiveBillId(chatId, null);
        clearPendingFinalization(chatId);
        setLastFinalizedBillId(chatId, pending.billId);


        return 'Bill finalized successfully. You can now say: send me that bill as PDF.';
      } catch (error: any) {
        console.error('Bill finalization error:', error);


        return (
          "I could not finalize the bill right now. " +
          "Nothing has changed. Please reply Yes again in a moment."
        );
      }
    }


    if (CANCEL_PHRASES.has(normalized)) {
      clearPendingFinalization(chatId);


      return 'Finalization cancelled. Your draft bill is still available.';
    }


    return (
      'Please reply Yes / Confirm to finalize, or No / Cancel ' +
      'to keep the draft bill.'
    );
  }


  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: systemPrompt
    },
    {
      role: 'user',
      content: text
    }
  ];


  for (let step = 0; step < 8; step += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: 0.2
    });


    const message = response.choices[0].message;


    messages.push(message);


    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || 'I could not understand that. Please try again.';
    }


    for (const toolCall of message.tool_calls) {
      try {
        const toolFunction = (toolCall as any).function;


        if (
          !toolFunction ||
          typeof toolFunction.name !== 'string' ||
          typeof toolFunction.arguments !== 'string'
        ) {
          throw new Error('The model returned an invalid tool call.');
        }


        const result = await executeTool(
          toolFunction.name,
          toolFunction.arguments,
          chatId
        );


        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      } catch (error: any) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : 'Tool execution failed.'
          })
        });
      }
    }
  }


  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role === 'tool' && typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }


  return 'I could not complete the request safely. Please try again.';
}