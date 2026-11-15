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
import { BAG_4X5_ARTBOARD_IN, BAG_4X5_CUTLINE_IN, POUND_BAG_14X16_ARTBOARD_IN, POUND_BAG_14X16_BAG_IN, POUND_BAG_14X16_CUTLINE_IN, SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN, bagLabelGeometryFor } from "../app/lib/bag-artboard-geometry";
import {
  BAG_4X5_BLANK_UNIT_COST,
  BAG_APPLICATION_SECONDS_PER_SIDE,
  BAG_REASONS,
  POUND_BAG_14X16_APPLICATION_SECONDS_PER_LABEL,
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
  QP_BAG_PENDING_OPTION_LABEL,
  calculatorFamilyChoice,
  calculatorFamilyParams,
  calculatorTransitionParams,
  isPoundBagParams,
  missingRequiredCalculatorFields,
  withCanonicalSplitBagGeometry,
} from "../app/lib/calculator-owner-view";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { getProductProductionSpec, listProductSpecs } from "../app/lib/product-production-spec";
import { OWN_COST_LADDER_PRICE_KINDS, POUND_BAG_AUTOMATIC_PRICE_KIND, isSplitBagQuoteItem } from "../app/lib/split-bag-quote-pricing";

const ROUTE_SRC = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8").replace(/\r\n/g, "\n");

/** The canonical job itself, built exactly as the route builds it (normalizer -> server-read blank record -> assembler). */
async function job(qs: string) {
  const input = await attachPoundBagBlank({ db, shop: "shop-1" }, normalizeCanonicalInput(new URLSearchParams(qs))!);
  return assembleCanonicalJob(input, await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input)) as any;
}
const line = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;
const STICKER_SQFT = (14.05 * 16) / 144;

describe("14x16 / Pound Bag — 1. it is a Sticker Bag bag type in the dropdown", () => {
  it("the Blank / bag type dropdown offers Standard 4x5, Split Bag and 14x16 / Pound Bag", () => {
    expect(POUND_BAG_CALCULATOR_OPTION).toEqual({ value: "pound-bags", label: "14x16 / Pound Bag", pfamily: "sticker-bags", ppoundbag: "1" });
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

  it("the loader reports a 14x16 / Pound Bag with its own blank and no manual width / height fields", async () => {
    const { pm } = await calculate(QS("pound", 1, 100));
    expect(pm.poundBag).toBe(true);
    expect(pm.splitBag).toBe(false);
    expect(pm.stockBag).toBe(false);
    expect(pm.canonicalFamily).toBe("sticker-bags"); // still the Sticker Bags UI family
    expect(pm.canonical.family).toBe("pound-bags");
    expect(pm.autoBag.label).toContain("14x16 / Pound Bag — $1.00");
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

describe("14x16 / Pound Bag — 2-4. geometry", () => {
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
    expect(r.diagnostics.productSpec).toMatchObject({ family: "pound-bags", productKey: "pound-bag-14x16", displayName: "14x16 / Pound Bag", standard: { label: { widthIn: 14.05, heightIn: 16, cutWidthIn: 14.05, cutHeightIn: 16 } } });
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

describe("14x16 / Pound Bag — 5. application labor is per applied label, through the existing canonical math", () => {
  it("uses the existing owner 14x16 standard ($1.00 per applied label = 180 s at the canonical $20/hr)", () => {
    expect(OWNER_STANDARDS.bagApplicationPerLabel14x16.value).toBe(1);
    expect(POUND_BAG_14X16_APPLICATION_SECONDS_PER_LABEL).toBe(180);
    expect((POUND_BAG_14X16_APPLICATION_SECONDS_PER_LABEL / 3600) * 20).toBeCloseTo(OWNER_STANDARDS.bagApplicationPerLabel14x16.value, 12);
    expect(bagApplicationSecondsPerLabel("pound_bag_14x16")).toBe(180);
    // the other bags keep their 10 s per applied side
    expect(bagApplicationSecondsPerLabel("sticker_bag_4x5")).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerLabel("split_bag")).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
    expect(bagApplicationSecondsPerLabel("stock_bag")).toBe(BAG_APPLICATION_SECONDS_PER_SIDE);
  });

  it("front only = 1 applied label per bag, front + back = 2 (never 4)", async () => {
    expect(bagApplicationCost(100, 1, "pound_bag_14x16")).toBeCloseTo(100, 9);
    expect(bagApplicationCost(100, 2, "pound_bag_14x16")).toBeCloseTo(200, 9);
    const front = await job(QS("pound", 1, 100));
    const both = await job(QS("pound", 2, 100));
    expect(line(front, "application")).toBeCloseTo(100, 6);
    expect(line(both, "application")).toBeCloseTo(200, 6);
    expect(front.diagnostics.applicationEvents).toBe(100);
    expect(both.diagnostics.applicationEvents).toBe(200);
    expect(both.diagnostics.applicationBreakdown).toMatchObject({ totalLabels: 200, totalCost: 200, laborRatePerHour: 20 });
    expect(both.diagnostics.applicationBreakdown.pieces[0]).toMatchObject({ secondsPerLabel: 180, costPerLabel: 1, labels: 200 });
  }, 300_000);
});

describe("14x16 / Pound Bag — 6. the blank cost is the current 14x16 Blank Bag record", () => {
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

  it("a Quarter Pound (QP) record is never taken for the 14x16 blank", () => {
    const qp = { id: "v_qp", name: "Quarter Pound Bag", productType: "bag", vendorSku: null, defaultUnitCost: 0.5, active: true, tiers: [] };
    expect(pickPoundBagBlank([qp], [])).toBeNull();
    expect(pickPoundBagBlank([qp, { ...POUND_14X16 }], [])!.recordId).toBe("v_pound");
    expect(pickPoundBagBlank([{ ...POUND_14X16, vendorSku: null, name: "Pound bag" }], [])!.name).toBe("Pound bag"); // name match when the SKU is absent
  });
});

describe("14x16 / Pound Bag — 7. approved Sticker Bag pricing ladder on its OWN true cost", () => {
  it("true cost is built from its own blank, media, ink, cutting, setup and application", async () => {
    const r = await job(QS("pound", 1, 100));
    expect(r.status).not.toBe("DRAFT_ONLY");
    expect(r.blockers).toEqual([]);
    expect(line(r, "blank_sets")).toBeCloseTo(100, 6);
    expect(line(r, "application")).toBeCloseTo(100, 6);
    expect(line(r, "print_media")).toBeGreaterThan(100 * STICKER_SQFT * (213 / 675)); // at least the sticker area at the selected media rate
    expect(line(r, "ink")).toBeGreaterThan(0);
    expect(line(r, "cutting_machine")).toBeGreaterThan(0);
    expect(line(r, "art_setup")).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 6);
    expect(line(r, "inbound_freight")).toBe(0); // no owner freight standard — disclosed, not invented
    expect(r.reasons).toEqual(expect.arrayContaining(["FREIGHT_NOT_MODELED", "PACKOUT_NOT_MODELED"]));
    expect(CANONICAL_PACKOUT["pound-bags"].unitsPerBox).toBeNull(); // never the 4x5 5,000 / box rule
    expect(r.trueCost.totalCost).toBeCloseTo(363.7057, 3);
    expect((await job(QS("pound", 2, 100))).trueCost.totalCost).toBeCloseTo(615.5701, 3);
  }, 300_000);

  it("the price is the Sticker Bag ladder band applied to that cost; the 4x5 dollar targets are never used", async () => {
    const { pm, row, result } = await calculate(QS("pound", 1, 100));
    expect(pm.marginFamily).toMatchObject({ key: "bags-4x5", configured: true, minPct: 45 });
    expect(POUND_BAG_MARGIN_RULE_KEY).toBe("bags-4x5");
    expect(pm.tiers.map((t: any) => t.quantity)).toEqual(expect.arrayContaining(STICKER_BAG_DISPLAY_LADDER));
    expect(result).toMatchObject({ state: "READY", priceAuthority: POUND_BAG_PRICE_AUTHORITY_TEXT });
    expect(result.authority).toMatchObject({ approved: true, kind: "pound_bag_sticker_bag_ladder" });
    expect(result.trueJobCost).toBeCloseTo(363.7057, 3);
    // cost / (1 - band margin): the ladder rule on the bag's OWN cost
    const band = [...BAGS_4X5_SINGLE_BANDS].reverse().find((b) => 100 >= b.minQty)!;
    expect(row.marginPct).toBeGreaterThanOrEqual(band.targetPct);
    expect(result.recommendedTotal).toBeCloseTo(result.trueJobCost! / (1 - row.marginPct / 100), 4);
    expect(result.recommendedTotal).toBeCloseTo(1039.159, 2);
    expect(row.commercial.marketPosition.applicable).toBe(false);
    expect(row.commercial.marketPosition.targetApplied).toBe(false);
    expect(String(row.commercial.controllingRule || row.commercial.marginSource)).toMatch(/Cost-based price/);
    // front + back uses the double-sided bands
    const both = await calculate(QS("pound", 2, 100));
    const bandDouble = [...BAGS_4X5_DOUBLE_BANDS].reverse().find((b) => 100 >= b.minQty)!;
    expect(both.row.marginPct).toBeGreaterThanOrEqual(bandDouble.targetPct);
    expect(both.result.recommendedTotal).toBeCloseTo(1578.385, 2);
    for (const t of both.pm.tiers) expect(t.marginPct, String(t.quantity)).toBeGreaterThanOrEqual(45);
  }, 300_000);

  it("any other pricing basis is refused; the resolver never approves a 14x16 price off the Sticker Bag ladder", () => {
    const row = { jobCost: 100, unitCost: 1, totalPrice: 250, unitPrice: 2.5 };
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: "bags-4x5", row })).toMatchObject({ approved: true, kind: "pound_bag_sticker_bag_ladder", label: POUND_BAG_PRICE_AUTHORITY_TEXT });
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: null, row }).approved).toBe(false);
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, poundBag: true, marginRuleKey: "bags-4x5", row: { ...row, totalPrice: null } }).approved).toBe(false);
  });

  it("no minimum quantity is enforced (none is on file), and none is borrowed from the 4x5 or the Split Bag", async () => {
    const small = await job(QS("pound", 1, 25));
    expect(small.blockers).toEqual([]);
    expect(small.reasons).not.toContain(BAG_REASONS.stickerBagBelowMoq);
    expect(small.reasons).not.toContain(BAG_REASONS.splitBagBelowMoq);
    expect(STICKER_BAG_MOQ).toBe(50);
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(getProductProductionSpec("pound-bags", "pound-bag-14x16")!.moqNote).toContain("No owner MOQ");
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
    expect(item.unitCost * 100).toBeCloseTo(363.7057, 3);
    expect(item.unitPrice * 100).toBeCloseTo(1039.159, 2);
    expect(price.pricingAuthority).toMatchObject({ approved: true, kind: "pound_bag_sticker_bag_ladder", approvedQuantity: 100 });
    expect(cost.canonical.family).toBe("pound-bags");
    expect(cost.productBreakdown.poundBag).toBe(true);
    expect(cost.productBreakdown.poundBagBlank).toMatchObject({ recordId: "v_pound", name: "14x16 Blank Bag", defaultUnitCost: 1 });
    expect(OWNER_OVERRIDABLE_AUTOMATIC_KINDS).toEqual(["split_bag_sticker_bag_ladder", "pound_bag_sticker_bag_ladder"]);
    expect(OWN_COST_LADDER_PRICE_KINDS[POUND_BAG_AUTOMATIC_PRICE_KIND]).toEqual({ product: "14x16 / Pound Bag", badge: "Approved Sticker Bag pricing ladder applied to 14x16 / Pound Bag true cost" });
    expect(isSplitBagQuoteItem(item)).toBe(false); // never shown as a Split Bag line
    const quote = { status: "draft", items: [{ productName: item.productName, quantity: 100, unitCost: item.unitCost, unitPrice: item.unitPrice, priceSnapshot: item.priceSnapshot }] };
    expect(provisionalQuoteStatusCheck(quote as any, "sent").ok).toBe(true);
  }, 300_000);
});

describe("14x16 / Pound Bag — specialty printing controls are the existing Sticker Bag ones", () => {
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

describe("10-15. QP / Quarter Pound Bag — no owner authority in the repo, so it is NOT calculable", () => {
  it("10. it is listed as not set up and cannot be selected", () => {
    expect(QP_BAG_PENDING_OPTION_LABEL).toBe("QP / Quarter Pound Bag — not set up yet (owner data needed)");
    expect(ROUTE_SRC).toContain('<option value="qp-pending" disabled>{QP_BAG_PENDING_OPTION_LABEL}</option>');
    expect(ROUTE_SRC).not.toMatch(/name="pqpbag"/);
  });

  it("11-13, 15. there is no QP family, bag product, geometry, blank cost, MOQ or price rule — nothing falls back to another bag", () => {
    expect((CANONICAL_FAMILIES as readonly string[]).some((family) => /qp|quarter/i.test(family))).toBe(false);
    expect(listProductSpecs().some((spec) => /\bqp\b|quarter/i.test(`${spec.productKey} ${spec.displayName}`))).toBe(false);
    expect(Object.keys(OWN_COST_LADDER_PRICE_KINDS).some((kind) => /qp|quarter/i.test(kind))).toBe(false);
    // a hand-typed QP flag is not a product: it is ignored, never costed as a QP bag
    for (const flag of ["pqpbag=1", "pquarterpound=1", "pbagtype=qp"]) {
      const input = normalizeCanonicalInput(new URLSearchParams(`pfamily=sticker-bags&pqty=100&pbagsides=1&${flag}`))!;
      expect(input.family).toBe("sticker-bags");
    }
    // the bag-type select's own value never reaches the Split Bag / Pound Bag flags
    expect(canonicalFamilyFromUi("sticker-bags", false, false, false)).toBe("sticker-bags");
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=sticker-bags&pqty=100&pbagsides=1&psplitbag=qp-pending"))!.family).toBe("sticker-bags");
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=sticker-bags&pqty=100&pbagsides=1&psplitbag=pound-bags"))!.family).toBe("sticker-bags");
  });

  it("14. no QP application rule exists either", () => {
    expect(Object.keys(OWNER_STANDARDS).some((key) => /qp|quarter/i.test(key))).toBe(false);
  });
});
