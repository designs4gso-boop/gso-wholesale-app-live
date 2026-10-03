// Patch 2D-4C2A (17D.7D) — THE GSO LABEL CUTLINE RULE.
//
// OWNER STANDARD: every GSO label — applied or not, on jars, sticker bags,
// stock bags or standalone — has its cutline created from the full artwork /
// artboard with a -0.0625in INWARD OFFSET PATH. It is a deterministic
// production setup, not a per-job measurement.
//
// For a rectangle the offset applies to BOTH edges of each axis:
//
//   cutWidth  = artboardWidth  - 2 x 0.0625 = W - 0.125
//   cutHeight = artboardHeight - 2 x 0.0625 = H - 0.125
//
//   3.000 x 3.000  ->  2.875 x 2.875
//   4.000 x 5.000  ->  3.875 x 4.875
//
// THIS MODULE IS THE ONLY PLACE THE OFFSET NUMBER LIVES. Adapters, the
// calculator route and the calibration reference all derive from it, so a
// second hardcoded cutline cannot drift away from the standard. It supersedes
// the earlier hand-recorded values (3.00 -> 2.85, 4x5 -> 3.79 x 4.81) that
// were being treated as measured canonical cutlines.
//
// Deliberately dependency-free and client-safe: the calculator form renders
// the derived cutline in the browser, and the server adapters cost from the
// same function, so the two can never disagree.
//
// FAILS CLOSED. Missing, non-finite or too-small artwork returns null. A
// cutline is never zero, never negative, and never invented from nothing.

export const GSO_CUTLINE_RULE_VERSION = "17D.7D-gso-cutline";

/** Inward offset applied to the artwork outline, in inches. */
export const GSO_CUTLINE_OFFSET_IN = 0.0625;

/** Total reduction per axis — the offset applies to both opposing edges. */
export const GSO_CUTLINE_INSET_PER_AXIS_IN = GSO_CUTLINE_OFFSET_IN * 2; // 0.125

export const GSO_CUTLINE_BASIS =
  "GSO production standard: cutline = full artwork/artboard with a -0.0625in inward offset path (-0.125in per axis).";

/** Smallest cut dimension worth treating as real, in inches. */
export const GSO_MIN_CUT_DIMENSION_IN = 0.01;

export type GsoCutline = {
  cutWidthIn: number;
  cutHeightIn: number;
  offsetIn: number;
  basis: string;
};

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive the canonical cutline for a RECTANGULAR label from its artboard.
 *
 * Returns null — never a guess — when the artwork is missing or when the
 * offset would leave nothing to cut (artwork at or below 0.125in per axis).
 * A caller that gets null must block, exactly as it would for an absent
 * measurement.
 */
export function deriveGsoLabelCutlineFromArtboard(
  artboardWidthIn: unknown,
  artboardHeightIn: unknown,
): GsoCutline | null {
  const width = positive(artboardWidthIn);
  const height = positive(artboardHeightIn);
  if (width == null || height == null) return null;

  const cutWidthIn = width - GSO_CUTLINE_INSET_PER_AXIS_IN;
  const cutHeightIn = height - GSO_CUTLINE_INSET_PER_AXIS_IN;
  if (cutWidthIn < GSO_MIN_CUT_DIMENSION_IN || cutHeightIn < GSO_MIN_CUT_DIMENSION_IN) return null;

  return { cutWidthIn, cutHeightIn, offsetIn: GSO_CUTLINE_OFFSET_IN, basis: GSO_CUTLINE_BASIS };
}

/**
 * The same rule for a CIRCULAR label (a jar lid): the offset reduces the
 * diameter by 0.125in in total, one offset on each side.
 */
export function deriveGsoLabelCutDiameter(artboardDiameterIn: unknown): number | null {
  const diameter = positive(artboardDiameterIn);
  if (diameter == null) return null;
  const cutDiameterIn = diameter - GSO_CUTLINE_INSET_PER_AXIS_IN;
  return cutDiameterIn >= GSO_MIN_CUT_DIMENSION_IN ? cutDiameterIn : null;
}

/** Rectangular cut PERIMETER straight from an artboard. null when invalid. */
export function gsoCutPerimeterFromArtboard(
  artboardWidthIn: unknown,
  artboardHeightIn: unknown,
): number | null {
  const cutline = deriveGsoLabelCutlineFromArtboard(artboardWidthIn, artboardHeightIn);
  return cutline ? 2 * (cutline.cutWidthIn + cutline.cutHeightIn) : null;
}

/** Display helper: "2.875 x 2.875 in". */
export function formatGsoCutline(cutline: GsoCutline | null, digits = 3): string {
  return cutline ? `${cutline.cutWidthIn.toFixed(digits)} x ${cutline.cutHeightIn.toFixed(digits)} in` : "—";
}
