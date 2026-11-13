// 2026-11-12 OWNER DECISION (final) — Split Bag priced by the APPROVED Sticker Bag ladder.
//
// Same bags-4x5 quantity bands (single / double), 45% family minimum, 40% global
// floor and minimum-profit policy, applied to the Split Bag's OWN true cost. The
// 4x5 market dollar targets are never copied. Tier rows keep the job's designs.

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
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

const QS = (sides: 1 | 2, qty: number, designs: number, printer = "mimaki") =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=${printer}&pwhitelayers=0&pglosslayers=0`;

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

describe("1-2, 6-7. the Split Bag uses the approved Sticker Bag pricing resolver", () => {
  it("1-2. Split Bag resolves the bags-4x5 rule (never the universal fallback); the resolver refuses any other basis", () => {
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "Split Bag")).toBe("bags-4x5");
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "4x5 Sticker Bag Blank")).toBe("bags-4x5");
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "14x16 bag")).toBeNull(); // other sizes unchanged
    const row = { jobCost: 100, unitCost: 0.2, totalPrice: 230, unitPrice: 0.46 };
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: "bags-4x5", row })).toMatchObject({ approved: true, kind: "split_bag_sticker_bag_ladder", label: SPLIT_BAG_PRICE_AUTHORITY_TEXT });
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: null, row }).approved).toBe(false);
    expect(SPLIT_BAG_PRICE_AUTHORITY_TEXT).toBe("PRICE AUTHORITY: Approved Sticker Bag pricing ladder applied to Split Bag true cost. Owner may override a specific quote.");
  });

  it("6-7. same tier structure (11-point sticker-bag ladder) and the same single / double bands, 45% family minimum", async () => {
    const { pm } = await calculate(QS(1, 500, 1));
    expect(pm.marginFamily).toMatchObject({ key: "bags-4x5", configured: true, minPct: 45 });
    expect(pm.tiers.map((t: any) => t.quantity)).toEqual(STICKER_BAG_DISPLAY_LADDER);
    const values = defaultPricingPolicyValues();
    for (const t of pm.tiers) {
      const band = [...BAGS_4X5_SINGLE_BANDS].reverse().find((b) => t.quantity >= b.minQty)!;
      expect(t.marginPct, String(t.quantity)).toBeGreaterThanOrEqual(band.targetPct); // band, or a raising-only minimum
    }
    expect(marginCurveKeyFor("bags-4x5", 2)).toBe("bags-4x5-double");
    expect(values.marginCurves.families["bags-4x5"].familyMinPct).toBe(45);
  }, 180_000);
});

describe("3-5, 8-10. automatic prices from the Split Bag's OWN true cost", () => {
  const cases = [
    { n: "8", label: "500 / 1 design / front only", qs: QS(1, 500, 1), cost: 228.9962, band: 58, total: 545.2290, unit: 1.09046, profit: 316.2328 },
    { n: "9", label: "500 / 1 design / front + back", qs: QS(2, 500, 1), cost: 366.6591, band: 54, total: 797.0849, unit: 1.59417, profit: 430.4259 },
    { n: "10", label: "3,800 / 30 designs / front + back / Roland (live job)", qs: QS(2, 3800, 30, "roland"), cost: 2792.4818, band: 49, total: 5475.4545, unit: 1.44091, profit: 2682.9727 },
  ];
  for (const c of cases) {
    it(`${c.n}. ${c.label}: ${c.band}% Sticker Bag band on its own cost`, async () => {
      const { row, result } = await calculate(c.qs);
      expect(result.state).toBe("READY");
      expect(result.badge).toBe("READY TO QUOTE");
      expect(result.priceAuthority).toBe(SPLIT_BAG_PRICE_AUTHORITY_TEXT);
      expect(result.trueJobCost).toBeCloseTo(c.cost, 3); // (4) own true cost
      expect(row.commercial.controllingRule).toBe(`Cost-based price — ${c.band}% quantity-band margin`);
      expect(row.commercial.marginSource).toMatch(/^4x5 sticker bags researched curve at quantity band/);
      expect(result.recommendedTotal!).toBeCloseTo(c.total, 3);
      expect(result.recommendedUnit!).toBeCloseTo(c.unit, 4);
      expect(result.profit!).toBeCloseTo(c.profit, 3);
      expect(result.marginPct!).toBeCloseTo(c.band, 6);
      expect(result.recommendedTotal!).toBeCloseTo(c.cost / (1 - c.band / 100), 3);
      // (3) the 4x5 market dollar target never contends
      expect(row.commercial.candidates.verifiedMarketTargetPrice).toBeNull();
    }, 180_000);
  }

  it("3. the 4x5 dollar price is NOT copied: where the 4x5 market target would control, a Split Bag stays on its own cost", () => {
    const values = defaultPricingPolicyValues();
    const band = marketTargetBandFor(values, "bags-4x5", 500)!;
    expect(band.target).not.toBeNull();
    // a low cost where the 4x5 $/bag target outranks the cost-based band price
    const common = { familyKey: "sticker-bags", quantity: 500, completeCost: 100, marginRule: resolveMarginFamily("bags-4x5"), premiumEligible: false, policyValues: values, marginCurveKey: "bags-4x5" };
    const asStandard4x5 = computeCommercialPrice(common);
    const asSplitBag = computeCommercialPrice({ ...common, marketTargetSpecialtyReasons: [SPLIT_BAG_NO_4X5_MARKET_TARGET], specialty: null });
    expect(asStandard4x5.finalTotalPrice).toBeCloseTo(band.target! * 500, 6);
    expect(asStandard4x5.controllingRule).toBe("Verified market target (owner config)");
    expect(asSplitBag.candidates.verifiedMarketTargetPrice).toBeNull();
    expect(asSplitBag.controllingRule).not.toBe("Verified market target (owner config)");
    expect(asSplitBag.finalTotalPrice).toBeLessThan(asStandard4x5.finalTotalPrice);
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(route).toContain("marketTargetSpecialtyReasons: splitBagP ? [...specialtyReasonsP, SPLIT_BAG_NO_4X5_MARKET_TARGET] : specialtyReasonsP");
    expect(route).toContain("marketTargetSpecialtyReasons: savedSplitBag ? [...specialtyReasonsSave, SPLIT_BAG_NO_4X5_MARKET_TARGET] : specialtyReasonsSave");
    expect(route).toContain("specialty: splitBagP ? null : {");
    expect(route).toContain("specialty: savedSplitBag ? null : {");
  });

  it("5. landed blank stays $0.164 ($0.14 vendor + $0.024 inbound freight)", () => {
    expect(SPLIT_BAG_BLANK_UNIT_COST).toBe(0.14);
    expect(SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT).toBeCloseTo(0.024, 12);
    expect(SPLIT_BAG_LANDED_UNIT_COST).toBeCloseTo(0.164, 12);
  });
});

describe("11-13. design count is retained across tier simulations and shown", () => {
  it("11. every tier of the 3,800 / 30-design job prices 30 designs (64 bags carry all 30 art setups)", async () => {
    const thirty = await calculate(QS(2, 3800, 30, "roland"));
    const one = await calculate(QS(2, 3800, 1, "roland"));
    expect(thirty.pm.designCount).toBe(30);
    const t64 = thirty.pm.tiers.find((t: any) => t.quantity === 64);
    const o64 = one.pm.tiers.find((t: any) => t.quantity === 64);
    expect(t64.jobCost - o64.jobCost).toBeCloseTo(thirty.row.jobCost - one.row.jobCost, 2); // the same 29 extra design setups at every quantity
    expect(t64.unitCost).toBeGreaterThan(5);
    expect(t64.marginPct).toBe(65);
  }, 180_000);

  it("12. changing designs changes cost and recommended price", async () => {
    const one = (await calculate(QS(2, 3800, 1, "roland"))).result;
    const thirty = (await calculate(QS(2, 3800, 30, "roland"))).result;
    expect(thirty.trueJobCost! - one.trueJobCost!).toBeGreaterThan(200);
    expect(thirty.recommendedTotal!).toBeGreaterThan(one.recommendedTotal!);
    expect(one.recommendedTotal!).toBeCloseTo(one.trueJobCost! / 0.51, 3); // 49% band either way
  }, 180_000);

  it("13. the tier table states the design assumption, has a Designs column and the Split Bag pricing statement", () => {
    expect(tierDesignAssumptionText(30)).toBe("Tier estimates retain the current job's number of unique designs. This job has 30 designs.");
    expect(tierDesignAssumptionText(1)).toBe("Tier estimates retain the current job's number of unique designs. This job has 1 design.");
    expect(SPLIT_BAG_TIER_TABLE_TEXT).toBe("SPLIT BAG PRICING — Uses approved Sticker Bag quantity pricing ladder with Split Bag true manufacturing cost.");
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(route).toContain("<b>{tierDesignAssumptionText(pm.designCount)}</b>");
    expect(route).toContain('<th align="left">Quantity</th><th>Designs</th><th>Job Cost</th>');
    expect(route).toContain("<td align=\"center\">{Number(pm.designCount || 1).toLocaleString()}</td>");
    expect(route).toContain("<b>{SPLIT_BAG_TIER_TABLE_TEXT}</b>");
    expect(route).not.toContain("DEDICATED SPLIT BAG LADDER NOT YET APPROVED");
  });
});

describe("14-16. other families unchanged", () => {
  const row = { quantity: 1000, requested: true, jobCost: 400, unitCost: 0.4, unitPrice: 0.9, totalPrice: 900, profit: 500, actualMarginPct: 55, marginPct: 55, draftOnly: false, status: "READY TO QUOTE", commercial: { controllingRule: "curve", marginSource: "researched curve", ownerLadder: null } };
  it("14. Standard 4x5 keeps its authority, bands and market targets (no Split Bag exclusion)", () => {
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, marginRuleKey: "bags-4x5", row })).toMatchObject({ approved: true, kind: "approved_margin_curve", label: APPROVED_MARGIN_CURVE_AUTHORITIES["bags-4x5"] });
    expect(BAGS_4X5_SINGLE_BANDS.map((b) => b.targetPct)).toEqual([65, 64, 61, 58, 57, 55, 52, 50]);
    expect(BAGS_4X5_DOUBLE_BANDS.map((b) => b.targetPct)).toEqual([65, 61, 58, 54, 52, 49, 47]);
    const values = defaultPricingPolicyValues();
    const std = computeCommercialPrice({ familyKey: "sticker-bags", quantity: 500, completeCost: 165.7335, marginRule: resolveMarginFamily("bags-4x5"), premiumEligible: false, policyValues: values, marginCurveKey: "bags-4x5" });
    expect(std.controllingRule).toBe("Verified market target (owner config)"); // the 4x5 still gets its own market target
  });
  it("15. Stock Bags keep the storefront authority", () => {
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: true, marginRuleKey: "bags-4x5", row: { ...row, stockBagStorefront: { ok: true, version: "v" } } })).toMatchObject({ approved: true, kind: "storefront_stock_bag" });
  });
  it("16. jars keep the owner ladder", () => {
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "miron-jars", row: { ...row, commercial: { ...row.commercial, ownerLadder: { label: "Miron 16D" } } } })).toMatchObject({ approved: true, kind: "owner_jar_ladder" });
  });
});

/* ---------------- quote workflow ---------------- */
const TRUE_UNIT = 2792.4818066232533 / 3800;
const AUTO_UNIT = 5475.454522790693 / 3800;
function autoItem(id: string) {
  return {
    id, quoteId: "q1", productName: "Split Bag", quantity: 3800, unitCost: TRUE_UNIT, unitPrice: AUTO_UNIT, discountPct: 0,
    costSnapshot: JSON.stringify({ canonical: { family: "split-bags", unitCost: TRUE_UNIT, totalCost: 2792.48, quantity: 3800 }, productBreakdown: { splitBag: true } }),
    priceSnapshot: JSON.stringify({ unitPrice: AUTO_UNIT, pricingAuthority: { approved: true, status: "APPROVED", kind: "split_bag_sticker_bag_ladder", source: SPLIT_BAG_PRICE_AUTHORITY_TEXT, missing: null, approvedUnitPrice: AUTO_UNIT, approvedTotalPrice: 5475.45, approvedQuantity: 3800, expectedProfit: 2682.97, expectedMarginPct: 49 } }),
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

describe("17-18. quote workflow", () => {
  it("the real save records the ladder price and authority; the quote can be sent without an override", async () => {
    const route: any = await import("../app/routes/app.erp.cost-calculator");
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${QS(2, 3800, 30, "roland")}`, pseltier: "3800", ecustomer: "Live Customer" });
    const json = await (await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) })).json();
    expect(json.ok, json.message).toBe(true);
    const item = dbState.writes.find((w) => w.op === "quote.create")!.args.data.items.create[0];
    const price = JSON.parse(item.priceSnapshot);
    expect(item.unitPrice).toBeCloseTo(AUTO_UNIT, 6);
    expect(price.pricingAuthority).toMatchObject({ approved: true, kind: "split_bag_sticker_bag_ladder", approvedQuantity: 3800, expectedMarginPct: 49 });
    expect(price.pricingAuthority.expectedProfit).toBeCloseTo(2682.97, 2);
    const quote = { status: "draft", items: [{ productName: "Split Bag", quantity: 3800, unitCost: item.unitCost, unitPrice: item.unitPrice, priceSnapshot: item.priceSnapshot }] };
    expect(provisionalQuoteStatusCheck(quote as any, "sent").ok).toBe(true);
  }, 180_000);

  it("17. owner override still works quote by quote (and only for the owner)", async () => {
    expect(OWNER_OVERRIDABLE_AUTOMATIC_KINDS).toEqual(["split_bag_sticker_bag_ladder"]);
    const store = fakeQuoteDb([autoItem("i1"), autoItem("i2")]);
    const result: any = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.35", reason: "repeat customer", owner: resolveOwnerAuthorization(as(OWNER)) });
    expect(result.ok, result.error).toBe(true);
    expect(store.state.itemWrites).toHaveLength(1);
    expect(itemPricingAuthority(store.state.quote.items[0])!.ownerApproval!.overrodeRecommendation).toMatchObject({ kind: "split_bag_sticker_bag_ladder", unitPrice: AUTO_UNIT });
    expect(itemPricingAuthority(store.state.quote.items[1])).toMatchObject({ approved: true, kind: "split_bag_sticker_bag_ladder" });
    process.env.GSO_STAFF_ROLES = "1002:sales";
    const denied = fakeQuoteDb([autoItem("i1")]);
    expect((await ownerSetQuoteItemPrice(denied.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "0.90", reason: "x", owner: resolveOwnerAuthorization(as("1002")) })).ok).toBe(false);
    expect(denied.state.itemWrites).toHaveLength(0);
  });

  it("18. historical saved snapshots keep their saved cost", () => {
    const old = { productName: "Split Bag", quantity: 500, unitCost: 0.1, costSnapshot: JSON.stringify({ canonical: { family: "split-bags", status: "PROVISIONAL", unitCost: 0.5439924, totalCost: 271.9962, quantity: 500 } }) };
    expect(enforceQuoteItemUnitCost(old as any)).toMatchObject({ protected: true, unitCost: 0.5439924 });
  });
});
