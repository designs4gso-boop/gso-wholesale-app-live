// Prisma implementations of the OPS-2 repository boundary. Durable runtime.
//
// REQUIRES the OPS-2 migration (prisma/migrations/20261004120000_add_ops_agent_platform)
// to be applied by the owner. Selected only when GSO_OPS_REPOSITORY=prisma.
// Semantics mirror memory-repositories.ts exactly; the engine and worker do
// not know which implementation they are talking to.

import db from "../../db.server";
import type { ActionIntent, Actor, AuditEvent, IntentStatus } from "./action-intents";
import type {
  ActionIntentRepository, AgentRun, AgentRunRepository, AgentRunStatus, EnqueueInput, ExternalEventReceipt, ExternalEventRepository,
  IntentFilter, OpsRepositories, OutboxMessage, OutboxRepository, OutboxStatus, SlackStaffIdentityRepository, SlackStaffIdentityRow,
} from "./repositories";

type Db = typeof db;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function actorFrom(type: string | null, id: string | null, name?: string | null, source?: string | null): Actor | null {
  if (!type || !id) return null;
  return { type: type as Actor["type"], id, name: name ?? undefined, source: source ?? undefined };
}

function intentFromRow(row: any, audit: AuditEvent[]): ActionIntent {
  return {
    id: row.id, actionType: row.actionType, agentId: row.agentId, agentVersion: row.agentVersion, provider: row.provider, model: row.model,
    entityType: row.entityType, entityId: row.entityId, payload: (row.payload as Record<string, unknown>) ?? {}, reason: row.reason,
    autonomyLevel: row.autonomyLevel, approvalPolicy: row.approvalPolicy, idempotencyKey: row.idempotencyKey, status: row.status as IntentStatus,
    createdAt: row.createdAt.toISOString(), createdBy: actorFrom(row.createdByType, row.createdById, null, row.createdBySource)!,
    approvedBy: actorFrom(row.approvedByType, row.approvedById, row.approvedByName, row.approvedBySource), approvedAt: iso(row.approvedAt),
    executedAt: iso(row.executedAt), externalReference: row.externalReference, error: row.error,
    audit: audit.map((a) => ({ at: a.at, actor: a.actor, event: a.event, from: a.previousStatus, to: a.newStatus, detail: a.detail ?? undefined, idempotencyKey: a.idempotencyKey })),
  };
}

function auditFromRow(r: any): AuditEvent {
  return {
    id: r.id, intentId: r.intentId, idempotencyKey: r.idempotencyKey, agentId: r.agentId, agentVersion: r.agentVersion, provider: r.provider, model: r.model,
    entityType: r.entityType, entityId: r.entityId, actionType: r.actionType, reason: "", payloadKeys: (r.payloadKeys as string[]) ?? [], autonomyLevel: r.autonomyLevel,
    previousStatus: r.previousStatus, newStatus: r.newStatus, event: r.event, actor: { type: r.actorType, id: r.actorId, source: r.actorSource ?? undefined },
    approver: actorFrom(r.approverType, r.approverId), at: r.at.toISOString(), executionResult: r.executionResult, externalReference: r.externalReference, error: r.error, detail: r.detail,
  };
}

export class PrismaActionIntentRepository implements ActionIntentRepository {
  constructor(private readonly client: Db = db) {}
  private get model() { return (this.client as any).opsActionIntent; }
  private get auditModel() { return (this.client as any).opsActionAuditEvent; }
  async getById(id: string) {
    const row = await this.model.findUnique({ where: { id } });
    return row ? intentFromRow(row, await this.listAudit(id)) : null;
  }
  async getByIdempotencyKey(key: string) {
    const row = await this.model.findUnique({ where: { idempotencyKey: key } });
    return row ? intentFromRow(row, await this.listAudit(row.id)) : null;
  }
  async save(i: ActionIntent) {
    const data = {
      actionType: i.actionType, agentId: i.agentId, agentVersion: i.agentVersion, provider: i.provider, model: i.model, entityType: i.entityType, entityId: i.entityId,
      payload: i.payload as any, reason: i.reason, autonomyLevel: i.autonomyLevel, approvalPolicy: i.approvalPolicy, status: i.status,
      createdByType: i.createdBy.type, createdById: i.createdBy.id, createdBySource: i.createdBy.source ?? null,
      approvedByType: i.approvedBy?.type ?? null, approvedById: i.approvedBy?.id ?? null, approvedByName: i.approvedBy?.name ?? null, approvedBySource: i.approvedBy?.source ?? null,
      approvedAt: i.approvedAt ? new Date(i.approvedAt) : null, executedAt: i.executedAt ? new Date(i.executedAt) : null, externalReference: i.externalReference, error: i.error,
    };
    await this.model.upsert({ where: { id: i.id }, create: { id: i.id, idempotencyKey: i.idempotencyKey, createdAt: new Date(i.createdAt), ...data }, update: data });
  }
  async appendAudit(e: AuditEvent) {
    // INSERT ONLY — there is deliberately no update/delete path for audit rows.
    await this.auditModel.create({ data: {
      id: e.id, intentId: e.intentId, idempotencyKey: e.idempotencyKey, agentId: e.agentId, agentVersion: e.agentVersion, provider: e.provider, model: e.model,
      entityType: e.entityType, entityId: e.entityId, actionType: e.actionType, autonomyLevel: e.autonomyLevel, event: e.event, previousStatus: e.previousStatus, newStatus: e.newStatus,
      actorType: e.actor.type, actorId: e.actor.id, actorSource: e.actor.source ?? null, approverType: e.approver?.type ?? null, approverId: e.approver?.id ?? null,
      executionResult: e.executionResult, externalReference: e.externalReference, error: e.error, detail: e.detail, payloadKeys: e.payloadKeys as any, at: new Date(e.at),
    } });
  }
  async listAudit(intentId: string) {
    const rows = await this.auditModel.findMany({ where: { intentId }, orderBy: { at: "asc" } });
    return rows.map(auditFromRow);
  }
  async list(filter: IntentFilter = {}) {
    const rows = await this.model.findMany({
      where: { ...(filter.status ? { status: Array.isArray(filter.status) ? { in: filter.status } : filter.status } : {}), ...(filter.agentId ? { agentId: filter.agentId } : {}), ...(filter.entityType ? { entityType: filter.entityType } : {}), ...(filter.entityId ? { entityId: filter.entityId } : {}) },
      orderBy: { createdAt: "asc" }, take: filter.limit ?? 200,
    });
    return rows.map((r: any) => intentFromRow(r, []));
  }
}

export class PrismaExternalEventRepository implements ExternalEventRepository {
  constructor(private readonly client: Db = db) {}
  private get model() { return (this.client as any).opsExternalEventReceipt; }
  private toReceipt(r: any): ExternalEventReceipt { return { id: r.id, source: r.source, externalId: r.externalId, kind: r.kind, receivedAt: r.receivedAt.toISOString(), status: r.status, result: r.result, error: r.error }; }
  async claim(input: { source: string; externalId: string; kind: string; now?: Date }) {
    try {
      const row = await this.model.create({ data: { source: input.source, externalId: input.externalId, kind: input.kind, receivedAt: input.now ?? new Date() } });
      return { first: true, receipt: this.toReceipt(row) };
    } catch (error: any) {
      if (error?.code === "P2002") { // unique violation = replay
        const existing = await this.model.findUnique({ where: { source_externalId: { source: input.source, externalId: input.externalId } } });
        return { first: false, receipt: this.toReceipt(existing) };
      }
      throw error;
    }
  }
  async complete(id: string, result: string | null) { await this.model.update({ where: { id }, data: { status: "COMPLETED", result } }); }
  async fail(id: string, error: string) { await this.model.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 500) } }); }
  async get(source: string, externalId: string) { const r = await this.model.findUnique({ where: { source_externalId: { source, externalId } } }); return r ? this.toReceipt(r) : null; }
}

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly client: Db = db) {}
  private get model() { return (this.client as any).opsOutboxMessage; }
  private toMsg(r: any): OutboxMessage { return { id: r.id, idempotencyKey: r.idempotencyKey, type: r.type, payload: r.payload ?? {}, intentId: r.intentId, status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts, nextAttemptAt: r.nextAttemptAt.toISOString(), claimedBy: r.claimedBy, claimedAt: iso(r.claimedAt), lastError: r.lastError, createdAt: r.createdAt.toISOString(), completedAt: iso(r.completedAt), externalReference: r.externalReference }; }
  async enqueue(input: EnqueueInput) {
    try {
      const row = await this.model.create({ data: { idempotencyKey: input.idempotencyKey, type: input.type, payload: input.payload as any, intentId: input.intentId ?? null, maxAttempts: input.maxAttempts ?? 5, nextAttemptAt: input.now ?? new Date(), createdAt: input.now ?? new Date() } });
      return { message: this.toMsg(row), created: true };
    } catch (error: any) {
      if (error?.code === "P2002") return { message: this.toMsg(await this.model.findUnique({ where: { idempotencyKey: input.idempotencyKey } })), created: false };
      throw error;
    }
  }
  /** Claim = conditional update per candidate: only the worker whose updateMany matched 1 row owns the message. */
  async claim(workerId: string, now: Date, limit: number) {
    const candidates = await this.model.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now } }, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: limit * 2 });
    const claimed: OutboxMessage[] = [];
    for (const c of candidates) {
      if (claimed.length >= limit) break;
      const res = await this.model.updateMany({ where: { id: c.id, status: c.status, attempts: c.attempts }, data: { status: "PROCESSING", claimedBy: workerId, claimedAt: now, attempts: { increment: 1 } } });
      if (res.count === 1) claimed.push(this.toMsg(await this.model.findUnique({ where: { id: c.id } })));
    }
    return claimed;
  }
  async markCompleted(id: string, externalReference: string | null, now: Date) { await this.model.update({ where: { id }, data: { status: "COMPLETED", completedAt: now, externalReference, claimedBy: null } }); }
  async markFailed(id: string, error: string, nextAttemptAt: Date | null, now: Date) { await this.model.update({ where: { id }, data: { status: nextAttemptAt ? "FAILED" : "DEAD", lastError: error.slice(0, 500), nextAttemptAt: nextAttemptAt ?? now, claimedBy: null } }); }
  async releaseStale(olderThan: Date) { const r = await this.model.updateMany({ where: { status: "PROCESSING", claimedAt: { lt: olderThan } }, data: { status: "PENDING", claimedBy: null, lastError: "released stale claim" } }); return r.count; }
  async get(id: string) { const r = await this.model.findUnique({ where: { id } }); return r ? this.toMsg(r) : null; }
  async list(status?: OutboxStatus) { const rows = await this.model.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "asc" }, take: 500 }); return rows.map((r: any) => this.toMsg(r)); }
}

export class PrismaAgentRunRepository implements AgentRunRepository {
  constructor(private readonly client: Db = db) {}
  private get model() { return (this.client as any).opsAgentRun; }
  private toRun(r: any): AgentRun { return { id: r.id, agentId: r.agentId, provider: r.provider, model: r.model, status: r.status, intentId: r.intentId, state: r.state ? JSON.stringify(r.state) : null, turns: r.turns, startedAt: r.startedAt.toISOString(), updatedAt: r.updatedAt.toISOString(), completedAt: iso(r.completedAt), error: r.error }; }
  async save(run: AgentRun) {
    const data = { agentId: run.agentId, provider: run.provider, model: run.model, status: run.status, intentId: run.intentId, state: run.state ? JSON.parse(run.state) : null, turns: run.turns, completedAt: run.completedAt ? new Date(run.completedAt) : null, error: run.error };
    await this.model.upsert({ where: { id: run.id }, create: { id: run.id, startedAt: new Date(run.startedAt), ...data }, update: data });
  }
  async get(id: string) { const r = await this.model.findUnique({ where: { id } }); return r ? this.toRun(r) : null; }
  async listByStatus(status: AgentRunStatus) { return (await this.model.findMany({ where: { status }, orderBy: { updatedAt: "desc" }, take: 200 })).map((r: any) => this.toRun(r)); }
  async findPausedByIntent(intentId: string) { const r = await this.model.findFirst({ where: { intentId, status: "PAUSED_FOR_APPROVAL" } }); return r ? this.toRun(r) : null; }
}

export class PrismaSlackStaffIdentityRepository implements SlackStaffIdentityRepository {
  constructor(private readonly client: Db = db) {}
  private get model() { return (this.client as any).opsSlackStaffIdentity; }
  async resolve(slackUserId: string) { const r = await this.model.findUnique({ where: { slackUserId } }); return r && r.active ? { slackUserId: r.slackUserId, staffId: r.staffId, name: r.name, role: r.role === "owner" ? "owner" : "staff", active: r.active } as SlackStaffIdentityRow : null; }
  async upsert(row: SlackStaffIdentityRow) { await this.model.upsert({ where: { slackUserId: row.slackUserId }, create: row, update: { staffId: row.staffId, name: row.name, role: row.role, active: row.active } }); }
  async list() { return (await this.model.findMany({ orderBy: { name: "asc" } })).map((r: any) => ({ slackUserId: r.slackUserId, staffId: r.staffId, name: r.name, role: r.role === "owner" ? "owner" : "staff", active: r.active }) as SlackStaffIdentityRow); }
}

export function createPrismaRepositories(client: Db = db): OpsRepositories {
  return { kind: "prisma", intents: new PrismaActionIntentRepository(client), events: new PrismaExternalEventRepository(client), outbox: new PrismaOutboxRepository(client), runs: new PrismaAgentRunRepository(client), slackIdentities: new PrismaSlackStaffIdentityRepository(client) };
}
