// Patch 2D-4E4 (October 2026) — AGENT REVIEW QUEUE CANONICAL GATE.
//
// The Agent Review Queue converts a queue item into a DRAFT quote by pricing
// the staff-selected ProductRecipe through the recipe tier engine
// (priceRecipeAtQuantity) and writing `priced.unitCost` straight onto the
// QuoteItem. For a CANONICAL_COST_AUTHORITY family that unit cost is not the
// canonical manufacturing cost — the canonical engine needs the job geometry,
// material keys, line structure, machine routing and approved calibrations,
// none of which a recipe row carries in canonical form.
//
// OWNER RULE: canonical manufacturing cost is the only cost authority for
// those families, and a blocked canonical result is unitCost = null — never
// $0 and never a stand-in. QuoteItem.unitCost is a non-null Float, so a
// "clearly unusable draft" cannot be represented without inventing a number.
// The safe existing architecture is therefore the conversion REFUSAL path the
// route already has (conversion-failed event + redirect with a reason), and
// staff build the quote in the Cost Calculator where canonical authority is
// enforced.
//
// Non-canonical families (DTP pouches, boxes, custom/unknown) keep their
// existing recipe-engine conversion unchanged. Nothing here guesses a family:
// it reads the recipe's DECLARED productFamily/productType against the
// product-family registry and a few explicit family words.

import { familyCostModel } from "./canonical-quote-authority.server";
import { PRODUCT_FAMILY_REGISTRY, familyByKeyOrAlias } from "./product-family-registry";
import type { CanonicalFamily } from "./canonical-calculator-shared";

export const AGENT_QUOTE_CANONICAL_GATE_VERSION = "17D.8D-agent-quote-canonical-gate";

export const AGENT_GATE_REASONS = {
  canonicalAuthorityRequired: "CANONICAL_TRUE_COST_REQUIRED",
} as const;

/** Conversion-error code the route surfaces for a refused canonical family. */
export const AGENT_GATE_CONVERSION_ERROR_CODE = "canonical_authority_required";

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Resolve the canonical UI family a recipe DECLARES, or null when it cannot be
 * read without guessing.
 *
 * Order: registry key/alias -> registry label / recipeFamilyLabel -> explicit
 * family words in productFamily, then productType. "Jars" resolves to
 * premium-jars for reporting; both jar families are canonical so the gate's
 * answer is the same either way.
 */
export function canonicalFamilyKeyForRecipe(recipe: {
  productFamily?: unknown;
  productType?: unknown;
}): CanonicalFamily | string | null {
  const candidates = [norm(recipe.productFamily), norm(recipe.productType)].filter(Boolean);
  for (const text of candidates) {
    const direct = familyByKeyOrAlias(text);
    if (direct) return direct.key;
    const byLabel = PRODUCT_FAMILY_REGISTRY.find(
      (entry) => norm(entry.label) === text || norm(entry.recipeFamilyLabel) === text,
    );
    if (byLabel) return byLabel.key;
  }
  for (const text of candidates) {
    if (/sticker\s*bag|stock\s*bag|bag_sticker/.test(text)) return "sticker-bags";
    if (/dtp|pouch|dtp_bag/.test(text)) return "dtp-bags";
    if (/\bbox(es)?\b/.test(text)) return "boxes";
    if (/banner/.test(text)) return "banners";
    if (/\bjars?\b|jar_/.test(text)) return "premium-jars";
    if (/label|sticker/.test(text)) return "stickers-labels";
  }
  return null;
}

export type AgentConversionGate =
  | { allowed: true; familyKey: string | null; model: ReturnType<typeof familyCostModel> }
  | { allowed: false; familyKey: string; model: "CANONICAL_COST_AUTHORITY" | "CANONICAL_FAIL_CLOSED"; code: typeof AGENT_GATE_CONVERSION_ERROR_CODE; reason: string };

/**
 * May the Agent Review Queue convert this recipe into a draft quote on the
 * recipe tier engine's cost?
 */
export function agentConversionCanonicalGate(recipe: {
  productFamily?: unknown;
  productType?: unknown;
  name?: unknown;
}): AgentConversionGate {
  const familyKey = canonicalFamilyKeyForRecipe(recipe);
  const model = familyCostModel(familyKey);
  if (model === "LEGACY_OUTSOURCED") {
    return { allowed: true, familyKey, model };
  }
  return {
    allowed: false,
    familyKey: String(familyKey),
    model,
    code: AGENT_GATE_CONVERSION_ERROR_CODE,
    reason:
      `${AGENT_GATE_REASONS.canonicalAuthorityRequired}: recipe "${String(recipe.name || "")}" belongs to "${String(familyKey)}", a canonical-authority manufacturing family. ` +
      `The agent conversion prices from the recipe tier engine, which is not the canonical true manufacturing cost, and the canonical engine cannot be run from a recipe row without inventing job inputs. ` +
      `No draft was created — build this quote in the Cost Calculator, where canonical authority is enforced.`,
  };
}
