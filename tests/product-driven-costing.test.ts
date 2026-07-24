import { describe, expect, it } from "vitest";

import {
  MAX_LAYERS,
  PRODUCT_ENGINE_VERSION,
  WEEDING_PAGE_SQFT,
  computeProductDrivenCost,
  unitsPerBoxFor,
  validateLayers,
  type ProductDrivenInput,
} from "../app/lib/product-driven-costing.server";

function makeInput(overrides: Partial<ProductDrivenInput> = {}): ProductDrivenInput {
  return {
    family: "bags-4x5", quantity: 1000, designs: 2, facesPerUnit: 1, widthIn: 4, heightIn: 5,
    blank: { name: "4x5 Blank Bag", unitCost: 0.09, tiers: [], status: "verified" },
    lid: null,
    material: { name: "Matte vinyl", costPerSqft: 0.3156, rollLabel: "54in x 150ft" },
    printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6, machineMinutesPerSqft: 2, machineRatePerHour: 8,
    cutRequiresWeeding: false, hemming: false, grommets: false,
    freightPerUnit: 0.05, freightSource: "estimated",
    recipeWastePct: null, wasteOverride: null, boxOverride: null,
    ...overrides,
  };
}

describe("layers (14C.1)", () => {
  it("accepts 0-14, rejects negatives and 15+, clamps and warns", () => {
    expect(validateLayers(0).ok).toBe(true);
    expect(validateLayers(14).ok).toBe(true);
    expect(validateLayers(-1).ok).toBe(false);
    expect(validateLayers(15).ok).toBe(false);
    expect(validateLayers(15).value).toBe(MAX_LAYERS);
  });

  it("white layers scale linearly (provisional model, labeled); CMYK stays a separate base line", () => {
    const four = computeProductDrivenCost(makeInput({ whiteLayers: 4 }));
    const one = computeProductDrivenCost(makeInput({ whiteLayers: 1 }));
    const whiteFour = four.lines.find((line) => line.key === "ink_white")!;
    const whiteOne = one.lines.find((line) => line.key === "ink_white")!;
    expect(whiteFour.amount).toBeCloseTo(whiteOne.amount * 4, 6);
    expect(whiteFour.label).toContain("4 layer(s)");
    expect(whiteFour.label).toContain("provisional linear model");
    expect(four.lines.find((line) => line.key === "ink_cmyk")!.amount).toBeCloseTo(one.lines.find((l) => l.key === "ink_cmyk")!.amount, 6);
  });

  it("gloss layers on Mimaki without verified gloss cost are MISSING (never $0-final); Roland gloss is provisional-estimated", () => {
    const mimaki = computeProductDrivenCost(makeInput({ glossLayers: 7 }));
    const glossLine = mimaki.lines.find((line) => line.key === "ink_gloss")!;
    expect(glossLine.source).toBe("missing");
    expect(glossLine.note).toContain("GLOSS INK COST NOT VERIFIED");
    expect(mimaki.missing.length).toBeGreaterThan(0);
    const roland = computeProductDrivenCost(makeInput({ printer: "roland", printerHasGloss: true, glossLayers: 2 }));
    expect(roland.lines.find((line) => line.key === "ink_gloss")!.source).toBe("estimated");
  });

  it("extra passes are represented once via machine time; passes = 1 + white + gloss", () => {
    const base = computeProductDrivenCost(makeInput());
    const layered = computeProductDrivenCost(makeInput({ whiteLayers: 4, glossLayers: 0 }));
    expect(layered.derived.printPasses).toBe(5);
    expect(layered.lines.find((line) => line.key === "machine")!.amount).toBeCloseTo(base.lines.find((l) => l.key === "machine")!.amount * 5, 4);
    expect(layered.lines.filter((line) => line.key === "passes")).toHaveLength(1);
  });

  it("white layers on a printer without a white channel are ignored with a warning", () => {
    const result = computeProductDrivenCost(makeInput({ printerHasWhite: false, whiteLayers: 3 }));
    expect(result.lines.some((line) => line.key === "ink_white")).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("no white channel"))).toBe(true);
  });
});

describe("derived geometry, waste, boxes, weeding", () => {
  it("sqft derives from dimensions x quantity x faces; two faces double material pieces", () => {
    const one = computeProductDrivenCost(makeInput());
    expect(one.derived.baseSqft).toBeCloseTo((4 * 5 * 1000) / 144, 4);
    const two = computeProductDrivenCost(makeInput({ facesPerUnit: 2 }));
    expect(two.derived.totalPieces).toBe(2000);
    expect(two.derived.baseSqft).toBeCloseTo(one.derived.baseSqft * 2, 4);
  });

  it("missing dimensions block instead of assuming", () => {
    const result = computeProductDrivenCost(makeInput({ widthIn: 0 }));
    expect(result.missing.some((label) => label.includes("width and height"))).toBe(true);
  });

  it("waste precedence: recipe rule wins, override labeled with reason and original, provisional 10% labeled; applied once", () => {
    const recipe = computeProductDrivenCost(makeInput({ recipeWastePct: 4 }));
    expect(recipe.derived.wastePct).toBe(4);
    expect(recipe.derived.wasteSource).toContain("recipe");
    const override = computeProductDrivenCost(makeInput({ recipeWastePct: 4, wasteOverride: { pct: 8, reason: "tricky media" } }));
    expect(override.derived.wastePct).toBe(8);
    expect(override.derived.wasteSource).toContain("OVERRIDE");
    expect(override.derived.wasteSource).toContain("4");
    const provisional = computeProductDrivenCost(makeInput());
    expect(provisional.derived.wasteSource).toContain("PROVISIONAL");
    // waste applied exactly once: material amount = rate x base x mult
    const material = provisional.lines.find((line) => line.key === "material")!;
    expect(material.amount).toBeCloseTo(0.3156 * provisional.derived.baseSqft / 0.9, 4);
  });

  it("automatic boxes: bags 1000/box, 3oz 150, 4oz 100; packing $2/box; missing rule = estimated packout", () => {
    expect(unitsPerBoxFor("4x5 Blank Bag").unitsPerBox).toBe(1000);
    expect(unitsPerBoxFor("3 oz Matte Black Jar with Cap").unitsPerBox).toBe(150);
    expect(unitsPerBoxFor("4 oz Black Jar with Arch Cap").unitsPerBox).toBe(100);
    const bags = computeProductDrivenCost(makeInput({ quantity: 2500 }));
    expect(bags.derived.boxes).toBe(3); // ceil(2500/1000)
    expect(bags.lines.find((line) => line.key === "packing")!.amount).toBeCloseTo(6, 6);
    const unknown = computeProductDrivenCost(makeInput({ blank: { name: "Mystery pouch", unitCost: 0.5, tiers: [], status: "verified" } }));
    expect(unknown.derived.boxes).toBeNull();
    expect(unknown.lines.find((line) => line.key === "packing")!.source).toBe("estimated");
    const overridden = computeProductDrivenCost(makeInput({ boxOverride: { unitsPerBox: 500, reason: "half boxes" } }));
    expect(overridden.derived.boxes).toBe(2);
    expect(overridden.lines.find((line) => line.key === "packing")!.source).toBe("manual_override");
  });

  it("automatic weeding: pages from sqft only when the cut requires it; labeled estimated with basis", () => {
    const stickers = computeProductDrivenCost(makeInput({ family: "stickers-labels", blank: null, cutRequiresWeeding: true, quantity: 500 }));
    const expectedPages = Math.ceil(stickers.derived.baseSqft / WEEDING_PAGE_SQFT);
    expect(stickers.derived.weedingPages).toBe(expectedPages);
    const weeding = stickers.lines.find((line) => line.key === "weeding")!;
    expect(weeding.amount).toBeCloseTo((20 / 15) * expectedPages, 4);
    expect(weeding.source).toBe("estimated");
    const noWeed = computeProductDrivenCost(makeInput({ family: "stickers-labels", blank: null, cutRequiresWeeding: false }));
    expect(noWeed.lines.some((line) => line.key === "weeding")).toBe(false);
  });
});

describe("components", () => {
  it("blank resolves server-side with quantity tiers; Chiron cap included note, never a second cap line", () => {
    const chiron = computeProductDrivenCost(makeInput({
      family: "chiron-jars",
      blank: { name: "Chiron 150 ml Jar with Cap", unitCost: 1.9, tiers: [], status: "verified" },
    }));
    const blankLines = chiron.lines.filter((line) => line.key === "blank");
    expect(blankLines).toHaveLength(1);
    expect(blankLines[0].amount).toBeCloseTo(1900, 4);
    expect(blankLines[0].note).toContain("Cap included");
    expect(chiron.lines.some((line) => line.key === "lid")).toBe(false);
  });

  it("Miron jar and lid stay separate lines with their own tiers; missing lid blocks", () => {
    const miron = computeProductDrivenCost(makeInput({
      family: "miron-jars",
      blank: { name: "Miron 150 ml Jar", unitCost: 0, tiers: [{ minQty: 1, maxQty: 999, unitCost: 2.1 }, { minQty: 1000, maxQty: null, unitCost: 1.95 }], status: "verified" },
      lid: { name: "Black metal lid", unitCost: 0, tiers: [{ minQty: 1, maxQty: null, unitCost: 0.45 }], status: "verified" },
    }));
    expect(miron.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(1950, 4); // 1000-tier
    expect(miron.lines.find((line) => line.key === "top")!.amount).toBeCloseTo(450, 4);
    const noLid = computeProductDrivenCost(makeInput({ family: "miron-jars", blank: { name: "Miron 150 ml Jar", unitCost: 1.95, tiers: [], status: "verified" }, lid: null }));
    expect(noLid.missing.some((label) => label.includes("Top type"))).toBe(true);
  });

  it("component without a verified cost is MISSING, never $0-verified", () => {
    const result = computeProductDrivenCost(makeInput({ blank: { name: "Unpriced jar", unitCost: null, tiers: [], status: "verified" } }));
    const blank = result.lines.find((line) => line.key === "blank")!;
    expect(blank.source).toBe("missing");
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

describe("engine safety", () => {
  it("totals reconstruct from lines (no double waste/freight/setup) and engine version is 14C.1", () => {
    expect(PRODUCT_ENGINE_VERSION).toBe("14C.1");
    const result = computeProductDrivenCost(makeInput({ whiteLayers: 2 }));
    const lineTotal = result.lines.reduce((sum, line) => sum + line.amount, 0);
    expect(result.totalCost).toBeCloseTo(lineTotal, 6);
    expect(result.perUnitVariable * 1000 + result.setupTotal).toBeCloseTo(lineTotal, 4);
    expect(result.lines.filter((line) => line.key === "freight")).toHaveLength(1);
  });
});

// ---- 14C.1A family-selection activation pins ----
import { readFileSync } from "node:fs";

describe("family selection activation (14C.1A)", () => {
  const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  const pdf = src.slice(src.indexOf("function ProductDrivenForm"));

  it("the family select auto-submits via React Router useSubmit (client-side GET, embedded-safe)", () => {
    expect(pdf).toContain('onChange={(event) => submit(event.currentTarget.form, { method: "get" })}');
    expect(src).toContain("useSubmit } from \"react-router\"");
  });

  it("a submit path exists before any family is chosen (no-JS CONTINUE fallback) and loading feedback renders", () => {
    expect(pdf).toContain("CONTINUE");
    expect(pdf).toContain("Loading products…");
    expect(pdf.indexOf("CONTINUE")).toBeLessThan(pdf.indexOf("{family ?"));
  });

  it("consistent default state: empty value option first, begin prompt only when family inactive", () => {
    expect(pdf).toContain('<option value="">— choose a product —</option>');
    expect(pdf).toContain("Choose a product family to begin.");
  });

  it("empty product list shows an explanation instead of a broken dropdown", () => {
    expect(pdf).toContain("No active products are configured for this family");
  });

  it("canonical family values are consistent across form, loader, and engine (14C.1B set; legacy values accepted in loader)", () => {
    for (const key of ["bags-4x5", "standard-jars", "premium-jars", "stickers-labels", "banners", "custom"]) {
      expect(pdf).toContain(`value="${key}"`);
      expect(src).toContain(`"${key}"`);
    }
    for (const legacy of ["chiron-jars", "miron-jars"]) expect(src).toContain(`"${legacy}"`); // back-compat in loader/action
  });

  it("no nested Form inside ProductDrivenForm and no POST triggered by family selection", () => {
    const formBody = pdf.slice(pdf.indexOf("<Form method=\"get\""), pdf.indexOf("function ProductBreakdown"));
    expect((formBody.match(/<Form /g) || []).length).toBe(1);
    expect(formBody).not.toContain('method="post"');
    expect(formBody).not.toContain("saveEmergencyQuoteDraft");
  });
});

// ---- 14C.1B classification + premium jars ----
import { classifyCalculatorProduct, formatComponentLabel, mironTopCompatible, uiFamilyToEngine } from "../app/lib/product-driven-costing.server";

describe("product classification (14C.1B)", () => {
  it("classifies standard jars from structured productType; 5oz stays out of customer flow", () => {
    expect(classifyCalculatorProduct({ name: "3oz Black/White Jar", productType: "jar_3oz_black_white" }).klass).toBe("jar_standard");
    expect(classifyCalculatorProduct({ name: "4oz Clear Jar", productType: "jar_4oz_clear" }).includesTop).toBe(true);
    expect(classifyCalculatorProduct({ name: "5oz Clear Jar", productType: "jar_5oz_clear" }).klass).toBe("other");
  });

  it("classifies Miron via vendor/sku/name; combined jar+lid sets detected as includesTop; tops classified separately", () => {
    const set = classifyCalculatorProduct({ name: "150ml Miron jar + lid", vendor: "MIRON", vendorSku: "preset:miron-150ml" });
    expect(set.klass).toBe("jar_miron");
    expect(set.includesTop).toBe(true);
    const jarOnly = classifyCalculatorProduct({ name: "Miron 100ml Tall Jar", vendor: "MIRON" });
    expect(jarOnly.klass).toBe("jar_miron");
    expect(jarOnly.includesTop).toBe(false);
    expect(classifyCalculatorProduct({ name: "Miron classic top", vendor: "MIRON" }).klass).toBe("miron_top");
    expect(classifyCalculatorProduct({ name: "Miron black metal lid 100ml", vendor: "MIRON" }).klass).toBe("miron_top");
  });

  it("classifies Chiron/SAFECARE with cap always included; bags and other records", () => {
    const chiron = classifyCalculatorProduct({ name: "Chiron 150 ml Jar with Cap", vendor: "SAFECARE" });
    expect(chiron.klass).toBe("jar_chiron");
    expect(chiron.includesTop).toBe(true);
    expect(classifyCalculatorProduct({ name: "SAFECARE 100ml jar" }).klass).toBe("jar_chiron");
    expect(classifyCalculatorProduct({ name: "4x5 Blank Bag" }).klass).toBe("bag_4x5");
    expect(classifyCalculatorProduct({ name: "Banner vinyl roll" }).klass).toBe("other");
  });

  it("top compatibility: size-token match or universal; wrong size excluded", () => {
    expect(mironTopCompatible("Miron 100ml Tall Jar", "Classic top")).toBe(true); // universal
    expect(mironTopCompatible("Miron 100ml Tall Jar", "Black metal top 100ml")).toBe(true);
    expect(mironTopCompatible("Miron 100ml Tall Jar", "Black metal top 150ml")).toBe(false);
    expect(mironTopCompatible("Miron 50ml Jar", "Classic top 50ml")).toBe(true);
  });

  it("UI family maps to the right engine family; Miron sets with included lids do NOT require a top", () => {
    expect(uiFamilyToEngine("standard-jars", "jar_standard", true)).toBe("chiron-jars");
    expect(uiFamilyToEngine("premium-jars", "jar_chiron", true)).toBe("chiron-jars");
    expect(uiFamilyToEngine("premium-jars", "jar_miron", false)).toBe("miron-jars"); // top REQUIRED
    expect(uiFamilyToEngine("premium-jars", "jar_miron", true)).toBe("miron-jars"); // 14C.1B1: top ALWAYS required, even for jar+lid sets
    expect(uiFamilyToEngine("miron-jars", null, false)).toBe("miron-jars"); // legacy back-compat
    expect(uiFamilyToEngine("custom-item", null, false)).toBe("custom");
  });

  it("owner-facing labels are shared and clear", () => {
    expect(formatComponentLabel("Chiron 150 ml", "jar_chiron", true, "$1.90 — Verified")).toBe("Chiron 150 ml — cap included — $1.90 — Verified");
    expect(formatComponentLabel("Miron 100 ml Tall", "jar_miron", false, "tiered — Verified")).toBe("Miron 100 ml Tall — jar only, top required — tiered — Verified");
    expect(formatComponentLabel("150ml Miron jar + lid", "jar_miron", true, "tiered — Verified")).toContain("standard top included in vendor set");
    expect(formatComponentLabel("Miron 100 ml Tall", "jar_miron", false, "tiered — Verified")).toContain("jar only, top required");
  });
});

describe("premium-jar UI pins (14C.1B)", () => {
  const src2 = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  it("family options show Standard + combined Premium; no separate visible Chiron/Miron families", () => {
    expect(src2).toContain('<option value="standard-jars">Standard Jars</option>');
    expect(src2).toContain("Premium Jars — Chiron &amp; Miron");
    expect(src2).not.toContain('<option value="chiron-jars">Chiron Jars</option>');
    expect(src2).not.toContain('<option value="miron-jars">Miron Jars</option>');
  });
  it("premium picker uses CHIRON/MIRON optgroups; top selector is gated by topRequired; empty states exist", () => {
    expect(src2).toContain('<optgroup label="CHIRON">');
    expect(src2).toContain('<optgroup label="MIRON">');
    expect(src2).toContain("Top type (required for Miron)");
    expect(src2).toContain("No verified compatible tops are configured for this Miron jar.");
    expect(src2).toContain("No active standard jar products are configured.");
    expect(src2).toContain("No active verified 4x5 blank bag is configured.");
  });
  it("bag auto-selection renders read-only with a hidden resolved ID; save snapshots engine 14C.1B", () => {
    expect(src2).toContain("Verified (auto-selected)");
    expect(src2).toContain('engine: "14C.1B1-required-miron-top"');
    expect(src2).toContain("type:standard-top"); // canonical tops render even without Vendor Cost Book records
  });
});

// ---- 14C.1B1 required Miron top charge ----
import { TOP_ENGINE_VERSION, resolveMironTopLine } from "../app/lib/product-driven-costing.server";

describe("required Miron top (14C.1B1)", () => {
  const standardTop = { name: "Standard / Classic top", unitCost: 0.30, tiers: [], status: "verified" as const };
  const metalTop = { name: "Black metal top", unitCost: 0.45, tiers: [], status: "verified" as const };

  it("no selected top is a MISSING blocker — combined sets never bypass selection", () => {
    const line = resolveMironTopLine({ quantity: 100, selectedTop: null, policy: { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: false } });
    expect(line.source).toBe("missing");
    expect(line.label).toContain("Required");
    const engineMissing = computeProductDrivenCost(makeInput({ family: "miron-jars", blank: { name: "150ml Miron jar + lid", unitCost: 1.95, tiers: [], status: "verified" }, lid: null, mironTop: { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: false } }));
    expect(engineMissing.missing.some((label) => label.includes("Top type"))).toBe(true);
  });

  it("matching standard top on a combined set adds $0 incrementally with the included note", () => {
    const line = resolveMironTopLine({ quantity: 500, selectedTop: standardTop, policy: { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: true } });
    expect(line.amount).toBe(0);
    expect(line.source).toBe("verified");
    expect(line.label).toContain("included in selected Miron set");
  });

  it("different top on a combined set adds ONLY the verified upgrade difference — never the full top", () => {
    const line = resolveMironTopLine({ quantity: 100, selectedTop: metalTop, policy: { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: false } });
    expect(line.amount).toBeCloseTo((0.45 - 0.3) * 100, 6);
    expect(line.note).toContain("Upgrade difference");
  });

  it("unverifiable upgrade difference blocks final-ready — never assumed $0", () => {
    const unpriced = { name: "Black metal top", unitCost: null, tiers: [], status: "estimated" as const };
    const line = resolveMironTopLine({ quantity: 100, selectedTop: unpriced, policy: { setIncludesStandardTop: true, includedStandardTopCost: null, selectedTopIsStandard: false } });
    expect(line.source).toBe("missing");
    expect(line.note).toContain("TOP UPGRADE COST NOT VERIFIED");
  });

  it("true jar-only records add the full selected top cost (qty-tiered), counted once", () => {
    const line = resolveMironTopLine({ quantity: 1000, selectedTop: { ...metalTop, unitCost: 0, tiers: [{ minQty: 1, maxQty: 999, unitCost: 0.5 }, { minQty: 1000, maxQty: null, unitCost: 0.45 }] }, policy: { setIncludesStandardTop: false, includedStandardTopCost: null, selectedTopIsStandard: false } });
    expect(line.amount).toBeCloseTo(450, 4);
    expect(line.note).toContain("jar-only");
    expect(TOP_ENGINE_VERSION).toBe("14C.1B1-required-miron-top");
  });
});
