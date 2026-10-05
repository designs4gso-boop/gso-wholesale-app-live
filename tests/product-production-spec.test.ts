// 2026-10-05 — ONE authoritative fixed-product production spec layer.
//
// Pins: (1) the client-safe geometry module is byte-identical to what the cost
// engine re-exports (no second authority), (2) every active jar resolves to a
// spec with the engine's dimensions, (3) placeholders (jar_5oz_clear) and
// non-active sizes are NOT exposed, (4) label sets are exactly the three owner
// options plus an optional tamper band, (5) override validation fails closed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ACTIVE_JAR_PROFILES } from "../app/lib/jar-active-scope";
import {
  JAR_LABEL_GEOMETRY,
  MAX_OVERRIDE_DIMENSION_IN,
  MIN_OVERRIDE_DIMENSION_IN,
  formatJarGeometry,
  validateJarGeometryOverride,
} from "../app/lib/jar-label-geometry";
import { JAR_LABEL_GEOMETRY as ENGINE_GEOMETRY, jarCutGeometry, jarPhysicalRuns } from "../app/lib/jar-cost-inputs.server";
import { BAG_4X5_ARTBOARD_IN } from "../app/lib/bag-artboard-geometry";
import { BAG_4X5_ARTBOARD_IN as ENGINE_BAG_ARTBOARD } from "../app/lib/bag-cost-inputs.server";
import {
  LABEL_SETS,
  describeStandardSpec,
  getProductProductionSpec,
  jarPiecesFor,
  labelSetSelection,
  listProductSpecs,
} from "../app/lib/product-production-spec";

describe("geometry extraction is behaviour-preserving", () => {
  it("the engine re-exports the SAME object as the client-safe module", () => {
    expect(ENGINE_GEOMETRY).toBe(JAR_LABEL_GEOMETRY);
    expect(ENGINE_BAG_ARTBOARD).toBe(BAG_4X5_ARTBOARD_IN);
  });

  it("the table holds exactly the Patch 2A owner presets (pinned, never inferred)", () => {
    expect(JAR_LABEL_GEOMETRY).toEqual({
      "50ml": { side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } },
      "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
      "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
      "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
      "250ml": { side: { widthIn: 9.4, heightIn: 2.9 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 9.4, heightIn: 0.6 } },
      "3oz": { side: { widthIn: 6.9, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 6.9, heightIn: 0.5 } },
      "4oz": { side: { widthIn: 7.125, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
    });
    expect(BAG_4X5_ARTBOARD_IN).toEqual({ widthIn: 4.0, heightIn: 5.0 });
  });

  it("the server module no longer carries its own copy of the numbers", () => {
    const src = readFileSync("app/lib/jar-cost-inputs.server.ts", "utf8");
    expect(src).not.toMatch(/"50ml": \{ side: \{ widthIn: 5\.6/);
    expect(src).toMatch(/from "\.\/jar-label-geometry"/);
    const bag = readFileSync("app/lib/bag-cost-inputs.server.ts", "utf8");
    expect(bag).not.toMatch(/BAG_4X5_ARTBOARD_IN = \{ widthIn: 4\.0/);
    expect(bag).toMatch(/from "\.\/bag-artboard-geometry"/);
  });

  it("the client-safe modules import nothing server-side", () => {
    for (const file of ["app/lib/jar-label-geometry.ts", "app/lib/bag-artboard-geometry.ts", "app/lib/product-production-spec.ts", "app/lib/weeding-standard.ts", "app/lib/weeding-benchmark.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\.server"/);
      expect(src, file).not.toMatch(/from "\.\.\/db/);
    }
  });
});

describe("listProductSpecs / getProductProductionSpec", () => {
  it("covers every ACTIVE jar profile exactly once plus the two 4x5 bag products", () => {
    const specs = listProductSpecs();
    const jarKeys = specs.filter((s) => s.family.endsWith("-jars")).map((s) => s.productKey);
    expect(jarKeys.sort()).toEqual(ACTIVE_JAR_PROFILES.map((p) => p.key).sort());
    expect(new Set(jarKeys).size).toBe(jarKeys.length);
    expect(specs.filter((s) => s.family === "sticker-bags").map((s) => s.productKey)).toEqual(["bag-4x5/sticker"]);
    expect(specs.filter((s) => s.family === "stock-bags").map((s) => s.productKey)).toEqual(["bag-4x5/stock"]);
    expect(specs.length).toBe(ACTIVE_JAR_PROFILES.length + 2);
  });

  it("the exact supported jar list: miron 50/100T/100W/150/250, chiron 100T/100W/150, standard 3oz/4oz", () => {
    const keys = listProductSpecs().filter((s) => s.family.endsWith("-jars")).map((s) => s.productKey).sort();
    expect(keys).toEqual([
      "chiron/100ml_tall", "chiron/100ml_wide", "chiron/150ml",
      "miron/100ml_tall", "miron/100ml_wide", "miron/150ml", "miron/250ml", "miron/50ml",
      "standard/3oz", "standard/4oz",
    ]);
  });

  it("never exposes the 5oz placeholder or any size outside the active scope", () => {
    const keys = listProductSpecs().map((s) => s.productKey);
    expect(keys.some((k) => /5oz/i.test(k))).toBe(false);
    expect(getProductProductionSpec("standard-jars", "standard/5oz")).toBeNull();
    expect(getProductProductionSpec("standard-jars", "jar_5oz_clear")).toBeNull();
    expect(getProductProductionSpec("premium-jars", "chiron/50ml")).toBeNull();
    expect(getProductProductionSpec("premium-jars", "")).toBeNull();
    expect(getProductProductionSpec("premium-jars", null)).toBeNull();
  });

  it("a jar spec carries the ENGINE dimensions, source metadata and COST_AUTHORITY status", () => {
    for (const profile of ACTIVE_JAR_PROFILES) {
      const spec = getProductProductionSpec(profile.uiFamily, profile.key)!;
      expect(spec, profile.key).not.toBeNull();
      expect(spec.status).toBe("COST_AUTHORITY");
      expect(spec.missing).toEqual([]);
      const g = JAR_LABEL_GEOMETRY[profile.size as keyof typeof JAR_LABEL_GEOMETRY];
      expect(spec.pieces).toEqual([
        { piece: "side", shape: "rect", widthIn: g.side.widthIn, heightIn: g.side.heightIn, quantityPerProduct: 1, label: "Side label" },
        { piece: "lid", shape: "circle", diameterIn: g.lid.diameterIn, quantityPerProduct: 1, label: "Lid label" },
        { piece: "tamper", shape: "rect", widthIn: g.tamper.widthIn, heightIn: g.tamper.heightIn, quantityPerProduct: 1, label: "Tamper / lid-side band" },
      ]);
      expect(spec.labelSets).toEqual(["side_only", "lid_only", "side_lid"]);
      expect(spec.source.module).toMatch(/jar-label-geometry/);
      expect(spec.source.authority).toMatch(/Patch 2A/);
      expect(spec.statusNote).toMatch(/RecipeLabelZone/); // the known conflicting seed is disclosed, not merged
    }
  });

  it("family filter is enforced: a standard jar does not resolve under premium-jars", () => {
    expect(getProductProductionSpec("premium-jars", "standard/3oz")).toBeNull();
    expect(getProductProductionSpec("standard-jars", "standard/3oz")).not.toBeNull();
    expect(getProductProductionSpec(null, "standard/3oz")).not.toBeNull();
  });

  it("tamper band availability mirrors the owner application timings (3oz/4oz have none)", () => {
    expect(getProductProductionSpec("standard-jars", "standard/3oz")!.optionalTamperBand).toBe(false);
    expect(getProductProductionSpec("standard-jars", "standard/4oz")!.optionalTamperBand).toBe(false);
    expect(getProductProductionSpec("premium-jars", "miron/50ml")!.optionalTamperBand).toBe(true);
    expect(getProductProductionSpec("premium-jars", "chiron/150ml")!.optionalTamperBand).toBe(true);
  });

  it("bag specs reuse the owner 4x5 artboard, MOQ 50 note, no label sets", () => {
    const bag = getProductProductionSpec("sticker-bags", "bag-4x5/sticker")!;
    expect(bag.pieces).toEqual([{ piece: "label", shape: "rect", widthIn: 4, heightIn: 5, quantityPerProduct: 1, label: "Applied label (per printed side)" }]);
    expect(bag.labelSets).toBeNull();
    expect(bag.moqNote).toMatch(/MOQ 50/);
    expect(describeStandardSpec(bag)).toBe("Applied label (per printed side) 4 x 5 in");
  });

  it("describeStandardSpec renders the read-only line and the fail-closed sentence", () => {
    const spec = getProductProductionSpec("premium-jars", "miron/100ml_wide")!;
    expect(describeStandardSpec(spec)).toBe("Side 6.6 x 2.6 in · Lid Ø 1.9 in · Tamper band 6.6 x 0.5 in");
    expect(describeStandardSpec(spec, { side: true, lid: true, tamper: false })).toBe("Side 6.6 x 2.6 in · Lid Ø 1.9 in");
    expect(describeStandardSpec({ ...spec, status: "OWNER_CONFIRMATION_REQUIRED" })).toBe("STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED");
  });
});

describe("label sets", () => {
  it("exactly Side Only / Lid Only / Side + Lid, tamper is an optional extra", () => {
    expect(LABEL_SETS.map((s) => [s.key, s.label])).toEqual([
      ["side_only", "Side Only"], ["lid_only", "Lid Only"], ["side_lid", "Side + Lid"],
    ]);
    expect(labelSetSelection("side_only")).toEqual({ side: true, lid: false, tamper: false });
    expect(labelSetSelection("lid_only")).toEqual({ side: false, lid: true, tamper: false });
    expect(labelSetSelection("side_lid")).toEqual({ side: true, lid: true, tamper: false });
    expect(labelSetSelection("side_lid", true)).toEqual({ side: true, lid: true, tamper: true });
    expect(labelSetSelection("both")).toBeNull();
    expect(labelSetSelection("")).toBeNull();
    expect(labelSetSelection(undefined)).toBeNull();
  });

  it("jarPiecesFor yields one piece per selected label", () => {
    const g = JAR_LABEL_GEOMETRY["250ml"];
    expect(jarPiecesFor(g, { side: true, lid: true, tamper: false }).map((p) => p.piece)).toEqual(["side", "lid"]);
    expect(jarPiecesFor(g, { side: false, lid: true, tamper: false }).map((p) => p.piece)).toEqual(["lid"]);
    expect(jarPiecesFor(g, { side: true, lid: true, tamper: true }).map((p) => p.piece)).toEqual(["side", "lid", "tamper"]);
  });
});

describe("validateJarGeometryOverride fails closed", () => {
  const sel = { side: true, lid: true, tamper: false };

  it("no override = the standard table, nothing overridden", () => {
    const r = validateJarGeometryOverride("100ml_wide", sel, null);
    expect(r.ok && r.overridden).toEqual([]);
    expect(r.ok && r.geometry).toBe(JAR_LABEL_GEOMETRY["100ml_wide"]);
    expect(validateJarGeometryOverride("100ml_wide", sel, undefined).ok).toBe(true);
  });

  it("a complete side override replaces ONLY the side; the lid stays standard", () => {
    const r = validateJarGeometryOverride("100ml_wide", sel, { side: { widthIn: 7, heightIn: 3 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.overridden).toEqual(["side"]);
      expect(r.geometry.side).toEqual({ widthIn: 7, heightIn: 3 });
      expect(r.geometry.lid).toEqual({ diameterIn: 1.9 });
      expect(JAR_LABEL_GEOMETRY["100ml_wide"].side).toEqual({ widthIn: 6.6, heightIn: 2.6 }); // table untouched
    }
  });

  it("half-entered pieces are refused, never defaulted", () => {
    expect(validateJarGeometryOverride("100ml_wide", sel, { side: { widthIn: 7, heightIn: NaN } }).ok).toBe(false);
    expect(validateJarGeometryOverride("100ml_wide", sel, { side: { widthIn: 7 } as any }).ok).toBe(false);
    expect(validateJarGeometryOverride("100ml_wide", sel, { lid: { diameterIn: NaN } }).ok).toBe(false);
  });

  it("zero, negative, non-finite and extreme values are refused", () => {
    for (const bad of [0, -1, Infinity, Number.NaN, MIN_OVERRIDE_DIMENSION_IN / 2, MAX_OVERRIDE_DIMENSION_IN + 1, 1e6]) {
      expect(validateJarGeometryOverride("100ml_wide", sel, { lid: { diameterIn: bad } }).ok, `lid ${bad}`).toBe(false);
      expect(validateJarGeometryOverride("100ml_wide", sel, { side: { widthIn: bad, heightIn: 2 } }).ok, `side w ${bad}`).toBe(false);
    }
    expect(validateJarGeometryOverride("100ml_wide", sel, { lid: { diameterIn: MIN_OVERRIDE_DIMENSION_IN } }).ok).toBe(true);
    expect(validateJarGeometryOverride("100ml_wide", sel, { lid: { diameterIn: MAX_OVERRIDE_DIMENSION_IN } }).ok).toBe(true);
  });

  it("an override for a label that is NOT in the set is a conflict, not a silent extra", () => {
    const r = validateJarGeometryOverride("100ml_wide", { side: true, lid: false, tamper: false }, { lid: { diameterIn: 2 } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/not in the selected label set/);
    const t = validateJarGeometryOverride("100ml_wide", sel, { tamper: { widthIn: 6, heightIn: 0.5 } });
    expect(t.ok).toBe(false);
  });

  it("an unknown size has no standard to override", () => {
    const r = validateJarGeometryOverride("5oz" as any, sel, null);
    expect(r.ok).toBe(false);
  });

  it("the engine's run/cut builders honour a validated override and ignore nothing else", () => {
    const r = validateJarGeometryOverride("100ml_wide", sel, { side: { widthIn: 7, heightIn: 3 } });
    if (!r.ok) throw new Error("expected ok");
    const runs = jarPhysicalRuns("100ml_wide", sel, 10, r.geometry);
    expect(runs[0].items[0]).toMatchObject({ widthIn: 7, heightIn: 3, quantity: 10 });
    expect(runs[1].items[0]).toMatchObject({ widthIn: 1.9, heightIn: 1.9 });
    const cut = jarCutGeometry("100ml_wide", r.geometry) as any;
    expect(cut.side.cutWidthIn).toBeCloseTo(7 - 0.125, 6);
    expect(cut.lid.cutDiameterIn).toBeCloseTo(1.9 - 0.125, 6);
    // and with NO override the builders are the pre-2026-10-05 behaviour
    expect(jarPhysicalRuns("100ml_wide", sel, 10)).toEqual(jarPhysicalRuns("100ml_wide", sel, 10, null));
    expect(jarCutGeometry("100ml_wide")).toEqual(jarCutGeometry("100ml_wide", undefined));
  });

  it("formatJarGeometry is the read-only line staff see", () => {
    expect(formatJarGeometry(JAR_LABEL_GEOMETRY["50ml"], { side: true, lid: false, tamper: false })).toBe("Side 5.6 x 1.5 in");
  });
});
