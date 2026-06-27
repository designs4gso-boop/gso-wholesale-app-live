import type { ActionFunctionArgs } from "react-router";

import { login } from "../../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await login(request);
  return null;
};

export default function AuthLogin() {
  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>Log in</h1>

      <form method="post" target="_top">
        <label>
          Shop domain
          <input
            name="shop"
            placeholder="942075-2.myshopify.com"
            defaultValue="942075-2.myshopify.com"
            style={{
              display: "block",
              width: "100%",
              padding: 10,
              marginTop: 8,
              marginBottom: 12,
            }}
          />
        </label>

        <button type="submit">Log in</button>
      </form>
    </main>
  );
}
