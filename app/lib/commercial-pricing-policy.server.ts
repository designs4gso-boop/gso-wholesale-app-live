// Commercial pricing policy (15F.0 — production-ready pricing). ONE shared
// module that turns a COMPLETE production cost into a customer-ready price.
//
// Deterministic contract (spec 15F.0-H):
//   final price = max( costBasedPrice, minimumGrossProfitPrice,
//                      minimumOrderTotalPrice, minimumUnitPriceTotal,
//                      ownerMarketLadderPrice, premiumFinishFloorPrice )
// with every candidate reported and the CONTROLLING rule named. Workers use
// the selected price — no routine owner review for supported jobs.
//
// Owner-approved data only: researched FAMILY_MARGIN_RULES curves (GSO 2026
// competitor and margin study), the spot-gloss premium curve from the same
// study, and the DTP owner ladders (which keep their own 15C.2 pipeline).
// Family minimum-profit / minimum-order / minimum-unit values are OWNER
// DECISIONS — unset entries are null (candidate skipped, documented in
// docs/GSO_ERP_PRICING_OWNER_DECISIONS.md), NEVER invented here.

import {
  MARGIN_FLOOR_PCT,
  marginMath,
  resolveMarginFamily,
  type FamilyMarginRule,
} from "./calculator-emergency.server";

export const COMMERCIAL_PRICING_VERSION = "15F.0-production-ready-pricing";
export const COMMERCIAL_PRICING_SOURCE = "GSO 2026 competitor and margin study + owner standards (15F.0)";

// Quantity band edges for the researched 5-point curves. These are the margin
// study's tier structure (the long-standing default tier quantities): band N
// covers quantities up to the next edge; >= 1000 uses the final approved
// point. Margin comes from the QUANTITY ONLY — never from table row position
// (fixes forensic finding P0-1; same model 15C.1 proved for DTP).
export const MARGIN_BAND_QUANTITIES = [64, 128, 256, 640, 1000];

export function marginPctForQuantity(rule: FamilyMarginRule, quantity: number): number {
  const qty = Math.max(1, Math.floor(quantity));
  // band index = how many edges beyond the first the quantity has reached
  let index = 0;
  for (let position = 1; position < MARGIN_BAND_QUANTITIES.length; position += 1) {
    if (qty >= MARGIN_BAND_QUANTITIES[position]) index = position;
  }
  const pct = rule.curve[Math.min(index, rule.curve.length - 1)] ?? rule.familyMinPct;
  return Math.max(pct, rule.familyMinPct);
}

// Premium finish rule: any white/gloss layer on stickers & labels prices off
// the researched SPOT-GLOSS curve (70/62/56/50/45, min 45) — premium labels
// must never price as basic stickers (spec I).
export const PREMIUM_FINISH_MARGIN_KEY = "spot-gloss-labels";

// ---------- 15F.0-FINAL-A: sticker/label commercial market floor ----------
// AREA-AWARE floor (never a universal unit-price ladder): $ per finished
// square foot, banded by TOTAL finished sqft so both very small stickers and
// large labels stay safe, plus full setup/design recovery on top. PROVISIONAL
// CONSERVATIVE — anchored to the two documented 15F.0 forensic market
// references at their LOW end (100 x 3x3 = 6.25 sqft -> $50 -> $8.00/sqft;
// 1,000 x 3x3 = 62.5 sqft -> $200 -> $3.20/sqft); intermediate bands are the
// linear interpolation between those anchors. Editable in 15F.1; owner
// ratification listed in GSO_ERP_PRICING_OWNER_DECISIONS.md. Material-class
// and finish premiums flow through the COST-based and PREMIUM-curve
// candidates (real material $/sqft + spot-gloss curve), so the floor itself
// stays material-neutral — it is the "never below this for the area" line.
export const STICKER_MARKET_FLOOR_SOURCE = "15F.0 forensic market references (low end) + linear interpolation — PROVISIONAL, owner ratification pending";
export const STICKER_MARKET_FLOOR_BANDS: Array<{ maxSqft: number | null; ratePerSqft: number }> = [
  { maxSqft: 10, ratePerSqft: 8.0 },
  { maxSqft: 25, ratePerSqft: 6.4 },
  { maxSqft: 50, ratePerSqft: 4.8 },
  { maxSqft: 62.5, ratePerSqft: 4.0 },
  { maxSqft: null, ratePerSqft: 3.2 },
];
export function stickerMarketFloorRate(finishedSqft: number): number {
  for (const band of STICKER_MARKET_FLOOR_BANDS) {
    if (band.maxSqft == null || finishedSqft < band.maxSqft) return band.ratePerSqft;
  }
  return STICKER_MARKET_FLOOR_BANDS[STICKER_MARKET_FLOOR_BANDS.length - 1].ratePerSqft;
}
// floor = area rate x finished sqft + full setup recovery (art + print per
// design) so multi-design jobs never eat setup out of the floor.
export function stickerMarketFloorPrice(finishedSqft: number, setupTotal: number): number | null {
  if (!(finishedSqft > 0)) return null;
  return stickerMarketFloorRate(finishedSqft) * finishedSqft + Math.max(0, setupTotal);
}

export type FamilyCommercialPolicy = {
  familyKey: string; // canonical UI family
  label: string;
  // null = owner has not set this minimum yet -> candidate skipped + listed
  // as an owner decision. NEVER silently defaulted.
  minimumGrossProfit: number | null;
  minimumOrderTotal: number | null;
  minimumUnitPrice: number | null;
  notes: string;
};

// 15F.0-FINAL-B/C/D: PROVISIONAL CONSERVATIVE minimums (never null in
// production — spec requirement). Derivation basis, documented per family:
// minimum gross profit = hours of the owner $25/hr labor basis a job must at
// least earn (stickers/banners/custom ~1 hr = $25; bags/standard jars ~3 hrs
// = $75; premium jars ~4 hrs = $100). Minimum order totals only where
// commercially necessary (stickers $25, banners $40, custom $25 — typical
// shop minimums, conservative low end). Minimum UNIT price: deliberately
// NONE anywhere — size/sqft differences make a universal unit floor unsafe
// for stickers (the AREA floor covers it) and no research supports one
// elsewhere. All values editable in 15F.1; owner ratification listed in
// GSO_ERP_PRICING_OWNER_DECISIONS.md. DTP is ABSENT deliberately: it keeps
// the 15C.2 owner ladder pipeline ($500/$350 rules) exactly.
export const FAMILY_COMMERCIAL_POLICIES: FamilyCommercialPolicy[] = [
  { familyKey: "sticker-bags", label: "Sticker Bags", minimumGrossProfit: 75, minimumOrderTotal: null, minimumUnitPrice: null, notes: "PROVISIONAL min profit = ~3 hrs owner labor basis. Researched bags-4x5 curve; non-4x5 sizes provisional universal curve until studied." },
  { familyKey: "standard-jars", label: "Standard Jars", minimumGrossProfit: 75, minimumOrderTotal: null, minimumUnitPrice: null, notes: "PROVISIONAL min profit = ~3 hrs owner labor basis. No researched curve yet — provisional universal curve, labeled." },
  { familyKey: "premium-jars", label: "Premium Jars (Chiron & Miron)", minimumGrossProfit: 100, minimumOrderTotal: null, minimumUnitPrice: null, notes: "PROVISIONAL min profit = ~4 hrs owner labor basis. Chiron/Miron researched curves from the jar study." },
  { familyKey: "stickers-labels", label: "Stickers & Labels", minimumGrossProfit: 25, minimumOrderTotal: 25, minimumUnitPrice: null, notes: "PROVISIONAL min profit/order = ~1 hr owner labor basis / typical shop minimum. Researched curve + AREA market floor + spot-gloss premium curve; unit-price floor deliberately none (area floor is size-safe)." },
  { familyKey: "banners", label: "Banners", minimumGrossProfit: 25, minimumOrderTotal: 40, minimumUnitPrice: null, notes: "PROVISIONAL min profit ~1 hr owner labor basis; $40 minimum banner charge (conservative low end of the documented $60-90 3x6 range scaled to the smallest common banner)." },
  { familyKey: "custom-item", label: "Custom Item", minimumGrossProfit: 25, minimumOrderTotal: 25, minimumUnitPrice: null, notes: "PROVISIONAL. Never auto-Ready without complete verified/owner-entered cost; below-floor owner prices keep the existing override gate." },
];

export function commercialPolicyFor(familyKey: string): FamilyCommercialPolicy | null {
  return FAMILY_COMMERCIAL_POLICIES.find((policy) => policy.familyKey === familyKey) || null;
}

export type CommercialCandidates = {
  costBasedPrice: number;
  marginFloorPrice: number; // informational floor line — costBased already clears it
  minimumGrossProfitPrice: number | null;
  minimumOrderTotalPrice: number | null;
  minimumUnitPriceTotal: number | null;
  ownerMarketLadderPrice: number | null;
  premiumFinishFloorPrice: number | null;
};

export type CommercialPriceResult = {
  version: string;
  familyKey: string;
  quantity: number;
  completeCost: number;
  marginPctApplied: number; // the researched quantity-band margin used for costBasedPrice
  marginSource: string;
  premiumApplied: boolean;
  candidates: CommercialCandidates;
  finalTotalPrice: number;
  finalUnitPrice: number;
  controllingRule: string;
  achievedProfit: number;
  achievedMarginPct: number;
};

// One quote -> one customer-ready price. `marginRule` = the resolved
// researched family rule (null -> provisional universal curve handled by the
// caller passing a rule built from defaults); `premiumEligible` = white/gloss
// layers > 0 on a stickers-family job.
export function computeCommercialPrice(input: {
  familyKey: string;
  quantity: number;
  completeCost: number;
  marginRule: FamilyMarginRule | null;
  premiumEligible: boolean;
  marginPctOverride?: number | null; // owner Advanced per-tier margin edit (validated by the existing gate)
  ownerMarketLadderTotal?: number | null; // reserved: family price ladders (DTP handled by its own pipeline)
  // 15F.0-FINAL-A: finished sqft + setup drive the sticker AREA market floor.
  finishedSqft?: number | null;
  setupTotal?: number | null;
  // 15F.0-FINAL: per-line calls in multi-line jobs suppress the JOB-level
  // minimum-profit/order candidates (applied once on the combined total).
  suppressJobMinimums?: boolean;
}): CommercialPriceResult {
  const quantity = Math.max(1, Math.floor(input.quantity));
  const completeCost = Math.max(0, input.completeCost);
  const policy = commercialPolicyFor(input.familyKey);
  const rule = input.marginRule;
  const premiumRule = input.premiumEligible ? resolveMarginFamily(PREMIUM_FINISH_MARGIN_KEY) : null;

  const baseMarginPct = input.marginPctOverride != null && Number.isFinite(input.marginPctOverride) && input.marginPctOverride > 0
    ? input.marginPctOverride
    : rule
      ? marginPctForQuantity(rule, quantity)
      : Math.max(MARGIN_FLOOR_PCT, 40);
  const marginSource = input.marginPctOverride != null && Number.isFinite(input.marginPctOverride) && input.marginPctOverride > 0
    ? "owner per-tier margin edit (Advanced Pricing Controls)"
    : rule
      ? `${rule.label} researched curve at quantity band (${COMMERCIAL_PRICING_SOURCE})`
      : `provisional universal curve — FAMILY MARGIN RULE NOT CONFIGURED (${MARGIN_FLOOR_PCT}% floor)`;

  const costBasedPrice = marginMath(completeCost, baseMarginPct).price;
  const floorPct = Math.max(rule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT);
  const marginFloorPrice = marginMath(completeCost, floorPct).price;
  const premiumFinishFloorPrice = premiumRule
    ? marginMath(completeCost, Math.max(marginPctForQuantity(premiumRule, quantity), premiumRule.familyMinPct)).price
    : null;
  const suppress = Boolean(input.suppressJobMinimums);
  const minimumGrossProfitPrice = !suppress && policy?.minimumGrossProfit != null ? completeCost + policy.minimumGrossProfit : null;
  const minimumOrderTotalPrice = !suppress && policy?.minimumOrderTotal != null ? policy.minimumOrderTotal : null;
  const minimumUnitPriceTotal = !suppress && policy?.minimumUnitPrice != null ? policy.minimumUnitPrice * quantity : null;
  // 15F.0-FINAL-A: the sticker AREA market floor fills the market-ladder
  // candidate slot for stickers & labels (provisional research anchors).
  const ownerMarketLadderPrice = input.ownerMarketLadderTotal
    ?? (input.familyKey === "stickers-labels" ? stickerMarketFloorPrice(input.finishedSqft ?? 0, input.setupTotal ?? 0) : null);

  const contenders: Array<{ rule: string; price: number | null }> = [
    { rule: `Cost-based price — ${baseMarginPct}% quantity-band margin`, price: costBasedPrice },
    { rule: "Minimum gross-profit floor (owner, provisional)", price: minimumGrossProfitPrice },
    { rule: "Minimum order total (owner, provisional)", price: minimumOrderTotalPrice },
    { rule: "Minimum unit price (owner)", price: minimumUnitPriceTotal },
    { rule: input.familyKey === "stickers-labels" && input.ownerMarketLadderTotal == null ? "Sticker market floor (area-banded, provisional research anchors)" : "Owner market price ladder", price: ownerMarketLadderPrice },
    { rule: "Premium finish floor (spot-gloss researched curve)", price: premiumFinishFloorPrice },
  ];
  let finalTotalPrice = 0;
  let controllingRule = contenders[0].rule;
  for (const contender of contenders) {
    if (contender.price != null && contender.price > finalTotalPrice) {
      finalTotalPrice = contender.price;
      controllingRule = contender.rule;
    }
  }
  const achievedProfit = finalTotalPrice - completeCost;
  const achievedMarginPct = finalTotalPrice > 0 ? (achievedProfit / finalTotalPrice) * 100 : 0;

  return {
    version: COMMERCIAL_PRICING_VERSION,
    familyKey: input.familyKey,
    quantity,
    completeCost,
    marginPctApplied: baseMarginPct,
    marginSource,
    premiumApplied: premiumRule != null && finalTotalPrice > 0 && controllingRule.startsWith("Premium"),
    candidates: {
      costBasedPrice,
      marginFloorPrice,
      minimumGrossProfitPrice,
      minimumOrderTotalPrice,
      minimumUnitPriceTotal,
      ownerMarketLadderPrice,
      premiumFinishFloorPrice,
    },
    finalTotalPrice,
    finalUnitPrice: quantity > 0 ? finalTotalPrice / quantity : finalTotalPrice,
    controllingRule,
    achievedProfit,
    achievedMarginPct,
  };
}

// ---------- multi-design split (spec J — display + snapshot helper) ----------
// Quantity = TOTAL physical labels; designs SHARE that total. 585/3 = 195 per
// design; uneven quantities show the remainder distribution deterministically
// (first `remainder` designs carry one extra).
export function designSplit(quantity: number, designs: number): { perDesign: number; remainder: number; text: string } {
  const qty = Math.max(0, Math.floor(quantity));
  const count = Math.max(1, Math.floor(designs || 1));
  const perDesign = Math.floor(qty / count);
  const remainder = qty - perDesign * count;
  const text = count <= 1
    ? `${qty.toLocaleString()} label(s), 1 design`
    : remainder === 0
      ? `Total labels: ${qty.toLocaleString()} · Designs: ${count} · ${perDesign.toLocaleString()} per design`
      : `Total labels: ${qty.toLocaleString()} · Designs: ${count} · ~${perDesign.toLocaleString()} per design (${remainder} design(s) get ${(perDesign + 1).toLocaleString()})`;
  return { perDesign, remainder, text };
}

// ---------- multi-line sticker jobs (spec K — shared line builder) ----------
// One shared builder for loader AND save action (same pattern as
// buildLabelRows): lines derive strictly from the posted count; stale extra
// posted array entries never affect cost. Each line prices independently
// (own quantity band, own premium eligibility); job-level packing is
// allocated by cost share before pricing so the combined price reconstructs
// exactly.
export type StickerLineInput = {
  name: string;
  quantity: number;
  designs: number;
  widthIn: number;
  heightIn: number;
  materialId: string;
  printer: "mimaki" | "roland";
  whiteLayers: number;
  glossLayers: number;
  cutType: string;
};

export function buildStickerLines(params: {
  count: number;
  names: string[];
  quantities: number[];
  designs: number[];
  widths: number[];
  heights: number[];
  materialIds: string[];
  printers: string[];
  whites: number[];
  glosses: number[];
  cuts: string[];
}): StickerLineInput[] {
  const count = Math.min(Math.max(0, Math.floor(params.count || 0)), 8);
  return Array.from({ length: count }, (_v, index) => ({
    name: String(params.names[index] || `Line ${index + 1}`).slice(0, 80),
    quantity: Math.max(0, Math.floor(Number(params.quantities[index]) || 0)),
    designs: Math.max(0, Math.floor(Number(params.designs[index]) || 0)),
    widthIn: Number(params.widths[index]) > 0 ? Number(params.widths[index]) : 0,
    heightIn: Number(params.heights[index]) > 0 ? Number(params.heights[index]) : 0,
    materialId: String(params.materialIds[index] || ""),
    printer: String(params.printers[index]) === "roland" ? "roland" : "mimaki",
    whiteLayers: Math.max(0, Math.floor(Number(params.whites[index]) || 0)),
    glossLayers: Math.max(0, Math.floor(Number(params.glosses[index]) || 0)),
    cutType: String(params.cuts[index] || "square-rect"),
  }));
}

// Combine independently-computed line results into one job quote. Inputs are
// the per-line engine outputs (cost + blockers) — this module never touches
// the database. Packing is passed once at job level and allocated by cost
// share; each line then prices on its own researched band.
export function combineStickerLines(input: {
  lines: Array<{
    name: string;
    quantity: number;
    designs: number;
    glossOrWhite: boolean;
    lineCost: number; // line's own direct cost WITHOUT job-level packing
    missing: string[];
    // 15F.0-FINAL: per-line area + setup feed the sticker market floor
    finishedSqft?: number;
    setupTotal?: number;
  }>;
  jobPackingCost: number;
  marginRule: FamilyMarginRule | null;
}): {
  lines: Array<{ name: string; quantity: number; lineCost: number; allocatedPacking: number; pricedCost: number; finalPrice: number; unitPrice: number; marginPctApplied: number; controllingRule: string; premiumApplied: boolean }>;
  totalQuantity: number;
  totalCost: number;
  finalTotalPrice: number;
  achievedProfit: number;
  achievedMarginPct: number;
  controllingRule: string;
  blockers: string[];
} {
  const activeLines = input.lines.filter((line) => line.quantity > 0);
  const directTotal = activeLines.reduce((sum, line) => sum + line.lineCost, 0);
  const blockers = activeLines.flatMap((line) => line.missing.map((reason) => `${line.name}: ${reason}`));
  const priced = activeLines.map((line) => {
    const share = directTotal > 0 ? line.lineCost / directTotal : 1 / Math.max(1, activeLines.length);
    const allocatedPacking = input.jobPackingCost * share;
    const pricedCost = line.lineCost + allocatedPacking;
    const commercial = computeCommercialPrice({
      familyKey: "stickers-labels",
      quantity: line.quantity,
      completeCost: pricedCost,
      marginRule: input.marginRule,
      premiumEligible: line.glossOrWhite,
      finishedSqft: line.finishedSqft ?? 0,
      setupTotal: line.setupTotal ?? 0,
      suppressJobMinimums: true, // job-level minimums apply ONCE below
    });
    return {
      name: line.name,
      quantity: line.quantity,
      lineCost: line.lineCost,
      allocatedPacking,
      pricedCost,
      finalPrice: commercial.finalTotalPrice,
      unitPrice: commercial.finalUnitPrice,
      marginPctApplied: commercial.marginPctApplied,
      controllingRule: commercial.controllingRule,
      premiumApplied: line.glossOrWhite,
    };
  });
  const totalCost = directTotal + input.jobPackingCost;
  const lineSum = priced.reduce((sum, line) => sum + line.finalPrice, 0);
  // 15F.0-FINAL: job-level minimum-profit/order candidates on the COMBINED
  // total (never per line — that would multiply shop minimums).
  const policy = commercialPolicyFor("stickers-labels");
  let finalTotalPrice = lineSum;
  let controllingRule = "Sum of per-line commercial prices";
  if (policy?.minimumGrossProfit != null && totalCost + policy.minimumGrossProfit > finalTotalPrice) {
    finalTotalPrice = totalCost + policy.minimumGrossProfit;
    controllingRule = "Minimum gross-profit floor (owner, provisional) on the combined job";
  }
  if (policy?.minimumOrderTotal != null && policy.minimumOrderTotal > finalTotalPrice) {
    finalTotalPrice = policy.minimumOrderTotal;
    controllingRule = "Minimum order total (owner, provisional)";
  }
  const achievedProfit = finalTotalPrice - totalCost;
  return {
    lines: priced,
    totalQuantity: activeLines.reduce((sum, line) => sum + line.quantity, 0),
    totalCost,
    finalTotalPrice,
    achievedProfit,
    achievedMarginPct: finalTotalPrice > 0 ? (achievedProfit / finalTotalPrice) * 100 : 0,
    controllingRule,
    blockers,
  };
}
