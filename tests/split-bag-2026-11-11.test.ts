// 2026-11-11 — SPLIT BAG (OWNER CORRECTION): a Sticker Bag blank / bag type.
//
// Owner authority: ONE physical bag, MOQ 64 (2026-11-12: $0.14 vendor blank + $0.024 inbound freight line; supersedes $0.25). Labels follow the
// normal Sticker Bag rule — ONE label per printed side (2026-11-12: the Split
// Bag label is its own 7.20 x 4.38 art / 7.07 x 4.26 cutline, not the 4x5):
//   front only / back only  1 blank, 1 label, 1 cut/weed, 1 application event
//   front + back            1 blank, 2 labels, 2 cuts/weeds, 2 application events
// Never 4 labels on one Split Bag (the earlier 2-per-side model was wrong).
// The 4x5 artboard / 3.79 x 4.81 cutline / 10 s-per-label application standard,
// selected material, ink, routing and setup are the Sticker Bag engine's. No Split Bag selling ladder
// exists yet, so its price is PROVISIONAL (owner job-level price) — the 4x5
// Sticker Bag curve is never applied to it, and 4x5 prices are unchanged.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

const MATTE = {
  id: "m_matte", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", productFamilies: "labels,sticker_bags",
  unit: "sqft", baseUnit: "sqft", costPerUnit: 213 / 675, calculatedUnitCost: 213 / 675, purchaseCost: 213,
  rollWidthIn: 54, costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor",
};
const BAG_4X5 = { id: "v_bag", shop: "shop-1", name: "4x5 Sticker Bag Blank (Safe Care)", productType: "bag", vendor: "Safe Care", vendorSku: "preset:blank-4x5-bag", defaultUnitCost: 0.11, active: true, tiers: [], addOns: [] };
const dbState: { writes: Array<{ op: string; args: any }> } = { writes: [] };

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
      if (/^(create|update|upsert|delete)/.test(method)) { dbState.writes.push({ op: `${name}.${method}`, args }); return { id: `${name}_new` }; }
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

import db from "../app/db.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import {
  BAG_4X5_BLANK_UNIT_COST,
  BAG_4X5_CUTLINE_IN,
  SPLIT_BAG_BLANK_UNIT_COST,
  SPLIT_BAG_MOQ,
  bagApplicationCost,
  bagLabelPositionsPerSide,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_DISPATCH, CANONICAL_FAMILIES, CANONICAL_PACKOUT } from "../app/lib/canonical-calculator-shared";
import { familyCostModel } from "../app/lib/canonical-quote-authority.server";
import {
  SPLIT_BAG_CALCULATOR_OPTION,
  SPLIT_BAG_PRICE_AUTHORITY_TEXT,
  calculatorFamilyChoice,
  calculatorFamilyParams,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
} from "../app/lib/calculator-owner-view";
import { getProductProductionSpec } from "../app/lib/product-production-spec";
import { PROVISIONAL_PRICING_STATUS } from "../app/lib/quote-pricing-authority";

beforeEach(() => {
  process.env[OWNER_USER_IDS_ENV] = "9001";
  authState.sub = "9001";
  dbState.writes = [];
});
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; });

const SPLIT_QS = (sides: 1 | 2, qty = 1000) =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=1&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;

async function costJob(qs: string) {
  const input = normalizeCanonicalInput(new URLSearchParams(qs))!;
  const machine = await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input);
  return { input, result: assembleCanonicalJob(input, machine) };
}
const amount = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount;

describe("Split Bag physical model (bag adapter)", () => {
  it("1/2. front only (or back only — one printed side): ONE $0.14 vendor blank, ONE label, ONE application event per bag", () => {
    const r = computeBagPhysical({ product: "split_bag", bagQuantity: 1000, sides: 1 });
    expect(SPLIT_BAG_BLANK_UNIT_COST).toBe(0.14);
    expect(r.blankCost).toBeCloseTo(1000 * 0.14, 10);
    expect(r.positionsPerSide).toBe(1);
    expect(r.labelQuantity).toBe(1000);
    expect(r.application.applicationEvents).toBe(1000);
    expect(r.application.applicationsPerItem).toBe(1);
  });

  it("3. front + back: ONE $0.14 vendor blank, TWO labels, TWO application events per bag", () => {
    const r = computeBagPhysical({ product: "split_bag", bagQuantity: 1000, sides: 2 });
    expect(r.blankCost).toBeCloseTo(140, 10);
    expect(r.labelQuantity).toBe(2000);
    expect(r.application.applicationEvents).toBe(2000);
    expect(bagApplicationCost(1000, 2, "split_bag")).toBeCloseTo(2000 * 10 / 3600 * 20, 10);
  });

  it("4. never 4 labels (or 2 per side) on one Split Bag", () => {
    expect(bagLabelPositionsPerSide("split_bag")).toBe(1);
    for (const sides of [1, 2] as const) {
      const r = computeBagPhysical({ product: "split_bag", bagQuantity: 1, sides });
      expect(r.labelQuantity).toBe(sides);
      expect(r.labelQuantity).toBeLessThan(4);
    }
  });

  it("label COUNT and application events match a 4x5 Sticker Bag of the same sides; geometry is the larger Split Bag label (2026-11-12)", () => {
    expect(BAG_4X5_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 }); // owner 4x5 cutline (2026-11-11)
    for (const sides of [1, 2] as const) {
      const split = computeBagPhysical({ product: "split_bag", bagQuantity: 1000, sides });
      const fourX5 = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides });
      expect(split.labelQuantity).toBe(fourX5.labelQuantity);
      expect(split.finishing.cutPathIn).toBeCloseTo(1000 * sides * 2 * (7.07 + 4.26), 6);
      expect(split.nesting.materialFootprintSqft).toBeGreaterThan(fourX5.nesting.materialFootprintSqft);
      expect(split.application.applicationEvents).toBe(fourX5.application.applicationEvents);
      expect(split.blankCost).toBeCloseTo(1000 * 0.14, 10);
      expect(fourX5.blankCost).toBeCloseTo(1000 * 0.11, 10);
    }
  });

  it("the 4x5 Sticker Bag and Stock Bag are unchanged", () => {
    const bag = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(bag.blankCost).toBeCloseTo(110, 10);
    expect(bag.labelQuantity).toBe(2000);
    expect(computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 }).labelQuantity).toBe(2000);
    expect(bagApplicationCost(1000, 2)).toBeCloseTo(2000 * 10 / 3600 * 20, 10);
  });

  it("5. owner Split Bag MOQ is 64 (2026-11-11); the 4x5 MOQ blockers never apply to it", () => {
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 63, sides: 1 }).blockers.join(" ")).toContain("SPLIT_BAG_BELOW_MOQ");
    const small = computeBagPhysical({ product: "split_bag", bagQuantity: 10, sides: 1 });
    expect(small.blockers.join(" ")).toContain("SPLIT_BAG_BELOW_MOQ");
    expect(small.blockers.join(" ")).not.toMatch(/STICKER_BAG_BELOW_MOQ|STOCK_BAG_BELOW_MOQ/);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 64, sides: 1 }).blockers).toEqual([]);
  });
});

describe("Split Bag in the canonical calculator", () => {
  it("is its own canonical family on the same bag adapter, with canonical save authority", () => {
    expect(CANONICAL_FAMILIES).toContain("split-bags");
    expect(CANONICAL_DISPATCH["split-bags"].entry).toBe("computeBagPhysical(product: split_bag)");
    expect(familyCostModel("split-bags")).toBe("CANONICAL_COST_AUTHORITY");
    // no box count was approved: disclosed, never borrowed from the 4x5 rule
    expect(CANONICAL_PACKOUT["split-bags"].unitsPerBox).toBeNull();
    expect(getProductProductionSpec("split-bags", "split-bag")?.displayName).toMatch(/^Split Bag/);
  });

  it("psplitbag=1 selects split-bags; Stock Bags win if both flags are posted", () => {
    expect(normalizeCanonicalInput(new URLSearchParams(SPLIT_QS(1)))!.family).toBe("split-bags");
    expect(normalizeCanonicalInput(new URLSearchParams(`${SPLIT_QS(1)}&pstockbag=1`))!.family).toBe("stock-bags");
    expect(normalizeCanonicalInput(new URLSearchParams(SPLIT_QS(1).replace("&psplitbag=1", "")))!.family).toBe("sticker-bags");
  });

  for (const sides of [1, 2] as const) {
    it(`6/9. ${sides === 1 ? "one side" : "front + back"}: $0.14 vendor blank line, ${sides} label(s)/bag of application, Split Bag identity`, async () => {
      const { result } = await costJob(SPLIT_QS(sides));
      expect(result.status).not.toBe("DRAFT_ONLY");
      expect(result.unitCost).toBeGreaterThan(0);
      expect(result.blockers).toEqual([]);
      const production = result.trueCost.lines.find((l: any) => l.key === "blank_sets")!;
      expect(production.amount).toBeCloseTo(1000 * 0.14, 6);
      expect(amount(result, "application")).toBeCloseTo(1000 * sides * 10 / 3600 * 20, 6);
      expect(result.diagnostics.applicationEvents).toBe(1000 * sides);
      expect(result.diagnostics.applicationBreakdown?.totalLabels).toBe(1000 * sides);
      expect(result.diagnostics.productSpec?.productKey).toBe("split-bag");
      for (const key of ["print_media", "ink", "machine", "cutting_machine", "weeding", "art_setup", "print_setup"]) expect(amount(result, key), key).toBeGreaterThan(0);
      // packout has no approved box count — disclosed, not invented
      expect(result.reasons).toContain("PACKOUT_NOT_MODELED");
    }, 120_000);
  }

  it("double-sided costs more than single-sided only in labels — the blank line is identical", async () => {
    const one = (await costJob(SPLIT_QS(1))).result;
    const two = (await costJob(SPLIT_QS(2))).result;
    expect(amount(one, "blank_sets")).toBeCloseTo(amount(two, "blank_sets"), 10);
    expect(amount(two, "application")).toBeCloseTo(amount(one, "application") * 2, 10);
    expect(two.totalCost).toBeGreaterThan(one.totalCost);
  }, 120_000);

  it("8. White/Gloss routing follows the normal Sticker Bag rules", async () => {
    // AUTO: the Roland is the only press with an approved White calibration (2026-11-11)
    const white = SPLIT_QS(1).replace("pprinter=mimaki", "pprinter=auto").replace("pwhitelayers=0", "pwhitelayers=1&pwhitecoverage=80");
    const { result } = await costJob(white);
    expect(result.routing.effectivePrinter).toBe("roland");
    expect(amount(result, "ink_white")).toBeGreaterThan(0);
    const sticker = (await costJob(white.replace("&psplitbag=1", "").replace("pblank=preset%3Asplit-bag", "pblank=v_bag"))).result;
    expect(sticker.routing.effectivePrinter).toBe(result.routing.effectivePrinter);
    // Gloss forces the Roland on a Split Bag exactly as on a 4x5 Sticker Bag
    const gloss = SPLIT_QS(1).replace("pprinter=mimaki", "pprinter=auto").replace("pglosslayers=0", "pglosslayers=1&pglosscoverage=50");
    expect((await costJob(gloss)).result.routing.effectivePrinter).toBe("roland");
    // Mimaki + Gloss is refused on a Split Bag just like any Sticker Bag
    const mimakiGloss = (await costJob(SPLIT_QS(1).replace("pglosslayers=0", "pglosslayers=1&pglosscoverage=50"))).result;
    expect(mimakiGloss.reasons).toContain("MIMAKI_GLOSS_UNSUPPORTED");
  }, 120_000);

  it("Split Bag shares the Sticker Bag setup / application costing; its larger label raises media, ink, machine and cutting; blank $0.14 (+ $0.024 freight) vs $0.11", async () => {
    for (const sides of [1, 2] as const) {
      const split = (await costJob(SPLIT_QS(sides))).result;
      const sticker = (await costJob(SPLIT_QS(sides).replace("&psplitbag=1", "").replace("pblank=preset%3Asplit-bag", "pblank=v_bag"))).result;
      expect(sticker.family).toBe("sticker-bags");
      for (const key of ["application", "art_setup", "print_setup"]) {
        expect(amount(split, key), key).toBeCloseTo(amount(sticker, key), 6);
      }
      for (const key of ["print_media", "ink", "machine", "cutting_machine"]) {
        expect(amount(split, key), key).toBeGreaterThan(amount(sticker, key));
      }
      expect(amount(split, "blank_sets")).toBeCloseTo(1000 * 0.14, 6);
      expect(amount(sticker, "blank_sets")).toBeCloseTo(1000 * 0.11, 6);
    }
  }, 120_000);

  it("7. the selected label material changes the label true cost", async () => {
    const matte = (await costJob(SPLIT_QS(1))).result;
    const gloss = (await costJob(SPLIT_QS(1).replace("pbagmat=matte", "pbagmat=gloss"))).result;
    const holo = (await costJob(SPLIT_QS(1).replace("pbagmat=matte", "pbagmat=holographic"))).result;
    expect(amount(holo, "print_media")).not.toBeCloseTo(amount(matte, "print_media"), 6);
    expect([amount(gloss, "print_media"), amount(holo, "print_media")].some((v) => Math.abs(v - amount(matte, "print_media")) > 1e-6)).toBe(true);
    expect(amount(holo, "blank_sets")).toBeCloseTo(amount(matte, "blank_sets"), 10); // the blank never moves with media
  }, 120_000);

  it("a posted pblankcost can no longer change any bag's blank cost", async () => {
    const forged = (await costJob(`${SPLIT_QS(1)}&pblankcost=0`)).result;
    expect(amount(forged, "blank_sets")).toBeCloseTo(140, 6);
    const forged4x5 = (await costJob("pfamily=sticker-bags&pbagmat=matte&pqty=1000&pbagsides=1&pdesigns=1&pprinter=mimaki&pblankcost=0")).result;
    expect(amount(forged4x5, "blank_sets")).toBeCloseTo(1000 * 0.11, 6);
  }, 120_000);
});

describe("Split Bag selling price stays PROVISIONAL; 4x5 prices unchanged", () => {
  const row = { quantity: 1000, requested: true, jobCost: 400, unitCost: 0.4, unitPrice: 0.9, totalPrice: 900, profit: 500, actualMarginPct: 55, marginPct: 55, belowFloor: false, draftOnly: false, freightTotal: 0, floorPct: 45, blockers: [], status: "READY TO QUOTE", commercial: { controllingRule: "curve", marginSource: "researched curve", ownerLadder: null } };

  it("no approved Split Bag authority — the 4x5 curve is never presented as its price", () => {
    const split = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: "bags-4x5", row });
    expect(split).toMatchObject({ approved: false, kind: "none", missing: SPLIT_BAG_PRICE_AUTHORITY_TEXT });
    const result = resolveOwnerResult({ family: "sticker-bags", splitBag: true, canonical: { status: "VALID", totalCost: 400, unitCost: 0.4, blockers: [] }, requestedRow: row, multiLine: null, marginRuleKey: "bags-4x5" })!;
    expect(result.badge).toBe(PROVISIONAL_PRICING_STATUS);
    expect(result.trueJobCost).toBe(400);
    expect(result.recommendedTotal).toBeNull();
  });

  it("4x5 Sticker Bags keep their existing approved authority", () => {
    const bag = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, marginRuleKey: "bags-4x5", row });
    expect(bag.approved).toBe(true);
  });

  it("Split Bag is a Sticker Bags -> Blank / bag type choice, not its own category", () => {
    expect(calculatorFamilyParams(SPLIT_BAG_CALCULATOR_OPTION.value)).toEqual({ pfamily: "sticker-bags", pstockbag: null, psplitbag: "1" });
    expect(calculatorFamilyChoice("sticker-bags", null, "1")).toBe("split-bags");
    expect(calculatorFamilyChoice("sticker-bags", "1", null)).toBe("stock-bags");
    expect(calculatorFamilyChoice("sticker-bags", null, null)).toBe("sticker-bags");
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(route).not.toContain('{entry.key === "sticker-bags" ? <option value={SPLIT_BAG_CALCULATOR_OPTION.value}>');
    expect(route).toContain("Blank / bag type");
    expect(route).toContain('<option value={SPLIT_BAG_CALCULATOR_OPTION.psplitbag}>{SPLIT_BAG_CALCULATOR_OPTION.label}</option>');
    expect(route).toMatch(/<select\s+name="psplitbag"/);
    expect(route).not.toMatch(/Single sided \(2 labels|4 labels per bag|two joined 4x5/);
    expect(route).toContain('<option value="1">Front only or back only (1 label per bag)</option><option value="2">Front and back (2 labels per bag)</option>');
    // the route reaches the bag adapter only through the canonical dispatch layer
    expect(route).not.toContain("lib/bag-cost-inputs");
  });
});

describe("Split Bag through the real calculator loader and save action", () => {
  it("the loader costs Split Bag canonically with the $0.14 vendor blank auto-selected", async () => {
    const route = await import("../app/routes/app.erp.cost-calculator");
    const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${SPLIT_QS(2)}`) } as any);
    const pm = data.emergency.productMode;
    expect(pm.splitBag).toBe(true);
    expect(pm.stockBag).toBe(false);
    expect(pm.autoBag.label).toContain("Split Bag — $0.14");
    expect(pm.canonical.family).toBe("split-bags");
    const tier = pm.tiers.find((t: any) => t.quantity === 1000);
    expect(tier.costAuthority).toBe("canonical");
    expect(tier.jobCost).toBeCloseTo(pm.canonical.totalCost, 6);
    expect(tier.draftOnly, JSON.stringify({ b: tier.blockers, m: pm.result?.missing, st: tier.status })).toBe(false);
  }, 120_000);

  it("save recomputes server-side: PROVISIONAL draft named Split Bag, true cost recorded, no customer price", async () => {
    const route = await import("../app/routes/app.erp.cost-calculator");
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${SPLIT_QS(2)}`, pseltier: "1000", ecustomer: "Test Customer" });
    const response = await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) } as any) as Response;
    const json = await response.json();
    expect(json.ok, json.message).toBe(true);
    expect(json.provisional).toBe(true);
    const create = dbState.writes.find((w) => w.op === "quote.create")!;
    const item = create.args.data.items.create[0];
    expect(item.productName).toBe("Split Bag");
    expect(item.unitPrice).toBe(0);
    expect(item.unitCost).toBeGreaterThan(0);
    const snapshot = JSON.parse(item.costSnapshot);
    expect(snapshot.canonical.family).toBe("split-bags");
    const price = JSON.parse(item.priceSnapshot);
    expect(price.pricingAuthority).toMatchObject({ approved: false, missing: SPLIT_BAG_PRICE_AUTHORITY_TEXT });
  }, 120_000);
});

/* 2026-11-11 OWNER DECISION — 4x5 cutline 3.79 x 4.81 */
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

describe("4x5 cutline owner decision (3.79 x 4.81)", () => {
  it("a normal 4x5 bag cuts on 3.79 x 4.81; the Split Bag cuts on its own 7.07 x 4.26 (owner correction 2026-11-12)", () => {
    const perLabel = 2 * (3.79 + 4.81);
    const perSplitLabel = 2 * (7.07 + 4.26);
    expect(computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 100, sides: 1 }).finishing.cutPathIn).toBeCloseTo(100 * perLabel, 6);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 100, sides: 1 }).finishing.cutPathIn).toBeCloseTo(100 * perSplitLabel, 6);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 100, sides: 2 }).finishing.cutPathIn).toBeCloseTo(200 * perSplitLabel, 6);
  });

  it("10. a historical Split Bag quote saved under the old 2/4-label model keeps its saved cost", () => {
    const oldSnapshot = JSON.stringify({ canonical: { family: "split-bags", status: "PROVISIONAL", unitCost: 0.6789, totalCost: 678.9, quantity: 1000, diagnostics: { applicationEvents: 4000, productSpec: { productKey: "split-bag" } } } });
    const decision: any = enforceQuoteItemUnitCost({ unitCost: 0.1, quantity: 1000, costSnapshot: oldSnapshot, productName: "Split Bag" });
    expect(decision).toMatchObject({ protected: true, ok: true, unitCost: 0.6789 });
    expect(JSON.parse(oldSnapshot).canonical.diagnostics.applicationEvents).toBe(4000); // stored text never rewritten
  });

  it("an OLD saved snapshot (costed at 3.875 x 4.875) keeps its saved cost and geometry on re-save", () => {
    const oldSnapshot = JSON.stringify({ canonical: { family: "sticker-bags", status: "PROVISIONAL", unitCost: 0.4123, totalCost: 412.3, quantity: 1000, diagnostics: { cutPathIn: 1000 * 2 * (3.875 + 4.875) } } });
    const decision: any = enforceQuoteItemUnitCost({ unitCost: 0.1, quantity: 1000, costSnapshot: oldSnapshot, productName: "4x5 Sticker Bag" });
    expect(decision).toMatchObject({ protected: true, ok: true, unitCost: 0.4123 });
    // nothing rewrites the stored snapshot text
    expect(JSON.parse(oldSnapshot).canonical.diagnostics.cutPathIn).toBeCloseTo(17500, 6);
  });
});
