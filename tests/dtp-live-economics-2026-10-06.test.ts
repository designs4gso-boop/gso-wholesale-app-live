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
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).toEqual({ 1000: 1.67, 2500: 0.88, 5000: 0.74, 7500: 0.61, 10000: 0.6 });
  });

  it("4x5x2 x1000 (Soft Touch): live vendor $0.767362/unit vs old $0.9897 (-22.5%); landed includes art + $85 (unverified); current $1.67 ladder GM/GP computed", () => {
    const c = dtpEconomicsCell("4x5x2", 1000);
    expect(c.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c.vendorUnit!).toBeCloseTo(0.767362, 5);
    expect(c.oldVendorUnit).toBe(0.9897);
    expect(c.oldVendorChangePct!).toBeCloseTo(-22.46, 1);
    expect(c.freightAssumption).toBe(85);
    expect(c.freightStatus).toBe("UNVERIFIED");
    expect(c.artCost).toBeCloseTo(8.3333, 3);
    expect(c.landedTotal!).toBeCloseTo(767.3625 + 8.3333 + 85, 1);
    expect(c.currentSellUnit).toBe(1.67);
    expect(c.currentGp!).toBeCloseTo(1670 - c.landedTotal!, 1);
    expect(c.currentGmPct!).toBeCloseTo(((1670 - c.landedTotal!) / 1670) * 100, 0);
    expect(c.hardFloorPct).toBe(dtpHardFloorPct(1000));
    expect(c.proposals.map((p) => p.key)).toEqual(["hold_price", "hold_margin", "split"]);
    const hold = c.proposals[0];
    expect(hold.sellUnit).toBe(1.67);
    const pass = c.proposals[1];
    expect(pass.sellUnit).toBeLessThan(1.67); // vendor cost fell, so passing it through lowers the price
    expect(pass.sellUnit).toBeGreaterThan(c.landedUnit!);
    expect(c.proposals[2].sellUnit).toBeCloseTo((hold.sellUnit + pass.sellUnit) / 2, 4);
    expect(c.marketReference).toMatch(/NOT AVAILABLE/);
  });

  it("new sizes (3.5x4.5x2, 5x5x2) have vendor cost but no owner ladder: floor and target anchors only", () => {
    const c = dtpEconomicsCell("5x5x2", 2500);
    expect(c.vendorStatus).toBe("OBSERVED_VENDOR_PRICE");
    expect(c.currentSellUnit).toBeNull();
    expect(c.oldVendorUnit).toBeNull();
    expect(c.proposals.map((p) => p.key)).toEqual(["hold_margin", "split"]);
    expect(c.proposals[0].meetsFloor).toBe(true);
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
