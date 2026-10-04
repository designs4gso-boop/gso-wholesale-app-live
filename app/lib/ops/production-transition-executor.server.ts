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
      const row = await db.productionJob.findFirst({
        where: { id: job.id },
        select: {
          proofStatus: true,
          proofApprovedAt: true,
          checklistItems: { select: { section: true, completed: true } },
          // Revision markers: every proof/artwork asset row. (Print files, RIP
          // outputs and reference images are not art revisions.)
          files: { where: { OR: [{ assetRole: { in: ["artwork", "proof"] } }, { fileType: { in: ["artwork", "proof", "customer_pdf", "dieline"] } }] }, select: { createdAt: true } },
          events: { where: { eventType: { in: ["qc_result", "shipped", "tracking_added", "proof_approved", "proof_saved"] } }, select: { eventType: true, newValue: true, createdAt: true } },
        },
      });
      const qcPass = Boolean(row?.events?.some((e: any) => e.eventType === "qc_result" && String(e.newValue).toLowerCase() === "pass"));
      const shipping = Boolean(row?.events?.some((e: any) => e.eventType === "shipped" || e.eventType === "tracking_added"));
      // Art approval evidence the ERP actually records (Stage 4 audit, 2026-10-04):
      //   (a) customer proof portal: proofStatus=approved + proofApprovedAt;
      //   (b) staff "Approve proof" action: a `proof_approved` event (sole
      //       emitter: app.erp.production.$id.proof.tsx approveProof).
      // Neither signal is bound to a proof/art version in the schema, so an
      // approval counts ONLY if it is at least as recent as the latest
      // proof/artwork revision marker (proof/artwork file rows, proof_saved
      // events) and the customer has not since requested changes. The legacy
      // changeStatus handler emits only `status_change` and never counts.
      const ms = (d: any) => (d ? new Date(d).getTime() : null);
      const latestRevisionAt = Math.max(
        -Infinity,
        ...((row?.files ?? []).map((f: any) => ms(f.createdAt) ?? -Infinity) as number[]),
        ...((row?.events ?? []).filter((e: any) => e.eventType === "proof_saved").map((e: any) => ms(e.createdAt) ?? -Infinity) as number[]),
      );
      const staffApprovalAt = Math.max(-Infinity, ...((row?.events ?? []).filter((e: any) => e.eventType === "proof_approved").map((e: any) => ms(e.createdAt) ?? -Infinity) as number[]));
      const portalApprovalAt = row?.proofStatus === "approved" && row?.proofApprovedAt ? (ms(row.proofApprovedAt) as number) : -Infinity;
      const approvalAt = Math.max(staffApprovalAt, portalApprovalAt);
      const artApproved = Number.isFinite(approvalAt) && row?.proofStatus !== "changes_requested" && (!Number.isFinite(latestRevisionAt) || approvalAt >= latestRevisionAt);
      return {
        artApproved,
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
