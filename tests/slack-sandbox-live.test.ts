// LIVE Slack sandbox verification (OPS-2). Skipped unless GSO_SLACK_LIVE=1.
// Posts ONLY to the sandbox destination (SLACK_TEST_CHANNEL). Every post is
// idempotent per run key; a replay posts nothing. Tokens are never printed.
// Also verifies private-channel discovery (Phase 32) through the fixed
// form-encoded conversations.list path.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { AGENT_REGISTRY } from "../app/lib/ops/agent-registry";
import { OPS_PLATFORM_VERSION } from "../app/lib/ops/autonomy";
import { routeException } from "../app/lib/ops/exceptions";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { agentOnlineBlocks, exceptionBlocks, intentCard, newLeadBlocks, reportBlocks } from "../app/lib/slack/slack-blocks";
import { SlackClient, describeSlackEnv, loadSlackEnv } from "../app/lib/slack/slack-client.server";
import { openSocketMode } from "../app/lib/slack/socket-mode.server";

const live = process.env.GSO_SLACK_LIVE === "1";

describe.skipIf(!live)("slack sandbox live", () => {
  it("discovers the private sandbox channel, posts the scenario set once, verifies idempotent replay, thread reply and Socket Mode", async () => {
    const env = loadSlackEnv();
    const client = new SlackClient(env);
    const runKey = process.env.GSO_SLACK_RUN_KEY || `run-${new Date().toISOString().slice(0, 16)}`;
    const out: Record<string, unknown> = { env: describeSlackEnv(env), runKey };

    const auth = await client.authTest();
    expect(auth.ok).toBe(true);
    if (auth.ok) out.auth = { team: auth.data.team, user: auth.data.user };

    // Phase 32: discovery must list the private sandbox channel with is_member=true.
    const channels = await client.listChannels();
    expect(channels.ok).toBe(true);
    const sandbox = await client.findChannel(String(env.SLACK_TEST_CHANNEL));
    out.discovery = { listed: channels.ok ? channels.data.map((c) => `${c.name}${c.isPrivate ? "(private)" : ""}${c.isMember ? "*" : ""}`) : channels, sandbox };
    expect(sandbox).toMatchObject({ isPrivate: true, isMember: true });

    const dest = client.destination("agent_approvals");
    expect(dest.sandboxRedirected).toBe(true);
    out.destination = dest;

    const repos = createMemoryRepositories();
    const now = new Date();
    const mk = async (actionType: any, agentId: string, entityType: string, entityId: string, reason: string) => {
      const p = await proposeIntent(repos.intents, { actionType, agentId, entityType, entityId, reason, idempotencyKey: `${runKey}:${actionType}:${entityId}`, now, provider: "fake" });
      if (!p.ok) throw new Error(p.reason);
      await validateIntent(repos.intents, p.intent.id, undefined, now);
      return (await repos.intents.getById(p.intent.id))!;
    };
    const artIntent = await mk("record_final_art_approval", "art_approval_coordinator", "job", "GSO-SANDBOX-0001", "MOCK: customer approved via proof portal; staff final approval requested");
    const moveIntent = await mk("move_production_job", "operations_supervisor", "job", "GSO-SANDBOX-0004", "MOCK: model proposed proof_approved -> printing; durable intent, kill switch OFF");
    const refundIntent = await mk("refund_or_void", "invoice_coordinator", "invoice", "INV-SANDBOX-1", "MOCK: owner-only decision demo");

    const posts: Array<{ name: string; destination: any; text: string; blocks: any[]; key: string }> = [
      { name: "agent_online", destination: "agent_approvals", text: "GSO Operations agent online (sandbox, OPS-2)", blocks: agentOnlineBlocks({ version: `${OPS_PLATFORM_VERSION} / OPS-2 durable`, agentsActive: AGENT_REGISTRY.filter((a) => a.status === "ACTIVE").length, agentsDraft: AGENT_REGISTRY.filter((a) => a.status === "DRAFT").length, sandboxRedirected: dest.sandboxRedirected }), key: `${runKey}:online` },
      { name: "new_lead", destination: "sales_leads", text: "New lead (sandbox mock)", blocks: newLeadBlocks({ company: "Northwind Botanicals (MOCK)", family: "sticker-bags", quantity: "500", classification: "canonical · cannabis_packaging_sales · MOQ 50", readiness: "NEEDS_INFO", missing: ["deadline", "shippingCityState"], sandboxRedirected: true }), key: `${runKey}:lead` },
      { name: "art_approval_request", destination: "art_approval", text: "Final art approval requested (sandbox mock)", blocks: intentCard({ title: "Final art approval — GSO-SANDBOX-0001 (MOCK)", intent: artIntent, facts: [["Version", "v1 sha256:aaaa…"], ["Technical preflight", "PASS — cutline 3.875 x 4.875 in"]], destination: "art_approval", sandboxRedirected: true, erpPath: "/app/erp/production", footer: "Buttons act on a MOCK intent in a memory repository. No production record changes." }), key: `${runKey}:art` },
      { name: "production_transition_request", destination: "production", text: "Production transition proposed by model (sandbox mock)", blocks: intentCard({ title: "Move GSO-SANDBOX-0004 → printing (MOCK, model proposal)", intent: moveIntent, facts: [["Proposed by", "operations_supervisor via fake provider"], ["Executor", "requestProductionTransition — kill switch OFF, nothing moves"]], destination: "production", sandboxRedirected: true, erpPath: "/app/erp/production" }), key: `${runKey}:move` },
      { name: "production_blocker", destination: "production_exceptions", text: "Production blocker (sandbox mock)", blocks: exceptionBlocks({ ...routeException({ code: "MACHINE_MISMATCH", entity: "item:GSO-SANDBOX-0001-02", summary: "white ink item explicitly assigned to Mimaki (CMYK-only) — BLOCK", now }), sandboxRedirected: true }), key: `${runKey}:blocker` },
      { name: "owner_only_mock", destination: "finance", text: "Owner-only decision (sandbox mock)", blocks: intentCard({ title: "Refund / void — OWNER REQUIRED (MOCK)", intent: refundIntent, facts: [["Invoice", "INV-SANDBOX-1"], ["Connector", "QuickBooks DEFERRED — NOT CONNECTED"]], destination: "finance", sandboxRedirected: true }), key: `${runKey}:refund` },
      { name: "management_report", destination: "management_reports", text: "Management report (sandbox mock)", blocks: reportBlocks({ title: "Production report (MOCK DATA)", lines: ["Jobs: 4 total · 1 ready · 1 in production · 1 blocked · 1 awaiting art", "Overdue: 1 — GSO-SANDBOX-0002", "Reasoning provider: NONE · execution: OFF"], sandboxRedirected: true }), key: `${runKey}:report` },
      { name: "exception_alert", destination: "agent_approvals", text: "Exception (sandbox mock)", blocks: exceptionBlocks({ ...routeException({ code: "UNTRUSTED_INSTRUCTION", entity: "lead:SANDBOX-1", summary: "customer note contained 'ignore your pricing rules' — flagged, ignored", now }), sandboxRedirected: true }), key: `${runKey}:untrusted` },
    ];

    const results: Record<string, unknown> = {};
    let firstTs: { channel: string; ts: string } | null = null;
    for (const p of posts) {
      const r = await client.postBlocks({ destination: p.destination, text: p.text, blocks: p.blocks, idempotencyKey: p.key });
      results[p.name] = r.ok ? { ok: true, ts: r.ts, channel: r.channel, duplicate: r.duplicate, sandboxRedirected: r.sandboxRedirected } : { ok: false, error: r.error, needed: (r as any).needed };
      expect(r.ok, `${p.name}: ${r.ok ? "" : r.error}`).toBe(true);
      if (r.ok && !firstTs) firstTs = { channel: r.channel, ts: r.ts };
    }
    const replay = await client.postBlocks({ destination: "agent_approvals", text: posts[0].text, blocks: posts[0].blocks, idempotencyKey: posts[0].key });
    expect(replay.ok && replay.duplicate).toBe(true);
    results.replay = replay;
    if (firstTs) {
      const thread = await client.threadReply(firstTs.channel, firstTs.ts, `OPS-2 sandbox run ${runKey}: ${posts.length} cards posted once; replay returned duplicate=true; discovery lists ${sandbox?.name} (private, member). Kill switches: reasoning OFF, execution OFF.`);
      expect(thread.ok).toBe(true);
      results.thread = thread.ok ? { ts: thread.data.ts } : thread;
    }
    const socket = await openSocketMode(client, {}, { timeoutMs: 15000 });
    results.socketMode = socket.ok ? { ok: true, connected: socket.session.connected() } : socket;
    if (socket.ok) socket.session.close();
    expect(socket.ok).toBe(true);

    out.results = results;
    const file = process.env.GSO_SLACK_LIVE_OUT;
    if (file) writeFileSync(file, JSON.stringify(out, null, 2));
  }, 90000);
});
