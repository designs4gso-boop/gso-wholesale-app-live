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
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/quotes">Quotes / CRM</s-link>
        <s-link href="/app/erp/production">Production</s-link>
        <s-link href="/app/erp/production-calendar">Production Calendar</s-link>
        <s-link href="/app/erp/reports-dashboard">Reports Dashboard</s-link>
        <s-link href="/app/erp/product-setup">Product Setup</s-link>
        <s-link href="/app/erp/admin-settings">Admin Settings</s-link>
        <s-link href="/app/erp/print-logs">Print Logs</s-link>
        <s-link href="/app/erp/print-log-settings">Print Log Settings</s-link>
        <s-link href="/app/erp/reorder-report">Reorder Report</s-link>
        <s-link href="/app/erp/purchase-requests">PO Requests</s-link>
        <s-link href="/app/erp/vendors">Vendor Center</s-link>
        <s-link href="/app/erp/vendor-cost-book">Vendor Cost Book</s-link>
        <s-link href="/app/product-costs">Product Costs</s-link>
        <s-link href="/app/wholesale/calculator">Cost Calculator</s-link>
        <s-link href="/app/erp/product-type-routes">Product Type Routes</s-link>
        <s-link href="/app/wholesale/rules">Pricing Rules</s-link>
        <s-link href="/app/wholesale">Wholesale Settings</s-link>
        <s-link href="/app/wholesale/customers">Customers</s-link>
        <s-link href="/app/erp/margin-review">Margin Review</s-link>
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