// GSO Operations Agent Platform — Production Planner (pure, read-only).
//
// Orders the production queue and names the blocker for every job. It never
// writes. Inputs are plain job facts (loaders map ProductionJob rows onto
// them); outputs feed Slack reports and the staff hub.

import { evaluateTransition, normalizeStatus, statusGroup, type ProductionStatus } from "./production-transitions";

export const PRODUCTION_PLANNER_VERSION = "production-planner/1.0.0-2026-10-03";

export type PlannerJob = {
  id: string;
  jobTicket: string | null;
  customerName?: string | null;
  status: string;
  priority?: string | null;
  dueDate?: string | Date | null;
  createdAt?: string | Date | null;
  family?: string | null;
  proofStatus?: string | null;
  artApproved?: boolean;
  materialReady?: boolean | null;
  routingDecided?: boolean | null;
  machine?: "mimaki" | "roland" | null;
  outsourced?: boolean;
  qcPassRecorded?: boolean;
  previousStatus?: string | null;
};

export type Readiness = "READY" | "BLOCKED" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "ON_HOLD" | "DONE" | "CANCELLED";

export type PlannedJob = {
  id: string;
  jobTicket: string | null;
  status: ProductionStatus | null;
  group: string;
  priorityRank: number;
  dueDate: string | null;
  overdue: boolean;
  readiness: Readiness;
  blockers: string[];
  nextAction: string;
  nextStatus: ProductionStatus | null;
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, rush: 1, high: 2, normal: 3, low: 4 };

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function planJob(job: PlannerJob, now = new Date()): PlannedJob {
  const status = normalizeStatus(job.status);
  const due = iso(job.dueDate);
  const overdue = Boolean(due && new Date(due).getTime() < now.getTime() && status !== "completed" && status !== "shipped" && status !== "cancelled");
  const artApproved = job.artApproved ?? job.proofStatus === "approved";
  const base = { id: job.id, jobTicket: job.jobTicket, status, group: status ? statusGroup(status) : "unknown", priorityRank: PRIORITY_RANK[String(job.priority ?? "normal")] ?? 3, dueDate: due, overdue };
  if (!status) return { ...base, readiness: "BLOCKED", blockers: [`unknown status "${job.status}"`], nextAction: "Staff: correct the job status", nextStatus: null };
  if (status === "cancelled") return { ...base, readiness: "CANCELLED", blockers: [], nextAction: "none", nextStatus: null };
  if (status === "shipped") return { ...base, readiness: "DONE", blockers: [], nextAction: "none", nextStatus: null };
  if (status === "completed") return { ...base, readiness: "READY", blockers: [], nextAction: "Ship: record tracking, then mark shipped", nextStatus: "shipped" };
  if (status === "on_hold") return { ...base, readiness: "ON_HOLD", blockers: ["job is on hold"], nextAction: `Staff: release to ${job.previousStatus ?? "previous status"} or cancel`, nextStatus: null };
  if (status === "new" || status === "proof_sent") {
    if (!artApproved) return { ...base, readiness: "WAITING_CUSTOMER", blockers: ["art not approved"], nextAction: status === "new" ? "Prepress: send proof" : "Waiting: customer proof approval", nextStatus: status === "new" ? "proof_sent" : "proof_approved" };
    return { ...base, readiness: "READY", blockers: [], nextAction: "Record proof approval", nextStatus: "proof_approved" };
  }
  if (status === "proof_approved" || status === "reprint_needed") {
    const target: ProductionStatus = job.outsourced ? "production" : "printing";
    const verdict = evaluateTransition(status, target, { artApproved, materialReady: job.materialReady ?? undefined, routingDecided: job.routingDecided ?? undefined });
    const blockers = [...verdict.reasons];
    if (job.materialReady === false) blockers.push("material not ready");
    if (!job.outsourced && job.routingDecided === false) blockers.push("machine routing not decided");
    const unique = Array.from(new Set(blockers));
    return unique.length
      ? { ...base, readiness: "BLOCKED", blockers: unique, nextAction: `Resolve: ${unique.join("; ")}`, nextStatus: target }
      : { ...base, readiness: "READY", blockers: [], nextAction: job.outsourced ? "Release to vendor / production" : `Dispatch to ${job.machine ?? "machine"} and start printing`, nextStatus: target };
  }
  if (status === "routed" || status === "printing" || status === "cutting" || status === "production") {
    return { ...base, readiness: "IN_PROGRESS", blockers: [], nextAction: "Production: finish stage, then QC", nextStatus: "qc" };
  }
  if (status === "qc") {
    return job.qcPassRecorded
      ? { ...base, readiness: "READY", blockers: [], nextAction: "Mark completed", nextStatus: "completed" }
      : { ...base, readiness: "BLOCKED", blockers: ["QC result not recorded"], nextAction: "QC: record pass/fail", nextStatus: "completed" };
  }
  return { ...base, readiness: "BLOCKED", blockers: ["unhandled status"], nextAction: "Staff review", nextStatus: null };
}

const READINESS_ORDER: Record<Readiness, number> = { READY: 0, IN_PROGRESS: 1, BLOCKED: 2, WAITING_CUSTOMER: 3, ON_HOLD: 4, DONE: 5, CANCELLED: 6 };

export function planQueue(jobs: PlannerJob[], now = new Date()): PlannedJob[] {
  return jobs
    .map((j) => planJob(j, now))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (READINESS_ORDER[a.readiness] !== READINESS_ORDER[b.readiness]) return READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness];
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });
}

export function queueSummary(planned: PlannedJob[]) {
  const count = (r: Readiness) => planned.filter((p) => p.readiness === r).length;
  return {
    total: planned.length,
    ready: count("READY"),
    inProgress: count("IN_PROGRESS"),
    blocked: count("BLOCKED"),
    waitingCustomer: count("WAITING_CUSTOMER"),
    onHold: count("ON_HOLD"),
    done: count("DONE"),
    overdue: planned.filter((p) => p.overdue).length,
  };
}
