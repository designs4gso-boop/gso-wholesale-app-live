// Emergency Cost Calculator stabilization (14B.0). Pure, testable core for
// the provisional tier generator, margin floor, freight allocation, and the
// 2026-07-24 owner labor standards. No Prisma, no network. The calculator
// route computes through THIS module server-side (loader GET params + draft
// action re-evaluation) — never duplicated client-side.

import { percentToDivisor, applyWasteDivisor } from "./recipe-pricing.server";
import { blankItemUnitCostAtQty } from "./cost-calculator.server";
import { OWNER_STANDARDS } from "./owner-standards";

export const MARGIN_FLOOR_PCT = 40; // absolute minimum gross margin
export const OVERRIDE_PHRASE = "OWNER MARGIN OVERRIDE"; // exact, case-sensitive
// PROVISIONAL margin curve (owner, until competitor research): smallest ->
// highest approved tier. Editable per tier in the UI; floor always enforced.
export const PROVISIONAL_MARGIN_CURVE = [60, 55, 50, 45, 40];
export const SUGGESTED_QUANTITIES = [64, 128, 256, 640, 1000, 2000, 5000, 10000];

// Owner labor standards (verified 2026-07-24). Art+print setup are separate
// lines now (8.3333 + 1.00 = the previously wired 9.3333 combined value).
// 15B: values are WIRED to the shared owner-standards registry — edit them in
// app/lib/owner-standards.ts, never here (same numbers, one source).
export const OWNER_LABOR = {
  artSetupPerDesign: OWNER_STANDARDS.artSetupPerDesign.value, // $8.3333 — cut setup included here
  printSetupPerDesign: OWNER_STANDARDS.printSetupPerDesign.value, // $1.00
  weedingPerPage54x54: OWNER_STANDARDS.weedingPerPage54x54.value, // $1.3333 per 54x54in page
  jarApplicationPer: OWNER_STANDARDS.jarApplicationPerLabel.value, // $0.20
  bagLabelApplicationPer: OWNER_STANDARDS.bagApplicationPerLabel4x5.value, // $0.078125 per applied label
  packoutPerBox: OWNER_STANDARDS.packoutPerBox.value, // $2.00
};

// Verified material roll dimensions (inches x feet) — source labels, not math.
export const MATERIAL_ROLLS = {
  matte: { widthIn: 54, lengthFt: 150 },
  gloss: { widthIn: 54, lengthFt: 150 },
  holographic: { widthIn: 50, lengthFt: 164 },
  clear: { widthIn: 54, lengthFt: 50 },
  banner: { widthIn: 54, lengthFt: 150 },
};

// Verified ink $/ml. Mimaki clear/gloss is UNKNOWN — never guessed.
export const INK_RATES = {
  mimakiCmykPerMl: 176 / 1000,
  mimakiWhitePerMl: 176 / 1000,
  mimakiGlossPerMl: null as number | null, // MISSING — warn, never price
  rolandPerMl: 149 / 750, // owner-approved provisional: same across channels
};

export type SourceLabel = "verified" | "owner_standard" | "estimated" | "missing" | "manual_override";

// ---------- family-specific margin curves (14B.0A) ----------
// Source: GSO 2026 competitor and margin study (owner-approved). Five levels,
// smallest tier -> highest approved tier. Family minimum = normal floor for
// that family; the 40% GLOBAL floor stays absolute underneath.
export const MARGIN_RULE_SOURCE = "GSO 2026 competitor and margin study";
export type FamilyMarginRule = { key: string; label: string; curve: number[]; familyMinPct: number; aliases: string[] };
export const FAMILY_MARGIN_RULES: FamilyMarginRule[] = [
  { key: "bags-4x5", label: "4x5 sticker bags", curve: [65, 58, 52, 47, 45], familyMinPct: 45, aliases: ["4x5", "4x5-bags", "stock-bags", "stock-bag", "bag-4x5", "sticker-bags-4x5"] },
  { key: "chiron-jars", label: "Chiron jars", curve: [60, 55, 50, 45, 40], familyMinPct: 40, aliases: ["chiron", "chiron-jar", "safecare", "safecare-jars"] },
  { key: "miron-jars", label: "Miron jars", curve: [65, 58, 52, 47, 45], familyMinPct: 45, aliases: ["miron", "miron-jar", "jars", "jar"] },
  { key: "stickers-labels", label: "Standard stickers & labels", curve: [65, 58, 52, 46, 40], familyMinPct: 40, aliases: ["stickers", "labels", "sticker", "label", "die-cut-stickers"] },
  { key: "spot-gloss-labels", label: "Spot gloss labels", curve: [70, 62, 56, 50, 45], familyMinPct: 45, aliases: ["spot-gloss", "gloss-labels", "spot-gloss-label"] },
  { key: "banners", label: "Banners", curve: [60, 55, 50, 45, 40], familyMinPct: 40, aliases: ["banner"] },
  { key: "dtp-pouches", label: "DTP pouches", curve: [65, 58, 52, 46, 42], familyMinPct: 42, aliases: ["dtp", "pouches", "pouch", "dtp-pouch", "dtp-4x5x2"] },
  { key: "die-cut-bags", label: "Die-cut bags", curve: [68, 60, 55, 50, 45], familyMinPct: 45, aliases: ["diecut-bags", "die-cut-bag", "custom-bags"] },
  { key: "boxes", label: "Boxes", curve: [68, 60, 54, 48, 45], familyMinPct: 45, aliases: ["box"] },
];

function normalizeFamilyKey(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// EXACT normalized matching only — key or listed alias; never substring/fuzzy.
export function resolveMarginFamily(input: string | null | undefined): FamilyMarginRule | null {
  const normalized = normalizeFamilyKey(String(input || ""));
  if (!normalized) return null;
  return FAMILY_MARGIN_RULES.find((rule) => rule.key === normalized || rule.aliases.includes(normalized)) || null;
}

// Tier-count mapping (documented): 1 -> [last]; 2 -> [first,last];
// 3 -> [first,middle,last]; 4 -> positions 1,2,4,5; 5 -> all; >5 -> monotonic
// linear interpolation from first to last, never below the family minimum.
export function curveForTierCount(curve: number[], count: number, familyMinPct: number): number[] {
  const c = curve;
  if (count <= 0) return [];
  if (count === 1) return [c[4]];
  if (count === 2) return [c[0], c[4]];
  if (count === 3) return [c[0], c[2], c[4]];
  if (count === 4) return [c[0], c[1], c[3], c[4]];
  if (count === 5) return [...c];
  return Array.from({ length: count }, (_v, index) => {
    const t = index / (count - 1);
    const value = c[0] + (c[4] - c[0]) * t;
    return Math.max(familyMinPct, Math.round(value * 10) / 10);
  });
}

export type CostLine = { key: string; label: string; amount: number; source: SourceLabel; note?: string };

export function marginMath(totalCost: number, marginPct: number) {
  const price = totalCost / percentToDivisor(marginPct); // price = cost / (1 - margin)
  const profit = price - totalCost;
  const actualMarginPct = price > 0 ? (profit / price) * 100 : 0;
  return { price, profit, actualMarginPct };
}

export type MarginGate = { allowed: boolean; belowFloor: boolean; reason: string | null };

// 14B.0A: three distinct levels — target margin (curve), FAMILY minimum
// (override-able at/above 40), and the 40% GLOBAL hard floor (override-able
// only via the same explicit gate).
export function checkMarginGate(marginPct: number, override: { phrase: string; reason: string }, familyMinPct: number = MARGIN_FLOOR_PCT): MarginGate {
  const effectiveMin = Math.max(familyMinPct, MARGIN_FLOOR_PCT);
  if (marginPct >= effectiveMin) return { allowed: true, belowFloor: false, reason: null };
  const ok = override.phrase === OVERRIDE_PHRASE && override.reason.trim().length >= 5;
  const scope = marginPct < MARGIN_FLOOR_PCT ? `${MARGIN_FLOOR_PCT}% GLOBAL floor` : `${effectiveMin}% family minimum`;
  return {
    allowed: ok,
    belowFloor: true,
    reason: ok
      ? `OWNER OVERRIDE below the ${scope}: ${override.reason.trim()}`
      : `Below the ${scope} — blocked. Type "${OVERRIDE_PHRASE}" and give a reason to override.`,
  };
}

// ---------- freight (visible, never buried in supplier cost) ----------

export type FreightInput = {
  actualFreight: number;
  handling: number;
  otherFees: number;
  estimatedAllowance: number; // used ONLY when no actuals entered
  allocation: "per_unit" | "by_value" | "manual";
  manualPerUnit: number;
};

export function computeFreight(input: FreightInput, quantity: number, merchandiseTotal: number): {
  total: number; perUnit: number; source: SourceLabel; note: string;
} {
  const actual = input.actualFreight + input.handling + input.otherFees;
  const usingActual = actual > 0;
  const total = usingActual ? actual : input.estimatedAllowance;
  let perUnit = 0;
  if (input.allocation === "manual") perUnit = input.manualPerUnit;
  else if (input.allocation === "by_value" && merchandiseTotal > 0) perUnit = 0; // by-value spreads via cost share; per-unit figure below
  if (input.allocation === "per_unit" && quantity > 0) perUnit = total / quantity;
  if (input.allocation === "by_value" && quantity > 0 && merchandiseTotal > 0) perUnit = total / quantity; // same per-unit result for a single-line job; label explains basis
  return {
    total: input.allocation === "manual" ? perUnit * quantity : total,
    perUnit,
    source: usingActual ? "verified" : total > 0 ? "estimated" : "missing",
    note: usingActual ? "Actual entered freight/handling/fees." : total > 0 ? "ESTIMATED freight allowance — replace with actual invoice freight." : "No freight entered.",
  };
}

// ---------- provisional tier generation ----------

export type TierInput = {
  quantity: number;
  marginPct: number; // editable per tier; validated against floor at save
};

export type TierResult = {
  quantity: number;
  marginPct: number;
  unitCost: number;
  totalCost: number;
  setupPerUnit: number;
  blankUnitCost: number | null;
  unitPrice: number;
  totalPrice: number;
  profit: number;
  actualMarginPct: number;
  belowFloor: boolean;
  warnings: string[];
};

export function defaultTierMargins(count: number): number[] {
  // Map the provisional curve onto N tiers: last tier always 40, earlier
  // tiers walk the curve from 60 down.
  const curve = PROVISIONAL_MARGIN_CURVE;
  if (count <= 0) return [];
  if (count >= curve.length) {
    return Array.from({ length: count }, (_v, index) => {
      const fromEnd = count - 1 - index;
      return fromEnd < curve.length ? curve[curve.length - 1 - fromEnd] : curve[0];
    });
  }
  return curve.slice(curve.length - count);
}

// Each tier recalculates INDEPENDENTLY: setup spreads over that tier's
// quantity, blank cost uses the vendor tier for that quantity, per-unit costs
// stay per-unit. Never a discount off the first tier's price.
export function generateTiers(params: {
  tiers: TierInput[];
  perUnitVariableCost: number; // material+ink+labor+machine+freight per unit (already waste-adjusted)
  setupTotal: number; // art+print setup etc. — spread by quantity
  blankVendorRows: any[]; // VendorProductTier-like rows for qty-aware blank cost
  blankFallbackUnitCost: number | null;
  wastePct: number;
}): TierResult[] {
  return params.tiers
    .filter((tier) => tier.quantity > 0)
    .map((tier) => {
      const warnings: string[] = [];
      let blankUnit: number | null = null;
      if (params.blankVendorRows.length || params.blankFallbackUnitCost != null) {
        const resolved = blankItemUnitCostAtQty(params.blankVendorRows, params.blankFallbackUnitCost ?? 0, tier.quantity, "Blank");
        blankUnit = resolved.unitCost > 0 ? resolved.unitCost : params.blankFallbackUnitCost;
        if (resolved.warning) warnings.push(resolved.warning);
      }
      const blankAdjusted = blankUnit != null ? applyWasteDivisor(blankUnit, params.wastePct) : 0;
      if (blankUnit == null && params.blankFallbackUnitCost == null && params.blankVendorRows.length === 0) {
        // no blank required for this family — fine
      }
      const setupPerUnit = tier.quantity > 0 ? params.setupTotal / tier.quantity : 0;
      const unitCost = params.perUnitVariableCost + blankAdjusted + setupPerUnit;
      const totalCost = unitCost * tier.quantity;
      const { price, profit, actualMarginPct } = marginMath(unitCost, tier.marginPct);
      const belowFloor = tier.marginPct < MARGIN_FLOOR_PCT;
      if (belowFloor) warnings.push(`Margin ${tier.marginPct}% is below the ${MARGIN_FLOOR_PCT}% floor.`);
      return {
        quantity: tier.quantity,
        marginPct: tier.marginPct,
        unitCost,
        totalCost,
        setupPerUnit,
        blankUnitCost: blankUnit,
        unitPrice: price,
        totalPrice: price * tier.quantity,
        profit: profit * tier.quantity,
        actualMarginPct,
        belowFloor,
        warnings,
      };
    });
}

// ---------- missing-cost gate ----------

export function missingCostKeys(lines: CostLine[]): string[] {
  return lines.filter((line) => line.source === "missing").map((line) => line.key);
}

export function canFinalize(lines: CostLine[], gate: MarginGate): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const key of missingCostKeys(lines)) blockers.push(`COST NOT VERIFIED — OWNER REVIEW REQUIRED: ${key}`);
  if (!gate.allowed) blockers.push(gate.reason || "margin gate");
  return { ok: blockers.length === 0, blockers };
}
