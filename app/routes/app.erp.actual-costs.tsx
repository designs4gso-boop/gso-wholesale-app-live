import type React from "react";
import { Form, Link, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { materialKind } from "../lib/material-classify";
import {
  MATCH_STATUS_LABELS,
  type MatchStatus,
} from "../lib/rip-actual-costs-shared";
import {
  buildBrandRates,
  computeEntryCosts,
  machineCost,
  machineRatePerHour,
  matchMediaToMaterial,
  matchStatusOf,
  parseGsoqRow,
  rollupByTicket,
} from "../lib/rip-actual-costs.server";
import {
  computeJobVariance,
  filterVarianceRows,
  type VarianceReportRow,
} from "../lib/actual-variance.server";

// Actual Cost Dashboard (13A.5): READ-ONLY. Turns imported RIP/print-log rows
// into actual dollars using the verified DB channel costs. No action export,
// no writes, no Shopify, no calculator/engine/production changes.

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [entries, machines, materials] = await Promise.all([
    db.printLogEntry.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true, jobTicket: true, sourceJobName: true, printerSoftware: true, machineName: true,
        mediaName: true, sqft: true, inkMl: true, cmykInkMl: true, whiteInkMl: true, glossInkMl: true,
        printMinutes: true, startedAt: true, completedAt: true, createdAt: true,
        productionJobId: true, productionJobItemId: true, rawRow: true, status: true,
      },
    }),
    db.machine.findMany({
      where: { shop, active: true },
      select: { name: true, inkChannels: { select: { inkType: true, inkName: true, enabled: true, costPerMl: true, cartridgeCost: true, cartridgeMl: true } } },
      take: 50,
    }),
    db.material.findMany({
      where: { shop, active: true },
      select: { id: true, name: true, materialType: true, unit: true, baseUnit: true, calculatedUnitCost: true, costPerUnit: true, purchaseCost: true },
      take: 300,
    }),
  ]);

  const rates = buildBrandRates(machines);
  const ratePerHour = machineRatePerHour(); // the ONE configured rate ($8/hr) - same source as board + writeback
  const printMaterials = materials.filter((material) => materialKind(material) === "print");

  const gsoqEntries = entries.filter((entry) => /^GSOQ-/i.test(String(entry.jobTicket || "")));
  const productionEntries = entries.filter((entry) => !/^GSOQ-/i.test(String(entry.jobTicket || "")));

  const rows = productionEntries.map((entry) => {
    const costs = computeEntryCosts(entry, rates);
    const media = matchMediaToMaterial(entry.mediaName, printMaterials);
    const status = matchStatusOf(entry);
    const warnings = [...costs.warnings];
    if (media.warning) warnings.push(media.warning);
    if (status === "potentially_matchable") warnings.push("GSO ticket present but no production job link — attach it in RIP Import Review.");
    if (status === "missing_ticket") warnings.push("No GSO ticket detected — file may have bypassed the intake watcher.");
    const sqft = Number(entry.sqft) || 0;
    return {
      id: entry.id,
      when: (entry.completedAt || entry.startedAt || entry.createdAt).toISOString(),
      machine: entry.machineName || costs.brand || "unknown",
      brand: costs.brand,
      jobName: entry.sourceJobName || "",
      jobTicket: entry.jobTicket || "",
      mediaName: entry.mediaName || "",
      mediaMaterialName: media.material?.name || null,
      mediaCostPerSqft: media.costPerSqft,
      possibleMediaCost: media.costPerSqft != null && sqft > 0 ? media.costPerSqft * sqft : null,
      sqft,
      printMinutes: Number(entry.printMinutes) || 0,
      cmykMl: Number(entry.cmykInkMl) || 0,
      whiteMl: Number(entry.whiteInkMl) || 0,
      glossMl: Number(entry.glossInkMl) || 0,
      totalMl: Number(entry.inkMl) || 0,
      inkCost: costs.inkCost,
      machineCostCurrent: machineCost(Number(entry.printMinutes) || 0, ratePerHour),
      productionJobId: entry.productionJobId || null,
      status,
      warnings,
    };
  });

  const matchedJobIds = [...new Set(rows.map((row) => row.productionJobId).filter(Boolean))] as string[];
  const jobs = matchedJobIds.length
    ? await db.productionJob.findMany({
        where: { id: { in: matchedJobIds }, shop },
        select: { id: true, jobTicket: true, quoteId: true, customerName: true, company: true, status: true },
      })
    : [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  const rollups = rollupByTicket(
    rows.filter((row) => row.status === "matched" || row.status === "potentially_matchable").map((row) => ({
      jobTicket: row.jobTicket,
      productionJobId: row.productionJobId,
      machineBrand: row.brand,
      machineName: row.machine,
      mediaName: row.mediaName,
      inkMl: row.totalMl,
      inkCost: row.inkCost,
      printMinutes: row.printMinutes,
    })),
  ).map((rollup) => ({
    ...rollup,
    machineCostCurrent: machineCost(rollup.totalPrintMinutes, ratePerHour),
    job: rollup.productionJobId ? jobById.get(rollup.productionJobId) || null : null,
  }));

  const dates = rows.map((row) => row.when).sort();
  const summary = {
    totalRows: productionEntries.length,
    matchedRows: rows.filter((row) => row.status === "matched").length,
    unmatchedRows: rows.filter((row) => row.status !== "matched").length,
    totalInkMl: rows.reduce((sum, row) => sum + row.totalMl, 0),
    totalInkCost: rows.reduce((sum, row) => sum + (row.inkCost ?? 0), 0),
    inkCostComplete: rows.every((row) => row.inkCost != null),
    totalPrintMinutes: rows.reduce((sum, row) => sum + row.printMinutes, 0),
    machineCostCurrent: rows.reduce((sum, row) => sum + row.machineCostCurrent, 0),
    machineRatePerHour: ratePerHour,
    dateRange: dates.length ? `${dates[0].slice(0, 10)} -> ${dates[dates.length - 1].slice(0, 10)}` : "no rows",
    gsoqCount: gsoqEntries.length,
    ratesFound: rates.map((rate) => `${rate.machineName}: CMYK ${rate.cmykPerMl == null ? "—" : `$${rate.cmykPerMl.toFixed(4)}/ml`}, white ${rate.whitePerMl == null ? "—" : `$${rate.whitePerMl.toFixed(4)}/ml`}, gloss ${rate.glossPerMl == null ? "—" : `$${rate.glossPerMl.toFixed(4)}/ml`}`),
  };

  const gsoqRows = gsoqEntries.slice(0, 50).map((entry) => parseGsoqRow(entry));

  // ----- 13A.7A: estimated-vs-actual variance (READ-ONLY preview) -----
  const url = new URL(request.url);
  const varianceFilters = {
    match: url.searchParams.get("vmatch") || "all",
    printer: url.searchParams.get("vprinter") || "all",
    severity: url.searchParams.get("vseverity") || "all",
  };
  let varianceRows: VarianceReportRow[] = [];
  let varianceTotal = 0;
  let varianceError: string | null = null;
  try {
    const varianceJobs = matchedJobIds.length
      ? await db.productionJob.findMany({
          where: { id: { in: matchedJobIds }, shop },
          take: 100,
          select: {
            id: true, jobTicket: true, customerName: true, company: true, status: true,
            actualTotalCost: true, actualFinalProfit: true, actualFinalMargin: true, actualCostFinalized: true,
            items: { select: { id: true, itemTicket: true, productTitle: true, quantity: true, unitPrice: true, unitCost: true, costSnapshot: true } },
          },
        })
      : [];
    const entriesByJob = new Map<string, typeof productionEntries>();
    for (const entry of productionEntries) {
      if (!entry.productionJobId) continue;
      const list = entriesByJob.get(entry.productionJobId) || [];
      list.push(entry);
      entriesByJob.set(entry.productionJobId, list);
    }
    const allVarianceRows = varianceJobs
      .map((job) => computeJobVariance({ job, entries: entriesByJob.get(job.id) || [], rates, printMaterials, machineRatePerHour: ratePerHour }))
      .sort((a, b) => Math.abs(b.variancePct ?? 0) - Math.abs(a.variancePct ?? 0));
    varianceTotal = allVarianceRows.length;
    varianceRows = filterVarianceRows(allVarianceRows, varianceFilters);
  } catch (error) {
    varianceError = `Variance report failed to compute: ${error instanceof Error ? error.message : String(error)}`;
  }
  const varianceSummary = {
    jobsAnalyzed: varianceTotal,
    shown: varianceRows.length,
    highSeverity: varianceRows.filter((row) => row.severity === "high").length,
    withReprints: varianceRows.filter((row) => row.reprintDetected).length,
    estimatedTotal: varianceRows.reduce((sum, row) => sum + row.estimatedCost, 0),
    previewTotal: varianceRows.reduce((sum, row) => sum + (row.previewTotal ?? 0), 0),
  };

  return { summary, rows: rows.slice(0, 200), rowTotal: rows.length, rollups, gsoqRows, varianceRows, varianceSummary, varianceFilters, varianceError };
}

const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "white" };
const thStyle: React.CSSProperties = { background: "#f3f4f6", textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12 };
const tdStyle: React.CSSProperties = { padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12, verticalAlign: "top" };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };
const warnStyle: React.CSSProperties = { color: "#92400e", fontSize: 11 };

const statusBadge: Record<MatchStatus, React.CSSProperties> = {
  matched: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  potentially_matchable: { background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  quote_rip: { background: "#e0e7ff", color: "#3730a3", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  missing_ticket: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
};

const money = (value: number | null, digits = 2) => (value == null ? "—" : `$${value.toFixed(digits)}`);

export default function ActualCostsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1360, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p>
        <Link to="/app/erp/rip-imports">← RIP Imports</Link> · <Link to="/app/erp/print-logs">Print Logs</Link> · <Link to="/app/erp/cost-verification">Cost Verification</Link> · <Link to="/app/erp/production">Production</Link>
      </p>
      <section style={{ background: "linear-gradient(135deg,#111827,#7c2d12)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>Actual Cost Dashboard</h1>
        <p style={{ marginBottom: 0 }}>v1 (13A.5): actual ink/machine dollars computed from imported RIP/print-log rows using the verified database channel costs.</p>
        <p style={{ margin: "8px 0 0", fontSize: 13 }}>
          Unmatched or ambiguous rows? <Link to="/app/erp/rip-import-review" style={{ color: "#c4b5fd" }}>Open RIP Import Review</Link> to attach them safely.
        </p>
      </section>

      <section style={{ marginTop: 16, border: "2px solid #16a34a", background: "#f0fdf4", color: "#166534", borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700 }}>
        This dashboard is read-only. It calculates actual print cost from imported RIP/print log rows. It does not change quotes, calculator
        assumptions, production jobs, or pricing.
      </section>

      <section style={{ marginTop: 12, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e3a8a", borderRadius: 12, padding: "10px 14px", fontSize: 13 }}>
        <b>Machine routing rule:</b> ROLAND tag or white/gloss → Roland LG-640; all other CMYK-only → Mimaki (Mimaki is CMYK-only).
        Rows below warn when white/gloss ink shows up on the Mimaki. Machine time is costed at the current configured rate of
        ${data.summary.machineRatePerHour}/hr (same shared source as the Production Board and print-log writeback). Ink uses the verified
        shared channel costs: {data.summary.ratesFound.join(" · ") || "none found — ink costs cannot be calculated"}.
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginTop: 16 }}>
        {[
          { label: "Print log rows (production)", value: String(data.summary.totalRows) },
          { label: "Matched / unmatched", value: `${data.summary.matchedRows} / ${data.summary.unmatchedRows}` },
          { label: "Date range", value: data.summary.dateRange },
          { label: "Total ink ml", value: data.summary.totalInkMl.toFixed(1) },
          { label: `Calculated ink cost${data.summary.inkCostComplete ? "" : " (partial)"}`, value: money(data.summary.totalInkCost) },
          { label: "Total print minutes", value: data.summary.totalPrintMinutes.toFixed(1) },
          { label: `Machine cost @ $${data.summary.machineRatePerHour}/hr (current rate)`, value: money(data.summary.machineCostCurrent) },
          { label: "Quote-time GSOQ results", value: String(data.summary.gsoqCount) },
        ].map((card) => (
          <div key={card.label} style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{card.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{card.value}</div>
          </div>
        ))}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Per-ticket rollup (matched + potentially matchable)</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Ticket</th><th style={thStyle}>Job / customer</th><th style={thStyle}>Rows</th><th style={thStyle}>Ink ml</th><th style={thStyle}>Ink cost</th><th style={thStyle}>Print min</th><th style={thStyle}>Machine @ ${data.summary.machineRatePerHour}/hr</th><th style={thStyle}>Machines / media</th><th style={thStyle}>Warnings</th></tr></thead>
            <tbody>
              {data.rollups.map((rollup) => (
                <tr key={rollup.jobTicket}>
                  <td style={tdStyle}><b>{rollup.jobTicket}</b></td>
                  <td style={tdStyle}>
                    {rollup.job ? (
                      <>
                        {rollup.job.customerName || rollup.job.company || "—"} <span style={smallHelp}>({rollup.job.status}{rollup.job.quoteId ? `, quote ${rollup.job.quoteId.slice(0, 8)}…` : ""})</span>
                        <div><Link to="/app/erp/production">Open Production</Link></div>
                      </>
                    ) : "no job link yet"}
                  </td>
                  <td style={tdStyle}>{rollup.rowCount}</td>
                  <td style={tdStyle}>{rollup.totalInkMl.toFixed(1)}</td>
                  <td style={tdStyle}><b>{money(rollup.totalInkCost)}</b>{rollup.inkCostComplete ? "" : <span style={warnStyle}> partial</span>}</td>
                  <td style={tdStyle}>{rollup.totalPrintMinutes.toFixed(1)}</td>
                  <td style={tdStyle}>{money(rollup.machineCostCurrent)}</td>
                  <td style={tdStyle}>{rollup.machines.join(", ")}<div style={smallHelp}>{rollup.medias.join(", ") || "—"}</div></td>
                  <td style={tdStyle}>{rollup.warnings.length ? rollup.warnings.map((warning) => <div key={warning} style={warnStyle}>{warning}</div>) : "—"}</td>
                </tr>
              ))}
              {!data.rollups.length ? <tr><td colSpan={9} style={{ ...tdStyle, color: "#6b7280" }}>No ticketed production print-log rows yet — upload RIP logs via RIP Imports.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <VarianceSection data={data} />

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Print log rows ({data.rowTotal}{data.rowTotal > data.rows.length ? `, showing latest ${data.rows.length}` : ""})</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Date</th><th style={thStyle}>Machine</th><th style={thStyle}>RIP job / ticket</th><th style={thStyle}>Media</th><th style={thStyle}>Sqft</th><th style={thStyle}>Min</th><th style={thStyle}>CMYK ml</th><th style={thStyle}>White ml</th><th style={thStyle}>Gloss ml</th><th style={thStyle}>Total ml</th><th style={thStyle}>Ink cost</th><th style={thStyle}>Machine @ ${data.summary.machineRatePerHour}/hr</th><th style={thStyle}>Match</th><th style={thStyle}>Warnings</th></tr></thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <td style={tdStyle}>{row.when.slice(0, 16).replace("T", " ")}</td>
                  <td style={tdStyle}>{row.machine}</td>
                  <td style={tdStyle}>{row.jobName || "—"}<div style={smallHelp}>{row.jobTicket || "no ticket"}</div></td>
                  <td style={tdStyle}>{row.mediaName || "—"}{row.mediaMaterialName ? <div style={smallHelp}>= {row.mediaMaterialName} ({money(row.mediaCostPerSqft, 4)}/sqft{row.possibleMediaCost != null ? `, ≈${money(row.possibleMediaCost)} media` : ""})</div> : null}</td>
                  <td style={tdStyle}>{row.sqft ? row.sqft.toFixed(2) : "—"}</td>
                  <td style={tdStyle}>{row.printMinutes ? row.printMinutes.toFixed(1) : "—"}</td>
                  <td style={tdStyle}>{row.cmykMl.toFixed(1)}</td>
                  <td style={tdStyle}>{row.whiteMl.toFixed(1)}</td>
                  <td style={tdStyle}>{row.glossMl.toFixed(1)}</td>
                  <td style={tdStyle}>{row.totalMl.toFixed(1)}</td>
                  <td style={tdStyle}><b>{money(row.inkCost)}</b></td>
                  <td style={tdStyle}>{money(row.machineCostCurrent)}</td>
                  <td style={tdStyle}><span style={statusBadge[row.status]}>{MATCH_STATUS_LABELS[row.status]}</span></td>
                  <td style={tdStyle}>{row.warnings.length ? row.warnings.map((warning) => <div key={warning} style={warnStyle}>{warning}</div>) : "—"}</td>
                </tr>
              ))}
              {!data.rows.length ? <tr><td colSpan={15} style={{ ...tdStyle, color: "#6b7280" }}>No production print-log rows yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Quote-time GSOQ RIP results (separate from production actuals)</h2>
        <p style={{ fontSize: 13, color: "#4b5563" }}>
          These are quote-time RIP results synced from the NAS for pricing in the Cost Calculator's Actual mode — they are not production print
          runs. Their ink dollars come from the NAS script's own constant (script recovery is on the 13A.4 collection list); the production rows
          above use the verified database channel costs.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Quote / ticket</th><th style={thStyle}>File</th><th style={thStyle}>Date</th><th style={thStyle}>Total cc</th><th style={thStyle}>RIP sec</th><th style={thStyle}>NAS ink $</th><th style={thStyle}>Match</th></tr></thead>
            <tbody>
              {data.gsoqRows.map((row, idx) => (
                <tr key={`${row.quoteId}-${idx}`}>
                  <td style={tdStyle}><b>{row.quoteId}</b></td>
                  <td style={tdStyle}>{row.fileName || "—"}</td>
                  <td style={tdStyle}>{String(row.date).slice(0, 10)}</td>
                  <td style={tdStyle}>{row.totalCc.toFixed(2)}</td>
                  <td style={tdStyle}>{row.ripSeconds}</td>
                  <td style={tdStyle}>{money(row.nasInkCost)}</td>
                  <td style={tdStyle}><span style={statusBadge.quote_rip}>usable in Cost Calculator Actual mode</span></td>
                </tr>
              ))}
              {!data.gsoqRows.length ? <tr><td colSpan={7} style={{ ...tdStyle, color: "#6b7280" }}>No GSOQ quote-time results synced yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

// ----- 13A.7A: estimated-vs-actual variance section (READ-ONLY preview) -----

function VarianceSection({ data }: { data: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const pct = (value: number | null) => (value == null ? "n/a" : `${value.toFixed(1)}%`);
  const componentBadge = (label: string, status: "calculated" | "partial" | "not_configured") => (
    <span key={label} style={{
      display: "inline-block", marginRight: 6, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: status === "calculated" ? "#dcfce7" : status === "partial" ? "#fef3c7" : "#f3f4f6",
      color: status === "calculated" ? "#166534" : status === "partial" ? "#92400e" : "#6b7280",
    }}>{label}: {status === "not_configured" ? "Not configured" : status}</span>
  );
  const severityBadge: Record<string, React.CSSProperties> = {
    high: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700 },
    medium: { background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700 },
    low: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700 },
    unknown: { background: "#f3f4f6", color: "#6b7280", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700 },
  };

  return (
    <section style={{ ...cardStyle, marginTop: 16, borderColor: "#7c2d12", borderWidth: 2 }}>
      <h2 style={{ marginTop: 0 }}>Estimated vs Actual variance (13A.7A — read-only preview)</h2>
      <p style={{ ...smallHelp, marginTop: 0 }}>
        PARTIAL preview by design: the total covers ink (verified shared channel costs) + machine time at the current
        configured rate — the SAME math and total as the Production Board writeback. Media/material is shown as a
        separate preview-only reference (name-matched, not write-grade, excluded from the total). Labor, packing,
        shipping, and outsourcing are excluded, so this is never a final cost. Duplicate historical rows are ignored in
        the math but counted; cut rows are listed, never costed; reprint runs stay visible. Nothing on this page writes anything.
      </p>

      {data.varianceError ? (
        <div style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 10, padding: 12, fontSize: 13 }}>
          {data.varianceError}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
        {[
          { label: "Jobs with matched print data", value: String(data.varianceSummary.jobsAnalyzed) },
          { label: "High variance (>25%)", value: String(data.varianceSummary.highSeverity) },
          { label: "Jobs with reprint runs", value: String(data.varianceSummary.withReprints) },
          { label: "Estimated vs partial print cost (shown jobs)", value: `${money(data.varianceSummary.estimatedTotal)} vs ${money(data.varianceSummary.previewTotal)}` },
        ].map((card) => (
          <div key={card.label} style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{card.label}</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{card.value}</div>
          </div>
        ))}
      </div>

      <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ fontSize: 12 }}>Match<br />
          <select name="vmatch" defaultValue={data.varianceFilters.match} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
            <option value="all">All matched jobs</option>
            <option value="item">Item-ticket matched</option>
            <option value="job">Job-ticket matched</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Printer<br />
          <select name="vprinter" defaultValue={data.varianceFilters.printer} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
            <option value="all">All printers</option>
            <option value="mimaki">Mimaki / RasterLink</option>
            <option value="roland">Roland / VersaWorks</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Variance severity<br />
          <select name="vseverity" defaultValue={data.varianceFilters.severity} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
            <option value="all">All severities</option>
            <option value="high">High (&gt;25%)</option>
            <option value="medium">Medium (10-25%)</option>
            <option value="low">Low (&le;10%)</option>
          </select>
        </label>
        <button type="submit" disabled={busy} style={{ background: "#111827", color: "white", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700 }}>
          {busy ? "Loading..." : "Apply"}
        </button>
        <span style={smallHelp}>Showing {data.varianceSummary.shown} of {data.varianceSummary.jobsAnalyzed} jobs.</span>
      </Form>

      {!data.varianceRows.length && !data.varianceError ? (
        <p style={{ color: "#6b7280", fontSize: 13 }}>
          {data.varianceSummary.jobsAnalyzed === 0
            ? "No production jobs have matched print-log rows yet — attach rows in RIP Import Review and they will appear here."
            : "No jobs match these filters."}
        </p>
      ) : null}

      {data.varianceRows.map((row) => (
        <div key={row.jobId} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <b>{row.jobTicket || row.jobId}</b> — {row.customer || "no customer"} <span style={smallHelp}>({row.jobStatus}, {row.itemCount} item{row.itemCount === 1 ? "" : "s"})</span>
              <div style={smallHelp}>
                <Link to={`/app/erp/production/${row.jobId}/print`}>Open production job</Link>
                {" · "}match: {row.matchMethods.join(", ")} · printers: {row.printers.join(", ") || "n/a"}
              </div>
            </div>
            <div>
              <span style={severityBadge[row.severity]}>variance {row.severity}</span>{" "}
              <span style={{ ...smallHelp, fontWeight: 700 }}>{row.complete ? "complete" : "PARTIAL preview"}</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 8, fontSize: 12 }}>
            <div>
              <b>Estimated</b>
              <div>Revenue: {money(row.revenue)}</div>
              <div>Cost: {money(row.estimatedCost)}{row.estimatedUnitCost != null ? ` (${money(row.estimatedUnitCost)}/unit)` : ""}</div>
              <div>Profit: {money(row.estimatedProfit)} · Margin: {pct(row.estimatedMarginPct)}</div>
            </div>
            <div>
              <b>Observed print data</b>
              <div>{row.printRowCount} print row(s){row.cutRowCount ? ` + ${row.cutRowCount} cut` : ""}{row.duplicateRowsIgnored ? ` (${row.duplicateRowsIgnored} dup ignored)` : ""}</div>
              <div>Ink: {row.inkMl.toFixed(2)} ml (C {row.cmykInkMl.toFixed(1)} / W {row.whiteInkMl.toFixed(1)} / G {row.glossInkMl.toFixed(1)})</div>
              <div>Sqft: {row.sqft.toFixed(2)} · Minutes: {row.printMinutes.toFixed(1)}</div>
              <div>Runs: {row.runCount == null ? "unknown" : row.runCount}{row.reprintDetected ? " (reprint!)" : ""}</div>
            </div>
            <div>
              <b>Actual preview (partial)</b>
              <div>Ink: {money(row.inkCost)} · Machine: {row.machineCost == null ? "Not configured" : `${money(row.machineCost)} @ $${row.machineRatePerHour}/hr`}</div>
              <div>Partial print total: <b>{row.previewTotal == null ? "Not configured" : money(row.previewTotal)}</b> (matches the Production Board)</div>
              <div>Media (preview-only, excluded): {money(row.materialCost)}</div>
              <div>Profit: {row.previewProfit == null ? "n/a" : money(row.previewProfit)} · Margin: {pct(row.previewMarginPct)}</div>
            </div>
            <div>
              <b>Variance vs estimate</b>
              <div>Dollars: {row.variance == null ? "n/a" : money(row.variance)}</div>
              <div>Percent: {pct(row.variancePct)}</div>
              {row.finalized ? <div style={{ marginTop: 4 }}><b>Manually recorded final:</b> {money(row.finalized.totalCost)} cost · {money(row.finalized.profit)} profit · {pct(row.finalized.marginPct)}</div> : null}
            </div>
          </div>
          <div style={{ marginTop: 6 }}>
            {componentBadge("ink", row.components.ink)}
            {componentBadge("machine time", row.components.machineTime)}
            {componentBadge("material", row.components.material)}
            <span style={smallHelp}>excluded: {row.excludedComponents.join(", ")}</span>
          </div>
          {row.warnings.length ? (
            <details style={{ marginTop: 6 }}>
              <summary style={{ ...warnStyle, cursor: "pointer" }}>{row.warnings.length} warning(s) / data-quality note(s)</summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {row.warnings.map((warning) => <li key={warning} style={warnStyle}>{warning}</li>)}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </section>
  );
}
