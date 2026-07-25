// DTP owner selling-price ladders + pricing safeguards (Patch 15C.2).
// THE centralized server-side registry for DTP CUSTOMER pricing — owner
// selling prices are NOT vendor costs (VendorProduct/VendorProductTier stay
// vendor-cost-only) and are never hardcoded in route JSX. Product Setup
// renders these rules today (read-only); making them owner-editable without
// code is the documented next step (move this table into ErpAdminSetting or a
// dedicated model once the owner wants in-app editing).
//
// Source: completed DTP pricing study (owner-approved 2026-07-24).

import { OVERRIDE_PHRASE } from "./calculator-emergency.server";
import { OWNER_STANDARDS } from "./owner-standards";

export const DTP_PRICING_ENGINE_VERSION = "15C.2-dtp-owner-price-ladders";
export const DTP_PRICING_SOURCE = "DTP pricing study (owner-approved 2026-07-24)";

// Owner ladder quantities (vendor tiers stop at 7,500; the ladder adds 10,000).
export const DTP_LADDER_QUANTITIES = [1000, 2500, 5000, 7500, 10000];

// Owner CUSTOMER selling prices per unit, keyed by the stable vendorSku so a
// mislabeled product NAME can never pull the wrong ladder (the pricing study
// found a historical 5x4x2-priced-as-4x5x2 example — sku is the identity).
export const DTP_OWNER_PRICE_LADDERS: Record<string, Record<number, number>> = {
  "spektra-dtp-4x5x2": { 1000: 1.67, 2500: 0.88, 5000: 0.74, 7500: 0.61, 10000: 0.6 },
  "spektra-dtp-5x4x2": { 1000: 1.76, 2500: 0.97, 5000: 0.86, 7500: 0.72, 10000: 0.71 },
  "spektra-dtp-6x5x2": { 1000: 1.84, 2500: 1.04, 5000: 0.96, 7500: 0.81, 10000: 0.81 },
  "spektra-dtp-8x5x2": { 1000: 2.05, 2500: 1.23, 5000: 1.23, 7500: 1.05, 10000: 1.05 },
};

// DTP safeguards (owner study): 40% stays a visible WARNING target, not a
// hard blocker. Hard margin floors by quantity band; job-profit rules.
export const DTP_MARGIN_WARNING_TARGET_PCT = 40;
export const DTP_HARD_FLOOR_BANDS = [
  { minQty: 1000, maxQty: 2499, floorPct: 30 },
  { minQty: 2500, maxQty: 4999, floorPct: 35 },
  { minQty: 5000, maxQty: null as number | null, floorPct: 38 },
];
export const DTP_MIN_JOB_PROFIT = 500; // standard minimum
export const DTP_STRATEGIC_MIN_JOB_PROFIT = 350; // absolute owner-exception floor

// Customer-facing additional-design fees (first production-ready design is
// included). Internal cost still carries EVERY design at the owner art rate.
export const DTP_EXTRA_DESIGN_FEES = [
  { minQty: 1000, maxQty: 2499, feePerDesign: 25 },
  { minQty: 2500, maxQty: 4999, feePerDesign: 20 },
  { minQty: 5000, maxQty: null as number | null, feePerDesign: 15 },
];

export function dtpHardFloorPct(quantity: number): number {
  const band = DTP_HARD_FLOOR_BANDS.find((row) => quantity >= row.minQty && (row.maxQty == null || quantity <= row.maxQty));
  return band ? band.floorPct : DTP_HARD_FLOOR_BANDS[0].floorPct;
}

export function dtpExtraDesignFeeEach(quantity: number): number {
  const band = DTP_EXTRA_DESIGN_FEES.find((row) => quantity >= row.minQty && (row.maxQty == null || quantity <= row.maxQty));
  return band ? band.feePerDesign : DTP_EXTRA_DESIGN_FEES[0].feePerDesign;
}

// Highest-REACHED owner tier (same step semantics as vendor tiers — never
// interpolated). 1,500 -> 1,000 price; 3,000 -> 2,500; above 10,000 -> 10,000.
export function ownerPriceForQuantity(ladderSku: string, quantity: number): { tierUsed: number | null; unitPrice: number | null } {
  const ladder = DTP_OWNER_PRICE_LADDERS[String(ladderSku || "").toLowerCase()];
  if (!ladder) return { tierUsed: null, unitPrice: null };
  let tierUsed: number | null = null;
  for (const tier of DTP_LADDER_QUANTITIES) if (quantity >= tier) tierUsed = tier;
  if (tierUsed == null) return { tierUsed: null, unitPrice: null }; // below MOQ — blocked elsewhere
  return { tierUsed, unitPrice: ladder[tierUsed] ?? null };
}

export type DtpQuoteStatus = "READY" | "WARNING — OWNER REVIEW" | "OWNER OVERRIDE REQUIRED" | "BLOCKED";

export type DtpPriceQuote = {
  ladderSku: string;
  quantity: number;
  ownerPriceTierUsed: number | null;
  defaultOwnerUnitPrice: number | null;
  customUnitPrice: number | null;
  unitPrice: number; // custom (owner-authorized) or default ladder price
  customerBaseSubtotal: number;
  extraDesignCount: number;
  extraDesignFeeEach: number;
  extraDesignFees: number;
  designFeeWaived: boolean;
  freightTreatment: "embedded" | "pass_through";
  customerFreight: number;
  customerTotal: number;
  landedCost: number;
  grossProfit: number;
  grossMarginPct: number;
  marginWarningTargetPct: number;
  hardFloorPct: number;
  minJobProfit: number;
  strategicMinJobProfit: number;
  status: DtpQuoteStatus;
  statusReasons: string[];
  overrideRequired: boolean;
  overrideSatisfied: boolean;
  overrideReason: string | null;
};

// ONE pricing function for loader AND save — landed cost comes from the
// product-driven engine server-side (vendor tier + ALL-designs art + $85
// freight); nothing posted by the client is trusted.
export function priceDtpQuote(input: {
  ladderSku: string;
  quantity: number;
  landedCost: number;
  missingCost: boolean;
  designs: number;
  customUnitPrice: number | null;
  repeatOrder: boolean; // exact repeat, no art changes -> customer design fee waived
  passThroughFreight: boolean;
  freightAmount: number;
  override: { phrase: string; reason: string };
}): DtpPriceQuote {
  const quantity = Math.max(1, Math.floor(input.quantity));
  const ladder = ownerPriceForQuantity(input.ladderSku, quantity);
  const customUnitPrice = input.customUnitPrice != null && input.customUnitPrice > 0 ? input.customUnitPrice : null;
  const unitPrice = customUnitPrice ?? ladder.unitPrice ?? 0;
  const designs = Math.max(0, Math.floor(input.designs));
  const extraDesignCount = Math.max(0, designs - 1); // one production-ready design included
  const extraDesignFeeEach = dtpExtraDesignFeeEach(quantity);
  const designFeeWaived = input.repeatOrder;
  const extraDesignFees = designFeeWaived ? 0 : extraDesignCount * extraDesignFeeEach;
  // Freight: internal landed cost ALWAYS includes it. Customer-facing default
  // = embedded in the unit price (no second charge). Pass-through backs the
  // embedded amount OUT of the default-ladder subtotal so the total never
  // recovers freight twice; an owner CUSTOM price is taken as product-only.
  const passThrough = input.passThroughFreight;
  const embeddedBackout = passThrough && customUnitPrice == null ? input.freightAmount : 0;
  const customerBaseSubtotal = Math.max(0, unitPrice * quantity - embeddedBackout);
  const customerFreight = passThrough ? input.freightAmount : 0;
  const customerTotal = customerBaseSubtotal + extraDesignFees + customerFreight;
  const landedCost = input.landedCost;
  const grossProfit = customerTotal - landedCost;
  const grossMarginPct = customerTotal > 0 ? (grossProfit / customerTotal) * 100 : 0;
  const hardFloorPct = dtpHardFloorPct(quantity);

  const statusReasons: string[] = [];
  let status: DtpQuoteStatus = "READY";
  const overrideSatisfied = input.override.phrase === OVERRIDE_PHRASE && input.override.reason.trim().length >= 5;
  let overrideRequired = false;
  if (input.missingCost || ladder.unitPrice == null && customUnitPrice == null) {
    status = "BLOCKED";
    statusReasons.push(input.missingCost ? "Missing vendor/component cost" : "No owner price ladder for this product and no custom price");
  } else if (customerTotal <= landedCost) {
    status = "BLOCKED";
    statusReasons.push("Blocked — selling price below cost");
  } else if (grossProfit < DTP_STRATEGIC_MIN_JOB_PROFIT) {
    status = "BLOCKED";
    statusReasons.push(`Blocked — gross profit $${grossProfit.toFixed(2)} below the $${DTP_STRATEGIC_MIN_JOB_PROFIT} strategic floor`);
  } else {
    if (grossMarginPct < hardFloorPct) {
      overrideRequired = true;
      statusReasons.push(`Below the ${hardFloorPct}% DTP hard margin floor`);
    }
    if (grossProfit < DTP_MIN_JOB_PROFIT) {
      overrideRequired = true;
      statusReasons.push(`Gross profit $${grossProfit.toFixed(2)} below the $${DTP_MIN_JOB_PROFIT} job target (strategic floor $${DTP_STRATEGIC_MIN_JOB_PROFIT})`);
    }
    if (overrideRequired) {
      status = "OWNER OVERRIDE REQUIRED";
    } else if (grossMarginPct < DTP_MARGIN_WARNING_TARGET_PCT) {
      status = "WARNING — OWNER REVIEW";
      statusReasons.push(`Below the ${DTP_MARGIN_WARNING_TARGET_PCT}% margin target (meets the ${hardFloorPct}% DTP floor)`);
    }
  }

  return {
    ladderSku: String(input.ladderSku || "").toLowerCase(),
    quantity,
    ownerPriceTierUsed: ladder.tierUsed,
    defaultOwnerUnitPrice: ladder.unitPrice,
    customUnitPrice,
    unitPrice,
    customerBaseSubtotal,
    extraDesignCount,
    extraDesignFeeEach,
    extraDesignFees,
    designFeeWaived,
    freightTreatment: passThrough ? "pass_through" : "embedded",
    customerFreight,
    customerTotal,
    landedCost,
    grossProfit,
    grossMarginPct,
    marginWarningTargetPct: DTP_MARGIN_WARNING_TARGET_PCT,
    hardFloorPct,
    minJobProfit: DTP_MIN_JOB_PROFIT,
    strategicMinJobProfit: DTP_STRATEGIC_MIN_JOB_PROFIT,
    status,
    statusReasons,
    overrideRequired,
    overrideSatisfied,
    overrideReason: overrideSatisfied ? input.override.reason.trim() : null,
  };
}

// Sanity note (documented, not enforced): internal owner art cost stays
// OWNER_STANDARDS.artSetupPerDesign ($8.3333) per design for EVERY design —
// the customer fee above is revenue policy, not cost.
export const DTP_INTERNAL_ART_COST_PER_DESIGN = OWNER_STANDARDS.artSetupPerDesign.value;
