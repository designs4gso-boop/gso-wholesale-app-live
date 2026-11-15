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

/**
 * OWNER DATA 2026-11-15 — the QP / P Bag (14x16) (a Sticker Bag blank).
 *   bag size            14.39 x 16.39 in (the physical bag — reference only, never printed)
 *   sticker / art size  14.05 x 16.00 in — the SAME sticker on the front and on the back
 * The owner gave ONE sticker size and no separate cutline, so the cut path is
 * the sticker itself (14.05 x 16.00). Nothing is derived from the 4x5 or the
 * Split Bag, and the generic -0.0625 in offset rule is not applied.
 */
export const POUND_BAG_14X16_BAG_IN = { widthIn: 14.39, heightIn: 16.39 } as const;
export const POUND_BAG_14X16_ARTBOARD_IN = { widthIn: 14.05, heightIn: 16.0 } as const;
export const POUND_BAG_14X16_CUTLINE_IN = POUND_BAG_14X16_ARTBOARD_IN;
export const POUND_BAG_14X16_GEOMETRY_DECISION = "Owner data 2026-11-15: QP / P Bag (14x16) — bag 14.39 x 16.39 in, sticker / art 14.05 x 16.00 in, same sticker front and back; no separate cutline given, so the cut path is the 14.05 x 16.00 sticker.";

/**
 * OWNER CLARIFICATION 2026-11-15 — ONE product. QP Bag = P Bag = 14x16 / Pound
 * Bag: the same large Sticker Bag (there is no separate, smaller QP size).
 * One employee-facing name; the other names are aliases of it only.
 */
export const POUND_BAG_14X16_DISPLAY_NAME = "QP / P Bag (14x16)";
export const POUND_BAG_14X16_ALIASES = ["QP", "QP Bag", "Quarter Pound Bag", "P Bag", "Pound Bag", "14x16", "14x16 Bag", "14x16 / Pound Bag", "large sticker bag"] as const;
/** True for any of the names this one product has gone by. */
export function isPoundBag14x16Name(name: unknown): boolean {
  const text = String(name ?? "").toLowerCase();
  return /14\s?x\s?16/.test(text) || /\bqp\b/.test(text) || /quarter[\s-]*pound/.test(text) || /\bpound[\s-]*bag/.test(text) || /\bp[\s-]+bag\b/.test(text) || /large sticker bag/.test(text);
}
/**
 * Calculator URL flags that select this product. `ppoundbag=1` is canonical;
 * the others are accepted so an old / hand-written link still opens the same
 * product (they are rewritten to ppoundbag=1, never treated as a second product).
 */
export const POUND_BAG_URL_FLAG = "ppoundbag";
export const POUND_BAG_URL_FLAG_ALIASES = ["ppoundbag", "pqpbag", "ppbag", "pbag14x16", "pquarterpound"] as const;
/** Legacy blank picks that mean this product (the old "Pound bag" calculator preset). */
export const POUND_BAG_LEGACY_BLANK_IDS = ["preset:pound-bag", "type:bag-14x16"] as const;
export function poundBagFlagPosted(params: { get(name: string): unknown }): boolean {
  return POUND_BAG_URL_FLAG_ALIASES.some((flag) => String(params.get(flag) ?? "") === "1")
    || (POUND_BAG_LEGACY_BLANK_IDS as readonly string[]).includes(String(params.get("pblank") ?? ""));
}

export type BagLabelGeometry = {
  artboard: { readonly widthIn: number; readonly heightIn: number };
  cutline: { readonly widthIn: number; readonly heightIn: number };
  decision: string;
  displayName: string;
};

/** The label geometry for a bag product ("split_bag", "pound_bag_14x16" or any 4x5 bag product). */
export function bagLabelGeometryFor(product: string): BagLabelGeometry {
  if (product === "pound_bag_14x16") {
    return { artboard: POUND_BAG_14X16_ARTBOARD_IN, cutline: POUND_BAG_14X16_CUTLINE_IN, decision: POUND_BAG_14X16_GEOMETRY_DECISION, displayName: POUND_BAG_14X16_DISPLAY_NAME };
  }
  return product === "split_bag"
    ? { artboard: SPLIT_BAG_ARTBOARD_IN, cutline: SPLIT_BAG_CUTLINE_IN, decision: SPLIT_BAG_GEOMETRY_DECISION, displayName: "Split Bag" }
    : { artboard: BAG_4X5_ARTBOARD_IN, cutline: BAG_4X5_CUTLINE_IN, decision: BAG_4X5_CUTLINE_DECISION, displayName: "Standard 4x5 Sticker Bag" };
}

export const BAG_ARTBOARD_SOURCE = "bag-artboard-geometry.ts — 2D-2 owner 4x5 label artboard 4.00 x 5.00 in; owner 4x5 cutline 3.79 x 4.81 in (decision 2026-11-11)";
