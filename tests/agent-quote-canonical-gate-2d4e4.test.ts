// Patch 2D-4E4 — the Agent Review Queue cannot create a draft quote for a
// canonical-authority family on the recipe tier engine's cost.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_GATE_CONVERSION_ERROR_CODE,
  AGENT_GATE_REASONS,
  AGENT_QUOTE_CANONICAL_GATE_VERSION,
  agentConversionCanonicalGate,
  canonicalFamilyKeyForRecipe,
} from "../app/lib/agent-quote-canonical-gate.server";

describe("2D-4E4 recipe family resolution reads the DECLARED family", () => {
  it("maps registry labels, recipe family labels, keys and aliases", () => {
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Sticker Bags" })).toBe("sticker-bags");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Labels / Stickers" })).toBe("stickers-labels");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Labels" })).toBe("stickers-labels");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Banners" })).toBe("banners");
    // "Jars" is the recipe label shared by both jar families; either is canonical.
    expect(["standard-jars", "premium-jars"]).toContain(canonicalFamilyKeyForRecipe({ productFamily: "Jars" }));
    expect(canonicalFamilyKeyForRecipe({ productFamily: "stickers-labels" })).toBe("stickers-labels");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "bags-4x5" })).toBe("sticker-bags");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "DTP Bags" })).toBe("dtp-bags");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Boxes" })).toBe("boxes");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "custom", productType: "general" })).toBe("custom-item");
  });

  it("falls back to productType only when productFamily says nothing, and never guesses from nothing", () => {
    expect(canonicalFamilyKeyForRecipe({ productFamily: "", productType: "dtp_bag" })).toBe("dtp-bags");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "", productType: "box" })).toBe("boxes");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "", productType: "label" })).toBe("stickers-labels");
    expect(canonicalFamilyKeyForRecipe({ productFamily: "", productType: "" })).toBeNull();
    expect(canonicalFamilyKeyForRecipe({})).toBeNull();
    expect(canonicalFamilyKeyForRecipe({ productFamily: "Widgets", productType: "sourced_product" })).toBeNull();
  });
});

describe("2D-4E4 the conversion gate", () => {
  it("refuses every canonical-authority family with the canonical reason and error code", () => {
    for (const family of ["Labels", "Sticker Bags", "Jars", "Banners", "Labels / Stickers"]) {
      const gate = agentConversionCanonicalGate({ productFamily: family, name: `${family} recipe` });
      expect(gate.allowed, family).toBe(false);
      if (gate.allowed) throw new Error("expected refusal");
      expect(gate.code).toBe(AGENT_GATE_CONVERSION_ERROR_CODE);
      expect(gate.model).toBe("CANONICAL_COST_AUTHORITY");
      expect(gate.reason).toContain(AGENT_GATE_REASONS.canonicalAuthorityRequired);
      expect(gate.reason).toContain("Cost Calculator");
    }
    expect(AGENT_QUOTE_CANONICAL_GATE_VERSION).toContain("agent-quote-canonical-gate");
  });

  it("allows outsourced / non-canonical families unchanged", () => {
    for (const recipe of [
      { productFamily: "DTP Bags", productType: "dtp_bag" },
      { productFamily: "Boxes", productType: "box" },
      { productFamily: "custom", productType: "sourced_product" },
      { productFamily: "", productType: "" },
    ]) {
      const gate = agentConversionCanonicalGate(recipe);
      expect(gate.allowed, JSON.stringify(recipe)).toBe(true);
      if (gate.allowed) expect(gate.model).toBe("LEGACY_OUTSOURCED");
    }
  });
});

describe("2D-4E4 the route consults the gate before pricing or writing", () => {
  const route = readFileSync("app/routes/app.erp.agent-review-queue.tsx", "utf8");

  it("the gate runs first inside quoteLineFromQueueItem, before priceRecipeAtQuantity", () => {
    const fn = route.indexOf("function quoteLineFromQueueItem(");
    const gate = route.indexOf("const canonicalGate = agentConversionCanonicalGate(recipe);", fn);
    const priced = route.indexOf("const priced = priceRecipeAtQuantity(recipe, quantity, {", fn);
    const write = route.indexOf("await tx.quote.create({");
    expect(gate).toBeGreaterThan(fn);
    expect(gate).toBeLessThan(priced);
    expect(gate).toBeLessThan(write);
    expect(route).toContain("canonicalAuthorityRequired: true as const");
  });

  it("a refused conversion records a failure event and redirects with the canonical error code", () => {
    expect(route).toContain("canonicalAuthorityRequired: quoteLineResult.canonicalAuthorityRequired,");
    expect(route).toContain("AGENT_GATE_CONVERSION_ERROR_CODE : \"no_pricing\"");
    expect(route).toContain("[AGENT_GATE_CONVERSION_ERROR_CODE]:");
    expect(route.match(/tx\.quote\.create\(/g)).toHaveLength(1);
  });
});
