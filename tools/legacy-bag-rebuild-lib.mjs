// Phase 16C — pure helpers for the legacy Stock Bag canonical rebuild.
// No I/O here: everything is unit-testable. The CLI (rebuild-legacy-bags-16c.mjs)
// wires these against live Shopify + Prisma data.
//
// Canonical target shape (matches the healthy 1,855-product fleet):
//   - single "Default Title" variant priced 1.00 (placeholder — real pricing is
//     the server canonical engine; the variant price is never charged because
//     checkout reprices every line)
//   - templateSuffix "configurator-pilot" (renders the configurator template)
//   - tag "configurator-pilot" (purchase-path lockout + ERP sync eligibility)
//   - ConfiguratorProduct row (stock_bag_4x5) linking product + base variant

export const EXPECTED_LEGACY_COUNT = 31;
export const CANONICAL_TEMPLATE_SUFFIX = "configurator-pilot";
export const CANONICAL_TAG = "configurator-pilot";
export const CANONICAL_VARIANT_PRICE = "1.00";
export const REBUILD_NOTES_MARKER = "16C legacy stock bag rebuild";
// Matches the ERP fleet value written by app.erp.configurator-sync (MIN_QTY=64).
// The storefront overrides bags to the canonical MOQ 50 regardless of this field.
export const ERP_ROW_MIN_QUANTITY = 64;

// Membership test for the legacy rebuild set. `erp` carries Sets of the
// ConfiguratorProduct linkage keys so a product already wired into the ERP can
// never be classified as legacy.
export function classifyProduct(product, erp) {
  const variantCount = product.variantsCount?.count ?? 0;
  const hasPilotTag = (product.tags || []).includes(CANONICAL_TAG);
  const inErp =
    erp.gids.has(product.id) ||
    erp.titles.has(product.title) ||
    (product.handle ? erp.handles.has(product.handle) : false);
  if (product.productType !== "Stock Bag") return "other";
  if (hasPilotTag && variantCount === 1 && inErp) return "canonical";
  if (!hasPilotTag && variantCount > 1 && !inErp && product.status === "DRAFT") return "legacy";
  return "other";
}

// Full pre-mutation snapshot — everything --rollback needs to restore an
// equivalent product (variant GIDs are necessarily new after a restore).
export function snapshotOf(detail) {
  return {
    id: detail.id,
    handle: detail.handle,
    title: detail.title,
    previousStatus: detail.status,
    previousTemplateSuffix: detail.templateSuffix ?? null,
    previousTags: [...(detail.tags || [])],
    vendor: detail.vendor ?? null,
    productType: detail.productType ?? null,
    mediaCount: detail.mediaCount?.count ?? null,
    options: (detail.options || []).map((option) => ({
      id: option.id,
      name: option.name,
      position: option.position,
      values: [...(option.values || [])],
    })),
    variants: (detail.variants?.nodes || []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      position: variant.position,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice ?? null,
      barcode: variant.barcode ?? null,
      sku: variant.inventoryItem?.sku ?? null,
      inventoryPolicy: variant.inventoryPolicy ?? null,
      tracked: variant.inventoryItem?.tracked ?? null,
      selectedOptions: (variant.selectedOptions || []).map((so) => ({ name: so.name, value: so.value })),
    })),
  };
}

// Mutation plan for one product. Returns { errors } instead of a plan whenever
// the product does not look like the audited legacy shape — the CLI refuses to
// touch anything that fails planning.
export function planRebuild(detail) {
  const errors = [];
  const variants = detail.variants?.nodes || [];
  const options = detail.options || [];
  if (detail.productType !== "Stock Bag") errors.push(`productType is "${detail.productType}", expected "Stock Bag"`);
  if (detail.status !== "DRAFT") errors.push(`status is ${detail.status}, expected DRAFT (16B containment)`);
  if (variants.length < 2) errors.push(`only ${variants.length} variants — nothing to collapse`);
  if (!options.length) errors.push("no options reported");
  if ((detail.tags || []).includes(CANONICAL_TAG)) errors.push("already tagged configurator-pilot");
  if (errors.length) return { errors };

  const sorted = [...variants].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const keepVariant = sorted[0];
  return {
    errors: [],
    keepVariantId: keepVariant.id,
    keepVariantSku: keepVariant.inventoryItem?.sku ?? null,
    deleteVariantIds: sorted.slice(1).map((variant) => variant.id),
    optionIds: options.map((option) => option.id),
    needsTag: true,
    needsTemplateSuffix: detail.templateSuffix !== CANONICAL_TEMPLATE_SUFFIX,
  };
}

// ConfiguratorProduct row payload — mirrors app.erp.configurator-sync exactly
// (defaultSides/minQuantity/pilot/active) so rebuilt rows are indistinguishable
// from synced ones apart from the notes provenance.
export function erpRowDataFor(detail, keepVariantId, keepVariantSku) {
  return {
    title: detail.title,
    shopifyProductGid: detail.id,
    shopifyVariantGid: keepVariantId,
    shopifyHandle: detail.handle,
    sku: keepVariantSku ?? null,
    productType: "stock_bag_4x5",
    defaultSides: "Double Sided",
    minQuantity: ERP_ROW_MIN_QUANTITY,
    pilot: true,
    active: true,
    notes: [
      `Created by ${REBUILD_NOTES_MARKER}.`,
      "Previous structure: native Sided/Material/Bag Color variant matrix collapsed to a single base variant.",
      "Storefront MOQ authority: canonical engine (50).",
    ].join("\n"),
  };
}

// Post-write acceptance for one product. `reference` is the live healthy-fleet
// variant posture (read from ritz-vanilla-cupcake at runtime) so the check is
// calibrated against production reality rather than assumptions.
export function verifyRebuilt(detail, reference) {
  const problems = [];
  const variants = detail.variants?.nodes || [];
  const options = detail.options || [];
  if (variants.length !== 1) problems.push(`expected 1 variant, found ${variants.length}`);
  if (options.length !== 1) problems.push(`expected 1 option, found ${options.length}`);
  const variant = variants[0];
  if (variant && Number(variant.price) !== Number(CANONICAL_VARIANT_PRICE)) {
    problems.push(`variant price ${variant.price}, expected ${CANONICAL_VARIANT_PRICE}`);
  }
  if (variant && reference?.inventoryPolicy && variant.inventoryPolicy !== reference.inventoryPolicy) {
    problems.push(`inventoryPolicy ${variant.inventoryPolicy}, expected ${reference.inventoryPolicy}`);
  }
  if (!(detail.tags || []).includes(CANONICAL_TAG)) problems.push(`missing tag ${CANONICAL_TAG}`);
  if (detail.templateSuffix !== CANONICAL_TEMPLATE_SUFFIX) {
    problems.push(`templateSuffix "${detail.templateSuffix}", expected "${CANONICAL_TEMPLATE_SUFFIX}"`);
  }
  return { ok: problems.length === 0, problems };
}
