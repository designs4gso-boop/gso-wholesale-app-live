// ONE authoritative PRODUCT PRODUCTION SPEC layer for fixed products (2026-10-05).
//
// Answers "what does GSO normally print for this exact product?" from the
// repo's EXISTING authorities only — nothing here is a new number:
//   * jars: jar-active-scope.ts (which brand x size GSO offers) x
//           jar-label-geometry.ts (Patch 2A owner geometry the cost engine uses)
//   * bags: bag-artboard-geometry.ts (owner 4x5 artboard, 2D-2)
// A product with no authoritative dimensions is reported as
// OWNER_CONFIRMATION_REQUIRED and the calculator fails closed; dimensions are
// never inferred. Client-safe: pure data + pure functions.

import { ACTIVE_JAR_PROFILES, type ActiveJarProfile } from "./jar-active-scope";
import { JAR_LABEL_GEOMETRY, JAR_LABEL_GEOMETRY_SOURCE, JAR_LABEL_GEOMETRY_VERSION, formatJarGeometry, type JarLabelGeometry, type JarLabelSelection, type JarSizeKey } from "./jar-label-geometry";
import { BAG_4X5_ARTBOARD_IN, BAG_ARTBOARD_SOURCE } from "./bag-artboard-geometry";

export const PRODUCT_SPEC_VERSION = "product-production-spec/1.0.0-2026-10-05";

export type SpecPiece =
  | { piece: "side" | "tamper" | "label"; shape: "rect"; widthIn: number; heightIn: number; quantityPerProduct: number; label: string }
  | { piece: "lid"; shape: "circle"; diameterIn: number; quantityPerProduct: number; label: string };

export type LabelSetKey = "side_only" | "lid_only" | "side_lid";

export const LABEL_SETS: Array<{ key: LabelSetKey; label: string; selection: JarLabelSelection }> = [
  { key: "side_only", label: "Side Only", selection: { side: true, lid: false, tamper: false } },
  { key: "lid_only", label: "Lid Only", selection: { side: false, lid: true, tamper: false } },
  { key: "side_lid", label: "Side + Lid", selection: { side: true, lid: true, tamper: false } },
];

export type SpecStatus = "COST_AUTHORITY" | "OWNER_CONFIRMATION_REQUIRED";

export type ProductProductionSpec = {
  family: "standard-jars" | "premium-jars" | "sticker-bags" | "stock-bags";
  productKey: string;
  displayName: string;
  status: SpecStatus;
  /** Why the status is what it is; shown to staff and in docs. */
  statusNote: string;
  physical: Record<string, string | number>;
  pieces: SpecPiece[];
  labelSets: LabelSetKey[] | null;
  /** Optional extra band staff may add on jars; null where the owner recorded no timing. */
  optionalTamperBand: boolean | null;
  materials: string[];
  finishes: string[];
  routing: string;
  moqNote: string;
  pricingSource: string;
  source: { module: string; version: string; authority: string };
  missing: string[];
};

const jarTamperAllowed: Record<JarSizeKey, boolean> = {
  // Mirrors JAR_APPLICATION_SECONDS_BY_SIZE (jar-cost-inputs.server.ts): 3oz/4oz
  // have no owner lid-side/tamper timing, so the band blocks on those sizes.
  "50ml": true, "100ml_tall": true, "100ml_wide": true, "150ml": true, "250ml": true, "3oz": false, "4oz": false,
};

export function jarPiecesFor(geometry: JarLabelGeometry, selection?: JarLabelSelection): SpecPiece[] {
  const pieces: SpecPiece[] = [];
  if (!selection || selection.side) pieces.push({ piece: "side", shape: "rect", widthIn: geometry.side.widthIn, heightIn: geometry.side.heightIn, quantityPerProduct: 1, label: "Side label" });
  if (!selection || selection.lid) pieces.push({ piece: "lid", shape: "circle", diameterIn: geometry.lid.diameterIn, quantityPerProduct: 1, label: "Lid label" });
  if (!selection || selection.tamper) pieces.push({ piece: "tamper", shape: "rect", widthIn: geometry.tamper.widthIn, heightIn: geometry.tamper.heightIn, quantityPerProduct: 1, label: "Tamper / lid-side band" });
  return pieces;
}

function jarSpec(profile: ActiveJarProfile): ProductProductionSpec {
  const geometry = JAR_LABEL_GEOMETRY[profile.size as JarSizeKey];
  const missing: string[] = [];
  if (!geometry) missing.push("side/lid/tamper label geometry");
  return {
    family: profile.uiFamily,
    productKey: profile.key,
    displayName: profile.label,
    status: geometry ? "COST_AUTHORITY" : "OWNER_CONFIRMATION_REQUIRED",
    statusNote: geometry
      ? "Dimensions are the Patch 2A owner presets the canonical cost engine prices with. The RecipeLabelZone database rows (seed-jar-label-zone-dimensions.mjs) carry older ESTIMATED values that differ for most sizes and are never used for cost — owner confirmation of the preset table is recommended (docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md)."
      : "No authoritative label geometry exists for this jar; custom dimensions are required and must be owner-confirmed before use.",
    physical: { brand: profile.brand, size: profile.size, completeSet: "jar + lid (+ printed labels)" },
    pieces: geometry ? jarPiecesFor(geometry) : [],
    labelSets: ["side_only", "lid_only", "side_lid"],
    optionalTamperBand: jarTamperAllowed[profile.size as JarSizeKey] ?? null,
    materials: ["Poseidon Matte (jar label media) — canonical jar media"],
    finishes: ["matte", "gloss (base finish choice, no cost difference)"],
    routing: "CMYK -> Mimaki UCJV300-130; white/gloss -> Roland LG-640 (canonical routing)",
    moqNote: "Jar MOQ comes from product-family-sales-rules (jars) — not restated here.",
    pricingSource: "canonical true cost (jar adapter: verified complete-set blank, Poseidon media, calibrated ink/machine, GSO cutline, per-size application seconds, 1% planned overage, per-size packout)",
    source: { module: "jar-label-geometry.ts (via jar-cost-inputs.server.ts) + jar-active-scope.ts", version: JAR_LABEL_GEOMETRY_VERSION, authority: JAR_LABEL_GEOMETRY_SOURCE },
    missing,
  };
}

function bagSpec(family: "sticker-bags" | "stock-bags"): ProductProductionSpec {
  return {
    family,
    productKey: family === "sticker-bags" ? "bag-4x5/sticker" : "bag-4x5/stock",
    displayName: family === "sticker-bags" ? "4x5 Sticker Bag (custom applied label)" : "4x5 Stock Bag (premade GSO art)",
    status: "COST_AUTHORITY",
    statusNote: "Owner 4x5 artboard (2D-2); cutline 3.875 x 4.875 in derived by the GSO -0.0625 in rule.",
    physical: { bag: "4x5 in", blankCost: "BAG_4X5_BLANK_UNIT_COST (owner-corrected supplier base, freight separate)" },
    pieces: [{ piece: "label", shape: "rect", widthIn: BAG_4X5_ARTBOARD_IN.widthIn, heightIn: BAG_4X5_ARTBOARD_IN.heightIn, quantityPerProduct: 1, label: "Applied label (per printed side)" }],
    labelSets: null,
    optionalTamperBand: null,
    materials: ["matte", "gloss (holographic quote-only online)"],
    finishes: ["matte", "gloss"],
    routing: "CMYK -> Mimaki; white/gloss -> Roland (canonical routing)",
    moqNote: "MOQ 50 (owner-approved 2026-10-04; STICKER_BAG_MOQ / STOCK_BAG_MOQ)",
    pricingSource: "canonical true cost (bag adapter)",
    source: { module: "bag-artboard-geometry.ts (via bag-cost-inputs.server.ts)", version: "17D.6-bag-cost-inputs", authority: BAG_ARTBOARD_SOURCE },
    missing: [],
  };
}

export function listProductSpecs(): ProductProductionSpec[] {
  return [...ACTIVE_JAR_PROFILES.map(jarSpec), bagSpec("sticker-bags"), bagSpec("stock-bags")];
}

export function getProductProductionSpec(family: string | null | undefined, productKey: string | null | undefined): ProductProductionSpec | null {
  const key = String(productKey ?? "");
  return listProductSpecs().find((s) => s.productKey === key && (!family || s.family === family)) ?? null;
}

export function labelSetSelection(set: string | null | undefined, tamper = false): JarLabelSelection | null {
  const found = LABEL_SETS.find((s) => s.key === set);
  if (!found) return null;
  return { ...found.selection, tamper };
}

export function describeStandardSpec(spec: ProductProductionSpec, selection?: JarLabelSelection): string {
  if (spec.status !== "COST_AUTHORITY") return "STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED";
  if (spec.family === "standard-jars" || spec.family === "premium-jars") {
    const geometry = JAR_LABEL_GEOMETRY[String(spec.physical.size) as JarSizeKey];
    return formatJarGeometry(geometry, selection);
  }
  const p = spec.pieces[0];
  return p.shape === "rect" ? `${p.label} ${p.widthIn} x ${p.heightIn} in` : `${p.label} Ø ${p.diameterIn} in`;
}
