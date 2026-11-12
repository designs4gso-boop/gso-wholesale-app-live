// 2026-10-19 owner decision: OWNER-ONLY actions (Owner Set Price & Approve).
//
// This embedded app has no staff-role table, and its Shopify sessions are
// OFFLINE (they carry no person). The only server-verified identity of the
// person clicking is the App Bridge session token: `sessionToken.sub` is the
// Shopify staff user ID, signed by Shopify and verified by authenticate.admin.
//
// Owner = that user ID is listed in GSO_OWNER_SHOPIFY_USER_IDS (comma list),
// or an ONLINE session marks the user as the store's account owner.
// Fail closed: with no configuration nobody is the owner. Never a posted field.
//
// 2026-11-11 TEMPORARY OWNER ACCESS (explicit, never implied). Until James's
// and Raquel's staff user IDs are verified, the owner can set
//   GSO_OWNER_ENFORCEMENT=temporary_all_staff
// on Render: every Shopify-AUTHENTICATED admin of the shop is then treated as
// owner, and every reason says so. Shopify authentication still runs first in
// every caller; this never makes the ERP public. Unset (or any other value) =
// ENFORCED, exactly as before. Every reason shows the viewer's own staff user
// ID so the real IDs can be collected for GSO_OWNER_SHOPIFY_USER_IDS.

import { COST_PRICING_OWNER_ONLY_MESSAGE } from "./calculator-owner-view";

export type OwnerAuthorization = {
  isOwner: boolean;
  /** Shopify staff user ID from the verified session token (null when absent). */
  userId: string | null;
  /** Audit identity for "approved by". */
  actor: string;
  /** Why the user is / is not the owner (owner-visible wording). */
  reason: string;
  /** "enforced" = configured IDs decide; "temporary_all_staff" = the explicit temporary switch is on. */
  enforcement?: OwnerEnforcementMode;
};

export const OWNER_USER_IDS_ENV = "GSO_OWNER_SHOPIFY_USER_IDS";
export const OWNER_ENFORCEMENT_ENV = "GSO_OWNER_ENFORCEMENT";
export const OWNER_ENFORCEMENT_TEMPORARY = "temporary_all_staff";
export type OwnerEnforcementMode = "enforced" | typeof OWNER_ENFORCEMENT_TEMPORARY;

/** Only the exact value "temporary_all_staff" relaxes enforcement; anything else is enforced. */
export function ownerEnforcementMode(env: Record<string, string | undefined> = process.env): OwnerEnforcementMode {
  return String(env[OWNER_ENFORCEMENT_ENV] || "").trim().toLowerCase() === OWNER_ENFORCEMENT_TEMPORARY ? OWNER_ENFORCEMENT_TEMPORARY : "enforced";
}

export function configuredOwnerUserIds(env: Record<string, string | undefined> = process.env): string[] {
  return String(env[OWNER_USER_IDS_ENV] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function resolveOwnerAuthorization(
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): OwnerAuthorization {
  const session = auth?.session || null;
  const tokenSub = auth?.sessionToken?.sub;
  const onlineUserId = session?.isOnline ? session?.userId ?? session?.onlineAccessInfo?.associated_user?.id : null;
  const userId = tokenSub != null && String(tokenSub).trim() ? String(tokenSub).trim() : onlineUserId != null ? String(onlineUserId) : null;
  const shop = String(session?.shop || "");
  const named = String(session?.email || [session?.firstName, session?.lastName].filter(Boolean).join(" ") || "").trim();
  const actor = named || (userId ? `shopify-user:${userId}` : `shop-admin:${shop} (unidentified)`);
  const yourId = userId ? ` Your Shopify staff user ID is ${userId}.` : "";
  const enforcement = ownerEnforcementMode(env);
  const result = (isOwner: boolean, reason: string): OwnerAuthorization => ({ isOwner, userId, actor, reason, enforcement });

  if (session?.isOnline && session?.accountOwner === true) {
    return result(true, "Shopify account owner (online session).");
  }
  const ownerIds = configuredOwnerUserIds(env);
  if (userId && ownerIds.includes(userId)) {
    return result(true, `Configured owner (verified Shopify staff user ID).${yourId}`);
  }
  if (enforcement === OWNER_ENFORCEMENT_TEMPORARY) {
    // Explicit temporary switch: any Shopify-authenticated admin of this shop.
    return result(true, `TEMPORARY OWNER ACCESS: ${OWNER_ENFORCEMENT_ENV}=${OWNER_ENFORCEMENT_TEMPORARY} gives every authenticated staff member owner access until ${OWNER_USER_IDS_ENV} is verified.${yourId}`);
  }
  if (!ownerIds.length) {
    return result(false, `Owner-only action: no owner is configured (${OWNER_USER_IDS_ENV} is empty) — denied by default.${yourId}`);
  }
  if (!userId) {
    return result(false, "Owner-only action: this request carries no verified Shopify staff identity.");
  }
  return result(false, `Owner-only action: you are not the configured owner.${yourId}`);
}

/** Managers the owner explicitly authorizes for internal financials (staff-roles.server.ts). */
export const MANAGER_AUTHORIZED_USER_IDS_ENV = "GSO_MANAGER_AUTHORIZED_USER_IDS";
export const STAFF_ROLES_ASSIGNMENT_ENV = "GSO_STAFF_ROLES";
export const FINANCIAL_ACCESS_DENIED_MESSAGE = "Internal financials (true cost, profit, margin, internal floors, material / ink cost) are limited to the owner and authorized managers.";

/**
 * 2026-11-11 owner decision: internal financials are visible to OWNERS and to
 * MANAGERS the owner explicitly authorizes (role manager in GSO_STAFF_ROLES AND
 * listed in GSO_MANAGER_AUTHORIZED_USER_IDS). Everyone else is denied — fails
 * closed, including when no owner is configured.
 */
export function financialAccess(
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { allowed: boolean; reason: string; owner: OwnerAuthorization } {
  const owner = resolveOwnerAuthorization(auth, env);
  if (owner.isOwner) return { allowed: true, reason: owner.reason, owner };
  const id = owner.userId;
  const ids = (key: string) => String(env[key] || "").split(",").map((part) => part.trim()).filter(Boolean);
  const isManager = Boolean(id) && ids(STAFF_ROLES_ASSIGNMENT_ENV).some((entry) => entry.split(":").map((part) => part.trim().toLowerCase()).join(":") === `${id}:manager`);
  if (isManager && ids(MANAGER_AUTHORIZED_USER_IDS_ENV).includes(id!)) {
    return { allowed: true, reason: `Authorized manager (verified Shopify staff user ID ${id}).`, owner };
  }
  return { allowed: false, reason: `${FINANCIAL_ACCESS_DENIED_MESSAGE} ${owner.reason}`, owner };
}

/** Loader / action guard for internal-financial pages: 403 unless owner or authorized manager. */
export function requireFinancialAccess(
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): OwnerAuthorization {
  const access = financialAccess(auth, env);
  if (!access.allowed) throw ownerOnlyForbiddenResponse(access.owner, FINANCIAL_ACCESS_DENIED_MESSAGE);
  return access.owner;
}

/**
 * 2026-11-11 owner decision: PRODUCTION staff do not see revenue, true cost,
 * profit, margin or owner cost controls. Visible to owners and authorized
 * managers only (financialAccess). Fails closed: with no owner configured,
 * nobody but the account owner / temporary switch sees them.
 */
export function productionFinancialVisibility(
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { show: boolean; reason: string; owner: OwnerAuthorization } {
  const access = financialAccess(auth, env);
  return access.allowed
    ? { show: true, reason: access.reason, owner: access.owner }
    : { show: false, reason: "Financial figures are limited to the owner and authorized managers.", owner: access.owner };
}

/* 2026-10-19 owner decision: the ENTIRE Cost & Pricing Calculator is owner
 * only. Loader and action both refuse a non-owner with 403 before any cost,
 * price, margin or diagnostic is computed; the route's error boundary renders
 * a plain "owner only" notice (no internal data in the body). */
export { COST_PRICING_OWNER_ONLY_MESSAGE };

export function ownerOnlyForbiddenResponse(owner: OwnerAuthorization, message = COST_PRICING_OWNER_ONLY_MESSAGE): Response {
  return new Response(`${message} ${owner.reason}`.trim(), { status: 403, statusText: "Forbidden", headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Loader / action guard: throws the 403 Response for a non-owner, returns the owner otherwise. */
export function requireOwner(auth: { session?: any; sessionToken?: any } | null | undefined, env: Record<string, string | undefined> = process.env, message?: string): OwnerAuthorization {
  const owner = resolveOwnerAuthorization(auth, env);
  if (!owner.isOwner) throw ownerOnlyForbiddenResponse(owner, message);
  return owner;
}
