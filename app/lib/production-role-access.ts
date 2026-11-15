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
};

export const PRODUCTION_ROLE_DENIED = "Your role can't do this on a production job.";

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** May this role open production job pages (board, job page, work order, proof page, calendar)? */
export function roleMayViewProduction(role: unknown): boolean {
  return (PRODUCTION_FLOOR_ROLES as readonly string[]).includes(norm(role));
}

/**
 * Server + screen rule. An intent this table does not cover (QC, reprint,
 * shipment, pickup, the owner cost controls — each with its own stricter
 * check) still needs a production floor role, so nothing is open to an
 * account merely because it is signed in.
 */
export function roleMayRunProductionIntent(role: unknown, intent: unknown): boolean {
  const allowed = Object.prototype.hasOwnProperty.call(PRODUCTION_INTENT_ROLES, String(intent ?? "")) ? PRODUCTION_INTENT_ROLES[String(intent ?? "")] : PRODUCTION_FLOOR_ROLES;
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
