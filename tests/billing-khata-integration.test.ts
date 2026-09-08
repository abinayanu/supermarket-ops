import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectDatabase, closeDatabase, query } from '../services/db';
import {
  createDraftBill,
  addLineItemToDraft,
  finalizeBillWithStockLock,
  getDraftBill
} from '../services/billing.service';
import { findProduct } from '../services/stock.service';
import { getBalance, listTransactions } from '../services/khata.service';

async function main(): Promise<void> {
  console.log('=== Billing ↔ Khata Integration Test ===\n');

  await connectDatabase();

  try {
    console.log('1. Create a draft bill with customer_ref');

    const bill = await createDraftBill(null);

    await query(
      `UPDATE bills SET customer_ref = $1 WHERE id = $2`,
      ['Ramesh', bill.id]
    );

    console.log('Draft bill ID:', bill.id, 'customer_ref: Ramesh');

    console.log('\n2. Find product and add line item');

    const maggiMatches = await findProduct('maggi 70g');
    const maggi = maggiMatches.find((m) => m.name === 'Maggi 70g')!;

    console.log('Product:', maggi.name, 'Stock:', maggi.currentStock);

    await addLineItemToDraft(
      bill.id,
      maggi.id,
      2,
      14,
      0,
      maggi.name
    );

    const draftWithItems = await getDraftBill(bill.id);
    console.log('Draft total:', draftWithItems!.totalAmount);

    console.log('\n3. Finalize bill (should auto-create khata credit)');
    console.log('About to call finalizeBillWithStockLock...');

    let finalized;
    try {
      finalized = await finalizeBillWithStockLock(
        bill.id,
        'test_user',
        crypto.randomUUID()
      );
      console.log('finalizeBillWithStockLock returned:', finalized.id);
    } catch (err) {
      console.error('Finalize failed with error:', err);
      throw err;
    }

    console.log('Bill finalized:', finalized.id);
    console.log('Finalized total:', finalized.totalAmount);
    console.log('Customer ref:', finalized.customerRef);

    assert.equal(finalized.status, 'finalized');
    assert.equal(finalized.totalAmount, 28);
    assert.equal(finalized.customerRef, 'Ramesh');

    console.log('\n4. Check khata balance for Ramesh');

    const rameshBalance = await getBalance('Ramesh');

    console.log('Ramesh balance:', rameshBalance);

    assert.equal(rameshBalance.totalCredit, 28);
    assert.equal(rameshBalance.balance, 28);

    console.log('\n5. Check khata transactions for Ramesh');

    const txns = await listTransactions('Ramesh', 10);

    console.log('Transaction count:', txns.length);
    console.log(
      'Transactions:',
      txns.map((t) => ({
        type: t.transactionType,
        amount: t.amount,
        relatedBillId: t.relatedBillId,
      }))
    );

    assert.equal(txns.length, 1);
    assert.equal(txns[0].transactionType, 'credit');
    assert.equal(txns[0].amount, 28);
    assert.equal(txns[0].relatedBillId, bill.id);

    console.log('\nBilling ↔ Khata integration test passed.');
  } catch (error) {
    console.error('Integration test failed with error:', error);
    throw error;
  } finally {
    await closeDatabase();
  }
}

main()
  .then(() => {
    console.log('Integration test completed successfully.');
  })
  .catch((error) => {
    console.error('Top-level integration test error:', error);
    process.exit(1);
  });