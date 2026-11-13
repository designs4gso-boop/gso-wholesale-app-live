// 2026-11-12 OWNER DECISIONS — Split Bag customer price.
//
// Final owner decision: a Split Bag quote carries an AUTOMATIC price from the
// approved Sticker Bag pricing ladder applied to the Split Bag's own true cost
// (calculator-owner-view.ts, kind "split_bag_sticker_bag_ladder") and can be
// sent as is (the 4x5 dollar prices are never copied). The owner MAY override the price on one
// quote with Owner Set Price & Approve (quote-owner-price-approval.server.ts),
// which writes that one quote item only — never a ladder, tier, product,
// Material Center row or Shopify price, and never the true cost.
//
// Pure, client-safe: the live preview the owner sees while typing a price.

import { resolveOwnerSetPrice } from "./quote-pricing-authority";

export const SPLIT_BAG_OWNER_PRICE_LABEL = "OWNER-SET CUSTOMER PRICE — THIS QUOTE ONLY";
export const SPLIT_BAG_AUTOMATIC_PRICE_KIND = "split_bag_sticker_bag_ladder";
export const SPLIT_BAG_LADDER_BADGE = "Approved Sticker Bag pricing ladder applied to Split Bag true cost";

const parse = (value: unknown) => {
  try {
    return typeof value === "string" ? JSON.parse(value || "null") : value ?? null;
  } catch {
    return null;
  }
};

/** A quote line costed as a Split Bag (snapshot flag, authority text, or the product name). */
export function isSplitBagQuoteItem(item: { productName?: string | null; costSnapshot?: unknown; priceSnapshot?: unknown } | null | undefined): boolean {
  if (!item) return false;
  const cost = parse(item.costSnapshot);
  if (cost?.splitBag === true || cost?.productBreakdown?.splitBag === true || cost?.canonicalFamilyKey === "split-bags") return true;
  const authority = parse(item.priceSnapshot)?.pricingAuthority;
  if (authority?.kind === SPLIT_BAG_AUTOMATIC_PRICE_KIND || authority?.ownerApproval?.overrodeRecommendation?.kind === SPLIT_BAG_AUTOMATIC_PRICE_KIND) return true;
  if (/Split Bag/i.test(String(authority?.missing || ""))) return true;
  return /\bsplit[\s-]*bag\b/i.test(String(item.productName || ""));
}

export type OwnerPricePreview = {
  ok: true;
  unitPrice: number;
  totalPrice: number;
  trueTotalCost: number;
  trueUnitCost: number;
  expectedProfit: number;
  /** profit / customer total, in percent. */
  realizedMarginPct: number | null;
  /** profit / true cost, in percent (informational only — never a price authority). */
  markupPct: number | null;
} | { ok: false; error: string };

/**
 * The exact numbers the approval will record, from a unit OR total price.
 * Uses the same resolver as the server so the preview never disagrees with
 * what is saved. True cost is an input and is never changed.
 */
export function ownerPricePreview(input: { quantity: number; trueUnitCost: number; unitPrice?: string | number | null; totalPrice?: string | number | null }): OwnerPricePreview {
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const unitText = input.unitPrice == null ? "" : String(input.unitPrice).trim();
  const totalText = input.totalPrice == null ? "" : String(input.totalPrice).trim();
  const price = resolveOwnerSetPrice({ unitPrice: unitText, totalPrice: unitText ? "" : totalText, reason: "preview", quantity });
  if (!price.ok) return price;
  const trueUnitCost = Number(input.trueUnitCost) || 0;
  const trueTotalCost = Math.round(trueUnitCost * quantity * 100) / 100;
  const expectedProfit = Math.round((price.totalPrice - trueTotalCost) * 100) / 100;
  return {
    ok: true,
    unitPrice: price.unitPrice,
    totalPrice: price.totalPrice,
    trueTotalCost,
    trueUnitCost,
    expectedProfit,
    realizedMarginPct: price.totalPrice > 0 ? Math.round((expectedProfit / price.totalPrice) * 1000) / 10 : null,
    markupPct: trueTotalCost > 0 ? Math.round((expectedProfit / trueTotalCost) * 1000) / 10 : null,
  };
}
