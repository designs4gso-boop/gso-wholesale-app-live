import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_RULES,
  KEEP_TOLERANCE_PCT,
  MIN_DATES,
  MIN_JOBS,
  MIN_RUNS,
  buildCalibrationRuns,
  buildRecommendation,
  checkSample,
  confidenceOf,
  isTestRow,
  mean,
  median,
  metricValue,
  splitOutliersIqr,
  type CalibrationJobContext,
  type CalibrationRun,
} from "../app/lib/calibration.server";
import { attributeMachine, type BrandInkRates } from "../app/lib/rip-actual-costs.server";
import type { VarianceEntryInput } from "../app/lib/actual-variance.server";

const RATES: BrandInkRates[] = [
  { brand: "mimaki", machineName: "Mimaki UCJV300", cmykPerMl: 0.176, whitePerMl: null, glossPerMl: null },
  { brand: "roland", machineName: "Roland LG-640", cmykPerMl: 0.19867, whitePerMl: 0.19867, glossPerMl: 0.19867 },
];

function makeEntry(overrides: Partial<VarianceEntryInput & { productionJobId: string | null }> = {}): VarianceEntryInput & { productionJobId: string | null } {
  return {
    id: `e${Math.random().toString(36).slice(2, 8)}`, productionJobId: "job1", productionJobItemId: "i1",
    jobTicket: "GSO-20260701-0001-01", sourceJobName: "GSO-20260701-0001-01_Jar.pdf",
    printerSoftware: "rasterlink", machineName: "Mimaki UCJV300", mediaName: "Matte Vinyl",
    status: "print:Complete", sqft: 10, inkMl: 6, cmykInkMl: 6, whiteInkMl: 0, glossInkMl: 0,
    printMinutes: 20, startedAt: "2026-07-01T10:00:00.000Z", completedAt: "2026-07-01T10:20:00.000Z",
    rawRow: JSON.stringify({ inkBasis: "rasterlink_rounded_per_item_estimate" }),
    ...overrides,
  };
}

const JOBS = new Map<string, CalibrationJobContext>([
  ["job1", { id: "job1", jobTicket: "GSO-20260701-0001", items: [{ id: "i1", selectedFinish: "Matte", quantity: 40 }] }],
  ["job2", { id: "job2", jobTicket: "GSO-20260702-0002", items: [{ id: "i2", selectedFinish: "Gloss", quantity: 10 }, { id: "i3", selectedFinish: "Matte", quantity: 5 }] }],
]);

function makeRun(overrides: Partial<CalibrationRun> = {}): CalibrationRun {
  return {
    entryId: `r${Math.random().toString(36).slice(2, 8)}`, jobId: "job1", jobTicket: "GSO-1", itemId: "i1",
    finish: "Matte", quantity: 40, printer: "mimaki", machineLabel: "Mimaki UCJV300", mediaName: "Matte",
    productionDate: "2026-07-01", sqft: 10, inkMl: 6, cmykInkMl: 6, whiteInkMl: 0, glossInkMl: 0,
    channelSplitResolved: true, minutes: 20, durationSource: "imported_native", inkCost: 1.06, isTest: false,
    ...overrides,
  };
}

// runs meeting all thresholds: 6 runs, 3 jobs, 3 dates, no job > 50%
function eligibleRuns(valueSpread = [0.6, 0.61, 0.6, 0.62, 0.59, 0.6]): CalibrationRun[] {
  const jobs = ["jobA", "jobA", "jobB", "jobB", "jobC", "jobC"];
  const dates = ["2026-07-01", "2026-07-01", "2026-07-02", "2026-07-02", "2026-07-03", "2026-07-03"];
  return valueSpread.map((mlPerSqft, index) =>
    makeRun({ jobId: jobs[index], productionDate: dates[index], sqft: 10, inkMl: mlPerSqft * 10 }));
}

describe("trustworthy run building (requirement A/K exclusions)", () => {
  it("excludes unmatched, ambiguous, cut, duplicate, and test rows with explicit reasons", () => {
    const entries = [
      makeEntry({ id: "ok" }),
      makeEntry({ id: "unmatched", productionJobId: null }),
      makeEntry({ id: "ambig", startedAt: "2026-07-01T12:00:00.000Z", completedAt: "2026-07-01T12:20:00.000Z", rawRow: JSON.stringify({ matchFlag: "ambiguous_ticket_needs_review" }) }),
      makeEntry({ id: "cut", status: "cut:Complete", inkMl: 0, cmykInkMl: 0, printMinutes: 0, startedAt: "2026-07-01T11:00:00.000Z", completedAt: "2026-07-01T11:05:00.000Z" }),
      makeEntry({ id: "dup" }), // identical natural key to "ok"
      makeEntry({ id: "test", sourceJobName: "GSO-20260627-0002-01_TEST.pdf", jobTicket: "GSO-20260627-0002-01", startedAt: "2026-07-02T10:00:00.000Z", completedAt: "2026-07-02T10:10:00.000Z" }),
    ];
    const { runs, excluded } = buildCalibrationRuns({ entries, jobsById: JOBS, rates: RATES });
    expect(runs.map((run) => run.entryId)).toEqual(["ok"]);
    const reasons = excluded.map((row) => row.reason);
    expect(reasons.some((reason) => reason === "unmatched_no_job_attachment")).toBe(true);
    expect(reasons.some((reason) => reason === "ambiguous_match_flag")).toBe(true);
    expect(reasons.some((reason) => reason === "cut_row")).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("duplicate_rows_collapsed"))).toBe(true);
    expect(reasons.some((reason) => reason === "test_data_token")).toBe(true);
  });

  it("test rows can be included via the explicit toggle; token matching is standalone-only", () => {
    expect(isTestRow({ jobTicket: "GSO-1", sourceJobName: "art_TEST.pdf" })).toBe(true);
    expect(isTestRow({ jobTicket: "GSO-1", sourceJobName: "CONTESTANT-banner.pdf" })).toBe(false); // never substring
    const testEntry = makeEntry({ id: "t1", sourceJobName: "thing_TEST.pdf" });
    const withToggle = buildCalibrationRuns({ entries: [testEntry], jobsById: JOBS, rates: RATES, includeTest: true });
    expect(withToggle.runs).toHaveLength(1);
    expect(withToggle.runs[0].isTest).toBe(true);
  });

  it("finish comes only from structured item data; multi-item jobs without item attribution have null finish", () => {
    const single = buildCalibrationRuns({ entries: [makeEntry()], jobsById: JOBS, rates: RATES }).runs[0];
    expect(single.finish).toBe("Matte");
    const multiNoItem = makeEntry({ id: "m1", productionJobId: "job2", productionJobItemId: null, sourceJobName: "GSO-20260702-0002_x.pdf" });
    const run = buildCalibrationRuns({ entries: [multiNoItem], jobsById: JOBS, rates: RATES }).runs[0];
    expect(run.finish).toBeNull();
  });
});

describe("metric extractors (requirement A/C exclusions)", () => {
  it("zero-sqft rows are excluded from ml/sqft; unresolved channel split excluded from channel metrics", () => {
    expect(metricValue.mlPerSqftTotal(makeRun({ sqft: 0 }))).toBeNull();
    expect(metricValue.mlPerSqftCmyk(makeRun({ channelSplitResolved: false }))).toBeNull();
    expect(metricValue.mlPerSqftCmyk(makeRun())).toBeCloseTo(0.6, 6);
  });

  it("unknown-duration rows are excluded from time and machine-cost metrics", () => {
    const unknown = makeRun({ durationSource: "unknown", minutes: 0 });
    expect(metricValue.minutesPerSqft(unknown)).toBeNull();
    expect(metricValue.machineCostPerSqft(8)(unknown)).toBeNull();
    expect(metricValue.minutesPerSqft(makeRun())).toBeCloseTo(2, 6);
    expect(metricValue.machineCostPerSqft(8)(makeRun())).toBeCloseTo((20 / 60) * 8 / 10, 6);
  });

  it("minutes per 100 units requires a trustworthy quantity", () => {
    expect(metricValue.minutesPer100Units(makeRun({ quantity: null }))).toBeNull();
    expect(metricValue.minutesPer100Units(makeRun())).toBeCloseTo(50, 6); // 20 min / 40 units x 100
  });
});

describe("sample thresholds (requirement B)", () => {
  it("insufficient runs, jobs, or dates each block eligibility with the exact reason", () => {
    const short = checkSample([makeRun(), makeRun()]);
    expect(short.eligible).toBe(false);
    expect(short.reasons.some((reason) => reason.includes(`${MIN_RUNS}+ reliable runs`))).toBe(true);
    const oneJob = checkSample(Array.from({ length: 6 }, () => makeRun({ jobId: "only", productionDate: "2026-07-01" })));
    expect(oneJob.reasons.some((reason) => reason.includes(`${MIN_JOBS}+ distinct jobs`))).toBe(true);
    expect(oneJob.reasons.some((reason) => reason.includes(`${MIN_DATES}+ distinct production dates`))).toBe(true);
  });

  it("a dominant job over 50% of the sample blocks eligibility", () => {
    const runs = [
      ...Array.from({ length: 4 }, () => makeRun({ jobId: "big", productionDate: "2026-07-01" })),
      makeRun({ jobId: "b", productionDate: "2026-07-02" }),
      makeRun({ jobId: "c", productionDate: "2026-07-03" }),
    ];
    const check = checkSample(runs);
    expect(check.eligible).toBe(false);
    expect(check.reasons.some((reason) => reason.includes("of the sample"))).toBe(true);
  });

  it("the eligible fixture passes all thresholds", () => {
    expect(checkSample(eligibleRuns()).eligible).toBe(true);
  });
});

describe("statistics and outliers (requirement C/D)", () => {
  it("median and mean are computed correctly (median default for skew)", () => {
    expect(median([1, 2, 100])).toBe(2);
    expect(mean([1, 2, 3])).toBeCloseTo(2, 9);
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 9);
    expect(median([])).toBeNull();
  });

  it("IQR fences exclude extremes transparently with both partitions returned", () => {
    const values = [10, 11, 12, 11, 10, 12, 11, 500];
    const { included, excludedOutliers, fences } = splitOutliersIqr(values.map((value) => ({ value })), (item) => item.value);
    expect(excludedOutliers.map((item) => item.value)).toEqual([500]);
    expect(included).toHaveLength(7);
    expect(fences).not.toBeNull();
  });

  it("small samples (under 8) skip outlier fencing — thin-fence clipping is worse than showing the spread", () => {
    const seven = [0.6, 0.61, 0.6, 0.62, 0.59, 0.6, 9].map((value) => ({ value }));
    const { included, excludedOutliers, fences } = splitOutliersIqr(seven, (item) => item.value);
    expect(included).toHaveLength(7);
    expect(excludedOutliers).toHaveLength(0);
    expect(fences).toBeNull();
  });
});

describe("confidence rules (requirement G)", () => {
  it("low just meets minimums; medium and high need documented breadth and low variability", () => {
    const lowCheck = checkSample(eligibleRuns());
    expect(confidenceOf(lowCheck, [0.6, 0.61, 0.6, 0.62, 0.59, 0.6])).toBe("low"); // 6 runs < medium's 8
    const mediumRuns = Array.from({ length: CONFIDENCE_RULES.medium.runs }, (_v, index) =>
      makeRun({ jobId: `j${index % CONFIDENCE_RULES.medium.jobs}`, productionDate: `2026-07-0${(index % CONFIDENCE_RULES.medium.dates) + 1}` }));
    expect(confidenceOf(checkSample(mediumRuns), Array.from({ length: 8 }, () => 0.6))).toBe("medium");
    const highRuns = Array.from({ length: CONFIDENCE_RULES.high.runs }, (_v, index) =>
      makeRun({ jobId: `j${index % CONFIDENCE_RULES.high.jobs}`, productionDate: `2026-07-${String((index % CONFIDENCE_RULES.high.dates) + 1).padStart(2, "0")}` }));
    expect(confidenceOf(checkSample(highRuns), Array.from({ length: 15 }, () => 0.6))).toBe("high");
  });
});

describe("recommendation cards (requirement F)", () => {
  const base = { metricKey: "m", title: "t", group: "All printers", unit: "ml/sqft", valueOf: metricValue.mlPerSqftTotal };

  it("insufficient data yields the exact not-enough message with observed values still shown", () => {
    const card = buildRecommendation({ ...base, runs: [makeRun(), makeRun({ jobId: "b" })], currentValue: 0.75, currentSource: "test" });
    expect(card.status).toBe("not_enough_data");
    expect(card.rationale).toContain("Not enough verified production data yet");
    expect(card.observedMedian).not.toBeNull();
    expect(card.recommendedValue).toBeNull();
  });

  it("recommends an increase when the observed median is above tolerance", () => {
    const card = buildRecommendation({ ...base, runs: eligibleRuns(), currentValue: 0.4, currentSource: "channels" });
    expect(card.status).toBe("recommend_increase");
    expect(card.recommendedValue).toBeCloseTo(0.6, 3);
    expect(card.percentDifference).toBeGreaterThan(KEEP_TOLERANCE_PCT);
    expect(card.confidence).toBe("low");
  });

  it("recommends a decrease when observed is below tolerance", () => {
    const card = buildRecommendation({ ...base, runs: eligibleRuns(), currentValue: 0.9, currentSource: "channels" });
    expect(card.status).toBe("recommend_decrease");
  });

  it("keeps the current assumption within +/-10% tolerance", () => {
    const card = buildRecommendation({ ...base, runs: eligibleRuns(), currentValue: 0.62, currentSource: "channels" });
    expect(card.status).toBe("keep_current");
    expect(card.recommendedValue).toBe(0.62);
  });

  it("observed-only when no active assumption exists; representative impact is reported when provided", () => {
    const observedOnly = buildRecommendation({ ...base, runs: eligibleRuns(), currentValue: null, currentSource: null });
    expect(observedOnly.status).toBe("observed_only");
    const withImpact = buildRecommendation({
      ...base, runs: eligibleRuns(), currentValue: 0.4, currentSource: "channels",
      impactOf: (delta, representative) => `$${(delta * 0.176 * representative.sqft).toFixed(2)} per representative run`,
    });
    expect(withImpact.representativeImpact).toContain("per representative run");
    expect(withImpact.includedRunIds.length).toBe(6);
  });

  it("outlier runs (8+ samples) are excluded from the recommendation but listed for inspection", () => {
    const runs = [
      ...eligibleRuns([0.58, 0.59, 0.6, 0.6, 0.61, 0.62]),
      makeRun({ jobId: "jobD", productionDate: "2026-07-04", sqft: 10, inkMl: 6.3 }), // 0.63 normal
      makeRun({ jobId: "jobD", productionDate: "2026-07-04", sqft: 10, inkMl: 90 }), // 9 ml/sqft outlier
    ];
    const card = buildRecommendation({ ...base, runs, currentValue: 0.4, currentSource: "channels" });
    expect(card.excludedOutlierRunIds).toHaveLength(1);
    expect(card.sampleCount).toBe(7);
    expect(card.recommendedValue).toBeCloseTo(0.6, 2); // median unaffected by the outlier
    expect(card.outlierFences).not.toBeNull();
  });
});

describe("read-only + compatibility pins (requirement L)", () => {
  const pageSource = readFileSync(new URL("../app/routes/app.erp.calibration.tsx", import.meta.url), "utf8");
  const libSource = readFileSync(new URL("../app/lib/calibration.server.ts", import.meta.url), "utf8");

  it("the calibration page has NO action export and no Prisma write verbs — nothing can change", () => {
    expect(pageSource).not.toMatch(/export (async )?function action/);
    expect(pageSource).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    expect(libSource).not.toMatch(/\.(create|update|delete|upsert)\(/);
  });

  it("the page reads the ACTIVE assumption sources (machine channels + machineRatePerHour), not stale duplicates", () => {
    expect(pageSource).toContain("mlPerSqft1Pct");
    expect(pageSource).toContain("machineRatePerHour()");
    expect(pageSource).toContain("defaultMachineRecoveryHr"); // flagged as duplicate, never used as the source
  });

  it("historical LG-540 rows classify as Roland; LG-640 is the displayed current model", () => {
    expect(attributeMachine({ machineName: "Roland TrueVIS LG-540" })).toBe("roland");
    expect(pageSource).toContain("Roland LG-640");
    expect(pageSource).not.toContain("Roland LG-540");
  });
});
