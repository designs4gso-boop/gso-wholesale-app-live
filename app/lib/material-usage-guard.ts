// 2026-11-15 — guards for a MANUALLY recorded production material use.
//
// Stock for a job is only ever deducted by the manual "Deduct from material
// stock" option on a material-use entry (automatic reservation / consumption
// is OFF). These two rules keep that one path from counting an entry twice.
// Pure: no db, no auth.

/** The same entry posted again inside this window is a double-click / retry. */
export const MATERIAL_USAGE_REPLAY_WINDOW_MS = 15_000;

/** Source value owned by the print-log import; its rows are replaced wholesale on every re-import. */
const PRINT_LOG_SOURCE = "print_log";

/**
 * A manual entry never takes the print-log source: imported print-log rows are
 * deleted and re-created on each "pull print-log actuals", with no stock
 * restore, so a manual row stored under that source (and its stock deduction)
 * would silently disappear.
 */
export function manualUsageSource(posted: unknown): string {
  const value = String(posted ?? "").trim() || "manual";
  return value === PRINT_LOG_SOURCE ? "manual" : value;
}

export type MaterialUsageEntry = {
  jobId: string;
  materialId: string | null;
  materialName: string;
  unit: string;
  usedQty: number;
  pulledQty: number;
  wasteQty: number;
  reprintQty: number;
};

/** Is `existing` the very same entry, recorded moments ago? (Checked field by field — never trusts the query alone.) */
export function isMaterialUsageReplay(existing: any, entry: MaterialUsageEntry, now: Date = new Date()): boolean {
  if (!existing) return false;
  const createdAt = existing.createdAt ? new Date(existing.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdAt)) return false;
  const age = now.getTime() - createdAt;
  if (age < 0 || age > MATERIAL_USAGE_REPLAY_WINDOW_MS) return false;
  const same = (a: unknown, b: unknown) => Number(a || 0) === Number(b || 0);
  return String(existing.jobId || "") === entry.jobId
    && (existing.materialId || null) === (entry.materialId || null)
    && String(existing.materialName || "") === entry.materialName
    && String(existing.unit || "") === entry.unit
    && String(existing.source || "") !== PRINT_LOG_SOURCE
    && same(existing.usedQty, entry.usedQty)
    && same(existing.pulledQty, entry.pulledQty)
    && same(existing.wasteQty, entry.wasteQty)
    && same(existing.reprintQty, entry.reprintQty);
}
