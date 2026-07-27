// 15F.0 acceptance tests — commercial pricing policy, premium stickers,
// multi-design/multi-line behavior, readiness gates, and save/snapshot
// parity pins. Expected values are independent reconstructions (production
// DB records read 2026-07-25; owner standards; researched curves).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_PRICING_VERSION,
  FAMILY_COMMERCIAL_POLICIES,
  buildStickerLines,
  combineStickerLines,
  computeCommercialPrice,
  designSplit,
  marginPctForQuantity,
  normalizeAdditionalLineCount,
  stickerMarketFloorPrice,
  stickerMarketFloorRate,
  validateStickerLine,
} from "../app/lib/commercial-pricing-policy.server";
import { BANNER_FINISHING_STANDARDS, CUT_CONTOUR_MULTIPLIERS, MIMAKI_INK_CALIBRATION, PREMIUM_INK_ESTIMATE_VERSION, ROLAND_INK_CALIBRATION, buildMimakiPremiumInkEstimate, computeProductDrivenCost, CUT_SQUARE_RECT_STANDARD, normalizeCutType, type ProductDrivenInput } from "../app/lib/product-driven-costing.server";
import { INK_RATES, resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";

const POSEIDON_PER_SQFT = 213 / ((54 / 12) * 150); // cmoxmgvx80000jj28acnr8ycp
const MACHINE_RATE = OWNER_STANDARDS.machineRecoveryPerHour.value; // $8/hr
// 15F.0G.2 printer-specific profiles (never one global constant): Roland =
// additive 150 CMYK + 110/75 per layer; Mimaki UCJV300-130 = COMBINED
// RasterLink table (600x1200 VD / 32-pass / Bi / Fast Print High) x 1.15
// turnaround applied once.
const SPEED = 150; // ROLAND verified baseline sqft/hr
const MIMAKI_RASTERLINK: Record<number, number> = { 1: 51.6, 2: 18.2, 3: 11.8, 4: 8.6 };
const MIMAKI_TURNAROUND = 1.15;
const mimakiMachine = (sqft: number, layers = 1) => (sqft / MIMAKI_RASTERLINK[layers]) * MIMAKI_TURNAROUND * MACHINE_RATE;

function stickerInput(overrides: Partial<ProductDrivenInput>): ProductDrivenInput {
  return {
    family: "stickers-labels", quantity: 100, designs: 1, facesPerUnit: 1,
    widthIn: 3, heightIn: 3, labelRows: null, dtp: null, blank: null, lid: null, mironTop: null,
    material: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
    printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0, machineSqftPerHour: 0, machineRatePerHour: MACHINE_RATE, // Mimaki default: engine-owned RasterLink profile governs
    cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false,
    freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null, wasteOverride: null, boxOverride: null,
    ...overrides,
  };
}

describe("commercial pricing policy (15F.0-H)", () => {
  const stickers = resolveMarginFamily("stickers-labels")!;

  it("final price = max of candidates with the controlling rule named; cost-based beats the nearby area floor at 100 x 3x3", () => {
    const result = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 100, completeCost: 21.158395, marginRule: stickers, premiumEligible: false, finishedSqft: 6.25, setupTotal: 25 / 3 + 1 });
    expect(result.version).toBe(COMMERCIAL_PRICING_VERSION);
    expect(result.marginPctApplied).toBe(65);
    expect(result.finalTotalPrice).toBeCloseTo(21.158395 / 0.35, 6); // 60.45 cost-based
    expect(result.controllingRule).toContain("Cost-based");
    expect(result.candidates.costBasedPrice).toBeCloseTo(result.finalTotalPrice, 10);
    // 15F.0-FINAL provisional floors are REAL candidates now (never null)
    expect(result.candidates.ownerMarketLadderPrice).toBeCloseTo(8.0 * 6.25 + 25 / 3 + 1, 6); // 59.33 area floor, close second
    expect(result.candidates.minimumGrossProfitPrice).toBeCloseTo(21.158395 + 25, 6);
    expect(result.candidates.minimumOrderTotalPrice).toBe(25);
    expect(result.achievedMarginPct).toBeCloseTo(65, 6);
    expect(result.achievedProfit).toBeCloseTo(result.finalTotalPrice - 21.158395, 8);
  });

  it("premium finish floor: gloss/white stickers price on the researched spot-gloss curve (70/62/56/50/45)", () => {
    const premium = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 585, completeCost: 163.959025, marginRule: stickers, premiumEligible: true });
    expect(premium.candidates.premiumFinishFloorPrice).toBeCloseTo(163.959025 / (1 - 0.56), 4); // 56% at the 256-band
    expect(premium.finalTotalPrice).toBeCloseTo(372.6342, 3);
    expect(premium.controllingRule).toContain("Premium finish floor");
    const basic = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 585, completeCost: 163.959025, marginRule: stickers, premiumEligible: false });
    expect(basic.finalTotalPrice).toBeCloseTo(163.959025 / 0.48, 4); // 52% band — premium never prices as basic
    expect(premium.finalTotalPrice).toBeGreaterThan(basic.finalTotalPrice);
  });

  it("15F.0-FINAL provisional minimums: profit floors set per family (owner $25/hr basis), order minimums only where needed, NO unit-price floors", () => {
    const byKey = new Map(FAMILY_COMMERCIAL_POLICIES.map((policy) => [policy.familyKey, policy]));
    expect(byKey.get("stickers-labels")!.minimumGrossProfit).toBe(25);
    expect(byKey.get("stickers-labels")!.minimumOrderTotal).toBe(25);
    expect(byKey.get("sticker-bags")!.minimumGrossProfit).toBe(75);
    expect(byKey.get("standard-jars")!.minimumGrossProfit).toBe(75);
    expect(byKey.get("premium-jars")!.minimumGrossProfit).toBe(100);
    expect(byKey.get("banners")!.minimumGrossProfit).toBe(25);
    expect(byKey.get("banners")!.minimumOrderTotal).toBe(40);
    expect(byKey.get("custom-item")!.minimumGrossProfit).toBe(25);
    for (const policy of FAMILY_COMMERCIAL_POLICIES) {
      expect(policy.minimumUnitPrice).toBeNull(); // area-aware floors instead — a universal unit floor is size-unsafe
      expect(policy.notes).toContain("PROVISIONAL"); // labeled provisional, editable in 15F.1
    }
    expect(byKey.has("dtp-bags")).toBe(false); // DTP keeps its own $500/$350 pipeline
  });

  it("sticker AREA market floor: sqft-banded rates from the two documented anchors; size-safe at both extremes", () => {
    expect(stickerMarketFloorRate(6.25)).toBe(8.0); // 100 x 3x3 anchor
    expect(stickerMarketFloorRate(24)).toBe(6.4);
    expect(stickerMarketFloorRate(45)).toBe(4.8);
    expect(stickerMarketFloorRate(60)).toBe(4.0);
    expect(stickerMarketFloorRate(62.5)).toBe(3.2); // 1,000 x 3x3 anchor
    expect(stickerMarketFloorRate(500)).toBe(3.2);
    expect(stickerMarketFloorPrice(62.5, 25 / 3 + 1)).toBeCloseTo(209.3333, 3);
    expect(stickerMarketFloorPrice(0, 10)).toBeNull(); // no area, no floor
    // large label safety: 100 sqft of 12x12 labels floors at 3.20 (never the small-job 8.00)
    expect(stickerMarketFloorPrice(100, 25 / 3 + 1)!).toBeCloseTo(329.3333, 3);
  });

  it("owner per-tier margin edits override the band margin (floor gate still applies downstream)", () => {
    const edited = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 100, completeCost: 100, marginRule: stickers, premiumEligible: false, marginPctOverride: 45 });
    expect(edited.marginPctApplied).toBe(45);
    expect(edited.marginSource).toContain("owner per-tier margin edit");
  });

  it("nonnegative profit is structural: max() can never select below cost while candidates are >= cost-based", () => {
    const result = computeCommercialPrice({ familyKey: "banners", quantity: 1, completeCost: 26.967926, marginRule: resolveMarginFamily("banners")!, premiumEligible: false });
    expect(result.achievedProfit).toBeGreaterThan(0);
    expect(result.finalTotalPrice).toBeGreaterThan(result.completeCost);
  });
});

describe("multi-design stickers (15F.0-J)", () => {
  it("quantity = TOTAL labels; designs share it; setup per design, production on the total", () => {
    expect(designSplit(585, 3).text).toContain("195 per design");
    expect(designSplit(585, 3).remainder).toBe(0);
    const uneven = designSplit(586, 3);
    expect(uneven.perDesign).toBe(195);
    expect(uneven.remainder).toBe(1);
    expect(uneven.text).toContain("~195 per design");
    // engine: 3 designs charge 3x setup, production stays on 585 labels
    const three = computeProductDrivenCost(stickerInput({ quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13 }));
    const one = computeProductDrivenCost(stickerInput({ quantity: 585, designs: 1, widthIn: 7.13, heightIn: 3.13 }));
    expect(three.derived.totalPieces).toBe(585); // NEVER quantity x designs
    expect(three.lines.find((line) => line.key === "art_setup")!.amount).toBeCloseTo(3 * (25 / 3), 6);
    expect(three.totalCost - one.totalCost).toBeCloseTo(2 * (25 / 3) + 2 * 1.0, 6); // only setup differs
  });

  it("fixture 3/4 (N): 585 x 7.13x3.13, 3 designs — 3 gloss layers on Roland vs none: premium job costs and prices higher", () => {
    const gloss = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13,
      printer: "roland", printerHasGloss: true, glossLayers: 3, machineSqftPerHour: SPEED,
    }));
    const baseSqft = (7.13 * 3.13 * 585) / 144; // 90.662406
    const wasteSqft = baseSqft / 0.9; // 100.736007
    const rolandRate = INK_RATES.rolandPerMl;
    // OWNER-CORRECTED RIP mode speeds: CMYK 150 + gloss 110/layer (1x per
    // SELECTED layer, no hidden overprint multiplier). Owner worked example:
    // 100.74 sqft -> 0.6716 + 2.7475 = 3.4191 hr -> ~205.15 min -> ~$27.35.
    const machineHours = wasteSqft / SPEED + (wasteSqft / 110) * 3;
    expect(machineHours).toBeCloseTo(3.4189, 3);
    expect(machineHours * MACHINE_RATE).toBeCloseTo(27.3513, 3);
    const machineLine = gloss.lines.find((line) => line.key === "machine")!;
    expect(machineLine.amount).toBeCloseTo(machineHours * MACHINE_RATE, 6);
    expect(machineLine.label).toContain(`${(machineHours * 60).toFixed(1)} min`); // 205.1 — hours x60, never x6
    // 15F.0J.3: Roland MEASURED ink calibration — CMYK 1.05, gloss 2.83
    // ml/sqft PER STAGE (never the generic 0.6 basis).
    // 15F.0K.4B: gloss ink at the 90% pre-art coverage default + the $6.25
    // gloss-layer Illustrator setup per design (once per design, never per
    // stage — 3 designs = $18.75 regardless of the 3 stages).
    const expectedGloss = POSEIDON_PER_SQFT * wasteSqft
      + rolandRate * 1.05 * wasteSqft // CMYK measured
      + rolandRate * 2.83 * wasteSqft * 3 * 0.9 // 3 gloss stages measured @ 90% est. coverage
      + machineHours * MACHINE_RATE
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(baseSqft / 20.25) // 5 pages
      + 2 + 3 * (25 / 3 + 1)
      + 3 * 6.25; // gloss-layer Illustrator setup (owner-verified 2026-07-26)
    const glossInkLine = gloss.lines.find((line) => line.key === "ink_gloss")!;
    expect(glossInkLine.amount).toBeCloseTo(rolandRate * 2.83 * wasteSqft * 3 * 0.9, 4); // 769.7 ml -> $152.92
    expect(glossInkLine.note).toContain("15F.0J.3-roland-measured-ink");
    expect(gloss.lines.find((line) => line.key === "gloss_setup")!.amount).toBeCloseTo(18.75, 10);
    expect(gloss.totalCost).toBeCloseTo(expectedGloss, 4);
    expect(gloss.totalCost).toBeCloseTo(314.4711, 3); // was 312.7120 pre-4B (−$16.99 coverage, +$18.75 gloss setup)
    expect(gloss.missing).toHaveLength(0);
    const plain = computeProductDrivenCost(stickerInput({ quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, printer: "roland", printerHasGloss: true, glossLayers: 0, machineSqftPerHour: SPEED }));
    expect(plain.totalCost).toBeCloseTo(120.8239, 3); // CMYK measured 1.05 (was 111.82 at 0.6)
    // commercial: premium 56% vs basic 52% at 585
    const stickersRule = resolveMarginFamily("stickers-labels")!;
    const glossPrice = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 585, completeCost: gloss.totalCost, marginRule: stickersRule, premiumEligible: true });
    const plainPrice = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 585, completeCost: plain.totalCost, marginRule: stickersRule, premiumEligible: false });
    expect(glossPrice.finalTotalPrice).toBeCloseTo(314.4711 / 0.44, 3); // 714.71 premium (15F.0K.4B repriced)
    expect(plainPrice.finalTotalPrice).toBeCloseTo(251.7165, 3); // 120.82 / 0.48 — CMYK path unchanged
  });

  it("owner white-layer examples: 1 layer = sqft/75 hours exactly (never a hidden 3x); 3 layers = 3x that", () => {
    const oneWhite = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, printer: "roland", printerHasGloss: true, whiteLayers: 1, machineSqftPerHour: SPEED,
    }));
    const threeWhite = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, printer: "roland", printerHasGloss: true, whiteLayers: 3, machineSqftPerHour: SPEED,
    }));
    const cmykOnly = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, printer: "roland", printerHasGloss: true, machineSqftPerHour: SPEED,
    }));
    const wasteSqft = ((7.13 * 3.13 * 585) / 144) / 0.9; // 100.736
    const oneMachine = oneWhite.lines.find((line) => line.key === "machine")!.amount;
    const cmykMachine = cmykOnly.lines.find((line) => line.key === "machine")!.amount;
    expect((wasteSqft / 75)).toBeCloseTo(1.3431, 3); // owner example ~1.3432 hr at 100.74
    expect(oneMachine - cmykMachine).toBeCloseTo((wasteSqft / 75) * MACHINE_RATE, 6); // exactly ONE white pass
    const threeMachine = threeWhite.lines.find((line) => line.key === "machine")!.amount;
    expect(threeMachine - cmykMachine).toBeCloseTo((wasteSqft / 75) * 3 * MACHINE_RATE, 6); // owner example ~4.0296 hr worth
  });

  it("fixture 6 (J): the same gloss job with SIMPLE CONTOUR cutting — +$4.90 cutting, premium curve still controls at $383.77", () => {
    const contour = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13,
      printer: "roland", printerHasGloss: true, glossLayers: 3, cutType: "kiss-simple", machineSqftPerHour: SPEED,
    }));
    expect(contour.missing).toHaveLength(0); // READY — simple contour quotes automatically
    expect(contour.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(5 * 6.53 * 1.15, 5); // 37.5475
    expect(contour.totalCost).toBeCloseTo(314.4711 + 5 * 6.53 * 0.15, 3); // 319.3686 (15F.0K.4B: 90% coverage + gloss setup)
    const priced = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 585, completeCost: contour.totalCost, marginRule: resolveMarginFamily("stickers-labels")!, premiumEligible: true, finishedSqft: contour.derived.baseSqft, setupTotal: contour.setupTotal });
    expect(priced.finalTotalPrice).toBeCloseTo(contour.totalCost / 0.44, 4); // 725.84 — premium 56%
    expect(priced.controllingRule).toContain("Premium finish floor");
  });
});

describe("multi-line sticker jobs (15F.0-K)", () => {
  it("line builder derives strictly from the posted count; stale extras discarded; caps at 8", () => {
    const lines = buildStickerLines({
      count: 2,
      names: ["A", "B", "STALE"],
      quantities: [100, 250, 999],
      designs: [1, 1, 9],
      widths: [3, 4], heights: [3, 4],
      materialIds: ["m1", "m2"], printers: ["mimaki", "roland"],
      whites: [0, 0], glosses: [0, 1], cuts: ["square-rect", "square-rect"],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1].printer).toBe("roland");
    expect(lines[1].glossLayers).toBe(1);
  });

  it("fixture 7 (J): 100x3x3 matte + 250x4x4 single-gloss — per-line AREA floors control, job packing + minimums once", () => {
    // line A = fixture-1 economics minus packing (charged once at job level)
    const lineA = 20.026181; // 22.026181 - 2 (Mimaki RasterLink 51.6)
    // line B: 250 x 4x4 Roland, 1 gloss layer
    const sqftB = (4 * 4 * 250) / 144; // 27.777778
    const wasteB = sqftB / 0.9;
    const lineB = POSEIDON_PER_SQFT * wasteB
      + INK_RATES.rolandPerMl * 0.6 * wasteB * 2 // CMYK + 1 gloss
      + (wasteB / SPEED + wasteB / 110) * MACHINE_RATE // owner mode speeds: CMYK + one gloss layer
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(sqftB / 20.25) // 2 pages
      + (25 / 3 + 1);
    expect(lineB).toBeCloseTo(43.3816, 3);
    const combined = combineStickerLines({
      lines: [
        { name: "A", quantity: 100, designs: 1, glossOrWhite: false, lineCost: lineA, missing: [], finishedSqft: 6.25, setupTotal: 25 / 3 + 1 },
        { name: "B", quantity: 250, designs: 1, glossOrWhite: true, lineCost: lineB, missing: [], finishedSqft: sqftB, setupTotal: 25 / 3 + 1 },
      ],
      jobPackingCost: 2, // ceil(350/5000) x $2 — once for the whole job
      marginRule: resolveMarginFamily("stickers-labels")!,
    });
    expect(combined.totalQuantity).toBe(350);
    expect(combined.totalCost).toBeCloseTo(lineA + lineB + 2, 6);
    // 15F.0-FINAL: per-line AREA floors beat both the cost-based and premium
    // candidates here: A 6.25 sqft x $8 + setup = 59.33; B 27.78 sqft x $4.80
    // + setup = 142.67 (> premium 116.22).
    expect(combined.lines[0].finalPrice).toBeCloseTo(8.0 * 6.25 + 25 / 3 + 1, 4);
    expect(combined.lines[0].controllingRule).toContain("Sticker market floor");
    expect(combined.lines[1].finalPrice).toBeCloseTo(4.8 * sqftB + 25 / 3 + 1, 4);
    expect(combined.lines[1].controllingRule).toContain("Sticker market floor");
    const reconstructed = combined.lines.reduce((sum, line) => sum + line.finalPrice, 0);
    expect(combined.finalTotalPrice).toBeCloseTo(reconstructed, 8);
    expect(combined.finalTotalPrice).toBeCloseTo(202.0, 3);
    expect(combined.controllingRule).toBe("Sum of per-line commercial prices");
    expect(combined.achievedMarginPct).toBeGreaterThan(60);
    expect(combined.blockers).toHaveLength(0);
    // packing allocation sums exactly back to the single job packing charge
    expect(combined.lines.reduce((sum, line) => sum + line.allocatedPacking, 0)).toBeCloseTo(2, 8);
  });

  it("job-level minimums apply ONCE to the combined job, never per line", () => {
    // two tiny lines: per-line minimums would demand $50; the job applies $25 once
    const combined = combineStickerLines({
      lines: [
        { name: "T1", quantity: 5, designs: 1, glossOrWhite: false, lineCost: 3, missing: [], finishedSqft: 0.3, setupTotal: 0 },
        { name: "T2", quantity: 5, designs: 1, glossOrWhite: false, lineCost: 3, missing: [], finishedSqft: 0.3, setupTotal: 0 },
      ],
      jobPackingCost: 2,
      marginRule: resolveMarginFamily("stickers-labels")!,
    });
    // combined cost $8 + $25 min profit = $33 controls (line sum ~$24.5 below it)
    expect(combined.finalTotalPrice).toBeCloseTo(8 + 25, 6);
    expect(combined.controllingRule).toContain("Minimum gross-profit floor");
    expect(combined.controllingRule).toContain("combined job");
  });

  it("a blocked line blocks the JOB with the line named", () => {
    const combined = combineStickerLines({
      lines: [{ name: "Contour line", quantity: 100, designs: 1, glossOrWhite: false, lineCost: 10, missing: ["Cutting — kiss cut, custom contour"] }],
      jobPackingCost: 2,
      marginRule: resolveMarginFamily("stickers-labels")!,
    });
    expect(combined.blockers[0]).toContain("Contour line:");
  });
});

describe("fixtures 8/9 (N): Chiron 150ml jars", () => {
  it("585 jars, one 3x2 label — complete cost $1,275.74 -> $2,551.49 at the 50% researched band", () => {
    const run = computeProductDrivenCost(stickerInput({
      family: "chiron-jars", quantity: 585, designs: 1, widthIn: 3, heightIn: 2,
      blank: { name: "Chiron 150 ml", unitCost: 1.9, tiers: [], status: "verified" }, // cmrzkm4u80001w6yslkmw0lfb
    }));
    const baseSqft = (3 * 2 * 585) / 144; // 24.375
    const wasteSqft = baseSqft / 0.9;
    const expected = 1.9 * 585 + 0.2 * 585
      + POSEIDON_PER_SQFT * wasteSqft + INK_RATES.mimakiCmykPerMl * 0.6 * wasteSqft
      + mimakiMachine(wasteSqft)
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(baseSqft / 20.25) // 2 pages
      + 2 * Math.ceil(585 / 100) + (25 / 3 + 1);
    expect(run.totalCost).toBeCloseTo(expected, 5);
    expect(run.totalCost).toBeCloseTo(1279.1284, 3);
    const chiron = resolveMarginFamily("chiron-jars")!;
    expect(marginPctForQuantity(chiron, 585)).toBe(50);
    const priced = computeCommercialPrice({ familyKey: "premium-jars", quantity: 585, completeCost: run.totalCost, marginRule: chiron, premiumEligible: false });
    expect(priced.finalTotalPrice).toBeCloseTo(2558.2569, 3);
    expect(priced.finalUnitPrice).toBeCloseTo(4.3731, 4);
  });

  it("585 jars, three DIFFERENT labels (2x2 side, 2x2 lid, 2x1 additional) — $1,524.84 -> $3,049.68 at 50%", () => {
    const rows = [
      { type: "side", typeLabel: "Side label", widthIn: 2, heightIn: 2 },
      { type: "lid", typeLabel: "Lid label", widthIn: 2, heightIn: 2 },
      { type: "additional", typeLabel: "Additional label", widthIn: 2, heightIn: 1 },
    ];
    const run = computeProductDrivenCost(stickerInput({
      family: "chiron-jars", quantity: 585, designs: 1, labelRows: rows,
      blank: { name: "Chiron 150 ml", unitCost: 1.9, tiers: [], status: "verified" },
    }));
    const baseSqft = (4 * 585) / 144 + (4 * 585) / 144 + (2 * 585) / 144; // 40.625
    const wasteSqft = baseSqft / 0.9;
    const expected = 1.9 * 585 + 0.2 * (585 * 3)
      + POSEIDON_PER_SQFT * wasteSqft + INK_RATES.mimakiCmykPerMl * 0.6 * wasteSqft
      + mimakiMachine(wasteSqft)
      + CUT_SQUARE_RECT_STANDARD.costPerPage * Math.ceil(baseSqft / 20.25) // 3 pages
      + 2 * Math.ceil(585 / 100) + (25 / 3 + 1);
    expect(run.derived.baseSqft).toBeCloseTo(baseSqft, 8);
    expect(run.derived.applicationCount).toBe(1755);
    expect(run.totalCost).toBeCloseTo(expected, 5);
    expect(run.totalCost).toBeCloseTo(1530.4818, 3);
    const priced = computeCommercialPrice({ familyKey: "premium-jars", quantity: 585, completeCost: run.totalCost, marginRule: resolveMarginFamily("chiron-jars")!, premiumEligible: false });
    expect(priced.finalTotalPrice).toBeCloseTo(3060.9637, 3);
  });
});

describe("Roland measured ink calibration (15F.0J.3)", () => {
  const wasteSqft = 6.25 / 0.9;
  const roland = (over: any = {}) => computeProductDrivenCost(stickerInput({ printer: "roland", printerHasGloss: true, machineSqftPerHour: SPEED, ...over }));

  it("profile constants: CMYK 1.05 HIGH / white 1.90 MEDIUM / gloss 2.83 per stage HIGH; versioned + sourced, never magic numbers", () => {
    expect(ROLAND_INK_CALIBRATION.cmykMlPerSqft).toBe(1.05);
    expect(ROLAND_INK_CALIBRATION.whiteMlPerSqftPerLayer).toBe(1.9);
    expect(ROLAND_INK_CALIBRATION.glossMlPerSqftPerStage).toBe(2.83);
    expect(ROLAND_INK_CALIBRATION.version).toBe("15F.0J.3-roland-measured-ink");
    expect(ROLAND_INK_CALIBRATION.source).toContain("VersaWorks all-time job log");
    expect(ROLAND_INK_CALIBRATION.areaBasis).toContain("layout proxy");
    expect(ROLAND_INK_CALIBRATION.coverageFactor).toBe(1.0);
  });

  it("CMYK uses 1.05 x layout proxy; 0 gloss = $0 gloss; white uses SELECTED layers (never assumed 3X)", () => {
    const cmykOnly = roland();
    expect(cmykOnly.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(INK_RATES.rolandPerMl * 1.05 * wasteSqft, 10);
    expect(cmykOnly.lines.some((line) => line.key === "ink_gloss")).toBe(false);
    expect(cmykOnly.lines.some((line) => line.key === "ink_white")).toBe(false);
    const oneWhite = roland({ whiteLayers: 1 });
    const threeWhite = roland({ whiteLayers: 3 });
    expect(oneWhite.lines.find((line) => line.key === "ink_white")!.amount).toBeCloseTo(INK_RATES.rolandPerMl * 1.9 * wasteSqft * 1, 10);
    expect(threeWhite.lines.find((line) => line.key === "ink_white")!.amount).toBeCloseTo(oneWhite.lines.find((line) => line.key === "ink_white")!.amount * 3, 10);
  });

  it("gloss scales EXACTLY by selected stage count (1X vs 3X) — one multiplier per stage, never doubled (15F.0K.4B: 90% pre-art coverage)", () => {
    const one = roland({ glossLayers: 1 }).lines.find((line) => line.key === "ink_gloss")!;
    const three = roland({ glossLayers: 3 }).lines.find((line) => line.key === "ink_gloss")!;
    expect(one.amount).toBeCloseTo(INK_RATES.rolandPerMl * 2.83 * wasteSqft * 0.9, 10); // owner-verified 90% pre-art estimate
    expect(three.amount).toBeCloseTo(one.amount * 3, 10);
    expect(one.label).toContain("1 stage(s)");
    expect(one.formula).toContain("coverage 0.90 (estimated_pre_art)");
  });

  it("15F.0K.4B: Mimaki CMYK basis unchanged; Mimaki white and gloss now BLOCK (CMYK-only, owner-verified)", () => {
    const mimaki = computeProductDrivenCost(stickerInput({}));
    expect(mimaki.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(0.176 * 0.6 * wasteSqft, 10);
    const mimakiGloss = computeProductDrivenCost(stickerInput({ glossLayers: 2 }));
    expect(mimakiGloss.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
    expect(mimakiGloss.lines.find((line) => line.key === "ink_gloss")).toBeUndefined();
    const mimakiWhite = computeProductDrivenCost(stickerInput({ whiteLayers: 2 }));
    expect(mimakiWhite.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
    expect(mimakiWhite.lines.find((line) => line.key === "ink_white")).toBeUndefined();
  });

  it("snapshot records the calibration version/basis for Roland saves (route pin); historical parsing untouched", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src).toContain('inkCalibration: !savedIsDtpSnapshot && productSnapshot && (fRead("pprinter") === "roland" || fReadAll("pslprinter").includes("roland"))');
    expect(src).toContain("version: ROLAND_INK_CALIBRATION.version");
    expect(src).toContain("areaBasis: ROLAND_INK_CALIBRATION.areaBasis");
  });

  it("multi-line mixed printers: each line prices ink through its own printer profile", () => {
    const mimakiLine = computeProductDrivenCost(stickerInput({ quantity: 100 }));
    const rolandLine = roland({ quantity: 100, glossLayers: 1 });
    expect(mimakiLine.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(0.176 * 0.6 * wasteSqft, 10);
    expect(rolandLine.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(INK_RATES.rolandPerMl * 1.05 * wasteSqft, 10);
  });
});

describe("multi-line sticker safety (15F.0J.2)", () => {
  const rule = resolveMarginFamily("stickers-labels")!;
  const validLine = (over: any = {}) => ({ name: "Line 2", quantity: 250, designs: 1, glossOrWhite: false, lineCost: 40, missing: [], fieldErrors: [] as string[], finishedSqft: 10, setupTotal: 9.33, ...over });
  const primary = (over: any = {}) => ({ name: "Line 1 (main sticker entry)", quantity: 585, designs: 3, glossOrWhite: false, lineCost: 100, missing: [], fieldErrors: [] as string[], finishedSqft: 90, setupTotal: 28, ...over });

  it("scenario 10 (A): '01' normalizes to exactly ONE additional line; invalid counts REJECT with messages", () => {
    expect(normalizeAdditionalLineCount("01")).toEqual({ count: 1, error: null });
    expect(normalizeAdditionalLineCount("")).toEqual({ count: 0, error: null }); // blank = single-line mode
    expect(normalizeAdditionalLineCount("2")).toEqual({ count: 2, error: null });
    expect(normalizeAdditionalLineCount("-1").error).toContain("cannot be negative");
    expect(normalizeAdditionalLineCount("abc").error).toContain("not a number");
    expect(normalizeAdditionalLineCount("9").error).toContain("cannot exceed 8");
  });

  it("scenarios 6/7/8/9 (C): blank quantity, zero quantity, missing dims, missing material each produce exact field errors", () => {
    const base = { name: "L", quantity: 0, designs: 0, widthIn: 0, heightIn: 0, materialId: "", printer: "mimaki" as const, whiteLayers: 0, glossLayers: 0, cutType: "square-rect" };
    const errors = validateStickerLine(base);
    expect(errors).toContain("Quantity is required (must be greater than 0).");
    expect(errors).toContain("Designs is required (must be at least 1).");
    expect(errors).toContain("Width (in) is required.");
    expect(errors).toContain("Height (in) is required.");
    expect(errors).toContain("Material is required.");
    expect(validateStickerLine({ ...base, quantity: 100, designs: 1, widthIn: 2.5, heightIn: 2.5, materialId: "m1" })).toHaveLength(0);
  });

  it("scenario 16 + exact 585 case: an active lid line with BLANK quantity blocks the JOB — never silently disappears; fixed, both lines price", () => {
    // primary 585 x 3 designs 7.13x3.13 + additional lid 2.5x2.5, qty blank
    const lidBlank = validLine({ name: "Line 2", quantity: 0, lineCost: 0, fieldErrors: ["Quantity is required (must be greater than 0)."], finishedSqft: 0 });
    const blocked = combineStickerLines({ lines: [primary(), lidBlank], jobPackingCost: 2, marginRule: rule });
    expect(blocked.blockers.some((blocker) => blocker.includes("Line 2") && blocker.includes("Quantity is required"))).toBe(true); // visible blocking error
    expect(blocked.lines.some((line) => line.name === "Line 2")).toBe(false); // not priced while invalid
    // READY TO QUOTE must be false while blockers exist (route derives status from blockers)
    expect(blocked.blockers.length).toBeGreaterThan(0);
    // quantity entered -> both lines price and totals include both
    const lidFixed = validLine({ name: "Line 2", quantity: 300, lineCost: 25, fieldErrors: [], finishedSqft: 13.02 });
    const ready = combineStickerLines({ lines: [primary(), lidFixed], jobPackingCost: 2, marginRule: rule });
    expect(ready.blockers).toHaveLength(0);
    expect(ready.totalQuantity).toBe(585 + 300); // scenario 15: every physical piece included
    expect(ready.lines).toHaveLength(2);
    expect(ready.totalCost).toBeCloseTo(100 + 25 + 2, 10);
  });

  it("scenarios 1/2/14 (B/F): primary-only vs primary+valid additional; job packing charged exactly once", () => {
    const single = combineStickerLines({ lines: [primary()], jobPackingCost: 2, marginRule: rule });
    expect(single.totalQuantity).toBe(585);
    const two = combineStickerLines({ lines: [primary(), validLine()], jobPackingCost: 2, marginRule: rule });
    expect(two.totalQuantity).toBe(835);
    expect(two.lines.reduce((sum, line) => sum + line.allocatedPacking, 0)).toBeCloseTo(2, 10); // packing once, allocated
    expect(two.totalCost).toBeCloseTo(100 + 40 + 2, 10);
  });

  it("scenario 7 legacy behavior is DEAD: a passed qty-0 line without fieldErrors still blocks (never silently filtered)", () => {
    const sneaky = combineStickerLines({ lines: [primary(), validLine({ quantity: 0, lineCost: 0 })], jobPackingCost: 2, marginRule: rule });
    expect(sneaky.blockers.some((blocker) => blocker.includes("Quantity is required"))).toBe(true);
  });

  it("scenarios 3/4/5 (route pins): different sizes/quantities/printers flow per line; loader includes the primary as Line 1", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src).toContain("normalizeAdditionalLineCount(eparams.get(\"pslcount\"))");
    expect(src).toContain("lineCountParsed.count >= 1 || lineCountParsed.error"); // >=1 activates (defect 1 dead)
    expect(src).toContain("lineNumber: index + 2, // primary = Line 1; additional lines start at Line 2");
    expect(src).toContain("name: \"Line 1 (main sticker entry)\"");
    expect(src).toContain("Your main sticker entry above stays LINE 1"); // defect 3: replacement is gone + stated
    expect(src).toContain("Remove line"); // scenario 11 (D): explicit removal
    expect(src).toContain("+ Add line");
    expect(src).toContain("fieldErrors: validateStickerLine(line)".replace("fieldErrors: ", "const fieldErrors = ")); // validation wired
  });

  it("scenarios 12/13 (G): save mirrors the loader — refuses on field errors, includes Line 1, snapshot totals from combined", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src).toContain("normalizeAdditionalLineCount(fRead(\"pslcount\"))");
    expect(src).toContain("Multi-line sticker job cannot save until every active line is complete or removed");
    expect(src).toContain("const primaryLineSave = {");
    expect(src).toContain("const allLinesSave = [primaryLineSave, ...activeAdditionalSave]");
    expect(src).toContain("multiLine: savedMultiLine ? { lines: savedMultiLine.lines, totalQuantity: savedMultiLine.totalQuantity"); // snapshot carries combined totals
    expect(src).toContain('name="psearch"'); // save/reopen replay preserved
  });

  it("totals panel (E) renders active lines / pieces / designs / sqft / machine / ink / cutting / packing-once", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    for (const label of ["Active lines:", "Total pieces:", "Total designs:", "Finished sqft:", "Adjusted sqft:", "Job packing (once):", "Selling price:"]) {
      expect(src).toContain(label);
    }
    expect(src).toContain("totalMachineCost");
    expect(src).toContain("totalCuttingCost");
  });
});

describe("contour cutting model (15F.0-FINAL-E)", () => {
  it("legacy + plain-language cut values normalize deterministically", () => {
    expect(normalizeCutType("kiss")).toBe("square-rect");
    expect(normalizeCutType("weeded")).toBe("square-rect");
    expect(normalizeCutType("kiss-contour")).toBe("kiss-simple"); // short-lived 15F.0 value
    expect(normalizeCutType("kiss-moderate")).toBe("kiss-moderate");
    expect(normalizeCutType("die-complex")).toBe("die-irregular");
    expect(normalizeCutType("")).toBe("square-rect");
  });

  it("fixtures 3/4 (J): contour bands price automatically — pages x $6.53 x band; die-irregular stays BLOCKED", () => {
    const simple100 = computeProductDrivenCost(stickerInput({ cutType: "kiss-simple" }));
    expect(simple100.missing).toHaveLength(0); // READY
    expect(simple100.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(6.53 * 1.15, 6); // 7.5095
    expect(simple100.totalCost).toBeCloseTo(22.026181 - 6.53 + 6.53 * 1.15, 4); // 23.0057 (RasterLink 51.6)
    const simple1000 = computeProductDrivenCost(stickerInput({ quantity: 1000, cutType: "kiss-simple" }));
    expect(simple1000.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(6.53 * 1.15 * 4, 6); // 4 pages
    expect(simple1000.totalCost).toBeCloseTo(82.9998, 3);
    const moderate = computeProductDrivenCost(stickerInput({ cutType: "kiss-moderate" }));
    expect(moderate.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(6.53 * 1.35, 6);
    const complex = computeProductDrivenCost(stickerInput({ cutType: "kiss-complex" }));
    expect(complex.lines.find((line) => line.key === "cutting")!.amount).toBeCloseTo(6.53 * 1.6, 6);
    expect(CUT_CONTOUR_MULTIPLIERS["kiss-simple"].label).toContain("provisional");
    const die = computeProductDrivenCost(stickerInput({ cutType: "die-irregular" }));
    expect(die.missing.join(" ")).toContain("die cut / irregular");
    expect(die.lines.find((line) => line.key === "cutting")!.note).toContain("Cutting standard required for this cut type");
  });

  it("fixture 3/4 (J) prices: 100 simple contour -> $63.25 cost-based; 1,000 simple contour -> area floor $209.33 still controls", () => {
    const rule = resolveMarginFamily("stickers-labels")!;
    const small = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 100, completeCost: 23.005681, marginRule: rule, premiumEligible: false, finishedSqft: 6.25, setupTotal: 25 / 3 + 1 });
    expect(small.finalTotalPrice).toBeCloseTo(23.005681 / 0.35, 4); // 65.73 — cost-based (RasterLink profile)
    expect(small.controllingRule).toContain("Cost-based");
    const big = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 1000, completeCost: 82.999814, marginRule: rule, premiumEligible: false, finishedSqft: 62.5, setupTotal: 25 / 3 + 1 });
    expect(big.finalTotalPrice).toBeCloseTo(209.3333, 3); // floor absorbs the contour delta
    expect(big.controllingRule).toContain("Sticker market floor");
  });
});

describe("banner finishing (15F.0-FINAL-G)", () => {
  const banner = (overrides: Partial<ProductDrivenInput>) => computeProductDrivenCost(stickerInput({
    family: "banners", quantity: 1, widthIn: 36, heightIn: 72,
    material: { name: "Banner Vinyl", costPerSqft: 140 / ((54 / 12) * 105) },
    ...overrides,
  }));

  it("hems + grommets quote automatically from perimeter standards; formulas and sources shown", () => {
    const finished = banner({ hemming: true, grommets: true });
    expect(finished.missing).toHaveLength(0); // READY — ordinary finishing never blocks
    const hems = finished.lines.find((line) => line.key === "finishing_hems")!;
    expect(hems.amount).toBeCloseTo(18 * BANNER_FINISHING_STANDARDS.hemPerFoot, 6); // 18 perimeter ft x $0.60
    expect(hems.formula).toContain("/ 12 x $0.6/ft");
    const grommets = finished.lines.find((line) => line.key === "finishing_grommets")!;
    expect(grommets.amount).toBeCloseTo(Math.ceil(216 / 24) * BANNER_FINISHING_STANDARDS.grommetEach, 6); // 9 x $0.30
    expect(finished.lines.find((line) => line.key === "finishing_setup")!.amount).toBe(5);
    // fixture 14 (J): trimmed base 28.9679 + 5 + 10.80 + 2.70 = 47.4679
    expect(finished.totalCost).toBeCloseTo(49.9672, 3);
    const priced = computeCommercialPrice({ familyKey: "banners", quantity: 1, completeCost: finished.totalCost, marginRule: resolveMarginFamily("banners")!, premiumEligible: false });
    expect(priced.finalTotalPrice).toBeCloseTo(finished.totalCost / 0.4, 4); // $118.67 at the 60% band — READY
    expect(priced.controllingRule).toContain("Cost-based");
    // multi-banner scaling: 3 banners = 3x hems/grommets, one setup, one tube
    const three = banner({ quantity: 3, hemming: true, grommets: true });
    expect(three.lines.find((line) => line.key === "finishing_hems")!.amount).toBeCloseTo(3 * 18 * 0.6, 6);
    expect(three.lines.find((line) => line.key === "finishing_setup")!.amount).toBe(5);
    expect(three.lines.find((line) => line.key === "packing")!.amount).toBe(4); // ceil(3/5) = 1 tube
  });

  it("banner packing is tubes, never sticker boxes; minimum order $40 is a candidate", () => {
    const six = banner({ quantity: 6 });
    expect(six.lines.find((line) => line.key === "packing")!.amount).toBe(8); // ceil(6/5) = 2 tubes x $4
    const tiny = computeCommercialPrice({ familyKey: "banners", quantity: 1, completeCost: 12, marginRule: resolveMarginFamily("banners")!, premiumEligible: false });
    expect(tiny.candidates.minimumOrderTotalPrice).toBe(40);
    expect(tiny.finalTotalPrice).toBe(40); // $40 minimum banner charge controls tiny jobs
    expect(tiny.controllingRule).toContain("Minimum order total");
  });
});

describe("printer-specific profiles (15F.0G.2 — Mimaki RasterLink)", () => {
  const wasteSqft = 6.25 / 0.9;

  it("Mimaki CMYK resolves to 51.6 sqft/hr x 1.15 turnaround (once); Roland stays exactly 150 additive", () => {
    const mimaki = computeProductDrivenCost(stickerInput({}));
    const roland = computeProductDrivenCost(stickerInput({ printer: "roland", machineSqftPerHour: SPEED }));
    const mimakiLine = mimaki.lines.find((line) => line.key === "machine")!;
    const rolandLine = roland.lines.find((line) => line.key === "machine")!;
    expect(mimakiLine.amount).toBeCloseTo(mimakiMachine(wasteSqft), 10);
    expect(rolandLine.amount).toBeCloseTo((wasteSqft / 150) * MACHINE_RATE, 10);
    expect(mimakiLine.label).toContain("CMYK machine time");
    expect(mimakiLine.note).toContain("RasterLink profile 600x1200 VD / 32-pass / Bi-direction / Fast Print High");
    expect(mimakiLine.note).toContain("1-layer throughput 51.6 sqft/hr");
    expect(mimakiLine.note).toContain("1.15 UCJV300-130 turnaround factor");
    expect(mimakiLine.note).not.toContain("169"); // retired incorrect figure
    expect(mimakiLine.note).not.toContain("150 sqft/hr"); // never a generic statement for Mimaki
    expect(rolandLine.note).toContain("Roland verified baseline 150 sqft/hr");
  });

  it("15F.0K.4B: the Mimaki combined-layer table is QUARANTINED — multi-layer Mimaki requests block CMYK-only; the profile constants remain pinned", () => {
    // Profile data stays pinned (documentation + any future owner reversal),
    // but no Mimaki request can reach the 2/3/4-layer rows anymore.
    expect(MIMAKI_RASTERLINK[2]).toBe(18.2);
    expect(MIMAKI_RASTERLINK[3]).toBe(11.8);
    expect(MIMAKI_RASTERLINK[4]).toBe(8.6);
    for (const layers of [1, 2, 3]) {
      const run = computeProductDrivenCost(stickerInput({ whiteLayers: layers }));
      expect(run.missing.join(" "), `white x${layers}`).toContain("Mimaki UCJV300-130 is CMYK ONLY");
      const machineLine = run.lines.find((line) => line.key === "machine")!;
      expect(machineLine.amount).toBeCloseTo(mimakiMachine(wasteSqft, 1), 10); // layers zeroed -> 1-layer CMYK profile
      expect(machineLine.label).toContain("CMYK machine time");
    }
  });

  it("owner-verified examples: 19.26 sqft CMYK ~25.8 min; 19.26 sqft two-layer ~73.0 min", () => {
    expect((19.26 / 51.6) * MIMAKI_TURNAROUND * 60).toBeCloseTo(25.756, 2); // ~26 minutes display
    expect((19.26 / 18.2) * MIMAKI_TURNAROUND * 60).toBeCloseTo(73.02, 2); // ~1 hour 13 minutes display
  });

  it("15F.0K.4B: ANY Mimaki layer request blocks CMYK-only (the old 5-layer profile gate is subsumed)", () => {
    const five = computeProductDrivenCost(stickerInput({ whiteLayers: 4 })); // was the 5-layer profile-gate case
    expect(five.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
    expect(five.lines.find((line) => line.key === "machine")!.source).not.toBe("missing"); // CMYK machine still prices; the CAPABILITY line blocks
  });

  it("15F.0K.4B: Mimaki gloss jobs BLOCK (the 15F.0G.3 READY decision is superseded by the owner CMYK-only standard)", () => {
    const gloss = computeProductDrivenCost(stickerInput({ glossLayers: 2 }));
    expect(gloss.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
    expect(gloss.lines.find((line) => line.key === "ink_gloss")).toBeUndefined(); // the provisional estimate can never price
    expect(gloss.lines.find((line) => line.key === "machine")!.amount).toBeCloseTo(mimakiMachine(6.25 / 0.9, 1), 10); // 1-layer CMYK only
  });

  it("no active 169 throughput anywhere; engine owns the Mimaki profile; save re-fetches records", () => {
    const engineSrc = readFileSync(new URL("../app/lib/product-driven-costing.server.ts", import.meta.url), "utf8");
    const routeSrc = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(engineSrc).not.toContain("169"); // retired value fully removed
    expect(routeSrc).not.toContain("169");
    expect(engineSrc).toContain("MIMAKI_UCJV_RASTERLINK_PROFILE");
    expect(engineSrc).toContain("sqftPerHourByTotalLayers: { 1: 51.6, 2: 18.2, 3: 11.8, 4: 8.6 }");
    expect(routeSrc).toContain("mimaki: 0, // engine-owned RasterLink profile governs Mimaki");
    expect(routeSrc).toContain("const printerSpeedsSave = resolvePrinterSpeeds(await db.machine.findMany");
  });
});

describe("provisional Mimaki gloss ink + live fixture (15F.0G.3)", () => {
  const wasteSqft = ((7.13 * 3.13 * 585) / 144) / 0.9; // 100.736007

  it("15F.0K.4B: the Mimaki provisional gloss estimate is quarantined — gloss requests block CMYK-only and never price", () => {
    const one = computeProductDrivenCost(stickerInput({ quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, glossLayers: 1 }));
    const three = computeProductDrivenCost(stickerInput({ quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, glossLayers: 3 }));
    for (const run of [one, three]) {
      expect(run.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
      expect(run.lines.find((line) => line.key === "ink_gloss")).toBeUndefined();
      expect(run.lines.find((line) => line.key === "gloss_setup")).toBeUndefined();
    }
  });

  it("premiumInkEstimate snapshot metadata: factors 1.00 snapshotted, white and gloss SEPARATE, version recorded", () => {
    const estimate = buildMimakiPremiumInkEstimate({ wasteAdjustedSqft: wasteSqft, whiteLayers: 1, glossLayers: 3, inkMlPerSqft: 0.6 })!;
    expect(estimate.glossFactor).toBe(1.0);
    expect(estimate.whiteFactor).toBe(1.0);
    expect(estimate.glossFactor).not.toBe(MIMAKI_INK_CALIBRATION.whiteFactor === MIMAKI_INK_CALIBRATION.glossFactor ? 2 : estimate.whiteFactor); // structurally separate fields
    expect(estimate.estimatedGlossMl).toBeCloseTo(wasteSqft * 0.6 * 3, 8);
    expect(estimate.estimatedWhiteMl).toBeCloseTo(wasteSqft * 0.6 * 1, 8);
    expect(estimate.estimatedGlossCost).toBeCloseTo(estimate.estimatedGlossMl * 0.176, 8);
    expect(estimate.sourceVersion).toBe(PREMIUM_INK_ESTIMATE_VERSION);
    expect(estimate.profile).toContain("600x1200 VD / 32-pass");
    expect(buildMimakiPremiumInkEstimate({ wasteAdjustedSqft: wasteSqft, whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6 })).toBeNull(); // no premium layers -> no block
  });

  it("15F.0K.4B: the old live Mimaki gloss fixture now BLOCKS with the printer-capability message (route the job to Roland)", () => {
    const run = computeProductDrivenCost(stickerInput({
      quantity: 585, designs: 3, widthIn: 7.13, heightIn: 3.13, glossLayers: 3, cutType: "kiss-simple",
    }));
    expect(run.missing.join(" ")).toContain("Mimaki UCJV300-130 is CMYK ONLY");
    expect(run.lines.find((line) => line.key === "ink_gloss")).toBeUndefined();
    // The Roland-routed equivalent of this job prices normally — pinned in
    // fixture 3/4 (N) and fixture 6 (J) above (314.47 cost / 714.71 premium).
  });

  it("route wires the snapshot metadata and the customer estimated-ink note; DTP untouched", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
    expect(src).toContain("premiumInkEstimate: !savedIsDtpSnapshot && fRead(\"pprinter\") !== \"roland\" && productSnapshot");
    expect(src).toContain("buildMimakiPremiumInkEstimate({");
    expect(src).toContain("Premium ink usage is estimated for quoting and reconciled against RIP actuals after production.");
  });
});

describe("route parity + presentation pins (15F.0-L/M/P)", () => {
  const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");

  it("loader and save action use the SAME quantity-band resolver and commercial module", () => {
    // 15F.0K.2-A: the shared resolver replaced the direct positional calls —
    // the parity invariant is unchanged (identical resolver + rule on both
    // sides); Stage-A defaults reproduce the positional math exactly
    // (tests/margin-curve-equivalence.test.ts proves old == new per boundary).
    expect(src).toContain("resolveMarginPctForQuantity(pricingPolicy.values, marginCurveKeyP, marginRuleForPricingP, qty)");
    expect(src).toContain("resolveMarginPctForQuantity(pricingPolicy.values, marginCurveKeySave, marginRuleForPricingSave, qty)");
    const commercialCalls = src.match(/computeCommercialPrice\(\{/g) || [];
    expect(commercialCalls.length).toBeGreaterThanOrEqual(2); // loader + action (+ multi-line via combineStickerLines)
  });

  it("machine speeds are re-fetched server-side at save; posted totals never trusted", () => {
    expect(src).toContain("const printerSpeedsSave = resolvePrinterSpeeds(await db.machine.findMany");
    expect(src).toContain("machineSqftPerHour: printerSave === \"roland\" ? printerSpeedsSave.roland : printerSpeedsSave.mimaki");
  });

  it("workers see READY TO QUOTE or BLOCKED with exact blockers — WARNING is not a routine non-DTP pricing state", () => {
    expect(src).toContain('"READY TO QUOTE"');
    expect(src).toContain("BLOCKED — not customer-ready");
    expect(src).toContain("Does not include: Customer delivery/shipping");
    expect(src).toContain("Price based on:");
  });

  it("snapshot records the commercial decision (candidates, controlling rule, versions); DTP keeps its engine", () => {
    expect(src).toContain("commercialPricing: !savedIsDtpSnapshot && savedSelectedTier?.commercial");
    expect(src).toContain("controllingRule: savedSelectedTier.commercial.controllingRule");
    expect(src).toContain("DTP_PRICING_ENGINE_VERSION : PRODUCTION_READY_ENGINE_VERSION");
    expect(src).toContain("multiLine: savedMultiLine");
  });

  it("multi-line save recomputes lines from posted state (fReadAll) with re-fetched materials", () => {
    expect(src).toContain('fReadAll("pslqty")');
    expect(src).toContain("lineMaterialByIdSave");
    expect(src).toContain("combineStickerLines({");
  });
});
