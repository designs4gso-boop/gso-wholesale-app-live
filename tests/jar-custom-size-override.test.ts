// 2026-10-05 — CUSTOM SIZE OVERRIDE through the canonical jar engine.
//
// Pins: no override => byte-identical result to before; an override changes
// media/ink/cutting/weeding ONLY (application and setup untouched); every
// partial / conflicting / out-of-range override BLOCKS; the spec used — and
// any override — is recorded in diagnostics so the quote snapshot carries it.
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  canonicalViewOf,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_REASONS } from "../app/lib/canonical-calculator-shared";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { JAR_LABEL_GEOMETRY } from "../app/lib/jar-label-geometry";

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

const BASE = "pfamily=premium-jars&pqty=128&pjar=miron/100ml_wide&pjarside=1&pjarlid=1&pcmykcoverage=40";
const run = (q: string) => {
  const input = normalizeCanonicalInput(new URLSearchParams(q));
  expect(input, q).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};
const line = (r: ReturnType<typeof run>, key: string) => r.trueCost.lines.filter((l) => l.key === key).reduce((t, l) => t + l.amount, 0);

describe("normalizer passes the override fields through untouched", () => {
  it("no override fields => customSize false, geometryOverride null", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(BASE))!;
    expect(input.jar?.customSize).toBe(false);
    expect(input.jar?.geometryOverride).toBeNull();
    expect(input.jar?.overrideReason).toBeNull();
    expect(input.jar?.labelSet).toBeNull();
  });

  it("override fields arrive as typed, including half-typed pieces and label set", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(BASE + "&pjarset=side_lid&pjarcustom=1&pjarsidew=7&pjarlidd=2&pjaroverridereason=die%20line"))!;
    expect(input.jar?.labelSet).toBe("side_lid");
    expect(input.jar?.customSize).toBe(true);
    expect(input.jar?.geometryOverride).toEqual({ side: { widthIn: 7, heightIn: undefined }, lid: { diameterIn: 2 } });
    expect(input.jar?.overrideReason).toBe("die line");
  });

  it("non-numeric text becomes NaN (so the assembler refuses it), never a default", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(BASE + "&pjarcustom=1&pjarlidd=two"))!;
    expect(Number.isNaN(input.jar?.geometryOverride?.lid?.diameterIn)).toBe(true);
  });
});

describe("zero change without an override", () => {
  it("the result with no override fields equals the result with the flag absent and empty strings", () => {
    const a = run(BASE);
    const b = run(BASE + "&pjarcustom=&pjarsidew=&pjarsideh=&pjarlidd=&pjaroverridereason=");
    expect(b.totalCost).toBe(a.totalCost);
    expect(b.status).toBe(a.status);
    expect(b.diagnostics).toEqual(a.diagnostics);
    expect(a.diagnostics.productSpec?.customSize).toBe(false);
    expect(a.diagnostics.productSpec?.override).toEqual({});
  });

  it("the spec used is recorded: product, source, standard dims for the selected pieces only", () => {
    const r = run(BASE);
    expect(r.diagnostics.productSpec).toMatchObject({
      family: "premium-jars",
      productKey: "miron/100ml_wide",
      displayName: "Miron 100ml",
      customSize: false,
      overriddenPieces: [],
      overrideReason: null,
      standard: { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 } },
    });
    expect(r.diagnostics.productSpec?.standard).not.toHaveProperty("tamper");
    expect(r.diagnostics.productSpec?.source).toMatch(/JAR_LABEL_GEOMETRY/);
    expect(r.diagnostics.productSpec?.specVersion).toMatch(/product-production-spec/);
  });

  it("the recorded spec is a COPY — mutating it cannot touch the authority table", () => {
    const r = run(BASE);
    (r.diagnostics.productSpec!.standard.side as any).widthIn = 99;
    expect(JAR_LABEL_GEOMETRY["100ml_wide"].side.widthIn).toBe(6.6);
  });

  it("the view the browser/snapshot receives carries productSpec and finishingBreakdown", () => {
    const view = canonicalViewOf(run(BASE));
    expect(view.diagnostics.productSpec?.productKey).toBe("miron/100ml_wide");
    expect(view.diagnostics.finishingBreakdown?.total).toBeGreaterThan(0);
    // JSON round-trip (what the quote snapshot stores) preserves it
    expect(JSON.parse(JSON.stringify(view)).diagnostics.productSpec.standard.lid.diameterIn).toBe(1.9);
  });
});

describe("a valid override reaches the canonical cost", () => {
  it("a larger side changes media/ink/cutting/weeding but NOT application, setup, blank or packout", () => {
    const base = run(BASE);
    const over = run(BASE + "&pjarcustom=1&pjarsidew=7&pjarsideh=3&pjaroverridereason=customer%20die%20line");
    expect(over.status).toBe(base.status);
    expect(over.blockers).toEqual([]);
    expect(over.totalCost).toBeGreaterThan(base.totalCost);
    expect(line(over, "print_media")).toBeGreaterThan(line(base, "print_media"));
    expect(line(over, "ink")).toBeGreaterThan(line(base, "ink"));
    expect(line(over, "cutting_machine")).toBeGreaterThan(line(base, "cutting_machine"));
    for (const key of ["application", "art_setup", "print_setup", "blank_sets", "packout", "inbound_freight"]) {
      expect(line(over, key), key).toBe(line(base, key));
    }
    expect(over.diagnostics.applicationEvents).toBe(256);
    expect(over.diagnostics.inkableArtworkSqft).toBeGreaterThan(base.diagnostics.inkableArtworkSqft);
    expect(over.diagnostics.productSpec).toMatchObject({
      customSize: true,
      overriddenPieces: ["side"],
      override: { side: { widthIn: 7, heightIn: 3 } },
      standard: { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 } },
      overrideReason: "customer die line",
    });
  });

  it("overriding only the lid leaves the side run identical", () => {
    const base = run(BASE);
    const over = run(BASE + "&pjarcustom=1&pjarlidd=2.5");
    expect(over.blockers).toEqual([]);
    expect(over.diagnostics.productSpec?.overriddenPieces).toEqual(["lid"]);
    expect(over.diagnostics.productSpec?.override).toEqual({ lid: { diameterIn: 2.5 } });
    expect(over.totalCost).toBeGreaterThan(base.totalCost);
  });

  it("an override equal to the standard values is honoured but changes nothing in cost", () => {
    const base = run(BASE);
    const same = run(BASE + "&pjarcustom=1&pjarsidew=6.6&pjarsideh=2.6&pjarlidd=1.9");
    expect(same.blockers).toEqual([]);
    expect(same.totalCost).toBeCloseTo(base.totalCost, 10);
    expect(same.diagnostics.productSpec?.customSize).toBe(true);
    expect(same.diagnostics.productSpec?.overriddenPieces).toEqual(["side", "lid"]);
  });

  it("the override reason is capped, never required", () => {
    const r = run(BASE + "&pjarcustom=1&pjarlidd=2&pjaroverridereason=" + "x".repeat(600));
    expect(r.diagnostics.productSpec?.overrideReason?.length).toBe(240);
    expect(run(BASE + "&pjarcustom=1&pjarlidd=2").diagnostics.productSpec?.overrideReason).toBeNull();
  });
});

describe("every bad override BLOCKS (DRAFT_ONLY, unit cost null)", () => {
  const expectBlocked = (q: string, reason: string, message?: RegExp) => {
    const r = run(q);
    expect(r.status, q).toBe("DRAFT_ONLY");
    expect(r.unitCost, q).toBeNull();
    expect(r.reasons, q).toContain(reason);
    if (message) expect(r.blockers.join("\n"), q).toMatch(message);
    return r;
  };

  it("values WITHOUT the flag: CUSTOM_SIZE_CONFLICT — not applied, not ignored", () => {
    const r = expectBlocked(BASE + "&pjarsidew=7&pjarsideh=3", CANONICAL_REASONS.customSizeConflict, /NOT silently used/);
    expect(r.diagnostics.productSpec?.customSize).toBe(false);
    expect(r.diagnostics.productSpec?.override).toEqual({});
  });

  it("flag ON with nothing entered: CUSTOM_SIZE_INCOMPLETE", () => {
    expectBlocked(BASE + "&pjarcustom=1", CANONICAL_REASONS.customSizeIncomplete, /no custom dimension was entered/);
  });

  it("partial piece (width only / height only): CUSTOM_SIZE_INCOMPLETE naming the piece", () => {
    expectBlocked(BASE + "&pjarcustom=1&pjarsidew=7", CANONICAL_REASONS.customSizeIncomplete, /side override needs BOTH/);
    expectBlocked(BASE + "&pjarcustom=1&pjarsideh=3", CANONICAL_REASONS.customSizeIncomplete, /side override needs BOTH/);
  });

  it("invalid lid diameter: zero, negative, text, extreme", () => {
    expectBlocked(BASE + "&pjarcustom=1&pjarlidd=0", CANONICAL_REASONS.customSizeIncomplete);
    expectBlocked(BASE + "&pjarcustom=1&pjarlidd=-2", CANONICAL_REASONS.customSizeIncomplete);
    expectBlocked(BASE + "&pjarcustom=1&pjarlidd=abc", CANONICAL_REASONS.customSizeIncomplete);
    expectBlocked(BASE + "&pjarcustom=1&pjarlidd=500", CANONICAL_REASONS.customSizeIncomplete, /outside/);
    expectBlocked(BASE + "&pjarcustom=1&pjarlidd=0.01", CANONICAL_REASONS.customSizeIncomplete, /outside/);
  });

  it("extreme side dimensions block instead of nesting a 1000 inch label", () => {
    expectBlocked(BASE + "&pjarcustom=1&pjarsidew=1000&pjarsideh=3", CANONICAL_REASONS.customSizeIncomplete, /outside/);
  });

  it("an override for a label that is not in the set (lid size on Side Only) blocks", () => {
    expectBlocked("pfamily=premium-jars&pqty=128&pjar=miron/100ml_wide&pjarside=1&pcmykcoverage=40&pjarcustom=1&pjarlidd=2", CANONICAL_REASONS.customSizeIncomplete, /not in the selected label set/);
  });

  it("a tamper override on a jar with no tamper timing still blocks on the timing (never costed from the override)", () => {
    const r = run("pfamily=standard-jars&pqty=100&pjar=standard/3oz&pjarvariant=black_white&pjarside=1&pjartamper=1&pcmykcoverage=40&pjarcustom=1&pjartamperw=6&pjartamperh=0.5");
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.reasons).toContain(CANONICAL_REASONS.applicationStandardRequired);
  });
});
