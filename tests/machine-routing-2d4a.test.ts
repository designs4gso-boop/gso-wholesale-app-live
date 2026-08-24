// Patch 2D-4A — canonical machine routing + calibration resolution.
//
// The rule under test: a normal operator picks a printer (auto / mimaki /
// roland) and, when specialty ink is involved, its layers and coverage. They
// never type a calibration internal. Routing derives the rest, and every
// unresolved piece fails closed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_CALIBRATION_IDENTITIES,
  MACHINE_CAPABILITIES,
  MACHINE_KEYS,
  PRINTER_SELECTIONS,
  ROUTING_REASONS,
  normalizePrinterSelection,
  resolveCanonicalMachineRouting,
  type CanonicalCalibrationKey,
} from "../app/lib/machine-routing.server";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  routingFor,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { isQuantityIndependentBasis } from "../app/lib/true-cost-engine.server";

/* ------------------------------------------------------------------ *
 * Fixtures mirroring the four SEEDED owner-measured rows.
 * ------------------------------------------------------------------ */

const row = (key: CanonicalCalibrationKey, values: { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }) => ({
  id: `cal_${key}`,
  shop: "test",
  ...CANONICAL_CALIBRATION_IDENTITIES[key],
  inkAreaBasis: "inkable_artwork",
  timeAreaBasis: "rip_layout",
  fixedMinutes: null,
  timeModel: "variable_only",
  measuredAt: new Date(0),
  effectiveFrom: new Date(0),
  effectiveTo: null,
  status: "approved",
  source: "owner-measured",
  notes: null,
  supersedesId: null,
  ...values,
});

/** The exact values in tools/seed-machine-profile-calibrations.mjs. */
const SEEDED: Record<CanonicalCalibrationKey, any> = {
  "mimaki-cmyk": row("mimaki-cmyk", { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null }),
  "roland-cmyk": row("roland-cmyk", { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null }),
  "roland-white": row("roland-white", { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 }),
  "roland-gloss": row("roland-gloss", { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 }),
};

/** Build the resolved machine inputs a route would produce, with or without DB rows. */
function resolvedFor(qs: string, seeded = true) {
  const input = normalizeCanonicalInput(new URLSearchParams(qs));
  expect(input, `did not normalise: ${qs}`).not.toBeNull();
  const routing = routingFor(input!);
  const channels = routing.channels.map((channel) => ({
    ...channel,
    calibration: seeded ? SEEDED[channel.calibrationKey] : null,
    calibrationMessage: seeded ? "approved" : "No approved calibration for this identity.",
  }));
  const base = channels.find((channel) => channel.isBase)!;
  const machine: ResolvedMachineInputs = {
    calibration: base.calibration,
    calibrationMessage: base.calibrationMessage,
    inkCostPerMl: base.inkCostPerMl,
    inkCostSource: base.inkCostSource,
    channels,
    routing,
  };
  return assembleCanonicalJob(input!, machine);
}

const LABEL = (extra = "") =>
  `pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.85&pl0cuth=2.85&pl0mat=matte&pl0art=A${extra}`;
const BAG = "pfamily=sticker-bags&pqty=1000&pbagsides=2&pdesigns=1";
const STOCK = "pfamily=sticker-bags&pstockbag=1&pqty=1000&pbagsides=2";
const BANNER = "pfamily=banners&pqty=1&pbannerw=36&pbannerh=60&pdesigns=1";

const channel = (r: any, kind: string) => r.inkChannels.find((c: any) => c.kind === kind);

/* ================================================================== *
 * The seed is the authority — these identities must not drift from it
 * ================================================================== */

describe("2D-4A calibration identities match the seed exactly", () => {
  const seedSrc = readFileSync("tools/seed-machine-profile-calibrations.mjs", "utf8");

  it("all four owner-measured identities appear verbatim in the seed", () => {
    for (const [key, identity] of Object.entries(CANONICAL_CALIBRATION_IDENTITIES)) {
      for (const [field, value] of Object.entries(identity)) {
        expect(seedSrc, `${key}.${field}`).toContain(`${field}: "${value}"`);
      }
    }
  });

  it("the Mimaki is cmyk_heavy, not cmyk — heavy production is what was measured", () => {
    expect(CANONICAL_CALIBRATION_IDENTITIES["mimaki-cmyk"].inkMode).toBe("cmyk_heavy");
    expect(CANONICAL_CALIBRATION_IDENTITIES["roland-cmyk"].inkMode).toBe("cmyk");
  });

  it("the owner baseline values are the ones the seed carries", () => {
    // cross-check only — the repo/seed remains the authority
    expect(seedSrc).toContain("mlPerSqftPerPass: 1.89");   // Mimaki CMYK heavy
    expect(seedSrc).toContain("minutesPerSqft: 1.444");
    expect(seedSrc).toContain("mlPerSqftPerPass: 1.4133"); // Roland CMYK
    expect(seedSrc).toContain("minutesPerSqft: 0.91");
    expect(seedSrc).toContain("mlPerSqftPerPass: 6.0");    // Roland white
    expect(seedSrc).toContain("minutesPerSqft: 1.71");
    expect(seedSrc).toContain("mlPerSqftPerPass: 4.18");   // Roland gloss
  });

  it("ink is measured on inkable artwork and time on RIP layout — never swapped", () => {
    expect(seedSrc.match(/inkAreaBasis: "inkable_artwork"/g)).toHaveLength(4);
    expect(seedSrc.match(/timeAreaBasis: "rip_layout"/g)).toHaveLength(4);
  });
});

/* ================================================================== *
 * 1-7  ROUTING
 * ================================================================== */

describe("2D-4A canonical machine routing", () => {
  it("1. AUTO + CMYK only -> Mimaki", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "auto" });
    expect(r.effectivePrinter).toBe("mimaki");
    expect(r.machineKey).toBe(MACHINE_KEYS.mimaki);
    expect(r.blockers).toHaveLength(0);
    expect(r.channels.map((c) => c.kind)).toEqual(["cmyk"]);
    expect(r.routingBasis).toMatch(/AUTO/);
  });

  it("2. AUTO + white -> Roland", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, whiteCoveragePct: 60 });
    expect(r.effectivePrinter).toBe("roland");
    expect(r.machineKey).toBe(MACHINE_KEYS.roland);
    expect(r.blockers).toHaveLength(0);
    expect(r.channels.map((c) => c.kind)).toEqual(["cmyk", "white"]);
  });

  it("3. AUTO + gloss -> Roland", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "auto", glossLayers: 1 });
    expect(r.effectivePrinter).toBe("roland");
    expect(r.channels.map((c) => c.kind)).toEqual(["cmyk", "gloss"]);
    expect(r.blockers).toHaveLength(0);
  });

  it("3b. AUTO + white + gloss -> Roland, all three channels", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, whiteCoveragePct: 60, glossLayers: 1 });
    expect(r.effectivePrinter).toBe("roland");
    expect(r.channels.map((c) => c.kind)).toEqual(["cmyk", "white", "gloss"]);
    expect(r.blockers).toHaveLength(0);
  });

  it("4. explicit Roland on a CMYK-only job is allowed (overflow work)", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "roland" });
    expect(r.effectivePrinter).toBe("roland");
    expect(r.overrideApplied).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.channels[0].calibrationKey).toBe("roland-cmyk");
  });

  it("4b. explicit Mimaki on a CMYK-only job is allowed", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "mimaki" });
    expect(r.effectivePrinter).toBe("mimaki");
    expect(r.overrideApplied).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("5. explicit Mimaki + white BLOCKS", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "mimaki", whiteLayers: 1, whiteCoveragePct: 60 });
    expect(r.reasons).toContain(ROUTING_REASONS.mimakiSpecialtyUnsupported);
    expect(r.blockers.join(" ")).toMatch(/CMYK-only press and cannot print white/);
  });

  it("6. explicit Mimaki + gloss BLOCKS", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "mimaki", glossLayers: 1 });
    expect(r.reasons).toContain(ROUTING_REASONS.mimakiSpecialtyUnsupported);
    expect(r.blockers.join(" ")).toMatch(/cannot print gloss/);
  });

  it("6b. the capability table says why — the Mimaki has no specialty channels", () => {
    expect(MACHINE_CAPABILITIES.mimaki).toEqual({ cmyk: true, white: false, gloss: false });
    expect(MACHINE_CAPABILITIES.roland).toEqual({ cmyk: true, white: true, gloss: true });
    // and no Mimaki gloss $/mL exists either, so it could never price
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBeNull();
  });

  it("7. the operator never supplies a calibration internal", () => {
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    // the normaliser reads NONE of these from the query string
    for (const param of ["pripprofile", "pqualitymode", "presolution", "ppassconfig", "pinkmode", "pmachinekey"]) {
      expect(src, param).not.toContain(param);
    }
    // it reads only the operator-facing ones
    for (const param of ["pprinter", "pwhitelayers", "pwhitecoverage", "pglosslayers", "pglosscoverage"]) {
      expect(src, param).toContain(param);
    }
    expect(PRINTER_SELECTIONS).toEqual(["auto", "mimaki", "roland"]);
    expect(normalizePrinterSelection("")).toBe("auto");
    expect(normalizePrinterSelection(undefined)).toBe("auto");
    expect(normalizePrinterSelection("ROLAND")).toBe("roland");
  });

  it("8. the resolver returns the exact canonical identity for each channel", () => {
    const r = resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, whiteCoveragePct: 50, glossLayers: 1 });
    expect(channelIdentity(r, "cmyk")).toEqual(CANONICAL_CALIBRATION_IDENTITIES["roland-cmyk"]);
    expect(channelIdentity(r, "white")).toEqual(CANONICAL_CALIBRATION_IDENTITIES["roland-white"]);
    expect(channelIdentity(r, "gloss")).toEqual(CANONICAL_CALIBRATION_IDENTITIES["roland-gloss"]);
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto" }).channels[0].identity)
      .toEqual(CANONICAL_CALIBRATION_IDENTITIES["mimaki-cmyk"]);
    // every identity is complete — all six parts, none blank
    for (const identity of r.requiredIdentities) {
      expect(Object.keys(identity).sort()).toEqual(["inkMode", "machineKey", "passConfig", "qualityMode", "resolution", "ripProfile"]);
      for (const value of Object.values(identity)) expect(String(value).length).toBeGreaterThan(0);
    }
  });

  function channelIdentity(r: any, kind: string) {
    return r.channels.find((c: any) => c.kind === kind)!.identity;
  }
});

/* ================================================================== *
 * 9-12  WHITE + GLOSS
 * ================================================================== */

describe("2D-4A white and gloss are priced on their own calibrations", () => {
  it("9. white coverage changes white ink and nothing else", () => {
    const at60 = resolvedFor(LABEL("&pwhitelayers=1&pwhitecoverage=60"));
    const at30 = resolvedFor(LABEL("&pwhitelayers=1&pwhitecoverage=30"));
    expect(channel(at60, "white").totalMl).toBeCloseTo(2 * channel(at30, "white").totalMl, 6);
    // CMYK is untouched by white coverage
    expect(channel(at60, "cmyk").totalMl).toBeCloseTo(channel(at30, "cmyk").totalMl, 10);
    // and coverage never touches occupancy
    expect(channel(at60, "white").occupancyMinutes).toBeCloseTo(channel(at30, "white").occupancyMinutes, 10);
  });

  it("10. missing white coverage BLOCKS — it is never defaulted", () => {
    const r = resolvedFor(LABEL("&pwhitelayers=2"));
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.reasons).toContain(ROUTING_REASONS.whiteCoverageRequired);
    expect(r.blockers.join(" ")).toMatch(/white has NO default coverage/);
    expect(r.blockers.join(" ")).toMatch(/never derived from them/);
  });

  it("10b. an out-of-range white coverage blocks too", () => {
    for (const bad of [0, 101, -5]) {
      const r = resolvedFor(LABEL(`&pwhitelayers=1&pwhitecoverage=${bad}`));
      expect(r.reasons, String(bad)).toContain(ROUTING_REASONS.invalidCoverage);
      expect(r.status).toBe("DRAFT_ONLY");
    }
  });

  it("11. white LAYERS change white ink quantity, separately from coverage", () => {
    const one = resolvedFor(LABEL("&pwhitelayers=1&pwhitecoverage=60"));
    const two = resolvedFor(LABEL("&pwhitelayers=2&pwhitecoverage=60"));
    expect(channel(two, "white").passes).toBe(2);
    expect(channel(two, "white").totalMl).toBeCloseTo(2 * channel(one, "white").totalMl, 6);
    // layers also double the white press occupancy
    expect(channel(two, "white").occupancyMinutes).toBeCloseTo(2 * channel(one, "white").occupancyMinutes, 6);
    // layers and coverage are genuinely independent knobs
    const twoAt30 = resolvedFor(LABEL("&pwhitelayers=2&pwhitecoverage=30"));
    expect(channel(twoAt30, "white").totalMl).toBeCloseTo(channel(one, "white").totalMl, 6);
  });

  it("12. gloss uses the Roland gloss calibration and its 50% owner default", () => {
    const r = resolvedFor(LABEL("&pglosslayers=1"));
    const gloss = channel(r, "gloss");
    expect(gloss.calibrationKey).toBe("roland-gloss");
    expect(gloss.mlPerSqftPerPass).toBe(4.18);
    expect(gloss.coveragePct).toBe(50);
    expect(gloss.coverageSource).toBe("gloss_default");
    // 62.5 sqft x 50% x 4.18 mL/sqft x 1 pass
    expect(gloss.totalMl).toBeCloseTo(62.5 * 0.5 * 4.18, 6);
    expect(gloss.inkCost).toBeCloseTo(gloss.totalMl * CANONICAL_INK_RATES.rolandPerMl, 8);
    // gloss is NOT blocked by a missing coverage — white is, gloss has a default
    expect(r.status).not.toBe("DRAFT_ONLY");
  });

  it("white and gloss are never merged into the CMYK arithmetic", () => {
    const r = resolvedFor(LABEL("&pwhitelayers=1&pwhitecoverage=60&pglosslayers=1"));
    expect(r.inkChannels.map((c: any) => c.kind)).toEqual(["cmyk", "white", "gloss"]);
    const kinds = new Set(r.inkChannels.map((c: any) => c.calibrationKey));
    expect(kinds.size).toBe(3);
    // each channel keeps its own mL rate, coverage, passes and cost
    expect(channel(r, "cmyk").mlPerSqftPerPass).toBe(1.4133);
    expect(channel(r, "white").mlPerSqftPerPass).toBe(6.0);
    expect(channel(r, "gloss").mlPerSqftPerPass).toBe(4.18);
    // and the job's ink total is exactly the sum of the three
    const summed = r.inkChannels.reduce((s: number, c: any) => s + (c.inkCost ?? 0), 0);
    expect(r.trueCost.totals.ink).toBeCloseTo(summed, 8);
  });

  it("every channel uses its calibration's OWN area basis", () => {
    const r = resolvedFor(LABEL("&pwhitelayers=1&pwhitecoverage=60&pglosslayers=1"));
    for (const c of r.inkChannels) {
      expect(c.areaBasis).toBe("inkable_artwork");
      expect(c.occupancyAreaBasis).toBe("rip_layout");
      // ink measured on artwork area, occupancy on the larger RIP layout
      expect(c.inkableSqft).toBeCloseTo(r.diagnostics.inkableArtworkSqft, 6);
      expect(c.occupancyAreaSqft).toBeCloseTo(r.diagnostics.ripLayoutSqft!, 6);
      expect(c.occupancyAreaSqft).not.toBeCloseTo(c.inkableSqft!, 2);
    }
  });
});

/* ================================================================== *
 * 13-15  FAMILY ROUTING
 * ================================================================== */

describe("2D-4A standard jobs route correctly by family", () => {
  it("13. a standard 4x5 sticker bag resolves the Mimaki", () => {
    const r = resolvedFor(BAG);
    expect(r.routing.effectivePrinter).toBe("mimaki");
    expect(r.inkChannels).toHaveLength(1);
    expect(channel(r, "cmyk").calibrationKey).toBe("mimaki-cmyk");
    expect(r.status).not.toBe("DRAFT_ONLY");
    expect(r.unitCost).not.toBeNull();
  });

  it("14. a standard Stock Bag resolves the Mimaki, same as the sticker bag", () => {
    const stock = resolvedFor(STOCK);
    const sticker = resolvedFor(BAG);
    expect(stock.routing.effectivePrinter).toBe("mimaki");
    expect(channel(stock, "cmyk").calibrationKey).toBe("mimaki-cmyk");
    // identical physical cost; only setup differs
    expect(stock.trueCost.totals.ink).toBeCloseTo(sticker.trueCost.totals.ink, 10);
    expect(stock.trueCost.totals.materials).toBeCloseTo(sticker.trueCost.totals.materials, 10);
    expect(stock.diagnostics.mediaConsumedSqft).toBe(sticker.diagnostics.mediaConsumedSqft);
  });

  it("15. a standard CMYK banner resolves the Mimaki", () => {
    const r = resolvedFor(BANNER);
    expect(r.routing.effectivePrinter).toBe("mimaki");
    expect(channel(r, "cmyk").calibrationKey).toBe("mimaki-cmyk");
    // 2D-3A media consumption survives
    expect(r.diagnostics.mediaConsumedSqft).toBeCloseTo(22.5, 8);
    expect(r.diagnostics.inkableArtworkSqft).toBeCloseTo(15, 8);
    expect(r.diagnostics.weedingPages).toBe(0);
    expect(r.unitCost).not.toBeNull();
  });

  it("bags keep every approved 2D fact under the new routing", () => {
    const r = resolvedFor(BAG);
    expect(r.trueCost.lines.find((l: any) => l.key === "blank_sets")!.amount).toBeCloseTo(1000 * 0.11, 8);
    expect(r.trueCost.lines.find((l: any) => l.key === "application")!.amount).toBeCloseTo((1000 * 2 * 10 / 3600) * 20, 6);
    expect(r.diagnostics.cutPathIn).toBeCloseTo(2000 * 2 * (3.79 + 4.81), 6);
    expect(r.diagnostics.weedingPages).toBeGreaterThan(0);
  });

  it("stock bag personalization survives routing untouched", () => {
    const r = resolvedFor(`${STOCK}&pperslogo=1&ppersdesigns=2`);
    expect(r.diagnostics.personalizationSetupEvents).toBe(2);
    expect(r.diagnostics.personalizationCustomerAddOn).toBe(0);
    expect(r.adapter.bag!.personalization.internalSetupCost).toBeCloseTo(2 * (25 / 3), 8);
  });
});

/* ================================================================== *
 * 16-18  FAIL-CLOSED + INVARIANTS
 * ================================================================== */

describe("2D-4A fails closed and preserves the committed invariants", () => {
  it("16. a logically-resolved identity with NO DB row still blocks", () => {
    for (const qs of [LABEL(), BAG, STOCK, BANNER]) {
      const r = resolvedFor(qs, false);
      expect(r.status, qs).toBe("DRAFT_ONLY");
      expect(r.unitCost).toBeNull();
      expect(r.blockers.join(" ")).toMatch(/MISSING_CALIBRATION/);
      // routing still resolved — the identity is known, the ROW is missing
      expect(r.routing.effectivePrinter).toBeTruthy();
      expect(r.routing.requiredIdentities.length).toBeGreaterThan(0);
    }
  });

  it("16b. a specialty channel with no row blocks even when the base resolves", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(LABEL("&pwhitelayers=1&pwhitecoverage=60")))!;
    const routing = routingFor(input);
    const channels = routing.channels.map((c) => ({
      ...c,
      // base resolves, white does NOT
      calibration: c.isBase ? SEEDED[c.calibrationKey] : null,
      calibrationMessage: c.isBase ? "approved" : "No approved calibration for this identity.",
    }));
    const base = channels.find((c) => c.isBase)!;
    const r = assembleCanonicalJob(input, {
      calibration: base.calibration, calibrationMessage: base.calibrationMessage,
      inkCostPerMl: base.inkCostPerMl, inkCostSource: base.inkCostSource, channels, routing,
    });
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.blockers.join(" ")).toMatch(/WHITE channel/);
  });

  it("16c. matching is never widened — no 'close enough' record is substituted", () => {
    const src = readFileSync("app/lib/machine-calibration.server.ts", "utf8");
    expect(src).toContain("It never widens the search, never");
    // the resolver names exact identities only
    const routing = resolveCanonicalMachineRouting({ printerSelection: "auto" });
    expect(routing.requiredIdentities).toEqual([CANONICAL_CALIBRATION_IDENTITIES["mimaki-cmyk"]]);
  });

  it("17. jars are still not routed — their cutline blocker is untouched", () => {
    for (const family of ["standard-jars", "premium-jars"]) {
      expect(normalizeCanonicalInput(new URLSearchParams(`pfamily=${family}&pqty=1000&pprinter=auto`))).toBeNull();
    }
    // and a label with no actual cutline still blocks, calibration or not
    const noCut = resolvedFor("pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0mat=matte&pl0art=A");
    expect(noCut.status).toBe("DRAFT_ONLY");
    expect(noCut.blockers.join(" ")).toMatch(/CUTLINE_GEOMETRY_REQUIRED/);
  });

  it("18. setup stays quantity-independent under every routing", () => {
    for (const extra of ["", "&pwhitelayers=1&pwhitecoverage=60", "&pglosslayers=1", "&pprinter=roland"]) {
      const runs = [50, 500, 5000].map((qty) =>
        resolvedFor(LABEL(extra).replace("pl0qty=1000", `pl0qty=${qty}`)));
      expect(new Set(runs.map((r) => r.trueCost.totals.setup_labor)).size, extra).toBe(1);
      for (const line of runs[0].trueCost.lines.filter((l: any) => isQuantityIndependentBasis(l.basis))) {
        const twin = runs[2].trueCost.lines.find((l: any) => l.key === line.key)!;
        expect(twin.amount, `${line.key} ${extra}`).toBe(line.amount);
      }
      // ink genuinely scales, so the invariant is not "nothing moves"
      expect(runs[2].trueCost.totals.ink).toBeGreaterThan(runs[0].trueCost.totals.ink);
    }
  });

  it("routing lives in ONE place — adapters never re-derive it", () => {
    for (const adapter of ["bag-cost-inputs", "banner-cost-inputs", "label-cost-inputs"]) {
      const src = readFileSync(`app/lib/${adapter}.server.ts`, "utf8");
      expect(src, adapter).not.toContain("machine-routing");
      expect(src, adapter).not.toContain("resolveCanonicalMachineRouting");
    }
    // the route consumes the authority rather than reimplementing the rule
    const routeSrc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(routeSrc).toContain("resolveCanonicalMachineRouting");
    expect(routeSrc).not.toMatch(/pprinter"\) === "roland" \? "roland" as const/);
  });

  it("the UI offers AUTO and asks for white coverage, with no duplicate printer control", () => {
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src.match(/name="pprinter"/g)).toHaveLength(1); // ONE control, reused
    expect(src).toContain(`<option value="auto">`);
    expect(src).toContain(`name="pwhitecoverage"`);
    // and it survives the save round trip
    expect(src).toContain(`"pwhitecoverage"`);
  });
});
