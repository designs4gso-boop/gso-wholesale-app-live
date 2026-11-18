// 2026-11-17 — MIRON Ceres 50 mL + Yuha 48 and MIRON Ceres 100 mL + Yuha 58.
//
// COSTING setup only. Each finished set is five physical pieces: the jar, its
// matching Yuha Special lid, a body wrap label, a lid top circle label and a
// lid side band label. Every number expected here is the owner's own figure
// (supplier prices, millimetre cut sizes, pack sizes) or an existing canonical
// rule (1% planned jar overage, GSO cutline rule, per-label application
// seconds). Nothing in this file is a selling price.

import { describe, expect, it } from "vitest";

import {
  ACTIVE_JAR_KEYS,
  ACTIVE_JAR_PROFILES,
  activeJarProfile,
  resolveActiveJarProfile,
} from "../app/lib/jar-active-scope";
import {
  JAR_LABEL_GEOMETRY,
  JAR_OWNER_CONFIRMED_GEOMETRY,
  MIRON_CERES_GEOMETRY_STATUS,
  MIRON_CERES_LABEL_CUT_MM,
  jarCutlineFor,
  jarGeometryAuthorityFor,
} from "../app/lib/jar-label-geometry";
import {
  APPLICATION_LABOR_RATE_PER_HOUR,
  JAR_APPLICATION_SECONDS_BY_SIZE,
  JAR_APPLICATION_SECONDS_PENDING_TIMING,
  JAR_FREIGHT_PENDING_LABEL,
  JAR_PLANNED_OVERAGE_PCT,
  MIRON_PALLET_CAPACITY,
  MIRON_SET_COMPONENTS,
  MIRON_SET_COST,
  estimatedSupplierPacks,
  jarFreightPerUnit,
  productionQtyFor,
  resolveJarApplication,
  resolveJarBlankCost,
} from "../app/lib/jar-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { APPROVED_COST_TRUTH, evaluateApprovedItem } from "../app/lib/approved-cost-updates.server";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { classifyCalculatorProduct } from "../app/lib/product-driven-costing.server";
import { getProductProductionSpec } from "../app/lib/product-production-spec";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";

const CERES_50 = "ceres_50ml" as const;
const CERES_100 = "ceres_100ml" as const;
const BOUNDARY_QTYS = [128, 249, 250, 499, 500, 999, 1000, 2499, 2500];

/** An approved Mimaki CMYK calibration, shaped like a real DB row (same harness as the jar scope suite). */
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

/** A full Ceres set job: body wrap + lid top + lid side band. */
const job = (size: string, qty: number, labels: { side?: boolean; lid?: boolean; tamper?: boolean } = { side: true, lid: true, tamper: true }) => {
  const params = new URLSearchParams({ pfamily: "premium-jars", pjarmat: "matte", pprinter: "mimaki", pqty: String(qty), pjar: `miron/${size}`, pcmykcoverage: "40" });
  if (labels.side) params.set("pjarside", "1");
  if (labels.lid) params.set("pjarlid", "1");
  if (labels.tamper) params.set("pjartamper", "1");
  const input = normalizeCanonicalInput(params);
  expect(input, `did not normalise: ${params}`).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};
const lineOf = (result: ReturnType<typeof job>, key: string) => result.trueCost.lines.find((line) => line.key === key)!;

describe("supplier tiers — jar and lid priced separately, jar + lid validation totals", () => {
  const expectTotals = (size: typeof CERES_50 | typeof CERES_100, bands: Array<[number, number, number]>) => {
    for (const quantity of BOUNDARY_QTYS) {
      const [, , total] = bands.find(([min, max]) => quantity >= min && quantity <= max)!;
      const r = resolveJarBlankCost({ brand: "miron", size, quantity });
      expect(r.ok, `${size} ${quantity}`).toBe(true);
      if (!r.ok) continue;
      expect(r.unitCost, `${size} ${quantity}`).toBe(total);
      // the total IS the two supplier components at the same tier
      expect(r.components!.map((c) => c.role)).toEqual(["jar", "lid"]);
      expect(Math.round(r.components!.reduce((t, c) => t + c.unitCost, 0) * 100) / 100, `${size} ${quantity} components`).toBe(total);
    }
  };

  it("Ceres 50 mL + Yuha 48: $2.74 / $2.52 / $2.31 / $2.12 / $1.98", () => {
    expectTotals(CERES_50, [[1, 249, 2.74], [250, 499, 2.52], [500, 999, 2.31], [1000, 2499, 2.12], [2500, Infinity, 1.98]]);
    expect(MIRON_SET_COST[CERES_50]).toEqual([2.74, 2.52, 2.31, 2.12, 1.98]);
  });

  it("Ceres 100 mL + Yuha 58: $3.51 / $3.24 / $2.97 / $2.77 / $2.60", () => {
    expectTotals(CERES_100, [[1, 249, 3.51], [250, 499, 3.24], [500, 999, 2.97], [1000, 2499, 2.77], [2500, Infinity, 2.6]]);
    expect(MIRON_SET_COST[CERES_100]).toEqual([3.51, 3.24, 2.97, 2.77, 2.6]);
  });

  it("each component keeps its own SKU, description and ladder", () => {
    const fifty = MIRON_SET_COMPONENTS[CERES_50]!;
    expect(fifty.jar).toMatchObject({ sku: "HF10685-204", ladder: [1.9, 1.72, 1.55, 1.44, 1.34] });
    expect(fifty.lid).toMatchObject({ sku: "EGA01A1A021-200", name: "Yuha 48 Special lid", description: "Black UREA, violet Phan inlay", ladder: [0.84, 0.8, 0.76, 0.68, 0.64] });
    const hundred = MIRON_SET_COMPONENTS[CERES_100]!;
    expect(hundred.jar).toMatchObject({ sku: "HF10657-204", ladder: [2.46, 2.23, 2.02, 1.9, 1.79] });
    expect(hundred.lid).toMatchObject({ sku: "EGA01A1A022-200", name: "Yuha 58 Special lid", description: "Black UREA, violet Phan inlay", ladder: [1.05, 1.01, 0.95, 0.87, 0.81] });
  });

  it("at 500 the resolved components are jar $1.55 + lid $0.76 (50 mL) and jar $2.02 + lid $0.95 (100 mL)", () => {
    const a = resolveJarBlankCost({ brand: "miron", size: CERES_50, quantity: 500 });
    const b = resolveJarBlankCost({ brand: "miron", size: CERES_100, quantity: 500 });
    expect(a.ok && a.components!.map((c) => [c.sku, c.unitCost])).toEqual([["HF10685-204", 1.55], ["EGA01A1A021-200", 0.76]]);
    expect(b.ok && b.components!.map((c) => [c.sku, c.unitCost])).toEqual([["HF10657-204", 2.02], ["EGA01A1A022-200", 0.95]]);
  });
});

describe("the finished recipe is five pieces: jar, lid, body wrap, lid top, lid side band", () => {
  for (const [size, label] of [[CERES_50, "MIRON Ceres 50 mL + Yuha 48"], [CERES_100, "MIRON Ceres 100 mL + Yuha 58"]] as const) {
    it(`${label}`, () => {
      const result = job(size, 500);
      expect(activeJarProfile("miron", size)!.label).toBe(label);
      // jar + lid
      expect(result.diagnostics.blankComponents!.map((c) => c.role)).toEqual(["jar", "lid"]);
      expect(lineOf(result, "blank_sets").label).toContain(`${label} complete set`);
      // three labels: each one printed, cut and applied
      expect(result.diagnostics.applicationsPerItem).toBe(3);
      expect(result.diagnostics.applicationEvents).toBe(1500);
      expect(result.diagnostics.applicationBreakdown!.pieces.map((p) => p.piece)).toEqual(["side", "lid", "tamper"]);
      expect(Object.keys(result.diagnostics.productSpec!.standard).sort()).toEqual(["lid", "side", "tamper"]);
      // media and ink are real cost lines, not a flat per-label number
      expect(lineOf(result, "print_media").amount).toBeGreaterThan(0);
      expect(result.trueCost.totals.ink).toBeGreaterThan(0);
      // dropping a label drops its media: the three labels are costed individually
      const withoutBand = job(size, 500, { side: true, lid: true });
      expect(lineOf(withoutBand, "print_media").amount).toBeLessThan(lineOf(result, "print_media").amount);
      expect(withoutBand.diagnostics.applicationsPerItem).toBe(2);
    });
  }
});

describe("label geometry — millimetre cut sizes are the source of truth", () => {
  it("stores the owner's cut sizes exactly, in millimetres", () => {
    expect(MIRON_CERES_LABEL_CUT_MM[CERES_50]).toEqual({ side: { widthMm: 166.5, heightMm: 25.3 }, lid: { diameterMm: 45 }, tamper: { widthMm: 165, heightMm: 11 } });
    expect(MIRON_CERES_LABEL_CUT_MM[CERES_100]).toEqual({ side: { widthMm: 198, heightMm: 31 }, lid: { diameterMm: 50.8 }, tamper: { widthMm: 198, heightMm: 10 } });
  });

  it("the engine's derived cutline is the owner's cut size (bleed is added once, never twice)", () => {
    for (const size of [CERES_50, CERES_100]) {
      const mm = MIRON_CERES_LABEL_CUT_MM[size];
      const art = JAR_LABEL_GEOMETRY[size];
      const cut = jarCutlineFor(art);
      const near = (inches: number, millimetres: number) => expect(Math.abs(inches * 25.4 - millimetres)).toBeLessThan(0.005);
      near(cut.side!.cutWidthIn, mm.side.widthMm);
      near(cut.side!.cutHeightIn, mm.side.heightMm);
      near(cut.lid!.cutDiameterIn, mm.lid.diameterMm);
      near(cut.tamper!.cutWidthIn, mm.tamper.widthMm);
      near(cut.tamper!.cutHeightIn, mm.tamper.heightMm);
      // art / print bounds = cut + the single GSO 0.125 in bleed per axis
      near(art.side.widthIn - 0.125, mm.side.widthMm);
      near(art.lid.diameterIn - 0.125, mm.lid.diameterMm);
    }
  });

  it("the lid top stays a circle: ink on the circle area, media on its bounding square", () => {
    const d = JAR_LABEL_GEOMETRY[CERES_50].lid.diameterIn;
    const lidOnly = job(CERES_50, 1000, { lid: true });
    const produced = productionQtyFor(1000);
    expect(lidOnly.diagnostics.inkableArtworkSqft).toBeCloseTo((Math.PI * (d / 2) ** 2 * produced) / 144, 6);
    expect(lidOnly.diagnostics.mediaConsumedSqft).toBeGreaterThan(lidOnly.diagnostics.inkableArtworkSqft);
  });

  it("is preliminary test-fit geometry — never marked owner-confirmed / production-verified", () => {
    expect(MIRON_CERES_GEOMETRY_STATUS).toBe("PHYSICAL SAMPLE TEST-FIT REQUIRED BEFORE PRODUCTION");
    for (const size of [CERES_50, CERES_100]) {
      expect(JAR_OWNER_CONFIRMED_GEOMETRY[size]).toBeUndefined();
      expect(jarGeometryAuthorityFor(size)).toMatchObject({ authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION", ownerConfirmationRequired: true });
      const spec = getProductProductionSpec("premium-jars", `miron/${size}`)!;
      expect(spec.ownerConfirmationRequired).toBe(true);
      expect(spec.sharedSizeKeyNote).toContain(MIRON_CERES_GEOMETRY_STATUS);
      expect(job(size, 500).diagnostics.productSpec!.sharedSizeKeyNote).toContain(MIRON_CERES_GEOMETRY_STATUS);
    }
  });

  it("did not move any existing jar dieline", () => {
    expect(JAR_LABEL_GEOMETRY["50ml"]).toEqual({ side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } });
    expect(JAR_LABEL_GEOMETRY["100ml_wide"]).toEqual({ side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } });
    expect(JAR_LABEL_GEOMETRY["100ml_tall"]).toEqual({ side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } });
  });
});

describe("1% planned jar overage — applied once", () => {
  it("500 finished sets are costed as 505 planned sets; blanks scale with it, application does not", () => {
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(1);
    const result = job(CERES_50, 500);
    expect(result.trueCost.customerFinishedQty).toBe(500);
    expect(result.trueCost.productionQty).toBe(505);
    // jar + lid are bought for 505 — exactly once, not 505 * 1.01
    expect(lineOf(result, "blank_sets").amount).toBeCloseTo(505 * 2.31, 6);
    // the overage is never a second charge
    expect(lineOf(result, "planned_overage").amount).toBe(0);
    // labels are applied to the 500 finished jars only
    expect(result.diagnostics.applicationBreakdown!.finishedUnits).toBe(500);
    // printed labels are produced for the 505
    expect(result.diagnostics.inkableArtworkSqft).toBeGreaterThan(job(CERES_50, 500, { side: true, lid: true }).diagnostics.inkableArtworkSqft);
  });

  it("the supplier tier follows the quantity actually purchased (finished + 1%) — existing jar behaviour, unchanged", () => {
    // 246 finished -> 249 purchased -> under-250 price; 247 finished -> 250 purchased -> 250 price
    expect(productionQtyFor(246)).toBe(249);
    expect(productionQtyFor(247)).toBe(250);
    expect(lineOf(job(CERES_50, 246), "blank_sets").amount).toBeCloseTo(249 * 2.74, 6);
    expect(lineOf(job(CERES_50, 247), "blank_sets").amount).toBeCloseTo(250 * 2.52, 6);
    // 249 finished -> 252 purchased, so it legitimately buys at the 250 price
    expect(lineOf(job(CERES_100, 249), "blank_sets").amount).toBeCloseTo(252 * 3.24, 6);
  });
});

describe("application labor — one application per label, at the existing $20/hr per-label model", () => {
  it("three labels = 12s + 10s + 12s = 34s per finished jar = $0.1889", () => {
    for (const size of [CERES_50, CERES_100]) {
      expect(JAR_APPLICATION_SECONDS_BY_SIZE[size]).toEqual({ side: 12, lid: 10, tamper: 12 });
      const all = resolveJarApplication(size, { side: true, lid: true, tamper: true });
      expect(all.ok && all.secondsPerJar).toBe(34);
      expect(all.ok && all.costPerFinishedUnit).toBeCloseTo((34 / 3600) * APPLICATION_LABOR_RATE_PER_HOUR, 10);
      // not one label's labor for three labels, and not a blanket x3 either
      const one = resolveJarApplication(size, { side: true, lid: false, tamper: false });
      expect(one.ok && one.secondsPerJar).toBe(12);
      // disclosed as the nominal-size timing, not a Ceres-specific measurement
      expect(JAR_APPLICATION_SECONDS_PENDING_TIMING[size]).toContain("not yet timed on a Ceres jar");
      expect(all.ok && all.detail).toContain("not yet timed on a Ceres jar");
    }
  });
});

describe("supplier pack estimates", () => {
  it("50 mL: CEILING(qty / 39); 100 mL: CEILING(qty / 28)", () => {
    const fifty = MIRON_SET_COMPONENTS[CERES_50]!.jar.piecesPerPack;
    const hundred = MIRON_SET_COMPONENTS[CERES_100]!.jar.piecesPerPack;
    expect(fifty).toBe(39);
    expect(hundred).toBe(28);
    expect([128, 250, 500].map((q) => estimatedSupplierPacks(q, fifty))).toEqual([4, 7, 13]);
    expect([128, 250, 500].map((q) => estimatedSupplierPacks(q, hundred))).toEqual([5, 9, 18]);
    expect(estimatedSupplierPacks(1000, fifty)).toBe(Math.ceil(1000 / 39));
    expect(estimatedSupplierPacks(2500, hundred)).toBe(Math.ceil(2500 / 28));
    // the calculator shows the same estimate on the jar component
    expect(job(CERES_50, 128).diagnostics.blankComponents!.find((c) => c.role === "jar")!.estimatedPacks).toBe(4);
    expect(job(CERES_100, 128).diagnostics.blankComponents!.find((c) => c.role === "jar")!.estimatedPacks).toBe(5);
  });

  it("records the supplier sheet quantities as given", () => {
    expect(MIRON_SET_COMPONENTS[CERES_50]!.jar.supplierQuantity).toBe(5616);
    expect(MIRON_SET_COMPONENTS[CERES_50]!.lid.supplierQuantity).toBe(396);
    expect(MIRON_SET_COMPONENTS[CERES_100]!.jar.supplierQuantity).toBe(3584);
    expect(MIRON_SET_COMPONENTS[CERES_100]!.lid.supplierQuantity).toBe(207);
  });
});

describe("unknown data stays unknown — never a fabricated value, never zero", () => {
  it("lid pieces-per-pack is null, and an unknown pack size yields no pack count", () => {
    for (const size of [CERES_50, CERES_100]) {
      expect(MIRON_SET_COMPONENTS[size]!.lid.piecesPerPack).toBeNull();
      expect(MIRON_SET_COMPONENTS[size]!.lid.piecesPerPack).not.toBe(0);
      const lid = job(size, 500).diagnostics.blankComponents!.find((c) => c.role === "lid")!;
      expect(lid.piecesPerPack).toBeNull();
      expect(lid.estimatedPacks).toBeNull();
    }
    expect(estimatedSupplierPacks(500, null)).toBeNull();
    expect(estimatedSupplierPacks(500, 0)).toBeNull();
  });

  it("inbound freight is unknown (null), not $0, and no pallet figure was invented", () => {
    for (const size of [CERES_50, CERES_100]) {
      const freight = jarFreightPerUnit("miron", size);
      expect(freight.perUnit).toBeNull();
      expect(freight.perUnit).not.toBe(0);
      expect(freight.basis).toBe("MISSING_FREIGHT_BASIS");
      expect(freight.source).toContain(JAR_FREIGHT_PENDING_LABEL);
      expect(freight.source).toContain("carton dimensions, packed weights and the lid pieces-per-pack are not confirmed");
      expect(MIRON_PALLET_CAPACITY[size]).toBeUndefined();
    }
  });

  it("the job shows a known subtotal and a PENDING landed cost — never a final unit cost", () => {
    for (const size of [CERES_50, CERES_100]) {
      const result = job(size, 500);
      expect(result.status).toBe("DRAFT_ONLY");
      expect(result.unitCost).toBeNull();
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]).toContain(JAR_FREIGHT_PENDING_LABEL);
      const freightLine = lineOf(result, "inbound_freight");
      expect(freightLine.blocker).toContain("MISSING_FREIGHT_BASIS");
      const landed = result.diagnostics.landedCost!;
      expect(landed.status).toBe("FREIGHT_PENDING");
      expect(landed.label).toBe("FREIGHT PENDING SUPPLIER PACK DATA");
      expect(landed.knownProductionCost).toBeCloseTo(result.trueCost.totalCost, 10);
      expect(landed.knownCostPerFinishedUnit).toBeCloseTo(result.trueCost.totalCost / 500, 10);
      // the known subtotal is every non-freight line
      expect(result.trueCost.totals.inbound_freight).toBe(0);
    }
  });

  it("a jar with a real freight basis is unaffected: no pending banner, a unit cost is published", () => {
    const params = new URLSearchParams({ pfamily: "premium-jars", pjarmat: "matte", pprinter: "mimaki", pqty: "500", pjar: "miron/100ml_wide", pjarside: "1", pjarlid: "1", pcmykcoverage: "40" });
    const result = assembleCanonicalJob(normalizeCanonicalInput(params)!, CAL);
    expect(result.diagnostics.landedCost).toBeUndefined();
    expect(result.diagnostics.blankComponents).toBeUndefined();
    expect(result.unitCost).not.toBeNull();
    expect(lineOf(result, "inbound_freight").amount).toBeGreaterThan(0);
  });
});

describe("no duplicates, no overwritten Miron product", () => {
  it("adds exactly two profiles; every key is unique", () => {
    expect(new Set(ACTIVE_JAR_KEYS).size).toBe(ACTIVE_JAR_KEYS.length);
    expect(ACTIVE_JAR_PROFILES.filter((p) => p.size.startsWith("ceres_")).map((p) => p.key)).toEqual(["miron/ceres_50ml", "miron/ceres_100ml"]);
  });

  it("a Ceres record resolves to the Ceres profile; the generic Miron records still resolve to theirs", () => {
    expect(resolveActiveJarProfile("MIRON Ceres 50 mL + Yuha 48 (jar + lid set)")!.key).toBe("miron/ceres_50ml");
    expect(resolveActiveJarProfile("MIRON Ceres 100 mL + Yuha 58 (jar + lid set)")!.key).toBe("miron/ceres_100ml");
    expect(resolveActiveJarProfile("50ml Miron jar + lid")!.key).toBe("miron/50ml");
    expect(resolveActiveJarProfile("100ml wide Miron jar + lid")!.key).toBe("miron/100ml_wide");
    expect(resolveActiveJarProfile("100ml tall Miron jar + lid")!.key).toBe("miron/100ml_tall");
    expect(resolveActiveJarProfile("Miron Violet Glass Jar 100ml")!.key).toBe("miron/100ml_wide");
  });

  it("the generic Miron ladders are untouched (distinct products: jar + normal SAN lid)", () => {
    expect(MIRON_SET_COST["50ml"]).toEqual([2.47, 2.26, 2.06, 1.93, 1.77]);
    expect(MIRON_SET_COST["100ml_tall"]).toEqual([2.78, 2.54, 2.31, 2.14, 1.99]);
    expect(MIRON_SET_COST["100ml_wide"]).toEqual([2.9, 2.67, 2.44, 2.26, 2.1]);
    expect(MIRON_SET_COMPONENTS["50ml"]).toBeUndefined();
    expect(MIRON_SET_COMPONENTS["100ml_wide"]).toBeUndefined();
  });

  const GENERIC_ROWS = [
    { id: "vp_50", name: "50ml Miron jar + lid", vendor: "MIRON", vendorSku: "preset:miron-50ml", defaultUnitCost: 2.46, notes: null, tiers: [] },
    { id: "vp_100w", name: "100ml wide Miron jar + lid", vendor: "MIRON", vendorSku: "preset:miron-100ml-wide", defaultUnitCost: 2.9, notes: null, tiers: [] },
    { id: "vp_100t", name: "100ml tall Miron jar + lid", vendor: "MIRON", vendorSku: "preset:miron-100ml-tall", defaultUnitCost: 2.78, notes: null, tiers: [] },
  ];
  const registry = (key: string) => APPROVED_COST_TRUTH.find((item) => item.key === key)!;

  it("the cost registry creates ONE set record per product and never matches a generic Miron row", () => {
    for (const [key, sku, name, totals] of [
      ["miron-ceres-50ml", "HF10685-204+EGA01A1A021-200", "MIRON Ceres 50 mL + Yuha 48 (jar + lid set)", MIRON_SET_COST[CERES_50]!],
      ["miron-ceres-100ml", "HF10657-204+EGA01A1A022-200", "MIRON Ceres 100 mL + Yuha 58 (jar + lid set)", MIRON_SET_COST[CERES_100]!],
    ] as const) {
      const item = registry(key);
      expect(APPROVED_COST_TRUTH.filter((entry) => entry.key === key)).toHaveLength(1);
      expect(item.creation).toEqual({ name, productType: "jar", vendor: "MIRON", vendorSku: sku });
      expect(item.tiers!.map((tier) => tier.unitCost)).toEqual(totals);
      expect(item.tiers!.map((tier) => [tier.minQty, tier.maxQty])).toEqual([[1, 249], [250, 499], [500, 999], [1000, 2499], [2500, null]]);
      // with only the generic rows present it CREATES — it does not adopt and overwrite one of them
      const missing = evaluateApprovedItem(item, { vendorProducts: GENERIC_ROWS as any, materials: [], machines: [] });
      expect(missing.row.status).toBe("will_create");
      expect(missing.record).toBeNull();
      // once its own record exists it is matched by SKU and reused, never created again
      const own = { id: "vp_new", name, vendor: "MIRON", vendorSku: sku, defaultUnitCost: 0, notes: null, tiers: [] };
      const existing = evaluateApprovedItem(item, { vendorProducts: [...GENERIC_ROWS, own] as any, materials: [], machines: [] });
      expect(existing.row.status).not.toBe("will_create");
      expect(existing.record?.id).toBe("vp_new");
      // the calculator classes the record as a Miron jar sold with its lid
      expect(classifyCalculatorProduct({ name, productType: "jar", vendor: "MIRON", vendorSku: sku })).toEqual({ klass: "jar_miron", includesTop: true });
    }
  });

  it("the generic Miron registry entries do not match a Ceres record either", () => {
    const ceresRows = [
      { id: "c50", name: "MIRON Ceres 50 mL + Yuha 48 (jar + lid set)", vendor: "MIRON", vendorSku: "HF10685-204+EGA01A1A021-200", defaultUnitCost: 0, notes: null, tiers: [] },
      { id: "c100", name: "MIRON Ceres 100 mL + Yuha 58 (jar + lid set)", vendor: "MIRON", vendorSku: "HF10657-204+EGA01A1A022-200", defaultUnitCost: 0, notes: null, tiers: [] },
    ];
    for (const key of ["miron-50ml", "miron-100ml-tall", "miron-100ml-wide", "miron-150ml", "miron-250ml"]) {
      const result = evaluateApprovedItem(registry(key), { vendorProducts: ceresRows as any, materials: [], machines: [] });
      expect(result.record, key).toBeNull();
    }
  });
});

describe("costing only — no selling price was created", () => {
  it("the Ceres sets have no customer price ladder", () => {
    for (const size of [CERES_50, CERES_100]) {
      const ladder = resolveJarOwnerLadder({ brand: "miron", sizeKey: size, quantity: 500 });
      expect(ladder.ok).toBe(false);
      expect(!ladder.ok && ladder.reason).toBe("NO_OWNER_LADDER");
    }
  });
});
