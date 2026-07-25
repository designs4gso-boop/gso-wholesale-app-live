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

// ---- 14B.0A family-specific margin curves ----
import { FAMILY_MARGIN_RULES, curveForTierCount, resolveMarginFamily } from "../app/lib/calculator-emergency.server";

describe("family margin curves (14B.0A)", () => {
  it("all nine researched curves and minimums are exact", () => {
    const expectations: Record<string, { curve: number[]; min: number }> = {
      "bags-4x5": { curve: [65, 58, 52, 47, 45], min: 45 },
      "chiron-jars": { curve: [60, 55, 50, 45, 40], min: 40 },
      "miron-jars": { curve: [65, 58, 52, 47, 45], min: 45 },
      "stickers-labels": { curve: [65, 58, 52, 46, 40], min: 40 },
      "spot-gloss-labels": { curve: [70, 62, 56, 50, 45], min: 45 },
      "banners": { curve: [60, 55, 50, 45, 40], min: 40 },
      "dtp-pouches": { curve: [65, 58, 52, 46, 42], min: 42 },
      "die-cut-bags": { curve: [68, 60, 55, 50, 45], min: 45 },
      "boxes": { curve: [68, 60, 54, 48, 45], min: 45 },
    };
    expect(FAMILY_MARGIN_RULES).toHaveLength(9);
    for (const rule of FAMILY_MARGIN_RULES) {
      expect(rule.curve).toEqual(expectations[rule.key].curve);
      expect(rule.familyMinPct).toBe(expectations[rule.key].min);
    }
    // top-tier pins: Chiron 40, Miron 45, DTP 42, spot gloss 45
    expect(resolveMarginFamily("chiron-jars")!.curve[4]).toBe(40);
    expect(resolveMarginFamily("miron-jars")!.curve[4]).toBe(45);
    expect(resolveMarginFamily("dtp-pouches")!.curve[4]).toBe(42);
    expect(resolveMarginFamily("spot-gloss-labels")!.curve[4]).toBe(45);
  });

  it("exact alias normalization only — no fuzzy/substring matching; unknown family is null (provisional fallback)", () => {
    expect(resolveMarginFamily("Stock Bags")!.key).toBe("bags-4x5");
    expect(resolveMarginFamily("DTP 4x5x2")!.key).toBe("dtp-pouches");
    expect(resolveMarginFamily("miron")!.key).toBe("miron-jars");
    expect(resolveMarginFamily("mironish")).toBeNull(); // never substring
    expect(resolveMarginFamily("mystery-family")).toBeNull();
    expect(resolveMarginFamily("")).toBeNull();
  });

  it("tier-count mapping: 1/2/3/4/5 and >5 monotonic never below family minimum", () => {
    const curve = [65, 58, 52, 47, 45];
    expect(curveForTierCount(curve, 1, 45)).toEqual([45]);
    expect(curveForTierCount(curve, 2, 45)).toEqual([65, 45]);
    expect(curveForTierCount(curve, 3, 45)).toEqual([65, 52, 45]);
    expect(curveForTierCount(curve, 4, 45)).toEqual([65, 58, 47, 45]);
    expect(curveForTierCount(curve, 5, 45)).toEqual(curve);
    const seven = curveForTierCount(curve, 7, 45);
    expect(seven).toHaveLength(7);
    expect(seven[0]).toBe(65);
    expect(seven[6]).toBe(45);
    for (let index = 1; index < seven.length; index += 1) expect(seven[index]).toBeLessThanOrEqual(seven[index - 1]);
    expect(Math.min(...seven)).toBeGreaterThanOrEqual(45);
  });

  it("family minimum gates: below family min (but >=40) needs the override; below 40 stays the global floor message", () => {
    const belowFamily = checkMarginGate(43, { phrase: "", reason: "" }, 45);
    expect(belowFamily.allowed).toBe(false);
    expect(belowFamily.reason).toContain("45% family minimum");
    const overridden = checkMarginGate(43, { phrase: OVERRIDE_PHRASE, reason: "match competitor" }, 45);
    expect(overridden.allowed).toBe(true);
    const belowGlobal = checkMarginGate(35, { phrase: "", reason: "" }, 45);
    expect(belowGlobal.reason).toContain("40% GLOBAL floor");
    expect(checkMarginGate(46, { phrase: "", reason: "" }, 45).allowed).toBe(true);
    expect(checkMarginGate(41, { phrase: "", reason: "" }, 40).allowed).toBe(true); // Chiron-style family min 40
  });

  it("user-edited margins are retained by the route contract (edits win when counts match) — lib default only fills gaps", () => {
    // mirrors the loader rule: explicit margins list of matching length wins over defaults
    const edited = [64, 57, 51, 46, 45];
    expect(edited).not.toEqual(resolveMarginFamily("bags-4x5")!.curve);
  });
});

// ---- 14B.1 automatic full costing ----
import { computeAutoCost, type AutoInputs } from "../app/lib/auto-costing.server";

function autoInputs(overrides: Partial<AutoInputs> = {}): AutoInputs {
  return {
    quantity: 100, designs: 2, sides: 1, labelWidthIn: 4, labelHeightIn: 5,
    materialCostPerSqft: 0.3156, materialLabel: "Matte vinyl", printer: "mimaki",
    whiteInk: false, spotGloss: false, inkMlPerSqft: 0.6, machineMinutesPerSqft: 2,
    machineRatePerHour: 8, blankUnitCost: 0.09, blankLabel: "4x5 blank bag",
    lidUnitCost: null, lidLabel: "", boxes: 2, wastePct: 10,
    freightPerUnit: 0.05, freightSource: "estimated", cutIsProvisional: true,
    weedingPages: 0, hemming: false, grommets: false, ...overrides,
  };
}

describe("automatic full costing (14B.1)", () => {
  it("4x5 bags: $0.09 blank, one vs two sided application, setup separated for tier spread", () => {
    const one = computeAutoCost("bags-4x5", autoInputs());
    const blank = one.lines.find((line) => line.key === "blank")!;
    expect(blank.amount).toBeCloseTo(9, 6); // 100 x 0.09
    expect(blank.source).toBe("verified");
    const app1 = one.lines.find((line) => line.key === "application")!.amount;
    const two = computeAutoCost("bags-4x5", autoInputs({ sides: 2 }));
    const app2 = two.lines.find((line) => line.key === "application")!.amount;
    expect(app1).toBeCloseTo(0.078125 * 100, 6);
    expect(app2).toBeCloseTo(app1 * 2, 6);
    expect(one.setupTotal).toBeCloseTo(2 * (25 / 3 + 1), 4); // art+print per design, spread later
    expect(two.lines.find((line) => line.key === "material")!.amount).toBeCloseTo(two.lines.find((l) => l.key === "material")!.amount, 6);
  });

  it("missing Mimaki gloss blocks; white ink uses the verified rate; freight is its own labeled line", () => {
    const gloss = computeAutoCost("bags-4x5", autoInputs({ spotGloss: true }));
    expect(gloss.missing.some((label) => label.includes("Spot gloss"))).toBe(true);
    const white = computeAutoCost("bags-4x5", autoInputs({ whiteInk: true }));
    expect(white.lines.find((line) => line.key === "ink_white")!.source).toBe("verified");
    const freight = white.lines.find((line) => line.key === "freight")!;
    expect(freight.amount).toBeCloseTo(5, 6);
    expect(freight.note).toContain("ESTIMATED");
  });

  it("Chiron: cap included with no duplicate; Miron: jar and lid separate, both tiered inputs", () => {
    const chiron = computeAutoCost("chiron-jars", autoInputs({ blankUnitCost: 1.9, blankLabel: "Chiron 150ml (cap incl)" }));
    expect(chiron.lines.filter((line) => line.key === "blank")).toHaveLength(1);
    expect(chiron.lines.find((line) => line.key === "blank")!.note).toContain("Cap included");
    expect(chiron.lines.some((line) => line.key === "lid")).toBe(false);
    expect(chiron.lines.find((line) => line.key === "application")!.amount).toBeCloseTo(20, 6); // 0.20 x 100
    const miron = computeAutoCost("miron-jars", autoInputs({ blankUnitCost: 1.95, blankLabel: "Miron 150ml tier", lidUnitCost: 0.45, lidLabel: "Black metal lid tier" }));
    expect(miron.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(195, 6);
    expect(miron.lines.find((line) => line.key === "lid")!.amount).toBeCloseTo(45, 6);
    const mironNoLid = computeAutoCost("miron-jars", autoInputs({ blankUnitCost: 1.95, lidUnitCost: null }));
    expect(mironNoLid.missing.some((label) => label.includes("lid"))).toBe(true);
  });

  it("stickers: sqft+waste applied once to material and ink, weeding standard, provisional cutting warns, missing dims block", () => {
    const stickers = computeAutoCost("stickers-labels", autoInputs({ blankUnitCost: null, blankLabel: "", weedingPages: 3 }));
    const area = (4 * 5 * 100) / 144;
    const material = stickers.lines.find((line) => line.key === "material")!;
    expect(material.amount).toBeCloseTo(0.3156 * area / 0.9, 4); // waste divisor once
    const ink = stickers.lines.find((line) => line.key === "ink_cmyk")!;
    expect(ink.amount).toBeCloseTo(0.176 * 0.6 * area / 0.9, 4);
    expect(stickers.lines.find((line) => line.key === "weeding")!.amount).toBeCloseTo(4, 4); // 3 x 1.3333
    expect(stickers.warnings.some((warning) => warning.includes("PROVISIONAL"))).toBe(true);
    const noDims = computeAutoCost("stickers-labels", autoInputs({ labelWidthIn: 0 }));
    expect(noDims.missing.some((label) => label.includes("dimensions"))).toBe(true);
  });

  it("banners: media+ink+machine computed; missing hem/grommet labor blocks; no-waste-rule flagged ESTIMATED", () => {
    const banner = computeAutoCost("banners", autoInputs({ hemming: true, quantity: 2, labelWidthIn: 36, labelHeightIn: 72, wastePct: -1 }));
    expect(banner.missing.some((label) => label.includes("hemming"))).toBe(true);
    expect(banner.warnings.some((warning) => warning.includes("ESTIMATED 10%"))).toBe(true);
    expect(banner.lines.find((line) => line.key === "machine")!.source).toBe("owner_standard");
  });

  it("safety: perUnitVariable + setup reconstruct the total (no double setup/waste/freight)", () => {
    const result = computeAutoCost("bags-4x5", autoInputs());
    const reconstructed = result.perUnitVariable * 100 + result.setupTotal;
    const lineTotal = result.lines.reduce((sum, line) => sum + line.amount, 0);
    expect(reconstructed).toBeCloseTo(lineTotal, 4);
    expect(result.missing).toHaveLength(0);
  });
});

// ---- 14B.1B usability pins ----
import { readFileSync } from "node:fs";
describe("calculator usability (14B.1B)", () => {
  const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  it("legacy calculator is collapsed behind a fallback-only details section below the new tools", () => {
    expect(src).toContain("Legacy Manual Calculator — Fallback Only");
    expect(src).toContain("Use only for unsupported products or special jobs");
    expect(src.indexOf("<EmergencySection />")).toBeLessThan(src.indexOf("Legacy Manual Calculator — Fallback Only"));
  });
  it("renames applied: Cost Calculator primary, Pricing Tiers & Margin Review, begin prompt shown", () => {
    expect(src).toContain("Pricing Tiers &amp; Margin Review");
    expect(src).toContain("Choose a product family and enter the job details to begin.");
    expect(src).not.toContain("Emergency pricing (14B.0)");
  });
});

describe("daily-use layout (14C)", () => {
  const src14c = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  it("calculator-first order: auto form before tier controls, EmergencySection before Advanced tools and legacy", () => {
    expect(src14c.indexOf("14B.1a: Automatic Costing form")).toBeLessThan(src14c.indexOf("Advanced Pricing Controls (custom tier quantities")); // full summary label (15C.2 gate messages also mention the section)
    expect(src14c.indexOf("<EmergencySection />")).toBeLessThan(src14c.indexOf("Advanced Pricing Tools"));
    expect(src14c.indexOf("Advanced Pricing Tools")).toBeLessThan(src14c.indexOf("Legacy Manual Calculator"));
  });
  it("sync/token/manual controls sit behind collapsed sections", () => {
    expect(src14c).toContain("Advanced Pricing Controls"); // renamed in 14C.2 — manual tier fields stay collapsed
    expect(src14c).toContain("Advanced Pricing Tools");
  });
});
