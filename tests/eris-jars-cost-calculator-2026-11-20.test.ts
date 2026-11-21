// 2026-11-20 — Eris 60ml Jar and Eris 120ml Jar in the owner's COST CALCULATOR.
//
// The owner provided exactly this and nothing else:
//   Eris 60ml Jar   supplier quantity 2,500   $2.28 each   (2,500 x $2.28 = $5,700)
//   Eris 120ml Jar  supplier quantity 2,500   $3.22 each   (2,500 x $3.22 = $8,050)
// both BEFORE shipping / inbound freight.
//
// Everything else is PENDING and must stay unknown: inbound freight (so no
// landed cost), every other supplier tier, label geometry, application timing
// and the outbound box quantity. Eris is cost-calculator only — never a
// storefront / Shopify product. Nothing about an existing jar may move.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_JAR_KEYS,
  ACTIVE_JAR_PROFILES,
  COST_ONLY_JAR_KEYS,
  COST_ONLY_JAR_PROFILES,
  activeJarProfile,
  costOnlyJarProfile,
  costOnlyJarProfileByKey,
  isActiveJarProfile,
  resolveActiveJarProfile,
  resolveCostOnlyJarProfile,
} from "../app/lib/jar-active-scope";
import {
  JAR_GEOMETRY_PENDING,
  JAR_GEOMETRY_PENDING_LABEL,
  JAR_LABEL_GEOMETRY,
  JAR_OWNER_CONFIRMED_GEOMETRY,
  MIRON_CERES_LABEL_CUT_MM,
  jarGeometryAuthorityFor,
  jarGeometryPendingNote,
} from "../app/lib/jar-label-geometry";
import {
  APPLICATION_LABOR_RATE_PER_HOUR,
  CHIRON_SET_COST,
  COST_ONLY_JAR_OPTION_PREFIX,
  DERIVED_STANDARD_PALLET_CAPACITY,
  ERIS_FREIGHT_PENDING_LABEL,
  ERIS_JAR_FREIGHT_PENDING,
  ERIS_JAR_SUPPLIER_COST,
  ERIS_LOWER_SUPPLIER_TIERS,
  ERIS_SUPPLIER_COST_LABEL,
  INVOICE_DERIVED_FREIGHT_PER_UNIT,
  JAR_APPLICATION_SECONDS_BY_SIZE,
  JAR_APPLICATION_SECONDS_PENDING_TIMING,
  JAR_APPLICATION_TIMING_NOT_RECORDED,
  JAR_APPLICATION_TIMING_VALIDATION_PENDING_LABEL,
  JAR_FREIGHT_PENDING,
  JAR_PACKOUT_PENDING,
  JAR_PACKOUT_PENDING_LABEL,
  JAR_PLANNED_OVERAGE_PCT,
  JAR_UNITS_PER_BOX,
  MIRON_PALLET_CAPACITY,
  MIRON_PALLET_FREIGHT,
  MIRON_SET_COMPONENTS,
  MIRON_SET_COST,
  MIRON_TIER_MIN_QTYS,
  STANDARD_SET_COST,
  costOnlyJarCalculatorOptions,
  costOnlyJarSummary,
  erisJarSupplierCostBasis,
  jarFreightPerUnit,
  packoutFor,
  productionQtyFor,
  resolveJarApplication,
  resolveJarBlankCost,
  type JarBrand,
} from "../app/lib/jar-cost-inputs.server";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { isCostedAuthority, resolveCostAuthority } from "../app/lib/canonical-quote-authority.server";
import { JAR_BASE_PRICES, JAR_LAUNCH_TYPE_SIZES, jarLaunchSizeForType } from "../app/lib/canonical-jar-pricing";
import { jarLaunchSizeForSizeKey, resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";
import { PRODUCT_FAMILY_SALES_RULES } from "../app/lib/product-family-sales-rules";
import { getProductProductionSpec, listProductSpecs } from "../app/lib/product-production-spec";
import { classifyRecipeReadiness } from "../app/lib/jar-quote-readiness.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";

const ERIS_60 = "eris_60ml" as const;
const ERIS_120 = "eris_120ml" as const;
const ERIS_SIZES = [ERIS_60, ERIS_120];
const src = (path: string) => readFileSync(path, "utf8");
const ERIS_WORD = /\beris\b/i;

/** An approved Mimaki CMYK calibration, shaped like a real DB row (same harness as the Ceres suite). */
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

/** A calculator job exactly as the Cost Calculator form posts it. */
const job = (pjar: string, qty: number, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ pfamily: "premium-jars", pjarmat: "matte", pprinter: "mimaki", pqty: String(qty), pjar, pcmykcoverage: "40", pjarside: "1", pjarlid: "1", ...extra });
  const input = normalizeCanonicalInput(params);
  expect(input, `did not normalise: ${params}`).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};
const lineOf = (result: ReturnType<typeof job>, key: string) => result.trueCost.lines.find((line) => line.key === key)!;

/* ------------------------------------------------------------------ */
describe("1-2. both Eris jars exist in the Cost Calculator", () => {
  it("Eris 60ml Jar exists, under its exact canonical name", () => {
    const profile = costOnlyJarProfile("eris", ERIS_60)!;
    expect(profile).not.toBeNull();
    expect(profile.label).toBe("Eris 60ml Jar");
    expect(profile.key).toBe("eris/eris_60ml");
    expect(resolveCostOnlyJarProfile("Eris 60ml Jar")).toBe(profile);
    expect(costOnlyJarProfileByKey("eris/eris_60ml")).toBe(profile);
    expect(ERIS_JAR_SUPPLIER_COST[ERIS_60].name).toBe("Eris 60ml Jar");
  });

  it("Eris 120ml Jar exists, under its exact canonical name", () => {
    const profile = costOnlyJarProfile("eris", ERIS_120)!;
    expect(profile).not.toBeNull();
    expect(profile.label).toBe("Eris 120ml Jar");
    expect(profile.key).toBe("eris/eris_120ml");
    expect(resolveCostOnlyJarProfile("Eris 120ml Jar")).toBe(profile);
    expect(ERIS_JAR_SUPPLIER_COST[ERIS_120].name).toBe("Eris 120ml Jar");
  });

  it("exactly two cost-only jars, both brand eris, and a bare size is never an Eris jar", () => {
    expect(COST_ONLY_JAR_KEYS).toEqual(["eris/eris_60ml", "eris/eris_120ml"]);
    expect(COST_ONLY_JAR_PROFILES.every((p) => p.brand === "eris" && p.notForSale === true)).toBe(true);
    expect(resolveCostOnlyJarProfile("60ml jar")).toBeNull();
    expect(resolveCostOnlyJarProfile("Miron 120ml")).toBeNull();
    expect(resolveCostOnlyJarProfile("MIRON Ceres 50 mL + Yuha 48")).toBeNull();
    expect(costOnlyJarProfile("miron", ERIS_60)).toBeNull();
    expect(costOnlyJarProfile("eris", "50ml")).toBeNull();
  });

  it("both appear in the calculator's Jar picker (Premium Jars), selectable, with base cost, the 2,500 tier and PENDING freight / landed cost", () => {
    const options = costOnlyJarCalculatorOptions("premium-jars");
    expect(options.map((o) => o.jarProfile)).toEqual(["eris/eris_60ml", "eris/eris_120ml"]);
    expect(options.map((o) => o.value)).toEqual([`${COST_ONLY_JAR_OPTION_PREFIX}eris/eris_60ml`, `${COST_ONLY_JAR_OPTION_PREFIX}eris/eris_120ml`]);
    expect(options[0].label).toBe("Eris 60ml Jar — $2.28 supplier unit cost at the 2,500 supplier tier (owner-provided, before inbound freight) — FREIGHT PENDING · landed cost PENDING");
    expect(options[1].label).toBe("Eris 120ml Jar — $3.22 supplier unit cost at the 2,500 supplier tier (owner-provided, before inbound freight) — FREIGHT PENDING · landed cost PENDING");
    for (const option of options) {
      expect(option.group).toBe("ERIS");
      expect(option.costOnly.landedUnitCost).toBeNull();
      expect(option.costOnly.inboundFreight.perUnit).toBeNull();
      expect(option.costOnly.notForSale).toBe(true);
    }
    expect(costOnlyJarCalculatorOptions("standard-jars")).toEqual([]);
    expect(costOnlyJarCalculatorOptions("sticker-bags")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
describe("3-7. owner-provided supplier cost and the one known supplier tier", () => {
  it("3. Eris 60ml base supplier unit cost is $2.28", () => {
    expect(ERIS_JAR_SUPPLIER_COST[ERIS_60].supplierUnitCost).toBe(2.28);
    const blank = resolveJarBlankCost({ brand: "eris", size: ERIS_60, quantity: 2500 });
    expect(blank.ok && blank.unitCost).toBe(2.28);
  });

  it("4. Eris 120ml base supplier unit cost is $3.22", () => {
    expect(ERIS_JAR_SUPPLIER_COST[ERIS_120].supplierUnitCost).toBe(3.22);
    const blank = resolveJarBlankCost({ brand: "eris", size: ERIS_120, quantity: 2500 });
    expect(blank.ok && blank.unitCost).toBe(3.22);
  });

  it("5. the known supplier tier is 2,500 — for both", () => {
    for (const size of ERIS_SIZES) {
      expect(ERIS_JAR_SUPPLIER_COST[size].supplierQuantity).toBe(2500);
      expect(erisJarSupplierCostBasis(size)!.supplierQuantity).toBe(2500);
      const blank = resolveJarBlankCost({ brand: "eris", size, quantity: 2500 });
      expect(blank.ok && blank.supplierBasis!.supplierQuantity).toBe(2500);
    }
  });

  it("6. 2,500 x $2.28 = $5,700", () => {
    expect(erisJarSupplierCostBasis(ERIS_60)!.supplierTotal).toBe(5700);
    const blank = resolveJarBlankCost({ brand: "eris", size: ERIS_60, quantity: 2500 });
    expect(blank.ok && blank.source).toContain("2,500 x $2.28 = $5,700.00");
  });

  it("7. 2,500 x $3.22 = $8,050", () => {
    expect(erisJarSupplierCostBasis(ERIS_120)!.supplierTotal).toBe(8050);
    const blank = resolveJarBlankCost({ brand: "eris", size: ERIS_120, quantity: 2500 });
    expect(blank.ok && blank.source).toContain("2,500 x $3.22 = $8,050.00");
  });

  it("the number is ONE supplier unit cost — never split into jar + lid, no lid cost added, no lid claim made", () => {
    for (const size of ERIS_SIZES) {
      expect(Object.keys(ERIS_JAR_SUPPLIER_COST[size]).sort()).toEqual(["name", "supplierQuantity", "supplierUnitCost"]);
      const blank = resolveJarBlankCost({ brand: "eris", size, quantity: 500 });
      expect(blank.ok).toBe(true);
      if (!blank.ok) continue;
      expect(blank.components).toBeUndefined();
      expect(blank.supplierBasis!.label).toBe(ERIS_SUPPLIER_COST_LABEL);
      expect(ERIS_SUPPLIER_COST_LABEL).toBe("ERIS JAR SUPPLIER UNIT COST PROVIDED BY OWNER");
      expect(blank.source).toContain(ERIS_SUPPLIER_COST_LABEL);
      expect(blank.source).not.toMatch(/\blids?\b/i);
      expect((MIRON_SET_COMPONENTS as Record<string, unknown>)[size]).toBeUndefined();
      const result = job(`eris/${size}`, 500);
      expect(result.diagnostics.blankComponents).toBeUndefined();
      expect(lineOf(result, "blank_sets").label).not.toMatch(/\blids?\b/i);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("8. inbound freight is not invented", () => {
  it("Eris freight is null (never $0), a missing basis, and says the owner has not provided it", () => {
    for (const size of ERIS_SIZES) {
      const freight = jarFreightPerUnit("eris", size);
      expect(freight.perUnit).toBeNull();
      expect(freight.perUnit).not.toBe(0);
      expect(freight.basis).toBe("MISSING_FREIGHT_BASIS");
      expect(freight.source).toContain(ERIS_FREIGHT_PENDING_LABEL);
      expect(freight.source).toBe(ERIS_JAR_FREIGHT_PENDING[size]);
      expect(freight.source).toContain("the owner has not provided a shipping / inbound freight cost for Eris");
      expect(freight.source).toContain("NOT $0");
      expect(freight.source).toContain("landed unit cost is PENDING");
    }
    expect(ERIS_FREIGHT_PENDING_LABEL).toBe("FREIGHT PENDING — ERIS INBOUND FREIGHT NOT PROVIDED BY OWNER");
  });

  it("no Miron pallet, Ceres, Chiron / standard invoice or derived-pallet figure exists for an Eris size", () => {
    for (const size of ERIS_SIZES) {
      expect((MIRON_PALLET_CAPACITY as Record<string, unknown>)[size]).toBeUndefined();
      expect((INVOICE_DERIVED_FREIGHT_PER_UNIT as Record<string, unknown>)[size]).toBeUndefined();
      expect((DERIVED_STANDARD_PALLET_CAPACITY as Record<string, unknown>)[size]).toBeUndefined();
      expect((JAR_FREIGHT_PENDING as Record<string, unknown>)[size]).toBeUndefined(); // the Ceres wording is not reused
    }
  });

  it("no brand x size combination can reach a number for Eris — every branch fails closed", () => {
    const brands: JarBrand[] = ["eris", "miron", "chiron", "standard"];
    for (const brand of brands) for (const size of ERIS_SIZES) {
      const freight = jarFreightPerUnit(brand, size);
      expect(freight.perUnit, `${brand}/${size}`).toBeNull();
      expect(freight.basis, `${brand}/${size}`).toBe("MISSING_FREIGHT_BASIS");
    }
    // The Eris BRAND never reads another brand's table, even for a size that has one.
    for (const size of Object.keys(JAR_LABEL_GEOMETRY) as Array<keyof typeof JAR_LABEL_GEOMETRY>) {
      const freight = jarFreightPerUnit("eris", size);
      expect(freight.perUnit, `eris/${size}`).toBeNull();
      expect(freight.basis).toBe("MISSING_FREIGHT_BASIS");
      expect(freight.source).not.toMatch(/pallet|invoice|Safe Care|Southwest/i);
      expect(resolveJarBlankCost({ brand: "eris", size, quantity: 500 }).ok, `eris/${size}`).toBe(false);
    }
  });

  it("the Eris freight wording names no other carrier, supplier or allowance", () => {
    for (const size of ERIS_SIZES) {
      expect(ERIS_JAR_FREIGHT_PENDING[size]).not.toMatch(/miron|ceres|chiron|southwest|safe care|pallet|invoice/i);
      // the only dollar figure in the wording is the explicit "NOT $0"
      expect(ERIS_JAR_FREIGHT_PENDING[size].match(/\$\d[\d.,]*/g)).toEqual(["$0"]);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("9. landed cost stays PENDING while freight is missing", () => {
  it("the summary never presents $2.28 / $3.22 as a landed cost", () => {
    for (const profile of COST_ONLY_JAR_PROFILES) {
      const summary = costOnlyJarSummary(profile, 500)!;
      expect(summary.landedUnitCost).toBeNull();
      expect(summary.landedUnitCostStatus).toBe("PENDING");
      expect(summary.inboundFreight.status).toBe("PENDING");
      expect(summary.inboundFreight.perUnit).toBeNull();
      expect(summary.landedUnitCost).not.toBe(summary.supplierUnitCost);
    }
  });

  it("an Eris calculator job is DRAFT_ONLY with NO unit cost, and says why in plain words", () => {
    for (const size of ERIS_SIZES) {
      const result = job(`eris/${size}`, 500);
      expect(result.status).toBe("DRAFT_ONLY");
      expect(result.unitCost).toBeNull();
      expect(result.trueCost.unitCost).toBeNull();
      const freightLine = lineOf(result, "inbound_freight");
      expect(freightLine.amount).toBe(0);
      expect(freightLine.blocker).toContain("MISSING_FREIGHT_BASIS");
      expect(freightLine.blocker).toContain(ERIS_FREIGHT_PENDING_LABEL);
      const all = result.blockers.join("\n");
      expect(all).toContain(ERIS_FREIGHT_PENDING_LABEL);
      expect(all).toContain(JAR_GEOMETRY_PENDING_LABEL);
      expect(all).toContain(JAR_APPLICATION_TIMING_VALIDATION_PENDING_LABEL);
      expect(all).toContain(JAR_PACKOUT_PENDING_LABEL);
      // not refused as an unknown jar — it is a known jar with a known base cost and pending inputs
      expect(all).not.toContain("is not a jar GSO currently offers");
      expect(all).not.toContain("is not a jar size this system has geometry for");
      // the Ceres "freight is the only thing missing" subtotal banner is NOT shown: far more than freight is missing
      expect(result.diagnostics.landedCost).toBeUndefined();
      const shown = result.diagnostics.costOnlyJar!;
      expect(shown.landedUnitCost).toBeNull();
      expect(shown.landedUnitCostStatus).toBe("PENDING");
      expect(shown.supplierQuantity).toBe(2500);
      expect(shown.lowerSupplierTiers).toBe("NOT PROVIDED");
    }
    expect(job("eris/eris_60ml", 500).diagnostics.costOnlyJar!.supplierUnitCost).toBe(2.28);
    expect(job("eris/eris_120ml", 500).diagnostics.costOnlyJar!.supplierUnitCost).toBe(3.22);
  });

  it("the exact blockers of an Eris 60ml job (500 jars, side + lid)", () => {
    expect(job("eris/eris_60ml", 500).blockers).toEqual([
      "STANDARD_PRODUCTION_DIMENSIONS_NOT_CONFIRMED: LABEL GEOMETRY PENDING OWNER MEASUREMENT — Eris 60ml Jar: no label sizes (side label, lid label or band) have been provided by the owner, so label media, ink, print time and cutting cannot be measured. No dimension is assumed or borrowed from another jar.",
      "MISSING_APPLICATION_STANDARD: PENDING REAL SHOP TIMING VALIDATION — no label application time has been recorded for the Eris 60ml Jar. Application labor cannot be costed until it is timed in the shop; no other jar's seconds are used.",
      "PACKOUT_NOT_MODELED: OUTBOUND BOX QUANTITY PENDING — the number of Eris 60ml Jars per outbound box has not been provided, so packout (boxes, labor and consumables) cannot be costed. No other jar's box quantity is used.",
      "Ink: INVALID_AREA: This calibration is measured on \"inkable_artwork\" area; no usable inkable_artwork sqft was supplied.",
      "Operator attention labor: Cannot derive operator attention without machine occupancy — MISSING_NESTING_MODEL: ripLayoutSqft is required and no nesting model produced one.",
      "Machine recovery: MISSING_NESTING_MODEL: ripLayoutSqft is required and no nesting model produced one.",
      "Inbound freight: MISSING_FREIGHT_BASIS: FREIGHT PENDING — ERIS INBOUND FREIGHT NOT PROVIDED BY OWNER — Eris 60ml Jar: the owner has not provided a shipping / inbound freight cost for Eris, and no other jar's freight is used in its place. It is NOT $0 and no allowance is assumed; landed unit cost is PENDING.",
    ]);
  });

  it("no price can be derived: the quote / cost authority refuses the job, and no ladder exists", () => {
    for (const size of ERIS_SIZES) for (const qty of [50, 500, 2500]) {
      const result = job(`eris/${size}`, qty);
      const authority = resolveCostAuthority({ canonicalFamilyKey: "premium-jars", canonical: result, legacyJobCost: 999, quantity: qty, freightTotal: 0 });
      expect(isCostedAuthority(authority)).toBe(false);
      expect(authority.unitCost).toBeNull();
      expect(authority.manufacturingJobCost).toBeNull();
      expect(authority.completeCost).toBeNull();
      const ladder = resolveJarOwnerLadder({ brand: "eris", sizeKey: size, quantity: qty });
      expect(ladder.ok).toBe(false);
      expect(!ladder.ok && ladder.reason).toBe("NO_OWNER_LADDER");
    }
  });

  it("selected under the wrong calculator family it is refused, not costed as something else", () => {
    const result = job("eris/eris_60ml", 500, { pfamily: "standard-jars" });
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join("\n")).toContain("Eris 60ml Jar is costed under \"premium-jars\", not \"standard-jars\"");
  });
});

/* ------------------------------------------------------------------ */
describe("10. no lower supplier tiers are fabricated", () => {
  it("the Eris table holds ONE supplier quantity per jar and no ladder array anywhere", () => {
    for (const size of ERIS_SIZES) {
      const entry = ERIS_JAR_SUPPLIER_COST[size] as Record<string, unknown>;
      expect(Object.values(entry).some((value) => Array.isArray(value))).toBe(false);
      expect(entry.ladder).toBeUndefined();
      expect(entry.tiers).toBeUndefined();
      expect((MIRON_SET_COST as Record<string, unknown>)[size]).toBeUndefined();
      expect((CHIRON_SET_COST as Record<string, unknown>)[size]).toBeUndefined();
      expect((STANDARD_SET_COST as Record<string, unknown>)[size]).toBeUndefined();
    }
    expect(ERIS_LOWER_SUPPLIER_TIERS).toBe("NOT PROVIDED");
  });

  it("a smaller job quantity resolves from the 2,500-quantity basis and SAYS so — no tier is claimed for it", () => {
    const expected = { [ERIS_60]: 2.28, [ERIS_120]: 3.22 } as const;
    for (const size of ERIS_SIZES) for (const qty of [1, 50, 128, 250, 256, 500, 1000, 2499, 2500, 5000]) {
      const blank = resolveJarBlankCost({ brand: "eris", size, quantity: qty });
      expect(blank.ok, `${size} @ ${qty}`).toBe(true);
      if (!blank.ok) continue;
      // one basis, never a per-quantity price
      expect(blank.unitCost).toBe(expected[size]);
      // no resolved tier is asserted for the job quantity (Miron reports the tier it reached; Eris has none)
      expect(blank.tierMinQty).toBeNull();
      expect(blank.supplierBasis).toEqual({
        label: "ERIS JAR SUPPLIER UNIT COST PROVIDED BY OWNER",
        productName: ERIS_JAR_SUPPLIER_COST[size].name,
        supplierUnitCost: expected[size],
        supplierQuantity: 2500,
        supplierTotal: size === ERIS_60 ? 5700 : 8050,
        lowerSupplierTiers: "NOT PROVIDED",
        beforeInboundFreight: true,
      });
      expect(blank.source).toContain("the owner-provided 2,500-quantity supplier cost");
      expect(blank.source).toContain("Lower supplier tiers: NOT PROVIDED");
      expect(blank.source).toContain("BEFORE inbound freight");
      expect(blank.source).toContain("Not a landed cost");
      expect(blank.source).toContain("the supplier price for any other purchase quantity is unknown");
      // none of the quantities the owner did not price appears as a tier
      expect(blank.source).not.toMatch(/tier (1|50|128|250|256|500|1000|1,000)\+/);
    }
  });

  it("Eris never rides the Miron tier ladder, the Chiron flat rule or the standard table", () => {
    for (const size of ERIS_SIZES) {
      for (const brand of ["miron", "chiron", "standard"] as JarBrand[]) {
        const blank = resolveJarBlankCost({ brand, size, quantity: 500 });
        expect(blank.ok, `${brand}/${size}`).toBe(false);
        expect(!blank.ok && blank.reason).toBe("MISSING_COST");
      }
      const blank = resolveJarBlankCost({ brand: "eris", size, quantity: 500 });
      expect(blank.ok && blank.source).not.toMatch(/Miron|Chiron|Standard jar|flat at every quantity/);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("11. no application timing is fabricated (owner freeze 2026-11-19)", () => {
  it("the frozen per-size timings are exactly their current values — and Eris is not a key", () => {
    expect(JAR_APPLICATION_SECONDS_BY_SIZE).toEqual({
      "50ml": { side: 12, lid: 10, tamper: 12 }, "100ml_tall": { side: 12, lid: 10, tamper: 12 }, "100ml_wide": { side: 12, lid: 10, tamper: 12 },
      "150ml": { side: 13, lid: 10, tamper: 12 }, "250ml": { side: 15, lid: 10, tamper: 12 }, "3oz": { side: 10, lid: 8, tamper: null }, "4oz": { side: 10, lid: 8, tamper: null },
      ceres_50ml: { side: 12, lid: 10, tamper: 12 }, ceres_100ml: { side: 12, lid: 10, tamper: 12 },
    });
    expect(APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(Object.keys(JAR_APPLICATION_SECONDS_PENDING_TIMING).sort()).toEqual(["ceres_100ml", "ceres_50ml"]);
    for (const size of ERIS_SIZES) {
      expect((JAR_APPLICATION_SECONDS_BY_SIZE as Record<string, unknown>)[size]).toBeUndefined();
      expect((JAR_APPLICATION_SECONDS_PENDING_TIMING as Record<string, unknown>)[size]).toBeUndefined();
    }
  });

  it("Eris application is PENDING REAL SHOP TIMING VALIDATION for every label selection — never a number", () => {
    const selections = [
      { side: true, lid: false, tamper: false }, { side: false, lid: true, tamper: false }, { side: true, lid: true, tamper: false },
      { side: true, lid: true, tamper: true }, { side: false, lid: false, tamper: true }, { side: false, lid: false, tamper: false },
    ];
    for (const size of ERIS_SIZES) for (const selection of selections) {
      const application = resolveJarApplication(size, selection);
      expect(application.ok).toBe(false);
      if (application.ok) continue;
      expect(application.reason).toBe("MISSING_APPLICATION_STANDARD");
      expect(application.message).toBe(JAR_APPLICATION_TIMING_NOT_RECORDED[size]);
      expect(application.message).toContain("PENDING REAL SHOP TIMING VALIDATION");
      expect(application.message).not.toMatch(/\d+\s*s\b|\d+\s*seconds/i);
    }
  });

  it("the Eris job carries no application seconds, no application cost and blocks on it", () => {
    for (const size of ERIS_SIZES) {
      const result = job(`eris/${size}`, 500, { pjartamper: "1" });
      expect(lineOf(result, "application").amount).toBe(0);
      expect(result.diagnostics.applicationBreakdown ?? null).toBeNull();
      expect(result.reasons).toContain("MISSING_APPLICATION_STANDARD");
      expect(result.blockers.some((b) => b.startsWith("MISSING_APPLICATION_STANDARD: PENDING REAL SHOP TIMING VALIDATION"))).toBe(true);
    }
  });

  it("existing jars resolve the same application seconds as before", () => {
    const sideLid = { side: true, lid: true, tamper: false };
    const a = resolveJarApplication("150ml", sideLid);
    expect(a.ok && a.secondsPerJar).toBe(23);
    const b = resolveJarApplication("ceres_50ml", { side: true, lid: true, tamper: true });
    expect(b.ok && b.secondsPerJar).toBe(34);
    const c = resolveJarApplication("3oz", { side: true, lid: true, tamper: true });
    expect(c.ok).toBe(false);
    expect(!c.ok && c.message).toContain("NEEDS REVIEW — missing application timing");
    const unknown = resolveJarApplication("5oz" as any, sideLid);
    expect(!unknown.ok && unknown.message).toBe("No owner application timing exists for a 5oz jar.");
  });
});

/* ------------------------------------------------------------------ */
describe("label geometry and outbound packout are PENDING, never borrowed", () => {
  it("Eris has no label geometry entry at all — not a placeholder, not another jar's dieline", () => {
    for (const size of ERIS_SIZES) {
      expect((JAR_LABEL_GEOMETRY as Record<string, unknown>)[size]).toBeUndefined();
      expect((JAR_OWNER_CONFIRMED_GEOMETRY as Record<string, unknown>)[size]).toBeUndefined();
      expect(jarGeometryPendingNote(size)).toBe(JAR_GEOMETRY_PENDING[size]);
      expect(JAR_GEOMETRY_PENDING[size]).toContain("LABEL GEOMETRY PENDING OWNER MEASUREMENT");
      expect(JAR_GEOMETRY_PENDING[size]).not.toMatch(/\d+(\.\d+)?\s*(in|mm)\b/);
      expect(jarGeometryAuthorityFor(size)).toEqual({ authorityStatus: "UNSUPPORTED", ownerConfirmationRequired: true, ownerRecord: null });
    }
    expect(jarGeometryPendingNote("50ml")).toBeNull();
    expect(jarGeometryPendingNote("ceres_50ml")).toBeNull();
    expect(jarGeometryPendingNote(null)).toBeNull();
  });

  it("the Eris job measures nothing: zero media, zero ink, no nest, no cut path", () => {
    for (const size of ERIS_SIZES) {
      const result = job(`eris/${size}`, 500);
      expect(result.diagnostics.mediaConsumedSqft).toBe(0);
      expect(result.diagnostics.inkableArtworkSqft).toBe(0);
      expect(result.diagnostics.ripLayoutSqft).toBeNull();
      expect(result.diagnostics.cutPathIn).toBeNull();
      expect(result.diagnostics.productSpec).toBeNull();
      expect(lineOf(result, "print_media").amount).toBe(0);
      expect(result.reasons).toContain("STANDARD_PRODUCTION_DIMENSIONS_NOT_CONFIRMED");
    }
  });

  it("Eris has no units-per-box and the job charges no packout", () => {
    for (const size of ERIS_SIZES) {
      expect((JAR_UNITS_PER_BOX as Record<string, unknown>)[size]).toBeUndefined();
      expect(JAR_PACKOUT_PENDING[size]).toContain("OUTBOUND BOX QUANTITY PENDING");
      expect(JAR_PACKOUT_PENDING[size].replace(/Eris (60|120)ml/g, "")).not.toMatch(/\d/); // no box quantity of any kind
      const result = job(`eris/${size}`, 500);
      expect(lineOf(result, "packout").amount).toBe(0);
      expect(lineOf(result, "packout").label).toBe("Packout — 0 box(es) @ 0/box");
      expect(result.reasons).toContain("PACKOUT_NOT_MODELED");
    }
  });
});

/* ------------------------------------------------------------------ */
describe("12. the 1% planned jar overage is intact and applies to Eris blanks", () => {
  it("the overage rule itself is unchanged: 1%, 500 -> 505", () => {
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(1);
    expect(productionQtyFor(500)).toBe(505);
    expect(productionQtyFor(100)).toBe(101);
    expect(productionQtyFor(128)).toBe(130);
    expect(productionQtyFor(2500)).toBe(2525);
    expect(productionQtyFor(0)).toBe(0);
  });

  it("500 finished Eris jars are costed as 505 blanks at the supplier unit cost — a partial figure, not a total", () => {
    const expected = { [ERIS_60]: { unit: 2.28, blank: 1151.4 }, [ERIS_120]: { unit: 3.22, blank: 1626.1 } } as const;
    for (const size of ERIS_SIZES) {
      const result = job(`eris/${size}`, 500);
      expect(result.trueCost.customerFinishedQty).toBe(500);
      expect(result.trueCost.productionQty).toBe(505);
      expect(result.trueCost.overagePct).toBe(1);
      const blank = lineOf(result, "blank_sets");
      expect(blank.amount).toBeCloseTo(505 * expected[size].unit, 9);
      expect(blank.formula).toBe(`505 x $${expected[size].unit.toFixed(4)}`);
      expect(blank.label).toContain("supplier unit cost, before inbound freight — 505 set(s)");
      expect(blank.blocker).toBeUndefined();
      expect(lineOf(result, "planned_overage").label).toBe("Planned overage 1% — 500 finished -> 505 produced");
      expect(lineOf(result, "planned_overage").amount).toBe(0); // never a separate charge
      const shown = result.diagnostics.costOnlyJar!;
      expect(shown.finishedQuantity).toBe(500);
      expect(shown.plannedBlankQuantity).toBe(505);
      expect(shown.overagePct).toBe(1);
      expect(shown.baseBlankCost).toBe(expected[size].blank);
      // the blank is the ONLY money in the job, and no per-unit figure is published from it
      expect(result.trueCost.totalCost).toBeCloseTo(blank.amount, 9);
      expect(result.unitCost).toBeNull();
    }
  });

  it("an existing jar still gets exactly the same overage", () => {
    const result = job("miron/100ml_wide", 500);
    expect(result.trueCost.productionQty).toBe(505);
    expect(lineOf(result, "blank_sets").amount).toBeCloseTo(505 * 2.44, 9);
  });
});

/* ------------------------------------------------------------------ */
describe("13. every existing jar product is unchanged", () => {
  it("blank cost tables", () => {
    expect(MIRON_TIER_MIN_QTYS).toEqual([1, 250, 500, 1000, 2500]);
    expect(MIRON_SET_COST).toEqual({
      "50ml": [2.47, 2.26, 2.06, 1.93, 1.77],
      "100ml_tall": [2.78, 2.54, 2.31, 2.14, 1.99],
      "100ml_wide": [2.9, 2.67, 2.44, 2.26, 2.1],
      "150ml": [3.26, 3.0, 2.76, 2.54, 2.37],
      "250ml": [3.92, 3.6, 3.32, 3.11, 2.92],
      ceres_50ml: [2.74, 2.52, 2.31, 2.12, 1.98],
      ceres_100ml: [3.51, 3.24, 2.97, 2.77, 2.6],
    });
    expect(MIRON_SET_COMPONENTS.ceres_50ml!.jar.ladder).toEqual([1.9, 1.72, 1.55, 1.44, 1.34]);
    expect(MIRON_SET_COMPONENTS.ceres_50ml!.lid.ladder).toEqual([0.84, 0.8, 0.76, 0.68, 0.64]);
    expect(MIRON_SET_COMPONENTS.ceres_100ml!.jar.ladder).toEqual([2.46, 2.23, 2.02, 1.9, 1.79]);
    expect(MIRON_SET_COMPONENTS.ceres_100ml!.lid.ladder).toEqual([1.05, 1.01, 0.95, 0.87, 0.81]);
    expect(Object.keys(MIRON_SET_COMPONENTS).sort()).toEqual(["ceres_100ml", "ceres_50ml"]);
    expect(CHIRON_SET_COST).toEqual({ "100ml_tall": 1.8, "100ml_wide": 1.8, "150ml": 1.9 });
    expect(STANDARD_SET_COST).toEqual({ "3oz": { clear: 0.5, black_white: 0.62 }, "4oz": { clear: 0.6, black_white: 0.65 } });
  });

  it("freight tables", () => {
    expect(MIRON_PALLET_FREIGHT).toBe(315);
    expect(MIRON_PALLET_CAPACITY).toEqual({ "50ml": 5376, "100ml_tall": 3360, "100ml_wide": 3080, "150ml": 2400, "250ml": 1760 });
    expect(INVOICE_DERIVED_FREIGHT_PER_UNIT).toEqual({ "100ml_tall": 0.139, "100ml_wide": 0.139, "150ml": 0.16, "3oz": 0.089, "4oz": 0.129 });
    expect(DERIVED_STANDARD_PALLET_CAPACITY).toEqual({ "100ml_tall": 3600, "100ml_wide": 3600, "150ml": 3600, "3oz": 5400, "4oz": 3600 });
    expect(Object.keys(JAR_FREIGHT_PENDING).sort()).toEqual(["ceres_100ml", "ceres_50ml"]);
  });

  it("label geometry and units per box", () => {
    expect(Object.keys(JAR_LABEL_GEOMETRY)).toEqual(["50ml", "100ml_tall", "100ml_wide", "150ml", "250ml", "3oz", "4oz", "ceres_50ml", "ceres_100ml"]);
    expect({ ...JAR_LABEL_GEOMETRY, ceres_50ml: undefined, ceres_100ml: undefined }).toEqual({
      "50ml": { side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } },
      "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
      "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
      "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
      "250ml": { side: { widthIn: 9.375, heightIn: 2.875 }, lid: { diameterIn: 2.02 }, tamper: { widthIn: 9.375, heightIn: 0.5 } },
      "3oz": { side: { widthIn: 7.06, heightIn: 1.7 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.06, heightIn: 0.5 } },
      "4oz": { side: { widthIn: 7.125, heightIn: 2.125 }, lid: { diameterIn: 2.16 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
      ceres_50ml: undefined,
      ceres_100ml: undefined,
    });
    expect(MIRON_CERES_LABEL_CUT_MM).toEqual({
      ceres_50ml: { side: { widthMm: 166.5, heightMm: 25.3 }, lid: { diameterMm: 45 }, tamper: { widthMm: 165, heightMm: 11 } },
      ceres_100ml: { side: { widthMm: 198, heightMm: 31 }, lid: { diameterMm: 50.8 }, tamper: { widthMm: 198, heightMm: 10 } },
    });
    expect(Object.keys(JAR_OWNER_CONFIRMED_GEOMETRY).sort()).toEqual(["100ml_tall", "100ml_wide", "150ml", "250ml", "3oz", "4oz"]);
    expect(JAR_UNITS_PER_BOX).toEqual({ "50ml": 100, "100ml_tall": 100, "100ml_wide": 100, "150ml": 50, "250ml": 25, "3oz": 150, "4oz": 100, ceres_50ml: 100, ceres_100ml: 100 });
    expect(packoutFor("150ml", 500)).toEqual({ boxes: 10, unitsPerBox: 50, cost: 35 });
    // geometry authority of the existing sizes did not move
    expect(jarGeometryAuthorityFor("150ml").authorityStatus).toBe("OWNER_CONFIRMED");
    expect(jarGeometryAuthorityFor("50ml").authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
    expect(jarGeometryAuthorityFor("ceres_50ml").authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
  });

  it("storefront base prices", () => {
    expect(JAR_BASE_PRICES).toEqual({
      "50ml": [{ minQty: 50, priceEach: 4.25 }, { minQty: 100, priceEach: 4.0 }, { minQty: 250, priceEach: 3.75 }, { minQty: 500, priceEach: 3.5 }, { minQty: 1000, priceEach: 3.25 }, { minQty: 2500, priceEach: 3.0 }],
      "100ml": [{ minQty: 50, priceEach: 4.95 }, { minQty: 100, priceEach: 4.5 }, { minQty: 250, priceEach: 4.0 }, { minQty: 500, priceEach: 3.75 }, { minQty: 1000, priceEach: 3.5 }, { minQty: 2500, priceEach: 3.35 }],
      "150ml": [{ minQty: 50, priceEach: 6.5 }, { minQty: 100, priceEach: 6.0 }, { minQty: 250, priceEach: 5.75 }, { minQty: 500, priceEach: 5.5 }, { minQty: 1000, priceEach: 5.25 }, { minQty: 2500, priceEach: 4.95 }],
      "250ml": [{ minQty: 50, priceEach: 7.5 }, { minQty: 100, priceEach: 7.0 }, { minQty: 250, priceEach: 6.5 }, { minQty: 500, priceEach: 6.25 }, { minQty: 1000, priceEach: 5.95 }, { minQty: 2500, priceEach: 5.75 }],
      "3oz": [{ minQty: 50, priceEach: 2.25 }, { minQty: 100, priceEach: 2.0 }, { minQty: 250, priceEach: 1.75 }, { minQty: 500, priceEach: 1.6 }, { minQty: 1000, priceEach: 1.45 }, { minQty: 2500, priceEach: 1.35 }],
      "4oz": [{ minQty: 50, priceEach: 2.5 }, { minQty: 100, priceEach: 2.25 }, { minQty: 250, priceEach: 2.0 }, { minQty: 500, priceEach: 1.8 }, { minQty: 1000, priceEach: 1.65 }, { minQty: 2500, priceEach: 1.5 }],
    });
  });

  it("existing blank cost resolutions are identical (whole result objects)", () => {
    expect(resolveJarBlankCost({ brand: "miron", size: "50ml", quantity: 505 })).toEqual({ ok: true, unitCost: 2.06, tierMinQty: 500, source: "Miron verified complete-set tier 500+." });
    expect(resolveJarBlankCost({ brand: "miron", size: "100ml_wide", quantity: 249 })).toEqual({ ok: true, unitCost: 2.9, tierMinQty: 1, source: "Miron verified complete-set tier 1+." });
    expect(resolveJarBlankCost({ brand: "miron", size: "250ml", quantity: 2500 })).toEqual({ ok: true, unitCost: 2.92, tierMinQty: 2500, source: "Miron verified complete-set tier 2500+." });
    expect(resolveJarBlankCost({ brand: "chiron", size: "150ml", quantity: 50 })).toEqual({ ok: true, unitCost: 1.9, tierMinQty: null, source: "Chiron verified complete-set cost — flat at every quantity (owner rule); 14C.2A owner record, 2026-07-24." });
    expect(resolveJarBlankCost({ brand: "chiron", size: "50ml", quantity: 50 })).toEqual({ ok: false, reason: "MISSING_COST", message: "Chiron 50ml has no verified complete-set cost — DRAFT ONLY. A blank cost must never be inferred." });
    expect(resolveJarBlankCost({ brand: "standard", size: "3oz", quantity: 500 })).toEqual({ ok: true, unitCost: 0.5, tierMinQty: null, source: "Standard jar verified complete-set cost (clear)." });
    expect(resolveJarBlankCost({ brand: "standard", size: "4oz", quantity: 500, variant: "black_white" })).toEqual({ ok: true, unitCost: 0.65, tierMinQty: null, source: "Standard jar verified complete-set cost (black_white)." });
    expect(resolveJarBlankCost({ brand: "standard", size: "150ml", quantity: 500 })).toEqual({ ok: false, reason: "MISSING_COST", message: "No verified standard-jar complete-set cost for 150ml." });
    const ceres = resolveJarBlankCost({ brand: "miron", size: "ceres_50ml", quantity: 500 });
    expect(ceres.ok && ceres.unitCost).toBe(2.31);
    expect(ceres.ok && ceres.tierMinQty).toBe(500);
    expect(ceres.ok && ceres.components!.map((c) => c.unitCost)).toEqual([1.55, 0.76]);
    expect(ceres.ok && ceres.supplierBasis).toBeUndefined();
  });

  it("existing freight resolutions are identical (whole result objects)", () => {
    expect(jarFreightPerUnit("miron", "100ml_wide")).toEqual({ perUnit: 315 / 3080, basis: "PROVISIONAL_SUPPLIER_PALLET", provisional: true, source: "Provisional $315/pallet over verified supplier capacity 3080 jars." });
    expect(jarFreightPerUnit("miron", "3oz")).toEqual({ perUnit: null, basis: "MISSING_FREIGHT_BASIS", provisional: true, source: "No verified Miron pallet capacity for 3oz." });
    expect(jarFreightPerUnit("chiron", "150ml")).toEqual({ perUnit: 0.16, basis: "PROVISIONAL_INVOICE_DERIVED", provisional: true, source: "Safe Care invoice + physical carton derived allowance ($0.16/jar). Mixed-shipment invoices #16651/#16731/#16636; derived 48x40 / 60in pallet planning basis 3600 jars. PROVISIONAL — not a supplier-confirmed tariff." });
    expect(jarFreightPerUnit("standard", "3oz").perUnit).toBe(0.089);
    expect(jarFreightPerUnit("standard", "50ml")).toEqual({ perUnit: null, basis: "MISSING_FREIGHT_BASIS", provisional: true, source: "No invoice-derived freight allowance for standard 50ml." });
    expect(jarFreightPerUnit("miron", "ceres_50ml").source).toBe(JAR_FREIGHT_PENDING.ceres_50ml);
  });

  it("the active (sellable) jar scope is the same twelve profiles; existing jobs still cost and Ceres still shows its own freight banner", () => {
    expect(ACTIVE_JAR_KEYS.slice().sort()).toEqual([
      "chiron/100ml_tall", "chiron/100ml_wide", "chiron/150ml",
      "miron/100ml_tall", "miron/100ml_wide", "miron/150ml", "miron/250ml", "miron/50ml",
      "miron/ceres_100ml", "miron/ceres_50ml",
      "standard/3oz", "standard/4oz",
    ]);
    const miron = job("miron/100ml_wide", 500);
    expect(miron.status).toBe("PROVISIONAL");
    expect(miron.blockers).toEqual([]);
    expect(miron.unitCost).not.toBeNull();
    expect(miron.diagnostics.costOnlyJar).toBeUndefined();
    expect(lineOf(miron, "inbound_freight").amount).toBeCloseTo(505 * (315 / 3080), 9);
    const ceres = job("miron/ceres_50ml", 500, { pjartamper: "1" });
    expect(ceres.blockers).toHaveLength(1);
    expect(ceres.diagnostics.landedCost!.label).toBe("FREIGHT PENDING SUPPLIER PACK DATA");
    expect(ceres.diagnostics.costOnlyJar).toBeUndefined();
    // a jar nobody offers is still refused exactly as before
    const unknown = job("chiron/50ml", 500);
    expect(unknown.blockers.join("\n")).toContain("\"chiron 50ml\" is not a jar GSO currently offers");
    const noSize = job("miron/60ml", 500);
    expect(noSize.blockers.join("\n")).toContain("\"60ml\" is not a jar size this system has geometry for");
    expect(noSize.diagnostics.costOnlyJar).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
describe("14. Eris is NOT for sale — no storefront, configurator, ladder or sales-rule presence", () => {
  it("is not in the active (offered) jar scope and is not a product spec", () => {
    for (const size of ERIS_SIZES) {
      expect(isActiveJarProfile("eris", size)).toBe(false);
      expect(activeJarProfile("eris", size)).toBeNull();
      expect(isActiveJarProfile("miron", size)).toBe(false);
      expect(getProductProductionSpec("premium-jars", `eris/${size}`)).toBeNull();
    }
    expect(ACTIVE_JAR_PROFILES.some((p) => ERIS_WORD.test(`${p.brand} ${p.size} ${p.label} ${p.key}`))).toBe(false);
    expect(resolveActiveJarProfile("Eris 60ml Jar")).toBeNull();
    expect(resolveActiveJarProfile("Eris 120ml Jar")).toBeNull();
    expect(listProductSpecs().some((s) => ERIS_WORD.test(`${s.productKey} ${s.displayName}`))).toBe(false);
  });

  it("an Eris recipe is never a quote-ready / launch-scope product", () => {
    const readiness = classifyRecipeReadiness({ name: "Eris 60ml Jar", productType: "jar_eris_60ml" }, []);
    expect(readiness.scope).toBe("jar_inactive");
    expect(readiness.quoteIssues).toEqual([]);
  });

  it("is not a storefront launch size and has no base price or price ladder", () => {
    expect(Object.keys(JAR_BASE_PRICES)).toEqual(["50ml", "100ml", "150ml", "250ml", "3oz", "4oz"]);
    expect(Object.keys(JAR_LAUNCH_TYPE_SIZES)).toEqual(["jar_50ml", "jar_100ml_tall", "jar_100ml_wide", "jar_150ml", "jar_250ml", "jar_3oz_clear", "jar_3oz_black_white", "jar_4oz_clear", "jar_4oz_black_white"]);
    for (const type of ["jar_eris_60ml", "jar_eris_120ml", "eris_60ml", "eris_120ml", "Eris 60ml Jar"]) expect(jarLaunchSizeForType(type)).toBeNull();
    for (const size of ERIS_SIZES) {
      expect(jarLaunchSizeForSizeKey(size)).toBeNull();
      for (const brand of ["eris", "miron", "chiron", "standard"]) {
        const ladder = resolveJarOwnerLadder({ brand, sizeKey: size, quantity: 500 });
        expect(ladder.ok, `${brand}/${size}`).toBe(false);
      }
    }
  });

  it("no sales rule / MOQ table and no Vendor Cost Book seed mentions Eris", () => {
    expect(ERIS_WORD.test(JSON.stringify(PRODUCT_FAMILY_SALES_RULES))).toBe(false);
    expect(APPROVED_COST_TRUTH.some((item) => ERIS_WORD.test(`${item.key} ${item.label}`))).toBe(false);
  });

  it("no storefront, App Proxy, configurator, theme, extension, seed tool or schema file mentions Eris", () => {
    const files = [
      "app/lib/canonical-jar-pricing.ts",
      "app/lib/jar-commercial-pricing.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/storefront-cost-snapshot.server.ts",
      "app/lib/configurator-pricing.ts",
      "app/lib/product-family-sales-rules.ts",
      "app/lib/product-family-registry.ts",
      "app/lib/approved-cost-updates.server.ts",
      "app/lib/product-production-spec.ts",
      "prisma/schema.prisma",
      ...readdirSync("app/routes").filter((name) => /^(apps\.wholesale-lite\.|webhooks\.|api\.)/.test(name)).map((name) => `app/routes/${name}`),
      ...readdirSync("tools").filter((name) => /\.(mjs|js|ts)$/.test(name)).map((name) => `tools/${name}`),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(ERIS_WORD.test(src(file)), file).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
describe("15. one Eris table — the cost resolver and the Cost Calculator read the same data", () => {
  it("the resolver, the summary, the calculator job and the picker option all return the table's own numbers", () => {
    for (const profile of COST_ONLY_JAR_PROFILES) {
      const table = ERIS_JAR_SUPPLIER_COST[profile.size];
      const resolved = resolveJarBlankCost({ brand: "eris", size: profile.size, quantity: 500 });
      const summary = costOnlyJarSummary(profile, 500)!;
      const option = costOnlyJarCalculatorOptions("premium-jars").find((o) => o.jarProfile === profile.key)!;
      const result = job(profile.key, 500);
      expect(resolved.ok && resolved.unitCost).toBe(table.supplierUnitCost);
      expect(summary.supplierUnitCost).toBe(table.supplierUnitCost);
      expect(summary.supplierQuantity).toBe(table.supplierQuantity);
      expect(option.costOnly.supplierUnitCost).toBe(table.supplierUnitCost);
      expect(option.costOnly.supplierQuantity).toBe(table.supplierQuantity);
      expect(result.diagnostics.costOnlyJar!.supplierUnitCost).toBe(table.supplierUnitCost);
      expect(lineOf(result, "blank_sets").amount).toBeCloseTo(505 * table.supplierUnitCost, 9);
      expect(lineOf(result, "blank_sets").note).toBe(resolved.ok ? resolved.source : "");
      expect(profile.label).toBe(table.name);
    }
  });

  it("the Eris dollar figures are written in exactly ONE source file", () => {
    const holders = readdirSync("app/lib").map((name) => `app/lib/${name}`)
      .concat(readdirSync("app/routes").map((name) => `app/routes/${name}`))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => /supplierUnitCost:\s*(2\.28|3\.22)\b/.test(src(file)));
    expect(holders).toEqual(["app/lib/jar-cost-inputs.server.ts"]);
  });

  it("the Cost Calculator route imports the option builder from the cost module and holds no copy of the numbers", () => {
    const route = src("app/routes/app.erp.cost-calculator.tsx");
    expect(route).toMatch(/import \{[^}]*\bcostOnlyJarCalculatorOptions\b[^}]*\} from "\.\.\/lib\/jar-cost-inputs\.server";/);
    expect(route).toContain(".concat(costOnlyJarCalculatorOptions(canonicalUiFamily(pFamily)) as any[])");
    expect(route).not.toMatch(/\b2\.28\b/);
    expect(route).not.toMatch(/\b3\.22\b/);
    expect(route).not.toMatch(/Eris (60|120)ml/);
    // the picker lists them, and the result panel shows base cost / tier / PENDING freight / PENDING landed cost
    expect(route).toContain("<optgroup label=\"ERIS — cost only, not for sale\">");
    expect(route).toContain("d.costOnlyJar.costLabel");
    expect(route).toContain("Known supplier tier:");
    expect(route).toContain("Inbound freight: <b>PENDING</b> (not $0)");
    expect(route).toContain("Landed unit cost: <b>PENDING</b>");
    expect(route).toContain("NOT FOR SALE · no price is suggested");
  });

  it("the canonical assembler costs Eris through the shared resolver functions, not its own numbers", () => {
    const assembler = src("app/lib/canonical-calculator.server.ts");
    expect(assembler).toContain("resolveJarBlankCost({ brand: cfg.brand, size: costOnlyJar.size, quantity: production })");
    expect(assembler).toContain("jarFreightPerUnit(cfg.brand, costOnlyJar.size)");
    expect(assembler).toContain("resolveJarApplication(costOnlyJar.size, selection)");
    expect(assembler).not.toMatch(/\b2\.28\b|\b3\.22\b/);
  });
});
