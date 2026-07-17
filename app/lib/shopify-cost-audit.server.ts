import {
  QUOTE_READY_RECIPE_WHERE,
  QUOTE_RECIPE_PRICING_INCLUDE,
  priceRecipeAtQuantity,
  safeNumber,
} from "./recipe-pricing.server";
import { resolveMaterialUnitCost } from "./cost-calculator.server";
import {
  gidKeys,
  normalizeSku,
  splitIdList,
  type CostIndex,
  type ErpCost,
  type ErpMatch,
  type MatchIndex,
} from "./shopify-cost-audit-shared";

// Server side of the read-only Shopify cost audit (12B.2b): the paginated
// Shopify read query and the ERP index build. This module never writes — the
// only Shopify traffic is a read query, and every database function takes the
// Prisma client as a parameter and uses find/count reads only (so tests can
// import the shared pure logic without ever constructing Prisma).

export const PRODUCT_PAGE_SIZE = 50;
export const MAX_PRODUCT_PAGES = 20; // 1,000 products
export const RECIPE_COMPUTE_CAP = 50;

export type ErpIndex = MatchIndex & CostIndex & {
  recipeMetaById: Map<string, { quoteReady: boolean; quantity: number }>;
};

function pushKey(map: Map<string, ErpMatch[]>, key: string, match: ErpMatch) {
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    if (!existing.some((entry) => entry.table === match.table && entry.id === match.id)) existing.push(match);
  } else {
    map.set(key, [match]);
  }
}

export async function buildErpIndex(dbClient: any, shop: string): Promise<ErpIndex> {
  const [recipes, variantRules, configuratorProducts, configuratorRules, vendorProducts, materials, pricingRules] = await Promise.all([
    dbClient.productRecipe.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, sku: true, productGid: true, variantGid: true,
        shopifyProductId: true, shopifyVariantId: true, shopifyVariantIds: true,
        useInQuotes: true, costReviewNeeded: true, minQuantity: true, defaultQuantity: true,
      },
      take: 500,
    }),
    dbClient.recipeVariantRule.findMany({
      where: { shop },
      select: { id: true, name: true, sku: true, shopifyProductGid: true, shopifyVariantGid: true },
      take: 500,
    }),
    dbClient.configuratorProduct.findMany({
      where: { shop },
      select: { id: true, title: true, productType: true, shopifyProductGid: true, shopifyHandle: true },
      take: 200,
    }),
    dbClient.configuratorPricingRule.findMany({
      where: { shop, active: true },
      select: { productType: true, costEach: true },
      take: 500,
    }),
    dbClient.vendorProduct.findMany({
      where: { shop, active: true },
      select: { id: true, name: true, vendorSku: true, defaultUnitCost: true, tiers: { select: { unitCost: true } } },
      take: 300,
    }),
    dbClient.material.findMany({
      where: { shop, active: true },
      select: { id: true, name: true, sku: true, calculatedUnitCost: true, costPerUnit: true, purchaseCost: true, baseUnit: true, unit: true },
      take: 300,
    }),
    dbClient.pricingRule.findMany({
      where: { shop, active: true },
      select: { id: true, title: true, sku: true, variantGid: true, unitCost: true },
      take: 300,
    }),
  ]);

  const index: ErpIndex = {
    byVariantKey: new Map(),
    byProductKey: new Map(),
    byHandle: new Map(),
    bySku: new Map(),
    vendorCostById: new Map(),
    materialCostById: new Map(),
    pricingRuleCostById: new Map(),
    configuratorCostByProductType: new Map(),
    configuratorTypeById: new Map(),
    recipeMetaById: new Map(),
  };

  for (const recipe of recipes) {
    const match: ErpMatch = { table: "recipe", id: recipe.id, name: recipe.name || "Recipe", matchedBy: "variant_gid" };
    for (const value of [recipe.variantGid, recipe.shopifyVariantId, ...splitIdList(recipe.shopifyVariantIds)]) {
      for (const key of gidKeys(value)) pushKey(index.byVariantKey, key, match);
    }
    const productMatch: ErpMatch = { ...match, matchedBy: "product_gid" };
    for (const value of [recipe.productGid, recipe.shopifyProductId]) {
      for (const key of gidKeys(value)) pushKey(index.byProductKey, key, productMatch);
    }
    pushKey(index.bySku, normalizeSku(recipe.sku), { ...match, matchedBy: "sku" });
    index.recipeMetaById.set(recipe.id, {
      quoteReady: Boolean(recipe.useInQuotes && !recipe.costReviewNeeded),
      quantity: Math.max(1, safeNumber(recipe.defaultQuantity) || safeNumber(recipe.minQuantity) || 1),
    });
  }

  for (const rule of variantRules) {
    const match: ErpMatch = { table: "variant_rule", id: rule.id, name: rule.name || "Variant rule", matchedBy: "variant_gid" };
    for (const key of gidKeys(rule.shopifyVariantGid)) pushKey(index.byVariantKey, key, match);
    for (const key of gidKeys(rule.shopifyProductGid)) pushKey(index.byProductKey, key, { ...match, matchedBy: "product_gid" });
    pushKey(index.bySku, normalizeSku(rule.sku), { ...match, matchedBy: "sku" });
  }

  for (const product of configuratorProducts) {
    const match: ErpMatch = { table: "configurator", id: product.id, name: product.title || "Configurator product", matchedBy: "product_gid" };
    for (const key of gidKeys(product.shopifyProductGid)) pushKey(index.byProductKey, key, match);
    const handle = String(product.shopifyHandle || "").trim().toLowerCase();
    if (handle) pushKey(index.byHandle, handle, { ...match, matchedBy: "handle" });
    index.configuratorTypeById.set(product.id, String(product.productType || ""));
  }

  const configuratorCosts = new Map<string, { low: number; high: number }>();
  for (const rule of configuratorRules) {
    const cost = safeNumber(rule.costEach);
    if (cost <= 0) continue;
    const type = String(rule.productType || "");
    const entry = configuratorCosts.get(type);
    if (!entry) configuratorCosts.set(type, { low: cost, high: cost });
    else {
      entry.low = Math.min(entry.low, cost);
      entry.high = Math.max(entry.high, cost);
    }
  }
  for (const [type, band] of configuratorCosts) {
    index.configuratorCostByProductType.set(type, {
      source: "configurator",
      low: band.low,
      high: band.high,
      label: band.low === band.high ? `$${band.low.toFixed(2)} each` : `$${band.low.toFixed(2)}-$${band.high.toFixed(2)} each`,
    });
  }

  for (const product of vendorProducts) {
    pushKey(index.bySku, normalizeSku(product.vendorSku), { table: "vendor_product", id: product.id, name: product.name || "Vendor product", matchedBy: "sku" });
    const tierCosts = (product.tiers || []).map((tier: any) => safeNumber(tier.unitCost)).filter((cost: number) => cost > 0);
    const fallback = safeNumber(product.defaultUnitCost);
    const low = tierCosts.length ? Math.min(...tierCosts) : fallback;
    const high = tierCosts.length ? Math.max(...tierCosts) : fallback;
    if (high > 0) {
      index.vendorCostById.set(product.id, {
        source: "vendor_product",
        low,
        high,
        label: tierCosts.length ? `tiers $${low.toFixed(2)}-$${high.toFixed(2)}` : `$${high.toFixed(2)} default`,
      });
    }
  }

  for (const material of materials) {
    pushKey(index.bySku, normalizeSku(material.sku), { table: "material", id: material.id, name: material.name || "Material", matchedBy: "sku" });
    const resolved = resolveMaterialUnitCost(material);
    if (resolved.unitCost > 0) {
      index.materialCostById.set(material.id, {
        source: "material",
        low: resolved.unitCost,
        high: resolved.unitCost,
        label: `$${resolved.unitCost.toFixed(4)}/${String(material.baseUnit || material.unit || "unit")}`,
      });
    }
  }

  for (const rule of pricingRules) {
    const match: ErpMatch = { table: "pricing_rule", id: rule.id, name: rule.title || "Pricing rule", matchedBy: "sku" };
    for (const key of gidKeys(rule.variantGid)) pushKey(index.byVariantKey, key, { ...match, matchedBy: "variant_gid" });
    pushKey(index.bySku, normalizeSku(rule.sku), match);
    const cost = safeNumber(rule.unitCost);
    if (cost > 0) {
      index.pricingRuleCostById.set(rule.id, { source: "pricing_rule", low: cost, high: cost, label: `$${cost.toFixed(2)} legacy` });
    }
  }

  return index;
}

// Engine-computed unit cost for matched quote-ready recipes (bounded, fail-soft).
export async function computeRecipeCosts(dbClient: any, shop: string, recipeIds: string[], index: ErpIndex) {
  const costs = new Map<string, ErpCost>();
  const quoteReadyIds = recipeIds.filter((id) => index.recipeMetaById.get(id)?.quoteReady).slice(0, RECIPE_COMPUTE_CAP);
  if (!quoteReadyIds.length) return costs;

  const recipes = await dbClient.productRecipe.findMany({
    where: { id: { in: quoteReadyIds }, shop, ...QUOTE_READY_RECIPE_WHERE },
    include: QUOTE_RECIPE_PRICING_INCLUDE,
  });

  for (const recipe of recipes) {
    try {
      const quantity = index.recipeMetaById.get(recipe.id)?.quantity || 1;
      const priced = priceRecipeAtQuantity(recipe, quantity, {});
      if (Number.isFinite(priced.unitCost) && priced.unitCost > 0) {
        costs.set(recipe.id, {
          source: "recipe_computed",
          low: priced.unitCost,
          high: priced.unitCost,
          label: `$${priced.unitCost.toFixed(4)}/unit computed at qty ${priced.quantity}`,
        });
      }
    } catch {
      // A recipe that cannot price is skipped; the row falls back to the next cost authority.
    }
  }
  return costs;
}

// ---------- Shopify pull (read-only, paginated, scope-resilient) ----------

export type ShopifyVariantRecord = {
  productId: string;
  productTitle: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string;
  productStatus: string;
  variantId: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  price: number | null;
  compareAtPrice: number | null;
  inventoryItemId: string;
  tracked: boolean | null;
  unitCost: number | null;
  currency: string | null;
  variantsTruncated: boolean;
};

export type ShopifyPullResult = {
  ok: boolean;
  error: string | null;
  inventoryAccess: boolean;
  inventoryAccessError: string | null;
  throttled: boolean;
  truncated: boolean;
  pageCount: number;
  productCount: number;
  variants: ShopifyVariantRecord[];
};

export function buildProductsQuery(includeInventory: boolean) {
  const inventoryBlock = includeInventory
    ? "inventoryItem { id tracked unitCost { amount currencyCode } }"
    : "";
  return `#graphql
    query ShopifyCostAudit($cursor: String) {
      products(first: ${PRODUCT_PAGE_SIZE}, after: $cursor, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title handle vendor productType tags status
          variants(first: 100) {
            pageInfo { hasNextPage }
            edges { node {
              id title sku barcode price compareAtPrice
              ${inventoryBlock}
            } }
          }
        } }
      }
    }`;
}

function isAccessError(errors: any[]) {
  return (errors || []).some((error) => {
    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.extensions?.code || "").toLowerCase();
    return code === "access_denied" || /access|scope|permission|unauthorized/.test(message);
  });
}

function isThrottleError(errors: any[]) {
  return (errors || []).some((error) => {
    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.extensions?.code || "").toLowerCase();
    return code === "throttled" || message.includes("throttl");
  });
}

function moneyOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const amount = Number(typeof value === "object" ? (value as any).amount : value);
  return Number.isFinite(amount) ? amount : null;
}

async function runProductsPage(admin: any, query: string, cursor: string | null) {
  const response = await admin.graphql(query, { variables: { cursor } });
  const body = await response.json();
  return { data: body?.data ?? null, errors: (body?.errors as any[]) || [] };
}

export async function pullShopifyCatalog(admin: any): Promise<ShopifyPullResult> {
  const result: ShopifyPullResult = {
    ok: false,
    error: null,
    inventoryAccess: true,
    inventoryAccessError: null,
    throttled: false,
    truncated: false,
    pageCount: 0,
    productCount: 0,
    variants: [],
  };

  let query = buildProductsQuery(true);

  // Scope probe: if the first page is denied because of inventory access,
  // fall back to the degraded query (no inventoryItem/unitCost) and restart.
  try {
    let probe = await runProductsPage(admin, query, null);
    if (!probe.data && probe.errors.length && isAccessError(probe.errors)) {
      result.inventoryAccess = false;
      result.inventoryAccessError = String(probe.errors[0]?.message || "Access denied for inventory cost fields.");
      query = buildProductsQuery(false);
      probe = await runProductsPage(admin, query, null);
    }

    let page = probe;
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_PRODUCT_PAGES; pageIndex += 1) {
      if (pageIndex > 0) page = await runProductsPage(admin, query, cursor);

      if (!page.data) {
        if (isThrottleError(page.errors)) {
          result.throttled = true;
          break;
        }
        result.error = String(page.errors[0]?.message || "Shopify query failed.");
        break;
      }

      result.pageCount += 1;
      const connection = page.data.products;
      for (const edge of connection?.edges || []) {
        const node = edge?.node;
        if (!node) continue;
        result.productCount += 1;
        const variantsTruncated = Boolean(node.variants?.pageInfo?.hasNextPage);
        for (const variantEdge of node.variants?.edges || []) {
          const variant = variantEdge?.node;
          if (!variant) continue;
          result.variants.push({
            productId: String(node.id || ""),
            productTitle: String(node.title || ""),
            handle: String(node.handle || ""),
            vendor: String(node.vendor || ""),
            productType: String(node.productType || ""),
            tags: Array.isArray(node.tags) ? node.tags.join(", ") : String(node.tags || ""),
            productStatus: String(node.status || ""),
            variantId: String(variant.id || ""),
            variantTitle: String(variant.title || ""),
            sku: String(variant.sku || ""),
            barcode: String(variant.barcode || ""),
            price: moneyOrNull(variant.price),
            compareAtPrice: moneyOrNull(variant.compareAtPrice),
            inventoryItemId: String(variant.inventoryItem?.id || ""),
            tracked: variant.inventoryItem ? Boolean(variant.inventoryItem.tracked) : null,
            unitCost: result.inventoryAccess ? moneyOrNull(variant.inventoryItem?.unitCost) : null,
            currency: variant.inventoryItem?.unitCost?.currencyCode || null,
            variantsTruncated,
          });
        }
      }

      if (!connection?.pageInfo?.hasNextPage) {
        result.ok = !result.error;
        return result;
      }
      cursor = String(connection.pageInfo.endCursor || "");
      if (!cursor) break;
    }

    // Loop ended without pageInfo saying done: capped or errored.
    if (!result.error && !result.throttled) result.truncated = true;
    result.ok = result.variants.length > 0 || !result.error;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Shopify pull failed.";
    result.ok = result.variants.length > 0;
    return result;
  }
}
