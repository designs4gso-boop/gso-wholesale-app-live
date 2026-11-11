// 2026-10-19 — Cost & Pricing Calculator owner decisions, ROUND 2 (sign-off).
//
//   1. Banners: true cost calculates; selling price PROVISIONAL / Not available.
//   2. Miron outside the owner 16D ladder: PROVISIONAL.
//   3. Manual / Legacy saves without authority: PROVISIONAL, no customer price.
//   4. OWNER SET PRICE & APPROVE: owner-only, server-authorized, audited,
//      bound to the item's commercial fields (any change resets it).
//   5. The exact Stock Bag storefront price is an approved authority: the
//      generic margin floor warns, it does not block — a changed price loses it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  APPROVED_MARGIN_CURVE_AUTHORITIES,
  PROVISIONAL_PRICING_STATUS,
  UNAPPROVED_MARGIN_CURVES,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
} from "../app/lib/calculator-owner-view";
import {
  OWNER_APPROVED_PRICING_STATUS,
  OWNER_QUOTE_PRICE_KIND,
  STOREFRONT_BELOW_TARGET_WARNING,
  itemPricingAuthority,
  provisionalQuoteStatusCheck,
  quotePricingAuthorityState,
  reconcileQuoteItemPricingAuthority,
  resolveOwnerSetPrice,
  storefrontAuthorityExempt,
} from "../app/lib/quote-pricing-authority";
import { OWNER_USER_IDS_ENV, resolveOwnerAuthorization, type OwnerAuthorization } from "../app/lib/owner-authorization.server";
import { OWNER_PRICE_APPROVAL_MARKER, ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { quoteMarginState } from "../app/lib/quote-margin.server";
import { quoteConversionEligibility } from "../app/lib/production-job-source.server";
import { assembleCanonicalJob, canonicalViewOf, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { resolveCanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";
import { priceStockBagTierRow, stockBagStorefrontSelection } from "../app/lib/stock-bag-quote-pricing.server";
import { BAG_4X5_BLANK_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { marginFamilyKeyFor } from "../app/lib/product-driven-costing.server";
import { DTP_LADDER_QUANTITIES, dtpLadderSource, ownerPriceForQuantity } from "../app/lib/dtp-owner-pricing.server";
import { resolveCanonicalMachineRouting } from "../app/lib/machine-routing.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const QUOTES = "app/routes/app.quotes.tsx";
const src = (path = ROUTE) => readFileSync(path, "utf8");

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test",
    machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};
const view = (qs: string) => {
  const input = normalizeCanonicalInput(new URLSearchParams(qs));
  expect(input, `query did not normalise: ${qs}`).not.toBeNull();
  return canonicalViewOf(assembleCanonicalJob(input!, CAL));
};
const BANNER_QS = "pfamily=banners&pprinter=mimaki&pqty=2&pwidth=36&pheight=60&pbannerw=36&pbannerh=60&pbannersides=SINGLE&pbanneredge=TRIM_ONLY&pbannergrommets=NONE&pdesigns=1";
const JAR_QS = (family: string, jar: string, qty = 500) => `pfamily=${family}&pjarmat=matte&pprinter=mimaki&pqty=${qty}&pjar=${jar}&pjarside=1&pjarlid=1&pcmykcoverage=40`;

/** Read-only shop data for the real Stock Bag storefront resolver. */
function fakeShopDb() {
  const rows: Record<string, any> = {
    material: [
      { id: "m1", name: "Poseidon Matte", calculatedUnitCost: 213 / 675, baseUnit: "sqft", active: true, useInRecipes: true },
      { id: "m2", name: "Holographic", calculatedUnitCost: 0.7141463415, baseUnit: "sqft", active: true, useInRecipes: true },
    ],
    vendorProduct: [
      { id: "v1", name: "4x5 Sticker Bag Blank (Safe Care)", productType: "bag", vendor: "Safe Care", vendorSku: "4x5-blank", defaultUnitCost: BAG_4X5_BLANK_UNIT_COST, tiers: [] },
    ],
  };
  return new Proxy({}, {
    get: (_target, model: string) => ({
      findMany: async () => rows[model] ?? [],
      findFirst: async () => (model === "machine" ? { sqftPerHour: 150 } : null),
      findUnique: async () => null,
    }),
  }) as any;
}

const costedRow = (overrides: Record<string, unknown> = {}) => ({
  quantity: 50, requested: true, jobCost: 60, unitCost: 1.2, unitPrice: 3.1, totalPrice: 155, profit: 95, actualMarginPct: 61.3, marginPct: 61.3,
  belowFloor: false, draftOnly: false, freightTotal: 0, floorPct: 45, blockers: [], status: "READY TO QUOTE",
  commercial: { controllingRule: "curve", marginSource: "researched curve", ownerLadder: null },
  ...overrides,
});
const validCanonical = { status: "VALID", totalCost: 60, unitCost: 1.2, blockers: [] as string[] };

/* ---- quote fixtures: the exact shapes the calculator save writes ---- */
const provisionalRecord = (missing: string, kind = "none") => ({
  approved: false, status: PROVISIONAL_PRICING_STATUS, kind, source: null, missing,
  customerUnitPrice: null, customerTotalPrice: null,
  diagnosticReference: { unitPrice: 7.5, totalPrice: 15, basis: "unsourced family default" },
});
const dbItem = (overrides: Record<string, any> = {}, record: any = provisionalRecord(UNAPPROVED_MARGIN_CURVES.banners)) => ({
  id: "item_1", quoteId: "q_1", productName: "Banner 36x60", variant: null, sku: null, quantity: 2,
  unitPrice: 0, unitCost: 21.5, notes: null, recipeId: null, recipeName: null, selectedFinish: null, selectedAddOnIds: "",
  pricingSource: null, tierLabel: null, minQuantity: null, marginPct: null,
  costSnapshot: JSON.stringify({ canonical: { family: "banners", input: { widthIn: 36, heightIn: 60, sides: "SINGLE", material: "13oz vinyl" } } }),
  priceSnapshot: JSON.stringify({ unitPrice: null, marginPct: null, pricingAuthority: record }),
  ...overrides,
});
const dbQuote = (items: any[], overrides: Record<string, any> = {}) => ({
  id: "q_1", shop: "shop-1", status: "draft", notes: "14C.2 product calculator draft", customerTier: "standard", customerTierLabel: null, items, ...overrides,
});

/** A DB double that records every call; refuses any model other than Quote / QuoteItem. */
function recordingDb(quote: any) {
  const calls: string[] = [];
  const state = { quote: JSON.parse(JSON.stringify(quote)) };
  const db: any = {
    quote: {
      findFirst: async (args: any) => { calls.push("quote.findFirst"); return args.where.id === state.quote.id && args.where.shop === state.quote.shop ? state.quote : null; },
      updateMany: async (args: any) => { calls.push("quote.updateMany"); Object.assign(state.quote, args.data); return { count: 1 }; },
    },
    quoteItem: {
      updateMany: async (args: any) => {
        calls.push("quoteItem.updateMany");
        const item = state.quote.items.find((row: any) => row.id === args.where.id);
        Object.assign(item, args.data);
        return { count: 1 };
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return {
    calls,
    state,
    db: new Proxy(db, {
      get: (target, key: string) => {
        if (key in target) return target[key];
        throw new Error(`owner approval touched a forbidden model: ${key}`);
      },
    }),
  };
}
const OWNER: OwnerAuthorization = { isOwner: true, userId: "9001", actor: "owner@gso.test", reason: "Configured owner" };
const STAFF: OwnerAuthorization = { isOwner: false, userId: "1234", actor: "staff@gso.test", reason: "Owner-only action: you are not the configured owner." };

/** The Quotes editor's re-posted copy of a DB item (normalizeQuote parity: strings, defaults). */
const editorCopy = (item: any) => ({
  id: item.id, productName: item.productName || "", variant: item.variant || "", sku: item.sku || "",
  quantity: String(item.quantity || 1), unitPrice: String(item.unitPrice || 0), unitCost: String(item.unitCost || 0), notes: item.notes || "",
  recipeId: item.recipeId || "", recipeName: item.recipeName || "", selectedFinish: item.selectedFinish || "base",
  selectedAddOnIds: String(item.selectedAddOnIds || "").split(",").filter(Boolean),
  pricingSource: item.pricingSource || (item.recipeId ? "recipe" : "manual"), tierLabel: item.tierLabel || "",
  minQuantity: item.minQuantity != null ? String(item.minQuantity) : "", marginPct: item.marginPct != null ? String(item.marginPct) : "",
  costSnapshot: item.costSnapshot || "", priceSnapshot: item.priceSnapshot || "",
});

async function approvedBannerQuote() {
  const harness = recordingDb(dbQuote([dbItem()]));
  const result = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "65", reason: "Owner quote for repeat customer", owner: OWNER, now: new Date("2026-10-19T15:00:00Z") });
  expect(result.ok).toBe(true);
  return harness;
}

/* ================================================================== */

describe("1. Banners — true cost yes, selling price PROVISIONAL (tests 1-4)", () => {
  it("1. banner true cost calculates through the existing canonical banner engine", () => {
    const banner = view(BANNER_QS);
    expect(banner.status).not.toBe("DRAFT_ONLY");
    expect(banner.unitCost).not.toBeNull();
    expect(banner.totalCost).toBeGreaterThan(0);
  });

  it("2. banner selling price is Not available — pricing authority required (the unsourced curve is not promoted)", () => {
    const banner = view(BANNER_QS);
    expect(marginFamilyKeyFor("banners", null, "")).toBe("banners");
    expect(APPROVED_MARGIN_CURVE_AUTHORITIES.banners).toBeUndefined();
    const result = resolveOwnerResult({
      family: "banners", canonical: { status: banner.status, totalCost: banner.totalCost, unitCost: banner.unitCost, blockers: banner.blockers },
      requestedRow: costedRow({ quantity: 2, jobCost: banner.totalCost, unitCost: banner.unitCost }), multiLine: null, marginRuleKey: "banners",
    })!;
    expect(result.state).toBe("PRICE_NOT_AVAILABLE");
    expect(result.badge).toBe(PROVISIONAL_PRICING_STATUS);
    expect(result.trueJobCost).toBe(banner.totalCost);
    expect([result.recommendedTotal, result.recommendedUnit, result.profit, result.marginPct]).toEqual([null, null, null, null]);
    expect(result.missingAuthority).toContain("Banners margin curve is an unsourced family default");
    const s = src();
    expect(s).toContain('result.state === "PRICE_NOT_AVAILABLE" ? "Pricing authority required" : null');
    // banner finishing blockers / rates are unchanged — hemming still fails closed
    expect(view(BANNER_QS.replace("TRIM_ONLY", "HEMMED")).blockers.join(" ")).toContain("BANNER_FINISHING_RATE_REQUIRED");
  });

  it("3. a banner provisional draft can save (no margin gate on a price that does not exist)", () => {
    const s = src();
    expect(s).toContain("const gate: { allowed: boolean; belowFloor: boolean; reason: string | null } = !savedPriceAuthority.approved\n    ? { allowed: true, belowFloor: false, reason: null }");
    expect(s).toContain('shop, status: "draft",');
    expect(provisionalQuoteStatusCheck(dbQuote([dbItem()]), "draft")).toEqual({ ok: true });
  });

  it("4. a banner provisional quote cannot be sent, approved or produced (server checks)", () => {
    const quote = dbQuote([dbItem()]);
    for (const next of ["sent", "approved", "won", "deposit_paid", "paid", "production"]) {
      expect(provisionalQuoteStatusCheck(quote, next).ok, next).toBe(false);
    }
    expect(quoteConversionEligibility({ ...quote, status: "paid" }, "shop-1").reason).toContain(PROVISIONAL_PRICING_STATUS);
    expect(quotePricingAuthorityState(quote).blockMessage).toContain("Owner Set Price & Approve");
  });
});

describe("2. Miron inside vs outside the owner ladder (tests 5-6)", () => {
  it("5. Miron inside the approved 16D ladder stays approved and quoteable", () => {
    const ladder = resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 100 });
    expect(ladder.ok && ladder.quote.unitPrice).toBe(4.5);
    const authority = resolveSellingPriceAuthority({
      family: "premium-jars", stockBag: false, marginRuleKey: "miron-jars",
      row: costedRow({ commercial: { controllingRule: "owner ladder", marginSource: "owner ladder", ownerLadder: { unitPrice: 4.5, raisedByFloor: false } } }),
    });
    expect(authority).toMatchObject({ approved: true, kind: "owner_jar_ladder" });
  });

  it("6. Miron outside the ladder (below 50, volume 2,500+) is PROVISIONAL — true cost still calculates", () => {
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 25 }).ok).toBe(false);
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 5000 }).ok).toBe(false);
    const miron = view(JAR_QS("premium-jars", "miron/100ml_wide", 25));
    const result = resolveOwnerResult({
      family: "premium-jars", canonical: { status: miron.status, totalCost: miron.totalCost, unitCost: miron.unitCost, blockers: miron.blockers },
      requestedRow: costedRow({ quantity: 25, jobCost: miron.totalCost, unitCost: miron.unitCost, commercial: { controllingRule: "miron curve", marginSource: "Miron researched curve", ownerLadder: null } }),
      multiLine: null, marginRuleKey: "miron-jars",
    })!;
    expect(result.state).toBe("PRICE_NOT_AVAILABLE");
    expect(result.recommendedTotal).toBeNull();
    expect(result.missingAuthority).toContain("outside the owner 16D price ladder");
  });
});

describe("3. Manual / Legacy saves (test 7)", () => {
  it("7. no-authority draft saves with NO customer price — never $0, never the generic fallback", () => {
    const s = src();
    expect(s).toContain(': { approved: false, kind: "none" as const, label: null, missing: "Manual / unsupported job — no approved selling-price rule.", ownerMarginEdit: false };');
    expect(s).toContain("customerUnitPrice: null,\n        customerTotalPrice: null,");
    expect(s).toContain("unitPrice: customerUnitPrice, marginPct: savedPriceAuthority.approved ? primary.marginPct : null,");
    expect(s).toContain("recommendedUnitPrice: customerUnitPrice, recommendedTotalPrice: customerTotalPrice,");
    const item = dbItem({ productName: "Manual job", unitCost: 3 }, provisionalRecord("Manual / unsupported job — no approved selling-price rule."));
    const record = itemPricingAuthority(item)!;
    expect(record.customerUnitPrice).toBeNull();
    expect(record.customerTotalPrice).toBeNull();
    expect(JSON.parse(item.priceSnapshot).unitPrice).toBeNull();
    // no reader treats the item as a $0 sale
    const margin = quoteMarginState(dbQuote([item]));
    expect(margin.isLowMargin).toBe(false);
    expect(margin.lowItems).toEqual([]);
    const q = src(QUOTES);
    expect(q).toContain('unitPrice: itemPricingAuthority(item)?.approved === false ? "" : String(item.unitPrice || 0),');
    expect(q).toContain('{quote.pricingAuthorityState?.provisional ? "Price not available" : `$${quoteRevenue.toFixed(2)}`}');
    const portal = src("app/routes/quote.$id.tsx");
    expect(portal).toContain("const pricingPending = quotePricingAuthorityState(authorityQuote).provisional;");
    expect(portal).toContain("items: items.map((item) => ({ ...item, unitPrice: null, lineTotal: null })) },");
  });
});

describe("4. OWNER SET PRICE & APPROVE (tests 8-16)", () => {
  it("8. the owner can set a price on a provisional item — a reason is required", async () => {
    const harness = recordingDb(dbQuote([dbItem()]));
    const noReason = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "65", reason: "  ", owner: OWNER });
    expect(noReason).toEqual({ ok: false, error: "A reason / note is required to set and approve a quote price." });
    expect(harness.calls).not.toContain("quoteItem.updateMany");
    const ok = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", totalPrice: "130", reason: "Repeat customer", owner: OWNER });
    expect(ok).toMatchObject({ ok: true, unitPrice: 65, totalPrice: 130 });
    expect(harness.state.quote.items[0].unitPrice).toBe(65);
    // unit OR total, in the existing unit-price x quantity model
    expect(resolveOwnerSetPrice({ unitPrice: "1", totalPrice: "2", reason: "r", quantity: 2 }).ok).toBe(false);
    expect(resolveOwnerSetPrice({ totalPrice: "100", reason: "r", quantity: 3 }).ok).toBe(false); // $33.333… is not exact
    expect(resolveOwnerSetPrice({ unitPrice: "0", reason: "r", quantity: 3 }).ok).toBe(false);
  });

  it("9. a non-owner cannot use it — refused before any read or write; identity is the verified session token", async () => {
    const harness = recordingDb(dbQuote([dbItem()]));
    const refused = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "65", reason: "x", owner: STAFF });
    expect(refused.ok).toBe(false);
    expect(harness.calls).toEqual([]);
    // fail closed: no configured owner = nobody is the owner
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: { sub: "9001" } }, {}).isOwner).toBe(false);
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: { sub: "1234" } }, { [OWNER_USER_IDS_ENV]: "9001" }).isOwner).toBe(false);
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: { sub: "9001" } }, { [OWNER_USER_IDS_ENV]: "9001, 9002" }).isOwner).toBe(true);
    expect(resolveOwnerAuthorization({ session: { shop: "s" }, sessionToken: null }, { [OWNER_USER_IDS_ENV]: "9001" }).isOwner).toBe(false);
    // offline sessions never claim account ownership
    expect(resolveOwnerAuthorization({ session: { shop: "s", isOnline: false, accountOwner: true } }, {}).isOwner).toBe(false);
    const q = src(QUOTES);
    expect(q).toContain('if (payload.intent === "ownerSetPriceApprove") {\n    const owner = resolveOwnerAuthorization({ session, sessionToken });');
    expect(q).toContain("{ownerAccess.isOwner && !isPaid ? (");
  });

  it("10. the approval records approver, time, reason and the exact price — true cost kept independently", async () => {
    const { state } = await approvedBannerQuote();
    const item = state.quote.items[0];
    const record = itemPricingAuthority(item)!;
    expect(record).toMatchObject({ approved: true, kind: OWNER_QUOTE_PRICE_KIND, status: OWNER_APPROVED_PRICING_STATUS, approvedUnitPrice: 65, approvedTotalPrice: 130, approvedQuantity: 2 });
    expect(record.ownerApproval).toMatchObject({
      approvedBy: "owner@gso.test", approvedAt: "2026-10-19T15:00:00.000Z", reason: "Owner quote for repeat customer",
      approvedUnitPrice: 65, approvedTotalPrice: 130, quantity: 2, trueUnitCost: 21.5, trueTotalCost: 43, expectedProfit: 87, expectedMarginPct: 66.9,
    });
    expect(record.ownerApproval!.provisionalBasis.missing).toContain("Banners margin curve");
    expect(record.history!.at(-1)).toMatchObject({ event: "owner_approved", by: "owner@gso.test" });
    expect(item.unitCost).toBe(21.5); // true cost untouched
    expect(item.marginPct).toBe(66.9);
    expect(state.quote.notes).toContain(`${OWNER_PRICE_APPROVAL_MARKER}owner@gso.test at 2026-10-19T15:00:00.000Z: Banner 36x60 × 2 @ $65.00/unit ($130.00)`);
    expect(state.quote.notes).toContain("Reason: Owner quote for repeat customer");
  });

  it("11. owner approval writes only this quote item + its audit line — no global pricing rule or ladder", async () => {
    const { calls } = await approvedBannerQuote();
    expect(calls).toEqual(["quote.findFirst", "quoteItem.updateMany", "quote.updateMany"]);
    const lib = src("app/lib/quote-owner-price-approval.server.ts");
    expect(lib).not.toMatch(/pricingRule|ownerConfig|tierLadder|recipeTier|wholesaleRule|productCost/i);
    // a second approval of an already-approved item is refused
    const harness = await approvedBannerQuote();
    const again = await ownerSetQuoteItemPrice(harness.db, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "70", reason: "x", owner: OWNER });
    expect(again).toEqual({ ok: false, error: "This item already has an owner-approved price." });
  });

  it("12. once approved, the quote may be sent, approved, paid and moved to production", async () => {
    const { state } = await approvedBannerQuote();
    for (const next of ["sent", "approved", "won", "deposit_paid", "paid", "production"]) {
      expect(provisionalQuoteStatusCheck(state.quote, next), next).toEqual({ ok: true });
    }
    expect(quotePricingAuthorityState(state.quote).provisional).toBe(false);
    expect(quoteConversionEligibility({ ...state.quote, status: "paid" }, "shop-1")).toEqual({ ok: true, reason: "" });
    expect(quoteMarginState(state.quote).approvalRequired).toBe(false); // 66.9% — normal margin protections satisfied
    // an unchanged editor save keeps the approval (editor string round-trip parity)
    const kept = reconcileQuoteItemPricingAuthority(state.quote.items, [editorCopy(state.quote.items[0])], state.quote, "staff", "t");
    expect(kept.resets).toEqual([]);
    expect(itemPricingAuthority(kept.items[0])!.approved).toBe(true);
  });

  const resetCase = async (mutate: (copy: any) => any, tier = "standard") => {
    const { state } = await approvedBannerQuote();
    const posted = mutate(editorCopy(state.quote.items[0]));
    const out = reconcileQuoteItemPricingAuthority(state.quote.items, [posted], { customerTier: tier, customerTierLabel: null }, "staff@gso.test", "2026-10-20T00:00:00Z");
    const record = itemPricingAuthority(out.items[0])!;
    expect(record.approved).toBe(false);
    expect(record.status).toBe(PROVISIONAL_PRICING_STATUS);
    expect(record.approvalReset!.previousApproval.approvedUnitPrice).toBe(65); // audit kept
    expect(record.history!.map((entry) => entry.event)).toEqual(["owner_approved", "owner_approval_reset"]);
    expect(provisionalQuoteStatusCheck({ items: out.items }, "sent").ok).toBe(false);
    return out.resets[0].changed;
  };

  it("13. a material / configuration change resets the approval", async () => {
    const changed = await resetCase((copy) => ({ ...copy, costSnapshot: copy.costSnapshot.replace("13oz vinyl", "18oz blockout") }));
    expect(changed).toContain("configuration");
    const sides = await resetCase((copy) => ({ ...copy, costSnapshot: copy.costSnapshot.replace('"SINGLE"', '"DOUBLE"') }));
    expect(sides).toContain("configuration");
    const dims = await resetCase((copy) => ({ ...copy, costSnapshot: copy.costSnapshot.replace('"widthIn":36', '"widthIn":48') }));
    expect(dims).toContain("configuration");
  });

  it("14. a quantity change resets the approval", async () => {
    expect(await resetCase((copy) => ({ ...copy, quantity: "3" }))).toEqual(["quantity"]);
  });

  it("15. a customer price or discount (customer tier) change resets the approval", async () => {
    expect(await resetCase((copy) => ({ ...copy, unitPrice: "60" }))).toEqual(["price"]);
    expect(await resetCase((copy) => copy, "wholesale")).toEqual(["discount"]);
  });

  it("16. a product / option change resets the approval — and a stale approval is caught at every gate", async () => {
    expect(await resetCase((copy) => ({ ...copy, productName: "Banner 48x60" }))).toEqual(["product"]);
    expect(await resetCase((copy) => ({ ...copy, selectedFinish: "gloss" }))).toEqual(["options"]);
    expect(await resetCase((copy) => ({ ...copy, selectedAddOnIds: ["grommets"] }))).toEqual(["options"]);
    // any OTHER write path that changes the row: the gates re-check the fingerprint
    const { state } = await approvedBannerQuote();
    const tampered = { ...state.quote, items: [{ ...state.quote.items[0], quantity: 10 }] };
    const gate = quotePricingAuthorityState(tampered);
    expect(gate.provisional).toBe(true);
    expect(gate.staleApprovals).toEqual(["Banner 36x60"]);
    expect(quoteConversionEligibility({ ...tampered, status: "paid" }, "shop-1").ok).toBe(false);
    // browser-posted approvals are never trusted
    const forged = reconcileQuoteItemPricingAuthority([], [{ id: "new", productName: "x", priceSnapshot: JSON.stringify({ pricingAuthority: { approved: true, kind: OWNER_QUOTE_PRICE_KIND } }) }], null, "s", "t");
    expect(itemPricingAuthority(forged.items[0])!.approved).toBe(false);
    // the save path uses the DB-trusted reconcile
    expect(src(QUOTES)).toContain("const reconciled = reconcileQuoteItemPricingAuthority(existingItemsForAuthority, costProtectedItems, { customerTier, customerTierLabel }, authorityActor, authorityAt);");
  });
});

describe("5. Stock Bag storefront price vs the generic margin floor (tests 17-21)", () => {
  const stockBagRow = async (jobCost: number) => {
    const inputs = await resolveCanonicalBagInputs(fakeShopDb(), "test-shop");
    const selection = stockBagStorefrontSelection({ faces: "2", materialName: "Poseidon Matte", glossLayers: "0" });
    return priceStockBagTierRow<Record<string, any>>(costedRow({ jobCost, unitCost: jobCost / 50 }), inputs, selection);
  };
  const stockBagItem = (unitPrice: number, quantity = 50) => ({
    productName: "4x5 Stock Bag", quantity, unitPrice, unitCost: 2,
    priceSnapshot: JSON.stringify({ pricingAuthority: { approved: true, status: "APPROVED", kind: "storefront_stock_bag", source: "storefront", missing: null, approvedUnitPrice: 2.7, approvedTotalPrice: 135, approvedQuantity: 50 } }),
  });

  it("17. the exact storefront price bypasses the generic 45% blocking gate", async () => {
    const row = await stockBagRow(100); // margin 25.9% < 45% bag target
    expect(row.belowFloor).toBe(false);
    expect(row.status).toBe("READY TO QUOTE");
    const result = resolveOwnerResult({ family: "sticker-bags", stockBag: true, canonical: { ...validCanonical, totalCost: 100, unitCost: 2 }, requestedRow: row, multiLine: null, marginRuleKey: "bags-4x5" })!;
    expect(result.state).toBe("READY");
    expect(result.badge).toBe("READY TO QUOTE");
    expect(src()).toContain("checkMarginGate(Math.min(100, ...snapshotTiers.filter((tier: any) => !tier.stockBagStorefront?.ok)");
    const margin = quoteMarginState({ items: [stockBagItem(2.7)] });
    expect(margin.isLowMargin).toBe(false);
    expect(margin.approvalRequired).toBe(false);
  });

  it("18. it still shows the ACTUAL true cost, profit and margin", async () => {
    const row = await stockBagRow(100);
    expect(row.totalPrice).toBe(135);
    expect(row.profit).toBeCloseTo(35, 6);
    expect(row.actualMarginPct).toBeCloseTo((35 / 135) * 100, 6);
    const result = resolveOwnerResult({ family: "sticker-bags", stockBag: true, canonical: { ...validCanonical, totalCost: 100, unitCost: 2 }, requestedRow: row, multiLine: null, marginRuleKey: "bags-4x5" })!;
    expect(result.trueJobCost).toBe(100);
    expect(result.profit).toBeCloseTo(35, 6);
    expect(result.marginPct).toBeCloseTo(25.93, 1);
  });

  it("19. below the target it WARNS (owner-visible), it does not block", async () => {
    const row = await stockBagRow(100);
    expect(row.belowMarginTarget).toBe(true);
    expect(row.marginWarning).toBe(STOREFRONT_BELOW_TARGET_WARNING);
    expect(STOREFRONT_BELOW_TARGET_WARNING).toBe("Approved storefront price is below the standard margin target.");
    const result = resolveOwnerResult({ family: "sticker-bags", stockBag: true, canonical: { ...validCanonical, totalCost: 100, unitCost: 2 }, requestedRow: row, multiLine: null, marginRuleKey: "bags-4x5" })!;
    expect(result.marginWarning).toBe(STOREFRONT_BELOW_TARGET_WARNING);
    const margin = quoteMarginState({ items: [stockBagItem(2.7)] });
    expect(margin.approvedPriceWarnings[0].reason).toContain(STOREFRONT_BELOW_TARGET_WARNING);
    // a healthy margin carries no warning
    expect((await stockBagRow(40)).marginWarning).toBeNull();
  });

  it("20. a manually altered Stock Bag price (or quantity) loses the storefront exemption", () => {
    expect(storefrontAuthorityExempt(stockBagItem(2.7))).toBe(true);
    expect(storefrontAuthorityExempt(stockBagItem(2.5))).toBe(false);
    expect(storefrontAuthorityExempt(stockBagItem(2.7, 60))).toBe(false);
    const altered = quoteMarginState({ items: [stockBagItem(2.5)] });
    expect(altered.isLowMargin).toBe(true);
    expect(altered.approvalRequired).toBe(true);
    expect(altered.approvedPriceWarnings).toEqual([]);
  });

  it("21. 50 Stock Bags still resolve to $2.70 / $135 from the real storefront authority (not hardcoded)", async () => {
    const inputs = await resolveCanonicalBagInputs(fakeShopDb(), "test-shop");
    const selection = stockBagStorefrontSelection({ faces: "2", materialName: "Poseidon Matte", glossLayers: "0" });
    expect(priceStorefrontConfiguration(inputs, { ...selection, quantity: 50 })).toMatchObject({ ok: true, unitPrice: 2.7, totalPrice: 135 });
    const row = await stockBagRow(60);
    expect([row.unitPrice, row.totalPrice]).toEqual([2.7, 135]);
    expect(row.stockBagStorefront).toMatchObject({ ok: true, unitPrice: 2.7, totalPrice: 135 });
    expect(src("app/lib/stock-bag-quote-pricing.server.ts")).not.toMatch(/2\.70?\b|135\b/);
  });
});

describe("unchanged (tests 22-29)", () => {
  it("22. Sticker Bag double-side mapping remains correct", () => {
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=sticker-bags&pbagmat=matte&pqty=1000&pbagsides=2&pdesigns=1&pprinter=auto"))!.bags!.sides).toBe(2);
    expect(src()).toContain('<input type="hidden" name="pbagsides" value={bagSidesValue} />');
  });

  it("23. Banner field mapping remains correct", () => {
    const s = src();
    for (const field of ["pbannerw", "pbannerh", "pbannersides", "pbanneredge", "pbannergrommets"]) expect(s).toContain(`name="${field}"`);
    expect(view(BANNER_QS).unitCost).not.toBeNull();
  });

  it("24. DTP ladders unchanged", () => {
    expect(DTP_LADDER_QUANTITIES).toEqual([1000, 2500, 5000, 10000, 25000]);
    expect([1000, 2500, 5000, 10000, 25000].map((q) => ownerPriceForQuantity("spektra-dtp-4x5x2", q).unitPrice)).toEqual([1.3, 0.71, 0.46, 0.37, 0.3]);
    expect(dtpLadderSource("spektra-dtp-5x4x2")?.status).toBe("OWNER_PRICING_REVIEW_REQUIRED");
  });

  it("25. Miron approved ladder unchanged", () => {
    expect((resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 100 }) as any).quote.unitPrice).toBe(4.5);
    expect((resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 250 }) as any).quote.unitPrice).toBe(4);
  });

  it("26. Chiron remains provisional (no explicit approved authority exists)", () => {
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 500 }).ok).toBe(false);
    expect(APPROVED_MARGIN_CURVE_AUTHORITIES["chiron-jars"]).toBeUndefined();
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "chiron-jars", row: costedRow() }).approved).toBe(false);
  });

  it("27. machine routing follows the corrected owner rule (2026-11-11)", () => {
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 0, glossLayers: 0 }).blockers.join(" ")).toContain("AUTO_MACHINE_LOAD_UNAVAILABLE");
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, glossLayers: 0, costReadyPrinters: ["roland"] }).effectivePrinter).toBe("roland");
    expect(resolveCanonicalMachineRouting({ printerSelection: "mimaki", whiteLayers: 1, whiteCoveragePct: 50, glossLayers: 0 }).blockers).toEqual([]);
    expect(resolveCanonicalMachineRouting({ printerSelection: "mimaki", whiteLayers: 0, glossLayers: 1 }).blockers.join(" ")).toContain("MIMAKI_GLOSS_UNSUPPORTED");
  });

  it("28. cost formulas unchanged", () => {
    for (const lib of [
      "app/lib/canonical-calculator.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/banner-cost-inputs.server.ts",
      "app/lib/label-cost-inputs.server.ts", "app/lib/jar-cost-inputs.server.ts", "app/lib/true-cost-engine.server.ts", "app/lib/canonical-bag-pricing.server.ts",
    ]) expect(src(lib), lib).not.toContain("2026-10-19");
  });

  it("29. pricing formulas unchanged — only authority / gating selection changed", () => {
    for (const lib of [
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/jar-commercial-pricing.ts", "app/lib/dtp-owner-pricing.server.ts", "app/lib/customer-tiers.ts",
    ]) expect(src(lib), lib).not.toContain("2026-10-19");
    // the low-margin threshold itself is unchanged
    expect(quoteMarginState({ items: [{ productName: "x", quantity: 1, unitPrice: 10, unitCost: 6.1 }] }).isLowMargin).toBe(true);
    expect(quoteMarginState({ items: [{ productName: "x", quantity: 1, unitPrice: 10, unitCost: 6 }] }).isLowMargin).toBe(false);
  });
});
