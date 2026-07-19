// Estimated-vs-actual variance report (13A.7A): READ-ONLY pure computation.
// No Prisma, no network — the Actual Costs route passes data in, tests import
// directly. Nothing here writes ProductionMaterialUsage, job actual-cost
// fields, quotes, or calibration values.
//
// Honesty contract:
// - every preview lists calculated, missing, and excluded components and is
//   labeled PARTIAL unless every component is calculated (labor/packing/
//   shipping are never derivable from print logs, so v1 is always partial);
// - "Not configured" is shown instead of inventing a rate;
// - duplicate historical rows are deduped IN COMPUTATION but stay visible as
//   a count; cut rows are never ink/time-costed; reprint runs are surfaced,
//   never merged silently.
//
// Rates come exclusively from the verified 13A.5 engine (DB machine channel
// costs + the undecided $5/$8 machine-rate range). The Production Board's
// legacy hardcoded ink rates are deliberately NOT used; the discrepancy is
// surfaced as a warning so the owner can reconcile it in 13A.7B.

import { MACHINE_RATE_HIGH, MACHINE_RATE_LOW } from "./rip-actual-costs-shared";
import {
  computeEntryCosts,
  matchMediaToMaterial,
  type BrandInkRates,
} from "./rip-actual-costs.server";

export type VarianceEntryInput = {
  id: string;
  productionJobItemId: string | null;
  jobTicket: string | null;
  sourceJobName: string | null;
  printerSoftware: string | null;
  machineName: string | null;
  mediaName: string | null;
  status: string | null;
  sqft: number;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  printMinutes: number;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  rawRow: string | null;
};

export type VarianceItemInput = {
  id: string;
  itemTicket: string | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  costSnapshot: string | null;
};

export type VarianceJobInput = {
  id: string;
  jobTicket: string | null;
  customerName: string | null;
  company: string | null;
  status: string;
  actualTotalCost: number;
  actualFinalProfit: number;
  actualFinalMargin: number;
  actualCostFinalized: boolean;
  items: VarianceItemInput[];
};

export type ComponentStatus = "calculated" | "partial" | "not_configured";

export type VarianceReportRow = {
  jobId: string;
  jobTicket: string | null;
  customer: string | null;
  jobStatus: string;
  itemCount: number;
  itemTickets: string[];
  // estimated
  revenue: number;
  estimatedCost: number;
  estimatedUnitCost: number | null;
  estimatedProfit: number;
  estimatedMarginPct: number | null;
  // observed print data (deduped; cut rows separated)
  matchedRowCount: number;
  duplicateRowsIgnored: number;
  printRowCount: number;
  cutRowCount: number;
  printers: string[];
  matchMethods: string[];
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  sqft: number;
  printMinutes: number;
  runCount: number | null; // distinct print start times; null = timestamps missing
  reprintDetected: boolean;
  // actual-cost preview (supported components only)
  components: { ink: ComponentStatus; machineTime: ComponentStatus; material: ComponentStatus };
  missingComponents: string[];
  excludedComponents: string[];
  inkCost: number | null;
  machineCostLow: number | null;
  machineCostHigh: number | null;
  materialCost: number | null;
  previewTotalLow: number | null;
  previewTotalHigh: number | null;
  previewProfitLow: number | null;
  previewProfitHigh: number | null;
  previewMarginLowPct: number | null;
  previewMarginHighPct: number | null;
  varianceLow: number | null; // previewLow - estimatedCost
  varianceHigh: number | null;
  variancePctLow: number | null;
  variancePctHigh: number | null;
  severity: "high" | "medium" | "low" | "unknown";
  complete: boolean; // always false while labor/packing/shipping are underivable
  finalized: { recorded: boolean; totalCost: number; profit: number; marginPct: number } | null;
  warnings: string[];
};

export const EXCLUDED_COMPONENTS = ["labor", "packing", "shipping", "outsource", "reprint_extras"];

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Historical duplicate protection: rows imported before the 13A.6A/6D dedupe
// layers can exist twice. Identical natural keys collapse to one costed row;
// the ignored count stays visible.
export function dedupeVarianceEntries(entries: VarianceEntryInput[]): { unique: VarianceEntryInput[]; duplicatesIgnored: number } {
  const seen = new Map<string, VarianceEntryInput>();
  let duplicatesIgnored = 0;
  for (const entry of entries) {
    const key = [
      entry.printerSoftware || "", entry.sourceJobName || "", entry.machineName || "", entry.status || "",
      entry.startedAt ? new Date(entry.startedAt).toISOString() : "",
      entry.completedAt ? new Date(entry.completedAt).toISOString() : "",
      String(entry.inkMl), String(entry.sqft),
    ].join("|");
    if (seen.has(key)) { duplicatesIgnored += 1; continue; }
    seen.set(key, entry);
  }
  return { unique: [...seen.values()], duplicatesIgnored };
}

// Cut rows (status "cut:<result>") are separate operations with no ink and no
// print minutes — they are counted, never costed, so Color+Cut pairs for the
// same file are not double-counted.
export function entryKindOf(entry: Pick<VarianceEntryInput, "status">): "print" | "cut" {
  return String(entry.status || "").toLowerCase().startsWith("cut:") ? "cut" : "print";
}

export function matchMethodOf(entry: Pick<VarianceEntryInput, "productionJobItemId" | "jobTicket" | "rawRow">, job: Pick<VarianceJobInput, "jobTicket" | "items">): string {
  const raw = (() => {
    try { return entry.rawRow ? JSON.parse(entry.rawRow) : null; } catch { return null; }
  })();
  if (raw && Array.isArray(raw.rematchAudit) && raw.rematchAudit.length) return "manual_review";
  if (entry.productionJobItemId) return "item_ticket";
  const ticket = String(entry.jobTicket || "").toUpperCase();
  if (ticket && job.items.some((item) => String(item.itemTicket || "").toUpperCase() === ticket)) return "item_ticket";
  if (ticket && ticket === String(job.jobTicket || "").toUpperCase()) return "job_ticket";
  return "attached";
}

// Distinct print start times among deduped print rows = observable run count.
// Reprints stay visible: 2+ runs flags reprintDetected. Rows without any
// timestamps cannot prove runs -> null ("unknown"), never guessed as 1.
export function detectRuns(printEntries: Pick<VarianceEntryInput, "startedAt">[]): { runCount: number | null; reprintDetected: boolean } {
  const stamps = [...new Set(printEntries.map((entry) => (entry.startedAt ? new Date(entry.startedAt).toISOString() : "")).filter(Boolean))];
  if (!stamps.length) return { runCount: printEntries.length ? null : 0, reprintDetected: false };
  return { runCount: stamps.length, reprintDetected: stamps.length > 1 };
}

function severityOf(variancePct: number | null): VarianceReportRow["severity"] {
  if (variancePct == null) return "unknown";
  const abs = Math.abs(variancePct);
  if (abs > 25) return "high";
  if (abs > 10) return "medium";
  return "low";
}

export function computeJobVariance(params: {
  job: VarianceJobInput;
  entries: VarianceEntryInput[];
  rates: BrandInkRates[];
  printMaterials: Parameters<typeof matchMediaToMaterial>[1];
}): VarianceReportRow {
  const { job, rates, printMaterials } = params;
  const warnings: string[] = [];

  // ----- estimated side (same source the Production Board uses: qty x unit) -----
  const revenue = round2(job.items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), 0));
  const estimatedCost = round2(job.items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitCost) || 0), 0));
  const totalQty = job.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const estimatedUnitCost = totalQty > 0 ? round2(estimatedCost / totalQty) : null;
  const estimatedProfit = round2(revenue - estimatedCost);
  const estimatedMarginPct = revenue > 0 ? round2((estimatedProfit / revenue) * 100) : null;
  for (const item of job.items) {
    if ((Number(item.unitCost) || 0) <= 0) {
      let snapshotCost: number | null = null;
      try {
        const snapshot = item.costSnapshot ? JSON.parse(item.costSnapshot) : null;
        snapshotCost = snapshot?.estimate?.totalCost ?? null;
      } catch { /* unparseable snapshot handled below */ }
      warnings.push(
        snapshotCost != null
          ? `Item "${item.productTitle}" has unitCost 0 but a cost snapshot totalCost of ${snapshotCost} — estimate may understate cost.`
          : `Item "${item.productTitle}" has no unit cost and no cost snapshot — estimated cost is incomplete.`,
      );
    }
  }
  if (job.items.length > 1) warnings.push(`Multi-item job (${job.items.length} items): print rows are job-level; per-item split is not derivable yet.`);

  // ----- observed print data -----
  const { unique, duplicatesIgnored } = dedupeVarianceEntries(params.entries);
  if (duplicatesIgnored > 0) warnings.push(`${duplicatesIgnored} duplicate historical row(s) ignored in cost math (kept visible here).`);
  const printRows = unique.filter((entry) => entryKindOf(entry) === "print");
  const cutRows = unique.filter((entry) => entryKindOf(entry) === "cut");
  if (cutRows.length) warnings.push(`${cutRows.length} cut row(s) counted separately — never ink/time-costed.`);
  const inkMl = round2(printRows.reduce((sum, entry) => sum + (Number(entry.inkMl) || 0), 0));
  const cmykInkMl = round2(printRows.reduce((sum, entry) => sum + (Number(entry.cmykInkMl) || 0), 0));
  const whiteInkMl = round2(printRows.reduce((sum, entry) => sum + (Number(entry.whiteInkMl) || 0), 0));
  const glossInkMl = round2(printRows.reduce((sum, entry) => sum + (Number(entry.glossInkMl) || 0), 0));
  const sqft = round2(printRows.reduce((sum, entry) => sum + (Number(entry.sqft) || 0), 0));
  const printMinutes = round2(printRows.reduce((sum, entry) => sum + (Number(entry.printMinutes) || 0), 0));
  const printers = [...new Set(unique.map((entry) => `${entry.printerSoftware || "?"}${entry.machineName ? `/${entry.machineName}` : ""}`))];
  const matchMethods = [...new Set(unique.map((entry) => matchMethodOf(entry, job)))];
  const { runCount, reprintDetected } = detectRuns(printRows);
  if (reprintDetected) warnings.push(`${runCount} distinct print runs detected — reprints are included, not merged.`);
  if (runCount === null && printRows.length) warnings.push("Print rows have no timestamps — run/reprint count unknown.");
  const zeroSqft = printRows.filter((entry) => (Number(entry.sqft) || 0) <= 0).length;
  if (zeroSqft) warnings.push(`${zeroSqft} print row(s) report zero square footage (RasterLink rows have no area data).`);
  const zeroMinutes = printRows.filter((entry) => (Number(entry.printMinutes) || 0) <= 0).length;
  if (zeroMinutes) warnings.push(`${zeroMinutes} print row(s) report zero print minutes — machine-time preview is understated.`);

  // ----- actual preview: ink (verified channel costs) -----
  let inkCost: number | null = null;
  let inkStatus: ComponentStatus = "not_configured";
  if (printRows.length) {
    let costed = 0;
    let costSum = 0;
    for (const entry of printRows) {
      const costs = computeEntryCosts(entry, rates);
      if (costs.inkCost != null) { costed += 1; costSum += costs.inkCost; }
      for (const warning of costs.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    }
    if (costed === printRows.length && costed > 0) { inkStatus = "calculated"; inkCost = round2(costSum); }
    else if (costed > 0) { inkStatus = "partial"; inkCost = round2(costSum); warnings.push(`Ink cost covers ${costed}/${printRows.length} print rows — remaining rows lack attributable verified rates.`); }
  }

  // ----- actual preview: machine time (owner has not picked $5 vs $8 -> range) -----
  let machineCostLow: number | null = null;
  let machineCostHigh: number | null = null;
  let machineStatus: ComponentStatus = "not_configured";
  if (printMinutes > 0) {
    machineCostLow = round2((printMinutes / 60) * MACHINE_RATE_LOW);
    machineCostHigh = round2((printMinutes / 60) * MACHINE_RATE_HIGH);
    machineStatus = "calculated";
    warnings.push(`Machine rate undecided — showing both $${MACHINE_RATE_LOW}/hr and $${MACHINE_RATE_HIGH}/hr.`);
  }

  // ----- actual preview: material (display-only media->material name match) -----
  let materialCost: number | null = null;
  let materialStatus: ComponentStatus = "not_configured";
  if (printRows.length) {
    let matched = 0;
    let withArea = 0;
    let costSum = 0;
    for (const entry of printRows) {
      const area = Number(entry.sqft) || 0;
      if (area <= 0) continue;
      withArea += 1;
      const media = matchMediaToMaterial(entry.mediaName, printMaterials);
      if (media.costPerSqft != null) { matched += 1; costSum += media.costPerSqft * area; }
      else if (media.warning && !warnings.includes(media.warning)) warnings.push(media.warning);
    }
    if (withArea > 0 && matched === withArea) { materialStatus = "calculated"; materialCost = round2(costSum); }
    else if (matched > 0) { materialStatus = "partial"; materialCost = round2(costSum); warnings.push(`Material cost covers ${matched}/${withArea} rows with area data.`); }
  }

  // ----- totals, variance, honesty flags -----
  const missingComponents: string[] = [];
  if (inkStatus === "not_configured") missingComponents.push("ink");
  if (machineStatus === "not_configured") missingComponents.push("machine_time");
  if (materialStatus === "not_configured") missingComponents.push("material");
  const supported = inkCost != null || machineCostLow != null || materialCost != null;
  const previewTotalLow = supported ? round2((inkCost || 0) + (machineCostLow || 0) + (materialCost || 0)) : null;
  const previewTotalHigh = supported ? round2((inkCost || 0) + (machineCostHigh || 0) + (materialCost || 0)) : null;
  const previewProfitLow = previewTotalHigh != null ? round2(revenue - previewTotalHigh) : null; // low profit uses HIGH cost
  const previewProfitHigh = previewTotalLow != null ? round2(revenue - previewTotalLow) : null;
  const previewMarginLowPct = previewProfitLow != null && revenue > 0 ? round2((previewProfitLow / revenue) * 100) : null;
  const previewMarginHighPct = previewProfitHigh != null && revenue > 0 ? round2((previewProfitHigh / revenue) * 100) : null;
  const varianceLow = previewTotalLow != null ? round2(previewTotalLow - estimatedCost) : null;
  const varianceHigh = previewTotalHigh != null ? round2(previewTotalHigh - estimatedCost) : null;
  const variancePctLow = varianceLow != null && estimatedCost > 0 ? round2((varianceLow / estimatedCost) * 100) : null;
  const variancePctHigh = varianceHigh != null && estimatedCost > 0 ? round2((varianceHigh / estimatedCost) * 100) : null;

  // The preview NEVER includes labor/packing/shipping/outsource — it is a
  // partial print-cost preview by construction and is labeled as such.
  const complete = false;
  warnings.push("Preview covers print components only (ink, machine time, media) — labor, packing, shipping, outsourcing are excluded, so this is NOT a final cost.");

  return {
    jobId: job.id,
    jobTicket: job.jobTicket,
    customer: job.company || job.customerName,
    jobStatus: job.status,
    itemCount: job.items.length,
    itemTickets: job.items.map((item) => item.itemTicket || "").filter(Boolean),
    revenue, estimatedCost, estimatedUnitCost, estimatedProfit, estimatedMarginPct,
    matchedRowCount: params.entries.length,
    duplicateRowsIgnored: duplicatesIgnored,
    printRowCount: printRows.length,
    cutRowCount: cutRows.length,
    printers,
    matchMethods,
    inkMl, cmykInkMl, whiteInkMl, glossInkMl, sqft, printMinutes,
    runCount, reprintDetected,
    components: { ink: inkStatus, machineTime: machineStatus, material: materialStatus },
    missingComponents,
    excludedComponents: EXCLUDED_COMPONENTS,
    inkCost, machineCostLow, machineCostHigh, materialCost,
    previewTotalLow, previewTotalHigh, previewProfitLow, previewProfitHigh,
    previewMarginLowPct, previewMarginHighPct,
    varianceLow, varianceHigh, variancePctLow, variancePctHigh,
    severity: severityOf(variancePctHigh),
    complete,
    finalized: job.actualTotalCost > 0 || job.actualCostFinalized
      ? { recorded: true, totalCost: round2(job.actualTotalCost), profit: round2(job.actualFinalProfit), marginPct: round2(job.actualFinalMargin) }
      : null,
    warnings,
  };
}

export type VarianceFilters = { match: string; printer: string; severity: string };

export function filterVarianceRows(rows: VarianceReportRow[], filters: VarianceFilters): VarianceReportRow[] {
  return rows.filter((row) => {
    if (filters.match === "item" && !row.matchMethods.includes("item_ticket")) return false;
    if (filters.match === "job" && !row.matchMethods.includes("job_ticket")) return false;
    if (filters.printer === "mimaki" && !row.printers.some((printer) => /rasterlink|mimaki/i.test(printer))) return false;
    if (filters.printer === "roland" && !row.printers.some((printer) => /versaworks|roland/i.test(printer))) return false;
    if (["high", "medium", "low"].includes(filters.severity) && row.severity !== filters.severity) return false;
    return true;
  });
}
