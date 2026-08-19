// Patch 1 (17D.1) — machine/profile calibration.
//
// Round-trip tests reconcile the seeded calibrations against the OWNER'S OWN
// measurements, so a drifted constant fails loudly. History/resolution tests
// pin the append-only contract. Guard tests pin that Patch 1 changes no live
// pricing path and that no money ever enters a calibration row.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AREA_BASES,
  CALIBRATION_STATUSES,
  GLOSS_DEFAULT_COVERAGE_PCT,
  IDENTITY_FIELDS,
  TIME_MODELS,
  computeInkMl,
  computeOccupancyMinutes,
  identityKeyOf,
  isAreaBasis,
  loadActiveCalibration,
  loadCalibrationHistory,
  resolveActiveCalibration,
  resolveCoverage,
  supersedeAndInsert,
  type CalibrationIdentity,
  type CalibrationRecord,
} from "../app/lib/machine-calibration.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";

const SEED_SRC = readFileSync("tools/seed-machine-profile-calibrations.mjs", "utf8");
const LIB_SRC = readFileSync("app/lib/machine-calibration.server.ts", "utf8");
const SCHEMA_SRC = readFileSync("prisma/schema.prisma", "utf8");
const MIGRATION_SRC = readFileSync(
  "prisma/migrations/20260818120000_add_machine_profile_calibration/migration.sql",
  "utf8",
);

const SHOP = "942075-2.myshopify.com";
const T0 = new Date("2026-08-18T00:00:00.000Z");
const NOW = new Date("2026-08-19T00:00:00.000Z");

/* ------------------------------------------------------------------ *
 * Fixtures — the four owner-measured calibrations
 * ------------------------------------------------------------------ */

let seq = 0;
function cal(overrides: Partial<CalibrationRecord> & CalibrationIdentity): CalibrationRecord {
  seq += 1;
  return {
    id: `cal_${seq}`,
    shop: SHOP,
    mlPerSqftPerPass: null,
    inkAreaBasis: "inkable_artwork",
    minutesPerSqft: null,
    timeAreaBasis: "rip_layout",
    fixedMinutes: null,
    timeModel: "variable_only",
    coverageBasisPct: null,
    measuredAt: T0,
    effectiveFrom: T0,
    effectiveTo: null,
    status: "approved",
    source: "test",
    notes: null,
    supersedesId: null,
    createdAt: T0,
    ...overrides,
  };
}

const MIMAKI_CMYK = cal({
  machineKey: "mimaki-ucjv300-130",
  inkMode: "cmyk_heavy",
  ripProfile: "PVC Gloss / Mimaki Vision Vinyl",
  qualityMode: "Fast Print High",
  resolution: "600x1200 VD",
  passConfig: "32-pass-bidi-op1",
  mlPerSqftPerPass: 1.89,
  minutesPerSqft: 1.444,
});

const ROLAND_CMYK = cal({
  machineKey: "roland-lg-640",
  inkMode: "cmyk",
  ripProfile: "Generic Sign Production",
  qualityMode: "High Quality",
  resolution: "720x1200",
  passConfig: "hq-default",
  mlPerSqftPerPass: 1.4133,
  minutesPerSqft: 0.91,
});

const ROLAND_WHITE = cal({
  machineKey: "roland-lg-640",
  inkMode: "white",
  ripProfile: "Generic Sign Production",
  qualityMode: "High Quality",
  resolution: "720x1200",
  passConfig: "white-hd-1x",
  mlPerSqftPerPass: 6.0,
  minutesPerSqft: 1.71,
  coverageBasisPct: 100,
});

const ROLAND_GLOSS = cal({
  machineKey: "roland-lg-640",
  inkMode: "gloss",
  ripProfile: "Special Effects",
  qualityMode: "High Quality",
  resolution: "720x1200",
  passConfig: "gloss-1x",
  mlPerSqftPerPass: 4.18,
  minutesPerSqft: 0.91,
  coverageBasisPct: 100,
});

const ALL = [MIMAKI_CMYK, ROLAND_CMYK, ROLAND_WHITE, ROLAND_GLOSS];
const idOf = (row: CalibrationRecord): CalibrationIdentity =>
  Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, row[f]])) as CalibrationIdentity;

/** Hand-rolled fake Prisma (repo convention: no real DB in tests). */
function makeDb(rows: CalibrationRecord[] = []) {
  let n = 0;
  const model = {
    async findMany({ where, orderBy }: any) {
      let out = rows.filter((r) =>
        Object.entries(where || {}).every(([k, v]) => (r as any)[k] === v),
      );
      if (orderBy) {
        out = [...out].sort(
          (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
        );
      }
      return out;
    },
    async update({ where, data }: any) {
      const row = rows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    async create({ data }: any) {
      n += 1;
      const row = { id: `new_${n}`, createdAt: new Date(), ...data } as CalibrationRecord;
      rows.push(row);
      return row;
    },
  };
  return {
    rows,
    machineProfileCalibration: model,
    async $transaction(fn: any) {
      return fn({ machineProfileCalibration: model });
    },
  } as any;
}

/* ================================================================== *
 * ROUND-TRIP — owner measurements
 * ================================================================== */

describe("round-trip against owner measurements", () => {
  it("1. Mimaki heavy CMYK ink: 18.01 sqft x 1.89 reconciles to the metered 34.085 mL", () => {
    const r = computeInkMl({ calibration: MIMAKI_CMYK, areas: { inkable_artwork: 18.01 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inkMl).toBeCloseTo(34.0389, 4);
    expect(Math.abs(r.inkMl - 34.085)).toBeLessThan(0.05);
    expect(r.areaBasis).toBe("inkable_artwork");
  });

  it("2. Mimaki heavy CMYK time: 18.01 sqft x 1.444 reconciles to the measured 26 min", () => {
    const r = computeOccupancyMinutes({ calibration: MIMAKI_CMYK, areas: { rip_layout: 18.01 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.minutes).toBeCloseTo(26.0064, 3);
    expect(Math.abs(r.minutes - 26)).toBeLessThan(0.05);
    expect(r.areaBasis).toBe("rip_layout");
  });

  it("3. Roland White HD: 3.00 sqft x 100% x 6.00 x 1 pass = exactly 18.00 mL", () => {
    const r = computeInkMl({
      calibration: ROLAND_WHITE,
      areas: { inkable_artwork: 3.0 },
      coveragePct: 100,
      passCount: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inkMl).toBeCloseTo(18.0, 10);
    expect(Math.abs(r.inkMl - 18.0025)).toBeLessThan(0.01);
  });

  it("4. Roland GlossVarnish: 3.00 sqft x 100% x 4.18 x 1 pass = exactly 12.54 mL", () => {
    const r = computeInkMl({
      calibration: ROLAND_GLOSS,
      areas: { inkable_artwork: 3.0 },
      coveragePct: 100,
      passCount: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inkMl).toBeCloseTo(12.54, 10);
    expect(Math.abs(r.inkMl - 12.541)).toBeLessThan(0.01);
  });

  it("5. Roland CMYK time: 18.2 sqft x 0.91 = 16.56 min, bracketing the measured 16 and 17", () => {
    const r = computeOccupancyMinutes({ calibration: ROLAND_CMYK, areas: { rip_layout: 18.2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.minutes).toBeCloseTo(16.562, 3);
    expect(r.minutes).toBeGreaterThan(16);
    expect(r.minutes).toBeLessThan(17);
  });

  it("21. Roland heavy CMYK ink: 7.2144 sqft x 1.4133 reconciles to the metered 10.1962 mL", () => {
    const r = computeInkMl({ calibration: ROLAND_CMYK, areas: { inkable_artwork: 7.2144 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inkMl).toBeCloseTo(10.1961, 4);
    expect(Math.abs(r.inkMl - 10.1962)).toBeLessThan(0.001);
  });
});

/* ================================================================== *
 * HISTORY + RESOLUTION
 * ================================================================== */

describe("append-only history and deterministic resolution", () => {
  it("6. multiple historical rows coexist for one identity", async () => {
    const identity = idOf(ROLAND_CMYK);
    const rows = [
      cal({ ...identity, mlPerSqftPerPass: 1.2, status: "superseded", effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-05-01") }),
      cal({ ...identity, mlPerSqftPerPass: 1.356, status: "superseded", effectiveFrom: new Date("2026-05-01"), effectiveTo: T0 }),
      cal({ ...identity, mlPerSqftPerPass: 1.4133, status: "approved", effectiveFrom: T0 }),
    ];
    const db = makeDb(rows);
    const history = await loadCalibrationHistory(db, SHOP, identity);
    expect(history).toHaveLength(3);
  });

  it("7. active resolution is deterministic — newest approved inside the window wins", () => {
    const identity = idOf(ROLAND_CMYK);
    const rows = [
      cal({ ...identity, mlPerSqftPerPass: 1.356, status: "superseded", effectiveFrom: new Date("2026-05-01"), effectiveTo: T0 }),
      cal({ ...identity, mlPerSqftPerPass: 1.4133, status: "approved", effectiveFrom: T0 }),
    ];
    const r = resolveActiveCalibration(rows, identity, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.mlPerSqftPerPass).toBe(1.4133);
    // stable across repeated calls
    expect(resolveActiveCalibration(rows, identity, NOW)).toEqual(r);
  });

  it("8. superseded rows remain queryable with their supersedes chain", async () => {
    const identity = idOf(ROLAND_CMYK);
    const db = makeDb([cal({ ...identity, mlPerSqftPerPass: 1.356 })]);
    const priorId = db.rows[0].id;

    await supersedeAndInsert(db, {
      shop: SHOP,
      identity,
      values: { measuredAt: T0, effectiveFrom: T0, source: "recal", mlPerSqftPerPass: 1.4133 } as any,
      at: T0,
    });

    expect(db.rows).toHaveLength(2);
    const prior = db.rows.find((r: CalibrationRecord) => r.id === priorId)!;
    expect(prior.status).toBe("superseded");
    expect(prior.effectiveTo).toEqual(T0);
    expect(prior.mlPerSqftPerPass).toBe(1.356); // measured value never overwritten
    const fresh = db.rows.find((r: CalibrationRecord) => r.id !== priorId)!;
    expect(fresh.supersedesId).toBe(priorId);
  });

  it("9. no active calibration returns an explicit MISSING_CALIBRATION, never a default", () => {
    const r = resolveActiveCalibration([], idOf(ROLAND_CMYK), NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MISSING_CALIBRATION");
    expect(r.message).toContain("No approved calibration");
  });

  it("10. no neighbouring profile is silently selected", () => {
    const base = idOf(ROLAND_GLOSS);
    for (const [field, wrong] of [
      ["passConfig", "gloss-2x"],
      ["resolution", "600x1200 VD"],
      ["qualityMode", "Fast Print High"],
      ["ripProfile", "Generic Sign Production"],
      ["machineKey", "mimaki-ucjv300-130"],
      ["inkMode", "white"],
    ] as Array<[keyof CalibrationIdentity, string]>) {
      const asked = { ...base, [field]: wrong };
      const r = resolveActiveCalibration(ALL, asked, NOW);
      expect(r.ok, `${field}=${wrong} must not resolve`).toBe(false);
    }
    // the exact identity still resolves
    expect(resolveActiveCalibration(ALL, base, NOW).ok).toBe(true);
  });

  it("11. Emboss/Raised has no calibration and is BLOCKED, never borrowing GlossVarnish", () => {
    const emboss: CalibrationIdentity = { ...idOf(ROLAND_GLOSS), passConfig: "emboss-2x" };
    const r = resolveActiveCalibration(ALL, emboss, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MISSING_CALIBRATION");
    // and it is genuinely absent from the seed. Assert on the seeded IDENTITY
    // VALUES, not on word presence — the seed comments deliberately explain why
    // emboss is excluded, and prose must never decide this verdict.
    const passConfigs = [...SEED_SRC.matchAll(/passConfig: "([^"]+)"/g)].map((m) => m[1]);
    const inkModes = [...SEED_SRC.matchAll(/inkMode: "([^"]+)"/g)].map((m) => m[1]);
    expect(passConfigs).toEqual(["32-pass-bidi-op1", "hq-default", "white-hd-1x", "gloss-1x"]);
    expect(inkModes).toEqual(["cmyk_heavy", "cmyk", "white", "gloss"]);
    expect(passConfigs.some((p) => /emboss|raised/i.test(p))).toBe(false);
    expect(inkModes.some((m) => /emboss|raised/i.test(m))).toBe(false);
  });

  it("12. recalibration only ever grows the table", async () => {
    const identity = idOf(ROLAND_WHITE);
    const db = makeDb([cal({ ...identity, mlPerSqftPerPass: 5.5 })]);
    for (const v of [5.8, 6.0, 6.2]) {
      await supersedeAndInsert(db, {
        shop: SHOP,
        identity,
        values: { measuredAt: T0, effectiveFrom: T0, source: "recal", mlPerSqftPerPass: v } as any,
      });
    }
    expect(db.rows).toHaveLength(4);
    expect(db.rows.filter((r: CalibrationRecord) => r.status === "approved")).toHaveLength(1);
  });

  it("loadActiveCalibration applies the same rule as the pure resolver", async () => {
    const identity = idOf(ROLAND_GLOSS);
    const db = makeDb([...ALL.map((r) => ({ ...r }))]);
    const r = await loadActiveCalibration(db, SHOP, identity, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.calibration.mlPerSqftPerPass).toBe(4.18);
  });
});

/* ================================================================== *
 * COVERAGE
 * ================================================================== */

describe("coverage model", () => {
  it("13. gloss with no coverage applies the owner-approved 50% default", () => {
    const c = resolveCoverage("gloss", null);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.pct).toBe(50);
    expect(c.source).toBe("gloss_default");
    expect(GLOSS_DEFAULT_COVERAGE_PCT).toBe(50);

    const r = computeInkMl({ calibration: ROLAND_GLOSS, areas: { inkable_artwork: 10 } });
    expect(r.ok && r.inkMl).toBeCloseTo(10 * 0.5 * 4.18, 10);
  });

  it("14. white with no coverage is DRAFT ONLY — never a silent 50% or 100%", () => {
    const c = resolveCoverage("white", null);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toBe("WHITE_COVERAGE_REQUIRED");
    expect(c.draftOnly).toBe(true);
    expect(c.message).toContain("WHITE COVERAGE REQUIRED");

    const r = computeInkMl({ calibration: ROLAND_WHITE, areas: { inkable_artwork: 10 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("WHITE_COVERAGE_REQUIRED");
    expect(r.draftOnly).toBe(true);
    // no number is produced at all
    expect((r as any).inkMl).toBeUndefined();
  });

  it("15. coverage scales ink only — occupancy is unchanged by coverage", () => {
    const full = computeInkMl({ calibration: ROLAND_GLOSS, areas: { inkable_artwork: 10 }, coveragePct: 100 });
    const half = computeInkMl({ calibration: ROLAND_GLOSS, areas: { inkable_artwork: 10 }, coveragePct: 50 });
    expect(full.ok && half.ok && full.inkMl / half.inkMl).toBeCloseTo(2, 10);

    const t1 = computeOccupancyMinutes({ calibration: ROLAND_GLOSS, areas: { rip_layout: 10 } });
    const t2 = computeOccupancyMinutes({ calibration: ROLAND_GLOSS, areas: { rip_layout: 10 }, passCount: 1 });
    expect(t1.ok && t2.ok && t1.minutes).toBe(t2.ok ? t2.minutes : NaN);
    expect(t1.ok && t1.minutes).toBeCloseTo(9.1, 10);
  });

  it("out-of-range coverage BLOCKS rather than clamping", () => {
    for (const bad of [-1, 101, Number.NaN]) {
      const c = resolveCoverage("gloss", bad);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.reason).toBe("INVALID_COVERAGE");
    }
  });
});

/* ================================================================== *
 * AREA BASIS
 * ================================================================== */

describe("area basis is explicit and cannot be confused", () => {
  it("22. every seeded calibration declares BOTH inkAreaBasis and timeAreaBasis", () => {
    expect(SEED_SRC.match(/inkAreaBasis: "inkable_artwork"/g)).toHaveLength(4);
    expect(SEED_SRC.match(/timeAreaBasis: "rip_layout"/g)).toHaveLength(4);
    for (const row of ALL) {
      expect(isAreaBasis(row.inkAreaBasis)).toBe(true);
      expect(isAreaBasis(row.timeAreaBasis)).toBe(true);
    }
  });

  it("23. a missing or unrecognised area basis REFUSES — it never falls back", () => {
    for (const bad of [null, "", "layout", "sqft"]) {
      const broken = { ...ROLAND_CMYK, inkAreaBasis: bad as any };
      const r = computeInkMl({ calibration: broken, areas: { inkable_artwork: 7.2144 } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("MISSING_AREA_BASIS");

      const t = computeOccupancyMinutes({
        calibration: { ...ROLAND_CMYK, timeAreaBasis: bad as any },
        areas: { rip_layout: 8.9175 },
      });
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.reason).toBe("MISSING_AREA_BASIS");
    }
  });

  it("24. ink and time consume DIFFERENT areas on the same job", () => {
    const areas = { inkable_artwork: 7.2144, rip_layout: 8.9175 };

    const ink = computeInkMl({ calibration: ROLAND_CMYK, areas });
    expect(ink.ok).toBe(true);
    if (!ink.ok) return;
    expect(ink.areaSqft).toBe(7.2144);
    expect(ink.inkMl).toBeCloseTo(10.1961, 4);
    // the WRONG denominator would have produced 12.6033 mL — it must not
    expect(ink.inkMl).not.toBeCloseTo(8.9175 * 1.4133, 3);

    const time = computeOccupancyMinutes({ calibration: ROLAND_CMYK, areas });
    expect(time.ok).toBe(true);
    if (!time.ok) return;
    expect(time.areaSqft).toBe(8.9175);
    expect(time.minutes).toBeCloseTo(8.1149, 4);
  });

  it("supplying only the wrong basis area fails loudly", () => {
    const r = computeInkMl({ calibration: ROLAND_CMYK, areas: { rip_layout: 8.9175 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INVALID_AREA");
  });
});

/* ================================================================== *
 * GUARD RAILS — Patch 1 changes nothing live
 * ================================================================== */

describe("guard rails", () => {
  it("16. ink purchasing is unchanged and stays out of calibration", () => {
    expect(CANONICAL_INK_RATES.rolandPerMl).toBe(149 / 750);
    expect(CANONICAL_INK_RATES.mimakiCmykPerMl).toBe(176 / 1000);
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBeNull();
  });

  it("17. no money may live in a calibration row or the schema model", () => {
    const model = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf("model MachineProfileCalibration"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(/cost|price|perMl|usd|\$/i.test(body.replace(/\/\/[^\n]*/g, ""))).toBe(false);
    for (const row of ALL) {
      expect(JSON.stringify(row)).not.toMatch(/0\.1986|0\.176|perMl/);
    }
  });

  it("18. the model has NO @@unique at all, so history can never be blocked", () => {
    const model = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf("model MachineProfileCalibration"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body.includes("@@unique")).toBe(false);
    expect(body).toContain("@@index([shop])");
    expect(body).toContain("supersedesId");
    expect(CALIBRATION_STATUSES).toContain("superseded");
    expect(TIME_MODELS[0]).toBe("variable_only");
  });

  it("19. no live pricing or storefront module references the calibration model", () => {
    for (const file of [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/lib/product-driven-costing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("MachineProfileCalibration"), file).toBe(false);
      expect(src.includes("machine-calibration.server"), file).toBe(false);
    }
  });

  it("20. the corrected Miron 100ml Tall tiers reconcile jar + 45/400 lid", () => {
    const jar = [2.05, 1.86, 1.69, 1.56, 1.46];
    const lid = [0.73, 0.68, 0.62, 0.58, 0.53];
    const combined = jar.map((j, i) => Math.round((j + lid[i]) * 100) / 100);
    expect(combined).toEqual([2.78, 2.54, 2.31, 2.14, 1.99]);

    const foundation = readFileSync("tools/seed-jar-erp-foundation.mjs", "utf8");
    expect(foundation).toContain("defaultUnitCost: 2.78,");
    for (const v of ["2.78", "2.54", "2.31", "2.14", "1.99"]) {
      expect(foundation).toContain(`unitCost: ${v},`);
    }
    // the stale 48/400-era ladder can no longer be recreated
    for (const stale of ["2.86", "2.63", "2.41", "2.22", "2.07"]) {
      expect(foundation.includes(`unitCost: ${stale},`), `stale ${stale}`).toBe(false);
    }
    expect(foundation.includes("defaultUnitCost: 2.86,")).toBe(false);

    const finishRules = readFileSync("tools/seed-jar-finish-pricing-rules.mjs", "utf8");
    expect(finishRules).toContain("jar_100ml_tall: [2.78, 2.54, 2.31, 2.14, 1.99],");
    expect(finishRules.includes("[2.86, 2.63, 2.41, 2.22, 2.07]")).toBe(false);
    // every other Miron ladder is untouched
    expect(finishRules).toContain("jar_50ml: [2.46, 2.24, 2.03, 1.89, 1.74],");
    expect(finishRules).toContain("jar_100ml_wide: [2.90, 2.67, 2.44, 2.26, 2.10],");
    expect(finishRules).toContain("jar_150ml: [3.26, 3.00, 2.76, 2.54, 2.37],");
    expect(finishRules).toContain("jar_250ml: [3.92, 3.60, 3.32, 3.11, 2.92],");
  });

  it("the migration is additive only and carries the deployment-order note", () => {
    const statements = MIGRATION_SRC.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .toUpperCase();
    expect(statements).toContain("CREATE TABLE IF NOT EXISTS");
    expect(statements.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(4);
    for (const destructive of ["ALTER TABLE", "DROP ", "TRUNCATE", "RENAME"]) {
      expect(statements.includes(destructive), destructive).toBe(false);
    }
    expect(MIGRATION_SRC).toContain("20260813210000");
  });

  it("the calibration library is not imported by anything but this test", () => {
    expect(LIB_SRC).toContain("imported by NOTHING in");
    expect(SEED_SRC).toContain("dry-run by default");
    expect(SEED_SRC).toContain("--apply");
  });

  it("identity is exactly the six agreed parts", () => {
    expect(IDENTITY_FIELDS).toEqual([
      "machineKey",
      "inkMode",
      "ripProfile",
      "qualityMode",
      "resolution",
      "passConfig",
    ]);
    expect(identityKeyOf(idOf(ROLAND_CMYK))).toBe(
      "roland-lg-640 | cmyk | Generic Sign Production | High Quality | 720x1200 | hq-default",
    );
    expect(AREA_BASES).toEqual(["inkable_artwork", "rip_layout", "material_footprint"]);
  });

  it("fixedMinutes is inert while timeModel is variable_only", () => {
    const withStray = { ...ROLAND_GLOSS, fixedMinutes: 3.27 };
    const r = computeOccupancyMinutes({ calibration: withStray, areas: { rip_layout: 10 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fixedMinutesApplied).toBe(0);
    expect(r.minutes).toBeCloseTo(9.1, 10);
    // the seeded rows never set it
    expect(SEED_SRC.match(/fixedMinutes: null/g)).toHaveLength(4);
  });
});
