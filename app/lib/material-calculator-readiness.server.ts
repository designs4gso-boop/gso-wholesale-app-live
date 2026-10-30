// 2026-10-28 — MATERIAL CENTER -> COST CALCULATOR INTEGRATION.
//
// Decides whether a Material Center record can be the canonical $/sqft for a
// Stickers & Labels line. Two paths, checked in this order:
//
//   1. APPROVED ROLL RATE. Only the specific records the Approved Cost
//      registry identifies as the approved roll media keep the verified
//      APPROVED_ROLL_COSTS rate (see approvedRollKeyOf). A finish word in a
//      name ("matte", "gloss", "holographic", "clear", "glow") never selects
//      another material's rate.
//   2. MATERIAL CENTER RATE. Any other printable roll media qualifies
//      when its record carries everything canonical costing needs: active and
//      available to the calculator, assigned to the Labels product family, a
//      stored cost per sqft (or sq in) that is not flagged for review, a vendor,
//      and a roll width (nesting needs it). Its canonical key is
//      "material:<id>"; the server re-reads the record by id before costing,
//      so the browser never carries a cost.
//
// Anything short of that stays blocked with plain-English reasons, shown in
// Material Center ("Needs cost setup") and in the calculator. Nothing here
// invents a cost, a roll width or a default.

import { APPROVED_COST_TRUTH } from "./approved-cost-updates.server";
import { resolvePrintMaterialCostPerSqft } from "./cost-calculator.server";
import { LABEL_MATERIALS, type VerifiedLabelMaterial } from "./label-cost-inputs.server";
import { materialKind } from "./material-classify";

export const MATERIAL_CANONICAL_KEY_PREFIX = "material:";
/** The Material Center product family a sticker/label print material must be assigned to. */
export const LABELS_PRODUCT_FAMILY = "labels";

export const CALCULATOR_READY = "Calculator ready";
export const NEEDS_COST_SETUP = "Needs cost setup";

export type MaterialCalculatorReadiness = {
  /** false for blanks, inks, labor, etc. — the calculator's print-media list never shows them. */
  applies: boolean;
  ready: boolean;
  label: typeof CALCULATOR_READY | typeof NEEDS_COST_SETUP | null;
  /** What the form emits as pl<N>mat. null = canonical costing blocks. */
  canonicalKey: string | null;
  source: "approved_roll_rate" | "material_center" | null;
  costPerSqft: number | null;
  rollWidthIn: number | null;
  /** Plain-English reasons the material is not calculator-ready. */
  missing: string[];
};

/** The Approved Cost registry entries that identify the three approved roll media. */
const APPROVED_ROLL_ENTRIES = {
  matte: "roll-poseidon-matte",
  gloss: "roll-poseidon-gloss",
  holographic: "roll-holographic",
} as const;
type ApprovedRollKey = keyof typeof APPROVED_ROLL_ENTRIES;

/** "Holographic", "Holographic Roll Media", "Holographic Gloss Vinyl" — the generic holographic roll, not a distinct product. */
const GENERIC_HOLOGRAPHIC_NAME = /^\s*holographic(\s+(roll|media|vinyl|film|gloss|glossy|label|labels|sticker|stickers))*\s*$/i;

/**
 * 2026-10-28 owner decision: is this record one of the APPROVED roll media?
 *
 * Identity comes from the Approved Cost registry, which is how the repo already
 * finds the exact records its approved costs are written to:
 *   - Poseidon Matte / Poseidon Gloss: the registry's brand + finish identity
 *     (a "Clear Gloss" or "Clear Matte" record is NOT a Poseidon roll);
 *   - Holographic: the registry matches any "holographic" name, which is too
 *     broad, so only the generic holographic roll name or a record already
 *     stamped with the registry's verified marker qualifies. A distinct
 *     holographic product with its own name uses its own stored cost.
 * Everything else uses its own Material Center record.
 */
export function approvedRollKeyOf(material: any): ApprovedRollKey | null {
  const name = String(material?.name || "");
  if (!name.trim()) return null;
  for (const key of ["holographic", "gloss", "matte"] as const) {
    const entry = APPROVED_COST_TRUTH.find((item) => item.key === APPROVED_ROLL_ENTRIES[key]);
    if (!entry || !entry.matchName.test(name)) continue;
    if (key !== "holographic") return key;
    const stamped = Boolean(entry.marker) && String(material?.notes || "").includes(entry.marker!);
    if (GENERIC_HOLOGRAPHIC_NAME.test(name) || stamped) return key;
  }
  return null;
}

function families(value: unknown): string[] {
  return String(value || "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function areaCostUnit(material: any): boolean {
  const unit = String(material?.baseUnit || material?.unit || "").toLowerCase();
  return unit === "sqft" || unit === "sqin";
}

export function materialCalculatorReadiness(material: any): MaterialCalculatorReadiness {
  const blocked = (missing: string[]): MaterialCalculatorReadiness => ({
    applies: true, ready: false, label: NEEDS_COST_SETUP, canonicalKey: null, source: null, costPerSqft: null, rollWidthIn: null, missing,
  });
  if (materialKind(material) !== "print") {
    return { applies: false, ready: false, label: null, canonicalKey: null, source: null, costPerSqft: null, rollWidthIn: null, missing: [] };
  }

  const availability: string[] = [];
  if (material?.active === false) availability.push("Material is inactive.");
  if (material?.useInRecipes === false) availability.push("Material is hidden from recipes and the calculator.");

  // 1. The approved roll media records (explicit registry identity).
  const approvedKey = approvedRollKeyOf(material);
  if (approvedKey) {
    if (availability.length) return blocked(availability);
    const approved = LABEL_MATERIALS[approvedKey];
    return {
      applies: true, ready: true, label: CALCULATOR_READY, canonicalKey: approvedKey, source: "approved_roll_rate",
      costPerSqft: approved.costPerSqft, rollWidthIn: approved.rollWidthIn, missing: [],
    };
  }

  // 2. Material Center record — structured fields only.
  const missing = [...availability];
  if (!families(material?.productFamilies).includes(LABELS_PRODUCT_FAMILY)) missing.push("Not assigned to the Labels product family.");
  const cost = resolvePrintMaterialCostPerSqft(material);
  if (!(cost.unitCost > 0)) missing.push("No stored cost per sqft.");
  else if (!areaCostUnit(material)) missing.push("Cost is not per sqft (or per sq in).");
  if (material?.costReviewNeeded) missing.push("Cost is marked \"needs review\" — confirm it first.");
  if (!material?.primaryVendorId && !String(material?.vendor || "").trim()) missing.push("No vendor set.");
  const rollWidthIn = Number(material?.rollWidthIn);
  if (!(Number.isFinite(rollWidthIn) && rollWidthIn > 0)) missing.push("Roll width is missing.");
  if (missing.length) return blocked(missing);

  return {
    applies: true, ready: true, label: CALCULATOR_READY, canonicalKey: `${MATERIAL_CANONICAL_KEY_PREFIX}${material.id}`, source: "material_center",
    costPerSqft: cost.unitCost, rollWidthIn, missing: [],
  };
}

/** The verified rate a ready Material Center record contributes to a label job. */
export function verifiedLabelMaterialOf(material: any): VerifiedLabelMaterial | null {
  const readiness = materialCalculatorReadiness(material);
  if (!readiness.ready || readiness.source !== "material_center" || !readiness.canonicalKey) return null;
  return {
    key: readiness.canonicalKey,
    label: String(material.name),
    costPerSqft: readiness.costPerSqft!,
    rollWidthIn: readiness.rollWidthIn!,
    source: "material_center",
    materialId: String(material.id),
  };
}

/**
 * Server side: attach the verified Material Center rates a label job references.
 * Re-reads each "material:<id>" record (shop-scoped) and re-checks readiness, so
 * a key posted for a material that is not ready — or another shop's — still
 * blocks. The resolved rate travels inside the canonical input, so a saved
 * snapshot keeps the rate it was costed at; later edits never rewrite it.
 */
export async function attachVerifiedLabelMaterials<T extends { family: string; labels?: { lines: Array<{ materialKey: string }>; materials?: Record<string, VerifiedLabelMaterial> } }>(
  deps: { db: any; shop: string },
  input: T,
): Promise<T> {
  if (input.family !== "stickers-labels" || !input.labels) return input;
  const ids = Array.from(new Set(
    input.labels.lines
      .map((line) => String(line.materialKey || ""))
      .filter((key) => key.startsWith(MATERIAL_CANONICAL_KEY_PREFIX))
      .map((key) => key.slice(MATERIAL_CANONICAL_KEY_PREFIX.length))
      .filter(Boolean),
  ));
  if (!ids.length) return input;
  const records = await deps.db.material.findMany({ where: { shop: deps.shop, id: { in: ids } } });
  const materials: Record<string, VerifiedLabelMaterial> = {};
  for (const record of records || []) {
    const verified = verifiedLabelMaterialOf(record);
    if (verified) materials[verified.key] = verified;
  }
  return { ...input, labels: { ...input.labels, materials } };
}
