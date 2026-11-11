// 2026-11-11 — QUOTE PAYMENT VERIFICATION (orders/paid webhook).
//
// Before this, a paid order whose NOTE said "Quote ID: <id> ... created from
// gso quote builder" moved that quote to paid — and a customer can type any
// note into a storefront cart. Note text is now only a HINT that names the
// quote. A quote changes status only when ALL of these hold:
//
//   1. the webhook is Shopify-signed and the quote belongs to that shop
//      (authenticate.webhook + shop-scoped lookup, unchanged);
//   2. the order is actually paid (financial_status);
//   3. one of the quote's OWN stored draft orders (fullDraftOrderId /
//      depositDraftOrderId / balanceDraftOrderId — created server-side by the
//      ERP) is the draft order that produced THIS order, confirmed against the
//      Shopify Admin API; that link — not the note or tags — decides whether
//      it is the full, deposit or balance payment;
//   4. the order subtotal equals that draft order's subtotal (± $0.01).
//
// Anything else fails CLOSED: no status change, and the order goes to the
// Agent Review Queue for staff. Pure: Shopify access is injected.


export type QuotePaymentType = "full" | "deposit" | "balance";

export type DraftOrderLookup = (draftOrderGid: string) => Promise<{ orderId: string | null; subtotal: number | null } | null>;

export type QuotePaymentVerification =
  | { ok: true; paymentType: QuotePaymentType; draftOrderId: string; basis: string }
  | { ok: false; reason: string };

const AMOUNT_TOLERANCE = 0.01;

/** The stable Admin GraphQL id of the webhook's order. */
export function webhookOrderGid(order: any): string {
  const explicit = String(order?.admin_graphql_api_id ?? "").trim();
  if (explicit) return explicit;
  const id = String(order?.id ?? "").trim();
  return id ? (id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`) : "";
}

export function storedDraftOrderLinks(quote: any): Array<{ type: QuotePaymentType; draftOrderId: string }> {
  return ([
    ["full", quote?.fullDraftOrderId],
    ["deposit", quote?.depositDraftOrderId],
    ["balance", quote?.balanceDraftOrderId],
  ] as Array<[QuotePaymentType, unknown]>)
    .filter(([, id]) => String(id ?? "").trim())
    .map(([type, id]) => ({ type, draftOrderId: String(id).trim() }));
}

export async function verifyQuotePaymentOrder(input: {
  quote: any;
  order: any;
  lookupDraftOrder: DraftOrderLookup | null;
}): Promise<QuotePaymentVerification> {
  const { quote, order, lookupDraftOrder } = input;
  const financial = String(order?.financial_status ?? "").toLowerCase();
  if (financial && financial !== "paid") return { ok: false, reason: `order financial_status is "${financial}", not paid` };
  const orderGid = webhookOrderGid(order);
  if (!orderGid) return { ok: false, reason: "order has no stable identity" };
  const links = storedDraftOrderLinks(quote);
  if (!links.length) return { ok: false, reason: "the quote has no stored draft order — nothing links this order to it" };
  if (!lookupDraftOrder) return { ok: false, reason: "Shopify Admin API unavailable — the draft-order link cannot be verified" };

  const matches: Array<{ type: QuotePaymentType; draftOrderId: string; subtotal: number | null }> = [];
  for (const link of links) {
    let found: Awaited<ReturnType<DraftOrderLookup>> = null;
    try {
      found = await lookupDraftOrder(link.draftOrderId);
    } catch {
      found = null;
    }
    if (found?.orderId && found.orderId === orderGid) matches.push({ ...link, subtotal: found.subtotal });
  }
  if (!matches.length) return { ok: false, reason: "no draft order stored on this quote produced this order (note/tags alone are not trusted)" };
  if (matches.length > 1) return { ok: false, reason: "more than one stored draft order claims this order — ambiguous" };

  const match = matches[0];
  const orderSubtotal = Number(order?.current_subtotal_price ?? order?.subtotal_price);
  if (match.subtotal == null || !Number.isFinite(orderSubtotal)) return { ok: false, reason: "order or draft-order subtotal missing — amount cannot be verified" };
  if (Math.abs(orderSubtotal - match.subtotal) > AMOUNT_TOLERANCE) {
    return { ok: false, reason: `order subtotal ${orderSubtotal.toFixed(2)} does not match the ${match.type} draft order subtotal ${match.subtotal.toFixed(2)}` };
  }
  return { ok: true, paymentType: match.type, draftOrderId: match.draftOrderId, basis: `${match.type} draft order ${match.draftOrderId} produced order ${orderGid}; subtotal ${orderSubtotal.toFixed(2)} matches` };
}

/** Admin GraphQL lookup used by the webhook. Returns null on any failure (fails closed upstream). */
export function adminDraftOrderLookup(admin: any): DraftOrderLookup | null {
  if (!admin?.graphql) return null;
  return async (draftOrderGid: string) => {
    const response = await admin.graphql(
      `#graphql
      query GsoQuotePaymentDraftOrder($id: ID!) {
        draftOrder(id: $id) { order { id } subtotalPriceSet { shopMoney { amount } } }
      }`,
      { variables: { id: draftOrderGid } },
    );
    const json = await response.json();
    const draft = json?.data?.draftOrder;
    if (!draft) return null;
    const subtotal = Number(draft?.subtotalPriceSet?.shopMoney?.amount);
    return { orderId: draft?.order?.id ?? null, subtotal: Number.isFinite(subtotal) ? subtotal : null };
  };
}

/** Review-queue trail for a paid order that names a quote but could not be verified. */
export function unverifiedQuotePaymentQueueItem(shop: string, order: any, quoteId: string, reason: string) {
  const orderName = String(order?.name || order?.order_number || order?.id || "order");
  return {
    shop,
    source: "shopify_order_quote_payment_unverified",
    status: "new",
    reviewLevel: "basic_staff_review",
    customerName: [order?.customer?.first_name, order?.customer?.last_name].filter(Boolean).join(" ") || order?.billing_address?.name || null,
    company: order?.customer?.default_address?.company || order?.billing_address?.company || null,
    email: order?.email || order?.customer?.email || null,
    productFamily: "quote_payment",
    quantity: "0",
    internalNotes: `PAID SHOPIFY ORDER ${orderName} names quote ${quoteId} but the payment could NOT be verified: ${reason}. The quote status was NOT changed and no production job was created. Confirm the payment in Shopify, then have the owner update the quote.`,
    recommendedStaffAction: "Verify the order and amount in Shopify before marking the quote paid.",
    createdBy: "orders_paid_webhook",
  };
}
