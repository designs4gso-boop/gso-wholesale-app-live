// PRODUCTION QC COMPLETION GUARD — OWNER DECISION 2026-10-07.
//
// A production job may NOT move to COMPLETED unless QC has a valid PASS
// result. Implemented on the EXISTING data: ProductionJobEvent rows written by
// the Production Board's "QC / Reprint / Revision" form —
//   eventType  production_run_qc_passed | production_run_qc_hold |
//              production_run_qc_failed   (always written)
//   oldValue   item ticket / product title (written since 2026-10-07; older
//              rows carry the item inside the message: "QC PASS for <item> (run ...)")
//   newValue   pass | hold | reprint_required (since 2026-10-07)
// plus the machine-readable twin `qc_result` (newValue = result).
//
// Rule: every item on the job needs a QC result whose LATEST entry is PASS.
// A later HOLD / REPRINT for the same item invalidates its earlier pass. A
// job with no items needs at least one PASS. Only the transition INTO
// "completed" is guarded — earlier stages are never blocked and jobs that
// are already completed are never touched. No schema change. Client-safe.

export const QC_PASS_REQUIRED_MESSAGE = "QC PASS REQUIRED BEFORE COMPLETION";

export type QcGuardEvent = { eventType: string; message?: string | null; oldValue?: string | null; newValue?: string | null; createdAt?: Date | string | null };
export type QcGuardItem = { id?: string; itemTicket?: string | null; productTitle?: string | null };

export type QcResult = "pass" | "hold" | "fail";

export type QcItemState = { key: string; label: string; latest: QcResult | null; passes: number; events: number };

export type QcCompletionVerdict = {
  ok: boolean;
  message: string;
  items: QcItemState[];
  passCount: number;
  missing: string[]; // items with no QC result at all
  notPassed: string[]; // items whose latest result is hold / fail
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function qcResultOf(event: QcGuardEvent): QcResult | null {
  const type = norm(event.eventType);
  if (type === "qc_result") {
    const v = norm(event.newValue);
    if (v === "pass") return "pass";
    if (v === "hold") return "hold";
    if (v === "reprint_required" || v === "fail" || v === "failed") return "fail";
    return null;
  }
  if (type === "production_run_qc_passed") return "pass";
  if (type === "production_run_qc_hold") return "hold";
  if (type === "production_run_qc_failed") return "fail";
  return null;
}

/** Item identity carried by a QC event: oldValue (new rows) or the "for <item> (run" fragment of the message (older rows). */
export function qcEventItemKey(event: QcGuardEvent): string {
  const explicit = norm(event.oldValue);
  if (explicit) return explicit;
  const m = String(event.message || "").match(/\bfor (.+?) \(run /i);
  return m ? norm(m[1]) : "";
}

function itemKeys(item: QcGuardItem): string[] {
  return [norm(item.itemTicket), norm(item.productTitle)].filter(Boolean);
}

/** Pure verdict. Events may be in any order; createdAt decides "latest" (ties: array order, later wins). */
export function evaluateQcForCompletion(items: QcGuardItem[], events: QcGuardEvent[]): QcCompletionVerdict {
  const qcEvents = events
    .map((e, index) => ({ e, index, result: qcResultOf(e), key: qcEventItemKey(e), at: e.createdAt ? new Date(e.createdAt).getTime() : 0 }))
    .filter((x) => x.result != null)
    .sort((a, b) => (a.at - b.at) || (a.index - b.index));
  // only one of the twin rows (production_run_qc_* + qc_result) should count per inspection — dedupe by (key, result, time)
  const seen = new Set<string>();
  const unique = qcEvents.filter((x) => { const k = `${x.key}|${x.result}|${x.at}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const states: QcItemState[] = [];
  const missing: string[] = [];
  const notPassed: string[] = [];
  if (items.length) {
    for (const item of items) {
      const keys = itemKeys(item);
      const mine = unique.filter((x) => keys.includes(x.key));
      const latest = mine.length ? mine[mine.length - 1].result : null;
      const label = item.itemTicket || item.productTitle || item.id || "item";
      states.push({ key: keys[0] || label, label, latest, passes: mine.filter((x) => x.result === "pass").length, events: mine.length });
      if (!mine.length) missing.push(label);
      else if (latest !== "pass") notPassed.push(label);
    }
  }
  const passCount = unique.filter((x) => x.result === "pass").length;
  let ok: boolean;
  if (items.length) ok = missing.length === 0 && notPassed.length === 0;
  else ok = passCount > 0 && unique[unique.length - 1]?.result === "pass";
  const detail = [
    missing.length ? `no QC result for: ${missing.join(", ")}` : "",
    notPassed.length ? `latest QC result is not PASS for: ${notPassed.join(", ")}` : "",
    !items.length && !passCount ? "no QC PASS recorded on this job" : "",
    !items.length && passCount && unique[unique.length - 1]?.result !== "pass" ? "the latest QC result is not PASS" : "",
  ].filter(Boolean).join("; ");
  return {
    ok,
    message: ok ? "QC PASS recorded for every item." : `${QC_PASS_REQUIRED_MESSAGE} — ${detail}. Record QC PASS with the QC / Reprint / Revision control on each item, then complete the job.`,
    items: states,
    passCount,
    missing,
    notPassed,
  };
}

/** True when a status change needs the QC guard: moving INTO completed from any other status. */
export function completionGuardApplies(fromStatus: unknown, toStatus: unknown): boolean {
  return norm(toStatus) === "completed" && norm(fromStatus) !== "completed";
}
