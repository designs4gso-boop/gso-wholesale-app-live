import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

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
        <s-link href="/app/erp/cost-calculator">Sales · Cost Calculator</s-link>
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
        <s-link href="/app/erp/setup-wizard">Help · Setup Wizard</s-link>
        <s-link href="/app/erp/walkthrough">Help · ERP Walkthrough</s-link>
      </s-app-nav>

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





