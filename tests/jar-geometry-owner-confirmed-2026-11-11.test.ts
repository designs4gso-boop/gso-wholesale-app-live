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
import { JAR_LABEL_GEOMETRY, JAR_OWNER_CONFIRMED_GEOMETRY, formatJarCutline, formatJarGeometry, jarCutlineFor, jarGeometryAuthorityFor } from "../app/lib/jar-label-geometry";
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

// 2026-11-11 owner clarification: the confirmed dimensions are the LABEL / ART
// size; the CUTLINE is label - 0.125 in per dimension (lid diameter - 0.125).
const ART_AND_CUT: Array<{ key: string; family: string; art: any; cut: any }> = [
  { key: "standard/4oz", family: "standard-jars", art: { side: [7.125, 2.125], lid: 2.16, band: [7.125, 0.5] }, cut: { side: [7.0, 2.0], lid: 2.035, band: [7.0, 0.375] } },
  { key: "standard/3oz", family: "standard-jars", art: { side: [7.06, 1.7], lid: 2.0, band: [7.06, 0.5] }, cut: { side: [6.935, 1.575], lid: 1.875, band: [6.935, 0.375] } },
  { key: "miron/250ml", family: "premium-jars", art: { side: [9.375, 2.875], lid: 2.02, band: [9.375, 0.5] }, cut: { side: [9.25, 2.75], lid: 1.895, band: [9.25, 0.375] } },
  { key: "miron/100ml_tall", family: "premium-jars", art: { side: [6.3, 3.15], lid: 1.75, band: [6.3, 0.5] }, cut: { side: [6.175, 3.025], lid: 1.625, band: [6.175, 0.375] } },
  { key: "miron/100ml_wide", family: "premium-jars", art: { side: [6.6, 2.6], lid: 1.9, band: [6.6, 0.5] }, cut: { side: [6.475, 2.475], lid: 1.775, band: [6.475, 0.375] } },
  { key: "miron/150ml", family: "premium-jars", art: { side: [7.125, 3.125], lid: 2.0, band: [7.125, 0.6] }, cut: { side: [7.0, 3.0], lid: 1.875, band: [7.0, 0.475] } },
];
const sideJob = (key: string, family: string, qty = 500) =>
  assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(`pfamily=${family}&pjarmat=matte&pprinter=mimaki&pqty=${qty}&pjar=${key}${family === "standard-jars" ? "&pjarvariant=black_white" : ""}&pjarside=1&pcmykcoverage=40`))!, CAL);

describe("LABEL / ART size and CUTLINE are separate values (owner clarification 2026-11-11)", () => {
  for (const { key, family, art, cut } of ART_AND_CUT) {
    it(`${key}: art side ${art.side.join(" x ")} / lid ${art.lid} / band ${art.band.join(" x ")}; cutline side ${cut.side.join(" x ")} / lid ${cut.lid} / band ${cut.band.join(" x ")}`, () => {
      const size = key.split("/")[1] as keyof typeof JAR_LABEL_GEOMETRY;
      const g = JAR_LABEL_GEOMETRY[size];
      // the stored geometry is the ART size, never overwritten with the cutline
      expect(g).toEqual({ side: { widthIn: art.side[0], heightIn: art.side[1] }, lid: { diameterIn: art.lid }, tamper: { widthIn: art.band[0], heightIn: art.band[1] } });
      const c = jarCutlineFor(g);
      expect(c.side!.cutWidthIn).toBeCloseTo(cut.side[0], 9);
      expect(c.side!.cutHeightIn).toBeCloseTo(cut.side[1], 9);
      expect(c.lid!.cutDiameterIn).toBeCloseTo(cut.lid, 9);
      expect(c.tamper!.cutWidthIn).toBeCloseTo(cut.band[0], 9);
      expect(c.tamper!.cutHeightIn).toBeCloseTo(cut.band[1], 9);
      expect(jarGeometryAuthorityFor(size).authorityStatus).toBe("OWNER_CONFIRMED");
      const spec = getProductProductionSpec(family, key)!;
      expect(spec.pieces.find((piece) => piece.piece === "side")).toMatchObject({ widthIn: art.side[0], heightIn: art.side[1] });
      expect((spec.pieces.find((piece) => piece.piece === "side") as any).cutWidthIn).toBeCloseTo(cut.side[0], 9);
      expect((spec.pieces.find((piece) => piece.piece === "lid") as any).cutDiameterIn).toBeCloseTo(cut.lid, 9);
      // the quote snapshot records both, separately
      const r = sideJob(key, family);
      expect(r.diagnostics.productSpec!.standard.side).toEqual({ widthIn: art.side[0], heightIn: art.side[1] });
      expect(r.diagnostics.productSpec!.cutline!.side!.cutWidthIn).toBeCloseTo(cut.side[0], 9);
      expect(r.diagnostics.productSpec!.cutline!.side!.cutHeightIn).toBeCloseTo(cut.side[1], 9);
    });

    it(`${key}: cut-path length uses the CUTLINE; artwork area uses the LABEL / ART size`, () => {
      const r = sideJob(key, family);
      const sets = Number(/^(\d+) x \$/.exec(r.trueCost.lines.find((l: any) => l.key === "blank_sets")!.formula as string)![1]);
      expect(r.diagnostics.cutPathIn).toBeCloseTo(sets * 2 * (cut.side[0] + cut.side[1]), 6);
      expect(r.diagnostics.cutPathIn).not.toBeCloseTo(sets * 2 * (art.side[0] + art.side[1]), 0);
      expect(r.diagnostics.inkableArtworkSqft).toBeCloseTo((sets * art.side[0] * art.side[1]) / 144, 6);
    });
  }

  it("the calculator shows both lines: label / art size and cutline", () => {
    const src = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
    expect(src).toContain("<b>Label / art size:</b> {formatJarGeometry(jarStandard, jarSelection)}");
    expect(src).toContain("<b>Cutline (label - 0.125 in):</b> {formatJarCutline(jarStandard, jarSelection)}");
    expect(formatJarCutline(JAR_LABEL_GEOMETRY["4oz"])).toBe("Side 7.000 x 2.000 in · Lid Ø 2.035 in · Tamper band 7.000 x 0.375 in");
    expect(formatJarGeometry(JAR_LABEL_GEOMETRY["4oz"])).toBe("Side 7.125 x 2.125 in · Lid Ø 2.16 in · Tamper band 7.125 x 0.5 in");
  });

  it("50ml stays pending owner confirmation", () => {
    expect(jarGeometryAuthorityFor("50ml")).toMatchObject({ authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION", ownerConfirmationRequired: true });
  });
});

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
    for (const size of ["50ml"]) {
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
