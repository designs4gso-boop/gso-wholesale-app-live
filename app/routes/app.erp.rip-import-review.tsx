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

  return {
    shop,
    filters,
    counts,
    rows,
    page,
    pageCount,
    total,
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
