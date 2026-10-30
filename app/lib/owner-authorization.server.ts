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

import { COST_PRICING_OWNER_ONLY_MESSAGE } from "./calculator-owner-view";

export type OwnerAuthorization = {
  isOwner: boolean;
  /** Shopify staff user ID from the verified session token (null when absent). */
  userId: string | null;
  /** Audit identity for "approved by". */
  actor: string;
  /** Why the user is / is not the owner (owner-visible wording). */
  reason: string;
};

export const OWNER_USER_IDS_ENV = "GSO_OWNER_SHOPIFY_USER_IDS";

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

  if (session?.isOnline && session?.accountOwner === true) {
    return { isOwner: true, userId, actor, reason: "Shopify account owner (online session)." };
  }
  const ownerIds = configuredOwnerUserIds(env);
  if (!ownerIds.length) {
    return { isOwner: false, userId, actor, reason: `Owner-only action: no owner is configured (${OWNER_USER_IDS_ENV} is empty) — denied by default.` };
  }
  if (!userId) {
    return { isOwner: false, userId, actor, reason: "Owner-only action: this request carries no verified Shopify staff identity." };
  }
  if (ownerIds.includes(userId)) {
    return { isOwner: true, userId, actor, reason: "Configured owner (verified Shopify staff user ID)." };
  }
  return { isOwner: false, userId, actor, reason: "Owner-only action: you are not the configured owner." };
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
