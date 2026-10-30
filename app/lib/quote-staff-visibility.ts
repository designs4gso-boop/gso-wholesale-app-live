// 2026-10-19 owner decision — QUOTE EDITOR FINANCIAL VISIBILITY.
//
// Non-owner staff never RECEIVE line-level internal cost or margin: the
// Quotes loader / action pass every quote, item and recipe they send to a
// non-owner through these redactors (server-side — hiding a field in the UI
// is not the guard). On a staff save the server restores the financial
// fields from the DATABASE (or recomputes a recipe line itself), so a staff
// browser can neither see nor overwrite internal cost.
//
// A Manual / Custom line a staff member adds has no authoritative internal
// cost: it is saved PROVISIONAL — "Owner Approval Required" — until the owner
// supplies the internal cost and approves the price (Owner Set Price & Approve).
//
// Pure + client-safe.

import { OWNER_QUOTE_PRICE_KIND, PROVISIONAL_PRICING_STATUS, itemPricingAuthority, type PricingAuthorityRecord } from "./quote-pricing-authority";

export const OWNER_APPROVAL_REQUIRED = "Owner Approval Required";
/** Same text as LOW_MARGIN_APPROVAL_MARKER (quote-margin.server.ts — server-only module); a test pins them equal. */
export const LOW_MARGIN_APPROVAL_MARKER_TEXT = "[GSO] Low-margin approved by ";

export const STAFF_MANUAL_ITEM_MISSING = `${OWNER_APPROVAL_REQUIRED} — Manual / Custom item with no authoritative internal cost. The owner supplies the internal cost and approves the price.`;

/** The provisional record a staff-added Manual / Custom line is saved with. */
export function staffManualItemAuthority(): PricingAuthorityRecord {
  return {
    approved: false,
    status: PROVISIONAL_PRICING_STATUS,
    kind: "staff_manual_item",
    source: null,
    missing: STAFF_MANUAL_ITEM_MISSING,
    customerUnitPrice: null,
    customerTotalPrice: null,
  };
}

/** Staff-safe authority: approval state + customer-facing approved price only. */
function staffAuthority(record: PricingAuthorityRecord | null) {
  if (!record) return null;
  const owner = record.approved && record.kind === OWNER_QUOTE_PRICE_KIND && record.ownerApproval
    ? {
        approvedBy: record.ownerApproval.approvedBy,
        approvedAt: record.ownerApproval.approvedAt,
        approvedUnitPrice: record.ownerApproval.approvedUnitPrice,
        approvedTotalPrice: record.ownerApproval.approvedTotalPrice,
      }
    : null;
  return {
    approved: record.approved,
    status: record.approved ? record.status : OWNER_APPROVAL_REQUIRED,
    kind: record.kind,
    source: null,
    missing: record.approved ? null : OWNER_APPROVAL_REQUIRED,
    ownerApproval: owner,
  };
}

/** One quote line as a non-owner may receive it: no internal cost, margin, snapshots or diagnostics. */
export function redactQuoteItemForStaff<T extends Record<string, any>>(item: T): T {
  const authority = staffAuthority(itemPricingAuthority(item));
  return {
    ...item,
    unitCost: null,
    marginPct: null,
    costSnapshot: null,
    priceSnapshot: authority ? JSON.stringify({ pricingAuthority: authority }) : null,
  };
}

/** Quote notes without the low-margin audit lines (they carry margin percentages). */
export function stripFinancialAuditLines(notes: string | null | undefined): { visible: string; financial: string[] } {
  const lines = String(notes || "").split("\n");
  const financial = lines.filter((line) => line.startsWith(LOW_MARGIN_APPROVAL_MARKER_TEXT));
  const visible = lines.filter((line) => !line.startsWith(LOW_MARGIN_APPROVAL_MARKER_TEXT)).join("\n");
  return { visible, financial };
}

/** Staff save: keep the DB's financial audit lines whatever the browser posted. */
export function mergeStaffNotes(postedNotes: string | null | undefined, dbNotes: string | null | undefined): string {
  const posted = stripFinancialAuditLines(postedNotes).visible;
  const kept = stripFinancialAuditLines(dbNotes).financial;
  return [posted, ...kept].filter((line) => line !== "").join("\n");
}

/** A Product Setup recipe as staff receive it: identity and options, no costs, margins or tiers. */
export function redactRecipeForStaff(recipe: Record<string, any>) {
  const addOn = (entry: any) => ({ id: entry.id, name: entry.name });
  return {
    id: recipe.id,
    name: recipe.name,
    sku: recipe.sku ?? null,
    productType: recipe.productType ?? null,
    productTypeProfile: recipe.productTypeProfile ? { name: recipe.productTypeProfile.name } : null,
    productionMode: recipe.productionMode ?? null,
    defaultQuantity: recipe.defaultQuantity ?? null,
    minQuantity: recipe.minQuantity ?? null,
    addOns: (recipe.addOns || []).map(addOn),
    vendorProduct: recipe.vendorProduct ? { addOns: (recipe.vendorProduct.addOns || []).map(addOn) } : null,
  };
}

/** A "Calculate from ERP" result as staff receive it: the recommended customer price, no cost / margin. */
export function redactRecipeLineForStaff(result: Record<string, any>) {
  if (!result?.ok || !result.line) return { ok: result?.ok ?? false, error: result?.error, canonicalAuthorityRequired: result?.canonicalAuthorityRequired };
  return {
    ok: true,
    warnings: [],
    line: { ...result.line, unitCost: "", marginPct: "", costSnapshot: "", priceSnapshot: "" },
  };
}
