// Client-safe constants for the Actual Cost Dashboard (13A.5): imported by
// the route COMPONENT, so they must not live in a .server module. The math
// helpers stay in rip-actual-costs.server.ts (loader-only).

// Machine hourly rate. 15G.2: the NUMBER lives in exactly one place — the
// owner-standards registry ($8/hr, owner decision 13A.7B / 15F.0K.4B). This
// constant is a binding, not a second definition; the server accessor
// machineRatePerHour() in rip-actual-costs.server.ts remains the ONE
// env-aware runtime authority for actuals/writeback. The stale
// erpAdminSetting `defaultMachineRecoveryHr` ($5) is reference-only and can
// never reprice anything. LOW remains only for the audit dashboard's
// historical range display.
import { OWNER_STANDARDS } from "./owner-standards";

export const MACHINE_RATE_LOW = 5;
export const MACHINE_RATE_HIGH = OWNER_STANDARDS.machineRecoveryPerHour.value;
export const MACHINE_RATE_CURRENT = OWNER_STANDARDS.machineRecoveryPerHour.value;

export type MatchStatus = "matched" | "potentially_matchable" | "quote_rip" | "missing_ticket";

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  matched: "Matched to production job",
  potentially_matchable: "Potentially matchable (GSO ticket, no job link)",
  quote_rip: "Quote-time GSOQ result",
  missing_ticket: "Missing/unknown ticket",
};
