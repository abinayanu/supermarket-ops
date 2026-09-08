import 'dotenv/config';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import {
  toolCreateDraftBill,
  toolAddLineItem,
  toolFinalizeBill,
  toolGetDraftBill,
  toolRemoveLineItem,
  toolUpdateLineItemQuantity,
  toolAddKhataCredit,
  toolAddKhataPayment,
  toolGetCustomerBalance,
  toolGenerateInvoice
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
import { toolGetStockLevel, toolReceiveStock, toolGetLowStockItems } from './tools';

// System prompt
const SYSTEM_PROMPT = `You are a supermarket operations assistant for an Indian kirana store.
You help the owner manage stock, bills, and customer credit via Telegram.

Rules:
- Always check stock before selling. Never oversell.
- Compute GST correctly (CGST + SGST for intra-state Tamil Nadu).
- Ask clarifying questions when product name is ambiguous.
- Bills can be edited mid-build (add/remove/update items).
- Stock decrements only on bill finalization.
- Record payment mode (cash/UPI/card) for all transactions.

Available capabilities:
- Receive stock
- Create and edit bills
- Finalize bills with GST
- Manage customer khata (credit)
- Generate PDF invoices
- Check stock levels
- Set preferences (default payment, preferred brands)`;

// Define tools
const tools = {
  create_draft_bill: tool({
    description: 'Create a new draft bill for a customer',
    parameters: z.object({
      customer_name: z.string().optional().describe('Customer name for the bill')
    }),
    execute: async ({ customer_name }) => {
      const result = await toolCreateDraftBill(customer_name);
      setActiveBillId(1, result.billId); // Default chatId=1 for now
      return result;
    }
  }),

  add_line_item: tool({
    description: 'Add item to current draft bill',
    parameters: z.object({
      product_id: z.string().describe('Product UUID'),
      quantity: z.number().describe('Quantity to add')
    }),
    execute: async ({ product_id, quantity }) => {
      return await toolAddLineItem(product_id, quantity);
    }
  }),

  remove_line_item: tool({
    description: 'Remove item from current draft bill',
    parameters: z.object({
      product_id: z.string().describe('Product UUID to remove')
    }),
    execute: async ({ product_id }) => {
      return await toolRemoveLineItem(product_id);
    }
  }),

  update_line_item_quantity: tool({
    description: 'Update quantity of an item in current draft bill',
    parameters: z.object({
      product_id: z.string().describe('Product UUID'),
      quantity: z.number().describe('New quantity')
    }),
    execute: async ({ product_id, quantity }) => {
      return await toolUpdateLineItemQuantity(product_id, quantity);
    }
  }),

  get_draft_bill: tool({
    description: 'Get current draft bill details',
    parameters: z.object({}),
    execute: async () => {
      const billId = getActiveBillId(1);
      if (!billId) return { message: 'No active draft bill' };
      return await toolGetDraftBill(billId);
    }
  }),

  finalize_bill: tool({
    description: 'Finalize current draft bill with payment',
    parameters: z.object({
      payment_mode: z.enum(['cash', 'upi', 'card', 'mixed']).default('cash'),
      upi_reference: z.string().optional()
    }),
    execute: async ({ payment_mode, upi_reference }) => {
      const billId = getActiveBillId(1);
      if (!billId) return { error: 'No active draft bill' };
      
      const idempotencyKey = `finalize-${billId}-${Date.now()}`;
      setPendingFinalization(1, billId, idempotencyKey);
      
      const result = await toolFinalizeBill(
        billId,
        idempotencyKey,
        1,
        payment_mode,
        upi_reference
      );
      
      clearPendingFinalization(1);
      setActiveBillId(1, null);
      setLastFinalizedBillId(1, result.billId);
      
      return result;
    }
  }),

  receive_stock: tool({
    description: 'Receive new stock for a product',
    parameters: z.object({
      product_id: z.string().describe('Product UUID'),
      quantity: z.number().describe('Quantity received'),
      cost_price: z.number().describe('Cost price per unit'),
      mrp: z.number().describe('MRP/sell price per unit')
    }),
    execute: async ({ product_id, quantity, cost_price, mrp }) => {
      return await toolReceiveStock(product_id, quantity, cost_price, mrp);
    }
  }),

  get_stock_level: tool({
    description: 'Check current stock level for a product',
    parameters: z.object({
      product_id: z.string().describe('Product UUID or name')
    }),
    execute: async ({ product_id }) => {
      return await toolGetStockLevel(product_id);
    }
  }),

  get_low_stock_items: tool({
    description: 'Get items that are below reorder level',
    parameters: z.object({}),
    execute: async () => {
      return await toolGetLowStockItems();
    }
  }),

  add_khata_credit: tool({
    description: 'Add credit to customer khata (they owe us)',
    parameters: z.object({
      customer_name: z.string().describe('Customer name'),
      amount: z.number().describe('Amount in INR'),
      note: z.string().optional().describe('Optional note')
    }),
    execute: async ({ customer_name, amount, note }) => {
      return await toolAddKhataCredit(customer_name, amount, note);
    }
  }),

  add_khata_payment: tool({
    description: 'Record payment from customer (they pay us)',
    parameters: z.object({
      customer_name: z.string().describe('Customer name'),
      amount: z.number().describe('Amount paid in INR'),
      payment_mode: z.enum(['cash', 'upi', 'card']).default('cash'),
      reference: z.string().optional().describe('UPI reference or transaction ID')
    }),
    execute: async ({ customer_name, amount, payment_mode, reference }) => {
      return await toolAddKhataPayment(customer_name, amount, payment_mode, reference);
    }
  }),

  get_customer_balance: tool({
    description: 'Get customer khata balance',
    parameters: z.object({
      customer_name: z.string().describe('Customer name')
    }),
    execute: async ({ customer_name }) => {
      return await toolGetCustomerBalance(customer_name);
    }
  }),

  generate_invoice: tool({
    description: 'Generate PDF invoice for a finalized bill',
    parameters: z.object({
      bill_id: z.string().describe('Bill ID (uses last finalized if not provided)')
    }),
    execute: async ({ bill_id }) => {
      const actualBillId = bill_id || getLastFinalizedBillId(1);
      if (!actualBillId) return { error: 'No finalized bill found' };
      
      const pdfBuffer = await toolGenerateInvoice(actualBillId);
      return {
        message: 'Invoice generated',
        filename: `invoice-${actualBillId.slice(0, 8)}.pdf`,
        pdf: pdfBuffer.toString('base64')
      };
    }
  }),

  set_preference: tool({
    description: 'Set a user preference (persisted across sessions)',
    parameters: z.object({
      key: z.string().describe('Preference key (e.g., "default_payment", "default_atta_brand")'),
      value: z.string().describe('Preference value')
    }),
    execute: async ({ key, value }) => {
      // TODO: Implement in session.service.ts or DB
      return { message: `Preference set: ${key} = ${value}` };
    }
  }),

  get_preference: tool({
    description: 'Get a user preference',
    parameters: z.object({
      key: z.string().describe('Preference key')
    }),
    execute: async ({ key }) => {
      // TODO: Implement
      return { message: 'Preference not implemented yet' };
    }
  })
};

// Main handler
export async function handleWithVercelAgent(
  chatId: number,
  message: string
): Promise<string> {
  try {
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      tools,
      maxSteps: 5
    });

    return result.text;
  } catch (error: any) {
    console.error('Vercel agent error:', error);
    return `Error: ${error.message || 'Could not process request'}`;
  }
}
