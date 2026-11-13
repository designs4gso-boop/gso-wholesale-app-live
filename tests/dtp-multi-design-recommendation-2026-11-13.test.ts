// 2026-11-13 OWNER RULE — DTP recommendations consider TOTAL quantity AND
// quantity PER UNIQUE DESIGN. A fragmented multi-design job (3,840 over 30
// designs = 128 per design) gets DTP MANUAL REVIEW, never a DTP price shown as
// equivalent. Advisory only — no product switch, no quote block, no pricing change.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: "9001" }, admin: {} }) },
}));

const MATTE = {
  id: "m_matte", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", productFamilies: "labels,sticker_bags",
  unit: "sqft", baseUnit: "sqft", costPerUnit: 213 / 675, calculatedUnitCost: 213 / 675, purchaseCost: 213,
  rollWidthIn: 54, costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor",
};
const BAG_4X5 = { id: "v_bag", shop: "shop-1", name: "4x5 Sticker Bag Blank (Safe Care)", productType: "bag", vendor: "Safe Care", vendorSku: "preset:blank-4x5-bag", defaultUnitCost: 0.11, active: true, tiers: [], addOns: [] };

vi.mock("../app/db.server", async () => {
  const { CANONICAL_CALIBRATION_IDENTITIES } = await import("../app/lib/machine-routing.server");
  const MEASURED: Record<string, any> = {
    "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
    "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
    "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
    "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
  };
  const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]: any) => ({
    id: `cal_${key}`, shop: "shop-1", ...identity, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null,
    timeModel: "variable_only", measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved",
    source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date(0), ...MEASURED[key],
  }));
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (/^(create|update|upsert|delete)/.test(method)) return { id: `${name}_new` };
      const where = args?.where || {};
      if (name === "machineProfileCalibration" && method === "findMany") {
        return ROWS.filter((row: any) => Object.entries(where).every(([f, v]) => (f === "shop" ? true : row[f] === v)));
      }
      if (name === "material" && method === "findMany") return [MATTE];
      if (name === "material" && method === "findFirst") return where.id === MATTE.id ? MATTE : null;
      if (name === "vendorProduct" && method === "findMany") return [BAG_4X5];
      if (name === "vendorProduct" && method === "findFirst") return where.id === BAG_4X5.id ? BAG_4X5 : null;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any) => (typeof ops === "function" ? ops(db) : Promise.all(ops)) : model(key)) });
  return { default: db, db };
});

import { resolveOwnerResult } from "../app/lib/calculator-owner-view";
import { DTP_COMPARISON_LADDER_SKU, DTP_STATE_HEADLINE, dtpEquivalenceChecks, qualifyDtpComparison, quantityPerDesign } from "../app/lib/dtp-comparison-qualification.server";
import { DTP_OWNER_PRICE_LADDERS, ownerPriceForQuantity, priceDtpQuote } from "../app/lib/dtp-owner-pricing.server";

process.env.GSO_OWNER_SHOPIFY_USER_IDS = "9001";
const QS = (o: { qty: number; designs: number; sides: 1 | 2; split: boolean; gloss?: number; white?: number; printer?: string }) =>
  `pfamily=sticker-bags&pbagmat=matte${o.split ? "&psplitbag=1&pblank=preset%3Asplit-bag" : "&pblank=vendor%3Av_bag"}&pqty=${o.qty}&pfaces=${o.sides}&pbagsides=${o.sides}&pdesigns=${o.designs}&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=${o.printer || "roland"}&pwhitelayers=${o.white || 0}&pglosslayers=${o.gloss || 0}`;
async function load(qs: string) {
  const route: any = await import("../app/routes/app.erp.cost-calculator");
  const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) });
  const pm = data.emergency.productMode;
  const row = (pm.tiers || []).find((t: any) => t.requested);
  const owner = resolveOwnerResult({ family: pm.canonicalFamily, stockBag: Boolean(pm.stockBag), splitBag: Boolean(pm.splitBag), canonical: pm.canonical ? { status: pm.canonical.status, totalCost: pm.canonical.totalCost, unitCost: pm.canonical.unitCost, blockers: pm.canonical.blockers } : null, requestedRow: row, multiLine: pm.multiLine, marginRuleKey: pm.marginFamily?.key || null });
  return { pm, row, owner, adv: pm.dtpAdvisory };
}
const LIVE = { qty: 3840, designs: 30, sides: 2 as const, split: true, gloss: 1 };
const BASE = { crossover: "mild" as const, faces: 1, glossLayers: 0, whiteLayers: 0, materialName: "Poseidon Matte", splitBag: false, widthIn: 4, heightIn: 5, currentProduct: "Sticker Bag" };
const ROUTE_SRC = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

describe("DTP recommendation qualified for multi-design jobs (2026-11-13)", () => {
  it("1. 3,840 qty / 30 designs = 128 per design", () => {
    expect(quantityPerDesign(3840, 30)).toBe(128);
    expect(qualifyDtpComparison({ ...BASE, totalQuantity: 3840, designs: 30 })!.quantityPerDesign).toBe(128);
  });

  it("2 + 5 + 10. live Split Bag 3,840 / 30 / F+B / gloss -> DTP MANUAL REVIEW, no equivalent DTP price, no product switch", async () => {
    const { pm, adv } = await load(QS(LIVE));
    expect(adv.state).toBe("multi_design_review");
    expect(adv.headline).toBe("DTP MANUAL REVIEW REQUIRED — MULTI-DESIGN JOB");
    expect(adv.totalQuantity).toBe(3840);
    expect(adv.uniqueDesigns).toBe(30);
    expect(adv.quantityPerDesign).toBe(128);
    expect(adv.currentProduct).toBe("Split Bag");
    expect(adv.setupChangeoverModeled).toBe(false);
    expect(adv.setupChangeoverReasons.join(" ")).toMatch(/30 designs exceeds the 10 SKUs/);
    expect(adv.setupChangeoverReasons.join(" ")).toMatch(/128 per design is below the vendor's published 500-unit minimum run per SKU/);
    expect(adv.message).toMatch(/not considered equivalent for this job\. This order contains 30 unique designs at 128 units per design\. The current DTP comparison does not fully model per-design setup\/changeover burden\./);
    expect(adv.message).toMatch(/Split Bag remains ready to quote/);
    expect(adv.finishEquivalent).toBe(false);
    expect(adv.comparison).toBeNull(); // 5: never presented as equivalent
    expect(adv.singleDesignLadderReference.unitPrice).toBe(0.71);
    expect(adv.advisoryOnly).toBe(true);
    expect(adv.autoSwitchProduct).toBe(false); // 10
    expect(pm.splitBag).toBe(true);
    expect(pm.canonicalFamily).toBe("sticker-bags");
    expect(ROUTE_SRC).toContain("NOT an equivalent price for this job; do not quote from it");
    expect(ROUTE_SRC).not.toContain("Direct-print price check recommended at 2,500+ units.");
  }, 300000);

  it("3 + 4 + 17. the Split Bag stays READY TO QUOTE on the Sticker Bag ladder (pricing unchanged)", async () => {
    const { owner, row } = await load(QS(LIVE));
    expect(owner!.badge).toBe("READY TO QUOTE");
    expect(owner!.authority!.kind).toBe("split_bag_sticker_bag_ladder");
    expect(row.marginPct).toBe(49);
    // eb22219 pinned values: 3,800 / 30 / F+B / Roland = $1.4409 per bag at 49%.
    const pinned = await load(QS({ qty: 3800, designs: 30, sides: 2, split: true }));
    expect(Math.round(pinned.row.unitPrice * 10000) / 10000).toBe(1.4409);
    expect(pinned.row.marginPct).toBe(49);
    expect(pinned.adv.state).toBe("multi_design_review");
  }, 300000);

  it("6. 5,000 / 1 design standard 4x5 front-only -> normal DTP comparison with true cost and selling price", async () => {
    const { adv } = await load(QS({ qty: 5000, designs: 1, sides: 1, split: false }));
    expect(adv.state).toBe("valid_comparison");
    expect(adv.headline).toBe("DTP comparison available.");
    expect(adv.crossover).toBe("strong");
    expect(adv.comparison.unitPrice).toBe(0.46);
    expect(adv.comparison.total).toBeCloseTo(2300, 6);
    expect(adv.comparison.designFees).toBe(0);
    expect(adv.comparison.trueCost).toBeGreaterThan(0);
  }, 300000);

  it("7. 5,000 / 2 designs -> comparison still shown, with the existing DTP extra-design fee", async () => {
    const { adv } = await load(QS({ qty: 5000, designs: 2, sides: 1, split: false }));
    expect(adv.state).toBe("valid_comparison");
    expect(adv.quantityPerDesign).toBe(2500);
    expect(adv.setupChangeoverModeled).toBe(true);
    expect(adv.comparison.designFees).toBe(15);
    expect(adv.comparison.total).toBeCloseTo(2315, 6);
  }, 300000);

  it("8 + 9. state is driven by the actual design count and qty/design updates with it", async () => {
    const one = qualifyDtpComparison({ ...BASE, totalQuantity: 3840, designs: 1 })!;
    const thirty = qualifyDtpComparison({ ...BASE, totalQuantity: 3840, designs: 30 })!;
    expect(one.state).toBe("valid_comparison");
    expect(thirty.state).toBe("multi_design_review");
    const ten = await load(QS({ ...LIVE, designs: 10 }));
    expect(ten.adv.quantityPerDesign).toBe(384);
    expect(ten.adv.state).toBe("multi_design_review"); // 384 < published 500 per SKU
    const five = await load(QS({ ...LIVE, designs: 5 }));
    expect(five.adv.quantityPerDesign).toBe(768);
    expect(five.adv.setupChangeoverModeled).toBe(true);
    expect(five.adv.state).toBe("configuration_not_equivalent"); // Split Bag + gloss + F+B still not equivalent
  }, 300000);

  it("11 + 12 + 13. Front + Back, Gloss and White are each checked for equivalence", () => {
    const byKey = (checks: any[], key: string) => checks.find((c) => c.key === key);
    expect(dtpEquivalenceChecks({ faces: 1, glossLayers: 0, whiteLayers: 0, splitBag: false }).every((c) => c.equivalent)).toBe(true);
    expect(byKey(dtpEquivalenceChecks({ faces: 2, glossLayers: 0, whiteLayers: 0, splitBag: false }), "front_back").equivalent).toBe(false);
    expect(byKey(dtpEquivalenceChecks({ faces: 1, glossLayers: 1, whiteLayers: 0, splitBag: false }), "gloss").equivalent).toBe(false);
    expect(byKey(dtpEquivalenceChecks({ faces: 1, glossLayers: 0, whiteLayers: 1, splitBag: false }), "white").equivalent).toBe(false);
    const split = dtpEquivalenceChecks({ faces: 1, glossLayers: 0, whiteLayers: 0, splitBag: true });
    expect(byKey(split, "material_shape").equivalent).toBe(false);
    expect(byKey(split, "dimensions").equivalent).toBe(false);
    expect(byKey(dtpEquivalenceChecks({ faces: 1, glossLayers: 0, whiteLayers: 0, splitBag: false, widthIn: 6, heightIn: 5 }), "dimensions").equivalent).toBe(false);
  });

  it("14. a non-equivalent finish produces manual-review messaging, not a DTP price", async () => {
    const { adv } = await load(QS({ qty: 5000, designs: 1, sides: 1, split: false, gloss: 1 }));
    expect(adv.state).toBe("configuration_not_equivalent");
    expect(adv.headline).toBe(DTP_STATE_HEADLINE.configuration_not_equivalent);
    expect(adv.finishEquivalent).toBe(false);
    expect(adv.message).toMatch(/does not reproduce the requested configuration \(Gloss ×1\)/);
    expect(adv.comparison).toBeNull();
  }, 300000);

  it("volume trigger unchanged: no advisory below the 2,500 crossover band", async () => {
    expect(qualifyDtpComparison({ ...BASE, crossover: null, totalQuantity: 1000, designs: 1 })).toBeNull();
    const { adv } = await load(QS({ qty: 1000, designs: 1, sides: 1, split: false }));
    expect(adv).toBeNull();
  }, 300000);

  it("15 + 16 + 18. pricing engines unchanged: DTP ladder / priceDtpQuote; Standard 4x5 tiers independent of the advisory", async () => {
    expect(DTP_OWNER_PRICE_LADDERS[DTP_COMPARISON_LADDER_SKU]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 });
    expect(ownerPriceForQuantity(DTP_COMPARISON_LADDER_SKU, 3840)).toMatchObject({ tierUsed: 2500, unitPrice: 0.71 });
    const q = priceDtpQuote({ ladderSku: DTP_COMPARISON_LADDER_SKU, quantity: 5000, landedCost: 1500, missingCost: false, designs: 3, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 0, override: { phrase: "", reason: "" } });
    expect(q.customerTotal).toBeCloseTo(2330, 6);
    // Standard 4x5: 1 vs 30 designs flips the advisory state; the bags-4x5 rule and margin band stay the same.
    const one = await load(QS({ qty: 5000, designs: 1, sides: 1, split: false }));
    const many = await load(QS({ qty: 5000, designs: 30, sides: 1, split: false }));
    expect(one.adv.state).toBe("valid_comparison");
    expect(many.adv.state).toBe("multi_design_review");
    expect(one.pm.marginFamily.key).toBe("bags-4x5");
    expect(one.row.marginPct).toBe(50);
    expect(many.row.marginPct).toBe(50);
    expect(one.row.commercial.marketPosition.crossover).toBe("strong");
  }, 300000);
});
