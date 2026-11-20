import { PERMISSION_DENIED_MESSAGE, resolveStaffAccess } from "../lib/staff-roles.server";
import type React from "react";
import { Form, Link, useActionData, useLoaderData, redirect } from "react-router";
import { watcherHealth } from "../lib/print-intake-heartbeat";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import { PRODUCTION_VIEW_DENIED_REDIRECT, roleMayViewProduction } from "../lib/production-role-access";
import db from "../db.server";
import { decodeIntakeOutcomes, type IntakeOutcome } from "../lib/print-intake-routing.server";
import { CREDENTIAL_PLACEHOLDER, credentialStatusLabel, maskCredential } from "../lib/security-guards-shared";
import {
  CONFIRM_PRINT_MODE_LABEL,
  CONFIRM_PRINT_MODE_REASON,
  NEEDS_LINK_TO_ITEM_LABEL,
  NEEDS_LINK_TO_ITEM_REASON,
  cleanIntakeJobSearch,
  intakeAssignableJobsWhere,
  parseBulkIntakeIds,
  NEEDS_LINK_TO_JOB_LABEL,
  PRINTER_CONFLICT_LABEL,
  REVISION_NEEDS_PROOF_LABEL,
  REVISION_NEEDS_PROOF_REASON,
  intakeContentHash,
  PRINTER_CONFLICT_REASONS,
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
      // 15Z.1: canonical ticket documentation (display only — the real
      // parsers/allocator never read this string).
      expectedTicketPattern: "GSO-YYYYMMDD-NNNN (job) / GSO-YYYYMMDD-NNNN-NN (item); run decorations __R#-P#-A# may follow",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const { session } = auth;
  // SERVER HARDENING 2026-11-15: production print pages are for production roles (Sales / unassigned are turned away before anything is read).
  if (!roleMayViewProduction(resolveStaffAccess(auth).role)) throw redirect(PRODUCTION_VIEW_DENIED_REDIRECT);
  const setting = await ensureSetting(session.shop);
  const { outcomes } = decodeIntakeOutcomes(setting.notes);
  // 15H.3: the server-authoritative review queue (PrintIntake rows) plus
  // assignable jobs for the explicit owner ASSIGN action.
  const reviewRows = await db.printIntake.findMany({
    where: { shop: session.shop, status: { in: [...REVIEW_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  // Patch D: optional job search (?q=) — narrows the "Assign to..." list for a
  // person. It is never used for automatic matching.
  const jobQuery = cleanIntakeJobSearch(new URL(request.url).searchParams.get("q"));
  // 15H.4C-N: commercial jobs first — Shopify orders, then quotes, then
  // manual, then anything else. Labels carry ticket + order/quote + name.
  const SOURCE_ORDER: Record<string, number> = { shopify: 0, quote: 1, manual: 2, other: 3, intake: 4 };
  const assignableJobs = (await db.productionJob.findMany({
    where: intakeAssignableJobsWhere(session.shop, jobQuery) as any,
    orderBy: { updatedAt: "desc" },
    take: jobQuery ? 60 : 30,
    select: { id: true, jobTicket: true, quoteId: true, quoteNumber: true, orderGid: true, customerName: true, company: true, items: { select: { id: true, itemTicket: true, productTitle: true }, orderBy: { sortOrder: "asc" } } },
  }))
    .map((job) => ({ ...job, sourceType: jobSourceType(job) }))
    .sort((a, b) => (SOURCE_ORDER[a.sourceType] ?? 9) - (SOURCE_ORDER[b.sourceType] ?? 9))
    .map((job) => ({
      id: job.id,
      jobTicket: job.jobTicket,
      customerName: job.customerName,
      label: `[${job.sourceType}] ${job.jobTicket || job.id} · ${job.quoteNumber || ""} · ${job.customerName || "—"}${job.company ? ` (${job.company})` : ""}`,
      items: job.items,
    }));
  // 15G.1A: the raw upload token never leaves the server — the browser gets
  // only the masked configured/not-configured status.
  return {
    // 2026-11-19: is the watcher on the RIP PC alive? (stamped by its own status call)
    watcher: watcherHealth((setting as any).intakeAgentLastSeenAt),
    incomingFolder: setting.incomingFolder,
    jobQuery,
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
      // Patch C: a review row with no linked job waits for a person to link it (label resolved server-side).
      // Patch B: contradictory printer instructions read as a printer conflict, not as a missing link.
      needsLinkLabel: (row.status === "review" || row.status === "assigned") && PRINTER_CONFLICT_REASONS.includes(String(row.reviewReason || ""))
        ? PRINTER_CONFLICT_LABEL
        : (row.status === "review" || row.status === "assigned") && row.reviewReason === CONFIRM_PRINT_MODE_REASON
          ? CONFIRM_PRINT_MODE_LABEL
          : row.status === "review" && row.reviewReason === NEEDS_LINK_TO_ITEM_REASON
            ? NEEDS_LINK_TO_ITEM_LABEL
            // 2026-11-20: a revision-reorder file waiting for its proof is not "missing a job" — it shows
            // its own label instead of LINK TO JOB.
            : (row.status === "review" || row.status === "assigned") && row.reviewReason === REVISION_NEEDS_PROOF_REASON
              ? REVISION_NEEDS_PROOF_LABEL
              : row.status === "review" && !row.matchedProductionJobId ? NEEDS_LINK_TO_JOB_LABEL : null,
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
  const auth = await authenticate.admin(request);
  const { session } = auth;
  // 2026-11-11 role matrix: intake review needs manageIntake (owner / manager / print operator).
  const staffAccess = resolveStaffAccess(auth);
  if (!staffAccess.can("manageIntake")) return { ok: false, message: `${PERMISSION_DENIED_MESSAGE.manageIntake} ${staffAccess.reason}` };
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const intakeId = String(form.get("intakeId") || "");
  const actor = staffAccess.actor || `admin:${shop}`;

  // Patch D: BULK ASSIGN — several ticked files to ONE existing job. Same
  // permission, same validation as the single Assign (a multi-item job needs the
  // exact item), all-or-nothing, never creates a job, never touches files.
  if (intent === "bulkAssign") {
    const parsedIds = parseBulkIntakeIds(form.getAll("intakeIds"));
    if (!parsedIds.ok) return { ok: false, message: parsedIds.reason };
    const [bulkJobId, bulkItemIdRaw] = String(form.get("target") || "").split("|");
    if (!bulkJobId) return { ok: false, message: "Pick a job/item to assign the ticked files to." };
    const rows = await db.printIntake.findMany({ where: { shop, id: { in: parsedIds.ids } } });
    if (rows.length !== parsedIds.ids.length) return { ok: false, message: "One or more ticked files were not found. Nothing was assigned." };
    const alreadyRouted = rows.filter((candidate) => candidate.status === "routed");
    if (alreadyRouted.length) return { ok: false, message: `${alreadyRouted.length} ticked file(s) are already routed (${alreadyRouted.slice(0, 3).map((candidate) => candidate.originalFilename).join(", ")}). Nothing was assigned.` };
    const bulkJob = await db.productionJob.findFirst({
      where: { id: bulkJobId, shop },
      select: { id: true, shop: true, active: true, status: true, actualCostFinalized: true, jobTicket: true, items: { select: { id: true, itemTicket: true } } },
    });
    const bulkVerdict = validateIntakeAssignment({ shop, job: bulkJob as any, itemId: bulkItemIdRaw || null });
    if (!bulkVerdict.ok) return { ok: false, message: `${bulkVerdict.reason} Nothing was assigned.` };
    for (const candidate of rows) {
      const moved = await deliveredElsewhere(shop, candidate, bulkJob!.id);
      if (moved) return { ok: false, message: `${moved} Nothing was assigned.` };
    }
    const now = new Date().toISOString();
    await db.$transaction([
      ...rows.map((candidate) => db.printIntake.update({ where: { id: candidate.id }, data: intakeAssignmentData(candidate, bulkJob!, bulkVerdict.item, actor, now) })),
      ...rows.map((candidate) => db.productionJobEvent.create({ data: intakeAssignmentEvent(shop, candidate, bulkJob!, bulkVerdict.item, actor) })),
    ] as never);
    return { ok: true, message: `${rows.length} file(s) assigned to ${bulkJob!.jobTicket || bulkJob!.id} — the agent will route them on its next pass.` };
  }

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
    const moved = await deliveredElsewhere(shop, row, job!.id);
    if (moved) return { ok: false, message: moved };
    await db.printIntake.update({ where: { id: row.id }, data: intakeAssignmentData(row, job!, verdict.item, actor, new Date().toISOString()) });
    await db.productionJobEvent.create({ data: intakeAssignmentEvent(shop, row, job!, verdict.item, actor) });
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

// 2026-11-20 (file history is not moved between jobs): an intake row whose file was already DELIVERED
// to a press for one job (a routed print file is on record there) is that job's history. Assigning the
// row to a different job would re-point it, so it is refused; the same file can still be printed for
// another job by saving it into that job's folder (it then gets its own record). Re-linking to another
// item of the SAME job stays allowed.
async function deliveredElsewhere(shop: string, row: { originalFilename: string; fileHashSha256: string; matchedProductionJobId: string | null }, targetJobId: string): Promise<string | null> {
  const currentJobId = row.matchedProductionJobId;
  if (!currentJobId || currentJobId === targetJobId) return null;
  const delivered = await db.productionJobFile.findFirst({
    where: { shop, jobId: currentJobId, fileType: "print_file", assetSource: "nas", sourceRef: intakeContentHash(row.fileHashSha256) },
    select: { id: true, jobTicket: true },
  });
  if (!delivered) return null;
  return `${row.originalFilename} was already sent to a press for ${delivered.jobTicket || "another job"} — that record stays on that job. To print the same file for this job, save it into this job's folder in Prints For Today.`;
}

// One assignment write, shared by the single and the bulk Assign so the two can
// never drift apart (server-only: used by the action above).
type AssignTargetJob = { id: string; jobTicket: string | null };
type AssignTargetItem = { id: string; itemTicket: string | null } | null;

function intakeAssignmentData(row: { reviewReason: string | null; rawParsedHints: string | null }, job: AssignTargetJob, item: AssignTargetItem, actor: string, at: string) {
  return {
    status: "assigned",
    matchedProductionJobId: job.id,
    authoritativeTicket: item?.itemTicket || job.jobTicket || null,
    reviewReason: row.reviewReason,
    rawParsedHints: appendIntakeAudit(
      JSON.stringify({ ...readIntakeMeta(row.rawParsedHints), assignedItemId: item?.id || null }),
      { at, actor, action: "assigned_to_job", reason: `${job.jobTicket || job.id}${item ? ` / ${item.itemTicket || item.id}` : ""}` },
    ),
  };
}

function intakeAssignmentEvent(shop: string, row: { originalFilename: string; fileHashSha256: string }, job: AssignTargetJob, item: AssignTargetItem, actor: string) {
  const ticket = item?.itemTicket || job.jobTicket || null;
  return { shop, jobId: job.id, eventType: "intake_file_assigned", message: `Intake file "${row.originalFilename}" (sha8 ${row.fileHashSha256.slice(0, 8)}) assigned by owner${ticket ? ` as ${ticket}` : ""}. Agent will route it on the next pass.`, createdBy: actor };
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 };
const finePrint: React.CSSProperties = { fontSize: 11, color: "#9ca3af", marginTop: 6 };

// Print flow strip (display only). The same four steps, in the same order,
// appear on Print Intake, RIP Imports, RIP Import Review and Print Logs so
// staff read them as one flow: artwork file -> matched job -> printer ->
// RIP log -> actual usage -> review exceptions. Kept local to this file on
// purpose (no shared module).
const PRINT_FLOW_STEPS = [
  { step: 1, label: "Print Intake", hint: "artwork → hot folder", to: "/app/erp/print-intake" },
  { step: 2, label: "RIP Imports", hint: "printer logs in", to: "/app/erp/rip-imports" },
  { step: 3, label: "RIP Import Review", hint: "fix unmatched", to: "/app/erp/rip-import-review" },
  { step: 4, label: "Print Logs", hint: "actual usage", to: "/app/erp/print-logs" },
] as const;

function PrintFlowStrip({ current }: { current: string }) {
  return (
    <nav aria-label="Print flow" style={{ marginTop: 12, padding: "8px 12px", border: "1px solid #e5e7eb", borderRadius: 10, background: "#f9fafb", fontSize: 13, lineHeight: 1.8 }}>
      <span style={{ fontWeight: 700, color: "#6b7280", marginRight: 8 }}>Print flow:</span>
      {PRINT_FLOW_STEPS.map((item, index) => {
        const active = item.to === current;
        const text = `${item.step} ${item.label} (${item.hint})`;
        return (
          <span key={item.to}>
            {index > 0 ? <span style={{ color: "#9ca3af", margin: "0 6px" }}>·</span> : null}
            {active ? (
              <b aria-current="page" style={{ color: "#111827", background: "#e0e7ff", padding: "2px 8px", borderRadius: 999 }}>{text}</b>
            ) : (
              <Link to={item.to} style={{ color: "#1d4ed8" }}>{text}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// Failure notice: plain sentence for staff, raw server text kept in a
// collapsed "Technical detail". Every ok:false path in this action returns
// before any write, so "nothing was changed" is accurate.
function ActionNotice({ ok, message }: { ok: boolean; message: string }) {
  return (
    <section style={{ ...card, borderColor: ok ? "#86efac" : "#fca5a5", background: ok ? "#f0fdf4" : "#fef2f2" }}>
      {ok ? (
        message
      ) : (
        <>
          <b>That action did not go through — nothing was changed.</b>
          <details style={{ marginTop: 6, fontSize: 13 }}>
            <summary style={{ cursor: "pointer" }}>Technical detail</summary>
            <code style={{ display: "block", marginTop: 4, whiteSpace: "pre-wrap" }}>{message}</code>
          </details>
        </>
      )}
    </section>
  );
}

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
  const { incomingFolder, jobQuery, credential, outcomes, reviewRows, assignableJobs, watcher } = useLoaderData<typeof loader>();
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
        <h1 style={{ margin: 0 }}>Print Intake</h1>
        <p style={{ margin: "8px 0 0" }}>
          Step 1 of the print flow. Staff drop artwork into <b>Prints For Today</b> — nothing else. The local intake agent
          matches each file to exactly one production job (item ticket, job ticket, stored filename, or job subfolder —
          never a guess), copies it to the printer&apos;s hot folder under the exact ERP RIP name, archives the original,
          and logs the outcome below. Files it cannot match stay where staff put them and show up as Needs review.
        </p>
      </section>
      {watcher ? (
        <div role="status" style={{ marginTop: 12, padding: "12px 14px", borderRadius: 10, fontSize: 15, fontWeight: 600, background: watcher.state === "ok" ? "#f0fdf4" : watcher.state === "stale" ? "#fef2f2" : "#fffbeb", color: watcher.state === "ok" ? "#166534" : watcher.state === "stale" ? "#991b1b" : "#92400e" }}>
          {watcher.message}
        </div>
      ) : null}

      <PrintFlowStrip current="/app/erp/print-intake" />

      <section style={card}>
        <b>Intake folder:</b> <code>{incomingFolder}</code>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
          Staff workflow: save the print-ready file into this folder, or into a <b>job folder whose name starts with the job
          ticket</b> (for example <code>GSO-20261118-0003 FLAVAZ</code>) — every file directly inside that folder belongs to that
          existing job, no renaming needed. Only the ticket counts; other folder names are ignored. Done. Files named with
          the item ticket (GSO-YYYYMMDD-NNNN-II) route instantly; the production board&apos;s &quot;Copy Print File
          Name&quot; button gives the exact name.
        </div>
      </section>

      <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
        <b>Which printer gets the file (owner rules, 2026-11-18).</b>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          <b>Gloss prints on either press</b> (the Mimaki gloss / clear channel is back in production). A CMYK-only job, or a
          CMYK + gloss job, goes to the press named on the job or in the filename (<code>ROLAND</code> / <code>MIMAKI</code>), otherwise
          to the <b>Mimaki</b>. Layer files of one job are read together — <code>_cmyk</code> with <code>_g</code> / <code>_gloss</code>{" "}
          (or <code>_w</code> white) — so the whole job goes to one press. <b>White still needs the Roland LG-640</b> (holographic counts —
          it prints a white layer); a white job that also says Mimaki is never sent to the Mimaki and shows as{" "}
          <b>NEEDS REVIEW — PRINTER CONFLICT</b>. There is no load balancing. Other conflicts (both printer tags, a tag against the ERP
          press, a layer already sent to the other press) are also held. A <code>_cmyk</code> layer on a job that states no finish at
          all is held as <b>NEEDS REVIEW — CONFIRM PRINT MODE</b> until the job says what it needs. Roland-bound plans stay in Needs
          review with the blocking reason until the Roland hot folder is confirmed and enabled in the agent config.
        </div>
        <details style={{ ...finePrint, color: "#6b7280" }}>
          <summary style={{ cursor: "pointer" }}>Technical detail (config keys)</summary>
          <div style={{ marginTop: 4 }}>
            Mimaki default profile: <code>GSO_MIMAKI_CMYK_STANDARD</code>. Copies happen only where the agent config enables
            them: <code>MimakiRoutingEnabled</code> / <code>RolandRoutingEnabled</code> ship off, and Roland additionally
            needs its confirmed <code>VersaWorksHotFolder</code> path.
          </div>
        </details>
      </section>

      {actionData?.message ? <ActionNotice ok={Boolean(actionData.ok)} message={actionData.message} /> : null}

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Files needing review</h2>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>
          This queue is the source of truth (the agent&apos;s local ledger is only a cache). <b>Release / Retry</b> lets
          the agent re-plan a blocked file on its next pass; <b>Assign</b> routes it to the exact job/item you pick;{" "}
          <b>Reject</b> stops retries (the file itself is never deleted). Every action is audited.
        </p>
        <Form method="get" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 10px", fontSize: 13 }}>
          <label htmlFor="intake-job-search"><b>Find a job to assign to:</b></label>
          <input id="intake-job-search" name="q" defaultValue={jobQuery} placeholder="ticket, customer, company or order number" style={{ padding: 6, minWidth: 280 }} />
          <button type="submit" style={{ padding: "4px 10px" }}>Search jobs</button>
          {jobQuery ? <Link to="/app/erp/print-intake" style={{ color: "#1d4ed8" }}>Clear</Link> : null}
          <span style={{ color: "#6b7280" }}>
            {jobQuery ? `${assignableJobs.length} open job(s) match "${jobQuery}"` : `Showing the ${assignableJobs.length} most recently updated open jobs`}
            {" "}— this only narrows the lists below; nothing is linked until you press Assign.
          </span>
        </Form>
        {reviewRows.length === 0 ? (
          <p style={{ color: "#6b7280" }}>
            Nothing needs review right now. A file appears here when the intake agent cannot match it to exactly one
            existing job (missing ticket, duplicate, contradictory printer data, or Roland not yet enabled). Dropping a file
            never creates a production job — you Assign it to the real job, or Release / Reject it, from this table.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th align="left" style={{ padding: 6 }}>Pick</th><th align="left">File</th><th align="left">Hash</th><th align="left">Printer / mode</th>
                  <th align="left">Status</th><th align="left">Reason</th><th align="left">Ticket / job</th><th align="left">Updated</th><th align="left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reviewRows.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid #e5e7eb", verticalAlign: "top" }}>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" name="intakeIds" value={row.id} form="intake-bulk-assign" aria-label={`Select ${row.fileName} for bulk assign`} />
                    </td>
                    <td style={{ padding: 6, maxWidth: 260, wordBreak: "break-all" }}>{row.fileName}</td>
                    <td><code>{row.hash8}</code></td>
                    <td>{row.printer || "—"}{row.printMode ? ` / ${row.printMode}` : ""}</td>
                    <td><span style={STATUS_STYLE[row.status || ""] || chip}>{row.needsLinkLabel ? row.needsLinkLabel : ({ retry_allowed: "Retry allowed", needs_review: "Needs review", assigned: "Assigned", rejected: "Rejected", new: "New", auto_created: "Auto-created" } as Record<string, string>)[String(row.status || "")] || String(row.status || "").replaceAll("_", " ")}</span></td>
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
                          <option value="" disabled>{assignableJobs.length ? "Assign to…" : "No open jobs to assign to"}</option>
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
            <Form method="post" id="intake-bulk-assign" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10, padding: 10, border: "1px dashed #c4b5fd", borderRadius: 10, fontSize: 13 }}>
              <input type="hidden" name="intent" value="bulkAssign" />
              <b>Assign every ticked file to one job:</b>
              <select name="target" defaultValue="" style={{ maxWidth: 340 }}>
                <option value="" disabled>{assignableJobs.length ? "Assign ticked files to…" : "No open jobs to assign to"}</option>
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
              <button type="submit" style={{ padding: "4px 10px" }}>Assign ticked files</button>
              <span style={{ color: "#6b7280" }}>
                Use this only for files that truly belong to the same job (for example the layers of one design). A job with several
                items is listed once per item — pick the exact item. All ticked files are assigned, or none.
              </span>
            </Form>
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
          <p style={{ color: "#6b7280" }}>
            No intake outcomes yet. Once the intake agent (setup below) processes a file from Prints For Today, each file
            appears here with its result: Routed, Needs review, Duplicate or Failed, plus the job and printer it went to.
          </p>
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
          Next in the flow: after the job prints, the printer&apos;s log comes in on{" "}
          <Link to="/app/erp/rip-imports">RIP Imports</Link> (step 2); rows that could not be matched to a job are fixed on{" "}
          <Link to="/app/erp/rip-import-review">RIP Import Review</Link> (step 3).
        </p>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 8px" }}>Agent setup</h2>
        <p style={{ ...finePrint, marginTop: 0, marginBottom: 8 }}>Script: <code>tools/gso-print-intake-agent.ps1</code></p>
        <ol style={{ fontSize: 13, lineHeight: 1.9, margin: 0, paddingLeft: 20 }}>
          <li>On the shop PC: copy <code>tools\gso-print-intake-agent-config.example.json</code> to <code>gso-print-intake-agent-config.json</code> (git-ignored) and set <code>UploadToken</code> (see the credential card below — the token itself is only shown once, at rotation).</li>
          <li>Health check (writes nothing): <code>powershell -ExecutionPolicy Bypass -File tools\gso-print-intake-agent.ps1 -Health</code></li>
          <li>Dry run (read-only: no copies, moves or reports, and the ERP records nothing — the server confirms the dry run or the agent stops): <code>... -DryRun</code>, then one real pass: <code>... -Once</code></li>
          <li>Enable routing by setting <code>MimakiRoutingEnabled: true</code> in the config after the dry run looks right.</li>
          <li>Install at startup: <code>schtasks /Create /TN &quot;GSO Print Intake Agent&quot; /SC ONSTART /TR &quot;powershell -ExecutionPolicy Bypass -File C:\path\to\tools\gso-print-intake-agent.ps1 -Loop&quot;</code></li>
        </ol>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
          The old <code>gso-print-intake-watcher.ps1</code> was retired and removed from the repo — it renamed
          originals destructively and routed by filename guesses. If a copy still exists on any shop PC, delete it and
          never schedule it; <code>gso-print-intake-agent.ps1</code> is the only intake agent.
        </p>
      </section>

      <section style={{ ...card, borderColor: "#fcd34d", background: "#fffbeb" }}>
        <b>Print Intake Agent Credential: {credentialStatusLabel(credential)}</b>
        <p style={{ fontSize: 13, marginBottom: 6 }}>
          The full token is never displayed here. In agent configs, set <code>UploadToken</code> to the value
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
