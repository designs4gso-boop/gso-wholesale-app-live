// 2026-11-19 — Privacy Requests (owner only).
//
// Shopify's privacy webhooks are recorded by webhooks.compliance.ts. This page
// lists them with their due date. Nothing is erased automatically: for a
// customer erasure request the owner sees how many records match (by exact
// e-mail / Shopify customer id) and applies the redaction, which blanks contact
// fields and keeps the records. See app/lib/privacy-compliance.server.ts.

import { Form, useActionData, useLoaderData, useNavigate, useNavigation } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireOwner } from "../lib/owner-authorization.server";
import { applyCustomerRedaction, closeComplianceRequest, planCustomerRedaction } from "../lib/privacy-compliance.server";

const TOPIC_LABEL: Record<string, string> = {
  "customers/data_request": "Customer asked for their data",
  "customers/redact": "Customer asked to be erased",
  "shop/redact": "Shop data erasure (sent after an uninstall)",
};

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireOwner(auth);
  const shop = auth.session.shop;
  const rows = await db.complianceRequest.findMany({ where: { shop }, orderBy: { receivedAt: "desc" }, take: 100 });
  const requests = [];
  for (const row of rows as any[]) {
    const plan = row.status !== "completed" && row.topic !== "shop/redact" ? await planCustomerRedaction(db, shop, row) : null;
    requests.push({
      id: row.id,
      topic: row.topic,
      topicLabel: TOPIC_LABEL[row.topic] || row.topic,
      customerEmail: row.customerEmail,
      customerId: row.customerId,
      status: row.status,
      receivedAt: row.receivedAt ? new Date(row.receivedAt).toISOString() : null,
      dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null,
      completedBy: row.completedBy,
      resultSummary: row.resultSummary,
      plan,
    });
  }
  return Response.json({ requests });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const owner = requireOwner(auth);
  const shop = auth.session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const requestId = String(form.get("id") || "");
  if (intent === "applyRedaction") {
    if (String(form.get("confirm") || "").trim().toUpperCase() !== "ERASE") return Response.json({ ok: false, id: requestId, message: "Type ERASE to confirm. Nothing was changed." });
    return Response.json({ ...(await applyCustomerRedaction(db, { shop, requestId, actor: owner.actor })), id: requestId });
  }
  if (intent === "close") return Response.json({ ...(await closeComplianceRequest(db, { shop, requestId, actor: owner.actor, note: String(form.get("note") || "") })), id: requestId });
  return Response.json({ ok: false, id: requestId, message: "Unknown action." }, { status: 400 });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16, display: "grid", gap: 10 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const day = (value: string | null) => (value ? new Date(value).toLocaleDateString() : "—");

export default function PrivacyRequests() {
  const { requests } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";
  return (
    <Page title="Privacy Requests" subtitle="Requests Shopify sends when a customer asks for their data or asks to be erased." backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 820 }}>
        {!(requests as any[]).length ? <div style={{ ...card, fontSize: 15 }}>No privacy requests have been received.</div> : null}
        {(requests as any[]).map((row) => (
          <div key={row.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{row.topicLabel}</div>
              <div style={{ fontSize: 13, color: row.status === "completed" ? "#166534" : "#92400e", fontWeight: 700 }}>{row.status === "completed" ? "Completed" : `Open — due ${day(row.dueAt)}`}</div>
            </div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Received {day(row.receivedAt)}{row.customerEmail ? ` · ${row.customerEmail}` : ""}{row.customerId ? ` · customer ${row.customerId}` : ""}</div>
            {result?.id === row.id && result?.message ? <div role="status" style={{ padding: "8px 10px", borderRadius: 8, background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b", fontWeight: 600 }}>{result.message}</div> : null}
            {row.status === "completed" ? <div style={{ fontSize: 14 }}>{row.resultSummary}{row.completedBy ? ` — ${row.completedBy}` : ""}</div> : (
              <>
                {row.plan ? (
                  <div style={{ fontSize: 14 }}>
                    {row.plan.matchable
                      ? `Records holding this customer's contact details: ${row.plan.quotes} quote(s), ${row.plan.productionJobs} production job(s), ${row.plan.wholesaleApplications} wholesale application(s), ${row.plan.leads} lead(s).`
                      : "This request carries no e-mail address or customer id, so no record can be matched."}
                  </div>
                ) : <div style={{ fontSize: 14 }}>Sent 48 hours after the app is uninstalled. Nothing is erased automatically.</div>}
                {row.topic === "customers/redact" && row.plan?.matchable ? (
                  <Form method="post" style={{ display: "grid", gap: 8 }}>
                    <input type="hidden" name="id" value={row.id} />
                    <div style={{ fontSize: 13, color: "#6b7280" }}>Erasing blanks the name, e-mail and phone on those records. The quotes, jobs and their history are kept. This cannot be undone.</div>
                    <input name="confirm" placeholder="Type ERASE to confirm" style={input} />
                    <button type="submit" name="intent" value="applyRedaction" disabled={busy} style={{ minHeight: 48, borderRadius: 10, border: "1px solid #b91c1c", background: "white", color: "#b91c1c", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Erase this customer's contact details</button>
                  </Form>
                ) : null}
                <Form method="post" style={{ display: "grid", gap: 8 }}>
                  <input type="hidden" name="id" value={row.id} />
                  <input name="note" placeholder="What was done (for example: data sent to the customer on …)" style={input} />
                  <button type="submit" name="intent" value="close" disabled={busy} style={{ minHeight: 44, borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Mark as handled</button>
                </Form>
              </>
            )}
          </div>
        ))}
      </div>
    </Page>
  );
}
