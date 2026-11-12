// 2026-11-12 OWNER DECISION — customer status notifications (FOUNDATION ONLY).
//
// Future channels: EMAIL + SMS. Events: proof ready, payment required, in
// production, ready for pickup, shipped. No provider or credentials exist, so
// NOTHING is ever sent: every plan returns send=false with the reason. A
// provider adapter plugs in later behind owner-configured preferences
// (NotificationPreference table in the staged migration 20261112090000).
// Messages never contain internal cost, profit or margin.

export const CUSTOMER_NOTIFICATION_EVENTS = [
  { key: "proof_ready", label: "Proof ready", trigger: "proof sent to the customer for approval" },
  { key: "payment_required", label: "Payment required", trigger: "approved quote awaiting deposit / balance payment" },
  { key: "in_production", label: "In production", trigger: "paid job moves into production" },
  { key: "ready_for_pickup", label: "Ready for pickup", trigger: "job QC-passed and staged for customer pickup" },
  { key: "shipped", label: "Shipped", trigger: "shipment record saved (carrier / tracking)" },
] as const;
export type CustomerNotificationEvent = (typeof CUSTOMER_NOTIFICATION_EVENTS)[number]["key"];
export const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type CustomerNotificationChannel = (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number];

export type NotificationProviderStatus = { email: string | null; sms: string | null };
/** No provider is connected (owner has not chosen / supplied credentials). */
export const NOTIFICATION_PROVIDERS: NotificationProviderStatus = { email: null, sms: null };

export type NotificationPlan = { send: false; event: CustomerNotificationEvent; channel: CustomerNotificationChannel; reason: "NO_PROVIDER_CONFIGURED" | "PREFERENCE_DISABLED" | "UNKNOWN_EVENT" };

/** Always a non-sending plan until a provider is connected AND the preference is enabled. */
export function planCustomerNotification(event: string, channel: CustomerNotificationChannel, preferenceEnabled: boolean, providers: NotificationProviderStatus = NOTIFICATION_PROVIDERS): NotificationPlan {
  const known = CUSTOMER_NOTIFICATION_EVENTS.find((e) => e.key === event);
  if (!known) return { send: false, event: event as CustomerNotificationEvent, channel, reason: "UNKNOWN_EVENT" };
  if (!providers[channel]) return { send: false, event: known.key, channel, reason: "NO_PROVIDER_CONFIGURED" };
  return { send: false, event: known.key, channel, reason: preferenceEnabled ? "NO_PROVIDER_CONFIGURED" : "PREFERENCE_DISABLED" };
}
