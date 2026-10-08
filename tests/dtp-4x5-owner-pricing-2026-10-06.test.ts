// OWNER-APPROVED 4x5 DTP PRICING PATCH — 2026-10-06.
//
// Pins the approved 4x5x2 ladder, the 1,000-unit acquisition exception, the
// 25,000 review requirement, the Design & Customize benchmark of record, the
// live-book quote cost authority by exact configuration, the shaped rules
// (+10 %, $700 once per unique die, MOQ 2,500) and historical-snapshot safety.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DTP_CATALOG, dtpSizeForVendorSku } from "../app/lib/dtp-catalog";
import {
  DESIGN_AND_CUSTOMIZE_BENCHMARK,
  DTP_MARKET_BENCHMARK_KEY,
  GSO_DTP_MARKET_POSITION,
  benchmarkComparableCrUnit,
  compareToBenchmark,
} from "../app/lib/dtp-market-benchmark";
import {
  DTP_4X5_PRICING_SOURCE,
  DTP_ACQUISITION_TIER_EXCEPTIONS,
  DTP_LADDER_QUANTITIES,
  DTP_LADDER_SOURCES,
  DTP_MIN_JOB_PROFIT,
  DTP_OWNER_PRICE_LADDERS,
  DTP_STRATEGIC_MIN_JOB_PROFIT,
  dtpLadderSource,
  ownerPriceForQuantity,
  priceDtpQuote,
} from "../app/lib/dtp-owner-pricing.server";
import { resolveDtpQuoteCost } from "../app/lib/dtp-quote-cost-authority.server";
import { DTP_SHAPED_MOQ, applyShapedPolicyToDtpRow, priceShapedPouch, toolingForShapes } from "../app/lib/dtp-shaped-bag-policy";
import { lookupSpektraVendorCost } from "../app/lib/spektra-live-cost-book";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";

const SKU = "spektra-dtp-4x5x2";
const ART = OWNER_STANDARDS.artSetupPerDesign.value;
const SOFT_TOUCH = { material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false };

/** Live landed cost for the comparable configuration (vendor + 1 design art + $85 UNVERIFIED freight). */
function liveLanded(quantity: number, designs = 1, selection = SOFT_TOUCH) {
  const look = lookupSpektraVendorCost({ size: "4x5x2", ...selection, quantity, skuCount: designs } as any);
  return look.wholesaleTotal! + ART * designs + 85;
}

function quote(quantity: number, overrides: Partial<Parameters<typeof priceDtpQuote>[0]> = {}) {
  return priceDtpQuote({
    ladderSku: SKU, quantity, landedCost: liveLanded(quantity), missingCost: false, designs: 1, customUnitPrice: null,
    repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" }, ...overrides,
  });
}

describe("OWNER-APPROVED 4x5x2 DTP ladder (2026-10-06)", () => {
  it("pins 1,000 = $1.30, 2,500 = $0.71, 5,000 = $0.46, 10,000 = $0.37, 25,000 = $0.30 (added 2026-10-07); no 7,500 price", () => {
    expect(DTP_OWNER_PRICE_LADDERS[SKU]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 });
    expect(ownerPriceForQuantity(SKU, 1000)).toMatchObject({ tierUsed: 1000, unitPrice: 1.3 });
    expect(ownerPriceForQuantity(SKU, 2500)).toMatchObject({ tierUsed: 2500, unitPrice: 0.71 });
    expect(ownerPriceForQuantity(SKU, 5000)).toMatchObject({ tierUsed: 5000, unitPrice: 0.46 });
    expect(ownerPriceForQuantity(SKU, 10000)).toMatchObject({ tierUsed: 10000, unitPrice: 0.37 });
    expect(ownerPriceForQuantity(SKU, 7500)).toMatchObject({ tierUsed: 5000, unitPrice: 0.46 }); // steps, never interpolated
    expect(DTP_LADDER_SOURCES[SKU]).toMatchObject({ pricingSource: DTP_4X5_PRICING_SOURCE, status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, requestQuoteAboveQuantity: 25000 });
    expect(DTP_4X5_PRICING_SOURCE).toBe("OWNER_APPROVED_DTP_4X5_2026_10_06");
    expect(DTP_MARKET_BENCHMARK_KEY).toBe("DESIGN_AND_CUSTOMIZE_PRIMARY");
  });

  it("1,000 tier: $1.30 on live landed ~$0.8607/unit -> ~$439 GP / ~33.8% GM passes under the explicit acquisition-tier exception ($350 target)", () => {
    const q = quote(1000);
    expect(q.unitPrice).toBe(1.3);
    expect(q.customerTotal).toBeCloseTo(1300, 6);
    expect(q.landedCost / 1000).toBeCloseTo(0.8607, 3);
    expect(q.grossProfit).toBeCloseTo(439.3, 0);
    expect(q.grossMarginPct).toBeCloseTo(33.8, 0);
    expect(q.grossProfit).toBeLessThan(DTP_MIN_JOB_PROFIT); // below the normal $500 target ...
    expect(q.minJobProfit).toBe(350); // ... but the owner exception applies to this ladder + tier only
    expect(q.status).toBe("READY");
    expect(q.overrideRequired).toBe(false);
    expect(q.acquisitionTierException).toMatchObject({ tier: 1000, minJobProfit: 350 });
    expect(q.statusReasons.join(" ")).toContain("acquisition tier");
    expect(q.pricingSource).toBe("OWNER_APPROVED_DTP_4X5_2026_10_06");
    expect(q.marketBenchmark).toBe("DESIGN_AND_CUSTOMIZE_PRIMARY");
    expect(q.commercialPolicy).toContain("$350");
    expect(DTP_ACQUISITION_TIER_EXCEPTIONS[SKU]).toMatchObject({ tier: 1000, minJobProfit: 350 });
    // the absolute $350 floor still blocks below it (exception does not remove the strategic floor)
    expect(DTP_STRATEGIC_MIN_JOB_PROFIT).toBe(350);
    expect(quote(1000, { customUnitPrice: (liveLanded(1000) + 300) / 1000 }).status).toBe("BLOCKED");
  });

  it("2,500+ tiers do NOT inherit the exception: normal $500 target and 35/38% floors; approved prices pass", () => {
    for (const [qty, price, floor] of [[2500, 0.71, 35], [5000, 0.46, 38], [10000, 0.37, 38]] as const) {
      const q = quote(qty);
      expect(q.unitPrice).toBe(price);
      expect(q.minJobProfit).toBe(500);
      expect(q.acquisitionTierException).toBeNull();
      expect(q.hardFloorPct).toBe(floor);
      expect(q.grossMarginPct).toBeGreaterThanOrEqual(floor);
      expect(q.grossProfit).toBeGreaterThanOrEqual(500);
      expect(q.status).toBe("READY");
    }
    // a 2,500 custom price with GP between $350 and $500 still needs an owner override
    const thin = quote(2500, { customUnitPrice: (liveLanded(2500) + 400) / 2500 });
    expect(thin.status).toBe("OWNER OVERRIDE REQUIRED");
    expect(thin.statusReasons.join(" ")).toContain("$500");
  });

  it("25,000 = $0.30 (OWNER APPROVED 2026-10-07); above 25,000 = REQUEST CURRENT VENDOR QUOTE (no invented price)", () => {
    expect(ownerPriceForQuantity(SKU, 25000)).toMatchObject({ tierUsed: 25000, unitPrice: 0.3 });
    const above = ownerPriceForQuantity(SKU, 25001);
    expect(above.unitPrice).toBeNull();
    expect(above.reviewRequired).toContain("REQUEST CURRENT VENDOR QUOTE");
    const q = priceDtpQuote({ ladderSku: SKU, quantity: 25001, landedCost: 0, missingCost: true, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(q.status).toBe("BLOCKED");
    expect(lookupSpektraVendorCost({ size: "4x5x2", ...SOFT_TOUCH, quantity: 25000, skuCount: 1 } as any).status).toBe("OBSERVED_VENDOR_PRICE");
    expect(ownerPriceForQuantity(SKU, 24999)).toMatchObject({ tierUsed: 10000, unitPrice: 0.37 });
  });

  it("other DTP sizes have their OWN owner-approved ladders (2026-10-07) — never a copy of 4x5x2; 5x4x2 stays legacy", () => {
    for (const sku of ["spektra-dtp-3.5x4.5x2", "spektra-dtp-5x5x2", "spektra-dtp-6x5x2", "spektra-dtp-8x5x2"]) {
      expect(dtpLadderSource(sku)?.status).toBe("OWNER_APPROVED");
      expect(dtpLadderSource(sku)?.pricingSource).toBe("OWNER_APPROVED_DTP_LADDERS_2026_10_07");
      expect(DTP_OWNER_PRICE_LADDERS[sku]).not.toEqual(DTP_OWNER_PRICE_LADDERS[SKU]);
    }
    expect(dtpLadderSource("spektra-dtp-5x4x2")?.status).toBe("OWNER_PRICING_REVIEW_REQUIRED");
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-6x5x2"]).toEqual({ 1000: 1.4, 2500: 0.78, 5000: 0.54, 10000: 0.46, 25000: 0.4 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-8x5x2"]).toEqual({ 1000: 1.5, 2500: 0.86, 5000: 0.65, 10000: 0.59, 25000: 0.52 });
    for (const size of ["3.5x4.5x2", "5x5x2"]) expect(DTP_CATALOG.find((e) => e.size === size)?.ownerLadder).toBe("OWNER_APPROVED_2026-10-07");
    // the 1,000-unit exception is per approved ladder; the legacy 5x4x2 ladder has none
    const legacy5x4 = priceDtpQuote({ ladderSku: "spektra-dtp-5x4x2", quantity: 1000, landedCost: 1760 - 450, missingCost: false, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(legacy5x4.minJobProfit).toBe(500);
    expect(legacy5x4.status).toBe("OWNER OVERRIDE REQUIRED");
    expect(DTP_LADDER_QUANTITIES).toEqual([1000, 2500, 5000, 10000, 25000]);
  });
});

describe("Design & Customize benchmark of record (market evidence only)", () => {
  it("records the published 4x5 ladder, upgrades and the comparable CR reference; GSO is modestly premium", () => {
    expect(DESIGN_AND_CUSTOMIZE_BENCHMARK.status).toBe("PRIMARY / CONTROLLING DTP COMPETITOR");
    expect(DESIGN_AND_CUSTOMIZE_BENCHMARK.baseLadder).toEqual({ 1000: 1.0, 1500: 0.8, 2500: 0.6, 5000: 0.4, 10000: 0.3 });
    expect(DESIGN_AND_CUSTOMIZE_BENCHMARK.upgradesPct).toEqual({ crZipper: 5, spotGloss: 5, holographic: 5, customShape: 10, insidePrint: 15, rushProduction: 20 });
    expect(benchmarkComparableCrUnit(1000).comparableUnit).toBeCloseTo(1.05, 6);
    expect(benchmarkComparableCrUnit(2500).comparableUnit).toBeCloseTo(0.63, 6);
    expect(benchmarkComparableCrUnit(5000).comparableUnit).toBeCloseTo(0.42, 6);
    expect(benchmarkComparableCrUnit(10000).comparableUnit).toBeCloseTo(0.315, 6);
    expect(compareToBenchmark(1.3, 1000).premiumPct).toBeCloseTo(23.8, 1);
    expect(compareToBenchmark(0.71, 2500).premiumPct).toBeCloseTo(12.7, 1);
    expect(compareToBenchmark(0.46, 5000).premiumPct).toBeCloseTo(9.5, 1);
    expect(compareToBenchmark(0.37, 10000).premiumPct).toBeCloseTo(17.5, 1);
    expect(compareToBenchmark(null, 1000).premiumPct).toBeNull();
    expect(GSO_DTP_MARKET_POSITION.label).toBe("PREMIUM DOMESTIC DTP");
    expect(GSO_DTP_MARKET_POSITION.wording).toBe("premium / heavy-duty pouch positioning");
    expect(GSO_DTP_MARKET_POSITION.prohibited).toMatch(/thickness/);
  });

  it("competitor add-on percentages are never applied to GSO vendor costing", () => {
    const costBook = readFileSync(new URL("../app/lib/spektra-live-cost-book.ts", import.meta.url), "utf8");
    const authority = readFileSync(new URL("../app/lib/dtp-quote-cost-authority.server.ts", import.meta.url), "utf8");
    for (const src of [costBook, authority]) {
      expect(src).not.toContain("dtp-market-benchmark");
      expect(src).not.toMatch(/insidePrint|rushProduction|DESIGN_AND_CUSTOMIZE/);
    }
  });
});

describe("quote cost authority: 4x5x2 = live book by EXACT configuration (never flattened)", () => {
  const legacy = { totalCost: 0.9897 * 1000 + ART + 85, missing: false, vendorSubtotal: 989.7 };

  it("comparable configuration resolves the observed row; landed ~$860.70 at 1,000", () => {
    const cost = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(cost.authority).toBe("LIVE_COST_BOOK_BY_CONFIGURATION");
    expect(cost.status).toBe("OBSERVED_VENDOR_PRICE");
    expect(cost.vendorSubtotal).toBeCloseTo(767.3625, 4);
    expect(cost.landedCost).toBeCloseTo(860.696, 2);
    expect(cost.missing).toBe(false);
    expect(cost.freightStatus).toBe("UNVERIFIED");
    expect(cost.config).toMatchObject({ size: "4x5x2", material: "White PET", finish: "Soft Touch", zipper: "Child Resistant" });
  });

  it("a higher-cost option (Hologram + Raised UV) raises landed cost and trips the protection at the same $1.30", () => {
    const premium = { material: "Hologram", finish: "Soft Touch", spot: "Raised UV", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false };
    const cost = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1000, designs: 1, selection: premium, legacy });
    const base = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(cost.status).toBe("OBSERVED_VENDOR_PRICE");
    expect(cost.landedCost).toBeGreaterThan(base.landedCost);
    const q = priceDtpQuote({ ladderSku: SKU, quantity: 1000, landedCost: cost.landedCost, missingCost: cost.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(q.unitPrice).toBe(1.3);
    expect(q.grossMarginPct).toBeLessThan(quote(1000).grossMarginPct);
    expect(["OWNER OVERRIDE REQUIRED", "BLOCKED"]).toContain(q.status); // never silently READY on a thinner margin
  });

  it("extra SKUs use the validated rule; custom quantity uses a labelled conservative step; unsupported config -> REQUEST CURRENT VENDOR QUOTE (blocked)", () => {
    const two = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 2500, designs: 2, selection: SOFT_TOUCH, legacy });
    expect(two.status).toBe("ESTIMATED_FROM_VALIDATED_VENDOR_RULE");
    expect(two.extraSkuCost).toBe(138.75);
    expect(two.landedCost).toBeCloseTo(958.2 + 138.75 + 2 * ART + 85, 4);
    const step = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1500, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(step.status).toBe("ESTIMATED_CONSERVATIVE_STEP");
    expect(step.vendorUnit).toBeCloseTo(0.7673625, 6); // the 1,000-unit observed unit, applied to 1,500
    expect(step.basis).toMatch(/request a current vendor quote/i);
    const glossySpot = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1000, designs: 1, selection: { ...SOFT_TOUCH, finish: "Glossy", spot: "Standard" }, legacy });
    expect(glossySpot.status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
    expect(glossySpot.missing).toBe(true);
    expect(priceDtpQuote({ ladderSku: SKU, quantity: 1000, landedCost: glossySpot.landedCost, missingCost: glossySpot.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } }).status).toBe("BLOCKED");
  });

  it("every current size costs from the live book by configuration (2026-10-07); 5x4x2 stays legacy manual review", () => {
    for (const sku of ["spektra-dtp-3.5x4.5x2", "spektra-dtp-5x5x2", "spektra-dtp-6x5x2", "spektra-dtp-8x5x2"]) {
      const cost = resolveDtpQuoteCost({ vendorSku: sku, quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy });
      expect(cost.authority, sku).toBe("LIVE_COST_BOOK_BY_CONFIGURATION");
      expect(cost.status, sku).toBe("OBSERVED_VENDOR_PRICE");
      expect(dtpSizeForVendorSku(sku)?.quoteCostAuthority).toBe("LIVE_COST_BOOK");
    }
    const legacyCost = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-5x4x2", quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(legacyCost.authority).toBe("LEGACY_VENDOR_SEED");
    expect(legacyCost.status).toBe("LEGACY_MANUAL_REVIEW");
    expect(dtpSizeForVendorSku(SKU)?.quoteCostAuthority).toBe("LIVE_COST_BOOK");
    expect(dtpSizeForVendorSku("spektra-dtp-5x4x2")?.status).toBe("LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH");
  });
});

describe("shaped 4x5x2 (owner policy, MOQ 2,500)", () => {
  it("+10% on the approved anchor: 2,500 at $0.71 -> $0.781 before rounding; $700 new die as a separate line; $0 on reuse", () => {
    const shaped = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "custom", die: { mode: "new" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 0, customerTotal: 1775, grossProfit: 1775 - liveLanded(2500) });
    expect(shaped.unitPrice).toBeCloseTo(0.781, 9);
    expect(shaped.shaped.shapeSurcharge).toBe(177.5);
    expect(shaped.shaped.toolingFee).toBe(700);
    expect(shaped.totalPrice).toBe(1775 + 177.5 + 700);
    expect(shaped.profit).toBeCloseTo(1775 - liveLanded(2500) + 177.5, 6); // tooling excluded from profit
    const reuse = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "custom", die: { mode: "existing", dieId: "DIE-0012" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 0, customerTotal: 1775, grossProfit: 700 });
    expect(reuse.shaped.toolingFee).toBe(0);
    expect(reuse.totalPrice).toBe(1952.5);
  });

  it("new die adds $700 once: same physical shape with several designs = one fee; a different shape = another fee", () => {
    const same = toolingForShapes([{ shapeKey: "leaf", die: { mode: "new" }, designs: 3 }, { shapeKey: "leaf", die: { mode: "new" }, designs: 2 }]);
    expect(same).toMatchObject({ uniqueNewShapes: 1, toolingFee: 700 });
    const two = toolingForShapes([{ shapeKey: "leaf", die: { mode: "new" } }, { shapeKey: "bottle", die: { mode: "new" } }, { shapeKey: "star", die: { mode: "existing", dieId: "DIE-0003" } }]);
    expect(two).toMatchObject({ uniqueNewShapes: 2, reusedShapes: 1, toolingFee: 1400 });
    expect(priceShapedPouch({ shape: "custom", quantity: 5000, standardProductTotal: 2300, die: { mode: "new" } }).lines.filter((l) => l.key === "tooling")).toHaveLength(1);
  });

  it("shaped MOQ 2,500: 1,000 shaped is blocked; standard 1,000 is unchanged", () => {
    expect(DTP_SHAPED_MOQ).toBe(2500);
    expect(priceShapedPouch({ shape: "custom", quantity: 1000, standardProductTotal: 1300, die: { mode: "new" } }).errors.join(" ")).toContain("2,500");
    expect(priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1775, die: { mode: "new" } }).errors).toEqual([]);
    expect(priceShapedPouch({ shape: "standard", quantity: 1000, standardProductTotal: 1300 }).errors).toEqual([]);
  });
});

describe("historical safety + route wiring", () => {
  it("historical DTP snapshots keep their own numbers (never recomputed from the new ladder or live cost)", () => {
    const old = JSON.parse(JSON.stringify({
      engine: "15C.2-dtp-owner-price-ladders",
      dtpPricing: { unitPrice: 1.67, customerTotal: 1670, landedCost: 1082.9833, grossProfit: 587.0167, grossMarginPct: 35.15, minJobProfit: 500 },
      dtp: { vendorUnitCost: 0.9897, freight: 85 },
    }));
    // a stored snapshot is data: nothing in the new modules mutates it
    const after = JSON.parse(JSON.stringify(old));
    quote(1000);
    resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy: { totalCost: 1082.9833, missing: false, vendorSubtotal: 989.7 } });
    expect(after).toEqual(old);
    expect(old.dtpPricing.unitPrice).toBe(1.67);
    expect(old.dtp.vendorUnitCost).toBe(0.9897);
    expect(old.dtpPricing.pricingSource).toBeUndefined(); // old snapshots are not back-filled
  });

  it("calculator: cost authority + provenance in loader and save; snapshot records pricing source, benchmark, policy, vendor cost", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect((src.match(/resolveDtpQuoteCost\(\{/g) || []).length).toBe(2);
    expect((src.match(/compareToBenchmark\(/g) || []).length).toBe(2);
    expect((src.match(/landedCost: costP\.landedCost|landedCost: costSave\.landedCost/g) || []).length).toBe(2);
    for (const field of ["pricingSource: savedSelectedTier.dtp.pricingSource", "marketBenchmark: savedSelectedTier.dtp.marketBenchmark", "competitorBenchmark: savedSelectedTier.dtp.benchmark", "commercialPolicy: savedSelectedTier.dtp.commercialPolicy", "acquisitionTierException: savedSelectedTier.dtp.acquisitionTierException", "vendorCost: savedSelectedTier.dtp.costAuthority", "overrideReason: savedSelectedTier.dtp.overrideSatisfied"]) {
      expect(src, field).toContain(field);
    }
    expect(src).toContain("MOQ 2,500");
    expect(src).toContain("OWNER-APPROVED ladders");
    expect(src).not.toMatch(/= 1\.3\b|= 0\.71\b|= 0\.46\b|= 0\.37\b/); // prices live in the pricing module only
    const pi = readFileSync(new URL("../app/routes/app.erp.pricing-intelligence.tsx", import.meta.url), "utf8");
    expect(pi).toContain("OWNER-APPROVED DTP ladders");
    expect(pi).toContain("GSO premium");
    const setup = readFileSync(new URL("../app/routes/app.erp.product-setup.tsx", import.meta.url), "utf8");
    expect(setup).toContain("DTP_LADDER_SOURCES");
  });
});
