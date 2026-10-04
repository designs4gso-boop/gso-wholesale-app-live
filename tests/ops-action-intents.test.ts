import { describe, expect, it } from "vitest";

import { InMemoryActionIntentStore, auditSummary, decideIntent, executeIntent, intentIdFor, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";

const now = new Date("2026-10-03T05:00:00Z");

describe("action intent engine", () => {
  it("propose is idempotent on the key and requires a key", () => {
    const store = new InMemoryActionIntentStore();
    const a = proposeIntent(store, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k1", now });
    const b = proposeIntent(store, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k1", now });
    expect(a.ok && b.ok && b.duplicate && a.intent.id === b.intent.id).toBe(true);
    expect(store.list().length).toBe(1);
    expect(proposeIntent(store, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "  " }).ok).toBe(false);
    expect(proposeIntent(store, { actionType: "classify_lead", agentId: "nope", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "k2" }).ok).toBe(false);
    expect(intentIdFor("abc")).toBe(intentIdFor("abc"));
    expect(intentIdFor("abc")).not.toBe(intentIdFor("abd"));
  });

  it("AUTO_INTERNAL validates straight to APPROVED; approval levels wait; DISABLED fails", async () => {
    const store = new InMemoryActionIntentStore();
    const auto = proposeIntent(store, { actionType: "prepare_quote_prep_draft", agentId: "quote_prep", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "a", now });
    const wait = proposeIntent(store, { actionType: "record_qc_result", agentId: "qa_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "b", now });
    const off = proposeIntent(store, { actionType: "send_invoice", agentId: "invoice_coordinator", entityType: "invoice", entityId: "I1", reason: "t", idempotencyKey: "c", now });
    if (!auto.ok || !wait.ok || !off.ok) throw new Error("propose failed");
    expect(validateIntent(store, auto.intent.id, undefined, now).ok).toBe(true);
    expect(auto.intent.status).toBe("APPROVED");
    validateIntent(store, wait.intent.id, undefined, now);
    expect(wait.intent.status).toBe("AWAITING_APPROVAL");
    const v = validateIntent(store, off.intent.id, undefined, now);
    expect(v.ok).toBe(false);
    expect(off.intent.status).toBe("FAILED");
    expect(off.intent.error).toMatch(/DISABLED/);
    const ex = await executeIntent(store, off.intent.id, async () => ({}));
    expect(ex.ok).toBe(false);
  });

  it("approval honours roles, refuses agents, and is idempotent", () => {
    const store = new InMemoryActionIntentStore();
    const p = proposeIntent(store, { actionType: "refund_or_void", agentId: "invoice_coordinator", entityType: "invoice", entityId: "I1", reason: "t", idempotencyKey: "r", now });
    if (!p.ok) throw new Error();
    validateIntent(store, p.intent.id, undefined, now);
    expect(decideIntent(store, p.intent.id, "APPROVE", { type: "staff", id: "s", role: "staff" }).ok).toBe(false);
    expect(decideIntent(store, p.intent.id, "APPROVE", { type: "agent", id: "x", role: "owner" }).ok).toBe(false);
    expect(decideIntent(store, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" }).ok).toBe(true);
    const again = decideIntent(store, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" });
    expect(again.ok && again.duplicate).toBe(true);
    expect(p.intent.approvedBy?.id).toBe("o");
    expect(p.intent.audit.map((a) => a.event)).toEqual(["proposed", "validated", "awaiting_approval", "approved"]);
  });

  it("reject cancels, request-changes/hold keep the intent and audit it", () => {
    const store = new InMemoryActionIntentStore();
    const p = proposeIntent(store, { actionType: "mark_shipped", agentId: "shipping_agent", entityType: "job", entityId: "J1", reason: "t", idempotencyKey: "s", now });
    if (!p.ok) throw new Error();
    validateIntent(store, p.intent.id, undefined, now);
    expect(decideIntent(store, p.intent.id, "HOLD", { type: "staff", id: "s", role: "staff" }, "waiting on tracking").ok).toBe(true);
    expect(p.intent.status).toBe("AWAITING_APPROVAL");
    expect(decideIntent(store, p.intent.id, "REQUEST_CHANGES", { type: "staff", id: "s", role: "staff" }, "wrong carrier").ok).toBe(true);
    expect(decideIntent(store, p.intent.id, "REJECT", { type: "staff", id: "s", role: "staff" }).ok).toBe(true);
    expect(p.intent.status).toBe("CANCELLED");
    expect(decideIntent(store, p.intent.id, "APPROVE", { type: "owner", id: "o", role: "owner" }).ok).toBe(false);
  });

  it("execution happens once, failures are captured, summaries carry no payload", async () => {
    const store = new InMemoryActionIntentStore();
    const p = proposeIntent(store, { actionType: "create_review_queue_item", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: "e", payload: { email: "secret@example.com" }, now });
    if (!p.ok) throw new Error();
    expect((await executeIntent(store, p.intent.id, async () => ({}))).ok).toBe(false); // not approved yet
    validateIntent(store, p.intent.id, undefined, now);
    let runs = 0;
    const first = await executeIntent(store, p.intent.id, async () => { runs += 1; return { externalReference: "queue:1" }; });
    const second = await executeIntent(store, p.intent.id, async () => { runs += 1; return {}; });
    expect(first.ok && !first.duplicate && second.ok && second.duplicate).toBe(true);
    expect(runs).toBe(1);
    expect(p.intent.externalReference).toBe("queue:1");
    const summary = auditSummary(p.intent);
    expect(JSON.stringify(summary)).not.toContain("secret@example.com");
    expect(summary.events.length).toBeGreaterThan(3);

    const f = proposeIntent(store, { actionType: "classify_lead", agentId: "lead_manager", entityType: "lead", entityId: "L2", reason: "t", idempotencyKey: "f", now });
    if (!f.ok) throw new Error();
    validateIntent(store, f.intent.id, undefined, now);
    const failed = await executeIntent(store, f.intent.id, async () => { throw new Error("boom"); });
    expect(failed.ok).toBe(false);
    expect(f.intent.status).toBe("FAILED");
    expect(f.intent.error).toBe("boom");
  });
});
