// 2026-11-19 — CRM: leads / opportunities (owner, manager, sales).
//
// INTERNAL ONLY. This page records who the shop is talking to and what happens
// next. It sends nothing: no email, text, DM or form leaves the ERP from here.
// No cost, price or margin is read or shown.

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError, useSearchParams } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LEAD_SOURCES, LEAD_STATUSES, LEAD_STATUS_LABEL, OPEN_LEAD_STATUSES, isLeadStatus, leadDisplayName, leadFollowUpDue } from "../lib/crm";
import { createLead } from "../lib/crm.server";
import { requireRouteAccess, routeAccessDecision } from "../lib/route-access.server";
import { crmLeadHref } from "../lib/simple-nav";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const staff = requireRouteAccess(auth, "erp/crm");
  const shop = auth.session.shop;
  const url = new URL(request.url);
  const view = String(url.searchParams.get("view") || "open");
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const contains = { contains: q, mode: "insensitive" as const };
  const where: any = {
    shop,
    ...(view === "mine" ? { assignedStaffId: staff.userId || "__none__", status: { in: [...OPEN_LEAD_STATUSES] } } : {}),
    ...(view === "open" || view === "due" ? { status: { in: [...OPEN_LEAD_STATUSES] } } : {}),
    ...(isLeadStatus(view) ? { status: view } : {}),
    ...(q ? { OR: [{ company: contains }, { contactName: contains }, { email: contains }, { phone: contains }] } : {}),
  };
  const rows = await db.crmLead.findMany({ where, orderBy: [{ nextFollowUpAt: "asc" }, { updatedAt: "desc" }], take: 200 });
  const now = new Date();
  const leads = rows
    .map((lead: any) => ({
      id: lead.id,
      name: leadDisplayName(lead),
      contactName: lead.contactName,
      company: lead.company,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      status: lead.status,
      statusLabel: LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] || lead.status,
      assignedStaffName: lead.assignedStaffName,
      nextFollowUpAt: lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).toISOString() : null,
      followUpDue: leadFollowUpDue(lead, now),
      hasQuote: Boolean(lead.quoteId),
    }))
    .filter((lead: any) => (view === "due" ? lead.followUpDue : true));
  const dueCount = await db.crmLead.count({ where: { shop, status: { in: [...OPEN_LEAD_STATUSES] }, nextFollowUpAt: { lte: now } } });
  return Response.json({ leads, view, q, dueCount, sources: LEAD_SOURCES, statuses: LEAD_STATUSES.map((status) => ({ value: status, label: LEAD_STATUS_LABEL[status] })) });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const access = routeAccessDecision(auth, "erp/crm");
  if (!access.allowed) return Response.json({ ok: false, message: access.message }, { status: 403 });
  const form = await request.formData();
  if (String(form.get("intent") || "") !== "createLead") return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const result = await createLead(db, { shop: auth.session.shop, actor: access.staff.actor, fields: Object.fromEntries(form) });
  return Response.json({ ok: result.ok, message: result.message, leadId: result.ok ? result.lead?.id : null });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };
const chip = (active: boolean): CSSProperties => ({ minHeight: 40, padding: "0 14px", borderRadius: 999, border: `1px solid ${active ? "#111827" : "#d1d5db"}`, background: active ? "#111827" : "white", color: active ? "white" : "#111827", fontSize: 14, fontWeight: 700, cursor: "pointer" });

export default function CrmLeads() {
  const { leads, view, q, dueCount, sources } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const busy = navigation.state !== "idle";
  const go = (next: string) => setParams((prev) => { const params = new URLSearchParams(prev); params.set("view", next); return params; });
  return (
    <Page title="Leads" subtitle="Who we are talking to and what happens next. Nothing on this page sends a message." backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 900 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={chip(view === "open")} onClick={() => go("open")}>Open</button>
          <button type="button" style={chip(view === "due")} onClick={() => go("due")}>Follow-up due{dueCount ? ` (${dueCount})` : ""}</button>
          <button type="button" style={chip(view === "mine")} onClick={() => go("mine")}>Assigned to me</button>
          <button type="button" style={chip(view === "won")} onClick={() => go("won")}>Won</button>
          <button type="button" style={chip(view === "lost")} onClick={() => go("lost")}>Lost</button>
          <button type="button" style={chip(view === "all")} onClick={() => go("all")}>All</button>
        </div>
        <Form method="get" style={{ display: "flex", gap: 8 }}>
          <input type="hidden" name="view" value={view} />
          <input name="q" defaultValue={q} placeholder="Search company, name, email or phone" style={input} />
          <button type="submit" style={{ ...chip(false), borderRadius: 10 }}>Search</button>
        </Form>

        {result?.message ? (
          <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b" }}>
            {result.message}
            {result.ok && result.leadId ? <div><button type="button" onClick={() => navigate(crmLeadHref(result.leadId))} style={{ marginTop: 8, minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #166534", background: "#166534", color: "white", fontWeight: 700, cursor: "pointer" }}>Open the lead</button></div> : null}
          </div>
        ) : null}

        {!leads.length ? (
          <div style={{ ...card, fontSize: 15, color: "#6b7280" }}>No leads in this view.</div>
        ) : (leads as any[]).map((lead) => (
          <button key={lead.id} type="button" onClick={() => navigate(crmLeadHref(lead.id))} style={{ ...card, textAlign: "left", cursor: "pointer", display: "grid", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 17, fontWeight: 800, overflowWrap: "anywhere" }}>{lead.name}</div>
              <div style={{ fontSize: 13, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: lead.followUpDue ? "#fef3c7" : "#f3f4f6", color: lead.followUpDue ? "#92400e" : "#374151" }}>{lead.followUpDue ? "Follow-up due" : lead.statusLabel}</div>
            </div>
            <div style={{ fontSize: 14, color: "#6b7280", overflowWrap: "anywhere" }}>
              {[lead.contactName && lead.contactName !== lead.name ? lead.contactName : null, lead.email, lead.phone].filter(Boolean).join(" · ") || "No contact details yet"}
            </div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              {lead.assignedStaffName ? `Assigned to ${lead.assignedStaffName}` : "Not assigned"}
              {lead.nextFollowUpAt ? ` · Follow up ${new Date(lead.nextFollowUpAt).toLocaleDateString()}` : ""}
              {lead.hasQuote ? " · Has a quote" : ""}
            </div>
          </button>
        ))}

        <details style={card}>
          <summary style={{ cursor: "pointer", fontSize: 16, fontWeight: 800, minHeight: 44 }}>Add a lead</summary>
          <Form method="post" style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <input type="hidden" name="intent" value="createLead" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={label}>Company<input name="company" style={input} /></label>
              <label style={label}>Contact name<input name="contactName" style={input} /></label>
              <label style={label}>Email<input name="email" type="email" style={input} /></label>
              <label style={label}>Phone<input name="phone" style={input} /></label>
              <label style={label}>Where it came from
                <select name="source" defaultValue="manual" style={input}>{(sources as string[]).map((source) => <option key={source} value={source}>{source.replace(/_/g, " ")}</option>)}</select>
              </label>
              <label style={label}>Interested in<input name="productInterest" placeholder="For example: 4x5 sticker bags, 500" style={input} /></label>
            </div>
            <label style={label}>Notes<textarea name="notes" rows={3} style={{ ...input, minHeight: 84, padding: 12 }} /></label>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Enter at least one of: company, contact name, email, phone.</div>
            <button type="submit" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>Add lead</button>
          </Form>
        </details>
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (!(isRouteErrorResponse(error) && error.status === 403)) return boundary.error(error);
  return (
    <Page title="Leads" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Leads and customers are for the owner, managers and sales.</div>
    </Page>
  );
}
