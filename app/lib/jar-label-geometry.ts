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
// Pure data, no imports.

export const JAR_LABEL_GEOMETRY_VERSION = "17D.2-jar-label-geometry";

export type JarSizeKey = "50ml" | "100ml_tall" | "100ml_wide" | "150ml" | "250ml" | "3oz" | "4oz";

export type JarLabelGeometry = {
  /** Side wrap, rectangular. */
  side: { widthIn: number; heightIn: number };
  /** Lid, CIRCULAR — diameter. Ink uses circle area; nesting uses the bounding box. */
  lid: { diameterIn: number };
  /** Optional tamper / lid-side band, rectangular. */
  tamper: { widthIn: number; heightIn: number };
};

export const JAR_LABEL_GEOMETRY: Record<JarSizeKey, JarLabelGeometry> = {
  "50ml": { side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } },
  "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
  "250ml": { side: { widthIn: 9.4, heightIn: 2.9 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 9.4, heightIn: 0.6 } },
  "3oz": { side: { widthIn: 6.9, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 6.9, heightIn: 0.5 } },
  "4oz": { side: { widthIn: 7.125, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
};

export const JAR_LABEL_GEOMETRY_SOURCE = "jar-cost-inputs.server.ts JAR_LABEL_GEOMETRY — Patch 2A (17D.2) owner presets; the only geometry any cost path reads";

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

export function formatJarGeometry(g: JarLabelGeometry, selection?: JarLabelSelection): string {
  const parts: string[] = [];
  if (!selection || selection.side) parts.push(`Side ${g.side.widthIn} x ${g.side.heightIn} in`);
  if (!selection || selection.lid) parts.push(`Lid Ø ${g.lid.diameterIn} in`);
  if (!selection || selection.tamper) parts.push(`Tamper band ${g.tamper.widthIn} x ${g.tamper.heightIn} in`);
  return parts.join(" · ");
}
