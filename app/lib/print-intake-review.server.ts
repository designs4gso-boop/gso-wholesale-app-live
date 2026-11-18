// Phase 15H.3 — Print Intake review/retry: pure helpers for the
// server-authoritative disposition model. The local agent JSONL ledger is a
// CACHE; PrintIntake rows are the truth about whether a hash may be retried.
//
// Disposition vocabulary (PrintIntake.status — existing column, no schema
// change): routed | review | failed | retry_allowed | assigned | rejected.

export const REVIEW_STATUSES = ["review", "failed", "retry_allowed", "assigned", "rejected"] as const;

export type IntakeDisposition = "keep_blocked" | "retry_allowed" | "already_routed" | "rejected" | "assigned";

// Machine-readable review reason codes (15H.3-D). Human labels below.
// Patch C (2026-11-18): a dropped file with no existing job to link to. It
// never creates a job; a person links it from Incoming Print Files.
export const NEEDS_LINK_TO_JOB_REASON = "needs_link_to_job";
export const NEEDS_LINK_TO_JOB_LABEL = "NEEDS REVIEW — LINK TO JOB";

// Patch B (2026-11-18): routing instructions that contradict each other are
// never auto-routed; the queue shows them as a printer conflict.
export const PRINTER_CONFLICT_LABEL = "NEEDS REVIEW — PRINTER CONFLICT";
export const PRINTER_CONFLICT_REASONS = ["printer_token_conflict", "premium_mode_mimaki_contradiction", "printer_assignment_contradiction", "layer_printer_split"];

export const REVIEW_REASON_LABELS: Record<string, string> = {
  layer_printer_split: "Another layer of this same job was already sent to the other press — one job is never split across presses.",
  needs_link_to_job: "No existing production job matches this file — pick the job with Assign.",
  conflicting_tickets: "Filename carries conflicting GSO tickets.",
  unknown_ticket: "Ticket in the filename is not on any eligible job.",
  ticket_folder_mismatch: "Filename ticket and folder ticket disagree.",
  ticket_on_closed_job: "Ticket belongs to a completed/closed job.",
  ambiguous_candidates: "Two or more production jobs/items match.",
  unsupported_file_type: "Not a supported artwork file type.",
  printer_token_conflict: "The job's files name BOTH printers.",
  premium_mode_mimaki_contradiction: "Gloss mode with a Mimaki token (gloss is not operational on the Mimaki).",
  printer_assignment_contradiction: "Filename printer tag contradicts the press assigned in the ERP.",
  auto_machine_load_unavailable: "Auto press selection unavailable (machine load incomplete) — assign Mimaki or Roland, or add a MIMAKI / ROLAND filename tag.",
  unknown_production_requirements: "No deterministic printer/mode could be derived.",
  ticket_allocation_failed: "Ticket allocation/DB failure (historical — print intake no longer creates jobs).",
  hot_folder_unreachable: "Machine hot folder is disabled or unreachable on the agent.",
  copy_verify_failed: "Routed copy failed size verification.",
  legacy_ledger_blocked: "Blocked by a pre-15F.0J.5 agent ledger entry — release to retry under current logic.",
  manual_review: "Manually placed in review.",
  rejected_by_owner: "Rejected by the owner — the agent will not retry it.",
};

// Map raw route-plan/report reason strings onto ONE canonical code.
export function canonicalReviewReason(reasons: string[] | string | null | undefined): string {
  const list = (Array.isArray(reasons) ? reasons : [String(reasons || "")]).map((reason) => String(reason || ""));
  const text = list.join(" | ");
  if (/rejected_by_owner/.test(text)) return "rejected_by_owner";
  if (/needs_link_to_job/.test(text)) return NEEDS_LINK_TO_JOB_REASON;
  if (/conflicting_printer_tokens/.test(text)) return "printer_token_conflict";
  if (/layer_split_sibling_already_routed/.test(text)) return "layer_printer_split";
  // white_gloss_job_but_erp_assigned_mimaki / premium_mode_but_mimaki_token are historical (pre-2026-11-11) codes.
  if (/premium_mode_but_mimaki_token|gloss_mode_but_mimaki_token|white_gloss_job_but_erp_assigned_mimaki|gloss_job_but_mimaki_selected/.test(text)) return "premium_mode_mimaki_contradiction";
  if (/roland_filename_tag_but_erp_assigned_mimaki|mimaki_filename_tag_but_erp_assigned_roland/.test(text)) return "printer_assignment_contradiction";
  if (/auto_machine_load_unavailable/.test(text)) return "auto_machine_load_unavailable";
  if (/not_an_artwork_file_type/.test(text)) return "unsupported_file_type";
  if (/matches_multiple|multiple_items|multiple_jobs|ambiguous/i.test(text)) return "ambiguous_candidates";
  if (/_not_found_in_eligible_jobs/.test(text)) return "unknown_ticket";
  if (/advisory_lock_failed|schema_mismatch|print_intake_create_failed|production_job_create_failed|unique_conflict|ticket_allocation_exhausted/.test(text)) return "ticket_allocation_failed";
  if (/hot_folder|routing.*disabled|route_blocked/i.test(text)) return "hot_folder_unreachable";
  if (/copy_length_mismatch|copy_verify/.test(text)) return "copy_verify_failed";
  if (/machine_summary_contradictory|machine_unresolved|no_deterministic_match|no_rip_name/.test(text)) return "unknown_production_requirements";
  if (/legacy_ledger/.test(text)) return "legacy_ledger_blocked";
  return "manual_review";
}

export function reviewReasonLabel(code: string | null | undefined): string {
  return REVIEW_REASON_LABELS[String(code || "")] || String(code || "Unknown reason");
}

// PrintIntake.status -> agent-facing disposition (15H.3-B).
export function dispositionOf(row: { status: string | null; matchedProductionJobId?: string | null; generatedProductionJobId?: string | null } | null): {
  disposition: IntakeDisposition;
  retryAllowed: boolean;
} {
  const status = String(row?.status || "");
  if (!row) return { disposition: "keep_blocked", retryAllowed: false };
  if (status === "routed") return { disposition: "already_routed", retryAllowed: false };
  if (status === "retry_allowed") return { disposition: "retry_allowed", retryAllowed: true };
  if (status === "assigned") return { disposition: "assigned", retryAllowed: true };
  if (status === "rejected") return { disposition: "rejected", retryAllowed: false };
  return { disposition: "keep_blocked", retryAllowed: false }; // review, failed, anything else
}

// ---------- audit trail inside rawParsedHints JSON (no schema change) ----------

export type IntakeAuditEntry = { at: string; actor: string; action: string; reason?: string | null };

export function appendIntakeAudit(rawParsedHints: string | null, entry: IntakeAuditEntry): string {
  let parsed: Record<string, unknown> = {};
  try {
    const existing = rawParsedHints ? JSON.parse(rawParsedHints) : null;
    if (existing && typeof existing === "object" && !Array.isArray(existing)) parsed = existing as Record<string, unknown>;
    else if (existing != null) parsed = { _original: existing };
  } catch {
    parsed = rawParsedHints ? { _originalText: String(rawParsedHints).slice(0, 2000) } : {};
  }
  const audit = Array.isArray(parsed.audit) ? (parsed.audit as IntakeAuditEntry[]) : [];
  parsed.audit = [...audit, entry].slice(-30);
  return JSON.stringify(parsed);
}

export function readIntakeMeta(rawParsedHints: string | null): Record<string, any> {
  try {
    const parsed = rawParsedHints ? JSON.parse(rawParsedHints) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

// ---------- owner assignment validation (15H.3-I) — pure + testable ----------

export type AssignableJob = {
  id: string;
  shop: string;
  active: boolean;
  status: string;
  actualCostFinalized: boolean;
  jobTicket: string | null;
  items: Array<{ id: string; itemTicket: string | null }>;
};

const CLOSED_JOB_STATUSES = new Set(["completed", "cancelled", "canceled", "archived"]);

export function validateIntakeAssignment(params: {
  shop: string;
  job: AssignableJob | null;
  itemId: string | null;
}): { ok: true; item: { id: string; itemTicket: string | null } | null } | { ok: false; reason: string } {
  const { shop, job, itemId } = params;
  if (!job || job.shop !== shop) return { ok: false, reason: "Job not found." }; // never leak cross-shop existence
  if (!job.active) return { ok: false, reason: "Job is inactive — reactivate it before assigning artwork." };
  if (job.actualCostFinalized) return { ok: false, reason: "Job actual cost is FINALIZED — use the reprint/reopen flow instead of silently attaching new artwork." };
  if (CLOSED_JOB_STATUSES.has(String(job.status || "").toLowerCase())) {
    return { ok: false, reason: "Job is completed/closed — use the reprint/reopen flow instead of silently attaching new artwork." };
  }
  if (job.items.length > 1) {
    if (!itemId) return { ok: false, reason: "This job has multiple items — pick the exact item." };
    const item = job.items.find((candidate) => candidate.id === itemId);
    if (!item) return { ok: false, reason: "Selected item does not belong to the selected job." };
    return { ok: true, item };
  }
  if (itemId) {
    const item = job.items.find((candidate) => candidate.id === itemId);
    if (!item) return { ok: false, reason: "Selected item does not belong to the selected job." };
    return { ok: true, item };
  }
  return { ok: true, item: job.items[0] || null };
}
