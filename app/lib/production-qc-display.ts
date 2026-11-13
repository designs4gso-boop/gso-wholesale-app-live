// 2026-11-12 — CURRENT QC state and MOST RECENT REPRINT for one production item.
//
// Source of truth: the structured ProductionJobItem columns (migration
// 20261112090000). A reprint clears the item's current QC (qcResult / qcBy /
// qcAt / qcNote) and stamps lastReprint*, so the item needs a NEW QC PASS;
// earlier QC / reprint history stays in ProductionJobEvent. Items recorded
// before the migration fall back to their latest QC event.
// Pure, client-safe, no Prisma.

import { reprintReasonLabel } from "./production-fulfillment";
import { qcEventItemKey, qcResultOf, type QcGuardEvent } from "./production-qc-guard";

export type ItemQcStatus = "pending_reprint" | "pass" | "hold" | "fail" | "none";

export type ItemQcState = { status: ItemQcStatus; label: string; by: string | null; at: string | null };

export type ItemReprintSummary = { reason: string; reasonCode: string; by: string | null; at: string | null };

type QcItem = {
  itemTicket?: string | null;
  productTitle?: string | null;
  qcResult?: string | null;
  qcBy?: string | null;
  qcAt?: Date | string | null;
  lastReprintReason?: string | null;
  lastReprintBy?: string | null;
  lastReprintAt?: Date | string | null;
};

export const QC_REQUIRED_AFTER_REPRINT = "Requires new QC after reprint";

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const time = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : 0);
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

const RESULT_LABEL: Record<"pass" | "hold" | "fail", string> = { pass: "PASS", hold: "HOLD / REVIEW", fail: "REPRINT REQUIRED / FAIL" };

/** True while the item's most recent reprint has not been QC'd yet. */
export function awaitingQcAfterReprint(item: QcItem): boolean {
  return Boolean(item.lastReprintAt) && (!item.qcAt || time(item.qcAt) < time(item.lastReprintAt));
}

export function itemQcState(item: QcItem, events: (QcGuardEvent & { createdBy?: string | null })[] = []): ItemQcState {
  if (awaitingQcAfterReprint(item)) return { status: "pending_reprint", label: QC_REQUIRED_AFTER_REPRINT, by: null, at: null };
  const structured = norm(item.qcResult);
  if (structured) {
    const result = structured === "pass" ? "pass" : structured === "hold" ? "hold" : "fail";
    return { status: result, label: RESULT_LABEL[result], by: item.qcBy ?? null, at: iso(item.qcAt) };
  }
  // pre-migration items: latest QC event for this item
  const keys = [norm(item.itemTicket), norm(item.productTitle)].filter(Boolean);
  const latest = events
    .filter((event) => qcResultOf(event) != null && keys.includes(qcEventItemKey(event)))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (!latest) return { status: "none", label: "No QC recorded yet", by: null, at: null };
  if (norm(latest.eventType) === "qc_result" && norm(latest.newValue) === "reprint_required" && /^QC reset by reprint/i.test(String(latest.message || ""))) {
    return { status: "pending_reprint", label: QC_REQUIRED_AFTER_REPRINT, by: null, at: null };
  }
  const result = qcResultOf(latest)!;
  return { status: result, label: RESULT_LABEL[result], by: latest.createdBy ?? null, at: iso(latest.createdAt) };
}

export function itemReprintSummary(item: QcItem): ItemReprintSummary | null {
  if (!item.lastReprintAt || !item.lastReprintReason) return null;
  return { reason: reprintReasonLabel(item.lastReprintReason), reasonCode: item.lastReprintReason, by: item.lastReprintBy ?? null, at: iso(item.lastReprintAt) };
}
