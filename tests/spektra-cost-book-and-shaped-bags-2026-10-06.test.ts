// 2026-10-06 — Spektra live cost book (versioned, fail-closed) + owner
// shaped-pouch policy. The research CSV was NOT present when this was built,
// so observed-row behaviour is tested with injected rows shaped exactly like
// the generated artifact; the real artifact is pinned EMPTY and fail-closed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SPEKTRA_ACCOUNT_DISCOUNT_FACTOR,
  SPEKTRA_COST_BOOK_META,
  SPEKTRA_FINISHES,
  SPEKTRA_MATERIALS,
  SPEKTRA_OBSERVED_ROWS,
  SPEKTRA_PUBLISHED_TIERS,
  SPEKTRA_PUBLIC_EXTRA_SKU_FEE,
  SPEKTRA_SIZES,
  SPEKTRA_SPOT_OPTIONS,
  SPEKTRA_TOP_FEATURES,
  SPEKTRA_WHOLESALE_EXTRA_SKU_FEE,
  SPEKTRA_ZIPPER_OPTIONS,
  lookupSpektraVendorCost,
  publicTotalForSkuCount,
  spektraMatrixSummary,
  spotAllowedForFinish,
  validateSpektraConfiguration,
  wholesaleExtraSkuCost,
  wholesaleTotalFromPublicTotal,
  wholesaleUnitCost,
} from "../app/lib/spektra-live-cost-book";
import type { SpektraObservedRow } from "../app/lib/generated/spektra-live-price-matrix-2026-10-06";
import { DTP_CATALOG, SPEKTRA_FREIGHT_ASSUMPTION, dtpCatalogEntry, dtpSizeForVendorSku } from "../app/lib/dtp-catalog";
import {
  DTP_CUSTOM_SHAPE_SURCHARGE_PCT,
  DTP_NEW_DIE_TOOLING_FEE,
  applyShapedPolicyToDtpRow,
  priceShapedPouch,
  shapedQuotePresentation,
  toolingForShapes,
} from "../app/lib/dtp-shaped-bag-policy";
import { DTP_OWNER_PRICE_LADDERS, priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";
import { SPEKTRA_FREIGHT_PER_PO } from "../app/lib/product-driven-costing.server";

/* ------------------------------------------------------------------ */
describe("cost book metadata and catalog (VENDOR OBSERVED DATA)", () => {
  it("version, source, date, discount status, freight unverified, die-cut coming soon", () => {
    expect(SPEKTRA_COST_BOOK_META.sourceDate).toBe("2026-10-06");
    expect(SPEKTRA_COST_BOOK_META.source).toBe("Flex Packaging / Spektra public calculator");
    expect(SPEKTRA_COST_BOOK_META.discount).toMatchObject({ pct: 25, status: "OWNER_CONFIRMED_ACCOUNT_DISCOUNT" });
    expect(SPEKTRA_COST_BOOK_META.vendorProductPricing).toBe("LIVE_RESEARCH_2026_10_06");
    expect(SPEKTRA_COST_BOOK_META.freight.status).toBe("UNVERIFIED");
    expect(SPEKTRA_COST_BOOK_META.dieCut.publicStatus).toBe("COMING SOON");
    expect(SPEKTRA_COST_BOOK_META.includedInPublicPrice).toEqual(["setup", "prepress", "plates", "run charges"]);
  });

  it("all 5 sizes with capacity labels and 2 in gussets; 4 materials; 3 finishes; spot/zipper/top options; published tiers", () => {
    expect(SPEKTRA_SIZES.map((s) => [s.key, s.capacityLabel, s.gussetIn])).toEqual([
      ["3.5x4.5x2", "1 g", 2], ["4x5x2", "3.5 g", 2], ["5x5x2", "7 g", 2], ["6x5x2", "14 g", 2], ["8x5x2", "28 g", 2],
    ]);
    expect([...SPEKTRA_MATERIALS]).toEqual(["White PET", "Silver PET", "Hologram", "Clear PET"]);
    expect([...SPEKTRA_FINISHES]).toEqual(["Soft Touch", "Matte", "Glossy"]);
    expect([...SPEKTRA_SPOT_OPTIONS]).toEqual(["None", "Standard", "Raised UV"]);
    expect([...SPEKTRA_ZIPPER_OPTIONS]).toEqual(["None", "10 mm", "Child Resistant"]);
    expect([...SPEKTRA_TOP_FEATURES]).toEqual(["No Tear Notch", "Punch Hole", "Sombrero"]);
    expect([...SPEKTRA_PUBLISHED_TIERS]).toEqual([500, 1000, 2500, 5000, 10000, 25000]);
  });

  it("spot incompatibility: Glossy allows neither Standard nor Raised UV; Soft Touch and Matte allow both", () => {
    expect(spotAllowedForFinish("Glossy", "Standard")).toBe(false);
    expect(spotAllowedForFinish("Glossy", "Raised UV")).toBe(false);
    expect(spotAllowedForFinish("Glossy", "None")).toBe(true);
    for (const f of ["Soft Touch", "Matte"] as const) for (const s of ["None", "Standard", "Raised UV"] as const) expect(spotAllowedForFinish(f, s)).toBe(true);
    const bad = validateSpektraConfiguration({ size: "4x5x2", material: "White PET", finish: "Glossy", spot: "Raised UV", zipper: "None", topFeature: "No Tear Notch", clearGusset: false });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors[0]).toMatch(/not available on the Glossy laminate/);
  });

  it("the generated artifact is loaded from the research CSV (1,084 directly observed rows, none derived)", () => {
    expect(SPEKTRA_COST_BOOK_META.researchFilePresent).toBe(true);
    expect(SPEKTRA_COST_BOOK_META.rowCount).toBe(1084);
    expect(SPEKTRA_OBSERVED_ROWS.length).toBe(1084);
    const artifact = readFileSync("app/lib/generated/spektra-live-price-matrix-2026-10-06.ts", "utf8");
    expect(artifact).toContain("DIRECTLY OBSERVED");
    expect(artifact).not.toContain("NOT PRESENT");
  });
});

/* ------------------------------------------------------------------ */
describe("owner-confirmed discount rule and validated SKU rule", () => {
  it("wholesale = EXACT public total x 0.75; unit = discounted total / delivered qty (never from the rounded displayed unit)", () => {
    expect(SPEKTRA_ACCOUNT_DISCOUNT_FACTOR).toBe(0.75);
    expect(wholesaleTotalFromPublicTotal(1000)).toBe(750);
    expect(wholesaleTotalFromPublicTotal(1234.57)).toBeCloseTo(925.9275, 9); // fractional cents retained, never rounded
    expect(wholesaleUnitCost(1234.57, 1000)).toBeCloseTo(0.92593, 5);
    // a displayed unit of $1.23 x 1000 = $1,230 would give the WRONG answer ($922.50)
    expect(wholesaleTotalFromPublicTotal(1234.57)).not.toBeCloseTo(922.5, 2);
    expect(wholesaleUnitCost(1000, 0)).toBe(0);
  });

  it("extra SKU: $185 public, $138.75 wholesale; total(n) = total(1) + 185 x (n-1); validated at 1 / 2 / 5 / 10", () => {
    expect(SPEKTRA_PUBLIC_EXTRA_SKU_FEE).toBe(185);
    expect(SPEKTRA_WHOLESALE_EXTRA_SKU_FEE).toBe(138.75);
    expect(185 * 0.75).toBe(138.75);
    for (const [n, add] of [[1, 0], [2, 185], [5, 740], [10, 1665]] as const) {
      expect(publicTotalForSkuCount(1000, n)).toBe(1000 + add);
      expect(wholesaleExtraSkuCost(n)).toBe(add * 0.75);
      expect(wholesaleTotalFromPublicTotal(publicTotalForSkuCount(1000, n))).toBeCloseTo((1000 + add) * 0.75, 6);
    }
  });
});

/* ------------------------------------------------------------------ */
const ROW = (over: Partial<SpektraObservedRow> = {}): SpektraObservedRow => ({
  size: "4x5x2", material: "White PET", finish: "Glossy", spot: "None", zipper: "None", topFeature: "No Tear Notch", clearGusset: false,
  quantity: 1000, skuCount: 1, publicTotal: 1000, publicUnitDisplayed: 1.0, observedAt: "2026-10-06", note: null, ...over,
});
const CFG = { size: "4x5x2" as const, material: "White PET" as const, finish: "Glossy" as const, spot: "None" as const, zipper: "None" as const, topFeature: "No Tear Notch" as const, clearGusset: false };

describe("lookup — fails closed; observed vs estimated vs request quote", () => {
  it("with the real artifact every base combination (5 sizes x 4 materials x 3 finishes x 6 tiers, CR zipper) is OBSERVED; the empty-matrix path still fails closed", () => {
    for (const size of SPEKTRA_SIZES) for (const material of SPEKTRA_MATERIALS) for (const finish of SPEKTRA_FINISHES) for (const quantity of SPEKTRA_PUBLISHED_TIERS) {
      const look = lookupSpektraVendorCost({ ...CFG, size: size.key, material, finish, zipper: "Child Resistant", quantity });
      expect(look.status, `${size.key} ${material} ${finish} ${quantity}`).toBe("OBSERVED_VENDOR_PRICE");
      expect(look.wholesaleUnit!).toBeGreaterThan(0);
      expect(look.freightStatus).toBe("UNVERIFIED");
    }
    const empty = lookupSpektraVendorCost({ ...CFG, quantity: 1000 }, []);
    expect(empty.status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
    expect(empty.basis).toMatch(/No observed Spektra rows are loaded/);
  });

  it("exact observed row -> OBSERVED VENDOR PRICE with the discount applied to the exact public total", () => {
    const rows = [ROW({ publicTotal: 1234.57 })];
    const look = lookupSpektraVendorCost({ ...CFG, quantity: 1000 }, rows);
    expect(look.status).toBe("OBSERVED_VENDOR_PRICE");
    expect(look.publicTotal).toBe(1234.57);
    expect(look.wholesaleTotal).toBeCloseTo(925.9275, 9);
    expect(look.wholesaleUnit).toBeCloseTo(0.92593, 5);
    expect(look.observedRow).toBe(rows[0]);
  });

  it("every option axis is part of the key (zipper / top feature / clear gusset / spot / material / finish / size / quantity / SKUs)", () => {
    const rows = [ROW()];
    const variants: Array<Partial<SpektraObservedRow>> = [
      { zipper: "10 mm" }, { zipper: "Child Resistant" }, { topFeature: "Punch Hole" }, { topFeature: "Sombrero" }, { clearGusset: true },
      { spot: "Standard", finish: "Matte" }, { spot: "Raised UV", finish: "Soft Touch" }, { material: "Hologram" }, { material: "Silver PET" }, { material: "Clear PET" },
      { finish: "Matte" }, { finish: "Soft Touch" }, { size: "8x5x2" }, { size: "3.5x4.5x2" }, { size: "5x5x2" }, { size: "6x5x2" }, { quantity: 2500 }, { quantity: 550 },
    ];
    for (const v of variants) {
      const q = { ...CFG, quantity: 1000, ...v } as any;
      expect(lookupSpektraVendorCost(q, rows).status, JSON.stringify(v)).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
      const withRow = lookupSpektraVendorCost(q, [ROW({ ...v, publicTotal: 2000 })]);
      expect(withRow.status, JSON.stringify(v)).toBe("OBSERVED_VENDOR_PRICE");
      expect(withRow.wholesaleTotal).toBe(1500);
    }
  });

  it("10 mm and Child Resistant are NOT assumed equal: each needs its own observed row", () => {
    const rows = [ROW({ zipper: "10 mm", publicTotal: 1100 })];
    expect(lookupSpektraVendorCost({ ...CFG, zipper: "10 mm", quantity: 1000 }, rows).status).toBe("OBSERVED_VENDOR_PRICE");
    expect(lookupSpektraVendorCost({ ...CFG, zipper: "Child Resistant", quantity: 1000 }, rows).status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
  });

  it("2 / 5 / 10 SKUs from a 1-SKU row -> ESTIMATED FROM VALIDATED VENDOR RULE; an exact multi-SKU row wins as OBSERVED", () => {
    const rows = [ROW({ publicTotal: 1000 }), ROW({ skuCount: 5, publicTotal: 1740 })];
    const two = lookupSpektraVendorCost({ ...CFG, quantity: 1000, skuCount: 2 }, rows);
    expect(two.status).toBe("ESTIMATED_FROM_VALIDATED_VENDOR_RULE");
    expect(two.publicTotal).toBe(1185);
    expect(two.wholesaleTotal).toBeCloseTo(888.75, 9);
    expect(two.wholesaleExtraSkuCost).toBe(138.75);
    const five = lookupSpektraVendorCost({ ...CFG, quantity: 1000, skuCount: 5 }, rows);
    expect(five.status).toBe("OBSERVED_VENDOR_PRICE");
    expect(five.publicTotal).toBe(1740);
    const ten = lookupSpektraVendorCost({ ...CFG, quantity: 1000, skuCount: 10 }, rows);
    expect(ten.status).toBe("ESTIMATED_FROM_VALIDATED_VENDOR_RULE");
    expect(ten.publicTotal).toBe(1000 + 185 * 9);
  });

  it("custom quantities are never interpolated: 999 / 1100 / 1200 / 7500 need their own observed row", () => {
    const rows = [ROW({ quantity: 1000, publicTotal: 1000 }), ROW({ quantity: 2500, publicTotal: 2000 })];
    for (const q of [999, 1100, 1200, 7500, 1500]) {
      const look = lookupSpektraVendorCost({ ...CFG, quantity: q }, rows);
      expect(look.status, String(q)).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
      expect(look.basis, String(q)).toMatch(/no observed row|no interpolation/);
    }
    expect(lookupSpektraVendorCost({ ...CFG, quantity: 1100 }, [...rows, ROW({ quantity: 1100, publicTotal: 1090 })]).status).toBe("OBSERVED_VENDOR_PRICE");
  });

  it("an unsupported configuration (Glossy + spot) or an unknown size never gets a price", () => {
    const rows = [ROW({ finish: "Glossy", spot: "Standard", publicTotal: 999 })]; // even if a bogus row existed, validation refuses it
    expect(lookupSpektraVendorCost({ ...CFG, finish: "Glossy", spot: "Standard", quantity: 1000 }, rows).status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
    expect(lookupSpektraVendorCost({ ...CFG, size: "5x4x2" as any, quantity: 1000 }, rows).status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
  });

  it("matrix summary describes coverage", () => {
    const s = spektraMatrixSummary([ROW(), ROW({ size: "8x5x2", quantity: 2500, skuCount: 2 })]);
    expect(s).toMatchObject({ rowCount: 2, sizes: ["4x5x2", "8x5x2"], quantities: [1000, 2500], skuCounts: [1, 2] });
    expect(spektraMatrixSummary().rowCount).toBe(1084);
  });
});

/* ------------------------------------------------------------------ */
describe("DTP catalog status and freight assumption", () => {
  it("five current standard sizes; 5x4x2 is LEGACY with no current match and no remap", () => {
    expect(DTP_CATALOG.filter((e) => e.status === "CURRENT_STANDARD").map((e) => e.size)).toEqual(["3.5x4.5x2", "4x5x2", "5x5x2", "6x5x2", "8x5x2"]);
    expect(dtpCatalogEntry("5x4x2")).toMatchObject({ status: "LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH", vendorSku: "spektra-dtp-5x4x2", vendorCost: "LEGACY_SEED_ONLY" });
    expect(dtpSizeForVendorSku("spektra-dtp-5x4x2")!.size).toBe("5x4x2");
    expect(dtpSizeForVendorSku("spektra-dtp-4x5x2")!.size).toBe("4x5x2");
    expect(dtpCatalogEntry("5x4x2")!.note).toMatch(/Do NOT map to 4x5x2 or 5x5x2/);
  });

  it("new sizes have no owner sell ladder (owner decision) and the legacy ladders are untouched", () => {
    expect(dtpCatalogEntry("3.5x4.5x2")!.ownerLadder).toBe("NONE_OWNER_DECISION_REQUIRED");
    expect(dtpCatalogEntry("5x5x2")!.ownerLadder).toBe("NONE_OWNER_DECISION_REQUIRED");
    expect(Object.keys(DTP_OWNER_PRICE_LADDERS).sort()).toEqual(["spektra-dtp-4x5x2", "spektra-dtp-5x4x2", "spektra-dtp-6x5x2", "spektra-dtp-8x5x2"]);
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37 }); // OWNER-APPROVED 2026-10-06
  });

  it("freight: the $85 runtime assumption is unchanged but labelled UNVERIFIED everywhere it is surfaced", () => {
    expect(SPEKTRA_FREIGHT_PER_PO).toBe(85);
    expect(SPEKTRA_FREIGHT_ASSUMPTION).toMatchObject({ amount: 85, status: "UNVERIFIED", label: "FREIGHT ASSUMPTION — OWNER / VENDOR CONFIRMATION NEEDED" });
    const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(calc).toContain("SPEKTRA_FREIGHT_ASSUMPTION.label");
    expect(calc).toContain("freightAssumption: SPEKTRA_FREIGHT_ASSUMPTION");
    // the existing freight line is still produced once (no silent removal)
    const quote = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: 1000, landedCost: 1200, missingCost: false, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: true, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(quote.customerFreight).toBe(85);
  });
});

/* ------------------------------------------------------------------ */
describe("owner shaped-pouch policy (OWNER DECISION 2026-10-06)", () => {
  it("standard $1000 product -> custom shape $1100 (+10%); new die adds exactly $700 as a separate line", () => {
    expect(DTP_CUSTOM_SHAPE_SURCHARGE_PCT).toBe(10);
    expect(DTP_NEW_DIE_TOOLING_FEE).toBe(700);
    const std = priceShapedPouch({ shape: "standard", quantity: 1000, standardProductTotal: 1000 });
    expect(std).toMatchObject({ productTotal: 1000, shapeSurcharge: 0, toolingFee: 0, total: 1000, unitPrice: 1 });
    const custom = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000, die: { mode: "new" } });
    expect(custom).toMatchObject({ shapeSurcharge: 100, productTotal: 1100, toolingRequired: true, toolingFee: 700, total: 1800, errors: [] });
    expect(custom.unitPrice).toBeCloseTo(1100 / 2500, 9); // tooling is NOT inside the unit price
    expect(custom.lines.map((l) => [l.key, l.amount])).toEqual([["product", 1000], ["shape_surcharge", 100], ["tooling", 700]]);
  });

  it("5 or 10 designs on ONE shape pay one $700 die; 2 unique shapes pay $1,400; 3 pay $2,100", () => {
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "new" }, designs: 5 }]).toolingFee).toBe(700);
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "new" }, designs: 10 }]).toolingFee).toBe(700);
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "new" } }, { shapeKey: "S1", die: { mode: "new" } }]).toolingFee).toBe(700); // same shape twice = one die
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "new" } }, { shapeKey: "S2", die: { mode: "new" } }]).toolingFee).toBe(1400);
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "new" } }, { shapeKey: "S2", die: { mode: "new" } }, { shapeKey: "S3", die: { mode: "new" } }]).toolingFee).toBe(2100);
  });

  it("reorder on the same existing die: $0 tooling, surcharge still +10%", () => {
    const re = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000, die: { mode: "existing", dieId: "DIE-0007" } });
    expect(re).toMatchObject({ toolingRequired: false, toolingFee: 0, shapeSurcharge: 100, productTotal: 1100, total: 1100, dieId: "DIE-0007", errors: [] });
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "existing", dieId: "DIE-0007" } }])).toMatchObject({ toolingFee: 0, reusedShapes: 1, errors: [] });
  });

  it("artwork and SKU-count changes never create a die by themselves; a new physical shape does", () => {
    // the policy functions take no artwork/SKU inputs for tooling: identical results across design counts
    const a = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000, die: { mode: "existing", dieId: "DIE-0007" } });
    const b = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000 + 25 * 4, die: { mode: "existing", dieId: "DIE-0007" } }); // 5 SKUs: design fees change the product, not the die
    expect(a.toolingFee).toBe(0);
    expect(b.toolingFee).toBe(0);
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "existing", dieId: "DIE-0007" } }, { shapeKey: "S9", die: { mode: "new" } }]).toolingFee).toBe(700);
  });

  it("existing-die claims without an ID or reference fail closed; dimensions never auto-match", () => {
    const bad = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000, die: { mode: "existing" } });
    expect(bad.errors[0]).toMatch(/requires a Die ID \/ Shape ID or a clear staff reference/);
    expect(bad.toolingFee).toBe(0);
    const ref = priceShapedPouch({ shape: "custom", quantity: 2500, standardProductTotal: 1000, die: { mode: "existing", reference: "Acme 4x5 wave, job 1234" } });
    expect(ref.errors).toEqual([]);
    expect(toolingForShapes([{ shapeKey: "S1", die: { mode: "existing" } }]).errors.length).toBe(1);
  });

  it("no double charge: surcharge is on the product price only (not on tooling), tooling is one line, setup/plates are never added", () => {
    const p = priceShapedPouch({ shape: "custom", quantity: 2000, standardProductTotal: 2000, die: { mode: "new" } });
    expect(p.shapeSurcharge).toBe(200); // 10% of 2000, NOT of 2700
    expect(p.lines.filter((l) => l.key === "tooling").length).toBe(1);
    expect(p.lines.some((l) => /setup|prepress|plate/i.test(l.label))).toBe(false);
    expect(p.lines.find((l) => l.key === "product")!.note).toMatch(/never added again/);
    expect(p.total).toBe(2000 + 200 + 700);
  });

  it("applyShapedPolicyToDtpRow: surcharge on base + design fees, tooling excluded from profit, SKU fees not surcharged twice", () => {
    // 2026-10-06 approved 4x5x2 anchor at the shaped MOQ (2,500): $0.71 -> shaped $0.781
    const row = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "custom", die: { mode: "new" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 100, customerTotal: 1875, grossProfit: 700 });
    expect(row.shaped.shapeSurcharge).toBe(187.5); // 10% of (1775 + 100)
    expect(row.unitPrice).toBeCloseTo(0.781, 9);
    expect(row.totalPrice).toBe(1875 + 187.5 + 700);
    expect(row.profit).toBe(887.5); // tooling is pass-through, not profit
    expect(row.marginPct).toBeCloseTo((887.5 / 2062.5) * 100, 6);
    expect(row.blocked).toBe(false);
    const standard = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "standard", die: { mode: "none" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 0, customerTotal: 1775, grossProfit: 400 });
    expect(standard).toMatchObject({ unitPrice: 0.71, totalPrice: 1775, profit: 400, blocked: false });
    const blocked = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "custom", die: { mode: "existing" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 0, customerTotal: 1775, grossProfit: 400 });
    expect(blocked.blocked).toBe(true);
    // shaped MOQ 2,500: a 1,000-unit shaped request is blocked (standard 1,000 stays allowed)
    const belowMoq = applyShapedPolicyToDtpRow({ quantity: 1000, shape: "custom", die: { mode: "new" }, ladderUnitPrice: 1.3, customerBaseSubtotal: 1300, extraDesignFees: 0, customerTotal: 1300, grossProfit: 439 });
    expect(belowMoq.blocked).toBe(true);
    expect(belowMoq.reasons.join(" ")).toContain("2,500");
  });

  it("customer presentation keeps tooling as a separate block", () => {
    const lines = shapedQuotePresentation(priceShapedPouch({ shape: "custom", quantity: 5000, standardProductTotal: 3700, die: { mode: "new" } }));
    expect(lines[0]).toBe("CUSTOM SHAPED POUCHES");
    expect(lines).toContain("Custom shape surcharge +10%");
    expect(lines).toContain("CUSTOM TOOLING");
    expect(lines).toContain("New reusable custom die: $700.00");
    expect(lines).toContain("Quote total: $4770.00");
    expect(lines.find((l) => l.startsWith("Unit price"))).toBe("Unit price: $0.81");
  });
});

/* ------------------------------------------------------------------ */
describe("calculator wiring and historical snapshot safety", () => {
  const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
  it("shape / die controls exist and both pricing paths apply the policy (parity)", () => {
    for (const field of ["pdtpshape", "pdtpdie", "pdtpdieid", "pdtpdieref", "pdtpmaterial", "pdtpfinish", "pdtpspot", "pdtpzipper", "pdtptop", "pdtpgusset"]) expect(calc).toContain(`name="${field}"`);
    expect(calc.split("lookupSpektraVendorCost({").length - 1).toBe(2); // live economics in loader + save (display + snapshot only)
    expect(calc).toContain("LIVE SPEKTRA ECONOMICS");
    expect(calc).toContain("not yet the quote cost authority");
    expect(calc).toContain("NEW SHAPE — NEW $700 DIE");
    expect(calc).toContain("EXISTING SHAPE / DIE ON FILE");
    expect(calc.split("applyShapedPolicyToDtpRow({").length - 1).toBe(2);
    expect(calc).toContain("CUSTOM TOOLING");
    expect(calc).toContain("LEGACY SIZE — NO CURRENT STANDARD CATALOG MATCH");
  });
  it("old DTP snapshots are plain JSON the new policy never rewrites", () => {
    const old = JSON.parse(JSON.stringify({ engine: "product-driven/15F.0-production-ready-pricing", tiers: [{ qty: 1000, unitPrice: 1.67, marginPct: 40 }], freight: { total: 85, source: "verified" }, dtp: { vendorTierLabel: "Spektra DTP 4x5x2 tier 1,000-2,499 @ $0.9897" } }));
    const before = JSON.stringify(old);
    priceShapedPouch({ shape: "custom", quantity: 1000, standardProductTotal: 1670, die: { mode: "new" } });
    lookupSpektraVendorCost({ ...CFG, quantity: 1000 });
    expect(JSON.stringify(old)).toBe(before);
    expect(old.freight.total).toBe(85);
    expect(old.tiers[0].unitPrice).toBe(1.67);
  });
});
