// In-memory implementations of the OPS-2 repository boundary. Used by tests,
// the simulator and the default local runtime. NOT DURABLE across processes.
// The Prisma implementations mirror these semantics exactly.

import type { ActionIntent, AuditEvent } from "./action-intents";
import type {
  ActionIntentRepository, AgentRun, AgentRunRepository, AgentRunStatus, EnqueueInput, ExternalEventReceipt, ExternalEventRepository,
  IntentFilter, OpsRepositories, OutboxMessage, OutboxRepository, OutboxStatus, SlackStaffIdentityRepository, SlackStaffIdentityRow,
} from "./repositories";

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(++seq).toString(36).padStart(6, "0")}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryActionIntentRepository implements ActionIntentRepository {
  private byId = new Map<string, ActionIntent>();
  private byKey = new Map<string, string>();
  private audit: AuditEvent[] = [];
  async getById(id: string) { const v = this.byId.get(id); return v ? clone(v) : null; }
  async getByIdempotencyKey(key: string) { const id = this.byKey.get(key); return id ? this.getById(id) : null; }
  async save(intent: ActionIntent) { this.byId.set(intent.id, clone(intent)); this.byKey.set(intent.idempotencyKey, intent.id); }
  async appendAudit(event: AuditEvent) { this.audit.push(clone(event)); }
  async listAudit(intentId: string) { return this.audit.filter((a) => a.intentId === intentId).map(clone); }
  async list(filter: IntentFilter = {}) {
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
    const out = Array.from(this.byId.values()).filter((i) =>
      (!statuses || statuses.includes(i.status)) && (!filter.agentId || i.agentId === filter.agentId) &&
      (!filter.entityType || i.entityType === filter.entityType) && (!filter.entityId || i.entityId === filter.entityId));
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return (filter.limit ? out.slice(0, filter.limit) : out).map(clone);
  }
  /** Test helper: total audit rows ever written (append-only proof). */
  auditCount() { return this.audit.length; }
}

export class MemoryExternalEventRepository implements ExternalEventRepository {
  private rows = new Map<string, ExternalEventReceipt>();
  private key = (s: string, e: string) => `${s}::${e}`;
  async claim(input: { source: string; externalId: string; kind: string; now?: Date }) {
    const k = this.key(input.source, input.externalId);
    const existing = this.rows.get(k);
    if (existing) return { first: false, receipt: clone(existing) };
    const receipt: ExternalEventReceipt = { id: nextId("evt"), source: input.source, externalId: input.externalId, kind: input.kind, receivedAt: (input.now ?? new Date()).toISOString(), status: "RECEIVED", result: null, error: null };
    this.rows.set(k, receipt);
    return { first: true, receipt: clone(receipt) };
  }
  private find(id: string) { for (const r of this.rows.values()) if (r.id === id) return r; return null; }
  async complete(id: string, result: string | null) { const r = this.find(id); if (r) { r.status = "COMPLETED"; r.result = result; } }
  async fail(id: string, error: string) { const r = this.find(id); if (r) { r.status = "FAILED"; r.error = error; } }
  async get(source: string, externalId: string) { const r = this.rows.get(this.key(source, externalId)); return r ? clone(r) : null; }
}

export class MemoryOutboxRepository implements OutboxRepository {
  private rows = new Map<string, OutboxMessage>();
  private byKey = new Map<string, string>();
  async enqueue(input: EnqueueInput) {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) return { message: clone(this.rows.get(existingId)!), created: false };
    const now = (input.now ?? new Date()).toISOString();
    const message: OutboxMessage = { id: nextId("obx"), idempotencyKey: input.idempotencyKey, type: input.type, payload: clone(input.payload), intentId: input.intentId ?? null, status: "PENDING", attempts: 0, maxAttempts: input.maxAttempts ?? 5, nextAttemptAt: now, claimedBy: null, claimedAt: null, lastError: null, createdAt: now, completedAt: null, externalReference: null };
    this.rows.set(message.id, message);
    this.byKey.set(message.idempotencyKey, message.id);
    return { message: clone(message), created: true };
  }
  async claim(workerId: string, now: Date, limit: number) {
    const due = Array.from(this.rows.values())
      .filter((m) => (m.status === "PENDING" || m.status === "FAILED") && new Date(m.nextAttemptAt).getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const m of due) { m.status = "PROCESSING"; m.claimedBy = workerId; m.claimedAt = now.toISOString(); m.attempts += 1; }
    return due.map(clone);
  }
  async markCompleted(id: string, externalReference: string | null, now: Date) {
    const m = this.rows.get(id); if (!m) return;
    m.status = "COMPLETED"; m.completedAt = now.toISOString(); m.externalReference = externalReference; m.claimedBy = null;
  }
  async markFailed(id: string, error: string, nextAttemptAt: Date | null, now: Date) {
    const m = this.rows.get(id); if (!m) return;
    m.lastError = error.slice(0, 500); m.claimedBy = null;
    if (nextAttemptAt) { m.status = "FAILED"; m.nextAttemptAt = nextAttemptAt.toISOString(); } else { m.status = "DEAD"; m.nextAttemptAt = now.toISOString(); }
  }
  async releaseStale(olderThan: Date) {
    let n = 0;
    for (const m of this.rows.values()) if (m.status === "PROCESSING" && m.claimedAt && new Date(m.claimedAt).getTime() < olderThan.getTime()) { m.status = "PENDING"; m.claimedBy = null; m.lastError = "released stale claim"; n += 1; }
    return n;
  }
  async get(id: string) { const m = this.rows.get(id); return m ? clone(m) : null; }
  async list(status?: OutboxStatus) { return Array.from(this.rows.values()).filter((m) => !status || m.status === status).map(clone); }
}

export class MemoryAgentRunRepository implements AgentRunRepository {
  private rows = new Map<string, AgentRun>();
  async save(run: AgentRun) { this.rows.set(run.id, clone(run)); }
  async get(id: string) { const r = this.rows.get(id); return r ? clone(r) : null; }
  async listByStatus(status: AgentRunStatus) { return Array.from(this.rows.values()).filter((r) => r.status === status).map(clone); }
  async findPausedByIntent(intentId: string) { for (const r of this.rows.values()) if (r.status === "PAUSED_FOR_APPROVAL" && r.intentId === intentId) return clone(r); return null; }
}

export class MemorySlackStaffIdentityRepository implements SlackStaffIdentityRepository {
  private rows = new Map<string, SlackStaffIdentityRow>();
  constructor(seed: SlackStaffIdentityRow[] = []) { for (const r of seed) this.rows.set(r.slackUserId, clone(r)); }
  async resolve(slackUserId: string) { const r = this.rows.get(slackUserId); return r && r.active ? clone(r) : null; }
  async upsert(row: SlackStaffIdentityRow) { this.rows.set(row.slackUserId, clone(row)); }
  async list() { return Array.from(this.rows.values()).map(clone); }
}

export function createMemoryRepositories(seedStaff: SlackStaffIdentityRow[] = []): OpsRepositories {
  return {
    kind: "memory",
    intents: new MemoryActionIntentRepository(),
    events: new MemoryExternalEventRepository(),
    outbox: new MemoryOutboxRepository(),
    runs: new MemoryAgentRunRepository(),
    slackIdentities: new MemorySlackStaffIdentityRepository(seedStaff),
  };
}
