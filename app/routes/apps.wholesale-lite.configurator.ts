import type { LoaderFunctionArgs } from "react-router";
import { db } from "../db.server";
import { authenticate } from "../shopify.server";
import { MIN_QTY } from "../lib/configurator-pricing";
import { stripInternalCostFields } from "../lib/security-guards-shared";

// 15G.1: served only through the signed Shopify app proxy (same-origin from
// the storefront) — no cross-origin callers exist, so no CORS headers.
function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(stripInternalCostFields(data)), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function clean(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function numberValue(value: string | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isJarProductType(productType: string): boolean {
  return productType.startsWith("jar_");
}

function normalizeJarColor(value: string | null | undefined): "Clear" | "Black" | "White" {
  const color = clean(value).toLowerCase();
  if (color === "black") return "Black";
  if (color === "white") return "White";
  return "Clear";
}

function isColorVariantJarProductType(productType: string): boolean {
  return [
    "jar_3oz_clear",
    "jar_3oz_black_white",
    "jar_4oz_clear",
    "jar_4oz_black_white",
  ].includes(productType);
}

function resolveJarVariantProductType(productType: string, jarColor: "Clear" | "Black" | "White"): string {
  if (productType === "jar_3oz_clear" || productType === "jar_3oz_black_white") {
    return jarColor === "Clear" ? "jar_3oz_clear" : "jar_3oz_black_white";
  }

  if (productType === "jar_4oz_clear" || productType === "jar_4oz_black_white") {
    return jarColor === "Clear" ? "jar_4oz_clear" : "jar_4oz_black_white";
  }

  return productType;
}

function productFamilyForType(productType: string): "Jars" | "Stock Bags" {
  return isJarProductType(productType) ? "Jars" : "Stock Bags";
}

function money(value: any) {
  const num = Number(value ?? 0);
  return Math.round(num * 100) / 100;
}

function uniqueValues(items: string[]) {
  return Array.from(
    new Set(
      items
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
}

function optionGroupName(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function optionMatches(option: any, names: string[]) {
  const group = optionGroupName(option.group);
  return names.map(optionGroupName).includes(group);
}

function optionValue(options: string[], requested: string) {
  if (!requested) return "";
  return options.find((option) => option.toLowerCase() === requested.toLowerCase()) || "";
}

function findMatchingRule(rules: any[], material: string, finish: string, quantity: number) {
  return (
    rules.find((rule) => {
      const materialOk = String(rule.material || "").toLowerCase() === material.toLowerCase();
      const finishOk = String(rule.finish || "").toLowerCase() === finish.toLowerCase();
      const minOk = quantity >= Number(rule.minQty || 0);
      const maxOk = rule.maxQty == null || quantity <= Number(rule.maxQty);
      return materialOk && finishOk && minOk && maxOk && rule.active !== false;
    }) || null
  );
}

function rangeLabel(rule: any) {
  if (!rule) return "";
  return rule.maxQty == null ? `${rule.minQty}+` : `${rule.minQty}-${rule.maxQty}`;
}

function humanProductType(value: string) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function loader({ request }: LoaderFunctionArgs) {
  // 15G.1: require a valid Shopify app-proxy signature. The authorized shop
  // comes ONLY from the authenticated session — never from request input.
  // Invalid/missing signatures throw a 4xx inside authenticate (fail closed).
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonResponse(
      { ok: false, active: false, message: "App is not installed for this shop." },
      { status: 400 },
    );
  }
  const shop = session.shop;

  const url = new URL(request.url);

  const handle = clean(url.searchParams.get("handle"));
  const productGid = clean(url.searchParams.get("productGid"));
  const material = clean(url.searchParams.get("material"));
  const finish = clean(url.searchParams.get("finish"));
  const bagColor = clean(url.searchParams.get("bagColor"));
  const jarColor = normalizeJarColor(
    url.searchParams.get("jarColor") ||
      url.searchParams.get("jar_color") ||
      url.searchParams.get("color"),
  );
  const labelSet = clean(
    url.searchParams.get("labelSet") ||
      url.searchParams.get("label_set") ||
      url.searchParams.get("labelset"),
  );

  if (!handle && !productGid) {
    return jsonResponse({ ok: false, active: false, message: "Missing product identifier." });
  }

  const product = await db.configuratorProduct.findFirst({
    where: {
      shop,
      active: true,
      OR: [
        productGid ? { shopifyProductGid: productGid } : undefined,
        handle ? { shopifyHandle: handle } : undefined,
      ].filter(Boolean) as any,
    },
  });

  if (!product) {
    return jsonResponse({
      ok: true,
      active: false,
      message: "No ERP configurator product found for this Shopify product.",
    });
  }

  const baseProductType = product.productType || "stock_bag_4x5";
  const productType = resolveJarVariantProductType(baseProductType, jarColor);
  const isJar = isJarProductType(productType);
  const hasJarColorVariants = isColorVariantJarProductType(baseProductType);
  const productFamily = productFamilyForType(productType);
  const effectiveProductIdentity = [
    product.shopifyProductGid ? { shopifyProductGid: product.shopifyProductGid } : undefined,
    product.shopifyHandle ? { shopifyHandle: product.shopifyHandle } : undefined,
  ].filter(Boolean) as any;
  const effectiveProduct =
    productType !== baseProductType && effectiveProductIdentity.length
      ? (await db.configuratorProduct.findFirst({
          where: {
            shop,
            active: true,
            productType,
            OR: effectiveProductIdentity,
          },
        })) || product
      : product;
  const minQuantity = Number(effectiveProduct.minQuantity || MIN_QTY);
  const quantity = Math.max(numberValue(url.searchParams.get("quantity"), minQuantity), minQuantity);

  const [options, rules] = await Promise.all([
    db.configuratorOption.findMany({
      where: { shop, productType, active: true },
      orderBy: [{ group: "asc" }, { sortOrder: "asc" }],
    }),
    db.configuratorPricingRule.findMany({
      where: { shop, productType, active: true },
      orderBy: [{ material: "asc" }, { finish: "asc" }, { minQty: "asc" }],
    }),
  ]);

  const optionMaterials = uniqueValues(
    options
      .filter((option) => optionMatches(option, ["material", "materials"]))
      .map((option) => option.label || option.value),
  );

  const optionFinishes = uniqueValues(
    options
      .filter((option) => optionMatches(option, ["finish", "finishes", "spotGloss", "gloss"]))
      .map((option) => option.label || option.value),
  );

  const optionBagColors = uniqueValues(
    options
      .filter((option) => optionMatches(option, ["bagColor", "bag color", "color", "colors"]))
      .map((option) => option.label || option.value),
  );

  const optionLabelSets = uniqueValues(
    options
      .filter((option) => optionMatches(option, ["Label Set", "labelSet", "label set", "label_set"]))
      .map((option) => option.label || option.value),
  );

  const ruleMaterials = uniqueValues(rules.map((rule) => rule.material));
  const ruleFinishes = uniqueValues(rules.map((rule) => rule.finish));

  const defaultBagColors = [
    "White",
    "Blue",
    "Red",
    "Pink",
    "Orange",
    "Green",
    "Gold-Holo",
    "Silver-Holo",
    "Purple-Holo",
    "Teal",
    "Black",
    "Light Pink",
    "Light Purple",
    "Clear",
  ];

  const materials = optionMaterials.length ? optionMaterials : ruleMaterials;
  const finishes = optionFinishes.length ? optionFinishes : ruleFinishes;
  const bagColors = optionBagColors.length ? optionBagColors : defaultBagColors;
  const jarColors = hasJarColorVariants ? ["Clear", "Black", "White"] : [];
  const labelSets = optionLabelSets;

  const selectedMaterial = material || materials[0] || "Matte";
  const selectedFinish = finish || finishes[0] || "No Spot Gloss";
  const selectedBagColor = isJar ? "" : bagColor || bagColors[0] || "White";
  const selectedJarColor = hasJarColorVariants ? jarColor : "";
  const requestedLabelSet = optionValue(labelSets, labelSet) || (!labelSets.length ? labelSet : "");
  const selectedLabelSet = isJar ? requestedLabelSet || labelSets[0] || "Side + Lid" : "";
  const selectedSides = isJar ? "" : effectiveProduct.defaultSides || "Double Sided";

  const rule = findMatchingRule(rules, selectedMaterial, selectedFinish, quantity);

  const priceBreaks = rules
    .filter((priceRule) => {
      const materialOk = String(priceRule.material || "").toLowerCase() === selectedMaterial.toLowerCase();
      const finishOk = String(priceRule.finish || "").toLowerCase() === selectedFinish.toLowerCase();
      return materialOk && finishOk && priceRule.active !== false;
    })
    .sort((a, b) => Number(a.minQty || 0) - Number(b.minQty || 0))
    .map((priceRule) => ({
      range: rangeLabel(priceRule),
      minQty: Number(priceRule.minQty || 0),
      maxQty: priceRule.maxQty == null ? null : Number(priceRule.maxQty),
      priceEach: money(priceRule.priceEach),
    }));

  // 15G.1: the public payload carries customer-facing pricing ONLY. Internal
  // cost/profit/margin figures never leave the server on a storefront route.
  const priceEach = money(rule?.priceEach ?? 0);
  const orderTotal = money(priceEach * quantity);

  return jsonResponse({
    ok: true,
    active: true,
    productType,
    productTypeLabel: humanProductType(productType),
    productFamily,
    product: {
      id: effectiveProduct.id,
      title: effectiveProduct.title,
      productType,
      productFamily,
      shopifyProductGid: effectiveProduct.shopifyProductGid,
      shopifyVariantGid: effectiveProduct.shopifyVariantGid,
      handle: effectiveProduct.shopifyHandle,
      sku: effectiveProduct.sku,
      minQuantity,
      defaultSides: effectiveProduct.defaultSides || "Double Sided",
    },
    options: { materials, finishes, bagColors, jarColors, labelSets },
    selected: {
      material: selectedMaterial,
      finish: selectedFinish,
      bagColor: selectedBagColor,
      jarColor: selectedJarColor,
      labelSet: selectedLabelSet,
      quantity,
      sides: selectedSides,
    },
    pricing: {
      matched: Boolean(rule),
      matchedRange: rangeLabel(rule),
      productionFinish: rule?.productionFinish || selectedFinish,
      priceEach,
      orderTotal,
      priceBreaks,
    },
  });
}
