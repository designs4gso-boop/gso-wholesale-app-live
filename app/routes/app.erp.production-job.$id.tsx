// GSO ERP SIMPLE MODE (2026-11-14) — Job Workspace.
//
// One job, six steps, one NEXT STEP. This page adds NO production logic:
//   - loader  = the full Production page's loader (same authentication, same
//               job query, same financial redaction), narrowed to one job;
//   - action  = the full Production page's action, unchanged — the same
//               intents, permission checks, QC / reprint persistence,
//               shipment / pickup transactions and completion guards.
// The step layout, the NEXT STEP line and the wording are display only
// (app/lib/simple-production.ts, app/lib/employee-messages.ts). The full
// Production page stays available to the owner as the Advanced view.

import { useState, type CSSProperties, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useFetcher, useLoaderData, useNavigate, useRouteError, useRouteLoaderData } from "react-router";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { action as productionAction, loader as productionLoader } from "./app.erp.production";
import { friendlyMessage } from "../lib/employee-messages";
import { REPRINT_REASONS, formatShipDate, savedPickupForJob, savedShipmentForJob } from "../lib/production-fulfillment";
import { itemQcState, itemReprintSummary } from "../lib/production-qc-display";
import { staffStatusLabel } from "../lib/production-status-vocabulary";
import { SIMPLE_BOARD_HREF, classicJobHref } from "../lib/simple-nav";
import { isJobOverdue, jobWorkspaceView, type JobStepKey, type WorkspaceStep } from "../lib/simple-production";

export async function loader(args: { request: Request; params: { id?: string } }) {
  const raw: any = await productionLoader({ request: args.request });
  const data: any = raw instanceof Response ? await raw.json() : raw;
  const job = ((data.jobs || []) as any[]).find((candidate) => String(candidate.id) === String(args.params.id || ""));
  if (!job) throw new Response("This job was not found. It may have been archived.", { status: 404 });
  // `job` is exactly what the Production page would show this viewer (already redacted for non-financial roles).
  return Response.json({ job, showFinancials: Boolean(data.showFinancials) });
}

/** Every button on this page posts to the existing Production action — nothing is re-implemented here. */
export async function action(args: { request: Request }) {
  return productionAction({ request: args.request });
}

/* ---------------- small building blocks ---------------- */

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const bigButton = (kind: "primary" | "secondary" | "danger" = "primary", disabled = false): CSSProperties => ({
  minHeight: 52, padding: "0 20px", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
  border: kind === "primary" ? "1px solid #111827" : kind === "danger" ? "1px solid #b91c1c" : "1px solid #d1d5db",
  background: kind === "primary" ? "#111827" : "white",
  color: kind === "primary" ? "white" : kind === "danger" ? "#b91c1c" : "#111827",
});
const TONE: Record<string, { bg: string; fg: string; border: string }> = {
  action: { bg: "#eff6ff", fg: "#1e3a8a", border: "#93c5fd" },
  waiting: { bg: "#fffbeb", fg: "#92400e", border: "#fcd34d" },
  problem: { bg: "#fef2f2", fg: "#991b1b", border: "#fca5a5" },
  done: { bg: "#f0fdf4", fg: "#166534", border: "#86efac" },
};

/** Result of the action, shown right under the button that produced it. Plain English first; the original text under Details. */
function Feedback({ data }: { data: any }) {
  if (!data?.message) return null;
  const friendly = friendlyMessage(data.message);
  const ok = Boolean(data.ok);
  return (
    <div role="status" style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: ok ? "#f0fdf4" : "#fef2f2", color: ok ? "#166534" : "#991b1b", border: `1px solid ${ok ? "#bbf7d0" : "#fecaca"}` }}>
      {friendly.primary}
      {friendly.detail ? (
        <details style={{ marginTop: 4, fontWeight: 400 }}>
          <summary style={{ cursor: "pointer", fontSize: 12 }}>Details</summary>
          <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>{friendly.detail}</div>
        </details>
      ) : null}
    </div>
  );
}

/** One form = one existing Production action intent. Its result appears inside the form (not in a page banner). */
function ActionForm({ jobId, intent, hidden, children }: { jobId: string; intent: string; hidden?: Record<string, string>; children: (busy: boolean) => ReactNode }) {
  const fetcher = useFetcher<any>();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="jobId" value={jobId} />
      {Object.entries(hidden || {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children(busy)}
      <Feedback data={fetcher.data} />
    </fetcher.Form>
  );
}

function Fact({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: alert ? "#b91c1c" : "#111827", overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

function ChecklistButtons({ jobId, items }: { jobId: string; items: any[] }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((item) => (
        <ActionForm key={item.id} jobId={jobId} intent="toggleChecklist" hidden={{ checklistId: String(item.id), completed: item.completed ? "false" : "true" }}>
          {(busy) => (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {item.completed ? (
                <>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "#166534" }}>✓ {item.label}</span>
                  <button type="submit" disabled={busy} style={{ minHeight: 36, padding: "0 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 13, cursor: "pointer" }}>Undo</button>
                </>
              ) : (
                <button type="submit" disabled={busy} style={{ ...bigButton("primary", busy), width: "100%", textAlign: "left" }}>Mark done: {item.label}</button>
              )}
            </div>
          )}
        </ActionForm>
      ))}
    </div>
  );
}

const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "—");

/* ---------------- step bodies (only existing actions) ---------------- */

function QcStep({ job }: { job: any }) {
  const items = (job.items || []) as any[];
  if (!items.length) return <p style={{ margin: 0, color: "#6b7280" }}>This job has no items to check.</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.map((item) => {
        const qc = itemQcState(item, job.events || []);
        const reprint = itemReprintSummary(item);
        const passed = qc.status === "pass";
        return (
          <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{item.displayTitle || item.productTitle || "Item"} · Qty {item.quantity}</div>
              <span style={{ fontSize: 13, fontWeight: 700, padding: "2px 10px", borderRadius: 999, background: passed ? "#dcfce7" : qc.status === "none" ? "#f3f4f6" : "#fef3c7", color: passed ? "#166534" : qc.status === "none" ? "#374151" : "#92400e" }}>
                {qc.status === "none" ? "Not checked yet" : qc.label}
              </span>
            </div>
            {reprint ? <div style={{ fontSize: 13, color: "#92400e" }}>Reprinted — {reprint.reason} · {reprint.by || "staff"} · {when(reprint.at)}</div> : null}
            <ActionForm jobId={job.id} intent="qcItem" hidden={{ itemId: String(item.id) }}>
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <input name="qcNote" placeholder="Note (optional)" style={input} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                    <button type="submit" name="qcResult" value="pass" disabled={busy} style={{ ...bigButton("primary", busy), background: "#166534", borderColor: "#166534" }}>QC PASS</button>
                    <button type="submit" name="qcResult" value="reprint_required" disabled={busy} style={bigButton("danger", busy)}>Needs reprint</button>
                    <button type="submit" name="qcResult" value="hold" disabled={busy} style={bigButton("secondary", busy)}>Hold / review</button>
                  </div>
                </div>
              )}
            </ActionForm>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7280", minHeight: 32 }}>Record a reprint for this item</summary>
              <ActionForm jobId={job.id} intent="reprintItem" hidden={{ itemId: String(item.id) }}>
                {(busy) => (
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    <select name="reprintReason" defaultValue="" required style={input}>
                      <option value="" disabled>Why is it being reprinted?</option>
                      {REPRINT_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
                    </select>
                    <input name="reprintNote" placeholder="Note (optional)" style={input} />
                    <button type="submit" disabled={busy} style={bigButton("secondary", busy)}>Record reprint</button>
                  </div>
                )}
              </ActionForm>
            </details>
          </div>
        );
      })}
    </div>
  );
}

function FulfillStep({ job, showFinancials }: { job: any; showFinancials: boolean }) {
  const shipment = savedShipmentForJob(job, job.events || []);
  const pickup = savedPickupForJob(job, job.events || []);
  const status = String(job.status || "");
  const summaryBox: CSSProperties = { padding: 12, borderRadius: 12, border: "1px solid #86efac", background: "#f0fdf4", display: "grid", gap: 2, fontSize: 15 };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {shipment ? (
        <div style={summaryBox}>
          <b>SHIPMENT RECORDED</b>
          <span>Carrier: {shipment.carrier}</span>
          <span>Tracking: {shipment.trackingNumber || "none entered"}</span>
          <span>Packages: {shipment.packageCount ?? "—"}</span>
          <span>Ship date: {formatShipDate(shipment.shipDate)}</span>
          {showFinancials ? <span>Actual shipping cost: {shipment.actualShippingCost != null ? `$${shipment.actualShippingCost.toFixed(2)}` : "not entered"}</span> : null}
          <span style={{ fontSize: 13, color: "#6b7280" }}>Recorded by {shipment.recordedBy || "staff"} · {when(shipment.recordedAt)}</span>
        </div>
      ) : null}
      {pickup ? (
        <div style={summaryBox}>
          <b>CUSTOMER PICKUP RECORDED</b>
          <span>Picked up by: {pickup.pickedUpBy || "not entered"}</span>
          <span>Pickup date/time: {when(pickup.pickedUpAt)}</span>
          {pickup.note ? <span>Note: {pickup.note}</span> : null}
          <span style={{ fontSize: 13, color: "#6b7280" }}>Recorded by {pickup.recordedBy || "staff"} · {when(pickup.recordedAt)}</span>
        </div>
      ) : null}

      {!shipment && !pickup && !["shipped", "picked_up", "completed", "cancelled"].includes(status) ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Shipping it</div>
            <ActionForm jobId={job.id} intent="recordShipment">
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <input name="carrier" placeholder="Carrier (UPS, FedEx, USPS…)" required style={input} />
                  <input name="trackingNumber" placeholder="Tracking number" style={input} />
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Packages<input name="packageCount" type="number" min={1} defaultValue={1} required style={input} /></label>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Ship date<input name="shipDate" type="date" required style={input} /></label>
                  <input name="actualShippingCost" type="number" min={0} step="0.01" placeholder="Shipping cost $ (leave blank if not known)" style={input} />
                  <button type="submit" disabled={busy} style={bigButton("primary", busy)}>Save shipment</button>
                </div>
              )}
            </ActionForm>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Customer is picking it up</div>
            <ActionForm jobId={job.id} intent="recordPickup">
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <input name="pickedUpBy" placeholder="Picked up by (optional)" style={input} />
                  <input name="pickupNote" placeholder="Note (optional)" style={input} />
                  <button type="submit" disabled={busy} style={bigButton("primary", busy)}>Save pickup (now)</button>
                </div>
              )}
            </ActionForm>
          </div>
        </div>
      ) : null}

      {(shipment || pickup || ["shipped", "picked_up"].includes(status)) && status !== "completed" && status !== "cancelled" ? (
        <ActionForm jobId={job.id} intent="changeStatus" hidden={{ status: "completed" }}>
          {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("primary", busy), width: "100%", background: "#166534", borderColor: "#166534" }}>Mark job completed</button>}
        </ActionForm>
      ) : null}
    </div>
  );
}

function StepBody({ step, job, machine, showFinancials }: { step: WorkspaceStep; job: any; machine: string; showFinancials: boolean }) {
  const navigate = useNavigate();
  const key: JobStepKey = step.key;
  const files = (job.files || []) as any[];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {key === "artwork" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 15 }}>{files.length ? `${files.length} file(s) linked to this job.` : "No artwork is linked yet — add it under Files below."}</span>
          <button type="button" onClick={() => navigate(`/app/erp/production/${job.id}/proof`)} style={{ ...bigButton("secondary"), minHeight: 44 }}>Open proof page</button>
        </div>
      ) : null}
      {key === "print" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 15 }}>Machine: <b>{machine || "Not assigned"}</b></span>
          <button type="button" onClick={() => navigate(`/app/erp/production/${job.id}/print`)} style={{ ...bigButton("secondary"), minHeight: 44 }}>Open work order</button>
        </div>
      ) : null}
      {key === "qc" ? <QcStep job={job} /> : null}
      {key === "fulfill" ? <FulfillStep job={job} showFinancials={showFinancials} /> : null}
      <ChecklistButtons jobId={job.id} items={step.checklist} />
      {key !== "qc" && key !== "fulfill" && !step.checklist.length ? <p style={{ margin: 0, color: "#6b7280", fontSize: 14 }}>Nothing to tick off for this step on this job.</p> : null}
    </div>
  );
}

/* ---------------- secondary tabs ---------------- */

function FilesTab({ job }: { job: any }) {
  const files = (job.files || []) as any[];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {files.length ? files.map((file) => (
        <div key={file.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid #f3f4f6" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{file.fileName}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{String(file.fileType || "file").replace(/_/g, " ")}</div>
          </div>
          <a href={file.fileUrl} target="_blank" rel="noreferrer" style={{ ...bigButton("secondary"), minHeight: 44, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Open file</a>
        </div>
      )) : <p style={{ margin: 0, color: "#6b7280" }}>No files yet.</p>}
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700, minHeight: 36 }}>Add a file link</summary>
        <ActionForm jobId={job.id} intent="addFile">
          {(busy) => (
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <input name="fileUrl" placeholder="Paste the file link" required style={input} />
              <input name="fileName" placeholder="Name (optional)" style={input} />
              <select name="fileType" defaultValue="artwork" style={input}>
                <option value="artwork">Artwork</option>
                <option value="proof">Proof</option>
                <option value="print_file">Print file</option>
                <option value="dieline">Dieline</option>
                <option value="other">Other</option>
              </select>
              <button type="submit" disabled={busy} style={bigButton("primary", busy)}>Add file</button>
            </div>
          )}
        </ActionForm>
      </details>
    </div>
  );
}

function MaterialsTab({ job }: { job: any }) {
  const usages = (job.materialUsages || []) as any[];
  return usages.length ? (
    <div style={{ display: "grid", gap: 6 }}>
      {usages.map((usage) => (
        <div key={usage.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: "1px solid #f3f4f6", fontSize: 15 }}>
          <span style={{ fontWeight: 600 }}>{usage.materialName}</span>
          <span>{Number(usage.usedQty || usage.pulledQty || usage.estimatedQty || 0)} {usage.unit}</span>
        </div>
      ))}
    </div>
  ) : <p style={{ margin: 0, color: "#6b7280" }}>No material has been recorded on this job yet.</p>;
}

function NotesTab({ job }: { job: any }) {
  const notes = ((job.events || []) as any[]).filter((event) => event.eventType === "note");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ActionForm jobId={job.id} intent="addNote">
        {(busy) => (
          <div style={{ display: "grid", gap: 8 }}>
            <textarea name="note" placeholder="Write a note for the team" rows={2} required style={{ ...input, minHeight: 72, padding: 12 }} />
            <button type="submit" disabled={busy} style={bigButton("primary", busy)}>Add note</button>
          </div>
        )}
      </ActionForm>
      {job.internalNotes ? <div style={{ padding: 10, borderRadius: 10, background: "#f9fafb", fontSize: 15, whiteSpace: "pre-wrap" }}>{job.internalNotes}</div> : null}
      {notes.map((note, index) => (
        <div key={note.id || index} style={{ padding: "8px 0", borderBottom: "1px solid #f3f4f6" }}>
          <div style={{ fontSize: 15, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note.message}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{when(note.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}

const money = (value: unknown) => (value == null || Number.isNaN(Number(value)) ? "—" : `$${Number(value).toFixed(2)}`);

/** Owner / financially authorized viewers only — rendered ONLY when the server says showFinancials. Read-only here. */
function CostsTab({ job }: { job: any }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Fact label="Quoted true cost" value={money(job.quotedTrueCost)} />
        <Fact label="Actual total cost" value={job.actualCostFinalized ? money(job.actualTotalCost) : "Not finalized"} />
        <Fact label="Variance" value={job.actualCostFinalized ? money(job.actualVarianceAmount) : "—"} />
      </div>
      <p style={{ margin: 0, color: "#6b7280", fontSize: 14 }}>Entering actual costs, pulling print-log actuals and finalizing are done in the advanced view.</p>
      <Link to={classicJobHref(job.id)} style={{ ...bigButton("secondary"), display: "inline-flex", alignItems: "center", textDecoration: "none", width: "fit-content" }}>Open advanced view</Link>
    </div>
  );
}

/* ---------------- page ---------------- */

export default function JobWorkspace() {
  const { job, showFinancials } = useLoaderData<any>();
  const shell = useRouteLoaderData("routes/app") as any;
  const navigate = useNavigate();
  const isOwner = (shell?.role || (showFinancials ? "owner" : "")) === "owner";
  const view = jobWorkspaceView(job);
  const tone = TONE[view.next.tone] || TONE.action;
  const items = (job.items || []) as any[];
  const product = !items.length ? "No items" : items.length > 1 ? `${items[0].displayTitle || items[0].productTitle || "Item"} (+${items.length - 1} more)` : items[0].displayTitle || items[0].productTitle || "Item";
  const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const overdue = isJobOverdue(job);
  const tabs = [
    { key: "files", label: `Files (${(job.files || []).length})` },
    { key: "materials", label: "Materials" },
    { key: "notes", label: "Notes" },
    ...(showFinancials ? [{ key: "costs", label: "Costs" }] : []),
  ];
  const [tab, setTab] = useState("files");

  return (
    <Page
      title={job.company || job.customerName || "Production job"}
      subtitle="Follow the steps from top to bottom. The next step is always shown first."
      backAction={{ content: "Production Board", onAction: () => navigate(SIMPLE_BOARD_HREF) }}
      secondaryActions={isOwner ? [{ content: "Open advanced view", onAction: () => navigate(classicJobHref(job.id)) }] : []}
    >
      <div style={{ display: "grid", gap: 16, paddingBottom: 40 }}>
        <div style={{ ...card, display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Fact label="Customer" value={job.company || job.customerName || "Not set"} />
          <Fact label="Product" value={product} />
          <Fact label="Quantity" value={quantity > 0 ? quantity.toLocaleString() : "Not set"} />
          <Fact label="Due" value={job.dueDate ? `${new Date(job.dueDate).toLocaleDateString()}${overdue ? " · LATE" : ""}` : "Not set"} alert={overdue} />
          <Fact label="Priority" value={String(job.priority || "normal").toUpperCase()} alert={["rush", "critical"].includes(String(job.priority))} />
          <Fact label="Assigned to" value={job.assignedTo || "Nobody yet"} />
          <Fact label="Status" value={staffStatusLabel(String(job.status || ""))} />
        </div>

        <div style={{ padding: "18px 20px", borderRadius: 14, background: tone.bg, border: `2px solid ${tone.border}`, color: tone.fg }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1 }}>{view.next.tone === "done" ? "STATUS" : "NEXT STEP"}</div>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2 }}>{view.next.text}</div>
          {view.next.detail ? <div style={{ fontSize: 15, marginTop: 4 }}>{view.next.detail}</div> : null}
        </div>

        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
          {view.steps.map((step) => (
            <li key={step.key} style={{ padding: "10px 8px", borderRadius: 12, textAlign: "center", fontWeight: 800, fontSize: 13, letterSpacing: 0.5, border: `2px solid ${step.state === "current" ? "#111827" : step.state === "done" ? "#86efac" : "#e5e7eb"}`, background: step.state === "done" ? "#f0fdf4" : "white", color: step.state === "upcoming" ? "#9ca3af" : "#111827" }}>
              {step.state === "done" ? "✓" : step.number} {step.label.toUpperCase()}
            </li>
          ))}
        </ol>

        {view.suggestedStatus ? (
          <ActionForm jobId={job.id} intent="changeStatus" hidden={{ status: view.suggestedStatus }}>
            {(busy) => (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14, color: "#6b7280" }}>
                <span>The board still shows this job under “{staffStatusLabel(String(job.status || ""))}”.</span>
                <button type="submit" disabled={busy} style={{ ...bigButton("secondary", busy), minHeight: 44, fontSize: 14 }}>Move it to {staffStatusLabel(view.suggestedStatus!)}</button>
              </div>
            )}
          </ActionForm>
        ) : null}

        {view.steps.map((step) => (
          <details key={`${step.key}-${step.state}`} open={step.state === "current"} style={{ ...card, borderColor: step.state === "current" ? "#111827" : "#e5e7eb", borderWidth: step.state === "current" ? 2 : 1 }}>
            <summary style={{ cursor: "pointer", fontSize: 17, fontWeight: 800, minHeight: 32, color: step.state === "upcoming" ? "#6b7280" : "#111827" }}>
              {step.state === "done" ? "✓ " : `${step.number}. `}{step.label}
              {step.state === "current" ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "#111827", color: "white" }}>NOW</span> : null}
              {step.state === "upcoming" ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600 }}>later</span> : null}
            </summary>
            <div style={{ marginTop: 12 }}>
              <StepBody step={step} job={job} machine={view.machine} showFinancials={showFinancials} />
            </div>
          </details>
        ))}

        <div style={card}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {tabs.map((entry) => (
              <button key={entry.key} type="button" onClick={() => setTab(entry.key)} style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", border: `1px solid ${tab === entry.key ? "#111827" : "#d1d5db"}`, background: tab === entry.key ? "#111827" : "white", color: tab === entry.key ? "white" : "#111827" }}>
                {entry.label.toUpperCase()}
              </button>
            ))}
          </div>
          {tab === "files" ? <FilesTab job={job} /> : null}
          {tab === "materials" ? <MaterialsTab job={job} /> : null}
          {tab === "notes" ? <NotesTab job={job} /> : null}
          {tab === "costs" && showFinancials ? <CostsTab job={job} /> : null}
        </div>

        <details style={card}>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#6b7280", minHeight: 32 }}>Advanced / details</summary>
          <div style={{ display: "grid", gap: 12, marginTop: 12, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Fact label="Job ticket" value={job.jobTicket || "—"} />
              <Fact label="Quote" value={job.quoteNumber || "—"} />
              <Fact label="Source" value={String(job.sourceType || "—")} />
            </div>
            {items.map((item) => item.itemTicket ? <div key={item.id} style={{ color: "#6b7280" }}>Item ticket: {item.itemTicket}</div> : null)}
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>History (most recent first)</div>
              {((job.events || []) as any[]).map((event, index) => (
                <div key={event.id || index} style={{ padding: "4px 0", borderBottom: "1px solid #f3f4f6", color: "#374151", overflowWrap: "anywhere" }}>
                  <span style={{ color: "#6b7280" }}>{when(event.createdAt)} · </span>{event.message}
                </div>
              ))}
            </div>
            {isOwner ? (
              <div>
                <p style={{ margin: "0 0 8px", color: "#6b7280" }}>Actual costs, material stock, asset roles, link / merge tools and print-log matching live in the advanced view.</p>
                <Link to={classicJobHref(job.id)} style={{ ...bigButton("secondary"), display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Open advanced view</Link>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  // only the "job not found" case is handled here; everything else (including Shopify auth) keeps the standard boundary
  if (!(isRouteErrorResponse(error) && error.status === 404)) return boundary.error(error);
  const message = "This job was not found. It may have been archived.";
  return (
    <Page title="Job not available" backAction={{ content: "Production Board", onAction: () => navigate(SIMPLE_BOARD_HREF) }}>
      <div style={{ ...card, fontSize: 16 }}>{message}</div>
    </Page>
  );
}
