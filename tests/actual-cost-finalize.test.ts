import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  REOPEN_PHRASE,
  assessFinalization,
  buildActualCostFinalizeSnapshot,
  computeEstimateVariance,
  computeFinalActualCost,
  estimateExpectations,
  normalizeDtpOutsource,
  numberOrNull,
  resolveActorFromSession,
} from "../app/lib/actual-cost-finalize.server";

const SOURCES_RECORDED = {
  printLogRecordedCost: 120, previewPrintCost: 95, materialCost: 60, materialRowCount: 1,
  deductedQty: 100, usedQty: 90, wasteQty: 8, reprintQty: 2, pulledQty: 100,
};
const SOURCES_EMPTY = { printLogRecordedCost: 0, previewPrintCost: 0, materialCost: 0, materialRowCount: 0, deductedQty: 0, usedQty: 0, wasteQty: 0, reprintQty: 0, pulledQty: 0 };
const NO_INPUTS = {
  laborMinutes: null, laborRate: null, laborCostOverride: null, laborZeroConfirmed: false,
  packingCost: null, shippingCost: null, outsourceCost: null, reprintCost: null, otherCost: null,
  dtp: null, warningReason: "",
};
const ESTIMATE = { estimatedTotalCost: 200, hadMaterialLines: true, hadPrintLines: true };

describe("formulas (15E.1-B)", () => {
  it("components sum ONCE: recorded print beats preview (never both); labor override replaces minutes x rate", () => {
    const result = computeFinalActualCost({
      revenue: 1000,
      sources: SOURCES_RECORDED,
      inputs: { ...NO_INPUTS, laborMinutes: 120, laborRate: 20, laborCostOverride: 55, packingCost: 10 },
    });
    expect(result.components.printCost).toBe(120); // recorded wins
    expect(result.components.printCostSource).toBe("recorded");
    expect(result.components.laborCost).toBe(55); // override REPLACES 120min x $20 = $40… never 95
    expect(result.totalCost).toBeCloseTo(120 + 60 + 55 + 10, 6);
    expect(result.grossProfit).toBeCloseTo(1000 - 245, 6);
    expect(result.grossMarginPct).toBeCloseTo(((1000 - 245) / 1000) * 100, 6);
    const minutesOnly = computeFinalActualCost({ revenue: 1000, sources: SOURCES_RECORDED, inputs: { ...NO_INPUTS, laborMinutes: 120, laborRate: 20 } });
    expect(minutesOnly.components.laborCost).toBeCloseTo(40, 6);
  });

  it("preview print cost is used only when nothing is recorded; blank fields stay null (never authoritative $0)", () => {
    const preview = computeFinalActualCost({ revenue: 500, sources: { ...SOURCES_RECORDED, printLogRecordedCost: 0 }, inputs: NO_INPUTS });
    expect(preview.components.printCostSource).toBe("preview");
    expect(preview.components.printCost).toBe(95);
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("  ")).toBeNull();
    expect(numberOrNull("0")).toBe(0); // typed zero IS entered
    expect(numberOrNull("12.5")).toBe(12.5);
    expect(numberOrNull("abc")).toBeNull();
  });

  it("variance: dollars vs estimate; percent UNAVAILABLE (null) when estimated cost is zero — never 0%", () => {
    expect(computeEstimateVariance(245, 200)).toEqual({ varianceDollars: 45, variancePct: 22.5 });
    expect(computeEstimateVariance(245, 0).variancePct).toBeNull();
    expect(computeEstimateVariance(150, 200).varianceDollars).toBe(-50);
  });

  it("DTP normalization: invoice + charges - credit; freight counted ONCE (backed out when invoice includes it); credit cannot go negative", () => {
    const separate = normalizeDtpOutsource({ invoiceSubtotal: 1230.5, additionalCharges: 20, credit: 50, freight: 85, invoiceIncludesFreight: false });
    expect(separate.outsourceCost).toBeCloseTo(1230.5 + 20 - 50, 6);
    expect(separate.shippingCost).toBe(85);
    expect(separate.invalid).toBeNull();
    const included = normalizeDtpOutsource({ invoiceSubtotal: 1315.5, additionalCharges: 0, credit: 0, freight: 85, invoiceIncludesFreight: true });
    expect(included.outsourceCost).toBeCloseTo(1230.5, 6); // freight backed OUT of vendor cost
    expect(included.shippingCost).toBe(85); // …and counted once as shipping
    expect(normalizeDtpOutsource({ invoiceSubtotal: 50, additionalCharges: 0, credit: 200, freight: 0, invoiceIncludesFreight: false }).invalid).toContain("Credit exceeds");
    expect(normalizeDtpOutsource({ invoiceSubtotal: 50, additionalCharges: 0, credit: 0, freight: 85, invoiceIncludesFreight: true }).invalid).toContain("exceeds the invoice subtotal");
  });

  it("estimate expectations parse the write-once snapshots without mutating them", () => {
    const items = [{ quantity: 100, unitCost: 2, costSnapshot: JSON.stringify({ productBreakdown: { lines: [{ key: "material", amount: 50 }, { key: "ink_cmyk", amount: 20 }] } }) }];
    const before = items[0].costSnapshot;
    const expectations = estimateExpectations(items);
    expect(expectations).toEqual({ estimatedTotalCost: 200, hadMaterialLines: true, hadPrintLines: true });
    expect(items[0].costSnapshot).toBe(before);
  });
});

describe("finalization gate (15E.1-C/D)", () => {
  const base = { family: "sticker-bags", alreadyFinalized: false, revenue: 1000, estimate: ESTIMATE, sources: SOURCES_RECORDED };

  it("READY: recorded in-house actuals with labor entered", () => {
    const ready = assessFinalization({ ...base, inputs: { ...NO_INPUTS, laborMinutes: 60, laborRate: 20 } });
    expect(ready.status).toBe("READY");
    expect(ready.requiresReason).toBe(false);
  });

  it("READY: valid DTP invoice + freight; explicit $0 labor confirmed; NO print/material expectations for DTP", () => {
    const dtp = assessFinalization({
      family: "dtp-bags", alreadyFinalized: false, revenue: 2200,
      estimate: { estimatedTotalCost: 1408, hadMaterialLines: false, hadPrintLines: false },
      sources: SOURCES_EMPTY,
      inputs: { ...NO_INPUTS, laborZeroConfirmed: true, dtp: { invoiceSubtotal: 1230.5, additionalCharges: 0, credit: 0, freight: 92, invoiceIncludesFreight: false } },
    });
    expect(dtp.status).toBe("READY"); // no print-log/material/ink/machine/application requirements
    expect(dtp.components.outsourceCost).toBeCloseTo(1230.5, 6);
    expect(dtp.components.shippingCost).toBe(92);
  });

  it("WARNING cases: preview-only print, missing expected material, unconfirmed zero labor, missing DTP freight", () => {
    const preview = assessFinalization({ ...base, sources: { ...SOURCES_RECORDED, printLogRecordedCost: 0 }, inputs: { ...NO_INPUTS, laborMinutes: 30, laborRate: 20 } });
    expect(preview.status).toBe("WARNING");
    expect(preview.warningReasons.join(" ")).toContain("LIVE PREVIEW");
    const noMaterial = assessFinalization({ ...base, sources: { ...SOURCES_RECORDED, materialCost: 0, materialRowCount: 0, deductedQty: 0 }, inputs: { ...NO_INPUTS, laborMinutes: 30, laborRate: 20 } });
    expect(noMaterial.warningReasons.join(" ")).toContain("material");
    const noLabor = assessFinalization({ ...base, inputs: NO_INPUTS });
    expect(noLabor.warningReasons.join(" ")).toContain("Labor is not entered");
    const dtpNoFreight = assessFinalization({ family: "dtp-bags", alreadyFinalized: false, revenue: 2200, estimate: { estimatedTotalCost: 1408, hadMaterialLines: false, hadPrintLines: false }, sources: SOURCES_EMPTY, inputs: { ...NO_INPUTS, laborZeroConfirmed: true, dtp: { invoiceSubtotal: 1230.5, additionalCharges: null, credit: null, freight: null, invoiceIncludesFreight: false } } });
    expect(dtpNoFreight.status).toBe("WARNING");
    expect(dtpNoFreight.warningReasons.join(" ")).toContain("freight");
  });

  it("BLOCKED cases with exact reasons", () => {
    expect(assessFinalization({ ...base, revenue: 0, inputs: NO_INPUTS }).blockedReasons.join(" ")).toContain("Revenue is zero");
    expect(assessFinalization({ ...base, inputs: { ...NO_INPUTS, packingCost: -5 } }).blockedReasons.join(" ")).toContain("Negative packing");
    expect(assessFinalization({ ...base, alreadyFinalized: true, inputs: NO_INPUTS }).blockedReasons.join(" ")).toContain("already finalized");
    const dtpNoInvoice = assessFinalization({ family: "dtp-bags", alreadyFinalized: false, revenue: 2200, estimate: { estimatedTotalCost: 1408, hadMaterialLines: false, hadPrintLines: false }, sources: SOURCES_EMPTY, inputs: { ...NO_INPUTS, laborZeroConfirmed: true, dtp: { invoiceSubtotal: null, additionalCharges: null, credit: null, freight: 85, invoiceIncludesFreight: false } } });
    expect(dtpNoInvoice.status).toBe("BLOCKED");
    expect(dtpNoInvoice.blockedReasons.join(" ")).toContain("vendor invoice subtotal");
    const badNormalization = assessFinalization({ family: "dtp-bags", alreadyFinalized: false, revenue: 2200, estimate: { estimatedTotalCost: 1408, hadMaterialLines: false, hadPrintLines: false }, sources: SOURCES_EMPTY, inputs: { ...NO_INPUTS, laborZeroConfirmed: true, dtp: { invoiceSubtotal: 50, additionalCharges: 0, credit: 200, freight: 0, invoiceIncludesFreight: false } } });
    expect(badNormalization.blockedReasons.join(" ")).toContain("invalid");
    const deductedNoCost = assessFinalization({ ...base, sources: { ...SOURCES_EMPTY, deductedQty: 50 }, inputs: { ...NO_INPUTS, laborMinutes: 30, laborRate: 20 } });
    expect(deductedNoCost.blockedReasons.join(" ")).toContain("Inventory was deducted");
    const minutesNoRate = assessFinalization({ ...base, inputs: { ...NO_INPUTS, laborMinutes: 60 } });
    expect(minutesNoRate.blockedReasons.join(" ")).toContain("without a labor rate");
  });

  it("deduction drift beyond 25% is a WARNING; snapshot embeds inputs, components, variance, actor", () => {
    const drift = assessFinalization({ ...base, sources: { ...SOURCES_RECORDED, deductedQty: 200 }, inputs: { ...NO_INPUTS, laborMinutes: 30, laborRate: 20 } });
    expect(drift.status).toBe("WARNING");
    expect(drift.warningReasons.join(" ")).toContain("differs from the costed usage basis");
    const snapshot = buildActualCostFinalizeSnapshot({ assessment: drift, inputs: { ...NO_INPUTS, warningReason: "owner accepts drift" }, actor: "owner@gso.com", finalizedAt: "2026-07-24T00:00:00Z", family: "sticker-bags" });
    expect(snapshot.version).toBe("15E.1-actual-cost-finalize");
    expect(snapshot.finalizeReason).toBe("owner accepts drift");
    expect((snapshot as any).components.printCost).toBe(120);
    expect(snapshot.varianceDollars).toBeDefined();
    expect(snapshot.actor).toBe("owner@gso.com");
  });
});

describe("actor + reopen + route wiring (15E.1-G/H/I/J)", () => {
  it("actor resolves from session identity, never a posted field; documented offline fallback", () => {
    expect(resolveActorFromSession({ email: "staff@gso.com" }, "shop1")).toBe("staff@gso.com");
    expect(resolveActorFromSession({ firstName: "Sam", lastName: "Owner" }, "shop1")).toBe("Sam Owner");
    expect(resolveActorFromSession({ userId: 777 }, "shop1")).toBe("user:777");
    expect(resolveActorFromSession({}, "shop1")).toBe("shop-admin:shop1 (offline session)");
    expect(REOPEN_PHRASE).toBe("OWNER COST REOPEN");
  });

  it("route: finalized jobs refuse edits; finalize gates + snapshot event + real actor; reopen audited with prior figures", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.production.tsx", import.meta.url), "utf8");
    expect(src).toContain("Reopen it first with Reopen Actual Cost");
    expect(src).toContain("Nothing was changed.");
    expect(src).toContain('assessment.status === "BLOCKED"');
    expect(src).toContain("WARNING — REASON REQUIRED:");
    expect(src).toContain("resolveActorFromSession(session, shop)");
    expect(src).not.toContain('"GSO ERP"'); // hardcoded actor gone
    expect(src).toContain('createEvent(shop, jobId, "actual_cost_finalized"');
    expect(src).toContain("SNAPSHOT ${JSON.stringify(snapshot)}");
    expect(src).toContain('intent === "reopenJobCost"');
    expect(src).toContain("PRIOR FINAL ${JSON.stringify(prior)}");
    expect(src).toContain("phrase !== REOPEN_PHRASE");
    expect(src).toContain("reason.length < 5");
    // zero-vs-missing + DTP structured entry + labor default removed
    expect(src).toContain("numberOrNull(formData.get(");
    expect(src).not.toContain("defaultValue={job.actualLaborRate || 25}");
    expect(src).toContain('name="laborZeroConfirmed"');
    expect(src).toContain('name="dtpInvoiceSubtotal"');
    expect(src).toContain('name="dtpFreight"');
    expect(src).toContain('name="dtpInvoiceIncludesFreight"');
    expect(src).toContain('name="finalizeReason"');
    expect(src).toContain('name="reopenPhrase"');
    // gate banner + variance display
    expect(src).toContain("READY TO FINALIZE");
    expect(src).toContain("% unavailable");
  });
});
