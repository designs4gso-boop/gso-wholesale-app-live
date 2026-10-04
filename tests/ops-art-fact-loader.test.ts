// Stage 4 art-approval fact safety (2026-10-04). The executor's Prisma fact
// loader derives `artApproved` from the ERP's ACTUAL recorded evidence:
//   staff "Approve proof" -> `proof_approved` event (createdAt is the only
//     timestamp; no approver id, version id, hash or proof id is stored),
//   customer portal       -> proofStatus=approved + proofApprovedAt.
// Neither signal is version-bound in the schema, so the loader additionally
// requires the approval to be at least as recent as the latest proof/artwork
// revision marker (ProductionJobFile proof/artwork rows, proof_saved events)
// and refuses when the customer has since requested changes. The legacy
// changeStatus handler emits only `status_change` and never counts.

import { describe, expect, it } from "vitest";

import { decideIntent, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { requestProductionTransition } from "../app/lib/ops/production-transition-executor";
import { prismaTransitionDeps } from "../app/lib/ops/production-transition-executor.server";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";

const T = (iso: string) => new Date(iso);
const t0 = "2026-05-11T01:04:05.659Z"; // staff approval on the real test job
const later = "2026-05-12T10:00:00.000Z";
const earlier = "2026-05-10T23:00:00.000Z";

type Row = { proofStatus: string; proofApprovedAt: Date | null; checklistItems: any[]; files: Array<{ createdAt: Date }>; events: Array<{ eventType: string; newValue: string | null; createdAt: Date }> };
const row = (over: Partial<Row>): Row => ({ proofStatus: "draft", proofApprovedAt: null, checklistItems: [], files: [], events: [], ...over });
const deps = (r: Row) => prismaTransitionDeps({ productionJob: { findFirst: async () => r } }, "shop");
const job = { id: "j", shop: "shop", jobTicket: "GSO-20260510-0004", status: "proof_approved" };
const staffApproval = (at = t0) => ({ eventType: "proof_approved", newValue: null, createdAt: T(at) });

describe("executor fact loader — art approval evidence", () => {
  it("staff approval of the current proof counts (exactly the real test job's evidence: event only, no files)", async () => {
    const facts = await deps(row({ events: [staffApproval()] })).loadFacts(job, "printing");
    expect(facts.artApproved).toBe(true);
  });

  it("legacy status-only change does NOT count", async () => {
    const facts = await deps(row({ events: [{ eventType: "status_change", newValue: "proof_approved", createdAt: T(t0) }] })).loadFacts(job, "printing");
    expect(facts.artApproved).toBe(false);
  });

  it("historical staff approval after a NEW proof revision does NOT count (A: v1 approved, B: v2 saved, C: unapproved, D: v1 event remains, E: -> printing BLOCKED)", async () => {
    const stale = row({ events: [staffApproval(t0), { eventType: "proof_saved", newValue: null, createdAt: T(later) }], files: [{ createdAt: T(later) }] });
    const facts = await deps(stale).loadFacts(job, "printing");
    expect(facts.artApproved).toBe(false);
    // and through the real executor the move is BLOCKED at the guard, nothing written
    const repos = createMemoryRepositories();
    const now = T("2026-10-04T21:00:00Z");
    const p = await proposeIntent(repos.intents, { actionType: "move_production_job", agentId: "production_planner", entityType: "job", entityId: "j", payload: { targetStatus: "printing" }, reason: "t", idempotencyKey: "stale", now });
    if (!p.ok) throw new Error();
    await validateIntent(repos.intents, p.intent.id, undefined, now);
    await decideIntent(repos.intents, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" }, undefined, now);
    let writes = 0;
    const d = { ...deps(stale), loadJob: async () => job, checkRouting: async () => ({ blocked: false, reasons: [] }), applyTransition: async () => { writes += 1; return { externalReference: "x" }; } };
    const outcome = await requestProductionTransition({ jobId: "j", targetStatus: "printing", actionIntentId: p.intent.id, actor: { type: "owner", id: "o" } }, d, repos, readOpsRuntimeConfig({ GSO_AGENT_EXECUTION_ENABLED: "true" }), now);
    expect(outcome).toMatchObject({ ok: false, stage: "guard" });
    expect((outcome as any).reasons).toContain("art not approved on current version");
    expect(writes).toBe(0);
  });

  it("a new ARTWORK file after approval also invalidates it; a non-art file (print_file) does not", async () => {
    const d = prismaTransitionDeps({ productionJob: { findFirst: async (args: any) => {
      // emulate the Prisma relation filter: only proof/artwork rows are selected by the loader's where-clause
      const where = args.select.files.where;
      const roles: string[] = where.OR[0].assetRole.in; const types: string[] = where.OR[1].fileType.in;
      const all = [{ assetRole: "printFile", fileType: "print_file", createdAt: T(later) }, { assetRole: "artwork", fileType: "artwork", createdAt: T(earlier) }];
      return row({ events: [staffApproval(t0)], files: all.filter((f) => roles.includes(f.assetRole) || types.includes(f.fileType)) });
    } } }, "shop");
    expect((await d.loadFacts(job, "printing")).artApproved).toBe(true); // print file later is irrelevant; artwork predates approval
    const d2 = prismaTransitionDeps({ productionJob: { findFirst: async () => row({ events: [staffApproval(t0)], files: [{ createdAt: T(later) }] }) } }, "shop");
    expect((await d2.loadFacts(job, "printing")).artApproved).toBe(false);
  });

  it("customer portal current approval counts; portal approval older than the latest proof file does not; changes_requested never counts", async () => {
    expect((await deps(row({ proofStatus: "approved", proofApprovedAt: T(t0) })).loadFacts(job, "printing")).artApproved).toBe(true);
    expect((await deps(row({ proofStatus: "approved", proofApprovedAt: T(t0), files: [{ createdAt: T(later) }] })).loadFacts(job, "printing")).artApproved).toBe(false);
    expect((await deps(row({ proofStatus: "approved", proofApprovedAt: T(later), files: [{ createdAt: T(t0) }] })).loadFacts(job, "printing")).artApproved).toBe(true);
    expect((await deps(row({ proofStatus: "approved", proofApprovedAt: null })).loadFacts(job, "printing")).artApproved).toBe(false);
    expect((await deps(row({ proofStatus: "changes_requested", proofApprovedAt: T(t0), events: [staffApproval(t0)] })).loadFacts(job, "printing")).artApproved).toBe(false);
  });

  it("missing approval blocks printing", async () => {
    const facts = await deps(row({})).loadFacts(job, "printing");
    expect(facts.artApproved).toBe(false);
  });
});
