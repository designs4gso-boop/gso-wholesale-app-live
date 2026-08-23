// Patch 2C-3A (17D.4) — canonical cutting + weeding, corrected geometry.
//
// GSO labels are cut INDIVIDUALLY. The reference benchmark is 130 x 4x5 bag
// labels whose ARTBOARD is 4.00 x 5.00in but whose real CUTLINE is
// 3.79 x 4.81in — perimeter 17.20in, total path 2236.0in, cut in 11.0 min.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CUT_EQUIPMENT_RATE_PER_HOUR,
  CUT_OPERATOR_ATTENTION_PER_HOUR,
  CUT_REFERENCE_PATH_IN,
  FINISHING_REASONS,
  REFERENCE_ARTBOARD_IN,
  REFERENCE_CUTLINE_IN,
  REFERENCE_PERIMETER_IN,
  REFERENCE_QTY,
  WEEDING_COST_PER_REFERENCE_PAGE,
  WEEDING_REFERENCE_PAGE_IN,
  WEEDING_REQUIRED_BY_DEFAULT,
  computeFinishing,
  computeWeeding,
  resolveCutCalibration,
  runCutPath,
  weedingPagesForRun,
  type CutGeometryMap,
} from "../app/lib/finishing-cost.server";
import { computeNesting, resolveNestingPolicy, type NestingPolicy } from "../app/lib/nesting-engine.server";

const MIMAKI = "mimaki-ucjv300-130";
const ROLAND = "roland-lg-640";
const policyFor = (machineKey: string, media: number): NestingPolicy => {
  const r = resolveNestingPolicy({ machineKey, loadedMediaWidthIn: media });
  if (!r.ok) throw new Error(r.message);
  return r.policy;
};

/** The reference job: nesting uses the ARTBOARD, cutting uses the CUTLINE. */
const referenceNesting = () =>
  computeNesting(
    [{ key: "bench", items: [{ key: "label", widthIn: 3.989, heightIn: 5, quantity: REFERENCE_QTY, shapeType: "rect", groupKey: "label" }] }],
    policyFor(MIMAKI, 54),
  );
const REFERENCE_GEOMETRY: CutGeometryMap = {
  label: { model: "separated_rectangle", cutWidthIn: REFERENCE_CUTLINE_IN.widthIn, cutHeightIn: REFERENCE_CUTLINE_IN.heightIn },
};

/* ================================================================== *
 * 1. CUTLINE GEOMETRY — the 2C-3A correction
 * ================================================================== */

describe("1. cutline geometry", () => {
  it("3.79 x 4.81 cutline perimeter = 17.20 in", () => {
    expect(REFERENCE_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    expect(REFERENCE_PERIMETER_IN).toBeCloseTo(17.2, 10);
    expect(2 * (3.79 + 4.81)).toBeCloseTo(17.2, 10);
  });

  it("130 labels = 2236.0 in of total cut path", () => {
    expect(REFERENCE_QTY).toBe(130);
    expect(CUT_REFERENCE_PATH_IN).toBeCloseTo(2236.0, 10);
    expect(130 * 17.2).toBeCloseTo(2236.0, 10);
  });

  it("separated rectangles do NOT collapse shared edges", () => {
    const band = runCutPath(referenceNesting().runs[0], REFERENCE_GEOMETRY).bands[0];
    expect(band.model).toBe("separated_rectangle");
    expect(band.pathIn).toBeCloseTo(2236.0, 6);
    // the rejected shared-grid answer, for contrast
    const grid = runCutPath(referenceNesting().runs[0], { label: { model: "shared_grid" } }).bands[0];
    expect(grid.pathIn).toBeCloseTo(1270.427, 3);
    expect(band.pathIn).toBeGreaterThan(grid.pathIn * 1.7);
  });

  it("the ARTBOARD does not determine the cut path — the CUTLINE does", () => {
    expect(REFERENCE_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
    const withCutline = runCutPath(referenceNesting().runs[0], REFERENCE_GEOMETRY).bands[0];
    const withoutCutline = runCutPath(referenceNesting().runs[0]).bands[0];
    // nesting placed the ARTBOARD (3.989 x 5.000); the cutter used 3.79 x 4.81
    expect(withCutline.cutWidthIn).toBe(3.79);
    expect(withCutline.cutHeightIn).toBe(4.81);
    expect(withoutCutline.cutWidthIn).toBeCloseTo(3.989, 6);
    expect(withCutline.pathIn).toBeLessThan(withoutCutline.pathIn);
    // ...and the artboard fallback is flagged, never passed off as measured
    expect(withCutline.estimateRequired).toBe(false);
    expect(withoutCutline.estimateRequired).toBe(true);
    expect(withoutCutline.estimateReason).toMatch(/ARTBOARD/);
  });

  it("shared_grid is never inferred — it must be asked for explicitly", () => {
    expect(runCutPath(referenceNesting().runs[0], REFERENCE_GEOMETRY).bands[0].model).toBe("separated_rectangle");
    expect(runCutPath(referenceNesting().runs[0]).bands[0].model).toBe("separated_rectangle");
  });

  it("a contour circle uses its circumference", () => {
    const lid = computeNesting(
      [{ key: "lid-run", items: [{ key: "lid", widthIn: 2, heightIn: 2, quantity: 35, shapeType: "circle_bbox", groupKey: "lid" }] }],
      policyFor(ROLAND, 54),
    );
    const band = runCutPath(lid.runs[0], { lid: { model: "contour", cutDiameterIn: 2 } }).bands[0];
    expect(band.model).toBe("contour");
    expect(band.perimeterIn).toBeCloseTo(Math.PI * 2, 10);
    expect(band.pathIn).toBeCloseTo(35 * Math.PI * 2, 10);
    expect(band.estimateRequired).toBe(true);
  });
});

/* ================================================================== *
 * 2. BENCHMARK RATES
 * ================================================================== */

describe("2. cut-mode benchmarks on the corrected 2236in geometry", () => {
  it("Mimaki NORMAL: 2236 / 203.2727 ~= 11 min — OWNER_MEASURED", () => {
    const cal = resolveCutCalibration(MIMAKI, "normal")!;
    expect(cal.inchesPerMinute).toBeCloseTo(203.2727, 4);
    expect(cal.benchmarkPathIn).toBeCloseTo(2236.0, 6);
    expect(cal.benchmarkMinutes).toBe(11.0);
    expect(2236.0 / cal.inchesPerMinute).toBeCloseTo(11.0, 9);
    expect(cal.classification).toBe("OWNER_MEASURED");
    expect(cal.provisional).toBeUndefined();
  });

  it("Mimaki NORMAL+PERF: 2236 / 20 = 111.8 in/min — DERIVED_FROM_CONFIRMED_GEOMETRY", () => {
    const cal = resolveCutCalibration(MIMAKI, "normal_perf")!;
    expect(cal.inchesPerMinute).toBeCloseTo(111.8, 9);
    expect(cal.classification).toBe("DERIVED_FROM_CONFIRMED_GEOMETRY");
    expect(cal.provisional).toBeUndefined();
  });

  it("both Roland rates are UNVERIFIED_GEOMETRY and force PROVISIONAL", () => {
    const normal = resolveCutCalibration(ROLAND, "normal")!;
    const perf = resolveCutCalibration(ROLAND, "normal_perf")!;
    expect(normal.inchesPerMinute).toBeCloseTo(2236 / 9, 9); // 248.444…
    expect(perf.inchesPerMinute).toBeCloseTo(2236 / 16, 9); // 139.75
    for (const cal of [normal, perf]) {
      expect(cal.classification).toBe("UNVERIFIED_GEOMETRY");
      expect(cal.provisional).toContain(FINISHING_REASONS.cutGeometryUnverified);
      expect(cal.source).toMatch(/INFERRED/);
    }
  });

  it("the OLD shared-grid rates are gone", () => {
    const src = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const stale of ["115.5", "1270.4", "63.5", "141.2", "79.4"]) {
      expect(code.includes(stale), stale).toBe(false);
    }
  });

  it("Mimaki NORMAL runs end to end at 11.0 min on the real reference job", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(r.cutPathIn).toBeCloseTo(2236.0, 6);
    expect(r.cutMinutes!).toBeCloseTo(11.0, 9);
    expect(r.reasons).toHaveLength(0);
  });

  it("normal_perf is ONE configured mode, never normal + a perf stage", () => {
    const n = referenceNesting();
    const perf = computeFinishing({ nesting: n, machineKey: MIMAKI, cutMode: "normal_perf", cutGeometry: REFERENCE_GEOMETRY });
    expect(perf.stages.filter((s) => s.category === "machine_recovery")).toHaveLength(1);
    expect(perf.stages.some((s) => /perf/i.test(s.key))).toBe(false);
    expect(perf.cutMinutes!).toBeCloseTo(20.0, 9);
  });
});

/* ================================================================== *
 * 3. OCCUPANCY LINES
 * ================================================================== */

describe("3. cutting occupancy — two separate lines", () => {
  const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });

  it("equipment recovery and operator attention stay separate, in separate categories", () => {
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    const at = r.stages.find((s) => s.key === "cutting_attention")!;
    expect(eq.category).toBe("machine_recovery");
    expect(at.category).toBe("run_labor");
    expect(eq.amount).toBeCloseTo(r.cutHours! * CUT_EQUIPMENT_RATE_PER_HOUR, 10);
    expect(at.amount).toBeCloseTo(r.cutHours! * CUT_OPERATOR_ATTENTION_PER_HOUR, 10);
    expect(at.amount / eq.amount).toBeCloseTo(2.5 / 8, 12);
  });

  it("charges NO cut setup", () => {
    expect(r.stages.some((s) => /setup/i.test(s.key))).toBe(false);
    expect(/cutSetup|cut_setup|setupPerCut/i.test(readFileSync("app/lib/finishing-cost.server.ts", "utf8"))).toBe(false);
  });

  it("carries NO legacy complexity multipliers", () => {
    const src = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const term of ["1.15", "1.35", "1.6", "kiss-simple", "kiss-moderate", "kiss-complex", "multiplier", "complexity"]) {
      expect(code.includes(term), term).toBe(false);
    }
    expect(r.cutMinutes!).toBeCloseTo(r.cutPathIn / resolveCutCalibration(MIMAKI, "normal")!.inchesPerMinute, 12);
  });

  it("never reads raw RasterLink cut rows", () => {
    const src = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    for (const t of ["PrintLogEntry", "printLogEntry", "prisma", "rawRow", "db."]) {
      expect(src.includes(t), t).toBe(false);
    }
  });
});

/* ================================================================== *
 * 4. WEEDING — unchanged contract
 * ================================================================== */

describe("4. weeding", () => {
  it("is required by default", () => {
    expect(WEEDING_REQUIRED_BY_DEFAULT).toBe(true);
    expect(WEEDING_REFERENCE_PAGE_IN).toBe(54);
    expect(WEEDING_COST_PER_REFERENCE_PAGE).toBeCloseTo(20 / 15, 12);
  });

  it("330.20in -> 7 pages, 70.30in -> 2 pages, two runs -> 9 pages -> $12.00", () => {
    expect(weedingPagesForRun(330.2)).toBe(7);
    expect(weedingPagesForRun(70.3)).toBe(2);
    const w = computeWeeding([{ key: "side-body-run", feedLengthIn: 330.2 }, { key: "lid-run", feedLengthIn: 70.3 }]);
    expect(w.totalPages).toBe(9);
    expect(w.cost).toBeCloseTo(12.0, 10);
  });

  it("exact boundary: 378in / 54 = exactly 7 pages", () => {
    expect(378 / 54).toBe(7);
    expect(weedingPagesForRun(378)).toBe(7);
    expect(weedingPagesForRun(60 * 6.3)).toBe(7);
    expect(weedingPagesForRun(378.0001)).toBe(8);
  });

  it("rounds PER RUN — differs from rounding the combined feed", () => {
    expect(computeWeeding([{ key: "a", feedLengthIn: 330.2 }, { key: "b", feedLengthIn: 70.3 }]).totalPages).toBe(9);
    expect(Math.ceil((330.2 + 70.3) / 54)).toBe(8);
  });

  it("requiresWeeding=false produces zero cost", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY, requiresWeeding: false });
    expect(r.stages.find((s) => s.key === "weeding")!.amount).toBe(0);
    expect(r.weedingPages).toBe(0);
  });

  it("weeding is human labor, kept out of machine categories", () => {
    const w = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY }).stages.find((s) => s.key === "weeding")!;
    expect(w.category).toBe("finishing_application");
    expect(w.note).toMatch(/never the printer\/operator rate/);
  });
});

/* ================================================================== *
 * 5. STATUS / REASON SEMANTICS
 * ================================================================== */

describe("5. never invents geometry or a rate", () => {
  it("an uncalibrated machine/mode BLOCKS", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: "unknown-cutter", cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    expect(eq.amount).toBe(0);
    expect(eq.blocker).toContain(FINISHING_REASONS.cutCalibrationPending);
    expect(r.cutMinutes).toBeNull();
  });

  it("a contour band prices numerically but stays PROVISIONAL", () => {
    const lid = computeNesting(
      [{ key: "lid-run", items: [{ key: "lid", widthIn: 1.9, heightIn: 1.9, quantity: 1010, shapeType: "circle_bbox", groupKey: "lid" }] }],
      policyFor(MIMAKI, 54),
    );
    const r = computeFinishing({ nesting: lid, machineKey: MIMAKI, cutMode: "normal", cutGeometry: { lid: { model: "contour", cutDiameterIn: 1.9 } } });
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    expect(eq.blocker).toBeUndefined();
    expect(eq.amount).toBeGreaterThan(0);
    expect(eq.provisional).toContain(FINISHING_REASONS.cutPathEstimateRequired);
    expect(r.reasons).toContain(FINISHING_REASONS.cutPathEstimateRequired);
  });

  it("2C-3B: an unknown ACTUAL cutline BLOCKS — never merely provisional", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal" });
    expect(r.reasons).toContain(FINISHING_REASONS.cutlineGeometryRequired);
    expect(r.cutlineMissingBands).toEqual(["label"]);
    expect(r.cutPathIsDiagnosticOnly).toBe(true);
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    const at = r.stages.find((s) => s.key === "cutting_attention")!;
    for (const stage of [eq, at]) {
      expect(stage.blocker).toContain(FINISHING_REASONS.cutlineGeometryRequired);
      expect(stage.provisional).toBeUndefined(); // a blocker, NOT a provisional
      expect(stage.amount).toBe(0);
    }
  });

  it("2C-3B: the artboard path survives ONLY as a labelled diagnostic estimate", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal" });
    // the number is still computed, for preview
    expect(r.cutPathIn).toBeCloseTo(130 * 2 * (3.989 + 5), 6);
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    expect(eq.note).toMatch(/DIAGNOSTIC ESTIMATE ONLY \(not quote-ready\)/);
    expect(eq.note).toMatch(/never billed, never canonical/);
    // ...and it does NOT clear the blocker
    expect(eq.blocker).toBeTruthy();
    expect(eq.amount).toBe(0);
    expect(r.blockers.join(" ")).toMatch(/ARTBOARD DIAGNOSTIC ESTIMATE ONLY/);
  });

  it("2C-3B: a KNOWN cutline + calibrated Mimaki normal does NOT block", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(r.reasons).not.toContain(FINISHING_REASONS.cutlineGeometryRequired);
    expect(r.cutlineMissingBands).toEqual([]);
    expect(r.cutPathIsDiagnosticOnly).toBe(false);
    expect(r.blockers).toHaveLength(0);
    expect(r.stages.find((s) => s.key === "cutting_machine")!.amount).toBeGreaterThan(0);
  });

  it("2C-3B: a contour with NO supplied geometry also blocks", () => {
    const lid = computeNesting(
      [{ key: "lid-run", items: [{ key: "lid", widthIn: 2, heightIn: 2, quantity: 35, shapeType: "circle_bbox", groupKey: "lid" }] }],
      policyFor(MIMAKI, 54),
    );
    const bare = computeFinishing({ nesting: lid, machineKey: MIMAKI, cutMode: "normal" });
    expect(bare.reasons).toContain(FINISHING_REASONS.cutlineGeometryRequired);
    const known = computeFinishing({ nesting: lid, machineKey: MIMAKI, cutMode: "normal", cutGeometry: { lid: { model: "contour", cutDiameterIn: 2 } } });
    expect(known.reasons).not.toContain(FINISHING_REASONS.cutlineGeometryRequired);
    expect(known.reasons).toContain(FINISHING_REASONS.cutPathEstimateRequired);
  });

  it("2C-3B: the four cases stay distinct", () => {
    const known = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(known.blockers).toHaveLength(0);
    expect(known.reasons).toHaveLength(0); // calibrated + known cutline + straight cuts

    const noCal = computeFinishing({ nesting: referenceNesting(), machineKey: "unknown-cutter", cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(noCal.reasons).toEqual([FINISHING_REASONS.cutCalibrationPending]);

    const noCutline = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal" });
    expect(noCutline.reasons).toEqual([FINISHING_REASONS.cutlineGeometryRequired]);

    const rolandKnown = computeFinishing({ nesting: referenceNesting(), machineKey: ROLAND, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(rolandKnown.blockers).toHaveLength(0);
    expect(rolandKnown.reasons).toEqual([FINISHING_REASONS.cutGeometryUnverified]);
  });

  it("an UNVERIFIED_GEOMETRY rate makes an otherwise clean job PROVISIONAL", () => {
    const bags = computeNesting(
      [{ key: "r", items: [{ key: "l", widthIn: 3.989, heightIn: 5, quantity: 130, shapeType: "rect", groupKey: "label" }] }],
      policyFor(ROLAND, 54),
    );
    const r = computeFinishing({ nesting: bags, machineKey: ROLAND, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY });
    expect(r.reasons).toContain(FINISHING_REASONS.cutGeometryUnverified);
    expect(r.stages.find((s) => s.key === "cutting_machine")!.provisional).toContain(FINISHING_REASONS.cutGeometryUnverified);
    expect(r.cutMinutes!).toBeCloseTo(2236 / (2236 / 9), 9); // 9.0 min
  });

  it("requiresCutting=false zeroes cutting without blocking", () => {
    const r = computeFinishing({ nesting: referenceNesting(), machineKey: MIMAKI, cutMode: "normal", cutGeometry: REFERENCE_GEOMETRY, requiresCutting: false });
    const eq = r.stages.find((s) => s.key === "cutting_machine")!;
    expect(eq.amount).toBe(0);
    expect(eq.blocker).toBeUndefined();
  });
});

/* ================================================================== *
 * 6. GENERIC ACROSS FAMILIES
 * ================================================================== */

describe("6. product-agnostic", () => {
  it("contains no family constants", () => {
    const src = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const term of ["jar", "lid", "tamper", "Chiron", "Miron", "sticker", "banner", "pouch", "DTP"]) {
      expect(new RegExp(`\\b${term}\\b`, "i").test(code), term).toBe(false);
    }
  });

  it("a 4x5 sticker-bag run cuts and weeds through the same code path", () => {
    const bags = computeNesting(
      [{ key: "bag-run", items: [{ key: "4x5", widthIn: 3.989, heightIn: 5, quantity: 1000, shapeType: "rect", groupKey: "bag" }] }],
      policyFor(MIMAKI, 54),
    );
    const r = computeFinishing({
      nesting: bags, machineKey: MIMAKI, cutMode: "normal",
      cutGeometry: { bag: { model: "separated_rectangle", cutWidthIn: 3.79, cutHeightIn: 4.81 } },
    });
    expect(r.cutPathIn).toBeCloseTo(1000 * 17.2, 6);
    expect(r.weedingPages).toBe(Math.ceil(bags.runs[0].feedLengthIn / 54));
    expect(r.reasons).toHaveLength(0);
  });

  it("no live pricing path imports the finishing engine", () => {
    for (const file of [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/lib/product-driven-costing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      expect(readFileSync(file, "utf8").includes("finishing-cost"), file).toBe(false);
    }
  });
});
