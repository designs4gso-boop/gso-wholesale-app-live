// OWNER DECISION 2026-11-14 — who may run which production-job action.
//
// The Production action used to accept these intents from ANY signed-in
// Shopify staff account (including Sales and accounts with no ERP role). For
// employee rollout the server now refuses them unless the caller's ERP role is
// listed here. This only RESTRICTS: it grants nothing that staff-roles or the
// owner / financial checks refuse, and it changes no calculation — a refused
// request returns 403 before any read or write.
//
// The same table drives what the Simple Mode job page SHOWS, so the screen and
// the server always agree. The server check is the authority; hiding a control
// is a convenience.
//
// Pure, client-safe, no Prisma.

export const PRODUCTION_FLOOR_ROLES = ["owner", "manager", "print_operator", "bagger"] as const;
const LEADS = ["owner", "manager", "print_operator"] as const;

/**
 * Intents that need a listed role.
 *
 * SERVER HARDENING 2026-11-14: an intent NOT listed here is no longer open to
 * every signed-in account — it needs a production floor role (fail closed).
 * Sales and unassigned accounts therefore hold no production-job action at
 * all, except the one Sales entry below (createFromQuote).
 */
export const PRODUCTION_INTENT_ROLES: Record<string, readonly string[]> = {
  // moving a job between stages (includes Complete job and Cancel; the QC / shipment guards are unchanged)
  changeStatus: PRODUCTION_FLOOR_ROLES,
  toggleChecklist: PRODUCTION_FLOOR_ROLES,
  addNote: PRODUCTION_FLOOR_ROLES,
  addFile: PRODUCTION_FLOOR_ROLES,
  markPrinted: PRODUCTION_FLOOR_ROLES,
  // artwork / customer proof (prepress work — same roles as an artwork revision)
  createProofPortal: LEADS,
  markProofSent: LEADS,
  saveProof: LEADS,
  approveProof: LEADS,
  setFileRole: LEADS,
  // calendar scheduling = the same fields as updateJob
  updateSchedule: ["owner", "manager"],
  quickDueDate: ["owner", "manager"],
  backfillTickets: ["owner", "manager"],
  // an accepted quote becomes a production job: the one production action Sales keeps
  createFromQuote: ["owner", "manager", "sales"],
  // recording / correcting production material use (incl. "Deduct from material stock" and its stock restore)
  addMaterialUsage: PRODUCTION_FLOOR_ROLES,
  deleteMaterialUsage: PRODUCTION_FLOOR_ROLES,
  // manual / walk-in production job (Sales creates work through the quote / order flow)
  createManualJob: LEADS,
  // scheduling: due date, priority, assigned to
  updateJob: ["owner", "manager"],
  // production corrections
  revisionItem: LEADS,
  reopenReprint: ["owner", "manager"],
  // print-intake job -> its real order / job
  linkJobToTarget: LEADS,
  // removing a wrongly attached production file
  deleteFile: LEADS,
  // 2026-11-15 (default DENY): the actions below used to pass through the "any
  // floor role" fallback. They are now listed, so the fallback can deny. Each
  // keeps its own stricter check in the route (recordQc / recordReprint /
  // recordShipment permissions; owner / authorized-manager cost controls).
  qcItem: PRODUCTION_FLOOR_ROLES,
  reprintItem: LEADS, // same three roles that hold recordReprint
  recordShipment: PRODUCTION_FLOOR_ROLES,
  recordPickup: PRODUCTION_FLOOR_ROLES,
  // 2026-11-19: packed and waiting (ready to ship / ready for pickup) — a floor step, QC PASS required
  markFulfillmentReady: PRODUCTION_FLOOR_ROLES,
  saveFinalCosts: ["owner", "manager"],
  reopenJobCost: ["owner", "manager"],
  pullPrintLogActuals: ["owner", "manager"],
  adjustInventory: ["owner", "manager"],
  // 2026-11-19 admin / workflow lane: reviewing a staged business transaction
  // (QuickBooks invoice / estimate, agent proposal) and releasing it to
  // production. Production roles receive the resulting job; they do not review
  // or release accounting transactions.
  reviewStagedTransaction: ["owner", "manager"],
  releaseStagedTransaction: ["owner", "manager"],
  dismissStagedTransaction: ["owner", "manager"],
};

/**
 * 2026-11-19 — named capability groups (ROLES, never people). Two lanes work on
 * the SAME jobs, items, tickets and files:
 *   ADMIN_WORKFLOW        staged transactions, release to production, due dates,
 *                         priorities, assignments, holds, reorder approval.
 *   PRODUCTION_EXECUTION  file prep, incoming print files, routing, reprints,
 *                         revisions, manual jobs.
 *   PRODUCTION_SHARED     the board, job / item status, notes, QC, completion,
 *                         shipment / pickup — every production floor role.
 *   COMMERCIAL            quotes and reorders (a reorder is a new sale).
 * An owner / admin who also supports production holds every group; a
 * production lead holds the production groups and no admin / accounting group.
 * These groups DESCRIBE the tables above and in staff-roles.server.ts — the
 * per-action tables stay the authority.
 */
export const CAPABILITY_GROUPS = {
  ADMIN_WORKFLOW: ["owner", "manager"],
  PRODUCTION_EXECUTION: LEADS,
  PRODUCTION_SHARED: PRODUCTION_FLOOR_ROLES,
  COMMERCIAL: ["owner", "manager", "sales"],
} as const satisfies Record<string, readonly string[]>;
export type CapabilityGroup = keyof typeof CAPABILITY_GROUPS;

export function roleHasCapabilityGroup(role: unknown, group: CapabilityGroup): boolean {
  return (CAPABILITY_GROUPS[group] as readonly string[]).includes(norm(role));
}

/** The work contexts a role is offered (display): the admin / workflow view, the production view, or both. */
export function workspacesForRole(role: unknown): Array<"admin" | "production"> {
  return [
    ...(roleHasCapabilityGroup(role, "ADMIN_WORKFLOW") ? (["admin"] as const) : []),
    ...(roleHasCapabilityGroup(role, "PRODUCTION_SHARED") ? (["production"] as const) : []),
  ];
}

/** An action that is not listed above is refused for EVERY role until it is reviewed and added. */
const UNLISTED_INTENT_ROLES: readonly string[] = [];

export const PRODUCTION_ROLE_DENIED = "Your role can't do this on a production job.";

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** May this role open production job pages (board, job page, work order, proof page, calendar)? */
export function roleMayViewProduction(role: unknown): boolean {
  return (PRODUCTION_FLOOR_ROLES as readonly string[]).includes(norm(role));
}

/**
 * Server + screen rule. DEFAULT DENY (owner rule 2026-11-15): an intent this
 * table does not list is refused for every role, so a newly added action
 * cannot run for anyone until it has been reviewed and given a role list.
 */
export function roleMayRunProductionIntent(role: unknown, intent: unknown): boolean {
  const allowed = Object.prototype.hasOwnProperty.call(PRODUCTION_INTENT_ROLES, String(intent ?? "")) ? PRODUCTION_INTENT_ROLES[String(intent ?? "")] : UNLISTED_INTENT_ROLES;
  return allowed.includes(norm(role));
}

/** Where a role that may not view production is sent. */
export const PRODUCTION_VIEW_DENIED_REDIRECT = "/app";

/**
 * DISPLAY ONLY — which roles are shown controls whose server rule lives in
 * staff-roles.server.ts (unchanged): reprint needs recordReprint, QC needs
 * recordQc, shipment / pickup need recordShipment.
 */
export const DISPLAY_ROLES: Record<string, readonly string[]> = {
  reprintItem: LEADS,
  qcItem: PRODUCTION_FLOOR_ROLES,
  recordShipment: PRODUCTION_FLOOR_ROLES,
  recordPickup: PRODUCTION_FLOOR_ROLES,
};

/** Should the Simple Mode job page show this control to this role? */
export function showsProductionControl(role: unknown, intent: string): boolean {
  if (Object.prototype.hasOwnProperty.call(PRODUCTION_INTENT_ROLES, intent)) return roleMayRunProductionIntent(role, intent);
  const display = DISPLAY_ROLES[intent];
  return display ? display.includes(norm(role)) : roleMayViewProduction(role);
}

/**
 * The full Production page (/app/erp/production) is the Advanced view: actual
 * costs, cost finalization, print-log actuals, stock adjustments, diagnostics.
 * It is for the owner and financially authorized managers. Everyone else is
 * sent to Simple Mode — production roles to the board, others to Home.
 */
export function advancedProductionRedirect(role: unknown, canViewFinancials: boolean): string | null {
  if (canViewFinancials) return null;
  return (PRODUCTION_FLOOR_ROLES as readonly string[]).includes(norm(role)) ? "/app/erp/production-board" : "/app";
}
