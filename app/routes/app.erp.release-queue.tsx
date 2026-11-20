// 2026-11-19 — Release to Production (admin / workflow lane).
//
// Business transactions staged from outside (QuickBooks invoice / estimate, an
// agent proposal) wait here for a person. The reviewer marks every line as
// production or not production, names the production items, and releases —
// which calls the canonical job service (staged-transaction.server.ts). A
// staged transaction never creates a job on its own, and nothing here writes
// to QuickBooks. Owner / manager only; production roles receive the resulting
// job on the Production Board and never need this page. Amounts are shown only
// to the owner and financially authorized managers.
//
// Which QuickBooks state MAY be released (invoice created / deposit / paid /
// estimate accepted) is an owner decision that is not encoded here: the page
// shows the status and balance and the reviewer decides.

import { Form, isRouteErrorResponse, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { MANUAL_JOB_FAMILIES, MANUAL_JOB_FINISHES, parseAdditionalManualItems } from "../lib/production-job-source.server";
import { PRODUCTION_ROLE_DENIED, roleMayRunProductionIntent } from "../lib/production-role-access";
import { SIMPLE_BOARD_HREF, jobWorkspaceHref } from "../lib/simple-nav";
import { resolveStaffAccess } from "../lib/staff-roles.server";
import { STAGED_SOURCE_LABEL, dismissStagedTransaction, readStagedLines, releaseReadiness, releaseStagedTransaction, saveStagedReview, type StagedLine } from "../lib/staged-transaction.server";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const staff = resolveStaffAccess(auth);
  if (!roleMayRunProductionIntent(staff.role, "reviewStagedTransaction")) throw new Response(PRODUCTION_ROLE_DENIED, { status: 403 });
  const shop = auth.session.shop;
  const showAmounts = staff.can("viewFinancials");
  const rows = await db.stagedTransaction.findMany({ where: { shop }, orderBy: [{ status: "desc" }, { createdAt: "desc" }], take: 80 });
  const jobIds = rows.map((row: any) => row.releasedJobId).filter(Boolean) as string[];
  const jobs = jobIds.length ? await db.productionJob.findMany({ where: { shop, id: { in: jobIds } }, select: { id: true, jobTicket: true } }) : [];
  const ticketById = new Map(jobs.map((job: any) => [job.id, job.jobTicket]));
  // 2026-11-19 REORDER PICKER: earlier items a production item may be a reorder of. Offered = earlier jobs
  // of the SAME customer name (exact, case-insensitive) plus whatever the reviewer searched for. Nothing is
  // pre-selected and nothing is matched automatically — a person picks, or it is not a reorder.
  const find = String(new URL(request.url).searchParams.get("find") || "").trim().slice(0, 80);
  const staged = rows.filter((row: any) => row.status === "staged");
  const names = Array.from(new Set(staged.map((row: any) => String(row.customerName || "").trim()).filter(Boolean))) as string[];
  const containsFind = { contains: find, mode: "insensitive" as const };
  const pastJobs = names.length || find ? await db.productionJob.findMany({
    where: {
      shop,
      status: { not: "cancelled" },
      OR: [
        ...names.flatMap((name) => [{ customerName: { equals: name, mode: "insensitive" as const } }, { company: { equals: name, mode: "insensitive" as const } }]),
        ...(find ? [{ customerName: containsFind }, { company: containsFind }, { jobTicket: containsFind }, { items: { some: { productTitle: containsFind } } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 60,
    // identity only — no price or cost
    select: { id: true, jobTicket: true, customerName: true, company: true, items: { orderBy: { sortOrder: "asc" }, select: { id: true, itemTicket: true, productTitle: true, quantity: true, selectedFinish: true } } },
  }) : [];
  const reorderOptions = (pastJobs as any[]).flatMap((job) => (job.items || []).map((item: any) => ({ id: item.id, label: `${item.itemTicket || job.jobTicket || "item"} — ${item.productTitle} (${item.quantity})${item.selectedFinish ? ` · ${item.selectedFinish}` : ""} — ${job.company || job.customerName || ""}`.slice(0, 160) })));
  const transactions = rows.map((row: any) => {
    const lines = readStagedLines(row.lines).map((line) => ({ ...line, amount: showAmounts ? line.amount : null }));
    const ready = releaseReadiness(row);
    return {
      id: row.id,
      sourceLabel: STAGED_SOURCE_LABEL[row.source] || row.source,
      docNumber: row.docNumber,
      customerName: row.customerName,
      txnDate: row.txnDate ? new Date(row.txnDate).toISOString() : null,
      externalStatus: row.externalStatus,
      totalAmount: showAmounts ? row.totalAmount : null,
      balance: showAmounts ? row.balance : null,
      status: row.status,
      reviewNotes: row.reviewNotes,
      releasedBy: row.releasedBy,
      releasedJobId: row.releasedJobId,
      releasedJobTicket: row.releasedJobId ? ticketById.get(row.releasedJobId) || null : null,
      lines,
      blockers: ready.ok ? [] : ready.reasons,
    };
  });
  return Response.json({ transactions, showAmounts, families: MANUAL_JOB_FAMILIES, finishes: MANUAL_JOB_FINISHES, canChoosePrinter: staff.can("selectPrinter"), reorderOptions, find });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const staff = resolveStaffAccess(auth);
  const shop = auth.session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");
  const roleIntent = intent === "dismiss" ? "dismissStagedTransaction" : intent === "release" ? "releaseStagedTransaction" : "reviewStagedTransaction";
  if (!roleMayRunProductionIntent(staff.role, roleIntent)) return Response.json({ ok: false, id, message: `${PRODUCTION_ROLE_DENIED} ${staff.reason}` }, { status: 403 });
  if (!staff.userId) return Response.json({ ok: false, id, message: "A verified staff sign-in is required to review or release a transaction." }, { status: 403 });

  if (intent === "dismiss") {
    const result = await dismissStagedTransaction(db, { shop, id, actor: staff.actor, reason: String(form.get("reason") || "") });
    return Response.json({ ...result, id });
  }
  if (intent !== "review" && intent !== "release") return Response.json({ ok: false, id, message: "Unknown action." }, { status: 400 });

  const staged = await db.stagedTransaction.findFirst({ where: { shop, id } });
  if (!staged) return Response.json({ ok: false, id, message: "The transaction was not found." }, { status: 404 });
  const base = {
    family: String(form.get("family") || "default"),
    finish: String(form.get("finish") || "CMYK"),
    // only roles with selectPrinter get a choice; anyone else is always Auto (same rule as New Job)
    printer: (staff.can("selectPrinter") ? String(form.get("printer") || "auto") : "auto") as any,
    size: "",
  };
  const posted: StagedLine[] = [];
  const stored = readStagedLines(staged.lines);
  for (let index = 0; index < stored.length; index += 1) {
    const line = stored[index];
    const classification = String(form.get(`class_${index}`) || "needs_review");
    if (classification !== "production") {
      posted.push({ ...line, classification: classification === "non_production" ? "non_production" : "needs_review", productionItems: [] });
      continue;
    }
    const parsed = parseAdditionalManualItems(String(form.get(`items_${index}`) || ""), { ...base, quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)) });
    if (!parsed.ok) return Response.json({ ok: false, id, message: `Line ${index + 1}: ${parsed.reason}` });
    if (!parsed.items.length) return Response.json({ ok: false, id, message: `Line ${index + 1}: list the production items for this line (one per line: name | quantity).` });
    // 2026-11-19 REORDER PICKER: a person may mark an item as a reorder of an earlier item. The pick is
    // tied to the item it was made for; if the item list changed since, the pick is refused (never guessed).
    for (let itemIndex = 0; itemIndex < parsed.items.length; itemIndex += 1) {
      const sourceId = String(form.get(`reorder_${index}_${itemIndex}`) || "").trim();
      if (!sourceId) continue;
      const pickedFor = String(form.get(`reorderfor_${index}_${itemIndex}`) || "");
      if (pickedFor !== parsed.items[itemIndex].productTitle) return Response.json({ ok: false, id, message: `Line ${index + 1}: the item list changed after a reorder link was chosen. Save the review, then choose the earlier item again.` });
      const source = await db.productionJobItem.findFirst({ where: { shop, id: sourceId }, select: { id: true } });
      if (!source) return Response.json({ ok: false, id, message: `Line ${index + 1}: the earlier item chosen for "${pickedFor}" was not found.` });
      parsed.items[itemIndex] = { ...parsed.items[itemIndex], reorderSourceItemId: source.id, reorderArtworkMode: String(form.get(`artwork_${index}_${itemIndex}`) || "") === "revision" ? "revision" : "same_artwork" };
    }
    posted.push({ ...line, classification: "production", productionItems: parsed.items });
  }
  const saved = await saveStagedReview(db, { shop, id, lines: posted, reviewNotes: String(form.get("reviewNotes") || ""), actor: staff.actor });
  if (!saved.ok || intent === "review") return Response.json({ ...saved, id });
  const released = await releaseStagedTransaction(db, { shop, id, actor: staff.actor, dueDate: String(form.get("dueDate") || ""), notes: String(form.get("jobNotes") || "") });
  return Response.json({ ok: released.ok, id, message: released.message, jobId: released.ok ? released.job.id : null });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };
const money = (value: number | null | undefined) => (value === null || value === undefined ? "" : `$${Number(value).toFixed(2)}`);

function StagedCard({ txn, families, finishes, canChoosePrinter, showAmounts, result, busy, reorderOptions = [] }: { txn: any; families: any[]; finishes: string[]; canChoosePrinter: boolean; showAmounts: boolean; result: any; busy: boolean; reorderOptions?: Array<{ id: string; label: string }> }) {
  const navigate = useNavigate();
  const mine = result?.id === txn.id ? result : null;
  return (
    <div style={{ ...card, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{txn.customerName || "Customer not set"}</div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>{txn.sourceLabel}{txn.docNumber ? ` ${txn.docNumber}` : ""}{txn.txnDate ? ` · ${new Date(txn.txnDate).toLocaleDateString()}` : ""}{txn.externalStatus ? ` · ${txn.externalStatus}` : ""}</div>
        </div>
        {showAmounts ? <div style={{ fontSize: 14, textAlign: "right" }}>Total {money(txn.totalAmount) || "—"}<br />Balance {money(txn.balance) || "—"}</div> : null}
      </div>
      {mine?.message ? (
        <div role="status" style={{ padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: mine.ok ? "#f0fdf4" : "#fef2f2", color: mine.ok ? "#166534" : "#991b1b" }}>
          {mine.message}
          {mine.ok && mine.jobId ? <div><button type="button" onClick={() => navigate(jobWorkspaceHref(mine.jobId))} style={{ marginTop: 8, minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #166534", background: "#166534", color: "white", fontWeight: 700, cursor: "pointer" }}>Open the job</button></div> : null}
        </div>
      ) : null}
      {txn.status !== "staged" ? (
        <div style={{ fontSize: 14 }}>
          {txn.status === "released" ? `Released to production${txn.releasedJobTicket ? ` as ${txn.releasedJobTicket}` : ""}${txn.releasedBy ? ` by ${txn.releasedBy}` : ""}.` : `Not production work${txn.reviewNotes ? ` — ${txn.reviewNotes}` : ""}.`}
        </div>
      ) : (
        <>
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <input type="hidden" name="id" value={txn.id} />
            {(txn.lines as any[]).map((line, index) => (
              <div key={line.key} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{line.description || line.externalItemName || `Line ${index + 1}`}</div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>{line.externalItemName ? `${line.externalItemName} · ` : ""}Qty {line.quantity ?? "—"}{showAmounts && line.amount !== null ? ` · ${money(line.amount)}` : ""}</div>
                <label style={label}>This line is
                  <select name={`class_${index}`} defaultValue={line.classification} style={input}>
                    <option value="needs_review">Not decided yet</option>
                    <option value="production">Production work</option>
                    <option value="non_production">Not production (discount, shipping, fee, old balance…)</option>
                  </select>
                </label>
                <label style={label}>Production items for this line — one per line: name | quantity
                  <textarea name={`items_${index}`} rows={3} defaultValue={(line.productionItems || []).map((item: any) => `${item.productTitle} | ${item.quantity}`).join("\n")} placeholder={"SHORTCAKES pouch | 128\nMIXED BERRIES pouch | 128"} style={{ ...input, minHeight: 84, padding: 12 }} />
                </label>
                {(line.productionItems || []).length ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 13, color: "#6b7280" }}>Is any of these a reorder of something we made before? Choose the earlier item, or leave it as "Not a reorder".</div>
                    {(line.productionItems as any[]).map((item, itemIndex) => (
                      <div key={`${line.key}-${itemIndex}`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "end" }}>
                        <input type="hidden" name={`reorderfor_${index}_${itemIndex}`} value={item.productTitle} />
                        <label style={label}>{item.productTitle} · {item.quantity}
                          <select name={`reorder_${index}_${itemIndex}`} defaultValue={item.reorderSourceItemId || ""} style={input}>
                            <option value="">Not a reorder</option>
                            {item.reorderSourceItemId && !reorderOptions.some((option) => option.id === item.reorderSourceItemId) ? <option value={item.reorderSourceItemId}>Earlier item already chosen</option> : null}
                            {reorderOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                          </select>
                        </label>
                        <label style={label}>Artwork
                          <select name={`artwork_${index}_${itemIndex}`} defaultValue={item.reorderArtworkMode || "same_artwork"} style={input}>
                            <option value="same_artwork">Same artwork as before</option>
                            <option value="revision">Revised artwork (new proof needed)</option>
                          </select>
                        </label>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label style={label}>Product type
                <select name="family" defaultValue="default" style={input}>{families.map((family) => <option key={family.value} value={family.value}>{family.label}</option>)}</select>
              </label>
              <label style={label}>Finish
                <select name="finish" defaultValue="CMYK" style={input}>{finishes.map((finish) => <option key={finish} value={finish}>{finish}</option>)}</select>
              </label>
              {canChoosePrinter ? (
                <label style={label}>Printer
                  <select name="printer" defaultValue="auto" style={input}>
                    <option value="auto">Auto (recommended)</option>
                    <option value="mimaki">Mimaki UCJV300</option>
                    <option value="roland">Roland LG-640</option>
                  </select>
                </label>
              ) : null}
              <label style={label}>Due date (optional)<input name="dueDate" type="date" style={input} /></label>
            </div>
            <label style={label}>Notes for production (optional)<textarea name="jobNotes" rows={2} style={{ ...input, minHeight: 64, padding: 12 }} /></label>
            {txn.blockers.length ? <div style={{ fontSize: 13, color: "#92400e" }}>Before release: {txn.blockers.join(" ")}</div> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
              <button type="submit" name="intent" value="review" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #d1d5db", background: "white", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Save review</button>
              <button type="submit" name="intent" value="release" disabled={busy} style={{ minHeight: 52, borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>RELEASE TO PRODUCTION</button>
            </div>
          </Form>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7280", minHeight: 32 }}>This is not production work</summary>
            <Form method="post" style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <input type="hidden" name="id" value={txn.id} />
              <input name="reason" required placeholder="Why (for example: service fee only)" style={input} />
              <button type="submit" name="intent" value="dismiss" disabled={busy} style={{ minHeight: 44, borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Mark as not production work</button>
            </Form>
          </details>
        </>
      )}
    </div>
  );
}

export default function ReleaseQueue() {
  const { transactions, showAmounts, families, finishes, canChoosePrinter, reorderOptions, find } = useLoaderData<any>();
  const result = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";
  const waiting = (transactions as any[]).filter((txn) => txn.status === "staged");
  const done = (transactions as any[]).filter((txn) => txn.status !== "staged");
  return (
    <Page title="Release to Production" subtitle="Business transactions waiting for your review. Releasing one creates the production job and its item tickets." backAction={{ content: "Production Board", onAction: () => navigate(SIMPLE_BOARD_HREF) }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 860 }}>
        {!waiting.length ? (
          <div style={{ ...card, fontSize: 15, display: "grid", gap: 6 }}>
            <div style={{ fontWeight: 700 }}>Nothing is waiting for release.</div>
            <div style={{ color: "#6b7280" }}>QuickBooks is not connected to the ERP yet, so invoices do not arrive here on their own. Until it is, start invoiced work with New Job and type the invoice number in the reference field.</div>
          </div>
        ) : (
          <>
            <Form method="get" style={{ ...card, display: "grid", gap: 8 }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Reorders: earlier jobs of the same customer name are offered on each item after you save the review. If the name differs here, search for the earlier job.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input name="find" defaultValue={find || ""} placeholder="Find earlier items: customer, job ticket or item name" style={input} />
                <button type="submit" style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #d1d5db", background: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Find</button>
              </div>
            </Form>
            {waiting.map((txn) => <StagedCard key={txn.id} txn={txn} families={families} finishes={finishes} canChoosePrinter={canChoosePrinter} showAmounts={showAmounts} result={result} busy={busy} reorderOptions={reorderOptions} />)}
          </>
        )}
        {done.length ? (
          <details style={card}>
            <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#6b7280", minHeight: 44 }}>Already handled ({done.length})</summary>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {done.map((txn) => <StagedCard key={txn.id} txn={txn} families={families} finishes={finishes} canChoosePrinter={canChoosePrinter} showAmounts={showAmounts} result={result} busy={busy} />)}
            </div>
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
    <Page title="Release to Production" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Reviewing and releasing business transactions is done by the owner or a manager. Released work appears on the Production Board.</div>
    </Page>
  );
}
