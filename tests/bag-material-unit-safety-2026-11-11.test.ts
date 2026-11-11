// 2026-11-11 — (A) the SELECTED bag label media controls 4x5 / Stock / Split
// bag true cost (no silent Poseidon Matte), through the ONE Material Center
// resolver; (B) Material Center unit safety: a purchase price per roll / pack /
// each is never accepted as a $/sqft.

import { describe, expect, it } from "vitest";
import { attachVerifiedLabelMaterials, areaCostUnitBasisIssues, materialCalculatorReadiness } from "../app/lib/material-calculator-readiness.server";
import { assembleCanonicalJob, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { LABEL_MATERIALS } from "../app/lib/label-cost-inputs.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal", shop: "shop-1", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk_heavy", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "x",
    mlPerSqftPerPass: 1.89, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: null, timeModel: "variable_only",
    coverageBasisPct: null, measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved", inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl, inkCostSource: "canonical",
};

const MEDIA = { shop: "shop-1", materialType: "roll_media", unit: "sqft", baseUnit: "sqft", costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor", rollWidthIn: 54 };
const RECORDS: any[] = [
  { ...MEDIA, id: "m_matte", name: "Poseidon Matte", productFamilies: "labels", costPerUnit: 0.31, calculatedUnitCost: 0.31, purchaseUnit: "roll", purchaseCost: 0 },
  { ...MEDIA, id: "m_clear", name: "Clear Material", productFamilies: "labels", costPerUnit: 0.3227, calculatedUnitCost: 0.3227, purchaseUnit: "roll", purchaseCost: 0, rollLengthFt: 150 },
  { ...MEDIA, id: "m_bagonly", name: "Bag Clear Gloss", productFamilies: "sticker_bags", costPerUnit: 0.4, calculatedUnitCost: 0.4, purchaseUnit: "sqft", purchaseCost: 0.4 },
  { ...MEDIA, id: "m_nowidth", name: "Glow Matte", productFamilies: "labels", costPerUnit: 0.5, calculatedUnitCost: 0.5, purchaseUnit: "roll", purchaseCost: 0, rollWidthIn: null },
  { ...MEDIA, id: "m_other_shop", shop: "shop-2", name: "Clear Material", productFamilies: "labels", costPerUnit: 0.01, calculatedUnitCost: 0.01, purchaseUnit: "roll", purchaseCost: 0 },
];
const db = { material: { findFirst: async ({ where }: any) => RECORDS.find((r) => r.shop === where.shop && r.id === where.id) ?? null, findMany: async () => [] } };

const BAG = (extra: string) => `pfamily=sticker-bags&pqty=1000&pbagsides=1&pdesigns=1&pprinter=mimaki&pwhitelayers=0&pglosslayers=0${extra}`;
async function cost(qs: string) {
  const input = await attachVerifiedLabelMaterials({ db, shop: "shop-1" }, normalizeCanonicalInput(new URLSearchParams(qs))!);
  return assembleCanonicalJob(input, CAL);
}
const media = (r: any) => r.trueCost.lines.find((l: any) => l.key === "print_media");

describe("A. bag label media sets true cost", () => {
  it("matte / gloss / holographic use their own approved roll rates (holographic nests on 50in)", async () => {
    for (const key of ["matte", "gloss", "holographic"] as const) {
      const r = await cost(BAG(`&pbagmat=${key}`));
      expect(r.status, key).not.toBe("DRAFT_ONLY");
      expect(media(r).amount / r.diagnostics.mediaConsumedSqft, key).toBeCloseTo(LABEL_MATERIALS[key].costPerSqft, 9);
    }
    const holo = await cost(BAG("&pbagmat=holographic"));
    const matte = await cost(BAG("&pbagmat=matte"));
    expect(media(holo).amount).toBeGreaterThan(media(matte).amount);
  });

  it("the form's Material Center selection (pmat) is resolved on the server and wins over a posted key", async () => {
    const r = await cost(BAG("&pmat=m_clear&pbagmat=holographic"));
    expect(media(r).amount / r.diagnostics.mediaConsumedSqft).toBeCloseTo(0.3227, 9);
    const approved = await cost(BAG("&pmat=m_matte"));
    expect(media(approved).amount / approved.diagnostics.mediaConsumedSqft).toBeCloseTo(LABEL_MATERIALS.matte.costPerSqft, 9); // approved roll rate, not the record's 0.31
    const bagOnly = await cost(BAG("&pmat=m_bagonly"));
    expect(bagOnly.status).not.toBe("DRAFT_ONLY"); // Sticker Bags family counts for bag labels
  });

  it("no material, an unready material, or another shop's material BLOCKS — never Matte, never $0", async () => {
    for (const extra of ["", "&pmat=m_nowidth", "&pmat=m_other_shop", "&pmat=missing", "&pbagmat=material%3Am_other_shop"]) {
      const r = await cost(BAG(extra));
      expect(r.status, extra).toBe("DRAFT_ONLY");
      expect(r.unitCost, extra).toBeNull();
      expect(r.blockers.join(" "), extra).toContain("MISSING_MATERIAL_COST");
    }
    expect((await cost(BAG("&pmat=m_nowidth"))).blockers.join(" ")).toContain("Roll width is missing.");
  });

  it("Stock Bags and Split Bags use the same selected-media authority", async () => {
    for (const flag of ["&pstockbag=1", "&psplitbag=1"]) {
      expect((await cost(BAG(`${flag}&pmat=m_clear`))).status, flag).not.toBe("DRAFT_ONLY");
      expect((await cost(BAG(flag))).status, flag).toBe("DRAFT_ONLY");
    }
  });
});

describe("B. Material Center unit safety", () => {
  const base = { ...MEDIA, id: "x", name: "Some Film", productFamilies: "labels" };
  it("a raw purchase price per each / pack / case / box is never a $/sqft", () => {
    for (const purchaseUnit of ["each", "pack", "case", "box", "sheet"]) {
      const r = materialCalculatorReadiness({ ...base, purchaseUnit, purchaseCost: 205, costPerUnit: 205, calculatedUnitCost: 205 });
      expect(r.ready, purchaseUnit).toBe(false);
      expect(r.missing.join(" "), purchaseUnit).toContain("UNIT_BASIS_REQUIRED");
    }
  });
  it("a roll price is accepted only when width x length derive the stored $/sqft", () => {
    const derived = 213 / ((54 * 150 * 12) / 144); // 0.3155...
    expect(materialCalculatorReadiness({ ...base, purchaseUnit: "roll", purchaseCost: 213, rollLengthFt: 150, calculatedUnitCost: derived, costPerUnit: derived }).ready).toBe(true);
    expect(materialCalculatorReadiness({ ...base, purchaseUnit: "roll", purchaseCost: 213, rollLengthFt: 150, calculatedUnitCost: 213, costPerUnit: 213 }).missing.join(" ")).toContain("does not match roll price");
    expect(materialCalculatorReadiness({ ...base, purchaseUnit: "roll", purchaseCost: 213, rollLengthFt: null, calculatedUnitCost: 0.3, costPerUnit: 0.3 }).missing.join(" ")).toContain("Roll length/width missing");
  });
  it("explicit area costs stay valid (purchased per sqft, or entered directly with no purchase price)", () => {
    expect(areaCostUnitBasisIssues({ purchaseUnit: "sqft", purchaseCost: 0.4 }, 0.4)).toEqual([]);
    expect(areaCostUnitBasisIssues({ purchaseUnit: "each", purchaseCost: 0 }, 0.3227)).toEqual([]);
    // the live Clear Material shape stays calculator-ready
    expect(materialCalculatorReadiness(RECORDS[1])).toMatchObject({ ready: true, costPerSqft: 0.3227 });
  });
});

/* ---- 2026-11-11 final pass: JAR label media (same authority as bags) ---- */
const JAR = (extra: string, labels = "&pjarside=1&pjarlid=1") => `pfamily=premium-jars&pqty=500&pjar=miron/100ml_wide&pcmykcoverage=40&pprinter=mimaki&pwhitelayers=0&pglosslayers=0${labels}${extra}`;

describe("C. jar label media sets jar true cost", () => {
  it("matte / gloss / holographic use their approved rates; holographic nests on 50in and costs more", async () => {
    for (const key of ["matte", "gloss", "holographic"] as const) {
      const r = await cost(JAR(`&pjarmat=${key}`));
      expect(r.blockers.join(" "), key).not.toContain("MISSING_MATERIAL_COST");
      expect(media(r).amount / r.diagnostics.mediaConsumedSqft, key).toBeCloseTo(LABEL_MATERIALS[key].costPerSqft, 9);
    }
    expect(media(await cost(JAR("&pjarmat=holographic"))).amount).toBeGreaterThan(media(await cost(JAR("&pjarmat=matte"))).amount);
  });
  it("a calculator-ready Material Center media (Clear) costs at its own stored rate", async () => {
    const r = await cost(JAR("&pmat=m_clear"));
    expect(media(r).amount / r.diagnostics.mediaConsumedSqft).toBeCloseTo(0.3227, 9);
    expect(media(r).label).toContain("Clear Material");
  });
  it("side only, lid only, side + lid and + tamper all print on the selected media", async () => {
    for (const labels of ["&pjarside=1", "&pjarlid=1", "&pjarside=1&pjarlid=1", "&pjarside=1&pjarlid=1&pjartamper=1"]) {
      const r = await cost(JAR("&pmat=m_clear", labels));
      if (r.status === "DRAFT_ONLY") expect(r.blockers.join(" "), labels).not.toContain("MISSING_MATERIAL_COST");
      else expect(media(r).amount / r.diagnostics.mediaConsumedSqft, labels).toBeCloseTo(0.3227, 9);
    }
  });
  it("no media, an unready media or another shop's media BLOCKS — never Poseidon Matte, never $0", async () => {
    for (const extra of ["", "&pmat=m_nowidth", "&pmat=m_other_shop", "&pmat=missing"]) {
      const r = await cost(JAR(extra));
      expect(r.status, extra).toBe("DRAFT_ONLY");
      expect(r.unitCost, extra).toBeNull();
      expect(r.blockers.join(" "), extra).toContain("MISSING_MATERIAL_COST");
    }
  });
  it("standard jars use the same authority", async () => {
    const qs = "pfamily=standard-jars&pqty=500&pjar=standard/4oz&pjarvariant=clear&pjarside=1&pcmykcoverage=40&pprinter=mimaki&pwhitelayers=0&pglosslayers=0";
    expect((await cost(qs)).blockers.join(" ")).toContain("MISSING_MATERIAL_COST");
    expect((await cost(`${qs}&pmat=m_clear`)).blockers.join(" ")).not.toContain("MISSING_MATERIAL_COST");
  });
});
