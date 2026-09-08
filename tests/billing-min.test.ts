import { query, connectDatabase, closeDatabase } from '../services/db';
import crypto from 'node:crypto';

async function main(): Promise<void> {
  console.log('=== Minimal Billing DB Test ===\n');

  try {
    await connectDatabase();
    console.log('DB connected');

    const id = crypto.randomUUID();
    console.log('Generated bill id:', id);

    console.log('Attempting INSERT into bills...');

    const rows = await query(
      `
      INSERT INTO bills (id, telegram_chat_id, status)
      VALUES ($1, $2, 'draft')
      RETURNING id, status
      `,
      [id, null]
    );

    console.log('Insert succeeded, rows:', rows);
  } catch (error) {
    console.error('Error during minimal test:', error);
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('Top-level error:', error);
  process.exit(1);
});