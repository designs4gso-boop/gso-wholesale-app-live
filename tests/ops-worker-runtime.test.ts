// Stage 5 — durable worker foundation. Offline: memory repositories, fake
// handlers, no Slack, no database, no network.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decideIntent, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { ACTION_TYPES } from "../app/lib/ops/autonomy";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { WORKER_FORBIDDEN_ACTIONS, processOutboxBatch, workerMayExecute } from "../app/lib/ops/outbox-worker";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";
import { WORKER_HANDLER_TYPES_V1, WORKER_SCHEDULED, WORKER_TOKEN_ENV, _resetWorkerRuntimeForTests, authenticateWorkerRequest, runWorkerOnce, workerDiagnostics } from "../app/lib/ops/worker-runtime.server";

const now = new Date("2026-10-05T02:00:00Z");
const TOKEN = "unit-test-worker-token-0123456789abcdef"; // >= 32 chars; not a real secret

describe("worker action safety ceiling", () => {
  it("denies every consequential action regardless of the execution switch; allows only internal work", () => {
    for (const a of ["move_production_job", "send_customer_notification", "send_purchase_order", "send_invoice", "refund_or_void", "change_cost_or_price", "dispatch_to_machine", "mark_shipped", "record_qc_result", "record_final_art_approval", "override_canonical_blocker", "post_slack_external"] as const) {
      expect(WORKER_FORBIDDEN_ACTIONS.has(a), a).toBe(true);
      expect(workerMayExecute(a), a).toBe(false);
    }
    for (const a of ["create_review_queue_item", "classify_lead", "prepare_quote_prep_draft", "draft_followup", "post_slack_internal", "read_report"] as const) expect(workerMayExecute(a), a).toBe(true);
    // every action type is classified one way or the other
    for (const a of ACTION_TYPES) expect(typeof workerMayExecute(a)).toBe("boolean");
  });

  it("an APPROVED move_production_job in the outbox is dead-lettered for manual review even with execution=true, never executed", async () => {
    const repos = createMemoryRepositories();
    const on = readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" });
    const p = await proposeIntent(repos.intents, { actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "J1", payload: { targetStatus: "printing" }, reason: "t", idempotencyKey: "mv", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await decideIntent(repos.intents, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" }, undefined, now);
    let executions = 0;
    await repos.outbox.enqueue({ idempotencyKey: "mv-msg", type: "production.transition", payload: {}, intentId: p.intent.id, now });
    const report = await processOutboxBatch(repos, on, { "production.transition": async () => { executions += 1; return { externalReference: "moved" }; } }, { workerId: "w", now });
    expect(report.dead.length).toBe(1);
    expect(executions).toBe(0);
    const msg = (await repos.outbox.list("DEAD"))[0];
    expect(msg.lastError).toMatch(/worker may not execute consequential action move_production_job/);
    expect((await repos.intents.getById(p.intent.id))?.status).toBe("APPROVED"); // untouched, still needs the human path
    // not retried on a later run either
    const again = await processOutboxBatch(repos, on, { "production.transition": async () => { executions += 1; return {}; } }, { workerId: "w", now: new Date(now.getTime() + 3_600_000) });
    expect(again.claimed).toBe(0);
    expect(executions).toBe(0);
  });

  it("non-consequential intent-bound work still executes through the intent engine", async () => {
    const repos = createMemoryRepositories();
    const off = readOpsRuntimeConfig({});
    const p = await proposeIntent(repos.intents, { actionType: "create_review_queue_item", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "q", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await repos.outbox.enqueue({ idempotencyKey: "q-msg", type: "review.queue", payload: {}, intentId: p.intent.id, now });
    const report = await processOutboxBatch(repos, off, { "review.queue": async () => ({ externalReference: "queue:1" }) }, { workerId: "w", now });
    expect(report.completed.length).toBe(1);
    expect((await repos.intents.getById(p.intent.id))?.status).toBe("COMPLETED");
  });
});

describe("worker trigger authentication", () => {
  it("fails closed when the token is absent or too short; rejects missing/invalid bearer; accepts the exact token", () => {
    expect(authenticateWorkerRequest("Bearer x", {})).toEqual({ ok: false, status: 503, reason: "token_not_configured" });
    expect(authenticateWorkerRequest("Bearer short", { [WORKER_TOKEN_ENV]: "short" })).toEqual({ ok: false, status: 503, reason: "token_not_configured" });
    expect(authenticateWorkerRequest(null, { [WORKER_TOKEN_ENV]: TOKEN })).toEqual({ ok: false, status: 401, reason: "missing_bearer" });
    expect(authenticateWorkerRequest("Basic abc", { [WORKER_TOKEN_ENV]: TOKEN })).toEqual({ ok: false, status: 401, reason: "missing_bearer" });
    expect(authenticateWorkerRequest(`Bearer ${TOKEN}x`, { [WORKER_TOKEN_ENV]: TOKEN })).toEqual({ ok: false, status: 401, reason: "invalid_token" });
    expect(authenticateWorkerRequest(`Bearer ${TOKEN.slice(0, -1)}`, { [WORKER_TOKEN_ENV]: TOKEN })).toEqual({ ok: false, status: 401, reason: "invalid_token" });
    expect(authenticateWorkerRequest(`Bearer ${TOKEN}`, { [WORKER_TOKEN_ENV]: TOKEN })).toEqual({ ok: true });
  });

  it("the route authenticates before touching repositories, ignores request bodies, and returns counts only", () => {
    const src = readFileSync(new URL("../app/routes/api.ops.worker.run.tsx", import.meta.url), "utf8");
    const action = src.slice(src.indexOf("export async function action"));
    expect(action.indexOf("authenticateWorkerRequest")).toBeLessThan(action.indexOf("getOpsRepositories"));
    expect(src).not.toMatch(/request\.(json|formData|text|arrayBuffer|blob)\(/); // no caller payload is ever read
    expect(src).not.toMatch(/searchParams\.get|new URL\(request\.url\)/); // nor query parameters
    expect(src).not.toMatch(/\.payload\b|\.email\b|customerName/); // response carries counts only
    expect(src).toMatch(/createWorkerHandlersV1\(\)/);
    expect(src).not.toMatch(/productionJob|requestProductionTransition|decideIntent|setInterval|cron/);
  });
});

describe("worker runtime", () => {
  it("runs one batch at a time per process and records the last run", async () => {
    _resetWorkerRuntimeForTests();
    const repos = createMemoryRepositories();
    const config = readOpsRuntimeConfig({});
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await repos.outbox.enqueue({ idempotencyKey: "slow", type: "ops.noop", payload: {}, now });
    const first = runWorkerOnce(repos, config, { "ops.noop": async () => { await gate; return { externalReference: "noop" }; } }, { now });
    const second = await runWorkerOnce(repos, config, { "ops.noop": async () => ({}) }, { now });
    expect(second).toEqual({ ok: false, reason: "busy" });
    release();
    const done = await first;
    expect(done.ok && done.report.completed.length).toBe(1);
    const diag = await workerDiagnostics(repos, config, {}, now);
    expect(diag.lastRun?.completed.length).toBe(1);
    expect(diag.busy).toBe(false);
  });

  it("diagnostics are sanitized and truthful about scheduling, auth and the allow/deny lists", async () => {
    _resetWorkerRuntimeForTests();
    const repos = createMemoryRepositories();
    await repos.outbox.enqueue({ idempotencyKey: "d1", type: "unknown.type", payload: { email: "dana@example.com", secret: "xoxb-should-never-appear" }, now });
    await repos.outbox.enqueue({ idempotencyKey: "d2", type: "ops.noop", payload: {}, now });
    await processOutboxBatch(repos, readOpsRuntimeConfig({}), { "ops.noop": async () => { throw new Error("transient"); } }, { workerId: "w", now, backoffBaseMs: 60_000 });
    const diag = await workerDiagnostics(repos, readOpsRuntimeConfig({}), {}, now);
    expect(diag.scheduled).toBe(false);
    expect(WORKER_SCHEDULED).toBe(false);
    expect(diag.authConfigured).toBe(false);
    expect((await workerDiagnostics(repos, readOpsRuntimeConfig({}), { [WORKER_TOKEN_ENV]: TOKEN }, now)).authConfigured).toBe(true);
    expect(diag.handlers).toEqual(WORKER_HANDLER_TYPES_V1);
    expect(diag.forbiddenActions).toContain("move_production_job");
    expect(diag.outbox).toMatchObject({ dead: 1, retrying: 1, claimableNow: 0 });
    expect(diag.dead[0]).toMatchObject({ type: "unknown.type" });
    const text = JSON.stringify(diag);
    expect(text).not.toContain("dana@example.com");
    expect(text).not.toContain("xoxb-");
    expect(text).not.toContain(TOKEN);
  });
});
