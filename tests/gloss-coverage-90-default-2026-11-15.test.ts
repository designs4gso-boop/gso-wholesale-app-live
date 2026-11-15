// 2026-11-15 LIVE QA BUG - Cost Calculator gloss coverage left blank.
//
// The form says "blank = 90% pre-art estimate", but a blank field reached the
// canonical calculator as null and the ink engine applied its own 50% default:
// the live job below was costed at $3,680.45 instead of the 90% figure.
// Rule: gloss layers > 0 and coverage blank = 90, exactly as if 90 were typed.
// (Harness copied from split-bag-sticker-bag-ladder-2026-11-12.test.ts; the
// job query string here leaves the gloss fields to each test.)

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

import { OWNER_USER_IDS_ENV, resolveOwnerAuthorization } from "../app/lib/owner-authorization.server";
import { SPLIT_BAG_BLANK_UNIT_COST, SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT, SPLIT_BAG_LANDED_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import { BAGS_4X5_DOUBLE_BANDS, BAGS_4X5_SINGLE_BANDS, STICKER_BAG_DISPLAY_LADDER, computeCommercialPrice, defaultPricingPolicyValues, marginCurveKeyFor, marketTargetBandFor } from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { marginFamilyKeyFor } from "../app/lib/product-driven-costing.server";
import {
  APPROVED_MARGIN_CURVE_AUTHORITIES,
  SPLIT_BAG_NO_4X5_MARKET_TARGET,
  SPLIT_BAG_PRICE_AUTHORITY_TEXT,
  SPLIT_BAG_TIER_TABLE_TEXT,
  resolveOwnerResult,
  resolveSellingPriceAuthority,
  tierDesignAssumptionText,
} from "../app/lib/calculator-owner-view";
import { OWNER_OVERRIDABLE_AUTOMATIC_KINDS, ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";
import { itemPricingAuthority, provisionalQuoteStatusCheck } from "../app/lib/quote-pricing-authority";
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

const OWNER = "9001";
const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

const QS = (sides: 1 | 2, qty: number, designs: number, printer = "mimaki") =>
  `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}&pwidth=4&pheight=5` +
  `&pmat=m_matte&pcut=square-rect&pprinter=${printer}&pwhitelayers=0`;

async function calculate(qs: string) {
  const route: any = await import("../app/routes/app.erp.cost-calculator");
  const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) });
  const pm = data.emergency.productMode;
  const row = (pm.tiers || []).find((t: any) => t.requested);
  const result = resolveOwnerResult({
    family: pm.canonicalFamily, stockBag: Boolean(pm.stockBag), splitBag: Boolean(pm.splitBag),
    canonical: pm.canonical ? { status: pm.canonical.status, totalCost: pm.canonical.totalCost, unitCost: pm.canonical.unitCost, blockers: pm.canonical.blockers } : null,
    requestedRow: row, multiLine: pm.multiLine, marginRuleKey: pm.marginFamily?.key || null,
  })!;
  return { pm, row, result };
}

import { COST_CALCULATOR_GLOSS_ESTIMATE_PCT, effectiveGlossCoveragePct, glossCoverageBasis, glossCoverageIsBlank } from "../app/lib/gloss-coverage";
import db from "../app/db.server";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { GLOSS_DEFAULT_COVERAGE_PCT, resolveCoverage } from "../app/lib/machine-calibration.server";
import { ROLAND_INK_CALIBRATION } from "../app/lib/product-driven-costing.server";

// The live job: 3,800 Split Bags, 30 designs, front + back, Poseidon Matte, Roland, 0 white.
const JOB = QS(2, 3800, 30, "roland");
const gloss = (extra: string): Promise<any> => calculate(`${JOB}&pglosslayers=1${extra}`);
const input = (extra: string) => normalizeCanonicalInput(new URLSearchParams(`${JOB}${extra}`))!;
/** The canonical job itself (same normalizer, same engine), for the gloss ink channel the screen total is built from. */
async function job(extra: string) {
  const i = input(extra);
  return assembleCanonicalJob(i, await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, i)) as any;
}
const glossChannel = async (extra: string) => ((await job(extra)).inkChannels || []).find((c: any) => c.kind === "gloss");

// Owner-verified live benchmark (85% entered) and the no-gloss ladder pin that already exists.
const BENCH_85 = { cost: 4164.21, total: 8165.12, unit: 2.15, margin: 49 };
const NO_GLOSS = { cost: 2792.4818066232533, total: 5475.454522790693 };
// What the live calculator returned for a BLANK field before this fix (it was costing 50%).
const BUG_BLANK = { cost: 3680.45, total: 7216.57 };

describe("the one normalization rule (gloss-coverage.ts)", () => {
  it("gloss selected + blank / missing coverage = 90; an entered value is used as entered", () => {
    expect(COST_CALCULATOR_GLOSS_ESTIMATE_PCT).toBe(90);
    expect(effectiveGlossCoveragePct(1, null)).toBe(90);
    expect(effectiveGlossCoveragePct(3, undefined)).toBe(90);
    expect(effectiveGlossCoveragePct(1, 85)).toBe(85);
    expect(effectiveGlossCoveragePct(1, 50)).toBe(50);
    expect(effectiveGlossCoveragePct(1, 90)).toBe(90);
    // an entered value is never replaced by the estimate, even when it is invalid (it still blocks downstream)
    expect(effectiveGlossCoveragePct(1, 0)).toBe(0);
    expect(effectiveGlossCoveragePct(1, 140)).toBe(140);
    // no gloss layers: nothing is invented
    expect(effectiveGlossCoveragePct(0, null)).toBeNull();
  });

  it("6. an empty string is BLANK, never 0", () => {
    for (const blank of [null, undefined, "", " ", "   "]) expect(glossCoverageIsBlank(blank), JSON.stringify(blank)).toBe(true);
    for (const entered of ["0", "85", "90", " 50 "]) expect(glossCoverageIsBlank(entered), entered).toBe(false);
    expect(input("&pglosslayers=1&pglosscoverage=").glossCoveragePct).toBe(90);
    expect(input("&pglosslayers=1&pglosscoverage=%20%20").glossCoveragePct).toBe(90);
    expect(input("&pglosslayers=1&pglosscoverage=").glossCoveragePct).not.toBe(0);
  });

  it("7-8. a query string with the field blank or absent (the reset / default form) gets 90 when gloss is on", () => {
    expect(input("&pglosslayers=1").glossCoveragePct).toBe(90);
    expect(input("&pglosslayers=1&pglosscoverage=").glossCoveragePct).toBe(90);
    expect(input("&pglosslayers=4").glossCoveragePct).toBe(90);
    expect(input("&pglosslayers=1&pglosscoverage=85").glossCoveragePct).toBe(85);
    expect(input("&pglosslayers=1&pglosscoverage=50").glossCoveragePct).toBe(50);
    // gloss off: the calculator input is exactly what it was
    expect(input("&pglosslayers=0").glossCoveragePct).toBeNull();
    expect(input("").glossCoveragePct).toBeNull();
    // the form field has no pre-filled value, so a reset form submits it blank
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src).toContain('<input name="pglosscoverage" type="number" min={0} max={100} step="1" placeholder="90% estimated" defaultValue={urlValue("pglosscoverage")} style={inputStyle} />');
  });

  it("the screen says Estimated: 90% or Entered: N%", () => {
    expect(glossCoverageBasis(1, "")).toEqual({ basis: "estimated", pct: 90, label: "Estimated: 90%" });
    expect(glossCoverageBasis(1, null)).toEqual({ basis: "estimated", pct: 90, label: "Estimated: 90%" });
    expect(glossCoverageBasis(1, "85")).toEqual({ basis: "entered", pct: 85, label: "Entered: 85%" });
    expect(glossCoverageBasis(0, "85")).toEqual({ basis: "none", pct: null, label: null });
    expect(glossCoverageBasis(0, "")).toEqual({ basis: "none", pct: null, label: null });
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src).toContain('glossCoverageBasis(Number(urlValue("pglosslayers", "0")), urlValue("pglosscoverage")).label');
  });

  it("both the calculate and the save path use the one normalizer (no second parser for the canonical input)", () => {
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src).toContain("normalizeCanonicalInput(url.searchParams)");
    expect(src).toContain("normalizeCanonicalInput(psearchParams)");
    const lib = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(lib.match(/glossCoveragePct: effectiveGlossCoveragePct\(/g)).toHaveLength(1);
    expect(lib).not.toContain('glossCoveragePct: String(params.get("pglosscoverage")');
  });
});

describe("live job — 3,800 Split Bags / 30 designs / front + back / Roland / 1 gloss layer", () => {
  it("1-2. blank coverage is costed at 90% and equals an explicit 90 to the cent", async () => {
    const blank = await gloss("");
    const empty = await gloss("&pglosscoverage=");
    const ninety = await gloss("&pglosscoverage=90");
    const chBlank = await glossChannel("&pglosslayers=1");
    const chEmpty = await glossChannel("&pglosslayers=1&pglosscoverage=");
    const chNinety = await glossChannel("&pglosslayers=1&pglosscoverage=90");
    for (const ch of [chBlank, chEmpty, chNinety]) expect(ch.coveragePct).toBe(90);
    for (const ch of [chBlank, chEmpty]) {
      expect(ch.totalMl).toBe(chNinety.totalMl);
      expect(ch.inkCost).toBe(chNinety.inkCost);
    }
    for (const r of [blank, empty]) {
      expect(r.result.trueJobCost).toBe(ninety.result.trueJobCost);
      expect(r.result.recommendedTotal).toBe(ninety.result.recommendedTotal);
      expect(r.result.recommendedUnit).toBe(ninety.result.recommendedUnit);
      expect(r.result.profit).toBe(ninety.result.profit);
    }
    // what 90% produces for this job
    expect(ninety.result.trueJobCost).toBeCloseTo(4233.32, 2);
    expect(ninety.result.trueUnitCost).toBeCloseTo(1.114, 3);
    expect(ninety.result.recommendedTotal).toBeCloseTo(8300.62, 2);
    expect(ninety.result.recommendedUnit).toBeCloseTo(2.18, 2);
    expect(ninety.result.profit).toBeCloseTo(4067.31, 2);
    expect(ninety.result.marginPct).toBeCloseTo(49, 6);
    // and it is no longer the 50% figure the live calculator returned for a blank field
    expect(Math.abs(blank.result.trueJobCost - BUG_BLANK.cost)).toBeGreaterThan(500);
    expect(Math.abs(blank.result.recommendedTotal - BUG_BLANK.total)).toBeGreaterThan(1000);
  }, 300_000);

  it("3. explicit 85% still matches the verified benchmark: $4,164.21 / $8,165.12 / $2.15 / 49%", async () => {
    const r = await gloss("&pglosscoverage=85");
    expect(await glossChannel("&pglosslayers=1&pglosscoverage=85")).toMatchObject({ coveragePct: 85, coverageSource: "explicit" });
    expect(r.result.trueJobCost).toBeCloseTo(BENCH_85.cost, 2);
    expect(r.result.trueUnitCost).toBeCloseTo(1.0958, 4);
    expect(r.result.recommendedTotal).toBeCloseTo(BENCH_85.total, 2);
    expect(r.result.recommendedUnit).toBeCloseTo(BENCH_85.unit, 2);
    expect(r.result.profit).toBeCloseTo(4000.91, 2);
    expect(r.result.marginPct).toBeCloseTo(BENCH_85.margin, 6);
  }, 300_000);

  it("4. explicit 50% uses 50%, not 90%", async () => {
    const fifty = await gloss("&pglosscoverage=50");
    const ninety = await gloss("&pglosscoverage=90");
    const ch50 = await glossChannel("&pglosslayers=1&pglosscoverage=50");
    const ch90 = await glossChannel("&pglosslayers=1&pglosscoverage=90");
    expect(ch50.coveragePct).toBe(50);
    expect(fifty.result.trueJobCost).toBeCloseTo(BUG_BLANK.cost, 2); // 50% is what a blank used to be costed at
    expect(fifty.result.recommendedTotal).toBeCloseTo(BUG_BLANK.total, 2);
    expect(fifty.result.trueJobCost).toBeLessThan(ninety.result.trueJobCost);
    expect(ch50.totalMl / ch90.totalMl).toBeCloseTo(50 / 90, 10);
  }, 300_000);

  it("5, 9. gloss layers 0: no gloss channel and no gloss cost, whatever the coverage field holds; the ladder price is unchanged", async () => {
    for (const extra of ["&pglosslayers=0", "&pglosslayers=0&pglosscoverage=", "&pglosslayers=0&pglosscoverage=85", ""]) {
      const r = await calculate(`${JOB}${extra}`);
      expect(await glossChannel(extra), extra).toBeUndefined();
      expect(r.result.trueJobCost, extra).toBeCloseTo(NO_GLOSS.cost, 6);
      expect(r.result.recommendedTotal, extra).toBeCloseTo(NO_GLOSS.total, 6);
      expect(r.result.marginPct, extra).toBeCloseTo(49, 6);
    }
  }, 300_000);

  it("10. Roland gloss calibration is unchanged: same mL/sqft, ink scales linearly with coverage, machine time does not", async () => {
    const eightyFive = await gloss("&pglosscoverage=85");
    const blank = await gloss("");
    const a = await glossChannel("&pglosslayers=1&pglosscoverage=85");
    const b = await glossChannel("&pglosslayers=1");
    expect(a.mlPerSqftPerPass).toBe(4.18);
    expect(b.mlPerSqftPerPass).toBe(4.18);
    expect(b.passes).toBe(1);
    expect(b.totalMl / a.totalMl).toBeCloseTo(90 / 85, 10);
    expect(b.inkCost / a.inkCost).toBeCloseTo(90 / 85, 10);
    expect(b.costPerMl).toBe(a.costPerMl);
    expect(b.inkableSqft).toBe(a.inkableSqft);
    expect(b.occupancyMinutes).toBe(a.occupancyMinutes);
    // the whole cost difference between 85 and blank (90) is gloss ink — nothing else moved
    expect(blank.result.trueJobCost - eightyFive.result.trueJobCost).toBeCloseTo(b.inkCost - a.inkCost, 6);
    expect(ROLAND_INK_CALIBRATION.glossMlPerSqftPerStage).toBe(2.83);
  }, 300_000);

  it("11. Mimaki gloss stays blocked, blank or entered", async () => {
    for (const extra of ["&pglosslayers=1", "&pglosslayers=1&pglosscoverage=90"]) {
      const r = await calculate(`${QS(2, 3800, 30, "mimaki")}${extra}`);
      expect(JSON.stringify(r.pm.canonical.blockers), extra).toContain("MIMAKI_GLOSS_UNSUPPORTED");
      expect(r.pm.canonical.status, extra).not.toBe("READY");
    }
  }, 300_000);

  it("12. White coverage is unchanged: no default, blank stays null and the job stays draft-only", async () => {
    expect(input("&pwhitelayers=1").whiteCoveragePct).toBeNull();
    expect(input("&pwhitelayers=1&pwhitecoverage=").whiteCoveragePct).toBeNull();
    expect(input("&pwhitelayers=1&pwhitecoverage=60").whiteCoveragePct).toBe(60);
    const r = await calculate(`${JOB.replace("pwhitelayers=0", "pwhitelayers=1")}`);
    expect(JSON.stringify(r.pm.canonical.blockers)).toContain("WHITE_COVERAGE_REQUIRED");
    expect(resolveCoverage("white", null)).toMatchObject({ ok: false, reason: "WHITE_COVERAGE_REQUIRED" });
  }, 300_000);

  it("13. nothing else changed: the ink engine default for callers that send no coverage is still 50%", () => {
    expect(GLOSS_DEFAULT_COVERAGE_PCT).toBe(50);
    expect(resolveCoverage("gloss", null)).toMatchObject({ ok: true, pct: 50, source: "gloss_default" });
    expect(resolveCoverage("gloss", 90)).toMatchObject({ ok: true, pct: 90, source: "explicit" });
    // storefront bag / sticker pricing still send no coverage (not part of this fix)
    expect(readFileSync("app/lib/canonical-bag-pricing.server.ts", "utf8")).toContain("glossCoveragePct: null,");
    expect(readFileSync("app/lib/canonical-sticker-pricing.server.ts", "utf8")).toContain("glossCoveragePct: null,");
  });

  it("the saved quote records 90% as the estimate (same numbers as the screen)", async () => {
    const route: any = await import("../app/routes/app.erp.cost-calculator");
    const save = async (extra: string) => {
      dbState.writes = [];
      const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${JOB}&pglosslayers=1${extra}`, pseltier: "3800", ecustomer: "Gloss Customer" });
      const json = await (await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) })).json();
      expect(json.ok, json.message).toBe(true);
      const item = dbState.writes.find((w) => w.op === "quote.create")!.args.data.items.create[0];
      const channel = JSON.parse(item.costSnapshot).canonical.inkChannels.find((c: any) => c.kind === "gloss");
      return { item, channel };
    };
    const blank = await save("");
    const ninety = await save("&pglosscoverage=90");
    const eightyFive = await save("&pglosscoverage=85");
    expect(blank.channel).toMatchObject({ coveragePct: 90, coverageSource: "estimated_pre_art" });
    expect(ninety.channel).toMatchObject({ coveragePct: 90, coverageSource: "explicit" });
    expect(blank.item.unitCost).toBe(ninety.item.unitCost);
    expect(blank.item.unitPrice).toBe(ninety.item.unitPrice);
    expect(blank.item.unitCost * 3800).toBeCloseTo(4233.32, 2);
    expect(blank.item.unitPrice * 3800).toBeCloseTo(8300.62, 2);
    expect(eightyFive.item.unitCost * 3800).toBeCloseTo(BENCH_85.cost, 2);
    expect(eightyFive.item.unitPrice * 3800).toBeCloseTo(BENCH_85.total, 2);
  }, 300_000);
});
