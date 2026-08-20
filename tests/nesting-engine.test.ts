// Patch 2B (17D.3) — the universal deterministic nesting / layout engine.
//
// Every number here is either an owner rule, a measured production benchmark,
// or a value the engine derived. Nothing is tuned toward a historical cost
// target: the two jar diagnostics report their delta and the residual is left
// visible rather than closed with a plug figure.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOW_ROTATION,
  DEFAULT_HORIZONTAL_GUTTER_IN,
  DEFAULT_VERTICAL_GUTTER_IN,
  MACHINE_NESTING_POLICIES,
  NESTING_BLOCKERS,
  NESTING_ENGINE_VERSION,
  computeNesting,
  resolveNestingPolicy,
  type NestingPolicy,
  type NestingRun,
} from "../app/lib/nesting-engine.server";
import {
  JAR_DEFAULT_MEDIA_WIDTH_IN,
  JAR_LABEL_GEOMETRY,
  inkableArtworkSqInPerSet,
  jarNestingAreas,
  jarPhysicalRuns,
  productionQtyFor,
  type JarLabelSelection,
} from "../app/lib/jar-cost-inputs.server";

const MIMAKI = "mimaki-ucjv300-130";
const ROLAND = "roland-lg-640";

/** Convenience: resolve a policy or fail loudly. */
function policyFor(machineKey: string, mediaWidthIn: number, actualSweptWidthIn?: number): NestingPolicy {
  const r = resolveNestingPolicy({ machineKey, loadedMediaWidthIn: mediaWidthIn, actualSweptWidthIn });
  if (!r.ok) throw new Error(r.message);
  return r.policy;
}

const rect = (key: string, w: number, h: number, qty: number, allowRotate = true) => ({
  key, widthIn: w, heightIn: h, quantity: qty, allowRotate, groupKey: key,
});

/* ================================================================== *
 * 1. CORE PLACEMENT LAW
 * ================================================================== */

describe("1. core placement law", () => {
  const base: NestingPolicy = {
    mediaWidthIn: 54, printableWidthIn: 50, ripBoxConvention: "nest_bbox",
    source: "test", classification: "TEST",
  };

  it("columns = floor(printableWidth / itemWidth), rows = ceil(qty / columns)", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 5, 2, 43, false)] }], base);
    const band = r.runs[0].bands[0];
    expect(band.columns).toBe(10); // floor(50 / 5)
    expect(band.rows).toBe(5); // ceil(43 / 10)
    expect(band.slotsAvailable).toBe(50);
    expect(band.blankSlots).toBe(7); // real physical loss, not a waste %
    expect(r.runs[0].feedLengthIn).toBeCloseTo(10, 10); // 5 rows x 2in
  });

  it("gutters default to ZERO and stay explicit + overrideable", () => {
    expect(DEFAULT_HORIZONTAL_GUTTER_IN).toBe(0);
    expect(DEFAULT_VERTICAL_GUTTER_IN).toBe(0);
    const zero = computeNesting([{ key: "r", items: [rect("a", 5, 2, 20, false)] }], base);
    expect(zero.runs[0].bands[0].columns).toBe(10);
    expect(zero.runs[0].feedLengthIn).toBeCloseTo(4, 10);

    const gutter = computeNesting(
      [{ key: "r", items: [rect("a", 5, 2, 20, false)] }],
      { ...base, horizontalGutterIn: 0.25, verticalGutterIn: 0.5 },
    );
    // floor((50 + 0.25) / 5.25) = 9 cols -> ceil(20/9) = 3 rows
    expect(gutter.runs[0].bands[0].columns).toBe(9);
    expect(gutter.runs[0].bands[0].rows).toBe(3);
    expect(gutter.runs[0].feedLengthIn).toBeCloseTo(3 * 2 + 2 * 0.5, 10);
  });

  it("margins shrink the placement window, not the media", () => {
    const r = computeNesting(
      [{ key: "r", items: [rect("a", 5, 2, 20, false)] }],
      { ...base, leftMarginIn: 1, rightMarginIn: 1, topMarginIn: 0.5, bottomMarginIn: 0.5 },
    );
    expect(r.runs[0].usableWidthIn).toBeCloseTo(48, 10);
    expect(r.runs[0].bands[0].columns).toBe(9); // floor(48/5)
    expect(r.runs[0].feedLengthIn).toBeCloseTo(0.5 + 3 * 2 + 0.5, 10);
    expect(r.runs[0].mediaWidthIn).toBe(54); // media is untouched by margins
  });

  it("materialFootprint is MEDIA width x feed — never the nest width, never a waste %", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 5, 2, 20, false)] }], base);
    const run = r.runs[0];
    expect(run.materialFootprintSqft).toBeCloseTo((54 * 4) / 144, 10);
    expect(run.ripWidthIn).toBeCloseTo(50, 10); // nest_bbox: 10 x 5.0
    expect(run.materialFootprintSqft).toBeGreaterThan(run.ripLayoutSqft);
    // unused web width is consumed for a standalone run
    expect(run.unusedAreaSqft).toBeCloseTo(run.materialFootprintSqft - run.usedShapeAreaSqft, 10);
  });

  it("carries NO waste-percentage field of any kind", () => {
    const src = readFileSync("app/lib/nesting-engine.server.ts", "utf8");
    for (const term of ["materialWastePct", "nestingWastePct", "wasteFactor", "wastePct", "wasteMultiplier"]) {
      expect(src.includes(term), term).toBe(false);
    }
  });
});

/* ================================================================== *
 * 2. ROTATION
 * ================================================================== */

describe("2. rotation", () => {
  const base: NestingPolicy = {
    mediaWidthIn: 54, printableWidthIn: 53.6, ripBoxConvention: "nest_bbox",
    source: "test", classification: "TEST",
  };

  it("is permitted by DEFAULT and picks the smaller feed", () => {
    expect(DEFAULT_ALLOW_ROTATION).toBe(true);
    // 100ml Tall side, 6.3 x 3.15, qty 1010 on a 53.6in window:
    //   normal   floor(53.6/6.3)=8 cols  x ceil(1010/8)=127 rows x 3.15 = 400.05in
    //   rotated  floor(53.6/3.15)=17 cols x ceil(1010/17)=60 rows x 6.3  = 378.00in
    const r = computeNesting([{ key: "r", items: [rect("a", 6.3, 3.15, 1010)] }], base);
    const band = r.runs[0].bands[0];
    expect(band.rows * band.placedHeightIn).toBeCloseTo(r.runs[0].feedLengthIn, 10);
    expect(band.rotated).toBe(true);
    expect(band.columns).toBe(17);
    expect(band.rows).toBe(60);
    expect(r.runs[0].feedLengthIn).toBeCloseTo(378, 10);
    const normalFeed = Math.ceil(1010 / Math.floor(53.6 / 6.3)) * 3.15;
    expect(r.runs[0].feedLengthIn).toBeLessThan(normalFeed);
  });

  it("ties resolve UNROTATED, deterministically", () => {
    const r = computeNesting([{ key: "r", items: [rect("sq", 2, 2, 35)] }], base);
    expect(r.runs[0].bands[0].rotated).toBe(false);
    expect(r.runs[0].bands[0].orientation).toBe("normal");
  });

  it("an adapter can disable rotation per item", () => {
    const on = computeNesting([{ key: "r", items: [rect("a", 6.3, 3.15, 1010, true)] }], base);
    const off = computeNesting([{ key: "r", items: [rect("a", 6.3, 3.15, 1010, false)] }], base);
    expect(on.runs[0].bands[0].rotated).toBe(true);
    expect(off.runs[0].bands[0].rotated).toBe(false);
    expect(on.runs[0].feedLengthIn).toBeCloseTo(378, 10);
    expect(off.runs[0].feedLengthIn).toBeCloseTo(400.05, 10);
    expect(on.runs[0].feedLengthIn).toBeLessThan(off.runs[0].feedLengthIn);
  });

  it("a policy can disable rotation for the whole job", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 6.3, 3.15, 1010, true)] }], { ...base, allowRotation: false });
    expect(r.runs[0].bands[0].rotated).toBe(false);
    expect(r.runs[0].feedLengthIn).toBeCloseTo(400.05, 10);
  });
});

/* ================================================================== *
 * 3. BLOCKERS — a missing width never falls back
 * ================================================================== */

describe("3. blockers", () => {
  it("no placement width -> MISSING_PRINTABLE_WIDTH and ripLayoutSqft null", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 5, 2, 10)] }], {
      mediaWidthIn: 54, printableWidthIn: 0, ripBoxConvention: "nest_bbox", source: "t", classification: "T",
    });
    expect(r.ok).toBe(false);
    expect(r.ripLayoutSqft).toBeNull();
    expect(r.blockers.join(" ")).toContain(NESTING_BLOCKERS.missingPrintableWidth);
    expect(r.blockers.join(" ")).not.toContain(NESTING_BLOCKERS.itemTooWide);
  });

  it("no media width -> MISSING_MEDIA_WIDTH", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 5, 2, 10)] }], {
      mediaWidthIn: 0, printableWidthIn: 50, ripBoxConvention: "nest_bbox", source: "t", classification: "T",
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join(" ")).toContain(NESTING_BLOCKERS.missingMediaWidth);
  });

  it("an item wider than the window in BOTH orientations blocks", () => {
    const r = computeNesting([{ key: "r", items: [rect("huge", 60, 60, 1)] }], {
      mediaWidthIn: 54, printableWidthIn: 52.4, ripBoxConvention: "nest_bbox", source: "t", classification: "T",
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join(" ")).toContain(NESTING_BLOCKERS.itemTooWide);
  });

  it("an unlisted Roland roll blocks rather than extrapolating a width", () => {
    const r = resolveNestingPolicy({ machineKey: ROLAND, loadedMediaWidthIn: 42 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.blocker).toBe(NESTING_BLOCKERS.missingPrintableWidth);
  });

  it("an unknown machine blocks", () => {
    const r = resolveNestingPolicy({ machineKey: "unknown-press", loadedMediaWidthIn: 54 });
    expect(r.ok).toBe(false);
  });
});

/* ================================================================== *
 * 4. PER-MACHINE WIDTH + RIP CONVENTION POLICY
 * ================================================================== */

describe("4. machine width and RIP convention policy", () => {
  it("Mimaki: placement = min(loadedMedia, 53.6), convention nest_bbox", () => {
    const m = MACHINE_NESTING_POLICIES[MIMAKI];
    expect(m.machineMaxWidthIn).toBe(53.6);
    expect(m.ripBoxConvention).toBe("nest_bbox");
    expect(m.classification).toBe("OWNER_APPROVED_PROVISIONAL");
    expect(policyFor(MIMAKI, 54).printableWidthIn).toBeCloseTo(53.6, 10);
    expect(policyFor(MIMAKI, 50).printableWidthIn).toBeCloseTo(50.0, 10);
    // states its own limits rather than claiming supplier/RIP verification
    expect(m.source).toMatch(/Not supplier- or RIP-verified/);
  });

  it("Roland: 52.9 is the MACHINE MAX, not every job's swept width", () => {
    const m = MACHINE_NESTING_POLICIES[ROLAND];
    expect(m.machineMaxWidthIn).toBe(52.9);
    expect(m.ripBoxConvention).toBe("swept_width");
    expect(m.classification).toBe("PROVISIONAL_EMPIRICAL");
    expect(policyFor(ROLAND, 54).printableWidthIn).toBeCloseTo(52.4, 10);
    expect(policyFor(ROLAND, 50).printableWidthIn).toBeCloseTo(49.1, 10);
    expect(policyFor(ROLAND, 54).sweptWidthIn).toBeCloseTo(52.4, 10);
  });

  it("an ACTUAL captured RIP swept width beats the operational default", () => {
    const p = policyFor(ROLAND, 54, 49.1043);
    expect(p.printableWidthIn).toBeCloseTo(49.1043, 10);
    expect(p.sweptWidthIn).toBeCloseTo(49.1043, 10);
    expect(p.classification).toBe("HISTORICAL_ACTUAL_RIP");
  });

  it("media / printable / rip widths stay THREE distinct fields", () => {
    const r = computeNesting([{ key: "r", items: [rect("a", 3.989, 5, 130)] }], policyFor(MIMAKI, 54));
    const run = r.runs[0];
    expect(run.mediaWidthIn).toBe(54);
    expect(run.printableWidthIn).toBeCloseTo(53.6, 10);
    expect(run.ripWidthIn).toBeCloseTo(13 * 3.989, 10); // nest, not media, not printable
    expect(new Set([run.mediaWidthIn, run.printableWidthIn, run.ripWidthIn]).size).toBe(3);
  });

  it("the two conventions produce DIFFERENT rip widths from one layout", () => {
    const items = [rect("a", 3.989, 5, 130)];
    const nest = computeNesting([{ key: "r", items }], { ...policyFor(MIMAKI, 54), ripBoxConvention: "nest_bbox" });
    const swept = computeNesting([{ key: "r", items }], { ...policyFor(MIMAKI, 54), ripBoxConvention: "swept_width" });
    expect(nest.runs[0].ripWidthIn).toBeCloseTo(51.857, 6);
    expect(swept.runs[0].ripWidthIn).toBeCloseTo(53.6, 10);
    expect(nest.runs[0].feedLengthIn).toBeCloseTo(swept.runs[0].feedLengthIn, 10); // feed is convention-free
  });
});

/* ================================================================== *
 * 5. VALIDATION CASE 1 — MIMAKI 130 PRODUCTION BENCHMARK
 * ================================================================== */

describe("5. VALIDATION 1 — Mimaki 130 x 3.989 x 5.000", () => {
  const OBSERVED_W = 51.855;
  const OBSERVED_FEED = 50;
  const OBSERVED_SQFT = (OBSERVED_W * OBSERVED_FEED) / 144; // 18.005

  const r = computeNesting([{ key: "bench", items: [rect("label", 3.989, 5, 130)] }], policyFor(MIMAKI, 54));
  const run = r.runs[0];
  const band = run.bands[0];

  it("derives 13 columns x 10 rows with zero gutters and zero margins", () => {
    expect(band.columns).toBe(13);
    expect(band.rows).toBe(10);
    expect(band.rotated).toBe(false);
    expect(band.blankSlots).toBe(0);
    expect(run.horizontalGutterIn).toBe(0);
    expect(run.verticalGutterIn).toBe(0);
    expect(run.usableWidthIn).toBeCloseTo(53.6, 10);
  });

  it("reproduces the observed 51.855 x 50 layout box", () => {
    expect(run.ripWidthIn).toBeCloseTo(51.857, 6); // 13 x 3.989
    expect(run.feedLengthIn).toBeCloseTo(50, 10);
    expect(run.ripLayoutSqft).toBeCloseTo((13 * 3.989 * 50) / 144, 10);
    const deltaPct = (run.ripLayoutSqft / OBSERVED_SQFT - 1) * 100;
    expect(Math.abs(deltaPct)).toBeLessThan(0.05); // +0.0301%
  });

  it("is INSENSITIVE to the remaining placement-width uncertainty", () => {
    for (const w of [52.4, 52.9, 53.6]) {
      const alt = computeNesting([{ key: "b", items: [rect("l", 3.989, 5, 130)] }], {
        mediaWidthIn: 54, printableWidthIn: w, ripBoxConvention: "nest_bbox", source: "t", classification: "T",
      });
      expect(alt.runs[0].bands[0].columns, `${w}`).toBe(13);
      expect(alt.runs[0].feedLengthIn, `${w}`).toBeCloseTo(50, 10);
    }
    // a 50in roll genuinely changes the answer — the model is not width-blind.
    // 12 cols x 11 rows = 55.000in un-rotated; rotated 10 cols x 13 rows =
    // 51.857in wins, so the engine takes the shorter feed.
    const narrow = computeNesting([{ key: "b", items: [rect("l", 3.989, 5, 130)] }], policyFor(MIMAKI, 50));
    expect(narrow.runs[0].bands[0].rotated).toBe(true);
    expect(narrow.runs[0].bands[0].columns).toBe(10);
    expect(narrow.runs[0].feedLengthIn).toBeCloseTo(13 * 3.989, 10);
    expect(narrow.runs[0].feedLengthIn).toBeGreaterThan(50);
  });

  it("consumes the FULL 54in web for material, above the RIP box", () => {
    expect(run.materialFootprintSqft).toBeCloseTo((54 * 50) / 144, 10); // 18.75
    expect(run.materialFootprintSqft).toBeGreaterThan(run.ripLayoutSqft);
  });
});

/* ================================================================== *
 * 6. MULTIPLE PHYSICAL RUNS
 * ================================================================== */

describe("6. multiple physical runs", () => {
  const SIDE_LID: JarLabelSelection = { side: true, lid: true, tamper: false };
  const ALL: JarLabelSelection = { side: true, lid: true, tamper: true };

  it("side + lid = TWO runs; side + tamper share run 1, lid runs alone", () => {
    const two = jarPhysicalRuns("150ml", SIDE_LID, 35);
    expect(two.map((r) => r.key)).toEqual(["side-body-run", "lid-run"]);
    expect(two[0].items.map((i) => i.groupKey)).toEqual(["side"]);
    expect(two[1].items.map((i) => i.groupKey)).toEqual(["lid"]);

    const three = jarPhysicalRuns("150ml", ALL, 35);
    expect(three.map((r) => r.key)).toEqual(["side-body-run", "lid-run"]);
    expect(three[0].items.map((i) => i.groupKey)).toEqual(["side", "tamper"]);
    expect(three[1].items.map((i) => i.groupKey)).toEqual(["lid"]);
  });

  it("a lid-only job produces exactly one run", () => {
    const runs = jarPhysicalRuns("150ml", { side: false, lid: true, tamper: false }, 35);
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe("lid-run");
  });

  it("feeds are NEVER combined across runs — totals are sums", () => {
    const policy = policyFor(ROLAND, 54, 49.1043);
    const runs = jarPhysicalRuns("150ml", ALL, 35);
    const r = computeNesting(runs, policy);
    expect(r.runs).toHaveLength(2);
    expect(r.feedLengthIn).toBeCloseTo(r.runs[0].feedLengthIn + r.runs[1].feedLengthIn, 10);
    expect(r.ripLayoutSqft).toBeCloseTo(r.runs[0].ripLayoutSqft + r.runs[1].ripLayoutSqft, 10);
    expect(r.materialFootprintSqft).toBeCloseTo(r.runs[0].materialFootprintSqft + r.runs[1].materialFootprintSqft, 10);

    // proof it is NOT one continuous run: a single combined run of the same
    // items would report ONE feed, and each run keeps its own diagnostics
    const combined = computeNesting([{ key: "one", items: [...runs[0].items, ...runs[1].items] }], policy);
    expect(combined.runs).toHaveLength(1);
    expect(r.runs.every((x) => x.feedLengthIn < combined.runs[0].feedLengthIn)).toBe(true);
  });

  it("each run reports its own rows / columns / feed / material / rip / utilisation", () => {
    const r = computeNesting(jarPhysicalRuns("150ml", SIDE_LID, 35), policyFor(ROLAND, 54, 49.1043));
    for (const run of r.runs) {
      expect(run.rows).toBeGreaterThan(0);
      expect(run.columns).toBeGreaterThan(0);
      expect(run.feedLengthIn).toBeGreaterThan(0);
      expect(run.materialFootprintSqft).toBeGreaterThan(0);
      expect(run.ripLayoutSqft).toBeGreaterThan(0);
      expect(run.utilizationPct).toBeGreaterThan(0);
      expect(run.utilizationPct).toBeLessThanOrEqual(100);
    }
  });

  it("a per-run policy override is honoured (different media on the lid run)", () => {
    const runs = jarPhysicalRuns("150ml", SIDE_LID, 35);
    runs[1].policy = { mediaWidthIn: 50, printableWidthIn: 49.1, sweptWidthIn: 49.1 };
    const r = computeNesting(runs, policyFor(ROLAND, 54));
    expect(r.runs[0].mediaWidthIn).toBe(54);
    expect(r.runs[1].mediaWidthIn).toBe(50);
  });
});

/* ================================================================== *
 * 7. VALIDATION CASE 2 — ROLAND FLAME SOCIETY 150ml x 35
 * ================================================================== */

describe("7. VALIDATION 2 — Roland Flame Society 150ml, 35 sets, side+tamper / lid", () => {
  const ALL: JarLabelSelection = { side: true, lid: true, tamper: true };
  const ACTUAL_SWEPT = 49.1043;
  const HISTORICAL_RIP_SQFT = 8.9175; // 49.1043 x 26.1508
  const HISTORICAL_INKABLE_SQFT = 7.2144;

  const { areas, nesting } = jarNestingAreas({
    size: "150ml", selection: ALL, productionQty: 35,
    machineKey: ROLAND, loadedMediaWidthIn: 54, actualSweptWidthIn: ACTUAL_SWEPT,
  });
  const run1 = nesting!.runs[0];
  const run2 = nesting!.runs[1];

  it("reproduces the historical INKABLE area exactly — proving the part mix", () => {
    // side + lid(circle) + tamper = 29.68216 sq in per set
    expect(areas.inkableArtworkSqft).toBeCloseTo(HISTORICAL_INKABLE_SQFT, 4);
    expect(inkableArtworkSqInPerSet("150ml", ALL) * 35).toBeCloseTo(HISTORICAL_INKABLE_SQFT * 144, 2);
  });

  it("run 1 = side + tamper", () => {
    expect(run1.key).toBe("side-body-run");
    expect(run1.bands.map((b) => b.groupKey)).toEqual(["side", "tamper"]);
    expect(run1.bands[0].columns).toBe(6); // floor(49.1043 / 7.125)
    expect(run1.bands[0].rows).toBe(6);
    expect(run1.bands[1].columns).toBe(6);
    expect(run1.bands[1].rows).toBe(6);
    expect(run1.feedLengthIn).toBeCloseTo(6 * 3.125 + 6 * 0.6, 10); // 22.35
  });

  it("run 2 = lid, on its own feed", () => {
    expect(run2.key).toBe("lid-run");
    expect(run2.bands[0].shapeType).toBe("circle_bbox");
    expect(run2.bands[0].placedWidthIn).toBeCloseTo(2.0, 10); // diameter bbox
    expect(run2.bands[0].columns).toBe(24); // floor(49.1043 / 2.0)
    expect(run2.bands[0].rows).toBe(2);
    expect(run2.feedLengthIn).toBeCloseTo(4.0, 10);
  });

  it("the lid nests as a bounding box but its SHAPE area stays the circle", () => {
    const band = run2.bands[0];
    expect(band.boundingItemAreaSqIn).toBeCloseTo(35 * 2.0 * 2.0, 10); // 140
    expect(band.usedShapeAreaSqIn).toBeCloseTo(35 * Math.PI * 1 * 1, 10); // 109.956
    expect(band.usedShapeAreaSqIn).toBeLessThan(band.boundingItemAreaSqIn);
  });

  it("total RIP layout vs the historical 8.9175 sqft — DELTA REPORTED, NOT FORCED", () => {
    const total = areas.ripLayoutSqft!;
    expect(total).toBeCloseTo(run1.ripLayoutSqft + run2.ripLayoutSqft, 10);
    expect(total).toBeCloseTo((49.1043 * 26.35) / 144, 8); // 8.9854049
    const deltaPct = (total / HISTORICAL_RIP_SQFT - 1) * 100;
    expect(deltaPct).toBeGreaterThan(0);
    expect(deltaPct).toBeLessThan(1.5); // measured +0.761%
  });

  it("material footprint uses the loaded 54in web across both runs", () => {
    const feed = run1.feedLengthIn + run2.feedLengthIn; // 26.35
    expect(areas.materialFootprintSqft).toBeCloseTo((54 * feed) / 144, 8);
    expect(areas.materialFootprintSqft).toBeGreaterThan(areas.ripLayoutSqft!);
  });

  it("the basis string names the runs and never claims to be a proxy", () => {
    expect(areas.ripLayoutBasis).toContain("side-body-run");
    expect(areas.ripLayoutBasis).toContain("lid-run");
    expect(areas.ripLayoutBasis).toContain("swept_width");
    expect(/proxy/i.test(areas.ripLayoutBasis)).toBe(false);
  });
});

/* ================================================================== *
 * 8. 555-JOB ROLAND PRODUCTION REPLAY
 * ================================================================== */

describe("8. Roland production replay — 555 accepted jobs", () => {
  type Row = { printer: string; copies: number; pw: number; ph: number; ax: number; ay: number };
  const rows: Row[] = (() => {
    const txt = readFileSync("analysis-output/roland/roland-cleaned-records.csv", "utf8").trim();
    const [head, ...lines] = txt.split(/\r?\n/);
    const H = head.split(",");
    const idx = (n: string) => H.indexOf(n);
    return lines
      .map((l) => l.split(","))
      .map((c) => ({
        printer: c[idx("printer")],
        copies: Number(c[idx("copies")]),
        pw: Number(c[idx("pageX_in")]),
        ph: Number(c[idx("pageY_in")]),
        ax: Number(c[idx("areaX_in")]),
        ay: Number(c[idx("areaY_in")]),
      }))
      .filter((r) => r.pw > 0 && r.ph > 0 && r.ax > 0 && r.ay > 0 && r.copies > 0);
  })();

  it("loads the tracked production evidence", () => {
    expect(rows.length).toBe(555);
  });

  it("reproduces the observed FEED on >=90% of real jobs within 5%", () => {
    let within5 = 0;
    let within0p5 = 0;
    for (const row of rows) {
      const r = computeNesting([{ key: "j", items: [rect("item", row.pw, row.ph, row.copies)] }], {
        mediaWidthIn: row.ax,
        printableWidthIn: row.ax, // actual per-job RIP Print Area_X
        sweptWidthIn: row.ax,
        ripBoxConvention: "swept_width",
        source: "historical actual", classification: "HISTORICAL_ACTUAL_RIP",
      });
      if (!r.ok) continue;
      const rel = Math.abs(r.runs[0].feedLengthIn - row.ay) / row.ay;
      if (rel <= 0.05) within5++;
      if (rel <= 0.005) within0p5++;
    }
    const pct5 = (within5 / rows.length) * 100;
    const pct05 = (within0p5 / rows.length) * 100;
    // eslint-disable-next-line no-console
    console.log(`[2B replay] feed within 5%: ${within5}/${rows.length} (${pct5.toFixed(1)}%) | within 0.5%: ${within0p5} (${pct05.toFixed(1)}%)`);
    expect(pct5).toBeGreaterThanOrEqual(90);
  });

  it("rotation materially improves reproduction — it is not decorative", () => {
    const count = (allowRotation: boolean) => {
      let hit = 0;
      for (const row of rows) {
        const r = computeNesting([{ key: "j", items: [rect("item", row.pw, row.ph, row.copies)] }], {
          mediaWidthIn: row.ax, printableWidthIn: row.ax, sweptWidthIn: row.ax,
          allowRotation, ripBoxConvention: "swept_width", source: "h", classification: "H",
        });
        if (r.ok && Math.abs(r.runs[0].feedLengthIn - row.ay) / row.ay <= 0.05) hit++;
      }
      return hit;
    };
    const withRot = count(true);
    const withoutRot = count(false);
    // eslint-disable-next-line no-console
    console.log(`[2B replay] rotation on: ${withRot} | rotation off: ${withoutRot}`);
    expect(withRot).toBeGreaterThan(withoutRot);
  });
});

/* ================================================================== *
 * 9. ARCHITECTURE — one engine, many adapters, nothing live
 * ================================================================== */

describe("9. architecture and live safety", () => {
  const SRC = readFileSync("app/lib/nesting-engine.server.ts", "utf8");

  it("the nesting engine is pure — no imports, no db, no network, no money", () => {
    expect(SRC.match(/^import /gm)).toBeNull();
    for (const term of ["prisma", "PrismaClient", "fetch(", "process.env", "require(", "costPer", "unitCost", "sellingPrice", "marginPct", "USD"]) {
      expect(SRC.includes(term), term).toBe(false);
    }
    // no currency arithmetic of any kind
    expect(/$s*[0-9]/.test(SRC)).toBe(false);
  });

  it("the engine contains no jar/sticker/bag family constants", () => {
    const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // WORD boundaries — "lid" must not be matched inside INVALID_NESTING_ITEM
    for (const term of ["jar", "jars", "lid", "lids", "tamper", "Chiron", "Miron", "100ml", "150ml", "sticker", "pouch", "banner", "DTP"]) {
      expect(new RegExp(`\\b${term}\\b`, "i").test(code), term).toBe(false);
    }
  });

  it("a non-jar family nests through the SAME engine with no engine change", () => {
    // 4x5 sticker bags: 1000 bags, 3.989 x 5.000, Mimaki, 54in roll
    const bags = computeNesting([{ key: "bag-run", items: [rect("4x5-bag", 3.989, 5, 1000)] }], policyFor(MIMAKI, 54));
    expect(bags.ok).toBe(true);
    expect(bags.runs[0].bands[0].columns).toBe(13);
    expect(bags.runs[0].bands[0].rows).toBe(77);

    // a banner: one big item, rotation blocked by the adapter
    const banner = computeNesting(
      [{ key: "banner-run", items: [rect("banner-48x96", 48, 96, 4, false)] }],
      policyFor(ROLAND, 54),
    );
    expect(banner.ok).toBe(true);
    expect(banner.runs[0].bands[0].columns).toBe(1);
    expect(banner.runs[0].feedLengthIn).toBeCloseTo(384, 10);
  });

  it("no live pricing or storefront path imports the nesting engine", () => {
    for (const file of [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/lib/product-driven-costing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/lib/cost-calculator.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("nesting-engine"), file).toBe(false);
      expect(src.includes("true-cost-engine"), file).toBe(false);
      expect(src.includes("-cost-inputs"), file).toBe(false);
    }
  });

  it("true-cost-engine.server.ts was NOT modified by Patch 2B", () => {
    const engine = readFileSync("app/lib/true-cost-engine.server.ts", "utf8");
    expect(engine.includes("nesting-engine")).toBe(false);
    expect(engine.match(/^import /gm)).toHaveLength(1); // still only machine-calibration
    expect(engine.includes("TRUE_COST_ENGINE_VERSION = \"17D.2-true-cost-engine\"")).toBe(true);
  });

  it("versions are stamped", () => {
    expect(NESTING_ENGINE_VERSION).toBe("17D.3-nesting-engine");
    expect(JAR_DEFAULT_MEDIA_WIDTH_IN).toBe(54);
    expect(JAR_LABEL_GEOMETRY["150ml"].lid.diameterIn).toBe(2.0);
  });

  it("productionQty flows through unchanged — nesting never re-applies overage", () => {
    expect(productionQtyFor(1000)).toBe(1010);
    const r = jarNestingAreas({
      size: "100ml_wide", selection: { side: true, lid: true, tamper: false },
      productionQty: 1010, machineKey: MIMAKI, loadedMediaWidthIn: 54,
    });
    expect(r.nesting!.itemsPlaced).toBe(2020); // 1010 sides + 1010 lids, no uplift
  });
});
