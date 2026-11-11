import { authenticate, unauthenticated } from "../shopify.server";
import {
  configuratorBypassPaidOrderQueueItem,
  sendProductionAlertSafe,
  unrecognizedPaidOrderQueueItem,
  unverifiedPricePaidOrderQueueItem,
} from "../lib/production-alert.server";
import db from "../db.server";
import {
  configuratorBypassLinesOf,
  configuratorManagedIdsOf,
  createProductionJobFromSource,
  unverifiedConfiguratorLinesOf,
} from "../lib/production-job-source.server";
import { createAdminGraphql } from "../lib/personalization-assets.server";
import { adminDraftOrderLookup, unverifiedQuotePaymentQueueItem, verifyQuotePaymentOrder, type DraftOrderLookup } from "../lib/quote-payment-verification.server";
import { resolveWithBoundedRetry } from "../lib/personalization-checkout.server";
import type { PersonalizationProductionResolver } from "../lib/personalization-production.server";

// 15D.1: configurator-order job creation moved VERBATIM into the central
// service (app/lib/production-job-source.server.ts) — field-for-field parity
// is pinned by tests/production-job-source.test.ts. Quote payments: note-marker
// idempotency and forward-only status moves are unchanged; since 2026-11-11 the
// deposit/balance/full type comes from the VERIFIED draft-order link
// (quote-payment-verification.server.ts), never from note text or tags.

function clean(value: any) {
  return String(value ?? "").trim();
}

function orderName(order: any) {
  return clean(order.name) || clean(order.order_number) || clean(order.id) || "Shopify Order";
}

const DEPOSIT_PAID_MARKER = "[GSO] Deposit invoice paid";
const BALANCE_PAID_MARKER = "[GSO] Balance invoice paid";
const FULL_PAID_MARKER = "[GSO] Full payment invoice paid";

function appendQuoteNote(notes: string | null | undefined, line: string) {
  const existing = String(notes || "");
  if (existing.includes(line)) return existing;
  return existing ? `${existing}\n${line}` : line;
}

async function applyQuotePaymentFromOrder(
  deps: { db: any; lookupDraftOrder: DraftOrderLookup | null },
  shop: string,
  quoteId: string,
  order: any,
) {
  const db = deps.db;
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop } });
  if (!quote) return "OK no matching quote for Quote ID";

  // 2026-11-11: the note only NAMES the quote. The payment type comes from the
  // quote's own stored draft order that Shopify confirms produced this order,
  // with a matching subtotal. Unverifiable = no status change + review queue.
  const verification = await verifyQuotePaymentOrder({ quote, order, lookupDraftOrder: deps.lookupDraftOrder });
  if (!verification.ok) {
    try {
      await db.agentReviewQueueItem.create({ data: unverifiedQuotePaymentQueueItem(shop, order, quote.id, verification.reason) as any });
    } catch (error) {
      console.error("orders_paid unverified quote-payment trail failed", error);
    }
    return `OK quote payment NOT verified (${verification.reason}); status unchanged, held for review`;
  }
  const paymentType = verification.paymentType;
  const orderLabel = orderName(order);
  const existingNotes = String(quote.notes || "");
  const depositAlreadyPaid =
    quote.status === "deposit_paid" || quote.status === "paid" || existingNotes.includes(DEPOSIT_PAID_MARKER);
  const balanceAlreadyPaid = quote.status === "paid" || existingNotes.includes(BALANCE_PAID_MARKER);

  if (paymentType === "full") {
    await db.quote.updateMany({
      where: { id: quote.id, shop },
      data: {
        status: "paid",
        notes: appendQuoteNote(quote.notes, `${FULL_PAID_MARKER} (Shopify order ${orderLabel}).`),
      },
    });
    return "OK quote marked paid (full payment)";
  }

  if (paymentType === "deposit") {
    const notes = appendQuoteNote(quote.notes, `${DEPOSIT_PAID_MARKER} (Shopify order ${orderLabel}).`);

    if (balanceAlreadyPaid) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "paid", notes } });
      return "OK quote marked paid (deposit and balance both paid)";
    }

    // Deposit payment must never present as full settlement, and must not pull a
    // quote backward out of a later workflow status.
    if (["paid", "production", "completed"].includes(quote.status)) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { notes } });
      return `OK deposit payment recorded; status ${quote.status} preserved`;
    }

    await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "deposit_paid", notes } });
    return "OK quote marked deposit_paid";
  }

  if (paymentType === "balance") {
    const notes = appendQuoteNote(quote.notes, `${BALANCE_PAID_MARKER} (Shopify order ${orderLabel}).`);

    if (depositAlreadyPaid) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "paid", notes } });
      return "OK quote marked paid (balance paid after deposit)";
    }

    await db.quote.updateMany({ where: { id: quote.id, shop }, data: { notes } });
    return "OK balance payment recorded; deposit not confirmed paid, status unchanged";
  }

  return "OK quote payment order not classified; status unchanged";
}

/**
 * Phase 5: an admin GraphQL client for re-resolving Stock Bag personalization
 * assets at production time.
 *
 * `shop` here comes from Shopify's verified webhook HMAC, not from a caller, so
 * looking up the stored offline session for it is legitimate — the 15G.1 rule
 * this must not break is "never a caller-chosen shop value".
 *
 * Returns null on any failure. A missing session or an uninstalled app must
 * degrade personalization to "needs resolution", never block a paid order from
 * becoming a production job.
 */
async function buildPersonalizationResolver(shop: string): Promise<PersonalizationProductionResolver | null> {
  try {
    const { session } = await unauthenticated.admin(shop);
    if (!session?.accessToken) return null;
    const graphql = createAdminGraphql(shop, session.accessToken);
    return (assetId: string) => resolveWithBoundedRetry({ graphql } as any, assetId, 3);
  } catch (error) {
    console.error("[orders_paid] could not build a personalization resolver", { shop, error: String(error) });
    return null;
  }
}

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop, admin } = await authenticate.webhook(request);

  const order = payload as any;
  const note = String(order.note || "");

  const quoteIdMatch = note.match(/Quote ID:\s*([a-zA-Z0-9]+)/);
  const quoteId = quoteIdMatch?.[1];

  if (quoteId) {
    const message = await applyQuotePaymentFromOrder({ db, lookupDraftOrder: adminDraftOrderLookup(admin) }, shop, quoteId, order);
    return new Response(message, { status: 200 });
  }

  // Basic-plan checkout authority (2026-10-17): configured lines bought through
  // native /cart/add were charged the variant price, not the server-computed
  // configured price — hold the order for review, never auto-create a job.
  const unverifiedLines = unverifiedConfiguratorLinesOf(order);
  if (unverifiedLines.length) {
    try {
      await db.agentReviewQueueItem.create({ data: unverifiedPricePaidOrderQueueItem(shop, order, unverifiedLines) as any });
    } catch (error) {
      console.error("orders_paid unverified-price hold trail failed", error);
    }
    return new Response("OK held for price review: configured line(s) bypassed the GSO checkout", { status: 200 });
  }

  // 2026-11-11: a RAW variant of a configurator-only product (the $1.00 Stock
  // Bag path) holds the whole order for the owner — never a production job.
  let bypassLines: any[] = [];
  try {
    const managed = configuratorManagedIdsOf(
      await db.configuratorProduct.findMany({ where: { shop, active: true }, select: { shopifyProductGid: true, shopifyVariantGid: true } }),
    );
    bypassLines = configuratorBypassLinesOf(order, managed);
  } catch (error) {
    console.error("orders_paid configurator-bypass check failed", error);
  }
  if (bypassLines.length) {
    try {
      await db.agentReviewQueueItem.create({ data: configuratorBypassPaidOrderQueueItem(shop, order, bypassLines) as any });
    } catch (error) {
      console.error("orders_paid configurator-bypass hold trail failed", error);
    }
    return new Response("OK held for owner review: raw variant(s) of a configurator-only product bypassed the configurator", { status: 200 });
  }

  // Configurator orders: same pseudo-quoteId idempotency, same ticket naming,
  // same item file names — now via the central service (webhook retries get
  // the existing job back with created:false).
  const result = await createProductionJobFromSource(db, {
    shop,
    source: { type: "shopify_order", order },
    actor: "orders_paid_webhook",
    personalizationResolver: await buildPersonalizationResolver(shop),
  });

  // 2026-10-07: the same production alert the board / quotes paths send, and a
  // visible review-queue trail when a PAID order produced no job. Neither can
  // fail the webhook (Shopify always gets 200 once the job decision is made).
  try {
    if (result.created && result.job) {
      await sendProductionAlertSafe(result.job, "paid Shopify order (webhook)");
    } else if (!result.job) {
      await db.agentReviewQueueItem.create({ data: unrecognizedPaidOrderQueueItem(shop, order) as any });
    }
  } catch (error) {
    console.error("orders_paid post-create trail failed", error);
  }

  return new Response(result.reason || "OK", { status: 200 });
};
