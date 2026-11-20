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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useFetcher, useLoaderData, useNavigate, useRouteError, useRouteLoaderData } from "react-router";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { action as productionAction, loader as productionLoader } from "./app.erp.production";
import { jobEventsWithNoteHistory } from "../lib/job-note-history.server";
import { friendlyMessage } from "../lib/employee-messages";
import { REPRINT_REASONS, formatShipDate, savedPickupForJob, savedShipmentForJob } from "../lib/production-fulfillment";
import { itemReprintSummary } from "../lib/production-qc-display";
import { showsProductionControl } from "../lib/production-role-access";
import { PRODUCTION_STATUS_OPTIONS, jobSourceLabel, staffStatusLabel } from "../lib/production-status-vocabulary";
import { REORDER_HREF, SIMPLE_BOARD_HREF, classicJobHref, jobWorkspaceHref } from "../lib/simple-nav";
import { RUN_CHARGE_TYPES, RUN_KINDS, itemFileState, itemRunSummary, runChargeLabel, runKindLabel, runCostAccounting } from "../lib/production-run";
import { reprintReasonLabel } from "../lib/production-fulfillment";
import { formatDueDate } from "../lib/business-date";
import { isJobOverdue, jobWorkspaceView, showsMaterialUse, workspaceItemQc, toMaterialOption, type JobStepKey, type WorkspaceStep } from "../lib/simple-production";

export async function loader(args: { request: Request; params: { id?: string } }) {
  const raw: any = await productionLoader({ request: args.request });
  const data: any = raw instanceof Response ? await raw.json() : raw;
  const job = ((data.jobs || []) as any[]).find((candidate) => String(candidate.id) === String(args.params.id || ""));
  if (!job) throw new Response("This job was not found. It may have been archived.", { status: 404 });
  // `job` is exactly what the Production page would show this viewer (already redacted for non-financial roles).
  // material picker: id / name / unit only — never a cost, for any viewer
  const materials = ((data.materials || []) as any[]).map(toMaterialOption);
  // link targets are only sent for an unlinked print-intake job (the only place they are used)
  const linkTargets = job.linkEligible ? data.linkTargets || [] : [];
  // 2026-11-15: the shared loader sends only the 20 newest history events, so on a busy job the
  // staff notes dropped off this page. They are read for this one job (job-note-history.server.ts).
  job.events = await jobEventsWithNoteHistory(job, Boolean(data.showFinancials));
  return Response.json({ job, materials, linkTargets, showFinancials: Boolean(data.showFinancials) });
}

/**
 * Linking an intake job archives that job, so reloading THIS page right after a successful
 * link showed "This job was not found" instead of the result. That one reload is skipped;
 * the form then opens the job it was linked into.
 */
export function shouldRevalidate({ formData, actionResult, defaultShouldRevalidate }: { formData?: FormData; actionResult?: any; defaultShouldRevalidate: boolean }) {
  if (formData?.get("intent") === "linkJobToTarget" && actionResult?.ok) return false;
  return defaultShouldRevalidate;
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
  // clear what was typed once it is saved, so a second tap cannot record the same entry twice
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) formRef.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <fetcher.Form method="post" ref={formRef}>
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
                  <button type="submit" disabled={busy} style={{ minHeight: 44, padding: "0 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 13, cursor: "pointer" }}>Undo</button>
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

const RUN_STATUS_LABEL: Record<string, string> = { open: "Waiting for QC", qc_passed: "QC passed", qc_failed: "QC failed", reprinted: "Reprinted", cancelled: "Cancelled" };

/** Every production run of one item: the original and each reprint / remake, with its own quantity. Display only. */
function ItemRuns({ item }: { item: any }) {
  const summary = itemRunSummary(item, item.runs || []);
  const actuals = (item.runActuals || []) as any[];
  if (!summary.reprintCount) {
    // no reprint: still show what the press reported for this item, when there is anything
    return actuals.length ? (
      <div style={{ fontSize: 13, color: "#374151" }}>
        {actuals.map((row) => <div key={row.label}>Press result — {row.label}: {Number(row.inkMl).toFixed(1)} mL ink · {Number(row.printMinutes).toFixed(1)} min</div>)}
      </div>
    ) : null;
  }
  return (
    <div style={{ fontSize: 13, border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: "8px 10px", display: "grid", gap: 4 }}>
      <div style={{ fontWeight: 700 }}>Ordered {summary.orderedQuantity} · Reprinted {summary.reprintQuantity} in {summary.reprintCount} run(s)</div>
      {summary.runs.map((run) => (
        <div key={run.runNumber} style={{ color: "#374151", overflowWrap: "anywhere" }}>
          Run {run.runNumber} — {runKindLabel(run.kind)} · {run.quantity} pcs
          {run.kind !== "original" ? ` · ${reprintReasonLabel(String(run.reasonCode || ""))} · ${runChargeLabel(run.chargeType)}` : ""}
          {` · ${RUN_STATUS_LABEL[String(run.status || "")] || String(run.status || "")}`}
          {run.kind !== "original" && run.requestedBy ? ` · ${run.requestedBy}` : ""}
          {run.notes && run.kind !== "original" ? ` · ${run.notes}` : ""}
        </div>
      ))}
      {actuals.map((row) => <div key={row.label} style={{ color: "#374151" }}>Press result — {row.label}: {Number(row.inkMl).toFixed(1)} mL ink · {Number(row.printMinutes).toFixed(1)} min</div>)}
      {(() => {
        // 2026-11-19: how the extra runs are treated. No dollars here; nothing is charged from this page.
        const cost = runCostAccounting(item.runs || [], actuals as any);
        return (
          <>
            {cost.internalExtra.runs ? <div style={{ color: "#92400e" }}>Shop-absorbed reprints: {cost.internalExtra.quantity} pcs in {cost.internalExtra.runs} run(s){cost.internalExtra.inkMl ? ` · ${cost.internalExtra.inkMl.toFixed(1)} mL ink` : ""}. The order total does not change.</div> : null}
            {cost.customerPaidExtra.runs ? <div style={{ color: "#92400e" }}>Customer-paid replacement: {cost.customerPaidExtra.quantity} pcs in {cost.customerPaidExtra.runs} run(s). Nothing was charged — the owner / admin creates the sale.</div> : null}
          </>
        );
      })()}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => { try { void navigator.clipboard?.writeText(text); setCopied(true); } catch { /* copy is a convenience only */ } }} style={{ minHeight: 44, padding: "0 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
      {copied ? "Copied" : label}
    </button>
  );
}

/** Job-first file prep: the exact folder / ticket names, what each item needs and what has arrived. Display only. */
function TicketsAndFiles({ job, role }: { job: any; role: string }) {
  const items = (job.items || []) as any[];
  if (!job.jobTicket) return null;
  const canReorder = role === "owner" || role === "manager";
  return (
    <div style={{ ...card, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>Job folder name</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace" }}>{job.jobTicket}</div>
        </div>
        <CopyButton text={job.jobTicket} label="Copy job folder name" />
      </div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>
        {items.length > 1
          ? "Save the print files in a folder with this name inside Prints For Today, and start each file name with its item ticket below."
          : "Save the print files in a folder with this name inside Prints For Today. They link to this job and go to the right printer automatically."}
      </div>
      {items.map((item) => {
        const state = itemFileState(item, job.files || []);
        return (
          <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace" }}>{item.itemTicket || "No item ticket"}</div>
                <div style={{ fontSize: 14 }}>{item.displayTitle || item.productTitle || "Item"} · Qty {item.quantity}</div>
              </div>
              {item.itemTicket ? <CopyButton text={item.itemTicket} label="Copy item ticket" /> : null}
            </div>
            <div style={{ fontSize: 13, color: "#374151" }}>Finish: {item.selectedFinish || "Not set"} · Printer: {item.machineSummary || "Not assigned"}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: state.awaiting ? "#92400e" : "#166534" }}>{state.label}</div>
            {item.reorderOf ? (
              <div style={{ fontSize: 13, color: "#1e3a8a" }}>
                Reorder of {item.reorderOf.itemTicket || item.reorderOf.productTitle} (earlier quantity {item.reorderOf.quantity}) — {item.reorderOf.artworkMode === "revision" ? "REVISED ARTWORK: a new proof approval is needed; the earlier file is reference only." : "same artwork: reuse the approved file listed under Files."}
              </div>
            ) : null}
          </div>
        );
      })}
      {canReorder ? <Link to={`${REORDER_HREF}?q=${encodeURIComponent(job.jobTicket)}`} style={{ fontSize: 14, fontWeight: 700 }}>Reorder an item from this job (new quote)</Link> : null}
    </div>
  );
}

/* ---------------- step bodies (only existing actions) ---------------- */

function QcStep({ job, role }: { job: any; role: string }) {
  const items = (job.items || []) as any[];
  if (!items.length) return <p style={{ margin: 0, color: "#6b7280" }}>This job has no items to check.</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.map((item) => {
        const qc = workspaceItemQc(item, job.events || []);
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
            <ItemRuns item={item} />
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
            {showsProductionControl(role, "reprintItem") ? (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#b91c1c", minHeight: 44 }}>NEEDS REPRINT</summary>
                <ActionForm jobId={job.id} intent="reprintItem" hidden={{ itemId: String(item.id) }}>
                  {(busy) => (
                    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                      <label style={{ fontSize: 13, color: "#6b7280" }}>Reason
                        <select name="reprintReason" defaultValue="" required style={input}>
                          <option value="" disabled>Choose a reason</option>
                          {REPRINT_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
                        </select>
                      </label>
                      <label style={{ fontSize: 13, color: "#6b7280" }}>How many pieces to reprint (ordered: {item.quantity})
                        <input name="reprintQty" type="number" min={1} step={1} required placeholder="For example 25" style={input} />
                      </label>
                      <label style={{ fontSize: 13, color: "#6b7280" }}>Type
                        <select name="runKind" defaultValue="reprint" style={input}>
                          {RUN_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                        </select>
                      </label>
                      <label style={{ fontSize: 13, color: "#6b7280" }}>Who pays
                        <select name="chargeType" defaultValue="internal" style={input}>
                          {RUN_CHARGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                        </select>
                      </label>
                      <input name="reprintNote" placeholder="Note (optional)" style={input} />
                      <div style={{ fontSize: 12, color: "#6b7280" }}>The ordered quantity and the price do not change. Every layer file of this item is sent back to the press. The reprinted piece needs a new QC PASS before the job can ship or be picked up.</div>
                      <button type="submit" disabled={busy} style={bigButton("danger", busy)}>START REPRINT</button>
                    </div>
                  )}
                </ActionForm>
              </details>
            ) : null}
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

      {/* a job that left Shipped / Picked Up (reopened for reprint, put on hold) must be shipped or handed over again */}
      {!["shipped", "picked_up", "completed", "cancelled"].includes(status) ? (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Packed and waiting{job.fulfillmentState === "ready_to_ship" ? " — READY TO SHIP" : job.fulfillmentState === "pickup_ready" ? " — READY FOR PICKUP" : ""}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            <ActionForm jobId={job.id} intent="markFulfillmentReady" hidden={{ kind: "ship" }}>
              {(busy) => <button type="submit" disabled={busy || job.fulfillmentState === "ready_to_ship"} style={{ ...input, fontWeight: 700, cursor: "pointer", background: "white" }}>Ready to ship</button>}
            </ActionForm>
            <ActionForm jobId={job.id} intent="markFulfillmentReady" hidden={{ kind: "pickup" }}>
              {(busy) => <button type="submit" disabled={busy || job.fulfillmentState === "pickup_ready"} style={{ ...input, fontWeight: 700, cursor: "pointer", background: "white" }}>Ready for pickup</button>}
            </ActionForm>
          </div>
        </div>
      ) : null}
      {["shipped", "picked_up"].includes(status) && job.fulfillmentSyncStatus === "disabled" && job.fulfillmentSyncError ? (
        <div style={{ fontSize: 14, color: "#92400e" }}>Shopify: {job.fulfillmentSyncError}</div>
      ) : null}
      {!["shipped", "picked_up", "completed", "cancelled"].includes(status) ? (
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

      {["shipped", "picked_up"].includes(status) ? (
        <ActionForm jobId={job.id} intent="changeStatus" hidden={{ status: "completed" }}>
          {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("primary", busy), width: "100%", background: "#166534", borderColor: "#166534" }}>COMPLETE JOB</button>}
        </ActionForm>
      ) : null}
    </div>
  );
}

const PROOF_STATE: Record<string, string> = { draft: "Not sent yet", sent: "Sent to customer", viewed: "Customer has opened it", approved: "Approved by customer", changes_requested: "Customer asked for changes" };

const PROOF_SEND_STATUSES = ["new", "prepress", "proof_needed", "proof_sent", "proof_approved"];
/** Notes as staff should read them: the system bookkeeping lines ("Source: ... | Request: ...") are left to the Advanced view. */
const staffNotes = (value: unknown) => String(value || "").split("\n").filter((line) => !/^\s*Source:\s/i.test(line)).join("\n").trim();

/** Customer proof link — the existing createProofPortal / markProofSent actions, unchanged. */
function CustomerProof({ job }: { job: any }) {
  const link: string = job.customerProofUrl || "";
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.4 }}>CUSTOMER PROOF</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: job.proofStatus === "approved" ? "#166534" : job.proofStatus === "changes_requested" ? "#b91c1c" : "#374151" }}>{link ? PROOF_STATE[String(job.proofStatus || "draft")] || "Link ready" : "No customer link yet"}</span>
      </div>
      {job.proofCustomerComment ? <div style={{ fontSize: 14 }}>Customer comment: {job.proofCustomerComment}</div> : null}
      {link ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "start" }}>
          <button type="button" onClick={() => { try { void navigator.clipboard?.writeText(link); } catch { /* copy is a convenience only */ } }} style={{ ...bigButton("secondary"), minHeight: 44 }}>Copy customer proof link</button>
          {/* marking a proof sent moves the job to Proof Sent, so it is only offered while the job is still in prepress */}
          {PROOF_SEND_STATUSES.includes(String(job.status || "new")) ? (
            <ActionForm jobId={job.id} intent="markProofSent">
              {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("secondary", busy), minHeight: 44, width: "100%" }}>Mark proof sent</button>}
            </ActionForm>
          ) : null}
        </div>
      ) : (
        <ActionForm jobId={job.id} intent="createProofPortal">
          {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("secondary", busy), minHeight: 44 }}>Create customer proof link</button>}
        </ActionForm>
      )}
    </div>
  );
}

function StepBody({ step, job, machine, showFinancials, materials, canRecordMaterial, role }: { step: WorkspaceStep; job: any; machine: string; showFinancials: boolean; materials: any[]; canRecordMaterial: boolean; role: string }) {
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
      {key === "artwork" && showsProductionControl(role, "createProofPortal") ? <CustomerProof job={job} /> : null}
      {key === "print" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 15 }}>Machine: <b>{machine || "Not assigned"}</b></span>
          <button type="button" onClick={() => navigate(`/app/erp/production/${job.id}/print`)} style={{ ...bigButton("secondary"), minHeight: 44 }}>Open work order</button>
          <ActionForm jobId={job.id} intent="markPrinted">
            {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("secondary", busy), minHeight: 44 }}>{job.printedAt ? "Work order printed ✓ (mark again)" : "Mark work order printed"}</button>}
          </ActionForm>
        </div>
      ) : null}
      {key === "artwork" && showsProductionControl(role, "revisionItem") && (job.items || []).length ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, minHeight: 44 }}>NEW ARTWORK REVISION</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <div style={{ fontSize: 14, color: "#6b7280" }}>Use this when corrected artwork is coming. The old artwork stays in the job history.</div>
            {((job.items || []) as any[]).map((item) => (
              <ActionForm key={item.id} jobId={job.id} intent="revisionItem" hidden={{ itemId: String(item.id) }}>
                {(busy) => <button type="submit" disabled={busy} style={{ ...bigButton("secondary", busy), width: "100%", textAlign: "left" }}>START NEW REVISION{(job.items || []).length > 1 ? ` — ${item.displayTitle || item.productTitle || "item"}` : ""}</button>}
              </ActionForm>
            ))}
          </div>
        </details>
      ) : null}
      {key === "qc" ? <QcStep job={job} role={role} /> : null}
      {key === "fulfill" ? <FulfillStep job={job} showFinancials={showFinancials} /> : null}
      {/* QC is recorded with the QC buttons above; a tick-box "QC passed" would not count as QC */}
      {key !== "qc" ? <ChecklistButtons jobId={job.id} items={step.checklist} /> : null}
      {key === "print" || key === "finish" ? <MaterialUse job={job} materials={materials} canRecord={canRecordMaterial} /> : null}
      {key !== "qc" && key !== "fulfill" && !step.checklist.length ? <p style={{ margin: 0, color: "#6b7280", fontSize: 14 }}>Nothing to tick off for this step on this job.</p> : null}
    </div>
  );
}

/* ---------------- secondary tabs ---------------- */

const FILE_KIND: Record<string, string> = { artwork: "Artwork", proof: "Proof", print_file: "Production file", dieline: "Dieline", customer_pdf: "Customer PDF", image: "Product image", other: "Other file" };

function FilesTab({ job, role }: { job: any; role: string }) {
  const files = (job.files || []) as any[];
  const canRemove = showsProductionControl(role, "deleteFile");
  const jobItems = (job.items || []) as any[];
  const itemTicketById: Record<string, string> = Object.fromEntries(jobItems.map((item) => [String(item.id), String(item.itemTicket || item.productTitle || "")]));
  const isWebLink = (url: unknown) => /^(https?:\/\/|\/)/i.test(String(url || ""));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {files.length ? files.map((file) => (
        <div key={file.id} style={{ padding: "8px 0", borderBottom: "1px solid #f3f4f6", display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{file.fileName}</div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                {file.assetSource === "reorder_reuse" ? "Earlier order's file (reorder)" : FILE_KIND[String(file.fileType || "")] || "File"}
                {itemTicketById[String(file.productionJobItemId || "")] ? ` · item ${itemTicketById[String(file.productionJobItemId)]}` : ""}
              </div>
              {/* files on the shop NAS have no web link: say where they are instead of offering a dead button */}
              {!isWebLink(file.fileUrl) && file.notes ? <div style={{ fontSize: 13, color: "#374151", overflowWrap: "anywhere" }}>{String(file.notes).split(/\r?\n/)[0]}</div> : null}
            </div>
            {isWebLink(file.fileUrl) ? <a href={file.fileUrl} target="_blank" rel="noreferrer" style={{ ...bigButton("secondary"), minHeight: 44, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Open file</a> : <span style={{ fontSize: 13, color: "#6b7280" }}>On the shop NAS</span>}
          </div>
          {canRemove ? (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#b91c1c", minHeight: 44 }}>Remove</summary>
              <ActionForm jobId={job.id} intent="deleteFile" hidden={{ fileId: String(file.id) }}>
                {(busy) => (
                  <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                    <div style={{ fontSize: 14 }}>Remove this file from the job? Only the link on this job is removed.</div>
                    <button type="submit" disabled={busy} style={{ ...bigButton("danger", busy), minHeight: 44 }}>Yes, remove file</button>
                  </div>
                )}
              </ActionForm>
            </details>
          ) : null}
        </div>
      )) : <p style={{ margin: 0, color: "#6b7280" }}>No files yet.</p>}
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700, minHeight: 44 }}>Add a file link</summary>
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
              {jobItems.length > 1 ? (
                <select name="fileItemId" defaultValue="" style={input}>
                  <option value="">For the whole job</option>
                  {jobItems.map((item) => <option key={item.id} value={item.id}>{item.itemTicket || item.productTitle} — {item.displayTitle || item.productTitle}</option>)}
                </select>
              ) : null}
              <button type="submit" disabled={busy} style={bigButton("primary", busy)}>Add file</button>
            </div>
          )}
        </ActionForm>
      </details>
    </div>
  );
}

/**
 * MATERIAL USED — the existing Production "addMaterialUsage" action, in employee
 * words. Same action, same stock logic: nothing is deducted unless the person
 * ticks "Deduct from material stock" (unticked by default, exactly as on the
 * full page), and a deduction only happens for a material chosen from the list.
 * No cost field exists here for anyone; cost comes from the material record.
 */
function MaterialUse({ job, materials, canRecord }: { job: any; materials: { id: string; name: string; unit: string }[]; canRecord: boolean }) {
  const usages = (job.materialUsages || []) as any[];
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.4 }}>MATERIAL USED</div>
      {usages.length ? usages.map((usage) => (
        <div key={usage.id} style={{ padding: "6px 0", borderBottom: "1px solid #f3f4f6", display: "grid", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 15 }}>
            <span style={{ fontWeight: 600 }}>{usage.materialName}</span>
            <span>
              {Number(usage.usedQty || usage.pulledQty || usage.estimatedQty || 0)} {usage.unit}
              {Number(usage.wasteQty || 0) > 0 ? ` · waste ${Number(usage.wasteQty)}` : ""}
              {Number(usage.stockDeductedQty || 0) > 0 ? ` · ${Number(usage.stockDeductedQty)} taken from stock` : ""}
            </span>
          </div>
          {canRecord ? (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#b91c1c", minHeight: 44 }}>Correct material entry</summary>
              <ActionForm jobId={job.id} intent="deleteMaterialUsage" hidden={{ usageId: String(usage.id) }}>
                {(busy) => (
                  <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>Remove this material entry?</div>
                    <div style={{ fontSize: 14 }}>
                      {Number(usage.stockDeductedQty || 0) > 0
                        ? `${Number(usage.stockDeductedQty)} ${usage.unit} was taken from stock for this entry. Removing it puts that amount back into stock.`
                        : "No stock was taken for this entry, so stock will not change."}
                      {" "}Then record the correct amount again.
                    </div>
                    <button type="submit" disabled={busy} style={{ ...bigButton("danger", busy), minHeight: 44 }}>Yes, remove entry</button>
                  </div>
                )}
              </ActionForm>
            </details>
          ) : null}
        </div>
      )) : <div style={{ fontSize: 14, color: "#6b7280" }}>Nothing recorded yet.</div>}
      {canRecord ? (
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 700, minHeight: 44 }}>Record material use</summary>
          <ActionForm jobId={job.id} intent="addMaterialUsage">
            {(busy) => (
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <label style={{ fontSize: 13, color: "#6b7280" }}>Material
                  <select name="materialId" defaultValue="" style={input}>
                    <option value="">Not in the list (type the name below)</option>
                    {materials.map((material) => <option key={material.id} value={material.id}>{material.name}{material.unit ? ` (${material.unit})` : ""}</option>)}
                  </select>
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Quantity used<input name="usedQty" type="number" min={0} step="any" required style={input} /></label>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Waste<input name="wasteQty" type="number" min={0} step="any" style={input} /></label>
                </div>
                <input name="materialNotes" placeholder="Notes (optional)" style={input} />
                <label style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, fontSize: 15 }}>
                  <input type="checkbox" name="deductInventory" style={{ width: 22, height: 22 }} />
                  Deduct from material stock
                </label>
                <div style={{ fontSize: 12, color: "#6b7280" }}>Stock is only deducted when this box is ticked and the material is chosen from the list. It deducts quantity used plus waste.</div>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7280", minHeight: 44 }}>Material is not in the list</summary>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 6 }}>
                    <input name="materialName" placeholder="Material name" style={input} />
                    <input name="unit" placeholder="Unit (sqft, each…)" style={input} />
                  </div>
                </details>
                <button type="submit" disabled={busy} style={bigButton("primary", busy)}>RECORD MATERIAL USE</button>
              </div>
            )}
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
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
      {staffNotes(job.internalNotes) ? <div style={{ padding: 10, borderRadius: 10, background: "#f9fafb", fontSize: 15, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{staffNotes(job.internalNotes)}</div> : null}
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

/* ---------------- small contextual tools (collapsed) ---------------- */

const dateInput = (value: unknown) => {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};
/** The existing updateJob action rewrites all of these; the ones not edited here are sent back unchanged. */
const UPDATE_JOB_KEPT_FIELDS = ["internalNotes", "customerNotes", "artworkUrl", "proofUrl", "printFileUrl", "productImageUrl", "assetFolderUrl", "sourceFolderUrl", "assetInboxKey"] as const;
/** Shipped / Picked Up are set only by a shipment / pickup record (server rule), so they are not offered here. */
const STATUS_CHOICES = PRODUCTION_STATUS_OPTIONS.filter((option) => !["shipped", "picked_up"].includes(option.value));

function MoreTools({ job, role }: { job: any; role: string }) {
  const canSettings = showsProductionControl(role, "updateJob");
  const canStatus = showsProductionControl(role, "changeStatus");
  const canReopen = showsProductionControl(role, "reopenReprint") && String(job.status) === "completed";
  if (!canSettings && !canStatus && !canReopen) return null;
  const section: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 8 };
  return (
    <details style={{ ...card, padding: "10px 16px" }}>
      <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#374151", minHeight: 44 }}>{canSettings ? "Job settings" : "More"}</summary>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 10, alignItems: "start" }}>
        {canSettings ? (
          <div style={section}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>DUE DATE · PRIORITY · ASSIGNED TO</div>
            <ActionForm jobId={job.id} intent="updateJob" hidden={Object.fromEntries(UPDATE_JOB_KEPT_FIELDS.map((field) => [field, String(job[field] ?? "")]))}>
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Due date<input name="dueDate" type="date" defaultValue={dateInput(job.dueDate)} style={input} /></label>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Priority
                    <select name="priority" key={String(job.priority || "normal")} defaultValue={String(job.priority || "normal")} style={input}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="rush">Rush</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 13, color: "#6b7280" }}>Assigned to<input name="assignedTo" defaultValue={job.assignedTo || ""} placeholder="Name" style={input} /></label>
                  <button type="submit" disabled={busy} style={bigButton("primary", busy)}>SAVE JOB SETTINGS</button>
                </div>
              )}
            </ActionForm>
          </div>
        ) : null}
        {canStatus ? (
          <div style={section}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>CHANGE STATUS</div>
            <ActionForm jobId={job.id} intent="changeStatus">
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  {/* 2026-11-15: a Shipped / Picked Up job is not in this list, and the browser then silently
                      pre-selected "New" — one tap on MOVE JOB sent a shipped job back to New. Nothing is
                      pre-selected for such a job; the key re-syncs the list after every move. */}
                  <select name="status" key={String(job.status || "new")} defaultValue={STATUS_CHOICES.some((option) => option.value === String(job.status || "new")) ? String(job.status || "new") : ""} required style={input}>
                    {STATUS_CHOICES.some((option) => option.value === String(job.status || "new")) ? null : <option value="" disabled>Choose a status</option>}
                    {STATUS_CHOICES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>Use this for On Hold, Cancelled or to move the job by hand. Shipping and pickup are recorded in the Fulfill step.</div>
                  <button type="submit" disabled={busy} style={bigButton("secondary", busy)}>MOVE JOB</button>
                </div>
              )}
            </ActionForm>
          </div>
        ) : null}
        {canReopen ? (
          <div style={section}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>REOPEN FOR REPRINT</div>
            <ActionForm jobId={job.id} intent="reopenReprint">
              {(busy) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <input name="reopenReason" placeholder="Why does this finished job need a reprint?" required style={input} />
                  <label style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, fontSize: 15 }}>
                    <input type="checkbox" name="confirmReopen" value="yes" required style={{ width: 22, height: 22 }} />
                    Yes, reopen this completed job
                  </label>
                  <button type="submit" disabled={busy} style={bigButton("danger", busy)}>REOPEN FOR REPRINT</button>
                </div>
              )}
            </ActionForm>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** Only for an unlinked print-intake job, and only for roles the server allows to link it. */
function LinkIntakeJob({ job, role, linkTargets }: { job: any; role: string; linkTargets: any[] }) {
  if (!job.linkEligible || !showsProductionControl(role, "linkJobToTarget")) return null;
  return (
    <details style={{ ...card, borderColor: "#c4b5fd", background: "#faf5ff" }}>
      <summary style={{ cursor: "pointer", fontSize: 15, fontWeight: 800, minHeight: 44 }}>This print file is not linked to an order yet — link it</summary>
      <LinkIntakeForm job={job} linkTargets={linkTargets} />
    </details>
  );
}

function LinkIntakeForm({ job, linkTargets }: { job: any; linkTargets: any[] }) {
  const fetcher = useFetcher<any>();
  const busy = fetcher.state !== "idle";
  const navigate = useNavigate();
  const [chosen, setChosen] = useState("");
  // after a successful link this (intake) job is archived — continue on the job it was linked into
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    const targetId = chosen.split("|")[0];
    navigate(targetId ? jobWorkspaceHref(targetId) : SIMPLE_BOARD_HREF);
  }, [fetcher.state, fetcher.data]);
  return (
    <fetcher.Form method="post" style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <input type="hidden" name="intent" value="linkJobToTarget" />
      <input type="hidden" name="sourceJobId" value={job.id} />
      <label style={{ fontSize: 13, color: "#6b7280" }}>Which job does it belong to?
        <select name="linkTarget" defaultValue="" required style={input} onChange={(event) => setChosen(event.currentTarget.value)}>
          <option value="" disabled>Choose the job</option>
          {linkTargets.map((target: any) => (target.items || []).length > 1
            ? target.items.map((item: any) => <option key={`${target.id}|${item.id}`} value={`${target.id}|${item.id}`}>{target.label} → {String(item.productTitle || "").slice(0, 28)} x{item.quantity}</option>)
            : <option key={target.id} value={`${target.id}|${target.items?.[0]?.id || ""}`}>{target.label}</option>)}
        </select>
      </label>
      <input name="linkReason" placeholder="Reason (optional)" style={input} />
      <label style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, fontSize: 15 }}>
        <input type="checkbox" name="confirmLink" value="yes" required style={{ width: 22, height: 22 }} />
        Yes, this is the right job
      </label>
      <button type="submit" disabled={busy} style={bigButton("primary", busy)}>LINK TO JOB</button>
      <Feedback data={fetcher.data} />
    </fetcher.Form>
  );
}

/* ---------------- page ---------------- */

export default function JobWorkspace() {
  const { job, materials = [], linkTargets = [], showFinancials } = useLoaderData<any>();
  const shell = useRouteLoaderData("routes/app") as any;
  const navigate = useNavigate();
  const role: string = shell?.role || (showFinancials ? "owner" : "unassigned");
  // the server decides who may open the Advanced view (owner / financially authorized manager)
  const canOpenAdvanced = Boolean(showFinancials);
  const canRecordMaterial = showsMaterialUse(role);
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
      secondaryActions={canOpenAdvanced ? [{ content: "Open advanced view", onAction: () => navigate(classicJobHref(job.id)) }] : []}
    >
      <div style={{ display: "grid", gap: 16, paddingBottom: 40 }}>
        <div style={{ ...card, display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Fact label="Customer" value={job.company || job.customerName || "Not set"} />
          <Fact label="Product" value={product} />
          <Fact label="Quantity" value={quantity > 0 ? quantity.toLocaleString() : "Not set"} />
          <Fact label="Due" value={job.dueDate ? `${formatDueDate(job.dueDate)}${overdue ? " · LATE" : ""}` : "Not set"} alert={overdue} />
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

        <LinkIntakeJob job={job} role={role} linkTargets={linkTargets} />

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
            <summary style={{ cursor: "pointer", fontSize: 17, fontWeight: 800, minHeight: 44, color: step.state === "upcoming" ? "#6b7280" : "#111827" }}>
              {step.state === "done" ? "✓ " : `${step.number}. `}{step.label}
              {step.state === "current" ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "#111827", color: "white" }}>NOW</span> : null}
              {step.state === "upcoming" ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600 }}>later</span> : null}
            </summary>
            <div style={{ marginTop: 12 }}>
              <StepBody step={step} job={job} machine={view.machine} showFinancials={showFinancials} materials={materials} canRecordMaterial={canRecordMaterial} role={role} />
            </div>
          </details>
        ))}

        <MoreTools job={job} role={role} />

        <div style={card}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {tabs.map((entry) => (
              <button key={entry.key} type="button" onClick={() => setTab(entry.key)} style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", border: `1px solid ${tab === entry.key ? "#111827" : "#d1d5db"}`, background: tab === entry.key ? "#111827" : "white", color: tab === entry.key ? "white" : "#111827" }}>
                {entry.label.toUpperCase()}
              </button>
            ))}
          </div>
          {tab === "files" ? <FilesTab job={job} role={role} /> : null}
          {tab === "materials" ? <MaterialUse job={job} materials={materials} canRecord={canRecordMaterial} /> : null}
          {tab === "notes" ? <NotesTab job={job} /> : null}
          {tab === "costs" && showFinancials ? <CostsTab job={job} /> : null}
        </div>

        <TicketsAndFiles job={job} role={role} />

        <details style={card}>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#6b7280", minHeight: 44 }}>Advanced / details</summary>
          <div style={{ display: "grid", gap: 12, marginTop: 12, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Fact label="Job ticket" value={job.jobTicket || "—"} />
              <Fact label="Quote" value={job.quoteNumber || "—"} />
              <Fact label="Source" value={jobSourceLabel(job.sourceType)} />
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
            {canOpenAdvanced ? (
              <div>
                <p style={{ margin: "0 0 8px", color: "#6b7280" }}>Actual costs, stock adjustments, asset roles, ticket tools and print-log matching live in the advanced view.</p>
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
