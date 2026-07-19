import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  COMPONENT_INK,
  COMPONENT_MACHINE_TIME,
  PRINT_LOG_USAGE_SOURCE,
  WRITEBACK_PHRASE,
  computePrintLogWriteback,
  isPrintLogUsageRow,
  parseWritebackProvenance,
} from "../app/lib/print-log-writeback.server";
import { computeEntryCosts, machineRatePerHour, type BrandInkRates } from "../app/lib/rip-actual-costs.server";
import { MACHINE_RATE_CURRENT } from "../app/lib/rip-actual-costs-shared";
import type { VarianceEntryInput } from "../app/lib/actual-variance.server";

const RATES: BrandInkRates[] = [
  { brand: "mimaki", machineName: "Mimaki UCJV300", cmykPerMl: 0.176, whitePerMl: null, glossPerMl: null },
  { brand: "roland", machineName: "Roland LG-640", cmykPerMl: 0.19867, whitePerMl: 0.19867, glossPerMl: 0.19867 },
];

function makeEntry(overrides: Partial<VarianceEntryInput> = {}): VarianceEntryInput {
  return {
    id: "e1", productionJobItemId: "i1", jobTicket: "GSO-20260718-0001-01",
    sourceJobName: "GSO-20260718-0001-01_Jar.pdf", printerSoftware: "rasterlink", machineName: "Mimaki UCJV300",
    mediaName: "Matte Vinyl", status: "print:Complete", sqft: 10, inkMl: 6.72, cmykInkMl: 6.72,
    whiteInkMl: 0, glossInkMl: 0, printMinutes: 20,
    startedAt: "2026-07-18T10:00:00.000Z", completedAt: "2026-07-18T10:20:00.000Z",
    rawRow: JSON.stringify({ inkBasis: "rasterlink_rounded_per_item_estimate" }),
    ...overrides,
  };
}

const ITEM = { id: "i1", itemTicket: "GSO-20260718-0001-01", productTitle: "Jar labels", quantity: 40, unitPrice: 2.5, unitCost: 0.9, costSnapshot: null };

function makeJob(overrides: Partial<Parameters<typeof computePrintLogWriteback>[0]["job"]> = {}) {
  return { id: "job1", jobTicket: "GSO-20260718-0001", items: [ITEM], actualCostFinalized: false, ...overrides };
}

function compute(entries: VarianceEntryInput[], job = makeJob(), rate = 8) {
  return computePrintLogWriteback({ job, entries, rates: RATES, machineRatePerHour: rate, now: new Date("2026-07-20T00:00:00Z") });
}

describe("guarded writeback computation", () => {
  it("successful computation produces ink + machine rows with full provenance", () => {
    const result = compute([makeEntry()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    const ink = result.rows.find((row) => row.componentKey === COMPONENT_INK)!;
    const machine = result.rows.find((row) => row.componentKey === COMPONENT_MACHINE_TIME)!;
    expect(ink.totalCost).toBeCloseTo(1.18, 2); // 6.72 x 0.176
    expect(ink.unit).toBe("ml");
    expect(ink.usedQty).toBeCloseTo(6.72, 6);
    expect(machine.totalCost).toBeCloseTo(2.67, 2); // 20/60 x 8
    expect(machine.costPerUnit).toBe(8);
    expect(machine.unit).toBe("hour");
    expect(result.totalCost).toBeCloseTo(3.85, 2);
    for (const row of result.rows) {
      expect(row.source).toBe(PRINT_LOG_USAGE_SOURCE);
      const { componentKey, provenance } = parseWritebackProvenance(row.notes);
      expect(componentKey).toBe(row.componentKey);
      expect(provenance?.engine).toBe("13A.7B");
      expect(provenance?.appliedAt).toBe("2026-07-20T00:00:00.000Z");
      expect(provenance?.entryIds).toEqual(["e1"]);
      expect(provenance?.partial).toBe(true);
      expect(provenance?.ratesSource).toBe("verified_machine_channel_costs");
    }
    expect(result.warnings.some((warning) => warning.includes("Material/media cost is preview-only"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("NOT finalized") || warning.includes("not finalized"))).toBe(true);
  });

  it("the confirmation phrase constant is exact and case-sensitive", () => {
    expect(WRITEBACK_PHRASE).toBe("APPLY PRINT LOG ACTUALS");
    const lowercase: string = "apply print log actuals";
    expect(lowercase === WRITEBACK_PHRASE).toBe(false);
  });

  it("finalized jobs are blocked with a clear reason", () => {
    const result = compute([makeEntry()], makeJob({ actualCostFinalized: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedReason).toContain("FINALIZED");
  });

  it("ambiguous-flagged rows block the writeback", () => {
    const ambiguous = makeEntry({ rawRow: JSON.stringify({ matchFlag: "ambiguous_ticket_needs_review" }) });
    const result = compute([ambiguous]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedReason).toContain("ambiguous");
  });

  it("no entries and no supported components both block", () => {
    const empty = compute([]);
    expect(empty.ok).toBe(false);
    const unusable = compute([makeEntry({ machineName: "", printerSoftware: "other", sourceJobName: "x.pdf", printMinutes: 0 })]);
    expect(unusable.ok).toBe(false);
    if (!unusable.ok) expect(unusable.blockedReason).toContain("No supported cost component");
    const cutOnly = compute([makeEntry({ status: "cut:Complete", inkMl: 0, cmykInkMl: 0, printMinutes: 0 })]);
    expect(cutOnly.ok).toBe(false);
    if (!cutOnly.ok) expect(cutOnly.blockedReason).toContain("cut rows");
  });
});

describe("row handling", () => {
  it("duplicate imported records are ignored, never double-counted", () => {
    const result = compute([makeEntry(), makeEntry({ id: "e2" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicatesIgnored).toBe(1);
    expect(result.inkMl).toBeCloseTo(6.72, 6);
    expect(result.inkCost).toBeCloseTo(1.18, 2);
  });

  it("cut rows are excluded from ink/machine cost but visible in the count", () => {
    const cut = makeEntry({ id: "c1", status: "cut:Complete", inkMl: 0, cmykInkMl: 0, printMinutes: 0, startedAt: "2026-07-18T11:00:00.000Z", completedAt: "2026-07-18T11:05:00.000Z" });
    const result = compute([makeEntry(), cut]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cutRowsExcluded).toBe(1);
    expect(result.printRowCount).toBe(1);
    expect(result.totalCost).toBeCloseTo(3.85, 2);
  });

  it("a new real print run increases cost and is flagged, never merged", () => {
    const first = compute([makeEntry()]);
    const rerun = makeEntry({ id: "e2", startedAt: "2026-07-18T15:00:00.000Z", completedAt: "2026-07-18T15:20:00.000Z" });
    const second = compute([makeEntry(), rerun]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.runCount).toBe(2);
    expect(second.reprintDetected).toBe(true);
    expect(second.totalCost).toBeCloseTo(first.totalCost * 2, 2);
    expect(second.warnings.some((warning) => warning.includes("reprints increase actual cost"))).toBe(true);
  });

  it("idempotent rerun: identical inputs produce identical rows (replace-then-recreate yields the same cost)", () => {
    const a = compute([makeEntry()]);
    const b = compute([makeEntry()]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.totalCost).toBe(a.totalCost);
    expect(b.rows.map((row) => [row.componentKey, row.totalCost, row.usedQty])).toEqual(a.rows.map((row) => [row.componentKey, row.totalCost, row.usedQty]));
  });
});

describe("attribution", () => {
  it("multi-item job with uniform exact item attribution records the item ticket", () => {
    const items = [ITEM, { ...ITEM, id: "i2", itemTicket: "GSO-20260718-0001-02" }];
    const result = compute([makeEntry({ productionJobItemId: "i1" })], makeJob({ items }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itemTicketAttribution).toBe("GSO-20260718-0001-01");
  });

  it("job-ticket-only attribution on a multi-item job stays job-level with a warning", () => {
    const items = [ITEM, { ...ITEM, id: "i2", itemTicket: "GSO-20260718-0001-02" }];
    const result = compute([makeEntry({ productionJobItemId: null, jobTicket: "GSO-20260718-0001" })], makeJob({ items }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itemTicketAttribution).toBeNull();
    expect(result.matchMethods).toContain("job_ticket");
    expect(result.warnings.some((warning) => warning.includes("job level"))).toBe(true);
  });
});

describe("manual data preservation (design-level pins)", () => {
  const productionSource = readFileSync(new URL("../app/routes/app.erp.production.tsx", import.meta.url), "utf8");

  it("manual material rows are preserved: deletion is scoped to source print_log only", () => {
    expect(isPrintLogUsageRow({ source: "print_log" })).toBe(true);
    expect(isPrintLogUsageRow({ source: "manual" })).toBe(false);
    expect(isPrintLogUsageRow({ source: "inventory" })).toBe(false);
    expect(productionSource).toContain("deleteMany({ where: { shop, jobId, source: PRINT_LOG_USAGE_SOURCE } })");
    expect(productionSource).not.toMatch(/productionMaterialUsage\.deleteMany\(\{ where: \{ shop, jobId \}/);
  });

  it("the writeback runs in one transaction and never touches manual actual-cost fields", () => {
    const intentBlock = productionSource.slice(productionSource.indexOf('intent === "pullPrintLogActuals"'));
    const block = intentBlock.slice(0, intentBlock.indexOf("return Response.json({ ok: true"));
    expect(block).toContain("db.$transaction([");
    expect(block).not.toContain("actualLaborCost");
    expect(block).not.toContain("actualTotalCost");
    expect(block).not.toContain("actualCostFinalized: true");
    expect(block).not.toContain("productionJob.update");
  });

  it("legacy board ink constants are gone; the shared engine is wired in", () => {
    expect(productionSource).not.toContain("156.99 / 750");
    expect(productionSource).not.toContain("190 / 1000");
    expect(productionSource).not.toContain("ROLAND_INK_COST_PER_ML");
    expect(productionSource).not.toContain("DEFAULT_MACHINE_RECOVERY_PER_HOUR");
    expect(productionSource).toContain("computeEntryCosts");
    expect(productionSource).toContain("machineRatePerHour()");
    expect(productionSource).toContain("buildBrandRates");
  });
});

describe("shared engine equality and machine rate", () => {
  it("writeback ink equals the audit engine's computeEntryCosts for the same rows", () => {
    const entries = [makeEntry(), makeEntry({ id: "e2", startedAt: "2026-07-18T16:00:00.000Z", inkMl: 3.1, cmykInkMl: 3.1, printMinutes: 9 })];
    const result = compute(entries);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const auditSum = entries.reduce((sum, entry) => sum + (computeEntryCosts(entry, RATES).inkCost || 0), 0);
    expect(result.inkCost).toBeCloseTo(Math.round(auditSum * 100) / 100, 2);
  });

  it("the current machine rate is $8/hour through the single configurable source", () => {
    expect(MACHINE_RATE_CURRENT).toBe(8);
    expect(machineRatePerHour({})).toBe(8);
    expect(machineRatePerHour({ GSO_MACHINE_RATE_PER_HOUR: "10" })).toBe(10); // configurable, not hardcoded
    expect(machineRatePerHour({ GSO_MACHINE_RATE_PER_HOUR: "garbage" })).toBe(8);
    const result = compute([makeEntry()], makeJob(), machineRatePerHour({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows.find((row) => row.componentKey === COMPONENT_MACHINE_TIME)?.costPerUnit).toBe(8);
  });
});
