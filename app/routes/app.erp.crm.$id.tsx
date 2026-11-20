// 2026-11-19 — one lead: details, assignment, status, follow-up, history, and
// the two conversions (customer account, draft quote). Owner, manager, sales.
//
// INTERNAL ONLY: nothing here contacts the customer. "Ask for approval" puts a
// draft in the approval queue for the owner or a manager; an approved draft is
// sent by a person, by hand, outside the ERP.

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { submitApproval } from "../lib/agent-approvals.server";
import { LEAD_SOURCES, LEAD_STATUSES, LEAD_STATUS_LABEL, leadDisplayName, leadFollowUpDue } from "../lib/crm";
import { addLeadNote, assignLead, changeLeadStatus, convertLeadToAccount, createDraftQuoteForLead, setLeadFollowUp, updateLead } from "../lib/crm.server";
import { PrismaActionIntentRepository } from "../lib/ops/prisma-repositories.server";
import { requireRouteAccess, routeAccessDecision } from "../lib/route-access.server";
import { CRM_HREF } from "../lib/simple-nav";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  const auth = await authenticate.admin(request);
  const staff = requireRouteAccess(auth, "erp/crm/:id");
  const shop = auth.session.shop;
  const lead = await db.crmLead.findFirst({ where: { shop, id: String(params.id || "") } });
  if (!lead) throw new Response("Lead not found.", { status: 404 });
  const [events, account, quote] = await Promise.all([
    db.crmLeadEvent.findMany({ where: { shop, leadId: lead.id }, orderBy: { createdAt: "desc" }, take: 100 }),
    lead.accountId ? db.crmAccount.findFirst({ where: { shop, id: lead.accountId }, select: { id: true, company: true, contactName: true, email: true } }) : null,
    // status only — no price, cost or margin leaves the server from this page
    lead.quoteId ? db.quote.findFirst({ where: { shop, id: lead.quoteId }, select: { id: true, status: true } }) : null,
  ]);
  return Response.json({
    lead: {
      id: lead.id, name: leadDisplayName(lead), company: lead.company, contactName: lead.contactName, email: lead.email, phone: lead.phone, source: lead.source,
      productInterest: lead.productInterest, notes: lead.notes, status: lead.status, statusLabel: LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] || lead.status,
      assignedStaffName: lead.assignedStaffName, assignedToMe: Boolean(staff.userId) && lead.assignedStaffId === staff.userId,
      nextFollowUpDate: lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).toISOString().slice(0, 10) : "",
      followUpDue: leadFollowUpDue(lead), outcomeReason: lead.outcomeReason, createdAt: new Date(lead.createdAt).toISOString(), createdBy: lead.createdBy,
    },
    account,
    quote,
    events: events.map((event: any) => ({ id: event.id, event: event.event, fromStatus: event.fromStatus, toStatus: event.toStatus, detail: event.detail, actor: event.actor, at: new Date(event.createdAt).toISOString() })),
    sources: LEAD_SOURCES,
    statuses: LEAD_STATUSES.map((status) => ({ value: status, label: LEAD_STATUS_LABEL[status] })),
    me: staff.actor,
  });
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const auth = await authenticate.admin(request);
  const access = routeAccessDecision(auth, "erp/crm/:id");
  if (!access.allowed) return Response.json({ ok: false, message: access.message }, { status: 403 });
  const staff = access.staff;
  const shop = auth.session.shop;
  const id = String(params.id || "");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const base = { shop, id, actor: staff.actor };
  if (intent === "save") return Response.json(await updateLead(db, { ...base, fields: Object.fromEntries(form) }));
  if (intent === "assignToMe") {
    if (!staff.userId) return Response.json({ ok: false, message: "A verified staff sign-in is required." }, { status: 403 });
    return Response.json(await assignLead(db, { ...base, staffName: staff.actor, staffId: staff.userId }));
  }
  if (intent === "assign") return Response.json(await assignLead(db, { ...base, staffName: form.get("staffName") }));
  if (intent === "status") return Response.json(await changeLeadStatus(db, { ...base, to: form.get("status"), reason: form.get("reason") }));
  if (intent === "followUp") return Response.json(await setLeadFollowUp(db, { ...base, date: form.get("date") }));
  if (intent === "note") return Response.json(await addLeadNote(db, { ...base, note: form.get("note") }));
  if (intent === "convertAccount") return Response.json(await convertLeadToAccount(db, base));
  if (intent === "createQuote") return Response.json(await createDraftQuoteForLead(db, base));
  if (intent === "askApproval") {
    // A draft message for the owner / a manager to approve. Approval sends nothing.
    const lead = await db.crmLead.findFirst({ where: { shop, id }, select: { id: true } });
    if (!lead) return Response.json({ ok: false, message: "The lead was not found." }, { status: 404 });
    const draft = String(form.get("draft") || "").trim().slice(0, 4000);
    if (!draft) return Response.json({ ok: false, message: "Write the draft message first." });
    const result = await submitApproval(new PrismaActionIntentRepository(), {
      shop,
      actionType: "submit_outreach_draft",
      entityType: "crm_lead",
      entityId: lead.id,
      payload: { channel: String(form.get("channel") || "email").slice(0, 20), message: draft },
      reason: String(form.get("why") || "").trim().slice(0, 300) || "Draft message for approval",
      idempotencyKey: `lead-draft:${lead.id}:${String(form.get("draftKey") || "").slice(0, 60)}`,
      proposedBy: { type: "staff", id: staff.userId || "staff", name: staff.actor, source: "erp:crm" },
    });
    return Response.json({ ok: result.ok, message: result.ok ? (result.duplicate ? "This draft was already sent for approval." : "Sent for approval. Nothing was sent to the customer.") : result.message });
  }
  return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16, display: "grid", gap: 12 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };
const primary: CSSProperties = { minHeight: 48, padding: "0 16px", borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 15, fontWeight: 800, cursor: "pointer" };
const secondary: CSSProperties = { minHeight: 48, padding: "0 16px", borderRadius: 12, border: "1px solid #d1d5db", background: "white", fontSize: 15, fontWeight: 700, cursor: "pointer" };
const heading: CSSProperties = { fontSize: 16, fontWeight: 800 };
const EVENT_LABEL: Record<string, string> = { created: "Created", edited: "Details edited", assigned: "Assigned", unassigned: "Unassigned", status_changed: "Status changed", follow_up_set: "Follow-up set", follow_up_cleared: "Follow-up cleared", note: "Note", account_linked: "Customer account", quote_created: "Quote created" };

export default function CrmLead() {
  const { lead, account, quote, events, sources, statuses } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";
  return (
    <Page title={lead.name} subtitle={`${lead.followUpDue ? "Follow-up due · " : ""}${lead.statusLabel}${lead.assignedStaffName ? ` · Assigned to ${lead.assignedStaffName}` : " · Not assigned"}`} backAction={{ content: "Leads", onAction: () => navigate(CRM_HREF) }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 860 }}>
        {result?.message ? <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b" }}>{result.message}</div> : null}

        <div style={card}>
          <div style={heading}>Next step</div>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "end" }}>
            <label style={label}>Status
              <select name="status" defaultValue={lead.status} style={input}>{(statuses as any[]).map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select>
            </label>
            <label style={label}>Reason (needed for Lost)<input name="reason" defaultValue={lead.outcomeReason || ""} style={input} /></label>
            <button type="submit" name="intent" value="status" disabled={busy} style={primary}>Update status</button>
          </Form>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "end" }}>
            <label style={label}>Follow up on<input name="date" type="date" defaultValue={lead.nextFollowUpDate} style={input} /></label>
            <button type="submit" name="intent" value="followUp" disabled={busy} style={secondary}>Save follow-up date</button>
          </Form>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "end" }}>
            <Form method="post"><button type="submit" name="intent" value="assignToMe" disabled={busy || lead.assignedToMe} style={{ ...secondary, width: "100%" }}>{lead.assignedToMe ? "Assigned to you" : "Assign to me"}</button></Form>
            <Form method="post" style={{ display: "grid", gap: 8 }}>
              <label style={label}>Assign to (name; empty to unassign)<input name="staffName" defaultValue={lead.assignedStaffName || ""} style={input} /></label>
              <button type="submit" name="intent" value="assign" disabled={busy} style={secondary}>Save assignment</button>
            </Form>
          </div>
        </div>

        <div style={card}>
          <div style={heading}>Customer and quote</div>
          <div style={{ fontSize: 14 }}>{account ? `Customer account: ${account.company || account.contactName || account.email || "created"}` : "No customer account yet."}</div>
          <div style={{ fontSize: 14 }}>{quote ? `Quote linked (${String(quote.status).replace(/_/g, " ")}).` : "No quote yet."}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            {!account ? <Form method="post"><button type="submit" name="intent" value="convertAccount" disabled={busy} style={{ ...secondary, width: "100%" }}>Make this a customer</button></Form> : null}
            {!quote ? <Form method="post"><button type="submit" name="intent" value="createQuote" disabled={busy} style={{ ...secondary, width: "100%" }}>Create draft quote</button></Form> : <button type="button" onClick={() => navigate("/app/quotes")} style={secondary}>Open Quotes</button>}
          </div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>A draft quote starts empty with this customer on it. Add the items and price it in Quotes. Production starts only from an approved quote.</div>
        </div>

        <details style={card}>
          <summary style={{ cursor: "pointer", ...heading, minHeight: 44 }}>Details</summary>
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={label}>Company<input name="company" defaultValue={lead.company || ""} style={input} /></label>
              <label style={label}>Contact name<input name="contactName" defaultValue={lead.contactName || ""} style={input} /></label>
              <label style={label}>Email<input name="email" type="email" defaultValue={lead.email || ""} style={input} /></label>
              <label style={label}>Phone<input name="phone" defaultValue={lead.phone || ""} style={input} /></label>
              <label style={label}>Where it came from
                <select name="source" defaultValue={lead.source} style={input}>{[...new Set([lead.source, ...(sources as string[])])].map((source) => <option key={source} value={source}>{String(source).replace(/_/g, " ")}</option>)}</select>
              </label>
              <label style={label}>Interested in<input name="productInterest" defaultValue={lead.productInterest || ""} style={input} /></label>
            </div>
            <label style={label}>Notes<textarea name="notes" rows={4} defaultValue={lead.notes || ""} style={{ ...input, minHeight: 100, padding: 12 }} /></label>
            <button type="submit" name="intent" value="save" disabled={busy} style={primary}>Save details</button>
          </Form>
        </details>

        <details style={card}>
          <summary style={{ cursor: "pointer", ...heading, minHeight: 44 }}>Ask for approval of a message</summary>
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <input type="hidden" name="draftKey" value={`${lead.id}-${events.length}`} />
            <div style={{ fontSize: 13, color: "#6b7280" }}>The owner or a manager reviews the draft. The ERP never sends it: once approved, a person sends it by hand.</div>
            <label style={label}>How it would be sent
              <select name="channel" defaultValue="email" style={input}><option value="email">Email</option><option value="text">Text</option><option value="phone">Phone call notes</option></select>
            </label>
            <label style={label}>Draft message<textarea name="draft" rows={5} style={{ ...input, minHeight: 120, padding: 12 }} /></label>
            <label style={label}>Why (optional)<input name="why" style={input} /></label>
            <button type="submit" name="intent" value="askApproval" disabled={busy} style={secondary}>Send for approval</button>
          </Form>
        </details>

        <div style={card}>
          <div style={heading}>History</div>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <input name="note" placeholder="Add a note (for example: called, left a voicemail)" style={input} />
            <button type="submit" name="intent" value="note" disabled={busy} style={secondary}>Add note</button>
          </Form>
          {(events as any[]).map((event) => (
            <div key={event.id} style={{ fontSize: 14, borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
              <div style={{ fontWeight: 700 }}>{EVENT_LABEL[event.event] || event.event}{event.toStatus ? ` → ${String(event.toStatus).replace(/_/g, " ")}` : ""}</div>
              {event.detail ? <div style={{ overflowWrap: "anywhere" }}>{event.detail}</div> : null}
              <div style={{ fontSize: 12, color: "#6b7280" }}>{new Date(event.at).toLocaleString()}{event.actor ? ` · ${event.actor}` : ""}</div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (!isRouteErrorResponse(error) || (error.status !== 403 && error.status !== 404)) return boundary.error(error);
  return (
    <Page title="Lead" backAction={{ content: "Leads", onAction: () => navigate(CRM_HREF) }}>
      <div style={{ ...card, fontSize: 16 }}>{error.status === 404 ? "This lead was not found." : "Leads and customers are for the owner, managers and sales."}</div>
    </Page>
  );
}
