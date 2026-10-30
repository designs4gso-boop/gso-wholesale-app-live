// 2026-10-19 — Cost & Pricing Calculator owner UX + final owner pricing decisions.
//
// Owner decisions pinned here:
//   A. Sticker Bag sides reach the canonical bag engine (pbagsides).
//   B. Banner fields reach the canonical banner engine (pbannerw/pbannerh/...).
//   C. Stock Bag quotes price through the live storefront authority
//      (priceStorefrontConfiguration) — 50 x 4x5 Matte / No Spot Gloss /
//      double = $2.70 each, $135.00 — while true cost stays canonical.
//   D. Chiron has no owner-approved selling-price authority -> Not available.
//   E. No approved authority -> PROVISIONAL draft only; send / approve /
//      order / production refused on the server.
// Plus the earlier UX checks (required fields, never-$0, diagnostics,
// overrides, DTP ladders, routing, unchanged cost formulas).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  APPROVED_MARGIN_CURVE_AUTHORITIES,
  PROVISIONAL_PRICING_STATUS,
  REQUIRED_FIELDS_MESSAGE,
  STOCK_BAG_CALCULATOR_OPTION,
  UNAPPROVED_MARGIN_CURVES,
  calculatorFamilyChoice,
  calculatorFamilyParams,
  missingRequiredCalculatorFields,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
  summarizeCalculatorBlockers,
  type CalculatorFormShape,
} from "../app/lib/calculator-owner-view";
import {
  PROVISIONAL_ALLOWED_QUOTE_STATUSES,
  carryProvisionalPricingAuthority,
  itemPricingAuthority,
  provisionalQuoteStatusCheck,
  quotePricingAuthorityState,
} from "../app/lib/quote-pricing-authority";
import { assembleCanonicalJob, canonicalViewOf, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { resolveCanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";
import { STOCK_BAG_QUOTE_PRICE_RULE, priceStockBagTierRow, stockBagStorefrontSelection } from "../app/lib/stock-bag-quote-pricing.server";
import { BAG_4X5_BLANK_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { marginFamilyKeyFor } from "../app/lib/product-driven-costing.server";
import { DTP_LADDER_QUANTITIES, dtpLadderSource, ownerPriceForQuantity } from "../app/lib/dtp-owner-pricing.server";
import { resolveCanonicalMachineRouting } from "../app/lib/machine-routing.server";
import { quoteConversionEligibility } from "../app/lib/production-job-source.server";
import { calculatorFamilies } from "../app/lib/product-family-registry";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const QUOTES = "app/routes/app.quotes.tsx";
const src = (path = ROUTE) => readFileSync(path, "utf8");

/** Approved Mimaki CMYK calibration — the same fixture the 2D-4 suite uses. */
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

const STICKER_BAG_QS = (sides: 1 | 2) => `pfamily=sticker-bags&pqty=1000&pbagsides=${sides}&pdesigns=1&pprinter=auto`;
const STOCK_BAG_QS = (qty: number) => `pfamily=sticker-bags&pstockbag=1&pqty=${qty}&pbagsides=2&pdesigns=1&pprinter=auto`;
const JAR_QS = (family: string, jar: string, extra = "") => `pfamily=${family}&pqty=500&pjar=${jar}&pjarside=1&pjarlid=1&pcmykcoverage=40${extra}`;

/** A read-only fake shop DB: one Poseidon matte roll, one holographic roll, the 4x5 blank bag, a Roland. */
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
      create: async () => { throw new Error(`test DB is read-only (${model}.create)`); },
      update: async () => { throw new Error(`test DB is read-only (${model}.update)`); },
      updateMany: async () => { throw new Error(`test DB is read-only (${model}.updateMany)`); },
    }),
  }) as any;
}

const costedRow = (overrides: Record<string, unknown> = {}) => ({
  quantity: 50, requested: true, jobCost: 60, unitCost: 1.2, unitPrice: 3.1, totalPrice: 155, profit: 95, actualMarginPct: 61.3, marginPct: 61.3,
  belowFloor: false, draftOnly: false, freightTotal: 0, floorPct: 45, blockers: [], status: "READY TO QUOTE",
  commercial: { controllingRule: "4x5 bands", marginSource: "4x5 sticker bags researched curve", ownerLadder: null },
  ...overrides,
});
const validCanonical = { status: "VALID", totalCost: 60, unitCost: 1.2, blockers: [] as string[] };
const provisionalItem = (name = "Chiron 150ml job") => ({
  productName: name,
  priceSnapshot: JSON.stringify({ unitPrice: null, pricingAuthority: { approved: false, status: PROVISIONAL_PRICING_STATUS, kind: "none", source: null, missing: "no authority" } }),
});
const approvedItem = (name = "Sticker job") => ({
  productName: name,
  priceSnapshot: JSON.stringify({ unitPrice: 1, pricingAuthority: { approved: true, status: "APPROVED", kind: "approved_margin_curve", source: "x", missing: null } }),
});

/* ================================================================== */

describe("A. Sticker Bag sides reach the canonical engine (1-3)", () => {
  it("1. Front only posts pbagsides=1 and the engine costs one side", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(STICKER_BAG_QS(1)))!;
    expect(input.bags!.sides).toBe(1);
  });

  it("2. Front and back posts pbagsides=2 and the engine receives two sides", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(STICKER_BAG_QS(2)))!;
    expect(input.bags!.sides).toBe(2);
  });

  it("3. double-sided costs more than the same single-sided job — through the existing engine, no new formula", () => {
    const single = view(STICKER_BAG_QS(1));
    const double = view(STICKER_BAG_QS(2));
    expect(single.unitCost).not.toBeNull();
    expect(double.unitCost).not.toBeNull();
    expect(double.totalCost).toBeGreaterThan(single.totalCost);
    expect(double.diagnostics.applicationsPerItem).toBe(2);
    expect(single.diagnostics.applicationsPerItem).toBe(1);
  });

  it("the form mirrors the visible side choice into pbagsides for Sticker AND Stock Bags", () => {
    const s = src();
    expect(s).toContain('<input type="hidden" name="pbagsides" value={bagSidesValue} />');
    expect(s).toContain('<option value="1">Front only</option><option value="2">Front and back</option>');
    expect(s).toContain('const bagSidesValue = bagSides === "1" || bagSides === "2" ? bagSides : isStockBag ? "2" : "1";');
  });
});

describe("B. Banner fields reach the canonical banner engine (4-5)", () => {
  it("4. the form mirrors width / height / sides / hemming / grommets into the engine's field names", () => {
    const s = src();
    expect(s).toContain('<input type="hidden" name="pbannerw" value={canonLine.w} />');
    expect(s).toContain('<input type="hidden" name="pbannerh" value={canonLine.h} />');
    expect(s).toContain('<input type="hidden" name="pbannersides" value={bannerFaces === "2" ? "DOUBLE" : "SINGLE"} />');
    expect(s).toContain('<input type="hidden" name="pbanneredge" value={bannerHem ? "HEMMED" : "TRIM_ONLY"} />');
    expect(s).toContain('<input type="hidden" name="pbannergrommets" value={bannerGrommets ? "FOUR_CORNERS" : "NONE"} />');
  });

  it("5. a valid banner now returns canonical true cost; the old field names alone still report missing size", () => {
    const old = view("pfamily=banners&pqty=2&pwidth=36&pheight=60&pdesigns=1");
    expect(old.blockers.join(" ")).toContain("BANNER_SIZE_REQUIRED");
    const mapped = view("pfamily=banners&pqty=2&pwidth=36&pheight=60&pbannerw=36&pbannerh=60&pbannersides=SINGLE&pbanneredge=TRIM_ONLY&pbannergrommets=NONE&pdesigns=1");
    expect(mapped.blockers.join(" ")).not.toContain("BANNER_SIZE_REQUIRED");
    expect(mapped.status).not.toBe("DRAFT_ONLY");
    expect(mapped.unitCost).not.toBeNull();
    expect(mapped.totalCost).toBeGreaterThan(0);
  });

  it("unverified banner finishing still fails closed (formula unchanged)", () => {
    const hemmed = view("pfamily=banners&pqty=2&pbannerw=36&pbannerh=60&pbanneredge=HEMMED&pdesigns=1");
    expect(hemmed.status).toBe("DRAFT_ONLY");
    expect(hemmed.blockers.join(" ")).toContain("BANNER_FINISHING_RATE_REQUIRED");
  });
});

describe("C. Stock Bag quotes use the storefront price authority (6-8)", () => {
  it("6. the calculator prices Stock Bag rows through the same function the storefront and checkout use", () => {
    const s = src();
    expect(s.split("priceStockBagTierRow(").length - 1).toBe(2); // loader + save action
    expect(s).toContain("const stockBagInputsP = stockBagP ? await resolveCanonicalBagInputs(db, shop) : null;");
    expect(s).toContain("const stockBagInputsSave = savedStockBag ? await resolveCanonicalBagInputs(db, shop) : null;");
    expect(src("app/lib/stock-bag-quote-pricing.server.ts")).toContain("const priced = priceStorefrontConfiguration(inputs, { ...selection, quantity: Number(row.quantity) || 0 });");
    expect(src("app/routes/apps.wholesale-lite.configurator-checkout.ts")).toContain("priceStorefrontConfiguration(canonicalInputs, { quantity, faces, material, finish })");
    // the old side-by-side comparison (and its amber "prices differ" note) is gone
    expect(s).not.toContain("stockBagStorefront,");
    expect(s).not.toContain("The quote price above and the storefront price differ");
  });

  it("7. 50 x 4x5 Matte / No Spot Gloss / double resolves to $2.70 each, $135.00 — via the real storefront authority", async () => {
    const inputs = await resolveCanonicalBagInputs(fakeShopDb(), "test-shop");
    expect(inputs.available).toBe(true);
    const selection = stockBagStorefrontSelection({ faces: "2", materialName: "Poseidon Matte", glossLayers: "0" });
    expect(selection).toEqual({ faces: 2, material: "Poseidon Matte", finish: "No Spot Gloss" });
    // the storefront's own answer
    const storefront = priceStorefrontConfiguration(inputs, { ...selection, quantity: 50 });
    expect(storefront).toMatchObject({ ok: true, unitPrice: 2.7, totalPrice: 135 });
    // the calculator row answer — identical, because it IS that function
    const row = priceStockBagTierRow(costedRow(), inputs, selection);
    expect(row.unitPrice).toBe(2.7);
    expect(row.totalPrice).toBe(135);
    expect(row.commercial.controllingRule).toBe(STOCK_BAG_QUOTE_PRICE_RULE);
    const authority = resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: true, marginRuleKey: "bags-4x5", row });
    expect(authority.approved).toBe(true);
    expect(authority.kind).toBe("storefront_stock_bag");
  });

  it("8. Stock Bag true cost stays the canonical cost; profit and margin are measured against it", async () => {
    const inputs = await resolveCanonicalBagInputs(fakeShopDb(), "test-shop");
    const selection = stockBagStorefrontSelection({ faces: "2", materialName: "Poseidon Matte", glossLayers: "0" });
    const canonical = view(STOCK_BAG_QS(50));
    expect(canonical.family).toBe("stock-bags");
    expect(canonical.unitCost).not.toBeNull();
    const row = priceStockBagTierRow(costedRow({ jobCost: canonical.totalCost, unitCost: canonical.unitCost }), inputs, selection);
    expect(row.jobCost).toBe(canonical.totalCost);
    expect(row.unitCost).toBe(canonical.unitCost);
    expect(row.profit).toBeCloseTo(135 - canonical.totalCost, 6);
    expect(row.actualMarginPct).toBeCloseTo(((135 - canonical.totalCost) / 135) * 100, 6);
    // a different true cost never moves the selling price
    const cheaper = priceStockBagTierRow(costedRow({ jobCost: 10 }), inputs, selection);
    expect(cheaper.totalPrice).toBe(135);
    // a blocked (no-cost) row stays unpriced
    const blocked = priceStockBagTierRow(costedRow({ jobCost: null, unitPrice: null, totalPrice: null, draftOnly: true }), inputs, selection);
    expect(blocked.totalPrice).toBeNull();
    // 5,000+ is a storefront volume quote: no price, never the generic curve
    const volume = priceStockBagTierRow(costedRow({ quantity: 5000 }), inputs, selection);
    expect(volume.unitPrice).toBeNull();
    expect(volume.status).toBe("QUOTE REQUIRED");
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: true, marginRuleKey: "bags-4x5", row: volume }).approved).toBe(false);
  });

  it("Stock Bags remain their own canonical family with the 50-bag MOQ; the selector shows them after Sticker Bags", () => {
    expect(calculatorFamilyParams(STOCK_BAG_CALCULATOR_OPTION.value)).toEqual({ pfamily: "sticker-bags", pstockbag: "1" });
    expect(calculatorFamilyChoice("sticker-bags", "1")).toBe("stock-bags");
    expect(calculatorFamilyChoice("sticker-bags", null)).toBe("sticker-bags");
    expect(view(STOCK_BAG_QS(49)).blockers.join(" ")).toContain("STOCK_BAG_BELOW_MOQ");
    expect(view(STOCK_BAG_QS(50)).blockers.join(" ")).not.toContain("STOCK_BAG_BELOW_MOQ");
    expect(src()).toContain('{entry.key === "sticker-bags" ? <option value={STOCK_BAG_CALCULATOR_OPTION.value}>{STOCK_BAG_CALCULATOR_OPTION.label}</option> : null}');
    expect(calculatorFamilies().map((entry) => entry.key)).not.toContain("stock-bags");
  });
});

describe("D. Chiron has no owner-approved selling-price authority (9-11)", () => {
  it("9. Chiron with a valid true cost shows Recommended Selling Price: Not available", () => {
    const chiron = view(JAR_QS("premium-jars", "chiron/150ml"));
    expect(chiron.unitCost).not.toBeNull(); // the true cost still calculates
    const result = resolveOwnerResult({
      family: "premium-jars", canonical: { status: chiron.status, totalCost: chiron.totalCost, unitCost: chiron.unitCost, blockers: chiron.blockers },
      requestedRow: costedRow({ jobCost: chiron.totalCost, unitCost: chiron.unitCost, commercial: { controllingRule: "chiron curve", marginSource: "Chiron jars researched curve", ownerLadder: null } }),
      multiLine: null, marginRuleKey: "chiron-jars",
    })!;
    expect(result.state).toBe("PRICE_NOT_AVAILABLE");
    expect(result.badge).toBe(PROVISIONAL_PRICING_STATUS);
    expect(result.recommendedTotal).toBeNull();
    expect(result.profit).toBeNull();
    expect(result.marginPct).toBeNull();
    expect(result.trueJobCost).toBe(chiron.totalCost);
    expect(result.missingAuthority).toContain("Chiron jars have no owner-approved price ladder");
  });

  it("10. the Chiron curve existing in code does not make it an authority; there is no Chiron owner ladder", () => {
    expect(marginFamilyKeyFor("premium-jars", "jar_chiron", "Chiron 150ml")).toBe("chiron-jars");
    expect(APPROVED_MARGIN_CURVE_AUTHORITIES["chiron-jars"]).toBeUndefined();
    expect(UNAPPROVED_MARGIN_CURVES["chiron-jars"]).toContain("unsourced family default");
    const ladder = resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 500 });
    expect(ladder.ok).toBe(false);
    expect(resolveSellingPriceAuthority({ family: "premium-jars", stockBag: false, marginRuleKey: "chiron-jars", row: costedRow() }).approved).toBe(false);
  });

  it("11. Miron's owner 16D ladder is unchanged and remains an approved authority", () => {
    const ladder = resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 100 });
    expect(ladder.ok && ladder.quote.unitPrice).toBe(4.5);
    expect((resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 250 }) as any).quote.unitPrice).toBe(4);
    const authority = resolveSellingPriceAuthority({
      family: "premium-jars", stockBag: false, marginRuleKey: "miron-jars",
      row: costedRow({ commercial: { controllingRule: "owner ladder", marginSource: "owner ladder", ownerLadder: { unitPrice: 4.5, raisedByFloor: false } } }),
    });
    expect(authority.approved).toBe(true);
    expect(authority.kind).toBe("owner_jar_ladder");
    expect(view(JAR_QS("premium-jars", "miron/100ml_wide")).unitCost).not.toBeNull();
  });
});

describe("E. no approved authority -> PROVISIONAL draft only, enforced on the server (12-17)", () => {
  it("12. the calculator save still saves a DRAFT, with no customer price and the authority recorded", () => {
    const s = src();
    expect(s).toContain("unitPrice: customerUnitPrice ?? 0,");
    expect(s).toContain("pricingAuthority: pricingAuthorityRecord,");
    expect(s).toContain("const customerUnitPrice: number | null = savedPriceAuthority.approved ? primary.unitPrice : null;");
    expect(s).toContain('shop, status: "draft",');
    expect(s).toContain("SAVE PROVISIONAL DRAFT (no customer price)");
    expect(provisionalQuoteStatusCheck({ items: [provisionalItem()] }, "draft")).toEqual({ ok: true });
  });

  it("13-14. a provisional quote cannot be Sent, Approved or marked Won (status intent AND editor save)", () => {
    for (const next of ["sent", "approved", "won", "deposit_paid", "paid", "production", "completed"]) {
      const check = provisionalQuoteStatusCheck({ items: [approvedItem(), provisionalItem()] }, next);
      expect(check.ok, next).toBe(false);
      expect((check as any).message).toContain(PROVISIONAL_PRICING_STATUS);
    }
    expect([...PROVISIONAL_ALLOWED_QUOTE_STATUSES]).toEqual(["draft", "lost", "canceled", "expired"]);
    // historical / approved quotes are unaffected
    expect(provisionalQuoteStatusCheck({ items: [approvedItem(), { productName: "old", priceSnapshot: JSON.stringify({ unitPrice: 2 }) }] }, "sent")).toEqual({ ok: true });
  });

  it("15. a provisional quote can never become a production job (central eligibility check)", () => {
    const quote = { shop: "s", status: "paid", items: [provisionalItem()] };
    const result = quoteConversionEligibility(quote, "s");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(PROVISIONAL_PRICING_STATUS);
  });

  it("16. the server refuses every prohibited transition — not just a disabled button", () => {
    const q = src(QUOTES);
    expect(q).toContain("const provisionalCheck = provisionalQuoteStatusCheck(provisionalQuote, nextStatus);");
    for (const intent of ["approveCreateOrder", "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail"]) {
      expect(q, intent).toContain(`return Response.json({ intent: "${intent}", ok: false, error: pricingAuthorityState.blockMessage });`);
    }
    // the editor cannot launder a provisional quote: authority comes from the DB, status checked server-side
    // (round 2: the save path reconciles per item from the DB — see the sign-off suite)
    expect(q).toContain("const reconciled = reconcileQuoteItemPricingAuthority(existingItemsForAuthority, costProtectedItems, { customerTier, customerTierLabel }, authorityActor, authorityAt);");
    expect(q).toContain('const provisionalSaveCheck = provisionalQuoteStatusCheck({ customerTier, customerTierLabel, items: protectedItems as any }, String(quote.status || "draft"));');
    const laundered = carryProvisionalPricingAuthority([provisionalItem()], [{ productName: "edited", priceSnapshot: JSON.stringify({ unitPrice: 9 }) }]);
    expect(itemPricingAuthority(laundered[0])?.approved).toBe(false);
    expect(quotePricingAuthorityState({ items: laundered as any }).provisional).toBe(true);
    // approved quotes pass through untouched
    const untouched = [{ productName: "x", priceSnapshot: JSON.stringify({ unitPrice: 9 }) }];
    expect(carryProvisionalPricingAuthority([approvedItem()], untouched)).toBe(untouched);
  });

  it("17. the generic fallback curve is never promoted to an approved customer price", () => {
    for (const key of [null, "provisional-universal", "banners", "miron-jars", "chiron-jars", "die-cut-bags", "boxes"]) {
      expect(resolveSellingPriceAuthority({ family: "standard-jars", stockBag: false, marginRuleKey: key, row: costedRow() }).approved, String(key)).toBe(false);
    }
    expect(resolveSellingPriceAuthority({ family: "custom-item", stockBag: false, marginRuleKey: null, row: costedRow() }).approved).toBe(false);
    const result = resolveOwnerResult({ family: "standard-jars", canonical: validCanonical, requestedRow: costedRow(), multiLine: null, marginRuleKey: null })!;
    expect(result.recommendedTotal).toBeNull();
    expect(result.recommendedUnit).toBeNull();
    // the tier table labels such prices diagnostic-only
    const s = src();
    expect(s).toContain('{provisionalPrices ? "Reference tier prices — diagnostic only, NOT approved customer prices" : "Quantity tiers"}');
    expect(s).toContain("tiers: snapshotTiers.map((tier: any) => ({ qty: tier.quantity, unitPrice: savedPriceAuthority.approved ? tier.unitPrice : null,");
    // approved curve families still price
    expect(resolveSellingPriceAuthority({ family: "sticker-bags", stockBag: false, marginRuleKey: "bags-4x5", row: costedRow() }).approved).toBe(true);
    expect(resolveSellingPriceAuthority({ family: "stickers-labels", stockBag: false, marginRuleKey: "stickers-labels", row: costedRow() }).approved).toBe(true);
  });
});

describe("18-20. unchanged: DTP ladders, printer routing, canonical cost formulas", () => {
  it("18. DTP owner ladders are unchanged; 5x4x2 stays manual / vendor review", () => {
    expect(DTP_LADDER_QUANTITIES).toEqual([1000, 2500, 5000, 10000, 25000]);
    expect([1000, 2500, 5000, 10000, 25000].map((q) => ownerPriceForQuantity("spektra-dtp-4x5x2", q).unitPrice)).toEqual([1.3, 0.71, 0.46, 0.37, 0.3]);
    expect(dtpLadderSource("spektra-dtp-5x4x2")?.status).toBe("OWNER_PRICING_REVIEW_REQUIRED");
    const legacy = resolveOwnerResult({
      family: "dtp-bags", canonical: null, multiLine: null, marginRuleKey: "dtp-pouches",
      requestedRow: costedRow({ status: "OWNER OVERRIDE REQUIRED", dtp: { statusReasons: [], customUnitPrice: null, pricingSource: "x", ladderStatus: "OWNER_PRICING_REVIEW_REQUIRED" } }),
    })!;
    expect(legacy.badge).toBe("MANUAL / VENDOR REVIEW");
    expect(legacy.recommendedTotal).toBeNull();
    const approved = resolveOwnerResult({
      family: "dtp-bags", canonical: null, multiLine: null, marginRuleKey: "dtp-pouches",
      requestedRow: costedRow({ status: "READY", dtp: { statusReasons: [], customUnitPrice: null, pricingSource: "OWNER_APPROVED_DTP_4X5_2026_10_06", ladderStatus: "OWNER_APPROVED" } }),
    })!;
    expect(approved.state).toBe("READY");
    expect(approved.priceAuthority).toBe("Owner DTP price ladder (OWNER_APPROVED_DTP_4X5_2026_10_06)");
  });

  it("19. printer routing: CMYK auto -> Mimaki, white/gloss -> Roland, Mimaki + white/gloss blocked, explicit Roland CMYK allowed", () => {
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 0, glossLayers: 0 }).effectivePrinter).toBe("mimaki");
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, glossLayers: 0 }).effectivePrinter).toBe("roland");
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 0, glossLayers: 2 }).effectivePrinter).toBe("roland");
    expect(resolveCanonicalMachineRouting({ printerSelection: "roland", whiteLayers: 0, glossLayers: 0 }).blockers).toEqual([]);
    for (const layers of [{ whiteLayers: 1, glossLayers: 0 }, { whiteLayers: 0, glossLayers: 1 }]) {
      const routed = resolveCanonicalMachineRouting({ printerSelection: "mimaki", ...layers });
      expect(routed.blockers.join(" ")).toContain("MIMAKI_SPECIALTY_UNSUPPORTED");
      expect(summarizeCalculatorBlockers(routed.blockers)!.items[0]).toBe("White/gloss cannot print on the Mimaki — choose Auto or Roland");
    }
  });

  it("20. canonical cost formulas are untouched by this change set", () => {
    for (const lib of [
      "app/lib/canonical-calculator.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/banner-cost-inputs.server.ts",
      "app/lib/label-cost-inputs.server.ts", "app/lib/jar-cost-inputs.server.ts", "app/lib/true-cost-engine.server.ts",
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/storefront-canonical-pricing.server.ts", "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/jar-commercial-pricing.ts", "app/lib/dtp-owner-pricing.server.ts",
    ]) {
      expect(src(lib), lib).not.toContain("2026-10-19");
    }
  });
});

describe("owner UX (earlier review, kept)", () => {
  const stickerShape: CalculatorFormShape = {
    isBags: false, isStockBag: false, jars: false, isStickers: true, isBanners: false, isCustom: false, isDtp: false,
    topRequired: false, autoBag: false, contourCut: false,
  };
  const reader = (values: Record<string, string>) => (name: string) => values[name] ?? "";

  it("Calculate is held back client-side while visible required fields are empty", () => {
    expect(missingRequiredCalculatorFields(stickerShape, reader({ pdesigns: "1" })).map((f) => f.name)).toEqual(["pqty", "pwidth", "pheight", "pmat"]);
    expect(missingRequiredCalculatorFields(stickerShape, reader({ pqty: "500", pdesigns: "1", pwidth: "3", pheight: "3", pmat: "m" }))).toEqual([]);
    expect(missingRequiredCalculatorFields({ ...stickerShape, isStickers: false, jars: true, topRequired: true }, reader({ pqty: "100", pdesigns: "1", pmat: "m" })).map((f) => f.name)).toEqual(["pblank", "plid"]);
    expect(REQUIRED_FIELDS_MESSAGE).toBe("Complete the highlighted fields before calculating.");
    const s = src();
    expect(s).toContain("if (missing.length) event.preventDefault();");
    expect(s).toContain("if (!family) return; // CONTINUE (no family yet) is never blocked");
  });

  it("the server still rejects incomplete input, and missing cost is never $0", () => {
    const blocked = view("pfamily=sticker-bags&pbagsides=1&pdesigns=1");
    expect(blocked.status).toBe("DRAFT_ONLY");
    expect(blocked.unitCost).toBeNull();
    const result = resolveOwnerResult({
      family: "stickers-labels", canonical: { status: "DRAFT_ONLY", totalCost: 12.34, unitCost: null, blockers: ["QUANTITY_REQUIRED: x"] },
      requestedRow: null, multiLine: null, marginRuleKey: "stickers-labels",
    })!;
    expect(result.trueJobCost).toBeNull();
    expect(result.trueUnitCost).toBeNull();
    expect(result.recommendedTotal).toBeNull();
    expect(result.state).toBe("NEEDS_INFORMATION");
    expect(result.reasons).toEqual(["Quantity"]);
    expect(resolveOwnerResult({ family: "banners", canonical: null, requestedRow: null, multiLine: null, marginRuleKey: null })).toBeNull();
    // tier money renders "—" for a missing amount, never $0.00
    expect(src()).toContain('(value == null || !Number.isFinite(Number(value)) ? "—"');
  });

  it("diagnostics: plain summary first, raw codes kept in a collapsed section", () => {
    const summary = summarizeCalculatorBlockers(["QUANTITY_REQUIRED: q", "CUT_PATH_ESTIMATE_REQUIRED: c", "APPLICATION_ITEM_QUANTITY_REQUIRED: a"])!;
    expect(summary.kind).toBe("NEEDS_INFORMATION");
    expect(summary.items).toEqual(["Quantity", "Contour cut-path perimeter", "Number of items to apply labels to"]);
    expect(summarizeCalculatorBlockers(["QUANTITY_REQUIRED", "MISSING_INK_PRICE", "MISSING_CALIBRATION", "BAG_BLANK_COST_REQUIRED", "WHITE_COVERAGE_REQUIRED"])!.items).toHaveLength(4);
    const s = src();
    const card = s.slice(s.indexOf("function CanonicalTrueCost()"), s.indexOf("function ProductBreakdown()"));
    const advanced = card.indexOf("Advanced diagnostics{canonical.blockers.length");
    expect(advanced).toBeGreaterThan(0);
    expect(card.indexOf("BLOCKERS ({canonical.blockers.length})")).toBeGreaterThan(advanced);
    const order = ["<ProductDrivenForm />", "<OwnerResultCard />", "<CanonicalTrueCost />", "<ProductTiers />"].map((tag) => s.indexOf(tag));
    expect(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]))).toBe(true);
    expect(s).not.toContain("never computed here");
  });

  it("Advanced Overrides stay collapsed and job-level only", () => {
    const s = src();
    expect(s).toContain('<details style={{ marginTop: 12 }}><summary style={{ fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Advanced Overrides (tier quantities, per-tier margin edits, freight/handling, owner override — job-level only, never global standards)</summary>');
    const block = s.split("Advanced Overrides (tier quantities")[1].split("</details>")[0];
    expect(block).not.toMatch(/ownerConfig|pricingPolicy\.|updatePricingSettings|savePricingSettings/);
  });
});
