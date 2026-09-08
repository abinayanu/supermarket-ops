-- ============================================================================
-- Supermarket Ops Agent — PostgreSQL Schema (contract only, no app logic)
-- Source of truth: original solution architecture + v2 addendum.
-- No tables beyond what those documents already scope.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy/typo-tolerant product name lookup

-- ============================================================================
-- products
-- MUTABLE. current_stock is a transactionally-maintained running balance
-- (updated only inside the same transaction as a stock_ledger insert, under
-- row lock). stock_ledger is the append-only audit trail; products.current_stock
-- is a fast-read cache derived from it, never the sole source of truth.
-- Products are never hard-deleted (is_active is used to retire a SKU).
-- ============================================================================
CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    unit            TEXT NOT NULL,                      -- 'packet','kg','box','litre', etc.
    mrp             NUMERIC(10,2) NOT NULL CHECK (mrp >= 0),
    cost_price      NUMERIC(10,2) NOT NULL CHECK (cost_price >= 0),
    gst_rate        NUMERIC(4,2) NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 28),
    hsn_code        TEXT NOT NULL,
    current_stock   NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    is_active       BOOLEAN NOT NULL DEFAULT true,       -- soft retirement, never delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grounded, typo-tolerant lookup (used by find_product).
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_active ON products (is_active) WHERE is_active = true;

-- ============================================================================
-- stock_ledger
-- APPEND-ONLY. Every stock movement (receive, sale-on-finalize, correction)
-- is a new row; rows are never updated or deleted. Corrections to a past
-- mistake are new offsetting rows referencing the original, per the
-- "no stock deletion" hard rule. resulting_stock is a point-in-time snapshot
-- for audit/debugging, computed at insert time inside the same transaction
-- that updates products.current_stock.
-- ============================================================================
CREATE TABLE stock_ledger (
    id              BIGSERIAL PRIMARY KEY,
    product_id      UUID NOT NULL REFERENCES products(id),
    change_qty      NUMERIC(12,3) NOT NULL,              -- positive=in, negative=out; never 0
    reason          TEXT NOT NULL CHECK (reason IN ('receive','sale','adjustment','correction')),
    reference_type  TEXT,                                 -- 'bill','manual','correction', nullable
    reference_id    UUID,                                 -- e.g. bill_id when reason='sale'
    resulting_stock NUMERIC(12,3) NOT NULL,
    created_by      TEXT NOT NULL,                         -- 'agent' | 'owner' | 'system'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (change_qty <> 0)
);

CREATE INDEX idx_stock_ledger_product_time ON stock_ledger (product_id, created_at DESC);
CREATE INDEX idx_stock_ledger_reference ON stock_ledger (reference_type, reference_id);

-- ============================================================================
-- bills
-- MUTABLE while status='draft' (multi-turn build/edit). Effectively frozen
-- once status='finalized' or 'void' — the app layer must not mutate totals
-- or items after finalization; only new offsetting records (e.g. a fresh
-- bill) represent later corrections. idempotency_key implements the H.1b
-- retry-safe finalize contract: one key per finalize *attempt*, unique,
-- reused automatically on retry of the same attempt.
-- ============================================================================
CREATE TABLE bills (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_ref        TEXT,                             -- khata customer_key, null = cash sale
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','finalized','void')),
    idempotency_key     UUID,                              -- set at finalize attempt, not at draft creation
    subtotal            NUMERIC(10,2),
    cgst_amount         NUMERIC(10,2),
    sgst_amount         NUMERIC(10,2),
    rounding_adjustment NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(10,2),
    payment_mode        TEXT CHECK (payment_mode IN ('cash', 'upi', 'card', 'mixed')),
    upi_reference       TEXT,
    telegram_chat_id    BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at        TIMESTAMPTZ,
    voided_at           TIMESTAMPTZ,
    CHECK (status != 'finalized' OR finalized_at IS NOT NULL),
    CHECK (status != 'finalized' OR idempotency_key IS NOT NULL)
);

-- Idempotency contract (H.1b): a given key can only ever belong to one bill.
CREATE UNIQUE INDEX uq_bills_idempotency_key ON bills (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_bills_status ON bills (status);
CREATE INDEX idx_bills_customer_ref ON bills (customer_ref) WHERE customer_ref IS NOT NULL;
CREATE INDEX idx_bills_finalized_at ON bills (finalized_at) WHERE finalized_at IS NOT NULL;

-- ============================================================================
-- bill_items
-- MUTABLE while the parent bill is 'draft' (quantity edits, removals via
-- status='removed' — never a row delete, so an edit history is always
-- reconstructable). Frozen once the parent bill is finalized. unit_price
-- and gst_rate are snapshotted at add-time so a later product price change
-- cannot silently alter an already-built or already-finalized bill.
-- ============================================================================
CREATE TABLE bill_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id         UUID NOT NULL REFERENCES bills(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    quantity        NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
    unit_price      NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),  -- snapshot
    gst_rate        NUMERIC(4,2) NOT NULL,                            -- snapshot
    line_subtotal   NUMERIC(10,2) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_items_bill ON bill_items (bill_id) WHERE status = 'active';
CREATE INDEX idx_bill_items_product ON bill_items (product_id);

-- ============================================================================
-- khata_transactions
-- APPEND-ONLY ledger. Combines customer identity (customer_name/customer_key)
-- with individual credit/settlement entries — there is no separate customers
-- table, per the original data model. A customer's balance is ALWAYS derived
-- by summing this table (credits - settlements) for a customer_key; it is
-- never stored or edited as a standalone field, which is the khata invariant
-- from the original architecture's hard-guardrails section.
-- ============================================================================
CREATE TABLE khata_transactions (
    id              BIGSERIAL PRIMARY KEY,
    customer_name   TEXT NOT NULL,                        -- as typed by the owner, display form
    customer_key    TEXT NOT NULL,                         -- normalized (lowercased/trimmed) identity
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('credit','settlement')),
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    related_bill_id UUID REFERENCES bills(id),              -- nullable; set when credit originates from a sale
    note            TEXT,
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_khata_customer_key_time ON khata_transactions (customer_key, created_at);

-- ============================================================================
-- daily_close_records
-- WRITE-ONCE. A close record is never edited or deleted after creation —
-- it is a locked snapshot of a completed day. A mistaken close is corrected
-- by a new explicit adjustment/entry elsewhere, never by rewriting history.
-- ============================================================================
CREATE TABLE daily_close_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    close_date          DATE NOT NULL,
    total_bills         INTEGER NOT NULL CHECK (total_bills >= 0),
    total_sales         NUMERIC(12,2) NOT NULL,
    total_cgst          NUMERIC(12,2) NOT NULL,
    total_sgst          NUMERIC(12,2) NOT NULL,
    total_khata_credit  NUMERIC(12,2) NOT NULL,
    total_khata_settled NUMERIC(12,2) NOT NULL,
    closed_by           TEXT NOT NULL,
    closed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_daily_close_date ON daily_close_records (close_date);

-- ============================================================================
-- preferences
-- MUTABLE, owner-set only (never inferred — see shortcut_candidates /
-- confirmed_shortcuts below for the inferred, separately-scoped mechanism).
-- Small key-value table; latest value wins, no history table (out of scope).
-- ============================================================================
CREATE TABLE preferences (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- shortcut_candidates
-- MUTABLE working table for the Shortcut Ledger's evidence-gathering phase
-- (A.1a). Tracks repeated ambiguity resolutions until they either qualify
-- for proposal (>=3 occurrences, >=2 distinct days, no conflicting
-- resolution) or are disqualified by a conflict. Read/written only by the
-- Shortcut Ledger service — never by pricing, stock, billing, or khata
-- services, and never a source of price/GST/stock truth.
-- ============================================================================
CREATE TABLE shortcut_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_key         TEXT NOT NULL,                    -- e.g. 'product_disambiguation:atta'
    resolved_value      TEXT NOT NULL,                    -- e.g. a product_id, as text
    occurrence_count    INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
    occurrence_dates    JSONB NOT NULL DEFAULT '[]'::jsonb, -- array of ISO dates, used for distinct-day + spread check
    has_conflict        BOOLEAN NOT NULL DEFAULT false,    -- true disqualifies this pattern from proposal
    status              TEXT NOT NULL DEFAULT 'tracking'
                            CHECK (status IN ('tracking','proposed','confirmed','rejected','expired')),
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One evidence row per (pattern, specific resolution) combination.
CREATE UNIQUE INDEX uq_shortcut_candidates_pattern_value
    ON shortcut_candidates (pattern_key, resolved_value);
CREATE INDEX idx_shortcut_candidates_pattern ON shortcut_candidates (pattern_key);

-- ============================================================================
-- confirmed_shortcuts
-- MUTABLE only via revoke (revoked_at set, row never deleted, preserving
-- history of what was once trusted). Read-only, advisory input appended to
-- agent context before reasoning. Structurally has no foreign key or code
-- path into products, stock_ledger, bills, bill_items, or khata_transactions
-- pricing/quantity/tax logic — it can only ever help the agent resolve
-- WHICH already-grounded product/customer a vague phrase refers to.
-- ============================================================================
CREATE TABLE confirmed_shortcuts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_key     TEXT NOT NULL,
    resolved_value  TEXT NOT NULL,
    candidate_id    UUID NOT NULL REFERENCES shortcut_candidates(id),  -- evidence trail
    confirmed_by    TEXT NOT NULL,
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

-- Only one *active* (non-revoked) confirmed shortcut per pattern at a time.
CREATE UNIQUE INDEX uq_confirmed_shortcuts_active_pattern
    ON confirmed_shortcuts (pattern_key)
    WHERE revoked_at IS NULL;
