// Stage 4 guarded real test-job transition — offline tests with memory
// repositories, a fake Slack poster, a fake job lookup and a fake ERP behind
// the executor dependencies. No database, no network, no live Slack.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decideIntent } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { prismaTransitionDeps } from "../app/lib/ops/production-transition-executor.server";
import type { TransitionDeps } from "../app/lib/ops/production-transition-executor";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";
import type { SandboxSlackPoster } from "../app/lib/ops/sandbox-approval-test";
import { STAGE4, createStage4Intent, executeStage4, findStage4Intents, resolveStage4Job, stage4Gate, stage4Preflight, type Stage4Deps, type Stage4JobRow } from "../app/lib/ops/stage4-test-transition";
import { SLACK_ACTION_IDS } from "../app/lib/slack/slack-blocks";
import { parseStaffMap, resolveSlackDestination, type SlackDestination } from "../app/lib/slack/slack-config";
import { handleSlackInteraction, parseSlackInteraction } from "../app/lib/slack/slack-interactions";

const now = new Date("2026-10-04T20:00:00Z");
const ENV = { SLACK_BOT_TOKEN: "test-token-not-real", SLACK_SIGNING_SECRET: "test-secret-not-real", SLACK_TEST_CHANNEL: "gso-agent-sandbox", SLACK_SANDBOX_ONLY: "true", SLACK_CHANNEL_PRODUCTION: "C0REALPROD" };
const CFG_OFF = readOpsRuntimeConfig({ GSO_OPS_REPOSITORY: "prisma" });
const CFG_ON = readOpsRuntimeConfig({ GSO_OPS_REPOSITORY: "prisma", GSO_AGENT_EXECUTION_ENABLED: "true" });
const OWNER = { type: "staff" as const, id: "owner@example.com", name: "Owner" };
const STAFF_MAP = parseStaffMap(JSON.stringify({ U_OWNER: { staffId: "owner", name: "Owner", role: "owner" } }));
const click = (actionId: string, intentId: string, user: string, ts = "1.000") => ({ type: "block_actions", user: { id: user, username: user.toLowerCase() }, container: { message_ts: ts, channel_id: "C0C6H9M5U4W" }, actions: [{ action_id: actionId, value: intentId }] });

class FakePoster implements SandboxSlackPoster {
  posts: Array<{ destination: SlackDestination; channel: string | null; blocks: any[] }> = [];
  private seen = new Map<string, { channel: string; ts: string }>();
  constructor(private readonly env: Record<string, string | undefined>) {}
  destination(d: SlackDestination) { return resolveSlackDestination(this.env, d); }
  async postBlocks(input: { destination: SlackDestination; text: string; blocks?: any[]; idempotencyKey?: string }) {
    const target = this.destination(input.destination);
    const key = `${target.channel}:${input.idempotencyKey}`;
    if (this.seen.has(key)) return { ok: true as const, duplicate: true, ...this.seen.get(key)!, sandboxRedirected: target.sandboxRedirected };
    const posted = { channel: "C0C6H9M5U4W", ts: `${this.posts.length + 1}.000` };
    this.posts.push({ destination: input.destination, channel: target.channel, blocks: input.blocks ?? [] });
    this.seen.set(key, posted);
    return { ok: true as const, duplicate: false, ...posted, sandboxRedirected: target.sandboxRedirected };
  }
}

type Erp = { jobs: Stage4JobRow[]; artApproved: boolean; routingBlocked: boolean; writes: Array<{ id: string; from: string; to: string; by: string }>; sideEffects: string[] };

function harness(opts: Partial<{ jobs: Stage4JobRow[]; artApproved: boolean; routingBlocked: boolean; config: typeof CFG_OFF; env: Record<string, string | undefined> }> = {}) {
  const erp: Erp = { jobs: opts.jobs ?? [{ id: "job_real_1", shop: "s", jobTicket: STAGE4.ticket, status: "proof_approved" }], artApproved: opts.artApproved ?? true, routingBlocked: opts.routingBlocked ?? false, writes: [], sideEffects: [] };
  const transitionDeps: TransitionDeps = {
    loadJob: async (id) => { const j = erp.jobs.find((x) => x.id === id); return j ? { ...j } : null; },
    loadFacts: async () => ({ artApproved: erp.artApproved, qcPassRecorded: false, shippingRecorded: false, materialReady: undefined, routingDecided: undefined }),
    checkRouting: async () => ({ blocked: erp.routingBlocked, reasons: erp.routingBlocked ? ["GSO-20260510-0004-01: white_gloss_job_but_erp_assigned_mimaki_contradiction"] : [] }),
    applyTransition: async (job, target, intent, actor) => { const row = erp.jobs.find((j) => j.id === job.id)!; erp.writes.push({ id: job.id, from: row.status, to: target, by: `${actor.type}:${actor.id}` }); row.status = target; return { externalReference: `productionJob:${job.id}:${job.status}->${target}` }; },
  };
  const env = opts.env ?? ENV;
  const poster = new FakePoster(env);
  const repos = createMemoryRepositories();
  const deps: Stage4Deps = { repos, config: opts.config ?? CFG_OFF, slackEnv: env, slack: poster, findJobsByTicket: async (t) => erp.jobs.filter((j) => j.jobTicket === t), transitionDeps, now };
  return { erp, deps, poster, repos };
}

async function createAndApprove(h: ReturnType<typeof harness>, runKey = "run-0123456789abcdef") {
  const created = await createStage4Intent(h.deps, runKey, OWNER);
  if (!created.ok) throw new Error(`create failed: ${created.reasons.join("; ")}`);
  const parsed = parseSlackInteraction(click(SLACK_ACTION_IDS.approve, created.intent.id, "U_OWNER"));
  if (!parsed.ok) throw new Error();
  const approved = await handleSlackInteraction(h.repos, parsed.interaction, { envStaffMap: STAFF_MAP, now });
  if (!approved.ok || approved.kind !== "decision" || approved.status !== "APPROVED") throw new Error(JSON.stringify(approved));
  return created.intent;
}

describe("Stage 4 gates and job lock", () => {
  it("create gate: prisma, reasoning off, sandbox true, Slack secrets; execute gate adds execution=true", () => {
    expect(stage4Gate(CFG_OFF, ENV, "create").ok).toBe(true);
    expect(stage4Gate(CFG_OFF, ENV, "execute").ok).toBe(false);
    expect(stage4Gate(CFG_ON, ENV, "execute").ok).toBe(true);
    expect(stage4Gate(readOpsRuntimeConfig({}), ENV, "create").reasons).toContain("prismaRepository failed");
    expect(stage4Gate(readOpsRuntimeConfig({ GSO_OPS_REPOSITORY: "prisma", GSO_AGENT_REASONING_ENABLED: "true" }), ENV, "execute").reasons).toContain("reasoningDisabled failed");
    expect(stage4Gate(CFG_ON, { ...ENV, SLACK_SANDBOX_ONLY: "false" }, "execute").reasons).toContain("sandboxOnlyTrue failed");
    expect(stage4Gate(CFG_OFF, { ...ENV, SLACK_BOT_TOKEN: "" }, "create").reasons).toContain("botTokenPresent failed");
  });

  it("job lock: wrong ticket, missing job, duplicate ticket and wrong status all fail closed", async () => {
    expect((await resolveStage4Job(harness().deps)).ok).toBe(true);
    const wrong = harness({ jobs: [{ id: "x", shop: "s", jobTicket: "GSO-20260510-0005", status: "proof_approved" }] });
    expect(await resolveStage4Job(wrong.deps)).toMatchObject({ ok: false, matches: 0 });
    const missing = harness({ jobs: [] });
    expect(await resolveStage4Job(missing.deps)).toMatchObject({ ok: false, matches: 0 });
    const dup = harness({ jobs: [{ id: "a", shop: "s", jobTicket: STAGE4.ticket, status: "proof_approved" }, { id: "b", shop: "s", jobTicket: STAGE4.ticket, status: "proof_approved" }] });
    expect(await resolveStage4Job(dup.deps)).toMatchObject({ ok: false, matches: 2 });
    const wrongStatus = harness({ jobs: [{ id: "a", shop: "s", jobTicket: STAGE4.ticket, status: "new" }] });
    const r = await resolveStage4Job(wrongStatus.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toMatch(/expected proof_approved/);
    expect(STAGE4.target).toBe("printing"); // the target is a constant, not an input
  });

  it("preflight loads the executor facts and the real guard; a false art fact or a routing block is reported, not invented around", async () => {
    const good = await stage4Preflight(harness().deps);
    expect(good).toMatchObject({ ok: true, currentStatus: "proof_approved", blockers: [] });
    expect(good.facts?.artApproved).toBe(true);
    const noArt = await stage4Preflight(harness({ artApproved: false }).deps);
    expect(noArt.ok).toBe(false);
    expect(noArt.blockers.join(" | ")).toMatch(/art not approved/);
    const routed = await stage4Preflight(harness({ routingBlocked: true }).deps);
    expect(routed.ok).toBe(false);
    expect(routed.blockers.join(" | ")).toMatch(/routing: GSO-20260510-0004-01/);
    const wrongStatus = await stage4Preflight(harness({ jobs: [{ id: "a", shop: "s", jobTicket: STAGE4.ticket, status: "printing" }] }).deps);
    expect(wrongStatus.blockers.join(" | ")).toMatch(/already in that status|not proof_approved/);
  });
});

describe("Stage 4 create + Slack approval", () => {
  it("creates the durable APPROVAL_REQUIRED intent bound to the real job id and posts one SANDBOX / STAGE 4 card to the sandbox only", async () => {
    const h = harness();
    const r = await createStage4Intent(h.deps, "run-0123456789abcdef", OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent).toMatchObject({ actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "job_real_1", autonomyLevel: "APPROVAL_REQUIRED", status: "AWAITING_APPROVAL" });
    expect(r.intent.payload).toMatchObject({ targetStatus: "printing", stage4Test: true, jobTicket: STAGE4.ticket });
    expect(r.intent.reason).toBe(STAGE4.reason);
    expect(h.poster.posts.length).toBe(1);
    expect(h.poster.posts[0].channel).toBe("#gso-agent-sandbox");
    const text = JSON.stringify(h.poster.posts[0].blocks);
    expect(text).toContain("SANDBOX");
    expect(text).toContain("STAGE 4 TEST");
    expect(text).toContain(STAGE4.ticket); // in the header (fact values are PII-redacted)
    expect(text).toContain("proof_approved");
    expect(text).toContain(r.intent.id);
    expect(text).toContain("Execution kill switch");
    expect(text).not.toMatch(/test-token-not-real|test-secret-not-real/);
    expect((await h.repos.intents.listAudit(r.intent.id)).map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "slack_card_posted"]);
    const again = await createStage4Intent(h.deps, "run-0123456789abcdef", OWNER);
    expect(again.ok && again.duplicateIntent && again.slack.duplicate).toBe(true);
    expect((await h.repos.intents.list()).length).toBe(1);
    expect(h.erp.writes.length).toBe(0);
  });

  it("creation refuses on gate, preflight (art/routing/status) and bad run key without creating anything", async () => {
    expect(await createStage4Intent(harness({ config: readOpsRuntimeConfig({}) }).deps, "run-0123456789abcdef", OWNER)).toMatchObject({ ok: false, stage: "gate" });
    const noArt = harness({ artApproved: false });
    expect(await createStage4Intent(noArt.deps, "run-0123456789abcdef", OWNER)).toMatchObject({ ok: false, stage: "preflight" });
    expect((await noArt.repos.intents.list()).length).toBe(0);
    expect(noArt.poster.posts.length).toBe(0);
    expect(await createStage4Intent(harness({ routingBlocked: true }).deps, "run-0123456789abcdef", OWNER)).toMatchObject({ ok: false, stage: "preflight" });
    expect(await createStage4Intent(harness({ jobs: [] }).deps, "run-0123456789abcdef", OWNER)).toMatchObject({ ok: false, stage: "preflight" });
    expect(await createStage4Intent(harness().deps, "x", OWNER)).toMatchObject({ ok: false, stage: "runKey" });
  });

  it("Slack approval alone never executes; unmapped users are refused; the approved intent is blocked while execution is off", async () => {
    const h = harness();
    const created = await createStage4Intent(h.deps, "run-0123456789abcdef", OWNER);
    if (!created.ok) throw new Error();
    const stranger = parseSlackInteraction(click(SLACK_ACTION_IDS.approve, created.intent.id, "U_STRANGER"));
    if (!stranger.ok) throw new Error();
    expect((await handleSlackInteraction(h.repos, stranger.interaction, { envStaffMap: STAFF_MAP, now })).ok).toBe(false);
    const intent = await createAndApprove(h);
    expect((await h.repos.intents.getById(intent.id))?.status).toBe("APPROVED");
    expect(h.erp.writes.length).toBe(0);
    expect(h.erp.jobs[0].status).toBe("proof_approved");
    const blocked = await executeStage4(h.deps, intent.id, OWNER);
    expect(blocked).toMatchObject({ ok: false, stage: "gate" });
    expect((blocked as any).reasons).toContain("executionEnabled failed");
    expect(h.erp.writes.length).toBe(0);
    expect((await findStage4Intents(h.repos, "job_real_1")).map((i) => i.status)).toEqual(["APPROVED"]);
  });
});

describe("Stage 4 execution", () => {
  it("approved valid intent executes exactly once through the executor; second execute is a no-op; audit records approver and executor", async () => {
    const h = harness();
    const intent = await createAndApprove(h);
    const on = { ...h.deps, config: CFG_ON };
    const first = await executeStage4(on, intent.id, OWNER);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(first.ok && first.outcome).toMatchObject({ ok: true, from: "proof_approved", to: "printing", externalReference: "productionJob:job_real_1:proof_approved->printing" });
    expect(h.erp.jobs[0].status).toBe("printing");
    expect(h.erp.writes).toEqual([{ id: "job_real_1", from: "proof_approved", to: "printing", by: "staff:owner@example.com" }]);
    const second = await executeStage4(on, intent.id, OWNER);
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(h.erp.writes.length).toBe(1);
    const stored = await h.repos.intents.getById(intent.id);
    expect(stored?.status).toBe("COMPLETED");
    expect(stored?.approvedBy).toMatchObject({ type: "owner", id: "owner", source: "slack:U_OWNER" });
    const audit = await h.repos.intents.listAudit(intent.id);
    expect(audit.map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "slack_card_posted", "approved", "executing", "completed"]);
    expect(audit.at(-1)).toMatchObject({ previousStatus: "EXECUTING", newStatus: "COMPLETED", executionResult: "completed", externalReference: "productionJob:job_real_1:proof_approved->printing" });
    expect(audit.at(-1)?.actor).toMatchObject({ type: "staff", id: "owner@example.com" });
    expect(h.erp.sideEffects).toEqual([]); // no money, customer or inventory paths exist to be invoked
  });

  it("execution refuses: unapproved intent, absent intent, wrong entity, wrong target, non-Stage-4 intent, reasoning on, memory repo, sandbox off, wrong current status, guard failure, routing block", async () => {
    const h = harness();
    const created = await createStage4Intent(h.deps, "run-0123456789abcdef", OWNER);
    if (!created.ok) throw new Error();
    const on = { ...h.deps, config: CFG_ON };
    expect(await executeStage4(on, created.intent.id, OWNER)).toMatchObject({ ok: false, stage: "intent" }); // AWAITING_APPROVAL
    expect(await executeStage4(on, "ai_00000000_0", OWNER)).toMatchObject({ ok: false, stage: "intent", intentId: null });
    expect(await executeStage4({ ...on, config: readOpsRuntimeConfig({ GSO_OPS_REPOSITORY: "prisma", GSO_AGENT_EXECUTION_ENABLED: "true", GSO_AGENT_REASONING_ENABLED: "true" }) }, created.intent.id, OWNER)).toMatchObject({ ok: false, stage: "gate" });
    expect(await executeStage4({ ...on, config: readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" }) }, created.intent.id, OWNER)).toMatchObject({ ok: false, stage: "gate" });
    expect(await executeStage4({ ...on, slackEnv: { ...ENV, SLACK_SANDBOX_ONLY: "false" } }, created.intent.id, OWNER)).toMatchObject({ ok: false, stage: "gate" });
    // approve, then break the world in different ways
    const intent = await createAndApprove(h, "run-fedcba9876543210");
    // wrong entity: an approved move intent for a different job id
    const other = await h.repos.intents.getById(intent.id);
    const foreign = { ...other!, id: "ai_feedfeed_1", idempotencyKey: "foreign", entityId: "job_other", payload: { ...other!.payload } };
    await h.repos.intents.save(foreign);
    expect(await executeStage4(on, foreign.id, OWNER)).toMatchObject({ ok: false, stage: "intent", reasons: ["intent entity does not match the loaded job"] });
    const wrongTarget = { ...other!, id: "ai_feedfeed_2", idempotencyKey: "wt", payload: { ...other!.payload, targetStatus: "shipped" } };
    await h.repos.intents.save(wrongTarget);
    expect((await executeStage4(on, wrongTarget.id, OWNER) as any).reasons.join()).toMatch(/intent target is shipped/);
    const notStage4 = { ...other!, id: "ai_feedfeed_3", idempotencyKey: "ns", payload: { targetStatus: "printing" } };
    await h.repos.intents.save(notStage4);
    expect((await executeStage4(on, notStage4.id, OWNER) as any).reasons.join()).toMatch(/not a Stage 4 intent/);
    // wrong current status
    h.erp.jobs[0].status = "new";
    expect(await executeStage4(on, intent.id, OWNER)).toMatchObject({ ok: false, stage: "job" });
    h.erp.jobs[0].status = "proof_approved";
    // real guard failure (art fact false at execution time) and routing block — both refused by the executor, nothing written
    h.erp.artApproved = false;
    expect(await executeStage4(on, intent.id, OWNER)).toMatchObject({ ok: false, stage: "executor", outcome: { stage: "guard" } });
    h.erp.artApproved = true; h.erp.routingBlocked = true;
    expect(await executeStage4(on, intent.id, OWNER)).toMatchObject({ ok: false, stage: "executor", outcome: { stage: "routing" } });
    expect(h.erp.writes.length).toBe(0);
    expect(h.erp.jobs[0].status).toBe("proof_approved");
    // a rejected intent can never execute
    h.erp.routingBlocked = false;
    const rejected = await createStage4Intent(h.deps, "run-00000000rejected", OWNER);
    if (!rejected.ok) throw new Error();
    await decideIntent(h.repos.intents, rejected.intent.id, "REJECT", { type: "owner", id: "owner", role: "owner" }, undefined, now);
    expect((await executeStage4(on, rejected.intent.id, OWNER) as any).reasons.join()).toMatch(/CANCELLED/);
  });

  it("Stage 4 and hub code never write ProductionJob directly or use the legacy changeStatus handler", () => {
    const stage4 = readFileSync(new URL("../app/lib/ops/stage4-test-transition.ts", import.meta.url), "utf8");
    for (const forbidden of ["db.server", "productionJob.update", "prisma.", "changeStatus", "processOutboxBatch", "@openai/agents", "executeIntent("]) expect(stage4, `stage4 module must not reference ${forbidden}`).not.toContain(forbidden);
    expect(stage4).toContain("requestProductionTransition(");
    const hub = readFileSync(new URL("../app/routes/app.erp.ops-hub.tsx", import.meta.url), "utf8");
    expect(hub).not.toMatch(/productionJob\.update|changeStatus|requestProductionTransition\(/);
    expect(hub).toMatch(/db\.productionJob\.findMany\(\{ where: \{ shop, jobTicket: ticket \}/); // read-only lookup by ticket only
    const actionBody = hub.slice(hub.indexOf("export async function action"));
    expect(actionBody.indexOf("await authenticate.admin(request)")).toBeLessThan(actionBody.indexOf("formData"));
  });

  it("the Prisma fact loader counts the staff proof_approved event or portal approval as art approval, never a bare status string", async () => {
    const mk = (row: any) => prismaTransitionDeps({ productionJob: { findFirst: async () => ({ files: [], ...row }) } }, "shop");
    const job = { id: "j", shop: "shop", jobTicket: STAGE4.ticket, status: "proof_approved" };
    const at = new Date("2026-05-11T01:04:05.659Z");
    expect((await mk({ proofStatus: "draft", proofApprovedAt: null, checklistItems: [], events: [{ eventType: "proof_approved", newValue: null, createdAt: at }] }).loadFacts(job, "printing")).artApproved).toBe(true);
    expect((await mk({ proofStatus: "approved", proofApprovedAt: at, checklistItems: [], events: [] }).loadFacts(job, "printing")).artApproved).toBe(true);
    expect((await mk({ proofStatus: "draft", proofApprovedAt: null, checklistItems: [], events: [{ eventType: "status_change", newValue: "proof_approved", createdAt: at }] }).loadFacts(job, "printing")).artApproved).toBe(false);
    expect((await mk({ proofStatus: "approved", proofApprovedAt: null, checklistItems: [], events: [] }).loadFacts(job, "printing")).artApproved).toBe(false);
    // stale: approval predates a newer proof revision
    expect((await mk({ proofStatus: "draft", proofApprovedAt: null, checklistItems: [], files: [{ createdAt: new Date("2026-05-12T00:00:00Z") }], events: [{ eventType: "proof_approved", newValue: null, createdAt: at }] }).loadFacts(job, "printing")).artApproved).toBe(false);
  });
});
