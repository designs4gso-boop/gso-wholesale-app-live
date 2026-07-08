import { describe, expect, it } from "vitest";

import {
  CUSTOMER_TIERS,
  customerTierDisplayLabel,
  isCustomerTier,
  tierRule,
} from "../app/lib/customer-tiers";

describe("CUSTOMER_TIERS registry", () => {
  it("contains exactly the six approved tiers with standard first", () => {
    expect(CUSTOMER_TIERS.map((tier) => tier.value)).toEqual([
      "standard",
      "wholesale",
      "vip",
      "distributor",
      "house_account",
      "custom",
    ]);
    expect(CUSTOMER_TIERS[0].value).toBe("standard");
  });

  it("has a display label for every tier", () => {
    for (const tier of CUSTOMER_TIERS) {
      expect(tier.label.length).toBeGreaterThan(0);
    }
    expect(CUSTOMER_TIERS.find((tier) => tier.value === "house_account")?.label).toBe("House Account");
  });
});

describe("isCustomerTier", () => {
  it("accepts all approved tier values", () => {
    for (const tier of CUSTOMER_TIERS) {
      expect(isCustomerTier(tier.value)).toBe(true);
    }
  });

  it("rejects unknown, empty, and non-string values", () => {
    expect(isCustomerTier("gold")).toBe(false);
    expect(isCustomerTier("")).toBe(false);
    expect(isCustomerTier(null)).toBe(false);
    expect(isCustomerTier(undefined)).toBe(false);
    expect(isCustomerTier(42)).toBe(false);
    expect(isCustomerTier("Standard")).toBe(false);
  });
});

describe("tier rules (Patch 9B, behavior frozen)", () => {
  it("every tier has a margin floor of exactly 40", () => {
    for (const tier of CUSTOMER_TIERS) {
      expect(tier.marginFloorPct).toBe(40);
    }
  });

  it("manualTermsOnly is true for exactly house_account and custom", () => {
    const manualTiers = CUSTOMER_TIERS.filter((tier) => tier.manualTermsOnly).map((tier) => tier.value);
    expect(manualTiers).toEqual(["house_account", "custom"]);
  });

  it("tierRule returns the matching rule", () => {
    expect(tierRule("vip").value).toBe("vip");
    expect(tierRule("house_account").manualTermsOnly).toBe(true);
    expect(tierRule("distributor").marginFloorPct).toBe(40);
  });

  it("tierRule falls back to standard for unknown values", () => {
    expect(tierRule("gold").value).toBe("standard");
    expect(tierRule(null).value).toBe("standard");
    expect(tierRule(undefined).value).toBe("standard");
  });
});

describe("customerTierDisplayLabel", () => {
  it("returns registry labels for known tiers", () => {
    expect(customerTierDisplayLabel("standard")).toBe("Standard");
    expect(customerTierDisplayLabel("vip")).toBe("VIP");
    expect(customerTierDisplayLabel("house_account")).toBe("House Account");
  });

  it("uses the custom label for the custom tier and falls back to Custom", () => {
    expect(customerTierDisplayLabel("custom", "Net-30 Partner")).toBe("Net-30 Partner");
    expect(customerTierDisplayLabel("custom", "   ")).toBe("Custom");
    expect(customerTierDisplayLabel("custom", null)).toBe("Custom");
  });

  it("falls back to Standard for unknown tiers", () => {
    expect(customerTierDisplayLabel("gold")).toBe("Standard");
    expect(customerTierDisplayLabel(null)).toBe("Standard");
  });
});
