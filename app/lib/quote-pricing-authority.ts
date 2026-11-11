// 2026-10-19 owner decision E — PROVISIONAL quotes (true cost, no approved
// selling-price authority).
//
// The Cost & Pricing Calculator may SAVE such a job as a DRAFT so the true
// cost is not lost. It records `pricingAuthority: { approved: false, ... }`
// in the item's priceSnapshot with NO customer price (customerUnitPrice /
// customerTotalPrice null) — the generic/unsourced reference price is kept
// only as a diagnostic inside the snapshot, never as the customer price.
//
// A provisional quote may NOT be sent, marked approved / won, turned into a
// Shopify order or invoice, or moved into production. These checks run on the
// SERVER at every one of those transitions — a disabled button is not the
// guard. Quotes without the field (all historical quotes) are unaffected.
//
// 2026-10-19 owner decisions round 2:
//  - OWNER SET PRICE & APPROVE turns ONE provisional quote item into an
//    owner-approved price (kind "owner_quote_price") with approver, time,
//    reason, exact price and a fingerprint of every commercial field. Any later
//    change to those fields resets the item to PROVISIONAL (editor save AND a
//    re-check at every gate, so no other write path can keep a stale approval).
//  - The exact server-resolved Stock Bag storefront price is an approved
//    commercial authority: it is exempt from the generic margin floor ONLY
//    while the item still carries exactly that price and quantity.
//
// Pure + client-safe: no Prisma, no server imports.

import { PROVISIONAL_PRICING_STATUS } from "./calculator-owner-view";

export { PROVISIONAL_PRICING_STATUS };

export const OWNER_QUOTE_PRICE_KIND = "owner_quote_price";
export const OWNER_APPROVED_PRICING_STATUS = "OWNER APPROVED QUOTE PRICE";
export const STOREFRONT_STOCK_BAG_KIND = "storefront_stock_bag";
export const STOREFRONT_BELOW_TARGET_WARNING = "Approved storefront price is below the standard margin target.";

export type OwnerApprovalRecord = {
  approvedBy: string;
  approvedAt: string;
  reason: string;
  approvedUnitPrice: number;
  approvedTotalPrice: number;
  quantity: number;
  /** True cost is preserved independently of the approved price. */
  trueUnitCost: number;
  trueTotalCost: number;
  expectedProfit: number;
  expectedMarginPct: number | null;
  /** Per-group fingerprints of every commercial field at approval time. */
  fingerprint: Record<string, string>;
  /** The provisional record this approval replaced (restored on reset). */
  provisionalBasis: { kind: string; missing: string | null };
  /**
   * 2026-10-19 owner decision: the same owner approval also serves as the
   * low-margin approval for THIS line when the approved price is below the
   * customer-tier margin target. Bound to the same fingerprint — it resets
   * with the price approval. Never changes a floor, ladder or other quote.
   */
  lowMarginOverride?: { applied: boolean; thresholdPct: number; marginPct: number | null; note: string | null };
  /** The owner supplied the internal unit cost (Manual / Custom line with no authoritative cost). */
  internalCostSuppliedByOwner?: boolean;
};

export type PricingAuthorityHistoryEntry = {
  event: "owner_approved" | "owner_approval_reset";
  at: string;
  by: string;
  reason?: string;
  changed?: string[];
  approvedUnitPrice?: number;
  approvedTotalPrice?: number;
};

export type PricingAuthorityRecord = {
  approved: boolean;
  status: string;
  kind: string;
  source: string | null;
  missing: string | null;
  /** Provisional: there is NO customer price (never $0). */
  customerUnitPrice?: number | null;
  customerTotalPrice?: number | null;
  /** Approved: the exact price the authority produced for this quantity. */
  approvedUnitPrice?: number | null;
  approvedTotalPrice?: number | null;
  approvedQuantity?: number | null;
  /** Approved storefront price below the generic target (warning, never a block). */
  marginWarning?: string | null;
  /** Generic/unsourced reference price — diagnostic only, never the customer price. */
  diagnosticReference?: { unitPrice: number | null; totalPrice: number | null; basis: string | null } | null;
  ownerApproval?: OwnerApprovalRecord | null;
  approvalReset?: { at: string; by: string; changed: string[]; previousApproval: OwnerApprovalRecord } | null;
  history?: PricingAuthorityHistoryEntry[];
};

/** Statuses a provisional quote may hold: still a draft, or closed out. */
export const PROVISIONAL_ALLOWED_QUOTE_STATUSES = ["draft", "lost", "canceled", "expired"] as const;

function parseSnapshot(raw: unknown): any {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** The recorded authority for one quote item, or null when none was recorded (historical / manual items). */
export function itemPricingAuthority(item: { priceSnapshot?: unknown } | null | undefined): PricingAuthorityRecord | null {
  const record = parseSnapshot(item?.priceSnapshot)?.pricingAuthority;
  return record && typeof record === "object" && typeof record.approved === "boolean" ? (record as PricingAuthorityRecord) : null;
}

/* ------------------------------------------------------------------ *
 * Commercial fingerprint — what an owner approval is bound to.
 * ------------------------------------------------------------------ */

type QuoteContext = { customerTier?: string | null; customerTierLabel?: string | null } | null | undefined;

export type CommercialItem = {
  productName?: unknown;
  variant?: unknown;
  sku?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  unitCost?: unknown;
  recipeId?: unknown;
  selectedFinish?: unknown;
  selectedAddOnIds?: unknown;
  pricingSource?: unknown;
  tierLabel?: unknown;
  minQuantity?: unknown;
  costSnapshot?: unknown;
  priceSnapshot?: unknown;
};

/** Human names of the fingerprint groups (used in reset messages). */
export const COMMERCIAL_FIELD_GROUPS: Readonly<Record<string, string>> = {
  product: "product / family",
  quantity: "quantity",
  price: "customer price",
  cost: "true cost",
  options: "finish / add-on options",
  configuration: "configuration (material, finish, sides, dimensions, jar / profile, DTP size)",
  discount: "customer tier / discount",
};

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return JSON.stringify(value);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const text = (value: unknown) => String(value ?? "").trim();
const amount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10000) / 10000 : 0;
};
const idList = (value: unknown) =>
  (Array.isArray(value) ? value.map(String) : String(value || "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();

/**
 * Per-group fingerprints. Normalised so the DB row and the Quotes editor's
 * re-posted copy of the SAME item produce the same values (the editor posts
 * strings, defaults finish to "base" and pricing source to manual/recipe).
 */
export function quoteItemCommercialFingerprint(item: CommercialItem, quote: QuoteContext): Record<string, string> {
  const priceSnapshot = parseSnapshot(item.priceSnapshot) || {};
  const { pricingAuthority: _ignored, ...priceConfiguration } = priceSnapshot;
  const costSnapshot = parseSnapshot(item.costSnapshot);
  const recipeId = text(item.recipeId);
  const minQuantity = text(item.minQuantity);
  return {
    product: fnv1a(stableStringify([text(item.productName), text(item.variant), text(item.sku), recipeId])),
    quantity: fnv1a(stableStringify(Math.max(1, Math.floor(Number(item.quantity) || 1)))),
    price: fnv1a(stableStringify(amount(item.unitPrice))),
    cost: fnv1a(stableStringify(amount(item.unitCost))),
    options: fnv1a(stableStringify([
      text(item.selectedFinish) || "base",
      idList(item.selectedAddOnIds),
      text(item.pricingSource) || (recipeId ? "recipe" : "manual"),
      text(item.tierLabel),
      minQuantity === "" ? null : Number(minQuantity),
    ])),
    configuration: fnv1a(stableStringify([costSnapshot, priceConfiguration])),
    discount: fnv1a(stableStringify([text(quote?.customerTier) || "standard", text(quote?.customerTierLabel)])),
  };
}

/** Groups whose fingerprint differs (empty = unchanged). */
export function changedCommercialGroups(recorded: Record<string, string> | null | undefined, current: Record<string, string>): string[] {
  if (!recorded) return Object.keys(COMMERCIAL_FIELD_GROUPS);
  return Object.keys(COMMERCIAL_FIELD_GROUPS).filter((group) => recorded[group] !== current[group]);
}

/** An owner approval whose bound commercial fields no longer match the item. */
export function ownerApprovalStaleGroups(item: CommercialItem, quote: QuoteContext): string[] {
  const record = itemPricingAuthority(item as { priceSnapshot?: unknown });
  if (!record?.approved || record.kind !== OWNER_QUOTE_PRICE_KIND) return [];
  return changedCommercialGroups(record.ownerApproval?.fingerprint, quoteItemCommercialFingerprint(item, quote));
}

/* ------------------------------------------------------------------ *
 * Quote-level state used by every server gate.
 * ------------------------------------------------------------------ */

export type QuotePricingAuthorityState = {
  provisional: boolean;
  provisionalItems: string[];
  /** Owner approvals that no longer match their item (treated as provisional). */
  staleApprovals: string[];
  blockMessage: string | null;
};

type GateQuote = {
  customerTier?: string | null;
  customerTierLabel?: string | null;
  items?: Array<CommercialItem & { productName?: string | null; priceSnapshot?: unknown }> | null;
} | null | undefined;

export function quotePricingAuthorityState(quote: GateQuote): QuotePricingAuthorityState {
  const provisionalItems: string[] = [];
  const staleApprovals: string[] = [];
  for (const item of quote?.items || []) {
    const name = String(item.productName || "Quote item");
    const record = itemPricingAuthority(item);
    if (record?.approved === false) provisionalItems.push(name);
    else if (ownerApprovalStaleGroups(item, quote).length) {
      provisionalItems.push(name);
      staleApprovals.push(name);
    }
  }
  const provisional = provisionalItems.length > 0;
  return {
    provisional,
    provisionalItems,
    staleApprovals,
    blockMessage: provisional
      ? `${PROVISIONAL_PRICING_STATUS}: ${provisionalItems.join(", ")} has no approved selling price${staleApprovals.length ? " (an owner-approved price no longer matches the item — re-approval required)" : ""}. This quote can be saved as a draft only — it cannot be sent, approved, invoiced, ordered or moved into production until the owner sets and approves a price (Owner Set Price & Approve).`
      : null,
  };
}

/** Every status the Quotes page may write. */
export const QUOTE_STATUS_VALUES = ["draft", "sent", "approved", "deposit_paid", "paid", "production", "completed", "won", "lost", "canceled", "expired"] as const;
/**
 * Payment / production states. Shopify payment (webhooks.orders_paid) and the
 * production-job flow set these; by hand only the owner may, because `paid`
 * is what makes a quote eligible for production. ("completed" stays a normal
 * staff move — nothing automated sets it and it unlocks nothing.)
 */
export const OWNER_ONLY_QUOTE_STATUSES = ["deposit_paid", "paid", "production"] as const;

/** 2026-11-11: server check that a manual status change is a known status and, for payment/production states, made by the owner. */
export function quoteStatusChangeCheck(input: { currentStatus: string | null | undefined; nextStatus: string; isOwner: boolean }): { ok: true } | { ok: false; message: string } {
  const next = String(input.nextStatus || "");
  if (!(QUOTE_STATUS_VALUES as readonly string[]).includes(next)) return { ok: false, message: `Unknown quote status "${next}".` };
  if (next === String(input.currentStatus || "")) return { ok: true };
  if ((OWNER_ONLY_QUOTE_STATUSES as readonly string[]).includes(next) && !input.isOwner) {
    return { ok: false, message: `Only the owner can set a quote to "${next}" by hand. Payment statuses come from the Shopify payment; production starts from a paid quote.` };
  }
  return { ok: true };
}

/** Server check for any status change (status intent AND the editor's save intent). */
export function provisionalQuoteStatusCheck(quote: GateQuote, nextStatus: string): { ok: true } | { ok: false; message: string } {
  const state = quotePricingAuthorityState(quote);
  if (!state.provisional) return { ok: true };
  if ((PROVISIONAL_ALLOWED_QUOTE_STATUSES as readonly string[]).includes(String(nextStatus || "draft"))) return { ok: true };
  return { ok: false, message: state.blockMessage! };
}

/**
 * Legacy quote-level carry (kept for callers that only need "stays
 * provisional"). The Quotes editor save now uses reconcileQuoteItemPricingAuthority.
 */
export function carryProvisionalPricingAuthority<T extends { priceSnapshot?: string | null }>(
  existingItems: Array<{ priceSnapshot?: unknown }> | null | undefined,
  nextItems: T[],
): T[] {
  const recorded = (existingItems || []).map(itemPricingAuthority).find((record) => record?.approved === false) || null;
  if (!recorded) return nextItems;
  return nextItems.map((item) => {
    if (itemPricingAuthority(item)?.approved === false) return item;
    const snapshot = parseSnapshot(item.priceSnapshot) || {};
    return { ...item, priceSnapshot: JSON.stringify({ ...snapshot, pricingAuthority: recorded }) };
  });
}

function withAuthority<T extends { priceSnapshot?: string | null }>(item: T, record: PricingAuthorityRecord | null): T {
  const snapshot = parseSnapshot(item.priceSnapshot) || {};
  if (!record) {
    if (!("pricingAuthority" in snapshot)) return item;
    const { pricingAuthority: _dropped, ...rest } = snapshot;
    return { ...item, priceSnapshot: JSON.stringify(rest) };
  }
  return { ...item, priceSnapshot: JSON.stringify({ ...snapshot, pricingAuthority: record }) };
}

/** The provisional record an owner approval falls back to when it resets. */
export function resetOwnerApproval(record: PricingAuthorityRecord, changed: string[], actor: string, at: string): PricingAuthorityRecord {
  const approval = record.ownerApproval as OwnerApprovalRecord;
  return {
    approved: false,
    status: PROVISIONAL_PRICING_STATUS,
    kind: approval?.provisionalBasis?.kind || "none",
    source: null,
    missing: `Owner-approved price reset — ${changed.map((group) => COMMERCIAL_FIELD_GROUPS[group] || group).join(", ")} changed after approval. ${approval?.provisionalBasis?.missing || ""}`.trim(),
    customerUnitPrice: null,
    customerTotalPrice: null,
    diagnosticReference: record.diagnosticReference ?? null,
    ownerApproval: null,
    approvalReset: { at, by: actor, changed, previousApproval: approval },
    history: [...(record.history || []), { event: "owner_approval_reset", at, by: actor, changed }],
  };
}

const ADDED_LINE_MISSING = "Line added or re-entered in the Quotes editor after a pricing authority was recorded — no approved selling price. Owner Set Price & Approve required.";
const POSTED_APPROVAL_MISSING = "An approved pricing authority cannot be posted from the Quotes editor. Owner Set Price & Approve required.";

/**
 * The Quotes editor rewrites every item from what the browser posts. The
 * pricing authority of each saved item comes from the DATABASE:
 *  - provisional stays provisional;
 *  - an owner-approved price stays approved only while every bound commercial
 *    field is unchanged — otherwise it resets to PROVISIONAL (audit kept);
 *  - other approved records are kept exactly as recorded;
 *  - a browser-posted record is never trusted as approved.
 * Quotes that never recorded an authority keep their historical behaviour.
 */
export function reconcileQuoteItemPricingAuthority<T extends CommercialItem & { id?: string; productName?: string; priceSnapshot?: string | null }>(
  existingItems: Array<CommercialItem & { id: string; productName?: string | null; priceSnapshot?: unknown }> | null | undefined,
  nextItems: T[],
  quote: QuoteContext,
  actor: string,
  at: string,
): { items: T[]; resets: Array<{ item: string; changed: string[] }> } {
  const existing = existingItems || [];
  const quoteHasAuthority = existing.some((item) => itemPricingAuthority(item));
  const resets: Array<{ item: string; changed: string[] }> = [];
  const items = nextItems.map((item) => {
    const match = item.id ? existing.find((row) => row.id === item.id) : undefined;
    const posted = itemPricingAuthority(item);
    if (!match) {
      if (posted?.approved === false) return item;
      if (posted?.approved) {
        return withAuthority(item, { approved: false, status: PROVISIONAL_PRICING_STATUS, kind: "none", source: null, missing: POSTED_APPROVAL_MISSING, customerUnitPrice: null, customerTotalPrice: null });
      }
      if (!quoteHasAuthority) return item;
      return withAuthority(item, { approved: false, status: PROVISIONAL_PRICING_STATUS, kind: "none", source: null, missing: ADDED_LINE_MISSING, customerUnitPrice: null, customerTotalPrice: null });
    }
    const recorded = itemPricingAuthority(match);
    if (!recorded) return withAuthority(item, null);
    if (recorded.approved && recorded.kind === OWNER_QUOTE_PRICE_KIND) {
      const changed = changedCommercialGroups(recorded.ownerApproval?.fingerprint, quoteItemCommercialFingerprint(withAuthority(item, null), quote));
      if (changed.length) {
        resets.push({ item: String(item.productName || "Quote item"), changed });
        return withAuthority(item, resetOwnerApproval(recorded, changed, actor, at));
      }
    }
    return withAuthority(item, recorded);
  });
  return { items, resets };
}

/* ------------------------------------------------------------------ *
 * OWNER SET PRICE & APPROVE (pure part; the DB write lives in
 * quote-owner-price-approval.server.ts).
 * ------------------------------------------------------------------ */

export type OwnerSetPriceInput = { unitPrice?: unknown; totalPrice?: unknown; reason?: unknown; quantity: number };

/** Exact approved price from a unit OR total price, in the existing unit-price × quantity model. */
export function resolveOwnerSetPrice(input: OwnerSetPriceInput): { ok: true; unitPrice: number; totalPrice: number; reason: string } | { ok: false; error: string } {
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  if (!reason) return { ok: false, error: "A reason / note is required to set and approve a quote price." };
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 0));
  const unitText = String(input.unitPrice ?? "").trim();
  const totalText = String(input.totalPrice ?? "").trim();
  if (unitText && totalText) return { ok: false, error: "Enter the approved unit price OR the approved total price, not both." };
  if (!unitText && !totalText) return { ok: false, error: "Enter the approved customer unit price or total price." };
  const raw = Number(unitText || totalText);
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: "The approved price must be a positive amount." };
  if (unitText) {
    const unitPrice = Math.round(raw * 10000) / 10000;
    return { ok: true, unitPrice, totalPrice: Math.round(unitPrice * quantity * 100) / 100, reason };
  }
  const totalPrice = Math.round(raw * 100) / 100;
  const unitPrice = Math.round((totalPrice / quantity) * 100) / 100; // a total must split into an exact cent unit price
  if (Math.abs(Math.round(unitPrice * quantity * 100) / 100 - totalPrice) > 0.004) {
    return { ok: false, error: `$${totalPrice.toFixed(2)} does not divide evenly across ${quantity} units — enter a unit price instead.` };
  }
  return { ok: true, unitPrice, totalPrice, reason };
}

/** The approved record that replaces a provisional one. */
export function ownerApprovedAuthority(input: {
  previous: PricingAuthorityRecord;
  approvedBy: string;
  approvedAt: string;
  reason: string;
  unitPrice: number;
  totalPrice: number;
  quantity: number;
  unitCost: number;
  /** The quote's normal margin target (customer-tier floor) at approval time. */
  marginFloorPct: number;
}): PricingAuthorityRecord {
  const trueTotalCost = Math.round(input.unitCost * input.quantity * 100) / 100;
  const expectedProfit = Math.round((input.totalPrice - trueTotalCost) * 100) / 100;
  const expectedMarginPct = input.totalPrice > 0 ? Math.round((expectedProfit / input.totalPrice) * 1000) / 10 : null;
  return {
    approved: true,
    status: OWNER_APPROVED_PRICING_STATUS,
    kind: OWNER_QUOTE_PRICE_KIND,
    source: `Owner Set Price & Approve — this quote item only (${input.approvedBy}, ${input.approvedAt})`,
    missing: null,
    approvedUnitPrice: input.unitPrice,
    approvedTotalPrice: input.totalPrice,
    approvedQuantity: input.quantity,
    diagnosticReference: input.previous.diagnosticReference ?? null,
    ownerApproval: {
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
      reason: input.reason,
      approvedUnitPrice: input.unitPrice,
      approvedTotalPrice: input.totalPrice,
      quantity: input.quantity,
      trueUnitCost: input.unitCost,
      trueTotalCost,
      expectedProfit,
      expectedMarginPct,
      fingerprint: {},
      provisionalBasis: { kind: input.previous.kind, missing: input.previous.missing },
      lowMarginOverride: expectedMarginPct != null && expectedMarginPct < input.marginFloorPct
        ? { applied: true, thresholdPct: input.marginFloorPct, marginPct: expectedMarginPct, note: `${LOW_MARGIN_OWNER_OVERRIDE_NOTE} (${expectedMarginPct.toFixed(1)}% vs ${input.marginFloorPct}% target).` }
        : { applied: false, thresholdPct: input.marginFloorPct, marginPct: expectedMarginPct, note: null },
    },
    approvalReset: null,
    history: [
      ...(input.previous.history || []),
      { event: "owner_approved", at: input.approvedAt, by: input.approvedBy, reason: input.reason, approvedUnitPrice: input.unitPrice, approvedTotalPrice: input.totalPrice },
    ],
  };
}

export const LOW_MARGIN_OWNER_OVERRIDE_NOTE = "Below the normal margin target — this owner price approval also serves as the low-margin approval for this line only";

/**
 * True while the line carries a CURRENT owner-approved price: approved by
 * Owner Set Price & Approve and every bound commercial field (product,
 * quantity, options, configuration, price, cost, discount) unchanged. Only
 * then does that approval also satisfy the low-margin approval for the line.
 */
export function ownerApprovalCoversLine(item: CommercialItem, quote: QuoteContext): boolean {
  const record = itemPricingAuthority(item as { priceSnapshot?: unknown });
  if (!record?.approved || record.kind !== OWNER_QUOTE_PRICE_KIND || !record.ownerApproval) return false;
  return ownerApprovalStaleGroups(item, quote).length === 0;
}

/* ------------------------------------------------------------------ *
 * Stock Bag storefront authority vs the generic margin floor.
 * ------------------------------------------------------------------ */

/**
 * True only while the item still carries EXACTLY the server-resolved Stock
 * Bag storefront price (and the quantity it was resolved for). A manually
 * changed price loses the exemption and the normal margin protections apply.
 */
export function storefrontAuthorityExempt(item: { unitPrice?: unknown; quantity?: unknown; priceSnapshot?: unknown }): boolean {
  const record = itemPricingAuthority(item);
  if (!record?.approved || record.kind !== STOREFRONT_STOCK_BAG_KIND) return false;
  if (record.approvedUnitPrice == null || record.approvedQuantity == null) return false;
  return Math.abs(Number(item.unitPrice) - Number(record.approvedUnitPrice)) < 0.005 && Number(item.quantity) === Number(record.approvedQuantity);
}
