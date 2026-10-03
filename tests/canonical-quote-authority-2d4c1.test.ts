// Patch 2D-4C1 — canonical true-cost authority + hard save gate.
//
// Two defects are pinned here, both found live in production:
//
//  1. computeCanonicalJob passed a bare identity to resolveCanonicalMachineInputs,
//     which took the back-compat branch and returned inkCostPerMl: null with no
//     channels — so EVERY canonical job reported MISSING_INK_PRICE. The whole
//     2D-4/2D-4A suite missed it because every test built ResolvedMachineInputs
//     by hand and called assembleCanonicalJob directly, skipping the wrapper.
//     These tests go through the WRAPPER with a mocked db.
//
//  2. The canonical result was displayed but never consulted: the legacy run
//     cost still fed margins, tiers and the saved Quote.unitCost, and a
//     DRAFT_ONLY canonical result could still save a quote.
//
// Requirement 4 uses deliberately DIFFERENT legacy and canonical numbers so a
// test cannot pass by accident with the wrong authority.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  canonicalInputForQuantity,
  canonicalSupportsTierLadder,
  computeCanonicalJob,
  normalizeCanonicalInput,
  resolveCanonicalMachineInputs,
} from "../app/lib/canonical-calculator.server";
import {
  AUTHORITY_REASONS,
  CANONICAL_SUPPORTED_FAMILIES,
  canonicalSaveGate,
  isCanonicalCostUsable,
  CANONICAL_FAIL_CLOSED_FAMILIES,
  familyCostModel,
  isCanonicalFailClosedFamily,
  isCanonicalSupportedFamily,
  isCostedAuthority,
  persistQuoteIfCanonicalAllows,
  resolveCostAuthority,
  type CanonicalCostLike,
} from "../app/lib/canonical-quote-authority.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const routeSrc = () => readFileSync(ROUTE, "utf8");

/* ------------------------------------------------------------------ *
 * A mocked database holding exactly the four seeded production rows.
 * ------------------------------------------------------------------ */

const MEASURED: Record<string, { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};

const SHOP = "942075-2.myshopify.com";

const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`,
  shop: SHOP,
  ...identity,
  inkAreaBasis: "inkable_artwork",
  timeAreaBasis: "rip_layout",
  fixedMinutes: null,
  timeModel: "variable_only",
  measuredAt: new Date("2026-08-18T00:00:00Z"),
  effectiveFrom: new Date("2026-08-18T00:00:00Z"),
  effectiveTo: null,
  status: "approved",
  source: "owner-measured",
  notes: null,
  supersedesId: null,
  createdAt: new Date("2026-08-18T00:00:00Z"),
  ...MEASURED[key],
}));

/** Mirrors loadActiveCalibration's exact `where` shape. */
const mockDb = () => ({
  machineProfileCalibration: {
    findMany: async ({ where }: any) =>
      ROWS.filter((row) =>
        Object.entries(where).every(([field, value]) =>
          field === "shop" ? row.shop === value : (row as any)[field] === value,
        ),
      ),
  },
});

/** A db whose table does not exist — the fail-closed path. */
const missingTableDb = () => ({
  machineProfileCalibration: {
    findMany: async () => { throw new Error('relation "MachineProfileCalibration" does not exist'); },
  },
});

const deps = () => ({ db: mockDb(), shop: SHOP });

const MACHINE = "&pprinter=auto&pwhitelayers=0&pglosslayers=0";
const CONTROL =
  "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3" +
  "&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A" + MACHINE;

const inputFor = (qs: string) => {
  const input = normalizeCanonicalInput(new URLSearchParams(qs));
  expect(input, `did not normalise: ${qs}`).not.toBeNull();
  return input!;
};

/* ================================================================== *
 * 1. resolveCanonicalMachineInputs with a FULL job input
 * ================================================================== */

describe("2D-4C1 (1) resolveCanonicalMachineInputs resolves from the full job", () => {
  it("Mimaki CMYK: inkCostPerMl is the canonical rate and the CMYK channel resolves", async () => {
    const machine = await resolveCanonicalMachineInputs(deps(), inputFor(CONTROL));
    expect(machine.inkCostPerMl).toBe(CANONICAL_INK_RATES.mimakiCmykPerMl);
    expect(machine.inkCostPerMl).toBeCloseTo(0.176, 10);
    expect(machine.inkCostSource).not.toBe("");
    expect(machine.calibration).not.toBeNull();
    expect(machine.calibration!.inkMode).toBe("cmyk_heavy");
    expect(machine.channels).toBeDefined();
    expect(machine.channels!.map((c) => c.kind)).toEqual(["cmyk"]);
    expect(machine.channels![0].calibration).not.toBeNull();
    expect(machine.routing!.effectivePrinter).toBe("mimaki");
  });

  it("Roland WHITE: both channels resolve at their own rates", async () => {
    const machine = await resolveCanonicalMachineInputs(
      deps(), inputFor(CONTROL.replace("&pwhitelayers=0", "&pwhitelayers=2&pwhitecoverage=60")));
    expect(machine.routing!.effectivePrinter).toBe("roland");
    expect(machine.channels!.map((c) => c.kind)).toEqual(["cmyk", "white"]);
    const [cmyk, white] = machine.channels!;
    expect(cmyk.calibration!.mlPerSqftPerPass).toBe(1.4133);
    expect(white.calibration!.mlPerSqftPerPass).toBe(6.0);
    expect(white.passCount).toBe(2);
    expect(white.coveragePct).toBe(60);
    for (const channel of machine.channels!) {
      expect(channel.inkCostPerMl).toBe(CANONICAL_INK_RATES.rolandPerMl);
    }
  });

  it("Roland GLOSS: the gloss channel resolves on its own calibration", async () => {
    const machine = await resolveCanonicalMachineInputs(
      deps(), inputFor(CONTROL.replace("&pglosslayers=0", "&pglosslayers=1")));
    expect(machine.routing!.effectivePrinter).toBe("roland");
    expect(machine.channels!.map((c) => c.kind)).toEqual(["cmyk", "gloss"]);
    const gloss = machine.channels!.find((c) => c.kind === "gloss")!;
    expect(gloss.calibration!.mlPerSqftPerPass).toBe(4.18);
    expect(gloss.calibration!.passConfig).toBe("gloss-1x");
    expect(gloss.inkCostPerMl).toBe(CANONICAL_INK_RATES.rolandPerMl);
  });

  it("the defect is gone: the wrapper no longer passes a bare identity", () => {
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(src).not.toContain("resolveCanonicalMachineInputs(deps, calibrationIdentityOf(input))");
    expect(src).toContain("resolveCanonicalMachineInputs(deps, input)");
  });

  it("still fails CLOSED when the calibration table is absent", async () => {
    const machine = await resolveCanonicalMachineInputs(
      { db: missingTableDb(), shop: SHOP }, inputFor(CONTROL));
    expect(machine.calibration).toBeNull();
    expect(machine.calibrationMessage).toMatch(/MISSING_CALIBRATION/);
  });
});

/* ================================================================== *
 * 2. computeCanonicalJob control fixture — the owner's reference job
 * ================================================================== */

describe("2D-4C1 (2) control fixture through the real route path", () => {
  it("1000 labels 3x3 / 2.875x2.875 cutline / matte / AUTO returns the reference result", async () => {
    const result = await computeCanonicalJob(deps(), inputFor(CONTROL));

    expect(result.status).toBe("PROVISIONAL");
    expect(result.blockers).toHaveLength(0);
    expect(result.unitCost).not.toBeNull();
    expect(result.unitCost!).toBeCloseTo(0.084143, 6);
    expect(result.totalCost).toBeCloseTo(84.143290, 5);

    expect(result.diagnostics.inkableArtworkSqft).toBeCloseTo(62.5, 6);
    expect(result.diagnostics.ripLayoutSqft!).toBeCloseTo(62.6875, 6);
    expect(result.diagnostics.mediaConsumedSqft).toBeCloseTo(66.375, 6);
    expect(result.diagnostics.machineMinutes!).toBeCloseTo(90.5, 1);

    const cmyk = result.inkChannels.find((c) => c.kind === "cmyk")!;
    expect(cmyk.totalMl!).toBeCloseTo(118.125, 4);
    expect(cmyk.inkCost!).toBeCloseTo(20.79, 4);
    expect(cmyk.occupancyMinutes!).toBeCloseTo(90.5207, 3);
    expect(cmyk.identity.machineKey).toBe("mimaki-ucjv300-130");
    expect(cmyk.identity.inkMode).toBe("cmyk_heavy");

    // the only reason is the disclosed, NON-blocking one
    expect(result.reasons).toEqual(["FREIGHT_NOT_MODELED"]);
  });

  it("the same job blocks when no calibration rows exist", async () => {
    const result = await computeCanonicalJob({ db: missingTableDb(), shop: SHOP }, inputFor(CONTROL));
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.blockers.join(" ")).toMatch(/MISSING_CALIBRATION/);
  });
});

/* ================================================================== *
 * 3. HARD SAVE GATE
 * ================================================================== */

const draftOnly: CanonicalCostLike = {
  family: "stickers-labels", status: "DRAFT_ONLY", unitCost: null, totalCost: 47.42,
  blockers: ["Print media: MISSING_COST", "Ink: MISSING_INK_PRICE"],
};
const nullUnit: CanonicalCostLike = {
  family: "sticker-bags", status: "PROVISIONAL", unitCost: null, totalCost: 500, blockers: [],
};
const withBlocker: CanonicalCostLike = {
  family: "banners", status: "PROVISIONAL", unitCost: 24.9, totalCost: 24.9,
  blockers: ["BANNER_FINISHING_RATE_REQUIRED: hemming"],
};
const usable: CanonicalCostLike = {
  family: "stickers-labels", status: "PROVISIONAL", unitCost: 0.084143, totalCost: 84.143290,
  blockers: [], reasons: ["FREIGHT_NOT_MODELED"],
};

describe("2D-4C1 (3) hard save gate", () => {
  it("refuses the save for every unusable canonical shape on a supported family", () => {
    for (const canonical of [draftOnly, nullUnit, withBlocker, null]) {
      const gate = canonicalSaveGate({ canonicalFamilyKey: "stickers-labels", canonical });
      expect(gate.allowed, JSON.stringify(canonical?.status ?? "null")).toBe(false);
      expect(gate.enforced).toBe(true);
      expect(gate.reason).toContain(AUTHORITY_REASONS.canonicalCostRequired);
    }
  });

  it("the refusal explicitly cannot be overridden by margin approval", () => {
    const gate = canonicalSaveGate({ canonicalFamilyKey: "sticker-bags", canonical: draftOnly });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/margin approval or override cannot supply a missing cost/i);
    expect(gate.reason).toMatch(/legacy engine's cost is not a substitute/i);
  });

  it("the route performs the write ONLY inside the gated boundary", () => {
    const src = routeSrc();
    const boundaryIdx = src.indexOf("await persistQuoteIfCanonicalAllows(");
    const createIdx = src.indexOf("await db.quote.create({");
    expect(boundaryIdx).toBeGreaterThan(0);
    // the single write is INSIDE the boundary's callback, not before it
    expect(createIdx).toBeGreaterThan(boundaryIdx);
    expect(src.match(/db\.quote\.create\(/g)).toHaveLength(1);
    expect(src.match(/persistQuoteIfCanonicalAllows\(/g)).toHaveLength(1);
    expect(src).toContain("if (!saveOutcome.ok) {");
    expect(src).toContain("canonicalBlocked: true");
  });

  it("the gate is INDEPENDENT of the commercial margin gate — the && is untouched", () => {
    const src = routeSrc();
    expect(src).toContain("if (!verdict.ok && !gate.allowed) return Response.json(");
    // the canonical boundary is a separate call that takes NO margin input —
    // structurally, an approval cannot supply a missing true cost.
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    const fn = lib.slice(lib.indexOf("export async function persistQuoteIfCanonicalAllows"));
    expect(fn).not.toMatch(/\bgate\b|marginPct|override|verdict/);
  });

  it("allows the save when canonical is usable", () => {
    const gate = canonicalSaveGate({ canonicalFamilyKey: "stickers-labels", canonical: usable });
    expect(gate.allowed).toBe(true);
    expect(gate.enforced).toBe(true);
  });
});

/* ================================================================== *
 * 4. COST AUTHORITY — deliberately different legacy vs canonical
 * ================================================================== */

describe("2D-4C1 (4) canonical is the cost authority", () => {
  // legacy 0.05/unit vs canonical 0.10/unit — a test cannot pass by accident.
  const LEGACY_UNIT = 0.05;
  const CANON_UNIT = 0.10;
  const QTY = 1000;
  const legacyJobCost = LEGACY_UNIT * QTY;   // 50
  const canonicalCost: CanonicalCostLike = {
    family: "stickers-labels", status: "PROVISIONAL",
    unitCost: CANON_UNIT, totalCost: CANON_UNIT * QTY, blockers: [], // 100
  };

  it("uses the canonical cost, not the legacy cost", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "stickers-labels", canonical: canonicalCost,
      legacyJobCost, quantity: QTY, freightTotal: 0,
    });
    expect(authority.authority).toBe("canonical");
    expect(authority.eligible).toBe(true);
    expect(authority.manufacturingJobCost).toBeCloseTo(100, 10);
    expect(authority.manufacturingUnitCost).toBeCloseTo(CANON_UNIT, 10);
    // the number the commercial policy prices from
    expect(authority.completeCost).toBeCloseTo(100, 10);
    // the number a saved quote records
    expect(authority.unitCost).toBeCloseTo(CANON_UNIT, 10);
    // and emphatically NOT the legacy figures
    expect(authority.completeCost).not.toBeCloseTo(legacyJobCost, 6);
    expect(authority.unitCost).not.toBeCloseTo(LEGACY_UNIT, 6);
  });

  it("every supported family takes the canonical authority", () => {
    for (const family of CANONICAL_SUPPORTED_FAMILIES) {
      const authority = resolveCostAuthority({
        canonicalFamilyKey: family,
        canonical: { ...canonicalCost, family },
        legacyJobCost, quantity: QTY, freightTotal: 0,
      });
      expect(authority.authority, family).toBe("canonical");
      expect(authority.unitCost, family).toBeCloseTo(CANON_UNIT, 10);
    }
    // 2D-4D1 added the two jar families once the owner approved their active
    // scope and every offered jar costed with zero blockers.
    expect(CANONICAL_SUPPORTED_FAMILIES).toEqual([
      "stickers-labels", "sticker-bags", "stock-bags", "banners", "standard-jars", "premium-jars",
    ]);
  });

  it("inbound freight stays additive and disclosed — canonical reports FREIGHT_NOT_MODELED", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "sticker-bags", canonical: { ...canonicalCost, family: "sticker-bags" },
      legacyJobCost, quantity: QTY, freightTotal: 25,
    });
    expect(authority.manufacturingJobCost).toBeCloseTo(100, 10); // manufacturing only
    expect(authority.completeCost).toBeCloseTo(125, 10);          // + freight
    expect(authority.freightTotal).toBe(25);
    expect(authority.basis).toMatch(/inbound freight/i);
  });

  it("an unusable canonical cost NEVER falls back to the legacy cost", () => {
    for (const canonical of [draftOnly, nullUnit, withBlocker, null]) {
      const authority = resolveCostAuthority({
        canonicalFamilyKey: "stickers-labels", canonical,
        legacyJobCost, quantity: QTY, freightTotal: 0,
      });
      expect(authority.eligible).toBe(false);
      expect(authority.costed).toBe(false);
      expect(authority.completeCost).toBeNull();
      expect(authority.unitCost).toBeNull();
      expect(authority.manufacturingJobCost).toBeNull();
      expect(authority.manufacturingUnitCost).toBeNull();
      expect(authority.blockers.join(" ")).toContain(AUTHORITY_REASONS.canonicalCostRequired);
    }
  });

  it("the route feeds the authority's cost to the commercial policy on BOTH sides", () => {
    const src = routeSrc();
    // exactly two call sites — loader and action — and both use the authority
    expect(src.match(/const authority = resolveCostAuthority\(\{/g)).toHaveLength(2);
    expect(src.match(/const completeCost = authority\.completeCost;/g)).toHaveLength(2);
    expect(src.match(/unitCost: authority\.unitCost/g)).toHaveLength(2);
    // the legacy basis is gone from both tier maps
    expect(src).not.toContain("const completeCost = run.totalCost + tierFreight.total;");
  });

  it("a canonical family with no usable cost can never read READY TO QUOTE", () => {
    const src = routeSrc();
    const readyLines = src.match(/status: \(run\.missing\.length \|\| !authority\.eligible\) \? "BLOCKED"/g) || [];
    expect(readyLines).toHaveLength(2); // loader + action
    expect(src).not.toMatch(/status: run\.missing\.length \? "BLOCKED" : belowFloor/);
  });
});

/* ================================================================== *
 * 5. PROVISIONAL usability
 * ================================================================== */

describe("2D-4C1 (5) PROVISIONAL is quotable when fully costed", () => {
  it("PROVISIONAL + non-null unit + zero blockers is usable", () => {
    expect(isCanonicalCostUsable(usable)).toBe(true);
    expect(canonicalSaveGate({ canonicalFamilyKey: "stickers-labels", canonical: usable }).allowed).toBe(true);
    expect(resolveCostAuthority({
      canonicalFamilyKey: "stickers-labels", canonical: usable,
      legacyJobCost: 999, quantity: 1000, freightTotal: 0,
    }).eligible).toBe(true);
  });

  it("VALID is usable too", () => {
    expect(isCanonicalCostUsable({ ...usable, status: "VALID" })).toBe(true);
  });

  it("a NON-blocking reason never disqualifies — FREIGHT_NOT_MODELED is a disclosure", () => {
    const withReasons: CanonicalCostLike = {
      ...usable, reasons: ["FREIGHT_NOT_MODELED", "PACKOUT_NOT_MODELED", "INKABLE_AREA_ESTIMATED"],
    };
    expect(isCanonicalCostUsable(withReasons)).toBe(true);
    expect(canonicalSaveGate({ canonicalFamilyKey: "banners", canonical: withReasons }).allowed).toBe(true);
  });

  it("but a BLOCKER always disqualifies, whatever the status", () => {
    expect(isCanonicalCostUsable({ ...usable, blockers: ["anything"] })).toBe(false);
    expect(isCanonicalCostUsable({ ...usable, status: "VALID", blockers: ["anything"] })).toBe(false);
  });
});

/* ================================================================== *
 * 6. Unsupported families — behaviour unchanged
 * ================================================================== */

describe("2D-4C1B (6) LEGACY / OUTSOURCED families keep their existing behaviour", () => {
  it("DTP, Boxes and custom keep the legacy authority — jars are NOT in this group", () => {
    for (const family of ["dtp-bags", "boxes", "custom-item", null]) {
      expect(familyCostModel(family), String(family)).toBe("LEGACY_OUTSOURCED");
      expect(isCanonicalSupportedFamily(family)).toBe(false);
      const authority = resolveCostAuthority({
        canonicalFamilyKey: family, canonical: null,
        legacyJobCost: 500, quantity: 1000, freightTotal: 85,
      });
      expect(authority.authority, String(family)).toBe("legacy");
      expect(authority.eligible).toBe(true);
      expect(authority.costed).toBe(true);
      expect(authority.completeCost).toBeCloseTo(585, 10);
      expect(authority.manufacturingJobCost).toBeCloseTo(500, 10);
      expect(authority.unitCost).toBeCloseTo(0.5, 10);
      expect(authority.reasons).toContain(AUTHORITY_REASONS.notCanonicalFamily);
    }
    // jars are emphatically NOT legacy/outsourced
    for (const jar of ["standard-jars", "premium-jars"]) {
      expect(familyCostModel(jar)).not.toBe("LEGACY_OUTSOURCED");
    }
  });

  it("the save gate does not enforce on legacy/outsourced families", () => {
    for (const family of ["dtp-bags", "boxes", "custom-item", null]) {
      const gate = canonicalSaveGate({ canonicalFamilyKey: family, canonical: null });
      expect(gate.allowed, String(family)).toBe(true);
      expect(gate.enforced).toBe(false);
    }
  });

  it("a legacy family is unaffected even if a canonical result somehow exists", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "dtp-bags", canonical: draftOnly,
      legacyJobCost: 500, quantity: 1000, freightTotal: 0,
    });
    expect(authority.authority).toBe("legacy");
    expect(authority.eligible).toBe(true);
    expect(authority.costed).toBe(true);
    expect(authority.completeCost).toBeCloseTo(500, 10);
  });
});


/* ================================================================== *
 * Tier ladders — the quantity has to reach the ADAPTER, not just the
 * per-unit divisor; and a multi-line label job is NEVER redistributed.
 * ================================================================== */

describe("2D-4C1 per-tier quantity actually scales the job", () => {
  const machineFor = async (qs: string) => resolveCanonicalMachineInputs(deps(), inputFor(qs));

  it("a SINGLE-LINE label ladder scales media, ink and job cost — unit cost falls", async () => {
    const input = inputFor(CONTROL);
    const machine = await machineFor(CONTROL);
    const rungs = [500, 1000, 2000].map((qty) =>
      assembleCanonicalJob(canonicalInputForQuantity(input, qty)!, machine));

    for (const [i, qty] of [500, 1000, 2000].entries()) {
      expect(canonicalInputForQuantity(input, qty)!.labels!.lines[0].quantity).toBe(qty);
      expect(rungs[i].adapter.label!.printedLabels).toBe(qty);
    }
    for (let i = 1; i < rungs.length; i += 1) {
      expect(rungs[i].diagnostics.mediaConsumedSqft).toBeGreaterThan(rungs[i - 1].diagnostics.mediaConsumedSqft);
      expect(rungs[i].trueCost.totals.ink).toBeGreaterThan(rungs[i - 1].trueCost.totals.ink);
      expect(rungs[i].totalCost).toBeGreaterThan(rungs[i - 1].totalCost);
      expect(rungs[i].unitCost!).toBeLessThan(rungs[i - 1].unitCost!);
    }
    expect(new Set(rungs.map((r) => r.totalCost)).size).toBe(3);
    expect(rungs[1].unitCost!).toBeCloseTo(0.084143, 6);
  });

  it("BAG and BANNER ladders scale too", async () => {
    for (const [qs, ladder] of [
      ["pfamily=sticker-bags&pqty=1000&pbagsides=2&pdesigns=1" + MACHINE, [100, 500, 1000]],
      ["pfamily=banners&pqty=1&pbannerw=36&pbannerh=60&pdesigns=1" + MACHINE, [1, 5, 10]],
    ] as const) {
      const input = inputFor(qs);
      const machine = await machineFor(qs);
      const rungs = ladder.map((qty) => assembleCanonicalJob(canonicalInputForQuantity(input, qty)!, machine));
      for (let i = 1; i < rungs.length; i += 1) {
        expect(rungs[i].totalCost, qs).toBeGreaterThan(rungs[i - 1].totalCost);
        expect(rungs[i].diagnostics.mediaConsumedSqft, qs).toBeGreaterThan(rungs[i - 1].diagnostics.mediaConsumedSqft);
        expect(rungs[i].trueCost.totals.ink, qs).toBeGreaterThan(rungs[i - 1].trueCost.totals.ink);
      }
      expect(rungs[rungs.length - 1].unitCost!, qs).toBeLessThan(rungs[0].unitCost!);
    }
  });

  it("setup still does NOT scale with the tier quantity", async () => {
    const input = inputFor(CONTROL);
    const machine = await machineFor(CONTROL);
    const rungs = [50, 500, 5000].map((qty) =>
      assembleCanonicalJob(canonicalInputForQuantity(input, qty)!, machine));
    expect(new Set(rungs.map((r) => r.trueCost.totals.setup_labor)).size).toBe(1);
  });

  it("non-label families are unaffected by the label-specific branch", () => {
    const bag = inputFor("pfamily=sticker-bags&pqty=1000&pbagsides=2" + MACHINE);
    const scaled = canonicalInputForQuantity(bag, 250)!;
    expect(scaled.quantity).toBe(250);
    expect(scaled.labels).toBeUndefined();
    expect(scaled.bags).toEqual(bag.bags);
  });
});

/* ------------------------------------------------------------------ *
 * FIX 2 — multi-line label quantities are NEVER redistributed
 * ------------------------------------------------------------------ */

const MULTI =
  "pfamily=stickers-labels&pllines=2" +
  "&pl0qty=750&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A" +
  "&pl1qty=250&pl1w=2&pl1h=2&pl1cutw=1.85&pl1cuth=1.85&pl1mat=gloss&pl1art=B" + MACHINE;

describe("2D-4C1A (FIX 2) multi-line label jobs are never re-allocated", () => {
  it("a multi-line job CANNOT be re-quantified — no ratio is invented", () => {
    const multi = inputFor(MULTI);
    expect(multi.labels!.lines.map((l) => l.quantity)).toEqual([750, 250]);
    for (const target of [400, 1500, 2001, 7]) {
      expect(canonicalInputForQuantity(multi, target), String(target)).toBeNull();
    }
  });

  it("the job AS ENTERED still resolves, unchanged", () => {
    const multi = inputFor(MULTI);
    const same = canonicalInputForQuantity(multi, 1000);
    expect(same).not.toBeNull();
    // byte-identical line quantities — nothing was scaled
    expect(same!.labels!.lines.map((l) => l.quantity)).toEqual([750, 250]);
    expect(same).toBe(multi); // the very same object, so nothing could have changed
  });

  it("no largest-remainder / proportional allocation code remains", () => {
    const lib = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(lib).not.toContain("largest-remainder");
    expect(lib).not.toMatch(/Math.floor(value)/);
    expect(lib).not.toMatch(/frac: value - Math.floor/);
  });

  it("alternate ladder rungs are SUPPRESSED for a multi-line job", () => {
    expect(canonicalSupportsTierLadder(inputFor(MULTI))).toBe(false);
    expect(canonicalSupportsTierLadder(inputFor(CONTROL))).toBe(true);
    expect(canonicalSupportsTierLadder(inputFor("pfamily=sticker-bags&pqty=1000&pbagsides=2" + MACHINE))).toBe(true);
    expect(canonicalSupportsTierLadder(inputFor("pfamily=banners&pqty=1&pbannerw=36&pbannerh=60" + MACHINE))).toBe(true);
    expect(canonicalSupportsTierLadder(null)).toBe(true); // unsupported families keep their ladder

    const route = routeSrc();
    expect(route.match(/canonicalSupportsTierLadder\(canonicalInput(Save)?\)/g)).toHaveLength(2);
    expect(route).toContain("[requestedQtyP].filter((value) => value > 0)");
    expect(route).toContain("[savedRequestedQty].filter((value) => value > 0)");
  });

  it("a suppressed rung produces NO canonical result rather than a guessed one", async () => {
    const multi = inputFor(MULTI);
    const machine = await resolveCanonicalMachineInputs(deps(), multi);
    // the caller's shape: null rescale => null result
    const rescaled = canonicalInputForQuantity(multi, 500);
    expect(rescaled).toBeNull();
    const result = rescaled ? assembleCanonicalJob(rescaled, machine) : null;
    expect(result).toBeNull();
    // and an absent canonical result is NOT costable
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "stickers-labels", canonical: result,
      legacyJobCost: 999, quantity: 500, freightTotal: 0,
    });
    expect(authority.eligible).toBe(false);
    expect(authority.unitCost).toBeNull();
  });
});

/* ================================================================== *
 * The gate must cover the SELECTED TIER, not just the base quantity.
 *
 * Found by adversarial review of this patch. The base quantity and the tier
 * the operator actually picks are different jobs, and a tier's canonical
 * result is computed at ITS quantity. A base job can be perfectly costable
 * while the selected rung is not — the live trigger is a Stock Bag ladder
 * crossing below the 50-unit MOQ — and an ineligible row carries a $0 cost
 * that must never be persisted.
 * ================================================================== */

describe("2D-4C1 selected-tier gate", () => {
  const STOCK = "pfamily=sticker-bags&pstockbag=1&pqty=1000&pbagsides=2" + MACHINE;

  it("a Stock Bag ladder that crosses below MOQ 50 blocks the LOW rung, not the base", async () => {
    const input = inputFor(STOCK);
    const machine = await resolveCanonicalMachineInputs(deps(), input);

    const base = assembleCanonicalJob(canonicalInputForQuantity(input, 1000)!, machine);
    expect(base.status).not.toBe("DRAFT_ONLY");
    expect(base.unitCost).not.toBeNull();
    expect(canonicalSaveGate({ canonicalFamilyKey: "sticker-bags", canonical: base }).allowed).toBe(true);

    // the rung below the MOQ is genuinely blocked
    const low = assembleCanonicalJob(canonicalInputForQuantity(input, 25)!, machine);
    expect(low.status).toBe("DRAFT_ONLY");
    expect(low.unitCost).toBeNull();
    expect(low.blockers.join(" ")).toMatch(/STOCK_BAG_BELOW_MOQ/);

    // and the gate refuses THAT rung even though the base passed
    const lowGate = canonicalSaveGate({ canonicalFamilyKey: "sticker-bags", canonical: low });
    expect(lowGate.allowed).toBe(false);
    expect(lowGate.enforced).toBe(true);
  });

  it("an ineligible tier is NON-COSTED (null), never a $0 cost", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "stock-bags",
      canonical: { family: "stock-bags", status: "DRAFT_ONLY", unitCost: null, totalCost: 0, blockers: ["STOCK_BAG_BELOW_MOQ"] },
      legacyJobCost: 12.5, quantity: 25, freightTotal: 0,
    });
    expect(authority.eligible).toBe(false);
    expect(authority.costed).toBe(false);
    expect(authority.unitCost).toBeNull();
    expect(authority.completeCost).toBeNull();
    // the $0 is fail-closed bookkeeping, not a quotable price
    expect(canonicalSaveGate({
      canonicalFamilyKey: "stock-bags",
      canonical: { family: "stock-bags", status: "DRAFT_ONLY", unitCost: null, totalCost: 0, blockers: ["x"] },
    }).allowed).toBe(false);
  });

  it("the boundary receives BOTH the base and the SELECTED tier canonical result", () => {
    const src = routeSrc();
    const primaryIdx = src.indexOf("const primary: any = productSnapshot && savedSelectedTier");
    const boundaryIdx = src.indexOf("await persistQuoteIfCanonicalAllows(");
    expect(primaryIdx).toBeGreaterThan(0);
    expect(boundaryIdx).toBeGreaterThan(primaryIdx); // primary is chosen first
    const call = src.slice(boundaryIdx, src.indexOf("if (!saveOutcome.ok) {"));
    expect(call).toContain("baseCanonical: canonicalSnapshot");
    expect(call).toContain("selectedCanonical: primary ? canonicalForQtySave(Number(primary.quantity) || 0) : null");
    expect(call).toContain("selectedTierDraftOnly: Boolean(primary?.draftOnly)");
  });

  it("the single refusal path reports canonicalBlocked to the client", () => {
    const src = routeSrc();
    expect(src.match(/canonicalBlocked: true/g)).toHaveLength(1);
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    // one in the outcome TYPE plus three distinct refusal paths:
    // base quantity, selected tier, and a blocked selected row
    expect(lib.match(/canonicalBlocked: true/g)).toHaveLength(4);
  });
});

/* ================================================================== *
 * FIX 3 — EXECUTABLE write-gate proof.
 *
 * The boundary the production action actually calls is executed here with a
 * spy in place of db.quote.create. Source-order assertions remain, but only
 * as supplemental coverage: this is the primary evidence.
 * ================================================================== */

describe("2D-4C1A (FIX 3) db.quote.create is provably never called when blocked", () => {
  /** Stands in for db.quote.create and counts its own invocations. */
  const spyCreate = () => {
    const calls: number[] = [];
    const fn = async () => { calls.push(Date.now()); return { id: "quote_should_not_exist" }; };
    return { fn, calls };
  };

  const blockedShapes: Array<[string, CanonicalCostLike | null]> = [
    ["DRAFT_ONLY", draftOnly],
    ["null unit cost", nullUnit],
    ["carries a blocker", withBlocker],
    ["no canonical result at all", null],
  ];

  it("refuses on the BASE quantity — create called ZERO times", async () => {
    for (const [label, canonical] of blockedShapes) {
      const spy = spyCreate();
      const outcome = await persistQuoteIfCanonicalAllows(
        {
          canonicalFamilyKey: "stickers-labels",
          baseCanonical: canonical,
          selectedCanonical: usable,     // even with a fine selected tier
          selectedQuantity: 1000,
        },
        spy.fn,
      );
      expect(spy.calls.length, label).toBe(0);
      expect(outcome.ok, label).toBe(false);
      expect(outcome.ok === false && outcome.canonicalBlocked).toBe(true);
    }
  });

  it("refuses on the SELECTED TIER even when the base is fine — create called ZERO times", async () => {
    for (const [label, canonical] of blockedShapes) {
      const spy = spyCreate();
      const outcome = await persistQuoteIfCanonicalAllows(
        {
          canonicalFamilyKey: "sticker-bags",
          baseCanonical: usable,          // base passes
          selectedCanonical: canonical,   // the rung actually saved does not
          selectedQuantity: 25,
        },
        spy.fn,
      );
      expect(spy.calls.length, label).toBe(0);
      expect(outcome.ok, label).toBe(false);
      expect(outcome.ok === false && outcome.message).toContain("Selected tier 25");
    }
  });

  it("refuses a blocked tier ROW even if both canonical results look usable", async () => {
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      {
        canonicalFamilyKey: "banners",
        baseCanonical: usable,
        selectedCanonical: usable,
        selectedQuantity: 500,
        selectedTierDraftOnly: true,
      },
      spy.fn,
    );
    expect(spy.calls.length).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  it("the refusal is independent of margin: the boundary takes NO margin input", async () => {
    // The production action reaches this boundary only AFTER the commercial
    // margin gate has already allowed the save, so executing it here is
    // exactly the "approval/override would otherwise permit it" scenario.
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "stock-bags", baseCanonical: draftOnly, selectedCanonical: draftOnly, selectedQuantity: 1000 },
      spy.fn,
    );
    expect(spy.calls.length).toBe(0);
    expect(outcome.ok).toBe(false);
    // structurally: no margin/override/verdict parameter exists to override it
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    const signature = lib.slice(
      lib.indexOf("export type QuoteSaveDecisionInput"),
      lib.indexOf("export type QuoteSaveOutcome"),
    );
    expect(signature).not.toMatch(/margin|override|verdict|approval|gate/i);
  });

  it("PROVISIONAL + non-null unit + zero blockers DOES proceed — create called exactly once", async () => {
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      {
        canonicalFamilyKey: "stickers-labels",
        baseCanonical: usable,
        selectedCanonical: usable,
        selectedQuantity: 1000,
        selectedTierDraftOnly: false,
      },
      spy.fn,
    );
    expect(spy.calls.length).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.created).toEqual({ id: "quote_should_not_exist" });
  });

  it("a LEGACY/OUTSOURCED family still saves — existing behaviour unchanged", async () => {
    for (const family of ["dtp-bags", "boxes", "custom-item", null]) {
      const spy = spyCreate();
      const outcome = await persistQuoteIfCanonicalAllows(
        { canonicalFamilyKey: family, baseCanonical: null, selectedCanonical: null, selectedQuantity: 1000 },
        spy.fn,
      );
      expect(spy.calls.length, String(family)).toBe(1);
      expect(outcome.ok).toBe(true);
    }
  });

  it("the production action calls THIS boundary, with the real db write inside it", () => {
    const src = routeSrc();
    expect(src).toContain("await persistQuoteIfCanonicalAllows(");
    const boundary = src.indexOf("await persistQuoteIfCanonicalAllows(");
    const create = src.indexOf("await db.quote.create({");
    const close = src.indexOf("if (!saveOutcome.ok) {");
    // the ONLY db write sits inside the boundary's callback
    expect(create).toBeGreaterThan(boundary);
    expect(create).toBeLessThan(close);
    expect(src.match(/db\.quote\.create\(/g)).toHaveLength(1);
  });
});

/* ================================================================== *
 * FREIGHT semantics with a NONZERO figure
 * ================================================================== */

describe("2D-4C1A freight never mutates the canonical manufacturing unit cost", () => {
  const QTY = 1000;
  const canonicalCost: CanonicalCostLike = {
    family: "sticker-bags", status: "PROVISIONAL",
    unitCost: 0.10, totalCost: 100, blockers: [],
  };
  const FREIGHT = 37.5; // deliberately NONZERO so nothing hides in a $0 fixture

  it("manufacturingUnitCost === canonical unitCost, freight excluded", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "sticker-bags", canonical: canonicalCost,
      legacyJobCost: 999, quantity: QTY, freightTotal: FREIGHT,
    });
    expect(isCostedAuthority(authority)).toBe(true);
    if (!isCostedAuthority(authority)) throw new Error("unreachable");

    // MANUFACTURING — canonical, freight-free
    expect(authority.manufacturingJobCost).toBeCloseTo(100, 10);
    expect(authority.manufacturingUnitCost).toBeCloseTo(canonicalCost.unitCost!, 12);
    expect(authority.manufacturingUnitCost).toBeCloseTo(0.10, 12);

    // what a saved quote records = the MANUFACTURING unit cost
    expect(authority.unitCost).toBeCloseTo(0.10, 12);
    expect(authority.unitCost).toBe(authority.manufacturingUnitCost);

    // freight is separately identifiable and only in the COMMERCIAL basis
    expect(authority.freightTotal).toBe(FREIGHT);
    expect(authority.completeCost).toBeCloseTo(137.5, 10);

    // the inflated per-unit figure is NOT what is recorded
    expect(authority.unitCost).not.toBeCloseTo(137.5 / QTY, 6); // 0.1375
    expect(authority.basis).toMatch(/never mutates the manufacturing unit cost/i);
  });

  it("freight changes the commercial basis but NOT the recorded unit cost", () => {
    const withoutFreight = resolveCostAuthority({
      canonicalFamilyKey: "sticker-bags", canonical: canonicalCost,
      legacyJobCost: 999, quantity: QTY, freightTotal: 0,
    });
    const withFreight = resolveCostAuthority({
      canonicalFamilyKey: "sticker-bags", canonical: canonicalCost,
      legacyJobCost: 999, quantity: QTY, freightTotal: FREIGHT,
    });
    if (!isCostedAuthority(withoutFreight) || !isCostedAuthority(withFreight)) throw new Error("unreachable");

    // BEFORE / AFTER — the only field that moves is completeCost
    expect(withoutFreight.completeCost).toBeCloseTo(100, 10);
    expect(withFreight.completeCost).toBeCloseTo(137.5, 10);
    expect(withFreight.unitCost).toBe(withoutFreight.unitCost);
    expect(withFreight.manufacturingUnitCost).toBe(withoutFreight.manufacturingUnitCost);
    expect(withFreight.manufacturingJobCost).toBe(withoutFreight.manufacturingJobCost);
  });

  it("the route records the MANUFACTURING unit cost on the tier row", () => {
    const src = routeSrc();
    // tier.unitCost (-> QuoteItem.unitCost via primary) is authority.unitCost,
    // which is the manufacturing figure; jobCost carries the commercial basis.
    expect(src.match(/unitCost: authority\.unitCost/g)).toHaveLength(2);
    expect(src.match(/jobCost: completeCost/g)).toHaveLength(2);
    expect(src).toContain("unitCost: primary.unitCost");
  });
});

/* ================================================================== *
 * 2D-4C1B — JARS ARE FAIL-CLOSED, NOT LEGACY.
 *
 * Jars have a canonical foundation and an AUTHORITATIVE canonical blocker:
 * their actual side-label cutlines are unmeasured, so canonical costing
 * reports CUTLINE_GEOMETRY_REQUIRED. Grouping them with DTP/Boxes let a jar
 * quote save on the legacy cost the blocker exists to reject. They fail for
 * the opposite reason to DTP: a jar HAS a canonical verdict and it is "no";
 * DTP simply has no canonical verdict yet.
 * ================================================================== */

describe("2D-4C1B/2D-4D1 the fail-closed mechanism, and what replaced it for jars", () => {
  /* 2D-4C1B put jars in CANONICAL_FAIL_CLOSED because their side-label
   * cutlines were unmeasured. 2D-4C2A gave every GSO label a cutline rule,
   * 2D-4D applied it to jars, and 2D-4D1 established the ten jars GSO
   * actually offers — at which point every offered jar costed with zero
   * blockers and the owner promoted the families.
   *
   * The mechanism itself was NOT removed. What this block now proves is:
   *   - the list is empty, and the classification still distinguishes the
   *     three cost models from one another;
   *   - the absolute refusal is still the FIRST thing the gate evaluates, so
   *     a future member of the list still refuses unconditionally;
   *   - every protection jars actually needed still holds through the normal
   *     canonical gate — no result, DRAFT_ONLY, or a null unit cost all
   *     refuse, and the legacy engine is never a substitute. */

  const spyCreate = () => {
    const calls: number[] = [];
    return { fn: async () => { calls.push(1); return { id: "jar_quote_should_not_exist" }; }, calls };
  };

  const jarDraftOnly: CanonicalCostLike = {
    family: "standard-jars", status: "DRAFT_ONLY", unitCost: null, totalCost: 0,
    blockers: ["FAMILY_NOT_CANONICAL: \"miron 4oz\" is not a jar GSO currently offers."],
  };
  const jarNullUnit: CanonicalCostLike = {
    family: "premium-jars", status: "PROVISIONAL", unitCost: null, totalCost: 250, blockers: [],
  };

  it("the fail-closed list is empty, and the three cost models stay distinct", () => {
    expect(CANONICAL_FAIL_CLOSED_FAMILIES).toHaveLength(0);
    for (const jar of ["standard-jars", "premium-jars"]) {
      expect(familyCostModel(jar), jar).toBe("CANONICAL_COST_AUTHORITY");
      expect(isCanonicalFailClosedFamily(jar), jar).toBe(false);
      expect(isCanonicalSupportedFamily(jar), jar).toBe(true);
    }
    for (const legacy of ["dtp-bags", "boxes", "custom-item", null]) {
      expect(isCanonicalFailClosedFamily(legacy), String(legacy)).toBe(false);
      expect(familyCostModel(legacy), String(legacy)).toBe("LEGACY_OUTSOURCED");
    }
    for (const canonical of CANONICAL_SUPPORTED_FAMILIES) {
      expect(familyCostModel(canonical), canonical).toBe("CANONICAL_COST_AUTHORITY");
    }
  });

  it("the absolute refusal is still the FIRST thing the gate decides", () => {
    // No family is currently fail-closed, so there is no fixture to exercise
    // this branch with — it is asserted structurally instead, and the moment a
    // family is added to the list the behavioural tests above cover it.
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    const gate = lib.slice(lib.indexOf("export function canonicalSaveGate"), lib.indexOf("export type QuoteSaveDecisionInput"));
    expect(gate.match(/model === "CANONICAL_FAIL_CLOSED"/g)).toHaveLength(1);
    // ...and it is decided BEFORE the result is ever asked whether it is usable
    expect(gate.indexOf('CANONICAL_FAIL_CLOSED')).toBeLessThan(gate.indexOf("isCanonicalCostUsable"));
  });

  it("1. a jar reported DRAFT_ONLY => create called ZERO times", async () => {
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "standard-jars", baseCanonical: jarDraftOnly, selectedCanonical: jarDraftOnly, selectedQuantity: 1000 },
      spy.fn,
    );
    expect(spy.calls.length).toBe(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("DRAFT_ONLY");
    // the specific reason travels with the refusal, so the operator is told
    // WHICH jar problem stopped the save
    expect((outcome.ok === false ? outcome.blockers : []).join(" ")).toContain("FAMILY_NOT_CANONICAL");
  });

  it("2. jar NULL canonical unit cost => create called ZERO times", async () => {
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "premium-jars", baseCanonical: jarNullUnit, selectedCanonical: jarNullUnit, selectedQuantity: 500 },
      spy.fn,
    );
    expect(spy.calls.length).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  it("2b. a jar with NO canonical result at all is still refused", async () => {
    for (const jar of ["standard-jars", "premium-jars"]) {
      const spy = spyCreate();
      const outcome = await persistQuoteIfCanonicalAllows(
        { canonicalFamilyKey: jar, baseCanonical: null, selectedCanonical: null, selectedQuantity: 1000 },
        spy.fn,
      );
      expect(spy.calls.length, jar).toBe(0);
      expect(outcome.ok).toBe(false);
    }
  });

  it("3. a margin approval / override cannot bypass the jar gate", async () => {
    // The boundary is reached only AFTER the commercial margin gate allowed
    // the save, and it accepts no margin input at all.
    const spy = spyCreate();
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "standard-jars", baseCanonical: jarDraftOnly, selectedCanonical: jarDraftOnly, selectedQuantity: 1000, selectedTierDraftOnly: false },
      spy.fn,
    );
    expect(spy.calls.length).toBe(0);
    expect(outcome.ok === false && outcome.message).toMatch(/margin approval or override cannot supply a missing cost/i);
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    const signature = lib.slice(lib.indexOf("export type QuoteSaveDecisionInput"), lib.indexOf("export type QuoteSaveOutcome"));
    expect(signature).not.toMatch(/margin|override|verdict|approval|gate/i);
  });

  it("a jar is never legacy-costed — no fallback to the legacy engine", () => {
    for (const jar of ["standard-jars", "premium-jars"]) {
      const authority = resolveCostAuthority({
        canonicalFamilyKey: jar, canonical: null,
        legacyJobCost: 1234.56, quantity: 1000, freightTotal: 42,
      });
      expect(authority.eligible, jar).toBe(false);
      expect(authority.costed).toBe(false);
      expect(authority.unitCost).toBeNull();
      expect(authority.completeCost).toBeNull();
      expect(authority.manufacturingJobCost).toBeNull();
      expect(authority.blockers.join(" ")).toMatch(/legacy/i);
    }
  });

  it("no jar cutline is invented and no artboard is substituted", () => {
    // BEHAVIOUR, not prose: a jar with no canonical result yields no cost at
    // any quantity, and never coincides with the legacy figure.
    for (const qty of [50, 500, 5000]) {
      const authority = resolveCostAuthority({
        canonicalFamilyKey: "standard-jars", canonical: null,
        legacyJobCost: 987.65, quantity: qty, freightTotal: 0,
      });
      expect(authority.costed, String(qty)).toBe(false);
      expect(authority.unitCost).toBeNull();
      expect(authority.manufacturingUnitCost).toBeNull();
    }
    // the shared cutline blocker itself is untouched by the promotion
    const finishing = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    expect(finishing).toContain("cutlineGeometryRequired");
    // and the authority module invents no geometry of its own
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    expect(lib).not.toMatch(/cutWidthIn|cutHeightIn|widthIn:|heightIn:/);
  });

  it("promotion is still a deliberate code change, and the mechanism is documented", () => {
    const lib = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    expect(lib).toMatch(/PROMOTION IS A DELIBERATE CODE CHANGE/);
    expect(lib).toMatch(/passes verification/i);
    expect(lib).toMatch(/explicitly approves it as quote-ready/i);
    // jars are in exactly one list, and it is now the supported one
    expect(CANONICAL_SUPPORTED_FAMILIES).toContain("standard-jars" as any);
    expect(CANONICAL_SUPPORTED_FAMILIES).toContain("premium-jars" as any);
    expect(CANONICAL_FAIL_CLOSED_FAMILIES as readonly string[]).not.toContain("standard-jars");
    expect(CANONICAL_FAIL_CLOSED_FAMILIES as readonly string[]).not.toContain("premium-jars");
  });
});

/* ================================================================== *
 * Scope guards — this patch must not have widened
 * ================================================================== */

describe("2D-4C1 scope guards", () => {
  it("the legacy 0.6 ml/sqft basis is untouched", () => {
    const src = routeSrc();
    expect(src.match(/inkMlPerSqft: 0\.6/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("the label form wiring landed in 2D-4C2, and C1's own scope is unchanged", () => {
    const src = routeSrc();
    // C1 deliberately did NOT wire the form; 2D-4C2 did, so these now exist.
    // The guard is inverted rather than deleted so the boundary stays recorded.
    expect(src).toContain('name="pl0qty"');
    // 2D-4C2A: the cutline is DERIVED, so the form no longer asks for it
    expect(src).not.toContain('name="pl0cutw"');
    expect(src).toContain("Canonical cutline:");
    // What C1 owns is still C1's: the authority module drives quote eligibility
    // and the form patch did not reach into it.
    expect(src).toContain("resolveCostAuthority({");
    expect(src).toContain("await persistQuoteIfCanonicalAllows(");
  });

  it("the cutline blocker is not weakened", () => {
    const src = readFileSync("app/lib/label-cost-inputs.server.ts", "utf8");
    expect(src).toContain('{ [line.key]: { model: "separated_rectangle" } }; // artboard fallback -> blocks');
    const finishing = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    expect(finishing).toContain("cutlineGeometryRequired");
  });

  it("the storefront/Zakeke modules are not imported by the authority module", () => {
    const src = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    for (const forbidden of ["storefront-canonical-pricing", "canonical-bag-pricing", "canonical-sticker-pricing", "zakeke", "product-family"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
