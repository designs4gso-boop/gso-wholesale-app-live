// 2026-11-19 — server enforcement of the route access table (route-access.ts).
// Identity is the verified Shopify staff user id only; never a posted field.

import { financialAccess } from "./owner-authorization.server";
import { ROUTE_ACCESS, ROUTE_ACCESS_DENIED, viewerMeetsRouteLevel, type RouteAccessLevel } from "./route-access";
import { resolveStaffAccess, type StaffAccess } from "./staff-roles.server";

type Auth = { session?: any; sessionToken?: any } | null | undefined;
type Env = Record<string, string | undefined>;

export type RouteAccessDecision = { allowed: boolean; level: RouteAccessLevel | undefined; staff: StaffAccess; canViewFinancials: boolean; message: string };

export function routeAccessDecision(auth: Auth, routeKey: string, env: Env = process.env): RouteAccessDecision {
  const staff = resolveStaffAccess(auth, env);
  const canViewFinancials = financialAccess(auth, env).allowed;
  const level = ROUTE_ACCESS[routeKey];
  const allowed = viewerMeetsRouteLevel(level, { role: staff.role, canViewFinancials });
  const message = allowed ? "" : `${level ? ROUTE_ACCESS_DENIED[level] : "This page is not available."} ${staff.reason}`.trim();
  return { allowed, level, staff, canViewFinancials, message };
}

export function routeAccessDeniedResponse(decision: RouteAccessDecision): Response {
  return new Response(decision.message, { status: 403, statusText: "Forbidden", headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Loader / action guard: throws 403 before anything is read or written; returns the staff access otherwise. */
export function requireRouteAccess(auth: Auth, routeKey: string, env: Env = process.env): StaffAccess {
  const decision = routeAccessDecision(auth, routeKey, env);
  if (!decision.allowed) throw routeAccessDeniedResponse(decision);
  return decision.staff;
}
