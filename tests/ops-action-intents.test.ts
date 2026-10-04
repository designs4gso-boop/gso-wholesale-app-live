import { describe, expect, it } from "vitest";

import { auditSummary, decideIntent, executeIntent, intentIdFor, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { MemoryActionIntentRepository } from "../app/lib/ops/memory-repositories";

const now = new Date("2026-10-04T05:00:00Z");

describe("action intent engine (async, repository-backed)", () => {
  it("propose is idempotent on the key and requires a key", async () => {
    const repo = new MemoryActionIntentRepository();
    const a = await proposeIntent(repo, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k1", now });
    const b = await proposeIntent(repo, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k1", now });
    expect(a.ok && b.ok && b.duplicate && a.intent.id === b.intent.id).toBe(true);
    expect((await repo.list()).length).toBe(1);
    expect((await proposeIntent(repo, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "  " })).ok).toBe(false);
    expect((await proposeIntent(repo, { actionType: "classify_lead", agentId: "nope", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k2" })).ok).toBe(false);
    expect(intentIdFor("abc")).toBe(intentIdFor("abc"));
    expect(intentIdFor("abc")).not.toBe(intentIdFor("abd"));
  });

  it("AUTO_INTERNAL validates to APPROVED; approval levels wait; DISABLED fails and never executes", async () => {
    const repo = new MemoryActionIntentRepository();
    const auto = await proposeIntent(repo, { actionType: "prepare_quote_prep_draft", agentId: "quote_prep", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "a", now });
    const wait = await proposeIntent(repo, { actionType: "record_qc_result", agentId: "qa_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "b", now });
    const off = await proposeIntent(repo, { actionType: "send_invoice", agentId: "invoice_coordinator", entityType: "invoice", entityId: "I1", reason: "t", idempotencyKey: "c", now });
    if (!auto.ok || !wait.ok || !off.ok) throw new Error("propose failed");
    expect((await validateIntent(repo, auto.intent.id, undefined, now)).ok).toBe(true);
    expect((await repo.getById(auto.intent.id))?.status).toBe("APPROVED");
    await validateIntent(repo, wait.intent.id, undefined, now);
    expect((await repo.getById(wait.intent.id))?.status).toBe("AWAITING_APPROVAL");
    const v = await validateIntent(repo, off.intent.id, undefined, now);
    expect(v.ok).toBe(false);
    const offRow = await repo.getById(off.intent.id);
    expect(offRow?.status).toBe("FAILED");
    expect(offRow?.error).toMatch(/DISABLED/);
    expect((await executeIntent(repo, off.intent.id, async () => ({}), { now })).ok).toBe(false);
  });

  it("approval honours roles, refuses agents/models/system, and is idempotent", async () => {
    const repo = new MemoryActionIntentRepository();
    const p = await proposeIntent(repo, { actionType: "refund_or_void", agentId: "invoice_coordinator", entityType: "invoice", entityId: "I1", reason: "t", idempotencyKey: "r", now });
    if (!p.ok) throw new Error();
    await validateIntent(repo, p.intent.id, undefined, now);
    expect((await decideIntent(repo, p.intent.id, "APPROVE", { type: "staff", id: "s", role: "staff" })).ok).toBe(false);
    expect((await decideIntent(repo, p.intent.id, "APPROVE", { type: "agent", id: "x", role: "owner" })).ok).toBe(false);
    expect((await decideIntent(repo, p.intent.id, "APPROVE", { type: "model", id: "x", role: "owner" })).ok).toBe(false);
    expect((await decideIntent(repo, p.intent.id, "APPROVE", { type: "system", id: "x", role: "owner" })).ok).toBe(false);
    expect((await decideIntent(repo, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" })).ok).toBe(true);
    const again = await decideIntent(repo, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" });
    expect(again.ok && again.duplicate).toBe(true);
    const row = await repo.getById(p.intent.id);
    expect(row?.approvedBy?.id).toBe("o");
    expect(row?.audit.map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "approved"]);
  });

  it("reject cancels; request-changes/hold keep the intent and audit it", async () => {
    const repo = new MemoryActionIntentRepository();
    const p = await proposeIntent(repo, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "s", now });
    if (!p.ok) throw new Error();
    await validateIntent(repo, p.intent.id, undefined, now);
    expect((await decideIntent(repo, p.intent.id, "HOLD", { type: "staff", id: "s", role: "staff" }, "waiting on tracking")).ok).toBe(true);
    expect((await repo.getById(p.intent.id))?.status).toBe("AWAITING_APPROVAL");
    expect((await decideIntent(repo, p.intent.id, "REQUEST_CHANGES", { type: "staff", id: "s", role: "staff" }, "wrong carrier")).ok).toBe(true);
    expect((await decideIntent(repo, p.intent.id, "RELEASE", { type: "staff", id: "s", role: "staff" })).ok).toBe(true);
    expect((await repo.getById(p.intent.id))?.status).toBe("APPROVED");
    const p2 = await proposeIntent(repo, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "J2", reason: "t", idempotencyKey: "s2", now });
    if (!p2.ok) throw new Error();
    await validateIntent(repo, p2.intent.id, undefined, now);
    expect((await decideIntent(repo, p2.intent.id, "REJECT", { type: "staff", id: "s", role: "staff" })).ok).toBe(true);
    expect((await repo.getById(p2.intent.id))?.status).toBe("CANCELLED");
    expect((await decideIntent(repo, p2.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" })).ok).toBe(false);
  });

  it("execution happens once, respects the kill switch for consequential actions, captures failures, and summaries carry no payload", async () => {
    const repo = new MemoryActionIntentRepository();
    const p = await proposeIntent(repo, { actionType: "create_review_queue_item", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "e", payload: { email: "secret@example.com" }, now });
    if (!p.ok) throw new Error();
    expect((await executeIntent(repo, p.intent.id, async () => ({}), { now })).ok).toBe(false); // not approved yet
    await validateIntent(repo, p.intent.id, undefined, now);
    let runs = 0;
    const first = await executeIntent(repo, p.intent.id, async () => { runs += 1; return { externalReference: "queue:1" }; }, { now });
    const second = await executeIntent(repo, p.intent.id, async () => { runs += 1; return {}; }, { now });
    expect(first.ok && !first.duplicate && second.ok && second.duplicate).toBe(true);
    expect(runs).toBe(1);
    const row = await repo.getById(p.intent.id);
    expect(row?.externalReference).toBe("queue:1");
    expect(JSON.stringify(auditSummary(row!))).not.toContain("secret@example.com");

    const ship = await proposeIntent(repo, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "ks", now });
    if (!ship.ok) throw new Error();
    await validateIntent(repo, ship.intent.id, undefined, now);
    await decideIntent(repo, ship.intent.id, "APPROVE", { type: "staff", id: "s", role: "staff" }, undefined, now);
    const blocked = await executeIntent(repo, ship.intent.id, async () => { runs += 1; return {}; }, { now, gate: { executionEnabled: false } });
    expect(blocked.ok).toBe(false);
    expect((blocked as any).blockedByKillSwitch).toBe(true);
    expect((await repo.getById(ship.intent.id))?.status).toBe("APPROVED");
    expect(runs).toBe(1);
    const allowed = await executeIntent(repo, ship.intent.id, async () => { runs += 1; return { externalReference: "shipped" }; }, { now, gate: { executionEnabled: true } });
    expect(allowed.ok && !allowed.duplicate).toBe(true);
    expect(runs).toBe(2);

    const f = await proposeIntent(repo, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L2", reason: "t", idempotencyKey: "f", now });
    if (!f.ok) throw new Error();
    await validateIntent(repo, f.intent.id, undefined, now);
    const failed = await executeIntent(repo, f.intent.id, async () => { throw new Error("boom"); }, { now });
    expect(failed.ok).toBe(false);
    const frow = await repo.getById(f.intent.id);
    expect(frow?.status).toBe("FAILED");
    expect(frow?.error).toBe("boom");
  });

  it("durable audit is append-only and carries every required field", async () => {
    const repo = new MemoryActionIntentRepository();
    const p = await proposeIntent(repo, { actionType: "record_qc_result", agentId: "qa_agent", entityType: "job", entityId: "J1", reason: "bench pass", idempotencyKey: "aud", payload: { result: "pass" }, provider: "openai", model: "cfg-model", now });
    if (!p.ok) throw new Error();
    await validateIntent(repo, p.intent.id, undefined, now);
    await decideIntent(repo, p.intent.id, "APPROVE", { type: "staff", id: "s", name: "Sam", role: "staff", source: "slack:U1" }, "ok", now);
    await executeIntent(repo, p.intent.id, async () => ({ externalReference: "qc:1" }), { now, gate: { executionEnabled: true } });
    const audit = await repo.listAudit(p.intent.id);
    expect(audit.map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "approved", "executing", "completed"]);
    const last = audit.at(-1)!;
    expect(last).toMatchObject({ intentId: p.intent.id, idempotencyKey: "aud", agentId: "qa_agent", provider: "openai", model: "cfg-model", entityType: "job", entityId: "J1", actionType: "record_qc_result", autonomyLevel: "APPROVAL_REQUIRED", previousStatus: "EXECUTING", newStatus: "COMPLETED", executionResult: "completed", externalReference: "qc:1", error: null, payloadKeys: ["result"] });
    expect(last.approver).toMatchObject({ type: "staff", id: "s" });
    expect(audit.every((a) => a.at && a.actor.id)).toBe(true);
    expect(repo.auditCount()).toBe(6); // nothing was rewritten
    expect(JSON.stringify(audit)).not.toMatch(/chain of thought|reasoning:/i);
  });
});
