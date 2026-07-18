import { describe, expect, it } from "vitest";

import {
  WIRED_LABOR,
  blankItemCostQty,
  blankItemUnitCostAtQty,
  computeLineCosts,
  designSetupCost,
  glossWhiteSetupApplies,
  resolveMaterialUnitCost,
  resolvePrintMaterialCostPerSqft,
  suggestedPriceFromMargin,
  tierRangeLabel,
  wiredApplicationRate,
} from "../app/lib/cost-calculator.server";
import { applyWasteDivisor, percentToDivisor } from "../app/lib/recipe-pricing.server";
import { materialKind, materialKindLabel } from "../app/lib/material-classify";

describe("waste math", () => {
  it("uses the engine divisor: 100 sqft at 10% waste needs 111.11 sqft of input", () => {
    expect(applyWasteDivisor(100, 10)).toBeCloseTo(111.11111, 4);
  });

  it("computeLineCosts waste-adjusts sqft exactly like applyWasteDivisor", () => {
    // 1000 labels of 12x12in = 1000 base sqft at 10% waste.
    const costs = computeLineCosts({
      quantity: 1000,
      widthIn: 12,
      heightIn: 12,
      wastePct: 10,
      materialCostPerSqft: 0.31,
      inkMode: "estimated",
      estimatedInkCostPerSqft: 0,
      ripInkCost: 0,
      ripInkCc: 0,
    });
    expect(costs.baseSqft).toBeCloseTo(1000, 6);
    expect(costs.wasteAdjustedSqft).toBeCloseTo(applyWasteDivisor(1000, 10), 6);
    expect(costs.materialCost).toBeCloseTo(applyWasteDivisor(1000, 10) * 0.31, 6);
    expect(costs.effectiveUnits).toBeCloseTo(applyWasteDivisor(1000, 10), 6);
  });

  it("clamps pathological waste instead of dividing by zero", () => {
    expect(applyWasteDivisor(100, 100)).toBeCloseTo(100 / 0.01, 6);
    expect(applyWasteDivisor(100, 250)).toBeCloseTo(100 / 0.01, 6);
  });

  it("rounds blank-item costed units up to whole units", () => {
    // 1000 jars at 2% waste: 1000 / 0.98 = 1020.4 -> 1021 costed jars.
    expect(blankItemCostQty(1000, 2)).toBe(1021);
    expect(blankItemCostQty(1000, 0)).toBe(1000);
    expect(blankItemCostQty(0, 5)).toBe(0);
  });
});

describe("material unit cost resolution", () => {
  it("prefers calculatedUnitCost, then costPerUnit", () => {
    expect(resolveMaterialUnitCost({ calculatedUnitCost: 0.31, costPerUnit: 0.5 }).unitCost).toBe(0.31);
    expect(resolveMaterialUnitCost({ calculatedUnitCost: 0, costPerUnit: 0.5 }).unitCost).toBe(0.5);
  });

  it("never falls back to purchaseCost: a $205 roll with no unit cost warns and prices 0", () => {
    const resolved = resolveMaterialUnitCost({ name: "Matte roll", purchaseCost: 205 });
    expect(resolved.unitCost).toBe(0);
    expect(resolved.warning).toContain("purchase cost but no per-unit cost");

    const perSqft = resolvePrintMaterialCostPerSqft({ name: "Matte roll", purchaseCost: 205, baseUnit: "sqft" });
    expect(perSqft.unitCost).toBe(0);
    expect(perSqft.warning).toBeTruthy();
  });

  it("warns on materials with no cost at all", () => {
    const resolved = resolveMaterialUnitCost({ name: "Mystery" });
    expect(resolved.unitCost).toBe(0);
    expect(resolved.warning).toContain("no usable unit cost");
  });

  it("converts sq-inch materials to sqft with x144", () => {
    const resolved = resolvePrintMaterialCostPerSqft({ calculatedUnitCost: 0.002, baseUnit: "sqin" });
    expect(resolved.unitCost).toBeCloseTo(0.288, 6);
    const sqft = resolvePrintMaterialCostPerSqft({ calculatedUnitCost: 0.31, baseUnit: "sqft" });
    expect(sqft.unitCost).toBeCloseTo(0.31, 6);
  });
});

describe("blank/vendor item tiers", () => {
  // Matches the seeded Miron 50ml jar tier table.
  const mironTiers = [
    { minQty: 1, maxQty: 249, unitCost: 2.46 },
    { minQty: 250, maxQty: 499, unitCost: 2.24 },
    { minQty: 500, maxQty: 999, unitCost: 2.03 },
    { minQty: 1000, maxQty: 2499, unitCost: 1.89 },
    { minQty: 2500, maxQty: null, unitCost: 1.74 },
  ];

  it("selects the tier whose range contains the quantity", () => {
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 100).unitCost).toBe(2.46);
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 250).unitCost).toBe(2.24);
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 600).unitCost).toBe(2.03);
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 2499).unitCost).toBe(1.89);
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 5000).unitCost).toBe(1.74);
  });

  it("labels the selected tier range", () => {
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 600).tierLabel).toBe("500-999");
    expect(blankItemUnitCostAtQty(mironTiers, 2.46, 5000).tierLabel).toBe("2500+");
    expect(tierRangeLabel(null)).toBe("fixed");
  });

  it("warns and charges the lowest tier when quantity is below all tier minimums", () => {
    const tiers = [
      { minQty: 500, maxQty: 999, unitCost: 2.03 },
      { minQty: 1000, maxQty: null, unitCost: 1.89 },
    ];
    const result = blankItemUnitCostAtQty(tiers, 0, 100, "Test jar");
    expect(result.unitCost).toBe(2.03);
    expect(result.warning).toContain("below the lowest cost tier");
  });

  it("uses the flat default cost when there are no tiers", () => {
    const result = blankItemUnitCostAtQty([], 0.6, 5000, "4oz jar");
    expect(result.unitCost).toBe(0.6);
    expect(result.tierLabel).toBe("fixed");
    expect(result.warning).toBeNull();
  });
});

describe("suggested price / margin divisor", () => {
  it("prices cost / (1 - margin%)", () => {
    expect(percentToDivisor(40)).toBeCloseTo(0.6, 6);
    expect(suggestedPriceFromMargin(600, 40)).toBeCloseTo(1000, 6);
  });

  it("clamps margins to the engine's 0-95 range instead of returning $0 at 100%", () => {
    expect(suggestedPriceFromMargin(100, 100)).toBeCloseTo(100 / 0.05, 6);
    expect(suggestedPriceFromMargin(100, -20)).toBeCloseTo(100, 6);
  });
});

describe("line ink modes", () => {
  it("estimated mode prices ink per waste-adjusted sqft", () => {
    const costs = computeLineCosts({
      quantity: 100,
      widthIn: 12,
      heightIn: 12,
      wastePct: 0,
      materialCostPerSqft: 0,
      inkMode: "estimated",
      estimatedInkCostPerSqft: 0.5,
      ripInkCost: 999,
      ripInkCc: 999,
    });
    expect(costs.inkCost).toBeCloseTo(50, 6);
    expect(costs.inkCc).toBe(0);
  });

  it("actual per-piece mode multiplies RIP ink by waste-adjusted units", () => {
    const costs = computeLineCosts({
      quantity: 100,
      widthIn: 4,
      heightIn: 5,
      wastePct: 0,
      materialCostPerSqft: 0,
      inkMode: "actual-per-piece",
      estimatedInkCostPerSqft: 0.5,
      ripInkCost: 0.02,
      ripInkCc: 1.5,
    });
    expect(costs.inkCost).toBeCloseTo(2, 6);
    expect(costs.inkCc).toBeCloseTo(150, 6);
  });

  it("actual full-job mode uses the RIP totals once", () => {
    const costs = computeLineCosts({
      quantity: 100,
      widthIn: 4,
      heightIn: 5,
      wastePct: 10,
      materialCostPerSqft: 0,
      inkMode: "actual-full-job",
      estimatedInkCostPerSqft: 0.5,
      ripInkCost: 7.25,
      ripInkCc: 320,
    });
    expect(costs.inkCost).toBeCloseTo(7.25, 6);
    expect(costs.inkCc).toBeCloseTo(320, 6);
  });
});

describe("owner labor standards wiring (13A.3)", () => {
  it("pins the wired standards at full precision", () => {
    expect(WIRED_LABOR.jarPerApplication).toBe(0.2);
    expect(WIRED_LABOR.bag4x5PerSide).toBe(20 / 180);
    expect(WIRED_LABOR.bag14x16PerSide).toBe(1);
    expect(WIRED_LABOR.designSetupPerDesign).toBeCloseTo(25 / 3 + 1, 9);
    expect(WIRED_LABOR.glossWhiteSetupPerJob).toBe(25 / 3);
  });

  it("maps modes/items to wired rates; unmapped combinations stay legacy (null)", () => {
    expect(wiredApplicationRate("apply-jar", "safe-care-jar 3oz jar - clear")).toBe(0.2);
    expect(wiredApplicationRate("apply-jar", "miron-250ml 250ml Miron jar + lid")).toBe(0.2);
    expect(wiredApplicationRate("apply-flat-bag", "preset:blank-4x5-bag 4x5 Blank Bag")).toBe(20 / 180);
    expect(wiredApplicationRate("apply-flat-bag", "14x16 Blank Bag")).toBe(1);
    expect(wiredApplicationRate("apply-flat-bag", "pound-bag Pound bag")).toBe(1);
    expect(wiredApplicationRate("apply-flat-bag", "oz-bag OZ bag")).toBeNull();
    expect(wiredApplicationRate("apply-box", "some box")).toBeNull();
    expect(wiredApplicationRate("apply-label-set", "4x5 Blank Bag")).toBeNull();
  });

  it("600 jars = $120.00; 1,000 4x5 front = $111.11; front+back = $222.22 application labor", () => {
    expect(600 * wiredApplicationRate("apply-jar", "jar")!).toBeCloseTo(120, 6);
    expect(1000 * wiredApplicationRate("apply-flat-bag", "4x5 Blank Bag")!).toBeCloseTo(111.1111, 3);
    expect(2000 * wiredApplicationRate("apply-flat-bag", "4x5 Blank Bag")!).toBeCloseTo(222.2222, 3);
  });

  it("design setup: presets charge the $9.3333 standard, none is $0, custom stays a user override", () => {
    expect(designSetupCost("none", 0, 0, 25).cost).toBe(0);
    const basic = designSetupCost("basic", 0, 0, 25);
    expect(basic.cost).toBeCloseTo(25 / 3 + 1, 9);
    expect(basic.wired).toBe(true);
    expect(designSetupCost("dieline", 0, 0, 25).cost).toBeCloseTo(25 / 3 + 1, 9);
    const custom = designSetupCost("custom", 30, 10, 25);
    expect(custom.cost).toBeCloseTo(10 + (30 / 60) * 25, 6);
    expect(custom.wired).toBe(false);
  });

  it("gloss/white setup applies on white/gloss profiles or RIP ink, labor only", () => {
    expect(glossWhiteSetupApplies({ estimatedProfiles: ["cmyk-white-heavy"], ripWhiteOrGlossCc: 0 })).toBe(true);
    expect(glossWhiteSetupApplies({ estimatedProfiles: ["cmyk-3x-gloss-heavy"], ripWhiteOrGlossCc: 0 })).toBe(true);
    expect(glossWhiteSetupApplies({ estimatedProfiles: ["cmyk-heavy"], ripWhiteOrGlossCc: 0 })).toBe(false);
    expect(glossWhiteSetupApplies({ estimatedProfiles: [], ripWhiteOrGlossCc: 12.5 })).toBe(true);
    expect(glossWhiteSetupApplies({ estimatedProfiles: [], ripWhiteOrGlossCc: 0 })).toBe(false);
  });
});

describe("material classifier", () => {
  it("classifies real seeded data shapes", () => {
    expect(materialKind({ materialType: "blank_jars", baseUnit: "each" })).toBe("blank");
    expect(materialKind({ materialType: "roll-media", baseUnit: "sqft" })).toBe("print");
    expect(materialKind({ materialType: "general", baseUnit: "sqin" })).toBe("print");
    expect(materialKind({ materialType: "label stock" })).toBe("print");
    expect(materialKind({ materialType: "ink_coating", baseUnit: "ml" })).toBe("excluded");
    expect(materialKind({ materialType: "labor", baseUnit: "hour" })).toBe("excluded");
    expect(materialKind({ materialType: "general", baseUnit: "each" })).toBe("blank");
    expect(materialKind({ materialType: "mystery", baseUnit: "ml" })).toBe("other");
  });

  it("labels kinds for the UI", () => {
    expect(materialKindLabel({ materialType: "roll-media", baseUnit: "sqft" })).toBe("Print media");
    expect(materialKindLabel({ materialType: "blank_jars", baseUnit: "each" })).toBe("Blank item");
    expect(materialKindLabel({ materialType: "mystery", baseUnit: "ml" })).toBe("Other");
  });
});
