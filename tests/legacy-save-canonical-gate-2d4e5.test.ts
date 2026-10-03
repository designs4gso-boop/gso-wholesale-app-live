// Patch 2D-4E5 — a KNOWN canonical family reaches the canonical save gate
// even when the emergency / legacy-auto panel omitted `pfamily`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalFamilyFromMarginFamilyKey } from "../app/lib/canonical-calculator-shared";
import { familyCostModel, persistQuoteIfCanonicalAllows } from "../app/lib/canonical-quote-authority.server";
import { FAMILY_MARGIN_RULES } from "../app/lib/calculator-emergency.server";

describe("2D-4E5 margin family -> canonical family", () => {
  it("maps every canonical manufacturing family the emergency panel can name", () => {
    expect(canonicalFamilyFromMarginFamilyKey("bags-4x5")).toBe("sticker-bags");
    expect(canonicalFamilyFromMarginFamilyKey("stickers-labels")).toBe("stickers-labels");
    expect(canonicalFamilyFromMarginFamilyKey("spot-gloss-labels")).toBe("stickers-labels");
    expect(canonicalFamilyFromMarginFamilyKey("banners")).toBe("banners");
    expect(canonicalFamilyFromMarginFamilyKey("chiron-jars")).toBe("premium-jars");
    expect(canonicalFamilyFromMarginFamilyKey("miron-jars")).toBe("premium-jars");
  });

  it("never guesses: outsourced, unknown and empty stay null (legacy behaviour)", () => {
    for (const key of ["dtp-pouches", "boxes", "die-cut-bags", "", null, undefined, "widgets"]) {
      expect(canonicalFamilyFromMarginFamilyKey(key), String(key)).toBeNull();
    }
  });

  it("every mapped family is a CANONICAL_COST_AUTHORITY family, and every rule key is accounted for", () => {
    for (const rule of FAMILY_MARGIN_RULES) {
      const mapped = canonicalFamilyFromMarginFamilyKey(rule.key);
      if (mapped) expect(familyCostModel(mapped), rule.key).toBe("CANONICAL_COST_AUTHORITY");
      else expect(["dtp-pouches", "die-cut-bags", "boxes"], rule.key).toContain(rule.key);
    }
  });
});

describe("2D-4E5 an emergency save of a known canonical family is refused", () => {
  it("no canonical input + a known canonical family -> zero writes", async () => {
    for (const marginKey of ["bags-4x5", "stickers-labels", "banners", "miron-jars"]) {
      let writes = 0;
      const outcome = await persistQuoteIfCanonicalAllows(
        {
          canonicalFamilyKey: canonicalFamilyFromMarginFamilyKey(marginKey),
          baseCanonical: null, // the emergency panel produces no canonical job
          selectedCanonical: null,
          selectedQuantity: 1000,
        },
        async () => { writes += 1; return { id: "never" }; },
      );
      expect(writes, marginKey).toBe(0);
      expect(outcome.ok, marginKey).toBe(false);
      if (!outcome.ok) expect(outcome.message).toContain("CANONICAL_TRUE_COST_REQUIRED");
    }
  });

  it("an unknown legacy item (no family) keeps its legacy save path", async () => {
    let writes = 0;
    const outcome = await persistQuoteIfCanonicalAllows(
      { canonicalFamilyKey: canonicalFamilyFromMarginFamilyKey(null), baseCanonical: null, selectedCanonical: null, selectedQuantity: 10 },
      async () => { writes += 1; return { id: "legacy" }; },
    );
    expect(writes).toBe(1);
    expect(outcome.ok).toBe(true);
  });
});

describe("2D-4E5 the calculator route hands the gate the derived family", () => {
  const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

  it("derives the gate family from pfamily first, then the researched margin family", () => {
    expect(route).toContain("const canonicalGateFamilyKey = pFamilySave");
    expect(route).toContain("? canonicalUiFamily(pFamilySave)");
    expect(route).toContain(": canonicalFamilyFromMarginFamilyKey(familyRule?.key ?? null);");
    const call = route.slice(route.indexOf("await persistQuoteIfCanonicalAllows("), route.indexOf("if (!saveOutcome.ok) {"));
    expect(call).toContain("canonicalFamilyKey: canonicalGateFamilyKey,");
    expect(call).not.toContain("canonicalFamilyKey: pFamilySave ? canonicalUiFamily(pFamilySave) : null");
  });

  it("the refusal tells the operator why an emergency save of a canonical family cannot proceed", () => {
    expect(route).toContain("The emergency/legacy panel cannot quote");
    expect(route.match(/canonicalBlocked: true/g)).toHaveLength(1);
  });
});
