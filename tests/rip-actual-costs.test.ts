import { describe, expect, it } from "vitest";

import {
  MACHINE_RATE_HIGH,
  MACHINE_RATE_LOW,
  MATCH_STATUS_LABELS,
  attributeMachine,
  buildBrandRates,
  computeEntryCosts,
  machineCost,
  matchMediaToMaterial,
  matchStatusOf,
  rollupByTicket,
} from "../app/lib/rip-actual-costs.server";

const machines = [
  {
    name: "Mimaki UCJV300-130",
    inkChannels: [
      { inkType: "cmyk", inkName: "Cyan", enabled: true, costPerMl: 0.176, cartridgeCost: 176, cartridgeMl: 1000 },
      { inkType: "cmyk", inkName: "Black", enabled: true, costPerMl: 0.176, cartridgeCost: 176, cartridgeMl: 1000 },
      { inkType: "white", inkName: "White", enabled: true, costPerMl: 0.176, cartridgeCost: 176, cartridgeMl: 1000 },
    ],
  },
  {
    name: "Roland TrueVIS LG-540",
    inkChannels: [
      { inkType: "cmyk", inkName: "Cyan", enabled: true, costPerMl: 149 / 750, cartridgeCost: 149, cartridgeMl: 750 },
      { inkType: "white", inkName: "White", enabled: true, costPerMl: 149 / 750, cartridgeCost: 149, cartridgeMl: 750 },
      { inkType: "gloss", inkName: "Gloss", enabled: true, costPerMl: 149 / 750, cartridgeCost: 149, cartridgeMl: 750 },
    ],
  },
];

describe("brand rates and machine attribution", () => {
  it("builds per-brand rates from DB channels (verified $/ml, never hardcoded)", () => {
    const rates = buildBrandRates(machines);
    const mimaki = rates.find((rate) => rate.brand === "mimaki")!;
    expect(mimaki.cmykPerMl).toBeCloseTo(0.176, 6);
    expect(mimaki.glossPerMl).toBeNull(); // Mimaki has no gloss channel
    const roland = rates.find((rate) => rate.brand === "roland")!;
    expect(roland.cmykPerMl).toBeCloseTo(149 / 750, 6);
    expect(roland.glossPerMl).toBeCloseTo(149 / 750, 6);
  });

  it("attributes machine by name, then software, then the route token in the job name", () => {
    expect(attributeMachine({ machineName: "Mimaki UCJV300" })).toBe("mimaki");
    expect(attributeMachine({ machineName: "", printerSoftware: "VersaWorks 6" })).toBe("roland");
    expect(attributeMachine({ machineName: "", printerSoftware: "", sourceJobName: "GSO-123_Cust_Prod_FRONT_Matte_ROLAND_R1" })).toBe("roland");
    expect(attributeMachine({ machineName: "", printerSoftware: "", sourceJobName: "GSO-123_Cust_Prod_FRONT_Matte_MIMAKI_R1" })).toBe("mimaki");
    expect(attributeMachine({ machineName: "", printerSoftware: "", sourceJobName: "no token here" })).toBeNull();
  });
});

describe("entry cost computation", () => {
  const rates = buildBrandRates(machines);

  it("computes ink cost from channel ml x verified rates and machine cost at both rates", () => {
    const costs = computeEntryCosts(
      { machineName: "Mimaki UCJV300", cmykInkMl: 100, whiteInkMl: 0, glossInkMl: 0, inkMl: 100, printMinutes: 30 },
      rates,
    );
    expect(costs.inkCost).toBeCloseTo(100 * 0.176, 6);
    expect(costs.machineCostLow).toBeCloseTo((30 / 60) * MACHINE_RATE_LOW, 6);
    expect(costs.machineCostHigh).toBeCloseTo((30 / 60) * MACHINE_RATE_HIGH, 6);
    expect(machineCost(30, 5)).toBeCloseTo(2.5, 6);
    expect(machineCost(30, 8)).toBeCloseTo(4, 6);
  });

  it("warns and returns null ink cost when the machine cannot be attributed — never guesses", () => {
    const costs = computeEntryCosts({ machineName: "", printerSoftware: "", sourceJobName: "", cmykInkMl: 50, whiteInkMl: 0, glossInkMl: 0, inkMl: 50, printMinutes: 10 }, rates);
    expect(costs.inkCost).toBeNull();
    expect(costs.warnings.some((warning) => warning.includes("could not be attributed"))).toBe(true);
  });

  it("15G.2: canonical ink authority prices known channels even when DB channel costs are missing", () => {
    // Before 15G.2 a missing white channel row meant white ml was excluded
    // from actual cost. The canonical ink authority (ink-rates-shared) now
    // defines Mimaki white = $176/1000ml regardless of seeded DB rows, so
    // actuals and estimates price ink identically. Mimaki gloss stays null
    // (CMYK-only — no rate may exist).
    const noWhite = buildBrandRates([{ name: "Mimaki UCJV300", inkChannels: [{ inkType: "cmyk", inkName: "Cyan", enabled: true, costPerMl: 0.176 }] }]);
    expect(noWhite[0].whitePerMl).toBeCloseTo(176 / 1000, 9);
    expect(noWhite[0].glossPerMl).toBeNull();
    const costs = computeEntryCosts({ machineName: "Mimaki", cmykInkMl: 10, whiteInkMl: 5, glossInkMl: 0, inkMl: 15, printMinutes: 5 }, noWhite);
    expect(costs.inkCost).toBeCloseTo(10 * 0.176 + 5 * 0.176, 6);
    const glossCosts = computeEntryCosts({ machineName: "Mimaki", cmykInkMl: 10, whiteInkMl: 0, glossInkMl: 5, inkMl: 15, printMinutes: 5 }, noWhite);
    expect(glossCosts.warnings.some((warning) => warning.includes("No gloss/clear channel cost"))).toBe(true);
    expect(glossCosts.inkCost).toBeCloseTo(10 * 0.176, 6);
  });

  it("flags white/gloss on Mimaki per the routing business rule", () => {
    const costs = computeEntryCosts({ machineName: "Mimaki UCJV300", cmykInkMl: 20, whiteInkMl: 8, glossInkMl: 0, inkMl: 28, printMinutes: 12 }, rates);
    expect(costs.warnings.some((warning) => warning.includes("ROUTING") && warning.includes("Mimaki is CMYK-only"))).toBe(true);
    const rolandOk = computeEntryCosts({ machineName: "Roland LG-540", cmykInkMl: 20, whiteInkMl: 8, glossInkMl: 3, inkMl: 31, printMinutes: 12 }, rates);
    expect(rolandOk.warnings.some((warning) => warning.includes("ROUTING"))).toBe(false);
  });

  it("warns on missing minutes and missing ink ml", () => {
    const costs = computeEntryCosts({ machineName: "Roland", cmykInkMl: 0, whiteInkMl: 0, glossInkMl: 0, inkMl: 0, printMinutes: 0 }, rates);
    expect(costs.warnings.some((warning) => warning.includes("Missing ink ml"))).toBe(true);
    expect(costs.warnings.some((warning) => warning.includes("Missing print minutes"))).toBe(true);
  });
});

describe("match status and media matching", () => {
  it("classifies match status from existing fields only", () => {
    expect(matchStatusOf({ productionJobId: "job1", jobTicket: "GSO-1" })).toBe("matched");
    expect(matchStatusOf({ productionJobId: null, jobTicket: "GSO-42" })).toBe("potentially_matchable");
    expect(matchStatusOf({ productionJobId: null, jobTicket: "GSOQ-7" })).toBe("quote_rip");
    expect(matchStatusOf({ productionJobId: null, jobTicket: "" })).toBe("missing_ticket");
    for (const label of Object.values(MATCH_STATUS_LABELS)) expect(label.length).toBeGreaterThan(0);
  });

  it("media matching: unique name match shows $/sqft; ambiguous/none warn and never persist anything", () => {
    const materials = [
      { id: "a", name: "Poseidon Matte Roll Media", calculatedUnitCost: 213 / 675, baseUnit: "sqft", unit: "sqft" },
      { id: "b", name: "Holographic Roll Media", calculatedUnitCost: 488 / ((50 / 12) * 164), baseUnit: "sqft", unit: "sqft" },
    ];
    const unique = matchMediaToMaterial("Poseidon Matte", materials as any);
    expect(unique.material?.id).toBe("a");
    expect(unique.costPerSqft).toBeCloseTo(213 / 675, 6);

    const none = matchMediaToMaterial("Mystery Vinyl 3000", materials as any);
    expect(none.material).toBeNull();
    expect(none.warning).toContain("does not match any Material");

    const ambiguous = matchMediaToMaterial("Roll Media", materials as any);
    expect(ambiguous.material).toBeNull();
    expect(ambiguous.warning).toContain("ambiguous");
  });
});

describe("ticket rollup", () => {
  it("totals per ticket and flags multiple machines/media + partial ink cost", () => {
    const rollups = rollupByTicket([
      { jobTicket: "GSO-1", productionJobId: "job1", machineBrand: "roland", machineName: "Roland LG-540", mediaName: "Matte", inkMl: 100, inkCost: 19.87, printMinutes: 30 },
      { jobTicket: "GSO-1", productionJobId: "job1", machineBrand: "mimaki", machineName: "Mimaki UCJV300", mediaName: "Holographic", inkMl: 50, inkCost: null, printMinutes: 15 },
      { jobTicket: "GSO-2", productionJobId: null, machineBrand: "mimaki", machineName: "Mimaki UCJV300", mediaName: "Matte", inkMl: 20, inkCost: 3.52, printMinutes: 10 },
    ]);
    const first = rollups.find((rollup) => rollup.jobTicket === "GSO-1")!;
    expect(first.rowCount).toBe(2);
    expect(first.totalInkMl).toBeCloseTo(150, 6);
    expect(first.totalPrintMinutes).toBeCloseTo(45, 6);
    expect(first.machineCostLow).toBeCloseTo((45 / 60) * MACHINE_RATE_LOW, 6);
    expect(first.machineCostHigh).toBeCloseTo((45 / 60) * MACHINE_RATE_HIGH, 6);
    expect(first.inkCostComplete).toBe(false);
    expect(first.warnings.some((warning) => warning.includes("Multiple machines"))).toBe(true);
    expect(first.warnings.some((warning) => warning.includes("Multiple media"))).toBe(true);

    const second = rollups.find((rollup) => rollup.jobTicket === "GSO-2")!;
    expect(second.inkCostComplete).toBe(true);
    expect(second.warnings).toHaveLength(0);
  });
});
