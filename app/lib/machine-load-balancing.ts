// 2026-11-11 — AUTO printer selection by operational load (owner rule).
//
// When a job has NO gloss, both presses are compatible (the Mimaki prints
// CMYK and White; the Roland prints everything). AUTO must then pick the LESS
// BUSY compatible press — never a permanent Mimaki default, never the press
// that merely looks cheaper, never the first entry of a list, never random.
//
// Load metrics, in owner order of preference:
//   1. remaining queued/assigned estimated machine MINUTES per press
//   2. active + queued production WORKLOAD (open print-stage items) per press
// A metric is used only when it is COMPLETE: every open print-stage item is
// attributed to a press (and, for minutes, carries an estimate). Anything
// less, a missing snapshot, or a tie means there is no defensible "less busy"
// answer — the result is UNAVAILABLE and the operator must choose a printer.
//
// PURE and client-safe: the quote route and Production intake both call
// selectLessBusyPrinter, so quote routing and Production routing agree.

export type LoadPrinter = "mimaki" | "roland";

export type MachineLoadEntry = {
  /** Open print-stage items attributed to this press. */
  openItems: number;
  /** Sum of estimated machine minutes for those items; null when any lacks one. */
  estimatedMinutes: number | null;
};

export type MachineLoadSnapshot = {
  source: string;
  capturedAt: string;
  byPrinter: Record<LoadPrinter, MachineLoadEntry>;
  /** Open print-stage items with NO press attribution. Any > 0 makes the counts incomplete. */
  unattributedOpenItems: number;
};

export type LoadSelection =
  | { ok: true; printer: LoadPrinter; metric: "estimated_minutes" | "open_workload"; detail: string }
  | { ok: false; reason: "AUTO_MACHINE_LOAD_UNAVAILABLE"; detail: string };

export const AUTO_MACHINE_LOAD_UNAVAILABLE = "AUTO_MACHINE_LOAD_UNAVAILABLE" as const;

const NAMES: Record<LoadPrinter, string> = { mimaki: "Mimaki UCJV300", roland: "Roland LG-640" };

/**
 * Choose the less busy press among `candidates` (compatible, and cost-ready
 * when the caller knows calibration). Exactly one candidate needs no load.
 */
export function selectLessBusyPrinter(candidates: LoadPrinter[], load: MachineLoadSnapshot | null | undefined): LoadSelection {
  const unique = Array.from(new Set(candidates));
  if (unique.length === 1) return { ok: true, printer: unique[0], metric: "open_workload", detail: `${NAMES[unique[0]]} is the only eligible press.` };
  if (unique.length === 0) return { ok: false, reason: AUTO_MACHINE_LOAD_UNAVAILABLE, detail: "No eligible press for automatic selection." };
  if (!load) {
    return { ok: false, reason: AUTO_MACHINE_LOAD_UNAVAILABLE, detail: "No machine-load data is available, so a less-busy press cannot be determined. Select Mimaki or Roland." };
  }
  if (load.unattributedOpenItems > 0) {
    return {
      ok: false,
      reason: AUTO_MACHINE_LOAD_UNAVAILABLE,
      detail: `${load.unattributedOpenItems} open print-stage item(s) have no press assigned, so per-press load is incomplete. Select Mimaki or Roland (or assign a press to the open items).`,
    };
  }
  const entries = unique.map((printer) => ({ printer, ...load.byPrinter[printer] }));
  const pick = (metric: "estimated_minutes" | "open_workload", value: (e: (typeof entries)[number]) => number, unit: string): LoadSelection => {
    const sorted = [...entries].sort((a, b) => value(a) - value(b));
    const summary = entries.map((e) => `${NAMES[e.printer]} ${value(e).toFixed(metric === "estimated_minutes" ? 1 : 0)} ${unit}`).join(", ");
    if (value(sorted[0]) === value(sorted[1])) {
      return { ok: false, reason: AUTO_MACHINE_LOAD_UNAVAILABLE, detail: `Both presses carry the same load (${summary}) — neither is less busy. Select Mimaki or Roland.` };
    }
    return { ok: true, printer: sorted[0].printer, metric, detail: `AUTO — ${NAMES[sorted[0].printer]} is less busy (${summary}; ${load.source}).` };
  };
  if (entries.every((e) => e.estimatedMinutes != null && Number.isFinite(e.estimatedMinutes))) {
    return pick("estimated_minutes", (e) => e.estimatedMinutes as number, "queued min");
  }
  return pick("open_workload", (e) => e.openItems, "open item(s)");
}
