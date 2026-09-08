import { query, connectDatabase, closeDatabase } from '../services/db';

async function addColumnIfNotExists(table: string, column: string, type: string, defaultValue?: string) {
  const checkQuery = `
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = '${table}' AND column_name = '${column}';
  `;
  
  const exists = await query<{ one: number }>(checkQuery);
  
  if (exists.length === 0) {
    const defaultClause = defaultValue ? ` DEFAULT ${defaultValue}` : '';
    const alterQuery = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause};`;
    await query(alterQuery);
    console.log(`  ✓ Added ${column} to ${table}`);
  } else {
    console.log(`  - ${column} already exists on ${table}`);
  }
}

async function dropColumnIfExists(table: string, column: string) {
  const checkQuery = `
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = '${table}' AND column_name = '${column}';
  `;
  
  const exists = await query<{ one: number }>(checkQuery);
  
  if (exists.length > 0) {
    await query(`ALTER TABLE ${table} DROP COLUMN ${column};`);
    console.log(`  ✓ Dropped ${column} from ${table}`);
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  console.log('\n🔄 Running schema migrations...\n');

  // === bills table ===
  console.log('Migrating bills table:');
  await addColumnIfNotExists('bills', 'subtotal', 'numeric(10,2)');
  await addColumnIfNotExists('bills', 'cgst_amount', 'numeric(10,2)');
  await addColumnIfNotExists('bills', 'sgst_amount', 'numeric(10,2)');
  await addColumnIfNotExists('bills', 'rounding_adjustment', 'numeric(10,2)', '0');
  await addColumnIfNotExists('bills', 'idempotency_key', 'text');
  
  // Drop old total_amount if it exists (we'll recreate it)
  await dropColumnIfExists('bills', 'total_amount');
  await addColumnIfNotExists('bills', 'total_amount', 'numeric(10,2)');

  // === bill_items table ===
  console.log('\nMigrating bill_items table:');
  await dropColumnIfExists('bill_items', 'price');
  await dropColumnIfExists('bill_items', 'subtotal');
  await addColumnIfNotExists('bill_items', 'unit_price', 'numeric(10,2)');
  await addColumnIfNotExists('bill_items', 'gst_rate', 'numeric(4,2)');
  await addColumnIfNotExists('bill_items', 'line_subtotal', 'numeric(10,2)');

  // === stock_ledger table ===
  console.log('\nMigrating stock_ledger table:');
  await dropColumnIfExists('stock_ledger', 'change');
  await addColumnIfNotExists('stock_ledger', 'change_qty', 'numeric(12,3)');
  await addColumnIfNotExists('stock_ledger', 'reason', 'text');
  await addColumnIfNotExists('stock_ledger', 'resulting_stock', 'numeric(12,3)');
  await addColumnIfNotExists('stock_ledger', 'created_by', 'text', "'system'");

  // === khata_transactions table ===
  console.log('\nMigrating khata_transactions table:');
  await addColumnIfNotExists('khata_transactions', 'customer_key', 'text');

  // === Update bills.status to allow 'void' ===
  console.log('\nUpdating bills.status enum:');
  await query(`
    ALTER TABLE bills 
    ALTER COLUMN status TYPE text;
  `);
  console.log('  ✓ bills.status now accepts: draft | finalized | void');

  console.log('\n✅ Schema migration complete.\n');
  
  await closeDatabase();
}

main().catch((error) => {
  console.error('Migration error:', error);
  process.exit(1);
});
