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
  FAMILY_MARGIN_RULES,
  MARGIN_FLOOR_PCT,
  SUGGESTED_QUANTITIES,
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
export type AreaFloorBand = { maxSqft: number | null; ratePerSqft: number };
export const STICKER_MARKET_FLOOR_BANDS: AreaFloorBand[] = [
  { maxSqft: 10, ratePerSqft: 8.0 },
  { maxSqft: 25, ratePerSqft: 6.4 },
  { maxSqft: 50, ratePerSqft: 4.8 },
  { maxSqft: 62.5, ratePerSqft: 4.0 },
  { maxSqft: null, ratePerSqft: 3.2 },
];
// 15F.0K.1: bands default to the code constant — an ownerConfig caller passes
// its resolved bands; absent = byte-identical current behavior.
export function stickerMarketFloorRate(finishedSqft: number, bands: AreaFloorBand[] = STICKER_MARKET_FLOOR_BANDS): number {
  for (const band of bands) {
    if (band.maxSqft == null || finishedSqft < band.maxSqft) return band.ratePerSqft;
  }
  return bands[bands.length - 1].ratePerSqft;
}
// floor = area rate x finished sqft + full setup recovery (art + print per
// design) so multi-design jobs never eat setup out of the floor.
export function stickerMarketFloorPrice(finishedSqft: number, setupTotal: number, bands: AreaFloorBand[] = STICKER_MARKET_FLOOR_BANDS): number | null {
  if (!(finishedSqft > 0)) return null;
  return stickerMarketFloorRate(finishedSqft, bands) * finishedSqft + Math.max(0, setupTotal);
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

// ---------- 15F.0K.1: owner-config value plumbing ----------
// The pricing math stays pure: callers (the calculator route) resolve
// ownerConfig ONCE per request and pass the values in. When absent, the
// defaults below are built from the SAME constants as before, so behavior is
// byte-for-byte identical (test-pinned equivalence).
export type FamilyMoneyMap = Record<string, number | null>;

// ---------- 15F.0K.2-A: per-family margin bands + tier ladders ----------
// Band semantics: the LAST band whose minQty <= quantity wins. The Stage-A
// defaults translate the positional 5-point curves at the global edges
// [64,128,256,640,1000] EXACTLY: quantities 1-127 always took curve[0], so
// the equivalent band starts at minQty 1 (never 64) — proven old-vs-new at
// every boundary by tests/margin-curve-equivalence.test.ts.
export type MarginBand = { minQty: number; targetPct: number };
export type FamilyMarginCurveConfig = { familyMinPct: number; bands: MarginBand[] };
export type MarginCurvesValues = { families: Record<string, FamilyMarginCurveConfig> };
export type TierLaddersValues = { defaultLadder: number[]; families: Record<string, number[]> };

// Stage-A band starts equivalent to MARGIN_BAND_QUANTITIES [64,128,256,640,1000].
export const EQUIVALENT_BAND_MIN_QTYS = [1, 128, 256, 640, 1000];
// DTP margins price through dtpMarginPctForQuantity (code) — the dtp-pouches
// curve is deliberately NOT owner-configurable, and the provisional-universal
// fallback stays code-only by definition.
export const MARGIN_CURVE_EXCLUDED_KEYS = ["dtp-pouches", "provisional-universal"];
// Optional variant curve keys (Stage B data): resolution falls back to the
// base key when the variant has no config entry, so absence = base behavior.
export const MARGIN_CURVE_VARIANT_BASE: Record<string, string> = { "bags-4x5-double": "bags-4x5" };
export const MARGIN_CURVE_CONFIGURABLE_KEYS = FAMILY_MARGIN_RULES
  .map((rule) => rule.key)
  .filter((key) => !MARGIN_CURVE_EXCLUDED_KEYS.includes(key));

// ---------- 15F.0K.2-B: research-calibrated 4x5 bag curves ----------
// OWNER-APPROVED 2026-07-26 from the GSO competitor-pricing study (Stage B).
// DELIBERATE repricing of 4x5 sticker-applied bags ONLY: raises volume-tier
// margins that the study proved under-market (e.g. 1,000 single-sided
// $577.59 -> $705.95 at 55%). Band 1 stays 65% on BOTH curves so quantities
// 1-127 never reprice (the min-profit candidate controls the small-run zone;
// no Stage-B price ever DECREASES). familyMinPct stays 45; the 40% global
// floor is untouched; every other family keeps the Stage-A equivalent
// translation of its positional curve. The legacy positional
// FAMILY_MARGIN_RULES entry is deliberately unchanged (fallback-panel
// reference only — these bands are the live pricing path).
export const BAGS_4X5_SINGLE_BANDS: MarginBand[] = [
  { minQty: 1, targetPct: 65 }, { minQty: 128, targetPct: 64 }, { minQty: 256, targetPct: 61 },
  { minQty: 500, targetPct: 58 }, { minQty: 640, targetPct: 57 }, { minQty: 1000, targetPct: 55 },
  { minQty: 1500, targetPct: 52 }, { minQty: 5000, targetPct: 50 },
];
export const BAGS_4X5_DOUBLE_BANDS: MarginBand[] = [
  { minQty: 1, targetPct: 65 }, { minQty: 128, targetPct: 61 }, { minQty: 256, targetPct: 58 },
  { minQty: 500, targetPct: 54 }, { minQty: 1000, targetPct: 52 },
  { minQty: 1500, targetPct: 49 }, { minQty: 5000, targetPct: 47 },
];
// Approved 11-point display ladder for sticker bags (display only — margins
// come from the quantity bands at ANY requested quantity).
export const STICKER_BAG_DISPLAY_LADDER = [64, 128, 256, 500, 640, 1000, 1500, 2000, 2500, 5000, 10000];

export function defaultMarginCurvesValues(): MarginCurvesValues {
  const families: Record<string, FamilyMarginCurveConfig> = {};
  for (const rule of FAMILY_MARGIN_RULES) {
    if (MARGIN_CURVE_EXCLUDED_KEYS.includes(rule.key)) continue;
    families[rule.key] = {
      familyMinPct: rule.familyMinPct,
      bands: rule.curve.map((targetPct, index) => ({ minQty: EQUIVALENT_BAND_MIN_QTYS[index] ?? EQUIVALENT_BAND_MIN_QTYS[EQUIVALENT_BAND_MIN_QTYS.length - 1], targetPct })),
    };
  }
  // 15F.0K.2-B: owner-approved research calibration replaces the Stage-A
  // translation for 4x5 bags (single + the new double-sided variant).
  families["bags-4x5"] = { familyMinPct: 45, bands: BAGS_4X5_SINGLE_BANDS.map((band) => ({ ...band })) };
  families["bags-4x5-double"] = { familyMinPct: 45, bands: BAGS_4X5_DOUBLE_BANDS.map((band) => ({ ...band })) };
  return { families };
}

// Display defaults: the long-standing family-blind [64,128,256,640,1000]
// (SUGGESTED_QUANTITIES.slice(0,5)) — except sticker-bags, which uses the
// owner-approved 11-point research ladder (15F.0K.2-B). The DTP ladder stays
// DTP_LADDER_QUANTITIES in code and is NOT configurable here.
export function defaultTierLaddersValues(): TierLaddersValues {
  const ladder = SUGGESTED_QUANTITIES.slice(0, 5);
  const families: Record<string, number[]> = {};
  for (const policy of FAMILY_COMMERCIAL_POLICIES) families[policy.familyKey] = [...ladder];
  families["sticker-bags"] = [...STICKER_BAG_DISPLAY_LADDER];
  return { defaultLadder: [...ladder], families };
}

export function marginPctForQuantityBands(config: FamilyMarginCurveConfig, quantity: number): number {
  const qty = Math.max(1, Math.floor(quantity));
  let pct = config.bands.length ? config.bands[0].targetPct : config.familyMinPct;
  for (const band of config.bands) {
    if (qty >= band.minQty) pct = band.targetPct;
  }
  return Math.max(pct, config.familyMinPct);
}

// Single/double-sided 4x5 bags: the double variant key applies only when the
// job actually prints two faces. With no "bags-4x5-double" config entry
// (Stage A defaults) resolution falls back to bags-4x5 — sides price
// identically, exactly today's behavior (test-pinned).
export function marginCurveKeyFor(ruleKey: string | null | undefined, facesPerUnit: number): string | null {
  const key = String(ruleKey || "") || null;
  if (key === "bags-4x5" && Math.floor(facesPerUnit) >= 2) return "bags-4x5-double";
  return key;
}

export function marginCurveConfigFor(values: PricingPolicyValues, curveKey: string | null | undefined): FamilyMarginCurveConfig | null {
  const key = String(curveKey || "") || null;
  if (!key) return null;
  const direct = values.marginCurves.families[key];
  if (direct) return direct;
  const base = MARGIN_CURVE_VARIANT_BASE[key];
  return base ? values.marginCurves.families[base] ?? null : null;
}

// ONE margin resolution used by computeCommercialPrice AND the route's tier
// defaults (no drift): config bands when the key has an entry -> legacy
// positional rule math -> 40% floor.
export function resolveMarginPctForQuantity(
  values: PricingPolicyValues,
  curveKey: string | null | undefined,
  rule: FamilyMarginRule | null,
  quantity: number,
): number {
  const config = marginCurveConfigFor(values, curveKey ?? rule?.key ?? null);
  if (config) return marginPctForQuantityBands(config, quantity);
  if (rule) return marginPctForQuantity(rule, quantity);
  return Math.max(MARGIN_FLOOR_PCT, 40);
}

export type PricingPolicyValues = {
  minimumGrossProfit: FamilyMoneyMap;
  minimumOrderTotals: FamilyMoneyMap;
  // K.1: unit-price floors stay all-null (current behavior) — the resolver
  // never reads a config key for them until unit floors are activated.
  minimumUnitPrices: FamilyMoneyMap;
  areaFloorBands: AreaFloorBand[];
  // 15F.0K.2-A: per-family margin bands + display tier ladders.
  marginCurves: MarginCurvesValues;
  tierLadders: TierLaddersValues;
};

export function defaultPricingPolicyValues(): PricingPolicyValues {
  const minimumGrossProfit: FamilyMoneyMap = {};
  const minimumOrderTotals: FamilyMoneyMap = {};
  const minimumUnitPrices: FamilyMoneyMap = {};
  for (const policy of FAMILY_COMMERCIAL_POLICIES) {
    minimumGrossProfit[policy.familyKey] = policy.minimumGrossProfit;
    minimumOrderTotals[policy.familyKey] = policy.minimumOrderTotal;
    minimumUnitPrices[policy.familyKey] = policy.minimumUnitPrice;
  }
  return {
    minimumGrossProfit,
    minimumOrderTotals,
    minimumUnitPrices,
    areaFloorBands: STICKER_MARKET_FLOOR_BANDS.map((band) => ({ ...band })),
    marginCurves: defaultMarginCurvesValues(),
    tierLadders: defaultTierLaddersValues(),
  };
}

const DEFAULT_PRICING_POLICY_VALUES = defaultPricingPolicyValues();

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
  // 15F.0K.1: ownerConfig-resolved policy values. Absent = code constants
  // (byte-identical behavior, equivalence test-pinned).
  policyValues?: PricingPolicyValues;
  // 15F.0K.2-A: explicit curve key for variant lookups (bags single vs
  // double). Absent = the margin rule's own key; a variant with no config
  // entry falls back to its base key, then to the positional rule math.
  marginCurveKey?: string | null;
}): CommercialPriceResult {
  const quantity = Math.max(1, Math.floor(input.quantity));
  const completeCost = Math.max(0, input.completeCost);
  const values = input.policyValues ?? DEFAULT_PRICING_POLICY_VALUES;
  const policy = {
    minimumGrossProfit: values.minimumGrossProfit[input.familyKey] ?? null,
    minimumOrderTotal: values.minimumOrderTotals[input.familyKey] ?? null,
    minimumUnitPrice: values.minimumUnitPrices[input.familyKey] ?? null,
  };
  const rule = input.marginRule;
  const premiumRule = input.premiumEligible ? resolveMarginFamily(PREMIUM_FINISH_MARGIN_KEY) : null;
  // 15F.0K.2-A: one shared resolution (config bands -> positional rule -> 40).
  const curveKey = input.marginCurveKey ?? rule?.key ?? null;
  const curveConfig = marginCurveConfigFor(values, curveKey);

  const baseMarginPct = input.marginPctOverride != null && Number.isFinite(input.marginPctOverride) && input.marginPctOverride > 0
    ? input.marginPctOverride
    : resolveMarginPctForQuantity(values, curveKey, rule, quantity);
  const marginSource = input.marginPctOverride != null && Number.isFinite(input.marginPctOverride) && input.marginPctOverride > 0
    ? "owner per-tier margin edit (Advanced Pricing Controls)"
    : rule
      ? `${rule.label} researched curve at quantity band (${COMMERCIAL_PRICING_SOURCE})`
      : `provisional universal curve — FAMILY MARGIN RULE NOT CONFIGURED (${MARGIN_FLOOR_PCT}% floor)`;

  const costBasedPrice = marginMath(completeCost, baseMarginPct).price;
  // Family minimum: config entry wins when present (Stage-A defaults carry
  // the identical familyMinPct values), else the rule constant.
  const floorPct = Math.max(curveConfig?.familyMinPct ?? rule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT);
  const marginFloorPrice = marginMath(completeCost, floorPct).price;
  const premiumConfig = premiumRule ? marginCurveConfigFor(values, PREMIUM_FINISH_MARGIN_KEY) : null;
  const premiumFinishFloorPrice = premiumRule
    ? marginMath(completeCost, Math.max(
        resolveMarginPctForQuantity(values, PREMIUM_FINISH_MARGIN_KEY, premiumRule, quantity),
        premiumConfig?.familyMinPct ?? premiumRule.familyMinPct,
      )).price
    : null;
  const suppress = Boolean(input.suppressJobMinimums);
  const minimumGrossProfitPrice = !suppress && policy?.minimumGrossProfit != null ? completeCost + policy.minimumGrossProfit : null;
  const minimumOrderTotalPrice = !suppress && policy?.minimumOrderTotal != null ? policy.minimumOrderTotal : null;
  const minimumUnitPriceTotal = !suppress && policy?.minimumUnitPrice != null ? policy.minimumUnitPrice * quantity : null;
  // 15F.0-FINAL-A: the sticker AREA market floor fills the market-ladder
  // candidate slot for stickers & labels (provisional research anchors).
  const ownerMarketLadderPrice = input.ownerMarketLadderTotal
    ?? (input.familyKey === "stickers-labels" ? stickerMarketFloorPrice(input.finishedSqft ?? 0, input.setupTotal ?? 0, values.areaFloorBands) : null);

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

// 15F.0J.2-A: deterministic ADDITIONAL-line count normalization. The field
// counts ADDITIONAL lines (the primary sticker form is ALWAYS Line 1);
// 0/blank = single-line job. "01" parses to exactly 1 additional line —
// never ignored. Invalid values are REJECTED with a message, never clamped
// silently.
export const MAX_ADDITIONAL_STICKER_LINES = 8;
export function normalizeAdditionalLineCount(raw: string | null | undefined): { count: number; error: string | null } {
  const text = String(raw ?? "").trim();
  if (text === "") return { count: 0, error: null }; // multi-line not enabled
  const value = Number(text);
  if (!Number.isFinite(value)) return { count: 0, error: `Number of additional lines "${text}" is not a number.` };
  const count = Math.floor(value);
  if (count < 0) return { count: 0, error: "Number of additional lines cannot be negative." };
  if (count > MAX_ADDITIONAL_STICKER_LINES) return { count: 0, error: `Number of additional lines cannot exceed ${MAX_ADDITIONAL_STICKER_LINES}.` };
  return { count, error: null };
}

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
  const count = Math.min(Math.max(0, Math.floor(params.count || 0)), MAX_ADDITIONAL_STICKER_LINES);
  return Array.from({ length: count }, (_v, index) => ({
    name: String(params.names[index] || `Line ${index + 2}`).slice(0, 80), // additional lines start at Line 2 (primary = Line 1)
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

// 15F.0J.2-C: field-level validation for an ACTIVE line. An active line that
// fails validation must surface these errors and BLOCK — never be silently
// dropped from the calculation.
export function validateStickerLine(line: StickerLineInput): string[] {
  const errors: string[] = [];
  if (!(line.quantity > 0)) errors.push("Quantity is required (must be greater than 0).");
  if (!(line.designs > 0)) errors.push("Designs is required (must be at least 1).");
  if (!(line.widthIn > 0)) errors.push("Width (in) is required.");
  if (!(line.heightIn > 0)) errors.push("Height (in) is required.");
  if (!line.materialId) errors.push("Material is required.");
  return errors;
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
    // 15F.0J.2-C: field-level validation errors (validateStickerLine). A line
    // with errors is NEVER silently dropped: it contributes $0 but forces
    // job-level blockers until fixed or removed.
    fieldErrors?: string[];
    // 15F.0-FINAL: per-line area + setup feed the sticker market floor
    finishedSqft?: number;
    setupTotal?: number;
  }>;
  jobPackingCost: number;
  marginRule: FamilyMarginRule | null;
  // 15F.0K.1: ownerConfig-resolved policy values (absent = code constants).
  policyValues?: PricingPolicyValues;
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
  // 15F.0J.2: NO silent quantity filter — every passed line either prices
  // (valid) or blocks (invalid). Callers pass only ACTIVE lines.
  const invalidBlockers = input.lines.flatMap((line) =>
    (line.fieldErrors && line.fieldErrors.length ? line.fieldErrors : line.quantity > 0 ? [] : ["Quantity is required (must be greater than 0)."])
      .map((reason) => `${line.name}: ${reason}`));
  const activeLines = input.lines.filter((line) => line.quantity > 0 && !(line.fieldErrors && line.fieldErrors.length));
  const directTotal = activeLines.reduce((sum, line) => sum + line.lineCost, 0);
  const blockers = [
    ...invalidBlockers,
    ...activeLines.flatMap((line) => line.missing.map((reason) => `${line.name}: ${reason}`)),
  ];
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
      policyValues: input.policyValues,
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
  const values = input.policyValues ?? DEFAULT_PRICING_POLICY_VALUES;
  const jobMinimumGrossProfit = values.minimumGrossProfit["stickers-labels"] ?? null;
  const jobMinimumOrderTotal = values.minimumOrderTotals["stickers-labels"] ?? null;
  let finalTotalPrice = lineSum;
  let controllingRule = "Sum of per-line commercial prices";
  if (jobMinimumGrossProfit != null && totalCost + jobMinimumGrossProfit > finalTotalPrice) {
    finalTotalPrice = totalCost + jobMinimumGrossProfit;
    controllingRule = "Minimum gross-profit floor (owner, provisional) on the combined job";
  }
  if (jobMinimumOrderTotal != null && jobMinimumOrderTotal > finalTotalPrice) {
    finalTotalPrice = jobMinimumOrderTotal;
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
