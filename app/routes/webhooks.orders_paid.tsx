import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { createProductionJobFromSource } from "../lib/production-job-source.server";
import { createAdminGraphql } from "../lib/personalization-assets.server";
import { resolveWithBoundedRetry } from "../lib/personalization-checkout.server";
import type { PersonalizationProductionResolver } from "../lib/personalization-production.server";

// 15D.1: configurator-order job creation moved VERBATIM into the central
// service (app/lib/production-job-source.server.ts) — field-for-field parity
// is pinned by tests/production-job-source.test.ts. The quote-payment branch
// below is UNCHANGED (deposit/balance/full classification, note-marker
// idempotency, forward-only status moves).

function clean(value: any) {
  return String(value ?? "").trim();
}

function orderName(order: any) {
  return clean(order.name) || clean(order.order_number) || clean(order.id) || "Shopify Order";
}

function getLineProperty(line: any, name: string) {
  const wanted = name.toLowerCase();

  const properties = Array.isArray(line.properties) ? line.properties : [];
  for (const prop of properties) {
    const key = clean(prop.name || prop.key).toLowerCase();
    if (key === wanted) return clean(prop.value);
  }

  const customAttributes = Array.isArray(line.customAttributes) ? line.customAttributes : [];
  for (const attr of customAttributes) {
    const key = clean(attr.name || attr.key).toLowerCase();
    if (key === wanted) return clean(attr.value);
  }

  return "";
}

const DEPOSIT_PAID_MARKER = "[GSO] Deposit invoice paid";
const BALANCE_PAID_MARKER = "[GSO] Balance invoice paid";
const FULL_PAID_MARKER = "[GSO] Full payment invoice paid";

function orderTags(order: any) {
  const raw = order?.tags;
  const parts = Array.isArray(raw) ? raw.map((tag: any) => clean(tag)) : clean(raw).split(",");
  return parts.map((tag: string) => tag.trim().toLowerCase()).filter(Boolean);
}

function classifyQuotePaymentOrder(order: any, note: string) {
  const tags = orderTags(order);
  const noteText = note.toLowerCase();
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];

  const isDeposit =
    tags.includes("deposit") ||
    noteText.includes("deposit created from gso quote builder") ||
    lines.some((line: any) => getLineProperty(line, "Deposit Percent") || clean(line.title).startsWith("Deposit Payment"));

  const isBalance =
    tags.includes("remaining balance") ||
    noteText.includes("remaining balance created from gso quote builder") ||
    lines.some((line: any) => getLineProperty(line, "Deposit Paid") || clean(line.title).startsWith("Remaining Balance"));

  if (isDeposit && isBalance) return "unknown";
  if (isDeposit) return "deposit";
  if (isBalance) return "balance";

  // "created from gso quote builder" also appears inside the deposit/balance notes,
  // so the full-payment check must run after both of them.
  if (tags.includes("full payment") || noteText.includes("created from gso quote builder")) return "full";

  return "unknown";
}

function appendQuoteNote(notes: string | null | undefined, line: string) {
  const existing = String(notes || "");
  if (existing.includes(line)) return existing;
  return existing ? `${existing}\n${line}` : line;
}

async function applyQuotePaymentFromOrder(shop: string, quoteId: string, order: any, note: string) {
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop } });
  if (!quote) return "OK no matching quote for Quote ID";

  const paymentType = classifyQuotePaymentOrder(order, note);
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
  const { payload, shop } = await authenticate.webhook(request);

  const order = payload as any;
  const note = String(order.note || "");

  const quoteIdMatch = note.match(/Quote ID:\s*([a-zA-Z0-9]+)/);
  const quoteId = quoteIdMatch?.[1];

  if (quoteId) {
    const message = await applyQuotePaymentFromOrder(shop, quoteId, order, note);
    return new Response(message, { status: 200 });
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

  return new Response(result.reason || "OK", { status: 200 });
};
