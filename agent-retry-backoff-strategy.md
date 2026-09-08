# Supermarket Ops Agent — Retry, Backoff & Reconciliation Strategy

*(Agent-layer contract for Day 3. Sits directly on top of `service-interfaces.ts` and `transaction-lock-strategy.md`. No new tools, services, or tables — this specifies how the agent orchestration layer calls the existing tools.)*

---

## 0. The one distinction the whole policy hangs on

Not every retryable error is safe to retry the same way, and this matters more than the specific numbers:

- **`CONCURRENT_MODIFICATION`** (Postgres `40001` serialization failure / `40P01` deadlock) is *always* safe to auto-retry, for *any* mutating tool. Postgres guarantees the losing transaction was fully rolled back before the client ever sees this error — nothing partially applied, ever.
- **`DB_UNAVAILABLE`** (connection dropped) has an *ambiguous* commit status. The connection can fail after the server already committed but before the client received the acknowledgment. Blindly retrying a mutation that has no durable idempotency key risks a silent double-write (double stock decrement, double khata credit).

So the retry policy is keyed on **both** the error code **and** whether the specific tool has a durable idempotency key — not on the error code alone.

| Tool safety tier | Tools | Auto-retry on `CONCURRENT_MODIFICATION`? | Auto-retry on `DB_UNAVAILABLE`? |
|---|---|---|---|
| **Idempotent-key** | `finalizeBill` (has `idempotency_key`) | Yes | Yes |
| **Transaction-safe-only** | `receiveStock`, `addOrUpdateItem`, `editItem`, `addCredit`, `addSettlement`, `recordAdjustment`, `confirmShortcut` | Yes | **No** — surface the error immediately |
| **Read-only** | `getStock`, `checkAvailability`, `getBalance`, `getBillState`, `findProduct`, `listLowStock`, `evaluateForProposal`, `getActiveShortcut` | Yes | Yes (nothing to double-write) |

For the "transaction-safe-only" tier, `DB_UNAVAILABLE` is *not* auto-retried by the agent. Recovery is the owner naturally repeating themselves ("got 10 box maggi today" again) — a visible, correctable duplicate is far safer than an invisible silent one. This is the honest gap in the current schema: only `finalizeBill` has a client idempotency key. If stronger guarantees are wanted later, `receiveStock` could reuse `stock_ledger.reference_type`/`reference_id` (already existing columns) to carry a client-generated key the same way — flagged here as a future hardening note, not built now, since it's outside today's scope.

---

## 1. Backoff Policies

```ts
interface RetryPolicy {
  maxRetries: number;     // additional attempts, beyond the original call
  backoffMs: number[];    // one entry per retry attempt, in order
}

const CONCURRENT_MODIFICATION_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: [100, 250],   // short — contention typically clears in milliseconds
};

const DB_UNAVAILABLE_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [500, 1000, 2000],   // longer — a dropped connection needs real recovery time
};
```

- `CONCURRENT_MODIFICATION`: **2 retries**, backoff **100ms, 250ms** (3 attempts total, ~350ms worst case before giving up).
- `DB_UNAVAILABLE` (idempotent-key or read-only tools only): **3 retries**, backoff **500ms, 1s, 2s** (4 attempts total, ~3.5s worst case).
- All other error codes: **0 retries**, immediate return.

---

## 2. Retry Wrapper — Pseudo-code

```ts
type MutationSafety = 'idempotent-key' | 'transaction-safe-only' | 'read-only';

interface CancellationToken {
  isCancelled(): boolean;
}

async function callToolWithRetry<T>(
  toolFn: () => Promise<Result<T>>,     // closure already bound with args,
                                          // including a fixed idempotencyKey
                                          // for finalizeBill (see §4)
  safety: MutationSafety,
  cancellationToken: CancellationToken,
): Promise<Result<T>> {

  let result = await toolFn();           // attempt 0, always made once
  if (result.ok) return result;

  let lastError = result.error;
  const policy = choosePolicy(lastError, safety);
  if (!policy) return result;            // non-retryable: return as-is, immediately

  for (let attempt = 0; attempt < policy.maxRetries; attempt++) {
    if (cancellationToken.isCancelled()) return cancelledResult();

    await sleep(policy.backoffMs[attempt]);

    if (cancellationToken.isCancelled()) return cancelledResult();

    result = await toolFn();
    if (result.ok) return result;

    lastError = result.error;
    // If the error class changed mid-retry (e.g. contention resolved but the
    // stock is now genuinely insufficient), stop — it's no longer transient.
    if (!choosePolicy(lastError, safety)) return result;
  }

  return result;   // retries exhausted, return the last error as-is
}

function choosePolicy(error: ServiceError, safety: MutationSafety): RetryPolicy | null {
  if (error.code === 'CONCURRENT_MODIFICATION') {
    return CONCURRENT_MODIFICATION_POLICY;          // always safe, any tier
  }
  if (error.code === 'DB_UNAVAILABLE') {
    return safety === 'transaction-safe-only' ? null : DB_UNAVAILABLE_POLICY;
  }
  return null;   // VALIDATION_ERROR, INSUFFICIENT_STOCK, BELOW_COST,
                 // PRODUCT_NOT_FOUND, BILL_NOT_FOUND, BILL_NOT_DRAFT,
                 // CUSTOMER_NOT_FOUND, DUPLICATE_FINALIZE: never retried
}

function cancelledResult<T>(): Result<T> {
  return { ok: false, error: { code: 'UNKNOWN', message: 'cancelled by user', retryable: false } };
}
```

The wrapper is the *only* place retry logic lives. Every tool call the agent makes goes through `callToolWithRetry` — individual tool implementations never retry themselves.

---

## 3. Decision Tree — Retry Silently vs. Show the User an Error

```
Tool call returns...
│
├─ ok: true
│    → proceed normally, use the fresh result to phrase the reply
│
└─ ok: false, error.code = ?
     │
     ├─ VALIDATION_ERROR / PRODUCT_NOT_FOUND / BILL_NOT_FOUND / BILL_NOT_DRAFT /
     │  CUSTOMER_NOT_FOUND / INSUFFICIENT_STOCK / BELOW_COST / DUPLICATE_FINALIZE
     │    → NEVER retry. Show the humanized error immediately (H.1a-style,
     │      or the specific stock/cost copy from the original architecture).
     │
     ├─ CONCURRENT_MODIFICATION
     │    → Retry silently, up to 2 times, 100ms/250ms backoff.
     │      No message sent to the user during these retries.
     │      ├─ Succeeds on retry → proceed normally, no mention of the retry.
     │      └─ Exhausted → show H.1a copy: "Someone else's sale just changed
     │         this — let me recheck stock before I continue." followed by
     │         a fresh, explicit stock re-check (see §5) before ending the turn.
     │
     └─ DB_UNAVAILABLE
          ├─ Tool is idempotent-key or read-only:
          │    → Retry silently, up to 3 times, 500ms/1s/2s backoff.
          │      Optionally send a Telegram "typing" chat action (not a text
          │      message) if elapsed time exceeds ~1s, so the chat doesn't
          │      look frozen. No text message until retries are exhausted.
          │      ├─ Succeeds on retry → proceed normally.
          │      └─ Exhausted → show: "I can't reach the shop's records right
          │         now. Nothing has been changed — please try again in a
          │         minute."
          │
          └─ Tool is transaction-safe-only:
               → NO auto-retry. Show the same H.1a copy immediately, since
                 an ambiguous-commit-status write must not be silently
                 repeated. The owner's own natural repeat of the message is
                 the safe recovery path.
```

---

## 4. Idempotency in Retries — `finalizeBill` specifically

- The `idempotencyKey` (client-generated UUID) is generated **once**, at the moment the agent first decides to call `finalizeBill` for this attempt — not regenerated per retry.
- `callToolWithRetry` wraps a closure that captures this single key:

```ts
const idempotencyKey = crypto.randomUUID();   // generated once per finalize attempt
const toolFn = () => billingService.finalizeBill({ billId, idempotencyKey });
const result = await callToolWithRetry(toolFn, 'idempotent-key', token);
```

- Every retry attempt inside the wrapper calls `toolFn()` again, which sends the **identical** `idempotencyKey`. The tool's own transaction (§3.3 of `transaction-lock-strategy.md`) is what actually enforces the dedup — if attempt 1 secretly succeeded server-side just as the connection dropped, attempt 2 arrives, locks the now-already-`finalized` bill row, sees `idempotency_key` matches and `finalized_at` is within 24h, and returns the original result instead of re-decrementing stock. The retry wrapper doesn't need to know this happened; it just sees `ok: true` either way.
- **When NOT to retry, even within policy:**
  - The user explicitly cancels mid-wait (checked before every backoff and every attempt, per §2).
  - The error is non-retryable per §3 (e.g. a second attempt reveals `BELOW_COST` because cost price changed between attempts — this is a real business-rule failure, not transient, so it's returned as-is rather than retried further).
  - `DUPLICATE_FINALIZE`-shaped outcomes aren't actually a failure to retry — an idempotent replay is a **success** path (`ok: true`, `wasAlreadyFinalized: true`); the agent just doesn't narrate that it was a replay to the owner, it reports the bill as done.

---

## 5. Agent-Layer State Reconciliation

The principle: **after any retry, never reuse pre-retry beliefs — always phrase the reply from the data the successful (or final failed) call actually returned.**

- **On success after retry:** `finalizeBill`'s own return value (`FinalizeResult`, containing the authoritative `BillBreakup`) is what the agent uses to compose its reply. It never falls back to an earlier in-conversation total computed before the retry — that value may now be stale by definition (the whole reason `CONCURRENT_MODIFICATION` fired is that something else changed underneath it).
- **On `INSUFFICIENT_STOCK` surfaced after a `CONCURRENT_MODIFICATION` retry is exhausted:** the agent does not just repeat a generic message — it makes one explicit follow-up call to `getStock(productId)` (read-only, cheap, always safe to retry per §0) to get the current count, so the H.1a copy is accurate: *"Only 6 Maggi packets are left. I can't bill 10."* The exact count comes from this fresh read, not from whatever the agent believed a few hundred milliseconds ago.
- **On final `DB_UNAVAILABLE` failure:** there is nothing to reconcile — the message is exactly the copy in §3, and the agent takes no further tool action this turn. It does not guess at what might have happened.
- **On a real `CONCURRENT_MODIFICATION` exhaustion (rare — contention that doesn't clear in ~350ms):** the agent explicitly re-checks stock (`getStock`) before ending the turn, per the H.1a copy's own wording ("let me recheck stock before I continue"), and if the recheck shows the sale is still possible, it may re-offer to proceed rather than dead-ending the conversation — but it does not automatically re-attempt `finalizeBill` a third round beyond the wrapper's own 2 retries; that next attempt only happens if the owner confirms again.

---

## 6. Telegram-Specific Retry Handling — Duplicate Webhook Delivery

Telegram redelivers an update if your webhook endpoint doesn't acknowledge quickly enough. Every `Message` has a `message_id` that is unique **within a given `chat_id`** — the pair `(chat_id, message_id)` is the natural dedup key. This is a transport-layer concern, separate from and layered underneath `finalizeBill`'s own idempotency key.

```ts
// In-memory/Redis cache, short TTL — this is a session/transport concern,
// not a business record, so it does NOT belong in the Postgres schema.
const processedMessages = new TTLCache<string, CachedAgentResponse>({ ttlMs: 15 * 60 * 1000 });

async function handleTelegramUpdate(update: TelegramUpdate) {
  const key = `${update.message.chat.id}:${update.message.message_id}`;

  const cached = processedMessages.get(key);
  if (cached) {
    // Duplicate delivery of an update we already fully handled.
    // Do NOT re-run the agent reasoning loop and do NOT re-call any tools —
    // simply replay (or silently drop) the response we already sent.
    return replay(cached);
  }

  const response = await runAgentTurn(update);   // full observe→reason→act→respond loop
  processedMessages.set(key, response);
  return response;
}
```

**Why both layers are needed together:** the Telegram-level dedup cache prevents the agent from *reasoning twice* about the same user message. Without it, a redelivered "finalize the bill" message would trigger a second full agent pass, which would generate a **new, different** `idempotencyKey` (since that key is minted fresh per reasoning pass, per §4) — and a second, different idempotency key would *not* be caught by `finalizeBill`'s own dedup check, since that check only catches retries of the *same* key. So: Telegram-level `(chat_id, message_id)` dedup stops duplicate reasoning passes from happening at all; `finalizeBill`'s idempotency key stops duplicate *writes* even if a duplicate reasoning pass somehow slipped through anyway. Neither one alone is sufficient.

---

## 7. LangGraph Integration — Where Retry Lives in the Graph

**Retry logic lives entirely inside the tool-execution node, as local imperative code — it is not modeled as separate graph nodes or edges.**

```
StateGraph:

  [reason] ──(model picks tool + args)──▶ [tool_execution] ──(result)──▶ [reason] ──▶ ... ──▶ [respond]
                                                │
                                          callToolWithRetry(...)
                                          (loops internally: attempt,
                                           backoff, retry, attempt again —
                                           all inside this one node)
```

- The `tool_execution` node calls `callToolWithRetry` and only returns to the graph once a **terminal** outcome exists — success, or a final (possibly retried-and-exhausted) error. The `reason` node that consumes the result never sees "attempt 1 of 3 failed" as a state transition; it only ever sees one clean `Result<T>`.
- **Rationale:** LangGraph's node/edge structure is meant to represent points where the *agent's reasoning* branches — what tool to call next, whether to ask a clarifying question, whether to chain another tool call. Retry-with-backoff is infrastructure, not reasoning; modeling each attempt as its own graph node would (a) pollute the graph with detail the LLM has no business seeing or being asked to react to, and (b) risk the model "narrating" retries to the owner mid-attempt, which violates the calm, predictable UX principle from the original architecture — the owner should only ever see a clean success or one clear, final, human-friendly error.
- **Cancellation integration:** the `CancellationToken` passed into `callToolWithRetry` is backed by an `AbortSignal`-style flag on the current turn's execution context. If a new incoming Telegram message for the *same chat* is a cancellation-like utterance ("cancel", "never mind", "stop") while a `tool_execution` node is mid-retry-wait, a per-chat single-flight controller (keyed on `chat_id`, separate from the message-level dedup cache in §6) sets that flag; the retry wrapper checks it before every backoff sleep and every re-attempt (§2) and exits cleanly rather than continuing to hammer the database or eventually surfacing a stale success.
- **Persistence:** the graph's checkpointed state (per `chat_id` thread, satisfying the "persistent memory across restart and `/new`" requirement) is only written *after* `tool_execution` returns its terminal result — an in-flight retry loop is never itself checkpointed mid-attempt, so a process restart during a retry simply means the *next* incoming message (or a resumed run) starts a fresh `callToolWithRetry` call from attempt 0, which is safe by the same idempotency reasoning as §4 for `finalizeBill`, and by the "owner naturally repeats themselves" reasoning of §0 for everything else.

---

## Summary Table

| Error | Retries | Backoff | Silent or shown? | Applies to |
|---|---|---|---|---|
| `VALIDATION_ERROR` / business-rule / not-found errors | 0 | — | Shown immediately | all tools |
| `CONCURRENT_MODIFICATION` | 2 | 100ms, 250ms | Silent, then shown only if exhausted | all mutating + read-only tools |
| `DB_UNAVAILABLE` (idempotent-key / read-only) | 3 | 500ms, 1s, 2s | Silent, then shown only if exhausted | `finalizeBill`, all read-only tools |
| `DB_UNAVAILABLE` (transaction-safe-only) | 0 | — | Shown immediately | `receiveStock`, `addOrUpdateItem`, `editItem`, `addCredit`, `addSettlement`, `recordAdjustment`, `confirmShortcut` |
