// 2026-11-20 — one customer: contact details, where they came from (leads),
// quotes, jobs, everything made for them, the reorder entry point, notes and
// history. Owner, manager, sales. Read-mostly: the only writes are the
// customer's own details, active / inactive and notes. No cost, price or margin.

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LEAD_STATUS_LABEL } from "../lib/crm";
import { accountDisplayName, accountLinks, addAccountNote, setAccountActive, updateAccount } from "../lib/crm-accounts.server";
import { roleMayViewProduction } from "../lib/production-role-access";
import { requireRouteAccess, routeAccessDecision } from "../lib/route-access.server";
import { CUSTOMERS_HREF, REORDER_HREF, crmLeadHref, jobWorkspaceHref } from "../lib/simple-nav";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  const auth = await authenticate.admin(request);
  const staff = requireRouteAccess(auth, "erp/customers/:id");
  const shop = auth.session.shop;
  const account = await db.crmAccount.findFirst({ where: { shop, id: String(params.id || "") } });
  if (!account) throw new Response("Customer not found.", { status: 404 });
  const [links, events] = await Promise.all([
    accountLinks(db, shop, account, { take: 50 }),
    db.crmAccountEvent.findMany({ where: { shop, accountId: account.id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const iso = (value: any) => (value ? new Date(value).toISOString() : null);
  return Response.json({
    customer: { id: account.id, name: accountDisplayName(account), company: account.company, contactName: account.contactName, email: account.email, phone: account.phone, notes: account.notes, active: Boolean(account.active), source: account.source, createdAt: iso(account.createdAt), lastActivityAt: iso(links.lastActivityAt) },
    leads: links.leads.map((lead: any) => ({ id: lead.id, name: lead.company || lead.contactName || lead.email || "Lead", status: LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] || lead.status, source: lead.source, updatedAt: iso(lead.updatedAt) })),
    quotes: links.quotes.map((quote: any) => ({ id: quote.id, status: String(quote.status || "").replace(/_/g, " "), createdAt: iso(quote.createdAt) })),
    jobs: links.jobs.map((job: any) => ({ id: job.id, jobTicket: job.jobTicket, status: String(job.status || "").replace(/_/g, " "), createdAt: iso(job.createdAt), dueDate: iso(job.dueDate), itemCount: (job.items || []).length })),
    items: links.items,
    reorders: links.reorders,
    events: (events as any[]).map((event) => ({ id: event.id, event: event.event, detail: event.detail, actor: event.actor, at: iso(event.createdAt) })),
    // display only: Sales may not open production pages (the server turns them away), so they get no job link
    canOpenProduction: roleMayViewProduction(staff.role),
    matchRule: [account.email ? `email ${account.email}` : null, account.company ? `company "${account.company}"` : null].filter(Boolean).join(" or "),
  });
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const auth = await authenticate.admin(request);
  const access = routeAccessDecision(auth, "erp/customers/:id");
  if (!access.allowed) return Response.json({ ok: false, message: access.message }, { status: 403 });
  const base = { shop: auth.session.shop, id: String(params.id || ""), actor: access.staff.actor };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "save") return Response.json(await updateAccount(db, { ...base, fields: Object.fromEntries(form) }));
  if (intent === "note") return Response.json(await addAccountNote(db, { ...base, note: form.get("note") }));
  if (intent === "deactivate" || intent === "reactivate") return Response.json(await setAccountActive(db, { ...base, active: intent === "reactivate" }));
  return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16, display: "grid", gap: 10 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };
const plain: CSSProperties = { minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" };
const heading: CSSProperties = { fontSize: 16, fontWeight: 800 };
const row: CSSProperties = { fontSize: 14, borderTop: "1px solid #f3f4f6", paddingTop: 8, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" };
const day = (value: string | null) => (value ? new Date(value).toLocaleDateString() : "");
const EVENT_LABEL: Record<string, string> = { created: "Customer added", edited: "Details edited", note: "Note", deactivated: "Marked inactive", reactivated: "Active again" };

export default function Customer() {
  const { customer, leads, quotes, jobs, items, reorders, events, canOpenProduction, matchRule } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";
  return (
    <Page title={customer.name} subtitle={`${customer.active ? "Active" : "Inactive"}${customer.source ? ` · From ${String(customer.source).replace(/_/g, " ")}` : ""}${customer.lastActivityAt ? ` · Last activity ${day(customer.lastActivityAt)}` : ""}`} backAction={{ content: "Customers", onAction: () => navigate(CUSTOMERS_HREF) }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 860 }}>
        {result?.message ? <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b" }}>{result.message}</div> : null}

        <div style={card}>
          <div style={heading}>Contact</div>
          <div style={{ fontSize: 15, overflowWrap: "anywhere" }}>{[customer.contactName, customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details yet."}</div>
          {customer.notes ? <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{customer.notes}</div> : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            <button type="button" onClick={() => navigate(`${REORDER_HREF}?q=${encodeURIComponent(customer.company || customer.contactName || "")}`)} style={{ ...plain, background: "#111827", color: "white", border: "1px solid #111827" }}>Reorder a past item</button>
            <button type="button" onClick={() => navigate("/app/quotes")} style={plain}>Open Quotes</button>
          </div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{matchRule ? `Quotes and jobs below are the ones with the same ${matchRule}.` : "Add an email or a company name to see this customer's quotes and jobs."}</div>
        </div>

        <div style={card}>
          <div style={heading}>Jobs ({jobs.length})</div>
          {!jobs.length ? <div style={{ fontSize: 14, color: "#6b7280" }}>No production jobs yet.</div> : null}
          {(jobs as any[]).map((job) => (
            <div key={job.id} style={row}>
              <div><b>{job.jobTicket || "Job"}</b> · {job.status} · {job.itemCount} item(s){job.createdAt ? ` · ${day(job.createdAt)}` : ""}{job.dueDate ? ` · due ${day(job.dueDate)}` : ""}</div>
              {canOpenProduction ? <button type="button" onClick={() => navigate(jobWorkspaceHref(job.id))} style={plain}>Open job</button> : null}
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={heading}>What we have made for them ({items.length}){reorders ? ` · ${reorders} reorder(s)` : ""}</div>
          {!items.length ? <div style={{ fontSize: 14, color: "#6b7280" }}>Nothing yet.</div> : null}
          {(items as any[]).map((item) => (
            <div key={item.id} style={row}>
              <div style={{ overflowWrap: "anywhere" }}><b>{item.itemTicket || item.jobTicket || "Item"}</b> · {item.productTitle} · {item.quantity}{item.reorderOf ? " · reorder" : ""}</div>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={heading}>Quotes ({quotes.length})</div>
          {!quotes.length ? <div style={{ fontSize: 14, color: "#6b7280" }}>No quotes yet.</div> : null}
          {(quotes as any[]).map((quote) => <div key={quote.id} style={row}><div>Quote · {quote.status}{quote.createdAt ? ` · ${day(quote.createdAt)}` : ""}</div></div>)}
        </div>

        <div style={card}>
          <div style={heading}>Leads ({leads.length})</div>
          {!leads.length ? <div style={{ fontSize: 14, color: "#6b7280" }}>This customer did not come from a lead.</div> : null}
          {(leads as any[]).map((lead) => (
            <div key={lead.id} style={row}>
              <div>{lead.name} · {lead.status}{lead.source ? ` · from ${String(lead.source).replace(/_/g, " ")}` : ""}</div>
              <button type="button" onClick={() => navigate(crmLeadHref(lead.id))} style={plain}>Open lead</button>
            </div>
          ))}
        </div>

        <details style={card}>
          <summary style={{ cursor: "pointer", ...heading, minHeight: 44 }}>Edit details</summary>
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={label}>Company<input name="company" defaultValue={customer.company || ""} style={input} /></label>
              <label style={label}>Primary contact<input name="contactName" defaultValue={customer.contactName || ""} style={input} /></label>
              <label style={label}>Email<input name="email" type="email" defaultValue={customer.email || ""} style={input} /></label>
              <label style={label}>Phone<input name="phone" defaultValue={customer.phone || ""} style={input} /></label>
            </div>
            <label style={label}>Notes<textarea name="notes" rows={4} defaultValue={customer.notes || ""} style={{ ...input, minHeight: 100, padding: 12 }} /></label>
            <button type="submit" name="intent" value="save" disabled={busy} style={{ ...plain, background: "#111827", color: "white", border: "1px solid #111827" }}>Save details</button>
            <button type="submit" name="intent" value={customer.active ? "deactivate" : "reactivate"} disabled={busy} style={plain}>{customer.active ? "Mark inactive (nothing is deleted)" : "Make active again"}</button>
          </Form>
        </details>

        <div style={card}>
          <div style={heading}>Notes and history</div>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <input name="note" placeholder="Add a note" style={input} />
            <button type="submit" name="intent" value="note" disabled={busy} style={plain}>Add note</button>
          </Form>
          {(events as any[]).map((event) => (
            <div key={event.id} style={{ fontSize: 14, borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
              <div style={{ fontWeight: 700 }}>{EVENT_LABEL[event.event] || event.event}</div>
              {event.detail ? <div style={{ overflowWrap: "anywhere" }}>{event.detail}</div> : null}
              <div style={{ fontSize: 12, color: "#6b7280" }}>{event.at ? new Date(event.at).toLocaleString() : ""}{event.actor ? ` · ${event.actor}` : ""}</div>
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
    <Page title="Customer" backAction={{ content: "Customers", onAction: () => navigate(CUSTOMERS_HREF) }}>
      <div style={{ ...card, fontSize: 16 }}>{error.status === 404 ? "This customer was not found." : "Customers are for the owner, managers and sales."}</div>
    </Page>
  );
}
