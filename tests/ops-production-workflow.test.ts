import { describe, expect, it } from "vitest";

import { planDispatch } from "../app/lib/ops/production-dispatch.server";
import { planJob, planQueue, queueSummary } from "../app/lib/ops/production-planner";
import { describeJobStatus } from "../app/lib/ops/production-status";
import { PRODUCTION_STATUSES, evaluateTransition, nextStatuses, normalizeStatus, statusGroup } from "../app/lib/ops/production-transitions";
import { assessQc } from "../app/lib/ops/qa-checklist.server";
import { shippingReadiness } from "../app/lib/ops/shipping";
import { routeException } from "../app/lib/ops/exceptions";

const now = new Date("2026-10-03T05:00:00Z");

describe("production transition guard (actual ERP statuses)", () => {
  it("covers the observed vocabulary and groups it like the ERP", () => {
    for (const s of ["new", "proof_sent", "proof_approved", "routed", "printing", "cutting", "qc", "production", "completed", "shipped", "on_hold", "reprint_needed", "cancelled"]) expect(PRODUCTION_STATUSES).toContain(s);
    expect(normalizeStatus("canceled")).toBe("cancelled");
    expect(normalizeStatus("bogus")).toBeNull();
    expect(statusGroup("printing")).toBe("printing");
    expect(statusGroup("proof_sent")).toBe("prepress");
    expect(statusGroup("shipped")).toBe("completed");
  });

  it("requires art approval to print, QC to complete, tracking to ship", () => {
    expect(evaluateTransition("new", "printing", {}).allowed).toBe(false);
    expect(evaluateTransition("proof_approved", "printing", {}).requiredFacts).toContain("artApproved");
    expect(evaluateTransition("proof_approved", "printing", { artApproved: true }).allowed).toBe(true);
    expect(evaluateTransition("proof_approved", "printing", { artApproved: true, materialReady: false }).reasons).toContain("material not ready");
    expect(evaluateTransition("qc", "completed", {}).allowed).toBe(false);
    expect(evaluateTransition("qc", "completed", { qcPassRecorded: true }).allowed).toBe(true);
    expect(evaluateTransition("completed", "shipped", {}).allowed).toBe(false);
    expect(evaluateTransition("completed", "shipped", { shippingRecorded: true }).allowed).toBe(true);
    expect(evaluateTransition("printing", "shipped", { shippingRecorded: true }).allowed).toBe(false);
    expect(evaluateTransition("shipped", "new", {}).allowed).toBe(false);
    expect(evaluateTransition("cancelled", "printing", { artApproved: true }).allowed).toBe(false);
    expect(evaluateTransition("on_hold", "printing", { previousStatus: "cutting" }).allowed).toBe(false);
    expect(evaluateTransition("on_hold", "cutting", { previousStatus: "cutting" }).allowed).toBe(true);
    expect(evaluateTransition("printing", "printing", {}).reasons).toEqual(["already in that status"]);
    expect(evaluateTransition("new", "warp", {}).reasons[0]).toMatch(/unknown status/);
    expect(nextStatuses("qc")).toEqual(["completed", "reprint_needed", "on_hold"]);
  });
});

describe("planner, dispatch, QC, shipping, status", () => {
  it("orders overdue first, then ready, in-progress, blocked; names blockers", () => {
    const planned = planQueue([
      { id: "a", jobTicket: "A", status: "printing", dueDate: "2026-10-30" },
      { id: "b", jobTicket: "B", status: "proof_approved", priority: "rush", dueDate: "2026-10-20", artApproved: true, materialReady: true, routingDecided: true, machine: "roland" },
      { id: "c", jobTicket: "C", status: "proof_approved", dueDate: "2026-10-21", artApproved: true, materialReady: false },
      { id: "d", jobTicket: "D", status: "new", dueDate: "2026-09-01", proofStatus: "sent" },
      { id: "e", jobTicket: "E", status: "shipped" },
      { id: "f", jobTicket: "F", status: "weird" },
    ], now);
    expect(planned.map((p) => p.id)).toEqual(["d", "b", "a", "c", "f", "e"]);
    expect(planned.find((p) => p.id === "c")?.blockers).toContain("material not ready");
    expect(planned.find((p) => p.id === "b")?.nextAction).toMatch(/Dispatch to roland/);
    expect(queueSummary(planned)).toMatchObject({ total: 6, ready: 1, inProgress: 1, blocked: 2, waitingCustomer: 1, done: 1, overdue: 1 });
    expect(planJob({ id: "h", jobTicket: "H", status: "on_hold", previousStatus: "printing" }).nextAction).toMatch(/release to printing/);
  });

  it("dispatch reuses the canonical decider: CMYK->Mimaki, white->Roland, contradiction->BLOCK, outsourced->vendor", () => {
    const plan = planDispatch([
      { id: "1", itemTicket: "T-01", productTitle: "matte labels", selectedFinish: "matte", materialSummary: "matte", machineSummary: null },
      { id: "2", itemTicket: "T-02", productTitle: "white labels", selectedFinish: "white", materialSummary: "white", machineSummary: null },
      { id: "3", itemTicket: "T-03", productTitle: "white labels", selectedFinish: "white", materialSummary: "white", machineSummary: "mimaki" },
      { id: "4", itemTicket: "T-04", productTitle: "dtp bags", selectedFinish: null, materialSummary: null, machineSummary: null, outsourced: true },
    ]);
    expect(plan.lines.map((l) => [l.decision, l.machineKey])).toEqual([["DISPATCH", "mimaki-ucjv300-130"], ["DISPATCH", "roland-lg-640"], ["BLOCK", null], ["OUTSOURCED", null]]);
    expect(plan.blocked).toBe(1);
  });

  it("QC needs a recorded actor; shipping needs completed+QC+packed+tracking", () => {
    expect(assessQc({ family: "sticker-bags" }).status).toBe("QC_REQUIRED");
    expect(assessQc({ family: "sticker-bags" }).requiredItems.some((i) => i.section === "qc")).toBe(true);
    expect(assessQc({ family: "standard-jars", recorded: { result: "fail", recordedBy: "Alex", recordedAt: now.toISOString() } }).status).toBe("QC_FAIL_RECORDED");
    expect(assessQc({ family: "standard-jars", recorded: { result: "pass", recordedBy: "", recordedAt: now.toISOString() } }).status).toBe("QC_REQUIRED");
    const pass = assessQc({ family: "unknown-family", checklist: [], recorded: { result: "pass", recordedBy: "Alex", recordedAt: now.toISOString() } });
    expect(pass.status).toBe("QC_PASS_RECORDED");
    expect(pass.reasons[0]).toMatch(/production steps incomplete/);
    const s = shippingReadiness({ jobTicket: "A", status: "qc", qcPassRecorded: false, packedAndLabeled: false, shipToKnown: false });
    expect(s.ready).toBe(false);
    expect(s.reasons.length).toBe(4);
    const r = shippingReadiness({ jobTicket: "A", status: "completed", qcPassRecorded: true, packedAndLabeled: true, shipToKnown: true });
    expect(r.ready && !r.canMarkShipped).toBe(true);
    expect(shippingReadiness({ jobTicket: "A", status: "completed", qcPassRecorded: true, packedAndLabeled: true, shipToKnown: true, handDelivered: true }).canMarkShipped).toBe(true);
  });

  it("status answers name unknowns instead of guessing", () => {
    const a = describeJobStatus({ id: "j", jobTicket: "GSO-1", status: "proof_approved", artApproved: true });
    expect(a.text).toMatch(/machine not yet decided/);
    expect(a.dataGaps).toEqual(expect.arrayContaining(["machine", "purchase requests"]));
    const b = describeJobStatus({ id: "j", jobTicket: "GSO-2", status: "shipped", machine: "mimaki", proofStatus: "approved", openPurchaseRequests: 0, tracking: "1Z" });
    expect(b.dataGaps).toEqual([]);
    expect(b.shipping).toMatch(/1Z/);
  });

  it("exceptions route to logical destinations with stable idempotency keys", () => {
    const e = routeException({ code: "MACHINE_MISMATCH", entity: "item:T-03", summary: "white on mimaki", now });
    expect(e).toMatchObject({ destination: "production_exceptions", severity: "high", ownerAgent: "production_dispatcher" });
    expect(e.idempotencyKey).toBe("exc:MACHINE_MISMATCH:item:T-03:2026-10-03T05");
    expect(routeException({ code: "VENDOR_COST_MISSING", entity: "m:1", summary: "", now }).destination).toBe("purchasing");
    expect(routeException({ code: "UNTRUSTED_INSTRUCTION", entity: "lead:1", summary: "", now }).destination).toBe("agent_approvals");
  });
});
