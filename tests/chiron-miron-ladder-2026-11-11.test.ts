// 2026-11-11 OWNER DECISION — Chiron jars sell on the equivalent Miron ladder.
//
// Selling price only: Chiron 100ml tall / 100ml wide / 150ml take the SAME
// customer price ladder (and holographic / specialty adders) as the
// equivalent Miron size. Chiron TRUE cost keeps its own flat blank authority
// ($1.80 / $1.80 / $1.90); margin = Chiron true cost vs the inherited price;
// the same raising-only minimum margin protection applies. Any other Chiron
// size still blocks. Saved quote snapshots are never re-priced.

import { describe, expect, it } from "vitest";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { computeCommercialPrice, defaultPricingPolicyValues } from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { CHIRON_EQUIVALENT_MIRON_SIZE, applyQuantityBreakEnvelope, resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { CHIRON_SET_COST, resolveJarBlankCost } from "../app/lib/jar-cost-inputs.server";
import { APPROVED_MARGIN_CURVE_AUTHORITIES, JAR_LADDER_LOW_MARGIN_WARNING, resolveOwnerResult, resolveSellingPriceAuthority } from "../app/lib/calculator-owner-view";
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.89, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};
const POLICY = defaultPricingPolicyValues();

const QS = (brand: string, size: string, qty: number, set = "&pjarside=1&pjarlid=1") =>
  `pfamily=premium-jars&pjarmat=matte&pqty=${qty}&pjar=${brand}/${size}${set}&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;

function job(brand: string, size: string, qty: number, set?: string) {
  const input = normalizeCanonicalInput(new URLSearchParams(QS(brand, size, qty, set)))!;
  return assembleCanonicalJob(input, CAL);
}
const blankLine = (r: any) => r.trueCost.lines.find((l: any) => l.key === "blank_sets");

/** Mirrors the calculator loader/save row pricing (same inputs, same functions). */
function price(brand: "chiron" | "miron", size: string, qty: number, set?: string) {
  const r = job(brand, size, qty, set);
  const ladder = resolveJarOwnerLadder({ brand, sizeKey: size, quantity: qty });
  const curveKey = brand === "chiron" ? "chiron-jars" : "miron-jars";
  const c = computeCommercialPrice({
    familyKey: "premium-jars", quantity: qty, completeCost: r.totalCost, marginRule: resolveMarginFamily(curveKey)!, premiumEligible: false,
    policyValues: POLICY, marginCurveKey: curveKey,
    ownerLadder: ladder.ok ? { unitPrice: ladder.quote.unitPrice, source: ladder.quote.source, label: ladder.quote.label } : null,
  });
  return { r, ladder, c };
}

const SIZES: Array<{ size: string; blank: number }> = [
  { size: "100ml_tall", blank: 1.8 },
  { size: "100ml_wide", blank: 1.8 },
  { size: "150ml", blank: 1.9 },
];

describe("Chiron selling price = equivalent Miron ladder; Chiron true cost unchanged", () => {
  it("the mapping covers exactly the three approved Chiron sizes, each to its own Miron size", () => {
    expect(CHIRON_EQUIVALENT_MIRON_SIZE).toEqual({ "100ml_tall": "100ml_tall", "100ml_wide": "100ml_wide", "150ml": "150ml" });
    expect(CHIRON_SET_COST).toEqual({ "100ml_tall": 1.8, "100ml_wide": 1.8, "150ml": 1.9 }); // true-cost authority untouched
  });

  for (const { size, blank } of SIZES) {
    it(`Chiron ${size}: true cost uses the $${blank.toFixed(2)} Chiron blank (never the Miron blank)`, () => {
      expect(resolveJarBlankCost({ brand: "chiron", size: size as any, quantity: 500 })).toMatchObject({ ok: true, unitCost: blank });
      const chiron = job("chiron", size, 500);
      const miron = job("miron", size, 500);
      expect(chiron.status).not.toBe("DRAFT_ONLY");
      const sets = Number(/^(\d+) x \$/.exec(blankLine(chiron).formula)![1]);
      expect(blankLine(chiron).formula).toBe(`${sets} x $${blank.toFixed(4)}`);
      expect(blankLine(chiron).amount).toBeCloseTo(blank * sets, 6);
      expect(blankLine(chiron).note).toContain("Chiron verified complete-set cost");
      expect(blankLine(miron).formula).not.toContain(`$${blank.toFixed(4)}`); // Miron keeps its own blank cost
    });

    it(`Chiron ${size}: customer ladder price equals the Miron ${size} ladder at every break`, () => {
      for (const qty of [50, 100, 250, 500, 1000, 2500, 4999]) {
        const c = resolveJarOwnerLadder({ brand: "chiron", sizeKey: size, quantity: qty });
        const m = resolveJarOwnerLadder({ brand: "miron", sizeKey: size, quantity: qty });
        expect(c.ok && m.ok, `${size} @ ${qty}`).toBe(true);
        if (!c.ok || !m.ok) continue;
        expect(c.quote.unitPrice).toBe(m.quote.unitPrice);
        expect(c.quote.basePrice).toBe(m.quote.basePrice);
        expect(c.quote.tierMinQty).toBe(m.quote.tierMinQty);
        expect(c.quote.inheritedFrom).toEqual({ brand: "miron", sizeKey: size });
        expect(c.quote.label).toContain("Chiron on the equivalent Miron");
      }
      // holographic and specialty adders carry over identically
      const ch = resolveJarOwnerLadder({ brand: "chiron", sizeKey: size, quantity: 250, holographic: true, specialtyX: 2 });
      const mh = resolveJarOwnerLadder({ brand: "miron", sizeKey: size, quantity: 250, holographic: true, specialtyX: 2 });
      expect(ch.ok && mh.ok && ch.quote.unitPrice === mh.quote.unitPrice).toBe(true);
    });
  }

  it("7. the label configuration is preserved: Side vs Side + Lid change true cost, not the ladder price", () => {
    const sideOnly = price("chiron", "150ml", 500, "&pjarside=1&pjarlid=0");
    const sideLid = price("chiron", "150ml", 500, "&pjarside=1&pjarlid=1");
    expect(sideLid.r.totalCost).toBeGreaterThan(sideOnly.r.totalCost);
    expect(sideOnly.c.ownerLadder?.unitPrice).toBe(sideLid.c.ownerLadder?.unitPrice); // one ladder per size, as for Miron
    const mironSideLid = price("miron", "150ml", 500, "&pjarside=1&pjarlid=1");
    expect(sideLid.c.ownerLadder?.unitPrice).toBe(mironSideLid.c.ownerLadder?.unitPrice);
  });

  it("margin = Chiron ACTUAL true cost vs the inherited Miron price", () => {
    for (const { size } of SIZES) {
      for (const qty of [250, 1000, 2500]) {
        const { r, c } = price("chiron", size, qty);
        expect(c.completeCost).toBe(r.totalCost);
        expect(c.achievedProfit).toBeCloseTo(c.finalTotalPrice - r.totalCost, 6);
        expect(c.achievedMarginPct).toBeCloseTo(((c.finalTotalPrice - r.totalCost) / c.finalTotalPrice) * 100, 6);
      }
    }
  });
});

describe("JAR LADDER AUTHORITY (owner decision 2026-11-11): the approved ladder price is never lifted by the generic floor", () => {
  it("1. Miron approved ladder is not lifted by the 45% generic floor", () => {
    const { c } = price("miron", "100ml_tall", 1000);
    expect(c.ownerLadder!.unitPrice).toBe(3.5);
    expect(c.finalUnitPrice).toBeCloseTo(3.5, 10);
    expect(c.achievedMarginPct).toBeLessThan(45); // below the generic target, still the ladder price
    expect(c.ownerLadder).toMatchObject({ raisedByFloor: false, belowGenericTarget: true, controls: true });
  });

  it("2. Chiron inherited ladder is not lifted by the 40% generic floor", () => {
    const { c } = price("chiron", "100ml_tall", 1000);
    expect(c.finalUnitPrice).toBeCloseTo(3.5, 10);
    expect(c.ownerLadder!.floorPct).toBe(40);
    expect(c.achievedMarginPct).toBeLessThan(40);
    expect(c.ownerLadder!.raisedByFloor).toBe(false);
  });

  it("3/4/5. equivalent tiers give the EXACT same customer price; true costs and realized margins stay independent", () => {
    for (const { size } of SIZES) {
      for (const qty of [50, 100, 250, 500, 1000, 2500]) {
        const m = price("miron", size, qty);
        const ch = price("chiron", size, qty);
        expect(ch.c.finalTotalPrice, `${size} x${qty}`).toBe(m.c.finalTotalPrice);
        expect(ch.c.finalTotalPrice).toBeCloseTo(m.ladder.ok ? m.ladder.quote.unitPrice * qty : NaN, 6);
        expect(ch.r.totalCost).not.toBeCloseTo(m.r.totalCost, 2); // own true costs
        expect(ch.c.achievedMarginPct).not.toBeCloseTo(m.c.achievedMarginPct, 2); // so margins differ
      }
    }
  });

  it("6. a low (even negative) realized margin never changes an approved ladder price", () => {
    const ladder = { unitPrice: 3.5, source: "s", label: "Owner ladder" };
    for (const cost of [1000, 3000, 3400, 5000]) {
      const c = computeCommercialPrice({ familyKey: "premium-jars", quantity: 1000, completeCost: cost, marginRule: resolveMarginFamily("miron-jars")!, premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: ladder });
      expect(c.finalTotalPrice, String(cost)).toBe(3500);
      expect(c.achievedProfit).toBeCloseTo(3500 - cost, 6);
    }
  });

  it("owner-only diagnostics: PRICE AUTHORITY = owner-approved jar ladder, with the informational low-margin warning (no block)", () => {
    const { r, c } = price("chiron", "100ml_tall", 1000);
    const row = { quantity: 1000, jobCost: r.totalCost, unitCost: r.unitCost, totalPrice: c.finalTotalPrice, unitPrice: c.finalUnitPrice, profit: c.achievedProfit, actualMarginPct: c.achievedMarginPct, marginPct: c.marginPctApplied, floorPct: 40, belowFloor: false, draftOnly: false, status: "READY TO QUOTE", blockers: [], commercial: { controllingRule: c.controllingRule, marginSource: c.marginSource, ownerLadder: c.ownerLadder } };
    const result = resolveOwnerResult({ family: "premium-jars", canonical: { status: "VALID", totalCost: r.totalCost, unitCost: r.unitCost, blockers: [] }, requestedRow: row, multiLine: null, marginRuleKey: "chiron-jars" })!;
    expect(result.state).toBe("READY");
    expect(result.priceAuthority).toMatch(/^Owner-approved jar ladder/);
    expect(result.recommendedTotal).toBeCloseTo(3500, 6);
    expect(result.marginWarning).toBe(JAR_LADDER_LOW_MARGIN_WARNING);
  });

  it("7. outside approved ladder authority the floor / provisional logic still applies", () => {
    // below the ladder range (no ladder): floor-protected curve, never a ladder price
    const below = price("miron", "100ml_tall", 40);
    expect(below.ladder.ok).toBe(false);
    expect(below.c.ownerLadder).toBeNull();
    expect(below.c.achievedMarginPct).toBeGreaterThanOrEqual(45 - 1e-9);
    // 5,000+ and unapproved sizes: no ladder price, provisional authority
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 5000 }).ok).toBe(false);
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "50ml", quantity: 500 }).ok).toBe(false);
    const offLadderRow = { quantity: 5000, jobCost: 100, unitCost: 0.02, totalPrice: 200, draftOnly: false, commercial: { controllingRule: "curve", marginSource: "curve", ownerLadder: null } };
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "chiron-jars", row: offLadderRow }).approved).toBe(false);
    // the envelope still holds NON-ladder rows at their floor
    const env = applyQuantityBreakEnvelope([
      { quantity: 40, totalPrice: 300, unitPrice: 7.5, profit: 100, actualMarginPct: 33, jobCost: 200, floorPct: 45, draftOnly: false, commercial: { controllingRule: "curve", ownerLadder: null } },
      { quantity: 50, totalPrice: 250, unitPrice: 5, profit: 40, actualMarginPct: 16, jobCost: 210, floorPct: 45, draftOnly: false, commercial: { controllingRule: "ladder", ownerLadder: { unitPrice: 5 } } },
    ] as any);
    expect(env[0].envelopeFloorBound).toBe(true);
    expect(env[0].totalPrice).toBeCloseTo(200 / 0.55, 6);
  });
});

describe("Chiron authority diagnostics, unknown sizes and history", () => {
  it("the pricing authority reports an APPROVED owner ladder with the Chiron inheritance diagnostic", () => {
    const { r, c } = price("chiron", "100ml_tall", 1000);
    const row = { quantity: 1000, jobCost: r.totalCost, unitCost: r.unitCost, totalPrice: c.finalTotalPrice, draftOnly: false, commercial: { controllingRule: c.controllingRule, marginSource: c.marginSource, ownerLadder: c.ownerLadder } };
    const authority = resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "chiron-jars", row });
    expect(authority).toMatchObject({ approved: true, kind: "owner_jar_ladder" });
    expect(authority.label).toContain("Chiron selling price inherited from the equivalent Miron ladder");
    expect(c.marginSource).toContain("Owner decision 2026-11-11: Chiron uses the equivalent Miron");
    // the Chiron margin CURVE itself is still not an authority
    expect(APPROVED_MARGIN_CURVE_AUTHORITIES["chiron-jars"]).toBeUndefined();
  });

  it("9. unknown / unapproved Chiron sizes still block (no invented price)", () => {
    for (const size of ["50ml", "250ml", "3oz", "4oz", "5oz", ""]) {
      expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: size, quantity: 500 })).toMatchObject({ ok: false, reason: "NO_OWNER_LADDER" });
    }
    expect(resolveJarBlankCost({ brand: "chiron", size: "50ml" as any, quantity: 500 }).ok).toBe(false);
    // off-ladder quantities follow the same Miron ladder limits
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 49 })).toMatchObject({ ok: false, reason: "BELOW_LADDER_MINIMUM" });
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 5000 })).toMatchObject({ ok: false, reason: "VOLUME_QUOTE" });
  });

  it("8/10. a historical jar quote snapshot keeps its saved cost (never re-priced)", () => {
    const oldSnapshot = JSON.stringify({ canonical: { family: "premium-jars", status: "PROVISIONAL", unitCost: 2.9876, totalCost: 1493.8, quantity: 500 } });
    const decision: any = enforceQuoteItemUnitCost({ unitCost: 0.5, quantity: 500, costSnapshot: oldSnapshot, productName: "Chiron 150ml" });
    expect(decision).toMatchObject({ protected: true, ok: true, unitCost: 2.9876 });
  });
});
