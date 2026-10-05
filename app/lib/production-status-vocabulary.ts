// Canonical STAFF production status vocabulary (hardening, 2026-10-04).
//
// This is the exact list the Production page has always offered staff. The
// manual "change status" action now accepts ONLY these values; arbitrary
// strings are rejected. Client-safe, no Prisma.
//
// NOTE for agent work: the deterministic transition guard used by agents
// (app/lib/ops/production-transitions.ts) models the subset of these statuses
// observed in live data; staff-only stages such as prepress, proof_needed,
// ready_to_print, laminating, packing and ready_for_pickup are treated as
// UNKNOWN by the agent guard and therefore fail closed. That gap is
// documented, not papered over, in docs/GSO_OPS_RUNTIME_EXECUTION_AUDIT.md.

export const PRODUCTION_STATUS_OPTIONS = [
  { label: "New", value: "new" },
  { label: "Prepress", value: "prepress" },
  { label: "Proof Needed", value: "proof_needed" },
  { label: "Proof Sent", value: "proof_sent" },
  { label: "Proof Approved", value: "proof_approved" },
  { label: "Ready to Print", value: "ready_to_print" },
  { label: "Printing", value: "printing" },
  { label: "Cutting", value: "cutting" },
  { label: "Laminating", value: "laminating" },
  { label: "QC", value: "qc" },
  { label: "Packing", value: "packing" },
  { label: "Ready for Pickup", value: "ready_for_pickup" },
  { label: "Shipped", value: "shipped" },
  { label: "Completed", value: "completed" },
  { label: "On Hold", value: "on_hold" },
  { label: "Reprint Needed", value: "reprint_needed" },
  { label: "Cancelled", value: "cancelled" },
] as const;

export type StaffProductionStatus = (typeof PRODUCTION_STATUS_OPTIONS)[number]["value"];

export const STAFF_PRODUCTION_STATUSES: readonly string[] = PRODUCTION_STATUS_OPTIONS.map((o) => o.value);

export function isStaffProductionStatus(value: unknown): value is StaffProductionStatus {
  return typeof value === "string" && STAFF_PRODUCTION_STATUSES.includes(value);
}

export function staffStatusLabel(value: string): string {
  return PRODUCTION_STATUS_OPTIONS.find((o) => o.value === value)?.label || value;
}
