import * as readline from 'readline';
import * as crypto from 'crypto';
import { connectDatabase, closeDatabase } from '../services/db';
import { findProduct } from '../services/stock.service';
import {
  addLineItem,
  createDraftBill,
  finalizeBill,
  getDraftBill,
  setBillCustomer
} from '../services/billing.service';
import { getBalance } from '../services/khata.service';

interface SessionState {
  currentBillId: string | null;
  currentCustomer: string | null;
}

const session: SessionState = {
  currentBillId: null,
  currentCustomer: null
};

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function addItem(args: string): Promise<void> {
  const match = args.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);

  if (!match) {
    console.log('Usage: item <quantity> <product name>');
    console.log('Example: item 2 maggi');
    return;
  }

  const quantity = Number(match[1]);
  const productQuery = match[2].trim();

  if (!Number.isFinite(quantity) || quantity <= 0) {
    console.log('Quantity must be greater than zero.');
    return;
  }

  const products = await findProduct(productQuery);

  if (products.length === 0) {
    console.log(`No product found matching: ${productQuery}`);
    return;
  }

  if (products.length > 1) {
    console.log('Multiple products matched. Please be more specific:');

    for (const product of products) {
      console.log(`  - ${product.name} (stock: ${product.currentStock})`);
    }

    return;
  }

  const product = products[0];

  if (!session.currentBillId) {
    session.currentBillId = await createDraftBill(session.currentCustomer);

    console.log(`Created new draft bill: ${session.currentBillId}`);
  }

  await addLineItem(
    session.currentBillId,
    product.id,
    quantity,
    Number(product.mrp),
    Number(product.gst_rate)
  );

  console.log(
    `Added ${quantity} × ${product.name} to bill. Current stock: ${product.currentStock}`
  );
}

async function setCustomer(args: string): Promise<void> {
  const customerName = args.trim();

  if (!customerName) {
    console.log('Usage: customer <name>');
    return;
  }

  session.currentCustomer = customerName;

  if (session.currentBillId) {
    await setBillCustomer(session.currentBillId, customerName);
    console.log(`Customer set to: ${customerName}`);
    return;
  }

  console.log(`Customer saved for the next bill: ${customerName}`);
}

async function showBill(): Promise<void> {
  if (!session.currentBillId) {
    console.log('No active draft bill. Start with: item <quantity> <product>');
    return;
  }

  const bill = await getDraftBill(session.currentBillId);

  if (!bill) {
    console.log('The active draft bill was not found. Clearing session.');
    session.currentBillId = null;
    return;
  }

  console.log('\nCurrent draft bill:');
  console.log(`ID: ${bill.id}`);
  console.log(`Customer: ${bill.customerRef ?? '(not set)'}`);
  console.log('Items:');

  for (const item of bill.items) {
    console.log(
      `  - ${item.productName}: ${item.quantity} × ${item.unitPrice.toFixed(2)} = ${item.lineSubtotal.toFixed(2)} (GST ${item.gstRate}%)`
    );
  }

  console.log(`Subtotal: ${bill.subtotal.toFixed(2)}`);
  console.log(`Estimated GST: ${bill.estimatedGst.toFixed(2)}`);
  console.log(`Estimated total: ${bill.estimatedTotal.toFixed(2)}\n`);
}

async function finalizeCurrentBill(): Promise<void> {
  if (!session.currentBillId) {
    console.log('No active draft bill to finalize.');
    return;
  }

  try {
    const result = await finalizeBill(
      session.currentBillId,
      generateIdempotencyKey(),
      'cli-agent'
    );

    console.log('\nBill finalized:');
    console.log(`ID: ${result.id}`);
    console.log(`Subtotal: ${result.subtotal.toFixed(2)}`);
    console.log(`CGST: ${result.cgstAmount.toFixed(2)}`);
    console.log(`SGST: ${result.sgstAmount.toFixed(2)}`);
    console.log(`Rounding: ${result.roundingAdjustment.toFixed(2)}`);
    console.log(`Total: ${result.totalAmount.toFixed(2)}`);
    console.log(`Customer: ${result.customerRef ?? '(none)'}`);

    if (result.customerRef) {
      console.log('(Khata credit auto-created)');
    }

    console.log('');

    session.currentBillId = null;
    session.currentCustomer = null;
  } catch (error: any) {
    console.log(`Error finalizing bill: ${error.message}`);
  }
}

async function showBalance(args: string): Promise<void> {
  const customerName = args.trim();

  if (!customerName) {
    console.log('Usage: balance <customer name>');
    return;
  }

  const balance = await getBalance(customerName);

  console.log(`\nKhata balance for ${balance.customerName}:`);
  console.log(`Customer key: ${balance.customerKey}`);
  console.log(`Total credit: ${balance.totalCredit.toFixed(2)}`);
  console.log(`Total settlement: ${balance.totalSettlement.toFixed(2)}`);
  console.log(`Outstanding balance: ${balance.balance.toFixed(2)}\n`);
}

function printHelp(): void {
  console.log('\nAvailable commands:');
  console.log('  item <qty> <product>  - Add an item to the current draft bill');
  console.log('  customer <name>       - Set the customer for this bill');
  console.log('  bill                  - Show current draft bill');
  console.log('  finalize              - Finalize bill, decrement stock, create khata credit');
  console.log('  balance <customer>    - Show khata balance');
  console.log('  help                  - Show available commands');
  console.log('  exit                  - Exit the CLI\n');
}

async function main(): Promise<void> {
  await connectDatabase();

  console.log('\n=== Supermarket CLI Test Harness ===');
  console.log('Type "help" for available commands.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = (): void => {
    rl.question('> ', async (input) => {
      const raw = input.trim();

      if (!raw) {
        prompt();
        return;
      }

      const [commandRaw, ...rest] = raw.split(/\s+/);
      const command = commandRaw.toLowerCase();
      const args = rest.join(' ');

      try {
        if (command === 'item') {
          await addItem(args);
        } else if (command === 'customer') {
          await setCustomer(args);
        } else if (command === 'bill') {
          await showBill();
        } else if (command === 'finalize') {
          await finalizeCurrentBill();
        } else if (command === 'balance') {
          await showBalance(args);
        } else if (command === 'help') {
          printHelp();
        } else if (command === 'exit' || command === 'quit') {
          console.log('Exiting CLI test harness.');
          rl.close();
          await closeDatabase();
          return;
        } else {
          console.log(`Unknown command: ${command}. Type "help" for commands.`);
        }
      } catch (error: any) {
        console.log(`Error: ${error.message}`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
