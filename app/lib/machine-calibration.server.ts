// Patch 1 (17D.1) — machine/profile calibration resolution.
//
// PURE + DEPENDENCY-FREE. This module is deliberately imported by NOTHING in
// the live application: no route, no pricing engine, no storefront path. It is
// foundation only, so Patch 1 cannot change a single price. The one consumer is
// tests/machine-calibration.test.ts.
//
// Three rules shape every function here:
//
//   1. AREA BASIS IS EXPLICIT. Ink and time are measured against DIFFERENT
//      areas (the Roland jar test: ripLayout 8.9175 sqft vs inkableArtwork
//      7.2144 sqft on the same job). Nothing computes a value without knowing
//      which basis its calibration was measured on — an absent basis FAILS,
//      it never falls back.
//
//   2. NO SILENT NEIGHBOURS. Resolution matches all six identity parts exactly.
//      A missing calibration is reported as missing; a near-miss profile,
//      different resolution, or different pass count is never substituted.
//
//   3. NO MONEY. Calibration owns mL/sqft/pass and minutes/sqft. Purchasing
//      owns $/mL. True cost later resolves as
//      inkCost = calculatedInkMl * currentCanonicalInkCostPerMl.

export const CALIBRATION_ENGINE_VERSION = "17D.1-machine-profile-calibration";

/* ------------------------------------------------------------------ *
 * Vocabularies (validated as data, not Prisma enums — a new basis or
 * status later is a data change, never a migration)
 * ------------------------------------------------------------------ */

export const AREA_BASES = ["inkable_artwork", "rip_layout", "material_footprint"] as const;
export type AreaBasis = (typeof AREA_BASES)[number];

export const CALIBRATION_STATUSES = ["approved", "superseded", "draft", "rejected"] as const;
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];

export const TIME_MODELS = ["variable_only", "fixed_plus_variable"] as const;
export type TimeModel = (typeof TIME_MODELS)[number];

export const INK_MODES = ["cmyk", "cmyk_heavy", "white", "gloss"] as const;
export type InkMode = (typeof INK_MODES)[number];

export function isAreaBasis(value: unknown): value is AreaBasis {
  return (AREA_BASES as readonly string[]).includes(String(value ?? ""));
}

/**
 * Gloss default coverage — owner-approved and editable.
 * White has NO default on purpose: an unspecified white coverage is a DRAFT
 * ONLY condition, never a silently assumed 50% or 100%.
 */
export const GLOSS_DEFAULT_COVERAGE_PCT = 50;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type CalibrationIdentity = {
  machineKey: string;
  inkMode: string;
  ripProfile: string;
  qualityMode: string;
  resolution: string;
  passConfig: string;
};

export const IDENTITY_FIELDS: Array<keyof CalibrationIdentity> = [
  "machineKey",
  "inkMode",
  "ripProfile",
  "qualityMode",
  "resolution",
  "passConfig",
];

export type CalibrationRecord = CalibrationIdentity & {
  id: string;
  shop: string;
  mlPerSqftPerPass: number | null;
  inkAreaBasis: string | null;
  minutesPerSqft: number | null;
  timeAreaBasis: string | null;
  fixedMinutes: number | null;
  timeModel: string;
  coverageBasisPct: number | null;
  measuredAt: Date;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: string;
  source: string;
  notes: string | null;
  supersedesId: string | null;
  createdAt?: Date;
};

/** Stable debug/log key. Never used for matching — matching is field-by-field. */
export function identityKeyOf(identity: CalibrationIdentity): string {
  return IDENTITY_FIELDS.map((field) => String(identity[field] ?? "")).join(" | ");
}

export type MissingReason =
  | "MISSING_CALIBRATION"
  | "MISSING_INK_CALIBRATION"
  | "MISSING_TIME_CALIBRATION"
  | "MISSING_AREA_BASIS"
  | "WHITE_COVERAGE_REQUIRED"
  | "INVALID_COVERAGE"
  | "INVALID_AREA";

export type CalibrationResolution =
  | { ok: true; calibration: CalibrationRecord }
  | { ok: false; reason: "MISSING_CALIBRATION"; identity: CalibrationIdentity; message: string };

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

function identityMatches(row: CalibrationRecord, identity: CalibrationIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => String(row[field] ?? "") === String(identity[field] ?? ""));
}

function isCurrentlyEffective(row: CalibrationRecord, at: Date): boolean {
  if (row.status !== "approved") return false;
  if (!(row.effectiveFrom instanceof Date)) return false;
  if (row.effectiveFrom.getTime() > at.getTime()) return false;
  if (row.effectiveTo && row.effectiveTo.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * THE resolution rule. Pure so it is testable without a database.
 *
 * Exact match on all six identity parts, status "approved", and inside the
 * effective window. Ties break on the most recent effectiveFrom, then the most
 * recent createdAt, so the answer is deterministic even if the application
 * transaction is ever bypassed and two approved rows coexist.
 *
 * Zero matches returns MISSING_CALIBRATION. It never widens the search, never
 * relaxes a field, and never returns a superseded/draft/rejected row.
 */
export function resolveActiveCalibration(
  rows: CalibrationRecord[],
  identity: CalibrationIdentity,
  at: Date = new Date(),
): CalibrationResolution {
  const candidates = (rows || []).filter(
    (row) => identityMatches(row, identity) && isCurrentlyEffective(row, at),
  );

  if (!candidates.length) {
    return {
      ok: false,
      reason: "MISSING_CALIBRATION",
      identity,
      message: `No approved calibration for ${identityKeyOf(identity)} at ${at.toISOString()}.`,
    };
  }

  candidates.sort((a, b) => {
    const byFrom = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    if (byFrom !== 0) return byFrom;
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  });

  return { ok: true, calibration: candidates[0] };
}

/** Database-backed sibling. Same rule; the filtering stays in one place. */
export async function loadActiveCalibration(
  db: any,
  shop: string,
  identity: CalibrationIdentity,
  at: Date = new Date(),
): Promise<CalibrationResolution> {
  const rows: CalibrationRecord[] = await db.machineProfileCalibration.findMany({
    where: { shop, status: "approved", ...identity },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });
  return resolveActiveCalibration(rows, identity, at);
}

/** Full history for one identity, newest first. Superseded rows always included. */
export async function loadCalibrationHistory(
  db: any,
  shop: string,
  identity: CalibrationIdentity,
): Promise<CalibrationRecord[]> {
  return db.machineProfileCalibration.findMany({
    where: { shop, ...identity },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

export type CoverageSource = "explicit" | "gloss_default" | "heavy_reference";

export type CoverageResolution =
  | { ok: true; fraction: number; pct: number; source: CoverageSource }
  | { ok: false; reason: "WHITE_COVERAGE_REQUIRED" | "INVALID_COVERAGE"; draftOnly: true; message: string };

/**
 * Coverage scales INK ONLY. It never reduces machine occupancy — the head
 * traverses the layout regardless of how much of it carries ink.
 *
 *   white  -> no default; missing coverage is DRAFT ONLY
 *   gloss  -> 50% owner-approved default
 *   cmyk   -> 100%; the heavy/full-colour reference rate already embodies
 *             production coverage, so no separate percentage is invented
 */
export function resolveCoverage(inkMode: string, coveragePct: number | null | undefined): CoverageResolution {
  if (coveragePct != null) {
    if (!Number.isFinite(coveragePct) || coveragePct < 0 || coveragePct > 100) {
      return {
        ok: false,
        reason: "INVALID_COVERAGE",
        draftOnly: true,
        message: `Coverage must be between 0 and 100 (received ${coveragePct}).`,
      };
    }
    return { ok: true, fraction: coveragePct / 100, pct: coveragePct, source: "explicit" };
  }

  if (inkMode === "white") {
    return {
      ok: false,
      reason: "WHITE_COVERAGE_REQUIRED",
      draftOnly: true,
      message:
        "WHITE COVERAGE REQUIRED — DRAFT ONLY. White coverage has no default; supply the actual coverage percentage. No final true cost, margin, or GP/hour may be claimed without it.",
    };
  }

  if (inkMode === "gloss") {
    return {
      ok: true,
      fraction: GLOSS_DEFAULT_COVERAGE_PCT / 100,
      pct: GLOSS_DEFAULT_COVERAGE_PCT,
      source: "gloss_default",
    };
  }

  return { ok: true, fraction: 1, pct: 100, source: "heavy_reference" };
}

/* ------------------------------------------------------------------ *
 * Computation
 * ------------------------------------------------------------------ */

export type InkResult =
  | {
      ok: true;
      inkMl: number;
      areaBasis: AreaBasis;
      areaSqft: number;
      coveragePct: number;
      coverageSource: CoverageSource;
      passCount: number;
      mlPerSqftPerPass: number;
    }
  | { ok: false; reason: MissingReason; draftOnly?: true; message: string };

/**
 * inkMl = areaSqft(for the calibration's OWN basis) x coverage x mlPerSqftPerPass x passes
 *
 * The caller supplies areas per basis rather than a single number, so the
 * calibration selects its own denominator. Handing this function the wrong
 * area is not possible without deliberately mislabelling the input.
 */
export function computeInkMl(input: {
  calibration: CalibrationRecord;
  areas: Partial<Record<AreaBasis, number>>;
  coveragePct?: number | null;
  passCount?: number;
}): InkResult {
  const cal = input.calibration;

  if (cal.mlPerSqftPerPass == null || !Number.isFinite(cal.mlPerSqftPerPass) || cal.mlPerSqftPerPass <= 0) {
    return {
      ok: false,
      reason: "MISSING_INK_CALIBRATION",
      message: `No ink calibration (mlPerSqftPerPass) on ${identityKeyOf(cal)}.`,
    };
  }

  if (!isAreaBasis(cal.inkAreaBasis)) {
    return {
      ok: false,
      reason: "MISSING_AREA_BASIS",
      message: `Calibration ${identityKeyOf(cal)} has no recognised inkAreaBasis (got ${JSON.stringify(
        cal.inkAreaBasis,
      )}). Refusing to guess a denominator.`,
    };
  }

  const basis = cal.inkAreaBasis as AreaBasis;
  const areaSqft = input.areas?.[basis];
  if (areaSqft == null || !Number.isFinite(areaSqft) || areaSqft <= 0) {
    return {
      ok: false,
      reason: "INVALID_AREA",
      message: `This calibration is measured on "${basis}" area; no usable ${basis} sqft was supplied.`,
    };
  }

  const coverage = resolveCoverage(cal.inkMode, input.coveragePct);
  if (!coverage.ok) {
    return { ok: false, reason: coverage.reason, draftOnly: true, message: coverage.message };
  }

  const passCount = Math.max(1, Math.floor(input.passCount ?? 1));
  const inkMl = areaSqft * coverage.fraction * cal.mlPerSqftPerPass * passCount;

  return {
    ok: true,
    inkMl,
    areaBasis: basis,
    areaSqft,
    coveragePct: coverage.pct,
    coverageSource: coverage.source,
    passCount,
    mlPerSqftPerPass: cal.mlPerSqftPerPass,
  };
}

export type OccupancyResult =
  | {
      ok: true;
      minutes: number;
      areaBasis: AreaBasis;
      areaSqft: number;
      passCount: number;
      minutesPerSqft: number;
      timeModel: string;
      fixedMinutesApplied: number;
    }
  | { ok: false; reason: MissingReason; message: string };

/**
 * minutes = areaSqft(for the calibration's OWN basis) x minutesPerSqft x passes
 *
 * Coverage is deliberately NOT applied — a 20%-covered layout still requires
 * the head to traverse the whole layout. While timeModel is "variable_only",
 * fixedMinutes is ignored even when populated, so a stray value cannot leak
 * into true cost.
 */
export function computeOccupancyMinutes(input: {
  calibration: CalibrationRecord;
  areas: Partial<Record<AreaBasis, number>>;
  passCount?: number;
}): OccupancyResult {
  const cal = input.calibration;

  if (cal.minutesPerSqft == null || !Number.isFinite(cal.minutesPerSqft) || cal.minutesPerSqft <= 0) {
    return {
      ok: false,
      reason: "MISSING_TIME_CALIBRATION",
      message: `No time calibration (minutesPerSqft) on ${identityKeyOf(cal)}.`,
    };
  }

  if (!isAreaBasis(cal.timeAreaBasis)) {
    return {
      ok: false,
      reason: "MISSING_AREA_BASIS",
      message: `Calibration ${identityKeyOf(cal)} has no recognised timeAreaBasis (got ${JSON.stringify(
        cal.timeAreaBasis,
      )}). Refusing to guess a denominator.`,
    };
  }

  const basis = cal.timeAreaBasis as AreaBasis;
  const areaSqft = input.areas?.[basis];
  if (areaSqft == null || !Number.isFinite(areaSqft) || areaSqft <= 0) {
    return {
      ok: false,
      reason: "INVALID_AREA",
      message: `This calibration is measured on "${basis}" area; no usable ${basis} sqft was supplied.`,
    };
  }

  const passCount = Math.max(1, Math.floor(input.passCount ?? 1));
  const fixedMinutesApplied = cal.timeModel === "fixed_plus_variable" ? cal.fixedMinutes ?? 0 : 0;
  const minutes = fixedMinutesApplied + areaSqft * cal.minutesPerSqft * passCount;

  return {
    ok: true,
    minutes,
    areaBasis: basis,
    areaSqft,
    passCount,
    minutesPerSqft: cal.minutesPerSqft,
    timeModel: cal.timeModel,
    fixedMinutesApplied,
  };
}

/* ------------------------------------------------------------------ *
 * Append-only recalibration
 * ------------------------------------------------------------------ */

/**
 * Recalibrate WITHOUT destroying history.
 *
 * Inside one transaction: mark every currently-approved row for this exact
 * identity as superseded (setting effectiveTo), then INSERT the new row with
 * supersedesId pointing at the most recent one. Nothing is deleted and no
 * measured value is ever overwritten, so the full chain stays queryable.
 *
 * This is where "one current approved record per identity" is enforced —
 * deliberately in the application rather than a database unique constraint,
 * which would otherwise forbid multiple superseded rows for the same identity.
 */
export async function supersedeAndInsert(
  db: any,
  input: {
    shop: string;
    identity: CalibrationIdentity;
    values: Partial<CalibrationRecord> & { measuredAt: Date; effectiveFrom: Date; source: string };
    at?: Date;
  },
): Promise<any> {
  const at = input.at ?? new Date();

  return db.$transaction(async (tx: any) => {
    const current: CalibrationRecord[] = await tx.machineProfileCalibration.findMany({
      where: { shop: input.shop, status: "approved", ...input.identity },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });

    for (const row of current) {
      await tx.machineProfileCalibration.update({
        where: { id: row.id },
        data: { status: "superseded", effectiveTo: row.effectiveTo ?? at },
      });
    }

    return tx.machineProfileCalibration.create({
      data: {
        shop: input.shop,
        ...input.identity,
        ...input.values,
        status: "approved",
        supersedesId: current[0]?.id ?? null,
      },
    });
  });
}
