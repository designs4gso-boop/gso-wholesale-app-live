// GSO Operations Agent Platform — repository boundary (OPS-2).
//
// Business logic (action intents, approvals, outbox, worker, transition
// executor, Slack handling, reasoning runs) depends ONLY on these interfaces.
// Implementations: memory-repositories.ts (tests, simulation, default local
// runtime) and prisma-repositories.server.ts (durable runtime, after the
// OPS-2 migration is applied by the owner). Client-safe: types only.

import type { ActionIntent, AuditEvent, IntentStatus } from "./action-intents";

/* ------------------------------------------------------------------ *
 * Action intents + append-only audit
 * ------------------------------------------------------------------ */

export type IntentFilter = { status?: IntentStatus | IntentStatus[]; agentId?: string; entityType?: string; entityId?: string; limit?: number };

export interface ActionIntentRepository {
  getById(id: string): Promise<ActionIntent | null>;
  getByIdempotencyKey(key: string): Promise<ActionIntent | null>;
  /** Upsert the intent row. Must never delete audit history. */
  save(intent: ActionIntent): Promise<void>;
  /** Append-only. Implementations must never update or delete audit rows. */
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(intentId: string): Promise<AuditEvent[]>;
  list(filter?: IntentFilter): Promise<ActionIntent[]>;
}

/* ------------------------------------------------------------------ *
 * External event receipts (Slack events/interactions, webhooks, retries)
 * ------------------------------------------------------------------ */

export type ExternalEventStatus = "RECEIVED" | "COMPLETED" | "FAILED";

export type ExternalEventReceipt = {
  id: string;
  source: string;        // "slack" | "shopify" | "worker" | "openai" | ...
  externalId: string;    // event_id / envelope_id / interaction key / webhook id
  kind: string;          // "event" | "interaction" | "webhook" | "retry"
  receivedAt: string;
  status: ExternalEventStatus;
  result: string | null;
  error: string | null;
};

export interface ExternalEventRepository {
  /** Atomically records the receipt; `first` is false for any replay of (source, externalId). */
  claim(input: { source: string; externalId: string; kind: string; now?: Date }): Promise<{ first: boolean; receipt: ExternalEventReceipt }>;
  complete(id: string, result: string | null): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  get(source: string, externalId: string): Promise<ExternalEventReceipt | null>;
}

/* ------------------------------------------------------------------ *
 * Outbox
 * ------------------------------------------------------------------ */

export type OutboxStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DEAD";

export type OutboxMessage = {
  id: string;
  idempotencyKey: string;
  type: string;                       // handler key, e.g. "slack.post" | "intent.execute" | "production.transition"
  payload: Record<string, unknown>;
  intentId: string | null;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  externalReference: string | null;
};

export type EnqueueInput = { idempotencyKey: string; type: string; payload: Record<string, unknown>; intentId?: string | null; maxAttempts?: number; now?: Date };

export interface OutboxRepository {
  /** Idempotent on idempotencyKey: an existing message is returned unchanged with `created: false`. */
  enqueue(input: EnqueueInput): Promise<{ message: OutboxMessage; created: boolean }>;
  /** Claims up to `limit` PENDING/FAILED-retryable messages due at `now`; each message is claimed by exactly one worker. */
  claim(workerId: string, now: Date, limit: number): Promise<OutboxMessage[]>;
  markCompleted(id: string, externalReference: string | null, now: Date): Promise<void>;
  /** Records the failure; `nextAttemptAt` null means DEAD (manual review). */
  markFailed(id: string, error: string, nextAttemptAt: Date | null, now: Date): Promise<void>;
  /** Releases a PROCESSING claim whose worker died (visibility timeout). */
  releaseStale(olderThan: Date): Promise<number>;
  get(id: string): Promise<OutboxMessage | null>;
  list(status?: OutboxStatus): Promise<OutboxMessage[]>;
}

/* ------------------------------------------------------------------ *
 * Reasoning run state (workflow state, NOT business authorization)
 * ------------------------------------------------------------------ */

export type AgentRunStatus = "RUNNING" | "PAUSED_FOR_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";

export type AgentRun = {
  id: string;
  agentId: string;
  provider: string;
  model: string | null;
  status: AgentRunStatus;
  /** The ActionIntent this run is waiting on, if paused. */
  intentId: string | null;
  /** Provider-serialized run state (no secrets, no raw customer files). */
  state: string | null;
  turns: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

export interface AgentRunRepository {
  save(run: AgentRun): Promise<void>;
  get(id: string): Promise<AgentRun | null>;
  listByStatus(status: AgentRunStatus): Promise<AgentRun[]>;
  findPausedByIntent(intentId: string): Promise<AgentRun | null>;
}

/* ------------------------------------------------------------------ *
 * Slack identity
 * ------------------------------------------------------------------ */

export type SlackStaffIdentityRow = { slackUserId: string; staffId: string; name: string; role: "owner" | "staff"; active: boolean };

export interface SlackStaffIdentityRepository {
  resolve(slackUserId: string): Promise<SlackStaffIdentityRow | null>;
  upsert(row: SlackStaffIdentityRow): Promise<void>;
  list(): Promise<SlackStaffIdentityRow[]>;
}

export type OpsRepositories = {
  kind: "memory" | "prisma";
  intents: ActionIntentRepository;
  events: ExternalEventRepository;
  outbox: OutboxRepository;
  runs: AgentRunRepository;
  slackIdentities: SlackStaffIdentityRepository;
};
