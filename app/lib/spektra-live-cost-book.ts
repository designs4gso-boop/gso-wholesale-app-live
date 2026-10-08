// SPEKTRA / FLEX PACKAGING LIVE VENDOR COST BOOK (versioned, 2026-10-06).
//
// ONE place for current Spektra vendor pricing in the ERP:
//   * the current public catalog (sizes, materials, finishes, spot, zipper,
//     top features, clear gusset, published tiers) — VENDOR OBSERVED DATA
//   * the GSO account discount rule — OWNER-CONFIRMED (25 % off the EXACT
//     public order total, never off the rounded displayed unit price)
//   * the validated extra-SKU rule — VENDOR OBSERVED DATA
//   * a deterministic lookup over the generated observed-row artifact
//     (app/lib/generated/...). Exact row -> OBSERVED VENDOR PRICE; 1-SKU row +
//     validated SKU arithmetic -> ESTIMATED FROM VALIDATED VENDOR RULE; nothing
//     else -> REQUEST CURRENT VENDOR QUOTE. No interpolation, no invented
//     continuous price equation.
//
// FREIGHT IS UNVERIFIED. The public site exposes no usable freight; the
// historical $85/PO figure stays wherever the runtime already uses it, but it
// is NOT part of this cost book and is labelled as an assumption.
//
// Client-safe: pure data + pure functions.

import {
  SPEKTRA_MATRIX_GENERATED_AT,
  SPEKTRA_MATRIX_ROW_COUNT,
  SPEKTRA_MATRIX_SOURCE_FILE,
  SPEKTRA_MATRIX_SOURCE_PRESENT,
  SPEKTRA_OBSERVED_ROWS,
  type SpektraObservedRow,
} from "./generated/spektra-live-price-matrix-2026-10-06";
export { SPEKTRA_OBSERVED_ROWS, type SpektraObservedRow };

export const SPEKTRA_COST_BOOK_VERSION = "spektra-live-cost-book/2026-10-06";
export const SPEKTRA_ACCOUNT_DISCOUNT_PCT = 25;
export const SPEKTRA_ACCOUNT_DISCOUNT_FACTOR = 0.75;
export const SPEKTRA_PUBLIC_EXTRA_SKU_FEE = 185;
export const SPEKTRA_WHOLESALE_EXTRA_SKU_FEE = 138.75; // 185 x 0.75, validated at 1 / 2 / 5 / 10 SKUs
export const SPEKTRA_PUBLISHED_TIERS = [500, 1000, 2500, 5000, 10000, 25000] as const;
/** Custom quantities the research tested directly (usable only where an exact row exists). */
export const SPEKTRA_RESEARCH_TESTED_CUSTOM_QUANTITIES = [550, 999, 1100, 1200, 7500] as const;

export const SPEKTRA_COST_BOOK_META = {
  version: SPEKTRA_COST_BOOK_VERSION,
  vendor: "Flex Packaging / Spektra",
  source: "Flex Packaging / Spektra public calculator",
  sourceDate: "2026-10-06",
  sourceFile: SPEKTRA_MATRIX_SOURCE_FILE,
  researchFilePresent: SPEKTRA_MATRIX_SOURCE_PRESENT,
  rowCount: SPEKTRA_MATRIX_ROW_COUNT,
  generatedAt: SPEKTRA_MATRIX_GENERATED_AT,
  discount: { pct: SPEKTRA_ACCOUNT_DISCOUNT_PCT, status: "OWNER_CONFIRMED_ACCOUNT_DISCOUNT" as const, rule: "wholesale total = EXACT public order total x 0.75; wholesale unit = discounted total / delivered quantity" },
  vendorProductPricing: "LIVE_RESEARCH_2026_10_06" as const,
  freight: { status: "UNVERIFIED" as const, note: "The public site exposes no usable freight. The historical $85 per purchase order is an UNVERIFIED assumption kept only where the runtime already applies it." },
  moq: { published: "500 minimum run, per SKU (website)", status: "NOT_FULLY_RESOLVED" as const, note: "The calculator prices lower test quantities; GSO's owner-approved DTP MOQ (1,000) is retained until the owner changes it." },
  includedInPublicPrice: ["setup", "prepress", "plates", "run charges"],
  dieCut: { publicStatus: "COMING SOON" as const, note: "No public die-cut calculator exists; shaped-bag pricing is an owner-approved GSO commercial rule, never a public Spektra price." },
} as const;

/* ------------------------------------------------------------------ *
 * Current catalog (VENDOR OBSERVED DATA)
 * ------------------------------------------------------------------ */
export type SpektraSizeKey = "3.5x4.5x2" | "4x5x2" | "5x5x2" | "6x5x2" | "8x5x2";
export const SPEKTRA_SIZES: Array<{ key: SpektraSizeKey; label: string; capacityLabel: string; gussetIn: number }> = [
  { key: "3.5x4.5x2", label: "3.5 x 4.5 x 2", capacityLabel: "1 g", gussetIn: 2 },
  { key: "4x5x2", label: "4 x 5 x 2", capacityLabel: "3.5 g", gussetIn: 2 },
  { key: "5x5x2", label: "5 x 5 x 2", capacityLabel: "7 g", gussetIn: 2 },
  { key: "6x5x2", label: "6 x 5 x 2", capacityLabel: "14 g", gussetIn: 2 },
  { key: "8x5x2", label: "8 x 5 x 2", capacityLabel: "28 g", gussetIn: 2 },
];
export const SPEKTRA_MATERIALS = ["White PET", "Silver PET", "Hologram", "Clear PET"] as const;
export const SPEKTRA_FINISHES = ["Soft Touch", "Matte", "Glossy"] as const;
export const SPEKTRA_SPOT_OPTIONS = ["None", "Standard", "Raised UV"] as const;
export const SPEKTRA_ZIPPER_OPTIONS = ["None", "10 mm", "Child Resistant"] as const;
export const SPEKTRA_TOP_FEATURES = ["No Tear Notch", "Punch Hole", "Sombrero"] as const;

export type SpektraMaterial = (typeof SPEKTRA_MATERIALS)[number];
export type SpektraFinish = (typeof SPEKTRA_FINISHES)[number];
export type SpektraSpot = (typeof SPEKTRA_SPOT_OPTIONS)[number];
export type SpektraZipper = (typeof SPEKTRA_ZIPPER_OPTIONS)[number];
export type SpektraTopFeature = (typeof SPEKTRA_TOP_FEATURES)[number];

export type SpektraConfiguration = {
  size: SpektraSizeKey;
  material: SpektraMaterial;
  finish: SpektraFinish;
  spot: SpektraSpot;
  zipper: SpektraZipper;
  topFeature: SpektraTopFeature;
  clearGusset: boolean;
};

/** Glossy laminate does not allow Standard or Raised UV spot gloss. */
export function spotAllowedForFinish(finish: SpektraFinish, spot: SpektraSpot): boolean {
  if (spot === "None") return true;
  return finish !== "Glossy";
}

export function validateSpektraConfiguration(c: Partial<SpektraConfiguration>): { ok: true; config: SpektraConfiguration } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!SPEKTRA_SIZES.some((s) => s.key === c.size)) errors.push(`size "${String(c.size)}" is not in the current Spektra catalog`);
  if (!SPEKTRA_MATERIALS.includes(c.material as SpektraMaterial)) errors.push(`material "${String(c.material)}" is not a current Spektra material`);
  if (!SPEKTRA_FINISHES.includes(c.finish as SpektraFinish)) errors.push(`finish "${String(c.finish)}" is not a current Spektra finish`);
  if (!SPEKTRA_SPOT_OPTIONS.includes(c.spot as SpektraSpot)) errors.push(`spot gloss "${String(c.spot)}" is not a current option`);
  if (!SPEKTRA_ZIPPER_OPTIONS.includes(c.zipper as SpektraZipper)) errors.push(`zipper "${String(c.zipper)}" is not a current option`);
  if (!SPEKTRA_TOP_FEATURES.includes(c.topFeature as SpektraTopFeature)) errors.push(`top feature "${String(c.topFeature)}" is not a current option`);
  if (!errors.length && !spotAllowedForFinish(c.finish as SpektraFinish, c.spot as SpektraSpot)) errors.push(`${c.spot} spot gloss is not available on the Glossy laminate`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { size: c.size!, material: c.material!, finish: c.finish!, spot: c.spot!, zipper: c.zipper!, topFeature: c.topFeature!, clearGusset: Boolean(c.clearGusset) } };
}

/* ------------------------------------------------------------------ *
 * Owner-confirmed discount rule + validated SKU rule
 * ------------------------------------------------------------------ */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Wholesale total from the EXACT public order total (never from the rounded
 * displayed unit). NO intermediate cent rounding — the research keeps
 * fractional cents (e.g. $913.10 x 0.75 = $684.825) and so does this book.
 */
export function wholesaleTotalFromPublicTotal(publicTotal: number): number {
  return Number(publicTotal) * SPEKTRA_ACCOUNT_DISCOUNT_FACTOR;
}

export function wholesaleUnitCost(publicTotal: number, deliveredQuantity: number): number {
  const qty = Math.floor(Number(deliveredQuantity) || 0);
  if (!(qty > 0)) return 0;
  return wholesaleTotalFromPublicTotal(publicTotal) / qty;
}

/** Validated public rule: total(n SKUs) = total(1 SKU) + 185 x (n - 1). The quantity tier is the TOTAL order quantity. */
export function publicTotalForSkuCount(oneSkuPublicTotal: number, skuCount: number): number {
  const n = Math.max(1, Math.floor(Number(skuCount) || 1));
  return Number(oneSkuPublicTotal) + SPEKTRA_PUBLIC_EXTRA_SKU_FEE * (n - 1);
}

export function wholesaleExtraSkuCost(skuCount: number): number {
  const n = Math.max(1, Math.floor(Number(skuCount) || 1));
  return money(SPEKTRA_WHOLESALE_EXTRA_SKU_FEE * (n - 1));
}

/* ------------------------------------------------------------------ *
 * Lookup (fails closed)
 * ------------------------------------------------------------------ */
export type SpektraCostStatus = "OBSERVED_VENDOR_PRICE" | "ESTIMATED_FROM_VALIDATED_VENDOR_RULE" | "REQUEST_CURRENT_VENDOR_QUOTE";
export const SPEKTRA_COST_STATUS_LABEL: Record<SpektraCostStatus, string> = {
  OBSERVED_VENDOR_PRICE: "OBSERVED VENDOR PRICE",
  ESTIMATED_FROM_VALIDATED_VENDOR_RULE: "ESTIMATED FROM VALIDATED VENDOR RULE",
  REQUEST_CURRENT_VENDOR_QUOTE: "REQUEST CURRENT VENDOR QUOTE",
};

export type SpektraCostLookup = {
  status: SpektraCostStatus;
  config: SpektraConfiguration | null;
  quantity: number;
  skuCount: number;
  publicTotal: number | null;
  wholesaleTotal: number | null;
  wholesaleUnit: number | null;
  /** Portion of the wholesale total attributable to extra SKUs (138.75 each). */
  wholesaleExtraSkuCost: number;
  basis: string;
  observedRow: SpektraObservedRow | null;
  version: string;
  sourceDate: string;
  freightStatus: "UNVERIFIED";
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function findRow(rows: SpektraObservedRow[], c: SpektraConfiguration, quantity: number, skuCount: number): SpektraObservedRow | null {
  return rows.find((r) => same(r.size, c.size) && same(r.material, c.material) && same(r.finish, c.finish) && same(r.spot, c.spot) && same(r.zipper, c.zipper) && same(r.topFeature, c.topFeature) && Boolean(r.clearGusset) === c.clearGusset && r.quantity === quantity && r.skuCount === skuCount) ?? null;
}

export function lookupSpektraVendorCost(
  input: Partial<SpektraConfiguration> & { quantity: number; skuCount?: number },
  rows: SpektraObservedRow[] = SPEKTRA_OBSERVED_ROWS,
): SpektraCostLookup {
  const quantity = Math.floor(Number(input.quantity) || 0);
  const skuCount = Math.max(1, Math.floor(Number(input.skuCount) || 1));
  const base = { quantity, skuCount, wholesaleExtraSkuCost: wholesaleExtraSkuCost(skuCount), version: SPEKTRA_COST_BOOK_VERSION, sourceDate: SPEKTRA_COST_BOOK_META.sourceDate, freightStatus: "UNVERIFIED" as const };
  const validated = validateSpektraConfiguration(input);
  if (!validated.ok) {
    return { ...base, status: "REQUEST_CURRENT_VENDOR_QUOTE", config: null, publicTotal: null, wholesaleTotal: null, wholesaleUnit: null, basis: `Unsupported configuration: ${validated.errors.join("; ")}.`, observedRow: null };
  }
  const config = validated.config;
  if (!(quantity > 0)) {
    return { ...base, status: "REQUEST_CURRENT_VENDOR_QUOTE", config, publicTotal: null, wholesaleTotal: null, wholesaleUnit: null, basis: "Quantity required.", observedRow: null };
  }
  if (!rows.length) {
    return { ...base, status: "REQUEST_CURRENT_VENDOR_QUOTE", config, publicTotal: null, wholesaleTotal: null, wholesaleUnit: null, basis: `No observed Spektra rows are loaded (research matrix ${SPEKTRA_MATRIX_SOURCE_PRESENT ? "loaded but empty" : "NOT PRESENT"}; run tools/generate-spektra-cost-book.mjs after committing ${SPEKTRA_MATRIX_SOURCE_FILE}).`, observedRow: null };
  }
  const exact = findRow(rows, config, quantity, skuCount);
  if (exact) {
    const wholesaleTotal = wholesaleTotalFromPublicTotal(exact.publicTotal);
    return { ...base, status: "OBSERVED_VENDOR_PRICE", config, publicTotal: exact.publicTotal, wholesaleTotal, wholesaleUnit: wholesaleTotal / quantity, basis: `Observed ${exact.observedAt}: public total $${exact.publicTotal.toFixed(2)} x 0.75.`, observedRow: exact };
  }
  const oneSku = skuCount > 1 ? findRow(rows, config, quantity, 1) : null;
  if (oneSku) {
    const publicTotal = publicTotalForSkuCount(oneSku.publicTotal, skuCount);
    const wholesaleTotal = wholesaleTotalFromPublicTotal(publicTotal);
    return { ...base, status: "ESTIMATED_FROM_VALIDATED_VENDOR_RULE", config, publicTotal, wholesaleTotal, wholesaleUnit: wholesaleTotal / quantity, basis: `1-SKU row observed ${oneSku.observedAt} ($${oneSku.publicTotal.toFixed(2)}) + $${SPEKTRA_PUBLIC_EXTRA_SKU_FEE} x ${skuCount - 1} extra SKU(s), then x 0.75.`, observedRow: oneSku };
  }
  const tierNote = (SPEKTRA_PUBLISHED_TIERS as readonly number[]).includes(quantity)
    ? "published tier, but no observed row for this exact configuration"
    : (SPEKTRA_RESEARCH_TESTED_CUSTOM_QUANTITIES as readonly number[]).includes(quantity)
      ? "research-tested custom quantity, but no observed row for this exact configuration"
      : "custom quantity with no observed row (no interpolation is performed)";
  return { ...base, status: "REQUEST_CURRENT_VENDOR_QUOTE", config, publicTotal: null, wholesaleTotal: null, wholesaleUnit: null, basis: `No observed Spektra row: ${tierNote}.`, observedRow: null };
}

/** Distinct configuration coverage of the loaded matrix — for the Vendor Cost Book summary. */
export function spektraMatrixSummary(rows: SpektraObservedRow[] = SPEKTRA_OBSERVED_ROWS) {
  const by = (key: keyof SpektraObservedRow) => Array.from(new Set(rows.map((r) => String(r[key])))).sort();
  return {
    rowCount: rows.length,
    sizes: by("size"), materials: by("material"), finishes: by("finish"), spots: by("spot"), zippers: by("zipper"), topFeatures: by("topFeature"),
    quantities: Array.from(new Set(rows.map((r) => r.quantity))).sort((a, b) => a - b),
    skuCounts: Array.from(new Set(rows.map((r) => r.skuCount))).sort((a, b) => a - b),
  };
}
