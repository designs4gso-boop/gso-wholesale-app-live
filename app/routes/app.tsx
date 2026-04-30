import { Outlet } from "react-router";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function App() {
  return (
    <AppProvider isEmbeddedApp apiKey={window.ENV.SHOPIFY_API_KEY}>
      <NavMenu>
        <a href="/app" rel="home">
          Dashboard
        </a>

        <a href="/app/quotes">
          Quotes / CRM
        </a>

        <a href="/app/wholesale/calculator">
          Cost Calculator
        </a>

        <a href="/app/wholesale/rules">
          Pricing Rules
        </a>

        <a href="/app/wholesale">
          Wholesale Settings
        </a>

        <a href="/app/wholesale/customers">
          Customers
        </a>
      </NavMenu>

      <Outlet />
    </AppProvider>
  );
}