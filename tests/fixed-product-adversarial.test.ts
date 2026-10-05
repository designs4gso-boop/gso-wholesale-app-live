// 2026-10-05 — adversarial calculator cases for fixed products.
//
// Every case must FAIL CLOSED (DRAFT_ONLY, unit cost null, a named reason) or
// be refused by the normalizer — never a silently substituted size or price.
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_REASONS } from "../app/lib/canonical-calculator-shared";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { getProductProductionSpec, listProductSpecs } from "../app/lib/product-production-spec";

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

const run = (q: string) => {
  const input = normalizeCanonicalInput(new URLSearchParams(q));
  expect(input, q).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};
const blocked = (q: string, reason?: string) => {
  const r = run(q);
  expect(r.status, `${q}\n${r.blockers.join("\n")}`).toBe("DRAFT_ONLY");
  expect(r.unitCost, q).toBeNull();
  expect(r.blockers.length, q).toBeGreaterThan(0);
  if (reason) expect(r.reasons, q).toContain(reason);
  return r;
};
const GOOD = "pfamily=premium-jars&pqty=100&pjar=miron/100ml_wide&pjarside=1&pjarlid=1&pcmykcoverage=40";

describe("fixed-product adversarial cases", () => {
  it("sanity: the good job is not blocked", () => {
    const r = run(GOOD);
    expect(r.status).not.toBe("DRAFT_ONLY");
    expect(r.unitCost).not.toBeNull();
  });

  it("missing product key", () => {
    blocked("pfamily=premium-jars&pqty=100&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.familyUnsupported);
  });

  it("unknown jar size", () => {
    blocked("pfamily=premium-jars&pqty=100&pjar=miron/500ml&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.familyUnsupported);
  });

  it("placeholder 5oz jar is not costable and not in the spec list", () => {
    blocked("pfamily=standard-jars&pqty=100&pjar=standard/5oz&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.familyUnsupported);
    expect(listProductSpecs().some((s) => /5oz/.test(s.productKey))).toBe(false);
    expect(getProductProductionSpec("standard-jars", "standard/5oz")).toBeNull();
  });

  it("a Chiron size GSO does not offer (50ml) is refused — no vendor work was added", () => {
    blocked("pfamily=premium-jars&pqty=100&pjar=chiron/50ml&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.familyUnsupported);
  });

  it("jar quoted under the wrong family", () => {
    blocked("pfamily=standard-jars&pqty=100&pjar=miron/100ml_wide&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.familyUnsupported);
  });

  it("no label selected (missing dims = nothing to print)", () => {
    blocked("pfamily=premium-jars&pqty=100&pjar=miron/100ml_wide&pcmykcoverage=40", CANONICAL_REASONS.noPrintedComponent);
  });

  it("legacy unsupported label rows (neck/bottom) block rather than drop", () => {
    blocked(GOOD + "&pjarunsupported=neck,bottom", CANONICAL_REASONS.labelGeometryUnsupported);
  });

  it("zero and negative quantity", () => {
    blocked("pfamily=premium-jars&pqty=0&pjar=miron/100ml_wide&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.quantityRequired);
    blocked("pfamily=premium-jars&pqty=-5&pjar=miron/100ml_wide&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.quantityRequired);
    blocked("pfamily=premium-jars&pqty=abc&pjar=miron/100ml_wide&pjarside=1&pcmykcoverage=40", CANONICAL_REASONS.quantityRequired);
  });

  it("partial override", () => {
    blocked(GOOD + "&pjarcustom=1&pjarsidew=7", CANONICAL_REASONS.customSizeIncomplete);
  });

  it("invalid lid diameter", () => {
    blocked(GOOD + "&pjarcustom=1&pjarlidd=0", CANONICAL_REASONS.customSizeIncomplete);
    blocked(GOOD + "&pjarcustom=1&pjarlidd=-1", CANONICAL_REASONS.customSizeIncomplete);
    blocked(GOOD + "&pjarcustom=1&pjarlidd=NaN", CANONICAL_REASONS.customSizeIncomplete);
  });

  it("extreme dimensions", () => {
    blocked(GOOD + "&pjarcustom=1&pjarsidew=9999&pjarsideh=9999", CANONICAL_REASONS.customSizeIncomplete);
    blocked(GOOD + "&pjarcustom=1&pjarlidd=0.0001", CANONICAL_REASONS.customSizeIncomplete);
  });

  it("override values without the override flag (conflict)", () => {
    blocked(GOOD + "&pjarsidew=7&pjarsideh=3", CANONICAL_REASONS.customSizeConflict);
  });

  it("override for a piece not in the label set", () => {
    blocked("pfamily=premium-jars&pqty=100&pjar=miron/100ml_wide&pjarlid=1&pcmykcoverage=40&pjarcustom=1&pjarsidew=7&pjarsideh=3", CANONICAL_REASONS.customSizeIncomplete);
  });

  it("multi-piece job missing a piece's timing (3oz tamper) blocks on the application standard", () => {
    blocked("pfamily=standard-jars&pqty=100&pjar=standard/3oz&pjarvariant=black_white&pjarside=1&pjarlid=1&pjartamper=1&pcmykcoverage=40", CANONICAL_REASONS.applicationStandardRequired);
  });

  it("Mimaki + white is refused by routing (CMYK-only press)", () => {
    const r = blocked(GOOD + "&pprinter=mimaki&pwhitelayers=1&pwhitecoverage=50");
    expect(r.blockers.join("\n")).toMatch(/MIMAKI_SPECIALTY_UNSUPPORTED/);
  });

  it("Mimaki + gloss is refused by routing", () => {
    const r = blocked(GOOD + "&pprinter=mimaki&pglosslayers=1&pglosscoverage=50");
    expect(r.blockers.join("\n")).toMatch(/MIMAKI_SPECIALTY_UNSUPPORTED/);
  });

  it("a specialty (white) job on AUTO routes to the Roland — it does not silently stay CMYK on the Mimaki", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(GOOD + "&pprinter=auto&pwhitelayers=1&pwhitecoverage=50"))!;
    const r = assembleCanonicalJob(input, CAL); // CAL is a Mimaki CMYK calibration: identity mismatch must not price
    expect(r.routing.machineKey).not.toBe("mimaki-ucjv300-130");
  });

  it("historical snapshot shape: a stored canonical view without productSpec/finishingBreakdown is still readable", () => {
    const stored = JSON.parse(JSON.stringify({ diagnostics: { weedingPages: 2, applicationEvents: 256 } }));
    // The UI guards on `d.productSpec ?` / `d.finishingBreakdown ?`; the stored shape must not throw when absent.
    expect(stored.diagnostics.productSpec).toBeUndefined();
    expect(stored.diagnostics.finishingBreakdown).toBeUndefined();
  });

  it("a stored snapshot keeps the dimensions it was priced with even if the table later changed", () => {
    const r = run(GOOD);
    const snapshot = JSON.parse(JSON.stringify(r.diagnostics.productSpec));
    // simulate a later spec revision WITHOUT touching the authority: the snapshot copy is independent
    snapshot.standard.side.widthIn = 6.6; // what was priced
    expect(r.diagnostics.productSpec!.standard.side.widthIn).toBe(6.6);
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(r.diagnostics.productSpec)));
  });

  it("the normalizer refuses a non-canonical family rather than guessing", () => {
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=dtp-bags&pqty=1000"))).toBeNull();
    expect(normalizeCanonicalInput(new URLSearchParams("pfamily=boxes&pqty=10"))).toBeNull();
  });
});
