import { query } from '../services/db';

interface ChatSession {
  activeBillId: string | null;

  pendingFinalizeBillId: string | null;
  pendingIdempotencyKey: string | null;
  pendingPaymentMode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' | null;
  pendingUpiReference: string | null;

  lastFinalizedBillId: string | null;

  pendingProductOperation: 'ADD_TO_BILL' | 'RECEIVE_STOCK' | null;

  pendingProductChoices: {
    productId: string;
    productName: string;
    quantity: number;
  }[];

  pendingCancellationBillId: string | null;
}

const sessions = new Map<number, ChatSession>();

function getOrCreateSession(chatId: number): ChatSession {
  let session = sessions.get(chatId);

  if (!session) {
    session = {
      activeBillId: null,

      pendingFinalizeBillId: null,
      pendingIdempotencyKey: null,
      pendingPaymentMode: null,
      pendingUpiReference: null,

      lastFinalizedBillId: null,

      pendingProductOperation: null,
      pendingProductChoices: [],

      pendingCancellationBillId: null
    };

    sessions.set(chatId, session);
  }

  return session;
}

// ============ ACTIVE BILL ============

export function getActiveBillId(chatId: number): string | null {
  return getOrCreateSession(chatId).activeBillId;
}

export function setActiveBillId(
  chatId: number,
  billId: string | null
): void {
  getOrCreateSession(chatId).activeBillId = billId;
}

// ============ FINALIZATION ============

export function setPendingFinalization(
  chatId: number,
  billId: string,
  idempotencyKey: string,
  paymentMode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT',
  upiReference?: string
): void {
  const session = getOrCreateSession(chatId);

  session.pendingFinalizeBillId = billId;
  session.pendingIdempotencyKey = idempotencyKey;
  session.pendingPaymentMode = paymentMode;
  session.pendingUpiReference = upiReference ?? null;
}

export function getPendingFinalization(chatId: number): {
  billId: string | null;
  idempotencyKey: string | null;
  paymentMode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' | null;
  upiReference: string | null;
} {
  const session = getOrCreateSession(chatId);

  return {
    billId: session.pendingFinalizeBillId,
    idempotencyKey: session.pendingIdempotencyKey,
    paymentMode: session.pendingPaymentMode,
    upiReference: session.pendingUpiReference
  };
}

export function clearPendingFinalization(chatId: number): void {
  const session = getOrCreateSession(chatId);

  session.pendingFinalizeBillId = null;
  session.pendingIdempotencyKey = null;
  session.pendingPaymentMode = null;
  session.pendingUpiReference = null;
}

// ============ LAST FINALIZED BILL ============

export function setLastFinalizedBillId(
  chatId: number,
  billId: string | null
): void {
  getOrCreateSession(chatId).lastFinalizedBillId = billId;
}

export function getLastFinalizedBillId(
  chatId: number
): string | null {
  return getOrCreateSession(chatId).lastFinalizedBillId;
}

// ============ PRODUCT SELECTION ============

export function setPendingProductChoices(
  chatId: number,
  operation: 'ADD_TO_BILL' | 'RECEIVE_STOCK',
  choices: {
    productId: string;
    productName: string;
    quantity: number;
  }[]
): void {
  const session = getOrCreateSession(chatId);

  session.pendingProductOperation = operation;
  session.pendingProductChoices = choices;
}

export function getPendingProductChoices(chatId: number): {
  operation: 'ADD_TO_BILL' | 'RECEIVE_STOCK' | null;
  choices: {
    productId: string;
    productName: string;
    quantity: number;
  }[];
} {
  const session = getOrCreateSession(chatId);

  return {
    operation: session.pendingProductOperation,
    choices: session.pendingProductChoices
  };
}

export function clearPendingProductChoices(chatId: number): void {
  const session = getOrCreateSession(chatId);

  session.pendingProductOperation = null;
  session.pendingProductChoices = [];
}

// ============ CANCELLATION ============

export function setPendingCancellation(
  chatId: number,
  billId: string
): void {
  const session = getOrCreateSession(chatId);

  session.pendingCancellationBillId = billId;
}

export function getPendingCancellation(
  chatId: number
): string | null {
  return getOrCreateSession(chatId).pendingCancellationBillId;
}

export function clearPendingCancellation(
  chatId: number
): void {
  getOrCreateSession(chatId).pendingCancellationBillId = null;
}

// ============ PREFERENCES ============

export async function setPreference(
  chatId: number,
  key: string,
  value: string
): Promise<void> {
  await query(
    `
      INSERT INTO preferences (key, value, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (key) DO UPDATE
        SET value = $2::jsonb,
            updated_by = $3,
            updated_at = now();
    `,
    [
      `chat_${chatId}_${key}`,
      JSON.stringify(value),
      `telegram:${chatId}`
    ]
  );
}

export async function getPreference(
  chatId: number,
  key: string
): Promise<string | null> {
  const rows = await query<{ value: unknown }>(
    `
      SELECT value
      FROM preferences
      WHERE key = $1;
    `,
    [`chat_${chatId}_${key}`]
  );

  if (rows.length === 0) {
    return null;
  }

  const value = rows[0].value;

  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'value' in value
  ) {
    return String((value as { value: unknown }).value);
  }

  return String(value);
}

// ============ CLEAR SESSION ============

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
}