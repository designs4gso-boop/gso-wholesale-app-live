// 2026-11-15 — Cost Calculator gloss coverage: ONE normalization rule.
//
// Live QA bug: the form says "blank = 90% pre-art estimate", but a blank field
// reached the canonical calculator as null, and the canonical ink engine then
// applied its own 50% gloss default (machine-calibration resolveCoverage). The
// quote was costed at 50% while the screen said 90%.
//
// Rule (owner, 2026-11-15):
//   gloss layers > 0 and coverage blank / missing  -> 90 (pre-art estimate)
//   gloss layers > 0 and a coverage entered         -> the entered value
//   gloss layers = 0                                -> no gloss channel, no gloss cost
// A blank field never becomes 0 and never falls through to another default.
//
// This is the Cost Calculator's rule only. The canonical engine's own default
// for callers that pass no coverage (storefront pricing) is not changed here.

export const COST_CALCULATOR_GLOSS_ESTIMATE_PCT = 90;

export type GlossCoverageBasis = "estimated" | "entered" | "none";

/** True when the operator left the field empty (absent, empty or whitespace). */
export function glossCoverageIsBlank(raw: unknown): boolean {
  return raw == null || String(raw).trim() === "";
}

/**
 * The gloss coverage the canonical calculator must receive.
 * `entered` is the already-parsed number, or null when the field is blank.
 * An entered value is passed through untouched (an invalid one still blocks
 * downstream exactly as before — it is never replaced by the estimate).
 */
export function effectiveGlossCoveragePct(glossLayers: number, entered: number | null | undefined): number | null {
  if (!(Number(glossLayers) > 0)) return entered ?? null;
  return entered == null ? COST_CALCULATOR_GLOSS_ESTIMATE_PCT : entered;
}

/** What the screen and the saved snapshot say about where the percentage came from. */
export function glossCoverageBasis(glossLayers: number, raw: unknown): { basis: GlossCoverageBasis; pct: number | null; label: string | null } {
  if (!(Number(glossLayers) > 0)) return { basis: "none", pct: null, label: null };
  if (glossCoverageIsBlank(raw)) {
    return { basis: "estimated", pct: COST_CALCULATOR_GLOSS_ESTIMATE_PCT, label: `Estimated: ${COST_CALCULATOR_GLOSS_ESTIMATE_PCT}%` };
  }
  const pct = Number(String(raw).trim());
  return { basis: "entered", pct: Number.isFinite(pct) ? pct : null, label: `Entered: ${String(raw).trim()}%` };
}
