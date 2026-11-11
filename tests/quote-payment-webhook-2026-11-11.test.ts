// 2026-11-11 — orders/paid quote payments are VERIFIED, never trusted from the
// order note. The real webhook action runs against an in-memory DB and a
// mocked Shopify Admin draft-order lookup.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  payload: null as any,
  shop: "shop-1",
  quotes: [] as any[],
  reviewItems: [] as any[],
  updates: [] as any[],
  draftOrders: {} as Record<string, { order: { id: string } | null; subtotal: string }>,
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    webhook: async () => ({
      payload: h.payload,
      shop: h.shop,
      admin: {
        graphql: async (_q: string, { variables }: any) => ({
          json: async () => {
            const d = h.draftOrders[variables.id];
            return { data: { draftOrder: d ? { order: d.order, subtotalPriceSet: { shopMoney: { amount: d.subtotal } } } : null } };
          },
        }),
      },
    }),
  },
  unauthenticated: { admin: async () => ({ session: null }) },
}));
vi.mock("../app/db.server", () => {
  const db: any = {
    quote: {
      findFirst: async ({ where }: any) => h.quotes.find((q) => q.id === where.id && q.shop === where.shop) ?? null,
      updateMany: async ({ where, data }: any) => {
        const q = h.quotes.find((row) => row.id === where.id && row.shop === where.shop);
        if (q) { Object.assign(q, data); h.updates.push({ id: q.id, ...data }); }
        return { count: q ? 1 : 0 };
      },
    },
    agentReviewQueueItem: { create: async ({ data }: any) => { h.reviewItems.push(data); return data; } },
  };
  return { default: db, db };
});
vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, createProductionJobFromSource: vi.fn(async () => ({ created: false, job: null, reason: "not used" })) };
});

import { action } from "../app/routes/webhooks.orders_paid";
import { verifyQuotePaymentOrder } from "../app/lib/quote-payment-verification.server";

const QUOTE_ID = "cq1quoteabc";
const order = (over: Record<string, any> = {}) => ({
  id: 5001, admin_graphql_api_id: "gid://shopify/Order/5001", name: "#5001", financial_status: "paid",
  subtotal_price: "625.00", note: `Quote ID: ${QUOTE_ID}\nCreated from GSO Quote Builder`, tags: "", line_items: [],
  ...over,
});
async function paid(payload: any) {
  h.payload = payload;
  const res = await action({ request: new Request("https://x.test/webhooks/orders_paid", { method: "POST" }) });
  return res.text();
}

beforeEach(() => {
  h.shop = "shop-1";
  h.reviewItems = [];
  h.updates = [];
  h.quotes = [{ id: QUOTE_ID, shop: "shop-1", status: "approved", notes: "", fullDraftOrderId: "gid://shopify/DraftOrder/77", depositDraftOrderId: null, balanceDraftOrderId: null }];
  h.draftOrders = { "gid://shopify/DraftOrder/77": { order: { id: "gid://shopify/Order/5001" }, subtotal: "625.00" } };
});

describe("quote payment webhook", () => {
  it("a valid paid order from the quote's own draft order marks the quote paid", async () => {
    expect(await paid(order())).toContain("marked paid");
    expect(h.quotes[0].status).toBe("paid");
    expect(h.reviewItems).toEqual([]);
  });

  it("a FORGED note on an unrelated order changes nothing and goes to review", async () => {
    const text = await paid(order({ id: 6666, admin_graphql_api_id: "gid://shopify/Order/6666", subtotal_price: "1.00" }));
    expect(text).toContain("NOT verified");
    expect(h.quotes[0].status).toBe("approved");
    expect(h.updates).toEqual([]);
    expect(h.reviewItems[0]).toMatchObject({ source: "shopify_order_quote_payment_unverified", shop: "shop-1" });
  });

  it("a webhook from ANOTHER shop cannot touch this shop's quote", async () => {
    h.shop = "shop-2";
    expect(await paid(order())).toContain("no matching quote");
    expect(h.quotes[0].status).toBe("approved");
  });

  it("a wrong amount (order modified after the draft) is refused", async () => {
    expect(await paid(order({ subtotal_price: "100.00" }))).toContain("does not match");
    expect(h.quotes[0].status).toBe("approved");
    expect(h.reviewItems).toHaveLength(1);
  });

  it("missing linkage (no stored draft order) is refused", async () => {
    h.quotes[0].fullDraftOrderId = null;
    expect(await paid(order())).toContain("no stored draft order");
    expect(h.quotes[0].status).toBe("approved");
  });

  it("an unpaid financial status is refused", async () => {
    expect(await paid(order({ financial_status: "pending" }))).toContain("not paid");
    expect(h.quotes[0].status).toBe("approved");
  });

  it("a duplicate webhook is idempotent (one payment note, status stays paid)", async () => {
    await paid(order());
    await paid(order());
    expect(h.quotes[0].status).toBe("paid");
    expect(h.quotes[0].notes.match(/Full payment invoice paid/g)).toHaveLength(1);
  });

  it("the draft-order link — not the note — decides deposit vs balance", async () => {
    h.quotes[0] = { ...h.quotes[0], fullDraftOrderId: null, depositDraftOrderId: "gid://shopify/DraftOrder/88" };
    h.draftOrders = { "gid://shopify/DraftOrder/88": { order: { id: "gid://shopify/Order/5001" }, subtotal: "625.00" } };
    // the note claims full payment; the verified link says deposit
    await paid(order());
    expect(h.quotes[0].status).toBe("deposit_paid");
  });

  it("no Admin API access fails closed", async () => {
    const result = await verifyQuotePaymentOrder({ quote: h.quotes[0], order: order(), lookupDraftOrder: null });
    expect(result.ok).toBe(false);
  });
});
