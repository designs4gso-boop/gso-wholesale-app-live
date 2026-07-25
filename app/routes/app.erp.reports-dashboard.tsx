import { useLoaderData, Link, Form } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  LEAKAGE_THRESHOLDS,
  aggregateByCustomer,
  aggregateByFamily,
  aggregateByProduct,
  aggregateByQuantityBand,
  aggregateByVendor,
  buildPricingFeedbackSuggestions,
  detectMarginLeakage,
  normalizeFinalizedJobActuals,
  toCsv,
} from "../lib/actual-cost-reporting.server";
import { resolveActorFromSession } from "../lib/actual-cost-finalize.server";

// 15E.2-M: owner review queue for pricing-feedback findings — decisions live
// in ErpAdminSetting (category "pricing-feedback"); destination data (Product
// Setup / Cost Book / owner standards / DTP ladder) is NEVER auto-changed.
export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  if (String(formData.get("intent")) !== "reviewPricingFeedback") return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const suggestionId = String(formData.get("suggestionId") || "").slice(0, 180);
  const decision = String(formData.get("decision") || "");
  if (!suggestionId || !["accepted", "dismissed", "deferred"].includes(decision)) {
    return Response.json({ ok: false, message: "Suggestion and a decision (accept/dismiss/defer) are required." }, { status: 400 });
  }
  const actor = resolveActorFromSession(session, shop);
  const value = JSON.stringify({ status: decision, actor, at: new Date().toISOString(), note: String(formData.get("decisionNote") || "").slice(0, 300) });
  const existing = await db.erpAdminSetting.findFirst({ where: { shop, category: "pricing-feedback", key: suggestionId } });
  if (existing) await db.erpAdminSetting.update({ where: { id: existing.id }, data: { value, label: `Pricing feedback ${decision}`, valueType: "json", description: "15E.2 owner review decision (no automatic data change)." } });
  else await db.erpAdminSetting.create({ data: { shop, category: "pricing-feedback", key: suggestionId, label: `Pricing feedback ${decision}`, value, valueType: "json", description: "15E.2 owner review decision (no automatic data change)." } });
  return Response.json({ ok: true, message: `Recorded: ${decision}. Apply any change manually in Product Setup / Vendor Cost Book / owner standards.` });
}

function number(value: any) {
  return Number(value || 0);
}

function money(value: any) {
  return `$${number(value).toFixed(2)}`;
}

function pct(value: any) {
  return `${number(value).toFixed(1)}%`;
}

function dateOnly(value: any) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString();
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function sum(items: any[], fn: (item: any) => number) {
  return items.reduce((total, item) => total + number(fn(item)), 0);
}

function quoteRevenue(quote: any) {
  return sum(quote.items || [], (item) => number(item.quantity) * number(item.unitPrice));
}

function quoteCost(quote: any) {
  return sum(quote.items || [], (item) => number(item.quantity) * number(item.unitCost));
}

function jobRevenue(job: any) {
  return sum(job.items || [], (item) => number(item.quantity) * number(item.unitPrice));
}

function jobEstimatedCost(job: any) {
  return sum(job.items || [], (item) => number(item.quantity) * number(item.unitCost));
}

function groupBy(items: any[], keyFn: (item: any) => string) {
  return items.reduce((groups: Record<string, any[]>, item) => {
    const key = keyFn(item) || "Unknown";
    groups[key] = groups[key] || [];
    groups[key].push(item);
    return groups;
  }, {});
}

function topEntries(groups: Record<string, any[]>, metricFn: (items: any[]) => number, limit = 8) {
  return Object.entries(groups)
    .map(([label, items]) => ({ label, count: items.length, value: metricFn(items) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "30";
  const rangeDays = range === "all" ? 3650 : Math.max(1, Number(range) || 30);
  const today = startOfDay(new Date());
  const rangeStart = startOfDay(addDays(today, -rangeDays));
  const weekEnd = endOfDay(addDays(today, 7));

  // ---- 15E.2: finalized-only actual-cost reporting (A) ----
  const reportFamily = String(url.searchParams.get("rfamily") || "");
  const reportCustomer = String(url.searchParams.get("rcustomer") || "").toLowerCase();
  const reportActor = String(url.searchParams.get("ractor") || "").toLowerCase();
  const reportBelowPct = Number(url.searchParams.get("rbelow") || 0);
  const reportWarningsOnly = url.searchParams.get("rwarnings") === "1";
  const reportReopenedOnly = url.searchParams.get("rreopened") === "1";
  const reportVarianceSign = String(url.searchParams.get("rvariance") || "");
  const finalizedJobsRaw = await db.productionJob.findMany({
    where: { shop, actualCostFinalized: true, actualCostFinalizedAt: { gte: rangeStart } },
    include: { items: true, materialUsages: true, events: { where: { eventType: { in: ["actual_cost_finalized", "actual_cost_reopened"] } }, orderBy: { createdAt: "asc" } } },
    orderBy: { actualCostFinalizedAt: "desc" },
    take: 400,
  });
  const openJobsCount = await db.productionJob.count({ where: { shop, active: true, actualCostFinalized: false } });
  const allFinalizedRows = finalizedJobsRaw.map((job: any) => normalizeFinalizedJobActuals(job)).filter(Boolean) as any[];
  const finalizedRows = allFinalizedRows.filter((row: any) => {
    if (reportFamily && row.family !== reportFamily) return false;
    if (reportCustomer && !row.customerLabel.toLowerCase().includes(reportCustomer)) return false;
    if (reportActor && !String(row.finalizedBy).toLowerCase().includes(reportActor)) return false;
    if (reportBelowPct > 0 && row.finalMarginPct >= reportBelowPct) return false;
    if (reportWarningsOnly && row.gateStatus !== "WARNING") return false;
    if (reportReopenedOnly && row.reopenCount === 0) return false;
    if (reportVarianceSign === "pos" && row.varianceDollars <= 0) return false;
    if (reportVarianceSign === "neg" && row.varianceDollars >= 0) return false;
    return true;
  });
  const jobLeakage = new Map(finalizedRows.map((row: any) => [row.jobId, detectMarginLeakage(row)]));
  const familyReport = aggregateByFamily(finalizedRows);
  const productReport = aggregateByProduct(finalizedRows);
  const customerReport = aggregateByCustomer(finalizedRows);
  const vendorReport = aggregateByVendor(finalizedRows);
  const bandReport = aggregateByQuantityBand(finalizedRows);
  const feedback = buildPricingFeedbackSuggestions(allFinalizedRows); // evidence uses the full finalized set, not the filtered view
  const feedbackDecisions = await db.erpAdminSetting.findMany({ where: { shop, category: "pricing-feedback" } });
  const decisionByKey = new Map(feedbackDecisions.map((setting: any) => [setting.key, (() => { try { return JSON.parse(setting.value); } catch { return null; } })()]));
  const execRevenue = finalizedRows.reduce((sum: number, row: any) => sum + row.finalRevenue, 0);
  const execProfit = finalizedRows.reduce((sum: number, row: any) => sum + row.finalProfit, 0);
  const exec = {
    finalizedJobs: finalizedRows.length,
    openJobs: openJobsCount,
    revenue: execRevenue,
    actualCost: finalizedRows.reduce((sum: number, row: any) => sum + row.finalCost, 0),
    profit: execProfit,
    weightedMarginPct: execRevenue > 0 ? (execProfit / execRevenue) * 100 : 0,
    varianceDollars: finalizedRows.reduce((sum: number, row: any) => sum + row.varianceDollars, 0),
    belowFloorJobs: finalizedRows.filter((row: any) => (jobLeakage.get(row.jobId) || []).some((flag: string) => flag.includes("FAMILY FLOOR"))).length,
    warningJobs: finalizedRows.filter((row: any) => row.gateStatus === "WARNING").length,
    reopenedJobs: finalizedRows.filter((row: any) => row.reopenCount > 0).length,
    reprintCost: finalizedRows.reduce((sum: number, row: any) => sum + row.reprintCost, 0),
    legacyJobs: finalizedRows.filter((row: any) => row.legacyFinal).length,
    topLeakageFamily: [...familyReport].sort((a, b) => (a.weightedMarginPct - b.weightedMarginPct))[0]?.label || "none",
    topProfitFamily: [...familyReport].sort((a, b) => (b.profit - a.profit))[0]?.label || "none",
  };
  // ---- 15E.2 CSV export (O): server-generated, no snapshots/phrases ----
  const exportKind = String(url.searchParams.get("export") || "");
  if (exportKind) {
    let csv = "";
    if (exportKind === "jobs") csv = toCsv(
      ["finalizedAt", "jobTicket", "customer", "product", "family", "quantity", "estRevenue", "estCost", "estProfit", "estMarginPct", "finalRevenue", "finalCost", "finalProfit", "finalMarginPct", "costVarianceDollars", "costVariancePct", "marginVariancePts", "gateStatus", "finalizeReason", "finalizedBy", "reopenCount", "sourceQuoteId", "legacyFinal", "leakageFlags"],
      finalizedRows.map((row: any) => [row.finalizedAt, row.jobTicket, row.customerLabel, row.productLabel, row.family, row.quantity, row.estimatedRevenue.toFixed(2), row.estimatedCost.toFixed(2), row.estimatedProfit.toFixed(2), row.estimatedMarginPct == null ? "" : row.estimatedMarginPct.toFixed(1), row.finalRevenue.toFixed(2), row.finalCost.toFixed(2), row.finalProfit.toFixed(2), row.finalMarginPct.toFixed(1), row.varianceDollars.toFixed(2), row.variancePct == null ? "unavailable" : row.variancePct.toFixed(1), row.marginVariancePts == null ? "" : row.marginVariancePts.toFixed(1), row.gateStatus, row.finalizeReason || "", row.finalizedBy, row.reopenCount, row.sourceQuoteId || "", row.legacyFinal ? "legacy final" : "", (jobLeakage.get(row.jobId) || []).join("; ")]),
    );
    else if (exportKind === "families" || exportKind === "products" || exportKind === "vendors") {
      const source = exportKind === "families" ? familyReport : exportKind === "products" ? productReport : vendorReport;
      csv = toCsv(
        ["label", "jobs", "units", "revenue", "estimatedCost", "actualCost", "profit", "weightedMarginPct", "averageMarginPct", "varianceDollars", "variancePct", "belowTargetJobs", "belowFloorJobs", "warningJobs", "reopenedJobs", "reprintCost", "laborVarianceDollars", "freightVarianceDollars", "vendorVarianceDollars"],
        source.map((row: any) => [row.label, row.jobs, row.units, row.revenue.toFixed(2), row.estimatedCost.toFixed(2), row.actualCost.toFixed(2), row.profit.toFixed(2), row.weightedMarginPct.toFixed(1), row.averageMarginPct.toFixed(1), row.varianceDollars.toFixed(2), row.variancePct == null ? "unavailable" : row.variancePct.toFixed(1), row.belowTargetJobs, row.belowFloorJobs, row.warningJobs, row.reopenedJobs, row.reprintCost.toFixed(2), row.laborVarianceDollars.toFixed(2), row.freightVarianceDollars.toFixed(2), row.vendorVarianceDollars.toFixed(2)]),
      );
    } else if (exportKind === "feedback") csv = toCsv(
      ["type", "family", "productKey", "quantityBand", "message", "currentStandard", "actualObserved", "jobCount", "dateRange", "variancePct", "projectedEffect", "confidence", "supportingJobs", "decision"],
      feedback.map((row: any) => [row.type, row.family, row.productKey, row.quantityBand, row.message, row.currentStandard, row.actualObserved, row.jobCount, row.dateRange, row.variancePct == null ? "" : row.variancePct.toFixed(1), row.projectedEffect, row.confidence, row.supportingJobs.join(" "), (decisionByKey.get(row.id) as any)?.status || "unreviewed"]),
    );
    if (csv) return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gso-actual-cost-${exportKind}.csv"` } });
  }

  const [quotes, jobs, materials, purchaseRequests, printLogs, vendors, costBookItems] = await Promise.all([
    db.quote.findMany({
      where: { shop, createdAt: { gte: rangeStart } },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    }),
    db.productionJob.findMany({
      where: { shop, active: true },
      orderBy: { updatedAt: "desc" },
      include: {
        items: true,
        materialUsages: true,
        events: { orderBy: { createdAt: "desc" }, take: 6 },
      },
    }),
    db.material.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.purchaseRequest.findMany({ where: { shop }, orderBy: { updatedAt: "desc" } }),
    db.printLogEntry.findMany({ where: { shop, createdAt: { gte: rangeStart } }, orderBy: { createdAt: "desc" } }),
    db.vendor.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.vendorCostBookItem.findMany({ where: { shop, status: "active" }, orderBy: { updatedAt: "desc" }, take: 100 }),
  ]);

  const quoteTotals = quotes.map((quote) => {
    const revenue = quoteRevenue(quote);
    const cost = quoteCost(quote);
    return { ...quote, revenue, cost, profit: revenue - cost };
  });

  const paidQuotes = quoteTotals.filter((quote) => ["paid", "production", "completed"].includes(String(quote.status || "").toLowerCase()));
  const approvedQuotes = quoteTotals.filter((quote) => String(quote.status || "").toLowerCase() === "approved");
  const openQuotes = quoteTotals.filter((quote) => !["paid", "production", "completed", "cancelled"].includes(String(quote.status || "").toLowerCase()));

  const jobRows = jobs.map((job) => {
    const revenue = jobRevenue(job);
    const estimatedCost = jobEstimatedCost(job);
    const materialCost = sum(job.materialUsages || [], (usage) => usage.totalCost);
    const actualTotalCost = number(job.actualTotalCost) || estimatedCost + materialCost;
    return {
      ...job,
      revenue,
      estimatedCost,
      materialCost,
      actualTotalCost,
      finalProfit: revenue - actualTotalCost,
      finalMargin: revenue > 0 ? ((revenue - actualTotalCost) / revenue) * 100 : 0,
    };
  });

  const overdueJobs = jobRows.filter((job) => job.dueDate && new Date(job.dueDate) < today && !["completed", "cancelled", "shipped"].includes(String(job.status).toLowerCase()));
  const dueThisWeek = jobRows.filter((job) => job.dueDate && new Date(job.dueDate) >= today && new Date(job.dueDate) <= weekEnd);
  const rushJobs = jobRows.filter((job) => ["rush", "critical"].includes(String(job.priority || "").toLowerCase()));
  const noDueDateJobs = jobRows.filter((job) => !job.dueDate && !["completed", "cancelled", "shipped"].includes(String(job.status).toLowerCase()));

  const lowStockMaterials = materials
    .filter((material) => material.reorderPoint != null && number(material.stockOnHand) <= number(material.reorderPoint))
    .map((material) => ({
      id: material.id,
      name: material.name,
      unit: material.unit || material.baseUnit || "each",
      stockOnHand: number(material.stockOnHand),
      reorderPoint: number(material.reorderPoint),
      vendor: material.vendor || "Vendor TBD",
      sku: material.sku || "",
      leadTimeDays: material.leadTimeDays || null,
    }));

  const openPurchaseRequests = purchaseRequests.filter((po) => !["received", "cancelled"].includes(String(po.status || "").toLowerCase()));
  const followUpPurchases = purchaseRequests.filter((po) => po.followUpNeeded);
  const latePurchases = purchaseRequests.filter((po) => po.expectedArrivalDate && new Date(po.expectedArrivalDate) < today && !["received", "cancelled"].includes(String(po.status || "").toLowerCase()));

  const statusCounts = Object.entries(groupBy(jobRows, (job) => String(job.status || "new"))).map(([label, rows]) => ({ label, count: rows.length }));
  const proofCounts = Object.entries(groupBy(jobRows, (job) => String(job.proofStatus || "draft"))).map(([label, rows]) => ({ label, count: rows.length }));
  const quoteStatusCounts = Object.entries(groupBy(quoteTotals, (quote) => String(quote.status || "draft"))).map(([label, rows]) => ({ label, count: rows.length }));

  const topCustomers = topEntries(groupBy(quoteTotals, (quote) => quote.company || quote.customerName || quote.email || "Unknown"), (items) => sum(items, (quote) => quote.revenue));
  const allQuoteItems = quotes.flatMap((quote) => (quote.items || []).map((item) => ({ ...item, quote })));
  const topProducts = topEntries(groupBy(allQuoteItems, (item) => item.productName || "Unknown"), (items) => sum(items, (item) => number(item.quantity) * number(item.unitPrice)));

  const metrics = {
    rangeDays,
    quoteRevenue: sum(quoteTotals, (quote) => quote.revenue),
    quoteCost: sum(quoteTotals, (quote) => quote.cost),
    quoteProfit: sum(quoteTotals, (quote) => quote.profit),
    paidRevenue: sum(paidQuotes, (quote) => quote.revenue),
    approvedRevenue: sum(approvedQuotes, (quote) => quote.revenue),
    openQuoteValue: sum(openQuotes, (quote) => quote.revenue),
    jobRevenue: sum(jobRows, (job) => job.revenue),
    jobEstimatedCost: sum(jobRows, (job) => job.estimatedCost),
    jobActualCost: sum(jobRows, (job) => job.actualTotalCost),
    jobFinalProfit: sum(jobRows, (job) => job.finalProfit),
    avgFinalMargin: jobRows.length ? sum(jobRows, (job) => job.finalMargin) / jobRows.length : 0,
    printSqft: sum(printLogs, (log) => log.sqft),
    printInkMl: sum(printLogs, (log) => log.inkMl),
    printMinutes: sum(printLogs, (log) => log.printMinutes),
    materialStockValue: sum(materials, (material) => number(material.stockOnHand) * number(material.costPerUnit || material.calculatedUnitCost || material.purchaseCost)),
    openPoValue: sum(openPurchaseRequests, (po) => po.estimatedCost),
  };

  return Response.json({
    range,
    // 15E.2: finalized-only actual-cost reporting payload
    actualReport: {
      exec,
      rows: finalizedRows,
      leakage: Object.fromEntries(jobLeakage),
      families: familyReport,
      products: productReport,
      customers: customerReport,
      vendors: vendorReport,
      bands: bandReport,
      feedback: feedback.map((suggestion) => ({ ...suggestion, decision: (decisionByKey.get(suggestion.id) as any) || null })),
      thresholds: LEAKAGE_THRESHOLDS,
      filters: { rfamily: reportFamily, rcustomer: reportCustomer, ractor: reportActor, rbelow: reportBelowPct, rwarnings: reportWarningsOnly, rreopened: reportReopenedOnly, rvariance: reportVarianceSign },
    },
    metrics,
    counts: {
      quotes: quotes.length,
      jobs: jobs.length,
      activeMaterials: materials.length,
      lowStock: lowStockMaterials.length,
      vendors: vendors.length,
      costBookItems: costBookItems.length,
      openPurchaseRequests: openPurchaseRequests.length,
      followUpPurchases: followUpPurchases.length,
      latePurchases: latePurchases.length,
      overdueJobs: overdueJobs.length,
      dueThisWeek: dueThisWeek.length,
      rushJobs: rushJobs.length,
      noDueDateJobs: noDueDateJobs.length,
      printLogRows: printLogs.length,
    },
    statusCounts,
    proofCounts,
    quoteStatusCounts,
    topCustomers,
    topProducts,
    overdueJobs: overdueJobs.slice(0, 10).map((job) => ({ id: job.id, jobTicket: job.jobTicket, customer: job.company || job.customerName || "Unknown", status: job.status, dueDate: job.dueDate, revenue: job.revenue })),
    rushJobs: rushJobs.slice(0, 10).map((job) => ({ id: job.id, jobTicket: job.jobTicket, customer: job.company || job.customerName || "Unknown", priority: job.priority, status: job.status, dueDate: job.dueDate })),
    lowStockMaterials: lowStockMaterials.slice(0, 15),
    latePurchases: latePurchases.slice(0, 10).map((po) => ({ id: po.id, requestNumber: po.requestNumber, materialName: po.materialName, vendor: po.vendor, expectedArrivalDate: po.expectedArrivalDate, estimatedCost: po.estimatedCost })),
    recentProductionEvents: jobs.flatMap((job) => (job.events || []).map((event) => ({ ...event, jobTicket: job.jobTicket, customer: job.company || job.customerName || "Unknown" }))).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12),
  });
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: "1px solid #d9d9d9", borderRadius: 12, padding: 14, background: "white" }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>{sub}</div> : null}
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid #ddd", borderRadius: 14, padding: 16, background: "white", marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function MiniTable({ rows, empty }: { rows: any[]; empty: string }) {
  if (!rows.length) return <p style={{ color: "#666" }}>{empty}</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((row: any, index: number) => (
        <div key={row.id || row.label || index} style={{ border: "1px solid #e4e4e4", borderRadius: 10, padding: 10, background: "#fafafa" }}>
          {Object.entries(row).filter(([key]) => key !== "id").map(([key, value]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
              <strong style={{ textTransform: "capitalize" }}>{key.replaceAll("_", " ").replaceAll(/([A-Z])/g, " $1")}:</strong>
              <span>{key.toLowerCase().includes("date") ? dateOnly(value) : String(value ?? "")}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function BarList({ rows, valueLabel = "value" }: { rows: { label: string; count?: number; value?: number }[]; valueLabel?: string }) {
  const max = Math.max(...rows.map((row) => number(row.value ?? row.count)), 1);
  if (!rows.length) return <p style={{ color: "#666" }}>No data yet.</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((row) => {
        const value = number(row.value ?? row.count);
        return (
          <div key={row.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <strong>{row.label}</strong>
              <span>{valueLabel === "money" ? money(value) : row.count != null && row.value != null ? `${row.count} | ${money(row.value)}` : value}</span>
            </div>
            <div style={{ height: 8, background: "#eee", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.max(4, (value / max) * 100)}%`, background: "#111" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportsDashboard() {
  const data = useLoaderData<any>();
  const { metrics, counts } = data;
  const report = data.actualReport || null;
  const actualMargin = metrics.jobRevenue > 0 ? ((metrics.jobRevenue - metrics.jobActualCost) / metrics.jobRevenue) * 100 : 0;
  const quoteMargin = metrics.quoteRevenue > 0 ? (metrics.quoteProfit / metrics.quoteRevenue) * 100 : 0;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
        <div>
          <Link to="/app">← Dashboard</Link>
          <h1 style={{ margin: "8px 0 4px", fontSize: 26 }}>Reports Dashboard</h1>
      {report ? (
        <section style={{ border: "2px solid #b45309", borderRadius: 14, padding: 16, background: "white", marginTop: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Actual-Cost Profitability (finalized jobs only)</h2>
          <p style={{ fontSize: 12, color: "#666", margin: "4px 0 10px" }}>
            Finalized-only policy: totals below come from locked final costs + immutable finalize snapshots. {report.exec.openJobs} open/unfinalized job(s) are EXCLUDED (incomplete data). {report.exec.legacyJobs ? `${report.exec.legacyJobs} legacy final(s) use columns only.` : ""} Pricing is never changed automatically.
          </p>
          {/* 1. Executive summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <div><b>{report.exec.finalizedJobs}</b><div style={{ fontSize: 12, color: "#666" }}>Finalized jobs</div></div>
            <div><b>{money(report.exec.revenue)}</b><div style={{ fontSize: 12, color: "#666" }}>Revenue</div></div>
            <div><b>{money(report.exec.actualCost)}</b><div style={{ fontSize: 12, color: "#666" }}>Actual cost</div></div>
            <div><b>{money(report.exec.profit)}</b><div style={{ fontSize: 12, color: "#666" }}>Profit</div></div>
            <div><b>{pct(report.exec.weightedMarginPct)}</b><div style={{ fontSize: 12, color: "#666" }}>Weighted margin</div></div>
            <div><b>{money(report.exec.varianceDollars)}</b><div style={{ fontSize: 12, color: "#666" }}>Cost variance vs estimate</div></div>
            <div><b>{report.exec.belowFloorJobs}</b><div style={{ fontSize: 12, color: "#666" }}>Below family floor</div></div>
            <div><b>{report.exec.warningJobs}</b><div style={{ fontSize: 12, color: "#666" }}>Warning finalizations</div></div>
            <div><b>{report.exec.reopenedJobs}</b><div style={{ fontSize: 12, color: "#666" }}>Reopened</div></div>
            <div><b>{money(report.exec.reprintCost)}</b><div style={{ fontSize: 12, color: "#666" }}>Reprint cost</div></div>
            <div><b>{report.exec.topLeakageFamily}</b><div style={{ fontSize: 12, color: "#666" }}>Lowest-margin family</div></div>
            <div><b>{report.exec.topProfitFamily}</b><div style={{ fontSize: 12, color: "#666" }}>Top profit family</div></div>
          </div>
          {/* Filters + exports */}
          <form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12, fontSize: 12 }}>
            <input type="hidden" name="range" value={data.range} />
            <label>Family<br /><select name="rfamily" defaultValue={report.filters.rfamily}><option value="">All</option>{["sticker-bags","standard-jars","premium-jars","stickers-labels","banners","dtp-bags","default"].map((family: string) => <option key={family} value={family}>{family}</option>)}</select></label>
            <label>Customer contains<br /><input name="rcustomer" defaultValue={report.filters.rcustomer} /></label>
            <label>Actor contains<br /><input name="ractor" defaultValue={report.filters.ractor} /></label>
            <label>Margin below %<br /><input name="rbelow" type="number" step="1" defaultValue={report.filters.rbelow || ""} style={{ width: 90 }} /></label>
            <label><input type="checkbox" name="rwarnings" value="1" defaultChecked={report.filters.rwarnings} /> Warnings only</label>
            <label><input type="checkbox" name="rreopened" value="1" defaultChecked={report.filters.rreopened} /> Reopened only</label>
            <label>Variance<br /><select name="rvariance" defaultValue={report.filters.rvariance}><option value="">Any</option><option value="pos">Over estimate</option><option value="neg">Under estimate</option></select></label>
            <button type="submit">Apply filters</button>
            {["jobs","families","products","vendors","feedback"].map((kind: string) => <a key={kind} href={`?range=${data.range}&export=${kind}`} style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8, textDecoration: "none" }}>CSV: {kind}</a>)}
          </form>
          {/* 2. Job profitability */}
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Finalized</th><th align="left">Ticket</th><th align="left">Customer</th><th align="left">Product</th><th>Family</th><th>Qty</th><th>Est cost</th><th>Final cost</th><th>Final profit</th><th>Final margin</th><th>Var $</th><th>Var %</th><th align="left">Gate</th><th align="left">Actor</th><th align="left">Flags</th></tr></thead>
              <tbody>
                {report.rows.map((row: any) => (
                  <tr key={row.jobId} style={{ borderTop: "1px solid #e5e7eb", background: (report.leakage[row.jobId] || []).length ? "#fffbeb" : undefined }}>
                    <td>{row.finalizedAt ? new Date(row.finalizedAt).toLocaleDateString() : ""}{row.legacyFinal ? " (legacy final)" : ""}</td>
                    <td><Link to={`/app/erp/production?job=${row.jobId}`}>{row.jobTicket}</Link></td>
                    <td>{row.customerLabel}</td>
                    <td>{row.productLabel}</td>
                    <td align="center">{row.family}</td>
                    <td align="center">{row.quantity.toLocaleString()}</td>
                    <td align="center">{money(row.estimatedCost)}</td>
                    <td align="center">{money(row.finalCost)}</td>
                    <td align="center">{money(row.finalProfit)}</td>
                    <td align="center">{pct(row.finalMarginPct)}</td>
                    <td align="center">{money(row.varianceDollars)}</td>
                    <td align="center">{row.variancePct == null ? "unavailable" : pct(row.variancePct)}</td>
                    <td>{row.gateStatus}{row.finalizeReason ? ` — ${row.finalizeReason}` : ""}{row.reopenCount ? ` — reopened x${row.reopenCount}` : ""}</td>
                    <td>{row.finalizedBy}</td>
                    <td style={{ color: "#92400e" }}>{(report.leakage[row.jobId] || []).join("; ") || "—"}</td>
                  </tr>
                ))}
                {!report.rows.length ? <tr><td colSpan={15} style={{ padding: 10, color: "#666" }}>No finalized jobs in this range/filter.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {/* 3-6. Aggregates */}
          {[["Families", report.families], ["Products / SKUs", report.products], ["Customers (provisional grouping: email, then company, then name)", report.customers], ["Vendors / DTP", report.vendors], ["Quantity bands", report.bands]].map(([title, rows]: any) => (
            <div key={title} style={{ marginTop: 14 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{title}</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Group</th><th>Jobs</th><th>Units</th><th>Revenue</th><th>Actual cost</th><th>Profit</th><th>Weighted margin</th><th>Var $</th><th>Var %</th><th>Below floor</th><th>Warnings</th><th>Reprint $</th><th>Labor var $</th><th>Freight var $</th><th>Vendor var $</th></tr></thead>
                  <tbody>
                    {rows.map((row: any) => (
                      <tr key={row.key} style={{ borderTop: "1px solid #e5e7eb" }}>
                        <td>{row.label}</td><td align="center">{row.jobs}</td><td align="center">{row.units.toLocaleString()}</td>
                        <td align="center">{money(row.revenue)}</td><td align="center">{money(row.actualCost)}</td><td align="center">{money(row.profit)}</td>
                        <td align="center"><b>{pct(row.weightedMarginPct)}</b></td>
                        <td align="center">{money(row.varianceDollars)}</td><td align="center">{row.variancePct == null ? "unavailable" : pct(row.variancePct)}</td>
                        <td align="center">{row.belowFloorJobs}</td><td align="center">{row.warningJobs}</td>
                        <td align="center">{money(row.reprintCost)}</td><td align="center">{money(row.laborVarianceDollars)}</td>
                        <td align="center">{money(row.freightVarianceDollars)}</td><td align="center">{money(row.vendorVarianceDollars)}</td>
                      </tr>
                    ))}
                    {!rows.length ? <tr><td colSpan={15} style={{ padding: 8, color: "#666" }}>No finalized data.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {/* 10. Pricing feedback + owner review queue */}
          <div style={{ marginTop: 14 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Pricing Feedback (owner review — never automatic)</h3>
            <p style={{ fontSize: 12, color: "#666", margin: "0 0 8px" }}>Suggestions need 3+ comparable finalized jobs (same family/product/quantity band); 5+ = high confidence. Accepting records a decision only — apply changes manually in Product Setup / Vendor Cost Book / owner standards / DTP ladder.</p>
            {report.feedback.length ? report.feedback.map((suggestion: any) => (
              <div key={suggestion.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, marginBottom: 8, fontSize: 12, background: suggestion.decision ? "#f0fdf4" : "#fffbeb" }}>
                <b>{suggestion.message}</b> <span style={{ color: "#666" }}>({suggestion.confidence} confidence — {suggestion.jobCount} jobs, {suggestion.dateRange})</span>
                <div>Current: {suggestion.currentStandard} · Observed: {suggestion.actualObserved}{suggestion.variancePct != null ? ` · Variance ${Number(suggestion.variancePct).toFixed(1)}%` : ""} · Next step: {suggestion.projectedEffect}</div>
                <div style={{ color: "#666" }}>Jobs: {suggestion.supportingJobs.join(", ")}</div>
                {suggestion.decision ? (
                  <div style={{ color: "#166534", fontWeight: 700 }}>Decision: {suggestion.decision.status} by {suggestion.decision.actor} ({new Date(suggestion.decision.at).toLocaleDateString()}){suggestion.decision.note ? ` — ${suggestion.decision.note}` : ""}</div>
                ) : (
                  <Form method="post" style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                    <input type="hidden" name="intent" value="reviewPricingFeedback" />
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <input name="decisionNote" placeholder="Optional note" style={{ padding: 4 }} />
                    {["accepted", "dismissed", "deferred"].map((decision: string) => <button key={decision} type="submit" name="decision" value={decision} style={{ padding: "4px 10px" }}>{decision}</button>)}
                  </Form>
                )}
              </div>
            )) : <p style={{ fontSize: 12, color: "#666" }}>No suggestions — fewer than 3 comparable finalized jobs per group, or actuals track estimates.</p>}
          </div>
        </section>
      ) : null}
          <p style={{ margin: 0, color: "#666" }}>Owner-level snapshot of sales, production, purchasing, inventory, print logs, and profitability.</p>
        </div>
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700 }}>Range</label>
            <select name="range" defaultValue={data.range} style={{ padding: 8, borderRadius: 8, border: "1px solid #aaa" }}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option>
              <option value="all">All time</option>
            </select>
          </div>
          <button style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #111", background: "#111", color: "white" }}>Refresh</button>
        </form>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 18 }}>
        <MetricCard label="Quote Revenue" value={money(metrics.quoteRevenue)} sub={`Quote margin ${pct(quoteMargin)}`} />
        <MetricCard label="Paid Revenue" value={money(metrics.paidRevenue)} sub={`Approved pipeline ${money(metrics.approvedRevenue)}`} />
        <MetricCard label="Production Revenue" value={money(metrics.jobRevenue)} sub={`Actual margin ${pct(actualMargin)}`} />
        <MetricCard label="Final Profit" value={money(metrics.jobFinalProfit)} sub={`Actual cost ${money(metrics.jobActualCost)}`} />
        <MetricCard label="Open Quote Value" value={money(metrics.openQuoteValue)} sub={`${counts.quotes} quote(s) in range`} />
        <MetricCard label="Print Logs" value={`${counts.printLogRows}`} sub={`${metrics.printSqft.toFixed(2)} sqft | ${metrics.printInkMl.toFixed(2)} ml | ${metrics.printMinutes.toFixed(2)} min`} />
        <MetricCard label="Inventory Value" value={money(metrics.materialStockValue)} sub={`${counts.lowStock} low-stock material(s)`} />
        <MetricCard label="Open PO Value" value={money(metrics.openPoValue)} sub={`${counts.openPurchaseRequests} open | ${counts.latePurchases} late`} />
      </div>

      <Section title="Action Needed" action={<Link to="/app/erp/production-calendar">Production Calendar</Link>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <MetricCard label="Overdue Jobs" value={String(counts.overdueJobs)} />
          <MetricCard label="Due This Week" value={String(counts.dueThisWeek)} />
          <MetricCard label="Rush / Critical" value={String(counts.rushJobs)} />
          <MetricCard label="No Due Date" value={String(counts.noDueDateJobs)} />
        </div>
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Production Status">
          <BarList rows={data.statusCounts} />
        </Section>
        <Section title="Proof Status">
          <BarList rows={data.proofCounts} />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Top Customers" action={<Link to="/app/quotes">Quotes</Link>}>
          <BarList rows={data.topCustomers} valueLabel="money" />
        </Section>
        <Section title="Top Products">
          <BarList rows={data.topProducts} valueLabel="money" />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Low Stock Materials" action={<Link to="/app/erp/reorder-report">Reorder Report</Link>}>
          <MiniTable rows={data.lowStockMaterials} empty="No low-stock materials right now." />
        </Section>
        <Section title="Late / Follow-up POs" action={<Link to="/app/erp/purchase-requests">PO Requests</Link>}>
          <MiniTable rows={data.latePurchases} empty="No late purchase orders right now." />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Overdue Jobs">
          <MiniTable rows={data.overdueJobs} empty="No overdue jobs." />
        </Section>
        <Section title="Rush / Critical Jobs">
          <MiniTable rows={data.rushJobs} empty="No rush or critical jobs." />
        </Section>
      </div>

      <Section title="Recent Production Events">
        <MiniTable rows={data.recentProductionEvents.map((event: any) => ({ jobTicket: event.jobTicket || "No ticket", customer: event.customer, eventType: event.eventType, message: event.message, createdAt: event.createdAt }))} empty="No recent production events." />
      </Section>
    </div>
  );
}
