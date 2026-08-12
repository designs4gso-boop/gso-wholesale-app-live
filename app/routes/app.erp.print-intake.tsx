import type React from "react";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { decodeIntakeOutcomes, type IntakeOutcome } from "../lib/print-intake-routing.server";
import { CREDENTIAL_PLACEHOLDER, credentialStatusLabel, maskCredential } from "../lib/security-guards-shared";
import {
  REVIEW_STATUSES,
  appendIntakeAudit,
  readIntakeMeta,
  reviewReasonLabel,
  validateIntakeAssignment,
} from "../lib/print-intake-review.server";
import { jobSourceType } from "../lib/production-job-source.server";

// Print Intake (13A.6G): the staff workflow is now automatic — drop artwork in
// "Prints For Today" and the local intake agent asks the ERP for a
// deterministic routing plan, copies the file into the machine hot folder
// under the exact ERP RIP name, archives the original, and reports every
// outcome back here. This page shows the live outcome log (stored without any
// schema change) plus setup instructions. Loader is read-only apart from the
// long-standing ensureSetting upsert.

async function ensureSetting(shop: string) {
  return db.printLogAutoImportSetting.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      uploadToken: crypto.randomUUID(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\error",
      expectedTicketPattern: "GSO-{jobNumber}_{customer}_{product}_{side}_{material}_{route}_R{revision}",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const setting = await ensureSetting(session.shop);
  const { outcomes } = decodeIntakeOutcomes(setting.notes);
  // 15H.3: the server-authoritative review queue (PrintIntake rows) plus
  // assignable jobs for the explicit owner ASSIGN action.
  const reviewRows = await db.printIntake.findMany({
    where: { shop: session.shop, status: { in: [...REVIEW_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  // 15H.4C-N: commercial jobs first — Shopify orders, then quotes, then
  // manual, then anything else. Labels carry ticket + order/quote + name.
  const SOURCE_ORDER: Record<string, number> = { shopify: 0, quote: 1, manual: 2, other: 3, intake: 4 };
  const assignableJobs = (await db.productionJob.findMany({
    where: { shop: session.shop, active: true, actualCostFinalized: false, status: { notIn: ["completed", "cancelled", "canceled", "archived"] } },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: { id: true, jobTicket: true, quoteId: true, quoteNumber: true, orderGid: true, customerName: true, items: { select: { id: true, itemTicket: true, productTitle: true }, orderBy: { sortOrder: "asc" } } },
  }))
    .map((job) => ({ ...job, sourceType: jobSourceType(job) }))
    .sort((a, b) => (SOURCE_ORDER[a.sourceType] ?? 9) - (SOURCE_ORDER[b.sourceType] ?? 9))
    .map((job) => ({
      id: job.id,
      jobTicket: job.jobTicket,
      customerName: job.customerName,
      label: `[${job.sourceType}] ${job.jobTicket || job.id} · ${job.quoteNumber || ""} · ${job.customerName || "—"}`,
      items: job.items,
    }));
  // 15G.1A: the raw upload token never leaves the server — the browser gets
  // only the masked configured/not-configured status.
  return {
    incomingFolder: setting.incomingFolder,
    credential: maskCredential(setting.uploadToken),
    outcomes: outcomes.slice(0, 50),
    reviewRows: reviewRows.map((row) => ({
      id: row.id,
      fileName: row.originalFilename,
      hash8: row.fileHashSha256.slice(0, 8),
      printer: row.printer,
      printMode: row.printMode,
      status: row.status,
      reviewReason: row.reviewReason,
      reasonLabel: reviewReasonLabel(row.reviewReason),
      ticket: row.authoritativeTicket,
      matchedProductionJobId: row.matchedProductionJobId,
      generatedProductionJobId: row.generatedProductionJobId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    assignableJobs,
  };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const intakeId = String(form.get("intakeId") || "");
  const actor = `admin:${shop}`;
  const row = await db.printIntake.findFirst({ where: { id: intakeId, shop } });
  if (!row) return { ok: false, message: "Intake record not found." };

  // 15H.3-F: RELEASE / RETRY — server-authoritative; the agent re-plans on
  // its next pass. Idempotent; never creates a job or touches files here.
  if (intent === "release") {
    if (row.status === "routed") return { ok: false, message: `${row.originalFilename} is already routed.` };
    await db.printIntake.update({
      where: { id: row.id },
      data: {
        status: "retry_allowed",
        rawParsedHints: appendIntakeAudit(row.rawParsedHints, { at: new Date().toISOString(), actor, action: "released_for_retry", reason: row.reviewReason }),
      },
    });
    return { ok: true, message: `${row.originalFilename} released — the agent will re-plan it on its next pass.` };
  }

  // 15H.3-I: ASSIGN — exact owner selection only; shop-scoped; multi-item
  // jobs require the explicit item; closed/finalized jobs refuse.
  if (intent === "assign") {
    const selection = String(form.get("target") || ""); // jobId|itemId
    const [jobId, itemIdRaw] = selection.split("|");
    const itemId = itemIdRaw || null;
    if (!jobId) return { ok: false, message: "Pick a job/item to assign." };
    const job = await db.productionJob.findFirst({
      where: { id: jobId, shop },
      select: { id: true, shop: true, active: true, status: true, actualCostFinalized: true, jobTicket: true, items: { select: { id: true, itemTicket: true } } },
    });
    const verdict = validateIntakeAssignment({ shop, job: job as any, itemId });
    if (!verdict.ok) return { ok: false, message: verdict.reason };
    const ticket = verdict.item?.itemTicket || job!.jobTicket || null;
    await db.printIntake.update({
      where: { id: row.id },
      data: {
        status: "assigned",
        matchedProductionJobId: job!.id,
        authoritativeTicket: ticket,
        reviewReason: row.reviewReason,
        rawParsedHints: appendIntakeAudit(
          JSON.stringify({ ...readIntakeMeta(row.rawParsedHints), assignedItemId: verdict.item?.id || null }),
          { at: new Date().toISOString(), actor, action: "assigned_to_job", reason: `${job!.jobTicket || job!.id}${verdict.item ? ` / ${verdict.item.itemTicket || verdict.item.id}` : ""}` },
        ),
      },
    });
    await db.productionJobEvent.create({
      data: { shop, jobId: job!.id, eventType: "intake_file_assigned", message: `Intake file "${row.originalFilename}" (sha8 ${row.fileHashSha256.slice(0, 8)}) assigned by owner${ticket ? ` as ${ticket}` : ""}. Agent will route it on the next pass.`, createdBy: actor },
    });
    return { ok: true, message: `${row.originalFilename} assigned to ${job!.jobTicket || job!.id} — the agent will route it on its next pass.` };
  }

  // 15H.3-J: REJECT — explicit confirmation; agent stops retrying; the file
  // itself is never deleted or moved by the server.
  if (intent === "reject") {
    if (String(form.get("confirmReject") || "") !== "yes") return { ok: false, message: "Check the confirmation box to reject this file." };
    await db.printIntake.update({
      where: { id: row.id },
      data: {
        status: "rejected",
        reviewReason: "rejected_by_owner",
        rawParsedHints: appendIntakeAudit(row.rawParsedHints, { at: new Date().toISOString(), actor, action: "rejected_by_owner", reason: String(form.get("rejectReason") || "").slice(0, 200) || null }),
      },
    });
    return { ok: true, message: `${row.originalFilename} rejected — the agent will stop retrying it. The file stays in Prints For Today until you move it.` };
  }

  return { ok: false, message: "Unknown action." };
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 };

const DECISION_STYLE: Record<IntakeOutcome["decision"], React.CSSProperties> = {
  routed: { ...chip, background: "#dcfce7", color: "#166534" },
  needs_review: { ...chip, background: "#fef3c7", color: "#92400e" },
  duplicate: { ...chip, background: "#e0e7ff", color: "#3730a3" },
  failed: { ...chip, background: "#fee2e2", color: "#991b1b" },
};

const DECISION_LABEL: Record<IntakeOutcome["decision"], string> = {
  routed: "Routed",
  needs_review: "Needs review",
  duplicate: "Duplicate",
  failed: "Failed",
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  review: { ...chip, background: "#fef3c7", color: "#92400e" },
  failed: { ...chip, background: "#fee2e2", color: "#991b1b" },
  retry_allowed: { ...chip, background: "#dbeafe", color: "#1e40af" },
  assigned: { ...chip, background: "#ede9fe", color: "#5b21b6" },
  rejected: { ...chip, background: "#e5e7eb", color: "#374151" },
};

export default function PrintIntake() {
  const { incomingFolder, credential, outcomes, reviewRows, assignableJobs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const counts = {
    routed: outcomes.filter((outcome) => outcome.decision === "routed").length,
    needs_review: outcomes.filter((outcome) => outcome.decision === "needs_review").length,
    duplicate: outcomes.filter((outcome) => outcome.decision === "duplicate").length,
    failed: outcomes.filter((outcome) => outcome.decision === "failed").length,
  };
  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#064e3b)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Print Intake Automation</h1>
        <p style={{ margin: "8px 0 0" }}>
          Patch 13A.6G: staff drop artwork into <b>Prints For Today</b> — nothing else. The local intake agent maps each
          file to exactly one production job (item ticket, job ticket, stored filename, or job subfolder — never fuzzy),
          copies it to the machine hot folder under the exact ERP RIP name, archives the original, and logs the outcome
          below. Unresolved files stay where staff put them and appear as Needs review.
        </p>
      </section>

      <section style={card}>
        <b>Intake folder:</b> <code>{incomingFolder}</code>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
          Staff workflow: save the print-ready file into this folder (or the job&apos;s subfolder). Done. Files named with
          the item ticket (GSO-YYYYMMDD-NNNN-II) route instantly; the production board&apos;s &quot;Copy Print File
          Name&quot; button gives the exact name.
        </div>
      </section>

      <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
        <b>Machine routing (finalized rules).</b>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          <b>White and/or gloss &rarr; Roland LG-640 (the Mimaki is CMYK only).</b> CMYK-only jobs explicitly assigned to Roland in the ERP, or
          named with the standalone <code>ROLAND</code> filename tag, also route to Roland. All other CMYK-only jobs
          default to the <b>Mimaki UCJV300</b> (<code>GSO_MIMAKI_CMYK_STANDARD</code>). Contradictory data (for example
          a white/gloss job explicitly assigned to the CMYK-only Mimaki) goes to Needs review. Copies happen only where
          the config enables them: <code>MimakiRoutingEnabled</code> / <code>RolandRoutingEnabled</code> ship off, and
          Roland additionally needs its confirmed <code>VersaWorksHotFolder</code> path — until then Roland-bound plans
          appear as Needs review with the blocking reason.
        </div>
      </section>

      {actionData?.message ? (
        <section style={{ ...card, borderColor: actionData.ok ? "#86efac" : "#fca5a5", background: actionData.ok ? "#f0fdf4" : "#fef2f2" }}>
          {actionData.message}
        </section>
      ) : null}

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Review queue (server-authoritative)</h2>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>
          15H.3: the agent&apos;s local ledger is a cache — this queue is the truth. <b>Release / Retry</b> lets the agent
          re-plan a blocked file on its next pass; <b>Assign</b> routes it to an exact job/item you pick; <b>Reject</b>
          stops retries (the file itself is never deleted). Every action is audited.
        </p>
        {reviewRows.length === 0 ? (
          <p style={{ color: "#6b7280" }}>Nothing needs review — unticketed files with deterministic hints auto-create and route.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th align="left" style={{ padding: 6 }}>File</th><th align="left">Hash</th><th align="left">Printer / mode</th>
                  <th align="left">Status</th><th align="left">Reason</th><th align="left">Ticket / job</th><th align="left">Updated</th><th align="left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reviewRows.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid #e5e7eb", verticalAlign: "top" }}>
                    <td style={{ padding: 6, maxWidth: 260, wordBreak: "break-all" }}>{row.fileName}</td>
                    <td><code>{row.hash8}</code></td>
                    <td>{row.printer || "—"}{row.printMode ? ` / ${row.printMode}` : ""}</td>
                    <td><span style={STATUS_STYLE[row.status || ""] || chip}>{row.status}</span></td>
                    <td style={{ maxWidth: 240 }}>{row.reasonLabel}</td>
                    <td>{row.ticket || (row.matchedProductionJobId || row.generatedProductionJobId ? "linked" : "—")}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(row.updatedAt).toLocaleString()}</td>
                    <td style={{ minWidth: 320 }}>
                      {row.status !== "rejected" ? (
                        <Form method="post" style={{ display: "inline-block", marginRight: 6 }}>
                          <input type="hidden" name="intent" value="release" />
                          <input type="hidden" name="intakeId" value={row.id} />
                          <button type="submit" style={{ padding: "4px 10px" }}>Release / Retry</button>
                        </Form>
                      ) : (
                        <Form method="post" style={{ display: "inline-block", marginRight: 6 }}>
                          <input type="hidden" name="intent" value="release" />
                          <input type="hidden" name="intakeId" value={row.id} />
                          <button type="submit" style={{ padding: "4px 10px" }}>Un-reject &amp; Retry</button>
                        </Form>
                      )}
                      <Form method="post" style={{ display: "inline-block", marginRight: 6 }}>
                        <input type="hidden" name="intent" value="assign" />
                        <input type="hidden" name="intakeId" value={row.id} />
                        <select name="target" defaultValue="" style={{ maxWidth: 200 }}>
                          <option value="" disabled>Assign to…</option>
                          {assignableJobs.map((job) => (
                            job.items.length > 1
                              ? job.items.map((item) => (
                                  <option key={item.id} value={`${job.id}|${item.id}`}>
                                    {job.label} → {item.itemTicket || item.id} — {item.productTitle.slice(0, 26)}
                                  </option>
                                ))
                              : <option key={job.id} value={`${job.id}|${job.items[0]?.id || ""}`}>{job.label}</option>
                          ))}
                        </select>
                        <button type="submit" style={{ padding: "4px 10px", marginLeft: 4 }}>Assign</button>
                      </Form>
                      {row.status !== "rejected" ? (
                        <Form method="post" style={{ display: "inline-block" }}>
                          <input type="hidden" name="intent" value="reject" />
                          <input type="hidden" name="intakeId" value={row.id} />
                          <label style={{ fontSize: 11, marginRight: 4 }}>
                            <input type="checkbox" name="confirmReject" value="yes" /> confirm
                          </label>
                          <button type="submit" style={{ padding: "4px 10px" }}>Reject</button>
                        </Form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Recent intake outcomes</h2>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>
          <span style={DECISION_STYLE.routed}>Routed: {counts.routed}</span>{" "}
          <span style={DECISION_STYLE.needs_review}>Needs review: {counts.needs_review}</span>{" "}
          <span style={DECISION_STYLE.duplicate}>Duplicates: {counts.duplicate}</span>{" "}
          <span style={DECISION_STYLE.failed}>Failed: {counts.failed}</span>{" "}
          <span>(last {outcomes.length} outcomes; file names only — no local paths)</span>
        </p>
        {outcomes.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No intake outcomes reported yet — install and run the agent below.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th align="left" style={{ padding: 6 }}>When</th><th align="left">File</th><th align="left">Outcome</th>
                  <th align="left">Rule / reason</th><th align="left">Job / item</th><th align="left">RIP name</th><th align="left">Machine</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((outcome, index) => (
                  <tr key={`${outcome.fileName}-${outcome.at}-${index}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(outcome.at).toLocaleString()}</td>
                    <td>{outcome.fileName}</td>
                    <td><span style={DECISION_STYLE[outcome.decision] || chip}>{DECISION_LABEL[outcome.decision] || outcome.decision}</span></td>
                    <td>{outcome.rule || outcome.reason || "—"}</td>
                    <td>{outcome.itemTicket || outcome.jobTicket || "—"}</td>
                    <td>{outcome.ripName || "—"}</td>
                    <td>{outcome.machine || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 13, marginTop: 10 }}>
          Unmatched RIP <i>results</i> (after printing) are a separate workflow:{" "}
          <Link to="/app/erp/rip-import-review">RIP Import Review</Link>.
        </p>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 8px" }}>Agent setup (tools/gso-print-intake-agent.ps1)</h2>
        <ol style={{ fontSize: 13, lineHeight: 1.9, margin: 0, paddingLeft: 20 }}>
          <li>On the shop PC: copy <code>tools\gso-print-intake-agent-config.example.json</code> to <code>gso-print-intake-agent-config.json</code> (git-ignored) and set <code>UploadToken</code> (see the credential card below — the token itself is only shown once, at rotation).</li>
          <li>Health check (writes nothing): <code>powershell -ExecutionPolicy Bypass -File tools\gso-print-intake-agent.ps1 -Health</code></li>
          <li>Dry run (plans only, no copies/moves/reports): <code>... -DryRun</code>, then one real pass: <code>... -Once</code></li>
          <li>Enable routing by setting <code>MimakiRoutingEnabled: true</code> in the config after the dry run looks right.</li>
          <li>Install at startup: <code>schtasks /Create /TN &quot;GSO Print Intake Agent&quot; /SC ONSTART /TR &quot;powershell -ExecutionPolicy Bypass -File C:\path\to\tools\gso-print-intake-agent.ps1 -Loop&quot;</code></li>
        </ol>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
          The old <code>gso-print-intake-watcher.ps1</code> is retired — it renamed originals destructively, routed by
          filename guesses, and its upload call cannot work on Windows PowerShell 5.1. Do not schedule it.
        </p>
      </section>

      <section style={{ ...card, borderColor: "#fcd34d", background: "#fffbeb" }}>
        <b>Print Intake Agent Credential: {credentialStatusLabel(credential)}</b>
        <p style={{ fontSize: 13, marginBottom: 6 }}>
          The full token is never displayed here (15G.1A). In agent configs, set <code>UploadToken</code> to the value
          in place of <code>{CREDENTIAL_PLACEHOLDER}</code>. To obtain a value, rotate the token on{" "}
          <Link to="/app/erp/print-log-settings">Print Log Settings</Link> — the new token is shown exactly once at
          rotation and never again. Never commit the real config — it is git-ignored.
        </p>
        {!credential.configured ? (
          <p style={{ fontSize: 13, color: "#991b1b" }}>
            No credential is configured yet — open Print Log Settings and rotate the token to create one.
          </p>
        ) : null}
      </section>
    </main>
  );
}
