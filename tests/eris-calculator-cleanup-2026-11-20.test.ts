// 2026-11-20 — Eris Cost Calculator PRESENTATION + classification cleanup.
//
// Nothing about the Eris cost data changes here ($2.28 / $3.22 at the 2,500
// supplier tier, freight pending, 1% overage). What changes is how an
// incomplete product is SHOWN:
//   1. unknown outbound packout never reads "0 box(es)";
//   2. missing inputs are named rows (Inbound freight / Outbound packout /
//      Label geometry / Application timing), not "Other production data";
//   3. with no label geometry, no ink / nesting / label-area failure is
//      reported — ONE geometry blocker instead;
//   4. Eris belongs to no jar family: it is listed under its own brand group;
//   5. the state is COST DATA PARTIAL (informational), not an error.
//
// BEFORE / AFTER. tests/fixtures/calculator-baseline-160b662.json was captured
// by running the SAME case matrix below against an untouched extract of commit
// 160b662 (the code before this cleanup). Every existing product is compared
// with it line by line; the only differences allowed are listed in section 8.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { ACTIVE_JAR_PROFILES, COST_ONLY_JAR_PICKER_FAMILIES, COST_ONLY_JAR_PICKER_GROUP, COST_ONLY_JAR_PICKER_GROUP_LABEL, COST_ONLY_JAR_PROFILES } from "../app/lib/jar-active-scope";
import { JAR_LABEL_GEOMETRY, jarGeometryPendingNote } from "../app/lib/jar-label-geometry";
import { ERIS_JAR_SUPPLIER_COST, JAR_APPLICATION_SECONDS_BY_SIZE, JAR_UNITS_PER_BOX, costOnlyJarCalculatorOptions, costOnlyJarSummary, productionQtyFor, resolveJarBlankCost } from "../app/lib/jar-cost-inputs.server";
import { canonicalComponentRows } from "../app/lib/canonical-calculator-shared";
import { resolveOwnerResult, summarizeCalculatorBlockers } from "../app/lib/calculator-owner-view";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { isCostedAuthority, resolveCostAuthority } from "../app/lib/canonical-quote-authority.server";
import { computeTrueJobCost } from "../app/lib/true-cost-engine.server";
import { CostOnlyJarPanel } from "../app/components/CostOnlyJarPanel";

const CAL: ResolvedMachineInputs = {
  calibration: { id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x", mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100, measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null } as any,
  calibrationMessage: "approved", inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl, inkCostSource: "canonical purchasing rate",
};
/** A press with NO approved calibration and NO ink price — the worst case for "calculation failed" noise. */
const NO_CAL: ResolvedMachineInputs = { calibration: null, calibrationMessage: "no approved calibration", inkCostPerMl: null, inkCostSource: "none" } as any;
const MACHINE_QS = "pmachinekey=mimaki-ucjv300-130&pinkmode=cmyk&pripprofile=p&pqualitymode=q&presolution=r&ppassconfig=1x&pprinter=mimaki";

const run = (qs: string, machine: ResolvedMachineInputs = CAL) => {
  const input = normalizeCanonicalInput(new URLSearchParams(qs));
  expect(input, `did not normalise: ${qs}`).not.toBeNull();
  return assembleCanonicalJob(input!, machine);
};
const erisQs = (size: "eris_60ml" | "eris_120ml", qty: number, family = "premium-jars", extra = "") =>
  `pfamily=${family}&pjarmat=matte&pqty=${qty}&pjar=eris/${size}&pjarside=1&pjarlid=1&pcmykcoverage=40&pprinter=mimaki${extra}`;
const lineOf = (result: ReturnType<typeof run>, key: string) => result.trueCost.lines.find((line) => line.key === key)!;
const everythingShown = (result: ReturnType<typeof run>) => JSON.stringify({
  lines: result.trueCost.lines, blockers: result.blockers, reasons: result.reasons,
  rows: canonicalComponentRows({ totals: result.trueCost.totals, lines: result.trueCost.lines }),
  summary: summarizeCalculatorBlockers(result.blockers), costOnly: result.diagnostics.costOnlyJar,
});

/* ------------------------------------------------------------------ *
 * The before / after case matrix — IDENTICAL to the generator that
 * captured the fixture from 160b662.
 * ------------------------------------------------------------------ */
type Case = { id: string; qs: string; ladder?: { brand: string; sizeKey: string; quantity: number } };
function baselineCases(): Case[] {
  const cases: Case[] = [];
  for (const p of ACTIVE_JAR_PROFILES) for (const qty of [50, 128, 500, 2500]) for (const tamper of qty === 500 ? [false, true] : [false]) {
    cases.push({
      id: `jar ${p.key} x${qty}${tamper ? " +band" : ""}`,
      qs: `pfamily=${p.uiFamily}&pjarmat=matte&pqty=${qty}&pjar=${p.key}${p.brand === "standard" ? "&pjarvariant=clear" : ""}&pjarside=1&pjarlid=1${tamper ? "&pjartamper=1" : ""}&pcmykcoverage=40&pprinter=mimaki`,
      ladder: { brand: p.brand, sizeKey: p.size, quantity: qty },
    });
  }
  cases.push({ id: "jar not offered chiron/50ml", qs: "pfamily=premium-jars&pjarmat=matte&pqty=500&pjar=chiron/50ml&pjarside=1&pjarlid=1&pprinter=mimaki" });
  cases.push({ id: "jar unknown size miron/60ml", qs: "pfamily=premium-jars&pjarmat=matte&pqty=500&pjar=miron/60ml&pjarside=1&pjarlid=1&pprinter=mimaki" });
  cases.push({ id: "jar no labels", qs: "pfamily=premium-jars&pjarmat=matte&pqty=500&pjar=miron/150ml&pprinter=mimaki" });
  cases.push({ id: "jar no media", qs: "pfamily=premium-jars&pqty=500&pjar=miron/150ml&pjarside=1&pjarlid=1&pprinter=mimaki" });
  cases.push({ id: "jar wrong family", qs: "pfamily=standard-jars&pjarmat=matte&pqty=500&pjar=miron/150ml&pjarside=1&pjarlid=1&pprinter=mimaki" });
  cases.push({ id: "jar no profile", qs: "pfamily=premium-jars&pjarmat=matte&pqty=500&pjarside=1&pjarlid=1&pprinter=mimaki" });
  for (const qty of [500, 1000, 5000]) {
    cases.push({ id: `sticker bag x${qty}`, qs: `pfamily=sticker-bags&pbagmat=matte&pqty=${qty}&pbagsides=2&pdesigns=1&${MACHINE_QS}` });
    cases.push({ id: `stock bag x${qty}`, qs: `pfamily=sticker-bags&pbagmat=matte&pstockbag=1&pqty=${qty}&pbagsides=2&${MACHINE_QS}` });
    cases.push({ id: `split bag x${qty}`, qs: `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pbagsides=1&pdesigns=1&${MACHINE_QS}` });
    cases.push({ id: `pound bag x${qty}`, qs: `pfamily=sticker-bags&pbagmat=matte&ppoundbag=1&pqty=${qty}&pbagsides=1&pdesigns=1&${MACHINE_QS}` });
    cases.push({ id: `labels x${qty}`, qs: `pfamily=stickers-labels&pllines=1&pl0qty=${qty}&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&${MACHINE_QS}` });
  }
  cases.push({ id: "labels two lines", qs: `pfamily=stickers-labels&pllines=2&pl0qty=500&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pl1qty=500&pl1w=3&pl1h=3&pl1cutw=2.875&pl1cuth=2.875&pl1mat=holographic&pl1art=A&${MACHINE_QS}` });
  cases.push({ id: "labels no size", qs: `pfamily=stickers-labels&pllines=1&pl0qty=100&pl0w=0&pl0h=0&pl0mat=matte&pl0art=A&${MACHINE_QS}` });
  for (const qty of [1, 5]) cases.push({ id: `banner x${qty}`, qs: `pfamily=banners&pqty=${qty}&pbannerw=36&pbannerh=60&pdesigns=1&${MACHINE_QS}` });
  cases.push({ id: "banner no size", qs: `pfamily=banners&pqty=1&pdesigns=1&${MACHINE_QS}` });
  return cases;
}
function baselineRecord(c: Case) {
  const input = normalizeCanonicalInput(new URLSearchParams(c.qs));
  if (!input) return { id: c.id, normalised: false };
  const r = assembleCanonicalJob(input, CAL);
  const authority = resolveCostAuthority({ canonicalFamilyKey: input.family, canonical: r, legacyJobCost: 123.45, quantity: input.quantity, freightTotal: 0 });
  return JSON.parse(JSON.stringify({
    id: c.id,
    normalised: true,
    status: r.status,
    unitCost: r.unitCost,
    totalCost: r.totalCost,
    blockers: r.blockers,
    reasons: r.reasons,
    totals: r.trueCost.totals,
    lines: r.trueCost.lines.map((l) => ({ key: l.key, category: l.category, label: l.label, amount: l.amount, formula: l.formula ?? null, blocker: l.blocker ?? null, provisional: l.provisional ?? null, basis: l.basis ?? null })),
    landedCost: r.diagnostics.landedCost ?? null,
    summary: summarizeCalculatorBlockers(r.blockers),
    authority: { costed: authority.costed, unitCost: authority.unitCost, completeCost: authority.completeCost, manufacturingJobCost: authority.manufacturingJobCost },
    ladder: c.ladder ? resolveJarOwnerLadder(c.ladder) : null,
  }));
}
const BASELINE: { capturedFrom: string; records: any[] } = JSON.parse(readFileSync("tests/fixtures/calculator-baseline-160b662.json", "utf8"));

/* ================================================================== */
describe("1. unknown outbound packout never displays \"0 box\"", () => {
  it("Eris: the packout line is PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED, with no box count, rate or zero", () => {
    for (const size of ["eris_60ml", "eris_120ml"] as const) for (const qty of [50, 500, 2500]) {
      const result = run(erisQs(size, qty));
      const packout = lineOf(result, "packout");
      expect(packout.label).toBe("PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED");
      expect(packout.pending).toBe("PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED");
      expect(packout.formula).toBeUndefined();
      expect(packout.blocker).toContain("OUTBOUND_PACKOUT_PENDING");
      expect(`${packout.label} ${packout.note} ${packout.blocker}`).not.toMatch(/\d+\s*box|\/box|box\(es\)/i);
      // nothing the calculator shows for the job mentions a box count of zero
      expect(everythingShown(result)).not.toMatch(/0 box|@ 0\/box|box\(es\)/);
      const row = canonicalComponentRows({ totals: result.trueCost.totals, lines: result.trueCost.lines }).find((r) => r.key === "packout")!;
      expect(row.pending).toBe("PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED");
    }
  });

  it("no jars-per-box was invented for Eris", () => {
    expect(Object.keys(JAR_UNITS_PER_BOX)).toEqual(["50ml", "100ml_tall", "100ml_wide", "150ml", "250ml", "3oz", "4oz", "ceres_50ml", "ceres_100ml"]);
  });

  it("the engine cannot emit a box count for a pending packout — blocking or not", () => {
    const base = {
      customerFinishedQty: 500, productionQty: 505, overagePct: 1,
      areas: { inkableArtworkSqft: 10, ripLayoutSqft: 12, materialFootprintSqft: 12, ripLayoutBasis: "test" },
      blank: { ok: true as const, unitCost: 1, label: "blank", source: "test" },
      material: { name: "media", costPerSqft: 1, source: "test" },
      calibration: CAL.calibration, calibrationMessage: "ok", inkCostPerMl: 0.1, inkCostSource: "test", coveragePct: 40, passCount: 1,
      application: { costPerFinishedUnit: 0.1 }, setup: { art: 1, print: 1, groups: 1 }, runLabor: { mode: "operator_attention" as const },
      equipmentRatePerHour: 5, freight: { perUnit: 0.1, basis: "TEST", provisional: false, source: "test" },
    };
    const blocking = computeTrueJobCost({ ...base, packout: { pending: "no box quantity", blocking: true } } as any);
    const nonBlocking = computeTrueJobCost({ ...base, packout: { pending: "no box standard", blocking: false } } as any);
    const known = computeTrueJobCost({ ...base, packout: { boxes: 5, unitsPerBox: 100, cost: 17.5 } } as any);
    for (const result of [blocking, nonBlocking]) {
      const line = result.lines.find((l) => l.key === "packout")!;
      expect(line.amount).toBe(0);
      expect(line.label).not.toMatch(/box\(es\)|\d/);
      expect(line.pending).toBeTruthy();
    }
    expect(blocking.status).toBe("DRAFT_ONLY");
    expect(blocking.unitCost).toBeNull();
    expect(nonBlocking.status).not.toBe("DRAFT_ONLY"); // unchanged behaviour for a family with no box standard
    expect(nonBlocking.totalCost).toBeCloseTo(known.totalCost - 17.5, 9);
    // a KNOWN packout is worded exactly as before
    expect(known.lines.find((l) => l.key === "packout")!.label).toBe("Packout — 5 box(es) @ 100/box");
    expect(known.lines.find((l) => l.key === "packout")!.pending).toBeUndefined();
  });

  it("other families with NO box standard (Split Bag, banner) stop reading \"0 box(es) @ 1/box\" — same $0, same status, still not blocking", () => {
    for (const id of ["split bag x500", "banner x1"]) {
      const before = BASELINE.records.find((r) => r.id === id)!;
      const after = run(baselineCases().find((c) => c.id === id)!.qs);
      expect(before.lines.find((l: any) => l.key === "packout").label).toBe("Packout — 0 box(es) @ 1/box");
      const packout = lineOf(after, "packout");
      expect(packout.label).toBe("PACKOUT PENDING — NO BOX STANDARD RECORDED");
      expect(packout.amount).toBe(0);
      expect(packout.blocker).toBeUndefined();
      expect(after.status).toBe(before.status);
      expect(after.unitCost).toBe(before.unitCost);
      expect(after.totalCost).toBe(before.totalCost);
      expect(after.reasons).toContain("PACKOUT_NOT_MODELED");
    }
  });
});

/* ================================================================== */
describe("2. missing inputs are named PENDING rows — never \"Other production data\", never a zero", () => {
  it("the blocker summary of an Eris job is exactly the four named rows", () => {
    for (const size of ["eris_60ml", "eris_120ml"] as const) {
      const summary = summarizeCalculatorBlockers(run(erisQs(size, 500)).blockers)!;
      expect(summary.items.slice().sort()).toEqual([
        "Application timing: PENDING REAL SHOP TIMING VALIDATION",
        "Inbound freight: PENDING",
        "Label geometry: PENDING",
        "Outbound packout: PENDING",
      ]);
      expect(summary.items.join(" ")).not.toMatch(/Other production data|Advanced diagnostics|more —/);
      expect(summary.codes.slice().sort()).toEqual(["APPLICATION_TIMING_PENDING", "LABEL_GEOMETRY_PENDING", "MISSING_FREIGHT_BASIS", "OUTBOUND_PACKOUT_PENDING"]);
    }
  });

  it("the result card lists them in the owner's order, with landed cost", () => {
    const result = run(erisQs("eris_60ml", 500));
    const owner = resolveOwnerResult({ family: "premium-jars", canonical: { status: result.status, totalCost: result.totalCost, unitCost: result.unitCost, blockers: result.blockers }, costOnlyJar: result.diagnostics.costOnlyJar, requestedRow: null, multiLine: null, marginRuleKey: null })!;
    expect(owner.reasons).toEqual([
      "Inbound freight: PENDING",
      "Landed unit cost: PENDING",
      "Label geometry: PENDING",
      "Application timing: PENDING REAL SHOP TIMING VALIDATION",
      "Outbound packout: PENDING",
    ]);
  });

  it("the cost breakdown shows PENDING for every category whose input is missing — no 0.0000 stands in for it", () => {
    const result = run(erisQs("eris_60ml", 500));
    const rows = Object.fromEntries(canonicalComponentRows({ totals: result.trueCost.totals, lines: result.trueCost.lines }).map((r) => [r.key, r]));
    expect(rows.inbound_freight.pending).toBe("PENDING — INBOUND FREIGHT NOT PROVIDED");
    expect(rows.packout.pending).toBe("PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED");
    expect(rows.ink.pending).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
    expect(rows.run_labor.pending).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
    expect(rows.machine_recovery.pending).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
    expect(rows.setup_labor.pending).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
    expect(rows.finishing_application.pending).toBe("PENDING REAL SHOP TIMING VALIDATION");
    // materials: the known blank cost is shown, with the pending label media named beside it
    expect(rows.materials.amount).toBeCloseTo(1151.4, 9);
    expect(rows.materials.pending).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
    // every $0 category of this job is either pending or a line that is $0 by design
    for (const row of Object.values(rows)) if (!row.amount && !row.pending) expect(["planned_overage", "outside_costs"]).toContain(row.key);
  });

  it("freight, geometry and application each display pending on their own line", () => {
    const result = run(erisQs("eris_120ml", 500, "premium-jars", "&pjartamper=1"));
    expect(lineOf(result, "inbound_freight").pending).toBe("PENDING — INBOUND FREIGHT NOT PROVIDED");
    expect(lineOf(result, "inbound_freight").amount).toBe(0);
    expect(lineOf(result, "print_media").label).toBe("Label media — LABEL GEOMETRY PENDING (owner measurement)");
    expect(lineOf(result, "application").label).toBe("Application labor — PENDING REAL SHOP TIMING VALIDATION");
    expect(lineOf(result, "application").amount).toBe(0);
    expect(lineOf(result, "application").formula).toBeUndefined();
  });

  it("Ceres freight pending also becomes \"Inbound freight: PENDING\" — and its own banner is untouched", () => {
    const before = BASELINE.records.find((r) => r.id === "jar miron/ceres_50ml x500 +band")!;
    expect(before.summary.items).toEqual(["Other production data — see Advanced diagnostics"]);
    const after = run(baselineCases().find((c) => c.id === "jar miron/ceres_50ml x500 +band")!.qs);
    expect(summarizeCalculatorBlockers(after.blockers)!.items).toEqual(["Inbound freight: PENDING"]);
    expect(after.blockers).toEqual(before.blockers);
    expect(JSON.parse(JSON.stringify(after.diagnostics.landedCost))).toEqual(before.landedCost);
    expect(after.diagnostics.landedCost!.label).toBe("FREIGHT PENDING SUPPLIER PACK DATA");
    expect(after.diagnostics.costOnlyJar).toBeUndefined();
  });
});

/* ================================================================== */
describe("3. no ink / nesting / label-area warnings before label geometry exists", () => {
  const NOISE = /INVALID_AREA|MISSING_NESTING_MODEL|ripLayoutSqft|inkable_artwork|MISSING_CALIBRATION|MISSING_INK_PRICE|MISSING_COST|MISSING_MATERIAL_COST|LABEL_MATERIAL|not calculator-ready|CUT_PATH|EMPTY_PHYSICAL_RUN|INVALID_NESTING_ITEM/;

  it("an Eris job reports ONE geometry blocker and none of the downstream calculation failures", () => {
    for (const size of ["eris_60ml", "eris_120ml"] as const) {
      const result = run(erisQs(size, 500));
      const text = `${result.blockers.join("\n")}\n${result.reasons.join("\n")}\n${result.trueCost.lines.map((l) => `${l.blocker ?? ""} ${l.provisional ?? ""}`).join("\n")}`;
      expect(text).not.toMatch(NOISE);
      expect(result.blockers.filter((b) => /LABEL_GEOMETRY_PENDING/.test(b))).toHaveLength(1);
      expect(result.blockers.filter((b) => /geometry/i.test(b))).toHaveLength(1);
      expect(result.blockers).toHaveLength(4);
      // the lines that depend on label area are pending, not failed
      for (const key of ["ink", "run_labor", "machine"]) {
        expect(lineOf(result, key).blocker, key).toBeUndefined();
        expect(lineOf(result, key).pending, key).toBe("PENDING — LABEL GEOMETRY PENDING (owner measurement)");
      }
      expect(lineOf(result, "print_media").blocker).toMatch(/^LABEL_GEOMETRY_PENDING: LABEL GEOMETRY PENDING OWNER MEASUREMENT/);
    }
  });

  it("still silent with no calibration, no ink price, no media selected and white / gloss layers requested", () => {
    const qs = "pfamily=premium-jars&pqty=500&pjar=eris/eris_60ml&pjarside=1&pjarlid=1&pjartamper=1&pprinter=roland&pwhitelayers=1&pglosslayers=1";
    const result = run(qs, NO_CAL);
    const text = `${result.blockers.join("\n")}\n${result.reasons.join("\n")}`;
    expect(text).not.toMatch(NOISE);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.inkChannels.every((channel) => channel.blocker == null)).toBe(true);
  });

  it("a jar WITH geometry still reports every one of those warnings when its inputs are bad", () => {
    // no calibration / ink price on a real, measured jar
    const noCal = run("pfamily=premium-jars&pjarmat=matte&pqty=500&pjar=miron/150ml&pjarside=1&pjarlid=1&pprinter=mimaki", NO_CAL);
    expect(noCal.blockers.join("\n")).toMatch(/MISSING_CALIBRATION/);
    expect(noCal.reasons).toEqual(expect.arrayContaining(["MISSING_CALIBRATION", "MISSING_INK_PRICE"]));
    expect(noCal.diagnostics.costOnlyJar).toBeUndefined();
    // no media selected on a real, measured jar — identical to before the cleanup
    const noMediaBefore = BASELINE.records.find((r) => r.id === "jar no media")!;
    const noMedia = run(baselineCases().find((c) => c.id === "jar no media")!.qs);
    expect(noMedia.blockers).toEqual(noMediaBefore.blockers);
    expect(noMedia.blockers.join("\n")).toMatch(/MISSING_COST|MATERIAL/);
    // a label job with no size still gets the nesting / area errors
    const noSizeBefore = BASELINE.records.find((r) => r.id === "labels no size")!;
    const noSize = run(baselineCases().find((c) => c.id === "labels no size")!.qs);
    expect(noSize.blockers).toEqual(noSizeBefore.blockers);
    expect(noSize.blockers.join("\n")).toMatch(/MISSING_NESTING_MODEL|INVALID_AREA|LABEL_PRINT_GEOMETRY_REQUIRED|EMPTY_PHYSICAL_RUN|INVALID_NESTING_ITEM/);
    // an unknown jar size (not a cost-only jar) is still refused with the old nesting errors
    const unknownBefore = BASELINE.records.find((r) => r.id === "jar unknown size miron/60ml")!;
    const unknown = run(baselineCases().find((c) => c.id === "jar unknown size miron/60ml")!.qs);
    expect(unknown.blockers).toEqual(unknownBefore.blockers);
    expect(unknown.blockers.join("\n")).toMatch(/MISSING_NESTING_MODEL/);
  });

  it("is driven by GEOMETRY BEING KNOWN, not by the brand: the day label sizes are entered the normal calculations resume", () => {
    const table = JAR_LABEL_GEOMETRY as Record<string, unknown>;
    expect(jarGeometryPendingNote("eris_60ml")).not.toBeNull();
    // TEST-ONLY placeholder sizes to prove the switch — NOT Eris dimensions; removed again below.
    table.eris_60ml = { side: { widthIn: 5, heightIn: 2 }, lid: { diameterIn: 2 }, tamper: { widthIn: 5, heightIn: 0.5 } };
    try {
      expect(jarGeometryPendingNote("eris_60ml")).toBeNull();
      const result = run(erisQs("eris_60ml", 500));
      const text = result.blockers.join("\n");
      expect(text).not.toMatch(/LABEL_GEOMETRY_PENDING|LABEL GEOMETRY PENDING/);
      // the label-area calculations ran normally
      expect(lineOf(result, "print_media").amount).toBeGreaterThan(0);
      expect(lineOf(result, "print_media").pending).toBeUndefined();
      expect(lineOf(result, "ink").amount).toBeGreaterThan(0);
      expect(lineOf(result, "machine").amount).toBeGreaterThan(0);
      expect(result.diagnostics.ripLayoutSqft).toBeGreaterThan(0);
      expect(result.diagnostics.cutPathIn).toBeGreaterThan(0);
      // ...and what is STILL not provided stays pending: timing, packout and freight (so still no unit cost)
      expect(result.blockers).toHaveLength(3);
      expect(summarizeCalculatorBlockers(result.blockers)!.items.slice().sort()).toEqual(["Application timing: PENDING REAL SHOP TIMING VALIDATION", "Inbound freight: PENDING", "Outbound packout: PENDING"]);
      expect(lineOf(result, "packout").label).toBe("PACKOUT PENDING — OUTBOUND PACKOUT NOT PROVIDED");
      expect(result.status).toBe("DRAFT_ONLY");
      expect(result.unitCost).toBeNull();
      const shown = result.diagnostics.costOnlyJar!;
      expect(shown.labelGeometry.status).toBe("PROVIDED");
      expect(shown.pending.map((row) => row.label)).toEqual(["Inbound freight", "Landed unit cost", "Application timing", "Outbound packout"]);
      // the blank is still the same owner-provided supplier cost at the planned quantity
      expect(lineOf(result, "blank_sets").amount).toBeCloseTo(505 * 2.28, 9);
      // and with a bad input, a jar that HAS geometry gets the normal warning again
      expect(run(erisQs("eris_60ml", 500), NO_CAL).blockers.join("\n")).toMatch(/MISSING_CALIBRATION/);
    } finally {
      delete table.eris_60ml;
    }
    expect(Object.keys(JAR_LABEL_GEOMETRY)).toEqual(["50ml", "100ml_tall", "100ml_wide", "150ml", "250ml", "3oz", "4oz", "ceres_50ml", "ceres_100ml"]);
    expect(run(erisQs("eris_60ml", 500)).blockers).toHaveLength(4);
  });
});

/* ================================================================== */
describe("4. picker classification — a brand group, never a family", () => {
  it("Eris is listed under its own brand group in every Jar picker and carries no family", () => {
    expect(COST_ONLY_JAR_PICKER_GROUP).toBe("ERIS");
    expect(COST_ONLY_JAR_PICKER_GROUP_LABEL).toBe("ERIS — cost data pending");
    expect([...COST_ONLY_JAR_PICKER_FAMILIES]).toEqual(["standard-jars", "premium-jars"]);
    for (const profile of COST_ONLY_JAR_PROFILES) {
      expect(Object.keys(profile).sort()).toEqual(["brand", "key", "label", "notForSale", "size"]);
      expect((profile as Record<string, unknown>).uiFamily).toBeUndefined();
    }
    const premium = costOnlyJarCalculatorOptions("premium-jars");
    const standard = costOnlyJarCalculatorOptions("standard-jars");
    expect(premium).toEqual(standard);
    expect(premium.map((o) => [o.group, o.jarProfile])).toEqual([["ERIS", "eris/eris_60ml"], ["ERIS", "eris/eris_120ml"]]);
    for (const family of ["sticker-bags", "stickers-labels", "banners", "dtp-bags", "custom-item", "", null]) expect(costOnlyJarCalculatorOptions(family)).toEqual([]);
  });

  it("Eris remains selectable: each option carries the profile the calculator costs, and that job resolves", () => {
    for (const option of costOnlyJarCalculatorOptions("standard-jars")) {
      expect(option.value).toBe(`costonly:jar:${option.jarProfile}`);
      const result = run(`pfamily=standard-jars&pjarmat=matte&pqty=500&pjar=${option.jarProfile}&pjarside=1&pjarlid=1&pprinter=mimaki`);
      expect(result.diagnostics.costOnlyJar!.productName).toBe(option.costOnly.productName);
      expect(result.blockers.join("\n")).not.toMatch(/FAMILY_NOT_CANONICAL|not a jar GSO currently offers/);
    }
  });

  it("the grouping changes nothing: identical cost result under either Jar family, and no family name anywhere in it", () => {
    for (const size of ["eris_60ml", "eris_120ml"] as const) for (const qty of [50, 500, 2500]) {
      const premium = run(erisQs(size, qty, "premium-jars"));
      const standard = run(erisQs(size, qty, "standard-jars"));
      expect(standard.trueCost).toEqual(premium.trueCost);
      expect(standard.blockers).toEqual(premium.blockers);
      expect(standard.reasons).toEqual(premium.reasons);
      expect(standard.diagnostics.costOnlyJar).toEqual(premium.diagnostics.costOnlyJar);
      expect(everythingShown(premium)).not.toMatch(/premium|standard-jars|Chiron|Miron/i);
    }
  });

  it("no price for Eris under any grouping — cost authority, owner ladder and the result card all refuse", () => {
    for (const family of ["premium-jars", "standard-jars"]) for (const size of ["eris_60ml", "eris_120ml"] as const) for (const qty of [50, 500, 2500]) {
      const result = run(erisQs(size, qty, family));
      const authority = resolveCostAuthority({ canonicalFamilyKey: family, canonical: result, legacyJobCost: 999, quantity: qty, freightTotal: 0 });
      expect(isCostedAuthority(authority)).toBe(false);
      expect(authority.unitCost).toBeNull();
      expect(authority.completeCost).toBeNull();
      for (const brand of ["eris", "miron", "chiron", "standard"]) expect(resolveJarOwnerLadder({ brand, sizeKey: size, quantity: qty }).ok).toBe(false);
      // even if a tier row carrying a price, and every family margin key, were handed to the result card
      for (const marginRuleKey of ["miron-jars", "chiron-jars", "premium-jars", "standard-jars", null]) {
        const owner = resolveOwnerResult({
          family, marginRuleKey, multiLine: null,
          canonical: { status: result.status, totalCost: result.totalCost, unitCost: result.unitCost, blockers: result.blockers },
          costOnlyJar: result.diagnostics.costOnlyJar,
          requestedRow: { quantity: qty, requested: true, jobCost: 100, unitCost: 1, unitPrice: 9.99, totalPrice: 9.99 * qty, profit: 500, actualMarginPct: 60, draftOnly: false, blockers: [], ownerLadder: { unitPrice: 9.99 } },
        })!;
        expect(owner.state).toBe("COST_DATA_PARTIAL");
        expect(owner.recommendedTotal).toBeNull();
        expect(owner.recommendedUnit).toBeNull();
        expect(owner.profit).toBeNull();
        expect(owner.marginPct).toBeNull();
        expect(owner.trueJobCost).toBeNull();
        expect(owner.trueUnitCost).toBeNull();
        expect(owner.priceAuthority).toBeNull();
        expect(owner.authority).toBeNull();
      }
    }
  });

  it("the calculator page shows no price table and no legacy family diagnostics for a cost-only jar", () => {
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    const tiers = route.slice(route.indexOf("function ProductTiers()"));
    expect(tiers.slice(0, tiers.indexOf("RECOMMENDED CUSTOMER PRICE"))).toContain("if (pm?.canonical?.diagnostics?.costOnlyJar?.status === \"COST_DATA_PARTIAL\") return null;");
    const breakdown = route.slice(route.indexOf("function ProductBreakdown()"), route.indexOf("function ProductTiers()"));
    expect(breakdown.slice(0, breakdown.indexOf("box(es)"))).toContain("costOnlyJar?.status === \"COST_DATA_PARTIAL\") return null;");
    // the brand group is rendered in the standard AND the premium picker (outside the premium-only branch)
    expect(route).toContain("</>) : recordOptions.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}\n            {erisOptions.length ? <optgroup label={COST_ONLY_JAR_PICKER_GROUP_LABEL}>");
  });
});

/* ================================================================== */
describe("5-6. COST DATA PARTIAL — a valid product with incomplete costing inputs", () => {
  it("Eris 60ml at 500 finished jars: the known figures and the pending items, verbatim", () => {
    const shown = run(erisQs("eris_60ml", 500)).diagnostics.costOnlyJar!;
    expect(shown.status).toBe("COST_DATA_PARTIAL");
    expect(shown.statusLabel).toBe("COST DATA PARTIAL");
    expect(shown.known).toEqual([
      { label: "Supplier cost", value: "$2.28 ea (before inbound freight — not a landed cost)" },
      { label: "Supplier tier", value: "2,500 (2,500 × $2.28 = $5,700.00) — lower supplier tiers NOT PROVIDED" },
      { label: "Planned blank quantity", value: "505 for 500 finished jars (1% planned overage)" },
      { label: "Base blank cost", value: "$1,151.40 (505 × $2.28, before inbound freight — not a job total)" },
    ]);
    expect(shown.pending).toEqual([
      { label: "Inbound freight", value: "PENDING" },
      { label: "Landed unit cost", value: "PENDING" },
      { label: "Label geometry", value: "PENDING" },
      { label: "Application timing", value: "PENDING REAL SHOP TIMING VALIDATION" },
      { label: "Outbound packout", value: "PENDING" },
    ]);
  });

  it("Eris 120ml at 500, and before a quantity is entered", () => {
    const shown = run(erisQs("eris_120ml", 500)).diagnostics.costOnlyJar!;
    expect(shown.known.map((row) => row.value)).toEqual([
      "$3.22 ea (before inbound freight — not a landed cost)",
      "2,500 (2,500 × $3.22 = $8,050.00) — lower supplier tiers NOT PROVIDED",
      "505 for 500 finished jars (1% planned overage)",
      "$1,626.10 (505 × $3.22, before inbound freight — not a job total)",
    ]);
    const picker = costOnlyJarSummary(COST_ONLY_JAR_PROFILES[0])!;
    expect(picker.known.map((row) => row.label)).toEqual(["Supplier cost", "Supplier tier"]);
    expect(picker.pending).toEqual(shown.pending);
  });

  it("the cost data itself did not move: $2.28 / $3.22, tier 2,500, 1% overage, 500 -> 505, $1,151.40", () => {
    expect(ERIS_JAR_SUPPLIER_COST).toEqual({
      eris_60ml: { name: "Eris 60ml Jar", supplierUnitCost: 2.28, supplierQuantity: 2500 },
      eris_120ml: { name: "Eris 120ml Jar", supplierUnitCost: 3.22, supplierQuantity: 2500 },
    });
    expect(productionQtyFor(500)).toBe(505);
    for (const qty of [1, 50, 128, 500, 2500, 5000]) {
      const a = resolveJarBlankCost({ brand: "eris", size: "eris_60ml", quantity: qty });
      const b = resolveJarBlankCost({ brand: "eris", size: "eris_120ml", quantity: qty });
      expect(a.ok && a.unitCost).toBe(2.28);
      expect(b.ok && b.unitCost).toBe(3.22);
      expect(a.ok && a.tierMinQty).toBeNull();
    }
    const result = run(erisQs("eris_60ml", 500));
    expect(result.trueCost.productionQty).toBe(505);
    expect(lineOf(result, "blank_sets").amount).toBeCloseTo(1151.4, 9);
    expect(lineOf(result, "blank_sets").formula).toBe("505 x $2.2800");
    expect(result.diagnostics.costOnlyJar!.baseBlankCost).toBe(1151.4);
    expect(result.diagnostics.costOnlyJar!.plannedBlankQuantity).toBe(505);
    expect(result.diagnostics.costOnlyJar!.landedUnitCost).toBeNull();
    expect(result.trueCost.totalCost).toBeCloseTo(1151.4, 9); // the blank is the only money in the job
    // nothing was added to the frozen tables
    expect(Object.keys(JAR_APPLICATION_SECONDS_BY_SIZE)).toEqual(["50ml", "100ml_tall", "100ml_wide", "150ml", "250ml", "3oz", "4oz", "ceres_50ml", "ceres_100ml"]);
  });

  it("the engine status stays DRAFT_ONLY so nothing downstream treats the job as costed", () => {
    const result = run(erisQs("eris_60ml", 500));
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.trueCost.status).toBe("DRAFT_ONLY");
    expect(result.trueCost.unitCost).toBeNull();
  });

  it("the result card state is COST DATA PARTIAL — not PRICING BLOCKED — and only for a cost-only jar", () => {
    const eris = run(erisQs("eris_60ml", 500));
    const card = resolveOwnerResult({ family: "premium-jars", canonical: { status: eris.status, totalCost: eris.totalCost, unitCost: eris.unitCost, blockers: eris.blockers }, costOnlyJar: eris.diagnostics.costOnlyJar, requestedRow: null, multiLine: null, marginRuleKey: null })!;
    expect(card.state).toBe("COST_DATA_PARTIAL");
    expect(card.badge).toBe("COST DATA PARTIAL");
    // every other blocked job keeps its existing state and wording
    const ceres = run(baselineCases().find((c) => c.id === "jar miron/ceres_50ml x500")!.qs);
    const ceresCard = resolveOwnerResult({ family: "premium-jars", canonical: { status: ceres.status, totalCost: ceres.totalCost, unitCost: ceres.unitCost, blockers: ceres.blockers }, costOnlyJar: ceres.diagnostics.costOnlyJar ?? null, requestedRow: null, multiLine: null, marginRuleKey: null })!;
    expect(ceresCard.state).toBe("PRICING_BLOCKED");
    expect(ceresCard.badge).toBe("PRICING BLOCKED");
    const withoutField = resolveOwnerResult({ family: "premium-jars", canonical: { status: ceres.status, totalCost: ceres.totalCost, unitCost: ceres.unitCost, blockers: ceres.blockers }, requestedRow: null, multiLine: null, marginRuleKey: null })!;
    expect(withoutField).toEqual(ceresCard);
  });
});

/* ================================================================== */
describe("7. the Eris panel renders (React server render of the real panel component)", () => {
  const render = (summary: any) => renderToString(createElement(CostOnlyJarPanel, { summary }))
    .replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("Eris 60ml at 500: status, Known and Pending — no zero, no box count, no price, no error red", () => {
    const html = render(run(erisQs("eris_60ml", 500)).diagnostics.costOnlyJar);
    const shown = text(html);
    expect(shown).toBe(
      "Eris 60ml Jar COST DATA PARTIAL Cost only — not for sale. No landed cost and no selling price are shown until the pending items below are provided. "
      + "KNOWN Supplier cost $2.28 ea (before inbound freight — not a landed cost) "
      + "Supplier tier 2,500 (2,500 × $2.28 = $5,700.00) — lower supplier tiers NOT PROVIDED "
      + "Planned blank quantity 505 for 500 finished jars (1% planned overage) "
      + "Base blank cost $1,151.40 (505 × $2.28, before inbound freight — not a job total) "
      + "PENDING Inbound freight PENDING Landed unit cost PENDING Label geometry PENDING Application timing PENDING REAL SHOP TIMING VALIDATION Outbound packout PENDING",
    );
    expect(shown).not.toMatch(/box\(es\)|0 box|\$0(\.0+)?\b|INVALID_AREA|MISSING_|Premium|price is|recommended/i);
    expect(html).toContain("data-cost-status=\"COST_DATA_PARTIAL\"");
    // neutral / informational styling — none of the red error colours
    expect(html).toContain("#eff6ff");
    expect(html).not.toMatch(/#991b1b|#fef2f2|#fecaca|#7f1d1d|#dc2626/i);
  });

  it("Eris 120ml in the picker (no quantity yet)", () => {
    const shown = text(render(costOnlyJarCalculatorOptions("standard-jars")[1].costOnly));
    expect(shown).toContain("Eris 120ml Jar COST DATA PARTIAL");
    expect(shown).toContain("Supplier cost $3.22 ea");
    expect(shown).toContain("Supplier tier 2,500 (2,500 × $3.22 = $8,050.00)");
    expect(shown).not.toContain("Planned blank quantity");
    expect(shown).toContain("Outbound packout PENDING");
  });

  it("the calculator route uses this panel in the picker and in the result card, in the informational tone", () => {
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(route).toContain("if (jarCostOnly) return <CostOnlyJarPanel summary={jarCostOnly}");
    expect(route).toContain("<CostOnlyJarPanel summary={costOnlyJar}");
    expect(route).toContain("COST_DATA_PARTIAL: { bg: \"#eff6ff\", fg: \"#1e40af\", border: \"#bfdbfe\" }");
    expect(route).toContain("const componentRows = canonicalComponentRows({ totals: cat as any, lines: canonical.lines });");
  });
});

/* ================================================================== */
describe("8. no existing product's cost or price changed — compared with the 160b662 capture", () => {
  const cases = baselineCases();

  it("the fixture is the capture of the same matrix", () => {
    expect(BASELINE.capturedFrom).toContain("160b662");
    expect(BASELINE.records.map((r) => r.id)).toEqual(cases.map((c) => c.id));
    expect(cases.length).toBe(86);
    // the matrix exercises every active jar, each bag family, labels and banners — costed and blocked
    expect(BASELINE.records.filter((r) => r.status === "PROVISIONAL").length).toBeGreaterThan(50);
    expect(BASELINE.records.filter((r) => r.status === "DRAFT_ONLY").length).toBeGreaterThan(15);
    expect(BASELINE.records.filter((r) => r.ladder?.ok).length).toBeGreaterThan(30);
  });

  /**
   * The ONLY differences allowed, all wording:
   *  (a) a packout line that used to read "Packout — 0 box(es) @ 1/box" (a family with no box standard:
   *      Split Bag, QP / P Bag, banner, or a refused jar) now reads "PACKOUT PENDING — NO BOX STANDARD
   *      RECORDED" with no formula — still $0, still not a blocker;
   *  (b) the plain blocker summary names a missing inbound freight "Inbound freight: PENDING" instead of
   *      folding it into "Other production data — see Advanced diagnostics".
   */
  const normalisePackout = (line: any) => line.key === "packout" && (line.label === "Packout — 0 box(es) @ 1/box" || line.label === "PACKOUT PENDING — NO BOX STANDARD RECORDED")
    ? { ...line, label: "<packout: no box standard>", formula: null, basis: null }
    : line;

  for (const c of cases) {
    it(c.id, () => {
      const before = BASELINE.records.find((r) => r.id === c.id)!;
      const after: any = baselineRecord(c);
      // cost: status, unit cost, job cost, category totals, every line amount / formula / blocker — identical
      expect(after.status).toBe(before.status);
      expect(after.unitCost).toBe(before.unitCost);
      expect(after.totalCost).toBe(before.totalCost);
      expect(after.totals).toEqual(before.totals);
      expect(after.blockers).toEqual(before.blockers);
      expect(after.reasons).toEqual(before.reasons);
      expect(after.lines.map(normalisePackout)).toEqual(before.lines.map(normalisePackout));
      expect(after.landedCost).toEqual(before.landedCost);
      // a KNOWN packout is byte-identical, and (a) only ever applies to a $0 non-blocking line
      const beforePackout = before.lines.find((l: any) => l.key === "packout");
      const afterPackout = after.lines.find((l: any) => l.key === "packout");
      if (beforePackout.label !== "Packout — 0 box(es) @ 1/box") expect(afterPackout).toEqual(beforePackout);
      else expect(afterPackout).toEqual({ ...beforePackout, label: "PACKOUT PENDING — NO BOX STANDARD RECORDED", formula: null, basis: null });
      // price: the cost authority and the owner jar ladder — identical
      expect(after.authority).toEqual(before.authority);
      expect(after.ladder).toEqual(before.ladder);
      // (b) the plain summary: identical unless the job is missing its inbound freight
      if (before.blockers.some((b: string) => b.includes("MISSING_FREIGHT_BASIS"))) {
        expect(after.summary.items).toContain("Inbound freight: PENDING");
        expect(after.summary.kind).toBe(before.summary.kind);
        expect(after.summary.codes).toEqual(before.summary.codes);
      } else {
        expect(after.summary).toEqual(before.summary);
      }
    });
  }
});
