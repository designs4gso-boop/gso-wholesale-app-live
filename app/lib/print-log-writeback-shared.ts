// Client-safe constants for the print-log writeback (13A.7B): the Production
// Board COMPONENT references these (summarizeMaterialUsage runs in render),
// so they must not live in the .server module. All computation stays in
// print-log-writeback.server.ts (loader/action-only).

export const PRINT_LOG_USAGE_SOURCE = "print_log";
export const WRITEBACK_PHRASE = "APPLY PRINT LOG ACTUALS"; // exact + case-sensitive (13.2.2 gate standard)
