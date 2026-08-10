// Phase 15G.2 — Single Price Truth: canonical-authority and cross-surface
// equivalence proofs. Pure engine calls + repo source pins; no database.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { CANONICAL_INK_RATES, channelInkRatePerMl, inkBrandFromMachineName } from "../app/lib/ink-rates-shared";
import { INK_RATES, resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { MACHINE_RATE_CURRENT } from "../app/lib/rip-actual-costs-shared";
import { buildBrandRates, machineRatePerHour } from "../app/lib/rip-actual-costs.server";
import {
  blockingConversionIssues,
  materialUnitCost,
  materialUnitCostResolution,
  priceRecipeAtQuantity,
} from "../app/lib/recipe-pricing.server";
import { computeProductDrivenCost } from "../app/lib/product-driven-costing.server";
import {
  computeCommercialPrice,
  defaultPricingPolicyValues,
  marginCurveKeyFor,
  specialtyFinishReasons,
} from "../app/lib/commercial-pricing-policy.server";
import { canonicalStockBagJob, type CanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import { FALLBACK_PRICING_ROWS } from "../app/lib/configurator-pricing";
import { buildCanonicalPricingSnapshot, CANONICAL_PRICING_SNAPSHOT_VERSION } from "../app/lib/pricing-snapshot";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// ---------- E. machine rate — one authority ----------

describe("machine rate authority", () => {
  it("the one canonical rate is the owner-standards $8/hr everywhere", () => {
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(8);
    expect(MACHINE_RATE_CURRENT).toBe(OWNER_STANDARDS.machineRecoveryPerHour.value);
    expect(machineRatePerHour({})).toBe(8);
  });

  it("the stale defaultMachineRecoveryHr admin setting cannot reprice anything", () => {
    // No pricing path reads the setting; the only readers flag it as stale.
    const calibration = readSource("app/routes/app.erp.calibration.tsx");
    expect(calibration).toContain("STALE reference-only");
    const adminSettings = readSource("app/routes/app.erp.admin-settings.tsx");
    expect(adminSettings).toContain("REFERENCE ONLY (15G.2)");
    for (const lib of ["app/lib/product-driven-costing.server.ts", "app/lib/recipe-pricing.server.ts", "app/lib/commercial-pricing-policy.server.ts", "app/lib/rip-actual-costs.server.ts"]) {
      expect(readSource(lib).includes("defaultMachineRecoveryHr")).toBe(false);
    }
  });

  it("the printable work order uses canonical helpers, not retired literals", () => {
    const source = readSource("app/routes/app.erp.production.$id.print.tsx");
    expect(source).toContain("machineRatePerHour");
    expect(source).toContain("computeEntryCosts");
    expect(source.includes("156.99")).toBe(false);
    expect(source.includes("190 / 1000")).toBe(false);
    expect(source.includes("DEFAULT_MACHINE_RECOVERY_PER_HOUR")).toBe(false);
  });
});

// ---------- F. ink rate — one authority ----------

describe("ink rate authority", () => {
  it("calculator INK_RATES and the canonical table are the same values", () => {
    expect(INK_RATES.mimakiCmykPerMl).toBe(CANONICAL_INK_RATES.mimakiCmykPerMl);
    expect(INK_RATES.mimakiWhitePerMl).toBe(CANONICAL_INK_RATES.mimakiWhitePerMl);
    expect(INK_RATES.rolandPerMl).toBe(CANONICAL_INK_RATES.rolandPerMl);
    expect(INK_RATES.mimakiGlossPerMl).toBeNull();
    expect(CANONICAL_INK_RATES.mimakiCmykPerMl).toBeCloseTo(176 / 1000, 12);
    expect(CANONICAL_INK_RATES.rolandPerMl).toBeCloseTo(149 / 750, 12);
  });

  it("actual-cost brand rates match quote-estimate rates even against stale seeded channels", () => {
    const rates = buildBrandRates([
      { name: "Mimaki UCJV300-130", inkChannels: [{ inkType: "cmyk", inkName: "Cyan", enabled: true, cartridgeCost: 190, cartridgeMl: 1000 }] },
      { name: "Roland TrueVIS LG-640", inkChannels: [{ inkType: "cmyk", inkName: "Cyan", enabled: true, cartridgeCost: 156.99, cartridgeMl: 750 }, { inkType: "gloss", inkName: "Gloss", enabled: true, cartridgeCost: 156.99, cartridgeMl: 750 }] },
    ]);
    const mimaki = rates.find((rate) => rate.brand === "mimaki")!;
    const roland = rates.find((rate) => rate.brand === "roland")!;
    expect(mimaki.cmykPerMl).toBeCloseTo(176 / 1000, 12);
    expect(mimaki.whitePerMl).toBeCloseTo(176 / 1000, 12);
    expect(mimaki.glossPerMl).toBeNull(); // Mimaki is CMYK-only — no gloss rate may exist
    expect(roland.cmykPerMl).toBeCloseTo(149 / 750, 12);
    expect(roland.whitePerMl).toBeCloseTo(149 / 750, 12);
    expect(roland.glossPerMl).toBeCloseTo(149 / 750, 12);
  });

  it("no Mimaki white/gloss pricing path becomes reachable (routing preserved)", () => {
    expect(channelInkRatePerMl("mimaki", "gloss")).toBeNull();
    expect(inkBrandFromMachineName("Roland TrueVIS LG-640")).toBe("roland");
    expect(inkBrandFromMachineName("Mimaki UCJV300-130")).toBe("mimaki");
    const mimakiGlossJob = computeProductDrivenCost(baseBagInput({ quantity: 100, faces: 1, printer: "mimaki", glossLayers: 3 }));
    expect(mimakiGlossJob.missing.some((label) => label.includes("CMYK ONLY"))).toBe(true);
  });

  it("machine seed presets carry the canonical rates", () => {
    const source = readSource("app/routes/app.erp.machines.tsx");
    expect(source).toContain("const ROLAND_POUCH_COST = 149");
    expect(source).toContain("const MIMAKI_BOTTLE_COST_ESTIMATE = 176");
    expect(source.includes("156.99")).toBe(false);
  });
});

// ---------- D. recipe purchase-cost fallback removed ----------

describe("recipe material cost fail-closed", () => {
  it("purchaseCost alone is never a pricing unit cost", () => {
    expect(materialUnitCost({ purchaseCost: 488 })).toBe(0);
    expect(materialUnitCostResolution({ purchaseCost: 488 })).toEqual({ unitCost: 0, source: "missing", purchaseCostOnly: true });
    expect(materialUnitCostResolution({ calculatedUnitCost: 0.31, purchaseCost: 488 }).unitCost).toBeCloseTo(0.31, 9);
    expect(materialUnitCostResolution({ costPerUnit: 0.09 }).source).toBe("cost_per_unit");
  });

  it("a purchase-cost-only material blocks conversion instead of silently pricing", () => {
    const recipe = {
      productionMode: "in_house",
      widthIn: 4,
      heightIn: 5,
      wastePct: 10,
      minQuantity: 1,
      targetMarginPct: 50,
      materials: [{ quantity: 1, unit: "sqft", material: { name: "Holographic roll", purchaseCost: 488 } }],
      machineRules: [{ preferredMachine: { name: "Roland TrueVIS LG-640", sqftPerHour: 150, inkChannels: [] } }],
      tiers: [],
    };
    const priced = priceRecipeAtQuantity(recipe, 100);
    expect(priced.warnings.some((warning) => warning.includes("only a purchase cost"))).toBe(true);
    const issues = blockingConversionIssues(recipe, priced);
    expect(issues.some((issue) => issue.includes("purchase cost"))).toBe(true);
  });

  it("the old fallback expression is gone from the engine source", () => {
    const source = readSource("app/lib/recipe-pricing.server.ts");
    expect(/\|\|\s*safeNumber\(material\?\.purchaseCost\)/.test(source)).toBe(false);
  });
});

// ---------- L. cross-surface price equivalence ----------

const POLICY = defaultPricingPolicyValues();
const CANONICAL_INPUTS: CanonicalBagInputs = {
  available: true,
  reasons: [],
  matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 },
  holographic: { name: "Holographic", costPerSqft: 0.7141463415 },
  blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: 0.09, tiers: [] },
  rolandSqftPerHour: 150,
  policyValues: POLICY,
};

function baseBagInput(options: { quantity: number; faces: number; printer: "mimaki" | "roland"; glossLayers?: number; whiteLayers?: number; glossCoveragePct?: number | null }) {
  return {
    family: "bags-4x5" as const,
    quantity: options.quantity,
    designs: 1,
    facesPerUnit: options.faces,
    widthIn: 4,
    heightIn: 5,
    labelRows: null,
    dtp: null,
    blank: { name: CANONICAL_INPUTS.blank!.name, unitCost: 0.09, tiers: [], status: "verified" as const },
    lid: null,
    material: { name: CANONICAL_INPUTS.matte!.name, costPerSqft: CANONICAL_INPUTS.matte!.costPerSqft },
    printer: options.printer,
    printerHasWhite: true,
    printerHasGloss: options.printer === "roland",
    whiteLayers: options.whiteLayers || 0,
    glossLayers: options.glossLayers || 0,
    glossCoveragePct: options.glossCoveragePct ?? null,
    inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0,
    machineSqftPerHour: options.printer === "roland" ? 150 : 0,
    machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: null,
    cutRequiresWeeding: false,
    hemming: false,
    grommets: false,
    freightPerUnit: 0,
    freightSource: "estimated" as const,
    recipeWastePct: null,
    wasteOverride: null,
    boxOverride: null,
  };
}

function directCommercial(quantity: number, faces: number, run: ReturnType<typeof computeProductDrivenCost>, glossLayers = 0, materialName = "Poseidon Matte") {
  return computeCommercialPrice({
    familyKey: "sticker-bags",
    quantity,
    completeCost: run.totalCost,
    marginRule: resolveMarginFamily("bags-4x5"),
    premiumEligible: false,
    finishedSqft: run.derived.baseSqft,
    setupTotal: run.setupTotal,
    policyValues: POLICY,
    marginCurveKey: marginCurveKeyFor("bags-4x5", faces),
    marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers: 0, glossLayers, materialName }),
    // 15G.4C: same specialty context the calculator route passes.
    specialty: { glossLayers, decorativeWhiteLayers: 0, requiredWhite: false, holographic: /holo/i.test(materialName) },
  });
}

describe("cross-surface equivalence — 4x5 sticker bags", () => {
  it("15G.4C owner recalibration: 1,000 single = $1.05/unit and 1,000 double = $1.45/unit (UV market targets, front + back premium)", () => {
    const single = canonicalStockBagJob(CANONICAL_INPUTS, { quantity: 1000, faces: 1 });
    const double = canonicalStockBagJob(CANONICAL_INPUTS, { quantity: 1000, faces: 2 });
    if (!single.available || !double.available) throw new Error("canonical job unavailable");
    expect(single.recommendedTotalPrice).toBeCloseTo(1050.0, 2);
    expect(single.recommendedUnitPrice).toBeCloseTo(1.05, 4);
    expect(double.recommendedTotalPrice).toBeCloseTo(1450.0, 2);
    expect(double.recommendedUnitPrice).toBeCloseTo(1.45, 4);
  });

  it("the admin-preview helper equals a direct calculator engine run exactly (same inputs → same cost and price)", () => {
    for (const fixture of [
      { quantity: 1000, faces: 1, glossLayers: 0 },
      { quantity: 1000, faces: 2, glossLayers: 0 },
      { quantity: 500, faces: 2, glossLayers: 3 },
    ]) {
      const viaHelper = canonicalStockBagJob(CANONICAL_INPUTS, fixture);
      const printer = fixture.glossLayers > 0 ? "roland" : "mimaki";
      const run = computeProductDrivenCost(baseBagInput({ ...fixture, printer }));
      const commercial = directCommercial(fixture.quantity, fixture.faces, run, fixture.glossLayers);
      if (!viaHelper.available) throw new Error("canonical job unavailable");
      expect(viaHelper.totalCost).toBeCloseTo(run.totalCost, 6);
      expect(viaHelper.recommendedTotalPrice).toBeCloseTo(commercial.finalTotalPrice, 6);
      expect(viaHelper.controllingRule).toBe(commercial.controllingRule);
    }
  });

  it("gloss DIRECT-COST math unchanged ($452.37 @55%); 15G.4C commercial: specialty tier controls (500 dbl 3X → $960 = 1.50 base +28%)", () => {
    const run = computeProductDrivenCost(baseBagInput({ quantity: 500, faces: 2, printer: "roland", glossLayers: 3, glossCoveragePct: 55 }));
    expect(run.totalCost).toBeCloseTo(452.37, 1); // owner gloss math untouched
    const commercial = directCommercial(500, 2, run, 3);
    expect(commercial.specialty?.active).toBe(true);
    expect(commercial.specialty?.curvePct).toBe(28);
    expect(commercial.controllingRule).toContain("UV specialty market tier");
    expect(commercial.finalTotalPrice).toBeCloseTo(960.0, 2); // 1.50 x 500 x 1.28
    expect(commercial.marketPosition?.applicable).toBe(false); // comparisons stay suppressed
    // floor reference: cost/0.60 at 55% actual coverage sits below the tier
    expect(commercial.specialty?.floorPrice).toBeCloseTo(452.37 / 0.6, 1);
  });
});

describe("cross-surface equivalence — recipe-backed products (jars, stickers, DTP path)", () => {
  const jarRecipe = {
    productionMode: "in_house",
    name: "3oz clear jar with applied label",
    widthIn: 3,
    heightIn: 2,
    wastePct: 10,
    minQuantity: 1,
    targetMarginPct: 50,
    baseCmykCoveragePct: 40,
    inkAllowancePct: 15,
    operatorLaborPct: 25,
    materials: [
      { quantity: 1, unit: "each", material: { name: "3oz clear jar", costPerUnit: 0.62 } },
      { quantity: 1, unit: "sqft", material: { name: "Poseidon Matte", calculatedUnitCost: 213 / 675 } },
    ],
    machineRules: [{ preferredMachine: { name: "Mimaki UCJV300-130", sqftPerHour: 150, inkChannels: [{ inkType: "cmyk", inkName: "Cyan", enabled: true, costPerMl: 0.209, mlPerSqft1Pct: 0.0075 }] } }],
    tiers: [{ minQty: 1, maxQty: null, marginPct: 55, fixedPrice: null }],
  };

  it("Margin Review's suggested price IS the canonical engine unit price (same identity Quotes uses)", () => {
    const priced = priceRecipeAtQuantity(jarRecipe, 585);
    // margin-review consumes cost.total = priced.unitCost and suggested =
    // priced.unitPrice; the engine identity price = cost / (1 - tierMargin).
    expect(priced.unitPrice).toBeCloseTo(priced.unitCost / (1 - 0.55), 9);
    expect(priced.unitCost).toBeGreaterThan(0);
    // canonical ink authority: Mimaki channel priced at 176/1000 (not the
    // stale seeded 0.209 $/ml on the channel row)
    const inkCost = (priced.estimate as any).breakdown.cmykInkCost;
    const expectedInk = ((3 * 2) / 144) * 585 / 0.9 * 40 * 0.0075 * (176 / 1000) * 1.15;
    expect(inkCost).toBeCloseTo(expectedInk, 6);
  });

  it("fixed-price tiers stay authoritative through the same engine", () => {
    const fixed = priceRecipeAtQuantity({ ...jarRecipe, tiers: [{ minQty: 1, maxQty: null, marginPct: null, fixedPrice: 4.5 }] }, 100);
    expect(fixed.unitPrice).toBe(4.5);
  });
});

// ---------- source pins — no alternate authority remains active ----------

describe("source pins — surfaces consume the canonical engines", () => {
  it("Quotes/CRM: legacy ProductCost/PricingRule pricing is gone; unmatched products are explicit manual", () => {
    const source = readSource("app/routes/app.quotes.tsx");
    expect(source.includes("db.productCost.findMany")).toBe(false);
    expect(source.includes("db.pricingRule.findMany")).toBe(false);
    expect(source.includes("getBestPricingRule")).toBe(false);
    expect(source.includes("getMatchedProductCost")).toBe(false);
    expect(source).toContain("manual_unsupported");
    expect(source).toContain("QUOTE_READY_RECIPE_WHERE");
    expect(source).toContain("buildCanonicalPricingSnapshot");
  });

  it("Margin Review prices through the canonical recipe engine with the approval gate intact", () => {
    const source = readSource("app/routes/app.erp.margin-review.tsx");
    expect(source).toContain("priceRecipeAtQuantity(recipe, qty)");
    expect(source).toContain("canonicalUnitPrice");
    expect(/numberOr\(material\?\.purchaseCost, 0\)/.test(source)).toBe(false);
    expect(source).toContain("OWNER_SHOPIFY_PRICE_PUSH_PHRASE"); // 15G.1 gate preserved
    expect(source).toContain("NO LONGER affects pricing"); // application floor demoted to reference
  });

  it("Pricing Rules preview consumes canonical cost — its private cost model is deleted", () => {
    const source = readSource("app/routes/app.erp.pricing-rules.tsx");
    expect(source).toContain("canonicalStockBagJob");
    expect(source.includes("blankBagCost")).toBe(false);
    expect(source.includes("wasteSqft * 0.18")).toBe(false);
    expect(source.includes("materialCostSqft")).toBe(false);
    expect(source).toContain("Below canonical recommendation");
  });

  it("15G.5: Configurator admin marks the matrix Deprecated/Compatibility; storefront serves the canonical engine", () => {
    const source = readSource("app/routes/app.erp.configurator.tsx");
    expect(source).toContain("Deprecated / Compatibility — Legacy ConfiguratorPricingRule");
    expect(source).toContain("Canonical ERP Recommendation");
    expect(source).toContain("Parity:");
    // the legacy pilot matrix data itself is unchanged (compatibility/audit)
    expect(FALLBACK_PRICING_ROWS[0].prices[0]).toBe(1.75);
    // the public proxy now prices supported bags through the canonical path
    const proxy = readSource("app/routes/apps.wholesale-lite.configurator.ts");
    expect(proxy).toContain("priceStorefrontConfiguration");
    expect(proxy).toContain('pricingSource = "canonical_erp"');
  });
});

// ---------- K. snapshot standard ----------

describe("canonical pricing snapshot", () => {
  it("builds the normalized versioned block", () => {
    const snapshot = buildCanonicalPricingSnapshot({
      engine: "test/engine",
      quantity: 500,
      totalCost: 452.37,
      unitCost: 0.9047,
      recommendedUnitPrice: 1.9668,
      recommendedTotalPrice: 983.41,
      marginPct: 54,
    });
    expect(snapshot.snapshotVersion).toBe(CANONICAL_PRICING_SNAPSHOT_VERSION);
    expect(snapshot.quantity).toBe(500);
    expect(snapshot.recommendedTotalPrice).toBeCloseTo(983.41, 2);
    expect(typeof snapshot.at).toBe("string");
  });
});
