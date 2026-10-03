// Patch 2D-4C2A — THE GSO CUTLINE RULE.
//
// Owner standard: every GSO label's cutline is the artwork with a -0.0625in
// inward offset path. It is deterministic production setup, so it is derived,
// never measured per job and never typed by an operator.
//
// These tests pin the rule itself, prove it is the ONLY cutline authority in
// the codebase, and prove it still fails closed when there is no artwork to
// offset from.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  GSO_CUTLINE_INSET_PER_AXIS_IN,
  GSO_CUTLINE_OFFSET_IN,
  deriveGsoLabelCutDiameter,
  deriveGsoLabelCutlineFromArtboard,
  formatGsoCutline,
  gsoCutPerimeterFromArtboard,
} from "../app/lib/gso-cutline";
import { BAG_4X5_ARTBOARD_IN, BAG_4X5_CUTLINE_IN } from "../app/lib/bag-cost-inputs.server";
import {
  BENCHMARK_ARTBOARD_IN,
  BENCHMARK_MEASURED_CUTLINE_IN,
  BENCHMARK_PERIMETER_IN,
  BENCHMARK_QTY,
  CUT_MODE_CALIBRATION,
  CUT_REFERENCE_PATH_IN,
} from "../app/lib/finishing-cost.server";
import { JAR_LABEL_GEOMETRY } from "../app/lib/jar-cost-inputs.server";
import { computeLabelJob } from "../app/lib/label-cost-inputs.server";
import { canonicalSaveGate, familyCostModel } from "../app/lib/canonical-quote-authority.server";

describe("2D-4C2A the rule", () => {
  it("the offset is 0.0625in per edge = 0.125in per axis", () => {
    expect(GSO_CUTLINE_OFFSET_IN).toBe(0.0625);
    expect(GSO_CUTLINE_INSET_PER_AXIS_IN).toBe(0.125);
  });

  it("1. 3.000 x 3.000 -> 2.875 x 2.875", () => {
    const cut = deriveGsoLabelCutlineFromArtboard(3, 3)!;
    expect(cut.cutWidthIn).toBeCloseTo(2.875, 10);
    expect(cut.cutHeightIn).toBeCloseTo(2.875, 10);
    expect(formatGsoCutline(cut)).toBe("2.875 x 2.875 in");
  });

  it("2. 4.000 x 5.000 -> 3.875 x 4.875", () => {
    const cut = deriveGsoLabelCutlineFromArtboard(4, 5)!;
    expect(cut.cutWidthIn).toBeCloseTo(3.875, 10);
    expect(cut.cutHeightIn).toBeCloseTo(4.875, 10);
  });

  it("the formula is exactly W-0.125 / H-0.125 across a range", () => {
    for (const [w, h] of [[1, 1], [2, 6.5], [3.15, 6.3], [9.4, 2.9], [12, 18]] as const) {
      const cut = deriveGsoLabelCutlineFromArtboard(w, h)!;
      expect(cut.cutWidthIn).toBeCloseTo(w - 0.125, 10);
      expect(cut.cutHeightIn).toBeCloseTo(h - 0.125, 10);
    }
  });

  it("5. missing or non-numeric artwork FAILS CLOSED", () => {
    for (const bad of [null, undefined, "", 0, -1, Number.NaN, Infinity, "abc"]) {
      expect(deriveGsoLabelCutlineFromArtboard(bad, 3), String(bad)).toBeNull();
      expect(deriveGsoLabelCutlineFromArtboard(3, bad), String(bad)).toBeNull();
    }
    expect(formatGsoCutline(null)).toBe("—");
  });

  it("6. artwork too small can never yield a zero or negative cutline", () => {
    for (const size of [0.125, 0.13, 0.1, 0.05, 0.01]) {
      const cut = deriveGsoLabelCutlineFromArtboard(size, size);
      if (cut) {
        expect(cut.cutWidthIn, String(size)).toBeGreaterThan(0);
        expect(cut.cutHeightIn, String(size)).toBeGreaterThan(0);
      } else {
        expect(cut).toBeNull(); // refused rather than degenerate
      }
    }
    // exactly at the inset there is nothing left to cut
    expect(deriveGsoLabelCutlineFromArtboard(0.125, 3)).toBeNull();
    // one axis valid and the other not still refuses the whole cutline
    expect(deriveGsoLabelCutlineFromArtboard(5, 0.05)).toBeNull();
  });

  it("perimeter and circular helpers follow the same rule", () => {
    expect(gsoCutPerimeterFromArtboard(4, 5)).toBeCloseTo(2 * (3.875 + 4.875), 10); // 17.5
    expect(gsoCutPerimeterFromArtboard(0, 5)).toBeNull();
    expect(deriveGsoLabelCutDiameter(2.0)).toBeCloseTo(1.875, 10);
    expect(deriveGsoLabelCutDiameter(0.1)).toBeNull();
  });
});

describe("2D-4C2A there is exactly ONE cutline authority", () => {
  it("7. the bag adapter derives its cutline — no 3.79 x 4.81 literal survives", () => {
    expect(BAG_4X5_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
    expect(BAG_4X5_CUTLINE_IN.widthIn).toBeCloseTo(3.875, 10);
    expect(BAG_4X5_CUTLINE_IN.heightIn).toBeCloseTo(4.875, 10);
    // and it equals what the rule says for that artboard
    const ruled = deriveGsoLabelCutlineFromArtboard(BAG_4X5_ARTBOARD_IN.widthIn, BAG_4X5_ARTBOARD_IN.heightIn)!;
    expect(BAG_4X5_CUTLINE_IN.widthIn).toBe(ruled.cutWidthIn);
    expect(BAG_4X5_CUTLINE_IN.heightIn).toBe(ruled.cutHeightIn);
  });

  it("3. the HISTORICAL benchmark keeps its measured geometry — 3.79 x 4.81 / 2236in / 11min", () => {
    // 2D-4C2C: a measured historical fact and a current production rule are
    // allowed to disagree. Restating the measurement in terms of the rule
    // would invent a path length nobody timed.
    expect(BENCHMARK_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
    expect(BENCHMARK_MEASURED_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    expect(BENCHMARK_QTY).toBe(130);
    expect(BENCHMARK_PERIMETER_IN).toBeCloseTo(17.2, 10);
    expect(CUT_REFERENCE_PATH_IN).toBeCloseTo(2236.0, 10);

    const mimaki = CUT_MODE_CALIBRATION["mimaki-ucjv300-130"]!;
    expect(mimaki.normal!.benchmarkMinutes).toBe(11.0);
    expect(mimaki.normal!.inchesPerMinute).toBeCloseTo(203.2727272, 6);
    expect(mimaki.normal!.benchmarkPathIn / mimaki.normal!.inchesPerMinute).toBeCloseTo(11.0, 10);
  });

  it("3b. the measured cutline is PROVABLY not rule-derived — which is why it stands apart", () => {
    // A -0.0625in offset gives symmetric insets. The measurement does not:
    // 0.105in on width, 0.095in on height. It cannot have come from the rule.
    const widthInset = (4.0 - BENCHMARK_MEASURED_CUTLINE_IN.widthIn) / 2;
    const heightInset = (5.0 - BENCHMARK_MEASURED_CUTLINE_IN.heightIn) / 2;
    expect(widthInset).toBeCloseTo(0.105, 10);
    expect(heightInset).toBeCloseTo(0.095, 10);
    expect(widthInset).not.toBeCloseTo(GSO_CUTLINE_OFFSET_IN, 6);
    expect(heightInset).not.toBeCloseTo(GSO_CUTLINE_OFFSET_IN, 6);
    expect(widthInset).not.toBeCloseTo(heightInset, 6);
    // and the rule applied to the same artboard yields something different
    const ruled = deriveGsoLabelCutlineFromArtboard(4, 5)!;
    expect(ruled.cutWidthIn).not.toBeCloseTo(BENCHMARK_MEASURED_CUTLINE_IN.widthIn, 6);
  });

  it("5. a live job cuts at DERIVED geometry but is timed at the HISTORICAL rate", () => {
    // current geometry
    const cut = deriveGsoLabelCutlineFromArtboard(3, 3)!;
    expect(cut.cutWidthIn).toBeCloseTo(2.875, 10);
    // historical speed
    const rate = CUT_MODE_CALIBRATION["mimaki-ucjv300-130"]!.normal!.inchesPerMinute;
    expect(rate).toBeCloseTo(203.2727272, 6);
    // the two combine: 1000 pieces at the derived perimeter, at the measured rate
    const perimeter = 2 * (cut.cutWidthIn + cut.cutHeightIn); // 11.5
    expect(perimeter).toBeCloseTo(11.5, 10);
    expect((1000 * perimeter) / rate).toBeCloseTo(56.57424, 4);
  });

  it("4. no CURRENT-geometry module uses 3.79 x 4.81 as production cutline", () => {
    // finishing-cost is deliberately excluded: it is the HISTORICAL
    // calibration record, and 3.79 x 4.81 is what was measured there.
    const files = [
      "app/lib/bag-cost-inputs.server.ts",
      "app/lib/canonical-calculator.server.ts",
      "app/lib/label-cost-inputs.server.ts",
      "app/routes/app.erp.cost-calculator.tsx",
    ];
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
        .join("\n");
      // the old hand-recorded pair must not appear as live values
      expect(code, file).not.toMatch(/widthIn:\s*3\.79\b/);
      expect(code, file).not.toMatch(/heightIn:\s*4\.81\b/);
    }
  });

  it("no module re-implements the offset arithmetic — they all import the rule", () => {
    for (const file of ["app/lib/bag-cost-inputs.server.ts", "app/lib/canonical-calculator.server.ts"]) {
      const src = readFileSync(file, "utf8");
      // every CURRENT-geometry consumer imports the single authority
      expect(src, file).toContain("gso-cutline");
      // and none of them COMPUTES with the offset: the remaining mentions are
      // prose in comments and human-readable note/source strings only.
      expect(src, file).not.toMatch(/[-+*/=]\s*0\.0625\s*[*+;)]/);
      expect(src, file).not.toMatch(/0\.0625\s*\*\s*2/);
      expect(src, file).not.toMatch(/-\s*0\.125\b/);
    }
    // the arithmetic exists in exactly one place
    const rule = readFileSync("app/lib/gso-cutline.ts", "utf8");
    expect(rule).toContain("GSO_CUTLINE_OFFSET_IN * 2");
    expect(rule.match(/GSO_CUTLINE_INSET_PER_AXIS_IN/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("2D-4C2A jar audit (report only — jars are NOT promoted)", () => {
  it("every jar profile carries real artboard geometry the rule could use", () => {
    for (const [size, geometry] of Object.entries(JAR_LABEL_GEOMETRY)) {
      expect(geometry.side.widthIn, size).toBeGreaterThan(0);
      expect(geometry.side.heightIn, size).toBeGreaterThan(0);
      expect(geometry.tamper.widthIn, size).toBeGreaterThan(0);
      expect(geometry.tamper.heightIn, size).toBeGreaterThan(0);
      expect(geometry.lid.diameterIn, size).toBeGreaterThan(0);
      // the rule yields a valid cutline for each of them
      expect(deriveGsoLabelCutlineFromArtboard(geometry.side.widthIn, geometry.side.heightIn), size).not.toBeNull();
      expect(deriveGsoLabelCutDiameter(geometry.lid.diameterIn), size).not.toBeNull();
    }
  });

  it("9. jars were fail-closed here — 2D-4D1 promoted them on the owner's approval", () => {
    // This patch derived the rule; it deliberately did NOT promote anything.
    // 2D-4D1 did, after the owner named the ten jars GSO actually offers and
    // every one of them costed with zero blockers. The guard is inverted
    // rather than deleted so the boundary between the two stays recorded.
    for (const jar of ["standard-jars", "premium-jars"]) {
      expect(familyCostModel(jar)).toBe("CANONICAL_COST_AUTHORITY");
    }
    // What the fail-closed classification protected still holds: an unusable
    // canonical result cannot be saved, whatever the family.
    const draftOnly = { family: "premium-jars", status: "DRAFT_ONLY" as const, unitCost: null, totalCost: 0, blockers: ["CUTLINE_GEOMETRY_REQUIRED"] };
    expect(canonicalSaveGate({ canonicalFamilyKey: "premium-jars", canonical: draftOnly }).allowed).toBe(false);
  });

  it("2D-4D: the jar adapter DERIVES its cutlines from the same rule", () => {
    const src = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    expect(src).toContain("deriveGsoLabelCutlineFromArtboard");
    expect(src).toContain("deriveGsoLabelCutDiameter");
    // the old artboard-stand-in note is gone
    expect(src).not.toContain("No owner cutline supplied");
    // Geometry alone was never promotion — the owner's approval was, and the
    // jar adapter still supplies no cutline it cannot derive from the rule.
    expect(src).not.toMatch(/cutWidthIn:\s*\d/);
  });
});

describe("2D-4C2A contour work stays fail-closed", () => {
  it("the rule places the cut path but does not supply an irregular perimeter", () => {
    // a contour line still needs its measured outline length; the offset rule
    // says WHERE the path runs, not HOW LONG an irregular one is.
    const contour = computeLabelJob({
      lines: [{ key: "c", artworkKey: "A", printWidthIn: 3, printHeightIn: 3, quantity: 100, materialKey: "matte", cutType: "contour" }],
    });
    expect(contour.blockers.join(" ")).toMatch(/CUTLINE_GEOMETRY_REQUIRED/);
    // supplying the measured perimeter clears it
    const withPerimeter = computeLabelJob({
      lines: [{ key: "c", artworkKey: "A", printWidthIn: 3, printHeightIn: 3, quantity: 100, materialKey: "matte", cutType: "contour", contourPerimeterIn: 11.5 }],
    });
    expect(withPerimeter.blockers).toHaveLength(0);
  });
});
