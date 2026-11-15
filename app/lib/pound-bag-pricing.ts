// QP / P Bag (14x16) — its OWN selling-price authority.
//
// OWNER APPROVAL 2026-11-15: the Balanced dedicated ladder below is the ONE
// active pricing rule for this product. It replaces the Standard 4x5 Sticker
// Bag ladder, which this bag inherited for one day and which was calibrated
// for a sub-$1 bag, not a ~$3 large-format one.
//
//   margin anchors   4 = 55%, 16 = 53%, 50 = 50%, 100 = 47%, 256 = 44%,
//                    500 = 42%, 1000 = 40%
//   between anchors  LINEAR in quantity (smooth — no cliffs); flat below 4
//                    and above 1000
//   minimum profit   $75 gross profit per job
//   safety floor     the existing 40% global margin floor
//   sides            ONE curve for front only, back only and front + back —
//                    each side configuration already has its own true cost
//
// The cost side is unchanged: the shared Sticker Bag COST engine (canonical
// bag adapter) produces the true cost; this file only says what margin that
// cost is priced at. Nothing here is read by the 4x5, Split Bag, Stock Bag,
// jar or DTP pricing paths.
//
// (The Conservative and Aggressive proposals shown to the owner on 2026-11-15
// were not approved and are deliberately not kept in code.)

export type PoundBagLadderAnchor = { quantity: number; marginPct: number };

export type PoundBagPriceLadder = {
  key: string;
  label: string;
  status: "OWNER_APPROVED";
  approvedOn: string;
  /** Margin anchors, ascending by quantity. */
  anchors: PoundBagLadderAnchor[];
  /** Minimum gross profit per job, in dollars. */
  minimumProfit: number;
};

/** The margin-rule / curve key this product prices under (never "bags-4x5"). */
export const POUND_BAG_PRICE_LADDER_KEY = "qp-p-bag-14x16";

/** The global margin floor every GSO price already respects. */
export const POUND_BAG_LADDER_GLOBAL_FLOOR_PCT = 40;

export const POUND_BAG_APPROVED_PRICE_LADDER: PoundBagPriceLadder = {
  key: POUND_BAG_PRICE_LADDER_KEY,
  label: "QP / P Bag (14x16) dedicated ladder",
  status: "OWNER_APPROVED",
  approvedOn: "2026-11-15",
  minimumProfit: 75,
  anchors: [
    { quantity: 4, marginPct: 55 },
    { quantity: 16, marginPct: 53 },
    { quantity: 50, marginPct: 50 },
    { quantity: 100, marginPct: 47 },
    { quantity: 256, marginPct: 44 },
    { quantity: 500, marginPct: 42 },
    { quantity: 1000, marginPct: 40 },
  ],
};

/** Quantities the calculator's tier table shows for this product: the approved anchors. */
export const POUND_BAG_DISPLAY_LADDER = POUND_BAG_APPROVED_PRICE_LADDER.anchors.map((anchor) => anchor.quantity);

export const POUND_BAG_PRICE_LADDER_SOURCE = "Owner-approved QP / P Bag (14x16) pricing ladder (2026-11-15)";

/**
 * The margin rule the calculator carries for this product. Shaped like a
 * FamilyMarginRule so the existing commercial-price function accepts it; the
 * five-value `curve` is the display summary only — the price always comes
 * from the anchors (poundBagLadderMarginPct).
 */
export const POUND_BAG_MARGIN_RULE = {
  key: POUND_BAG_PRICE_LADDER_KEY,
  label: POUND_BAG_APPROVED_PRICE_LADDER.label,
  curve: [55, 53, 50, 44, 40],
  familyMinPct: POUND_BAG_LADDER_GLOBAL_FLOOR_PCT,
  aliases: [] as string[],
};

/** Margin for a quantity: linear between anchors, flat before the first and after the last. */
export function poundBagLadderMarginPct(ladder: PoundBagPriceLadder, quantity: number): number {
  const anchors = [...ladder.anchors].sort((a, b) => a.quantity - b.quantity);
  if (!anchors.length) return POUND_BAG_LADDER_GLOBAL_FLOOR_PCT;
  if (quantity <= anchors[0].quantity) return anchors[0].marginPct;
  const last = anchors[anchors.length - 1];
  if (quantity >= last.quantity) return last.marginPct;
  for (let i = 1; i < anchors.length; i += 1) {
    const lo = anchors[i - 1];
    const hi = anchors[i];
    if (quantity <= hi.quantity) {
      // two decimals: exact at every anchor, and a readable percentage in between
      return Math.round((lo.marginPct + ((hi.marginPct - lo.marginPct) * (quantity - lo.quantity)) / (hi.quantity - lo.quantity)) * 100) / 100;
    }
  }
  return last.marginPct;
}

/** The approved margin for a quantity of QP / P Bags (14x16). */
export function poundBagMarginPctForQuantity(quantity: number): number {
  return Math.max(POUND_BAG_LADDER_GLOBAL_FLOOR_PCT, poundBagLadderMarginPct(POUND_BAG_APPROVED_PRICE_LADDER, Math.max(1, Math.floor(quantity))));
}

/**
 * Pricing-policy values for ONE QP / P Bag tier row: the caller's policy with
 * this product's curve entry (the approved margin for exactly this quantity)
 * and the approved $75 minimum gross profit. Handed to the existing
 * computeCommercialPrice, so the cost-based price, the minimum-profit rule
 * and the 40% floor all run through the SAME code as every other product.
 * A copy — the caller's values (and so every other product) are untouched.
 */
export function poundBagPolicyValues<T extends { marginCurves: { families: Record<string, any> }; minimumGrossProfit: Record<string, any> }>(values: T, quantity: number, familyKey = "sticker-bags"): T {
  return {
    ...values,
    marginCurves: {
      ...values.marginCurves,
      families: {
        ...values.marginCurves.families,
        [POUND_BAG_PRICE_LADDER_KEY]: { familyMinPct: POUND_BAG_LADDER_GLOBAL_FLOOR_PCT, bands: [{ minQty: 1, targetPct: poundBagMarginPctForQuantity(quantity) }] },
      },
    },
    minimumGrossProfit: { ...values.minimumGrossProfit, [familyKey]: POUND_BAG_APPROVED_PRICE_LADDER.minimumProfit },
  };
}

export type PoundBagLadderPrice = {
  quantity: number;
  trueCost: number;
  totalPrice: number;
  unitPrice: number;
  profit: number;
  /** Realized margin on the final price, in percent. */
  marginPct: number;
  /** The curve margin for this quantity (before the minimum profit). */
  curveMarginPct: number;
  controllingRule: "margin_curve" | "minimum_profit";
};

/**
 * Reference implementation of the rule: the larger of cost / (1 - margin) and
 * cost + minimum profit. Pure. The calculator prices through
 * computeCommercialPrice (see poundBagPolicyValues); tests hold the two equal.
 * Returns null when there is no usable cost.
 */
export function poundBagLadderPrice(ladder: PoundBagPriceLadder, input: { quantity: number; trueCost: number }): PoundBagLadderPrice | null {
  const quantity = Math.floor(Number(input.quantity));
  const trueCost = Number(input.trueCost);
  if (!(quantity > 0) || !Number.isFinite(trueCost) || !(trueCost > 0)) return null;
  const curveMarginPct = Math.max(POUND_BAG_LADDER_GLOBAL_FLOOR_PCT, poundBagLadderMarginPct(ladder, quantity));
  const byMargin = trueCost / (1 - curveMarginPct / 100);
  const byMinimumProfit = trueCost + Math.max(0, ladder.minimumProfit);
  const totalPrice = Math.max(byMargin, byMinimumProfit);
  const profit = totalPrice - trueCost;
  return {
    quantity, trueCost, totalPrice, unitPrice: totalPrice / quantity, profit,
    marginPct: (profit / totalPrice) * 100,
    curveMarginPct,
    controllingRule: byMinimumProfit > byMargin ? "minimum_profit" : "margin_curve",
  };
}
