  it("2D-4D: multi-line jobs now emit canonical lines, with DECLARED artwork identity", () => {
    // The C2 stop condition is resolved: each additional line declares its
    // artwork relationship, so nothing has to be guessed from index or size.
    const route = routeSrc();
    expect(route).toContain('name="pslart"');
    expect(route).toContain("const resolveArtworkKey");
    expect(route).toContain('name={`pl${canonicalIndex}art`}');
    // and the old "cannot cost multi-line" notice is gone
    expect(route).not.toMatch(/Multi-line label jobs have no canonical true cost yet/);
  });// Patch 2D-4C2 — LIVE LABEL FORM -> CANONICAL WIRING.
//
// The 2D-4C production failure was NOT a costing bug: the live sticker form
// emitted pqty/pwidth/pheight/pmat, normalizeCanonicalInput reads pllines/pl0*,
// so `lines` came back EMPTY and every label job reported MISSING_MATERIAL_COST
// and MISSING_NESTING_MODEL. The 2D-4 suite missed it entirely because every
// test hand-built a perfect canonical query string.
//
// So these tests start from the PARAMS THE FORM ACTUALLY EMITS, reconstructed
// from the route source, and push them through the real normalisation path.
// A test that builds its own canonical input proves nothing about the form.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assembleCanonicalJob,
  computeCanonicalJob,
  normalizeCanonicalInput,
  resolveCanonicalMachineInputs,
} from "../app/lib/canonical-calculator.server";
import {
  canonicalCutTypeIsWireable,
  canonicalLabelCutType,
  canonicalLabelMaterialKey,
} from "../app/lib/canonical-calculator-shared";
import { LABEL_MATERIALS } from "../app/lib/label-cost-inputs.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { canonicalSaveGate, persistQuoteIfCanonicalAllows } from "../app/lib/canonical-quote-authority.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const routeSrc = () => readFileSync(ROUTE, "utf8");

/* ---- the four seeded production calibrations ---- */
const MEASURED: Record<string, any> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const SHOP = "942075-2.myshopify.com";
const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`, shop: SHOP, ...identity,
  inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null,
  timeModel: "variable_only", measuredAt: new Date(0), effectiveFrom: new Date(0),
  effectiveTo: null, status: "approved", source: "owner-measured", notes: null,
  supersedesId: null, createdAt: new Date(0), ...MEASURED[key],
}));
const deps = () => ({
  db: {
    machineProfileCalibration: {
      findMany: async ({ where }: any) =>
        ROWS.filter((row) => Object.entries(where).every(([f, v]) => (f === "shop" ? row.shop === v : (row as any)[f] === v))),
    },
  },
  shop: SHOP,
});

/* ------------------------------------------------------------------ *
 * THE LIVE FORM PARAM SHAPE
 *
 * Exactly what the browser submits for a single-line sticker job: the legacy
 * primary fields the operator fills in, PLUS the canonical mirror the form now
 * renders (pllines + pl0*), PLUS the operator-entered cutline.
 * ------------------------------------------------------------------ */

type FormState = {
  qty?: string; width?: string; height?: string; designs?: string;
  materialId?: string; materialName?: string; cut?: string;
  printer?: string; white?: string; gloss?: string;
  additionalLines?: number;
};

/** Mirrors the JSX: legacy fields always; canonical mirror only when wireable and single-line. */
function liveFormParams(state: FormState = {}): URLSearchParams {
  const s = {
    qty: "1000", width: "3", height: "3", designs: "1",
    materialId: "cmat_poseidon_matte", materialName: "Poseidon Matte Roll Media",
    cut: "square-rect",
    printer: "auto", white: "0", gloss: "0", additionalLines: 0, ...state,
  };
  const p = new URLSearchParams();
  // --- legacy primary fields (unchanged by 2D-4C2) ---
  p.set("pfamily", "stickers-labels");
  p.set("pqty", s.qty); p.set("pwidth", s.width); p.set("pheight", s.height);
  p.set("pdesigns", s.designs); p.set("pmat", s.materialId); p.set("pcut", s.cut);
  p.set("pprinter", s.printer); p.set("pwhitelayers", s.white); p.set("pglosslayers", s.gloss);
  if (s.additionalLines > 0) p.set("pslcount", String(s.additionalLines));

  const cutType = canonicalLabelCutType(s.cut);
  const wireable = canonicalCutTypeIsWireable(s.cut);
  // 2D-4C2A: NO cutline is submitted — it is derived from the artwork by the
  // GSO offset rule inside normalizeCanonicalInput.
  // --- canonical mirror of the primary line ---
  if (wireable && s.additionalLines === 0) {
    const designs = Math.max(1, Math.floor(Number(s.designs) || 1));
    p.set("pllines", "1");
    p.set("pl0qty", s.qty); p.set("pl0w", s.width); p.set("pl0h", s.height);
    p.set("pl0mat", canonicalLabelMaterialKey(s.materialName) || "");
    p.set("pl0cuttype", cutType);
    p.set("pl0art", "ART-1");
    if (designs > 1) p.set("pl0extraart", String(designs - 1));
    p.set("pl0printsetups", String(designs));
  }
  return p;
}

/* ================================================================== *
 * 1. LIVE PARAM SHAPE CONTRACT
 * ================================================================== */

describe("2D-4C2 (1) the live form param shape reaches the canonical adapter", () => {
  it("a real single-line submission normalises to ONE canonical physical line", () => {
    const input = normalizeCanonicalInput(liveFormParams())!;
    expect(input).not.toBeNull();
    expect(input.family).toBe("stickers-labels");
    expect(input.quantity).toBe(1000);
    expect(input.labels!.lines).toHaveLength(1);

    const line = input.labels!.lines[0];
    expect(line.quantity).toBe(1000);
    expect(line.printWidthIn).toBe(3);
    expect(line.printHeightIn).toBe(3);
    // derived by the GSO rule, not submitted
     expect(line.cutWidthIn).toBeCloseTo(2.875, 10);
    expect(line.cutHeightIn).toBeCloseTo(2.875, 10);
    expect(line.materialKey).toBe("matte");
    expect(line.artworkKey).toBeTruthy();
    expect(line.cutType).toBe("rectangular");
  });

  it("REGRESSION: the pre-2D-4C2 param shape produced ZERO lines", () => {
    // the exact production failure — legacy fields only
    const legacyOnly = new URLSearchParams({
      pfamily: "stickers-labels", pqty: "1000", pwidth: "3", pheight: "3",
      pdesigns: "1", pmat: "cmat_poseidon_matte", pcut: "square-rect",
      pprinter: "auto", pwhitelayers: "0", pglosslayers: "0",
    });
    expect(normalizeCanonicalInput(legacyOnly)!.labels!.lines).toHaveLength(0);
    // and the form now emits more than that
    expect(normalizeCanonicalInput(liveFormParams())!.labels!.lines).toHaveLength(1);
  });

  it("the form emits the EXACT names normalizeCanonicalInput reads", () => {
    const src = routeSrc();
    for (const name of ["pllines", "pl0qty", "pl0w", "pl0h", "pl0mat", "pl0art", "pl0cuttype"]) {
      expect(src, name).toContain(`name="${name}"`);
    }
    // and the legacy fields are NOT removed
    for (const legacy of ["pqty", "pwidth", "pheight", "pmat", "pcut", "pdesigns"]) {
      expect(src, legacy).toContain(`name="${legacy}"`);
    }
  });
});

/* ================================================================== *
 * 2. CONTROL JOB END TO END — through the live shape
 * ================================================================== */

describe("2D-4C2 (2) the owner control job costs through the live form shape", () => {
  it("1000 x 3x3 artwork (derived 2.875 cutline) / matte / AUTO returns the reference result", async () => {
    const result = await computeCanonicalJob(deps(), normalizeCanonicalInput(liveFormParams())!);

    expect(result.status).toBe("PROVISIONAL");
    expect(result.blockers).toHaveLength(0);
    expect(result.unitCost).not.toBeNull();
    expect(result.unitCost!).toBeCloseTo(0.079617, 6); // OWNER APPROVED 2026-10-07: machine recovery $5/hr (was $8/hr provisional); only machine-recovery lines moved.
    expect(result.totalCost).toBeCloseTo(79.617252, 5);

    expect(result.diagnostics.inkableArtworkSqft).toBeCloseTo(62.5, 6);
    expect(result.diagnostics.ripLayoutSqft!).toBeCloseTo(62.6875, 6);
    expect(result.diagnostics.mediaConsumedSqft).toBeCloseTo(66.375, 6);
    expect(result.diagnostics.machineMinutes!).toBeCloseTo(90.5, 1);

    const cmyk = result.inkChannels.find((c) => c.kind === "cmyk")!;
    expect(cmyk.totalMl!).toBeCloseTo(118.125, 4);
    expect(cmyk.inkCost!).toBeCloseTo(20.79, 4);
    expect(cmyk.occupancyMinutes!).toBeCloseTo(90.5207, 3);
    expect(result.routing.effectivePrinter).toBe("mimaki");
    expect(result.routing.machineKey).toBe("mimaki-ucjv300-130");
    expect(cmyk.identity.inkMode).toBe("cmyk_heavy");

    expect(result.reasons).toEqual(["FREIGHT_NOT_MODELED"]);
  });

  it("and it is therefore quote-eligible", async () => {
    const result = await computeCanonicalJob(deps(), normalizeCanonicalInput(liveFormParams())!);
    expect(canonicalSaveGate({ canonicalFamilyKey: "stickers-labels", canonical: result }).allowed).toBe(true);
    let created = 0;
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "stickers-labels", baseCanonical: result, selectedCanonical: result, selectedQuantity: 1000 },
      async () => { created += 1; return { id: "q" }; },
    );
    expect(created).toBe(1);
    expect(outcome.ok).toBe(true);
  });
});

/* ================================================================== *
 * 3 + 4. CUTLINE IS DERIVED BY THE OWNER RULE, AND STILL FAILS CLOSED
 *
 * 2D-4C2A superseded manual entry: GSO builds every label cutline from the
 * artwork with a -0.0625in inward offset, so staff never re-measure it. What
 * must still fail closed is MISSING OR INVALID ARTWORK — the rule has nothing
 * to offset from, and no cutline may be invented.
 * ================================================================== */

describe("2D-4C2A (3,4) the cutline is derived, and invalid artwork fails closed", () => {
  it("3x3 artwork yields the 2.875 x 2.875 cutline with no operator entry", () => {
    const params = liveFormParams();
    // the form does not submit a cutline at all
    expect(params.get("pl0cutw")).toBeNull();
    expect(params.get("pl0cuth")).toBeNull();
    const line = normalizeCanonicalInput(params)!.labels!.lines[0];
    expect(line.printWidthIn).toBe(3);
    expect(line.printHeightIn).toBe(3);
    expect(line.cutWidthIn).toBeCloseTo(2.875, 10);
    expect(line.cutHeightIn).toBeCloseTo(2.875, 10);
  });

  it("4x5 artwork yields 3.875 x 4.875", () => {
    const line = normalizeCanonicalInput(liveFormParams({ width: "4", height: "5" }))!.labels!.lines[0];
    expect(line.cutWidthIn).toBeCloseTo(3.875, 10);
    expect(line.cutHeightIn).toBeCloseTo(4.875, 10);
  });

  it("the cutline is NEVER the artboard — the offset is always applied", () => {
    for (const [w, h] of [["3", "3"], ["4", "5"], ["2", "6.5"]] as const) {
      const line = normalizeCanonicalInput(liveFormParams({ width: w, height: h }))!.labels!.lines[0];
      expect(line.cutWidthIn).not.toBeCloseTo(Number(w), 6);
      expect(line.cutHeightIn).not.toBeCloseTo(Number(h), 6);
      expect(Number(w) - line.cutWidthIn!).toBeCloseTo(0.125, 10);
      expect(Number(h) - line.cutHeightIn!).toBeCloseTo(0.125, 10);
    }
  });

  it("MISSING artwork fails closed — no cutline, no cost, save refused", async () => {
    const result = await computeCanonicalJob(deps(), normalizeCanonicalInput(liveFormParams({ width: "", height: "" }))!);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(canonicalSaveGate({ canonicalFamilyKey: "stickers-labels", canonical: result }).allowed).toBe(false);
    let created = 0;
    await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: "stickers-labels", baseCanonical: result, selectedCanonical: result, selectedQuantity: 1000 },
      async () => { created += 1; return { id: "q" }; },
    );
    expect(created).toBe(0);
  });

  it("artwork too small to offset produces NO cutline rather than zero or negative", () => {
    for (const size of ["0.125", "0.1", "0.05"]) {
      const line = normalizeCanonicalInput(liveFormParams({ width: size, height: size }))!.labels!.lines[0];
      expect(line.cutWidthIn, size).toBeUndefined();
      expect(line.cutHeightIn, size).toBeUndefined();
    }
  });

  it("the operator is never asked to type a cutline", () => {
    const src = routeSrc();
    expect(src).not.toContain('name="pl0cutw"');
    expect(src).not.toContain('name="pl0cuth"');
    // it is DISPLAYED instead, derived from the artwork
    expect(src).toContain("Canonical cutline:");
    expect(src).toContain("deriveGsoLabelCutlineFromArtboard(canonLine.w, canonLine.h)");
  });
});

/* ================================================================== *
 * 5. MATERIAL MAPPING
 * ================================================================== */

describe("2D-4C2 (5) live material resolves to the canonical key", () => {
  it("the production Poseidon Matte selection resolves to matte", () => {
    expect(canonicalLabelMaterialKey("Poseidon Matte Roll Media")).toBe("matte");
    expect(normalizeCanonicalInput(liveFormParams())!.labels!.lines[0].materialKey).toBe("matte");
  });

  it("gloss and holographic resolve too, and holographic wins over gloss", () => {
    expect(canonicalLabelMaterialKey("Poseidon Gloss Roll Media")).toBe("gloss");
    expect(canonicalLabelMaterialKey("Holographic Roll Media")).toBe("holographic");
    expect(canonicalLabelMaterialKey("Holographic Gloss Vinyl")).toBe("holographic");
  });

  it("every key it can return exists in LABEL_MATERIALS", () => {
    for (const name of ["Poseidon Matte Roll Media", "Poseidon Gloss Roll Media", "Holographic Roll Media"]) {
      const key = canonicalLabelMaterialKey(name)!;
      expect(LABEL_MATERIALS[key as keyof typeof LABEL_MATERIALS], name).toBeDefined();
    }
  });

  it("an unmappable material FAILS CLOSED — no rate is guessed", async () => {
    for (const name of ["Mystery Vinyl", "", null]) {
      expect(canonicalLabelMaterialKey(name)).toBeNull();
    }
    const result = await computeCanonicalJob(
      deps(), normalizeCanonicalInput(liveFormParams({ materialName: "Mystery Vinyl" }))!);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join(" ")).toMatch(/LABEL_MATERIAL_COST_REQUIRED/);
    expect(result.unitCost).toBeNull();
  });

  it("it selects a material but NEVER supplies a cost", () => {
    const src = readFileSync("app/lib/canonical-calculator-shared.ts", "utf8");
    const fn = src.slice(src.indexOf("export function canonicalLabelMaterialKey"), src.indexOf("export function canonicalLabelCutType"));
    expect(fn).not.toMatch(/costPerSqft|\d+\s*\/\s*\d+|APPROVED_ROLL_COSTS/);
  });
});

/* ================================================================== *
 * 6 + 7. MULTI-LINE AND ARTWORK IDENTITY
 * ================================================================== */

describe("2D-4C2 (6,7) multi-line jobs and artwork identity", () => {
  it("2D-4D: multi-line jobs now emit canonical lines, with DECLARED artwork identity", () => {
    // The C2 stop condition is resolved: each additional line declares its
    // artwork relationship, so nothing is guessed from index, size or material.
    const route = routeSrc();
    expect(route).toContain('name="pslart"');
    expect(route).toContain("const resolveArtworkKey");
    expect(route).toContain("pl${canonicalIndex}art");
    expect(route).toContain('name="pllines" value={String(1 + rows.length)}');
    // the old "cannot cost multi-line" notice is gone
    expect(route).not.toMatch(/Multi-line label jobs have no canonical true cost yet/);
  });

  it("row index is NEVER used as artwork identity", () => {
    const src = routeSrc();
    // the only artwork key the form emits is the single-line constant
    expect(src.match(/name="pl0art"/g)).toHaveLength(1);
    expect(src).not.toMatch(/name=\{`pl\$\{index\}art`\}/);
    expect(src).not.toMatch(/pl\$\{i\}art.*index/);
  });

  it("extra designs on ONE physical line are art events, not extra lines", () => {
    const input = normalizeCanonicalInput(liveFormParams({ designs: "3" }))!;
    expect(input.labels!.lines).toHaveLength(1);            // still ONE physical line
    const line = input.labels!.lines[0];
    expect(line.artworkKey).toBe("ART-1");
    expect(line.additionalArtSetupEvents).toBe(2);          // 1 + 2 = 3 art events
    expect(line.printSetupEvents).toBe(3);                  // 3 print-design setups
  });

  it("the canonical adapter agrees: 3 designs = 3 art setups on one line", async () => {
    const result = await computeCanonicalJob(deps(), normalizeCanonicalInput(liveFormParams({ designs: "3" }))!);
    expect(result.adapter.label!.setup.physicalLines).toBe(1);
    expect(result.adapter.label!.setup.artSetupEvents).toBe(3);
    expect(result.adapter.label!.setup.printSetupEvents).toBe(3);
  });

  it("C1 multi-line quantity protection is untouched", () => {
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(src).toContain("export function canonicalSupportsTierLadder");
    expect(src).toMatch(/return target === entered \? input : null;/);
  });
});

/* ================================================================== *
 * 8. CALCULATE / SAVE PARITY
 * ================================================================== */

describe("2D-4C2 (8) calculate and save normalise identically", () => {
  it("the same submitted form yields byte-identical canonical input on both paths", () => {
    const submitted = liveFormParams();
    // calculate: the loader reads url.searchParams
    const calc = normalizeCanonicalInput(new URLSearchParams(submitted.toString()));
    // save: the action replays that exact query string via psearch
    const psearch = `?${submitted.toString()}`;
    const save = normalizeCanonicalInput(new URLSearchParams(psearch.replace(/^\?/, "")));
    expect(JSON.stringify(save)).toBe(JSON.stringify(calc));
  });

  it("both paths produce the identical cost", async () => {
    const submitted = liveFormParams();
    const machine = await resolveCanonicalMachineInputs(deps(), normalizeCanonicalInput(submitted)!);
    const calc = assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(submitted.toString()))!, machine);
    const save = assembleCanonicalJob(normalizeCanonicalInput(new URLSearchParams(`?${submitted.toString()}`.replace(/^\?/, "")))!, machine);
    expect(save.totalCost).toBe(calc.totalCost);
    expect(save.unitCost).toBe(calc.unitCost);
    expect(save.status).toBe(calc.status);
  });

  it("the canonical params ride the GET form, so psearch carries them automatically", () => {
    const src = routeSrc();
    // the mirror lives INSIDE the product <Form method="get">
    const formStart = src.indexOf(`<Form method="get" onChange={(event) => syncCanonLine(event.currentTarget)}`);
    expect(formStart).toBeGreaterThan(0);
    expect(src.indexOf('name="pl0qty"')).toBeGreaterThan(formStart);
    expect(src.indexOf('name="pl0mat"')).toBeGreaterThan(formStart);
    // and the action still normalises from psearch, unchanged
    expect(src).toContain("const canonicalInputSave = normalizeCanonicalInput(psearchParams);");
  });
});

/* ================================================================== *
 * 9. C1 REGRESSION + scope guards
 * ================================================================== */

describe("2D-4C2 (9) C1 authority and scope are intact", () => {
  it("jars were fail-closed at this patch; 2D-4D1 promoted them, and a bad jar still cannot save", () => {
    for (const jar of ["standard-jars", "premium-jars"]) {
      const draftOnly = { family: jar, status: "DRAFT_ONLY" as const, unitCost: null, totalCost: 0, blockers: ["FAMILY_NOT_CANONICAL"] };
      expect(canonicalSaveGate({ canonicalFamilyKey: jar, canonical: draftOnly }).allowed, jar).toBe(false);
      // and a jar job with no canonical result at all is still refused
      expect(canonicalSaveGate({ canonicalFamilyKey: jar, canonical: null }).allowed, jar).toBe(false);
    }
  });

  it("DTP and Boxes remain legacy/outsourced", () => {
    for (const family of ["dtp-bags", "boxes"]) {
      expect(canonicalSaveGate({ canonicalFamilyKey: family, canonical: null }).allowed).toBe(true);
    }
  });

  it("the cutline blocker was not weakened", () => {
    const label = readFileSync("app/lib/label-cost-inputs.server.ts", "utf8");
    expect(label).toContain('{ [line.key]: { model: "separated_rectangle" } }; // artboard fallback -> blocks');
    expect(readFileSync("app/lib/finishing-cost.server.ts", "utf8")).toContain("cutlineGeometryRequired");
  });

  it("legacy inkMlPerSqft 0.6 is untouched", () => {
    expect((routeSrc().match(/inkMlPerSqft: 0\.6/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it("no second material-cost authority was introduced", () => {
    const shared = readFileSync("app/lib/canonical-calculator-shared.ts", "utf8");
    expect(shared).not.toContain("APPROVED_ROLL_COSTS");
    // LABEL_MATERIALS remains the only canonical label rate table
    expect(Object.keys(LABEL_MATERIALS)).toEqual(["matte", "gloss", "holographic"]);
  });
});
