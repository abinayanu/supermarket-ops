interface ChatSession {
  activeBillId: string | null;
  pendingFinalizeBillId: string | null;
  pendingIdempotencyKey: string | null;
  lastFinalizedBillId: string | null;
  preferences: Map<string, string>;
}

const sessions = new Map<number, ChatSession>();

function getOrCreateSession(chatId: number): ChatSession {
  let session = sessions.get(chatId);

  if (!session) {
    session = {
      activeBillId: null,
      pendingFinalizeBillId: null,
      pendingIdempotencyKey: null,
      lastFinalizedBillId: null,
      preferences: new Map()
    };

    sessions.set(chatId, session);
  }

  return session;
}

export function getActiveBillId(chatId: number): string | null {
  return getOrCreateSession(chatId).activeBillId;
}

export function setActiveBillId(
  chatId: number,
  billId: string | null
): void {
  getOrCreateSession(chatId).activeBillId = billId;
}

export function setPendingFinalization(
  chatId: number,
  billId: string,
  idempotencyKey: string
): void {
  const session = getOrCreateSession(chatId);

  session.pendingFinalizeBillId = billId;
  session.pendingIdempotencyKey = idempotencyKey;
}

export function getPendingFinalization(chatId: number): {
  billId: string | null;
  idempotencyKey: string | null;
} {
  const session = getOrCreateSession(chatId);

  return {
    billId: session.pendingFinalizeBillId,
    idempotencyKey: session.pendingIdempotencyKey
  };
}

export function clearPendingFinalization(chatId: number): void {
  const session = getOrCreateSession(chatId);

  session.pendingFinalizeBillId = null;
  session.pendingIdempotencyKey = null;
}

export function setLastFinalizedBillId(
  chatId: number,
  billId: string | null
): void {
  getOrCreateSession(chatId).lastFinalizedBillId = billId;
}

export function getLastFinalizedBillId(chatId: number): string | null {
  return getOrCreateSession(chatId).lastFinalizedBillId;
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
}

// ============ PREFERENCES ============

export function setPreference(
  chatId: number,
  key: string,
  value: string
): void {
  const session = getOrCreateSession(chatId);
  session.preferences.set(key, value);
}

export function getPreference(
  chatId: number,
  key: string
): string | null {
  const session = getOrCreateSession(chatId);
  return session.preferences.get(key) || null;
}