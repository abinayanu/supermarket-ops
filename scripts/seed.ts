import { query, connectDatabase, closeDatabase } from '../services/db';

async function main(): Promise<void> {
  await connectDatabase();

  console.log('Resetting supermarket_ops database to seed state...\n');

  // Clear transactional data
  await query(`DELETE FROM khata_transactions;`);
  await query(`DELETE FROM stock_ledger;`);
  await query(`DELETE FROM bill_items;`);
  await query(`DELETE FROM bills;`);

  // Reset products to known seed state
  await query(`DELETE FROM products;`);

  await query(`
    INSERT INTO products (
      id,
      name,
      unit,
      mrp,
      cost_price,
      gst_rate,
      hsn_code,
      current_stock,
      is_active
    )
    VALUES
      (
        gen_random_uuid(),
        'Aashirvaad Atta 5kg',
        'bag',
        250.00,
        200.00,
        5.00,
        '1101',
        50,
        true
      ),
      (
        gen_random_uuid(),
        'Britannia Good Day Biscuit',
        'packet',
        30.00,
        24.00,
        18.00,
        '1905',
        15,
        true
      ),
      (
        gen_random_uuid(),
        'Maggi 70g',
        'packet',
        14.00,
        10.00,
        0.00,
        '1902',
        100,
        true
      ),
      (
        gen_random_uuid(),
        'Tata Salt 1kg',
        'packet',
        20.00,
        16.00,
        18.00,
        '2501',
        75,
        true
      )
    ON CONFLICT DO NOTHING;
  `);

  console.log('Seed data loaded:\n');

  const products = await query<{ name: string; current_stock: string }>(
    `SELECT name, current_stock FROM products ORDER BY name;`
  );

  for (const p of products) {
    console.log(`- ${p.name}: ${p.current_stock}`);
  }

  console.log('\nDatabase reset complete.');
  await closeDatabase();
}

main().catch((error) => {
  console.error('Seed error:', error);
  process.exit(1);
});
