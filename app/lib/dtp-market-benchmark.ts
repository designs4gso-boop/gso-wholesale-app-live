// DTP MARKET BENCHMARK OF RECORD — OWNER DECISION 2026-10-06.
//
// Classification: MARKET RESEARCH (owner-supplied published competitor
// pricing). These are COMPETITOR customer prices, never GSO costs; the
// competitor add-on percentages are never copied into GSO vendor costing.
//
// Design & Customize is the PRIMARY / CONTROLLING 1:1 competitive benchmark
// for DTP pricing until additional true 1:1 premium domestic competitors are
// verified. Other competitors remain research / reference only and never
// change GSO prices automatically. Client-safe: pure data.

export const DTP_MARKET_BENCHMARK_VERSION = "dtp-market-benchmark/2026-10-06";
export const DTP_MARKET_BENCHMARK_KEY = "DESIGN_AND_CUSTOMIZE_PRIMARY";

export const DESIGN_AND_CUSTOMIZE_BENCHMARK = {
  key: DTP_MARKET_BENCHMARK_KEY,
  competitor: "Design & Customize",
  status: "PRIMARY / CONTROLLING DTP COMPETITOR" as const,
  classification: "MARKET RESEARCH — owner-supplied published pricing (2026-10-06)" as const,
  size: "4x5 standard bag",
  /** Published base (Gloss or Matte) price per unit by quantity. */
  baseLadder: { 1000: 1.0, 1500: 0.8, 2500: 0.6, 5000: 0.4, 10000: 0.3 } as Record<number, number>,
  /** Published upgrade percentages on the base price (competitor pricing only — NOT GSO cost rules). */
  upgradesPct: { crZipper: 5, spotGloss: 5, holographic: 5, customShape: 10, insidePrint: 15, rushProduction: 20 } as const,
  note: "Market evidence only. Not a GSO cost. Add-on percentages are the competitor's customer pricing and are never applied to GSO vendor costing.",
};

export const DTP_MARKET_BENCHMARK_QUANTITIES = [1000, 1500, 2500, 5000, 10000] as const;

/**
 * Owner-supplied Design & Customize CUSTOM-SHAPE evidence (3.5 g, Gloss or
 * Matte) — MARKET EVIDENCE ONLY. Supports GSO shaped positioning (+10% on the
 * standard price, $700 die separately, MOQ 2,500); never copied as a GSO price.
 */
export const DESIGN_AND_CUSTOMIZE_SHAPED_EVIDENCE = {
  competitor: "Design & Customize",
  product: "3.5 g custom shape, Gloss or Matte",
  ladder: { 1250: 1.8, 1500: 1.55, 2000: 1.3, 2500: 1.2, 4000: 0.9 } as Record<number, number>,
  use: "Market evidence for shaped positioning only — do not copy these prices; GSO shaped = standard customer price x 1.10 + $700 per new die (separate).",
  classification: "MARKET RESEARCH — owner-supplied published pricing (2026-10-07)" as const,
};

/** GSO market position statement — wording approved 2026-10-06 (no thickness claim until documented). */
export const GSO_DTP_MARKET_POSITION = {
  label: "PREMIUM DOMESTIC DTP",
  wording: "premium / heavy-duty pouch positioning",
  prohibited: "Do not claim an exact thickness advantage (e.g. \"X mil thicker than competitor\") until documented.",
  intent: "Approved GSO pricing is intentionally modestly premium to Design & Customize.",
};

/** Highest published benchmark tier reached (step semantics, never interpolated). Null below 1,000 or above the published ladder where no tier is reached. */
export function benchmarkBaseUnit(quantity: number): { tierUsed: number | null; unit: number | null } {
  let tierUsed: number | null = null;
  for (const q of DTP_MARKET_BENCHMARK_QUANTITIES) if (quantity >= q) tierUsed = q;
  if (tierUsed == null) return { tierUsed: null, unit: null };
  return { tierUsed, unit: DESIGN_AND_CUSTOMIZE_BENCHMARK.baseLadder[tierUsed] ?? null };
}

/** Comparable CR-zipper reference = published base x (1 + 5%) — e.g. 1,000 = $1.05, 2,500 = $0.63, 5,000 = $0.42, 10,000 = $0.315. */
export function benchmarkComparableCrUnit(quantity: number): { tierUsed: number | null; baseUnit: number | null; comparableUnit: number | null } {
  const base = benchmarkBaseUnit(quantity);
  if (base.unit == null) return { tierUsed: base.tierUsed, baseUnit: null, comparableUnit: null };
  const comparableUnit = Math.round(base.unit * (1 + DESIGN_AND_CUSTOMIZE_BENCHMARK.upgradesPct.crZipper / 100) * 1e6) / 1e6;
  return { tierUsed: base.tierUsed, baseUnit: base.unit, comparableUnit };
}

export type DtpBenchmarkComparison = {
  benchmark: typeof DTP_MARKET_BENCHMARK_KEY;
  competitor: string;
  tierUsed: number | null;
  competitorBaseUnit: number | null;
  competitorComparableUnit: number | null;
  gsoUnit: number | null;
  /** GSO price relative to the comparable CR reference, in percent (positive = GSO premium). */
  premiumPct: number | null;
  position: string;
};

/** Compares a GSO unit price to the comparable CR reference. Information only — never changes a GSO price. */
export function compareToBenchmark(gsoUnit: number | null, quantity: number): DtpBenchmarkComparison {
  const ref = benchmarkComparableCrUnit(quantity);
  const premiumPct = gsoUnit != null && ref.comparableUnit != null && ref.comparableUnit > 0
    ? Math.round(((gsoUnit - ref.comparableUnit) / ref.comparableUnit) * 1000) / 10
    : null;
  return {
    benchmark: DTP_MARKET_BENCHMARK_KEY,
    competitor: DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor,
    tierUsed: ref.tierUsed,
    competitorBaseUnit: ref.baseUnit,
    competitorComparableUnit: ref.comparableUnit,
    gsoUnit,
    premiumPct,
    position: `${GSO_DTP_MARKET_POSITION.label} — ${GSO_DTP_MARKET_POSITION.wording}`,
  };
}
