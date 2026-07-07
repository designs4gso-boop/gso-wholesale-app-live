export const LOW_MARGIN_THRESHOLD_PCT = 40;

// Namespaced so it can never collide with the payment/email markers the paid
// webhook and invoice actions match on ("[GSO] ... invoice paid/email sent").
export const LOW_MARGIN_APPROVAL_MARKER = "[GSO] Low-margin approved by ";

type MarginItem = {
  productName?: string | null;
  sku?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  unitCost?: number | null;
};

export function itemMarginPct(item: MarginItem) {
  const unitPrice = Number(item?.unitPrice) || 0;
  const unitCost = Number(item?.unitCost) || 0;
  if (unitPrice <= 0) return null;
  return ((unitPrice - unitCost) / unitPrice) * 100;
}

export type QuoteMarginState = ReturnType<typeof quoteMarginState>;

export function quoteMarginState(quote: { notes?: string | null; items?: MarginItem[] | null }) {
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

  for (const item of items) {
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
    } else if ((marginPct as number) < LOW_MARGIN_THRESHOLD_PCT) {
      lowItems.push({
        name,
        sku: item?.sku || null,
        marginPct,
        unknownCost: false,
        kind: "below_threshold",
        reason: `${name}: margin ${(marginPct as number).toFixed(1)}% is below ${LOW_MARGIN_THRESHOLD_PCT}%`,
      });
    }
  }

  const blendedMarginPct = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
  const isLowMargin = lowItems.length > 0;
  const isApproved = String(quote?.notes || "").includes(LOW_MARGIN_APPROVAL_MARKER);
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
    thresholdPct: LOW_MARGIN_THRESHOLD_PCT,
    lowItems,
    lowestMarginPct,
    blendedMarginPct,
    isLowMargin,
    isApproved,
    approvalRequired: isLowMargin && !isApproved,
    hasBelowThreshold,
    hasUnknownCost,
    hasInvalidPrice,
    approvalLabel,
    blockMessage: isLowMargin
      ? `${approvalLabel.replace(" - approval required", "")} approval required: ${lowItems.map((item) => item.reason).join("; ")}`
      : "",
  };
}

export function lowMarginApprovalLine(input: {
  actor: string;
  blendedMarginPct: number;
  lowestMarginPct: number | null;
  reason: string;
}) {
  const lowest = input.lowestMarginPct == null ? "n/a" : `${input.lowestMarginPct.toFixed(1)}%`;
  return `${LOW_MARGIN_APPROVAL_MARKER}${input.actor} at ${new Date().toISOString()} (threshold ${LOW_MARGIN_THRESHOLD_PCT}%, blended ${input.blendedMarginPct.toFixed(1)}%, lowest item ${lowest}): ${input.reason}`;
}
