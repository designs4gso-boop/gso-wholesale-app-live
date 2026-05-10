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
        <s-link href="/app">Home</s-link>
        <s-link href="/app/erp/product-setup">Product Setup</s-link>
        <s-link href="/app/quotes">Quotes / CRM</s-link>
        <s-link href="/app/erp/recipes">Recipes</s-link>
        <s-link href="/app/erp/product-types">Product Types</s-link>
        <s-link href="/app/erp/materials">Materials</s-link>
        <s-link href="/app/erp/machines">Machines</s-link>
        <s-link href="/app/erp/vendor-products">Vendor Products</s-link>
        <s-link href="/app/wholesale/rules">Wholesale Rules</s-link>
        <s-link href="/app/wholesale/customers">Customers</s-link>
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
