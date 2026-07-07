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

  if (quote.status !== "approved") {
    return Response.json({ ok: false, error: "Quote must be Approved before creating a payment request." }, { status: 400 });
  }

  if (quote.fullOrderCreated) {
    return Response.json({ ok: false, error: "A full payment order already exists for this quote." }, { status: 400 });
  }

  if (quote.depositCreated || quote.balanceCreated) {
    return Response.json({ ok: false, error: "This quote is on the deposit/balance track." }, { status: 400 });
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
          tags: ["GSO Quote", "Wholesale", "Full Payment"],
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
      fullOrderCreated: true,
      fullDraftOrderId: draftOrder?.id || null,
      fullInvoiceUrl: draftOrder?.invoiceUrl || null,
    },
  });

  return Response.json({
    ok: true,
    invoiceUrl: draftOrder?.invoiceUrl,
    draftOrderId: draftOrder?.id,
    status: "approved",
  });
}