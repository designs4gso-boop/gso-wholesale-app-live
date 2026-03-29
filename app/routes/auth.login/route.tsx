import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");

  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <div
        style={{
          maxWidth: 720,
          margin: "60px auto",
          padding: 24,
          border: "1px solid #e1e3e5",
          borderRadius: 12,
          background: "#fff",
        }}
      >
        <h1 style={{ marginTop: 0 }}>Log in</h1>

        <Form method="post">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label htmlFor="shop" style={{ fontWeight: 600 }}>
              Shop domain
            </label>

            <input
              id="shop"
              name="shop"
              type="text"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              placeholder="example.myshopify.com"
              autoComplete="on"
              style={{
                padding: "12px 14px",
                border: "1px solid #8c9196",
                borderRadius: 8,
                fontSize: 16,
              }}
            />

            {errors?.shop ? (
              <p style={{ color: "#d82c0d", margin: 0 }}>{errors.shop}</p>
            ) : null}

            <div>
              <button
                type="submit"
                style={{
                  padding: "10px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "#111827",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Log in
              </button>
            </div>
          </div>
        </Form>
      </div>
    </AppProvider>
  );
}