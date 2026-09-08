import { query } from './db';

export type Paise = number;

export interface KhataBalance {
  customerName: string;
  customerKey: string;
  totalCredit: number;
  totalSettlement: number;
  balance: number;
}

export interface KhataTransactionView {
  id: number;
  customerName: string;
  customerKey: string;
  transactionType: 'credit' | 'settlement';
  amount: number;
  relatedBillId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

function normalizeCustomerKey(name: string): string {
  return name.trim().toLowerCase();
}

export async function addCredit(input: {
  customerName: string;
  amount: Paise;
  note?: string;
  relatedBillId?: string;
  createdBy: string;
}): Promise<{ transactionId: number }> {
  const customerKey = normalizeCustomerKey(input.customerName);

  const rows = await query<{ id: number }>(
    `INSERT INTO khata_transactions (
      customer_name,
      customer_key,
      transaction_type,
      amount,
      related_bill_id,
      note,
      created_by
    )
    VALUES ($1, $2, 'credit', $3, $4, $5, $6)
    RETURNING id`,
    [
      input.customerName,
      customerKey,
      input.amount,
      input.relatedBillId ?? null,
      input.note ?? null,
      input.createdBy,
    ]
  );

  return { transactionId: rows[0].id };
}

export async function addSettlement(input: {
  customerName: string;
  amount: Paise;
  note?: string;
  createdBy: string;
}): Promise<{ transactionId: number }> {
  const customerKey = normalizeCustomerKey(input.customerName);

  const existing = await query<{ id: number }>(
    `SELECT id FROM khata_transactions
     WHERE customer_key = $1
     LIMIT 1`,
    [customerKey]
  );

  if (existing.length === 0) {
    throw new Error(`Khata customer "${input.customerName}" does not exist`);
  }

  const rows = await query<{ id: number }>(
    `INSERT INTO khata_transactions (
      customer_name,
      customer_key,
      transaction_type,
      amount,
      related_bill_id,
      note,
      created_by
    )
    VALUES ($1, $2, 'settlement', $3, NULL, $4, $5)
    RETURNING id`,
    [
      input.customerName,
      customerKey,
      input.amount,
      input.note ?? null,
      input.createdBy,
    ]
  );

  return { transactionId: rows[0].id };
}

export async function getBalance(customerName: string): Promise<KhataBalance> {
  const customerKey = normalizeCustomerKey(customerName);

  const rows = await query<{
    total_credit: string;
    total_settlement: string;
  }>(
    `SELECT
      COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
      COALESCE(SUM(CASE WHEN transaction_type = 'settlement' THEN amount ELSE 0 END), 0) AS total_settlement
    FROM khata_transactions
    WHERE customer_key = $1`,
    [customerKey]
  );

  const totalCredit = Number(rows[0].total_credit);
  const totalSettlement = Number(rows[0].total_settlement);
  const balance = totalCredit - totalSettlement;

  return {
    customerName,
    customerKey,
    totalCredit,
    totalSettlement,
    balance,
  };
}

export async function listTransactions(
  customerName: string,
  limit = 50
): Promise<KhataTransactionView[]> {
  const customerKey = normalizeCustomerKey(customerName);

  const rows = await query<{
    id: number;
    customer_name: string;
    customer_key: string;
    transaction_type: 'credit' | 'settlement';
    amount: string;
    related_bill_id: string | null;
    note: string | null;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT
      id,
      customer_name,
      customer_key,
      transaction_type,
      amount,
      related_bill_id,
      note,
      created_by,
      created_at
    FROM khata_transactions
    WHERE customer_key = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2`,
    [customerKey, limit]
  );

  return rows.map((row) => ({
    id: row.id,
    customerName: row.customer_name,
    customerKey: row.customer_key,
    transactionType: row.transaction_type,
    amount: Number(row.amount),
    relatedBillId: row.related_bill_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}