// Patch 2D-3D — A PRODUCTION LINE IS NOT AN ARTWORK.
//
// Three counts, three meanings, three multipliers:
//
//   physical lines      size / material / finish / cutline / nesting / ink /
//                       cutting / weeding. Always independent.
//   art setup events    distinct ARTWORK, plus any genuinely separate
//                       per-line artwork prep. Shared artwork = one event.
//   print setup events  press setups. Two lines of ONE artwork on two media
//                       are still two press setups.
//
// The defect this pins: art setup silently following line count, which bills
// artwork nobody drew. The opposite error is pinned too — collapsing print
// setups just because artwork happens to be shared gives away real work.

import { describe, expect, it } from "vitest";

import { computeBagPhysical } from "../app/lib/bag-cost-inputs.server";
import { computeLabelJob, type LabelLine } from "../app/lib/label-cost-inputs.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import {
  computeTrueJobCost,
  isQuantityIndependentBasis,
  type TrueCostInput,
} from "../app/lib/true-cost-engine.server";

const ART = OWNER_STANDARDS.artSetupPerDesign.value; // $8.3333333333
const PRINT = OWNER_STANDARDS.printSetupPerDesign.value; // $1.00
const QTYS = [50, 500, 5000] as const;

const line = (over: Partial<LabelLine> & { key: string }): LabelLine => ({
  quantity: 500,
  printWidthIn: 3,
  printHeightIn: 3,
  cutWidthIn: 2.85,
  cutHeightIn: 2.85,
  materialKey: "matte",
  ...over,
});

/** Example A from the owner brief: ONE artwork, two media. */
const sameArtworkTwoLines = (quantity = 500) =>
  computeLabelJob({
    lines: [
      line({ key: "l1", artworkKey: "ART-A", materialKey: "matte", quantity }),
      line({ key: "l2", artworkKey: "ART-A", materialKey: "holographic", quantity }),
    ],
  });

/** Example B: two genuinely different artworks. */
const twoArtworksTwoLines = (quantity = 500) =>
  computeLabelJob({
    lines: [
      line({ key: "l1", artworkKey: "ART-A", materialKey: "matte", quantity }),
      line({
        key: "l2", artworkKey: "ART-B", materialKey: "holographic", quantity,
        printWidthIn: 2, printHeightIn: 4, cutWidthIn: 1.9, cutHeightIn: 3.9,
      }),
    ],
  });

describe("2D-3D art setup follows ARTWORK, not line count", () => {
  it("1. same artwork on 2 physical lines => 1 art setup event", () => {
    const r = sameArtworkTwoLines();
    expect(r.setup.physicalLines).toBe(2);
    expect(r.setup.distinctArtworkCount).toBe(1);
    expect(r.setup.artSetupEvents).toBe(1);
    expect(r.setup.art).toBeCloseTo(ART, 10);
    // explicitly NOT the line count
    expect(r.setup.art).not.toBeCloseTo(2 * ART, 6);
  });

  it("2. two distinct artworks on 2 physical lines => 2 art setup events", () => {
    const r = twoArtworksTwoLines();
    expect(r.setup.distinctArtworkCount).toBe(2);
    expect(r.setup.artSetupEvents).toBe(2);
    expect(r.setup.art).toBeCloseTo(2 * ART, 10);
  });

  it("3. same artwork on 2 lines still produces 2 PRINT setup events", () => {
    const r = sameArtworkTwoLines();
    expect(r.setup.artSetupEvents).toBe(1);
    expect(r.setup.printSetupEvents).toBe(2);
    expect(r.setup.print).toBeCloseTo(2 * PRINT, 10);
    // the two counts are genuinely allowed to disagree
    expect(r.setup.printSetupEvents).not.toBe(r.setup.artSetupEvents);
  });

  it("Example C: shared artwork that needs real extra prep may add an art event", () => {
    const r = computeLabelJob({
      lines: [
        line({ key: "l1", artworkKey: "ART-A" }),
        line({ key: "l2", artworkKey: "ART-A", materialKey: "holographic", additionalArtSetupEvents: 1 }),
      ],
    });
    expect(r.setup.distinctArtworkCount).toBe(1);
    expect(r.setup.additionalArtSetupEvents).toBe(1);
    expect(r.setup.artSetupEvents).toBe(2);
    expect(r.setup.art).toBeCloseTo(2 * ART, 10);
    // ...and a size/material change ALONE does not, which is the default
    expect(sameArtworkTwoLines().setup.artSetupEvents).toBe(1);
  });

  it("7. adding physical lines alone does NOT increase art setup", () => {
    const one = computeLabelJob({ lines: [line({ key: "l1", artworkKey: "ART-A" })] });
    const three = computeLabelJob({
      lines: [
        line({ key: "l1", artworkKey: "ART-A", materialKey: "matte" }),
        line({ key: "l2", artworkKey: "ART-A", materialKey: "gloss" }),
        line({ key: "l3", artworkKey: "ART-A", materialKey: "holographic" }),
      ],
    });
    expect(three.setup.physicalLines).toBe(3);
    expect(three.setup.artSetupEvents).toBe(one.setup.artSetupEvents);
    expect(three.setup.art).toBeCloseTo(one.setup.art, 10);
    // but the press setups DO grow, because three runs really are set up
    expect(three.setup.printSetupEvents).toBe(3);
    expect(three.setup.print).toBeCloseTo(3 * PRINT, 10);
  });

  it("6. increasing DISTINCT artwork count increases art setup", () => {
    const counts = [1, 2, 3, 5];
    const arts = counts.map((n) =>
      computeLabelJob({
        lines: Array.from({ length: n }, (_, i) => line({ key: `l${i}`, artworkKey: `ART-${i}` })),
      }).setup.art,
    );
    for (const [i, n] of counts.entries()) expect(arts[i]).toBeCloseTo(n * ART, 10);
    for (let i = 1; i < arts.length; i += 1) expect(arts[i]).toBeGreaterThan(arts[i - 1]);
  });

  it("an omitted artworkKey defaults to DISTINCT — nothing is silently shared", () => {
    const r = computeLabelJob({ lines: [line({ key: "l1" }), line({ key: "l2", materialKey: "gloss" })] });
    expect(r.setup.distinctArtworkCount).toBe(2);
    expect(r.setup.art).toBeCloseTo(2 * ART, 10);
  });

  it("a line may ride an existing press setup when that is genuinely true", () => {
    const r = computeLabelJob({
      lines: [
        line({ key: "l1", artworkKey: "ART-A" }),
        line({ key: "l2", artworkKey: "ART-A", printSetupEvents: 0 }),
      ],
    });
    expect(r.setup.artSetupEvents).toBe(1);
    expect(r.setup.printSetupEvents).toBe(1);
    expect(r.setup.print).toBeCloseTo(PRINT, 10);
  });

  it("the basis note states what each count follows", () => {
    const note = sameArtworkTwoLines().setup.basisNote;
    expect(note).toMatch(/2 physical line\(s\)/);
    expect(note).toMatch(/1 distinct artwork\(s\)/);
    expect(note).toMatch(/2 print-design setup\(s\)/);
    expect(note).toMatch(/never line count and never copies/);
  });
});

describe("2D-3D sharing artwork never merges the physical lines", () => {
  it("4. material, nesting, media cost and ink basis stay per line", () => {
    const r = sameArtworkTwoLines();
    expect(r.lines).toHaveLength(2);

    // different materials, and each priced at its OWN verified $/sqft
    expect(r.lines[0].material!.label).toBe("Poseidon Matte");
    expect(r.lines[1].material!.label).toBe("Holographic");
    expect(r.lines[0].material!.costPerSqft).not.toBe(r.lines[1].material!.costPerSqft);
    expect(r.lines[0].materialCost).not.toBeCloseTo(r.lines[1].materialCost, 6);

    // each line nested on its own roll width — 54in matte vs 50in holographic
    expect(r.lines[0].nesting).not.toBeNull();
    expect(r.lines[1].nesting).not.toBeNull();
    expect(r.lines[0].nesting!.materialFootprintSqft).not.toBeCloseTo(
      r.lines[1].nesting!.materialFootprintSqft, 6,
    );

    // job media cost is the SUM of the independent lines, not one merged layout
    expect(r.materialCost).toBeCloseTo(r.lines[0].materialCost + r.lines[1].materialCost, 10);
    expect(r.printedLabels).toBe(1000);
  });

  it("4. cutting and weeding still see both physical lines", () => {
    const one = computeLabelJob({ lines: [line({ key: "l1", artworkKey: "ART-A" })] });
    const two = sameArtworkTwoLines();
    expect(two.finishing).not.toBeNull();
    // twice the labels through the cutter, despite the shared artwork
    expect(two.finishing!.cutPathIn).toBeCloseTo(2 * one.finishing!.cutPathIn, 6);
    expect(two.finishing!.weedingPages).toBeGreaterThan(one.finishing!.weedingPages);
  });

  it("4. shared artwork and distinct artwork give IDENTICAL physical costs", () => {
    // same geometry + materials on both sides; only artwork identity differs
    const shared = sameArtworkTwoLines();
    const distinct = computeLabelJob({
      lines: [
        line({ key: "l1", artworkKey: "ART-A", materialKey: "matte" }),
        line({ key: "l2", artworkKey: "ART-B", materialKey: "holographic" }),
      ],
    });
    expect(shared.materialCost).toBeCloseTo(distinct.materialCost, 10);
    expect(shared.printedLabels).toBe(distinct.printedLabels);
    expect(shared.finishing!.cutPathIn).toBeCloseTo(distinct.finishing!.cutPathIn, 10);
    expect(shared.finishing!.weedingPages).toBe(distinct.finishing!.weedingPages);
    // ONLY art setup differs
    expect(shared.setup.art).toBeCloseTo(ART, 10);
    expect(distinct.setup.art).toBeCloseTo(2 * ART, 10);
    expect(shared.setup.print).toBeCloseTo(distinct.setup.print, 10);
  });
});

describe("2D-3D quantity still multiplies nothing in setup", () => {
  it("5. same artwork/line structure at qty 50 / 500 / 5000 => identical setup", () => {
    const runs = QTYS.map((q) => sameArtworkTwoLines(q));
    expect(new Set(runs.map((r) => r.setup.art)).size).toBe(1);
    expect(new Set(runs.map((r) => r.setup.print)).size).toBe(1);
    expect(new Set(runs.map((r) => r.setup.total)).size).toBe(1);
    expect(runs[0].setup.art).toBeCloseTo(ART, 10);
    expect(runs[0].setup.print).toBeCloseTo(2 * PRINT, 10);
    // while the physical side genuinely scales
    expect(new Set(runs.map((r) => r.materialCost)).size).toBe(3);
    expect(runs.map((r) => r.printedLabels)).toEqual([100, 1000, 10000]);
  });

  it("5. holds for the two-artwork structure as well", () => {
    const runs = QTYS.map((q) => twoArtworksTwoLines(q));
    expect(new Set(runs.map((r) => r.setup.total)).size).toBe(1);
    expect(runs[0].setup.art).toBeCloseTo(2 * ART, 10);
  });
});

describe("2D-3D Stock Bag rulings preserved", () => {
  const stock = (bagQuantity: number, personalization?: { logo?: boolean; qr?: boolean; personalizedDesignCount?: number }) =>
    computeBagPhysical({ product: "stock_bag", bagQuantity, sides: 2, personalization });

  it("8. two distinct personalized designs still produce $2 print setup", () => {
    for (const q of QTYS) {
      const r = stock(q, { logo: true, qr: true, personalizedDesignCount: 2 });
      expect(r.setup.printDesignEvents, `qty ${q}`).toBe(2);
      expect(r.setup.print, `qty ${q}`).toBeCloseTo(2 * PRINT, 10);
      expect(r.setup.art, `qty ${q}`).toBeCloseTo(2 * ART, 10);
    }
    // and the owner's 1 / 2 / 7 ladder
    for (const [designs, expected] of [[1, 1], [2, 2], [7, 7]] as const) {
      const r = stock(500, { logo: true, personalizedDesignCount: designs });
      expect(r.setup.print, `${designs} designs`).toBeCloseTo(expected * PRINT, 10);
    }
  });

  it("9. bag quantity multiplies neither print nor art setup", () => {
    for (const p of [undefined, { logo: true }, { logo: true, qr: true, personalizedDesignCount: 2 }]) {
      const runs = QTYS.map((q) => stock(q, p));
      expect(new Set(runs.map((r) => r.setup.art)).size, JSON.stringify(p)).toBe(1);
      expect(new Set(runs.map((r) => r.setup.print)).size, JSON.stringify(p)).toBe(1);
      expect(new Set(runs.map((r) => r.setup.total)).size, JSON.stringify(p)).toBe(1);
      // the physical side genuinely varies across the same three jobs
      expect(new Set(runs.map((r) => r.application.applicationEvents)).size).toBe(3);
    }
    // base premade stock bag: $1 print, $0 art, at every quantity
    for (const q of QTYS) {
      expect(stock(q).setup.print).toBeCloseTo(PRINT, 10);
      expect(stock(q).setup.art).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Specialty / file prep — basis audit
 * ------------------------------------------------------------------ */

describe("2D-3D specialty file prep is per artwork/design, never per line", () => {
  it("the canonical label adapter emits no specialty prep at all", () => {
    const r = sameArtworkTwoLines();
    expect(r.setup).not.toHaveProperty("specialty");
    // so there is nothing that could be multiplied by line count here
    expect(r.setup.total).toBeCloseTo(r.setup.art + r.setup.print, 10);
  });

  it("the gloss standard is written once per DESIGN and never per stage", () => {
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.unit).toMatch(/per gloss design/i);
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.unit).toMatch(/never per stage/i);
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.status).toBe("owner_verified");
  });

  it("a specialty setup line is quantity-independent and carries its own basis", () => {
    const base = (qty: number): TrueCostInput => ({
      customerFinishedQty: qty,
      productionQty: qty,
      overagePct: 0,
      areas: {
        inkableArtworkSqft: qty * 0.1,
        ripLayoutSqft: qty * 0.12,
        materialFootprintSqft: qty * 0.15,
        ripLayoutBasis: "deterministic nesting engine",
      },
      blank: { ok: true, unitCost: 0.11, label: "blank", source: "owner" },
      material: { name: "media", costPerSqft: 0.3156, source: "verified roll" },
      calibration: null,
      inkCostPerMl: 0.176,
      inkCostSource: "purchasing",
      coveragePct: 100,
      passCount: 1,
      application: { secondsPerFinishedUnit: 10, laborRatePerHour: 20 },
      setup: {
        art: ART,
        print: PRINT,
        specialty: OWNER_STANDARDS.glossLayerSetupPerDesign.value,
        groups: 1,
        specialtyBasis: "PER_DESIGN",
      },
      runLabor: null,
      equipmentRatePerHour: 8,
      packout: { unitsPerBox: 100, laborPerBox: 2, consumablesPerBox: 1.5 },
      freight: { perUnit: 0.01, basis: "invoice", provisional: false, source: "invoice" },
    });
    const amounts = QTYS.map((q) => {
      const l = computeTrueJobCost(base(q)).lines.find((x) => x.key === "specialty_setup")!;
      expect(l.category).toBe("setup_labor");
      expect(isQuantityIndependentBasis(l.basis)).toBe(true);
      return l.amount;
    });
    expect(amounts[0]).toBeCloseTo(6.25, 10);
    expect(new Set(amounts).size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 10. every stamp matches its real multiplier
 * ------------------------------------------------------------------ */

describe("2D-3D every CostBasis stamp matches the actual multiplier", () => {
  it("label art and print are both PER_DESIGN and both quantity-independent", () => {
    const r = sameArtworkTwoLines();
    expect(r.setup.artBasis).toBe("PER_DESIGN");
    expect(r.setup.printBasis).toBe("PER_DESIGN");
    expect(isQuantityIndependentBasis(r.setup.artBasis)).toBe(true);
    expect(isQuantityIndependentBasis(r.setup.printBasis)).toBe(true);
  });

  it("a PER_DESIGN stamp means the amount moves with EVENTS and not with copies", () => {
    // art: moves with distinct artwork, not with lines and not with copies
    expect(twoArtworksTwoLines().setup.art).toBeGreaterThan(sameArtworkTwoLines().setup.art);
    expect(sameArtworkTwoLines(5000).setup.art).toBeCloseTo(sameArtworkTwoLines(50).setup.art, 10);
    // print: moves with press setups, not with copies
    const onePress = computeLabelJob({ lines: [line({ key: "l1", artworkKey: "ART-A" })] });
    expect(sameArtworkTwoLines().setup.print).toBeGreaterThan(onePress.setup.print);
    expect(sameArtworkTwoLines(5000).setup.print).toBeCloseTo(sameArtworkTwoLines(50).setup.print, 10);
  });

  it("bag art and print stamps also match their multipliers", () => {
    const base = computeBagPhysical({ product: "stock_bag", bagQuantity: 500, sides: 2 });
    const two = computeBagPhysical({
      product: "stock_bag", bagQuantity: 500, sides: 2,
      personalization: { logo: true, personalizedDesignCount: 2 },
    });
    expect(base.setup.artBasis).toBe("PER_DESIGN");
    expect(base.setup.printBasis).toBe("PER_DESIGN");
    expect(two.setup.artDesignEvents).toBe(2);
    expect(two.setup.printDesignEvents).toBe(2);
    expect(two.setup.art).toBeCloseTo(2 * ART, 10);
    expect(two.setup.print).toBeCloseTo(2 * PRINT, 10);
  });
});
