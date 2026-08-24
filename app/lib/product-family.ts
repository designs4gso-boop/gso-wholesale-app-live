// Phase 0D — ONE storefront/configurator product-family classifier.
//
// WHY THIS FILE EXISTS
//
// `productFamilyForType()` was duplicated byte-for-byte in the configurator
// loader and the configurator checkout proxy. The checkout copy is the
// load-bearing one — its result becomes the draft-order line attribute
// `Product Family`, which then drives BOTH the ADD YOUR BRAND personalization
// gate and the ERP production checklist. Two copies of a classifier that must
// agree is a drift hazard, so both now import this one.
//
// This is NOT the ERP cost/margin registry (product-family-registry.ts) and
// NOT the sales-rule table (product-family-sales-rules.ts). This is only the
// customer-facing family label attached to a configurator line.
//
// Client-safe: pure data + pure functions, no Prisma, no server imports.
//
// ORDERING MATTERS
//
// `sticker_bag_*` MUST be tested before `sticker_*`. A 4x5 Sticker Bag is a
// blank bag with a printed customer label applied — it prices through the
// canonical BAG engine, and its production checklist has to include "Labels
// applied to bags". An ordinary sticker is a flat dimension-driven cut label.
// Letting the generic `sticker_` prefix win would file the bag as a sticker.
//
// FAIL CLOSED
//
// The pre-0D classifier returned "Stock Bags" for ANYTHING it did not
// recognise, and the callers additionally coerced a missing productType to
// the literal `stock_bag_4x5`. That is unsafe: "Stock Bags" is the single
// member of PERSONALIZATION_SUPPORTED_FAMILIES, so an unrecognised product
// silently gained the Stock-Bag-only ADD YOUR BRAND channel. Unknown now
// returns null and every caller treats that as "not configurable".

export const CONFIGURATOR_FAMILIES = [
  "Jars",
  "Stock Bags",
  "Sticker Bags",
  "DTP Pouches",
  "Stickers",
] as const;

export type ConfiguratorFamily = (typeof CONFIGURATOR_FAMILIES)[number];

function normalizeType(productType: unknown): string {
  return String(productType ?? "").trim();
}

/** A blank bag with a printed customer label applied — not a flat sticker. */
export function isStickerBagProductType(productType: unknown): boolean {
  return normalizeType(productType).startsWith("sticker_bag_");
}

// 0D-F: deliberately NOT exported. Both app-proxy routes already carry their
// own jar/stock-bag predicates; exporting these would have made a THIRD copy
// of a helper in a patch whose whole point was de-duplication.
function isJarType(productType: string): boolean {
  return productType.startsWith("jar_");
}

function isStockBagType(productType: string): boolean {
  return productType.startsWith("stock_bag_");
}

/**
 * Resolve a ConfiguratorProduct.productType to its customer-facing family.
 *
 * Returns null for an empty or unrecognised type so the caller can fail
 * closed. Never guesses a family.
 */
export function productFamilyForConfiguratorType(productType: unknown): ConfiguratorFamily | null {
  const type = normalizeType(productType);
  if (!type) return null;
  if (isJarType(type)) return "Jars";
  if (type.startsWith("dtp_")) return "DTP Pouches";
  // MUST precede the generic sticker_ test — see the header note.
  if (isStickerBagProductType(type)) return "Sticker Bags";
  if (type.startsWith("sticker_")) return "Stickers";
  if (isStockBagType(type)) return "Stock Bags";
  return null;
}

/* ------------------------------------------------------------------ *
 * 0D-F — the fail-closed DECISION, as a pure function
 * ------------------------------------------------------------------ */

export type ConfiguratorProductGate =
  | { ok: true; family: ConfiguratorFamily }
  | { ok: false; code: "PRODUCT_NOT_CONFIGURABLE" };

/**
 * Decide whether a ConfiguratorProduct row is sellable through the GSO
 * configurator, and under which family.
 *
 * WHY THIS IS A FUNCTION AND NOT AN `if` IN THE ROUTE
 *
 * The decision used to live inline in both proxies, which meant the only thing
 * a test could do was grep the route source. Mutation testing showed that a
 * grep cannot tell a correct guard from an inverted or dead-coded one. Holding
 * the decision here makes it directly executable, so inverting it fails a real
 * assertion instead of passing a substring match.
 */
export function configuratorProductGate(productType: unknown): ConfiguratorProductGate {
  const family = productFamilyForConfiguratorType(productType);
  if (!family) return { ok: false, code: "PRODUCT_NOT_CONFIGURABLE" };
  return { ok: true, family };
}
