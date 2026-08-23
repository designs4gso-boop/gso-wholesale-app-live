// Patch 2D-4 — Cost Calculator canonical integration.
//
// The whole point of this suite is that ONE function owns the true cost of a
// supported family, and that calculate / save / recalculate cannot disagree
// because there is only one normaliser and one assembler between all three.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_DISPATCH,
  CANONICAL_FAMILIES,
  CANONICAL_PACKOUT,
  CANONICAL_REASONS,
  NON_CANONICAL_FAMILIES,
  assembleCanonicalJob,
  canonicalFamilyFromUi,
  canonicalViewOf,
  isCanonicalFamily,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { SPECIALTY_FILE_PREP_FEE, specialtyFilePrepFee } from "../app/lib/calculator-fee-standards";
import { BAG_APPLICATION_SECONDS_PER_SIDE, BAG_4X5_BLANK_UNIT_COST, BAG_4X5_CUTLINE_IN } from "../app/lib/bag-cost-inputs.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { WIRED_LABOR } from "../app/lib/cost-calculator.server";
import { calculateAddOns, isSetupTypeAddOn, validateAddOnBasis, allowedPricingTypesFor } from "../app/lib/recipe-pricing.server";
import { isQuantityIndependentBasis } from "../app/lib/true-cost-engine.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const routeSrc = () => readFileSync(ROUTE, "utf8");

/** An approved Mimaki CMYK calibration, shaped exactly like a real DB row. */
const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test",
    machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};

const NO_CAL: ResolvedMachineInputs = {
  calibration: null,
  calibrationMessage: "No approved calibration for this identity.",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};

const MACHINE_QS = "pmachinekey=mimaki-ucjv300-130&pinkmode=cmyk&pripprofile=p&pqualitymode=q&presolution=r&ppassconfig=1x";

const run = (qs: string, machine: ResolvedMachineInputs = CAL) => {
  const input = normalizeCanonicalInput(new URLSearchParams(qs));
  expect(input, `query did not normalise: ${qs}`).not.toBeNull();
  return assembleCanonicalJob(input!, machine);
};

const BAG_QS = `pfamily=sticker-bags&pqty=1000&pbagsides=2&pdesigns=1&${MACHINE_QS}`;
const STOCK_QS = `pfamily=sticker-bags&pstockbag=1&pqty=1000&pbagsides=2&${MACHINE_QS}`;
const BANNER_QS = `pfamily=banners&pqty=1&pbannerw=36&pbannerh=60&pdesigns=1&${MACHINE_QS}`;
const LABEL_QS =
  `pfamily=stickers-labels&pllines=2` +
  `&pl0qty=500&pl0w=3&pl0h=3&pl0cutw=2.85&pl0cuth=2.85&pl0mat=matte&pl0art=A` +
  `&pl1qty=500&pl1w=3&pl1h=3&pl1cutw=2.85&pl1cuth=2.85&pl1mat=holographic&pl1art=A&${MACHINE_QS}`;

/* ================================================================== *
 * DISPATCH
 * ================================================================== */

describe("2D-4 canonical dispatch", () => {
  it("routes exactly the four in-house manufacturing families", () => {
    expect([...CANONICAL_FAMILIES]).toEqual(["stickers-labels", "sticker-bags", "stock-bags", "banners"]);
    expect(CANONICAL_DISPATCH["stickers-labels"].adapter).toBe("label-cost-inputs.server.ts");
    expect(CANONICAL_DISPATCH["sticker-bags"].adapter).toBe("bag-cost-inputs.server.ts");
    expect(CANONICAL_DISPATCH["stock-bags"].adapter).toBe("bag-cost-inputs.server.ts");
    expect(CANONICAL_DISPATCH.banners.adapter).toBe("banner-cost-inputs.server.ts");
    // both bag products share ONE physical adapter
    expect(CANONICAL_DISPATCH["stock-bags"].adapter).toBe(CANONICAL_DISPATCH["sticker-bags"].adapter);
  });

  it("DTP and Boxes are never routed through the in-house adapters", () => {
    for (const family of ["dtp-bags", "boxes"]) {
      expect(isCanonicalFamily(family)).toBe(false);
      expect(NON_CANONICAL_FAMILIES).toContain(family);
      expect(normalizeCanonicalInput(new URLSearchParams(`pfamily=${family}&pqty=1000`))).toBeNull();
    }
  });

  it("jars and custom-item also stay on their existing path", () => {
    for (const family of ["standard-jars", "premium-jars", "custom-item"]) {
      expect(normalizeCanonicalInput(new URLSearchParams(`pfamily=${family}&pqty=1000`))).toBeNull();
    }
  });

  it("the stock-bag flag is what separates the two bag products", () => {
    expect(canonicalFamilyFromUi("sticker-bags", false)).toBe("sticker-bags");
    expect(canonicalFamilyFromUi("sticker-bags", true)).toBe("stock-bags");
    expect(canonicalFamilyFromUi("dtp-bags", false)).toBeNull();
  });
});

/* ================================================================== *
 * LABELS / STICKERS — including the deferred ink + machine wiring
 * ================================================================== */

describe("2D-4 label / sticker integration", () => {
  it("calls the canonical adapter and carries its per-line media through", () => {
    const r = run(LABEL_QS);
    expect(r.adapter.label).not.toBeNull();
    expect(r.adapter.label!.lines).toHaveLength(2);
    // each line nested on its OWN roll width — 54in matte vs 50in holographic
    expect(r.adapter.label!.lines[0].nesting!.materialFootprintSqft)
      .not.toBeCloseTo(r.adapter.label!.lines[1].nesting!.materialFootprintSqft, 6);
    // and the job media equals the sum of the lines exactly
    const summed = r.adapter.label!.lines.reduce((s, l) => s + l.materialCost, 0);
    const materialLine = r.trueCost.lines.find((l) => l.key === "print_media")!;
    expect(materialLine.amount).toBeCloseTo(summed, 8);
  });

  it("INK is now wired — a real mL x $/mL line, not a placeholder", () => {
    const r = run(LABEL_QS);
    const ink = r.trueCost.lines.find((l) => l.key === "ink")!;
    expect(ink.blocker).toBeUndefined();
    expect(ink.amount).toBeGreaterThan(0);
    // 1000 labels x 9 sq in = 62.5 sqft inkable x 1.6 mL/sqft x $0.176/mL
    expect(r.diagnostics.inkableArtworkSqft).toBeCloseTo(62.5, 6);
    expect(ink.amount).toBeCloseTo(62.5 * 1.6 * CANONICAL_INK_RATES.mimakiCmykPerMl, 6);
    expect(r.trueCost.totals.ink).toBeCloseTo(ink.amount, 10);
  });

  it("MACHINE occupancy + equipment recovery are now wired", () => {
    const r = run(LABEL_QS);
    const machine = r.trueCost.lines.find((l) => l.key === "machine")!;
    expect(machine.blocker).toBeUndefined();
    expect(machine.amount).toBeGreaterThan(0);
    expect(r.diagnostics.machineMinutes).toBeGreaterThan(0);
    // occupancy runs on RIP LAYOUT, never on the finished/inkable area
    expect(r.diagnostics.machineMinutes).toBeCloseTo(r.diagnostics.ripLayoutSqft! * 1.444, 1);
    // and operator attention derives from that same occupancy
    expect(r.trueCost.totals.run_labor).toBeGreaterThan(0);
  });

  it("a missing calibration BLOCKS ink and machine instead of zeroing them", () => {
    const r = run(LABEL_QS, NO_CAL);
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.reasons).toContain(CANONICAL_REASONS.calibrationRequired);
    expect(r.blockers.join(" ")).toMatch(/MISSING_CALIBRATION/);
  });

  it("a missing ACTUAL cutline blocks — the artboard is never substituted", () => {
    const noCut = LABEL_QS.replace("&pl0cutw=2.85&pl0cuth=2.85", "").replace("&pl1cutw=2.85&pl1cuth=2.85", "");
    const r = run(noCut);
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.blockers.join(" ")).toMatch(/CUTLINE_GEOMETRY_REQUIRED/);
  });

  it("artwork identity and print-setup events survive the round trip", () => {
    const shared = run(LABEL_QS);
    expect(shared.diagnostics.artSetupEvents).toBe(1); // one artwork
    expect(shared.diagnostics.printSetupEvents).toBe(2); // two press setups
    const distinct = run(LABEL_QS.replace("pl1art=A", "pl1art=B"));
    expect(distinct.diagnostics.artSetupEvents).toBe(2);
    expect(distinct.diagnostics.printSetupEvents).toBe(2);
    // physical cost is identical; only art setup moved
    expect(distinct.trueCost.totals.materials).toBeCloseTo(shared.trueCost.totals.materials, 10);
    expect(distinct.trueCost.totals.setup_labor - shared.trueCost.totals.setup_labor)
      .toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 8);
  });

  it("cutting, weeding and their two burdens all reach the engine", () => {
    const r = run(LABEL_QS);
    expect(r.diagnostics.cutPathIn).toBeGreaterThan(0);
    expect(r.diagnostics.cutMinutes).toBeGreaterThan(0);
    expect(r.diagnostics.weedingPages).toBeGreaterThan(0);
    const byKey = (pattern: RegExp) => r.trueCost.lines.filter((l) => pattern.test(l.key));
    // cutter OCCUPANCY posts as equipment recovery, its ATTENTION as run labor —
    // the same split the printer gets, so cut time is never buried in finishing.
    const cutterOccupancy = byKey(/cut.*(machine|equip)/i);
    expect(cutterOccupancy).toHaveLength(1);
    expect(cutterOccupancy[0].category).toBe("machine_recovery");
    expect(cutterOccupancy[0].amount).toBeGreaterThan(0);
    const cutterAttention = byKey(/cut.*attention/i);
    expect(cutterAttention).toHaveLength(1);
    expect(cutterAttention[0].category).toBe("run_labor");
    expect(cutterAttention[0].amount).toBeGreaterThan(0);
    const weeding = byKey(/weed/i);
    expect(weeding).toHaveLength(1);
    expect(weeding[0].amount).toBeGreaterThan(0);
    expect(weeding[0].basis).toBe("PER_AREA");
  });

  it("specialty file prep is a per-EVENT setup, never per copy", () => {
    const withPrep = (qty: number) =>
      run(LABEL_QS.replace("pl0qty=500", `pl0qty=${qty}`).replace("pl1qty=500", `pl1qty=${qty}`) + "&pfileprep=1&pfileprepevents=1");
    const small = withPrep(50);
    const big = withPrep(5000);
    const specialtySmall = small.trueCost.lines.find((l) => l.key === "specialty_setup")!;
    const specialtyBig = big.trueCost.lines.find((l) => l.key === "specialty_setup")!;
    expect(specialtySmall.amount).toBeCloseTo(OWNER_STANDARDS.glossLayerSetupPerDesign.value, 8);
    expect(specialtyBig.amount).toBe(specialtySmall.amount);
    expect(isQuantityIndependentBasis(specialtyBig.basis)).toBe(true);
  });
});

/* ================================================================== *
 * LABEL APPLICATION — the three modes
 * ================================================================== */

describe("2D-4 label application modes", () => {
  it("NONE: no physical item cost and no application labor", () => {
    const r = run(LABEL_QS);
    expect(r.adapter.application).toBeNull();
    expect(r.diagnostics.applicationEvents).toBeNull();
    const app = r.trueCost.lines.find((l) => l.key === "application")!;
    expect(app.amount).toBe(0);
    expect(r.trueCost.lines.find((l) => l.key === "custom_item")).toBeUndefined();
  });

  it("CUSTOMER_PROVIDED_ITEM: item cost $0, labor at the canonical $20/hr", () => {
    const r = run(`${LABEL_QS}&papplymode=customer_provided_item&papplyitemqty=500&papplyper=2&papplysec=12`);
    const app = r.adapter.application!;
    expect(app.itemCost).toBe(0);
    expect(app.applicationEvents).toBe(1000); // 500 items x 2 applications
    expect(app.applicationLaborCost).toBeCloseTo((1000 * 12 / 3600) * 20, 8);
    expect(r.trueCost.lines.find((l) => l.key === "custom_item")).toBeUndefined();
    // and the engine charged exactly that labor
    expect(r.trueCost.lines.find((l) => l.key === "application")!.amount)
      .toBeCloseTo(app.applicationLaborCost, 6);
  });

  it("CUSTOM_ITEM: item cost = physical quantity x entered unit cost", () => {
    const r = run(`${LABEL_QS}&papplymode=custom_item&papplyitemqty=500&papplyper=2&papplysec=12&papplyitemcost=0.4`);
    const app = r.adapter.application!;
    expect(app.itemCost).toBeCloseTo(500 * 0.4, 8);
    const custom = r.trueCost.lines.find((l) => l.key === "custom_item")!;
    expect(custom.amount).toBeCloseTo(200, 8);
    expect(custom.category).toBe("materials");
    expect(custom.basis).toBe("PER_UNIT");
  });

  it("the four quantity diagnostics stay distinct and are never conflated", () => {
    const r = run(`${LABEL_QS}&papplymode=customer_provided_item&papplyitemqty=500&papplyper=2&papplysec=12`);
    expect(r.diagnostics.physicalItems).toBe(500);
    expect(r.diagnostics.applicationsPerItem).toBe(2);
    expect(r.diagnostics.applicationEvents).toBe(1000);
    expect(r.diagnostics.printedLabelsAvailable).toBe(1000);
    expect(r.diagnostics.physicalItems).not.toBe(r.diagnostics.applicationEvents);
  });

  it("a label shortfall still blocks", () => {
    const r = run(`${LABEL_QS}&papplymode=customer_provided_item&papplyitemqty=5000&papplyper=2&papplysec=12`);
    expect(r.reasons.join(" ")).toMatch(/APPLICATION_LABEL_QUANTITY_SHORTFALL/);
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
  });

  it("a missing application rate blocks rather than costing $0", () => {
    const r = run(`${LABEL_QS}&papplymode=customer_provided_item&papplyitemqty=500&papplyper=2&papplysec=0`);
    expect(r.reasons.join(" ")).toMatch(/APPLICATION_RATE_REQUIRED/);
    expect(r.status).toBe("DRAFT_ONLY");
  });

  it("CUSTOM_ITEM with no item cost blocks", () => {
    const r = run(`${LABEL_QS}&papplymode=custom_item&papplyitemqty=500&papplyper=2&papplysec=12`);
    expect(r.reasons.join(" ")).toMatch(/CUSTOM_ITEM_COST_REQUIRED/);
    expect(r.status).toBe("DRAFT_ONLY");
  });
});

/* ================================================================== *
 * 4x5 STICKER BAGS + STOCK BAGS
 * ================================================================== */

describe("2D-4 bag integration", () => {
  it("the canonical adapter is authoritative and carries the owner facts", () => {
    const r = run(BAG_QS);
    expect(r.adapter.bag).not.toBeNull();
    // $0.11 blank at production quantity
    const blankLine = r.trueCost.lines.find((l) => l.key === "blank_sets")!;
    expect(blankLine.amount).toBeCloseTo(1000 * BAG_4X5_BLANK_UNIT_COST, 8);
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    // 10s per applied side at $20/hr, 2 sides
    expect(BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    expect(r.trueCost.lines.find((l) => l.key === "application")!.amount)
      .toBeCloseTo((1000 * 2 * 10 / 3600) * 20, 6);
    // the ACTUAL 4x5 cutline drove the cutter
    expect(BAG_4X5_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    expect(r.diagnostics.cutPathIn).toBeCloseTo(2000 * 2 * (3.79 + 4.81), 6);
    // weeding is required
    expect(r.diagnostics.weedingPages).toBeGreaterThan(0);
  });

  it("single vs double side scales the physical work, not the setup", () => {
    const one = run(BAG_QS.replace("pbagsides=2", "pbagsides=1"));
    const two = run(BAG_QS);
    expect(two.diagnostics.applicationEvents).toBe(2 * one.diagnostics.applicationEvents!);
    expect(two.diagnostics.mediaConsumedSqft).toBeGreaterThan(one.diagnostics.mediaConsumedSqft);
    expect(two.trueCost.totals.setup_labor).toBeCloseTo(one.trueCost.totals.setup_labor, 10);
  });

  it("physical quantity scales production while setup stays put", () => {
    const runs = [50, 500, 5000].map((q) => run(BAG_QS.replace("pqty=1000", `pqty=${q}`)));
    expect(new Set(runs.map((r) => r.trueCost.totals.setup_labor)).size).toBe(1);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i].trueCost.totals.materials).toBeGreaterThan(runs[i - 1].trueCost.totals.materials);
      expect(runs[i].trueCost.totals.finishing_application).toBeGreaterThan(runs[i - 1].trueCost.totals.finishing_application);
    }
  });

  it("stock bag and 4x5 sticker bag give IDENTICAL physical results", () => {
    const sticker = run(BAG_QS);
    const stock = run(STOCK_QS);
    expect(stock.diagnostics.mediaConsumedSqft).toBe(sticker.diagnostics.mediaConsumedSqft);
    expect(stock.diagnostics.ripLayoutSqft).toBe(sticker.diagnostics.ripLayoutSqft);
    expect(stock.diagnostics.cutPathIn).toBe(sticker.diagnostics.cutPathIn);
    expect(stock.diagnostics.weedingPages).toBe(sticker.diagnostics.weedingPages);
    expect(stock.diagnostics.applicationEvents).toBe(sticker.diagnostics.applicationEvents);
    expect(stock.trueCost.totals.materials).toBeCloseTo(sticker.trueCost.totals.materials, 10);
    expect(stock.trueCost.totals.ink).toBeCloseTo(sticker.trueCost.totals.ink, 10);
    // ONLY setup differs — premade base art is $0
    expect(stock.adapter.bag!.setup.art).toBe(0);
    expect(sticker.adapter.bag!.setup.art).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 8);
  });

  it("stock bag MOQ 50 still blocks below the minimum", () => {
    const below = run(STOCK_QS.replace("pqty=1000", "pqty=25"));
    expect(below.reasons.join(" ")).toMatch(/STOCK_BAG_BELOW_MOQ/);
    expect(below.status).toBe("DRAFT_ONLY");
    expect(run(STOCK_QS.replace("pqty=1000", "pqty=50")).reasons.join(" ")).not.toMatch(/BELOW_MOQ/);
  });

  it("personalization is one normal art setup per design, free to the customer", () => {
    for (const qty of [50, 500, 5000]) {
      const r = run(`${STOCK_QS.replace("pqty=1000", `pqty=${qty}`)}&pperslogo=1`);
      expect(r.diagnostics.personalizationSetupEvents, `qty ${qty}`).toBe(1);
      expect(r.diagnostics.personalizationCustomerAddOn).toBe(0);
      expect(r.adapter.bag!.personalization.internalSetupCost).toBeCloseTo(25 / 3, 8);
    }
    const two = run(`${STOCK_QS}&pperslogo=1&ppersqr=1&ppersdesigns=2`);
    expect(two.diagnostics.personalizationSetupEvents).toBe(2);
    expect(two.adapter.bag!.personalization.internalSetupCost).toBeCloseTo(2 * (25 / 3), 8);
    // $1 print setup per legitimate print-design event
    expect(two.diagnostics.printSetupEvents).toBe(2);
    expect(two.adapter.bag!.setup.print).toBeCloseTo(2 * OWNER_STANDARDS.printSetupPerDesign.value, 8);
  });

  it("bag quantity never multiplies personalization or print setup", () => {
    const runs = [50, 500, 5000].map((q) => run(`${STOCK_QS.replace("pqty=1000", `pqty=${q}`)}&pperslogo=1&ppersdesigns=2`));
    expect(new Set(runs.map((r) => r.diagnostics.personalizationSetupEvents)).size).toBe(1);
    expect(new Set(runs.map((r) => r.diagnostics.printSetupEvents)).size).toBe(1);
    expect(new Set(runs.map((r) => r.trueCost.totals.setup_labor)).size).toBe(1);
    // while application really does scale
    expect(new Set(runs.map((r) => r.diagnostics.applicationEvents)).size).toBe(3);
  });
});

/* ================================================================== *
 * BANNERS
 * ================================================================== */

describe("2D-4 banner integration", () => {
  it("material is ACTUAL media consumed — a 3x5 uses 22.5 sqft, not 15", () => {
    const r = run(BANNER_QS);
    expect(r.adapter.banner!.finishedSqft).toBeCloseTo(15, 8);
    expect(r.diagnostics.mediaConsumedSqft).toBeCloseTo(22.5, 8);
    expect(r.diagnostics.ripLayoutSqft).toBeCloseTo(15, 8);
    expect(r.diagnostics.inkableArtworkSqft).toBeCloseTo(15, 8);
    // and the priced media line uses the 22.5, not the 15
    const media = r.trueCost.lines.find((l) => l.key === "print_media")!;
    expect(media.amount).toBeCloseTo(22.5 * (140 / ((54 / 12) * 105)), 8);
  });

  it("ink and machine are wired for banners too", () => {
    const r = run(BANNER_QS);
    expect(r.trueCost.lines.find((l) => l.key === "ink")!.blocker).toBeUndefined();
    expect(r.trueCost.totals.ink).toBeGreaterThan(0);
    expect(r.trueCost.totals.machine_recovery).toBeGreaterThan(0);
    // ink prices the FINISHED artwork, occupancy the RIP layout
    expect(r.trueCost.totals.ink).toBeCloseTo(15 * 1.6 * CANONICAL_INK_RATES.mimakiCmykPerMl, 6);
  });

  it("banners are trimmed, never weeded", () => {
    const r = run(BANNER_QS);
    expect(r.diagnostics.weedingPages).toBe(0);
    expect(r.trueCost.lines.some((l) => /weed/.test(l.key))).toBe(false);
    expect(r.diagnostics.cutPathIn).toBeGreaterThan(0);
  });

  it("unverified finishing operations block instead of being guessed", () => {
    for (const [param, value] of [["pbanneredge", "HEMMED"], ["pbannergrommets", "FOUR_CORNERS"], ["pbannerpockets", "TOP"], ["pbannersides", "DOUBLE"]]) {
      const r = run(`${BANNER_QS}&${param}=${value}`);
      expect(r.status, `${param}=${value}`).toBe("DRAFT_ONLY");
      expect(r.unitCost).toBeNull();
      expect(r.blockers.length).toBeGreaterThan(0);
    }
  });

  it("banner packout is disclosed as unverified rather than charged", () => {
    expect(CANONICAL_PACKOUT.banners.unitsPerBox).toBeNull();
    const r = run(BANNER_QS);
    expect(r.reasons).toContain(CANONICAL_REASONS.packoutNotModeled);
    expect(r.trueCost.totals.packout).toBe(0);
  });
});

/* ================================================================== *
 * STATUS / BLOCKER SEMANTICS
 * ================================================================== */

describe("2D-4 blocked jobs never look quote-ready", () => {
  it("DRAFT_ONLY publishes NO unit cost — and it is not $0", () => {
    const r = run(BAG_QS, NO_CAL);
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.unitCost).not.toBe(0);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("the three statuses stay distinct", () => {
    expect(run(BAG_QS, NO_CAL).status).toBe("DRAFT_ONLY");
    const ok = run(BAG_QS);
    expect(["VALID", "PROVISIONAL"]).toContain(ok.status);
    expect(ok.unitCost).not.toBeNull();
  });

  it("the client view carries the blockers and the null unit cost intact", () => {
    const view = canonicalViewOf(run(BAG_QS, NO_CAL));
    expect(view.status).toBe("DRAFT_ONLY");
    expect(view.unitCost).toBeNull();
    expect(view.blockers.length).toBeGreaterThan(0);
    // and it does NOT ship the raw adapter objects to the browser
    expect(view).not.toHaveProperty("adapter");
    expect(view).not.toHaveProperty("trueCost");
  });
});

/* ================================================================== *
 * CALCULATE / SAVE / RECALCULATE CONSISTENCY
 * ================================================================== */

describe("2D-4 calculate / save / recalculate cannot disagree", () => {
  const QUERIES = [BAG_QS, STOCK_QS, BANNER_QS, LABEL_QS, `${LABEL_QS}&papplymode=custom_item&papplyitemqty=500&papplyper=2&papplysec=12&papplyitemcost=0.4`];

  it("the same query string yields byte-identical totals every time", () => {
    for (const qs of QUERIES) {
      // calculate (loader: url.searchParams)
      const calculated = run(qs);
      // save (action: the replayed psearch string)
      const saved = run(new URLSearchParams(qs).toString());
      // recalculate (a fresh page load of the same URL)
      const recalculated = run(`?${qs}`.replace(/^\?/, ""));
      expect(saved.totalCost, qs).toBe(calculated.totalCost);
      expect(recalculated.totalCost, qs).toBe(calculated.totalCost);
      expect(saved.unitCost).toBe(calculated.unitCost);
      expect(recalculated.unitCost).toBe(calculated.unitCost);
      expect(saved.status).toBe(calculated.status);
      expect(JSON.stringify(saved.trueCost.totals)).toBe(JSON.stringify(calculated.trueCost.totals));
      expect(JSON.stringify(saved.diagnostics)).toBe(JSON.stringify(calculated.diagnostics));
    }
  });

  it("param ORDER cannot change the answer", () => {
    const shuffled = BAG_QS.split("&").reverse().join("&");
    expect(run(shuffled).totalCost).toBe(run(BAG_QS).totalCost);
  });

  it("there is exactly ONE assembler — the route never re-implements it", () => {
    const src = routeSrc();
    // the route calls the shared entry point, on both sides
    expect(src).toContain("normalizeCanonicalInput(url.searchParams)");
    expect(src).toContain("normalizeCanonicalInput(psearchParams)");
    const calls = src.match(/computeCanonicalJob\(/g) || [];
    expect(calls.length).toBe(2); // loader + action, nothing else
    // and it does NOT import the adapters directly
    for (const adapter of ["bag-cost-inputs", "banner-cost-inputs", "label-cost-inputs", "true-cost-engine"]) {
      expect(src, adapter).not.toContain(`../lib/${adapter}`);
    }
  });

  it("the save path builds from the replayed query string, not the posted form", () => {
    const src = routeSrc();
    const idx = src.indexOf("const canonicalInputSave");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx, idx + 160)).toContain("psearchParams");
    expect(src.slice(idx, idx + 160)).not.toContain("fRead(");
  });

  it("the browser owns no canonical arithmetic", () => {
    const src = routeSrc();
    const start = src.indexOf("function CanonicalTrueCost()");
    const end = src.indexOf("function ProductBreakdown()");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const panel = src.slice(start, end);
    // formatting only: no engine call, no adapter call, no cost recomputation
    expect(panel).not.toContain("computeCanonicalJob");
    expect(panel).not.toContain("assembleCanonicalJob");
    expect(panel).not.toMatch(/computeTrueJobCost|computeBagPhysical|computeLabelJob|computeBannerCost/);
  });
});

/* ================================================================== *
 * RECIPE ADD-ON BASIS GUARD
 * ================================================================== */

describe("2D-4 setup-type add-ons can never be per-unit", () => {
  const SETUP_NAMES = ["Art setup", "Artwork setup", "Print setup", "File prep", "File preparation", "Design setup", "Prepress", "Specialty setup", "Gloss mask setup", "Setup fee", "Plate charge", "Screen setup", "Proofing fee"];
  const PRODUCTION_NAMES = ["Lamination", "Rush handling", "Extra packaging", "Die cut", "Foil per unit", "Shrink wrap"];

  it("recognises setup-type operations by name", () => {
    for (const name of SETUP_NAMES) expect(isSetupTypeAddOn({ name }), name).toBe(true);
    for (const name of PRODUCTION_NAMES) expect(isSetupTypeAddOn({ name }), name).toBe(false);
  });

  it("a setup-type add-on configured per_unit contributes ZERO and reports a blocker", () => {
    const addOn = { id: "x", name: "Art setup", pricingType: "per_unit", amount: 8.3333 };
    const result = calculateAddOns([addOn], ["x"], 5000, 1000);
    expect(result.perUnitCost).toBe(0);
    expect(result.total).toBe(0);
    expect(result.basisViolations).toHaveLength(1);
    expect(result.basisViolations[0].reason).toBe("ADDON_SETUP_CANNOT_BE_PER_UNIT");
    expect(result.blockers[0]).toMatch(/must never scale with order quantity/);
    // without the guard this would have been 5000 x $8.3333
    expect(result.total).not.toBeCloseTo(5000 * 8.3333, 2);
  });

  it("percent-of-cost is refused for setup work too", () => {
    const result = calculateAddOns([{ id: "y", name: "Design setup", pricingType: "percent", amount: 10 }], ["y"], 5000, 1000);
    expect(result.percentCost).toBe(0);
    expect(result.basisViolations).toHaveLength(1);
  });

  it("a setup-type add-on as flat_fee is allowed and charged ONCE", () => {
    for (const qty of [50, 500, 5000]) {
      const result = calculateAddOns([{ id: "z", name: "Art setup", pricingType: "flat_fee", amount: 8.3333 }], ["z"], qty, 1000);
      expect(result.flatCost).toBeCloseTo(8.3333, 6);
      expect(result.total).toBeCloseTo(8.3333, 6);
      expect(result.basisViolations).toHaveLength(0);
    }
  });

  it("legitimate production add-ons keep working per_unit", () => {
    const result = calculateAddOns([{ id: "p", name: "Lamination", pricingType: "per_unit", amount: 0.05 }], ["p"], 5000, 1000);
    expect(result.perUnitCost).toBeCloseTo(250, 6);
    expect(result.basisViolations).toHaveLength(0);
  });

  it("validateAddOnBasis names the allowed types for an admin screen", () => {
    const violations = validateAddOnBasis([{ id: "a", name: "Print setup", pricingType: "per_unit", amount: 1 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].allowedPricingTypes).toEqual(["flat_fee", "included"]);
    expect(allowedPricingTypesFor({ name: "Lamination" })).toContain("per_unit");
  });
});

/* ================================================================== *
 * DUPLICATE AUTHORITY CLEANUP
 * ================================================================== */

describe("2D-4 duplicate authority cleanup", () => {
  it("WIRED_LABOR reads the owner registry wherever an equal entry exists", () => {
    expect(WIRED_LABOR.jarPerApplication).toBe(OWNER_STANDARDS.jarApplicationPerLabel.value);
    expect(WIRED_LABOR.bag14x16PerSide).toBe(OWNER_STANDARDS.bagApplicationPerLabel14x16.value);
    expect(WIRED_LABOR.artSetupPerDesign).toBe(OWNER_STANDARDS.artSetupPerDesign.value);
    expect(WIRED_LABOR.printSetupPerDesign).toBe(OWNER_STANDARDS.printSetupPerDesign.value);
    expect(WIRED_LABOR.designSetupPerDesign)
      .toBe(OWNER_STANDARDS.artSetupPerDesign.value + OWNER_STANDARDS.printSetupPerDesign.value);
  });

  it("no value changed — the cleanup is a sourcing fix only", () => {
    expect(WIRED_LABOR.jarPerApplication).toBeCloseTo(0.2, 10);
    expect(WIRED_LABOR.bag14x16PerSide).toBeCloseTo(1.0, 10);
    expect(WIRED_LABOR.artSetupPerDesign).toBeCloseTo(25 / 3, 12);
    expect(WIRED_LABOR.printSetupPerDesign).toBeCloseTo(1.0, 12);
    expect(WIRED_LABOR.designSetupPerDesign).toBeCloseTo(25 / 3 + 1, 12);
    // the two that genuinely differ keep their own number
    expect(WIRED_LABOR.bag4x5PerSide).toBeCloseTo(20 / 180, 12);
    expect(WIRED_LABOR.glossWhiteSetupPerJob).toBeCloseTo(25 / 3, 12);
  });

  it("the 14x16 bag rate no longer leaks in from the legacy const", () => {
    const src = readFileSync("app/lib/product-driven-costing.server.ts", "utf8");
    expect(src).not.toContain("WIRED_LABOR.bag14x16PerSide");
    expect(src).toContain("OWNER_STANDARDS.bagApplicationPerLabel14x16.value");
  });

  it("the specialty file-prep fee has ONE authority", () => {
    expect(SPECIALTY_FILE_PREP_FEE).toBe(25);
    expect(specialtyFilePrepFee({ requested: true, glossLayers: 1, whiteLayers: 0 })).toBe(25);
    expect(specialtyFilePrepFee({ requested: true, glossLayers: 0, whiteLayers: 0 })).toBe(0);
    expect(specialtyFilePrepFee({ requested: false, glossLayers: 2, whiteLayers: 1 })).toBe(0);
    const src = routeSrc();
    expect(src).toContain("specialtyFilePrepFee({");
    // the two inline literals are gone
    expect(src).not.toMatch(/pfileprep"\) === "1" &&[^\n]*\? 25 : 0/);
    expect(src.match(/\? 25 : 0/g)).toBeNull();
  });

  it("canonical bag application uses 10s/side — never the retired 256/hr rate", () => {
    const r = run(BAG_QS);
    const app = r.trueCost.lines.find((l) => l.key === "application")!;
    expect(app.amount).toBeCloseTo((1000 * 2 * 10 / 3600) * 20, 6);
    // the retired rate would have produced a different number
    expect(app.amount).not.toBeCloseTo(1000 * 2 * (20 / 256), 4);
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(src).not.toContain("bagApplicationPerLabel4x5");
    expect(src).not.toContain("0.078125");
  });
});

/* ================================================================== *
 * LEGACY CUTOVER
 * ================================================================== */

describe("2D-4 legacy path cutover", () => {
  it("the supported families no longer take their TRUE COST from the legacy engine", () => {
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    for (const legacy of ["computeProductDrivenCost", "computeAutoCost", "computeLineCosts"]) {
      expect(src, legacy).not.toContain(legacy);
    }
  });

  it("the canonical result is the only true cost the calculator serializes for them", () => {
    const src = routeSrc();
    expect(src).toContain("canonical: canonicalResult ? canonicalViewOf(canonicalResult) : null");
    expect(src).toContain("canonical: canonicalSnapshot");
  });

  it("DTP and Boxes keep their existing branch untouched", () => {
    const src = routeSrc();
    expect(src).toContain("priceDtpQuote");
    expect(src).toContain("SPEKTRA_FREIGHT_PER_PO");
    // and neither reaches the canonical dispatch
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=dtp-bags&pqty=5000"))).toBeNull();
  });

  it("jars keep their blocker — no artboard fallback to force a number", () => {
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=standard-jars&pqty=1000"))).toBeNull();
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=premium-jars&pqty=1000"))).toBeNull();
  });
});
