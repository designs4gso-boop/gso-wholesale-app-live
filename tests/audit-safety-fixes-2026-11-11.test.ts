// 2026-11-11 — safety fixes from the full ERP recovery audit.
//
//  1. Quotes: only known statuses; payment/production states (deposit_paid,
//     paid, production) are owner-only by hand — `paid` makes a quote
//     production-eligible. The editor's save obeys the same rules plus the
//     low-margin gate.
//  2. Low-margin legacy notes marker counts only at the start of a line.
//  3. Owner low-margin approval refuses a $0 / missing price.
//  4. Production QC guard: a reprint or reopen invalidates an earlier PASS.
//  5. Public proof page returns a customer-safe projection only.
//  6. Polaris TextField forms post what the user sees (FormTextField).
//  7. Custom Item never offers canonical-family blanks; recipe gate knows
//     stock_bag_4x5 and the Split Bag.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OWNER_ONLY_QUOTE_STATUSES, QUOTE_STATUS_VALUES, quoteStatusChangeCheck } from "../app/lib/quote-pricing-authority";
import { LOW_MARGIN_APPROVAL_MARKER, quoteMarginState } from "../app/lib/quote-margin.server";
import { evaluateQcForCompletion } from "../app/lib/production-qc-guard";
import { blankClassAllowedFor } from "../app/lib/product-driven-costing.server";
import { canonicalFamilyKeyForRecipe } from "../app/lib/agent-quote-canonical-gate.server";

const src = (path: string) => readFileSync(path, "utf8");

describe("1. quote status changes", () => {
  it("unknown statuses are refused", () => {
    expect(quoteStatusChangeCheck({ currentStatus: "draft", nextStatus: "shipped", isOwner: true }).ok).toBe(false);
  });
  it("staff cannot set deposit_paid / paid / production by hand; the owner can", () => {
    expect(OWNER_ONLY_QUOTE_STATUSES).toEqual(["deposit_paid", "paid", "production"]);
    for (const next of OWNER_ONLY_QUOTE_STATUSES) {
      expect(quoteStatusChangeCheck({ currentStatus: "approved", nextStatus: next, isOwner: false }).ok, next).toBe(false);
      expect(quoteStatusChangeCheck({ currentStatus: "approved", nextStatus: next, isOwner: true }).ok, next).toBe(true);
    }
  });
  it("normal staff moves (and unchanged statuses on save) still work", () => {
    for (const next of ["draft", "sent", "approved", "completed", "won", "lost", "canceled", "expired"]) {
      expect(quoteStatusChangeCheck({ currentStatus: "draft", nextStatus: next, isOwner: false }).ok, next).toBe(true);
    }
    // a save that keeps an already-paid status is not a manual payment change
    expect(quoteStatusChangeCheck({ currentStatus: "paid", nextStatus: "paid", isOwner: false }).ok).toBe(true);
    expect(QUOTE_STATUS_VALUES).toContain("canceled");
  });
  it("both Quotes handlers call the check, and save applies the low-margin gate", () => {
    const quotes = src("app/routes/app.quotes.tsx");
    expect(quotes.match(/quoteStatusChangeCheck\(/g)).toHaveLength(2);
    expect(quotes).toContain("const saveMarginState = quoteMarginState(");
    expect(quotes).toContain("if (marginState.hasInvalidPrice) {");
  });
});

describe("2. legacy low-margin marker", () => {
  const lowQuote = (notes: string) => ({ customerTier: "standard", notes, items: [{ productName: "x", quantity: 10, unitPrice: 1, unitCost: 0.9 }] });
  it("a marker at the start of a line still approves (system-written form)", () => {
    expect(quoteMarginState(lowQuote(`hello\n${LOW_MARGIN_APPROVAL_MARKER}owner at t: reason`) as any).isApproved).toBe(true);
  });
  it("a marker buried mid-line (staff-typed) does not", () => {
    expect(quoteMarginState(lowQuote(`please x ${LOW_MARGIN_APPROVAL_MARKER}me`) as any).isApproved).toBe(false);
  });
});

describe("4. QC completion guard after reprint / reopen", () => {
  const items = [{ itemTicket: "GSO-1-01", productTitle: "Label" }];
  it("a reprint qc_result after a PASS blocks completion", () => {
    const events = [
      { eventType: "qc_result", oldValue: "GSO-1-01", newValue: "pass", createdAt: "2026-11-01T10:00:00Z" },
      { eventType: "qc_result", oldValue: "GSO-1-01", newValue: "reprint_required", createdAt: "2026-11-01T11:00:00Z" },
    ];
    expect(evaluateQcForCompletion(items, events).ok).toBe(false);
    expect(evaluateQcForCompletion(items, [...events, { eventType: "qc_result", oldValue: "GSO-1-01", newValue: "pass", createdAt: "2026-11-01T12:00:00Z" }]).ok).toBe(true);
  });
  it("reprint and reopen handlers write the invalidating qc_result rows", () => {
    const production = src("app/routes/app.erp.production.tsx");
    expect(production).toContain('"qc_result", `QC reset by reprint request');
    expect(production).toContain('"qc_result", `QC reset to HOLD by reopen for reprint');
  });
});

describe("5-6. public proof projection and form fields", () => {
  it("the proof loader returns a customer-safe projection, never the raw job", () => {
    const proof = src("app/routes/proof.$token.tsx");
    expect(proof).toContain("return Response.json({ job: customerJob });");
    expect(proof).not.toContain("return Response.json({ job });");
  });
  it("no route posts a Polaris TextField that has no value (it would post blanks)", () => {
    for (const file of ["app/routes/app.erp.production.tsx", "app/routes/app.erp.print-log-settings.tsx", "app/routes/app.wholesale.tsx", "app/routes/app.erp.reorder-report.tsx"]) {
      const text = src(file);
      expect(text, file).not.toMatch(/<TextField\b/);
      expect(text, file).toContain('from "../components/FormTextField"');
    }
  });
});

describe("7. canonical families stay out of legacy paths", () => {
  it("Custom Item never offers a canonical-family blank", () => {
    for (const klass of ["bag_sticker", "bag_dtp", "jar_standard", "jar_chiron", "jar_miron", "miron_top"] as const) {
      expect(blankClassAllowedFor("custom-item", klass), klass).toBe(false);
    }
    expect(blankClassAllowedFor("custom-item", "other")).toBe(true);
  });
  it("recipe family gate recognises underscore forms and the Split Bag", () => {
    expect(canonicalFamilyKeyForRecipe({ productType: "stock_bag_4x5" })).toBe("sticker-bags");
    expect(canonicalFamilyKeyForRecipe({ productType: "split_bag" })).toBe("split-bags");
    expect(canonicalFamilyKeyForRecipe({ productType: "Split Bag" })).toBe("split-bags");
  });
});

/* ---- 2026-11-11 final pass: storefront fail-closed + scoped approved-cost apply ---- */
import { applyApprovedCostUpdates } from "../app/lib/approved-cost-updates.server";

describe("8. storefront checkout fails closed for unmodeled products", () => {
  it("non-launch jars and non-4x5 bag types get NO_PRICING_AUTHORITY, never a legacy rule price", () => {
    const checkout = src("app/routes/apps.wholesale-lite.configurator-checkout.ts");
    expect(checkout).toContain('const STOREFRONT_PRICED_BAG_TYPES = new Set(["stock_bag_4x5", "sticker_bag_4x5"]);');
    expect(checkout).toContain("|| (isJar && !jarLaunchSize) || unmodeledBag) {");
    const loader = src("app/routes/apps.wholesale-lite.configurator.ts");
    expect(loader).toContain('pricingMessage = "This product is not available for online pricing yet.";');
  });
});

describe("9. Approved Cost Updates can apply ONE owner-approved entry", () => {
  it("onlyKeys=[miron-50ml] rewrites only the 50ml tiers, leaving other pending registry changes alone", async () => {
    const ops: string[] = [];
    const vendorProducts = [
      { id: "vp_50", name: "50ml Miron Jar + Lid", vendor: "Miron", vendorSku: "preset:miron-50ml", defaultUnitCost: 2.46, notes: "", tiers: [1, 250, 500, 1000, 2500].map((minQty, i) => ({ id: `t${i}`, minQty, maxQty: null, unitCost: [2.46, 2.24, 2.03, 1.89, 1.74][i] })) },
      { id: "vp_bag", name: "Blank 4x5 bag", vendor: "Safe Care", vendorSku: "preset:blank-4x5-bag", defaultUnitCost: 0.09, notes: "", tiers: [{ id: "tb", minQty: 1, maxQty: null, unitCost: 0.09 }] },
    ];
    const tx: any = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_m, method: string) => async (args: any) => { ops.push(`${model}.${method}:${args?.where?.vendorProductId ?? args?.where?.id ?? args?.data?.[0]?.vendorProductId ?? ""}`); return {}; } }) });
    const db: any = {
      vendorProduct: { findMany: async () => vendorProducts },
      material: { findMany: async () => [] },
      machine: { findMany: async () => [] },
      $transaction: async (fn: any) => fn(tx),
    };
    await applyApprovedCostUpdates(db, "shop-1", { onlyKeys: ["miron-50ml"] });
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((op) => op.includes("vp_50") || op.startsWith("vendorProductTier.createMany"))).toBe(true);
    expect(ops.some((op) => op.includes("vp_bag") || op.includes("tb"))).toBe(false);
  });
  it("the apply action is owner-only and validates the key", () => {
    const route = src("app/routes/app.erp.cost-verification.tsx");
    expect(route).toContain('requireOwner(auth, process.env, "Applying approved cost updates is owner only.");');
    expect(route).toContain("applyApprovedCostUpdates(db, session.shop, onlyKey ? { onlyKeys: [onlyKey] } : {})");
  });
});
