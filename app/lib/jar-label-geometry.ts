// Jar label GEOMETRY — the canonical cost authority, extracted verbatim from
// jar-cost-inputs.server.ts (Patch 2A / 17D.2 owner presets) on 2026-10-05 so
// the Cost Calculator form and the product-spec layer can read it CLIENT-SIDE
// without importing server-only engine code. jar-cost-inputs.server.ts
// re-exports these names; every cost path still reads exactly these numbers.
//
// NOT a second authority. Values are byte-identical to the previous inline
// table (tests pin that). The RecipeLabelZone database rows seeded by
// tools/seed-jar-label-zone-dimensions.mjs hold OLDER ESTIMATED geometry read
// only by admin screens, never by a cost path — see
// docs/GSO_FIXED_PRODUCT_SPEC_AUDIT.md for the size-by-size comparison.
//
// LABEL / ART SIZE vs CUTLINE (owner clarification 2026-11-11): every value in
// JAR_LABEL_GEOMETRY is the LABEL / ARTBOARD size — it drives artwork setup,
// nesting / media usage, ink area and the application spec. The CUTLINE is a
// SEPARATE value derived from it by the GSO rule (gso-cutline.ts): rectangle
// width - 0.125 x height - 0.125; circle diameter - 0.125. Cut-path length
// uses the cutline (jarCutGeometry). The art size is never overwritten with
// the cutline.
//
// Pure data + the dependency-free GSO cutline rule.

import { GSO_CUTLINE_INSET_PER_AXIS_IN, deriveGsoLabelCutDiameter, deriveGsoLabelCutlineFromArtboard } from "./gso-cutline";

export const JAR_LABEL_GEOMETRY_VERSION = "17D.2-jar-label-geometry";

export type JarSizeKey = "50ml" | "100ml_tall" | "100ml_wide" | "150ml" | "250ml" | "3oz" | "4oz" | "ceres_50ml" | "ceres_100ml";

export type JarLabelGeometry = {
  /** Side wrap, rectangular. */
  side: { widthIn: number; heightIn: number };
  /** Lid, CIRCULAR — diameter. Ink uses circle area; nesting uses the bounding box. */
  lid: { diameterIn: number };
  /** Optional tamper / lid-side band, rectangular. */
  tamper: { widthIn: number; heightIn: number };
};

/* ------------------------------------------------------------------ *
 * MIRON Ceres 50 mL + Yuha 48 / Ceres 100 mL + Yuha 58 (owner, 2026-11-17)
 *
 * The owner supplied these as physical CUT sizes BEFORE bleed, in
 * MILLIMETRES — and millimetres are the source of truth. Every other entry in
 * JAR_LABEL_GEOMETRY is a LABEL / ART size from which the cutline is derived
 * (art - 0.125 in per axis). So the art size stored for a Ceres label is the
 * exact inverse: cut + 0.125 in per axis (the one GSO bleed rule, added ONCE),
 * and the engine's derived cutline lands back on the owner's cut size.
 *
 * "side" = jar body wrap, "lid" = lid top circle, "tamper" = lid side band.
 *
 * PRELIMINARY: these are test-fit dimensions, not owner-approved production
 * dielines. They are NOT in JAR_OWNER_CONFIRMED_GEOMETRY, so every quote that
 * uses them shows the pending-confirmation status.
 * ------------------------------------------------------------------ */
export type JarCutGeometryMm = {
  side: { widthMm: number; heightMm: number };
  lid: { diameterMm: number };
  tamper: { widthMm: number; heightMm: number };
};

export const MIRON_CERES_LABEL_CUT_MM: Record<"ceres_50ml" | "ceres_100ml", JarCutGeometryMm> = {
  ceres_50ml: { side: { widthMm: 166.5, heightMm: 25.3 }, lid: { diameterMm: 45 }, tamper: { widthMm: 165, heightMm: 11 } },
  ceres_100ml: { side: { widthMm: 198, heightMm: 31 }, lid: { diameterMm: 50.8 }, tamper: { widthMm: 198, heightMm: 10 } },
};

export const MIRON_CERES_GEOMETRY_STATUS = "PHYSICAL SAMPLE TEST-FIT REQUIRED BEFORE PRODUCTION";
export const MIRON_CERES_GEOMETRY_NOTE =
  `${MIRON_CERES_GEOMETRY_STATUS} — preliminary test-fit cut sizes supplied by the owner in millimetres on 2026-11-17 (cut size before bleed). Usable for preliminary costing, calculator estimates, test prints and sample fitting only; not a production-verified dieline.`;

const MM_PER_INCH = 25.4;
/** Label / art size (inches, 4 dp = 0.0025 mm) for a CUT size in mm: cut + the GSO bleed, once. */
export function jarArtInFromCutMm(cutMm: number): number {
  return Math.round((cutMm / MM_PER_INCH + GSO_CUTLINE_INSET_PER_AXIS_IN) * 10000) / 10000;
}
function jarArtGeometryFromCutMm(cut: JarCutGeometryMm): JarLabelGeometry {
  return {
    side: { widthIn: jarArtInFromCutMm(cut.side.widthMm), heightIn: jarArtInFromCutMm(cut.side.heightMm) },
    lid: { diameterIn: jarArtInFromCutMm(cut.lid.diameterMm) },
    tamper: { widthIn: jarArtInFromCutMm(cut.tamper.widthMm), heightIn: jarArtInFromCutMm(cut.tamper.heightMm) },
  };
}

export const JAR_LABEL_GEOMETRY: Record<JarSizeKey, JarLabelGeometry> = {
  "50ml": { side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } },
  "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
  // 2026-11-11 owner-confirmed LABEL / ART sizes (supersede the Patch 2A presets
  // 250ml 9.4 x 2.9 / 2.1 / 9.4 x 0.6, 3oz 6.9 x 1.4 / 2.1, 4oz 7.125 x 1.4 / 2.1).
  "250ml": { side: { widthIn: 9.375, heightIn: 2.875 }, lid: { diameterIn: 2.02 }, tamper: { widthIn: 9.375, heightIn: 0.5 } },
  "3oz": { side: { widthIn: 7.06, heightIn: 1.7 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.06, heightIn: 0.5 } },
  "4oz": { side: { widthIn: 7.125, heightIn: 2.125 }, lid: { diameterIn: 2.16 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
  // 2026-11-17 MIRON Ceres — derived from the owner's millimetre CUT sizes (see MIRON_CERES_LABEL_CUT_MM). Preliminary.
  ceres_50ml: jarArtGeometryFromCutMm(MIRON_CERES_LABEL_CUT_MM.ceres_50ml),
  ceres_100ml: jarArtGeometryFromCutMm(MIRON_CERES_LABEL_CUT_MM.ceres_100ml),
};

/* ------------------------------------------------------------------ *
 * 2026-11-20 — jars with NO label geometry at all (Eris 60ml / 120ml).
 *
 * The owner supplied a supplier unit cost for the two Eris jars and nothing
 * else: no side label, lid label or band size, no circumference, no label
 * count. They are therefore deliberately NOT keys of JAR_LABEL_GEOMETRY (and
 * not a JarSizeKey): there is no number to store, and a placeholder would be
 * an invented dimension. Every cost path that needs a measurement blocks on
 * the note below instead. Add the size to JAR_LABEL_GEOMETRY only when the
 * owner supplies measured label sizes.
 * ------------------------------------------------------------------ */
export type JarGeometryPendingSizeKey = "eris_60ml" | "eris_120ml";

export const JAR_GEOMETRY_PENDING_LABEL = "LABEL GEOMETRY PENDING OWNER MEASUREMENT";

export const JAR_GEOMETRY_PENDING: Record<JarGeometryPendingSizeKey, string> = {
  eris_60ml: `${JAR_GEOMETRY_PENDING_LABEL} — Eris 60ml Jar: no label sizes (side label, lid label or band) have been provided by the owner, so label media, ink, print time and cutting cannot be measured. No dimension is assumed or borrowed from another jar.`,
  eris_120ml: `${JAR_GEOMETRY_PENDING_LABEL} — Eris 120ml Jar: no label sizes (side label, lid label or band) have been provided by the owner, so label media, ink, print time and cutting cannot be measured. No dimension is assumed or borrowed from another jar.`,
};

/** The pending-measurement note for a size with no label geometry, or null for every other size. */
export function jarGeometryPendingNote(size: string | null | undefined): string | null {
  const key = String(size ?? "");
  // Geometry KNOWN always wins: the day a size gets an entry in JAR_LABEL_GEOMETRY it stops being pending,
  // and every label-area calculation resumes with no other change.
  if (Object.prototype.hasOwnProperty.call(JAR_LABEL_GEOMETRY, key)) return null;
  return Object.prototype.hasOwnProperty.call(JAR_GEOMETRY_PENDING, key) ? JAR_GEOMETRY_PENDING[key as JarGeometryPendingSizeKey] : null;
}

/** CUTLINE geometry — derived from the label / art size, never stored over it. */
export type JarCutlineGeometry = {
  side: { cutWidthIn: number; cutHeightIn: number } | null;
  lid: { cutDiameterIn: number } | null;
  tamper: { cutWidthIn: number; cutHeightIn: number } | null;
};

/** The GSO cutline for each piece of a label / art geometry (null when too small to offset). */
export function jarCutlineFor(g: JarLabelGeometry): JarCutlineGeometry {
  const side = deriveGsoLabelCutlineFromArtboard(g.side.widthIn, g.side.heightIn);
  const tamper = deriveGsoLabelCutlineFromArtboard(g.tamper.widthIn, g.tamper.heightIn);
  const lid = deriveGsoLabelCutDiameter(g.lid.diameterIn);
  return {
    side: side ? { cutWidthIn: side.cutWidthIn, cutHeightIn: side.cutHeightIn } : null,
    lid: lid != null ? { cutDiameterIn: lid } : null,
    tamper: tamper ? { cutWidthIn: tamper.cutWidthIn, cutHeightIn: tamper.cutHeightIn } : null,
  };
}

export const JAR_LABEL_GEOMETRY_SOURCE = "jar-cost-inputs.server.ts JAR_LABEL_GEOMETRY — Patch 2A (17D.2) presets; the only geometry any cost path reads";

/**
 * AUTHORITY STATUS of a fixed-product dimension source (2026-10-05 release gate).
 *
 *  OWNER_CONFIRMED                          — repo holds an explicit owner
 *                                              confirmation record for the
 *                                              physical dimension.
 *  CANONICAL_COSTING_PENDING_CONFIRMATION   — the dimension is what the
 *                                              canonical cost engine prices
 *                                              with TODAY, but no owner record
 *                                              physically confirms it.
 *  UNSUPPORTED                              — no costing geometry; fail closed.
 */
export type SpecAuthorityStatus = "OWNER_CONFIRMED" | "CANONICAL_COSTING_PENDING_CONFIRMATION" | "UNSUPPORTED";

/**
 * Provenance of the table above. The numbers entered the repo in commit
 * 5246607 (Patch 2A / 17D.2, 2026-08-19) self-labelled "owner presets" with
 * NO OWNER_STANDARDS entry, no dated decision and no measurement record —
 * the same pattern 2D-4D2 audited for the 1% overage before the owner
 * confirmed it. Until a physical confirmation is recorded, the table is the
 * current canonical COSTING geometry, not a confirmed PRODUCTION dimension.
 * 2026-11-11: 100ml tall / 100ml wide / 150ml are now owner-confirmed — see
 * JAR_OWNER_CONFIRMED_GEOMETRY and jarGeometryAuthorityFor (per size).
 */
export const JAR_LABEL_GEOMETRY_AUTHORITY = {
  authorityStatus: "CANONICAL_COSTING_PENDING_CONFIRMATION" as SpecAuthorityStatus,
  ownerConfirmationRequired: true,
  source: JAR_LABEL_GEOMETRY_SOURCE,
  version: JAR_LABEL_GEOMETRY_VERSION,
  introducedIn: "5246607 (Patch 2A / 17D.2, 2026-08-19)",
  ownerRecord: null as string | null,
  note: "Current canonical costing geometry. Physical dimensions need owner confirmation (docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md). No cost changes until the owner confirms.",
} as const;

/**
 * OWNER CONFIRMATION 2026-11-11 — LABEL / ART sizes (not cutlines) that are
 * OWNER-CONFIRMED. Miron AND Chiron share them (Chiron uses the same geometry
 * as the equivalent Miron size). Cutline = label - 0.125 per dimension
 * (diameter - 0.125 for lids), derived by jarCutlineFor:
 *   100ml tall  side 6.3 x 3.15    lid 1.75   band 6.3 x 0.5
 *   100ml wide  side 6.6 x 2.6     lid 1.9    band 6.6 x 0.5
 *   150ml       side 7.125 x 3.125 lid 2.0    band 7.125 x 0.6
 *   250ml       side 9.375 x 2.875 lid 2.02   band 9.375 x 0.5
 *   3oz         side 7.06 x 1.7    lid 2.0    band 7.06 x 0.5
 *   4oz         side 7.125 x 2.125 lid 2.16   band 7.125 x 0.5
 * 50ml keeps JAR_LABEL_GEOMETRY_AUTHORITY (pending confirmation).
 */
export const JAR_OWNER_CONFIRMED_GEOMETRY: Partial<Record<JarSizeKey, JarLabelGeometry>> = {
  "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
  "250ml": { side: { widthIn: 9.375, heightIn: 2.875 }, lid: { diameterIn: 2.02 }, tamper: { widthIn: 9.375, heightIn: 0.5 } },
  "3oz": { side: { widthIn: 7.06, heightIn: 1.7 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.06, heightIn: 0.5 } },
  "4oz": { side: { widthIn: 7.125, heightIn: 2.125 }, lid: { diameterIn: 2.16 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
};
export const JAR_GEOMETRY_OWNER_RECORD = "Owner confirmation 2026-11-11: label / art sizes for 100ml tall, 100ml wide, 150ml, 250ml, 3oz and 4oz (Miron and Chiron share the same geometry; cutline = label - 0.125 in per dimension)";

/** Authority for ONE size: owner-confirmed sizes are OWNER_CONFIRMED; the rest stay pending. */
export function jarGeometryAuthorityFor(size: string | null | undefined): { authorityStatus: SpecAuthorityStatus; ownerConfirmationRequired: boolean; ownerRecord: string | null } {
  // 2026-11-20: a size with NO geometry (Eris) is UNSUPPORTED — it is not "costing geometry pending confirmation".
  if (jarGeometryPendingNote(size)) return { authorityStatus: "UNSUPPORTED", ownerConfirmationRequired: true, ownerRecord: null };
  const confirmed = Boolean(size && JAR_OWNER_CONFIRMED_GEOMETRY[size as JarSizeKey]);
  return confirmed
    ? { authorityStatus: "OWNER_CONFIRMED", ownerConfirmationRequired: false, ownerRecord: JAR_GEOMETRY_OWNER_RECORD }
    : { authorityStatus: JAR_LABEL_GEOMETRY_AUTHORITY.authorityStatus, ownerConfirmationRequired: true, ownerRecord: null };
}

export type JarLabelSelection = { side: boolean; lid: boolean; tamper: boolean };

/**
 * A staff-entered CUSTOM SIZE OVERRIDE. Every field is optional at the type
 * level; validateJarGeometryOverride enforces completeness per selected piece.
 */
export type JarGeometryOverride = {
  side?: { widthIn: number; heightIn: number };
  lid?: { diameterIn: number };
  tamper?: { widthIn: number; heightIn: number };
};

/** The GSO cutline inset per axis (2 x 0.0625in). A piece smaller than this cannot be cut. */
export const MIN_OVERRIDE_DIMENSION_IN = 0.126;
export const MAX_OVERRIDE_DIMENSION_IN = 54; // loaded media width; nothing wider can be printed in one piece

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export type OverrideValidation = { ok: true; geometry: JarLabelGeometry; overridden: Array<keyof JarLabelGeometry> } | { ok: false; errors: string[] };

/**
 * Builds the effective geometry for a job: the standard table for every piece
 * unless the staff member supplied a COMPLETE, in-range override for a
 * SELECTED piece. Fails closed: a partial override, an out-of-range value, or an
 * override for a piece that is not selected is an error, never a fallback.
 */
export function validateJarGeometryOverride(size: JarSizeKey, selection: JarLabelSelection, override: JarGeometryOverride | null | undefined): OverrideValidation {
  const standard = JAR_LABEL_GEOMETRY[size];
  if (!standard) return { ok: false, errors: [`no standard geometry for jar size "${size}"`] };
  if (!override) return { ok: true, geometry: standard, overridden: [] };
  const errors: string[] = [];
  const overridden: Array<keyof JarLabelGeometry> = [];
  const geometry: JarLabelGeometry = { side: { ...standard.side }, lid: { ...standard.lid }, tamper: { ...standard.tamper } };
  const inRange = (n: number) => n >= MIN_OVERRIDE_DIMENSION_IN && n <= MAX_OVERRIDE_DIMENSION_IN;

  for (const piece of ["side", "tamper"] as const) {
    const o = override[piece];
    if (!o) continue;
    if (!selection[piece]) { errors.push(`${piece} override supplied but the ${piece} label is not in the selected label set`); continue; }
    const w = o.widthIn, h = o.heightIn;
    if (!positive(w) || !positive(h)) { errors.push(`${piece} override needs BOTH a positive width and height (got ${String(w)} x ${String(h)})`); continue; }
    if (!inRange(w) || !inRange(h)) { errors.push(`${piece} override ${w} x ${h} in is outside ${MIN_OVERRIDE_DIMENSION_IN}-${MAX_OVERRIDE_DIMENSION_IN} in`); continue; }
    geometry[piece] = { widthIn: w, heightIn: h };
    overridden.push(piece);
  }
  if (override.lid) {
    if (!selection.lid) errors.push("lid override supplied but the lid label is not in the selected label set");
    else {
      const d = override.lid.diameterIn;
      if (!positive(d)) errors.push(`lid override needs a positive diameter (got ${String(d)})`);
      else if (!inRange(d)) errors.push(`lid override diameter ${d} in is outside ${MIN_OVERRIDE_DIMENSION_IN}-${MAX_OVERRIDE_DIMENSION_IN} in`);
      else { geometry.lid = { diameterIn: d }; overridden.push("lid"); }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, geometry, overridden };
}

/** Read-only CUTLINE line (derived from the label / art size). */
export function formatJarCutline(g: JarLabelGeometry, selection?: JarLabelSelection): string {
  const c = jarCutlineFor(g);
  const f = (n: number) => n.toFixed(3);
  const parts: string[] = [];
  if (!selection || selection.side) parts.push(c.side ? `Side ${f(c.side.cutWidthIn)} x ${f(c.side.cutHeightIn)} in` : "Side —");
  if (!selection || selection.lid) parts.push(c.lid ? `Lid Ø ${f(c.lid.cutDiameterIn)} in` : "Lid —");
  if (!selection || selection.tamper) parts.push(c.tamper ? `Tamper band ${f(c.tamper.cutWidthIn)} x ${f(c.tamper.cutHeightIn)} in` : "Tamper band —");
  return parts.join(" · ");
}

/** Read-only LABEL / ART size line. */
export function formatJarGeometry(g: JarLabelGeometry, selection?: JarLabelSelection): string {
  const parts: string[] = [];
  if (!selection || selection.side) parts.push(`Side ${g.side.widthIn} x ${g.side.heightIn} in`);
  if (!selection || selection.lid) parts.push(`Lid Ø ${g.lid.diameterIn} in`);
  if (!selection || selection.tamper) parts.push(`Tamper band ${g.tamper.widthIn} x ${g.tamper.heightIn} in`);
  return parts.join(" · ");
}
