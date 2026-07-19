// Legacy print-log matcher safety (13A.6E): pure, conservative decisions for
// the print-logs page's import-time matching. Replaces the old three-stage
// first-match-wins helper (exact findFirst -> bare `contains` findFirst ->
// includes() scan over recent jobs). No Prisma, no network.
//
// Rules (same standard as RasterLink/VersaWorks, 13A.6A/6D):
// - exact ticket equality only, shop-scoped, exactly one candidate attaches;
// - zero or two+ candidates stay unresolved (two+ flagged ambiguous);
// - contains/similarity is NEVER an attachment basis — the 13A.6C review page
//   (/app/erp/rip-import-review) shows those as confirm-gated suggestions.

export type PrintLogMatchDecision = {
  productionJobId: string | null;
  ambiguous: boolean;
};

export function decidePrintLogMatch(candidates: Array<{ id: string }>): PrintLogMatchDecision {
  if (candidates.length === 1) return { productionJobId: candidates[0].id, ambiguous: false };
  return { productionJobId: null, ambiguous: candidates.length > 1 };
}

// Every candidate lookup goes through this builder, so the query is always
// shop-scoped and exact — a cross-shop or substring ticket can never resolve.
export function printLogTicketWhere(shop: string, jobTicket: string): { shop: string; jobTicket: string } {
  return { shop, jobTicket };
}

export const PRINT_LOG_REVIEW_PATH = "/app/erp/rip-import-review";

// Message returned by the retired manual matchEntry intent (the form itself is
// replaced by a link). The old action attached with no confirmation, no
// stale-write protection, no audit metadata, and overwrote entry.jobTicket —
// making it safe would duplicate the entire 13A.6C review workflow, so the
// action is disabled instead of forked.
export const MATCH_ENTRY_RETIRED_MESSAGE =
  `Manual matching moved to RIP Import Review (${PRINT_LOG_REVIEW_PATH}) — it adds confirmation, stale-write protection, and a full audit trail. Nothing was changed.`;
