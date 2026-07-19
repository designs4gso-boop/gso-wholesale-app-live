// Guarded print-log actual-cost writeback (13A.7B): pure computation of the
// ProductionMaterialUsage rows the Production Board action may write after
// the owner types the confirmation phrase. No Prisma, no network — the route
// passes data in and re-computes SERVER-SIDE at apply time (client preview
// numbers are never trusted).
//
// Owner decisions encoded here:
// - only ink + machine-time are write-grade; MATERIAL/media cost stays
//   preview-only (name-based matching is not write-grade);
// - machine time uses the ONE configurable rate source ($8/hr current);
// - a partial print-cost writeback is NEVER a finalized job cost;
// - labor/packing/shipping/outsourcing/reprint-extras stay manual.
//
// Idempotency: rows carry source "print_log" and a component marker in notes;
// re-applying deletes ONLY rows with { jobId, source: "print_log" } and
// recreates them in the same transaction. Manual usage rows, inventory
// deductions, and every other source are untouched.

import {
  dedupeVarianceEntries,
  detectRuns,
  entryKindOf,
  matchMethodOf,
  round2,
  type VarianceEntryInput,
  type VarianceJobInput,
} from "./actual-variance.server";
import { computeEntryCosts, type BrandInkRates } from "./rip-actual-costs.server";
import { resolvePrintDuration } from "./rip-duration.server";

// Client-safe constants live in print-log-writeback-shared.ts (the board
// component references them); re-exported here so server code and tests use
// one import path.
export { PRINT_LOG_USAGE_SOURCE, WRITEBACK_PHRASE } from "./print-log-writeback-shared";
import { PRINT_LOG_USAGE_SOURCE } from "./print-log-writeback-shared";
export const WRITEBACK_ENGINE_VERSION = "13A.7B";
export const COMPONENT_INK = "print_log_ink";
export const COMPONENT_MACHINE_TIME = "print_log_machine_time";

export type WritebackUsageDraft = {
  componentKey: string;
  materialName: string;
  materialType: string;
  unit: string;
  usedQty: number;
  costPerUnit: number;
  totalCost: number;
  source: typeof PRINT_LOG_USAGE_SOURCE;
  notes: string; // "component:<key>|<provenance json>"
};

export type WritebackComputation =
  | { ok: false; blockedReason: string; warnings: string[] }
  | {
      ok: true;
      rows: WritebackUsageDraft[];
      totalCost: number;
      inkCost: number | null;
      machineCost: number | null;
      inkMl: number;
      printMinutes: number;
      machineRatePerHour: number;
      printRowCount: number;
      cutRowsExcluded: number;
      duplicatesIgnored: number;
      runCount: number | null;
      reprintDetected: boolean;
      printers: string[];
      matchMethods: string[];
      itemTicketAttribution: string | null; // set only when EVERY costed row attributes to one exact item
      entryIds: string[];
      warnings: string[];
    };

function provenanceNote(componentKey: string, provenance: Record<string, unknown>): string {
  return `component:${componentKey}|${JSON.stringify(provenance)}`;
}

export function isPrintLogUsageRow(usage: { source?: string | null }): boolean {
  return String(usage.source || "") === PRINT_LOG_USAGE_SOURCE;
}

export function parseWritebackProvenance(notes: string | null): { componentKey: string | null; provenance: Record<string, unknown> | null } {
  const text = String(notes || "");
  const match = text.match(/^component:([a-z_]+)\|(.*)$/s);
  if (!match) return { componentKey: null, provenance: null };
  try {
    const provenance = JSON.parse(match[2]);
    return { componentKey: match[1], provenance: provenance && typeof provenance === "object" ? provenance : null };
  } catch {
    return { componentKey: match[1], provenance: null };
  }
}

export function computePrintLogWriteback(params: {
  job: Pick<VarianceJobInput, "id" | "jobTicket" | "items"> & { actualCostFinalized: boolean };
  entries: VarianceEntryInput[];
  rates: BrandInkRates[];
  machineRatePerHour: number;
  now?: Date;
}): WritebackComputation {
  const warnings: string[] = [];
  if (params.job.actualCostFinalized) {
    return { ok: false, blockedReason: "Job actual cost is FINALIZED — writeback is blocked. Un-finalize first if a correction is genuinely needed.", warnings };
  }
  if (!params.entries.length) {
    return { ok: false, blockedReason: "No print-log rows are attached to this job — attach rows in RIP Import Review first.", warnings };
  }
  // Ambiguity belt-and-braces: attached rows should never carry the ambiguous
  // flag, but if one does (legacy data), block instead of guessing.
  const ambiguous = params.entries.filter((entry) => {
    try { return entry.rawRow ? JSON.parse(entry.rawRow)?.matchFlag === "ambiguous_ticket_needs_review" : false; } catch { return false; }
  });
  if (ambiguous.length) {
    return { ok: false, blockedReason: `${ambiguous.length} attached row(s) still carry the ambiguous-match flag — resolve them in RIP Import Review before writing costs.`, warnings };
  }

  const { unique, duplicatesIgnored } = dedupeVarianceEntries(params.entries);
  if (duplicatesIgnored > 0) warnings.push(`${duplicatesIgnored} duplicate historical row(s) ignored — never double-counted.`);
  const printRows = unique.filter((entry) => entryKindOf(entry) === "print");
  const cutRowsExcluded = unique.length - printRows.length;
  if (cutRowsExcluded > 0) warnings.push(`${cutRowsExcluded} cut row(s) excluded from ink/machine cost.`);
  if (!printRows.length) {
    return { ok: false, blockedReason: "Only cut rows are attached — no supported print cost component is available.", warnings };
  }

  const { runCount, reprintDetected } = detectRuns(printRows);
  if (reprintDetected) warnings.push(`${runCount} distinct print runs included — reprints increase actual cost and are never merged.`);
  if (runCount === null) warnings.push("Print rows have no timestamps — run/reprint count is uncertain.");

  // ---- ink (verified channel rates; partial coverage warns, zero coverage drops the component) ----
  let inkCost: number | null = null;
  let costedRows = 0;
  let inkSum = 0;
  const inkMl = round2(printRows.reduce((sum, entry) => sum + (Number(entry.inkMl) || 0), 0));
  for (const entry of printRows) {
    const costs = computeEntryCosts(entry, params.rates);
    if (costs.inkCost != null) { costedRows += 1; inkSum += costs.inkCost; }
    for (const warning of costs.warnings) if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (costedRows > 0) {
    inkCost = round2(inkSum);
    if (costedRows < printRows.length) warnings.push(`Ink cost covers ${costedRows}/${printRows.length} print rows — uncovered rows are excluded, not guessed.`);
  }

  // ---- machine time (single configurable rate; 13A.7C reliable durations) ----
  // Duration precedence per row: exact print stamps from the row's own raw
  // fields (derived, plausibility-gated) > stored imported minutes > unknown.
  const durationSources = { derived: 0, native: 0, unknown: 0 };
  let printMinutes = 0;
  for (const entry of printRows) {
    const duration = resolvePrintDuration(entry);
    printMinutes += duration.minutes;
    if (duration.source === "derived_print_timestamps") durationSources.derived += 1;
    else if (duration.source === "imported_native") durationSources.native += 1;
    else durationSources.unknown += 1;
  }
  printMinutes = round2(printMinutes);
  const machineCost = printMinutes > 0 ? round2((printMinutes / 60) * params.machineRatePerHour) : null;
  if (durationSources.unknown > 0) warnings.push(`${durationSources.unknown} print row(s) have no reliable duration (no native value, no exact print stamps) — their machine time stays 0, never guessed.`);
  if (durationSources.derived > 0) warnings.push(`${durationSources.derived} row(s) use duration DERIVED from exact print start/end stamps (labeled, not native).`);
  if (printMinutes <= 0) warnings.push("No reliable print minutes — machine-time component unavailable.");

  if (inkCost == null && machineCost == null) {
    return { ok: false, blockedReason: "No supported cost component is computable (no attributable ink rates and no print minutes). Nothing to write.", warnings };
  }

  // ---- exact item attribution (only when EVERY print row points at one item) ----
  const itemIds = [...new Set(printRows.map((entry) => entry.productionJobItemId).filter(Boolean))] as string[];
  const allAttributed = printRows.every((entry) => entry.productionJobItemId);
  const singleItem = params.job.items.length === 1 ? params.job.items[0] : null;
  const attributedItem =
    allAttributed && itemIds.length === 1
      ? params.job.items.find((item) => item.id === itemIds[0]) || null
      : singleItem;
  const itemTicketAttribution = attributedItem?.itemTicket || null;
  if (!itemTicketAttribution && params.job.items.length > 1) {
    warnings.push("Multi-item job without uniform item attribution — costs recorded at job level (schema has no usage->item link).");
  }

  const printers = [...new Set(unique.map((entry) => `${entry.printerSoftware || "?"}${entry.machineName ? `/${entry.machineName}` : ""}`))];
  const matchMethods = [...new Set(unique.map((entry) => matchMethodOf(entry, { jobTicket: params.job.jobTicket, items: params.job.items })))];
  const entryIds = unique.map((entry) => entry.id);
  const appliedAt = (params.now || new Date()).toISOString();
  const baseProvenance = {
    engine: WRITEBACK_ENGINE_VERSION,
    appliedAt,
    appliedBy: "production-board",
    ratesSource: "verified_machine_channel_costs",
    entryIds,
    duplicatesIgnored,
    cutRowsExcluded,
    runCount,
    reprintDetected,
    printers,
    matchMethods,
    itemTicket: itemTicketAttribution,
    partial: true, // NEVER a complete finalized job cost
  };

  const rows: WritebackUsageDraft[] = [];
  if (inkCost != null) {
    rows.push({
      componentKey: COMPONENT_INK,
      materialName: "Print-log ink (imported)",
      materialType: "ink",
      unit: "ml",
      usedQty: inkMl,
      costPerUnit: inkMl > 0 ? round2(inkCost / inkMl) : 0,
      totalCost: inkCost,
      source: PRINT_LOG_USAGE_SOURCE,
      notes: provenanceNote(COMPONENT_INK, { ...baseProvenance, inkMl, coveredRows: costedRows, totalPrintRows: printRows.length }),
    });
  }
  if (machineCost != null) {
    rows.push({
      componentKey: COMPONENT_MACHINE_TIME,
      materialName: "Print-log machine time (imported)",
      materialType: "other",
      unit: "hour",
      usedQty: round2(printMinutes / 60),
      costPerUnit: params.machineRatePerHour,
      totalCost: machineCost,
      source: PRINT_LOG_USAGE_SOURCE,
      notes: provenanceNote(COMPONENT_MACHINE_TIME, { ...baseProvenance, printMinutes, machineRatePerHour: params.machineRatePerHour, durationSources }),
    });
  }

  warnings.push("Material/media cost is preview-only (name-based matching, not write-grade) and was NOT written.");
  warnings.push("This is a PARTIAL print-cost import — labor, packing, shipping, outsourcing, and reprint extras stay manual; the job is NOT finalized.");

  return {
    ok: true,
    rows,
    totalCost: round2((inkCost || 0) + (machineCost || 0)),
    inkCost,
    machineCost,
    inkMl,
    printMinutes,
    machineRatePerHour: params.machineRatePerHour,
    printRowCount: printRows.length,
    cutRowsExcluded,
    duplicatesIgnored,
    runCount,
    reprintDetected,
    printers,
    matchMethods,
    itemTicketAttribution,
    entryIds,
    warnings,
  };
}
