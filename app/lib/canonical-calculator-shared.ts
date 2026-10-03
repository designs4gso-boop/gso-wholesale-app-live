// Patch 2D-4 (17D.7) — client-safe half of the canonical Cost Calculator
// dispatch. Pure data and types only, no server imports, so the route's React
// components can render a canonical result without dragging the server module
// (and Prisma) into the browser bundle.
//
// Same split the repo already uses for cost-verification-shared,
// rip-actual-costs-shared and ink-rates-shared.
//
// canonical-calculator.server.ts imports everything here and re-exports it, so
// there is still exactly ONE definition of each name.

import type { CostBasis, CostCategory, TrueCostResult, TrueCostStatus } from "./true-cost-engine.server";

export const CANONICAL_CALCULATOR_VERSION = "17D.7-canonical-calculator";

/* ------------------------------------------------------------------ *
 * Families
 * ------------------------------------------------------------------ */

export const CANONICAL_FAMILIES = ["stickers-labels", "sticker-bags", "stock-bags", "banners", "standard-jars", "premium-jars"] as const;
export type CanonicalFamily = (typeof CANONICAL_FAMILIES)[number];

/**
 * Families the calculator must keep on their EXISTING path.
 *
 * DTP and Boxes are outsourced/vendor families — they are never routed through
 * the in-house manufacturing adapters. Jars have a cost adapter but no
 * quote-ready entry point yet (their real side-label cutlines are unknown), and
 * custom-item has no product model at all.
 */
export const NON_CANONICAL_FAMILIES = ["dtp-bags", "boxes", "custom-item"] as const;

export function isCanonicalFamily(value: unknown): value is CanonicalFamily {
  return typeof value === "string" && (CANONICAL_FAMILIES as readonly string[]).includes(value);
}

/** The dispatch table as DATA, so a test asserts it instead of re-deriving it. */
export const CANONICAL_DISPATCH: Record<CanonicalFamily, { adapter: string; entry: string; note: string }> = {
  "stickers-labels": {
    adapter: "label-cost-inputs.server.ts",
    entry: "computeLabelJob",
    note: "Multi-line. Each line keeps its own size, material, cutline and physical run.",
  },
  "sticker-bags": {
    adapter: "bag-cost-inputs.server.ts",
    entry: "computeBagPhysical(product: sticker_bag_4x5)",
    note: "Customer artwork; normal art setup per design.",
  },
  "stock-bags": {
    adapter: "bag-cost-inputs.server.ts",
    entry: "computeBagPhysical(product: stock_bag)",
    note: "SAME physical adapter as sticker-bags. Premade base art, MOQ 50, optional logo/QR personalization.",
  },
  "standard-jars": {
    adapter: "jar-cost-inputs.server.ts",
    entry: "jarNestingAreas + jarCutGeometry (chiron / normal oz)",
    note: "ACTIVE SCOPE ONLY — Chiron 100ml, 100ml tall, 150ml and the 3oz/4oz jars. Art is PER_DESIGN, print PER_JOB.",
  },
  "premium-jars": {
    adapter: "jar-cost-inputs.server.ts",
    entry: "jarNestingAreas + jarCutGeometry (miron)",
    note: "ACTIVE SCOPE ONLY — Miron 50ml, 100ml, 100ml tall, 150ml, 250ml. Art is PER_DESIGN, print PER_JOB.",
  },
  banners: {
    adapter: "banner-cost-inputs.server.ts",
    entry: "computeBannerCost",
    note: "Material is ACTUAL media consumed from the nesting engine, never finished area.",
  },
};

/* ------------------------------------------------------------------ *
 * Reason codes
 * ------------------------------------------------------------------ */

export const CANONICAL_REASONS = {
  calibrationRequired: "MISSING_CALIBRATION",
  inkPriceRequired: "MISSING_INK_PRICE",
  materialCostRequired: "MISSING_MATERIAL_COST",
  familyUnsupported: "FAMILY_NOT_CANONICAL",
  quantityRequired: "QUANTITY_REQUIRED",
  packoutNotModeled: "PACKOUT_NOT_MODELED",
  freightNotModeled: "FREIGHT_NOT_MODELED",
  inkableAreaEstimated: "INKABLE_AREA_ESTIMATED",
  /** A requested label has no verified geometry for this product. */
  labelGeometryUnsupported: "LABEL_GEOMETRY_UNSUPPORTED",
  /** A job that prints nothing — no printed component was selected. */
  noPrintedComponent: "NO_PRINTED_COMPONENT",
  /** A requested label has no owner application-labor timing. */
  applicationStandardRequired: "MISSING_APPLICATION_STANDARD",
} as const;

/* ------------------------------------------------------------------ *
 * Packout — the owner standard, applied per family.
 *
 * $2.00/box is OWNER_STANDARDS.packoutPerBox. Units-per-box mirrors the
 * long-standing legacy rule so the cutover does not silently drop a cost the
 * legacy engine charged. Consumables are NOT modeled for these families (no
 * verified per-box consumable standard exists outside jars), and banners have
 * no verified tube-packout standard at all — both disclosed, never guessed.
 * ------------------------------------------------------------------ */

export const CANONICAL_PACKOUT: Record<CanonicalFamily, { unitsPerBox: number | null; source: string }> = {
  "stickers-labels": { unitsPerBox: 5000, source: "Legacy packing rule: 5,000 labels per box at the owner packout standard." },
  "sticker-bags": { unitsPerBox: 5000, source: "Legacy packing rule: 5,000 bags per box at the owner packout standard." },
  "stock-bags": { unitsPerBox: 5000, source: "Legacy packing rule: 5,000 bags per box at the owner packout standard." },
  banners: { unitsPerBox: null, source: "Banner tube packout has NO verified standard (BANNER_FINISHING_SUPPORT.TUBE_PACKOUT.verified = false)." },
  // Jars carry their OWN verified per-size box counts (JAR_UNITS_PER_BOX) plus
  // a consumables rate, so the adapter supplies packout directly and this
  // table is not consulted for them.
  "standard-jars": { unitsPerBox: null, source: "Jar packout comes from JAR_UNITS_PER_BOX per size, supplied by the jar adapter." },
  "premium-jars": { unitsPerBox: null, source: "Jar packout comes from JAR_UNITS_PER_BOX per size, supplied by the jar adapter." },
};

/* ------------------------------------------------------------------ *
 * Result shape (types only — the numbers are produced server-side)
 * ------------------------------------------------------------------ */

export type CanonicalDiagnostics = {
  /** Media physically consumed. */
  mediaConsumedSqft: number;
  /** Printer occupancy basis. */
  ripLayoutSqft: number | null;
  /** Printed artwork area — the ink basis. */
  inkableArtworkSqft: number;
  feedLengthIn: number | null;
  nestRotated: boolean | null;
  nestColumns: number | null;
  nestRows: number | null;
  machineMinutes: number | null;
  cutPathIn: number | null;
  cutMinutes: number | null;
  weedingPages: number | null;
  applicationEvents: number | null;
  physicalItems: number | null;
  applicationsPerItem: number | null;
  printedLabelsAvailable: number | null;
  artSetupEvents: number | null;
  printSetupEvents: number | null;
  personalizationSetupEvents: number | null;
  /** Owner decision: personalization is free to the customer. */
  personalizationCustomerAddOn: number | null;
};

/**
 * What the UI renders. Deliberately narrower than the server result: the
 * component never sees the raw adapter objects, only the authoritative
 * numbers the server already computed.
 */
export type CanonicalCalculatorView = {
  version: string;
  family: CanonicalFamily;
  status: TrueCostStatus;
  /** null whenever status is DRAFT_ONLY — a blocked job publishes no unit cost. */
  unitCost: number | null;
  totalCost: number;
  lines: TrueCostResult["lines"];
  totals: Record<CostCategory, number>;
  diagnostics: CanonicalDiagnostics;
  calibration: {
    resolved: boolean;
    identity: Record<string, string>;
    message: string;
    inkCostPerMl: number | null;
    inkCostSource: string;
  };
  setupBasis: { artBasis: CostBasis; printBasis: CostBasis; specialtyBasis: CostBasis | null };
  reasons: string[];
  blockers: string[];
};

/** Component labels, in the order the breakdown displays them. */
export const CANONICAL_COMPONENT_ORDER: Array<{ key: CostCategory; label: string }> = [
  { key: "materials", label: "Material (media consumed) + physical items" },
  { key: "ink", label: "Ink" },
  { key: "setup_labor", label: "Setup labor (art + print + specialty)" },
  { key: "run_labor", label: "Run labor (print + cut operator attention)" },
  { key: "finishing_application", label: "Finishing / weeding / application" },
  { key: "machine_recovery", label: "Equipment recovery (print + cutter)" },
  { key: "planned_overage", label: "Planned overage" },
  { key: "packout", label: "Packout" },
  { key: "inbound_freight", label: "Inbound freight" },
  { key: "outside_costs", label: "Outside costs" },
];

/* ------------------------------------------------------------------ *
 * 2D-4C2 — LIVE FORM -> CANONICAL LINE MAPPING
 *
 * Client-safe on purpose: the calculator form (browser) and the normaliser
 * (server) must agree on these mappings exactly, so both import them from
 * here rather than each keeping its own copy.
 * ------------------------------------------------------------------ */

/**
 * Resolve a live Material row's NAME to a canonical LABEL_MATERIALS key.
 *
 * WHY BY NAME. The Material model carries no finish key: `materialType` is a
 * family classifier ("label" / "dtp" / "box"), not matte-vs-gloss-vs-holo, and
 * `sku` is nullable and unset on these rolls. Name matching is not invented
 * here — it is the repo's EXISTING authority for these exact three media:
 * approved-cost-updates.server.ts matches the very same rolls with
 * /poseidon.*matte/i, /poseidon.*gloss/i and /holographic/i to drive
 * production cost updates, and canonical-bag-pricing.server.ts resolves its
 * media the same way. Reusing those patterns keeps ONE authority rather than
 * adding a fourth.
 *
 * Order matters: holographic is tested first because a holographic roll may
 * also be described as gloss.
 *
 * FAILS CLOSED. An unrecognised material returns null, the form emits no
 * material key, and canonical costing blocks with LABEL_MATERIAL_COST_REQUIRED
 * rather than guessing a rate. This function NEVER supplies a cost — it only
 * selects which verified canonical material applies.
 */
export function canonicalLabelMaterialKey(materialName: string | null | undefined): "matte" | "gloss" | "holographic" | null {
  const name = String(materialName || "");
  if (!name.trim()) return null;
  if (/holograph/i.test(name)) return "holographic";
  if (/gloss/i.test(name)) return "gloss";
  if (/matte|matt\b/i.test(name)) return "matte";
  return null;
}

/**
 * Map the calculator's cut-type option onto the canonical line cut model.
 *
 * square-rect / weeded  -> "rectangular": the entered actual cutline width and
 *                          height fully describe the cutter path.
 * kiss-* / die-irregular -> "contour": a rectangle is NOT the contour path, so
 *                          these need a measured outline length per item
 *                          (contourPerimeterIn), which the live form does not
 *                          yet collect. They correctly stay fail-closed.
 * none                  -> "none".
 */
export function canonicalLabelCutType(legacyCut: string | null | undefined): "rectangular" | "contour" | "none" {
  const value = String(legacyCut || "").trim().toLowerCase();
  if (value === "none") return "none";
  if (value.startsWith("kiss") || value.startsWith("die")) return "contour";
  return "rectangular"; // square-rect, weeded, and the default
}

/** Cut modes whose canonical geometry the live form can fully express today. */
export function canonicalCutTypeIsWireable(legacyCut: string | null | undefined): boolean {
  return canonicalLabelCutType(legacyCut) === "rectangular";
}

/* ------------------------------------------------------------------ *
 * 2D-4E5 — A KNOWN FAMILY MUST REACH THE CANONICAL GATE.
 *
 * The emergency / legacy-auto calculator panels post no `pfamily`, only the
 * researched MARGIN family (`efamily`: bags-4x5, chiron-jars, miron-jars,
 * stickers-labels, spot-gloss-labels, banners, ...). When that margin family
 * unambiguously names a canonical-authority manufacturing family, the save
 * must be judged by the canonical gate — a route omitting a field is not a
 * licence to quote on legacy math. Anything ambiguous or unknown returns
 * null and keeps its existing legacy behaviour; nothing is guessed.
 * ------------------------------------------------------------------ */
export function canonicalFamilyFromMarginFamilyKey(marginFamilyKey: string | null | undefined): CanonicalFamily | null {
  const key = String(marginFamilyKey || "").trim().toLowerCase();
  if (key === "bags-4x5") return "sticker-bags";
  if (key === "stickers-labels" || key === "spot-gloss-labels") return "stickers-labels";
  if (key === "banners") return "banners";
  if (key === "chiron-jars" || key === "miron-jars") return "premium-jars";
  return null;
}
