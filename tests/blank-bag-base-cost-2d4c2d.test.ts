// 4X5 BLANK BAG AUTHORITY — OWNER DECISION 2026-10-08: $0.11 EACH, ANY COLOUR.
//
// This file began as Patch 2D-4C2D, which pinned "$0.09 supplier base BEFORE
// inbound freight" and retired $0.11. On 2026-10-08 the owner resolved the two
// competing records the other way: $0.11 is the true base cost, $0.09 is
// SUPERSEDED, and no generic freight uplift is added on top. These tests pin
// ONE authority ($0.11 everywhere current), the freight disclosure that stays,
// and everything the correction must not move.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BAG_4X5_BLANK_EFFECTIVE_DATE,
  BAG_4X5_BLANK_SOURCE,
  BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24,
  BAG_4X5_BLANK_UNIT_COST,
  BAG_4X5_CARTON_FACTS,
  BAG_4X5_CUTLINE_IN,
  BAG_APPLICATION_LABOR_RATE_PER_HOUR,
  BAG_APPLICATION_SECONDS_PER_SIDE,
  STICKER_BAG_MOQ,
  STOCK_BAG_MOQ,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";
import { LEGACY_CONFLICTING_RATES, OWNER_STANDARDS } from "../app/lib/owner-standards";
import { normalizeCanonicalInput, computeCanonicalJob } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { decideMachine } from "../app/lib/print-intake-routing.server";
import { DTP_OWNER_PRICE_LADDERS } from "../app/lib/dtp-owner-pricing.server";

/* ---- seeded calibrations, so a full canonical bag job can be costed ---- */
const MEASURED: Record<string, any> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([k, id]) => ({
  id: `cal_${k}`, shop: "s", ...id, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout",
  fixedMinutes: null, timeModel: "variable_only", measuredAt: new Date(0), effectiveFrom: new Date(0),
  effectiveTo: null, status: "approved", source: "owner", notes: null, supersedesId: null,
  createdAt: new Date(0), ...MEASURED[k],
}));
const deps = () => ({
  db: { machineProfileCalibration: { findMany: async ({ where }: any) =>
    ROWS.filter((r) => Object.entries(where).every(([f, v]) => (f === "shop" ? true : (r as any)[f] === v))) } },
  shop: "s",
});
const codeOf = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const bagJob = (family: "sticker-bags" | "stock-bags", blankUnitCost: number | null = null) => {
  // the UI family is always "sticker-bags"; pstockbag=1 selects the stock bag (canonicalFamilyFromUi)
  const input = normalizeCanonicalInput(new URLSearchParams(`pfamily=sticker-bags${family === "stock-bags" ? "&pstockbag=1" : ""}&pqty=1000&pbagsides=1&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0`))!;
  expect(input.family).toBe(family);
  return computeCanonicalJob(deps(), blankUnitCost == null ? input : { ...input, bags: { ...(input.bags ?? { sides: 1 as any }), blankUnitCost } });
};

describe("4x5 blank bag authority (1) the owner base cost is $0.11 — ONE authority", () => {
  it("the constant is exactly $0.11, effective 2026-10-08, and the source names the decision", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(BAG_4X5_BLANK_EFFECTIVE_DATE).toBe("2026-10-08");
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/2026-10-08/);
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/\$0\.11/);
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/regardless of colour/i);
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/supersedes/i);
  });

  it("$0.09 survives only as the named SUPERSEDED figure (code + owner-standards provenance)", () => {
    expect(BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24).toBe(0.09);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank009SupplierBaseSuperseded.value).toBe(0.09);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank009SupplierBaseSuperseded.supersededBy).toMatch(/\$0\.11/);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank009SupplierBaseSuperseded.supersededBy).toMatch(/2026-10-08/);
    expect((LEGACY_CONFLICTING_RATES as any).bag4x5Blank011LandedAssumption).toBeUndefined();
  });

  it("1,000 bags cost 1,000 x $0.11 in blank, not 1,000 x $0.09", () => {
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 });
    expect(r.blankCost).toBeCloseTo(110, 10);
    expect(r.blankCost).not.toBeCloseTo(90, 2);
  });

  it("no current runtime authority still carries 0.09 (only the SUPERSEDED constants may)", () => {
    const allowed = [/BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24 = 0\.09/, /bag4x5Blank009SupplierBaseSuperseded: \{\s*value: 0\.09,/, /supersedes the 2026-08-24 \$0\.09-before-freight rule/];
    for (const file of [
      "app/lib/bag-cost-inputs.server.ts",
      "app/lib/owner-standards.ts",
      "app/lib/canonical-calculator.server.ts",
      "app/lib/approved-cost-updates.server.ts",
      "app/lib/cost-verification-shared.ts",
      "app/routes/app.erp.cost-verification.tsx",
      "app/routes/app.erp.cost-calculator.tsx",
      "app/lib/product-production-spec.ts",
    ]) {
      let code = codeOf(file);
      for (const a of allowed) code = code.replace(a, "");
      code = code.replace(/[^"\n]*supersed[^"\n]*/gi, ""); // provenance strings may NAME the superseded $0.09
      expect(code, `${file} still carries a current 0.09`).not.toMatch(/\b0\.09\b/);
    }
    expect(APPROVED_COST_TRUTH.some((i) => i.flatCost === 0.09)).toBe(false);
  });
});

describe("4x5 blank bag authority (2) freight is disclosed, never uplifted", () => {
  it("no generic freight uplift is hidden in the bag adapter", () => {
    const code = codeOf("app/lib/bag-cost-inputs.server.ts");
    expect(code).not.toMatch(/0\.02/);
    expect(code).not.toMatch(/BAG_4X5_BLANK_UNIT_COST\s*\+/);
    expect(code).not.toMatch(/BAG_4X5_BLANK_UNIT_COST\s*\*\s*1\./);
  });

  it("the canonical blank line charges exactly $0.11 x 1,000 and names the 2026-10-08 decision", async () => {
    const r = await bagJob("sticker-bags");
    const blank = r.trueCost.lines.find((l) => l.key === "blank_sets")!;
    expect(blank.amount).toBeCloseTo(1000 * 0.11, 8);
    expect(blank.amount).not.toBeCloseTo(1000 * 0.09, 2);
    expect(String(blank.note || "")).toMatch(/2026-10-08|\$0\.11/);
  });

  it("missing inbound freight stays DISCLOSED (FREIGHT_NOT_MODELED), inbound_freight component is $0", async () => {
    const r = await bagJob("sticker-bags");
    expect(r.reasons).toContain("FREIGHT_NOT_MODELED");
    expect(r.trueCost.totals.inbound_freight).toBe(0);
  });

  it("no Southwest Cargo model is introduced; carton facts stay unpriced", () => {
    const code = codeOf("app/lib/bag-cost-inputs.server.ts");
    expect(code).not.toMatch(/southwestCargo|SOUTHWEST_CARGO|swCargo/);
    expect(BAG_4X5_CARTON_FACTS.inboundMethod).toMatch(/same pallet inbound method as jars/i);
    expect(BAG_4X5_CARTON_FACTS.coloured.bagsPerCarton).toBe(1000);
    expect(BAG_4X5_CARTON_FACTS.whiteBlack.bagsPerCarton).toBe(2000);
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const factsBlock = src.slice(src.indexOf("BAG_4X5_CARTON_FACTS"), src.indexOf("export const STOCK_BAG_MOQ"));
    expect(factsBlock).not.toMatch(/perLb|perPallet|freightRate|costPer/);
  });
});

describe("4x5 blank bag authority (3) Sticker Bag and Stock Bag share the ONE authority", () => {
  it("Stock Bag and 4x5 Sticker Bag charge the identical $0.11 blank cost", () => {
    const sticker = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    expect(stock.blankCost).toBe(sticker.blankCost);
    expect(stock.blankCost).toBeCloseTo(110, 10);
  });

  it("both canonical families moved by exactly $0.02 x 1,000 = $20.00 against the superseded $0.09 (cost impact)", async () => {
    for (const family of ["sticker-bags", "stock-bags"] as const) {
      const now = await bagJob(family);
      const superseded = await bagJob(family, 0.09);
      expect(now.totalCost! - superseded.totalCost!).toBeCloseTo(20, 6);
      expect(now.trueCost.lines.find((l) => l.key === "blank_sets")!.amount).toBeCloseTo(110, 8);
    }
  });

  it("the constant is read once — neither product carries its own literal", () => {
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    expect(src.match(/BAG_4X5_BLANK_UNIT_COST = /g)).toHaveLength(1);
  });
});

describe("4x5 blank bag authority (4) Approved Cost Updates carries $0.11 and can never duplicate the row", () => {
  it("entry bag-4x5: flat $0.11, exact vendorSku, verified marker dated 2026-10-08, NO creation spec", () => {
    const entry = APPROVED_COST_TRUTH.find((i) => i.key === "bag-4x5")!;
    expect(entry).toBeDefined();
    expect(entry.target).toBe("vendor_product");
    expect(entry.kind).toBe("flat");
    expect(entry.policy).toBe("update");
    expect(entry.flatCost).toBe(0.11);
    expect(entry.matchVendorSkus).toEqual(["preset:blank-4x5-bag"]);
    expect(entry.marker).toMatch(/\[VERIFIED 2026-10-08/);
    expect(entry.creation).toBeUndefined();
    // the name regex matches the production row and nothing that merely contains "4x5"
    expect(entry.matchName.test("4x5 Blank Bag")).toBe(true);
    for (const other of ["DTP 4x5x2 Blank Pouch (unprinted)", "Spektra DTP 4x5x2", "Template - 4x5 Outsourced Stock Bag", "4x5 custom box", "4x6 Sticker Bag"]) {
      expect(entry.matchName.test(other), other).toBe(false);
    }
    // the other bag corrections are untouched
    expect(APPROVED_COST_TRUTH.find((i) => i.key === "bag-4x6")?.flatCost).toBe(0.1);
    expect(APPROVED_COST_TRUTH.find((i) => i.key === "bag-14x16")?.flatCost).toBe(1.0);
  });

  it("the old neutralised one-shot still writes no bag cost, and the bag adapter reaches no database", () => {
    const oneShot = readFileSync("tools/apply-15f0k4b-data-corrections.mjs", "utf8");
    expect(oneShot.includes("costPerUnit: 0.09")).toBe(false);
    expect(oneShot.includes("costPerUnit: 0.11")).toBe(false);
    expect(oneShot).toMatch(/never writes a cost/);
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    for (const forbidden of ["db.server", "PrismaClient", "prisma", "vendorProduct", "$transaction"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("the authorised production update tool targets exactly the two records, confirms $0.09 first, and never touches history tables", () => {
    const tool = codeOf("tools/apply-4x5-blank-authority-2026-10-08.mjs");
    expect(tool).toContain('"cmowdnhb40003h128csyx8il2"'); // Material 4x5 Blank Bag
    expect(tool).toContain('"cmrpjvdc50000av2atvnbt09e"'); // VendorProduct preset:blank-4x5-bag
    expect(tool).toMatch(/EXPECTED_BEFORE = 0\.09/);
    expect(tool).toMatch(/NEW_COST = 0\.11/);
    expect((tool.match(/\.update\(/g) || []).length).toBe(2);
    expect((tool.match(/materialCostHistory\.create\(/g) || []).length).toBe(1);
    expect(tool).not.toMatch(/updateMany|deleteMany|\.delete\(|\.quote|quoteSnapshot|productionJob|actualCost|invoice/i);
    expect(tool).toMatch(/--write/);
  });
});

describe("4x5 blank bag authority (5) everything else is unchanged", () => {
  it("cutline, application and setup behaviour are unchanged", () => {
    expect(BAG_4X5_CUTLINE_IN.widthIn).toBeCloseTo(3.875, 10);
    expect(BAG_4X5_CUTLINE_IN.heightIn).toBeCloseTo(4.875, 10);
    expect(BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    expect(BAG_APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(r.application.applicationEvents).toBe(2000);
    expect(r.application.applicationLaborCost).toBeCloseTo((2000 * 10 / 3600) * 20, 10);
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    expect(stock.setup.art).toBe(0);
    expect(stock.setup.print).toBeCloseTo(1.0, 10);
    const sticker = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2, designs: 1 });
    expect(sticker.setup.art).toBeCloseTo(25 / 3, 10);
  });

  it("MOQ stays 50 for both bag products", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(STICKER_BAG_MOQ).toBe(50);
  });

  it("routing unchanged: white / gloss -> Roland, CMYK -> Mimaki", () => {
    expect(decideMachine({ selectedFinish: "White + CMYK", materialSummary: "white ink layer", machineSummary: null } as any).machine).toBe("roland");
    expect(decideMachine({ selectedFinish: "Gloss", materialSummary: "spot gloss", machineSummary: null } as any).machine).toBe("roland");
    expect(decideMachine({ selectedFinish: "CMYK", materialSummary: "standard cmyk", machineSummary: null } as any).machine).toBe("mimaki");
  });

  it("machine recovery stays $5/hour (owner_verified)", () => {
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(5);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.status).toBe("owner_verified");
  });

  it("DTP ladders unchanged", () => {
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-3.5x4.5x2"]).toEqual({ 1000: 1.3, 2500: 0.7, 5000: 0.45, 10000: 0.36, 25000: 0.29 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-5x5x2"]).toEqual({ 1000: 1.35, 2500: 0.75, 5000: 0.49, 10000: 0.41, 25000: 0.35 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-6x5x2"]).toEqual({ 1000: 1.4, 2500: 0.78, 5000: 0.54, 10000: 0.46, 25000: 0.4 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-8x5x2"]).toEqual({ 1000: 1.5, 2500: 0.86, 5000: 0.65, 10000: 0.59, 25000: 0.52 });
  });
});
