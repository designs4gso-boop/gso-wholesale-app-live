// 15F.0 FORENSIC FIXTURES — updated for the production-ready pricing engine.
// The original 15F.0 audit pins documented the DEFECTS (margin-by-row-position,
// $0 machine/cutting/packing); this file now pins the CORRECTED behavior with
// the same independent-reconstruction discipline: every expected value derives
// from verified production DB records (IDs in comments, read 2026-07-25) and
// owner standards — never copied from engine output.

import { describe, expect, it } from "vitest";

import {
  CUT_SQUARE_RECT_STANDARD,
  computeProductDrivenCost,
  WEEDING_PAGE_SQFT,
  unitsPerBoxFor,
  type ProductDrivenInput,
} from "../app/lib/product-driven-costing.server";
import { INK_RATES, marginMath, resolveMarginFamily, OWNER_LABOR } from "../app/lib/calculator-emergency.server";
import { computeCommercialPrice, marginPctForQuantity } from "../app/lib/commercial-pricing-policy.server";
import { applyWasteDivisor } from "../app/lib/recipe-pricing.server";
import { blankItemUnitCostAtQty, resolvePrintMaterialCostPerSqft } from "../app/lib/cost-calculator.server";
import { priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";

// ---- Production DB truth (read-only sample 2026-07-25) ----
// Material cmoxmgvx80000jj28acnr8ycp "Poseidon Matte Roll Media": $213/roll,
// 54in x 150ft -> 675 sqft -> $0.315555.../sqft
const POSEIDON_PER_SQFT = 213 / ((54 / 12) * 150);
// Material cmrpkqxgp0006ef1sn52kwq5b "Banner Vinyl": $140 / (4.5ft x 105ft)
const BANNER_PER_SQFT = 140 / ((54 / 12) * 105);
// Machine cmozcqiib000hfj28hcsc2wez "Mimaki UCJV300-130": 150 sqft/hr verified
// speed; recovery rate = $8/hr OWNER standard (NOT the stale $5 record rate).
const PRINTER_SQFT_PER_HOUR = 150;
const MACHINE_RATE = OWNER_STANDARDS.machineRecoveryPerHour.value; // $8/hr
const CALC_INK_ML_PER_SQFT = 0.6;

function baseInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
  return {
    family: "stickers-labels", quantity: 100, designs: 1, facesPerUnit: 1,
    widthIn: 3, heightIn: 3, labelRows: null, dtp: null, blank: null, lid: null,
    mironTop: null, material: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
    printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: CALC_INK_ML_PER_SQFT,
    machineMinutesPerSqft: 0, machineSqftPerHour: PRINTER_SQFT_PER_HOUR, machineRatePerHour: MACHINE_RATE,
    cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false,
    freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null,
    wasteOverride: null, boxOverride: null,
    ...overrides,
  };
}

describe("15F.0-B unit and dimension conversions", () => {
  it("square-inch -> square-foot uses /144 with quantity applied exactly once", () => {
    const run = computeProductDrivenCost(baseInput({}));
    expect(run.derived.sqinPerPiece).toBe(9); // 3 x 3
    expect(run.derived.totalPieces).toBe(100);
    expect(run.derived.baseSqft).toBeCloseTo((3 * 3 * 100) / 144, 10); // 6.25 — qty once, never twice
  });

  it("roll cost -> $/sqft conversion matches production records exactly", () => {
    expect(POSEIDON_PER_SQFT).toBeCloseTo(0.3155555555555555, 12); // = stored calculatedUnitCost
    expect(BANNER_PER_SQFT).toBeCloseTo(0.2962962962962963, 12);
    expect(resolvePrintMaterialCostPerSqft({ calculatedUnitCost: 0.002, baseUnit: "sqin" }).unitCost).toBeCloseTo(0.288, 10);
  });

  it("waste is a divisor (required input = base / (1 - waste%)), never a multiplier", () => {
    expect(applyWasteDivisor(100, 10)).toBeCloseTo(111.1111111111, 6);
    const run = computeProductDrivenCost(baseInput({}));
    expect(run.derived.wastePct).toBe(10); // provisional — recipe waste wiring is a listed owner follow-up
    expect(run.derived.wasteAdjustedSqft).toBeCloseTo(6.25 / 0.9, 10);
  });

  it("weeding page constant is a true 54x54in page (20.25 sqft) and pages round up", () => {
    expect(WEEDING_PAGE_SQFT).toBeCloseTo((54 * 54) / 144, 12);
    const run = computeProductDrivenCost(baseInput({ cutRequiresWeeding: true }));
    expect(run.derived.weedingPages).toBe(Math.ceil(6.25 / 20.25)); // 1
  });

  it("packout boxes round up; configured rules win; jar family default 100/box; single-box floor otherwise", () => {
    expect(unitsPerBoxFor("4x5 Blank Bag").unitsPerBox).toBe(1000);
    expect(unitsPerBoxFor("Chiron 100 ml").unitsPerBox).toBeNull(); // no rule -> 15F.0 jar family default handles it
    const bags = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1001, blank: { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" } }));
    expect(bags.derived.boxes).toBe(2); // ceil(1001/1000)
    const jars = computeProductDrivenCost(baseInput({ family: "chiron-jars", quantity: 585, blank: { name: "Chiron 100 ml", unitCost: 1.8, tiers: [], status: "verified" } }));
    expect(jars.derived.boxes).toBe(6); // ceil(585/100) family default, labeled estimated
    expect(jars.lines.find((line) => line.key === "packing")!.source).toBe("estimated");
    const stickers = computeProductDrivenCost(baseInput({}));
    expect(stickers.lines.find((line) => line.key === "packing")!.amount).toBe(2); // single-box job floor
  });

  it("blank tier selection below the lowest tier still charges the lowest tier with a warning", () => {
    const result = blankItemUnitCostAtQty([{ minQty: 1000, maxQty: 2499, unitCost: 0.9897 }], 0, 500, "Spektra DTP 4x5x2");
    expect(result.unitCost).toBe(0.9897);
    expect(result.warning).toContain("below the lowest cost tier");
  });

  it("blank quantities that fail to parse become blockers, never silent zeros", () => {
    const run = computeProductDrivenCost(baseInput({ widthIn: 0, heightIn: 0 }));
    expect(run.missing.join(" ")).toContain("Print width and height");
  });
});

describe("15F.0-I margin formula and rounding", () => {
  it("price = cost / (1 - margin) — true gross margin, not markup", () => {
    const { price, actualMarginPct } = marginMath(12, 60);
    expect(price).toBeCloseTo(30, 10); // markup would give 19.20
    expect(actualMarginPct).toBeCloseTo(60, 10);
  });

  it("FIXED (was P0-1): margin comes from QUANTITY bands — row count cannot shift it", () => {
    const stickers = resolveMarginFamily("stickers-labels")!;
    expect(stickers.curve).toEqual([65, 58, 52, 46, 40]);
    // researched band mapping (64/128/256/640/1000 edges from the margin study)
    expect(marginPctForQuantity(stickers, 64)).toBe(65);
    expect(marginPctForQuantity(stickers, 100)).toBe(65); // was 60 under row interpolation
    expect(marginPctForQuantity(stickers, 128)).toBe(58); // was 55 when a 6th row rendered
    expect(marginPctForQuantity(stickers, 256)).toBe(52);
    expect(marginPctForQuantity(stickers, 999)).toBe(46);
    expect(marginPctForQuantity(stickers, 1000)).toBe(40);
    expect(marginPctForQuantity(stickers, 50000)).toBe(40); // never below family min
  });
});

describe("15F.0-A fixture 1: 100 x 3x3 matte square-cut stickers (corrected quote)", () => {
  const run = computeProductDrivenCost(baseInput({}));
  const wasteSqft = 6.25 / 0.9;
  const material = POSEIDON_PER_SQFT * wasteSqft; // 2.191358
  const ink = INK_RATES.mimakiCmykPerMl * CALC_INK_ML_PER_SQFT * wasteSqft; // 0.733333
  const machine = (wasteSqft / PRINTER_SQFT_PER_HOUR) * MACHINE_RATE; // 0.370370
  const cutting = CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(6.25 / 20.25); // 6.53
  const packing = 2; // single-box floor
  const setup = OWNER_LABOR.artSetupPerDesign + OWNER_LABOR.printSetupPerDesign; // 9.333333

  it("complete cost = material + ink + machine + cutting + packing + setup = $21.16 (was $12.26 with silent $0s)", () => {
    expect(run.lines.find((line) => line.key === "machine")!.amount).toBeCloseTo(machine, 6);
    expect(machine).toBeCloseTo(0.3704, 4);
    expect(run.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(6.53, 10);
    expect(run.lines.find((line) => line.key === "packing")!.amount).toBe(2);
    expect(run.totalCost).toBeCloseTo(material + ink + machine + cutting + packing + setup, 6);
    expect(run.totalCost).toBeCloseTo(21.1584, 4);
    expect(run.missing).toHaveLength(0); // genuinely READY — nothing silent
  });

  it("outbound shipping is EXCLUDED (stated), never missing; machine has formula + source", () => {
    const shipping = run.lines.find((line) => line.key === "shipping_outbound")!;
    expect(shipping.source).toBe("excluded");
    expect(shipping.amount).toBe(0);
    expect(shipping.label).toContain("not included");
    const machineLine = run.lines.find((line) => line.key === "machine")!;
    expect(machineLine.formula).toContain("min/sqft");
    expect(machineLine.note).toContain("150 sqft/hr");
    expect(machineLine.note).toContain("$8/hr");
  });

  it("price at the researched 65% band = $60.45 total ($0.60/unit) — in the $50-80 market range", () => {
    const priced = marginMath(run.totalCost, 65);
    expect(priced.price).toBeCloseTo(60.4526, 3);
    expect(priced.price / 100).toBeCloseTo(0.6045, 4);
  });

  it("missing machine speed BLOCKS instead of pricing $0 (gate L)", () => {
    const blocked = computeProductDrivenCost(baseInput({ machineSqftPerHour: 0 }));
    expect(blocked.missing.join(" ")).toContain("Machine recovery");
  });

  it("die-cut/irregular production without an owner model BLOCKS with the exact configuration message (contour bands quote automatically)", () => {
    const die = computeProductDrivenCost(baseInput({ cutType: "die-irregular" }));
    const cutLine = die.lines.find((line) => line.key === "cutting")!;
    expect(cutLine.source).toBe("missing");
    expect(cutLine.note).toContain("Cutting standard required for this cut type");
    const simple = computeProductDrivenCost(baseInput({ cutType: "kiss-simple" }));
    expect(simple.missing).toHaveLength(0); // 15F.0-FINAL: simple contour is READY
  });
});

describe("15F.0-M remaining forensic fixtures (corrected engine)", () => {
  it("fixture 2: 1,000 x 3x3 stickers — cost $70.40; the AREA MARKET FLOOR controls at $209.33 (15F.0-FINAL)", () => {
    const run = computeProductDrivenCost(baseInput({ quantity: 1000 }));
    const wasteSqft = 62.5 / 0.9;
    const expected = POSEIDON_PER_SQFT * wasteSqft
      + INK_RATES.mimakiCmykPerMl * 0.6 * wasteSqft
      + (wasteSqft / PRINTER_SQFT_PER_HOUR) * MACHINE_RATE
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(62.5 / 20.25) // 4 pages
      + 2 + 9.333333333333334;
    expect(run.totalCost).toBeCloseTo(expected, 5);
    expect(run.totalCost).toBeCloseTo(70.4040, 3);
    expect(marginMath(run.totalCost, 40).price).toBeCloseTo(117.3400, 2); // cost-based candidate
    // 62.5 finished sqft -> $3.20/sqft anchor band + setup recovery = $209.33
    const commercial = computeCommercialPrice({
      familyKey: "stickers-labels", quantity: 1000, completeCost: run.totalCost,
      marginRule: resolveMarginFamily("stickers-labels")!, premiumEligible: false,
      finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal,
    });
    expect(commercial.candidates.ownerMarketLadderPrice).toBeCloseTo(3.2 * 62.5 + 9.333333333333334, 6);
    expect(commercial.finalTotalPrice).toBeCloseTo(209.3333, 3); // inside the documented $200-300 range
    expect(commercial.controllingRule).toContain("Sticker market floor");
    expect(commercial.achievedMarginPct).toBeCloseTo((1 - run.totalCost / 209.3333333) * 100, 3); // ~66.4%
  });

  it("fixture 3/4: 1,000 x 4x5 sticker bags — label cutting + machine now included; blanks still not waste-adjusted (documented)", () => {
    const blank = { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" as const };
    const one = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1000, facesPerUnit: 1, widthIn: 4, heightIn: 5, blank }));
    const sqftOne = (4 * 5 * 1000) / 144;
    const wasteOne = sqftOne / 0.9;
    const expectedOne = 90 // blank 0.09 x 1000 — no waste on blanks (owner decision pending)
      + POSEIDON_PER_SQFT * wasteOne
      + INK_RATES.mimakiCmykPerMl * 0.6 * wasteOne
      + (wasteOne / PRINTER_SQFT_PER_HOUR) * MACHINE_RATE
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(sqftOne / 20.25) // 7 pages label cutting
      + OWNER_STANDARDS.bagApplicationPerLabel4x5.value * 1000
      + 9.333333333333334 + 2;
    expect(one.totalCost).toBeCloseTo(expectedOne, 5);
    expect(one.totalCost).toBeCloseTo(298.3919, 3);
    const two = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1000, facesPerUnit: 2, widthIn: 4, heightIn: 5, blank }));
    expect(two.derived.totalPieces).toBe(2000);
    expect(two.totalCost).toBeCloseTo(495.4505, 3);
  });

  it("fixture 5: 585 Chiron jars x 3 same-size 2x2 labels — machine/cutting/packing all real now", () => {
    const rows = [
      { type: "side", typeLabel: "Side label", widthIn: 2, heightIn: 2 },
      { type: "lid", typeLabel: "Lid label", widthIn: 2, heightIn: 2 },
      { type: "additional", typeLabel: "Additional label", widthIn: 2, heightIn: 2 },
    ];
    const run = computeProductDrivenCost(baseInput({
      family: "chiron-jars", quantity: 585, labelRows: rows,
      blank: { name: "Chiron 100 ml", unitCost: 1.8, tiers: [], status: "verified" },
    }));
    const baseSqft = 3 * ((2 * 2 * 585) / 144); // 48.75
    const wasteSqft = baseSqft / 0.9;
    const expected = 1.8 * 585 + 0.2 * 1755
      + POSEIDON_PER_SQFT * wasteSqft
      + INK_RATES.mimakiCmykPerMl * 0.6 * wasteSqft
      + (wasteSqft / PRINTER_SQFT_PER_HOUR) * MACHINE_RATE
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(baseSqft / 20.25) // 3 pages
      + 2 * Math.ceil(585 / 100) // jar family default 100/box
      + 9.333333333333334;
    expect(run.totalCost).toBeCloseTo(expected, 5);
    expect(run.totalCost).toBeCloseTo(1470.6248, 3);
  });

  it("fixture 6: 2,500 Spektra DTP 4x5x2 — UNCHANGED (owner ladder preserved exactly)", () => {
    const landed = 0.4922 * 2500 + 25 / 3 + 85;
    expect(landed).toBeCloseTo(1323.83, 2);
    const quote = priceDtpQuote({
      ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: landed, missingCost: false,
      designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false,
      freightAmount: 85, override: { phrase: "", reason: "" },
    });
    expect(quote.unitPrice).toBe(0.88);
    expect(quote.customerTotal).toBeCloseTo(2200, 6);
    expect(quote.grossMarginPct).toBeCloseTo(((2200 - landed) / 2200) * 100, 4);
    // 15F.0-FINAL: meets the 35% floor + $500 target -> READY with an
    // informational note; floors/profit rules/overrides unchanged.
    expect(quote.status).toBe("READY");
    expect(quote.statusReasons.join(" ")).toContain("meets the 35% DTP floor");
  });

  it("fixture 7: one 3x6 ft banner — tube packing + deterministic hems/grommets quote automatically (15F.0-FINAL)", () => {
    const wasteSqft = 18 / 0.9;
    const baseCost = BANNER_PER_SQFT * wasteSqft
      + INK_RATES.mimakiCmykPerMl * 0.6 * wasteSqft
      + (wasteSqft / PRINTER_SQFT_PER_HOUR) * MACHINE_RATE
      + CUT_SQUARE_RECT_STANDARD.costPerPage * 1 // trim page
      + 4 // one shipping TUBE (never a sticker box)
      + 9.333333333333334;
    const plain = computeProductDrivenCost(baseInput({ family: "banners", quantity: 1, widthIn: 36, heightIn: 72, material: { name: "Banner Vinyl", costPerSqft: BANNER_PER_SQFT } }));
    expect(plain.totalCost).toBeCloseTo(baseCost, 5);
    expect(plain.totalCost).toBeCloseTo(28.9679, 3);
    expect(plain.lines.find((line) => line.key === "packing")!.label).toContain("tube");
    expect(plain.missing).toHaveLength(0);
    expect(marginMath(plain.totalCost, 60).price).toBeCloseTo(72.4198, 3); // trimmed banner, $60-90 market range
    // hems: perimeter 18 ft x $0.60 + $5 finishing setup — READY, no blocker
    const hemmed = computeProductDrivenCost(baseInput({ family: "banners", quantity: 1, widthIn: 36, heightIn: 72, hemming: true, material: { name: "Banner Vinyl", costPerSqft: BANNER_PER_SQFT } }));
    expect(hemmed.missing).toHaveLength(0);
    expect(hemmed.lines.find((line) => line.key === "finishing_hems")!.amount).toBeCloseTo(18 * 0.6, 6);
    expect(hemmed.lines.find((line) => line.key === "finishing_setup")!.amount).toBe(5);
    expect(hemmed.totalCost).toBeCloseTo(baseCost + 5 + 10.8, 5); // 44.7679
  });
});
