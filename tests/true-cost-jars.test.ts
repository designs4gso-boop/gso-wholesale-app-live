// Patch 2A (17D.2) — canonical true-cost engine, jars.
//
// Every component is derived and asserted individually, so a drift names its
// own line rather than hiding inside a total. The owner's working targets
// ($2.53 Chiron / $2.84 Miron) are recorded as REFERENCE only and deliberately
// not asserted — the known unknowns (nesting model, run labor) are documented
// as explicit gaps instead of being closed with an invented number.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  JAR_ART_SETUP_BASE,
  JAR_ART_SETUP_TAMPER_ADD,
  JAR_LABEL_GEOMETRY,
  JAR_PLANNED_OVERAGE_PCT,
  JAR_PRINT_SETUP_PER_JOB,
  JAR_UNITS_PER_BOX,
  PACKOUT_TOTAL_PER_BOX,
  applicationCostPerJar,
  inkableArtworkSqInPerSet,
  jarFreightPerUnit,
  jarSetupCost,
  materialFootprintSqInPerSet,
  packoutFor,
  productionQtyFor,
  resolveJarBlankCost,
  type JarLabelSelection,
  type JarSizeKey,
} from "../app/lib/jar-cost-inputs.server";
import {
  DEFAULT_OPERATOR_ATTENTION_PCT,
  DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR,
  OPERATOR_ATTENTION_CLASSIFICATION,
  computeTrueJobCost,
  type TrueCostInput,
} from "../app/lib/true-cost-engine.server";
import { APPROVED_ROLL_COSTS } from "../app/lib/approved-cost-updates.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import type { CalibrationRecord } from "../app/lib/machine-calibration.server";

const MATTE_PER_SQFT = APPROVED_ROLL_COSTS.poseidonMattePerSqft; // 213 / 675
const MIMAKI_PER_ML = CANONICAL_INK_RATES.mimakiCmykPerMl; // 176 / 1000
const EQUIP_RATE = 8;
const SIDE_LID: JarLabelSelection = { side: true, lid: true, tamper: false };

/** Production MachineProfileCalibration row 1 — Mimaki heavy CMYK. */
const MIMAKI_HEAVY_CMYK: CalibrationRecord = {
  id: "cal_mimaki", shop: "942075-2.myshopify.com",
  machineKey: "mimaki-ucjv300-130", inkMode: "cmyk_heavy",
  ripProfile: "PVC Gloss / Mimaki Vision Vinyl", qualityMode: "Fast Print High",
  resolution: "600x1200 VD", passConfig: "32-pass-bidi-op1",
  mlPerSqftPerPass: 1.89, inkAreaBasis: "inkable_artwork",
  minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
  fixedMinutes: null, timeModel: "variable_only", coverageBasisPct: null,
  measuredAt: new Date("2026-08-18"), effectiveFrom: new Date("2026-08-18"), effectiveTo: null,
  status: "approved", source: "owner-measured", notes: null, supersedesId: null,
};

/** Production row 3 — Roland White HD 1X (coverage-gated). */
const ROLAND_WHITE: CalibrationRecord = {
  ...MIMAKI_HEAVY_CMYK, id: "cal_white",
  machineKey: "roland-lg-640", inkMode: "white",
  ripProfile: "Generic Sign Production", qualityMode: "High Quality",
  resolution: "720x1200", passConfig: "white-hd-1x",
  mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100,
};

/**
 * Build a full jar job. ripLayoutSqft has NO nesting model in the repo, so the
 * caller must say where it came from; using the material footprint as a proxy
 * is labelled and forces PROVISIONAL.
 */
function jarJob(opts: {
  size: JarSizeKey;
  brand: "miron" | "chiron" | "standard";
  qty: number;
  selection?: JarLabelSelection;
  calibration?: CalibrationRecord | null;
  coveragePct?: number | null;
  runLabor?: TrueCostInput["runLabor"];
  variant?: "clear" | "black_white";
}) {
  const selection = opts.selection ?? SIDE_LID;
  const production = productionQtyFor(opts.qty);
  const inkableArtworkSqft = (inkableArtworkSqInPerSet(opts.size, selection) * production) / 144;
  const materialFootprintSqft = (materialFootprintSqInPerSet(opts.size, selection) * production) / 144;
  const setup = jarSetupCost(selection);

  const input: TrueCostInput = {
    customerFinishedQty: opts.qty,
    productionQty: production,
    overagePct: JAR_PLANNED_OVERAGE_PCT,
    areas: {
      inkableArtworkSqft,
      materialFootprintSqft,
      ripLayoutSqft: materialFootprintSqft,
      ripLayoutBasis: "PROXY: material footprint used because no nesting model exists.",
    },
    blank: (() => {
      const r = resolveJarBlankCost({ brand: opts.brand, size: opts.size, quantity: production, variant: opts.variant });
      return r.ok
        ? { ok: true as const, unitCost: r.unitCost, label: `${opts.brand} ${opts.size} complete set`, source: r.source }
        : { ok: false as const, reason: r.reason, message: r.message };
    })(),
    material: { name: "Poseidon Matte", costPerSqft: MATTE_PER_SQFT, source: "Verified roll $213 / 675 sqft." },
    calibration: opts.calibration === undefined ? MIMAKI_HEAVY_CMYK : opts.calibration,
    calibrationMessage: "no approved calibration for this exact identity.",
    inkCostPerMl: MIMAKI_PER_ML,
    inkCostSource: "Mimaki LUS-170 $176/1000 mL.",
    coveragePct: opts.coveragePct,
    passCount: 1,
    application: { costPerFinishedUnit: applicationCostPerJar(selection), note: "Owner standard $20/hr; side 45s + lid 22s = 67s." },
    setup: { art: setup.art, print: setup.print, groups: setup.designs },
    runLabor: opts.runLabor ?? { mode: "operator_attention" as const },
    equipmentRatePerHour: EQUIP_RATE,
    packout: packoutFor(opts.size, opts.qty),
    freight: jarFreightPerUnit(opts.brand, opts.size),
  };
  return { input, result: computeTrueJobCost(input) };
}

const amountOf = (r: ReturnType<typeof computeTrueJobCost>, key: string) => r.lines.find((l) => l.key === key)?.amount ?? NaN;

/* ================================================================== *
 * E. GOLD STANDARD — Chiron 100ml Wide
 * ================================================================== */

describe("E. gold standard — 1000 Chiron 100ml Wide, Matte, heavy CMYK, side+lid", () => {
  const { result } = jarJob({ size: "100ml_wide", brand: "chiron", qty: 1000 });

  it("derives production quantity from the 1% planned overage", () => {
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(1);
    expect(result.productionQty).toBe(1010);
    expect(result.customerFinishedQty).toBe(1000);
  });

  it("keeps the three areas distinct — the circular lid is not a bounding box", () => {
    const g = JAR_LABEL_GEOMETRY["100ml_wide"];
    const lidCircle = Math.PI * Math.pow(g.lid.diameterIn / 2, 2);
    const lidBox = g.lid.diameterIn * g.lid.diameterIn;
    expect(lidCircle).toBeCloseTo(2.8353, 4);
    expect(lidBox).toBeCloseTo(3.61, 4);
    expect(lidBox / lidCircle).toBeCloseTo(1.2732, 4); // 27% larger

    expect(result.areas.inkableArtworkSqft).toBeCloseTo(140.2451, 3);
    expect(result.areas.materialFootprintSqft).toBeCloseTo(145.678472, 5);
    expect(result.areas.inkableArtworkSqft).not.toBeCloseTo(result.areas.materialFootprintSqft, 2);
  });

  it("blanks price at PRODUCTION qty on the flat Chiron set cost", () => {
    expect(amountOf(result, "blank_sets")).toBeCloseTo(1010 * 1.8, 6); // 1818.00
  });

  it("print media uses the material footprint at the verified matte rate", () => {
    expect(MATTE_PER_SQFT).toBeCloseTo(213 / 675, 10);
    expect(amountOf(result, "print_media")).toBeCloseTo(145.678472 * MATTE_PER_SQFT, 4); // ~45.9697
  });

  it("ink uses the INKABLE ARTWORK area and the calibrated 1.89 mL/sqft", () => {
    const expectedMl = 140.2451 * 1.89;
    expect(amountOf(result, "ink")).toBeCloseTo(expectedMl * MIMAKI_PER_ML, 3); // 46.651005
    // the wrong denominator would have produced a materially different number
    expect(amountOf(result, "ink")).not.toBeCloseTo(145.678472 * 1.89 * MIMAKI_PER_ML, 2);
  });

  it("setup is one design for side+lid: $12.50 art + $2.00 print", () => {
    expect(amountOf(result, "art_setup")).toBe(12.5);
    expect(amountOf(result, "print_setup")).toBe(2.0);
    expect(result.totals.setup_labor).toBe(14.5);
  });

  it("application charges FINISHED qty only, at 67 s per jar", () => {
    expect(applicationCostPerJar(SIDE_LID)).toBeCloseTo((67 / 3600) * 20, 10); // 0.372222
    expect(amountOf(result, "application")).toBeCloseTo(1000 * 0.3722222, 4); // 372.22
    // explicitly NOT production qty
    expect(amountOf(result, "application")).not.toBeCloseTo(1010 * 0.3722222, 2);
  });

  it("packout uses the per-size box density on finished qty", () => {
    expect(JAR_UNITS_PER_BOX["100ml_wide"]).toBe(100);
    expect(PACKOUT_TOTAL_PER_BOX).toBe(3.5);
    expect(amountOf(result, "packout")).toBeCloseTo(10 * 3.5, 6); // 35.00
  });

  it("freight is the invoice-derived Chiron allowance on PRODUCTION qty", () => {
    const f = jarFreightPerUnit("chiron", "100ml_wide");
    expect(f.perUnit).toBe(0.139);
    expect(f.basis).toBe("PROVISIONAL_INVOICE_DERIVED");
    expect(amountOf(result, "inbound_freight")).toBeCloseTo(1010 * 0.139, 6); // 140.39
  });

  it("planned overage is a quantity effect, never a second charge", () => {
    expect(amountOf(result, "planned_overage")).toBe(0);
    expect(result.totals.planned_overage).toBe(0);
  });

  it("produces a PROVISIONAL numeric result and records why", () => {
    expect(result.status).toBe("PROVISIONAL");
    expect(result.blockers).toEqual([]);
    expect(result.provisionalReasons.join(" ")).toMatch(/OWNER_APPROVED_PROVISIONAL/);
    expect(result.provisionalReasons.join(" ")).toMatch(/Operator attention 10%/);
    expect(result.provisionalReasons.join(" ")).toMatch(/PROXY|proxy/);
    expect(result.provisionalReasons.join(" ")).toMatch(/INVOICE_DERIVED/);
  });

  it("REFERENCE ONLY: derived unit cost vs the owner working target $2.53", () => {
    const unit = result.unitCost!;
    expect(unit).toBeGreaterThan(0);
    // documented, not asserted against the target — the residual is the
    // measure of the two known gaps (nesting model, run labor)
    const gap = 2.53 - unit;
    expect(Number.isFinite(gap)).toBe(true);
  });
});

/* ================================================================== *
 * F. GENUINE MIRON — 100ml Tall
 * ================================================================== */

describe("F. genuine Miron — 1000 100ml Tall, Matte, heavy CMYK, side+lid", () => {
  const { result } = jarJob({ size: "100ml_tall", brand: "miron", qty: 1000 });

  it("selects the 1000+ Miron tier for the complete set", () => {
    const r = resolveJarBlankCost({ brand: "miron", size: "100ml_tall", quantity: 1010 });
    expect(r.ok && r.unitCost).toBe(2.14);
    expect(r.ok && r.tierMinQty).toBe(1000);
    expect(amountOf(result, "blank_sets")).toBeCloseTo(1010 * 2.14, 6); // 2161.40
  });

  it("uses the verified Miron pallet capacity, not the invoice-derived table", () => {
    const f = jarFreightPerUnit("miron", "100ml_tall");
    expect(f.perUnit).toBeCloseTo(315 / 3360, 10); // 0.09375
    expect(f.basis).toBe("PROVISIONAL_SUPPLIER_PALLET");
    expect(amountOf(result, "inbound_freight")).toBeCloseTo(1010 * (315 / 3360), 6); // 94.69
  });

  it("derives areas from the 100ml Tall geometry", () => {
    expect(result.areas.inkableArtworkSqft).toBeCloseTo(156.061005, 5);
    expect(result.areas.materialFootprintSqft).toBeCloseTo(160.670660, 5);
  });

  it("ink and machine consume DIFFERENT area bases", () => {
    const inkLine = result.lines.find((l) => l.key === "ink")!;
    const machineLine = result.lines.find((l) => l.key === "machine")!;
    expect(inkLine.formula).toContain("inkable_artwork");
    expect(machineLine.formula).toContain("rip_layout");
  });

  it("machine recovery uses 1.444 min/sqft at $8/hr", () => {
    const expected = ((160.670660 * 1.444) / 60) * EQUIP_RATE;
    expect(amountOf(result, "machine")).toBeCloseTo(expected, 3); // ~30.93
  });

  it("produces a PROVISIONAL numeric result", () => {
    expect(result.status).toBe("PROVISIONAL");
    expect(result.blockers).toEqual([]);
    expect(result.unitCost).toBeGreaterThan(0);
  });

  it("REFERENCE ONLY: derived unit cost vs the owner working target $2.84", () => {
    expect(Number.isFinite(2.84 - result.unitCost!)).toBe(true);
  });
});

/* ================================================================== *
 * G. DRAFT-ONLY / BLOCKED CASES
 * ================================================================== */

describe("G. draft-only cases — never $0, never inferred", () => {
  it("Chiron 50ml has no verified blank cost -> MISSING_COST, DRAFT_ONLY, no unit cost", () => {
    const { result } = jarJob({ size: "50ml", brand: "chiron", qty: 1000 });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.blockers.join(" ")).toContain("MISSING_COST");
    expect(amountOf(result, "blank_sets")).toBe(0);
    // and no cost was silently inferred from another size or brand
    const r = resolveJarBlankCost({ brand: "chiron", size: "50ml", quantity: 1000 });
    expect(r.ok).toBe(false);
  });

  it("White selected with no coverage -> WHITE_COVERAGE_REQUIRED, DRAFT_ONLY", () => {
    const { result } = jarJob({ size: "100ml_tall", brand: "miron", qty: 1000, calibration: ROLAND_WHITE, coveragePct: null });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.blockers.join(" ")).toContain("WHITE_COVERAGE_REQUIRED");
    expect(amountOf(result, "ink")).toBe(0);
  });

  it("White WITH explicit coverage computes normally", () => {
    const { result } = jarJob({ size: "100ml_tall", brand: "miron", qty: 1000, calibration: ROLAND_WHITE, coveragePct: 60 });
    expect(result.blockers.join(" ")).not.toContain("WHITE_COVERAGE_REQUIRED");
    expect(amountOf(result, "ink")).toBeCloseTo(156.0576 * 0.6 * 6.0 * CANONICAL_INK_RATES.rolandPerMl * (MIMAKI_PER_ML / CANONICAL_INK_RATES.rolandPerMl), 2);
  });

  it("Emboss/Raised has no calibration -> MISSING_CALIBRATION, DRAFT_ONLY", () => {
    const { result } = jarJob({ size: "100ml_tall", brand: "miron", qty: 1000, calibration: null });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.blockers.join(" ")).toContain("MISSING_CALIBRATION");
    // both ink AND machine block — neither silently falls back
    expect(amountOf(result, "ink")).toBe(0);
    expect(amountOf(result, "machine")).toBe(0);
  });

  it("unknown exact machine profile -> MISSING_CALIBRATION (same path, no neighbour)", () => {
    const { result } = jarJob({ size: "150ml", brand: "miron", qty: 500, calibration: null });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join(" ")).toContain("MISSING_CALIBRATION");
  });

  it("missing freight basis is explicit, never fabricated", () => {
    const f = jarFreightPerUnit("standard", "250ml");
    expect(f.perUnit).toBeNull();
    expect(f.basis).toBe("MISSING_FREIGHT_BASIS");
    const { result } = jarJob({ size: "250ml", brand: "standard", qty: 500 });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(amountOf(result, "inbound_freight")).toBe(0);
  });

  it("no nesting model -> machine recovery blocks rather than guessing", () => {
    const { input } = jarJob({ size: "150ml", brand: "miron", qty: 500 });
    const blocked = computeTrueJobCost({
      ...input,
      areas: { ...input.areas, ripLayoutSqft: null, ripLayoutBasis: "none" },
    });
    expect(blocked.status).toBe("DRAFT_ONLY");
    expect(blocked.blockers.join(" ")).toContain("MISSING_NESTING_MODEL");
  });
});

/* ================================================================== *
 * Freight amendment
 * ================================================================== */

describe("freight amendment — invoice-derived allowances", () => {
  it("carries every owner-supplied per-unit allowance", () => {
    const expected: Array<[JarSizeKey, number]> = [
      ["100ml_tall", 0.139], ["100ml_wide", 0.139], ["150ml", 0.16], ["3oz", 0.089], ["4oz", 0.129],
    ];
    for (const [size, perUnit] of expected) {
      const f = jarFreightPerUnit("chiron", size);
      expect(f.perUnit, size).toBe(perUnit);
      expect(f.basis, size).toBe("PROVISIONAL_INVOICE_DERIVED");
      expect(f.provisional, size).toBe(true);
    }
  });

  it("is never classified as fully verified", () => {
    const src = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    expect(src).toContain("PROVISIONAL_INVOICE_DERIVED");
    expect(src.includes('"VALID"')).toBe(false);
    // the mixed invoices are documented as mixed
    expect(src).toContain("Mixed-shipment invoices");
  });

  it("Miron keeps its verified-capacity pallet allocation", () => {
    expect(jarFreightPerUnit("miron", "50ml").perUnit).toBeCloseTo(315 / 5376, 10);
    expect(jarFreightPerUnit("miron", "100ml_wide").perUnit).toBeCloseTo(315 / 3080, 10);
    expect(jarFreightPerUnit("miron", "250ml").perUnit).toBeCloseTo(315 / 1760, 10);
  });

  it("freight is applied once, on production qty only", () => {
    const { result } = jarJob({ size: "3oz", brand: "standard", qty: 1000, variant: "clear" });
    expect(result.productionQty).toBe(1010);
    expect(amountOf(result, "inbound_freight")).toBeCloseTo(1010 * 0.089, 6);
    expect(result.totals.planned_overage).toBe(0); // no second overage charge
  });
});

/* ================================================================== *
 * Setup / geometry / box-density contract
 * ================================================================== */

describe("owner rule contract", () => {
  it("tamper adds a second design at +$10 art and NO extra print setup", () => {
    const withTamper = jarSetupCost({ side: true, lid: true, tamper: true });
    expect(withTamper.art).toBe(JAR_ART_SETUP_BASE + JAR_ART_SETUP_TAMPER_ADD); // 22.50
    expect(withTamper.print).toBe(JAR_PRINT_SETUP_PER_JOB); // 2.00
    expect(withTamper.total).toBe(24.5);
    expect(withTamper.designs).toBe(2);
  });

  it("tamper adds 45 s of application labor", () => {
    expect(applicationCostPerJar({ side: true, lid: true, tamper: true })).toBeCloseTo((112 / 3600) * 20, 10);
    expect(applicationCostPerJar({ side: true, lid: false, tamper: false })).toBeCloseTo((45 / 3600) * 20, 10); // 0.25
    expect(applicationCostPerJar({ side: false, lid: true, tamper: false })).toBeCloseTo((22 / 3600) * 20, 10); // 0.122222
  });

  it("box density is per size, not a flat 100", () => {
    expect(JAR_UNITS_PER_BOX).toEqual({
      "50ml": 100, "100ml_tall": 100, "100ml_wide": 100, "150ml": 50, "250ml": 25, "3oz": 150, "4oz": 100,
    });
    expect(packoutFor("250ml", 1000).boxes).toBe(40);
    expect(packoutFor("3oz", 1000).boxes).toBe(7); // ceil(1000/150)
  });

  it("carries the owner geometry presets with a circular lid", () => {
    expect(JAR_LABEL_GEOMETRY["150ml"].side).toEqual({ widthIn: 7.125, heightIn: 3.125 });
    expect(JAR_LABEL_GEOMETRY["150ml"].lid.diameterIn).toBe(2.0);
    // the 150ml single-set artwork area matches the Roland field measurement
    const perSet = inkableArtworkSqInPerSet("150ml", { side: true, lid: true, tamper: true });
    expect(perSet).toBeCloseTo(29.6822, 4);
  });

  it("Miron ladder tiers step, never interpolate", () => {
    expect(resolveJarBlankCost({ brand: "miron", size: "100ml_tall", quantity: 249 }).ok && resolveJarBlankCost({ brand: "miron", size: "100ml_tall", quantity: 249 })).toMatchObject({ unitCost: 2.78 });
    expect(resolveJarBlankCost({ brand: "miron", size: "100ml_tall", quantity: 700 })).toMatchObject({ unitCost: 2.31 });
    expect(resolveJarBlankCost({ brand: "miron", size: "100ml_tall", quantity: 99999 })).toMatchObject({ unitCost: 1.99 });
  });
});

/* ================================================================== *
 * H. LIVE-PRICING SAFETY
 * ================================================================== */

describe("H. live-pricing safety — Patch 2A moves nothing", () => {
  it("no live pricing or storefront module imports the new engine", () => {
    for (const file of [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/lib/product-driven-costing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("true-cost-engine"), file).toBe(false);
      expect(src.includes("jar-cost-inputs"), file).toBe(false);
    }
  });

  it("the jar selling ladder is untouched", () => {
    const src = readFileSync("app/lib/canonical-jar-pricing.ts", "utf8");
    expect(src).toContain('"100ml": [');
    expect(src).toContain("{ minQty: 1000, priceEach: 3.5 }");
    expect(src).toContain("JAR_HOLOGRAPHIC_PCT = 0.2");
  });

  it("the new engine contains no selling-price or margin logic", () => {
    const src = readFileSync("app/lib/true-cost-engine.server.ts", "utf8");
    expect(/marginPct|sellPrice|recommendedUnitPrice|computeCommercialPrice/.test(src)).toBe(false);
  });

  it("purchasing rates are unchanged and no money lives in a calibration", () => {
    expect(APPROVED_ROLL_COSTS.poseidonMattePerSqft).toBeCloseTo(213 / 675, 10);
    expect(CANONICAL_INK_RATES.mimakiCmykPerMl).toBe(176 / 1000);
    expect(CANONICAL_INK_RATES.rolandPerMl).toBe(149 / 750);
    expect(MIMAKI_HEAVY_CMYK).not.toHaveProperty("costPerMl");
  });

  it("the engine is pure — no db, no prisma, no network", () => {
    const src = readFileSync("app/lib/true-cost-engine.server.ts", "utf8");
    expect(/PrismaClient|db\.|fetch\(|process\.env/.test(src)).toBe(false);
  });
});

/* ================================================================== *
 * 10. CROSS-FAMILY ARCHITECTURE — one engine, many adapters
 *
 * These call the engine with NO jar adapter at all, proving the core is
 * product-agnostic and that bags / stickers / DTP / boxes / banners can be
 * added as adapters without touching the engine.
 * ================================================================== */

const ENGINE_SRC = readFileSync("app/lib/true-cost-engine.server.ts", "utf8");

/** A minimal non-jar job: a generic printed product, no adapter involved. */
function genericJob(over: Partial<TrueCostInput> = {}): TrueCostInput {
  return {
    customerFinishedQty: 500,
    productionQty: 505,
    overagePct: 1,
    areas: {
      inkableArtworkSqft: 40,
      ripLayoutSqft: 55,
      materialFootprintSqft: 50,
      ripLayoutBasis: "nested layout supplied by adapter",
    },
    blank: { ok: true, unitCost: 0.09, label: "4x5 blank bag", source: "verified vendor tier" },
    material: { name: "Poseidon Matte", costPerSqft: MATTE_PER_SQFT, source: "verified roll" },
    calibration: MIMAKI_HEAVY_CMYK,
    inkCostPerMl: MIMAKI_PER_ML,
    inkCostSource: "Mimaki LUS-170",
    application: { secondsPerFinishedUnit: 28.125, laborRatePerHour: 20 },
    setup: { art: 12.5, print: 2, groups: 1 },
    runLabor: { mode: "operator_attention" },
    equipmentRatePerHour: EQUIP_RATE,
    packout: { unitsPerBox: 1000, laborPerBox: 2, consumablesPerBox: 1.5 },
    freight: { perUnit: 0.02, basis: "PROVISIONAL_INVOICE_DERIVED", provisional: true, source: "carton derived" },
    ...over,
  };
}

describe("10. cross-family architecture proof", () => {
  it("A. the engine contains no jar-family constants in its code", () => {
    const code = ENGINE_SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // Word-boundary matching: a naive substring check hits "lid" inside
    // "VALID" and would fail on the engine's own status vocabulary.
    for (const term of ["jar", "jars", "lid", "lids", "Chiron", "Miron", "100ml", "150ml", "3oz", "4oz", "jarsPerBox", "JAR_"]) {
      const pattern = new RegExp(`\\b${term.replace(/_/g, "_")}\\b`, "i");
      expect(pattern.test(code), `engine code must not mention "${term}"`).toBe(false);
    }
    expect(ENGINE_SRC.includes("jar-cost-inputs")).toBe(false);
    expect(ENGINE_SRC.match(/^import /gm)).toHaveLength(1);
  });

  it("B. White/Gloss compute from generic inputs with no adapter", () => {
    const white = computeTrueJobCost(genericJob({ calibration: ROLAND_WHITE, coveragePct: 40, passCount: 2 }));
    const inkLine = white.lines.find((l) => l.key === "ink")!;
    expect(inkLine.amount).toBeCloseTo(192 * MIMAKI_PER_ML, 6);
    expect(inkLine.formula).toContain("inkable_artwork");

    const blocked = computeTrueJobCost(genericJob({ calibration: ROLAND_WHITE, coveragePct: null }));
    expect(blocked.status).toBe("DRAFT_ONLY");
    expect(blocked.blockers.join(" ")).toContain("WHITE_COVERAGE_REQUIRED");
  });

  it("B2. machine uses ripLayout while ink uses inkableArtwork — on a non-jar job", () => {
    const r = computeTrueJobCost(genericJob());
    const ink = r.lines.find((l) => l.key === "ink")!;
    const machine = r.lines.find((l) => l.key === "machine")!;
    expect(ink.formula).toContain("inkable_artwork");
    expect(machine.formula).toContain("rip_layout");
    expect(ink.amount).toBeCloseTo(40 * 1.89 * MIMAKI_PER_ML, 6);
    expect(machine.amount).toBeCloseTo(((55 * 1.444) / 60) * EQUIP_RATE, 6);
  });

  it("C. freight is generic — adapter supplies value, basis and status", () => {
    const r = computeTrueJobCost(genericJob());
    expect(r.lines.find((l) => l.key === "inbound_freight")!.amount).toBeCloseTo(505 * 0.02, 6);
    expect(r.status).toBe("PROVISIONAL");

    const missing = computeTrueJobCost(
      genericJob({ freight: { perUnit: null, basis: "MISSING_FREIGHT_BASIS", provisional: true, source: "no carton data" } }),
    );
    expect(missing.status).toBe("DRAFT_ONLY");
    expect(missing.blockers.join(" ")).toContain("MISSING_FREIGHT_BASIS");
    expect(ENGINE_SRC.includes("0.139")).toBe(false);
    expect(ENGINE_SRC.includes("315")).toBe(false);
  });

  it("D. packout is generic — rates or a precomputed cost", () => {
    const byRate = computeTrueJobCost(genericJob());
    expect(byRate.lines.find((l) => l.key === "packout")!.amount).toBeCloseTo(3.5, 6);

    const byCost = computeTrueJobCost(genericJob({ packout: { boxes: 4, unitsPerBox: 125, cost: 14 } }));
    expect(byCost.lines.find((l) => l.key === "packout")!.amount).toBe(14);
    expect(ENGINE_SRC.includes("unitsPerBox: 100")).toBe(false);
  });

  it("E. application is generic — seconds+rate, or a precomputed per-unit cost", () => {
    const bySeconds = computeTrueJobCost(genericJob());
    expect(bySeconds.lines.find((l) => l.key === "application")!.amount).toBeCloseTo(500 * (28.125 / 3600) * 20, 6);

    const byCost = computeTrueJobCost(genericJob({ application: { costPerFinishedUnit: 0.5 } }));
    expect(byCost.lines.find((l) => l.key === "application")!.amount).toBeCloseTo(250, 6);
    expect(ENGINE_SRC.includes("67 / 3600")).toBe(false);
  });

  it("F. setup groups can exceed 1 — a 13-design label job", () => {
    const r = computeTrueJobCost(genericJob({ setup: { art: 13 * 12.5, print: 13 * 2, groups: 13 } }));
    expect(r.lines.find((l) => l.key === "art_setup")!.label).toContain("13 setup group(s)");
    expect(r.totals.setup_labor).toBeCloseTo(13 * 14.5, 6);

    const withSpecialty = computeTrueJobCost(genericJob({ setup: { art: 12.5, print: 2, specialty: 6.25, groups: 1 } }));
    expect(withSpecialty.totals.setup_labor).toBeCloseTo(20.75, 6);
  });

  it("G. cutting / weeding enter as generic finishing stages, no engine change", () => {
    const r = computeTrueJobCost(
      genericJob({
        finishingStages: [
          { key: "cutting", label: "Cutting — square/rect", amount: 32.65 },
          { key: "weeding", label: "Weeding — 5 pages", amount: 6.67, provisional: "estimated page model" },
        ],
      }),
    );
    expect(r.totals.finishing_application).toBeCloseTo(500 * (28.125 / 3600) * 20 + 32.65 + 6.67, 6);
    expect(r.status).toBe("PROVISIONAL");

    const blocked = computeTrueJobCost(
      genericJob({ finishingStages: [{ key: "cutting", label: "Die-cut", amount: 99, blocker: "MISSING_CUT_STANDARD" }] }),
    );
    expect(blocked.status).toBe("DRAFT_ONLY");
    expect(blocked.lines.find((l) => l.key === "cutting")!.amount).toBe(0);
    expect(blocked.blockers.join(" ")).toContain("MISSING_CUT_STANDARD");
  });

  it("H. planned overage stays generic and is never double-counted", () => {
    const r = computeTrueJobCost(genericJob());
    expect(r.totals.planned_overage).toBe(0);
    expect(r.productionQty).toBe(505);
    expect(r.lines.find((l) => l.key === "blank_sets")!.amount).toBeCloseTo(505 * 0.09, 6);
    expect(r.lines.find((l) => l.key === "inbound_freight")!.amount).toBeCloseTo(505 * 0.02, 6);
    expect(r.lines.find((l) => l.key === "application")!.amount).toBeCloseTo(500 * (28.125 / 3600) * 20, 6);
  });

  it("I. no live pricing path imports the engine or any adapter", () => {
    for (const file of [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/lib/product-driven-costing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("true-cost-engine"), file).toBe(false);
      expect(src.includes("-cost-inputs"), file).toBe(false);
    }
  });

  it("Stock Bag and custom 4x5 Sticker Bag share ONE physical cost model", () => {
    const stock = genericJob({ setup: { art: 0, print: 2, groups: 0, note: "Stock Bag — GSO premade artwork, no customer art charge." } });
    const custom = genericJob({ setup: { art: 12.5, print: 2, groups: 1, note: "Custom 4x5 — customer artwork, normal art/setup rules." } });

    const a = computeTrueJobCost(stock);
    const b = computeTrueJobCost(custom);

    for (const key of ["blank_sets", "print_media", "ink", "machine", "application", "packout", "inbound_freight"]) {
      expect(a.lines.find((l) => l.key === key)!.amount, key).toBeCloseTo(b.lines.find((l) => l.key === key)!.amount, 10);
    }
    expect(b.totals.setup_labor - a.totals.setup_labor).toBeCloseTo(12.5, 6);
    expect(b.totalCost - a.totalCost).toBeCloseTo(12.5, 6);
  });
});

/* ================================================================== *
 * OPERATOR ATTENTION — owner-approved provisional 10% standard
 * ================================================================== */

describe("operator attention run labor", () => {
  it("derives 10% of machine occupancy at $25/hr, universally", () => {
    expect(DEFAULT_OPERATOR_ATTENTION_PCT).toBe(10);
    expect(DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR).toBe(25);
    expect(OPERATOR_ATTENTION_CLASSIFICATION).toBe("OWNER_APPROVED_PROVISIONAL");

    const r = computeTrueJobCost(genericJob());
    const occHr = (55 * 1.444) / 60;
    expect(r.lines.find((l) => l.key === "run_labor")!.amount).toBeCloseTo(occHr * 0.1 * 25, 8);
  });

  it("combined printer burden is $8.00 equipment + $2.50 attention = $10.50/machine hr", () => {
    const r = computeTrueJobCost(genericJob());
    const occHr = (55 * 1.444) / 60;
    expect(r.totals.machine_recovery / occHr).toBeCloseTo(8.0, 8);
    expect(r.totals.run_labor / occHr).toBeCloseTo(2.5, 8);
    expect((r.totals.machine_recovery + r.totals.run_labor) / occHr).toBeCloseTo(10.5, 8);
  });

  it("is PROVISIONAL, never DRAFT_ONLY", () => {
    const r = computeTrueJobCost(genericJob());
    expect(r.status).toBe("PROVISIONAL");
    expect(r.blockers).toEqual([]);
    expect(r.provisionalReasons.join(" ")).toContain("OWNER_APPROVED_PROVISIONAL");
  });

  it("does NOT double-count print setup", () => {
    const r = computeTrueJobCost(genericJob());
    expect(r.totals.setup_labor).toBeCloseTo(14.5, 8); // art 12.50 + print 2.00, unchanged
    expect(r.lines.find((l) => l.key === "run_labor")!.note).toContain("SEPARATE component");
  });

  it("attention percentage is overridable per machine/profile", () => {
    const r = computeTrueJobCost(genericJob({ runLabor: { mode: "operator_attention", attentionPct: 25, laborRatePerHour: 30 } }));
    const occHr = (55 * 1.444) / 60;
    expect(r.lines.find((l) => l.key === "run_labor")!.amount).toBeCloseTo(occHr * 0.25 * 30, 8);
    expect(r.lines.find((l) => l.key === "run_labor")!.label).toContain("25%");
  });

  it("explicit dedicated run labor is still supported", () => {
    const r = computeTrueJobCost(genericJob({ runLabor: { mode: "explicit", hours: 2, ratePerHour: 20 } }));
    expect(r.lines.find((l) => l.key === "run_labor")!.amount).toBe(40);
  });

  it("blocks rather than guessing when occupancy is unavailable", () => {
    const r = computeTrueJobCost(genericJob({ areas: { inkableArtworkSqft: 40, ripLayoutSqft: null, materialFootprintSqft: 50, ripLayoutBasis: "none" } }));
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.lines.find((l) => l.key === "run_labor")!.amount).toBe(0);
    expect(r.blockers.join(" ")).toContain("MISSING_NESTING_MODEL");
  });

  it("machine occupancy is resolved ONCE and shared by both burdens", () => {
    const r = computeTrueJobCost(genericJob());
    const occHr = (55 * 1.444) / 60;
    // equipment and attention must agree on the same occupancy
    expect(r.totals.run_labor / (r.totals.machine_recovery / 8)).toBeCloseTo(2.5, 8);
    expect(r.lines.find((l) => l.key === "run_labor")!.formula).toContain(occHr.toFixed(4));
  });
});

/* ================================================================== *
 * MATERIAL WASTE POLICY — no generic waste factor, by design
 * ================================================================== */

describe("material waste semantics", () => {
  it("no generic material-waste field exists in the engine or the adapter", () => {
    const adapter = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    for (const src of [ENGINE_SRC, adapter]) {
      for (const field of ["materialWastePct", "nestingWastePct", "wasteFactor", "wastePct", "wasteMultiplier"]) {
        expect(src.includes(field), field).toBe(false);
      }
    }
  });

  it("materialFootprintSqft IS the consumed media — no uplift is applied to it", () => {
    const r = computeTrueJobCost(genericJob());
    const media = r.lines.find((l) => l.key === "print_media")!;
    // exactly area x rate, with no multiplier of any kind
    expect(media.amount).toBeCloseTo(50 * MATTE_PER_SQFT, 10);
    expect(media.formula).toContain("50.0000 sqft");
  });

  it("planned overage and physical nesting loss are never multiplied together", () => {
    const r = computeTrueJobCost(genericJob());
    // media is priced from the supplied footprint alone; the 1% overage reaches
    // it only because the adapter already sized the area at production qty
    expect(r.totals.planned_overage).toBe(0);
    expect(r.lines.find((l) => l.key === "print_media")!.amount).toBeCloseTo(50 * MATTE_PER_SQFT, 10);
    // and the engine never re-applies overagePct to any area
    expect(ENGINE_SRC.includes("overagePct / 100")).toBe(false);
    expect(ENGINE_SRC.includes("overagePct/100")).toBe(false);
  });

  it("documents that the nesting engine supplies the footprint directly", () => {
    const r = computeTrueJobCost(genericJob());
    const note = r.lines.find((l) => l.key === "print_media")!.note!;
    expect(note).toContain("No separate waste percentage is required");
    const doc = readFileSync("docs/GSO_TRUE_COST_CONTRACT.md", "utf8");
    expect(doc).toContain("No generic material-waste factor");
    expect(doc).toContain("would double-count");
  });
});
