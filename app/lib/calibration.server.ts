// Calibration recommendations (13A.8A): READ-ONLY pure engine. No Prisma, no
// network, no writes — the Audit Calibration page passes data in; tests
// import directly. Nothing here changes pricing, costs, quotes, products,
// machine channels, or historical jobs.
//
// Trust rules (documented in the state doc): only rows that are attached to a
// real job, deduped, non-cut, non-ambiguous, and (per metric) with usable
// sqft / reliable duration / resolved channel split. Test rows (standalone
// TEST token in ticket or source name) are excluded by default — there is no
// production/test flag in the schema, so the token filter is the documented
// safe strategy until one exists.
//
// The ACTIVE assumption source compared against is MachineInkChannel
// (mlPerSqft1Pct seeded 0.0075 per 1% coverage per channel + verified
// costPerMl) — the exact values recipe-pricing.server.ts uses — plus the
// single $8/hr machine rate. Observed ml/sqft is TOTAL ink per area; the
// assumption is per-1%-coverage, so comparisons state the reference coverage
// explicitly and APPLY IS DELIBERATELY NOT BUILT (writing mlPerSqft1Pct from
// observed totals would bake in a guessed coverage percentage).

import {
  dedupeVarianceEntries,
  entryKindOf,
  type VarianceEntryInput,
} from "./actual-variance.server";
import { resolvePrintDuration } from "./rip-duration.server";
import { attributeMachine, computeEntryCosts, type BrandInkRates } from "./rip-actual-costs.server";

// ---------- sample thresholds + confidence (requirement B/G — documented) ----------

export const MIN_RUNS = 5;
export const MIN_JOBS = 3;
export const MIN_DATES = 2;
export const MAX_SINGLE_JOB_SHARE = 0.5;

// Confidence: LOW just clears the minimums; MEDIUM = 8+ runs, 4+ jobs,
// 3+ dates, coefficient of variation <= 0.35; HIGH = 15+ runs, 6+ jobs,
// 5+ dates, CV <= 0.20.
export const CONFIDENCE_RULES = {
  medium: { runs: 8, jobs: 4, dates: 3, maxCv: 0.35 },
  high: { runs: 15, jobs: 6, dates: 5, maxCv: 0.2 },
};

// Keep-current tolerance: observed median within +/-10% of the current
// assumption keeps it.
export const KEEP_TOLERANCE_PCT = 10;

export type CalibrationRun = {
  entryId: string;
  jobId: string;
  jobTicket: string | null;
  itemId: string | null;
  finish: string | null; // exact structured selectedFinish only — never inferred from filenames
  quantity: number | null;
  printer: "mimaki" | "roland" | "unknown";
  machineLabel: string;
  mediaName: string | null;
  productionDate: string | null; // YYYY-MM-DD from startedAt
  sqft: number;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  channelSplitResolved: boolean;
  minutes: number;
  durationSource: string;
  inkCost: number | null;
  isTest: boolean;
};

export type ExcludedRow = { entryId: string; sourceJobName: string | null; reason: string };

const TEST_TOKEN_RE = /(^|[-_ .])TEST([-_ .]|$)/i; // standalone token incl. before extensions (_TEST.pdf); never inside words

export function isTestRow(entry: Pick<VarianceEntryInput, "jobTicket" | "sourceJobName">): boolean {
  return TEST_TOKEN_RE.test(String(entry.jobTicket || "")) || TEST_TOKEN_RE.test(String(entry.sourceJobName || ""));
}

export type CalibrationJobContext = {
  id: string;
  jobTicket: string | null;
  items: Array<{ id: string; selectedFinish: string | null; quantity: number }>;
};

// Build trustworthy runs from attached entries. Every exclusion carries an
// explicit reason — nothing disappears silently.
export function buildCalibrationRuns(params: {
  entries: (VarianceEntryInput & { productionJobId?: string | null })[];
  jobsById: Map<string, CalibrationJobContext>;
  rates: BrandInkRates[];
  includeTest?: boolean;
}): { runs: CalibrationRun[]; excluded: ExcludedRow[] } {
  const excluded: ExcludedRow[] = [];
  const attached = params.entries.filter((entry) => {
    if (!entry.productionJobId) {
      excluded.push({ entryId: entry.id, sourceJobName: entry.sourceJobName, reason: "unmatched_no_job_attachment" });
      return false;
    }
    return true;
  });
  const jobIdByEntryId = new Map(attached.map((entry) => [entry.id, entry.productionJobId as string]));
  const { unique, duplicatesIgnored } = dedupeVarianceEntries(attached);
  if (duplicatesIgnored > 0) {
    // dedupe keeps first occurrence; report the collapsed count as one line
    excluded.push({ entryId: "(collapsed)", sourceJobName: null, reason: `duplicate_rows_collapsed:${duplicatesIgnored}` });
  }
  const runs: CalibrationRun[] = [];
  for (const entry of unique) {
    if (entryKindOf(entry) === "cut") { excluded.push({ entryId: entry.id, sourceJobName: entry.sourceJobName, reason: "cut_row" }); continue; }
    let ambiguous = false;
    try { ambiguous = entry.rawRow ? JSON.parse(entry.rawRow)?.matchFlag === "ambiguous_ticket_needs_review" : false; } catch { /* unparseable = not flagged */ }
    if (ambiguous) { excluded.push({ entryId: entry.id, sourceJobName: entry.sourceJobName, reason: "ambiguous_match_flag" }); continue; }
    const job = params.jobsById.get(jobIdByEntryId.get(entry.id) as string);
    if (!job) { excluded.push({ entryId: entry.id, sourceJobName: entry.sourceJobName, reason: "job_context_missing" }); continue; }
    const test = isTestRow(entry);
    if (test && !params.includeTest) { excluded.push({ entryId: entry.id, sourceJobName: entry.sourceJobName, reason: "test_data_token" }); continue; }

    const item = entry.productionJobItemId ? job.items.find((candidate) => candidate.id === entry.productionJobItemId) || null : job.items.length === 1 ? job.items[0] : null;
    const duration = resolvePrintDuration(entry);
    const costs = computeEntryCosts(entry, params.rates);
    const cmyk = Number(entry.cmykInkMl) || 0;
    const white = Number(entry.whiteInkMl) || 0;
    const gloss = Number(entry.glossInkMl) || 0;
    runs.push({
      entryId: entry.id,
      jobId: job.id,
      jobTicket: job.jobTicket,
      itemId: item?.id || null,
      finish: item?.selectedFinish || null,
      quantity: item && Number(item.quantity) > 0 ? Number(item.quantity) : null,
      printer: attributeMachine(entry) || "unknown",
      machineLabel: entry.machineName || entry.printerSoftware || "unknown",
      mediaName: entry.mediaName,
      productionDate: entry.startedAt ? new Date(entry.startedAt).toISOString().slice(0, 10) : null,
      sqft: Number(entry.sqft) || 0,
      inkMl: Number(entry.inkMl) || 0,
      cmykInkMl: cmyk,
      whiteInkMl: white,
      glossInkMl: gloss,
      channelSplitResolved: cmyk + white + gloss > 0,
      minutes: duration.minutes,
      durationSource: duration.source,
      inkCost: costs.inkCost,
      isTest: test,
    });
  }
  return { runs, excluded };
}

// ---------- statistics (requirement C/D) ----------

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

// Transparent IQR outlier rule (1.5 x IQR fences). Returns both partitions —
// excluded runs stay inspectable, never deleted or altered. Fencing applies
// only at 8+ samples: below that, quartiles of near-identical values produce
// razor-thin fences that clip legitimate runs, so small samples are shown
// whole (the minimum-sample rules already guard against over-trusting them).
export const MIN_SAMPLES_FOR_FENCING = 8;
export function splitOutliersIqr<T>(items: T[], valueOf: (item: T) => number): { included: T[]; excludedOutliers: T[]; fences: { low: number; high: number } | null } {
  if (items.length < MIN_SAMPLES_FOR_FENCING) return { included: items, excludedOutliers: [], fences: null };
  const sorted = [...items].sort((a, b) => valueOf(a) - valueOf(b));
  const quartile = (fraction: number) => {
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return (valueOf(sorted[lower]) + valueOf(sorted[upper])) / 2;
  };
  const q1 = quartile(0.25);
  const q3 = quartile(0.75);
  const iqr = q3 - q1;
  const fences = { low: q1 - 1.5 * iqr, high: q3 + 1.5 * iqr };
  const included: T[] = [];
  const excludedOutliers: T[] = [];
  for (const item of items) {
    const value = valueOf(item);
    if (value < fences.low || value > fences.high) excludedOutliers.push(item);
    else included.push(item);
  }
  return { included, excludedOutliers, fences };
}

// ---------- sample eligibility (requirement B) ----------

export type SampleCheck = {
  eligible: boolean;
  reasons: string[];
  runCount: number;
  jobCount: number;
  dateCount: number;
  dominantJobShare: number;
};

export function checkSample(runs: Pick<CalibrationRun, "jobId" | "productionDate">[]): SampleCheck {
  const reasons: string[] = [];
  const jobCounts = new Map<string, number>();
  for (const run of runs) jobCounts.set(run.jobId, (jobCounts.get(run.jobId) || 0) + 1);
  const dates = new Set(runs.map((run) => run.productionDate).filter(Boolean));
  const dominant = runs.length ? Math.max(0, ...jobCounts.values()) / runs.length : 0;
  if (runs.length < MIN_RUNS) reasons.push(`needs ${MIN_RUNS}+ reliable runs (have ${runs.length})`);
  if (jobCounts.size < MIN_JOBS) reasons.push(`needs ${MIN_JOBS}+ distinct jobs (have ${jobCounts.size})`);
  if (dates.size < MIN_DATES) reasons.push(`needs ${MIN_DATES}+ distinct production dates (have ${dates.size})`);
  if (runs.length >= MIN_RUNS && dominant > MAX_SINGLE_JOB_SHARE) reasons.push(`one job is ${(dominant * 100).toFixed(0)}% of the sample (max ${MAX_SINGLE_JOB_SHARE * 100}%)`);
  return { eligible: reasons.length === 0, reasons, runCount: runs.length, jobCount: jobCounts.size, dateCount: dates.size, dominantJobShare: dominant };
}

export type Confidence = "low" | "medium" | "high";

export function confidenceOf(check: SampleCheck, values: number[]): Confidence {
  const avg = mean(values);
  const deviation = stdev(values);
  const cv = avg && deviation != null && avg !== 0 ? Math.abs(deviation / avg) : Infinity;
  const { high, medium } = CONFIDENCE_RULES;
  if (check.runCount >= high.runs && check.jobCount >= high.jobs && check.dateCount >= high.dates && cv <= high.maxCv) return "high";
  if (check.runCount >= medium.runs && check.jobCount >= medium.jobs && check.dateCount >= medium.dates && cv <= medium.maxCv) return "medium";
  return "low";
}

// ---------- recommendation cards (requirement F) ----------

export type RecommendationStatus = "recommend_increase" | "recommend_decrease" | "keep_current" | "observed_only" | "not_enough_data";

export type RecommendationCard = {
  metricKey: string;
  title: string;
  group: string; // "all" | printer | finish label
  unit: string;
  currentValue: number | null;
  currentSource: string | null;
  observedMedian: number | null;
  observedMean: number | null;
  recommendedValue: number | null; // median-based
  absoluteDifference: number | null;
  percentDifference: number | null;
  status: RecommendationStatus;
  confidence: Confidence | null;
  sampleCount: number;
  jobCount: number;
  dateRange: string | null;
  printers: string[];
  includedRunIds: string[];
  excludedOutlierRunIds: string[];
  outlierFences: { low: number; high: number } | null;
  stdev: number | null;
  min: number | null;
  max: number | null;
  rationale: string;
  representativeImpact: string | null;
  insufficientReasons: string[];
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function buildRecommendation(params: {
  metricKey: string;
  title: string;
  group: string;
  unit: string;
  runs: CalibrationRun[];
  valueOf: (run: CalibrationRun) => number | null;
  currentValue: number | null;
  currentSource: string | null;
  impactOf?: (delta: number, representative: CalibrationRun) => string;
}): RecommendationCard {
  const usable = params.runs
    .map((run) => ({ run, value: params.valueOf(run) }))
    .filter((pair): pair is { run: CalibrationRun; value: number } => pair.value != null && Number.isFinite(pair.value));
  const { included, excludedOutliers, fences } = splitOutliersIqr(usable, (pair) => pair.value);
  const values = included.map((pair) => pair.value);
  const check = checkSample(included.map((pair) => pair.run));
  const observedMedian = median(values);
  const observedMean = mean(values);
  const dates = included.map((pair) => pair.run.productionDate).filter(Boolean).sort();
  const base: Omit<RecommendationCard, "status" | "recommendedValue" | "absoluteDifference" | "percentDifference" | "confidence" | "rationale" | "representativeImpact"> = {
    metricKey: params.metricKey,
    title: params.title,
    group: params.group,
    unit: params.unit,
    currentValue: params.currentValue,
    currentSource: params.currentSource,
    observedMedian: observedMedian != null ? round4(observedMedian) : null,
    observedMean: observedMean != null ? round4(observedMean) : null,
    sampleCount: values.length,
    jobCount: check.jobCount,
    dateRange: dates.length ? `${dates[0]} -> ${dates[dates.length - 1]}` : null,
    printers: [...new Set(included.map((pair) => pair.run.printer))],
    includedRunIds: included.map((pair) => pair.run.entryId),
    excludedOutlierRunIds: excludedOutliers.map((pair) => pair.run.entryId),
    outlierFences: fences,
    stdev: stdev(values) != null ? round4(stdev(values)!) : null,
    min: values.length ? round4(Math.min(...values)) : null,
    max: values.length ? round4(Math.max(...values)) : null,
    insufficientReasons: check.reasons,
  };

  if (!check.eligible || observedMedian == null) {
    return {
      ...base,
      status: "not_enough_data",
      recommendedValue: null,
      absoluteDifference: null,
      percentDifference: null,
      confidence: null,
      rationale: values.length
        ? `Not enough verified production data yet — ${check.reasons.join("; ")}. Observed values shown for reference only.`
        : "Not enough verified production data yet — no usable runs for this metric.",
      representativeImpact: null,
    };
  }

  const confidence = confidenceOf(check, values);
  if (params.currentValue == null) {
    return {
      ...base,
      status: "observed_only",
      recommendedValue: round4(observedMedian),
      absoluteDifference: null,
      percentDifference: null,
      confidence,
      rationale: "No active assumption exists for this metric — observed median shown as a baseline, nothing to change.",
      representativeImpact: null,
    };
  }

  const difference = observedMedian - params.currentValue;
  const percent = params.currentValue !== 0 ? (difference / params.currentValue) * 100 : null;
  const representative = included[Math.floor(included.length / 2)].run;
  const impact = params.impactOf ? params.impactOf(difference, representative) : null;
  if (percent != null && Math.abs(percent) <= KEEP_TOLERANCE_PCT) {
    return {
      ...base,
      status: "keep_current",
      recommendedValue: params.currentValue,
      absoluteDifference: round4(difference),
      percentDifference: round4(percent),
      confidence,
      rationale: `Observed median is within the +/-${KEEP_TOLERANCE_PCT}% tolerance of the current assumption — keep it.`,
      representativeImpact: impact,
    };
  }
  return {
    ...base,
    status: difference > 0 ? "recommend_increase" : "recommend_decrease",
    recommendedValue: round4(observedMedian),
    absoluteDifference: round4(difference),
    percentDifference: percent != null ? round4(percent) : null,
    confidence,
    rationale: `Observed median (${round4(observedMedian)} ${params.unit}, ${values.length} runs across ${check.jobCount} jobs) differs from the current assumption (${params.currentValue} ${params.unit}) by ${percent != null ? `${round4(percent)}%` : "n/a"} — median-based recommendation.`,
    representativeImpact: impact,
  };
}

// ---------- metric value extractors (requirement C) ----------

export const metricValue = {
  mlPerSqftTotal: (run: CalibrationRun) => (run.sqft > 0 && run.inkMl > 0 ? run.inkMl / run.sqft : null),
  mlPerSqftCmyk: (run: CalibrationRun) => (run.sqft > 0 && run.channelSplitResolved ? run.cmykInkMl / run.sqft : null),
  mlPerSqftWhite: (run: CalibrationRun) => (run.sqft > 0 && run.channelSplitResolved ? run.whiteInkMl / run.sqft : null),
  mlPerSqftGloss: (run: CalibrationRun) => (run.sqft > 0 && run.channelSplitResolved ? run.glossInkMl / run.sqft : null),
  inkCostPerSqft: (run: CalibrationRun) => (run.sqft > 0 && run.inkCost != null ? run.inkCost / run.sqft : null),
  machineCostPerSqft: (ratePerHour: number) => (run: CalibrationRun) =>
    run.sqft > 0 && run.durationSource !== "unknown" && run.minutes > 0 ? ((run.minutes / 60) * ratePerHour) / run.sqft : null,
  minutesPerSqft: (run: CalibrationRun) => (run.sqft > 0 && run.durationSource !== "unknown" && run.minutes > 0 ? run.minutes / run.sqft : null),
  minutesPerJob: (run: CalibrationRun) => (run.durationSource !== "unknown" && run.minutes > 0 ? run.minutes : null),
  minutesPer100Units: (run: CalibrationRun) =>
    run.durationSource !== "unknown" && run.minutes > 0 && run.quantity != null ? (run.minutes / run.quantity) * 100 : null,
};
