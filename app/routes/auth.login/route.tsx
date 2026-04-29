import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect, Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  if (shop) {
    const params = new URLSearchParams({ shop });
    if (host) params.set("host", host);
    return redirect(`/auth?${params.toString()}`);
  }

  const errors = loginErrorMessage(await login(request));
  return data({ errors });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const shop = String(formData.get("shop") || "").trim();

  if (shop) {
    return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }

  const errors = loginErrorMessage(await login(request));
  return data({ errors });
};

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors || loaderData?.errors;

  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>Log in</h1>

      <Form method="post">
        <label>
          Shop domain
          <input
            name="shop"
            placeholder="example.myshopify.com"
            style={{
              display: "block",
              width: "100%",
              padding: 10,
              marginTop: 8,
              marginBottom: 12,
            }}
          />
        </label>

        {errors?.shop ? (
          <p style={{ color: "red" }}>{errors.shop}</p>
        ) : null}

        <button type="submit">Log in</button>
      </Form>
    </main>
  );
}