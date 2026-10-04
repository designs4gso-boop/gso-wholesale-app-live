// OPS-2 (2026-10-04) — OWNER DECISION: the 4x5 Sticker Bag MOQ is 50. The
// canonical adapter (STICKER_BAG_MOQ) was already correct; the sales-facing
// rule said 100 and was stale. This test pins parity between every agent-
// facing MOQ source and the canonical authority.

import { describe, expect, it } from "vitest";

import { BAG_REASONS, STICKER_BAG_MOQ, STOCK_BAG_MOQ } from "../app/lib/bag-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { officialMoqForFamily, productFamilySalesRuleFor } from "../app/lib/product-family-sales-rules";
import { detectEscalations, draftCustomerSafeReply } from "../app/lib/ops/sales-intake";
import { prepareQuote } from "../app/lib/ops/quote-prep.server";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};

const canonical = (qty: number) => assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(`pfamily=sticker-bags&pqty=${qty}&pbagsides=2&pdesigns=1&pprinter=auto`))!, CAL);

const lead = (qty: number) => ({ source: "web", customerName: "Dana", email: "d@example.com", productFamily: "sticker-bags", quantity: qty, dimensions: "4x5", material: "matte", finish: "matte", artworkReady: true, deadline: "2026-11-01", shippingCityState: "Portland, OR" });

describe("OPS-2 sticker bag MOQ parity (owner-approved 50)", () => {
  it("canonical and sales authorities agree on 50; stock bags stay 50", () => {
    expect(STICKER_BAG_MOQ).toBe(50);
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(officialMoqForFamily("sticker-bags")).toBe(50);
    expect(officialMoqForFamily("Sticker Bags")).toBe(50);
    expect(officialMoqForFamily("sticker-bags")).toBe(STICKER_BAG_MOQ);
    const rule = productFamilySalesRuleFor("sticker-bags");
    expect(rule.salesRules.join(" ")).toMatch(/Official MOQ: 50/);
    expect(rule.customerSafeSummary).toMatch(/start at 50 units/);
    expect(JSON.stringify(rule)).not.toMatch(/\b100\b/);
  });

  it("other families' MOQs are untouched", () => {
    expect(officialMoqForFamily("dtp-pouches")).toBe(1000);
    expect(officialMoqForFamily("boxes")).toBe(1000);
  });

  it("canonical adapter: 49 blocks, 50 passes, 100 passes", () => {
    const at49 = canonical(49);
    expect(at49.reasons).toContain(BAG_REASONS.stickerBagBelowMoq);
    expect(at49.blockers.join(" ")).toContain("STICKER_BAG_BELOW_MOQ");
    for (const qty of [50, 100]) {
      const ok = canonical(qty);
      expect(ok.reasons, `qty ${qty}`).not.toContain(BAG_REASONS.stickerBagBelowMoq);
      expect(ok.blockers.join(" "), `qty ${qty}`).not.toContain("STICKER_BAG_BELOW_MOQ");
    }
  });

  it("sales intake and quote prep use the same 50", () => {
    expect(detectEscalations(lead(49))).toContain("below_moq");
    expect(detectEscalations(lead(50))).not.toContain("below_moq");
    expect(detectEscalations(lead(100))).not.toContain("below_moq");
    expect(prepareQuote(lead(49)).staffReviewTriggers.join(" ")).toMatch(/below official MOQ \(50\)/);
    expect(prepareQuote(lead(50)).staffReviewTriggers.join(" ")).not.toMatch(/MOQ/);
    expect(draftCustomerSafeReply(lead(500))).toMatch(/usually start at 50 units/);
    expect(draftCustomerSafeReply(lead(500))).not.toMatch(/100 units/);
  });
});
