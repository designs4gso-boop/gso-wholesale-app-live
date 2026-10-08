// DTP owner selling-price ladders + pricing safeguards (Patch 15C.2).
// THE centralized server-side registry for DTP CUSTOMER pricing — owner
// selling prices are NOT vendor costs (VendorProduct/VendorProductTier stay
// vendor-cost-only) and are never hardcoded in route JSX. Product Setup
// renders these rules today (read-only); making them owner-editable without
// code is the documented next step (move this table into ErpAdminSetting or a
// dedicated model once the owner wants in-app editing).
//
// Source: completed DTP pricing study (owner-approved 2026-07-24), superseded
// for 4x5x2 by the OWNER-APPROVED 4x5 DTP ladder of 2026-10-06 (Design &
// Customize = controlling 1:1 benchmark; see dtp-market-benchmark.ts).

import { OVERRIDE_PHRASE } from "./calculator-emergency.server";
import { DTP_MARKET_BENCHMARK_KEY } from "./dtp-market-benchmark";
import { OWNER_STANDARDS } from "./owner-standards";

export const DTP_PRICING_ENGINE_VERSION = "15C.2-dtp-owner-price-ladders";
export const DTP_PRICING_SOURCE = "DTP pricing study (owner-approved 2026-07-24)";
export const DTP_4X5_PRICING_SOURCE = "OWNER_APPROVED_DTP_4X5_2026_10_06";
/** 2026-10-07: the four remaining current sizes + the 25,000 tier for every current size. */
export const DTP_CURRENT_LADDERS_PRICING_SOURCE = "OWNER_APPROVED_DTP_LADDERS_2026_10_07";
export const DTP_OWNER_REVIEW_REQUIRED = "OWNER PRICING REVIEW REQUIRED";
export const DTP_REQUEST_VENDOR_QUOTE = "REQUEST CURRENT VENDOR QUOTE";
/** Highest approved customer tier. Above it there is no customer price: REQUEST CURRENT VENDOR QUOTE (owner 2026-10-07). */
export const DTP_MAX_APPROVED_QUANTITY = 25000;

export type DtpLadderStatus = "OWNER_APPROVED" | "OWNER_PRICING_REVIEW_REQUIRED";
export type DtpLadderSource = {
  pricingSource: string;
  approvedOn: string;
  status: DtpLadderStatus;
  marketBenchmark: string | null;
  /** Quantities at or above this need a separate owner decision (no invented price). */
  reviewRequiredFromQuantity: number | null;
  /** Quantities ABOVE this have no customer price: REQUEST CURRENT VENDOR QUOTE (never an extended vendor row). */
  requestQuoteAboveQuantity: number | null;
  note: string;
};

// Per-ladder provenance. Only 4x5x2 is the OWNER-APPROVED 2026-10-06 anchor;
// the 2026-07-24 ladders for the other sizes stay in force for quoting but
// are flagged OWNER PRICING REVIEW REQUIRED and are never derived from 4x5x2.
export const DTP_LADDER_SOURCES: Record<string, DtpLadderSource> = {
  // OWNER APPROVED 2026-10-06 (1,000–10,000) + 2026-10-07 (25,000 tier). Design & Customize = benchmark of record.
  "spektra-dtp-4x5x2": { pricingSource: DTP_4X5_PRICING_SOURCE, approvedOn: "2026-10-06 (25,000 tier 2026-10-07)", status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: DTP_MAX_APPROVED_QUANTITY, note: "Standard 4x5x2 DTP commercial anchor. Above 25,000: REQUEST CURRENT VENDOR QUOTE." },
  // OWNER APPROVED 2026-10-07 — derived from the real live Spektra landed-cost delta vs the 4x5x2 anchor (docs/GSO_DTP_FINAL_PRICING_REVIEW_2026-10-07.md); never a size multiplier.
  "spektra-dtp-3.5x4.5x2": { pricingSource: DTP_CURRENT_LADDERS_PRICING_SOURCE, approvedOn: "2026-10-07", status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: DTP_MAX_APPROVED_QUANTITY, note: "Anchored on 4x5x2 by landed-cost delta; exact-size competitor NOT CURRENTLY VERIFIED." },
  "spektra-dtp-5x5x2": { pricingSource: DTP_CURRENT_LADDERS_PRICING_SOURCE, approvedOn: "2026-10-07", status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: DTP_MAX_APPROVED_QUANTITY, note: "Anchored on 4x5x2 by landed-cost delta; exact-size competitor NOT CURRENTLY VERIFIED." },
  "spektra-dtp-6x5x2": { pricingSource: DTP_CURRENT_LADDERS_PRICING_SOURCE, approvedOn: "2026-10-07", status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: DTP_MAX_APPROVED_QUANTITY, note: "Replaces the 2026-07-24 ladder ($1.84 / $1.04 / $0.96 / $0.81 / $0.81) for NEW quotes; historical quotes unchanged." },
  "spektra-dtp-8x5x2": { pricingSource: DTP_CURRENT_LADDERS_PRICING_SOURCE, approvedOn: "2026-10-07", status: "OWNER_APPROVED", marketBenchmark: DTP_MARKET_BENCHMARK_KEY, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: DTP_MAX_APPROVED_QUANTITY, note: "Replaces the 2026-07-24 ladder ($2.05 / $1.23 / $1.23 / $1.05 / $1.05) for NEW quotes; historical quotes unchanged." },
  // LEGACY: 5x4x2 has no current catalog match — MANUAL / VENDOR REVIEW for new quotes (owner 2026-10-07); the July ladder is kept for historical display only.
  "spektra-dtp-5x4x2": { pricingSource: DTP_PRICING_SOURCE, approvedOn: "2026-07-24", status: "OWNER_PRICING_REVIEW_REQUIRED", marketBenchmark: null, reviewRequiredFromQuantity: null, requestQuoteAboveQuantity: null, note: "LEGACY / NO CURRENT STANDARD CATALOG MATCH — new quotes need MANUAL / VENDOR REVIEW; never mapped to another size." },
};

export function dtpLadderSource(ladderSku: string): DtpLadderSource | null {
  return DTP_LADDER_SOURCES[String(ladderSku || "").toLowerCase()] ?? null;
}

// OWNER-APPROVED 1,000-UNIT ACQUISITION EXCEPTIONS (4x5x2 2026-10-06; the four
// other current sizes 2026-10-07): the 1,000 tier of each CURRENT DTP size is a
// competitive / acquisition tier allowed below the normal $500 GP target with
// a $350 minimum. They apply ONLY to these ladders at the 1,000 tier — 2,500+
// and every other product keep the normal $500 protection.
export const DTP_ACQUISITION_TIER_EXCEPTIONS: Record<string, { tier: number; minJobProfit: number; label: string; approvedOn: string }> = {
  "spektra-dtp-4x5x2": { tier: 1000, minJobProfit: 350, label: "DTP 1,000-unit competitive/acquisition tier (owner exception 2026-10-06)", approvedOn: "2026-10-06" },
  "spektra-dtp-3.5x4.5x2": { tier: 1000, minJobProfit: 350, label: "DTP 1,000-unit competitive/acquisition tier (owner exception 2026-10-07)", approvedOn: "2026-10-07" },
  "spektra-dtp-5x5x2": { tier: 1000, minJobProfit: 350, label: "DTP 1,000-unit competitive/acquisition tier (owner exception 2026-10-07)", approvedOn: "2026-10-07" },
  "spektra-dtp-6x5x2": { tier: 1000, minJobProfit: 350, label: "DTP 1,000-unit competitive/acquisition tier (owner exception 2026-10-07)", approvedOn: "2026-10-07" },
  "spektra-dtp-8x5x2": { tier: 1000, minJobProfit: 350, label: "DTP 1,000-unit competitive/acquisition tier (owner exception 2026-10-07)", approvedOn: "2026-10-07" },
};

export function dtpAcquisitionTierException(ladderSku: string, tierUsed: number | null) {
  const rule = DTP_ACQUISITION_TIER_EXCEPTIONS[String(ladderSku || "").toLowerCase()];
  return rule && tierUsed != null && tierUsed === rule.tier ? rule : null;
}

// Owner ladder quantities = the commercial steps (owner 2026-10-07):
// 1,000–2,499 / 2,500–4,999 / 5,000–9,999 / 10,000–24,999 / exactly 25,000.
// Above 25,000: REQUEST CURRENT VENDOR QUOTE. Never interpolated.
export const DTP_LADDER_QUANTITIES = [1000, 2500, 5000, 10000, 25000];

// Owner CUSTOMER selling prices per unit, keyed by the stable vendorSku so a
// mislabeled product NAME can never pull the wrong ladder (the pricing study
// found a historical 5x4x2-priced-as-4x5x2 example — sku is the identity).
export const DTP_OWNER_PRICE_LADDERS: Record<string, Record<number, number>> = {
  // OWNER APPROVED — 4x5x2 2026-10-06 (25,000 added 2026-10-07); the other four current sizes 2026-10-07.
  // Steps: 1,000–2,499 / 2,500–4,999 / 5,000–9,999 / 10,000–24,999 / 25,000 exactly; above 25,000 = REQUEST CURRENT VENDOR QUOTE.
  "spektra-dtp-3.5x4.5x2": { 1000: 1.3, 2500: 0.7, 5000: 0.45, 10000: 0.36, 25000: 0.29 },
  "spektra-dtp-4x5x2": { 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 },
  "spektra-dtp-5x5x2": { 1000: 1.35, 2500: 0.75, 5000: 0.49, 10000: 0.41, 25000: 0.35 },
  "spektra-dtp-6x5x2": { 1000: 1.4, 2500: 0.78, 5000: 0.54, 10000: 0.46, 25000: 0.4 },
  "spektra-dtp-8x5x2": { 1000: 1.5, 2500: 0.86, 5000: 0.65, 10000: 0.59, 25000: 0.52 },
  // LEGACY 5x4x2 (2026-07-24) — historical display only; new quotes are MANUAL / VENDOR REVIEW.
  "spektra-dtp-5x4x2": { 1000: 1.76, 2500: 0.97, 5000: 0.86, 7500: 0.72, 10000: 0.71 },
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

// Highest-REACHED owner tier THAT HAS A PRICE (same step semantics as vendor
// tiers — never interpolated). 1,500 -> 1,000 price; 3,000 -> 2,500; a ladder
// without a 7,500 price steps 7,500 to its 5,000 price. Quantities at or above
// a ladder's reviewRequiredFromQuantity (4x5x2: 25,000) return NO price with
// reviewRequired set — an owner price is never invented there.
export function ownerPriceForQuantity(ladderSku: string, quantity: number): { tierUsed: number | null; unitPrice: number | null; reviewRequired?: string } {
  const key = String(ladderSku || "").toLowerCase();
  const ladder = DTP_OWNER_PRICE_LADDERS[key];
  if (!ladder) return { tierUsed: null, unitPrice: null };
  const source = DTP_LADDER_SOURCES[key];
  if (source?.requestQuoteAboveQuantity != null && quantity > source.requestQuoteAboveQuantity) {
    return { tierUsed: null, unitPrice: null, reviewRequired: `${DTP_REQUEST_VENDOR_QUOTE} — ${quantity.toLocaleString()} units is above the ${source.requestQuoteAboveQuantity.toLocaleString()} approved tier (no customer price beyond the 25,000 vendor row)` };
  }
  if (source?.reviewRequiredFromQuantity != null && quantity >= source.reviewRequiredFromQuantity) {
    return { tierUsed: null, unitPrice: null, reviewRequired: `${DTP_OWNER_REVIEW_REQUIRED} — ${key} at ${source.reviewRequiredFromQuantity.toLocaleString()}+ units has no approved customer price yet` };
  }
  let tierUsed: number | null = null;
  for (const tier of DTP_LADDER_QUANTITIES) if (quantity >= tier && ladder[tier] != null) tierUsed = tier;
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
  /** Provenance recorded with every quote (2026-10-06). */
  pricingSource: string;
  ladderStatus: DtpLadderStatus | null;
  marketBenchmark: string | null;
  commercialPolicy: string;
  acquisitionTierException: { tier: number; minJobProfit: number; label: string } | null;
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
  const source = dtpLadderSource(input.ladderSku);
  // 2026-10-06: the owner acquisition-tier exception lowers ONLY the job-profit
  // target for the named ladder + tier (4x5x2 x 1,000 -> $350). The hard
  // margin floor and the $350 absolute floor are unchanged; 2,500+ and every
  // other ladder keep the $500 target.
  const exception = dtpAcquisitionTierException(input.ladderSku, ladder.tierUsed);
  const minJobProfit = exception ? exception.minJobProfit : DTP_MIN_JOB_PROFIT;

  const statusReasons: string[] = [];
  let status: DtpQuoteStatus = "READY";
  const overrideSatisfied = input.override.phrase === OVERRIDE_PHRASE && input.override.reason.trim().length >= 5;
  let overrideRequired = false;
  if (input.missingCost || ladder.unitPrice == null && customUnitPrice == null) {
    status = "BLOCKED";
    statusReasons.push(input.missingCost ? "Missing vendor/component cost" : ladder.reviewRequired ?? "No owner price ladder for this product and no custom price");
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
    if (grossProfit < minJobProfit) {
      overrideRequired = true;
      statusReasons.push(`Gross profit $${grossProfit.toFixed(2)} below the $${minJobProfit} job target (strategic floor $${DTP_STRATEGIC_MIN_JOB_PROFIT})`);
    }
    if (exception && !overrideRequired) {
      statusReasons.push(`${exception.label}: $${exception.minJobProfit}+ gross-profit target applies to this tier only (normal $${DTP_MIN_JOB_PROFIT} protection unchanged elsewhere)`);
    }
    if (overrideRequired) {
      status = "OWNER OVERRIDE REQUIRED";
    } else if (grossMarginPct < DTP_MARGIN_WARNING_TARGET_PCT) {
      // 15F.0-FINAL: a normal owner-ladder quote that MEETS the DTP hard floor
      // and the $500 job-profit target is READY — the generic 40% target is an
      // INFORMATIONAL note, never routine owner review. Floors, the $500/$350
      // profit rules, and every override path above are unchanged.
      statusReasons.push(`Note: below the ${DTP_MARGIN_WARNING_TARGET_PCT}% margin target (meets the ${hardFloorPct}% DTP floor and the $${minJobProfit} profit target)`);
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
    minJobProfit,
    strategicMinJobProfit: DTP_STRATEGIC_MIN_JOB_PROFIT,
    status,
    statusReasons,
    overrideRequired,
    overrideSatisfied,
    overrideReason: overrideSatisfied ? input.override.reason.trim() : null,
    pricingSource: customUnitPrice != null ? `OWNER_CUSTOM_PRICE (ladder: ${source?.pricingSource ?? "none"})` : source?.pricingSource ?? "NO_OWNER_LADDER",
    ladderStatus: source?.status ?? null,
    marketBenchmark: source?.marketBenchmark ?? null,
    commercialPolicy: exception
      ? `${exception.label}; hard floor ${hardFloorPct}%; GP target $${exception.minJobProfit}; absolute floor $${DTP_STRATEGIC_MIN_JOB_PROFIT}`
      : `Standard DTP protection: hard floor ${hardFloorPct}%; GP target $${DTP_MIN_JOB_PROFIT}; absolute floor $${DTP_STRATEGIC_MIN_JOB_PROFIT}`,
    acquisitionTierException: exception ? { tier: exception.tier, minJobProfit: exception.minJobProfit, label: exception.label } : null,
  };
}

// Sanity note (documented, not enforced): internal owner art cost stays
// OWNER_STANDARDS.artSetupPerDesign ($8.3333) per design for EVERY design —
// the customer fee above is revenue policy, not cost.
export const DTP_INTERNAL_ART_COST_PER_DESIGN = OWNER_STANDARDS.artSetupPerDesign.value;
