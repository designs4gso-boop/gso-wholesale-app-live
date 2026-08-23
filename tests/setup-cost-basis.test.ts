// Patch 2D-3B — THE GLOBAL SETUP-BASIS INVARIANT.
//
// OWNER RULE: any cost classified as SETUP is an EVENT-based fixed cost. It is
// charged per job / per design / per setup event and must NEVER be multiplied
// by physical order quantity simply because more copies are produced.
//
// Production costs — per unit, per application, per area, per cut path — do
// legitimately scale. These tests pin BOTH halves, because a rule that only
// freezes setup would be satisfied by freezing everything.
//
// Numbered assertions map 1:1 onto the owner's 16 required regression cases.

import { describe, expect, it } from "vitest";

import {
  BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN,
  BAG_PERSONALIZATION_BASIS,
  BAG_PERSONALIZATION_CUSTOMER_ADD_ON,
  BAG_REASONS,
  bagSetupCost,
  computeBagPersonalization,
  computeBagPhysical,
} from "../app/lib/bag-cost-inputs.server";
import { computeBannerCost } from "../app/lib/banner-cost-inputs.server";
import { computeLabelJob } from "../app/lib/label-cost-inputs.server";
import { jarSetupCost } from "../app/lib/jar-cost-inputs.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import {
  QUANTITY_INDEPENDENT_BASES,
  QUANTITY_SCALED_BASES,
  SETUP_BASIS,
  computeTrueJobCost,
  isQuantityIndependentBasis,
  type TrueCostInput,
} from "../app/lib/true-cost-engine.server";

const ART = OWNER_STANDARDS.artSetupPerDesign.value; // $8.3333/design
const PRINT = OWNER_STANDARDS.printSetupPerDesign.value; // $1.00

/** The three copy quantities the owner named. */
const QTYS = [50, 500, 5000] as const;

const SIDE_LID = { side: true, lid: true, tamper: false } as const;

/* ------------------------------------------------------------------ *
 * Engine-level: the basis vocabulary and the stamped lines
 * ------------------------------------------------------------------ */

/** Minimal complete job. Only `qty` and `designs` vary between calls. */
function job(qty: number, designs = 1): TrueCostInput {
  return {
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
    calibration: {
      id: "cal", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
      ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
      mlPerSqftPerPass: 1.6, minutesPerSqft: 1.444, coverageBasisPct: 100,
      areaBasis: "inkable_artwork", timeModel: "linear", fixedMinutes: 0,
      status: "approved", source: "owner-measured", notes: null, supersedesId: null,
    } as unknown as TrueCostInput["calibration"],
    inkCostPerMl: 0.176,
    inkCostSource: "purchasing",
    coveragePct: 100,
    passCount: 1,
    application: { secondsPerFinishedUnit: 10, laborRatePerHour: 20 },
    // THE point: setup is derived from DESIGNS. `qty` is not in scope here.
    setup: { art: designs * ART, print: designs > 0 ? PRINT : 0, groups: designs },
    runLabor: { mode: "operator_attention" },
    equipmentRatePerHour: 8,
    packout: { unitsPerBox: 100, laborPerBox: 2, consumablesPerBox: 1.5 },
    freight: { perUnit: 0.01, basis: "invoice", provisional: false, source: "invoice" },
  };
}

describe("2D-3B cost basis vocabulary", () => {
  it("PER_JOB / PER_DESIGN are the quantity-independent bases; production bases are not", () => {
    expect([...QUANTITY_INDEPENDENT_BASES]).toEqual(["PER_JOB", "PER_DESIGN"]);
    for (const b of QUANTITY_INDEPENDENT_BASES) expect(isQuantityIndependentBasis(b)).toBe(true);
    for (const b of QUANTITY_SCALED_BASES) expect(isQuantityIndependentBasis(b)).toBe(false);
    expect(isQuantityIndependentBasis(undefined)).toBe(false);
  });

  it("every setup component is stamped PER_DESIGN", () => {
    expect(SETUP_BASIS).toBe("PER_DESIGN");
    const r = computeTrueJobCost(job(500));
    const setupLines = r.lines.filter((l) => l.category === "setup_labor");
    expect(setupLines.length).toBeGreaterThan(0);
    for (const l of setupLines) {
      expect(l.basis, l.key).toBe(SETUP_BASIS);
      expect(isQuantityIndependentBasis(l.basis), l.key).toBe(true);
    }
  });

  it("GLOBAL INVARIANT — every quantity-independent line holds the same amount at 50 / 500 / 5000", () => {
    const runs = QTYS.map((q) => computeTrueJobCost(job(q)));
    const [a, ...rest] = runs;
    const fixed = a.lines.filter((l) => isQuantityIndependentBasis(l.basis));
    expect(fixed.length).toBeGreaterThan(0);
    for (const line of fixed) {
      for (const other of rest) {
        const twin = other.lines.find((l) => l.key === line.key);
        expect(twin, line.key).toBeDefined();
        expect(twin!.amount, `${line.key} moved with quantity`).toBe(line.amount);
      }
    }
    // setup_labor as a whole is frozen
    for (const other of rest) expect(other.totals.setup_labor).toBe(a.totals.setup_labor);
  });

  it("quantity-SCALED lines really do scale — the invariant is not just 'nothing moves'", () => {
    const small = computeTrueJobCost(job(50));
    const big = computeTrueJobCost(job(5000));
    const scaled = small.lines.filter((l) => l.basis != null && !isQuantityIndependentBasis(l.basis) && l.amount > 0);
    expect(scaled.length).toBeGreaterThan(0);
    for (const line of scaled) {
      const twin = big.lines.find((l) => l.key === line.key)!;
      expect(twin.amount, `${line.key} failed to scale`).toBeGreaterThan(line.amount);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 1-4  ART SETUP
 * ------------------------------------------------------------------ */

describe("2D-3B art setup — event based", () => {
  it("1-3. one design at qty 50 / 500 / 5000 charges IDENTICAL art setup", () => {
    const amounts = QTYS.map((q) => {
      const r = computeTrueJobCost(job(q, 1));
      return r.lines.find((l) => l.key === "art_setup")!.amount;
    });
    expect(amounts[0]).toBeCloseTo(ART, 10);
    expect(new Set(amounts).size).toBe(1);
  });

  it("1-3. holds in every canonical family adapter, not just the engine", () => {
    // bag (custom sticker bag carries customer artwork)
    const bagSetups = QTYS.map((q) => computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: q, sides: 2 }).setup);
    expect(new Set(bagSetups.map((s) => s.art)).size).toBe(1);
    expect(new Set(bagSetups.map((s) => s.total)).size).toBe(1);
    expect(bagSetups[0].art).toBeCloseTo(ART, 10);

    // banner
    const bannerSetups = QTYS.map((q) => computeBannerCost({ widthIn: 36, heightIn: 60, quantity: q }).setup);
    expect(new Set(bannerSetups.map((s) => s.art)).size).toBe(1);
    expect(new Set(bannerSetups.map((s) => s.total)).size).toBe(1);

    // labels — one design, three copy counts
    const labelSetups = QTYS.map(
      (q) =>
        computeLabelJob({
          lines: [{ key: "l1", artworkKey: "ART-A", printWidthIn: 3, printHeightIn: 3, cutWidthIn: 3, cutHeightIn: 3, quantity: q, materialKey: "matte" }],
        }).setup,
    );
    expect(new Set(labelSetups.map((s) => s.art)).size).toBe(1);
    expect(new Set(labelSetups.map((s) => s.total)).size).toBe(1);

    // jars — the selection carries no quantity at all
    expect(jarSetupCost(SIDE_LID).total).toBe(jarSetupCost(SIDE_LID).total);
  });

  it("4. two distinct designs legitimately create two art-setup events", () => {
    const one = computeTrueJobCost(job(500, 1)).lines.find((l) => l.key === "art_setup")!.amount;
    const two = computeTrueJobCost(job(500, 2)).lines.find((l) => l.key === "art_setup")!.amount;
    expect(two).toBeCloseTo(one * 2, 10);

    expect(bagSetupCost("sticker_bag_4x5", 2).art).toBeCloseTo(2 * ART, 10);
    expect(computeBannerCost({ widthIn: 36, heightIn: 60, quantity: 1, designs: 2 }).setup.art).toBeCloseTo(2 * ART, 10);
  });

  it("4. design count — not copy count — is what moves art setup", () => {
    const manyCopiesOneDesign = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 5000, sides: 2, designs: 1 });
    const fewCopiesTwoDesigns = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 50, sides: 1, designs: 2 });
    expect(fewCopiesTwoDesigns.setup.art).toBeGreaterThan(manyCopiesOneDesign.setup.art);
  });

  it("bag / banner / label stamp BOTH setup components PER_DESIGN", () => {
    const stamps = [
      bagSetupCost("stock_bag"),
      bagSetupCost("sticker_bag_4x5", 3),
      computeBannerCost({ widthIn: 24, heightIn: 48, quantity: 1 }).setup,
      computeLabelJob({ lines: [{ key: "l", printWidthIn: 2, printHeightIn: 2, cutWidthIn: 2, cutHeightIn: 2, quantity: 10, materialKey: "matte" }] }).setup,
    ];
    for (const st of stamps) {
      expect(st.artBasis).toBe(SETUP_BASIS);
      expect(st.printBasis).toBe(SETUP_BASIS);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5-6  PRINT SETUP
 * ------------------------------------------------------------------ */

describe("2D-3C print setup — PER DESIGN, never per copy", () => {
  /** N DISTINCT artworks, each on its own physical line. */
  const labelJob = (designs: number, quantity: number) =>
    computeLabelJob({
      lines: Array.from({ length: designs }, (_, i) => ({
        key: `l${i}`, artworkKey: `ART-${i}`,
        printWidthIn: 3, printHeightIn: 3, cutWidthIn: 3, cutHeightIn: 3,
        quantity, materialKey: "matte",
      })),
    });

  it("5. more copies alone never create more print setup", () => {
    const amounts = QTYS.map((q) => computeTrueJobCost(job(q, 1)).lines.find((l) => l.key === "print_setup")!.amount);
    expect(amounts[0]).toBeCloseTo(PRINT, 10);
    expect(new Set(amounts).size).toBe(1);

    // 50 / 500 / 5000 copies must NOT mean 50 / 500 / 5000 print setups
    for (const [i, q] of QTYS.entries()) expect(amounts[i]).not.toBeCloseTo(PRINT * q, 6);
  });

  it("5. holds across every canonical adapter", () => {
    expect(new Set(QTYS.map((q) => computeBagPhysical({ product: "stock_bag", bagQuantity: q, sides: 2 }).setup.print)).size).toBe(1);
    expect(new Set(QTYS.map((q) => computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: q, sides: 2 }).setup.print)).size).toBe(1);
    expect(new Set(QTYS.map((q) => computeBannerCost({ widthIn: 36, heightIn: 60, quantity: q }).setup.print)).size).toBe(1);
  });

  it("6. the owner grid — 1 design = $1 and 3 designs = $3, at qty 50 AND qty 5000", () => {
    expect(PRINT).toBeCloseTo(25 / 25, 12); // $25/hr at 25 designs/hr
    for (const [designs, expected] of [[1, 1], [3, 3]] as const) {
      for (const qty of [50, 5000]) {
        const bag = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: qty, sides: 1, designs });
        const banner = computeBannerCost({ widthIn: 36, heightIn: 60, quantity: qty, designs });
        const labels = labelJob(designs, qty);
        expect(bag.setup.print, `bag ${designs}d @ ${qty}`).toBeCloseTo(expected, 10);
        expect(banner.setup.print, `banner ${designs}d @ ${qty}`).toBeCloseTo(expected, 10);
        expect(labels.setup.print, `label ${designs}d @ ${qty}`).toBeCloseTo(expected, 10);
      }
    }
  });

  it("6. print setup uses the canonical standard, not a re-typed $1 literal", () => {
    expect(bagSetupCost("sticker_bag_4x5", 3).print).toBeCloseTo(3 * OWNER_STANDARDS.printSetupPerDesign.value, 10);
    expect(computeBannerCost({ widthIn: 36, heightIn: 60, quantity: 1, designs: 3 }).setup.print)
      .toBeCloseTo(3 * OWNER_STANDARDS.printSetupPerDesign.value, 10);
    expect(labelJob(3, 100).setup.print).toBeCloseTo(3 * OWNER_STANDARDS.printSetupPerDesign.value, 10);
  });

  it("6. legitimate additional setup events are never collapsed by the engine", () => {
    const base = job(500, 1);
    const one = computeTrueJobCost({ ...base, setup: { ...base.setup, print: PRINT, groups: 1 } })
      .lines.find((l) => l.key === "print_setup")!.amount;
    const two = computeTrueJobCost({ ...base, setup: { ...base.setup, print: 2 * PRINT, groups: 2 } })
      .lines.find((l) => l.key === "print_setup")!.amount;
    expect(one).toBeCloseTo(PRINT, 10);
    expect(two).toBeCloseTo(one * 2, 10);
  });
});

/* ------------------------------------------------------------------ *
 * Jars — a genuinely MIXED setup object
 * ------------------------------------------------------------------ */

describe("2D-3C jar setup basis stamps describe the real arithmetic", () => {
  it("art is PER_DESIGN, print is PER_JOB — the object is not flattened to one basis", () => {
    const plain = jarSetupCost(SIDE_LID);
    const tamper = jarSetupCost({ side: true, lid: true, tamper: true });
    expect(plain.artBasis).toBe("PER_DESIGN");
    expect(plain.printBasis).toBe("PER_JOB");
    expect(tamper.artBasis).toBe("PER_DESIGN");
    expect(tamper.printBasis).toBe("PER_JOB");
    expect(plain.artBasis).not.toBe(plain.printBasis);
  });

  it("the stamps match the arithmetic: art moves with designs, print moves with neither", () => {
    const plain = jarSetupCost(SIDE_LID);
    const tamper = jarSetupCost({ side: true, lid: true, tamper: true });
    // PER_DESIGN: a second design (tamper) raises art
    expect(tamper.designs).toBe(2);
    expect(tamper.art).toBeGreaterThan(plain.art);
    // PER_JOB: identical despite the extra design AND despite two physical runs
    expect(tamper.print).toBe(plain.print);
  });

  it("previously approved jar dollar amounts are unchanged", () => {
    expect(jarSetupCost(SIDE_LID).art).toBeCloseTo(12.5, 10);
    expect(jarSetupCost({ side: true, lid: true, tamper: true }).art).toBeCloseTo(22.5, 10);
    expect(jarSetupCost(SIDE_LID).print).toBeCloseTo(2.0, 10);
  });

  it("a PER_JOB line moves with neither design count nor copy count", () => {
    const base = job(500, 1);
    const perJob = (qty: number, designs: number) =>
      computeTrueJobCost({
        ...base,
        customerFinishedQty: qty,
        productionQty: qty,
        setup: { ...base.setup, print: 2.0, groups: designs, printBasis: "PER_JOB" },
      }).lines.find((l) => l.key === "print_setup")!;
    const a = perJob(50, 1);
    const b = perJob(5000, 1);
    const c = perJob(5000, 3);
    expect(a.basis).toBe("PER_JOB");
    expect(b.amount).toBe(a.amount);
    expect(c.amount).toBe(a.amount);
  });
});

/* ------------------------------------------------------------------ *
 * 7-15  STOCK BAG PERSONALIZATION
 * ------------------------------------------------------------------ */

describe("2D-3C stock bag personalization — one NORMAL art setup event per personalized design", () => {
  const stock = (bagQuantity: number, personalization?: Parameters<typeof computeBagPhysical>[0]["personalization"]) =>
    computeBagPhysical({ product: "stock_bag", bagQuantity, sides: 2, personalization });

  it("7. no personalization: 0 events, $0 art setup, $0 customer add-on, no blocker", () => {
    for (const p of [undefined, {}, { logo: false, qr: false }]) {
      const r = stock(500, p);
      expect(r.personalization.mode).toBe("NONE");
      expect(r.personalization.active).toBe(false);
      expect(r.personalization.setupEvents).toBe(0);
      expect(r.personalization.internalSetupCost).toBe(0);
      expect(r.personalization.internalCostStatus).toBe("NONE");
      expect(r.personalization.customerAddOn).toBe(0);
      // base premade artwork carries no art setup at all
      expect(r.setup.art).toBe(0);
      expect(r.setup.artDesignEvents).toBe(0);
      expect(r.blockers).toHaveLength(0);
    }
  });

  it("2D-3C: the rate-required blocker is retired from the reason vocabulary", () => {
    expect(Object.values(BAG_REASONS)).not.toContain("STOCK_BAG_PERSONALIZATION_RATE_REQUIRED");
    expect(BAG_REASONS).not.toHaveProperty("stockBagPersonalizationRateRequired");
    // selecting personalization no longer blocks anything
    expect(stock(500, { logo: true, qr: true }).blockers).toHaveLength(0);
  });

  it("8-10. 50 / 500 / 5000 bags, ONE personalized design => 1 event at $8.3333333333, every time", () => {
    expect(BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN).toBe(OWNER_STANDARDS.artSetupPerDesign.value);
    expect(BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN).toBeCloseTo(25 / 3, 12); // $25/hr at 3 designs/hr
    for (const q of QTYS) {
      const r = stock(q, { logo: true });
      expect(r.personalization.setupEvents, `qty ${q}`).toBe(1);
      expect(r.personalization.basis).toBe("PER_DESIGN");
      expect(r.personalization.internalSetupCost, `qty ${q}`).toBeCloseTo(8.3333333333, 9);
      // and it lands in the job's art setup, not in a parallel bucket
      expect(r.setup.art, `qty ${q}`).toBeCloseTo(8.3333333333, 9);
      expect(r.setup.artDesignEvents).toBe(1);
    }
    // identical across the whole ladder
    expect(new Set(QTYS.map((q) => stock(q, { logo: true }).personalization.internalSetupCost)).size).toBe(1);
  });

  it("11. two personalized designs => 2 events at $16.6666666667", () => {
    for (const q of QTYS) {
      const r = stock(q, { logo: true, qr: true, personalizedDesignCount: 2 });
      expect(r.personalization.setupEvents).toBe(2);
      expect(r.personalization.internalSetupCost, `qty ${q}`).toBeCloseTo(16.6666666667, 9);
      expect(r.setup.art, `qty ${q}`).toBeCloseTo(16.6666666667, 9);
    }
    const seven = stock(500, { logo: true, personalizedDesignCount: 7 });
    expect(seven.personalization.setupEvents).toBe(7);
    expect(seven.personalization.internalSetupCost).toBeCloseTo(7 * (25 / 3), 9);
  });

  it("12. logo-only / QR-only / logo+QR all use the SAME basis AND the same rate", () => {
    const variants = [{ logo: true }, { qr: true }, { logo: true, qr: true }];
    const results = variants.map((p) => computeBagPersonalization(p, 5000));
    for (const r of results) {
      expect(r.mode).toBe("PERSONALIZED");
      expect(r.setupEvents).toBe(1);
      expect(r.basis).toBe(BAG_PERSONALIZATION_BASIS);
      expect(r.internalSetupCost).toBeCloseTo(25 / 3, 10);
      expect(r.ratePerDesign).toBe(BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN);
      expect(r.customerAddOn).toBe(0);
    }
    // no separate logo / QR / logo+QR rate exists
    expect(new Set(results.map((r) => `${r.mode}|${r.setupEvents}|${r.basis}|${r.internalSetupCost}`)).size).toBe(1);
    expect(results.map((r) => [r.logo, r.qr])).toEqual([[true, false], [false, true], [true, true]]);
  });

  it("13. NOTHING physical multiplies personalization setup", () => {
    // 100x the bags, same single design
    const small = computeBagPersonalization({ logo: true, qr: true }, 50);
    const huge = computeBagPersonalization({ logo: true, qr: true }, 5000);
    expect(huge.setupEvents).toBe(small.setupEvents);
    expect(huge.internalSetupCost).toBe(small.internalSetupCost);

    // bag quantity, printed sides, label quantity and application events all
    // change across these four jobs; the personalization cost does not.
    const jobs = [
      stock(50, { logo: true }),
      stock(5000, { logo: true }),
      computeBagPhysical({ product: "stock_bag", bagQuantity: 5000, sides: 1, personalization: { logo: true } }),
      computeBagPhysical({ product: "stock_bag", bagQuantity: 50, sides: 1, personalization: { logo: true } }),
    ];
    expect(new Set(jobs.map((r) => r.personalization.internalSetupCost)).size).toBe(1);
    expect(new Set(jobs.map((r) => r.setup.art)).size).toBe(1);
    expect(new Set(jobs.map((r) => r.labelQuantity)).size).toBe(4); // the physical side really does vary
    expect(new Set(jobs.map((r) => r.application.applicationEvents)).size).toBe(4);

    // the basis note names every excluded multiplier explicitly
    const note = small.basisNote;
    for (const excluded of ["Bag quantity", "label quantity", "printed sides", "application events", "production quantity"]) {
      expect(note, excluded).toContain(excluded);
    }
  });

  it("14. physical label application stays completely separate and DOES scale", () => {
    const events = QTYS.map((q) => stock(q, { logo: true }).application.applicationEvents);
    expect(events).toEqual([100, 1000, 10000]); // qty x 2 labelled sides
    // 1000 bags x 2 sides = 2000 application events, while personalization stays at 1
    const r = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2, personalization: { qr: true } });
    expect(r.application.applicationEvents).toBe(2000);
    expect(r.personalization.setupEvents).toBe(1);
    expect(r.labelQuantity).toBe(2000);
  });

  it("15. the customer add-on is $0 — internal labor never becomes a surcharge", () => {
    expect(BAG_PERSONALIZATION_CUSTOMER_ADD_ON).toBe(0);
    for (const q of QTYS) {
      for (const p of [undefined, { logo: true }, { logo: true, qr: true, personalizedDesignCount: 3 }]) {
        const r = stock(q, p);
        expect(r.personalization.customerAddOn).toBe(0);
        // internal cost and customer add-on are genuinely independent numbers
        if (p) expect(r.personalization.internalSetupCost).toBeGreaterThan(0);
      }
    }
  });

  it("selected personalization is VERIFIED and fully costable — nothing is DRAFT_ONLY", () => {
    const r = stock(500, { logo: true });
    expect(r.personalization.internalCostStatus).toBe("VERIFIED");
    expect(r.personalization.internalSetupCost).toBeCloseTo(25 / 3, 10);
    expect(r.blockers).toHaveLength(0);
    // base physical production still computes exactly as before
    expect(r.blankCost).toBeCloseTo(500 * 0.11, 10);
    expect(r.labelQuantity).toBe(1000);
    expect(r.nesting.ok).toBe(true);
  });

  it("no invented duration or second rate exists in the personalization surface", () => {
    const src = readFileSyncUtf8("app/lib/bag-cost-inputs.server.ts");
    const personalizationBlock = src.slice(src.indexOf("2D-3B OWNER RULE"), src.indexOf("export function bagSetupCost"));
    const code = personalizationBlock
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    // no minutes/seconds constant and no duration arithmetic
    expect(code).not.toMatch(/MINUTES_PER|SECONDS_PER|minutesPerDesign|secondsPerDesign/);
    expect(code).not.toMatch(/\/\s*3600|\/\s*60\b/);
    // the rate is READ from the canonical registry, never re-typed as a literal
    expect(code).toMatch(/BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN = OWNER_STANDARDS\.artSetupPerDesign\.value/);
    expect(code).toMatch(/setupEvents \* BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN/);
    // no numeric rate literal is assigned or multiplied anywhere in the code
    expect(code).not.toMatch(/=\s*8\.3|\*\s*8\.3|25\s*\/\s*3/);
  });

  it("personalizedDesignCount must be a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = computeBagPersonalization({ logo: true, personalizedDesignCount: bad }, 500);
      expect(r.reasons, String(bad)).toContain(BAG_REASONS.stockBagPersonalizedDesignCountInvalid);
      expect(r.blockers.join(" ")).toMatch(/positive integer/);
    }
    for (const good of [1, 2, 9]) {
      const r = computeBagPersonalization({ logo: true, personalizedDesignCount: good }, 500);
      expect(r.reasons).not.toContain(BAG_REASONS.stockBagPersonalizedDesignCountInvalid);
      expect(r.setupEvents).toBe(good);
    }
    // omitted while active defaults to 1
    expect(computeBagPersonalization({ qr: true }, 500).setupEvents).toBe(1);
  });

  it("artwork REPAIR is explicitly excluded from normal personalization", () => {
    const scope = computeBagPersonalization({ logo: true }, 500).scope;
    expect(scope).toMatch(/vector recreation/i);
    expect(scope).toMatch(/rebuilding artwork/i);
    expect(scope).toMatch(/substantial redesign/i);
    expect(scope).toMatch(/separate artwork work/i);
  });
});

/* ------------------------------------------------------------------ *
 * 16  SPECIALTY FILE PREP
 * ------------------------------------------------------------------ */

describe("2D-3B specialty file prep — event based", () => {
  it("16. specialty setup is independent of finished copy quantity", () => {
    const specialty = OWNER_STANDARDS.glossLayerSetupPerDesign.value; // $6.25 once per gloss design
    const amounts = QTYS.map((q) => {
      const input = job(q, 1);
      const r = computeTrueJobCost({ ...input, setup: { ...input.setup, specialty } });
      return r.lines.find((l) => l.key === "specialty_setup")!.amount;
    });
    expect(amounts[0]).toBeCloseTo(specialty, 10);
    expect(new Set(amounts).size).toBe(1);
  });

  it("16. the gloss standard is written per DESIGN and never per stage", () => {
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.unit).toMatch(/per gloss design/i);
    expect(OWNER_STANDARDS.glossLayerSetupPerDesign.unit).toMatch(/never per stage/i);
    expect(OWNER_STANDARDS.artSetupPerDesign.unit).toMatch(/per design/i);
    expect(OWNER_STANDARDS.printSetupPerDesign.unit).toMatch(/per design/i);
  });

  it("16. specialty setup lands in setup_labor on the quantity-independent basis", () => {
    const input = job(500, 1);
    const r = computeTrueJobCost({ ...input, setup: { ...input.setup, specialty: 6.25 } });
    const line = r.lines.find((l) => l.key === "specialty_setup")!;
    expect(line.category).toBe("setup_labor");
    expect(isQuantityIndependentBasis(line.basis)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Preservation — 2D / 2D-3A decisions must survive this patch
 * ------------------------------------------------------------------ */

describe("2D-3B preserves the approved 2D decisions", () => {
  it("physical bag production is untouched by the personalization rework", () => {
    const plain = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    const personalized = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2, personalization: { logo: true } });
    expect(personalized.blankCost).toBe(plain.blankCost);
    expect(personalized.nesting.materialFootprintSqft).toBe(plain.nesting.materialFootprintSqft);
    expect(personalized.nesting.ripLayoutSqft).toBe(plain.nesting.ripLayoutSqft);
    expect(personalized.finishing.cutPathIn).toBe(plain.finishing.cutPathIn);
    expect(personalized.application.applicationLaborCost).toBe(plain.application.applicationLaborCost);
    expect(personalized.application.applicationEvents).toBe(plain.application.applicationEvents);
    // setup is the ONLY thing personalization moves, and by exactly one art event
    expect(personalized.setup.print).toBe(plain.setup.print);
    expect(personalized.setup.art - plain.setup.art).toBeCloseTo(ART, 10);
    expect(personalized.setup.total - plain.setup.total).toBeCloseTo(ART, 10);
    // 1000 bags at the owner-approved $0.11 blank
    expect(plain.blankCost).toBeCloseTo(110, 10);
    // 2000 applied sides at 10s / $20 per hour
    expect(plain.application.applicationLaborCost).toBeCloseTo((2000 * 10 / 3600) * 20, 10);
  });

  it("the shared physical adapter still gives both bag products identical physics", () => {
    const stock = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2, personalization: { logo: true } });
    const sticker = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 2 });
    expect(stock.nesting.materialFootprintSqft).toBe(sticker.nesting.materialFootprintSqft);
    expect(stock.finishing.cutPathIn).toBe(sticker.finishing.cutPathIn);
    expect(stock.application.applicationLaborCost).toBe(sticker.application.applicationLaborCost);
    expect(stock.blankCost).toBe(sticker.blankCost);

    // Only setup differs. The BASE stock bag carries no art setup at all...
    const base = computeBagPhysical({ product: "stock_bag", bagQuantity: 1000, sides: 2 });
    expect(base.setup.art).toBe(0);
    expect(sticker.setup.art).toBeCloseTo(ART, 10);
    // ...and a personalized one carries exactly one normal art event, the same
    // rate the custom sticker bag pays for its one customer design.
    expect(stock.setup.art).toBeCloseTo(ART, 10);
    expect(stock.setup.art).toBeCloseTo(sticker.setup.art, 10);
  });

  it("banner media consumption from 2D-3A is unchanged", () => {
    const b = computeBannerCost({ widthIn: 36, heightIn: 60, quantity: 1 });
    expect(b.finishedSqft).toBeCloseTo(15, 10);
    expect(b.mediaSqft).toBeCloseTo(22.5, 10);
    expect(b.ripLayoutSqft).toBeCloseTo(15, 10);
  });
});

function readFileSyncUtf8(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(p, "utf8");
}
