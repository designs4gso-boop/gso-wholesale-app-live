// DTP REMAINING-SIZE PRICE PROPOSALS — PROPOSED OWNER PRICING (NOT ACTIVE).
//
// Owner direction 2026-10-06/07: Design & Customize 4x5 is the ONLY current
// controlling competitor, so the OWNER-APPROVED 4x5x2 ladder is the MARKET
// ANCHOR. Prices for 3.5x4.5x2 / 5x5x2 / 6x5x2 / 8x5x2 are derived from their
// REAL live Spektra landed-cost difference versus 4x5x2 at the same quantity —
// never by multiplying 4x5 by a size percentage, and never from the old July
// ladder. Everything here is a PROPOSAL for the owner to approve; nothing in
// this module is read by the quote engine (dtp-owner-pricing.server.ts stays
// the only customer-price authority).
//
// Per size and tier (1,000 / 2,500 / 5,000 / 10,000 / 25,000):
//   A live Spektra product cost (comparable spec: White PET / Soft Touch / no
//     spot / CR zipper / No Tear Notch / 1 SKU)      B GSO art (1 design)
//   C provisional freight $85 (UNVERIFIED)           D landed = A + B + C
//   E 4x5x2 approved anchor price at the tier (25,000: the 4x5 RECOMMENDATION)
//   F landed-unit delta vs 4x5x2                     G GP-parity price = E + F
//   H normal margin-protection price = landed / (1 - floor)
//   I $500 job-profit price = (landed total + 500) / qty
//   proposed = commercial rounding of max(G, H, I)
//     (>= $1.00 -> next $0.05; < $1.00 -> next $0.01)
// 1,000 tier: the 4x5 $350 exception is NOT inherited. The proposal uses the
// normal protection; an OPTIONAL acquisition price (GP parity with 4x5, never
// below $350 GP / 30 %) is shown separately for an explicit owner decision.
// 25,000: no 4x5 price is approved; the 4x5 recommendation is the 40 % target
// on live landed cost (continuity-checked against the 10,000 step), and the
// other sizes anchor on that recommendation (clearly labelled).

import { DTP_CATALOG, DTP_COMPARABLE_CONFIG } from "./dtp-catalog";
import { DESIGN_AND_CUSTOMIZE_BENCHMARK, compareToBenchmark } from "./dtp-market-benchmark";
import { DTP_INTERNAL_ART_COST_PER_DESIGN, DTP_MARGIN_WARNING_TARGET_PCT, DTP_MIN_JOB_PROFIT, DTP_STRATEGIC_MIN_JOB_PROFIT, dtpHardFloorPct, ownerPriceForQuantity } from "./dtp-owner-pricing.server";
import { SPEKTRA_FREIGHT_PER_PO } from "./product-driven-costing.server";
import { lookupSpektraVendorCost, type SpektraSizeKey } from "./spektra-live-cost-book";

export const DTP_PROPOSED_LADDERS_VERSION = "dtp-proposed-ladders/2026-10-07";
export const DTP_PROPOSAL_STATUS = "PROPOSED FOR OWNER APPROVAL — NOT ACTIVE" as const;
export const DTP_PROPOSAL_TIERS = [1000, 2500, 5000, 10000, 25000] as const;
export const DTP_REMAINING_SIZES: SpektraSizeKey[] = ["3.5x4.5x2", "5x5x2", "6x5x2", "8x5x2"];
export const ANCHOR_SIZE: SpektraSizeKey = "4x5x2";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Commercial rounding: >= $1.00 to the next $0.05, below $1.00 to the next cent. */
export function commercialRound(price: number): number {
  if (price >= 1) return Math.ceil(price * 20 - 1e-9) / 20;
  return Math.ceil(price * 100 - 1e-9) / 100;
}

export type DtpLandedCell = { size: SpektraSizeKey; quantity: number; status: string; productCost: number | null; art: number; freight: number; landedTotal: number | null; landedUnit: number | null };

export function landedCell(size: SpektraSizeKey, quantity: number): DtpLandedCell {
  const look = lookupSpektraVendorCost({ size, material: DTP_COMPARABLE_CONFIG.material, finish: DTP_COMPARABLE_CONFIG.finish, spot: DTP_COMPARABLE_CONFIG.spot, zipper: DTP_COMPARABLE_CONFIG.zipper, topFeature: DTP_COMPARABLE_CONFIG.topFeature, clearGusset: false, quantity, skuCount: 1 });
  const art = DTP_INTERNAL_ART_COST_PER_DESIGN;
  const freight = SPEKTRA_FREIGHT_PER_PO;
  const landedTotal = look.wholesaleTotal != null ? look.wholesaleTotal + art + freight : null;
  return { size, quantity, status: look.status, productCost: look.wholesaleTotal, art, freight, landedTotal, landedUnit: landedTotal != null ? landedTotal / quantity : null };
}

function economics(price: number, landedTotal: number, quantity: number) {
  const revenue = price * quantity;
  const gp = revenue - landedTotal;
  return { price, revenue: r2(revenue), gp: r2(gp), gmPct: r4(revenue > 0 ? (gp / revenue) * 100 : 0) };
}

export type DtpPriceOption = { price: number; revenue: number; gp: number; gmPct: number; meetsFloor: boolean; meetsMinProfit: boolean };

/** 4x5x2 25,000 RECOMMENDATION (not approved): 40 % target on live landed cost, commercially rounded, checked against the 10,000 step. */
export function recommended4x5At25k() {
  const cell = landedCell(ANCHOR_SIZE, 25000);
  if (cell.landedUnit == null || cell.landedTotal == null) return null;
  const floor = dtpHardFloorPct(25000);
  const raw = cell.landedUnit / (1 - DTP_MARGIN_WARNING_TARGET_PCT / 100);
  const price = commercialRound(raw);
  const e = economics(price, cell.landedTotal, 25000);
  const tenK = ownerPriceForQuantity("spektra-dtp-4x5x2", 10000).unitPrice ?? 0;
  const boundaryTotalBelow = tenK * 24999;
  return {
    status: "OWNER APPROVAL REQUIRED" as const,
    size: ANCHOR_SIZE, quantity: 25000, landedUnit: r6(cell.landedUnit), landedTotal: r2(cell.landedTotal),
    method: `${DTP_MARGIN_WARNING_TARGET_PCT}% target on live landed cost, commercially rounded`,
    rawPrice: r4(raw), ...e, floorPct: floor, meetsFloor: e.gmPct >= floor, meetsMinProfit: e.gp >= DTP_MIN_JOB_PROFIT,
    continuity: { priceAt10k: tenK, totalAt24999: r2(boundaryTotalBelow), totalAt25000: e.revenue, boundaryDropPct: r2(((boundaryTotalBelow - e.revenue) / boundaryTotalBelow) * 100) },
    competitor: "Design & Customize publishes no 25,000 price (10,000 = $0.30 base / $0.315 CR); EXACT TIER COMPETITOR NOT CURRENTLY VERIFIED",
  };
}

export type DtpProposalRow = {
  size: SpektraSizeKey; quantity: number; floorPct: number;
  vendorStatus: string;
  A_productCost: number | null; B_art: number; C_freight: number; D_landedTotal: number | null; D_landedUnit: number | null;
  E_anchorPrice: number | null; E_anchorBasis: "OWNER APPROVED 4x5x2" | "4x5x2 25,000 RECOMMENDATION (not approved)" | "none";
  anchorLandedUnit: number | null; F_landedDeltaUnit: number | null; F_landedDeltaPct: number | null;
  G_gpParityPrice: number | null; H_floorPrice: number | null; I_minProfitPrice: number | null;
  proposed: (DtpPriceOption & { basis: string }) | null;
  /** 1,000 tier only: optional acquisition price (GP parity with 4x5, bounded by $350 / 30 %). */
  acquisitionOption: (DtpPriceOption & { basis: string; gpBelowNormalTarget: number; recommendation: string }) | null;
  marketAnchor: string; exactSizeCompetitor: "NOT CURRENTLY VERIFIED";
  benchmarkComparableCrUnit: number | null; premiumVsAnchorBenchmarkPct: number | null;
  warnings: string[];
};

export function proposeRow(size: SpektraSizeKey, quantity: number): DtpProposalRow {
  const cell = landedCell(size, quantity);
  const anchorCell = landedCell(ANCHOR_SIZE, quantity);
  const floorPct = dtpHardFloorPct(quantity);
  const warnings: string[] = [];
  let E: number | null = null;
  let basis: DtpProposalRow["E_anchorBasis"] = "none";
  if (quantity >= 25000) {
    const rec = recommended4x5At25k();
    if (rec) { E = rec.price; basis = "4x5x2 25,000 RECOMMENDATION (not approved)"; }
  } else {
    E = ownerPriceForQuantity("spektra-dtp-4x5x2", quantity).unitPrice;
    if (E != null) basis = "OWNER APPROVED 4x5x2";
  }
  const bench = compareToBenchmark(null, quantity);
  const row: DtpProposalRow = {
    size, quantity, floorPct, vendorStatus: cell.status,
    A_productCost: cell.productCost != null ? r2(cell.productCost) : null, B_art: r4(cell.art), C_freight: cell.freight,
    D_landedTotal: cell.landedTotal != null ? r2(cell.landedTotal) : null, D_landedUnit: cell.landedUnit != null ? r6(cell.landedUnit) : null,
    E_anchorPrice: E, E_anchorBasis: basis, anchorLandedUnit: anchorCell.landedUnit != null ? r6(anchorCell.landedUnit) : null,
    F_landedDeltaUnit: null, F_landedDeltaPct: null, G_gpParityPrice: null, H_floorPrice: null, I_minProfitPrice: null,
    proposed: null, acquisitionOption: null,
    marketAnchor: `${DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} 4x5 (via the approved 4x5x2 ladder)`, exactSizeCompetitor: "NOT CURRENTLY VERIFIED",
    benchmarkComparableCrUnit: bench.competitorComparableUnit, premiumVsAnchorBenchmarkPct: null,
    warnings,
  };
  if (cell.landedTotal == null || cell.landedUnit == null) { warnings.push("No observed vendor row for the comparable configuration at this quantity — no proposal."); return row; }
  if (anchorCell.landedUnit == null || E == null) { warnings.push("No 4x5x2 anchor available at this quantity — no proposal."); return row; }
  const F = cell.landedUnit - anchorCell.landedUnit;
  row.F_landedDeltaUnit = r6(F);
  row.F_landedDeltaPct = r2((F / anchorCell.landedUnit) * 100);
  const G = E + F;
  const H = cell.landedUnit / (1 - floorPct / 100);
  const I = (cell.landedTotal + DTP_MIN_JOB_PROFIT) / quantity;
  row.G_gpParityPrice = r4(G); row.H_floorPrice = r4(H); row.I_minProfitPrice = r4(I);
  const candidates: Array<[string, number]> = [["G GP parity with 4x5", G], [`H ${floorPct}% floor`, H], [`I $${DTP_MIN_JOB_PROFIT} job profit`, I]];
  const [controlling, raw] = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  const price = commercialRound(raw);
  const e = economics(price, cell.landedTotal, quantity);
  row.proposed = { ...e, meetsFloor: e.gmPct >= floorPct, meetsMinProfit: e.gp >= DTP_MIN_JOB_PROFIT, basis: `max(G, H, I) = ${controlling} ($${raw.toFixed(4)}) -> commercial rounding` };
  row.premiumVsAnchorBenchmarkPct = bench.competitorComparableUnit ? r2(((price - bench.competitorComparableUnit) / bench.competitorComparableUnit) * 100) : null;
  if (quantity === 1000) {
    // optional acquisition price: GP parity with the 4x5 1,000 tier (~$439), never below the $350 absolute floor or the 30 % hard floor
    const gpParityFloor = Math.max(G, (cell.landedTotal + DTP_STRATEGIC_MIN_JOB_PROFIT) / quantity, H);
    const acqPrice = commercialRound(gpParityFloor);
    const ae = economics(acqPrice, cell.landedTotal, quantity);
    const normalGp = row.proposed.gp;
    row.acquisitionOption = {
      ...ae, meetsFloor: ae.gmPct >= floorPct, meetsMinProfit: ae.gp >= DTP_MIN_JOB_PROFIT,
      basis: `GP parity with the approved 4x5x2 1,000 tier (bounded by $${DTP_STRATEGIC_MIN_JOB_PROFIT} GP and ${floorPct}% floor); requires an explicit owner exception like 4x5x2`,
      gpBelowNormalTarget: r2(DTP_MIN_JOB_PROFIT - ae.gp),
      recommendation: acqPrice >= price
        ? "Not needed — the normal-protection price already matches 4x5 economics."
        : `Recommend the normal-protection price $${price.toFixed(2)} (GP $${normalGp.toFixed(0)}) as default; approve $${acqPrice.toFixed(2)} (GP $${ae.gp.toFixed(0)}, ${ae.gmPct.toFixed(1)}%) only as an explicit acquisition exception for this size.`,
    };
  }
  if (row.proposed.gmPct < DTP_MARGIN_WARNING_TARGET_PCT) warnings.push(`Proposed price is below the ${DTP_MARGIN_WARNING_TARGET_PCT}% target (meets the ${floorPct}% floor and the $${DTP_MIN_JOB_PROFIT} GP rule).`);
  if (quantity === 1000 && row.proposed.gp < DTP_MIN_JOB_PROFIT) warnings.push("1,000-tier GP below $500 — owner exception required.");
  return row;
}

export type DtpProposedLadder = {
  size: SpektraSizeKey; capacityLabel: string | null; status: typeof DTP_PROPOSAL_STATUS;
  rows: DtpProposalRow[];
  continuity: Array<{ fromQty: number; toQty: number; totalJustBelow: number; totalAtStep: number; dropPct: number; cliff: boolean }>;
  rationale: string;
};

/**
 * Quantity continuity: order total at the step vs one unit below the step.
 * Every step ladder drops at a boundary (the approved 4x5x2 ladder itself
 * drops ~45% / ~35% / ~20% at 2,500 / 5,000 / 10,000); a proposal is flagged
 * CLIFF only when its drop exceeds the 4x5x2 reference drop at the same
 * boundary by more than 5 points (or a flat reference when a number is given).
 */
export function continuityFor(prices: Array<{ quantity: number; price: number }>, reference?: Array<{ toQty: number; dropPct: number }> | number) {
  const sorted = [...prices].sort((a, b) => a.quantity - b.quantity);
  const out: DtpProposedLadder["continuity"] = [];
  for (let i = 1; i < sorted.length; i++) {
    const below = sorted[i - 1].price * (sorted[i].quantity - 1);
    const at = sorted[i].price * sorted[i].quantity;
    const dropPct = r2(((below - at) / below) * 100);
    const ref = typeof reference === "number" ? reference : reference?.find((x) => x.toQty === sorted[i].quantity)?.dropPct;
    out.push({ fromQty: sorted[i - 1].quantity, toQty: sorted[i].quantity, totalJustBelow: r2(below), totalAtStep: r2(at), dropPct, cliff: ref == null ? false : dropPct > ref + 5 });
  }
  return out;
}

/** The approved 4x5x2 ladder's own boundary drops (plus the 25,000 recommendation) — the continuity reference for every proposal. */
export function anchorContinuity() {
  const approved = DTP_PROPOSAL_TIERS.filter((q) => q < 25000).map((q) => ({ quantity: q, price: ownerPriceForQuantity("spektra-dtp-4x5x2", q).unitPrice ?? 0 }));
  const rec25 = recommended4x5At25k();
  return continuityFor([...approved, ...(rec25 ? [{ quantity: 25000, price: rec25.price }] : [])]);
}

export function proposeLadder(size: SpektraSizeKey): DtpProposedLadder {
  const entry = DTP_CATALOG.find((e) => e.size === size);
  const rows = DTP_PROPOSAL_TIERS.map((q) => proposeRow(size, q));
  const priced = rows.filter((r) => r.proposed).map((r) => ({ quantity: r.quantity, price: r.proposed!.price }));
  return {
    size, capacityLabel: entry?.capacityLabel ?? null, status: DTP_PROPOSAL_STATUS, rows,
    continuity: continuityFor(priced, anchorContinuity()),
    rationale: `Anchored on the OWNER-APPROVED 4x5x2 ladder (Design & Customize 4x5 = controlling benchmark) by the real live Spektra landed-cost difference at each quantity (GP parity), lifted where the ${rows.map((r) => r.floorPct).filter((v, i, a) => a.indexOf(v) === i).join("/")}% floors or the $${DTP_MIN_JOB_PROFIT} job-profit rule require more, then commercially rounded. No exact-size competitor price is verified for ${size}; the old July ladder is not used as authority.`,
  };
}

export function buildDtpProposedLadders() {
  const approved4x5 = DTP_PROPOSAL_TIERS.filter((q) => q < 25000).map((q) => ({ quantity: q, price: ownerPriceForQuantity("spektra-dtp-4x5x2", q).unitPrice ?? 0 }));
  const rec25 = recommended4x5At25k();
  return {
    version: DTP_PROPOSED_LADDERS_VERSION,
    status: DTP_PROPOSAL_STATUS,
    anchor: { size: ANCHOR_SIZE, approved: approved4x5, continuity: anchorContinuity(), recommended25k: rec25 },
    ladders: DTP_REMAINING_SIZES.map(proposeLadder),
    freightNote: "Freight $85 per PO is a provisional UNVERIFIED assumption inside every landed cost.",
    marketNote: `${DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} 4x5 is the market anchor via the approved 4x5x2 ladder. Exact-size competitor pricing for 3.5x4.5 / 5x5 / 6x5 / 8x5: NOT CURRENTLY VERIFIED.`,
  };
}

/** Markdown for docs/generated — written by the test suite. */
export function dtpProposedLaddersMarkdown(): string {
  const data = buildDtpProposedLadders();
  const m = (n: number | null | undefined, d = 4) => (n == null ? "—" : `$${n.toFixed(d)}`);
  const L: string[] = [
    `# DTP proposed owner ladders — ${DTP_PROPOSAL_STATUS} (generated ${data.version})`,
    "",
    `Anchor: OWNER-APPROVED 4x5x2 ${data.anchor.approved.map((a) => `${a.quantity.toLocaleString()} $${a.price.toFixed(2)}`).join(" · ")}; 25,000 recommendation ${data.anchor.recommended25k ? `$${data.anchor.recommended25k.price.toFixed(2)} (${data.anchor.recommended25k.gmPct.toFixed(1)}% / $${data.anchor.recommended25k.gp.toFixed(0)}; boundary drop vs 24,999 x $0.37: ${data.anchor.recommended25k.continuity.boundaryDropPct}%) — OWNER APPROVAL REQUIRED` : "n/a"}. ${data.marketNote} ${data.freightNote}`,
    "",
  ];
  for (const ladder of data.ladders) {
    L.push(`## ${ladder.size}${ladder.capacityLabel ? ` (${ladder.capacityLabel})` : ""} — ${ladder.status}`, "", ladder.rationale, "",
      "| qty | A product | B art | C freight | D landed total | D landed/unit | E 4x5 anchor | F Δ landed/unit | G GP parity | H floor price | I $500 GP price | PROPOSED | GM | GP | floor | D&C 4x5 CR ref | vs ref |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of ladder.rows) {
      L.push(`| ${r.quantity.toLocaleString()} | ${m(r.A_productCost, 2)} | ${m(r.B_art)} | $${r.C_freight} | ${m(r.D_landedTotal, 2)} | ${m(r.D_landedUnit, 6)} | ${m(r.E_anchorPrice, 2)}${r.E_anchorBasis.includes("RECOMMENDATION") ? " (rec.)" : ""} | ${r.F_landedDeltaUnit == null ? "—" : `${r.F_landedDeltaUnit >= 0 ? "+" : ""}${r.F_landedDeltaUnit.toFixed(6)} (${r.F_landedDeltaPct}%)`} | ${m(r.G_gpParityPrice)} | ${m(r.H_floorPrice)} | ${m(r.I_minProfitPrice)} | **${m(r.proposed?.price, 2)}** | ${r.proposed ? `${r.proposed.gmPct.toFixed(1)}%` : "—"} | ${r.proposed ? `$${r.proposed.gp.toFixed(0)}` : "—"} | ${r.floorPct}% | ${m(r.benchmarkComparableCrUnit, 3)} | ${r.premiumVsAnchorBenchmarkPct == null ? "—" : `${r.premiumVsAnchorBenchmarkPct >= 0 ? "+" : ""}${r.premiumVsAnchorBenchmarkPct}%`} |`);
    }
    const acq = ladder.rows.find((r) => r.acquisitionOption)?.acquisitionOption;
    if (acq) L.push("", `1,000 optional acquisition price: $${acq.price.toFixed(2)} (${acq.gmPct.toFixed(1)}% / $${acq.gp.toFixed(0)}; $${acq.gpBelowNormalTarget.toFixed(0)} below the $500 target). ${acq.recommendation}`);
    L.push("", `Continuity: ${ladder.continuity.map((c) => `${c.fromQty.toLocaleString()}->${c.toQty.toLocaleString()} ${c.dropPct}%${c.cliff ? " CLIFF" : ""}`).join(" · ")}`, "");
  }
  return L.join("\n") + "\n";
}
