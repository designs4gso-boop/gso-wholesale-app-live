// Client-safe constants for the Actual Cost Dashboard (13A.5): imported by
// the route COMPONENT, so they must not live in a .server module. The math
// helpers stay in rip-actual-costs.server.ts (loader-only).

// Owner has not picked the machine hourly rate yet ($5 seeded vs $8
// calculator default) — the dashboard shows BOTH until that decision.
export const MACHINE_RATE_LOW = 5;
export const MACHINE_RATE_HIGH = 8;

export type MatchStatus = "matched" | "potentially_matchable" | "quote_rip" | "missing_ticket";

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  matched: "Matched to production job",
  potentially_matchable: "Potentially matchable (GSO ticket, no job link)",
  quote_rip: "Quote-time GSOQ result",
  missing_ticket: "Missing/unknown ticket",
};
