import { describe, expect, it } from "vitest";

import {
  computeJobVariance,
  dedupeVarianceEntries,
  detectRuns,
  entryKindOf,
  filterVarianceRows,
  matchMethodOf,
  round2,
  type VarianceEntryInput,
  type VarianceItemInput,
  type VarianceJobInput,
} from "../app/lib/actual-variance.server";
import type { BrandInkRates } from "../app/lib/rip-actual-costs.server";

const RATES: BrandInkRates[] = [
  { brand: "mimaki", machineName: "Mimaki UCJV300", cmykPerMl: 0.176, whitePerMl: null, glossPerMl: null },
  { brand: "roland", machineName: "Roland LG-540", cmykPerMl: 0.19867, whitePerMl: 0.19867, glossPerMl: 0.19867 },
];

const MATERIALS = [
  { id: "mat1", name: "Matte Vinyl", materialType: "roll_media", unit: "sqft", baseUnit: "sqft", calculatedUnitCost: 0.3156, costPerUnit: 0.3156, purchaseCost: 213 },
];

function makeEntry(overrides: Partial<VarianceEntryInput> = {}): VarianceEntryInput {
  return {
    id: "e1",
    productionJobItemId: null,
    jobTicket: "GSO-20260718-0001-01",
    sourceJobName: "GSO-20260718-0001-01_Jar.pdf",
    printerSoftware: "rasterlink",
    machineName: "Mimaki UCJV300",
    mediaName: "Matte Vinyl",
    status: "print:Complete",
    sqft: 10,
    inkMl: 6.72,
    cmykInkMl: 6.72,
    whiteInkMl: 0,
    glossInkMl: 0,
    printMinutes: 20,
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:20:00.000Z",
    rawRow: JSON.stringify({ inkBasis: "rasterlink_rounded_per_item_estimate" }),
    ...overrides,
  };
}

function makeItem(overrides: Partial<VarianceItemInput> = {}): VarianceItemInput {
  return { id: "i1", itemTicket: "GSO-20260718-0001-01", productTitle: "Jar labels", quantity: 40, unitPrice: 2.5, unitCost: 0.9, costSnapshot: null, ...overrides };
}

function makeJob(overrides: Partial<VarianceJobInput> = {}): VarianceJobInput {
  return {
    id: "job1", jobTicket: "GSO-20260718-0001", customerName: "Cust", company: "Cust Co", status: "in_production",
    actualTotalCost: 0, actualFinalProfit: 0, actualFinalMargin: 0, actualCostFinalized: false,
    items: [makeItem()],
    ...overrides,
  };
}

describe("matching visibility", () => {
  it("item-ticket matches are labeled item_ticket (via productionJobItemId or itemTicket equality)", () => {
    expect(matchMethodOf(makeEntry({ productionJobItemId: "i1" }), makeJob())).toBe("item_ticket");
    expect(matchMethodOf(makeEntry(), makeJob())).toBe("item_ticket"); // jobTicket equals an itemTicket
  });

  it("job-ticket-only matches are labeled job_ticket; manual review attachments are labeled manual_review", () => {
    expect(matchMethodOf(makeEntry({ jobTicket: "GSO-20260718-0001" }), makeJob())).toBe("job_ticket");
    const manual = makeEntry({ rawRow: JSON.stringify({ rematchAudit: [{ action: "attach" }] }) });
    expect(matchMethodOf(manual, makeJob())).toBe("manual_review");
  });

  it("unmatched logs never enter a job report — a job with zero entries reports zero observed data", () => {
    const row = computeJobVariance({ job: makeJob(), entries: [], rates: RATES, printMaterials: MATERIALS });
    expect(row.matchedRowCount).toBe(0);
    expect(row.printRowCount).toBe(0);
    expect(row.inkCost).toBeNull();
    expect(row.previewTotalLow).toBeNull();
    expect(row.varianceLow).toBeNull();
    expect(row.severity).toBe("unknown");
  });
});

describe("duplicate and Color+Cut protection", () => {
  it("identical historical rows are costed once and counted as ignored duplicates", () => {
    const twin = makeEntry({ id: "e2" });
    const { unique, duplicatesIgnored } = dedupeVarianceEntries([makeEntry(), twin]);
    expect(unique).toHaveLength(1);
    expect(duplicatesIgnored).toBe(1);
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry(), twin], rates: RATES, printMaterials: MATERIALS });
    expect(row.matchedRowCount).toBe(2);
    expect(row.duplicateRowsIgnored).toBe(1);
    expect(row.inkMl).toBeCloseTo(6.72, 6); // NOT 13.44
    expect(row.warnings.some((warning) => warning.includes("duplicate historical"))).toBe(true);
  });

  it("cut rows are counted separately and never ink/time-costed", () => {
    expect(entryKindOf(makeEntry({ status: "cut:Complete" }))).toBe("cut");
    const cut = makeEntry({ id: "cut1", status: "cut:Complete", inkMl: 0, cmykInkMl: 0, printMinutes: 0, startedAt: "2026-07-18T11:00:00.000Z", completedAt: "2026-07-18T11:07:00.000Z" });
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry(), cut], rates: RATES, printMaterials: MATERIALS });
    expect(row.printRowCount).toBe(1);
    expect(row.cutRowCount).toBe(1);
    expect(row.inkMl).toBeCloseTo(6.72, 6);
    expect(row.printMinutes).toBeCloseTo(20, 6);
    expect(row.warnings.some((warning) => warning.includes("cut row"))).toBe(true);
  });
});

describe("reprint/run visibility", () => {
  it("multiple real print runs are counted and flagged, never merged", () => {
    const rerun = makeEntry({ id: "e2", startedAt: "2026-07-18T14:00:00.000Z", completedAt: "2026-07-18T14:20:00.000Z" });
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry(), rerun], rates: RATES, printMaterials: MATERIALS });
    expect(row.runCount).toBe(2);
    expect(row.reprintDetected).toBe(true);
    expect(row.inkMl).toBeCloseTo(13.44, 6); // both runs included in totals
    expect(row.warnings.some((warning) => warning.includes("distinct print runs"))).toBe(true);
  });

  it("rows without timestamps report run count unknown, not one", () => {
    expect(detectRuns([{ startedAt: null }]).runCount).toBeNull();
    expect(detectRuns([]).runCount).toBe(0);
  });
});

describe("estimates and snapshots", () => {
  it("computes estimated revenue/cost/unit/profit/margin from qty x unit fields", () => {
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    expect(row.revenue).toBeCloseTo(100, 6); // 40 x 2.50
    expect(row.estimatedCost).toBeCloseTo(36, 6); // 40 x 0.90
    expect(row.estimatedUnitCost).toBeCloseTo(0.9, 6);
    expect(row.estimatedProfit).toBeCloseTo(64, 6);
    expect(row.estimatedMarginPct).toBeCloseTo(64, 6);
  });

  it("missing cost snapshot is flagged, and a snapshot-only cost is surfaced in the warning", () => {
    const bare = makeJob({ items: [makeItem({ unitCost: 0, costSnapshot: null })] });
    const bareRow = computeJobVariance({ job: bare, entries: [], rates: RATES, printMaterials: MATERIALS });
    expect(bareRow.warnings.some((warning) => warning.includes("no unit cost and no cost snapshot"))).toBe(true);
    const snap = makeJob({ items: [makeItem({ unitCost: 0, costSnapshot: JSON.stringify({ estimate: { totalCost: 41.2 } }) })] });
    const snapRow = computeJobVariance({ job: snap, entries: [], rates: RATES, printMaterials: MATERIALS });
    expect(snapRow.warnings.some((warning) => warning.includes("41.2"))).toBe(true);
  });

  it("multi-item jobs are reported at job level with an explicit warning", () => {
    const job = makeJob({ items: [makeItem(), makeItem({ id: "i2", itemTicket: "GSO-20260718-0001-02", quantity: 10, unitPrice: 5, unitCost: 2 })] });
    const row = computeJobVariance({ job, entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    expect(row.itemCount).toBe(2);
    expect(row.revenue).toBeCloseTo(150, 6);
    expect(row.estimatedCost).toBeCloseTo(56, 6);
    expect(row.warnings.some((warning) => warning.includes("Multi-item job"))).toBe(true);
  });
});

describe("partial actual preview and honesty", () => {
  it("computes ink + machine range + material when sources exist, and stays labeled partial", () => {
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    expect(row.components.ink).toBe("calculated");
    expect(row.inkCost).toBeCloseTo(round2(6.72 * 0.176), 2);
    expect(row.components.machineTime).toBe("calculated");
    expect(row.machineCostLow).toBeCloseTo(round2((20 / 60) * 5), 2);
    expect(row.machineCostHigh).toBeCloseTo(round2((20 / 60) * 8), 2);
    expect(row.components.material).toBe("calculated");
    expect(row.materialCost).toBeCloseTo(round2(10 * 0.3156), 2);
    expect(row.previewTotalLow).toBeCloseTo(round2(row.inkCost! + row.machineCostLow! + row.materialCost!), 2);
    expect(row.complete).toBe(false);
    expect(row.excludedComponents).toContain("labor");
    expect(row.warnings.some((warning) => warning.includes("NOT a final cost"))).toBe(true);
  });

  it("missing sources show Not configured instead of invented values", () => {
    const mystery = makeEntry({ machineName: "", printerSoftware: "other", sourceJobName: "x.pdf", mediaName: "Unknown Media", printMinutes: 0 });
    const row = computeJobVariance({ job: makeJob(), entries: [mystery], rates: RATES, printMaterials: MATERIALS });
    expect(row.components.ink).toBe("not_configured"); // machine not attributable
    expect(row.inkCost).toBeNull();
    expect(row.components.machineTime).toBe("not_configured"); // zero minutes
    expect(row.machineCostLow).toBeNull();
    expect(row.components.material).toBe("not_configured"); // media does not match
    expect(row.missingComponents).toEqual(["ink", "machine_time", "material"]);
    expect(row.previewTotalLow).toBeNull();
  });

  it("zero print minutes and zero square footage are flagged, never silently priced", () => {
    const zero = makeEntry({ printMinutes: 0, sqft: 0 });
    const row = computeJobVariance({ job: makeJob(), entries: [zero], rates: RATES, printMaterials: MATERIALS });
    expect(row.warnings.some((warning) => warning.includes("zero square footage"))).toBe(true);
    expect(row.warnings.some((warning) => warning.includes("zero print minutes"))).toBe(true);
    expect(row.machineCostLow).toBeNull();
    expect(row.materialCost).toBeNull();
  });
});

describe("variance and margin math", () => {
  it("variance dollars/percent and preview margins use safe 2-decimal rounding", () => {
    const row = computeJobVariance({ job: makeJob(), entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    // ink 1.18 + machine 1.67/2.67 + material 3.16
    expect(row.previewTotalLow).toBeCloseTo(6.01, 2);
    expect(row.previewTotalHigh).toBeCloseTo(7.01, 2);
    expect(row.varianceLow).toBeCloseTo(round2(row.previewTotalLow! - 36), 2);
    expect(row.variancePctLow).toBeCloseTo(round2(((row.previewTotalLow! - 36) / 36) * 100), 2);
    expect(row.previewProfitHigh).toBeCloseTo(round2(100 - row.previewTotalLow!), 2);
    expect(row.previewMarginHighPct).toBeCloseTo(round2(((100 - row.previewTotalLow!) / 100) * 100), 2);
    expect(row.severity).toBe("high"); // preview is far below the estimate -> big negative variance
  });

  it("recorded manual finals surface separately and never replace the preview", () => {
    const job = makeJob({ actualTotalCost: 42.5, actualFinalProfit: 57.5, actualFinalMargin: 57.5, actualCostFinalized: true });
    const row = computeJobVariance({ job, entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    expect(row.finalized).toEqual({ recorded: true, totalCost: 42.5, profit: 57.5, marginPct: 57.5 });
    expect(row.previewTotalLow).not.toBe(42.5);
  });
});

describe("filters", () => {
  it("filters by match method, printer, and severity", () => {
    const base = computeJobVariance({ job: makeJob(), entries: [makeEntry()], rates: RATES, printMaterials: MATERIALS });
    expect(filterVarianceRows([base], { match: "item", printer: "all", severity: "all" })).toHaveLength(1);
    expect(filterVarianceRows([base], { match: "job", printer: "all", severity: "all" })).toHaveLength(0);
    expect(filterVarianceRows([base], { match: "all", printer: "mimaki", severity: "all" })).toHaveLength(1);
    expect(filterVarianceRows([base], { match: "all", printer: "roland", severity: "all" })).toHaveLength(0);
    expect(filterVarianceRows([base], { match: "all", printer: "all", severity: base.severity })).toHaveLength(1);
    expect(filterVarianceRows([base], { match: "all", printer: "all", severity: "medium" })).toHaveLength(0);
  });
});
