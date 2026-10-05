// 2026-10-05 RELEASE GATE — costing geometry is NOT a confirmed production spec.
//
// The fixed-product UI must never promote the Patch 2A costing geometry into
// an "owner-confirmed standard production spec". These tests pin the authority
// semantics (OWNER_CONFIRMED / CANONICAL_COSTING_PENDING_CONFIRMATION /
// UNSUPPORTED), the snapshot metadata, the Chiron and 5oz rules, the
// reference-conflict disclosure, and — above all — that none of it changed a
// single canonical cost.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  canonicalViewOf,
  normalizeCanonicalInput,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { ACTIVE_JAR_PROFILES } from "../app/lib/jar-active-scope";
import { JAR_LABEL_GEOMETRY, JAR_LABEL_GEOMETRY_AUTHORITY, type JarSizeKey } from "../app/lib/jar-label-geometry";
import { JAR_REFERENCE_GEOMETRY, jarReferenceConflicts } from "../app/lib/jar-reference-geometry";
import { JAR_APPLICATION_SECONDS_BY_SIZE, APPLICATION_LABOR_RATE_PER_HOUR } from "../app/lib/jar-cost-inputs.server";
import { WEEDING_STANDARD } from "../app/lib/weeding-standard";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { AUTHORITY_LABEL, LABEL_SETS, PENDING_CONFIRMATION_WARNING, describeStandardSpec, getProductProductionSpec, listProductSpecs } from "../app/lib/product-production-spec";

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
const jarQs = (key: string, set: { side: boolean; lid: boolean; tamper: boolean }, extra = "") => {
  const p = ACTIVE_JAR_PROFILES.find((x) => x.key === key)!;
  return `pfamily=${p.uiFamily}&pqty=200&pjar=${key}${p.brand === "standard" ? "&pjarvariant=black_white" : ""}${set.side ? "&pjarside=1" : ""}${set.lid ? "&pjarlid=1" : ""}${set.tamper ? "&pjartamper=1" : ""}&pcmykcoverage=40${extra}`;
};

/* ------------------------------------------------------------------ */
describe("authority statuses", () => {
  it("the Patch 2A table is explicitly PENDING confirmation with no owner record", () => {
    expect(JAR_LABEL_GEOMETRY_AUTHORITY.authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
    expect(JAR_LABEL_GEOMETRY_AUTHORITY.ownerConfirmationRequired).toBe(true);
    expect(JAR_LABEL_GEOMETRY_AUTHORITY.ownerRecord).toBeNull();
    expect(JAR_LABEL_GEOMETRY_AUTHORITY.introducedIn).toMatch(/5246607/);
  });

  it("every supported jar is PENDING, never OWNER_CONFIRMED; bags are the only OWNER_CONFIRMED specs", () => {
    for (const spec of listProductSpecs()) {
      if (spec.family.endsWith("-jars")) {
        expect(spec.authorityStatus, spec.productKey).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
        expect(spec.ownerConfirmationRequired, spec.productKey).toBe(true);
        expect(spec.authorityNote, spec.productKey).toContain(PENDING_CONFIRMATION_WARNING);
        expect(spec.authorityNote, spec.productKey).not.toMatch(/owner[- ]verified|owner[- ]confirmed dimensions/i);
      } else {
        expect(spec.authorityStatus, spec.productKey).toBe("OWNER_CONFIRMED");
        expect(spec.ownerConfirmationRequired).toBe(false);
      }
    }
    expect(listProductSpecs().filter((s) => s.authorityStatus === "OWNER_CONFIRMED").map((s) => s.productKey).sort()).toEqual(["bag-4x5/sticker", "bag-4x5/stock"]);
  });

  it("labels: OWNER_CONFIRMED = STANDARD PRODUCTION SPEC; pending = CURRENT CANONICAL COSTING GEOMETRY; unsupported = NOT CONFIRMED", () => {
    expect(AUTHORITY_LABEL.OWNER_CONFIRMED).toBe("STANDARD PRODUCTION SPEC");
    expect(AUTHORITY_LABEL.CANONICAL_COSTING_PENDING_CONFIRMATION).toBe("CURRENT CANONICAL COSTING GEOMETRY");
    expect(AUTHORITY_LABEL.UNSUPPORTED).toBe("STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED");
    expect(PENDING_CONFIRMATION_WARNING).toBe("PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION");
  });
});

/* ------------------------------------------------------------------ */
describe("reference conflicts (RecipeLabelZone) are disclosed, never merged", () => {
  it("reference table equals the seed, and no cost module imports it", () => {
    expect(JAR_REFERENCE_GEOMETRY["4oz"]!.side).toEqual({ widthIn: 7.125, heightIn: 2.125 });
    expect(JAR_REFERENCE_GEOMETRY["3oz"]!.side).toEqual({ widthIn: 7.1, heightIn: 1.7 });
    for (const file of ["app/lib/jar-cost-inputs.server.ts", "app/lib/canonical-calculator.server.ts", "app/lib/finishing-cost.server.ts", "app/lib/nesting-engine.server.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/jar-reference-geometry/);
    }
  });

  it("per-size conflicts match the audit; 150ml side/lid agree", () => {
    const c = (size: JarSizeKey) => jarReferenceConflicts(size, JAR_LABEL_GEOMETRY[size]).map((x) => `${x.piece}.${x.field}:${x.canonical}->${x.reference}`);
    expect(c("4oz")).toEqual(["side.heightIn:1.4->2.125"]);
    expect(c("3oz")).toEqual(["side.widthIn:6.9->7.1", "side.heightIn:1.4->1.7", "lid.diameterIn:2.1->2"]);
    expect(c("150ml")).toEqual(["tamper.heightIn:0.6->0.5"]);
    expect(c("50ml")).toEqual(["side.widthIn:5.6->5.75", "side.heightIn:1.5->1.625", "lid.diameterIn:1.6->1.75", "tamper.widthIn:5.6->5.75"]);
  });

  it("the spec carries a staff-readable conflict sentence", () => {
    const spec = getProductProductionSpec("standard-jars", "standard/4oz")!;
    expect(spec.referenceConflicts.length).toBe(1);
    expect(spec.conflictSummary).toBe("Reference setup lists a different side label height 2.125 in (current quote uses 1.4 in). Current quote uses the existing canonical cost-engine geometry.");
  });

  it("neither table was changed to reconcile the other", () => {
    expect(JAR_LABEL_GEOMETRY["4oz"].side).toEqual({ widthIn: 7.125, heightIn: 1.4 });
    expect(JAR_REFERENCE_GEOMETRY["4oz"]!.side.heightIn).toBe(2.125);
  });
});

/* ------------------------------------------------------------------ */
describe("quoting behaviour for pending confirmation", () => {
  it("Miron pending geometry auto-resolves and prices (not blocked), with the warning in the snapshot", () => {
    const r = run(jarQs("miron/100ml_wide", { side: true, lid: true, tamper: false }));
    expect(r.status).toBe("PROVISIONAL");
    expect(r.unitCost).not.toBeNull();
    expect(r.reasons).not.toContain("STANDARD_PRODUCTION_DIMENSIONS_NOT_CONFIRMED");
    expect(r.diagnostics.productSpec).toMatchObject({
      authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION",
      ownerConfirmationRequired: true,
      referenceConflict: true,
      standard: { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 } },
    });
    expect(r.diagnostics.productSpec!.referenceConflicts).toEqual([
      "side label width 6.43 in (current quote uses 6.6 in)",
      "lid label diameter 1.875 in (current quote uses 1.9 in)",
    ]);
  });

  it("conflict indicator is scoped to the SELECTED pieces (4oz Lid Only has no lid conflict)", () => {
    const lidOnly = run(jarQs("standard/4oz", { side: false, lid: true, tamper: false }));
    expect(lidOnly.diagnostics.productSpec!.referenceConflict).toBe(false);
    expect(lidOnly.diagnostics.productSpec!.referenceConflicts).toEqual([]);
    const sideOnly = run(jarQs("standard/4oz", { side: true, lid: false, tamper: false }));
    expect(sideOnly.diagnostics.productSpec!.referenceConflict).toBe(true);
  });

  it("custom override still works on pending geometry and is recorded alongside the authority status", () => {
    const r = run(jarQs("miron/100ml_wide", { side: true, lid: true, tamper: false }, "&pjarcustom=1&pjarsidew=6.43&pjarsideh=2.6&pjaroverridereason=reference"));
    expect(r.blockers).toEqual([]);
    expect(r.diagnostics.productSpec).toMatchObject({ customSize: true, overriddenPieces: ["side"], authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION", overrideReason: "reference" });
  });

  it("unknown / 5oz / out-of-scope products still fail closed and have no spec", () => {
    for (const q of [
      "pfamily=standard-jars&pqty=100&pjar=standard/5oz&pjarside=1&pcmykcoverage=40",
      "pfamily=standard-jars&pqty=100&pjar=jar_5oz_clear&pjarside=1&pcmykcoverage=40",
      "pfamily=premium-jars&pqty=100&pjar=chiron/50ml&pjarside=1&pcmykcoverage=40",
      "pfamily=premium-jars&pqty=100&pjar=chiron/250ml&pjarside=1&pcmykcoverage=40",
      "pfamily=premium-jars&pqty=100&pjarside=1&pcmykcoverage=40",
    ]) {
      const r = run(q);
      expect(r.status, q).toBe("DRAFT_ONLY");
      expect(r.unitCost, q).toBeNull();
    }
    expect(getProductProductionSpec("standard-jars", "standard/5oz")).toBeNull();
    expect(getProductProductionSpec("standard-jars", "jar_5oz_clear")).toBeNull();
    expect(listProductSpecs().some((s) => /5oz/i.test(s.productKey) || /5oz/i.test(s.displayName))).toBe(false);
    expect(describeStandardSpec({ ...getProductProductionSpec("premium-jars", "miron/50ml")!, authorityStatus: "UNSUPPORTED" })).toBe("STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED");
  });
});

/* ------------------------------------------------------------------ */
describe("Chiron hardening", () => {
  const chiron = ACTIVE_JAR_PROFILES.filter((p) => p.brand === "chiron");

  it("exactly the three active Chiron profiles exist and no others resolve", () => {
    expect(chiron.map((p) => p.key).sort()).toEqual(["chiron/100ml_tall", "chiron/100ml_wide", "chiron/150ml"]);
  });

  it("every Chiron spec is pending, requires confirmation, and names the shared size key", () => {
    for (const p of chiron) {
      const spec = getProductProductionSpec("premium-jars", p.key)!;
      expect(spec.authorityStatus, p.key).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
      expect(spec.ownerConfirmationRequired, p.key).toBe(true);
      expect(spec.sharedSizeKeyNote, p.key).toMatch(/shared "\w+" size key/);
      expect(spec.sharedSizeKeyNote, p.key).toMatch(/no Chiron-specific label geometry/);
      expect(spec.authorityNote).toContain("Not owner-confirmed");
      expect(spec.authorityNote).not.toMatch(/STANDARD PRODUCTION SPEC|^OWNER_CONFIRMED/);
      const r = run(jarQs(p.key, { side: true, lid: true, tamper: false }));
      expect(r.diagnostics.productSpec!.authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
      expect(r.diagnostics.productSpec!.sharedSizeKeyNote).toMatch(/shared/);
      expect(r.diagnostics.productSpec!.override).toEqual({});
    }
    // Miron specs carry no shared-key note
    expect(getProductProductionSpec("premium-jars", "miron/150ml")!.sharedSizeKeyNote).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
describe("snapshot / historical safety", () => {
  it("the canonical view carries every required authority field and JSON round-trips", () => {
    const view = canonicalViewOf(run(jarQs("standard/3oz", { side: true, lid: true, tamper: false }, "&pjarset=side_lid")));
    const stored = JSON.parse(JSON.stringify(view)).diagnostics.productSpec;
    expect(Object.keys(stored).sort()).toEqual([
      "authorityStatus", "customSize", "displayName", "family", "labelSet", "overriddenPieces", "override", "overrideReason",
      "ownerConfirmationRequired", "productKey", "referenceConflict", "referenceConflicts", "sharedSizeKeyNote", "source", "specVersion", "standard",
    ]);
    expect(stored.labelSet).toBe("side_lid");
    expect(stored.productKey).toBe("standard/3oz");
    expect(stored.authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
    expect(stored.referenceConflict).toBe(true);
  });

  it("an older snapshot without the authority fields is treated as unknown authority, never as confirmed", () => {
    const old = JSON.parse(JSON.stringify({ productSpec: { specVersion: "product-production-spec/1.0.0-2026-10-05", productKey: "miron/50ml", standard: { side: { widthIn: 5.6, heightIn: 1.5 } }, customSize: false, override: {}, overriddenPieces: [], overrideReason: null } }));
    expect(old.productSpec.authorityStatus).toBeUndefined();
    expect(old.productSpec.authorityStatus === "OWNER_CONFIRMED").toBe(false);
    // the UI labels this case explicitly (pinned in source)
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src).toContain("DIMENSION AUTHORITY NOT RECORDED (older snapshot)");
    expect(src).toContain("COSTING GEOMETRY — OWNER CONFIRMATION PENDING");
  });
});

/* ------------------------------------------------------------------ */
describe("UI copy never outruns the evidence", () => {
  const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
  const setup = readFileSync("app/routes/app.erp.product-setup.tsx", "utf8");
  const verify = readFileSync("app/routes/app.erp.cost-verification.tsx", "utf8");

  it("the calculator spec box renders the authority label, green only when OWNER_CONFIRMED", () => {
    expect(calc).toContain("{AUTHORITY_LABEL[jarSpec.authorityStatus]}: {jarSpec.displayName}");
    expect(calc).toContain('const confirmed = jarSpec?.authorityStatus === "OWNER_CONFIRMED";');
    expect(calc).toContain("{!confirmed ? <div style={{ color: \"#92400e\", fontWeight: 700 }}>{PENDING_CONFIRMATION_WARNING}</div> : null}");
    expect(calc).toContain("Reference setup contains a different");
    expect(calc).not.toContain("<b>STANDARD PRODUCTION SPEC: {jarSpec.displayName}</b>");
  });

  it("Product Setup and Cost Verification do not call pending geometry a confirmed or verified spec", () => {
    expect(setup).toContain("Current canonical costing geometry (read-only)");
    expect(setup).toContain("PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION");
    expect(setup).not.toContain("Production spec used by the cost engine (read-only)");
    expect(verify).toContain("costing geometry — owner confirmation pending");
    expect(verify).not.toContain('"cost authority" : "OWNER CONFIRMATION REQUIRED"');
  });

  it("the geometry source string no longer asserts 'owner presets'", () => {
    expect(readFileSync("app/lib/jar-label-geometry.ts", "utf8")).not.toMatch(/JAR_LABEL_GEOMETRY_SOURCE = "[^"]*owner presets/);
  });
});

/* ------------------------------------------------------------------ */
describe("ZERO cost change: 30 jar fixtures, control case, weeding and application numbers", () => {
  it("every supported jar x label set totals and lines equal the pre-gate capture", () => {
    const before = JSON.parse(readFileSync("tests/fixtures/jar-fixtures-2026-10-05.json", "utf8"));
    for (const p of ACTIVE_JAR_PROFILES) for (const s of LABEL_SETS) {
      const r = run(jarQs(p.key, s.selection));
      const key = `${p.key}/${s.key}`;
      expect(before[key], key).toBeDefined();
      expect(r.status, key).toBe(before[key].status);
      expect(r.totalCost, key).toBeCloseTo(before[key].total, 9);
      expect(r.unitCost, key).toBeCloseTo(before[key].unit, 9);
      expect(r.trueCost.lines.map((l) => [l.key, l.amount]), key).toEqual(before[key].lines);
    }
    expect(Object.keys(before).length).toBe(ACTIVE_JAR_PROFILES.length * LABEL_SETS.length);
  });

  it("weeding and application numbers are frozen", () => {
    expect(WEEDING_STANDARD.laborRatePerHour).toBe(20);
    expect(WEEDING_STANDARD.pagesPerHour).toBe(15);
    expect(WEEDING_STANDARD.costPerPage).toBeCloseTo(20 / 15, 12);
    expect(WEEDING_STANDARD.pageLengthIn).toBe(54);
    expect(OWNER_STANDARDS.weedingPerPage54x54.value).toBeCloseTo(20 / 15, 12);
    expect(APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(JAR_APPLICATION_SECONDS_BY_SIZE).toEqual({
      "50ml": { side: 12, lid: 10, tamper: 12 }, "100ml_tall": { side: 12, lid: 10, tamper: 12 }, "100ml_wide": { side: 12, lid: 10, tamper: 12 },
      "150ml": { side: 13, lid: 10, tamper: 12 }, "250ml": { side: 15, lid: 10, tamper: 12 }, "3oz": { side: 10, lid: 8, tamper: null }, "4oz": { side: 10, lid: 8, tamper: null },
    });
    expect(OWNER_STANDARDS.jarApplicationPerLabel.value).toBeCloseTo(0.2, 12);
  });
});
