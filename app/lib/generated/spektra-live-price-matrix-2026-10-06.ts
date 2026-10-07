// GENERATED ARTIFACT — do not edit by hand.
// Source CSV: docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv
// Generator:  tools/generate-spektra-cost-book.mjs
//
// STATUS AT GENERATION (2026-10-06): the source CSV was NOT PRESENT in the
// repository or on the working machine (searched docs/vendor-research/, all
// branches, stash, Downloads/Desktop/Documents). No observed vendor price was
// loaded. Every lookup therefore fails closed to REQUEST_CURRENT_VENDOR_QUOTE
// until the owner commits the research files and re-runs the generator:
//
//   node tools/generate-spektra-cost-book.mjs
//
// NOTHING in this file is an invented price.

export const SPEKTRA_MATRIX_GENERATED_AT = "2026-10-06";
export const SPEKTRA_MATRIX_SOURCE_FILE = "docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv";
export const SPEKTRA_MATRIX_SOURCE_PRESENT = false;
export const SPEKTRA_MATRIX_ROW_COUNT = 0;

/** One directly observed public-calculator price. */
export type SpektraObservedRow = {
  size: string; // "4x5x2"
  material: string; // "White PET" | "Silver PET" | "Hologram" | "Clear PET"
  finish: string; // "Soft Touch" | "Matte" | "Glossy"
  spot: string; // "None" | "Standard" | "Raised UV"
  zipper: string; // "None" | "10 mm" | "Child Resistant"
  topFeature: string; // "No Tear Notch" | "Punch Hole" | "Sombrero"
  clearGusset: boolean;
  quantity: number;
  skuCount: number;
  /** EXACT public order total as displayed by the calculator (before the GSO discount). */
  publicTotal: number;
  /** Rounded public unit price as displayed (informational; never discounted directly). */
  publicUnitDisplayed: number | null;
  observedAt: string; // ISO date
  note: string | null;
};

export const SPEKTRA_OBSERVED_ROWS: SpektraObservedRow[] = [];
