// 2026-11-12 OWNER CORRECTION — Split Bag AUTOMATIC recommended customer price.
//
// The calculator recommends a Split Bag price from the EXISTING provisional
// universal curve (PROVISIONAL_MARGIN_CURVE by quantity band, 40% global floor,
// family minimum profit) applied to the full canonical true cost — labelled
// PROVISIONAL PRICING; no dedicated Split Bag ladder. Owner override optional.

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

import { OWNER_USER_IDS_ENV, resolveOwnerAuthorization } from "../app/lib/owner-authorization.server";
import { MARGIN_FLOOR_PCT, PROVISIONAL_MARGIN_CURVE } from "../app/lib/calculator-emergency.server";
import { SPLIT_BAG_BLANK_UNIT_COST, SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT, SPLIT_BAG_LANDED_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import {
  APPROVED_MARGIN_CURVE_AUTHORITIES,
  COST_PRICING_OWNER_ONLY_MESSAGE,
  SPLIT_BAG_PRICE_AUTHORITY_TEXT,
  SPLIT_BAG_PROVISIONAL_PRICING_BADGE,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
} from "../app/lib/calculator-owner-view";
import { ownerSetQuoteItemPrice, OWNER_OVERRIDABLE_AUTOMATIC_KINDS } from "../app/lib/quote-owner-price-approval.server";
import { itemPricingAuthority, provisionalQuoteStatusCheck, reconcileQuoteItemPricingAuthority } from "../app/lib/quote-pricing-authority";
import { quoteMarginState } from "../app/lib/quote-margin.server";
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

const OWNER = "9001";
const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

const QS = (sides: 1 | 2, qty: number, designs: number, printer = "mimaki") =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=${printer}&pwhitelayers=0&pglosslayers=0`;

/** The owner result card exactly as the calculator renders it, from the real loader. */
async function calculate(qs: string) {
  const route: any = await import("../app/routes/app.erp.cost-calculator");
  const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) });
  const pm = data.emergency.productMode;
  const row = (pm.tiers || []).find((t: any) => t.requested);
  const result = resolveOwnerResult({
    family: pm.canonicalFamily, stockBag: Boolean(pm.stockBag), splitBag: Boolean(pm.splitBag),
    canonical: pm.canonical ? { status: pm.canonical.status, totalCost: pm.canonical.totalCost, unitCost: pm.canonical.unitCost, blockers: pm.canonical.blockers } : null,
    requestedRow: row, multiLine: pm.multiLine, marginRuleKey: pm.marginFamily?.key || null,
  })!;
  return { pm, row, result };
}

describe("1-12. the calculator gives every Split Bag job an automatic recommended price", () => {
  const cases = [
    { n: "8", label: "500 front only", qs: QS(1, 500, 1), cost: 228.9962, band: 50, total: 457.9924, unit: 0.91598 },
    { n: "9", label: "500 front + back", qs: QS(2, 500, 1), cost: 366.6591, band: 50, total: 733.3181, unit: 1.46664 },
    { n: "10", label: "3,800 / 30 designs / front + back / Roland (live job)", qs: QS(2, 3800, 30, "roland"), cost: 2792.4818, band: 40, total: 4654.1363, unit: 1.22477 },
  ];
  for (const c of cases) {
    it(`${c.n}. ${c.label}: true cost, recommended unit / total, profit and margin from the provisional universal curve`, async () => {
      const { pm, row, result } = await calculate(c.qs);
      expect(pm.splitBag).toBe(true);
      expect(pm.marginFamily.configured).toBe(false); // no Split Bag family rule / ladder exists (3)
      expect(result.state).toBe("READY");
      expect(result.badge).toBe(`READY TO QUOTE — ${SPLIT_BAG_PROVISIONAL_PRICING_BADGE}`);
      expect(result.authority).toMatchObject({ approved: true, kind: "split_bag_provisional_curve", label: SPLIT_BAG_PRICE_AUTHORITY_TEXT });
      expect(result.trueJobCost).toBeCloseTo(c.cost, 3); // (4) true cost unchanged
      // (2) the existing canonical provisional resolver: quantity-band margin on the full true cost
      expect(row.commercial.marginSource).toMatch(/^Provisional universal curve/);
      expect(row.commercial.controllingRule).toBe(`Cost-based price — ${c.band}% quantity-band margin`);
      expect(PROVISIONAL_MARGIN_CURVE).toContain(c.band);
      expect(c.band).toBeGreaterThanOrEqual(MARGIN_FLOOR_PCT);
      // (1, 5-7) populated numbers, consistent with each other
      expect(result.recommendedTotal!).toBeCloseTo(c.total, 3);
      expect(result.recommendedUnit!).toBeCloseTo(c.unit, 4);
      expect(result.profit!).toBeCloseTo(c.total - c.cost, 3);
      expect(result.marginPct!).toBeCloseTo(c.band, 6);
      expect(result.recommendedTotal!).toBeCloseTo(c.cost / (1 - c.band / 100), 3); // priced on the WHOLE true cost, not the blank
    }, 180_000);
  }

  it("11. changing quantity recalculates the recommendation (500 -> 1,000 moves into the 40% band)", async () => {
    const small = (await calculate(QS(1, 500, 1))).result;
    const large = (await calculate(QS(1, 1000, 1))).result;
    expect(large.trueJobCost).not.toBeCloseTo(small.trueJobCost!, 2);
    expect(large.marginPct!).toBeCloseTo(40, 6);
    expect(large.recommendedTotal!).toBeCloseTo(large.trueJobCost! / 0.6, 6);
    expect(large.recommendedUnit!).toBeLessThan(small.recommendedUnit!);
  }, 180_000);

  it("12. changing the number of designs recalculates true cost (setup only) and the recommendation", async () => {
    const one = (await calculate(QS(2, 3800, 1, "roland"))).result;
    const thirty = (await calculate(QS(2, 3800, 30, "roland"))).result;
    expect(thirty.trueJobCost! - one.trueJobCost!).toBeGreaterThan(200);
    expect(thirty.recommendedTotal!).toBeCloseTo(thirty.trueJobCost! / 0.6, 6);
    expect(one.recommendedTotal!).toBeCloseTo(one.trueJobCost! / 0.6, 6);
  }, 180_000);

  it("3. no permanent Split Bag ladder or family curve exists", () => {
    expect(Object.keys(APPROVED_MARGIN_CURVE_AUTHORITIES)).toEqual(["bags-4x5", "stickers-labels"]);
    const src = readFileSync("app/lib/calculator-owner-view.ts", "utf8") + readFileSync("app/lib/commercial-pricing-policy.server.ts", "utf8") + readFileSync("app/lib/product-driven-costing.server.ts", "utf8");
    expect(src).not.toMatch(/split[-_]?bags?["']?\s*:\s*\{\s*(curve|label|familyMinPct)/i);
    expect(src).toContain('if (canonical === "sticker-bags") return /4\\s?x\\s?5\\b/i.test(String(blankName || "")) ? "bags-4x5" : null;');
  });

  it("20. true-cost authority stays $0.14 vendor + $0.024 inbound freight = $0.164 landed", () => {
    expect(SPLIT_BAG_BLANK_UNIT_COST).toBe(0.14);
    expect(SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT).toBeCloseTo(0.024, 12);
    expect(SPLIT_BAG_LANDED_UNIT_COST).toBeCloseTo(0.164, 12);
  });
});

describe("13. accepting the recommendation needs no manual price", () => {
  it("the real save action records the automatic price, profit, margin and authority; the quote can be sent", async () => {
    const route: any = await import("../app/routes/app.erp.cost-calculator");
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${QS(2, 3800, 30, "roland")}`, pseltier: "3800", ecustomer: "Live Customer" });
    const json = await (await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) })).json();
    expect(json.ok, json.message).toBe(true);
    const item = dbState.writes.find((w) => w.op === "quote.create")!.args.data.items.create[0];
    const price = JSON.parse(item.priceSnapshot);
    expect(item.unitCost).toBeCloseTo(2792.4818 / 3800, 6);
    expect(item.unitPrice).toBeCloseTo(4654.1363 / 3800, 6);
    expect(price.pricingAuthority).toMatchObject({ approved: true, kind: "split_bag_provisional_curve", approvedQuantity: 3800, expectedMarginPct: 40 });
    expect(price.pricingAuthority.expectedProfit).toBeCloseTo(1861.65, 2);
    expect(price.pricingAuthority.ownerApproval ?? null).toBeNull(); // not overridden
    expect(price.recommendedTotalPrice).toBeCloseTo(4654.1363, 3);
    const quote = { status: "draft", items: [{ productName: "Split Bag", quantity: 3800, unitCost: item.unitCost, unitPrice: item.unitPrice, priceSnapshot: item.priceSnapshot }] };
    for (const status of ["sent", "approved"]) expect(provisionalQuoteStatusCheck(quote as any, status).ok, status).toBe(true);
  }, 180_000);
});

/* ---------------- optional owner override ---------------- */
const TRUE_UNIT = 2792.4818066232533 / 3800;
const AUTO_UNIT = 4654.136344372089 / 3800;
function autoItem(id: string) {
  return {
    id, quoteId: "q1", productName: "Split Bag", quantity: 3800, unitCost: TRUE_UNIT, unitPrice: AUTO_UNIT, discountPct: 0,
    costSnapshot: JSON.stringify({ canonical: { family: "split-bags", unitCost: TRUE_UNIT, totalCost: 2792.48, quantity: 3800 }, productBreakdown: { splitBag: true } }),
    priceSnapshot: JSON.stringify({ unitPrice: AUTO_UNIT, pricingAuthority: { approved: true, status: "APPROVED", kind: "split_bag_provisional_curve", source: SPLIT_BAG_PRICE_AUTHORITY_TEXT, missing: null, approvedUnitPrice: AUTO_UNIT, approvedTotalPrice: 4654.14, approvedQuantity: 3800, expectedProfit: 1861.65, expectedMarginPct: 40 } }),
  };
}
function fakeQuoteDb(items: any[]) {
  const state = { quote: { id: "q1", shop: "shop-1", status: "draft", customerTier: "standard", notes: "", items }, itemWrites: [] as any[] };
  const db = {
    quote: { findFirst: async () => ({ ...state.quote, items: state.quote.items.map((i: any) => ({ ...i })) }), updateMany: async () => ({ count: 1 }) },
    quoteItem: { updateMany: async (args: any) => { state.itemWrites.push(args); Object.assign(state.quote.items.find((i: any) => i.id === args.where.id), args.data); return { count: 1 }; } },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return { db, state };
}

describe("14-16, 21-23. owner override is optional, per quote, owner only", () => {
  it("14-15. the owner can override the automatic price on ONE quote item; the override and the recommendation are recorded; cost untouched", async () => {
    expect(OWNER_OVERRIDABLE_AUTOMATIC_KINDS).toEqual(["split_bag_provisional_curve"]);
    const store = fakeQuoteDb([autoItem("i1"), autoItem("i2")]);
    const result: any = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.35", reason: "repeat customer", owner: resolveOwnerAuthorization(as(OWNER)) });
    expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({ unitPrice: 1.35, totalPrice: 5130 });
    expect(store.state.itemWrites).toHaveLength(1);
    expect(store.state.itemWrites[0].where).toEqual({ id: "i1", quoteId: "q1" });
    expect(store.state.itemWrites[0].data.unitCost).toBeUndefined();
    const record = itemPricingAuthority(store.state.quote.items[0])!;
    expect(record).toMatchObject({ approved: true, kind: "owner_quote_price" });
    expect(record.ownerApproval!.overrodeRecommendation).toMatchObject({ kind: "split_bag_provisional_curve", unitPrice: AUTO_UNIT, totalPrice: 4654.14 });
    expect(record.ownerApproval!.expectedProfit).toBeCloseTo(5130 - 2792.48, 2);
    // the other line keeps its automatic price
    expect(itemPricingAuthority(store.state.quote.items[1])).toMatchObject({ approved: true, kind: "split_bag_provisional_curve" });
  });

  it("16. a new quote returns to the automatic recommendation (nothing global changed)", async () => {
    const store = fakeQuoteDb([autoItem("i1")]);
    await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.10", reason: "x", owner: resolveOwnerAuthorization(as(OWNER)) });
    const authority = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: null, row: { jobCost: 2792.48, unitCost: TRUE_UNIT, totalPrice: 4654.14, unitPrice: AUTO_UNIT } });
    expect(authority).toMatchObject({ approved: true, kind: "split_bag_provisional_curve" });
    expect(Object.keys(store.db)).toEqual(["quote", "quoteItem", "$transaction"]); // no rule / ladder / product write path
  });

  it("22. non-owners cannot override (Sales, Bagger, even an authorized Manager)", async () => {
    process.env.GSO_STAFF_ROLES = "1002:sales,1004:bagger,1005:manager";
    process.env.GSO_MANAGER_AUTHORIZED_USER_IDS = "1005";
    for (const sub of ["1002", "1004", "1005", "9999"]) {
      const store = fakeQuoteDb([autoItem("i1")]);
      const result = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "0.80", reason: "x", owner: resolveOwnerAuthorization(as(sub)) });
      expect(result.ok, sub).toBe(false);
      expect(store.state.itemWrites, sub).toHaveLength(0);
    }
    expect(COST_PRICING_OWNER_ONLY_MESSAGE).toBe("The Cost & Pricing Calculator is owner only.");
  });

  it("23. a lowered price in the Quotes editor keeps the existing margin gate (no exemption for Split Bags)", () => {
    const lowered = { ...autoItem("i1"), unitPrice: TRUE_UNIT * 1.2 }; // ~16.7% margin
    const reconciled = reconcileQuoteItemPricingAuthority([autoItem("i1")] as any, [lowered] as any, { customerTier: "standard" } as any, "staff", new Date().toISOString());
    expect(itemPricingAuthority(reconciled.items[0])?.kind).toBe("split_bag_provisional_curve"); // a posted record is never upgraded
    const state = quoteMarginState({ customerTier: "standard", items: reconciled.items } as any);
    expect(state.lowItems.some((low: any) => low.kind === "below_threshold")).toBe(true);
    expect(state.ownerApprovedLowMargin).toEqual([]);
  });

  it("21. historical snapshots keep their saved cost and price", () => {
    const oldProvisional = { productName: "Split Bag", quantity: 500, unitCost: 0.5439924, costSnapshot: JSON.stringify({ canonical: { family: "split-bags", status: "PROVISIONAL", unitCost: 0.5439924, totalCost: 271.9962, quantity: 500 } }) };
    expect(enforceQuoteItemUnitCost({ ...oldProvisional, unitCost: 0.1 } as any)).toMatchObject({ protected: true, unitCost: 0.5439924 });
  });
});

describe("17-19. other families unchanged", () => {
  const row = { quantity: 1000, requested: true, jobCost: 400, unitCost: 0.4, unitPrice: 0.9, totalPrice: 900, profit: 500, actualMarginPct: 55, marginPct: 55, draftOnly: false, status: "READY TO QUOTE", commercial: { controllingRule: "curve", marginSource: "researched curve", ownerLadder: null } };
  it("17. Standard 4x5 keeps its researched bags-4x5 authority", () => {
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, marginRuleKey: "bags-4x5", row })).toMatchObject({ approved: true, kind: "approved_margin_curve", label: APPROVED_MARGIN_CURVE_AUTHORITIES["bags-4x5"] });
    // and a non-split sticker bag without a researched curve is still NOT approved
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, marginRuleKey: null, row }).approved).toBe(false);
  });
  it("18. Stock Bags keep the live storefront authority", () => {
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: true, marginRuleKey: null, row: { ...row, stockBagStorefront: { ok: true, version: "v" } } })).toMatchObject({ approved: true, kind: "storefront_stock_bag" });
  });
  it("19. jars keep the owner ladder; off-ladder jar curves stay unapproved", () => {
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "miron-jars", row: { ...row, commercial: { ...row.commercial, ownerLadder: { label: "Miron 16D" } } } })).toMatchObject({ approved: true, kind: "owner_jar_ladder" });
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "miron-jars", row }).approved).toBe(false);
  });
});
