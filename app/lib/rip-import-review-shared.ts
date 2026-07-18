// Client-safe constants for the RIP Import Review page (13A.6C): imported by
// the route COMPONENT, so they must not live in a .server module. All logic
// (classification, audit append, candidate ranking, validation) stays in
// rip-import-review.server.ts (loader/action-only).

export type ReviewStatus = "unmatched" | "ambiguous" | "attached";

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  unmatched: "Unmatched",
  ambiguous: "Ambiguous (2+ ticket hits)",
  attached: "Attached",
};

export const STATUS_FILTERS = [
  { value: "unresolved", label: "Unresolved (unmatched + ambiguous)" },
  { value: "unmatched", label: "Unmatched only" },
  { value: "ambiguous", label: "Ambiguous only" },
  { value: "attached", label: "Attached" },
  { value: "all", label: "All" },
];

export const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "rasterlink", label: "RasterLink" },
  { value: "versaworks", label: "VersaWorks" },
  { value: "other", label: "Other / manual" },
];

export const DAYS_FILTERS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
  { value: "all", label: "All time" },
];

export type CandidateConfidence = "exact_ticket" | "rip_job_name" | "name_similarity";

export const CONFIDENCE_LABELS: Record<CandidateConfidence, string> = {
  exact_ticket: "Exact ticket match",
  rip_job_name: "RIP job name similarity (suggestion only)",
  name_similarity: "Job name similarity (suggestion only)",
};

export const PAGE_SIZE = 50;

// Loader fetch bound: filters/classification run in memory over at most this
// many rows per bucket (ambiguity lives inside rawRow JSON, which is not
// SQL-filterable by design — the no-rawRow-query rule from 13A.6A).
export const FETCH_BOUND = 400;
