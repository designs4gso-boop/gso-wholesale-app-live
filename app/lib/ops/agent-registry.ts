// GSO Operations Agent Platform — THE versioned agent registry.
//
// One architecture, one registry. Every agent declares what it does, what it
// may touch, what it is forbidden, its autonomy per action, its approval
// policy, handoffs, prompt/model version, fallback and escalation.
//
// STATUS HONESTY. An agent is ACTIVE only when every integration it needs
// exists in this repo and is verified. Tonight (2026-10-03):
//   * No LLM provider is wired into the repo (no OpenAI/Anthropic client, no
//     API key). Agents whose reasoning step needs a model are DRAFT with a
//     deterministic fallback, or MANUAL_ONLY.
//   * Slack is verified against the real workspace in the sandbox channel
//     only (see slack-config.ts). Slack-dependent agents are therefore
//     ACTIVE for sandbox posting, with production channels BLOCKED.
//   * QuickBooks is DEFERRED — not connected.
//
// The historical "Cannabis Packaging Lead", "Commercial Print Lead", "Sales
// Intake" and "Lead Manager" agents existed ONLY as external ChatGPT custom
// agents/prompt text (never version-controlled). Their behaviour is
// re-specified here as repo-owned contracts so it can be recreated
// consistently; the external agents remain EXTERNAL ONLY.

import { ACTION_TYPES, type ActionType, type AutonomyLevel, type Permission, AUTONOMY_TO_PERMISSION, effectiveAutonomy } from "./autonomy";

export const AGENT_REGISTRY_VERSION = "agent-registry/1.0.0-2026-10-03";

export type AgentStatus = "ACTIVE" | "DRAFT" | "BLOCKED" | "MANUAL_ONLY";

export type AgentId =
  | "operations_supervisor"
  | "lead_manager"
  | "cannabis_packaging_sales"
  | "commercial_print_sales"
  | "sales_intake"
  | "quote_prep"
  | "customer_followup"
  | "art_preflight"
  | "art_approval_coordinator"
  | "purchasing_agent"
  | "production_planner"
  | "production_dispatcher"
  | "qa_agent"
  | "shipping_agent"
  | "sales_reporting"
  | "production_reporting"
  | "production_status"
  | "reorder_agent"
  | "marketing_agent"
  | "exception_manager"
  | "invoice_coordinator";

export type AgentDefinition = {
  id: AgentId;
  name: string;
  purpose: string;
  status: AgentStatus;
  statusReason: string;
  inputs: string[];
  outputs: string[];
  /** Deterministic repo tools the agent may call (module names). */
  tools: string[];
  forbidden: string[];
  /** The agent's OWN autonomy per action it may propose; capped by the platform ceiling. */
  autonomy: Partial<Record<ActionType, AutonomyLevel>>;
  approvalPolicy: string;
  handoffTargets: AgentId[];
  /** Prompt + model version. "deterministic" means no model is involved. */
  promptVersion: string;
  modelVersion: string;
  fallback: string;
  escalation: string;
};

const NO_MODEL = "deterministic (no LLM wired in this repo)";
const LLM_DRAFT = "unset — provider not configured; deterministic fallback in force";

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    id: "operations_supervisor",
    name: "Operations Supervisor",
    purpose: "Routes work between agents, enforces the permission matrix, owns the action-intent lifecycle and the Slack approval loop.",
    status: "ACTIVE",
    statusReason: "Deterministic; needs no model. Slack approvals are sandbox-only tonight.",
    inputs: ["action intents", "agent outputs", "Slack interactions (sandbox)", "staff identity mapping"],
    outputs: ["validated intents", "approval requests", "exception routing", "audit records"],
    tools: ["ops/action-intents", "ops/autonomy", "slack/slack-interactions", "ops/exceptions"],
    forbidden: ["executing DISABLED actions", "approving on a human's behalf", "overriding canonical blockers"],
    autonomy: { post_slack_internal: "AUTO_INTERNAL", read_report: "AUTO_READ" },
    approvalPolicy: "Never approves. Collects approvals from mapped staff/owner only.",
    handoffTargets: ["exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Hold the intent in AWAITING_APPROVAL.",
    escalation: "exception_manager -> owner via agent_approvals destination",
  },
  {
    id: "lead_manager",
    name: "Lead Manager",
    purpose: "Validates, de-duplicates, classifies and routes inbound leads to the right sales agent and the Agent Review Queue.",
    status: "ACTIVE",
    statusReason: "Deterministic classification/dedupe on the existing intake contract.",
    inputs: ["lead payload (api/agent/intake shape)", "existing queue items for dedupe"],
    outputs: ["classified lead", "duplicate verdict", "routing decision", "review queue item intent"],
    tools: ["ops/sales-intake", "product-family-registry", "agent-intake-rules"],
    forbidden: ["pricing", "customer messaging", "editing ERP data"],
    autonomy: { classify_lead: "AUTO_INTERNAL", create_review_queue_item: "AUTO_INTERNAL", request_missing_info: "AUTO_INTERNAL" },
    approvalPolicy: "Queue items always require staff review (AGENT_REVIEW_QUEUE_GUARDRAILS).",
    handoffTargets: ["cannabis_packaging_sales", "commercial_print_sales", "sales_intake", "quote_prep"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Route to sales_intake with NEEDS_INFO.",
    escalation: "exception_manager",
  },
  {
    id: "cannabis_packaging_sales",
    name: "Cannabis Packaging Sales",
    purpose: "Specialist intake for jars, sticker bags, stock bags and labels sold into cannabis packaging; collects compliance-relevant specs; drafts customer-safe replies for staff review.",
    status: "DRAFT",
    statusReason: "Conversation reasoning needs a model; the deterministic intake-question and readiness logic is active. Historically an external ChatGPT custom agent (not version-controlled).",
    inputs: ["lead", "intake answers", "product family rules"],
    outputs: ["intake questions", "customer-safe draft reply", "quote-prep handoff"],
    tools: ["ops/sales-intake", "agent-intake-rules", "product-family-sales-rules"],
    forbidden: ["firm pricing", "turnaround promises", "discounts", "compliance/legal advice"],
    autonomy: { draft_customer_reply: "AUTO_INTERNAL", request_missing_info: "AUTO_INTERNAL", prepare_quote_prep_draft: "AUTO_INTERNAL" },
    approvalPolicy: "Every customer-facing draft is staff-reviewed before sending.",
    handoffTargets: ["quote_prep", "art_preflight"],
    promptVersion: "cannabis-packaging-sales/contract-1.0 (docs/GSO_AGENT_SYSTEM_CONTRACT.md)",
    modelVersion: LLM_DRAFT,
    fallback: "Deterministic intake questions from PRODUCT_FAMILY_INTAKE_QUESTIONS.",
    escalation: "lead_manager -> staff",
  },
  {
    id: "commercial_print_sales",
    name: "Commercial Print Sales",
    purpose: "Specialist intake for labels, stickers, banners and general commercial print; collects specs; drafts replies for staff review.",
    status: "DRAFT",
    statusReason: "Same as cannabis_packaging_sales — reasoning step needs a model; deterministic path active.",
    inputs: ["lead", "intake answers", "product family rules"],
    outputs: ["intake questions", "customer-safe draft reply", "quote-prep handoff"],
    tools: ["ops/sales-intake", "agent-intake-rules"],
    forbidden: ["firm pricing", "turnaround promises", "discounts"],
    autonomy: { draft_customer_reply: "AUTO_INTERNAL", request_missing_info: "AUTO_INTERNAL", prepare_quote_prep_draft: "AUTO_INTERNAL" },
    approvalPolicy: "Every customer-facing draft is staff-reviewed before sending.",
    handoffTargets: ["quote_prep", "art_preflight"],
    promptVersion: "commercial-print-sales/contract-1.0",
    modelVersion: LLM_DRAFT,
    fallback: "Deterministic intake questions.",
    escalation: "lead_manager -> staff",
  },
  {
    id: "sales_intake",
    name: "Sales Intake",
    purpose: "Generic intake when the family is unknown or mixed; collects the standard fields; hands off once classified.",
    status: "ACTIVE",
    statusReason: "Deterministic field collection on AGENT_STANDARD_INTAKE_FIELDS.",
    inputs: ["lead"],
    outputs: ["missing-field list", "classification suggestion"],
    tools: ["ops/sales-intake", "agent-intake-rules"],
    forbidden: ["pricing", "sending"],
    autonomy: { request_missing_info: "AUTO_INTERNAL", classify_lead: "AUTO_INTERNAL" },
    approvalPolicy: "n/a (internal drafts only)",
    handoffTargets: ["lead_manager", "quote_prep"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "NEEDS_INFO",
    escalation: "lead_manager",
  },
  {
    id: "quote_prep",
    name: "Quote Prep",
    purpose: "Decides quote readiness per family. Canonical families route to the Cost Calculator (canonical authority); DTP/Boxes route to outsourced review. Never prices.",
    status: "ACTIVE",
    statusReason: "Deterministic on familyCostModel + intake completeness.",
    inputs: ["classified lead", "intake fields"],
    outputs: ["READY_FOR_STAFF_QUOTE | NEEDS_INFO | CANONICAL_BLOCKED | OUTSOURCED_REVIEW | UNSUPPORTED", "staff handoff note"],
    tools: ["ops/quote-prep", "canonical-quote-authority", "agent-quote-prep-rules"],
    forbidden: ["setting any price", "legacy manufacturing cost", "creating Quote records"],
    autonomy: { prepare_quote_prep_draft: "AUTO_INTERNAL" },
    approvalPolicy: "Staff build the quote in the Cost Calculator; the agent only prepares.",
    handoffTargets: ["art_preflight", "customer_followup"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "NEEDS_INFO",
    escalation: "exception_manager (CANONICAL_BLOCKED)",
  },
  {
    id: "customer_followup",
    name: "Customer Follow-Up",
    purpose: "Drafts follow-ups for stale leads/quotes for staff to send. Never sends.",
    status: "ACTIVE",
    statusReason: "Deterministic templates; sending is DISABLED tonight.",
    inputs: ["lead/quote age", "last contact", "status"],
    outputs: ["follow-up draft"],
    tools: ["ops/followup"],
    forbidden: ["sending", "discounts", "promises"],
    autonomy: { draft_followup: "AUTO_INTERNAL", send_customer_notification: "DISABLED" },
    approvalPolicy: "Staff send manually.",
    handoffTargets: ["lead_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "No draft (insufficient data).",
    escalation: "exception_manager",
  },
  {
    id: "art_preflight",
    name: "Art Preflight",
    purpose: "Technical artwork checks against GSO rules (format, artboard, cutline, contour geometry, white/gloss, design count, sides). Marks TECHNICAL_PREFLIGHT_PASSED only.",
    status: "ACTIVE",
    statusReason: "Deterministic on supplied file facts; file-content parsing (PDF geometry) is NOT implemented — those checks report NEEDS_DESIGNER.",
    inputs: ["art file facts", "job spec (family, dims, sides, designs, white/gloss)"],
    outputs: ["PASS | WARN | FAIL | NEEDS_DESIGNER", "findings"],
    tools: ["ops/art-preflight", "gso-cutline", "machine-routing", "print-intake-routing"],
    forbidden: ["CUSTOMER_APPROVED", "FINAL_ART_APPROVED", "inventing art requirements"],
    autonomy: { run_art_preflight: "AUTO_INTERNAL", mark_technical_preflight_passed: "AUTO_INTERNAL" },
    approvalPolicy: "n/a (technical only)",
    handoffTargets: ["art_approval_coordinator"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "NEEDS_DESIGNER",
    escalation: "exception_manager (art failure)",
  },
  {
    id: "art_approval_coordinator",
    name: "Art Approval Coordinator",
    purpose: "Runs the approval loop: version/hash binding, Slack approval intent, invalidation on new versions. Records approvals only from authorized humans.",
    status: "ACTIVE",
    statusReason: "Deterministic; Slack approval buttons verified in sandbox only.",
    inputs: ["preflight result", "art version + hash", "approver identity"],
    outputs: ["approval intent", "immutable approved version record", "production readiness flag"],
    tools: ["ops/art-approval", "slack/slack-blocks", "ops/action-intents"],
    forbidden: ["fabricating approvals", "approving on anyone's behalf"],
    autonomy: { request_art_approval: "AUTO_INTERNAL", record_final_art_approval: "APPROVAL_REQUIRED" },
    approvalPolicy: "Customer/final approval must come from a mapped staff member recording the customer's decision, or the customer proof portal.",
    handoffTargets: ["production_planner"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Hold at AWAITING_APPROVAL.",
    escalation: "exception_manager",
  },
  {
    id: "purchasing_agent",
    name: "Purchasing Agent",
    purpose: "Prepares purchase-order intents from known vendor/material data. Never invents prices or freight. External PO creation DISABLED tonight.",
    status: "ACTIVE",
    statusReason: "Preparation path deterministic; send path DISABLED.",
    inputs: ["material need", "vendor product rows", "vendor rows"],
    outputs: ["PO_READY_FOR_APPROVAL | PURCHASING_INFO_REQUIRED | VENDOR_COST_REQUIRED"],
    tools: ["ops/purchasing"],
    forbidden: ["inventing vendor cost/freight", "sending POs"],
    autonomy: { prepare_purchase_order: "AUTO_INTERNAL", send_purchase_order: "DISABLED" },
    approvalPolicy: "Owner/staff approve a prepared PO; sending is a later phase.",
    handoffTargets: ["exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "PURCHASING_INFO_REQUIRED",
    escalation: "exception_manager (vendor cost missing)",
  },
  {
    id: "production_planner",
    name: "Production Planner",
    purpose: "Orders the queue: ready vs blocked, due date, priority, machine, material, art approval, holds, outsourced work. Read-only tonight.",
    status: "ACTIVE",
    statusReason: "Deterministic planner over real ProductionJob statuses; writes DISABLED.",
    inputs: ["production jobs", "art approvals", "material readiness", "holds"],
    outputs: ["ordered queue", "blockers", "next action per job"],
    tools: ["ops/production-planner", "ops/production-transitions"],
    forbidden: ["moving jobs", "writing jobs"],
    autonomy: { read_production_status: "AUTO_READ", move_production_job: "DISABLED" },
    approvalPolicy: "n/a tonight",
    handoffTargets: ["production_dispatcher", "exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Report blockers.",
    escalation: "exception_manager",
  },
  {
    id: "production_dispatcher",
    name: "Production Dispatcher",
    purpose: "Plans machine dispatch with the canonical routing authority (CMYK->Mimaki, white/gloss->Roland, explicit Mimaki+specialty BLOCK). Integrates with the existing print-intake agent; does not duplicate it.",
    status: "ACTIVE",
    statusReason: "Plan-only; the PowerShell print-intake agent remains the executor.",
    inputs: ["job item specs", "routing"],
    outputs: ["dispatch plan", "BLOCK reasons"],
    tools: ["ops/production-dispatch", "machine-routing", "print-intake-routing"],
    forbidden: ["copying files", "writing RIP hot folders"],
    autonomy: { dispatch_to_machine: "DISABLED", read_production_status: "AUTO_READ" },
    approvalPolicy: "n/a tonight",
    handoffTargets: ["exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "BLOCK",
    escalation: "exception_manager (machine mismatch)",
  },
  {
    id: "qa_agent",
    name: "QA / QC Agent",
    purpose: "Builds family-aware QC checklists and validates supplied facts. Never claims a physical inspection happened.",
    status: "ACTIVE",
    statusReason: "Deterministic checklist from FAMILY_CHECKLISTS; recording a result needs a person/device.",
    inputs: ["job", "spec", "recorded QC facts"],
    outputs: ["QC_REQUIRED | QC_PASS_RECORDED | QC_FAIL_RECORDED", "checklist"],
    tools: ["ops/qa-checklist", "production-job-source FAMILY_CHECKLISTS"],
    forbidden: ["asserting inspection without a recorded actor"],
    autonomy: { record_qc_result: "APPROVAL_REQUIRED" },
    approvalPolicy: "A named person or device records pass/fail.",
    handoffTargets: ["shipping_agent", "exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "QC_REQUIRED",
    escalation: "exception_manager",
  },
  {
    id: "shipping_agent",
    name: "Shipping / Completion Agent",
    purpose: "Shipping readiness after QC, tracking capture, customer-update draft. No labels bought, no notifications sent tonight.",
    status: "ACTIVE",
    statusReason: "Deterministic readiness; external actions DISABLED.",
    inputs: ["job", "QC status", "packing facts", "tracking"],
    outputs: ["readiness", "customer-update draft"],
    tools: ["ops/shipping"],
    forbidden: ["buying labels", "sending notifications"],
    autonomy: { mark_shipped: "APPROVAL_REQUIRED", send_customer_notification: "DISABLED" },
    approvalPolicy: "Staff mark shipped with tracking.",
    handoffTargets: ["invoice_coordinator"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Not ready.",
    escalation: "exception_manager",
  },
  {
    id: "sales_reporting",
    name: "Sales Reporting",
    purpose: "Daily/weekly sales activity, quote pipeline, sales by family/customer from ERP-owned data. Never calls ERP totals cash collected.",
    status: "ACTIVE",
    statusReason: "Deterministic aggregation over ERP rows.",
    inputs: ["quotes", "queue items"],
    outputs: ["report blocks"],
    tools: ["ops/reporting"],
    forbidden: ["financial statements (QuickBooks DEFERRED)", "cash-collected claims"],
    autonomy: { read_report: "AUTO_READ", post_slack_internal: "AUTO_INTERNAL" },
    approvalPolicy: "n/a",
    handoffTargets: [],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Empty report with data-gap note.",
    escalation: "exception_manager",
  },
  {
    id: "production_reporting",
    name: "Production Reporting",
    purpose: "Jobs awaiting art, ready, in production, blocked, completed, overdue; purchasing needs; agent exceptions.",
    status: "ACTIVE",
    statusReason: "Deterministic aggregation.",
    inputs: ["production jobs", "purchase requests", "exceptions"],
    outputs: ["report blocks"],
    tools: ["ops/reporting", "ops/production-planner"],
    forbidden: ["fabricating job states"],
    autonomy: { read_report: "AUTO_READ", post_slack_internal: "AUTO_INTERNAL" },
    approvalPolicy: "n/a",
    handoffTargets: [],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Empty report with data-gap note.",
    escalation: "exception_manager",
  },
  {
    id: "production_status",
    name: "Production Status",
    purpose: "Read-only answers: where is the job, what stage, what blocks it, next action, machine/vendor, art, purchasing, shipping.",
    status: "ACTIVE",
    statusReason: "Deterministic over a job record.",
    inputs: ["job + items + files + events"],
    outputs: ["status answer"],
    tools: ["ops/production-status", "ops/production-transitions"],
    forbidden: ["guessing", "writing"],
    autonomy: { read_production_status: "AUTO_READ" },
    approvalPolicy: "n/a",
    handoffTargets: [],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "UNKNOWN with the missing data named.",
    escalation: "n/a",
  },
  {
    id: "reorder_agent",
    name: "Reorder Agent",
    purpose: "Identifies reorder opportunities from completed jobs, revalidates product/quote readiness, drafts outreach. Never sends.",
    status: "ACTIVE",
    statusReason: "Deterministic; sending DISABLED.",
    inputs: ["completed jobs", "customer history"],
    outputs: ["opportunity list", "draft message"],
    tools: ["ops/reorder-marketing", "ops/quote-prep"],
    forbidden: ["sending", "discounts"],
    autonomy: { draft_followup: "AUTO_INTERNAL", send_customer_notification: "DISABLED" },
    approvalPolicy: "Staff send.",
    handoffTargets: ["customer_followup"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "No opportunity.",
    escalation: "n/a",
  },
  {
    id: "marketing_agent",
    name: "Marketing Agent",
    purpose: "Campaign concepts, audience, copy, creative brief, CTA — drafts only. Never publishes, never invents discounts.",
    status: "DRAFT",
    statusReason: "Copy generation needs a model; deterministic brief scaffold is active.",
    inputs: ["family", "audience", "goal"],
    outputs: ["creative brief"],
    tools: ["ops/reorder-marketing"],
    forbidden: ["publishing", "sending", "discounts"],
    autonomy: { draft_marketing_brief: "AUTO_INTERNAL" },
    approvalPolicy: "Owner approves any campaign.",
    handoffTargets: [],
    promptVersion: "marketing/contract-1.0",
    modelVersion: LLM_DRAFT,
    fallback: "Scaffold brief without copy.",
    escalation: "n/a",
  },
  {
    id: "exception_manager",
    name: "Exception Manager",
    purpose: "Classifies exceptions (missing canonical data, art failure, machine mismatch, material shortage, vendor cost missing, approval missing, Slack failure, duplicate webhook, late production) and routes them. Never bypasses blockers.",
    status: "ACTIVE",
    statusReason: "Deterministic routing to logical Slack destinations (sandbox-only tonight).",
    inputs: ["exception events"],
    outputs: ["routed alerts", "intents"],
    tools: ["ops/exceptions", "slack/slack-blocks"],
    forbidden: ["overriding blockers", "silencing failures"],
    autonomy: { post_slack_internal: "AUTO_INTERNAL", override_canonical_blocker: "DISABLED" },
    approvalPolicy: "n/a",
    handoffTargets: ["operations_supervisor"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "Route to agent_approvals.",
    escalation: "owner",
  },
  {
    id: "invoice_coordinator",
    name: "Invoice Coordinator",
    purpose: "ERP-side invoice readiness: validates customer, quote/order, approved selling total, lines, shipping if known. QuickBooks DEFERRED; no external invoice.",
    status: "ACTIVE",
    statusReason: "Readiness deterministic; send DISABLED; accounting connector deferred.",
    inputs: ["quote", "job", "shipping facts"],
    outputs: ["INVOICE_READY_FOR_APPROVAL | ACCOUNTING_INFO_REQUIRED"],
    tools: ["ops/invoice-readiness"],
    forbidden: ["inventing tax/discount/terms/shipping/deposit", "creating invoices", "QuickBooks"],
    autonomy: { prepare_invoice: "AUTO_INTERNAL", send_invoice: "DISABLED", refund_or_void: "OWNER_REQUIRED" },
    approvalPolicy: "Owner approves invoices; accounting mapping is a later phase.",
    handoffTargets: ["exception_manager"],
    promptVersion: "n/a",
    modelVersion: NO_MODEL,
    fallback: "ACCOUNTING_INFO_REQUIRED",
    escalation: "owner",
  },
];

export const AGENT_IDS: AgentId[] = AGENT_REGISTRY.map((a) => a.id);

export function agentById(id: string): AgentDefinition | null {
  return AGENT_REGISTRY.find((a) => a.id === id) ?? null;
}

/** agent x action permission matrix (effective, ceiling-capped). */
export function permissionMatrix(): Record<AgentId, Record<ActionType, Permission>> {
  const matrix = {} as Record<AgentId, Record<ActionType, Permission>>;
  for (const agent of AGENT_REGISTRY) {
    const row = {} as Record<ActionType, Permission>;
    for (const action of ACTION_TYPES) {
      row[action] = AUTONOMY_TO_PERMISSION[effectiveAutonomy(agent.autonomy[action], action)];
    }
    matrix[agent.id] = row;
  }
  return matrix;
}

export function permissionFor(agentId: string, action: ActionType): Permission {
  const agent = agentById(agentId);
  if (!agent) return "DENIED";
  return AUTONOMY_TO_PERMISSION[effectiveAutonomy(agent.autonomy[action], action)];
}
