// 2026-10-05 — canonical FIXED-PRODUCT regression suite.
//
// Every fixture comes from repo authority (jar-active-scope + jar-label-geometry
// + the jar adapter rules). No dollar values are invented: dollar pins are
// RELATIONSHIPS the engine must keep (additivity, no double counts, determinism)
// plus the existing 17D.7 control case which the repo already pins at 84.143290.
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  computeCanonicalJob,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { ACTIVE_JAR_PROFILES } from "../app/lib/jar-active-scope";
import { JAR_LABEL_GEOMETRY, type JarSizeKey } from "../app/lib/jar-label-geometry";
import { JAR_APPLICATION_SECONDS_BY_SIZE, APPLICATION_LABOR_RATE_PER_HOUR, JAR_UNITS_PER_BOX, PACKOUT_TOTAL_PER_BOX } from "../app/lib/jar-cost-inputs.server";
import { WEEDING_STANDARD } from "../app/lib/weeding-standard";
import { LABEL_SETS } from "../app/lib/product-production-spec";

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

const run = (q: string) => {
  const input = normalizeCanonicalInput(new URLSearchParams(q));
  expect(input, q).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};
const line = (r: ReturnType<typeof run>, key: string) => r.trueCost.lines.filter((l) => l.key === key).reduce((t, l) => t + l.amount, 0);
const jarQs = (profileKey: string, qty: number, set: { side: boolean; lid: boolean; tamper: boolean }, extra = "") => {
  const profile = ACTIVE_JAR_PROFILES.find((p) => p.key === profileKey)!;
  const variant = profile.brand === "standard" ? "&pjarvariant=black_white" : "";
  return `pfamily=${profile.uiFamily}&pqty=${qty}&pjar=${profileKey}${variant}` +
    (set.side ? "&pjarside=1" : "") + (set.lid ? "&pjarlid=1" : "") + (set.tamper ? "&pjartamper=1" : "") +
    "&pcmykcoverage=40" + extra;
};

describe("every supported jar x every label set prices from the one spec authority", () => {
  for (const profile of ACTIVE_JAR_PROFILES) {
    for (const set of LABEL_SETS) {
      it(`${profile.key} / ${set.key}`, () => {
        const qty = 200;
        const r = run(jarQs(profile.key, qty, set.selection));
        expect(r.status, r.blockers.join("\n")).not.toBe("DRAFT_ONLY");
        expect(r.unitCost).not.toBeNull();
        expect(r.unitCost!).toBeGreaterThan(0);
        const pieces = (set.selection.side ? 1 : 0) + (set.selection.lid ? 1 : 0);
        // multi-piece: one label of each selected kind PER jar
        expect(r.diagnostics.physicalItems).toBe(qty);
        expect(r.diagnostics.applicationsPerItem).toBe(pieces);
        expect(r.diagnostics.applicationEvents).toBe(qty * pieces);
        // setup: side+lid is ONE design; print setup once per JOB
        expect(r.diagnostics.artSetupEvents).toBe(1);
        expect(r.diagnostics.printSetupEvents).toBe(1);
        // the spec used is the geometry table entry for the selected pieces
        const g = JAR_LABEL_GEOMETRY[profile.size as JarSizeKey];
        const expected: Record<string, any> = {};
        if (set.selection.side) expected.side = { ...g.side };
        if (set.selection.lid) expected.lid = { ...g.lid };
        expect(r.diagnostics.productSpec?.standard).toEqual(expected);
        expect(r.diagnostics.productSpec?.productKey).toBe(profile.key);
        expect(r.diagnostics.productSpec?.customSize).toBe(false);
        // application = per-label owner seconds at $20/hr on FINISHED jars
        const seconds = JAR_APPLICATION_SECONDS_BY_SIZE[profile.size as JarSizeKey];
        const perJar = ((set.selection.side ? seconds.side : 0) + (set.selection.lid ? seconds.lid : 0)) / 3600 * APPLICATION_LABOR_RATE_PER_HOUR;
        expect(line(r, "application")).toBeCloseTo(perJar * qty, 6);
        // weeding = ceil(feed/54) per physical run, summed, at the ONE standard
        expect(r.diagnostics.weedingPages).toBeGreaterThanOrEqual(pieces);
        expect(line(r, "weeding")).toBeCloseTo(r.diagnostics.weedingPages! * WEEDING_STANDARD.costPerPage, 9);
        // packout on finished jars from the per-size box table
        expect(line(r, "packout")).toBeCloseTo(Math.ceil(qty / JAR_UNITS_PER_BOX[profile.size as JarSizeKey]) * PACKOUT_TOTAL_PER_BOX, 6);
        // determinism
        expect(JSON.stringify(run(jarQs(profile.key, qty, set.selection)))).toBe(JSON.stringify(r));
      });
    }
  }
});

describe("multi-piece cost audit: 128 jars Side + Lid", () => {
  const QTY = 128;
  const both = run(jarQs("miron/100ml_wide", QTY, { side: true, lid: true, tamper: false }));
  const side = run(jarQs("miron/100ml_wide", QTY, { side: true, lid: false, tamper: false }));
  const lid = run(jarQs("miron/100ml_wide", QTY, { side: false, lid: true, tamper: false }));

  it("128 jars = 128 side labels + 128 lid labels, two physical runs", () => {
    expect(both.diagnostics.applicationEvents).toBe(256);
    expect(both.diagnostics.physicalItems).toBe(128);
    expect(both.diagnostics.applicationsPerItem).toBe(2);
    expect(side.diagnostics.applicationEvents).toBe(128);
    expect(lid.diagnostics.applicationEvents).toBe(128);
  });

  it("per-piece costs are ADDITIVE across the two runs (media, ink, application, weeding, cutting)", () => {
    for (const key of ["print_media", "ink", "application", "weeding", "cutting_machine", "cutting_attention"]) {
      expect(line(both, key), key).toBeCloseTo(line(side, key) + line(lid, key), 6);
    }
    expect(both.diagnostics.inkableArtworkSqft).toBeCloseTo(side.diagnostics.inkableArtworkSqft + lid.diagnostics.inkableArtworkSqft, 9);
    expect(both.diagnostics.mediaConsumedSqft).toBeCloseTo(side.diagnostics.mediaConsumedSqft + lid.diagnostics.mediaConsumedSqft, 9);
    expect(both.diagnostics.weedingPages).toBe(side.diagnostics.weedingPages! + lid.diagnostics.weedingPages!);
  });

  it("per-JAR costs are charged ONCE (blank set, art setup, print setup, packout, freight) — no double count", () => {
    for (const key of ["blank_sets", "art_setup", "print_setup", "packout", "inbound_freight"]) {
      expect(line(both, key), key).toBeCloseTo(line(side, key), 9);
      expect(line(both, key), key).toBeCloseTo(line(lid, key), 9);
    }
    expect(both.totalCost).toBeLessThan(side.totalCost + lid.totalCost);
  });

  it("no line key is emitted twice and the lines sum to the total", () => {
    const keys = both.trueCost.lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(both.trueCost.lines.reduce((t, l) => t + l.amount, 0)).toBeCloseTo(both.totalCost, 6);
  });

  it("inkable area: side rectangle + lid CIRCLE (pi r^2), on the 1% production quantity", () => {
    const g = JAR_LABEL_GEOMETRY["100ml_wide"];
    const production = Math.ceil(QTY * 1.01);
    const sqin = g.side.widthIn * g.side.heightIn + Math.PI * (g.lid.diameterIn / 2) ** 2;
    expect(both.diagnostics.inkableArtworkSqft).toBeCloseTo((sqin * production) / 144, 9);
  });

  it("application is per label at the owner's size seconds: 128 x (12s + 10s) at $20/hr", () => {
    expect(line(both, "application")).toBeCloseTo(128 * ((12 + 10) / 3600) * 20, 6);
    expect(line(side, "application")).toBeCloseTo(128 * (12 / 3600) * 20, 6);
    expect(line(lid, "application")).toBeCloseTo(128 * (10 / 3600) * 20, 6);
  });

  it("the finishing decomposition is exactly the sum of the engine's finishing lines", () => {
    const fb = both.diagnostics.finishingBreakdown!;
    expect(fb.cuttingMachine).toBeCloseTo(line(both, "cutting_machine"), 9);
    expect(fb.cuttingAttention).toBeCloseTo(line(both, "cutting_attention"), 9);
    expect(fb.weeding).toBeCloseTo(line(both, "weeding"), 9);
    expect(fb.application).toBeCloseTo(line(both, "application"), 9);
    expect(fb.specialtySetup).toBe(0);
    expect(fb.total).toBeCloseTo(fb.cuttingMachine + fb.cuttingAttention + fb.weeding + fb.application + fb.specialtySetup, 9);
    expect(fb.basis.weeding).toEqual(["weeding"]);
  });
});

describe("17D.7 control case still pins after the spec/weeding refactor", () => {
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
  const CONTROL = "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=0";

  it("1000 x 3x3 matte AUTO CMYK = 84.143290 total / 0.084143 unit, PROVISIONAL", async () => {
    const input = normalizeCanonicalInput(new URLSearchParams(CONTROL))!;
    const result = await computeCanonicalJob({ db, shop: SHOP }, input);
    expect(result.status).toBe("PROVISIONAL");
    expect(result.totalCost).toBeCloseTo(84.14329, 5);
    expect(result.unitCost!).toBeCloseTo(0.084143, 6);
    expect(result.diagnostics.inkableArtworkSqft).toBeCloseTo(62.5, 6);
    expect(result.diagnostics.productSpec).toBeNull(); // custom labels have no fixed spec
    expect(result.diagnostics.finishingBreakdown?.weeding).toBeCloseTo(result.diagnostics.weedingPages! * WEEDING_STANDARD.costPerPage, 9);
  });
});

describe("bag families record their fixed spec too", () => {
  it("sticker bag diagnostics carry the owner 4x5 artboard with no override", () => {
    const r = run("pfamily=sticker-bags&pqty=100&pbagsides=1&pcmykcoverage=40");
    expect(r.diagnostics.productSpec).toMatchObject({
      family: "sticker-bags", productKey: "bag-4x5/sticker", customSize: false,
      standard: { label: { widthIn: 4, heightIn: 5 } },
    });
  });
});
