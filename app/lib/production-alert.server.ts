// Production Slack alert — shared, never-throwing helper (2026-10-07).
//
// The Production Board and the Quotes board already post "New GSO Production
// Job" to the production webhook when a job is created. Paid Shopify orders
// create jobs through the orders/paid webhook and were the only path with no
// alert; this helper closes that gap with the SAME webhook and message shape.
// It is decision-free (a notification only), and a failure can never fail the
// caller — the webhook response to Shopify stays 200 regardless.

import { staffStatusLabel } from "./production-status-vocabulary";

export type ProductionAlertResult = { sent: boolean; reason: string };

export function productionAlertWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SLACK_WEBHOOK_URL || env.PRODUCTION_SLACK_WEBHOOK_URL || null;
}

export function buildProductionAlertText(job: any, sourceLabel: string): string {
  return [
    "🚨 New GSO Production Job",
    `Source: ${sourceLabel}`,
    `Customer: ${job?.company || job?.customerName || "Unknown"}`,
    `Job: ${job?.jobTicket || job?.id || "?"}`,
    `Quote: ${job?.quoteId || "N/A"}`,
    `Priority: ${job?.priority || "normal"}`,
    `Status: ${staffStatusLabel(String(job?.status || "new"))}`,
  ].join("\n");
}

export async function sendProductionAlertSafe(job: any, sourceLabel: string, fetchImpl: typeof fetch = fetch): Promise<ProductionAlertResult> {
  const webhookUrl = productionAlertWebhookUrl();
  if (!webhookUrl) return { sent: false, reason: "No Slack webhook configured." };
  try {
    const response = await fetchImpl(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: buildProductionAlertText(job, sourceLabel) }) });
    return { sent: response.ok, reason: response.ok ? "Slack alert sent." : `Slack returned ${response.status}` };
  } catch (error: any) {
    return { sent: false, reason: `Slack alert failed: ${error?.message || "unknown error"}` };
  }
}

/**
 * Review-queue record for a PAID order that produced no production job
 * (no recognisable configurator / canonical line). Nothing is fabricated: the
 * item only names the order and its line titles so staff can create the job
 * manually. Never throws.
 */
export function unrecognizedPaidOrderQueueItem(shop: string, order: any) {
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];
  const titles = lines.map((line: any) => `${line?.title || "line"} x${Number(line?.quantity || 0)}`).slice(0, 10);
  const orderName = String(order?.name || order?.order_number || order?.id || "order");
  return {
    shop,
    source: "shopify_order_unrecognized",
    status: "new",
    reviewLevel: "basic_staff_review",
    customerName: [order?.customer?.first_name, order?.customer?.last_name].filter(Boolean).join(" ") || order?.billing_address?.name || null,
    company: order?.customer?.default_address?.company || order?.billing_address?.company || null,
    email: order?.email || order?.customer?.email || null,
    productFamily: "unrecognized",
    quantity: String(lines.reduce((sum: number, line: any) => sum + Number(line?.quantity || 0), 0)),
    internalNotes: `PAID SHOPIFY ORDER ${orderName} created NO production job: no line matched a configurator / canonical product. Lines: ${titles.join("; ") || "(none)"}. Create the production job manually from the Production Board (manual job) and reference this order.`,
    recommendedStaffAction: "Create the production job manually from the paid order; confirm pricing against the Shopify order before production.",
    createdBy: "orders_paid_webhook",
  };
}
