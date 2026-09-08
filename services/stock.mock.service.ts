// services/stock.service.ts

export interface StockEntry {
  id: number;
  product_id: number;
  quantity_change: number;  // positive for receive, negative for sale
  reference_type: 'receive' | 'sale' | 'adjustment';
  reference_id: string | null;
  created_at: Date;
}

export interface ProductStock {
  product_id: number;
  product_name: string;
  current_stock: number;
}

// Mock database - replace with real DB calls later
const mockProducts: Map<number, { id: number; name: string; stock: number }> = new Map([
  [1, { id: 1, name: 'Maggi 70g', stock: 100 }],
  [2, { id: 2, name: 'Aashirvaad 5kg', stock: 50 }],
  [3, { id: 3, name: 'Tata Salt 1kg', stock: 75 }],
]);

const mockStockLedger: StockEntry[] = [];

export function receiveStock(productId: number, quantity: number, referenceId?: string): StockEntry {
  const product = mockProducts.get(productId);
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }
  
  // Update stock
  product.stock += quantity;
  
  // Create ledger entry
  const entry: StockEntry = {
    id: mockStockLedger.length + 1,
    product_id: productId,
    quantity_change: quantity,
    reference_type: 'receive',
    reference_id: referenceId || null,
    created_at: new Date(),
  };
  
  mockStockLedger.push(entry);
  return entry;
}

export function getStock(productId: number): ProductStock | null {
  const product = mockProducts.get(productId);
  if (!product) return null;
  
  return {
    product_id: productId,
    product_name: product.name,
    current_stock: product.stock,
  };
}

export function getLowStock(threshold: number = 20): ProductStock[] {
  const lowStockItems: ProductStock[] = [];
  
  for (const [id, product] of mockProducts) {
    if (product.stock <= threshold) {
      lowStockItems.push({
        product_id: id,
        product_name: product.name,
        current_stock: product.stock,
      });
    }
  }
  
  return lowStockItems;
}

export function decrementStock(productId: number, quantity: number, referenceId: string): StockEntry {
  const product = mockProducts.get(productId);
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }
  
  if (product.stock < quantity) {
    throw new Error(`Insufficient stock: have ${product.stock}, need ${quantity}`);
  }
  
  // Update stock
  product.stock -= quantity;
  
  // Create ledger entry
  const entry: StockEntry = {
    id: mockStockLedger.length + 1,
    product_id: productId,
    quantity_change: -quantity,  // negative for sale
    reference_type: 'sale',
    reference_id: referenceId,
    created_at: new Date(),
  };
  
  mockStockLedger.push(entry);
  return entry;
}