// Patch 2D-4D1 — ACTIVE JAR SCOPE + CANONICAL PROMOTION.
//
// Two things had been conflated: the sizes the geometry tables KNOW about, and
// the ten jars GSO actually SELLS. Because of that, sizes nobody offers looked
// like missing costs and held the whole jar family in fail-closed.
//
// This suite pins the separation down. Scope decides what can be QUOTED; the
// verified cost tables still decide what anything COSTS, and a jar outside the
// active list is refused rather than given a stand-in price.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_JAR_KEYS,
  ACTIVE_JAR_PROFILES,
  activeJarProfile,
  activeJarProfileByKey,
  activeJarProfilesForFamily,
  canonicalJarLabelRole,
  isActiveJarProfile,
  resolveActiveJarProfile,
  resolveActiveJarVariant,
} from "../app/lib/jar-active-scope";
import {
  CANONICAL_FAMILIES,
  CANONICAL_REASONS,
  NON_CANONICAL_FAMILIES,
  assembleCanonicalJob,
  canonicalFamilyFromUi,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import {
  CANONICAL_FAIL_CLOSED_FAMILIES,
  CANONICAL_SUPPORTED_FAMILIES,
  FAIL_CLOSED_REASONS,
  canonicalSaveGate,
  familyCostModel,
  isCostedAuthority,
  persistQuoteIfCanonicalAllows,
  resolveCostAuthority,
} from "../app/lib/canonical-quote-authority.server";
import {
  CHIRON_SET_COST,
  JAR_APPLICATION_SECONDS_BY_SIZE,
  JAR_ART_SETUP_PER_DESIGN,
  JAR_LABEL_GEOMETRY,
  CHIRON_SET_COST_PROVENANCE,
  JAR_PLANNED_OVERAGE_PCT,
  JAR_PLANNED_OVERAGE_PROVENANCE,
  JAR_SETUP_RETIRED_ASSUMPTIONS,
  JAR_PRINT_SETUP_PER_JOB,
  MIRON_SET_COST,
  MIRON_TIER_MIN_QTYS,
  STANDARD_SET_COST,
  productionQtyFor,
  resolveJarBlankCost,
} from "../app/lib/jar-cost-inputs.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { blankClassAllowedFor } from "../app/lib/product-driven-costing.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const routeSrc = () => readFileSync(ROUTE, "utf8");

/** An approved Mimaki CMYK calibration, shaped exactly like a real DB row. */
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

const qs = (extra: Record<string, string | number> = {}) => {
  const params = new URLSearchParams({
    pfamily: "premium-jars", pqty: "500", pjar: "miron/100ml_wide",
    pjarside: "1", pjarlid: "1", pcmykcoverage: "40",
  });
  for (const [key, value] of Object.entries(extra)) {
    if (String(value) === "") params.delete(key);
    else params.set(key, String(value));
  }
  return params;
};

const run = (params: URLSearchParams) => {
  const input = normalizeCanonicalInput(params);
  expect(input, `did not normalise: ${params}`).not.toBeNull();
  return assembleCanonicalJob(input!, CAL);
};

const lineOf = (result: ReturnType<typeof run>, key: string) =>
  result.trueCost.lines.find((line) => line.key === key);

/* ------------------------------------------------------------------ */

describe("2D-4D1 — the active jar scope is exactly what the owner offers", () => {
  it("lists the ten offered combinations and nothing else", () => {
    expect(ACTIVE_JAR_KEYS.slice().sort()).toEqual([
      "chiron/100ml_tall", "chiron/100ml_wide", "chiron/150ml",
      "miron/100ml_tall", "miron/100ml_wide", "miron/150ml", "miron/250ml", "miron/50ml",
      "standard/3oz", "standard/4oz",
    ]);
  });

  it("follows the repo's own family split — Chiron and Miron are premium", () => {
    // product-family-registry: "Premium Jars — Chiron & Miron", and Standard
    // Jars is described as explicitly "Not Chiron". blankClassAllowedFor
    // enforces the same split, so the scope must not invent a different one.
    expect(activeJarProfilesForFamily("premium-jars").map((p) => p.key).sort())
      .toEqual([
        "chiron/100ml_tall", "chiron/100ml_wide", "chiron/150ml",
        "miron/100ml_tall", "miron/100ml_wide", "miron/150ml", "miron/250ml", "miron/50ml",
      ]);
    expect(activeJarProfilesForFamily("standard-jars").map((p) => p.key).sort())
      .toEqual(["standard/3oz", "standard/4oz"]);
    expect(blankClassAllowedFor("premium-jars", "jar_chiron")).toBe(true);
    expect(blankClassAllowedFor("standard-jars", "jar_chiron")).toBe(false);
  });

  it("keeps the owner's '100ml' / '100ml tall' names attached to the right geometry", () => {
    // The mapping is decided by the jars themselves, not by the key spelling:
    // the TALL one is the narrower, taller body on the smaller lid.
    const tall = JAR_LABEL_GEOMETRY["100ml_tall"];
    const wide = JAR_LABEL_GEOMETRY["100ml_wide"];
    expect(tall.side.heightIn).toBeGreaterThan(wide.side.heightIn);   // taller body
    expect(tall.side.widthIn).toBeLessThan(wide.side.widthIn);        // narrower wrap
    expect(tall.lid.diameterIn).toBeLessThan(wide.lid.diameterIn);    // smaller lid

    expect(activeJarProfile("miron", "100ml_tall")!.label).toBe("Miron 100ml tall");
    expect(activeJarProfile("miron", "100ml_wide")!.label).toBe("Miron 100ml");
    expect(activeJarProfile("chiron", "100ml_tall")!.label).toBe("Chiron 100ml tall");
    expect(activeJarProfile("chiron", "100ml_wide")!.label).toBe("Chiron 100ml");
  });

  it("does NOT invent scope for combinations the owner did not name", () => {
    const notOffered = [
      "miron/3oz", "miron/4oz", "chiron/50ml", "chiron/250ml", "chiron/3oz", "chiron/4oz",
      "standard/50ml", "standard/100ml_wide", "standard/150ml", "standard/250ml",
    ];
    for (const key of notOffered) {
      const [brand, size] = key.split("/");
      expect(isActiveJarProfile(brand, size), `${key} must not be offered`).toBe(false);
      expect(activeJarProfileByKey(key)).toBeNull();
    }
  });
});

describe("2D-4D1 — resolving a live blank record to a profile", () => {
  it("reads real record names, testing '100ml tall' before the bare '100ml'", () => {
    expect(resolveActiveJarProfile("Miron 100ml tall jar")!.key).toBe("miron/100ml_tall");
    expect(resolveActiveJarProfile("Miron Violet Glass Jar 100ml")!.key).toBe("miron/100ml_wide");
    expect(resolveActiveJarProfile("Chiron 150ml jar with lid")!.key).toBe("chiron/150ml");
    expect(resolveActiveJarProfile("3oz jar - clear")!.key).toBe("standard/3oz");
    expect(resolveActiveJarProfile("4oz jar - black/white")!.key).toBe("standard/4oz");
  });

  it("returns null for records that are not offered, not jars, or unreadable", () => {
    expect(resolveActiveJarProfile("Miron 4oz jar")).toBeNull();       // size exists, not offered
    expect(resolveActiveJarProfile("Chiron 250ml jar")).toBeNull();
    expect(resolveActiveJarProfile("5oz jar - clear")).toBeNull();     // no such size at all
    expect(resolveActiveJarProfile("Poseidon matte roll")).toBeNull();
    expect(resolveActiveJarProfile("")).toBeNull();
    expect(resolveActiveJarProfile(null)).toBeNull();
  });

  it("reads the standard-jar variant, and only where a variant exists", () => {
    expect(resolveActiveJarVariant("3oz jar - clear")).toBe("clear");
    expect(resolveActiveJarVariant("4oz jar - black/white")).toBe("black_white");
    expect(resolveActiveJarVariant("Miron 150ml jar")).toBeNull();
  });
});

describe("2D-4D1 — jar label roles", () => {
  it("maps only the three positions a jar has verified geometry for", () => {
    expect(canonicalJarLabelRole("side")).toBe("side");
    expect(canonicalJarLabelRole("lid")).toBe("lid");
    expect(canonicalJarLabelRole("tamper")).toBe("tamper");
  });

  it("refuses every row type with no jar geometry rather than dropping it", () => {
    for (const type of ["bottom", "neck", "additional", "custom", "lid-side", "front", "warning", ""]) {
      expect(canonicalJarLabelRole(type), `${type} has no verified jar geometry`).toBeNull();
    }
  });
});

describe("2D-4D1 — the jar families are promoted, and the mechanism survives", () => {
  it("routes both jar families through the canonical cost authority", () => {
    expect(CANONICAL_SUPPORTED_FAMILIES).toContain("standard-jars");
    expect(CANONICAL_SUPPORTED_FAMILIES).toContain("premium-jars");
    expect(familyCostModel("standard-jars")).toBe("CANONICAL_COST_AUTHORITY");
    expect(familyCostModel("premium-jars")).toBe("CANONICAL_COST_AUTHORITY");
  });

  it("no longer treats jars as non-canonical anywhere", () => {
    expect(CANONICAL_FAMILIES).toContain("standard-jars");
    expect(CANONICAL_FAMILIES).toContain("premium-jars");
    expect(NON_CANONICAL_FAMILIES as readonly string[]).not.toContain("standard-jars");
    expect(NON_CANONICAL_FAMILIES as readonly string[]).not.toContain("premium-jars");
    expect(canonicalFamilyFromUi("standard-jars", false)).toBe("standard-jars");
    expect(canonicalFamilyFromUi("premium-jars", false)).toBe("premium-jars");
  });

  it("empties the fail-closed list without deleting the mechanism", () => {
    expect(CANONICAL_FAIL_CLOSED_FAMILIES).toHaveLength(0);
    expect(Object.keys(FAIL_CLOSED_REASONS)).toHaveLength(0);
    // The refusal path itself is still wired: a truly outsourced family is
    // still distinguished from a canonical one.
    expect(familyCostModel("dtp-bags")).toBe("LEGACY_OUTSOURCED");
    expect(familyCostModel("boxes")).toBe("LEGACY_OUTSOURCED");
  });
});

describe("2D-4D1 — every active profile actually costs", () => {
  it("produces a real unit cost with no blockers for all ten", () => {
    for (const profile of ACTIVE_JAR_PROFILES) {
      const result = run(qs({
        pfamily: profile.uiFamily,
        pjar: profile.key,
        pjarvariant: profile.brand === "standard" ? "clear" : "",
      }));
      expect(result.blockers, `${profile.label}: ${result.blockers.join(" | ")}`).toHaveLength(0);
      expect(result.status, profile.label).not.toBe("DRAFT_ONLY");
      expect(result.unitCost, profile.label).toBeGreaterThan(0);
    }
  });

  it("costs a jar from the verified blank tables, never a stand-in", () => {
    // Miron is tiered; the 500-rung price is the one a 500-jar job pays.
    const tierIndex = MIRON_TIER_MIN_QTYS.indexOf(500);
    const expected = MIRON_SET_COST["100ml_wide"]![tierIndex];
    const blank = lineOf(run(qs({ pqty: 500 })), "blank_sets")!;
    expect(blank.formula).toContain(expected.toFixed(4));

    // Chiron is flat at every quantity (owner rule).
    const chironFlat = CHIRON_SET_COST["150ml"]!;
    for (const quantity of [100, 5000]) {
      const line = lineOf(run(qs({ pjar: "chiron/150ml", pqty: quantity })), "blank_sets")!;
      expect(line.formula).toContain(chironFlat.toFixed(4));
    }

    // The plain oz jars price by VARIANT — clear and black/white differ.
    const clear = lineOf(run(qs({ pfamily: "standard-jars", pjar: "standard/3oz", pjarvariant: "clear" })), "blank_sets")!;
    const bw = lineOf(run(qs({ pfamily: "standard-jars", pjar: "standard/3oz", pjarvariant: "black_white" })), "blank_sets")!;
    expect(clear.formula).toContain(STANDARD_SET_COST["3oz"]!.clear.toFixed(4));
    expect(bw.formula).toContain(STANDARD_SET_COST["3oz"]!.black_white.toFixed(4));
    expect(bw.amount).toBeGreaterThan(clear.amount);
  });
});

describe("2D-4D1 — the physical jar is charged ONCE", () => {
  it("buys one complete set per jar produced, not one per label", () => {
    const oneLabel = run(qs({ pjarlid: "" }));
    const threeLabels = run(qs({ pjartamper: "1" }));
    expect(lineOf(oneLabel, "blank_sets")!.amount).toBe(lineOf(threeLabels, "blank_sets")!.amount);
    expect(threeLabels.diagnostics.applicationsPerItem).toBe(3);
  });

  it("applies the owner's 1% planned overage by producing more, not by charging twice", () => {
    const result = run(qs({ pqty: 500 }));
    const produced = Math.ceil(500 * (1 + JAR_PLANNED_OVERAGE_PCT / 100));
    expect(lineOf(result, "blank_sets")!.formula).toContain(`${produced} x $`);
    expect(lineOf(result, "planned_overage")!.amount).toBe(0);
    // Packout ships the FINISHED jars, so it never inherits the overage.
    expect(lineOf(result, "packout")!.formula).toContain("500");
  });

  it("lets an explicit overage field override the family standard", () => {
    expect(lineOf(run(qs({ poverage: 0 })), "blank_sets")!.formula).toContain("500 x $");
    expect(lineOf(run(qs({ poverage: 10 })), "blank_sets")!.formula).toContain("550 x $");
  });
});

describe("2D-4D1 — jar setup keeps its own bases", () => {
  it("charges art PER DESIGN and print ONCE PER JOB, at the OWNER rates", () => {
    const sideLid = run(qs());
    expect(lineOf(sideLid, "art_setup")!.basis).toBe("PER_DESIGN");
    expect(lineOf(sideLid, "art_setup")!.amount).toBeCloseTo(JAR_ART_SETUP_PER_DESIGN, 10);
    expect(lineOf(sideLid, "print_setup")!.basis).toBe("PER_JOB");
    expect(lineOf(sideLid, "print_setup")!.amount).toBeCloseTo(JAR_PRINT_SETUP_PER_JOB, 10);
    expect(sideLid.diagnostics.artSetupEvents).toBe(1);   // side + lid is ONE design
    expect(sideLid.diagnostics.printSetupEvents).toBe(1); // two physical runs, one job

    // 2D-4D2: the rates are the owner-verified globals; only the BASIS is
    // jar-specific. A second artwork is a second EVENT, not a flat surcharge.
    expect(JAR_ART_SETUP_PER_DESIGN).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 10);
    expect(JAR_PRINT_SETUP_PER_JOB).toBeCloseTo(OWNER_STANDARDS.printSetupPerDesign.value, 10);

    const withTamper = run(qs({ pjartamper: "1" }));
    expect(withTamper.diagnostics.artSetupEvents).toBe(2);
    expect(lineOf(withTamper, "art_setup")!.amount).toBeCloseTo(JAR_ART_SETUP_PER_DESIGN * 2, 10);
    expect(lineOf(withTamper, "print_setup")!.amount).toBeCloseTo(JAR_PRINT_SETUP_PER_JOB, 10);
    expect(withTamper.diagnostics.printSetupEvents).toBe(1);
  });

  it("never multiplies setup by the copy quantity", () => {
    const small = run(qs({ pqty: 100 }));
    const large = run(qs({ pqty: 10000 }));
    for (const key of ["art_setup", "print_setup"]) {
      expect(lineOf(large, key)!.amount, key).toBe(lineOf(small, key)!.amount);
    }
  });
});

describe("2D-4D1 — application is per label applied", () => {
  it("counts one event per selected label per FINISHED jar, at the size's owner timing", () => {
    const owner = JAR_APPLICATION_SECONDS_BY_SIZE["100ml_wide"];
    const cases: Array<[Record<string, string>, number, number]> = [
      [{ pjarlid: "" }, 1, owner.side],
      [{}, 2, owner.side + owner.lid],
      [{ pjartamper: "1" }, 3, owner.side + owner.lid + owner.tamper!],
    ];
    for (const [extra, perJar, seconds] of cases) {
      const result = run(qs(extra));
      expect(result.diagnostics.applicationsPerItem).toBe(perJar);
      expect(result.diagnostics.applicationEvents).toBe(500 * perJar);
      expect(result.diagnostics.physicalItems).toBe(500);
      // $20/hr on the OWNER seconds for THIS size — never a flat per-jar rate.
      expect(lineOf(result, "application")!.amount).toBeCloseTo(500 * (seconds / 3600) * 20, 6);
    }
  });

  it("2D-4D2: application labor differs by SIZE, which a flat rate could not do", () => {
    const at = (family: string, key: string) =>
      lineOf(run(qs({ pfamily: family, pjar: key, pjarvariant: key.startsWith("standard/") ? "clear" : "" })), "application")!.amount;
    // 250ml takes longer to wrap than a 3oz jar; the old flat 45/22 could not
    // express that at all.
    expect(at("premium-jars", "miron/250ml")).toBeGreaterThan(at("premium-jars", "miron/150ml"));
    expect(at("premium-jars", "miron/150ml")).toBeGreaterThan(at("premium-jars", "miron/100ml_wide"));
    expect(at("premium-jars", "miron/100ml_wide")).toBeGreaterThan(at("standard-jars", "standard/3oz"));
    // and every figure traces to the owner table, not to a constant in code
    for (const [key, family] of [["miron/250ml", "premium-jars"], ["standard/4oz", "standard-jars"]] as const) {
      const size = key.split("/")[1] as keyof typeof JAR_APPLICATION_SECONDS_BY_SIZE;
      const o = JAR_APPLICATION_SECONDS_BY_SIZE[size];
      expect(at(family, key)).toBeCloseTo(500 * ((o.side + o.lid) / 3600) * 20, 6);
    }
  });

  it("2D-4D2: a tamper band on a 3oz/4oz jar BLOCKS — no timing is borrowed", () => {
    for (const key of ["standard/3oz", "standard/4oz"]) {
      const result = run(qs({ pfamily: "standard-jars", pjar: key, pjarvariant: "clear", pjartamper: "1" }));
      expect(result.status, key).toBe("DRAFT_ONLY");
      expect(result.unitCost, key).toBeNull();
      expect(result.blockers.join(" ")).toContain(CANONICAL_REASONS.applicationStandardRequired);
      // the same jar WITHOUT the band still costs normally
      const fine = run(qs({ pfamily: "standard-jars", pjar: key, pjarvariant: "clear" }));
      expect(fine.blockers, key).toHaveLength(0);
    }
  });
});

describe("2D-4D1 — everything outside the active scope fails closed", () => {
  const blocked = (params: URLSearchParams) => {
    const result = run(params);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();     // never 0 — a blocked job has NO cost
    expect(result.blockers.length).toBeGreaterThan(0);
    return result;
  };

  it("refuses a jar GSO does not offer, even though the tables know its geometry", () => {
    const result = blocked(qs({ pjar: "miron/4oz" }));
    expect(result.blockers.join(" ")).toContain(CANONICAL_REASONS.familyUnsupported);
    expect(result.reasons).toContain(CANONICAL_REASONS.familyUnsupported);
  });

  it("refuses an active jar quoted under the wrong family", () => {
    const result = blocked(qs({ pjar: "standard/4oz" }));  // standard jar, premium form
    expect(result.blockers.join(" ")).toContain("standard-jars");
  });

  it("refuses a size the geometry tables have never heard of, without throwing", () => {
    expect(() => blocked(qs({ pjar: "miron/900ml" }))).not.toThrow();
    expect(() => blocked(qs({ pjar: "" }))).not.toThrow();
  });

  it("refuses a label row the jar model cannot represent instead of dropping it", () => {
    const result = blocked(qs({ pjarunsupported: "neck,additional" }));
    expect(result.blockers.join(" ")).toContain(CANONICAL_REASONS.labelGeometryUnsupported);
    expect(result.blockers.join(" ")).toContain("neck");
  });

  it("refuses a jar job with nothing printed on it", () => {
    const result = blocked(qs({ pjarside: "", pjarlid: "" }));
    expect(result.blockers.join(" ")).toContain(CANONICAL_REASONS.noPrintedComponent);
  });
});

describe("2D-4D1 — a blocked jar can never be saved", () => {
  const decision = (params: URLSearchParams) => {
    const result = run(params);
    return {
      canonicalFamilyKey: String(params.get("pfamily")),
      baseCanonical: result,
      selectedCanonical: result,
      selectedQuantity: 500,
      selectedTierDraftOnly: result.status === "DRAFT_ONLY",
    };
  };

  it("writes the quote for an active, fully costed jar", async () => {
    let calls = 0;
    const outcome = await persistQuoteIfCanonicalAllows(decision(qs()), async () => { calls += 1; return { id: "q1" }; });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("never touches the database for a jar outside the active scope", async () => {
    for (const params of [qs({ pjar: "miron/4oz" }), qs({ pjarunsupported: "neck" }), qs({ pjar: "" })]) {
      let calls = 0;
      const outcome = await persistQuoteIfCanonicalAllows(decision(params), async () => { calls += 1; return { id: "q" }; });
      expect(outcome.ok, String(params)).toBe(false);
      expect(calls, "db.quote.create must not be called").toBe(0);
    }
  });

  it("publishes null money, not zero, for a blocked jar", () => {
    const authority = resolveCostAuthority({
      canonicalFamilyKey: "premium-jars",
      canonical: run(qs({ pjar: "miron/4oz" })),
      legacyJobCost: 9999,     // a legacy number exists and must NOT be used
      quantity: 500,
      freightTotal: 0,
    });
    expect(isCostedAuthority(authority)).toBe(false);
    // Every money field is null BY TYPE — a blocked jar has no cost at all,
    // and there is no zero for a downstream gate to mistake for one.
    expect(authority.unitCost).toBeNull();
    expect(authority.completeCost).toBeNull();
    expect(authority.manufacturingJobCost).toBeNull();
    expect(authority.manufacturingUnitCost).toBeNull();
    expect(canonicalSaveGate({ canonicalFamilyKey: "premium-jars", canonical: run(qs({ pjar: "miron/4oz" })) }).allowed).toBe(false);
  });
});

describe("2D-4D1 — the calculator form emits the canonical jar descriptor", () => {
  it("mirrors the operator's jar pick into the fields the normaliser reads", () => {
    const src = routeSrc();
    for (const field of ["pjar", "pjarvariant", "pjarside", "pjarlid", "pjartamper", "pjarunsupported"]) {
      expect(src, `form must emit ${field}`).toContain(`name="${field}"`);
    }
    // The descriptor rides on the server-tagged option — the client never
    // re-derives which jar a DB row is.
    expect(src).toContain("jarProfile: resolveActiveJarProfile(entry.item.name)?.key");
    expect(src).toContain("jarVariant: resolveActiveJarVariant(entry.item.name)");
  });

  it("shows staff only the jars that are actually offered", () => {
    const src = routeSrc();
    expect(src).toMatch(/pFamily === "standard-jars"\) return [^\n]*resolveActiveJarProfile\(entry\.item\.name\)\?\.uiFamily === "standard-jars"/);
    expect(src).toMatch(/pFamily === "premium-jars"\) return [^\n]*resolveActiveJarProfile\(entry\.item\.name\)\?\.uiFamily === "premium-jars"/);
  });

  it("reproduces the legacy label-row defaults so both engines see the same labels", () => {
    // buildLabelRows: 1 -> side, 2 -> side+lid, 3+ -> side+lid+additional...
    expect(routeSrc()).toContain('n === 1 ? ["side"] : n === 2 ? ["side", "lid"]');
  });
});

describe("2D-4D1 — the normaliser reads the jar descriptor", () => {
  it("carries brand, size, variant and selection through unchanged", () => {
    const input = normalizeCanonicalInput(qs({
      pfamily: "standard-jars", pjar: "standard/4oz", pjarvariant: "black_white", pjartamper: "1",
    }))!;
    expect(input.family).toBe("standard-jars");
    expect(input.jar).toEqual(expect.objectContaining({
      brand: "standard", size: "4oz", variant: "black_white",
      selection: { side: true, lid: true, tamper: true },
    }));
  });

  it("passes an unknown jar through as-is instead of defaulting to a neighbour", () => {
    const input = normalizeCanonicalInput(qs({ pjar: "miron/4oz" }))!;
    expect(input.jar!.size).toBe("4oz");
    expect(input.jar!.brand).toBe("miron");
  });
});

describe("2D-4D1 — jars supply their own packout and freight", () => {
  it("does not disclose packout or freight as unmodeled when the adapter supplies both", () => {
    const result = run(qs());
    expect(result.reasons).not.toContain(CANONICAL_REASONS.packoutNotModeled);
    expect(result.reasons).not.toContain(CANONICAL_REASONS.freightNotModeled);
    // per-size box counts + the consumables rate, not the shared $2.00 default
    expect(lineOf(result, "packout")!.formula).toMatch(/\$3\.50\/box/);
    expect(lineOf(result, "inbound_freight")!.amount).toBeGreaterThan(0);
  });

  it("still discloses the lid contour as a borrowed cut RATE, so a jar is PROVISIONAL not VALID", () => {
    const result = run(qs());
    expect(result.reasons).toContain("CUT_PATH_ESTIMATE_REQUIRED");
    expect(result.status).toBe("PROVISIONAL");
    // A side-only job has no circular lid, so the contour disclosure is
    // specific to what the job actually cuts — it is not a blanket label.
    expect(run(qs({ pjarlid: "" })).reasons).not.toContain("CUT_PATH_ESTIMATE_REQUIRED");
  });

  it("leaves the other canonical families' disclosures alone", () => {
    const banner = normalizeCanonicalInput(new URLSearchParams("pfamily=banners&pqty=1&pbannerw=36&pbannerh=60&pdesigns=1"))!;
    const result = assembleCanonicalJob(banner, CAL);
    // banners still have NO verified tube packout
    expect(result.reasons).toContain(CANONICAL_REASONS.packoutNotModeled);
    expect(result.reasons).toContain(CANONICAL_REASONS.freightNotModeled);
  });
});

/* ================================================================== *
 * 2D-4D2 — owner-standards reconciliation + Chiron selectability
 * ================================================================== */

describe("2D-4D2 — the jar authorities trace to owner records", () => {
  it("application seconds match the owner per-size timings, size for size", () => {
    // These are the timings the owner supplied and that are live in
    // RecipeLabelZone (seed-jar-label-zone-dimensions.mjs). The third column is
    // the optional band the zone rows call "Lid side label" and this module
    // calls "tamper" — same circumference width, same 0.5-0.6in height, both
    // optional, so the timing transfers.
    expect(JAR_APPLICATION_SECONDS_BY_SIZE).toEqual({
      "50ml": { side: 12, lid: 10, tamper: 12 },
      "100ml_tall": { side: 12, lid: 10, tamper: 12 },
      "100ml_wide": { side: 12, lid: 10, tamper: 12 },
      "150ml": { side: 13, lid: 10, tamper: 12 },
      "250ml": { side: 15, lid: 10, tamper: 12 },
      "3oz": { side: 10, lid: 8, tamper: null },
      "4oz": { side: 10, lid: 8, tamper: null },
    });
  });

  it("the retired flat 45/22/45 is gone from the cost path", () => {
    const src = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // no executable line may reintroduce the flat triple
    expect(code).not.toMatch(/side:\s*45/);
    expect(code).not.toMatch(/lid:\s*22/);
    // and nothing costs a jar from a size-blind constant
    expect(code).not.toMatch(/JAR_APPLICATION_SECONDS\s*=\s*\{/);
  });

  it("setup rates ARE the owner globals, not jar-local numbers", () => {
    expect(JAR_ART_SETUP_PER_DESIGN).toBe(OWNER_STANDARDS.artSetupPerDesign.value);
    expect(JAR_PRINT_SETUP_PER_JOB).toBe(OWNER_STANDARDS.printSetupPerDesign.value);
    expect(OWNER_STANDARDS.artSetupPerDesign.status).toBe("owner_verified");
    expect(OWNER_STANDARDS.printSetupPerDesign.status).toBe("owner_verified");
    // the retired figures are recorded so a silent revert is visible
    expect(JAR_SETUP_RETIRED_ASSUMPTIONS.artBaseDollars).toBe(12.5);
    expect(JAR_SETUP_RETIRED_ASSUMPTIONS.artTamperAddDollars).toBe(10);
    expect(JAR_SETUP_RETIRED_ASSUMPTIONS.printPerJobDollars).toBe(2);
  });

  it("setup is still quantity-independent at 100 and at 10,000", () => {
    const small = run(qs({ pqty: 100 }));
    const large = run(qs({ pqty: 10000 }));
    for (const key of ["art_setup", "print_setup"]) {
      expect(lineOf(large, key)!.amount, key).toBe(lineOf(small, key)!.amount);
    }
    expect(lineOf(small, "art_setup")!.amount).toBeCloseTo(OWNER_STANDARDS.artSetupPerDesign.value, 10);
    expect(lineOf(small, "print_setup")!.amount).toBeCloseTo(OWNER_STANDARDS.printSetupPerDesign.value, 10);
  });
});

describe("2D-4D3 — the 1% overage is OWNER-VERIFIED and lives in the decision authority", () => {
  it("reads from OWNER_STANDARDS, not from a constant this module asserts", () => {
    expect(OWNER_STANDARDS.jarPlannedOveragePct.value).toBe(1);
    expect(OWNER_STANDARDS.jarPlannedOveragePct.status).toBe("owner_verified");
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(OWNER_STANDARDS.jarPlannedOveragePct.value);
    expect(JAR_PLANNED_OVERAGE_PROVENANCE.status).toBe("OWNER_VERIFIED");
    expect(JAR_PLANNED_OVERAGE_PROVENANCE.ownerRecord).toBe("OWNER_STANDARDS.jarPlannedOveragePct");
    // the cost path must not re-type the number anywhere
    const code = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8")
      .split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(code).toContain("JAR_PLANNED_OVERAGE_PCT = OWNER_STANDARDS.jarPlannedOveragePct.value");
  });

  it("carries NO disclosure any more — the decision was made, not re-warned", () => {
    const result = run(qs({ pqty: 500 }));
    expect(result.reasons.join(" ")).not.toMatch(/OVERAGE/i);
    // and nothing quietly replaced it with a different warning
    expect(Object.values(CANONICAL_REASONS).join(" ")).not.toMatch(/OVERAGE/i);
  });

  it("pins the owner arithmetic: 500 -> 505 and 1000 -> 1010", () => {
    for (const [finished, produced] of [[500, 505], [1000, 1010]] as const) {
      const result = run(qs({ pqty: finished }));
      expect(productionQtyFor(finished), String(finished)).toBe(produced);
      // the blank line is the one that literally prints the produced count
      expect(lineOf(result, "blank_sets")!.formula, String(finished)).toContain(`${produced} x $`);
      expect(lineOf(result, "planned_overage")!.label).toContain(`${finished} finished -> ${produced} produced`);
    }
  });

  it("is exactly 1% — never compounded and never applied twice", () => {
    const finished = 1000;
    const produced = productionQtyFor(finished);
    expect(produced).toBe(1010);
    // 1% applied twice would be 1020 (or 1020.1 -> 1021 compounded); neither.
    expect(produced).not.toBe(1020);
    expect(produced).not.toBe(Math.ceil(finished * 1.01 * 1.01));
    // applying the helper to its own output would compound — prove the engine
    // never does that by checking the ratio the job actually charged.
    const result = run(qs({ pqty: finished }));
    const blank = lineOf(result, "blank_sets")!;
    const perSet = Number(blank.formula!.split(" x $")[1]);
    expect(blank.amount / perSet).toBeCloseTo(produced, 6);
    // and the overage is never ALSO a line item
    expect(lineOf(result, "planned_overage")!.amount).toBe(0);
  });

  it("raises produced-quantity inputs only — packout still ships finished jars", () => {
    const result = run(qs({ pqty: 500 }));
    // blanks + freight follow PRODUCED
    expect(lineOf(result, "blank_sets")!.formula).toContain("505 x $");
    expect(lineOf(result, "inbound_freight")!.formula).toContain("505 x $");
    // packout follows FINISHED — boxes ship what the customer receives
    expect(lineOf(result, "packout")!.formula).toContain("500");
    expect(lineOf(result, "packout")!.formula).not.toContain("505");
    // application labor is per finished jar, never per produced jar
    expect(result.diagnostics.physicalItems).toBe(500);
    expect(result.diagnostics.applicationEvents).toBe(1000); // side + lid on 500
  });

  it("an operator may still override it, and zero really means zero", () => {
    expect(lineOf(run(qs({ poverage: 0 })), "blank_sets")!.formula).toContain("500 x $");
    expect(lineOf(run(qs({ poverage: 10 })), "blank_sets")!.formula).toContain("550 x $");
  });
});

describe("2D-4D3 — Chiron 100ml tall is OWNER-VERIFIED at $1.80", () => {
  it("records its own provenance rather than inheriting 100ml wide's", () => {
    expect(CHIRON_SET_COST["100ml_tall"]).toBe(1.8);
    expect(CHIRON_SET_COST_PROVENANCE["100ml_tall"]).toEqual({
      status: "OWNER_VERIFIED",
      record: "Owner confirmation, 2026-08-25 (2D-4D3)",
    });
    // the other two keep the older record — this patch did not touch them
    expect(CHIRON_SET_COST["100ml_wide"]).toBe(1.8);
    expect(CHIRON_SET_COST["150ml"]).toBe(1.9);
    expect(CHIRON_SET_COST_PROVENANCE["100ml_wide"]!.record).toContain("14C.2A");
    expect(CHIRON_SET_COST_PROVENANCE["150ml"]!.record).toContain("14C.2A");
    // 50ml stays deliberately absent and must still block
    expect(CHIRON_SET_COST["50ml"]).toBeUndefined();
  });

  it("resolves a real cost and names where it came from", () => {
    const resolved = resolveJarBlankCost({ brand: "chiron", size: "100ml_tall", quantity: 505 });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.unitCost).toBe(1.8);
    expect(resolved.ok && resolved.source).toContain("2026-08-25");
    // flat at every quantity, which is the Chiron owner rule
    for (const quantity of [1, 100, 10000]) {
      const at = resolveJarBlankCost({ brand: "chiron", size: "100ml_tall", quantity });
      expect(at.ok && at.unitCost, String(quantity)).toBe(1.8);
    }
  });

  it("the canonical cost path does not read the VendorProduct price", () => {
    // The row exists for the picker and the legacy panel. The canonical blank
    // cost comes from CHIRON_SET_COST, so a jar costs the same whether or not
    // that row has been seeded yet.
    const result = run(qs({ pjar: "chiron/100ml_tall" }));
    expect(result.blockers).toHaveLength(0);
    expect(lineOf(result, "blank_sets")!.formula).toContain("$1.8000");
  });
});

describe("2D-4D2 — Chiron 100ml tall becomes selectable", () => {
  const TOOL = "tools/seed-chiron-100ml-tall-2d4d2.mjs";

  it("the name the seed writes resolves to exactly that profile", () => {
    const profile = resolveActiveJarProfile("Chiron 100 ml tall");
    expect(profile?.key).toBe("chiron/100ml_tall");
    expect(profile?.uiFamily).toBe("premium-jars");
    // and it does not steal the existing 100ml wide row
    expect(resolveActiveJarProfile("Chiron 100 ml")?.key).toBe("chiron/100ml_wide");
  });

  it("the seed is dry-run by default and create-only", () => {
    const src = readFileSync(TOOL, "utf8");
    expect(src).toContain('const APPLY = args.includes("--apply");');
    expect(src).toContain('if (!APPLY) {');
    // scoped to the production shop, never a parameter
    expect(src).toContain('const SHOP = "942075-2.myshopify.com";');
    // create-if-missing only: no update/delete/upsert verb anywhere
    expect(src).not.toMatch(/vendorProduct\.(update|updateMany|delete|deleteMany|upsert)/);
    expect(src).not.toMatch(/vendorProductTier\.(create|update|delete|deleteMany)/);
    expect(src.match(/vendorProduct\.create/g)).toHaveLength(1);
    // 2D-4D3: the owner-approved cost is encoded and VALIDATED, so a typo at
    // apply time is refused rather than written.
    expect(src).toContain("OWNER_APPROVED_UNIT_COST = 1.8");
    expect(src).toContain("REFUSING");
  });

  it("the seed does not become a cost authority", () => {
    // EXECUTABLE lines only — the header explains what the script must not
    // do, and naming CHIRON_SET_COST there is the explanation, not a lookup.
    const code = readFileSync(TOOL, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    // It may NAME the cost table when telling the operator where the real
    // cost lives; what it must never do is read a value out of it.
    expect(code).not.toMatch(/CHIRON_SET_COST\s*[[.]/);
    expect(code).not.toMatch(/import .*jar-cost-inputs/);
    // the only price it writes is the one the owner passed in
    expect(code).toContain("defaultUnitCost: unitCost");
  });
});

describe("2D-4D3 — the legitimate PROVISIONAL disclosures survive the lock", () => {
  it("keeps the contour cut-rate and provisional freight disclosures", () => {
    const result = run(qs());
    // A jar is PROVISIONAL for real reasons, not because a figure is unverified.
    expect(result.status).toBe("PROVISIONAL");
    expect(result.reasons).toContain("CUT_PATH_ESTIMATE_REQUIRED");

    const provisional = result.trueCost.lines.filter((line) => line.provisional);
    const keys = provisional.map((line) => line.key);
    expect(keys).toContain("inbound_freight");
    expect(keys).toContain("cutting_machine");
    expect(provisional.find((line) => line.key === "inbound_freight")!.provisional)
      .toMatch(/PROVISIONAL_SUPPLIER_PALLET/);
    // the contour disclosure says the LENGTH is exact and only the RATE is borrowed
    expect(provisional.find((line) => line.key === "cutting_machine")!.provisional)
      .toMatch(/LENGTH is exact geometry, the RATE is borrowed/);
  });

  it("does not mark a jar VALID just because the overage got verified", () => {
    for (const profile of ACTIVE_JAR_PROFILES) {
      const result = run(qs({
        pfamily: profile.uiFamily,
        pjar: profile.key,
        pjarvariant: profile.brand === "standard" ? "clear" : "",
      }));
      expect(result.status, profile.label).toBe("PROVISIONAL");
      expect(result.blockers, profile.label).toHaveLength(0);   // still quotable
      expect(result.unitCost, profile.label).toBeGreaterThan(0);
    }
  });
});
