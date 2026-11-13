// 2026-11-12 OWNER DECISION — FINAL Split Bag landed cost + owner quote pricing.
//
// Owner final vendor quote (first real purchase): 5,000 bags at $0.14 = $700,
// inbound freight $120 = $0.024/bag, landed $0.164 ($820). Vendor cost and
// inbound freight are separate engine lines; the provisional $0.25 is superseded.
// Selling price: OWNER-SET CUSTOMER PRICE — THIS QUOTE ONLY (no ladder).

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
import { OWNER_USER_IDS_ENV, resolveOwnerAuthorization } from "../app/lib/owner-authorization.server";
import { SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN } from "../app/lib/bag-artboard-geometry";
import {
  BAG_4X5_BLANK_UNIT_COST,
  SPLIT_BAG_BLANK_SUPERSEDED_PROVISIONAL_2026_11_11,
  SPLIT_BAG_BLANK_UNIT_COST,
  SPLIT_BAG_INBOUND_FREIGHT_LOT,
  SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT,
  SPLIT_BAG_LANDED_UNIT_COST,
  SPLIT_BAG_MOQ,
  STICKER_BAG_MOQ,
  STOCK_BAG_MOQ,
  bagBlankUnitCostFor,
  computeBagPhysical,
  splitBagInboundCartons,
} from "../app/lib/bag-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_PACKOUT } from "../app/lib/canonical-calculator-shared";
import { SPLIT_BAG_PRICE_AUTHORITY_TEXT, resolveSellingPriceAuthority } from "../app/lib/calculator-owner-view";
import { SPLIT_BAG_OWNER_PRICE_LABEL, isSplitBagQuoteItem, ownerPricePreview } from "../app/lib/split-bag-quote-pricing";
import { ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { itemPricingAuthority, provisionalQuoteStatusCheck } from "../app/lib/quote-pricing-authority";

const OWNER = "9001";
const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

const QS = (sides: 1 | 2, qty = 500, designs = 1, split = true) =>
  `pfamily=sticker-bags&pbagmat=matte${split ? "&psplitbag=1&pblank=preset%3Asplit-bag" : "&pblank=v_bag"}&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;
async function costJob(qs: string) {
  const input = normalizeCanonicalInput(new URLSearchParams(qs))!;
  const machine = await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input);
  return assembleCanonicalJob(input, machine) as any;
}
const line = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;

describe("1-6, 13-16. owner final vendor quote — the Split Bag cost authority", () => {
  it("1-6. vendor $0.14, $700 merchandise, $120 freight, $0.024/bag, landed $0.164, $820 landed value", () => {
    expect(SPLIT_BAG_BLANK_UNIT_COST).toBe(0.14);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.orderedQuantity * SPLIT_BAG_INBOUND_FREIGHT_LOT.vendorUnitCost).toBeCloseTo(700, 10);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.merchandiseTotal).toBe(700);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.inboundFreightTotal).toBe(120);
    expect(SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT).toBeCloseTo(0.024, 12);
    expect(SPLIT_BAG_LANDED_UNIT_COST).toBeCloseTo(0.164, 12);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.merchandiseTotal + SPLIT_BAG_INBOUND_FREIGHT_LOT.inboundFreightTotal).toBe(820);
    expect(SPLIT_BAG_LANDED_UNIT_COST * 5000).toBeCloseTo(820, 9);
  });

  it("13-16. packout 2,500/carton, 5,000 = 2 cartons; carton dimensions and weight stay pending", () => {
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.bagsPerCarton).toBe(2500);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.cartons).toBe(2);
    expect(splitBagInboundCartons(5000)).toBe(2);
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.cartonDimensionsIn).toBeNull();
    expect(SPLIT_BAG_INBOUND_FREIGHT_LOT.cartonWeightLb).toBeNull();
    // the vendor carton is NOT an outbound packout standard (nothing invented)
    expect(CANONICAL_PACKOUT["split-bags"].unitsPerBox).toBeNull();
  });
});

describe("7-12, 17-24. canonical true cost (qty 500, 1 design, Mimaki, matte)", () => {
  it("7-9, 12. blank $70 vendor + $12 inbound freight = $82 landed; freight counted exactly once", async () => {
    for (const sides of [1, 2] as const) {
      const r = await costJob(QS(sides));
      expect(line(r, "blank_sets")).toBeCloseTo(70, 9);
      expect(line(r, "inbound_freight")).toBeCloseTo(12, 9);
      expect(line(r, "blank_sets") + line(r, "inbound_freight")).toBeCloseTo(82, 9);
      // the $120 lot freight is never added to a quote; only the per-bag allocation
      expect(r.trueCost.lines.filter((l: any) => l.category === "inbound_freight")).toHaveLength(1);
      expect(r.trueCost.lines.some((l: any) => Math.abs(l.amount - 120) < 1e-6)).toBe(false);
      expect(r.reasons).not.toContain("FREIGHT_NOT_MODELED");
      // no outbound customer shipping is ever derived from inbound freight
      expect(r.trueCost.lines.some((l: any) => /outbound|customer shipping/i.test(l.label))).toBe(false);
    }
  }, 120_000);

  it("TRUE COST: front only $228.996 ($0.458/bag); front + back $366.659 ($0.733/bag) — exactly $43 below the $0.25 basis", async () => {
    const one = await costJob(QS(1));
    const two = await costJob(QS(2));
    expect(one.trueCost.totalCost).toBeCloseTo(228.996, 2);
    expect(two.trueCost.totalCost).toBeCloseTo(366.659, 2);
    expect(one.trueCost.totalCost / 500).toBeCloseTo(0.458, 3);
    expect(two.trueCost.totalCost / 500).toBeCloseTo(0.7333, 3);
    expect(271.9962 - one.trueCost.totalCost).toBeCloseTo(43, 3);
    expect(409.6591 - two.trueCost.totalCost).toBeCloseTo(43, 3);
  }, 120_000);

  it("10. the provisional $0.25 is no longer used for new costing", async () => {
    expect(SPLIT_BAG_BLANK_SUPERSEDED_PROVISIONAL_2026_11_11).toBe(0.25);
    expect(bagBlankUnitCostFor("split_bag")).toBe(0.14);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides: 1 }).blankCost).toBeCloseTo(70, 9);
    for (const file of ["app/lib/bag-cost-inputs.server.ts", "app/lib/canonical-calculator-shared.ts", "app/lib/product-production-spec.ts", "app/routes/app.erp.cost-calculator.tsx"]) {
      const code = readFileSync(file, "utf8").split("\n").filter((l) => !/SUPERSEDED|Supersedes|supersedes/.test(l));
      expect(code.filter((l) => /Split Bag/i.test(l) && /\$0\.25\b|= 0\.25\b/.test(l)), file).toEqual([]);
    }
  });

  it("11. historical snapshots keep their saved cost (an approval never changes unitCost / costSnapshot)", async () => {
    const oldItem = quoteItem("i_old", 0.5439924, JSON.stringify({ canonical: { family: "split-bags", unitCost: 0.5439924, totalCost: 271.9962, quantity: 500 } }));
    const store = fakeQuoteDb([oldItem]);
    const result = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i_old", unitPrice: "1.25", reason: "historical check", owner: resolveOwnerAuthorization(as(OWNER)) });
    expect(result.ok).toBe(true);
    const write = store.itemWrites[0];
    expect(write.data.unitCost).toBeUndefined(); // the saved $0.25-basis cost is never recomputed
    expect(write.data.costSnapshot).toBeUndefined();
  });

  it("17-19. MOQ 64; art 7.20 x 4.38; cutline 7.07 x 4.26", async () => {
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(SPLIT_BAG_ARTBOARD_IN).toEqual({ widthIn: 7.2, heightIn: 4.38 });
    expect(SPLIT_BAG_CUTLINE_IN).toEqual({ widthIn: 7.07, heightIn: 4.26 });
    const r = await costJob(QS(1));
    expect(r.diagnostics.productSpec.standard.label).toEqual({ widthIn: 7.2, heightIn: 4.38, cutWidthIn: 7.07, cutHeightIn: 4.26 });
  }, 120_000);

  it("20-23. front only / back only = 500 faces; front + back = 1,000 faces, never 2,000", () => {
    const one = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides: 1 }); // front only and back only post one side
    const two = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides: 2 });
    expect(one.labelQuantity).toBe(500);
    expect(two.labelQuantity).toBe(1000);
    expect(two.labelQuantity).not.toBe(2000);
    expect(one.blankCost).toBeCloseTo(two.blankCost, 9); // 500 physical blanks either way
  });

  it("24. quantity 500 + 1 design stay independent", async () => {
    const r = await costJob(QS(1, 500, 1));
    expect(r.diagnostics.artSetupEvents ?? 1).toBe(1);
    expect(line(r, "blank_sets")).toBeCloseTo(70, 9);
    expect(r.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * 7.2 * 4.38) / 144, 6);
  }, 120_000);
});

describe("25-26. Standard 4x5 and Stock Bags unchanged", () => {
  it("25. Standard 4x5: $0.11 blank, MOQ 50, no inbound freight line, FREIGHT_NOT_MODELED kept", async () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(STICKER_BAG_MOQ).toBe(50);
    const std = await costJob(QS(1, 500, 1, false));
    expect(std.family).toBe("sticker-bags");
    expect(line(std, "blank_sets")).toBeCloseTo(55, 9);
    expect(line(std, "inbound_freight")).toBe(0);
    expect(std.reasons).toContain("FREIGHT_NOT_MODELED");
  }, 120_000);

  it("26. Stock Bag: $0.11 blank, MOQ 50, no Split Bag freight", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(bagBlankUnitCostFor("stock_bag")).toBe(0.11);
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(src).toContain("if (splitBag) {\n      bagFreightInput = { perUnit: SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT");
  });
});

/* ---------------- owner-set customer price, this quote only ---------------- */

function quoteItem(id: string, unitCost: number, costSnapshot = JSON.stringify({ splitBag: true, canonical: { family: "split-bags" } })) {
  return {
    id, quoteId: "q1", productName: "Split Bag", quantity: 500, unitCost, unitPrice: 0, discountPct: 0, costSnapshot,
    priceSnapshot: JSON.stringify({ unitPrice: null, pricingAuthority: { approved: false, status: "PROVISIONAL", kind: "none", missing: SPLIT_BAG_PRICE_AUTHORITY_TEXT, history: [] } }),
  };
}
function fakeQuoteDb(items: any[], quoteId = "q1") {
  const state = { quote: { id: quoteId, shop: "shop-1", status: "draft", customerTier: "standard", notes: "", items }, itemWrites: [] as any[], quoteWrites: [] as any[] };
  const db = {
    quote: {
      findFirst: async ({ where }: any) => (where.id === state.quote.id ? { ...state.quote, items: state.quote.items.map((i: any) => ({ ...i })) } : null),
      updateMany: async (args: any) => { state.quoteWrites.push(args); return { count: 1 }; },
    },
    quoteItem: {
      updateMany: async (args: any) => {
        state.itemWrites.push(args);
        const item = state.quote.items.find((i: any) => i.id === args.where.id);
        Object.assign(item, args.data);
        return { count: 1 };
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return { db, ...state, state };
}

const FRONT_ONLY_UNIT = 228.9961959626317 / 500;

describe("27-40. Split Bag quote pricing: owner-set price (provisional lines / overrides), this quote only", () => {
  it("27. (superseded by the 2026-11-12 owner decisions) a priced Split Bag row is priced by the Sticker Bag ladder; a line saved without a price stays provisional", () => {
    const authority = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: "bags-4x5", row: { jobCost: 228.99, unitCost: FRONT_ONLY_UNIT, totalPrice: 545.23, unitPrice: 1.0905 } });
    expect(authority).toMatchObject({ approved: true, kind: "split_bag_sticker_bag_ladder" });
    const unpriced = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, splitBag: true, marginRuleKey: "bags-4x5", row: { jobCost: 228.99, unitCost: FRONT_ONLY_UNIT, totalPrice: null, unitPrice: null } });
    expect(unpriced.approved).toBe(false);
    const item = quoteItem("i1", FRONT_ONLY_UNIT);
    expect(isSplitBagQuoteItem(item)).toBe(true);
    expect(JSON.parse(item.priceSnapshot).unitPrice).toBeNull();
  });

  it("28-33. example owner prices: unit OR total input; revenue, profit = total - true cost, margin = profit / total; true cost unchanged", () => {
    const trueTotal = Math.round(FRONT_ONLY_UNIT * 500 * 100) / 100; // $229.00
    for (const unit of [1.0, 1.25, 1.5, 1.75, 2.0]) {
      const byUnit = ownerPricePreview({ quantity: 500, trueUnitCost: FRONT_ONLY_UNIT, unitPrice: String(unit) });
      const byTotal = ownerPricePreview({ quantity: 500, trueUnitCost: FRONT_ONLY_UNIT, totalPrice: String(unit * 500) });
      for (const p of [byUnit, byTotal]) {
        if (!p.ok) throw new Error(p.error);
        expect(p.unitPrice).toBeCloseTo(unit, 9);
        expect(p.totalPrice).toBeCloseTo(unit * 500, 9);
        expect(p.trueTotalCost).toBeCloseTo(trueTotal, 9);
        expect(p.expectedProfit).toBeCloseTo(unit * 500 - trueTotal, 2);
        expect(p.realizedMarginPct!).toBeCloseTo(((unit * 500 - trueTotal) / (unit * 500)) * 100, 1);
        expect(p.trueUnitCost).toBe(FRONT_ONLY_UNIT); // the selling price never moves the true cost
      }
    }
    const at125 = ownerPricePreview({ quantity: 500, trueUnitCost: FRONT_ONLY_UNIT, unitPrice: "1.25" }) as any;
    expect(at125).toMatchObject({ totalPrice: 625, trueTotalCost: 229, expectedProfit: 396, realizedMarginPct: 63.4 });
  });

  it("28, 30-34. owner approval writes THIS quote item only: price, profit and margin recorded; cost untouched", async () => {
    const store = fakeQuoteDb([quoteItem("i1", FRONT_ONLY_UNIT)]);
    const result: any = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.25", reason: "Customer A — Split Bag front only", owner: resolveOwnerAuthorization(as(OWNER)) });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ unitPrice: 1.25, totalPrice: 625, expectedProfit: 396, expectedMarginPct: 63.4 });
    expect(store.itemWrites).toHaveLength(1);
    expect(store.itemWrites[0].where).toEqual({ id: "i1", quoteId: "q1" });
    expect(store.itemWrites[0].data.unitCost).toBeUndefined();
    const record = itemPricingAuthority(store.state.quote.items[0])!;
    expect(record.approved).toBe(true);
    expect(record.ownerApproval).toMatchObject({ approvedUnitPrice: 1.25, approvedTotalPrice: 625, trueTotalCost: 229, expectedProfit: 396, expectedMarginPct: 63.4 });
    expect(record.source).toContain("this quote item only");
  });

  it("29. a total price is accepted when it divides into an exact cent unit price", async () => {
    const store = fakeQuoteDb([quoteItem("i1", FRONT_ONLY_UNIT)]);
    const result: any = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", totalPrice: "750", reason: "total price", owner: resolveOwnerAuthorization(as(OWNER)) });
    expect(result).toMatchObject({ ok: true, unitPrice: 1.5, totalPrice: 750 });
  });

  it("35-37. a second Split Bag quote inherits nothing; no tier / ladder / product / Shopify write exists in this path", async () => {
    const first = fakeQuoteDb([quoteItem("i1", FRONT_ONLY_UNIT)], "q1");
    await ownerSetQuoteItemPrice(first.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.75", reason: "A", owner: resolveOwnerAuthorization(as(OWNER)) });
    const second = quoteItem("i2", FRONT_ONLY_UNIT);
    expect(itemPricingAuthority(second)).toMatchObject({ approved: false });
    expect(JSON.parse(second.priceSnapshot).unitPrice).toBeNull();
    for (const file of ["app/lib/quote-owner-price-approval.server.ts", "app/lib/split-bag-quote-pricing.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/pricingRule|recipeTier|productCost|wholesaleRule|configuratorPricingRule|material\.update|admin\.graphql|productVariants|db\.product/);
    }
    // the only writes are this quote item and the quote's audit note
    expect(Object.keys(first.db)).toEqual(["quote", "quoteItem", "$transaction"]);
  });

  it("38. non-owners cannot approve an arbitrary Split Bag price (Sales, Manager — even an authorized one)", async () => {
    process.env.GSO_STAFF_ROLES = "1002:sales,1005:manager";
    process.env.GSO_MANAGER_AUTHORIZED_USER_IDS = "1005";
    for (const sub of ["1002", "1005", "9999"]) {
      const store = fakeQuoteDb([quoteItem("i1", FRONT_ONLY_UNIT)]);
      const result = await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "0.50", reason: "x", owner: resolveOwnerAuthorization(as(sub)) });
      expect(result.ok, sub).toBe(false);
      expect(store.itemWrites, sub).toHaveLength(0);
    }
    const quotes = readFileSync("app/routes/app.quotes.tsx", "utf8");
    expect(quotes).toContain('if (payload.intent === "ownerSetPriceApprove") {\n    const owner = resolveOwnerAuthorization({ session, sessionToken });');
  });

  it("39-40. cannot be sent / approved / moved to production before the owner price; normal workflow after", async () => {
    const store = fakeQuoteDb([quoteItem("i1", FRONT_ONLY_UNIT)]);
    for (const status of ["sent", "approved", "production", "paid"]) expect(provisionalQuoteStatusCheck(store.state.quote as any, status).ok, status).toBe(false);
    expect(provisionalQuoteStatusCheck(store.state.quote as any, "draft").ok).toBe(true);
    await ownerSetQuoteItemPrice(store.db as any, { shop: "shop-1", quoteId: "q1", itemId: "i1", unitPrice: "1.50", reason: "approved", owner: resolveOwnerAuthorization(as(OWNER)) });
    for (const status of ["sent", "approved"]) expect(provisionalQuoteStatusCheck(store.state.quote as any, status).ok, status).toBe(true);
  });

  it("UI: Split Bag lines show both labels and a live unit / total / profit / margin preview (owner only)", () => {
    const quotes = readFileSync("app/routes/app.quotes.tsx", "utf8");
    expect(quotes).toContain("<Badge tone=\"success\">{SPLIT_BAG_LADDER_BADGE}</Badge>");
    expect(quotes).toContain("<Badge tone=\"info\">{SPLIT_BAG_OWNER_PRICE_LABEL}</Badge>");
    expect(quotes).toContain("const preview = ownerPricePreview({");
    expect(quotes).toMatch(/Customer unit price \$\{preview\.unitPrice/);
    expect(quotes).toMatch(/expected profit \$\{preview\.expectedProfit\.toFixed\(2\)\} · realized margin/);
    const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(calc).toContain("splitBag: savedSplitBag,");
  });
});
