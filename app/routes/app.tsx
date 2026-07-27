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
      {/* Patch 13.0 nav groups. The embedded admin nav renders a flat link
          list (no section headers), so grouping is expressed by ordering and
          label prefixes: unprefixed = Daily Operations; "Setup ·" = Setup &
          Cost Data; "Audit ·" = Cost Audit / Health; "Owner ·" = owner-only
          tools that can change live pricing, mappings, or Shopify behavior. */}
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/erp/setup-wizard">Setup Wizard</s-link>
        <s-link href="/app/erp/walkthrough">ERP Walkthrough</s-link>
        <s-link href="/app/quotes">Quotes / CRM</s-link>
        <s-link href="/app/erp/agent-review-queue">Agent Review Queue</s-link>
        <s-link href="/app/erp/production">Production</s-link>
        <s-link href="/app/erp/reports-dashboard">Reports Dashboard</s-link>
        <s-link href="/app/erp/print-logs">Print Logs</s-link>
        <s-link href="/app/erp/rip-imports">RIP Imports</s-link>
        <s-link href="/app/erp/rip-import-review">RIP Import Review</s-link>
        <s-link href="/app/erp/print-intake">Print Intake</s-link>
        <s-link href="/app/erp/cost-calculator">Cost Calculator</s-link>
        <s-link href="/app/erp/pricing-settings">Pricing Settings</s-link>
        <s-link href="/app/erp/pricing-intelligence">Pricing Intelligence</s-link>
        <s-link href="/app/erp/product-setup">Setup · Product Setup</s-link>
        <s-link href="/app/erp/products/new">Setup · Add Product</s-link>
        <s-link href="/app/erp/materials">Setup · Materials</s-link>
        <s-link href="/app/erp/machines">Setup · Machines</s-link>
        <s-link href="/app/erp/vendors">Setup · Vendors</s-link>
        <s-link href="/app/erp/vendor-cost-book">Setup · Vendor Cost Book</s-link>
        <s-link href="/app/erp/cost-verification">Audit · Cost Verification</s-link>
        <s-link href="/app/erp/cost-health">Audit · Cost Health</s-link>
        <s-link href="/app/erp/shopify-cost-audit">Audit · Shopify Cost Audit</s-link>
        <s-link href="/app/erp/actual-costs">Audit · Actual Costs</s-link>
        <s-link href="/app/erp/calibration">Audit · Calibration</s-link>
        <s-link href="/app/erp/pricing-health">Audit · Pricing Health</s-link>
        <s-link href="/app/erp/configurator-audit">Audit · Configurator Audit</s-link>
        <s-link href="/app/erp/admin-settings">Owner · Admin Settings</s-link>
        <s-link href="/app/erp/agent-security">Owner · Agent Security</s-link>
        <s-link href="/app/erp/pricing-rules">Owner · Pricing Rules</s-link>
        <s-link href="/app/erp/configurator">Owner · Configurator</s-link>
        <s-link href="/app/erp/configurator-sync">Owner · Configurator Sync</s-link>
        <s-link href="/app/erp/configurator-mapping">Owner · Manual Mapping</s-link>
        <s-link href="/app/erp/configurator-jar-mapping">Owner · Jar Mapping</s-link>
        <s-link href="/app/erp/shopify-links">Owner · Shopify Links</s-link>
        <s-link href="/app/erp/margin-review">Owner · Margin Review</s-link>
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





