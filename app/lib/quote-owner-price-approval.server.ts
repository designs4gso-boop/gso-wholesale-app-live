// 2026-10-19 owner decision 4 — OWNER SET PRICE & APPROVE.
//
// Turns ONE provisional quote item into an owner-approved price for THAT
// quote item only. Writes exactly two rows: the QuoteItem (unit price,
// expected margin, pricingAuthority record with approver / time / reason /
// exact price / commercial fingerprint / history) and the Quote's notes
// (audit line). It never touches a pricing rule, ladder, curve or product —
// global pricing is unchanged. True cost (unitCost) is never modified — except
// that the owner may SUPPLY the internal cost of a Manual / Custom line that has
// none (2026-10-19: staff cannot enter cost); a canonical cost is never replaced.
//
// Authorization is decided by the caller from the verified session
// (owner-authorization.server.ts) and re-checked here: a non-owner is refused
// before anything is read or written.

import type { OwnerAuthorization } from "./owner-authorization.server";
import { tierRule } from "./customer-tiers";
import { quoteItemCostIsProtected } from "./quote-item-cost-authority";
import {
  OWNER_QUOTE_PRICE_KIND,
  itemPricingAuthority,
  ownerApprovalStaleGroups,
  ownerApprovedAuthority,
  resetOwnerApproval,
  quoteItemCommercialFingerprint,
  resolveOwnerSetPrice,
} from "./quote-pricing-authority";

export const OWNER_PRICE_APPROVAL_MARKER = "[GSO] Owner set price & approved by ";
/**
 * 2026-11-12: approved AUTOMATIC authorities the owner may override on one
 * quote item (Split Bag priced on the Sticker Bag ladder). Every other approved
 * authority (ladders, storefront, researched curves) keeps its existing rules.
 */
export const OWNER_OVERRIDABLE_AUTOMATIC_KINDS = ["split_bag_sticker_bag_ladder"] as const;

type Db = {
  quote: { findFirst: (args: any) => Promise<any>; updateMany: (args: any) => Promise<any> };
  quoteItem: { updateMany: (args: any) => Promise<any> };
  $transaction: (operations: any[]) => Promise<any>;
};

export type OwnerSetPriceResult =
  | { ok: true; message: string; unitPrice: number; totalPrice: number; expectedProfit: number; expectedMarginPct: number | null; lowMarginOverride: boolean }
  | { ok: false; error: string };

export async function ownerSetQuoteItemPrice(
  db: Db,
  input: { shop: string; quoteId: string; itemId: string; unitPrice?: unknown; totalPrice?: unknown; reason?: unknown; owner: OwnerAuthorization; now?: Date; /** Owner-supplied internal unit cost (lines without an authoritative cost only). */ internalUnitCost?: unknown },
): Promise<OwnerSetPriceResult> {
  if (!input.owner?.isOwner) return { ok: false, error: input.owner?.reason || "Owner-only action." };

  const quote = await db.quote.findFirst({ where: { id: input.quoteId, shop: input.shop }, include: { items: true } });
  if (!quote) return { ok: false, error: "Quote not found." };
  if (quote.status === "paid") return { ok: false, error: "Paid quotes are locked." };
  const item = (quote.items || []).find((row: any) => row.id === input.itemId);
  if (!item) return { ok: false, error: "Quote item not found." };

  let previous = itemPricingAuthority(item);
  const approvedAtDate = input.now || new Date();
  // An owner approval that no longer matches its item is provisional again — it may be re-approved.
  if (previous?.approved && previous.kind === OWNER_QUOTE_PRICE_KIND) {
    const stale = ownerApprovalStaleGroups(item, quote);
    if (stale.length) previous = resetOwnerApproval(previous, stale, input.owner.actor, approvedAtDate.toISOString());
  }
  // 2026-11-12: an automatic Split Bag recommendation may be OVERRIDDEN by the owner for this item.
  const automatic = previous?.approved === true && (OWNER_OVERRIDABLE_AUTOMATIC_KINDS as readonly string[]).includes(previous.kind) ? previous : null;
  if (automatic) {
    previous = {
      ...automatic,
      approved: false,
      missing: `Owner override of the automatic recommendation (${automatic.source || automatic.kind}).`,
      diagnosticReference: { unitPrice: automatic.approvedUnitPrice ?? null, totalPrice: automatic.approvedTotalPrice ?? null, basis: automatic.source ?? null },
    };
  }
  if (!previous || previous.approved !== false) {
    return { ok: false, error: previous?.kind === OWNER_QUOTE_PRICE_KIND ? "This item already has an owner-approved price." : "This item is not provisional — it already has an approved pricing authority." };
  }
  const suppliedCostText = String(input.internalUnitCost ?? "").trim();
  let costSupplied = false;
  let unitCost = Number(item.unitCost);
  if (suppliedCostText) {
    if (quoteItemCostIsProtected(item.costSnapshot)) {
      return { ok: false, error: "This line carries the canonical true cost — it cannot be replaced by a typed cost." };
    }
    const supplied = Number(suppliedCostText);
    if (!Number.isFinite(supplied) || supplied <= 0) return { ok: false, error: "The internal unit cost must be a positive amount." };
    unitCost = Math.round(supplied * 10000) / 10000;
    costSupplied = true;
  }
  if (previous.kind === "cost_blocked" || !Number.isFinite(unitCost) || unitCost <= 0) {
    return { ok: false, error: "This item has no internal cost yet — supply the internal unit cost (Manual / Custom items) or calculate the true cost before approving a price." };
  }

  const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
  const price = resolveOwnerSetPrice({ unitPrice: input.unitPrice, totalPrice: input.totalPrice, reason: input.reason, quantity });
  if (!price.ok) return price;

  const approvedAt = approvedAtDate.toISOString();
  const record = ownerApprovedAuthority({
    previous,
    approvedBy: input.owner.actor,
    approvedAt,
    reason: price.reason,
    unitPrice: price.unitPrice,
    totalPrice: price.totalPrice,
    quantity,
    unitCost,
    // Decision: the same approval also serves as this line's low-margin approval (read-only use of the tier floor).
    marginFloorPct: tierRule(quote.customerTier).marginFloorPct,
  });
  const approval = record.ownerApproval!;
  approval.internalCostSuppliedByOwner = costSupplied;
  approval.overrodeRecommendation = automatic
    ? { kind: automatic.kind, unitPrice: automatic.approvedUnitPrice ?? null, totalPrice: automatic.approvedTotalPrice ?? null, source: automatic.source ?? null }
    : null;

  const snapshot = (() => {
    try {
      return JSON.parse(String(item.priceSnapshot || "{}")) || {};
    } catch {
      return {};
    }
  })();
  const nextSnapshot: Record<string, unknown> = { ...snapshot, unitPrice: price.unitPrice, marginPct: approval.expectedMarginPct, ownerApprovedUnitPrice: price.unitPrice, ownerApprovedTotalPrice: price.totalPrice };
  // Bind the approval to every commercial field of the item AS APPROVED.
  approval.fingerprint = quoteItemCommercialFingerprint(
    { ...item, unitCost, unitPrice: price.unitPrice, priceSnapshot: JSON.stringify(nextSnapshot) },
    quote,
  );
  nextSnapshot.pricingAuthority = record;

  const auditLine = `${OWNER_PRICE_APPROVAL_MARKER}${approval.approvedBy} at ${approvedAt}: ${item.productName} × ${quantity} @ $${price.unitPrice.toFixed(2)}/unit ($${price.totalPrice.toFixed(2)}). Reason: ${price.reason}${approval.lowMarginOverride?.applied ? " — also recorded as this line's LOW-MARGIN OVERRIDE" : ""}. (Cost / profit / margin are kept in the owner-only approval record, not in quote notes.)`;
  const existingNotes = String(quote.notes || "");

  await db.$transaction([
    db.quoteItem.updateMany({
      where: { id: item.id, quoteId: quote.id },
      data: { unitPrice: price.unitPrice, marginPct: approval.expectedMarginPct, priceSnapshot: JSON.stringify(nextSnapshot), ...(costSupplied ? { unitCost } : {}) },
    }),
    db.quote.updateMany({
      where: { id: quote.id, shop: input.shop },
      data: { notes: existingNotes ? `${existingNotes}\n${auditLine}` : auditLine },
    }),
  ]);

  return {
    ok: true,
    message: `Owner price approved for ${item.productName}: $${price.unitPrice.toFixed(2)}/unit ($${price.totalPrice.toFixed(2)}); true cost $${approval.trueTotalCost.toFixed(2)}, expected profit $${approval.expectedProfit.toFixed(2)}, margin ${approval.expectedMarginPct == null ? "—" : `${approval.expectedMarginPct.toFixed(1)}%`}.${approval.lowMarginOverride?.applied ? ` WARNING: ${approval.lowMarginOverride.note}` : ""} Any later change to product, quantity, options, configuration, price or discount resets this approval.`,
    unitPrice: price.unitPrice,
    totalPrice: price.totalPrice,
    expectedProfit: approval.expectedProfit,
    expectedMarginPct: approval.expectedMarginPct,
    lowMarginOverride: Boolean(approval.lowMarginOverride?.applied),
  };
}
