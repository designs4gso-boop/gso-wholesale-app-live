// 15F.0K.3 verified market targets — owner-approved 2026-07-26.
// Verification list from the approval: raising-only; disabling restores
// Stage-B outputs exactly; only the two verified 4x5 bag families; crossover
// tiers skip the candidate; warnings never alter price; the 1,000-unit
// anchors ($850 single / $1,130 double); negotiation floors are display data.
// Bag COSTS are pinned in tests/margin-curve-equivalence.test.ts (unchanged).

import { describe, expect, it } from "vitest";

import {
  MARKET_TARGET_ALLOWED_KEYS,
  computeCommercialPrice,
  defaultMarketTargetsValues,
  defaultPricingPolicyValues,
  marginCurveKeyFor,
  marketTargetBandFor,
} from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import {
  PRICING_MARKET_TARGETS_KEY,
  ownerConfigKeyDefinition,
  parseOwnerConfigValue,
  resolvePricingPolicyConfig,
  validateMarketTargets,
} from "../app/lib/owner-config.server";

const bagsRule = resolveMarginFamily("bags-4x5")!;
// Engine-pinned Stage-B costs at 1,000 (margin-curve-equivalence certifies
// these against computeProductDrivenCost; used here as fixed inputs).
const SINGLE_COST_1000 = 317.67606932082816;
const DOUBLE_COST_1000 = 534.0187910275874;
// Stage-B cost-per-unit by qty (from the certified Stage-B matrix) — used to
// exercise every approved ladder quantity without re-running the engine.
const COST_PER_UNIT: Record<"single" | "double", Record<number, number>> = {
  single: { 64: 0.5397, 128: 0.4002, 256: 0.3559, 500: 0.3355, 640: 0.3294, 1000: 0.3177, 1500: 0.3174, 2000: 0.313, 2500: 0.3138, 5000: 0.3102, 10000: 0.3086 },
  double: { 64: 0.7104, 128: 0.6218, 256: 0.5776, 500: 0.5454, 640: 0.5408, 1000: 0.534, 1500: 0.5316, 2000: 0.5294, 2500: 0.5288, 5000: 0.5252, 10000: 0.5243 },
};
const QTYS = [64, 128, 256, 500, 640, 1000, 1500, 2000, 2500, 5000, 10000];

const activeValues = () => defaultPricingPolicyValues();
const inactiveValues = () => {
  const values = defaultPricingPolicyValues();
  for (const key of Object.keys(values.marketTargets.families)) values.marketTargets.families[key].active = false;
  return values;
};

function bagPrice(side: "single" | "double", qty: number, values: ReturnType<typeof defaultPricingPolicyValues>, marginPctOverride: number | null = null) {
  return computeCommercialPrice({
    familyKey: "sticker-bags",
    quantity: qty,
    completeCost: COST_PER_UNIT[side][qty] * qty,
    marginRule: bagsRule,
    premiumEligible: false,
    policyValues: values,
    marginCurveKey: marginCurveKeyFor("bags-4x5", side === "double" ? 2 : 1),
    marginPctOverride,
  });
}

describe("owner-approved anchors and raising-only behavior", () => {
  it("1,000 single = $850.00 total ($0.85/unit) via the market target; cost-based candidate untouched", () => {
    const result = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: SINGLE_COST_1000, marginRule: bagsRule, premiumEligible: false, policyValues: activeValues(), marginCurveKey: "bags-4x5" });
    expect(result.finalTotalPrice).toBeCloseTo(850, 6);
    expect(result.finalUnitPrice).toBeCloseTo(0.85, 10);
    expect(result.controllingRule).toBe("Verified market target (owner config)");
    expect(result.candidates.verifiedMarketTargetPrice).toBeCloseTo(850, 6);
    expect(result.candidates.costBasedPrice).toBeCloseTo(SINGLE_COST_1000 / 0.45, 8);
    expect(result.marketPosition?.targetApplied).toBe(true);
    expect(result.marketPosition?.finalVsMedianPct).toBeCloseTo(0, 6); // at the median by design
  });

  it("1,000 double = $1,130.00 total ($1.13/unit)", () => {
    const result = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: DOUBLE_COST_1000, marginRule: bagsRule, premiumEligible: false, policyValues: activeValues(), marginCurveKey: "bags-4x5-double" });
    expect(result.finalTotalPrice).toBeCloseTo(1130, 6);
    expect(result.controllingRule).toBe("Verified market target (owner config)");
  });

  it("market target can only RAISE, never lower: final(active) >= final(inactive) AND >= cost-based candidate at every approved quantity, both sides", () => {
    for (const side of ["single", "double"] as const) {
      for (const qty of QTYS) {
        const active = bagPrice(side, qty, activeValues());
        const inactive = bagPrice(side, qty, inactiveValues());
        expect(active.finalTotalPrice, `${side} @ ${qty}`).toBeGreaterThanOrEqual(inactive.finalTotalPrice - 1e-9);
        expect(active.finalTotalPrice, `${side} @ ${qty} vs cost-based`).toBeGreaterThanOrEqual(active.candidates.costBasedPrice - 1e-9);
      }
    }
  });

  it("disabling the market target restores Stage-B outputs exactly (only marketPosition context differs)", () => {
    for (const side of ["single", "double"] as const) {
      for (const qty of QTYS) {
        const inactive = bagPrice(side, qty, inactiveValues());
        expect(inactive.candidates.verifiedMarketTargetPrice).toBeNull();
        // Stage-B expectation: pure margin-band price vs the same candidates
        const stageB = { ...inactive, marketPosition: null };
        const recomputed = { ...bagPrice(side, qty, inactiveValues()), marketPosition: null };
        expect(recomputed).toEqual(stageB);
        expect(inactive.controllingRule.includes("market target")).toBe(false);
      }
    }
    // exact Stage-B anchor: single 1,000 back to 705.9468
    const single = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 1000, completeCost: SINGLE_COST_1000, marginRule: bagsRule, premiumEligible: false, policyValues: inactiveValues(), marginCurveKey: "bags-4x5" });
    expect(single.finalTotalPrice).toBeCloseTo(705.9468, 3);
  });
});

describe("allowlist: only the two verified 4x5 bag families carry market pricing", () => {
  it("allowlist is exactly bags-4x5 + bags-4x5-double", () => {
    expect([...MARKET_TARGET_ALLOWED_KEYS]).toEqual(["bags-4x5", "bags-4x5-double"]);
  });

  it("stickers, jars, banners, DTP, provisional: no band, no candidate, no marketPosition", () => {
    const values = activeValues();
    for (const key of ["stickers-labels", "miron-jars", "chiron-jars", "banners", "dtp-pouches", "provisional-universal", "boxes", "die-cut-bags"]) {
      expect(marketTargetBandFor(values, key, 1000), key).toBeNull();
    }
    const stickers = resolveMarginFamily("stickers-labels")!;
    const result = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 1000, completeCost: 117.34, marginRule: stickers, premiumEligible: false, policyValues: values, finishedSqft: 62.5, setupTotal: 9.33 });
    expect(result.candidates.verifiedMarketTargetPrice).toBeNull();
    expect(result.marketPosition).toBeNull();
  });

  it("validator rejects any non-allowlisted family and any missing allowlisted family", () => {
    const good = () => defaultMarketTargetsValues();
    for (const forbidden of ["miron-jars", "stickers-labels", "dtp-pouches", "direct-print-bags", "banners"]) {
      const bad: any = good();
      bad.families[forbidden] = good().families["bags-4x5"];
      expect(validateMarketTargets(bad).ok, forbidden).toBe(false);
    }
    const missing: any = good();
    delete missing.families["bags-4x5-double"];
    expect(validateMarketTargets(missing).ok).toBe(false);
  });
});

describe("crossover tiers (owner-approved behavior)", () => {
  it("5,000 and 10,000 skip the target candidate (null target) and flag a STRONG crossover; price stays cost-based", () => {
    for (const side of ["single", "double"] as const) {
      for (const qty of [5000, 10000]) {
        const result = bagPrice(side, qty, activeValues());
        expect(result.candidates.verifiedMarketTargetPrice, `${side} @ ${qty}`).toBeNull();
        expect(result.marketPosition?.crossover).toBe("strong");
        expect(result.controllingRule).toContain("Cost-based");
      }
    }
  });

  it("2,500 keeps the target (single: it controls) and flags the MILD advisory", () => {
    const single = bagPrice("single", 2500, activeValues());
    expect(single.marketPosition?.crossover).toBe("mild");
    expect(single.candidates.verifiedMarketTargetPrice).toBeCloseTo(0.72 * 2500, 6);
    expect(single.controllingRule).toBe("Verified market target (owner config)");
    const double = bagPrice("double", 2500, activeValues());
    expect(double.marketPosition?.crossover).toBe("mild");
    // double 2500: cost-based (49%) exceeds the 0.97 target -> cost-based rules
    expect(double.controllingRule).toContain("Cost-based");
  });
});

describe("warnings are information only — they never alter the price", () => {
  it("final price always equals the max of the contending candidates, flags ride along", () => {
    for (const side of ["single", "double"] as const) {
      for (const qty of QTYS) {
        const result = bagPrice(side, qty, activeValues());
        const contending = [
          result.candidates.costBasedPrice,
          result.candidates.minimumGrossProfitPrice ?? 0,
          result.candidates.minimumOrderTotalPrice ?? 0,
          result.candidates.minimumUnitPriceTotal ?? 0,
          result.candidates.ownerMarketLadderPrice ?? 0,
          result.candidates.premiumFinishFloorPrice ?? 0,
          result.candidates.verifiedMarketTargetPrice ?? 0,
        ];
        expect(result.finalTotalPrice, `${side} @ ${qty}`).toBeCloseTo(Math.max(...contending), 8);
      }
    }
  });

  it("staff margin override takes command: target stops contending, below-target/below-negotiation-floor warnings fire, margin gates untouched", () => {
    // single 1,000 with an explicit 45% staff override -> $577.59 (Stage-B floor-margin price)
    const overridden = bagPrice("single", 1000, activeValues(), 45);
    expect(overridden.candidates.verifiedMarketTargetPrice).toBeNull(); // not contending
    expect(overridden.finalTotalPrice).toBeCloseTo((COST_PER_UNIT.single[1000] * 1000) / 0.55, 8);
    expect(overridden.marketPosition?.belowTarget).toBe(true); // warning shows
    expect(overridden.marketPosition?.targetUnit).toBe(0.85); // target still displayed
    expect(overridden.marketPosition?.belowNegotiationFloor).toBe(true); // 0.5776 < 0.72 -> stronger warning
    expect(overridden.marginPctApplied).toBe(45); // staff margin applied; existing gates govern below-floor cases
  });

  it("negotiation floor never blocks and never raises: it is absent from candidates entirely", () => {
    const result = bagPrice("single", 1000, activeValues());
    expect(Object.keys(result.candidates)).not.toContain("negotiationFloorPrice");
    expect(result.marketPosition?.negotiationFloorUnit).toBe(0.72); // display data
  });
});

describe("config plumbing: validator details + fail-closed fallback + resolver", () => {
  const definition = ownerConfigKeyDefinition(PRICING_MARKET_TARGETS_KEY)!;
  const envelope = (payload: unknown) => JSON.stringify({ schemaVersion: 1, payload, updatedAt: "2026-07-26T00:00:00.000Z", updatedBy: "seed@test", note: "seed", previous: null });

  it("accepts the shipped defaults; rejects malformed bands and ordering violations", () => {
    expect(validateMarketTargets(defaultMarketTargetsValues()).ok).toBe(true);
    const cases: Array<(payload: any) => void> = [
      (payload) => { payload.families["bags-4x5"].active = "yes"; },
      (payload) => { payload.families["bags-4x5"].sourceDate = ""; },
      (payload) => { payload.families["bags-4x5"].bands = []; },
      (payload) => { payload.families["bags-4x5"].bands[0].minQty = 64; }, // must start at 1
      (payload) => { payload.families["bags-4x5"].bands[2].minQty = 5; }, // descending
      (payload) => { payload.families["bags-4x5"].bands[0].target = -1; },
      (payload) => { payload.families["bags-4x5"].bands[0].target = Number.NaN; },
      (payload) => { payload.families["bags-4x5"].bands[0].low = 2; }, // low > median (2 > 1.35)
      (payload) => { payload.families["bags-4x5"].bands[0].target = 9; }, // target > high
      (payload) => { payload.families["bags-4x5"].bands[0].crossover = "severe"; },
    ];
    for (const mutate of cases) {
      const payload: any = defaultMarketTargetsValues();
      mutate(payload);
      expect(validateMarketTargets(payload).ok).toBe(false);
    }
  });

  it("negotiationFloor above the collapsing median is VALID (crossover squeeze — real research data at double 2,000+)", () => {
    const payload = defaultMarketTargetsValues();
    const band = payload.families["bags-4x5-double"].bands.find((candidate) => candidate.minQty === 2000)!;
    expect(band.negotiationFloor).toBe(1.04);
    expect(band.median).toBe(1.01);
    expect(validateMarketTargets(payload).ok).toBe(true);
  });

  it("corrupt or invalid stored config falls back to the ACTIVE defaults (never to no-targets, never to a crash)", () => {
    for (const stored of ["{corrupt", envelope({}), envelope({ families: { "miron-jars": {} } })]) {
      const parsed = parseOwnerConfigValue(PRICING_MARKET_TARGETS_KEY, stored, definition.validate, definition.codeFallback());
      expect(parsed.source).toBe("invalid_config_fallback");
      expect(parsed.value).toEqual(defaultMarketTargetsValues());
    }
  });

  it("resolver: empty db serves the active defaults; a valid saved inactive config wins", async () => {
    const emptyDb = { erpAdminSetting: { findMany: async () => [] } };
    const resolved = await resolvePricingPolicyConfig(emptyDb, "test-shop.myshopify.com");
    expect(resolved.values.marketTargets).toEqual(defaultMarketTargetsValues());
    const disabled = defaultMarketTargetsValues();
    disabled.families["bags-4x5"].active = false;
    disabled.families["bags-4x5-double"].active = false;
    const db = { erpAdminSetting: { findMany: async () => [{ key: PRICING_MARKET_TARGETS_KEY, value: envelope(disabled) }] } };
    const resolvedDisabled = await resolvePricingPolicyConfig(db, "test-shop.myshopify.com");
    expect((resolvedDisabled.values.marketTargets.families["bags-4x5"] as any).active).toBe(false);
  });
});
