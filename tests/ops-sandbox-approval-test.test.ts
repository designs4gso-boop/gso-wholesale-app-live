// Stage 3 durable Slack approval bridge — offline tests. Memory repositories
// stand in for the repository abstraction; a fake poster stands in for the
// Slack client. No database, no network, no live Slack.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { executeIntent, isConsequential } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";
import { SANDBOX_TEST_ENTITY_ID, createSandboxApprovalTest, groupIntentsForHub, sandboxApprovalTestGate, type SandboxSlackPoster } from "../app/lib/ops/sandbox-approval-test";
import { SLACK_ACTION_IDS } from "../app/lib/slack/slack-blocks";
import { parseStaffMap, resolveSlackDestination, type SlackDestination } from "../app/lib/slack/slack-config";
import { handleSlackInteraction, parseSlackInteraction } from "../app/lib/slack/slack-interactions";

const now = new Date("2026-10-04T18:00:00Z");
const GOOD_ENV = { SLACK_BOT_TOKEN: "test-token-not-real", SLACK_SIGNING_SECRET: "test-secret-not-real", SLACK_TEST_CHANNEL: "gso-agent-sandbox", SLACK_SANDBOX_ONLY: "true", SLACK_CHANNEL_PRODUCTION: "C0REALPROD" };
const GOOD_CONFIG = readOpsRuntimeConfig({ GSO_OPS_REPOSITORY: "prisma" });

class FakePoster implements SandboxSlackPoster {
  posts: Array<{ destination: SlackDestination; channel: string | null; text: string; blocks: any[] }> = [];
  private seen = new Map<string, { channel: string; ts: string }>();
  constructor(private readonly env: Record<string, string | undefined>, private readonly fail = false) {}
  destination(d: SlackDestination) { return resolveSlackDestination(this.env, d); }
  async postBlocks(input: { destination: SlackDestination; text: string; blocks?: any[]; idempotencyKey?: string }) {
    if (this.fail) return { ok: false as const, error: "channel_not_found" };
    const target = this.destination(input.destination);
    const key = `${target.channel}:${input.idempotencyKey}`;
    if (this.seen.has(key)) return { ok: true as const, duplicate: true, ...this.seen.get(key)!, sandboxRedirected: target.sandboxRedirected };
    const posted = { channel: "C0C6H9M5U4W", ts: `${this.posts.length + 1}.000` };
    this.posts.push({ destination: input.destination, channel: target.channel, text: input.text, blocks: input.blocks ?? [] });
    this.seen.set(key, posted);
    return { ok: true as const, duplicate: false, ...posted, sandboxRedirected: target.sandboxRedirected };
  }
}

function harness(envOverride: Record<string, string | undefined> = {}, configEnv: Record<string, string | undefined> = { GSO_OPS_REPOSITORY: "prisma" }, fail = false) {
  const repos = createMemoryRepositories();
  const env = { ...GOOD_ENV, ...envOverride };
  const poster = new FakePoster(env, fail);
  const config = readOpsRuntimeConfig(configEnv);
  const run = (runKey = "run-0123456789abcdef") => createSandboxApprovalTest({ repos, config, slackEnv: env, slack: poster, runKey, requestedBy: { id: "owner@example.com", name: "Owner" }, now });
  return { repos, poster, config, env, run };
}

describe("runtime gate (fail closed)", () => {
  it("passes only when every requirement holds", () => {
    expect(sandboxApprovalTestGate(GOOD_CONFIG, GOOD_ENV).ok).toBe(true);
  });
  it("memory repository mode refuses", async () => {
    const g = sandboxApprovalTestGate(readOpsRuntimeConfig({}), GOOD_ENV);
    expect(g.ok).toBe(false);
    expect(g.reasons.join()).toMatch(/not prisma/);
    const h = harness({}, {});
    expect(await h.run()).toMatchObject({ ok: false, stage: "gate" });
    expect((await h.repos.intents.list()).length).toBe(0);
    expect(h.poster.posts.length).toBe(0);
  });
  it("SLACK_SANDBOX_ONLY=false or unset refuses", () => {
    expect(sandboxApprovalTestGate(GOOD_CONFIG, { ...GOOD_ENV, SLACK_SANDBOX_ONLY: "false" }).reasons.join()).toMatch(/SANDBOX_ONLY/);
    expect(sandboxApprovalTestGate(GOOD_CONFIG, { ...GOOD_ENV, SLACK_SANDBOX_ONLY: undefined }).ok).toBe(false);
  });
  it("execution=true refuses", async () => {
    const h = harness({}, { GSO_OPS_REPOSITORY: "prisma", GSO_AGENT_EXECUTION_ENABLED: "true" });
    const r = await h.run();
    expect(r).toMatchObject({ ok: false, stage: "gate" });
    expect((r as any).reasons.join()).toMatch(/EXECUTION_ENABLED is true/);
    expect((await h.repos.intents.list()).length).toBe(0);
  });
  it("missing bot token, signing secret or test channel refuses", () => {
    expect(sandboxApprovalTestGate(GOOD_CONFIG, { ...GOOD_ENV, SLACK_BOT_TOKEN: "" }).reasons.join()).toMatch(/BOT_TOKEN/);
    expect(sandboxApprovalTestGate(GOOD_CONFIG, { ...GOOD_ENV, SLACK_SIGNING_SECRET: undefined }).reasons.join()).toMatch(/SIGNING_SECRET/);
    expect(sandboxApprovalTestGate(GOOD_CONFIG, { ...GOOD_ENV, SLACK_TEST_CHANNEL: " " }).reasons.join()).toMatch(/TEST_CHANNEL/);
  });
  it("the hub action authenticates before anything else and the route exposes no unauthenticated test path", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.ops-hub.tsx", import.meta.url), "utf8");
    const actionBody = src.slice(src.indexOf("export async function action"));
    expect(actionBody.indexOf("await authenticate.admin(request)")).toBeGreaterThan(0);
    expect(actionBody.indexOf("await authenticate.admin(request)")).toBeLessThan(actionBody.indexOf("formData"));
    expect(src).not.toMatch(/api\/ops\/sandbox|public/);
    expect(src).toMatch(/runKey: crypto\.randomUUID\(\)/); // server-generated run key
  });
});

describe("synthetic intent + sandbox card", () => {
  it("creates an APPROVAL_REQUIRED intent in AWAITING_APPROVAL, durable through the repository, and posts one SANDBOX card to the sandbox channel only", async () => {
    const h = harness();
    const r = await h.run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent).toMatchObject({ actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: SANDBOX_TEST_ENTITY_ID, autonomyLevel: "APPROVAL_REQUIRED", status: "AWAITING_APPROVAL" });
    expect(r.intent.payload).toMatchObject({ targetStatus: "printing", sandboxTest: true });
    const stored = await h.repos.intents.getById(r.intent.id);
    expect(stored?.status).toBe("AWAITING_APPROVAL");
    expect((await h.repos.intents.listAudit(r.intent.id)).map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "slack_card_posted"]);
    expect(h.poster.posts.length).toBe(1);
    expect(h.poster.posts[0].destination).toBe("production");
    expect(h.poster.posts[0].channel).toBe("#gso-agent-sandbox"); // NOT C0REALPROD
    const text = JSON.stringify(h.poster.posts[0].blocks);
    expect(text).toContain("SANDBOX");
    expect(text).toContain("Stage 3 Durable Approval Test");
    expect(text).toContain(r.intent.id);
    expect(text).toContain("no ERP mutation possible");
    for (const id of [SLACK_ACTION_IDS.approve, SLACK_ACTION_IDS.reject, SLACK_ACTION_IDS.requestChanges, SLACK_ACTION_IDS.openErp]) expect(text).toContain(id);
    expect(text).not.toMatch(/test-token-not-real|test-secret-not-real/);
  });

  it("the same run key never creates a second intent or a second card; a new run key does", async () => {
    const h = harness();
    const a = await h.run("run-0123456789abcdef");
    const b = await h.run("run-0123456789abcdef");
    const c = await h.run("run-fedcba9876543210");
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.intent.id).toBe(a.intent.id);
    expect(b.duplicateIntent && b.slack.duplicate).toBe(true);
    expect(c.intent.id).not.toBe(a.intent.id);
    expect((await h.repos.intents.list()).length).toBe(2);
    expect(h.poster.posts.length).toBe(2);
    expect(await h.run("short")).toMatchObject({ ok: false, stage: "runKey" });
  });

  it("refuses to post when the destination would not land in the sandbox, and reports Slack failures without losing the intent", async () => {
    const h = harness();
    // destination resolves outside sandbox only if sandbox-only were false — the gate already refuses that; prove the destination check independently:
    const badPoster = new FakePoster({ ...GOOD_ENV, SLACK_SANDBOX_ONLY: "false" });
    const r = await createSandboxApprovalTest({ repos: h.repos, config: h.config, slackEnv: GOOD_ENV, slack: badPoster, runKey: "run-0123456789abcdef", requestedBy: { id: "o" }, now });
    expect(r).toMatchObject({ ok: false, stage: "destination" });
    expect(badPoster.posts.length).toBe(0);
    const failing = harness({}, { GSO_OPS_REPOSITORY: "prisma" }, true);
    const f = await failing.run();
    expect(f).toMatchObject({ ok: false, stage: "slack", reasons: ["channel_not_found"] });
    expect((await failing.repos.intents.list()).length).toBe(1); // intent stays awaiting; nothing executed
  });

  it("never touches a ProductionJob write path or the executor", () => {
    const src = readFileSync(new URL("../app/lib/ops/sandbox-approval-test.ts", import.meta.url), "utf8");
    for (const forbidden of ["requestProductionTransition", "productionJob", "prismaTransitionDeps", "processOutboxBatch", "executeIntent", "db.server", "@openai/agents"]) expect(src, `must not reference ${forbidden}`).not.toContain(forbidden);
  });
});

describe("approval through the existing Slack interaction path", () => {
  const click = (actionId: string, intentId: string, user: string, ts = "1.000") => ({ type: "block_actions", user: { id: user, username: user.toLowerCase() }, container: { message_ts: ts, channel_id: "C0C6H9M5U4W" }, actions: [{ action_id: actionId, value: intentId }] });

  it("unmapped user refused; mapped owner approves durably; duplicate click is a replay; approved intent stays unexecuted and shows as blocked", async () => {
    const h = harness();
    const r = await h.run();
    if (!r.ok) throw new Error("setup");
    const staffMap = parseStaffMap(JSON.stringify({ U_OWNER: { staffId: "owner", name: "Owner", role: "owner" } }));
    const stranger = parseSlackInteraction(click(SLACK_ACTION_IDS.approve, r.intent.id, "U_STRANGER"));
    if (!stranger.ok) throw new Error();
    expect((await handleSlackInteraction(h.repos, stranger.interaction, { envStaffMap: staffMap, now })).ok).toBe(false);
    expect((await h.repos.intents.getById(r.intent.id))?.status).toBe("AWAITING_APPROVAL");

    const owner = parseSlackInteraction(click(SLACK_ACTION_IDS.approve, r.intent.id, "U_OWNER", "2.000"));
    if (!owner.ok) throw new Error();
    const first = await handleSlackInteraction(h.repos, owner.interaction, { envStaffMap: staffMap, now });
    expect(first).toMatchObject({ ok: true, kind: "decision", decision: "APPROVE", status: "APPROVED", duplicate: false, approver: "Owner" });
    const stored = await h.repos.intents.getById(r.intent.id);
    expect(stored?.status).toBe("APPROVED");
    expect(stored?.approvedBy).toMatchObject({ type: "owner", id: "owner", source: "slack:U_OWNER" });
    const audit = await h.repos.intents.listAudit(r.intent.id);
    expect(audit.map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "slack_card_posted", "approved"]);

    const second = await handleSlackInteraction(h.repos, owner.interaction, { envStaffMap: staffMap, now });
    expect(second).toMatchObject({ ok: true, kind: "replay" });
    expect((await h.repos.intents.listAudit(r.intent.id)).length).toBe(5); // no second decision row
    expect((await h.repos.events.get("slack", owner.interaction.externalId))?.status).toBe("COMPLETED");

    // Execution remains impossible: the kill switch is off and nothing calls the executor.
    const exec = await executeIntent(h.repos.intents, r.intent.id, async () => { throw new Error("must not run"); }, { now, gate: { executionEnabled: h.config.executionEnabled } });
    expect(exec.ok).toBe(false);
    expect((exec as any).blockedByKillSwitch).toBe(true);
    expect((await h.repos.intents.getById(r.intent.id))?.status).toBe("APPROVED");

    const grouped = groupIntentsForHub(await h.repos.intents.list(), h.config, isConsequential);
    expect(grouped.pending.length).toBe(0);
    expect(grouped.blocked.map((i) => i.id)).toEqual([r.intent.id]);
    expect(grouped.completed.length).toBe(0);
  });

  it("hub grouping shows the intent as pending before approval", async () => {
    const h = harness();
    const r = await h.run();
    if (!r.ok) throw new Error("setup");
    const grouped = groupIntentsForHub(await h.repos.intents.list(), h.config, isConsequential);
    expect(grouped.pending.map((i) => i.id)).toEqual([r.intent.id]);
    expect(grouped.blocked.length).toBe(0);
  });
});
