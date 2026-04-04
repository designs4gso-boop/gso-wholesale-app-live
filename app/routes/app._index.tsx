import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AppIndex() {
  return (
    <s-page>
      <s-section heading="Wholesale Lite">
        <s-text>
          Shopify embedded app auth is working.
        </s-text>
      </s-section>
    </s-page>
  );
}