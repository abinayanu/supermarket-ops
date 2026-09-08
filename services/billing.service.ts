import { PoolClient } from 'pg';
import { query, withTransaction } from './db';

export interface BillItemInput {
  productId: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
}

export interface DraftBillItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
  lineSubtotal: number;
}

export interface DraftBill {
  id: string;
  customerRef: string | null;
  status: 'draft';
  items: DraftBillItem[];
  subtotal: number;
  estimatedGst: number;
  estimatedTotal: number;
}

export interface FinalizedBill {
  id: string;
  customerRef: string | null;
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  roundingAdjustment: number;
  totalAmount: number;
  finalizedAt: Date | null;
paymentMode?: 'CASH' | 'UPI' | 'CARD' | 'CREDIT'; 
 upiReference?: string;
}

interface BillRow {
  id: string;
  customer_ref: string | null;
  status: string;
  subtotal: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  rounding_adjustment: string;
  total_amount: string | null;
  payment_mode: string | null;
  upi_reference: string | null;
  finalized_at: Date | null;
}

interface BillItemRow {
  product_id: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  gst_rate: string;
  line_subtotal: string;
}

interface LockedProductRow {
  id: string;
  name: string;
  current_stock: string;
}

function asNumber(value: string | null): number {
  return value === null ? 0 : Number(value);
}

function normalizeCustomerKey(customerName: string): string {
  return customerName.trim().toLowerCase().replace(/\s+/g, ' ');
}

function mapFinalizedBill(row: BillRow): FinalizedBill {
  return {
    id: row.id,
    customerRef: row.customer_ref,
    subtotal: asNumber(row.subtotal),
    cgstAmount: asNumber(row.cgst_amount),
    sgstAmount: asNumber(row.sgst_amount),
    roundingAdjustment: Number(row.rounding_adjustment),
    totalAmount: asNumber(row.total_amount),
    finalizedAt: row.finalized_at,
    paymentMode: row.payment_mode as 'CASH' | 'UPI' | 'CARD' | 'CREDIT' | undefined,
    upiReference: row.upi_reference ?? undefined
  };
}

export async function createDraftBill(
  customerRef: string | null = null
): Promise<string> {
  const rows = await query<{ id: string }>(
    `
      INSERT INTO bills (id, customer_ref, status)
      VALUES (gen_random_uuid(), $1, 'draft')
      RETURNING id;
    `,
    [customerRef]
  );

  return rows[0].id;
}

export async function setBillCustomer(
  billId: string,
  customerName: string
): Promise<void> {
  const result = await query<{ id: string }>(
    `
      UPDATE bills
      SET customer_ref = $1
      WHERE id = $2
        AND status = 'draft'
      RETURNING id;
    `,
    [customerName.trim(), billId]
  );

  if (result.length === 0) {
    throw new Error(`Active draft bill ${billId} was not found`);
  }
}

export async function addLineItem(
  billId: string,
  productId: string,
  quantity: number,
  unitPrice: number,
  gstRate: number
): Promise<void> {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be greater than zero');
  }

  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error('Unit price must be zero or greater');
  }

  if (!Number.isFinite(gstRate) || gstRate < 0) {
    throw new Error('GST rate must be zero or greater');
  }

  const bill = await query<{ id: string }>(
    `SELECT id FROM bills WHERE id = $1 AND status = 'draft';`,
    [billId]
  );

  if (bill.length === 0) {
    throw new Error(`Draft bill ${billId} not found`);
  }

  const product = await query<{ id: string; cost_price: string }>(
    `SELECT id, cost_price FROM products WHERE id = $1 AND is_active = true;`,
    [productId]
  );

  if (product.length === 0) {
    throw new Error(`Active product ${productId} not found`);
  }

  const costPrice = Number(product[0].cost_price);

  if (unitPrice < costPrice) {
    throw new Error(
      `Selling price ₹${unitPrice.toFixed(2)} cannot be below cost price ₹${costPrice.toFixed(2)}`
    );
  }

  const lineSubtotal = Math.round(quantity * unitPrice * 100) / 100;

  await query(
    `
      INSERT INTO bill_items (
        bill_id,
        product_id,
        quantity,
        unit_price,
        gst_rate,
        line_subtotal,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active');
    `,
    [billId, productId, quantity, unitPrice, gstRate, lineSubtotal]
  );
}

export async function getDraftBill(
  billId: string
): Promise<DraftBill | null> {
  const billRows = await query<BillRow>(
    `
      SELECT
        id,
        customer_ref,
        status,
        subtotal,
        cgst_amount,
        sgst_amount,
        rounding_adjustment,
        total_amount,
        finalized_at
      FROM bills
      WHERE id = $1
        AND status = 'draft';
    `,
    [billId]
  );

  if (billRows.length === 0) {
    return null;
  }

  const itemRows = await query<BillItemRow>(
    `
      SELECT
        bi.product_id,
        p.name AS product_name,
        bi.quantity,
        bi.unit_price,
        bi.gst_rate,
        bi.line_subtotal
      FROM bill_items bi
      INNER JOIN products p ON p.id = bi.product_id
      WHERE bi.bill_id = $1
        AND bi.status = 'active'
      ORDER BY bi.created_at ASC;
    `,
    [billId]
  );

  const items: DraftBillItem[] = itemRows.map((item) => ({
    productId: item.product_id,
    productName: item.product_name,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    gstRate: Number(item.gst_rate),
    lineSubtotal: Number(item.line_subtotal)
  }));

  const subtotal = items.reduce(
    (sum, item) => sum + item.lineSubtotal,
    0
  );

  const estimatedGst = items.reduce(
    (sum, item) => sum + (item.lineSubtotal * item.gstRate) / 100,
    0
  );

  return {
    id: billRows[0].id,
    customerRef: billRows[0].customer_ref,
    status: 'draft',
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    estimatedGst: Math.round(estimatedGst * 100) / 100,
    estimatedTotal: Math.round((subtotal + estimatedGst) * 100) / 100
  };
}

export async function finalizeBill(
  billId: string,
  idempotencyKey: string,
  createdBy: string = 'cli-agent',
paymentMode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' = 'CASH',
  upiReference?: string
): Promise<FinalizedBill> {
  return withTransaction(async (client: PoolClient) => {
    const existingFinalized = await client.query<BillRow>(
      `
  SELECT
  id,
  customer_ref,
  status,
  subtotal,
  cgst_amount,
  sgst_amount,
  rounding_adjustment,
  total_amount,
  payment_mode,
  upi_reference,
  finalized_at
FROM bills
        WHERE idempotency_key = $1
          AND status = 'finalized';
      `,
      [idempotencyKey]
    );

    if (existingFinalized.rows.length > 0) {
      return mapFinalizedBill(existingFinalized.rows[0]);
    }

    const billResult = await client.query<BillRow>(
      `
        SELECT
          id,
          customer_ref,
          status,
          subtotal,
          cgst_amount,
          sgst_amount,
          rounding_adjustment,
          total_amount,
          finalized_at
        FROM bills
        WHERE id = $1
          AND status = 'draft'
        FOR UPDATE;
      `,
      [billId]
    );

    if (billResult.rows.length === 0) {
      throw new Error(`Draft bill ${billId} not found`);
    }

    const bill = billResult.rows[0];

    const itemsResult = await client.query<BillItemRow>(
      `
        SELECT
          bi.product_id,
          p.name AS product_name,
          bi.quantity,
          bi.unit_price,
          bi.gst_rate,
          bi.line_subtotal
        FROM bill_items bi
        INNER JOIN products p ON p.id = bi.product_id
        WHERE bi.bill_id = $1
          AND bi.status = 'active'
        ORDER BY bi.product_id ASC;
      `,
      [billId]
    );

    const items = itemsResult.rows;

    if (items.length === 0) {
      throw new Error('Cannot finalize a bill with no active items');
    }

    const uniqueProductIds = [...new Set(items.map((item) => item.product_id))]
      .sort();

    const productsResult = await client.query<LockedProductRow>(
      `
        SELECT id, name, current_stock
        FROM products
        WHERE id = ANY($1::uuid[])
        ORDER BY id ASC
        FOR UPDATE;
      `,
      [uniqueProductIds]
    );

    if (productsResult.rows.length !== uniqueProductIds.length) {
      throw new Error('One or more products in this bill no longer exist');
    }

    const productsById = new Map(
      productsResult.rows.map((product) => [product.id, product])
    );

    const quantityByProduct = new Map<string, number>();

    for (const item of items) {
      const existing = quantityByProduct.get(item.product_id) ?? 0;
      quantityByProduct.set(
        item.product_id,
        existing + Number(item.quantity)
      );
    }

    for (const [productId, quantity] of quantityByProduct.entries()) {
      const product = productsById.get(productId);

      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }

      const currentStock = Number(product.current_stock);

      if (currentStock < quantity) {
        throw new Error(
          `Insufficient stock for ${product.name}: have ${currentStock}, need ${quantity}`
        );
      }
    }

    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.line_subtotal),
      0
    );

    const totalGst = items.reduce(
      (sum, item) =>
        sum +
        (Number(item.line_subtotal) * Number(item.gst_rate)) / 100,
      0
    );

    const cgstAmount = Math.round((totalGst / 2) * 100) / 100;
    const sgstAmount = Math.round((totalGst - cgstAmount) * 100) / 100;

    const rawTotal = subtotal + cgstAmount + sgstAmount;
    const totalAmount = Math.round(rawTotal * 100) / 100;
    const roundingAdjustment = Math.round((totalAmount - rawTotal) * 100) / 100;

    for (const [productId, soldQuantity] of quantityByProduct.entries()) {
      const product = productsById.get(productId)!;
      const currentStock = Number(product.current_stock);
      const resultingStock = currentStock - soldQuantity;

      await client.query(
        `
          UPDATE products
          SET current_stock = $1,
              updated_at = now()
          WHERE id = $2;
        `,
        [resultingStock, productId]
      );

      await client.query(
        `
          INSERT INTO stock_ledger (
            product_id,
            change_qty,
            reason,
            reference_type,
            reference_id,
            resulting_stock,
            created_by
          )
          VALUES ($1, $2, 'sale', 'bill', $3, $4, $5);
        `,
        [productId, -soldQuantity, billId, resultingStock, createdBy]
      );
    }

    const finalizedBillResult = await client.query<BillRow>(
  `
    UPDATE bills
    SET
      status = 'finalized',
      subtotal = $1,
      cgst_amount = $2,
      sgst_amount = $3,
      rounding_adjustment = $4,
      total_amount = $5,
      idempotency_key = $6,
      finalized_at = now(),
      payment_mode = $7,
      upi_reference = $8
    WHERE id = $9
    RETURNING
      id,
      customer_ref,
      status,
      subtotal,
      cgst_amount,
      sgst_amount,
      rounding_adjustment,
      total_amount,
      payment_mode,
      upi_reference,
      finalized_at;
  `,
  [
    subtotal,
    cgstAmount,
    sgstAmount,
    roundingAdjustment,
    totalAmount,
    idempotencyKey,
    paymentMode,
    upiReference ?? null,
    billId
  ]
);

if (bill.customer_ref && paymentMode === 'CREDIT') {
    const customerName = bill.customer_ref.trim();
  const customerKey = normalizeCustomerKey(customerName);

  await client.query(
    `
      INSERT INTO khata_transactions (
        customer_name,
        customer_key,
        transaction_type,
        amount,
        related_bill_id,
        created_by
      )
      VALUES ($1, $2, 'credit', $3, $4, $5);
    `,
    [customerName, customerKey, totalAmount, billId, createdBy]
  );
}

    return mapFinalizedBill(finalizedBillResult.rows[0]);
  });
}

export async function getBillById(
  billId: string
): Promise<FinalizedBill | null> {
  const rows = await query<BillRow>(
    `
      SELECT
  id,
  customer_ref,
  status,
  subtotal,
  cgst_amount,
  sgst_amount,
  rounding_adjustment,
  total_amount,
  payment_mode,
  upi_reference,
  finalized_at
FROM bills
WHERE id = $1;
    `,
    [billId]
  );

  if (rows.length === 0) {
    return null;
  }

  return mapFinalizedBill(rows[0]);
}

export async function removeLineItem(
  billId: string,
  productId: string
): Promise<void> {
  const result = await query(
    `
      UPDATE bill_items
      SET status = 'removed', updated_at = now()
      WHERE bill_id = $1
        AND product_id = $2
        AND status = 'active';
    `,
    [billId, productId]
  );

  if (result.length === 0) {
    throw new Error(`Active line item for product ${productId} not found in bill ${billId}`);
  }
}

export async function updateLineItemQuantity(
  billId: string,
  productId: string,
  quantity: number
): Promise<void> {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be greater than zero');
  }

  const itemResult = await query<{ line_subtotal: string; unit_price: string }>(
    `
      UPDATE bill_items
      SET quantity = $1,
          line_subtotal = quantity * unit_price,
          updated_at = now()
      WHERE bill_id = $2
        AND product_id = $3
        AND status = 'active'
      RETURNING line_subtotal, unit_price;
    `,
    [quantity, billId, productId]
  );

  if (itemResult.length === 0) {
    throw new Error(`Active line item for product ${productId} not found in bill ${billId}`);
  }
}