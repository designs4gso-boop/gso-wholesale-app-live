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
//   * PROPOSAL options computed from existing approved DTP policy (hard floors
//     30/35/38 %, $500 minimum job profit, 40 % warning target). They are
//     proposals for the owner; the live ladders are NOT changed by this module.
//
// Market reference: no DTP market-pricing document exists in the repository;
// commercial position is reported as NOT AVAILABLE rather than guessed.
// Server-only because it reads the owner ladders (server module).

import { DTP_CATALOG, DTP_COMPARABLE_CONFIG } from "./dtp-catalog";
export { DTP_COMPARABLE_CONFIG };
import { DTP_HARD_FLOOR_BANDS, DTP_INTERNAL_ART_COST_PER_DESIGN, DTP_MARGIN_WARNING_TARGET_PCT, DTP_MIN_JOB_PROFIT, DTP_OWNER_PRICE_LADDERS, dtpHardFloorPct, ownerPriceForQuantity } from "./dtp-owner-pricing.server";
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
  proposals: Array<{ key: "hold_price" | "hold_margin" | "split"; label: string; sellUnit: number; sellTotal: number; gmPct: number; gp: number; meetsFloor: boolean; meetsMinProfit: boolean }>;
  marketReference: "NOT AVAILABLE — no DTP market document in repository";
};

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function dtpEconomicsCell(size: SpektraSizeKey, quantity: number, finish: SpektraFinish = DTP_COMPARABLE_CONFIG.finish, designs = 1): DtpEconomicsCell {
  const look = lookupSpektraVendorCost({ size, material: DTP_COMPARABLE_CONFIG.material, finish, spot: DTP_COMPARABLE_CONFIG.spot, zipper: DTP_COMPARABLE_CONFIG.zipper, topFeature: DTP_COMPARABLE_CONFIG.topFeature, clearGusset: false, quantity, skuCount: Math.max(1, designs) });
  const artCost = DTP_INTERNAL_ART_COST_PER_DESIGN * Math.max(1, designs);
  const freightAssumption = SPEKTRA_FREIGHT_PER_PO;
  const landedTotal = look.wholesaleTotal != null ? look.wholesaleTotal + artCost + freightAssumption : null;
  const landedUnit = landedTotal != null ? landedTotal / quantity : null;
  const entry = DTP_CATALOG.find((e) => e.size === size);
  const ladder = entry?.vendorSku ? ownerPriceForQuantity(entry.vendorSku, quantity) : { tierUsed: null, unitPrice: null };
  const currentSellUnit = ladder.unitPrice;
  const currentTotal = currentSellUnit != null ? currentSellUnit * quantity : null;
  const currentGp = currentTotal != null && landedTotal != null ? currentTotal - landedTotal : null;
  const currentGmPct = currentTotal != null && currentGp != null && currentTotal > 0 ? (currentGp / currentTotal) * 100 : null;
  const oldVendorUnit = legacySeedUnit(size, quantity);
  const hardFloorPct = dtpHardFloorPct(quantity);
  const proposals: DtpEconomicsCell["proposals"] = [];
  if (landedTotal != null && landedUnit != null) {
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
    hardFloorPct, proposals,
    marketReference: "NOT AVAILABLE — no DTP market document in repository",
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
    policy: { hardFloorBands: DTP_HARD_FLOOR_BANDS, minJobProfit: DTP_MIN_JOB_PROFIT, warningTargetPct: DTP_MARGIN_WARNING_TARGET_PCT, ladders: DTP_OWNER_PRICE_LADDERS },
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
    `Vendor: live Spektra cost book (public total x 0.75). Landed = vendor + GSO art $${DTP_INTERNAL_ART_COST_PER_DESIGN.toFixed(4)} (1 design) + freight $${SPEKTRA_FREIGHT_PER_PO} (UNVERIFIED). Current sell = owner ladder 2026-07-24 (highest tier reached; none below 1,000). Market: ${data.cells[0]?.marketReference ?? "n/a"}. Proposals are computed from existing DTP policy and are NOT applied.`,
    "",
    "| size | qty | vendor unit (live) | old seed unit | change | landed unit | current sell | current GM | current GP | floor | A hold price GM/GP | B pass-through sell GM/GP | C split sell GM/GP |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of data.cells) {
    const p = (key: string) => c.proposals.find((x) => x.key === key);
    const fmt = (x?: DtpEconomicsCell["proposals"][number]) => (x ? `${money(x.sellUnit)} ${pct(x.gmPct)} / $${x.gp.toFixed(0)}${x.meetsFloor ? "" : " BELOW FLOOR"}${x.meetsMinProfit ? "" : " <$500"}` : "—");
    lines.push(`| ${c.size} | ${c.quantity.toLocaleString()} | ${money(c.vendorUnit, 6)} | ${money(c.oldVendorUnit)} | ${c.oldVendorChangePct == null ? "—" : `${c.oldVendorChangePct.toFixed(1)}%`} | ${money(c.landedUnit, 6)} | ${money(c.currentSellUnit, 2)} | ${pct(c.currentGmPct)} | ${c.currentGp == null ? "—" : `$${c.currentGp.toFixed(0)}`} | ${c.hardFloorPct}% | ${fmt(p("hold_price"))} | ${fmt(p("hold_margin"))} | ${fmt(p("split"))} |`);
  }
  return lines.join("\n") + "\n";
}
