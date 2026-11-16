import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { resolveStaffAccess } from "../lib/staff-roles.server";
import { navForRole } from "../lib/simple-nav";
import { OWNER_ENFORCEMENT_ENV, OWNER_USER_IDS_ENV, configuredOwnerUserIds, resolveOwnerAuthorization } from "../lib/owner-authorization.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const owner = resolveOwnerAuthorization(auth);
  // SIMPLE MODE (2026-11-14): the role only chooses which nav areas are SHOWN.
  const staff = resolveStaffAccess(auth);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // 2026-10-19: owner-only nav entries are hidden for staff (the routes themselves refuse non-owners server-side).
    isOwner: owner.isOwner,
    role: staff.role,
    viewFinancials: staff.can("viewFinancials"),
    // 2026-11-11 OWNER ACCESS DIAGNOSTIC: shown only while owner access is not
    // yet permanent — the temporary switch is on, or no owner IDs are set. It
    // names the mode and the viewer's OWN verified Shopify staff user ID (the
    // value GSO_OWNER_SHOPIFY_USER_IDS needs). Gone once enforcement is final.
    ownerAccessNotice: owner.enforcement === "temporary_all_staff" || !configuredOwnerUserIds().length
      // 2026-11-15: the server setting names are sent to a verified owner only (not merely hidden on screen).
      ? { temporary: owner.enforcement === "temporary_all_staff", userId: owner.userId, idsEnv: owner.isOwner ? OWNER_USER_IDS_ENV : null, switchEnv: owner.isOwner ? OWNER_ENFORCEMENT_ENV : null }
      : null,
  };
};

export default function App() {
  const { apiKey, role, viewFinancials, ownerAccessNotice, isOwner } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* SIMPLE MODE nav (2026-11-14). The embedded admin nav is a flat list, so
          it carries at most six areas — Home, Sales, Production, Inventory,
          Purchasing, Admin — chosen by ROLE (app/lib/simple-nav.ts). Each
          area's pages are listed on Home ("Your areas"); everything else stays
          under Home -> "Advanced & owner tools" (/app#advanced). Display only:
          every route still enforces its own permissions server-side. */}
      <s-app-nav>
        {navForRole(role, { viewFinancials }).map((section) => (
          <s-link key={section.key} href={section.href}>{section.label}</s-link>
        ))}
      </s-app-nav>

      {/* 2026-11-15: the setup detail (which server setting to change) is for a verified owner only. Anyone else
          gets one plain line plus their own staff ID — the number the owner needs from them. */}
      {ownerAccessNotice && !isOwner ? (
        <div style={{ margin: "8px 16px 0", padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#374151" }}>
          <b>Your access is limited.</b> Ask the owner if you need another area.
          {ownerAccessNotice.temporary ? null : " Owner access is not set up yet — the owner finishes that in the app's server settings."}
          {ownerAccessNotice.userId ? <> Your Shopify staff user ID: <code>{ownerAccessNotice.userId}</code></> : null}
        </div>
      ) : null}
      {ownerAccessNotice && isOwner ? (
        <div style={{ margin: "8px 16px 0", padding: "6px 10px", borderRadius: 6, fontSize: 12, background: ownerAccessNotice.temporary ? "#fffbeb" : "#f3f4f6", border: `1px solid ${ownerAccessNotice.temporary ? "#fde68a" : "#e5e7eb"}`, color: "#374151" }}>
          <b>{ownerAccessNotice.temporary ? "TEMPORARY OWNER ACCESS" : "Owner access not configured"}</b>
          {ownerAccessNotice.temporary
            ? ` — every signed-in staff member has owner access (${ownerAccessNotice.switchEnv}=temporary_all_staff).`
            : ` — owner-only pages are closed until ${ownerAccessNotice.idsEnv} is set.`}
          {" "}Your Shopify staff user ID: <code>{ownerAccessNotice.userId || "not available in this session"}</code>
        </div>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};





