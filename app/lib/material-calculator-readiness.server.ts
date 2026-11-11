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

/** Purchase units whose price IS an area price. */
const AREA_PURCHASE_UNITS = new Set(["sqft", "sqin"]);
/** Stored roll $/sqft may differ from purchase price ÷ roll area by rounding only. */
const ROLL_DERIVATION_TOLERANCE = 0.01;

/**
 * 2026-11-11 UNIT SAFETY. A purchase price ($250 per roll, $50 per pack, $20
 * each) must never become a $/sqft. The stored area cost is defensible only
 * when it is:
 *   - an explicit area cost (purchased per sqft/sq in, or entered directly with
 *     no purchase price on record), or
 *   - derived from a ROLL purchase: purchase price ÷ (width x length), and the
 *     stored rate matches that derivation.
 * Any other purchase unit carrying a price (each, case, pack, box, sheet ...)
 * cannot express a $/sqft, so the material is not calculator-ready.
 * Returns plain-English reasons; nothing is converted or guessed here.
 */
export function areaCostUnitBasisIssues(material: any, costPerSqft: number): string[] {
  const purchaseUnit = String(material?.purchaseUnit || "").toLowerCase().trim();
  const purchaseCost = Number(material?.purchaseCost) || 0;
  if (!(purchaseCost > 0) || AREA_PURCHASE_UNITS.has(purchaseUnit)) return [];
  if (purchaseUnit === "roll") {
    const widthIn = Number(material?.rollWidthIn) || 0;
    const lengthFt = Number(material?.rollLengthFt) || 0;
    if (!(widthIn > 0) || !(lengthFt > 0)) {
      return ["Roll length/width missing — the $/sqft cannot be verified from the roll price (UNIT_BASIS_REQUIRED)."];
    }
    const derived = purchaseCost / ((widthIn * lengthFt * 12) / 144);
    if (Math.abs(costPerSqft - derived) > derived * ROLL_DERIVATION_TOLERANCE) {
      return [`Stored $/sqft (${costPerSqft.toFixed(4)}) does not match roll price ÷ roll area (${derived.toFixed(4)}) — re-save the material (UNIT_BASIS_REQUIRED).`];
    }
    return [];
  }
  return [`Cost is a purchase price per ${purchaseUnit || "unit"}, not a per-sq-ft cost — enter the roll size or an explicit $/sqft (UNIT_BASIS_REQUIRED).`];
}

/** Material Center product families a print medium may serve. */
export type MaterialUse = "labels" | "bag_labels";
const FAMILIES_FOR_USE: Record<MaterialUse, string[]> = {
  labels: [LABELS_PRODUCT_FAMILY],
  // 4x5 / Stock / Split bag labels are sticker-label media.
  bag_labels: [LABELS_PRODUCT_FAMILY, "sticker_bags"],
};

export function materialCalculatorReadiness(material: any, use: MaterialUse = "labels"): MaterialCalculatorReadiness {
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
  const allowedFamilies = FAMILIES_FOR_USE[use];
  if (!families(material?.productFamilies).some((family) => allowedFamilies.includes(family))) {
    missing.push(use === "labels" ? "Not assigned to the Labels product family." : "Not assigned to the Labels or Sticker Bags product family.");
  }
  const cost = resolvePrintMaterialCostPerSqft(material);
  if (!(cost.unitCost > 0)) missing.push("No stored cost per sqft.");
  else if (!areaCostUnit(material)) missing.push("Cost is not per sqft (or per sq in).");
  else missing.push(...areaCostUnitBasisIssues(material, cost.unitCost));
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
export function verifiedLabelMaterialOf(material: any, use: MaterialUse = "labels"): VerifiedLabelMaterial | null {
  const readiness = materialCalculatorReadiness(material, use);
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
export async function attachVerifiedLabelMaterials<T extends {
  family: string;
  labels?: { lines: Array<{ materialKey: string }>; materials?: Record<string, VerifiedLabelMaterial> };
  bags?: MediaSelection;
  jar?: MediaSelection;
}>(
  deps: { db: any; shop: string },
  input: T,
): Promise<T> {
  if (input.bags && BAG_FAMILIES.has(input.family)) return { ...input, bags: await attachVerifiedMediaSelection(deps, input.bags, "bag_labels") };
  if (input.jar && JAR_FAMILIES.has(input.family)) return { ...input, jar: await attachVerifiedMediaSelection(deps, input.jar, "labels") };
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

const BAG_FAMILIES = new Set(["sticker-bags", "stock-bags", "split-bags"]);
const JAR_FAMILIES = new Set(["standard-jars", "premium-jars"]);
type MediaSelection = { materialKey?: string | null; materialId?: string | null; materials?: Record<string, VerifiedLabelMaterial>; materialMissing?: string[] };

/**
 * 2026-11-11 — server side: the bag / jar label media the form selected (pmat,
 * a Material Center id) becomes the job's canonical media key. The record is
 * re-read shop-scoped: an approved roll keeps its approved rate; any other
 * record must be calculator-ready for that use and contributes its OWN stored
 * $/sqft; anything else blocks with its readiness reasons. A selected id always
 * wins over a posted media key, so the browser cannot pick the rate.
 */
async function attachVerifiedMediaSelection<S extends MediaSelection>(deps: { db: any; shop: string }, selection: S, use: MaterialUse): Promise<S> {
  const posted = String(selection.materialKey || "");
  const id = String(selection.materialId || "") || (posted.startsWith(MATERIAL_CANONICAL_KEY_PREFIX) ? posted.slice(MATERIAL_CANONICAL_KEY_PREFIX.length) : "");
  if (!id) return selection; // approved keys resolve in code; nothing selected stays blocked
  const record = await deps.db.material.findFirst({ where: { shop: deps.shop, id } });
  if (!record) return { ...selection, materialKey: `${MATERIAL_CANONICAL_KEY_PREFIX}${id}`, materials: {}, materialMissing: ["Selected material was not found."] };
  const readiness = materialCalculatorReadiness(record, use);
  if (!readiness.ready || !readiness.canonicalKey) {
    return { ...selection, materialKey: `${MATERIAL_CANONICAL_KEY_PREFIX}${id}`, materials: {}, materialMissing: readiness.missing };
  }
  const verified = verifiedLabelMaterialOf(record, use);
  return { ...selection, materialKey: readiness.canonicalKey, materials: verified ? { [verified.key]: verified } : {}, materialMissing: [] };
}
