import { tierRule } from "./customer-tiers";
// 2026-10-19 owner decisions: provisional items carry NO customer price; the exact Stock Bag storefront price is an approved authority.
import { LOW_MARGIN_OWNER_OVERRIDE_NOTE, STOREFRONT_BELOW_TARGET_WARNING, itemPricingAuthority, ownerApprovalCoversLine, storefrontAuthorityExempt } from "./quote-pricing-authority";

// Standard/default margin floor. Per-tier floors come from the customer-tier
// registry; today every tier's floor equals this value (behavior frozen).
export const LOW_MARGIN_THRESHOLD_PCT = 40;

// Namespaced so it can never collide with the payment/email markers the paid
// webhook and invoice actions match on ("[GSO] ... invoice paid/email sent").
export const LOW_MARGIN_APPROVAL_MARKER = "[GSO] Low-margin approved by ";

type MarginItem = {
  productName?: string | null;
  variant?: string | null;
  sku?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  unitCost?: number | null;
  priceSnapshot?: unknown;
};

type MarginQuote = {
  notes?: string | null;
  items?: MarginItem[] | null;
  customerTier?: string | null;
  customerTierLabel?: string | null;
  lowMarginApprovedAt?: Date | string | null;
  lowMarginApprovedBy?: string | null;
  lowMarginApprovalReason?: string | null;
  lowMarginApprovalThresholdPct?: number | null;
  lowMarginApprovedSnapshot?: unknown;
};

// Quote saves delete and recreate QuoteItem rows, so item ids are not stable.
// Snapshot comparison must therefore be value-based over a deterministic order.
export function normalizedSnapshotItems(items: MarginItem[] | null | undefined) {
  return (items || [])
    .map((item) => ({
      productName: String(item?.productName || ""),
      variant: String(item?.variant || ""),
      sku: String(item?.sku || ""),
      quantity: Number(item?.quantity) || 0,
      unitPrice: Number(item?.unitPrice) || 0,
      unitCost: Number(item?.unitCost) || 0,
    }))
    .sort((a, b) =>
      `${a.productName}|${a.variant}|${a.sku}|${a.quantity}|${a.unitPrice}|${a.unitCost}`.localeCompare(
        `${b.productName}|${b.variant}|${b.sku}|${b.quantity}|${b.unitPrice}|${b.unitCost}`,
      ),
    );
}

export function buildApprovalSnapshot(
  quote: MarginQuote,
  state: { thresholdPct: number; blendedMarginPct: number; lowestMarginPct: number | null },
) {
  return {
    thresholdPct: state.thresholdPct,
    blendedMarginPct: state.blendedMarginPct,
    lowestMarginPct: state.lowestMarginPct,
    items: normalizedSnapshotItems(quote.items),
  };
}

function snapshotMatchesItems(snapshot: unknown, items: MarginItem[] | null | undefined) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const snapshotItems = (snapshot as { items?: unknown }).items;
  if (!Array.isArray(snapshotItems)) return false;
  return (
    JSON.stringify(normalizedSnapshotItems(snapshotItems as MarginItem[])) ===
    JSON.stringify(normalizedSnapshotItems(items))
  );
}

export function itemMarginPct(item: MarginItem) {
  const unitPrice = Number(item?.unitPrice) || 0;
  const unitCost = Number(item?.unitCost) || 0;
  if (unitPrice <= 0) return null;
  return ((unitPrice - unitCost) / unitPrice) * 100;
}

export type QuoteMarginState = ReturnType<typeof quoteMarginState>;

export function quoteMarginState(quote: MarginQuote) {
  const marginFloorPct = tierRule(quote?.customerTier).marginFloorPct;
  const items = quote?.items || [];
  const lowItems: Array<{
    name: string;
    sku: string | null;
    marginPct: number | null;
    unknownCost: boolean;
    kind: "invalid_price" | "unknown_cost" | "below_threshold";
    reason: string;
  }> = [];

  let revenue = 0;
  let cost = 0;
  let lowestMarginPct: number | null = null;
  // 2026-10-19: approved Stock Bag storefront prices below the generic target — shown, never blocking.
  const approvedPriceWarnings: Array<{ name: string; marginPct: number; reason: string }> = [];
  // 2026-10-19: owner-approved line prices below the target — the owner approval IS the low-margin approval for that line.
  const ownerApprovedLowMargin: Array<{ name: string; marginPct: number; reason: string }> = [];

  for (const item of items) {
    // 2026-10-19 owner decision E: a PROVISIONAL item has no customer price —
    // it is not a $0 sale. The pricing-authority gate (not this margin gate)
    // holds the quote until the owner sets and approves a price.
    if (itemPricingAuthority(item)?.approved === false) continue;
    const unitPrice = Number(item?.unitPrice) || 0;
    const unitCost = Number(item?.unitCost) || 0;
    const quantity = Math.max(1, Number(item?.quantity) || 1);
    const name = String(item?.productName || "Quote item");
    const marginPct = itemMarginPct(item);
    const unknownCost = unitCost <= 0;

    revenue += unitPrice * quantity;
    cost += unitCost * quantity;

    if (marginPct != null && (lowestMarginPct == null || marginPct < lowestMarginPct)) {
      lowestMarginPct = marginPct;
    }

    if (unitPrice <= 0) {
      lowItems.push({
        name,
        sku: item?.sku || null,
        marginPct: null,
        unknownCost,
        kind: "invalid_price",
        reason: `${name}: invalid price (unit price is not positive)`,
      });
    } else if (unknownCost) {
      lowItems.push({
        name,
        sku: item?.sku || null,
        marginPct,
        unknownCost: true,
        kind: "unknown_cost",
        reason: `${name}: unknown cost (unit cost is 0 or less), margin cannot be verified`,
      });
    } else if ((marginPct as number) < marginFloorPct && storefrontAuthorityExempt(item)) {
      // 2026-10-19 owner decision 5: the EXACT server-resolved Stock Bag
      // storefront price is an approved commercial authority — the generic
      // floor warns but does not block. A changed price loses this exemption.
      approvedPriceWarnings.push({ name, marginPct: marginPct as number, reason: `${name}: ${STOREFRONT_BELOW_TARGET_WARNING} Margin ${(marginPct as number).toFixed(1)}% vs ${marginFloorPct}% target.` });
    } else if ((marginPct as number) < marginFloorPct && ownerApprovalCoversLine(item as any, quote)) {
      // 2026-10-19 owner decision: OWNER SET PRICE & APPROVE also satisfies the
      // low-margin approval for THIS exact line (same fingerprint — any change
      // to quantity, product, options, configuration, price or discount voids it).
      ownerApprovedLowMargin.push({ name, marginPct: marginPct as number, reason: `${name}: margin ${(marginPct as number).toFixed(1)}% is below ${marginFloorPct}% — ${LOW_MARGIN_OWNER_OVERRIDE_NOTE}.` });
    } else if ((marginPct as number) < marginFloorPct) {
      lowItems.push({
        name,
        sku: item?.sku || null,
        marginPct,
        unknownCost: false,
        kind: "below_threshold",
        reason: `${name}: margin ${(marginPct as number).toFixed(1)}% is below ${marginFloorPct}%`,
      });
    }
  }

  const blendedMarginPct = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
  const isLowMargin = lowItems.length > 0;

  // Approval resolution order: schema fields (with value-matched snapshot) win;
  // stale schema approval blocks again; legacy notes markers are honored only
  // when no schema approval exists (transition support).
  // 2026-11-11: the marker counts only at the START of a line, which is how the
  // approval action writes it. Staff notes lines that start with it are already
  // stripped (quote-staff-visibility mergeStaffNotes), so a marker typed mid-line
  // by staff can no longer approve a quote.
  const legacyMarkerApproved = String(quote?.notes || "").split(/\r?\n/).some((line) => line.startsWith(LOW_MARGIN_APPROVAL_MARKER));
  const hasSchemaApproval = Boolean(quote?.lowMarginApprovedAt);
  const schemaSnapshotMatches = hasSchemaApproval && snapshotMatchesItems(quote?.lowMarginApprovedSnapshot, items);

  let isApproved = false;
  let approvalStale = false;
  let approvalSource: "schema" | "legacy_marker" | null = null;

  if (hasSchemaApproval && schemaSnapshotMatches) {
    isApproved = true;
    approvalSource = "schema";
  } else if (hasSchemaApproval) {
    approvalStale = true;
  } else if (legacyMarkerApproved) {
    isApproved = true;
    approvalSource = "legacy_marker";
  }

  const hasBelowThreshold = lowItems.some((item) => item.kind === "below_threshold");
  const hasUnknownCost = lowItems.some((item) => item.kind === "unknown_cost" || item.unknownCost);
  const hasInvalidPrice = lowItems.some((item) => item.kind === "invalid_price");

  const approvalLabel = !isLowMargin
    ? ""
    : hasBelowThreshold && hasUnknownCost
      ? "Low margin / unknown cost - approval required"
      : hasUnknownCost && !hasBelowThreshold
        ? "Unknown cost - approval required"
        : hasInvalidPrice && !hasBelowThreshold
          ? "Invalid price - approval required"
          : "Low margin - approval required";

  return {
    thresholdPct: marginFloorPct,
    lowItems,
    lowestMarginPct,
    blendedMarginPct,
    isLowMargin,
    isApproved,
    approvalRequired: isLowMargin && !isApproved,
    approvalStale,
    approvalSource,
    approvedAt: quote?.lowMarginApprovedAt ? new Date(quote.lowMarginApprovedAt as any).toISOString() : null,
    approvedBy: quote?.lowMarginApprovedBy || null,
    hasBelowThreshold,
    hasUnknownCost,
    hasInvalidPrice,
    approvalLabel,
    approvedPriceWarnings,
    ownerApprovedLowMargin,
    blockMessage: isLowMargin
      ? `${approvalLabel.replace(" - approval required", "")} approval required: ${lowItems.map((item) => item.reason).join("; ")}`
      : "",
  };
}

export function lowMarginApprovalLine(input: {
  actor: string;
  thresholdPct: number;
  blendedMarginPct: number;
  lowestMarginPct: number | null;
  reason: string;
}) {
  const lowest = input.lowestMarginPct == null ? "n/a" : `${input.lowestMarginPct.toFixed(1)}%`;
  return `${LOW_MARGIN_APPROVAL_MARKER}${input.actor} at ${new Date().toISOString()} (threshold ${input.thresholdPct}%, blended ${input.blendedMarginPct.toFixed(1)}%, lowest item ${lowest}): ${input.reason}`;
}
