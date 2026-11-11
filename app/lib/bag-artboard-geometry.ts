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
 * Used by every 4x5 position: 4x5 Sticker Bags, Stock Bags and both
 * positions on each side of a Split Bag.
 */
export const BAG_4X5_CUTLINE_IN = { widthIn: 3.79, heightIn: 4.81 } as const;
export const BAG_4X5_CUTLINE_DECISION = "Owner decision 2026-11-11: 4x5 actual cutline 3.79 x 4.81 in (documented owner standard; supersedes the undocumented 3.875 x 4.875 derived value).";
export const BAG_ARTBOARD_SOURCE = "bag-artboard-geometry.ts — 2D-2 owner 4x5 label artboard 4.00 x 5.00 in; owner 4x5 cutline 3.79 x 4.81 in (decision 2026-11-11)";
