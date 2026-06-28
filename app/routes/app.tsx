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
        <s-link href="/app/erp/setup-wizard">Setup Wizard</s-link>
        <s-link href="/app/quotes">Quotes / CRM</s-link>
        <s-link href="/app/erp/production">Production</s-link>
        <s-link href="/app/erp/reports-dashboard">Reports Dashboard</s-link>
        <s-link href="/app/erp/admin-settings">Admin Settings</s-link>
        <s-link href="/app/erp/print-logs">Print Logs</s-link>
        <s-link href="/app/erp/rip-imports">RIP Imports</s-link>
        <s-link href="/app/erp/print-intake">Print Intake</s-link>
        <s-link href="/app/erp/cost-calculator">Cost Calculator</s-link>
        <s-link href="/app/erp/pricing-rules">Pricing Rules</s-link>
        <s-link href="/app/erp/pricing-health">Pricing Health</s-link>
        <s-link href="/app/erp/configurator">Configurator</s-link>
        <s-link href="/app/erp/configurator-jar-mapping">Jar Mapping</s-link>
        <s-link href="/app/erp/configurator-sync">Configurator Sync</s-link>
        <s-link href="/app/erp/configurator-mapping">Manual Mapping</s-link>
        <s-link href="/app/erp/configurator-audit">Configurator Audit</s-link>
        <s-link href="/app/erp/products/new">Add Product</s-link>
        <s-link href="/app/erp/product-setup">Product Setup</s-link>
        <s-link href="/app/erp/shopify-links">Shopify Links</s-link>
        <s-link href="/app/erp/materials">Materials</s-link>
        <s-link href="/app/erp/machines">Machines</s-link>
        <s-link href="/app/erp/vendors">Vendors</s-link>
        <s-link href="/app/erp/vendor-cost-book">Vendor Cost Book</s-link>
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





