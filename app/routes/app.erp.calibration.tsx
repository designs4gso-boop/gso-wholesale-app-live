import type React from "react";
import { Form, Link, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { machineRatePerHour, buildBrandRates } from "../lib/rip-actual-costs.server";
import {
  KEEP_TOLERANCE_PCT,
  MAX_SINGLE_JOB_SHARE,
  MIN_DATES,
  MIN_JOBS,
  MIN_RUNS,
  buildCalibrationRuns,
  buildRecommendation,
  metricValue,
  type CalibrationJobContext,
  type CalibrationRun,
  type RecommendationCard,
} from "../lib/calibration.server";

// Audit - Calibration (13A.8A): READ-ONLY recommendations from verified
// actual production data. NO action export — this page cannot write anything.
// Recommendations compare observed medians against the ACTIVE assumption
// sources (MachineInkChannel mlPerSqft1Pct + verified costPerMl, and the $8/hr
// machine rate). Apply is deliberately NOT built: observed ml/sqft is total
// ink per area while the engine assumption is per-1%-coverage per channel —
// converting one to the other needs coverage data the RIP logs do not record.

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const filters = {
    printer: url.searchParams.get("cprinter") || "all",
    finish: url.searchParams.get("cfinish") || "all",
    confidence: url.searchParams.get("cconfidence") || "all",
    status: url.searchParams.get("cstatus") || "all",
    days: url.searchParams.get("cdays") || "365",
    includeTest: url.searchParams.get("ctest") === "1",
  };
  const cutoff = filters.days !== "all" ? new Date(Date.now() - (Number(filters.days) || 365) * 86400000) : null;

  const [entries, machines, adminMachineRate] = await Promise.all([
    db.printLogEntry.findMany({
      where: { shop, productionJobId: { not: null }, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true, productionJobId: true, productionJobItemId: true, jobTicket: true, sourceJobName: true,
        printerSoftware: true, machineName: true, mediaName: true, status: true, sqft: true,
        inkMl: true, cmykInkMl: true, whiteInkMl: true, glossInkMl: true, printMinutes: true,
        startedAt: true, completedAt: true, rawRow: true, createdAt: true,
      },
    }),
    db.machine.findMany({
      where: { shop, active: true },
      select: {
        name: true,
        inkChannels: { select: { inkType: true, inkName: true, enabled: true, costPerMl: true, cartridgeCost: true, cartridgeMl: true, mlPerSqft1Pct: true } },
      },
      take: 50,
    }),
    db.erpAdminSetting.findFirst({ where: { shop, key: "defaultMachineRecoveryHr" }, select: { value: true } }).catch(() => null),
  ]);

  const jobIds = [...new Set(entries.map((entry) => entry.productionJobId).filter(Boolean))] as string[];
  const jobs = jobIds.length
    ? await db.productionJob.findMany({
        where: { shop, id: { in: jobIds } },
        select: { id: true, jobTicket: true, items: { select: { id: true, selectedFinish: true, quantity: true } } },
      })
    : [];
  const jobsById = new Map<string, CalibrationJobContext>(jobs.map((job) => [job.id, job]));
  const rates = buildBrandRates(machines);
  const ratePerHour = machineRatePerHour();

  const { runs, excluded } = buildCalibrationRuns({ entries, jobsById, rates, includeTest: filters.includeTest });

  // ACTIVE assumption values, stated at 100% reference coverage: the engine
  // multiplies mlPerSqft1Pct x coverage% per enabled channel, so the
  // comparable ceiling is sum(channel rates) x 100.
  function channelAssumption(brand: "mimaki" | "roland", types: string[]): { value: number | null; source: string } {
    const machine = machines.find((candidate) => (brand === "mimaki" ? /mimaki|ucjv/i : /roland|lg[-\s]?[56]40|truevis/i).test(candidate.name));
    if (!machine) return { value: null, source: "no active machine found" };
    const channels = machine.inkChannels.filter((channel) => channel.enabled !== false && types.includes(String(channel.inkType)));
    if (!channels.length) return { value: null, source: `no ${types.join("/")} channels on ${machine.name}` };
    const sum = channels.reduce((total, channel) => total + (Number(channel.mlPerSqft1Pct) || 0), 0) * 100;
    return { value: sum, source: `${machine.name}: ${channels.length} ${types.join("/")} channel(s) x mlPerSqft1Pct x 100% coverage (ACTIVE engine source)` };
  }

  const brandRateOf = (brand: "mimaki" | "roland") => rates.find((rate) => rate.brand === brand)?.cmykPerMl ?? null;
  const groups: Array<{ key: string; label: string; runs: CalibrationRun[]; brand: "mimaki" | "roland" | null }> = [
    { key: "all", label: "All printers", runs, brand: null },
    { key: "mimaki", label: "Mimaki UCJV300", runs: runs.filter((run) => run.printer === "mimaki"), brand: "mimaki" },
    { key: "roland", label: "Roland LG-640", runs: runs.filter((run) => run.printer === "roland"), brand: "roland" },
  ];
  const finishes = [...new Set(runs.map((run) => run.finish).filter(Boolean))] as string[];
  for (const finish of finishes.slice(0, 6)) {
    groups.push({ key: `finish:${finish}`, label: `Finish: ${finish}`, runs: runs.filter((run) => run.finish === finish), brand: null });
  }

  const cards: RecommendationCard[] = [];
  for (const group of groups) {
    const dollarImpact = (deltaPerSqft: number, representative: CalibrationRun) =>
      `~$${(deltaPerSqft * representative.sqft).toFixed(2)} on a representative ${representative.sqft.toFixed(1)} sqft run (${representative.jobTicket || representative.entryId})`;
    if (group.brand) {
      const cmyk = channelAssumption(group.brand, ["cmyk"]);
      const rate = brandRateOf(group.brand);
      cards.push(buildRecommendation({
        metricKey: `mlPerSqftCmyk:${group.key}`, title: "CMYK ink usage (ml/sqft @100% coverage)", group: group.label, unit: "ml/sqft",
        runs: group.runs, valueOf: metricValue.mlPerSqftCmyk, currentValue: cmyk.value, currentSource: cmyk.source,
        impactOf: rate != null ? (delta, representative) => dollarImpact(delta * rate, representative) : undefined,
      }));
      if (group.brand === "roland") {
        const white = channelAssumption("roland", ["white"]);
        const gloss = channelAssumption("roland", ["gloss"]);
        cards.push(buildRecommendation({ metricKey: `mlPerSqftWhite:${group.key}`, title: "White ink usage (ml/sqft @100% coverage)", group: group.label, unit: "ml/sqft", runs: group.runs, valueOf: metricValue.mlPerSqftWhite, currentValue: white.value, currentSource: white.source }));
        cards.push(buildRecommendation({ metricKey: `mlPerSqftGloss:${group.key}`, title: "Gloss ink usage (ml/sqft @100% coverage)", group: group.label, unit: "ml/sqft", runs: group.runs, valueOf: metricValue.mlPerSqftGloss, currentValue: gloss.value, currentSource: gloss.source }));
      }
    }
    cards.push(buildRecommendation({ metricKey: `mlPerSqftTotal:${group.key}`, title: "Total ink usage (ml/sqft)", group: group.label, unit: "ml/sqft", runs: group.runs, valueOf: metricValue.mlPerSqftTotal, currentValue: null, currentSource: null }));
    cards.push(buildRecommendation({ metricKey: `inkCostPerSqft:${group.key}`, title: "Observed ink cost ($/sqft)", group: group.label, unit: "$/sqft", runs: group.runs, valueOf: metricValue.inkCostPerSqft, currentValue: null, currentSource: null, impactOf: dollarImpact }));
    cards.push(buildRecommendation({ metricKey: `machineCostPerSqft:${group.key}`, title: `Observed machine cost ($/sqft @ $${ratePerHour}/hr)`, group: group.label, unit: "$/sqft", runs: group.runs, valueOf: metricValue.machineCostPerSqft(ratePerHour), currentValue: null, currentSource: null, impactOf: dollarImpact }));
    cards.push(buildRecommendation({ metricKey: `minutesPerSqft:${group.key}`, title: "Print minutes per sqft", group: group.label, unit: "min/sqft", runs: group.runs, valueOf: metricValue.minutesPerSqft, currentValue: null, currentSource: null }));
    cards.push(buildRecommendation({ metricKey: `minutesPerJob:${group.key}`, title: "Print minutes per run", group: group.label, unit: "min", runs: group.runs, valueOf: metricValue.minutesPerJob, currentValue: null, currentSource: null }));
    cards.push(buildRecommendation({ metricKey: `minutesPer100Units:${group.key}`, title: "Print minutes per 100 units", group: group.label, unit: "min/100u", runs: group.runs, valueOf: metricValue.minutesPer100Units, currentValue: null, currentSource: null }));
  }

  const filteredCards = cards.filter((card) => {
    if (filters.printer === "mimaki" && !card.metricKey.includes(":mimaki") && !card.metricKey.includes(":all")) return false;
    if (filters.printer === "roland" && !card.metricKey.includes(":roland") && !card.metricKey.includes(":all")) return false;
    if (filters.finish !== "all" && !card.group.startsWith("Finish: ")) return false;
    if (filters.finish !== "all" && card.group !== `Finish: ${filters.finish}`) return false;
    if (filters.confidence !== "all" && card.confidence !== filters.confidence) return false;
    if (filters.status !== "all" && card.status !== filters.status) return false;
    return true;
  });

  const excludedReasonCounts: Record<string, number> = {};
  for (const row of excluded) {
    const key = row.reason.split(":")[0];
    excludedReasonCounts[key] = (excludedReasonCounts[key] || 0) + 1;
  }

  const adminRateValue = adminMachineRate?.value ?? null;
  return {
    filters,
    finishes,
    runCount: runs.length,
    testRunCount: runs.filter((run) => run.isTest).length,
    excludedReasonCounts,
    excludedRows: excluded.slice(0, 30),
    cards: filteredCards,
    totalCards: cards.length,
    runsPreview: runs.slice(0, 50),
    assumptions: {
      machineRatePerHour: ratePerHour,
      adminDuplicateRate: adminRateValue,
      adminDuplicateFlag: adminRateValue != null && Number(adminRateValue) !== ratePerHour
        ? `erpAdminSetting.defaultMachineRecoveryHr = ${adminRateValue} is a STALE reference-only value. The one canonical machine-rate authority is machineRatePerHour() = $${ratePerHour}/hr (owner-standards registry); the admin setting never prices anything and is not a competing source (15G.2).`
        : null,
      seededFingerprint: 0.0075,
      channelRates: rates.map((rate) => `${rate.machineName}: CMYK ${rate.cmykPerMl == null ? "n/a" : `$${rate.cmykPerMl.toFixed(4)}/ml`}`),
    },
    thresholds: { MIN_RUNS, MIN_JOBS, MIN_DATES, MAX_SINGLE_JOB_SHARE, KEEP_TOLERANCE_PCT },
  };
}

const card: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "white", marginTop: 14 };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, marginRight: 6 };
const STATUS_STYLE: Record<string, React.CSSProperties> = {
  recommend_increase: { ...chip, background: "#fee2e2", color: "#991b1b" },
  recommend_decrease: { ...chip, background: "#dbeafe", color: "#1e40af" },
  keep_current: { ...chip, background: "#dcfce7", color: "#166534" },
  observed_only: { ...chip, background: "#e0e7ff", color: "#3730a3" },
  not_enough_data: { ...chip, background: "#f3f4f6", color: "#6b7280" },
};
const CONF_STYLE: Record<string, React.CSSProperties> = {
  high: { ...chip, background: "#dcfce7", color: "#166534" },
  medium: { ...chip, background: "#fef3c7", color: "#92400e" },
  low: { ...chip, background: "#fee2e2", color: "#991b1b" },
};

export default function CalibrationRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const fmt = (value: number | null, digits = 4) => (value == null ? "n/a" : value.toFixed(digits));

  return (
    <main style={{ maxWidth: 1280, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p><Link to="/app/erp/actual-costs">← Audit · Actual Costs</Link> · <Link to="/app/erp/rip-import-review">RIP Import Review</Link> · <Link to="/app/erp/cost-verification">Cost Verification</Link></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#3f6212)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>Calibration Recommendations</h1>
        <p style={{ margin: "8px 0 0" }}>
          13A.8A — READ-ONLY. Verified actual production data vs the ACTIVE pricing assumptions (machine ink channels +
          the ${data.assumptions.machineRatePerHour}/hr rate). Nothing on this page changes pricing, costs, quotes,
          products, machines, or history — recommendations are informational until a separate owner-approved apply exists.
        </p>
      </section>

      <section style={{ marginTop: 14, border: "2px solid #16a34a", background: "#f0fdf4", color: "#166534", borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700 }}>
        Nothing changes automatically. This page has no write actions at all. Sample thresholds: {data.thresholds.MIN_RUNS}+ runs,
        {" "}{data.thresholds.MIN_JOBS}+ jobs, {data.thresholds.MIN_DATES}+ dates, no job over {data.thresholds.MAX_SINGLE_JOB_SHARE * 100}% of the sample;
        keep-current tolerance ±{data.thresholds.KEEP_TOLERANCE_PCT}%; median-based recommendations; IQR outlier fences shown per card.
      </section>

      {data.assumptions.adminDuplicateFlag ? (
        <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb", fontSize: 13 }}>
          <b>Duplicate assumption source flagged:</b> {data.assumptions.adminDuplicateFlag}
        </section>
      ) : null}

      <section style={card}>
        <b style={{ fontSize: 13 }}>Data quality</b>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 8, fontSize: 13 }}>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}><div style={{ color: "#6b7280", fontSize: 11 }}>Trustworthy runs</div><div style={{ fontWeight: 800, fontSize: 18 }}>{data.runCount}</div></div>
          {Object.entries(data.excludedReasonCounts).map(([reason, count]) => (
            <div key={reason} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
              <div style={{ color: "#6b7280", fontSize: 11 }}>excluded: {reason.replace(/_/g, " ")}</div>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{count}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          Verified channel rates in use: {data.assumptions.channelRates.join(" · ") || "none"} · Seeded fingerprint under calibration: {data.assumptions.seededFingerprint} ml/sqft per 1% coverage per channel.
          Test rows (standalone TEST token) are {data.filters.includeTest ? "INCLUDED (toggle below)" : "excluded by default"} — the schema has no production/test flag, so the token filter is the documented safe strategy.
        </p>
      </section>

      <section style={card}>
        <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12 }}>Printer<br />
            <select name="cprinter" defaultValue={data.filters.printer} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
              <option value="all">All</option><option value="mimaki">Mimaki</option><option value="roland">Roland</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Finish<br />
            <select name="cfinish" defaultValue={data.filters.finish} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
              <option value="all">All groups</option>
              {data.finishes.map((finish) => <option key={finish} value={finish}>{finish}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Confidence<br />
            <select name="cconfidence" defaultValue={data.filters.confidence} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
              <option value="all">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Status<br />
            <select name="cstatus" defaultValue={data.filters.status} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
              <option value="all">All</option><option value="recommend_increase">Increase</option><option value="recommend_decrease">Decrease</option>
              <option value="keep_current">Keep current</option><option value="observed_only">Observed only</option><option value="not_enough_data">Not enough data</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Window<br />
            <select name="cdays" defaultValue={data.filters.days} style={{ padding: 6, borderRadius: 6, border: "1px solid #aaa" }}>
              <option value="90">90 days</option><option value="365">1 year</option><option value="all">All time</option>
            </select>
          </label>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            <input type="checkbox" name="ctest" value="1" defaultChecked={data.filters.includeTest} /> include TEST rows
          </label>
          <button type="submit" disabled={busy} style={{ background: "#111827", color: "white", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700 }}>Apply filters</button>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{data.cards.length} of {data.totalCards} cards</span>
        </Form>
      </section>

      {data.cards.map((rec) => (
        <section key={rec.metricKey} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div><b>{rec.title}</b> <span style={{ color: "#6b7280", fontSize: 12 }}>— {rec.group}</span></div>
            <div>
              <span style={STATUS_STYLE[rec.status]}>{rec.status.replace(/_/g, " ")}</span>
              {rec.confidence ? <span style={CONF_STYLE[rec.confidence]}>confidence: {rec.confidence}</span> : null}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8, fontSize: 12 }}>
            <div><b>Current:</b> {fmt(rec.currentValue)} {rec.currentValue != null ? rec.unit : ""}<div style={{ color: "#6b7280", fontSize: 11 }}>{rec.currentSource || "no active assumption"}</div></div>
            <div><b>Observed median:</b> {fmt(rec.observedMedian)}<br /><b>Mean:</b> {fmt(rec.observedMean)}</div>
            <div><b>Recommended:</b> {fmt(rec.recommendedValue)}<br /><b>Diff:</b> {fmt(rec.absoluteDifference)} ({rec.percentDifference == null ? "n/a" : `${rec.percentDifference.toFixed(1)}%`})</div>
            <div><b>Sample:</b> {rec.sampleCount} runs / {rec.jobCount} jobs<br /><b>Dates:</b> {rec.dateRange || "n/a"}</div>
            <div><b>Spread:</b> {fmt(rec.min)}–{fmt(rec.max)}<br /><b>Stdev:</b> {fmt(rec.stdev)}</div>
            <div><b>Printers:</b> {rec.printers.join(", ") || "n/a"}<br /><b>Outliers excluded:</b> {rec.excludedOutlierRunIds.length}</div>
          </div>
          <p style={{ fontSize: 12, margin: "8px 0 0" }}>{rec.rationale}</p>
          {rec.representativeImpact ? <p style={{ fontSize: 12, margin: "4px 0 0", color: "#1e40af" }}>Expected impact: {rec.representativeImpact}</p> : null}
          {rec.excludedOutlierRunIds.length ? (
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 12, color: "#92400e", cursor: "pointer" }}>
                {rec.excludedOutlierRunIds.length} outlier run(s) excluded by IQR fences {rec.outlierFences ? `(${rec.outlierFences.low.toFixed(4)} to ${rec.outlierFences.high.toFixed(4)})` : ""} — row IDs
              </summary>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{rec.excludedOutlierRunIds.join(", ")}</div>
            </details>
          ) : null}
        </section>
      ))}
      {!data.cards.length ? <section style={card}><p style={{ color: "#6b7280", fontSize: 13 }}>No cards match these filters.</p></section> : null}

      <section style={card}>
        <b style={{ fontSize: 13 }}>Source runs (trustworthy, first {data.runsPreview.length})</b>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ background: "#f3f4f6" }}><th align="left" style={{ padding: 6 }}>Run</th><th align="left">Ticket</th><th align="left">Printer</th><th align="left">Finish</th><th>Sqft</th><th>Ink ml</th><th>C/W/G</th><th>Min (source)</th><th>Date</th></tr></thead>
            <tbody>
              {data.runsPreview.map((run) => (
                <tr key={run.entryId} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 6 }}>{run.entryId.slice(0, 8)}…{run.isTest ? " (TEST)" : ""}</td>
                  <td><Link to={`/app/erp/production/${run.jobId}/print`}>{run.jobTicket || "job"}</Link></td>
                  <td>{run.printer} <span style={{ color: "#6b7280" }}>{run.machineLabel}</span></td>
                  <td>{run.finish || "—"}</td>
                  <td align="center">{run.sqft.toFixed(2)}</td>
                  <td align="center">{run.inkMl.toFixed(2)}</td>
                  <td align="center">{run.channelSplitResolved ? `${run.cmykInkMl.toFixed(1)}/${run.whiteInkMl.toFixed(1)}/${run.glossInkMl.toFixed(1)}` : "unresolved"}</td>
                  <td align="center">{run.minutes.toFixed(1)} ({run.durationSource.replace(/_/g, " ")})</td>
                  <td>{run.productionDate || "—"}</td>
                </tr>
              ))}
              {!data.runsPreview.length ? <tr><td colSpan={9} style={{ padding: 8, color: "#6b7280" }}>No trustworthy runs yet — attach print logs and re-check.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
