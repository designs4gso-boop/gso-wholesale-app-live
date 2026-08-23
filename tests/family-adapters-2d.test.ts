// Patch 2D (17D.6) — canonical family adapters: labels/stickers, 4x5 sticker
// bags + stock bags, banners. Plus the cross-family retirement checks that
// prove the two superseded constants can never be read as canonical costs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BAG_4X5_ARTBOARD_IN, BAG_4X5_BLANK_RETIRED_COST, BAG_4X5_BLANK_UNIT_COST, BAG_4X5_CUTLINE_IN,
  BAG_APPLICATION_LABOR_RATE_PER_HOUR, BAG_APPLICATION_RETIRED_LABELS_PER_HOUR,
  BAG_APPLICATION_SECONDS_PER_SIDE, BAG_REASONS, STOCK_BAG_MOQ,
  bagApplicationCost, bagSetupCost, computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { LABEL_MATERIALS, LABEL_REASONS, computeLabelJob } from "../app/lib/label-cost-inputs.server";
import { BANNER_REASONS, BANNER_REQUIRES_WEEDING, BANNER_VINYL_PER_SQFT, computeBannerCost, resolveBannerMachine } from "../app/lib/banner-cost-inputs.server";
import { FINISHING_REASONS, resolveCutCalibration } from "../app/lib/finishing-cost.server";
import { LEGACY_CONFLICTING_RATES, OWNER_STANDARDS } from "../app/lib/owner-standards";
import { APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";

/* ================================================================== *
 * 1. LABELS / STICKERS
 * ================================================================== */

const line = (over: Partial<Parameters<typeof computeLabelJob>[0]["lines"][0]> = {}) => ({
  key: "sticker-a", quantity: 500, printWidthIn: 3, printHeightIn: 3,
  cutWidthIn: 2.85, cutHeightIn: 2.85, materialKey: "matte", ...over,
});

describe("2D-1 labels / stickers", () => {
  it("uses only VERIFIED canonical material costs", () => {
    expect(LABEL_MATERIALS.matte.costPerSqft).toBeCloseTo(213 / ((54 / 12) * 150), 12);
    expect(LABEL_MATERIALS.holographic.costPerSqft).toBeCloseTo(488 / ((50 / 12) * 164), 12);
    const r = computeLabelJob({ lines: [line({ materialKey: "unobtainium" })] });
    expect(r.reasons).toContain(LABEL_REASONS.materialCostRequired);
    expect(r.blockers.join(" ")).toMatch(/never invented/);
  });

  it("the ACTUAL cutline drives the cutter path, not the artboard", () => {
    const r = computeLabelJob({ lines: [line()] });
    // 500 x 2 x (2.85 + 2.85) = 5700in on the CUTLINE
    expect(r.finishing!.cutPathIn).toBeCloseTo(500 * 2 * (2.85 + 2.85), 6);
    // the 3x3 ARTBOARD would have given 6000in
    expect(r.finishing!.cutPathIn).not.toBeCloseTo(500 * 2 * (3 + 3), 3);
  });

  it("a missing cutline BLOCKS with CUTLINE_GEOMETRY_REQUIRED", () => {
    const r = computeLabelJob({ lines: [line({ cutWidthIn: undefined, cutHeightIn: undefined })] });
    expect(r.reasons).toContain(FINISHING_REASONS.cutlineGeometryRequired);
    expect(r.blockers.join(" ")).toMatch(/CUTLINE_GEOMETRY_REQUIRED/);
  });

  it("a contour with NO geometry blocks; with geometry it is only PROVISIONAL", () => {
    const bare = computeLabelJob({ lines: [line({ cutType: "contour", cutWidthIn: undefined, cutHeightIn: undefined })] });
    expect(bare.reasons).toContain(FINISHING_REASONS.cutlineGeometryRequired);

    const known = computeLabelJob({ lines: [line({ cutType: "contour", contourPerimeterIn: 9.4, cutWidthIn: undefined, cutHeightIn: undefined })] });
    expect(known.reasons).not.toContain(FINISHING_REASONS.cutlineGeometryRequired);
    expect(known.reasons).toContain(FINISHING_REASONS.cutPathEstimateRequired);
    expect(known.finishing!.cutPathIn).toBeCloseTo(500 * 9.4, 6);
  });

  it("uses canonical nesting, material and weeding", () => {
    const r = computeLabelJob({ lines: [line()] });
    const nest = r.lines[0].nesting!;
    expect(nest.runs[0].bands[0].columns).toBeGreaterThan(0);
    expect(r.materialCost).toBeCloseTo(nest.materialFootprintSqft * LABEL_MATERIALS.matte.costPerSqft, 10);
    expect(r.finishing!.weedingPages).toBeGreaterThan(0);
  });

  it("multiple lines stay PHYSICALLY independent — sizes are never merged", () => {
    const r = computeLabelJob({
      lines: [line({ key: "small", printWidthIn: 2, printHeightIn: 2, cutWidthIn: 1.9, cutHeightIn: 1.9 }),
              line({ key: "large", printWidthIn: 4, printHeightIn: 6, cutWidthIn: 3.8, cutHeightIn: 5.8, materialKey: "gloss" })],
    });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].nesting!.runs[0].bands[0].placedWidthIn).not.toBe(r.lines[1].nesting!.runs[0].bands[0].placedWidthIn);
    expect(r.printedLabels).toBe(1000);
    // each line's own material rate is used
    expect(r.lines[1].material!.label).toBe("Poseidon Gloss");
  });
});

/* ================================================================== *
 * 2. 4X5 STICKER BAG + STOCK BAG
 * ================================================================== */

describe("2D-2 4x5 sticker bag + stock bag", () => {
  it("blank bag is EXACTLY $0.11, and $0.09 is retired", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(BAG_4X5_BLANK_RETIRED_COST).toBe(0.09);
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 });
    expect(r.blankCost).toBeCloseTo(1000 * 0.11, 10);
    expect(r.blankCost).not.toBeCloseTo(1000 * 0.09, 2);
  });

  it("cutline is 3.79 x 4.81 with a 17.20in perimeter — never the 4x5 artboard", () => {
    expect(BAG_4X5_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    expect(BAG_4X5_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
    expect(2 * (3.79 + 4.81)).toBeCloseTo(17.2, 10);
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 130, sides: 1 });
    expect(r.finishing.cutPathIn).toBeCloseTo(130 * 17.2, 6); // 2236in
    expect(r.finishing.cutPathIn).not.toBeCloseTo(130 * 2 * (4 + 5), 3); // artboard would be 2340
  });

  it("Mimaki NORMAL uses the canonical 203.2727 in/min", () => {
    const cal = resolveCutCalibration("mimaki-ucjv300-130", "normal")!;
    expect(cal.inchesPerMinute).toBeCloseTo(203.2727, 4);
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 130, sides: 1 });
    expect(r.finishing.cutMinutes!).toBeCloseTo(11.0, 6);
  });

  it("application is 10s per applied SIDE at $20/hr", () => {
    expect(BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    expect(BAG_APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(bagApplicationCost(1, 1)).toBeCloseTo(0.0555555556, 9);
    expect(bagApplicationCost(1, 2)).toBeCloseTo(0.1111111111, 9);
    // and NOT the retired 256/hr rate
    expect(bagApplicationCost(1, 1)).not.toBeCloseTo(20 / 256, 4);
    expect(bagApplicationCost(1, 2)).not.toBeCloseTo(2 * (20 / 256), 4);
  });

  it("single vs double side produces the right application event count", () => {
    const one = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 });
    const two = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(one.application.applicationEvents).toBe(1000);
    expect(two.application.applicationEvents).toBe(2000);
    expect(one.labelQuantity).toBe(1000);
    expect(two.labelQuantity).toBe(2000);
    expect(two.application.applicationLaborCost).toBeCloseTo(2 * one.application.applicationLaborCost, 10);
    // the bag itself is never charged twice — the blank line owns it
    expect(two.application.itemCost).toBe(0);
    expect(two.blankCost).toBeCloseTo(1000 * 0.11, 10);
  });

  it("weeding is present and no legacy cut multiplier exists", () => {
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(r.finishing.weedingPages).toBeGreaterThan(0);
    expect(r.finishing.weedingCost).toBeGreaterThan(0);
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const t of ["1.15", "1.35", "multiplier", "20 / 256", "0.078125"]) {
      expect(code.includes(t), t).toBe(false);
    }
  });

  it("STOCK BAG: MOQ 50", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(computeBagPhysical({ product: "stock_bag", bagQuantity: 40, sides: 1 }).reasons).toContain(BAG_REASONS.stockBagBelowMoq);
    expect(computeBagPhysical({ product: "stock_bag", bagQuantity: 50, sides: 1 }).reasons).not.toContain(BAG_REASONS.stockBagBelowMoq);
  });

  it("RECONCILIATION: every PHYSICAL line matches; only setup differs", () => {
    const custom = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });

    expect(stock.blankCost).toBeCloseTo(custom.blankCost, 12);
    expect(stock.labelQuantity).toBe(custom.labelQuantity);
    expect(stock.nesting.materialFootprintSqft).toBeCloseTo(custom.nesting.materialFootprintSqft, 12);
    expect(stock.nesting.ripLayoutSqft!).toBeCloseTo(custom.nesting.ripLayoutSqft!, 12);
    expect(stock.finishing.cutPathIn).toBeCloseTo(custom.finishing.cutPathIn, 12);
    expect(stock.finishing.cutMinutes!).toBeCloseTo(custom.finishing.cutMinutes!, 12);
    expect(stock.finishing.equipmentRecovery).toBeCloseTo(custom.finishing.equipmentRecovery, 12);
    expect(stock.finishing.operatorAttention).toBeCloseTo(custom.finishing.operatorAttention, 12);
    expect(stock.finishing.weedingCost).toBeCloseTo(custom.finishing.weedingCost, 12);
    expect(stock.application.applicationLaborCost).toBeCloseTo(custom.application.applicationLaborCost, 12);

    // the ONLY legitimate difference
    expect(custom.setup.art).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 10);
    expect(stock.setup.art).toBe(0);
    expect(stock.setup.print).toBeCloseTo(custom.setup.print, 10);
    expect(stock.setup.basisNote).toMatch(/premade GSO design/);
    // 2D-3C: art and print each carry their own typed basis
    expect(stock.setup.artBasis).toBe("PER_DESIGN");
    expect(stock.setup.printBasis).toBe("PER_DESIGN");
    expect(custom.setup.artBasis).toBe("PER_DESIGN");
    expect(custom.setup.printBasis).toBe("PER_DESIGN");
  });

  it("STOCK BAG: no $0 template blank and no Zakeke dependency", () => {
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 1 });
    expect(stock.blankCost).toBeGreaterThan(0);
    expect(stock.blankCost).toBeCloseTo(1000 * 0.11, 10);
    // check CODE, not prose — the header comment deliberately says "NO ZAKEKE"
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const t of ["Zakeke", "zakeke", "STOCK-BAG-4X5-TBD"]) expect(code.includes(t), t).toBe(false);
    expect(src.match(/^import /gm)!.every((i) => !/zakeke/i.test(i))).toBe(true);
    // 0.09 appears only where it documents its own retirement — never as a cost:
    //   the retired-value constant, and the source string recording the supersession
    expect(code.match(/0\.09/g)).toHaveLength(2);
    expect(code).toMatch(/BAG_4X5_BLANK_RETIRED_COST = 0\.09/);
    expect(code).toMatch(/BAG_4X5_BLANK_SOURCE[\s\S]*Supersedes the earlier \$0\.09/);
    // and the value actually charged is 0.11
    expect(code).toMatch(/BAG_4X5_BLANK_UNIT_COST = 0\.11/);
  });

  it("stock bag setup never charges new-customer art, however many designs are passed", () => {
    expect(bagSetupCost("stock_bag", 5).art).toBe(0);
    expect(bagSetupCost("sticker_bag_4x5", 2).art).toBeCloseTo(2 * OWNER_STANDARDS.artSetupPerDesign.value, 10);
  });
});

/* ================================================================== *
 * 3. BANNERS
 * ================================================================== */

describe("2D-3A banners", () => {
  const basic = (w: number, h: number, q = 1) => computeBannerCost({ widthIn: w, heightIn: h, quantity: q });

  it("uses the verified banner vinyl rate", () => {
    expect(BANNER_VINYL_PER_SQFT).toBeCloseTo(140 / ((54 / 12) * 105), 12);
    expect(BANNER_VINYL_PER_SQFT).toBeCloseTo(0.2962962963, 9);
  });

  it("MATERIAL is actual MEDIA CONSUMED, never finished sqft", () => {
    const r = basic(36, 60); // 3x5
    expect(r.finishedSqft).toBeCloseTo(15, 10);
    expect(r.mediaSqft).toBeCloseTo(22.5, 10); // 54in roll x 60in feed
    expect(r.mediaSqft).toBeGreaterThan(r.finishedSqft);
    expect(r.materialCost).toBeCloseTo(22.5 * BANNER_VINYL_PER_SQFT, 10);
    // the old (wrong) answer would have been finished x rate
    expect(r.materialCost).not.toBeCloseTo(15 * BANNER_VINYL_PER_SQFT, 4);
  });

  it("3x5 physically runs 36in across with 60in of feed", () => {
    const r = basic(36, 60);
    expect(r.rotated).toBe(false); // 60in cannot fit across a 53.6in window
    expect(r.columns).toBe(1);
    expect(r.rows).toBe(1);
    expect(r.feedLengthIn).toBeCloseTo(60, 10);
    expect(r.nestWidthIn).toBeCloseTo(36, 10);
  });

  it("2x4 rotates because that shortens the feed", () => {
    const r = basic(24, 48);
    expect(r.rotated).toBe(true);   // 48 across, 24 of feed
    expect(r.feedLengthIn).toBeCloseTo(24, 10);
    expect(r.mediaSqft).toBeCloseTo(9, 10);
  });

  it("the three areas stay separate for every sample size", () => {
    for (const [w, h, finished, media] of [[24, 48, 8, 9], [36, 60, 15, 22.5], [36, 72, 18, 27], [48, 96, 32, 36]] as const) {
      const r = basic(w, h);
      expect(r.finishedSqft, `${w}x${h} finished`).toBeCloseTo(finished, 9);
      expect(r.mediaSqft, `${w}x${h} media`).toBeCloseTo(media, 9);
      expect(r.ripLayoutSqft, `${w}x${h} rip`).toBeCloseTo(finished, 9); // nest box == the banner
      expect(r.mediaSqft).toBeGreaterThanOrEqual(r.ripLayoutSqft);
    }
  });

  it("uses the canonical nesting engine — no banner-specific layout formula", () => {
    const src = readFileSync("app/lib/banner-cost-inputs.server.ts", "utf8");
    expect(src).toMatch(/computeNesting/);
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // MEDIA must come from the nesting engine, never hand-rolled. (The one
    // `/ 144` that remains is FINISHED/inkable area, which is not media.)
    expect(code).toMatch(/mediaSqft = nesting\?\.materialFootprintSqft/);
    expect(code).toMatch(/materialCost = mediaSqft \* BANNER_VINYL_PER_SQFT/);
    expect(code.includes("BANNER_ROLL_WIDTH_IN *")).toBe(false); // no roll x feed by hand
    expect(code.match(/\/ 144/g)).toHaveLength(1); // finishedSqft only
  });

  it("banners are NEVER weeded", () => {
    expect(BANNER_REQUIRES_WEEDING).toBe(false);
    const r = basic(36, 72);
    expect(r.requiresWeeding).toBe(false);
    expect(r.finishing!.weedingPages).toBe(0);
    expect(r.finishing!.weedingCost).toBe(0);
  });

  it("TRIM is machine cutting through the canonical engine, never silently $0", () => {
    const r = basic(36, 72);
    // 1 banner, finished size IS the cutline: 2 x (36 + 72) = 216in
    expect(r.finishing!.cutPathIn).toBeCloseTo(2 * (36 + 72), 6);
    expect(r.finishing!.equipmentRecovery).toBeGreaterThan(0);
    expect(r.finishing!.operatorAttention).toBeGreaterThan(0);
    // ...and the borrowed rate is disclosed
    expect(r.reasons).toContain(BANNER_REASONS.trimRateRequired);
  });

  it("CMYK-only routes to the Mimaki by default", () => {
    expect(resolveBannerMachine({})).toBe("mimaki-ucjv300-130");
    expect(resolveBannerMachine({ machineKey: "roland-lg-640" })).toBe("roland-lg-640");
  });

  it("an unverified OPTIONAL finish never gets a guessed cost", () => {
    for (const [label, input] of [
      ["hem", { edge: "HEMMED" as const }],
      ["grommets", { grommets: "FOUR_CORNERS" as const }],
      ["pole pockets", { polePockets: "TOP" as const }],
    ] as const) {
      const r = computeBannerCost({ widthIn: 36, heightIn: 72, quantity: 1, ...input });
      expect(r.reasons, label).toContain(BANNER_REASONS.finishingRateRequired);
      expect(r.blockers.length, label).toBeGreaterThan(0);
      expect(r.unverifiedSelections[0].ownerInputNeeded, label).toBeTruthy();
    }
  });

  it("double-sided is not assumed possible", () => {
    expect(basic(36, 72).reasons).not.toContain(BANNER_REASONS.doubleSidedUnsupported);
    expect(computeBannerCost({ widthIn: 36, heightIn: 72, quantity: 1, sides: "DOUBLE" }).reasons)
      .toContain(BANNER_REASONS.doubleSidedUnsupported);
  });

  it("a plain banner is NOT blocked by an unselected optional finish", () => {
    const r = computeBannerCost({ widthIn: 24, heightIn: 48, quantity: 1, edge: "TRIM_ONLY", grommets: "NONE", polePockets: "NONE" });
    expect(r.blockers).toHaveLength(0);
    expect(r.materialCost).toBeGreaterThan(0);
  });

  it("a banner larger than the roll in BOTH directions is rejected", () => {
    expect(computeBannerCost({ widthIn: 60, heightIn: 60, quantity: 1 }).blockers.length).toBeGreaterThan(0);
  });

  it("contains no selling price, margin or competitor constant", () => {
    const src = readFileSync("app/lib/banner-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const t of ["sellPrice", "sellingPrice", "margin", "competitor", "retail", "4.50", "3.25"]) {
      expect(code.toLowerCase().includes(t.toLowerCase()), t).toBe(false);
    }
  });
});

/* ================================================================== *
 * 4. CROSS-FAMILY — retirements and isolation
 * ================================================================== */

describe("2D cross-family", () => {
  it("the $0.09 blank bag is retired from the canonical seed", () => {
    const bag = APPROVED_COST_TRUTH.find((i) => i.key === "bag-4x5")!;
    expect(bag.flatCost).toBe(0.11);
    expect(bag.marker).toMatch(/2026-08-22/);
    expect(bag.marker).toMatch(/supersedes/i);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank009.value).toBe(0.09);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank009.supersededBy).toMatch(/0\.11/);
  });

  it("the 256/hr application standard is retired from canonical bag costing", () => {
    expect(BAG_APPLICATION_RETIRED_LABELS_PER_HOUR).toBe(256);
    // demoted: no longer owner_verified, and its basis says so
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.status).toBe("provisional");
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.basis).toMatch(/SUPERSEDED/);
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.unit).toMatch(/SUPERSEDED/);
    expect(LEGACY_CONFLICTING_RATES.bag4x5ApplicationPer256Hour.supersededBy).toMatch(/10 seconds per applied side/);
    // the canonical adapter never imports it
    expect(readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8").includes("bagApplicationPerLabel4x5")).toBe(false);
  });

  it("DTP and Boxes never import the in-house manufacturing adapters", () => {
    for (const file of ["app/lib/product-driven-costing.server.ts", "app/lib/commercial-pricing-policy.server.ts"]) {
      const src = readFileSync(file, "utf8");
      for (const adapter of ["bag-cost-inputs", "label-cost-inputs", "banner-cost-inputs", "finishing-cost", "nesting-engine"]) {
        expect(src.includes(adapter), `${file} -> ${adapter}`).toBe(false);
      }
    }
  });

  it("no live storefront pricing path imports the new adapters", () => {
    for (const file of [
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      for (const adapter of ["bag-cost-inputs", "label-cost-inputs", "banner-cost-inputs", "label-application"]) {
        expect(src.includes(adapter), `${file} -> ${adapter}`).toBe(false);
      }
    }
  });

  it("the cost calculator route is NOT rewired in this patch", () => {
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    for (const adapter of ["bag-cost-inputs", "label-cost-inputs", "banner-cost-inputs"]) {
      expect(src.includes(adapter), adapter).toBe(false);
    }
  });
});

describe("2D-3A/2D-3B stock bag personalization + retired data script", () => {
  it("2D-3C: selected personalization COSTS one normal art setup per design — it no longer blocks", () => {
    for (const p of [{ logo: true }, { qr: true }, { logo: true, qr: true }]) {
      const r = computeBagPhysical({ product: "stock_bag", bagQuantity: 500, sides: 1, personalization: p });
      expect(r.personalization.internalSetupCost, JSON.stringify(p)).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 10);
      expect(r.personalization.internalCostStatus).toBe("VERIFIED");
      expect(r.blockers, JSON.stringify(p)).toHaveLength(0);
      // and it stays free to the customer
      expect(r.personalization.customerAddOn).toBe(0);
    }
    // the rate-required reason code is gone from the vocabulary entirely
    expect(Object.values(BAG_REASONS)).not.toContain("STOCK_BAG_PERSONALIZATION_RATE_REQUIRED");
  });

  it("UNselected personalization leaves the base stock bag at $0 art and no blocker", () => {
    for (const p of [undefined, {}, { logo: false, qr: false }]) {
      const r = computeBagPhysical({ product: "stock_bag", bagQuantity: 500, sides: 1, personalization: p });
      expect(r.personalization.internalSetupCost).toBe(0);
      expect(r.setup.art).toBe(0);
      expect(r.blockers).toHaveLength(0);
    }
  });

  it("the obsolete one-shot can never restore $0.09", () => {
    const src = readFileSync("tools/apply-15f0k4b-data-corrections.mjs", "utf8");
    expect(src.includes("costPerUnit: 0.09")).toBe(false);
    expect(src.includes("newCost: 0.09")).toBe(false);
    expect(src).toMatch(/RETIRED 2026-08-23/);
    expect(src).toMatch(/never write \$0\.09 again/);
    // the other corrections in the script are untouched
    expect(src).toMatch(/costPerUnit: 2\.78/);
    expect(src).toMatch(/costPerHour: 8/);
  });
});
