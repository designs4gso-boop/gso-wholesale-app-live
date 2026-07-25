// 15F.0G.3 — premium-ink calibration: read-only comparisons and owner-review
// recommendations. Quote estimates are never mutated; factors never apply
// automatically.

import { describe, expect, it } from "vitest";

import {
  MIN_CALIBRATION_JOBS,
  buildInkCalibrationRecommendations,
  comparePremiumInkEstimateToActual,
  type InkCalibrationRow,
} from "../app/lib/ink-calibration.server";

const ESTIMATE = {
  estimatedWhiteMl: 60.44,
  estimatedGlossMl: 181.3248,
  estimatedWhiteCost: 60.44 * 0.176,
  estimatedGlossCost: 181.3248 * 0.176,
  inkCostPerMl: 0.176,
};

function row(overrides: Partial<InkCalibrationRow> = {}): InkCalibrationRow {
  return {
    jobId: "job1", finalizedAt: "2026-07-25T12:00:00Z",
    printer: "Mimaki UCJV300-130", profile: "600x1200 VD / 32-pass / Bi-direction / Fast Print High (LUS-170)",
    inkType: "gloss", layers: 3, adjustedSqft: 100.736,
    baseEstimatedMlBeforeFactor: 181.3248, estimatedMl: 181.3248, actualMl: 210.5,
    materialFamily: "stickers-labels",
    ...overrides,
  };
}

describe("estimate-vs-actual comparison (15F.0G.3-F)", () => {
  it("preserves estimate AND actual with ml/% variance; never mutates the estimate", () => {
    const before = JSON.stringify(ESTIMATE);
    const comparison = comparePremiumInkEstimateToActual(ESTIMATE, { whiteMl: 55.1, glossMl: 210.5 });
    expect(JSON.stringify(ESTIMATE)).toBe(before); // quote estimate untouched
    expect(comparison.estimatedGlossMl).toBeCloseTo(181.3248, 4); // estimate preserved alongside
    expect(comparison.actualGlossMl).toBe(210.5);
    expect(comparison.glossVarianceMl).toBeCloseTo(210.5 - 181.3248, 6);
    expect(comparison.glossVariancePct).toBeCloseTo(((210.5 - 181.3248) / 181.3248) * 100, 6);
    expect(comparison.whiteVarianceMl).toBeCloseTo(55.1 - 60.44, 6);
    expect(comparison.actualCost).toBeCloseTo((55.1 + 210.5) * 0.176, 6);
  });

  it("zero estimate -> variance % null (never 0%); missing actuals -> nulls", () => {
    const zeroEstimate = comparePremiumInkEstimateToActual({ ...ESTIMATE, estimatedWhiteMl: 0 }, { whiteMl: 5, glossMl: null });
    expect(zeroEstimate.whiteVariancePct).toBeNull();
    expect(zeroEstimate.glossVarianceMl).toBeNull();
    const noActuals = comparePremiumInkEstimateToActual(ESTIMATE, { whiteMl: null, glossMl: null });
    expect(noActuals.actualCost).toBeNull();
  });
});

describe("calibration recommendations (15F.0G.3-G)", () => {
  it("requires at least 3 comparable finalized jobs; 3-4 low / 5-9 medium / 10+ high confidence", () => {
    expect(MIN_CALIBRATION_JOBS).toBe(3);
    const two = buildInkCalibrationRecommendations([row({ jobId: "a" }), row({ jobId: "b" })]);
    expect(two).toHaveLength(0); // below the sample minimum — no suggestion
    const three = buildInkCalibrationRecommendations([row({ jobId: "a" }), row({ jobId: "b" }), row({ jobId: "c" })]);
    expect(three).toHaveLength(1);
    expect(three[0].confidence).toBe("low");
    expect(three[0].jobCount).toBe(3);
    expect(three[0].supportingJobs).toEqual(["a", "b", "c"]);
    const six = buildInkCalibrationRecommendations([1, 2, 3, 4, 5, 6].map((n) => row({ jobId: `j${n}` })));
    expect(six[0].confidence).toBe("medium");
    const eleven = buildInkCalibrationRecommendations(Array.from({ length: 11 }, (_v, i) => row({ jobId: `k${i}` })));
    expect(eleven[0].confidence).toBe("high");
  });

  it("weighted factor = sum(actualMl) / sum(baseEstimatedMlBeforeFactor) — factors never compound or auto-apply", () => {
    const rows = [
      row({ jobId: "a", baseEstimatedMlBeforeFactor: 100, estimatedMl: 100, actualMl: 130 }),
      row({ jobId: "b", baseEstimatedMlBeforeFactor: 200, estimatedMl: 200, actualMl: 240 }),
      row({ jobId: "c", baseEstimatedMlBeforeFactor: 100, estimatedMl: 100, actualMl: 110 }),
    ];
    const before = JSON.stringify(rows);
    const [recommendation] = buildInkCalibrationRecommendations(rows);
    expect(recommendation.weightedFactor).toBeCloseTo((130 + 240 + 110) / (100 + 200 + 100), 10); // 1.2
    expect(recommendation.totalActualMl).toBe(480);
    expect(recommendation.totalBaseEstimatedMl).toBe(400);
    expect(recommendation.variancePct).toBeCloseTo(20, 6);
    expect(recommendation.note).toContain("Owner-review recommendation only");
    expect(JSON.stringify(rows)).toBe(before); // pure — nothing mutated, nothing applied
  });

  it("groups by printer/profile/ink type/material family; white and gloss never mix; incomplete rows excluded", () => {
    const rows = [
      row({ jobId: "g1" }), row({ jobId: "g2" }), row({ jobId: "g3" }),
      row({ jobId: "w1", inkType: "white" }), row({ jobId: "w2", inkType: "white" }), row({ jobId: "w3", inkType: "white" }),
      row({ jobId: "bad", actualMl: 0 }), // incomplete — never calibrates
    ];
    const recommendations = buildInkCalibrationRecommendations(rows);
    expect(recommendations).toHaveLength(2);
    const gloss = recommendations.find((entry) => entry.inkType === "gloss")!;
    const white = recommendations.find((entry) => entry.inkType === "white")!;
    expect(gloss.jobCount).toBe(3); // "bad" excluded
    expect(white.jobCount).toBe(3);
    expect(gloss.groupKey).not.toBe(white.groupKey);
  });
});
