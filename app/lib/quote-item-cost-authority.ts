// Patch 2D-4E3 (October 2026) — QUOTE EDITOR CANONICAL COST PROTECTION.
//
// The Quotes editor lets staff retype any item's unit cost and unit price,
// and the save intent wrote both straight to the database. For a quote item
// whose cost snapshot carries a CANONICAL true-cost block (one saved by the
// Cost Calculator for a canonical-authority family), the manufacturing unit
// cost is NOT an opinion: it is the canonical engine's figure for that exact
// job and quantity. This module is the pure decision the save boundary (and
// the editor UI) consult:
//
//   * canonical block present and USABLE  -> unitCost is forced back to the
//     canonical manufacturing unit cost; whatever was typed is ignored.
//   * canonical block present but BLOCKED  -> the save is REFUSED. A blocked
//     canonical job never had a defensible cost; it cannot acquire one by
//     being edited.
//   * canonical block present and the posted QUANTITY differs from the
//     quantity the canonical cost was computed for -> REFUSED. The snapshot
//     does not carry the engine input, so the cost cannot be recomputed here;
//     the job must be re-quoted in the Cost Calculator.
//   * no canonical block (recipe-priced, manual, outsourced) -> unchanged
//     legacy behaviour; the typed value stands.
//
// Selling price (unitPrice) is a COMMERCIAL field and is not touched here —
// the existing low-margin approval policy governs it.
//
// Client-safe: pure data + JSON parsing, no server imports.

import { isCanonicalFamily } from "./canonical-calculator-shared";

export const QUOTE_ITEM_COST_AUTHORITY_VERSION = "17D.8C-quote-item-cost-authority";

export type CanonicalCostBlock = {
  family: string;
  status: "VALID" | "PROVISIONAL" | "DRAFT_ONLY";
  unitCost: number | null;
  totalCost: number | null;
  /** Finished quantity the canonical cost was computed for, when recorded. */
  quantity: number | null;
  version: string | null;
};

const STATUSES = new Set(["VALID", "PROVISIONAL", "DRAFT_ONLY"]);

function parseSnapshot(value: unknown): any | null {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  // null / undefined / "" are ABSENT, never zero — Number(null) would be 0,
  // which is exactly the "$0 masquerading as a cost" this module exists to stop.
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the canonical true-cost block from a persisted costSnapshot.
 *
 * Deliberately strict: it must be the Cost Calculator's `canonical` block
 * (a canonical family key AND a TrueCostStatus). The 15G.2 pricing snapshot
 * that recipe-priced items also store under `canonical` has neither, so it is
 * never mistaken for canonical manufacturing authority.
 */
export function canonicalCostBlockOf(costSnapshot: unknown): CanonicalCostBlock | null {
  const snapshot = parseSnapshot(costSnapshot);
  const block = snapshot?.canonical;
  if (!block || typeof block !== "object") return null;
  if (!isCanonicalFamily(block.family)) return null;
  if (typeof block.status !== "string" || !STATUSES.has(block.status)) return null;

  const quantity =
    finiteOrNull(block.quantity) ??
    finiteOrNull(snapshot?.canonicalSnapshot?.quantity) ??
    null;

  return {
    family: block.family,
    status: block.status,
    unitCost: finiteOrNull(block.unitCost),
    totalCost: finiteOrNull(block.totalCost),
    quantity: quantity != null && quantity > 0 ? Math.floor(quantity) : null,
    version: typeof block.version === "string" ? block.version : null,
  };
}

/** True when a quote item's manufacturing cost is owned by the canonical engine. */
export function quoteItemCostIsProtected(costSnapshot: unknown): boolean {
  return canonicalCostBlockOf(costSnapshot) != null;
}

export type QuoteItemCostDecision =
  | { protected: false; unitCost: number }
  | { protected: true; ok: true; unitCost: number; family: string; status: string; note: string }
  | { protected: true; ok: false; family: string; reason: string };

export const QUOTE_ITEM_COST_REASONS = {
  blocked: "CANONICAL_TRUE_COST_REQUIRED",
  quantityChanged: "CANONICAL_QUANTITY_MISMATCH",
} as const;

/**
 * Decide the unit cost a quote item may be saved with.
 *
 * `item.unitCost` is whatever the editor posted; `item.quantity` likewise.
 */
export function enforceQuoteItemUnitCost(item: {
  unitCost: unknown;
  quantity?: unknown;
  costSnapshot?: unknown;
  productName?: unknown;
}): QuoteItemCostDecision {
  const posted = finiteOrNull(item.unitCost) ?? 0;
  const block = canonicalCostBlockOf(item.costSnapshot);
  if (!block) return { protected: false, unitCost: posted };

  const name = String(item.productName || "item");

  if (block.status === "DRAFT_ONLY" || block.unitCost == null || !Number.isFinite(block.unitCost)) {
    return {
      protected: true,
      ok: false,
      family: block.family,
      reason:
        `${QUOTE_ITEM_COST_REASONS.blocked}: "${name}" (${block.family}) carries a BLOCKED canonical true cost (${block.status}, unit cost ${block.unitCost == null ? "null" : block.unitCost}). ` +
        `A blocked canonical job has no defensible manufacturing cost and cannot be saved with a typed one. Re-quote it in the Cost Calculator.`,
    };
  }

  const postedQty = finiteOrNull(item.quantity);
  if (block.quantity != null && postedQty != null && Math.floor(postedQty) !== block.quantity) {
    return {
      protected: true,
      ok: false,
      family: block.family,
      reason:
        `${QUOTE_ITEM_COST_REASONS.quantityChanged}: "${name}" (${block.family}) was costed canonically for ${block.quantity} units; the edit posts ${Math.floor(postedQty)}. ` +
        `The canonical manufacturing cost cannot be recomputed from the editor — re-quote the new quantity in the Cost Calculator.`,
    };
  }

  return {
    protected: true,
    ok: true,
    unitCost: block.unitCost,
    family: block.family,
    status: block.status,
    note: `Manufacturing unit cost held at the canonical figure (${block.status}) for ${block.family}; typed value ${posted} ignored.`,
  };
}
