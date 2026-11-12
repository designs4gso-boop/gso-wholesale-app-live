// 2026-11-12 — LIVE QA REGRESSIONS (commit 03c0eed in production).
//
// 1/6. Split Bag width / height are canonical (7.20 x 4.38 art, 7.07 x 4.26
//      cutline): never required, never overridden by stale query params, 4.38
//      never rounded.
// 2/3. Quantity (physical bags) and Number of designs (unique artworks) are
//      independent; printed faces = bags x sides, never designs.
// 4.   The 3oz / 4oz side lid band is offered; missing application timing
//      keeps the quote Needs Review instead of hiding the option.
// 5.   Launch Readiness reads canonical jar geometry and names what is
//      genuinely unresolved (50ml, non-active jars) instead of "at least 3".

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

const MATTE = {
  id: "m_matte", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", productFamilies: "labels,sticker_bags",
  unit: "sqft", baseUnit: "sqft", costPerUnit: 213 / 675, calculatedUnitCost: 213 / 675, purchaseCost: 213,
  rollWidthIn: 54, costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor",
};
const BAG_4X5 = { id: "v_bag", shop: "shop-1", name: "4x5 Sticker Bag Blank (Safe Care)", productType: "bag", vendor: "Safe Care", vendorSku: "preset:blank-4x5-bag", defaultUnitCost: 0.11, active: true, tiers: [], addOns: [] };
const dbState: { writes: Array<{ op: string; args: any }> } = { writes: [] };

vi.mock("../app/db.server", async () => {
  const { CANONICAL_CALIBRATION_IDENTITIES } = await import("../app/lib/machine-routing.server");
  const MEASURED: Record<string, any> = {
    "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
    "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
    "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
    "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
  };
  const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]: any) => ({
    id: `cal_${key}`, shop: "shop-1", ...identity, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null,
    timeModel: "variable_only", measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved",
    source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date(0), ...MEASURED[key],
  }));
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (/^(create|update|upsert|delete)/.test(method)) { dbState.writes.push({ op: `${name}.${method}`, args }); return { id: `${name}_new` }; }
      const where = args?.where || {};
      if (name === "machineProfileCalibration" && method === "findMany") {
        return ROWS.filter((row: any) => Object.entries(where).every(([f, v]) => (f === "shop" ? true : row[f] === v)));
      }
      if (name === "material" && method === "findMany") return [MATTE];
      if (name === "material" && method === "findFirst") return where.id === MATTE.id ? MATTE : null;
      if (name === "vendorProduct" && method === "findMany") return [BAG_4X5];
      if (name === "vendorProduct" && method === "findFirst") return where.id === BAG_4X5.id ? BAG_4X5 : null;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any) => (typeof ops === "function" ? ops(db) : Promise.all(ops)) : model(key)) });
  return { default: db, db };
});

import { SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN } from "../app/lib/bag-artboard-geometry";
import { bagCutGeometry, bagNestingRuns } from "../app/lib/bag-cost-inputs.server";
import { JAR_LABEL_GEOMETRY, jarCutlineFor } from "../app/lib/jar-label-geometry";
import { JAR_APPLICATION_SECONDS_BY_SIZE, resolveJarApplication } from "../app/lib/jar-cost-inputs.server";
import { CANONICAL_REASONS } from "../app/lib/canonical-calculator-shared";
import { SPLIT_BAG_PARAM_HEIGHT, calculatorDesignCount, calculatorTransitionParams, missingRequiredCalculatorFields, summarizeCalculatorBlockers, withCanonicalSplitBagGeometry } from "../app/lib/calculator-owner-view";
import { RECIPE_MISSING_DIMENSIONS_ISSUE, jarRecipeGeometryStatus, readinessIssuesForRecipe } from "../app/lib/jar-recipe-geometry";
import { quotePipelineSummary } from "../app/lib/launch-readiness-view";
import db from "../app/db.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import {
  BAG_4X5_BLANK_UNIT_COST,
  BAG_4X5_CUTLINE_IN,
  SPLIT_BAG_BLANK_UNIT_COST,
  SPLIT_BAG_MOQ,
  bagApplicationCost,
  bagLabelPositionsPerSide,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_DISPATCH, CANONICAL_FAMILIES, CANONICAL_PACKOUT } from "../app/lib/canonical-calculator-shared";
import { familyCostModel } from "../app/lib/canonical-quote-authority.server";
import {
  SPLIT_BAG_CALCULATOR_OPTION,
  SPLIT_BAG_PRICE_AUTHORITY_TEXT,
  calculatorFamilyChoice,
  calculatorFamilyParams,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
} from "../app/lib/calculator-owner-view";
import { getProductProductionSpec } from "../app/lib/product-production-spec";
import { PROVISIONAL_PRICING_STATUS } from "../app/lib/quote-pricing-authority";

beforeEach(() => {
  process.env[OWNER_USER_IDS_ENV] = "9001";
  authState.sub = "9001";
  dbState.writes = [];
});
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; });

const SPLIT_QS = (sides: 1 | 2, qty = 1000) =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=1&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;

async function costJob(qs: string) {
  const input = normalizeCanonicalInput(new URLSearchParams(qs))!;
  const machine = await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input);
  return { input, result: assembleCanonicalJob(input, machine) };
}
const amount = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount;


const ROUTE = () => readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
const lineAmount = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;
// The live QA job: 500 physical Split Bags, ONE design. pwidth / pheight deliberately stale (4 x 5).
const LIVE_QS = (sides: 1 | 2, designs = 1) =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=500&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}` +
  `&pwidth=4&pheight=5&pmat=m_matte&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;

describe("Issue 1 / 6 — Split Bag geometry is canonical (no manual width / height)", () => {
  it("1. width / height resolve without user input and are never required", () => {
    const withoutDims = new URLSearchParams("pfamily=sticker-bags&psplitbag=1&pqty=500&pdesigns=1");
    const resolved = withCanonicalSplitBagGeometry(withoutDims);
    expect(resolved.get("pwidth")).toBe("7.2");
    expect(resolved.get("pheight")).toBe("4.38");
    const shape = { isBags: true, isStockBag: false, jars: false, isStickers: false, isBanners: false, isCustom: false, isDtp: false, topRequired: false, autoBag: true, contourCut: false, isSplitBag: true };
    const read = (name: string) => ({ pqty: "500", pdesigns: "1", pmat: "m_matte" } as Record<string, string>)[name] ?? "";
    expect(missingRequiredCalculatorFields(shape, read).map((f) => f.name)).not.toContain("pwidth");
    expect(missingRequiredCalculatorFields(shape, read).map((f) => f.name)).not.toContain("pheight");
    // 20. the Standard 4x5 form still requires its own width / height
    const std = missingRequiredCalculatorFields({ ...shape, isSplitBag: false }, read).map((f) => f.name);
    expect(std).toEqual(expect.arrayContaining(["pwidth", "pheight"]));
  });

  it("2. stale / posted query params cannot override the canonical geometry (loader, save and engine)", async () => {
    const stale = withCanonicalSplitBagGeometry(new URLSearchParams("pfamily=sticker-bags&psplitbag=1&pwidth=4&pheight=5"));
    expect([stale.get("pwidth"), stale.get("pheight")]).toEqual(["7.2", "4.38"]);
    // Stock / standard bags are untouched
    expect(withCanonicalSplitBagGeometry(new URLSearchParams("pfamily=sticker-bags&pwidth=4&pheight=5")).get("pwidth")).toBe("4");
    expect(withCanonicalSplitBagGeometry(new URLSearchParams("pfamily=sticker-bags&pstockbag=1&psplitbag=1&pwidth=4")).get("pwidth")).toBe("4");
    // the engine costs the same whatever width / height is posted
    const a = (await costJob(LIVE_QS(1))).result;
    const b = (await costJob(LIVE_QS(1).replace("pwidth=4&pheight=5", "pwidth=99&pheight=99"))).result;
    expect(a.trueCost.totalCost).toBeCloseTo(b.trueCost.totalCost, 9);
    expect(a.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * 7.2 * 4.38) / 144, 9);
    // loader + save both force it
    const src = ROUTE();
    expect(src).toContain("url.search = withCanonicalSplitBagGeometry(url.searchParams).toString();");
    expect(src).toContain('const psearchParams = withCanonicalSplitBagGeometry(new URLSearchParams(String(form.get("psearch") || "")');
    expect(src).toContain('if ((key === "pwidth" || key === "pheight") && savedSplitGeometry.has(key)) return String(savedSplitGeometry.get(key));');
  }, 120_000);

  it("3/4. the calculator shows the Split Bag production spec 7.20 x 4.38 / cutline 7.07 x 4.26 read-only", () => {
    const src = ROUTE();
    expect(src).toContain('"SPLIT BAG production spec"');
    expect(src).toContain("<div>Art / print size: <b>{(isSplitBag ? SPLIT_BAG_ARTBOARD_IN : BAG_4X5_ARTBOARD_IN).widthIn.toFixed(2)}");
    expect(src).toContain("<div>Cutline: <b>{(isSplitBag ? SPLIT_BAG_CUTLINE_IN : BAG_4X5_CUTLINE_IN).widthIn.toFixed(2)}");
    expect([SPLIT_BAG_ARTBOARD_IN.widthIn.toFixed(2), SPLIT_BAG_ARTBOARD_IN.heightIn.toFixed(2)]).toEqual(["7.20", "4.38"]);
    expect([SPLIT_BAG_CUTLINE_IN.widthIn.toFixed(2), SPLIT_BAG_CUTLINE_IN.heightIn.toFixed(2)]).toEqual(["7.07", "4.26"]);
    expect(src).toContain("{!isDtp && !jars && !isSplitBag ? (<>"); // no editable width / height for Split Bag
  });

  it("5. 4.38 is never rounded to 4.4 in calculation", () => {
    expect(SPLIT_BAG_PARAM_HEIGHT).toBe("4.38");
    expect(bagNestingRuns(1, "split_bag")[0].items[0].heightIn).toBe(4.38);
    const r = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides: 1 });
    expect(r.nesting.usedShapeAreaSqft).toBeCloseTo((500 * 7.2 * 4.38) / 144, 9);
    expect(r.nesting.usedShapeAreaSqft).not.toBeCloseTo((500 * 7.2 * 4.4) / 144, 3);
  });
});

describe("Issue 2 / 3 — Quantity and Number of designs are independent", () => {
  it("6/7. qty 500 + designs 1 stays qty 500 + designs 1 through a product switch", () => {
    const form = new URLSearchParams("pfamily=sticker-bags&pqty=500&pdesigns=1&pblank=v_bag&pwidth=4&pheight=5");
    const next = calculatorTransitionParams(form, { pfamily: "sticker-bags", pstockbag: null, psplitbag: "1" });
    expect(next.get("pqty")).toBe("500");
    expect(next.get("pdesigns")).toBe("1");
  });

  it("8. changing quantity (128 -> 500) never changes designs", () => {
    for (const qty of ["128", "500"]) {
      const next = calculatorTransitionParams(new URLSearchParams(`pfamily=sticker-bags&psplitbag=1&pqty=${qty}&pdesigns=1`), { pfamily: "sticker-bags", pstockbag: null, psplitbag: "1" });
      expect(next.get("pqty")).toBe(qty);
      expect(next.get("pdesigns")).toBe("1");
    }
  });

  it("9. changing bag type (standard <-> split <-> stock) never changes designs", () => {
    let state = new URLSearchParams("pfamily=sticker-bags&pqty=500&pdesigns=3&pwidth=4&pheight=5");
    for (const next of [
      { pfamily: "sticker-bags", pstockbag: null, psplitbag: "1" },
      { pfamily: "sticker-bags", pstockbag: null, psplitbag: null },
      calculatorFamilyParams("stock-bags"),
      calculatorFamilyParams("split-bags"),
    ]) {
      state = calculatorTransitionParams(state, next);
      expect(state.get("pdesigns")).toBe("3");
      expect(state.get("pqty")).toBe("500");
    }
    // leaving Split Bag drops its fixed size; entering it forces the canonical size
    const toStd = calculatorTransitionParams(new URLSearchParams("pfamily=sticker-bags&psplitbag=1&pwidth=7.2&pheight=4.38"), { pfamily: "sticker-bags", pstockbag: null, psplitbag: null });
    expect(toStd.has("pwidth")).toBe(false);
    expect(toStd.has("pblank")).toBe(false);
  });

  it("URL state never maps qty into designs; missing / invalid designs default to 1 (reset)", () => {
    expect(calculatorDesignCount(null)).toBe("1");
    expect(calculatorDesignCount("")).toBe("1");
    expect(calculatorDesignCount("abc")).toBe("1");
    expect(calculatorDesignCount("-2")).toBe("1");
    expect(calculatorDesignCount("2.5")).toBe("1");
    expect(calculatorDesignCount("4")).toBe("4");
    const next = calculatorTransitionParams(new URLSearchParams("pfamily=sticker-bags&pqty=500"), calculatorFamilyParams("split-bags"));
    expect(next.get("pdesigns")).toBe("1");
    const src = ROUTE();
    expect(src).toContain('<input key="pqty" name="pqty" type="number" min={isDtp ? pm?.dtpSpec?.moq || 1000 : 1} defaultValue={urlValue("pqty")}');
    expect(src).toContain('<input key="pdesigns" name="pdesigns" type="number" min={0} step={1} defaultValue={calculatorDesignCount(canonParams.get("pdesigns"))}');
    expect(src).not.toMatch(/name="pdesigns"[^>]*pqty/);
    // browser position-based form restoration is off for the product form
    expect(src).toContain('<Form method="get" autoComplete="off"');
    // both selectors build their GET through the independent-state helper
    expect(src.match(/submit\(calculatorTransitionParams\(data, /g)).toHaveLength(2);
  });

  it("10/11/12/13. Split Bag qty 500, 1 design: front-only / back-only = 500 faces, front + back = 1,000 (never designs, never 2,000)", async () => {
    const one = (await costJob(LIVE_QS(1))).result;
    const two = (await costJob(LIVE_QS(2))).result;
    expect(one.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * 7.2 * 4.38) / 144, 9); // 500 faces
    expect(two.diagnostics.inkableArtworkSqft).toBeCloseTo((1000 * 7.2 * 4.38) / 144, 9); // 1,000 faces
    for (const sides of [1, 2] as const) {
      const physical = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides, designs: 1 });
      expect(physical.bagQuantity).toBe(500);
      expect(physical.labelQuantity).toBe(500 * sides);
      expect(physical.blankCost).toBeCloseTo(125, 9);
    }
    // 13. the design count changes ONLY setup — never printed faces / media / blanks
    const manyDesigns = (await costJob(LIVE_QS(1, 7))).result;
    expect(manyDesigns.diagnostics.inkableArtworkSqft).toBeCloseTo(one.diagnostics.inkableArtworkSqft, 9);
    expect(lineAmount(manyDesigns, "print_media")).toBeCloseTo(lineAmount(one, "print_media"), 9);
    expect(lineAmount(manyDesigns, "blank_sets")).toBeCloseTo(125, 9);
    expect(lineAmount(manyDesigns, "art_setup")).toBeGreaterThan(lineAmount(one, "art_setup"));
    // the corrected live jobs land near the engine result, not ~$4,900
    expect(one.trueCost.totalCost).toBeCloseTo(271.996, 2);
    expect(two.trueCost.totalCost).toBeCloseTo(409.659, 2);
    // the live symptom reproduced: designs = 500 is what produced ~$4,929
    const bug = (await costJob(LIVE_QS(1, 500))).result;
    expect(bug.trueCost.totalCost).toBeGreaterThan(4900);
    expect(bug.trueCost.totalCost).toBeLessThan(4950);
  }, 120_000);
});

describe("Issue 4 — 3oz / 4oz side lid band is offered; missing labor = Needs Review", () => {
  it("14/15. the band option renders for any jar with band geometry; the old 'not available' branch is gone", () => {
    const src = ROUTE();
    expect(src).toContain("const jarTamperAllowed = Boolean(jarStandard?.tamper) && jarSpec?.optionalTamperBand !== false;");
    expect(src).not.toContain("Tamper band: not available for");
    for (const key of ["standard/4oz", "standard/3oz"]) {
      const spec = getProductProductionSpec("standard-jars", key)!;
      expect(spec.optionalTamperBand).toBe(true);
      expect(spec.tamperApplicationLaborPending).toBe(true);
    }
    expect(JAR_LABEL_GEOMETRY["4oz"].tamper).toEqual({ widthIn: 7.125, heightIn: 0.5 });
    expect(JAR_LABEL_GEOMETRY["3oz"].tamper).toEqual({ widthIn: 7.06, heightIn: 0.5 });
    expect(jarCutlineFor(JAR_LABEL_GEOMETRY["4oz"]).tamper!.cutWidthIn).toBeCloseTo(7.0, 9);
    expect(jarCutlineFor(JAR_LABEL_GEOMETRY["3oz"]).tamper!.cutWidthIn).toBeCloseTo(6.935, 9);
  });

  it("16. missing band labor = Needs Review with a clear message (no invented seconds)", () => {
    for (const size of ["3oz", "4oz"] as const) {
      expect(JAR_APPLICATION_SECONDS_BY_SIZE[size].tamper).toBeNull();
      const r = resolveJarApplication(size, { side: true, lid: true, tamper: true });
      expect(r.ok).toBe(false);
      expect((r as any).message).toMatch(/^NEEDS REVIEW — missing application timing/);
      expect(resolveJarApplication(size, { side: true, lid: true, tamper: false }).ok).toBe(true); // Side / Lid quote normally
    }
    const summary = summarizeCalculatorBlockers([`${CANONICAL_REASONS.applicationStandardRequired}: x`]) as any;
    expect(JSON.stringify(summary)).toContain("Needs Review — missing owner application timing");
  });
});

describe("Issue 5 — Launch Readiness recognises canonical jar geometry", () => {
  const missing = [RECIPE_MISSING_DIMENSIONS_ISSUE];
  it("17. owner-confirmed jar sizes are dimension-ready without Product Setup width / height", () => {
    for (const name of [
      "4oz Clear Jar with Applied Label", "4oz Black/White Jar with Applied Label", "3oz Clear Jar with Applied Label",
      "100ml Tall Miron Jar with Applied Label", "100ml Wide Miron Jar with Applied Label", "150ml Miron Jar with Applied Label",
      "250ml Miron Jar with Applied Label", "Chiron 150ml jar",
    ]) {
      expect(jarRecipeGeometryStatus({ name }).kind, name).toBe("confirmed");
      expect(readinessIssuesForRecipe({ name }, missing), name).toEqual([]);
    }
    // other real issues are never hidden
    expect(readinessIssuesForRecipe({ name: "4oz Clear Jar with Applied Label" }, [...missing, "recipe has no preferred machine"])).toEqual(["recipe has no preferred machine"]);
  });

  it("18. 50ml stays pending and is named", () => {
    expect(readinessIssuesForRecipe({ name: "50ml Miron Jar with Applied Label", productType: "jar_50ml" }, missing)).toEqual(["Miron 50ml — label geometry pending owner sample"]);
  });

  it("19. any other unresolved jar is named specifically; non-jar recipes keep the generic dimension check", () => {
    expect(readinessIssuesForRecipe({ name: "5oz Clear Jar with Applied Label", productType: "jar_5oz_clear" }, missing)).toEqual(["5oz Clear Jar with Applied Label — not an active jar product; no confirmed label geometry"]);
    expect(readinessIssuesForRecipe({ name: "Custom Vinyl Sticker", productType: "sticker" }, missing)).toEqual(missing);
    const summary = quotePipelineSummary([{ name: "50ml Miron Jar with Applied Label", firstIssue: "Miron 50ml — label geometry pending owner sample" }], 5);
    expect(summary).toBe("Not quote-ready yet: Miron 50ml — label geometry pending owner sample.");
    expect(summary).not.toMatch(/At least/);
    // the agent-queue conversion gate itself is NOT relaxed (it prices from recipe fields)
    expect(readFileSync("app/lib/recipe-pricing.server.ts", "utf8")).toContain('issues.push("recipe is missing width or height");');
  });
});

describe("20. Standard 4x5 does not regress", () => {
  it("geometry, cost and required fields are unchanged", async () => {
    const std = (await costJob("pfamily=sticker-bags&pbagmat=matte&pblank=v_bag&pqty=500&pfaces=1&pbagsides=1&pdesigns=1&pwidth=4&pheight=5&pmat=m_matte&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0")).result;
    expect(std.family).toBe("sticker-bags");
    expect(std.trueCost.totalCost).toBeCloseTo(165.7335, 3);
    expect(bagCutGeometry()["bag-label"]).toMatchObject({ cutWidthIn: 3.79, cutHeightIn: 4.81 });
    expect(withCanonicalSplitBagGeometry(new URLSearchParams("pfamily=sticker-bags&pwidth=4&pheight=5")).toString()).toBe("pfamily=sticker-bags&pwidth=4&pheight=5");
  }, 120_000);
});
