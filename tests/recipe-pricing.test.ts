import { describe, expect, it } from "vitest";

import {
  blockingConversionIssues,
  getBestRange,
  priceRecipeAtQuantity,
} from "../app/lib/recipe-pricing.server";

// Minimal in-house recipe: 12x12in (1 sqft per unit), one $2/sqft material,
// zero labor/machine/ink/overhead so the expected cost is exactly material.
function inHouseRecipe(overrides: Record<string, unknown> = {}) {
  return {
    productionMode: "in_house",
    widthIn: 12,
    heightIn: 12,
    wastePct: 0,
    setupCost: 0,
    laborMinutes: 0,
    operatorLaborPct: 0,
    maintenanceCostPerSqft: 0,
    machineRecoveryCostPerSqft: 0,
    overheadCostPerSqft: 0,
    inkAllowancePct: 0,
    baseCmykCoveragePct: 0,
    minQuantity: 1,
    targetMarginPct: 50,
    tiers: [],
    materials: [
      {
        quantity: 1,
        unit: "sqft",
        usageType: "media",
        material: { name: "Test media", calculatedUnitCost: 2 },
      },
    ],
    machineRules: [
      {
        preferredMachine: {
          name: "Test printer",
          costPerHour: 0,
          sqftPerHour: 150,
          inkChannels: [],
        },
      },
    ],
    addOns: [],
    vendorProduct: null,
    ...overrides,
  };
}

describe("priceRecipeAtQuantity", () => {
  it("prices margin-based recipes as cost / (1 - margin%)", () => {
    const priced = priceRecipeAtQuantity(inHouseRecipe(), 10, {});

    expect(priced.unitCost).toBeCloseTo(2, 5);
    expect(priced.unitPrice).toBeCloseTo(4, 5); // 2 / (1 - 0.5)
    expect(priced.marginActual).toBeCloseTo(50, 5);
    expect(priced.pricingSource).toBe("recipe_in_house");
  });

  it("uses a fixed tier price when the matching tier has one", () => {
    const priced = priceRecipeAtQuantity(
      inHouseRecipe({ tiers: [{ minQty: 1, maxQty: null, marginPct: null, fixedPrice: 9.99 }] }),
      10,
      {},
    );

    expect(priced.fixedPrice).toBe(9.99);
    expect(priced.unitPrice).toBe(9.99);
    expect(priced.tierLabel).toBe("1+");
  });

  it("warns when quantity is below the recipe minimum", () => {
    const priced = priceRecipeAtQuantity(inHouseRecipe({ minQuantity: 64 }), 10, {});

    expect(priced.warnings.join(" ")).toContain("below this recipe minimum of 64");
  });

  it("prices outsourced recipes from vendor tiers", () => {
    const priced = priceRecipeAtQuantity(
      inHouseRecipe({
        productionMode: "outsourced",
        vendorProduct: {
          defaultUnitCost: 0,
          tiers: [
            { minQty: 1, maxQty: 99, unitCost: 3 },
            { minQty: 100, maxQty: null, unitCost: 2.5 },
          ],
          addOns: [],
        },
      }),
      100,
      {},
    );

    expect(priced.pricingSource).toBe("recipe_outsourced");
    expect(priced.unitCost).toBeCloseTo(2.5, 5);
  });
});

describe("getBestRange", () => {
  const rows = [
    { minQty: 1, maxQty: 99 },
    { minQty: 100, maxQty: null },
  ];

  it("picks the exact matching range", () => {
    expect(getBestRange(rows, 50)).toBe(rows[0]);
    expect(getBestRange(rows, 100)).toBe(rows[1]);
    expect(getBestRange(rows, 5000)).toBe(rows[1]);
  });

  it("falls back to the first range when quantity is below all minimums", () => {
    expect(getBestRange([{ minQty: 10, maxQty: null }], 1)).toEqual({ minQty: 10, maxQty: null });
  });
});

describe("blockingConversionIssues", () => {
  it("returns no issues for a complete in-house recipe at a valid quantity", () => {
    const recipe = inHouseRecipe();
    const priced = priceRecipeAtQuantity(recipe, 10, {});

    expect(blockingConversionIssues(recipe, priced)).toEqual([]);
  });

  it("flags missing dimensions, materials, and machine with exact reasons", () => {
    const recipe = inHouseRecipe({ widthIn: 0, heightIn: 0, materials: [], machineRules: [] });
    const priced = priceRecipeAtQuantity(recipe, 10, {});
    const issues = blockingConversionIssues(recipe, priced);

    expect(issues).toContain("recipe is missing width or height");
    expect(issues).toContain("recipe has no materials attached");
    expect(issues).toContain("recipe has no preferred machine");
    expect(issues).toContain("unit cost is not a positive number");
  });

  it("flags quantities below the recipe minimum", () => {
    const recipe = inHouseRecipe({ minQuantity: 64 });
    const priced = priceRecipeAtQuantity(recipe, 10, {});

    expect(blockingConversionIssues(recipe, priced)).toContain(
      "quantity 10 is below the recipe minimum of 64",
    );
  });
});
