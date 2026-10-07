// DTP QUOTE COST AUTHORITY — OWNER DECISION 2026-10-06.
//
// The owner-approved 4x5x2 ladder ($1.30 / $0.71 / $0.46 / $0.37) was priced
// on the LIVE Spektra landed cost (vendor 0.767363 + art + $85 freight =
// ~$0.8607/unit at 1,000). New 4x5x2 quotes therefore cost from the live
// cost book, resolved by the EXACT configuration (material / finish / spot /
// zipper / top feature / clear gusset / SKU count) — option combinations are
// never flattened into one true cost, so an option with a higher vendor cost
// lowers the computed margin and trips the existing protection instead of
// hiding behind the comparable-spec cost.
//
// Sizes whose catalog entry says LEGACY_VENDOR_SEED keep the 15C engine cost
// (VendorProduct tiers) until the owner reviews them. Historical snapshots
// are never recomputed. Freight stays the $85 UNVERIFIED assumption.

import { DTP_COMPARABLE_CONFIG, SPEKTRA_FREIGHT_ASSUMPTION, dtpSizeForVendorSku } from "./dtp-catalog";
import { OWNER_STANDARDS } from "./owner-standards";
import { SPEKTRA_FREIGHT_PER_PO } from "./product-driven-costing.server";
import {
  SPEKTRA_COST_BOOK_VERSION,
  SPEKTRA_OBSERVED_ROWS,
  lookupSpektraVendorCost,
  type SpektraConfiguration,
  type SpektraCostLookup,
  type SpektraObservedRow,
} from "./spektra-live-cost-book";

export const DTP_QUOTE_COST_AUTHORITY_VERSION = "dtp-quote-cost-authority/2026-10-06";

export type DtpQuoteCostAuthority = "LIVE_COST_BOOK_BY_CONFIGURATION" | "LEGACY_VENDOR_SEED";
export type DtpQuoteCostStatus =
  | "OBSERVED_VENDOR_PRICE"
  | "ESTIMATED_FROM_VALIDATED_VENDOR_RULE"
  | "ESTIMATED_CONSERVATIVE_STEP"
  | "REQUEST_CURRENT_VENDOR_QUOTE"
  | "LEGACY_VENDOR_SEED"
  | "LEGACY_MANUAL_REVIEW";

export type DtpQuoteCost = {
  version: string;
  authority: DtpQuoteCostAuthority;
  status: DtpQuoteCostStatus;
  basis: string;
  config: SpektraConfiguration | null;
  skuCount: number;
  quantity: number;
  vendorSubtotal: number | null;
  vendorUnit: number | null;
  extraSkuCost: number;
  artCost: number;
  freight: number;
  freightStatus: "UNVERIFIED";
  landedCost: number;
  /** True when the quote must be BLOCKED (no usable vendor cost). */
  missing: boolean;
  missingReason: string | null;
  costBookVersion: string | null;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Conservative step: the highest OBSERVED quantity at or below the requested
 * one for the EXACT configuration (1-SKU row), priced at that row's unit cost
 * for the full requested quantity plus the validated extra-SKU rule. Unit
 * cost falls with quantity, so this over-states cost (safe for margin
 * protection). It is a labelled estimate, not an observed price, and never
 * an interpolation.
 */
function conservativeStep(config: SpektraConfiguration, quantity: number, skuCount: number, rows: SpektraObservedRow[]): SpektraCostLookup | null {
  const candidates = rows.filter((r) => r.skuCount === 1 && r.quantity <= quantity
    && same(r.size, config.size) && same(r.material, config.material) && same(r.finish, config.finish) && same(r.spot, config.spot)
    && same(r.zipper, config.zipper) && same(r.topFeature, config.topFeature) && Boolean(r.clearGusset) === Boolean(config.clearGusset));
  if (!candidates.length) return null;
  const stepQty = Math.max(...candidates.map((r) => r.quantity));
  const step = lookupSpektraVendorCost({ ...config, quantity: stepQty, skuCount }, rows);
  if (step.wholesaleUnit == null || step.wholesaleTotal == null) return null;
  const oneSku = lookupSpektraVendorCost({ ...config, quantity: stepQty, skuCount: 1 }, rows);
  if (oneSku.wholesaleUnit == null) return null;
  const wholesaleTotal = oneSku.wholesaleUnit * quantity + step.wholesaleExtraSkuCost;
  return {
    ...step,
    status: "REQUEST_CURRENT_VENDOR_QUOTE", // the cost-book status is unchanged; the quote layer labels the step below
    quantity,
    wholesaleTotal,
    wholesaleUnit: wholesaleTotal / quantity,
    basis: `Conservative step from the observed ${stepQty.toLocaleString()}-unit row ($${oneSku.wholesaleUnit.toFixed(6)}/unit) applied to ${quantity.toLocaleString()} units${skuCount > 1 ? ` + validated extra-SKU rule` : ""}; request a current vendor quote before the PO.`,
  };
}

export function resolveDtpQuoteCost(input: {
  vendorSku: string | null | undefined;
  quantity: number;
  designs: number;
  selection: { material?: string | null; finish?: string | null; spot?: string | null; zipper?: string | null; topFeature?: string | null; clearGusset?: boolean };
  legacy: { totalCost: number; missing: boolean; vendorSubtotal: number | null };
  freightPerOrder?: number;
  rows?: SpektraObservedRow[];
}): DtpQuoteCost {
  const quantity = Math.max(0, Math.floor(Number(input.quantity) || 0));
  const skuCount = Math.max(1, Math.floor(Number(input.designs) || 1));
  const artCost = OWNER_STANDARDS.artSetupPerDesign.value * skuCount;
  const freight = input.freightPerOrder ?? SPEKTRA_FREIGHT_PER_PO;
  const catalog = dtpSizeForVendorSku(input.vendorSku);
  const base = { version: DTP_QUOTE_COST_AUTHORITY_VERSION, skuCount, quantity, artCost, freight, freightStatus: SPEKTRA_FREIGHT_ASSUMPTION.status };

  // 2026-10-07: a LEGACY size with no current catalog match (5x4x2) is not
  // quoted automatically any more — MANUAL / VENDOR REVIEW REQUIRED. The
  // historical VendorProduct rows and old quote snapshots are untouched.
  if (catalog && catalog.status === "LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH") {
    return {
      ...base,
      authority: "LEGACY_VENDOR_SEED",
      status: "LEGACY_MANUAL_REVIEW",
      basis: `${catalog.size}: LEGACY / NO CURRENT STANDARD CATALOG MATCH — new quotes need MANUAL / VENDOR REVIEW (current vendor quote); not quoted automatically. Historical quotes unchanged.`,
      config: null,
      vendorSubtotal: input.legacy.vendorSubtotal,
      vendorUnit: input.legacy.vendorSubtotal != null && quantity > 0 ? input.legacy.vendorSubtotal / quantity : null,
      extraSkuCost: 0,
      landedCost: input.legacy.totalCost,
      missing: true,
      missingReason: `LEGACY ${catalog.size} — MANUAL / VENDOR REVIEW REQUIRED before quoting (no current Spektra catalog match; legacy cost shown for reference only)`,
      costBookVersion: null,
    };
  }
  if (!catalog || catalog.quoteCostAuthority !== "LIVE_COST_BOOK" || catalog.status !== "CURRENT_STANDARD") {
    return {
      ...base,
      authority: "LEGACY_VENDOR_SEED",
      status: "LEGACY_VENDOR_SEED",
      basis: catalog
        ? `${catalog.size}: quote cost = legacy 15C vendor tiers until the owner reviews this size (${catalog.ownerLadder === "EXISTS_2026-07-24" ? "2026-07-24 ladder in force" : "no owner ladder"}).`
        : "No current catalog entry for this product — legacy vendor tiers.",
      config: null,
      vendorSubtotal: input.legacy.vendorSubtotal,
      vendorUnit: input.legacy.vendorSubtotal != null && quantity > 0 ? input.legacy.vendorSubtotal / quantity : null,
      extraSkuCost: 0,
      landedCost: input.legacy.totalCost,
      missing: input.legacy.missing,
      missingReason: input.legacy.missing ? "Missing vendor/component cost" : null,
      costBookVersion: null,
    };
  }

  const rows = input.rows ?? SPEKTRA_OBSERVED_ROWS;
  const selection = {
    size: catalog.size as SpektraConfiguration["size"],
    material: (input.selection.material || DTP_COMPARABLE_CONFIG.material) as SpektraConfiguration["material"],
    finish: (input.selection.finish || DTP_COMPARABLE_CONFIG.finish) as SpektraConfiguration["finish"],
    spot: (input.selection.spot || DTP_COMPARABLE_CONFIG.spot) as SpektraConfiguration["spot"],
    zipper: (input.selection.zipper || DTP_COMPARABLE_CONFIG.zipper) as SpektraConfiguration["zipper"],
    topFeature: (input.selection.topFeature || DTP_COMPARABLE_CONFIG.topFeature) as SpektraConfiguration["topFeature"],
    clearGusset: Boolean(input.selection.clearGusset),
  };
  let look = lookupSpektraVendorCost({ ...selection, quantity, skuCount }, rows);
  let status: DtpQuoteCostStatus = look.status;
  if (look.wholesaleTotal == null && look.config && quantity > 0) {
    const step = conservativeStep(look.config, quantity, skuCount, rows);
    if (step) { look = step; status = "ESTIMATED_CONSERVATIVE_STEP"; }
  }
  const usable = look.wholesaleTotal != null && look.wholesaleTotal > 0;
  const landedCost = usable ? look.wholesaleTotal! + artCost + freight : 0;
  return {
    ...base,
    authority: "LIVE_COST_BOOK_BY_CONFIGURATION",
    status: usable ? status : "REQUEST_CURRENT_VENDOR_QUOTE",
    basis: usable
      ? `${catalog.size} live cost book by exact configuration — ${look.basis}`
      : `${catalog.size}: ${look.basis} No quote cost — request a current vendor quote.`,
    config: look.config,
    vendorSubtotal: usable ? look.wholesaleTotal : null,
    vendorUnit: usable ? look.wholesaleUnit : null,
    extraSkuCost: look.wholesaleExtraSkuCost,
    landedCost,
    missing: !usable,
    missingReason: usable ? null : `REQUEST CURRENT VENDOR QUOTE — ${look.basis}`,
    costBookVersion: SPEKTRA_COST_BOOK_VERSION,
  };
}
