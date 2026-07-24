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

  it("canonical family values are consistent across form, loader, and engine (14C.2 set; legacy values accepted in loader)", () => {
    for (const key of ["sticker-bags", "standard-jars", "premium-jars", "stickers-labels", "banners", "custom-item"]) {
      expect(pdf).toContain(`value="${key}"`);
      expect(src).toContain(`"${key}"`);
    }
    for (const legacy of ["bags-4x5", "chiron-jars", "miron-jars", "custom"]) expect(src).toContain(`"${legacy}"`); // back-compat in loader/action
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
  it("classifies standard jars from structured productType; 5oz is a STANDARD jar (owner rule 14C.2A)", () => {
    expect(classifyCalculatorProduct({ name: "3oz Black/White Jar", productType: "jar_3oz_black_white" }).klass).toBe("jar_standard");
    expect(classifyCalculatorProduct({ name: "4oz Clear Jar", productType: "jar_4oz_clear" }).includesTop).toBe(true);
    expect(classifyCalculatorProduct({ name: "5oz Clear Jar", productType: "jar_5oz_clear" }).klass).toBe("jar_standard");
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

  it("classifies EXPLICIT Chiron with cap always included; SAFE CARE alone is NOT Chiron (owner rule 14C.2A)", () => {
    const chiron = classifyCalculatorProduct({ name: "Chiron 150 ml Jar with Cap", vendor: "SAFECARE" });
    expect(chiron.klass).toBe("jar_chiron");
    expect(chiron.includesTop).toBe(true);
    expect(classifyCalculatorProduct({ name: "SAFECARE 100ml jar" }).klass).toBe("jar_standard"); // vendor alone never implies Chiron
    expect(classifyCalculatorProduct({ name: "4x5 Blank Bag" }).klass).toBe("bag_sticker");
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
    expect(src2).toContain("No active sticker-bag products are configured.");
  });
  it("bag auto-selection renders read-only with a hidden resolved ID; save snapshots the 14C.2 engine + top engine", () => {
    expect(src2).toContain("Verified (auto-selected)");
    expect(src2).toContain("engine: MULTILABEL_ENGINE_VERSION");
    expect(src2).toContain("topEngine: TOP_ENGINE_VERSION");
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

// ---- 14C.2: Chiron restoration, data-driven sticker bags, multi-label jars,
// automatic tiers. Classification fixtures use the ACTUAL live records
// reported by the read-only VendorProduct inspection (2026-07-24).
import {
  MAX_LABELS_PER_UNIT,
  MULTILABEL_ENGINE_VERSION,
  REQUIRED_STICKER_BAG_SIZES,
  bagApplicationRateFor,
  bagSizeToken,
  blankClassAllowedFor,
  buildLabelRows,
  canonicalUiFamily,
  defaultLabelTypesFor,
  enforceFlatChironCost,
  marginFamilyKeyFor,
} from "../app/lib/product-driven-costing.server";

describe("corrected jar catalog (14C.2A — owner-authoritative rules)", () => {
  it("the ACTUAL Safe Care 3oz/4oz/5oz records are STANDARD jars — SAFE CARE vendor alone never implies Chiron", () => {
    const real = [
      { name: "3oz jar - clear", vendor: "SAFE CARE", vendorSku: "preset:3oz-jar-clear", productType: "jar" },
      { name: "3oz jar - black/white", vendor: "SAFE CARE", vendorSku: "preset:3oz-jar-black-white", productType: "jar" },
      { name: "4oz jar - clear", vendor: "SAFE CARE", vendorSku: "preset:4oz-jar-clear", productType: "jar" },
      { name: "4oz jar - black/white", vendor: "SAFE CARE", vendorSku: "preset:4oz-jar-black-white", productType: "jar" },
      { name: "5oz jar - clear", vendor: "SAFE CARE", vendorSku: "preset:5oz-jar-clear", productType: "jar" },
    ];
    for (const record of real) {
      const result = classifyCalculatorProduct(record);
      expect(result.klass).toBe("jar_standard");
      expect(result.includesTop).toBe(true); // cap counted once, never a second cap line
    }
  });

  it("the seeded Chiron 100/150 ml records classify jar_chiron with the exact owner-facing labels", () => {
    const chiron100 = classifyCalculatorProduct({ name: "Chiron 100 ml", vendor: "CHIRON", vendorSku: "chiron-100ml", productType: "jar" });
    const chiron150 = classifyCalculatorProduct({ name: "Chiron 150 ml", vendor: "CHIRON", vendorSku: "chiron-150ml", productType: "jar" });
    expect(chiron100.klass).toBe("jar_chiron");
    expect(chiron150.klass).toBe("jar_chiron");
    expect(formatComponentLabel("Chiron 100 ml", "jar_chiron", true, "$1.80 — Verified")).toBe("Chiron 100 ml — cap included — $1.80 — Verified");
    expect(formatComponentLabel("Chiron 150 ml", "jar_chiron", true, "$1.90 — Verified")).toBe("Chiron 150 ml — cap included — $1.90 — Verified");
    // Miron precedence beats Chiron/generic and stays tier-priced
    expect(classifyCalculatorProduct({ name: "150ml Miron jar + lid", vendor: "MIRON", productType: "jar" }).klass).toBe("jar_miron");
  });

  it("family/class fit: Chiron in Premium only; standard jars in Standard only; no cross-family leakage", () => {
    expect(blankClassAllowedFor("premium-jars", "jar_chiron")).toBe(true);
    expect(blankClassAllowedFor("standard-jars", "jar_chiron")).toBe(false);
    expect(blankClassAllowedFor("standard-jars", "jar_miron")).toBe(false);
    expect(blankClassAllowedFor("standard-jars", "jar_standard")).toBe(true);
    expect(blankClassAllowedFor("premium-jars", "jar_standard")).toBe(false); // 3/4/5 oz never under CHIRON
    expect(blankClassAllowedFor("sticker-bags", "bag_sticker")).toBe(true);
    expect(blankClassAllowedFor("sticker-bags", "jar_chiron")).toBe(false);
  });

  it("Chiron blank cost is FLAT at every quantity — $1.80/100ml, $1.90/150ml; tiers ignored; cap once; no top line", () => {
    const flat100 = { name: "Chiron 100 ml", unitCost: 1.8, tiers: [], status: "verified" as const };
    for (const qty of [1, 128, 1000, 5000]) {
      const run = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: qty, blank: flat100 }));
      const blank = run.lines.find((line) => line.key === "blank")!;
      expect(blank.amount).toBeCloseTo(1.8 * qty, 4); // no quantity-tier cost drift
      expect(run.lines.filter((line) => line.key === "blank")).toHaveLength(1);
      expect(blank.note).toContain("Cap included");
      expect(run.lines.some((line) => line.key === "top")).toBe(false); // no top selector/line for Chiron
    }
    const flat150 = { name: "Chiron 150 ml", unitCost: 1.9, tiers: [], status: "verified" as const };
    for (const qty of [1, 128, 1000, 5000]) {
      const run = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: qty, blank: flat150 }));
      expect(run.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(1.9 * qty, 4);
    }
    // stray tiers on a Chiron record are stripped by the centralized guard
    const withStrayTiers = enforceFlatChironCost({ name: "Chiron 100 ml", unitCost: 1.8, tiers: [{ minQty: 1000, maxQty: null, unitCost: 1.2 }], status: "verified" }, "jar_chiron")!;
    expect(withStrayTiers.tiers).toHaveLength(0);
    expect(enforceFlatChironCost({ name: "150ml Miron jar + lid", unitCost: 3.26, tiers: [{ minQty: 1, maxQty: null, unitCost: 3.26 }], status: "verified" }, "jar_miron")!.tiers).toHaveLength(1); // Miron tiers untouched
  });

  it("selecting Chiron hides the top selector, prices the cap ONCE, and ignores any stale top selection", () => {
    expect(uiFamilyToEngine("premium-jars", "jar_chiron", true)).toBe("chiron-jars");
    const chiron = computeProductDrivenCost(makeInput({
      family: "chiron-jars",
      blank: { name: "Chiron 100 ml", unitCost: 1.8, tiers: [], status: "verified" },
      lid: { name: "Standard / Classic top", unitCost: 0.3, tiers: [], status: "verified" }, // stale from a Miron switch
    }));
    expect(chiron.lines.filter((line) => line.key === "blank")).toHaveLength(1);
    expect(chiron.lines.find((line) => line.key === "blank")!.note).toContain("Cap included");
    expect(chiron.lines.some((line) => line.key === "top")).toBe(false); // top cleared — never double-counted
  });

  it("Miron tier pricing is preserved — blank cost still resolves by configured quantity tier", () => {
    const mironTiers = [
      { minQty: 1, maxQty: 249, unitCost: 3.26 }, { minQty: 250, maxQty: 499, unitCost: 3.0 },
      { minQty: 500, maxQty: 999, unitCost: 2.76 }, { minQty: 1000, maxQty: 2499, unitCost: 2.54 },
      { minQty: 2500, maxQty: null, unitCost: 2.37 },
    ];
    const blank = { name: "150ml Miron jar + lid", unitCost: 3.26, tiers: mironTiers, status: "verified" as const };
    const top = { name: "Standard / Classic top", unitCost: 0.3, tiers: [], status: "verified" as const };
    const policy = { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: true };
    const at128 = computeProductDrivenCost(makeInput({ family: "miron-jars", quantity: 128, blank, lid: top, mironTop: policy }));
    const at1000 = computeProductDrivenCost(makeInput({ family: "miron-jars", quantity: 1000, blank, lid: top, mironTop: policy }));
    expect(at128.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(3.26 * 128, 4);
    expect(at1000.lines.find((line) => line.key === "blank")!.amount).toBeCloseTo(2.54 * 1000, 4); // tier drop preserved
    expect(at1000.lines.find((line) => line.key === "top")!.amount).toBe(0); // included-top logic unchanged
    const noTop = computeProductDrivenCost(makeInput({ family: "miron-jars", quantity: 128, blank, lid: null, mironTop: policy }));
    expect(noTop.missing.some((label) => label.includes("Top type"))).toBe(true); // top still required
  });
});

describe("data-driven sticker bags (14C.2)", () => {
  it("classifies every ACTUAL bag record from structured fields; DTP/stock/box AND OZ bags stay out (14C.2A)", () => {
    expect(classifyCalculatorProduct({ name: "4x5 Blank Bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x5-bag", productType: "bag" }).klass).toBe("bag_sticker");
    expect(classifyCalculatorProduct({ name: "4x6 Blank Bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x6-bag", productType: "bag" }).klass).toBe("bag_sticker"); // future size — no route change needed
    expect(classifyCalculatorProduct({ name: "14x16 Blank Bag", vendor: "Vendor TBD", vendorSku: "preset:pound-bag", productType: "bag" }).klass).toBe("bag_sticker");
    expect(classifyCalculatorProduct({ name: "5x8 Sticker Bag", productType: "bag" }).klass).toBe("bag_sticker");
    expect(classifyCalculatorProduct({ name: "6x9 Sticker Bag", productType: "bag" }).klass).toBe("bag_sticker");
    expect(classifyCalculatorProduct({ name: "OZ bag", productType: "bag" }).klass).toBe("other"); // owner rule: OZ bags are NOT sticker bags
    expect(classifyCalculatorProduct({ name: "Template - 4x5 Outsourced Stock Bag", productType: "stock_bag" }).klass).toBe("other");
    expect(classifyCalculatorProduct({ name: "DTP 4x5x2 Blank Pouch", productType: "dtp_bag" }).klass).toBe("other");
    expect(classifyCalculatorProduct({ name: "4x5 custom box", productType: "box" }).klass).toBe("other");
  });

  it("owner-required sizes render as canonical NO PRICE options when no record exists; picker shows exactly the five sizes (14C.2A)", () => {
    expect(REQUIRED_STICKER_BAG_SIZES).toEqual(["4x5", "4x6", "5x8", "6x9", "14x16"]);
    expect(bagSizeToken("4x5 Blank Bag")).toBe("4x5");
    expect(bagSizeToken("14x16 Blank Bag")).toBe("14x16");
    expect(bagSizeToken("OZ bag")).toBeNull();
    // real records today: 4x5, 4x6, 14x16 -> canonical entries fill 5x8 + 6x9
    const present = new Set(["4x5", "4x6", "14x16"]);
    const canonical = REQUIRED_STICKER_BAG_SIZES.filter((size) => !present.has(size));
    expect(canonical).toEqual(["5x8", "6x9"]);
    // a canonical (missing-cost) selection blocks final-ready — never $0-final
    const draftOnly = computeProductDrivenCost(makeInput({ blank: { name: "5x8 Sticker Bag", unitCost: null, tiers: [], status: "estimated" } }));
    expect(draftOnly.lines.find((line) => line.key === "blank")!.source).toBe("missing");
    expect(draftOnly.missing.length).toBeGreaterThan(0);
    // and its application labor stays a SEPARATE missing blocker (no borrowed 4x5 rate)
    expect(bagApplicationRateFor("5x8 Sticker Bag").rate).toBeNull();
    expect(bagApplicationRateFor("6x9 Sticker Bag").rate).toBeNull();
  });

  it("bag application labor resolves by SIZE from owner standards; unknown sizes block instead of borrowing 4x5", () => {
    expect(bagApplicationRateFor("4x5 Blank Bag").rate).toBeCloseTo(20 / 256, 6);
    expect(bagApplicationRateFor("14x16 Blank Bag").rate).toBeCloseTo(1.0, 6);
    const unknown = bagApplicationRateFor("4x6 Blank Bag");
    expect(unknown.rate).toBeNull();
    const engine = computeProductDrivenCost(makeInput({ blank: { name: "4x6 Blank Bag", unitCost: 0.1, tiers: [], status: "verified" } }));
    const application = engine.lines.find((line) => line.key === "application")!;
    expect(application.source).toBe("missing");
    expect(application.amount).toBe(0);
  });

  it("researched 4x5 margin curve applies only to 4x5 bags; other sizes stay provisional (never invented)", () => {
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "4x5 Blank Bag")).toBe("bags-4x5");
    expect(marginFamilyKeyFor("bags-4x5", "bag_sticker", "4x5 Blank Bag")).toBe("bags-4x5"); // legacy value
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "4x6 Blank Bag")).toBeNull();
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "14x16 Blank Bag")).toBeNull();
  });

  it("canonical family mapping normalizes legacy values for snapshots", () => {
    expect(canonicalUiFamily("bags-4x5")).toBe("sticker-bags");
    expect(canonicalUiFamily("chiron-jars")).toBe("premium-jars");
    expect(canonicalUiFamily("miron-jars")).toBe("premium-jars");
    expect(canonicalUiFamily("custom")).toBe("custom-item");
    expect(uiFamilyToEngine("sticker-bags", null, false)).toBe("bags-4x5");
  });
});

describe("jar multi-label builder (14C.2)", () => {
  it("same-size flow: quantity x labels x one size — 640 jars x 3 labels @ 2x1 = 1,920 pieces / 26.67 sqft", () => {
    const rows = buildLabelRows({ count: 3, same: true, sameWidthIn: 2, sameHeightIn: 1, types: [], widths: [], heights: [] });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.type)).toEqual(["side", "lid", "additional"]);
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 640, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    expect(result.derived.totalPieces).toBe(1920);
    expect(result.derived.baseSqft).toBeCloseTo((640 * 3 * 2 * 1) / 144, 4);
    expect(result.derived.applicationCount).toBe(1920);
  });

  it("different-size flow sums every row (spec example: 26.67 + 17.78 + 2.22 = 46.67 sqft) and shares reconstruct exactly", () => {
    const rows = buildLabelRows({ count: 3, same: false, sameWidthIn: 0, sameHeightIn: 0, types: ["side", "lid", "additional"], widths: [4, 2, 1], heights: [1.5, 2, 0.5] });
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 640, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    expect(result.derived.labelRows).toHaveLength(3);
    expect(result.derived.labelRows![0].baseSqft).toBeCloseTo(26.6667, 3);
    expect(result.derived.labelRows![1].baseSqft).toBeCloseTo(17.7778, 3);
    expect(result.derived.labelRows![2].baseSqft).toBeCloseTo(2.2222, 3);
    expect(result.derived.baseSqft).toBeCloseTo(46.6667, 3);
    const materialLine = result.lines.find((line) => line.key === "material")!;
    const shareSum = result.derived.labelRows!.reduce((sum, row) => sum + row.materialCostShare, 0);
    expect(shareSum).toBeCloseTo(materialLine.amount, 6); // allocation reconstructs the costed line exactly
  });

  it("waste applies ONCE to the summed total, never per row and again on the total", () => {
    const rows = buildLabelRows({ count: 2, same: false, sameWidthIn: 0, sameHeightIn: 0, types: ["side", "lid"], widths: [4, 2], heights: [1.5, 2], });
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 640, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    const materialLine = result.lines.find((line) => line.key === "material")!;
    expect(materialLine.amount).toBeCloseTo(0.3156 * result.derived.baseSqft / 0.9, 4); // base x one 10% waste division
    expect(result.derived.wasteAdjustedSqft).toBeCloseTo(result.derived.baseSqft / 0.9, 4);
  });

  it("application labor charges per LABEL APPLIED, once — never per jar", () => {
    const rows = buildLabelRows({ count: 3, same: true, sameWidthIn: 2, sameHeightIn: 1, types: [], widths: [], heights: [] });
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 640, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    const applications = result.lines.filter((line) => line.key === "application");
    expect(applications).toHaveLength(1); // no double application
    expect(applications[0].amount).toBeCloseTo(0.2 * 1920, 4); // labels, not jars (640 x 3)
  });

  it("missing row dimensions block calculation with a per-row MISSING line", () => {
    const rows = buildLabelRows({ count: 2, same: false, sameWidthIn: 0, sameHeightIn: 0, types: ["side", "lid"], widths: [4], heights: [1.5] });
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 640, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    expect(result.missing.some((label) => label.includes("Lid label") && label.includes("label 2"))).toBe(true);
  });

  it("stale hidden rows beyond the posted count are discarded and never affect cost", () => {
    const rows = buildLabelRows({ count: 2, same: false, sameWidthIn: 0, sameHeightIn: 0, types: ["side", "lid", "bottom", "neck", "tamper"], widths: [4, 2, 90, 90, 90], heights: [1.5, 2, 90, 90, 90] });
    expect(rows).toHaveLength(2);
    const result = computeProductDrivenCost(makeInput({ family: "chiron-jars", quantity: 100, labelRows: rows, blank: { name: "3oz jar - clear", unitCost: 0.5, tiers: [], status: "verified" } }));
    expect(result.derived.baseSqft).toBeCloseTo((100 * (4 * 1.5 + 2 * 2)) / 144, 4); // 90x90 ghosts excluded
  });

  it("default label types follow the spec (1/2/3/4+) with numbered additionals; count clamps 1..6", () => {
    expect(defaultLabelTypesFor(1)).toEqual(["side"]);
    expect(defaultLabelTypesFor(2)).toEqual(["side", "lid"]);
    expect(defaultLabelTypesFor(3)).toEqual(["side", "lid", "additional"]);
    expect(defaultLabelTypesFor(4)).toEqual(["side", "lid", "additional", "additional"]);
    expect(MAX_LABELS_PER_UNIT).toBe(6);
    const four = buildLabelRows({ count: 4, same: true, sameWidthIn: 1, sameHeightIn: 1, types: [], widths: [], heights: [] });
    expect(four[2].typeLabel).toBe("Additional label 1");
    expect(four[3].typeLabel).toBe("Additional label 2");
    expect(buildLabelRows({ count: 99, same: true, sameWidthIn: 1, sameHeightIn: 1, types: [], widths: [], heights: [] })).toHaveLength(6);
  });

  it("Miron physical Top Type stays separate from a printed Lid label row — both present, neither double-counted", () => {
    const rows = buildLabelRows({ count: 2, same: false, sameWidthIn: 0, sameHeightIn: 0, types: ["side", "lid"], widths: [4, 2], heights: [1.5, 2] });
    const result = computeProductDrivenCost(makeInput({
      family: "miron-jars", quantity: 500, labelRows: rows,
      blank: { name: "150ml Miron jar + lid", unitCost: 2.76, tiers: [], status: "verified" },
      lid: { name: "Standard / Classic top", unitCost: 0.3, tiers: [], status: "verified" },
      mironTop: { setIncludesStandardTop: true, includedStandardTopCost: 0.3, selectedTopIsStandard: true },
    }));
    const topLines = result.lines.filter((line) => line.key === "top");
    expect(topLines).toHaveLength(1); // ONE physical top line ($0 — included in set)
    expect(topLines[0].amount).toBe(0);
    expect(result.derived.labelRows!.some((row) => row.type === "lid")).toBe(true); // printed lid label is a label row
    expect(result.derived.applicationCount).toBe(1000); // 500 jars x 2 printed labels
  });
});

describe("automatic tier flow pins (14C.2)", () => {
  const src3 = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");

  it("tiers generate automatically from the calculated job — per-quantity engine reruns, requested qty included and highlighted", () => {
    expect(src3).toContain("Automatic pricing tiers — generated from the calculated job (no re-entry)");
    expect(src3).toContain("computeProductDrivenCost({ ...productInput, quantity: qty })"); // loader rerun per tier
    expect(src3).toContain("computeProductDrivenCost({ ...productInputSave, quantity: qty })"); // save rerun per tier
    expect(src3).toContain("[...new Set([...eQuantities, requestedQtyP])]"); // requested quantity always a row
    expect(src3).toContain("← requested"); // highlighted
    expect(src3).toContain("if (requestedQtyP > 0) {"); // no tier table before a real calculation
  });

  it("researched family curves and the 40% floor are preserved — never invented; margin family derived from the product", () => {
    expect(src3).toContain("curveForTierCount(productMarginRule.curve, tierQuantities.length, productMarginRule.familyMinPct)");
    expect(src3).toContain("marginFamilyKeyFor(pFamily, selectedClass,");
    expect(src3).toContain("Math.max(productMarginRule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT)");
    expect(src3).toContain("FAMILY MARGIN RULE NOT CONFIGURED");
  });

  it("no duplicate pricing inputs in the normal flow — manual fields live in collapsed Advanced Pricing Controls; zero rows suppressed", () => {
    expect(src3).toContain("Advanced Pricing Controls (custom tier quantities, target-margin edits, freight/handling, owner override)");
    expect(src3).toContain("emergency.tiers.some((tier) => tier.unitCost > 0)"); // manual tier table zero-state
    expect(src3).toContain("Zero-value rows are never shown");
  });

  it("customer price selection populates the summary; internal cost/profit stay out of the customer card", () => {
    expect(src3).toContain("Use this price");
    expect(src3).toContain("Customer price summary");
    expect(src3).toContain("internal costs and profit are not shown here");
    expect(src3).toContain("Setup/design: included in unit pricing");
  });

  it("save recomputes tiers server-side and resolves the selected tier by QUANTITY — posted totals are ignored", () => {
    expect(src3).toContain('name="pseltier"');
    expect(src3).toContain("savedTiers.find((tier) => tier.quantity === selectedTierQty)");
    expect(src3).toContain('name="psearch"');
    expect(src3).toContain("engine: MULTILABEL_ENGINE_VERSION");
    expect(MULTILABEL_ENGINE_VERSION).toBe("14C.2-multilabel-auto-tiers");
  });

  it("historical quotes are never modified — the calculator only ever CREATES draft quotes", () => {
    expect(src3).toContain("db.quote.create");
    expect(src3).not.toContain("db.quote.update");
    expect(src3).not.toContain("db.quote.delete");
    expect(src3).not.toContain("quoteItem.update");
  });

  it("stale family switches are neutralized at BOTH loader and save (blankClassAllowedFor)", () => {
    expect((src3.match(/blankClassAllowedFor\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src3).toContain("topId: savedEngineFamily === \"miron-jars\"");
  });
});

describe("catalog correction pins (14C.2A)", () => {
  const src4 = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  it("canonical NO PRICE bag sizes render and resolve at loader AND save; unpriced bags stay visible", () => {
    expect(src4).toContain("REQUIRED_STICKER_BAG_SIZES.filter((size) => !presentBagSizes.has(size))");
    expect((src4.match(/type:bag-/g) || []).length).toBeGreaterThanOrEqual(3); // options + loader resolve + action resolve
    expect(src4).toContain("Owner cost not provided yet — Draft Only.");
    expect(src4).toContain('return entry.klass === "bag_sticker";'); // no priced filter — NO PRICE bags visible
  });
  it("Chiron flat cost is enforced at loader AND save (tiers ignored, never cost drift)", () => {
    expect((src4.match(/enforceFlatChironCost\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("neutralized 4x6 + final catalog statuses (14C.2A1)", () => {
  it("the live 4x6 record (renamed, $0) classifies bag_sticker and renders the EXACT unverified label", () => {
    const live = classifyCalculatorProduct({ name: "4x6 Sticker Bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x6-bag", productType: "bag" });
    expect(live.klass).toBe("bag_sticker");
    expect(formatComponentLabel("4x6 Sticker Bag", "bag_sticker", false, "NO PRICE — not verified")).toBe("4x6 Sticker Bag — NO PRICE — not verified");
    expect(bagSizeToken("4x6 Sticker Bag")).toBe("4x6"); // fills the required-size slot — no duplicate canonical entry
  });

  it("selecting the neutralized 4x6 produces a MISSING blank blocker — Draft Only, old $0.10 never reused", () => {
    // defaultUnitCost 0 resolves to a null-cost component (never trusted as $0-final)
    const result = computeProductDrivenCost(makeInput({ blank: { name: "4x6 Sticker Bag", unitCost: null, tiers: [], status: "verified" } }));
    const blank = result.lines.find((line) => line.key === "blank")!;
    expect(blank.source).toBe("missing");
    expect(blank.amount).toBe(0);
    expect(result.missing.length).toBeGreaterThan(0); // every tier row from this run is Draft Only
    // and its application labor stays its own separate blocker
    expect(bagApplicationRateFor("4x6 Sticker Bag").rate).toBeNull();
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "4x6 Sticker Bag")).toBeNull(); // no researched curve borrowed
  });

  it("final sticker-bag statuses: 4x5 $0.09 Verified, 14x16 $1.00 Verified, 4x6/5x8/6x9 unverified, OZ excluded", () => {
    expect(formatComponentLabel("4x5 Blank Bag", "bag_sticker", false, "$0.09 — Verified")).toBe("4x5 Blank Bag — $0.09 — Verified");
    expect(formatComponentLabel("14x16 Blank Bag", "bag_sticker", false, "$1.00 — Verified")).toBe("14x16 Blank Bag — $1.00 — Verified");
    // priced records keep their owner-approved application standards
    expect(bagApplicationRateFor("4x5 Blank Bag").rate).toBeCloseTo(20 / 256, 6);
    expect(bagApplicationRateFor("14x16 Blank Bag").rate).toBeCloseTo(1.0, 6);
    // with 4x5/4x6/14x16 present, the canonical unverified fills are 5x8 + 6x9
    const present = new Set(["4x5", "4x6", "14x16"]);
    expect(REQUIRED_STICKER_BAG_SIZES.filter((size) => !present.has(size))).toEqual(["5x8", "6x9"]);
    expect(classifyCalculatorProduct({ name: "OZ bag", productType: "bag" }).klass).toBe("other"); // still excluded
  });

  it("Standard Jars = 3 oz + 4 oz + 5 oz + soda-can preset; Chiron/Miron/tops stay excluded", () => {
    expect(classifyCalculatorProduct({ name: "Soda can", vendor: "P1", productType: "jar" }).klass).toBe("jar_standard"); // owner: the can is treated as a jar
    expect(classifyCalculatorProduct({ name: "3oz jar - clear", vendor: "SAFE CARE", productType: "jar" }).klass).toBe("jar_standard");
    expect(classifyCalculatorProduct({ name: "5oz jar - clear", vendor: "SAFE CARE", productType: "jar" }).klass).toBe("jar_standard");
    expect(blankClassAllowedFor("standard-jars", "jar_standard")).toBe(true);
    expect(blankClassAllowedFor("standard-jars", "jar_chiron")).toBe(false);
    expect(blankClassAllowedFor("standard-jars", "jar_miron")).toBe(false);
    expect(blankClassAllowedFor("standard-jars", "miron_top")).toBe(false);
  });
});
