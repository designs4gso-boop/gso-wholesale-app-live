// DTP (Spektra vendor-finished pouch) CATALOG STATUS — 2026-10-06.
//
// Reconciles the ERP's DTP products with the CURRENT public Spektra catalog
// (VENDOR OBSERVED DATA, 2026-10-06) without deleting or remapping anything:
//   current standard: 3.5x4.5x2 (1 g), 4x5x2 (3.5 g), 5x5x2 (7 g), 6x5x2 (14 g), 8x5x2 (28 g)
//   legacy GSO:       4x5x2, 5x4x2, 6x5x2, 8x5x2 (owner ladders + vendor seed)
// 5x4x2 has NO confirmed current catalog match and must not be mapped to
// 4x5x2 or 5x5x2 without owner approval. Client-safe: pure data.

import { SPEKTRA_SIZES, type SpektraSizeKey } from "./spektra-live-cost-book";

export const DTP_CATALOG_VERSION = "dtp-catalog/2026-10-06";

export type DtpCatalogStatus = "CURRENT_STANDARD" | "LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH";

export type DtpCatalogEntry = {
  size: string;
  status: DtpCatalogStatus;
  capacityLabel: string | null;
  /** Existing ERP vendorSku (ladder + vendor seed identity) or null for a size the ERP has not sold before. */
  vendorSku: string | null;
  /** Whether an owner CUSTOMER price ladder exists (dtp-owner-pricing.server.ts). */
  ownerLadder: "EXISTS_2026-07-24" | "NONE_OWNER_DECISION_REQUIRED";
  /** Vendor cost source for NEW calculations. */
  vendorCost: "LIVE_COST_BOOK_2026-10-06" | "LEGACY_SEED_ONLY";
  /**
   * QUOTE cost authority. "LIVE_COST_BOOK" = new quotes cost from the live
   * Spektra book resolved by the exact configuration (owner decision
   * 2026-10-06, 4x5x2 only — the approved ladder was priced on live landed
   * cost). "LEGACY_VENDOR_SEED" = the 15C VendorProduct tiers remain the quote
   * cost until the owner reviews that size.
   */
  quoteCostAuthority: "LIVE_COST_BOOK" | "LEGACY_VENDOR_SEED";
  note: string;
};

export const DTP_CATALOG: DtpCatalogEntry[] = [
  { size: "3.5x4.5x2", status: "CURRENT_STANDARD", capacityLabel: "1 g", vendorSku: null, ownerLadder: "NONE_OWNER_DECISION_REQUIRED", vendorCost: "LIVE_COST_BOOK_2026-10-06", quoteCostAuthority: "LEGACY_VENDOR_SEED", note: "NEW in the current catalog; ERP-ready for costing once the live matrix is loaded; no Shopify product is created by this change." },
  { size: "4x5x2", status: "CURRENT_STANDARD", capacityLabel: "3.5 g", vendorSku: "spektra-dtp-4x5x2", ownerLadder: "EXISTS_2026-07-24", vendorCost: "LIVE_COST_BOOK_2026-10-06", quoteCostAuthority: "LIVE_COST_BOOK", note: "Existing product; OWNER-APPROVED 4x5 ladder 2026-10-06 priced on live landed cost, so new quotes cost from the live book by exact configuration. Legacy seed tiers remain for historical quotes." },
  { size: "5x5x2", status: "CURRENT_STANDARD", capacityLabel: "7 g", vendorSku: null, ownerLadder: "NONE_OWNER_DECISION_REQUIRED", vendorCost: "LIVE_COST_BOOK_2026-10-06", quoteCostAuthority: "LEGACY_VENDOR_SEED", note: "NEW in the current catalog; not a replacement for the legacy 5x4x2." },
  { size: "6x5x2", status: "CURRENT_STANDARD", capacityLabel: "14 g", vendorSku: "spektra-dtp-6x5x2", ownerLadder: "EXISTS_2026-07-24", vendorCost: "LIVE_COST_BOOK_2026-10-06", quoteCostAuthority: "LEGACY_VENDOR_SEED", note: "Existing product; customer ladder OWNER PRICING REVIEW REQUIRED (2026-07-24 ladder still in force)." },
  { size: "8x5x2", status: "CURRENT_STANDARD", capacityLabel: "28 g", vendorSku: "spektra-dtp-8x5x2", ownerLadder: "EXISTS_2026-07-24", vendorCost: "LIVE_COST_BOOK_2026-10-06", quoteCostAuthority: "LEGACY_VENDOR_SEED", note: "Existing product; customer ladder OWNER PRICING REVIEW REQUIRED (2026-07-24 ladder still in force)." },
  { size: "5x4x2", status: "LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH", capacityLabel: null, vendorSku: "spektra-dtp-5x4x2", ownerLadder: "EXISTS_2026-07-24", vendorCost: "LEGACY_SEED_ONLY", quoteCostAuthority: "LEGACY_VENDOR_SEED", note: "No confirmed current Spektra catalog match. Do NOT map to 4x5x2 or 5x5x2 without owner approval; new quotes need a current vendor quote; historical quotes unchanged." },
];

export function dtpCatalogEntry(size: string | null | undefined): DtpCatalogEntry | null {
  const key = String(size || "").toLowerCase().replace(/\s+/g, "");
  return DTP_CATALOG.find((e) => e.size.toLowerCase() === key) ?? null;
}

/** Legacy vendorSku -> current catalog size (only where the size itself is unchanged). */
export function dtpSizeForVendorSku(vendorSku: string | null | undefined): DtpCatalogEntry | null {
  const sku = String(vendorSku || "").toLowerCase();
  return DTP_CATALOG.find((e) => e.vendorSku === sku) ?? null;
}

export function isCurrentSpektraSize(size: string): size is SpektraSizeKey {
  return SPEKTRA_SIZES.some((s) => s.key === size);
}

/**
 * FREIGHT — UNVERIFIED ASSUMPTION. The runtime still applies the historical
 * $85 per Spektra purchase order (product-driven-costing.server.ts
 * SPEKTRA_FREIGHT_PER_PO); this marker exists so every surface labels it
 * honestly instead of calling it verified.
 */
export const SPEKTRA_FREIGHT_ASSUMPTION = {
  amount: 85,
  status: "UNVERIFIED" as const,
  label: "FREIGHT ASSUMPTION — OWNER / VENDOR CONFIRMATION NEEDED",
  note: "Historical $85 flat per Spektra purchase order. The current public site exposes no usable freight; this figure has not been verified and is kept only because existing DTP quoting needs a freight line. Not part of the 2026-10-06 live cost book.",
};

/** The ERP comparable standard configuration (legacy product spec = soft-touch lamination + CR zipper included). Client-safe. */
export const DTP_COMPARABLE_CONFIG = { material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false, skuCount: 1 } as const;
