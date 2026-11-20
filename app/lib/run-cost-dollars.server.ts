// 2026-11-20 — RUN COST IN DOLLARS (owner / financially authorized managers).
//
// What each production run cost on the press, from data that is already
// approved: the press result's ink volume x the machine's ink cost per mL
// (computeEntryCosts — the same function Actual Costs uses), and press time x
// the owner's machine recovery rate (machineRatePerHour).
//
// PARTIAL BY DESIGN. Material, labour, finishing and application are NOT in the
// number: nothing records them per run, and no value is invented for them. The
// result always says what is included and what is missing.
//
// Treatment (from production-run.ts): original = cost of the order; a
// shop-absorbed or warranty reprint adds cost and no revenue; a customer-paid
// replacement adds cost and the ERP charges nothing. Pure — no database.

import { reprintNumberOfRipName, reprintNumberOfRun, runCostClassOf, runKindLabel, RUN_COST_TREATMENT, type RunCostClass, type RunRow } from "./production-run";
import { computeEntryCosts, machineCost, type BrandInkRates, type EntryInput } from "./rip-actual-costs.server";

export const RUN_COST_INCLUDED = ["ink (press result x ink cost per mL)", "press time (press result x machine recovery rate)"];
export const RUN_COST_NOT_INCLUDED = ["material", "labour", "finishing / application"];

export type RunCostDollars = {
  runNumber: number | null; label: string; costClass: RunCostClass; treatment: string;
  entries: number; inkCost: number | null; pressCost: number; knownCost: number;
  /** true when some press result of this run could not be costed (machine or ink rate unknown) */
  inkIncomplete: boolean; partial: true;
};
export type RunCostDollarsSummary = { runs: RunCostDollars[]; original: number; shopAbsorbed: number; customerPaid: number; included: string[]; notIncluded: string[]; revenueChange: "none" };

const round2 = (value: number) => Math.round(value * 100) / 100;

export function runCostDollars(runs: RunRow[], entries: Array<EntryInput & { sourceJobName?: string | null }>, rates: BrandInkRates[], ratePerHour: number): RunCostDollarsSummary {
  const buckets = new Map<number, RunCostDollars>();
  for (const entry of entries || []) {
    const reprint = reprintNumberOfRipName(entry.sourceJobName);
    const run = (runs || []).find((candidate) => reprintNumberOfRun(candidate) === reprint) || null;
    const costClass: RunCostClass = run ? runCostClassOf(run) : reprint === 0 ? "original" : "internal_extra";
    const bucket: RunCostDollars = buckets.get(reprint) || {
      runNumber: run ? Number(run.runNumber) : reprint === 0 ? 1 : null,
      label: run ? `Run ${run.runNumber} — ${runKindLabel(run.kind)}` : reprint === 0 ? "Run 1 — Original" : `Reprint P${reprint} — no run recorded`,
      costClass, treatment: RUN_COST_TREATMENT[costClass], entries: 0, inkCost: null, pressCost: 0, knownCost: 0, inkIncomplete: false, partial: true as const,
    };
    const costs = computeEntryCosts(entry, rates);
    bucket.entries += 1;
    if (costs.inkCost === null) bucket.inkIncomplete = true; else bucket.inkCost = (bucket.inkCost || 0) + costs.inkCost;
    bucket.pressCost += machineCost(Number(entry.printMinutes) || 0, ratePerHour);
    buckets.set(reprint, bucket);
  }
  const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => ({ ...bucket, inkCost: bucket.inkCost === null ? null : round2(bucket.inkCost), pressCost: round2(bucket.pressCost), knownCost: round2((bucket.inkCost || 0) + bucket.pressCost) }));
  const total = (costClass: RunCostClass) => round2(rows.filter((row) => row.costClass === costClass).reduce((sum, row) => sum + row.knownCost, 0));
  return { runs: rows, original: total("original"), shopAbsorbed: total("internal_extra"), customerPaid: total("customer_paid_extra"), included: RUN_COST_INCLUDED, notIncluded: RUN_COST_NOT_INCLUDED, revenueChange: "none" };
}
