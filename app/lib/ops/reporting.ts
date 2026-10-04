// GSO Operations Agent Platform — Sales / Production Reporting (pure).
// ERP-owned data only. Quote totals are quoted value, never cash collected.
// QuickBooks financials are DEFERRED and never claimed.

import { planQueue, queueSummary, type PlannerJob } from "./production-planner";

export const REPORTING_VERSION = "reporting/1.0.0-2026-10-03";

export type ReportQuote = { id: string; status: string; company?: string | null; customerName?: string | null; createdAt: string | Date; updatedAt?: string | Date; family?: string | null; total?: number | null };
export type ReportQueueItem = { id: string; status: string; createdAt: string | Date; productFamily?: string | null };
export type ReportPurchase = { id: string; status: string; materialName: string; priority?: string | null; neededBy?: string | Date | null };
export type ReportException = { code: string; entity: string; at: string };

function within(value: string | Date, since: Date, until: Date) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= since.getTime() && t <= until.getTime();
}

const money = (n: number) => `$${n.toFixed(2)}`;

export function salesReport(input: { quotes: ReportQuote[]; queueItems: ReportQueueItem[]; since: Date; until?: Date }): { title: string; lines: string[]; caveat: string } {
  const until = input.until ?? new Date();
  const quotes = input.quotes.filter((q) => within(q.createdAt, input.since, until));
  const byStatus = new Map<string, number>();
  for (const q of input.quotes) byStatus.set(q.status, (byStatus.get(q.status) ?? 0) + 1);
  const won = input.quotes.filter((q) => q.status === "won" && q.updatedAt && within(q.updatedAt, input.since, until));
  const wonValue = won.reduce((s, q) => s + (Number(q.total) || 0), 0);
  const leads = input.queueItems.filter((i) => within(i.createdAt, input.since, until));
  const byFamily = new Map<string, number>();
  for (const q of quotes) byFamily.set(q.family || "unknown", (byFamily.get(q.family || "unknown") ?? 0) + 1);
  const lines = [
    `New leads in queue: ${leads.length} (${input.queueItems.filter((i) => i.status === "needs_staff_review" || i.status === "new").length} awaiting staff review overall)`,
    `Quotes created: ${quotes.length}`,
    `Quotes won in period: ${won.length}, quoted value ${money(wonValue)} (quoted value, not cash collected)`,
    `Open pipeline: ${["draft", "sent"].reduce((s, k) => s + (byStatus.get(k) ?? 0), 0)} draft/sent quotes`,
    `By family (created): ${Array.from(byFamily.entries()).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ];
  return { title: `Sales report ${input.since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)}`, lines, caveat: "ERP quote data only. Not revenue, not cash. QuickBooks DEFERRED — NOT CONNECTED." };
}

export function productionReport(input: { jobs: PlannerJob[]; purchases: ReportPurchase[]; exceptions: ReportException[]; now?: Date }): { title: string; lines: string[]; caveat: string } {
  const now = input.now ?? new Date();
  const planned = planQueue(input.jobs, now);
  const s = queueSummary(planned);
  const awaitingArt = planned.filter((p) => p.readiness === "WAITING_CUSTOMER").length;
  const openPurchases = input.purchases.filter((p) => ["draft", "requested", "ordered", "partially_received"].includes(p.status));
  const urgentPurchases = openPurchases.filter((p) => p.priority === "rush" || p.priority === "critical");
  const lines = [
    `Jobs: ${s.total} total · ${s.ready} ready · ${s.inProgress} in production · ${s.blocked} blocked · ${awaitingArt} awaiting art · ${s.onHold} on hold`,
    `Overdue: ${s.overdue}${s.overdue ? ` — ${planned.filter((p) => p.overdue).map((p) => p.jobTicket ?? p.id).slice(0, 8).join(", ")}` : ""}`,
    `Blocked reasons: ${Array.from(new Set(planned.filter((p) => p.readiness === "BLOCKED").flatMap((p) => p.blockers))).slice(0, 6).join("; ") || "none"}`,
    `Purchasing: ${openPurchases.length} open requests (${urgentPurchases.length} rush/critical)`,
    `Agent exceptions (24h): ${input.exceptions.filter((e) => now.getTime() - new Date(e.at).getTime() < 86400000).length}`,
  ];
  return { title: `Production report ${now.toISOString().slice(0, 10)}`, lines, caveat: "Computed from ERP job, purchase and exception records. No job was moved." };
}
