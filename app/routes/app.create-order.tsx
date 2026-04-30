import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const { quoteId } = await request.json();

  const quote = await db.quote.findFirst({
    where: {
      id: quoteId,
      shop: session.shop,
    },
    include: {
      items: true,
    },
  });

  if (!quote) {
    return Response.json({ ok: false, error: "Quote not found" }, { status: 404 });
  }

  const lineItems = quote.items.map((item: any) => ({
    title: item.productName || "Custom print item",
    variantTitle: item.variant || "",
    sku: item.sku || "",
    quantity: Number(item.quantity) || 1,
    originalUnitPrice: String(Number(item.unitPrice) || 0),
    customAttributes: [
      { key: "Variant / Options", value: item.variant || "" },
      { key: "SKU", value: item.sku || "" },
      { key: "Notes", value: item.notes || "" },
    ],
  }));

  const response = await admin.graphql(
    `#graphql
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
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
        input: {
          email: quote.email || undefined,
          note: `Created from GSO Quote Builder. Quote ID: ${quote.id}`,
          tags: ["GSO Quote", "Wholesale"],
          lineItems,
        },
      },
    }
  );

  const data = await response.json();
  const errors = data.data?.draftOrderCreate?.userErrors || [];

  if (errors.length) {
    return Response.json({ ok: false, errors }, { status: 400 });
  }

  const draftOrder = data.data?.draftOrderCreate?.draftOrder;

  await db.quote.update({
    where: { id: quote.id },
    data: {
      status: "approved",
    },
  });

  return Response.json({
    ok: true,
    invoiceUrl: draftOrder?.invoiceUrl,
    draftOrderId: draftOrder?.id,
    status: "approved",
  });
}