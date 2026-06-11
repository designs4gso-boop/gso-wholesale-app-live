import { authenticate } from "../shopify.server";

export const loader = async ({ request }: { request: Request }) => {
  const { admin } = await authenticate.admin(request);

  const functionsRes = await admin.graphql(`
    query ShopifyFunctions {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
          app {
            title
          }
        }
      }
    }
  `);

  const functionsJson = await functionsRes.json();

  const fn = functionsJson?.data?.shopifyFunctions?.nodes?.find((f: any) => {
    const title = String(f?.title || "").toLowerCase();
    const apiType = String(f?.apiType || "").toLowerCase();

    return (
      title.includes("gso-configurator-cart-transform") ||
      title.includes("configurator-cart-transform") ||
      title.includes("cart-transform") ||
      apiType.includes("cart_transform") ||
      apiType.includes("cart transform")
    );
  });

  if (!fn?.id && !fn?.title) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: "Cart transform function not found",
          availableFunctions: functionsJson?.data?.shopifyFunctions?.nodes || [],
        },
        null,
        2,
      ),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const existingRes = await admin.graphql(`
    query ExistingCartTransforms {
      cartTransforms(first: 25) {
        nodes {
          id
          functionId
          functionHandle
          blockOnFailure
        }
      }
    }
  `);

  const existingJson = await existingRes.json();

  const alreadyActive = existingJson?.data?.cartTransforms?.nodes?.find((t: any) => {
    return (
      String(t?.functionId || "") === String(fn.id || "") ||
      String(t?.functionHandle || "") === String(fn.title || "")
    );
  });

  if (alreadyActive) {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          status: "already_active",
          function: fn,
          cartTransform: alreadyActive,
          existingCartTransforms: existingJson?.data?.cartTransforms?.nodes || [],
        },
        null,
        2,
      ),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const createRes = await admin.graphql(
    `
      mutation CreateConfiguratorCartTransform($functionHandle: String!, $blockOnFailure: Boolean) {
        cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure) {
          cartTransform {
            id
            functionId
            functionHandle
            blockOnFailure
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
        functionHandle: "gso-configurator-cart-transform",
        blockOnFailure: false,
      },
    },
  );

  const createJson = await createRes.json();

  return new Response(
    JSON.stringify(
      {
        ok: !createJson?.data?.cartTransformCreate?.userErrors?.length,
        selectedFunction: fn,
        createResult: createJson,
        existingCartTransformsBeforeCreate: existingJson?.data?.cartTransforms?.nodes || [],
      },
      null,
      2,
    ),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
};
