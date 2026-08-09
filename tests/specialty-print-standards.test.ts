// 15F.0K.4B — owner-verified specialty print and pricing standards
// (2026-07-26): Mimaki UCJV300-130 is CMYK ONLY; Roland LG-640 owns
// white/gloss; $6.25 gloss-layer Illustrator setup per gloss DESIGN (never
// per stage); 90% pre-art gloss coverage with actual-artwork override
// (0-100 validated); $8/hr machine recovery everywhere including the recipe
// engine (stale Machine.costPerHour can never underprice again).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeProductDrivenCost, type ProductDrivenInput } from "../app/lib/product-driven-costing.server";
import { computeCommercialPrice, defaultPricingPolicyValues, marginCurveKeyFor } from "../app/lib/commercial-pricing-policy.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { OWNER_LABOR, resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { calculateInHouseRecipe } from "../app/lib/recipe-pricing.server";
import { machineRatePerHour } from "../app/lib/rip-actual-costs.server";
import { validateFamilyMoneyMap, parseOwnerConfigValue, ownerConfigKeyDefinition, PRICING_MIN_ORDER_TOTALS_KEY, resolvePricingPolicyConfig } from "../app/lib/owner-config.server";

const POSEIDON_PER_SQFT = 213 / ((54 / 12) * 150);
const MACHINE_RATE = OWNER_STANDARDS.machineRecoveryPerHour.value;

function stickerInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
  return {
    family: "stickers-labels", quantity: 100, designs: 1, facesPerUnit: 1,
    widthIn: 3, heightIn: 3, labelRows: null, dtp: null, blank: null, lid: null, mironTop: null,
    material: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
    printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0, machineSqftPerHour: 0, machineRatePerHour: MACHINE_RATE,
    cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false,
    freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null, wasteOverride: null, boxOverride: null,
    ...overrides,
  };
}

function rolandInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
  return stickerInput({ printer: "roland", printerHasGloss: true, machineSqftPerHour: 150, ...overrides });
}

const CAPABILITY_BLOCKER = "Mimaki UCJV300-130 is CMYK ONLY";

describe("machine routing — Mimaki is CMYK ONLY (owner-verified 2026-07-26)", () => {
  it("Mimaki accepts CMYK-only jobs (no capability blocker; machine + ink price normally)", () => {
    const run = computeProductDrivenCost(stickerInput({}));
    expect(run.lines.find((line) => line.key === "printer_capability")).toBeUndefined();
    expect(run.missing.join(" ")).not.toContain(CAPABILITY_BLOCKER);
    expect(run.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeGreaterThan(0);
    expect(run.lines.find((line) => line.key === "machine")!.amount).toBeGreaterThan(0);
  });

  it("Mimaki BLOCKS white jobs with the exact capability message and prices no white ink", () => {
    const run = computeProductDrivenCost(stickerInput({ whiteLayers: 1 }));
    expect(run.missing.join(" ")).toContain(CAPABILITY_BLOCKER);
    expect(run.lines.find((line) => line.key === "ink_white")).toBeUndefined();
    expect(run.derived.printPasses).toBe(1); // layers zeroed — no multi-layer machine time
  });

  it("Mimaki BLOCKS 1X, 3X, 5X, and 7X gloss (the 15F.0G.3 provisional path is quarantined)", () => {
    for (const stages of [1, 3, 5, 7]) {
      const run = computeProductDrivenCost(stickerInput({ glossLayers: stages }));
      expect(run.missing.join(" "), `Mimaki ${stages}X`).toContain(CAPABILITY_BLOCKER);
      expect(run.lines.find((line) => line.key === "ink_gloss"), `Mimaki ${stages}X ink`).toBeUndefined();
      expect(run.lines.find((line) => line.key === "gloss_setup"), `Mimaki ${stages}X setup`).toBeUndefined();
    }
  });

  it("Roland accepts white and gloss jobs (prices ink, no capability blocker)", () => {
    const run = computeProductDrivenCost(rolandInput({ whiteLayers: 1, glossLayers: 3 }));
    expect(run.missing.join(" ")).not.toContain(CAPABILITY_BLOCKER);
    expect(run.lines.find((line) => line.key === "ink_white")!.amount).toBeGreaterThan(0);
    expect(run.lines.find((line) => line.key === "ink_gloss")!.amount).toBeGreaterThan(0);
  });
});

describe("gloss-layer Illustrator setup — $6.25 once per gloss DESIGN, never per stage", () => {
  it("owner standard is $25/hr at 4 jobs/hr = $6.25", () => {
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.value).toBeCloseTo(6.25, 10);
    expect(OWNER_LABOR.glossLayerSetupPerDesign).toBeCloseTo(6.25, 10);
  });

  it("one gloss design adds exactly $6.25; standard print setup stays a separate $1.00 line", () => {
    const run = computeProductDrivenCost(rolandInput({ glossLayers: 1, designs: 1 }));
    expect(run.lines.find((line) => line.key === "gloss_setup")!.amount).toBeCloseTo(6.25, 10);
    expect(run.lines.find((line) => line.key === "print_setup")!.amount).toBeCloseTo(1.0, 10);
    expect(run.lines.find((line) => line.key === "art_setup")!.amount).toBeCloseTo(OWNER_LABOR.artSetupPerDesign, 10);
  });

  it("four gloss designs add exactly $25.00 total gloss setup", () => {
    const run = computeProductDrivenCost(rolandInput({ glossLayers: 2, designs: 4 }));
    expect(run.lines.find((line) => line.key === "gloss_setup")!.amount).toBeCloseTo(25.0, 10);
    expect(run.lines.find((line) => line.key === "print_setup")!.amount).toBeCloseTo(4.0, 10);
  });

  it("a 7X gloss job with one design still adds only ONE $6.25 setup (never x stages)", () => {
    const sevenX = computeProductDrivenCost(rolandInput({ glossLayers: 7, designs: 1 }));
    const oneX = computeProductDrivenCost(rolandInput({ glossLayers: 1, designs: 1 }));
    expect(sevenX.lines.find((line) => line.key === "gloss_setup")!.amount).toBeCloseTo(6.25, 10);
    expect(sevenX.lines.find((line) => line.key === "gloss_setup")!.amount)
      .toBeCloseTo(oneX.lines.find((line) => line.key === "gloss_setup")!.amount, 10);
  });

  it("no gloss stages -> no gloss setup line (white-only work never receives it)", () => {
    const plain = computeProductDrivenCost(rolandInput({ designs: 2 }));
    expect(plain.lines.find((line) => line.key === "gloss_setup")).toBeUndefined();
    const whiteOnly = computeProductDrivenCost(rolandInput({ whiteLayers: 2, designs: 2 }));
    expect(whiteOnly.lines.find((line) => line.key === "gloss_setup")).toBeUndefined();
  });

  it("gloss setup is included in setupTotal (spread/recovery) exactly once", () => {
    const run = computeProductDrivenCost(rolandInput({ glossLayers: 3, designs: 2 }));
    const expectedSetup = 2 * (OWNER_LABOR.artSetupPerDesign + OWNER_LABOR.printSetupPerDesign) + 2 * 6.25;
    expect(run.setupTotal).toBeCloseTo(expectedSetup, 8);
  });
});

describe("gloss coverage — 90% pre-art estimate, actual-artwork override, 0-100 validated", () => {
  const glossAmount = (overrides: Partial<ProductDrivenInput>) =>
    computeProductDrivenCost(rolandInput({ glossLayers: 1, ...overrides })).lines.find((line) => line.key === "ink_gloss");

  it("missing actual coverage defaults to 90% ESTIMATED (labeled estimated_pre_art)", () => {
    const line = glossAmount({})!;
    expect(line.formula).toContain("coverage 0.90 (estimated_pre_art)");
    const full = glossAmount({ glossCoveragePct: 100 })!;
    expect(line.amount).toBeCloseTo(full.amount * 0.9, 8);
  });

  it("actual coverage overrides the 90% estimate (labeled actual_artwork)", () => {
    const half = glossAmount({ glossCoveragePct: 50 })!;
    expect(half.formula).toContain("coverage 0.50 (actual_artwork)");
    const est = glossAmount({})!;
    expect(half.amount).toBeCloseTo((est.amount / 0.9) * 0.5, 8);
  });

  it("0% and 100% validate; below 0 or above 100 BLOCKS (never clamps, never zero-costs silently)", () => {
    expect(glossAmount({ glossCoveragePct: 0 })!.amount).toBeCloseTo(0, 10);
    expect(glossAmount({ glossCoveragePct: 100 })!.amount).toBeGreaterThan(0);
    for (const bad of [-5, 150, Number.NaN]) {
      const run = computeProductDrivenCost(rolandInput({ glossLayers: 1, glossCoveragePct: bad }));
      expect(run.missing.join(" "), `coverage ${bad}`).toContain("Gloss coverage");
    }
  });

  it("larger label area produces higher gloss ink cost", () => {
    const small = glossAmount({ widthIn: 3, heightIn: 3 })!;
    const large = glossAmount({ widthIn: 6, heightIn: 6 })!;
    expect(large.amount).toBeGreaterThan(small.amount);
  });

  it("at the same size and coverage: 7X > 5X > 3X > 1X", () => {
    const at = (stages: number) => glossAmount({ glossLayers: stages })!.amount;
    expect(at(7)).toBeGreaterThan(at(5));
    expect(at(5)).toBeGreaterThan(at(3));
    expect(at(3)).toBeGreaterThan(at(1));
  });

  it("missing label dimensions BLOCK rather than returning zero-cost gloss", () => {
    const run = computeProductDrivenCost(rolandInput({ glossLayers: 3, widthIn: 0, heightIn: 0 }));
    expect(run.missing.join(" ")).toContain("Print width and height");
  });
});

describe("machine recovery — $8/hr everywhere; stale $5 records can never underprice", () => {
  it("recipe pricing uses $8/hr even when the Machine record says $5 (or $0)", () => {
    const recipe = {
      widthIn: 3, heightIn: 3, wastePct: 10, laborMinutes: 0, operatorLaborPct: 0,
      materials: [],
      machineRules: [{ preferredMachine: { costPerHour: 5, sqftPerHour: 150, inkChannels: [] } }],
    };
    const result: any = calculateInHouseRecipe(recipe, 1000, "base");
    const totalSqft = ((3 * 3 * 1000) / 144) / 0.9;
    const runHours = totalSqft / 150;
    expect(result.breakdown.machineRunCost).toBeCloseTo(runHours * machineRatePerHour(), 6);
    expect(result.breakdown.machineRunCost).toBeCloseTo(runHours * 8, 6);
    const zeroRecord: any = calculateInHouseRecipe({ ...recipe, machineRules: [{ preferredMachine: { costPerHour: 0, sqftPerHour: 150, inkChannels: [] } }] }, 1000, "base");
    expect(zeroRecord.breakdown.machineRunCost).toBeCloseTo(runHours * 8, 6);
  });

  it("product-driven pricing remains pinned to the $8/hr owner standard", () => {
    expect(machineRatePerHour()).toBe(8);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(8);
    const run = computeProductDrivenCost(stickerInput({}));
    const machineLine = run.lines.find((line) => line.key === "machine")!;
    expect(machineLine.note || "").toContain("$8/hr owner recovery standard");
    expect(machineLine.formula || "").toContain("$8/hr");
  });

  it("machine presets create records at $8/hr and LG-640 naming (no $5 presets remain)", () => {
    const source = readFileSync("app/routes/app.erp.machines.tsx", "utf8");
    expect(source).toContain('name: "Roland TrueVIS LG-640"');
    expect((source.match(/costPerHour: 8/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(source.includes("costPerHour: 5")).toBe(false);
  });
});

describe("data consistency — owner-approved values resolve correctly", () => {
  it("stickers/labels $45 minimum order total validates and resolves from owner config", async () => {
    const payload = { "sticker-bags": 75, "standard-jars": null, "premium-jars": null, "stickers-labels": 45, "banners": 40, "custom-item": 25 };
    expect(validateFamilyMoneyMap(payload).ok).toBe(true);
    const definition = ownerConfigKeyDefinition(PRICING_MIN_ORDER_TOTALS_KEY)!;
    const envelope = JSON.stringify({ schemaVersion: 1, payload, updatedAt: "2026-07-26T00:00:00.000Z", updatedBy: "owner", note: "Owner-approved $45 stickers/labels minimum (15F.0K.4B)", previous: null });
    const parsed = parseOwnerConfigValue(PRICING_MIN_ORDER_TOTALS_KEY, envelope, definition.validate, definition.codeFallback());
    expect(parsed.source).toBe("owner_config");
    const db = { erpAdminSetting: { findMany: async () => [{ key: PRICING_MIN_ORDER_TOTALS_KEY, value: envelope }] } };
    const resolved = await resolvePricingPolicyConfig(db, "942075-2.myshopify.com");
    expect(resolved.values.minimumOrderTotals["stickers-labels"]).toBe(45);
  });

  it("holographic authority formula: $488 roll at 50in x 164ft = $0.714146/sqft (never 0.6624)", () => {
    expect(488 / ((50 / 12) * 164)).toBeCloseTo(0.7141463414634146, 12);
  });
});

describe("regression — verified 4x5 bag outputs are unchanged (CMYK Mimaki path untouched)", () => {
  const bagsRule = resolveMarginFamily("bags-4x5")!;
  function bagInput(faces: number): ProductDrivenInput {
    return stickerInput({
      family: "bags-4x5", quantity: 1000, facesPerUnit: faces, widthIn: 4, heightIn: 5,
      blank: { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" },
    } as Partial<ProductDrivenInput>);
  }
  it("15G.4C: 1,000 single-sided = $1.05/unit and double-sided $1.45/unit (UV market target controlling)", () => {
    const defaults = defaultPricingPolicyValues();
    const single = computeProductDrivenCost(bagInput(1));
    expect(single.totalCost).toBeCloseTo(317.6761, 3);
    const singlePrice = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: single.totalCost, marginRule: bagsRule, premiumEligible: false, policyValues: defaults, marginCurveKey: marginCurveKeyFor("bags-4x5", 1) });
    expect(singlePrice.finalUnitPrice).toBeCloseTo(1.05, 10);
    const double = computeProductDrivenCost(bagInput(2));
    expect(double.totalCost).toBeCloseTo(534.0188, 3);
    const doublePrice = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: double.totalCost, marginRule: bagsRule, premiumEligible: false, policyValues: defaults, marginCurveKey: marginCurveKeyFor("bags-4x5", 2) });
    expect(doublePrice.finalUnitPrice).toBeCloseTo(1.45, 10);
  });
});
