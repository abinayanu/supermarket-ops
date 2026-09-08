import assert from 'node:assert/strict';
import {
  closeDatabase
} from '../services/db';
import {
  findProduct,
  getLowStock,
  getStock,
  receiveStock
} from '../services/stock.service';

async function main(): Promise<void> {
  console.log('=== PostgreSQL Stock Service Test ===\n');

  console.log('1. Grounded fuzzy product lookup');
  const maggiMatches = await findProduct('magi');

  console.log(
    'Matches:',
    maggiMatches.map((item) => `${item.name} (${item.currentStock})`)
  );

  assert.ok(maggiMatches.length >= 1, 'Maggi should be found in the database.');

  const maggi = maggiMatches.find(
    (item) => item.name.toLowerCase() === 'maggi 70g'
  );

  assert.ok(maggi, 'Expected to find Maggi 70g.');

  console.log('\n2. Read stock before receipt');
  const stockBefore = await getStock(maggi.id);

  assert.ok(stockBefore, 'Maggi stock record should exist.');
  console.log('Starting stock:', stockBefore.currentStock);

  console.log('\n3. Receive stock using a database transaction');
  const received = await receiveStock(
    maggi.id,
    10,
    'abinaya_demo',
    'demo_receipt'
  );

  console.log('Stock ledger entry:', received);

  console.log('\n4. Read stock after receipt');
  const stockAfter = await getStock(maggi.id);

  assert.ok(stockAfter, 'Maggi stock record should still exist.');
  console.log('Stock after receipt:', stockAfter.currentStock);

  assert.equal(
    stockAfter.currentStock,
    stockBefore.currentStock + 10,
    'Stock must increase by exactly the received quantity.'
  );

  console.log('\n5. Low-stock query');
  const lowStockItems = await getLowStock(20);

  console.log(
    'Low-stock products:',
    lowStockItems.map((item) => `${item.name}: ${item.currentStock}`)
  );

  assert.ok(
    lowStockItems.some(
      (item) => item.name === 'Britannia Good Day Biscuit'
    ),
    'Britannia should appear in low stock at threshold 20.'
  );

  console.log('\nDatabase-backed stock test passed.');
  await closeDatabase();
}

main().catch(async (error) => {
  console.error('Database-backed stock test failed:', error);
  await closeDatabase();
  process.exit(1);
});