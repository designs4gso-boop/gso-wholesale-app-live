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
import { JAR_LABEL_GEOMETRY, JAR_LABEL_GEOMETRY_SOURCE, jarCutlineFor, jarGeometryAuthorityFor, JAR_LABEL_GEOMETRY_VERSION, formatJarGeometry, type JarLabelGeometry, type JarLabelSelection, type JarSizeKey, type SpecAuthorityStatus } from "./jar-label-geometry";
import { JAR_REFERENCE_GEOMETRY_SOURCE, jarReferenceConflicts, type ReferenceConflict } from "./jar-reference-geometry";
import { BAG_4X5_ARTBOARD_IN, BAG_4X5_CUTLINE_IN, BAG_ARTBOARD_SOURCE, SPLIT_BAG_ARTBOARD_IN, SPLIT_BAG_CUTLINE_IN, SPLIT_BAG_GEOMETRY_DECISION } from "./bag-artboard-geometry";

export const PRODUCT_SPEC_VERSION = "product-production-spec/1.1.0-2026-10-05";

/**
 * Bag artboard evidence (the only fixed product with an explicit record):
 * 2D-4C2A benchmarked the ACTUAL 4x5 bag artboard (4.00 x 5.00) against its
 * cutline and the sticker-bag product has shipped on it since
 * 15G. Recorded here so the status is traceable, not asserted.
 */
export const BAG_ARTBOARD_AUTHORITY = {
  authorityStatus: "OWNER_CONFIRMED" as SpecAuthorityStatus,
  ownerConfirmationRequired: false,
  evidence: `Owner 4x5 artboard 4.00 x 5.00 (2D-2) with the documented owner cutline ${BAG_4X5_CUTLINE_IN.widthIn} x ${BAG_4X5_CUTLINE_IN.heightIn} (owner decision 2026-11-11); live sticker-bag production since 15G`,
} as const;

export const AUTHORITY_LABEL: Record<SpecAuthorityStatus, string> = {
  OWNER_CONFIRMED: "STANDARD PRODUCTION SPEC",
  CANONICAL_COSTING_PENDING_CONFIRMATION: "CURRENT CANONICAL COSTING GEOMETRY",
  UNSUPPORTED: "STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED",
};
export const PENDING_CONFIRMATION_WARNING = "PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION";

/** widthIn / heightIn / diameterIn are the LABEL / ART size; cut* is the derived CUTLINE (jar pieces). */
export type SpecPiece =
  | { piece: "side" | "tamper" | "label"; shape: "rect"; widthIn: number; heightIn: number; quantityPerProduct: number; label: string; cutWidthIn?: number | null; cutHeightIn?: number | null }
  | { piece: "lid"; shape: "circle"; diameterIn: number; quantityPerProduct: number; label: string; cutDiameterIn?: number | null };

export type LabelSetKey = "side_only" | "lid_only" | "side_lid";

export const LABEL_SETS: Array<{ key: LabelSetKey; label: string; selection: JarLabelSelection }> = [
  { key: "side_only", label: "Side Only", selection: { side: true, lid: false, tamper: false } },
  { key: "lid_only", label: "Lid Only", selection: { side: false, lid: true, tamper: false } },
  { key: "side_lid", label: "Side + Lid", selection: { side: true, lid: true, tamper: false } },
];

export type SpecStatus = "COST_AUTHORITY" | "OWNER_CONFIRMATION_REQUIRED";

export type ProductProductionSpec = {
  family: "standard-jars" | "premium-jars" | "sticker-bags" | "stock-bags" | "split-bags";
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
  /** True when the band is selectable but has no owner application timing (job stays needs-review). */
  tamperApplicationLaborPending: boolean | null;
  materials: string[];
  finishes: string[];
  routing: string;
  moqNote: string;
  pricingSource: string;
  source: { module: string; version: string; authority: string };
  missing: string[];
  /** 2026-10-05 release gate: how strong the dimension evidence is. */
  authorityStatus: SpecAuthorityStatus;
  ownerConfirmationRequired: boolean;
  /** Short staff wording for the authority state (never stronger than the evidence). */
  authorityNote: string;
  /** Fields where the admin reference rows disagree with the costing geometry. */
  referenceConflicts: ReferenceConflict[];
  /** One staff-readable sentence, or null when nothing conflicts. */
  conflictSummary: string | null;
  /** Chiron: costing uses the shared Miron size key; no Chiron-specific geometry exists. */
  sharedSizeKeyNote: string | null;
};

// 2026-11-12 owner correction: EVERY active jar size uses a Side Lid / tamper
// band — 3oz (art 7.06 x 0.5, cutline 6.935 x 0.375) and 4oz (art 7.125 x 0.5,
// cutline 7.0 x 0.375) included, so the option is selectable on all of them.
const jarTamperAllowed: Record<JarSizeKey, boolean> = {
  "50ml": true, "100ml_tall": true, "100ml_wide": true, "150ml": true, "250ml": true, "3oz": true, "4oz": true,
};
// Mirrors JAR_APPLICATION_SECONDS_BY_SIZE (jar-cost-inputs.server.ts): 3oz/4oz
// have NO owner band APPLICATION timing. The band's print / media / ink / cut
// still cost; the job stays DRAFT_ONLY (needs review / quote-only) on
// MISSING_APPLICATION_STANDARD until the owner times it. Never borrowed.
const jarTamperApplicationPending: Record<JarSizeKey, boolean> = {
  "50ml": false, "100ml_tall": false, "100ml_wide": false, "150ml": false, "250ml": false, "3oz": true, "4oz": true,
};

export function jarPiecesFor(geometry: JarLabelGeometry, selection?: JarLabelSelection): SpecPiece[] {
  const cut = jarCutlineFor(geometry);
  const pieces: SpecPiece[] = [];
  if (!selection || selection.side) pieces.push({ piece: "side", shape: "rect", widthIn: geometry.side.widthIn, heightIn: geometry.side.heightIn, quantityPerProduct: 1, label: "Side label", cutWidthIn: cut.side?.cutWidthIn ?? null, cutHeightIn: cut.side?.cutHeightIn ?? null });
  if (!selection || selection.lid) pieces.push({ piece: "lid", shape: "circle", diameterIn: geometry.lid.diameterIn, quantityPerProduct: 1, label: "Lid label", cutDiameterIn: cut.lid?.cutDiameterIn ?? null });
  if (!selection || selection.tamper) pieces.push({ piece: "tamper", shape: "rect", widthIn: geometry.tamper.widthIn, heightIn: geometry.tamper.heightIn, quantityPerProduct: 1, label: "Tamper / lid-side band", cutWidthIn: cut.tamper?.cutWidthIn ?? null, cutHeightIn: cut.tamper?.cutHeightIn ?? null });
  return pieces;
}

function jarSpec(profile: ActiveJarProfile): ProductProductionSpec {
  const geometry = JAR_LABEL_GEOMETRY[profile.size as JarSizeKey];
  const missing: string[] = [];
  if (!geometry) missing.push("side/lid/tamper label geometry");
  const referenceConflicts = geometry ? jarReferenceConflicts(profile.size as JarSizeKey, geometry) : [];
  const conflictSummary = referenceConflicts.length
    ? `Reference setup lists a different ${referenceConflicts.map((c) => c.text).join("; ")}. Current quote uses the existing canonical cost-engine geometry.`
    : null;
  const sizeAuthority = jarGeometryAuthorityFor(profile.size);
  const confirmed = Boolean(geometry) && sizeAuthority.authorityStatus === "OWNER_CONFIRMED";
  const sharedSizeKeyNote = profile.brand === "chiron"
    ? confirmed
      ? `Chiron ${profile.size.replace("_", " ")} uses the same owner-confirmed label geometry as the equivalent Miron size (owner confirmation 2026-11-11).`
      : `Chiron ${profile.size.replace("_", " ")} is costed with the shared "${profile.size}" size key; no Chiron-specific label geometry exists in the system. Owner confirmation required.`
    : null;
  const authorityStatus: SpecAuthorityStatus = geometry ? sizeAuthority.authorityStatus : "UNSUPPORTED";
  return {
    authorityStatus,
    ownerConfirmationRequired: !confirmed,
    authorityNote: !geometry
      ? AUTHORITY_LABEL.UNSUPPORTED
      : confirmed
        ? `${AUTHORITY_LABEL.OWNER_CONFIRMED} — owner-confirmed physical label dimensions (${sizeAuthority.ownerRecord}).`
        : `${AUTHORITY_LABEL[authorityStatus]} — ${PENDING_CONFIRMATION_WARNING}. Not owner-confirmed; the quote uses what the cost engine prices with today.`,
    referenceConflicts,
    conflictSummary,
    sharedSizeKeyNote,
    family: profile.uiFamily,
    productKey: profile.key,
    displayName: profile.label,
    status: geometry ? "COST_AUTHORITY" : "OWNER_CONFIRMATION_REQUIRED",
    statusNote: confirmed
      ? "Owner-confirmed physical label dimensions (2026-11-11) — the canonical geometry for label media, ink, cutting, weeding and application. Older RecipeLabelZone reference values for this size are superseded and never used."
      : geometry
      ? "Dimensions are the Patch 2A presets the canonical cost engine prices with today; they are NOT physically owner-confirmed. The RecipeLabelZone database rows (seed-jar-label-zone-dimensions.mjs) carry older ESTIMATED values that differ for most sizes and are never used for cost. Owner confirmation of the physical dimensions is required (docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md)."
      : "No costing geometry exists for this jar; it cannot be quoted. Owner must supply confirmed dimensions before use.",
    physical: { brand: profile.brand, size: profile.size, completeSet: "jar + lid (+ printed labels)" },
    pieces: geometry ? jarPiecesFor(geometry) : [],
    labelSets: ["side_only", "lid_only", "side_lid"],
    optionalTamperBand: jarTamperAllowed[profile.size as JarSizeKey] ?? null,
    tamperApplicationLaborPending: jarTamperApplicationPending[profile.size as JarSizeKey] ?? null,
    materials: ["Poseidon Matte (jar label media) — canonical jar media"],
    finishes: ["matte", "gloss (base finish choice, no cost difference)"],
    routing: "Gloss -> Roland LG-640; CMYK / White -> either press, Auto = less busy cost-ready press (canonical routing)",
    moqNote: "Jar MOQ comes from product-family-sales-rules (jars) — not restated here.",
    pricingSource: "canonical true cost (jar adapter: verified complete-set blank, Poseidon media, calibrated ink/machine, GSO cutline, per-size application seconds, 1% planned overage, per-size packout)",
    source: { module: "jar-label-geometry.ts (via jar-cost-inputs.server.ts) + jar-active-scope.ts", version: JAR_LABEL_GEOMETRY_VERSION, authority: `${JAR_LABEL_GEOMETRY_SOURCE}; reference: ${JAR_REFERENCE_GEOMETRY_SOURCE}` },
    missing,
  };
}

function bagSpec(family: "sticker-bags" | "stock-bags"): ProductProductionSpec {
  return {
    family,
    productKey: family === "sticker-bags" ? "bag-4x5/sticker" : "bag-4x5/stock",
    displayName: family === "sticker-bags" ? "4x5 Sticker Bag (custom applied label)" : "4x5 Stock Bag (premade GSO art)",
    status: "COST_AUTHORITY",
    authorityStatus: BAG_ARTBOARD_AUTHORITY.authorityStatus,
    ownerConfirmationRequired: BAG_ARTBOARD_AUTHORITY.ownerConfirmationRequired,
    authorityNote: `${AUTHORITY_LABEL.OWNER_CONFIRMED} — ${BAG_ARTBOARD_AUTHORITY.evidence}`,
    referenceConflicts: [],
    conflictSummary: null,
    sharedSizeKeyNote: null,
    statusNote: `Owner 4x5 artboard (2D-2); owner cutline ${BAG_4X5_CUTLINE_IN.widthIn} x ${BAG_4X5_CUTLINE_IN.heightIn} in (decision 2026-11-11).`,
    physical: { bag: "4x5 in", blankCost: "BAG_4X5_BLANK_UNIT_COST ($0.11 owner true base cost, 2026-10-08; no freight uplift)" },
    pieces: [{ piece: "label", shape: "rect", widthIn: BAG_4X5_ARTBOARD_IN.widthIn, heightIn: BAG_4X5_ARTBOARD_IN.heightIn, quantityPerProduct: 1, label: "Applied label (per printed side)" }],
    labelSets: null,
    optionalTamperBand: null,
    tamperApplicationLaborPending: null,
    materials: ["matte", "gloss (holographic quote-only online)"],
    finishes: ["matte", "gloss"],
    routing: "Gloss -> Roland; CMYK / White -> either press, Auto = less busy cost-ready press (canonical routing)",
    moqNote: "MOQ 50 (owner-approved 2026-10-04; STICKER_BAG_MOQ / STOCK_BAG_MOQ)",
    pricingSource: "canonical true cost (bag adapter)",
    source: { module: "bag-artboard-geometry.ts (via bag-cost-inputs.server.ts)", version: "17D.6-bag-cost-inputs", authority: BAG_ARTBOARD_SOURCE },
    missing: [],
  };
}

/**
 * 2026-11-11 owner decision (corrected): the Split Bag is a Sticker Bag blank
 * variant — ONE bag, MOQ 64, ONE label per printed side (2026-11-12: $0.14
 * vendor blank + $0.024 inbound freight = $0.164 landed; supersedes $0.25).
 * 2026-11-12 owner correction: the Split Bag label is NOT the 4x5 — its own
 * owner-measured art / print size 7.20 x 4.38 in and cutline 7.07 x 4.26 in.
 */
function splitBagSpec(): ProductProductionSpec {
  const base = bagSpec("sticker-bags");
  return {
    ...base,
    family: "split-bags",
    productKey: "split-bag",
    displayName: "Split Bag (Sticker Bag blank, custom applied labels)",
    authorityNote: `${AUTHORITY_LABEL.OWNER_CONFIRMED} — ${SPLIT_BAG_GEOMETRY_DECISION}`,
    statusNote: `One Split Bag label per printed side (front only / back only = 1 label, front + back = 2): art / print ${SPLIT_BAG_ARTBOARD_IN.widthIn.toFixed(2)} x ${SPLIT_BAG_ARTBOARD_IN.heightIn.toFixed(2)} in, cutline ${SPLIT_BAG_CUTLINE_IN.widthIn.toFixed(2)} x ${SPLIT_BAG_CUTLINE_IN.heightIn.toFixed(2)} in (owner correction 2026-11-12).`,
    physical: { bag: "one Split Bag blank", blankCost: "SPLIT_BAG_BLANK_UNIT_COST ($0.14 vendor cost) + SPLIT_BAG_INBOUND_FREIGHT_PER_UNIT ($0.024 inbound freight) = $0.164 landed (owner final vendor quote 2026-11-12)" },
    pieces: [{ piece: "label", shape: "rect", widthIn: SPLIT_BAG_ARTBOARD_IN.widthIn, heightIn: SPLIT_BAG_ARTBOARD_IN.heightIn, quantityPerProduct: 1, label: "Applied Split Bag label (one per printed side)", cutWidthIn: SPLIT_BAG_CUTLINE_IN.widthIn, cutHeightIn: SPLIT_BAG_CUTLINE_IN.heightIn }],
    moqNote: "MOQ 64 (owner decision 2026-11-11; SPLIT_BAG_MOQ). Packout is not modeled yet (vendor carton = 2,500 bags; carton dimensions / weight pending receipt). Inbound freight is the owner's real lot allocation ($120 / 5,000 = $0.024 per bag); outbound customer freight is never assumed.",
    pricingSource: "canonical true cost (bag adapter, split_bag); no owner-approved selling price yet — OWNER-SET CUSTOMER PRICE, THIS QUOTE ONLY",
  };
}

export function listProductSpecs(): ProductProductionSpec[] {
  return [...ACTIVE_JAR_PROFILES.map(jarSpec), bagSpec("sticker-bags"), bagSpec("stock-bags"), splitBagSpec()];
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
  if (spec.status !== "COST_AUTHORITY" || spec.authorityStatus === "UNSUPPORTED") return AUTHORITY_LABEL.UNSUPPORTED;
  if (spec.family === "standard-jars" || spec.family === "premium-jars") {
    const geometry = JAR_LABEL_GEOMETRY[String(spec.physical.size) as JarSizeKey];
    return formatJarGeometry(geometry, selection);
  }
  const p = spec.pieces[0];
  return p.shape === "rect" ? `${p.label} ${p.widthIn} x ${p.heightIn} in` : `${p.label} Ø ${p.diameterIn} in`;
}
