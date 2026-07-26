import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DTP_ENGINE_VERSION,
  DTP_TIER_QUANTITIES,
  SPEKTRA_FREIGHT_PER_PO,
  blankClassAllowedFor,
  canonicalUiFamily,
  classifyCalculatorProduct,
  computeProductDrivenCost,
  marginFamilyKeyFor,
  uiFamilyToEngine,
  type ProductDrivenInput,
} from "../app/lib/product-driven-costing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";

// Exact owner-verified Spektra tiers (mirrors tools/seed-spektra-dtp.mjs)
const TIERS_4X5X2 = [
  { minQty: 1000, maxQty: 2499, unitCost: 0.9897 },
  { minQty: 2500, maxQty: 4999, unitCost: 0.4922 },
  { minQty: 5000, maxQty: 7499, unitCost: 0.4033 },
  { minQty: 7500, maxQty: null, unitCost: 0.3232 },
];
const TIERS_5X4X2 = [
  { minQty: 1000, maxQty: 2499, unitCost: 1.0504 },
  { minQty: 2500, maxQty: 4999, unitCost: 0.5419 },
  { minQty: 5000, maxQty: 7499, unitCost: 0.4697 },
  { minQty: 7500, maxQty: null, unitCost: 0.3818 },
];

const INCLUDED = ["Silver PET", "Five colors including one white", "Soft-touch lamination", "Child-resistant zipper", "Tear notches", "2-inch gusset"];

function dtpInput(overrides: Partial<ProductDrivenInput> = {}): ProductDrivenInput {
  return {
    family: "dtp-bags", quantity: 2500, designs: 1, facesPerUnit: 1, widthIn: 0, heightIn: 0,
    blank: { name: "Spektra DTP 4x5x2", unitCost: 0.9897, tiers: TIERS_4X5X2, status: "verified" },
    lid: null,
    dtp: {
      sizeLabel: "Spektra DTP 4x5x2", moq: 1000, hangHole: false,
      includedFeatures: INCLUDED, optionalFeatures: [{ name: "Hang hole", amount: 0 }],
      freightPerOrder: SPEKTRA_FREIGHT_PER_PO, freightSource: "verified", freightNote: "One $85 charge per Spektra purchase order.",
    },
    material: null, printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6, machineMinutesPerSqft: 0, machineRatePerHour: 8,
    cutRequiresWeeding: false, hemming: false, grommets: false,
    freightPerUnit: 0, freightSource: "verified",
    recipeWastePct: null, wasteOverride: null, boxOverride: null,
    ...overrides,
  };
}

describe("DTP classification (15C)", () => {
  it("all four seeded Spektra records classify bag_dtp and ONLY appear under DTP Bags", () => {
    for (const name of ["Spektra DTP 4x5x2", "Spektra DTP 5x4x2", "Spektra DTP 6x5x2", "Spektra DTP 8x5x2"]) {
      const result = classifyCalculatorProduct({ name, vendor: "SPEKTRA", vendorSku: `spektra-dtp-${name.slice(12).toLowerCase()}`, productType: "dtp_bag" });
      expect(result.klass, name).toBe("bag_dtp");
    }
    expect(blankClassAllowedFor("dtp-bags", "bag_dtp")).toBe(true);
    expect(blankClassAllowedFor("dtp-bags", "bag_sticker")).toBe(false);
    expect(blankClassAllowedFor("sticker-bags", "bag_dtp")).toBe(false);
    expect(blankClassAllowedFor("standard-jars", "bag_dtp")).toBe(false);
    expect(blankClassAllowedFor("premium-jars", "bag_dtp")).toBe(false);
  });

  it("DTP is never a sticker/stock/die-cut bag; the legacy blank-pouch preset stays out of DTP", () => {
    expect(classifyCalculatorProduct({ name: "Spektra DTP 4x5x2", vendor: "SPEKTRA", productType: "dtp_bag" }).klass).not.toBe("bag_sticker");
    expect(classifyCalculatorProduct({ name: "4x5 Blank Bag", productType: "bag" }).klass).toBe("bag_sticker"); // unchanged
    expect(classifyCalculatorProduct({ name: "Template - 4x5 Outsourced Stock Bag", productType: "stock_bag" }).klass).toBe("other"); // unchanged
    // the OLD "DTP 4x5x2 Blank Pouch" preset record is a placeholder, not a Spektra product
    expect(classifyCalculatorProduct({ name: "DTP 4x5x2 Blank Pouch", vendor: "Vendor TBD", vendorSku: "preset:dtp-4x5x2-pouch", productType: "dtp_bag" }).klass).toBe("other");
  });

  it("family mapping: engine, canonical, margin rule (researched curve preserved)", () => {
    expect(uiFamilyToEngine("dtp-bags", "bag_dtp", false)).toBe("dtp-bags");
    expect(uiFamilyToEngine("dtp-pouches", null, false)).toBe("dtp-bags"); // legacy alias
    expect(canonicalUiFamily("dtp-pouches")).toBe("dtp-bags");
    expect(marginFamilyKeyFor("dtp-bags", "bag_dtp", "Spektra DTP 4x5x2")).toBe("dtp-pouches");
    const rule = resolveMarginFamily("dtp-pouches")!;
    expect(rule.curve).toEqual([65, 58, 52, 46, 42]);
    expect(rule.familyMinPct).toBe(42);
    expect(DTP_TIER_QUANTITIES).toEqual([1000, 2500, 5000, 7500]);
  });
});

describe("DTP vendor tier resolution (15C)", () => {
  it("resolves the EXACT owner costs at 1,000 / 2,500 / 5,000 / 7,500", () => {
    const expected: Array<[number, number]> = [[1000, 0.9897], [2500, 0.4922], [5000, 0.4033], [7500, 0.3232]];
    for (const [qty, unit] of expected) {
      const run = computeProductDrivenCost(dtpInput({ quantity: qty }));
      expect(run.lines.find((line) => line.key === "blank")!.amount, `qty ${qty}`).toBeCloseTo(unit * qty, 2);
    }
  });

  it("between tiers uses the RANGE-CONTAINING tier (highest reached — existing resolver semantics, never interpolated); above 7,500 stays on the top tier", () => {
    const at3000 = computeProductDrivenCost(dtpInput({ quantity: 3000 }));
    expect(at3000.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.4922 * 3000, 2); // 2,500 tier
    const at6000 = computeProductDrivenCost(dtpInput({ quantity: 6000 }));
    expect(at6000.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.4033 * 6000, 2); // 5,000 tier
    const at10000 = computeProductDrivenCost(dtpInput({ quantity: 10000 }));
    expect(at10000.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.3232 * 10000, 2); // 7,500+ tier
  });

  it("4x5x2 and 5x4x2 stay distinct (zipper location) with their own costs", () => {
    const a = computeProductDrivenCost(dtpInput({ quantity: 2500 }));
    const b = computeProductDrivenCost(dtpInput({ quantity: 2500, blank: { name: "Spektra DTP 5x4x2", unitCost: 1.0504, tiers: TIERS_5X4X2, status: "verified" } }));
    expect(a.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.4922 * 2500, 2);
    expect(b.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.5419 * 2500, 2);
  });

  it("MOQ 1,000 enforced: below-MOQ quantities are a MISSING blocker; 1,000+ passes", () => {
    const below = computeProductDrivenCost(dtpInput({ quantity: 500 }));
    expect(below.missing.some((label) => label.includes("minimum order"))).toBe(true);
    const at = computeProductDrivenCost(dtpInput({ quantity: 1000 }));
    expect(at.lines.some((line) => line.key === "moq")).toBe(false);
  });
});

describe("DTP freight + design charge (15C)", () => {
  it("$85 flat freight appears ONCE as a separate verified line — not scaled by quantity or designs; in the cost basis", () => {
    const one = computeProductDrivenCost(dtpInput({ quantity: 2500, designs: 1 }));
    const freightLines = one.lines.filter((line) => line.key === "freight");
    expect(freightLines).toHaveLength(1);
    expect(freightLines[0].amount).toBe(85);
    expect(freightLines[0].source).toBe("verified");
    const moreDesigns = computeProductDrivenCost(dtpInput({ quantity: 2500, designs: 4 }));
    expect(moreDesigns.lines.find((line) => line.key === "freight")!.amount).toBe(85); // never per design
    const moreQty = computeProductDrivenCost(dtpInput({ quantity: 7500 }));
    expect(moreQty.lines.find((line) => line.key === "freight")!.amount).toBe(85); // never per unit
    expect(one.totalCost).toBeCloseTo(0.4922 * 2500 + 85 + OWNER_STANDARDS.artSetupPerDesign.value, 2); // freight in the margin/cost basis
  });

  it("GSO design charge = art $8.3333/design ONLY — no vendor setup fee, no in-house print setup on outsourced production", () => {
    const run = computeProductDrivenCost(dtpInput({ quantity: 2500, designs: 3 }));
    const art = run.lines.find((line) => line.key === "art_setup")!;
    expect(art.amount).toBeCloseTo(3 * OWNER_STANDARDS.artSetupPerDesign.value, 4);
    expect(run.lines.some((line) => line.key === "print_setup")).toBe(false); // Spektra prints — no in-house print setup
    expect(run.setupTotal).toBeCloseTo(3 * OWNER_STANDARDS.artSetupPerDesign.value, 4);
    const vendorSetup = run.lines.find((line) => line.key === "vendor_setup")!;
    expect(vendorSetup.amount).toBe(0);
    expect(vendorSetup.source).toBe("verified");
  });

  it("no in-house lines exist: material/ink/machine/application/weeding/packing never render for DTP", () => {
    const run = computeProductDrivenCost(dtpInput({ quantity: 2500 }));
    for (const key of ["material", "ink_cmyk", "ink_white", "ink_gloss", "machine", "application", "weeding", "packing", "dimensions"]) {
      expect(run.lines.some((line) => line.key === key), key).toBe(false);
    }
    expect(run.missing).toHaveLength(0); // fully verified quote
    expect(run.warnings.some((warning) => warning.includes("Waste"))).toBe(false); // no provisional waste warning
  });
});

describe("DTP features (15C)", () => {
  it("all six included features show as $0 verified spec — never an additional charge; hang hole optional $0", () => {
    const run = computeProductDrivenCost(dtpInput({ quantity: 2500 }));
    const features = run.lines.find((line) => line.key === "features")!;
    for (const feature of INCLUDED) expect(features.label).toContain(feature);
    expect(features.amount).toBe(0);
    expect(features.source).toBe("verified");
    const hang = run.lines.find((line) => line.key === "hang_hole")!;
    expect(hang.amount).toBe(0);
    expect(hang.label).toContain("(not selected)");
    const withHole = computeProductDrivenCost(dtpInput({ quantity: 2500, dtp: { ...dtpInput().dtp!, hangHole: true } }));
    expect(withHole.lines.find((line) => line.key === "hang_hole")!.label).toContain("(selected)");
    expect(withHole.totalCost).toBeCloseTo(run.totalCost, 6); // $0 either way
  });

  it("no size selected = MISSING blocker (cost never guessed)", () => {
    const run = computeProductDrivenCost(dtpInput({ blank: null }));
    expect(run.missing.some((label) => label.includes("DTP size"))).toBe(true);
  });
});

describe("DTP route pins (15C)", () => {
  const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  const pdf = src.slice(src.indexOf("function ProductDrivenForm"));

  it("DTP-specific fields render; in-house print fields are hidden for DTP", () => {
    expect(pdf).toContain('name="phanghole"');
    expect(pdf).toContain('name="pcustomer"');
    expect(pdf).toContain('name="pnotes"');
    expect(pdf).toContain("Included product specification");
    expect(pdf).toContain("MOQ ");
    expect(pdf).toContain('{!isDtp && (!jars || sameSize === "yes") ?'); // dimensions hidden
    expect(pdf).toContain('{!isDtp ? (<label style={{ fontSize: 12 }}>* Material'); // material hidden
  });

  it("automatic tiers use DTP vendor quantities + requested qty; freight never double-added; save recomputes with the 15C engine", () => {
    // 15F.0K.2-A: the ladder branch was restructured for ownerConfig tier
    // ladders — the invariant is unchanged: DTP rows ALWAYS come from the
    // code DTP_LADDER_QUANTITIES, never from config or the generic list.
    expect(src).toContain("(isDtpP ? DTP_LADDER_QUANTITIES : configLadderP)"); // 15C.2: ladder quantities incl. 10,000
    expect(src).toContain("(savedIsDtp ? DTP_LADDER_QUANTITIES : configLadderSave)");
    expect((src.match(/isDtpP \? \{ total: 0, perUnit: 0/g) || []).length).toBe(1); // loader tier pipeline skips freight for DTP
    expect((src.match(/savedIsDtp \? \{ total: 0, perUnit: 0/g) || []).length).toBe(1); // save pipeline too
    expect(src).toContain("savedIsDtpSnapshot ? DTP_PRICING_ENGINE_VERSION : PRODUCTION_READY_ENGINE_VERSION"); // 15C.2 pricing engine preserved for DTP; 15F.0 engine for the rest
    expect(DTP_ENGINE_VERSION).toBe("15C-spektra-dtp"); // cost engine label retained in snapshots as costEngine
  });

  it("snapshot stores the full DTP record and the seed never leaks costs into app code", () => {
    for (const field of ["vendorSubtotal", "vendorUnitCost", "freightRule", "designRule", "includedFeatures", "hangHole", "requestedQuantity"]) {
      expect(src).toContain(field);
    }
    // vendor costs live ONLY in the DB/seed — the route must not hardcode them
    for (const cost of ["0.9897", "0.4922", "0.4033", "0.3232", "1.0504", "0.5419"]) {
      expect(src).not.toContain(cost);
    }
  });
});

// ---- 15C.1: quantity-based DTP margin thresholds ----
import { DTP_MARGIN_QUANTITY_THRESHOLDS, dtpMarginPctForQuantity } from "../app/lib/product-driven-costing.server";
import { curveForTierCount, defaultTierMargins } from "../app/lib/calculator-emergency.server";

describe("DTP quantity-based margins (15C.1)", () => {
  it("margin follows the owner quantity thresholds — never row count or position", () => {
    const expected: Array<[number, number]> = [
      [1000, 65], [2499, 65],
      [2500, 58], [3000, 58], [4999, 58],
      [5000, 52], [6000, 52], [7499, 52],
      [7500, 46], [8000, 46], [9999, 46],
      [10000, 42], [15000, 42],
    ];
    for (const [qty, pct] of expected) expect(dtpMarginPctForQuantity(qty), `qty ${qty}`).toBe(pct);
    expect(DTP_MARGIN_QUANTITY_THRESHOLDS).toEqual([1000, 2500, 5000, 7500, 10000]);
  });

  it("the standard four-row DTP table keeps 52% (the generic 4-row mapping would have dropped it)", () => {
    const rowMargins = DTP_TIER_QUANTITIES.map((qty) => dtpMarginPctForQuantity(qty));
    expect(rowMargins).toEqual([65, 58, 52, 46]); // 5,000 -> 52, 7,500 -> 46
    expect(rowMargins).toContain(52);
    // the generic row-count mapping (unchanged for other families) compresses to [65,58,46,42]
    expect(curveForTierCount([65, 58, 52, 46, 42], 4, 42)).toEqual([65, 58, 46, 42]);
  });

  it("requested quantities use the same rule; vendor cost above 7,500 stays on the top Spektra tier while margin drops independently", () => {
    expect(dtpMarginPctForQuantity(6000)).toBe(52); // between vendor tiers
    const at10000 = computeProductDrivenCost(dtpInput({ quantity: 10000 }));
    expect(at10000.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(0.3232 * 10000, 2); // highest reached vendor tier
    expect(dtpMarginPctForQuantity(10000)).toBe(42); // margin threshold independent of vendor tier
    // family minimum + floor preserved
    expect(dtpMarginPctForQuantity(999999)).toBe(42);
    expect(dtpMarginPctForQuantity(1)).toBe(65); // below-MOQ is blocked elsewhere; margin never below family min
  });

  it("no other family curve behavior changed", () => {
    expect(resolveMarginFamily("bags-4x5")!.curve).toEqual([65, 58, 52, 47, 45]);
    expect(resolveMarginFamily("chiron-jars")!.curve).toEqual([60, 55, 50, 45, 40]);
    expect(resolveMarginFamily("miron-jars")!.curve).toEqual([65, 58, 52, 47, 45]);
    expect(curveForTierCount([60, 55, 50, 45, 40], 4, 40)).toEqual([60, 55, 45, 40]); // generic mapping untouched
    expect(defaultTierMargins(5)).toEqual([60, 55, 50, 45, 40]); // provisional universal untouched
  });

  it("both tier pipelines (loader + save) use the shared quantity rule", () => {
    const src2 = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src2).toContain("isDtpP\n        ? tierQuantities.map((qty) => dtpMarginPctForQuantity(qty))");
    expect(src2).toContain("savedIsDtp\n      ? tierQuantitiesSave.map((qty) => dtpMarginPctForQuantity(qty))");
    expect((src2.match(/dtpMarginPctForQuantity/g) || []).length).toBeGreaterThanOrEqual(3); // import + loader + save
  });
});

// ---- 15C.2: owner selling-price ladders + safeguards ----
import {
  DTP_LADDER_QUANTITIES,
  DTP_OWNER_PRICE_LADDERS,
  DTP_PRICING_ENGINE_VERSION,
  dtpExtraDesignFeeEach,
  dtpHardFloorPct,
  ownerPriceForQuantity,
  priceDtpQuote,
} from "../app/lib/dtp-owner-pricing.server";

const LANDED_4X5X2_2500 = 0.4922 * 2500 + 85 + 25 / 3; // vendor + freight + 1 design art

describe("DTP owner price ladders (15C.2)", () => {
  it("holds all 20 exact owner prices, keyed by stable vendorSku", () => {
    const expected: Record<string, number[]> = {
      "spektra-dtp-4x5x2": [1.67, 0.88, 0.74, 0.61, 0.6],
      "spektra-dtp-5x4x2": [1.76, 0.97, 0.86, 0.72, 0.71],
      "spektra-dtp-6x5x2": [1.84, 1.04, 0.96, 0.81, 0.81],
      "spektra-dtp-8x5x2": [2.05, 1.23, 1.23, 1.05, 1.05],
    };
    expect(DTP_LADDER_QUANTITIES).toEqual([1000, 2500, 5000, 7500, 10000]);
    for (const [sku, prices] of Object.entries(expected)) {
      DTP_LADDER_QUANTITIES.forEach((qty, index) => {
        expect(DTP_OWNER_PRICE_LADDERS[sku][qty], `${sku}@${qty}`).toBe(prices[index]);
      });
    }
  });

  it("lookup: exact tier, highest-reached between tiers, above 10,000 — never interpolated", () => {
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 2500)).toEqual({ tierUsed: 2500, unitPrice: 0.88 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 1500)).toEqual({ tierUsed: 1000, unitPrice: 1.67 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 3000)).toEqual({ tierUsed: 2500, unitPrice: 0.88 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 6000)).toEqual({ tierUsed: 5000, unitPrice: 0.74 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 8000)).toEqual({ tierUsed: 7500, unitPrice: 0.61 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 25000)).toEqual({ tierUsed: 10000, unitPrice: 0.6 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 500).unitPrice).toBeNull(); // below MOQ
    expect(ownerPriceForQuantity("unknown-sku", 2500).unitPrice).toBeNull(); // no ladder — never guessed
  });

  it("PRODUCT MAPPING SAFEGUARD: 4x5x2 and 5x4x2 use their OWN ladders and never share (historical mislabel regression)", () => {
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 2500).unitPrice).toBe(0.88);
    expect(ownerPriceForQuantity("spektra-dtp-5x4x2", 2500).unitPrice).toBe(0.97);
    for (const qty of DTP_LADDER_QUANTITIES) {
      expect(ownerPriceForQuantity("spektra-dtp-4x5x2", qty).unitPrice).not.toBe(ownerPriceForQuantity("spektra-dtp-5x4x2", qty).unitPrice);
    }
  });

  it("actual margin/profit from landed cost; recommended 4x5x2 ladder lands near the study targets (~35/40/43/45/45%)", () => {
    const cases: Array<[number, number, number]> = [
      [1000, 0.9897 * 1000, 35], [2500, 0.4922 * 2500, 40], [5000, 0.4033 * 5000, 43], [7500, 0.3232 * 7500, 45], [10000, 0.3232 * 10000, 45],
    ];
    for (const [qty, vendor, approxPct] of cases) {
      const landed = vendor + 85 + 25 / 3;
      const quote = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: qty, landedCost: landed, missingCost: false, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
      expect(quote.grossProfit).toBeCloseTo(quote.customerTotal - landed, 6);
      expect(Math.abs(quote.grossMarginPct - approxPct)).toBeLessThan(2.5); // approximate study targets, actual server-derived
    }
  });

  it("floors and status ladder: 30/35/38 hard floors, 40% warning target, $500 target, $350 strategic floor, below-cost block", () => {
    expect(dtpHardFloorPct(1000)).toBe(30);
    expect(dtpHardFloorPct(2499)).toBe(30);
    expect(dtpHardFloorPct(2500)).toBe(35);
    expect(dtpHardFloorPct(4999)).toBe(35);
    expect(dtpHardFloorPct(5000)).toBe(38);
    expect(dtpHardFloorPct(10000)).toBe(38);
    const base = { ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: LANDED_4X5X2_2500, missingCost: false, designs: 1, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } };
    // 15F.0-FINAL: ladder default ~39.8% -> meets the 35% hard floor AND the
    // $500 profit target -> READY (the 40% target is an informational note,
    // never routine owner review for a normal owner-ladder quote)
    const ladder = priceDtpQuote({ ...base, customUnitPrice: null });
    expect(ladder.status).toBe("READY");
    expect(ladder.statusReasons.join(" ")).toContain("Note: below the 40% margin target");
    // healthy custom price -> READY
    expect(priceDtpQuote({ ...base, customUnitPrice: 0.95 }).status).toBe("READY");
    // below the 35% floor but profit >= $500 -> OVERRIDE REQUIRED
    const belowFloor = priceDtpQuote({ ...base, customUnitPrice: 0.79 });
    expect(belowFloor.status).toBe("OWNER OVERRIDE REQUIRED");
    expect(belowFloor.statusReasons.join(" ")).toContain("35%");
    // profit between $350 and $500 -> OVERRIDE REQUIRED
    const thinProfit = priceDtpQuote({ ...base, customUnitPrice: (LANDED_4X5X2_2500 + 400) / 2500 });
    expect(thinProfit.status).toBe("OWNER OVERRIDE REQUIRED");
    expect(thinProfit.statusReasons.join(" ")).toContain("$500");
    // profit below $350 -> BLOCKED
    expect(priceDtpQuote({ ...base, customUnitPrice: (LANDED_4X5X2_2500 + 300) / 2500 }).status).toBe("BLOCKED");
    // below cost -> BLOCKED
    expect(priceDtpQuote({ ...base, customUnitPrice: 0.4 }).status).toBe("BLOCKED");
    // missing cost -> BLOCKED
    expect(priceDtpQuote({ ...base, customUnitPrice: null, missingCost: true }).status).toBe("BLOCKED");
    // override phrase + reason satisfies the override requirement (status stays factual)
    const withOverride = priceDtpQuote({ ...base, customUnitPrice: 0.79, override: { phrase: "OWNER MARGIN OVERRIDE", reason: "strategic account entry" } });
    expect(withOverride.overrideSatisfied).toBe(true);
    expect(priceDtpQuote({ ...base, customUnitPrice: 0.79, override: { phrase: "wrong", reason: "strategic account entry" } }).overrideSatisfied).toBe(false);
  });

  it("design fees: first included; extras $25/$20/$15 by quantity; repeat order waives; internal art cost keeps EVERY design", () => {
    expect(dtpExtraDesignFeeEach(1000)).toBe(25);
    expect(dtpExtraDesignFeeEach(2499)).toBe(25);
    expect(dtpExtraDesignFeeEach(2500)).toBe(20);
    expect(dtpExtraDesignFeeEach(5000)).toBe(15);
    const threeDesigns = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: 0.4922 * 2500 + 85 + 3 * (25 / 3), missingCost: false, designs: 3, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(threeDesigns.extraDesignCount).toBe(2);
    expect(threeDesigns.extraDesignFees).toBe(40); // 2 x $20
    expect(threeDesigns.customerTotal).toBeCloseTo(0.88 * 2500 + 40, 6);
    const repeat = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: 0.4922 * 2500 + 85 + 3 * (25 / 3), missingCost: false, designs: 3, customUnitPrice: null, repeatOrder: true, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(repeat.extraDesignFees).toBe(0);
    expect(repeat.designFeeWaived).toBe(true);
    // internal cost still carries all 3 designs (landed input includes 3 x art) — engine-side test:
    const engineRun = computeProductDrivenCost(dtpInput({ quantity: 2500, designs: 3 }));
    expect(engineRun.lines.find((line) => line.key === "art_setup")!.amount).toBeCloseTo(3 * (25 / 3), 4);
    expect(engineRun.lines.some((line) => line.key === "print_setup")).toBe(false);
    expect(engineRun.lines.some((line) => line.key === "machine")).toBe(false);
  });

  it("freight: $85 internal once; embedded customer-facing by default; pass-through backs it out of the ladder subtotal (no double recovery)", () => {
    const base = { ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: LANDED_4X5X2_2500, missingCost: false, designs: 1, customUnitPrice: null as number | null, repeatOrder: false, freightAmount: 85, override: { phrase: "", reason: "" } };
    const embedded = priceDtpQuote({ ...base, passThroughFreight: false });
    expect(embedded.customerFreight).toBe(0);
    expect(embedded.customerTotal).toBeCloseTo(0.88 * 2500, 6); // no second $85 charge
    const passThrough = priceDtpQuote({ ...base, passThroughFreight: true });
    expect(passThrough.customerFreight).toBe(85);
    expect(passThrough.customerBaseSubtotal).toBeCloseTo(0.88 * 2500 - 85, 6); // backed out
    expect(passThrough.customerTotal).toBeCloseTo(embedded.customerTotal, 6); // NEVER recovered twice
    const passThroughCustom = priceDtpQuote({ ...base, passThroughFreight: true, customUnitPrice: 0.85 });
    expect(passThroughCustom.customerBaseSubtotal).toBeCloseTo(0.85 * 2500, 6); // custom price is product-only
    expect(passThroughCustom.customerTotal).toBeCloseTo(0.85 * 2500 + 85, 6);
  });

  it("route pins: owner columns render, custom-price/repeat/pass-through fields exist, save gate enforces phrase+reason, snapshot has the pricing block", () => {
    const src4 = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src4).toContain('name="pdtpcustomprice"');
    expect(src4).toContain('name="pdtprepeat"');
    expect(src4).toContain('name="pdtpfreightpass"');
    expect(src4).toContain("Owner unit price");
    expect(src4).toContain("<th>Owner tier</th>"); // owner tier column
    expect(src4).toContain("Owner price tier used"); // tier-used explanation
    expect(src4).toContain("OWNER OVERRIDE REQUIRED:");
    expect(src4).toContain("DTP quote BLOCKED:");
    expect((src4.match(/priceDtpQuote\(\{/g) || []).length).toBe(2); // loader + save — one shared function
    expect(src4).toContain("dtpPricing: savedIsDtpSnapshot");
    expect(src4).toContain("Base pouch subtotal");
    expect(DTP_PRICING_ENGINE_VERSION).toBe("15C.2-dtp-owner-price-ladders");
    // owner ladder prices are NEVER hardcoded in the route
    for (const price of ["1.67", "0.88", "0.74", "1.76", "0.97", "2.05"]) expect(src4).not.toContain(`= ${price}`);
    const setupSrc = readFileSync(new URL("../app/routes/app.erp.product-setup.tsx", import.meta.url), "utf8");
    expect(setupSrc).toContain("DTP pricing rules — owner selling-price ladders (15C.2)");
    expect(setupSrc).toContain("DTP_OWNER_PRICE_LADDERS");
  });
});
