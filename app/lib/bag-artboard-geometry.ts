// 4x5 sticker/stock bag ARTBOARD — extracted verbatim from
// bag-cost-inputs.server.ts (2D-2 owner standard) on 2026-10-05 so the
// product-spec layer can read it client-side. bag-cost-inputs.server.ts
// re-exports it; the cost path reads exactly this value. Pure data.

export const BAG_4X5_ARTBOARD_IN = { widthIn: 4.0, heightIn: 5.0 } as const;
export const BAG_ARTBOARD_SOURCE = "bag-cost-inputs.server.ts BAG_4X5_ARTBOARD_IN — 2D-2 owner standard 4x5 label artboard; cutline derived by gso-cutline.ts";
