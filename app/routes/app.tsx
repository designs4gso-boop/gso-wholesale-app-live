import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { OWNER_ENFORCEMENT_ENV, OWNER_USER_IDS_ENV, configuredOwnerUserIds, resolveOwnerAuthorization } from "../lib/owner-authorization.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const owner = resolveOwnerAuthorization(auth);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // 2026-10-19: owner-only nav entries are hidden for staff (the routes themselves refuse non-owners server-side).
    isOwner: owner.isOwner,
    // 2026-11-11 OWNER ACCESS DIAGNOSTIC: shown only while owner access is not
    // yet permanent — the temporary switch is on, or no owner IDs are set. It
    // names the mode and the viewer's OWN verified Shopify staff user ID (the
    // value GSO_OWNER_SHOPIFY_USER_IDS needs). Gone once enforcement is final.
    ownerAccessNotice: owner.enforcement === "temporary_all_staff" || !configuredOwnerUserIds().length
      ? { temporary: owner.enforcement === "temporary_all_staff", userId: owner.userId, idsEnv: OWNER_USER_IDS_ENV, switchEnv: OWNER_ENFORCEMENT_ENV }
      : null,
  };
};

export default function App() {
  const { apiKey, isOwner, ownerAccessNotice } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* Nav groups (2026-10-05). The embedded admin nav renders a flat link
          list (no section headers), so grouping is expressed by ordering and
          label prefixes: Dashboard, then "Sales ·", "Production ·",
          "Purchasing ·", "Operations ·", "Reporting ·", "Pricing ·",
          "Audit ·", "Setup ·", "Admin ·", "Help ·". Everything that used to be
          an "Owner ·" or secondary "Audit ·" link (configurator tools, cost
          audits, admin settings, agent security, pricing rules, production
          extras, Add Product) now lives ONLY under Dashboard -> "Advanced &
          owner tools" (/app#advanced) so the daily nav stays short. */}
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/quotes">Sales · Quotes / CRM</s-link>
        <s-link href="/app/wholesale/customers">Sales · Wholesale Applications</s-link>
        {isOwner ? <s-link href="/app/erp/cost-calculator">Sales · Cost Calculator</s-link> : null}
        <s-link href="/app/erp/production">Production · Production Board</s-link>
        <s-link href="/app/erp/print-intake">Production · Print Intake</s-link>
        <s-link href="/app/erp/rip-imports">Production · RIP Imports & Review</s-link>
        <s-link href="/app/erp/print-logs">Production · Print Logs</s-link>
        <s-link href="/app/erp/purchase-requests">Purchasing · Purchase Requests</s-link>
        <s-link href="/app/erp/reorder-report">Purchasing · Reorder Report</s-link>
        <s-link href="/app/erp/agent-review-queue">Operations · Agent Review Queue</s-link>
        <s-link href="/app/erp/ops-hub">Operations · Operations Hub</s-link>
        <s-link href="/app/erp/reports-dashboard">Reporting · Reports Dashboard</s-link>
        <s-link href="/app/erp/pricing-settings">Pricing · Pricing Settings</s-link>
        <s-link href="/app/erp/pricing-intelligence">Pricing · Pricing Intelligence</s-link>
        <s-link href="/app/erp/margin-review">Pricing · Margin Review</s-link>
        <s-link href="/app/erp/cost-verification">Audit · Cost Verification</s-link>
        <s-link href="/app/erp/product-setup">Setup · Product Setup</s-link>
        <s-link href="/app/erp/materials">Setup · Materials</s-link>
        <s-link href="/app/erp/machines">Setup · Machines</s-link>
        <s-link href="/app/erp/vendors">Setup · Vendors</s-link>
        <s-link href="/app/erp/vendor-cost-book">Setup · Vendor Cost Book</s-link>
        <s-link href="/app#advanced">Admin · Advanced Tools</s-link>
        <s-link href="/app/erp/setup-wizard">Help · Launch Readiness</s-link>
        <s-link href="/app/erp/walkthrough">Help · ERP Walkthrough</s-link>
      </s-app-nav>

      {ownerAccessNotice ? (
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





