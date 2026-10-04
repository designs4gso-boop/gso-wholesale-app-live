import { describe, expect, it } from "vitest";

import { AGENT_IDS, AGENT_REGISTRY, agentById, permissionFor, permissionMatrix } from "../app/lib/ops/agent-registry";
import { ACTION_AUTONOMY_CEILING, ACTION_TYPES, approverSatisfies, effectiveAutonomy, mostRestrictive } from "../app/lib/ops/autonomy";

describe("agent registry", () => {
  it("has the 21 required roles with unique ids", () => {
    expect(AGENT_REGISTRY.length).toBe(21);
    expect(new Set(AGENT_IDS).size).toBe(21);
    for (const id of ["operations_supervisor", "lead_manager", "cannabis_packaging_sales", "commercial_print_sales", "sales_intake", "quote_prep", "customer_followup", "art_preflight", "art_approval_coordinator", "purchasing_agent", "production_planner", "production_dispatcher", "qa_agent", "shipping_agent", "sales_reporting", "production_reporting", "production_status", "reorder_agent", "marketing_agent", "exception_manager", "invoice_coordinator"]) {
      expect(agentById(id)?.id).toBe(id);
    }
  });

  it("every handoff target exists and every agent declares the contract fields", () => {
    for (const a of AGENT_REGISTRY) {
      for (const t of a.handoffTargets) expect(AGENT_IDS).toContain(t);
      expect(a.purpose.length).toBeGreaterThan(10);
      expect(a.statusReason.length).toBeGreaterThan(5);
      expect(a.forbidden.length).toBeGreaterThan(0);
      expect(a.fallback.length).toBeGreaterThan(0);
      expect(a.escalation.length).toBeGreaterThan(0);
      expect(["ACTIVE", "DRAFT", "BLOCKED", "MANUAL_ONLY"]).toContain(a.status);
    }
  });

  it("no agent is ACTIVE while depending on an LLM (none is wired in the repo)", () => {
    for (const a of AGENT_REGISTRY) {
      if (/unset|not configured/.test(a.modelVersion)) expect(a.status).not.toBe("ACTIVE");
    }
  });
});

describe("autonomy ceilings and permission matrix", () => {
  it("the platform ceiling denies the dangerous actions for everyone tonight", () => {
    for (const action of ["send_purchase_order", "send_invoice", "dispatch_to_machine", "send_customer_notification", "override_canonical_blocker", "post_slack_external"] as const) {
      expect(ACTION_AUTONOMY_CEILING[action]).toBe("DISABLED");
      for (const id of AGENT_IDS) expect(permissionFor(id, action)).toBe("DENIED");
    }
  });

  it("production job mutation is APPROVAL_REQUIRED at most, never AUTO (OPS-2 owner decision)", () => {
    expect(ACTION_AUTONOMY_CEILING.move_production_job).toBe("APPROVAL_REQUIRED");
    for (const id of AGENT_IDS) expect(["APPROVAL", "DENIED"]).toContain(permissionFor(id, "move_production_job"));
    expect(permissionFor("operations_supervisor", "move_production_job")).toBe("APPROVAL");
    expect(permissionFor("production_planner", "move_production_job")).toBe("APPROVAL");
    expect(permissionFor("cannabis_packaging_sales", "move_production_job")).toBe("DENIED");
    expect(permissionFor("production_dispatcher", "dispatch_to_machine")).toBe("DENIED");
  });

  it("money actions are owner-only at most", () => {
    for (const id of AGENT_IDS) {
      expect(["OWNER", "DENIED"]).toContain(permissionFor(id, "refund_or_void"));
      expect(["OWNER", "DENIED"]).toContain(permissionFor(id, "change_cost_or_price"));
    }
    expect(permissionFor("invoice_coordinator", "refund_or_void")).toBe("OWNER");
  });

  it("an agent can never be more permissive than the ceiling", () => {
    expect(effectiveAutonomy("AUTO_INTERNAL", "move_production_job")).toBe("APPROVAL_REQUIRED"); // agent AUTO is capped to approval
    expect(effectiveAutonomy("AUTO_INTERNAL", "dispatch_to_machine")).toBe("DISABLED");
    expect(effectiveAutonomy("AUTO_INTERNAL", "record_final_art_approval")).toBe("APPROVAL_REQUIRED");
    expect(effectiveAutonomy(undefined, "read_report")).toBe("DISABLED");
    expect(mostRestrictive("AUTO_READ", "OWNER_REQUIRED")).toBe("OWNER_REQUIRED");
  });

  it("the matrix covers every agent x action and never grants AUTO on human-only actions", () => {
    const m = permissionMatrix();
    for (const id of AGENT_IDS) {
      for (const action of ACTION_TYPES) expect(["READ", "AUTO", "APPROVAL", "OWNER", "DENIED"]).toContain(m[id][action]);
      expect(m[id].record_final_art_approval).not.toBe("AUTO");
      expect(m[id].record_qc_result).not.toBe("AUTO");
      expect(m[id].mark_shipped).not.toBe("AUTO");
    }
    expect(m.art_preflight.mark_technical_preflight_passed).toBe("AUTO");
    expect(m.art_approval_coordinator.record_final_art_approval).toBe("APPROVAL");
    expect(m.lead_manager.create_review_queue_item).toBe("AUTO");
    expect(m.production_status.read_production_status).toBe("READ");
  });

  it("approver role must satisfy the level; agents never qualify", () => {
    expect(approverSatisfies("OWNER_REQUIRED", "staff")).toBe(false);
    expect(approverSatisfies("OWNER_REQUIRED", "owner")).toBe(true);
    expect(approverSatisfies("APPROVAL_REQUIRED", "staff")).toBe(true);
    expect(approverSatisfies("APPROVAL_REQUIRED", "unknown")).toBe(false);
    expect(approverSatisfies("DISABLED", "owner")).toBe(false);
  });
});
