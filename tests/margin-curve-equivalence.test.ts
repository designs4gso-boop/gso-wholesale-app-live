// 15F.0K.2 Stage A equivalence proof: per-family margin BANDS + config tier
// ladders must reproduce the positional five-point curves at the global
// edges [64,128,256,640,1000] EXACTLY (quantities 1-127 always took
// curve[0], so the equivalent band starts at minQty 1). Old-vs-new margin
// math is compared at every boundary; the dollar-pinned fixture suites
// remain the primary oracle and are untouched.

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
import { dtpMarginPctForQuantity } from "../app/lib/product-driven-costing.server";
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

describe("1. exhaustive old-vs-new margin equivalence (every family x every boundary)", () => {
  it("band resolution equals positional resolution for all nine FAMILY_MARGIN_RULES", () => {
    for (const rule of FAMILY_MARGIN_RULES) {
      for (const qty of BOUNDARY_QUANTITIES) {
        expect(resolveMarginPctForQuantity(defaults, rule.key, rule, qty), `${rule.key} @ ${qty}`).toBe(marginPctForQuantity(rule, qty));
      }
    }
  });

  it("direct band math equals positional math for every configurable family", () => {
    const curves = defaultMarginCurvesValues();
    for (const key of MARGIN_CURVE_CONFIGURABLE_KEYS) {
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

  it("Stage-A band starts are the exact positional translation (1, not 64)", () => {
    expect(EQUIVALENT_BAND_MIN_QTYS).toEqual([1, 128, 256, 640, 1000]);
    expect(defaults.marginCurves.families["bags-4x5"].bands.map((band) => band.minQty)).toEqual([1, 128, 256, 640, 1000]);
    expect(defaults.marginCurves.families["bags-4x5"].bands.map((band) => band.targetPct)).toEqual([65, 58, 52, 47, 45]);
    expect(defaults.marginCurves.families["bags-4x5"].familyMinPct).toBe(45);
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

describe("6. bags-4x5-double falls back to bags-4x5 (sides price identically in Stage A)", () => {
  const bags = resolveMarginFamily("bags-4x5")!;

  it("variant key mapping is exactly bags-4x5 + faces>=2, nothing else", () => {
    expect(marginCurveKeyFor("bags-4x5", 1)).toBe("bags-4x5");
    expect(marginCurveKeyFor("bags-4x5", 2)).toBe("bags-4x5-double");
    expect(marginCurveKeyFor("bags-4x5", 3)).toBe("bags-4x5-double");
    expect(marginCurveKeyFor("stickers-labels", 2)).toBe("stickers-labels");
    expect(marginCurveKeyFor("miron-jars", 2)).toBe("miron-jars");
    expect(MARGIN_CURVE_VARIANT_BASE["bags-4x5-double"]).toBe("bags-4x5");
  });

  it("with no double entry the variant resolves to the base config and prices identically at every boundary", () => {
    expect(defaults.marginCurves.families["bags-4x5-double"]).toBeUndefined();
    expect(marginCurveConfigFor(defaults, "bags-4x5-double")).toEqual(defaults.marginCurves.families["bags-4x5"]);
    for (const qty of BOUNDARY_QUANTITIES) {
      const single = computeCommercialPrice({ familyKey: "sticker-bags", quantity: qty, completeCost: qty * 0.4 + 9.33, marginRule: bags, premiumEligible: false, policyValues: defaults, marginCurveKey: marginCurveKeyFor("bags-4x5", 1) });
      const double = computeCommercialPrice({ familyKey: "sticker-bags", quantity: qty, completeCost: qty * 0.4 + 9.33, marginRule: bags, premiumEligible: false, policyValues: defaults, marginCurveKey: marginCurveKeyFor("bags-4x5", 2) });
      expect(double).toEqual(single);
    }
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
    expect(resolveMarginPctForQuantity(custom, "bags-4x5", bags, 1000)).toBe(45); // other family untouched
    expect(dtpMarginPctForQuantity(1000)).toBe(65); // DTP untouched
    const priced = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 1000, completeCost: 500, marginRule: stickers, premiumEligible: false, finishedSqft: 0, setupTotal: 0, policyValues: custom });
    expect(priced.marginPctApplied).toBe(55);
  });
});

describe("10. display-default behavior pins (no eqty -> today's rows)", () => {
  it("Stage-A ladders are [64,128,256,640,1000] for the default and every family", () => {
    const ladders = defaultTierLaddersValues();
    expect(ladders.defaultLadder).toEqual([64, 128, 256, 640, 1000]);
    expect(ladders.defaultLadder).toEqual(SUGGESTED_QUANTITIES.slice(0, 5));
    for (const family of Object.keys(ladders.families)) expect(ladders.families[family]).toEqual([64, 128, 256, 640, 1000]);
    expect(Object.keys(ladders.families).sort()).toEqual(["banners", "custom-item", "premium-jars", "standard-jars", "sticker-bags", "stickers-labels"]);
  });

  it("route source pins: ladder + shared margin resolver wired in loader AND save; no direct positional calls remain", () => {
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
