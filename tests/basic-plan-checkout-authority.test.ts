// Basic-plan checkout authority (2026-10-17).
//
// The store is on Shopify Basic, where Cart Transform lineUpdate price
// overrides are unavailable. The ONLY authorised configured purchase path is:
//   configuration -> /apps/wholesale-lite/configurator-checkout (server reprices)
//   -> draftOrderCreate (custom line, server price) -> invoiceUrl checkout
//   -> orders_paid -> production job.
//
// These tests drive the REAL route actions; only the Shopify auth boundary,
// Prisma and the network are mocked. The draft-order payload is captured at the
// fetch boundary, so every assertion is on exactly what Shopify would receive.
import { beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "942075-2.myshopify.com";

const h = vi.hoisted(() => {
  const products: Record<string, any> = {};
  const touched = new Set<string>();
  const reviewItems: any[] = [];
  const dbTarget: any = {
    configuratorProduct: {
      findFirst: async ({ where }: any) => {
        const ids = (where.OR || []).map((o: any) => o.shopifyHandle || o.shopifyProductGid);
        const hit = ids.map((id: string) => products[id]).find(Boolean);
        if (!hit) return null;
        if (where.productType && where.productType !== hit.productType) return null;
        return hit;
      },
    },
    configuratorPricingRule: { findMany: async () => [] },
    agentReviewQueueItem: { create: async ({ data }: any) => { reviewItems.push(data); return data; } },
  };
  // Any model the checkout touches is recorded, so "no production job before
  // payment" is asserted on real access, not on a grep.
  const db = new Proxy(dbTarget, {
    get(target, prop: string) {
      touched.add(prop);
      return target[prop];
    },
  });
  return { products, touched, reviewItems, db, createJob: vi.fn(), webhookPayload: { current: null as any } };
});

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    public: { appProxy: async () => ({ session: { shop: "942075-2.myshopify.com", accessToken: "test-token" } }) },
    webhook: async () => ({ payload: h.webhookPayload.current, shop: "942075-2.myshopify.com" }),
  },
  unauthenticated: { admin: async () => ({ session: null }) },
}));
vi.mock("../app/db.server", () => ({ db: h.db, default: h.db }));
vi.mock("../app/lib/canonical-bag-pricing.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  const { defaultPricingPolicyValues } = await import("../app/lib/commercial-pricing-policy.server");
  const { BAG_4X5_BLANK_UNIT_COST } = await import("../app/lib/bag-cost-inputs.server");
  return {
    ...actual,
    // Same deterministic fixture the commercial-price-safety tests use, at the
    // CURRENT approved blank cost ($0.11, owner decision 2026-10-08).
    resolveCanonicalBagInputs: async () => ({
      available: true,
      reasons: [],
      matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 },
      holographic: { name: "Holographic", costPerSqft: 0.7141463415 },
      blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: BAG_4X5_BLANK_UNIT_COST, tiers: [] },
      rolandSqftPerHour: 150,
      policyValues: defaultPricingPolicyValues(),
    }),
  };
});
vi.mock("../app/lib/canonical-sticker-pricing.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  const { DOCUMENTED_PRINTER_SQFT_PER_HOUR } = await import("../app/lib/product-driven-costing.server");
  return {
    ...actual,
    resolveCanonicalStickerInputs: async () => ({
      available: true,
      reasons: [],
      matte: { name: "Poseidon Matte Vinyl", costPerSqft: 0.26 },
      holographic: { name: "Holographic Vinyl", costPerSqft: 1.2 },
      rolandSqftPerHour: DOCUMENTED_PRINTER_SQFT_PER_HOUR,
      policyValues: undefined,
    }),
  };
});
vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, createProductionJobFromSource: h.createJob };
});
vi.mock("../app/lib/production-alert.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, sendProductionAlertSafe: async () => ({ ok: true }) };
});

import { action as checkoutAction } from "../app/routes/apps.wholesale-lite.configurator-checkout";
import { action as ordersPaidAction } from "../app/routes/webhooks.orders_paid";
import { priceDtpConfiguration } from "../app/lib/canonical-dtp-pricing.server";
import { priceJarConfiguration } from "../app/lib/canonical-jar-pricing";
import { priceStickerConfiguration, resolveCanonicalStickerInputs } from "../app/lib/canonical-sticker-pricing.server";
import { parseCanonicalOrderLine } from "../app/lib/order-canonical.server";
import { isConfiguratorLine, unverifiedConfiguratorLinesOf } from "../app/lib/production-job-source.server";

const fetchCalls: Array<{ url: string; body: any }> = [];

function product(handle: string, productType: string, extra: Record<string, any> = {}) {
  h.products[handle] = {
    id: `cp_${handle}`,
    shop: SHOP,
    active: true,
    title: extra.title || handle,
    productType,
    shopifyHandle: handle,
    shopifyProductGid: `gid://shopify/Product/${handle}`,
    sku: "",
    defaultSides: "Double Sided",
    minQuantity: 50,
    ...extra,
  };
}

async function checkout(item: Record<string, any>) {
  const res = await checkoutAction({
    request: new Request("https://example.test/apps/wholesale-lite/configurator-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [item] }),
    }),
  } as any);
  return { status: res.status, json: (await res.json()) as any };
}

function draftInput() {
  const call = fetchCalls.find((c) => String(c.body?.query || "").includes("draftOrderCreate"));
  return call?.body?.variables?.input;
}

function attrs(line: any): Record<string, string> {
  return Object.fromEntries((line.customAttributes || []).map((a: any) => [a.key, a.value]));
}

const STOCK_BAG_50 = { handle: "4x5-stock-bag", material: "Matte", finish: "No Spot Gloss", bagColor: "Black", quantity: 50 };

beforeEach(() => {
  fetchCalls.length = 0;
  h.touched.clear();
  h.reviewItems.length = 0;
  h.createJob.mockReset();
  h.createJob.mockResolvedValue({ job: null, created: false, reason: "test" });
  for (const key of Object.keys(h.products)) delete h.products[key];
  product("4x5-stock-bag", "stock_bag_4x5", { title: "4x5 Stock Bag" });
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(
      JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://942075-2.myshopify.com/invoices/abc" }, userErrors: [] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
});

describe("50-bag control: server price is the only price", () => {
  it("50 configured 4x5 Stock Bags create a $135.00 draft order ($2.70 each)", async () => {
    const { status, json } = await checkout(STOCK_BAG_50);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.cartTotal).toBe(135);
    expect(json.invoiceUrl).toContain("/invoices/");
    const line = draftInput().lineItems[0];
    expect(line.quantity).toBe(50);
    expect(line.originalUnitPriceWithCurrency).toEqual({ amount: "2.70", currencyCode: "USD" });
    // custom line (no variant) — the charged price is exactly the server price
    expect(line.variantId).toBeUndefined();
  });

  const TAMPERS: Array<[string, Record<string, any>]> = [
    ["_GSO Price Each = 0.01", { "_GSO Price Each": "0.01", properties: { "_GSO Price Each": "0.01", _gso_configurator: "true" } }],
    ["price / unitPrice / priceEach / total = 0.01", { price: 0.01, unitPrice: 0.01, priceEach: 0.01, total: 0.5, orderTotal: 0.5, cartTotal: 0.5 }],
    ["missing price property", {}],
    ["wrong (non-numeric) price property", { "_GSO Price Each": "free", priceEach: "abc" }],
    ["tampered tier", { "_GSO Matched Tier": "25000+", matchedTier: "25000+", matchedRange: "25000+", tier: 25000 }],
    ["ERP-key spelling + cost/margin", { "_GSO ERP Price Each": "0.01", costEach: 0.01, margin: 99 }],
  ];
  for (const [label, tamper] of TAMPERS) {
    it(`tamper "${label}" cannot change the charged price`, async () => {
      const { json } = await checkout({ ...STOCK_BAG_50, ...tamper });
      expect(json.ok).toBe(true);
      expect(json.cartTotal).toBe(135);
      const line = draftInput().lineItems[0];
      expect(line.originalUnitPriceWithCurrency.amount).toBe("2.70");
      // client price keys never reach the draft order
      const keys = (line.customAttributes || []).map((a: any) => a.key);
      for (const forbidden of ["_GSO Price Each", "_GSO ERP Price Each", "_GSO Matched Tier", "_gso_configurator", "price", "unitPrice"]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  }

  it("a below-MOQ quantity is raised to 50, never priced below the ladder", async () => {
    const { json } = await checkout({ ...STOCK_BAG_50, quantity: 1 });
    expect(draftInput().lineItems[0].quantity).toBe(50);
    expect(json.cartTotal).toBe(135);
  });
});

describe("draft order carries what ERP production needs", () => {
  it("family, identity, options, sides and the server canonical snapshot survive", async () => {
    await checkout({ ...STOCK_BAG_50, zakekeDesignId: "design-42" });
    const input = draftInput();
    expect(input.tags).toContain("GSO Configurator");
    const line = input.lineItems[0];
    expect(line.title).toBe("4x5 Stock Bag - Matte / No Spot Gloss / Black");
    const a = attrs(line);
    expect(a["Product Family"]).toBe("Stock Bags");
    expect(a["Product Type"]).toBe("stock_bag_4x5");
    expect(a.Material).toBe("Matte");
    expect(a.Finish).toBe("No Spot Gloss");
    expect(a["Bag Color"]).toBe("Black");
    expect(a.Sides).toBe("Double Sided");
    expect(Object.values(a)).toContain("design-42"); // art/customization identity
    const canonical: any = parseCanonicalOrderLine(a["_GSO Canonical"]);
    expect(canonical).not.toBeNull();
    expect(canonical).toMatchObject({ profile: "stock_bag_4x5", qty: 50, faces: 2, material: "Matte", bagColor: "Black", glossX: 0, unitPrice: 2.7 });
    // the paid order's line (draft custom attributes -> order properties) is a
    // production-eligible configurator line
    expect(isConfiguratorLine({ properties: line.customAttributes.map((x: any) => ({ name: x.key, value: x.value })) })).toBe(true);
  });

  it("no production job, review item or other ERP write happens before payment", async () => {
    await checkout(STOCK_BAG_50);
    expect([...h.touched].sort()).toEqual(["configuratorPricingRule", "configuratorProduct"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.query).toContain("draftOrderCreate");
    expect(h.createJob).not.toHaveBeenCalled();
  });
});

describe("representative families price from their own server authority", () => {
  it("DTP 4x5x2 owner ladder (1000/2500/5000/10000) is charged exactly", async () => {
    product("dtp-4x5x2", "dtp_4x5x2", { title: "4x5x2 DTP Pouch" });
    for (const [quantity, unit] of [[1000, "1.30"], [2500, "0.71"], [5000, "0.46"], [10000, "0.37"]] as const) {
      fetchCalls.length = 0;
      const { json } = await checkout({ handle: "dtp-4x5x2", quantity, priceEach: 0.01 });
      expect(json.ok, String(quantity)).toBe(true);
      expect(draftInput().lineItems[0].originalUnitPriceWithCurrency.amount).toBe(unit);
    }
  });

  it("DTP above the online cap and legacy 5x4x2 fail closed to a quote request", async () => {
    product("dtp-4x5x2", "dtp_4x5x2");
    product("dtp-5x4x2", "dtp_5x4x2");
    const over = await checkout({ handle: "dtp-4x5x2", quantity: 25001 });
    expect(over.json.ok).toBe(false);
    expect(over.json.requestQuote).toBe(true);
    const legacy = await checkout({ handle: "dtp-5x4x2", quantity: 1000 });
    expect(legacy.json.ok).toBe(false);
    expect(legacy.json.requestQuote).toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(priceDtpConfiguration({ productType: "dtp_4x5x2", quantity: 25000 }).ok).toBe(false); // storefront cap 10,000
  });

  it("launch jars price through the canonical jar engine", async () => {
    product("jar-150ml", "jar_150ml", { title: "150ml Miron Jar" });
    const { json } = await checkout({ handle: "jar-150ml", quantity: 500, material: "Matte", labelSet: "Standard", finish: "Standard — 0X", priceEach: 0.01 });
    expect(json.ok).toBe(true);
    const expected = priceJarConfiguration({ productType: "jar_150ml", quantity: 500, baseFinish: "Matte", labelMaterial: "Standard", specialty: "Standard — 0X" });
    if (!expected.ok) throw new Error("fixture jar must price");
    expect(draftInput().lineItems[0].originalUnitPriceWithCurrency.amount).toBe(expected.unitPrice.toFixed(2));
  });

  it("stickers recompute from dimensions through the canonical sticker engine", async () => {
    product("sticker", "sticker_regular", { title: "Custom Sticker" });
    const { json } = await checkout({ handle: "sticker", quantity: 100, widthIn: 3, heightIn: 3, material: "Matte", finish: "Standard — 0X", priceEach: 0.01 });
    expect(json.ok).toBe(true);
    const expected = priceStickerConfiguration(await resolveCanonicalStickerInputs(null, SHOP), {
      productType: "sticker_regular", widthIn: "3", heightIn: "3", quantity: 100, material: "Matte", specialty: "Standard — 0X",
    });
    if (!expected.ok) throw new Error("fixture sticker must price");
    expect(draftInput().lineItems[0].originalUnitPriceWithCurrency.amount).toBe(expected.unitPrice.toFixed(2));
  });

  it("sticker bags price on the bag engine but require a design first", async () => {
    product("sticker-bag", "sticker_bag_4x5", { title: "4x5 Sticker Bag" });
    const blocked = await checkout({ ...STOCK_BAG_50, handle: "sticker-bag" });
    expect(blocked.json.ok).toBe(false);
    expect(blocked.json.code).toBe("ZAKEKE_DESIGN_REQUIRED");
    const { json } = await checkout({ ...STOCK_BAG_50, handle: "sticker-bag", zakekeDesignId: "design-7", priceEach: 0.01 });
    expect(json.ok).toBe(true);
    expect(json.cartTotal).toBe(135);
  });
});

describe("unsupported or blocked configurations fail closed", () => {
  it("banners are not a configurator product", async () => {
    product("banner", "banner_vinyl");
    const { json } = await checkout({ handle: "banner", quantity: 1, material: "13oz", finish: "Grommets", bagColor: "n/a" });
    expect(json).toMatchObject({ ok: false, code: "PRODUCT_NOT_CONFIGURABLE" });
  });

  it("a dtp_/sticker_ type with no launch pricer is never charged as a 4x5 bag", async () => {
    product("dtp-bag", "dtp_bag");
    product("sticker-label", "sticker_label");
    for (const handle of ["dtp-bag", "sticker-label"]) {
      const { json } = await checkout({ ...STOCK_BAG_50, handle });
      expect(json, handle).toMatchObject({ ok: false, code: "NO_PRICING_AUTHORITY" });
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it("Deep Build 9X+ and 5,000+ bags request a quote instead of pricing", async () => {
    const deep = await checkout({ ...STOCK_BAG_50, finish: "9X Spot Gloss" });
    expect(deep.json.ok).toBe(false);
    const volume = await checkout({ ...STOCK_BAG_50, quantity: 5000 });
    expect(volume.json.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("unknown product, missing options and inactive products create no draft order", async () => {
    expect((await checkout({ ...STOCK_BAG_50, handle: "nope" })).status).toBe(404);
    expect((await checkout({ ...STOCK_BAG_50, bagColor: "" })).json.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("orders_paid: only server-priced configured lines become production jobs", () => {
  async function paid(order: any) {
    h.webhookPayload.current = order;
    const res = await ordersPaidAction({ request: new Request("https://example.test/webhooks/orders_paid", { method: "POST" }) } as any);
    return { status: res.status, text: await res.text() };
  }

  async function draftOrderPaidOrder() {
    await checkout(STOCK_BAG_50);
    const line = draftInput().lineItems[0];
    return {
      id: 9001,
      admin_graphql_api_id: "gid://shopify/Order/9001",
      name: "#9001",
      line_items: [{
        id: 1, title: line.title, quantity: line.quantity, price: line.originalUnitPriceWithCurrency.amount,
        variant_id: null, product_id: null,
        properties: line.customAttributes.map((x: any) => ({ name: x.key, value: x.value })),
      }],
    };
  }

  it("a paid server-priced draft order goes to production-job creation unchanged", async () => {
    const order = await draftOrderPaidOrder();
    expect(unverifiedConfiguratorLinesOf(order)).toHaveLength(0);
    const { status } = await paid(order);
    expect(status).toBe(200);
    expect(h.createJob).toHaveBeenCalledTimes(1);
    expect(h.createJob.mock.calls[0][1]).toMatchObject({ source: { type: "shopify_order", order }, actor: "orders_paid_webhook" });
  });

  it("a native /cart/add configured line (forged properties, $1 variant) is held for review — no job", async () => {
    const forged = await draftOrderPaidOrder();
    forged.line_items[0] = { ...forged.line_items[0], variant_id: 123456, product_id: 654321, price: "1.00" } as any;
    const { status, text } = await paid(forged);
    expect(status).toBe(200);
    expect(text).toContain("held for price review");
    expect(h.createJob).not.toHaveBeenCalled();
    expect(h.reviewItems).toHaveLength(1);
    expect(h.reviewItems[0]).toMatchObject({ source: "shopify_order_unverified_price", reviewLevel: "owner_review", createdBy: "orders_paid_webhook" });
    expect(h.reviewItems[0].internalNotes).toContain("@ $1.00");
  });

  it("ordinary non-configured paid orders keep the existing path", async () => {
    await paid({ id: 77, admin_graphql_api_id: "gid://shopify/Order/77", name: "#77", line_items: [{ title: "T-shirt", quantity: 1, variant_id: 5, properties: [] }] });
    expect(h.createJob).toHaveBeenCalledTimes(1);
  });
});
