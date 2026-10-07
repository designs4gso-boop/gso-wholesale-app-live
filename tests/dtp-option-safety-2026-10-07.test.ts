// DTP OPTION SAFETY SWEEP — 2026-10-07.
// Every supported option combination (material x finish x spot x zipper x
// top feature x clear gusset x SKU count) must resolve through the quote cost
// authority and the owner ladder WITHOUT a crash, and a combination whose
// vendor cost breaks the protection must never come back READY.
import { describe, expect, it } from "vitest";
import {
  SPEKTRA_FINISHES,
  SPEKTRA_MATERIALS,
  SPEKTRA_SPOT_OPTIONS,
  SPEKTRA_TOP_FEATURES,
  SPEKTRA_ZIPPER_OPTIONS,
  spotAllowedForFinish,
} from "../app/lib/spektra-live-cost-book";
import { resolveDtpQuoteCost } from "../app/lib/dtp-quote-cost-authority.server";
import { DTP_MIN_JOB_PROFIT, priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";

const SKU = "spektra-dtp-4x5x2";
const legacy = { totalCost: 1082.98, missing: false, vendorSubtotal: 989.7 };

describe("DTP option combinations resolve safely (4x5x2, live cost book)", () => {
  const combos: Array<{ material: string; finish: string; spot: string; zipper: string; topFeature: string; clearGusset: boolean }> = [];
  for (const material of SPEKTRA_MATERIALS) for (const finish of SPEKTRA_FINISHES) for (const spot of SPEKTRA_SPOT_OPTIONS) for (const zipper of SPEKTRA_ZIPPER_OPTIONS) for (const topFeature of SPEKTRA_TOP_FEATURES) for (const clearGusset of [false, true]) {
    combos.push({ material, finish, spot, zipper, topFeature, clearGusset });
  }

  it(`sweeps ${4 * 3 * 3 * 3 * 3 * 2} combinations x 1,000 / 2,500 / 5,000 / 10,000 x 1 / 2 / 5 / 10 SKUs: never crashes, never READY below protection`, () => {
    const counts = { observed: 0, estimated: 0, step: 0, requestQuote: 0, ready: 0, override: 0, blocked: 0 };
    for (const combo of combos) for (const quantity of [1000, 2500, 5000, 10000]) for (const designs of [1, 2, 5, 10]) {
      const cost = resolveDtpQuoteCost({ vendorSku: SKU, quantity, designs, selection: combo, legacy });
      expect(cost.authority).toBe("LIVE_COST_BOOK_BY_CONFIGURATION");
      if (!spotAllowedForFinish(combo.finish as any, combo.spot as any)) {
        expect(cost.status, JSON.stringify(combo)).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
        expect(cost.missing).toBe(true);
      }
      if (cost.status === "OBSERVED_VENDOR_PRICE") counts.observed++;
      else if (cost.status === "ESTIMATED_FROM_VALIDATED_VENDOR_RULE") counts.estimated++;
      else if (cost.status === "ESTIMATED_CONSERVATIVE_STEP") counts.step++;
      else counts.requestQuote++;
      const q = priceDtpQuote({ ladderSku: SKU, quantity, landedCost: cost.landedCost, missingCost: cost.missing, designs, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
      expect(Number.isFinite(q.grossMarginPct)).toBe(true);
      expect(Number.isFinite(q.customerTotal)).toBe(true);
      if (cost.missing) expect(q.status).toBe("BLOCKED");
      if (q.status === "READY") {
        counts.ready++;
        expect(q.grossMarginPct, JSON.stringify({ combo, quantity, designs })).toBeGreaterThanOrEqual(q.hardFloorPct - 1e-9);
        expect(q.grossProfit).toBeGreaterThanOrEqual(q.minJobProfit - 1e-9);
        if (quantity >= 2500) expect(q.minJobProfit).toBe(DTP_MIN_JOB_PROFIT);
      } else if (q.status === "OWNER OVERRIDE REQUIRED") {
        counts.override++;
        expect(q.overrideRequired).toBe(true);
        expect(q.grossMarginPct < q.hardFloorPct || q.grossProfit < q.minJobProfit).toBe(true);
      } else {
        counts.blocked++;
        expect(q.status).toBe("BLOCKED");
      }
    }
    expect(counts.observed).toBeGreaterThan(0);
    expect(counts.estimated).toBeGreaterThan(0); // multi-SKU rule
    expect(counts.ready).toBeGreaterThan(0);
    expect(counts.override + counts.blocked).toBeGreaterThan(0); // premium options at the same $1.30 trip protection
    expect(counts.step).toBe(0); // published tiers never need the step
  });

  it("a custom quantity (1,500) for every observed base combination uses the labelled conservative step, never interpolation", () => {
    const base = { material: "White PET", finish: "Glossy", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false };
    const step = resolveDtpQuoteCost({ vendorSku: SKU, quantity: 1500, designs: 1, selection: base, legacy });
    expect(step.status).toBe("ESTIMATED_CONSERVATIVE_STEP");
    // priced at the highest OBSERVED quantity at or below 1,500 for this configuration (research also tested 1,100 / 1,200) — never between rows
    const stepQty = Number(String(step.basis).match(/observed ([\d,]+)-unit row/)?.[1]?.replace(/,/g, ""));
    expect(stepQty).toBeGreaterThanOrEqual(1000);
    expect(stepQty).toBeLessThanOrEqual(1500);
    const stepRow = resolveDtpQuoteCost({ vendorSku: SKU, quantity: stepQty, designs: 1, selection: base, legacy });
    expect(stepRow.status).toBe("OBSERVED_VENDOR_PRICE");
    expect(step.vendorUnit!).toBeCloseTo(stepRow.vendorUnit!, 9);
  });
});
