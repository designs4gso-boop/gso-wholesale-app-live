// 2026-10-06 — DTP live economics: current Spektra wholesale cost vs the legacy
// seed, landed cost with the UNVERIFIED $85 freight, the CURRENT owner ladder
// GM / GP, and policy-derived PROPOSALS (not applied). Writes the analysis
// tables to docs/generated for the owner review.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DTP_COMPARABLE_CONFIG, LEGACY_SEED_VENDOR_UNIT, buildDtpLiveEconomics, dtpEconomicsCell, dtpLiveEconomicsMarkdown, legacySeedUnit } from "../app/lib/dtp-live-economics.server";
import { DTP_OWNER_PRICE_LADDERS, dtpHardFloorPct } from "../app/lib/dtp-owner-pricing.server";
import { lookupSpektraVendorCost } from "../app/lib/spektra-live-cost-book";

describe("DTP live economics (analysis only — ladders unchanged)", () => {
  it("comparable configuration matches the legacy product spec (soft-touch lamination, CR zipper included)", () => {
    expect(DTP_COMPARABLE_CONFIG).toMatchObject({ material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false, skuCount: 1 });
  });

  it("old seed reference matches the 15C seed and the owner ladders are untouched", () => {
    expect(LEGACY_SEED_VENDOR_UNIT["4x5x2"]).toEqual({ 1000: 0.9897, 2500: 0.4922, 5000: 0.4033, 7500: 0.3232 });
    expect(legacySeedUnit("4x5x2", 1500)).toBe(0.9897);
    expect(legacySeedUnit("4x5x2", 25000)).toBe(0.3232);
    expect(legacySeedUnit("5x5x2", 1000)).toBeNull();
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 }); // OWNER-APPROVED 2026-10-06 (+25k 2026-10-07)
  });

  it("4x5x2 x1000 (Soft Touch): live vendor $0.767362/unit vs old $0.9897 (-22.5%); landed includes art + $85 (unverified); APPROVED $1.30 ladder GM/GP + benchmark computed", () => {
    const c = dtpEconomicsCell("4x5x2", 1000);
    expect(c.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c.vendorUnit!).toBeCloseTo(0.767362, 5);
    expect(c.oldVendorUnit).toBe(0.9897);
    expect(c.oldVendorChangePct!).toBeCloseTo(-22.46, 1);
    expect(c.freightAssumption).toBe(85);
    expect(c.freightStatus).toBe("UNVERIFIED");
    expect(c.artCost).toBeCloseTo(8.3333, 3);
    expect(c.landedTotal!).toBeCloseTo(767.3625 + 8.3333 + 85, 1);
    expect(c.currentSellUnit).toBe(1.3);
    expect(c.currentGp!).toBeCloseTo(1300 - c.landedTotal!, 1); // ~$439
    expect(c.currentGmPct!).toBeCloseTo(((1300 - c.landedTotal!) / 1300) * 100, 0); // ~33.8%
    expect(c.hardFloorPct).toBe(dtpHardFloorPct(1000));
    expect(c.minJobProfit).toBe(350); // owner acquisition-tier exception
    expect(c.meetsProtection).toBe(true);
    expect(c.ladderStatus).toBe("OWNER_APPROVED");
    expect(c.pricingSource).toBe("OWNER_APPROVED_DTP_4X5_2026_10_06");
    expect(c.proposals).toEqual([]); // approved ladder is decided — no generic proposals
    expect(c.marketReference).toMatch(/Design & Customize/);
    expect(c.benchmark.competitorComparableUnit).toBeCloseTo(1.05, 6);
    expect(c.benchmark.premiumPct).toBeCloseTo(23.8, 1);
    // 2,500 keeps the normal $500 target and the approved price
    const c2 = dtpEconomicsCell("4x5x2", 2500);
    expect(c2.currentSellUnit).toBe(0.71);
    expect(c2.minJobProfit).toBe(500);
    expect(c2.meetsProtection).toBe(true);
    // 25,000: approved $0.30 (2026-10-07); above 25,000 no price
    const c25 = dtpEconomicsCell("4x5x2", 25000);
    expect(c25.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c25.currentSellUnit).toBe(0.3);
    expect(c25.ladderStatus).toBe("OWNER_APPROVED");
    expect(c25.meetsProtection).toBe(true);
  });

  it("new sizes (3.5x4.5x2, 5x5x2) now carry OWNER-APPROVED ladders (2026-10-07): no proposals, protection met", () => {
    const c = dtpEconomicsCell("5x5x2", 2500);
    expect(c.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c.currentSellUnit).toBe(0.75);
    expect(c.oldVendorUnit).toBeNull();
    expect(c.ladderStatus).toBe("OWNER_APPROVED");
    expect(c.proposals).toEqual([]);
    expect(c.meetsProtection).toBe(true);
    const c1 = dtpEconomicsCell("3.5x4.5x2", 1000);
    expect(c1.currentSellUnit).toBe(1.3);
    expect(c1.minJobProfit).toBe(350);
    expect(c1.meetsProtection).toBe(true);
  });

  it("500 units: vendor cost observed but the owner ladder has no price below 1,000 (MOQ retained)", () => {
    const c = dtpEconomicsCell("4x5x2", 500);
    expect(c.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c.currentSellUnit).toBeNull();
    expect(c.currentSellTierUsed).toBeNull();
  });

  it("vendor unit in the cell equals the cost-book lookup (no second arithmetic path)", () => {
    for (const q of [1000, 2500, 5000, 10000, 25000]) {
      const c = dtpEconomicsCell("8x5x2", q, "Glossy");
      const look = lookupSpektraVendorCost({ size: "8x5x2", material: "White PET", finish: "Glossy", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false, quantity: q, skuCount: 1 });
      expect(c.vendorUnit!).toBeCloseTo(look.wholesaleUnit!, 6);
    }
  });

  it("writes the owner review tables (Soft Touch comparable + Glossy lowest-cost) to docs/generated", () => {
    mkdirSync("docs/generated", { recursive: true });
    const soft = dtpLiveEconomicsMarkdown("Soft Touch");
    const glossy = dtpLiveEconomicsMarkdown("Glossy");
    writeFileSync("docs/generated/dtp-live-economics-soft-touch-2026-10-06.md", soft);
    writeFileSync("docs/generated/dtp-live-economics-glossy-2026-10-06.md", glossy);
    expect(soft).toContain("| 4x5x2 | 1,000 |");
    expect(buildDtpLiveEconomics().cells.length).toBe(30);
  });
});
