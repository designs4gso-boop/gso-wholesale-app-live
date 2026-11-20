// 2026-11-19 — the INTERNAL approval queue.
//
//   proposal (agent or staff) -> AWAITING_APPROVAL -> a person approves or rejects
//     -> approved: EXECUTING -> COMPLETED / FAILED   (internal record only)
//
// Built on the existing action-intent engine (ops/action-intents.ts) and its
// durable tables (OpsActionIntent + append-only OpsActionAuditEvent). This file
// adds the tenant boundary and the staff decision.
//
// EXTERNAL EXECUTION IS OFF, by construction: no code path here sends an email,
// text, DM, form or post, creates an order, or charges anyone. Approving a
// draft message records that a person may send it BY HAND. The only things an
// approval changes are inside the ERP: a lead's assignee or follow-up date.

import { decideIntent, executeIntent, proposeIntent, validateIntent, type ActionIntent, type Actor } from "./ops/action-intents";
import { INTERNAL_APPROVAL_ACTIONS, type ActionType } from "./ops/autonomy";
import type { ActionIntentRepository } from "./ops/repositories";
import { assignLead, setLeadFollowUp } from "./crm.server";
import { agentMayPropose } from "./ops/agent-registry";

export const APPROVAL_ACTION_INFO: Record<string, { label: string; agentId: string; onApprove: string }> = {
  submit_outreach_draft: { label: "Draft message to a customer", agentId: "customer_followup", onApprove: "Approved for a person to send by hand. The ERP sends nothing." },
  propose_followup: { label: "Proposed follow-up", agentId: "customer_followup", onApprove: "The follow-up date is set on the lead." },
  propose_quote: { label: "Proposed quote", agentId: "quote_prep", onApprove: "Approved for a person to build in Quotes. No quote is sent." },
  propose_reorder: { label: "Reorder recommendation", agentId: "reorder_agent", onApprove: "Approved for a person to start with Reorder a Past Item. Nothing is ordered." },
  suggest_lead_assignment: { label: "Lead assignment suggestion", agentId: "lead_manager", onApprove: "The lead is assigned." },
};

export const APPROVAL_PAYLOAD_MAX_BYTES = 8 * 1024;
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

export function isApprovalAction(value: unknown): value is ActionType {
  return (INTERNAL_APPROVAL_ACTIONS as string[]).includes(String(value ?? ""));
}

export type SubmitApprovalInput = {
  shop: string;
  actionType: unknown;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
  reason: string;
  /** Unique per proposal. The same key always resolves to the same intent — never a second one. */
  idempotencyKey: string;
  proposedBy: Actor;
  agentId?: string;
};

export type ApprovalResult = { ok: true; intent: ActionIntent; duplicate: boolean; message: string } | { ok: false; message: string };

/** Create a proposal and put it in front of a person. Idempotent on shop + idempotencyKey. */
export async function submitApproval(repo: ActionIntentRepository, input: SubmitApprovalInput): Promise<ApprovalResult> {
  const shop = text(input.shop, 200);
  if (!shop) return { ok: false, message: "A proposal needs a shop." };
  if (!isApprovalAction(input.actionType)) return { ok: false, message: "This kind of proposal is not available." };
  const key = text(input.idempotencyKey, 160);
  if (!key) return { ok: false, message: "A proposal needs an idempotency key." };
  const reason = text(input.reason, 500);
  if (!reason) return { ok: false, message: "Say why this is proposed." };
  const payload = input.payload || {};
  if (JSON.stringify(payload).length > APPROVAL_PAYLOAD_MAX_BYTES) return { ok: false, message: "The proposal is too long." };
  const info = APPROVAL_ACTION_INFO[input.actionType];
  // 2026-11-20: the registry decides which agent may propose what (staff proposals use the default agent of the action)
  if (input.agentId && !agentMayPropose(input.agentId, input.actionType)) return { ok: false, message: "This agent may not propose that action." };
  const proposed = await proposeIntent(repo, {
    shop,
    actionType: input.actionType,
    agentId: input.agentId || info.agentId,
    entityType: text(input.entityType, 60) || "none",
    entityId: text(input.entityId, 120) || "none",
    payload,
    reason,
    idempotencyKey: `${shop}:${key}`,
    actor: input.proposedBy,
  });
  if (!proposed.ok) return { ok: false, message: proposed.reason };
  // The key is global in the engine; refuse an intent that belongs to another shop.
  if ((proposed.intent.shop ?? null) !== shop) return { ok: false, message: "This proposal could not be recorded." };
  if (proposed.duplicate) return { ok: true, intent: proposed.intent, duplicate: true, message: "This was already proposed." };
  const validated = await validateIntent(repo, proposed.intent.id);
  if (!validated.ok) return { ok: false, message: validated.reason };
  if (validated.intent.status !== "AWAITING_APPROVAL") return { ok: false, message: "This proposal did not reach the approval queue." };
  return { ok: true, intent: validated.intent, duplicate: false, message: "Sent for approval." };
}

/** Proposals of this shop only. */
export async function listApprovals(repo: ActionIntentRepository, shop: string, limit = 200): Promise<ActionIntent[]> {
  const rows = await repo.list({ shop, limit });
  return rows.filter((intent) => intent.shop === shop && isApprovalAction(intent.actionType)).reverse();
}

export type ApproverInput = { userId: string | null; actor: string; role: string };

/**
 * A person approves or rejects. Agents and system actors can never decide (the
 * engine refuses them). Deciding twice changes nothing. An intent of another
 * shop is reported as not found.
 */
export async function decideApproval(
  repo: ActionIntentRepository,
  dbClient: any,
  input: { shop: string; id: string; decision: "approve" | "reject"; approver: ApproverInput; comment?: string },
): Promise<{ ok: boolean; message: string; status?: string }> {
  const intent = await repo.getById(text(input.id, 80));
  if (!intent || intent.shop !== input.shop || !isApprovalAction(intent.actionType)) return { ok: false, message: "The proposal was not found." };
  if (!input.approver.userId) return { ok: false, message: "A verified staff sign-in is required to approve or reject." };
  const role = input.approver.role === "owner" ? "owner" : input.approver.role === "manager" ? "staff" : "unknown";
  if (role === "unknown") return { ok: false, message: "Proposals are approved by the owner or a manager." };
  const comment = text(input.comment, 500) || undefined;
  if (input.decision === "reject" && !comment) return { ok: false, message: "Say why it is rejected." };
  const human = { type: (role === "owner" ? "owner" : "staff") as Actor["type"], id: input.approver.userId, name: input.approver.actor, source: "erp:agent-approvals", role } as Actor & { role: "owner" | "staff" };
  if (input.decision === "reject") {
    if (intent.status !== "AWAITING_APPROVAL" && intent.status !== "CANCELLED") return { ok: false, message: `This proposal is already ${intent.status.toLowerCase()}.` };
    const rejected = await decideIntent(repo, intent.id, "REJECT", human, comment);
    return rejected.ok ? { ok: true, message: "Rejected. Nothing was changed or sent.", status: rejected.intent.status } : { ok: false, message: rejected.reason };
  }
  if (intent.status !== "AWAITING_APPROVAL" && intent.status !== "APPROVED" && intent.status !== "COMPLETED") return { ok: false, message: `This proposal is already ${intent.status.toLowerCase()}.` };
  // a second click / a retried request: already approved and recorded — nothing is applied twice
  if (intent.status === "COMPLETED") return { ok: true, message: APPROVAL_ACTION_INFO[intent.actionType]?.onApprove || "Approved.", status: "COMPLETED" };
  const approved = await decideIntent(repo, intent.id, "APPROVE", human, comment);
  if (!approved.ok) return { ok: false, message: approved.reason };
  // Record the outcome. The executor only ever touches ERP records of this shop.
  const run = await executeIntent(repo, intent.id, async (current) => applyApprovedProposal(dbClient, input.shop, current, input.approver.actor), { actor: human });
  // a simultaneous second approval lost the claim: the first one is applying it — same answer, applied once
  if (!run.ok && (run.intent?.status === "EXECUTING" || run.intent?.status === "COMPLETED")) return { ok: true, message: APPROVAL_ACTION_INFO[intent.actionType]?.onApprove || "Approved.", status: run.intent.status };
  if (!run.ok) return { ok: false, message: `Approved, but it could not be applied: ${run.reason}`, status: run.intent?.status };
  return { ok: true, message: APPROVAL_ACTION_INFO[intent.actionType]?.onApprove || "Approved.", status: run.intent.status };
}

/** What an approval does INSIDE the ERP. Never anything outside it. */
async function applyApprovedProposal(dbClient: any, shop: string, intent: ActionIntent, actor: string): Promise<{ externalReference?: string | null }> {
  const payload = intent.payload || {};
  if (intent.actionType === "suggest_lead_assignment") {
    if (intent.entityType !== "crm_lead") throw new Error("An assignment suggestion must name a lead.");
    const result = await assignLead(dbClient, { shop, id: intent.entityId, actor, staffName: payload.staffName, staffId: payload.staffId });
    if (!result.ok) throw new Error(result.message);
    return { externalReference: `crm_lead:${intent.entityId}` };
  }
  if (intent.actionType === "propose_followup") {
    if (intent.entityType !== "crm_lead") throw new Error("A follow-up proposal must name a lead.");
    const result = await setLeadFollowUp(dbClient, { shop, id: intent.entityId, actor, date: payload.followUpDate });
    if (!result.ok) throw new Error(result.message);
    return { externalReference: `crm_lead:${intent.entityId}` };
  }
  // drafts, quote and reorder proposals: the approval is the whole outcome — a person acts on it by hand
  return { externalReference: null };
}

export function approvalView(intent: ActionIntent) {
  const info = APPROVAL_ACTION_INFO[intent.actionType];
  const payload = (intent.payload || {}) as Record<string, unknown>;
  return {
    id: intent.id,
    kind: info?.label || intent.actionType,
    actionType: intent.actionType,
    status: intent.status,
    reason: intent.reason,
    entityType: intent.entityType,
    entityId: intent.entityId,
    proposedBy: intent.createdBy?.name || `${intent.createdBy?.type}:${intent.createdBy?.id}`,
    proposedByType: intent.createdBy?.type || "agent",
    createdAt: intent.createdAt,
    approvedBy: intent.approvedBy?.name || intent.approvedBy?.id || null,
    approvedAt: intent.approvedAt,
    error: intent.error,
    onApprove: info?.onApprove || "",
    // only plain text fields are shown; nothing in a payload is ever executed
    fields: Object.entries(payload).slice(0, 12).map(([name, value]) => ({ name, value: text(typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value), 2000) })),
  };
}
