// Patch 2D-4E2 — the owner-verified 50-unit MOQ for custom 4x5 Sticker Bags
// is enforced by the CANONICAL manufacturing engine, not only by the
// storefront commercial layer. Eligibility only: the material/cut/application
// math is untouched by it.

import { describe, expect, it } from "vitest";
import {
  BAG_REASONS,
  STICKER_BAG_MOQ,
  STOCK_BAG_MOQ,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { resolveCostAuthority, canonicalSaveGate } from "../app/lib/canonical-quote-authority.server";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test",
    machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};

const bagJob = (qty: number, stock = false) => {
  const input = normalizeCanonicalInput(new URLSearchParams(
    `pfamily=sticker-bags${stock ? "&pstockbag=1" : ""}&pqty=${qty}&pbagsides=2&pdesigns=1&pprinter=auto`,
  ))!;
  return assembleCanonicalJob(input, CAL);
};

describe("2D-4E2 sticker bag MOQ in the canonical adapter", () => {
  it("the MOQ is 50 for sticker bags and stays 50 for stock bags", () => {
    expect(STICKER_BAG_MOQ).toBe(50);
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(BAG_REASONS.stickerBagBelowMoq).toBe("STICKER_BAG_BELOW_MOQ");
  });

  it("qty 49 blocks; qty 50 is eligible", () => {
    const below = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 49, sides: 1 });
    expect(below.reasons).toContain(BAG_REASONS.stickerBagBelowMoq);
    expect(below.blockers.join(" ")).toContain("STICKER_BAG_BELOW_MOQ");
    const atMoq = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 50, sides: 1 });
    expect(atMoq.reasons).not.toContain(BAG_REASONS.stickerBagBelowMoq);
    expect(atMoq.blockers.join(" ")).not.toContain("STICKER_BAG_BELOW_MOQ");
  });

  it("the MOQ is eligibility only — 49 bags still consume 49 bags of material and applications", () => {
    const below = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 49, sides: 2 });
    expect(below.labelQuantity).toBe(98);
    expect(below.blankCost).toBeCloseTo(49 * 0.09, 10);
    expect(below.application.applicationEvents).toBe(98);
    expect(below.nesting.materialFootprintSqft).toBeGreaterThan(0);
  });

  it("zero quantity does not trip the MOQ (the quantity-required blocker owns that)", () => {
    const zero = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 0, sides: 1 });
    expect(zero.reasons).not.toContain(BAG_REASONS.stickerBagBelowMoq);
  });

  it("stock bags keep their own reason code and are not double-flagged", () => {
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 40, sides: 1 });
    expect(stock.reasons).toContain(BAG_REASONS.stockBagBelowMoq);
    expect(stock.reasons).not.toContain(BAG_REASONS.stickerBagBelowMoq);
  });

  it("through the canonical job: 49 is DRAFT_ONLY with null unit cost; 50 publishes a real cost", () => {
    const below = bagJob(49);
    expect(below.status).toBe("DRAFT_ONLY");
    expect(below.unitCost).toBeNull();
    expect(below.blockers.join(" ")).toContain("STICKER_BAG_BELOW_MOQ");
    const atMoq = bagJob(50);
    expect(atMoq.status).not.toBe("DRAFT_ONLY");
    expect(atMoq.unitCost).toBeGreaterThan(0);
    expect(atMoq.blockers).toEqual([]);
  });

  it("the cost authority and the save gate both refuse the 49-bag job", () => {
    const below = bagJob(49);
    const authority = resolveCostAuthority({ canonicalFamilyKey: "sticker-bags", canonical: below, legacyJobCost: 12.34, quantity: 49 });
    expect(authority.costed).toBe(false);
    expect(authority.unitCost).toBeNull();
    expect(canonicalSaveGate({ canonicalFamilyKey: "sticker-bags", canonical: below }).allowed).toBe(false);
    const atMoq = bagJob(50);
    expect(canonicalSaveGate({ canonicalFamilyKey: "sticker-bags", canonical: atMoq }).allowed).toBe(true);
  });
});
