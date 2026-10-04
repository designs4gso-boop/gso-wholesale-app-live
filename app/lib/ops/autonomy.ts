// GSO Operations Agent Platform — autonomy levels, action types and the
// agent x action permission matrix. Client-safe: pure data + pure functions.
//
// OWNER RULES ENCODED HERE (2026-10-03, owner away):
//   * Nothing that touches money, customers, real art approval, external
//     purchase orders, invoices or production job movement runs on its own.
//   * Consequential actions default to DENIED or APPROVAL_REQUIRED.
//   * Refund / void and anything financial are OWNER_REQUIRED.
//   * QuickBooks is DEFERRED — not connected, no credential required.

export const OPS_PLATFORM_VERSION = "ops-platform/1.0.0-2026-10-03";

export type AutonomyLevel =
  | "AUTO_READ"          // may read and report; never writes
  | "AUTO_INTERNAL"      // may create INTERNAL drafts / intents; nothing leaves GSO
  | "APPROVAL_REQUIRED"  // a named staff approver must approve the intent first
  | "OWNER_REQUIRED"     // only the owner may approve
  | "DISABLED";          // not available in this release, even with approval

export const AUTONOMY_LEVELS: AutonomyLevel[] = ["AUTO_READ", "AUTO_INTERNAL", "APPROVAL_REQUIRED", "OWNER_REQUIRED", "DISABLED"];

/** Every consequential action an agent can PROPOSE. Execution is separate. */
export type ActionType =
  | "read_production_status"
  | "read_report"
  | "draft_customer_reply"
  | "draft_followup"
  | "draft_marketing_brief"
  | "create_review_queue_item"
  | "classify_lead"
  | "prepare_quote_prep_draft"
  | "request_missing_info"
  | "run_art_preflight"
  | "mark_technical_preflight_passed"
  | "request_art_approval"
  | "record_final_art_approval"
  | "prepare_purchase_order"
  | "send_purchase_order"
  | "prepare_invoice"
  | "send_invoice"
  | "move_production_job"
  | "dispatch_to_machine"
  | "record_qc_result"
  | "mark_shipped"
  | "send_customer_notification"
  | "refund_or_void"
  | "change_cost_or_price"
  | "override_canonical_blocker"
  | "post_slack_internal"
  | "post_slack_external";

export const ACTION_TYPES: ActionType[] = [
  "read_production_status", "read_report", "draft_customer_reply", "draft_followup", "draft_marketing_brief",
  "create_review_queue_item", "classify_lead", "prepare_quote_prep_draft", "request_missing_info",
  "run_art_preflight", "mark_technical_preflight_passed", "request_art_approval", "record_final_art_approval",
  "prepare_purchase_order", "send_purchase_order", "prepare_invoice", "send_invoice",
  "move_production_job", "dispatch_to_machine", "record_qc_result", "mark_shipped", "send_customer_notification",
  "refund_or_void", "change_cost_or_price", "override_canonical_blocker", "post_slack_internal", "post_slack_external",
];

/**
 * The PLATFORM ceiling for each action tonight. An agent can never be more
 * permissive than this, whatever its own definition says.
 */
export const ACTION_AUTONOMY_CEILING: Record<ActionType, AutonomyLevel> = {
  read_production_status: "AUTO_READ",
  read_report: "AUTO_READ",
  draft_customer_reply: "AUTO_INTERNAL",
  draft_followup: "AUTO_INTERNAL",
  draft_marketing_brief: "AUTO_INTERNAL",
  create_review_queue_item: "AUTO_INTERNAL",
  classify_lead: "AUTO_INTERNAL",
  prepare_quote_prep_draft: "AUTO_INTERNAL",
  request_missing_info: "AUTO_INTERNAL",
  run_art_preflight: "AUTO_INTERNAL",
  mark_technical_preflight_passed: "AUTO_INTERNAL",
  request_art_approval: "AUTO_INTERNAL",
  record_final_art_approval: "APPROVAL_REQUIRED", // a HUMAN approver; AI never fabricates it
  prepare_purchase_order: "AUTO_INTERNAL",
  send_purchase_order: "DISABLED",                // tonight: no external PO
  prepare_invoice: "AUTO_INTERNAL",
  send_invoice: "DISABLED",                       // tonight: QuickBooks deferred, no external invoice
  move_production_job: "DISABLED",                // tonight: support built, execution off
  dispatch_to_machine: "DISABLED",                // tonight: plan only
  record_qc_result: "APPROVAL_REQUIRED",          // a person/device records inspection
  mark_shipped: "APPROVAL_REQUIRED",
  send_customer_notification: "DISABLED",         // tonight
  refund_or_void: "OWNER_REQUIRED",
  change_cost_or_price: "OWNER_REQUIRED",
  override_canonical_blocker: "DISABLED",         // never — a canonical blocker is not overridable
  post_slack_internal: "AUTO_INTERNAL",           // sandbox only tonight (see slack-config)
  post_slack_external: "DISABLED",
};

/** Permission matrix values (agent x action). */
export type Permission = "READ" | "AUTO" | "APPROVAL" | "OWNER" | "DENIED";

export const AUTONOMY_TO_PERMISSION: Record<AutonomyLevel, Permission> = {
  AUTO_READ: "READ",
  AUTO_INTERNAL: "AUTO",
  APPROVAL_REQUIRED: "APPROVAL",
  OWNER_REQUIRED: "OWNER",
  DISABLED: "DENIED",
};

const RANK: Record<AutonomyLevel, number> = { AUTO_READ: 0, AUTO_INTERNAL: 1, APPROVAL_REQUIRED: 2, OWNER_REQUIRED: 3, DISABLED: 4 };

/** The more restrictive of two levels wins. */
export function mostRestrictive(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Effective level = agent's own level capped by the platform ceiling. */
export function effectiveAutonomy(agentLevel: AutonomyLevel | undefined, action: ActionType): AutonomyLevel {
  const ceiling = ACTION_AUTONOMY_CEILING[action];
  if (!agentLevel) return "DISABLED";
  return mostRestrictive(agentLevel, ceiling);
}

export function isDisabled(level: AutonomyLevel): boolean {
  return level === "DISABLED";
}

export function requiresHumanApproval(level: AutonomyLevel): boolean {
  return level === "APPROVAL_REQUIRED" || level === "OWNER_REQUIRED";
}

/** Approver roles the ERP recognises for Slack / staff approvals. */
export type ApproverRole = "owner" | "staff" | "unknown";

export function approverSatisfies(level: AutonomyLevel, role: ApproverRole): boolean {
  if (level === "DISABLED") return false;
  if (level === "OWNER_REQUIRED") return role === "owner";
  if (level === "APPROVAL_REQUIRED") return role === "owner" || role === "staff";
  return true; // AUTO_* need no approval
}
