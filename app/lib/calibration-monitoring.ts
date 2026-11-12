// 2026-11-12 OWNER RULE — calibration monitoring.
//
// "10% sustained variance -> owner review. NEVER auto-change a calibration."
// There is NO owner-approved minimum sample size, so none is invented: the
// owner sets GSO_CALIBRATION_REVIEW_MIN_SAMPLES (a whole number). Until then
// the evaluator returns SAMPLE_SIZE_AUTHORITY_MISSING and never recommends a
// review — a single noisy job can never raise an alert. "Sustained" means the
// mean variance over the most recent N jobs (N = the owner's number) is at or
// beyond the approved 10%. Nothing here writes a calibration (autoChange is
// always false).

export const CALIBRATION_REVIEW_VARIANCE_PCT = 10;
export const CALIBRATION_MIN_SAMPLES_ENV = "GSO_CALIBRATION_REVIEW_MIN_SAMPLES";

export type CalibrationSample = { estimated: number; actual: number; at?: string | Date | null };
export type CalibrationReviewStatus = "SAMPLE_SIZE_AUTHORITY_MISSING" | "INSUFFICIENT_SAMPLES" | "WITHIN_TOLERANCE" | "OWNER_REVIEW_RECOMMENDED";

export type CalibrationReview = {
  status: CalibrationReviewStatus;
  minSamples: number | null;
  samplesUsed: number;
  meanVariancePct: number | null;
  direction: "actual_higher" | "actual_lower" | null;
  autoChange: false;
  message: string;
};

export function configuredMinSamples(env: Record<string, string | undefined> = process.env): number | null {
  const raw = String(env[CALIBRATION_MIN_SAMPLES_ENV] || "").trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 2 ? n : null;
}

export function evaluateCalibrationVariance(samples: CalibrationSample[], minSamples: number | null): CalibrationReview {
  const base = { minSamples, autoChange: false as const };
  if (minSamples == null) {
    return { ...base, status: "SAMPLE_SIZE_AUTHORITY_MISSING", samplesUsed: 0, meanVariancePct: null, direction: null, message: `No owner-approved minimum sample count (${CALIBRATION_MIN_SAMPLES_ENV}) — no automatic review alert is raised.` };
  }
  const valid = samples.filter((s) => Number.isFinite(s.estimated) && s.estimated > 0 && Number.isFinite(s.actual) && s.actual >= 0);
  const sorted = [...valid].sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
  const recent = sorted.slice(0, minSamples);
  if (recent.length < minSamples) {
    return { ...base, status: "INSUFFICIENT_SAMPLES", samplesUsed: recent.length, meanVariancePct: null, direction: null, message: `${recent.length} of ${minSamples} required jobs — no review yet.` };
  }
  const mean = recent.reduce((sum, s) => sum + ((s.actual - s.estimated) / s.estimated) * 100, 0) / recent.length;
  const direction = mean > 0 ? "actual_higher" : mean < 0 ? "actual_lower" : null;
  if (Math.abs(mean) >= CALIBRATION_REVIEW_VARIANCE_PCT) {
    return { ...base, status: "OWNER_REVIEW_RECOMMENDED", samplesUsed: recent.length, meanVariancePct: mean, direction, message: `Mean variance ${mean.toFixed(1)}% over the last ${recent.length} jobs is beyond the ${CALIBRATION_REVIEW_VARIANCE_PCT}% owner threshold — owner review. The calibration is NOT changed automatically.` };
  }
  return { ...base, status: "WITHIN_TOLERANCE", samplesUsed: recent.length, meanVariancePct: mean, direction, message: `Mean variance ${mean.toFixed(1)}% is within ${CALIBRATION_REVIEW_VARIANCE_PCT}%.` };
}
