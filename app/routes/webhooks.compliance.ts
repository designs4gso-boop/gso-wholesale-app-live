import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { recordComplianceRequest } from "../lib/privacy-compliance.server";

// 2026-11-19: Shopify privacy webhooks (customers/data_request, customers/redact,
// shop/redact). The signature is verified by authenticate.webhook; the request
// is then RECORDED for the owner (app/lib/privacy-compliance.server.ts) instead
// of being acknowledged and forgotten. Nothing is erased here. If the record
// cannot be written the webhook answers 500 so Shopify delivers it again.
export async function action({ request }: ActionFunctionArgs) {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const { topic, shop, payload } = await authenticate.webhook(request);
  try {
    await recordComplianceRequest(db, { shop, topic, webhookId, payload });
  } catch (error) {
    console.error("[webhooks.compliance] could not record the request", { shop, topic: String(topic), error: String(error) });
    return new Response("Could not record the request", { status: 500 });
  }
  return new Response();
}
