// GSO Operations Agent Platform — Production Status agent (read-only).
// Answers "where is this job and what blocks it" from job facts. Never guesses:
// anything unknown is reported as unknown with the missing data named.

import { planJob, type PlannerJob } from "./production-planner";

export const PRODUCTION_STATUS_VERSION = "production-status/1.0.0-2026-10-03";

export type StatusAnswer = {
  version: string;
  jobTicket: string | null;
  stage: string;
  group: string;
  readiness: string;
  blockers: string[];
  nextAction: string;
  machineOrVendor: string;
  art: string;
  purchasing: string;
  shipping: string;
  dataGaps: string[];
  text: string;
};

export function describeJobStatus(job: PlannerJob & { vendor?: string | null; openPurchaseRequests?: number | null; tracking?: string | null }): StatusAnswer {
  const p = planJob(job);
  const gaps: string[] = [];
  const machineOrVendor = job.outsourced ? (job.vendor ? `vendor ${job.vendor}` : (gaps.push("vendor"), "vendor unknown")) : job.machine ? `machine ${job.machine}` : (gaps.push("machine"), "machine not yet decided");
  const art = job.artApproved ?? job.proofStatus === "approved" ? "approved on current version" : job.proofStatus ? `proof ${job.proofStatus}` : (gaps.push("proofStatus"), "unknown");
  const purchasing = job.openPurchaseRequests == null ? (gaps.push("purchase requests"), "unknown") : job.openPurchaseRequests > 0 ? `${job.openPurchaseRequests} open purchase request(s)` : "no open purchase requests";
  const shipping = p.status === "shipped" ? (job.tracking ? `shipped, tracking ${job.tracking}` : "shipped (no tracking on file)") : p.status === "completed" ? "ready to ship" : "not yet";
  const text = `${job.jobTicket ?? job.id}: ${p.status ?? "unknown status"} (${p.group}) — ${p.readiness}${p.blockers.length ? `; blocked by ${p.blockers.join(", ")}` : ""}. Next: ${p.nextAction}. ${machineOrVendor}; art ${art}; ${purchasing}; shipping ${shipping}.${gaps.length ? ` Unknown: ${gaps.join(", ")}.` : ""}`;
  return { version: PRODUCTION_STATUS_VERSION, jobTicket: job.jobTicket, stage: p.status ?? "unknown", group: p.group, readiness: p.readiness, blockers: p.blockers, nextAction: p.nextAction, machineOrVendor, art, purchasing, shipping, dataGaps: gaps, text };
}
