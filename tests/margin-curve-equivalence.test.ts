// 15F.0K.2 margin-band correctness suite.
// Stage A (fc1a6bb): per-family BANDS must reproduce the positional
// five-point curves EXACTLY — still enforced below for every family EXCEPT
// 4x5 bags (quantities 1-127 always took curve[0], so equivalent bands
// start at minQty 1).
// Stage B (owner-approved 2026-07-26): 4x5 bags are DELIBERATELY
// research-calibrated — single (bags-4x5) and double-sided
// (bags-4x5-double) carry the approved study curves, band 1 stays 65% so
// no small-run price changes, and NO price decreases anywhere (proven
// old-vs-new per boundary below). All other families, DTP, and every bag
// COST pin remain byte-identical.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EQUIVALENT_BAND_MIN_QTYS,
  MARGIN_CURVE_CONFIGURABLE_KEYS,
  MARGIN_CURVE_VARIANT_BASE,
  combineStickerLines,
  computeCommercialPrice,
  defaultMarginCurvesValues,
  defaultPricingPolicyValues,
  defaultTierLaddersValues,
  marginCurveConfigFor,
  marginCurveKeyFor,
  marginPctForQuantity,
  marginPctForQuantityBands,
  resolveMarginPctForQuantity,
} from "../app/lib/commercial-pricing-policy.server";
import {
  FAMILY_MARGIN_RULES,
  MARGIN_FLOOR_PCT,
  PROVISIONAL_MARGIN_CURVE,
  SUGGESTED_QUANTITIES,
  resolveMarginFamily,
  type FamilyMarginRule,
} from "../app/lib/calculator-emergency.server";
import { computeProductDrivenCost, dtpMarginPctForQuantity, type ProductDrivenInput } from "../app/lib/product-driven-costing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import {
  PRICING_MARGIN_CURVES_KEY,
  PRICING_TIER_LADDERS_KEY,
  ownerConfigKeyDefinition,
  parseOwnerConfigValue,
} from "../app/lib/owner-config.server";

// Both sides of every band edge, the old first-edge oddity (63/64/65), the
// >=1000 flatten, and far-out volumes.
const BOUNDARY_QUANTITIES = [1, 2, 63, 64, 65, 127, 128, 129, 255, 256, 257, 500, 639, 640, 641, 999, 1000, 1001, 1500, 2500, 5000, 10000, 64000];

const defaults = defaultPricingPolicyValues();
const provisionalRule: FamilyMarginRule = { key: "provisional-universal", label: "Provisional universal curve", curve: [...PROVISIONAL_MARGIN_CURVE], familyMinPct: MARGIN_FLOOR_PCT, aliases: [] };

describe("1. old-vs-new margin equivalence (every NON-BAG family x every boundary; bags deliberately calibrated)", () => {
  it("band resolution equals positional resolution for every family except the calibrated bags-4x5", () => {
    for (const rule of FAMILY_MARGIN_RULES) {
      if (rule.key === "bags-4x5") continue; // 15F.0K.2-B deliberate research calibration (pinned below)
      for (const qty of BOUNDARY_QUANTITIES) {
        expect(resolveMarginPctForQuantity(defaults, rule.key, rule, qty), `${rule.key} @ ${qty}`).toBe(marginPctForQuantity(rule, qty));
      }
    }
  });

  it("direct band math equals positional math for every configurable non-bag family", () => {
    const curves = defaultMarginCurvesValues();
    for (const key of MARGIN_CURVE_CONFIGURABLE_KEYS) {
      if (key === "bags-4x5") continue; // calibrated (Stage B)
      const rule = resolveMarginFamily(key)!;
      for (const qty of BOUNDARY_QUANTITIES) {
        expect(marginPctForQuantityBands(curves.families[key], qty), `${key} @ ${qty}`).toBe(marginPctForQuantity(rule, qty));
      }
    }
  });

  it("provisional-universal (no config entry by design) still resolves through the rule identically", () => {
    expect(defaults.marginCurves.families["provisional-universal"]).toBeUndefined();
    for (const qty of BOUNDARY_QUANTITIES) {
      expect(resolveMarginPctForQuantity(defaults, provisionalRule.key, provisionalRule, qty)).toBe(marginPctForQuantity(provisionalRule, qty));
    }
  });

  it("non-bag band starts keep the exact positional translation (1, not 64)", () => {
    expect(EQUIVALENT_BAND_MIN_QTYS).toEqual([1, 128, 256, 640, 1000]);
    expect(defaults.marginCurves.families["stickers-labels"].bands.map((band) => band.minQty)).toEqual([1, 128, 256, 640, 1000]);
    expect(defaults.marginCurves.families["stickers-labels"].bands.map((band) => band.targetPct)).toEqual([65, 58, 52, 46, 40]);
    expect(defaults.marginCurves.families["miron-jars"].bands.map((band) => band.targetPct)).toEqual([65, 58, 52, 47, 45]);
  });

  it("15F.0K.2-B: bag curves are EXACTLY the owner-approved research values; legacy positional rule untouched", () => {
    const single = defaults.marginCurves.families["bags-4x5"];
    expect(single.familyMinPct).toBe(45);
    expect(single.bands).toEqual([
      { minQty: 1, targetPct: 65 }, { minQty: 128, targetPct: 64 }, { minQty: 256, targetPct: 61 },
      { minQty: 500, targetPct: 58 }, { minQty: 640, targetPct: 57 }, { minQty: 1000, targetPct: 55 },
      { minQty: 1500, targetPct: 52 }, { minQty: 5000, targetPct: 50 },
    ]);
    const double = defaults.marginCurves.families["bags-4x5-double"];
    expect(double.familyMinPct).toBe(45);
    expect(double.bands).toEqual([
      { minQty: 1, targetPct: 65 }, { minQty: 128, targetPct: 61 }, { minQty: 256, targetPct: 58 },
      { minQty: 500, targetPct: 54 }, { minQty: 1000, targetPct: 52 },
      { minQty: 1500, targetPct: 49 }, { minQty: 5000, targetPct: 47 },
    ]);
    // fallback-panel reference deliberately unchanged
    expect(resolveMarginFamily("bags-4x5")!.curve).toEqual([65, 58, 52, 47, 45]);
    expect(resolveMarginFamily("bags-4x5")!.familyMinPct).toBe(45);
  });
});

describe("5. full-result deep equality with and without explicit Stage-A defaults / curve keys", () => {
  const stickers = resolveMarginFamily("stickers-labels")!;
  const bags = resolveMarginFamily("bags-4x5")!;
  const CASES = [
    { familyKey: "stickers-labels", quantity: 100, completeCost: 21.158395, marginRule: stickers, premiumEligible: false, finishedSqft: 6.25, setupTotal: 25 / 3 + 1 },
    { familyKey: "stickers-labels", quantity: 1000, completeCost: 117.34, marginRule: stickers, premiumEligible: false, finishedSqft: 62.5, setupTotal: 25 / 3 + 1 },
    { familyKey: "stickers-labels", quantity: 256, completeCost: 80, marginRule: stickers, premiumEligible: true, finishedSqft: 16, setupTotal: 9.33 },
    { familyKey: "sticker-bags", quantity: 64, completeCost: 33, marginRule: bags, premiumEligible: false, finishedSqft: 0, setupTotal: 9.33 },
    { familyKey: "sticker-bags", quantity: 2500, completeCost: 925, marginRule: bags, premiumEligible: false, finishedSqft: 0, setupTotal: 9.33 },
    { familyKey: "dtp-bags", quantity: 1000, completeCost: 1083, marginRule: null, premiumEligible: false, finishedSqft: 0, setupTotal: 0 },
  ] as const;

  it("computeCommercialPrice is unchanged by explicit defaults and by an explicit base curve key", () => {
    for (const testCase of CASES) {
      const bare = computeCommercialPrice({ ...testCase });
      const withDefaults = computeCommercialPrice({ ...testCase, policyValues: defaults });
      const withKey = computeCommercialPrice({ ...testCase, policyValues: defaults, marginCurveKey: testCase.marginRule?.key ?? null });
      expect(withDefaults).toEqual(bare);
      expect(withKey).toEqual(bare);
    }
  });

  it("combineStickerLines is unchanged by explicit defaults", () => {
    const lines = [
      { name: "Line 1", quantity: 300, designs: 1, glossOrWhite: false, lineCost: 42.5, missing: [], fieldErrors: [], finishedSqft: 18.75, setupTotal: 9.33 },
      { name: "Line 2", quantity: 120, designs: 2, glossOrWhite: true, lineCost: 30.1, missing: [], fieldErrors: [], finishedSqft: 7.5, setupTotal: 18.67 },
    ];
    expect(combineStickerLines({ lines, jobPackingCost: 2, marginRule: stickers, policyValues: defaults }))
      .toEqual(combineStickerLines({ lines, jobPackingCost: 2, marginRule: stickers }));
  });
});

describe("6. bags-4x5-double: approved deliberate spread (15F.0K.2-B) + fallback still safe", () => {
  const bags = resolveMarginFamily("bags-4x5")!;
  const marginAt = (faces: number, qty: number) =>
    computeCommercialPrice({ familyKey: "sticker-bags", quantity: qty, completeCost: qty * 0.5 + 9.33, marginRule: bags, premiumEligible: false, policyValues: defaults, marginCurveKey: marginCurveKeyFor("bags-4x5", faces) }).marginPctApplied;

  it("variant key mapping is exactly bags-4x5 + faces>=2, nothing else", () => {
    expect(marginCurveKeyFor("bags-4x5", 1)).toBe("bags-4x5");
    expect(marginCurveKeyFor("bags-4x5", 2)).toBe("bags-4x5-double");
    expect(marginCurveKeyFor("bags-4x5", 3)).toBe("bags-4x5-double");
    expect(marginCurveKeyFor("stickers-labels", 2)).toBe("stickers-labels");
    expect(marginCurveKeyFor("miron-jars", 2)).toBe("miron-jars");
    expect(MARGIN_CURVE_VARIANT_BASE["bags-4x5-double"]).toBe("bags-4x5");
  });

  it("the double entry now EXISTS and resolves directly (no fallback needed)", () => {
    expect(defaults.marginCurves.families["bags-4x5-double"]).toBeDefined();
    expect(marginCurveConfigFor(defaults, "bags-4x5-double")).toEqual(defaults.marginCurves.families["bags-4x5-double"]);
  });

  it("quantities 1-127 stay side-parity at 65% (owner rule: small runs never repriced)", () => {
    for (const qty of [1, 64, 100, 127]) {
      expect(marginAt(1, qty)).toBe(65);
      expect(marginAt(2, qty)).toBe(65);
    }
  });

  it("128+ carries the approved single-vs-double spread", () => {
    const expectations: Array<[number, number, number]> = [
      [128, 64, 61], [256, 61, 58], [500, 58, 54], [640, 57, 54], [1000, 55, 52],
      [1500, 52, 49], [2000, 52, 49], [2500, 52, 49], [5000, 50, 47], [10000, 50, 47],
    ];
    for (const [qty, singlePct, doublePct] of expectations) {
      expect(marginAt(1, qty), `single @ ${qty}`).toBe(singlePct);
      expect(marginAt(2, qty), `double @ ${qty}`).toBe(doublePct);
    }
  });

  it("if an owner-config clears the double entry, the variant still falls back to bags-4x5 (never crashes, never 0)", () => {
    const cleared = defaultPricingPolicyValues();
    delete cleared.marginCurves.families["bags-4x5-double"];
    expect(marginCurveConfigFor(cleared, "bags-4x5-double")).toEqual(cleared.marginCurves.families["bags-4x5"]);
    const price = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: 534.02, marginRule: bags, premiumEligible: false, policyValues: cleared, marginCurveKey: "bags-4x5-double" });
    expect(price.marginPctApplied).toBe(55); // single curve at 1000
  });
});

describe("7/8. corrupt, incomplete, and DTP config falls back safely", () => {
  const curvesDefinition = ownerConfigKeyDefinition(PRICING_MARGIN_CURVES_KEY)!;
  const laddersDefinition = ownerConfigKeyDefinition(PRICING_TIER_LADDERS_KEY)!;
  const envelope = (payload: unknown) => JSON.stringify({ schemaVersion: 1, payload, updatedAt: "2026-07-26T00:00:00.000Z", updatedBy: "seed@test", note: "seed", previous: null });

  it("corrupt JSON, missing families, and DTP keys all resolve to the exact code defaults", () => {
    const badStored = [
      "{corrupt",
      envelope({}), // missing families object contents
      envelope({ families: { "bags-4x5": { familyMinPct: 45, bands: [{ minQty: 1, targetPct: 65 }] } } }), // missing the other required families
      envelope({ ...defaultMarginCurvesValues(), families: { ...defaultMarginCurvesValues().families, "dtp-pouches": { familyMinPct: 42, bands: [{ minQty: 1, targetPct: 65 }] } } }),
    ];
    for (const stored of badStored) {
      const parsed = parseOwnerConfigValue(PRICING_MARGIN_CURVES_KEY, stored, curvesDefinition.validate, curvesDefinition.codeFallback());
      expect(parsed.source).toBe("invalid_config_fallback");
      expect(parsed.value).toEqual(defaultMarginCurvesValues());
    }
    const ladderBad = parseOwnerConfigValue(PRICING_TIER_LADDERS_KEY, envelope({ defaultLadder: [64], families: { "dtp-bags": [1000] } }), laddersDefinition.validate, laddersDefinition.codeFallback());
    expect(ladderBad.source).toBe("invalid_config_fallback");
    expect(ladderBad.value).toEqual(defaultTierLaddersValues());
  });

  it("DTP margin thresholds never read config: constants pinned at every DTP band", () => {
    expect(dtpMarginPctForQuantity(1000)).toBe(65);
    expect(dtpMarginPctForQuantity(2500)).toBe(58);
    expect(dtpMarginPctForQuantity(5000)).toBe(52);
    expect(dtpMarginPctForQuantity(7500)).toBe(46);
    expect(dtpMarginPctForQuantity(10000)).toBe(42);
  });
});

describe("9. a custom valid config changes ONLY the intended non-DTP margin", () => {
  it("editing the stickers 1000+ band moves stickers only; bags and DTP are untouched", () => {
    const stickers = resolveMarginFamily("stickers-labels")!;
    const bags = resolveMarginFamily("bags-4x5")!;
    const custom = defaultPricingPolicyValues();
    custom.marginCurves.families["stickers-labels"] = {
      familyMinPct: 40,
      bands: [{ minQty: 1, targetPct: 65 }, { minQty: 128, targetPct: 58 }, { minQty: 256, targetPct: 52 }, { minQty: 640, targetPct: 46 }, { minQty: 1000, targetPct: 55 }],
    };
    expect(resolveMarginPctForQuantity(custom, "stickers-labels", stickers, 1000)).toBe(55);
    expect(resolveMarginPctForQuantity(custom, "stickers-labels", stickers, 999)).toBe(46); // neighbor band untouched
    expect(resolveMarginPctForQuantity(custom, "bags-4x5", bags, 1000)).toBe(55); // other family untouched (bags stays at its own 15F.0K.2-B calibrated value)
    expect(dtpMarginPctForQuantity(1000)).toBe(65); // DTP untouched
    const priced = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 1000, completeCost: 500, marginRule: stickers, premiumEligible: false, finishedSqft: 0, setupTotal: 0, policyValues: custom });
    expect(priced.marginPctApplied).toBe(55);
  });
});

describe("10. display-default behavior pins (no eqty -> configured rows)", () => {
  it("ladders: sticker-bags carries the approved 11-point research ladder; every other family keeps [64,128,256,640,1000]", () => {
    const ladders = defaultTierLaddersValues();
    expect(ladders.defaultLadder).toEqual([64, 128, 256, 640, 1000]);
    expect(ladders.defaultLadder).toEqual(SUGGESTED_QUANTITIES.slice(0, 5));
    expect(ladders.families["sticker-bags"]).toEqual([64, 128, 256, 500, 640, 1000, 1500, 2000, 2500, 5000, 10000]); // 15F.0K.2-B owner-approved
    for (const family of ["standard-jars", "premium-jars", "stickers-labels", "banners", "custom-item"]) {
      expect(ladders.families[family]).toEqual([64, 128, 256, 640, 1000]);
    }
    expect(Object.keys(ladders.families).sort()).toEqual(["banners", "custom-item", "premium-jars", "standard-jars", "sticker-bags", "stickers-labels"]);
  });

  it("route source pins (part of describe 10): ladder + shared margin resolver wired in loader AND save; no direct positional calls remain", () => {
    const source = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(source).toContain("pricingPolicy.values.tierLadders.families[canonicalUiFamily(pFamily)]");
    expect(source).toContain("pricingPolicy.values.tierLadders.families[canonicalUiFamily(pFamilySave)]");
    expect(source.match(/resolveMarginPctForQuantity\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("marginCurveKey: marginCurveKeyP");
    expect(source).toContain("marginCurveKey: marginCurveKeySave");
    expect(source.includes("marginPctForQuantity(marginRuleForPricing")).toBe(false); // positional path fully replaced in the route
    // DTP ladder stays code-only in both branches
    expect(source).toContain("(isDtpP ? DTP_LADDER_QUANTITIES : configLadderP)");
    expect(source).toContain("(savedIsDtp ? DTP_LADDER_QUANTITIES : configLadderSave)");
  });
});

// ---------- 15F.0K.2 Stage B: deliberate research calibration pins ----------
// Owner-approved 2026-07-26. These pins document the INTENTIONAL 4x5-bag
// repricing (research calibration) with exact before/after dollars computed
// through the live engine, and prove NO price decreased anywhere. Bag COSTS
// are pinned unchanged (the calibration is margin-only).
describe("15F.0K.2-B deliberate bag calibration (exact prices; no decreases)", () => {
  const POSEIDON_PER_SQFT = 213 / ((54 / 12) * 150);
  const MACHINE_RATE = OWNER_STANDARDS.machineRecoveryPerHour.value;
  const bagsRule = resolveMarginFamily("bags-4x5")!;

  function bagInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
    return {
      family: "bags-4x5", quantity: 1000, designs: 1, facesPerUnit: 1,
      widthIn: 4, heightIn: 5, labelRows: null, dtp: null,
      blank: { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" }, lid: null, mironTop: null,
      material: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
      printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
      whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6,
      machineMinutesPerSqft: 0, machineSqftPerHour: 0, machineRatePerHour: MACHINE_RATE,
      cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false,
      freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null, wasteOverride: null, boxOverride: null,
      ...overrides,
    };
  }

  // Stage-A translation of the untouched positional rule, with the K.3
  // market targets deactivated = the exact pre-Stage-B behavior baseline.
  function stageAValues() {
    const values = defaultPricingPolicyValues();
    values.marginCurves.families["bags-4x5"] = {
      familyMinPct: bagsRule.familyMinPct,
      bands: bagsRule.curve.map((targetPct, index) => ({ minQty: EQUIVALENT_BAND_MIN_QTYS[index], targetPct })),
    };
    delete values.marginCurves.families["bags-4x5-double"];
    for (const key of Object.keys(values.marketTargets.families)) values.marketTargets.families[key].active = false;
    return values;
  }

  const priceAt = (faces: number, qty: number, values: ReturnType<typeof defaultPricingPolicyValues>) => {
    const run = computeProductDrivenCost(bagInput({ quantity: qty, facesPerUnit: faces }));
    return {
      cost: run.totalCost,
      result: computeCommercialPrice({ familyKey: "sticker-bags", quantity: qty, completeCost: run.totalCost, marginRule: bagsRule, premiumEligible: false, policyValues: values, marginCurveKey: marginCurveKeyFor("bags-4x5", faces) }),
    };
  };

  it("bag COSTS are unchanged (margin-only calibration): fixture cost pins hold", () => {
    expect(computeProductDrivenCost(bagInput({ quantity: 1000, facesPerUnit: 1 })).totalCost).toBeCloseTo(317.6761, 3);
    expect(computeProductDrivenCost(bagInput({ quantity: 1000, facesPerUnit: 2 })).totalCost).toBeCloseTo(534.0188, 3);
  });

  it("exact anchors at 1,000: Stage-B cost-based candidates 705.95/1112.54; K.3 market target lifts the FINAL to $850.00 / $1,130.00", () => {
    const single = priceAt(1, 1000, defaults);
    expect(single.result.marginPctApplied).toBe(55);
    expect(single.result.candidates.costBasedPrice).toBeCloseTo(single.cost / 0.45, 10);
    expect(single.result.candidates.costBasedPrice).toBeCloseTo(705.9468, 3); // Stage-B cost-based (unchanged by K.3)
    expect(single.result.finalTotalPrice).toBeCloseTo(850, 6); // owner-approved: $0.85/unit at 1,000
    expect(single.result.controllingRule).toBe("Verified market target (owner config)");
    const double = priceAt(2, 1000, defaults);
    expect(double.result.marginPctApplied).toBe(52);
    expect(double.result.candidates.costBasedPrice).toBeCloseTo(double.cost / 0.48, 10);
    expect(double.result.candidates.costBasedPrice).toBeCloseTo(1112.5392, 3);
    expect(double.result.finalTotalPrice).toBeCloseTo(1130, 6); // owner-approved: $1.13/unit at 1,000
    expect(double.result.controllingRule).toBe("Verified market target (owner config)");
  });

  it("64-unit prices are UNCHANGED from pre-B behavior on both sides (owner rule)", () => {
    for (const faces of [1, 2]) {
      const before = priceAt(faces, 64, stageAValues());
      const after = priceAt(faces, 64, defaults);
      expect(after.result.finalTotalPrice).toBeCloseTo(before.result.finalTotalPrice, 10);
    }
    // single 64 stays min-profit-controlled ($75 over cost)
    const single64 = priceAt(1, 64, defaults);
    expect(single64.result.controllingRule).toContain("gross-profit");
    expect(single64.result.finalTotalPrice).toBeCloseTo(single64.cost + 75, 10);
  });

  it("NO price decreases anywhere: after >= before for both sides at every approved ladder quantity", () => {
    const before = stageAValues();
    for (const qty of [64, 128, 256, 500, 640, 1000, 1500, 2000, 2500, 5000, 10000]) {
      for (const faces of [1, 2]) {
        const beforePrice = priceAt(faces, qty, before).result.finalTotalPrice;
        const afterPrice = priceAt(faces, qty, defaults).result.finalTotalPrice;
        expect(afterPrice, `faces ${faces} @ ${qty}`).toBeGreaterThanOrEqual(beforePrice - 1e-9);
      }
    }
  });
});
