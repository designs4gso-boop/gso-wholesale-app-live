import { db } from "../db.server";
import { MIN_QTY } from "../lib/configurator-pricing";

const SHOPIFY_API_VERSION = "2025-10";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...(init.headers || {}),
    },
  });
}

function clean(value: any) {
  return String(value ?? "").trim();
}

function money(value: any) {
  const num = Number(value ?? 0);
  return Math.round(num * 100) / 100;
}

function numberValue(value: any, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isJarProductType(productType: string): boolean {
  return productType.startsWith("jar_");
}

function normalizeJarColor(value: any): "Clear" | "Black" | "White" | "" {
  const color = clean(value).toLowerCase();
  if (color === "clear") return "Clear";
  if (color === "black") return "Black";
  if (color === "white") return "White";
  return "";
}

function isColorVariantJarProductType(productType: string): boolean {
  return [
    "jar_3oz_clear",
    "jar_3oz_black_white",
    "jar_4oz_clear",
    "jar_4oz_black_white",
  ].includes(productType);
}

function resolveJarVariantProductType(productType: string, jarColor: "Clear" | "Black" | "White" | ""): string {
  if (productType === "jar_3oz_clear" || productType === "jar_3oz_black_white") {
    return jarColor === "Black" || jarColor === "White" ? "jar_3oz_black_white" : "jar_3oz_clear";
  }

  if (productType === "jar_4oz_clear" || productType === "jar_4oz_black_white") {
    return jarColor === "Black" || jarColor === "White" ? "jar_4oz_black_white" : "jar_4oz_clear";
  }

  return productType;
}

function productFamilyForType(productType: string): "Jars" | "Stock Bags" {
  return isJarProductType(productType) ? "Jars" : "Stock Bags";
}

function rangeLabel(rule: any) {
  if (!rule) return "";
  return rule.maxQty == null ? `${rule.minQty}+` : `${rule.minQty}-${rule.maxQty}`;
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

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const session = await db.session.findFirst({
    where: { shop },
    orderBy: { id: "asc" },
  });

  if (!session?.accessToken) {
    throw new Error(`No Shopify access token found for ${shop}`);
  }

  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (!res.ok || json.errors) {
    return {
      ok: false,
      status: res.status,
      errors: json.errors || json,
      raw: json,
    };
  }

  return {
    ok: true,
    status: res.status,
    raw: json,
  };
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  return jsonResponse({
    ok: true,
    endpoint: "GSO configurator checkout",
    method: "POST",
  });
}

export async function action({ request }: { request: Request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    const body = await request.json();

    const incomingItems = Array.isArray(body.items) && body.items.length ? body.items : [body];
    const shop = clean(body.shop || incomingItems[0]?.shop);
    const email = clean(body.email || incomingItems[0]?.email);

    if (!shop) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing shop.",
        },
        { status: 400 },
      );
    }

    const lineItems: any[] = [];
    const itemSummaries: any[] = [];
    let cartTotal = 0;
    const productTypes = new Set<string>();

    for (const rawItem of incomingItems) {
      const handle = clean(rawItem.handle);
      const productGid = clean(rawItem.productGid || rawItem.shopifyProductGid);
      const material = clean(rawItem.material);
      const finish = clean(rawItem.finish);
      const bagColor = clean(rawItem.bagColor);
      const rawJarColor = rawItem.jarColor || rawItem.jar_color || rawItem.color;
      const labelSet = clean(rawItem.labelSet || rawItem.label_set || rawItem.labelset);
      const productImageUrl = clean(rawItem.image || rawItem.productImageUrl || rawItem.imageUrl);

      if (!handle && !productGid) {
        return jsonResponse(
          {
            ok: false,
            error: "Missing product identifier on one cart item.",
            item: rawItem,
          },
          { status: 400 },
        );
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
        return jsonResponse(
          {
            ok: false,
            error: "No active ERP configurator product found for one cart item.",
            item: {
              handle,
              productGid,
              material,
              finish,
              bagColor,
            },
          },
          { status: 404 },
        );
      }

      const baseProductType = product.productType || "stock_bag_4x5";
      const baseUsesJarColor = isColorVariantJarProductType(baseProductType);
      const normalizedJarColor = normalizeJarColor(rawJarColor);
      const selectedJarColor = isJarProductType(baseProductType) && baseUsesJarColor ? normalizedJarColor || "Clear" : "";
      const productType = resolveJarVariantProductType(baseProductType, selectedJarColor);
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
      const isJar = isJarProductType(productType);
      const usesJarColor = isColorVariantJarProductType(productType);
      const productFamily = productFamilyForType(productType);
      const selectedBagColor = isJar ? "" : bagColor;
      const selectedLabelSet = isJar ? labelSet || "Side + Lid" : "";
      const defaultSides = effectiveProduct.defaultSides || "Double Sided";
      const minQuantity = Number(effectiveProduct.minQuantity || MIN_QTY);
      const quantity = Math.max(numberValue(rawItem.quantity, minQuantity), minQuantity);

      if (isJar) {
        if (!material || !finish || !selectedLabelSet) {
          return jsonResponse(
            {
              ok: false,
              error: "Missing material, finish, or label set on one jar cart item.",
              item: rawItem,
            },
            { status: 400 },
          );
        }
      } else if (!material || !finish || !selectedBagColor) {
        return jsonResponse(
          {
            ok: false,
            error: "Missing material, finish, or bag color on one stock bag cart item.",
            item: rawItem,
          },
          { status: 400 },
        );
      }

      productTypes.add(productType);

      const rules = await db.configuratorPricingRule.findMany({
        where: {
          shop,
          productType,
          active: true,
        },
        orderBy: [{ material: "asc" }, { finish: "asc" }, { minQty: "asc" }],
      });

      const rule = findMatchingRule(rules, material, finish, quantity);

      if (!rule) {
        return jsonResponse(
          {
            ok: false,
            error: "No matching ERP pricing rule found for one cart item.",
            item: {
              title: effectiveProduct.title,
              productType,
              handle,
              material,
              finish,
              bagColor: selectedBagColor,
              jarColor: selectedJarColor,
              labelSet: selectedLabelSet,
              quantity,
            },
          },
          { status: 400 },
        );
      }

      const priceEach = money(rule.priceEach);
      const orderTotal = money(priceEach * quantity);
      const matchedRange = rangeLabel(rule);

      if (!priceEach || priceEach <= 0) {
        return jsonResponse(
          {
            ok: false,
            error: "ERP price is missing or invalid for one cart item.",
            item: {
              title: effectiveProduct.title,
              productType,
              handle,
              material,
              finish,
              bagColor: selectedBagColor,
              jarColor: selectedJarColor,
              labelSet: selectedLabelSet,
              quantity,
            },
          },
          { status: 400 },
        );
      }

      cartTotal = money(cartTotal + orderTotal);

      const baseTitle = effectiveProduct.title || clean(rawItem.title) || "Configured Product";
      const optionSummary = isJar
        ? [selectedJarColor, material, finish, selectedLabelSet].filter(Boolean).join(" / ")
        : `${material} / ${finish} / ${selectedBagColor}`;
      const lineTitle = `${baseTitle} - ${optionSummary}`;
      const customAttributes = [
        { key: "Product Family", value: productFamily },
        { key: "Product Type", value: productType },
        { key: "Material", value: material },
        { key: "Finish", value: finish },
        { key: "Production Finish", value: String(rule.productionFinish || finish) },
        ...(isJar
          ? [
              ...(usesJarColor ? [{ key: "Jar Color", value: selectedJarColor }] : []),
              { key: "Label Set", value: selectedLabelSet },
            ]
          : [
              { key: "Bag Color", value: selectedBagColor },
              { key: "Sides", value: String(defaultSides) },
            ]),
        { key: "_GSO Product Image", value: productImageUrl },
      ];

      lineItems.push({
        title: lineTitle,
        sku: effectiveProduct.sku || "",
        quantity,
        originalUnitPrice: String(priceEach.toFixed(2)),
        customAttributes,
      });

      itemSummaries.push({
        product: {
          id: effectiveProduct.id,
          title: effectiveProduct.title,
          productType,
          handle: effectiveProduct.shopifyHandle,
          sku: effectiveProduct.sku,
          productImageUrl,
        },
        selected: {
          material,
          finish,
          bagColor: selectedBagColor,
          jarColor: selectedJarColor,
          labelSet: selectedLabelSet,
          sides: isJar ? "" : defaultSides,
        },
        pricing: {
          priceEach,
          quantity,
          orderTotal,
          matchedRange,
          jarColor: selectedJarColor,
        },
      });
    }

    if (!lineItems.length) {
      return jsonResponse(
        {
          ok: false,
          error: "No valid cart items were found.",
        },
        { status: 400 },
      );
    }

    const draftRes = await shopifyGraphql(
      shop,
      `#graphql
        mutation CreateConfiguratorDraftOrder($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id
              invoiceUrl
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        input: {
          email: email || undefined,
          note: `Created from GSO Product Configurator. Items: ${lineItems.length}. Product types: ${Array.from(productTypes).join(", ")}.`,
          tags: ["GSO Configurator", ...Array.from(productTypes)],
          lineItems,
        },
      },
    );

    if (!draftRes.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Shopify draft order GraphQL request failed.",
          details: draftRes,
        },
        { status: 500 },
      );
    }

    const data = draftRes.raw;
    const errors = data.data?.draftOrderCreate?.userErrors || [];

    if (errors.length) {
      return jsonResponse(
        {
          ok: false,
          error: "Shopify draft order returned userErrors.",
          errors,
          raw: data,
        },
        { status: 400 },
      );
    }

    const draftOrder = data.data?.draftOrderCreate?.draftOrder;

    return jsonResponse({
      ok: true,
      invoiceUrl: draftOrder?.invoiceUrl,
      draftOrderId: draftOrder?.id,
      itemCount: lineItems.length,
      cartTotal,
      productTypes: Array.from(productTypes),
      items: itemSummaries,
    });
  } catch (error: any) {
    return jsonResponse(
      {
        ok: false,
        error: error?.message || "Unknown configurator checkout error.",
        stack: error?.stack,
      },
      { status: 500 },
    );
  }
}

