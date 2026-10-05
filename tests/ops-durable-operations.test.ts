// OPS-2 durable operations: repositories, external-event receipts, outbox,
// worker, kill switches, transition executor. Memory repositories only — no
// database is touched.

import { describe, expect, it } from "vitest";

import { decideIntent, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { backoffMs, processOutboxBatch } from "../app/lib/ops/outbox-worker";
import { requestProductionTransition, type TransitionDeps } from "../app/lib/ops/production-transition-executor";
import { describeOpsRuntime, readOpsRuntimeConfig, reasoningAvailable } from "../app/lib/ops/runtime-config";

const now = new Date("2026-10-04T05:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("runtime config and kill switches", () => {
  it("defaults are SAFE: provider none, reasoning off, execution off, tracing off, memory repository", () => {
    const c = readOpsRuntimeConfig({});
    expect(c).toMatchObject({ executionEnabled: false, reasoningEnabled: false, provider: "none", repository: "memory" });
    expect(c.openai).toEqual({ apiKeyPresent: false, model: null, tracingEnabled: false, traceIncludeSensitiveData: false });
    expect(reasoningAvailable(c)).toBe(false);
    const d = describeOpsRuntime(c);
    expect(d).toMatchObject({ provider: "NONE", reasoningEnabled: "NO", executionEnabled: "NO", tracingEnabled: "NO", sensitiveTracing: "NO" });
    expect(JSON.stringify(d)).not.toMatch(/sk-|key/i);
  });

  it("missing key or model fails closed even when reasoning is switched on; the two switches are independent", () => {
    const noKey = readOpsRuntimeConfig({ GSO_REASONING_PROVIDER: "openai", GSO_AGENT_REASONING_ENABLED: "true", GSO_OPENAI_MODEL: "x" });
    expect(reasoningAvailable(noKey)).toBe(false);
    expect(noKey.reasoningBlockers).toContain("OPENAI_API_KEY absent");
    const noModel = readOpsRuntimeConfig({ GSO_REASONING_PROVIDER: "openai", GSO_AGENT_REASONING_ENABLED: "true", OPENAI_API_KEY: "present-in-test-only" });
    expect(noModel.reasoningBlockers).toContain("GSO_OPENAI_MODEL not configured");
    expect(JSON.stringify(describeOpsRuntime(noModel))).not.toContain("present-in-test-only");
    const ready = readOpsRuntimeConfig({ GSO_REASONING_PROVIDER: "openai", GSO_AGENT_REASONING_ENABLED: "true", OPENAI_API_KEY: "k", GSO_OPENAI_MODEL: "m" });
    expect(reasoningAvailable(ready)).toBe(true);
    expect(ready.executionEnabled).toBe(false); // reasoning on does not turn execution on
    const execOnly = readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" });
    expect(execOnly.executionEnabled).toBe(true);
    expect(reasoningAvailable(execOnly)).toBe(false); // execution on does not turn reasoning on
    expect(readOpsRuntimeConfig({ GSO_REASONING_PROVIDER: "anthropic", GSO_AGENT_REASONING_ENABLED: "true" }).reasoningBlockers.join()).toMatch(/not implemented/);
  });
});

describe("external event receipts", () => {
  it("first claim wins; replays report first=false; completion/failure recorded", async () => {
    const repos = createMemoryRepositories();
    const a = await repos.events.claim({ source: "slack", externalId: "Ev1", kind: "event", now });
    const b = await repos.events.claim({ source: "slack", externalId: "Ev1", kind: "event", now });
    const c = await repos.events.claim({ source: "shopify", externalId: "Ev1", kind: "webhook", now });
    expect(a.first && !b.first && c.first).toBe(true);
    expect(a.receipt.id).toBe(b.receipt.id);
    await repos.events.complete(a.receipt.id, "done");
    expect((await repos.events.get("slack", "Ev1"))?.status).toBe("COMPLETED");
    await repos.events.fail(c.receipt.id, "bad");
    expect((await repos.events.get("shopify", "Ev1"))).toMatchObject({ status: "FAILED", error: "bad" });
  });
});

describe("outbox and worker", () => {
  it("enqueue is idempotent; claim is exclusive; completion recorded", async () => {
    const repos = createMemoryRepositories();
    const a = await repos.outbox.enqueue({ idempotencyKey: "k", type: "noop", payload: { x: 1 }, now });
    const b = await repos.outbox.enqueue({ idempotencyKey: "k", type: "noop", payload: { x: 2 }, now });
    expect(a.created && !b.created && a.message.id === b.message.id).toBe(true);
    const w1 = await repos.outbox.claim("w1", now, 10);
    const w2 = await repos.outbox.claim("w2", now, 10);
    expect(w1.length).toBe(1);
    expect(w2.length).toBe(0); // already PROCESSING
    expect(w1[0].attempts).toBe(1);
    await repos.outbox.markCompleted(w1[0].id, "ref", now);
    expect((await repos.outbox.get(w1[0].id))).toMatchObject({ status: "COMPLETED", externalReference: "ref" });
    expect(backoffMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffMs(4, 1000, 60_000)).toBe(8000);
    expect(backoffMs(20, 1000, 60_000)).toBe(60_000);
  });

  it("worker retries boundedly, never duplicates a completed action, deads permanent failures, releases stale claims", async () => {
    const repos = createMemoryRepositories();
    const config = readOpsRuntimeConfig({});
    let runs = 0;
    const handlers = {
      "flaky": async () => { runs += 1; if (runs === 1) throw new Error("transient"); return { externalReference: `ok-${runs}` }; },
      "dead": async () => { throw new Error("permanent"); },
    };
    await repos.outbox.enqueue({ idempotencyKey: "f", type: "flaky", payload: {}, maxAttempts: 3, now });
    await repos.outbox.enqueue({ idempotencyKey: "d", type: "dead", payload: {}, maxAttempts: 2, now });
    await repos.outbox.enqueue({ idempotencyKey: "u", type: "unknown.type", payload: {}, now });
    const r1 = await processOutboxBatch(repos, config, handlers, { workerId: "w", now, backoffBaseMs: 1000 });
    expect(r1.retried.length).toBe(2);
    expect(r1.dead.length).toBe(1); // unknown handler -> dead immediately
    const r2 = await processOutboxBatch(repos, config, handlers, { workerId: "w", now: later(1500), backoffBaseMs: 1000 });
    expect(r2.completed.length).toBe(1);
    expect(r2.dead.length).toBe(1); // permanent failure hit maxAttempts
    const r3 = await processOutboxBatch(repos, config, handlers, { workerId: "w", now: later(60_000), backoffBaseMs: 1000 });
    expect(r3.claimed).toBe(0); // nothing left; completed never re-runs
    expect(runs).toBe(2);
    const dead = await repos.outbox.list("DEAD");
    expect(dead.map((m) => m.idempotencyKey).sort()).toEqual(["d", "u"]);
    // stale claim release
    await repos.outbox.enqueue({ idempotencyKey: "stale", type: "flaky", payload: {}, now });
    const claimed = await repos.outbox.claim("crashed", now, 1);
    expect(claimed.length).toBe(1);
    const r4 = await processOutboxBatch(repos, config, handlers, { workerId: "w", now: later(11 * 60_000), staleAfterMs: 10 * 60_000 });
    expect(r4.releasedStale).toBe(1);
    expect(r4.completed.length).toBe(1);
  });

  it("intent-bound messages: consequential actions are dead-lettered for a human path even when approved and execution is on; internal work executes once", async () => {
    const repos = createMemoryRepositories();
    const on = readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" });
    const p = await proposeIntent(repos.intents, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "ship", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await decideIntent(repos.intents, p.intent.id, "APPROVE", { type: "staff", id: "s", role: "staff" }, undefined, now);
    let executions = 0;
    const handlers = { "ship": async () => { executions += 1; return { externalReference: "1Z" }; }, "queue": async () => { executions += 1; return { externalReference: "q" }; } };
    await repos.outbox.enqueue({ idempotencyKey: "ship-msg", type: "ship", payload: {}, intentId: p.intent.id, now });
    const r1 = await processOutboxBatch(repos, on, handlers, { workerId: "w", now, backoffBaseMs: 1000 });
    expect(r1.dead.length).toBe(1); // Stage 5 ceiling: the worker never executes consequential actions
    expect(executions).toBe(0);
    expect((await repos.intents.getById(p.intent.id))?.status).toBe("APPROVED");
    // Internal (non-consequential) work executes through the intent engine exactly once.
    const q = await proposeIntent(repos.intents, { actionType: "create_review_queue_item", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "q", now });
    if (!q.ok) throw new Error();
    await validateIntent(repos.intents, q.intent.id, undefined, now);
    await repos.outbox.enqueue({ idempotencyKey: "q-msg", type: "queue", payload: {}, intentId: q.intent.id, now });
    const r3 = await processOutboxBatch(repos, readOpsRuntimeConfig({}), handlers, { workerId: "w", now: later(5000), backoffBaseMs: 1000 });
    expect(r3.completed.length).toBe(1);
    expect(executions).toBe(1);
    await repos.outbox.enqueue({ idempotencyKey: "q-msg-2", type: "queue", payload: {}, intentId: q.intent.id, now });
    const r4 = await processOutboxBatch(repos, readOpsRuntimeConfig({}), handlers, { workerId: "w", now: later(6000) });
    expect(r4.skipped.length).toBe(1);
    expect(executions).toBe(1);
  });
});

describe("production transition executor", () => {
  function setup() {
    const repos = createMemoryRepositories();
    const erp = { status: "proof_approved", writes: 0 };
    const deps: TransitionDeps = {
      loadJob: async (id) => (id === "j1" ? { id: "j1", shop: "s", jobTicket: "T", status: erp.status } : null),
      loadFacts: async () => ({ artApproved: true, materialReady: true, routingDecided: true, qcPassRecorded: false }),
      checkRouting: async () => ({ blocked: false, reasons: [] }),
      applyTransition: async (_job, target) => { erp.status = target; erp.writes += 1; return { externalReference: `job:j1:${target}` }; },
    };
    return { repos, erp, deps };
  }
  const owner = { type: "owner" as const, id: "o" };
  const approvedIntent = async (repos: ReturnType<typeof createMemoryRepositories>, target: string, key: string) => {
    const p = await proposeIntent(repos.intents, { actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "j1", payload: { targetStatus: target }, reason: "t", idempotencyKey: key, now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await decideIntent(repos.intents, p.intent.id, "APPROVE", { ...owner, role: "owner" }, undefined, now);
    return p.intent.id;
  };

  it("requires an approved, matching intent and the kill switch; executes once", async () => {
    const { repos, erp, deps } = setup();
    const off = readOpsRuntimeConfig({});
    const on = readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" });
    const id = await approvedIntent(repos, "printing", "m1");
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: "nope", actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "intent" });
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: id, actor: owner }, deps, repos, off, now)).toMatchObject({ ok: false, stage: "kill_switch" });
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "cutting", actionIntentId: id, actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "intent" });
    expect(await requestProductionTransition({ jobId: "j9", targetStatus: "printing", actionIntentId: id, actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "intent" });
    const ok = await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: id, actor: owner }, deps, repos, on, now);
    expect(ok).toMatchObject({ ok: true, duplicate: false, from: "proof_approved", to: "printing" });
    expect(erp).toEqual({ status: "printing", writes: 1 });
    const twice = await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: id, actor: owner }, deps, repos, on, now);
    expect(twice).toMatchObject({ ok: true, duplicate: true });
    expect(erp.writes).toBe(1);
    const audit = await repos.intents.listAudit(id);
    expect(audit.at(-1)).toMatchObject({ newStatus: "COMPLETED", externalReference: "job:j1:printing" });
  });

  it("unapproved intent, bad prior status, missing art, missing QC and routing conflicts all block", async () => {
    const { repos, erp, deps } = setup();
    const on = readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" });
    const p = await proposeIntent(repos.intents, { actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "j1", payload: { targetStatus: "printing" }, reason: "t", idempotencyKey: "u", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: p.intent.id, actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "intent" });
    const toCompleted = await approvedIntent(repos, "completed", "c");
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "completed", actionIntentId: toCompleted, actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "guard" }); // proof_approved -> completed not allowed, no QC
    const noArt = await approvedIntent(repos, "printing", "na");
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: noArt, actor: owner }, { ...deps, loadFacts: async () => ({ artApproved: false }) }, repos, on, now)).toMatchObject({ ok: false, stage: "guard" });
    const routed = await approvedIntent(repos, "printing", "rt");
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: routed, actor: owner }, { ...deps, checkRouting: async () => ({ blocked: true, reasons: ["white on mimaki"] }) }, repos, on, now)).toMatchObject({ ok: false, stage: "routing", reasons: ["white on mimaki"] });
    erp.status = "shipped";
    const fromShipped = await approvedIntent(repos, "printing", "fs");
    expect(await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: fromShipped, actor: owner }, deps, repos, on, now)).toMatchObject({ ok: false, stage: "guard" });
    expect(erp.writes).toBe(0);
  });
});
