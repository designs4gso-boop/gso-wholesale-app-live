// Phase 9 — realistic GSO flows end to end, OFFLINE: memory repositories,
// fake reasoning provider, fixture services, recording Slack sink. Pins known
// GSO rules (sticker bag MOQ 50, cutline -0.0625 in/side, CMYK -> Mimaki,
// white/gloss -> Roland, canonical families vs outsourced, never invent
// vendor cost/freight). No live Slack, no DB, no Shopify, no HTTP.

import { describe, expect, it } from "vitest";

import { decideIntent, executeIntent, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { approvalFromProofPortal, productionArtReadiness, recordApproval, registerNewVersion, type ApprovalRecord, type ArtVersion } from "../app/lib/ops/art-approval";
import { runArtPreflight } from "../app/lib/ops/art-preflight.server";
import { routeException } from "../app/lib/ops/exceptions";
import { followupDrafts } from "../app/lib/ops/followup";
import { invoiceReadiness } from "../app/lib/ops/invoice-readiness";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { planDispatch } from "../app/lib/ops/production-dispatch.server";
import { planQueue } from "../app/lib/ops/production-planner";
import { requestProductionTransition, type TransitionDeps } from "../app/lib/ops/production-transition-executor";
import { evaluateTransition } from "../app/lib/ops/production-transitions";
import { preparePurchaseOrder } from "../app/lib/ops/purchasing";
import { assessQc } from "../app/lib/ops/qa-checklist.server";
import { prepareQuote } from "../app/lib/ops/quote-prep.server";
import { reorderOpportunities, draftIsCustomerSafe } from "../app/lib/ops/reorder-marketing";
import { productionReport, salesReport } from "../app/lib/ops/reporting";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";
import { assessLead, type LeadInput } from "../app/lib/ops/sales-intake";
import { shippingReadiness } from "../app/lib/ops/shipping";
import { FakeReasoningProvider } from "../app/lib/reasoning/fake-provider";
import { createFixtureGatewayServices } from "../app/lib/reasoning/gateway-services.server";
import { runOperationsSupervisor } from "../app/lib/reasoning/operations-supervisor";
import { SPECIALIST_TOOL_ALLOWLIST } from "../app/lib/reasoning/specialists";
import { ToolGateway } from "../app/lib/reasoning/tool-gateway";
import { SLACK_ACTION_IDS, intentCard } from "../app/lib/slack/slack-blocks";
import { parseStaffMap } from "../app/lib/slack/slack-config";
import { handleSlackInteraction, parseSlackInteraction } from "../app/lib/slack/slack-interactions";

const now = new Date("2026-10-05T03:00:00Z");
const STAFF = parseStaffMap(JSON.stringify({ U_OWNER: { staffId: "owner", name: "Owner", role: "owner" }, U_STAFF: { staffId: "s1", name: "Sam", role: "staff" } }));
const click = (actionId: string, intentId: string, user: string, ts = "1.0") => ({ type: "block_actions", user: { id: user }, container: { message_ts: ts, channel_id: "C" }, actions: [{ action_id: actionId, value: intentId }] });

describe("GSO flow: sticker bag order from lead to invoice readiness", () => {
  const lead: LeadInput = { source: "website", customerName: "Dana Lee", company: "Northwind Botanicals", email: "dana@example.com", productType: "sticker bags", quantity: 500, dimensions: "4x5", material: "matte", finish: "matte", artworkReady: true, notes: "launch in three weeks" };

  it("1 new lead -> classification -> missing-info -> quote readiness", () => {
    const a = assessLead(lead, [], now);
    expect(a.classification).toMatchObject({ family: "sticker-bags", costModel: "canonical", routeTo: "cannabis_packaging_sales" });
    expect(a.missingFields).toEqual(["deadline", "shippingCityState"]);
    expect(a.reviewQueueStatus).toBe("missing_customer_info");
    expect(a.customerSafeDraftReply).toMatch(/usually start at 50 units/);
    expect(draftIsCustomerSafe(a.customerSafeDraftReply).safe).toBe(true);
    expect(prepareQuote(lead, { now }).status).toBe("NEEDS_INFO");
    const complete = { ...lead, deadline: "2026-10-26", shippingCityState: "Portland, OR" };
    expect(prepareQuote(complete, { now }).status).toBe("READY_FOR_STAFF_QUOTE");
    expect(prepareQuote({ ...complete, quantity: 49 }, { now }).staffReviewTriggers.join()).toMatch(/MOQ \(50\)/);
    expect(prepareQuote({ ...complete, productFamily: "dtp-bags" }, { now }).status).toBe("OUTSOURCED_REVIEW");
    expect(JSON.stringify(prepareQuote(complete, { now }))).not.toMatch(/\$\d/);
  });

  it("2 supervisor (fake reasoning) hands off and returns a safe draft; tools stay read/proposal only", async () => {
    const repos = createMemoryRepositories();
    const gateway = new ToolGateway({ intents: repos.intents, services: createFixtureGatewayServices({ leads: { L1: { ...lead, deadline: "2026-10-26", shippingCityState: "Portland, OR" } }, jobs: {}, customers: {}, art: {}, canonicalBlockers: {} }), now: () => now }, SPECIALIST_TOOL_ALLOWLIST);
    const fake = new FakeReasoningProvider([{ kind: "handoff", to: "cannabis_packaging_sales", reason: "packaging" }, { kind: "classify", toolCalls: [{ toolName: "getProductRules", args: { family: "sticker-bags" } }, { toolName: "getQuoteReadiness", args: { leadId: "L1" } }], output: { draft: "Thanks Dana — 500 4x5 matte sticker bags noted; minimums usually start at 50 units; the team will review specs and follow up.", tone: "friendly", containsPricing: false, containsPromises: false, reason: "confirmed" } }]);
    const config = { ...readOpsRuntimeConfig({}), reasoningEnabled: true, provider: "openai" as const, reasoningBlockers: [], openai: { apiKeyPresent: true, model: "fake", tracingEnabled: false, traceIncludeSensitiveData: false } };
    const out = await runOperationsSupervisor({ requestId: "r", requester: { type: "staff", id: "s1" }, text: "Dana wants 500 sticker bags", facts: { leadId: "L1" }, lead }, { provider: fake, gateway, repos, config, now: () => now });
    expect(out).toMatchObject({ status: "completed", specialistKey: "cannabis_packaging_sales" });
    expect(out.toolCalls.map((t) => t.toolName)).toEqual(["getProductRules", "getQuoteReadiness"]);
    expect((await repos.intents.list()).length).toBe(0); // read tools create nothing
  });

  it("3 art preflight -> revision invalidation -> proof approval -> production readiness", () => {
    const v1: ArtVersion = { versionId: "v1", fileHash: "h1", fileName: "northwind.pdf", createdAt: now.toISOString() };
    const pre = runArtPreflight({ family: "sticker-bags", widthIn: 4, heightIn: 5, cutType: "rectangular" }, [{ fileName: v1.fileName, artboardWidthIn: 4, artboardHeightIn: 5, colorSpace: "CMYK", minRasterDpi: 300, hasCutlineLayer: true, fontsOutlined: true }]);
    expect(pre.status).toBe("PASS");
    expect(pre.expectedCutline).toBe("3.875 x 4.875 in"); // -0.0625 in per side
    let records: ApprovalRecord[] = [];
    const t = recordApproval(records, { version: v1, state: "TECHNICAL_PREFLIGHT_PASSED", approverType: "agent", approverId: "art_preflight", source: "agent", now }); if (t.ok) records = t.records;
    const c = recordApproval(records, approvalFromProofPortal({ proofStatus: "approved", proofApprovedAt: now, proofCustomerEmail: "dana@example.com" }, v1)!); if (c.ok) records = c.records;
    const f = recordApproval(records, { version: v1, state: "FINAL_ART_APPROVED", approverType: "staff", approverId: "s1", source: "erp", now }); if (f.ok) records = f.records;
    expect(productionArtReadiness(records, v1).ready).toBe(true);
    const v2: ArtVersion = { ...v1, versionId: "v2", fileHash: "h2" };
    const inv = registerNewVersion(records, v2, now);
    expect(inv.invalidated).toBe(3);
    expect(productionArtReadiness(inv.records, v2).ready).toBe(false);
    expect(evaluateTransition("proof_approved", "printing", { artApproved: false }).allowed).toBe(false);
  });

  it("4 planning -> machine routing -> production approval intent -> Slack approval -> guarded transition -> QC -> shipping", async () => {
    const jobs = [
      { id: "j1", jobTicket: "GSO-A", status: "proof_approved", priority: "rush", dueDate: "2026-10-20", artApproved: true, materialReady: true, routingDecided: true, machine: "mimaki" as const },
      { id: "j2", jobTicket: "GSO-B", status: "new", dueDate: "2026-09-01", proofStatus: "sent" },
    ];
    expect(planQueue(jobs, now).map((p) => p.id)).toEqual(["j2", "j1"]); // overdue first
    const dispatch = planDispatch([
      { id: "i1", itemTicket: "GSO-A-01", productTitle: "matte", selectedFinish: "matte", materialSummary: "matte", machineSummary: null },
      { id: "i2", itemTicket: "GSO-A-02", productTitle: "white", selectedFinish: "white", materialSummary: "white", machineSummary: null },
      { id: "i3", itemTicket: "GSO-A-03", productTitle: "white on mimaki", selectedFinish: "white", materialSummary: "white", machineSummary: "mimaki" },
    ]);
    expect(dispatch.lines.map((l) => [l.decision, l.machine])).toEqual([["DISPATCH", "mimaki"], ["DISPATCH", "roland"], ["BLOCK", null]]);

    const repos = createMemoryRepositories();
    const p = await proposeIntent(repos.intents, { actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "j1", payload: { targetStatus: "printing" }, reason: "ready", idempotencyKey: "j1:printing", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    const awaiting = (await repos.intents.getById(p.intent.id))!;
    expect(awaiting.status).toBe("AWAITING_APPROVAL");
    const card = intentCard({ title: "Move GSO-A -> printing", intent: awaiting, facts: [], destination: "production", sandboxRedirected: true });
    expect(card.some((b) => b.type === "actions")).toBe(true);
    const parsed = parseSlackInteraction(click(SLACK_ACTION_IDS.approve, p.intent.id, "U_STAFF"));
    if (!parsed.ok) throw new Error();
    expect(await handleSlackInteraction(repos, parsed.interaction, { envStaffMap: STAFF, now })).toMatchObject({ ok: true, kind: "decision", status: "APPROVED" });
    expect(await handleSlackInteraction(repos, parsed.interaction, { envStaffMap: STAFF, now })).toMatchObject({ ok: true, kind: "replay" });

    const erp = { status: "proof_approved", writes: 0 };
    const deps: TransitionDeps = { loadJob: async () => ({ id: "j1", shop: "s", jobTicket: "GSO-A", status: erp.status }), loadFacts: async () => ({ artApproved: true, materialReady: true, routingDecided: true }), checkRouting: async () => ({ blocked: false, reasons: [] }), applyTransition: async (_j, t) => { erp.status = t; erp.writes += 1; return { externalReference: `job:j1:${t}` }; } };
    const off = await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: p.intent.id, actor: { type: "owner", id: "o" } }, deps, repos, readOpsRuntimeConfig({}), now);
    expect(off).toMatchObject({ ok: false, stage: "kill_switch" });
    const on = await requestProductionTransition({ jobId: "j1", targetStatus: "printing", actionIntentId: p.intent.id, actor: { type: "owner", id: "o" } }, deps, repos, readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" }), now);
    expect(on).toMatchObject({ ok: true, duplicate: false, to: "printing" });
    expect(erp.writes).toBe(1);

    expect(assessQc({ family: "sticker-bags", recorded: { result: "pass", recordedBy: "QC Bench", recordedAt: now.toISOString() } }).status).toBe("QC_PASS_RECORDED");
    expect(evaluateTransition("qc", "completed", { qcPassRecorded: false }).allowed).toBe(false);
    expect(shippingReadiness({ jobTicket: "GSO-A", status: "completed", qcPassRecorded: true, packedAndLabeled: true, shipToKnown: true, tracking: "1Z" }).canMarkShipped).toBe(true);
    expect(shippingReadiness({ jobTicket: "GSO-A", status: "completed", qcPassRecorded: true, packedAndLabeled: true, shipToKnown: true }).canMarkShipped).toBe(false);
  });

  it("5 purchasing -> vendor cost missing blocker -> invoice readiness -> follow-up -> reorder -> exceptions -> reports", () => {
    expect(preparePurchaseOrder({ materialName: "4x5 blank", quantity: 520, unit: "each" }, { vendor: "BagCo", moq: 500, defaultUnitCost: 0.11, leadTimeDays: 7 }, now)).toMatchObject({ status: "PO_READY_FOR_APPROVAL" });
    const missing = preparePurchaseOrder({ materialName: "roland white ink", quantity: 1, unit: "cart" }, { vendor: "InkCo", defaultUnitCost: null }, now);
    expect(missing).toMatchObject({ status: "VENDOR_COST_REQUIRED", draft: null });
    expect(routeException({ code: "VENDOR_COST_MISSING", entity: "material:white-ink", summary: missing.approvalSummary, now }).destination).toBe("purchasing");
    const inv = invoiceReadiness({ quote: { id: "Q", status: "won", company: "Northwind", email: "d@example.com", items: [{ productName: "bags", quantity: 500, unitPrice: 1.25 }], depositAmount: 300 }, jobStatus: "shipped", shippingAmount: 42, shippingKnown: true, taxKnown: true, termsKnown: true });
    expect(inv).toMatchObject({ status: "INVOICE_READY_FOR_APPROVAL", balanceDue: 367 });
    expect(inv.connector).toMatch(/DEFERRED/);
    const fu = followupDrafts([{ id: "L1", kind: "lead", status: "missing_customer_info", customerName: "Dana", lastContactAt: "2026-10-01T00:00:00Z", missingFields: ["deadline"] }], now);
    expect(fu.length).toBe(1);
    expect(fu[0].sendBy).toBe("staff");
    const re = reorderOpportunities([{ id: "j", jobTicket: "GSO-A", customerName: "Dana Lee", company: "Northwind", family: "sticker-bags", quantity: 500, completedAt: "2026-08-01T00:00:00Z" }], now);
    expect(re.length).toBe(1);
    expect(draftIsCustomerSafe(re[0].draft).safe).toBe(true);
    const sales = salesReport({ quotes: [{ id: "Q", status: "won", createdAt: now, updatedAt: now, family: "sticker-bags", total: 625 }], queueItems: [], since: new Date(now.getTime() - 7 * 86400000), until: now });
    expect(sales.lines.join()).toMatch(/not cash collected/);
    const prod = productionReport({ jobs: [{ id: "j2", jobTicket: "GSO-B", status: "new", dueDate: "2026-09-01", proofStatus: "sent" }], purchases: [], exceptions: [], now });
    expect(prod.lines[1]).toMatch(/Overdue: 1/);
  });

  it("6 execution kill switch holds approved consequential intents without losing them", async () => {
    const repos = createMemoryRepositories();
    const p = await proposeIntent(repos.intents, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "j1", reason: "t", idempotencyKey: "ship", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await decideIntent(repos.intents, p.intent.id, "APPROVE", { type: "staff", id: "s1", role: "staff" }, undefined, now);
    const blocked = await executeIntent(repos.intents, p.intent.id, async () => { throw new Error("must not run"); }, { now, gate: { executionEnabled: false } });
    expect(blocked.ok).toBe(false);
    expect((await repos.intents.getById(p.intent.id))?.status).toBe("APPROVED");
  });
});
