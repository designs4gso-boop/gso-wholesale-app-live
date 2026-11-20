// Storefront reviewed fixes (2026-11-20).
//
// Three owner-approved rules, each driven through the REAL route handler with
// only the Shopify auth boundary, Prisma and the network mocked:
//   1. A Stock Bag line never carries a Zakeke design (premade artwork). The
//      posted id is DROPPED — the checkout still succeeds at the same price.
//   2. A jar with no launch size (jar_5oz_clear is cost-only) is not offered as
//      an active configurator product, and no legacy rule prices are served.
//   3. Configurator Sync writes the approved Stock Bag MOQ (50), not the
//      retired pilot value 64.
import { beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "942075-2.myshopify.com";

const h = vi.hoisted(() => {
  const products: Record<string, any> = {};
  const writes: Array<{ op: string; data: any }> = [];
  const state = { existing: null as any, shopifyNodes: [] as any[] };
  const legacyRules = [
    { material: "Matte", finish: "No Spot Gloss", minQty: 64, maxQty: 127, priceEach: 9.99, productionFinish: "CMYK", active: true },
    { material: "Matte", finish: "No Spot Gloss", minQty: 128, maxQty: null, priceEach: 8.88, productionFinish: "CMYK", active: true },
  ];
  const db: any = {
    configuratorProduct: {
      findFirst: async ({ where }: any) => {
        const ids = (where.OR || []).map((o: any) => o.shopifyHandle || o.shopifyProductGid);
        const hit = ids.map((id: string) => products[id]).find(Boolean);
        if (hit) return where.productType && where.productType !== hit.productType ? null : hit;
        return state.existing;
      },
      findMany: async () => [],
      count: async () => 0,
      create: async ({ data }: any) => { writes.push({ op: "create", data }); return data; },
      update: async ({ data }: any) => { writes.push({ op: "update", data }); return data; },
    },
    configuratorOption: { findMany: async () => [] },
    configuratorPricingRule: { findMany: async () => legacyRules },
  };
  return { products, writes, state, db };
});

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    public: { appProxy: async () => ({ session: { shop: "942075-2.myshopify.com", accessToken: "test-token" } }) },
    admin: async () => ({
      session: { shop: "942075-2.myshopify.com" },
      admin: {
        graphql: async () => ({
          json: async () => ({
            data: { collection: { products: { edges: h.state.shopifyNodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } },
          }),
        }),
      },
    }),
  },
  unauthenticated: { admin: async () => ({ session: null }) },
}));
vi.mock("../app/db.server", () => ({ db: h.db, default: h.db }));
vi.mock("../app/lib/owner-authorization.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, requireFinancialAccess: () => ({}) };
});
vi.mock("../app/lib/canonical-bag-pricing.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  const { defaultPricingPolicyValues } = await import("../app/lib/commercial-pricing-policy.server");
  const { BAG_4X5_BLANK_UNIT_COST } = await import("../app/lib/bag-cost-inputs.server");
  return {
    ...actual,
    // same deterministic fixture as tests/basic-plan-checkout-authority.test.ts
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

import { action as checkoutAction } from "../app/routes/apps.wholesale-lite.configurator-checkout";
import { loader as configuratorLoader } from "../app/routes/apps.wholesale-lite.configurator";
import { action as syncAction, loader as syncLoader } from "../app/routes/app.erp.configurator-sync";
import { STOCK_BAG_MOQ } from "../app/lib/bag-cost-inputs.server";
import { JAR_LAUNCH_TYPE_SIZES } from "../app/lib/canonical-jar-pricing";
import { STOREFRONT_BAG_MIN_QTY } from "../app/lib/storefront-canonical-pricing.server";
import {
  ZAKEKE_DESIGN_ID_KEY,
  ZAKEKE_PREVIEW_KEY,
  productTypeForbidsZakekeDesign,
  resolveZakekeDesign,
  zakekeDesignForProductType,
  zakekeDesignGate,
} from "../app/lib/zakeke-design.server";

const fetchCalls: any[] = [];

function product(handle: string, productType: string, extra: Record<string, any> = {}) {
  h.products[handle] = {
    id: `cp_${handle}`,
    shop: SHOP,
    active: true,
    title: extra.title || handle,
    productType,
    shopifyHandle: handle,
    shopifyProductGid: `gid://shopify/Product/${handle}`,
    shopifyVariantGid: `gid://shopify/ProductVariant/${handle}`,
    sku: "",
    defaultSides: "Double Sided",
    minQuantity: 50,
    ...extra,
  };
}

async function checkout(items: Array<Record<string, any>>) {
  const res = await checkoutAction({
    request: new Request("https://example.test/apps/wholesale-lite/configurator-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }),
  } as any);
  return { status: res.status, json: await res.json() };
}

async function load(query: string) {
  const res = await configuratorLoader({
    request: new Request(`https://example.test/apps/wholesale-lite/configurator?${query}`),
  } as any);
  return { status: res.status, json: await res.json(), text: "" };
}

function draftLines(): any[] {
  return fetchCalls[fetchCalls.length - 1].variables.input.lineItems;
}

function attrs(line: any): Record<string, string> {
  return Object.fromEntries(line.customAttributes.map((a: any) => [a.key, a.value]));
}

const BAG = { quantity: 50, material: "Matte", finish: "No Spot Gloss", bagColor: "Black" };

beforeEach(() => {
  for (const key of Object.keys(h.products)) delete h.products[key];
  h.writes.length = 0;
  h.state.existing = null;
  h.state.shopifyNodes = [];
  fetchCalls.length = 0;
  product("stock-bag", "stock_bag_4x5", { title: "4x5 Stock Bag" });
  product("sticker-bag", "sticker_bag_4x5", { title: "4x5 Sticker Bag" });
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    fetchCalls.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://example.test/invoice" }, userErrors: [] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
});

describe("1. a Stock Bag line never carries a Zakeke design", () => {
  it("drops the posted design id and still checks out at the identical price", async () => {
    const plain = await checkout([{ handle: "stock-bag", ...BAG }]);
    const plainLine = draftLines()[0];
    const posted = await checkout([{ handle: "stock-bag", ...BAG, zakekeDesignId: "design-42" }]);
    const line = draftLines()[0];

    expect(posted.status).toBe(200);
    expect(posted.json.ok).toBe(true);
    expect(posted.json.invoiceUrl).toBe("https://example.test/invoice");
    const a = attrs(line);
    expect(a["Product Family"]).toBe("Stock Bags");
    expect(a).not.toHaveProperty(ZAKEKE_DESIGN_ID_KEY);
    expect(a).not.toHaveProperty(ZAKEKE_PREVIEW_KEY);
    expect(JSON.stringify(line)).not.toContain("design-42");
    // nothing else about the line moved: same payload as an order with no id
    expect(line).toEqual(plainLine);
    expect(posted.json.cartTotal).toBe(plain.json.cartTotal);
    expect(line.originalUnitPriceWithCurrency).toEqual(plainLine.originalUnitPriceWithCurrency);
  });

  it("the snake_case alias and a hostile id are dropped too, never rejected", async () => {
    for (const extra of [{ zakeke_design_id: "design-9" }, { zakekeDesignId: "<script>" }, { zakekeDesignId: "x".repeat(500) }]) {
      const { json } = await checkout([{ handle: "stock-bag", ...BAG, ...extra }]);
      expect(json.ok).toBe(true);
      expect(Object.keys(attrs(draftLines()[0])).some((key) => /zakeke/i.test(key))).toBe(false);
    }
  });

  it("a Sticker Bag keeps its design, and is still refused without one", async () => {
    const blocked = await checkout([{ handle: "sticker-bag", ...BAG }]);
    expect(blocked.json).toMatchObject({ ok: false, code: "ZAKEKE_DESIGN_REQUIRED" });
    const { json } = await checkout([{ handle: "sticker-bag", ...BAG, zakekeDesignId: "design-7" }]);
    expect(json.ok).toBe(true);
    const a = attrs(draftLines()[0]);
    expect(a[ZAKEKE_DESIGN_ID_KEY]).toBe("design-7");
    expect(a[ZAKEKE_PREVIEW_KEY]).toBe("/apps/zakeke/preview/design-7");
  });

  it("is decided per line in a mixed cart", async () => {
    const { json } = await checkout([
      { handle: "stock-bag", ...BAG, zakekeDesignId: "design-A" },
      { handle: "sticker-bag", ...BAG, zakekeDesignId: "design-B" },
    ]);
    expect(json.ok).toBe(true);
    const [stock, sticker] = draftLines().map(attrs);
    expect(stock).not.toHaveProperty(ZAKEKE_DESIGN_ID_KEY);
    expect(sticker[ZAKEKE_DESIGN_ID_KEY]).toBe("design-B");
  });

  it("other families keep an optional design exactly as before", async () => {
    product("jar", "jar_100ml_tall", { title: "100ml Jar" });
    const { json } = await checkout([{ handle: "jar", quantity: 50, material: "Matte", finish: "Standard — 0X", labelSet: "Standard", zakekeDesignId: "design-J" }]);
    expect(json.ok).toBe(true);
    expect(attrs(draftLines()[0])[ZAKEKE_DESIGN_ID_KEY]).toBe("design-J");
  });

  it("the pure rule: only stock_bag_ types are stripped", () => {
    const design = resolveZakekeDesign("design-1");
    expect(design).not.toBeNull();
    expect(productTypeForbidsZakekeDesign("stock_bag_4x5")).toBe(true);
    expect(zakekeDesignForProductType("stock_bag_4x5", design)).toBeNull();
    expect(zakekeDesignForProductType(" stock_bag_4x5 ", design)).toBeNull();
    for (const type of ["sticker_bag_4x5", "jar_100ml_tall", "dtp_4x5", "sticker_regular", "sticker_die_cut", "", null, undefined]) {
      expect(productTypeForbidsZakekeDesign(type)).toBe(false);
      expect(zakekeDesignForProductType(type, design)).toBe(design);
      expect(zakekeDesignForProductType(type, null)).toBeNull();
    }
    // stripping can never trip the required-design gate on a Stock Bag
    expect(zakekeDesignGate("stock_bag_4x5", zakekeDesignForProductType("stock_bag_4x5", design))).toEqual({ ok: true });
  });
});

describe("2. a jar with no launch size is not offered as active", () => {
  it("jar_5oz_clear: inactive, no price, no legacy rule price breaks", async () => {
    product("jar-5oz", "jar_5oz_clear", { title: "5oz Clear Jar" });
    const { status, json } = await load("handle=jar-5oz");
    expect(status).toBe(200);
    expect(json).toEqual({
      ok: true,
      active: false,
      code: "NO_PRICING_AUTHORITY",
      message: "This product is not available for online pricing yet.",
    });
    // the legacy ConfiguratorPricingRule fixture prices never reach the storefront
    expect(JSON.stringify(json)).not.toContain("9.99");
    expect(JSON.stringify(json)).not.toContain("8.88");
  });

  it("checkout still refuses the same product (unchanged)", async () => {
    product("jar-5oz", "jar_5oz_clear", { title: "5oz Clear Jar" });
    const { json } = await checkout([{ handle: "jar-5oz", quantity: 64, material: "Matte", finish: "No Spot Gloss", labelSet: "Side + Lid" }]);
    expect(json).toMatchObject({ ok: false, code: "NO_PRICING_AUTHORITY" });
    expect(fetchCalls.length).toBe(0);
  });

  it("every launch jar type stays active and canonically priced", async () => {
    const launchTypes = Object.keys(JAR_LAUNCH_TYPE_SIZES);
    expect(launchTypes.sort()).toEqual([
      "jar_100ml_tall",
      "jar_100ml_wide",
      "jar_150ml",
      "jar_250ml",
      "jar_3oz_black_white",
      "jar_3oz_clear",
      "jar_4oz_black_white",
      "jar_4oz_clear",
      "jar_50ml",
    ]);
    for (const type of launchTypes) {
      product(`h-${type}`, type);
      // colour-variant jars resolve their type from the selected colour
      const color = type.endsWith("_black_white") ? "&jarColor=Black" : "";
      const { json } = await load(`handle=h-${type}${color}`);
      expect(json.active, type).toBe(true);
      expect(json.productType, type).toBe(type);
      expect(json.pricing.pricingSource, type).toBe("canonical_erp");
      expect(json.pricing.matched, type).toBe(true);
      expect(json.pricing.priceEach, type).toBeGreaterThan(0);
    }
  });

  it("bags are untouched: a Stock Bag is active at the approved minimum", async () => {
    const { json } = await load("handle=stock-bag");
    expect(json.active).toBe(true);
    expect(json.productFamily).toBe("Stock Bags");
    expect(json.product.minQuantity).toBe(50);
    expect(json.pricing).toMatchObject({ matched: true, pricingSource: "canonical_erp", priceEach: 2.7 });
  });
});

describe("3. Configurator Sync writes the approved Stock Bag MOQ", () => {
  const node = {
    id: "gid://shopify/Product/9001",
    title: "Ritz Vanilla Cupcake",
    handle: "ritz-vanilla-cupcake",
    productType: "Stock Bag",
    status: "ACTIVE",
    tags: ["configurator-pilot"],
    variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/1", sku: "RVC-1", title: "Default Title" } }] },
    collections: { edges: [{ node: { id: "gid://shopify/Collection/302046380097", handle: "stock-bags", title: "Stock Bags" } }] },
  };

  async function sync() {
    const form = new URLSearchParams({ intent: "sync", collectionInput: "302046380097", requiredTag: "configurator-pilot", shopifyProductType: "Stock Bag", limit: "50" });
    return (await syncAction({
      request: new Request("https://example.test/app/erp/configurator-sync", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    } as any)) as any;
  }

  it("the canonical constants agree on 50", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(STOREFRONT_BAG_MIN_QTY).toBe(STOCK_BAG_MOQ);
  });

  it("a newly synced stock bag row is created with minQuantity 50", async () => {
    h.state.shopifyNodes = [node];
    const result = await sync();
    expect(result.syncResult).toMatchObject({ created: 1, updated: 0 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].op).toBe("create");
    expect(h.writes[0].data).toMatchObject({ productType: "stock_bag_4x5", minQuantity: 50, defaultSides: "Double Sided", active: true, shopifyHandle: "ritz-vanilla-cupcake" });
  });

  it("re-syncing an existing row corrects a stale 64 to 50", async () => {
    h.state.shopifyNodes = [node];
    h.state.existing = { id: "cp_existing", productType: "stock_bag_4x5", minQuantity: 64 };
    const result = await sync();
    expect(result.syncResult).toMatchObject({ created: 0, updated: 1 });
    expect(h.writes[0].op).toBe("update");
    expect(h.writes[0].data.minQuantity).toBe(50);
  });

  it("the page shows the same value it writes", async () => {
    const data: any = await syncLoader({ request: new Request("https://example.test/app/erp/configurator-sync") } as any);
    expect(data.minQuantity).toBe(50);
    expect(data.productType).toBe("stock_bag_4x5");
  });
});
