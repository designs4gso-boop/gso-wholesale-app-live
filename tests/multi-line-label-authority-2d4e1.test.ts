// Patch 2D-4E1 — multi-line label jobs quote from CANONICAL cost.
//
// Before this patch the combined multi-line job was costed, displayed and
// SAVED from per-line legacy engine runs even though the family is a
// CANONICAL_COST_AUTHORITY family. These tests pin the new authority:
//   A. canonical manufacturing jobCost/unitCost are what the job carries;
//   B. shared vs new artwork and mixed material flow through unchanged;
//   C. entered quantities are preserved exactly;
//   D. a blocked / null canonical result leaves every money field null and
//      refuses the save — never $0, never the legacy number;
//   E. the route wires the helper on BOTH the loader and the save side.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import {
  MULTI_LINE_LABEL_AUTHORITY_VERSION,
  MULTI_LINE_REASONS,
  allocateCanonicalJobCost,
  canonicalLineKeyFor,
  resolveMultiLineLabelQuote,
  type MultiLineLegacyLine,
} from "../app/lib/multi-line-label-authority.server";
import { persistQuoteIfCanonicalAllows } from "../app/lib/canonical-quote-authority.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";

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
const NO_CAL: ResolvedMachineInputs = {
  calibration: null,
  calibrationMessage: "No approved calibration for this identity.",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};

/** What the form emits for Line 1 (pl0) + one additional line (pl1). */
function params(opts: { line2Art: "ART-1" | "ART-2"; line2Mat?: "matte" | "holographic"; pqty?: string }) {
  return new URLSearchParams({
    pfamily: "stickers-labels", pprinter: "auto", pwhitelayers: "0", pglosslayers: "0",
    ...(opts.pqty ? { pqty: opts.pqty } : {}),
    pllines: "2",
    pl0qty: "500", pl0w: "3", pl0h: "3", pl0mat: "matte", pl0art: "ART-1", pl0cuttype: "rectangular", pl0printsetups: "1",
    pl1qty: "250", pl1w: "2", pl1h: "4", pl1mat: opts.line2Mat ?? "matte", pl1art: opts.line2Art, pl1cuttype: "rectangular", pl1printsetups: "1",
  });
}

/** The legacy per-line records the route builds (costs deliberately WRONG). */
const LEGACY_LINES: MultiLineLegacyLine[] = [
  { lineNumber: 1, name: "Line 1 (main sticker entry)", quantity: 500, designs: 1, glossOrWhite: false, lineCost: 999.99, missing: [], fieldErrors: [], finishedSqft: 31.25, setupTotal: 9.33 },
  { lineNumber: 2, name: "Line 2", quantity: 250, designs: 1, glossOrWhite: false, lineCost: 555.55, missing: [], fieldErrors: [], finishedSqft: 13.89, setupTotal: 9.33 },
];

const MARGIN = resolveMarginFamily("stickers-labels");

function canonicalFor(opts: Parameters<typeof params>[0], machine = CAL) {
  const input = normalizeCanonicalInput(params(opts));
  expect(input).not.toBeNull();
  return { input: input!, result: assembleCanonicalJob(input!, machine) };
}

describe("2D-4E1 (A) canonical manufacturing cost is the multi-line authority", () => {
  it("the combined job carries the canonical jobCost and unitCost, not the legacy sum", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    expect(result.status).not.toBe("DRAFT_ONLY");
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: result, marginRule: MARGIN });

    expect(quote.version).toBe(MULTI_LINE_LABEL_AUTHORITY_VERSION);
    expect(quote.costAuthority).toBe("canonical");
    expect(quote.authority.authority).toBe("canonical");
    expect(quote.totalCost).toBeCloseTo(result.totalCost, 10);
    expect(quote.unitCost).toBeCloseTo(result.unitCost!, 10);
    // the legacy numbers (999.99 + 555.55) never leak into the job
    expect(quote.totalCost).not.toBeCloseTo(1555.54, 2);
    expect(quote.blockers).toEqual([]);
  });

  it("the canonical unit cost divides the job total by the SUM of entered lines (750), not Line 1 only", () => {
    const { input, result } = canonicalFor({ line2Art: "ART-1", pqty: "500" });
    expect(input.quantity).toBe(750);
    expect(result.trueCost.customerFinishedQty).toBe(750);
    expect(result.unitCost).toBeCloseTo(result.totalCost / 750, 10);
  });

  it("the commercial price is derived from the canonical cost basis and never below it", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: result, marginRule: MARGIN });
    expect(quote.finalTotalPrice).not.toBeNull();
    expect(quote.finalTotalPrice!).toBeGreaterThan(quote.totalCost!);
    expect(quote.achievedProfit).toBeCloseTo(quote.finalTotalPrice! - result.totalCost, 8);
    expect(quote.lines).toHaveLength(2);
    // per-line commercial costs sum to the canonical job total exactly
    const pricedSum = quote.lines.reduce((sum, line) => sum + line.pricedCost, 0);
    expect(pricedSum).toBeCloseTo(result.totalCost, 8);
    expect(quote.reasons).toContain(MULTI_LINE_REASONS.canonicalAllocation);
    expect(quote.controllingRule).toContain("canonical true manufacturing cost");
  });

  it("the allocation is for commercial bands only and sums to the canonical total", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    const alloc = allocateCanonicalJobCost(result.totalCost, LEGACY_LINES, result.adapter.label!.lines);
    expect(alloc.basis).toBe("canonical_material_footprint");
    expect(alloc.perLine.reduce((sum, line) => sum + line.allocatedCost, 0)).toBeCloseTo(result.totalCost, 10);
    expect(alloc.perLine.reduce((sum, line) => sum + line.share, 0)).toBeCloseTo(1, 10);
    expect(canonicalLineKeyFor(1)).toBe("line-0");
    expect(canonicalLineKeyFor(2)).toBe("line-1");
    // quantity fallback when a line has no footprint
    const fallback = allocateCanonicalJobCost(100, LEGACY_LINES, []);
    expect(fallback.basis).toBe("quantity");
    expect(fallback.perLine[0].allocatedCost).toBeCloseTo(100 * 500 / 750, 10);
    expect(fallback.perLine[1].allocatedCost).toBeCloseTo(100 * 250 / 750, 10);
    expect(fallback.perLine[0].allocatedCost + fallback.perLine[1].allocatedCost).toBe(100);
  });
});

describe("2D-4E1 (B) artwork identity and material flow through unchanged", () => {
  it("shared artwork: one art setup, two print setups; new artwork: two art setups", () => {
    const shared = canonicalFor({ line2Art: "ART-1" }).result;
    const fresh = canonicalFor({ line2Art: "ART-2" }).result;
    expect(shared.adapter.label!.setup.artSetupEvents).toBe(1);
    expect(shared.adapter.label!.setup.printSetupEvents).toBe(2);
    expect(fresh.adapter.label!.setup.artSetupEvents).toBe(2);
    expect(fresh.totalCost).toBeGreaterThan(shared.totalCost);
    const sharedQuote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: shared, marginRule: MARGIN });
    const freshQuote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: fresh, marginRule: MARGIN });
    expect(freshQuote.totalCost!).toBeGreaterThan(sharedQuote.totalCost!);
    expect(freshQuote.totalCost! - sharedQuote.totalCost!).toBeCloseTo(fresh.totalCost - shared.totalCost, 8);
  });

  it("mixed material: the holographic line costs more and the job total follows canonical exactly", () => {
    const matte = canonicalFor({ line2Art: "ART-1", line2Mat: "matte" }).result;
    const holo = canonicalFor({ line2Art: "ART-1", line2Mat: "holographic" }).result;
    expect(holo.adapter.label!.lines[1].material!.label).toBe("Holographic");
    expect(holo.totalCost).toBeGreaterThan(matte.totalCost);
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: holo, marginRule: MARGIN });
    expect(quote.totalCost).toBeCloseTo(holo.totalCost, 10);
    expect(quote.unitCost).toBeCloseTo(holo.unitCost!, 10);
  });
});

describe("2D-4E1 (C) exact quantity preservation", () => {
  it("line quantities are read as typed and the job total is their sum", () => {
    const { input, result } = canonicalFor({ line2Art: "ART-2" });
    expect(input.labels!.lines.map((line) => line.quantity)).toEqual([500, 250]);
    expect(input.quantity).toBe(750);
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: result, marginRule: MARGIN });
    expect(quote.totalQuantity).toBe(750);
    expect(quote.lines.map((line) => line.quantity)).toEqual([500, 250]);
  });

  it("a single-line job still honours pqty (unchanged behaviour)", () => {
    const single = normalizeCanonicalInput(new URLSearchParams({
      pfamily: "stickers-labels", pqty: "300", pllines: "1",
      pl0qty: "300", pl0w: "3", pl0h: "3", pl0mat: "matte", pl0art: "ART-1", pl0cuttype: "rectangular",
    }))!;
    expect(single.quantity).toBe(300);
  });
});

describe("2D-4E1 (D) blocked / null canonical results fail closed", () => {
  it("a DRAFT_ONLY canonical result (no calibration) blocks with null money — never $0, never legacy", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" }, NO_CAL);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: result, marginRule: MARGIN });
    expect(quote.costAuthority).toBe("blocked");
    expect(quote.totalCost).toBeNull();
    expect(quote.unitCost).toBeNull();
    expect(quote.finalTotalPrice).toBeNull();
    expect(quote.achievedMarginPct).toBeNull();
    expect(quote.lines).toEqual([]);
    expect(quote.blockers.length).toBeGreaterThan(0);
    expect(quote.blockers.join(" ")).toContain("CANONICAL_TRUE_COST_REQUIRED");
    expect(quote.totalQuantity).toBe(750); // quantities still reported, never costs
  });

  it("a NULL canonical result blocks the same way", () => {
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: null, marginRule: MARGIN });
    expect(quote.costAuthority).toBe("blocked");
    expect(quote.unitCost).toBeNull();
    expect(quote.totalCost).toBeNull();
    expect(quote.blockers.join(" ")).toContain("no canonical result was produced");
  });

  it("a canonical result whose unitCost is null (even with a VALID status) blocks", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    const forged = { ...result, unitCost: null } as typeof result;
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: forged, marginRule: MARGIN });
    expect(quote.costAuthority).toBe("blocked");
    expect(quote.unitCost).toBeNull();
  });

  it("a line with field errors blocks the whole job even when canonical is fine", () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    const broken = [LEGACY_LINES[0], { ...LEGACY_LINES[1], fieldErrors: ["Material is required."] }];
    const quote = resolveMultiLineLabelQuote({ lines: broken, canonical: result, marginRule: MARGIN });
    expect(quote.costAuthority).toBe("blocked");
    expect(quote.reasons).toContain(MULTI_LINE_REASONS.lineIncomplete);
    expect(quote.blockers).toContain("Line 2: Material is required.");
    expect(quote.unitCost).toBeNull();
  });

  it("the save boundary refuses a blocked multi-line job — zero writes", async () => {
    const { result } = canonicalFor({ line2Art: "ART-1" }, NO_CAL);
    let writes = 0;
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "stickers-labels", baseCanonical: result, selectedCanonical: result, selectedQuantity: 750 },
      async () => { writes += 1; return { id: "never" }; },
    );
    expect(writes).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  it("the save boundary writes a usable multi-line job, and the saved unitCost equals canonical", async () => {
    const { result } = canonicalFor({ line2Art: "ART-1" });
    const quote = resolveMultiLineLabelQuote({ lines: LEGACY_LINES, canonical: result, marginRule: MARGIN });
    let saved: { unitCost: number | null } | null = null;
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "stickers-labels", baseCanonical: result, selectedCanonical: result, selectedQuantity: 750 },
      async () => { saved = { unitCost: quote.unitCost }; return saved; },
    );
    expect(outcome.ok).toBe(true);
    expect(saved!.unitCost).toBeCloseTo(result.unitCost!, 10);
  });
});

describe("2D-4E1 (E) the calculator route is wired to the canonical multi-line authority", () => {
  const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

  it("the loader AND the save path build the combined job from the canonical result", () => {
    expect(route.match(/resolveMultiLineLabelQuote\(\{/g)).toHaveLength(2);
    expect(route).toContain("canonical: canonicalResult,");
    expect(route).toContain("canonical: canonicalSnapshot,");
    // the legacy combiner no longer runs in the route at all
    expect(route).not.toMatch(/combineStickerLines\(/);
  });

  it("the saved tier publishes the canonical manufacturing figures", () => {
    expect(route).toContain("jobCost: savedMultiLine.totalCost,");
    expect(route).toContain("unitCost: savedMultiLine.unitCost,");
    expect(route).toContain("canonicalUnitCost: savedMultiLine.unitCost,");
    // the old legacy divisor is gone
    expect(route).not.toContain("unitCost: savedMultiLine.totalCost / combinedQty");
  });

  it("an unusable multi-line canonical cost refuses the save before any write", () => {
    const refusalIdx = route.indexOf("Multi-line sticker job cannot save: canonical true manufacturing cost is not usable");
    const writeIdx = route.indexOf("await db.quote.create({");
    expect(refusalIdx).toBeGreaterThan(0);
    expect(refusalIdx).toBeLessThan(writeIdx);
    expect(route).toContain('savedMultiLine.costAuthority === "canonical" && savedMultiLine.blockers.length === 0');
  });

  it("the normaliser sums entered lines for the finished quantity of a multi-line job", () => {
    const lib = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(lib).toContain("quantity: lines.length > 1 ? enteredTotal : base.quantity > 0 ? base.quantity : enteredTotal");
  });
});
