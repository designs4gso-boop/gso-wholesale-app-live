// Patch 2D-4 (17D.7) — ONE authority for the Cost Calculator's own fee
// literals. Client-safe: pure data, no server imports, so the route's
// component tree can render the same number the loader and action charge.
//
// This file changes NO amount. It exists because the specialty file-prep fee
// was typed as a bare `25` in two independent places (the loader's tier map
// and the action's save map) plus a third time in the UI option label, so the
// three could drift apart silently. Now they cannot.

/**
 * Specialty file prep — the customer charge when GSO builds the gloss/white
 * mask rather than the customer supplying it.
 *
 * PER JOB. It is a setup-type operation and is deliberately NOT multiplied by
 * quantity anywhere: the loader and action both add it once to the job total
 * and divide only for per-unit DISPLAY.
 */
export const SPECIALTY_FILE_PREP_FEE = 25;

export const SPECIALTY_FILE_PREP_BASIS = "PER_JOB" as const;

export const SPECIALTY_FILE_PREP_LABEL = `GSO builds the specialty mask — $${SPECIALTY_FILE_PREP_FEE}/job customer charge`;

/**
 * The fee applies only when the operator asked GSO to build the mask AND the
 * job actually has a specialty layer to build one for.
 */
export function specialtyFilePrepFee(input: {
  requested: boolean;
  glossLayers: number;
  whiteLayers: number;
}): number {
  if (!input.requested) return 0;
  const hasSpecialty = (Number(input.glossLayers) || 0) > 0 || (Number(input.whiteLayers) || 0) > 0;
  return hasSpecialty ? SPECIALTY_FILE_PREP_FEE : 0;
}
