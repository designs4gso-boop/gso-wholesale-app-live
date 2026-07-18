import type React from "react";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { materialKind } from "../lib/material-classify";
import {
  MACHINE_RATE_HIGH,
  MACHINE_RATE_LOW,
  MATCH_STATUS_LABELS,
  type MatchStatus,
} from "../lib/rip-actual-costs-shared";
import {
  buildBrandRates,
  computeEntryCosts,
  matchMediaToMaterial,
  matchStatusOf,
  parseGsoqRow,
  rollupByTicket,
} from "../lib/rip-actual-costs.server";

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
        productionJobId: true, rawRow: true, status: true,
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
  const printMaterials = materials.filter((material) => materialKind(material) === "print");

  const gsoqEntries = entries.filter((entry) => /^GSOQ-/i.test(String(entry.jobTicket || "")));
  const productionEntries = entries.filter((entry) => !/^GSOQ-/i.test(String(entry.jobTicket || "")));

  const rows = productionEntries.map((entry) => {
    const costs = computeEntryCosts(entry, rates);
    const media = matchMediaToMaterial(entry.mediaName, printMaterials);
    const status = matchStatusOf(entry);
    const warnings = [...costs.warnings];
    if (media.warning) warnings.push(media.warning);
    if (status === "potentially_matchable") warnings.push("GSO ticket present but no production job link — re-import or match in 13A.6.");
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
      machineCostLow: costs.machineCostLow,
      machineCostHigh: costs.machineCostHigh,
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
    machineCostLow: rows.reduce((sum, row) => sum + row.machineCostLow, 0),
    machineCostHigh: rows.reduce((sum, row) => sum + row.machineCostHigh, 0),
    dateRange: dates.length ? `${dates[0].slice(0, 10)} -> ${dates[dates.length - 1].slice(0, 10)}` : "no rows",
    gsoqCount: gsoqEntries.length,
    ratesFound: rates.map((rate) => `${rate.machineName}: CMYK ${rate.cmykPerMl == null ? "—" : `$${rate.cmykPerMl.toFixed(4)}/ml`}, white ${rate.whitePerMl == null ? "—" : `$${rate.whitePerMl.toFixed(4)}/ml`}, gloss ${rate.glossPerMl == null ? "—" : `$${rate.glossPerMl.toFixed(4)}/ml`}`),
  };

  const gsoqRows = gsoqEntries.slice(0, 50).map((entry) => parseGsoqRow(entry));

  return { summary, rows: rows.slice(0, 200), rowTotal: rows.length, rollups, gsoqRows };
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
      </section>

      <section style={{ marginTop: 16, border: "2px solid #16a34a", background: "#f0fdf4", color: "#166534", borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700 }}>
        This dashboard is read-only. It calculates actual print cost from imported RIP/print log rows. It does not change quotes, calculator
        assumptions, production jobs, or pricing.
      </section>

      <section style={{ marginTop: 12, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e3a8a", borderRadius: 12, padding: "10px 14px", fontSize: 13 }}>
        <b>Machine routing rule (documented, warn-only for now):</b> ROLAND tag → Roland LG-540; no tag → Mimaki. Mimaki is CMYK-only for
        routing/pricing; Roland handles CMYK + white + gloss. Rows below warn when white/gloss ink shows up on the Mimaki. Machine hourly cost is
        shown at BOTH ${MACHINE_RATE_LOW}/hr and ${MACHINE_RATE_HIGH}/hr until the owner picks one. Channel rates in use: {data.summary.ratesFound.join(" · ") || "none found — ink costs cannot be calculated"}.
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginTop: 16 }}>
        {[
          { label: "Print log rows (production)", value: String(data.summary.totalRows) },
          { label: "Matched / unmatched", value: `${data.summary.matchedRows} / ${data.summary.unmatchedRows}` },
          { label: "Date range", value: data.summary.dateRange },
          { label: "Total ink ml", value: data.summary.totalInkMl.toFixed(1) },
          { label: `Calculated ink cost${data.summary.inkCostComplete ? "" : " (partial)"}`, value: money(data.summary.totalInkCost) },
          { label: "Total print minutes", value: data.summary.totalPrintMinutes.toFixed(1) },
          { label: `Machine cost @ $${MACHINE_RATE_LOW}/hr`, value: money(data.summary.machineCostLow) },
          { label: `Machine cost @ $${MACHINE_RATE_HIGH}/hr`, value: money(data.summary.machineCostHigh) },
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
            <thead><tr><th style={thStyle}>Ticket</th><th style={thStyle}>Job / customer</th><th style={thStyle}>Rows</th><th style={thStyle}>Ink ml</th><th style={thStyle}>Ink cost</th><th style={thStyle}>Print min</th><th style={thStyle}>Machine @ ${MACHINE_RATE_LOW}</th><th style={thStyle}>Machine @ ${MACHINE_RATE_HIGH}</th><th style={thStyle}>Machines / media</th><th style={thStyle}>Warnings</th></tr></thead>
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
                  <td style={tdStyle}>{money(rollup.machineCostLow)}</td>
                  <td style={tdStyle}>{money(rollup.machineCostHigh)}</td>
                  <td style={tdStyle}>{rollup.machines.join(", ")}<div style={smallHelp}>{rollup.medias.join(", ") || "—"}</div></td>
                  <td style={tdStyle}>{rollup.warnings.length ? rollup.warnings.map((warning) => <div key={warning} style={warnStyle}>{warning}</div>) : "—"}</td>
                </tr>
              ))}
              {!data.rollups.length ? <tr><td colSpan={10} style={{ ...tdStyle, color: "#6b7280" }}>No ticketed production print-log rows yet — upload RIP logs via RIP Imports.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Print log rows ({data.rowTotal}{data.rowTotal > data.rows.length ? `, showing latest ${data.rows.length}` : ""})</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Date</th><th style={thStyle}>Machine</th><th style={thStyle}>RIP job / ticket</th><th style={thStyle}>Media</th><th style={thStyle}>Sqft</th><th style={thStyle}>Min</th><th style={thStyle}>CMYK ml</th><th style={thStyle}>White ml</th><th style={thStyle}>Gloss ml</th><th style={thStyle}>Total ml</th><th style={thStyle}>Ink cost</th><th style={thStyle}>Mach @ ${MACHINE_RATE_LOW}</th><th style={thStyle}>Mach @ ${MACHINE_RATE_HIGH}</th><th style={thStyle}>Match</th><th style={thStyle}>Warnings</th></tr></thead>
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
                  <td style={tdStyle}>{money(row.machineCostLow)}</td>
                  <td style={tdStyle}>{money(row.machineCostHigh)}</td>
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
