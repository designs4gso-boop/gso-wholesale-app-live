import { json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getProductWholesalePricing } from "../lib/wholesale.server";

async function customerTagsForEmail(admin: any, email: string | null) {
  if (!email) return [];
  const res = await admin.graphql(
    `#graphql
    query($query: String!) {
      customers(first: 1, query: $query) {
        nodes { tags email }
      }
    }`,
    { variables: { query: `email:${email}` } },
  );
  const data = await res.json();
  return data?.data?.customers?.nodes?.[0]?.tags || [];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return json({ ok: false, message: "App not installed." }, { status: 400 });
  }

  const url = new URL(request.url);
  const productId = url.searchParams.get("product_id") || "";
  const variantIds = (url.searchParams.get("variant_ids") || "").split(",").filter(Boolean);
  const customerEmail = url.searchParams.get("customer_email");
  const subtotal = Number(url.searchParams.get("subtotal") || 0);
  const cartQuantity = Number(url.searchParams.get("cart_quantity") || 0);

  if (!productId || variantIds.length === 0) {
    return json({ ok: false, message: "product_id and variant_ids required." }, { status: 400 });
  }

  const customerTags = await customerTagsForEmail(admin, customerEmail);
  const result = await getProductWholesalePricing(
    session.shop,
    productId,
    variantIds,
    customerTags,
    [],
    subtotal,
    cartQuantity,
  );

  return json({
    ok: true,
    customerTags,
    settings: {
      minCartQuantity: result.settings.minCartQuantity,
      enforceMinCartQty: result.settings.enforceMinCartQty,
      minimumSubtotal: result.settings.minimumSubtotal,
      wholesaleTag: result.settings.wholesaleTag,
    },
    tiersByVariant: result.tiersByVariant,
    metaByVariant: result.metaByVariant,
  });
}
