// 2026-10-19 owner decision C — Stock Bag customer quotes use the SAME
// selling-price authority as the live Stock Bag storefront.
//
// The storefront configurator and the configurator checkout price Stock Bags
// through priceStorefrontConfiguration (storefront-canonical-pricing.server.ts).
// The Cost & Pricing Calculator now prices every Stock Bag tier row through
// that exact function, in BOTH the loader and the save action, so a quote and
// an online checkout of the same configuration charge the same price.
//
// True manufacturing cost is untouched: the row keeps the canonical
// stock-bags true cost, and profit / margin are measured against it.
//
// 2026-10-19 owner decision 5: that exact storefront price is an APPROVED
// commercial authority. A margin below the generic bag target is shown as an
// owner warning (belowMarginTarget / marginWarning) — it is NOT a floor block
// (belowFloor stays false), so saving is not refused for it.

import type { CanonicalBagInputs } from "./canonical-bag-pricing.server";
import { STOREFRONT_PRICING_VERSION, priceStorefrontConfiguration, type StorefrontSelection } from "./storefront-canonical-pricing.server";
import { STOREFRONT_BELOW_TARGET_WARNING } from "./quote-pricing-authority";

export { STOREFRONT_BELOW_TARGET_WARNING };

export const STOCK_BAG_QUOTE_PRICE_RULE = `Live storefront Stock Bag price (${STOREFRONT_PRICING_VERSION}; priceStorefrontConfiguration)`;

/** The storefront selection for the calculator's Stock Bag fields. */
export function stockBagStorefrontSelection(input: { faces: unknown; materialName: string | null | undefined; glossLayers: unknown }): Omit<StorefrontSelection, "quantity"> {
  const glossX = Math.max(0, Math.floor(Number(input.glossLayers) || 0));
  return {
    faces: Number(input.faces || 2) >= 2 ? 2 : 1,
    material: String(input.materialName || ""),
    // parseStorefrontFinish: "No Spot Gloss" = 0X, "<n>X" = n stages, 9X+ = deep-build quote.
    finish: glossX > 0 ? `${glossX}X` : "No Spot Gloss",
  };
}

/**
 * Replace a COSTED tier row's price with the storefront authority's price.
 * A row with no cost is returned unchanged (it stays blocked and unpriced).
 * A configuration the storefront does not price (5,000+, Deep Build 9X+,
 * unavailable inputs) gets NO price — never the generic curve.
 */
export function priceStockBagTierRow<T extends Record<string, any>>(row: T, inputs: CanonicalBagInputs, selection: Omit<StorefrontSelection, "quantity">): T {
  if (row.jobCost == null || row.draftOnly) return row;
  const priced = priceStorefrontConfiguration(inputs, { ...selection, quantity: Number(row.quantity) || 0 });
  const commercial = row.commercial
    ? { ...row.commercial, controllingRule: STOCK_BAG_QUOTE_PRICE_RULE, marginSource: "storefront Stock Bag price authority" }
    : row.commercial;
  if (!priced.ok) {
    return {
      ...row,
      filePrepFee: 0,
      marginPct: null,
      unitPrice: null,
      totalPrice: null,
      profit: null,
      actualMarginPct: null,
      belowFloor: false,
      belowMarginTarget: false,
      marginWarning: null,
      commercial,
      status: priced.requestQuote ? "QUOTE REQUIRED" : "PRICING AUTHORITY REQUIRED",
      stockBagStorefront: { ok: false, reason: priced.reason, version: STOREFRONT_PRICING_VERSION },
    };
  }
  const profit = priced.totalPrice - Number(row.jobCost);
  const actualMarginPct = priced.totalPrice > 0 ? (profit / priced.totalPrice) * 100 : 0;
  const marginPct = Math.round(actualMarginPct * 10) / 10;
  const belowMarginTarget = row.floorPct != null && marginPct < Number(row.floorPct);
  return {
    ...row,
    filePrepFee: 0,
    marginPct,
    unitPrice: priced.unitPrice,
    totalPrice: priced.totalPrice,
    profit,
    actualMarginPct,
    belowFloor: false,
    belowMarginTarget,
    marginWarning: belowMarginTarget ? STOREFRONT_BELOW_TARGET_WARNING : null,
    commercial,
    status: "READY TO QUOTE",
    stockBagStorefront: { ok: true, reason: null, version: priced.version, unitPrice: priced.unitPrice, totalPrice: priced.totalPrice },
  };
}
