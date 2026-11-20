// 2026-11-19 — Approvals: proposals from agents and staff that wait for a
// person. Owner and managers.
//
// Approving or rejecting here NEVER sends anything. An approved draft message
// is sent by a person, by hand, outside the ERP. The only things an approval
// changes are inside the ERP (a lead's assignee or follow-up date).

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { APPROVAL_ACTION_INFO, approvalView, decideApproval, listApprovals } from "../lib/agent-approvals.server";
import { agentProposalProfiles } from "../lib/ops/agent-registry";
import { PrismaActionIntentRepository } from "../lib/ops/prisma-repositories.server";
import { requireRouteAccess, routeAccessDecision } from "../lib/route-access.server";
import { crmLeadHref } from "../lib/simple-nav";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireRouteAccess(auth, "erp/agent-approvals");
  const approvals = (await listApprovals(new PrismaActionIntentRepository(), auth.session.shop)).map(approvalView);
  // 2026-11-20: which registered agent may propose what. Display only; the registry is the rule.
  const agents = agentProposalProfiles().map((agent) => ({ key: agent.agentKey, name: agent.name, purpose: agent.purpose, proposes: agent.permittedProposalTypes.map((action) => APPROVAL_ACTION_INFO[action]?.label || action) }));
  return Response.json({ approvals, agents });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const access = routeAccessDecision(auth, "erp/agent-approvals");
  if (!access.allowed) return Response.json({ ok: false, message: access.message }, { status: 403 });
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");
  if (intent !== "approve" && intent !== "reject") return Response.json({ ok: false, id, message: "Unknown action." }, { status: 400 });
  const result = await decideApproval(new PrismaActionIntentRepository(), db, {
    shop: auth.session.shop,
    id,
    decision: intent,
    approver: { userId: access.staff.userId, actor: access.staff.actor, role: access.staff.role },
    comment: String(form.get("comment") || ""),
  });
  return Response.json({ ...result, id });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16, display: "grid", gap: 10 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const STATUS_LABEL: Record<string, string> = { AWAITING_APPROVAL: "Waiting for you", APPROVED: "Approved", EXECUTING: "Being recorded", COMPLETED: "Approved", FAILED: "Could not be applied", CANCELLED: "Rejected", PROPOSED: "Received", VALIDATED: "Received" };

function ApprovalCard({ item, result, busy }: { item: any; result: any; busy: boolean }) {
  const navigate = useNavigate();
  const mine = result?.id === item.id ? result : null;
  const waiting = item.status === "AWAITING_APPROVAL";
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{item.kind}</div>
        <div style={{ fontSize: 13, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: waiting ? "#fef3c7" : "#f3f4f6", color: waiting ? "#92400e" : "#374151" }}>{STATUS_LABEL[item.status] || item.status}</div>
      </div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>Proposed by {item.proposedBy}{item.proposedByType === "agent" ? " (agent)" : ""} · {new Date(item.createdAt).toLocaleString()}</div>
      <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{item.reason}</div>
      {(item.fields as any[]).map((field) => (
        <div key={field.name} style={{ fontSize: 14, border: "1px solid #f3f4f6", borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{field.name}</div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{field.value}</div>
        </div>
      ))}
      {item.entityType === "crm_lead" ? <div><button type="button" onClick={() => navigate(crmLeadHref(item.entityId))} style={{ minHeight: 40, padding: "0 14px", borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Open the lead</button></div> : null}
      {mine?.message ? <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: mine.ok ? "#f0fdf4" : "#fef2f2", color: mine.ok ? "#166534" : "#991b1b" }}>{mine.message}</div> : null}
      {waiting ? (
        <Form method="post" style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="id" value={item.id} />
          <div style={{ fontSize: 13, color: "#6b7280" }}>If approved: {item.onApprove}</div>
          <input name="comment" placeholder="Comment (needed to reject)" style={input} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
            <button type="submit" name="intent" value="approve" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #166534", background: "#166534", color: "white", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>APPROVE</button>
            <button type="submit" name="intent" value="reject" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #d1d5db", background: "white", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Reject</button>
          </div>
        </Form>
      ) : (
        <div style={{ fontSize: 13, color: "#6b7280" }}>{item.approvedBy ? `Decided by ${item.approvedBy}. ` : ""}{item.error ? item.error : ""}</div>
      )}
    </div>
  );
}

export default function AgentApprovals() {
  const { approvals, agents = [] } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";
  const waiting = (approvals as any[]).filter((item) => item.status === "AWAITING_APPROVAL");
  const done = (approvals as any[]).filter((item) => item.status !== "AWAITING_APPROVAL");
  return (
    <Page title="Approvals" subtitle="Proposals waiting for a person. Approving never sends anything to a customer." backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 860 }}>
        {!waiting.length ? <div style={{ ...card, fontSize: 15, color: "#6b7280" }}>Nothing is waiting for approval.</div> : waiting.map((item) => <ApprovalCard key={item.id} item={item} result={result} busy={busy} />)}
        {done.length ? (
          <details style={card}>
            <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#6b7280", minHeight: 44 }}>Already decided ({done.length})</summary>
            <div style={{ display: "grid", gap: 12 }}>{done.map((item) => <ApprovalCard key={item.id} item={item} result={result} busy={busy} />)}</div>
          </details>
        ) : null}
        {(agents as any[]).length ? (
          <details style={card}>
            <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#6b7280", minHeight: 44 }}>Which agents can propose what ({agents.length})</summary>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Every proposal needs a person. No agent can send, post, order or charge.</div>
            {(agents as any[]).map((agent) => (
              <div key={agent.key} style={{ fontSize: 14, borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
                <b>{agent.name}</b> — {agent.proposes.join(", ")}
              </div>
            ))}
          </details>
        ) : null}
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (!(isRouteErrorResponse(error) && error.status === 403)) return boundary.error(error);
  return (
    <Page title="Approvals" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Proposals are approved by the owner or a manager.</div>
    </Page>
  );
}
