// Client-safe constants for the Actual Cost Dashboard (13A.5): imported by
// the route COMPONENT, so they must not live in a .server module. The math
// helpers stay in rip-actual-costs.server.ts (loader-only).

// Machine hourly rate. Owner decision (13A.7B): $8/hour is the CURRENT rate
// for previews and print-log writeback. It lives here as the ONE shared
// source (never scattered as inline constants); the server accessor
// machineRatePerHour() in rip-actual-costs.server.ts adds an env override
// (GSO_MACHINE_RATE_PER_HOUR) so it stays configurable without code edits.
// LOW/HIGH remain for the audit dashboard's historical range display.
export const MACHINE_RATE_LOW = 5;
export const MACHINE_RATE_HIGH = 8;
export const MACHINE_RATE_CURRENT = 8;

export type MatchStatus = "matched" | "potentially_matchable" | "quote_rip" | "missing_ticket";

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  matched: "Matched to production job",
  potentially_matchable: "Potentially matchable (GSO ticket, no job link)",
  quote_rip: "Quote-time GSOQ result",
  missing_ticket: "Missing/unknown ticket",
};
