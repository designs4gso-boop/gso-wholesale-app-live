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
import { presentProductionEvent } from "../lib/production-event-presenter.server";
import { assessCommercialName, cleanCommercialName } from "../lib/commercial-name-resolver.server";

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
  const topProducts = topEntries(groupBy(allQuoteItems, (item) => cleanCommercialName(item.productName) || item.productName || "Unknown"), (items) => sum(items, (item) => number(item.quantity) * number(item.unitPrice)));

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
    // 15E.3: events are presented server-side — human summaries, collapsed
    // audit detail, raw payload preserved; product/customer names display-cleaned.
    recentProductionEvents: jobs
      .flatMap((job) => (job.events || []).map((event) => presentProductionEvent({ ...event, jobTicket: job.jobTicket, customer: job.company || job.customerName || "Unknown", product: (job.items || [])[0]?.productTitle || null })))
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, 12),
    nameAudit: url.searchParams.get("nameaudit") === "1" ? await (async () => {
      // 15E.3-E: DRY RUN ONLY — read-only scan; nothing is ever written here.
      const [quoteItems, jobItems] = await Promise.all([
        db.quoteItem.findMany({ where: { quote: { shop } }, select: { id: true, productName: true, quoteId: true }, orderBy: { id: "desc" }, take: 300 }),
        db.productionJobItem.findMany({ where: { shop }, select: { id: true, productTitle: true, jobId: true, itemTicket: true }, orderBy: { createdAt: "desc" }, take: 300 }),
      ]);
      const rows: any[] = [];
      for (const item of quoteItems) {
        const assessment = assessCommercialName(item.productName);
        if (assessment.changed && assessment.confidence !== "none") rows.push({ recordType: "QuoteItem", recordId: item.id, related: item.quoteId, current: assessment.original, proposed: assessment.cleaned || "Custom Quote", reason: assessment.hadPlaceholderFragment ? "placeholder-corruption pattern" : "placeholder or cosmetic value", confidence: assessment.confidence });
      }
      for (const item of jobItems) {
        const assessment = assessCommercialName(item.productTitle);
        if (assessment.changed && assessment.confidence !== "none") rows.push({ recordType: "ProductionJobItem", recordId: item.id, related: item.itemTicket || item.jobId, current: assessment.original, proposed: assessment.cleaned || "Custom Quote", reason: assessment.hadPlaceholderFragment ? "placeholder-corruption pattern" : "placeholder or cosmetic value", confidence: assessment.confidence });
      }
      return rows.sort((a, b) => (a.confidence === "high" ? -1 : 1) - (b.confidence === "high" ? -1 : 1));
    })() : null,
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

// Display-only: readable labels for the loader's row keys, and "not recorded"
// for null/blank values so a missing field never reads as a confirmed zero.
const MINI_TABLE_LABELS: Record<string, string> = {
  name: "Material",
  unit: "Unit",
  stockOnHand: "Stock on hand",
  reorderPoint: "Reorder point",
  vendor: "Vendor",
  sku: "SKU",
  leadTimeDays: "Lead time (days)",
  jobTicket: "Job ticket",
  customer: "Customer",
  status: "Status",
  dueDate: "Due date",
  revenue: "Revenue",
  priority: "Priority",
  requestNumber: "PO request",
  materialName: "Material",
  expectedArrivalDate: "Expected arrival",
  estimatedCost: "Estimated cost",
};

const MINI_TABLE_MONEY_KEYS = new Set(["revenue", "estimatedCost"]);

function miniTableValue(key: string, value: any) {
  if (value === null || value === undefined || value === "") return "not recorded";
  if (key.toLowerCase().includes("date")) return dateOnly(value);
  if (MINI_TABLE_MONEY_KEYS.has(key)) return money(value);
  if (key === "status" || key === "priority") return String(value).replaceAll("_", " ");
  return String(value);
}

function humanizeKey(value: string) {
  return String(value || "").replaceAll("_", " ").replaceAll(/([A-Z])/g, " $1").trim() || "not set";
}

function MiniTable({ rows, empty }: { rows: any[]; empty: string }) {
  if (!rows.length) return <p style={{ color: "#666" }}>{empty}</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((row: any, index: number) => (
        <div key={row.id || row.label || index} style={{ border: "1px solid #e4e4e4", borderRadius: 10, padding: 10, background: "#fafafa" }}>
          {Object.entries(row).filter(([key]) => key !== "id").map(([key, value]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
              <strong>{MINI_TABLE_LABELS[key] || humanizeKey(key)}:</strong>
              <span style={{ color: value === null || value === undefined || value === "" ? "#888" : undefined }}>{miniTableValue(key, value)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function BarList({ rows, valueLabel = "value", empty = "Nothing recorded yet." }: { rows: { label: string; count?: number; value?: number }[]; valueLabel?: string; empty?: string }) {
  const max = Math.max(...rows.map((row) => number(row.value ?? row.count)), 1);
  if (!rows.length) return <p style={{ color: "#666" }}>{empty}</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((row) => {
        const value = number(row.value ?? row.count);
        return (
          <div key={row.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <strong>{String(row.label || "").replaceAll("_", " ") || "not set"}</strong>
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
  const rangeLabel = data.range === "all" ? "all time" : `last ${metrics.rangeDays} days`;

  // Display-only guards: a zero that comes from "nothing recorded" renders as
  // "not recorded", never as a confirmed $0 / 0%.
  const hasFinalized = Boolean(report && report.exec.finalizedJobs > 0);
  const hasQuotes = counts.quotes > 0;
  const hasJobs = counts.jobs > 0;
  const hasPrintLogs = counts.printLogRows > 0;
  const hasStockValue = metrics.materialStockValue > 0;
  const hasOpenPos = counts.openPurchaseRequests > 0;
  const NOT_RECORDED = "not recorded";

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <Link to="/app">← Dashboard</Link>
          <h1 style={{ margin: "8px 0 4px", fontSize: 26 }}>Reports Dashboard</h1>
          <p style={{ margin: 0, color: "#666" }}>Owner snapshot of sales, profitability, production, purchasing, inventory and print logs for the {rangeLabel}.</p>
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

      {report ? (
        <section style={{ border: "2px solid #b45309", borderRadius: 14, padding: 16, background: "white", marginTop: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Actual profitability (finalized jobs only)</h2>
          <p style={{ fontSize: 12, color: "#666", margin: "4px 0 10px" }}>
            Only jobs whose final costs have been locked are counted. {report.exec.openJobs} open/unfinalized job(s) are EXCLUDED because their costs are not final yet.
            {report.exec.legacyJobs ? ` ${report.exec.legacyJobs} older job(s) were finalized before snapshots existed and use stored totals only.` : ""} Nothing here changes pricing automatically.
          </p>
          {!hasFinalized ? (
            <p style={{ fontSize: 13, color: "#92400e", background: "#fffbeb", padding: 10, borderRadius: 8, margin: "0 0 10px" }}>
              No finalized jobs in this range{report.filters.rfamily || report.filters.rcustomer || report.filters.ractor || report.filters.rbelow || report.filters.rwarnings || report.filters.rreopened || report.filters.rvariance ? " with these filters" : ""}. Finalize a job's actual cost in Production to see real margin here. Totals below show "{NOT_RECORDED}" rather than zero.
            </p>
          ) : null}
          {/* 1. Executive summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <div><b>{report.exec.finalizedJobs}</b><div style={{ fontSize: 12, color: "#666" }}>Finalized jobs</div></div>
            <div><b>{hasFinalized ? money(report.exec.revenue) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Revenue</div></div>
            <div><b>{hasFinalized ? money(report.exec.actualCost) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Actual cost</div></div>
            <div><b>{hasFinalized ? money(report.exec.profit) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Profit</div></div>
            <div><b>{hasFinalized ? pct(report.exec.weightedMarginPct) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Margin (weighted by revenue)</div></div>
            <div><b>{hasFinalized ? money(report.exec.varianceDollars) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Actual cost vs estimate</div></div>
            <div><b>{hasFinalized ? report.exec.belowFloorJobs : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Jobs below family margin floor</div></div>
            <div><b>{hasFinalized ? report.exec.warningJobs : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Finalized with warnings</div></div>
            <div><b>{hasFinalized ? report.exec.reopenedJobs : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Reopened after finalizing</div></div>
            <div><b>{hasFinalized ? money(report.exec.reprintCost) : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Reprint cost</div></div>
            <div><b>{hasFinalized && report.exec.topLeakageFamily !== "none" ? report.exec.topLeakageFamily : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Lowest-margin family</div></div>
            <div><b>{hasFinalized && report.exec.topProfitFamily !== "none" ? report.exec.topProfitFamily : NOT_RECORDED}</b><div style={{ fontSize: 12, color: "#666" }}>Most profitable family</div></div>
          </div>
          {/* Filters + exports */}
          <form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12, fontSize: 12 }}>
            <input type="hidden" name="range" value={data.range} />
            <label>Product family<br /><select name="rfamily" defaultValue={report.filters.rfamily}><option value="">All</option>{["sticker-bags","standard-jars","premium-jars","stickers-labels","banners","dtp-bags","default"].map((family: string) => <option key={family} value={family}>{family}</option>)}</select></label>
            <label>Customer contains<br /><input name="rcustomer" defaultValue={report.filters.rcustomer} /></label>
            <label>Finalized by (name contains)<br /><input name="ractor" defaultValue={report.filters.ractor} /></label>
            <label>Margin below %<br /><input name="rbelow" type="number" step="1" defaultValue={report.filters.rbelow || ""} style={{ width: 90 }} /></label>
            <label><input type="checkbox" name="rwarnings" value="1" defaultChecked={report.filters.rwarnings} /> Finalized with warnings only</label>
            <label><input type="checkbox" name="rreopened" value="1" defaultChecked={report.filters.rreopened} /> Reopened only</label>
            <label>Cost vs estimate<br /><select name="rvariance" defaultValue={report.filters.rvariance}><option value="">Any</option><option value="pos">Cost over estimate</option><option value="neg">Cost under estimate</option></select></label>
            <button type="submit">Apply filters</button>
            <span style={{ color: "#666" }}>Download CSV:</span>
            {["jobs","families","products","vendors","feedback"].map((kind: string) => <a key={kind} href={`?range=${data.range}&export=${kind}`} style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8, textDecoration: "none" }}>{kind}</a>)}
          </form>
          {/* 2. Job profitability */}
          <h3 style={{ margin: "14px 0 6px", fontSize: 15 }}>Finalized jobs</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Finalized</th><th align="left">Job ticket</th><th align="left">Customer</th><th align="left">Product</th><th>Family</th><th>Qty</th><th>Est. cost</th><th>Final cost</th><th>Final profit</th><th>Final margin</th><th>Cost var ($)</th><th>Cost var (%)</th><th align="left">Finalize check</th><th align="left">Finalized by</th><th align="left">Margin flags</th></tr></thead>
              <tbody>
                {report.rows.map((row: any) => (
                  <tr key={row.jobId} style={{ borderTop: "1px solid #e5e7eb", background: (report.leakage[row.jobId] || []).length ? "#fffbeb" : undefined }}>
                    <td>{row.finalizedAt ? new Date(row.finalizedAt).toLocaleDateString() : NOT_RECORDED}{row.legacyFinal ? " (older job, stored totals)" : ""}</td>
                    <td><Link to={`/app/erp/production?job=${row.jobId}`}>{row.jobTicket}</Link></td>
                    <td>{row.customerLabel}</td>
                    <td>{row.productLabel}</td>
                    <td align="center">{row.family}</td>
                    <td align="center">{row.quantity.toLocaleString()}</td>
                    <td align="center">{row.estimatedCost > 0 ? money(row.estimatedCost) : NOT_RECORDED}</td>
                    <td align="center">{money(row.finalCost)}</td>
                    <td align="center">{money(row.finalProfit)}</td>
                    <td align="center">{pct(row.finalMarginPct)}</td>
                    <td align="center">{row.estimatedCost > 0 ? money(row.varianceDollars) : NOT_RECORDED}</td>
                    <td align="center">{row.variancePct == null ? NOT_RECORDED : pct(row.variancePct)}</td>
                    <td>{row.gateStatus}{row.finalizeReason ? ` — ${row.finalizeReason}` : ""}{row.reopenCount ? ` — reopened x${row.reopenCount}` : ""}</td>
                    <td>{row.finalizedBy}</td>
                    <td style={{ color: "#92400e" }}>{(report.leakage[row.jobId] || []).join("; ") || "none"}</td>
                  </tr>
                ))}
                {!report.rows.length ? <tr><td colSpan={15} style={{ padding: 10, color: "#666" }}>No finalized jobs in this range or filter.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {/* 3-6. Aggregates */}
          {[["By product family", report.families, ""], ["By product", report.products, ""], ["By customer", report.customers, "Grouped by email, then company, then name — treat as approximate until customer records are unified."], ["By vendor (outsourced / DTP work)", report.vendors, ""], ["By quantity band", report.bands, ""]].map(([title, rows, note]: any) => (
            <div key={title} style={{ marginTop: 14 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{title}</h3>
              {note ? <p style={{ fontSize: 11, color: "#666", margin: "0 0 6px" }}>{note}</p> : null}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Group</th><th>Jobs</th><th>Units</th><th>Revenue</th><th>Actual cost</th><th>Profit</th><th>Margin</th><th>Cost var ($)</th><th>Cost var (%)</th><th>Below floor</th><th>Warnings</th><th>Reprint ($)</th><th>Labor var ($)</th><th>Freight var ($)</th><th>Vendor var ($)</th></tr></thead>
                  <tbody>
                    {rows.map((row: any) => (
                      <tr key={row.key} style={{ borderTop: "1px solid #e5e7eb" }}>
                        <td>{row.label}</td><td align="center">{row.jobs}</td><td align="center">{row.units.toLocaleString()}</td>
                        <td align="center">{money(row.revenue)}</td><td align="center">{money(row.actualCost)}</td><td align="center">{money(row.profit)}</td>
                        <td align="center"><b>{pct(row.weightedMarginPct)}</b></td>
                        <td align="center">{row.estimatedCost > 0 ? money(row.varianceDollars) : NOT_RECORDED}</td><td align="center">{row.variancePct == null ? NOT_RECORDED : pct(row.variancePct)}</td>
                        <td align="center">{row.belowFloorJobs}</td><td align="center">{row.warningJobs}</td>
                        <td align="center">{money(row.reprintCost)}</td><td align="center">{money(row.laborVarianceDollars)}</td>
                        <td align="center">{money(row.freightVarianceDollars)}</td><td align="center">{money(row.vendorVarianceDollars)}</td>
                      </tr>
                    ))}
                    {!rows.length ? <tr><td colSpan={15} style={{ padding: 8, color: "#666" }}>No finalized jobs to group yet.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {/* 10. Pricing feedback + owner review queue */}
          <div style={{ marginTop: 14 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Pricing feedback (owner review — never automatic)</h3>
            <p style={{ fontSize: 12, color: "#666", margin: "0 0 8px" }}>A suggestion appears once 3 or more comparable finalized jobs (same family, product and quantity band) show actuals drifting from the standard; 5 or more = high confidence. Accepting only records your decision — apply the change yourself in Product Setup, Vendor Cost Book or owner standards.</p>
            {report.feedback.length ? report.feedback.map((suggestion: any) => (
              <div key={suggestion.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, marginBottom: 8, fontSize: 12, background: suggestion.decision ? "#f0fdf4" : "#fffbeb" }}>
                <b>{suggestion.message}</b> <span style={{ color: "#666" }}>({suggestion.confidence} confidence — {suggestion.jobCount} jobs, {suggestion.dateRange})</span>
                <div>Current standard: {suggestion.currentStandard} · Observed: {suggestion.actualObserved}{suggestion.variancePct != null ? ` · Variance ${Number(suggestion.variancePct).toFixed(1)}%` : ""} · Next step: {suggestion.projectedEffect}</div>
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
            )) : <p style={{ fontSize: 12, color: "#666" }}>No pricing suggestions yet. Either fewer than 3 comparable finalized jobs exist per group, or actual costs are tracking the estimates.</p>}
          </div>
        </section>
      ) : null}

      <h2 style={{ margin: "22px 0 8px", fontSize: 18 }}>Sales and pipeline ({rangeLabel})</h2>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#666" }}>From quotes created in the range. Quote margin uses the cost on each quote line, which is an estimate, not an actual.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        <MetricCard label="Quoted revenue" value={hasQuotes ? money(metrics.quoteRevenue) : NOT_RECORDED} sub={hasQuotes ? `Est. quote margin ${pct(quoteMargin)} across ${counts.quotes} quote(s)` : "No quotes created in this range"} />
        <MetricCard label="Paid / in production / completed" value={hasQuotes ? money(metrics.paidRevenue) : NOT_RECORDED} sub={hasQuotes ? `Approved, not yet paid: ${money(metrics.approvedRevenue)}` : "No quotes created in this range"} />
        <MetricCard label="Open quote value" value={hasQuotes ? money(metrics.openQuoteValue) : NOT_RECORDED} sub={hasQuotes ? "Quotes not yet paid, in production, completed or cancelled" : "No quotes created in this range"} />
        <MetricCard label="Open PO commitments" value={hasOpenPos ? money(metrics.openPoValue) : "No open POs"} sub={`${counts.openPurchaseRequests} open | ${counts.latePurchases} late | ${counts.followUpPurchases} need follow-up`} />
      </div>

      <h2 style={{ margin: "22px 0 8px", fontSize: 18 }}>Active production (estimates, not finalized)</h2>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#666" }}>All active jobs, priced from their line items. Costs here are estimates until a job is finalized; use the finalized section above for real margin.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        <MetricCard label="Active job revenue" value={hasJobs ? money(metrics.jobRevenue) : NOT_RECORDED} sub={hasJobs ? `${counts.jobs} active job(s) | est. margin ${pct(actualMargin)}` : "No active jobs"} />
        <MetricCard label="Est. profit on active jobs" value={hasJobs ? money(metrics.jobFinalProfit) : NOT_RECORDED} sub={hasJobs ? `Est. cost ${money(metrics.jobActualCost)} (actuals where recorded, otherwise estimates)` : "No active jobs"} />
        <MetricCard label="Print logs in range" value={hasPrintLogs ? `${counts.printLogRows} row(s)` : NOT_RECORDED} sub={hasPrintLogs ? `${metrics.printSqft > 0 ? `${metrics.printSqft.toFixed(2)} sqft` : `sqft ${NOT_RECORDED}`} | ${metrics.printInkMl > 0 ? `${metrics.printInkMl.toFixed(2)} ml ink` : `ink ${NOT_RECORDED}`} | ${metrics.printMinutes > 0 ? `${metrics.printMinutes.toFixed(2)} print min` : `minutes ${NOT_RECORDED}`}` : "No RIP / print logs imported for this range"} />
        <MetricCard label="Inventory value on hand" value={hasStockValue ? money(metrics.materialStockValue) : NOT_RECORDED} sub={hasStockValue ? `${counts.lowStock} of ${counts.activeMaterials} active material(s) at or below reorder point` : `${counts.activeMaterials} active material(s); no stock counts recorded`} />
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "#666" }}>
        Not reported here yet (no data source): material waste, per-machine usage, and quote-to-order conversion rate. Setup coverage: {counts.vendors} vendor(s), {counts.costBookItems} active cost book item(s), {counts.activeMaterials} active material(s).
      </p>

      <Section title="Jobs needing attention" action={<Link to="/app/erp/production-calendar">Production calendar</Link>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <MetricCard label="Overdue jobs" value={String(counts.overdueJobs)} />
          <MetricCard label="Due in the next 7 days" value={String(counts.dueThisWeek)} />
          <MetricCard label="Rush / critical" value={String(counts.rushJobs)} />
          <MetricCard label="Open jobs with no due date" value={String(counts.noDueDateJobs)} />
        </div>
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Active jobs by status">
          <BarList rows={data.statusCounts} empty="No active jobs." />
        </Section>
        <Section title="Active jobs by proof status">
          <BarList rows={data.proofCounts} empty="No active jobs." />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Quotes by status" action={<Link to="/app/quotes">Quotes</Link>}>
          <BarList rows={data.quoteStatusCounts} empty="No quotes created in this range." />
        </Section>
        <Section title="Top customers by quoted revenue">
          <BarList rows={data.topCustomers} valueLabel="money" empty="No quotes created in this range." />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Top products by quoted revenue">
          <BarList rows={data.topProducts} valueLabel="money" empty="No quote line items in this range." />
        </Section>
        <Section title="Low stock materials" action={<Link to="/app/erp/reorder-report">Reorder report</Link>}>
          <MiniTable rows={data.lowStockMaterials} empty="No materials at or below their reorder point. Materials without a reorder point are not checked." />
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Section title="Late purchase orders" action={<Link to="/app/erp/purchase-requests">PO requests</Link>}>
          <MiniTable rows={data.latePurchases} empty="No purchase orders past their expected arrival date." />
        </Section>
        <Section title="Overdue jobs">
          <MiniTable rows={data.overdueJobs} empty="No overdue jobs." />
        </Section>
      </div>

      <Section title="Rush / critical jobs">
        <MiniTable rows={data.rushJobs} empty="No rush or critical jobs." />
      </Section>

      <Section title="Recent production events">
        {/* 15E.3: human-readable summaries — raw JSON only inside collapsed audit details */}
        {data.recentProductionEvents.length ? (
          <div style={{ display: "grid", gap: 8 }}>
            {data.recentProductionEvents.map((event: any) => (
              <div key={event.id} style={{ border: "1px solid #e4e4e4", borderRadius: 10, padding: 10, background: event.legacy ? "#fafafa" : "white", fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <strong>{event.title}</strong>
                  <span style={{ color: "#666" }}>
                    {[event.jobTicket, event.customer, event.product].filter(Boolean).join(" · ")}
                    {event.timestamp ? ` · ${new Date(event.timestamp).toLocaleString()}` : ""}
                    {event.actor ? ` · ${event.actor}` : ""}
                  </span>
                </div>
                {event.summaryLines.map((line: string, index: number) => (
                  <div key={index} style={{ color: event.legacy ? "#666" : "#111", overflowWrap: "anywhere" }}>{line}</div>
                ))}
                {(event.auditSections.length || event.rawJson) ? (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12, color: "#666" }}>Show audit details</summary>
                    {event.auditSections.map((section: any) => (
                      <div key={section.title} style={{ marginTop: 6 }}>
                        <b style={{ fontSize: 12 }}>{section.title}</b>
                        {section.rows.map(([label, value]: [string, string]) => (
                          <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
                            <span style={{ color: "#666" }}>{label}</span><span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{value}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {event.rawJson ? (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: "pointer", fontSize: 12, color: "#666" }}>Raw event data</summary>
                        <pre style={{ maxHeight: 240, overflow: "auto", background: "#111827", color: "#f9fafb", padding: 8, borderRadius: 6, fontSize: 11 }}>{event.rawJson}</pre>
                      </details>
                    ) : null}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : <p style={{ color: "#666" }}>No recent production events.</p>}
      </Section>

      <Section title="Data cleanup: product name check (read-only)">
        <details open={Boolean(data.nameAudit)}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "#666" }}>Maintenance tool — finds quote and job line names that were stored as placeholders. Nothing is changed by running it.</summary>
          {data.nameAudit ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12, color: "#666", margin: "0 0 8px" }}>
                Read-only scan: nothing was changed. Rows marked high confidence match the known placeholder pattern and could be cleaned up in a future owner-approved step; the proposed value is what the app already shows on screen.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Record type</th><th align="left">Quote / ticket</th><th align="left">Stored name</th><th align="left">Shown as</th><th align="left">Reason</th><th>Confidence</th><th align="left" style={{ color: "#999" }}>Record ID</th></tr></thead>
                  <tbody>
                    {data.nameAudit.map((row: any) => (
                      <tr key={`${row.recordType}-${row.recordId}`} style={{ borderTop: "1px solid #e5e7eb", background: row.confidence === "high" ? "#fffbeb" : undefined }}>
                        <td>{row.recordType === "QuoteItem" ? "Quote line" : row.recordType === "ProductionJobItem" ? "Job line" : row.recordType}</td><td>{row.related || NOT_RECORDED}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{row.current}</td><td>{row.proposed}</td><td>{row.reason}</td>
                        <td align="center"><b>{row.confidence}</b></td>
                        <td style={{ color: "#999", fontSize: 11 }}>{row.recordId.slice(0, 10)}…</td>
                      </tr>
                    ))}
                    {!data.nameAudit.length ? <tr><td colSpan={7} style={{ padding: 8, color: "#666" }}>No placeholder names found in recent quotes and jobs.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
              <a href={`?range=${data.range}&nameaudit=1`}>Run the product name check</a> — scans the most recent 300 quote lines and 300 job lines. Read-only; stored values are never changed.
            </p>
          )}
        </details>
      </Section>
    </div>
  );
}
