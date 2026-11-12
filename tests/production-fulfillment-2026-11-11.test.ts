// 2026-11-11 OWNER DECISION — production completion, shipment / pickup, QC, reprint reasons.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_REQUIRES_FULFILLMENT,
  FULFILLMENT_RECORD_REQUIRED,
  REPRINT_REASONS,
  fulfillmentQcGuardApplies,
  isReprintReason,
  parsePickupInput,
  parseShipmentInput,
  shipmentSummary,
  statusChangeFulfillmentVerdict,
} from "../app/lib/production-fulfillment";
import { isStaffProductionStatus } from "../app/lib/production-status-vocabulary";

describe("Completed only after Shipped or Picked Up", () => {
  it("a status change to completed is refused unless the job is shipped / picked_up", () => {
    for (const from of ["new", "printing", "qc", "packing", "ready_for_pickup", "on_hold"]) {
      const v = statusChangeFulfillmentVerdict(from, "completed");
      expect(v.ok, from).toBe(false);
      if (!v.ok) expect(v.message).toContain(COMPLETION_REQUIRES_FULFILLMENT);
    }
    expect(statusChangeFulfillmentVerdict("shipped", "completed").ok).toBe(true);
    expect(statusChangeFulfillmentVerdict("picked_up", "completed").ok).toBe(true);
    expect(statusChangeFulfillmentVerdict("completed", "completed").ok).toBe(true); // historical completed jobs are never re-checked
  });

  it("shipped / picked_up can only be set through the shipment / pickup record", () => {
    for (const to of ["shipped", "picked_up"]) {
      const v = statusChangeFulfillmentVerdict("packing", to);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain(FULFILLMENT_RECORD_REQUIRED);
    }
    expect(statusChangeFulfillmentVerdict("printing", "qc").ok).toBe(true); // ordinary moves unaffected
    expect(isStaffProductionStatus("picked_up")).toBe(true);
  });

  it("QC PASS is required when a job enters shipped / picked_up", () => {
    expect(fulfillmentQcGuardApplies("packing", "shipped")).toBe(true);
    expect(fulfillmentQcGuardApplies("ready_for_pickup", "picked_up")).toBe(true);
    expect(fulfillmentQcGuardApplies("completed", "shipped")).toBe(false); // legacy completed->shipped, already QC-gated at completion
  });

  it("both Production board and calendar enforce it on the server", () => {
    for (const file of ["app/routes/app.erp.production.tsx", "app/routes/app.erp.production-calendar.tsx"]) {
      expect(readFileSync(file, "utf8"), file).toContain("const fulfillment = statusChangeFulfillmentVerdict(job.status, status);");
    }
  });
});

describe("shipment / pickup records", () => {
  it("captures carrier, tracking, packages, ship date and the ENTERED cost (never invented)", () => {
    const ok = parseShipmentInput({ carrier: "UPS", trackingNumber: "1Z999", packageCount: "2", shipDate: "2026-11-12", actualShippingCost: "$18.40" });
    expect(ok).toEqual({ ok: true, record: { carrier: "UPS", trackingNumber: "1Z999", packageCount: 2, shipDate: "2026-11-12", actualShippingCost: 18.4 } });
    const noCost = parseShipmentInput({ carrier: "FedEx", packageCount: "1", shipDate: "2026-11-12" });
    expect(noCost.ok && noCost.record.actualShippingCost).toBeNull();
    if (noCost.ok) expect(shipmentSummary(noCost.record)).toContain("shipping cost not entered");
    for (const bad of [{ packageCount: "1", shipDate: "2026-11-12" }, { carrier: "UPS", packageCount: "0", shipDate: "2026-11-12" }, { carrier: "UPS", packageCount: "1", shipDate: "" }, { carrier: "UPS", packageCount: "1", shipDate: "2026-11-12", actualShippingCost: "-5" }]) {
      expect(parseShipmentInput(bad as any).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("pickup records the time (now by default) and who picked up", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    expect(parsePickupInput({ pickedUpBy: "Customer A" }, now)).toEqual({ ok: true, record: { pickedUpAt: now.toISOString(), pickedUpBy: "Customer A", note: null } });
    expect(parsePickupInput({ pickedUpAt: "not a date" }).ok).toBe(false);
  });

  it("the board writes shipped / tracking_added / picked_up events and needs the recordShipment permission", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain('await createEvent(shop, jobId, "shipped", shipmentSummary(record)');
    expect(board).toContain('await createEvent(shop, jobId, "tracking_added"');
    expect(board).toContain('await createEvent(shop, jobId, "picked_up"');
    expect(board).toContain('recordShipment: "recordShipment", recordPickup: "recordShipment"');
    expect(board).toContain("record.actualShippingCost != null && !job.actualCostFinalized");
  });
});

describe("QC / reprint accountability", () => {
  it("reprint reasons are exactly the owner's categories, validated on the server", () => {
    expect(REPRINT_REASONS.map((r) => r.label)).toEqual(["Machine error", "Operator error", "Artwork / prepress error", "Customer change / error", "Material defect", "Color / quality issue", "Shipping damage", "Other"]);
    expect(isReprintReason("machine_error")).toBe(true);
    expect(isReprintReason("print defect")).toBe(false);
    expect(isReprintReason("")).toBe(false);
  });

  it("QC / reprint need the role permission; manual printer choice needs selectPrinter", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain('qcItem: "recordQc", reprintItem: "recordReprint"');
    expect(board).toContain('staffAccess.can("selectPrinter") ? String(formData.get("printer") || "auto") : "auto"');
  });
});
