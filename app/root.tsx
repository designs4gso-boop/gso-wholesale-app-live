import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { AppProvider } from "@shopify/polaris";
import { AppProvider as AppBridgeProvider } from "@shopify/shopify-app-react-router/react";
import "@shopify/polaris/build/esm/styles.css";

export default function App() {
  return (
    <html>
      <head>
        <Meta />
        <Links />
      </head>
      <body>
        {/* 🔥 THIS FIXES YOUR EMBEDDED APP */}
        <AppBridgeProvider>
          <AppProvider>
            <Outlet />
          </AppProvider>
        </AppBridgeProvider>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}