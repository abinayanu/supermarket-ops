/**
 * Supermarket Ops Agent — Deterministic Service Interfaces (contract only)
 *
 * No implementations. This is the boundary the agent's tools call against.
 * Money is represented in integer paise (never floating-point rupees) to
 * avoid rounding drift; convert to/from NUMERIC(10,2) rupees only at the
 * DB read/write boundary inside each service's implementation.
 *
 * None of these five services call an LLM. The agent never computes a
 * price, GST amount, stock count, or khata balance itself — it only calls
 * these functions and relays their output.
 */

// ============================================================================
// Shared primitive types
// ============================================================================

type UUID = string;
type Paise = number;          // integer, >= 0 unless noted
type ISODate = string;        // 'YYYY-MM-DD'
type ISODateTime = string;    // full timestamp, UTC

/** Internal-only error shape. Never shown to the owner verbatim — the agent
 *  layer maps each `code` to the humanized copy defined in the original
 *  architecture's guardrails section and the v2 addendum's H.1a. */
interface ServiceError {
  code:
    | 'PRODUCT_NOT_FOUND'
    | 'INSUFFICIENT_STOCK'
    | 'BELOW_COST'
    | 'BILL_NOT_FOUND'
    | 'BILL_NOT_DRAFT'
    | 'DUPLICATE_FINALIZE'
    | 'CONCURRENT_MODIFICATION'
    | 'CUSTOMER_NOT_FOUND'
    | 'VALIDATION_ERROR'
    | 'DB_UNAVAILABLE'
    | 'UNKNOWN';
  message: string;             // developer-facing detail, not owner-facing
  retryable: boolean;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

// ============================================================================
// 1. PricingService — GST computation and per-line/per-bill money math.
//    Reads: products (mrp, cost_price, gst_rate, hsn_code only).
//    Writes: none. Purely computational beyond the one product read.
// ============================================================================

interface ProductPricing {
  productId: UUID;
  mrp: Paise;
  costPrice: Paise;
  gstRate: number;      // e.g. 5, 12, 18 — percentage
  hsnCode: string;
}

interface LineItemBreakup {
  lineSubtotal: Paise;   // unitPrice * quantity, pre-tax
  gstAmount: Paise;
  cgstAmount: Paise;     // gstAmount / 2 for intra-state
  sgstAmount: Paise;     // gstAmount / 2 for intra-state
  lineTotal: Paise;      // lineSubtotal + gstAmount
}

interface BillBreakup {
  subtotal: Paise;
  cgstTotal: Paise;
  sgstTotal: Paise;
  taxTotal: Paise;
  preRoundingTotal: Paise;
  roundingAdjustment: Paise;   // signed; applies the owner's rounding preference
  total: Paise;
}

interface PricingService {
  /** Fetches a product's current price, cost, and tax facts — the only
   *  DB read in this service. */
  getProductPricing(productId: UUID): Promise<Result<ProductPricing>>;
  // Reads: products

  /** Computes tax breakup for a single line item from an already-snapshotted
   *  unit price, quantity, and GST rate. Pure function, no DB access.
   *  Validation: quantity > 0, unitPriceRupeesPaise >= 0, 0 <= gstRate <= 28. */
  computeLineItem(input: {
    unitPrice: Paise;
    quantity: number;
    gstRate: number;
  }): Result<LineItemBreakup>;
  // Reads/Writes: none

  /** Aggregates a set of line items into a whole-bill CGST/SGST breakup and
   *  applies a rounding rule (from preferences, passed in resolved — this
   *  service does not read the preferences table itself). Pure function.
   *  Validation: at least one line item; all lineSubtotal/gstAmount >= 0. */
  computeBillBreakup(input: {
    lineItems: LineItemBreakup[];
    roundingRule: 'none' | 'nearest_1' | 'nearest_5' | 'nearest_10';
  }): Result<BillBreakup>;
  // Reads/Writes: none
}

// ============================================================================
// 2. StockService — availability checks and all stock mutation.
//    Reads: products (current_stock). Writes: products (current_stock),
//    stock_ledger (append-only insert, same transaction as the write).
// ============================================================================

interface StockAvailability {
  productId: UUID;
  requestedQty: number;
  currentStock: number;
  available: boolean;
  shortfall: number;    // 0 if available
}

interface StockMovement {
  ledgerId: number;
  productId: UUID;
  changeQty: number;     // signed
  resultingStock: number;
}

interface StockService {
  /** Returns current on-hand quantity for a product. */
  getStock(productId: UUID): Promise<Result<{ productId: UUID; currentStock: number }>>;
  // Reads: products

  /** Checks whether the requested quantity can be fulfilled from current
   *  stock, without mutating anything. Used before adding a bill item and
   *  re-used as the H.1a "stale read" recheck before finalize.
   *  Validation: quantity > 0. */
  checkAvailability(productId: UUID, quantity: number): Promise<Result<StockAvailability>>;
  // Reads: products

  /** Increases stock on receiving new inventory; appends a 'receive' row
   *  to stock_ledger and updates products.current_stock atomically.
   *  Validation: quantity > 0; costPrice, if provided, >= 0. */
  receiveStock(input: {
    productId: UUID;
    quantity: number;
    costPrice?: Paise;
    note?: string;
    createdBy: string;
  }): Promise<Result<StockMovement>>;
  // Reads/Writes: products, stock_ledger

  /** Decrements stock for every line item of a bill as part of finalization.
   *  Must run inside the same DB transaction as bills.status update (owned
   *  by BillingService.finalizeBill) under row-level locks per product, so
   *  a concurrent sale of the same product cannot both succeed past the
   *  oversell check. Appends one 'sale' row per line item to stock_ledger.
   *  Validation: every item's quantity <= current locked stock (re-checked
   *  here, not trusted from an earlier read — this is the concurrency
   *  guardrail from the original architecture's Section H). */
  decrementStockForFinalize(input: {
    billId: UUID;
    items: { productId: UUID; quantity: number }[];
  }): Promise<Result<StockMovement[]>>;
  // Reads/Writes: products, stock_ledger

  /** Records a manual correction (never a delete) — e.g. shrinkage, damage,
   *  recount. Appends a 'correction' or 'adjustment' row to stock_ledger.
   *  Validation: deltaQty != 0. */
  recordAdjustment(input: {
    productId: UUID;
    deltaQty: number;
    reason: 'adjustment' | 'correction';
    note: string;
    createdBy: string;
  }): Promise<Result<StockMovement>>;
  // Reads/Writes: products, stock_ledger

  /** Lists products at or below a stock threshold. */
  listLowStock(threshold?: number): Promise<Result<{ productId: UUID; name: string; currentStock: number }[]>>;
  // Reads: products
}

// ============================================================================
// 3. BillingService — multi-turn bill lifecycle, finalize, and daily close.
//    Reads/Writes: bills, bill_items. Also writes daily_close_records on
//    close, and reads khata_transactions for the close summary only.
//    Calls into PricingService and StockService; never touches GST math or
//    stock rows directly itself.
// ============================================================================

interface BillItemView {
  itemId: UUID;
  productId: UUID;
  productName: string;
  quantity: number;
  unitPrice: Paise;
  gstRate: number;
  lineSubtotal: Paise;
  status: 'active' | 'removed';
}

interface BillView {
  billId: UUID;
  status: 'draft' | 'finalized' | 'void';
  customerRef?: string;
  items: BillItemView[];
  breakup?: BillBreakup;   // present once at least one active item exists
}

interface FinalizeResult {
  billId: UUID;
  wasAlreadyFinalized: boolean;  // true if this call was a duplicate (idempotent replay)
  breakup: BillBreakup;
  finalizedAt: ISODateTime;
}

interface DailyCloseSummary {
  closeDate: ISODate;
  totalBills: number;
  totalSales: Paise;
  totalCgst: Paise;
  totalSgst: Paise;
  totalKhataCredit: Paise;
  totalKhataSettled: Paise;
}

interface BillingService {
  /** Opens a new draft bill. */
  startBill(customerRef?: string): Promise<Result<{ billId: UUID }>>;
  // Writes: bills

  /** Adds a new item or increases an existing active item's quantity for
   *  the same product on a draft bill. Runs, in order: stock availability
   *  check (StockService), cost-floor check (unitPrice must be >=
   *  product.costPrice from PricingService), then line-item GST calc
   *  (PricingService). Rejects with INSUFFICIENT_STOCK or BELOW_COST
   *  before writing anything.
   *  Validation: bill must be status='draft'; quantity > 0. */
  addOrUpdateItem(input: {
    billId: UUID;
    productId: UUID;
    quantity: number;
  }): Promise<Result<BillItemView>>;
  // Reads: bills, products (via Pricing/StockService) — Writes: bill_items

  /** Changes quantity or removes (status='removed') an existing draft-bill
   *  item — covers both explicit edits and D.1a edited-Telegram-message
   *  re-evaluation. Never deletes the row.
   *  Validation: bill must be 'draft'; if newQuantity given, must be > 0
   *  (use remove=true to zero out instead of newQuantity=0). */
  editItem(input: {
    billId: UUID;
    itemId: UUID;
    newQuantity?: number;
    remove?: boolean;
  }): Promise<Result<BillItemView>>;
  // Reads: bills, bill_items — Writes: bill_items

  /** Returns the current state of a bill (draft or finalized), including
   *  a fresh breakup computed via PricingService. */
  getBillState(billId: UUID): Promise<Result<BillView>>;
  // Reads: bills, bill_items

  /** Finalizes a bill: re-validates stock/cost under lock, computes the
   *  final breakup, decrements stock (StockService, same transaction),
   *  and writes bills.status/totals/finalized_at/idempotency_key.
   *  Idempotency (H.1b): if idempotencyKey already exists on a bill
   *  finalized within the last 24h, returns that original result with
   *  wasAlreadyFinalized=true and performs no further mutation.
   *  Validation: bill must be 'draft' with at least one active item;
   *  idempotencyKey must be a client-generated UUID. */
  finalizeBill(input: {
    billId: UUID;
    idempotencyKey: UUID;
  }): Promise<Result<FinalizeResult>>;
  // Reads/Writes: bills, bill_items — calls StockService, PricingService

  /** Aggregates and locks a calendar day: sums finalized bills' totals and
   *  that day's khata activity, writes one write-once daily_close_records
   *  row. Validation: closeDate must not already have a close record. */
  closeDay(closeDate: ISODate, closedBy: string): Promise<Result<DailyCloseSummary>>;
  // Reads: bills, khata_transactions — Writes: daily_close_records
}

// ============================================================================
// 4. KhataService — credit/settlement ledger and derived balances.
//    Reads/Writes: khata_transactions only. Balance is always computed by
//    aggregation, never stored — this is the khata invariant from the
//    original architecture.
// ============================================================================

interface KhataBalance {
  customerKey: string;
  customerName: string;   // most recent display form used
  totalCredit: Paise;
  totalSettled: Paise;
  balance: Paise;         // totalCredit - totalSettled
}

interface KhataService {
  /** Records credit given to a customer (append-only insert).
   *  Validation: amount > 0; customerName non-empty. */
  addCredit(input: {
    customerName: string;
    amount: Paise;
    note?: string;
    relatedBillId?: UUID;
    createdBy: string;
  }): Promise<Result<{ transactionId: number }>>;
  // Writes: khata_transactions

  /** Records a payment received against a customer's balance (append-only
   *  insert). Validation: amount > 0; customerName non-empty. Does not
   *  reject if it would put balance below zero (an overpayment is a valid
   *  real-world event) — the agent surfaces it in plain language, it is
   *  not a hard rule violation. */
  addSettlement(input: {
    customerName: string;
    amount: Paise;
    note?: string;
    createdBy: string;
  }): Promise<Result<{ transactionId: number }>>;
  // Writes: khata_transactions

  /** Computes a customer's current balance by summing all credit and
   *  settlement rows for their normalized customer_key. */
  getBalance(customerName: string): Promise<Result<KhataBalance>>;
  // Reads: khata_transactions
}

// ============================================================================
// 5. ShortcutLedgerService — evidence tracking and confirmed shortcuts.
//    Reads/Writes: shortcut_candidates, confirmed_shortcuts ONLY. No
//    function in this service reads or writes products, stock_ledger,
//    bills, bill_items, or khata_transactions — this is the structural
//    guarantee that it can never influence price, GST, stock, or khata math.
//    It can only ever resolve WHICH already-grounded option an ambiguous
//    phrase refers to.
// ============================================================================

interface ProposalDecision {
  patternKey: string;
  qualifies: boolean;
  reason: 'threshold_met' | 'not_enough_occurrences' | 'not_enough_distinct_days' | 'has_conflict';
  candidateId?: UUID;      // present if qualifies=true
  resolvedValue?: string;
}

interface ShortcutLedgerConfig {
  minOccurrences: number;   // default 3, per A.1a
  minDistinctDays: number;  // default 2, per A.1a
}

interface ShortcutLedgerService {
  /** Records one observed ambiguity resolution (e.g. owner picked a
   *  specific product for a vague phrase). Upserts the matching
   *  shortcut_candidates row: increments occurrence_count, appends today's
   *  date to occurrence_dates if not already present, and sets
   *  has_conflict=true if a *different* resolved_value has been seen for
   *  the same patternKey. Validation: patternKey and resolvedValue non-empty.
   */
  recordAmbiguityResolution(input: {
    patternKey: string;
    resolvedValue: string;
    occurredOn: ISODate;
  }): Promise<Result<{ candidateId: UUID }>>;
  // Reads/Writes: shortcut_candidates

  /** Evaluates a pattern against the configured threshold (A.1a: >= 3
   *  occurrences, >= 2 distinct days, no conflict). Called by the agent
   *  before deciding whether to surface a proposal message. Does not
   *  mutate state by itself. */
  evaluateForProposal(
    patternKey: string,
    config?: ShortcutLedgerConfig
  ): Promise<Result<ProposalDecision>>;
  // Reads: shortcut_candidates

  /** Records the owner's yes/no on a proposed shortcut. On accept, writes
   *  a confirmed_shortcuts row (and marks the candidate 'confirmed'); any
   *  prior active confirmed shortcut for the same patternKey is revoked
   *  first, since only one may be active at a time. On decline, marks the
   *  candidate 'rejected' — it does not retry proposing the same pattern
   *  automatically. */
  confirmShortcut(input: {
    candidateId: UUID;
    accept: boolean;
    decidedBy: string;
  }): Promise<Result<{ shortcutId?: UUID; status: 'confirmed' | 'rejected' }>>;
  // Reads/Writes: shortcut_candidates, confirmed_shortcuts

  /** Returns the currently active (non-revoked) confirmed shortcut for a
   *  pattern, if any — used to inject a hint into agent context before
   *  reasoning. Read-only; the agent still resolves the final product via
   *  a normal grounded lookup, this only removes the need to ask. */
  getActiveShortcut(patternKey: string): Promise<Result<{ resolvedValue: string } | null>>;
  // Reads: confirmed_shortcuts

  /** Owner-initiated undo, at any time. Sets revoked_at; never deletes. */
  revokeShortcut(shortcutId: UUID, revokedBy: string): Promise<Result<{ revoked: true }>>;
  // Writes: confirmed_shortcuts
}
