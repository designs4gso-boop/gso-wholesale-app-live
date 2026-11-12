// 2026-11-11 OWNER DECISION — staff roles / permissions (minimal secure foundation).
//
// Identity: the ONLY trusted identity is the verified Shopify staff user ID
// (App Bridge session token `sub`, verified by authenticate.admin) — the same
// identity owner-authorization.server.ts already uses. Never a posted field.
//
// Assignment: a server-side environment mapping, no schema change:
//   GSO_STAFF_ROLES="<shopifyUserId>:<role>,<shopifyUserId>:<role>"
//     roles: manager | sales | print_operator | bagger
//   GSO_MANAGER_AUTHORIZED_USER_IDS="<id>,<id>"  managers the owner explicitly
//     authorizes for internal financials, purchasing approval and exception
//     pricing (a manager is NOT automatically an owner).
// Owners come from owner-authorization (GSO_OWNER_SHOPIFY_USER_IDS / online
// account owner / the explicit temporary switch) and hold every permission.
// Anyone else is "unassigned" and gets NO financial and NO production-write
// permission (fails closed). Employees each need their own Shopify staff
// account before they are assigned a role.

import { resolveOwnerAuthorization, type OwnerAuthorization } from "./owner-authorization.server";

export const STAFF_ROLES_ENV = "GSO_STAFF_ROLES";
export const MANAGER_AUTHORIZED_ENV = "GSO_MANAGER_AUTHORIZED_USER_IDS";

export const STAFF_ROLE_VALUES = ["manager", "sales", "print_operator", "bagger"] as const;
export type AssignableStaffRole = (typeof STAFF_ROLE_VALUES)[number];
export type StaffRole = "owner" | AssignableStaffRole | "unassigned";

export type StaffPermission =
  | "viewFinancials" // true cost, profit, margin, internal floors, ink/material cost
  | "ownerOverrides" // owner-only pricing / material / cost overrides
  | "approvePurchasing"
  | "createPurchaseRequest"
  | "approveExceptionPricing" // below-floor / override / exception pricing
  | "sendQuote" // ordinary quotes inside approved pricing authority
  | "selectPrinter" // manual compatible-printer choice
  | "recordQc"
  | "recordReprint"
  | "recordShipment"; // shipment / pickup records

const ALL: StaffPermission[] = ["viewFinancials", "ownerOverrides", "approvePurchasing", "createPurchaseRequest", "approveExceptionPricing", "sendQuote", "selectPrinter", "recordQc", "recordReprint", "recordShipment"];

/** Owner-approved permission matrix. */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly StaffPermission[]> = {
  owner: ALL,
  // Operational management; financial / purchasing / exception authority only when explicitly authorized.
  manager: ["createPurchaseRequest", "sendQuote", "selectPrinter", "recordQc", "recordReprint", "recordShipment"],
  // Customer selling price and quote/order totals only — never internal cost. No discretionary discount.
  sales: ["createPurchaseRequest", "sendQuote"],
  // Operational production; authorized print operators may choose a compatible printer; QC authority.
  print_operator: ["createPurchaseRequest", "selectPrinter", "recordQc", "recordReprint", "recordShipment"],
  // Bagging / packing / QC tasks; no internal financials.
  bagger: ["createPurchaseRequest", "recordQc", "recordShipment"],
  unassigned: [],
};
export const AUTHORIZED_MANAGER_EXTRA: readonly StaffPermission[] = ["viewFinancials", "approvePurchasing", "approveExceptionPricing"];

export type StaffAccess = {
  role: StaffRole;
  userId: string | null;
  actor: string;
  owner: OwnerAuthorization;
  permissions: ReadonlySet<StaffPermission>;
  can: (permission: StaffPermission) => boolean;
  reason: string;
};

const list = (value: string | undefined) => String(value || "").split(",").map((part) => part.trim()).filter(Boolean);

export function configuredStaffRoles(env: Record<string, string | undefined> = process.env): Map<string, AssignableStaffRole> {
  const map = new Map<string, AssignableStaffRole>();
  for (const entry of list(env[STAFF_ROLES_ENV])) {
    const [id, role] = entry.split(":").map((part) => part.trim());
    if (id && /^\d+$/.test(id) && (STAFF_ROLE_VALUES as readonly string[]).includes(String(role).toLowerCase())) map.set(id, String(role).toLowerCase() as AssignableStaffRole);
  }
  return map;
}

export function resolveStaffAccess(
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): StaffAccess {
  const owner = resolveOwnerAuthorization(auth, env);
  let role: StaffRole = "unassigned";
  let reason: string;
  const permissions = new Set<StaffPermission>();
  if (owner.isOwner) {
    role = "owner";
    reason = owner.reason;
  } else {
    const assigned = owner.userId ? configuredStaffRoles(env).get(owner.userId) : undefined;
    if (assigned) {
      role = assigned;
      reason = `Assigned role ${assigned} (verified Shopify staff user ID ${owner.userId}).`;
    } else {
      reason = owner.userId
        ? `No ERP role is assigned to Shopify staff user ID ${owner.userId} (${STAFF_ROLES_ENV}).`
        : "This request carries no verified Shopify staff identity.";
    }
  }
  for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  if (role === "manager" && owner.userId && list(env[MANAGER_AUTHORIZED_ENV]).includes(owner.userId)) {
    for (const permission of AUTHORIZED_MANAGER_EXTRA) permissions.add(permission);
  }
  return { role, userId: owner.userId, actor: owner.actor, owner, permissions, can: (permission) => permissions.has(permission), reason };
}

export const PERMISSION_DENIED_MESSAGE: Record<StaffPermission, string> = {
  viewFinancials: "Internal financials are limited to the owner and authorized managers.",
  ownerOverrides: "Owner-only override.",
  approvePurchasing: "Purchasing approval is limited to the owner and authorized managers.",
  createPurchaseRequest: "Creating purchase requests needs an assigned ERP role.",
  approveExceptionPricing: "Exception / below-floor pricing needs owner or authorized-manager approval.",
  sendQuote: "Sending quotes needs an assigned ERP role.",
  selectPrinter: "Manual printer selection is limited to owners, managers and authorized print operators.",
  recordQc: "QC can be recorded by print operators, baggers, managers and owners.",
  recordReprint: "Reprints can be recorded by print operators, managers and owners.",
  recordShipment: "Shipment / pickup can be recorded by print operators, baggers, managers and owners.",
};

export function permissionDeniedResponse(access: StaffAccess, permission: StaffPermission): Response {
  return Response.json({ ok: false, message: `${PERMISSION_DENIED_MESSAGE[permission]} ${access.reason}`.trim() }, { status: 403 });
}
