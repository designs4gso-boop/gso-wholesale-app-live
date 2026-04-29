import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const functionsRes = await admin.graphql(`
    query {
      shopifyFunctions(first: 25) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `);

  const functionsJson = await functionsRes.json();

  const fn = functionsJson?.data?.shopifyFunctions?.nodes?.find((f: any) =>
    String(f.title || "").toLowerCase().includes("gso-wholesale-discount")
  );

  if (!fn?.id) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Function not found",
        availableFunctions: functionsJson?.data?.shopifyFunctions?.nodes || [],
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const createRes = await admin.graphql(
    `
      mutation CreateWholesaleDiscount($functionId: String!) {
        discountAutomaticAppCreate(
          automaticAppDiscount: {
            title: "Wholesale Pricing"
            functionId: $functionId
            startsAt: "2024-01-01T00:00:00Z"
            discountClasses: [PRODUCT]
            combinesWith: {
              orderDiscounts: true
              productDiscounts: true
              shippingDiscounts: true
            }
          }
        ) {
          automaticAppDiscount {
            discountId
            title
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        functionId: fn.id,
      },
    }
  );

  const createJson = await createRes.json();

  return new Response(JSON.stringify(createJson, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};