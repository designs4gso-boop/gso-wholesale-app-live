// Premium-ink calibration (15F.0G.3). PURE, READ-ONLY functions that compare
// quoted premium-ink ESTIMATES (snapshot premiumInkEstimate blocks) against
// finalized RIP ACTUALS (PrintLogEntry white/clear channel data via the 15E
// actual-cost infrastructure) and build owner-review recommendations.
//
// Ownership contract: the QUOTE keeps its estimate forever (snapshots
// immutable); ACTUALS belong to production finalization and reporting; a
// calibration factor changes ONLY by owner approval (future
// ownerConfig.inkCalibration.mimaki.whiteFactor / .glossFactor — 15F.1).
// Nothing here writes anywhere or mutates its inputs.

export const INK_CALIBRATION_VERSION = "15F.0G.3-ink-calibration";
export const MIN_CALIBRATION_JOBS = 3;

export type PremiumInkComparison = {
  estimatedWhiteMl: number;
  actualWhiteMl: number | null;
  whiteVarianceMl: number | null;
  whiteVariancePct: number | null; // null when the estimate is 0 — never 0%
  estimatedGlossMl: number;
  actualGlossMl: number | null;
  glossVarianceMl: number | null;
  glossVariancePct: number | null;
  estimatedCost: number;
  actualCost: number | null;
};

// Estimate-vs-actual for ONE finalized job. Never mutates the estimate — the
// caller stores this alongside, not instead of, the quote snapshot.
export function comparePremiumInkEstimateToActual(
  estimate: { estimatedWhiteMl: number; estimatedGlossMl: number; estimatedWhiteCost: number; estimatedGlossCost: number; inkCostPerMl: number },
  actual: { whiteMl: number | null; glossMl: number | null },
): PremiumInkComparison {
  const variance = (estimated: number, actualMl: number | null) => {
    if (actualMl == null) return { ml: null, pct: null };
    const ml = actualMl - estimated;
    return { ml, pct: estimated > 0 ? (ml / estimated) * 100 : null };
  };
  const white = variance(estimate.estimatedWhiteMl, actual.whiteMl);
  const gloss = variance(estimate.estimatedGlossMl, actual.glossMl);
  const actualCost = actual.whiteMl == null && actual.glossMl == null
    ? null
    : ((actual.whiteMl ?? 0) + (actual.glossMl ?? 0)) * estimate.inkCostPerMl;
  return {
    estimatedWhiteMl: estimate.estimatedWhiteMl,
    actualWhiteMl: actual.whiteMl,
    whiteVarianceMl: white.ml,
    whiteVariancePct: white.pct,
    estimatedGlossMl: estimate.estimatedGlossMl,
    actualGlossMl: actual.glossMl,
    glossVarianceMl: gloss.ml,
    glossVariancePct: gloss.pct,
    estimatedCost: estimate.estimatedWhiteCost + estimate.estimatedGlossCost,
    actualCost,
  };
}

export type InkCalibrationRow = {
  jobId: string;
  finalizedAt: string;
  printer: string;
  profile: string;
  inkType: "white" | "gloss";
  layers: number;
  adjustedSqft: number;
  // base estimate BEFORE the approved factor (sqft x ml/sqft x layers) — the
  // weighted factor is computed against THIS so an already-applied factor
  // never compounds.
  baseEstimatedMlBeforeFactor: number;
  estimatedMl: number; // with the factor that was snapshotted on the quote
  actualMl: number;
  materialFamily?: string | null;
};

export type InkCalibrationRecommendation = {
  version: string;
  groupKey: string;
  printer: string;
  profile: string;
  inkType: "white" | "gloss";
  materialFamily: string | null;
  jobCount: number;
  totalEstimatedMl: number;
  totalActualMl: number;
  totalBaseEstimatedMl: number;
  weightedFactor: number; // sum(actualMl) / sum(baseEstimatedMlBeforeFactor)
  variancePct: number | null; // actual vs (factored) estimate
  confidence: "low" | "medium" | "high";
  supportingJobs: string[];
  note: string;
};

function confidenceFor(jobCount: number): "low" | "medium" | "high" {
  if (jobCount >= 10) return "high";
  if (jobCount >= 5) return "medium";
  return "low";
}

// Read-only recommendations from finalized comparable jobs. Groups by
// printer + RasterLink profile + ink type (+ material family when present);
// layer counts normalize through the per-layer base estimate. Requires
// MIN_CALIBRATION_JOBS finalized jobs per group; NEVER applies a factor —
// output is owner-review input only.
export function buildInkCalibrationRecommendations(rows: InkCalibrationRow[]): InkCalibrationRecommendation[] {
  const groups = new Map<string, InkCalibrationRow[]>();
  for (const row of rows) {
    if (!(row.actualMl > 0) || !(row.baseEstimatedMlBeforeFactor > 0)) continue; // incomplete data never calibrates
    const key = [row.printer, row.profile, row.inkType, row.materialFamily || ""].join("|");
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const recommendations: InkCalibrationRecommendation[] = [];
  for (const [groupKey, groupRows] of groups) {
    if (groupRows.length < MIN_CALIBRATION_JOBS) continue; // below sample minimum — no suggestion
    const totalActualMl = groupRows.reduce((sum, row) => sum + row.actualMl, 0);
    const totalBaseEstimatedMl = groupRows.reduce((sum, row) => sum + row.baseEstimatedMlBeforeFactor, 0);
    const totalEstimatedMl = groupRows.reduce((sum, row) => sum + row.estimatedMl, 0);
    const [printer, profile, inkType, materialFamily] = groupKey.split("|");
    recommendations.push({
      version: INK_CALIBRATION_VERSION,
      groupKey,
      printer,
      profile,
      inkType: inkType as "white" | "gloss",
      materialFamily: materialFamily || null,
      jobCount: groupRows.length,
      totalEstimatedMl,
      totalActualMl,
      totalBaseEstimatedMl,
      weightedFactor: totalActualMl / totalBaseEstimatedMl,
      variancePct: totalEstimatedMl > 0 ? ((totalActualMl - totalEstimatedMl) / totalEstimatedMl) * 100 : null,
      confidence: confidenceFor(groupRows.length),
      supportingJobs: groupRows.map((row) => row.jobId),
      note: "Owner-review recommendation only — apply by updating the approved factor (ownerConfig.inkCalibration, 15F.1); quotes snapshot the factor used and historical snapshots are never rewritten.",
    });
  }
  return recommendations.sort((a, b) => b.jobCount - a.jobCount);
}
