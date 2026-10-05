// Staff Operations Hub (OPS-2 / Stage 3 / Stage 4 / Stage 5).
//
// Daily operations view of the agent platform with a global safety header,
// plus owner-authenticated release-test controls kept in a collapsed
// "SANDBOX / RELEASE TEST TOOLS" section:
//   Stage 3: create a SYNTHETIC durable ActionIntent and post its sandbox card.
//   Stage 4: for ONE locked TEST ticket, create a real durable intent (after a
//            real preflight), and — separately — execute an APPROVED intent
//            through the centralized transition executor only.
// Never touches a ProductionJob directly, never uses the legacy status form
// handler, refuses unless every runtime gate holds. No secrets, no prompts,
// no customer PII beyond entity ids.

import crypto from "node:crypto";

import { Badge, BlockStack, Button, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { auditSummary, isConsequential, type Actor } from "../lib/ops/action-intents";
import { AGENT_REGISTRY, AGENT_REGISTRY_VERSION, permissionMatrix } from "../lib/ops/agent-registry";
import { ACTION_TYPES, OPS_PLATFORM_VERSION } from "../lib/ops/autonomy";
import { describeRepositoryDurability, getOpsRepositories } from "../lib/ops/intent-store.server";
import { prismaTransitionDeps } from "../lib/ops/production-transition-executor.server";
import { describeOpsRuntime, readOpsRuntimeConfig } from "../lib/ops/runtime-config";
import { createSandboxApprovalTest, groupIntentsForHub, sandboxApprovalTestGate } from "../lib/ops/sandbox-approval-test";
import { runCompanyFlowSimulation } from "../lib/ops/simulator.server";
import { STAGE4, createStage4Intent, executeStage4, findStage4Intents, stage4Gate, stage4Preflight, type Stage4Deps } from "../lib/ops/stage4-test-transition";
import { workerDiagnostics } from "../lib/ops/worker-runtime.server";
import { SPECIALISTS } from "../lib/reasoning/specialists";
import { SlackClient, describeSlackEnv, loadSlackEnv } from "../lib/slack/slack-client.server";

function stage4Deps(shop: string): Stage4Deps {
  const slackEnv = loadSlackEnv();
  return {
    repos: getOpsRepositories(),
    config: readOpsRuntimeConfig(),
    slackEnv,
    slack: new SlackClient(slackEnv),
    // Authoritative lookup: by ticket within the shop. 0 or >1 rows fail closed downstream.
    findJobsByTicket: (ticket) => db.productionJob.findMany({ where: { shop, jobTicket: ticket }, select: { id: true, shop: true, jobTicket: true, status: true } }),
    transitionDeps: prismaTransitionDeps(db, shop),
  };
}

/** Same shape other ERP routes use for the acting staff member (session fields are optional on the Shopify Session type). */
function actorFromSession(session: any): { id: string; name?: string } {
  return { id: String(session?.email || session?.shop || "staff"), name: [session?.firstName, session?.lastName].filter(Boolean).join(" ").trim() || undefined };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const config = readOpsRuntimeConfig();
  const slackEnv = loadSlackEnv();
  const repos = getOpsRepositories();
  const intents = (await repos.intents.list({ limit: 200 })).map(auditSummary);
  const pausedRuns = await repos.runs.listByStatus("PAUSED_FOR_APPROVAL");
  const worker = await workerDiagnostics(repos, config);
  const sim = await runCompanyFlowSimulation();
  const gate = sandboxApprovalTestGate(config, slackEnv);
  const s4 = stage4Deps(session.shop);
  const preflight = await stage4Preflight(s4);
  const stage4Intents = preflight.job ? (await findStage4Intents(repos, preflight.job.id)).map(auditSummary) : [];
  const executable = stage4Intents.find((i) => i.status === "APPROVED") ?? null;
  const runtime = describeOpsRuntime(config);
  const slack = describeSlackEnv(slackEnv);
  const dangerous: string[] = [];
  if (runtime.executionEnabled === "YES") dangerous.push("Execution switch is ON — approved consequential intents can execute through owner actions");
  if (runtime.reasoningEnabled === "YES") dangerous.push("Reasoning switch is ON — a model may be consulted");
  if (slack.sandboxOnly !== "true") dangerous.push("Slack sandbox-only is OFF — cards could reach real channels");
  if (config.repository !== "prisma") dangerous.push("Repository is in-memory — intents are not durable");
  return {
    platformVersion: OPS_PLATFORM_VERSION,
    registryVersion: AGENT_REGISTRY_VERSION,
    runtime,
    durability: describeRepositoryDurability(),
    slack,
    dangerous,
    worker,
    agents: AGENT_REGISTRY.map((a) => ({ id: a.id, name: a.name, status: a.status, purpose: a.purpose, reasoning: Object.values(SPECIALISTS).some((s) => s.agentId === a.id) ? "model-capable (provider-gated)" : "deterministic" })),
    matrix: permissionMatrix(),
    actions: ACTION_TYPES,
    grouped: groupIntentsForHub(intents, config, isConsequential),
    pausedRuns: pausedRuns.map((r) => ({ id: r.id, agentId: r.agentId, provider: r.provider, intentId: r.intentId, updatedAt: r.updatedAt })),
    simulation: { passed: sim.assertions.filter((a) => a.ok).length, total: sim.assertions.length, failures: sim.assertions.filter((a) => !a.ok).map((f) => f.name) },
    sandboxTest: { gate, runKey: crypto.randomUUID() },
    stage4: {
      ticket: STAGE4.ticket, from: STAGE4.from, target: STAGE4.target,
      createGate: stage4Gate(config, slackEnv, "create"),
      executeGate: stage4Gate(config, slackEnv, "execute"),
      preflight: { ...preflight, job: preflight.job ? { id: preflight.job.id, status: preflight.job.status } : null },
      intents: stage4Intents,
      executableIntentId: executable?.id ?? null,
      runKey: crypto.randomUUID(),
    },
  };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intentName = String(formData.get("intent"));
  const config = readOpsRuntimeConfig();
  const slackEnv = loadSlackEnv();
  const requestedBy = actorFromSession(session);

  if (intentName === "createSandboxApprovalTest") {
    const result = await createSandboxApprovalTest({ repos: getOpsRepositories(), config, slackEnv, slack: new SlackClient(slackEnv), runKey: String(formData.get("runKey") || ""), requestedBy, erpBase: new URL(request.url).origin });
    if (!result.ok) return Response.json({ kind: "stage3", ok: false, stage: result.stage, reasons: result.reasons, intentId: result.intentId ?? null });
    return Response.json({ kind: "stage3", ok: true, intentId: result.intent.id, status: result.intent.status, autonomyLevel: result.intent.autonomyLevel, duplicateIntent: result.duplicateIntent, slack: result.slack });
  }
  if (intentName === "createStage4Intent") {
    const result = await createStage4Intent(stage4Deps(session.shop), String(formData.get("runKey") || ""), requestedBy);
    if (!result.ok) return Response.json({ kind: "stage4-create", ok: false, stage: result.stage, reasons: result.reasons, intentId: result.intentId ?? null });
    return Response.json({ kind: "stage4-create", ok: true, intentId: result.intent.id, status: result.intent.status, autonomyLevel: result.intent.autonomyLevel, duplicateIntent: result.duplicateIntent, slack: result.slack });
  }
  if (intentName === "executeStage4") {
    const actor: Actor = { type: "staff", id: requestedBy.id, name: requestedBy.name, source: "ops-hub:stage4-execute" };
    const result = await executeStage4(stage4Deps(session.shop), String(formData.get("intentId") || ""), actor);
    if (!result.ok) return Response.json({ kind: "stage4-execute", ok: false, stage: result.stage, reasons: result.reasons, intentId: result.intentId });
    return Response.json({ kind: "stage4-execute", ok: true, duplicate: result.duplicate, intentId: result.intentId, outcome: result.outcome });
  }
  return Response.json({ ok: false, reasons: ["unknown action"] }, { status: 400 });
}

const cell = { border: "1px solid #e1e3e5", padding: "4px 6px", fontSize: 12, whiteSpace: "nowrap" as const };
const PERM_TONE: Record<string, "success" | "info" | "attention" | "warning" | "critical"> = { READ: "info", AUTO: "success", APPROVAL: "attention", OWNER: "warning", DENIED: "critical" };
const STATUS_TONE: Record<string, "success" | "info" | "attention" | "critical"> = { ACTIVE: "success", DRAFT: "info", MANUAL_ONLY: "attention", BLOCKED: "critical" };
const summaryStyle = { fontWeight: 600, cursor: "pointer", fontSize: 14, padding: "6px 0" } as const;

type Row = ReturnType<typeof auditSummary>;

function explain(i: Row, executionEnabled: boolean): string {
  if (i.status === "AWAITING_APPROVAL") return i.autonomyLevel === "OWNER_REQUIRED" ? "Needs the OWNER's decision (Slack card or hub)." : "Needs a mapped staff decision (Slack card).";
  if (i.status === "APPROVED" && isConsequential(i.actionType)) return executionEnabled ? "Approved; waits for an explicit owner execution action (never automatic)." : "Approved; held by the execution kill switch (GSO_AGENT_EXECUTION_ENABLED=false). Nothing will execute.";
  if (i.status === "APPROVED") return "Approved internal work; executes through the worker or an internal path.";
  if (i.status === "FAILED") return i.error?.includes("DISABLED") ? "Action is DISABLED in this release — refused at validation." : `Execution failed: ${i.error ?? "see audit"}.`;
  if (i.status === "COMPLETED") return `Executed once${i.externalReference ? ` → ${i.externalReference}` : ""}.`;
  if (i.status === "CANCELLED") return "Rejected/cancelled by a human.";
  return i.status;
}

function IntentList({ title, rows, empty, tone, executionEnabled }: { title: string; rows: Row[]; empty: string; tone?: "success" | "info" | "attention" | "warning" | "critical"; executionEnabled: boolean }) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">{title}</Text>
          <Badge tone={rows.length ? tone : undefined}>{String(rows.length)}</Badge>
        </InlineStack>
        {rows.length === 0 ? <Text as="p" tone="subdued">{empty}</Text> : null}
        {rows.map((i) => (
          <BlockStack key={i.id} gap="050">
            <Text as="p">
              <strong>{i.actionType}</strong> on {i.entity} · agent {i.agentId}{i.provider ? ` via ${i.provider}` : ""} · <code>{i.id}</code>
            </Text>
            <Text as="p" tone="subdued">
              created {i.createdAt} · level {i.autonomyLevel}{i.approvedBy ? ` · approved by ${i.approvedBy}` : ""}{i.executedAt ? ` · executed ${i.executedAt}` : ""}{i.externalReference ? ` · ref ${i.externalReference}` : ""}
            </Text>
            <Text as="p" tone={i.status === "FAILED" ? "critical" : "subdued"}>{explain(i, executionEnabled)}</Text>
          </BlockStack>
        ))}
      </BlockStack>
    </Card>
  );
}

function GateBadges({ checks }: { checks: Record<string, boolean> }) {
  return <InlineStack gap="200" wrap>{Object.entries(checks).map(([k, ok]) => <Badge key={k} tone={ok ? "success" : "critical"}>{`${k}: ${ok ? "OK" : "FAIL"}`}</Badge>)}</InlineStack>;
}

export default function OpsHub() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const busy = useNavigation().state !== "idle";
  const r = data.runtime;
  const w = data.worker;
  const gate = data.sandboxTest.gate;
  const s4 = data.stage4;
  const executionOn = r.executionEnabled === "YES";
  return (
    <Page title="Operations hub" subtitle={`${data.platformVersion} · ${data.registryVersion}`}>
      <BlockStack gap="400">
        {/* ---------------- Global safety header ---------------- */}
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Safety status</Text>
              <Badge tone={data.dangerous.length ? "critical" : "success"}>{data.dangerous.length ? "ATTENTION" : "ALL CONSEQUENTIAL PATHS CLOSED"}</Badge>
            </InlineStack>
            <InlineStack gap="200" wrap>
              <Badge tone={r.reasoningEnabled === "YES" ? "critical" : "success"}>{`Reasoning ${r.reasoningEnabled === "YES" ? "ON" : "OFF"}`}</Badge>
              <Badge tone={executionOn ? "critical" : "success"}>{`Execution ${executionOn ? "ON" : "OFF"}`}</Badge>
              <Badge tone={w.repository === "prisma" ? "success" : "critical"}>{`Repository: ${w.repository}`}</Badge>
              <Badge tone={data.slack.sandboxOnly === "true" ? "success" : "critical"}>{`Slack sandbox mode: ${data.slack.sandboxOnly === "true" ? "ON" : "OFF"}`}</Badge>
              <Badge tone="success">{`Worker scheduled: ${w.scheduled ? "YES" : "NO"}`}</Badge>
              <Badge tone={w.authConfigured ? "attention" : "info"}>{`Worker trigger configured: ${w.authConfigured ? "YES" : "NO"}`}</Badge>
              <Badge tone={r.provider === "NONE" ? "success" : "attention"}>{`Provider: ${r.provider}${r.provider !== "NONE" ? ` (configured ${r.providerConfigured})` : ""}`}</Badge>
              <Badge tone={r.tracingEnabled === "YES" || r.sensitiveTracing === "YES" ? "critical" : "success"}>{`Tracing ${r.tracingEnabled} · sensitive ${r.sensitiveTracing}`}</Badge>
            </InlineStack>
            {data.dangerous.map((d) => <Text key={d} as="p" tone="critical">⚠ {d}</Text>)}
            <Text as="p" tone="subdued">Production job movement is never executed from Slack and never by the worker; it requires an explicit owner action through the centralized transition executor. Money, customer messages, POs, invoices and dispatch stay DISABLED or OWNER_REQUIRED. QuickBooks: DEFERRED — NOT CONNECTED. Slack: bot token {data.slack.botToken}, signing secret {data.slack.signingSecret}, test channel {data.slack.testChannel}.</Text>
            <Text as="p" tone="subdued">Repository: {data.durability}. Reasoning blockers: {r.blockers.join("; ") || "none"}. Offline simulation: {data.simulation.passed}/{data.simulation.total} checks{data.simulation.failures.length ? ` — FAILURES: ${data.simulation.failures.join("; ")}` : ""}.</Text>
            <InlineStack gap="200">
              <Link to="/app/erp/agent-review-queue">Agent Review Queue</Link>
              <Link to="/app/erp/production">Production</Link>
              <Link to="/app/erp/purchase-requests">Purchase requests</Link>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* ---------------- Daily operations ---------------- */}
        <IntentList title="Needs a decision" rows={data.grouped.pending} empty="No intents awaiting a human decision." tone="attention" executionEnabled={executionOn} />
        <IntentList title="Approved but blocked by the execution kill switch" rows={data.grouped.blocked} empty="None." tone="warning" executionEnabled={executionOn} />
        <IntentList title="Failed / disabled actions" rows={data.grouped.failed} empty="None." tone="critical" executionEnabled={executionOn} />
        <IntentList title="Completed actions" rows={data.grouped.completed} empty="None." tone="success" executionEnabled={executionOn} />

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Worker and outbox</Text>
            <InlineStack gap="200" wrap>
              <Badge>{`pending ${w.outbox.pending}`}</Badge>
              <Badge tone={w.outbox.claimableNow ? "attention" : undefined}>{`claimable now ${w.outbox.claimableNow}`}</Badge>
              <Badge>{`processing ${w.outbox.processing}`}</Badge>
              <Badge tone={w.outbox.retrying ? "warning" : undefined}>{`retrying ${w.outbox.retrying}`}</Badge>
              <Badge tone="success">{`completed ${w.outbox.completed}`}</Badge>
              <Badge tone={w.outbox.dead ? "critical" : undefined}>{`dead / manual review ${w.outbox.dead}`}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Worker {w.version}: not scheduled (no cron or background service exists in this repo); trigger {w.authConfigured ? "configured" : "not configured"}; handlers allowed: {w.handlers.join(", ")}. The worker can never execute: {w.forbiddenActions.join(", ")}. Last run: {w.lastRun ? `${w.lastRun.at} — claimed ${w.lastRun.claimed}, completed ${w.lastRun.completed.length}, retried ${w.lastRun.retried.length}, dead ${w.lastRun.dead.length}` : "none in this process"}.</Text>
            {w.dead.map((m) => <Text key={m.id} as="p" tone="critical">DEAD {m.type} <code>{m.id}</code> after {m.attempts} attempt(s): {m.lastError}</Text>)}
            {w.retrying.map((m) => <Text key={m.id} as="p" tone="subdued">RETRY {m.type} <code>{m.id}</code> next {m.nextAttemptAt}: {m.lastError}</Text>)}
            <Text as="p">Paused reasoning runs awaiting a human decision: {data.pausedRuns.length}.</Text>
            {data.pausedRuns.map((p) => <Text key={p.id} as="p"><code>{p.id}</code> {p.agentId} via {p.provider} → intent {p.intentId} · {p.updatedAt}</Text>)}
          </BlockStack>
        </Card>

        {/* ---------------- Sandbox / release test tools (collapsed) ---------------- */}
        <Card>
          <details>
            <summary style={summaryStyle}>SANDBOX / RELEASE TEST TOOLS — owner-only regression controls (collapsed; not daily operations)</summary>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Stage 3 — Slack sandbox approval test</Text>
                <Text as="p" tone="subdued">Creates ONE synthetic, durable ActionIntent (move_production_job on OPS-SANDBOX-TEST-NO-ERP-WRITE, APPROVAL_REQUIRED) and posts its SANDBOX approval card to #{data.slack.testChannel}. Approving it records a durable APPROVED state and an audit row. No job, PO, invoice, message or money action can result.</Text>
                <GateBadges checks={gate.checks} />
                {gate.ok ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="createSandboxApprovalTest" />
                    <input type="hidden" name="runKey" value={data.sandboxTest.runKey} />
                    <Button submit disabled={busy}>CREATE SLACK SANDBOX APPROVAL TEST</Button>
                  </Form>
                ) : <Text as="p" tone="critical">Refused (fail closed): {gate.reasons.join("; ")}</Text>}
                {actionData?.kind === "stage3" ? (
                  actionData.ok
                    ? <Text as="p" tone="success">Intent <code>{actionData.intentId}</code> {actionData.status} ({actionData.autonomyLevel}){actionData.duplicateIntent ? " — existing intent reused (same run key)" : ""} · Slack {actionData.slack.duplicate ? "card already posted" : "card posted"} to {actionData.slack.channel} ts {actionData.slack.ts}. Approve it in Slack, then reload this page.</Text>
                    : <Text as="p" tone="critical">Refused at {actionData.stage}: {(actionData.reasons || []).join("; ")}{actionData.intentId ? ` (intent ${actionData.intentId})` : ""}</Text>
                ) : null}
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">STAGE 4 — GUARDED TEST JOB TRANSITION</Text>
                <Text as="p" tone="subdued">Locked to ticket <strong>{s4.ticket}</strong>: {s4.from} → {s4.target}. Creation posts a SANDBOX / STAGE 4 TEST card; approval happens in Slack; execution happens ONLY through the owner button below, which calls the centralized transition executor. The job id is resolved server-side from the ticket. (Stage 4 passed live on 2026-10-04; the ticket is now <em>printing</em>, so preflight is expected to report the status mismatch until a new test job is chosen.)</Text>
                <InlineStack gap="200" wrap>
                  <Badge tone={executionOn ? "critical" : "success"}>{`Execution kill switch: ${executionOn ? "ON" : "OFF"}`}</Badge>
                  <Badge tone={r.reasoningEnabled === "YES" ? "warning" : "success"}>{`Reasoning: ${r.reasoningEnabled === "YES" ? "ON" : "OFF"}`}</Badge>
                  <Badge tone={data.slack.sandboxOnly === "true" ? "success" : "critical"}>{`Slack sandbox-only: ${data.slack.sandboxOnly}`}</Badge>
                  <Badge tone={s4.preflight.job ? "info" : "critical"}>{`Current status: ${s4.preflight.currentStatus ?? "job not found"}`}</Badge>
                  <Badge tone={s4.preflight.ok ? "success" : "critical"}>{`Preflight: ${s4.preflight.ok ? "PASS" : "BLOCKED"}`}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Preflight facts: artApproved={String(s4.preflight.facts?.artApproved)} · qcPassRecorded={String(s4.preflight.facts?.qcPassRecorded)} · materialReady={String(s4.preflight.facts?.materialReady)} (not modelled) · routingDecided={String(s4.preflight.facts?.routingDecided)} (not modelled) · routing {s4.preflight.routing ? (s4.preflight.routing.blocked ? `BLOCKED: ${s4.preflight.routing.reasons.join("; ")}` : "clear") : "n/a"} · guard {s4.preflight.guard ? (s4.preflight.guard.allowed ? "allowed" : s4.preflight.guard.reasons.join("; ")) : "n/a"}.</Text>
                {s4.preflight.blockers.length ? <Text as="p" tone="critical">Blocked by: {s4.preflight.blockers.join(" · ")}</Text> : null}
                <Text as="h4" variant="headingXs">Step 1 — create the durable intent and post the sandbox card</Text>
                <GateBadges checks={s4.createGate.checks} />
                {s4.createGate.ok && s4.preflight.ok ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="createStage4Intent" />
                    <input type="hidden" name="runKey" value={s4.runKey} />
                    <Button submit disabled={busy}>CREATE STAGE 4 APPROVAL REQUEST</Button>
                  </Form>
                ) : <Text as="p" tone="critical">Creation refused (fail closed): {[...s4.createGate.reasons, ...(s4.preflight.ok ? [] : ["preflight blocked"])].join("; ")}</Text>}
                <Text as="h4" variant="headingXs">Step 2 — approve in Slack (#{data.slack.testChannel}) as a mapped owner</Text>
                {s4.intents.length === 0 ? <Text as="p" tone="subdued">No Stage 4 intents yet.</Text> : s4.intents.map((i) => (
                  <Text key={i.id} as="p"><code>{i.id}</code> <strong>{i.status}</strong> · created {i.createdAt}{i.approvedBy ? ` · approved by ${i.approvedBy}` : ""}{i.executedAt ? ` · executed ${i.executedAt}` : ""}{i.externalReference ? ` · ref ${i.externalReference}` : ""}{i.error ? ` · error ${i.error}` : ""}</Text>
                ))}
                <Text as="h4" variant="headingXs">Step 3 — owner executes (separate action; never from Slack, never from a worker)</Text>
                <GateBadges checks={s4.executeGate.checks} />
                {s4.executableIntentId && s4.executeGate.ok && s4.preflight.ok ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="executeStage4" />
                    <input type="hidden" name="intentId" value={s4.executableIntentId} />
                    <Button submit variant="primary" tone="critical" disabled={busy}>EXECUTE APPROVED STAGE 4 TEST TRANSITION</Button>
                  </Form>
                ) : <Text as="p" tone="subdued">Execution unavailable: {[...s4.executeGate.reasons, ...(s4.executableIntentId ? [] : ["no APPROVED Stage 4 intent"]), ...(s4.preflight.ok ? [] : ["preflight blocked"])].join("; ")}.</Text>}
                {actionData?.kind === "stage4-create" ? (
                  actionData.ok
                    ? <Text as="p" tone="success">Stage 4 intent <code>{actionData.intentId}</code> {actionData.status} ({actionData.autonomyLevel}){actionData.duplicateIntent ? " — existing intent reused" : ""} · Slack {actionData.slack.duplicate ? "card already posted" : "card posted"} to {actionData.slack.channel} ts {actionData.slack.ts}.</Text>
                    : <Text as="p" tone="critical">Creation refused at {actionData.stage}: {(actionData.reasons || []).join("; ")}</Text>
                ) : null}
                {actionData?.kind === "stage4-execute" ? (
                  actionData.ok
                    ? <Text as="p" tone={actionData.duplicate ? "subdued" : "success"}>{actionData.duplicate ? `Already executed — no-op (intent ${actionData.intentId}).` : `Executed: ${actionData.outcome.from} → ${actionData.outcome.to} via intent ${actionData.intentId}; ref ${actionData.outcome.externalReference}.`}</Text>
                    : <Text as="p" tone="critical">Execution refused at {actionData.stage}: {(actionData.reasons || []).join("; ")}</Text>
                ) : null}
              </BlockStack>
            </BlockStack>
          </details>
        </Card>

        {/* ---------------- Reference: registry + matrix (collapsed) ---------------- */}
        <Card>
          <details>
            <summary style={summaryStyle}>Agent registry and permission matrix (reference)</summary>
            <BlockStack gap="300">
              <BlockStack gap="100">
                {data.agents.map((a) => (
                  <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                    <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                    <Text as="span" fontWeight="semibold">{a.name}</Text>
                    <Text as="span" tone="subdued">{a.reasoning} · {a.purpose}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={cell}>agent</th>
                      {data.actions.map((act) => <th key={act} style={{ ...cell, writingMode: "vertical-rl", transform: "rotate(180deg)" }}>{act}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <tr key={a.id}>
                        <td style={cell}>{a.id}</td>
                        {data.actions.map((act) => {
                          const perm = (data.matrix as any)[a.id][act] as string;
                          return <td key={act} style={cell}>{perm === "DENIED" ? <span style={{ color: "#b98900" }}>·</span> : <Badge tone={PERM_TONE[perm]}>{perm}</Badge>}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Text as="p" tone="subdued">· = DENIED. READ = report only. AUTO = internal draft/intent. APPROVAL = mapped staff. OWNER = owner only. Consequential execution additionally requires GSO_AGENT_EXECUTION_ENABLED and, for job moves, the owner's explicit executor action.</Text>
            </BlockStack>
          </details>
        </Card>
      </BlockStack>
    </Page>
  );
}
