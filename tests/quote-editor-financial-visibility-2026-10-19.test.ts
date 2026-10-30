// 2026-10-19 — QUOTE EDITOR FINANCIAL VISIBILITY (owner decision).
//
// Staff never receive line-level internal cost / margin from the server, and
// cannot set it: a staff save restores financial fields from the DB, and a new
// Manual / Custom line is saved PROVISIONAL — Owner Approval Required — until
// the owner supplies the internal cost and approves the price.
//
// The REAL Quotes loader / action run against an in-memory DB double with a
// mocked Shopify session (no Prisma connection, nothing persisted).

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const authState: { sessionToken: any } = { sessionToken: { sub: "1234" } };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", email: "person@gso.test" }, sessionToken: authState.sessionToken, admin: {} }) },
}));

const LOW_MARGIN_LINE = "[GSO] Low-margin approved by owner@gso.test at 2026-10-01T00:00:00.000Z (threshold 40%, blended 20.0%, lowest item 20.0%): launch";
function freshQuote() {
  return {
    id: "q_1", shop: "shop-1", status: "draft", notes: `Customer wants rush\n${LOW_MARGIN_LINE}`, customerName: "Acme", company: "Acme", email: null, phone: null,
    customerTier: "standard", customerTierLabel: null, createdAt: new Date(0), updatedAt: new Date(0),
    lowMarginApprovedAt: null, lowMarginApprovedBy: null, lowMarginApprovalReason: null, lowMarginApprovalThresholdPct: null, lowMarginApprovedSnapshot: null,
    items: [{
      id: "i_1", quoteId: "q_1", productName: "Custom display", variant: "Large", sku: "CD-1", quantity: 10, unitPrice: 20, unitCost: 8, marginPct: 60, notes: null,
      recipeId: null, recipeName: null, selectedFinish: null, selectedAddOnIds: "", pricingSource: "manual", tierLabel: null, minQuantity: null,
      costSnapshot: JSON.stringify({ estimate: { totalCost: 80 } }),
      priceSnapshot: JSON.stringify({ unitCost: 8, profit: 120, pricingAuthority: { approved: true, status: "APPROVED", kind: "approved_margin_curve", source: "curve", missing: null, diagnosticReference: { unitPrice: 19, totalPrice: 190, basis: "x" } } }),
    }],
  };
}
const RECIPE = {
  id: "r_1", name: "Die-cut sticker", sku: "DCS", productType: "stickers", productTypeProfile: { name: "Stickers", laborRate: 25 }, productionMode: "in_house",
  defaultQuantity: 100, minQuantity: 50, targetMarginPct: 55, materialCost: 0.12,
  tiers: [{ minQty: 50, unitPrice: 0.9, marginPct: 55 }], addOns: [{ id: "a_1", name: "Gloss", amount: 0.05, pricingType: "per_unit", cost: 0.01 }],
  vendorProduct: { defaultUnitCost: 0.11, tiers: [{ minQty: 1, unitCost: 0.11 }], addOns: [] },
};

const dbState: { quote: any; created: any[]; createdItems: any[]; writes: string[] } = { quote: freshQuote(), created: [], createdItems: [], writes: [] };
vi.mock("../app/db.server", () => {
  const model = (name: string) => ({
    findMany: async () => (name === "quote" ? [dbState.quote] : name === "quoteItem" ? dbState.quote.items : name === "productRecipe" ? [RECIPE] : []),
    findFirst: async () => (name === "quote" ? dbState.quote : null),
    findUnique: async () => (name === "quote" ? dbState.quote : null),
    updateMany: async (args: any) => { dbState.writes.push(`${name}.updateMany`); if (name === "quote") Object.assign(dbState.quote, args.data); if (name === "quoteItem") Object.assign(dbState.quote.items.find((row: any) => row.id === args.where.id), args.data); return { count: 1 }; },
    deleteMany: async () => { dbState.writes.push(`${name}.deleteMany`); return { count: 1 }; },
    createMany: async (args: any) => { dbState.writes.push(`${name}.createMany`); dbState.createdItems.push(...args.data); return { count: args.data.length }; },
    create: async (args: any) => { dbState.writes.push(`${name}.create`); dbState.created.push(args.data); return { id: "q_new", ...args.data }; },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any[]) => Promise.all(ops) : model(key)) });
  return { default: db, db };
});

import { OWNER_USER_IDS_ENV, type OwnerAuthorization } from "../app/lib/owner-authorization.server";
import { LOW_MARGIN_APPROVAL_MARKER } from "../app/lib/quote-margin.server";
import { LOW_MARGIN_APPROVAL_MARKER_TEXT, OWNER_APPROVAL_REQUIRED, redactRecipeLineForStaff } from "../app/lib/quote-staff-visibility";
import { itemPricingAuthority, provisionalQuoteStatusCheck, quotePricingAuthorityState } from "../app/lib/quote-pricing-authority";
import { ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { quoteConversionEligibility } from "../app/lib/production-job-source.server";

const QUOTES = "app/routes/app.quotes.tsx";
const src = (path: string) => readFileSync(path, "utf8");
const asOwner = () => { process.env[OWNER_USER_IDS_ENV] = "9001"; authState.sessionToken = { sub: "9001" }; };
const asStaff = () => { process.env[OWNER_USER_IDS_ENV] = "9001"; authState.sessionToken = { sub: "1234" }; };
const post = (payload: unknown) => new Request("https://app.test/app/quotes", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
const OWNER: OwnerAuthorization = { isOwner: true, userId: "9001", actor: "owner@gso.test", reason: "Configured owner" };

afterEach(() => {
  delete process.env[OWNER_USER_IDS_ENV];
  dbState.quote = freshQuote();
  dbState.created = [];
  dbState.createdItems = [];
  dbState.writes = [];
});

/** What the staff browser holds and posts back for the existing quote (redacted values, editor strings). */
const staffEditorItem = (overrides: Record<string, any> = {}) => ({
  id: "i_1", productName: "Custom display", variant: "Large", sku: "CD-1", quantity: "10", unitPrice: "20", unitCost: "0", notes: "",
  recipeId: "", recipeName: "", selectedFinish: "base", selectedAddOnIds: [], pricingSource: "manual", tierLabel: "", minQuantity: "", marginPct: "",
  costSnapshot: "", priceSnapshot: JSON.stringify({ pricingAuthority: { approved: true, status: "APPROVED", kind: "approved_margin_curve", source: null, missing: null, ownerApproval: null } }),
  ...overrides,
});
const newManualItem = { id: "tmp_1", productName: "Custom banner stand", variant: "Black", sku: "", quantity: "5", unitPrice: "40", unitCost: "1", notes: "spec: 33x80", recipeId: "", recipeName: "", selectedFinish: "base", selectedAddOnIds: [], pricingSource: "manual", tierLabel: "", minQuantity: "", marginPct: "97", costSnapshot: "", priceSnapshot: "" };

describe("staff do not receive or view line-level cost / margin", () => {
  it("the loader sends staff NO internal cost, margin, snapshots, recipe costs or margin audit lines", async () => {
    asStaff();
    const { loader } = await import("../app/routes/app.quotes");
    const data = await (await loader({ request: new Request("https://app.test/app/quotes") }) as Response).json();
    const item = data.quotes[0].items[0];
    expect(item.unitCost).toBeNull();
    expect(item.marginPct).toBeNull();
    expect(item.costSnapshot).toBeNull();
    expect(JSON.parse(item.priceSnapshot)).toEqual({ pricingAuthority: { approved: true, status: "APPROVED", kind: "approved_margin_curve", source: null, missing: null, ownerApproval: null } });
    expect(item.unitPrice).toBe(20); // the customer price is still there
    expect(data.quotes[0].notes).toBe("Customer wants rush");
    expect(data.recipes[0]).toEqual({ id: "r_1", name: "Die-cut sticker", sku: "DCS", productType: "stickers", productTypeProfile: { name: "Stickers" }, productionMode: "in_house", defaultQuantity: 100, minQuantity: 50, addOns: [{ id: "a_1", name: "Gloss" }], vendorProduct: { addOns: [] } });
    const wire = JSON.stringify(data);
    expect(wire).not.toMatch(/"unitCost":\d|"profit"|"marginPct":\d|targetMarginPct|defaultUnitCost|diagnosticReference|blended/);
    // the editor hides the cost / margin fields and totals for staff
    const q = src(QUOTES);
    expect(q).toContain('{ownerAccess.isOwner ? <Text as="p">Line Cost: ${lineCost.toFixed(2)}</Text> : null}');
    expect(q).toContain('{ownerAccess.isOwner ? <Text as="p">Total Cost: ${totals.cost.toFixed(2)}</Text> : null}');
    expect(q.split('{ownerAccess.isOwner ? <TextField label="Margin %"').length - 1).toBe(2);
    expect(q).toContain("{ownerAccess.isOwner ? (\n        <Layout.Section>");
    expect(q).not.toContain("\\nProfit: $${totals.profit.toFixed(2)}"); // customer email carries no profit / margin
    // "Calculate from ERP" returns the customer price only
    expect(redactRecipeLineForStaff({ ok: true, estimate: { totalCost: 9 }, priceSnapshot: {}, line: { unitPrice: "0.90", unitCost: "0.40", marginPct: "55.0", costSnapshot: "{}", priceSnapshot: "{}" } }))
      .toEqual({ ok: true, warnings: [], line: { unitPrice: "0.90", unitCost: "", marginPct: "", costSnapshot: "", priceSnapshot: "" } });
    expect(LOW_MARGIN_APPROVAL_MARKER_TEXT).toBe(LOW_MARGIN_APPROVAL_MARKER);
  }, 60_000);

  it("a staff save cannot see OR overwrite internal cost — the server restores it from the DB", async () => {
    asStaff();
    const { action } = await import("../app/routes/app.quotes");
    const body = await (await action({ request: post({ intent: "save", quote: { id: "q_1", customerName: "Acme", company: "Acme", email: "", phone: "", customerTier: "standard", customerTierLabel: "", status: "draft", notes: "Customer wants rush", items: [staffEditorItem({ unitPrice: "21" })] } }) })).json();
    expect(body.ok).toBe(true);
    const saved = dbState.createdItems[0];
    expect(saved.unitCost).toBe(8);
    expect(saved.unitPrice).toBe(21);
    expect(saved.costSnapshot).toBe(freshQuote().items[0].costSnapshot);
    expect(JSON.parse(saved.priceSnapshot).pricingAuthority.diagnosticReference).toBeDefined(); // DB snapshot kept intact
    expect(dbState.quote.notes).toContain(LOW_MARGIN_LINE); // margin audit line kept server-side
    expect(body.quotes[0].items[0].unitCost).toBeNull(); // and the refreshed list is redacted again
  }, 60_000);
});

describe("owner receives line-level cost / margin", () => {
  it("the loader sends the owner full cost, margin, snapshots and recipe costs", async () => {
    asOwner();
    const { loader } = await import("../app/routes/app.quotes");
    const data = await (await loader({ request: new Request("https://app.test/app/quotes") }) as Response).json();
    const item = data.quotes[0].items[0];
    expect(item.unitCost).toBe(8);
    expect(item.marginPct).toBe(60);
    expect(JSON.parse(item.priceSnapshot).profit).toBe(120);
    expect(data.quotes[0].notes).toContain(LOW_MARGIN_LINE);
    expect(data.recipes[0].targetMarginPct).toBe(55);
    expect(data.recipes[0].vendorProduct.defaultUnitCost).toBe(0.11);
  }, 60_000);
});

describe("staff Manual / Custom items -> Owner Approval Required", () => {
  async function staffCreatesManualItem(status = "draft") {
    asStaff();
    const { action } = await import("../app/routes/app.quotes");
    return (await action({ request: post({ intent: "save", quote: { id: null, customerName: "New Co", company: "New Co", email: "", phone: "", customerTier: "standard", customerTierLabel: "", status, notes: "", items: [newManualItem] } }) })).json();
  }

  it("staff can still create a Manual / Custom item (description, quantity, specs, notes, customer price)", async () => {
    const body = await staffCreatesManualItem();
    expect(body.ok).toBe(true);
    const line = dbState.created[0].items.create[0];
    expect(line).toMatchObject({ productName: "Custom banner stand", variant: "Black", quantity: 5, unitPrice: 40, notes: "spec: 33x80" });
  }, 60_000);

  it("without an authoritative internal cost it becomes Owner Approval Required — a typed staff cost is ignored", async () => {
    await staffCreatesManualItem();
    const line = dbState.created[0].items.create[0];
    expect(line.unitCost).toBe(0); // the staff-posted "1" never reaches the DB
    expect(line.marginPct).toBeNull();
    const record = itemPricingAuthority(line)!;
    expect(record).toMatchObject({ approved: false, kind: "staff_manual_item", customerUnitPrice: null });
    expect(record.missing).toContain(OWNER_APPROVAL_REQUIRED);
    expect(quotePricingAuthorityState({ items: [line] }).provisional).toBe(true);
  }, 60_000);

  it("it cannot be sent, approved or produced until the owner supplies the cost and approves the price", async () => {
    const refused = await staffCreatesManualItem("sent");
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("PROVISIONAL");
    expect(dbState.created).toEqual([]);
    await staffCreatesManualItem("draft");
    const line = { ...dbState.created[0].items.create[0], id: "i_new", quoteId: "q_new" };
    const quote = { id: "q_new", shop: "shop-1", status: "draft", notes: "", customerTier: "standard", customerTierLabel: null, items: [line] };
    for (const next of ["sent", "approved", "won", "paid"]) expect(provisionalQuoteStatusCheck(quote, next).ok, next).toBe(false);
    expect(quoteConversionEligibility({ ...quote, status: "paid" }, "shop-1").ok).toBe(false);
    const q = src(QUOTES);
    for (const intent of ["approveCreateOrder", "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail"]) {
      expect(q).toContain(`return Response.json({ intent: "${intent}", ok: false, error: pricingAuthorityState.blockMessage });`);
    }
    // owner approval needs the internal cost for a line that has none
    const state = { quote: JSON.parse(JSON.stringify(quote)) };
    const db: any = {
      quote: { findFirst: async () => state.quote, updateMany: async (args: any) => Object.assign(state.quote, args.data) },
      quoteItem: { updateMany: async (args: any) => Object.assign(state.quote.items[0], args.data) },
      $transaction: async (ops: any[]) => Promise.all(ops),
    };
    const noCost = await ownerSetQuoteItemPrice(db, { shop: "shop-1", quoteId: "q_new", itemId: "i_new", unitPrice: "40", reason: "custom job", owner: OWNER });
    expect(noCost.ok).toBe(false);
    expect((noCost as any).error).toContain("supply the internal unit cost");
    const approved = await ownerSetQuoteItemPrice(db, { shop: "shop-1", quoteId: "q_new", itemId: "i_new", unitPrice: "40", internalUnitCost: "22", reason: "custom job, vendor quote $22", owner: OWNER });
    expect(approved.ok).toBe(true);
    expect(state.quote.items[0].unitCost).toBe(22);
    const approval = itemPricingAuthority(state.quote.items[0])!.ownerApproval!;
    expect(approval).toMatchObject({ internalCostSuppliedByOwner: true, trueUnitCost: 22, expectedProfit: 90, expectedMarginPct: 45 });
    // now it may proceed
    expect(provisionalQuoteStatusCheck(state.quote, "sent")).toEqual({ ok: true });
    expect(quoteConversionEligibility({ ...state.quote, status: "paid" }, "shop-1")).toEqual({ ok: true, reason: "" });
    // a canonical true cost is never replaced by a typed one
    const canonicalLine = { ...line, costSnapshot: JSON.stringify({ canonical: { version: "2D-4", status: "VALID", unitCost: 3, totalCost: 15, quantity: 5, family: "banners" } }) };
    state.quote = { ...quote, items: [canonicalLine] };
    const replaced = await ownerSetQuoteItemPrice(db, { shop: "shop-1", quoteId: "q_new", itemId: "i_new", unitPrice: "40", internalUnitCost: "1", reason: "x", owner: OWNER });
    expect(replaced.ok).toBe(false);
  }, 60_000);
});

describe("formulas unchanged", () => {
  it("no cost or pricing engine file was touched", () => {
    for (const lib of [
      "app/lib/canonical-calculator.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/banner-cost-inputs.server.ts",
      "app/lib/label-cost-inputs.server.ts", "app/lib/jar-cost-inputs.server.ts", "app/lib/true-cost-engine.server.ts", "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/storefront-canonical-pricing.server.ts", "app/lib/jar-commercial-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts", "app/lib/customer-tiers.ts", "app/lib/recipe-pricing.server.ts",
    ]) expect(src(lib), lib).not.toContain("2026-10-19");
  });
});
