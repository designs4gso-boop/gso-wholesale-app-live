// Staff Operations Hub (OPS-2) — read-only view of the agent platform: provider
// and kill-switch status (safe values only), registry, permission matrix,
// durable intents grouped by state (pending approvals, failed, blocked by the
// execution kill switch, completed), outbox and paused reasoning runs, and the
// offline simulation result. No secrets, no raw prompts, no chain-of-thought,
// no customer PII beyond entity ids. Approvals stay in Slack / the Agent
// Review Queue; this page does not duplicate them.

import { Badge, BlockStack, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { auditSummary, isConsequential } from "../lib/ops/action-intents";
import { AGENT_REGISTRY, AGENT_REGISTRY_VERSION, permissionMatrix } from "../lib/ops/agent-registry";
import { ACTION_TYPES, OPS_PLATFORM_VERSION } from "../lib/ops/autonomy";
import { describeRepositoryDurability, getOpsRepositories } from "../lib/ops/intent-store.server";
import { describeOpsRuntime, readOpsRuntimeConfig } from "../lib/ops/runtime-config";
import { runCompanyFlowSimulation } from "../lib/ops/simulator.server";
import { SPECIALISTS } from "../lib/reasoning/specialists";
import { describeSlackEnv, loadSlackEnv } from "../lib/slack/slack-client.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  const config = readOpsRuntimeConfig();
  const repos = getOpsRepositories();
  const intents = (await repos.intents.list({ limit: 200 })).map(auditSummary);
  const outbox = await repos.outbox.list();
  const pausedRuns = await repos.runs.listByStatus("PAUSED_FOR_APPROVAL");
  const sim = await runCompanyFlowSimulation();
  const grouped = {
    pending: intents.filter((i) => i.status === "AWAITING_APPROVAL"),
    blocked: intents.filter((i) => i.status === "APPROVED" && isConsequential(i.actionType) && !config.executionEnabled),
    failed: intents.filter((i) => i.status === "FAILED"),
    completed: intents.filter((i) => i.status === "COMPLETED"),
  };
  return {
    platformVersion: OPS_PLATFORM_VERSION,
    registryVersion: AGENT_REGISTRY_VERSION,
    runtime: describeOpsRuntime(config),
    durability: describeRepositoryDurability(),
    slack: describeSlackEnv(loadSlackEnv()),
    agents: AGENT_REGISTRY.map((a) => ({ id: a.id, name: a.name, status: a.status, purpose: a.purpose, reasoning: Object.values(SPECIALISTS).some((s) => s.agentId === a.id) ? "model-capable (provider-gated)" : "deterministic" })),
    matrix: permissionMatrix(),
    actions: ACTION_TYPES,
    grouped,
    outbox: { pending: outbox.filter((m) => m.status === "PENDING").length, processing: outbox.filter((m) => m.status === "PROCESSING").length, failed: outbox.filter((m) => m.status === "FAILED").length, dead: outbox.filter((m) => m.status === "DEAD").map((m) => ({ id: m.id, type: m.type, lastError: m.lastError })), completed: outbox.filter((m) => m.status === "COMPLETED").length },
    pausedRuns: pausedRuns.map((r) => ({ id: r.id, agentId: r.agentId, provider: r.provider, intentId: r.intentId, updatedAt: r.updatedAt })),
    simulation: { passed: sim.assertions.filter((a) => a.ok).length, total: sim.assertions.length, failures: sim.assertions.filter((a) => !a.ok).map((f) => f.name) },
  };
}

const cell = { border: "1px solid #e1e3e5", padding: "4px 6px", fontSize: 12, whiteSpace: "nowrap" as const };
const PERM_TONE: Record<string, "success" | "info" | "attention" | "warning" | "critical"> = { READ: "info", AUTO: "success", APPROVAL: "attention", OWNER: "warning", DENIED: "critical" };
const STATUS_TONE: Record<string, "success" | "info" | "attention" | "critical"> = { ACTIVE: "success", DRAFT: "info", MANUAL_ONLY: "attention", BLOCKED: "critical" };

type Row = ReturnType<typeof auditSummary>;

function IntentList({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">{title} ({rows.length})</Text>
        {rows.length === 0 ? <Text as="p" tone="subdued">{empty}</Text> : null}
        {rows.map((i) => (
          <Text key={i.id} as="p">
            <code>{i.id}</code> {i.agentId}{i.provider ? ` via ${i.provider}` : ""} → {i.actionType} on {i.entity} · created {i.createdAt} · <strong>{i.status}</strong> ({i.autonomyLevel}{i.requiresApproval ? ", approval required" : ""})
            {i.approvedBy ? ` · approved by ${i.approvedBy}` : ""}{i.externalReference ? ` · ref ${i.externalReference}` : ""}{i.error ? ` · error: ${i.error}` : ""}
          </Text>
        ))}
      </BlockStack>
    </Card>
  );
}

export default function OpsHub() {
  const data = useLoaderData<typeof loader>();
  const r = data.runtime;
  return (
    <Page title="Operations hub" subtitle={`${data.platformVersion} · ${data.registryVersion}`}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Runtime status</Text>
            <InlineStack gap="200" wrap>
              <Badge tone={r.provider === "NONE" ? "info" : "attention"}>{`Reasoning provider: ${r.provider}`}</Badge>
              <Badge tone={r.providerConfigured === "YES" ? "success" : "info"}>{`Configured: ${r.providerConfigured}`}</Badge>
              <Badge tone={r.reasoningEnabled === "YES" ? "warning" : "success"}>{`Reasoning enabled: ${r.reasoningEnabled}`}</Badge>
              <Badge tone={r.executionEnabled === "YES" ? "critical" : "success"}>{`Execution enabled: ${r.executionEnabled}`}</Badge>
              <Badge tone={r.tracingEnabled === "YES" ? "warning" : "success"}>{`Tracing: ${r.tracingEnabled}`}</Badge>
              <Badge tone={r.sensitiveTracing === "YES" ? "critical" : "success"}>{`Sensitive tracing: ${r.sensitiveTracing}`}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Model: {r.model} · Repository: {data.durability} · Reasoning blockers: {r.blockers.join("; ") || "none"}.</Text>
            <Text as="p" tone="subdued">Slack: bot token {data.slack.botToken}, signing secret {data.slack.signingSecret}, sandbox-only {data.slack.sandboxOnly}, test channel {data.slack.testChannel}. QuickBooks: DEFERRED — NOT CONNECTED. LLM provider: DEFERRED (runtime prepared, disabled).</Text>
            <Text as="p">Offline company-flow simulation: {data.simulation.passed}/{data.simulation.total} checks passed{data.simulation.failures.length ? ` — failures: ${data.simulation.failures.join("; ")}` : ""}.</Text>
            <InlineStack gap="200">
              <Link to="/app/erp/agent-review-queue">Agent Review Queue</Link>
              <Link to="/app/erp/production">Production</Link>
              <Link to="/app/erp/purchase-requests">Purchase requests</Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <IntentList title="Pending approvals" rows={data.grouped.pending} empty="No intents awaiting a human decision." />
        <IntentList title="Approved but blocked by the execution kill switch" rows={data.grouped.blocked} empty="None." />
        <IntentList title="Failed / disabled actions" rows={data.grouped.failed} empty="None." />
        <IntentList title="Completed actions" rows={data.grouped.completed} empty="None." />

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Outbox and reasoning runs</Text>
            <Text as="p">Outbox: {data.outbox.pending} pending · {data.outbox.processing} processing · {data.outbox.failed} retrying · {data.outbox.completed} completed · {data.outbox.dead.length} dead (manual review).</Text>
            {data.outbox.dead.map((m) => <Text key={m.id} as="p" tone="critical">{m.id} {m.type}: {m.lastError}</Text>)}
            <Text as="p">Paused reasoning runs awaiting a human decision: {data.pausedRuns.length}.</Text>
            {data.pausedRuns.map((p) => <Text key={p.id} as="p"><code>{p.id}</code> {p.agentId} via {p.provider} → intent {p.intentId} · {p.updatedAt}</Text>)}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Agent registry</Text>
            {data.agents.map((a) => (
              <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                <Text as="span" fontWeight="semibold">{a.name}</Text>
                <Text as="span" tone="subdued">{a.reasoning} · {a.purpose}</Text>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Permission matrix (agent × action)</Text>
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
            <Text as="p" tone="subdued">· = DENIED. READ = report only. AUTO = internal draft/intent. APPROVAL = mapped staff. OWNER = owner only. Consequential execution additionally requires GSO_AGENT_EXECUTION_ENABLED.</Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
