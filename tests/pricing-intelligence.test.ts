// 15F.0K.4D — pricing-intelligence evidence capture: quote outcomes,
// conservative test-data exclusion, basket classification (never mixing
// finishes/sides/forms), threshold-gated statistics, and privacy.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACCEPTED_EVIDENCE_STATUSES,
  DEDUP_REASON,
  EVIDENCE_MIN_ACCEPTED,
  MSG_INSUFFICIENT_CUSTOMERS,
  MSG_INSUFFICIENT_MONTHS,
  MSG_NOT_ENOUGH_HISTORY,
  QUOTE_OUTCOME_STATUSES,
  TEST_ORDER_REASON,
  aggregateEvidence,
  basketKey,
  classifyEvidenceBasket,
  customerKey,
  evidenceConfidence,
  evidenceExclusion,
  gatherPricingEvidence,
  qtyBandFor,
  resolveQuoteOutcomeChange,
  shopifyRefsFromJobItem,
  type EvidenceRecord,
  type ShopifyEvidenceContext,
} from "../app/lib/pricing-intelligence.server";

describe("quote outcomes (A)", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  it("won records outcomeAt (reason optional)", () => {
    const result = resolveQuoteOutcomeChange({ nextStatus: "won", now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcomeAt).toEqual(NOW);
      expect(result.outcomeReason).toBeNull();
    }
  });

  it("lost and canceled REQUIRE a reason; expired works with optional reason", () => {
    for (const status of ["lost", "canceled"]) {
      const missing = resolveQuoteOutcomeChange({ nextStatus: status, reason: "" });
      expect(missing.ok, status).toBe(false);
      const withReason = resolveQuoteOutcomeChange({ nextStatus: status, reason: "priced too high", now: NOW });
      expect(withReason.ok).toBe(true);
      if (withReason.ok) expect(withReason.outcomeReason).toBe("priced too high");
    }
    const expired = resolveQuoteOutcomeChange({ nextStatus: "expired", now: NOW });
    expect(expired.ok).toBe(true);
    if (expired.ok) expect(expired.outcomeAt).toEqual(NOW);
  });

  it("returning to draft or sent clears outcome fields; existing ladder statuses leave them untouched", () => {
    for (const status of ["draft", "sent"]) {
      const result = resolveQuoteOutcomeChange({ nextStatus: status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.clearsOutcome).toBe(true);
    }
    for (const status of ["approved", "deposit_paid", "production", "completed"]) {
      const result = resolveQuoteOutcomeChange({ nextStatus: status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.clearsOutcome).toBe(false);
    }
  });

  it("marking won never creates a production job and quote conversion stays gated to paid statuses (route pins)", () => {
    const src = readFileSync("app/routes/app.quotes.tsx", "utf8");
    expect(src).toContain("resolveQuoteOutcomeChange({ nextStatus, reason: payload.reason })");
    // the outcome branch writes ONLY quote.updateMany — no production-job call
    const statusBranch = src.slice(src.indexOf('payload.intent === "status"'), src.indexOf('payload.intent === "approveCreateOrder"'));
    expect(statusBranch.includes("createProductionJob")).toBe(false);
    expect(statusBranch.includes("sendInvoice")).toBe(false);
    // won respects the low-margin acceptance gate like sent/approved
    expect(src).toContain('nextStatus === "sent" || nextStatus === "approved" || nextStatus === "won"');
    // production creation remains gated on the paid ladder, not on won
    expect(src).toContain('"Production: quote must be approved and paid"');
  });

  it("outcome vocabulary and accepted-evidence statuses are pinned", () => {
    expect([...QUOTE_OUTCOME_STATUSES]).toEqual(["won", "lost", "canceled", "expired"]);
    expect(ACCEPTED_EVIDENCE_STATUSES).toContain("won");
    expect(ACCEPTED_EVIDENCE_STATUSES).toContain("paid");
    expect(ACCEPTED_EVIDENCE_STATUSES).not.toContain("lost");
  });
});

describe("test-data exclusion (C) — conservative shared helper", () => {
  it("known test_shopify_order replays and test source ids are excluded with reasons", () => {
    const result = evidenceExclusion({ sourceId: "test_shopify_order_9", productName: "Ritz Vanilla Cupcake", quantity: 64, unitPrice: 2.8 });
    expect(result.excluded).toBe(true);
    expect(result.reasons.join(" ")).toContain("test source id");
  });

  it("CMYK Routing Test and known audit artifacts are excluded", () => {
    expect(evidenceExclusion({ productName: "CMYK Routing Test", quantity: 1, unitPrice: 2 }).excluded).toBe(true);
    expect(evidenceExclusion({ productName: "NoProduction Test Stickert selected / unknown", quantity: 100, unitPrice: 0.31 }).excluded).toBe(true);
    expect(evidenceExclusion({ productName: "PRINT INTAKE — GSO PIPELINE TEST 3_1X", quantity: 0, unitPrice: 0 }).excluded).toBe(true);
  });

  it("quantity-zero and zero-price records are excluded", () => {
    const zeroQty = evidenceExclusion({ productName: "4x5 Bag", quantity: 0, unitPrice: 1.2 });
    expect(zeroQty.excluded).toBe(true);
    expect(zeroQty.reasons.join(" ")).toContain("non-positive quantity");
    expect(evidenceExclusion({ productName: "4x5 Bag", quantity: 100, unitPrice: 0 }).excluded).toBe(true);
  });

  it("legitimate records are retained — common words never exclude", () => {
    for (const name of ["Apples Banana Pebbles", "4X5 Sticker Bag", "Contest Winner Stickers", "Greatest Hits Jar Set", "Taste Test Kit"]) {
      const result = evidenceExclusion({ productName: name, quantity: 250, unitPrice: 1.6, sourceId: "cmoz123", email: "orders@realshop.com" });
      expect(result.excluded, name).toBe(false);
      expect(result.reasons).toEqual([]);
    }
  });

  it("explicit markers exclude: ALL-CAPS TEST token, [TEST DATA], test emails", () => {
    expect(evidenceExclusion({ productName: "GSO PIPELINE TEST FILE", quantity: 5, unitPrice: 1 }).excluded).toBe(true);
    expect(evidenceExclusion({ productName: "Bag", notes: "[TEST DATA] do not count", quantity: 5, unitPrice: 1 }).excluded).toBe(true);
    expect(evidenceExclusion({ productName: "Bag", email: "test@gso.com", quantity: 5, unitPrice: 1 }).excluded).toBe(true);
    expect(evidenceExclusion({ productName: "Bag", email: "attestor@client.com", quantity: 5, unitPrice: 1 }).excluded).toBe(false);
  });
});

describe("classification (E) — conservative, never mixing", () => {
  it("4X is never treated as 3X; gloss stages classify from variant vocabulary", () => {
    const fourX = classifyEvidenceBasket({ productName: "Ritz", variantTitle: "Matte / 4X Spot Gloss / Blue", quantity: 64 });
    const threeX = classifyEvidenceBasket({ productName: "Ritz", variantTitle: "Matte / 3X Spot Gloss / Blue", quantity: 64 });
    expect(fourX.glossStage).toBe("4");
    expect(threeX.glossStage).toBe("3");
    expect(basketKey(fourX)).not.toBe(basketKey(threeX));
    expect(classifyEvidenceBasket({ productName: "x", variantTitle: "Matte / No Spot Gloss", quantity: 10 }).glossStage).toBe("0");
    expect(classifyEvidenceBasket({ productName: "x", selectedFinish: "GLOSS-1X", quantity: 10 }).glossStage).toBe("1");
  });

  it("sides, material class, and finished-vs-labels separate; unknown stays its own segment", () => {
    const double = classifyEvidenceBasket({ productName: "4X5 Sticker Bag", variantTitle: "Double / Matte", quantity: 250 });
    const single = classifyEvidenceBasket({ productName: "4X5 Sticker Bag", variantTitle: "Front Only / Matte", quantity: 250 });
    expect(double.sides).toBe("2");
    expect(single.sides).toBe("1");
    expect(basketKey(double)).not.toBe(basketKey(single));
    const holo = classifyEvidenceBasket({ productName: "Bag", variantTitle: "Holographic / 4X Spot Gloss", quantity: 64 });
    expect(holo.materialClass).toBe("holographic");
    const unknown = classifyEvidenceBasket({ productName: "Mystery Item", quantity: 50 });
    expect(unknown.family).toBe("unknown");
    expect(unknown.materialClass).toBe("unknown");
    expect(basketKey(unknown)).toContain("unknown");
    const jarSet = classifyEvidenceBasket({ productName: "100ML Tall Miron Jars", variantTitle: "Matte / No Spot Gloss / Side + Lid", quantity: 128 });
    expect(jarSet.family).toBe("premium-jars");
    expect(jarSet.productForm).toBe("finished_jar_set");
  });

  it("snapshot selections win over text: faces/white/gloss come from the stored structure", () => {
    const snapshot = JSON.stringify({ productBreakdown: { canonicalFamily: "sticker-bags", selections: { whiteLayers: 0, glossLayers: 3, faces: 2 } } });
    const basket = classifyEvidenceBasket({ productName: "Custom Bag", costSnapshot: snapshot, quantity: 500 });
    expect(basket.family).toBe("sticker-bags");
    expect(basket.glossStage).toBe("3");
    expect(basket.sides).toBe("2");
    expect(basket.whiteLayers).toBe("0");
    expect(basket.qtyBand).toBe("500-999");
  });

  it("quantity bands split evidence tiers", () => {
    expect(qtyBandFor(64)).toBe("64-127");
    expect(qtyBandFor(500)).toBe("500-999");
    expect(qtyBandFor(5000)).toBe("5000+");
  });
});

describe("thresholds (D4) — statistics are withheld from tiny samples", () => {
  const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
    source: "erp_quote",
    basket: classifyEvidenceBasket({ productName: "4x5 Bag", variantTitle: "Double / Matte", quantity: 500 }),
    key: "basket-a",
    quantity: 500,
    unitPrice: 1.2,
    state: "accepted",
    customerKey: "c1",
    evidenceAt: new Date("2026-06-15T00:00:00Z"),
    exactSnapshot: true,
    ...over,
  });

  it("4 accepted items: no median (Not enough verified sales history yet)", () => {
    const rows = [1, 2, 3, 4].map((index) => record({ customerKey: `c${index}`, evidenceAt: new Date(2026, index, 1) }));
    const [aggregate] = aggregateEvidence(rows);
    expect(aggregate.confidence.eligible).toBe(false);
    expect(aggregate.confidence.message).toContain(MSG_NOT_ENOUGH_HISTORY);
    expect(aggregate.acceptedMedian).toBeNull();
  });

  it("5 accepted from only 2 customers: no median (Insufficient customer diversity)", () => {
    const rows = [1, 2, 3, 4, 5].map((index) => record({ customerKey: index % 2 ? "c1" : "c2", evidenceAt: new Date(2026, index, 1) }));
    const [aggregate] = aggregateEvidence(rows);
    expect(aggregate.confidence.eligible).toBe(false);
    expect(aggregate.confidence.message).toContain(MSG_INSUFFICIENT_CUSTOMERS);
    expect(aggregate.acceptedMedian).toBeNull();
  });

  it("5 accepted across 3 customers but 1 month: no median (Insufficient time coverage)", () => {
    const rows = [1, 2, 3, 4, 5].map((index) => record({ customerKey: `c${(index % 3) + 1}`, evidenceAt: new Date("2026-06-10T00:00:00Z") }));
    const [aggregate] = aggregateEvidence(rows);
    expect(aggregate.confidence.eligible).toBe(false);
    expect(aggregate.confidence.message).toContain(MSG_INSUFFICIENT_MONTHS);
    expect(aggregate.acceptedMedian).toBeNull();
  });

  it("5 accepted, 3 customers, 2 months: display-eligible — and eligibility creates NO market target", () => {
    const rows = [1, 2, 3, 4, 5].map((index) => record({
      customerKey: `c${(index % 3) + 1}`,
      unitPrice: 1 + index * 0.1,
      evidenceAt: new Date(index <= 2 ? "2026-05-10T00:00:00Z" : "2026-06-10T00:00:00Z"),
    }));
    const [aggregate] = aggregateEvidence(rows);
    expect(aggregate.confidence.eligible).toBe(true);
    expect(aggregate.acceptedMedian).toBeCloseTo(1.3, 10);
    expect(aggregate.acceptedLow).toBeCloseTo(1.1, 10);
    expect(aggregate.acceptedHigh).toBeCloseTo(1.5, 10);
    // eligibility is advisory data only — no target/candidate fields exist
    expect(Object.keys(aggregate).join(" ")).not.toContain("target");
    expect(evidenceConfidence({ accepted: 99, distinctCustomers: 9, distinctMonths: 9 }).message).toContain("advisory only");
    expect(EVIDENCE_MIN_ACCEPTED).toBe(5);
  });
});

describe("privacy (D6)", () => {
  it("customerKey hashes identities; raw email/name never appear in gathered records", async () => {
    expect(customerKey("Jane@Client.com", null)).toHaveLength(12);
    expect(customerKey("Jane@Client.com", null)).toBe(customerKey("jane@client.com", "Someone"));
    const fakeDb = {
      quote: { findMany: async () => [{ id: "cmq1", status: "won", email: "secret@client.com", customerName: "Secret Person", createdAt: new Date(), updatedAt: new Date(), outcomeAt: new Date(), notes: null, items: [{ productName: "4x5 Bag", variant: "Double / Matte", sku: null, quantity: 500, unitPrice: 1.2, selectedFinish: null, costSnapshot: null }] }] },
      productionJobItem: { findMany: async () => [] },
    };
    const evidence = await gatherPricingEvidence(fakeDb, "shop");
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("secret@client.com");
    expect(serialized).not.toContain("Secret Person");
    expect(evidence.totals.distinctCustomers).toBe(1);
    expect(evidence.records[0].state).toBe("accepted");
  });

  it("the page renders counts only — no email/name fields are returned by the loader shape (source pin)", () => {
    const src = readFileSync("app/routes/app.erp.pricing-intelligence.tsx", "utf8");
    expect(src).toContain("distinctCustomers");
    expect(src.includes("customerName")).toBe(false);
    expect(src.includes(".email")).toBe(false);
    // 15F.0K.4E replaced the "not yet connected" notice with the live
    // Shopify section — same invariant, new mechanism: the page renders the
    // Shopify source read-only and surfaces the blocked state, still with
    // zero identity fields.
    expect(src).toContain("Shopify historical-order evidence (15F.0K.4E — read-only)");
    expect(src).toContain("SHOPIFY_ACCESS_BLOCKED_MESSAGE");
  });
});

// ---------- 15F.0K.4G — classification corrections + dedup ----------

describe("white-ink classification (4G-A) — color white is NOT white ink", () => {
  it("bag/jar COLOR vocabulary never implies white ink (the 4F false positives)", () => {
    const cases = [
      { productName: "Custom Sticker Bag (4x5)", variantTitle: "Matte Vinyl / White / Front Only" },
      { productName: "Custom Sticker Bag (4x5)", variantTitle: "Holographic / White / Front Only" },
      { productName: "3oz Black/White Jar - Black / Matte / No Spot Gloss / Side + Lid" },
      { productName: "Bag", attributeText: "Bag Color: White | Material: Matte" },
      { productName: "Jar thing", attributeText: "Jar Color: White | Material: Matte" },
    ];
    for (const input of cases) {
      const basket = classifyEvidenceBasket({ ...input, quantity: 16 });
      expect(basket.whiteLayers, JSON.stringify(input)).toBe("unknown");
    }
  });

  it("explicit ink/layer context DOES classify white", () => {
    expect(classifyEvidenceBasket({ productName: "Bag", variantTitle: "Matte + White Ink", quantity: 16 }).whiteLayers).toBe("1+");
    expect(classifyEvidenceBasket({ productName: "Bag", variantTitle: "Holo + White + 4X Spot Gloss", quantity: 16 }).whiteLayers).toBe("1+");
    expect(classifyEvidenceBasket({ productName: "Bag", attributeText: "Finish: White Underbase + CMYK", quantity: 16 }).whiteLayers).toBe("1+");
    expect(classifyEvidenceBasket({ productName: "Bag", attributeText: "whiteLayers: 1", quantity: 16 }).whiteLayers).toBe("1");
    expect(classifyEvidenceBasket({ productName: "Bag", attributeText: "White Layers: 2", quantity: 16 }).whiteLayers).toBe("2");
  });

  it("explicit zero stays zero; missing stays unknown — never assumed zero", () => {
    expect(classifyEvidenceBasket({ productName: "Bag", attributeText: "whiteLayers: 0", quantity: 16 }).whiteLayers).toBe("0");
    const snapshot = JSON.stringify({ productBreakdown: { selections: { whiteLayers: 0 } } });
    expect(classifyEvidenceBasket({ productName: "Bag", costSnapshot: snapshot, quantity: 16 }).whiteLayers).toBe("0");
    expect(classifyEvidenceBasket({ productName: "4x5 Bag", variantTitle: "Double / Matte", quantity: 16 }).whiteLayers).toBe("unknown");
  });
});

describe("jar label zones (4G-B) — explicit Label Set only", () => {
  const jar = (extra: string) =>
    classifyEvidenceBasket({ productName: "100ML Tall Miron Jars", attributeText: extra, quantity: 128 });

  it("every explicit Label Set value maps to its own distinct zone", () => {
    const zones = [
      ["Label Set: Side Only", "side"],
      ["Label Set: Lid Only", "lid"],
      ["Label Set: Side + Lid", "side_lid"],
      ["Label Set: Side + Lid + Bottom", "side_lid_bottom"],
      ["Label Set: Side + Lid + Lid Side", "side_lid_lidside"],
    ] as const;
    const keys = new Set<string>();
    for (const [text, expected] of zones) {
      const basket = jar(text);
      expect(basket.sides, text).toBe(expected);
      keys.add(basketKey(basket));
    }
    expect(keys.size).toBe(zones.length); // zones never merge
  });

  it("jars IGNORE generic double/single tokens (webhook priceSnapshot.sides default is meaningless)", () => {
    expect(jar("Sides: Double Sided").sides).toBe("unknown");
    expect(classifyEvidenceBasket({ productName: "3oz Jar", variantTitle: "Double Sided / Matte", quantity: 10 }).sides).toBe("unknown");
    expect(jar("").sides).toBe("unknown");
  });

  it("bag sides logic is unaffected; bags never take jar zones", () => {
    expect(classifyEvidenceBasket({ productName: "4x5 Bag", variantTitle: "Double Sided / Matte", quantity: 10 }).sides).toBe("2");
    expect(classifyEvidenceBasket({ productName: "4x5 Bag", variantTitle: "Front Only / Matte", quantity: 10 }).sides).toBe("1");
    const bagWithZoneText = classifyEvidenceBasket({ productName: "4x5 Bag", attributeText: "Label Set: Side + Lid", quantity: 10 });
    expect(["1", "2", "unknown"]).toContain(bagWithZoneText.sides);
  });
});

describe("size parsing (4G-E) — case-insensitive, orientation-safe, decimal-aware", () => {
  it("OZ/ML match case-insensitively", () => {
    expect(classifyEvidenceBasket({ productName: "100ML Tall Miron Jars", quantity: 10 }).sizeToken).toBe("100ml-tall");
    expect(classifyEvidenceBasket({ productName: "100ml Tall Miron Jars", quantity: 10 }).sizeToken).toBe("100ml-tall");
    expect(classifyEvidenceBasket({ productName: "3OZ Jar", quantity: 10 }).sizeToken).toBe("3oz");
    expect(classifyEvidenceBasket({ productName: "3oz Jar", quantity: 10 }).sizeToken).toBe("3oz");
  });

  it("100ml tall / 100ml wide / bare 100ml never collapse", () => {
    const tall = classifyEvidenceBasket({ productName: "Miron Jar", attributeText: "Product Type: jar_100ml_tall", quantity: 10 });
    const wide = classifyEvidenceBasket({ productName: "Miron Jar", attributeText: "Product Type: jar_100ml_wide", quantity: 10 });
    const bare = classifyEvidenceBasket({ productName: "Miron 100ml Jar", quantity: 10 });
    expect(tall.sizeToken).toBe("100ml-tall");
    expect(wide.sizeToken).toBe("100ml-wide");
    expect(bare.sizeToken).toBe("100ml");
    expect(new Set([basketKey(tall), basketKey(wide), basketKey(bare)]).size).toBe(3);
  });

  it("explicit decimal dimensions are preserved and stay distinct from the integer size", () => {
    expect(classifyEvidenceBasket({ productName: "Custom Sticker Bag (14 X 18.6)", quantity: 2 }).sizeToken).toBe("14x18.6");
    expect(classifyEvidenceBasket({ productName: "Custom Sticker Bag (14 X 18)", quantity: 2 }).sizeToken).toBe("14x18");
    expect(classifyEvidenceBasket({ productName: "Custom Sticker Bag (4x5)", quantity: 2 }).sizeToken).toBe("4x5");
  });
});

describe("dedup + test propagation (4G-C/D)", () => {
  const context: ShopifyEvidenceContext = {
    lineItemIds: new Set(["111"]),
    orderIds: new Set(["1001"]),
    keysByLineItemId: new Map([["111", "shopify | basket | key"]]),
    testOrders: [{ id: "9999", name: "#1099" }],
  };
  const jobDb = (items: any[], quotes: any[] = []) => ({
    quote: { findMany: async () => quotes },
    productionJobItem: { findMany: async () => items },
  });
  const jobItem = (over: Record<string, any> = {}) => ({
    productTitle: "Ritz Vanilla Cupcake", variantTitle: "Matte / 4X Spot Gloss / Blue", quantity: 64,
    unitPrice: 2.8, selectedFinish: null, costSnapshot: null, createdAt: new Date("2026-06-26T00:00:00Z"),
    priceSnapshot: null, materialSummary: null,
    job: { shop: "shop", quoteId: "shopify_order_555", status: "new", customerName: "Someone", email: "someone@client.com" },
    ...over,
  });

  it("shopifyRefsFromJobItem extracts exact ids from quoteId (numeric + gid) and priceSnapshot", () => {
    expect(shopifyRefsFromJobItem("shopify_order_1001", null)).toEqual({ orderId: "1001", lineItemId: null });
    expect(shopifyRefsFromJobItem("shopify_order_gid://shopify/Order/1001", null)).toEqual({ orderId: "1001", lineItemId: null });
    expect(shopifyRefsFromJobItem("manual_x", JSON.stringify({ orderId: "gid://shopify/Order/42", lineItemId: 111 }))).toEqual({ orderId: "42", lineItemId: "111" });
    expect(shopifyRefsFromJobItem("shopify_order_77", "{not json")).toEqual({ orderId: "77", lineItemId: null });
  });

  it("exact lineItemId match deduplicates — one sale, one row, no customer inflation", async () => {
    const shopifyTwin: EvidenceRecord = {
      source: "shopify_order", basket: classifyEvidenceBasket({ productName: "4x5 Bag", quantity: 64 }),
      key: "shopify | basket | key", quantity: 64, unitPrice: 2.7, state: "accepted",
      customerKey: "abcabcabcabc", evidenceAt: new Date("2026-06-26T00:00:00Z"), exactSnapshot: true,
      refs: { orderId: "1001", lineItemId: "111" },
    };
    const local = await gatherPricingEvidence(
      jobDb([jobItem({ job: { shop: "shop", quoteId: "shopify_order_1001", status: "new", customerName: "Someone", email: "someone@client.com" }, priceSnapshot: JSON.stringify({ orderId: "gid://shopify/Order/1001", lineItemId: 111 }) })]),
      "shop",
      context,
    );
    expect(local.records).toHaveLength(0);
    expect(local.excluded).toHaveLength(1);
    expect(local.excluded[0].reasons).toEqual([DEDUP_REASON]);
    expect(local.totals.distinctCustomers).toBe(0); // deduped twin adds no customer
    const combined = aggregateEvidence([shopifyTwin, ...local.records]);
    expect(combined).toHaveLength(1);
    expect(combined[0].accepted).toBe(1);
    expect(combined[0].distinctCustomers).toBe(1);
  });

  it("fallback order-id match deduplicates when no priceSnapshot exists (gid and numeric forms)", async () => {
    for (const quoteId of ["shopify_order_1001", "shopify_order_gid://shopify/Order/1001"]) {
      const local = await gatherPricingEvidence(
        jobDb([jobItem({ job: { shop: "shop", quoteId, status: "new", customerName: "S", email: "s@client.com" } })]),
        "shop",
        context,
      );
      expect(local.records, quoteId).toHaveLength(0);
      expect(local.excluded[0].reasons).toEqual([DEDUP_REASON]);
    }
  });

  it("jobs paid by Shopify TEST orders are excluded with the exact required reason", async () => {
    const local = await gatherPricingEvidence(
      jobDb([jobItem({ job: { shop: "shop", quoteId: "shopify_order_9999", status: "new", customerName: "S", email: "s@client.com" } })]),
      "shop",
      context,
    );
    expect(local.records).toHaveLength(0);
    expect(local.excluded[0].reasons).toEqual([TEST_ORDER_REASON]);
  });

  it("unrelated production jobs remain eligible; without context behavior is unchanged", async () => {
    const withContext = await gatherPricingEvidence(jobDb([jobItem()]), "shop", context);
    expect(withContext.records).toHaveLength(1); // order 555: not deduped, not test
    const withoutContext = await gatherPricingEvidence(jobDb([jobItem({ job: { shop: "shop", quoteId: "shopify_order_1001", status: "new", customerName: "S", email: "s@client.com" } })]), "shop");
    expect(withoutContext.records).toHaveLength(1); // no context -> no dedup possible
  });

  it("classification conflict between a deduped twin and its Shopify line lands in staff review", async () => {
    const local = await gatherPricingEvidence(
      jobDb([jobItem({ priceSnapshot: JSON.stringify({ orderId: "gid://shopify/Order/1001", lineItemId: 111 }), job: { shop: "shop", quoteId: "shopify_order_1001", status: "new", customerName: "S", email: "s@client.com" } })]),
      "shop",
      context,
    );
    expect(local.review).toHaveLength(1);
    expect(local.review[0].reason).toContain("Classification conflict");
    expect(local.review[0].suggestedAction).toContain("Shopify record is counted");
  });
});

describe("quote test-payment review (4G-I) — flagged, never auto-excluded", () => {
  const quoteRow = (over: Record<string, any> = {}) => ({
    id: "cmq_apples", status: "paid", email: "real@client.com", customerName: "Real Client",
    createdAt: new Date(), updatedAt: new Date(), outcomeAt: null,
    notes: "[GSO] Full payment invoice paid (Shopify order #1099).",
    items: [{ productName: "Apples Banana Pebbles", variant: "Double Sided / Matte / Green", sku: null, quantity: 100, unitPrice: 1.6, selectedFinish: null, costSnapshot: null }],
    ...over,
  });
  const db = (quotes: any[]) => ({ quote: { findMany: async () => quotes }, productionJobItem: { findMany: async () => [] } });
  const context: ShopifyEvidenceContext = { lineItemIds: new Set(), orderIds: new Set(), keysByLineItemId: new Map(), testOrders: [{ id: "9999", name: "#1099" }] };

  it("paid quote whose payment note references a test order is flagged but STILL counted", async () => {
    const local = await gatherPricingEvidence(db([quoteRow()]), "shop", context);
    expect(local.records).toHaveLength(1); // still evidence — review only
    expect(local.review).toHaveLength(1);
    expect(local.review[0].source).toBe("erp_quote");
    expect(local.review[0].reason).toContain("Shopify test order #1099");
    expect(JSON.stringify(local.review)).not.toContain("Real Client");
  });

  it("unusual legitimate product names alone trigger NOTHING — no exclusion, no review", async () => {
    const local = await gatherPricingEvidence(db([quoteRow({ notes: "regular quote notes" })]), "shop", context);
    expect(local.records).toHaveLength(1);
    expect(local.review).toHaveLength(0);
  });

  it("draft quotes never produce test-payment review items", async () => {
    const local = await gatherPricingEvidence(db([quoteRow({ status: "draft" })]), "shop", context);
    expect(local.review).toHaveLength(0);
  });
});

describe("material summary classification (4G-F)", () => {
  it("job materialSummary recovers structured facets through the shared classifier path", async () => {
    const db = {
      quote: { findMany: async () => [] },
      productionJobItem: {
        findMany: async () => [{
          productTitle: "100ML Tall Miron Jars", variantTitle: null, quantity: 128, unitPrice: 4.85,
          selectedFinish: null, costSnapshot: null, createdAt: new Date("2026-06-27T00:00:00Z"),
          priceSnapshot: JSON.stringify({ orderId: "gid://shopify/Order/808", lineItemId: 42, sides: "Double Sided" }),
          materialSummary: "Product Family: Jars | Product Type: jar_100ml_tall | Material: Matte | Finish: No Spot Gloss | Label Set: Side + Lid",
          job: { shop: "shop", quoteId: "manual_entry", status: "new", customerName: "C", email: "c@client.com" },
        }],
      },
    };
    const local = await gatherPricingEvidence(db, "shop");
    expect(local.records).toHaveLength(1);
    const basket = local.records[0].basket;
    expect(basket.family).toBe("premium-jars");
    expect(basket.sizeToken).toBe("100ml-tall");
    expect(basket.materialClass).toBe("matte");
    expect(basket.glossStage).toBe("0");
    expect(basket.sides).toBe("side_lid"); // from Label Set — priceSnapshot "Double Sided" ignored
    expect(basket.whiteLayers).toBe("unknown");
  });

  it("gloss MATERIAL never implies layered gloss stages; bag-color white stays color", () => {
    const gloss = classifyEvidenceBasket({ productName: "Custom Sticker Bag (14 X 18.6)", variantTitle: "GLOSS VINYL / FRONT ONLY", quantity: 2 });
    expect(gloss.materialClass).toBe("gloss");
    expect(gloss.glossStage).toBe("unknown");
    const white = classifyEvidenceBasket({ productName: "Bag", attributeText: "Material: Matte | Bag Color: White", quantity: 10 });
    expect(white.whiteLayers).toBe("unknown");
  });
});

describe("thresholds unchanged after 4G corrections", () => {
  it("5 accepted from 1 customer in 1 month stays withheld (the corrected 4x5 gloss basket shape)", () => {
    const basket = classifyEvidenceBasket({ productName: "Custom Sticker Bag (4x5)", variantTitle: "Gloss Vinyl / Front Only", quantity: 16 });
    const rows: EvidenceRecord[] = [1, 2, 3, 4, 5].map(() => ({
      source: "shopify_order", basket, key: basketKey(basket), quantity: 16, unitPrice: 1.05,
      state: "accepted", customerKey: "same-customer", evidenceAt: new Date("2024-05-05T22:15:56Z"), exactSnapshot: true,
    }));
    const [aggregate] = aggregateEvidence(rows);
    expect(aggregate.accepted).toBe(5);
    expect(aggregate.confidence.eligible).toBe(false);
    expect(aggregate.acceptedMedian).toBeNull();
    expect(aggregate.acceptedLow).toBeNull();
  });
});
