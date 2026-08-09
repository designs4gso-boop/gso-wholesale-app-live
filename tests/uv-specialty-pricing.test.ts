// Phase 15G.4C — owner-approved UV market + specialty pricing policy pins.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BACK_LABEL_PREMIUM_BANDS,
  BAGS_4X5_FRONT_LADDER,
  DEEP_BUILD_MESSAGE,
  SPECIALTY_FLOOR_RULE,
  SPECIALTY_MARKET_RULE,
  backLabelPremiumForQuantity,
  computeCommercialPrice,
  defaultPricingPolicyValues,
  defaultSpecialtyPricingValues,
  marginCurveKeyFor,
  marketTargetBandFor,
} from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { validateSpecialtyPricing } from "../app/lib/owner-config.server";

const POLICY = defaultPricingPolicyValues();
const bagsRule = resolveMarginFamily("bags-4x5");

function price(input: {
  qty: number;
  faces: 1 | 2;
  cost: number;
  glossLayers?: number;
  whiteLayers?: number;
  holographic?: boolean;
  requiredWhite?: boolean;
}) {
  return computeCommercialPrice({
    familyKey: "sticker-bags",
    quantity: input.qty,
    completeCost: input.cost,
    marginRule: bagsRule,
    premiumEligible: false,
    policyValues: POLICY,
    marginCurveKey: marginCurveKeyFor("bags-4x5", input.faces),
    marketTargetSpecialtyReasons: input.glossLayers || input.whiteLayers || input.holographic ? ["specialty"] : [],
    specialty: {
      glossLayers: input.glossLayers || 0,
      decorativeWhiteLayers: input.requiredWhite ? 0 : input.whiteLayers || 0,
      requiredWhite: Boolean(input.requiredWhite),
      holographic: Boolean(input.holographic),
    },
  });
}

describe("standard UV ladder (front + back premium)", () => {
  it("front ladder and back premiums are the approved bands; double target = front + back", () => {
    const front: Record<number, number | null> = { 1: 2.15, 100: 1.3, 250: 1.15, 500: 1.05, 1000: 1.05, 2500: 0.95, 5000: null, 10000: null };
    for (const band of BAGS_4X5_FRONT_LADDER) expect(band.target).toBe(front[band.minQty]);
    expect(BACK_LABEL_PREMIUM_BANDS.map((band) => band.premium)).toEqual([0.55, 0.5, 0.48, 0.45, 0.4, 0.37]);
    for (const qty of [50, 100, 250, 500, 1000, 2500]) {
      const single = marketTargetBandFor(POLICY, "bags-4x5", qty)!.target!;
      const double = marketTargetBandFor(POLICY, "bags-4x5-double", qty)!.target!;
      expect(double).toBeCloseTo(Number((single + backLabelPremiumForQuantity(qty)).toFixed(2)), 10);
    }
    expect(backLabelPremiumForQuantity(1000)).toBe(0.4);
  });

  it("5,000+ has NO fixed UV market target — cost-led + strong crossover advisory preserved", () => {
    for (const key of ["bags-4x5", "bags-4x5-double"]) {
      for (const qty of [5000, 10000]) {
        expect(marketTargetBandFor(POLICY, key, qty)!.target).toBeNull();
        expect(marketTargetBandFor(POLICY, key, qty)!.crossover).toBe("strong");
      }
    }
  });
});

describe("specialty curve + 40% floor (pre-art cost@90 basis)", () => {
  // engine-exact costs @90% pre-art coverage (double-sided, Roland)
  const COST90_1000: Record<number, number> = { 1: 712.11, 2: 890.73, 3: 1069.35, 4: 1247.97, 5: 1426.6, 6: 1605.22, 7: 1783.84, 8: 1962.46 };
  const FINAL_1000: Record<number, number> = { 1: 1624, 2: 1740, 3: 1856, 4: 2079.95, 5: 2377.67, 6: 2675.37, 7: 2973.07, 8: 3270.77 };
  const FLOOR_FROM = 4;

  it("1X-8X finals at 1,000 double match the approved matrix; floor controls from 4X pre-art", () => {
    for (let x = 1; x <= 8; x += 1) {
      const result = price({ qty: 1000, faces: 2, cost: COST90_1000[x], glossLayers: x });
      expect(result.finalTotalPrice, `${x}X`).toBeCloseTo(FINAL_1000[x], 1);
      expect(result.controllingRule).toBe(x >= FLOOR_FROM ? SPECIALTY_FLOOR_RULE : SPECIALTY_MARKET_RULE);
      expect(result.specialty?.curvePct).toBe(defaultSpecialtyPricingValues().curve[x]);
      expect(result.marketPosition?.applicable).toBe(false); // comparisons stay suppressed
    }
  });

  it("small-run minimums: $35 (1X-3X) / $60 (4X+) beat tiny percentage premiums at qty 50", () => {
    // 50 double base = 2.70 x 50 = $135; 1X pct premium = $16.20 < $35
    const low = price({ qty: 50, faces: 2, cost: 60, glossLayers: 1 });
    expect(low.specialty?.smallRunMinimumApplied).toBe(true);
    expect(low.finalTotalPrice).toBeCloseTo(135 + 35, 6);
    const high = price({ qty: 50, faces: 2, cost: 80, glossLayers: 4 });
    expect(high.specialty?.smallRunMinimumApplied).toBe(true);
    expect(high.finalTotalPrice).toBeCloseTo(135 + 60, 6);
  });

  it("9X+ = Deep Build custom quote: no automatic market price; floor still protects", () => {
    const deep = price({ qty: 1000, faces: 2, cost: 2100, glossLayers: 9 });
    expect(deep.specialty?.deepBuild).toBe(true);
    expect(deep.specialty?.message).toBe(DEEP_BUILD_MESSAGE);
    expect(deep.controllingRule).toBe(SPECIALTY_FLOOR_RULE);
    expect(deep.finalTotalPrice).toBeCloseTo(2100 / 0.6, 6);
  });
});

describe("holographic + white treatment (additive stacking)", () => {
  it("holo-only = +20% on the standard base (1,000 double: 1450 x 1.20 = 1740)", () => {
    const holo = price({ qty: 1000, faces: 2, cost: 650.27, holographic: true });
    expect(holo.specialty?.holoPct).toBe(20);
    expect(holo.finalTotalPrice).toBeCloseTo(1450 * 1.2, 6);
    expect(holo.controllingRule).toBe(SPECIALTY_MARKET_RULE);
  });

  it("holo + 3X stacks ADDITIVELY (1450 x 1.48 = 2146), never compounded (2227.2)", () => {
    const combo = price({ qty: 1000, faces: 2, cost: 1007.26, glossLayers: 3, holographic: true });
    expect(combo.finalTotalPrice).toBeCloseTo(1450 * (1 + 0.2 + 0.28), 6);
    expect(Math.abs(combo.finalTotalPrice - 1450 * 1.2 * 1.28)).toBeGreaterThan(50);
  });

  it("required production white adds NO luxury surcharge (floor-protected only); decorative white = one +12% layer", () => {
    const required = price({ qty: 1000, faces: 2, cost: 799.7, holographic: true, whiteLayers: 1, requiredWhite: true });
    expect(required.specialty?.x).toBe(0); // white not counted as a tier
    expect(required.finalTotalPrice).toBeCloseTo(1450 * 1.2, 6); // holo only
    const decorative = price({ qty: 1000, faces: 2, cost: 700, whiteLayers: 1 });
    expect(decorative.specialty?.x).toBe(1);
    expect(decorative.specialty?.curvePct).toBe(12);
    expect(decorative.finalTotalPrice).toBeCloseTo(1450 * 1.12, 6);
  });

  it("floor overrides heavy combos: holo + required white + 3X @90 cost 1156.69 → floor 2225.92 > additive 2146", () => {
    const heavy = price({ qty: 1000, faces: 2, cost: 1335.55, glossLayers: 3, holographic: true, whiteLayers: 1, requiredWhite: true });
    // cost 1335.55/0.6 = 2225.92 exceeds 1450 x 1.48 = 2146 → floor controls
    expect(heavy.controllingRule).toBe(SPECIALTY_FLOOR_RULE);
    expect(heavy.finalTotalPrice).toBeCloseTo(1335.55 / 0.6, 2);
  });
});

describe("ownerConfig validator (fail-closed)", () => {
  it("accepts the shipped defaults and rejects bad shapes", () => {
    expect(validateSpecialtyPricing(defaultSpecialtyPricingValues()).ok).toBe(true);
    const bad = (mutate: (value: any) => void) => {
      const value: any = JSON.parse(JSON.stringify(defaultSpecialtyPricingValues()));
      mutate(value);
      return validateSpecialtyPricing(value).ok;
    };
    expect(bad((value) => { value.floorPct = 20; })).toBe(false);
    expect(bad((value) => { value.curve[3] = -1; })).toBe(false);
    expect(bad((value) => { value.curve[2] = 50; })).toBe(false); // non-decreasing violated at 3
    expect(bad((value) => { value.stackingMode = "compound"; })).toBe(false);
    expect(bad((value) => { delete value.curve[8]; })).toBe(false);
    expect(bad((value) => { value.smallRunMinimums.highMin = 1; })).toBe(false);
  });
});

describe("route wiring + guardrails", () => {
  const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
  it("calculator passes specialty context + conditional $25 file prep in loader AND save", () => {
    expect((src.match(/specialty: \{/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('pfileprep') ;
    expect(src).toContain("filePrepFeeP");
    expect(src).toContain("filePrepFeeSave");
    expect(src).toContain("Cost safety floor controls this quote.");
    expect(src.includes("admin.graphql")).toBe(false); // still no Shopify mutations
  });
  it("direct-cost formulas untouched: engine files contain no specialty-pricing imports", () => {
    const engine = readFileSync("app/lib/product-driven-costing.server.ts", "utf8");
    expect(engine.includes("specialtyPricing")).toBe(false);
    expect(engine.includes("SPECIALTY_MARKET_RULE")).toBe(false);
  });
});
