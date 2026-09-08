import { PoolClient } from 'pg';
import { query, withTransaction } from './db';

export interface ProductStock {
  id: string;
  name: string;
  unit: string;
  mrp: string;
  gst_rate: string;
  currentStock: number;
}

export interface StockLedgerEntry {
  id: number;
  productId: string;
  changeQty: number;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  resultingStock: number;
  createdBy: string;
  createdAt: Date;
}

interface ProductRow {
  id: string;
  name: string;
  unit: string;
  mrp: string;
  gst_rate: string;
  current_stock: string;
}

interface LockedProductRow {
  id: string;
  name: string;
  unit: string;
  mrp: string;
  gst_rate: string;
  current_stock: string;
}

interface LedgerRow {
  id: string;
  product_id: string;
  change_qty: string;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  resulting_stock: string;
  created_by: string;
  created_at: Date;
}

function mapProduct(row: ProductRow): ProductStock {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    mrp: row.mrp,
    gst_rate: row.gst_rate,
    currentStock: parseFloat(row.current_stock)
  };
}

export async function getStock(productId: string): Promise<ProductStock | null> {
  const rows = await query<ProductRow>(
    `SELECT id, name, unit, mrp, gst_rate, current_stock FROM products WHERE id = $1;`,
    [productId]
  );
  
  if (rows.length === 0) return null;
  return mapProduct(rows[0]);
}

export async function findProduct(queryText: string): Promise<ProductStock[]> {
  const searchText = queryText.trim();
  
  if (!searchText) {
    return [];
  }
  // Check if query is a UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(searchText)) {
    const rows = await query<ProductRow>(
      `SELECT id, name, unit, mrp, gst_rate, current_stock FROM products WHERE id = $1 AND is_active = true;`,
      [searchText]
    );
    return rows.map(mapProduct);
  }
  
  const rows = await query<ProductRow>(
    `
      SELECT id, name, unit, mrp, gst_rate, current_stock
      FROM products
      WHERE is_active = true
        AND (
          name ILIKE '%' || $1 || '%'
          OR similarity(lower(name), lower($1)) > 0.2
        )
      ORDER BY
        CASE
          WHEN name ILIKE '%' || $1 || '%' THEN 1
          ELSE 0
        END DESC,
        similarity(lower(name), lower($1)) DESC
      LIMIT 10;
    `,
    [searchText]
  );
  
  return rows.map(mapProduct);
}

export async function getLowStock(
  threshold: number = 10
): Promise<ProductStock[]> {
  const rows = await query<ProductRow>(
    `
      SELECT id, name, unit, mrp, gst_rate, current_stock
      FROM products
      WHERE is_active = true AND current_stock < $1
      ORDER BY current_stock ASC;
    `,
    [threshold]
  );
  
  return rows.map(mapProduct);
}

export async function receiveStock(
  productId: string,
  quantity: number,
  reason: string,
  referenceType: string | null,
  referenceId: string | null,
  createdBy: string
): Promise<number> {
  return withTransaction(async (client) => {
    const lockResult = await client.query<LockedProductRow>(
      `SELECT id, name, unit, mrp, gst_rate, current_stock 
       FROM products 
       WHERE id = $1 
       FOR UPDATE;`,
      [productId]
    );
    
    if (lockResult.rows.length === 0) {
      throw new Error(`Product ${productId} not found`);
    }
    
    const currentStock = parseFloat(lockResult.rows[0].current_stock);
    const newStock = currentStock + quantity;
    
    const ledgerResult = await client.query<LedgerRow>(
      `
        INSERT INTO stock_ledger (
          product_id, change_qty, reason, reference_type, reference_id, resulting_stock, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, product_id, change_qty, reason, reference_type, reference_id, resulting_stock, created_by, created_at;
      `,
      [productId, quantity, reason, referenceType, referenceId, newStock, createdBy]
    );
    
    await client.query(
      `UPDATE products SET current_stock = $1, updated_at = now() WHERE id = $2;`,
      [newStock, productId]
    );
    
    return newStock;
  });
}

export async function decrementStock(
  client: PoolClient,
  productId: string,
  quantity: number,
  reason: string,
  referenceType: string | null,
  referenceId: string | null,
  createdBy: string
): Promise<number> {
  const lockResult = await client.query<LockedProductRow>(
    `SELECT id, name, unit, mrp, gst_rate, current_stock 
     FROM products 
     WHERE id = $1 
     FOR UPDATE;`,
    [productId]
  );
  
  if (lockResult.rows.length === 0) {
    throw new Error(`Product ${productId} not found`);
  }
  
  const currentStock = parseFloat(lockResult.rows[0].current_stock);
  const newStock = currentStock - quantity;
  
  if (newStock < 0) {
    throw new Error(
      `Insufficient stock for product ${lockResult.rows[0].name}: have ${currentStock}, need ${quantity}`
    );
  }
  
  await client.query(
    `
      INSERT INTO stock_ledger (
        product_id, change_qty, reason, reference_type, reference_id, resulting_stock, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7);
    `,
    [productId, -quantity, reason, referenceType, referenceId, newStock, createdBy]
  );
  
  await client.query(
    `UPDATE products SET current_stock = $1, updated_at = now() WHERE id = $2;`,
    [newStock, productId]
  );
  
  return newStock;
}

export async function getStockLedger(
  productId?: string,
  limit: number = 50
): Promise<StockLedgerEntry[]> {
  const params: any[] = [limit];
  const productFilter = productId ? `WHERE product_id = $2` : '';
  const productIdParam = productId ? [limit, productId] : [limit];
  
  const rows = await query<LedgerRow>(
    `
      SELECT id, product_id, change_qty, reason, reference_type, reference_id, resulting_stock, created_by, created_at
      FROM stock_ledger
      ${productFilter}
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    productIdParam
  );
  
  return rows.map((row) => ({
    id: parseInt(row.id as any, 10),
    productId: row.product_id,
    changeQty: parseFloat(row.change_qty),
    reason: row.reason,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    resultingStock: parseFloat(row.resulting_stock),
    createdBy: row.created_by,
    createdAt: row.created_at
  }));
}
