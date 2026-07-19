import type React from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  CONFIDENCE_LABELS,
  DAYS_FILTERS,
  FETCH_BOUND,
  PAGE_SIZE,
  REVIEW_STATUS_LABELS,
  SOURCE_FILTERS,
  STATUS_FILTERS,
  type ReviewStatus,
} from "../lib/rip-import-review-shared";
import {
  buildEntryUpdate,
  bulkEligibility,
  classifyEntries,
  filterEntries,
  paginate,
  parseImportSummary,
  rankCandidates,
  scopedEntryWhere,
  scopedJobWhere,
  timingDetails,
  validateMutation,
  type CandidateJob,
} from "../lib/rip-import-review.server";
import { attributeMachine } from "../lib/rip-actual-costs.server";
import {
  RIP_BACKFILL_PHRASE,
  appendRawRowBlock,
  attributeEntryToItem,
  resolvePrintDuration,
} from "../lib/rip-duration.server";

// 13A.7C: shared duration/attribution audit over recent ATTACHED rows. Used
// by the loader (read-only display) and re-computed fresh by the backfill
// action — eligibility is deterministic from stored data, so preview and
// apply always agree.
async function computeRipBackfillAudit(shop: string) {
  const entries = await db.printLogEntry.findMany({
    where: { shop, productionJobId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: {
      id: true, productionJobId: true, productionJobItemId: true, jobTicket: true, sourceJobName: true,
      printerSoftware: true, machineName: true, status: true, printMinutes: true, rawRow: true,
    },
  });
  const jobIds = [...new Set(entries.map((entry) => entry.productionJobId).filter(Boolean))] as string[];
  const jobs = jobIds.length
    ? await db.productionJob.findMany({
        where: { shop, id: { in: jobIds } },
        select: {
          id: true, jobTicket: true,
          items: { select: { id: true, itemTicket: true, ripJobName: true, suggestedFileName: true, productTitle: true } },
          files: { select: { fileName: true, originalFileName: true }, take: 20 },
        },
      })
    : [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  const counts = {
    attachedRows: entries.length,
    rolandRows: 0,
    nativeDuration: 0,
    derivedDuration: 0,
    unknownDuration: 0,
    exactItem: 0,
    singleItemFallback: 0,
    jobLevelOnly: 0,
    unresolved: 0,
    durationEligible: 0,
    itemEligible: 0,
  };
  const auditRows: Array<Record<string, unknown>> = [];
  const eligible: Array<{ id: string; jobId: string; data: { printMinutes?: number; productionJobItemId?: string }; rawRowNext: string; fills: string[] }> = [];

  for (const entry of entries) {
    const job = jobById.get(entry.productionJobId as string);
    if (!job) continue;
    const brand = attributeMachine(entry);
    const duration = resolvePrintDuration(entry);
    const isCut = String(entry.status || "").toLowerCase().startsWith("cut:");
    if (brand === "roland") counts.rolandRows += 1;
    if (!isCut) {
      if (duration.source === "imported_native") counts.nativeDuration += 1;
      else if (duration.source === "derived_print_timestamps") counts.derivedDuration += 1;
      else counts.unknownDuration += 1;
    }
    const attribution = attributeEntryToItem(entry, {
      id: job.id,
      jobTicket: job.jobTicket,
      items: job.items,
      fileNames: job.files.flatMap((file) => [file.fileName, file.originalFileName || ""]).filter(Boolean),
    });
    if (attribution.confidence === "exact") counts.exactItem += 1;
    else if (attribution.confidence === "fallback") counts.singleItemFallback += 1;
    else if (attribution.confidence === "job_level") counts.jobLevelOnly += 1;
    else counts.unresolved += 1;

    // Deterministic backfill eligibility: FILL-ONLY, never overwrite.
    const fills: string[] = [];
    const data: { printMinutes?: number; productionJobItemId?: string } = {};
    let rawRowNext = entry.rawRow || "";
    const storedMinutes = Number(entry.printMinutes) || 0;
    if (!isCut && storedMinutes === 0 && duration.source === "derived_print_timestamps" && duration.minutes > 0) {
      data.printMinutes = duration.minutes;
      rawRowNext = appendRawRowBlock(rawRowNext, "durationBackfill", {
        engine: "13A.7C", source: duration.source, minutes: duration.minutes,
        printStartRaw: duration.printStartRaw, printEndRaw: duration.printEndRaw,
        previousPrintMinutes: 0, appliedBy: "rip-import-review",
      });
      fills.push("duration");
      counts.durationEligible += 1;
    }
    if (!entry.productionJobItemId && attribution.productionJobItemId && (attribution.confidence === "exact" || attribution.confidence === "fallback")) {
      data.productionJobItemId = attribution.productionJobItemId;
      rawRowNext = appendRawRowBlock(rawRowNext, "itemAttributionBackfill", {
        engine: "13A.7C", method: attribution.method, confidence: attribution.confidence,
        candidateCount: attribution.candidateCount, appliedBy: "rip-import-review",
      });
      fills.push("item");
      counts.itemEligible += 1;
    }
    if (fills.length) eligible.push({ id: entry.id, jobId: job.id, data, rawRowNext, fills });

    if (auditRows.length < 50) {
      auditRows.push({
        id: entry.id,
        sourceJobName: entry.sourceJobName || "",
        jobTicket: entry.jobTicket || "",
        printer: `${entry.printerSoftware || "?"}${entry.machineName ? `/${entry.machineName}` : ""}`,
        brand: brand || "unknown",
        isCut,
        storedMinutes,
        selectedMinutes: duration.minutes,
        durationSource: duration.source,
        printStartRaw: duration.printStartRaw,
        printEndRaw: duration.printEndRaw,
        jobId: job.id,
        jobTicketOfJob: job.jobTicket,
        itemAttribution: attribution.method,
        itemConfidence: attribution.confidence,
        attributedItemId: entry.productionJobItemId || attribution.productionJobItemId,
        fills,
        warnings: [...duration.warnings, ...attribution.warnings],
      });
    }
  }
  return { counts, auditRows, eligible };
}

// RIP Import Review (13A.6C): inspect unmatched/ambiguous PrintLogEntry rows
// from RasterLink AND VersaWorks and attach them to the correct ProductionJob
// with explicit confirmation, stale-write protection, and rawRow audit
// metadata. Writes touch ONLY PrintLogEntry.productionJobId + rawRow (audit)
// and add ProductionJobEvent audit rows — never ink, timing, names, tickets,
// imports, or any calculator/quote/production logic.

const ENTRY_SELECT = {
  id: true, importId: true, productionJobId: true, jobTicket: true, sourceJobName: true,
  printerSoftware: true, machineName: true, mediaName: true, status: true,
  inkMl: true, printMinutes: true, startedAt: true, completedAt: true, createdAt: true, rawRow: true,
} as const;

const JOB_SELECT = { id: true, jobTicket: true, customerName: true, company: true, status: true, createdAt: true } as const;

function jobLabel(job: CandidateJob): string {
  const created = job.createdAt ? new Date(job.createdAt).toLocaleDateString() : "";
  return `${job.jobTicket || job.id} | ${job.company || job.customerName || "No customer"} | ${job.status}${created ? ` | ${created}` : ""}`;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const filters = {
    status: url.searchParams.get("status") || "unresolved",
    source: url.searchParams.get("source") || "all",
    days: url.searchParams.get("days") || "30",
    q: url.searchParams.get("q") || "",
    warningsOnly: url.searchParams.get("warnings") === "1",
    page: Number(url.searchParams.get("page") || "1") || 1,
  };

  const cutoff = filters.days !== "all" ? new Date(Date.now() - (Number(filters.days) || 30) * 24 * 60 * 60 * 1000) : null;
  const where = {
    shop,
    ...(filters.status === "attached" ? { productionJobId: { not: null } } : filters.status !== "all" ? { productionJobId: null } : {}),
    ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
  };

  const [entries, recentJobs, ripNames, imports] = await Promise.all([
    db.printLogEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: FETCH_BOUND, select: ENTRY_SELECT }),
    db.productionJob.findMany({ where: { shop, active: true }, orderBy: { updatedAt: "desc" }, take: 200, select: JOB_SELECT }),
    db.productionJobItem.findMany({ where: { shop, ripJobName: { not: null } }, take: 300, select: { jobId: true, ripJobName: true } }),
    db.printLogImport.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, source: true, fileName: true, rowCount: true, matchedCount: true, unmatchedCount: true, status: true, createdAt: true, notes: true },
    }),
  ]);

  const classified = classifyEntries(entries);
  const counts = {
    fetched: classified.length,
    unmatched: classified.filter((entry) => entry.reviewStatus === "unmatched").length,
    ambiguous: classified.filter((entry) => entry.reviewStatus === "ambiguous").length,
    attached: classified.filter((entry) => entry.reviewStatus === "attached").length,
    bounded: entries.length === FETCH_BOUND,
  };
  const filtered = filterEntries(classified, filters);
  const { pageItems, page, pageCount, total } = paginate(filtered, filters.page, PAGE_SIZE);

  // Exact-ticket candidates for the visible page (bounded IN query), merged
  // with recent jobs for similarity suggestions + the manual dropdown.
  const pageTickets = [...new Set(pageItems.map((entry) => String(entry.jobTicket || "").trim()).filter(Boolean))];
  const ticketJobs = pageTickets.length
    ? await db.productionJob.findMany({ where: { shop, jobTicket: { in: pageTickets } }, take: 100, select: JOB_SELECT })
    : [];
  const jobPool: CandidateJob[] = [...ticketJobs, ...recentJobs.filter((job) => !ticketJobs.some((t) => t.id === job.id))];

  const attachedIds = [...new Set(pageItems.map((entry) => entry.productionJobId).filter(Boolean))] as string[];
  const attachedJobs = attachedIds.length
    ? await db.productionJob.findMany({ where: { shop, id: { in: attachedIds } }, select: JOB_SELECT })
    : [];
  const attachedById = new Map(attachedJobs.map((job) => [job.id, job]));

  const importById = new Map(imports.map((item) => [item.id, item]));
  const rows = pageItems.map((entry) => ({
    id: entry.id,
    reviewStatus: entry.reviewStatus,
    warnings: entry.warnings,
    source: entry.printerSoftware || "unknown",
    importFileName: importById.get(entry.importId)?.fileName || null,
    sourceJobName: entry.sourceJobName || "",
    jobTicket: entry.jobTicket || "",
    status: entry.status || "",
    machineName: entry.machineName || "",
    mediaName: entry.mediaName || "",
    inkMl: Number(entry.inkMl) || 0,
    printMinutes: Number(entry.printMinutes) || 0,
    startedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
    completedAt: entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
    importedAt: new Date(entry.createdAt).toISOString(),
    timing: timingDetails(entry),
    productionJobId: entry.productionJobId,
    attachedJob: entry.productionJobId ? attachedById.get(entry.productionJobId) || null : null,
    candidates: entry.reviewStatus === "attached" ? [] : rankCandidates(entry, jobPool, ripNames),
  }));

  const backfillAudit = await computeRipBackfillAudit(shop);

  return {
    shop,
    filters,
    counts,
    rows,
    page,
    pageCount,
    total,
    backfillAudit: { counts: backfillAudit.counts, auditRows: backfillAudit.auditRows, eligibleCount: backfillAudit.eligible.length },
    recentJobs,
    imports: imports.map((item) => ({
      id: item.id,
      source: item.source,
      fileName: item.fileName || "(pasted text)",
      rowCount: item.rowCount,
      matchedCount: item.matchedCount,
      unmatchedCount: item.unmatchedCount,
      status: item.status,
      createdAt: new Date(item.createdAt).toISOString(),
      summary: parseImportSummary(item.notes), // structured counters only — raw notes text is never sent to the client
    })),
  };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const confirm = String(form.get("confirm") || "");

  if (intent === "rematch" || intent === "unmatch") {
    const entryId = String(form.get("entryId") || "");
    const jobId = String(form.get("jobId") || "");
    const expectedJobId = String(form.get("expectedJobId") || "");
    const entry = entryId ? await db.printLogEntry.findFirst({ where: scopedEntryWhere(shop, entryId), select: ENTRY_SELECT }) : null;
    const job = intent === "rematch" && jobId
      ? await db.productionJob.findFirst({ where: scopedJobWhere(shop, jobId), select: JOB_SELECT })
      : null;

    const verdict = validateMutation({ intent, entry, job, expectedJobId, confirm });
    if (!verdict.ok) return { ok: false, message: verdict.error };

    const target = intent === "rematch" ? (job as CandidateJob) : null;
    const update = buildEntryUpdate(entry!, target ? target.id : null, shop);
    const eventJobId = target ? target.id : entry!.productionJobId!;
    await db.$transaction([
      db.printLogEntry.update({ where: { id: entry!.id }, data: update }),
      db.productionJobEvent.create({
        data: {
          shop,
          jobId: eventJobId,
          eventType: target ? "print_log_manual_match" : "print_log_manual_unmatch",
          message: target
            ? `Print log row manually attached in RIP Import Review: ${entry!.sourceJobName || entry!.id}.`
            : `Print log row manually detached in RIP Import Review: ${entry!.sourceJobName || entry!.id}.`,
          oldValue: entry!.productionJobId,
          newValue: target ? target.id : null,
          createdBy: "rip-import-review",
        },
      }),
    ]);
    return {
      ok: true,
      message: target
        ? `Attached "${entry!.sourceJobName || entry!.id}" to ${target.jobTicket || target.id}.`
        : `Detached "${entry!.sourceJobName || entry!.id}" from its production job.`,
    };
  }

  if (intent === "bulkRematch") {
    const entryIds = [...new Set(form.getAll("entryIds").map((value) => String(value)).filter(Boolean))];
    const jobId = String(form.get("jobId") || "");
    if (confirm !== "yes") return { ok: false, message: "Confirmation checkbox is required — nothing was changed." };
    if (!entryIds.length || entryIds.length > PAGE_SIZE) return { ok: false, message: "Select between 2 and 50 rows for a bulk attach." };

    const selected = await db.printLogEntry.findMany({ where: { shop, id: { in: entryIds } }, select: ENTRY_SELECT });
    if (selected.length !== entryIds.length) {
      return { ok: false, message: "Some selected rows were not found in this shop — refresh and try again. Nothing was changed." };
    }
    if (selected.some((entry) => entry.productionJobId)) {
      return { ok: false, message: "A selected row is already attached (changed since page load) — refresh and review. Nothing was changed." };
    }
    const eligibility = bulkEligibility(selected);
    if (!eligibility.eligible) return { ok: false, message: eligibility.reason };

    const job = jobId ? await db.productionJob.findFirst({ where: scopedJobWhere(shop, jobId), select: JOB_SELECT }) : null;
    if (!job) return { ok: false, message: "Production job not found in this shop — nothing was changed." };

    await db.$transaction([
      ...selected.map((entry) =>
        db.printLogEntry.update({ where: { id: entry.id }, data: buildEntryUpdate(entry, job.id, shop) }),
      ),
      db.productionJobEvent.create({
        data: {
          shop,
          jobId: job.id,
          eventType: "print_log_manual_match",
          message: `${selected.length} print log rows bulk-attached in RIP Import Review (${eligibility.reason}).`,
          oldValue: null,
          newValue: job.id,
          createdBy: "rip-import-review",
        },
      }),
    ]);
    return { ok: true, message: `Attached ${selected.length} rows to ${job.jobTicket || job.id}.` };
  }

  // 13A.7C: owner-gated deterministic backfill — FILL-ONLY (missing duration
  // from exact print stamps; missing item attribution from exact/single-item
  // tiers). Never overwrites nonzero minutes or a different item id; one
  // transaction; provenance appended to rawRow; per-job audit events.
  if (intent === "applyRipBackfill") {
    const phrase = String(form.get("confirmPhrase") || "");
    if (phrase !== RIP_BACKFILL_PHRASE) {
      return { ok: false, message: `Confirmation phrase must be exactly "${RIP_BACKFILL_PHRASE}" (case-sensitive) — nothing was written.` };
    }
    const { eligible } = await computeRipBackfillAudit(shop);
    if (!eligible.length) return { ok: false, message: "No deterministic backfill candidates — nothing to write." };
    const affectedJobs = [...new Set(eligible.map((row) => row.jobId))];
    const durationFills = eligible.filter((row) => row.fills.includes("duration")).length;
    const itemFills = eligible.filter((row) => row.fills.includes("item")).length;
    await db.$transaction([
      ...eligible.map((row) =>
        db.printLogEntry.update({ where: { id: row.id }, data: { ...row.data, rawRow: row.rawRowNext } }),
      ),
      ...affectedJobs.map((jobId) =>
        db.productionJobEvent.create({
          data: {
            shop,
            jobId,
            eventType: "rip_backfill_applied",
            message: `Verified RIP backfill applied: filled ${durationFills} missing duration(s) from exact print stamps and ${itemFills} missing item attribution(s). Fill-only — nothing overwritten.`,
            createdBy: "rip-import-review",
          },
        }),
      ),
    ]);
    return { ok: true, message: `Backfill applied: ${durationFills} duration fill(s), ${itemFills} item attribution fill(s) across ${affectedJobs.length} job(s). Re-run writeback on affected jobs to update machine-time cost.` };
  }

  return { ok: false, message: "Unknown review action." };
}

const card: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white", marginTop: 16 };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, marginRight: 8 };
const label: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: 12, marginBottom: 4 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid #aaa", width: "100%" };
const btn: React.CSSProperties = { background: "#111827", color: "white", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" };

const STATUS_STYLE: Record<ReviewStatus, React.CSSProperties> = {
  unmatched: { ...chip, background: "#fef3c7", color: "#92400e" },
  ambiguous: { ...chip, background: "#fee2e2", color: "#991b1b" },
  attached: { ...chip, background: "#dcfce7", color: "#166534" },
};

export default function RipImportReview() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const pageLink = (page: number) => {
    const params = new URLSearchParams({
      status: data.filters.status, source: data.filters.source, days: data.filters.days,
      q: data.filters.q, page: String(page),
    });
    if (data.filters.warningsOnly) params.set("warnings", "1");
    return `/app/erp/rip-import-review?${params.toString()}`;
  };

  return (
    <main style={{ maxWidth: 1200, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#4c1d95)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>RIP Import Review</h1>
        <p style={{ margin: "8px 0 0" }}>
          Patch 13A.6C — review unmatched and ambiguous print-log rows (RasterLink + VersaWorks) and attach them to the
          correct production job with confirmation and a full audit trail. Nothing here auto-matches.
        </p>
        <p style={{ margin: "8px 0 0", fontSize: 13 }}>
          <Link to="/app/erp/actual-costs" style={{ color: "#c4b5fd" }}>Actual Costs</Link>{" · "}
          <Link to="/app/erp/print-logs" style={{ color: "#c4b5fd" }}>Print Logs</Link>{" · "}
          <Link to="/app/erp/rip-imports" style={{ color: "#c4b5fd" }}>RIP Imports</Link>{" · "}
          <Link to="/app/erp/print-log-settings" style={{ color: "#c4b5fd" }}>Auto Import Settings</Link>
        </p>
      </section>

      {actionData ? (
        <div style={{ marginTop: 16, border: actionData.ok ? "1px solid #bbf7d0" : "1px solid #fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2", padding: 12, borderRadius: 10, fontWeight: 600 }}>
          {actionData.message}
        </div>
      ) : null}

      <section style={card}>
        <span style={STATUS_STYLE.unmatched}>Unmatched: {data.counts.unmatched}</span>
        <span style={STATUS_STYLE.ambiguous}>Ambiguous: {data.counts.ambiguous}</span>
        <span style={STATUS_STYLE.attached}>Attached: {data.counts.attached}</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          within the {data.counts.fetched} most recent rows for this filter window{data.counts.bounded ? ` (bounded at ${FETCH_BOUND} — narrow the date range to see older rows)` : ""}.
        </span>
        <Form method="get" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
          <div style={{ minWidth: 210 }}>
            <label style={label}>Status</label>
            <select name="status" defaultValue={data.filters.status} style={input}>
              {STATUS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 150 }}>
            <label style={label}>Source</label>
            <select name="source" defaultValue={data.filters.source} style={input}>
              {SOURCE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 140 }}>
            <label style={label}>Window</label>
            <select name="days" defaultValue={data.filters.days} style={input}>
              {DAYS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 220, flex: 1 }}>
            <label style={label}>Search (file, ticket, machine, media)</label>
            <input name="q" defaultValue={data.filters.q} style={input} placeholder="GSO-123, jar, matte…" />
          </div>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            <input type="checkbox" name="warnings" value="1" defaultChecked={data.filters.warningsOnly} /> Warnings only
          </label>
          <button type="submit" style={btn} disabled={busy}>Apply filters</button>
        </Form>
      </section>

      <section style={{ ...card, borderColor: "#bfdbfe", background: "#eff6ff" }}>
        <b>VersaWorks matching note.</b>{" "}
        <span style={{ fontSize: 13 }}>
          VersaWorks uploads are hardened (Patch 13A.6D): exact-only two-stage matching with ambiguity flags, file and
          row dedupe — the same standard as RasterLink. Rows imported <i>before</i> that patch may still carry silent
          first-match attachments; spot-check older rows in the &quot;Attached&quot; view and correct them here.
        </span>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Rows ({data.total} after filters)</h2>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6b7280" }}>
          Page {data.page} of {data.pageCount}
          {data.page > 1 ? <>{" · "}<Link to={pageLink(data.page - 1)}>Previous</Link></> : null}
          {data.page < data.pageCount ? <>{" · "}<Link to={pageLink(data.page + 1)}>Next</Link></> : null}
        </p>

        {data.rows.length === 0 ? <p style={{ color: "#6b7280" }}>No rows match this filter.</p> : null}

        {data.rows.map((row) => (
          <div key={row.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 12, background: row.reviewStatus === "attached" ? "#f9fafb" : "white" }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <span style={STATUS_STYLE[row.reviewStatus as ReviewStatus]}>{REVIEW_STATUS_LABELS[row.reviewStatus as ReviewStatus]}</span>
                <b>{row.sourceJobName || "(no source job name)"}</b>
              </div>
              <label style={{ fontSize: 12, color: "#6b7280" }}>
                {row.reviewStatus !== "attached" ? <><input type="checkbox" name="entryIds" value={row.id} form="bulk-attach-form" /> bulk</> : null}
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6, fontSize: 13, marginTop: 8 }}>
              <div><b>Source:</b> {row.source}</div>
              <div><b>Import file:</b> {row.importFileName || "—"}</div>
              <div><b>Ticket:</b> {row.jobTicket || "not detected"}</div>
              <div><b>Result:</b> {row.status || "—"}</div>
              <div><b>Machine:</b> {row.machineName || "—"}</div>
              <div><b>Media:</b> {row.mediaName || "—"}</div>
              <div><b>Ink:</b> {row.inkMl.toFixed(2)} ml</div>
              <div><b>Print time:</b> {row.printMinutes.toFixed(1)} min</div>
              <div><b>Started:</b> {row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</div>
              <div><b>Completed:</b> {row.completedAt ? new Date(row.completedAt).toLocaleString() : "—"}</div>
              <div><b>Imported:</b> {new Date(row.importedAt).toLocaleString()}</div>
            </div>
            {row.timing.length ? (
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
                {row.timing.map((item) => <span key={item.label} style={{ marginRight: 12 }}><b>{item.label}:</b> {item.value}</span>)}
              </div>
            ) : null}
            {row.warnings.length ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
                {row.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}

            {row.reviewStatus === "attached" && row.attachedJob ? (
              <div style={{ marginTop: 10, borderTop: "1px dashed #e5e7eb", paddingTop: 10 }}>
                <div style={{ fontSize: 13 }}>
                  <b>Attached to:</b> {jobLabel(row.attachedJob)}
                </div>
                <Form method="post" style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="hidden" name="intent" value="unmatch" />
                  <input type="hidden" name="entryId" value={row.id} />
                  <input type="hidden" name="expectedJobId" value={row.productionJobId || ""} />
                  <label style={{ fontSize: 13 }}>
                    <input type="checkbox" name="confirm" value="yes" /> I confirm detaching this row (audit is preserved)
                  </label>
                  <button type="submit" style={{ ...btn, background: "#b91c1c" }} disabled={busy}>Detach from job</button>
                </Form>
              </div>
            ) : null}

            {row.reviewStatus !== "attached" ? (
              <div style={{ marginTop: 10, borderTop: "1px dashed #e5e7eb", paddingTop: 10 }}>
                {row.candidates.length ? (
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    <b>Suggestions (never auto-saved):</b>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {row.candidates.map((candidate) => (
                        <li key={candidate.job.id}>
                          {jobLabel(candidate.job)} — <i>{CONFIDENCE_LABELS[candidate.confidence]}</i>. {candidate.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, marginBottom: 8, color: "#6b7280" }}>No candidate suggestions — pick from recent jobs below.</div>
                )}
                <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
                  <input type="hidden" name="intent" value="rematch" />
                  <input type="hidden" name="entryId" value={row.id} />
                  <input type="hidden" name="expectedJobId" value="" />
                  <div style={{ minWidth: 340, flex: 1 }}>
                    <label style={label}>Attach to production job (ticket | customer | status | created)</label>
                    <select name="jobId" defaultValue="" style={input}>
                      <option value="">Choose production job…</option>
                      {row.candidates.map((candidate) => (
                        <option key={candidate.job.id} value={candidate.job.id}>★ {jobLabel(candidate.job)}</option>
                      ))}
                      {data.recentJobs
                        .filter((job) => !row.candidates.some((candidate) => candidate.job.id === job.id))
                        .map((job) => <option key={job.id} value={job.id}>{jobLabel(job)}</option>)}
                    </select>
                  </div>
                  <label style={{ fontSize: 13 }}>
                    <input type="checkbox" name="confirm" value="yes" /> I confirm this is the correct job
                  </label>
                  <button type="submit" style={btn} disabled={busy}>Attach</button>
                </Form>
              </div>
            ) : null}
          </div>
        ))}
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Bulk attach</h2>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>
          No blind bulk matching: the server only accepts a bulk attach when every checked row is unresolved and all of
          them share one exact source job name or one exact ticket. Anything else rejects the whole batch — no partial writes.
        </p>
        <Form id="bulk-attach-form" method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <input type="hidden" name="intent" value="bulkRematch" />
          <div style={{ minWidth: 340, flex: 1 }}>
            <label style={label}>Attach all checked rows to</label>
            <select name="jobId" defaultValue="" style={input}>
              <option value="">Choose production job…</option>
              {data.recentJobs.map((job) => <option key={job.id} value={job.id}>{jobLabel(job)}</option>)}
            </select>
          </div>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="confirm" value="yes" /> I confirm one job for all checked rows
          </label>
          <button type="submit" style={btn} disabled={busy}>Bulk attach checked rows</button>
        </Form>
      </section>

      <section style={{ ...card, borderColor: "#7c2d12", borderWidth: 2 }}>
        <h2 style={{ margin: "0 0 4px" }}>Roland duration &amp; item attribution audit (13A.7C)</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Read-only audit of the {data.backfillAudit.counts.attachedRows} most recent attached rows. Duration precedence:
          exact print start/end stamps from the row&apos;s own source data (derived, plausibility-checked) &gt; imported
          native minutes &gt; unknown (stays 0 — never guessed from RIP time, queue time, sqft, or ink). Item attribution:
          exact item ticket &gt; exact RIP name &gt; job-file on single-item job &gt; single-item fallback (recorded) &gt;
          job-level only. The backfill below is FILL-ONLY and owner-gated.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 10, fontSize: 13 }}>
          {[
            ["Roland rows", data.backfillAudit.counts.rolandRows],
            ["Native duration", data.backfillAudit.counts.nativeDuration],
            ["Derived duration", data.backfillAudit.counts.derivedDuration],
            ["Unknown duration", data.backfillAudit.counts.unknownDuration],
            ["Exact item attribution", data.backfillAudit.counts.exactItem],
            ["Single-item fallback", data.backfillAudit.counts.singleItemFallback],
            ["Job-level only", data.backfillAudit.counts.jobLevelOnly],
            ["Unresolved", data.backfillAudit.counts.unresolved],
            ["Duration fills available", data.backfillAudit.counts.durationEligible],
            ["Item fills available", data.backfillAudit.counts.itemEligible],
          ].map(([label, value]) => (
            <div key={String(label)} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
              <div style={{ color: "#6b7280", fontSize: 11 }}>{label}</div>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{String(value)}</div>
            </div>
          ))}
        </div>
        {data.backfillAudit.eligibleCount > 0 ? (
          <Form method="post" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12, border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: 10 }}>
            <input type="hidden" name="intent" value="applyRipBackfill" />
            <span style={{ fontSize: 13 }}>
              <b>{data.backfillAudit.eligibleCount} row(s)</b> have deterministic fills (missing duration from exact print
              stamps, or missing item attribution). Fill-only — nonzero durations and existing item links are never touched.
              After applying, re-run the writeback on affected jobs to update machine-time cost.
            </span>
            <input name="confirmPhrase" placeholder="Type APPLY VERIFIED RIP BACKFILL" autoComplete="off" style={{ ...input, minWidth: 280, width: "auto" }} />
            <button type="submit" style={btn} disabled={busy}>Apply verified RIP backfill</button>
          </Form>
        ) : (
          <p style={{ fontSize: 13, color: "#166534", marginBottom: 12 }}>No deterministic backfill needed — every attached row already has its best-available duration and attribution.</p>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                <th align="left" style={{ padding: 6 }}>Source row</th><th align="left">Ticket</th><th align="left">Printer</th>
                <th align="left">Raw print stamps</th><th align="left">Minutes (source)</th><th align="left">Item attribution</th>
                <th align="left">Fills</th><th align="left">Job</th><th align="left">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {data.backfillAudit.auditRows.map((row: any) => (
                <tr key={row.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 6 }}>{row.sourceJobName || "—"}{row.isCut ? " (cut)" : ""}</td>
                  <td>{row.jobTicket || "—"}</td>
                  <td>{row.printer} <span style={{ color: "#6b7280" }}>({row.brand})</span></td>
                  <td>{row.printStartRaw ? `${row.printStartRaw} → ${row.printEndRaw || "?"}` : "—"}</td>
                  <td><b>{Number(row.selectedMinutes).toFixed(1)}</b> ({String(row.durationSource).replace(/_/g, " ")}){row.storedMinutes !== row.selectedMinutes ? ` · stored ${Number(row.storedMinutes).toFixed(1)}` : ""}</td>
                  <td>{String(row.itemAttribution).replace(/_/g, " ")} ({row.itemConfidence})</td>
                  <td>{(row.fills || []).join(", ") || "—"}</td>
                  <td><Link to={`/app/erp/production/${row.jobId}/print`}>{row.jobTicketOfJob || "job"}</Link></td>
                  <td>{(row.warnings || []).length ? (row.warnings as string[]).map((warning) => <div key={warning} style={{ color: "#92400e", fontSize: 11 }}>{warning}</div>) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 8px" }}>Recent imports</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                <th align="left" style={{ padding: 6 }}>Imported</th><th align="left">Source</th><th align="left">File</th>
                <th>Rows</th><th>Matched</th><th>Unmatched</th><th align="left">Details</th><th align="left">Hash</th><th align="left">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.imports.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 6 }}>{new Date(item.createdAt).toLocaleString()}</td>
                  <td>{item.source}</td>
                  <td>{item.fileName}</td>
                  <td align="center">{item.rowCount}</td>
                  <td align="center">{item.matchedCount}</td>
                  <td align="center">{item.unmatchedCount}</td>
                  <td>{item.summary.counters.map((counter) => `${counter.label}: ${counter.value}`).join(", ") || "—"}</td>
                  <td><code>{item.summary.fileHashShort || "—"}</code></td>
                  <td>{item.summary.outcome || item.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
