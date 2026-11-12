// 2026-11-11 OWNER CONFIRMATION — jar label geometry (Miron + Chiron).
//
//   100ml tall  side 6.3 x 3.15    lid 1.75 dia  tamper 6.3 x 0.5
//   100ml wide  side 6.6 x 2.6     lid 1.9 dia   tamper 6.6 x 0.5
//   150ml       side 7.125 x 3.125 lid 2.0 dia   tamper 7.125 x 0.6
//
// Chiron uses the SAME geometry as the equivalent Miron size. These sizes are
// OWNER_CONFIRMED (no "PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION" warning);
// the older RecipeLabelZone reference values (6.125 / 6.43 side, 1.875 lid,
// 0.5 tamper on 150ml) are superseded. The confirmed values already were the
// canonical cost geometry, so true cost is unchanged. Snapshots are immutable.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { JAR_LABEL_GEOMETRY, JAR_OWNER_CONFIRMED_GEOMETRY, jarGeometryAuthorityFor } from "../app/lib/jar-label-geometry";
import { JAR_REFERENCE_GEOMETRY, jarReferenceConflicts } from "../app/lib/jar-reference-geometry";
import { PENDING_CONFIRMATION_WARNING, getProductProductionSpec } from "../app/lib/product-production-spec";
import { enforceQuoteItemUnitCost } from "../app/lib/quote-item-cost-authority";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "c", shop: "t", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.89, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: 0, timeModel: "variable_only",
    coverageBasisPct: 100, measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "x", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved", inkCostPerMl: 0.2, inkCostSource: "x",
};
const job = (key: string, extra = "") =>
  assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(`pfamily=premium-jars&pjarmat=matte&pprinter=mimaki&pqty=500&pjar=${key}&pjarside=1&pjarlid=1&pjartamper=1&pcmykcoverage=40${extra}`))!, CAL);

const CONFIRMED = {
  "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
} as const;

describe("owner-confirmed jar label geometry (2026-11-11)", () => {
  for (const [size, geometry] of Object.entries(CONFIRMED)) {
    it(`1-3. ${size}: side ${geometry.side.widthIn} x ${geometry.side.heightIn}, lid ${geometry.lid.diameterIn}, tamper ${geometry.tamper.widthIn} x ${geometry.tamper.heightIn} — the cost engine's geometry`, () => {
      expect(JAR_OWNER_CONFIRMED_GEOMETRY[size as keyof typeof CONFIRMED]).toEqual(geometry);
      expect(JAR_LABEL_GEOMETRY[size as keyof typeof CONFIRMED]).toEqual(geometry); // the table every cost path reads
      for (const brand of ["miron", "chiron"]) {
        const r = job(`${brand}/${size}`);
        expect(r.unitCost, `${brand}/${size}`).not.toBeNull();
        expect(r.diagnostics.productSpec!.standard).toEqual(geometry);
      }
    });

    it(`${size}: true cost is driven by these dimensions (an explicit override with the same values costs identically; a different size does not)`, () => {
      const standard = job(`miron/${size}`);
      const same = job(`miron/${size}`, `&pjarcustom=1&pjarsidew=${geometry.side.widthIn}&pjarsideh=${geometry.side.heightIn}&pjaroverridereason=check`);
      const bigger = job(`miron/${size}`, `&pjarcustom=1&pjarsidew=${geometry.side.widthIn + 1}&pjarsideh=${geometry.side.heightIn}&pjaroverridereason=check`);
      expect(same.totalCost).toBeCloseTo(standard.totalCost, 6);
      expect(bigger.totalCost).toBeGreaterThan(standard.totalCost);
    });
  }

  it("4. Chiron and Miron equivalent sizes use identical geometry, specs and media/cut/application areas", () => {
    for (const size of Object.keys(CONFIRMED)) {
      const m = job(`miron/${size}`);
      const c = job(`chiron/${size}`);
      expect(c.diagnostics.productSpec!.standard).toEqual(m.diagnostics.productSpec!.standard);
      expect(c.diagnostics.inkableArtworkSqft).toBeCloseTo(m.diagnostics.inkableArtworkSqft!, 9);
      expect(c.diagnostics.mediaConsumedSqft).toBeCloseTo(m.diagnostics.mediaConsumedSqft!, 9);
      expect(c.diagnostics.cutPathIn).toBeCloseTo(m.diagnostics.cutPathIn!, 9);
      expect(c.diagnostics.applicationEvents).toBe(m.diagnostics.applicationEvents);
      expect(getProductProductionSpec("premium-jars", `chiron/${size}`)!.pieces).toEqual(getProductProductionSpec("premium-jars", `miron/${size}`)!.pieces);
    }
  });

  it("5. the owner-confirmation warning is gone for these sizes (and stays for unconfirmed ones)", () => {
    for (const size of Object.keys(CONFIRMED)) {
      for (const brand of ["miron", "chiron"]) {
        const spec = getProductProductionSpec("premium-jars", `${brand}/${size}`)!;
        expect(spec.authorityStatus).toBe("OWNER_CONFIRMED");
        expect(spec.ownerConfirmationRequired).toBe(false);
        expect(spec.authorityNote).not.toContain(PENDING_CONFIRMATION_WARNING);
        expect(spec.statusNote).toMatch(/Owner-confirmed physical label dimensions/);
      }
      expect(jarGeometryAuthorityFor(size)).toMatchObject({ authorityStatus: "OWNER_CONFIRMED", ownerConfirmationRequired: false });
    }
    for (const size of ["50ml", "250ml", "3oz", "4oz"]) {
      expect(jarGeometryAuthorityFor(size)).toMatchObject({ authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION", ownerConfirmationRequired: true });
    }
    expect(getProductProductionSpec("premium-jars", "miron/50ml")!.authorityNote).toContain(PENDING_CONFIRMATION_WARNING);
    // the calculator / product setup render the warning only when NOT confirmed
    expect(readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8")).toContain("{!confirmed ? <div style={{ color: \"#92400e\", fontWeight: 700 }}>{PENDING_CONFIRMATION_WARNING}</div> : null}");
    expect(readFileSync("app/routes/app.erp.product-setup.tsx", "utf8")).toContain('{!confirmed ? <p><span className="badge yellow">PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION</span></p> : null}');
  });

  it("6. old conflicting reference values (6.125 / 6.43 side, 1.875 lid, 0.5 tamper on 150ml) never override or conflict", () => {
    expect(JAR_REFERENCE_GEOMETRY["100ml_wide"]!.side.widthIn).toBe(6.43); // still on file as a superseded reference
    expect(JAR_REFERENCE_GEOMETRY["100ml_wide"]!.lid.diameterIn).toBe(1.875);
    for (const size of Object.keys(CONFIRMED) as Array<keyof typeof CONFIRMED>) {
      expect(jarReferenceConflicts(size, JAR_LABEL_GEOMETRY[size])).toEqual([]);
      expect(getProductProductionSpec("premium-jars", `miron/${size}`)!.conflictSummary).toBeNull();
      expect(job(`miron/${size}`).diagnostics.productSpec!.referenceConflict).toBe(false);
    }
    expect(job("miron/100ml_wide").diagnostics.productSpec!.standard!.side.widthIn).toBe(6.6);
    expect(job("miron/100ml_wide").diagnostics.productSpec!.standard!.lid.diameterIn).toBe(1.9);
  });

  it("7. a historical saved quote keeps its saved cost and its stored (pending) authority text", () => {
    const old = JSON.stringify({ canonical: { family: "premium-jars", status: "PROVISIONAL", unitCost: 3.1234, totalCost: 1561.7, quantity: 500, diagnostics: { productSpec: { productKey: "miron/100ml_wide", authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION", referenceConflicts: ["side label width 6.43 in (current quote uses 6.6 in)"] } } } });
    const decision: any = enforceQuoteItemUnitCost({ unitCost: 0.5, quantity: 500, costSnapshot: old, productName: "Miron 100ml" });
    expect(decision).toMatchObject({ protected: true, ok: true, unitCost: 3.1234 });
    expect(JSON.parse(old).canonical.diagnostics.productSpec.authorityStatus).toBe("CANONICAL_COSTING_PENDING_CONFIRMATION");
  });
});
