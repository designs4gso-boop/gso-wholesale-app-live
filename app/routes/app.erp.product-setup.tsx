import { Form, Link, useActionData, useLoaderData } from "react-router";
import { salesRulesForFamily } from "../lib/product-family-sales-rules";
import { authenticate } from "../shopify.server";
import { deriveProductVerification, productSetupFamilyLabels } from "../lib/product-family-registry";
import { classifyCalculatorProduct } from "../lib/product-driven-costing.server";
import { DTP_EXTRA_DESIGN_FEES, DTP_HARD_FLOOR_BANDS, DTP_INTERNAL_ART_COST_PER_DESIGN, DTP_LADDER_QUANTITIES, DTP_MIN_JOB_PROFIT, DTP_OWNER_PRICE_LADDERS, DTP_PRICING_SOURCE, DTP_STRATEGIC_MIN_JOB_PROFIT } from "../lib/dtp-owner-pricing.server";
import db from "../db.server";
import {
  QUOTE_RECIPE_PRICING_INCLUDE,
  blockingConversionIssues,
  priceRecipeAtQuantity,
} from "../lib/recipe-pricing.server";
import { materialKind, materialKindLabel } from "../lib/material-classify";

// 15B: recipe-family vocabulary is REGISTRY-first (shared product-family
// registry supplies the canonical families' recipe labels); the extra strings
// preserve every value already stored on live ProductRecipe rows.
const EXTRA_RECIPE_FAMILIES = [
  "Boxes",
  "Apparel / DTF",
  "Sourced / Blank Resale",
  "Custom / Other",
  "Labels",
  "DTP Bags",
  "DTF / Apparel",
];
const PRODUCT_FAMILIES = [...new Set([...productSetupFamilyLabels(), ...EXTRA_RECIPE_FAMILIES])];
const PRODUCTION_MODES = ["in_house", "outsourced", "hybrid"];
const UNIT_OPTIONS = ["each", "sqft", "sqin", "ml", "hour"];

function slugify(value: string) {
  return String(value || "template")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "template";
}

function numberValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Print/blank material classification now lives in app/lib/material-classify.ts
// (shared with the Cost Calculator); the logic moved there verbatim in 12B.1a.

function zoneAreaSqft(zone: any) {
  return ((Number(zone?.widthIn || 0) * Number(zone?.heightIn || 0)) / 144) * Number(zone?.qtyPerUnit ?? zone?.quantityPerUnit ?? 1);
}

function money(value: any) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function pct(value: any) {
  return `${(Number(value) || 0).toFixed(1)}%`;
}
// Same engine + blocking rules used by Quotes / CRM and Agent Review Queue
// conversion, so Product Setup readiness matches those failure reasons exactly.
function recipeReadiness(recipe: any, testQuantity: number) {
  const minQuantity = Math.max(1, Number(recipe?.minQuantity) || 1);
  const baseline = priceRecipeAtQuantity(recipe, minQuantity, {});
  const recipeBlockers = blockingConversionIssues(recipe, baseline);

  if (String(recipe?.productionMode || "in_house") === "outsourced" && !recipe?.vendorProduct) {
    recipeBlockers.push("outsourced recipe has no vendor product / cost tiers attached");
  }

  const safeTestQuantity = Math.max(1, Math.floor(Number(testQuantity) || 0) || minQuantity);
  const priced = priceRecipeAtQuantity(recipe, safeTestQuantity, {});

  return {
    minQuantity,
    testQuantity: safeTestQuantity,
    recipeBlockers,
    dataReady: recipeBlockers.length === 0,
    gate: {
      active: Boolean(recipe?.active),
      useInQuotes: Boolean(recipe?.useInQuotes),
      costReviewNeeded: Boolean(recipe?.costReviewNeeded),
    },
    pricing: {
      unitCost: priced.unitCost,
      unitPrice: priced.unitPrice,
      marginActual: priced.marginActual,
      tierLabel: priced.tierLabel,
      pricingSource: priced.pricingSource,
      warnings: priced.warnings,
      belowMinimum: safeTestQuantity < minQuantity,
    },
  };
}

function costReviewReasonList(recipe: any) {
  return String(recipe?.costReviewReasons || "")
    .split(/\r?\n/)
    .map((reason) => reason.trim())
    .filter(Boolean);
}

function shortDateTime(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function parseTiers(value: any) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function tiersToText(tiers: any[]) {
  if (!tiers?.length) return "";
  return tiers
    .map((tier) => {
      const range = tier.maxQty ? `${tier.minQty}-${tier.maxQty}` : `${tier.minQty}+`;
      const mode = tier.fixedPrice ? `$${tier.fixedPrice}` : `${tier.marginPct ?? 50}%`;
      return `${range}: ${mode}`;
    })
    .join("\n");
}

function parseTierText(text: string, fallbackMargin = 50) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rangeRaw, valueRaw] = line.split(":").map((part) => part?.trim());
      const range = rangeRaw || "1+";
      const value = valueRaw || `${fallbackMargin}`;
      let minQty = 1;
      let maxQty: number | null = null;
      if (range.includes("-")) {
        const [min, max] = range.split("-");
        minQty = Math.max(1, parseInt(min, 10) || 1);
        maxQty = Math.max(minQty, parseInt(max, 10) || minQty);
      } else {
        minQty = Math.max(1, parseInt(range.replace("+", ""), 10) || 1);
      }
      const isFixed = value.includes("$");
      const numeric = Number(value.replace(/[^0-9.]/g, ""));
      return {
        minQty,
        maxQty,
        marginPct: isFixed ? null : (Number.isFinite(numeric) ? numeric : fallbackMargin),
        fixedPrice: isFixed ? (Number.isFinite(numeric) ? numeric : null) : null,
      };
    })
    .sort((a, b) => a.minQty - b.minQty);
}

function templateForFamily(family: string) {
  if (family === "Labels") {
    return [
      { minQty: 64, maxQty: 199, marginPct: 70, fixedPrice: null },
      { minQty: 200, maxQty: 499, marginPct: 65, fixedPrice: null },
      { minQty: 500, maxQty: 999, marginPct: 60, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 55, fixedPrice: null },
      { minQty: 2500, maxQty: 4999, marginPct: 50, fixedPrice: null },
      { minQty: 5000, maxQty: null, marginPct: 45, fixedPrice: null },
    ];
  }
  if (family === "Sticker Bags") {
    return [
      { minQty: 64, maxQty: 199, marginPct: 70, fixedPrice: null },
      { minQty: 200, maxQty: 499, marginPct: 65, fixedPrice: null },
      { minQty: 500, maxQty: 999, marginPct: 60, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 55, fixedPrice: null },
      { minQty: 2500, maxQty: null, marginPct: 50, fixedPrice: null },
    ];
  }
  if (family === "Boxes" || family === "DTP Bags") {
    return [
      { minQty: 500, maxQty: 999, marginPct: 45, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 40, fixedPrice: null },
      { minQty: 2500, maxQty: 4999, marginPct: 35, fixedPrice: null },
      { minQty: 5000, maxQty: 9999, marginPct: 32, fixedPrice: null },
      { minQty: 10000, maxQty: null, marginPct: 30, fixedPrice: null },
    ];
  }
  return [
    { minQty: 1, maxQty: 99, marginPct: 70, fixedPrice: null },
    { minQty: 100, maxQty: 499, marginPct: 60, fixedPrice: null },
    { minQty: 500, maxQty: null, marginPct: 50, fixedPrice: null },
  ];
}

const APPROVED_TEMPLATE_KEYS = PRODUCT_FAMILIES.map((family) => slugify(family));
const UNAPPROVED_TEMPLATE_HINTS = [
  "stock_bags",
  "stock_bag",
  "sourced_products",
  "sourced_product",
  "die_cut_bags",
  "die_cut",
  "general",
  "bag_box_combo",
  "combo",
];

function approvedTemplateName(family: string) {
  return `${family} Pricing Template`;
}

async function archiveDuplicateAndUnapprovedTemplates(shop: string) {
  const allTemplates = await db.productTypeProfile.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  const approvedKeys = new Set(APPROVED_TEMPLATE_KEYS);
  const canonicalByKey = new Map<string, string>();

  for (const family of PRODUCT_FAMILIES) {
    const key = slugify(family);
    const existing = allTemplates.find((template: any) => template.key === key);
    if (existing) canonicalByKey.set(key, existing.id);
  }

  for (const template of allTemplates as any[]) {
    const key = String(template.key || "");
    const nameKey = slugify(template.name || "");
    const isApprovedCanonical = approvedKeys.has(key) && canonicalByKey.get(key) === template.id;
    const isUnapproved = !approvedKeys.has(key) || UNAPPROVED_TEMPLATE_HINTS.some((hint) => key.includes(hint) || nameKey.includes(hint));
    const isDuplicateApprovedName = PRODUCT_FAMILIES.some((family) => {
      const familyKey = slugify(family);
      return nameKey.includes(familyKey) && key !== familyKey;
    });

    if (!isApprovedCanonical && (isUnapproved || isDuplicateApprovedName)) {
      await db.productTypeProfile.update({
        where: { id: template.id },
        data: {
          active: false,
          notes: `${template.notes || ""}\nArchived by template cleanup. Approved families: ${PRODUCT_FAMILIES.join(", ")}.`.trim(),
        },
      });
    }
  }
}

async function createDefaultTemplates(shop: string) {
  for (const family of PRODUCT_FAMILIES) {
    const tiers = templateForFamily(family);
    const key = slugify(family);
    await db.productTypeProfile.upsert({
      where: { shop_key: { shop, key } },
      create: {
        shop,
        key,
        name: `${family} Pricing Template`,
        productionMode: family === "Boxes" || family === "DTP Bags" ? "outsourced" : "in_house",
        minQuantity: tiers[0]?.minQty || 1,
        defaultQuantity: family === "Labels" || family === "Sticker Bags" ? 250 : 1000,
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: Number(tiers[0]?.marginPct || 50),
        pricingMethod: "auto_margin",
        notes: "Approved default GSO pricing template. Edit tier margins as real cost data improves.",
        active: true,
      },
      update: {
        name: approvedTemplateName(family),
        productionMode: family === "Boxes" || family === "DTP Bags" ? "outsourced" : "in_house",
        minQuantity: tiers[0]?.minQty || 1,
        defaultQuantity: family === "Labels" || family === "Sticker Bags" ? 250 : 1000,
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: Number(tiers[0]?.marginPct || 50),
        pricingMethod: "auto_margin",
        active: true,
      },
    });
  }
  await archiveDuplicateAndUnapprovedTemplates(shop);
}

function unitCost(material: any) {
  return Number(material?.calculatedUnitCost || material?.costPerUnit || material?.purchaseCost || 0);
}

function zoneSqft(zone: any) {
  const width = Number(zone.widthIn || 0);
  const height = Number(zone.heightIn || 0);
  const count = Number(zone.qtyPerUnit || 1);
  return (width * height * count) / 144;
}

function materialForZone(zone: any, allZones: any[] = []) {
  if (zone.mediaMode === "media_option" && zone.mediaOption?.material) return zone.mediaOption.material;
  if (zone.mediaMode === "same_as_zone") {
    const source = allZones.find((candidate: any) => candidate.id === zone.sameAsZoneId) || allZones.find((candidate: any) => candidate.position === "Front") || allZones.find((candidate: any) => candidate.id !== zone.id);
    if (source) return materialForZone(source, allZones);
  }
  return zone.material;
}

function mediaLabelForZone(zone: any, allZones: any[] = []) {
  if (zone.mediaMode === "same_as_zone") {
    const source = allZones.find((candidate: any) => candidate.id === zone.sameAsZoneId) || allZones.find((candidate: any) => candidate.position === "Front");
    return source ? `Same as ${source.name}` : "Same as front";
  }
  if (zone.mediaMode === "media_option") return zone.mediaOption?.name || "Media option";
  return materialForZone(zone, allZones)?.name || "No material selected";
}

function estimateRecipe(recipe: any, laborRate = 25) {
  const qty = Math.max(1, Number(recipe.defaultQuantity || recipe.minQuantity || 1));
  const activeMaterialRows = (recipe.materials || []).filter((row: any) => row.active !== false);
  const activeZones = (recipe.labelZones || []).filter((zone: any) => zone.active !== false);
  const materialRowCostPerUnit = activeMaterialRows.reduce((sum: number, row: any) => {
    const base = unitCost(row.material);
    const quantity = Number(row.quantity || 0);
    const wasteMultiplier = row.includeWaste ? 1 + (Number(row.wastePct || 0) / 100) : 1;
    return sum + base * quantity * wasteMultiplier;
  }, 0);
  const zones = activeZones;
  const labelSqftPerUnit = zones.reduce((sum: number, zone: any) => sum + zoneSqft(zone), 0);
  const labelMediaCostPerUnit = zones.reduce((sum: number, zone: any) => {
    const base = unitCost(materialForZone(zone, zones));
    const wasteMultiplier = 1 + (Number(recipe.wastePct || 0) / 100);
    return sum + base * zoneSqft(zone) * wasteMultiplier;
  }, 0);
  const labelApplicationSecondsPerUnit = zones.reduce((sum: number, zone: any) => sum + (Number(zone.applicationSecondsPerLabel || 0) * Number(zone.qtyPerUnit || 1)), 0);
  const materialCostPerUnit = materialRowCostPerUnit + labelMediaCostPerUnit;
  const fallbackApplicationSecondsPerUnit = activeZones.length ? 0 : Number(recipe.applicationLaborSecondsPerUnit || 0);
  const perUnitLaborSeconds = fallbackApplicationSecondsPerUnit + Number(recipe.packingLaborSecondsPerUnit || 0) + labelApplicationSecondsPerUnit;
  const perUnitLaborCost = (perUnitLaborSeconds / 3600) * laborRate;
  const perJobLaborCost = ((Number(recipe.laborMinutes || 0) + Number(recipe.prepressMinutes || 0)) / 60) * laborRate / qty;
  const setupCostPerUnit = Number(recipe.setupCost || 0) / qty;
  const unitCostTotal = materialCostPerUnit + perUnitLaborCost + perJobLaborCost + setupCostPerUnit;
  const margin = Number(recipe.targetMarginPct || 50);
  const suggestedPrice = margin >= 99 ? unitCostTotal : unitCostTotal / (1 - margin / 100);
  return { qty, materialCostPerUnit, materialRowCostPerUnit, labelMediaCostPerUnit, labelSqftPerUnit, labelApplicationSecondsPerUnit, perUnitLaborCost, perJobLaborCost, setupCostPerUnit, unitCostTotal, suggestedPrice };
}

function priceFromMargin(cost: number, marginPct: number) {
  if (marginPct >= 99) return cost;
  return cost / (1 - marginPct / 100);
}


function findOption(options: any[], id?: string | null) {
  return (options || []).find((option: any) => option.id === id);
}

function mediaOptionLabel(options: any[], id?: string | null) {
  const option = findOption(options, id);
  return option ? `${option.name} (${option.material?.name || "material"})` : "Default / not selected";
}

function estimateVariantFromRule(recipe: any, rule: any) {
  const baseEstimate = estimateRecipe(recipe);
  const zones = (recipe.labelZones || []).filter((zone: any) => zone.active !== false);
  const frontZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("front")) || zones[0];
  const backZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("back")) || zones[1];
  const useFront = rule.useFrontZone !== false && frontZone;
  const useBack = rule.useBackZone === true && backZone;
  const selectedZones = [useFront ? frontZone : null, useBack ? backZone : null].filter(Boolean);
  const area = selectedZones.reduce((sum: number, zone: any) => sum + zoneAreaSqft(zone), 0);
  const applySeconds = selectedZones.reduce((sum: number, zone: any) => sum + (Number(zone.applicationSecondsPerLabel || 0) * Number(zone.qtyPerUnit || 1)), 0);
  const mediaOptions = recipe.mediaOptions || [];
  const frontOption = findOption(mediaOptions, rule.frontMediaOptionId) || mediaOptions.find((option: any) => option.defaultOption && option.active !== false) || mediaOptions.find((option: any) => option.active !== false);
  const backOption = rule.backMediaMode === "specific" ? findOption(mediaOptions, rule.backMediaOptionId) : frontOption;
  const mediaCost = selectedZones.reduce((sum: number, zone: any) => {
    const option = zone === backZone ? backOption : frontOption;
    const material = option?.material || zone?.mediaOption?.material || zone?.material;
    return sum + zoneAreaSqft(zone) * unitCost(material);
  }, 0) * (1 + Number(recipe.wastePct || 0) / 100);
  const originalZoneCost = Number(baseEstimate.labelMediaCostPerUnit || 0);
  const originalApplySeconds = Number(baseEstimate.labelApplicationSecondsPerUnit || 0);
  const laborRatePerHour = 20;
  const applyLaborDelta = ((applySeconds - originalApplySeconds) / 3600) * laborRatePerHour;
  const variantUnitCost = Number(baseEstimate.unitCostTotal || 0) - originalZoneCost + mediaCost + applyLaborDelta;
  const price = priceFromMargin(variantUnitCost, Number(recipe.targetMarginPct || 60));
  return { area, applySeconds, mediaCost, unitCost: variantUnitCost, price };
}


function normalizeVariantText(value: any) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectedOptionsText(selectedOptions: any[] = []) {
  return selectedOptions
    .map((option: any) => `${option?.name || ""}: ${option?.value || ""}`)
    .join(" / ");
}

function matchesAny(value: string, terms: string[]) {
  const normalized = normalizeVariantText(value);
  return terms.some((term) => normalized.includes(normalizeVariantText(term)));
}

function pickSideModeFromVariantText(text: string) {
  const normalized = normalizeVariantText(text);
  if (matchesAny(normalized, ["single sided", "single side", "1 sided", "1 side", "one sided", "front only"])) {
    return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
  }
  if (matchesAny(normalized, ["double sided", "double side", "2 sided", "2 side", "two sided", "front and back", "both sides"])) {
    return { sideMode: "double_same", useFrontZone: true, useBackZone: true, backMediaMode: "same_as_front" };
  }
  return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
}

function mediaAliasesForOption(option: any) {
  const name = String(option?.name || "");
  const materialName = String(option?.material?.name || "");
  const aliases = [name, materialName];

  if (/holo|holographic/i.test(`${name} ${materialName}`)) aliases.push("holo", "holographic", "hologram");
  if (/matte|matt/i.test(`${name} ${materialName}`)) aliases.push("matte", "matt");
  if (/gloss/i.test(`${name} ${materialName}`)) aliases.push("gloss", "glossy");
  if (/clear/i.test(`${name} ${materialName}`)) aliases.push("clear", "transparent");
  if (/chrome|silver/i.test(`${name} ${materialName}`)) aliases.push("chrome", "silver");

  return aliases.filter(Boolean);
}

function pickMediaOptionFromVariantText(text: string, mediaOptions: any[] = []) {
  const activeOptions = (mediaOptions || []).filter((option: any) => option.active !== false);
  const normalized = normalizeVariantText(text);

  for (const option of activeOptions) {
    if (mediaAliasesForOption(option).some((alias) => normalized.includes(normalizeVariantText(alias)))) {
      return option;
    }
  }

  return activeOptions.find((option: any) => option.defaultOption) || activeOptions[0] || null;
}

function pickBagColorFromSelectedOptions(selectedOptions: any[] = [], text = "") {
  const colorTerms = [
    "black", "white", "clear", "gold", "silver", "red", "blue", "green", "purple", "pink",
    "orange", "yellow", "brown", "kraft", "mylar", "mixed", "assorted"
  ];

  for (const option of selectedOptions || []) {
    const name = normalizeVariantText(option?.name);
    const value = String(option?.value || "").trim();
    const normalizedValue = normalizeVariantText(value);
    if (!value) continue;
    if (name.includes("color") || name.includes("colour") || name.includes("bag")) return value;
    if (colorTerms.some((color) => normalizedValue === normalizeVariantText(color) || normalizedValue.includes(normalizeVariantText(color)))) return value;
  }

  const normalizedText = normalizeVariantText(text);
  const found = colorTerms.find((color) => normalizedText.includes(normalizeVariantText(color)));
  return found ? found.replace(/\b\w/g, (char) => char.toUpperCase()) : "Any";
}

function autoMapShopifyVariant(variant: any, recipe: any) {
  const selectedOptions = variant?.selectedOptions || [];
  const text = `${variant?.title || ""} / ${selectedOptionsText(selectedOptions)} / ${variant?.sku || ""}`;
  const side = pickSideModeFromVariantText(text);
  const mediaOption = pickMediaOptionFromVariantText(text, recipe?.mediaOptions || []);
  const bagColor = pickBagColorFromSelectedOptions(selectedOptions, text);

  const needsReview: string[] = [];
  if (!mediaOption) needsReview.push("media option");
  if (bagColor === "Any" && matchesAny(text, ["color", "colour", "bag color"])) needsReview.push("bag color");

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
    notes: needsReview.length
      ? `Auto-synced from Shopify. Needs review: ${needsReview.join(", ")}. Quantities are handled by pricing templates, not Shopify variants.`
      : "Auto-synced from Shopify variant options. Quantities are handled by pricing templates, not Shopify variants.",
  };
}

async function fetchShopifyProductVariants(admin: any, productGid: string) {
  const response = await admin.graphql(
    `#graphql
      query ProductRecipeVariantSync($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          options {
            name
            values
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    `,
    { variables: { id: productGid } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  }

  const product = payload?.data?.product;
  return {
    product,
    variants: product?.variants?.edges?.map((edge: any) => edge.node) || [],
  };
}

async function searchShopifyProducts(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query ProductRecipeProductSearch($query: String!) {
        products(first: 10, query: $query) {
          edges {
            node {
              id
              title
              handle
              status
              totalVariants
              featuredImage {
                url
                altText
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: `title:*${safeQuery}* OR sku:*${safeQuery}*` } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  }

  return (payload?.data?.products?.edges || []).map((edge: any) => {
    const product = edge.node;
    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      totalVariants: product.totalVariants || 0,
      imageUrl: product.featuredImage?.url || null,
      variants: (product.variants?.edges || []).map((variantEdge: any) => variantEdge.node),
    };
  });
}


export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const recipeStatus = url.searchParams.get("recipeStatus") || "active";
  const recipeSearch = (url.searchParams.get("recipeSearch") || "").trim();
  const selectedRecipeId = url.searchParams.get("recipeId") || "";
  const recipePage = Math.max(1, parseInt(url.searchParams.get("recipePage") || "1", 10) || 1);
  const requestedLimit = Math.max(5, parseInt(url.searchParams.get("recipeLimit") || "15", 10) || 15);
  const recipeLimit = Math.min(requestedLimit, 25);
  const recipeSkip = (recipePage - 1) * recipeLimit;

  const recipeWhere: any = { shop };
  if (recipeStatus === "active") recipeWhere.active = true;
  if (recipeStatus === "archived") recipeWhere.active = false;
  if (recipeSearch) {
    recipeWhere.OR = [
      { name: { contains: recipeSearch, mode: "insensitive" } },
      { sku: { contains: recipeSearch, mode: "insensitive" } },
      { productFamily: { contains: recipeSearch, mode: "insensitive" } },
    ];
  }

  const selectedWhere = selectedRecipeId ? { shop, id: selectedRecipeId } : null;

  const [templates, recipeCount, recipeRows, selectedRecipe, machinesList, materialsList, vendorProductRows, costBookLinks] = await Promise.all([
    db.productTypeProfile.findMany({
      where: { shop },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, key: true, defaultMarginPct: true, active: true, productionMode: true },
    }),
    db.productRecipe.count({ where: recipeWhere }),
    db.productRecipe.findMany({
      where: recipeWhere,
      orderBy: [{ active: "desc" }, { costReviewNeeded: "desc" }, { updatedAt: "desc" }],
      take: recipeLimit,
      skip: recipeSkip,
      select: {
        id: true,
        name: true,
        sku: true,
        productFamily: true,
        productType: true,
        productionMode: true,
        targetMarginPct: true,
        defaultSellPrice: true,
        costReviewNeeded: true,
        costReviewReasons: true,
        costReviewSyncedAt: true,
        costReviewSource: true,
        active: true,
        updatedAt: true,
        productTypeProfile: { select: { id: true, name: true, defaultMarginPct: true, active: true } },
      },
    }),
    selectedWhere
      ? db.productRecipe.findFirst({
          where: selectedWhere,
          include: {
            ...QUOTE_RECIPE_PRICING_INCLUDE,
            productTypeProfile: true,
            materials: { include: { material: true }, orderBy: { createdAt: "asc" } },
            labelZones: { include: { material: true, mediaOption: { include: { material: true } } }, orderBy: { createdAt: "asc" } },
            mediaOptions: { include: { material: true }, orderBy: [{ active: "desc" }, { name: "asc" }] },
            variantRules: { orderBy: [{ active: "desc" }, { name: "asc" }] },
          },
        })
      : Promise.resolve(null),
    db.machine.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, name: true },
    }),
    db.material.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      take: 200,
      select: { id: true, name: true, materialType: true, baseUnit: true, unit: true, calculatedUnitCost: true, costPerUnit: true },
    }),
    // 15B Vendor Cost tab data: applied VendorProduct records (the calculator
    // cost source of truth) — display + status only; edits stay in the Vendor
    // Cost Book (single cost store, per docs/GSO_ERP_DATA_OWNERSHIP_MAP.md).
    db.vendorProduct.findMany({
      where: { shop },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      take: 60,
      select: { id: true, name: true, vendor: true, vendorSku: true, productType: true, active: true, defaultUnitCost: true, _count: { select: { tiers: true, addOns: true } } },
    }),
    db.vendorCostBookItem.findMany({
      where: { shop, vendorProductId: { not: null } },
      select: { vendorProductId: true, status: true },
      take: 200,
    }),
  ]);

  const bookStatusByVendorProduct = new Map<string, string>();
  for (const link of costBookLinks as any[]) if (link.vendorProductId) bookStatusByVendorProduct.set(link.vendorProductId, link.status || "");
  const vendorCostRows = (vendorProductRows as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    vendor: row.vendor || "",
    sku: row.vendorSku || "",
    klass: classifyCalculatorProduct({ name: row.name, productType: row.productType, vendor: row.vendor, vendorSku: row.vendorSku }).klass,
    unitCost: Number(row.defaultUnitCost) || 0,
    tierCount: row._count.tiers,
    addOnCount: row._count.addOns,
    ...deriveProductVerification({ active: row.active, unitCost: row.defaultUnitCost, tierCount: row._count.tiers, costBookStatus: bookStatusByVendorProduct.get(row.id) || null }),
  }));

  const activeTemplates = templates.filter((template: any) => template.active);
  const recipeTotalPages = Math.max(1, Math.ceil(recipeCount / recipeLimit));
  const selectedRecipeReadiness = selectedRecipe
    ? recipeReadiness(selectedRecipe, Math.max(1, Number((selectedRecipe as any).minQuantity) || 1))
    : null;

  // 15C.2: DTP owner-pricing rules (read-only display; centralized in
  // app/lib/dtp-owner-pricing.server.ts — next step for in-app editing is
  // moving the table into ErpAdminSetting or a dedicated model).
  const dtpPricingRules = {
    source: DTP_PRICING_SOURCE,
    quantities: DTP_LADDER_QUANTITIES,
    ladders: Object.entries(DTP_OWNER_PRICE_LADDERS).map(([sku, ladder]) => ({ sku, prices: DTP_LADDER_QUANTITIES.map((qty) => (ladder as Record<number, number>)[qty] ?? null) })),
    floors: DTP_HARD_FLOOR_BANDS,
    minJobProfit: DTP_MIN_JOB_PROFIT,
    strategicMinJobProfit: DTP_STRATEGIC_MIN_JOB_PROFIT,
    fees: DTP_EXTRA_DESIGN_FEES,
    artCostPerDesign: DTP_INTERNAL_ART_COST_PER_DESIGN,
  };

  return Response.json({
    templates,
    activeTemplates,
    recipes: recipeRows,
    selectedRecipe,
    selectedRecipeReadiness,
    vendorCostRows,
    dtpPricingRules,
    machines: machinesList,
    materialsAvailable: materialsList,
    selectedRecipeId,
    recipeStatus,
    recipeSearch,
    recipeCount,
    recipePage,
    recipeLimit,
    recipeTotalPages,
    hasPrevRecipes: recipePage > 1,
    hasNextRecipes: recipePage < recipeTotalPages,
    memorySafeMode: true,
  });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "seedTemplates") {
    await createDefaultTemplates(shop);
    return Response.json({ ok: true, message: "Approved pricing templates created/refreshed and old duplicates archived." });
  }

  if (intent === "cleanupTemplates") {
    await archiveDuplicateAndUnapprovedTemplates(shop);
    return Response.json({ ok: true, message: "Duplicate and unapproved pricing templates archived." });
  }

  if (intent === "createTemplate") {
    const name = String(formData.get("name") || "New Pricing Template").trim();
    const family = String(formData.get("family") || "Labels");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("defaultMarginPct"), 50));
    const key = `custom_${slugify(family)}_${slugify(name)}_${Date.now()}`.slice(0, 80);
    await db.productTypeProfile.create({
      data: {
        shop,
        key,
        name,
        productionMode: String(formData.get("productionMode") || "in_house"),
        minQuantity: intValue(formData.get("minQuantity"), tiers[0]?.minQty || 1),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: numberValue(formData.get("defaultMarginPct"), 50),
        pricingMethod: "auto_margin",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Pricing template created." });
  }

  if (intent === "updateTemplate") {
    const id = String(formData.get("templateId") || "");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("defaultMarginPct"), 50));
    await db.productTypeProfile.updateMany({
      where: { shop, id },
      data: {
        name: String(formData.get("name") || "Pricing Template"),
        productionMode: String(formData.get("productionMode") || "in_house"),
        minQuantity: intValue(formData.get("minQuantity"), tiers[0]?.minQty || 1),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: numberValue(formData.get("defaultMarginPct"), 50),
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Pricing template updated." });
  }

  if (intent === "archiveTemplate") {
    await db.productTypeProfile.updateMany({ where: { shop, id: String(formData.get("templateId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Pricing template archived." });
  }

  if (intent === "restoreTemplate") {
    await db.productTypeProfile.updateMany({ where: { shop, id: String(formData.get("templateId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Pricing template restored." });
  }

  if (intent === "deleteTemplate") {
    const templateId = String(formData.get("templateId") || "");
    const usedCount = await db.productRecipe.count({ where: { shop, productTypeProfileId: templateId } });
    if (usedCount > 0) {
      await db.productTypeProfile.updateMany({ where: { shop, id: templateId }, data: { active: false } });
      return Response.json({ ok: true, message: "Template is used by recipes, so it was archived instead of deleted." });
    }
    await db.productTypeProfile.deleteMany({ where: { shop, id: templateId } });
    return Response.json({ ok: true, message: "Unused pricing template deleted." });
  }

  if (intent === "createRecipe") {
    const templateId = String(formData.get("templateId") || "") || null;
    const machineId = String(formData.get("machineId") || "") || null;
    const name = String(formData.get("name") || "New Product Recipe").trim();
    const family = String(formData.get("productFamily") || "Labels");
    const recipe = await db.productRecipe.create({
      data: {
        shop,
        name,
        sku: String(formData.get("sku") || "") || null,
        productType: slugify(family),
        productFamily: family,
        productTypeProfileId: templateId,
        pricingTemplateMode: String(formData.get("pricingTemplateMode") || "template"),
        productionMode: String(formData.get("productionMode") || "in_house"),
        productGid: String(formData.get("productGid") || "") || null,
        variantGid: String(formData.get("variantGid") || "") || null,
        minQuantity: intValue(formData.get("minQuantity"), 64),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        targetMarginPct: numberValue(formData.get("targetMarginPct"), 60),
        defaultSellPrice: positiveOrNull(formData.get("defaultSellPrice")),
        wastePct: numberValue(formData.get("wastePct"), 15),
        setupCost: numberValue(formData.get("setupCost"), 0),
        laborMinutes: numberValue(formData.get("laborMinutes"), 0),
        prepressMinutes: numberValue(formData.get("prepressMinutes"), 0),
        applicationLaborSecondsPerUnit: numberValue(formData.get("applicationLaborSecondsPerUnit"), 0),
        packingLaborSecondsPerUnit: numberValue(formData.get("packingLaborSecondsPerUnit"), 0),
        costReviewNeeded: String(formData.get("costReviewNeeded") || "") === "on",
        useInQuotes: String(formData.get("useInQuotes") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
        machineRules: machineId ? { create: [{ shop, preferredMachineId: machineId, allowOverflow: true }] } : undefined,
      },
    });

    if (templateId) {
      const template = await db.productTypeProfile.findFirst({ where: { shop, id: templateId } });
      const tiers = parseTiers(template?.tierTemplate);
      if (tiers.length) {
        await db.recipeTier.createMany({
          data: tiers.map((tier: any) => ({
            shop,
            recipeId: recipe.id,
            minQty: Number(tier.minQty || 1),
            maxQty: tier.maxQty ? Number(tier.maxQty) : null,
            marginPct: tier.marginPct == null ? null : Number(tier.marginPct),
            fixedPrice: tier.fixedPrice == null ? null : Number(tier.fixedPrice),
          })),
        });
      }
    }

    return Response.json({ ok: true, message: "Product recipe created." });
  }

  if (intent === "updateRecipe") {
    const recipeId = String(formData.get("recipeId") || "");
    const machineId = String(formData.get("machineId") || "") || null;
    const existingRecipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      select: { productType: true, useInQuotes: true },
    });

    if (!existingRecipe) {
      return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });
    }

    if (formData.has("machineId") && machineId) {
      const machine = await db.machine.findFirst({ where: { shop, id: machineId }, select: { id: true } });
      if (!machine) {
        return Response.json({ ok: false, message: "Selected machine was not found." }, { status: 400 });
      }
    }

    const managesQuoteFlag = formData.has("manageQuoteFlag");
    const wantsUseInQuotes = String(formData.get("useInQuotes") || "") === "on";
    const wasUseInQuotes = Boolean(existingRecipe.useInQuotes);

    // Partial update: only fields the submitting form actually posts are
    // written, so a save from one form can never wipe values owned by another
    // form (template links, Shopify GIDs, cost review flag, MOQ, labor fields).
    const data: Record<string, unknown> = {};
    if (formData.has("name")) data.name = String(formData.get("name") || "Product Recipe");
    if (formData.has("sku")) data.sku = String(formData.get("sku") || "") || null;
    if (formData.has("productFamily")) data.productFamily = String(formData.get("productFamily") || "Labels");
    if (formData.has("productType")) data.productType = String(formData.get("productType") || existingRecipe.productType || "label");
    if (formData.has("templateId")) data.productTypeProfileId = String(formData.get("templateId") || "") || null;
    if (formData.has("pricingTemplateMode")) data.pricingTemplateMode = String(formData.get("pricingTemplateMode") || "template");
    if (formData.has("productionMode")) data.productionMode = String(formData.get("productionMode") || "in_house");
    if (formData.has("productGid")) data.productGid = String(formData.get("productGid") || "") || null;
    if (formData.has("variantGid")) data.variantGid = String(formData.get("variantGid") || "") || null;
    if (formData.has("minQuantity")) data.minQuantity = Math.max(1, intValue(formData.get("minQuantity"), 1));
    if (formData.has("defaultQuantity")) data.defaultQuantity = Math.max(1, intValue(formData.get("defaultQuantity"), 1));
    if (formData.has("targetMarginPct")) data.targetMarginPct = numberValue(formData.get("targetMarginPct"), 60);
    if (formData.has("defaultSellPrice")) data.defaultSellPrice = positiveOrNull(formData.get("defaultSellPrice"));
    if (formData.has("widthIn")) data.widthIn = positiveOrNull(formData.get("widthIn"));
    if (formData.has("heightIn")) data.heightIn = positiveOrNull(formData.get("heightIn"));
    if (formData.has("wastePct")) data.wastePct = numberValue(formData.get("wastePct"), 15);
    if (formData.has("setupCost")) data.setupCost = numberValue(formData.get("setupCost"), 0);
    if (formData.has("laborMinutes")) data.laborMinutes = numberValue(formData.get("laborMinutes"), 0);
    if (formData.has("prepressMinutes")) data.prepressMinutes = numberValue(formData.get("prepressMinutes"), 0);
    if (formData.has("applicationLaborSecondsPerUnit")) data.applicationLaborSecondsPerUnit = numberValue(formData.get("applicationLaborSecondsPerUnit"), 0);
    if (formData.has("packingLaborSecondsPerUnit")) data.packingLaborSecondsPerUnit = numberValue(formData.get("packingLaborSecondsPerUnit"), 0);
    if (formData.has("costReviewNeeded")) data.costReviewNeeded = String(formData.get("costReviewNeeded") || "") === "on";
    if (formData.has("notes")) data.notes = String(formData.get("notes") || "") || null;
    if (managesQuoteFlag) {
      // Turning the quote flag ON is deferred until the post-save readiness
      // check below passes; turning it off or keeping it on is applied here.
      data.useInQuotes = wantsUseInQuotes && wasUseInQuotes;
    }

    if (Object.keys(data).length) {
      await db.productRecipe.updateMany({
        where: { shop, id: recipeId },
        data,
      });
    }
    // Only rewrite machine rules when the submitting form actually posts a
    // machineId field. The Recipe Details form does not, and wiping rules on
    // every save was silently stripping the preferred machine.
    if (formData.has("machineId")) {
      await db.recipeMachineRule.deleteMany({ where: { shop, recipeId } });
      if (machineId) {
        await db.recipeMachineRule.create({ data: { shop, recipeId, preferredMachineId: machineId, allowOverflow: true } });
      }
    }

    if (managesQuoteFlag && wantsUseInQuotes && !wasUseInQuotes) {
      const updated = await db.productRecipe.findFirst({
        where: { shop, id: recipeId },
        include: QUOTE_RECIPE_PRICING_INCLUDE,
      });

      if (!updated) {
        return Response.json({ ok: false, message: "Saved, but Use in Quotes stayed off: recipe was not found after save." });
      }

      const readiness = recipeReadiness(updated, Math.max(1, Number(updated.minQuantity) || 1));
      const blockers = [...readiness.recipeBlockers];
      if (!updated.active) blockers.push("recipe is archived / not active");
      if (updated.costReviewNeeded) blockers.push("cost review is still flagged");

      if (blockers.length) {
        return Response.json({
          ok: false,
          message: `Saved, but Use in Quotes stayed off: ${blockers.join("; ")}.`,
        });
      }

      await db.productRecipe.updateMany({ where: { shop, id: recipeId }, data: { useInQuotes: true } });
      return Response.json({ ok: true, message: "Product recipe updated and enabled for Quotes / CRM." });
    }

    return Response.json({ ok: true, message: "Product recipe updated." });
  }

  if (intent === "testRecipePrice") {
    const recipeId = String(formData.get("recipeId") || "");
    const requestedQuantity = Math.max(1, Math.floor(Number(formData.get("testQuantity")) || 0));
    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      include: QUOTE_RECIPE_PRICING_INCLUDE,
    });

    if (!recipe) {
      return Response.json({ ok: false, message: "Recipe not found for pricing test." }, { status: 404 });
    }

    const readiness = recipeReadiness(recipe, requestedQuantity || Math.max(1, Number(recipe.minQuantity) || 1));
    return Response.json({
      ok: true,
      intent: "testRecipePrice",
      recipeId,
      message: `Test price calculated at quantity ${readiness.testQuantity}.`,
      readiness,
    });
  }

  if (intent === "archiveRecipe") {
    await db.productRecipe.updateMany({ where: { shop, id: String(formData.get("recipeId") || "") }, data: { active: false, useInQuotes: false } });
    return Response.json({ ok: true, message: "Product recipe archived." });
  }

  if (intent === "restoreRecipe") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      select: {
        id: true,
        name: true,
        sku: true,
        productFamily: true,
        productType: true,
        targetMarginPct: true,
        costReviewNeeded: true,
        tiers: { select: { id: true }, take: 1 },
      },
    });

    if (!recipe) {
      return Response.json({ ok: false, message: "Recipe cannot be activated because it was not found." }, { status: 404 });
    }

    const missingReasons = [];
    if (recipe.costReviewNeeded) missingReasons.push("finish cost review");
    if (!String(recipe.name || "").trim()) missingReasons.push("add product name");
    if (!String(recipe.sku || "").trim()) missingReasons.push("add SKU");
    if (!String(recipe.productFamily || "").trim()) missingReasons.push("add product family");
    if (!String(recipe.productType || "").trim()) missingReasons.push("add internal product type key");
    if (!Number.isFinite(Number(recipe.targetMarginPct)) || Number(recipe.targetMarginPct) <= 0) missingReasons.push("set target margin");
    if (!recipe.tiers?.length) missingReasons.push("add quantity tiers");

    if (missingReasons.length) {
      return Response.json({
        ok: false,
        message: `Recipe cannot be activated yet. Please ${missingReasons.join(", ")} first.`,
      }, { status: 400 });
    }

    await db.productRecipe.updateMany({ where: { shop, id: recipeId }, data: { active: true } });
    return Response.json({ ok: true, message: "Product recipe restored after activation checks." });
  }

  if (intent === "deleteRecipeForever") {
    const recipeId = String(formData.get("recipeId") || "");
    if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
    // 15G.1: the whole cascade runs in ONE transaction — a mid-sequence
    // failure can no longer leave a recipe half-deleted (orphaned children).
    await db.$transaction([
      db.recipeMaterial.deleteMany({ where: { shop, recipeId } }),
      db.recipeLabelZone.deleteMany({ where: { shop, recipeId } }),
      db.recipeMediaOption.deleteMany({ where: { shop, recipeId } }),
      db.recipeInkRequirement.deleteMany({ where: { shop, recipeId } }),
      db.recipeMachineRule.deleteMany({ where: { shop, recipeId } }),
      db.recipeTier.deleteMany({ where: { shop, recipeId } }),
      db.recipeAddOn.deleteMany({ where: { shop, recipeId } }),
      db.sourcedCostTier.deleteMany({ where: { shop, recipeId } }),
      db.productRecipe.deleteMany({ where: { shop, id: recipeId } }),
    ]);
    return Response.json({ ok: true, message: "Product recipe permanently deleted." });
  }



  if (intent === "searchShopifyProductsForRecipe") {
    const recipeId = String(formData.get("recipeId") || "");
    const query = String(formData.get("productSearch") || "").trim();
    if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
    if (!query) return Response.json({ ok: false, message: "Enter a Shopify product name or SKU to search." }, { status: 400 });

    const results = await searchShopifyProducts(admin, query);
    return Response.json({
      ok: true,
      message: results.length ? `Found ${results.length} Shopify product(s). Pick one to sync variants.` : "No Shopify products found. Try a different product name or SKU.",
      productSearchRecipeId: recipeId,
      productSearchQuery: query,
      productSearchResults: results,
    });
  }

  if (intent === "linkShopifyProductToRecipe") {
    const recipeId = String(formData.get("recipeId") || "");
    const productGid = String(formData.get("shopifyProductGid") || "").trim();
    const productTitle = String(formData.get("shopifyProductTitle") || "").trim();
    if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or Shopify product." }, { status: 400 });

    await db.productRecipe.updateMany({
      where: { shop, id: recipeId },
      data: {
        productGid,
        notes: productTitle ? `Linked Shopify product: ${productTitle}` : undefined,
      },
    });
    return Response.json({ ok: true, message: `Linked Shopify product${productTitle ? `: ${productTitle}` : ""}. Now sync variants.` });
  }

  if (intent === "syncShopifyVariants") {
    const recipeId = String(formData.get("recipeId") || "");
    const productGid = String(formData.get("shopifyProductGid") || "").trim();

    if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
    if (!productGid) return Response.json({ ok: false, message: "Add or paste the Shopify Product GID first." }, { status: 400 });

    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      include: { mediaOptions: { include: { material: true } } },
    });
    if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

    const { product, variants } = await fetchShopifyProductVariants(admin, productGid);
    if (!product) return Response.json({ ok: false, message: "Shopify product not found. Check the Product GID." }, { status: 404 });

    await db.productRecipe.updateMany({
      where: { shop, id: recipeId },
      data: {
        productGid,
        notes: recipe.notes || "",
      },
    });

    let created = 0;
    let updated = 0;

    for (const variant of variants) {
      const mapped = autoMapShopifyVariant(variant, recipe);
      const existing = await db.recipeVariantRule.findFirst({
        where: { shop, recipeId, shopifyVariantGid: variant.id },
      });

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
        await db.recipeVariantRule.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await db.recipeVariantRule.create({ data: { shop, recipeId, ...data } });
        created += 1;
      }
    }

    return Response.json({
      ok: true,
      message: `Synced ${variants.length} Shopify variant(s): ${created} created, ${updated} updated. Quantities were not parsed because tiers are handled by pricing templates.`,
    });
  }

  if (intent === "autoMapExistingVariantRules") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      include: { mediaOptions: { include: { material: true } } },
    });
    if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

    const rules = await db.recipeVariantRule.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    let updated = 0;

    for (const rule of rules) {
      const mapped = autoMapShopifyVariant(
        {
          title: rule.shopifyVariantTitle || rule.name,
          sku: rule.sku,
          selectedOptions: [],
        },
        recipe
      );

      await db.recipeVariantRule.update({
        where: { id: rule.id },
        data: {
          sideMode: mapped.sideMode,
          bagColor: rule.bagColor || mapped.bagColor,
          frontMediaOptionId: mapped.frontMediaOptionId || rule.frontMediaOptionId,
          backMediaMode: mapped.backMediaMode,
          backMediaOptionId: mapped.backMediaOptionId,
          useFrontZone: mapped.useFrontZone,
          useBackZone: mapped.useBackZone,
          notes: rule.notes || mapped.notes,
        },
      });
      updated += 1;
    }

    return Response.json({ ok: true, message: `Auto-mapped ${updated} existing variant mapping(s). Quantities remain controlled by pricing templates.` });
  }


  if (intent === "addVariantRule") {
    await db.recipeVariantRule.create({
      data: {
        shop,
        recipeId: String(formData.get("recipeId") || ""),
        name: String(formData.get("name") || "New variant rule"),
        shopifyProductGid: String(formData.get("shopifyProductGid") || "") || null,
        shopifyVariantGid: String(formData.get("shopifyVariantGid") || "") || null,
        shopifyVariantTitle: String(formData.get("shopifyVariantTitle") || "") || null,
        sku: String(formData.get("sku") || "") || null,
        sideMode: String(formData.get("sideMode") || "single"),
        bagColor: String(formData.get("bagColor") || "") || null,
        frontMediaOptionId: String(formData.get("frontMediaOptionId") || "") || null,
        backMediaMode: String(formData.get("backMediaMode") || "same_as_front"),
        backMediaOptionId: String(formData.get("backMediaOptionId") || "") || null,
        useFrontZone: String(formData.get("useFrontZone") || "") === "on",
        useBackZone: String(formData.get("useBackZone") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Variant pricing rule added." });
  }

  if (intent === "updateVariantRule") {
    await db.recipeVariantRule.updateMany({
      where: { shop, id: String(formData.get("variantRuleId") || "") },
      data: {
        name: String(formData.get("name") || "Variant rule"),
        shopifyProductGid: String(formData.get("shopifyProductGid") || "") || null,
        shopifyVariantGid: String(formData.get("shopifyVariantGid") || "") || null,
        shopifyVariantTitle: String(formData.get("shopifyVariantTitle") || "") || null,
        sku: String(formData.get("sku") || "") || null,
        sideMode: String(formData.get("sideMode") || "single"),
        bagColor: String(formData.get("bagColor") || "") || null,
        frontMediaOptionId: String(formData.get("frontMediaOptionId") || "") || null,
        backMediaMode: String(formData.get("backMediaMode") || "same_as_front"),
        backMediaOptionId: String(formData.get("backMediaOptionId") || "") || null,
        useFrontZone: String(formData.get("useFrontZone") || "") === "on",
        useBackZone: String(formData.get("useBackZone") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Variant pricing rule updated." });
  }

  if (intent === "archiveVariantRule") {
    await db.recipeVariantRule.updateMany({ where: { shop, id: String(formData.get("variantRuleId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Variant pricing rule hidden." });
  }

  if (intent === "restoreVariantRule") {
    await db.recipeVariantRule.updateMany({ where: { shop, id: String(formData.get("variantRuleId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Variant pricing rule restored." });
  }

  if (intent === "deleteVariantRule") {
    await db.recipeVariantRule.deleteMany({ where: { shop, id: String(formData.get("variantRuleId") || "") } });
    return Response.json({ ok: true, message: "Variant pricing rule permanently deleted." });
  }

  if (intent === "cleanupDuplicateVariantRules") {
    const recipeId = String(formData.get("recipeId") || "");
    const rows = await db.recipeVariantRule.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.shopifyVariantGid || row.name}|${row.sideMode}|${row.bagColor || ""}|${row.frontMediaOptionId || ""}|${row.backMediaMode || ""}|${row.backMediaOptionId || ""}`.toLowerCase();
      if (seen.has(key)) duplicateIds.push(row.id);
      else seen.add(key);
    }
    if (duplicateIds.length) await db.recipeVariantRule.deleteMany({ where: { shop, id: { in: duplicateIds } } });
    return Response.json({ ok: true, message: `${duplicateIds.length} duplicate variant rule(s) deleted.` });
  }

  if (intent === "addMaterial") {
    const recipeId = String(formData.get("recipeId") || "");
    const materialId = String(formData.get("materialId") || "");
    const [recipe, material] = await Promise.all([
      db.productRecipe.findFirst({ where: { shop, id: recipeId }, select: { id: true } }),
      db.material.findFirst({ where: { shop, id: materialId }, select: { id: true } }),
    ]);

    if (!recipe || !material) {
      return Response.json({ ok: false, message: "Recipe or material was not found." }, { status: 400 });
    }

    const quantityRaw = numberValue(formData.get("quantity"), 1);

    await db.recipeMaterial.create({
      data: {
        shop,
        recipeId,
        materialId,
        usageType: String(formData.get("usageType") || "media"),
        // numberValue("") is 0, so an emptied quantity field must not save a
        // zero multiplier that silently removes this row's cost contribution.
        quantity: quantityRaw > 0 ? quantityRaw : 1,
        unit: String(formData.get("unit") || "each"),
        wastePct: numberValue(formData.get("wastePct"), 0),
        includeWaste: String(formData.get("includeWaste") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Material added to recipe." });
  }

  if (intent === "updateMaterialRow") {
    await db.recipeMaterial.updateMany({
      where: { shop, id: String(formData.get("recipeMaterialId") || "") },
      data: {
        materialId: String(formData.get("materialId") || ""),
        usageType: String(formData.get("usageType") || "media"),
        quantity: numberValue(formData.get("quantity"), 1),
        unit: String(formData.get("unit") || "each"),
        wastePct: numberValue(formData.get("wastePct"), 0),
        includeWaste: String(formData.get("includeWaste") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Recipe material updated." });
  }

  if (intent === "archiveMaterialRow") {
    await db.recipeMaterial.updateMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Recipe material hidden." });
  }

  if (intent === "restoreMaterialRow") {
    await db.recipeMaterial.updateMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Recipe material restored." });
  }

  if (intent === "removeMaterial" || intent === "deleteMaterialRow") {
    await db.recipeMaterial.deleteMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") } });
    return Response.json({ ok: true, message: "Recipe material permanently deleted." });
  }

  if (intent === "cleanupDuplicateMaterials") {
    const recipeId = String(formData.get("recipeId") || "");
    const rows = await db.recipeMaterial.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.materialId}|${row.usageType}|${row.unit}`;
      if (seen.has(key)) duplicateIds.push(row.id);
      else seen.add(key);
    }
    if (duplicateIds.length) await db.recipeMaterial.deleteMany({ where: { shop, id: { in: duplicateIds } } });
    return Response.json({ ok: true, message: `${duplicateIds.length} duplicate material row(s) deleted.` });
  }

  if (intent === "addMediaOption") {
    const recipeId = String(formData.get("recipeId") || "");
    const materialId = String(formData.get("materialId") || "");
    const makeDefault = String(formData.get("defaultOption") || "") === "on";
    if (makeDefault) await db.recipeMediaOption.updateMany({ where: { shop, recipeId }, data: { defaultOption: false } });
    await db.recipeMediaOption.create({
      data: {
        shop,
        recipeId,
        materialId,
        name: String(formData.get("name") || "Media option"),
        defaultOption: makeDefault,
        premiumOption: String(formData.get("premiumOption") || "") === "on",
        priceAdjustPct: numberValue(formData.get("priceAdjustPct"), 0),
        priceAdjustFlat: numberValue(formData.get("priceAdjustFlat"), 0),
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Media option added." });
  }

  if (intent === "updateMediaOption") {
    const id = String(formData.get("mediaOptionId") || "");
    const recipeId = String(formData.get("recipeId") || "");
    const makeDefault = String(formData.get("defaultOption") || "") === "on";
    if (makeDefault) await db.recipeMediaOption.updateMany({ where: { shop, recipeId }, data: { defaultOption: false } });
    await db.recipeMediaOption.updateMany({
      where: { shop, id },
      data: {
        name: String(formData.get("name") || "Media option"),
        materialId: String(formData.get("materialId") || ""),
        defaultOption: makeDefault,
        premiumOption: String(formData.get("premiumOption") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Media option updated." });
  }

  if (intent === "archiveMediaOption") {
    await db.recipeMediaOption.updateMany({ where: { shop, id: String(formData.get("mediaOptionId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Media option archived." });
  }

  if (intent === "restoreMediaOption") {
    await db.recipeMediaOption.updateMany({ where: { shop, id: String(formData.get("mediaOptionId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Media option restored." });
  }

  if (intent === "deleteMediaOption") {
    const id = String(formData.get("mediaOptionId") || "");
    const usedCount = await db.recipeLabelZone.count({ where: { shop, mediaOptionId: id } });
    if (usedCount > 0) {
      await db.recipeMediaOption.updateMany({ where: { shop, id }, data: { active: false } });
      return Response.json({ ok: true, message: "Media option is used by zones, so it was archived instead of deleted." });
    }
    await db.recipeMediaOption.deleteMany({ where: { shop, id } });
    return Response.json({ ok: true, message: "Unused media option deleted." });
  }

  if (intent === "deleteMediaOptionForever") {
    const id = String(formData.get("mediaOptionId") || "");
    await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: id }, data: { mediaOptionId: null, mediaMode: "fixed" } });
    await db.recipeMediaOption.deleteMany({ where: { shop, id } });
    return Response.json({ ok: true, message: "Media option permanently deleted and removed from zones." });
  }

  if (intent === "addLabelZone") {
    const recipeId = String(formData.get("recipeId") || "");
    const materialId = String(formData.get("materialId") || "") || null;
    await db.recipeLabelZone.create({
      data: {
        shop,
        recipeId,
        materialId,
        mediaMode: String(formData.get("mediaMode") || "fixed"),
        mediaOptionId: String(formData.get("mediaOptionId") || "") || null,
        sameAsZoneId: String(formData.get("sameAsZoneId") || "") || null,
        name: String(formData.get("name") || "Label zone"),
        position: String(formData.get("position") || "Front"),
        widthIn: numberValue(formData.get("widthIn"), 0),
        heightIn: numberValue(formData.get("heightIn"), 0),
        qtyPerUnit: numberValue(formData.get("qtyPerUnit"), 1),
        applicationSecondsPerLabel: numberValue(formData.get("applicationSecondsPerLabel"), 0),
        required: String(formData.get("required") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Label/application zone added." });
  }

  if (intent === "updateLabelZone") {
    await db.recipeLabelZone.updateMany({
      where: { shop, id: String(formData.get("zoneId") || "") },
      data: {
        materialId: String(formData.get("materialId") || "") || null,
        mediaMode: String(formData.get("mediaMode") || "fixed"),
        mediaOptionId: String(formData.get("mediaOptionId") || "") || null,
        sameAsZoneId: String(formData.get("sameAsZoneId") || "") || null,
        name: String(formData.get("name") || "Label zone"),
        position: String(formData.get("position") || "Front"),
        widthIn: numberValue(formData.get("widthIn"), 0),
        heightIn: numberValue(formData.get("heightIn"), 0),
        qtyPerUnit: numberValue(formData.get("qtyPerUnit"), 1),
        applicationSecondsPerLabel: numberValue(formData.get("applicationSecondsPerLabel"), 0),
        required: String(formData.get("required") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Label/application zone updated." });
  }

  if (intent === "archiveLabelZone") {
    await db.recipeLabelZone.updateMany({ where: { shop, id: String(formData.get("zoneId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Label/application zone hidden." });
  }

  if (intent === "restoreLabelZone") {
    await db.recipeLabelZone.updateMany({ where: { shop, id: String(formData.get("zoneId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Label/application zone restored." });
  }

  if (intent === "duplicateLabelZone") {
    const zoneId = String(formData.get("zoneId") || "");
    const zone = await db.recipeLabelZone.findFirst({ where: { shop, id: zoneId } });
    if (!zone) return Response.json({ ok: false, message: "Label zone not found." }, { status: 404 });
    await db.recipeLabelZone.create({
      data: {
        shop,
        recipeId: zone.recipeId,
        materialId: zone.materialId,
        mediaMode: zone.mediaMode || "fixed",
        mediaOptionId: zone.mediaOptionId,
        sameAsZoneId: zone.sameAsZoneId,
        name: `${zone.name || "Label zone"} copy`,
        position: zone.position === "Front" ? "Back" : zone.position,
        widthIn: zone.widthIn,
        heightIn: zone.heightIn,
        qtyPerUnit: zone.qtyPerUnit,
        applicationSecondsPerLabel: zone.applicationSecondsPerLabel,
        required: zone.required,
        notes: zone.notes,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Label zone duplicated." });
  }

  if (intent === "removeLabelZone" || intent === "deleteLabelZone") {
    await db.recipeLabelZone.deleteMany({ where: { shop, id: String(formData.get("zoneId") || "") } });
    return Response.json({ ok: true, message: "Label/application zone permanently deleted." });
  }


  if (intent === "cleanupDuplicateMediaOptions") {
    const recipeId = String(formData.get("recipeId") || "");
    const options = await db.recipeMediaOption.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Map<string, any>();
    let removed = 0;
    for (const option of options as any[]) {
      const key = `${String(option.name || "").trim().toLowerCase()}|${option.materialId || ""}`;
      const keeper = seen.get(key);
      if (!keeper) {
        seen.set(key, option);
        continue;
      }
      await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: option.id }, data: { mediaOptionId: keeper.id } });
      if (option.defaultOption && !keeper.defaultOption) {
        await db.recipeMediaOption.updateMany({ where: { shop, id: keeper.id }, data: { defaultOption: true } });
      }
      await db.recipeMediaOption.deleteMany({ where: { shop, id: option.id } });
      removed += 1;
    }
    return Response.json({ ok: true, message: `${removed} duplicate media option(s) merged/deleted.` });
  }

  if (intent === "cleanupDuplicateLabelZones") {
    const recipeId = String(formData.get("recipeId") || "");
    const zones = await db.recipeLabelZone.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Map<string, any>();
    let removed = 0;
    for (const zone of zones as any[]) {
      const key = [
        String(zone.name || "").trim().toLowerCase(),
        String(zone.position || ""),
        Number(zone.widthIn || 0).toFixed(4),
        Number(zone.heightIn || 0).toFixed(4),
        Number(zone.qtyPerUnit || 0).toFixed(4),
        String(zone.mediaMode || "fixed"),
        String(zone.materialId || ""),
        String(zone.mediaOptionId || ""),
        String(zone.sameAsZoneId || ""),
      ].join("|");
      const keeper = seen.get(key);
      if (!keeper) {
        seen.set(key, zone);
        continue;
      }
      await db.recipeLabelZone.updateMany({ where: { shop, sameAsZoneId: zone.id }, data: { sameAsZoneId: keeper.id } });
      await db.recipeLabelZone.deleteMany({ where: { shop, id: zone.id } });
      removed += 1;
    }
    return Response.json({ ok: true, message: `${removed} duplicate label zone(s) deleted.` });
  }

  if (intent === "cleanupAllRecipeDuplicates") {
    const recipeId = String(formData.get("recipeId") || "");

    const options = await db.recipeMediaOption.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenOptions = new Map<string, any>();
    let removedOptions = 0;
    for (const option of options as any[]) {
      const key = `${String(option.name || "").trim().toLowerCase()}|${option.materialId || ""}`;
      const keeper = seenOptions.get(key);
      if (!keeper) seenOptions.set(key, option);
      else {
        await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: option.id }, data: { mediaOptionId: keeper.id } });
        await db.recipeMediaOption.deleteMany({ where: { shop, id: option.id } });
        removedOptions += 1;
      }
    }

    const zones = await db.recipeLabelZone.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenZones = new Map<string, any>();
    let removedZones = 0;
    for (const zone of zones as any[]) {
      const key = [String(zone.name || "").trim().toLowerCase(), String(zone.position || ""), Number(zone.widthIn || 0).toFixed(4), Number(zone.heightIn || 0).toFixed(4), Number(zone.qtyPerUnit || 0).toFixed(4), String(zone.mediaMode || "fixed"), String(zone.materialId || ""), String(zone.mediaOptionId || ""), String(zone.sameAsZoneId || "")].join("|");
      const keeper = seenZones.get(key);
      if (!keeper) seenZones.set(key, zone);
      else {
        await db.recipeLabelZone.updateMany({ where: { shop, sameAsZoneId: zone.id }, data: { sameAsZoneId: keeper.id } });
        await db.recipeLabelZone.deleteMany({ where: { shop, id: zone.id } });
        removedZones += 1;
      }
    }

    const rows = await db.recipeMaterial.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenRows = new Set<string>();
    const duplicateRowIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.materialId}|${row.usageType}|${row.unit}`;
      if (seenRows.has(key)) duplicateRowIds.push(row.id);
      else seenRows.add(key);
    }
    if (duplicateRowIds.length) await db.recipeMaterial.deleteMany({ where: { shop, id: { in: duplicateRowIds } } });

    return Response.json({ ok: true, message: `Cleanup complete: ${removedOptions} media option(s), ${removedZones} zone(s), ${duplicateRowIds.length} material row(s).` });
  }

  if (intent === "addBasicTier") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({ where: { shop, id: recipeId }, select: { id: true } });
    if (!recipe) {
      return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });
    }

    const minQty = intValue(formData.get("minQty"), 0);
    if (minQty < 1) {
      return Response.json({ ok: false, message: "Tier needs a minimum quantity of at least 1." }, { status: 400 });
    }

    const maxQtyRaw = intValue(formData.get("maxQty"), 0);
    const maxQty = maxQtyRaw >= minQty && maxQtyRaw > 0 ? maxQtyRaw : null;
    const fixedPrice = positiveOrNull(formData.get("fixedPrice"));
    const marginRaw = String(formData.get("marginPct") ?? "").trim();
    const marginParsed = Number(marginRaw);
    const marginPct = marginRaw && Number.isFinite(marginParsed) ? Math.min(Math.max(marginParsed, 0), 95) : null;

    if (fixedPrice == null && marginPct == null) {
      return Response.json({ ok: false, message: "Tier needs a fixed price or a margin percent." }, { status: 400 });
    }

    await db.recipeTier.create({ data: { shop, recipeId, minQty, maxQty, marginPct, fixedPrice } });
    return Response.json({ ok: true, message: "Tier added." });
  }

  if (intent === "deleteTier") {
    const recipeId = String(formData.get("recipeId") || "");
    const tierId = String(formData.get("tierId") || "");
    const deleted = await db.recipeTier.deleteMany({ where: { shop, id: tierId, recipeId } });
    return Response.json(
      deleted.count === 1
        ? { ok: true, message: "Tier deleted." }
        : { ok: false, message: "Tier not found." },
    );
  }

  if (intent === "syncTiersFromTemplate") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { productTypeProfile: true } });
    const tiers = parseTiers(recipe?.productTypeProfile?.tierTemplate);
    if (!recipe || !tiers.length) return Response.json({ ok: false, message: "Recipe has no template tiers to sync." }, { status: 400 });
    await db.recipeTier.deleteMany({ where: { shop, recipeId } });
    await db.recipeTier.createMany({ data: tiers.map((tier: any) => ({ shop, recipeId, minQty: Number(tier.minQty || 1), maxQty: tier.maxQty ? Number(tier.maxQty) : null, marginPct: tier.marginPct == null ? null : Number(tier.marginPct), fixedPrice: tier.fixedPrice == null ? null : Number(tier.fixedPrice) })) });
    return Response.json({ ok: true, message: "Recipe tiers synced from pricing template." });
  }

  if (intent === "saveCustomTiers") {
    const recipeId = String(formData.get("recipeId") || "");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("targetMarginPct"), 50));
    await db.recipeTier.deleteMany({ where: { shop, recipeId } });
    if (tiers.length) {
      await db.recipeTier.createMany({ data: tiers.map((tier: any) => ({ shop, recipeId, minQty: tier.minQty, maxQty: tier.maxQty, marginPct: tier.marginPct, fixedPrice: tier.fixedPrice })) });
    }
    await db.productRecipe.updateMany({ where: { shop, id: recipeId }, data: { pricingTemplateMode: "custom" } });
    return Response.json({ ok: true, message: "Custom recipe tiers saved." });
  }

  return Response.json({ ok: false, message: "Unknown product setup action." }, { status: 400 });
}

function NativeInput({ label, name, defaultValue = "", type = "text", step, placeholder }: any) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} step={step} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
    </label>
  );
}

function NativeSelect({ label, name, defaultValue, children }: any) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue ?? ""}>{children}</select>
    </label>
  );
}

function NativeTextarea({ label, name, defaultValue = "", rows = 3, placeholder }: any) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea name={name} rows={rows} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
    </label>
  );
}

function PageStyles() {
  return <style>{`
    .erp-page { max-width: 1480px; margin: 0 auto; padding: 24px; font-family: Arial, sans-serif; color: #202223; }
    .hero { background: linear-gradient(135deg, #111827, #3b0764); color: white; padding: 22px; border-radius: 18px; margin-bottom: 18px; }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .hero p { margin: 0; opacity: .9; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .card { background: white; border: 1px solid #d9d9d9; border-radius: 16px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); margin-bottom: 16px; }
    .card h2, .card h3 { margin: 0 0 12px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 700; }
    .field span { color: #3f3f46; }
    .field input, .field select, .field textarea { border: 1px solid #babfc3; border-radius: 9px; padding: 9px; font: inherit; font-weight: 400; background: white; min-height: 38px; }
    .checkbox-field { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; font-weight: 700; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; background: #f9fafb; }
    .checkbox-field input { margin-top: 2px; }
    .checkbox-field span { display: block; color: #111827; }
    .wide { grid-column: 1 / -1; }
    .button-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
    button, .button { border: 0; background: #111827; color: white; padding: 9px 12px; border-radius: 10px; cursor: pointer; font-weight: 700; text-decoration: none; display: inline-block; }
    .secondary { background: #e5e7eb; color: #111827; }
    .danger { background: #b91c1c; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 700; margin-right: 6px; margin-bottom: 6px; }
    .badge.green { background:#dcfce7; color:#166534; } .badge.red { background:#fee2e2; color:#991b1b; } .badge.yellow { background:#fef9c3; color:#854d0e; }
    .muted { color: #6b7280; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { color:#374151; background:#f9fafb; }
    details { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px; margin-top: 10px; }
    summary { cursor: pointer; font-weight: 800; }
    .draft-handoff-panel { margin: 12px 0; padding: 14px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 12px; }
    .draft-handoff-panel h3 { margin: 0 0 8px; color: #1e3a8a; }
    .draft-handoff-panel p { margin: 7px 0; }
    .draft-handoff-panel ol { margin: 10px 0 0 20px; padding: 0; color: #1e3a8a; font-weight: 600; }
    .draft-handoff-panel li { margin: 5px 0; }
    .cost-review-panel { margin: 12px 0; padding: 12px; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 10px; }
    .cost-review-panel strong { color: #92400e; }
    .cost-review-panel ul { margin: 8px 0 0 18px; padding: 0; color: #92400e; font-weight: 600; }
    .cost-review-panel li { margin: 4px 0; }
  `}</style>;
}

export default function ProductSetupRecipeBuilder() {
  const {
    templates = [],
    activeTemplates = [],
    recipes = [],
    selectedRecipe = null,
    selectedRecipeReadiness = null,
    machines = [],
    materialsAvailable = [],
    selectedRecipeId = "",
    recipeStatus = "active",
    recipeSearch = "",
    vendorCostRows = [],
    dtpPricingRules = null,
    recipeCount = 0,
    recipePage = 1,
    recipeLimit = 15,
    recipeTotalPages = 1,
    hasPrevRecipes = false,
    hasNextRecipes = false,
    memorySafeMode = true,
  } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const recipeBaseQuery = `recipeStatus=${encodeURIComponent(recipeStatus)}&recipeSearch=${encodeURIComponent(recipeSearch)}&recipeLimit=${encodeURIComponent(String(recipeLimit))}`;
  const selectedRecipeQuoteReady = Boolean(selectedRecipe?.active && selectedRecipe?.useInQuotes && !selectedRecipe?.costReviewNeeded);
  const canEnableQuoteUse = Boolean(selectedRecipe?.active && !selectedRecipe?.costReviewNeeded);
  const testedReadiness =
    actionData?.intent === "testRecipePrice" && actionData?.recipeId === selectedRecipe?.id ? actionData.readiness : null;
  const readiness = testedReadiness || selectedRecipeReadiness;
  const printMaterials = materialsAvailable.filter((material: any) => materialKind(material) === "print");
  const blankItems = materialsAvailable.filter((material: any) => materialKind(material) === "blank");

  function recipeHref(recipeId: string) {
    return `?${recipeBaseQuery}&recipePage=${recipePage}&recipeId=${encodeURIComponent(recipeId)}`;
  }

  return (
    <div className="erp-page">
      <PageStyles />
      <div className="hero">
        <h1>Product Setup / Recipe Builder</h1>
        <p>512MB-safe recipe control center. Recipes load as a light list first; full details load only after selecting one recipe.</p>
      </div>

      {/* 15B: Product Setup is the single Add/Edit Product home. Grouped
          sections (jump links) — full forms are reused, never duplicated. */}
      <div className="card">
        <h2>Product home</h2>
        <p className="muted">One place for every product: create or pick a recipe below, review applied vendor costs, and jump to the section you need.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="badge" href="#basics">1. Basics</a>
          <a className="badge" href="#vendor-cost">2. Vendor Cost</a>
          <a className="badge" href="#calculator-rules">3. Calculator Rules</a>
          <a className="badge" href="#features">4. Features</a>
          <a className="badge" href="#shopify">5. Shopify</a>
          <a className="badge" href="#production-recipe">6. Production Recipe</a>
          <a className="badge green" href="/app/erp/products/new">+ New Product (guided wizard)</a>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          The guided wizard collects the basics and returns here with a draft recipe selected. Vendor costs are edited in the
          {" "}<a href="/app/erp/vendor-cost-book">Vendor Cost Book</a> (intake/review) and applied to the Vendor Products shown in section 2 — there is no second cost store.
        </p>
      </div>

      <div className="card" id="vendor-cost">
        <h2>2. Vendor Cost — applied records (calculator source of truth)</h2>
        <p className="muted">
          Read-only view of VendorProduct records the Cost Calculator prices from. Status derives from live data
          (cost + Vendor Cost Book review) — Draft / Unverified / Verified plus Active / Inactive. Edit or verify costs in the
          {" "}<a href="/app/erp/vendor-cost-book">Vendor Cost Book</a>.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr><th align="left">Product</th><th align="left">Vendor</th><th align="left">Class</th><th>Unit cost</th><th>Tiers</th><th>Features</th><th align="left">Status</th></tr></thead>
            <tbody>
              {(vendorCostRows as any[]).map((row: any) => (
                <tr key={row.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{row.name}</td>
                  <td>{row.vendor}</td>
                  <td>{row.klass}</td>
                  <td align="center">{row.unitCost > 0 ? `$${row.unitCost.toFixed(4)}` : row.tierCount > 0 ? "tiered" : "—"}</td>
                  <td align="center">{row.tierCount}</td>
                  <td align="center">{row.addOnCount}</td>
                  <td>
                    <span className={`badge ${row.verification === "Verified" ? "green" : row.verification === "Unverified" ? "yellow" : ""}`}>{row.verification}</span>
                    <span className={`badge ${row.lifecycle === "Active" ? "" : "red"}`}>{row.lifecycle}</span>
                    <span className="muted" style={{ fontSize: 11 }}> {row.basis}</span>
                  </td>
                </tr>
              ))}
              {!(vendorCostRows as any[]).length ? <tr><td colSpan={7} className="muted" style={{ padding: 8 }}>No vendor product records yet — add them via the Vendor Cost Book.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>

      {(dtpPricingRules as any) ? (
        <div className="card" id="dtp-pricing-rules">
          <h2>DTP pricing rules — owner selling-price ladders (15C.2)</h2>
          <p className="muted">
            Customer selling prices per unit (NOT vendor costs — Spektra tiers stay in the Vendor Cost Book).
            Source: {(dtpPricingRules as any).source}. Read-only here for now — centralized in app/lib/dtp-owner-pricing.server.ts;
            the documented next step for no-code editing is moving this table into ErpAdminSetting or a dedicated model.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th align="left">Size (sku)</th>{(dtpPricingRules as any).quantities.map((qty: number) => <th key={qty}>{qty.toLocaleString()}</th>)}</tr></thead>
              <tbody>
                {(dtpPricingRules as any).ladders.map((row: any) => (
                  <tr key={row.sku} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td>{row.sku}</td>
                    {row.prices.map((price: number | null, index: number) => <td key={index} align="center">{price != null ? `$${price.toFixed(2)}` : "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Hard margin floors: {(dtpPricingRules as any).floors.map((band: any) => `${band.minQty.toLocaleString()}${band.maxQty ? `–${band.maxQty.toLocaleString()}` : "+"} → ${band.floorPct}%`).join(" · ")}.
            {" "}Minimum job profit ${(dtpPricingRules as any).minJobProfit} (strategic owner exception floor ${(dtpPricingRules as any).strategicMinJobProfit}).
            {" "}Additional-design customer fees: {(dtpPricingRules as any).fees.map((band: any) => `${band.minQty.toLocaleString()}${band.maxQty ? `–${band.maxQty.toLocaleString()}` : "+"} → $${band.feePerDesign}`).join(" · ")} (first design included; internal art cost ${(dtpPricingRules as any).artCostPerDesign.toFixed(4)}/design for EVERY design).
            {" "}40% stays the visible warning target. Freight $85/PO embedded in prices by default.
          </p>
        </div>
      ) : null}

      <div className="card" id="calculator-rules">
        <h2>3. Calculator Rules — shared family registry</h2>
        <p className="muted">
          Families come from ONE registry (app/lib/product-family-registry.ts) consumed by this page and the Cost Calculator.
          Owner labor/machine standards live in app/lib/owner-standards.ts (bag label $0.078125, jar label $0.20, art $8.3333 + print $1.00 per design,
          weeding $1.3333/page, packing $2.00/box, machine $8/hour provisional). Legacy conflicting rates are quarantined and cannot override these.
          DTP (Custom Printed Pouches / DTP Bags — ENABLED 15C): vendor-finished Spektra pouches — MOQ 1,000; researched dtp-pouches margin curve (65/58/52/46/42, min 42); GSO art/design charge only (no in-house print setup); $85 flat freight per Spektra PO; included features come from each record's Vendor Cost Book add-ons. Add another DTP size by creating a Spektra VendorProduct + tiers + add-ons in the Vendor Cost Book — no calculator code changes needed.
        </p>
      </div>

      {actionData?.message ? <div className="card"><span className={actionData.ok ? "badge green" : "badge red"}>{actionData.message}</span></div> : null}

      <div className="card">
        <h2>Memory-safe mode is active</h2>
        <p className="muted">
          This page is optimized for the current 512MB Render server. It avoids loading every recipe, material, media option, rule, and tier at once.
        </p>
        <span className="badge green">512MB safe</span>
        <span className="badge">{recipeCount} recipe(s)</span>
        <span className="badge">{recipeLimit} per page max</span>
        <span className="badge yellow">Shopify updates still locked</span>
      </div>

      <div className="card" id="basics">
        <h2>1. Basics — Create Product Recipe</h2>
        <p className="muted">Use this for new recipe shells. Open a recipe later to attach materials, zones, tiers, and rules.</p>
        <Form method="post" className="form-grid">
          <input type="hidden" name="intent" value="createRecipe" />
          <NativeInput label="Recipe / product name" name="name" placeholder="4x5 Sticker Bag" />
          <NativeInput label="SKU / internal code" name="sku" placeholder="STICKER-BAG-4X5" />
          <NativeSelect label="Product family" name="productFamily" defaultValue="Sticker Bags">
            {PRODUCT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
          </NativeSelect>
          <NativeSelect label="Pricing template" name="productTypeProfileId">
            <option value="">No template yet</option>
            {(activeTemplates || templates).map((template: any) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </NativeSelect>
          <NativeInput label="Target margin %" name="targetMarginPct" type="number" step="0.01" defaultValue="60" />
          <NativeInput label="Default sell price" name="defaultSellPrice" type="number" step="0.01" placeholder="1.90" />
          <div className="wide button-row"><button type="submit">Create recipe</button></div>
        </Form>
      </div>

      <div className="card">
        <h2>Product Recipes</h2>
        <p className="muted">Open one recipe at a time. Cost review flags from Margin Review will show here with reason details.</p>
        <Form method="get" className="form-grid">
          <NativeSelect label="Recipe status" name="recipeStatus" defaultValue={recipeStatus}>
            <option value="active">Active recipes</option>
            <option value="archived">Archived recipes</option>
            <option value="all">All recipes</option>
          </NativeSelect>
          <NativeInput label="Search recipes" name="recipeSearch" defaultValue={recipeSearch} placeholder="name, SKU, family" />
          <NativeSelect label="Recipes per page" name="recipeLimit" defaultValue={String(recipeLimit)}>
            <option value="10">10</option>
            <option value="15">15</option>
            <option value="25">25 max</option>
          </NativeSelect>
          <input type="hidden" name="recipePage" value="1" />
          <div className="field"><span>&nbsp;</span><button type="submit">Search recipes</button></div>
        </Form>
        <div className="button-row">
          <span className="badge">Showing {recipes.length} of {recipeCount}</span>
          <span className="badge">Page {recipePage} of {recipeTotalPages}</span>
          {hasPrevRecipes ? <Link className="button secondary" to={`?${recipeBaseQuery}&recipePage=${recipePage - 1}`}>Previous recipes</Link> : null}
          {hasNextRecipes ? <Link className="button secondary" to={`?${recipeBaseQuery}&recipePage=${recipePage + 1}`}>Next recipes</Link> : null}
        </div>

        {recipes.length ? <table>
          <thead>
            <tr>
              <th>Recipe</th>
              <th>Family</th>
              <th>Template</th>
              <th>Margin</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((recipe: any) => {
              const reasons = costReviewReasonList(recipe);
              return <tr key={recipe.id}>
                <td><strong>{recipe.name}</strong><br/><span className="muted">{recipe.sku || "No SKU"}</span></td>
                <td>{recipe.productFamily || recipe.productType}</td>
                <td>{recipe.productTypeProfile?.name || "No template"}</td>
                <td>{pct(recipe.targetMarginPct)}</td>
                <td>
                  {recipe.active ? <span className="badge green">Active</span> : <span className="badge red">Archived</span>}
                  {recipe.costReviewNeeded ? <span className="badge yellow">Cost Review</span> : <span className="badge green">Cost OK</span>}
                  {reasons.length ? <div className="muted">{reasons[0]}</div> : null}
                </td>
                <td><Link className="button" to={recipeHref(recipe.id)} preventScrollReset>Open</Link></td>
              </tr>;
            })}
          </tbody>
        </table> : <p>No recipes found.</p>}
      </div>

      {selectedRecipe ? <div className="card" id="production-recipe">
        <span id="features" /><span id="shopify" />
        <h2>{selectedRecipe.name}</h2>
        <p className="muted">Sections 4 (Features: recipe add-ons + vendor product add-ons above), 5 (Shopify: GID link fields below), and 6 (Production Recipe) all edit THIS selected recipe — the existing forms are reused, not duplicated.</p>
        <p className="muted">Full recipe details are loaded only for this one selected recipe to protect server memory.</p>
        {selectedRecipeQuoteReady ? <span className="badge green">Quote-ready</span> : <span className="badge yellow">Not quote-ready</span>}

        {readiness ? <div className="card">
          <h3>Recipe readiness</h3>
          <div className="button-row">
            <span className={readiness.gate.active ? "badge green" : "badge red"}>Active: {readiness.gate.active ? "yes" : "no"}</span>
            <span className={readiness.gate.useInQuotes ? "badge green" : "badge yellow"}>Use in Quotes / CRM: {readiness.gate.useInQuotes ? "yes" : "no"}</span>
            <span className={readiness.gate.costReviewNeeded ? "badge yellow" : "badge green"}>Cost review needed: {readiness.gate.costReviewNeeded ? "yes" : "no"}</span>
          </div>
          <p>
            Pricing test at quantity {readiness.testQuantity}
            {readiness.pricing.belowMinimum ? ` (below recipe minimum of ${readiness.minQuantity})` : ""}:
            {" "}unit cost {money(readiness.pricing.unitCost)} | unit price {money(readiness.pricing.unitPrice)} | margin {pct(readiness.pricing.marginActual)} | tier {readiness.pricing.tierLabel}
          </p>
          <Form method="post" className="button-row">
            <input type="hidden" name="intent" value="testRecipePrice" />
            <input type="hidden" name="recipeId" value={selectedRecipe.id} />
            <label className="muted">
              Test quantity{" "}
              <input name="testQuantity" type="number" min={1} step={1} defaultValue={readiness.testQuantity} style={{ width: 100 }} />
            </label>
            <button type="submit">Test price</button>
          </Form>
          {readiness.recipeBlockers.length ? <div>
            <strong>Blocking issues</strong>
            <ul>
              {readiness.recipeBlockers.map((issue: string) => <li key={issue}>{issue}</li>)}
            </ul>
          </div> : null}
          {readiness.pricing.warnings.length ? <div>
            <span className="badge yellow">Cautions (not blocking)</span>
            <ul>
              {readiness.pricing.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}
            </ul>
          </div> : null}
          {readiness.dataReady && readiness.gate.active && readiness.gate.useInQuotes && !readiness.gate.costReviewNeeded
            ? <span className="badge green">Ready for Quotes and Agent Review Queue conversion</span>
            : readiness.dataReady
              ? <span className="badge yellow">Cost inputs are ready. Activate the recipe, clear cost review, and enable Use in Quotes / CRM to finish.</span>
              : <span className="badge red">Not ready — Agent Review Queue conversion will fail. Fix the items above.</span>}
          {readiness.gate.useInQuotes && !readiness.dataReady ? <div className="cost-review-panel">
            <strong>Warning:</strong> This recipe is enabled for quotes, but Agent Review Queue conversion will fail: {readiness.recipeBlockers.join("; ")}.
          </div> : null}
        </div> : null}

        <div className="card">
          <h3>Fix readiness blockers</h3>
          <p className="muted">
            Staff-only fix tools for this recipe. Saves here update only the posted fields; pricing math and quote safety gates are unchanged.
          </p>

          <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="updateRecipe" />
            <input type="hidden" name="recipeId" value={selectedRecipe.id} />
            <NativeInput label="Width (in)" name="widthIn" type="number" step="0.01" defaultValue={selectedRecipe.widthIn || ""} />
            <NativeInput label="Height (in)" name="heightIn" type="number" step="0.01" defaultValue={selectedRecipe.heightIn || ""} />
            <NativeInput label="Minimum quantity" name="minQuantity" type="number" step="1" defaultValue={selectedRecipe.minQuantity || 1} />
            <NativeSelect label="Preferred machine" name="machineId" defaultValue={selectedRecipe.machineRules?.[0]?.preferredMachineId || ""}>
              <option value="">No machine selected</option>
              {machines.map((machine: any) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
            </NativeSelect>
            <div className="wide button-row"><button type="submit">Save dimensions / MOQ / machine</button></div>
          </Form>
          {machines.length === 0 ? <p className="muted">No active machines exist yet. Create them in Machines first.</p> : null}

          <h3>Recipe materials</h3>
          {(selectedRecipe.materials || []).length ? <table>
            <thead><tr><th>Material</th><th>Usage</th><th>Qty</th><th>Unit</th><th>Waste %</th><th></th></tr></thead>
            <tbody>
              {(selectedRecipe.materials || []).map((row: any) => <tr key={row.id}>
                <td>
                  {row.material?.name || "Material"}{" "}
                  <span className="badge">{materialKindLabel(row.material)}</span>
                </td>
                <td>{row.usageType}</td>
                <td>{row.quantity}</td>
                <td>{row.unit}</td>
                <td>{row.wastePct}</td>
                <td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="removeMaterial" />
                    <input type="hidden" name="recipeMaterialId" value={row.id} />
                    <button type="submit">Remove</button>
                  </Form>
                </td>
              </tr>)}
            </tbody>
          </table> : <p className="muted">No materials attached. In-house recipes need at least one material to price.</p>}

          <h4>Attach printed material</h4>
          {printMaterials.length ? <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="addMaterial" />
            <input type="hidden" name="recipeId" value={selectedRecipe.id} />
            <NativeSelect label="Printed material / substrate" name="materialId" defaultValue={printMaterials[0]?.id || ""}>
              {printMaterials.map((material: any) => (
                <option key={material.id} value={material.id}>
                  {material.name} ({money(material.calculatedUnitCost || material.costPerUnit)}/{material.baseUnit || material.unit || "each"})
                </option>
              ))}
            </NativeSelect>
            <NativeSelect label="Usage type" name="usageType" defaultValue="media">
              {["media", "laminate", "other"].map((usage) => <option key={usage} value={usage}>{usage}</option>)}
            </NativeSelect>
            <NativeInput label="Quantity multiplier" name="quantity" type="number" step="0.01" defaultValue={1} />
            <NativeSelect label="Unit" name="unit" defaultValue="sqft">
              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </NativeSelect>
            <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue={10} />
            <div className="wide button-row"><button type="submit">Attach printed material</button></div>
          </Form> : <p className="muted">No print materials found. Create roll media / vinyl in Materials first.</p>}

          <h4>Apply to blank item (optional)</h4>
          {blankItems.length ? <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="addMaterial" />
            <input type="hidden" name="recipeId" value={selectedRecipe.id} />
            <input type="hidden" name="usageType" value="blank" />
            <input type="hidden" name="unit" value="each" />
            <NativeSelect label="Blank item / application target" name="materialId" defaultValue={blankItems[0]?.id || ""}>
              {blankItems.map((material: any) => (
                <option key={material.id} value={material.id}>
                  {material.name} ({money(material.calculatedUnitCost || material.costPerUnit)}/{material.baseUnit || material.unit || "each"})
                </option>
              ))}
            </NativeSelect>
            <NativeInput label="Quantity per unit" name="quantity" type="number" step="0.01" defaultValue={1} />
            <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue={0} />
            <div className="wide button-row"><button type="submit">Apply blank item</button></div>
          </Form> : <p className="muted">No blank items found. Create jars / bags / boxes in Materials first.</p>}

          <h3>Recipe tiers</h3>
          {(selectedRecipe.tiers || []).length ? <table>
            <thead><tr><th>Min qty</th><th>Max qty</th><th>Margin %</th><th>Fixed price</th><th></th></tr></thead>
            <tbody>
              {(selectedRecipe.tiers || []).map((tier: any) => <tr key={tier.id}>
                <td>{tier.minQty}</td>
                <td>{tier.maxQty ?? "+"}</td>
                <td>{tier.marginPct ?? "-"}</td>
                <td>{tier.fixedPrice != null ? money(tier.fixedPrice) : "-"}</td>
                <td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="deleteTier" />
                    <input type="hidden" name="recipeId" value={selectedRecipe.id} />
                    <input type="hidden" name="tierId" value={tier.id} />
                    <button type="submit">Delete</button>
                  </Form>
                </td>
              </tr>)}
            </tbody>
          </table> : <p className="muted">No tiers yet. Tiers are optional; margin pricing works without them.</p>}

          <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="addBasicTier" />
            <input type="hidden" name="recipeId" value={selectedRecipe.id} />
            <NativeInput label="Min qty" name="minQty" type="number" step="1" placeholder="128" />
            <NativeInput label="Max qty (optional)" name="maxQty" type="number" step="1" />
            <NativeInput label="Fixed price (optional)" name="fixedPrice" type="number" step="0.01" placeholder="1.90" />
            <NativeInput label="Margin % (optional)" name="marginPct" type="number" step="0.1" placeholder="60" />
            <div className="wide button-row"><button type="submit">Add tier</button></div>
          </Form>
        </div>
        {!selectedRecipe.active || selectedRecipe.costReviewNeeded ? <div className="draft-handoff-panel">
          <h3>ERP Draft Handoff</h3>
          <div className="button-row">
            <span className="badge">Draft</span>
            {!selectedRecipe.active ? <span className="badge red">Inactive</span> : null}
            <span className="badge red">Not live</span>
            <span className="badge yellow">Not quote-ready</span>
            <span className="badge yellow">Not agent-ready</span>
            {selectedRecipe.costReviewNeeded ? <span className="badge yellow">Cost Review Needed</span> : null}
          </div>
          <p>
            This is an internal ERP draft. It is not live, has not created a Shopify product, has not created storefront configurator pricing,
            and is not ready for customer quoting or future sales agents.
          </p>
          <p className="muted">
            Review cost, pricing, production setup, and Shopify mapping before activating this recipe or allowing sales/agent use.
          </p>
          <ol>
            <li>Review product name, SKU, family, and internal product type key.</li>
            <li>Add or confirm material/vendor costs.</li>
            <li>Add label zones if this product uses labels.</li>
            <li>Review quantity tiers and MOQ.</li>
            <li>Add machine/production route if needed.</li>
            <li>Add Shopify mapping only when this product is ready to sell online.</li>
            <li>Run Pricing Health / margin review.</li>
            <li>Confirm quote rules before sales or agent use.</li>
            <li>Activate only after review is complete.</li>
          </ol>
          <div className="button-row">
            <Link className="button secondary" to="/app/erp/pricing-health">Pricing Health</Link>
            <Link className="button secondary" to="/app/erp/margin-review">Margin Review</Link>
            <Link className="button secondary" to="/app/erp/shopify-links">Shopify Links</Link>
          </div>
        </div> : null}
        {selectedRecipe.costReviewNeeded ? <div className="cost-review-panel">
          <strong>Cost Review Needed</strong>
          <p className="muted">Fix these recipe setup issues before approving price changes or updating Shopify.</p>
          {costReviewReasonList(selectedRecipe).length ? <ul>
            {costReviewReasonList(selectedRecipe).map((reason: string, index: number) => <li key={`${reason}-${index}`}>{reason}</li>)}
          </ul> : <p className="muted">Margin Review flagged this recipe, but no reason text was saved yet. Re-run Margin Review and sync recipe review flags.</p>}
          {selectedRecipe.costReviewSyncedAt ? <p className="muted">Last synced from Margin Review: {shortDateTime(selectedRecipe.costReviewSyncedAt)}</p> : null}
        </div> : <div className="card"><span className="badge green">No cost review flag</span></div>}

        <div className="grid">
          <div className="card">
            <h3>Recipe Details</h3>
            <Form method="post" className="form-grid">
              <input type="hidden" name="intent" value="updateRecipe" />
              <input type="hidden" name="recipeId" value={selectedRecipe.id} />
              <input type="hidden" name="manageQuoteFlag" value="1" />
              <NativeInput label="Recipe / product name" name="name" defaultValue={selectedRecipe.name} />
              <NativeInput label="SKU" name="sku" defaultValue={selectedRecipe.sku || ""} />
              <NativeSelect label="Product family" name="productFamily" defaultValue={selectedRecipe.productFamily || "Sticker Bags"}>
                {PRODUCT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
              </NativeSelect>
              <NativeSelect label="Production mode" name="productionMode" defaultValue={selectedRecipe.productionMode || "in_house"}>
                {PRODUCTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </NativeSelect>
              <NativeInput label="Target margin %" name="targetMarginPct" type="number" step="0.01" defaultValue={selectedRecipe.targetMarginPct} />
              <NativeInput label="Default sell price" name="defaultSellPrice" type="number" step="0.01" defaultValue={selectedRecipe.defaultSellPrice || ""} />
              <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue={selectedRecipe.wastePct || 0} />
              <NativeInput label="Setup cost" name="setupCost" type="number" step="0.01" defaultValue={selectedRecipe.setupCost || 0} />
              <NativeInput label="Packing labor seconds/unit" name="packingLaborSecondsPerUnit" type="number" step="0.01" defaultValue={selectedRecipe.packingLaborSecondsPerUnit || 0} />
              <NativeTextarea label="Notes" name="notes" defaultValue={selectedRecipe.notes || ""} />
              {(!canEnableQuoteUse && selectedRecipe.useInQuotes) ? <input type="hidden" name="useInQuotes" value="on" /> : null}
              <label className="checkbox-field wide">
                <input type="checkbox" name="useInQuotes" defaultChecked={Boolean(selectedRecipe.useInQuotes)} disabled={!canEnableQuoteUse} />
                <span>
                  Use in Quotes / CRM
                  <small className="muted">
                    Only enable after cost review is clear, MOQ/tiers are reviewed, margin is approved, and this recipe should appear in Quotes / CRM.
                  </small>
                </span>
              </label>
              {!canEnableQuoteUse ? <p className="muted wide">Quote use is locked until this recipe is active and cost review is clear.</p> : null}
              <div className="wide button-row"><button type="submit">Save recipe</button></div>
            </Form>
          </div>

          <div className="card">
            <h3>Loaded detail counts</h3>
            <p><span className="badge">Materials: {(selectedRecipe.materials || []).length}</span></p>
            <p><span className="badge">Label zones: {(selectedRecipe.labelZones || []).length}</span></p>
            <p><span className="badge">Media options: {(selectedRecipe.mediaOptions || []).length}</span></p>
            <p><span className="badge">Variant rules: {(selectedRecipe.variantRules || []).length}</span></p>
            <p><span className="badge">Tiers: {(selectedRecipe.tiers || []).length}</span></p>
            <p className="muted">Deep editing for zones/material rows will be restored in a separate optimized editor if needed. This page is now protected from all-at-once memory crashes.</p>
          </div>

          <div className="card">
            <h3>Sales rules / MOQ source of truth</h3>
            <p className="muted">Staff and future agent-safe workflows should follow these rules before quoting or marking a recipe Use in Quotes / CRM.</p>
            <ul>
              {salesRulesForFamily(selectedRecipe.productFamily || selectedRecipe.productType).map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
          </div>
        </div>

        <details open>
          <summary>Recipe material/media summary</summary>
          <div className="grid">
            <div>
              <h3>Recipe materials</h3>
              {(selectedRecipe.materials || []).length ? <table><tbody>{selectedRecipe.materials.map((row: any) => <tr key={row.id}><td>{row.material?.name || row.name || "Material"}</td><td>{row.quantityPerUnit || row.qtyPerUnit || 0} {row.unit || row.material?.unit || "unit"}</td><td>{row.active === false ? "Hidden" : "Active"}</td></tr>)}</tbody></table> : <p className="muted">No fixed materials loaded.</p>}
            </div>
            <div>
              <h3>Label/application zones</h3>
              {(selectedRecipe.labelZones || []).length ? <table><tbody>{selectedRecipe.labelZones.map((zone: any) => <tr key={zone.id}><td>{zone.name}</td><td>{zone.widthIn || 0} × {zone.heightIn || 0}</td><td>{zone.mediaOption?.name || zone.material?.name || "No media"}</td></tr>)}</tbody></table> : <p className="muted">No zones loaded.</p>}
            </div>
          </div>
        </details>
      </div> : selectedRecipeId ? <div className="card"><span className="badge red">Selected recipe was not found.</span></div> : null}
    </div>
  );
}
