// Patch 2D-4E3 — the Quotes editor cannot retype a canonical manufacturing
// unit cost. Pure decision tests + source assertions on the save boundary.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUOTE_ITEM_COST_AUTHORITY_VERSION,
  QUOTE_ITEM_COST_REASONS,
  canonicalCostBlockOf,
  enforceQuoteItemUnitCost,
  quoteItemCostIsProtected,
} from "../app/lib/quote-item-cost-authority";

/** The Cost Calculator's saved costSnapshot shape (2D-4 + 2D-4E3 quantity). */
function calculatorSnapshot(overrides: Partial<{ status: string; unitCost: number | null; quantity: number | null; family: string }> = {}) {
  return JSON.stringify({
    canonical: {
      version: "17D.7B-canonical-calculator",
      family: overrides.family ?? "stickers-labels",
      status: overrides.status ?? "PROVISIONAL",
      totalCost: 123.456,
      unitCost: "unitCost" in overrides ? overrides.unitCost : 0.123456,
      quantity: "quantity" in overrides ? overrides.quantity : 1000,
      lines: [], totals: {}, diagnostics: {}, reasons: [], blockers: [],
    },
    canonicalSnapshot: { snapshotVersion: "15G.2-canonical-snapshot-v1", quantity: 1000, unitCost: 0.123456 },
    engine: "15F.0-production-ready-pricing",
  });
}

/** A recipe-priced item: its `canonical` is the 15G.2 pricing snapshot, NOT a true-cost block. */
const RECIPE_SNAPSHOT = JSON.stringify({
  recipeId: "r1",
  canonical: { snapshotVersion: "15G.2-canonical-snapshot-v1", engine: "recipe-pricing/tier", family: "label", quantity: 500, totalCost: 50, unitCost: 0.1, recommendedUnitPrice: 0.2, recommendedTotalPrice: 100 },
});

describe("2D-4E3 canonical block detection", () => {
  it("recognises the Cost Calculator's canonical true-cost block", () => {
    const block = canonicalCostBlockOf(calculatorSnapshot());
    expect(block).not.toBeNull();
    expect(block!.family).toBe("stickers-labels");
    expect(block!.status).toBe("PROVISIONAL");
    expect(block!.unitCost).toBeCloseTo(0.123456, 10);
    expect(block!.quantity).toBe(1000);
    expect(quoteItemCostIsProtected(calculatorSnapshot())).toBe(true);
    expect(QUOTE_ITEM_COST_AUTHORITY_VERSION).toContain("quote-item-cost-authority");
  });

  it("never mistakes a recipe pricing snapshot, a manual item, or garbage for canonical authority", () => {
    expect(canonicalCostBlockOf(RECIPE_SNAPSHOT)).toBeNull();
    expect(canonicalCostBlockOf(null)).toBeNull();
    expect(canonicalCostBlockOf("")).toBeNull();
    expect(canonicalCostBlockOf("{not json")).toBeNull();
    expect(canonicalCostBlockOf(JSON.stringify({ canonical: { family: "dtp-bags", status: "VALID", unitCost: 1 } }))).toBeNull();
    expect(canonicalCostBlockOf(JSON.stringify({ canonical: { family: "stickers-labels", status: "WEIRD", unitCost: 1 } }))).toBeNull();
    expect(quoteItemCostIsProtected(RECIPE_SNAPSHOT)).toBe(false);
  });

  it("falls back to the 15G.2 snapshot quantity for pre-2D-4E3 saves", () => {
    const legacySave = JSON.stringify({
      canonical: { version: "17D.7B", family: "sticker-bags", status: "VALID", totalCost: 90, unitCost: 0.09 },
      canonicalSnapshot: { quantity: 1000 },
    });
    expect(canonicalCostBlockOf(legacySave)!.quantity).toBe(1000);
  });
});

describe("2D-4E3 the unit-cost decision", () => {
  it("a usable canonical item holds the canonical unit cost — the typed value is ignored", () => {
    const decision = enforceQuoteItemUnitCost({ unitCost: "0.01", quantity: "1000", costSnapshot: calculatorSnapshot(), productName: "Labels" });
    expect(decision.protected).toBe(true);
    if (!decision.protected || !decision.ok) throw new Error("expected protected ok");
    expect(decision.unitCost).toBeCloseTo(0.123456, 10);
    expect(decision.family).toBe("stickers-labels");
    expect(decision.note).toContain("typed value 0.01 ignored");
  });

  it("a BLOCKED canonical item cannot be saved with a typed cost — refused, never $0", () => {
    const draft = enforceQuoteItemUnitCost({ unitCost: "0.50", quantity: "1000", costSnapshot: calculatorSnapshot({ status: "DRAFT_ONLY", unitCost: null }) });
    expect(draft.protected).toBe(true);
    if (!draft.protected || draft.ok) throw new Error("expected refusal");
    expect(draft.reason).toContain(QUOTE_ITEM_COST_REASONS.blocked);
    const nullCost = enforceQuoteItemUnitCost({ unitCost: "0.50", quantity: "1000", costSnapshot: calculatorSnapshot({ status: "VALID", unitCost: null }) });
    expect(nullCost.protected && !nullCost.ok).toBe(true);
  });

  it("a quantity change on a canonical item is refused — it cannot be re-costed in the editor", () => {
    const changed = enforceQuoteItemUnitCost({ unitCost: "0.123456", quantity: "1500", costSnapshot: calculatorSnapshot() });
    expect(changed.protected && !changed.ok).toBe(true);
    if (!changed.protected || changed.ok) throw new Error("expected refusal");
    expect(changed.reason).toContain(QUOTE_ITEM_COST_REASONS.quantityChanged);
    // same quantity is fine; unknown snapshot quantity cannot be checked and passes
    expect(enforceQuoteItemUnitCost({ unitCost: "1", quantity: "1000", costSnapshot: calculatorSnapshot() }).protected).toBe(true);
    const noQtyAnywhere = JSON.stringify({ canonical: { version: "17D.7B", family: "banners", status: "VALID", totalCost: 40, unitCost: 20 } });
    const noQty = enforceQuoteItemUnitCost({ unitCost: "1", quantity: "7", costSnapshot: noQtyAnywhere });
    expect(noQty.protected && noQty.ok).toBe(true);
    if (noQty.protected && noQty.ok) expect(noQty.unitCost).toBe(20);
  });

  it("legacy / recipe / manual items keep the typed value (unchanged behaviour)", () => {
    const recipe = enforceQuoteItemUnitCost({ unitCost: "0.42", quantity: "500", costSnapshot: RECIPE_SNAPSHOT });
    expect(recipe).toEqual({ protected: false, unitCost: 0.42 });
    const manual = enforceQuoteItemUnitCost({ unitCost: "3.5", quantity: "10" });
    expect(manual).toEqual({ protected: false, unitCost: 3.5 });
    const empty = enforceQuoteItemUnitCost({ unitCost: "", quantity: "10", costSnapshot: "" });
    expect(empty).toEqual({ protected: false, unitCost: 0 });
  });
});

describe("2D-4E3 the Quotes route save boundary", () => {
  const route = readFileSync("app/routes/app.quotes.tsx", "utf8");

  it("enforces the decision BEFORE either write path and refuses on a protected failure", () => {
    const saveIdx = route.indexOf('if (payload.intent === "save") {');
    const enforceIdx = route.indexOf("const costDecisions = quote.items.map((item) => enforceQuoteItemUnitCost(item));");
    const refuseIdx = route.indexOf("return Response.json({ ok: false, error: refused.reason, canonicalBlocked: true, quotes });");
    const updateIdx = route.indexOf("db.quoteItem.createMany({");
    const createIdx = route.indexOf("await db.quote.create({");
    expect(saveIdx).toBeGreaterThan(0);
    expect(enforceIdx).toBeGreaterThan(saveIdx);
    expect(refuseIdx).toBeGreaterThan(enforceIdx);
    expect(updateIdx).toBeGreaterThan(refuseIdx);
    expect(createIdx).toBeGreaterThan(refuseIdx);
  });

  it("both write paths persist the PROTECTED items, not the raw posted ones", () => {
    expect(route).toContain("data: protectedItems.map((item) => quoteItemData(item, quote.id as string)),");
    expect(route).toContain("create: protectedItems.map((item) => quoteItemData(item)),");
    expect(route).not.toContain("data: quote.items.map((item) => quoteItemData(item, quote.id as string)),");
    expect(route).not.toContain("create: quote.items.map((item) => quoteItemData(item)),");
  });

  it("the editor renders a protected item's unit cost read-only (both item layouts)", () => {
    expect(route.match(/disabled=\{quoteItemCostIsProtected\(item\.costSnapshot\)\}/g)).toHaveLength(2);
    expect(route).toContain("Canonical true manufacturing cost — read-only.");
  });

  it("the Cost Calculator records the finished quantity on its canonical block", () => {
    const calculator = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(calculator).toContain("quantity: canonicalSnapshot.trueCost.customerFinishedQty,");
  });
});
