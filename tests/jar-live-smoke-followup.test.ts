// 2026-10-05 — LIVE JAR CALCULATOR SMOKE FOLLOW-UP.
//
// The first production smoke test (Premium Jars, 100ml Tall Miron, 128,
// Side + Lid, Poseidon Matte, AUTO, CMYK) returned 430.0861 / 3.3600 with
// CUT_PATH_ESTIMATE_REQUIRED. That exact result was captured from the engine
// at HEAD 10036eb BEFORE any runtime change and is pinned here; the staff
// display fixes must leave every number untouched.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalViewOf, computeCanonicalJob, normalizeCanonicalInput } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { FINISHING_REASONS, bandCutPath } from "../app/lib/finishing-cost.server";
import { jarCutGeometry, JAR_APPLICATION_SECONDS_BY_SIZE, APPLICATION_LABOR_RATE_PER_HOUR } from "../app/lib/jar-cost-inputs.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { WEEDING_STANDARD } from "../app/lib/weeding-standard";

/* Production-shaped calibration rows (same as the 2D-4C1 control suite). */
const MEASURED: Record<string, { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const SHOP = "942075-2.myshopify.com";
const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`, shop: SHOP, ...identity,
  inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null, timeModel: "variable_only",
  measuredAt: new Date("2026-08-18T00:00:00Z"), effectiveFrom: new Date("2026-08-18T00:00:00Z"), effectiveTo: null,
  status: "approved", source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date("2026-08-18T00:00:00Z"),
  ...MEASURED[key],
}));
const db = {
  machineProfileCalibration: {
    findMany: async ({ where }: any) => ROWS.filter((row) => Object.entries(where).every(([field, value]) => field === "shop" ? row.shop === value : (row as any)[field] === value)),
  },
};
const FIXTURE = JSON.parse(readFileSync("tests/fixtures/jar-live-smoke-100ml-tall-2026-10-05.json", "utf8"));
const LIVE = FIXTURE.query as string;
const compute = (q: string) => computeCanonicalJob({ db, shop: SHOP }, normalizeCanonicalInput(new URLSearchParams(q))!);
// The live observation was captured at the then-provisional $8/hr machine recovery rate
// (owner standard since 2026-10-07: $5/hr). The capture comparisons run with the historical
// rate pinned explicitly so every non-machine line is still verified unchanged.
const HISTORICAL_MACHINE_RATE = 8;
const computeAt8 = (q: string) => computeCanonicalJob({ db, shop: SHOP }, { ...normalizeCanonicalInput(new URLSearchParams(q))!, equipmentRatePerHour: HISTORICAL_MACHINE_RATE });
const line = (r: Awaited<ReturnType<typeof compute>>, key: string) => r.trueCost.lines.filter((l) => l.key === key).reduce((t, l) => t + l.amount, 0);

describe("live smoke fixture — 100ml Tall Miron, 128, Side + Lid, AUTO, CMYK", () => {
  it("reproduces the live observation exactly (430.0861 / 3.3600, PROVISIONAL, CUT_PATH_ESTIMATE_REQUIRED)", async () => {
    const r = await computeAt8(LIVE);
    expect(r.status).toBe("PROVISIONAL");
    expect(r.totalCost).toBeCloseTo(430.0861, 4);
    expect(r.unitCost!).toBeCloseTo(3.36, 4);
    expect(r.reasons).toEqual(["CUT_PATH_ESTIMATE_REQUIRED"]);
    expect(r.blockers).toEqual([]);
    expect(FIXTURE.liveObservation.totalCost).toBe(430.0861);
  });

  it("every line and total equals the pre-change capture", async () => {
    const r = await computeAt8(LIVE);
    expect(r.totalCost).toBe(FIXTURE.totalCost);
    expect(r.unitCost).toBe(FIXTURE.unitCost);
    expect(r.trueCost.lines.map((l) => ({ key: l.key, amount: l.amount }))).toEqual(FIXTURE.lines);
    expect(r.trueCost.totals).toEqual(FIXTURE.totals);
  });

  it("piece counts are unchanged: 256 application events, 128 physical items, 2 per item, 2 weeding pages", async () => {
    const d = (await computeAt8(LIVE)).diagnostics;
    expect(d.applicationEvents).toBe(256);
    expect(d.physicalItems).toBe(128);
    expect(d.applicationsPerItem).toBe(2);
    expect(d.weedingPages).toBe(2);
    expect(d.artSetupEvents).toBe(1);
    expect(d.printSetupEvents).toBe(1);
    for (const key of ["applicationEvents", "physicalItems", "applicationsPerItem", "weedingPages", "mediaConsumedSqft", "ripLayoutSqft", "inkableArtworkSqft", "cutPathIn", "cutMinutes", "machineMinutes"]) {
      expect((d as any)[key], key).toEqual(FIXTURE.diagnostics[key]);
    }
  });

  it("owner-confirmation geometry warning remains intact on the live product", async () => {
    const d = (await computeAt8(LIVE)).diagnostics;
    expect(d.productSpec).toMatchObject({
      productKey: "miron/100ml_tall",
      authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION",
      ownerConfirmationRequired: true,
      standard: { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 } },
    });
    expect(d.productSpec!.referenceConflicts).toEqual(["side label width 6.125 in (current quote uses 6.3 in)", "side label height 3.125 in (current quote uses 3.15 in)"]);
  });
});

describe("ISSUE 1 — CUT_PATH_ESTIMATE_REQUIRED on a fixed Side + Lid jar", () => {
  it("the side rectangle has an exact derived cutline (not flagged); the lid contour is flagged for RATE, not length", () => {
    const geometry = jarCutGeometry("100ml_tall") as any;
    expect(geometry.side).toMatchObject({ model: "separated_rectangle", cutWidthIn: 6.3 - 0.125, cutHeightIn: 3.15 - 0.125 });
    expect(geometry.lid).toMatchObject({ model: "contour", cutDiameterIn: 1.75 - 0.125 });
    const sideBand: any = { groupKey: "side", shapeType: "rect", itemsPlaced: 130, columns: 1, rows: 130, placedWidthIn: 6.3, placedHeightIn: 3.15, bandFeedIn: 0, nestWidthIn: 0 };
    const lidBand: any = { groupKey: "lid", shapeType: "circle_bbox", itemsPlaced: 130, columns: 1, rows: 130, placedWidthIn: 1.75, placedHeightIn: 1.75, bandFeedIn: 0, nestWidthIn: 0 };
    const side = bandCutPath(sideBand, geometry.side);
    const lid = bandCutPath(lidBand, geometry.lid);
    expect(side.estimateRequired).toBe(false);
    expect(side.cutlineKnown).toBe(true);
    expect(side.pathIn).toBeCloseTo(130 * 2 * (6.175 + 3.025), 6);
    expect(lid.cutlineKnown).toBe(true);
    expect(lid.estimateRequired).toBe(true);
    expect(lid.estimateReason).toMatch(/LENGTH is exact geometry, the RATE is borrowed/);
    expect(lid.pathIn).toBeCloseTo(130 * Math.PI * 1.625, 6);
  });

  it("the live job's provisional state is explained (length exact, rate borrowed) and remains PROVISIONAL", async () => {
    const r = await computeAt8(LIVE);
    expect(r.status).toBe("PROVISIONAL");
    expect(r.diagnostics.cutPathBasis).toMatchObject({ lengthExact: true, rateExact: false });
    expect(r.diagnostics.cutPathBasis!.bands.map((b) => b.group)).toEqual(["lid"]);
    expect(r.diagnostics.cutPathBasis!.provisionalReason).toMatch(/cutter SPEED for a circular contour has never been benchmarked/);
    expect(FINISHING_REASONS.cutPathEstimateRequired).toBe("CUT_PATH_ESTIMATE_REQUIRED");
  });

  it("a Side Only jar job carries no cut-path estimate flag (so the flag is lid-specific, not jar-wide)", async () => {
    const r = await computeAt8(LIVE.replace("&pjarlid=1", "").replace("pjarset=side_lid", "pjarset=side_only"));
    expect(r.reasons).not.toContain("CUT_PATH_ESTIMATE_REQUIRED");
    expect(r.reasons).toEqual([]);
    expect(r.diagnostics.cutPathBasis).toMatchObject({ lengthExact: true, rateExact: true, provisionalReason: null });
    // Still PROVISIONAL — but for OTHER pre-existing reasons (operator attention
    // 10% is OWNER_APPROVED_PROVISIONAL; inbound freight basis is a provisional
    // supplier pallet estimate). So removing the cut-path flag alone could never
    // make a jar job FINAL; this is documented, not changed.
    expect(r.status).toBe("PROVISIONAL");
    const provisionalKeys = r.trueCost.lines.filter((l: any) => l.provisional).map((l) => l.key).sort();
    expect(provisionalKeys).toEqual(["inbound_freight", "run_labor"]);
  });
});

describe("ISSUE 2/3 — application authority reconciliation", () => {
  it("canonical application = 128 x (12 s + 10 s) / 3600 x $20 = 15.6444 (owner per-size timings)", async () => {
    const r = await computeAt8(LIVE);
    expect(line(r, "application")).toBeCloseTo(15.644444, 5);
    expect(JAR_APPLICATION_SECONDS_BY_SIZE["100ml_tall"]).toEqual({ side: 12, lid: 10, tamper: 12 });
    expect(APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    const ab = r.diagnostics.applicationBreakdown!;
    expect(ab.standardLabel).toBe("Jar application (owner per-size timings)");
    expect(ab.pieces.map((p) => [p.piece, p.secondsPerLabel, p.labels])).toEqual([["side", 12, 128], ["lid", 10, 128]]);
    expect(ab.pieces[0].cost).toBeCloseTo(128 * (12 / 3600) * 20, 9);
    expect(ab.pieces[1].cost).toBeCloseTo(128 * (10 / 3600) * 20, 9);
    expect(ab.totalLabels).toBe(256);
    expect(ab.totalCost).toBeCloseTo(line(r, "application"), 9);
  });

  it("the legacy $0.20/label figure is NOT the canonical value and does not enter the canonical cost", async () => {
    const r = await computeAt8(LIVE);
    const legacy = OWNER_STANDARDS.jarApplicationPerLabel.value * 256; // 51.20 — legacy 14C.2 diagnostics only
    expect(legacy).toBeCloseTo(51.2, 9);
    expect(line(r, "application")).not.toBeCloseTo(legacy, 2);
    expect(r.trueCost.lines.some((l) => Math.abs(l.amount - legacy) < 1e-6)).toBe(false);
    const canonicalSrc = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(canonicalSrc).not.toMatch(/jarApplicationPerLabel|jarApplicationPer\b/);
  });

  it("the legacy 4x5 bag rate ($0.078125) never enters a jar cost", async () => {
    const r = await computeAt8(LIVE);
    const bagRate = OWNER_STANDARDS.bagApplicationPerLabel4x5.value;
    expect(bagRate).toBeCloseTo(0.078125, 9);
    expect(r.trueCost.lines.some((l) => Math.abs(l.amount - bagRate * 256) < 1e-6)).toBe(false);
    expect(readFileSync("app/lib/canonical-calculator.server.ts", "utf8")).not.toMatch(/bagApplicationPerLabel4x5/);
    expect(readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8")).not.toMatch(/bagApplicationPerLabel4x5|0\.078125/);
  });

  it("the canonical view and snapshot JSON carry the application breakdown and the cut-path basis", async () => {
    const view = canonicalViewOf(await computeAt8(LIVE));
    const stored = JSON.parse(JSON.stringify(view)).diagnostics;
    expect(stored.applicationBreakdown.totalLabels).toBe(256);
    expect(stored.cutPathBasis.lengthExact).toBe(true);
    // older snapshots without these fields are tolerated by the UI guards
    const old = JSON.parse(JSON.stringify({ diagnostics: { weedingPages: 2 } }));
    expect(old.diagnostics.applicationBreakdown).toBeUndefined();
    expect(old.diagnostics.cutPathBasis).toBeUndefined();
  });
});

describe("ISSUE 2/4/5 — staff-facing UI copy", () => {
  const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

  it("the jar UI never shows a '4x5 application' standard as the jar's", () => {
    expect(src).not.toContain("<b>4x5 application:</b>");
    expect(src).not.toMatch(/4x5 application:<\/b>/);
    // the legacy line survives only as a labelled legacy fallback when no canonical breakdown exists
    expect(src).toContain("Legacy 4x5 bag application (legacy 14C.2 path only)");
    expect(src).toContain("if (canonicalAuthoritative && ab && ab.pieces.length)");
  });

  it("context-aware application label comes from the canonical breakdown", () => {
    expect(src).toContain("<b>Application standard:</b> {ab.standardLabel}");
    expect(src).toContain("APPLICATION BREAKDOWN");
    expect(src).toContain("Total application");
  });

  it("the legacy application line is marked diagnostic-only without changing its formula", () => {
    expect(src).toContain("legacy diagnostic only, not used by canonical quote");
    const legacy = readFileSync("app/lib/product-driven-costing.server.ts", "utf8");
    expect(legacy).toContain("amount: OWNER_LABOR.jarApplicationPer * totalPieces");
  });

  it("the provisional cutting explanation is rendered", () => {
    expect(src).toContain("WHY CUTTING IS PROVISIONAL");
  });
});

describe("freezes", () => {
  it("weeding numbers unchanged", () => {
    expect(WEEDING_STANDARD.laborRatePerHour).toBe(20);
    expect(WEEDING_STANDARD.pagesPerHour).toBe(15);
    expect(WEEDING_STANDARD.pageLengthIn).toBe(54);
    expect(WEEDING_STANDARD.costPerPage).toBeCloseTo(1.333333, 6);
  });

  it("3x3 sticker control = 79.617252 at the $5/hr owner machine rate (84.143290 at the historical $8)", async () => {
    const q = "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=0";
    const r = await compute(q);
    expect(r.totalCost).toBeCloseTo(79.617252, 5);
    expect((await computeAt8(q)).totalCost).toBeCloseTo(84.14329, 5);
    // the live jar observation at the approved $5/hr: only the machine line moves
    const live5 = await compute(LIVE);
    expect(live5.totalCost).toBeCloseTo(428.5026, 4);
    expect(live5.unitCost!).toBeCloseTo(3.3477, 4);
    const live8 = await computeAt8(LIVE);
    const moved = live8.trueCost.lines.filter((l8) => Math.abs(l8.amount - (live5.trueCost.lines.find((l5) => l5.key === l8.key)?.amount ?? 0)) > 1e-9).map((l) => l.key);
    expect(moved).toEqual(["machine"]);
    expect(r.diagnostics.applicationBreakdown).toBeNull();
  });
});
