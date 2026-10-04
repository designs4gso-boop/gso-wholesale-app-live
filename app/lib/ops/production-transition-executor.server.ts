// Prisma-backed dependencies for the production transition executor (OPS-2).
//
// NOT WIRED to any route or worker handler yet: no agent path in this release
// reaches ProductionJob. This factory exists so the first owner-approved
// enablement is a one-line registration, not a new code path.

import { decideMachine } from "../print-intake-routing.server";
import type { ActionIntent, Actor } from "./action-intents";
import type { ProductionStatus } from "./production-transitions";
import type { JobSnapshot, TransitionDeps } from "./production-transition-executor";

type DbLike = any;

export function prismaTransitionDeps(db: DbLike, shop: string): TransitionDeps {
  return {
    async loadJob(jobId) {
      const job = await db.productionJob.findFirst({ where: { shop, id: jobId }, select: { id: true, shop: true, jobTicket: true, status: true } });
      if (!job) return null;
      const lastHold = await db.productionJobEvent.findFirst({ where: { jobId, eventType: "status_change", newValue: "on_hold" }, orderBy: { createdAt: "desc" }, select: { oldValue: true } });
      return { ...job, previousStatus: lastHold?.oldValue ?? null } as JobSnapshot;
    },
    async loadFacts(job, target) {
      const row = await db.productionJob.findFirst({ where: { id: job.id }, select: { proofStatus: true, proofApprovedAt: true, checklistItems: { select: { section: true, completed: true } }, events: { where: { eventType: { in: ["qc_result", "shipped", "tracking_added"] } }, select: { eventType: true, newValue: true } } } });
      const qcPass = Boolean(row?.events?.some((e: any) => e.eventType === "qc_result" && String(e.newValue).toLowerCase() === "pass"));
      const shipping = Boolean(row?.events?.some((e: any) => e.eventType === "shipped" || e.eventType === "tracking_added"));
      return {
        artApproved: row?.proofStatus === "approved" && Boolean(row?.proofApprovedAt),
        qcPassRecorded: qcPass,
        shippingRecorded: shipping,
        materialReady: undefined,
        routingDecided: target === "printing" ? undefined : undefined,
      };
    },
    async checkRouting(job) {
      const items = await db.productionJobItem.findMany({ where: { jobId: job.id }, select: { id: true, itemTicket: true, productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true } });
      const reasons: string[] = [];
      for (const item of items) {
        const d = decideMachine({ ...item, ripJobName: null, suggestedFileName: null }, "");
        if (!d.machine) reasons.push(`${item.itemTicket ?? item.id}: ${d.reasons.join(", ")}`);
      }
      return { blocked: reasons.length > 0, reasons };
    },
    async applyTransition(job, target: ProductionStatus, intent: ActionIntent, actor: Actor) {
      await db.$transaction([
        db.productionJob.update({ where: { id: job.id }, data: { status: target, completedAt: target === "completed" ? new Date() : undefined } }),
        db.productionJobEvent.create({ data: { shop: job.shop, jobId: job.id, eventType: "status_change", message: `Status changed from ${job.status} to ${target} by agent intent ${intent.id} (${actor.type}:${actor.id}).`, oldValue: job.status, newValue: target, createdBy: `${actor.type}:${actor.id}` } }),
      ]);
      return { externalReference: `productionJob:${job.id}:${job.status}->${target}` };
    },
  };
}
