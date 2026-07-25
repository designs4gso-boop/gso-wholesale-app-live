// 15F.0 FORENSIC FIXTURES — read-only audit pins. Every expected value is an
// INDEPENDENT arithmetic reconstruction from verified production DB records
// (IDs in comments, values read 2026-07-25) and owner standards — never copied
// from engine output. Where the pinned value documents a DEFECT (margin
// interpolation, $0 machine time), the assertion pins CURRENT behavior and the
// comment marks the finding ID from docs/GSO_ERP_CALCULATOR_FORENSIC_AUDIT.md
// so the fix patch must consciously update it.

import { describe, expect, it } from "vitest";

import {
  computeProductDrivenCost,
  dtpMarginPctForQuantity,
  WEEDING_PAGE_SQFT,
  unitsPerBoxFor,
  type ProductDrivenInput,
} from "../app/lib/product-driven-costing.server";
import {
  curveForTierCount,
  INK_RATES,
  marginMath,
  resolveMarginFamily,
  OWNER_LABOR,
} from "../app/lib/calculator-emergency.server";
import { applyWasteDivisor } from "../app/lib/recipe-pricing.server";
import { blankItemUnitCostAtQty, resolvePrintMaterialCostPerSqft } from "../app/lib/cost-calculator.server";
import { priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";

// ---- Production DB truth (read-only sample 2026-07-25) ----
// Material cmoxmgvx80000jj28acnr8ycp "Poseidon Matte Roll Media":
//   purchaseCost $213/roll, 54in x 150ft -> 675 sqft -> $0.315555.../sqft
const POSEIDON_PER_SQFT = 213 / ((54 / 12) * 150);
// Material cmrpkqxgp0006ef1sn52kwq5b "Banner Vinyl": $140 / (4.5ft x 105ft)
const BANNER_PER_SQFT = 140 / ((54 / 12) * 105);
// Machine cmozcqiib000hfj28hcsc2wez "Mimaki UCJV300-130": $5/hr, 150 sqft/hr —
// EXISTS in the DB but the product flow passes machineMinutesPerSqft = 0.
const MIMAKI_DB_RATE_PER_HOUR = 5;
const MIMAKI_DB_SQFT_PER_HOUR = 150;
// VendorProduct cmrpjvdc50000av2atvnbt09e "4x5 Blank Bag" $0.09 flat;
// cmrzkm4om0000w6ysvtyrt97k "Chiron 100 ml" $1.80 flat;
// cmrzqo6gv0002w61849d331gw "Spektra DTP 4x5x2" tier 2500-4999 = $0.4922.
const CALC_INK_ML_PER_SQFT = 0.6; // route hard-codes 0.6 (= DB mlPerSqft1Pct 0.0075 x 80% coverage)

function baseInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
  return {
    family: "stickers-labels", quantity: 100, designs: 1, facesPerUnit: 1,
    widthIn: 3, heightIn: 3, labelRows: null, dtp: null, blank: null, lid: null,
    mironTop: null, material: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
    printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: CALC_INK_ML_PER_SQFT,
    machineMinutesPerSqft: 0, machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutRequiresWeeding: false, hemming: false, grommets: false,
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
    // sqin-based materials convert with x144 (never /144)
    expect(resolvePrintMaterialCostPerSqft({ calculatedUnitCost: 0.002, baseUnit: "sqin" }).unitCost).toBeCloseTo(0.288, 10);
  });

  it("waste is a divisor (required input = base / (1 - waste%)), never a multiplier", () => {
    expect(applyWasteDivisor(100, 10)).toBeCloseTo(111.1111111111, 6);
    const run = computeProductDrivenCost(baseInput({}));
    expect(run.derived.wastePct).toBe(10); // provisional — recipeWastePct is never wired in the product flow
    expect(run.derived.wasteAdjustedSqft).toBeCloseTo(6.25 / 0.9, 10);
  });

  it("weeding page constant is a true 54x54in page (20.25 sqft) and pages round up", () => {
    expect(WEEDING_PAGE_SQFT).toBeCloseTo((54 * 54) / 144, 12);
    const run = computeProductDrivenCost(baseInput({ cutRequiresWeeding: true }));
    expect(run.derived.weedingPages).toBe(Math.ceil(6.25 / 20.25)); // 1
  });

  it("packout boxes round up and only match configured rules", () => {
    expect(unitsPerBoxFor("4x5 Blank Bag").unitsPerBox).toBe(1000);
    expect(unitsPerBoxFor("Chiron 100 ml").unitsPerBox).toBeNull(); // no rule -> $0 Estimated packing (finding P1-4)
    const run = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1001, blank: { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" } }));
    expect(run.derived.boxes).toBe(2); // ceil(1001/1000)
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

  it("totals multiply the UNROUNDED unit price (no per-unit cents rounding before x qty)", () => {
    const { price } = marginMath(0.122580246913, 60);
    expect(price * 100).toBeCloseTo(30.645, 3); // saved totalPrice basis; $0.31 is display-only
  });

  it("FINDING P0-1 (pinned current behavior): non-DTP margin maps by ROW COUNT, so adding the requested quantity re-interpolates the researched curve", () => {
    const stickers = resolveMarginFamily("stickers-labels")!;
    expect(stickers.curve).toEqual([65, 58, 52, 46, 40]);
    // 5 default quantities alone -> exact curve
    expect(curveForTierCount(stickers.curve, 5, stickers.familyMinPct)).toEqual([65, 58, 52, 46, 40]);
    // requested qty 100 makes SIX rows -> linear 65..40: qty 100 gets 60 (not 65)
    // and the neighbouring researched tiers shift (128: 58 -> 55, 256: 52 -> 50).
    expect(curveForTierCount(stickers.curve, 6, stickers.familyMinPct)).toEqual([65, 60, 55, 50, 45, 40]);
    // DTP already uses quantity thresholds (15C.1) — the model the fix should generalize
    expect(dtpMarginPctForQuantity(5000)).toBe(52);
  });
});

describe("15F.0-A fixture 1: 100 x 3x3 matte kiss-cut stickers (live quote reconstruction)", () => {
  const run = computeProductDrivenCost(baseInput({}));
  const material = POSEIDON_PER_SQFT * (6.25 / 0.9); // 2.191358...
  const ink = INK_RATES.mimakiCmykPerMl * CALC_INK_ML_PER_SQFT * (6.25 / 0.9); // 0.733333...
  const art = OWNER_LABOR.artSetupPerDesign; // 8.3333...
  const printSetup = OWNER_LABOR.printSetupPerDesign; // 1.00

  it("reproduces the observed live breakdown exactly (material 2.19 / ink 0.73 / setup 9.33 / total 12.26)", () => {
    expect(run.lines.find((line) => line.key === "material")!.amount).toBeCloseTo(material, 6);
    expect(material).toBeCloseTo(2.1914, 4);
    expect(run.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(ink, 6);
    expect(ink).toBeCloseTo(0.7333, 4);
    expect(run.totalCost).toBeCloseTo(material + ink + art + printSetup, 6);
    expect(run.totalCost).toBeCloseTo(12.258, 3); // observed "$12.26"
  });

  it("FINDING P1 (pinned): machine, cutting, packing, and freight all contribute $0 to this READY quote", () => {
    expect(run.lines.find((line) => line.key === "machine")!.amount).toBe(0); // DB has $5/hr @ 150 sqft/hr — unwired
    expect(run.lines.some((line) => line.key === "cutting")).toBe(false); // no cut-time line exists for stickers
    expect(run.lines.find((line) => line.key === "packing")!.amount).toBe(0);
    expect(run.lines.find((line) => line.key === "freight")!.amount).toBe(0);
    expect(run.missing).toHaveLength(0); // nothing blocks — quote reads "Ready"
    // what the DB-backed machine model WOULD have added (documented, not charged):
    const machineIfWired = ((6.25 / 0.9) / MIMAKI_DB_SQFT_PER_HOUR) * MIMAKI_DB_RATE_PER_HOUR;
    expect(machineIfWired).toBeCloseTo(0.2315, 4);
  });

  it("observed $30.65 price = interpolated 60% margin on $12.258 (researched curve point would be 65% -> $35.02)", () => {
    const at60 = marginMath(run.totalCost / 100, 60);
    expect(at60.price * 100).toBeCloseTo(30.645, 3);
    const at65 = marginMath(run.totalCost / 100, 65);
    expect(at65.price * 100).toBeCloseTo(35.023, 3);
  });
});

describe("15F.0-M remaining forensic fixtures", () => {
  it("fixture 2: 1,000 x 3x3 stickers — $38.58 cost prices at $64.30 (40% tier), documenting the volume collapse", () => {
    const run = computeProductDrivenCost(baseInput({ quantity: 1000 }));
    const material = POSEIDON_PER_SQFT * (62.5 / 0.9);
    const ink = INK_RATES.mimakiCmykPerMl * 0.6 * (62.5 / 0.9);
    expect(run.totalCost).toBeCloseTo(material + ink + 8.333333333333334 + 1, 6);
    expect(run.totalCost).toBeCloseTo(38.58, 2);
    const price = marginMath(run.totalCost / 1000, 40).price * 1000; // 1000 hits the last researched tier -> 40%
    expect(price).toBeCloseTo(64.3, 1); // $0.064/sticker — commercial reference ~$0.20-0.30
  });

  it("fixture 3/4: 1,000 x 4x5 sticker bags, one- vs two-sided — application labor doubles, blanks never waste-adjusted", () => {
    const blank = { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" as const };
    const one = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1000, facesPerUnit: 1, widthIn: 4, heightIn: 5, blank }));
    const two = computeProductDrivenCost(baseInput({ family: "bags-4x5", quantity: 1000, facesPerUnit: 2, widthIn: 4, heightIn: 5, blank }));
    // one-sided reconstruction
    const sqftOne = (4 * 5 * 1000) / 144; // 138.888...
    const materialOne = POSEIDON_PER_SQFT * (sqftOne / 0.9);
    const inkOne = INK_RATES.mimakiCmykPerMl * 0.6 * (sqftOne / 0.9);
    const application = OWNER_STANDARDS.bagApplicationPerLabel4x5.value * 1000; // 78.125
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.value).toBeCloseTo(20 / 256, 12);
    expect(one.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(90, 6); // 0.09 x 1000 — NO waste on blanks in this flow (finding P2-3)
    expect(one.lines.find((line) => line.key === "packing")!.amount).toBe(2); // 1 box @ $2
    expect(one.totalCost).toBeCloseTo(90 + materialOne + inkOne + application + 8.333333333333334 + 1 + 2, 5);
    // two-sided: material/ink/application double, blank+packing+setup do not
    expect(two.derived.totalPieces).toBe(2000);
    expect(two.lines.find((line) => line.key === "application")!.amount).toBeCloseTo(2 * application, 6);
    expect(two.totalCost - one.totalCost).toBeCloseTo(materialOne + inkOne + application, 5);
  });

  it("fixture 5: 585 Chiron jars x 3 same-size 2x2 labels — jar application per LABEL, cap counted once, no packing rule", () => {
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
    expect(run.derived.baseSqft).toBeCloseTo(baseSqft, 10);
    expect(run.derived.totalPieces).toBe(1755);
    expect(run.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(1.8 * 585, 6); // flat, cap included
    expect(run.lines.find((line) => line.key === "application")!.amount).toBeCloseTo(0.2 * 1755, 6); // $0.20 x labels
    const material = POSEIDON_PER_SQFT * (baseSqft / 0.9);
    const ink = INK_RATES.mimakiCmykPerMl * 0.6 * (baseSqft / 0.9);
    expect(run.totalCost).toBeCloseTo(1053 + 351 + material + ink + 8.333333333333334 + 1, 5);
    expect(run.lines.find((line) => line.key === "packing")!.amount).toBe(0); // no Chiron packout rule (finding P1-4)
  });

  it("fixture 6: 2,500 Spektra DTP 4x5x2 — landed 1,323.83, ladder $0.88 -> margin 39.83% WARNING (floor 35% met)", () => {
    const landed = 0.4922 * 2500 + 25 / 3 + 85; // vendor tier + 1 design art + flat freight
    expect(landed).toBeCloseTo(1323.83, 2);
    const quote = priceDtpQuote({
      ladderSku: "spektra-dtp-4x5x2", quantity: 2500, landedCost: landed, missingCost: false,
      designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false,
      freightAmount: 85, override: { phrase: "", reason: "" },
    });
    expect(quote.unitPrice).toBe(0.88);
    expect(quote.customerTotal).toBeCloseTo(2200, 6);
    expect(quote.grossProfit).toBeCloseTo(2200 - landed, 4);
    expect(quote.grossMarginPct).toBeCloseTo(((2200 - landed) / 2200) * 100, 4); // 39.826%
    expect(quote.status).toBe("WARNING — OWNER REVIEW");
  });

  it("fixture 7: one 3x6 ft banner with hems — Draft Only (finishing standard missing), cost $17.37 before finishing", () => {
    const run = computeProductDrivenCost(baseInput({
      family: "banners", quantity: 1, widthIn: 36, heightIn: 72, hemming: true,
      material: { name: "Banner Vinyl", costPerSqft: BANNER_PER_SQFT },
    }));
    const baseSqft = (36 * 72) / 144; // 18
    const material = BANNER_PER_SQFT * (baseSqft / 0.9);
    const ink = INK_RATES.mimakiCmykPerMl * 0.6 * (baseSqft / 0.9);
    expect(run.totalCost).toBeCloseTo(material + ink + 8.333333333333334 + 1, 5);
    expect(run.totalCost).toBeCloseTo(17.37, 2);
    expect(run.missing.join(" ")).toContain("hemming/grommets"); // blocks Ready status correctly
  });
});
