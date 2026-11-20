// 2026-11-20 — Customers (owner, manager, sales).
//
// One row per customer account (CrmAccount). What belongs to a customer —
// leads, quotes, production jobs, reorders — is found by an exact e-mail or
// company match (crm-accounts.server.ts); nothing on a quote or job is changed.
// No cost, price or margin is read. Nothing here sends a message.

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { accountDisplayName, accountLinks, createAccount, customersNotYetAdded } from "../lib/crm-accounts.server";
import { requireRouteAccess, routeAccessDecision } from "../lib/route-access.server";
import { customerHref } from "../lib/simple-nav";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireRouteAccess(auth, "erp/customers");
  const shop = auth.session.shop;
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const show = url.searchParams.get("show") === "inactive" ? "inactive" : "active";
  const contains = { contains: q, mode: "insensitive" as const };
  const rows = await db.crmAccount.findMany({
    where: { shop, active: show === "active", ...(q ? { OR: [{ company: contains }, { contactName: contains }, { email: contains }, { phone: contains }] } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const customers = [];
  for (const account of rows as any[]) {
    const links = await accountLinks(db, shop, account, { take: 25 });
    customers.push({
      id: account.id, name: accountDisplayName(account), contactName: account.contactName, email: account.email, phone: account.phone,
      source: account.source || (links.leads[0]?.source ?? null), status: account.active ? "Active" : "Inactive",
      leads: links.leads.length, quotes: links.quotes.length, jobs: links.jobs.length, reorders: links.reorders,
      lastActivityAt: links.lastActivityAt ? links.lastActivityAt.toISOString() : null,
    });
  }
  const notYetAdded = q || show === "inactive" ? [] : await customersNotYetAdded(db, shop, 20);
  return Response.json({ customers, q, show, notYetAdded });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const access = routeAccessDecision(auth, "erp/customers");
  if (!access.allowed) return Response.json({ ok: false, message: access.message }, { status: 403 });
  const form = await request.formData();
  if (String(form.get("intent") || "") !== "createCustomer") return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const result = await createAccount(db, { shop: auth.session.shop, actor: access.staff.actor, fields: Object.fromEntries(form), source: String(form.get("source") || "manual") });
  return Response.json({ ok: result.ok, message: result.message, accountId: result.ok ? result.accountId : null });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };
const plain: CSSProperties = { minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function Customers() {
  const { customers, q, show, notYetAdded } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";
  return (
    <Page title="Customers" subtitle="Everyone we sell to, with their leads, quotes, jobs and reorders." backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 900 }}>
        <Form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input name="q" defaultValue={q} placeholder="Search company, contact, email or phone" style={{ ...input, flex: "1 1 240px", width: "auto" }} />
          <select name="show" defaultValue={show} style={{ ...input, width: "auto" }}><option value="active">Active</option><option value="inactive">Inactive</option></select>
          <button type="submit" style={plain}>Search</button>
        </Form>

        {result?.message ? (
          <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b" }}>
            {result.message}
            {result.ok && result.accountId ? <div><button type="button" onClick={() => navigate(customerHref(result.accountId))} style={{ ...plain, marginTop: 8 }}>Open the customer</button></div> : null}
          </div>
        ) : null}

        {!(customers as any[]).length ? <div style={{ ...card, fontSize: 15, color: "#6b7280" }}>{q ? "No customer matches that search." : "No customers yet. Add one below, or make a lead a customer."}</div> : null}
        {(customers as any[]).map((customer) => (
          <button key={customer.id} type="button" onClick={() => navigate(customerHref(customer.id))} style={{ ...card, textAlign: "left", cursor: "pointer", display: "grid", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 17, fontWeight: 800, overflowWrap: "anywhere" }}>{customer.name}</div>
              <div style={{ fontSize: 13, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "#f3f4f6", color: "#374151" }}>{customer.status}</div>
            </div>
            <div style={{ fontSize: 14, color: "#6b7280", overflowWrap: "anywhere" }}>{[customer.contactName && customer.contactName !== customer.name ? customer.contactName : null, customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details yet"}</div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              {[count(customer.leads, "lead", "leads"), count(customer.quotes, "quote", "quotes"), count(customer.jobs, "job", "jobs"), count(customer.reorders, "reorder", "reorders")].join(" · ")}
              {customer.source ? ` · From ${String(customer.source).replace(/_/g, " ")}` : ""}
              {customer.lastActivityAt ? ` · Last activity ${new Date(customer.lastActivityAt).toLocaleDateString()}` : ""}
            </div>
          </button>
        ))}

        {(notYetAdded as any[]).length ? (
          <details style={card}>
            <summary style={{ cursor: "pointer", fontSize: 16, fontWeight: 800, minHeight: 44 }}>On quotes or jobs, not a customer yet ({notYetAdded.length})</summary>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>Add the ones that are real customers. Nothing is added for you.</div>
            <div style={{ display: "grid", gap: 8 }}>
              {(notYetAdded as any[]).map((row, index) => (
                <Form method="post" key={`${row.email || row.company}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
                  <input type="hidden" name="intent" value="createCustomer" />
                  <input type="hidden" name="company" value={row.company || ""} />
                  <input type="hidden" name="contactName" value={row.contactName || ""} />
                  <input type="hidden" name="email" value={row.email || ""} />
                  <input type="hidden" name="phone" value={row.phone || ""} />
                  <input type="hidden" name="source" value={row.from} />
                  <div style={{ fontSize: 14, overflowWrap: "anywhere" }}><b>{row.company || row.email}</b>{row.email && row.company ? ` · ${row.email}` : ""} <span style={{ color: "#6b7280" }}>(from a {row.from})</span></div>
                  <button type="submit" disabled={busy} style={plain}>Add as customer</button>
                </Form>
              ))}
            </div>
          </details>
        ) : null}

        <details style={card}>
          <summary style={{ cursor: "pointer", fontSize: 16, fontWeight: 800, minHeight: 44 }}>Add a customer</summary>
          <Form method="post" style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <input type="hidden" name="intent" value="createCustomer" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={label}>Company<input name="company" style={input} /></label>
              <label style={label}>Primary contact<input name="contactName" style={input} /></label>
              <label style={label}>Email<input name="email" type="email" style={input} /></label>
              <label style={label}>Phone<input name="phone" style={input} /></label>
            </div>
            <label style={label}>Notes<textarea name="notes" rows={3} style={{ ...input, minHeight: 84, padding: 12 }} /></label>
            <button type="submit" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>Add customer</button>
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
    <Page title="Customers" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Customers are for the owner, managers and sales.</div>
    </Page>
  );
}
