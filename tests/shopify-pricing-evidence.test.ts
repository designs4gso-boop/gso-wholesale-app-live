// 15F.0K.4E — Shopify historical-order evidence pull: read-only scope,
// order/line eligibility, net-price-after-discounts, basket classification
// via line attributes, privacy (hashed keys, no PII serialized), combined
// ERP+Shopify thresholds, pagination caps, cache round-trip, blocked state.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SHOPIFY_ACCESS_BLOCKED_MESSAGE,
  SHOPIFY_EVIDENCE_MAX_PAGES,
  SHOPIFY_EVIDENCE_SETTING_KEY,
  SHOPIFY_ORDER_EVIDENCE_QUERY,
  buildShopifyEvidenceContext,
  evidenceKeysChanged,
  fetchShopifyOrderEvidence,
  isAccessDeniedError,
  loadShopifyEvidenceCache,
  normalizeShopifyOrderEvidence,
  saveShopifyEvidenceCache,
  type ShopifyEvidenceCache,
} from "../app/lib/shopify-pricing-evidence.server";
import {
  aggregateEvidence,
  classifyEvidenceBasket,
  type EvidenceRecord,
} from "../app/lib/pricing-intelligence.server";

// ---------- fixtures ----------

function makeLine(overrides: Record<string, any> = {}) {
  return {
    id: "gid://shopify/LineItem/1",
    title: "Custom Sticker Bag 4x5",
    variantTitle: "Matte / Front Only",
    sku: "BAG-4X5",
    quantity: 100,
    refundableQuantity: 100,
    isGiftCard: false,
    customAttributes: [
      { key: "Finish", value: "Matte + 3X Spot Gloss" },
      { key: "Sides", value: "Front Only" },
    ],
    product: { productType: "Sticker Bags" },
    originalUnitPriceSet: { shopMoney: { amount: "1.00" } },
    originalTotalSet: { shopMoney: { amount: "100.00" } },
    discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "10.00" } } }],
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, any> = {}, lines?: any[]) {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    test: false,
    cancelledAt: null,
    createdAt: "2026-05-10T10:00:00Z",
    processedAt: "2026-05-10T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currentSubtotalPriceSet: { shopMoney: { amount: "90.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00" } },
    // NOT an @example.com address — the shared 4D exclusion treats those as
    // test data (a rule this suite relies on staying strict).
    customer: { id: "gid://shopify/Customer/501" },
    email: "buyer@greenshopco.com",
    lineItems: { nodes: lines ?? [makeLine()] },
    ...overrides,
  };
}

// ---------- B. scope configuration (read-only, pinned) ----------

describe("Shopify scope configuration (B)", () => {
  const toml = readFileSync("shopify.app.toml", "utf8");

  it("read_all_orders is present and write_orders is deliberately absent", () => {
    const scopesLine = toml.split("\n").find((line) => line.trim().startsWith("scopes ="));
    expect(scopesLine).toBeTruthy();
    expect(scopesLine).toContain("read_all_orders");
    expect(scopesLine).toContain("read_orders");
    expect(scopesLine).not.toContain("write_orders");
  });

  it("order evidence query is READ-ONLY (a query, never a mutation)", () => {
    expect(SHOPIFY_ORDER_EVIDENCE_QUERY).toContain("query PricingEvidenceOrders");
    expect(SHOPIFY_ORDER_EVIDENCE_QUERY.toLowerCase()).not.toContain("mutation");
  });

  it("query requests no address or phone fields (privacy minimization)", () => {
    for (const banned of ["address", "phone", "shippingAddress", "billingAddress"]) {
      expect(SHOPIFY_ORDER_EVIDENCE_QUERY.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

// ---------- D. accepted-evidence rules (order level) ----------

describe("order eligibility (D)", () => {
  it("a normal PAID order with a classifiable line becomes accepted evidence", () => {
    const result = normalizeShopifyOrderEvidence([makeOrder()]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].state).toBe("accepted");
    expect(result.records[0].source).toBe("shopify_order");
    expect(result.excluded).toHaveLength(0);
  });

  it("PARTIALLY_REFUNDED orders stay eligible (line-level refunds handled separately)", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({ displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: { shopMoney: { amount: "10.00" } } }),
    ]);
    expect(result.records).toHaveLength(1);
  });

  it("test orders, canceled orders, and non-paid statuses are excluded with reasons", () => {
    const cases: Array<[Record<string, any>, RegExp]> = [
      [{ test: true }, /test order/i],
      [{ cancelledAt: "2026-05-11T00:00:00Z" }, /canceled/i],
      [{ displayFinancialStatus: "PENDING" }, /PENDING/],
      [{ displayFinancialStatus: "PARTIALLY_PAID" }, /PARTIALLY_PAID/],
      [{ displayFinancialStatus: "REFUNDED" }, /REFUNDED/],
      [{ displayFinancialStatus: "VOIDED" }, /VOIDED/],
    ];
    for (const [overrides, reason] of cases) {
      const result = normalizeShopifyOrderEvidence([makeOrder(overrides)]);
      expect(result.records, JSON.stringify(overrides)).toHaveLength(0);
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].reasons.join(" ")).toMatch(reason);
    }
  });

  it("fully refunded orders are excluded even when status is PARTIALLY_REFUNDED", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        currentSubtotalPriceSet: { shopMoney: { amount: "90.00" } },
        totalRefundedSet: { shopMoney: { amount: "90.00" } },
      }),
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.excluded[0].reasons.join(" ")).toMatch(/fully refunded/i);
  });

  it("evidence window (earliest/latest) reflects only eligible orders", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({ processedAt: "2026-03-01T00:00:00Z" }),
      makeOrder({ id: "gid://shopify/Order/1002", name: "#1002", processedAt: "2026-06-15T00:00:00Z" }),
      makeOrder({ id: "gid://shopify/Order/1003", name: "#1003", test: true, processedAt: "2020-01-01T00:00:00Z" }),
    ]);
    expect(result.earliest).toBe("2026-03-01");
    expect(result.latest).toBe("2026-06-15");
    expect(result.orderCount).toBe(3);
  });
});

// ---------- D. line-level rules ----------

describe("line eligibility (D)", () => {
  it("gift cards, refunded lines, and zero-net lines are excluded", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({}, [
        makeLine({ id: "l1", isGiftCard: true, title: "Gift card" }),
        makeLine({ id: "l2", quantity: 10, refundableQuantity: 8, title: "Partially refunded bags" }),
        makeLine({
          id: "l3",
          title: "Free sample bag",
          originalTotalSet: { shopMoney: { amount: "5.00" } },
          discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "5.00" } } }],
        }),
        makeLine({ id: "l4", title: "Real sticker bag order" }),
      ]),
    ]);
    expect(result.records).toHaveLength(1);
    const reasons = result.excluded.map((note) => note.reasons.join(" "));
    expect(reasons.some((reason) => /gift card/i.test(reason))).toBe(true);
    expect(reasons.some((reason) => /refunded line/i.test(reason))).toBe(true);
    expect(reasons.some((reason) => /free\/zero-net/i.test(reason))).toBe(true);
  });

  it("shared 4D test-data exclusion applies to Shopify lines too", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({ email: "owner+test@gmail.com" }),
      makeOrder({ id: "gid://shopify/Order/1005", name: "#1005" }, [makeLine({ title: "CMYK routing test" })]),
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.excluded).toHaveLength(2);
  });

  it("unclassifiable lines are kept out of every basket rather than guessed", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({}, [
        makeLine({
          title: "Mystery item",
          variantTitle: null,
          customAttributes: [],
          product: { productType: "" },
        }),
      ]),
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.excluded[0].reasons.join(" ")).toMatch(/unclassifiable/i);
  });
});

// ---------- E. net selling price after discounts ----------

describe("net selling price (E)", () => {
  it("net = gross line total minus ALL allocated discounts; net unit = net / quantity", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({}, [
        makeLine({
          quantity: 100,
          originalTotalSet: { shopMoney: { amount: "100.00" } },
          discountAllocations: [
            { allocatedAmountSet: { shopMoney: { amount: "10.00" } } },
            { allocatedAmountSet: { shopMoney: { amount: "5.00" } } },
          ],
        }),
      ]),
    ]);
    const record = result.records[0];
    expect(record.pricing?.grossLineTotal).toBe(100);
    expect(record.pricing?.allocatedDiscount).toBe(15);
    expect(record.pricing?.netLineTotal).toBe(85);
    expect(record.unitPrice).toBeCloseTo(0.85, 10);
  });

  it("undiscounted lines keep the full gross as net", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({}, [makeLine({ discountAllocations: [] })]),
    ]);
    expect(result.records[0].unitPrice).toBeCloseTo(1.0, 10);
  });

  it("missing line totals or discount amounts mark the line pricingIncomplete (never a median input)", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder({}, [
        makeLine({ id: "l1", originalTotalSet: null }),
        makeLine({ id: "l2", discountAllocations: [{ allocatedAmountSet: null }] }),
      ]),
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.incomplete).toHaveLength(2);
    expect(result.incomplete.every((note) => note.reasons.join(" ").includes("pricingIncomplete"))).toBe(true);
  });
});

// ---------- F. classification via line attributes ----------

describe("classification from Shopify attributes (F)", () => {
  it("3X and 4X spot gloss land in DIFFERENT baskets (4X never treated as 3X)", () => {
    const threeX = normalizeShopifyOrderEvidence([makeOrder()]).records[0];
    const fourX = normalizeShopifyOrderEvidence([
      makeOrder({}, [makeLine({ customAttributes: [{ key: "Finish", value: "Matte + 4X Spot Gloss" }] })]),
    ]).records[0];
    expect(threeX.basket.glossStage).toBe("3");
    expect(fourX.basket.glossStage).toBe("4");
    expect(threeX.key).not.toBe(fourX.key);
  });

  it("single- and double-sided lines never share a basket", () => {
    const single = normalizeShopifyOrderEvidence([makeOrder()]).records[0];
    const double = normalizeShopifyOrderEvidence([
      makeOrder({}, [
        makeLine({
          variantTitle: "Matte / Front and Back",
          customAttributes: [{ key: "Sides", value: "Front and Back" }],
        }),
      ]),
    ]).records[0];
    expect(single.basket.sides).toBe("1");
    expect(double.basket.sides).toBe("2");
    expect(single.key).not.toBe(double.key);
  });

  it("structured customAttributes beat the bare title for classification", () => {
    const basket = classifyEvidenceBasket({
      productName: "Custom order",
      variantTitle: null,
      selectedFinish: null,
      costSnapshot: null,
      attributeText: "Product: 4x5 bag | Finish: Holographic + 4X Spot Gloss | Sides: Front and Back",
      quantity: 500,
    });
    expect(basket.family).toBe("sticker-bags");
    expect(basket.materialClass).toBe("holographic");
    expect(basket.glossStage).toBe("4");
    expect(basket.sides).toBe("2");
  });
});

// ---------- H. privacy ----------

describe("privacy (H)", () => {
  it("records carry ONLY a short hashed customer key — never the raw id or email", () => {
    const result = normalizeShopifyOrderEvidence([makeOrder()]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("buyer@greenshopco.com");
    expect(serialized).not.toContain("gid://shopify/Customer/501");
    expect(result.records[0].customerKey).toMatch(/^[0-9a-f]{12}$/);
  });

  it("guest orders (no customer, no email) still get a stable hashed key", () => {
    const result = normalizeShopifyOrderEvidence([makeOrder({ customer: null, email: null })]);
    expect(result.records[0].customerKey).toMatch(/^[0-9a-f]{12}$/);
  });

  it("same customer id hashes identically across orders (repeat-buyer counting works)", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder(),
      makeOrder({ id: "gid://shopify/Order/1010", name: "#1010", processedAt: "2026-06-01T00:00:00Z" }),
    ]);
    expect(result.records[0].customerKey).toBe(result.records[1].customerKey);
  });
});

// ---------- G. combined ERP + Shopify aggregation ----------

describe("combined thresholds (G)", () => {
  function shopifyRecords(count: number): EvidenceRecord[] {
    return Array.from({ length: count }, (_, index) =>
      normalizeShopifyOrderEvidence([
        makeOrder({
          id: `gid://shopify/Order/${2000 + index}`,
          name: `#${2000 + index}`,
          customer: { id: `gid://shopify/Customer/${900 + index}` },
          processedAt: `2026-0${(index % 3) + 3}-15T00:00:00Z`,
        }),
      ]).records[0],
    );
  }

  it("sources stay distinguishable while combining toward the thresholds", () => {
    const erp: EvidenceRecord = {
      ...shopifyRecords(1)[0],
      source: "erp_quote",
      customerKey: "aaaaaaaaaaaa",
      evidenceAt: new Date("2026-07-01T00:00:00Z"),
    };
    const combined = [erp, ...shopifyRecords(4)];
    const aggregates = aggregateEvidence(combined);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].accepted).toBe(5);
    expect(aggregates[0].sourceCounts.erp_quote).toBe(1);
    expect(aggregates[0].sourceCounts.shopify_order).toBe(4);
    expect(aggregates[0].confidence.eligible).toBe(true);
  });

  it("statistics stay withheld when combined evidence misses ANY threshold", () => {
    const aggregates = aggregateEvidence(shopifyRecords(4)); // 4 accepted < 5 minimum
    expect(aggregates[0].confidence.eligible).toBe(false);
    expect(aggregates[0].acceptedMedian).toBeNull();
  });
});

// ---------- C. pagination ----------

describe("paginated fetch (C)", () => {
  function fakeAdmin(pages: any[][], options: { failWith?: string } = {}) {
    let call = 0;
    const cursors: Array<string | null> = [];
    return {
      cursors,
      graphql: async (_query: string, { variables }: any) => {
        cursors.push(variables.cursor);
        if (options.failWith) return { json: async () => ({ errors: [{ message: options.failWith }] }) };
        const index = call++;
        const nodes = pages[index] || [];
        return {
          json: async () => ({
            data: {
              orders: {
                pageInfo: { hasNextPage: index < pages.length - 1, endCursor: `cursor-${index}` },
                nodes,
              },
            },
          }),
        };
      },
    };
  }

  it("follows cursors across pages and stops when hasNextPage is false", async () => {
    const admin = fakeAdmin([[makeOrder()], [makeOrder({ id: "gid://shopify/Order/1002", name: "#1002" })]]);
    const result = await fetchShopifyOrderEvidence(admin);
    expect(result.orders).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(admin.cursors).toEqual([null, "cursor-0"]);
  });

  it("stops at the defensive page cap and reports truncation", async () => {
    const pages = Array.from({ length: SHOPIFY_EVIDENCE_MAX_PAGES + 5 }, () => [makeOrder()]);
    const result = await fetchShopifyOrderEvidence(fakeAdmin(pages));
    expect(result.pagesFetched).toBe(SHOPIFY_EVIDENCE_MAX_PAGES);
    expect(result.truncated).toBe(true);
  });

  it("GraphQL errors throw (caller caches the failure state; page never half-succeeds)", async () => {
    await expect(fetchShopifyOrderEvidence(fakeAdmin([], { failWith: "Access denied for orders field" }))).rejects.toThrow(/Access denied/);
  });
});

// ---------- J. access blocked state ----------

describe("access blocked state (J)", () => {
  it("exact required blocked message is pinned", () => {
    expect(SHOPIFY_ACCESS_BLOCKED_MESSAGE).toBe(
      "Historical Shopify order access is not yet authorized. Reauthorize the app with read_all_orders to include orders older than Shopify's standard recent-order window.",
    );
  });

  it("recognizes access-denial errors without swallowing unrelated failures", () => {
    expect(isAccessDeniedError("Access denied for field orders")).toBe(true);
    expect(isAccessDeniedError("This app is not approved to access the Order object")).toBe(true);
    expect(isAccessDeniedError("requires read_all_orders scope")).toBe(true);
    expect(isAccessDeniedError("HTTP 403 Forbidden")).toBe(true);
    expect(isAccessDeniedError("network timeout")).toBe(false);
    expect(isAccessDeniedError("")).toBe(false);
  });
});

// ---------- K. cache round-trip ----------

describe("evidence cache (K)", () => {
  function fakeDb() {
    const rows = new Map<string, any>();
    return {
      rows,
      erpAdminSetting: {
        upsert: async ({ where, update, create }: any) => {
          const key = `${where.shop_key.shop}:${where.shop_key.key}`;
          rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : create);
        },
        findUnique: async ({ where }: any) => rows.get(`${where.shop_key.shop}:${where.shop_key.key}`) ?? null,
      },
    };
  }

  function cacheFixture(overrides: Partial<ShopifyEvidenceCache> = {}): ShopifyEvidenceCache {
    const normalized = normalizeShopifyOrderEvidence([makeOrder()]);
    return {
      capturedAt: "2026-07-26T12:00:00.000Z",
      ok: true,
      error: null,
      accessBlocked: false,
      orderCount: 1,
      pagesFetched: 1,
      truncated: false,
      earliest: normalized.earliest,
      latest: normalized.latest,
      records: normalized.records.map((record) => ({ ...record, evidenceAt: record.evidenceAt.toISOString() })),
      excluded: normalized.excluded,
      incomplete: normalized.incomplete,
      ...overrides,
    };
  }

  it("save/load round-trips and rehydrates evidenceAt as a Date", async () => {
    const db = fakeDb();
    await saveShopifyEvidenceCache(db, "shop1.myshopify.com", cacheFixture());
    const loaded = await loadShopifyEvidenceCache(db, "shop1.myshopify.com");
    expect(loaded.cache?.ok).toBe(true);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].evidenceAt).toBeInstanceOf(Date);
    expect(loaded.records[0].source).toBe("shopify_order");
    const stored = db.rows.get(`shop1.myshopify.com:${SHOPIFY_EVIDENCE_SETTING_KEY}`);
    expect(stored.valueType).toBe("json");
    expect(stored.value).not.toContain("buyer@example.com");
  });

  it("a corrupt cache never breaks the page (returns empty, not a throw)", async () => {
    const db = fakeDb();
    db.rows.set(`shop1.myshopify.com:${SHOPIFY_EVIDENCE_SETTING_KEY}`, { value: "{not json" });
    const loaded = await loadShopifyEvidenceCache(db, "shop1.myshopify.com");
    expect(loaded.cache).toBeNull();
    expect(loaded.records).toHaveLength(0);
  });

  it("a missing cache reads as not-connected (empty records)", async () => {
    const loaded = await loadShopifyEvidenceCache(fakeDb(), "shop1.myshopify.com");
    expect(loaded.cache).toBeNull();
    expect(loaded.records).toHaveLength(0);
  });

  it("failure states persist accessBlocked so the page can show the exact message", async () => {
    const db = fakeDb();
    await saveShopifyEvidenceCache(
      db,
      "shop1.myshopify.com",
      cacheFixture({ ok: false, accessBlocked: true, error: "Access denied", records: [], excluded: [], incomplete: [] }),
    );
    const loaded = await loadShopifyEvidenceCache(db, "shop1.myshopify.com");
    expect(loaded.cache?.accessBlocked).toBe(true);
    expect(loaded.records).toHaveLength(0);
  });
});

// ---------- 15F.0K.4G: refs, test orders, dedup context, reclassification ----------

describe("evidence refs + test-order capture (4G)", () => {
  it("eligible records carry Shopify OBJECT id digit-tails for exact dedup joins", () => {
    const result = normalizeShopifyOrderEvidence([makeOrder()]);
    expect(result.records[0].refs).toEqual({ orderId: "1001", lineItemId: "1" });
  });

  it("test orders are listed with privacy-safe id + name; real orders are not", () => {
    const result = normalizeShopifyOrderEvidence([
      makeOrder(),
      makeOrder({ id: "gid://shopify/Order/9999", name: "#1099", test: true }),
    ]);
    expect(result.testOrders).toEqual([{ id: "9999", name: "#1099" }]);
    expect(JSON.stringify(result.testOrders)).not.toContain("1001");
  });

  it("buildShopifyEvidenceContext exposes id sets, key lookup, and test orders", () => {
    const normalized = normalizeShopifyOrderEvidence([
      makeOrder(),
      makeOrder({ id: "gid://shopify/Order/9999", name: "#1099", test: true }),
    ]);
    const cache = { testOrders: normalized.testOrders } as ShopifyEvidenceCache;
    const context = buildShopifyEvidenceContext(cache, normalized.records);
    expect(context.lineItemIds.has("1")).toBe(true);
    expect(context.orderIds.has("1001")).toBe(true);
    expect(context.keysByLineItemId.get("1")).toBe(normalized.records[0].key);
    expect(context.testOrders).toEqual([{ id: "9999", name: "#1099" }]);
  });

  it("a legacy pre-4G cache (no testOrders field) builds an empty-test context without crashing", () => {
    const legacy = { records: [] } as unknown as ShopifyEvidenceCache;
    const context = buildShopifyEvidenceContext(legacy, []);
    expect(context.testOrders).toEqual([]);
    expect(context.lineItemIds.size).toBe(0);
    expect(buildShopifyEvidenceContext(null, []).testOrders).toEqual([]);
  });

  it("cache round-trips refs and testOrders", async () => {
    const rows = new Map<string, any>();
    const db = {
      erpAdminSetting: {
        upsert: async ({ where, update, create }: any) => {
          const key = `${where.shop_key.shop}:${where.shop_key.key}`;
          rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : create);
        },
        findUnique: async ({ where }: any) => rows.get(`${where.shop_key.shop}:${where.shop_key.key}`) ?? null,
      },
    };
    const normalized = normalizeShopifyOrderEvidence([makeOrder(), makeOrder({ id: "gid://shopify/Order/9999", name: "#1099", test: true })]);
    await saveShopifyEvidenceCache(db, "s.myshopify.com", {
      capturedAt: "2026-07-27T00:00:00.000Z", ok: true, error: null, accessBlocked: false,
      orderCount: 2, pagesFetched: 1, truncated: false, earliest: normalized.earliest, latest: normalized.latest,
      records: normalized.records.map((record) => ({ ...record, evidenceAt: record.evidenceAt.toISOString() })),
      excluded: normalized.excluded, incomplete: normalized.incomplete, testOrders: normalized.testOrders,
    });
    const loaded = await loadShopifyEvidenceCache(db, "s.myshopify.com");
    expect(loaded.records[0].refs).toEqual({ orderId: "1001", lineItemId: "1" });
    expect(loaded.cache?.testOrders).toEqual([{ id: "9999", name: "#1099" }]);
  });
});

describe("reclassification detection (4G-G)", () => {
  it("same multiset of keys (any order) => unchanged; different keys or counts => changed", () => {
    expect(evidenceKeysChanged(["a", "b"], ["b", "a"])).toBe(false);
    expect(evidenceKeysChanged(["a", "b"], ["a", "c"])).toBe(true);
    expect(evidenceKeysChanged(["a"], ["a", "a"])).toBe(true);
    expect(evidenceKeysChanged([], [])).toBe(false);
  });

  it("page shows the exact reclassification notice and passes dedup context into gathering (source pins)", () => {
    const page = readFileSync("app/routes/app.erp.pricing-intelligence.tsx", "utf8");
    expect(page).toContain("Historical evidence was reclassified using updated deterministic rules.");
    // 15F.0K.4H: the context is built from the cutoff-filtered records so
    // pre-launch Shopify lines can no longer anchor dedup — their job twins
    // fall through to the cutoff exclusion instead.
    expect(page).toContain("buildShopifyEvidenceContext(shopify.cache, keptShopifyRecords)");
    expect(page).toContain("testOrders: normalized.testOrders");
    expect(page).toContain("Staff review");
  });
});

// ---------- 15F.0K.4H: live-sales cutoff on the Shopify source ----------

describe("live-sales cutoff (4H) — Shopify orders", () => {
  const LIVE_FROM = new Date("2026-07-27T12:00:00Z"); // fixture order is 2026-05-10

  it("orders before the cutoff are excluded with the exact reason and leave the evidence window empty", () => {
    const result = normalizeShopifyOrderEvidence([makeOrder()], { liveFrom: LIVE_FROM });
    expect(result.records).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].reasons).toEqual(["Pre-launch test evidence — before owner-approved live-sales start date"]);
    expect(result.earliest).toBeNull();
    expect(result.latest).toBeNull();
  });

  it("orders exactly at and after the cutoff stay eligible under all existing rules", () => {
    const atCutoff = normalizeShopifyOrderEvidence([makeOrder({ processedAt: "2026-07-27T12:00:00Z" })], { liveFrom: LIVE_FROM });
    expect(atCutoff.records).toHaveLength(1);
    const after = normalizeShopifyOrderEvidence([makeOrder({ processedAt: "2026-08-01T00:00:00Z" })], { liveFrom: LIVE_FROM });
    expect(after.records).toHaveLength(1);
    expect(after.records[0].state).toBe("accepted");
  });

  it("processedAt governs; createdAt is only the fallback", () => {
    const processedAfter = normalizeShopifyOrderEvidence(
      [makeOrder({ createdAt: "2026-05-01T00:00:00Z", processedAt: "2026-08-01T00:00:00Z" })],
      { liveFrom: LIVE_FROM },
    );
    expect(processedAfter.records).toHaveLength(1);
    const fallbackBefore = normalizeShopifyOrderEvidence(
      [makeOrder({ processedAt: null, createdAt: "2026-05-01T00:00:00Z" })],
      { liveFrom: LIVE_FROM },
    );
    expect(fallbackBefore.records).toHaveLength(0);
  });

  it("the cutoff does not replace normal detection: test orders keep their reason and refund/gift rules still run after the date", () => {
    const futureTest = normalizeShopifyOrderEvidence(
      [makeOrder({ test: true, processedAt: "2026-08-01T00:00:00Z", id: "gid://shopify/Order/8888", name: "#2001" })],
      { liveFrom: LIVE_FROM },
    );
    expect(futureTest.records).toHaveLength(0);
    expect(futureTest.excluded[0].reasons.join(" ")).toContain("Shopify test order");
    expect(futureTest.testOrders).toEqual([{ id: "8888", name: "#2001" }]);
    const futureRefunded = normalizeShopifyOrderEvidence(
      [makeOrder({ processedAt: "2026-08-01T00:00:00Z", displayFinancialStatus: "REFUNDED" })],
      { liveFrom: LIVE_FROM },
    );
    expect(futureRefunded.records).toHaveLength(0);
    expect(futureRefunded.excluded[0].reasons.join(" ")).toContain("REFUNDED");
  });

  it("pre-cutoff TEST orders still land in testOrders (job propagation keeps working)", () => {
    const result = normalizeShopifyOrderEvidence(
      [makeOrder({ test: true, id: "gid://shopify/Order/7777", name: "#1007" })],
      { liveFrom: LIVE_FROM },
    );
    expect(result.testOrders).toEqual([{ id: "7777", name: "#1007" }]);
  });

  it("no cutoff (null / omitted) keeps pre-4H behavior", () => {
    expect(normalizeShopifyOrderEvidence([makeOrder()], { liveFrom: null }).records).toHaveLength(1);
    expect(normalizeShopifyOrderEvidence([makeOrder()]).records).toHaveLength(1);
  });

  it("page pins: live-from notice, pre-launch card, re-evaluation message, cutoff wiring (source pins)", () => {
    const page = readFileSync("app/routes/app.erp.pricing-intelligence.tsx", "utf8");
    expect(page).toContain("Live sales evidence begins:");
    expect(page).toContain("Pre-launch test evidence");
    expect(page).toContain("Historical evidence was re-evaluated using the owner-approved live-sales start date.");
    expect(page).toContain("loadPricingEvidenceLiveFrom");
    expect(page).toContain("normalizeShopifyOrderEvidence(orders, { liveFrom: liveFrom?.date ?? null })");
    expect(page).toContain("isPreLaunchEvidence(record.evidenceAt, liveFrom?.date ?? null)"); // stale-cache defense
    const settings = readFileSync("app/routes/app.erp.pricing-settings.tsx", "utf8");
    expect(settings).toContain("READ-ONLY here");
    expect(settings).toContain("tools/apply-15f0k4h-live-from.mjs");
  });
});

// ---------- structure pins (page wiring stays read-only) ----------

describe("pricing-intelligence page wiring (structure pins)", () => {
  const page = readFileSync("app/routes/app.erp.pricing-intelligence.tsx", "utf8");

  it("page refresh action is staff-triggered, cached, and uses the read-only fetch path", () => {
    expect(page).toContain("refreshShopifyEvidence");
    expect(page).toContain("fetchShopifyOrderEvidence");
    expect(page).toContain("normalizeShopifyOrderEvidence");
    expect(page).toContain("saveShopifyEvidenceCache");
    expect(page).toContain("loadShopifyEvidenceCache");
    expect(page).toContain("SHOPIFY_ACCESS_BLOCKED_MESSAGE");
  });

  it("page combines local + Shopify records into ONE aggregation (thresholds see both)", () => {
    // 15F.0K.4H: the combined list uses the cutoff-filtered Shopify records
    // (keptShopifyRecords) — same one-aggregation invariant, plus the
    // guarantee that stale pre-4H caches cannot keep pre-launch rows eligible.
    expect(page).toContain("[...local.records, ...keptShopifyRecords]");
    expect(page).toContain("aggregateEvidence(combined)");
  });

  it("page performs no Shopify mutations", () => {
    expect(page.toLowerCase()).not.toContain("mutation");
  });
});
