import { authenticate } from "../shopify.server";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cleanError(error: any) {
  return {
    name: error?.name,
    message: error?.message,
    graphQLErrors: error?.graphQLErrors,
    response: error?.response
      ? {
          status: error.response.status,
          statusText: error.response.statusText,
        }
      : undefined,
    stack: error?.stack,
  };
}

export const loader = async ({ request }: { request: Request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    // Patch 13.0 confirm gate: this route creates the live cart transform in
    // Shopify when visited. It must never run from a casual page load.
    const url = new URL(request.url);
    if (url.searchParams.get("confirm") !== "1") {
      return json({
        ok: false,
        blocked: true,
        warning: "Owner / advanced tool — changes here can affect live pricing, mappings, or Shopify behavior.",
        message:
          "This tool CREATES the live configurator cart transform in Shopify. Nothing was changed. To run it on purpose, re-open this URL with ?confirm=1 appended.",
        confirmUrl: "/app/create-configurator-cart-transform?confirm=1",
      });
    }

    const createRes = await admin.graphql(
      `
        mutation CreateConfiguratorCartTransform($functionHandle: String!, $blockOnFailure: Boolean) {
          cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure) {
            cartTransform {
              id
              functionId
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

    const userErrors = createJson?.data?.cartTransformCreate?.userErrors || [];
    const cartTransform = createJson?.data?.cartTransformCreate?.cartTransform || null;

    return json({
      ok: userErrors.length === 0 && !!cartTransform,
      step: "cartTransformCreate",
      functionHandle: "gso-configurator-cart-transform",
      cartTransform,
      userErrors,
      raw: createJson,
    });
  } catch (error: any) {
    return json(
      {
        ok: false,
        step: "exception",
        error: cleanError(error),
      },
      500,
    );
  }
};

