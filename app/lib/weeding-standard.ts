// THE canonical WEEDING labor standard — one object, one place (2026-10-05).
//
// INITIALIZED TO THE EXACT CURRENT BEHAVIOUR. Nothing about today's pricing
// changes: $20/hr at 15 reference pages/hr on a 54 x 54 in reference page,
// pages = ceil(feed length / 54) PER PHYSICAL RUN, then summed. Previously the
// same numbers were hard-coded in finishing-cost.server.ts and restated in
// owner-standards.ts; both now read from here, so a future owner-measured
// calibration is ONE change.
//
// The owner is timing real weeding work (2026-10-05). When that data arrives,
// use weeding-benchmark.ts to derive candidate values, review them, and then
// update THIS object (version, effectiveFrom, source, notes). Do not edit the
// numbers anywhere else. Client-safe: pure data.

export const WEEDING_STANDARD_VERSION = "weeding-standard/1.0.0-2026-10-05";

export type WeedingStandard = {
  basis: "reference_page_per_physical_run";
  laborRatePerHour: number;
  pagesPerHour: number;
  /** Derived: laborRatePerHour / pagesPerHour. */
  costPerPage: number;
  /** The reference page: feed-length inches per page on full-width media. */
  pageLengthIn: number;
  /** Nominal page width (the loaded media width the page is defined against). */
  pageWidthIn: number;
  /** How pages are counted. */
  rounding: "ceil_per_physical_run_then_sum";
  appliesTo: string;
  source: string;
  status: "owner_verified" | "provisional" | "measured";
  effectiveFrom: string;
  version: string;
  notes: string[];
};

export const WEEDING_STANDARD: WeedingStandard = {
  basis: "reference_page_per_physical_run",
  laborRatePerHour: 20,
  pagesPerHour: 15,
  costPerPage: 20 / 15,
  pageLengthIn: 54,
  pageWidthIn: 54,
  rounding: "ceil_per_physical_run_then_sum",
  appliesTo: "every physical printed run off either printer for stickers/labels, sticker bags, stock bags and jar labels (banners: not weeded)",
  source: "OWNER_STANDARDS.weedingPerPage54x54 — $20/hour at 15 pages/hour (owner_verified, pre-2026-10-05); finishing-cost.server.ts 17D.4A",
  status: "owner_verified",
  effectiveFrom: "2026-08-19",
  version: WEEDING_STANDARD_VERSION,
  notes: [
    "A 'page' is 54 in of feed length on the loaded roll, i.e. a 54 x 54 in reference page; it is NOT a count of labels.",
    "The same page basis applies to square/rectangle, contour and specialty jobs — no complexity multiplier exists today (audit: docs/GSO_WEEDING_COST_AUDIT.md).",
    "Cutting is costed separately (machine recovery + operator attention); application is costed separately; setup is never charged in weeding.",
    "PENDING: owner timing measurements (2026-10-05). The rate below is unchanged until the owner approves a new standard.",
  ],
};

/** Convenience accessors used by the finishing engine and legacy standards. */
export const WEEDING_LABOR_RATE_PER_HOUR = WEEDING_STANDARD.laborRatePerHour;
export const WEEDING_PAGES_PER_HOUR = WEEDING_STANDARD.pagesPerHour;
export const WEEDING_COST_PER_REFERENCE_PAGE = WEEDING_STANDARD.costPerPage;
export const WEEDING_REFERENCE_PAGE_IN = WEEDING_STANDARD.pageLengthIn;
