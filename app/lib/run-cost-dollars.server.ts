// 2026-11-20 — RUN COST IN DOLLARS (owner / financially authorized managers).
//
// What each production run cost, from data that is already approved:
//   ink        the press result's ink volume x the machine's ink cost per mL
//              (computeEntryCosts — the same function Actual Costs uses)   ACTUAL
//   pressTime  press minutes x the owner's machine recovery rate
//              (machineRatePerHour)                                         ACTUAL
//   material   } nothing records these per run or per item, so no actual is
//   finishing  } ever shown. For the ORIGINAL run only, the item's stored cost
//                snapshot (the quote / storefront estimate) may be shown,
//                labelled as the QUOTED ESTIMATE — never as an actual, and
//                never added to the actual totals.
//
// Nothing is invented: a component with no approved data is "not_recorded"
// with the reason, its amount is null, and the run is marked PARTIAL COST.
// Labour is not a component at all (no approved per-run labour exists).
//
// Treatment (from production-run.ts): original = cost of the order; a
// shop-absorbed reprint (internal or warranty) adds cost and no revenue; a
// customer-paid replacement adds cost and the ERP charges nothing. Pure — no
// database.

import { reprintNumberOfRipName, reprintNumberOfRun, runCostClassOf, runKindLabel, RUN_COST_TREATMENT, type RunCostClass, type RunRow } from "./production-run";
import { computeEntryCosts, machineCost, type BrandInkRates, type EntryInput } from "./rip-actual-costs.server";

export const RUN_COST_INCLUDED = ["ink (press result x ink cost per mL)", "press time (press result x machine recovery rate)"];
export const RUN_COST_NOT_INCLUDED = ["material", "labour", "finishing / application"];
export const PARTIAL_COST_LABEL = "PARTIAL COST";
export const ACTUAL_PLUS_ESTIMATE_LABEL = "ACTUAL PRESS COST + QUOTED ESTIMATE";
export const COMPLETE_COST_LABEL = "COMPLETE COST";

export type RunCostBasis = "actual" | "estimate" | "not_recorded";
export type RunCostComponent = { amount: number | null; basis: RunCostBasis; note: string };
export type RunCostComponents = { ink: RunCostComponent; pressTime: RunCostComponent; material: RunCostComponent; finishing: RunCostComponent };

export type RunCostDollars = {
  runNumber: number | null; label: string; costClass: RunCostClass; treatment: string;
  /** internal | warranty | customer_paid for a reprint / remake; null for the original */
  chargeType: string | null;
  entries: number; inkCost: number | null; pressCost: number;
  /** ACTUAL dollars only (ink + press time). A quoted estimate is never part of it. */
  knownCost: number;
  /** quoted estimate dollars shown for this run (material + finishing, original run only); null when none */
  estimateCost: number | null;
  /** true when some press result of this run could not be costed (machine or ink rate unknown) */
  inkIncomplete: boolean;
  components: RunCostComponents;
  /** true only when every component is an ACTUAL */
  complete: boolean;
  /** PARTIAL COST whenever any component is not recorded */
  costLabel: string;
  partial: boolean;
};
export type RunCostDollarsSummary = {
  runs: RunCostDollars[];
  /** ACTUAL dollars by treatment — kept apart, never netted against each other */
  original: number; shopAbsorbed: number; customerPaid: number;
  /** the shop-absorbed total, split by who-pays */
  shopAbsorbedInternal: number; shopAbsorbedWarranty: number;
  /** quoted estimate (material + finishing) for the original run; null when the item has none */
  originalEstimate: number | null;
  complete: boolean; costLabel: string;
  included: string[]; notIncluded: string[];
  /** always "none": no run adds revenue and nothing is charged from here */
  revenueChange: "none";
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/* ---------------- quoted estimate from the stored cost snapshot ---------------- */

// Cost lines the calculator writes (product-driven-costing / auto-costing). Only
// lines that carry a real amount count: a line marked "missing" or "excluded",
// or with no positive amount, is not an estimate of anything.
const MATERIAL_LINE_KEYS = new Set(["material", "blank", "lid"]);
const FINISHING_LINE_KEYS = new Set(["finishing", "finishing_setup", "finishing_grommets", "finishing_hems", "cutting", "weeding", "application", "hang_hole"]);

export type QuotedEstimate = { material: number | null; finishing: number | null; source: string | null };

/**
 * Material and finishing dollars the item was QUOTED with, read from the item's
 * own stored cost snapshot (written once when the quote / order was costed).
 * Line amounts are totals for the quoted quantity. Null when the snapshot has no
 * such line — nothing is derived from unit cost, price or any other number.
 */
export function quotedEstimateOf(costSnapshot: unknown): QuotedEstimate {
  let snapshot: any = null;
  try { snapshot = typeof costSnapshot === "string" ? JSON.parse(costSnapshot) : costSnapshot && typeof costSnapshot === "object" ? costSnapshot : null; } catch { snapshot = null; }
  const lines: any[] = Array.isArray(snapshot?.productBreakdown?.lines) ? snapshot.productBreakdown.lines : Array.isArray(snapshot?.autoBreakdown?.lines) ? snapshot.autoBreakdown.lines : [];
  const sumOf = (keys: Set<string>): number | null => {
    const hits = lines.filter((line) => keys.has(String(line?.key || "")) && !["missing", "excluded"].includes(String(line?.source || "")) && Number.isFinite(Number(line?.amount)) && Number(line.amount) > 0);
    return hits.length ? round2(hits.reduce((sum, line) => sum + Number(line.amount), 0)) : null;
  };
  const material = sumOf(MATERIAL_LINE_KEYS);
  const finishing = sumOf(FINISHING_LINE_KEYS);
  return { material, finishing, source: material !== null || finishing !== null ? "the item's stored cost snapshot (quote / order estimate)" : null };
}

export type RunCostOptions = {
  /** the item's stored cost snapshot (ProductionJobItem.costSnapshot) — used for the ORIGINAL run's quoted estimate only */
  costSnapshot?: unknown;
  /** how many material-use rows the JOB has (they are per job, never per item or run) */
  jobMaterialRows?: number;
};

const NO_PRESS_RESULT = "No press result received for this run yet.";
const MATERIAL_PER_RUN = "Material is not recorded per run.";
const FINISHING_PER_RUN = "Finishing / application is not recorded per run.";

export function runCostDollars(runs: RunRow[], entries: Array<EntryInput & { sourceJobName?: string | null }>, rates: BrandInkRates[], ratePerHour: number, options: RunCostOptions = {}): RunCostDollarsSummary {
  type Bucket = { reprint: number; run: RunRow | null; costClass: RunCostClass; entries: number; inkCost: number | null; pressCost: number; inkIncomplete: boolean };
  const buckets = new Map<string, Bucket>();
  const keyOf = (reprint: number | null, run: RunRow | null) => (reprint !== null ? `p${reprint}` : `run${run?.runNumber}`);
  const blank = (reprint: number, run: RunRow | null): Bucket => ({ reprint, run, costClass: run ? runCostClassOf(run) : reprint === 0 ? "original" : "internal_extra", entries: 0, inkCost: null, pressCost: 0, inkIncomplete: false });

  // every recorded run has a line, with or without a press result; so does the original production
  buckets.set("p0", blank(0, (runs || []).find((candidate) => reprintNumberOfRun(candidate) === 0) || null));
  for (const run of runs || []) {
    const reprint = reprintNumberOfRun(run);
    const key = keyOf(reprint, run);
    if (!buckets.has(key)) buckets.set(key, blank(reprint ?? Number.MAX_SAFE_INTEGER, run));
  }
  for (const entry of entries || []) {
    const reprint = reprintNumberOfRipName(entry.sourceJobName);
    const key = `p${reprint}`;
    const bucket = buckets.get(key) || blank(reprint, (runs || []).find((candidate) => reprintNumberOfRun(candidate) === reprint) || null);
    const costs = computeEntryCosts(entry, rates);
    bucket.entries += 1;
    if (costs.inkCost === null) bucket.inkIncomplete = true; else bucket.inkCost = (bucket.inkCost || 0) + costs.inkCost;
    bucket.pressCost += machineCost(Number(entry.printMinutes) || 0, ratePerHour);
    buckets.set(key, bucket);
  }

  const estimate = quotedEstimateOf(options.costSnapshot);
  const jobMaterialNote = Number(options.jobMaterialRows) > 0 ? ` The job has ${Number(options.jobMaterialRows)} material-use row(s); they are recorded for the whole job, not per item or run, so they are not split here.` : "";

  const rows: RunCostDollars[] = [...buckets.values()]
    .sort((a, b) => a.reprint - b.reprint || Number(a.run?.runNumber || 0) - Number(b.run?.runNumber || 0))
    .map((bucket) => {
      const { run, reprint } = bucket;
      const isOriginal = bucket.costClass === "original";
      const inkCost = bucket.inkCost === null ? null : round2(bucket.inkCost);
      const pressCost = round2(bucket.pressCost);
      const ink: RunCostComponent = !bucket.entries
        ? { amount: null, basis: "not_recorded", note: NO_PRESS_RESULT }
        : inkCost === null
          ? { amount: null, basis: "not_recorded", note: "The press result could not be matched to a machine ink rate, so no ink cost is calculated." }
          : { amount: inkCost, basis: "actual", note: bucket.inkIncomplete ? "Press result ink x ink cost per mL. INCOMPLETE: one press result of this run could not be costed." : "Press result ink x ink cost per mL." };
      const pressTime: RunCostComponent = !bucket.entries
        ? { amount: null, basis: "not_recorded", note: NO_PRESS_RESULT }
        : { amount: pressCost, basis: "actual", note: "Press minutes x the approved machine recovery rate." };
      const material: RunCostComponent = isOriginal && estimate.material !== null
        ? { amount: estimate.material, basis: "estimate", note: `QUOTED ESTIMATE from ${estimate.source} — not an actual.${jobMaterialNote}` }
        : { amount: null, basis: "not_recorded", note: `${isOriginal ? "No material line in the item's stored cost snapshot, and material use is not recorded per item." : MATERIAL_PER_RUN}${jobMaterialNote}` };
      const finishing: RunCostComponent = isOriginal && estimate.finishing !== null
        ? { amount: estimate.finishing, basis: "estimate", note: `QUOTED ESTIMATE from ${estimate.source} — not an actual.` }
        : { amount: null, basis: "not_recorded", note: isOriginal ? "No finishing line in the item's stored cost snapshot, and finishing is not recorded per item." : FINISHING_PER_RUN };
      const components: RunCostComponents = { ink, pressTime, material, finishing };
      const list = Object.values(components);
      const anyMissing = list.some((component) => component.basis === "not_recorded") || bucket.inkIncomplete;
      const complete = list.every((component) => component.basis === "actual") && !bucket.inkIncomplete;
      const estimateParts = [material, finishing].filter((component) => component.basis === "estimate");
      return {
        runNumber: run ? Number(run.runNumber) : reprint === 0 ? 1 : null,
        label: run ? `Run ${run.runNumber} — ${runKindLabel(run.kind)}` : reprint === 0 ? "Run 1 — Original" : `Reprint P${reprint} — no run recorded`,
        costClass: bucket.costClass, treatment: RUN_COST_TREATMENT[bucket.costClass],
        chargeType: isOriginal ? null : run ? String(run.chargeType || "internal") : null,
        entries: bucket.entries, inkCost, pressCost, knownCost: round2((bucket.inkCost || 0) + bucket.pressCost),
        estimateCost: estimateParts.length ? round2(estimateParts.reduce((sum, component) => sum + Number(component.amount || 0), 0)) : null,
        inkIncomplete: bucket.inkIncomplete, components, complete,
        costLabel: complete ? COMPLETE_COST_LABEL : anyMissing ? PARTIAL_COST_LABEL : ACTUAL_PLUS_ESTIMATE_LABEL,
        partial: !complete,
      };
    });

  const total = (pick: (row: RunCostDollars) => boolean) => round2(rows.filter(pick).reduce((sum, row) => sum + row.knownCost, 0));
  const complete = rows.every((row) => row.complete);
  const anyPartial = rows.some((row) => row.costLabel === PARTIAL_COST_LABEL);
  return {
    runs: rows,
    original: total((row) => row.costClass === "original"),
    shopAbsorbed: total((row) => row.costClass === "internal_extra"),
    customerPaid: total((row) => row.costClass === "customer_paid_extra"),
    shopAbsorbedInternal: total((row) => row.costClass === "internal_extra" && row.chargeType !== "warranty"),
    shopAbsorbedWarranty: total((row) => row.costClass === "internal_extra" && row.chargeType === "warranty"),
    originalEstimate: rows.find((row) => row.costClass === "original")?.estimateCost ?? null,
    complete, costLabel: complete ? COMPLETE_COST_LABEL : anyPartial ? PARTIAL_COST_LABEL : ACTUAL_PLUS_ESTIMATE_LABEL,
    included: RUN_COST_INCLUDED, notIncluded: RUN_COST_NOT_INCLUDED, revenueChange: "none",
  };
}
