// RecipeLabelZone REFERENCE geometry — copied verbatim from
// tools/seed-jar-label-zone-dimensions.mjs (2026-10-05) so the product-spec
// layer can DISCLOSE where the admin reference rows disagree with the
// canonical costing geometry.
//
// THIS IS NOT A COST AUTHORITY. No cost path reads it. Every row in the seed
// is self-described "Estimated ... Verify with physical jar". It exists here
// only so staff can be told, in the calculator, that a different reference
// value exists for a dimension. Do not reconcile either table to the other
// until the owner physically confirms the jars (docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md).
//
// Pure data, no imports.

import type { JarLabelGeometry, JarSizeKey } from "./jar-label-geometry";

export const JAR_REFERENCE_GEOMETRY_SOURCE = "RecipeLabelZone rows seeded by tools/seed-jar-label-zone-dimensions.mjs (admin reference, self-described estimates; NOT a cost authority)";

/** Seed values by size key; the seed's "Lid side label" is the tamper band. */
export const JAR_REFERENCE_GEOMETRY: Partial<Record<JarSizeKey, JarLabelGeometry>> = {
  "50ml": { side: { widthIn: 5.75, heightIn: 1.625 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 5.75, heightIn: 0.5 } },
  "100ml_tall": { side: { widthIn: 6.125, heightIn: 3.125 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.125, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.43, heightIn: 2.6 }, lid: { diameterIn: 1.875 }, tamper: { widthIn: 6.43, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
  "250ml": { side: { widthIn: 9.375, heightIn: 2.875 }, lid: { diameterIn: 2 }, tamper: { widthIn: 9.375, heightIn: 0.5 } },
  // 3oz / 4oz seed rows carry NO lid-side band row.
  "3oz": { side: { widthIn: 7.1, heightIn: 1.7 }, lid: { diameterIn: 2 }, tamper: { widthIn: Number.NaN, heightIn: Number.NaN } },
  "4oz": { side: { widthIn: 7.125, heightIn: 2.125 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: Number.NaN, heightIn: Number.NaN } },
};

export type ReferenceConflict = {
  piece: "side" | "lid" | "tamper";
  field: "widthIn" | "heightIn" | "diameterIn";
  canonical: number;
  reference: number;
  /** Staff wording. */
  text: string;
};

const PIECE_LABEL = { side: "side label", lid: "lid label", tamper: "tamper band" } as const;
const FIELD_LABEL = { widthIn: "width", heightIn: "height", diameterIn: "diameter" } as const;

/**
 * Every field where the reference rows disagree with the canonical costing
 * geometry for the given size. Pieces the reference has no row for (NaN) are
 * not conflicts. Equal values are not conflicts.
 */
export function jarReferenceConflicts(size: JarSizeKey, canonical: JarLabelGeometry): ReferenceConflict[] {
  const ref = JAR_REFERENCE_GEOMETRY[size];
  if (!ref) return [];
  const out: ReferenceConflict[] = [];
  const check = (piece: ReferenceConflict["piece"], field: ReferenceConflict["field"], c: number, r: number) => {
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    if (Math.abs(c - r) < 1e-9) return;
    out.push({ piece, field, canonical: c, reference: r, text: `${PIECE_LABEL[piece]} ${FIELD_LABEL[field]} ${r} in (current quote uses ${c} in)` });
  };
  check("side", "widthIn", canonical.side.widthIn, ref.side.widthIn);
  check("side", "heightIn", canonical.side.heightIn, ref.side.heightIn);
  check("lid", "diameterIn", canonical.lid.diameterIn, ref.lid.diameterIn);
  check("tamper", "widthIn", canonical.tamper.widthIn, ref.tamper.widthIn);
  check("tamper", "heightIn", canonical.tamper.heightIn, ref.tamper.heightIn);
  return out;
}
