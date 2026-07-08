// Customer tier registry. Deliberately a validated string list instead of a
// Prisma enum so future tiers/config (for example per-tier margin floors) are
// app-level changes, not database enum migrations. Client-safe module.
// Tier rules are policy: margin floors and terms flags change only via a
// reviewed code diff, never via runtime data. All floors are 40 by owner
// decision; lowering any tier's floor requires explicit owner approval.
// No discount fields exist yet on purpose.
export const CUSTOMER_TIERS = [
  { value: "standard", label: "Standard", marginFloorPct: 40, manualTermsOnly: false },
  { value: "wholesale", label: "Wholesale", marginFloorPct: 40, manualTermsOnly: false },
  { value: "vip", label: "VIP", marginFloorPct: 40, manualTermsOnly: false },
  { value: "distributor", label: "Distributor", marginFloorPct: 40, manualTermsOnly: false },
  { value: "house_account", label: "House Account", marginFloorPct: 40, manualTermsOnly: true },
  { value: "custom", label: "Custom", marginFloorPct: 40, manualTermsOnly: true },
] as const;

export type CustomerTier = (typeof CUSTOMER_TIERS)[number]["value"];
export type CustomerTierRule = (typeof CUSTOMER_TIERS)[number];

export function tierRule(tier: unknown): CustomerTierRule {
  return CUSTOMER_TIERS.find((entry) => entry.value === tier) || CUSTOMER_TIERS[0];
}

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
