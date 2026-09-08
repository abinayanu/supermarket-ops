import { v4 as uuidv4 } from 'uuid';
import { findProduct, getLowStock } from '../services/stock.service';
import { generateWeeklySalesPPTX } from '../services/pptx-report';
import {
  createDraftBill,
  setBillCustomer,
  addLineItem,
  getDraftBill,
  finalizeBill,
  removeLineItem,
  updateLineItemQuantity
} from '../services/billing.service';
import { setPreference, getPreference } from './session.service';
import { query } from '../services/db';
import { generateInvoicePDF } from '../services/pdf-invoice';
import { getBalance, addCredit, addSettlement } from '../services/khata.service';
import { receiveStock } from '../services/stock.service';

export async function toolFindProduct(productQuery: string) {
  const products = await findProduct(productQuery);

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    unit: product.unit,
    mrp: Number(product.mrp),
    gstRate: Number(product.gst_rate),
    currentStock: product.currentStock
  }));
}

export async function toolCreateDraftBill(
  customerName: string | null,
  telegramChatId: number
) {
  const billId = await createDraftBill(customerName);

  return {
    billId,
    customerName,
    telegramChatId,
    status: 'draft'
  };
}

export async function toolSetBillCustomer(
  billId: string,
  customerName: string
) {
  await setBillCustomer(billId, customerName);

  return {
    billId,
    customerName,
    updated: true
  };
}

export async function toolAddLineItem(
  billId: string,
  productId: string,
  quantity: number,
  unitPrice?: number,
  gstRate?: number
) {
  let price = unitPrice;
  let tax = gstRate;

  if (price === undefined || tax === undefined) {
    const products = await findProduct(productId);
    const product = products.find((p) => p.id === productId);

    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    price = price ?? Number(product.mrp);
    tax = tax ?? Number(product.gst_rate);
  }

  await addLineItem(billId, productId, quantity, price!, tax!);

  return {
    billId,
    updated: true
  };
}

export async function toolGetDraftBill(billId: string) {
  const bill = await getDraftBill(billId);

  if (!bill) {
    return {
      activeBill: false,
      message: 'No active draft bill exists.'
    };
  }

  return {
    activeBill: true,
    billId: bill.id,
    customerName: bill.customerRef || 'Cash',
    items: bill.items,
    totalAmount: bill.estimatedTotal
  };
}

export async function toolFinalizeBill(
  billId: string,
  idempotencyKey: string,
  chatId: number,
  paymentMode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' = 'CASH',
  upiReference?: string
) {
  const finalizedBill = await finalizeBill(
    billId,
    idempotencyKey,
    `telegram-${chatId}`,
    paymentMode,
    upiReference
  );

  return {
    billId: finalizedBill.id,
    totalAmount: finalizedBill.totalAmount,
    finalized: true,
    paymentMode: finalizedBill.paymentMode,
    upiReference: finalizedBill.upiReference
  };
}

export async function toolGetCustomerBalance(customerName: string) {
  const balance = await getBalance(customerName);

  return {
    customerName: balance.customerName,
    balance: balance.balance,
    totalCredit: balance.totalCredit,
    totalSettlement: balance.totalSettlement
  };
}

export async function toolGenerateInvoice(billId: string): Promise<Buffer> {
  return generateInvoicePDF(billId);
}

export async function toolReceiveStock(
  productId: string,
  quantity: number,
  createdBy: string = 'telegram-bot'
) {
  const ledgerId = await receiveStock(
    productId,
    quantity,
    'receive',
    null,
    null,
    createdBy
  );

  return {
    productId,
    quantity,
    ledgerId,
    success: true
  };
}

// ============ BILL EDITING ============

export async function toolRemoveLineItem(
  billId: string,
  productId: string
) {
  const bill = await getDraftBill(billId);

  if (!bill) {
    throw new Error('No active draft bill exists.');
  }

  const item = bill.items.find((i) => i.productId === productId);

  if (!item) {
    throw new Error(`Product ${productId} not found in bill.`);
  }

  await removeLineItem(billId, productId);

  return {
    billId,
    productId,
    itemName: item.productName,
    removed: true
  };
}

export async function toolUpdateLineItemQuantity(
  billId: string,
  productId: string,
  quantity: number
) {
  const bill = await getDraftBill(billId);

  if (!bill) {
    throw new Error('No active draft bill exists.');
  }

  const item = bill.items.find((i) => i.productId === productId);

  if (!item) {
    throw new Error(`Product ${productId} not found in bill.`);
  }

  await updateLineItemQuantity(billId, productId, quantity);

  return {
    billId,
    productId,
    itemName: item.productName,
    oldQuantity: item.quantity,
    newQuantity: quantity,
    updated: true
  };
}

// ============ STOCK QUERIES ============

export async function toolGetStockLevel(productId: string) {
  const products = await findProduct(productId);
  const product = products.find((p) => p.id === productId);

  if (!product) {
    return {
      found: false,
      message: 'Product not found'
    };
  }

  return {
    found: true,
    productId: product.id,
    name: product.name,
    currentStock: product.currentStock,
    unit: product.unit
  };
}

export async function toolGetLowStockItems(threshold: number = 10) {
  const items = await getLowStock(threshold);

  return {
    threshold,
    items: items.map((item) => ({
      productId: item.id,
      name: item.name,
      unit: item.unit,
      currentStock: item.currentStock,
      mrp: Number(item.mrp)
    }))
  };
}

// ============ KHATA FULL FLOW ============

export async function toolAddKhataCredit(
  customerName: string,
  amount: number,
  note?: string
) {
  const result = await addCredit({
    customerName,
    amount,
    note,
    createdBy: 'telegram-bot'
  });

  return {
    customerName,
    amount,
    note,
    transactionId: result.transactionId,
    success: true
  };
}

export async function toolAddKhataPayment(
  customerName: string,
  amount: number,
  paymentMode?: string,
  reference?: string
) {
  const note = paymentMode
    ? `Payment via ${paymentMode}${reference ? ` (${reference})` : ''}`
    : undefined;

  const result = await addSettlement({
    customerName,
    amount,
    note,
    createdBy: 'telegram-bot'
  });

  return {
    customerName,
    amount,
    paymentMode,
    reference,
    transactionId: result.transactionId,
    success: true
  };
}

// ============ PREFERENCES ============

export async function toolSetPreference(
  chatId: number,
  key: string,
  value: string
) {
await setPreference(chatId, key, value);

  return {
    chatId,
    key,
    value,
    success: true
  };
}

export async function toolGetPreference(
  chatId: number,
  key: string
) {
const value = await getPreference(chatId, key);

  return {
    chatId,
    key,
    value,
    success: true
  };
}



// ============ DAILY CLOSE ============

export async function toolGetDailySalesSummary(date?: string) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const result = await query<{
    total_sales: string;
    total_tax: string;
    cash_total: string;
    upi_total: string;
    card_total: string;
    bill_count: string;
  }>(
    `
    SELECT
      COALESCE(SUM(total_amount), 0) AS total_sales,
      COALESCE(SUM(cgst_amount + sgst_amount), 0) AS total_tax,
      COALESCE(SUM(CASE WHEN payment_mode = 'CASH'
        THEN total_amount ELSE 0 END), 0) AS cash_total,
      COALESCE(SUM(CASE WHEN payment_mode = 'UPI'
        THEN total_amount ELSE 0 END), 0) AS upi_total,
      COALESCE(SUM(CASE WHEN payment_mode = 'CARD'
        THEN total_amount ELSE 0 END), 0) AS card_total,
      COUNT(*) AS bill_count
    FROM bills
    WHERE status = 'finalized'
      AND DATE(finalized_at) = $1
    `,
    [targetDate]
  );

  const row = result[0];

  return {
    date: targetDate,
    totalSales: Number(row?.total_sales ?? 0),
    totalGST: Number(row?.total_tax ?? 0),
    cashTotal: Number(row?.cash_total ?? 0),
    upiTotal: Number(row?.upi_total ?? 0),
    cardTotal: Number(row?.card_total ?? 0),
    billCount: Number(row?.bill_count ?? 0),
    topItems: (await query<{
  name: string;
  quantity: string;
  sales: string;
}>(
  `SELECT
     p.name,
     SUM(bi.quantity) AS quantity,
     SUM(bi.line_subtotal) AS sales
   FROM bills b
   JOIN bill_items bi ON bi.bill_id = b.id
   JOIN products p ON p.id = bi.product_id
   WHERE b.status = 'finalized'
     AND DATE(b.finalized_at) = $1
     AND bi.status = 'active'
   GROUP BY p.id, p.name
   ORDER BY SUM(bi.quantity) DESC, SUM(bi.line_subtotal) DESC
   LIMIT 5`,
  [targetDate]
)).map(item => ({
  name: item.name,
  quantity: Number(item.quantity),
  sales: Number(item.sales)
}))
  };
}

// ============ PPTX DECK ============

export async function toolGenerateAnalysisDeck(
  chatId: number,
  period: string = 'week'
): Promise<Buffer> {
  return generateWeeklySalesPPTX();
}

// Get daily sales
export async function toolGetDailySales(): Promise<{
  totalSales: number;
  totalTax: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  billCount: number;
}> {
  const result = await query(
    `
    SELECT 
      COALESCE(SUM(total_amount), 0) as total_sales,
      COALESCE(SUM(cgst_amount + sgst_amount), 0) as total_tax,
      COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN total_amount ELSE 0 END), 0) as cash_sales,
      COALESCE(SUM(CASE WHEN payment_mode = 'upi' THEN total_amount ELSE 0 END), 0) as upi_sales,
      COALESCE(SUM(CASE WHEN payment_mode = 'card' THEN total_amount ELSE 0 END), 0) as card_sales,
      COUNT(*) as bill_count
    FROM bills
    WHERE status = 'finalized'
      AND finalized_at >= CURRENT_DATE
    `
  );
  
const row = result[0];
  return {
    totalSales: Number(row.total_sales),
    totalTax: Number(row.total_tax),
    cashSales: Number(row.cash_sales),
    upiSales: Number(row.upi_sales),
    cardSales: Number(row.card_sales),
    billCount: Number(row.bill_count)
  };
}
