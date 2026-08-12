// Phase 16E — storefront adapter for the EXISTING owner DTP pricing
// authority. This module deliberately contains NO price numbers: every unit
// price comes from dtp-owner-pricing.server.ts (15C.2 owner selling-price
// ladders, keyed by Spektra vendorSku) via ownerPriceForQuantity. The 45%
// profile margin figure is a legacy template default — the ratified
// authority is the owner ladder (~35-45% realized on landed cost by design).
//
// DTP pouches are VENDOR-FINISHED outsourced products (Spektra):
//   - soft-touch lamination, Silver PET, five colors incl. white, CR zipper,
//     tear notches, 2" gusset are ALL INCLUDED in the vendor cost and are
//     never a customer add-on (owner 15C rule recorded on every vendor row)
//   - therefore the storefront exposes NO holographic / CR / finish
//     surcharges — size + quantity are the only price axes
//   - $85/PO freight and the first design's art are embedded in the ladder
//     (quote-side pass-through handling stays quote-only)
//   - no in-house Mimaki/Roland print math applies.

import {
  DTP_LADDER_QUANTITIES,
  DTP_PRICING_ENGINE_VERSION,
  ownerPriceForQuantity,
} from "./dtp-owner-pricing.server";

export const DTP_STOREFRONT_VERSION = "16E-dtp-canonical";
export const DTP_STOREFRONT_ENGINE = "canonical-dtp-pricing/16E";

export const DTP_STOREFRONT_MIN_QTY = 1000;
// Online orders cap at the top owner ladder tier; larger runs are quoted
// (freight/PO assumptions need human review beyond this point).
export const DTP_STOREFRONT_MAX_QTY = 10000;
export const DTP_QUANTITY_OPTIONS = [...DTP_LADDER_QUANTITIES];

// Customer-facing included-spec labels (informational single-option lists —
// there is nothing to choose because everything is included).
export const DTP_MATERIAL_OPTIONS = ["Soft-Touch Lamination — Included"];
export const DTP_FINISH_OPTIONS = ["Full-Color Print + CR Zipper + Tear Notch — Included"];
export const DTP_FINISH_LABEL = DTP_FINISH_OPTIONS[0];

export type DtpLaunchInfo = { sku: string; size: string };

export const DTP_LAUNCH_TYPE_INFO: Record<string, DtpLaunchInfo> = {
  dtp_4x5x2: { sku: "spektra-dtp-4x5x2", size: "4x5x2" },
  dtp_5x4x2: { sku: "spektra-dtp-5x4x2", size: "5x4x2" },
  dtp_6x5x2: { sku: "spektra-dtp-6x5x2", size: "6x5x2" },
  dtp_8x5x2: { sku: "spektra-dtp-8x5x2", size: "8x5x2" },
};

export function dtpLaunchInfoForType(productType: string): DtpLaunchInfo | null {
  return DTP_LAUNCH_TYPE_INFO[String(productType || "")] ?? null;
}

export type DtpPriceResult =
  | {
      ok: true;
      sku: string;
      size: string;
      quantity: number;
      tierUsed: number;
      unitPrice: number;
      orderTotal: number;
      version: string;
      engine: string;
    }
  | { ok: false; requestQuote: boolean; reason: string };

function money(value: number) {
  return Math.round(value * 100) / 100;
}

export function priceDtpConfiguration(selection: { productType: string; quantity: number }): DtpPriceResult {
  const info = dtpLaunchInfoForType(selection.productType);
  if (!info) {
    return { ok: false, requestQuote: false, reason: "This pouch size is not available for online pricing yet." };
  }
  const quantity = Math.floor(Number(selection.quantity) || 0);
  if (quantity < DTP_STOREFRONT_MIN_QTY) {
    return { ok: false, requestQuote: false, reason: `Minimum order is ${DTP_STOREFRONT_MIN_QTY.toLocaleString()} pouches (vendor MOQ).` };
  }
  if (quantity > DTP_STOREFRONT_MAX_QTY) {
    return {
      ok: false,
      requestQuote: true,
      reason: `Orders above ${DTP_STOREFRONT_MAX_QTY.toLocaleString()} pouches are quoted individually — please request a volume quote.`,
    };
  }
  const owner = ownerPriceForQuantity(info.sku, quantity);
  if (owner.unitPrice == null || owner.tierUsed == null) {
    // fail closed — never guessed (unknown sku / below-MOQ resolve here too)
    return { ok: false, requestQuote: false, reason: "No owner-approved price is available for this configuration." };
  }
  return {
    ok: true,
    sku: info.sku,
    size: info.size,
    quantity,
    tierUsed: owner.tierUsed,
    unitPrice: owner.unitPrice,
    orderTotal: money(owner.unitPrice * quantity),
    version: DTP_STOREFRONT_VERSION,
    engine: DTP_STOREFRONT_ENGINE,
  };
}

export function dtpPriceBreaks(productType: string): Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> {
  const info = dtpLaunchInfoForType(productType);
  if (!info) return [];
  const breaks: Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> = [];
  for (const quantity of DTP_LADDER_QUANTITIES) {
    const owner = ownerPriceForQuantity(info.sku, quantity);
    if (owner.unitPrice != null) breaks.push({ range: `${quantity}+`, minQty: quantity, maxQty: null, priceEach: owner.unitPrice });
  }
  return breaks;
}

// Hidden `_GSO Canonical` snapshot for DTP lines — family-aware sibling of
// the bag/jar snapshots. Carries the outsourced-supplier classification so
// production mapping never treats these as in-house print work.
export function buildCanonicalDtpLineMetadata(input: {
  productType: string;
  priced: Extract<DtpPriceResult, { ok: true }>;
}): string {
  return JSON.stringify({
    v: DTP_STOREFRONT_VERSION,
    family: "dtp",
    profile: input.productType,
    size: input.priced.size,
    qty: input.priced.quantity,
    finishLabel: DTP_FINISH_LABEL,
    crZipper: true,
    unitPrice: input.priced.unitPrice,
    supplier: "spektra_outsourced",
    ladderSku: input.priced.sku,
    ladderEngine: DTP_PRICING_ENGINE_VERSION,
    engine: DTP_STOREFRONT_ENGINE,
  });
}
