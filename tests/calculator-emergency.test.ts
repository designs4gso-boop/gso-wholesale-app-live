import { describe, expect, it } from "vitest";

import {
  INK_RATES,
  MARGIN_FLOOR_PCT,
  MATERIAL_ROLLS,
  OVERRIDE_PHRASE,
  OWNER_LABOR,
  PROVISIONAL_MARGIN_CURVE,
  canFinalize,
  checkMarginGate,
  computeFreight,
  defaultTierMargins,
  generateTiers,
  marginMath,
  type CostLine,
} from "../app/lib/calculator-emergency.server";
import { suggestedPriceFromMargin } from "../app/lib/cost-calculator.server";
import { MACHINE_RATE_CURRENT } from "../app/lib/rip-actual-costs-shared";
import { percentToDivisor } from "../app/lib/recipe-pricing.server";

describe("owner standards and verified rates (14B.0)", () => {
  it("labor standards match the 2026-07-24 owner numbers", () => {
    expect(OWNER_LABOR.artSetupPerDesign).toBeCloseTo(8.3333, 3);
    expect(OWNER_LABOR.printSetupPerDesign).toBe(1);
    expect(OWNER_LABOR.weedingPerPage54x54).toBeCloseTo(1.3333, 3);
    expect(OWNER_LABOR.jarApplicationPer).toBeCloseTo(0.2, 6);
    expect(OWNER_LABOR.bagLabelApplicationPer).toBeCloseTo(0.078125, 6);
    expect(OWNER_LABOR.packoutPerBox).toBe(2);
    expect(MACHINE_RATE_CURRENT).toBe(8);
  });

  it("ink rates: Mimaki verified, Roland provisional-uniform, Mimaki gloss MISSING (never guessed)", () => {
    expect(INK_RATES.mimakiCmykPerMl).toBeCloseTo(0.176, 6);
    expect(INK_RATES.mimakiWhitePerMl).toBeCloseTo(0.176, 6);
    expect(INK_RATES.rolandPerMl).toBeCloseTo(149 / 750, 9);
    expect(INK_RATES.mimakiGlossPerMl).toBeNull();
  });

  it("material roll dimensions are recorded per owner spec", () => {
    expect(MATERIAL_ROLLS.matte).toEqual({ widthIn: 54, lengthFt: 150 });
    expect(MATERIAL_ROLLS.holographic).toEqual({ widthIn: 50, lengthFt: 164 });
    expect(MATERIAL_ROLLS.clear).toEqual({ widthIn: 54, lengthFt: 50 });
  });
});

describe("margin math and floor", () => {
  it("uses margin-as-divisor (never markup) and matches the calculator helper (engine equality)", () => {
    const { price, actualMarginPct } = marginMath(60, 40);
    expect(price).toBeCloseTo(100, 6); // 60 / (1 - 0.40)
    expect(actualMarginPct).toBeCloseTo(40, 6);
    expect(suggestedPriceFromMargin(60, 40)).toBeCloseTo(price, 6); // same math as the calculator/engine path
    expect(60 / percentToDivisor(40)).toBeCloseTo(price, 6);
  });

  it("blocks below 40% without the exact override phrase + reason; allows with them", () => {
    expect(checkMarginGate(45, { phrase: "", reason: "" }).allowed).toBe(true);
    const blocked = checkMarginGate(35, { phrase: "", reason: "" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.belowFloor).toBe(true);
    expect(checkMarginGate(35, { phrase: "owner margin override", reason: "match competitor" }).allowed).toBe(false); // case-sensitive
    const allowed = checkMarginGate(35, { phrase: OVERRIDE_PHRASE, reason: "match competitor quote" });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toContain("OWNER OVERRIDE");
  });
});

describe("provisional tier generation", () => {
  const vendorRows = [
    { minQty: 1, maxQty: 499, unitCost: 2.0 },
    { minQty: 500, maxQty: null, unitCost: 1.5 },
  ];

  it("five-level provisional curve maps onto tiers with the highest tier at 40%", () => {
    expect(defaultTierMargins(5)).toEqual(PROVISIONAL_MARGIN_CURVE);
    expect(defaultTierMargins(3)).toEqual([50, 45, 40]);
    expect(defaultTierMargins(8).slice(-5)).toEqual(PROVISIONAL_MARGIN_CURVE);
    expect(defaultTierMargins(8)[0]).toBe(60);
  });

  it("setup spreads by quantity and vendor blank cost is quantity-aware — each tier independent", () => {
    const tiers = generateTiers({
      tiers: [{ quantity: 100, marginPct: 60 }, { quantity: 1000, marginPct: 40 }],
      perUnitVariableCost: 0.5,
      setupTotal: 100,
      blankVendorRows: vendorRows,
      blankFallbackUnitCost: null,
      wastePct: 0,
    });
    expect(tiers[0].setupPerUnit).toBeCloseTo(1, 6); // 100/100
    expect(tiers[1].setupPerUnit).toBeCloseTo(0.1, 6); // 100/1000
    expect(tiers[0].blankUnitCost).toBeCloseTo(2.0, 6); // vendor tier <500
    expect(tiers[1].blankUnitCost).toBeCloseTo(1.5, 6); // vendor tier 500+
    expect(tiers[0].unitCost).toBeCloseTo(0.5 + 2.0 + 1, 6);
    expect(tiers[1].unitCost).toBeCloseTo(0.5 + 1.5 + 0.1, 6);
    // price is computed from each tier's own cost+margin, never a discount off tier 1:
    expect(tiers[1].unitPrice).toBeCloseTo(tiers[1].unitCost / (1 - 0.4), 6);
    expect(tiers[0].unitPrice).toBeCloseTo(tiers[0].unitCost / (1 - 0.6), 6);
    expect(tiers[0].actualMarginPct).toBeCloseTo(60, 4);
  });

  it("a tier edited below the floor is flagged, never silent", () => {
    const [tier] = generateTiers({
      tiers: [{ quantity: 100, marginPct: 30 }],
      perUnitVariableCost: 1, setupTotal: 0, blankVendorRows: [], blankFallbackUnitCost: 0.09, wastePct: 0,
    });
    expect(tier.belowFloor).toBe(true);
    expect(tier.warnings.some((warning) => warning.includes("below the 40%"))).toBe(true);
    expect(tier.blankUnitCost).toBeCloseTo(0.09, 6); // 4x5 bag flat blank
  });
});

describe("freight", () => {
  it("actual freight wins over the allowance and allocates per unit", () => {
    const actual = computeFreight({ actualFreight: 280, handling: 20, otherFees: 0, estimatedAllowance: 300, allocation: "per_unit", manualPerUnit: 0 }, 1000, 5000);
    expect(actual.total).toBe(300);
    expect(actual.perUnit).toBeCloseTo(0.3, 6);
    expect(actual.source).toBe("verified");
  });

  it("estimated allowance is labeled ESTIMATED; by-value and manual allocations work", () => {
    const estimated = computeFreight({ actualFreight: 0, handling: 0, otherFees: 0, estimatedAllowance: 290, allocation: "by_value", manualPerUnit: 0 }, 500, 2000);
    expect(estimated.source).toBe("estimated");
    expect(estimated.note).toContain("ESTIMATED");
    expect(estimated.perUnit).toBeCloseTo(290 / 500, 6);
    const manual = computeFreight({ actualFreight: 0, handling: 0, otherFees: 0, estimatedAllowance: 0, allocation: "manual", manualPerUnit: 0.25 }, 100, 0);
    expect(manual.perUnit).toBe(0.25);
    expect(manual.total).toBeCloseTo(25, 6);
  });
});

describe("missing-cost gate", () => {
  const lines: CostLine[] = [
    { key: "blank", label: "Blank bag", amount: 0.09, source: "verified" },
    { key: "mimaki_gloss_ink", label: "Gloss ink", amount: 0, source: "missing" },
  ];

  it("missing required cost blocks finalization with the exact banner text; draft with warnings remains possible", () => {
    const gate = checkMarginGate(45, { phrase: "", reason: "" });
    const verdict = canFinalize(lines, gate);
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers.some((blocker) => blocker.includes("COST NOT VERIFIED — OWNER REVIEW REQUIRED"))).toBe(true);
    const clean = canFinalize([lines[0]], gate);
    expect(clean.ok).toBe(true);
  });

  it("margin gate failure also blocks finalization", () => {
    const verdict = canFinalize([lines[0]], checkMarginGate(30, { phrase: "", reason: "" }));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers.some((blocker) => blocker.includes("40%"))).toBe(true);
  });
});
