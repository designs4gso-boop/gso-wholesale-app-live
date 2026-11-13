// 2026-11-13 OWNER RULE — DTP comparison validity for sticker-applied bags.
//
// The volume trigger is unchanged: the requested row reaches a bags-4x5
// market crossover band (2,500+ "mild", 5,000+ "strong"). What changes is
// whether the direct-print (Spektra DTP pouch) comparison is presented as
// EQUIVALENT. A DTP comparison must consider both the TOTAL quantity and the
// quantity PER UNIQUE DESIGN: 3,840 bags over 30 designs is 30 short runs of
// 128, not one 3,840-piece DTP run.
//
// No new per-design cutoff is invented. The comparison is "fully modeled"
// only inside what the existing DTP engine already covers:
//   * extra designs: the vendor extra-SKU rule (SPEKTRA_WHOLESALE_EXTRA_SKU_FEE)
//     is validated at 1 / 2 / 5 / 10 SKUs only (spektra-live-cost-book.ts);
//   * per-SKU minimum: Spektra publishes a 500 minimum run PER SKU
//     (SPEKTRA_COST_BOOK_META.moq) and the cost engine has no charge for runs
//     below it.
// Outside that envelope the comparison is advisory MANUAL REVIEW — never a
// recommendation, never a product switch, never a quote block. Pricing
// engines are not touched: the DTP numbers come from the existing owner
// ladder / priceDtpQuote and the live cost book exactly as before.

import { DTP_COMPARABLE_CONFIG } from "./dtp-catalog";
import { ownerPriceForQuantity, priceDtpQuote } from "./dtp-owner-pricing.server";
import { resolveDtpQuoteCost } from "./dtp-quote-cost-authority.server";
import { SPEKTRA_COST_BOOK_META } from "./spektra-live-cost-book";

export const DTP_COMPARISON_LADDER_SKU = "spektra-dtp-4x5x2";
/** Largest SKU count the vendor extra-SKU rule was validated at (1 / 2 / 5 / 10). */
export const DTP_EXTRA_SKU_RULE_VALIDATED_MAX = 10;
/** Spektra's published minimum run per SKU ("500 minimum run, per SKU"). */
export const DTP_PUBLISHED_MIN_RUN_PER_SKU = 500;

export type DtpComparisonState = "valid_comparison" | "multi_design_review" | "configuration_not_equivalent";

export const DTP_STATE_HEADLINE: Record<DtpComparisonState, string> = {
  valid_comparison: "DTP comparison available.",
  multi_design_review: "DTP MANUAL REVIEW REQUIRED — MULTI-DESIGN JOB",
  configuration_not_equivalent: "DTP comparison not equivalent for requested configuration.",
};

export type DtpEquivalenceCheck = { key: "front_back" | "gloss" | "white" | "material_shape" | "dimensions"; label: string; equivalent: boolean; detail: string };

export type DtpComparisonAdvisory = {
  state: DtpComparisonState;
  headline: string;
  crossover: "mild" | "strong";
  totalQuantity: number;
  uniqueDesigns: number;
  quantityPerDesign: number;
  currentProduct: string;
  currentConfiguration: string;
  /** True only when the DTP engine models every design's setup / changeover for this job. */
  setupChangeoverModeled: boolean;
  setupChangeoverReasons: string[];
  /** True only when every configuration check is equivalent. */
  finishEquivalent: boolean;
  equivalenceChecks: DtpEquivalenceCheck[];
  message: string;
  /** Advisory only — never switches product, never blocks save / approve / send / production. */
  advisoryOnly: true;
  autoSwitchProduct: false;
  /** Presented as an equivalent price ONLY in the valid_comparison state. */
  comparison: {
    ladderSku: string;
    qty: number;
    tierUsed: number | null;
    unitPrice: number;
    designFees: number;
    total: number;
    trueCost: number | null;
    trueCostStatus: string | null;
  } | null;
  /** The plain single-design ladder figure, shown only as labelled reference outside valid_comparison. */
  singleDesignLadderReference: { unitPrice: number; total: number; tierUsed: number | null } | null;
};

export function quantityPerDesign(totalQuantity: number, designs: number): number {
  const total = Math.max(0, Math.floor(Number(totalQuantity) || 0));
  const n = Math.max(1, Math.floor(Number(designs) || 1));
  return Math.floor(total / n);
}

function isFourByFive(widthIn: number | null, heightIn: number | null): boolean {
  const w = Number(widthIn), h = Number(heightIn);
  if (!(w > 0) || !(h > 0)) return true; // the 4x5 sticker bag default
  return (Math.abs(w - 4) < 0.01 && Math.abs(h - 5) < 0.01) || (Math.abs(w - 5) < 0.01 && Math.abs(h - 4) < 0.01);
}

/** Configuration equivalence vs the ERP comparable DTP pouch (4x5x2, DTP_COMPARABLE_CONFIG). */
export function dtpEquivalenceChecks(input: { faces: number; glossLayers: number; whiteLayers: number; materialName?: string | null; splitBag: boolean; widthIn?: number | null; heightIn?: number | null }): DtpEquivalenceCheck[] {
  const faces = Math.max(1, Math.floor(Number(input.faces) || 1));
  const gloss = Math.max(0, Number(input.glossLayers) || 0);
  const white = Math.max(0, Number(input.whiteLayers) || 0);
  const specialMaterial = /holo|clear|metal|chrome|foil|glitter/i.test(String(input.materialName || ""));
  const checks: DtpEquivalenceCheck[] = [];
  checks.push(faces >= 2
    ? { key: "front_back", label: "Front + Back", equivalent: false, detail: "Two applied labels requested. The DTP cost book has no per-side input, so front + back print coverage on the comparison pouch is not verified." }
    : { key: "front_back", label: "Front only", equivalent: true, detail: "One printed side; the comparison pouch is printed." });
  checks.push(gloss > 0
    ? { key: "gloss", label: `Gloss ×${gloss}`, equivalent: false, detail: `Gloss layer requested; the DTP comparison prices the ${DTP_COMPARABLE_CONFIG.finish} / spot ${DTP_COMPARABLE_CONFIG.spot} pouch, not a gloss finish.` }
    : { key: "gloss", label: "No gloss", equivalent: true, detail: "No gloss layer requested." });
  checks.push(white > 0
    ? { key: "white", label: `White ×${white}`, equivalent: false, detail: `White ink layer requested; the DTP comparison is ${DTP_COMPARABLE_CONFIG.material} film and does not reproduce a white-ink label effect.` }
    : { key: "white", label: "No white", equivalent: true, detail: "No white layer requested." });
  checks.push(input.splitBag
    ? { key: "material_shape", label: "Split Bag blank", equivalent: false, detail: "Split Bag blank with applied labels; the comparison is a 4x5x2 stand-up DTP pouch (different bag shape)." }
    : specialMaterial
      ? { key: "material_shape", label: String(input.materialName), equivalent: false, detail: `Specialty label material; the comparison is ${DTP_COMPARABLE_CONFIG.material} / ${DTP_COMPARABLE_CONFIG.finish}.` }
      : { key: "material_shape", label: "4x5 Sticker Bag", equivalent: true, detail: "Standard 4x5 sticker bag vs the 4x5x2 DTP pouch (the existing approved comparison)." });
  checks.push(input.splitBag
    ? { key: "dimensions", label: "Split Bag label size", equivalent: false, detail: "Split Bag label geometry is not the 4x5 bag face of the comparison pouch." }
    : isFourByFive(input.widthIn ?? null, input.heightIn ?? null)
      ? { key: "dimensions", label: "4x5", equivalent: true, detail: "4x5 matches the 4x5x2 comparison pouch." }
      : { key: "dimensions", label: `${input.widthIn}x${input.heightIn}`, equivalent: false, detail: "Requested size is not the 4x5x2 comparison pouch." });
  return checks;
}

export function qualifyDtpComparison(input: {
  crossover: "mild" | "strong" | null | undefined;
  totalQuantity: number;
  designs: number;
  faces: number;
  glossLayers: number;
  whiteLayers: number;
  materialName?: string | null;
  splitBag: boolean;
  widthIn?: number | null;
  heightIn?: number | null;
  currentProduct: string;
}): DtpComparisonAdvisory | null {
  if (input.crossover !== "mild" && input.crossover !== "strong") return null;
  const totalQuantity = Math.max(0, Math.floor(Number(input.totalQuantity) || 0));
  const uniqueDesigns = Math.max(1, Math.floor(Number(input.designs) || 1));
  const perDesign = quantityPerDesign(totalQuantity, uniqueDesigns);

  // Setup / changeover coverage of the existing DTP engine for THIS job.
  const setupChangeoverReasons: string[] = [];
  if (uniqueDesigns > DTP_EXTRA_SKU_RULE_VALIDATED_MAX) {
    setupChangeoverReasons.push(`${uniqueDesigns} designs exceeds the ${DTP_EXTRA_SKU_RULE_VALIDATED_MAX} SKUs the vendor extra-SKU (setup / changeover) rule was validated at.`);
  }
  if (uniqueDesigns > 1 && perDesign < DTP_PUBLISHED_MIN_RUN_PER_SKU) {
    setupChangeoverReasons.push(`${perDesign.toLocaleString()} per design is below the vendor's published ${DTP_PUBLISHED_MIN_RUN_PER_SKU}-unit minimum run per SKU (${SPEKTRA_COST_BOOK_META.moq.status.replace(/_/g, " ").toLowerCase()}); the DTP cost engine has no charge for short per-design runs.`);
  }
  const setupChangeoverModeled = setupChangeoverReasons.length === 0;

  const equivalenceChecks = dtpEquivalenceChecks(input);
  const finishEquivalent = equivalenceChecks.every((c) => c.equivalent);

  const state: DtpComparisonState = !setupChangeoverModeled ? "multi_design_review" : !finishEquivalent ? "configuration_not_equivalent" : "valid_comparison";

  const ladder = ownerPriceForQuantity(DTP_COMPARISON_LADDER_SKU, totalQuantity);
  const singleDesignLadderReference = ladder.unitPrice != null ? { unitPrice: ladder.unitPrice, total: ladder.unitPrice * totalQuantity, tierUsed: ladder.tierUsed } : null;

  let comparison: DtpComparisonAdvisory["comparison"] = null;
  if (state === "valid_comparison" && ladder.unitPrice != null) {
    const cost = resolveDtpQuoteCost({ vendorSku: DTP_COMPARISON_LADDER_SKU, quantity: totalQuantity, designs: uniqueDesigns, selection: {}, legacy: { totalCost: 0, missing: true, vendorSubtotal: null } });
    const price = priceDtpQuote({ ladderSku: DTP_COMPARISON_LADDER_SKU, quantity: totalQuantity, landedCost: cost.landedCost, missingCost: cost.missing, designs: uniqueDesigns, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 0, override: { phrase: "", reason: "" } });
    comparison = {
      ladderSku: DTP_COMPARISON_LADDER_SKU,
      qty: totalQuantity,
      tierUsed: price.ownerPriceTierUsed,
      unitPrice: price.unitPrice,
      designFees: price.extraDesignFees,
      total: price.customerTotal,
      trueCost: cost.missing ? null : cost.landedCost,
      trueCostStatus: cost.status,
    };
  }

  const designsText = `${uniqueDesigns} unique design${uniqueDesigns === 1 ? "" : "s"} at ${perDesign.toLocaleString()} units per design`;
  const configurationText = equivalenceChecks.map((c) => c.label).join(" · ");
  const message = state === "multi_design_review"
    ? `Direct-print comparison is not considered equivalent for this job. This order contains ${designsText}. The current DTP comparison does not fully model per-design setup/changeover burden. Review DTP manually before switching production method. ${input.currentProduct} remains ready to quote.`
    : state === "configuration_not_equivalent"
      ? `The DTP comparison pouch does not reproduce the requested configuration (${equivalenceChecks.filter((c) => !c.equivalent).map((c) => c.label).join(", ")}). Review DTP manually before switching production method. ${input.currentProduct} remains ready to quote.`
      : `Compare a direct-print (Spektra DTP pouch) quote before finalizing — ${designsText}; per-design setup is in the DTP engine. No automatic product conversion.`;

  return {
    state,
    headline: DTP_STATE_HEADLINE[state],
    crossover: input.crossover,
    totalQuantity,
    uniqueDesigns,
    quantityPerDesign: perDesign,
    currentProduct: input.currentProduct,
    currentConfiguration: configurationText,
    setupChangeoverModeled,
    setupChangeoverReasons,
    finishEquivalent,
    equivalenceChecks,
    message,
    advisoryOnly: true,
    autoSwitchProduct: false,
    comparison,
    singleDesignLadderReference,
  };
}
