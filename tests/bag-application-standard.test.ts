// Phase 15G.2A — owner-confirmed 4x5 bag label application throughput.
// Unit = applied LABEL (never bags): front-only bag = 1 label, front+back =
// 2 labels. NORMAL (canonical) = 256 labels/hr @ $20 = $0.078125/label;
// CONSERVATIVE (planning reference only) = 180 labels/hr = $0.111111/label.

import { describe, expect, it } from "vitest";
import { BAG_APPLICATION_THROUGHPUT, OWNER_STANDARDS } from "../app/lib/owner-standards";
import { OWNER_LABOR } from "../app/lib/calculator-emergency.server";
import { computeProductDrivenCost } from "../app/lib/product-driven-costing.server";

const NORMAL_PER_LABEL = 20 / 256; // $0.078125
const CONSERVATIVE_PER_LABEL = 20 / 180; // $0.111111...

function bagRun(quantity: number, faces: number) {
  return computeProductDrivenCost({
    family: "bags-4x5",
    quantity,
    designs: 1,
    facesPerUnit: faces,
    labelRows: null,
    dtp: null,
    widthIn: 4,
    heightIn: 5,
    blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: 0.09, tiers: [], status: "verified" },
    lid: null,
    material: { name: "Poseidon Matte", costPerSqft: 213 / 675 },
    printer: "mimaki",
    printerHasWhite: true,
    printerHasGloss: false,
    whiteLayers: 0,
    glossLayers: 0,
    glossCoveragePct: null,
    inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0,
    machineSqftPerHour: 0,
    machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: null,
    cutRequiresWeeding: false,
    hemming: false,
    grommets: false,
    freightPerUnit: 0,
    freightSource: "estimated",
    recipeWastePct: null,
    wasteOverride: null,
    boxOverride: null,
  });
}

function applicationLine(run: ReturnType<typeof computeProductDrivenCost>) {
  const line = run.lines.find((entry) => entry.key === "application");
  if (!line) throw new Error("no application line");
  return line;
}

describe("owner standard values", () => {
  it("normal canonical = 256 labels/hr @ $20 = $0.078125 per applied label", () => {
    expect(BAG_APPLICATION_THROUGHPUT.laborRatePerHour).toBe(20);
    expect(BAG_APPLICATION_THROUGHPUT.normalLabelsPerHour).toBe(256);
    expect(BAG_APPLICATION_THROUGHPUT.unit).toContain("labels, not bags");
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.value).toBeCloseTo(NORMAL_PER_LABEL, 12);
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.value).toBeCloseTo(0.078125, 12);
    expect(OWNER_LABOR.bagLabelApplicationPer).toBeCloseTo(NORMAL_PER_LABEL, 12);
  });

  it("conservative reference = 180 labels/hr = $0.111111 per applied label, and it never controls canonical quoting", () => {
    expect(BAG_APPLICATION_THROUGHPUT.conservativeLabelsPerHour).toBe(180);
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5Conservative.value).toBeCloseTo(CONSERVATIVE_PER_LABEL, 12);
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5Conservative.value).toBeCloseTo(0.1111111111, 9);
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5Conservative.basis).toContain("NOT used in canonical quoting");
    // the wired canonical rate is the NORMAL one
    expect(OWNER_LABOR.bagLabelApplicationPer).not.toBeCloseTo(CONSERVATIVE_PER_LABEL, 6);
  });
});

describe("engine charges by applied-label count (labels, never bags or sides)", () => {
  it("500 front-only bags = 500 labels → $39.0625 normal ($55.5556 conservative reference)", () => {
    const line = applicationLine(bagRun(500, 1));
    expect(line.label).toContain("500 label(s)");
    expect(line.amount).toBeCloseTo(39.0625, 6);
    expect(500 * CONSERVATIVE_PER_LABEL).toBeCloseTo(55.5556, 3);
  });

  it("500 front+back bags = 1,000 labels → $78.125 normal ($111.1111 conservative reference)", () => {
    const line = applicationLine(bagRun(500, 2));
    expect(line.label).toContain("1000 label(s)");
    expect(line.amount).toBeCloseTo(78.125, 6);
    expect(1000 * CONSERVATIVE_PER_LABEL).toBeCloseTo(111.1111, 3);
  });

  it("1,000 front+back bags = 2,000 labels → $156.25 normal ($222.2222 conservative reference)", () => {
    const line = applicationLine(bagRun(1000, 2));
    expect(line.label).toContain("2000 label(s)");
    expect(line.amount).toBeCloseTo(156.25, 6);
    expect(2000 * CONSERVATIVE_PER_LABEL).toBeCloseTo(222.2222, 3);
  });

  it("no per-bag confusion and no legacy per-side floor: amount is exactly labels x $0.078125", () => {
    const run = bagRun(500, 2);
    const line = applicationLine(run);
    expect(run.derived.applicationCount).toBe(1000);
    expect(line.amount).toBeCloseTo(run.derived.applicationCount * NORMAL_PER_LABEL, 9);
    // never the conservative rate, never a $0.20 or $0.15 per-side floor
    expect(line.amount).not.toBeCloseTo(1000 * CONSERVATIVE_PER_LABEL, 4);
    expect(line.amount).not.toBeCloseTo(500 * 2 * 0.2, 4);
    expect(line.amount).not.toBeCloseTo(500 * 2 * 0.15, 4);
  });
});
