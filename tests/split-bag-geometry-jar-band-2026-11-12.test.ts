// 2026-11-12 — OWNER CORRECTION before the final smoke test.
//
// 1. Split Bag geometry: its own owner-measured label — art / print 7.20 x
//    4.38 in (area, nesting, media, ink) and cutline 7.07 x 4.26 in (cut
//    path), never the 4x5 artboard or the 4x5 3.79 x 4.81 cutline. $0.25
//    blank, MOQ 64 and one label per printed side (never 4) are unchanged.
// 2. Jar Side Lid / tamper band: selectable on 3oz (art 7.06 x 0.5, cutline
//    6.935 x 0.375) and 4oz (art 7.125 x 0.5, cutline 7.0 x 0.375). Print /
//    media / ink / cut are costed; with no owner application seconds the job
//    stays DRAFT_ONLY (needs review / quote-only) — no labor is invented.

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

import { BAG_4X5_ARTBOARD_IN, SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN, bagLabelGeometryFor } from "../app/lib/bag-artboard-geometry";
import { bagCutGeometry, bagNestingRuns } from "../app/lib/bag-cost-inputs.server";
import { JAR_LABEL_GEOMETRY, jarCutlineFor } from "../app/lib/jar-label-geometry";
import { JAR_APPLICATION_SECONDS_BY_SIZE, jarCutGeometry, resolveJarApplication } from "../app/lib/jar-cost-inputs.server";
import { CANONICAL_REASONS } from "../app/lib/canonical-calculator-shared";
import { buildReadinessChecks } from "../app/lib/owner-readiness";
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


const STD_QS = (sides: 1 | 2, qty = 500) => SPLIT_QS(sides, qty).replace("&psplitbag=1", "").replace("pblank=preset%3Asplit-bag", "pblank=v_bag");
const lineAmount = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount ?? 0;

describe("Split Bag geometry (owner correction 2026-11-12)", () => {
  it("1. Standard 4x5 Sticker Bag keeps 4.00 x 5.00 art and the 3.79 x 4.81 cutline", () => {
    expect(BAG_4X5_ARTBOARD_IN).toEqual({ widthIn: 4, heightIn: 5 });
    expect(BAG_4X5_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    expect(bagLabelGeometryFor("sticker_bag_4x5")).toMatchObject({ artboard: { widthIn: 4, heightIn: 5 }, cutline: { widthIn: 3.79, heightIn: 4.81 } });
    expect(bagNestingRuns(10)[0].items[0]).toMatchObject({ widthIn: 4, heightIn: 5 });
    expect(bagCutGeometry()["bag-label"]).toMatchObject({ cutWidthIn: 3.79, cutHeightIn: 4.81 });
    expect(bagCutGeometry("stock_bag")["bag-label"]).toMatchObject({ cutWidthIn: 3.79, cutHeightIn: 4.81 });
    expect(getProductProductionSpec("sticker-bags", "bag-4x5/sticker")!.pieces).toEqual([{ piece: "label", shape: "rect", widthIn: 4, heightIn: 5, quantityPerProduct: 1, label: "Applied label (per printed side)" }]);
  });

  it("2/3. Split Bag uses art 7.20 x 4.38 and cutline 7.07 x 4.26 — exact owner values, never 3.79 x 4.81", () => {
    expect(SPLIT_BAG_ARTBOARD_IN).toEqual({ widthIn: 7.2, heightIn: 4.38 });
    expect(SPLIT_BAG_CUTLINE_IN).toEqual({ widthIn: 7.07, heightIn: 4.26 });
    // the exact owner values, not the generic -0.125 rule (7.075 x 4.255)
    expect(SPLIT_BAG_CUTLINE_IN.widthIn).not.toBeCloseTo(7.2 - 0.125, 4);
    expect(bagNestingRuns(10, "split_bag")[0].items[0]).toMatchObject({ widthIn: 7.2, heightIn: 4.38 });
    const cut = bagCutGeometry("split_bag")["bag-label"] as any;
    expect(cut).toMatchObject({ cutWidthIn: 7.07, cutHeightIn: 4.26 });
    expect([cut.cutWidthIn, cut.cutHeightIn]).not.toEqual([3.79, 4.81]);
    const spec = getProductProductionSpec("split-bags", "split-bag")!;
    expect(spec.pieces).toEqual([expect.objectContaining({ widthIn: 7.2, heightIn: 4.38, cutWidthIn: 7.07, cutHeightIn: 4.26 })]);
    expect(JSON.stringify(spec.pieces) + spec.statusNote).not.toMatch(/3\.79|4\.81/);
  });

  it("4/5/6/7. qty 500: front-only and back-only = 500 blanks + 500 faces; front+back = 500 blanks + 1,000 faces (never 2,000); blank $125", () => {
    for (const sides of [1, 2] as const) {
      const r = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides });
      expect(r.bagQuantity).toBe(500);
      expect(r.labelQuantity).toBe(500 * sides);
      expect(r.labelQuantity).not.toBe(2000);
      expect(r.application.applicationEvents).toBe(500 * sides);
      expect(r.blankCost).toBeCloseTo(125, 10);
    }
  });

  it("4/5. front-only and back-only are the same one-face job in the calculator (pbagsides=1)", async () => {
    // The calculator posts one printed side for either Front only or Back only.
    const one = (await costJob(SPLIT_QS(1, 500))).result;
    expect(one.diagnostics.physicalItems ?? 500).toBe(500);
    expect(one.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * 7.2 * 4.38) / 144, 6);
    expect(lineAmount(one, "blank_sets")).toBeCloseTo(125, 6);
  }, 120_000);

  it("8. MOQ remains 64", () => {
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 63, sides: 1 }).reasons).toContain("SPLIT_BAG_BELOW_MOQ");
    expect(computeBagPhysical({ product: "split_bag", bagQuantity: 64, sides: 1 }).reasons).not.toContain("SPLIT_BAG_BELOW_MOQ");
  });

  it("9. media / ink area rises versus the incorrect 4x5 assumption (canonical job, qty 500)", async () => {
    for (const sides of [1, 2] as const) {
      const split = (await costJob(SPLIT_QS(sides, 500))).result;
      const std = (await costJob(STD_QS(sides, 500))).result;
      expect(split.family).toBe("split-bags");
      expect(std.family).toBe("sticker-bags");
      // ink area = printed faces x 7.20 x 4.38 in (front+back = 1,000 faces, never 2,000)
      expect(split.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * sides * 7.2 * 4.38) / 144, 6);
      expect(std.diagnostics.inkableArtworkSqft).toBeCloseTo((500 * sides * 4 * 5) / 144, 6);
      expect(split.diagnostics.mediaConsumedSqft).toBeGreaterThan(std.diagnostics.mediaConsumedSqft);
      expect(lineAmount(split, "print_media")).toBeGreaterThan(lineAmount(std, "print_media"));
      expect(lineAmount(split, "ink")).toBeGreaterThan(lineAmount(std, "ink"));
      expect(lineAmount(split, "blank_sets")).toBeCloseTo(125, 6);
      expect(split.diagnostics.productSpec!.standard.label).toEqual({ widthIn: 7.2, heightIn: 4.38, cutWidthIn: 7.07, cutHeightIn: 4.26 });
      expect(std.diagnostics.productSpec!.standard.label).toMatchObject({ widthIn: 4, heightIn: 5, cutWidthIn: 3.79, cutHeightIn: 4.81 });
    }
  }, 120_000);

  it("10. cut path uses 7.07 x 4.26 per printed face", () => {
    for (const sides of [1, 2] as const) {
      const r = computeBagPhysical({ product: "split_bag", bagQuantity: 500, sides });
      expect(r.finishing.cutPathIn).toBeCloseTo(500 * sides * 2 * (7.07 + 4.26), 6);
    }
  });

  it("UI: Split Bag shows its fixed geometry and never asks for 4 x 5 dimensions; the standard 4x5 is labelled distinctly", () => {
    const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(route).toContain('"SPLIT BAG production spec" : "STANDARD 4X5 STICKER BAG production spec"');
    expect(route).toContain('<input type="hidden" name="pwidth" value={SPLIT_BAG_ARTBOARD_IN.widthIn} />');
    expect(route).toContain('<input type="hidden" name="pheight" value={SPLIT_BAG_ARTBOARD_IN.heightIn} />');
    expect(route).toContain("{!isDtp && !jars && !isSplitBag ? (<>");
  });
});

/* ---------------- jar Side Lid / tamper band ---------------- */
const CAL: any = {
  calibration: {
    id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  },
  calibrationMessage: "approved", inkCostPerMl: 0.2, inkCostSource: "test",
};
const jarRun = (key: string, extra = "") =>
  assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(`pfamily=standard-jars&pjarmat=matte&pprinter=mimaki&pqty=500&pjar=${key}&pjarvariant=clear&pjarside=1&pjarlid=1&pcmykcoverage=40${extra}`))!, CAL);

describe("jar Side Lid / tamper band (owner correction 2026-11-12)", () => {
  const cases = [
    { n: 11, size: "4oz", key: "standard/4oz", art: { widthIn: 7.125, heightIn: 0.5 }, cut: { w: 7.0, h: 0.375 } },
    { n: 12, size: "3oz", key: "standard/3oz", art: { widthIn: 7.06, heightIn: 0.5 }, cut: { w: 6.935, h: 0.375 } },
  ] as const;

  for (const c of cases) {
    it(`${c.n}. ${c.size} Side Lid option exists: art ${c.art.widthIn} x ${c.art.heightIn}, cutline ${c.cut.w} x ${c.cut.h}`, () => {
      const spec = getProductProductionSpec("standard-jars", c.key)!;
      expect(spec.optionalTamperBand).toBe(true);
      expect(spec.tamperApplicationLaborPending).toBe(true);
      expect(JAR_LABEL_GEOMETRY[c.size].tamper).toEqual(c.art);
      const cutline = jarCutlineFor(JAR_LABEL_GEOMETRY[c.size]).tamper!;
      expect(cutline.cutWidthIn).toBeCloseTo(c.cut.w, 9);
      expect(cutline.cutHeightIn).toBeCloseTo(c.cut.h, 9);
      const cutMap = jarCutGeometry(c.size) as Record<string, any>;
      const band = cutMap[Object.keys(cutMap).find((k) => k.includes("tamper"))!];
      expect(band.cutWidthIn).toBeCloseTo(c.cut.w, 9);
      expect(band.cutHeightIn).toBeCloseTo(c.cut.h, 9);
      const piece = spec.pieces.find((p) => p.piece === "tamper") as any;
      expect(piece).toMatchObject({ widthIn: c.art.widthIn, heightIn: c.art.heightIn });
      expect(piece.cutWidthIn).toBeCloseTo(c.cut.w, 9);
      expect(piece.cutHeightIn).toBeCloseTo(c.cut.h, 9);
    });

    it(`13. ${c.size} band: print / media / ink / cut costed, NO application seconds invented, job stays needs-review (DRAFT_ONLY)`, () => {
      expect(JAR_APPLICATION_SECONDS_BY_SIZE[c.size].tamper).toBeNull();
      expect(resolveJarApplication(c.size, { side: true, lid: true, tamper: true }).ok).toBe(false);
      const withBand = jarRun(c.key, "&pjartamper=1");
      const without = jarRun(c.key);
      expect(withBand.status).toBe("DRAFT_ONLY");
      expect(withBand.unitCost).toBeNull();
      expect(withBand.reasons).toContain(CANONICAL_REASONS.applicationStandardRequired);
      expect((withBand.diagnostics.productSpec as any).cutline.tamper.cutWidthIn).toBeCloseTo(c.cut.w, 9);
      for (const key of ["print_media", "ink", "cutting_machine"]) {
        expect(lineAmount(withBand, key), key).toBeGreaterThan(lineAmount(without, key));
      }
      expect(withBand.diagnostics.applicationBreakdown ?? null).toBeNull(); // no invented band seconds
      // 14. ordinary Side + Lid still quotes normally
      expect(without.blockers).toHaveLength(0);
      expect(without.unitCost).not.toBeNull();
    });
  }

  it("14. sizes with owner band timing are unchanged; readiness keeps 3oz/4oz band labor pending", () => {
    for (const size of ["50ml", "100ml_tall", "100ml_wide", "150ml", "250ml"] as const) {
      expect(JAR_APPLICATION_SECONDS_BY_SIZE[size].tamper).toBe(12);
      expect(resolveJarApplication(size, { side: true, lid: true, tamper: true }).ok).toBe(true);
    }
    const band = buildReadinessChecks({
      ownerIdsConfigured: 1, temporaryAllStaff: false, staffRoleAssignments: 0, authorizedManagers: 0, activeConfiguratorProducts: 0, configuratorProductsMissingShopifyIds: 0,
      mimakiWhiteCalibrationApproved: false, jar50mlConfirmed: false, bandSecondsMissingSizes: ["3oz", "4oz"], bannerFinishingUnverified: [], splitBagPackoutModeled: false,
      operationalMigrationActivated: false, calibrationMinSamples: null,
    }).find((check) => check.key === "jar-band-labor")!;
    expect(band.tone).toBe("amber");
    expect(band.detail).toMatch(/needs-review \(quote-only\)/);
  });
});
