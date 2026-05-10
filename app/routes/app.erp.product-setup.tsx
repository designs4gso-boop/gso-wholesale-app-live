import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Select,
  Badge,
  Divider,
  Checkbox,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type ProductTypeDefault = {
  name: string;
  productionMode: string;
  minQuantity: number;
  defaultQuantity: number;
  tiers: number[];
  defaultMarginPct: number;
  pricingMethod: string;
  defaultTags: string[];
};

type ShopifyVariantOption = {
  id: string;
  title: string;
  sku: string;
  price: string;
  minQuantityHint?: number | null;
  minQuantitySource?: string | null;
};

type ShopifyProductOption = {
  productId: string;
  productTitle: string;
  handle: string;
  status: string;
  tags: string[];
  minQuantityHint?: number | null;
  minQuantitySource?: string | null;
  variants: ShopifyVariantOption[];
};

const productTypeDefaults: Record<string, ProductTypeDefault> = {
  label: {
    name: "Labels",
    productionMode: "in_house",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 100, 250, 500, 1000, 2500, 5000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:labels", "gso:in-house", "gso:wholesale"],
  },
  dtp_bag: {
    name: "DTP Bags",
    productionMode: "in_house",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:dtp-bags", "gso:in-house", "gso:wholesale"],
  },
  stock_bag: {
    name: "Stock Bags",
    productionMode: "outsourced",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 200, 500, 750, 1000, 2000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:stock-bags", "gso:outsourced", "gso:wholesale"],
  },
  box: {
    name: "Boxes",
    productionMode: "outsourced",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2000, 2500, 5000, 7500, 10000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:boxes", "gso:outsourced", "gso:wholesale"],
  },
  die_cut_bag: {
    name: "Die Cut Bags",
    productionMode: "hybrid",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:die-cut-bags", "gso:hybrid", "gso:wholesale"],
  },
  sourced_product: {
    name: "Sourced Products",
    productionMode: "outsourced",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 200, 500, 750, 1000, 2000],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:sourced-products", "gso:outsourced", "gso:wholesale"],
  },
  general: {
    name: "General",
    productionMode: "in_house",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 200, 500, 750, 1000, 2000],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:general", "gso:wholesale"],
  },
};

const productionModeOptions = [
  { label: "In-house production", value: "in_house" },
  { label: "Outsourced / vendor produced", value: "outsourced" },
  { label: "Hybrid: vendor item + GSO finishing", value: "hybrid" },
];

const pricingMethodOptions = [
  { label: "Auto margin", value: "auto_margin" },
  { label: "Fixed unit price later", value: "fixed_price" },
  { label: "Discount from first tier later", value: "discount_from_first" },
  { label: "Markup over cost later", value: "markup_over_cost" },
];

const emptyOption = { label: "None", value: "" };

function numberOrZero(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableInt(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value: any, fallback = 1) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumberLines(value: any, fallback: number[] = [1]) {
  const parsed = String(value || "")
    .split(/[\n,]+/)
    .map((item) => positiveInt(item.trim(), 0))
    .filter((item) => item > 0);
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => a - b) : fallback;
}

type TierSetupRow = {
  minQty: string;
  maxQty: string;
  marginPct: string;
  fixedPrice: string;
};

type VendorTierSetupRow = {
  minQty: string;
  maxQty: string;
  unitCost: string;
  notes: string;
};

function nullableIntValue(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function tierRangeLabel(row: { minQty: any; maxQty?: any }) {
  const min = positiveInt(row.minQty, 1);
  const max = nullableIntValue(row.maxQty);
  return max ? `${min}-${max}` : `${min}+`;
}

function makeRangeRows(starts: number[], marginPct: number): TierSetupRow[] {
  const uniqueStarts = Array.from(new Set(starts.map((qty) => positiveInt(qty, 0)).filter((qty) => qty > 0))).sort((a, b) => a - b);
  const rows = uniqueStarts.length ? uniqueStarts : [1];
  return rows.map((qty, index) => {
    const next = rows[index + 1];
    return {
      minQty: String(qty),
      maxQty: next ? String(Math.max(qty, next - 1)) : "",
      marginPct: String(marginPct),
      fixedPrice: "",
    };
  });
}

function suggestedTierStarts(minQuantity: number) {
  const min = positiveInt(minQuantity, 1);
  let anchors: number[];

  if (min < 10) {
    anchors = [min, 10, 25, 50, 100, 250, 500];
  } else if (min < 50) {
    anchors = [min, 50, 100, 250, 500, 750, 1000, 2000];
  } else if (min < 100) {
    anchors = [min, 200, 500, 750, 1000, 2000];
  } else if (min < 500) {
    anchors = [min, 250, 500, 750, 1000, 2000, 5000];
  } else if (min < 1000) {
    anchors = [min, 1000, 2000, 2500, 5000, 7500, 10000];
  } else {
    anchors = [min, 2000, 2500, 5000, 7500, 10000];
  }

  return Array.from(new Set(anchors.filter((qty) => qty >= min))).sort((a, b) => a - b);
}

function suggestedTierRowsFromMin(minQuantity: number, marginPct: number, templateRows: TierSetupRow[] = []) {
  const starts = suggestedTierStarts(minQuantity);
  return makeRangeRows(starts, marginPct).map((row, index) => {
    const template = templateRows[index] || templateRows[templateRows.length - 1];
    return {
      ...row,
      marginPct: template?.marginPct || String(marginPct),
      fixedPrice: template?.fixedPrice || "",
    };
  });
}

function makeTierRows(quantities: number[], marginPct: number): TierSetupRow[] {
  return makeRangeRows(quantities.length ? quantities : [1], marginPct);
}

function cleanTierRows(rows: any[], fallbackQuantities: number[], fallbackMarginPct: number) {
  const source = Array.isArray(rows) && rows.length
    ? rows
    : makeTierRows(fallbackQuantities, fallbackMarginPct);

  const cleaned = source
    .map((row) => ({
      minQty: positiveInt(row?.minQty, 0),
      maxQty: nullableIntValue(row?.maxQty),
      marginPct: nullableNumber(row?.marginPct),
      fixedPrice: nullableNumber(row?.fixedPrice),
    }))
    .filter((row) => row.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  const deduped: typeof cleaned = [];
  for (const row of cleaned) {
    const existingIndex = deduped.findIndex((item) => item.minQty === row.minQty);
    if (existingIndex >= 0) {
      deduped[existingIndex] = row;
    } else {
      deduped.push(row);
    }
  }

  return deduped.map((row, index) => {
    const next = deduped[index + 1];
    const computedMax = next ? Math.max(row.minQty, next.minQty - 1) : null;
    return {
      minQty: row.minQty,
      maxQty: row.maxQty ?? computedMax,
      marginPct: row.marginPct ?? fallbackMarginPct,
      fixedPrice: row.fixedPrice,
    };
  }).length
    ? deduped.map((row, index) => {
        const next = deduped[index + 1];
        const computedMax = next ? Math.max(row.minQty, next.minQty - 1) : null;
        return {
          minQty: row.minQty,
          maxQty: row.maxQty ?? computedMax,
          marginPct: row.marginPct ?? fallbackMarginPct,
          fixedPrice: row.fixedPrice,
        };
      })
    : [{ minQty: positiveInt(fallbackQuantities[0], 1), maxQty: null, marginPct: fallbackMarginPct, fixedPrice: null }];
}

function parseTierRows(value: any, fallbackQuantities: number[], fallbackMarginPct: number) {
  if (Array.isArray(value)) return cleanTierRows(value, fallbackQuantities, fallbackMarginPct);

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return cleanTierRows(parsed, fallbackQuantities, fallbackMarginPct);
    } catch (_error) {
      // Fall back to old comma/newline tier breakpoint input.
    }

    return cleanTierRows(
      parseNumberLines(value, fallbackQuantities).map((qty) => ({ minQty: String(qty), maxQty: "", marginPct: String(fallbackMarginPct), fixedPrice: "" })),
      fallbackQuantities,
      fallbackMarginPct,
    );
  }

  return cleanTierRows([], fallbackQuantities, fallbackMarginPct);
}

function parseTierTemplate(value: any, fallbackQuantities: number[], fallbackMarginPct: number): TierSetupRow[] {
  const parsed = parseTierRows(value, fallbackQuantities, fallbackMarginPct);
  return parsed.map((row) => ({
    minQty: String(row.minQty),
    maxQty: row.maxQty ? String(row.maxQty) : "",
    marginPct: row.marginPct !== null && row.marginPct !== undefined ? String(row.marginPct) : String(fallbackMarginPct),
    fixedPrice: row.fixedPrice !== null && row.fixedPrice !== undefined ? String(row.fixedPrice) : "",
  }));
}

function parseTags(value: any) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function cleanVendorTierRows(rows: any[], fallbackRows: TierSetupRow[], fallbackCost: number): VendorTierSetupRow[] {
  const source = Array.isArray(rows) && rows.length
    ? rows
    : fallbackRows.map((row) => ({ minQty: row.minQty, maxQty: row.maxQty, unitCost: String(fallbackCost || ""), notes: "" }));

  const cleaned = source
    .map((row) => ({
      minQty: positiveInt(row?.minQty, 0),
      maxQty: nullableIntValue(row?.maxQty),
      unitCost: numberOrZero(row?.unitCost),
      notes: String(row?.notes || "").trim(),
    }))
    .filter((row) => row.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  const deduped: typeof cleaned = [];
  for (const row of cleaned) {
    const existingIndex = deduped.findIndex((item) => item.minQty === row.minQty);
    if (existingIndex >= 0) deduped[existingIndex] = row;
    else deduped.push(row);
  }

  const withRanges = deduped.map((row, index) => {
    const next = deduped[index + 1];
    return {
      minQty: String(row.minQty),
      maxQty: row.maxQty ? String(row.maxQty) : next ? String(Math.max(row.minQty, next.minQty - 1)) : "",
      unitCost: row.unitCost ? String(row.unitCost) : "",
      notes: row.notes,
    };
  });

  return withRanges.length ? withRanges : [{ minQty: "1", maxQty: "", unitCost: String(fallbackCost || ""), notes: "" }];
}

function parseVendorCostTiers(value: any, fallbackRows: TierSetupRow[], fallbackCost: number) {
  if (Array.isArray(value)) {
    return cleanVendorTierRows(value, fallbackRows, fallbackCost)
      .map((row) => ({
        minQty: positiveInt(row.minQty, 1),
        maxQty: nullableIntValue(row.maxQty),
        unitCost: numberOrZero(row.unitCost),
        notes: row.notes || null,
      }));
  }

  const parsed = String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        minQty: positiveInt(parts[0], positiveInt(fallbackRows[0]?.minQty, 1)),
        maxQty: nullableIntValue(parts[1]),
        unitCost: numberOrZero(parts[2] ?? parts[1]),
        notes: parts.slice(3).join(" | ") || null,
      };
    })
    .filter((item) => item.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  if (parsed.length) return parsed;
  return cleanVendorTierRows([], fallbackRows, fallbackCost).map((row) => ({
    minQty: positiveInt(row.minQty, 1),
    maxQty: nullableIntValue(row.maxQty),
    unitCost: numberOrZero(row.unitCost),
    notes: row.notes || null,
  }));
}

function parseAddOns(value: any) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        name: parts[0] || "Add-on",
        pricingType: parts[1] || "per_unit",
        amount: numberOrZero(parts[2]),
        enabled: true,
        notes: parts.slice(3).join(" | ") || null,
      };
    })
    .filter((item) => item.name);
}

function marginPrice(cost: number, marginPct: number) {
  const margin = Math.min(Math.max(numberOrZero(marginPct), 0), 95);
  return cost / (1 - margin / 100);
}

function dollars(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function defaultRows(shop: string) {
  return Object.entries(productTypeDefaults).map(([key, defaults]) => ({
    shop,
    key,
    name: defaults.name,
    productionMode: defaults.productionMode,
    minQuantity: defaults.minQuantity,
    defaultQuantity: defaults.defaultQuantity,
    tierBreakpoints: defaults.tiers.join(", "),
    tierTemplate: JSON.stringify(makeRangeRows(defaults.tiers, defaults.defaultMarginPct)),
    defaultMarginPct: defaults.defaultMarginPct,
    pricingMethod: defaults.pricingMethod,
    defaultTags: defaults.defaultTags.join(", "),
  }));
}

async function ensureProductTypeProfiles(shop: string) {
  const count = await db.productTypeProfile.count({ where: { shop } });
  if (count === 0) {
    await db.productTypeProfile.createMany({ data: defaultRows(shop) });
  }
}

function escapeShopifySearchTerm(term: string) {
  return term.replace(/[\\:()]/g, "\\$&").replace(/["']/g, "").trim();
}

function searchTokens(search: string) {
  return String(search || "")
    .replace(/([0-9])x([0-9])/gi, "$1 $2 $1x$2")
    .split(/\s+/)
    .map((token) => escapeShopifySearchTerm(token))
    .filter((token) => token.length >= 2);
}

function buildTitleSearchQuery(search: string) {
  const tokens = searchTokens(search).slice(0, 5);
  return tokens.map((token) => `title:${token}*`).join(" ");
}

function buildDefaultSearchQuery(search: string) {
  const cleaned = String(search || "").trim().replace(/["']/g, "");
  return cleaned.length >= 2 ? cleaned : "";
}

function normalizeForRanking(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstPositiveIntFromValues(values: any[]) {
  for (const value of values) {
    const parsed = positiveInt(value, 0);
    if (parsed > 0) return parsed;
  }
  return null;
}

function inferMinQuantityFromTags(tags: string[] = []) {
  for (const tag of tags || []) {
    const normalized = String(tag || "").toLowerCase();
    const match = normalized.match(/(?:min|moq|minimum|gso:min|gso:moq)[^0-9]*([0-9]+)/);
    if (match) {
      const parsed = positiveInt(match[1], 0);
      if (parsed > 0) return { value: parsed, source: `tag:${tag}` };
    }
  }
  return { value: null, source: null };
}

function inferMinQuantityFromMetafields(owner: any, tags: string[] = []) {
  const direct = firstPositiveIntFromValues([
    owner?.gsoMinQuantity?.value,
    owner?.customMinQuantity?.value,
    owner?.customMinimumQuantity?.value,
    owner?.customMoq?.value,
  ]);
  if (direct) return { value: direct, source: "Shopify metafield" };
  return inferMinQuantityFromTags(tags);
}

function inferMinQuantityFromSelectedProduct(product: ShopifyProductOption | null, variantIds: string[] = [], targetMode = "product_all_variants") {
  if (!product) return { value: null, source: null };
  const selectedVariants = targetMode === "selected_variants"
    ? product.variants.filter((variant) => variantIds.includes(variant.id))
    : product.variants;
  const variantMinimums = selectedVariants
    .map((variant) => variant.minQuantityHint)
    .filter((value): value is number => Boolean(value && value > 0));

  if (variantMinimums.length) {
    return { value: Math.max(...variantMinimums), source: "selected Shopify variant" };
  }

  if (product.minQuantityHint) {
    return { value: product.minQuantityHint, source: product.minQuantitySource || "Shopify product" };
  }

  return { value: null, source: null };
}

function productSearchScore(product: ShopifyProductOption, search: string) {
  const title = normalizeForRanking(product.productTitle);
  const raw = normalizeForRanking(search);
  const tokens = raw.split(/\s+/).filter(Boolean);
  let score = 0;

  if (title === raw) score += 1000;
  if (title.includes(raw)) score += 500;
  for (const token of tokens) {
    if (title.split(" ").some((part) => part === token)) score += 75;
    else if (title.includes(token)) score += 35;
  }

  for (const variant of product.variants || []) {
    const sku = normalizeForRanking(variant.sku);
    if (sku && sku.includes(raw)) score += 250;
    for (const token of tokens) {
      if (sku && sku.includes(token)) score += 50;
    }
  }

  return score;
}

async function runProductSearch(admin: any, query: string) {
  if (!query) return [];

  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String!) {
        products(first: 20, query: $query, sortKey: TITLE) {
          nodes {
            id
            title
            handle
            status
            tags
            gsoMinQuantity: metafield(namespace: "gso_erp", key: "min_quantity") { value }
            customMinQuantity: metafield(namespace: "custom", key: "min_quantity") { value }
            customMinimumQuantity: metafield(namespace: "custom", key: "minimum_quantity") { value }
            customMoq: metafield(namespace: "custom", key: "moq") { value }
            variants(first: 100) {
              nodes {
                id
                title
                sku
                price
                gsoMinQuantity: metafield(namespace: "gso_erp", key: "min_quantity") { value }
                customMinQuantity: metafield(namespace: "custom", key: "min_quantity") { value }
                customMinimumQuantity: metafield(namespace: "custom", key: "minimum_quantity") { value }
                customMoq: metafield(namespace: "custom", key: "moq") { value }
              }
            }
          }
        }
      }
    `,
    { variables: { query } },
  );

  const json = await response.json();
  if (json.errors) return [];

  return (json.data?.products?.nodes || []).map((product: any) => {
    const productMin = inferMinQuantityFromMetafields(product, product.tags || []);
    return {
      productId: product.id,
      productTitle: product.title,
      handle: product.handle || "",
      status: product.status || "",
      tags: product.tags || [],
      minQuantityHint: productMin.value,
      minQuantitySource: productMin.source,
      variants: (product.variants?.nodes || []).map((variant: any) => {
        const variantMin = inferMinQuantityFromMetafields(variant, product.tags || []);
        return {
          id: variant.id,
          title: variant.title || "Default Title",
          sku: variant.sku || "",
          price: String(variant.price || "0"),
          minQuantityHint: variantMin.value,
          minQuantitySource: variantMin.source,
        };
      }),
    };
  }) as ShopifyProductOption[];
}

async function searchShopifyProducts(admin: any, search: string) {
  const cleanedSearch = String(search || "").trim();
  if (cleanedSearch.length < 2) return [];

  const seen = new Set<string>();
  const results: ShopifyProductOption[] = [];
  const queries = [buildTitleSearchQuery(cleanedSearch), buildDefaultSearchQuery(cleanedSearch)].filter(Boolean);

  for (const query of queries) {
    const matches = await runProductSearch(admin, query);
    for (const product of matches) {
      if (!seen.has(product.productId)) {
        seen.add(product.productId);
        results.push(product);
      }
    }
  }

  return results
    .sort((a, b) => productSearchScore(b, cleanedSearch) - productSearchScore(a, cleanedSearch))
    .slice(0, 12);
}

async function applyShopifyTags(admin: any, productId: string, currentTags: string[], tagsToAdd: string[]) {
  if (!productId || !tagsToAdd.length) return { ok: true, tags: currentTags };

  const mergedTags = Array.from(new Set([...(currentTags || []), ...tagsToAdd].map((tag) => tag.trim()).filter(Boolean)));

  const response = await admin.graphql(
    `#graphql
      mutation ProductUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { input: { id: productId, tags: mergedTags } } },
  );

  const json = await response.json();
  const errors = json.errors || json.data?.productUpdate?.userErrors || [];
  if (errors.length) {
    return { ok: false, error: JSON.stringify(errors), tags: currentTags };
  }

  return { ok: true, tags: json.data?.productUpdate?.product?.tags || mergedTags };
}

export async function loader({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  await ensureProductTypeProfiles(shop);

  const [profiles, materials, machines, vendorProducts, recentRecipes, shopifyProducts] = await Promise.all([
    db.productTypeProfile.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.material.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.machine.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { tiers: { orderBy: { minQty: "asc" } }, addOns: { where: { enabled: true } } },
    }),
    db.productRecipe.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { productTypeProfile: true, vendorProduct: true, tiers: { orderBy: { minQty: "asc" } } },
    }),
    Promise.resolve([]),
  ]);

  return Response.json({ profiles, materials, machines, vendorProducts, recentRecipes, shopifyProducts });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "searchShopifyProducts") {
    const shopifyProducts = await searchShopifyProducts(admin, payload.search || "");
    return Response.json({ ok: true, shopifyProducts });
  }

  if (payload.intent !== "quickCreateProduct") {
    return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  const productName = String(payload.productName || "").trim();
  if (!productName) {
    return Response.json({ ok: false, error: "Product name is required." }, { status: 400 });
  }

  const profile = await db.productTypeProfile.findFirst({ where: { id: payload.productTypeProfileId, shop } });
  if (!profile) {
    return Response.json({ ok: false, error: "Choose a product type." }, { status: 400 });
  }

  const selectedShopifyProduct = payload.selectedShopifyProduct || null;
  const shopifyTargetMode = payload.skipShopifyLink
    ? "internal_only"
    : payload.shopifyTargetMode || selectedShopifyProduct?.targetMode || "product_all_variants";
  const selectedVariantIds = Array.isArray(payload.selectedVariantIds)
    ? payload.selectedVariantIds.filter(Boolean)
    : Array.isArray(selectedShopifyProduct?.variantIds)
      ? selectedShopifyProduct.variantIds.filter(Boolean)
      : [];
  const selectedVariantLabels = Array.isArray(selectedShopifyProduct?.variants)
    ? selectedShopifyProduct.variants.map((variant: any) => [variant.title, variant.sku].filter(Boolean).join(" / ")).filter(Boolean)
    : [];
  const productGid = payload.skipShopifyLink ? null : selectedShopifyProduct?.productId || null;
  const variantGid = payload.skipShopifyLink
    ? null
    : shopifyTargetMode === "selected_variants" && selectedVariantIds.length === 1
      ? selectedVariantIds[0]
      : null;
  const shopifyVariantIds = payload.skipShopifyLink || shopifyTargetMode !== "selected_variants"
    ? null
    : JSON.stringify(selectedVariantIds);
  const defaultTags = parseTags(profile.defaultTags);
  const shouldApplyTags = Boolean(payload.applyShopifyTags && productGid && !payload.skipShopifyLink);

  const productionMode = payload.productionMode || profile.productionMode || "in_house";
  const minQuantity = positiveInt(payload.minQuantity, profile.minQuantity || 1);
  const defaultQuantity = Math.max(minQuantity, positiveInt(payload.defaultQuantity, profile.defaultQuantity || minQuantity));
  const marginPct = numberOrZero(payload.targetMarginPct || profile.defaultMarginPct || 40);
  const fallbackTiers = parseNumberLines(profile.tierBreakpoints, [minQuantity]).filter((qty) => qty >= minQuantity);
  const profileTemplateRows = parseTierTemplate(profile.tierTemplate, fallbackTiers, marginPct);
  const tierRows = parseTierRows(payload.tierRows || payload.tierBreakpoints || profile.tierTemplate, fallbackTiers, marginPct)
    .filter((row) => row.minQty >= minQuantity);
  const tiers = tierRows.map((row) => row.minQty);
  const pricingMethod = payload.pricingMethod || profile.pricingMethod || "auto_margin";

  let vendorProductId = payload.vendorProductId || null;
  const existingRecipe = productGid
    ? await db.productRecipe.findFirst({
        where: {
          shop,
          OR: [
            variantGid ? { variantGid } : undefined,
            variantGid ? { shopifyVariantId: variantGid } : undefined,
            { productGid, shopifyTargetMode },
            { shopifyProductId: productGid, shopifyTargetMode },
          ].filter(Boolean) as any,
        },
      })
    : null;

  let recipeId = existingRecipe?.id || "";

  await db.$transaction(async (tx) => {
    if (productionMode === "outsourced" || productionMode === "hybrid") {
      const vendorName = String(payload.vendorName || "").trim();
      const vendorProductName = String(payload.vendorProductName || productName).trim();
      const fallbackUnitCost = numberOrZero(payload.vendorFallbackUnitCost);
      const vendorTiers = parseVendorCostTiers(payload.vendorTierRows || payload.vendorCostTiers, tierRows.map((row) => ({ ...row, minQty: String(row.minQty), maxQty: row.maxQty ? String(row.maxQty) : "" })), fallbackUnitCost);
      const addOns = parseAddOns(payload.vendorAddOns);

      if (!vendorProductId && existingRecipe?.vendorProductId) {
        vendorProductId = existingRecipe.vendorProductId;
      }

      if (vendorProductId) {
        await tx.vendorProduct.updateMany({
          where: { id: vendorProductId, shop },
          data: {
            name: vendorProductName,
            productType: profile.key,
            vendor: vendorName || null,
            vendorSku: payload.vendorSku || null,
            moq: minQuantity,
            defaultUnitCost: fallbackUnitCost || vendorTiers[0]?.unitCost || 0,
            leadTimeDays: nullableInt(payload.leadTimeDays),
            notes: payload.vendorNotes || null,
          },
        });
        await tx.vendorProductTier.deleteMany({ where: { vendorProductId, shop } });
        await tx.vendorProductAddOn.deleteMany({ where: { vendorProductId, shop } });
        await tx.vendorProductTier.createMany({ data: vendorTiers.map((tier) => ({ shop, vendorProductId, ...tier })) });
        if (addOns.length) {
          await tx.vendorProductAddOn.createMany({ data: addOns.map((addOn) => ({ shop, vendorProductId, ...addOn })) });
        }
      } else {
        const vendorProduct = await tx.vendorProduct.create({
          data: {
            shop,
            name: vendorProductName,
            productType: profile.key,
            vendor: vendorName || null,
            vendorSku: payload.vendorSku || null,
            moq: minQuantity,
            defaultUnitCost: fallbackUnitCost || vendorTiers[0]?.unitCost || 0,
            leadTimeDays: nullableInt(payload.leadTimeDays),
            notes: payload.vendorNotes || null,
            tiers: { create: vendorTiers.map((tier) => ({ shop, ...tier })) },
            addOns: { create: addOns.map((addOn) => ({ shop, ...addOn })) },
          },
        });
        vendorProductId = vendorProduct.id;
      }
    }

    const recipeData = {
      productTypeProfileId: profile.id,
      name: productName,
      sku: payload.sku || selectedShopifyProduct?.sku || null,
      productType: profile.key,
      productionMode,
      vendorProductId: vendorProductId || null,
      productGid,
      variantGid,
      shopifyProductId: productGid,
      shopifyVariantId: variantGid,
      shopifyTargetMode,
      shopifyVariantIds,
      widthIn: nullableNumber(payload.widthIn),
      heightIn: nullableNumber(payload.heightIn),
      depthIn: nullableNumber(payload.depthIn),
      minQuantity,
      defaultQuantity,
      targetMarginPct: marginPct,
      wastePct: numberOrZero(payload.wastePct),
      baseCmykCoveragePct: numberOrZero(payload.baseCmykCoveragePct || 40),
      inkAllowancePct: numberOrZero(payload.inkAllowancePct || 15),
      maintenanceCostPerSqft: numberOrZero(payload.maintenanceCostPerSqft || 0.08),
      machineRecoveryCostPerSqft: numberOrZero(payload.machineRecoveryCostPerSqft || 0.05),
      operatorLaborPct: numberOrZero(payload.operatorLaborPct || 25),
      notes: [
        payload.notes || "",
        selectedShopifyProduct?.productTitle ? `Shopify product: ${selectedShopifyProduct.productTitle}` : "",
        productGid && !payload.skipShopifyLink ? `Shopify target: ${shopifyTargetMode === "selected_variants" ? "Selected variant(s)" : "All variants"}` : "",
        selectedVariantLabels.length ? `Selected variants: ${selectedVariantLabels.join(", ")}` : "",
        profile.defaultTags ? `Default Shopify tags: ${profile.defaultTags}` : "",
        `Pricing method: ${pricingMethod}`,
        `Created/updated from Product Setup Wizard`,
      ]
        .filter(Boolean)
        .join("\n"),
    } as any;

    if (existingRecipe) {
      await tx.productRecipe.update({ where: { id: existingRecipe.id }, data: recipeData });
      recipeId = existingRecipe.id;
      await tx.recipeTier.deleteMany({ where: { recipeId, shop } });
      await tx.recipeMaterial.deleteMany({ where: { recipeId, shop } });
      await tx.recipeMachineRule.deleteMany({ where: { recipeId, shop } });
    } else {
      const recipe = await tx.productRecipe.create({ data: { shop, ...recipeData } });
      recipeId = recipe.id;
    }

    await tx.recipeTier.createMany({
      data: tierRows.map((row) => ({
        shop,
        recipeId,
        minQty: row.minQty,
        maxQty: row.maxQty,
        marginPct: row.marginPct ?? marginPct,
        fixedPrice: row.fixedPrice,
      })),
    });

    if (productionMode === "in_house" || productionMode === "hybrid") {
      const materialRows = [] as any[];
      if (payload.mediaMaterialId) {
        materialRows.push({
          shop,
          recipeId,
          materialId: payload.mediaMaterialId,
          usageType: "media",
          quantity: 1,
          unit: "sqft",
          wastePct: numberOrZero(payload.wastePct),
        });
      }
      if (payload.laminateMaterialId) {
        materialRows.push({
          shop,
          recipeId,
          materialId: payload.laminateMaterialId,
          usageType: "laminate",
          quantity: 1,
          unit: "sqft",
          wastePct: numberOrZero(payload.wastePct),
        });
      }
      if (materialRows.length) await tx.recipeMaterial.createMany({ data: materialRows });

      if (payload.machineId) {
        await tx.recipeMachineRule.create({
          data: {
            shop,
            recipeId,
            preferredMachineId: payload.machineId,
            requiredInkTypes: profile.key === "label" ? "cmyk,white,gloss" : "cmyk",
            allowOverflow: false,
          },
        });
      }
    }
  });

  let tagSync: any = null;
  if (shouldApplyTags) {
    tagSync = await applyShopifyTags(admin, productGid, selectedShopifyProduct?.tags || [], defaultTags);
  }

  return Response.json({
    ok: true,
    recipeId,
    updatedExisting: Boolean(existingRecipe),
    tagSync,
  });
}

function profileDefaults(profile: any) {
  const fallback = productTypeDefaults[profile?.key] || productTypeDefaults.general;
  const minQuantity = positiveInt(profile?.minQuantity, fallback.minQuantity);
  const margin = numberOrZero(profile?.defaultMarginPct || fallback.defaultMarginPct);
  const fallbackBreakpoints = parseNumberLines(profile?.tierBreakpoints, fallback.tiers).filter((qty) => qty >= minQuantity);
  const profileTierRows = parseTierTemplate(profile?.tierTemplate, fallbackBreakpoints, margin);
  const generatedTierRows = suggestedTierRowsFromMin(minQuantity, margin, profileTierRows);

  return {
    productionMode: profile?.productionMode || fallback.productionMode,
    minQuantity,
    defaultQuantity: Math.max(minQuantity, positiveInt(profile?.defaultQuantity, fallback.defaultQuantity)),
    tiers: generatedTierRows.map((row) => positiveInt(row.minQty, minQuantity)),
    tierRows: generatedTierRows,
    profileTierRows,
    margin,
    pricingMethod: profile?.pricingMethod || fallback.pricingMethod,
    tags: profile?.defaultTags || fallback.defaultTags.join(", "),
  };
}

function selectOptions(items: any[], labelKey = "name") {
  return [emptyOption, ...items.map((item) => ({ label: item[labelKey] || item.name || item.id, value: item.id }))];
}

function getBestVendorTier(vendorProduct: any, quantity: number) {
  const tiers = [...(vendorProduct?.tiers || [])].sort((a: any, b: any) => a.minQty - b.minQty);
  let best = tiers[0];
  for (const tier of tiers) {
    if (quantity >= tier.minQty) best = tier;
  }
  return best || { minQty: quantity, unitCost: numberOrZero(vendorProduct?.defaultUnitCost) };
}

function getAddOnUnitCost(vendorProduct: any, quantity: number) {
  let addOnCost = 0;
  for (const addOn of vendorProduct?.addOns || []) {
    if (!addOn.enabled) continue;
    if (addOn.pricingType === "per_unit") addOnCost += numberOrZero(addOn.amount);
    if (addOn.pricingType === "flat_fee") addOnCost += numberOrZero(addOn.amount) / Math.max(1, quantity);
  }
  return addOnCost;
}

function getBestVendorTierRow(rows: VendorTierSetupRow[], quantity: number) {
  const sorted = cleanVendorTierRows(rows, [], 0)
    .map((row) => ({
      minQty: positiveInt(row.minQty, 1),
      maxQty: nullableIntValue(row.maxQty),
      unitCost: numberOrZero(row.unitCost),
    }))
    .sort((a, b) => a.minQty - b.minQty);

  let best = sorted[0];
  for (const row of sorted) {
    if (quantity >= row.minQty && (!row.maxQty || quantity <= row.maxQty)) return row;
    if (quantity >= row.minQty) best = row;
  }
  return best || { minQty: quantity, maxQty: null, unitCost: 0 };
}

export default function ProductSetupPage() {
  const { profiles, materials, machines, vendorProducts, recentRecipes, shopifyProducts: initialShopifyProducts } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const [shopifyProducts, setShopifyProducts] = useState<ShopifyProductOption[]>(initialShopifyProducts || []);
  const [shopifySearch, setShopifySearch] = useState("");
  const [hasSearchedShopify, setHasSearchedShopify] = useState(false);
  const [selectedShopifyProductId, setSelectedShopifyProductId] = useState("");
  const [shopifyTargetMode, setShopifyTargetMode] = useState("product_all_variants");
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([]);
  const [skipShopifyLink, setSkipShopifyLink] = useState(false);
  const [applyShopifyTags, setApplyShopifyTags] = useState(true);

  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [profileId, setProfileId] = useState(profiles?.[0]?.id || "");
  const selectedProfile = useMemo(() => profiles.find((profile: any) => profile.id === profileId), [profiles, profileId]);
  const defaults = useMemo(() => profileDefaults(selectedProfile), [selectedProfile]);

  const [productionMode, setProductionMode] = useState(defaults.productionMode);
  const [minQuantity, setMinQuantity] = useState(String(defaults.minQuantity));
  const [defaultQuantity, setDefaultQuantity] = useState(String(defaults.defaultQuantity));
  const [minimumSource, setMinimumSource] = useState("Product type profile");
  const [tierRows, setTierRows] = useState<TierSetupRow[]>(() => defaults.tierRows);
  const [useProfileMargins, setUseProfileMargins] = useState(true);
  const [targetMarginPct, setTargetMarginPct] = useState(String(defaults.margin));
  const [pricingMethod, setPricingMethod] = useState(defaults.pricingMethod);

  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [depthIn, setDepthIn] = useState("");
  const [mediaMaterialId, setMediaMaterialId] = useState("");
  const [laminateMaterialId, setLaminateMaterialId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [wastePct, setWastePct] = useState("10");

  const [vendorProductId, setVendorProductId] = useState("");
  const [vendorProductName, setVendorProductName] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorFallbackUnitCost, setVendorFallbackUnitCost] = useState("");
  const [vendorTierRows, setVendorTierRows] = useState<VendorTierSetupRow[]>(() => cleanVendorTierRows([], defaults.tierRows, 0));
  const [vendorAddOns, setVendorAddOns] = useState("Gloss finish | per_unit | 0.08\nSetup fee | flat_fee | 75\nFreight | flat_fee | 120");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [notes, setNotes] = useState("");

  const selectedShopifyProduct = shopifyProducts.find((product) => product.productId === selectedShopifyProductId) || null;
  const selectedVariants = selectedShopifyProduct?.variants?.filter((variant) => selectedVariantIds.includes(variant.id)) || [];

  useEffect(() => {
    setProductionMode(defaults.productionMode);
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setMinimumSource("Product type profile");
    setTierRows(defaults.tierRows);
    setUseProfileMargins(true);
    setTargetMarginPct(String(defaults.margin));
    setPricingMethod(defaults.pricingMethod);
    setVendorTierRows(cleanVendorTierRows([], defaults.tierRows, numberOrZero(vendorFallbackUnitCost)));
  }, [profileId]);

  useEffect(() => {
    if (selectedShopifyProduct && !skipShopifyLink) {
      setProductName((current) => current || selectedShopifyProduct.productTitle);
      if (selectedVariants.length === 1) {
        setSku((current) => current || selectedVariants[0].sku);
      }
    }
  }, [selectedShopifyProductId, selectedVariantIds.join("|")]);

  useEffect(() => {
    if (!selectedShopifyProduct || skipShopifyLink) return;
    const inferred = inferMinQuantityFromSelectedProduct(selectedShopifyProduct, selectedVariantIds, shopifyTargetMode);
    if (!inferred.value) return;
    applyMinimumAndSuggestedTiers(inferred.value, inferred.source || "Shopify product");
  }, [selectedShopifyProductId, shopifyTargetMode, selectedVariantIds.join("|")]);

  useEffect(() => {
    if (fetcher.data?.shopifyProducts) {
      setShopifyProducts(fetcher.data.shopifyProducts);
      setSelectedShopifyProductId("");
      setSelectedVariantIds([]);
    }
    if (fetcher.data?.ok && fetcher.data?.recipeId) {
      setProductName("");
      setSku("");
      setVendorProductName("");
      setVendorName("");
      setVendorSku("");
      setVendorFallbackUnitCost("");
      setVendorTierRows(cleanVendorTierRows([], defaults.tierRows, numberOrZero(vendorFallbackUnitCost)));
      setNotes("");
    }
  }, [fetcher.data]);

  const quantity = positiveInt(defaultQuantity, defaults.defaultQuantity);
  const cleanRows = cleanTierRows(tierRows, defaults.tiers, numberOrZero(targetMarginPct || defaults.margin));
  const tierList = cleanRows.map((row) => row.minQty);
  const selectedVendorProduct = vendorProducts.find((item: any) => item.id === vendorProductId);
  const bestVendorTier = getBestVendorTier(selectedVendorProduct, quantity);
  const cleanVendorRows = cleanVendorTierRows(vendorTierRows, cleanRows.map((row) => ({
    minQty: String(row.minQty),
    maxQty: row.maxQty ? String(row.maxQty) : "",
    marginPct: String(row.marginPct ?? targetMarginPct),
    fixedPrice: row.fixedPrice ? String(row.fixedPrice) : "",
  })), numberOrZero(vendorFallbackUnitCost));
  const bestVendorRow = getBestVendorTierRow(cleanVendorRows, quantity);
  const vendorPreviewCost = selectedVendorProduct
    ? numberOrZero(bestVendorTier.unitCost) + getAddOnUnitCost(selectedVendorProduct, quantity)
    : numberOrZero(bestVendorRow.unitCost || vendorFallbackUnitCost);
  const estimatedPrice = marginPrice(vendorPreviewCost, numberOrZero(targetMarginPct));

  const profileOptions = profiles.map((profile: any) => ({ label: profile.name, value: profile.id }));
  const materialOptions = selectOptions(materials);
  const machineOptions = selectOptions(machines);
  const vendorOptions = selectOptions(vendorProducts);
  const shopifySearchInProgress = fetcher.state !== "idle" && fetcher.json?.intent === "searchShopifyProducts";
  const hasValidShopifyTarget = skipShopifyLink || Boolean(
    selectedShopifyProduct &&
      (shopifyTargetMode === "product_all_variants" || selectedVariantIds.length > 0),
  );
  const selectedShopifyPayload = selectedShopifyProduct
    ? {
        productId: selectedShopifyProduct.productId,
        productTitle: selectedShopifyProduct.productTitle,
        tags: selectedShopifyProduct.tags,
        targetMode: shopifyTargetMode,
        variantIds: shopifyTargetMode === "selected_variants" ? selectedVariantIds : [],
        variants: selectedVariants,
      }
    : null;
  const isOutsourced = productionMode === "outsourced";
  const isInHouse = productionMode === "in_house";
  const isHybrid = productionMode === "hybrid";

  function buildSuggestedRows(minQty: number) {
    return suggestedTierRowsFromMin(minQty, numberOrZero(targetMarginPct || defaults.margin), defaults.profileTierRows || defaults.tierRows);
  }

  function applyMinimumAndSuggestedTiers(value: any, source = "Product type profile") {
    const requestedMin = positiveInt(value, defaults.minQuantity || 64);
    const profileFloor = positiveInt(defaults.minQuantity, 64);
    const min = Math.max(requestedMin, profileFloor);
    const suggestedRows = buildSuggestedRows(min);
    setMinimumSource(min > requestedMin ? `${source}; raised to ${min} by product type minimum` : source);
    setMinQuantity(String(min));
    setDefaultQuantity(String(Math.max(min, positiveInt(defaultQuantity, min))));
    setTierRows(suggestedRows);
    setVendorTierRows(cleanVendorTierRows([], suggestedRows, numberOrZero(vendorFallbackUnitCost)));
  }

  function regenerateTiersFromCurrentMinimum() {
    applyMinimumAndSuggestedTiers(minQuantity, "Manual regenerate from current minimum");
  }

  function syncVendorRowsFromPricingRows() {
    setVendorTierRows((current) => cleanVendorTierRows(current, cleanRows.map((row) => ({
      minQty: String(row.minQty),
      maxQty: row.maxQty ? String(row.maxQty) : "",
      marginPct: String(row.marginPct ?? targetMarginPct),
      fixedPrice: row.fixedPrice ? String(row.fixedPrice) : "",
    })), numberOrZero(vendorFallbackUnitCost)));
  }

  function searchProducts() {
    setHasSearchedShopify(true);
    setShopifyProducts([]);
    setSelectedShopifyProductId("");
    setSelectedVariantIds([]);
    fetcher.submit(
      { intent: "searchShopifyProducts", search: shopifySearch },
      { method: "post", encType: "application/json" },
    );
  }

  function chooseShopifyProduct(product: ShopifyProductOption) {
    setSelectedShopifyProductId(product.productId);
    setShopifyTargetMode("product_all_variants");
    setSelectedVariantIds([]);
    setProductName((current) => current || product.productTitle);
  }

  function toggleVariant(variantId: string, checked: boolean) {
    setSelectedVariantIds((current) => {
      if (checked) return Array.from(new Set([...current, variantId]));
      return current.filter((id) => id !== variantId);
    });
  }

  function updateTierRow(index: number, field: keyof TierSetupRow, value: string) {
    setTierRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  }

  function addTierRow() {
    const lastQty = tierList.length ? tierList[tierList.length - 1] : positiveInt(minQuantity, 1);
    const newQty = lastQty >= 1000 ? lastQty + 1000 : lastQty >= 100 ? lastQty + 250 : lastQty * 2;
    setTierRows((current) => [...current, { minQty: String(newQty), maxQty: "", marginPct: targetMarginPct, fixedPrice: "" }]);
  }

  function removeTierRow(index: number) {
    setTierRows((current) => current.length <= 1 ? current : current.filter((_row, rowIndex) => rowIndex !== index));
  }

  function updateVendorTierRow(index: number, field: keyof VendorTierSetupRow, value: string) {
    setVendorTierRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  }

  function addVendorTierRow() {
    const lastRow = cleanVendorRows[cleanVendorRows.length - 1];
    const lastQty = positiveInt(lastRow?.minQty, positiveInt(minQuantity, 1));
    const newQty = lastQty >= 1000 ? lastQty + 1000 : lastQty >= 100 ? lastQty + 250 : lastQty * 2;
    setVendorTierRows((current) => [...current, { minQty: String(newQty), maxQty: "", unitCost: "", notes: "" }]);
  }

  function removeVendorTierRow(index: number) {
    setVendorTierRows((current) => current.length <= 1 ? current : current.filter((_row, rowIndex) => rowIndex !== index));
  }

  function submit() {
    fetcher.submit(
      {
        intent: "quickCreateProduct",
        selectedShopifyProduct: selectedShopifyPayload,
        shopifyTargetMode,
        selectedVariantIds,
        skipShopifyLink,
        applyShopifyTags,
        productName,
        sku,
        productTypeProfileId: profileId,
        productionMode,
        minQuantity,
        defaultQuantity,
        tierRows: cleanRows,
        targetMarginPct,
        pricingMethod,
        widthIn,
        heightIn,
        depthIn,
        mediaMaterialId,
        laminateMaterialId,
        machineId,
        wastePct,
        vendorProductId,
        vendorProductName: vendorProductName || productName,
        vendorName,
        vendorSku,
        vendorFallbackUnitCost,
        vendorTierRows: cleanVendorRows,
        vendorAddOns,
        leadTimeDays,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  const tagPreview = parseTags(defaults.tags);
  const modeLabel = productionModeOptions.find((item) => item.value === productionMode)?.label || productionMode;
  const productSetupComplete = Boolean(productName && profileId && hasValidShopifyTarget);

  return (
    <Page
      title="Product Setup / Pricing Wizard"
      subtitle="The easy front door: link Shopify, choose product type, enter only needed costs, and let the app create recipes, tiers, and vendor records."
      backAction={{ content: "Command Center", onAction: () => navigate("/app") }}
      primaryAction={{ content: "Advanced Recipes", onAction: () => navigate("/app/erp/recipes") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">1. Link or name the product</Text>
                  <Text as="p" tone="subdued">Search Shopify when the product already exists. Check the box when it is a new product that is not in Shopify yet.</Text>
                </BlockStack>
                <Badge tone={selectedShopifyProduct || skipShopifyLink ? "success" : undefined}>{selectedShopifyProduct ? "Linked" : skipShopifyLink ? "Internal only" : "Needs product"}</Badge>
              </InlineStack>

              <Checkbox
                label="This is a new product / not in Shopify yet"
                checked={skipShopifyLink}
                onChange={setSkipShopifyLink}
              />

              {!skipShopifyLink ? (
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="end" wrap>
                    <div style={{ minWidth: 260, flex: 1 }}>
                      <TextField
                        label="Search Shopify products"
                        value={shopifySearch}
                        onChange={setShopifySearch}
                        autoComplete="off"
                        placeholder="Example: 4x5 Custom Pouch"
                        helpText="Search by product title or SKU. Results stay empty until you search so random products do not get selected by mistake."
                      />
                    </div>
                    <Button onClick={searchProducts} loading={shopifySearchInProgress}>Search</Button>
                  </InlineStack>

                  {hasSearchedShopify && !shopifySearchInProgress && !shopifyProducts.length ? (
                    <Text as="p" tone="critical">No matching Shopify products found. Try fewer words, the SKU, or check “new product / not in Shopify yet.”</Text>
                  ) : null}

                  {shopifyProducts.length ? (
                    <BlockStack gap="300">
                      {shopifyProducts.map((product) => {
                        const isSelected = product.productId === selectedShopifyProductId;
                        return (
                          <Card key={product.productId}>
                            <BlockStack gap="300">
                              <InlineStack align="space-between" blockAlign="start" wrap>
                                <BlockStack gap="100">
                                  <Text as="p" fontWeight="bold">{product.productTitle}</Text>
                                  <Text as="p" tone="subdued">{product.variants.length} variant{product.variants.length === 1 ? "" : "s"}{product.minQuantityHint ? ` · Shopify min ${product.minQuantityHint}` : ""} · Tags: {(product.tags || []).join(", ") || "No tags yet"}</Text>
                                </BlockStack>
                                <Button variant={isSelected ? "primary" : undefined} onClick={() => chooseShopifyProduct(product)}>
                                  {isSelected ? "Selected" : "Use this product"}
                                </Button>
                              </InlineStack>

                              {isSelected ? (
                                <BlockStack gap="300">
                                  <Select
                                    label="Apply this setup to"
                                    options={[
                                      { label: "All variants on this product", value: "product_all_variants" },
                                      { label: "Only selected variant(s)", value: "selected_variants" },
                                    ]}
                                    value={shopifyTargetMode}
                                    onChange={(value) => {
                                      setShopifyTargetMode(value);
                                      if (value === "product_all_variants") setSelectedVariantIds([]);
                                    }}
                                  />

                                  {shopifyTargetMode === "selected_variants" ? (
                                    <BlockStack gap="200">
                                      {product.variants.map((variant) => (
                                        <Checkbox
                                          key={variant.id}
                                          label={`${variant.title || "Default"}${variant.sku ? ` · SKU ${variant.sku}` : ""}${variant.price ? ` · $${variant.price}` : ""}${variant.minQuantityHint ? ` · Min ${variant.minQuantityHint}` : ""}`}
                                          checked={selectedVariantIds.includes(variant.id)}
                                          onChange={(checked) => toggleVariant(variant.id, checked)}
                                        />
                                      ))}
                                      {!selectedVariantIds.length ? <Text as="p" tone="critical">Choose at least one variant or switch back to all variants.</Text> : null}
                                    </BlockStack>
                                  ) : null}
                                </BlockStack>
                              ) : null}
                            </BlockStack>
                          </Card>
                        );
                      })}
                    </BlockStack>
                  ) : null}

                  <Checkbox label="Apply GSO product type tags to Shopify on save" checked={applyShopifyTags} onChange={setApplyShopifyTags} />
                </BlockStack>
              ) : null}

              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 260, flex: 1 }}>
                  <TextField label="Product name" value={productName} onChange={setProductName} autoComplete="off" />
                </div>
                <div style={{ minWidth: 180, flex: 1 }}>
                  <TextField label="SKU optional" value={sku} onChange={setSku} autoComplete="off" />
                </div>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">2. Product type and production method</Text>
                  <Text as="p" tone="subdued">Product type profiles fill in the defaults so employees do not have to remember minimums, tags, margins, or tiers.</Text>
                </BlockStack>
                <Badge>{modeLabel}</Badge>
              </InlineStack>

              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 260, flex: 1 }}>
                  <Select label="Product type" options={profileOptions} value={profileId} onChange={setProfileId} />
                </div>
                <div style={{ minWidth: 260, flex: 1 }}>
                  <Select label="Production method" options={productionModeOptions} value={productionMode} onChange={setProductionMode} />
                </div>
              </InlineStack>

              <InlineStack gap="200" wrap>
                <Badge>{selectedProfile?.name || "Product type"}</Badge>
                {tagPreview.map((tag) => <Badge key={tag}>{tag}</Badge>)}
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start" wrap>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">3. Quantity tiers and pricing rules</Text>
                  <Text as="p" tone="subdued">Tiers are now ranges. The minimum quantity drives the suggested ranges, and margins come from the product type profile unless you choose to override them.</Text>
                </BlockStack>
                <Badge>{minimumSource}</Badge>
              </InlineStack>

              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Minimum quantity" type="number" value={minQuantity} onChange={setMinQuantity} autoComplete="off" helpText="If Shopify has a GSO/custom min quantity metafield or MOQ tag, the app pulls it in automatically." />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Default quote quantity" type="number" value={defaultQuantity} onChange={setDefaultQuantity} autoComplete="off" />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Fallback margin %" type="number" value={targetMarginPct} onChange={setTargetMarginPct} autoComplete="off" helpText="Used only when a tier has no profile margin." />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap>
                <Button onClick={regenerateTiersFromCurrentMinimum}>Generate tier ranges from minimum</Button>
                <Checkbox label="Use product type profile margins" checked={useProfileMargins} onChange={setUseProfileMargins} />
              </InlineStack>

              <Select label="Default pricing method" options={pricingMethodOptions} value={pricingMethod} onChange={setPricingMethod} />
              <BlockStack gap="250">
                <Text as="p" tone="subdued">Example: stock bags/stickers start at 64 and become 64-199, 200-499, 500-749, 750-999, 1000-1999, 2000+. Boxes start at 500 and become 500-999, 1000-1999, 2000-2499, 2500-4999, 5000-7499, 7500-9999, 10000+. If a Shopify product has a higher minimum, the app uses the higher number.</Text>
                {tierRows.map((row, index) => (
                  <Card key={`${index}-${row.minQty}-${row.maxQty}`}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" fontWeight="semibold">Tier {index + 1}: {tierRangeLabel(row)}</Text>
                        <Button disabled={tierRows.length <= 1} onClick={() => removeTierRow(index)}>Remove</Button>
                      </InlineStack>
                      <InlineStack gap="300" blockAlign="end" wrap>
                        <div style={{ minWidth: 120, flex: 1 }}>
                          <TextField label="From qty" type="number" value={row.minQty} onChange={(value) => updateTierRow(index, "minQty", value)} autoComplete="off" />
                        </div>
                        <div style={{ minWidth: 120, flex: 1 }}>
                          <TextField label="To qty" type="number" value={row.maxQty} onChange={(value) => updateTierRow(index, "maxQty", value)} autoComplete="off" placeholder="No max" />
                        </div>
                        <div style={{ minWidth: 140, flex: 1 }}>
                          <TextField label="Margin %" type="number" value={row.marginPct} onChange={(value) => updateTierRow(index, "marginPct", value)} autoComplete="off" disabled={useProfileMargins} />
                        </div>
                        <div style={{ minWidth: 160, flex: 1 }}>
                          <TextField label="Fixed price optional" type="number" value={row.fixedPrice} onChange={(value) => updateTierRow(index, "fixedPrice", value)} autoComplete="off" prefix="$" disabled={useProfileMargins} />
                        </div>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                ))}
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Button onClick={addTierRow}>Add tier</Button>
                  <InlineStack gap="200" wrap>
                    {cleanRows.slice(0, 10).map((row) => <Badge key={`${row.minQty}-${row.maxQty}`}>{tierRangeLabel(row)}</Badge>)}
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>

          {(isInHouse || isHybrid) ? (
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">4. In-house production inputs</Text>
                <Text as="p" tone="subdued">Only show production inputs when GSO is making or finishing the item in-house.</Text>
                <InlineStack gap="300" wrap>
                  <div style={{ minWidth: 150, flex: 1 }}>
                    <TextField label="Width inches" type="number" value={widthIn} onChange={setWidthIn} autoComplete="off" />
                  </div>
                  <div style={{ minWidth: 150, flex: 1 }}>
                    <TextField label="Height inches" type="number" value={heightIn} onChange={setHeightIn} autoComplete="off" />
                  </div>
                  <div style={{ minWidth: 150, flex: 1 }}>
                    <TextField label="Depth/gusset optional" type="number" value={depthIn} onChange={setDepthIn} autoComplete="off" />
                  </div>
                  <div style={{ minWidth: 150, flex: 1 }}>
                    <TextField label="Waste %" type="number" value={wastePct} onChange={setWastePct} autoComplete="off" />
                  </div>
                </InlineStack>
                <Select label="Media material" options={materialOptions} value={mediaMaterialId} onChange={setMediaMaterialId} />
                <Select label="Laminate optional" options={materialOptions} value={laminateMaterialId} onChange={setLaminateMaterialId} />
                <Select label="Preferred machine" options={machineOptions} value={machineId} onChange={setMachineId} />
              </BlockStack>
            </Card>
          ) : null}

          {(isOutsourced || isHybrid) ? (
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">4. Vendor / outsourced cost inputs</Text>
                <Text as="p" tone="subdued">Outsourced products should use vendor tiers and add-ons, not fake media materials.</Text>
                <Select
                  label="Use existing vendor product optional"
                  options={vendorOptions}
                  value={vendorProductId}
                  onChange={setVendorProductId}
                  helpText="Leave blank to create or update one automatically from this setup."
                />
                {!vendorProductId ? (
                  <BlockStack gap="300">
                    <TextField label="Vendor product name" value={vendorProductName} onChange={setVendorProductName} autoComplete="off" />
                    <InlineStack gap="300" wrap>
                      <div style={{ minWidth: 180, flex: 1 }}>
                        <TextField label="Vendor" value={vendorName} onChange={setVendorName} autoComplete="off" />
                      </div>
                      <div style={{ minWidth: 180, flex: 1 }}>
                        <TextField label="Vendor SKU" value={vendorSku} onChange={setVendorSku} autoComplete="off" />
                      </div>
                      <div style={{ minWidth: 180, flex: 1 }}>
                        <TextField label="Fallback unit cost" type="number" value={vendorFallbackUnitCost} onChange={setVendorFallbackUnitCost} autoComplete="off" />
                      </div>
                      <div style={{ minWidth: 180, flex: 1 }}>
                        <TextField label="Lead time days" type="number" value={leadTimeDays} onChange={setLeadTimeDays} autoComplete="off" />
                      </div>
                    </InlineStack>
                    <BlockStack gap="250">
                      <InlineStack align="space-between" blockAlign="center" wrap>
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingSm">Vendor cost tiers</Text>
                          <Text as="p" tone="subdued">Use the same ranges as customer tiers. Enter the vendor cost each for every range you need.</Text>
                        </BlockStack>
                        <Button onClick={syncVendorRowsFromPricingRows}>Match pricing tier ranges</Button>
                      </InlineStack>
                      {vendorTierRows.map((row, index) => (
                        <Card key={`${index}-${row.minQty}-${row.maxQty}`}>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="p" fontWeight="semibold">Vendor tier {index + 1}: {tierRangeLabel(row)}</Text>
                              <Button disabled={vendorTierRows.length <= 1} onClick={() => removeVendorTierRow(index)}>Remove</Button>
                            </InlineStack>
                            <InlineStack gap="300" blockAlign="end" wrap>
                              <div style={{ minWidth: 110, flex: 1 }}>
                                <TextField label="From qty" type="number" value={row.minQty} onChange={(value) => updateVendorTierRow(index, "minQty", value)} autoComplete="off" />
                              </div>
                              <div style={{ minWidth: 110, flex: 1 }}>
                                <TextField label="To qty" type="number" value={row.maxQty} onChange={(value) => updateVendorTierRow(index, "maxQty", value)} autoComplete="off" placeholder="No max" />
                              </div>
                              <div style={{ minWidth: 130, flex: 1 }}>
                                <TextField label="Vendor cost each" type="number" value={row.unitCost} onChange={(value) => updateVendorTierRow(index, "unitCost", value)} autoComplete="off" prefix="$" />
                              </div>
                              <div style={{ minWidth: 180, flex: 2 }}>
                                <TextField label="Notes optional" value={row.notes} onChange={(value) => updateVendorTierRow(index, "notes", value)} autoComplete="off" />
                              </div>
                            </InlineStack>
                          </BlockStack>
                        </Card>
                      ))}
                      <Button onClick={addVendorTierRow}>Add vendor tier</Button>
                    </BlockStack>
                    <TextField
                      label="Vendor add-ons"
                      value={vendorAddOns}
                      onChange={setVendorAddOns}
                      multiline={5}
                      autoComplete="off"
                      helpText="One per line: name | per_unit/flat_fee/percent/included | amount"
                    />
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>
          ) : null}

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">5. Save setup</Text>
              {fetcher.data?.error ? <Text as="p" tone="critical">{fetcher.data.error}</Text> : null}
              {fetcher.data?.ok ? (
                <BlockStack gap="100">
                  <Text as="p" tone="success">Saved. {fetcher.data.updatedExisting ? "Existing recipe was updated." : "New recipe was created."}</Text>
                  {fetcher.data.tagSync && !fetcher.data.tagSync.ok ? (
                    <Text as="p" tone="critical">Recipe saved, but Shopify tags were not updated. The app likely needs write_products scope.</Text>
                  ) : null}
                  {fetcher.data.tagSync?.ok ? <Text as="p" tone="success">Shopify tags updated.</Text> : null}
                </BlockStack>
              ) : null}
              <TextField label="Internal notes optional" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />
              <InlineStack gap="300">
                <Button variant="primary" disabled={!productSetupComplete} loading={fetcher.state !== "idle"} onClick={submit}>
                  Save product setup
                </Button>
                <Button onClick={() => navigate("/app/quotes")}>Go to Quotes</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Setup health</Text>
              <InlineStack gap="200"><Badge tone={productSetupComplete ? "success" : undefined}>{productSetupComplete ? "Ready" : "Needs product"}</Badge><Badge>{modeLabel}</Badge></InlineStack>
              <Divider />
              <Text as="p"><strong>Creates or updates:</strong></Text>
              <Text as="p">Product Recipe</Text>
              {(isOutsourced || isHybrid) ? <Text as="p">Vendor Product + cost tiers/add-ons</Text> : null}
              {(isInHouse || isHybrid) ? <Text as="p">Recipe material links + machine rule</Text> : null}
              <Text as="p">Quantity tiers and target margin</Text>
              {!skipShopifyLink ? <Text as="p">Shopify product link and optional GSO tags</Text> : null}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Quick price preview</Text>
              {(isOutsourced || isHybrid) ? (
                <BlockStack gap="100">
                  <Text as="p">Quantity: {quantity}</Text>
                  <Text as="p">Estimated vendor cost each: {money(vendorPreviewCost)}</Text>
                  <Text as="p">Suggested price each: {money(estimatedPrice)}</Text>
                  <Text as="p">Suggested total: {dollars(estimatedPrice * quantity)}</Text>
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">In-house label and print costs are calculated in the recipe finish table after setup.</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recent recipes</Text>
              {recentRecipes.length ? recentRecipes.map((recipe: any) => (
                <BlockStack key={recipe.id} gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" fontWeight="semibold">{recipe.name}</Text>
                    <Badge>{recipe.active ? "Active" : "Archived"}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">{recipe.productTypeProfile?.name || recipe.productType} · Min {recipe.minQuantity}</Text>
                  <Divider />
                </BlockStack>
              )) : <Text as="p" tone="subdued">No recipes yet.</Text>}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
