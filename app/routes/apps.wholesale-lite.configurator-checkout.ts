import { db } from "../db.server";
import { MIN_QTY, PRODUCT_TYPE } from "../lib/configurator-pricing";

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
    where: {
      shop,
    },
    orderBy: {
      id: "asc",
    },
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

    const shop = clean(body.shop);
    const handle = clean(body.handle);
    const productGid = clean(body.productGid);
    const material = clean(body.material);
    const finish = clean(body.finish);
    const bagColor = clean(body.bagColor);
    const email = clean(body.email);
    const quantity = Math.max(numberValue(body.quantity, MIN_QTY), MIN_QTY);

    if (!shop || (!handle && !productGid)) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing shop or product identifier.",
        },
        { status: 400 },
      );
    }

    if (!material || !finish || !bagColor) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing material, finish, or bag color.",
        },
        { status: 400 },
      );
    }

    const product = await db.configuratorProduct.findFirst({
      where: {
        shop,
        productType: PRODUCT_TYPE,
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
          error: "No active ERP configurator product found for this Shopify product.",
        },
        { status: 404 },
      );
    }

    const rules = await db.configuratorPricingRule.findMany({
      where: {
        shop,
        productType: PRODUCT_TYPE,
        active: true,
      },
      orderBy: [{ material: "asc" }, { finish: "asc" }, { minQty: "asc" }],
    });

    const rule = findMatchingRule(rules, material, finish, quantity);

    if (!rule) {
      return jsonResponse(
        {
          ok: false,
          error: "No matching ERP pricing rule found.",
          selected: { material, finish, bagColor, quantity },
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
          error: "ERP price is missing or invalid.",
          selected: { material, finish, bagColor, quantity },
        },
        { status: 400 },
      );
    }

    const baseTitle = product.title || "Configured Stock Bag";
    const optionSummary = `${material} / ${finish} / ${bagColor}`;
    const lineTitle = `${baseTitle} - ${optionSummary}`;

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
          note: `Created from GSO Product Configurator. ERP Product ID: ${product.id}. Shopify Product GID: ${product.shopifyProductGid || ""}. Shopify Variant GID: ${product.shopifyVariantGid || ""}.`,
          tags: ["GSO Configurator", "Stock Bag"],
          lineItems: [
            {
              title: lineTitle,
              sku: product.sku || "",
              quantity,
              originalUnitPrice: String(priceEach.toFixed(2)),
              customAttributes: [
                { key: "Material", value: material },
                { key: "Finish", value: finish },
                { key: "Production Finish", value: String(rule.productionFinish || finish) },
                { key: "Bag Color", value: bagColor },
                { key: "Sides", value: "Double Sided" },
                { key: "ERP Price Each", value: `$${priceEach.toFixed(2)}` },
                { key: "ERP Matched Tier", value: matchedRange },
                { key: "ERP Order Total", value: `$${orderTotal.toFixed(2)}` },
              ],
            },
          ],
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
      pricing: {
        priceEach,
        quantity,
        orderTotal,
        matchedRange,
      },
      selected: {
        material,
        finish,
        bagColor,
        sides: "Double Sided",
      },
      product: {
        id: product.id,
        title: product.title,
        handle: product.shopifyHandle,
        sku: product.sku,
      },
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



