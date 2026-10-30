// 2026-10-19 — Cost & Pricing FINAL ACCESS LOCK (owner decisions round 3).
//
//   1. Owner = verified Shopify staff user ID in GSO_OWNER_SHOPIFY_USER_IDS
//      (one or more). No configuration -> nobody is the owner (fail closed).
//   2. The ENTIRE Cost & Pricing Calculator is owner only — loader AND action
//      refuse non-owners server-side (403); the nav link is hidden for staff.
//   3. No nullable-price migration: the schema-required 0 placeholder on a
//      provisional line never escapes as a customer price.
//   4. OWNER SET PRICE & APPROVE also satisfies the low-margin approval for
//      that exact line; both reset together on any commercial change.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const authState: { session: any; sessionToken: any } = { session: { shop: "shop-1" }, sessionToken: { sub: "1234" } };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: authState.session, sessionToken: authState.sessionToken, admin: {} }) },
}));

import { PROVISIONAL_PRICING_STATUS, UNAPPROVED_MARGIN_CURVES } from "../app/lib/calculator-owner-view";
import {
  COST_PRICING_OWNER_ONLY_MESSAGE,
  OWNER_USER_IDS_ENV,
  requireOwner,
  resolveOwnerAuthorization,
  type OwnerAuthorization,
} from "../app/lib/owner-authorization.server";
import {
  LOW_MARGIN_OWNER_OVERRIDE_NOTE,
  itemPricingAuthority,
  ownerApprovalCoversLine,
  provisionalQuoteStatusCheck,
  quotePricingAuthorityState,
  reconcileQuoteItemPricingAuthority,
  storefrontAuthorityExempt,
} from "../app/lib/quote-pricing-authority";
import { ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { LOW_MARGIN_THRESHOLD_PCT, quoteMarginState } from "../app/lib/quote-margin.server";
import { tierRule } from "../app/lib/customer-tiers";
import { quoteConversionEligibility } from "../app/lib/production-job-source.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const QUOTES = "app/routes/app.quotes.tsx";
const src = (path = ROUTE) => readFileSync(path, "utf8");
const ENV_OWNERS = { [OWNER_USER_IDS_ENV]: "9001,9002" };

afterEach(() => {
  delete process.env[OWNER_USER_IDS_ENV];
  authState.sessionToken = { sub: "1234" };
});

/* ---- quote fixtures (the shapes the calculator save writes) ---- */
const provisionalRecord = () => ({
  approved: false, status: PROVISIONAL_PRICING_STATUS, kind: "none", source: null, missing: UNAPPROVED_MARGIN_CURVES.banners,
  customerUnitPrice: null, customerTotalPrice: null, diagnosticReference: { unitPrice: 7.5, totalPrice: 15, basis: "unsourced" },
});
const dbItem = (overrides: Record<string, any> = {}) => ({
  id: "item_1", quoteId: "q_1", productName: "Banner 36x60", variant: null, sku: null, quantity: 2,
  unitPrice: 0, unitCost: 21.5, notes: null, recipeId: null, recipeName: null, selectedFinish: null, selectedAddOnIds: "",
  pricingSource: null, tierLabel: null, minQuantity: null, marginPct: null,
  costSnapshot: JSON.stringify({ canonical: { family: "banners", input: { widthIn: 36, heightIn: 60, sides: "SINGLE", material: "13oz vinyl" } } }),
  priceSnapshot: JSON.stringify({ unitPrice: null, marginPct: null, pricingAuthority: provisionalRecord() }),
  ...overrides,
});
const dbQuote = (items: any[], overrides: Record<string, any> = {}) => ({
  id: "q_1", shop: "shop-1", status: "draft", notes: "calculator draft", customerTier: "standard", customerTierLabel: null, items, ...overrides,
});
function recordingDb(quote: any) {
  const calls: string[] = [];
  const state = { quote: JSON.parse(JSON.stringify(quote)) };
  const db: any = {
    quote: {
      findFirst: async () => { calls.push("quote.findFirst"); return state.quote; },
      updateMany: async (args: any) => { calls.push("quote.updateMany"); Object.assign(state.quote, args.data); return { count: 1 }; },
    },
    quoteItem: {
      updateMany: async (args: any) => { calls.push("quoteItem.updateMany"); Object.assign(state.quote.items.find((row: any) => row.id === args.where.id), args.data); return { count: 1 }; },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return { calls, state, db: new Proxy(db, { get: (target, key: string) => { if (key in target) return target[key]; throw new Error(`forbidden model: ${key}`); } }) };
}
const OWNER: OwnerAuthorization = { isOwner: true, userId: "9001", actor: "owner@gso.test", reason: "Configured owner" };
const STAFF: OwnerAuthorization = { isOwner: false, userId: "1234", actor: "staff@gso.test", reason: "Owner-only action: you are not the configured owner." };
async function approveAt(unitPrice: string) {
  const harness = recordingDb(dbQuote([dbItem()]));
  const result = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice, reason: "Intentional launch price", owner: OWNER, now: new Date("2026-10-19T16:00:00Z") });
  expect(result.ok).toBe(true);
  return { ...harness, result };
}
const editorCopy = (item: any) => ({
  id: item.id, productName: item.productName || "", variant: item.variant || "", sku: item.sku || "",
  quantity: String(item.quantity || 1), unitPrice: String(item.unitPrice || 0), unitCost: String(item.unitCost || 0), notes: item.notes || "",
  recipeId: item.recipeId || "", recipeName: item.recipeName || "", selectedFinish: item.selectedFinish || "base",
  selectedAddOnIds: String(item.selectedAddOnIds || "").split(",").filter(Boolean),
  pricingSource: item.pricingSource || (item.recipeId ? "recipe" : "manual"), tierLabel: item.tierLabel || "",
  minQuantity: item.minQuantity != null ? String(item.minQuantity) : "", marginPct: item.marginPct != null ? String(item.marginPct) : "",
  costSnapshot: item.costSnapshot || "", priceSnapshot: item.priceSnapshot || "",
});

/* ================================================================== */

describe("owner route lock (tests 1-5)", () => {
  it("1. the owner can open the Cost & Pricing Calculator (any of several configured IDs)", () => {
    for (const sub of ["9001", "9002"]) {
      const owner = requireOwner({ session: { shop: "s" }, sessionToken: { sub } }, ENV_OWNERS);
      expect(owner.isOwner).toBe(true);
      expect(owner.userId).toBe(sub);
    }
    // the guard is the FIRST thing the loader does after authentication
    const s = src();
    const loader = s.slice(s.indexOf("export async function loader("), s.indexOf("export async function loader(") + 400);
    expect(loader).toMatch(/const auth = await authenticate\.admin\(request\);\s+\/\/ Owner only[^\n]*\n\s+requireOwner\(auth\);/);
  });

  it("2. a non-owner cannot open it — the REAL loader returns 403 before computing anything", async () => {
    process.env[OWNER_USER_IDS_ENV] = "9001";
    authState.sessionToken = { sub: "1234" };
    const { loader } = await import("../app/routes/app.erp.cost-calculator");
    const thrown = await loader({ request: new Request("https://app.test/app/erp/cost-calculator?pfamily=banners&pqty=2") }).then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    const body = await (thrown as Response).text();
    expect(body).toContain(COST_PRICING_OWNER_ONLY_MESSAGE);
    expect(body).not.toMatch(/\$|cost:|margin|profit/i);
    // the route renders a plain owner-only notice for 403
    expect(src()).toContain('if (isRouteErrorResponse(error) && error.status === 403) {');
    // and the nav hides the link for staff
    const nav = src("app/routes/app.tsx");
    expect(nav).toContain('{isOwner ? <s-link href="/app/erp/cost-calculator">Sales · Cost Calculator</s-link> : null}');
    expect(nav).toContain("isOwner: resolveOwnerAuthorization(auth).isOwner,");
  }, 60_000); // first import of the large route module is slow

  it("3. no owner configured -> fails closed, even for a verified staff identity", async () => {
    expect(() => requireOwner({ session: { shop: "s" }, sessionToken: { sub: "9001" } }, {})).toThrow();
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: { sub: "9001" } }, { [OWNER_USER_IDS_ENV]: " , " }).isOwner).toBe(false);
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: { sub: "9001" } }, {}).reason).toContain("denied by default");
    authState.sessionToken = { sub: "9001" }; // even the "real" owner, with nothing configured
    const { loader } = await import("../app/routes/app.erp.cost-calculator");
    const thrown = await loader({ request: new Request("https://app.test/app/erp/cost-calculator") }).then(() => null, (error: unknown) => error);
    expect((thrown as Response).status).toBe(403);
    // no browser-controlled flag: ownership is never read from the request body / query
    expect(src("app/lib/owner-authorization.server.ts")).not.toMatch(/formData|searchParams|payload|request\.json/);
  }, 60_000);

  it("4. a non-owner cannot submit the calculator directly — the REAL action returns 403 before reading the form", async () => {
    process.env[OWNER_USER_IDS_ENV] = "9001";
    const { action } = await import("../app/routes/app.erp.cost-calculator");
    const form = new FormData();
    form.set("intent", "saveEmergencyQuoteDraft");
    const thrown = await action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body: form }) }).then(() => null, (error: unknown) => error);
    expect((thrown as Response).status).toBe(403);
    const s = src();
    const action_ = s.slice(s.indexOf("export async function action("), s.indexOf("export async function action(") + 400);
    expect(action_.indexOf("requireOwner(auth);")).toBeLessThan(action_.indexOf("await request.formData()"));
  }, 60_000);

  it("5. a non-owner cannot see or use Owner Set Price & Approve", async () => {
    const harness = recordingDb(dbQuote([dbItem()]));
    const refused = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "65", reason: "x", owner: STAFF });
    expect(refused.ok).toBe(false);
    expect(harness.calls).toEqual([]);
    const q = src(QUOTES);
    expect(q).toContain("{ownerAccess.isOwner && !isPaid ? (");
    expect(q).toContain('if (payload.intent === "ownerSetPriceApprove") {\n    const owner = resolveOwnerAuthorization({ session, sessionToken });');
  });
});

describe("provisional zero placeholder (tests 6-9)", () => {
  it("6. the provisional line stores the schema-required placeholder, with the authority as the source of truth", () => {
    const s = src();
    expect(s).toContain("unitPrice: customerUnitPrice ?? 0,"); // NOT NULL column (no migration this release)
    expect(s).toContain("customerUnitPrice: null,\n        customerTotalPrice: null,");
    const item = dbItem();
    expect(item.unitPrice).toBe(0);
    expect(itemPricingAuthority(item)).toMatchObject({ approved: false, customerUnitPrice: null, customerTotalPrice: null });
    expect(JSON.parse(item.priceSnapshot).unitPrice).toBeNull();
    expect(src("prisma/schema.prisma")).toMatch(/model QuoteItem \{[\s\S]*?unitPrice\s+Float\r?\n/); // schema unchanged
  });

  it("7. the placeholder never appears as a real customer price", () => {
    const quote = dbQuote([dbItem()]);
    // editor: blank; card: Price not available; portal: Pricing in progress
    const q = src(QUOTES);
    expect(q).toContain('unitPrice: itemPricingAuthority(item)?.approved === false ? "" : String(item.unitPrice || 0),');
    expect(q).toContain('{quote.pricingAuthorityState?.provisional ? "Price not available" : `$${quoteRevenue.toFixed(2)}`}');
    const portal = src("app/routes/quote.$id.tsx");
    expect(portal).toContain("items: items.map((item) => ({ ...item, unitPrice: null, lineTotal: null })) },");
    expect(portal).toContain('{pricingPending ? "Pricing in progress" : `$${Number(total || 0).toFixed(2)}`}');
    // margin checks skip it (not a $0 "invalid price" sale)
    const margin = quoteMarginState(quote);
    expect(margin.lowItems).toEqual([]);
    expect(margin.isLowMargin).toBe(false);
    // pricing intelligence already excludes non-positive unit prices from evidence
    expect(src("app/lib/pricing-intelligence.server.ts")).toContain('if (record.unitPrice != null && !(Number(record.unitPrice) > 0)) reasons.push("non-positive unit price");');
    // only an owner approval turns it into a price
    expect(quotePricingAuthorityState(quote).provisional).toBe(true);
  });

  it("8. the placeholder cannot be sent, approved, invoiced or ordered", () => {
    const quote = dbQuote([dbItem()]);
    for (const next of ["sent", "approved", "won", "deposit_paid", "paid"]) expect(provisionalQuoteStatusCheck(quote, next).ok, next).toBe(false);
    const q = src(QUOTES);
    for (const intent of ["approveCreateOrder", "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail"]) {
      expect(q, intent).toContain(`return Response.json({ intent: "${intent}", ok: false, error: pricingAuthorityState.blockMessage });`);
    }
  });

  it("9. the placeholder cannot go to production", () => {
    for (const status of ["paid", "production"]) {
      const result = quoteConversionEligibility(dbQuote([dbItem()], { status }), "shop-1");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(PROVISIONAL_PRICING_STATUS);
    }
  });
});

describe("owner price approval also satisfies low-margin approval (tests 10-13)", () => {
  it("10. an owner-approved price below target needs no second low-margin approval for that line", async () => {
    const { state } = await approveAt("30"); // cost 21.50 -> 28.3% margin < 40% target
    const margin = quoteMarginState(state.quote);
    expect(margin.isLowMargin).toBe(false);
    expect(margin.approvalRequired).toBe(false);
    expect(margin.ownerApprovedLowMargin).toHaveLength(1);
    expect(margin.ownerApprovedLowMargin[0].reason).toContain(LOW_MARGIN_OWNER_OVERRIDE_NOTE);
    expect(provisionalQuoteStatusCheck(state.quote, "approved")).toEqual({ ok: true });
    expect(quoteConversionEligibility({ ...state.quote, status: "paid" }, "shop-1")).toEqual({ ok: true, reason: "" });
    // the same low price WITHOUT an owner approval still needs approval (no global change)
    const unapproved = quoteMarginState(dbQuote([{ ...state.quote.items[0], priceSnapshot: JSON.stringify({ unitPrice: 30 }) }]));
    expect(unapproved.approvalRequired).toBe(true);
  });

  it("11. the approval records true cost, profit, margin and the low-margin override when applicable", async () => {
    const { state, result } = await approveAt("30");
    const approval = itemPricingAuthority(state.quote.items[0])!.ownerApproval!;
    expect(approval).toMatchObject({ approvedBy: "owner@gso.test", approvedAt: "2026-10-19T16:00:00.000Z", reason: "Intentional launch price", approvedUnitPrice: 30, approvedTotalPrice: 60, trueTotalCost: 43, expectedProfit: 17, expectedMarginPct: 28.3 });
    expect(approval.lowMarginOverride).toMatchObject({ applied: true, thresholdPct: 40, marginPct: 28.3 });
    expect(result).toMatchObject({ ok: true, lowMarginOverride: true });
    expect((result as any).message).toContain("WARNING:");
    expect(state.quote.notes).toContain("also recorded as this line's LOW-MARGIN OVERRIDE");
    expect(state.quote.notes).not.toMatch(/true cost \$|expected profit|\d+\.\d%/i); // financials stay in the owner-only record
    // above target: recorded as not needed
    const healthy = await approveAt("65");
    expect(itemPricingAuthority(healthy.state.quote.items[0])!.ownerApproval!.lowMarginOverride).toMatchObject({ applied: false, thresholdPct: 40 });
    expect(healthy.result).toMatchObject({ lowMarginOverride: false });
  });

  it("12. a non-owner cannot grant low-margin approval (neither route)", async () => {
    const harness = recordingDb(dbQuote([dbItem()]));
    expect((await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "30", reason: "x", owner: STAFF })).ok).toBe(false);
    const q = src(QUOTES);
    const block = q.slice(q.indexOf('if (payload.intent === "approveLowMarginQuote") {'), q.indexOf('if (payload.intent === "approveLowMarginQuote") {') + 700);
    expect(block).toContain("const lowMarginOwner = resolveOwnerAuthorization({ session, sessionToken });");
    expect(block.indexOf("if (!lowMarginOwner.isOwner)")).toBeLessThan(block.indexOf("db.quote.findFirst"));
    expect(q).toContain("{quote.marginState?.approvalRequired && ownerAccess.isOwner ? (");
  });

  it("13. a material commercial change resets BOTH approvals", async () => {
    const { state } = await approveAt("30");
    const cases: Array<[string, (copy: any) => any, string]> = [
      ["quantity", (copy) => ({ ...copy, quantity: "3" }), "standard"],
      ["product", (copy) => ({ ...copy, productName: "Banner 48x60" }), "standard"],
      ["options", (copy) => ({ ...copy, selectedFinish: "gloss" }), "standard"],
      ["configuration", (copy) => ({ ...copy, costSnapshot: copy.costSnapshot.replace("13oz vinyl", "18oz blockout") }), "standard"],
      ["price", (copy) => ({ ...copy, unitPrice: "29" }), "standard"],
      ["discount", (copy) => copy, "wholesale"],
    ];
    for (const [group, mutate, tier] of cases) {
      const out = reconcileQuoteItemPricingAuthority(state.quote.items, [mutate(editorCopy(state.quote.items[0]))], { customerTier: tier, customerTierLabel: null }, "staff", "t");
      const record = itemPricingAuthority(out.items[0])!;
      expect(record.approved, group).toBe(false); // price approval reset (provisional again)
      expect(record.ownerApproval, group).toBeNull(); // the low-margin override lived inside it — gone too
      expect(record.approvalReset!.previousApproval.lowMarginOverride!.applied, group).toBe(true); // audit kept
      expect(out.resets[0].changed, group).toContain(group);
    }
    // a change made by any other write path: the gates re-check, and the low-margin cover is void
    const tampered = dbQuote([{ ...state.quote.items[0], quantity: 3 }]);
    expect(ownerApprovalCoversLine(tampered.items[0], tampered)).toBe(false);
    expect(quotePricingAuthorityState(tampered).provisional).toBe(true);
    expect(quoteMarginState(tampered).approvalRequired).toBe(true);
  });
});

describe("unchanged (tests 14-17)", () => {
  it("14. global pricing / margin rules are unchanged; the approval touches only this quote line", async () => {
    expect(LOW_MARGIN_THRESHOLD_PCT).toBe(40);
    expect(tierRule("standard").marginFloorPct).toBe(40);
    const { calls } = await approveAt("30");
    expect(calls).toEqual(["quote.findFirst", "quoteItem.updateMany", "quote.updateMany"]);
    for (const lib of ["app/lib/customer-tiers.ts", "app/lib/commercial-pricing-policy.server.ts", "app/lib/jar-commercial-pricing.ts", "app/lib/dtp-owner-pricing.server.ts", "app/lib/storefront-canonical-pricing.server.ts"]) {
      expect(src(lib), lib).not.toContain("2026-10-19");
    }
  });

  it("15. the Stock Bag storefront-authority exemption is unchanged", () => {
    const item = (unitPrice: number) => ({
      productName: "4x5 Stock Bag", quantity: 50, unitPrice, unitCost: 2,
      priceSnapshot: JSON.stringify({ pricingAuthority: { approved: true, kind: "storefront_stock_bag", status: "APPROVED", source: "storefront", missing: null, approvedUnitPrice: 2.7, approvedTotalPrice: 135, approvedQuantity: 50 } }),
    });
    expect(storefrontAuthorityExempt(item(2.7))).toBe(true);
    const exact = quoteMarginState({ items: [item(2.7)] });
    expect(exact.approvalRequired).toBe(false);
    expect(exact.approvedPriceWarnings).toHaveLength(1);
    expect(exact.ownerApprovedLowMargin).toEqual([]); // no manual low-margin override involved
    expect(quoteMarginState({ items: [item(2.5)] }).approvalRequired).toBe(true);
  });

  it("16. cost formulas unchanged", () => {
    for (const lib of [
      "app/lib/canonical-calculator.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/banner-cost-inputs.server.ts",
      "app/lib/label-cost-inputs.server.ts", "app/lib/jar-cost-inputs.server.ts", "app/lib/true-cost-engine.server.ts", "app/lib/canonical-bag-pricing.server.ts",
    ]) expect(src(lib), lib).not.toContain("2026-10-19");
  });

  it("17. pricing formulas unchanged", () => {
    for (const lib of ["app/lib/commercial-pricing-policy.server.ts", "app/lib/storefront-canonical-pricing.server.ts", "app/lib/jar-commercial-pricing.ts", "app/lib/dtp-owner-pricing.server.ts"]) {
      expect(src(lib), lib).not.toContain("2026-10-19");
    }
  });
});
