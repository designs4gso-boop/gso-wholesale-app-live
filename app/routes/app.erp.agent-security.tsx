import crypto from "node:crypto";

import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AGENT_ERROR_CODE_EXPLANATIONS } from "../lib/agent-security.server";

// Mirrors AGENT_INTAKE_SCOPE in app/lib/agent-security.server.ts. Kept as a
// literal here because this route's component renders it, and client code
// must not import from a .server module.
const INTAKE_SCOPE = "intake:create";

const FAMILY_OPTIONS = ["jars", "banners", "labels-stickers", "custom-other"] as const;

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function actorLabel(session: any) {
  return String(
    session?.email || [session?.firstName, session?.lastName].filter(Boolean).join(" ").trim() || "staff",
  );
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function jsonList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const inputStyle = {
  border: "1px solid #c9cccf",
  borderRadius: 6,
  font: "inherit",
  padding: "7px 9px",
  width: "100%",
} as const;

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const credentials = await db.agentApiCredential.findMany({
    where: { shop: session.shop },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      agentId: true,
      agentName: true,
      agentEmail: true,
      sourceType: true,
      sourceChannel: true,
      tokenId: true,
      scopes: true,
      allowedProductFamilies: true,
      isActive: true,
      revokedAt: true,
      revokedReason: true,
      lastUsedAt: true,
      createdBy: true,
      createdAt: true,
    },
  });

  const submissions = await db.agentSubmissionLog.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      agentName: true,
      agentId: true,
      sourceChannel: true,
      status: true,
      errorCode: true,
      outcome: true,
      queueItemId: true,
      createdAt: true,
    },
  });

  return Response.json({
    shop: session.shop,
    // Delivered via loader data on purpose: the component must never import
    // from a .server module.
    errorExplanations: AGENT_ERROR_CODE_EXPLANATIONS,
    credentials: credentials.map((credential) => ({
      ...credential,
      revokedAt: credential.revokedAt ? credential.revokedAt.toISOString() : null,
      lastUsedAt: credential.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
      createdAt: credential.createdAt.toISOString(),
    })),
    submissions: submissions.map((submission) => ({
      ...submission,
      createdAt: submission.createdAt.toISOString(),
    })),
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "createCredential") {
    const agentName = String(formData.get("agentName") || "").trim().slice(0, 120);
    if (!agentName) {
      return Response.json({ ok: false, intent, message: "Agent name is required." }, { status: 400 });
    }

    const agentEmail = String(formData.get("agentEmail") || "").trim().slice(0, 180) || null;
    const sourceType = String(formData.get("sourceType") || "sales_agent").trim().slice(0, 60) || "sales_agent";
    const sourceChannel = String(formData.get("sourceChannel") || "").trim().slice(0, 120) || null;
    const families = formData
      .getAll("allowedFamilies")
      .map(String)
      .filter((value): value is (typeof FAMILY_OPTIONS)[number] =>
        (FAMILY_OPTIONS as readonly string[]).includes(value),
      );
    const allowedProductFamilies = families.length ? families : null;

    const agentId = `agent_${crypto.randomBytes(6).toString("hex")}`;
    const tokenId = `gso_${crypto.randomBytes(9).toString("hex")}`;
    const tokenSecret = crypto.randomBytes(32).toString("base64url");

    try {
      await db.agentApiCredential.create({
        data: {
          shop: session.shop,
          agentId,
          agentName,
          agentEmail,
          sourceType,
          sourceChannel,
          tokenId,
          tokenHash: sha256Hex(tokenSecret),
          scopes: [INTAKE_SCOPE],
          allowedProductFamilies: allowedProductFamilies ?? undefined,
          isActive: true,
          createdBy: actorLabel(session),
        },
      });
    } catch (_error) {
      return Response.json(
        { ok: false, intent, message: "Credential could not be created. Try again." },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      intent,
      message: "Credential created. Copy the token below now - it will never be shown again.",
      oneTimeToken: `${tokenId}.${tokenSecret}`,
      createdAgentName: agentName,
    });
  }

  if (intent === "revokeCredential") {
    const credentialId = String(formData.get("credentialId") || "");
    const reason = String(formData.get("reason") || "").trim().slice(0, 300);

    if (!reason) {
      return Response.json({ ok: false, intent, message: "A revoke reason is required." }, { status: 400 });
    }

    const updated = await db.agentApiCredential.updateMany({
      where: { id: credentialId, shop: session.shop, isActive: true },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedReason: `${reason} (by ${actorLabel(session)})`,
      },
    });

    if (updated.count !== 1) {
      return Response.json(
        { ok: false, intent, message: "Credential was not found or is already revoked." },
        { status: 400 },
      );
    }

    return Response.json({ ok: true, intent, message: "Credential revoked. Intake requests with it now fail." });
  }

  return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
}

function submissionTone(status: string) {
  if (status === "accepted") return "success" as const;
  if (status === "duplicate") return "info" as const;
  if (status === "rejected_rate_limit") return "warning" as const;
  return "critical" as const;
}

const SUBMISSION_FILTERS = [
  { value: "all", label: "All" },
  { value: "accepted", label: "Accepted" },
  { value: "duplicate", label: "Duplicates" },
  { value: "failures", label: "Failures" },
] as const;

export default function AgentSecurityPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const isFailure = (status: string) => status !== "accepted" && status !== "duplicate";
  const filteredSubmissions = (data.submissions || []).filter((submission: any) =>
    statusFilter === "all"
      ? true
      : statusFilter === "failures"
        ? isFailure(submission.status)
        : submission.status === statusFilter,
  );
  const filterCount = (value: string) =>
    value === "all"
      ? data.submissions.length
      : value === "failures"
        ? data.submissions.filter((s: any) => isFailure(s.status)).length
        : data.submissions.filter((s: any) => s.status === value).length;

  return (
    <Page
      title="Agent Security"
      subtitle={`External agent credentials and intake activity for ${data.shop}`}
    >
      <BlockStack gap="400">
        <Banner tone="info">
          <Text as="p">
            External agents are intake-only. Credentials created here carry the {INTAKE_SCOPE} scope and can
            never create quotes, orders, invoices, customer messages, or production jobs.
          </Text>
        </Banner>

        {actionData?.message ? (
          <Banner tone={actionData.ok ? "success" : "critical"} title={actionData.message}>
            {actionData.oneTimeToken ? (
              <BlockStack gap="150">
                <Text as="p" fontWeight="semibold">
                  One-time token for {actionData.createdAgentName}:
                </Text>
                <div
                  style={{
                    background: "#f6f6f7",
                    border: "1px solid #c9cccf",
                    borderRadius: 6,
                    fontFamily: "monospace",
                    overflowWrap: "anywhere",
                    padding: 10,
                  }}
                >
                  {actionData.oneTimeToken}
                </div>
                <Text as="p" tone="critical">
                  This is the only time the token is shown. It is stored only as a hash.
                </Text>
                <Text as="p" tone="subdued">
                  Send it exactly as shown: Authorization: Bearer tokenId.tokenSecret (dot separator). Timestamps
                  may be unix milliseconds or seconds. Test locally with tools/test-agent-intake.ps1.
                </Text>
              </BlockStack>
            ) : null}
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Create agent credential
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="createCredential" />
              <BlockStack gap="200">
                <label style={{ display: "grid", gap: 4 }}>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    Agent name *
                  </Text>
                  <input name="agentName" required style={inputStyle} placeholder="Acme Marketing Bot" />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    Agent email
                  </Text>
                  <input name="agentEmail" type="email" style={inputStyle} placeholder="ops@acme.example" />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    Source type
                  </Text>
                  <input name="sourceType" defaultValue="sales_agent" style={inputStyle} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    Source channel
                  </Text>
                  <input name="sourceChannel" style={inputStyle} placeholder="instagram_dm" />
                </label>
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    Allowed product families (none checked = all allowed)
                  </Text>
                  <InlineStack gap="300">
                    {FAMILY_OPTIONS.map((family) => (
                      <label key={family} style={{ alignItems: "center", display: "flex", gap: 6 }}>
                        <input type="checkbox" name="allowedFamilies" value={family} />
                        <Text as="span" variant="bodySm">
                          {family}
                        </Text>
                      </label>
                    ))}
                  </InlineStack>
                </BlockStack>
                <InlineStack gap="200">
                  <Button submit variant="primary">
                    Create credential
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              How to test &amp; integrate
            </Text>
            <BlockStack gap="150">
              <Text as="p" fontWeight="semibold">
                Testing a credential (staff, local machine):
              </Text>
              <Text as="p" variant="bodySm">
                1. Create a credential above and copy the one-time token. 2. Run tools/test-agent-intake.ps1 and
                paste the token when prompted. 3. Expect HTTP 201 accepted, then an automatic replay returning 200
                duplicate. 4. Both attempts appear in Recent Submissions below. 5. The accepted lead appears in the
                Agent Review Queue for normal staff review.
              </Text>
              <Text as="p" fontWeight="semibold">
                Wire contract for agent vendors:
              </Text>
              <Text as="p" variant="bodySm">
                POST https://gso-wholesale-app-live.onrender.com/api/agent/intake with JSON body (32KB max) and
                headers: Authorization: Bearer tokenId.tokenSecret (dot separator, format gso_xxxx.xxxx);
                X-GSO-Agent-Timestamp: unix milliseconds (seconds also accepted), within 5 minutes of server time;
                X-GSO-Agent-Signature: lowercase hex HMAC-SHA256 over "timestamp.body" keyed with the UTF-8 token
                secret. Include an idempotencyKey per lead. Limits: 60 requests/hour and 10/minute per credential;
                identical accepted payloads within 10 minutes return the original item as a duplicate. Credentials
                may be restricted to specific product families. Intake is the only permitted action.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Credentials
            </Text>
            {data.credentials.length === 0 ? (
              <Text as="p" tone="subdued">
                No agent credentials exist yet.
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", minWidth: 900, width: "100%" }}>
                  <thead>
                    <tr>
                      {["Agent", "Token ID", "Scopes", "Families", "Status", "Last used", "Created", "Actions"].map(
                        (heading) => (
                          <th
                            key={heading}
                            style={{ borderBottom: "1px solid #dfe3e8", padding: 8, textAlign: "left" }}
                          >
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              {heading}
                            </Text>
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.credentials.map((credential: any) => (
                      <tr key={credential.id}>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              {credential.agentName}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {credential.agentEmail || credential.agentId}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {credential.sourceType}
                              {credential.sourceChannel ? ` / ${credential.sourceChannel}` : ""}
                            </Text>
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", fontFamily: "monospace", padding: 8, verticalAlign: "top" }}>
                          {credential.tokenId}
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {jsonList(credential.scopes).join(", ") || "legacy (all intake)"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {jsonList(credential.allowedProductFamilies).join(", ") || "All"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          {credential.isActive ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <BlockStack gap="050">
                              <Badge tone="critical">Revoked</Badge>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {formatDate(credential.revokedAt)}
                              </Text>
                              {credential.revokedReason ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {credential.revokedReason}
                                </Text>
                              ) : null}
                            </BlockStack>
                          )}
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {formatDate(credential.lastUsedAt)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm">
                              {formatDate(credential.createdAt)}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {credential.createdBy || "unknown"}
                            </Text>
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8, verticalAlign: "top" }}>
                          {credential.isActive ? (
                            <Form method="post">
                              <input type="hidden" name="intent" value="revokeCredential" />
                              <input type="hidden" name="credentialId" value={credential.id} />
                              <BlockStack gap="100">
                                <input
                                  name="reason"
                                  required
                                  maxLength={300}
                                  placeholder="Revoke reason (required)"
                                  style={{ ...inputStyle, maxWidth: 200, width: "100%" }}
                                />
                                <Button size="slim" tone="critical" submit>
                                  Revoke
                                </Button>
                              </BlockStack>
                            </Form>
                          ) : (
                            <Text as="span" variant="bodySm" tone="subdued">
                              Create a new credential to re-enable this agent.
                            </Text>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent intake submissions (last 50)
            </Text>
            <InlineStack gap="150">
              {SUBMISSION_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  size="slim"
                  pressed={statusFilter === filter.value}
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {`${filter.label} (${filterCount(filter.value)})`}
                </Button>
              ))}
            </InlineStack>
            {data.submissions.length === 0 ? (
              <Text as="p" tone="subdued">
                No intake submissions logged yet.
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", minWidth: 800, width: "100%" }}>
                  <thead>
                    <tr>
                      {["Time", "Agent", "Status", "Error code", "Outcome", "Queue item"].map((heading) => (
                        <th key={heading} style={{ borderBottom: "1px solid #dfe3e8", padding: 8, textAlign: "left" }}>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {heading}
                          </Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSubmissions.map((submission: any) => (
                      <tr key={submission.id}>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8 }}>
                          <Text as="span" variant="bodySm">
                            {formatDate(submission.createdAt)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8 }}>
                          <Text as="span" variant="bodySm">
                            {submission.agentName || submission.agentId || "Unknown"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8 }}>
                          <Badge tone={submissionTone(submission.status)}>{submission.status}</Badge>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8 }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm">
                              {submission.errorCode || "-"}
                            </Text>
                            {submission.errorCode && data.errorExplanations?.[submission.errorCode] ? (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {data.errorExplanations[submission.errorCode]}
                              </Text>
                            ) : null}
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 8 }}>
                          <Text as="span" variant="bodySm">
                            {submission.outcome || "-"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", fontFamily: "monospace", padding: 8 }}>
                          {submission.queueItemId || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
