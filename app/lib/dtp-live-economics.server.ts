// DTP (Spektra) LIVE ECONOMICS — analysis layer (2026-10-06).
//
// Combines, per current catalog size and published tier:
//   * CURRENT vendor cost from the live cost book (VENDOR OBSERVED DATA,
//     25 % off the exact public total)
//   * OLD vendor cost from the legacy 15C seed (documented reference only;
//     old material / finish / zipper / feature / SKU / freight scope was not
//     preserved, so deltas are scenarios, not proven like-for-like savings)
//   * the $85/PO freight assumption (UNVERIFIED) and GSO internal art
//   * the CURRENT owner sell ladder (dtp-owner-pricing.server.ts) with GM / GP
//   * for ladders still OWNER PRICING REVIEW REQUIRED: PROPOSAL options computed
//     from existing approved DTP policy (hard floors 30/35/38 %, $500 minimum
//     job profit, 40 % warning target). Proposals for the owner only; the live
//     ladders are NOT changed by this module. The OWNER-APPROVED 4x5x2 ladder
//     (2026-10-06) shows no proposals — it is decided.
//
// Market reference (2026-10-06): Design & Customize is the PRIMARY /
// CONTROLLING 1:1 DTP benchmark (dtp-market-benchmark.ts); each cell carries
// the comparable CR reference and the GSO premium %. Other competitors are
// reference only. Server-only because it reads the owner ladders.

import { DTP_CATALOG, DTP_COMPARABLE_CONFIG } from "./dtp-catalog";
export { DTP_COMPARABLE_CONFIG };
import { DESIGN_AND_CUSTOMIZE_BENCHMARK, DTP_MARKET_BENCHMARK_KEY, GSO_DTP_MARKET_POSITION, compareToBenchmark, type DtpBenchmarkComparison } from "./dtp-market-benchmark";
import { DTP_ACQUISITION_TIER_EXCEPTIONS, DTP_HARD_FLOOR_BANDS, DTP_INTERNAL_ART_COST_PER_DESIGN, DTP_LADDER_SOURCES, DTP_MARGIN_WARNING_TARGET_PCT, DTP_MIN_JOB_PROFIT, DTP_OWNER_PRICE_LADDERS, DTP_OWNER_REVIEW_REQUIRED, dtpAcquisitionTierException, dtpHardFloorPct, ownerPriceForQuantity } from "./dtp-owner-pricing.server";
import { SPEKTRA_FREIGHT_PER_PO } from "./product-driven-costing.server";
import { SPEKTRA_COST_BOOK_META, SPEKTRA_PUBLISHED_TIERS, lookupSpektraVendorCost, type SpektraFinish, type SpektraSizeKey } from "./spektra-live-cost-book";

export const DTP_LIVE_ECONOMICS_VERSION = "dtp-live-economics/2026-10-06";


/** Legacy 15C vendor seed (tools/seed-spektra-dtp.mjs) — REFERENCE ONLY for the comparison; the DB rows stay the historical authority. */
export const LEGACY_SEED_VENDOR_UNIT: Record<string, Record<number, number>> = {
  "4x5x2": { 1000: 0.9897, 2500: 0.4922, 5000: 0.4033, 7500: 0.3232 },
  "5x4x2": { 1000: 1.0504, 2500: 0.5419, 5000: 0.4697, 7500: 0.3818 },
  "6x5x2": { 1000: 1.1048, 2500: 0.5864, 5000: 0.529, 7500: 0.4341 },
  "8x5x2": { 1000: 1.2418, 2500: 0.6991, 5000: 0.6799, 7500: 0.5674 },
};
export function legacySeedUnit(size: string, quantity: number): number | null {
  const ladder = LEGACY_SEED_VENDOR_UNIT[size];
  if (!ladder) return null;
  let used: number | null = null;
  for (const q of [1000, 2500, 5000, 7500]) if (quantity >= q) used = q;
  return used == null ? null : ladder[used];
}

export type DtpEconomicsCell = {
  size: string;
  quantity: number;
  finish: SpektraFinish;
  vendorStatus: string;
  vendorUnit: number | null;
  vendorTotal: number | null;
  extraSkuCost: number;
  artCost: number;
  freightAssumption: number;
  freightStatus: "UNVERIFIED";
  landedTotal: number | null;
  landedUnit: number | null;
  oldVendorUnit: number | null;
  oldVendorChangePct: number | null;
  currentSellUnit: number | null;
  currentSellTierUsed: number | null;
  currentGmPct: number | null;
  currentGp: number | null;
  hardFloorPct: number;
  /** Job-profit target for this cell ($350 on the 4x5x2 1,000 acquisition tier, else $500). */
  minJobProfit: number;
  meetsProtection: boolean | null;
  /** OWNER_APPROVED (4x5x2, 2026-10-06) / OWNER_PRICING_REVIEW_REQUIRED (2026-07-24 ladders, new sizes, 4x5x2 at 25,000). */
  ladderStatus: "OWNER_APPROVED" | "OWNER_PRICING_REVIEW_REQUIRED";
  ladderNote: string;
  pricingSource: string | null;
  proposals: Array<{ key: "hold_price" | "hold_margin" | "split"; label: string; sellUnit: number; sellTotal: number; gmPct: number; gp: number; meetsFloor: boolean; meetsMinProfit: boolean }>;
  marketReference: string;
  benchmark: DtpBenchmarkComparison;
};

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function dtpEconomicsCell(size: SpektraSizeKey, quantity: number, finish: SpektraFinish = DTP_COMPARABLE_CONFIG.finish, designs = 1): DtpEconomicsCell {
  const look = lookupSpektraVendorCost({ size, material: DTP_COMPARABLE_CONFIG.material, finish, spot: DTP_COMPARABLE_CONFIG.spot, zipper: DTP_COMPARABLE_CONFIG.zipper, topFeature: DTP_COMPARABLE_CONFIG.topFeature, clearGusset: false, quantity, skuCount: Math.max(1, designs) });
  const artCost = DTP_INTERNAL_ART_COST_PER_DESIGN * Math.max(1, designs);
  const freightAssumption = SPEKTRA_FREIGHT_PER_PO;
  const landedTotal = look.wholesaleTotal != null ? look.wholesaleTotal + artCost + freightAssumption : null;
  const landedUnit = landedTotal != null ? landedTotal / quantity : null;
  const entry = DTP_CATALOG.find((e) => e.size === size);
  const ladder = entry?.vendorSku ? ownerPriceForQuantity(entry.vendorSku, quantity) : { tierUsed: null, unitPrice: null, reviewRequired: undefined };
  const source = entry?.vendorSku ? DTP_LADDER_SOURCES[entry.vendorSku] ?? null : null;
  const approved = source?.status === "OWNER_APPROVED" && ladder.unitPrice != null;
  const ladderStatus: DtpEconomicsCell["ladderStatus"] = approved ? "OWNER_APPROVED" : "OWNER_PRICING_REVIEW_REQUIRED";
  const ladderNote = approved
    ? `${source!.pricingSource} (approved ${source!.approvedOn})`
    : ladder.reviewRequired ?? (source ? `${DTP_OWNER_REVIEW_REQUIRED} — ${source.note}` : `${DTP_OWNER_REVIEW_REQUIRED} — no owner ladder for ${size}`);
  const exception = entry?.vendorSku ? dtpAcquisitionTierException(entry.vendorSku, ladder.tierUsed) : null;
  const minJobProfit = exception ? exception.minJobProfit : DTP_MIN_JOB_PROFIT;
  const currentSellUnit = ladder.unitPrice;
  const currentTotal = currentSellUnit != null ? currentSellUnit * quantity : null;
  const currentGp = currentTotal != null && landedTotal != null ? currentTotal - landedTotal : null;
  const currentGmPct = currentTotal != null && currentGp != null && currentTotal > 0 ? (currentGp / currentTotal) * 100 : null;
  const oldVendorUnit = legacySeedUnit(size, quantity);
  const hardFloorPct = dtpHardFloorPct(quantity);
  const proposals: DtpEconomicsCell["proposals"] = [];
  // Proposals only for ladders that are still under review — an OWNER-APPROVED
  // ladder is decided and is never re-proposed through a generic margin curve.
  if (!approved && landedTotal != null && landedUnit != null) {
    const mk = (key: DtpEconomicsCell["proposals"][number]["key"], label: string, sellUnit: number) => {
      const sellTotal = sellUnit * quantity;
      const gp = sellTotal - landedTotal;
      const gmPct = sellTotal > 0 ? (gp / sellTotal) * 100 : 0;
      return { key, label, sellUnit: round(sellUnit), sellTotal: round(sellTotal, 2), gmPct: round(gmPct, 1), gp: round(gp, 2), meetsFloor: gmPct >= hardFloorPct - 1e-9, meetsMinProfit: gp >= DTP_MIN_JOB_PROFIT - 1e-9 };
    };
    if (currentSellUnit != null) {
      proposals.push(mk("hold_price", "A — hold current customer price (margin rises)", currentSellUnit));
      // B — pass the vendor change through: keep the margin % the current ladder earned on the OLD landed cost
      const oldUnit = oldVendorUnit;
      if (oldUnit != null) {
        const oldLanded = oldUnit * quantity + artCost + freightAssumption;
        const oldGm = currentTotal! > 0 ? (currentTotal! - oldLanded) / currentTotal! : 0;
        if (oldGm > 0 && oldGm < 0.95) {
          const passThroughUnit = landedUnit / (1 - oldGm);
          proposals.push(mk("hold_margin", `B — pass the vendor change through (hold the ${round(oldGm * 100, 1)}% margin the ladder earned on the old cost)`, passThroughUnit));
          proposals.push(mk("split", "C — split the improvement (midpoint of A and B)", (currentSellUnit + passThroughUnit) / 2));
        }
      }
    } else {
      // no owner ladder (new sizes): show the floor-based minimum and the 40 % target as the only policy-derived anchors
      proposals.push(mk("hold_margin", `floor — minimum at the ${hardFloorPct}% DTP hard floor`, landedUnit / (1 - hardFloorPct / 100)));
      proposals.push(mk("split", `target — ${DTP_MARGIN_WARNING_TARGET_PCT}% warning target`, landedUnit / (1 - DTP_MARGIN_WARNING_TARGET_PCT / 100)));
    }
  }
  return {
    size, quantity, finish,
    vendorStatus: look.status, vendorUnit: look.wholesaleUnit != null ? round(look.wholesaleUnit, 6) : null, vendorTotal: look.wholesaleTotal != null ? round(look.wholesaleTotal, 2) : null,
    extraSkuCost: look.wholesaleExtraSkuCost, artCost: round(artCost, 4), freightAssumption, freightStatus: "UNVERIFIED",
    landedTotal: landedTotal != null ? round(landedTotal, 2) : null, landedUnit: landedUnit != null ? round(landedUnit, 6) : null,
    oldVendorUnit, oldVendorChangePct: oldVendorUnit != null && look.wholesaleUnit != null ? round(((look.wholesaleUnit - oldVendorUnit) / oldVendorUnit) * 100, 2) : null,
    currentSellUnit, currentSellTierUsed: ladder.tierUsed, currentGmPct: currentGmPct != null ? round(currentGmPct, 1) : null, currentGp: currentGp != null ? round(currentGp, 2) : null,
    hardFloorPct, minJobProfit,
    meetsProtection: currentGmPct != null && currentGp != null ? currentGmPct >= hardFloorPct - 1e-9 && currentGp >= minJobProfit - 1e-9 : null,
    ladderStatus, ladderNote, pricingSource: source?.pricingSource ?? null,
    proposals,
    marketReference: size === "4x5x2"
      ? `${DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} — ${DESIGN_AND_CUSTOMIZE_BENCHMARK.status} (${DTP_MARKET_BENCHMARK_KEY})`
      : `${DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} is the DTP benchmark of record; no published ${size} competitor price is on file`,
    benchmark: compareToBenchmark(size === "4x5x2" ? currentSellUnit : null, quantity),
  };
}

export function buildDtpLiveEconomics(finish: SpektraFinish = DTP_COMPARABLE_CONFIG.finish) {
  const sizes = DTP_CATALOG.filter((e) => e.status === "CURRENT_STANDARD").map((e) => e.size as SpektraSizeKey);
  const cells = sizes.flatMap((size) => SPEKTRA_PUBLISHED_TIERS.map((q) => dtpEconomicsCell(size, q, finish)));
  return {
    version: DTP_LIVE_ECONOMICS_VERSION,
    costSourceDate: SPEKTRA_COST_BOOK_META.sourceDate,
    comparableConfig: { ...DTP_COMPARABLE_CONFIG, finish },
    freightNote: "Freight $85 per PO is an UNVERIFIED assumption included in landed cost for comparability only.",
    policy: { hardFloorBands: DTP_HARD_FLOOR_BANDS, minJobProfit: DTP_MIN_JOB_PROFIT, warningTargetPct: DTP_MARGIN_WARNING_TARGET_PCT, ladders: DTP_OWNER_PRICE_LADDERS, ladderSources: DTP_LADDER_SOURCES, acquisitionTierExceptions: DTP_ACQUISITION_TIER_EXCEPTIONS },
    market: { benchmark: DESIGN_AND_CUSTOMIZE_BENCHMARK, position: GSO_DTP_MARKET_POSITION },
    cells,
  };
}

/** Markdown for docs/generated — written by the test suite. */
export function dtpLiveEconomicsMarkdown(finish: SpektraFinish = DTP_COMPARABLE_CONFIG.finish): string {
  const data = buildDtpLiveEconomics(finish);
  const money = (n: number | null, d = 4) => (n == null ? "—" : `$${n.toFixed(d)}`);
  const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
  const lines = [
    `# DTP live economics — ${data.comparableConfig.material} / ${finish} / no spot / ${data.comparableConfig.zipper} / ${data.comparableConfig.topFeature} / 1 SKU (generated ${data.costSourceDate})`,
    "",
    `Vendor: live Spektra cost book (public total x 0.75). Landed = vendor + GSO art $${DTP_INTERNAL_ART_COST_PER_DESIGN.toFixed(4)} (1 design) + freight $${SPEKTRA_FREIGHT_PER_PO} (UNVERIFIED). Current sell: 4x5x2 = OWNER-APPROVED ladder 2026-10-06 ($1.30 / $0.71 / $0.46 / $0.37; 25,000 = OWNER PRICING REVIEW REQUIRED; 1,000 = acquisition tier, $350+ GP); other sizes = 2026-07-24 ladder where one exists, flagged OWNER PRICING REVIEW REQUIRED (highest tier reached; none below 1,000). Market: ${DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} = ${DESIGN_AND_CUSTOMIZE_BENCHMARK.status}; D&C comparable = published Gloss/Matte base + 5% CR zipper (market evidence, not a GSO cost). GSO position: ${GSO_DTP_MARKET_POSITION.label} (${GSO_DTP_MARKET_POSITION.wording}). Proposals appear only for ladders still under review and are NOT applied.`,
    "",
    "| size | qty | ladder status | vendor unit (live) | old seed unit | change | landed unit | current sell | current GM | current GP | floor / GP target | protection | D&C comparable CR | GSO premium | A hold price GM/GP | B pass-through sell GM/GP | C split sell GM/GP |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of data.cells) {
    const p = (key: string) => c.proposals.find((x) => x.key === key);
    const fmt = (x?: DtpEconomicsCell["proposals"][number]) => (x ? `${money(x.sellUnit)} ${pct(x.gmPct)} / $${x.gp.toFixed(0)}${x.meetsFloor ? "" : " BELOW FLOOR"}${x.meetsMinProfit ? "" : " <$500"}` : "—");
    lines.push(`| ${c.size} | ${c.quantity.toLocaleString()} | ${c.ladderStatus === "OWNER_APPROVED" ? "OWNER APPROVED 2026-10-06" : "OWNER PRICING REVIEW REQUIRED"} | ${money(c.vendorUnit, 6)} | ${money(c.oldVendorUnit)} | ${c.oldVendorChangePct == null ? "—" : `${c.oldVendorChangePct.toFixed(1)}%`} | ${money(c.landedUnit, 6)} | ${money(c.currentSellUnit, 2)} | ${pct(c.currentGmPct)} | ${c.currentGp == null ? "—" : `$${c.currentGp.toFixed(0)}`} | ${c.hardFloorPct}% / $${c.minJobProfit} | ${c.meetsProtection == null ? "—" : c.meetsProtection ? "meets" : "BELOW"} | ${c.benchmark.competitorComparableUnit != null ? `$${c.benchmark.competitorComparableUnit.toFixed(4)}` : "—"} | ${c.benchmark.premiumPct != null ? `+${c.benchmark.premiumPct.toFixed(1)}%` : "—"} | ${fmt(p("hold_price"))} | ${fmt(p("hold_margin"))} | ${fmt(p("split"))} |`);
  }
  return lines.join("\n") + "\n";
}
