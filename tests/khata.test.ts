import assert from 'node:assert/strict';
import { connectDatabase, closeDatabase } from '../services/db';
import {
  addCredit,
  addSettlement,
  getBalance,
  listTransactions
} from '../services/khata.service';

async function main(): Promise<void> {
  console.log('=== PostgreSQL Khata Service Test ===\n');

  await connectDatabase();

  try {
    console.log('1. Credit → settle → balance');

    const rameshCredit = await addCredit({
      customerName: 'Ramesh',
      amount: 500,
      note: 'Initial credit',
      createdBy: 'test_user',
    });

    console.log('Credit transaction ID:', rameshCredit.transactionId);

    const rameshSettlement = await addSettlement({
      customerName: 'Ramesh',
      amount: 300,
      note: 'Partial payment',
      createdBy: 'test_user',
    });

    console.log('Settlement transaction ID:', rameshSettlement.transactionId);

    const balance = await getBalance('Ramesh');

    console.log('Balance:', balance);

    assert.equal(balance.totalCredit, 500);
    assert.equal(balance.totalSettlement, 300);
    assert.equal(balance.balance, 200);

    console.log('\n2. List transactions for Ramesh');

    const txns = await listTransactions('Ramesh');

    console.log('Transaction count:', txns.length);
    console.log(
      'Transactions:',
      txns.map((t) => `${t.transactionType} ${t.amount}`)
    );

    assert.equal(txns.length, 2);

    console.log('\n3. Concurrent credits (no lost writes)');

    const [c1, c2] = await Promise.all([
      addCredit({
        customerName: 'Suresh',
        amount: 100,
        note: 'Concurrent credit 1',
        createdBy: 'test_user',
      }),
      addCredit({
        customerName: 'Suresh',
        amount: 100,
        note: 'Concurrent credit 2',
        createdBy: 'test_user',
      }),
    ]);

    console.log('Concurrent credit IDs:', c1.transactionId, c2.transactionId);

    const sureshBalance = await getBalance('Suresh');

    console.log('Suresh balance:', sureshBalance);

    assert.equal(sureshBalance.totalCredit, 200);
    assert.equal(sureshBalance.balance, 200);

    console.log('\nKhata service test passed.');
  } catch (error) {
    console.error('Khata service test failed with error:', error);
    throw error;
  } finally {
    await closeDatabase();
  }
}

main()
  .then(() => {
    console.log('Khata test completed successfully.');
  })
  .catch((error) => {
    console.error('Top-level khata test error:', error);
    process.exit(1);
  });