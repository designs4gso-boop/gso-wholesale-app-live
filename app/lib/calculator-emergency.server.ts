// Emergency Cost Calculator stabilization (14B.0). Pure, testable core for
// the provisional tier generator, margin floor, freight allocation, and the
// 2026-07-24 owner labor standards. No Prisma, no network. The calculator
// route computes through THIS module server-side (loader GET params + draft
// action re-evaluation) — never duplicated client-side.

import { percentToDivisor, applyWasteDivisor } from "./recipe-pricing.server";
import { blankItemUnitCostAtQty } from "./cost-calculator.server";

export const MARGIN_FLOOR_PCT = 40; // absolute minimum gross margin
export const OVERRIDE_PHRASE = "OWNER MARGIN OVERRIDE"; // exact, case-sensitive
// PROVISIONAL margin curve (owner, until competitor research): smallest ->
// highest approved tier. Editable per tier in the UI; floor always enforced.
export const PROVISIONAL_MARGIN_CURVE = [60, 55, 50, 45, 40];
export const SUGGESTED_QUANTITIES = [64, 128, 256, 640, 1000, 2000, 5000, 10000];

// Owner labor standards (verified 2026-07-24). Art+print setup are separate
// lines now (8.3333 + 1.00 = the previously wired 9.3333 combined value).
export const OWNER_LABOR = {
  artSetupPerDesign: 25 / 3, // $8.3333 — cut setup included here
  printSetupPerDesign: 25 / 25, // $1.00
  weedingPerPage54x54: 20 / 15, // $1.3333 per 54x54in page
  jarApplicationPer: 20 / 100, // $0.20
  bagLabelApplicationPer: 20 / 256, // $0.078125 per applied label
  packoutPerBox: 20 / 10, // $2.00
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

export type CostLine = { key: string; label: string; amount: number; source: SourceLabel; note?: string };

export function marginMath(totalCost: number, marginPct: number) {
  const price = totalCost / percentToDivisor(marginPct); // price = cost / (1 - margin)
  const profit = price - totalCost;
  const actualMarginPct = price > 0 ? (profit / price) * 100 : 0;
  return { price, profit, actualMarginPct };
}

export type MarginGate = { allowed: boolean; belowFloor: boolean; reason: string | null };

export function checkMarginGate(marginPct: number, override: { phrase: string; reason: string }): MarginGate {
  if (marginPct >= MARGIN_FLOOR_PCT) return { allowed: true, belowFloor: false, reason: null };
  const ok = override.phrase === OVERRIDE_PHRASE && override.reason.trim().length >= 5;
  return {
    allowed: ok,
    belowFloor: true,
    reason: ok
      ? `OWNER OVERRIDE below the ${MARGIN_FLOOR_PCT}% floor: ${override.reason.trim()}`
      : `Below the ${MARGIN_FLOOR_PCT}% minimum margin — blocked. Type "${OVERRIDE_PHRASE}" and give a reason to override.`,
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
