// 2026-11-20 — DECISION SUPPORT ONLY (docs/GSO_PRICING_ENGINE_DECISION.md).
//
// Computes, from literal fixtures and with NO database, the two cost bases
// that exist today for Stock Bags, Sticker Bags and stickers:
//
//   ENGINE A  the STOREFRONT basis — computeProductDrivenCost, exactly as
//             canonicalStockBagJob / priceStickerConfiguration call it.
//   ENGINE B  the COST CALCULATOR basis — the canonical true-cost engine
//             (computeCanonicalJob), fed production-shaped calibration rows.
//
// Both costs go through the SAME computeCommercialPrice call (the storefront
// one), so the only thing that differs between the two prices is the cost.
//
// This file changes nothing and pins NO dollar amount: it asserts only
// structural facts (both engines compute, the table is complete). It writes
// nothing to disk and prints nothing. The calibration rows are the one
// DB-only input of ENGINE B (MachineProfileCalibration); the values below are
// the same production-shaped fixture commercial-price-safety-2026-10-07 uses.

import { describe, expect, it } from "vitest";
import { computeCanonicalJob, normalizeCanonicalInput } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { canonicalStockBagJob, type CanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";
import { priceStickerConfiguration, STICKER_HOLO_MIN_PREMIUM_PCT, type CanonicalStickerInputs } from "../app/lib/canonical-sticker-pricing.server";
import { computeCommercialPrice, defaultPricingPolicyValues, marginCurveKeyFor, specialtyFinishReasons } from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { computeProductDrivenCost } from "../app/lib/product-driven-costing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { BAG_4X5_BLANK_UNIT_COST } from "../app/lib/bag-cost-inputs.server";

/* ---- fixtures (same shapes as the existing price-safety suites) ---- */
const MEASURED: Record<string, { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const SHOP = "fixture-shop.example";
const CAL_ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`, shop: SHOP, ...identity, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null, timeModel: "variable_only",
  measuredAt: new Date("2026-08-18T00:00:00Z"), effectiveFrom: new Date("2026-08-18T00:00:00Z"), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date("2026-08-18T00:00:00Z"), ...MEASURED[key],
}));
/** Read-only double: the only model ENGINE B reads. */
const db = { machineProfileCalibration: { findMany: async ({ where }: any) => CAL_ROWS.filter((row) => Object.entries(where).every(([field, value]) => (field === "shop" ? row.shop === value : (row as any)[field] === value))) } };

const POLICY = defaultPricingPolicyValues();
const MATTE = { name: "Poseidon Matte", costPerSqft: 213 / 675 };
const HOLO = { name: "Holographic", costPerSqft: 0.7141463415 };
const ROLAND_SQFT_PER_HOUR = 150;
const BAG_INPUTS: CanonicalBagInputs = {
  available: true, reasons: [], matte: MATTE, holographic: HOLO,
  blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: BAG_4X5_BLANK_UNIT_COST, tiers: [] },
  rolandSqftPerHour: ROLAND_SQFT_PER_HOUR, policyValues: POLICY,
};
const STICKER_INPUTS: CanonicalStickerInputs = { available: true, reasons: [], matte: MATTE, holographic: HOLO, rolandSqftPerHour: ROLAND_SQFT_PER_HOUR, policyValues: POLICY };

const QUANTITIES = [50, 100, 250, 500, 1000, 2500];
const round2 = (value: number) => Math.round(value * 100) / 100;

type ComparisonRow = {
  family: "Stock Bags" | "Sticker Bags" | "Stickers";
  config: string;
  quantity: number;
  costA: number; costB: number | null;
  priceA: number; priceB: number | null;
  ruleA: string; ruleB: string | null;
  linesA: Array<{ label: string; amount: number }>;
  linesB: Array<{ label: string; amount: number }>;
  blockersB: string[];
};

/* ---- ENGINE A, bags: the exact computeProductDrivenCost call canonicalStockBagJob makes ---- */
function bagRunA(o: { quantity: number; faces: number; glossLayers: number; holographic: boolean }) {
  const whiteLayers = o.holographic ? 1 : 0;
  const printer: "mimaki" | "roland" = o.glossLayers > 0 || whiteLayers > 0 || o.holographic ? "roland" : "mimaki";
  const material = o.holographic ? HOLO : MATTE;
  return computeProductDrivenCost({
    family: "bags-4x5", quantity: o.quantity, designs: 1, facesPerUnit: o.faces, widthIn: 4, heightIn: 5, labelRows: null, dtp: null,
    blank: { name: BAG_INPUTS.blank!.name, unitCost: BAG_INPUTS.blank!.unitCost, tiers: [], status: "verified" }, lid: null,
    material: { name: material.name, costPerSqft: material.costPerSqft }, printer, printerHasWhite: true, printerHasGloss: printer === "roland",
    whiteLayers, glossLayers: o.glossLayers, glossCoveragePct: null, inkMlPerSqft: 0.6, machineMinutesPerSqft: 0,
    machineSqftPerHour: printer === "roland" ? ROLAND_SQFT_PER_HOUR : 0, machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: null, cutRequiresWeeding: false, hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated",
    recipeWastePct: null, wasteOverride: null, boxOverride: null,
  } as any);
}

/** The storefront bag price policy, fed any cost. Mirrors canonicalStockBagJob + the storefront unit rounding. */
function bagPriceFor(completeCost: number, run: ReturnType<typeof bagRunA>, o: { quantity: number; faces: number; glossLayers: number; holographic: boolean }) {
  const whiteLayers = o.holographic ? 1 : 0;
  const material = o.holographic ? HOLO : MATTE;
  const commercial = computeCommercialPrice({
    familyKey: "sticker-bags", quantity: o.quantity, completeCost, marginRule: resolveMarginFamily("bags-4x5"), premiumEligible: false,
    finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, policyValues: POLICY,
    marginCurveKey: marginCurveKeyFor("bags-4x5", o.faces),
    marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers, glossLayers: o.glossLayers, materialName: material.name }),
    specialty: { glossLayers: o.glossLayers, decorativeWhiteLayers: 0, requiredWhite: o.holographic, holographic: o.holographic },
  });
  const unit = round2(commercial.finalTotalPrice / o.quantity);
  return { total: round2(unit * o.quantity), rule: commercial.controllingRule };
}

async function canonical(query: string) {
  const input = normalizeCanonicalInput(new URLSearchParams(query));
  if (!input) throw new Error(`query did not normalise: ${query}`);
  return computeCanonicalJob({ db, shop: SHOP }, input);
}

async function bagRow(family: "Stock Bags" | "Sticker Bags", o: { quantity: number; faces: number; glossLayers: number; holographic: boolean }): Promise<ComparisonRow> {
  const run = bagRunA(o);
  const a = bagPriceFor(run.totalCost, run, o);
  const query = `pfamily=sticker-bags&pbagmat=${o.holographic ? "holographic" : "matte"}${family === "Stock Bags" ? "&pstockbag=1" : ""}&pqty=${o.quantity}&pbagsides=${o.faces}&pdesigns=1&pprinter=${o.holographic || o.glossLayers > 0 ? "auto" : "mimaki"}`
    + `&pwhitelayers=${o.holographic ? 1 : 0}${o.holographic ? "&pwhitecoverage=100" : ""}&pglosslayers=${o.glossLayers}`;
  const b = await canonical(query);
  const usable = b.unitCost != null && b.totalCost > 0;
  const priceB = usable ? bagPriceFor(b.totalCost, run, o) : null;
  return {
    family, quantity: o.quantity,
    config: `${o.holographic ? "Holographic" : "Matte"}, ${o.glossLayers}X gloss, ${o.faces === 2 ? "double" : "single"} sided`,
    costA: run.totalCost, costB: usable ? b.totalCost : null, priceA: a.total, priceB: priceB?.total ?? null, ruleA: a.rule, ruleB: priceB?.rule ?? null,
    linesA: run.lines.map((line: any) => ({ label: String(line.label), amount: Number(line.amount) || 0 })),
    linesB: b.trueCost.lines.map((line) => ({ label: `${line.key}: ${line.label}`, amount: Number(line.amount) || 0 })),
    blockersB: b.blockers,
  };
}

/* ---- ENGINE A, stickers: the exact computeProductDrivenCost call priceStickerConfiguration makes ---- */
function stickerRunA(o: { quantity: number; widthIn: number; heightIn: number; glossLayers: number; holographic: boolean }) {
  const whiteLayers = o.holographic ? 1 : 0;
  const printer: "mimaki" | "roland" = o.glossLayers > 0 || whiteLayers > 0 || o.holographic ? "roland" : "mimaki";
  const material = o.holographic ? HOLO : MATTE;
  return computeProductDrivenCost({
    family: "stickers-labels", quantity: o.quantity, designs: 1, facesPerUnit: 1, widthIn: o.widthIn, heightIn: o.heightIn, labelRows: null, dtp: null, blank: null, lid: null,
    material: { name: material.name, costPerSqft: material.costPerSqft }, printer, printerHasWhite: true, printerHasGloss: printer === "roland",
    whiteLayers, glossLayers: o.glossLayers, glossCoveragePct: null, inkMlPerSqft: 0.6, machineMinutesPerSqft: 0,
    machineSqftPerHour: printer === "roland" ? ROLAND_SQFT_PER_HOUR : 0, machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated",
    recipeWastePct: null, wasteOverride: null, boxOverride: null,
  } as any);
}

/** The storefront sticker price policy (before the holographic x1.20 floor), fed any cost. */
function stickerPolicyUnit(completeCost: number, run: ReturnType<typeof stickerRunA>, o: { quantity: number; glossLayers: number; holographic: boolean }) {
  const whiteLayers = o.holographic ? 1 : 0;
  const material = o.holographic ? HOLO : MATTE;
  const commercial = computeCommercialPrice({
    familyKey: "stickers-labels", quantity: o.quantity, completeCost, marginRule: resolveMarginFamily("stickers-labels"), premiumEligible: false,
    finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, policyValues: POLICY, marginCurveKey: marginCurveKeyFor("stickers-labels", 1),
    marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers, glossLayers: o.glossLayers, materialName: material.name }),
    specialty: { glossLayers: o.glossLayers, decorativeWhiteLayers: 0, requiredWhite: o.holographic, holographic: o.holographic },
  });
  return { unit: round2(commercial.finalTotalPrice / o.quantity), rule: commercial.controllingRule };
}

const stickerQuery = (o: { quantity: number; widthIn: number; heightIn: number; glossLayers: number; holographic: boolean }) =>
  `pfamily=stickers-labels&pllines=1&pqty=${o.quantity}&pl0qty=${o.quantity}&pl0w=${o.widthIn}&pl0h=${o.heightIn}&pl0mat=${o.holographic ? "holographic" : "matte"}&pl0art=A&pprinter=${o.holographic || o.glossLayers > 0 ? "auto" : "mimaki"}`
  + `&pwhitelayers=${o.holographic ? 1 : 0}${o.holographic ? "&pwhitecoverage=100" : ""}&pglosslayers=${o.glossLayers}`;

async function stickerRow(o: { quantity: number; widthIn: number; heightIn: number; glossLayers: number; holographic: boolean }): Promise<ComparisonRow> {
  const run = stickerRunA(o);
  const b = await canonical(stickerQuery(o));
  const usable = b.unitCost != null && b.totalCost > 0;
  let unitB: { unit: number; rule: string } | null = usable ? stickerPolicyUnit(b.totalCost, run, o) : null;
  if (unitB && o.holographic) {
    // Owner 16F.1 floor, applied the way the storefront applies it: HOLO >= equivalent MATTE x 1.20.
    const matte = { ...o, holographic: false };
    const matteB = await canonical(stickerQuery(matte));
    if (matteB.unitCost != null) {
      const floor = round2(stickerPolicyUnit(matteB.totalCost, stickerRunA(matte), matte).unit * (1 + STICKER_HOLO_MIN_PREMIUM_PCT));
      if (floor > unitB.unit) unitB = { unit: floor, rule: "holographic minimum premium (matte x1.2)" };
    }
  }
  // ENGINE A price is the REAL storefront function, not a re-derivation.
  const specialty = ["Standard — 0X", "Spot Gloss — 1X", "Raised — 2X", "Raised+ — 3X"][o.glossLayers];
  const a = priceStickerConfiguration(STICKER_INPUTS, { productType: "sticker_regular", widthIn: o.widthIn, heightIn: o.heightIn, quantity: o.quantity, material: o.holographic ? "Holographic" : "Matte", specialty });
  if (!a.ok) throw new Error(`storefront could not price: ${a.reason}`);
  return {
    family: "Stickers", quantity: o.quantity,
    config: `${o.widthIn}x${o.heightIn} in, ${o.holographic ? "Holographic" : "Matte"}, ${o.glossLayers}X gloss`,
    costA: run.totalCost, costB: usable ? b.totalCost : null, priceA: a.orderTotal, priceB: unitB ? round2(unitB.unit * o.quantity) : null, ruleA: a.controllingRule, ruleB: unitB?.rule ?? null,
    linesA: run.lines.map((line: any) => ({ label: String(line.label), amount: Number(line.amount) || 0 })),
    linesB: b.trueCost.lines.map((line) => ({ label: `${line.key}: ${line.label}`, amount: Number(line.amount) || 0 })),
    blockersB: b.blockers,
  };
}

async function buildTable(): Promise<ComparisonRow[]> {
  const rows: ComparisonRow[] = [];
  for (const family of ["Stock Bags", "Sticker Bags"] as const) {
    for (const holographic of [false, true]) for (const glossLayers of [0, 3]) for (const faces of [1, 2]) for (const quantity of QUANTITIES) {
      rows.push(await bagRow(family, { quantity, faces, glossLayers, holographic }));
    }
  }
  for (const [widthIn, heightIn] of [[2, 2], [3, 3], [4, 4]]) {
    for (const holographic of [false, true]) for (const glossLayers of [0, 3]) for (const quantity of QUANTITIES) {
      rows.push(await stickerRow({ quantity, widthIn, heightIn, glossLayers, holographic }));
    }
  }
  return rows;
}

describe("pricing engine comparison 2026-11-20 — storefront cost basis (A) vs Cost Calculator cost basis (B)", () => {
  it("the fixture blank is the owner $0.11 authority and ENGINE A here is the live storefront engine", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    for (const o of [{ quantity: 500, faces: 2, glossLayers: 0, holographic: false }, { quantity: 1000, faces: 2, glossLayers: 3, holographic: true }, { quantity: 50, faces: 1, glossLayers: 3, holographic: false }]) {
      const run = bagRunA(o);
      const job = canonicalStockBagJob(BAG_INPUTS, { ...o, whiteLayers: o.holographic ? 1 : 0 });
      if (!job.available) throw new Error("storefront bag engine unavailable");
      expect(run.totalCost).toBeCloseTo(job.totalCost, 8);
      const storefront = priceStorefrontConfiguration(BAG_INPUTS, { quantity: o.quantity, faces: o.faces, material: o.holographic ? "Holographic" : "Matte", finish: o.glossLayers ? `${o.glossLayers}X Spot Gloss` : "No Spot Gloss" });
      if (!storefront.ok) throw new Error("storefront could not price");
      expect(bagPriceFor(run.totalCost, run, o).total).toBeCloseTo(storefront.totalPrice, 2);
    }
  });

  it("both engines compute a cost and a price for every Stock Bag, Sticker Bag and sticker configuration", async () => {
    const rows = await buildTable();
    expect(rows.length).toBe(2 * 2 * 2 * 2 * QUANTITIES.length + 3 * 2 * 2 * QUANTITIES.length);
    for (const family of ["Stock Bags", "Sticker Bags", "Stickers"]) expect(rows.some((row) => row.family === family)).toBe(true);
    for (const row of rows) {
      const where = `${row.family} · ${row.config} · ${row.quantity}`;
      expect(row.costA, where).toBeGreaterThan(0);
      expect(row.priceA, where).toBeGreaterThan(0);
      expect(row.blockersB, where).toEqual([]);
      expect(row.costB, where).not.toBeNull();
      expect(row.costB!, where).toBeGreaterThan(0);
      expect(row.priceB!, where).toBeGreaterThan(0);
      expect(row.linesA.length, where).toBeGreaterThan(0);
      expect(row.linesB.length, where).toBeGreaterThan(0);
      // Same price policy on both sides: a price never sits below its own cost.
      expect(row.priceA, where).toBeGreaterThan(row.costA);
      expect(row.priceB!, where).toBeGreaterThan(row.costB!);
    }
  });
});
