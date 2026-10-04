// GSO Operations Agent Platform — the UNIVERSAL ACTION INTENT ENGINE (OPS-2,
// async, repository-backed).
//
// Every consequential thing an agent (deterministic or model-driven) wants
// to do becomes an ActionIntent that moves through an explicit lifecycle.
// Approval is a HUMAN decision bound to an identity; execution is a separate
// step gated by the execution kill switch; the same idempotency key never
// produces two intents and the same intent never executes twice. Every
// transition is written to an append-only audit log through the repository
// boundary (repositories.ts) — the engine itself never touches Prisma.

import { effectiveAutonomy, approverSatisfies, type ActionType, type ApproverRole, type AutonomyLevel } from "./autonomy";
import { agentById } from "./agent-registry";
import type { ActionIntentRepository } from "./repositories";

export const ACTION_INTENT_ENGINE_VERSION = "action-intents/2.0.0-2026-10-04";

export type IntentStatus = "PROPOSED" | "VALIDATED" | "AWAITING_APPROVAL" | "APPROVED" | "EXECUTING" | "COMPLETED" | "FAILED" | "CANCELLED";

export const INTENT_STATUSES: IntentStatus[] = ["PROPOSED", "VALIDATED", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "COMPLETED", "FAILED", "CANCELLED"];

export const INTENT_TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  PROPOSED: ["VALIDATED", "CANCELLED", "FAILED"],
  VALIDATED: ["AWAITING_APPROVAL", "APPROVED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export type Actor = { type: "agent" | "staff" | "owner" | "system" | "customer" | "model"; id: string; name?: string; source?: string };

export type ActionIntent = {
  id: string;
  actionType: ActionType;
  agentId: string;
  agentVersion: string;
  /** Reasoning provider / model that produced the proposal, when any. */
  provider: string | null;
  model: string | null;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  reason: string;
  autonomyLevel: AutonomyLevel;
  approvalPolicy: string;
  idempotencyKey: string;
  status: IntentStatus;
  createdAt: string;
  createdBy: Actor;
  approvedBy: Actor | null;
  approvedAt: string | null;
  executedAt: string | null;
  externalReference: string | null;
  error: string | null;
  /** In-memory mirror of the audit trail (the repository holds the durable copy). */
  audit: AuditRecord[];
};

/** Compact per-intent audit line (kept on the intent for Slack threads/UI). */
export type AuditRecord = { at: string; actor: Actor; event: string; from: IntentStatus | null; to: IntentStatus | null; detail?: string; idempotencyKey?: string };

/** Durable, self-describing audit event (Phase 23) — one row per transition. */
export type AuditEvent = {
  id: string;
  intentId: string;
  idempotencyKey: string;
  agentId: string;
  agentVersion: string;
  provider: string | null;
  model: string | null;
  entityType: string;
  entityId: string;
  actionType: ActionType;
  reason: string;
  payloadKeys: string[];
  autonomyLevel: AutonomyLevel;
  previousStatus: IntentStatus | null;
  newStatus: IntentStatus | null;
  event: string;
  actor: Actor;
  approver: Actor | null;
  at: string;
  executionResult: "completed" | "failed" | null;
  externalReference: string | null;
  error: string | null;
  detail: string | null;
};

/** Deterministic id from the idempotency key — the same request yields the same id. */
export function intentIdFor(idempotencyKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < idempotencyKey.length; i += 1) {
    hash ^= idempotencyKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ai_${hash.toString(16).padStart(8, "0")}_${idempotencyKey.length}`;
}

let auditSeq = 0;
function auditEventFor(intent: ActionIntent, rec: AuditRecord, extra: Partial<AuditEvent> = {}): AuditEvent {
  auditSeq += 1;
  return {
    id: `${intent.id}:${intent.audit.length}:${auditSeq.toString(36)}`,
    intentId: intent.id,
    idempotencyKey: intent.idempotencyKey,
    agentId: intent.agentId,
    agentVersion: intent.agentVersion,
    provider: intent.provider,
    model: intent.model,
    entityType: intent.entityType,
    entityId: intent.entityId,
    actionType: intent.actionType,
    reason: intent.reason,
    payloadKeys: Object.keys(intent.payload ?? {}),
    autonomyLevel: intent.autonomyLevel,
    previousStatus: rec.from,
    newStatus: rec.to,
    event: rec.event,
    actor: rec.actor,
    approver: intent.approvedBy,
    at: rec.at,
    executionResult: null,
    externalReference: intent.externalReference,
    error: intent.error,
    detail: rec.detail ?? null,
    ...extra,
  };
}

async function record(repo: ActionIntentRepository, intent: ActionIntent, rec: AuditRecord, extra: Partial<AuditEvent> = {}) {
  intent.audit.push(rec);
  await repo.save(intent);
  await repo.appendAudit(auditEventFor(intent, rec, extra));
}

function setStatus(intent: ActionIntent, to: IntentStatus) { (intent as { status: IntentStatus }).status = to; }

function move(intent: ActionIntent, to: IntentStatus): { ok: true } | { ok: false; reason: string } {
  if (!INTENT_TRANSITIONS[intent.status].includes(to)) return { ok: false, reason: `Intent ${intent.id} cannot move ${intent.status} -> ${to}.` };
  return { ok: true };
}

export type ProposeInput = {
  actionType: ActionType;
  agentId: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
  actor?: Actor;
  provider?: string | null;
  model?: string | null;
  now?: Date;
};

export type ProposeResult = { ok: true; intent: ActionIntent; duplicate: boolean } | { ok: false; reason: string };

/** Propose. Same idempotency key -> the SAME intent is returned, nothing new is created. */
export async function proposeIntent(repo: ActionIntentRepository, input: ProposeInput): Promise<ProposeResult> {
  const key = String(input.idempotencyKey || "").trim();
  if (!key) return { ok: false, reason: "idempotencyKey is required for every consequential action." };
  const existing = await repo.getByIdempotencyKey(key);
  if (existing) return { ok: true, intent: existing, duplicate: true };
  const agent = agentById(input.agentId);
  if (!agent) return { ok: false, reason: `Unknown agent "${input.agentId}".` };
  const level = effectiveAutonomy(agent.autonomy[input.actionType], input.actionType);
  const now = (input.now ?? new Date()).toISOString();
  const actor: Actor = input.actor ?? { type: "agent", id: agent.id, name: agent.name };
  const intent: ActionIntent = {
    id: intentIdFor(key),
    actionType: input.actionType,
    agentId: agent.id,
    agentVersion: agent.promptVersion === "n/a" ? agent.modelVersion : `${agent.promptVersion} / ${agent.modelVersion}`,
    provider: input.provider ?? null,
    model: input.model ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload ?? {},
    reason: input.reason,
    autonomyLevel: level,
    approvalPolicy: agent.approvalPolicy,
    idempotencyKey: key,
    status: "PROPOSED",
    createdAt: now,
    createdBy: actor,
    approvedBy: null,
    approvedAt: null,
    executedAt: null,
    externalReference: null,
    error: null,
    audit: [],
  };
  await record(repo, intent, { at: now, actor, event: "proposed", from: null, to: "PROPOSED", idempotencyKey: key });
  return { ok: true, intent, duplicate: false };
}

const SYSTEM: Actor = { type: "system", id: "operations_supervisor" };

/** Validate: DISABLED fails immediately; AUTO_* -> APPROVED (internal); APPROVAL/OWNER -> AWAITING_APPROVAL. */
export async function validateIntent(repo: ActionIntentRepository, intentId: string, actor: Actor = SYSTEM, now = new Date()) {
  const intent = await repo.getById(intentId);
  if (!intent) return { ok: false as const, reason: "Intent not found." };
  if (intent.status !== "PROPOSED") return { ok: false as const, reason: `Intent is ${intent.status}, not PROPOSED.`, intent };
  const iso = now.toISOString();
  if (intent.autonomyLevel === "DISABLED") {
    intent.error = `Action "${intent.actionType}" is DISABLED in this release.`;
    const from: IntentStatus = intent.status; setStatus(intent, "FAILED");
    await record(repo, intent, { at: iso, actor, event: "disabled_action", from, to: "FAILED", detail: intent.error }, { executionResult: "failed" });
    return { ok: false as const, reason: intent.error, intent };
  }
  let from: IntentStatus = intent.status; setStatus(intent, "VALIDATED");
  await record(repo, intent, { at: iso, actor, event: "validated", from, to: "VALIDATED" });
  from = intent.status;
  if (intent.autonomyLevel === "AUTO_READ" || intent.autonomyLevel === "AUTO_INTERNAL") {
    setStatus(intent, "APPROVED");
    await record(repo, intent, { at: iso, actor, event: "auto_approved_internal", from, to: "APPROVED", detail: `autonomy ${intent.autonomyLevel}` });
  } else {
    setStatus(intent, "AWAITING_APPROVAL");
    await record(repo, intent, { at: iso, actor, event: "awaiting_approval", from, to: "AWAITING_APPROVAL", detail: intent.approvalPolicy });
  }
  return { ok: true as const, intent };
}

export type ApprovalDecision = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "HOLD" | "RELEASE";

/** Apply a human decision. Agents, models and system actors can never approve. Idempotent. */
export async function decideIntent(
  repo: ActionIntentRepository,
  intentId: string,
  decision: ApprovalDecision,
  approver: Actor & { role: ApproverRole },
  comment?: string,
  now = new Date(),
): Promise<{ ok: true; intent: ActionIntent; duplicate: boolean } | { ok: false; reason: string }> {
  const intent = await repo.getById(intentId);
  if (!intent) return { ok: false, reason: "Intent not found." };
  if (approver.type === "agent" || approver.type === "system" || approver.type === "model") {
    return { ok: false, reason: "Agents, models and system actors cannot approve, reject or release intents." };
  }
  const iso = now.toISOString();
  const human: Actor = { type: approver.type, id: approver.id, name: approver.name, source: approver.source };
  if (decision === "APPROVE" || decision === "RELEASE") {
    if (intent.status === "APPROVED") return { ok: true, intent, duplicate: true };
    if (!approverSatisfies(intent.autonomyLevel, approver.role)) {
      return { ok: false, reason: `"${intent.actionType}" needs ${intent.autonomyLevel}; approver role "${approver.role}" is not sufficient.` };
    }
    const m = move(intent, "APPROVED"); if (!m.ok) return m;
    const from: IntentStatus = intent.status; setStatus(intent, "APPROVED");
    intent.approvedBy = human; intent.approvedAt = iso;
    await record(repo, intent, { at: iso, actor: human, event: decision === "RELEASE" ? "released" : "approved", from, to: "APPROVED", detail: comment });
    return { ok: true, intent, duplicate: false };
  }
  if (decision === "REJECT") {
    if (intent.status === "CANCELLED") return { ok: true, intent, duplicate: true };
    const m = move(intent, "CANCELLED"); if (!m.ok) return m;
    const from: IntentStatus = intent.status; setStatus(intent, "CANCELLED");
    await record(repo, intent, { at: iso, actor: human, event: "rejected", from, to: "CANCELLED", detail: comment });
    return { ok: true, intent, duplicate: false };
  }
  if (decision === "REQUEST_CHANGES" && intent.status !== "AWAITING_APPROVAL" && intent.status !== "VALIDATED") {
    return { ok: false, reason: `Cannot request changes on a ${intent.status} intent.` };
  }
  await record(repo, intent, { at: iso, actor: human, event: decision === "HOLD" ? "held" : "changes_requested", from: intent.status, to: intent.status, detail: comment });
  return { ok: true, intent, duplicate: false };
}

export type ExecutionGate = { executionEnabled: boolean };

/** Actions that are consequential: blocked by the execution kill switch even when APPROVED. */
export const CONSEQUENTIAL_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "move_production_job", "dispatch_to_machine", "record_qc_result", "mark_shipped", "record_final_art_approval",
  "send_customer_notification", "send_purchase_order", "send_invoice", "refund_or_void", "change_cost_or_price",
  "override_canonical_blocker", "post_slack_external",
]);

export function isConsequential(actionType: ActionType): boolean {
  return CONSEQUENTIAL_ACTIONS.has(actionType);
}

/**
 * Execute through an injected deterministic executor. Requires APPROVED; a
 * COMPLETED intent is never executed again (duplicate=true). Consequential
 * actions additionally require the execution kill switch to be on.
 */
export async function executeIntent<T>(
  repo: ActionIntentRepository,
  intentId: string,
  executor: (intent: ActionIntent) => Promise<{ externalReference?: string | null; result?: T }>,
  options: { actor?: Actor; now?: Date; gate?: ExecutionGate } = {},
): Promise<{ ok: true; intent: ActionIntent; duplicate: boolean; result?: T } | { ok: false; reason: string; intent?: ActionIntent; blockedByKillSwitch?: boolean }> {
  const actor = options.actor ?? SYSTEM;
  const now = options.now ?? new Date();
  const intent = await repo.getById(intentId);
  if (!intent) return { ok: false, reason: "Intent not found." };
  if (intent.status === "COMPLETED") return { ok: true, intent, duplicate: true };
  if (intent.status !== "APPROVED") return { ok: false, reason: `Intent is ${intent.status}; only APPROVED intents execute.`, intent };
  if (intent.autonomyLevel === "DISABLED") return { ok: false, reason: "DISABLED action can never execute.", intent };
  const gate = options.gate ?? { executionEnabled: false };
  if (isConsequential(intent.actionType) && !gate.executionEnabled) {
    await record(repo, intent, { at: now.toISOString(), actor, event: "execution_blocked_kill_switch", from: intent.status, to: intent.status, detail: "GSO_AGENT_EXECUTION_ENABLED is false" });
    return { ok: false, reason: "Consequential execution is disabled (GSO_AGENT_EXECUTION_ENABLED=false). Intent stays APPROVED.", intent, blockedByKillSwitch: true };
  }
  let from: IntentStatus = intent.status; setStatus(intent, "EXECUTING");
  await record(repo, intent, { at: now.toISOString(), actor, event: "executing", from, to: "EXECUTING" });
  try {
    const outcome = await executor(intent);
    intent.externalReference = outcome.externalReference ?? null;
    intent.executedAt = new Date().toISOString();
    from = intent.status; setStatus(intent, "COMPLETED");
    await record(repo, intent, { at: intent.executedAt, actor, event: "completed", from, to: "COMPLETED", detail: intent.externalReference ?? undefined }, { executionResult: "completed" });
    return { ok: true, intent, duplicate: false, result: outcome.result };
  } catch (error: any) {
    intent.error = String(error?.message || error).slice(0, 500);
    from = intent.status; setStatus(intent, "FAILED");
    await record(repo, intent, { at: new Date().toISOString(), actor, event: "failed", from, to: "FAILED", detail: intent.error }, { executionResult: "failed" });
    return { ok: false, reason: intent.error, intent };
  }
}

/** A compact, PII-light view (no payload) for logs, Slack threads and the hub. */
export function auditSummary(intent: ActionIntent) {
  return {
    id: intent.id,
    actionType: intent.actionType,
    agentId: intent.agentId,
    agentVersion: intent.agentVersion,
    provider: intent.provider,
    model: intent.model,
    entity: `${intent.entityType}:${intent.entityId}`,
    status: intent.status,
    autonomyLevel: intent.autonomyLevel,
    idempotencyKey: intent.idempotencyKey,
    createdAt: intent.createdAt,
    approvedBy: intent.approvedBy ? `${intent.approvedBy.type}:${intent.approvedBy.id}` : null,
    requiresApproval: intent.autonomyLevel === "APPROVAL_REQUIRED" || intent.autonomyLevel === "OWNER_REQUIRED",
    executedAt: intent.executedAt,
    externalReference: intent.externalReference,
    error: intent.error,
    events: intent.audit.map((a) => `${a.at} ${a.actor.type}:${a.actor.id} ${a.event}${a.to ? ` -> ${a.to}` : ""}`),
  };
}
