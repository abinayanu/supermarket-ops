import { closeDatabase, query } from '../services/db';

async function main(): Promise<void> {
  const databaseRows = await query<{ database_name: string }>(
    'SELECT current_database() AS database_name'
  );

  console.log('Connected to database:', databaseRows[0].database_name);

  const productRows = await query<{ product_count: string }>(
    'SELECT COUNT(*) AS product_count FROM products'
  );

  console.log('Products currently in database:', productRows[0].product_count);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('Database connection test failed:', error);
  await closeDatabase();
  process.exit(1);
});