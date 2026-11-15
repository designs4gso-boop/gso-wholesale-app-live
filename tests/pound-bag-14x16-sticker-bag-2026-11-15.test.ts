// 2026-11-15 — 14x16 / POUND BAG added to the Sticker Bag calculator; QP stays blocked.
//
// The 14x16 / Pound Bag is a Sticker Bag blank / bag type (canonical family
// pound-bags): blank cost = the CURRENT 14x16 Blank Bag Vendor Cost Book record,
// sticker 14.05 x 16.00 in on a 14.39 x 16.39 in bag (same sticker front and
// back), application = the owner 14x16 standard ($1.00 per applied label), and
// the approved Sticker Bag pricing ladder applied to its OWN true cost.
// QP / Quarter Pound Bag has no owner data in the repo and is not calculable.
// (Harness adapted from split-bag-sticker-bag-ladder-2026-11-12.test.ts.)

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
const POUND_14X16 = { id: "v_pound", shop: "shop-1", name: "14x16 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:pound-bag", defaultUnitCost: 1.0, active: true, tiers: [] as any[], addOns: [] };
const dbState: { writes: Array<{ op: string; args: any }>; vendorProducts: any[] } = { writes: [], vendorProducts: [] };

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
      if (name === "vendorProduct" && method === "findMany") return dbState.vendorProducts;
      if (name === "vendorProduct" && method === "findFirst") return dbState.vendorProducts.find((p: any) => p.id === where.id) || null;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any) => (typeof ops === "function" ? ops(db) : Promise.all(ops)) : model(key)) });
  return { default: db, db };
});

import { OWNER_USER_IDS_ENV, resolveOwnerAuthorization } from "../app/lib/owner-authorization.server";
import { SPLIT_BAG_BLANK_UNIT_COST, SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT, SPLIT_BAG_LANDED_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import { BAGS_4X5_DOUBLE_BANDS, BAGS_4X5_SINGLE_BANDS, STICKER_BAG_DISPLAY_LADDER, computeCommercialPrice, defaultPricingPolicyValues, marginCurveKeyFor, marketTargetBandFor } from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { marginFamilyKeyFor } from "../app/lib/product-driven-costing.server";
import {
  APPROVED_MARGIN_CURVE_AUTHORITIES,
  SPLIT_BAG_NO_4X5_MARKET_TARGET,
  SPLIT_BAG_PRICE_AUTHORITY_TEXT,
  SPLIT_BAG_TIER_TABLE_TEXT,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
  tierDesignAssumptionText,
} from "../app/lib/calculator-owner-view";
import { OWNER_OVERRIDABLE_AUTOMATIC_KINDS, ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { itemPricingAuthority, provisionalQuoteStatusCheck } from "../app/lib/quote-pricing-authority";
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

const OWNER = "9001";
const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; dbState.vendorProducts = [BAG_4X5, { ...POUND_14X16 }]; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

type BagType = "4x5" | "split" | "pound";
const QS = (type: BagType, sides: 1 | 2, qty: number, designs = 1, printer = "mimaki") =>
  `pfamily=sticker-bags&pbagmat=matte${type === "split" ? "&psplitbag=1&pblank=preset%3Asplit-bag" : type === "pound" ? "&ppoundbag=1" : "&pblank=vendor%3Av_bag"}&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}` +
  `${type === "4x5" ? "&pwidth=4&pheight=5" : ""}&pmat=m_matte&pcut=square-rect&pprinter=${printer}&pwhitelayers=0&pglosslayers=0`;

async function calculate(qs: string) {
  const route: any = await import("../app/routes/app.erp.cost-calculator");
  const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) });
  const pm = data.emergency.productMode;
  const row = (pm.tiers || []).find((t: any) => t.requested);
  const result = resolveOwnerResult({
    family: pm.canonicalFamily, stockBag: Boolean(pm.stockBag), splitBag: Boolean(pm.splitBag), poundBag: Boolean(pm.poundBag),
    canonical: pm.canonical ? { status: pm.canonical.status, totalCost: pm.canonical.totalCost, unitCost: pm.canonical.unitCost, blockers: pm.canonical.blockers } : null,
    requestedRow: row, multiLine: pm.multiLine, marginRuleKey: pm.marginFamily?.key || null,
  })!;
  return { pm, row, result };
}

import db from "../app/db.server";
import { assembleCanonicalJob, canonicalFamilyFromUi, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_DISPATCH, CANONICAL_FAMILIES, CANONICAL_PACKOUT } from "../app/lib/canonical-calculator-shared";
import { CANONICAL_SUPPORTED_FAMILIES } from "../app/lib/canonical-quote-authority.server";
import { POUND_BAG_14X16_ALIASES, POUND_BAG_14X16_DISPLAY_NAME, POUND_BAG_URL_FLAG_ALIASES, isPoundBag14x16Name } from "../app/lib/bag-artboard-geometry";
import { POUND_BAG_APPROVED_PRICE_LADDER, POUND_BAG_DISPLAY_LADDER, POUND_BAG_MARGIN_RULE, POUND_BAG_PRICE_LADDER_KEY, poundBagLadderMarginPct, poundBagLadderPrice, poundBagMarginPctForQuantity, poundBagPolicyValues } from "../app/lib/pound-bag-pricing";
import { bagApplicationRateFor } from "../app/lib/product-driven-costing.server";
import { BAG_4X5_ARTBOARD_IN, BAG_4X5_CUTLINE_IN, POUND_BAG_14X16_ARTBOARD_IN, POUND_BAG_14X16_BAG_IN, POUND_BAG_14X16_CUTLINE_IN, SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN, bagLabelGeometryFor } from "../app/lib/bag-artboard-geometry";
import {
  BAG_4X5_BLANK_UNIT_COST,
  BAG_APPLICATION_SECONDS_PER_SIDE,
  BAG_REASONS,
  POUND_BAG_14X16_DOUBLE_SIDED_BAGS_PER_HOUR,
  POUND_BAG_14X16_SINGLE_SIDED_BAGS_PER_HOUR,
  bagApplicationSecondsPerBag,
  poundBagApplicationSecondsPerBag,
  POUND_BAG_14X16_MOQ,
  SPLIT_BAG_MOQ,
  STICKER_BAG_MOQ,
  bagApplicationCost,
  bagApplicationSecondsPerLabel,
  bagBlankUnitCostFor,
  bagCutGeometry,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { attachPoundBagBlank, loadPoundBagBlank, pickPoundBagBlank, poundBagBlankUnitCostAt } from "../app/lib/pound-bag-blank.server";
import {
  POUND_BAG_CALCULATOR_OPTION,
  POUND_BAG_MARGIN_RULE_KEY,
  POUND_BAG_PRICE_AUTHORITY_TEXT,
  calculatorFamilyChoice,
  calculatorFamilyParams,
  calculatorTransitionParams,
  isPoundBagParams,
  missingRequiredCalculatorFields,
  withCanonicalSplitBagGeometry,
} from "../app/lib/calculator-owner-view";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { getProductProductionSpec, listProductSpecs } from "../app/lib/product-production-spec";
import { OWN_COST_LADDER_PRICE_KINDS, POUND_BAG_AUTOMATIC_PRICE_KIND, POUND_BAG_LEGACY_PRICE_KIND, isSplitBagQuoteItem } from "../app/lib/split-bag-quote-pricing";

const ROUTE_SRC = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8").replace(/\r\n/g, "\n");

/** The canonical job itself, built exactly as the route builds it (normalizer -> server-read blank record -> assembler). */
async function job(qs: string) {
  const input = await attachPoundBagBlank({ db, shop: "shop-1" }, normalizeCanonicalInput(new URLSearchParams(qs))!);
  return assembleCanonicalJob(input, await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input)) as any;
}
const line = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;
const STICKER_SQFT = (14.05 * 16) / 144;

describe("QP / P Bag (14x16) — 1. it is a Sticker Bag bag type in the dropdown", () => {
  it("the Blank / bag type dropdown offers Standard 4x5, Split Bag and QP / P Bag (14x16)", () => {
    expect(POUND_BAG_CALCULATOR_OPTION).toEqual({ value: "pound-bags", label: "QP / P Bag (14x16)", pfamily: "sticker-bags", ppoundbag: "1" });
    expect(ROUTE_SRC).toContain('<option value="">Standard 4x5 Sticker Bag</option>');
    expect(ROUTE_SRC).toContain("<option value={SPLIT_BAG_CALCULATOR_OPTION.psplitbag}>{SPLIT_BAG_CALCULATOR_OPTION.label}</option>");
    expect(ROUTE_SRC).toContain("<option value={POUND_BAG_CALCULATOR_OPTION.value}>{POUND_BAG_CALCULATOR_OPTION.label}</option>");
    // it posts ppoundbag=1 and stays inside the Sticker Bags family (no new product family in the selector)
    expect(ROUTE_SRC).toContain('{familyParams.ppoundbag ? <input type="hidden" name="ppoundbag" value={familyParams.ppoundbag} /> : null}');
    expect(calculatorFamilyParams("pound-bags")).toEqual({ pfamily: "sticker-bags", pstockbag: null, psplitbag: null, ppoundbag: "1" });
    expect(calculatorFamilyChoice("sticker-bags", null, null, "1")).toBe("pound-bags");
    expect(calculatorFamilyChoice("sticker-bags", null, null, null)).toBe("sticker-bags");
    expect(calculatorFamilyChoice("sticker-bags", null, "1", null)).toBe("split-bags");
  });

  it("pfamily=sticker-bags + ppoundbag=1 is the canonical pound-bags family; Stock Bag and Split Bag flags win", () => {
    expect(canonicalFamilyFromUi("sticker-bags", false, false, true)).toBe("pound-bags");
    expect(canonicalFamilyFromUi("sticker-bags", false, false, false)).toBe("sticker-bags");
    expect(canonicalFamilyFromUi("sticker-bags", false, true, true)).toBe("split-bags");
    expect(canonicalFamilyFromUi("sticker-bags", true, false, true)).toBe("stock-bags");
    expect(canonicalFamilyFromUi("stickers-labels", false, false, true)).toBe("stickers-labels");
    expect(normalizeCanonicalInput(new URLSearchParams(QS("pound", 1, 100)))!.family).toBe("pound-bags");
    expect(CANONICAL_FAMILIES).toContain("pound-bags");
    expect(CANONICAL_SUPPORTED_FAMILIES).toContain("pound-bags");
    expect(CANONICAL_DISPATCH["pound-bags"].entry).toBe("computeBagPhysical(product: pound_bag_14x16)");
  });

  it("the loader reports a QP / P Bag (14x16) with its own blank and no manual width / height fields", async () => {
    const { pm } = await calculate(QS("pound", 1, 100));
    expect(pm.poundBag).toBe(true);
    expect(pm.splitBag).toBe(false);
    expect(pm.stockBag).toBe(false);
    expect(pm.canonicalFamily).toBe("sticker-bags"); // still the Sticker Bags UI family
    expect(pm.canonical.family).toBe("pound-bags");
    expect(pm.autoBag.label).toContain("QP / P Bag (14x16) — $1.00"); // 10. blank still the $1.00 record
    expect(pm.autoBag.label).toContain('"14x16 Blank Bag" cost record');
    // fixed geometry: no width / height entry and they are never required inputs
    expect(ROUTE_SRC).toContain("{isPoundBag ? null : (<>");
    expect(ROUTE_SRC).toContain("...(poundBagP ? { specialty: null } : {}),");
    expect(ROUTE_SRC).toContain("...(savedPoundBag ? { specialty: null } : {}),");
    const shape = { isBags: true, isStockBag: false, jars: false, isStickers: false, isBanners: false, isCustom: false, isDtp: false, topRequired: false, autoBag: true, contourCut: false, isSplitBag: true };
    const read = (name: string) => ({ pqty: "100", pdesigns: "1", pmat: "m_matte" } as Record<string, string>)[name] ?? "";
    expect(missingRequiredCalculatorFields(shape, read)).toEqual([]);
  }, 300_000);
});

describe("QP / P Bag (14x16) — 2-4. geometry", () => {
  it("2. the bag is 14.39 x 16.39 in", () => {
    expect(POUND_BAG_14X16_BAG_IN).toEqual({ widthIn: 14.39, heightIn: 16.39 });
    expect(getProductProductionSpec("pound-bags", "pound-bag-14x16")!.physical.bag).toContain("14.39 x 16.39 in");
    expect(ROUTE_SRC).toContain("POUND_BAG_14X16_BAG_IN.widthIn.toFixed(2)");
  });

  it("3. the sticker / art is 14.05 x 16.00 in — used for print area, media, ink and the cut path", async () => {
    expect(POUND_BAG_14X16_ARTBOARD_IN).toEqual({ widthIn: 14.05, heightIn: 16 });
    expect(POUND_BAG_14X16_CUTLINE_IN).toEqual({ widthIn: 14.05, heightIn: 16 });
    const g = bagLabelGeometryFor("pound_bag_14x16");
    expect(g.artboard).toEqual({ widthIn: 14.05, heightIn: 16 });
    expect(g.cutline).toEqual({ widthIn: 14.05, heightIn: 16 });
    expect(bagCutGeometry("pound_bag_14x16")["bag-label"]).toMatchObject({ cutWidthIn: 14.05, cutHeightIn: 16 });
    const physical = computeBagPhysical({ product: "pound_bag_14x16", bagQuantity: 100, sides: 1, designs: 1, blankUnitCost: 1 });
    expect(physical.nesting.usedShapeAreaSqft).toBeCloseTo(100 * STICKER_SQFT, 6);
    const r = await job(QS("pound", 1, 100));
    expect(r.diagnostics.productSpec).toMatchObject({ family: "pound-bags", productKey: "pound-bag-14x16", displayName: "QP / P Bag (14x16)", standard: { label: { widthIn: 14.05, heightIn: 16, cutWidthIn: 14.05, cutHeightIn: 16 } } });
    // a posted / stale size can never replace it
    const stale = withCanonicalSplitBagGeometry(new URLSearchParams(`${QS("pound", 1, 100)}&pwidth=4&pheight=5`));
    expect(stale.get("pwidth")).toBe("14.05");
    expect(stale.get("pheight")).toBe("16");
    const staleJob = await job(`${QS("pound", 1, 100)}&pwidth=4&pheight=5`);
    expect(staleJob.trueCost.totalCost).toBe(r.trueCost.totalCost);
    const viaLoader = await calculate(`${QS("pound", 1, 100)}&pwidth=4&pheight=5`);
    expect(viaLoader.result.trueJobCost).toBeCloseTo(r.trueCost.totalCost, 6);
  }, 300_000);

  it("3b. it never uses the 4x5 or the Split Bag geometry", () => {
    expect(bagLabelGeometryFor("pound_bag_14x16").artboard).not.toEqual(BAG_4X5_ARTBOARD_IN);
    expect(bagLabelGeometryFor("pound_bag_14x16").artboard).not.toEqual(SPLIT_BAG_ARTBOARD_IN);
    expect(bagLabelGeometryFor("sticker_bag_4x5")).toMatchObject({ artboard: BAG_4X5_ARTBOARD_IN, cutline: BAG_4X5_CUTLINE_IN });
    expect(bagLabelGeometryFor("split_bag")).toMatchObject({ artboard: SPLIT_BAG_ARTBOARD_IN, cutline: SPLIT_BAG_CUTLINE_IN });
  });

  it("4. front and back are the SAME sticker: front + back is exactly twice the sticker area of front only", () => {
    const front = computeBagPhysical({ product: "pound_bag_14x16", bagQuantity: 100, sides: 1, designs: 1, blankUnitCost: 1 });
    const both = computeBagPhysical({ product: "pound_bag_14x16", bagQuantity: 100, sides: 2, designs: 1, blankUnitCost: 1 });
    expect(front.labelQuantity).toBe(100);
    expect(both.labelQuantity).toBe(200);
    expect(both.nesting.usedShapeAreaSqft).toBeCloseTo(2 * front.nesting.usedShapeAreaSqft, 6);
    expect(both.nesting.usedShapeAreaSqft).toBeCloseTo(200 * STICKER_SQFT, 6);
    expect(getProductProductionSpec("pound-bags", "pound-bag-14x16")!.pieces).toHaveLength(1); // one piece definition, used per printed side
    // one blank per bag, whatever the side count
    expect(front.blankCost).toBe(100);
    expect(both.blankCost).toBe(100);
  });
});

describe("LABOR — 1-7. application is BAG-THROUGHPUT based at $20/hr (owner final 2026-11-15)", () => {
  it("1-5. single-sided 50 completed bags/hour = $0.40 a bag; double-sided 30 completed bags/hour = $0.6667 a bag", () => {
    expect(POUND_BAG_14X16_SINGLE_SIDED_BAGS_PER_HOUR).toBe(50);
    expect(POUND_BAG_14X16_DOUBLE_SIDED_BAGS_PER_HOUR).toBe(30);
    expect(poundBagApplicationSecondsPerBag(1)).toBe(72);
    expect(poundBagApplicationSecondsPerBag(2)).toBe(120);
    expect((bagApplicationSecondsPerBag("pound_bag_14x16", 1) / 3600) * 20).toBeCloseTo(0.4, 12);
    expect((bagApplicationSecondsPerBag("pound_bag_14x16", 2) / 3600) * 20).toBeCloseTo(0.6666667, 6);
    // front only and back only are the same single-sided job (there is one "1 side" setting)
    expect(bagApplicationCost(100, 1, "pound_bag_14x16")).toBeCloseTo(40, 9);
    expect(bagApplicationCost(100, 2, "pound_bag_14x16")).toBeCloseTo(66.6666667, 6);
    // the old $1.00 per applied label is not this product's standard any more
    expect(bagApplicationCost(100, 1, "pound_bag_14x16")).not.toBeCloseTo(100 * OWNER_STANDARDS.bagApplicationPerLabel14x16.value, 6);
    expect(bagApplicationCost(100, 2, "pound_bag_14x16")).not.toBeCloseTo(200 * OWNER_STANDARDS.bagApplicationPerLabel14x16.value, 6);
    // the other bags keep 10 s per applied label
    expect(bagApplicationSecondsPerLabel("sticker_bag_4x5", 1)).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerLabel("sticker_bag_4x5", 2)).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerLabel("split_bag", 2)).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerLabel("stock_bag", 2)).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerBag("sticker_bag_4x5", 2)).toBe(20);
    expect(bagApplicationCost(500, 2, "sticker_bag_4x5")).toBeCloseTo(500 * 2 * (10 / 3600) * 20, 9);
    expect(bagApplicationCost(500, 2, "split_bag")).toBeCloseTo(500 * 2 * (10 / 3600) * 20, 9);
  });

  it("6. a double-sided bag is ONE application operation — never the single-sided labor twice, never two label charges", async () => {
    const front = await job(QS("pound", 1, 100));
    const both = await job(QS("pound", 2, 100));
    expect(line(front, "application")).toBeCloseTo(40, 6);
    expect(line(both, "application")).toBeCloseTo(66.6666667, 5);
    expect(line(both, "application")).toBeLessThan(2 * line(front, "application")); // 2 x $0.40 = $0.80 would be double-counting
    expect(both.trueCost.lines.filter((l: any) => l.key === "application")).toHaveLength(1);
    expect(both.diagnostics.applicationBreakdown.pieces).toHaveLength(1);
    expect(both.diagnostics.applicationBreakdown.pieces[0]).toMatchObject({ secondsPerLabel: 120, labels: 100 }); // per completed BAG
    expect(both.diagnostics.applicationBreakdown.pieces[0].costPerLabel).toBeCloseTo(0.6666667, 6);
    expect(both.diagnostics.applicationBreakdown.totalCost).toBeCloseTo(66.6666667, 5);
    expect(front.diagnostics.applicationBreakdown.pieces[0]).toMatchObject({ secondsPerLabel: 72, costPerLabel: 0.4, labels: 100, cost: 40 });
    // the per-event record agrees with the per-bag figure (2 events x 60 s = 120 s)
    const physical = computeBagPhysical({ product: "pound_bag_14x16", bagQuantity: 100, sides: 2, designs: 1, blankUnitCost: 1 });
    expect(physical.application.applicationEvents).toBe(200);
    expect(bagApplicationSecondsPerLabel("pound_bag_14x16", 2) * 2).toBe(120);
    // the legacy diagnostic run carries the same labor (labels x rate = bags x per-bag)
    expect(bagApplicationRateFor("QP / P Bag (14x16)", 1).rate! * 100).toBeCloseTo(40, 9);
    expect(bagApplicationRateFor("QP / P Bag (14x16)", 2).rate! * 200).toBeCloseTo(66.6666667, 6);
  }, 300_000);

  it("7. the number of designs never multiplies application labor", async () => {
    for (const sides of [1, 2] as const) {
      const one = line(await job(QS("pound", sides, 100, 1)), "application");
      for (const designs of [5, 10, 25]) expect(line(await job(QS("pound", sides, 100, designs)), "application"), `${sides}/${designs}`).toBe(one);
    }
  }, 300_000);
});

describe("QP / P Bag (14x16) — 6. the blank cost is the current 14x16 Blank Bag record", () => {
  it("there is no code constant for it", () => {
    expect(Number.isNaN(bagBlankUnitCostFor("pound_bag_14x16"))).toBe(true);
    const physical = computeBagPhysical({ product: "pound_bag_14x16", bagQuantity: 100, sides: 1, designs: 1 });
    expect(physical.reasons).toContain(BAG_REASONS.bagBlankCostRequired);
    expect(physical.blankCost).toBe(0);
  });

  it("the record is found by its vendor SKU (preset:pound-bag) and read on the server", async () => {
    const authority = await loadPoundBagBlank({ db, shop: "shop-1" });
    expect(authority).toMatchObject({ recordType: "vendor_product", recordId: "v_pound", name: "14x16 Blank Bag", vendorSku: "preset:pound-bag", defaultUnitCost: 1 });
    expect(poundBagBlankUnitCostAt(authority, 100)).toBe(1);
    const r = await job(QS("pound", 1, 100));
    expect(line(r, "blank_sets")).toBeCloseTo(100 * 1.0, 9);
  }, 300_000);

  it("changing the record changes the cost (nothing stale is hardcoded); quantity tiers are honoured", async () => {
    dbState.vendorProducts = [BAG_4X5, { ...POUND_14X16, defaultUnitCost: 1.25 }];
    const repriced = await job(QS("pound", 1, 100));
    expect(line(repriced, "blank_sets")).toBeCloseTo(125, 9);
    expect((await calculate(QS("pound", 1, 100))).pm.autoBag.label).toContain("$1.25");

    dbState.vendorProducts = [BAG_4X5, { ...POUND_14X16, defaultUnitCost: 1.0, tiers: [{ minQty: 1, maxQty: 499, unitCost: 1.0 }, { minQty: 500, maxQty: null, unitCost: 0.8 }] }];
    expect(line(await job(QS("pound", 1, 100)), "blank_sets")).toBeCloseTo(100, 9);
    expect(line(await job(QS("pound", 1, 500)), "blank_sets")).toBeCloseTo(400, 9);
  }, 300_000);

  it("no record, an unpriced record or an ambiguous match = BLANK COST REQUIRED: no true cost and no price, never a borrowed 4x5 / Split Bag cost", async () => {
    for (const vendorProducts of [
      [BAG_4X5],
      [BAG_4X5, { ...POUND_14X16, defaultUnitCost: 0 }],
      [BAG_4X5, { ...POUND_14X16 }, { ...POUND_14X16, id: "v_pound_2" }],
    ]) {
      dbState.vendorProducts = vendorProducts;
      const r = await job(QS("pound", 1, 100));
      expect(JSON.stringify(r.blockers)).toContain("BAG_BLANK_COST_REQUIRED");
      expect(r.status).toBe("DRAFT_ONLY");
      const { pm, result } = await calculate(QS("pound", 1, 100));
      expect(pm.autoBag.label).toContain("NO COST");
      expect(result.state).not.toBe("READY");
      expect(result.recommendedTotal ?? null).toBeNull();
    }
  }, 300_000);

  it("a query-string value can never set or lower the blank cost", async () => {
    const honest = await job(QS("pound", 1, 100));
    const attacked = await job(`${QS("pound", 1, 100)}&pblankcost=0.01&blankUnitCost=0.01&pblank=vendor%3Av_bag&pcustomcost=0.01`);
    expect(line(attacked, "blank_sets")).toBe(line(honest, "blank_sets"));
    expect(attacked.trueCost.totalCost).toBe(honest.trueCost.totalCost);
    expect(normalizeCanonicalInput(new URLSearchParams(QS("pound", 1, 100)))!.bags!.blankAuthority).toBeUndefined();
  }, 300_000);

  it("a blank record under any alias name (QP / P Bag / Pound bag / 14x16) is this blank; two matches are ambiguous and give no cost", () => {
    for (const name of ["QP Bag", "Quarter Pound Bag", "P Bag", "Pound bag", "14x16 Blank Bag"]) {
      expect(pickPoundBagBlank([{ ...POUND_14X16, vendorSku: null, name }], [])!.name, name).toBe(name);
    }
    expect(pickPoundBagBlank([{ ...POUND_14X16, vendorSku: null, name: "4x5 Sticker Bag Blank (Safe Care)" }], [])).toBeNull();
    expect(pickPoundBagBlank([{ ...POUND_14X16, vendorSku: null, name: "QP Bag" }, { ...POUND_14X16, id: "v2", vendorSku: null, name: "Pound bag" }], [])).toBeNull();
    // the vendor SKU still wins over a name match
    expect(pickPoundBagBlank([{ ...POUND_14X16, id: "v2", vendorSku: null, name: "QP Bag" }, { ...POUND_14X16 }], [])!.recordId).toBe("v_pound");
  });
});

describe("PRICING — 13-20. the owner-approved dedicated ladder, on the bag's OWN true cost", () => {
  it("true cost is built from its own blank, media, ink, cutting, setup and application", async () => {
    const r = await job(QS("pound", 1, 100));
    expect(r.status).not.toBe("DRAFT_ONLY");
    expect(r.blockers).toEqual([]);
    expect(line(r, "blank_sets")).toBeCloseTo(100, 6);
    expect(line(r, "application")).toBeCloseTo(40, 6);
    expect(line(r, "print_media")).toBeGreaterThan(100 * STICKER_SQFT * (213 / 675)); // at least the sticker area at the selected media rate
    expect(line(r, "ink")).toBeGreaterThan(0);
    expect(line(r, "cutting_machine")).toBeGreaterThan(0);
    expect(line(r, "art_setup")).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 6);
    expect(line(r, "inbound_freight")).toBe(0); // no owner freight standard — disclosed, not invented
    expect(line(r, "planned_overage")).toBe(0); // spoilage: unchanged, a separate future owner decision
    expect(r.reasons).toEqual(expect.arrayContaining(["FREIGHT_NOT_MODELED", "PACKOUT_NOT_MODELED"]));
    expect(CANONICAL_PACKOUT["pound-bags"].unitsPerBox).toBeNull(); // never the 4x5 5,000 / box rule
    // 8. exactly $60 below the old $1.00-a-label model ($363.7057), nothing else moved
    expect(r.trueCost.totalCost).toBeCloseTo(363.70566651759094 - 60, 6);
    // 9. the audited 30 bags/hour double-sided model ($615.5701 - $200 + $66.6667)
    expect((await job(QS("pound", 2, 100))).trueCost.totalCost).toBeCloseTo(615.5700747018486 - 200 + 100 * (20 / 30), 6);
  }, 300_000);

  it("14-15. the anchors are exactly 4=55, 16=53, 50=50, 100=47, 256=44, 500=42, 1000=40; smooth between; flat outside", () => {
    expect(POUND_BAG_APPROVED_PRICE_LADDER.status).toBe("OWNER_APPROVED");
    expect(POUND_BAG_APPROVED_PRICE_LADDER.anchors).toEqual([
      { quantity: 4, marginPct: 55 }, { quantity: 16, marginPct: 53 }, { quantity: 50, marginPct: 50 }, { quantity: 100, marginPct: 47 },
      { quantity: 256, marginPct: 44 }, { quantity: 500, marginPct: 42 }, { quantity: 1000, marginPct: 40 },
    ]);
    expect(POUND_BAG_APPROVED_PRICE_LADDER.minimumProfit).toBe(75);
    expect(POUND_BAG_DISPLAY_LADDER).toEqual([4, 16, 50, 100, 256, 500, 1000]);
    for (const anchor of POUND_BAG_APPROVED_PRICE_LADDER.anchors) expect(poundBagMarginPctForQuantity(anchor.quantity), String(anchor.quantity)).toBe(anchor.marginPct);
    expect(poundBagMarginPctForQuantity(75)).toBe(48.5); // halfway between 50 (at 50) and 47 (at 100)
    expect(poundBagMarginPctForQuantity(10)).toBe(54);
    expect(poundBagMarginPctForQuantity(1)).toBe(55);
    expect(poundBagMarginPctForQuantity(5000)).toBe(40);
    // smooth: the margin never jumps by more than a fraction of a point per bag, and never rises with quantity
    let previous = poundBagMarginPctForQuantity(4);
    for (let quantity = 5; quantity <= 1100; quantity += 1) {
      const margin = poundBagMarginPctForQuantity(quantity);
      expect(margin, String(quantity)).toBeLessThanOrEqual(previous);
      expect(previous - margin, String(quantity)).toBeLessThanOrEqual(0.2);
      expect(margin, String(quantity)).toBeGreaterThanOrEqual(40);
      previous = margin;
    }
    // only ONE ladder exists in code (the unapproved proposals were removed)
    const src = readFileSync("app/lib/pound-bag-pricing.ts", "utf8");
    expect(src).not.toContain("PROPOSED_LADDERS");
    expect(src.match(/minimumProfit: \d+/g)).toHaveLength(1);
  });

  it("13, 17-19. the calculator prices on that ladder — not the 4x5 Sticker Bag ladder — with ONE curve for every side option", async () => {
    const front = await calculate(QS("pound", 1, 100));
    const both = await calculate(QS("pound", 2, 100));
    for (const r of [front, both]) {
      expect(r.pm.marginFamily).toMatchObject({ key: "qp-p-bag-14x16", configured: true, minPct: 40, source: "Owner-approved QP / P Bag (14x16) pricing ladder (2026-11-15)" });
      expect(r.pm.marginFamily.key).not.toBe("bags-4x5");
      expect(r.row.marginPct).toBe(47); // the same anchor for front only and for front + back
      expect(String(r.row.commercial.controllingRule)).toBe("Cost-based price — 47% quantity-band margin");
      expect(r.result).toMatchObject({ state: "READY", priceAuthority: POUND_BAG_PRICE_AUTHORITY_TEXT });
      expect(r.result.authority).toMatchObject({ approved: true, kind: "pound_bag_dedicated_ladder" });
      expect(r.result.recommendedTotal).toBeCloseTo(r.result.trueJobCost! / 0.53, 6);
      expect(r.row.commercial.marketPosition ?? null).toBeNull(); // no 4x5 market table is consulted at all
      expect(r.row.commercial.candidates.verifiedMarketTargetPrice ?? null).toBeNull();
      expect(r.pm.tiers.filter((t: any) => !t.supportRow).map((t: any) => t.quantity)).toEqual([4, 16, 50, 100, 256, 500, 1000]);
    }
    expect(POUND_BAG_MARGIN_RULE_KEY).toBe(POUND_BAG_PRICE_LADDER_KEY);
    expect(POUND_BAG_MARGIN_RULE).toMatchObject({ key: "qp-p-bag-14x16", familyMinPct: 40 });
    // 18. 100 front only: $303.71 cost -> $573.03 ($5.73 each), $269.33 profit
    expect(front.result.trueJobCost).toBeCloseTo(303.71, 2);
    expect(front.result.recommendedTotal).toBeCloseTo(573.03, 1);
    expect(front.result.recommendedUnit).toBeCloseTo(5.73, 2);
    expect(front.result.profit).toBeCloseTo(269.33, 1);
    expect(front.result.marginPct).toBeCloseTo(47, 6);
    // 19. 100 front + back: $482.24 cost -> $909.88 ($9.10 each)
    expect(both.result.trueJobCost).toBeCloseTo(482.24, 2);
    expect(both.result.recommendedTotal).toBeCloseTo(909.88, 1);
    expect(both.result.recommendedUnit).toBeCloseTo(9.1, 2);
    expect(both.result.profit).toBeCloseTo(427.64, 1);
    // the inherited 4x5 ladder would have priced these at 65% / 61%
    expect(front.result.recommendedTotal).toBeLessThan(front.result.trueJobCost! / (1 - 0.65));
  }, 300_000);

  it("16, 20. every tier row = the ladder rule on its own cost: $75 minimum profit at the low end, no cliff around any anchor", async () => {
    for (const sides of [1, 2] as const) {
      let previousTotal = 0;
      let previousMargin = Infinity;
      const unitAt: Record<number, number> = {};
      for (const quantity of [4, 8, 12, 15, 16, 17, 24, 32, 49, 50, 51, 64, 99, 100, 101, 128, 255, 256, 257, 499, 500, 501, 999, 1000, 1001]) {
        const { row, result } = await calculate(QS("pound", sides, quantity));
        const reference = poundBagLadderPrice(POUND_BAG_APPROVED_PRICE_LADDER, { quantity, trueCost: result.trueJobCost! })!;
        expect(result.recommendedTotal, `${sides}/${quantity}`).toBeCloseTo(reference.totalPrice, 6);
        expect(result.profit!, `${sides}/${quantity}`).toBeGreaterThanOrEqual(75 - 1e-6);
        expect(result.marginPct!, `${sides}/${quantity}`).toBeGreaterThanOrEqual(40 - 1e-6);
        expect(String(row.commercial.controllingRule), `${sides}/${quantity}`).toMatch(reference.controllingRule === "minimum_profit" ? /Minimum gross-profit floor/ : /Cost-based price/);
        // no cliff: one more bag never lowers the job total, and the realized margin never rises with quantity
        expect(result.recommendedTotal!, `${sides}/${quantity}`).toBeGreaterThan(previousTotal);
        expect(result.marginPct!, `${sides}/${quantity}`).toBeLessThanOrEqual(previousMargin + 1e-9);
        previousTotal = result.recommendedTotal!;
        previousMargin = result.marginPct!;
        unitAt[quantity] = result.recommendedUnit!;
      }
      // the unit price falls from one table quantity to the next (bag-by-bag it can tick up a cent or two where
      // one more bag starts a new row of media — a real cost step, not a pricing cliff)
      const table = [4, 8, 12, 16, 24, 32, 50, 64, 100, 128, 256, 500, 1000];
      for (let i = 1; i < table.length; i += 1) expect(unitAt[table[i]], `${sides}/${table[i]}`).toBeLessThan(unitAt[table[i - 1]]);
    }
    // the $75 minimum controls a 4-bag job (expected), and stops controlling as quantity grows
    const four = await calculate(QS("pound", 1, 4));
    expect(four.result.profit).toBeCloseTo(75, 6);
    expect(String(four.row.commercial.controllingRule)).toMatch(/Minimum gross-profit floor/);
    expect(String((await calculate(QS("pound", 1, 50))).row.commercial.controllingRule)).toBe("Cost-based price — 50% quantity-band margin");
  }, 600_000);

  it("the ladder is handed to the shared price function as a per-product copy: other products' policy values are untouched", () => {
    const values = defaultPricingPolicyValues();
    const before = JSON.stringify(values);
    const copy = poundBagPolicyValues(values, 100);
    expect(JSON.stringify(values)).toBe(before);
    expect(copy.marginCurves.families["qp-p-bag-14x16"]).toEqual({ familyMinPct: 40, bands: [{ minQty: 1, targetPct: 47 }] });
    expect(copy.minimumGrossProfit["sticker-bags"]).toBe(75);
    expect(copy.marginCurves.families["bags-4x5"]).toEqual(values.marginCurves.families["bags-4x5"]);
    expect(copy.marginCurves.families["bags-4x5-double"]).toEqual(values.marginCurves.families["bags-4x5-double"]);
    expect(values.marginCurves.families["qp-p-bag-14x16"]).toBeUndefined();
    expect(marginCurveKeyFor("qp-p-bag-14x16", 2)).toBe("qp-p-bag-14x16"); // no separate double-sided curve
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "QP / P Bag (14x16)")).toBeNull(); // not reachable through the 4x5 name rule
  });

  it("any other pricing basis is refused: the resolver approves a QP / P Bag price only on its own ladder", () => {
    const row = { jobCost: 100, unitCost: 1, totalPrice: 250, unitPrice: 2.5 };
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: "qp-p-bag-14x16", row })).toMatchObject({ approved: true, kind: "pound_bag_dedicated_ladder", label: POUND_BAG_PRICE_AUTHORITY_TEXT });
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: "bags-4x5", row }).approved).toBe(false);
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: null, row }).approved).toBe(false);
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: "qp-p-bag-14x16", row: { ...row, totalPrice: null } }).approved).toBe(false);
  });

  it("10-12. MOQ 4: quantities 1-3 are blocked, 4 and above are allowed; the 4x5 (50) and Split Bag (64) minimums are not borrowed", async () => {
    expect(POUND_BAG_14X16_MOQ).toBe(4);
    for (const qty of [1, 2, 3]) {
      const r = await job(QS("pound", 1, qty));
      expect(r.reasons, String(qty)).toContain(BAG_REASONS.poundBagBelowMoq);
      expect(r.status, String(qty)).toBe("DRAFT_ONLY");
      const { result } = await calculate(QS("pound", 1, qty));
      expect(result.state, String(qty)).not.toBe("READY");
      expect(result.recommendedTotal ?? null, String(qty)).toBeNull();
      expect(JSON.stringify(result.reasons), String(qty)).toContain("Quantity is below the QP / P Bag (14x16) minimum (4)");
    }
    for (const qty of [4, 5, 25, 49, 63]) {
      const r = await job(QS("pound", 2, qty));
      expect(r.blockers, String(qty)).toEqual([]);
      expect(r.reasons, String(qty)).not.toContain(BAG_REASONS.poundBagBelowMoq);
      expect(r.reasons, String(qty)).not.toContain(BAG_REASONS.stickerBagBelowMoq);
      expect(r.reasons, String(qty)).not.toContain(BAG_REASONS.splitBagBelowMoq);
    }
    expect((await calculate(QS("pound", 1, 4))).result.state).toBe("READY");
    expect(STICKER_BAG_MOQ).toBe(50);
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(getProductProductionSpec("pound-bags", "pound-bag-14x16")!.moqNote).toContain("MOQ 4");
    expect(ROUTE_SRC).toContain("Minimum order: 4 bags (MOQ 4).");
    expect(ROUTE_SRC).not.toMatch(/No minimum quantity is set/i);
  }, 300_000);

  it("the saved quote carries the ladder price, the authority and the blank record it was costed from; the owner may override it", async () => {
    const route: any = await import("../app/routes/app.erp.cost-calculator");
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${QS("pound", 1, 100)}`, pseltier: "100", ecustomer: "Pound Customer" });
    const json = await (await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) })).json();
    expect(json.ok, json.message).toBe(true);
    const item = dbState.writes.find((w) => w.op === "quote.create")!.args.data.items.create[0];
    const cost = JSON.parse(item.costSnapshot);
    const price = JSON.parse(item.priceSnapshot);
    expect(item.quantity).toBe(100);
    expect(item.unitCost * 100).toBeCloseTo(303.7057, 3);
    expect(item.unitPrice * 100).toBeCloseTo(573.03, 1);
    expect(price.pricingAuthority).toMatchObject({ approved: true, kind: "pound_bag_dedicated_ladder", approvedQuantity: 100, expectedMarginPct: 47 });
    expect(cost.canonical.family).toBe("pound-bags");
    expect(cost.productBreakdown.poundBag).toBe(true);
    expect(cost.productBreakdown.poundBagBlank).toMatchObject({ recordId: "v_pound", name: "14x16 Blank Bag", defaultUnitCost: 1 });
    expect(OWNER_OVERRIDABLE_AUTOMATIC_KINDS).toEqual(["split_bag_sticker_bag_ladder", "pound_bag_sticker_bag_ladder", "pound_bag_dedicated_ladder"]);
    expect(POUND_BAG_AUTOMATIC_PRICE_KIND).toBe("pound_bag_dedicated_ladder");
    expect(OWN_COST_LADDER_PRICE_KINDS[POUND_BAG_AUTOMATIC_PRICE_KIND]).toEqual({ product: "QP / P Bag (14x16)", badge: "Owner-approved QP / P Bag (14x16) pricing ladder applied to its own true cost" });
    // a quote saved earlier today under the inherited ladder still reads and can still be overridden
    expect(OWN_COST_LADDER_PRICE_KINDS[POUND_BAG_LEGACY_PRICE_KIND].product).toBe("QP / P Bag (14x16)");
    expect(isSplitBagQuoteItem(item)).toBe(false); // never shown as a Split Bag line
    const quote = { status: "draft", items: [{ productName: item.productName, quantity: 100, unitCost: item.unitCost, unitPrice: item.unitPrice, priceSnapshot: item.priceSnapshot }] };
    expect(provisionalQuoteStatusCheck(quote as any, "sent").ok).toBe(true);
  }, 300_000);
});

describe("QP / P Bag (14x16) — specialty printing controls are the existing Sticker Bag ones", () => {
  it("gloss on the Roland costs gloss ink; a blank gloss coverage is still the 90% estimate; Mimaki gloss stays blocked", async () => {
    const base = QS("pound", 1, 100, 1, "roland").replace("&pglosslayers=0", "");
    const none = await job(`${base}&pglosslayers=0`);
    const blank = await job(`${base}&pglosslayers=1`);
    const ninety = await job(`${base}&pglosslayers=1&pglosscoverage=90`);
    const gloss = (r: any) => r.inkChannels.find((c: any) => c.kind === "gloss");
    expect(gloss(none)).toBeUndefined();
    expect(gloss(blank).coveragePct).toBe(90);
    expect(blank.trueCost.totalCost).toBe(ninety.trueCost.totalCost);
    expect(blank.trueCost.totalCost).toBeGreaterThan(none.trueCost.totalCost);
    const mimaki = await job(`${QS("pound", 1, 100, 1, "mimaki").replace("&pglosslayers=0", "")}&pglosslayers=1`);
    expect(JSON.stringify(mimaki.blockers)).toContain("MIMAKI_GLOSS_UNSUPPORTED");
  }, 300_000);

  it("white still needs an entered coverage (no default)", async () => {
    const r = await job(QS("pound", 1, 100, 1, "roland").replace("pwhitelayers=0", "pwhitelayers=1"));
    expect(JSON.stringify(r.blockers)).toContain("WHITE_COVERAGE_REQUIRED");
  }, 300_000);
});

describe("8-9. Standard 4x5 and Split Bag are unchanged", () => {
  it("8. Standard 4x5 Sticker Bag: same family, $0.11 blank, 4.00 x 5.00 art / 3.79 x 4.81 cutline, 10 s per applied side, same cost and price", async () => {
    const r = await job(QS("4x5", 2, 500));
    expect(r.family).toBe("sticker-bags");
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(line(r, "blank_sets")).toBeCloseTo(500 * 0.11, 9);
    expect(line(r, "application")).toBeCloseTo(500 * 2 * (10 / 3600) * 20, 9);
    expect(r.diagnostics.productSpec.standard.label).toEqual({ widthIn: 4, heightIn: 5, cutWidthIn: 3.79, cutHeightIn: 4.81 });
    expect(r.trueCost.totalCost).toBeCloseTo(264.21609508547004, 9);
    const { pm, result } = await calculate(QS("4x5", 2, 500));
    expect(pm.poundBag).toBe(false);
    expect(result.trueJobCost).toBeCloseTo(264.21609508547004, 9);
    expect(result.recommendedTotal).toBeCloseTo(750, 9);
    expect(result.authority?.kind).toBe("approved_margin_curve");
    // the 14x16 record sitting in the Vendor Cost Book changes nothing for a 4x5 job
    dbState.vendorProducts = [BAG_4X5];
    expect((await job(QS("4x5", 2, 500))).trueCost.totalCost).toBeCloseTo(264.21609508547004, 9);
    // the 50-unit minimum still applies to the 4x5
    expect((await job(QS("4x5", 1, 25))).reasons).toContain(BAG_REASONS.stickerBagBelowMoq);
  }, 300_000);

  it("9. Split Bag: the pinned live job is byte-identical — $2,792.48 true cost, $5,475.45 at 49%", async () => {
    const { pm, result } = await calculate(QS("split", 2, 3800, 30, "roland"));
    expect(pm.splitBag).toBe(true);
    expect(pm.poundBag).toBe(false);
    expect(pm.canonical.family).toBe("split-bags");
    expect(result.trueJobCost).toBe(2792.4818066232533);
    expect(result.recommendedTotal).toBe(5475.454522790693);
    expect(result.marginPct).toBeCloseTo(49, 9);
    expect(result.authority?.kind).toBe("split_bag_sticker_bag_ladder");
    const r = await job(QS("split", 2, 500));
    expect(line(r, "blank_sets")).toBeCloseTo(500 * SPLIT_BAG_BLANK_UNIT_COST, 9);
    expect(line(r, "inbound_freight")).toBeCloseTo(500 * SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT, 9);
    expect(r.diagnostics.productSpec.standard.label).toEqual({ widthIn: 7.2, heightIn: 4.38, cutWidthIn: 7.07, cutHeightIn: 4.26 });
    expect((await job(QS("split", 1, 25))).reasons).toContain(BAG_REASONS.splitBagBelowMoq);
  }, 300_000);

  it("switching bag type never carries a fixed size to the next type, and keeps quantity and designs", () => {
    const fromPound = new URLSearchParams(`${QS("pound", 1, 300, 4)}&pwidth=14.05&pheight=16`);
    const to4x5 = calculatorTransitionParams(fromPound, { pfamily: "sticker-bags", pstockbag: null, psplitbag: null, ppoundbag: null });
    expect(to4x5.get("ppoundbag")).toBeNull();
    expect(to4x5.get("pwidth")).toBeNull();
    expect(to4x5.get("pheight")).toBeNull();
    expect(to4x5.get("pqty")).toBe("300");
    expect(to4x5.get("pdesigns")).toBe("4");
    const toSplit = calculatorTransitionParams(fromPound, { pfamily: "sticker-bags", pstockbag: null, psplitbag: "1", ppoundbag: null });
    expect([toSplit.get("psplitbag"), toSplit.get("ppoundbag"), toSplit.get("pwidth"), toSplit.get("pheight")]).toEqual(["1", null, "7.2", "4.38"]);
    const toPound = calculatorTransitionParams(new URLSearchParams(QS("split", 1, 300, 4)), { pfamily: "sticker-bags", pstockbag: null, psplitbag: null, ppoundbag: "1" });
    expect([toPound.get("psplitbag"), toPound.get("ppoundbag"), toPound.get("pwidth"), toPound.get("pheight")]).toEqual([null, "1", "14.05", "16"]);
    expect(isPoundBagParams(toPound)).toBe(true);
    expect(isPoundBagParams(toSplit)).toBe(false);
  });
});

describe("PRODUCT IDENTITY — QP Bag = P Bag = 14x16 / Pound Bag is ONE product", () => {
  it("1. one canonical name; every other name is an alias of it", () => {
    expect(POUND_BAG_14X16_DISPLAY_NAME).toBe("QP / P Bag (14x16)");
    expect(POUND_BAG_CALCULATOR_OPTION.label).toBe("QP / P Bag (14x16)");
    for (const alias of POUND_BAG_14X16_ALIASES) expect(isPoundBag14x16Name(alias), alias).toBe(true);
    for (const alias of ["qp bag", "Quarter-Pound bag", "P-Bag", "pound bag", "14 x 16 bag", "14x16 / Pound Bag"]) expect(isPoundBag14x16Name(alias), alias).toBe(true);
    for (const other of ["4x5 Sticker Bag", "Split Bag", "4x6 Blank Bag", "Stock Bag", "DTP 4x5x2 pouch"]) expect(isPoundBag14x16Name(other), other).toBe(false);
    // one canonical family, one bag product, one production spec
    expect((CANONICAL_FAMILIES as readonly string[]).filter((family) => /pound|qp|quarter/i.test(family))).toEqual(["pound-bags"]);
    expect(listProductSpecs().filter((spec) => /pound|qp|quarter|14x16/i.test(`${spec.productKey} ${spec.displayName}`)).map((spec) => spec.productKey)).toEqual(["pound-bag-14x16"]);
    expect(getProductProductionSpec("pound-bags", "pound-bag-14x16")!.displayName).toContain("QP / P Bag (14x16)");
  });

  it("2-3. the calculator shows exactly ONE option for it and no QP placeholder", () => {
    const select = ROUTE_SRC.slice(ROUTE_SRC.indexOf('name="psplitbag"'), ROUTE_SRC.indexOf("</select>", ROUTE_SRC.indexOf('name="psplitbag"')));
    expect(select.match(/<option /g)).toHaveLength(3); // Standard 4x5, Split Bag, QP / P Bag (14x16)
    expect(select).toContain("<option value={POUND_BAG_CALCULATOR_OPTION.value}>{POUND_BAG_CALCULATOR_OPTION.label}</option>");
    expect(ROUTE_SRC).not.toContain("qp-pending");
    expect(ROUTE_SRC).not.toContain("QP_BAG_PENDING_OPTION_LABEL");
    expect(readFileSync("app/lib/calculator-owner-view.ts", "utf8")).not.toContain("not set up yet");
    expect(ROUTE_SRC).not.toContain("14x16 / Pound Bag");
    expect(ROUTE_SRC).not.toMatch(/disabled>\{/);
  });

  it("4. old identifiers still open the same product: alias URL flags and the old Pound bag preset pick", async () => {
    expect([...POUND_BAG_URL_FLAG_ALIASES]).toEqual(["ppoundbag", "pqpbag", "ppbag", "pbag14x16", "pquarterpound"]);
    const base = QS("pound", 1, 100).replace("&ppoundbag=1", "");
    const canonical = await job(QS("pound", 1, 100));
    for (const alias of ["pqpbag=1", "ppbag=1", "pbag14x16=1", "pquarterpound=1", "pblank=preset%3Apound-bag", "pblank=type%3Abag-14x16"]) {
      const qs = `${base}&${alias}`;
      expect(normalizeCanonicalInput(new URLSearchParams(qs))!.family, alias).toBe("pound-bags");
      const rewritten = withCanonicalSplitBagGeometry(new URLSearchParams(qs));
      expect(rewritten.get("ppoundbag"), alias).toBe("1");
      expect([rewritten.get("pwidth"), rewritten.get("pheight")], alias).toEqual(["14.05", "16"]);
      for (const flag of ["pqpbag", "ppbag", "pbag14x16", "pquarterpound"]) expect(rewritten.get(flag), alias).toBeNull();
      expect((await job(qs)).trueCost.totalCost, alias).toBe(canonical.trueCost.totalCost);
      const { pm, result } = await calculate(qs);
      expect(pm.poundBag, alias).toBe(true);
      expect(result.trueJobCost, alias).toBeCloseTo(canonical.trueCost.totalCost, 6);
    }
    // an alias never beats the Stock Bag or Split Bag flags, and means nothing outside Sticker Bags
    expect(normalizeCanonicalInput(new URLSearchParams(`${base}&pqpbag=1&psplitbag=1`))!.family).toBe("split-bags");
    expect(normalizeCanonicalInput(new URLSearchParams(`${base}&pqpbag=1&pstockbag=1`))!.family).toBe("stock-bags");
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=stickers-labels&pqty=100&pqpbag=1"))!.family).toBe("stickers-labels");
    // leaving the product drops every alias flag
    const away = calculatorTransitionParams(new URLSearchParams(`${base}&pqpbag=1`), { pfamily: "sticker-bags", pstockbag: null, psplitbag: null, ppoundbag: null });
    expect([away.get("ppoundbag"), away.get("pqpbag"), away.get("pwidth")]).toEqual([null, null, null]);
  }, 300_000);

  it("the 14x16 blank is never a pick inside the Standard 4x5 product list (it would be costed as a 4x5)", async () => {
    const { pm } = await calculate(QS("4x5", 2, 500).replace("&pblank=vendor%3Av_bag", ""));
    expect(pm.poundBag).toBe(false);
    expect(pm.bagCount).toBe(1); // only the 4x5 record is offered
    expect(pm.autoBag.label).toContain("4x5 Sticker Bag Blank");
    // a stale link that points at the 14x16 record under Standard 4x5 selects nothing from it
    const stale = await calculate(QS("4x5", 2, 500).replace("vendor%3Av_bag", "vendor%3Av_pound"));
    expect(stale.pm.poundBag).toBe(false);
    expect(stale.pm.autoBag.label).toContain("4x5 Sticker Bag Blank");
    // an already-saved quote line keeps its recorded authority kind (nothing is renamed in stored data)
    expect(POUND_BAG_LEGACY_PRICE_KIND).toBe("pound_bag_sticker_bag_ladder");
  }, 300_000);
});

describe("COST — 13-18. the 100-bag front-only true cost is built only from this product", () => {
  it("every component of the 100-bag front-only example ($303.71), and nothing from the 4x5 or the Split Bag", async () => {
    const r = await job(QS("pound", 1, 100));
    const amounts = Object.fromEntries(r.trueCost.lines.map((l: any) => [l.key, l.amount]));
    expect(amounts.blank_sets).toBeCloseTo(100, 9); // 100 x the $1.00 record
    expect(amounts.application).toBeCloseTo(40, 9); // 100 completed bags x $0.40
    expect(amounts.print_media).toBeCloseTo(56.5278, 3);
    expect(amounts.ink).toBeCloseTo(51.9288, 3);
    expect(amounts.art_setup).toBeCloseTo(8.3333, 3); // once per design, not per bag
    expect(amounts.print_setup).toBeCloseTo(1, 9);
    expect(amounts.run_labor).toBeCloseTo(9.5805, 3);
    expect(amounts.cutting_machine + amounts.cutting_attention).toBeCloseTo(5.1741, 3);
    expect(amounts.weeding).toBeCloseTo(12, 6);
    expect(amounts.machine).toBeCloseTo(19.1611, 3);
    expect(amounts.planned_overage).toBe(0);
    expect(amounts.packout).toBe(0);
    expect(amounts.inbound_freight).toBe(0); // no freight at all, so none is double-counted
    expect(r.trueCost.lines.reduce((sum: number, l: any) => sum + l.amount, 0)).toBeCloseTo(r.trueCost.totalCost, 6);
    expect(r.trueCost.totalCost).toBeCloseTo(303.7057, 3);
    // 15-16. sticker area: 100 x 14.05 x 16 / 144 = 156.11 sqft inked — one sticker per bag, not two
    const ink = r.trueCost.lines.find((l: any) => l.key === "ink");
    expect(String(ink.formula)).toContain("156.1111 sqft");
    // cut path: 100 stickers x 2 x (14.05 + 16) in
    expect(r.diagnostics.cutPathIn).toBeCloseTo(100 * 2 * (14.05 + 16), 6);
    // 18. no 4x5 / Split Bag numbers anywhere
    expect(amounts.blank_sets).not.toBeCloseTo(100 * BAG_4X5_BLANK_UNIT_COST, 6);
    expect(amounts.blank_sets).not.toBeCloseTo(100 * SPLIT_BAG_BLANK_UNIT_COST, 6);
    expect(amounts.inbound_freight).not.toBeCloseTo(100 * SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT, 6);
  }, 300_000);

  it("17. front + back doubles the sticker-driven lines only; application is the 30 bags/hour figure, the blank and the setup are NOT doubled", async () => {
    const front = await job(QS("pound", 1, 100));
    const both = await job(QS("pound", 2, 100));
    const f = Object.fromEntries(front.trueCost.lines.map((l: any) => [l.key, l.amount]));
    const b = Object.fromEntries(both.trueCost.lines.map((l: any) => [l.key, l.amount]));
    expect(f.application).toBeCloseTo(40, 9);
    expect(b.application).toBeCloseTo(100 * (20 / 30), 9); // one double-sided operation per bag, not 2 x $0.40
    expect(b.ink).toBeCloseTo(2 * f.ink, 6);
    expect(both.diagnostics.cutPathIn).toBeCloseTo(2 * front.diagnostics.cutPathIn, 6);
    expect(b.blank_sets).toBe(f.blank_sets);
    expect(b.art_setup).toBe(f.art_setup);
    expect(b.print_setup).toBe(f.print_setup);
    expect(both.trueCost.totalCost).toBeLessThan(2 * front.trueCost.totalCost);
  }, 300_000);

  it("setup follows the design count only: 100 bags with 1 / 5 / 10 / 25 designs", async () => {
    const one = await job(QS("pound", 1, 100, 1));
    for (const designs of [5, 10, 25]) {
      const r = await job(QS("pound", 1, 100, designs));
      const setup = (x: any) => line(x, "art_setup") + line(x, "print_setup");
      expect(setup(r), String(designs)).toBeCloseTo(designs * setup(one), 6);
      // nothing else moves with the design count
      expect(r.trueCost.totalCost - setup(r), String(designs)).toBeCloseTo(one.trueCost.totalCost - setup(one), 6);
    }
  }, 300_000);
});
