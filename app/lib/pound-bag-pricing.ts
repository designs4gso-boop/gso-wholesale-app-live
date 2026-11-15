// 2026-11-15 — QP / P Bag (14x16): a place for its OWN selling-price ladder.
//
// STATUS: NOTHING HERE PRICES A QUOTE. The calculator still prices this bag on
// the approved Sticker Bag ladder (calculator-owner-view.ts, kind
// "pound_bag_sticker_bag_ladder"). The owner has asked for a dedicated
// large-bag ladder and must approve one first; until then
// POUND_BAG_APPROVED_PRICE_LADDER is null and this module is not imported by
// any route.
//
// The three ladders below are PROPOSALS for owner review (the tables sent to
// the owner on 2026-11-15 were produced by this exact function). A ladder is
// a margin curve over quantity (linear between anchors, flat outside them)
// plus a minimum gross profit per job; it is applied to the bag's OWN
// canonical true cost. It never touches the 4x5, Split Bag, jar or DTP rules.

export type PoundBagLadderAnchor = { quantity: number; marginPct: number };

export type PoundBagPriceLadder = {
  key: string;
  label: string;
  status: "PROPOSED" | "OWNER_APPROVED";
  /** Margin anchors, ascending by quantity. */
  anchors: PoundBagLadderAnchor[];
  /** Minimum gross profit per job, in dollars. */
  minimumProfit: number;
};

/** The global margin floor every GSO price already respects. */
export const POUND_BAG_LADDER_GLOBAL_FLOOR_PCT = 40;

export const POUND_BAG_PROPOSED_LADDERS: Record<"conservative" | "balanced" | "aggressive", PoundBagPriceLadder> = {
  conservative: {
    key: "conservative", label: "A. Conservative / higher margin", status: "PROPOSED", minimumProfit: 100,
    anchors: [{ quantity: 4, marginPct: 62 }, { quantity: 16, marginPct: 60 }, { quantity: 50, marginPct: 57 }, { quantity: 100, marginPct: 54 }, { quantity: 256, marginPct: 51 }, { quantity: 500, marginPct: 48 }, { quantity: 1000, marginPct: 45 }],
  },
  balanced: {
    key: "balanced", label: "B. Balanced / recommended", status: "PROPOSED", minimumProfit: 75,
    anchors: [{ quantity: 4, marginPct: 55 }, { quantity: 16, marginPct: 53 }, { quantity: 50, marginPct: 50 }, { quantity: 100, marginPct: 47 }, { quantity: 256, marginPct: 44 }, { quantity: 500, marginPct: 42 }, { quantity: 1000, marginPct: 40 }],
  },
  aggressive: {
    key: "aggressive", label: "C. Aggressive / volume", status: "PROPOSED", minimumProfit: 60,
    anchors: [{ quantity: 4, marginPct: 50 }, { quantity: 16, marginPct: 47 }, { quantity: 50, marginPct: 45 }, { quantity: 100, marginPct: 42 }, { quantity: 256, marginPct: 40 }, { quantity: 500, marginPct: 40 }, { quantity: 1000, marginPct: 40 }],
  },
};

/** The ladder the owner has approved. Null = none yet; the calculator keeps its existing authority. */
export const POUND_BAG_APPROVED_PRICE_LADDER: PoundBagPriceLadder | null = null;

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
      return lo.marginPct + ((hi.marginPct - lo.marginPct) * (quantity - lo.quantity)) / (hi.quantity - lo.quantity);
    }
  }
  return last.marginPct;
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
 * The price a ladder gives a job: the larger of cost / (1 - margin) and
 * cost + minimum profit. Pure. Returns null when there is no usable cost —
 * a price is never produced from a missing or zero cost.
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
