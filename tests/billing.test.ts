import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectDatabase, closeDatabase } from '../services/db';
import {
  createDraftBill,
  addLineItemToDraft,
  getDraftBill,
  finalizeBillWithStockLock,
  removeLineItem
} from '../services/billing.service';
import { findProduct } from '../services/stock.service';

async function main(): Promise<void> {
  console.log('=== PostgreSQL Billing Service Test ===\n');

  await connectDatabase();

  try {
    console.log('1. Create a draft bill');
    const bill = await createDraftBill(null);
    console.log('Draft bill created:', bill.id);

    console.log('\n2. Find product using grounded search');
    const maggiMatches = await findProduct('magi');
    console.log('Maggi matches count:', maggiMatches.length);

    assert.ok(maggiMatches.length >= 1, 'Maggi should be found');

    const maggi = maggiMatches.find(
      (item) => item.name.toLowerCase() === 'maggi 70g'
    )!;

    console.log('Selected product:', maggi.name, 'Stock:', maggi.currentStock);

    console.log('\n3. Add line item to draft bill');
    const lineItem = await addLineItemToDraft(
      bill.id,
      maggi.id,
      2,
      14,
      0,
      maggi.name
    );
    console.log('Line item added:', lineItem.productName, lineItem.quantity);

    console.log('\n4. Read draft bill with totals');
    const draftWithItems = await getDraftBill(bill.id);

    if (!draftWithItems) {
      throw new Error('Draft bill not found');
    }

    console.log('Draft items count:', draftWithItems.items.length);
    console.log('Draft total:', draftWithItems.totalAmount);

    assert.equal(draftWithItems.items.length, 1);
    assert.equal(draftWithItems.totalAmount, 28);

    console.log('\n5. Remove line item');
    await removeLineItem(lineItem.id);

    const draftAfterRemove = await getDraftBill(bill.id);

    if (!draftAfterRemove) {
      throw new Error('Draft bill not found after removal');
    }

    console.log('Items after removal:', draftAfterRemove.items.length);
    console.log('Total after removal:', draftAfterRemove.totalAmount);

    assert.equal(draftAfterRemove.items.length, 0);
    assert.equal(draftAfterRemove.totalAmount, 0);

    console.log('\n6. Re-add line item for finalization test');
    const lineItem2 = await addLineItemToDraft(
      bill.id,
      maggi.id,
      2,
      14,
      0,
      maggi.name
    );
    console.log('Re-added line item quantity:', lineItem2.quantity);

    console.log('\n7. Finalize bill with stock lock and idempotency key');
    const finalized = await finalizeBillWithStockLock(
      bill.id,
      'abinaya_demo',
      crypto.randomUUID()
    );

    console.log('Bill finalized:', finalized.id);
    console.log('Finalized status:', finalized.status);
    console.log('Finalized items count:', finalized.items.length);
    console.log('Finalized total:', finalized.totalAmount);

    assert.equal(finalized.status, 'finalized');
    assert.equal(finalized.items.length, 1);
    assert.equal(finalized.totalAmount, 28);

    console.log('\n8. Verify stock decreased');
    const maggiAfter = await findProduct('maggi 70g');
    const maggiRow = maggiAfter.find((item) => item.name === 'Maggi 70g')!;

    if (!maggiRow) {
      throw new Error('Maggi row not found after finalization');
    }

    console.log('Maggi stock after finalization:', maggiRow.currentStock);

    assert.ok(
      maggiRow.currentStock <= 118,
      'Stock should have decreased by 2 units'
    );

    console.log('\nBilling service test passed.');
  } catch (error) {
    console.error('Billing service test failed with error:', error);
    throw error;
  } finally {
    await closeDatabase();
  }
}

main()
  .then(() => {
    console.log('Test completed successfully.');
  })
  .catch((error) => {
    console.error('Top-level test error:', error);
    process.exit(1);
  });