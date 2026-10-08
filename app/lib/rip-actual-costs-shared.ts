// Client-safe constants for the Actual Cost Dashboard (13A.5): imported by
// the route COMPONENT, so they must not live in a .server module. The math
// helpers stay in rip-actual-costs.server.ts (loader-only).

// Machine hourly rate. The NUMBER lives in exactly one place — the
// owner-standards registry ($5/hr, OWNER APPROVED 2026-10-07; previously the
// $8/hr provisional 13A.7B figure). This constant is a binding, not a second
// definition; the server accessor machineRatePerHour() in
// rip-actual-costs.server.ts remains the ONE env-aware runtime authority for
// actuals/writeback (GSO_MACHINE_RATE_PER_HOUR override preserved). The
// erpAdminSetting `defaultMachineRecoveryHr` is reference-only and can never
// reprice anything. LOW is the historical seeded-preset value kept for the
// audit dashboard's range display (it now equals the approved rate).
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
