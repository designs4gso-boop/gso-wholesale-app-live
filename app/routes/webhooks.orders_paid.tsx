import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  const order = payload as any;
  const tags = String(order.tags || "");
  const note = String(order.note || "");

  const quoteIdMatch = note.match(/Quote ID:\s*([a-zA-Z0-9]+)/);
  const quoteId = quoteIdMatch?.[1];

  if (!quoteId) {
    return new Response("No quote id found", { status: 200 });
  }

  await db.quote.updateMany({
    where: {
      id: quoteId,
      shop,
    },
    data: {
      status: "paid",
    },
  });

  return new Response("OK", { status: 200 });
};