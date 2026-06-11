export const PRODUCT_TYPE = "stock_bag_4x5";
export const PRODUCT_TYPE_LABEL = "4x5 Stock Bag";
export const MIN_QTY = 64;

export const PILOT_PRODUCTS = [
  "Ritz Vanilla Cupcake",
  "Bubble Tape Lemonade Lightning",
  "Trolli Worms Pineapple Pop",
  "Bubble Tape Blue Raspberry",
  "Ritz Orange Creamsicle",
];

export const MATERIALS = ["Matte", "Holographic"];

export const FINISHES = [
  "No Spot Gloss",
  "1X Spot Gloss",
  "2X Spot Gloss",
  "3X Spot Gloss",
  "4X Spot Gloss",
];

export const BAG_COLORS = [
  "White",
  "Blue",
  "Red",
  "Pink",
  "Orange",
  "Green",
  "Gold-Holo",
  "Silver-Holo",
  "Purple-Holo",
  "Teal",
  "Black",
  "Light Pink",
  "Light Purple",
  "Clear",
];

export type QtyRange = {
  label: string;
  min: number;
  max: number | null;
};

export const QTY_RANGES: QtyRange[] = [
  { label: "64-256", min: 64, max: 256 },
  { label: "257-640", min: 257, max: 640 },
  { label: "641-1280", min: 641, max: 1280 },
  { label: "1281-1920", min: 1281, max: 1920 },
  { label: "1921-2560+", min: 1921, max: null },
];

export type FallbackPricingRow = {
  material: string;
  finish: string;
  productionFinish: string;
  costEach: number;
  prices: number[];
};

export const FALLBACK_PRICING_ROWS: FallbackPricingRow[] = [
  {
    material: "Matte",
    finish: "No Spot Gloss",
    productionFinish: "Matte",
    costEach: 0.60,
    prices: [1.80, 1.65, 1.50, 1.35, 1.25],
  },
  {
    material: "Matte",
    finish: "1X Spot Gloss",
    productionFinish: "Matte + 1X Spot Gloss",
    costEach: 0.75,
    prices: [2.25, 2.05, 1.90, 1.75, 1.60],
  },
  {
    material: "Matte",
    finish: "2X Spot Gloss",
    productionFinish: "Matte + 2X Spot Gloss",
    costEach: 0.90,
    prices: [2.40, 2.20, 2.05, 1.90, 1.75],
  },
  {
    material: "Matte",
    finish: "3X Spot Gloss",
    productionFinish: "Matte + 3X Spot Gloss",
    costEach: 1.02,
    prices: [2.55, 2.35, 2.15, 1.95, 1.85],
  },
  {
    material: "Matte",
    finish: "4X Spot Gloss",
    productionFinish: "Matte + 4X Spot Gloss",
    costEach: 1.21,
    prices: [2.85, 2.65, 2.45, 2.25, 2.05],
  },
  {
    material: "Holographic",
    finish: "No Spot Gloss",
    productionFinish: "Holographic Vinyl + CMYK + White",
    costEach: 0.88,
    prices: [1.75, 1.65, 1.55, 1.45, 1.35],
  },
  {
    material: "Holographic",
    finish: "1X Spot Gloss",
    productionFinish: "Holo + White + 1X Spot Gloss",
    costEach: 1.03,
    prices: [2.05, 1.95, 1.85, 1.75, 1.65],
  },
  {
    material: "Holographic",
    finish: "2X Spot Gloss",
    productionFinish: "Holo + White + 2X Spot Gloss",
    costEach: 1.03,
    prices: [2.30, 2.20, 2.10, 2.00, 1.90],
  },
  {
    material: "Holographic",
    finish: "3X Spot Gloss",
    productionFinish: "Holo + White + 3X Spot Gloss",
    costEach: 1.18,
    prices: [2.40, 2.30, 2.20, 2.10, 2.00],
  },
  {
    material: "Holographic",
    finish: "4X Spot Gloss",
    productionFinish: "Holo + White + 4X Spot Gloss",
    costEach: 1.18,
    prices: [2.80, 2.60, 2.40, 2.20, 2.05],
  },
];

export function rangeLabelFromRule(rule: { minQty: number; maxQty: number | null }) {
  const matchedRange = QTY_RANGES.find((range) => range.min === rule.minQty && range.max === rule.maxQty);
  if (matchedRange) return matchedRange.label;
  return rule.maxQty ? `${rule.minQty}-${rule.maxQty}` : `${rule.minQty}+`;
}

export function matrixPrice(row: any, range: QtyRange) {
  const fallbackLabel = range.max ? `${range.min}-${range.max}` : `${range.min}+`;
  const openEndedLabel = `${range.min}+`;

  if (row.prices[range.label] !== undefined && row.prices[range.label] !== null) {
    return row.prices[range.label];
  }

  if (row.prices[fallbackLabel] !== undefined && row.prices[fallbackLabel] !== null) {
    return row.prices[fallbackLabel];
  }

  if (row.prices[openEndedLabel] !== undefined && row.prices[openEndedLabel] !== null) {
    return row.prices[openEndedLabel];
  }

  return null;
}

