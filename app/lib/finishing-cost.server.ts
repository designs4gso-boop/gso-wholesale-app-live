// Patch 2C-3A (17D.4) — THE canonical cutting + weeding cost stage.
//
// Product-agnostic, exactly like the nesting engine it consumes. Jars,
// stickers/labels, 4x5 sticker bags, stock bags, DTP, boxes and banners all
// cost their cutting and weeding through this file. Families contribute
// geometry via a NestingResult plus an explicit cut-geometry map; they never
// get their own finishing maths.
//
// 2C-3A CORRECTION — the two mistakes this file no longer makes:
//
//   1. SHARED EDGES. GSO labels are cut INDIVIDUALLY; adjacent labels do not
//      share a physical cut line. The default model is therefore
//      SEPARATED_RECTANGLE (qty x perimeter), NOT a shared grid. shared_grid
//      exists but must be asked for explicitly and is never inferred from
//      rows/columns.
//   2. ARTBOARD != CUTLINE. The cutter follows the real cutline. A 4x5 bag
//      label is a 4.00 x 5.00in ARTBOARD cut at a 3.875 x 4.875in CUTLINE by
//      cutline is an owner-supplied fact and is NEVER derived from bleed or
//      inferred from the artboard.
//
// THREE THINGS THIS FILE STILL REFUSES TO DO
//   - Sum raw RasterLink cut ROWS (physical event identity is importId +
//     startedAt + completedAt + result; row-summing overstated 29-49%).
//   - Carry the legacy complexity multipliers. Cutting is path/time based.
//   - Invent geometry or a rate. Missing either one is flagged, not guessed.
//
// Pure: no db, no network, no clock.

import type { NestingResult, NestingRunResult, NestingBand } from "./nesting-engine.server";
import type { CostCategory } from "./true-cost-engine.server";

export const FINISHING_COST_VERSION = "17D.4A-finishing-cost";

/* ------------------------------------------------------------------ *
 * Owner costing contract
 * ------------------------------------------------------------------ */

export const CUT_EQUIPMENT_RATE_PER_HOUR = 8;
export const CUT_OPERATOR_ATTENTION_PER_HOUR = 2.5;
/** Display convenience only; the engine never sees this merged number. */
export const CUT_COMBINED_BURDEN_PER_HOUR = CUT_EQUIPMENT_RATE_PER_HOUR + CUT_OPERATOR_ATTENTION_PER_HOUR;

/* 2026-10-05: the weeding numbers now come from ONE object —
 * weeding-standard.ts WEEDING_STANDARD — initialised to exactly these values
 * ($20/hr, 15 pages/hr, 54in reference page). Re-exported under the names the
 * rest of the engine and the tests already use, so nothing about the cost
 * changes; a future owner-measured calibration edits that one object. */
import {
  WEEDING_COST_PER_REFERENCE_PAGE,
  WEEDING_LABOR_RATE_PER_HOUR,
  WEEDING_PAGES_PER_HOUR,
  WEEDING_REFERENCE_PAGE_IN,
  WEEDING_STANDARD,
} from "./weeding-standard";
export { WEEDING_COST_PER_REFERENCE_PAGE, WEEDING_LABOR_RATE_PER_HOUR, WEEDING_PAGES_PER_HOUR, WEEDING_REFERENCE_PAGE_IN, WEEDING_STANDARD };
export const WEEDING_REQUIRED_BY_DEFAULT = true;

export const FINISHING_REASONS = {
  /** Contour length is exact but its cutting RATE is borrowed. -> PROVISIONAL */
  cutPathEstimateRequired: "CUT_PATH_ESTIMATE_REQUIRED",
  /** No measured rate for this machine + mode. -> DRAFT_ONLY */
  cutCalibrationPending: "CUT_CALIBRATION_PENDING",
  /** Rate is numeric but the geometry behind it was never confirmed. -> PROVISIONAL */
  cutGeometryUnverified: "CUT_GEOMETRY_UNVERIFIED",
  /**
   * 2C-3B: the ACTUAL cutline is unknown. The 4x5 benchmark proved an artboard
   * is not a safe substitute (4.00x5.00 artboard vs 3.875x4.875 cutline), and the
   * rule is NOT that a cutline is always smaller — it is simply that an unknown
   * cutline is unknown. Such a job is never quote-ready. -> DRAFT_ONLY
   */
  cutlineGeometryRequired: "CUTLINE_GEOMETRY_REQUIRED",
} as const;

/* ------------------------------------------------------------------ *
 * THE HISTORICAL CUTTER BENCHMARK — a measurement, NOT current geometry
 *
 * 2D-4C2C. These constants record ONE observed job and exist solely to derive
 * a cutting SPEED from it. They are deliberately NOT the cutline authority:
 * current production geometry comes from gso-cutline.ts (-0.0625in inward
 * offset), and nothing here may be used to shape a job's cut path.
 *
 * THE OBSERVED JOB
 *   130 x 4x5 bag labels, individually cut, NORMAL mode, 09:46 -> 09:57.
 *   Owner-confirmed cutline 3.79 x 4.81in.
 *     perimeter = 2 x (3.79 + 4.81) = 17.20 in
 *     total     = 130 x 17.20       = 2236.0 in over 11.0 minutes
 *
 * WHY THIS IS NOT REWRITTEN TO THE CURRENT RULE. A -0.0625in offset on a
 * 4.00 x 5.00 artboard gives 3.875 x 4.875, so the recorded 3.79 x 4.81 cannot
 * have come from today's rule: its implied insets are 0.105in and 0.095in per
 * edge — asymmetric, and neither is 0.0625. The measurement therefore predates
 * or diverges from the current standard, and restating it in terms of that
 * standard would silently invent a path length nobody timed. The 2D-4C2A
 * attempt to do exactly that was reverted here after the 2D-4C2B audit.
 *
 * A measured historical fact and a current production rule are allowed to
 * disagree; forcing them to agree destroys the measurement.
 *
 * CONSEQUENCE, STATED PLAINLY: today's 4x5 bag labels are cut at
 * 3.875 x 4.875in — a slightly LONGER path than the 3.79 x 4.81 job this rate
 * was timed on — so their cut time is priced marginally higher than the
 * benchmark job's was. That is correct: it reflects the geometry actually cut.
 *
 * SUPERSESSION. A fresh owner-timed cut of a known-geometry job replaces this
 * record outright. The Roland entries below would benefit most: their piece
 * count was inferred from layout area and is already flagged unverified.
 * ------------------------------------------------------------------ */

/** Artboard of the OBSERVED job. Historical context only. */
export const BENCHMARK_ARTBOARD_IN = { widthIn: 4.0, heightIn: 5.0 } as const;

/**
 * Cutline AS MEASURED on the observed job — owner-confirmed 2C-3A.
 *
 * NEVER a current cutline. Deriving a live job's geometry from this would
 * reintroduce the second authority the -0.0625 rule exists to remove; use
 * deriveGsoLabelCutlineFromArtboard from gso-cutline.ts instead.
 */
export const BENCHMARK_MEASURED_CUTLINE_IN = { widthIn: 3.79, heightIn: 4.81 } as const;

export const BENCHMARK_QTY = 130;
export const BENCHMARK_PERIMETER_IN = 2 * (BENCHMARK_MEASURED_CUTLINE_IN.widthIn + BENCHMARK_MEASURED_CUTLINE_IN.heightIn); // 17.20
export const CUT_REFERENCE_PATH_IN = BENCHMARK_QTY * BENCHMARK_PERIMETER_IN; // 2236.0

/* ------------------------------------------------------------------ *
 * Cut-mode calibration
 *
 * `normal` and `normal_perf` are SEPARATE configured modes, each measured end
 * to end. normal_perf is NEVER modelled as normal plus a perf stage.
 *
 * classification:
 *   OWNER_MEASURED                  duration AND geometry both owner-confirmed
 *   DERIVED_FROM_CONFIRMED_GEOMETRY duration owner-given, geometry confirmed
 *                                   to be the same 130-piece reference job
 *   UNVERIFIED_GEOMETRY             duration owner-given, but the piece count
 *                                   behind it was never confirmed — numeric,
 *                                   and flagged PROVISIONAL wherever used
 * ------------------------------------------------------------------ */

export type CutMode = "normal" | "normal_perf";

export type CutModeCalibration = {
  inchesPerMinute: number;
  benchmarkMinutes: number;
  benchmarkPathIn: number;
  classification: "OWNER_MEASURED" | "DERIVED_FROM_CONFIRMED_GEOMETRY" | "UNVERIFIED_GEOMETRY";
  source: string;
  /** Set when merely using this rate must make the job PROVISIONAL. */
  provisional?: string;
};

export const CUT_MODE_CALIBRATION: Record<string, Partial<Record<CutMode, CutModeCalibration>>> = {
  "mimaki-ucjv300-130": {
    normal: {
      inchesPerMinute: CUT_REFERENCE_PATH_IN / 11.0, // 203.2727…
      benchmarkMinutes: 11.0,
      benchmarkPathIn: CUT_REFERENCE_PATH_IN,
      classification: "OWNER_MEASURED",
      source: "Owner controlled benchmark: 130 x 4x5 bag labels, NORMAL cut only, 09:46 -> 09:57 = 11.0 min. Cutline 3.79 x 4.81in confirmed by the owner, individually cut = 2236.0in. HISTORICAL MEASUREMENT — not current cutline geometry; live jobs derive theirs from the -0.0625in offset rule (gso-cutline.ts).",
    },
    normal_perf: {
      inchesPerMinute: CUT_REFERENCE_PATH_IN / 20.0, // 111.8
      benchmarkMinutes: 20.0,
      benchmarkPathIn: CUT_REFERENCE_PATH_IN,
      classification: "DERIVED_FROM_CONFIRMED_GEOMETRY",
      source: "Owner benchmark: the SAME 130-piece 4x5 layout in the NORMAL+PERF configured mode, 20 min. Recalculated on the measured 2236.0in cutline path.",
    },
  },
  "roland-lg-640": {
    normal: {
      inchesPerMinute: CUT_REFERENCE_PATH_IN / 9.0, // 248.444…
      benchmarkMinutes: 9.0,
      benchmarkPathIn: CUT_REFERENCE_PATH_IN,
      classification: "UNVERIFIED_GEOMETRY",
      source: "Owner benchmark: 4x5 layout, NORMAL cut only, 9 min. The 130-piece count is INFERRED from the reported ~18.19 sqft layout, never owner-stated.",
      provisional: "CUT_GEOMETRY_UNVERIFIED: the Roland NORMAL benchmark duration is owner-given but its piece count was inferred from layout area, not confirmed. The rate is numeric but unverified.",
    },
    normal_perf: {
      inchesPerMinute: CUT_REFERENCE_PATH_IN / 16.0, // 139.75
      benchmarkMinutes: 16.0,
      benchmarkPathIn: CUT_REFERENCE_PATH_IN,
      classification: "UNVERIFIED_GEOMETRY",
      source: "Owner benchmark: 4x5 layout, NORMAL+PERF configured mode, 16 min. The 130-piece count is INFERRED from the reported ~18.16 sqft layout, never owner-stated.",
      provisional: "CUT_GEOMETRY_UNVERIFIED: the Roland NORMAL+PERF benchmark duration is owner-given but its piece count was inferred from layout area, not confirmed. The rate is numeric but unverified.",
    },
  },
};

export function resolveCutCalibration(machineKey: string, mode: CutMode): CutModeCalibration | null {
  return CUT_MODE_CALIBRATION[machineKey]?.[mode] ?? null;
}

/* ------------------------------------------------------------------ *
 * Cut geometry — supplied per band groupKey, never inferred
 * ------------------------------------------------------------------ */

export type CutPathModel = "separated_rectangle" | "contour" | "shared_grid";

export type CutGeometry = {
  /** Defaults: contour for a circle bbox, separated_rectangle for everything else. */
  model?: CutPathModel;
  /** REAL cutline, not the artboard. Owner-supplied; never derived from bleed. */
  cutWidthIn?: number;
  cutHeightIn?: number;
  /** Contour circles. */
  cutDiameterIn?: number;
  note?: string;
};

export type CutGeometryMap = Record<string, CutGeometry>;

export type CutPathBand = {
  groupKey: string;
  shapeType: string;
  model: CutPathModel;
  columns: number;
  rows: number;
  itemsPlaced: number;
  /** The dimensions the CUTTER used — cutline when supplied, artboard when not. */
  cutWidthIn: number;
  cutHeightIn: number;
  perimeterIn: number;
  /**
   * When cutlineKnown is false this is a DIAGNOSTIC estimate built from the
   * artboard. It is never canonical and never clears the blocker.
   */
  pathIn: number;
  /** False = the ACTUAL cutline is unknown -> the job BLOCKS. */
  cutlineKnown: boolean;
  /** True when a length or rate here rests on something unmeasured. */
  estimateRequired: boolean;
  estimateReason: string | null;
  detail: string;
};

export function bandCutPath(band: NestingBand, geometry?: CutGeometry): CutPathBand {
  const shapeType = band.shapeType || "rect";
  const model: CutPathModel = geometry?.model ?? (shapeType === "circle_bbox" ? "contour" : "separated_rectangle");
  const qty = band.itemsPlaced;

  if (model === "shared_grid") {
    // Only when a family PROVES its production shares cut lines. Never a default.
    const pathIn = (band.columns + 1) * band.bandFeedIn + (band.rows + 1) * band.nestWidthIn;
    return {
      groupKey: band.groupKey, shapeType, model, columns: band.columns, rows: band.rows, itemsPlaced: qty,
      cutWidthIn: band.placedWidthIn, cutHeightIn: band.placedHeightIn,
      perimeterIn: 0, pathIn, cutlineKnown: true, estimateRequired: false, estimateReason: null,
      detail: `shared grid: (${band.columns}+1) x ${band.bandFeedIn.toFixed(3)}in + (${band.rows}+1) x ${band.nestWidthIn.toFixed(3)}in — explicitly requested; the path is fixed by the LAYOUT, so no per-item cutline is involved`,
    };
  }

  if (model === "contour") {
    const hasCircle = geometry?.cutDiameterIn != null;
    const hasRect = geometry?.cutWidthIn != null && geometry?.cutHeightIn != null;
    const diameter = geometry?.cutDiameterIn ?? band.placedWidthIn;
    const perimeterIn = hasCircle || (shapeType === "circle_bbox" && !hasRect)
      ? Math.PI * diameter
      : 2 * ((geometry?.cutWidthIn ?? band.placedWidthIn) + (geometry?.cutHeightIn ?? band.placedHeightIn));
    return {
      groupKey: band.groupKey, shapeType, model, columns: band.columns, rows: band.rows, itemsPlaced: qty,
      cutWidthIn: diameter, cutHeightIn: diameter, perimeterIn, pathIn: perimeterIn * qty,
      cutlineKnown: hasCircle || hasRect,
      estimateRequired: true,
      estimateReason: hasCircle || hasRect
        ? `${band.groupKey} cuts on a contour and no controlled contour benchmark exists — the LENGTH is exact geometry, the RATE is borrowed from straight cutting.`
        : `${band.groupKey} cuts on a contour and NO actual contour geometry was supplied — the bounding box ${band.placedWidthIn}in stands in as a DIAGNOSTIC estimate only.`,
      detail: `contour: ${qty} x ${perimeterIn.toFixed(4)}in outline${hasCircle || hasRect ? "" : " (BOUNDING-BOX DIAGNOSTIC — actual contour geometry unknown)"}`,
    };
  }

  // SEPARATED_RECTANGLE — the GSO default. Every label cut on its own outline.
  const hasCutline = geometry?.cutWidthIn != null && geometry?.cutHeightIn != null;
  const cutWidthIn = geometry?.cutWidthIn ?? band.placedWidthIn;
  const cutHeightIn = geometry?.cutHeightIn ?? band.placedHeightIn;
  const perimeterIn = 2 * (cutWidthIn + cutHeightIn);
  return {
    groupKey: band.groupKey, shapeType, model, columns: band.columns, rows: band.rows, itemsPlaced: qty,
    cutWidthIn, cutHeightIn, perimeterIn, pathIn: perimeterIn * qty,
    cutlineKnown: hasCutline,
    estimateRequired: !hasCutline,
    estimateReason: hasCutline
      ? null
      : `${band.groupKey} has no owner-supplied cutline. The ARTBOARD ${band.placedWidthIn} x ${band.placedHeightIn}in stands in as a DIAGNOSTIC estimate ONLY — an artboard is not a safe substitute for a cutline in either direction.`,
    detail: `separated rectangles: ${qty} x 2 x (${cutWidthIn} + ${cutHeightIn}) = ${(perimeterIn * qty).toFixed(2)}in${hasCutline ? " (owner cutline)" : " (ARTBOARD DIAGNOSTIC — actual cutline unknown)"}`,
  };
}

export type CutPathRun = { key: string; bands: CutPathBand[]; pathIn: number; estimateRequired: boolean };

export function runCutPath(run: NestingRunResult, geometry: CutGeometryMap = {}): CutPathRun {
  const bands = run.bands.map((b) => bandCutPath(b, geometry[b.groupKey]));
  return {
    key: run.key,
    bands,
    pathIn: bands.reduce((s, b) => s + b.pathIn, 0),
    estimateRequired: bands.some((b) => b.estimateRequired),
  };
}

/* ------------------------------------------------------------------ *
 * Weeding — unchanged by 2C-3A
 * ------------------------------------------------------------------ */

export type WeedingRun = { key: string; feedLengthIn: number; pages: number };

/** ceil PER PHYSICAL RUN, then sum. Never ceil the combined feed. */
export function weedingPagesForRun(feedLengthIn: number): number {
  if (!(feedLengthIn > 0)) return 0;
  return Math.ceil(feedLengthIn / WEEDING_REFERENCE_PAGE_IN);
}

export function computeWeeding(runs: Array<{ key: string; feedLengthIn: number }>, requiresWeeding = WEEDING_REQUIRED_BY_DEFAULT) {
  if (!requiresWeeding) return { requiresWeeding: false, runs: [] as WeedingRun[], totalPages: 0, cost: 0 };
  const detail: WeedingRun[] = runs.map((r) => ({ key: r.key, feedLengthIn: r.feedLengthIn, pages: weedingPagesForRun(r.feedLengthIn) }));
  const totalPages = detail.reduce((s, r) => s + r.pages, 0);
  return { requiresWeeding: true, runs: detail, totalPages, cost: totalPages * WEEDING_COST_PER_REFERENCE_PAGE };
}

/* ------------------------------------------------------------------ *
 * The stage builder
 * ------------------------------------------------------------------ */

export type FinishingStage = {
  key: string;
  label: string;
  amount: number;
  category?: CostCategory;
  formula?: string;
  note?: string;
  provisional?: string;
  blocker?: string;
};

export type FinishingInput = {
  nesting: NestingResult;
  machineKey: string;
  cutMode: CutMode;
  /** Cut geometry per band groupKey. Missing entries fall back to the artboard, flagged. */
  cutGeometry?: CutGeometryMap;
  requiresWeeding?: boolean;
  requiresCutting?: boolean;
};

export type FinishingResult = {
  version: string;
  stages: FinishingStage[];
  cutPathIn: number;
  cutMinutes: number | null;
  cutHours: number | null;
  equipmentRecovery: number;
  operatorAttention: number;
  weedingPages: number;
  weedingCost: number;
  runs: CutPathRun[];
  calibration: CutModeCalibration | null;
  /** Band groupKeys whose ACTUAL cutline is unknown. Non-empty => blocked. */
  cutlineMissingBands: string[];
  /** True when cutPathIn is an artboard/bbox estimate, not canonical geometry. */
  cutPathIsDiagnosticOnly: boolean;
  blockers: string[];
  reasons: string[];
};

export function computeFinishing(input: FinishingInput): FinishingResult {
  const requiresCutting = input.requiresCutting ?? true;
  const stages: FinishingStage[] = [];
  const reasons: string[] = [];

  const runs = input.nesting.runs.map((r) => runCutPath(r, input.cutGeometry ?? {}));
  const cutPathIn = runs.reduce((s, r) => s + r.pathIn, 0);
  const allBands = runs.flatMap((r) => r.bands);
  const flaggedBands = allBands.filter((b) => b.estimateRequired);
  const cutlineMissingBands = allBands.filter((b) => !b.cutlineKnown);
  const cal = resolveCutCalibration(input.machineKey, input.cutMode);

  let cutMinutes: number | null = null;
  let equipmentRecovery = 0;
  let operatorAttention = 0;

  /* 2C-3B: collect every BLOCKING condition first. An unknown actual cutline
   * is never downgraded to "provisional" — the job is not quote-ready, full
   * stop. The artboard-derived path is still reported on the result and in the
   * line note, clearly labelled DIAGNOSTIC, but it can never clear the
   * blocker and the engine zeroes a blocked line's amount. */
  const blockers: string[] = [];
  if (requiresCutting) {
    if (!cal) {
      blockers.push(`${FINISHING_REASONS.cutCalibrationPending}: no measured ${input.cutMode} cut rate for ${input.machineKey}. A cut rate is never inferred from another machine or mode.`);
      reasons.push(FINISHING_REASONS.cutCalibrationPending);
    }
    if (cutlineMissingBands.length) {
      blockers.push(
        `${FINISHING_REASONS.cutlineGeometryRequired}: ${cutlineMissingBands.map((b) => b.groupKey).join(", ")} ` +
        `${cutlineMissingBands.length === 1 ? "has" : "have"} no ACTUAL cutline geometry. An artboard is not a substitute in either direction ` +
        `(a 4.00x5.00in artboard is cut at 3.875x4.875in under the -0.0625in offset rule), so this job is not quote-ready. ` +
        `The ${cutPathIn.toFixed(1)}in path shown is an ARTBOARD DIAGNOSTIC ESTIMATE ONLY and is not canonical measured geometry.`,
      );
      reasons.push(FINISHING_REASONS.cutlineGeometryRequired);
    }
    if (cal && !cutlineMissingBands.length && !(cutPathIn > 0)) {
      blockers.push(`${FINISHING_REASONS.cutPathEstimateRequired}: the nesting result produced no cut path.`);
      reasons.push(FINISHING_REASONS.cutPathEstimateRequired);
    }
  }

  if (!requiresCutting) {
    stages.push({ key: "cutting_machine", category: "machine_recovery", label: "Cutting — not required", amount: 0, note: "This product is not cut." });
  } else if (blockers.length) {
    const blocker = blockers.join(" | ");
    const diagnostic = cal && cutPathIn > 0
      ? `DIAGNOSTIC ESTIMATE ONLY (not quote-ready): ${cutPathIn.toFixed(1)}in / ${cal.inchesPerMinute.toFixed(4)} in/min = ${(cutPathIn / cal.inchesPerMinute).toFixed(2)} min -> $${((cutPathIn / cal.inchesPerMinute / 60) * CUT_EQUIPMENT_RATE_PER_HOUR).toFixed(4)} equipment + $${((cutPathIn / cal.inchesPerMinute / 60) * CUT_OPERATOR_ATTENTION_PER_HOUR).toFixed(4)} attention. Preview only — never billed, never canonical.`
      : undefined;
    stages.push({ key: "cutting_machine", category: "machine_recovery", label: "Cutting — equipment recovery", amount: 0, blocker, note: diagnostic });
    stages.push({ key: "cutting_attention", category: "run_labor", label: "Cutting — operator attention", amount: 0, blocker, note: diagnostic });
  } else {
    const calibration = cal!; // guaranteed: a missing cal is in `blockers` above
    cutMinutes = cutPathIn / calibration.inchesPerMinute;
    const cutHours = cutMinutes / 60;
    equipmentRecovery = cutHours * CUT_EQUIPMENT_RATE_PER_HOUR;
    operatorAttention = cutHours * CUT_OPERATOR_ATTENTION_PER_HOUR;

    const notes: string[] = [];
    if (flaggedBands.length) {
      reasons.push(FINISHING_REASONS.cutPathEstimateRequired);
      notes.push(`${FINISHING_REASONS.cutPathEstimateRequired}: ${flaggedBands.map((b) => b.estimateReason).join(" ")}`);
    }
    if (calibration.provisional) {
      reasons.push(FINISHING_REASONS.cutGeometryUnverified);
      notes.push(calibration.provisional);
    }
    const provisional = notes.length ? notes.join(" ") : undefined;

    stages.push({
      key: "cutting_machine",
      category: "machine_recovery",
      label: `Cutting — equipment recovery, ${cutMinutes.toFixed(2)} min (${input.cutMode})`,
      amount: equipmentRecovery,
      formula: `${cutPathIn.toFixed(1)}in / ${calibration.inchesPerMinute.toFixed(4)} in/min / 60 x $${CUT_EQUIPMENT_RATE_PER_HOUR}/hr`,
      note: `${calibration.source} [${calibration.classification}] Cut setup is already inside the art-setup standard and is never charged again here.`,
      provisional,
    });
    stages.push({
      key: "cutting_attention",
      category: "run_labor",
      label: `Cutting — operator attention, ${cutMinutes.toFixed(2)} min (${input.cutMode})`,
      amount: operatorAttention,
      formula: `${cutMinutes.toFixed(4)} min / 60 x $${CUT_OPERATOR_ATTENTION_PER_HOUR}/hr`,
      note: "Separate accounting line from equipment recovery; the two are never merged internally.",
      provisional,
    });
  }

  const weeding = computeWeeding(
    input.nesting.runs.map((r) => ({ key: r.key, feedLengthIn: r.feedLengthIn })),
    input.requiresWeeding ?? WEEDING_REQUIRED_BY_DEFAULT,
  );
  if (weeding.requiresWeeding) {
    stages.push({
      key: "weeding",
      category: "finishing_application",
      label: `Weeding — ${weeding.totalPages} reference page(s) across ${weeding.runs.length} physical run(s)`,
      amount: weeding.cost,
      formula: `${weeding.runs.map((r) => `ceil(${r.feedLengthIn.toFixed(2)}/${WEEDING_REFERENCE_PAGE_IN})=${r.pages}`).join(" + ")} = ${weeding.totalPages} x $${WEEDING_COST_PER_REFERENCE_PAGE.toFixed(6)}`,
      note: `Owner policy: every physical printed run off either printer is weeded. $${WEEDING_LABOR_RATE_PER_HOUR}/hr at ${WEEDING_PAGES_PER_HOUR} pages/hr, ${WEEDING_REFERENCE_PAGE_IN}x${WEEDING_REFERENCE_PAGE_IN}in reference page. Each run is rounded up on its own, then summed — feeds are never combined before rounding. Human labor, never the printer/operator rate.`,
    });
  } else {
    stages.push({ key: "weeding", category: "finishing_application", label: "Weeding — not required", amount: 0, note: "Explicitly overridden to false for this product." });
  }

  return {
    version: FINISHING_COST_VERSION,
    stages,
    cutPathIn,
    cutMinutes,
    cutHours: cutMinutes == null ? null : cutMinutes / 60,
    equipmentRecovery,
    operatorAttention,
    weedingPages: weeding.totalPages,
    weedingCost: weeding.cost,
    runs,
    calibration: cal,
    cutlineMissingBands: cutlineMissingBands.map((b) => b.groupKey),
    cutPathIsDiagnosticOnly: requiresCutting && cutlineMissingBands.length > 0,
    blockers,
    reasons: Array.from(new Set(reasons)),
  };
}
