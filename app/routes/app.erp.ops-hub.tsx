// Staff Operations Hub — read-only view of the agent platform: registry,
// agent x action permission matrix, pending intents (this process), Slack
// configuration state (no secrets) and the company-flow simulation result.
// Approvals and lead review stay in the Agent Review Queue; this page does not
// duplicate it.

import { Badge, BlockStack, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { AGENT_REGISTRY, AGENT_REGISTRY_VERSION, permissionMatrix } from "../lib/ops/agent-registry";
import { ACTION_TYPES, OPS_PLATFORM_VERSION } from "../lib/ops/autonomy";
import { auditSummary } from "../lib/ops/action-intents";
import { getIntentStore, INTENT_STORE_DURABILITY } from "../lib/ops/intent-store.server";
import { describeSlackEnv, loadSlackEnv } from "../lib/slack/slack-client.server";
import { runCompanyFlowSimulation } from "../lib/ops/simulator.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  const sim = await runCompanyFlowSimulation();
  return {
    platformVersion: OPS_PLATFORM_VERSION,
    registryVersion: AGENT_REGISTRY_VERSION,
    agents: AGENT_REGISTRY.map((a) => ({ id: a.id, name: a.name, status: a.status, statusReason: a.statusReason, modelVersion: a.modelVersion, purpose: a.purpose })),
    matrix: permissionMatrix(),
    actions: ACTION_TYPES,
    intents: getIntentStore().list().map(auditSummary),
    storeDurability: INTENT_STORE_DURABILITY,
    slack: describeSlackEnv(loadSlackEnv()),
    simulation: { passed: sim.assertions.filter((a) => a.ok).length, total: sim.assertions.length, failures: sim.assertions.filter((a) => !a.ok) },
  };
}

const cell = { border: "1px solid #e1e3e5", padding: "4px 6px", fontSize: 12, whiteSpace: "nowrap" as const };
const PERM_TONE: Record<string, "success" | "info" | "attention" | "warning" | "critical"> = { READ: "info", AUTO: "success", APPROVAL: "attention", OWNER: "warning", DENIED: "critical" };
const STATUS_TONE: Record<string, "success" | "info" | "attention" | "critical"> = { ACTIVE: "success", DRAFT: "info", MANUAL_ONLY: "attention", BLOCKED: "critical" };

export default function OpsHub() {
  const data = useLoaderData<typeof loader>();
  return (
    <Page title="Operations hub" subtitle={`${data.platformVersion} · ${data.registryVersion}`}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Release posture</Text>
            <Text as="p">Agents propose; humans approve. Tonight every money, customer, external PO/invoice and job-movement action is DENIED or requires approval. QuickBooks: DEFERRED — NOT CONNECTED.</Text>
            <Text as="p" tone="subdued">Intent store: {data.storeDurability}. Slack: bot token {data.slack.botToken}, app token {data.slack.appToken}, signing secret {data.slack.signingSecret}, sandbox-only {data.slack.sandboxOnly}, test channel {data.slack.testChannel}.</Text>
            <Text as="p">Company-flow simulation: {data.simulation.passed}/{data.simulation.total} checks passed{data.simulation.failures.length ? ` — failures: ${data.simulation.failures.map((f) => f.name).join("; ")}` : ""}.</Text>
            <InlineStack gap="200">
              <Link to="/app/erp/agent-review-queue">Agent Review Queue (lead approvals)</Link>
              <Link to="/app/erp/production">Production</Link>
              <Link to="/app/erp/purchase-requests">Purchase requests</Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Agent registry</Text>
            {data.agents.map((a) => (
              <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                <Text as="span" fontWeight="semibold">{a.name}</Text>
                <Text as="span" tone="subdued">{a.purpose}</Text>
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
            <Text as="p" tone="subdued">· = DENIED. READ = report only. AUTO = internal draft/intent, nothing leaves GSO. APPROVAL = mapped staff. OWNER = owner only.</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Action intents in this process ({data.intents.length})</Text>
            {data.intents.length === 0 ? <Text as="p" tone="subdued">None. Intents appear here when agents run in this server process.</Text> : null}
            {data.intents.map((i) => (
              <Text key={i.id} as="p"><code>{i.id}</code> {i.agentId} → {i.actionType} on {i.entity}: <strong>{i.status}</strong> ({i.autonomyLevel}){i.approvedBy ? ` approved by ${i.approvedBy}` : ""}{i.error ? ` — ${i.error}` : ""}</Text>
            ))}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
