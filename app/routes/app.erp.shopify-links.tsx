import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PRODUCT_SEARCH_LIMIT = 25;
const COLLECTION_SEARCH_LIMIT = 10;
const COLLECTION_BATCH_SIZE = 25;
const COLLECTION_SCAN_PAGE_SIZE = 50;
const VARIANT_FETCH_LIMIT = 100;
const GROUP_ROW_PREVIEW_LIMIT = 0;
const INSPECT_ROW_LIMIT = 75;
const ALLOWED_EXCEPTION_MARKER = "[ALLOWED_SHOPIFY_LINK_EXCEPTION]";

const STICKER_BAG_RULE_PRESET = {
  name: "Sticker Bag Variant Rules",
  sideSingle: ["Single", "Single Sided", "1 Sided", "One Side", "Front Only"],
  sideDouble: ["Double", "Double Sided", "2 Sided", "Two Sided", "Front + Back", "Both Sides"],
  mediaMatte: ["Matte", "Matt"],
  mediaGloss: ["Gloss", "Glossy"],
  mediaHolographic: ["Holographic", "Holo"],
  colors: ["Black", "Green", "Lime Green", "Orange", "Purple", "Teal", "White", "Clear"],
};

function normalize(value: any) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function selectedOptionsText(options: any[] = []) {
  return (options || []).map((option) => `${option?.name || ""}: ${option?.value || ""}`).join(" / ");
}

function matchesAny(text: string, terms: string[]) {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function hasWord(text: string, word: string) {
  return normalize(text).split(" ").includes(normalize(word));
}

function pickSideModeFromVariantText(text: string) {
  const normalized = normalize(text);
  const isDouble =
    matchesAny(normalized, ["double sided", "2 sided", "two sided", "front back", "front and back", "both sides", "double side", "two side"]) ||
    hasWord(normalized, "double");
  const isSingle =
    matchesAny(normalized, ["single sided", "1 sided", "one sided", "front only", "single side", "one side"]) ||
    hasWord(normalized, "single");

  if (isDouble) {
    return { sideMode: "double_same", useFrontZone: true, useBackZone: true, backMediaMode: "same_as_front", detected: true };
  }
  if (isSingle) {
    return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none", detected: true };
  }
  return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none", detected: false };
}

function mediaAliasesForOption(option: any) {
  const values = [option?.name, option?.material?.name, option?.notes];
  const text = values.filter(Boolean).join(" ");
  const aliases = new Set<string>();
  if (text) aliases.add(text);

  if (matchesAny(text, ["holographic", "holo"])) {
    ["holographic", "holo", "premium"].forEach((value) => aliases.add(value));
  }
  if (matchesAny(text, ["matte", "matt"])) {
    ["matte", "matt"].forEach((value) => aliases.add(value));
  }
  if (matchesAny(text, ["gloss", "glossy"])) {
    ["gloss", "glossy"].forEach((value) => aliases.add(value));
  }

  return Array.from(aliases);
}

function pickMediaOptionFromVariantText(text: string, mediaOptions: any[] = []) {
  const activeOptions = (mediaOptions || []).filter((option: any) => option.active !== false);
  const normalized = normalize(text);

  const directTerms = [
    { terms: ["holographic", "holo"], keyword: "holo" },
    { terms: ["matte", "matt"], keyword: "matte" },
    { terms: ["gloss", "glossy"], keyword: "gloss" },
  ];

  for (const group of directTerms) {
    if (group.terms.some((term) => normalized.includes(normalize(term)))) {
      const match = activeOptions.find((option: any) => mediaAliasesForOption(option).some((alias) => normalize(alias).includes(group.keyword)));
      if (match) return match;
    }
  }

  for (const option of activeOptions) {
    if (mediaAliasesForOption(option).some((alias) => normalized.includes(normalize(alias)))) return option;
  }

  return activeOptions.find((option: any) => option.defaultOption) || activeOptions[0] || null;
}

function pickBagColorFromSelectedOptions(selectedOptions: any[] = [], text = "") {
  const colorTerms = [
    "black", "white", "clear", "gold", "silver", "red", "blue", "green", "purple", "pink",
    "orange", "yellow", "brown", "kraft", "mylar", "mixed", "assorted"
  ];

  for (const option of selectedOptions || []) {
    const optionName = normalize(option?.name);
    const optionValue = String(option?.value || "").trim();
    const normalizedValue = normalize(optionValue);
    if (!optionValue) continue;
    if (optionName.includes("color") || optionName.includes("colour") || optionName.includes("bag")) return optionValue;
    if (colorTerms.some((color) => normalizedValue === normalize(color) || normalizedValue.includes(normalize(color)))) return optionValue;
  }

  const normalizedText = normalize(text);
  const found = colorTerms.find((color) => normalizedText.includes(normalize(color)));
  return found ? found.replace(/\b\w/g, (char) => char.toUpperCase()) : "Any";
}

function autoMapShopifyVariant(variant: any, recipe: any, product?: any, sourceLabel?: string) {
  const selectedOptions = variant?.selectedOptions || [];
  const text = `${variant?.title || ""} / ${selectedOptionsText(selectedOptions)} / ${variant?.sku || ""}`;
  const side = pickSideModeFromVariantText(text);
  const mediaOption = pickMediaOptionFromVariantText(text, recipe?.mediaOptions || []);
  const bagColor = pickBagColorFromSelectedOptions(selectedOptions, text);

  const needsReview: string[] = [];
  if (!side.detected) needsReview.push("side count");
  if (!mediaOption) needsReview.push("media option");
  if (bagColor === "Any" && matchesAny(text, ["color", "colour", "bag color"])) needsReview.push("bag color");

  const productTitle = product?.title || "Unknown product";
  const sourceText = sourceLabel ? `Source: ${sourceLabel}. ` : "";

  return {
    name: variant?.title ? `Auto - ${variant.title}` : "Auto-mapped Shopify variant",
    shopifyVariantTitle: variant?.title || "",
    sku: variant?.sku || "",
    sideMode: side.sideMode,
    bagColor,
    frontMediaOptionId: mediaOption?.id || null,
    backMediaMode: side.backMediaMode,
    backMediaOptionId: null,
    useFrontZone: side.useFrontZone,
    useBackZone: side.useBackZone,
    notes: `${sourceText}Product: ${productTitle}. ${needsReview.length
      ? `Needs review: ${needsReview.join(", ")}. `
      : ""}Auto-synced from Shopify Links. Quantities are handled by pricing templates, not Shopify variants.`,
  };
}

function extractProductTitleFromNotes(notes: string) {
  const match = String(notes || "").match(/Product:\s*([^\.]+)\./i);
  return match?.[1]?.trim() || "";
}

async function searchShopifyProducts(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query ProductRecipeProductSearch($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              handle
              totalVariants
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: safeQuery, first: PRODUCT_SEARCH_LIMIT } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  return payload?.data?.products?.edges?.map((edge: any) => ({
    ...edge.node,
    sampleVariants: edge.node?.variants?.edges?.map((variantEdge: any) => variantEdge.node) || [],
  })) || [];
}

async function searchShopifyCollections(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query ProductRecipeCollectionSearch($query: String!, $first: Int!) {
        collections(first: $first, query: $query) {
          edges {
            node {
              id
              title
              handle
              products(first: 5) {
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    id
                    title
                    handle
                    totalVariants
                    variants(first: 3) {
                      edges { node { id title sku price selectedOptions { name value } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: safeQuery, first: COLLECTION_SEARCH_LIMIT } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  return payload?.data?.collections?.edges?.map((edge: any) => ({
    ...edge.node,
    previewProducts: edge.node?.products?.edges?.map((productEdge: any) => ({
      ...productEdge.node,
      sampleVariants: productEdge.node?.variants?.edges?.map((variantEdge: any) => variantEdge.node) || [],
    })) || [],
    previewPageInfo: edge.node?.products?.pageInfo || null,
  })) || [];
}

async function fetchShopifyProductVariants(admin: any, productGid: string) {
  const response = await admin.graphql(
    `#graphql
      query ProductRecipeVariantSync($id: ID!, $first: Int!) {
        product(id: $id) {
          id
          title
          handle
          totalVariants
          variants(first: $first) {
            edges {
              node {
                id
                title
                sku
                price
                selectedOptions { name value }
              }
            }
          }
        }
      }
    `,
    { variables: { id: productGid, first: VARIANT_FETCH_LIMIT } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  const product = payload?.data?.product;
  return { product, variants: product?.variants?.edges?.map((edge: any) => edge.node) || [] };
}

async function fetchCollectionProductBatch(admin: any, collectionGid: string, after?: string, first = COLLECTION_SCAN_PAGE_SIZE) {
  const response = await admin.graphql(
    `#graphql
      query CollectionProductBatch($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          id
          title
          handle
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              cursor
              node {
                id
                title
                handle
                totalVariants
                variants(first: 100) {
                  edges { node { id title sku price selectedOptions { name value } } }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { id: collectionGid, first, after: after || null } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  const collection = payload?.data?.collection;
  const productEdges = collection?.products?.edges || [];
  const products = productEdges.map((edge: any) => ({
    ...edge.node,
    cursor: edge.cursor,
    variantsList: edge.node?.variants?.edges?.map((variantEdge: any) => variantEdge.node) || [],
  })) || [];
  return {
    collection,
    products,
    productEdges,
    pageInfo: collection?.products?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}


async function fetchCollectionTotalProducts(admin: any, collectionGid: string) {
  if (!collectionGid) return null;
  try {
    const response = await admin.graphql(
      `#graphql
        query CollectionTotalProducts($id: ID!) {
          collection(id: $id) {
            id
            title
            handle
            productsCount { count }
          }
        }
      `,
      { variables: { id: collectionGid } }
    );
    const payload = await response.json();
    if (payload?.errors?.length) return null;
    const count = payload?.data?.collection?.productsCount?.count;
    return Number.isFinite(Number(count)) ? Number(count) : null;
  } catch (_error) {
    return null;
  }
}

function collectionProgressHealth(item: any, totalProducts: any) {
  const products = Number(item?.products || 0);
  const variants = Number(item?.activeVariants || item?.variants || 0);
  const total = Number(totalProducts || 0);
  const remaining = total ? Math.max(0, total - products) : null;
  const percent = total ? Math.min(100, Math.round((products / total) * 1000) / 10) : null;
  const variantsPerProduct = products ? Math.round((variants / products) * 10) / 10 : null;
  const estimatedVariants = total && products ? Math.round((variants / products) * total) : null;
  const isComplete = !!total && products >= total;
  const isLargeCollection = !!total && total >= 500;
  const needsBatching = !!remaining && remaining > COLLECTION_BATCH_SIZE;
  return { total, remaining, percent, estimatedVariants, variantsPerProduct, isComplete, isLargeCollection, needsBatching };
}

function collectionGuardrailMessage(progress: any) {
  if (!progress?.total) return "Search/relink this collection to load the Shopify total and enable progress guardrails.";
  if (progress.isComplete) return "Collection appears fully synced. Continue is disabled to prevent duplicate batch work.";
  if (progress.isLargeCollection) return `Large collection guardrail: sync ${COLLECTION_BATCH_SIZE} unsynced products per click and verify health before continuing.`;
  if (progress.needsBatching) return `Batch guardrail: ${progress.remaining} product(s) remain, so continue in ${COLLECTION_BATCH_SIZE}-product batches.`;
  return "Small collection: continue sync can finish the remaining products safely.";
}

async function cleanDuplicateMappings(shop: string, recipeId?: string, productGid?: string) {
  const prisma: any = db;
  const where: any = { shop };
  if (recipeId) where.recipeId = recipeId;
  if (productGid) where.shopifyProductGid = productGid;

  const rules = await prisma.recipeVariantRule.findMany({
    where,
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
  });

  const keepByKey = new Map<string, any>();
  const deleteIds: string[] = [];

  for (const rule of rules) {
    const key = rule.shopifyVariantGid
      ? `variant:${rule.shopifyVariantGid}`
      : `fallback:${rule.recipeId || ""}:${rule.shopifyProductGid || ""}:${normalize(rule.shopifyVariantTitle || rule.name || "")}:${rule.sku || ""}`;

    if (!keepByKey.has(key)) {
      keepByKey.set(key, rule);
    } else {
      deleteIds.push(rule.id);
    }
  }

  if (deleteIds.length) {
    await prisma.recipeVariantRule.deleteMany({ where: { shop, id: { in: deleteIds } } });
  }

  return { scanned: rules.length, removed: deleteIds.length, kept: keepByKey.size };
}

async function upsertVariantRule(shop: string, recipe: any, product: any, variant: any, sourceLabel?: string) {
  const prisma: any = db;
  const mapped = autoMapShopifyVariant(variant, recipe, product, sourceLabel);
  const needsReview = String(mapped.notes || "").toLowerCase().includes("needs review") ? 1 : 0;

  const existingRules = await prisma.recipeVariantRule.findMany({
    where: { shop, recipeId: recipe.id, shopifyVariantGid: variant.id },
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const existing = existingRules[0];
  const duplicateIds = existingRules.slice(1).map((rule: any) => rule.id);
  if (duplicateIds.length) {
    await prisma.recipeVariantRule.deleteMany({ where: { shop, id: { in: duplicateIds } } });
  }

  const data = {
    name: mapped.name,
    shopifyProductGid: product.id,
    shopifyVariantGid: variant.id,
    shopifyVariantTitle: mapped.shopifyVariantTitle,
    sku: mapped.sku,
    sideMode: mapped.sideMode,
    bagColor: mapped.bagColor,
    frontMediaOptionId: mapped.frontMediaOptionId,
    backMediaMode: mapped.backMediaMode,
    backMediaOptionId: mapped.backMediaOptionId,
    useFrontZone: mapped.useFrontZone,
    useBackZone: mapped.useBackZone,
    active: true,
    notes: mapped.notes,
  };

  if (existing) {
    await prisma.recipeVariantRule.update({ where: { id: existing.id }, data });
    return { created: 0, updated: 1, duplicateCleaned: duplicateIds.length, needsReview };
  }

  await prisma.recipeVariantRule.create({ data: { shop, recipeId: recipe.id, ...data } });
  return { created: 1, updated: 0, duplicateCleaned: duplicateIds.length, needsReview };
}

async function syncProductToRecipe(shop: string, recipe: any, admin: any, productGid: string, sourceLabel?: string) {
  const prisma: any = db;
  const { product, variants } = await fetchShopifyProductVariants(admin, productGid);
  if (!product) return { product: null, variants: [], created: 0, updated: 0, cleaned: 0, needsReview: 0 };

  const preClean = await cleanDuplicateMappings(shop, recipe.id, product.id);

  let created = 0;
  let updated = 0;
  let cleaned = preClean.removed;
  let needsReview = 0;

  for (const variant of variants) {
    const result = await upsertVariantRule(shop, recipe, product, variant, sourceLabel);
    created += result.created;
    updated += result.updated;
    cleaned += result.duplicateCleaned;
    needsReview += result.needsReview;
  }

  const postClean = await cleanDuplicateMappings(shop, recipe.id, product.id);
  cleaned += postClean.removed;

  await prisma.productRecipe.updateMany({
    where: { shop, id: recipe.id, OR: [{ productGid: null }, { productGid: "" }] },
    data: { productGid: product.id },
  });

  return { product, variants, created, updated, cleaned, needsReview };
}

async function mappedProductGidsForRecipe(shop: string, recipeId: string) {
  const prisma: any = db;
  const rules = await prisma.recipeVariantRule.findMany({
    where: { shop, recipeId, shopifyProductGid: { not: null } },
    select: { shopifyProductGid: true },
  });
  return new Set((rules || []).map((rule: any) => rule.shopifyProductGid).filter(Boolean));
}

async function fetchNextUnsyncedCollectionProductBatch(admin: any, collectionGid: string, mappedProductGids: Set<string>, after?: string) {
  let cursor = after || undefined;
  let products: any[] = [];
  let collection: any = null;
  let pageInfo: any = { hasNextPage: false, endCursor: null };
  let scannedProducts = 0;
  let skippedAlreadyMapped = 0;
  let pagesScanned = 0;
  let nextCursor = after || undefined;
  let stoppedAfterFindingBatch = false;

  do {
    const batch = await fetchCollectionProductBatch(admin, collectionGid, cursor, COLLECTION_SCAN_PAGE_SIZE);
    collection = batch.collection;
    pageInfo = batch.pageInfo;
    pagesScanned += 1;

    const batchProducts = batch.products || [];
    for (const product of batchProducts) {
      scannedProducts += 1;
      nextCursor = product.cursor || nextCursor;

      if (mappedProductGids.has(product.id)) {
        skippedAlreadyMapped += 1;
      } else {
        products.push(product);
      }

      if (products.length >= COLLECTION_BATCH_SIZE) {
        stoppedAfterFindingBatch = true;
        break;
      }
    }

    if (stoppedAfterFindingBatch) break;

    cursor = pageInfo?.endCursor || nextCursor || undefined;
  } while (collection && pageInfo?.hasNextPage && pagesScanned < 12);

  const hasMoreFromCurrentPage = stoppedAfterFindingBatch && !!nextCursor;
  const normalizedPageInfo = {
    hasNextPage: !!(hasMoreFromCurrentPage || pageInfo?.hasNextPage),
    endCursor: nextCursor || pageInfo?.endCursor || null,
    shopifyEndCursor: pageInfo?.endCursor || null,
  };

  return { collection, products, pageInfo: normalizedPageInfo, scannedProducts, skippedAlreadyMapped, pagesScanned };
}

async function syncCollectionBatchToRecipe(shop: string, recipe: any, admin: any, collectionGid: string, after?: string) {
  const mappedProductGids = await mappedProductGidsForRecipe(shop, recipe.id);
  const { collection, products, pageInfo, scannedProducts, skippedAlreadyMapped, pagesScanned } = await fetchNextUnsyncedCollectionProductBatch(admin, collectionGid, mappedProductGids, after);
  if (!collection) return { collection: null, products: [], variants: 0, created: 0, updated: 0, cleaned: 0, needsReview: 0, pageInfo, scannedProducts: 0, skippedAlreadyMapped: 0, pagesScanned: 0 };

  let variants = 0;
  let created = 0;
  let updated = 0;
  let cleaned = 0;
  let needsReview = 0;
  const sourceLabel = `Collection: ${collection.title}. Collection GID: ${collection.id}`;

  for (const product of products) {
    const preClean = await cleanDuplicateMappings(shop, recipe.id, product.id);
    cleaned += preClean.removed;
    const productVariants = product.variantsList || [];
    variants += productVariants.length;

    for (const variant of productVariants) {
      const result = await upsertVariantRule(shop, recipe, product, variant, sourceLabel);
      created += result.created;
      updated += result.updated;
      cleaned += result.duplicateCleaned;
      needsReview += result.needsReview;
    }

    const postClean = await cleanDuplicateMappings(shop, recipe.id, product.id);
    cleaned += postClean.removed;
  }

  return { collection, products, variants, created, updated, cleaned, needsReview, pageInfo, scannedProducts, skippedAlreadyMapped, pagesScanned };
}

function productSampleText(product: any) {
  const samples = (product?.sampleVariants || []).map((variant: any) => [variant.title, variant.sku].filter(Boolean).join(" / ")).filter(Boolean);
  return samples.length ? samples.join("; ") : "No sample variants returned";
}

function groupedRulesByProduct(rules: any[] = []) {
  const groups = new Map<string, any>();
  for (const rule of rules || []) {
    const productGid = rule.shopifyProductGid || "No product GID";
    if (!groups.has(productGid)) groups.set(productGid, { productGid, productTitle: "", rules: [] });
    const group = groups.get(productGid);
    group.rules.push(rule);
    if (!group.productTitle) group.productTitle = extractProductTitleFromNotes(rule.notes || "");
  }
  return Array.from(groups.values()).sort((a: any, b: any) => b.rules.length - a.rules.length);
}

function isAllowedException(rule: any) {
  return String(rule?.notes || "").includes(ALLOWED_EXCEPTION_MARKER);
}

function allowedExceptionReason(rule: any) {
  const match = String(rule?.notes || "").match(/Allowed exception:\s*([^\[]+)/i);
  return match?.[1]?.trim().replace(/[\.\s]+$/, "") || "Approved exception";
}

function needsReview(rule: any) {
  if (isAllowedException(rule)) return false;
  return String(rule?.notes || "").toLowerCase().includes("needs review");
}

function collectionLabelFromRule(rule: any) {
  const match = String(rule?.notes || "").match(/Source:\s*Collection:\s*([^\.]+)\./i);
  return match?.[1]?.trim() || "";
}

function collectionGidFromRule(rule: any) {
  const match = String(rule?.notes || "").match(/Collection GID:\s*(gid:\/\/shopify\/Collection\/[0-9]+)/i);
  return match?.[1]?.trim() || "";
}

function recipeCollectionSummary(rules: any[] = []) {
  const summary = new Map<string, any>();
  for (const rule of rules || []) {
    const collection = collectionLabelFromRule(rule);
    if (!collection) continue;
    if (!summary.has(collection)) summary.set(collection, { collection, collectionGid: "", productGids: new Set<string>(), variants: 0, activeVariants: 0, needsReview: 0 });
    const item = summary.get(collection);
    if (!item.collectionGid) item.collectionGid = collectionGidFromRule(rule);
    if (rule.shopifyProductGid) item.productGids.add(rule.shopifyProductGid);
    item.variants += 1;
    if (rule.active !== false) item.activeVariants += 1;
    if (needsReview(rule)) item.needsReview += 1;
  }
  return Array.from(summary.values()).map((item: any) => ({
    collection: item.collection,
    collectionGid: item.collectionGid,
    products: item.productGids.size,
    variants: item.variants,
    activeVariants: item.activeVariants,
    needsReview: item.needsReview,
  }));
}


function collectionVariantHealth(item: any) {
  const products = Number(item?.products || 0);
  const activeVariants = Number(item?.activeVariants || item?.variants || 0);
  const totalVariants = Number(item?.variants || 0);
  const perProduct = products ? activeVariants / products : 0;
  const rounded = Math.round(perProduct * 10) / 10;
  const isWhole = Math.abs(perProduct - Math.round(perProduct)) < 0.001;
  const expectedPattern = isWhole && (Math.round(perProduct) === 24 || Math.round(perProduct) === 36);
  const hasHidden = totalVariants !== activeVariants;
  return {
    products,
    activeVariants,
    totalVariants,
    perProduct: rounded,
    expectedPattern,
    hasHidden,
    label: products ? `${rounded} variants/product` : "No products synced",
  };
}

function recipeHealthSummary(groups: any[] = []) {
  const activeGroups = (groups || []).map((group: any) => {
    const activeCount = (group.rules || []).filter((rule: any) => rule.active !== false).length;
    const allowed = (group.rules || []).some(isAllowedException);
    return { ...group, activeCount, allowed };
  }).filter((group: any) => group.activeCount > 0);
  const expected = activeGroups.filter((group: any) => group.activeCount === 24 || group.activeCount === 36 || group.allowed).length;
  const unusual = activeGroups.filter((group: any) => !group.allowed && group.activeCount !== 24 && group.activeCount !== 36).length;
  const allowed = activeGroups.filter((group: any) => group.allowed).length;
  return { total: activeGroups.length, expected, unusual, allowed };
}

function productGroupExceptionRows(groups: any[] = []) {
  return (groups || []).map((group: any) => {
    const rules = group.rules || [];
    const allowed = rules.some(isAllowedException);
    const activeCount = rules.filter((rule: any) => rule.active !== false).length;
    const totalCount = rules.length;
    const hiddenCount = totalCount - activeCount;
    const reviewCount = rules.filter(needsReview).length;
    const unusualCount = !allowed && activeCount > 0 && activeCount !== 24 && activeCount !== 36;
    const reasons: string[] = [];
    if (unusualCount) reasons.push(`Unusual active variant count: ${activeCount}`);
    if (reviewCount) reasons.push(`${reviewCount} variant rule(s) need review`);
    if (!allowed && hiddenCount) reasons.push(`${hiddenCount} hidden/inactive rule(s)`);
    return {
      productGid: group.productGid,
      productTitle: group.productTitle || group.productGid,
      activeCount,
      totalCount,
      hiddenCount,
      reviewCount,
      reasons,
    };
  }).filter((item: any) => item.reasons.length);
}

function productGroupAllowedExceptionRows(groups: any[] = []) {
  return (groups || []).map((group: any) => {
    const rules = group.rules || [];
    const allowedRule = rules.find(isAllowedException);
    if (!allowedRule) return null;
    const activeCount = rules.filter((rule: any) => rule.active !== false).length;
    return {
      productGid: group.productGid,
      productTitle: group.productTitle || group.productGid,
      activeCount,
      totalCount: rules.length,
      reason: allowedExceptionReason(allowedRule),
    };
  }).filter(Boolean);
}


async function deleteMappingsForRecipe(shop: string, recipeId: string) {
  const prisma: any = db;
  const result = await prisma.recipeVariantRule.deleteMany({ where: { shop, recipeId } });
  await prisma.productRecipe.updateMany({ where: { shop, id: recipeId }, data: { productGid: null, variantGid: null } });
  return result.count || 0;
}

async function deleteMappingsForProduct(shop: string, recipeId: string, productGid: string) {
  const prisma: any = db;
  const result = await prisma.recipeVariantRule.deleteMany({ where: { shop, recipeId, shopifyProductGid: productGid } });
  await prisma.productRecipe.updateMany({ where: { shop, id: recipeId, productGid }, data: { productGid: null, variantGid: null } });
  return result.count || 0;
}

async function setProductMappingsActive(shop: string, recipeId: string, productGid: string, active: boolean) {
  const prisma: any = db;
  const result = await prisma.recipeVariantRule.updateMany({ where: { shop, recipeId, shopifyProductGid: productGid }, data: { active } });
  return result.count || 0;
}

async function setProductAllowedException(shop: string, recipeId: string, productGid: string, allowed: boolean, reason = "Approved intentional variant count") {
  const prisma: any = db;
  const rules = await prisma.recipeVariantRule.findMany({ where: { shop, recipeId, shopifyProductGid: productGid } });
  let changed = 0;
  const cleanAllowedText = (notes: string) => String(notes || "")
    .replace(/\s*Allowed exception:[^\[]*\[ALLOWED_SHOPIFY_LINK_EXCEPTION\]\.?/gi, "")
    .trim();

  for (const rule of rules || []) {
    const currentNotes = String(rule.notes || "");
    const baseNotes = cleanAllowedText(currentNotes);
    const nextNotes = allowed
      ? `${baseNotes}${baseNotes ? " " : ""}Allowed exception: ${reason || "Approved intentional variant count"}. ${ALLOWED_EXCEPTION_MARKER}`
      : baseNotes;
    if (nextNotes !== currentNotes) {
      await prisma.recipeVariantRule.update({ where: { id: rule.id }, data: { notes: nextNotes } });
      changed += 1;
    }
  }
  return changed;
}

async function deleteMappingsForCollectionSource(shop: string, recipeId: string, collectionName: string) {
  const prisma: any = db;
  const rules = await prisma.recipeVariantRule.findMany({ where: { shop, recipeId } });
  const target = normalize(collectionName);
  const ids = rules
    .filter((rule: any) => normalize(collectionLabelFromRule(rule) || "") === target)
    .map((rule: any) => rule.id);
  if (!ids.length) return 0;
  const result = await prisma.recipeVariantRule.deleteMany({ where: { shop, id: { in: ids } } });
  return result.count || 0;
}

async function setCollectionMappingsActive(shop: string, recipeId: string, collectionName: string, active: boolean) {
  const prisma: any = db;
  const rules = await prisma.recipeVariantRule.findMany({ where: { shop, recipeId } });
  const target = normalize(collectionName);
  const ids = rules
    .filter((rule: any) => normalize(collectionLabelFromRule(rule) || "") === target)
    .map((rule: any) => rule.id);
  if (!ids.length) return 0;
  const result = await prisma.recipeVariantRule.updateMany({ where: { shop, id: { in: ids } }, data: { active } });
  return result.count || 0;
}


function ruleMediaName(rule: any, recipe: any) {
  const option = (recipe?.mediaOptions || []).find((media: any) => media.id === rule.frontMediaOptionId);
  return option?.name || "Default/unknown";
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value || "Unknown"] = (counts[value || "Unknown"] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function productGroupBreakdown(recipe: any, group: any) {
  const activeRules = (group?.rules || []).filter((rule: any) => rule.active !== false);
  return {
    sides: countBy(activeRules.map((rule: any) => rule.sideMode || "single")),
    media: countBy(activeRules.map((rule: any) => ruleMediaName(rule, recipe))),
    colors: countBy(activeRules.map((rule: any) => rule.bagColor || "Any")),
    needsReview: activeRules.filter(needsReview).length,
  };
}

function BreakdownLine({ label, items }: { label: string; items: [string, number][] }) {
  return <div><strong>{label}:</strong> {items.length ? items.map(([name, count]) => `${name}: ${count}`).join(" · ") : "None"}</div>;
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: "green" | "yellow" | "red" | "neutral" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}


async function writeShopifyLinkSyncLog(prisma: any, data: any) {
  try {
    if (!prisma?.shopifyLinkSyncLog?.create) return;
    await prisma.shopifyLinkSyncLog.create({
      data: {
        shop: data.shop,
        recipeId: data.recipeId || null,
        recipeName: data.recipeName || null,
        sourceType: data.sourceType || "collection",
        sourceName: data.sourceName || null,
        sourceGid: data.sourceGid || null,
        action: data.action || "sync",
        products: Number(data.products || 0),
        variants: Number(data.variants || 0),
        created: Number(data.created || 0),
        updated: Number(data.updated || 0),
        skipped: Number(data.skipped || 0),
        scanned: Number(data.scanned || 0),
        needsReview: Number(data.needsReview || 0),
        hasNextPage: Boolean(data.hasNextPage),
        ok: data.ok !== false,
        message: data.message || null,
      },
    });
  } catch (error) {
    console.warn("Shopify link sync log was not saved", error);
  }
}

async function loadShopifyLinkSyncLogs(prisma: any, shop: string) {
  try {
    if (!prisma?.shopifyLinkSyncLog?.findMany) return [];
    return await prisma.shopifyLinkSyncLog.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  } catch (_error) {
    return [];
  }
}

function PersistentSyncHistoryPanel({ logs = [] }: { logs?: any[] }) {
  return <section className="card wide sync-history-card">
    <details>
      <summary><strong>Persistent Sync History</strong> <Badge tone={logs.length ? "green" : "neutral"}>{logs.length ? `${logs.length} recent log(s)` : "not enabled yet"}</Badge></summary>
      <p className="muted">Stores completed collection/product sync batches in the database after the ShopifyLinkSyncLog Prisma model is added and migrated. The current page still works even if the table is not installed yet.</p>
      {logs.length ? <table>
        <thead><tr><th>Time</th><th>Source</th><th>Action</th><th>Products</th><th>Variants</th><th>Status</th></tr></thead>
        <tbody>{logs.map((log: any) => <tr key={log.id}>
          <td>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}</td>
          <td><Badge tone={log.sourceType === "collection" ? "yellow" : "neutral"}>{log.sourceType || "source"}</Badge> <strong>{log.sourceName || "Shopify source"}</strong><br /><span className="muted gid">{log.sourceGid || ""}</span></td>
          <td>{log.action || "sync"}<br /><span className="muted">{log.message || ""}</span></td>
          <td>{log.products || 0}<br /><span className="muted">scanned {log.scanned || 0}, skipped {log.skipped || 0}</span></td>
          <td>{log.variants || 0}<br /><span className="muted">created {log.created || 0}, updated {log.updated || 0}</span></td>
          <td><Badge tone={log.ok ? "green" : "red"}>{log.ok ? "ok" : "error"}</Badge> {log.needsReview ? <Badge tone="yellow">{log.needsReview} review</Badge> : null} {log.hasNextPage ? <Badge tone="neutral">more pages</Badge> : <Badge tone="green">end reached</Badge>}</td>
        </tr>)}</tbody>
      </table> : <p className="muted">No persistent logs are available yet. Add the schema model from the notes, run Prisma migrate/generate, then future batches will be saved here.</p>}
    </details>
  </section>;
}


function LinkRegistryPanel({ recipes, collectionTotalByGid = {} }: { recipes: any[]; collectionTotalByGid?: Record<string, any> }) {
  const rows: any[] = [];

  for (const recipe of recipes || []) {
    const rules = recipe.variantRules || [];
    const grouped = groupedRulesByProduct(rules);
    const collections = recipeCollectionSummary(rules);

    for (const group of grouped) {
      const activeCount = (group.rules || []).filter((rule: any) => rule.active !== false).length;
      if (!activeCount) continue;
      const isCollectionProduct = (group.rules || []).some((rule: any) => collectionLabelFromRule(rule));
      if (isCollectionProduct) continue;
      const reviewCount = (group.rules || []).filter(needsReview).length;
      const healthy = activeCount === 24 || activeCount === 36;
      rows.push({
        key: `${recipe.id}-product-${group.productGid}`,
        recipe,
        sourceType: "Product",
        sourceName: group.productTitle || (recipe.productGid === group.productGid ? "Default Shopify product" : group.productGid),
        gid: group.productGid,
        synced: "1 product",
        variants: activeCount,
        healthTone: reviewCount ? "yellow" : healthy ? "green" : "yellow",
        healthLabel: reviewCount ? `${reviewCount} need review` : healthy ? (activeCount === 36 ? "36 variant product" : "24 variant product") : "check variant count",
        progress: recipe.productGid === group.productGid ? "Default product link" : "Direct product link",
      });
    }

    for (const collection of collections) {
      const progress = collectionProgressHealth(collection, collectionTotalByGid[collection.collectionGid]);
      const health = collectionVariantHealth(collection);
      rows.push({
        key: `${recipe.id}-collection-${collection.collection}-${collection.collectionGid || "legacy"}`,
        recipe,
        sourceType: "Collection",
        sourceName: collection.collection,
        gid: collection.collectionGid || "Older source without saved collection GID",
        synced: `${collection.products} product(s)`,
        variants: collection.activeVariants || collection.variants,
        healthTone: collection.needsReview ? "yellow" : health.expectedPattern ? "green" : "yellow",
        healthLabel: collection.needsReview ? `${collection.needsReview} need review` : health.expectedPattern ? `${health.label}` : "check variant count",
        progress: progress.total ? `${collection.products} / ${progress.total} synced (${progress.percent}%)` : "Total not loaded",
        remaining: progress.total ? `${progress.remaining} remaining` : "Search/relink to load total",
      });
    }
  }

  return <section className="card wide link-registry">
    <h2>Shopify Link Registry / Control Center</h2>
    <p className="muted">Read-only overview of every Shopify source connected to a recipe. Use this as the control-center view; detailed cleanup still lives inside each recipe accordion below.</p>
    {rows.length ? <table>
      <thead><tr><th>Recipe</th><th>Source</th><th>Synced</th><th>Health</th><th>Progress</th></tr></thead>
      <tbody>
        {rows.map((row: any) => <tr key={row.key}>
          <td><strong>{row.recipe.name}</strong><br /><span className="muted">{row.recipe.productFamily || row.recipe.productTypeProfile?.name || "Recipe"}</span></td>
          <td><Badge tone={row.sourceType === "Collection" ? "yellow" : "neutral"}>{row.sourceType}</Badge> <strong>{row.sourceName}</strong><br /><span className="muted gid">{row.gid}</span></td>
          <td>{row.synced}<br /><span className="muted">{row.variants} active variant rule(s)</span></td>
          <td><Badge tone={row.healthTone}>{row.healthLabel}</Badge></td>
          <td>{row.progress}<br />{row.remaining ? <span className="muted">{row.remaining}</span> : null}</td>
        </tr>)}
      </tbody>
    </table> : <p className="muted">No Shopify product or collection links have been synced yet.</p>}
  </section>;
}

function SyncLogPanel({ actionData }: { actionData: any }) {
  const hasAction = Boolean(actionData?.intent || actionData?.message || actionData?.batch);
  const rows: any[] = [];

  if (actionData?.batch) {
    rows.push({
      type: "Collection batch",
      source: actionData.batch.collectionTitle || "Collection",
      summary: `${actionData.batch.products || 0} product(s), ${actionData.batch.variants || 0} variant rule(s)`,
      detail: `Scanned ${actionData.batch.scannedProducts || actionData.batch.products || 0}; skipped ${actionData.batch.skippedAlreadyMapped || 0}; ${actionData.batch.hasNextPage ? "more pages available" : "no more Shopify pages reported"}`
    });
  }

  if (actionData?.intent && !actionData?.batch) {
    rows.push({
      type: actionData.intent,
      source: actionData.query || actionData.collectionName || actionData.productTitle || "Shopify Links",
      summary: actionData.message || (actionData.ok ? "Action completed" : "Action failed"),
      detail: actionData.ok === false ? "Review the error before continuing." : "No full batch details for this action."
    });
  }

  return <section className="card wide sync-log-card">
    <details open={Boolean(actionData?.batch)}>
      <summary><strong>Sync Log / Last Action</strong> <Badge tone={hasAction ? "green" : "neutral"}>{hasAction ? "action recorded" : "no action yet"}</Badge></summary>
      <p className="muted">This panel shows the most recent Shopify Links action from the current page request. Full persistent batch history will move into database sync logs later.</p>
      {rows.length ? <table>
        <thead><tr><th>Type</th><th>Source</th><th>Summary</th><th>Detail</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <td>{row.type}</td>
          <td>{row.source}</td>
          <td>{row.summary}</td>
          <td>{row.detail}</td>
        </tr>)}</tbody>
      </table> : <p className="muted">No sync/search/cleanup action has run on this request yet. Use Search, Continue next 25, or cleanup buttons to populate the log.</p>}
      <div className="pill-row tight">
        <Badge tone="neutral">current request only</Badge>
        <Badge tone="yellow">database sync log comes next</Badge>
        <Badge tone="green">safe for large collections</Badge>
      </div>
    </details>
  </section>;
}

export async function loader({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const inspectProductGid = url.searchParams.get("inspectProductGid") || "";
  const inspectRecipeId = url.searchParams.get("inspectRecipeId") || "";
  const prisma: any = db;

  const recipes = await prisma.productRecipe.findMany({
    where: { shop, active: true },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    include: {
      mediaOptions: { include: { material: true }, orderBy: [{ active: "desc" }, { name: "asc" }] },
      variantRules: { orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { name: "asc" }] },
    },
  });

    const collectionTotalByGid: Record<string, number> = {};
  const collectionGids = Array.from(new Set(recipes.flatMap((recipe: any) =>
    recipeCollectionSummary(recipe.variantRules || [])
      .map((item: any) => item.collectionGid)
      .filter(Boolean)
  )));
  for (const gid of collectionGids.slice(0, 10)) {
    const total = await fetchCollectionTotalProducts(admin, String(gid));
    if (total !== null) collectionTotalByGid[String(gid)] = total;
  }

  const syncHistory = await loadShopifyLinkSyncLogs(prisma, shop);

  return Response.json({ recipes, collectionBatchSize: COLLECTION_BATCH_SIZE, groupRowPreviewLimit: GROUP_ROW_PREVIEW_LIMIT, inspectProductGid, inspectRecipeId, inspectRowLimit: INSPECT_ROW_LIMIT, collectionTotalByGid, syncHistory });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const prisma: any = db;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "testVariantRules") {
      const recipeId = String(formData.get("recipeId") || "");
      const variantText = String(formData.get("variantText") || "").trim();
      if (!recipeId) return Response.json({ ok: false, message: "Choose a recipe to test rules." }, { status: 400 });
      if (!variantText) return Response.json({ ok: false, message: "Enter a sample variant name to test." }, { status: 400 });
      const recipe = await prisma.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { mediaOptions: { include: { material: true } } } });
      if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });
      const mapped = autoMapShopifyVariant({ title: variantText, sku: "", selectedOptions: [] }, recipe, { title: "Rule test" }, "Rule tester");
      const mediaName = (recipe.mediaOptions || []).find((option: any) => option.id === mapped.frontMediaOptionId)?.name || "Default / no match";
      const reviewMatch = String(mapped.notes || "").match(/Needs review: ([^\.]+)\./i);
      return Response.json({
        ok: true,
        intent,
        message: `Rule test complete for: ${variantText}`,
        ruleTest: {
          recipeId,
          variantText,
          sideMode: mapped.sideMode,
          useFrontZone: mapped.useFrontZone,
          useBackZone: mapped.useBackZone,
          backMediaMode: mapped.backMediaMode,
          mediaName,
          bagColor: mapped.bagColor,
          needsReview: reviewMatch?.[1] || "None",
        },
      });
    }

    if (intent === "searchProducts") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return Response.json({ ok: false, message: "Enter a Shopify product name or SKU." }, { status: 400 });
      const results = await searchShopifyProducts(admin, query);
      return Response.json({ ok: true, intent, message: results.length ? `Found ${results.length} product(s).` : "No products found.", query, productResults: results });
    }

    if (intent === "searchCollections") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return Response.json({ ok: false, message: "Enter a Shopify collection name." }, { status: 400 });
      const results = await searchShopifyCollections(admin, query);
      return Response.json({ ok: true, intent, message: results.length ? `Found ${results.length} collection(s). Pick a collection, then sync in safe batches.` : "No collections found.", query, collectionResults: results });
    }

    if (intent === "syncProduct") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or Shopify product." }, { status: 400 });
      const recipe = await prisma.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { mediaOptions: { include: { material: true } } } });
      if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });
      const result = await syncProductToRecipe(shop, recipe, admin, productGid, "Product link");
      if (!result.product) return Response.json({ ok: false, message: "Shopify product not found." }, { status: 404 });
      await writeShopifyLinkSyncLog(prisma, { shop, recipeId, recipeName: recipe.name, sourceType: "product", sourceName: result.product.title, sourceGid: productGid, action: "syncProduct", products: 1, variants: result.variants.length, created: result.created, updated: result.updated, skipped: 0, scanned: 1, needsReview: result.needsReview, hasNextPage: false, ok: true, message: "Direct product sync" });
      return Response.json({ ok: true, intent, message: `Synced ${result.product.title}: ${result.variants.length} variant(s), ${result.created} created, ${result.updated} updated, ${result.cleaned} duplicate(s) cleaned, ${result.needsReview} need review.` });
    }

    if (intent === "syncCollectionBatch") {
      const recipeId = String(formData.get("recipeId") || "");
      const collectionGid = String(formData.get("collectionGid") || "");
      const cursor = String(formData.get("cursor") || "");
      const autoSync = String(formData.get("autoSync") || "") === "1";
      if (!recipeId || !collectionGid) return Response.json({ ok: false, message: "Missing recipe or collection." }, { status: 400 });
      const recipe = await prisma.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { mediaOptions: { include: { material: true } } } });
      if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

      const result = await syncCollectionBatchToRecipe(shop, recipe, admin, collectionGid, cursor || undefined);
      if (!result.collection) return Response.json({ ok: false, message: "Collection not found." }, { status: 404 });

      await writeShopifyLinkSyncLog(prisma, {
        shop,
        recipeId,
        recipeName: recipe.name,
        sourceType: "collection",
        sourceName: result.collection.title,
        sourceGid: result.collection.id,
        action: autoSync ? "autoSyncCollectionBatch" : "syncCollectionBatch",
        products: result.products.length,
        variants: result.variants,
        created: result.created,
        updated: result.updated,
        skipped: result.skippedAlreadyMapped || 0,
        scanned: result.scannedProducts || result.products.length,
        needsReview: result.needsReview,
        hasNextPage: !!result.pageInfo?.hasNextPage,
        ok: true,
        message: result.pageInfo?.hasNextPage ? "More collection products may be available" : "Shopify reported no more pages",
      });

      return Response.json({
        ok: true,
        intent,
        message: `Synced next unsynced batch from ${result.collection.title}: ${result.products.length} new product(s), ${result.variants} variant(s), ${result.created} created, ${result.updated} updated, ${result.cleaned} duplicate(s) cleaned, ${result.needsReview} need review. Scanned ${result.scannedProducts || result.products.length} product(s), skipped ${result.skippedAlreadyMapped || 0} already-linked product(s).${result.pageInfo?.hasNextPage ? " More products may be available." : " Collection batch sync reached the end."}`,
        batch: {
          collectionId: result.collection.id,
          collectionTitle: result.collection.title,
          recipeId,
          nextCursor: result.pageInfo?.endCursor || "",
          hasNextPage: !!result.pageInfo?.hasNextPage,
          products: result.products.length,
          variants: result.variants,
          scannedProducts: result.scannedProducts || result.products.length,
          skippedAlreadyMapped: result.skippedAlreadyMapped || 0,
          pagesScanned: result.pagesScanned || 1,
          guardrail: result.products.length ? "Batch completed. Review health badges before continuing." : "No new unsynced products were found in this batch.",
          autoSync,
          autoContinue: autoSync && !!result.pageInfo?.hasNextPage && result.products.length > 0 && Number(result.needsReview || 0) === 0,
        },
      });
    }

    if (intent === "cleanRecipeMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
      const result = await cleanDuplicateMappings(shop, recipeId);
      return Response.json({ ok: true, message: `Cleaned recipe mappings: scanned ${result.scanned}, removed ${result.removed} duplicate(s), kept ${result.kept}.` });
    }

    if (intent === "cleanProductMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or product." }, { status: 400 });
      const result = await cleanDuplicateMappings(shop, recipeId, productGid);
      return Response.json({ ok: true, message: `Cleaned product mappings: scanned ${result.scanned}, removed ${result.removed} duplicate(s), kept ${result.kept}.` });
    }

    if (intent === "deleteRecipeMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
      const deleted = await deleteMappingsForRecipe(shop, recipeId);
      return Response.json({ ok: true, message: `Removed ${deleted} Shopify mapping(s) from this recipe. Recipe materials, media options, label zones, and pricing templates were not changed.` });
    }

    if (intent === "deleteProductMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or product." }, { status: 400 });
      const deleted = await deleteMappingsForProduct(shop, recipeId, productGid);
      return Response.json({ ok: true, message: `Removed ${deleted} mapping(s) for this Shopify product from the recipe.` });
    }

    if (intent === "hideProductMappings" || intent === "restoreProductMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or product." }, { status: 400 });
      const active = intent === "restoreProductMappings";
      const changed = await setProductMappingsActive(shop, recipeId, productGid, active);
      return Response.json({ ok: true, message: `${active ? "Restored" : "Hid"} ${changed} mapping(s) for this Shopify product.` });
    }

    if (intent === "deleteCollectionMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      const collectionName = String(formData.get("collectionName") || "");
      if (!recipeId || !collectionName) return Response.json({ ok: false, message: "Missing recipe or collection source." }, { status: 400 });
      const deleted = await deleteMappingsForCollectionSource(shop, recipeId, collectionName);
      return Response.json({ ok: true, message: `Removed ${deleted} mapping(s) from collection source: ${collectionName}.` });
    }

    if (intent === "hideCollectionMappings" || intent === "restoreCollectionMappings") {
      const recipeId = String(formData.get("recipeId") || "");
      const collectionName = String(formData.get("collectionName") || "");
      if (!recipeId || !collectionName) return Response.json({ ok: false, message: "Missing recipe or collection source." }, { status: 400 });
      const active = intent === "restoreCollectionMappings";
      const changed = await setCollectionMappingsActive(shop, recipeId, collectionName, active);
      return Response.json({ ok: true, message: `${active ? "Restored" : "Hid"} ${changed} mapping(s) from collection source: ${collectionName}.` });
    }

    if (intent === "markAllowedException" || intent === "clearAllowedException") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      const reason = String(formData.get("reason") || "Approved intentional variant count").trim();
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or Shopify product group." }, { status: 400 });
      const allowed = intent === "markAllowedException";
      const changed = await setProductAllowedException(shop, recipeId, productGid, allowed, reason);
      return Response.json({ ok: true, intent, message: `${allowed ? "Marked" : "Cleared"} allowed exception on ${changed} variant mapping(s).` });
    }

    if (intent === "inspectProduct") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or Shopify product group." }, { status: 400 });
      return Response.json({ ok: true, intent, message: "Variant details opened for one product group.", inspectRecipeId: recipeId, inspectProductGid: productGid });
    }

    if (intent === "clearInspect") {
      return Response.json({ ok: true, intent, message: "Variant details hidden." });
    }

    if (intent === "hideRule" || intent === "restoreRule") {
      const ruleId = String(formData.get("ruleId") || "");
      await prisma.recipeVariantRule.updateMany({ where: { shop, id: ruleId }, data: { active: intent === "restoreRule" } });
      return Response.json({ ok: true, message: intent === "restoreRule" ? "Variant mapping restored." : "Variant mapping hidden." });
    }

    if (intent === "deleteRule") {
      const ruleId = String(formData.get("ruleId") || "");
      await prisma.recipeVariantRule.deleteMany({ where: { shop, id: ruleId } });
      return Response.json({ ok: true, message: "Variant mapping deleted." });
    }

    return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("Shopify Links action failed", error);
    return Response.json({ ok: false, message: error?.message || "Shopify link action failed." }, { status: 500 });
  }
}

export default function ShopifyLinksPage() {
  const { recipes, collectionBatchSize, groupRowPreviewLimit, inspectProductGid, inspectRecipeId, inspectRowLimit, collectionTotalByGid = {}, syncHistory = [] } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const inspectedRecipeId = actionData?.intent === "inspectProduct" ? actionData.inspectRecipeId : "";
  const inspectedProductGid = actionData?.intent === "inspectProduct" ? actionData.inspectProductGid : "";


  return <main className="page">
    <header className="hero">
      <h1>Shopify Product / Collection Links</h1>
      <p>Control-center for connecting Shopify products and collections to recipes. Safe batch sync, auto-sync, exception review, link registry, sync history, and cleanup controls are kept on one page.</p>
    </header>

    <section style={{ border: "2px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700, margin: "12px 0" }}>
      Owner / advanced tool — changes here can affect live pricing, mappings, or Shopify behavior.
    </section>

    <section className="card wide plan-card">
      <h2>Clean linking model</h2>
      <div className="pill-row">
        <Badge tone="green">Recipe = how it is made</Badge>
        <Badge tone="neutral">Product/collection link = where it applies</Badge>
        <Badge tone="yellow">Variant rules = parsed from option names</Badge>
      </div>
      <p className="muted">Stock Bags can contain thousands of products. This page syncs collections in safe batches of {collectionBatchSize} unsynced products, skips products already linked to the recipe, and shows summaries first. Auto-sync is browser-driven: keep this page open and it will continue one safe batch at a time. Quantity tiers stay controlled by pricing templates, not Shopify variants.</p><p className="muted"><strong>Recommended flow:</strong> link the product or collection once, scan a small batch to verify rules, then continue only after Single/Double and media mapping look correct.</p>
    </section>

    {actionData?.message ? <div className={`notice ${actionData.ok ? "success" : "error"}`}>{actionData.message}</div> : null}

    <section className="card wide completion-card">
      <h2>Shopify Links status</h2>
      <div className="pill-row">
        <Badge tone="green">Products linked</Badge>
        <Badge tone="green">Collections linked</Badge>
        <Badge tone="green">Batch sync guarded</Badge>
        <Badge tone="green">Auto-sync available</Badge>
        <Badge tone="green">Exception review ready</Badge>
      </div>
      <p className="muted"><strong>Use this page for linking only.</strong> Pricing tiers stay in templates. Cost and price updates happen later in Margin Review / Price Audit.</p>
      <p className="muted"><strong>Safe workflow:</strong> link source → sync small batch → verify health → use auto-sync → review exceptions → move to Margin Review.</p>
    </section>

    <SyncLogPanel actionData={actionData} />

    <PersistentSyncHistoryPanel logs={syncHistory} />

    {actionData?.batch ? <section className="card wide continue-card">
      <h2>Last collection batch</h2>
      <p><strong>{actionData.batch.collectionTitle}</strong> synced {actionData.batch.products} new product(s) and {actionData.batch.variants} variant rule(s) in the last batch.</p>
      <p className="muted">Scanned {actionData.batch.scannedProducts || actionData.batch.products} product(s), skipped {actionData.batch.skippedAlreadyMapped || 0} already-linked product(s). {actionData.batch.hasNextPage ? "More products may be available." : "Shopify reported no more pages in this collection."}</p>
      <p><Badge tone={actionData.batch.products ? "green" : "yellow"}>{actionData.batch.guardrail || "Review health badges before continuing."}</Badge> {actionData.batch.autoSync ? <Badge tone={actionData.batch.autoContinue ? "green" : "yellow"}>auto-sync {actionData.batch.autoContinue ? "running" : "paused"}</Badge> : null}</p>
      {actionData.batch.hasNextPage ? <div className="button-row">
        <Form method="post" onSubmit={(event) => { if (!confirm(`Continue syncing ${collectionBatchSize} more unsynced products from ${actionData.batch.collectionTitle}? Check health badges after each batch.`)) event.preventDefault(); }}>
          <input type="hidden" name="intent" value="syncCollectionBatch" />
          <input type="hidden" name="recipeId" value={actionData.batch.recipeId} />
          <input type="hidden" name="collectionGid" value={actionData.batch.collectionId} />
          <input type="hidden" name="cursor" value={actionData.batch.nextCursor} />
          <button type="submit">Continue sync next {collectionBatchSize} unsynced products</button>
        </Form>
        <Form method="post" id="auto-sync-next-batch-form">
          <input type="hidden" name="intent" value="syncCollectionBatch" />
          <input type="hidden" name="recipeId" value={actionData.batch.recipeId} />
          <input type="hidden" name="collectionGid" value={actionData.batch.collectionId} />
          <input type="hidden" name="cursor" value={actionData.batch.nextCursor} />
          <input type="hidden" name="autoSync" value="1" />
          <button type="submit" className="secondary">{actionData.batch.autoSync ? "Continue auto-sync now" : "Start auto-sync"}</button>
        </Form>
        {actionData.batch.autoSync ? <form><button type="submit" className="secondary">Pause auto-sync</button></form> : null}
      </div> : <p><Badge tone="green">No more Shopify pages reported</Badge></p>}
      {actionData.batch.autoContinue ? <div className="notice success auto-sync-banner">Auto-sync is running. Keep this tab open; the next safe batch will start automatically.</div> : null}
      {actionData.batch.autoContinue ? <script dangerouslySetInnerHTML={{ __html: `setTimeout(function(){var f=document.getElementById('auto-sync-next-batch-form'); if(f) f.requestSubmit ? f.requestSubmit() : f.submit();}, 2500);` }} /> : null}
    </section> : null}

    <section className="card wide rule-preset-card">
      <h2>Variant Rule Presets</h2>
      <p className="muted">Current preset: <strong>{STICKER_BAG_RULE_PRESET.name}</strong>. These rules tell the app how to read Shopify option names before creating recipe variant rules.</p>
      <div className="grid two">
        <div className="mini-card">
          <h3>Side rules</h3>
          <p><Badge tone="green">Single / front only</Badge> {STICKER_BAG_RULE_PRESET.sideSingle.join(", ")}</p>
          <p><Badge tone="yellow">Double / front + back</Badge> {STICKER_BAG_RULE_PRESET.sideDouble.join(", ")}</p>
        </div>
        <div className="mini-card">
          <h3>Media rules</h3>
          <p><Badge tone="neutral">Matte</Badge> {STICKER_BAG_RULE_PRESET.mediaMatte.join(", ")}</p>
          <p><Badge tone="neutral">Gloss</Badge> {STICKER_BAG_RULE_PRESET.mediaGloss.join(", ")}</p>
          <p><Badge tone="neutral">Holographic</Badge> {STICKER_BAG_RULE_PRESET.mediaHolographic.join(", ")}</p>
        </div>
      </div>
      <p className="muted"><strong>Known bag colors:</strong> {STICKER_BAG_RULE_PRESET.colors.join(", ")}</p>
      <Form method="post" className="rule-test-form">
        <input type="hidden" name="intent" value="testVariantRules" />
        <label>Recipe
          <select name="recipeId" defaultValue={actionData?.ruleTest?.recipeId || ""}>
            <option value="">Choose recipe</option>
            {recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.productFamily}</option>)}
          </select>
        </label>
        <label>Sample Shopify variant text
          <input name="variantText" defaultValue={actionData?.ruleTest?.variantText || "Double Sided / Holographic / Black"} placeholder="Example: Double Sided / Holographic / Black" />
        </label>
        <button type="submit">Test variant rules</button>
      </Form>
      {actionData?.ruleTest ? <div className="inspector-box" style={{ marginTop: 10 }}>
        <h3>Rule test result</h3>
        <p><strong>Variant:</strong> {actionData.ruleTest.variantText}</p>
        <p><strong>Side:</strong> {actionData.ruleTest.sideMode} · Front: {String(actionData.ruleTest.useFrontZone)} · Back: {String(actionData.ruleTest.useBackZone)} · Back media: {actionData.ruleTest.backMediaMode}</p>
        <p><strong>Media:</strong> {actionData.ruleTest.mediaName}</p>
        <p><strong>Bag color:</strong> {actionData.ruleTest.bagColor}</p>
        <p><strong>Needs review:</strong> {actionData.ruleTest.needsReview}</p>
      </div> : null}
      <p className="muted">Next version can move these presets into database records. For now this gives you a safe tester before syncing large batches.</p>
    </section>

    <section className="grid two">
      <div className="card">
        <h2>Search Shopify products</h2>
        <p className="muted">Use this to link one exact Shopify product to a recipe. Results are intentionally limited to {PRODUCT_SEARCH_LIMIT}.</p>
        <Form method="post" className="row">
          <input type="hidden" name="intent" value="searchProducts" />
          <input name="query" defaultValue={actionData?.intent === "searchProducts" ? actionData.query : ""} placeholder="Example: 4x5 sticker bag" />
          <button type="submit">Search products</button>
        </Form>
      </div>

      <div className="card">
        <h2>Search Shopify collections</h2>
        <p className="muted">Use this to link a large Shopify collection to a recipe. Collection products are synced in safe batches, not all at once.</p>
        <Form method="post" className="row">
          <input type="hidden" name="intent" value="searchCollections" />
          <input name="query" defaultValue={actionData?.intent === "searchCollections" ? actionData.query : ""} placeholder="Example: Stock Bags" />
          <button type="submit">Search collections</button>
        </Form>
      </div>
    </section>

    {actionData?.productResults?.length ? <section className="card wide">
      <h2>Product results</h2>
      <table>
        <thead><tr><th>Shopify product</th><th>Sample variants</th><th>Link to recipe</th></tr></thead>
        <tbody>
          {actionData.productResults.map((product: any) => <tr key={product.id}>
            <td><strong>{product.title}</strong><br /><span className="muted">{product.handle} · {product.totalVariants || 0} variant(s)</span></td>
            <td>{productSampleText(product)}</td>
            <td>
              <Form method="post" className="stacked">
                <input type="hidden" name="intent" value="syncProduct" />
                <input type="hidden" name="productGid" value={product.id} />
                <select name="recipeId" required defaultValue="">
                  <option value="" disabled>Choose recipe</option>
                  {recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.productFamily || recipe.productTypeProfile?.name || "Recipe"}</option>)}
                </select>
                <button type="submit">Link product + sync variants</button>
              </Form>
            </td>
          </tr>)}
        </tbody>
      </table>
    </section> : null}

    {actionData?.collectionResults?.length ? <section className="card wide">
      <h2>Collection results</h2>
      <p className="muted">The product list below is only a preview. When you sync, the app starts at the first page of the collection and can continue batch by batch.</p>
      <table>
        <thead><tr><th>Collection</th><th>Preview products</th><th>Link collection to recipe</th></tr></thead>
        <tbody>
          {actionData.collectionResults.map((collection: any) => <tr key={collection.id}>
            <td><strong>{collection.title}</strong><br /><span className="muted">{collection.handle}</span><br />{collection.previewPageInfo?.hasNextPage ? <Badge tone="yellow">more than preview shown</Badge> : null}</td>
            <td>{collection.previewProducts?.length ? collection.previewProducts.map((product: any) => <div key={product.id}>{product.title} <span className="muted">({product.totalVariants || 0} variant/s)</span></div>) : "No products returned"}</td>
            <td>
              <Form method="post" className="stacked">
                <input type="hidden" name="intent" value="syncCollectionBatch" />
                <input type="hidden" name="collectionGid" value={collection.id} />
                <input type="hidden" name="cursor" value="" />
                <select name="recipeId" required defaultValue="">
                  <option value="" disabled>Choose recipe</option>
                  {recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.productFamily || recipe.productTypeProfile?.name || "Recipe"}</option>)}
                </select>
                <button type="submit">Link collection + sync next {collectionBatchSize} unsynced</button>
              </Form>
            </td>
          </tr>)}
        </tbody>
      </table>
    </section> : null}

    <LinkRegistryPanel recipes={recipes} collectionTotalByGid={collectionTotalByGid} />

    <section className="card wide">
      <h2>Detailed linked sources / cleanup tools</h2>
      <p className="muted">Summary-first view. Products and collections are grouped so large Stock Bags catalogs do not flood the page. Variant rows are hidden here; Margin Review will handle full price audits.</p>
      {recipes.map((recipe: any) => {
        const allRules = recipe.variantRules || [];
        const activeRules = allRules.filter((rule: any) => rule.active !== false);
        const grouped = groupedRulesByProduct(allRules);
        const reviewCount = allRules.filter(needsReview).length;
        const collections = recipeCollectionSummary(allRules);
        const healthSummary = recipeHealthSummary(grouped);
        const exceptionRows = productGroupExceptionRows(grouped);
        const allowedExceptionRows = productGroupAllowedExceptionRows(grouped);

        return <details key={recipe.id} className="recipe-card">
          <summary>
            <strong>{recipe.name}</strong>
            <Badge tone="green">{activeRules.length} active variant rules</Badge>
            <Badge tone="neutral">{grouped.length} product group(s)</Badge>
            {collections.length ? <Badge tone="neutral">{collections.length} collection source(s)</Badge> : null}
            {healthSummary.expected ? <Badge tone="green">{healthSummary.expected} healthy product group(s)</Badge> : null}
            {healthSummary.unusual ? <Badge tone="yellow">{healthSummary.unusual} unusual count(s)</Badge> : null}
            {healthSummary.allowed ? <Badge tone="green">{healthSummary.allowed} allowed exception(s)</Badge> : null}
            {reviewCount ? <Badge tone="yellow">{reviewCount} need review</Badge> : null}
          </summary>
          <div className="recipe-body">
            <p><strong>Default Shopify product:</strong> {recipe.productGid || <span className="muted">Not set yet</span>}</p>
            <p><strong>Media options:</strong> {(recipe.mediaOptions || []).map((option: any) => option.name).join(", ") || "No media options"}</p>
            <div className="button-row" style={{ marginBottom: 12 }}>
              <Form method="post">
                <input type="hidden" name="intent" value="cleanRecipeMappings" />
                <input type="hidden" name="recipeId" value={recipe.id} />
                <button type="submit" className="secondary">Clean duplicate mappings for this recipe</button>
              </Form>
              <Form method="post" onSubmit={(event) => { if (!confirm(`Remove ALL Shopify mappings from ${recipe.name}? This does not delete the recipe or Shopify products.`)) event.preventDefault(); }}>
                <input type="hidden" name="intent" value="deleteRecipeMappings" />
                <input type="hidden" name="recipeId" value={recipe.id} />
                <button type="submit" className="danger">Remove all Shopify mappings from this recipe</button>
              </Form>
            </div>

            {exceptionRows.length ? <div className="summary-box exception-review">
              <h3>Exception Review</h3>
              <p className="muted">Only product groups with unusual counts, hidden/inactive mappings, or variant rules that need review appear here. Healthy 24-variant stock bag products and healthy 36-variant gloss products stay out of this list.</p>
              <table>
                <thead><tr><th>Product</th><th>Active / Total</th><th>Issue</th><th>Actions</th></tr></thead>
                <tbody>
                  {exceptionRows.map((item: any) => <tr key={item.productGid}>
                    <td><strong>{item.productTitle}</strong><br /><span className="muted gid">{item.productGid}</span></td>
                    <td>{item.activeCount} / {item.totalCount}</td>
                    <td>{item.reasons.map((reason: string) => <div key={reason}><Badge tone="yellow">{reason}</Badge></div>)}</td>
                    <td>
                      <div className="button-row">
                        <Form method="post" className="inline-form">
                          <input type="hidden" name="intent" value="inspectProduct" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <button type="submit" className="secondary">View details</button>
                        </Form>
                        <Form method="post" className="inline-form">
                          <input type="hidden" name="intent" value="hideProductMappings" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <button type="submit" className="secondary">Hide group</button>
                        </Form>
                        <Form method="post" className="inline-form allowed-form" onSubmit={(event) => { if (!confirm(`Approve ${item.productTitle} as an allowed exception?`)) event.preventDefault(); }}>
                          <input type="hidden" name="intent" value="markAllowedException" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <input name="reason" defaultValue="Approved intentional Shopify variant structure" />
                          <button type="submit" className="secondary">Mark allowed</button>
                        </Form>
                        <Form method="post" className="inline-form" onSubmit={(event) => { if (!confirm(`Remove mappings for ${item.productTitle}?`)) event.preventDefault(); }}>
                          <input type="hidden" name="intent" value="deleteProductMappings" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <button type="submit" className="danger">Remove mappings</button>
                        </Form>
                      </div>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <div className="summary-box"><h3>Exception Review</h3><Badge tone="green">No exceptions found</Badge><p className="muted">All active product groups currently match expected 24/36 variant patterns with no review flags.</p></div>}

            {allowedExceptionRows.length ? <div className="summary-box allowed-exceptions">
              <h3>Allowed Exceptions</h3>
              <p className="muted">Approved product groups stay out of Exception Review. Use this only when a product intentionally has a different Shopify variant structure.</p>
              <table>
                <thead><tr><th>Product</th><th>Active / Total</th><th>Reason</th><th>Actions</th></tr></thead>
                <tbody>
                  {allowedExceptionRows.map((item: any) => <tr key={item.productGid}>
                    <td><strong>{item.productTitle}</strong><br /><span className="muted gid">{item.productGid}</span></td>
                    <td>{item.activeCount} / {item.totalCount}</td>
                    <td><Badge tone="green">{item.reason}</Badge></td>
                    <td>
                      <div className="button-row">
                        <Form method="post" className="inline-form">
                          <input type="hidden" name="intent" value="inspectProduct" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <button type="submit" className="secondary">View details</button>
                        </Form>
                        <Form method="post" className="inline-form" onSubmit={(event) => { if (!confirm(`Clear allowed exception for ${item.productTitle}?`)) event.preventDefault(); }}>
                          <input type="hidden" name="intent" value="clearAllowedException" />
                          <input type="hidden" name="recipeId" value={recipe.id} />
                          <input type="hidden" name="productGid" value={item.productGid} />
                          <button type="submit" className="secondary">Clear allowed</button>
                        </Form>
                      </div>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div> : null}

            {collections.length ? <div className="summary-box">
              <h3>Collection source summaries</h3>
              <p className="muted">Remove a collection source if the wrong collection was synced to this recipe. This deletes only the saved mapping rules created from that source; it does not touch Shopify products or the recipe setup.</p>
              {collections.map((item: any) => <div key={item.collection} className="source-row">
                <div>
                  {(() => {
                    const health = collectionVariantHealth(item);
                    return <>
                      <strong>{item.collection}</strong>: {item.products} product(s), {item.activeVariants || item.variants} active / {item.variants} variant rule(s)
                      <div className="pill-row tight">
                        <Badge tone={health.expectedPattern ? "green" : "yellow"}>{health.label}</Badge>
                        {health.expectedPattern ? <Badge tone="green">expected pattern</Badge> : <Badge tone="yellow">check variant count</Badge>}
                        {health.hasHidden ? <Badge tone="yellow">hidden rules included</Badge> : null}
                        {item.needsReview ? <Badge tone="yellow">{item.needsReview} need review</Badge> : <Badge tone="green">0 need review</Badge>}
                      </div>
                      {(() => {
                        const progress = collectionProgressHealth(item, collectionTotalByGid[item.collectionGid]);
                        if (!progress.total) return <div className="muted">Shopify total not loaded yet. Search/relink the collection if progress total is missing.</div>;
                        return <div className="progress-box">
                          <div><strong>Progress:</strong> {item.products} / {progress.total} products synced ({progress.percent}%)</div>
                          <div className="muted">Remaining: {progress.remaining} product(s){progress.estimatedVariants ? ` · Estimated complete variant rules: ${progress.estimatedVariants}` : ""}{progress.variantsPerProduct ? ` · Avg ${progress.variantsPerProduct} variants/product` : ""}</div>
                          <div className="pill-row tight">
                            {progress.isComplete ? <Badge tone="green">complete</Badge> : <Badge tone="yellow">in progress</Badge>}
                            {progress.isLargeCollection ? <Badge tone="yellow">large collection guardrail</Badge> : null}
                            {progress.needsBatching ? <Badge tone="neutral">batch sync only</Badge> : null}
                          </div>
                          <div className="muted">{collectionGuardrailMessage(progress)}</div>
                          <div className="progress-track"><div className="progress-fill" style={{ width: `${progress.percent || 0}%` }} /></div>
                        </div>;
                      })()}
                    </>;
                  })()}
                  {item.collectionGid ? <div className="muted">Collection linked. Continue sync skips products already mapped to this recipe.</div> : <div className="muted">Older source without saved collection GID. Search this collection again to continue syncing.</div>}
                </div>
                <div className="button-row">
                  {item.collectionGid ? (() => {
                    const progress = collectionProgressHealth(item, collectionTotalByGid[item.collectionGid]);
                    if (progress.isComplete) return <button type="button" className="secondary" disabled>Collection complete</button>;
                    return <>
                      <Form method="post" onSubmit={(event) => { if (progress.isLargeCollection && !confirm(`Continue syncing ${collectionBatchSize} more unsynced products from ${item.collection}? Check health badges after each batch.`)) event.preventDefault(); }}>
                        <input type="hidden" name="intent" value="syncCollectionBatch" />
                        <input type="hidden" name="recipeId" value={recipe.id} />
                        <input type="hidden" name="collectionGid" value={item.collectionGid} />
                        <button type="submit">Continue next {collectionBatchSize}</button>
                      </Form>
                      <Form method="post" onSubmit={(event) => { if (progress.isLargeCollection && !confirm(`Start browser auto-sync for ${item.collection}? Keep this tab open. The app will stop if a batch creates no products, Shopify reports no more pages, or exceptions appear.`)) event.preventDefault(); }}>
                        <input type="hidden" name="intent" value="syncCollectionBatch" />
                        <input type="hidden" name="recipeId" value={recipe.id} />
                        <input type="hidden" name="collectionGid" value={item.collectionGid} />
                        <input type="hidden" name="autoSync" value="1" />
                        <button type="submit" className="secondary">Start auto-sync</button>
                      </Form>
                    </>;
                  })() : null}
                  <Form method="post">
                    <input type="hidden" name="intent" value="hideCollectionMappings" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <input type="hidden" name="collectionName" value={item.collection} />
                    <button type="submit" className="secondary">Hide source</button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="restoreCollectionMappings" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <input type="hidden" name="collectionName" value={item.collection} />
                    <button type="submit" className="secondary">Restore source</button>
                  </Form>
                  <Form method="post" onSubmit={(event) => { if (!confirm(`Remove mappings from collection source ${item.collection}?`)) event.preventDefault(); }}>
                    <input type="hidden" name="intent" value="deleteCollectionMappings" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <input type="hidden" name="collectionName" value={item.collection} />
                    <button type="submit" className="danger">Remove source mappings</button>
                  </Form>
                </div>
              </div>)}
            </div> : null}

            {grouped.length ? grouped.map((group: any) => {
              const groupActive = group.rules.filter((rule: any) => rule.active !== false).length;
              const groupReview = group.rules.filter(needsReview).length;
              const title = group.productTitle || group.productGid;
              const isInspecting = inspectedRecipeId === recipe.id && inspectedProductGid === group.productGid;
              const previewLimit = Number(inspectRowLimit || INSPECT_ROW_LIMIT);
              const previewRows = isInspecting ? group.rules.slice(0, previewLimit) : group.rules.slice(0, groupRowPreviewLimit || GROUP_ROW_PREVIEW_LIMIT);
              const hiddenRows = Math.max(0, group.rules.length - previewRows.length);
              const breakdown = productGroupBreakdown(recipe, group);
              return <details key={group.productGid} className="product-group" open={isInspecting}>
                <summary>
                  <strong>{title}</strong>
                  <span className="muted gid">{group.productTitle ? group.productGid : ""}</span>
                  <Badge tone="green">{groupActive} active</Badge>
                  <Badge tone="neutral">{group.rules.length} total</Badge>
                  {groupReview ? <Badge tone="yellow">{groupReview} need review</Badge> : null}
                </summary>
                <div style={{ marginTop: 10 }}>
                  <div className="inspector-box">
                    <div className="button-row" style={{ marginBottom: 8 }}>
                      {isInspecting ? <Form method="post" className="inline-form">
                        <input type="hidden" name="intent" value="clearInspect" />
                        <button type="submit" className="secondary">Hide variant details</button>
                      </Form> : <Form method="post" className="inline-form">
                        <input type="hidden" name="intent" value="inspectProduct" />
                        <input type="hidden" name="recipeId" value={recipe.id} />
                        <input type="hidden" name="productGid" value={group.productGid} />
                        <button type="submit" className="secondary">View variant details</button>
                      </Form>}
                      <span className="muted">{isInspecting ? `Showing up to ${previewLimit} variant rule(s) for this product only.` : "Variant details are hidden until opened for this product."}</span>
                    </div>
                    {isInspecting ? <div className="breakdown-grid">
                      <BreakdownLine label="Side count" items={breakdown.sides} />
                      <BreakdownLine label="Media count" items={breakdown.media} />
                      <BreakdownLine label="Color count" items={breakdown.colors} />
                      <div><strong>Needs review:</strong> {breakdown.needsReview}</div>
                    </div> : null}
                  </div>
                  <div className="button-row" style={{ marginBottom: 10 }}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="cleanProductMappings" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <input type="hidden" name="productGid" value={group.productGid} />
                      <button type="submit" className="secondary">Clean duplicates for this product</button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="hideProductMappings" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <input type="hidden" name="productGid" value={group.productGid} />
                      <button type="submit" className="secondary">Hide product group</button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="restoreProductMappings" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <input type="hidden" name="productGid" value={group.productGid} />
                      <button type="submit" className="secondary">Restore product group</button>
                    </Form>
                    <Form method="post" onSubmit={(event) => { if (!confirm(`Remove all mappings for ${title}? This does not delete the Shopify product.`)) event.preventDefault(); }}>
                      <input type="hidden" name="intent" value="deleteProductMappings" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <input type="hidden" name="productGid" value={group.productGid} />
                      <button type="submit" className="danger">Remove product mappings</button>
                    </Form>
                  </div>
                  {hiddenRows ? <p className="muted">Variant detail rows are hidden in summary view. Use View variant details to inspect side/media/color for this product without flooding the page.</p> : null}
                  {previewRows.length ? <table>
                    <thead><tr><th>Variant</th><th>SKU</th><th>Auto rules</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {previewRows.map((rule: any) => <tr key={rule.id}>
                        <td><strong>{rule.name}</strong><br /><span className="muted">{rule.shopifyVariantTitle || "No Shopify title"}</span></td>
                        <td>{rule.sku ? `SKU: ${rule.sku}` : <span className="muted">No SKU</span>}</td>
                        <td>
                          Side: {rule.sideMode || "single"}<br />
                          Color: {rule.bagColor || "Any"}<br />
                          Front media: {recipe.mediaOptions?.find((option: any) => option.id === rule.frontMediaOptionId)?.name || "Default"}<br />
                          Back: {rule.backMediaMode || "none"}
                          {needsReview(rule) ? <><br /><Badge tone="yellow">Needs review</Badge></> : null}
                        </td>
                        <td>{rule.active === false ? <Badge tone="yellow">Hidden</Badge> : <Badge tone="green">Active</Badge>}</td>
                        <td>
                          <div className="button-row">
                            <Form method="post"><input type="hidden" name="intent" value={rule.active === false ? "restoreRule" : "hideRule"} /><input type="hidden" name="ruleId" value={rule.id} /><button type="submit" className="secondary">{rule.active === false ? "Restore" : "Hide"}</button></Form>
                            <Form method="post"><input type="hidden" name="intent" value="deleteRule" /><input type="hidden" name="ruleId" value={rule.id} /><button type="submit" className="danger">Delete</button></Form>
                          </div>
                        </td>
                      </tr>)}
                    </tbody>
                  </table> : <p className="muted">Variant rows are hidden until you click View variant details. This keeps large collections like Stock Bags usable.</p>}
                </div>
              </details>;
            }) : <p className="muted">No synced variant rules yet.</p>}
          </div>
        </details>;
      })}
    </section>

    <style>{`
      .page { max-width: 1180px; margin: 0 auto; padding: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .hero { background: linear-gradient(135deg, #15121d, #421066); color: white; border-radius: 14px; padding: 22px; margin-bottom: 16px; }
      .hero h1 { margin: 0 0 6px; font-size: 28px; }
      .hero p { margin: 0; opacity: .9; }
      .grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
      .wide { width: 100%; }
      .plan-card { border-color: #c7f0d2; }
      .continue-card { border-color: #facc15; background: #fffbeb; }
      .muted { color: #666; font-size: 13px; }
      .gid { display: block; margin-top: 2px; }
      .notice { border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
      .success { background: #e8fff0; border: 1px solid #b8ebc8; }
      .error { background: #ffe8e8; border: 1px solid #efb8b8; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
      .stacked { display: grid; gap: 8px; }
      input, select, textarea { border: 1px solid #bbb; border-radius: 8px; padding: 9px 10px; font: inherit; }
      button { border: 0; border-radius: 8px; background: #111827; color: white; padding: 9px 12px; cursor: pointer; }
      button.secondary { background: #e5e7eb; color: #111827; }
      button.danger { background: #b91c1c; color: #fff; }
      button:disabled { opacity: .55; cursor: not-allowed; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; vertical-align: top; }
      th { font-size: 12px; color: #555; background: #fafafa; }
      .badge { display: inline-block; border-radius: 999px; padding: 3px 8px; font-size: 12px; margin-left: 6px; }
      .badge.green { background: #dcfce7; color: #166534; }
      .badge.yellow { background: #fef3c7; color: #92400e; }
      .badge.red { background: #fee2e2; color: #991b1b; }
      .badge.neutral { background: #eee; color: #333; }
      .pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      .pill-row.tight { margin: 6px 0 2px; }
      .recipe-card { border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; margin: 10px 0; }
      .recipe-body { padding-top: 10px; }
      .summary-box { border: 1px solid #e5e7eb; border-radius: 10px; background: #f9fafb; padding: 12px; margin: 12px 0; }
      .summary-box h3 { margin-top: 0; }
      .source-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; border-top: 1px solid #e5e7eb; padding: 10px 0; }
      .product-group { border: 1px solid #eee; border-radius: 10px; padding: 10px; margin: 10px 0; background: #fff; }
      .button-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .button-link { display: inline-block; border-radius: 8px; background: #111827; color: white; padding: 9px 12px; text-decoration: none; }
      .button-link.secondary { background: #e5e7eb; color: #111827; }
      .inspector-box { border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 10px; padding: 10px; margin-bottom: 10px; }
      .breakdown-grid { display: grid; gap: 4px; font-size: 13px; color: #374151; }

      @media (max-width: 900px) { .grid.two { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr; } }
      .progress-box { margin-top: 8px; }
      .progress-track { margin-top: 6px; height: 8px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }
      .progress-fill { height: 100%; background: #111827; }
    `}</style>
    <section className="card wide next-step-card">
    <h2>Next major section</h2>
    <p className="muted">Once Shopify source linking is complete, use <strong>Margin Review / Price Audit</strong> to compare Shopify prices against calculated costs, target margins, and suggested prices.</p>
  </section>
</main>;
}
