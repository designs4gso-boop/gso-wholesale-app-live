// 2026-11-15 — LIVE BENCHMARK LOCK.
//
// The four Cost Calculator results the owner verified in the live app on
// 2026-11-15 (Split Bag at 85% and at blank gloss coverage; QP / P Bag (14x16)
// 100 front only and 100 front + back), driven through the real loader, plus
// the QP / P Bag rules behind them and the Standard 4x5 / Split Bag numbers
// that QP / P Bag work must never move. If one of these fails, a cost or a
// price changed — do not edit the expected numbers without owner approval.
// (Harness shared with pound-bag-14x16-sticker-bag-2026-11-15.test.ts.)

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
const POUND_14X16 = { id: "v_pound", shop: "shop-1", name: "14x16 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:pound-bag", defaultUnitCost: 1.0, active: true, tiers: [] as any[], addOns: [] };
const dbState: { writes: Array<{ op: string; args: any }>; vendorProducts: any[] } = { writes: [], vendorProducts: [] };

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
      if (name === "vendorProduct" && method === "findMany") return dbState.vendorProducts;
      if (name === "vendorProduct" && method === "findFirst") return dbState.vendorProducts.find((p: any) => p.id === where.id) || null;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any) => (typeof ops === "function" ? ops(db) : Promise.all(ops)) : model(key)) });
  return { default: db, db };
});


import db from "../app/db.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { resolveOwnerResult } from "../app/lib/calculator-owner-view";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { attachPoundBagBlank } from "../app/lib/pound-bag-blank.server";
import { POUND_BAG_14X16_ARTBOARD_IN, POUND_BAG_14X16_BAG_IN, POUND_BAG_14X16_CUTLINE_IN } from "../app/lib/bag-artboard-geometry";
import {
  BAG_4X5_BLANK_UNIT_COST,
  POUND_BAG_14X16_DOUBLE_SIDED_BAGS_PER_HOUR,
  POUND_BAG_14X16_MOQ,
  POUND_BAG_14X16_SINGLE_SIDED_BAGS_PER_HOUR,
  BAG_REASONS,
  bagApplicationCost,
  poundBagApplicationSecondsPerBag,
} from "../app/lib/bag-cost-inputs.server";
import { POUND_BAG_APPROVED_PRICE_LADDER, POUND_BAG_DISPLAY_LADDER, POUND_BAG_PRICE_LADDER_KEY, poundBagMarginPctForQuantity } from "../app/lib/pound-bag-pricing";
import { COST_CALCULATOR_GLOSS_ESTIMATE_PCT } from "../app/lib/gloss-coverage";
import { POUND_BAG_PRICING_BASIS_TEXT } from "../app/lib/calculator-owner-view";

const OWNER = "9001";
beforeEach(() => { process.env[OWNER_USER_IDS_ENV] = OWNER; authState.sub = OWNER; dbState.writes = []; dbState.vendorProducts = [BAG_4X5, { ...POUND_14X16 }]; });
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; delete process.env.GSO_STAFF_ROLES; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; });

type BagType = "4x5" | "split" | "pound";
/** The Cost Calculator URL the browser sends for a Sticker Bag job. `extra` carries the gloss fields. */
const QS = (type: BagType, sides: 1 | 2, qty: number, designs = 1, printer = "mimaki", extra = "&pglosslayers=0") =>
  `pfamily=sticker-bags&pbagmat=matte${type === "split" ? "&psplitbag=1&pblank=preset%3Asplit-bag" : type === "pound" ? "&ppoundbag=1" : "&pblank=vendor%3Av_bag"}&pqty=${qty}&pfaces=${sides}&pbagsides=${sides}&pdesigns=${designs}` +
  `${type === "pound" ? "" : "&pwidth=4&pheight=5"}&pmat=m_matte&pcut=square-rect&pprinter=${printer}&pwhitelayers=0${extra}`;

async function calculate(qs: string): Promise<any> {
  const route: any = await import("../app/routes/app.erp.cost-calculator");
  const data: any = await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) });
  const pm = data.emergency.productMode;
  const row = (pm.tiers || []).find((t: any) => t.requested);
  const result = resolveOwnerResult({
    family: pm.canonicalFamily, stockBag: Boolean(pm.stockBag), splitBag: Boolean(pm.splitBag), poundBag: Boolean(pm.poundBag),
    canonical: pm.canonical ? { status: pm.canonical.status, totalCost: pm.canonical.totalCost, unitCost: pm.canonical.unitCost, blockers: pm.canonical.blockers } : null,
    requestedRow: row, multiLine: pm.multiLine, marginRuleKey: pm.marginFamily?.key || null,
  })!;
  return { pm, row, result };
}
async function job(qs: string): Promise<any> {
  const input = await attachPoundBagBlank({ db, shop: "shop-1" }, normalizeCanonicalInput(new URLSearchParams(qs))!);
  return assembleCanonicalJob(input, await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input)) as any;
}
const line = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;
/** Dollars and cents exactly as the owner reads them on screen. */
const cents = (value: number) => Math.round(value * 100) / 100;

// The live Split Bag job: 3,800 bags, 30 designs, front + back, Poseidon Matte, Roland, 0 white, 1 gloss layer.
const SPLIT_LIVE = (gloss: string) => QS("split", 2, 3800, 30, "roland", `&pglosslayers=1${gloss}`);

describe("LIVE BENCHMARK LOCK — Split Bag (owner live-verified 2026-11-15)", () => {
  it("explicit 85% gloss: $4,164.21 true cost, $8,165.12 price, $2.15 each, 49%", async () => {
    const { pm, result } = await calculate(SPLIT_LIVE("&pglosscoverage=85"));
    expect(pm.splitBag).toBe(true);
    expect(result.state).toBe("READY");
    expect(cents(result.trueJobCost)).toBe(4164.21);
    expect(cents(result.recommendedTotal)).toBe(8165.12);
    expect(cents(result.recommendedUnit)).toBe(2.15);
    expect(Math.round(result.marginPct)).toBe(49);
    expect(result.authority?.kind).toBe("split_bag_sticker_bag_ladder");
  }, 300_000);

  it("blank gloss coverage means 90%: $4,233.32 true cost, $8,300.62 price, $2.18 each, $4,067.31 profit, 49%", async () => {
    expect(COST_CALCULATOR_GLOSS_ESTIMATE_PCT).toBe(90);
    const blank = await calculate(SPLIT_LIVE("&pglosscoverage="));
    const absent = await calculate(SPLIT_LIVE(""));
    const ninety = await calculate(SPLIT_LIVE("&pglosscoverage=90"));
    for (const { result } of [blank, absent, ninety]) {
      expect(cents(result.trueJobCost)).toBe(4233.32);
      expect(cents(result.recommendedTotal)).toBe(8300.62);
      expect(cents(result.recommendedUnit)).toBe(2.18);
      // $4,067.31 on screen; the unrounded figure sits within half a cent of it
      expect(Math.abs(result.profit - 4067.31)).toBeLessThan(0.006);
      expect(Math.round(result.marginPct)).toBe(49);
    }
    // never the old hidden 50% (that priced this job at $3,680.45)
    expect(cents(blank.result.trueJobCost)).not.toBe(3680.45);
    const fifty = await calculate(SPLIT_LIVE("&pglosscoverage=50"));
    expect(fifty.result.trueJobCost).toBeLessThan(blank.result.trueJobCost);
  }, 300_000);

  it("no gloss: the earlier pinned live job is unchanged ($2,792.48 / $5,475.45)", async () => {
    const { result } = await calculate(QS("split", 2, 3800, 30, "roland"));
    expect(result.trueJobCost).toBe(2792.4818066232533);
    expect(result.recommendedTotal).toBe(5475.454522790693);
  }, 300_000);
});

describe("LIVE BENCHMARK LOCK — QP / P Bag (14x16) (owner live-verified 2026-11-15)", () => {
  it("100 front only: $303.71 true cost ($3.0371 each), $573.03 price, $5.73 each, $269.32 profit, 47%", async () => {
    const { pm, result } = await calculate(QS("pound", 1, 100));
    expect(pm.poundBag).toBe(true);
    expect(result.state).toBe("READY");
    expect(cents(result.trueJobCost)).toBe(303.71);
    expect(Math.round(result.trueUnitCost * 10000) / 10000).toBe(3.0371);
    expect(cents(result.recommendedTotal)).toBe(573.03);
    expect(cents(result.recommendedUnit)).toBe(5.73);
    expect(cents(result.profit)).toBe(269.32);
    expect(result.marginPct).toBeCloseTo(47, 6);
    expect(result.authority?.kind).toBe("pound_bag_dedicated_ladder");
    expect(pm.marginFamily.key).toBe(POUND_BAG_PRICE_LADDER_KEY);
  }, 300_000);

  it("100 back only costs and prices exactly like 100 front only", async () => {
    const front = await calculate(QS("pound", 1, 100));
    const back = await calculate(QS("pound", 1, 100).replace("pbagsides=1", "pbagsides=1&pbagside=back"));
    expect(back.result.trueJobCost).toBe(front.result.trueJobCost);
    expect(back.result.recommendedTotal).toBe(front.result.recommendedTotal);
  }, 300_000);

  it("100 front + back: $482.24 true cost ($4.8224 each), $909.88 price, $9.10 each, $427.64 profit, 47%", async () => {
    const { result } = await calculate(QS("pound", 2, 100));
    expect(cents(result.trueJobCost)).toBe(482.24);
    expect(Math.round(result.trueUnitCost * 10000) / 10000).toBe(4.8224);
    expect(cents(result.recommendedTotal)).toBe(909.88);
    expect(cents(result.recommendedUnit)).toBe(9.1);
    expect(cents(result.profit)).toBe(427.64);
    expect(result.marginPct).toBeCloseTo(47, 6);
  }, 300_000);

  it("application labor: $0.40 per front-only bag, $0.6666667 per double-sided bag as ONE operation (never 2 x $0.40)", async () => {
    expect(POUND_BAG_14X16_SINGLE_SIDED_BAGS_PER_HOUR).toBe(50);
    expect(POUND_BAG_14X16_DOUBLE_SIDED_BAGS_PER_HOUR).toBe(30);
    expect(poundBagApplicationSecondsPerBag(1)).toBe(72);
    expect(poundBagApplicationSecondsPerBag(2)).toBe(120);
    expect(bagApplicationCost(1, 1, "pound_bag_14x16")).toBeCloseTo(0.4, 12);
    expect(bagApplicationCost(1, 2, "pound_bag_14x16")).toBeCloseTo(0.6666667, 7);
    expect(line(await job(QS("pound", 1, 100)), "application")).toBeCloseTo(40, 9);
    const both = line(await job(QS("pound", 2, 100)), "application");
    expect(both).toBeCloseTo(66.66667, 4);
    expect(both).not.toBeCloseTo(80, 2); // not two single-sided operations
    expect(both).not.toBeCloseTo(200, 2); // not the old $1.00 per applied label
    // the number of designs never changes application labor
    expect(line(await job(QS("pound", 1, 100, 25)), "application")).toBeCloseTo(40, 9);
  }, 300_000);

  it("blank $1.00 from the 14x16 Blank Bag record, MOQ 4, geometry 14.39 x 16.39 bag / 14.05 x 16.00 sticker, 0% planned overage", async () => {
    const r = await job(QS("pound", 1, 100));
    expect(line(r, "blank_sets")).toBeCloseTo(100 * 1.0, 9);
    expect(line(r, "planned_overage")).toBe(0); // spoilage is an OPEN owner decision — not invented here
    expect(POUND_BAG_14X16_MOQ).toBe(4);
    expect((await job(QS("pound", 1, 3))).reasons).toContain(BAG_REASONS.poundBagBelowMoq);
    expect((await job(QS("pound", 1, 4))).reasons).not.toContain(BAG_REASONS.poundBagBelowMoq);
    expect(POUND_BAG_14X16_BAG_IN).toEqual({ widthIn: 14.39, heightIn: 16.39 });
    expect(POUND_BAG_14X16_ARTBOARD_IN).toEqual({ widthIn: 14.05, heightIn: 16 });
    expect(POUND_BAG_14X16_CUTLINE_IN).toEqual(POUND_BAG_14X16_ARTBOARD_IN);
    // no record -> blocked, never a guessed blank cost
    dbState.vendorProducts = [BAG_4X5];
    const noRecord = await calculate(QS("pound", 1, 100));
    expect(JSON.stringify(noRecord.pm.canonical.blockers)).toContain("BAG_BLANK_COST_REQUIRED");
    expect(noRecord.result.state).not.toBe("READY");
    expect(noRecord.result.recommendedTotal).toBeNull();
  }, 300_000);

  it("pricing ladder: the seven approved anchors, linear between them, flat past 1,000, $75 minimum profit", async () => {
    expect(POUND_BAG_APPROVED_PRICE_LADDER.anchors).toEqual([
      { quantity: 4, marginPct: 55 }, { quantity: 16, marginPct: 53 }, { quantity: 50, marginPct: 50 }, { quantity: 100, marginPct: 47 },
      { quantity: 256, marginPct: 44 }, { quantity: 500, marginPct: 42 }, { quantity: 1000, marginPct: 40 },
    ]);
    expect(POUND_BAG_APPROVED_PRICE_LADDER.minimumProfit).toBe(75);
    expect(POUND_BAG_DISPLAY_LADDER).toEqual([4, 16, 50, 100, 256, 500, 1000]);
    for (const { quantity, marginPct } of POUND_BAG_APPROVED_PRICE_LADDER.anchors) expect(poundBagMarginPctForQuantity(quantity)).toBe(marginPct);
    // linear: halfway between two anchors is halfway between their margins
    expect(poundBagMarginPctForQuantity(10)).toBe(54); // 4 -> 16
    expect(poundBagMarginPctForQuantity(33)).toBe(51.5); // 16 -> 50
    expect(poundBagMarginPctForQuantity(75)).toBe(48.5); // 50 -> 100
    expect(poundBagMarginPctForQuantity(178)).toBe(45.5); // 100 -> 256
    expect(poundBagMarginPctForQuantity(378)).toBe(43); // 256 -> 500
    expect(poundBagMarginPctForQuantity(750)).toBe(41); // 500 -> 1000
    expect(poundBagMarginPctForQuantity(5000)).toBe(40);
    expect(poundBagMarginPctForQuantity(1)).toBe(55);
    // $75 minimum profit controls the smallest job
    const four = await calculate(QS("pound", 1, 4));
    expect(four.result.profit).toBeCloseTo(75, 6);
    expect(cents(four.result.recommendedTotal)).toBe(98.57);
    // 1,000 bags sit exactly on the 40% anchor
    const thousand = await calculate(QS("pound", 1, 1000));
    expect(thousand.result.marginPct).toBeCloseTo(40, 6);
    expect(cents(thousand.result.recommendedTotal)).toBe(4890.02);
  }, 300_000);

  it("tier table shows only this product's own quantities and names its own authority (no inherited 4x5 rows)", async () => {
    const { pm } = await calculate(QS("pound", 1, 100));
    expect(pm.tiers.map((t: any) => t.quantity)).toEqual([4, 16, 50, 100, 256, 500, 1000]);
    expect(pm.tiers.map((t: any) => t.marginPct)).toEqual([55, 53, 50, 47, 44, 42, 40]);
    expect(pm.pricingBasis).toEqual({ kind: "pound_bag_dedicated_ladder", text: POUND_BAG_PRICING_BASIS_TEXT });
    expect(POUND_BAG_PRICING_BASIS_TEXT).not.toMatch(/4x5|researched curve/i);
    for (const tier of pm.tiers) expect(tier.commercial?.marketPosition ?? null).toBeNull(); // no 4x5 market targets
    // an off-anchor quantity is added as its own row, priced on the same ladder
    const odd = await calculate(QS("pound", 1, 64));
    expect(odd.pm.tiers.map((t: any) => t.quantity)).toEqual([4, 16, 50, 64, 100, 256, 500, 1000]);
    expect(odd.row.marginPct).toBe(poundBagMarginPctForQuantity(64));
    // the other bag types carry no QP / P Bag basis line
    expect((await calculate(QS("4x5", 2, 500))).pm.pricingBasis).toBeNull();
    expect((await calculate(QS("split", 2, 500))).pm.pricingBasis).toBeNull();
  }, 300_000);
});

describe("LIVE BENCHMARK LOCK — Standard 4x5 and Split Bag do not move when QP / P Bag changes", () => {
  it("Standard 4x5, 500 front + back: $264.22 true cost, $750.00 price, its own approved margin curve", async () => {
    const { pm, result } = await calculate(QS("4x5", 2, 500));
    expect(pm.poundBag).toBe(false);
    expect(pm.splitBag).toBe(false);
    expect(result.trueJobCost).toBeCloseTo(264.21609508547004, 9);
    expect(result.recommendedTotal).toBeCloseTo(750, 9);
    expect(result.authority?.kind).toBe("approved_margin_curve");
    expect(pm.marginFamily.key).not.toBe(POUND_BAG_PRICE_LADDER_KEY);
    const r = await job(QS("4x5", 2, 500));
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(line(r, "blank_sets")).toBeCloseTo(500 * 0.11, 9);
    expect(line(r, "application")).toBeCloseTo(500 * 2 * (10 / 3600) * 20, 9); // 10 s per applied side — not bag throughput
  }, 300_000);

  it("the 14x16 Blank Bag record and the QP / P Bag ladder change nothing for a 4x5 or a Split Bag", async () => {
    const with4x5 = (await calculate(QS("4x5", 2, 500))).result;
    const withSplit = (await calculate(QS("split", 2, 500))).result;
    dbState.vendorProducts = [BAG_4X5, { ...POUND_14X16, defaultUnitCost: 9.99 }];
    const again4x5 = (await calculate(QS("4x5", 2, 500))).result;
    const againSplit = (await calculate(QS("split", 2, 500))).result;
    expect(again4x5.trueJobCost).toBe(with4x5.trueJobCost);
    expect(again4x5.recommendedTotal).toBe(with4x5.recommendedTotal);
    expect(againSplit.trueJobCost).toBe(withSplit.trueJobCost);
    expect(againSplit.recommendedTotal).toBe(withSplit.recommendedTotal);
    expect(withSplit.authority?.kind).toBe("split_bag_sticker_bag_ladder");
  }, 300_000);
});
