import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: { request: Request }) => {
  const { admin } = await authenticate.admin(request);

  const functionsRes = await admin.graphql(`
    query {
      shopifyFunctions(first: 20) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `);

  const functionsJson = await functionsRes.json();

  const fn = functionsJson.data.shopifyFunctions.nodes.find((f: any) =>
    f.title.toLowerCase().includes("gso-wholesale-discount")
  );

  if (!fn) {
    return new Response("Function not found", { status: 404 });
  }

  const createRes = await admin.graphql(
    `
    mutation CreateWholesaleDiscount($functionId: String!) {
      discountAutomaticAppCreate(
        automaticAppDiscount: {
          title: "Wholesale Pricing"
          functionId: $functionId
          startsAt: "2024-01-01T00:00:00Z"
          discountClasses: ["ORDER"],
          }
        }
      ) {
        automaticAppDiscount {
          discountId
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