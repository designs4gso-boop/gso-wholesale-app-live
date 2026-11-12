// 4x5 sticker/stock bag ARTBOARD — extracted verbatim from
// bag-cost-inputs.server.ts (2D-2 owner standard) on 2026-10-05 so the
// product-spec layer can read it client-side. bag-cost-inputs.server.ts
// re-exports it; the cost path reads exactly this value. Pure data.

export const BAG_4X5_ARTBOARD_IN = { widthIn: 4.0, heightIn: 5.0 } as const;

/**
 * OWNER DECISION 2026-11-11 — the 4x5 bag label ACTUAL CUTLINE is
 * 3.79 x 4.81 in (the documented owner-confirmed 4x5 standard, a3495cc /
 * 2C-3A). The 3.875 x 4.875 value introduced by cf04eaf (derived from the
 * generic -0.0625 in offset rule) had no owner decision for the 4x5 and is
 * superseded for this product. Other labels keep the gso-cutline.ts rule.
 * Used by every 4x5 bag label: 4x5 Sticker Bags and Stock Bags. The Split
 * Bag has its own, larger geometry (SPLIT_BAG_* below).
 */
export const BAG_4X5_CUTLINE_IN = { widthIn: 3.79, heightIn: 4.81 } as const;
export const BAG_4X5_CUTLINE_DECISION = "Owner decision 2026-11-11: 4x5 actual cutline 3.79 x 4.81 in (documented owner standard; supersedes the undocumented 3.875 x 4.875 derived value).";
/**
 * OWNER CORRECTION 2026-11-12 — the Split Bag is PHYSICALLY LARGER than the
 * 4x5 bag. Owner-measured production values, used EXACTLY (never derived or
 * rounded from the generic -0.125 in rule, and never the 4x5 3.79 x 4.81):
 *   art / print size  7.20 x 4.38 in — artwork area, nesting, media, ink
 *   cutline           7.07 x 4.26 in — cut path / perimeter
 * One label per printed side is unchanged (front + back = 2, never 4).
 */
export const SPLIT_BAG_ARTBOARD_IN = { widthIn: 7.2, heightIn: 4.38 } as const;
export const SPLIT_BAG_CUTLINE_IN = { widthIn: 7.07, heightIn: 4.26 } as const;
export const SPLIT_BAG_GEOMETRY_DECISION = "Owner correction 2026-11-12: Split Bag art / print size 7.20 x 4.38 in, cutline 7.07 x 4.26 in (physically confirmed; not the 4x5 geometry).";

export type BagLabelGeometry = {
  artboard: { readonly widthIn: number; readonly heightIn: number };
  cutline: { readonly widthIn: number; readonly heightIn: number };
  decision: string;
  displayName: string;
};

/** The label geometry for a bag product ("split_bag" or any 4x5 bag product). */
export function bagLabelGeometryFor(product: string): BagLabelGeometry {
  return product === "split_bag"
    ? { artboard: SPLIT_BAG_ARTBOARD_IN, cutline: SPLIT_BAG_CUTLINE_IN, decision: SPLIT_BAG_GEOMETRY_DECISION, displayName: "Split Bag" }
    : { artboard: BAG_4X5_ARTBOARD_IN, cutline: BAG_4X5_CUTLINE_IN, decision: BAG_4X5_CUTLINE_DECISION, displayName: "Standard 4x5 Sticker Bag" };
}

export const BAG_ARTBOARD_SOURCE = "bag-artboard-geometry.ts — 2D-2 owner 4x5 label artboard 4.00 x 5.00 in; owner 4x5 cutline 3.79 x 4.81 in (decision 2026-11-11)";
