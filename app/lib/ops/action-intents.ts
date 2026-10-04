// GSO Operations Agent Platform — the UNIVERSAL ACTION INTENT ENGINE.
//
// Every consequential thing an agent wants to do becomes an ActionIntent that
// moves through an explicit lifecycle. Approval is a HUMAN decision bound to
// an identity; execution is a separate step; the same idempotency key can
// never produce two intents, and the same intent can never execute twice.
//
// PERSISTENCE. No Prisma model exists for intents yet and no schema change is
// made tonight. The engine is written against a tiny store interface with an
// in-memory implementation for tests and local simulation. A durable store
// (new Prisma model `OpsActionIntent` + `OpsActionAudit`) is a documented
// deployment requirement — see docs/GSO_AGENT_DEPLOYMENT_PLAN.md.
//
// Client-safe: pure data + pure functions; no server imports.

import {
  effectiveAutonomy,
  approverSatisfies,
  type ActionType,
  type ApproverRole,
  type AutonomyLevel,
} from "./autonomy";
import { agentById } from "./agent-registry";

export const ACTION_INTENT_ENGINE_VERSION = "action-intents/1.0.0-2026-10-03";

export type IntentStatus =
  | "PROPOSED"
  | "VALIDATED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const INTENT_STATUSES: IntentStatus[] = ["PROPOSED", "VALIDATED", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "COMPLETED", "FAILED", "CANCELLED"];

/** Legal lifecycle moves. Anything else is refused. */
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

export type Actor = { type: "agent" | "staff" | "owner" | "system" | "customer"; id: string; name?: string; source?: string };

export type ActionIntent = {
  id: string;
  actionType: ActionType;
  agentId: string;
  agentVersion: string;
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
  /** Append-only audit trail. */
  audit: AuditRecord[];
};

export type AuditRecord = {
  at: string;
  actor: Actor;
  event: string;
  from: IntentStatus | null;
  to: IntentStatus | null;
  detail?: string;
  idempotencyKey?: string;
};

export interface ActionIntentStore {
  getById(id: string): ActionIntent | undefined;
  getByIdempotencyKey(key: string): ActionIntent | undefined;
  save(intent: ActionIntent): void;
  list(): ActionIntent[];
}

export class InMemoryActionIntentStore implements ActionIntentStore {
  private byId = new Map<string, ActionIntent>();
  private byKey = new Map<string, string>();
  getById(id: string) { return this.byId.get(id); }
  getByIdempotencyKey(key: string) { const id = this.byKey.get(key); return id ? this.byId.get(id) : undefined; }
  save(intent: ActionIntent) { this.byId.set(intent.id, intent); this.byKey.set(intent.idempotencyKey, intent.id); }
  list() { return Array.from(this.byId.values()); }
}

/** Deterministic id from the idempotency key — the same request yields the same id. */
export function intentIdFor(idempotencyKey: string): string {
  // FNV-1a 32-bit, hex — stable, dependency-free, collision-resistant enough
  // for an idempotency namespace that is ALSO guarded by the key itself.
  let hash = 0x811c9dc5;
  for (let i = 0; i < idempotencyKey.length; i += 1) {
    hash ^= idempotencyKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ai_${hash.toString(16).padStart(8, "0")}_${idempotencyKey.length}`;
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
  now?: Date;
};

export type ProposeResult =
  | { ok: true; intent: ActionIntent; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Propose an intent. Same idempotency key -> the SAME intent is returned and
 * nothing new is created (Slack retries, webhook retries, double clicks).
 */
export function proposeIntent(store: ActionIntentStore, input: ProposeInput): ProposeResult {
  const key = String(input.idempotencyKey || "").trim();
  if (!key) return { ok: false, reason: "idempotencyKey is required for every consequential action." };
  const existing = store.getByIdempotencyKey(key);
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
    audit: [{ at: now, actor, event: "proposed", from: null, to: "PROPOSED", idempotencyKey: key }],
  };
  store.save(intent);
  return { ok: true, intent, duplicate: false };
}

function move(intent: ActionIntent, to: IntentStatus, actor: Actor, event: string, detail?: string, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (!INTENT_TRANSITIONS[intent.status].includes(to)) {
    return { ok: false, reason: `Intent ${intent.id} cannot move ${intent.status} -> ${to}.` };
  }
  intent.audit.push({ at: now.toISOString(), actor, event, from: intent.status, to, detail });
  intent.status = to;
  return { ok: true };
}

/**
 * Validate: a DISABLED action is failed immediately (never awaits approval);
 * AUTO_* becomes APPROVED; APPROVAL/OWNER-required waits.
 */
export function validateIntent(store: ActionIntentStore, intentId: string, actor: Actor = { type: "system", id: "operations_supervisor" }, now = new Date()) {
  const intent = store.getById(intentId);
  if (!intent) return { ok: false as const, reason: "Intent not found." };
  if (intent.status !== "PROPOSED") return { ok: false as const, reason: `Intent is ${intent.status}, not PROPOSED.` };
  if (intent.autonomyLevel === "DISABLED") {
    intent.error = `Action "${intent.actionType}" is DISABLED in this release.`;
    move(intent, "FAILED", actor, "disabled_action", intent.error, now);
    store.save(intent);
    return { ok: false as const, reason: intent.error };
  }
  move(intent, "VALIDATED", actor, "validated", undefined, now);
  if (intent.autonomyLevel === "AUTO_READ" || intent.autonomyLevel === "AUTO_INTERNAL") {
    move(intent, "APPROVED", actor, "auto_approved_internal", `autonomy ${intent.autonomyLevel}`, now);
  } else {
    move(intent, "AWAITING_APPROVAL", actor, "awaiting_approval", intent.approvalPolicy, now);
  }
  store.save(intent);
  return { ok: true as const, intent };
}

export type ApprovalDecision = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "HOLD" | "RELEASE";

/**
 * Apply a human decision. The approver's ROLE must satisfy the intent's level;
 * an agent or unknown identity can never approve. Idempotent: approving an
 * already-approved intent is a no-op that reports duplicate=true.
 */
export function decideIntent(
  store: ActionIntentStore,
  intentId: string,
  decision: ApprovalDecision,
  approver: Actor & { role: ApproverRole },
  comment?: string,
  now = new Date(),
): { ok: true; intent: ActionIntent; duplicate: boolean } | { ok: false; reason: string } {
  const intent = store.getById(intentId);
  if (!intent) return { ok: false, reason: "Intent not found." };
  if (approver.type === "agent" || approver.type === "system") {
    return { ok: false, reason: "Agents and system actors cannot approve, reject or release intents." };
  }
  if (decision === "APPROVE" || decision === "RELEASE") {
    if (intent.status === "APPROVED") return { ok: true, intent, duplicate: true };
    if (!approverSatisfies(intent.autonomyLevel, approver.role)) {
      return { ok: false, reason: `"${intent.actionType}" needs ${intent.autonomyLevel}; approver role "${approver.role}" is not sufficient.` };
    }
    const from = intent.status;
    const result = move(intent, "APPROVED", approver, decision === "RELEASE" ? "released" : "approved", comment, now);
    if (!result.ok) return result;
    intent.approvedBy = { type: approver.type, id: approver.id, name: approver.name, source: approver.source };
    intent.approvedAt = now.toISOString();
    intent.audit[intent.audit.length - 1].detail = `${comment ?? ""} (from ${from})`.trim();
    store.save(intent);
    return { ok: true, intent, duplicate: false };
  }
  if (decision === "REJECT") {
    if (intent.status === "CANCELLED") return { ok: true, intent, duplicate: true };
    const result = move(intent, "CANCELLED", approver, "rejected", comment, now);
    if (!result.ok) return result;
    store.save(intent);
    return { ok: true, intent, duplicate: false };
  }
  if (decision === "REQUEST_CHANGES") {
    if (intent.status !== "AWAITING_APPROVAL" && intent.status !== "VALIDATED") {
      return { ok: false, reason: `Cannot request changes on a ${intent.status} intent.` };
    }
    intent.audit.push({ at: now.toISOString(), actor: approver, event: "changes_requested", from: intent.status, to: intent.status, detail: comment });
    store.save(intent);
    return { ok: true, intent, duplicate: false };
  }
  // HOLD: stays where it is, audited.
  intent.audit.push({ at: now.toISOString(), actor: approver, event: "held", from: intent.status, to: intent.status, detail: comment });
  store.save(intent);
  return { ok: true, intent, duplicate: false };
}

/**
 * Execute through an injected executor. The intent must be APPROVED; a
 * COMPLETED intent is never executed again (returns duplicate=true).
 */
export async function executeIntent<T>(
  store: ActionIntentStore,
  intentId: string,
  executor: (intent: ActionIntent) => Promise<{ externalReference?: string | null; result?: T }>,
  actor: Actor = { type: "system", id: "operations_supervisor" },
  now = new Date(),
): Promise<{ ok: true; intent: ActionIntent; duplicate: boolean; result?: T } | { ok: false; reason: string; intent?: ActionIntent }> {
  const intent = store.getById(intentId);
  if (!intent) return { ok: false, reason: "Intent not found." };
  if (intent.status === "COMPLETED") return { ok: true, intent, duplicate: true };
  if (intent.status !== "APPROVED") return { ok: false, reason: `Intent is ${intent.status}; only APPROVED intents execute.`, intent };
  if (intent.autonomyLevel === "DISABLED") return { ok: false, reason: "DISABLED action can never execute.", intent };
  move(intent, "EXECUTING", actor, "executing", undefined, now);
  store.save(intent);
  try {
    const outcome = await executor(intent);
    intent.externalReference = outcome.externalReference ?? null;
    intent.executedAt = new Date().toISOString();
    move(intent, "COMPLETED", actor, "completed", intent.externalReference ?? undefined);
    store.save(intent);
    return { ok: true, intent, duplicate: false, result: outcome.result };
  } catch (error: any) {
    intent.error = String(error?.message || error).slice(0, 500);
    move(intent, "FAILED", actor, "failed", intent.error);
    store.save(intent);
    return { ok: false, reason: intent.error, intent };
  }
}

/** A compact, PII-light audit view (no payload) for logs and Slack threads. */
export function auditSummary(intent: ActionIntent) {
  return {
    id: intent.id,
    actionType: intent.actionType,
    agentId: intent.agentId,
    agentVersion: intent.agentVersion,
    entity: `${intent.entityType}:${intent.entityId}`,
    status: intent.status,
    autonomyLevel: intent.autonomyLevel,
    idempotencyKey: intent.idempotencyKey,
    approvedBy: intent.approvedBy ? `${intent.approvedBy.type}:${intent.approvedBy.id}` : null,
    executedAt: intent.executedAt,
    externalReference: intent.externalReference,
    error: intent.error,
    events: intent.audit.map((a) => `${a.at} ${a.actor.type}:${a.actor.id} ${a.event}${a.to ? ` -> ${a.to}` : ""}`),
  };
}
