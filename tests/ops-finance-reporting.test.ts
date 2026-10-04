import { describe, expect, it } from "vitest";

import { ACCOUNTING_CONNECTOR_STATUS, invoiceReadiness } from "../app/lib/ops/invoice-readiness";
import { preparePurchaseOrder } from "../app/lib/ops/purchasing";
import { productionReport, salesReport } from "../app/lib/ops/reporting";

const now = new Date("2026-10-03T05:00:00Z");

describe("purchasing agent", () => {
  it("prepares a PurchaseRequest-shaped draft from known vendor cost, freight null", () => {
    const r = preparePurchaseOrder({ materialName: "4x5 blank", quantity: 400, unit: "each", neededBy: "2026-10-20" }, { vendor: "BagCo", vendorId: "v1", vendorSku: "BC", moq: 500, defaultUnitCost: 0.09, leadTimeDays: 7 }, now);
    expect(r.status).toBe("PO_READY_FOR_APPROVAL");
    expect(r.draft).toMatchObject({ status: "draft", requestedQty: 500, unitCost: 0.09, estimatedCost: 45, freight: null, priority: "normal", source: "production" });
    expect(r.warnings[0]).toMatch(/below vendor MOQ/);
    expect(r.approvalSummary).toMatch(/freight excluded/);
  });

  it("never invents cost or vendor", () => {
    expect(preparePurchaseOrder({ materialName: "ink", quantity: 1 }, { vendor: "InkCo", defaultUnitCost: 0 }, now)).toMatchObject({ status: "VENDOR_COST_REQUIRED", draft: null });
    expect(preparePurchaseOrder({ materialName: "ink", quantity: 1 }, { vendor: "InkCo", defaultUnitCost: null }, now).status).toBe("VENDOR_COST_REQUIRED");
    expect(preparePurchaseOrder({ materialName: "ink", quantity: 1 }, null, now)).toMatchObject({ status: "PURCHASING_INFO_REQUIRED", missing: ["vendor"] });
    expect(preparePurchaseOrder({ materialName: "", quantity: 0 }, { vendor: "X", defaultUnitCost: 1 }, now).missing).toEqual(["materialName", "quantity"]);
    const late = preparePurchaseOrder({ materialName: "ink", quantity: 1, neededBy: "2026-10-05" }, { vendor: "InkCo", defaultUnitCost: 2, leadTimeDays: 10 }, now);
    expect(late.draft?.priority).toBe("critical");
  });
});

describe("invoice coordinator (QuickBooks deferred)", () => {
  const quote = { id: "Q", status: "won", company: "Northwind", email: "d@example.com", items: [{ productName: "bags", quantity: 500, unitPrice: 1.25 }], depositAmount: 300 };

  it("ready only when every accounting fact is known", () => {
    const r = invoiceReadiness({ quote, jobStatus: "shipped", shippingAmount: 42, shippingKnown: true, taxKnown: true, termsKnown: true });
    expect(r.status).toBe("INVOICE_READY_FOR_APPROVAL");
    expect(r.balanceDue).toBe(367);
    expect(r.connector).toBe(ACCOUNTING_CONNECTOR_STATUS);
    expect(r.approvalSummary).toMatch(/DEFERRED — NOT CONNECTED/);
  });

  it("missing facts are listed, never invented", () => {
    const r = invoiceReadiness({ quote: { ...quote, status: "sent", email: null, items: [{ productName: "bags", quantity: 500, unitPrice: 0 }] }, jobStatus: "printing", shippingKnown: false, taxKnown: false, termsKnown: false });
    expect(r.status).toBe("ACCOUNTING_INFO_REQUIRED");
    expect(r.balanceDue).toBeNull();
    expect(r.missing.join(" | ")).toMatch(/billing email/);
    expect(r.missing.join(" | ")).toMatch(/approved selling price/);
    expect(r.missing.join(" | ")).toMatch(/shipping amount \(not invented\)/);
    expect(r.missing.join(" | ")).toMatch(/production job is printing/);
  });
});

describe("reporting", () => {
  it("sales report counts quotes/leads and never claims cash", () => {
    const r = salesReport({
      quotes: [
        { id: "1", status: "won", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", family: "sticker-bags", total: 625 },
        { id: "2", status: "sent", createdAt: "2026-10-02T00:00:00Z", family: "standard-jars" },
        { id: "3", status: "draft", createdAt: "2026-08-02T00:00:00Z" },
      ],
      queueItems: [{ id: "a", status: "needs_staff_review", createdAt: "2026-10-02T00:00:00Z" }],
      since: new Date("2026-09-26T00:00:00Z"), until: now,
    });
    expect(r.lines[0]).toMatch(/New leads in queue: 1/);
    expect(r.lines[1]).toMatch(/Quotes created: 2/);
    expect(r.lines[2]).toMatch(/won in period: 1, quoted value \$625\.00 \(quoted value, not cash collected\)/);
    expect(r.lines[3]).toMatch(/Open pipeline: 2/);
    expect(r.caveat).toMatch(/QuickBooks DEFERRED/);
  });

  it("production report summarises readiness, overdue, purchasing and exceptions", () => {
    const r = productionReport({
      jobs: [{ id: "a", jobTicket: "A", status: "printing" }, { id: "b", jobTicket: "B", status: "new", dueDate: "2026-09-01", proofStatus: "sent" }],
      purchases: [{ id: "p", status: "requested", materialName: "x", priority: "critical" }, { id: "q", status: "received", materialName: "y" }],
      exceptions: [{ code: "ART_FAILURE", entity: "j", at: now.toISOString() }, { code: "ART_FAILURE", entity: "k", at: "2026-09-01T00:00:00Z" }],
      now,
    });
    expect(r.lines[0]).toMatch(/2 total/);
    expect(r.lines[1]).toMatch(/Overdue: 1 — B/);
    expect(r.lines[3]).toMatch(/1 open requests \(1 rush\/critical\)/);
    expect(r.lines[4]).toMatch(/\(24h\): 1/);
    expect(r.caveat).toMatch(/No job was moved/);
  });
});
