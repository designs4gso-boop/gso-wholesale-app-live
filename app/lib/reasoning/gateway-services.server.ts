// Deterministic READ services behind the Tool Gateway (OPS-2, Phase 11/13).
//
// Every answer is SHAPED minimum context computed by GSO's own deterministic
// modules — never a raw database row, never a secret, never a price. The
// fixture factory serves tests and the simulator; a Prisma-backed factory
// would map ERP rows onto the same fixture shapes (not wired in this release).

import { permissionMatrix } from "../ops/agent-registry";
import { productionArtReadiness, type ApprovalRecord, type ArtVersion } from "../ops/art-approval";
import type { PreflightResult } from "../ops/art-preflight.server";
import { describeJobStatus } from "../ops/production-status";
import type { PlannerJob } from "../ops/production-planner";
import { prepareQuote } from "../ops/quote-prep.server";
import { assessLead, type LeadInput } from "../ops/sales-intake";
import { shippingReadiness } from "../ops/shipping";
import { familyCostModel } from "../canonical-quote-authority.server";
import { productFamilySalesRuleFor } from "../product-family-sales-rules";
import type { GatewayReadServices } from "./tool-gateway";

export type GatewayFixtures = {
  leads: Record<string, LeadInput>;
  jobs: Record<string, PlannerJob & { vendor?: string | null; openPurchaseRequests?: number | null; tracking?: string | null; customerId?: string | null; packedAndLabeled?: boolean; shipToKnown?: boolean }>;
  customers: Record<string, { displayName: string; company: string | null; openQuotes: number; openJobs: number }>;
  art: Record<string, { version: ArtVersion; records: ApprovalRecord[]; preflight: PreflightResult | null }>;
  /** Canonical blockers per family (e.g. missing calibration) — simulated here, real check in the calculator. */
  canonicalBlockers: Record<string, string[]>;
};

const notFound = (what: string, id: string) => ({ found: false, error: `${what} ${id} not found` });

export function createFixtureGatewayServices(fx: GatewayFixtures): GatewayReadServices {
  return {
    async getProductRules({ family }) {
      const rule = productFamilySalesRuleFor(family);
      return { family: rule.key, label: rule.label, officialMoq: rule.officialMoq, costModel: familyCostModel(family), quotePrepAllowed: rule.quotePrepAllowed, agentFirmPricingAllowed: rule.agentFirmPricingAllowed, customerSafeSummary: rule.customerSafeSummary, salesRules: rule.salesRules };
    },
    async getQuoteReadiness({ leadId }) {
      const lead = fx.leads[leadId]; if (!lead) return notFound("lead", leadId);
      const r = prepareQuote(lead, { canonicalCheck: fx.canonicalBlockers[assessLead(lead).classification.family ?? ""]?.length ? { usable: false, reason: fx.canonicalBlockers[assessLead(lead).classification.family ?? ""].join("; ") } : null });
      return { found: true, status: r.status, family: r.family, costModel: r.costModel, missingFields: r.missingFields, staffReviewTriggers: r.staffReviewTriggers, canonicalBlocker: r.canonicalBlocker, handoffNote: r.handoffNote };
    },
    async getCanonicalCostStatus({ family, quantity }) {
      const model = familyCostModel(family);
      const rule = productFamilySalesRuleFor(family);
      const blockers = [...(fx.canonicalBlockers[family] ?? [])];
      if (rule.officialMoq && quantity < rule.officialMoq) blockers.push(`below MOQ ${rule.officialMoq}`);
      return { family, quantity, costModel: model, costable: model === "CANONICAL_COST_AUTHORITY" && blockers.length === 0, blockers, note: "no price is ever returned by this tool; staff build quotes in the Cost Calculator" };
    },
    async getCustomerSummary({ customerId }) {
      const c = fx.customers[customerId]; if (!c) return notFound("customer", customerId);
      return { found: true, displayName: c.displayName, company: c.company, openQuotes: c.openQuotes, openJobs: c.openJobs };
    },
    async getLeadStatus({ leadId }) {
      const lead = fx.leads[leadId]; if (!lead) return notFound("lead", leadId);
      const a = assessLead(lead);
      return { found: true, family: a.classification.family, routeTo: a.classification.routeTo, missingFields: a.missingFields, escalations: a.escalations, reviewQueueStatus: a.reviewQueueStatus, reviewLevel: a.reviewLevel, duplicate: a.duplicate.duplicate };
    },
    async getArtStatus({ jobId }) {
      const art = fx.art[jobId]; if (!art) return notFound("art for job", jobId);
      const ready = productionArtReadiness(art.records, art.version);
      return { found: true, versionId: art.version.versionId, preflight: art.preflight?.status ?? "not run", findings: art.preflight?.findings.map((f) => `${f.severity}:${f.code}`) ?? [], states: ready.states, productionReady: ready.ready, missing: ready.reasons };
    },
    async getProductionStatus({ jobId }) {
      const job = fx.jobs[jobId]; if (!job) return notFound("job", jobId);
      const s = describeJobStatus(job);
      return { found: true, jobTicket: s.jobTicket, stage: s.stage, group: s.group, readiness: s.readiness, blockers: s.blockers, nextAction: s.nextAction, machineOrVendor: s.machineOrVendor, dataGaps: s.dataGaps };
    },
    async getPurchasingStatus({ jobId }) {
      const job = fx.jobs[jobId]; if (!job) return notFound("job", jobId);
      return { found: true, openPurchaseRequests: job.openPurchaseRequests ?? null, materialReady: job.materialReady ?? null };
    },
    async getShippingStatus({ jobId }) {
      const job = fx.jobs[jobId]; if (!job) return notFound("job", jobId);
      const r = shippingReadiness({ jobTicket: job.jobTicket, status: job.status, qcPassRecorded: Boolean(job.qcPassRecorded), packedAndLabeled: Boolean(job.packedAndLabeled), shipToKnown: Boolean(job.shipToKnown), tracking: job.tracking ?? null });
      return { found: true, ready: r.ready, canMarkShipped: r.canMarkShipped, reasons: r.reasons };
    },
    async getAgentCapabilities({ agentId }) {
      const row = (permissionMatrix() as Record<string, Record<string, string>>)[agentId];
      if (!row) return notFound("agent", agentId);
      return { found: true, agentId, permissions: row };
    },
  };
}
