// GSO Operations Agent Platform — Reorder + Marketing agents (drafts only).
// Nothing is sent or published. No discounts are ever invented.

import { BLOCKED_REPLY_PATTERNS } from "./sales-intake";

export const REORDER_MARKETING_VERSION = "reorder-marketing/1.0.0-2026-10-03";

export type CompletedJobRef = { id: string; jobTicket: string | null; customerName: string | null; company: string | null; family: string | null; quantity: number | null; completedAt: string | Date; reorderedAt?: string | Date | null };

export type ReorderOpportunity = { jobId: string; jobTicket: string | null; customer: string; family: string | null; quantity: number | null; daysSince: number; draft: string; readiness: "REVALIDATE_QUOTE" };

export function reorderOpportunities(jobs: CompletedJobRef[], now = new Date(), minDays = 45, maxDays = 180): ReorderOpportunity[] {
  const out: ReorderOpportunity[] = [];
  for (const j of jobs) {
    if (j.reorderedAt) continue;
    const days = Math.floor((now.getTime() - new Date(j.completedAt).getTime()) / 86400000);
    if (!Number.isFinite(days) || days < minDays || days > maxDays) continue;
    const customer = j.company || j.customerName || "customer";
    const first = (j.customerName || "").split(" ")[0];
    const draft = `Hi${first ? ` ${first}` : ""}, it has been about ${Math.round(days / 7)} weeks since your ${j.family ? j.family.replace(/-/g, " ") : "order"}${j.jobTicket ? ` (${j.jobTicket})` : ""} shipped. If you are getting close to needing more, reply here and the team will confirm current specs and pricing before anything is set up.`;
    out.push({ jobId: j.id, jobTicket: j.jobTicket, customer, family: j.family, quantity: j.quantity, daysSince: days, draft, readiness: "REVALIDATE_QUOTE" });
  }
  return out.sort((a, b) => b.daysSince - a.daysSince);
}

export type MarketingBrief = {
  version: string;
  family: string;
  audience: string;
  goal: string;
  concept: string;
  cta: string;
  creativeNotes: string[];
  copy: null; // model not configured — copy is not generated
  approvalRequired: "owner";
  blocked: string[];
};

export function marketingBrief(input: { family: string; audience: string; goal: string }): MarketingBrief {
  return {
    version: REORDER_MARKETING_VERSION,
    family: input.family,
    audience: input.audience,
    goal: input.goal,
    concept: `Show ${input.family.replace(/-/g, " ")} on real shelves for ${input.audience}; lead with quality and turnaround honesty, not price.`,
    cta: "Request a quote",
    creativeNotes: ["Use GSO-produced product photography only", "No pricing, no discount language, no turnaround guarantees", "Canonical families only (no DTP/Box pricing claims)"],
    copy: null,
    approvalRequired: "owner",
    blocked: ["publishing", "sending", "discounts", "price claims"],
  };
}

/** Guard every draft that could reach a customer. */
export function draftIsCustomerSafe(text: string): { safe: boolean; violations: string[] } {
  const violations = BLOCKED_REPLY_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  return { safe: violations.length === 0, violations };
}
