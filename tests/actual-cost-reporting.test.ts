import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  LEAKAGE_THRESHOLDS,
  aggregateByCustomer,
  aggregateByFamily,
  aggregateByProduct,
  aggregateByVendor,
  buildPricingFeedbackSuggestions,
  detectMarginLeakage,
  familyFloorPct,
  normalizeFinalizedJobActuals,
  parseFinalizeSnapshotFromEvents,
  quantityBand,
  toCsv,
  type FinalizedJobRow,
} from "../app/lib/actual-cost-reporting.server";

function makeJob(overrides: any = {}): any {
  const snapshot = {
    version: "15E.1-actual-cost-finalize",
    gateStatus: "READY",
    warningReasons: [],
    finalizeReason: null,
    revenue: 2200,
    components: { laborCost: 25, laborBasis: "minutes_x_rate" },
    enteredInputs: { laborMinutes: 60, dtp: null },
  };
  return {
    id: "job1",
    jobTicket: "GSO-20260724-0001",
    quoteId: "quoteA",
    email: "buyer@x.com",
    company: "JarCo",
    customerName: "Jane",
    actualCostFinalized: true,
    actualCostFinalizedAt: "2026-07-24T12:00:00Z",
    actualCostFinalizedBy: "owner@gso.com",
    actualTotalCost: 1400,
    actualFinalProfit: 800,
    actualFinalMargin: (800 / 2200) * 100,
    actualLaborCost: 25,
    actualLaborMinutes: 60,
    actualReprintCost: 0,
    actualPackingCost: 10,
    actualShippingCost: 92,
    actualOutsourceCost: 1230,
    actualOtherCost: 0,
    items: [{
      quantity: 2500, unitPrice: 0.88, unitCost: 0.5296, productTitle: "Spektra DTP 4x5x2", sku: null, recipeId: null,
      costSnapshot: JSON.stringify({ productBreakdown: { canonicalFamily: "dtp-bags", selections: { blank: "vendor:dtp4x5x2" }, dtp: { size: "vendor:dtp4x5x2", vendorSubtotal: 1230.5, freight: 85 }, dtpPricing: { ownerPriceTierUsed: 2500, customUnitPrice: null, overrideRequired: false, marginWarningTargetPct: 40, extraDesignFees: 0 }, lines: [{ key: "art_setup", amount: 8.33 }] } }),
    }],
    materialUsages: [],
    events: [{ eventType: "actual_cost_finalized", message: `Actual cost FINALIZED. SNAPSHOT ${JSON.stringify(snapshot)}` }],
    ...overrides,
  };
}

describe("normalization (15E.2-A/P)", () => {
  it("finalized 15E.1 job normalizes with snapshot gate/actor/variance; unfinalized returns null", () => {
    const row = normalizeFinalizedJobActuals(makeJob())!;
    expect(row.gateStatus).toBe("READY");
    expect(row.legacyFinal).toBe(false);
    expect(row.family).toBe("dtp-bags");
    expect(row.finalCost).toBe(1400);
    expect(row.estimatedCost).toBeCloseTo(2500 * 0.5296, 2);
    expect(row.variancePct).not.toBeNull();
    expect(row.finalizedBy).toBe("owner@gso.com");
    expect(normalizeFinalizedJobActuals(makeJob({ actualCostFinalized: false }))).toBeNull(); // finalized-only policy
  });

  it("legacy finalized jobs (no 15E.1 snapshot event) use columns and are labeled legacy", () => {
    const legacy = normalizeFinalizedJobActuals(makeJob({ events: [] }))!;
    expect(legacy.legacyFinal).toBe(true);
    expect(legacy.gateStatus).toBe("LEGACY");
    expect(legacy.finalCost).toBe(1400); // columns still authoritative
    expect(parseFinalizeSnapshotFromEvents([])).toBeNull();
  });

  it("zero estimated cost -> variance % unavailable (null), never 0%", () => {
    const row = normalizeFinalizedJobActuals(makeJob({ items: [{ quantity: 100, unitPrice: 5, unitCost: 0, productTitle: "Freebie estimate", costSnapshot: null }] }))!;
    expect(row.estimatedCost).toBe(0);
    expect(row.variancePct).toBeNull();
  });

  it("customer grouping precedence: email > company > name > Unknown; product identity keeps DTP sizes distinct", () => {
    expect(normalizeFinalizedJobActuals(makeJob())!.customerKey).toContain("email:");
    expect(normalizeFinalizedJobActuals(makeJob({ email: null }))!.customerKey).toContain("company:");
    expect(normalizeFinalizedJobActuals(makeJob({ email: null, company: null }))!.customerKey).toContain("name:");
    expect(normalizeFinalizedJobActuals(makeJob({ email: null, company: null, customerName: null }))!.customerLabel).toBe("Unknown customer");
    const a = normalizeFinalizedJobActuals(makeJob())!;
    const b = normalizeFinalizedJobActuals(makeJob({ items: [{ ...makeJob().items[0], productTitle: "Spektra DTP 5x4x2", costSnapshot: JSON.stringify({ productBreakdown: { canonicalFamily: "dtp-bags", selections: { blank: "vendor:dtp5x4x2" }, dtp: {}, dtpPricing: {} } }) }] }))!;
    expect(a.productKey).not.toBe(b.productKey); // 4x5x2 and 5x4x2 never merge
  });

  it("quantity bands map correctly", () => {
    expect(quantityBand(64)).toBe("1-99");
    expect(quantityBand(2500)).toBe("2500-4999");
    expect(quantityBand(7500)).toBe("7500+");
    expect(quantityBand(20000)).toBe("7500+");
  });
});

describe("aggregation + weighted margin (15E.2-D/E/F/G)", () => {
  const rows = [
    normalizeFinalizedJobActuals(makeJob())!,
    normalizeFinalizedJobActuals(makeJob({
      id: "job2", jobTicket: "GSO-2", actualTotalCost: 800, actualFinalProfit: 200, actualFinalMargin: 20,
      items: [{ ...makeJob().items[0], quantity: 1000, unitPrice: 1.0 }],
      events: [], // legacy final — revenue derives from item rows (1000), not an inherited snapshot
    }))!,
  ];

  it("weighted margin = total profit / total revenue — never an average of percentages; totals sum once", () => {
    const family = aggregateByFamily(rows);
    expect(family).toHaveLength(1);
    const dtp = family[0];
    expect(dtp.jobs).toBe(2);
    expect(dtp.revenue).toBeCloseTo(2200 + 1000, 2);
    expect(dtp.profit).toBeCloseTo(1000, 2);
    expect(dtp.weightedMarginPct).toBeCloseTo((1000 / 3200) * 100, 4); // Σprofit/Σrevenue
    expect(dtp.averageMarginPct).toBeCloseTo(((800 / 2200) * 100 + 20) / 2, 4);
    expect(Math.abs(dtp.weightedMarginPct - dtp.averageMarginPct)).toBeGreaterThan(1); // distinct KPIs
    expect(dtp.actualCost).toBeCloseTo(2200, 2);
  });

  it("product/customer/vendor grouping stays stable", () => {
    expect(aggregateByProduct(rows)[0].key).toBe("vendor:dtp4x5x2");
    expect(aggregateByCustomer(rows)[0].key).toContain("email:buyer@x.com");
    expect(aggregateByVendor(rows)[0].label).toContain("Spektra");
  });
});

describe("leakage rules (15E.2-K)", () => {
  it("centralized thresholds flag below-target, below-floor, cost/freight/vendor variance, warnings, reopens", () => {
    expect(LEAKAGE_THRESHOLDS.marginTargetPct).toBe(40);
    expect(familyFloorPct("sticker-bags", 500)).toBe(45);
    expect(familyFloorPct("dtp-bags", 2500)).toBe(35); // quantity-banded DTP floor
    const healthy = normalizeFinalizedJobActuals(makeJob())!;
    expect(detectMarginLeakage(healthy)).toEqual(expect.arrayContaining([expect.stringContaining("Below 40% target")])); // 36.4% margin
    const bad = { ...healthy, finalMarginPct: 30, marginVariancePts: -10, variancePct: 15, gateStatus: "WARNING", reopenCount: 1 } as FinalizedJobRow;
    const flags = detectMarginLeakage(bad);
    expect(flags.join(" ")).toContain("BELOW FAMILY FLOOR 35%");
    expect(flags.join(" ")).toContain("pts below estimate");
    expect(flags.join(" ")).toContain("over estimate");
    expect(flags.join(" ")).toContain("warning reason");
    expect(flags.join(" ")).toContain("Reopened 1x");
    const freight = { ...healthy, dtp: { ...healthy.dtp!, actualFreight: 120, estimatedFreight: 85 } } as FinalizedJobRow;
    expect(detectMarginLeakage(freight).join(" ")).toContain("Freight");
  });
});

describe("pricing feedback (15E.2-L)", () => {
  it("fewer than 3 comparable jobs -> no recommendation; 3+ -> evidence-backed suggestion; 5+ -> high confidence; never mutates", () => {
    const two = [normalizeFinalizedJobActuals(makeJob())!, normalizeFinalizedJobActuals(makeJob({ id: "j2", jobTicket: "T2" }))!];
    expect(buildPricingFeedbackSuggestions(two)).toHaveLength(0);
    const five = [1, 2, 3, 4, 5].map((n) => normalizeFinalizedJobActuals(makeJob({ id: `j${n}`, jobTicket: `T${n}`, actualTotalCost: 1700, actualFinalProfit: 500, actualFinalMargin: (500 / 2200) * 100 }))!);
    const before = JSON.stringify(five[0]);
    const suggestions = buildPricingFeedbackSuggestions(five);
    expect(suggestions.length).toBeGreaterThan(0);
    const costSuggestion = suggestions.find((suggestion) => suggestion.type === "cost-understated");
    expect(costSuggestion).toBeDefined();
    expect(costSuggestion!.confidence).toBe("high"); // 5 jobs
    expect(costSuggestion!.jobCount).toBe(5);
    expect(costSuggestion!.supportingJobs).toHaveLength(5);
    expect(costSuggestion!.currentStandard).toContain("estimate");
    expect(JSON.stringify(five[0])).toBe(before); // no mutation
    const priceSuggestion = suggestions.find((suggestion) => suggestion.type === "price-below-target");
    expect(priceSuggestion).toBeDefined(); // weighted ~22.7% vs 40 target
  });
});

describe("CSV + route pins (15E.2-N/O)", () => {
  it("CSV escapes quotes/commas and never emits snapshots or override phrases", () => {
    const csv = toCsv(["a", "b"], [["plain", 'has "quote", and comma']]);
    expect(csv).toBe('a,b\nplain,"has ""quote"", and comma"');
  });

  it("dashboard pins: finalized-only policy, filters, CSV exports, review queue, legacy label, no automatic pricing writes", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.reports-dashboard.tsx", import.meta.url), "utf8");
    expect(src).toContain("actualCostFinalized: true"); // finalized-only query
    expect(src).toContain("open/unfinalized job(s) are EXCLUDED");
    expect(src).toContain("legacy final");
    expect(src).toContain('name="rfamily"');
    expect(src).toContain('name="rbelow"');
    expect(src).toContain('export=${kind}');
    expect(src).toContain('reviewPricingFeedback');
    expect(src).toContain('category: "pricing-feedback"');
    expect(src).toContain("Apply any change manually");
    expect(src).toContain("never automatic");
    // pricing-feedback decisions touch ONLY ErpAdminSetting — no pricing/vendor writes
    for (const banned of ["vendorProduct.update", "vendorProductTier.update", "pricingRule.update", "OWNER_PRICE_LADDERS ="]) {
      expect(src).not.toContain(banned);
    }
    expect(src).toContain("weightedMarginPct"); // weighted KPI rendered
  });
});
