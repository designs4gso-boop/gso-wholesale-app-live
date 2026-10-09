// Patch 2D-4D — QUOTE READINESS: labels, bags, jars.
//
// Three things this sprint changed, and what each must keep true:
//
//   A. Labels    multi-line artwork identity is DECLARED per line, so two lines
//                of one artwork pay one art setup and two press setups. Every
//                normal label is cut; contour needs a MEASURED path length.
//   B. Bags      unchanged from 2D-4C2D, re-pinned here so a readiness sweep
//                cannot quietly regress the $0.09 base or the freight split.
//   C. Jars      cutlines are now DERIVED by the GSO offset rule, which removes
//                the one geometric blocker. That is NOT promotion: jars stay
//                CANONICAL_FAIL_CLOSED until the owner says otherwise, and
//                several profiles still lack a verified blank cost or freight.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BAG_4X5_ARTBOARD_IN, BAG_4X5_BLANK_UNIT_COST, BAG_4X5_CUTLINE_IN,
  BAG_APPLICATION_SECONDS_PER_SIDE, STOCK_BAG_MOQ, computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { computeLabelJob } from "../app/lib/label-cost-inputs.server";
import {
  JAR_ART_SETUP_PER_DESIGN, JAR_LABEL_GEOMETRY, JAR_PRINT_SETUP_PER_JOB,
  jarCutGeometry, jarFreightPerUnit, jarSetupCost, resolveJarBlankCost,
  type JarSizeKey,
} from "../app/lib/jar-cost-inputs.server";
import { deriveGsoLabelCutDiameter, deriveGsoLabelCutlineFromArtboard } from "../app/lib/gso-cutline";
import { canonicalSaveGate, familyCostModel } from "../app/lib/canonical-quote-authority.server";
import { normalizeCanonicalInput, canonicalSupportsTierLadder } from "../app/lib/canonical-calculator.server";

const routeSrc = () => readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

/* ================================================================== *
 * A. LABELS
 * ================================================================== */

/** Mirrors what the form emits for a multi-line job. */
function multiLineParams(line2Art: "ART-1" | "ART-2") {
  return new URLSearchParams({
    pfamily: "stickers-labels", pprinter: "auto", pwhitelayers: "0", pglosslayers: "0",
    pllines: "2",
    pl0qty: "500", pl0w: "3", pl0h: "3", pl0mat: "matte", pl0art: "ART-1",
    pl0cuttype: "rectangular", pl0printsetups: "1",
    pl1qty: "250", pl1w: "3", pl1h: "3", pl1mat: "holographic", pl1art: line2Art,
    pl1cuttype: "rectangular", pl1printsetups: "1",
  });
}

describe("2D-4D A2 multi-line artwork assignment", () => {
  it("SAME artwork on two lines: 2 physical lines, 1 art setup, 2 print setups", () => {
    const input = normalizeCanonicalInput(multiLineParams("ART-1"))!;
    const job = computeLabelJob({ lines: input.labels!.lines });
    expect(job.setup.physicalLines).toBe(2);
    expect(job.setup.distinctArtworkCount).toBe(1);
    expect(job.setup.artSetupEvents).toBe(1);
    expect(job.setup.printSetupEvents).toBe(2);
  });

  it("NEW artwork on line 2: 2 art setups, still 2 print setups", () => {
    const input = normalizeCanonicalInput(multiLineParams("ART-2"))!;
    const job = computeLabelJob({ lines: input.labels!.lines });
    expect(job.setup.distinctArtworkCount).toBe(2);
    expect(job.setup.artSetupEvents).toBe(2);
    expect(job.setup.printSetupEvents).toBe(2);
  });

  it("quantities are preserved EXACTLY — never redistributed", () => {
    for (const art of ["ART-1", "ART-2"] as const) {
      const input = normalizeCanonicalInput(multiLineParams(art))!;
      expect(input.labels!.lines.map((l) => l.quantity)).toEqual([500, 250]);
    }
  });

  it("each physical line stays independent: material, nesting, ink area, cut", () => {
    const input = normalizeCanonicalInput(multiLineParams("ART-1"))!;
    const job = computeLabelJob({ lines: input.labels!.lines });
    expect(job.lines[0].material!.label).toBe("Poseidon Matte");
    expect(job.lines[1].material!.label).toBe("Holographic");
    expect(job.lines[0].material!.costPerSqft).not.toBe(job.lines[1].material!.costPerSqft);
    // 54in matte vs 50in holographic — separate nests
    expect(job.lines[0].nesting!.materialFootprintSqft)
      .not.toBeCloseTo(job.lines[1].nesting!.materialFootprintSqft, 6);
    expect(job.printedLabels).toBe(750);
  });

  it("C1 rule preserved: multi-line jobs generate NO alternate tier ladder", () => {
    expect(canonicalSupportsTierLadder(normalizeCanonicalInput(multiLineParams("ART-1")))).toBe(false);
  });

  it("the form DECLARES artwork — it never infers it", () => {
    const route = routeSrc();
    expect(route).toContain('name="pslart"');
    expect(route).toContain("const resolveArtworkKey");
    // no inference from size or material anywhere in the resolver
    const resolver = route.slice(route.indexOf("const resolveArtworkKey"), route.indexOf("if (!pm) return null;"));
    expect(resolver).not.toMatch(/widthIn|heightIn|\.mat\b|printWidth/);
  });
});

describe("2D-4D A3 every normal label is cut", () => {
  it("the Labels cut-type selects offer no 'no cutting' option", () => {
    const route = routeSrc();
    const primary = route.slice(route.indexOf('<select name="pcut"'), route.indexOf("</select>", route.indexOf('<select name="pcut"')));
    const additional = route.slice(route.indexOf('<select name="pslcut"'), route.indexOf("</select>", route.indexOf('<select name="pslcut"')));
    for (const [label, block] of [["primary", primary], ["additional", additional]] as const) {
      expect(block, label).not.toContain('value="none"');
      expect(block, label).toContain('value="square-rect"');
    }
  });

  it("no special no-cut costing logic was introduced", () => {
    const src = readFileSync("app/lib/label-cost-inputs.server.ts", "utf8");
    expect(src).not.toMatch(/requiresCutting:\s*false/);
  });
});

describe("2D-4D A4 contour needs a measured path length", () => {
  const contourLine = (perimeter?: number) => ({
    key: "c", artworkKey: "A", printWidthIn: 3, printHeightIn: 3,
    quantity: 500, materialKey: "matte", cutType: "contour" as const,
    ...(perimeter ? { contourPerimeterIn: perimeter } : {}),
  });

  it("WITHOUT a perimeter the job blocks — a rectangle is not a contour", () => {
    const job = computeLabelJob({ lines: [contourLine()] });
    expect(job.blockers.join(" ")).toMatch(/CUTLINE_GEOMETRY_REQUIRED/);
  });

  it("WITH a measured perimeter it costs through the canonical finishing engine", () => {
    const job = computeLabelJob({ lines: [contourLine(11.5)] });
    expect(job.blockers).toHaveLength(0);
    expect(job.finishing!.cutPathIn).toBeCloseTo(500 * 11.5, 6);
  });

  it("the form asks for the perimeter ONLY when contour is selected", () => {
    const route = routeSrc();
    expect(route).toContain('name="pl0perim"');
    expect(route).toContain('name="pslperim"');
    expect(route).toContain('canonicalLabelCutType(row.cut) === "contour"');
    expect(route).toContain('canonCutType === "contour"');
  });
});

/* ================================================================== *
 * B. BAGS — re-pinned so a readiness sweep cannot regress them
 * ================================================================== */

describe("2D-4D B bags", () => {
  it("blank base is $0.11 (owner decision 2026-10-08) and no generic freight uplift is assumed", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 }).blankCost).toBeCloseTo(110, 10);
    const code = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/0\.02/);
  });

  it("B3: the ACTUAL artboard drives the cutline, and it is the only bag artboard we have", () => {
    expect(BAG_4X5_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
    const ruled = deriveGsoLabelCutlineFromArtboard(4, 5)!;
    expect(BAG_4X5_CUTLINE_IN.widthIn).toBe(ruled.cutWidthIn);
    expect(BAG_4X5_CUTLINE_IN.heightIn).toBe(ruled.cutHeightIn);
    // there is exactly ONE bag artboard constant — no other size has one.
    // 2026-10-05: it lives in the client-safe bag-artboard-geometry.ts and the
    // server module re-exports it rather than defining its own.
    const geometrySrc = readFileSync("app/lib/bag-artboard-geometry.ts", "utf8");
    expect(geometrySrc.match(/_ARTBOARD_IN = /g)).toHaveLength(1);
    const src = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    expect(src.match(/_ARTBOARD_IN = /g)).toBeNull();
    expect(src).toContain('import { BAG_4X5_ARTBOARD_IN } from "./bag-artboard-geometry"');
  });

  it("MOQ, application and setup are unchanged", () => {
    expect(STOCK_BAG_MOQ).toBe(50);
    expect(BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    const one = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 });
    const two = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(one.application.applicationEvents).toBe(1000);
    expect(two.application.applicationEvents).toBe(2000);
    expect(computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 }).setup.art).toBe(0);
  });

  it("Stock Bag personalization: $0 customer add-on, one art event per design", () => {
    const p = computeBagPhysical({
      product: "stock_bag", bagQuantity: 1000, sides: 2,
      personalization: { logo: true, personalizedDesignCount: 2 },
    });
    expect(p.personalization.customerAddOn).toBe(0);
    expect(p.personalization.setupEvents).toBe(2);
    expect(p.setup.printDesignEvents).toBe(2);
    // never multiplied by bag quantity
    const p5000 = computeBagPhysical({
      product: "stock_bag", bagQuantity: 5000, sides: 2,
      personalization: { logo: true, personalizedDesignCount: 2 },
    });
    expect(p5000.setup.total).toBe(p.setup.total);
  });
});

/* ================================================================== *
 * C. JARS
 * ================================================================== */

const ALL_SIZES = Object.keys(JAR_LABEL_GEOMETRY) as JarSizeKey[];

describe("2D-4D C1 jar cutlines are derived, never the artboard", () => {
  it("every one of the 7 profiles carries side, tamper and lid artwork", () => {
    expect(ALL_SIZES).toHaveLength(7);
    for (const size of ALL_SIZES) {
      const g = JAR_LABEL_GEOMETRY[size];
      for (const v of [g.side.widthIn, g.side.heightIn, g.tamper.widthIn, g.tamper.heightIn, g.lid.diameterIn]) {
        expect(v, size).toBeGreaterThan(0);
      }
    }
  });

  it("side / tamper / lid all derive by the -0.0625in rule, and none equals its artboard", () => {
    for (const size of ALL_SIZES) {
      const g = JAR_LABEL_GEOMETRY[size];
      const geo = jarCutGeometry(size);
      const side = deriveGsoLabelCutlineFromArtboard(g.side.widthIn, g.side.heightIn)!;
      const tamper = deriveGsoLabelCutlineFromArtboard(g.tamper.widthIn, g.tamper.heightIn)!;
      const lid = deriveGsoLabelCutDiameter(g.lid.diameterIn)!;

      expect((geo.side as any).cutWidthIn, size).toBeCloseTo(g.side.widthIn - 0.125, 10);
      expect((geo.side as any).cutHeightIn, size).toBeCloseTo(g.side.heightIn - 0.125, 10);
      expect((geo.tamper as any).cutWidthIn, size).toBeCloseTo(tamper.cutWidthIn, 10);
      expect((geo.lid as any).cutDiameterIn, size).toBeCloseTo(g.lid.diameterIn - 0.125, 10);

      // never the artboard itself
      expect((geo.side as any).cutWidthIn, size).not.toBeCloseTo(g.side.widthIn, 6);
      expect((geo.lid as any).cutDiameterIn, size).not.toBeCloseTo(g.lid.diameterIn, 6);
      expect(side.cutWidthIn).toBeGreaterThan(0);
      expect(lid).toBeGreaterThan(0);
    }
  });

  it("the jar adapter imports the shared rule — it does not re-implement it", () => {
    const src = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    expect(src).toContain('from "./gso-cutline"');
    // the offset may be NAMED in comments and note strings; what must not exist
    // is arithmetic that re-derives it locally
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/[-+*/=]\s*0\.0625\s*[*+;)]/);
    expect(code).not.toMatch(/widthIn\s*-\s*0\.125|heightIn\s*-\s*0\.125|diameterIn\s*-\s*0\.125/);
  });
});

describe("2D-4D C2/C6 jar data completeness is PER PROFILE", () => {
  it("blank item cost exists for some profiles and is honestly missing for others", () => {
    const verified: string[] = [];
    const blocked: string[] = [];
    for (const size of ALL_SIZES) {
      for (const brand of ["standard", "chiron", "miron"] as const) {
        const r: any = resolveJarBlankCost({ brand, size, quantity: 1000, variant: "clear" });
        (r.ok ? verified : blocked).push(`${brand}/${size}`);
      }
    }
    // both lists are non-empty — that is the point: readiness is per profile
    expect(verified.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    // spot-check the extremes
    expect(verified).toContain("miron/100ml_tall");
    expect(verified).toContain("standard/4oz");
    expect(blocked).toContain("miron/4oz");
    expect(blocked).toContain("standard/250ml");
  });

  it("a missing blank cost BLOCKS that profile rather than defaulting", () => {
    const r: any = resolveJarBlankCost({ brand: "miron", size: "4oz", quantity: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("MISSING_COST");
    expect(r.unitCost).toBeUndefined();
  });

  it("freight is provisional where derived and NULL where no basis exists", () => {
    const derived: any = jarFreightPerUnit("miron", "100ml_tall");
    expect(derived.perUnit).toBeGreaterThan(0);
    expect(derived.provisional).toBe(true);

    const missing: any = jarFreightPerUnit("miron", "4oz");
    expect(missing.perUnit).toBeNull();
    expect(missing.basis).toBe("MISSING_FREIGHT_BASIS");
  });

  it("no pallet freight rate was invented for jars or bags", () => {
    const jar = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    expect(jar).not.toMatch(/southwest/i);
    const bag = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    const bagCode = bag.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(bagCode).not.toMatch(/perPallet|palletRate|freightPerUnit/);
  });
});

describe("2D-4D C5 jar setup rules are untouched", () => {
  it("art is PER_DESIGN and print is PER_JOB — NOT the labels/bags model", () => {
    const plain = jarSetupCost({ side: true, lid: true, tamper: false });
    const tamper = jarSetupCost({ side: true, lid: true, tamper: true });
    expect(plain.artBasis).toBe("PER_DESIGN");
    expect(plain.printBasis).toBe("PER_JOB");
    expect(plain.art).toBeCloseTo(JAR_ART_SETUP_PER_DESIGN, 10);
    expect(plain.print).toBeCloseTo(JAR_PRINT_SETUP_PER_JOB, 10);
    // a second design raises art but never print
    expect(tamper.art).toBeGreaterThan(plain.art);
    expect(tamper.print).toBe(plain.print);
  });
});

describe("2D-4D C7 jars were not promoted HERE — 2D-4D1 promoted them", () => {
  // 2D-4D derived the jar cutlines and evaluated readiness; it deliberately
  // stopped short of promotion because the ACTIVE jar scope was still unknown
  // and inactive sizes looked like missing costs. 2D-4D1 settled the scope
  // with the owner and promoted on that basis. These guards are inverted
  // rather than deleted so the boundary between the two patches stays on
  // record and a silent re-demotion would fail.

  it("both jar families are now the canonical cost authority", () => {
    for (const family of ["standard-jars", "premium-jars"]) {
      expect(familyCostModel(family)).toBe("CANONICAL_COST_AUTHORITY");
    }
  });

  it("a usable canonical jar result CAN quote — and an unusable one still cannot", () => {
    for (const family of ["standard-jars", "premium-jars"]) {
      const usable = { family, status: "PROVISIONAL" as const, unitCost: 2.5, totalCost: 2500, blockers: [] };
      expect(canonicalSaveGate({ canonicalFamilyKey: family, canonical: usable }).allowed, family).toBe(true);

      const draftOnly = { family, status: "DRAFT_ONLY" as const, unitCost: null, totalCost: 0, blockers: ["FAMILY_NOT_CANONICAL"] };
      expect(canonicalSaveGate({ canonicalFamilyKey: family, canonical: draftOnly }).allowed, family).toBe(false);
      expect(canonicalSaveGate({ canonicalFamilyKey: family, canonical: null }).allowed, family).toBe(false);
    }
  });

  it("jars are routed through the canonical dispatch", () => {
    for (const family of ["standard-jars", "premium-jars"]) {
      expect(normalizeCanonicalInput(new URLSearchParams(`pfamily=${family}&pqty=1000&pprinter=auto`))).not.toBeNull();
    }
  });

  it("promotion stayed a deliberate, documented code change", () => {
    const src = readFileSync("app/lib/canonical-quote-authority.server.ts", "utf8");
    expect(src).toMatch(/PROMOTION IS A DELIBERATE CODE CHANGE/);
    // The mechanism outlived its only members: the list is empty, not gone.
    expect(src).toContain("CANONICAL_FAIL_CLOSED_FAMILIES = [] as const");
    expect(src).toMatch(/THE REFUSAL IS ABSOLUTE/);
  });
});

/* ================================================================== *
 * REGRESSION
 * ================================================================== */

describe("2D-4D regression", () => {
  it("DTP and Boxes remain legacy/outsourced", () => {
    for (const family of ["dtp-bags", "boxes"]) {
      expect(familyCostModel(family)).toBe("LEGACY_OUTSOURCED");
      expect(canonicalSaveGate({ canonicalFamilyKey: family, canonical: null }).allowed).toBe(true);
    }
  });

  it("the legacy 0.6 mL/sqft constants are untouched", () => {
    expect((routeSrc().match(/inkMlPerSqft: 0\.6/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it("no production DB write path was introduced", () => {
    for (const file of ["app/lib/jar-cost-inputs.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/label-cost-inputs.server.ts", "app/lib/gso-cutline.ts"]) {
      const src = readFileSync(file, "utf8");
      for (const forbidden of ["db.server", "PrismaClient", "$transaction", ".create(", ".update("]) {
        expect(src, `${file} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the single db.quote.create stays inside the canonical save boundary", () => {
    const route = routeSrc();
    expect(route.match(/db\.quote\.create\(/g)).toHaveLength(1);
    expect(route.indexOf("await db.quote.create({")).toBeGreaterThan(route.indexOf("await persistQuoteIfCanonicalAllows("));
  });
});
