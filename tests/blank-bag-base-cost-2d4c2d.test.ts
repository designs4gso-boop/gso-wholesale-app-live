// Patch 2D-4C2D — BLANK BAG BASE COST AUTHORITY.
//
// Owner correction: the supplier base cost of a blank 4x5 bag is $0.09 EACH,
// BEFORE inbound freight. The $0.11 used from 2D-2 through 2D-4C2C was a
// landed-cost assumption — base plus an unstated freight allowance — and was
// never verified as a supplier price.
//
// The defect that hides inside a landed number: freight silently lives in the
// item cost, so the freight component looks like $0 and nobody can see what is
// missing. These tests pin the separation: $0.09 item cost, freight disclosed
// as not modelled, and no fabricated $0.02 bridging the two.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BAG_4X5_BLANK_RETIRED_LANDED_ASSUMPTION,
  BAG_4X5_BLANK_SOURCE,
  BAG_4X5_BLANK_UNIT_COST,
  BAG_4X5_CARTON_FACTS,
  BAG_4X5_CUTLINE_IN,
  BAG_APPLICATION_LABOR_RATE_PER_HOUR,
  BAG_APPLICATION_SECONDS_PER_SIDE,
  STOCK_BAG_MOQ,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";
import { LEGACY_CONFLICTING_RATES } from "../app/lib/owner-standards";
import { normalizeCanonicalInput, computeCanonicalJob } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";

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

describe("2D-4C2D (1) the canonical base cost is $0.09", () => {
  it("the supplier base cost is exactly $0.09", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.09);
  });

  it("$0.11 survives only as the named RETIRED landed assumption", () => {
    expect(BAG_4X5_BLANK_RETIRED_LANDED_ASSUMPTION).toBe(0.11);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank011LandedAssumption.value).toBe(0.11);
    expect(LEGACY_CONFLICTING_RATES.bag4x5Blank011LandedAssumption.supersededBy).toMatch(/0\.09/);
  });

  it("the source string says BEFORE inbound freight, so the split is unmissable", () => {
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/\$0\.09/);
    expect(BAG_4X5_BLANK_SOURCE).toMatch(/BEFORE inbound freight/i);
    expect(BAG_4X5_BLANK_SOURCE).not.toMatch(/\$0\.11/);
  });

  it("1000 bags cost 1000 x $0.09 in blank, not 1000 x $0.11", () => {
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 });
    expect(r.blankCost).toBeCloseTo(90, 10);
    expect(r.blankCost).not.toBeCloseTo(110, 2);
  });
});

describe("2D-4C2D (2,3) freight is separated, never assumed", () => {
  it("no $0.02 freight is hidden anywhere in the bag adapter", () => {
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/0\.02/);
    // and nothing reconstructs 0.11 by addition
    expect(code).not.toMatch(/0\.09\s*\+\s*0\.02/);
    expect(code).not.toMatch(/BAG_4X5_BLANK_UNIT_COST\s*\+/);
  });

  it("the blank line charges the base cost ONLY — no landed uplift", async () => {
    const input = normalizeCanonicalInput(new URLSearchParams(
      "pfamily=sticker-bags&pqty=1000&pbagsides=1&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0"))!;
    const r = await computeCanonicalJob(deps(), input);
    const blank = r.trueCost.lines.find((l) => l.key === "blank_sets")!;
    expect(blank.amount).toBeCloseTo(1000 * 0.09, 8);
    expect(blank.amount).not.toBeCloseTo(1000 * 0.11, 2);
    expect(blank.note).toMatch(/before inbound freight/i);
  });

  it("missing inbound freight stays DISCLOSED, not silently $0-certain", async () => {
    const input = normalizeCanonicalInput(new URLSearchParams(
      "pfamily=sticker-bags&pqty=1000&pbagsides=1&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0"))!;
    const r = await computeCanonicalJob(deps(), input);
    expect(r.reasons).toContain("FREIGHT_NOT_MODELED");
    // the freight component really is zero — which is exactly why it must be disclosed
    expect(r.trueCost.totals.inbound_freight).toBe(0);
  });

  it("6. no Southwest Cargo model is introduced for blank bags", () => {
    // Southwest Cargo may be NAMED in prose to rule it out; what must not
    // exist is any code that models it.
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/southwestCargo|SOUTHWEST_CARGO|swCargo/);
    // the adapter records the correct inbound METHOD without pricing it
    expect(BAG_4X5_CARTON_FACTS.inboundMethod).toMatch(/same pallet inbound method as jars/i);
    expect(BAG_4X5_CARTON_FACTS.inboundMethod).toMatch(/NOT Southwest Cargo/i);
  });

  it("carton facts are recorded for the future allocator but priced nowhere", () => {
    expect(BAG_4X5_CARTON_FACTS.coloured.bagsPerCarton).toBe(1000);
    expect(BAG_4X5_CARTON_FACTS.coloured.grossLb).toBe(10);
    expect(BAG_4X5_CARTON_FACTS.whiteBlack.bagsPerCarton).toBe(2000);
    expect(BAG_4X5_CARTON_FACTS.whiteBlack.grossLb).toBe(29);
    // no rate, no $/lb, no allocation maths
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const factsBlock = src.slice(src.indexOf("BAG_4X5_CARTON_FACTS"), src.indexOf("export const STOCK_BAG_MOQ"));
    // dimensions and weights only — no rate, no allocation arithmetic
    expect(factsBlock).not.toMatch(/perLb|perPallet|freightRate|costPer/);
    expect(factsBlock).not.toMatch(/[*/+]\s*(grossLb|bagsPerCarton)/);
  });
});

describe("2D-4C2D (4) both bag products share ONE blank authority", () => {
  it("Stock Bag and 4x5 Sticker Bag charge the identical blank cost", () => {
    const sticker = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    expect(stock.blankCost).toBe(sticker.blankCost);
    expect(stock.blankCost).toBeCloseTo(90, 10);
  });

  it("the constant is read once — neither product carries its own literal", () => {
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    expect(src.match(/BAG_4X5_BLANK_UNIT_COST = /g)).toHaveLength(1);
  });
});

describe("2D-4C2D (5) cutline, application and setup behaviour are unchanged", () => {
  it("the derived cutline still comes from the GSO offset rule", () => {
    expect(BAG_4X5_CUTLINE_IN.widthIn).toBeCloseTo(3.875, 10);
    expect(BAG_4X5_CUTLINE_IN.heightIn).toBeCloseTo(4.875, 10);
  });

  it("application is still 10s per applied side at $20/hr", () => {
    expect(BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    expect(BAG_APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    const r = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(r.application.applicationEvents).toBe(2000);
    expect(r.application.applicationLaborCost).toBeCloseTo((2000 * 10 / 3600) * 20, 10);
  });

  it("MOQ, setup and personalization rules are untouched", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    expect(stock.setup.art).toBe(0);
    expect(stock.setup.print).toBeCloseTo(1.0, 10);
    const sticker = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2, designs: 1 });
    expect(sticker.setup.art).toBeCloseTo(25 / 3, 10);
  });
});

describe("2D-4C2D (7) no production DB write path is touched", () => {
  it("Approved Cost Updates can NEITHER offer NOR apply a 4x5 blank-bag correction", () => {
    // 2D-4C2D1 — the entry is gone, so the admin preview cannot list it, the
    // apply path cannot score it, and no duplicate VendorProduct can be created.
    expect(APPROVED_COST_TRUTH.find((i) => i.key === "bag-4x5")).toBeUndefined();
    expect(APPROVED_COST_TRUTH.some((i) => i.matchVendorSkus?.includes("preset:blank-4x5-bag"))).toBe(false);
    expect(APPROVED_COST_TRUTH.some((i) => i.creation?.vendorSku === "preset:blank-4x5-bag")).toBe(false);
    // and no replacement no-op $0.09 target was left behind
    expect(APPROVED_COST_TRUTH.some((i) => i.flatCost === 0.09)).toBe(false);

    const src = readFileSync("app/lib/approved-cost-updates.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("BAG_MARKER_4X5");
    expect(code).not.toContain('key: "bag-4x5"');
    // the other bag corrections are untouched
    expect(APPROVED_COST_TRUTH.find((i) => i.key === "bag-4x6")).toBeDefined();
    expect(APPROVED_COST_TRUTH.find((i) => i.key === "bag-14x16")).toBeDefined();
  });

  it("the canonical adapter still owns the base cost, independent of that seed", () => {
    // removing the seed entry must not disturb what the calculator charges
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.09);
    expect(computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 }).blankCost).toBeCloseTo(90, 10);
  });

  it("the unguarded one-shot still writes no bag cost", () => {
    const src = readFileSync("tools/apply-15f0k4b-data-corrections.mjs", "utf8");
    expect(src.includes("costPerUnit: 0.09")).toBe(false);
    expect(src.includes("newCost: 0.09")).toBe(false);
    expect(src.includes("costPerUnit: 0.11")).toBe(false);
    expect(src).toMatch(/never writes a cost/);
  });

  it("the bag adapter reaches no database at all", () => {
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    for (const forbidden of ["db.server", "PrismaClient", "prisma", "vendorProduct", "$transaction"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
