// 2026-11-19 — internal fulfilment state and the GUARDED Shopify fulfilment
// boundary.
//
// Internal state (ProductionJob.fulfillmentState), independent of Shopify:
//   ready_to_ship -> shipped        pickup_ready -> picked_up
// "Ready" is a floor step (packed and waiting); shipped / picked up are still
// set only by the shipment / pickup record.
//
// Shopify: the app holds NO fulfilment scope today, so nothing is sent to
// Shopify. This file is the one place a future adapter plugs in. Until an
// adapter exists AND the scope is granted AND the switch is on, every job is
// recorded as "disabled" (or "not_applicable" for work that is not a Shopify
// order). The ERP never claims a Shopify fulfilment it did not make.
//
// Pure, client-safe, no Prisma, no network.

export const FULFILLMENT_STATES = ["ready_to_ship", "shipped", "pickup_ready", "picked_up"] as const;
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];

export const FULFILLMENT_STATE_LABEL: Record<FulfillmentState, string> = {
  ready_to_ship: "Ready to ship",
  shipped: "Shipped",
  pickup_ready: "Ready for pickup",
  picked_up: "Picked up",
};

export const FULFILLMENT_READY_KINDS = { ship: "ready_to_ship", pickup: "pickup_ready" } as const;

export function isFulfillmentState(value: unknown): value is FulfillmentState {
  return (FULFILLMENT_STATES as readonly string[]).includes(String(value ?? ""));
}

/** May a job be marked ready? Only an open job that is not already shipped / picked up / completed / cancelled. */
export function readyMarkVerdict(job: { status: unknown; fulfillmentState?: unknown }, kind: unknown): { ok: true; state: FulfillmentState; unchanged: boolean } | { ok: false; message: string } {
  const state = FULFILLMENT_READY_KINDS[String(kind ?? "") as keyof typeof FULFILLMENT_READY_KINDS];
  if (!state) return { ok: false, message: "Choose ready to ship or ready for pickup." };
  const status = String(job.status ?? "").toLowerCase();
  if (["shipped", "picked_up", "completed", "cancelled"].includes(status)) return { ok: false, message: `This job is already ${status.replace(/_/g, " ")}.` };
  return { ok: true, state, unchanged: job.fulfillmentState === state };
}

export const FULFILLMENT_SYNC_STATUSES = ["not_applicable", "disabled", "pending", "synced", "failed"] as const;
export type FulfillmentSyncStatus = (typeof FULFILLMENT_SYNC_STATUSES)[number];

export const FULFILLMENT_SYNC_ENV = "GSO_SHOPIFY_FULFILLMENT_SYNC";
export const FULFILLMENT_WRITE_SCOPE = "write_merchant_managed_fulfillment_orders";

export type FulfillmentSyncDecision = { status: FulfillmentSyncStatus; reason: string | null };

/**
 * Should this job's shipment / pickup be sent to Shopify? Today the answer is
 * never "pending": no adapter is installed. The three gates are checked in
 * order so the stored reason says exactly what is missing.
 */
export function fulfillmentSyncDecision(
  job: { orderGid?: string | null },
  context: { env?: Record<string, string | undefined>; grantedScopes?: string | null; adapterInstalled?: boolean } = {},
): FulfillmentSyncDecision {
  if (!String(job.orderGid || "").trim()) return { status: "not_applicable", reason: null };
  const scopes = String(context.grantedScopes || "").split(",").map((scope) => scope.trim());
  if (!scopes.includes(FULFILLMENT_WRITE_SCOPE)) return { status: "disabled", reason: "The app has no Shopify fulfilment permission. Mark the order fulfilled in Shopify by hand." };
  if (String(context.env?.[FULFILLMENT_SYNC_ENV] || "").trim().toLowerCase() !== "enabled") return { status: "disabled", reason: "Shopify fulfilment sync is switched off. Mark the order fulfilled in Shopify by hand." };
  if (!context.adapterInstalled) return { status: "disabled", reason: "Shopify fulfilment sync is not installed in this release. Mark the order fulfilled in Shopify by hand." };
  return { status: "pending", reason: null };
}

/** The shape a future Shopify adapter implements. The ERP calls it only for a "pending" decision. */
export type FulfillmentSyncRequest = { shop: string; jobId: string; orderGid: string; kind: "shipped" | "picked_up"; carrier?: string | null; trackingNumber?: string | null; idempotencyKey: string };
export type FulfillmentSyncResult = { status: "synced"; shopifyFulfillmentId: string } | { status: "failed"; error: string } | { status: "disabled"; reason: string };
export interface ShopifyFulfillmentAdapter {
  readonly installed: boolean;
  sync(request: FulfillmentSyncRequest): Promise<FulfillmentSyncResult>;
}

/** The only adapter in this release: it does nothing and says so. */
export const DISABLED_FULFILLMENT_ADAPTER: ShopifyFulfillmentAdapter = {
  installed: false,
  async sync() {
    return { status: "disabled", reason: "Shopify fulfilment sync is not installed in this release." };
  },
};

/** What staff are told on the job after a shipment / pickup is recorded. */
export function fulfillmentSyncNote(status: unknown, reason?: unknown): string {
  if (status === "synced") return "Shopify order marked fulfilled.";
  if (status === "failed") return `Shopify was NOT updated: ${String(reason || "the sync failed")}. Mark the order fulfilled in Shopify by hand.`;
  if (status === "pending") return "Waiting to update Shopify.";
  if (status === "disabled") return String(reason || "Shopify was not updated. Mark the order fulfilled in Shopify by hand.");
  return "";
}
