import { db } from "../db.server";
import { MIN_QTY } from "../lib/configurator-pricing";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
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

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(request.url);

  const shop = clean(url.searchParams.get("shop"));
  const handle = clean(url.searchParams.get("handle"));
  const productGid = clean(url.searchParams.get("productGid"));
  const material = clean(url.searchParams.get("material"));
  const finish = clean(url.searchParams.get("finish"));
  const bagColor = clean(url.searchParams.get("bagColor"));
  const labelSet = clean(
    url.searchParams.get("labelSet") ||
      url.searchParams.get("label_set") ||
      url.searchParams.get("labelset"),
  );

  if (!shop || (!handle && !productGid)) {
    return jsonResponse({ ok: false, active: false, message: "Missing shop or product identifier." });
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

  const productType = product.productType || "stock_bag_4x5";
  const isJar = isJarProductType(productType);
  const productFamily = productFamilyForType(productType);
  const minQuantity = Number(product.minQuantity || MIN_QTY);
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
  const labelSets = optionLabelSets;

  const selectedMaterial = material || materials[0] || "Matte";
  const selectedFinish = finish || finishes[0] || "No Spot Gloss";
  const selectedBagColor = isJar ? "" : bagColor || bagColors[0] || "White";
  const requestedLabelSet = optionValue(labelSets, labelSet) || (!labelSets.length ? labelSet : "");
  const selectedLabelSet = isJar ? requestedLabelSet || labelSets[0] || "Side + Lid" : "";
  const selectedSides = isJar ? "" : product.defaultSides || "Double Sided";

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

  const priceEach = money(rule?.priceEach ?? 0);
  const costEach = money(rule?.costEach ?? 0);
  const orderTotal = money(priceEach * quantity);
  const totalCost = money(costEach * quantity);
  const totalProfit = money(orderTotal - totalCost);
  const margin = orderTotal > 0 ? money((totalProfit / orderTotal) * 100) : 0;

  return jsonResponse({
    ok: true,
    active: true,
    productType,
    productTypeLabel: humanProductType(productType),
    productFamily,
    product: {
      id: product.id,
      title: product.title,
      productType,
      productFamily,
      shopifyProductGid: product.shopifyProductGid,
      shopifyVariantGid: product.shopifyVariantGid,
      handle: product.shopifyHandle,
      sku: product.sku,
      minQuantity,
      defaultSides: product.defaultSides || "Double Sided",
    },
    options: { materials, finishes, bagColors, labelSets },
    selected: {
      material: selectedMaterial,
      finish: selectedFinish,
      bagColor: selectedBagColor,
      labelSet: selectedLabelSet,
      quantity,
      sides: selectedSides,
    },
    pricing: {
      matched: Boolean(rule),
      matchedRange: rangeLabel(rule),
      productionFinish: rule?.productionFinish || selectedFinish,
      priceEach,
      costEach,
      orderTotal,
      totalCost,
      totalProfit,
      margin,
      priceBreaks,
    },
  });
}
