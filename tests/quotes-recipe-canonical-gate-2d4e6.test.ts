// Patch 2D-4E6 — the Quotes editor's "Calculate from ERP" (price a line from
// a ProductRecipe through the recipe TIER engine) refuses canonical-authority
// families. Found by the October CORE audit: a label/bag/jar/banner recipe
// could be priced and saved with a recipe tier cost, and because such a line
// carries no canonical true-cost block the 2D-4E3 save protection could not
// hold it. Same gate the Agent Review Queue uses (2D-4E4).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentConversionCanonicalGate } from "../app/lib/agent-quote-canonical-gate.server";
import { canonicalCostBlockOf } from "../app/lib/quote-item-cost-authority";

describe("2D-4E6 recipe-priced quote lines", () => {
  it("a recipe-priced line carries NO canonical block, so only an upstream gate can protect it", () => {
    // This is what priceRecipeLine stores on a line (15G.2 pricing snapshot).
    const recipeLineSnapshot = JSON.stringify({
      recipeId: "r1",
      canonical: { snapshotVersion: "15G.2-canonical-snapshot-v1", engine: "recipe-pricing/tier", family: "label", quantity: 500, totalCost: 50, unitCost: 0.1, recommendedUnitPrice: 0.2, recommendedTotalPrice: 100 },
    });
    expect(canonicalCostBlockOf(recipeLineSnapshot)).toBeNull();
  });

  it("the shared gate refuses every canonical-authority recipe family and allows outsourced ones", () => {
    for (const family of ["Labels", "Labels / Stickers", "Sticker Bags", "Jars", "Banners", "stickers-labels", "bags-4x5"]) {
      expect(agentConversionCanonicalGate({ productFamily: family, name: "r" }).allowed, family).toBe(false);
    }
    for (const recipe of [{ productFamily: "DTP Bags", productType: "dtp_bag" }, { productFamily: "Boxes", productType: "box" }, { productFamily: "custom", productType: "sourced_product" }]) {
      expect(agentConversionCanonicalGate(recipe).allowed, JSON.stringify(recipe)).toBe(true);
    }
  });

  it("the Quotes route gates priceRecipeLine BEFORE the recipe engine prices anything", () => {
    const route = readFileSync("app/routes/app.quotes.tsx", "utf8");
    const fn = route.indexOf("async function priceRecipeLine(");
    const gate = route.indexOf("const canonicalGate = agentConversionCanonicalGate(recipe);", fn);
    const priced = route.indexOf("const priced = priceRecipeAtQuantity(recipe, payload.quantity, {", fn);
    expect(fn).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(fn);
    expect(gate).toBeLessThan(priced);
    expect(route).toContain("return { ok: false, error: canonicalGate.reason, canonicalAuthorityRequired: true };");
    // the client surfaces a failed recipe pricing as a message and changes nothing on the line
    expect(route).toContain('setLastMessage(fetcher.data.error || "Recipe pricing failed.");');
  });
});
