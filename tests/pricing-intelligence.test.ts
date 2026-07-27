// 15F.0K.4D — pricing-intelligence evidence capture: quote outcomes,
// conservative test-data exclusion, basket classification (never mixing
// finishes/sides/forms), threshold-gated statistics, and privacy.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACCEPTED_EVIDENCE_STATUSES,
  EVIDENCE_MIN_ACCEPTED,
  MSG_INSUFFICIENT_CUSTOMERS,
  MSG_INSUFFICIENT_MONTHS,
  MSG_NOT_ENOUGH_HISTORY,
  QUOTE_OUTCOME_STATUSES,
  aggregateEvidence,
  basketKey,
  classifyEvidenceBasket,
  customerKey,
  evidenceConfidence,
  evidenceExclusion,
  gatherPricingEvidence,
  qtyBandFor,
  resolveQuoteOutcomeChange,
  type EvidenceRecord,
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
    expect(src).toContain("Shopify historical-order evidence is not yet connected. Current counts are based only on locally stored ERP records.");
  });
});
