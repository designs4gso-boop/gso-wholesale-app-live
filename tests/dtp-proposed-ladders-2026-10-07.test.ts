// DTP remaining-size PROPOSALS (not active) + 4x5 step pins + 5x4x2 manual review — 2026-10-07.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_SIZE,
  DTP_PROPOSAL_STATUS,
  DTP_REMAINING_SIZES,
  buildDtpProposedLadders,
  commercialRound,
  continuityFor,
  dtpProposedLaddersMarkdown,
  proposeRow,
  recommended4x5At25k,
} from "../app/lib/dtp-proposed-ladders.server";
import { DTP_OWNER_PRICE_LADDERS, ownerPriceForQuantity, priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";
import { resolveDtpQuoteCost } from "../app/lib/dtp-quote-cost-authority.server";
import { priceDtpConfiguration } from "../app/lib/canonical-dtp-pricing.server";
import { DESIGN_AND_CUSTOMIZE_SHAPED_EVIDENCE, benchmarkComparableCrUnit } from "../app/lib/dtp-market-benchmark";
import { DTP_NEW_DIE_TOOLING_FEE, priceShapedPouch } from "../app/lib/dtp-shaped-bag-policy";

describe("4x5x2 commercial quantity steps (owner direction 2026-10-07)", () => {
  it("pins every step boundary; never interpolates; 25,000+ has no activated ladder", () => {
    const expected: Array<[number, number | null]> = [
      [1000, 1.3], [1500, 1.3], [2499, 1.3], [2500, 0.71], [4999, 0.71], [5000, 0.46], [7500, 0.46], [9999, 0.46], [10000, 0.37], [24999, 0.37], [25000, null], [30000, null],
    ];
    for (const [qty, price] of expected) expect(ownerPriceForQuantity("spektra-dtp-4x5x2", qty).unitPrice, String(qty)).toBe(price);
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 25000).reviewRequired).toContain("OWNER PRICING REVIEW REQUIRED");
    expect(Object.keys(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).map(Number).sort((a, b) => a - b)).toEqual([1000, 2500, 5000, 10000]);
  });

  it("Design & Customize comparable CR references include the 1,500 tier ($0.84)", () => {
    expect(benchmarkComparableCrUnit(1500).comparableUnit).toBeCloseTo(0.84, 6);
    expect(benchmarkComparableCrUnit(2499).comparableUnit).toBeCloseTo(0.84, 6); // step semantics on the benchmark too
    expect(DESIGN_AND_CUSTOMIZE_SHAPED_EVIDENCE.ladder).toEqual({ 1250: 1.8, 1500: 1.55, 2000: 1.3, 2500: 1.2, 4000: 0.9 });
    expect(DESIGN_AND_CUSTOMIZE_SHAPED_EVIDENCE.use).toMatch(/market evidence/i);
  });

  it("shaped: the 10% never touches the $700 tooling fee", () => {
    const p = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1775, die: { mode: "new" } });
    expect(p.toolingFee).toBe(DTP_NEW_DIE_TOOLING_FEE);
    expect(p.shapeSurcharge).toBe(177.5);
    expect(p.total).toBe(1775 + 177.5 + 700);
    expect(p.unitPrice * 2500).toBeCloseTo(1952.5, 6); // tooling excluded from the unit price
  });
});

describe("5x4x2 legacy: MANUAL / VENDOR REVIEW for new quotes; history untouched", () => {
  it("quote cost authority blocks automated 5x4x2 quoting with a manual-review reason", () => {
    const cost = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-5x4x2", quantity: 2500, designs: 1, selection: {}, legacy: { totalCost: 1448.08, missing: false, vendorSubtotal: 1354.75 } });
    expect(cost.authority).toBe("LEGACY_VENDOR_SEED");
    expect(cost.status).toBe("LEGACY_MANUAL_REVIEW");
    expect(cost.missing).toBe(true);
    expect(cost.missingReason).toMatch(/MANUAL \/ VENDOR REVIEW/);
    const q = priceDtpQuote({ ladderSku: "spektra-dtp-5x4x2", quantity: 2500, landedCost: cost.landedCost, missingCost: cost.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(q.status).toBe("BLOCKED");
    // the July ladder values stay readable for historical display
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-5x4x2"]).toEqual({ 1000: 1.76, 2500: 0.97, 5000: 0.86, 7500: 0.72, 10000: 0.71 });
  });

  it("storefront adapter sends 5x4x2 to a manual quote instead of auto-pricing", () => {
    const r = priceDtpConfiguration({ productType: "dtp_5x4x2", quantity: 2500 });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.requestQuote).toBe(true); expect(r.reason).toMatch(/quoted manually|vendor review/i); }
    const ok = priceDtpConfiguration({ productType: "dtp_4x5x2", quantity: 2500 });
    expect(ok.ok).toBe(true);
  });
});

describe("remaining-size PROPOSED ladders (not active)", () => {
  const data = buildDtpProposedLadders();

  it("covers 3.5x4.5x2 / 5x5x2 / 6x5x2 / 8x5x2 at 1,000 / 2,500 / 5,000 / 10,000 / 25,000 with full A–I economics", () => {
    expect(data.status).toBe(DTP_PROPOSAL_STATUS);
    expect(data.ladders.map((l) => l.size)).toEqual(DTP_REMAINING_SIZES);
    for (const ladder of data.ladders) {
      expect(ladder.rows.map((r) => r.quantity)).toEqual([1000, 2500, 5000, 10000, 25000]);
      for (const r of ladder.rows) {
        expect(r.vendorStatus, `${r.size}@${r.quantity}`).toBe("OBSERVED_VENDOR_PRICE");
        expect(r.proposed, `${r.size}@${r.quantity}`).not.toBeNull();
        expect(r.proposed!.meetsFloor).toBe(true);
        expect(r.proposed!.meetsMinProfit).toBe(true); // normal protection — no inherited $350 exception
        expect(r.proposed!.price).toBeGreaterThanOrEqual(Math.max(r.G_gpParityPrice!, r.H_floorPrice!, r.I_minProfitPrice!) - 1e-9);
        expect(r.exactSizeCompetitor).toBe("NOT CURRENTLY VERIFIED");
        expect(r.E_anchorBasis).toBe(r.quantity === 25000 ? "4x5x2 25,000 RECOMMENDATION (not approved)" : "OWNER APPROVED 4x5x2");
      }
      expect(ladder.rows[0].acquisitionOption).not.toBeNull();
      expect(ladder.rows[0].acquisitionOption!.gp).toBeGreaterThanOrEqual(350);
      expect(ladder.rows[1].acquisitionOption).toBeNull();
    }
  });

  it("GP parity is a real landed-cost delta, not a size multiplier: 3.5x4.5x2 prices at or below 4x5x2, 8x5x2 above", () => {
    const small = proposeRow("3.5x4.5x2", 2500);
    const big = proposeRow("8x5x2", 2500);
    expect(small.F_landedDeltaUnit!).toBeLessThan(0);
    expect(big.F_landedDeltaUnit!).toBeGreaterThan(0);
    expect(small.proposed!.price).toBeLessThanOrEqual(0.71);
    expect(big.proposed!.price).toBeGreaterThan(0.71);
    expect(big.G_gpParityPrice!).toBeCloseTo(0.71 + big.F_landedDeltaUnit!, 3);
  });

  it("commercial rounding and 4x5 25,000 recommendation", () => {
    expect(commercialRound(1.3816)).toBe(1.4);
    expect(commercialRound(1.3)).toBe(1.3);
    expect(commercialRound(0.6949)).toBe(0.7);
    expect(commercialRound(0.71)).toBe(0.71);
    const rec = recommended4x5At25k()!;
    expect(rec.status).toBe("OWNER APPROVAL REQUIRED");
    expect(rec.size).toBe(ANCHOR_SIZE);
    expect(rec.price).toBe(0.3);
    expect(rec.gmPct).toBeGreaterThanOrEqual(40);
    expect(rec.meetsFloor).toBe(true);
    expect(rec.continuity.priceAt10k).toBe(0.37);
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 25000).unitPrice).toBeNull(); // still NOT activated
  });

  it("continuity flags step cliffs; the approved 4x5 ladder's own steps are the reference", () => {
    const c = continuityFor([{ quantity: 1000, price: 1.3 }, { quantity: 2500, price: 0.71 }, { quantity: 5000, price: 0.46 }, { quantity: 10000, price: 0.37 }]);
    expect(c.map((x) => x.toQty)).toEqual([2500, 5000, 10000]);
    expect(c[0].totalJustBelow).toBeCloseTo(1.3 * 2499, 2);
    expect(c[0].totalAtStep).toBe(1775);
    expect(c.every((x) => x.dropPct > 0)).toBe(true); // every step is cheaper in total than one unit below it
    expect(data.anchor.continuity.length).toBe(4);
    // proposals are judged against the 4x5 reference drops: none is a cliff beyond the approved ladder's own steps
    for (const ladder of data.ladders) expect(ladder.continuity.filter((x) => x.cliff).map((x) => `${ladder.size}@${x.toQty}`)).toEqual([]);
  });

  it("writes the owner review markdown to docs/generated", () => {
    const md = dtpProposedLaddersMarkdown();
    expect(md).toContain("PROPOSED FOR OWNER APPROVAL — NOT ACTIVE");
    expect(md).toContain("## 8x5x2");
    mkdirSync(new URL("../docs/generated/", import.meta.url), { recursive: true });
    const path = new URL("../docs/generated/dtp-proposed-ladders-2026-10-07.md", import.meta.url);
    writeFileSync(path, md);
    expect(readFileSync(path, "utf8")).toBe(md);
  });
});
