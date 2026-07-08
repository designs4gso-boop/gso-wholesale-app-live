// Customer tier registry. Deliberately a validated string list instead of a
// Prisma enum so future tiers/config (for example per-tier margin floors) are
// app-level changes, not database enum migrations. Client-safe module.
export const CUSTOMER_TIERS = [
  { value: "standard", label: "Standard" },
  { value: "wholesale", label: "Wholesale" },
  { value: "vip", label: "VIP" },
  { value: "distributor", label: "Distributor" },
  { value: "house_account", label: "House Account" },
  { value: "custom", label: "Custom" },
] as const;

export type CustomerTier = (typeof CUSTOMER_TIERS)[number]["value"];

export function isCustomerTier(value: unknown): value is CustomerTier {
  return CUSTOMER_TIERS.some((tier) => tier.value === value);
}

export function customerTierDisplayLabel(tier: unknown, customLabel?: string | null) {
  if (tier === "custom") {
    const label = String(customLabel || "").trim();
    return label || "Custom";
  }

  const match = CUSTOMER_TIERS.find((entry) => entry.value === tier);
  return match ? match.label : "Standard";
}
