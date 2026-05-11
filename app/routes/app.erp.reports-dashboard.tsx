import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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
  const actualMargin = metrics.jobRevenue > 0 ? ((metrics.jobRevenue - metrics.jobActualCost) / metrics.jobRevenue) * 100 : 0;
  const quoteMargin = metrics.quoteRevenue > 0 ? (metrics.quoteProfit / metrics.quoteRevenue) * 100 : 0;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
        <div>
          <Link to="/app">← Dashboard</Link>
          <h1 style={{ margin: "8px 0 4px", fontSize: 26 }}>Reports Dashboard</h1>
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
