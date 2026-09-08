# Supermarket Ops Agent — Transaction & Locking Strategy

*(Implementation contract for Day 3. Builds directly on `schema.sql` and `service-interfaces.ts`. No new tables, services, or tools — this only specifies transaction boundaries, lock acquisition, and isolation levels for the mutating functions already defined.)*

---

## One correction to flag before the strategy

The request asks for `SELECT ... FOR UPDATE` on **stock_ledger** rows. That table is append-only (see `schema.sql` comments) — it has no mutable balance to lock, so locking a `stock_ledger` row would not actually serialize anything. The row that must be locked is **`products.id`**, since `products.current_stock` is the transactionally-maintained running balance that both the oversell check and the decrement race against. Every strategy below locks `products`, and `stock_ledger` only ever receives an append inside the same transaction, after the lock is held.

---

## 1. Stock Mutations

### 1.1 `receiveStock` (owner sends new inventory)

```sql
BEGIN; -- isolation: READ COMMITTED (default)

SELECT current_stock FROM products WHERE id = :product_id FOR UPDATE;
-- lock the single product row before read-modify-write

UPDATE products
   SET current_stock = current_stock + :quantity,
       cost_price = COALESCE(:cost_price, cost_price),
       updated_at = now()
 WHERE id = :product_id
 RETURNING current_stock;
-- resulting_stock for the ledger row = the value just returned

INSERT INTO stock_ledger (product_id, change_qty, reason, reference_type, resulting_stock, created_by)
VALUES (:product_id, :quantity, 'receive', 'manual', :new_current_stock, :created_by);

COMMIT;
```

- **Lock order:** single row, single table — no ordering concern.
- **Isolation:** READ COMMITTED. The `FOR UPDATE` row lock is the only protection needed; two concurrent `receiveStock` calls on the same product simply queue behind each other and both apply correctly.
- **Error handling:** any failure before COMMIT → ROLLBACK, nothing partially applied. `receiveStock` never fails on business grounds (there's no "too much stock" rule), only on `DB_UNAVAILABLE`-class errors, which map to the H.1a "can't reach the shop's records" message.

### 1.2 `decrementStockForFinalize` (called inside `finalizeBill`, not standalone)

Locking strategy is identical in shape to 1.1, but for **multiple products in one transaction**, which is where deadlock avoidance matters. Full detail is in §3.3 (`finalizeBill`), since this function only ever runs as one step inside that larger transaction — it does not open its own transaction.

### 1.3 Concurrent `finalize_bill` calls on overlapping items

Two bills, Bill A (Maggi, Sugar) and Bill B (Sugar, Rice), finalize at the same moment. Both need to lock the `products` row for Sugar.

- Both transactions lock their **own** `bills` row first (different rows, no contention there).
- Both then lock their product rows **in ascending `product_id` order**, not in the order items appear on the bill.
- Whichever transaction acquires the Sugar row first proceeds; the other blocks on that single row until the first commits or rolls back, then proceeds normally. Because both transactions request shared resources in the *same* global order, neither can hold what the other needs while waiting for what the other holds — the classic lock-ordering deadlock-avoidance rule.

```sql
-- inside each finalize transaction, after locking the bill row:
SELECT id, current_stock FROM products
 WHERE id = ANY(:product_ids)
 ORDER BY id ASC   -- deterministic global order, same in every transaction
 FOR UPDATE;
```

### 1.4 Deadlock prevention, multiple bills finalizing simultaneously

Two rules, applied consistently everywhere in this document:
1. **Always lock `bills` before `products`** (never the reverse, never interleaved).
2. **Always lock `products` rows in ascending `id` order** when a transaction needs more than one.

As long as every code path obeys both rules, Postgres cannot deadlock on these tables — a deadlock requires a cycle in the wait-for graph, and a single global lock order makes a cycle impossible. If a deadlock is ever detected anyway (e.g. a future bug violates the order), Postgres aborts one transaction automatically (`40P01`); treat that as `CONCURRENT_MODIFICATION`, retry the whole transaction once, and only surface the H.1a error if the retry also fails.

### 1.5 Isolation level recommendation

**READ COMMITTED**, with explicit `FOR UPDATE` locks on the specific contended rows (`bills`, `products`). Not SERIALIZABLE.

Reasoning: SERIALIZABLE in Postgres detects conflicts via predicate locking and aborts transactions after the fact, requiring retry logic around *every* mutating call, for a benefit we don't need — we already know exactly which rows are contended (`bills.id`, `products.id`) and can lock them explicitly and cheaply. Pessimistic row locking is more predictable, easier to reason about for a 5-day build, and avoids surprise serialization failures on unrelated concurrent operations that never touch the same rows.

---

## 2. Khata Mutations

### 2.1 `addCredit` / `addSettlement`

```sql
BEGIN; -- READ COMMITTED
INSERT INTO khata_transactions (customer_name, customer_key, transaction_type, amount, related_bill_id, note, created_by)
VALUES (:customer_name, :customer_key, 'credit', :amount, :related_bill_id, :note, :created_by);
COMMIT;
```

- **No lock needed, and no lost-write risk.** Balance is derived (`SUM(credit) − SUM(settlement)`), never stored as a mutable field, so there is no read-modify-write step to protect. Two concurrent credits for the same customer are two independent `INSERT`s; both always succeed and both are always counted correctly by the next balance read, regardless of ordering.
- **Advisory locks are not needed for the current scope.** They would only become relevant if a future rule needed to atomically check-then-decide against a customer's balance before writing (e.g. a credit limit) — that is not an official requirement, so it is intentionally not added here.

### 2.2 `getBalance`

```sql
SELECT customer_name,
       SUM(amount) FILTER (WHERE transaction_type = 'credit')     AS total_credit,
       SUM(amount) FILTER (WHERE transaction_type = 'settlement') AS total_settled
  FROM khata_transactions
 WHERE customer_key = :customer_key
 GROUP BY customer_name
 ORDER BY MAX(created_at) DESC
 LIMIT 1;
```

- Plain read, no explicit transaction or lock required. READ COMMITTED gives a consistent-enough snapshot for a balance query; sub-millisecond staleness against an in-flight concurrent insert is acceptable for this use case and is not a correctness violation of the khata invariant (the invariant is "balance is always derived," which this query satisfies regardless of timing).

---

## 3. Billing Mutations

### 3.1 `startBill`

```sql
INSERT INTO bills (customer_ref, status) VALUES (:customer_ref, 'draft') RETURNING id;
```

Insert-only, no lock, no explicit transaction block needed beyond the statement's own implicit one.

### 3.2 `addOrUpdateItem` / `editItem`

```sql
BEGIN; -- READ COMMITTED
SELECT status FROM bills WHERE id = :bill_id FOR UPDATE;
-- must be 'draft', else roll back with BILL_NOT_DRAFT

SELECT current_stock, cost_price FROM products WHERE id = :product_id;
-- plain SELECT, no FOR SHARE — see reasoning below

-- application-layer checks: requested quantity <= current_stock, unit_price >= cost_price
-- if either fails: ROLLBACK, return INSUFFICIENT_STOCK / BELOW_COST

INSERT INTO bill_items (...) / UPDATE bill_items SET quantity = ... , updated_at = now();
COMMIT;
```

**Does `add_bill_item` need `FOR SHARE` on `products`? No.** This check is deliberately a *soft, best-effort* check, not the security boundary — the original architecture is explicit that "stock decremented only on finalization," which means the authoritative, hard-enforced check happens later, under a real `FOR UPDATE` lock, inside `finalizeBill` (§3.3). Taking `FOR SHARE` here would hold a lock across the entire multi-turn conversation while a bill is being built (potentially minutes, across several Telegram messages), which would block `receiveStock` and other bills' `finalizeBill` calls on that product for no real safety benefit. A plain, unlocked `SELECT` gives the owner fast, good-enough feedback ("only 6 left") during build-up; the real gate is at finalize.

**Locking `bills` `FOR UPDATE` here matters for a different reason:** it's what makes concurrent `editItem` calls and an in-flight `finalizeBill` on the *same bill* mutually exclusive (see §3.3, step a) — not stock safety, but bill-state safety, so an edit can't land after finalize has already locked the bill.

### 3.3 `finalizeBill` — the critical section, step by step

```sql
BEGIN; -- READ COMMITTED

-- (a) Acquire lock on the bill row first, always before any product lock.
SELECT status, idempotency_key, finalized_at
  FROM bills
 WHERE id = :bill_id
 FOR UPDATE;

-- (b) Idempotency re-check, using the row just locked.
--     Because we hold FOR UPDATE, no other transaction can be mid-finalize
--     on this same bill concurrently — this check is race-free.
IF bills.status = 'finalized' THEN
    IF bills.idempotency_key = :idempotency_key
       AND bills.finalized_at > now() - interval '24 hours' THEN
        -- duplicate/retry of the same attempt: return the already-committed
        -- result, mutate nothing further.
        ROLLBACK;  -- read-only path, nothing to commit
        RETURN cached_result(bills.*);
    ELSE
        ROLLBACK;
        RETURN error('BILL_NOT_DRAFT');
        -- already finalized under a different attempt / stale client state
    END IF;
END IF;
IF bills.status != 'draft' THEN
    ROLLBACK;
    RETURN error('BILL_NOT_DRAFT'); -- e.g. status = 'void'
END IF;

-- (c) For each active line item: lock the product rows, in ascending
--     product_id order (deadlock avoidance, see §1.4), then verify.
SELECT id, current_stock, cost_price
  FROM products
 WHERE id = ANY(:distinct_product_ids)
 ORDER BY id ASC
 FOR UPDATE;

-- application-layer, per item, using the just-locked, fresh values:
--   IF quantity > current_stock          → INSUFFICIENT_STOCK
--   IF snapshotted_unit_price < cost_price → BELOW_COST (re-check; cost
--     may have changed since the item was added to the draft bill)

-- (d) If every item passes: write the stock movement and the bill.
--     Still inside the same transaction as (a)-(c) — one atomic unit.
UPDATE products
   SET current_stock = current_stock - :item_quantity, updated_at = now()
 WHERE id = :item_product_id
 RETURNING current_stock;   -- becomes resulting_stock below

INSERT INTO stock_ledger (product_id, change_qty, reason, reference_type, reference_id, resulting_stock, created_by)
VALUES (:item_product_id, -:item_quantity, 'sale', 'bill', :bill_id, :new_current_stock, 'agent');
-- repeated for each active line item

UPDATE bills
   SET status = 'finalized',
       subtotal = :subtotal,
       cgst_amount = :cgst_total,
       sgst_amount = :sgst_total,
       rounding_adjustment = :rounding_adjustment,
       total_amount = :total,
       idempotency_key = :idempotency_key,
       finalized_at = now()
 WHERE id = :bill_id;

-- (e) Commit — releases the bills lock and every products lock together.
COMMIT;
```

- **What rolls back vs. what fails gracefully:** any check failure in step (c) — `INSUFFICIENT_STOCK` or `BELOW_COST` on *any single item* — rolls back the **entire** transaction. Nothing is partially finalized; the bill remains `draft` exactly as it was, and the owner sees one H.1a-style message ("Only 6 Maggi packets are left. I can't bill 10.") for the item that failed. The owner can then edit that one item and retry finalize; already-valid items are not silently dropped, they're simply still sitting on the untouched draft bill.
- **`DB_UNAVAILABLE`-class failures** (connection drop mid-transaction) also roll back automatically at the connection level; the retry (same `idempotency_key`) is safe per (b) once the DB is reachable again.
- **Isolation:** READ COMMITTED, for the same reasoning as §1.5 — the `FOR UPDATE` locks on `bills` and `products` are the actual correctness mechanism, not the isolation level.

---

## 4. Shortcut Ledger Mutations

These are read-mostly, and — by design — never touch `products`, `stock_ledger`, `bills`, `bill_items`, or `khata_transactions`, so they can never block or be blocked by any of the financial paths above.

### 4.1 `recordAmbiguityResolution`

```sql
INSERT INTO shortcut_candidates (pattern_key, resolved_value, occurrence_count, occurrence_dates, first_seen_at, last_seen_at)
VALUES (:pattern_key, :resolved_value, 1, jsonb_build_array(:today), now(), now())
ON CONFLICT (pattern_key, resolved_value) DO UPDATE
   SET occurrence_count = shortcut_candidates.occurrence_count + 1,
       occurrence_dates = CASE
           WHEN shortcut_candidates.occurrence_dates @> to_jsonb(:today::text)
           THEN shortcut_candidates.occurrence_dates
           ELSE shortcut_candidates.occurrence_dates || to_jsonb(:today::text)
       END,
       last_seen_at = now();

-- separately, mark conflicting resolutions for the same pattern_key
-- (a different resolved_value seen for the same pattern disqualifies both):
UPDATE shortcut_candidates
   SET has_conflict = true
 WHERE pattern_key = :pattern_key
   AND resolved_value <> :resolved_value;
```

- **No explicit lock needed.** `INSERT ... ON CONFLICT DO UPDATE` is atomic per row in Postgres — the row lock is acquired and released automatically as part of the single statement, which is sufficient here since there's no multi-statement read-modify-write to protect beyond what the `ON CONFLICT` clause already does.

### 4.2 Preventing duplicate proposals for the same pattern

Rely on an atomic conditional `UPDATE`, not an explicit lock:

```sql
UPDATE shortcut_candidates
   SET status = 'proposed'
 WHERE id = :candidate_id
   AND status = 'tracking'   -- guard: only transitions once
 RETURNING id;
```

If two near-simultaneous evaluations both try to propose the same pattern, Postgres serializes the two `UPDATE`s on that row automatically; whichever commits first flips `status` to `'proposed'`, and the second `UPDATE`'s `WHERE status = 'tracking'` clause then matches zero rows (it re-evaluates the row after the first commits) — so it returns nothing, and the caller treats "0 rows updated" as "someone already proposed this, don't ask again." No explicit `FOR UPDATE` or advisory lock required; this is the standard "optimistic conditional update" pattern.

### 4.3 `confirmShortcut`

```sql
BEGIN;
UPDATE confirmed_shortcuts
   SET revoked_at = now()
 WHERE pattern_key = :pattern_key AND revoked_at IS NULL;
-- retire any prior active shortcut for this pattern (normally 0 or 1 row)

INSERT INTO confirmed_shortcuts (pattern_key, resolved_value, candidate_id, confirmed_by, confirmed_at)
VALUES (:pattern_key, :resolved_value, :candidate_id, :decided_by, now());

UPDATE shortcut_candidates SET status = 'confirmed' WHERE id = :candidate_id;
COMMIT;
```

- The partial unique index `uq_confirmed_shortcuts_active_pattern` (from `schema.sql`) is the actual safety net against two concurrent confirmations racing to create two simultaneously-active shortcuts for the same pattern: if that ever happened, the second `INSERT` would fail with a `unique_violation`. On that error, `ROLLBACK` and re-fetch the current active shortcut rather than retry blindly — this should be an exceptionally rare race (it requires two separate "yes" confirmations for the same proposal within the same instant) and is safe to surface as a generic H.1a-style retry message if it ever occurs.

---

## 5. Daily Close (`closeDay`)

**Should be idempotent: yes.** Calling it twice for the same date must return the same summary, not recompute or double-count.

```sql
BEGIN; -- SERIALIZABLE, for this operation only

SELECT pg_advisory_xact_lock(hashtext('daily_close:' || :close_date));
-- serializes any concurrent close_day calls for the SAME date;
-- calls for different dates never contend with each other

SELECT * FROM daily_close_records WHERE close_date = :close_date;
IF found THEN
    COMMIT;  -- read-only path
    RETURN existing_row;  -- idempotent replay, no recompute
END IF;

-- compute aggregates for the date, inside the same SERIALIZABLE transaction
-- so the bills sum and the khata sum see one consistent snapshot:
SELECT COUNT(*), SUM(total_amount), SUM(cgst_amount), SUM(sgst_amount)
  FROM bills
 WHERE status = 'finalized' AND finalized_at::date = :close_date;

SELECT SUM(amount) FILTER (WHERE transaction_type = 'credit'),
       SUM(amount) FILTER (WHERE transaction_type = 'settlement')
  FROM khata_transactions
 WHERE created_at::date = :close_date;

INSERT INTO daily_close_records (close_date, total_bills, total_sales, total_cgst, total_sgst, total_khata_credit, total_khata_settled, closed_by)
VALUES (:close_date, :total_bills, :total_sales, :total_cgst, :total_sgst, :total_khata_credit, :total_khata_settled, :closed_by);

COMMIT;
```

- **Why SERIALIZABLE here, and only here:** `closeDay` runs once per day per shop — the overhead of Postgres's serializable snapshot machinery is irrelevant at that frequency, and it protects against a subtle read-skew case where the bills aggregate and the khata aggregate are read at slightly different points relative to a bill that finalizes mid-close. Everywhere else in this document, explicit row locks are cheaper and sufficient; here, the transaction touches many rows across two tables with no single row to lock, so SERIALIZABLE is the simpler correct choice.
- **Concurrent-close prevention:** the `pg_advisory_xact_lock` on a key derived from `close_date` means a second `closeDay(sameDate)` call — however it arrives, retried Telegram delivery, owner sending "close the day" twice — simply waits for the first to finish, then hits the "already exists, return it" branch instead of racing to insert a second row. The `UNIQUE(close_date)` constraint on `daily_close_records` is the backstop if the advisory lock is ever bypassed by a bug: the second `INSERT` would fail with `unique_violation`, which should be caught and treated the same as "already closed, return the existing record."

---

## Summary Table

| Operation | Lock target(s) | Order | Isolation | Idempotent? |
|---|---|---|---|---|
| `receiveStock` | `products` row | n/a (single row) | READ COMMITTED | No (each call is a real new receipt) |
| `addOrUpdateItem` / `editItem` | `bills` row (`FOR UPDATE`) | n/a | READ COMMITTED | N/a (mid-build state) |
| `finalizeBill` | `bills` row, then `products` rows (ascending id) | bills → products, products sorted | READ COMMITTED | Yes, via `idempotency_key` |
| `addCredit` / `addSettlement` | none | n/a | READ COMMITTED | No (each is a real event); safe under concurrency by construction |
| `recordAmbiguityResolution` | none (atomic upsert) | n/a | READ COMMITTED | N/a (accumulator) |
| `confirmShortcut` | none (unique index as backstop) | n/a | READ COMMITTED | N/a (explicit owner action) |
| `closeDay` | advisory lock on `close_date` | n/a | SERIALIZABLE | Yes, by construction |
