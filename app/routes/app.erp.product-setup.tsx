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
};

type ShopifyProductOption = {
  productId: string;
  productTitle: string;
  handle: string;
  status: string;
  tags: string[];
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
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:stock-bags", "gso:outsourced", "gso:wholesale"],
  },
  box: {
    name: "Boxes",
    productionMode: "outsourced",
    minQuantity: 5,
    defaultQuantity: 5,
    tiers: [5, 10, 25, 50, 100, 250, 500],
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
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100, 250, 500],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:sourced-products", "gso:outsourced", "gso:wholesale"],
  },
  general: {
    name: "General",
    productionMode: "in_house",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100],
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
  marginPct: string;
  fixedPrice: string;
};

function makeTierRows(quantities: number[], marginPct: number): TierSetupRow[] {
  const rows = quantities.length ? quantities : [1];
  return rows.map((qty) => ({
    minQty: String(qty),
    marginPct: String(marginPct),
    fixedPrice: "",
  }));
}

function cleanTierRows(rows: any[], fallbackQuantities: number[], fallbackMarginPct: number) {
  const source = Array.isArray(rows) && rows.length
    ? rows
    : makeTierRows(fallbackQuantities, fallbackMarginPct);

  const cleaned = source
    .map((row) => ({
      minQty: positiveInt(row?.minQty, 0),
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

  return deduped.length
    ? deduped
    : [{ minQty: positiveInt(fallbackQuantities[0], 1), marginPct: fallbackMarginPct, fixedPrice: null }];
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
      parseNumberLines(value, fallbackQuantities).map((qty) => ({ minQty: String(qty), marginPct: String(fallbackMarginPct), fixedPrice: "" })),
      fallbackQuantities,
      fallbackMarginPct,
    );
  }

  return cleanTierRows([], fallbackQuantities, fallbackMarginPct);
}

function parseTags(value: any) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseVendorCostTiers(value: any, fallbackQty: number, fallbackCost: number) {
  const parsed = String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        minQty: positiveInt(parts[0], fallbackQty),
        unitCost: numberOrZero(parts[1]),
        notes: parts.slice(2).join(" | ") || null,
      };
    })
    .filter((item) => item.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  if (parsed.length) return parsed;
  return [{ minQty: fallbackQty, unitCost: numberOrZero(fallbackCost), notes: null }];
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
            variants(first: 100) {
              nodes {
                id
                title
                sku
                price
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

  return (json.data?.products?.nodes || []).map((product: any) => ({
    productId: product.id,
    productTitle: product.title,
    handle: product.handle || "",
    status: product.status || "",
    tags: product.tags || [],
    variants: (product.variants?.nodes || []).map((variant: any) => ({
      id: variant.id,
      title: variant.title || "Default Title",
      sku: variant.sku || "",
      price: String(variant.price || "0"),
    })),
  })) as ShopifyProductOption[];
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
  const tierRows = parseTierRows(payload.tierRows || payload.tierBreakpoints, fallbackTiers, marginPct)
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
      const vendorTiers = parseVendorCostTiers(payload.vendorCostTiers, minQuantity, fallbackUnitCost);
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
  return {
    productionMode: profile?.productionMode || fallback.productionMode,
    minQuantity,
    defaultQuantity: Math.max(minQuantity, positiveInt(profile?.defaultQuantity, fallback.defaultQuantity)),
    tiers: parseNumberLines(profile?.tierBreakpoints, fallback.tiers).filter((qty) => qty >= minQuantity),
    margin: numberOrZero(profile?.defaultMarginPct || fallback.defaultMarginPct),
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
  const [tierRows, setTierRows] = useState<TierSetupRow[]>(() => makeTierRows(defaults.tiers, defaults.margin));
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
  const [vendorCostTiers, setVendorCostTiers] = useState("");
  const [vendorAddOns, setVendorAddOns] = useState("Gloss finish | per_unit | 0.08\nSetup fee | flat_fee | 75\nFreight | flat_fee | 120");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [notes, setNotes] = useState("");

  const selectedShopifyProduct = shopifyProducts.find((product) => product.productId === selectedShopifyProductId) || null;
  const selectedVariants = selectedShopifyProduct?.variants?.filter((variant) => selectedVariantIds.includes(variant.id)) || [];

  useEffect(() => {
    setProductionMode(defaults.productionMode);
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierRows(makeTierRows(defaults.tiers, defaults.margin));
    setTargetMarginPct(String(defaults.margin));
    setPricingMethod(defaults.pricingMethod);
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
      setVendorCostTiers("");
      setNotes("");
    }
  }, [fetcher.data]);

  const quantity = positiveInt(defaultQuantity, defaults.defaultQuantity);
  const cleanRows = cleanTierRows(tierRows, defaults.tiers, numberOrZero(targetMarginPct || defaults.margin));
  const tierList = cleanRows.map((row) => row.minQty);
  const selectedVendorProduct = vendorProducts.find((item: any) => item.id === vendorProductId);
  const bestVendorTier = getBestVendorTier(selectedVendorProduct, quantity);
  const vendorPreviewCost = selectedVendorProduct
    ? numberOrZero(bestVendorTier.unitCost) + getAddOnUnitCost(selectedVendorProduct, quantity)
    : numberOrZero(vendorFallbackUnitCost);
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
    setTierRows((current) => [...current, { minQty: String(lastQty * 2), marginPct: targetMarginPct, fixedPrice: "" }]);
  }

  function removeTierRow(index: number) {
    setTierRows((current) => current.length <= 1 ? current : current.filter((_row, rowIndex) => rowIndex !== index));
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
        vendorCostTiers,
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
                                  <Text as="p" tone="subdued">{product.variants.length} variant{product.variants.length === 1 ? "" : "s"} · Tags: {(product.tags || []).join(", ") || "No tags yet"}</Text>
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
                                          label={`${variant.title || "Default"}${variant.sku ? ` · SKU ${variant.sku}` : ""}${variant.price ? ` · $${variant.price}` : ""}`}
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
              <Text as="h2" variant="headingMd">3. Quantity tiers and pricing rules</Text>
              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Minimum quantity" type="number" value={minQuantity} onChange={setMinQuantity} autoComplete="off" />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Default quote quantity" type="number" value={defaultQuantity} onChange={setDefaultQuantity} autoComplete="off" />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Target margin %" type="number" value={targetMarginPct} onChange={setTargetMarginPct} autoComplete="off" />
                </div>
              </InlineStack>
              <Select label="Default pricing method" options={pricingMethodOptions} value={pricingMethod} onChange={setPricingMethod} />
              <BlockStack gap="250">
                <Text as="p" tone="subdued">Stacked tiers are easier to review. The first/lowest quantity is the highest unit price. Use margin for auto pricing or fixed price to override a tier.</Text>
                {tierRows.map((row, index) => (
                  <Card key={`${index}-${row.minQty}`}>
                    <InlineStack gap="300" blockAlign="end" wrap>
                      <div style={{ minWidth: 120, flex: 1 }}>
                        <TextField label="Qty" type="number" value={row.minQty} onChange={(value) => updateTierRow(index, "minQty", value)} autoComplete="off" />
                      </div>
                      <div style={{ minWidth: 140, flex: 1 }}>
                        <TextField label="Margin %" type="number" value={row.marginPct} onChange={(value) => updateTierRow(index, "marginPct", value)} autoComplete="off" />
                      </div>
                      <div style={{ minWidth: 160, flex: 1 }}>
                        <TextField label="Fixed price optional" type="number" value={row.fixedPrice} onChange={(value) => updateTierRow(index, "fixedPrice", value)} autoComplete="off" prefix="$" />
                      </div>
                      <Button disabled={tierRows.length <= 1} onClick={() => removeTierRow(index)}>Remove</Button>
                    </InlineStack>
                  </Card>
                ))}
                <InlineStack gap="300">
                  <Button onClick={addTierRow}>Add tier</Button>
                  <InlineStack gap="200" wrap>
                    {tierList.slice(0, 10).map((qty) => <Badge key={qty}>{qty}</Badge>)}
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
                    <TextField
                      label="Vendor cost tiers"
                      value={vendorCostTiers}
                      onChange={setVendorCostTiers}
                      multiline={5}
                      autoComplete="off"
                      helpText="One per line: quantity | unit cost. Example: 100 | 0.42"
                    />
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
