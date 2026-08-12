import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { db } from "../db.server";
import { authenticate } from "../shopify.server";
import { MIN_QTY } from "../lib/configurator-pricing";
import {
  publicCheckoutFailure,
  sanitizeDraftOrderUserErrors,
  stripInternalCostFields,
} from "../lib/security-guards-shared";
import { resolveCanonicalBagInputs } from "../lib/canonical-bag-pricing.server";
import { STOREFRONT_BAG_MIN_QTY, buildCanonicalLineMetadata, priceStorefrontConfiguration } from "../lib/storefront-canonical-pricing.server";
import {
  JAR_STOREFRONT_MIN_QTY,
  buildCanonicalJarLineMetadata,
  jarLaunchSizeForType,
  priceJarConfiguration,
} from "../lib/canonical-jar-pricing";
import {
  DTP_FINISH_LABEL,
  DTP_STOREFRONT_MIN_QTY,
  buildCanonicalDtpLineMetadata,
  dtpLaunchInfoForType,
  priceDtpConfiguration,
} from "../lib/canonical-dtp-pricing.server";
import {
  STICKER_STOREFRONT_MIN_QTY,
  buildCanonicalStickerLineMetadata,
  priceStickerConfiguration,
  resolveCanonicalStickerInputs,
  stickerLaunchInfoForType,
  type CanonicalStickerInputs,
} from "../lib/canonical-sticker-pricing.server";

const SHOPIFY_API_VERSION = "2025-10";

// 15G.1: served only through the signed Shopify app proxy (same-origin from
// the storefront) — no cross-origin callers exist, so no CORS headers.
function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(stripInternalCostFields(data), null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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

function productFamilyForType(productType: string): "Jars" | "Stock Bags" | "DTP Pouches" | "Stickers" {
  if (isJarProductType(productType)) return "Jars";
  if (productType.startsWith("dtp_")) return "DTP Pouches";
  if (productType.startsWith("sticker_")) return "Stickers";
  return "Stock Bags";
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

// 15G.1: the admin token comes ONLY from the authenticated app-proxy session
// — never looked up from the Session table by an attacker-chosen shop value.
async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: any) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
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

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonResponse({ ok: false, error: "App is not installed for this shop." }, { status: 400 });
  }

  return jsonResponse({
    ok: true,
    endpoint: "GSO configurator checkout",
    method: "POST",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  // 15G.1: require a valid Shopify app-proxy signature; the authorized shop
  // and admin token come ONLY from the authenticated session. `shop` in the
  // request body is ignored. Invalid signatures throw inside authenticate.
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.accessToken) {
    return jsonResponse({ ok: false, error: "App is not installed for this shop." }, { status: 400 });
  }
  const shop = session.shop;
  const accessToken = session.accessToken;

  try {
    const body = await request.json();

    const incomingItems = Array.isArray(body.items) && body.items.length ? body.items : [body];
    const email = clean(body.email || incomingItems[0]?.email);

    // 15G.5: canonical inputs resolved ONCE per checkout — every supported
    // stock-bag line is repriced server-side through the canonical engine.
    // Posted/browser prices are never read (unchanged contract).
    const canonicalInputs = await resolveCanonicalBagInputs(db, shop);
    // 16F: sticker inputs resolve lazily on the first sticker line.
    let stickerInputs: CanonicalStickerInputs | null = null;

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
            item: { handle, productGid, material, finish },
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
      // 16D: launch jars (100ml/150ml Miron applied-label) price through the
      // canonical jar engine — the posted "material" carries the included
      // Matte/Gloss base finish, "labelSet" carries the label material, and
      // "finish" carries the universal specialty ladder selection.
      const jarLaunchSize = isJar ? jarLaunchSizeForType(productType) : null;
      // 16E: outsourced DTP pouches — size + quantity are the only axes;
      // posted option strings are informational and never validated/priced.
      const dtpLaunch = dtpLaunchInfoForType(productType);
      // 16F: dimension-driven stickers — the server recomputes width x height.
      const stickerLaunch = stickerLaunchInfoForType(productType);
      const stickerWidthIn = clean(rawItem.widthIn || rawItem.width);
      const stickerHeightIn = clean(rawItem.heightIn || rawItem.height);
      const usesJarColor = isColorVariantJarProductType(productType);
      const productFamily = productFamilyForType(productType);
      const selectedBagColor = isJar ? "" : bagColor;
      const selectedLabelSet = isJar ? labelSet || (jarLaunchSize ? "Standard" : "Side + Lid") : "";
      const defaultSides = effectiveProduct.defaultSides || "Double Sided";
      // 15G.5A: bags floor at the approved ladder minimum (50); non-launch
      // jars keep their own product MOQ; launch jars floor at the approved
      // jar minimum (50). The clamp can only RAISE a posted quantity.
      const minQuantity = stickerLaunch
        ? STICKER_STOREFRONT_MIN_QTY
        : dtpLaunch
          ? DTP_STOREFRONT_MIN_QTY
          : isJar
            ? jarLaunchSize
              ? JAR_STOREFRONT_MIN_QTY
              : Number(effectiveProduct.minQuantity || MIN_QTY)
            : STOREFRONT_BAG_MIN_QTY;
      const quantity = Math.max(numberValue(rawItem.quantity, minQuantity), minQuantity);

      if (stickerLaunch) {
        if (!stickerWidthIn || !stickerHeightIn) {
          return jsonResponse(
            {
              ok: false,
              error: "Missing sticker dimensions (width and height in inches) on one cart item.",
              item: { handle, productGid, widthIn: stickerWidthIn, heightIn: stickerHeightIn, quantity },
            },
            { status: 400 },
          );
        }
      } else if (dtpLaunch) {
        // no option validation — everything is included in the vendor spec
      } else if (isJar) {
        if (!material || !finish || !selectedLabelSet) {
          return jsonResponse(
            {
              ok: false,
              error: "Missing material, finish, or label set on one jar cart item.",
              item: { handle, productGid, material, finish, jarColor: selectedJarColor, labelSet: selectedLabelSet, quantity },
            },
            { status: 400 },
          );
        }
      } else if (!material || !finish || !selectedBagColor) {
        return jsonResponse(
          {
            ok: false,
            error: "Missing material, finish, or bag color on one stock bag cart item.",
            item: { handle, productGid, material, finish, bagColor: selectedBagColor, quantity },
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

      // 15G.5: supported stock bags are repriced through the CANONICAL
      // engine at checkout — the line price is server-derived from the
      // configuration alone (posted prices are never read); malformed,
      // unsupported, and Deep Build (9X+) combinations are rejected.
      // Jars remain on the legacy rule path until their canonical phase.
      let priceEach = 0;
      let matchedRange = "";
      let canonicalMeta: string | null = null;
      if (stickerLaunch) {
        // 16F: dimension-driven server recompute through the ONE ERP cost +
        // commercial policy pipeline — posted prices/areas are never read.
        stickerInputs = stickerInputs || (await resolveCanonicalStickerInputs(db, shop));
        const priced = priceStickerConfiguration(stickerInputs, {
          productType,
          widthIn: stickerWidthIn,
          heightIn: stickerHeightIn,
          quantity,
          material,
          specialty: finish,
        });
        if (!priced.ok) {
          return jsonResponse(
            {
              ok: false,
              requestQuote: priced.requestQuote,
              error: priced.reason,
              item: { title: effectiveProduct.title, productType, handle, widthIn: stickerWidthIn, heightIn: stickerHeightIn, material, finish, quantity },
            },
            { status: 400 },
          );
        }
        priceEach = priced.unitPrice;
        matchedRange = "canonical";
        canonicalMeta = buildCanonicalStickerLineMetadata({ productType, priced });
      } else if (dtpLaunch) {
        // 16E: server recompute from the owner DTP selling-price ladders —
        // posted prices are never read; >10,000 and below-MOQ are rejected.
        const priced = priceDtpConfiguration({ productType, quantity });
        if (!priced.ok) {
          return jsonResponse(
            {
              ok: false,
              requestQuote: priced.requestQuote,
              error: priced.reason,
              item: { title: effectiveProduct.title, productType, handle, quantity },
            },
            { status: 400 },
          );
        }
        priceEach = priced.unitPrice;
        matchedRange = `${priced.tierUsed}+`;
        canonicalMeta = buildCanonicalDtpLineMetadata({ productType, priced });
      } else if (jarLaunchSize) {
        // 16D: owner-approved launch pricing recomputed SERVER-SIDE from the
        // configuration alone — posted prices are never read. 5,000+ and
        // Deep Build 9X+ are rejected here exactly like bag Deep Builds.
        const priced = priceJarConfiguration({
          productType,
          quantity,
          baseFinish: material,
          labelMaterial: selectedLabelSet,
          specialty: finish,
        });
        if (!priced.ok) {
          return jsonResponse(
            {
              ok: false,
              requestQuote: priced.requestQuote,
              error: priced.reason,
              item: { title: effectiveProduct.title, productType, handle, material, finish, labelSet: selectedLabelSet, quantity },
            },
            { status: 400 },
          );
        }
        priceEach = priced.unitPrice;
        matchedRange = `${priced.tierMinQty}+`;
        canonicalMeta = buildCanonicalJarLineMetadata({ productType, priced, jarColor: selectedJarColor || undefined });
      } else if (!isJar) {
        const faces = /single|front\s*only/i.test(String(defaultSides || "")) ? 1 : 2;
        const priced = priceStorefrontConfiguration(canonicalInputs, { quantity, faces, material, finish });
        if (!priced.ok) {
          return jsonResponse(
            {
              ok: false,
              requestQuote: priced.requestQuote,
              error: priced.reason,
              item: { title: effectiveProduct.title, productType, handle, material, finish, bagColor: selectedBagColor, quantity },
            },
            { status: 400 },
          );
        }
        priceEach = priced.unitPrice;
        matchedRange = "canonical";
        canonicalMeta = buildCanonicalLineMetadata({
          profileType: productType,
          selection: { quantity, faces, material, finish, bagColor: selectedBagColor },
          priced,
          finishLabel: finish,
        });
      } else {
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
        priceEach = money(rule.priceEach);
        matchedRange = rangeLabel(rule);
      }

      const orderTotal = money(priceEach * quantity);

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
      const optionSummary = stickerLaunch
        ? `${stickerWidthIn}x${stickerHeightIn}in / ${material} / ${finish}`
        : dtpLaunch
          ? `${dtpLaunch.size} / Soft-Touch Full-Color / CR Zipper Included`
          : isJar
            ? [selectedJarColor, material, finish, selectedLabelSet].filter(Boolean).join(" / ")
            : `${material} / ${finish} / ${selectedBagColor}`;
      const lineTitle = `${baseTitle} - ${optionSummary}`;
      const customAttributes = [
        { key: "Product Family", value: productFamily },
        { key: "Product Type", value: productType },
        { key: "Material", value: dtpLaunch ? "Soft-Touch Lamination (Included)" : material },
        { key: "Finish", value: dtpLaunch ? DTP_FINISH_LABEL : finish },
        ...(dtpLaunch
          ? [
              { key: "Size", value: dtpLaunch.size },
              { key: "CR Zipper", value: "Included" },
            ]
          : []),
        ...(stickerLaunch
          ? [
              { key: "Width (in)", value: stickerWidthIn },
              { key: "Height (in)", value: stickerHeightIn },
              { key: "Cut", value: stickerLaunch.stickerType === "die_cut" ? "Die-Cut (contour)" : "Square / Rectangle" },
            ]
          : []),
        // 15G.5B: `rule` is legitimately null on the canonical bag path (legacy
        // ConfiguratorPricingRule rows never match the canonical finish labels)
        // — the canonical finish label IS the production finish for bags.
        { key: "Production Finish", value: dtpLaunch ? DTP_FINISH_LABEL : String(rule?.productionFinish || finish) },
        ...(dtpLaunch
          ? []
          : isJar
          ? [
              ...(usesJarColor ? [{ key: "Jar Color", value: selectedJarColor }] : []),
              // 16D launch jars: explicit customer-facing base finish + label
              // material; "Label Set" stays for legacy line compatibility.
              ...(jarLaunchSize
                ? [
                    { key: "Base Finish", value: material },
                    { key: "Label Material", value: selectedLabelSet },
                  ]
                : []),
              { key: "Label Set", value: selectedLabelSet },
            ]
          : [
              { key: "Bag Color", value: selectedBagColor },
              { key: "Sides", value: String(defaultSides) },
            ]),
        { key: "_GSO Product Image", value: productImageUrl },
        // 16E: DTP lines omit Bag Color/Sides entirely (vendor-finished
        // pouch; both sides printed by spec).
        // 15G.5 (O): hidden canonical configuration snapshot for paid-order
        // production creation and future Ticket-First intake.
        ...(canonicalMeta ? [{ key: "_GSO Canonical", value: canonicalMeta }] : []),
      ];

      lineItems.push({
        title: lineTitle,
        sku: effectiveProduct.sku || "",
        quantity,
        // 15G.5B ROOT-CAUSE FIX: `originalUnitPrice` no longer exists on the
        // pinned 2025-10 Admin API (schema-verified 2026-08-11) — the dead
        // field made draftOrderCreate fail schema validation on every live
        // checkout. `originalUnitPriceWithCurrency` is the current field
        // (same shape Quotes/CRM has used successfully all along).
        originalUnitPriceWithCurrency: {
          amount: priceEach.toFixed(2),
          currencyCode: "USD",
        },
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
      accessToken,
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
      // 15G.1: log the detailed failure server-side; the customer gets a
      // generic message — never raw Shopify responses or internals.
      console.error("[configurator-checkout] Shopify draft order request failed", {
        shop,
        status: draftRes.status,
        errors: draftRes.errors,
      });
      // 15G.5B: NEVER emit 5xx through the app proxy — Shopify replaces
      // upstream 5xx responses with its storefront theme error page (the
      // browser then sees HTML instead of our JSON). 4xx passes through.
      return jsonResponse(publicCheckoutFailure(), { status: 400 });
    }

    const data = draftRes.raw;
    const errors = data.data?.draftOrderCreate?.userErrors || [];

    if (errors.length) {
      console.error("[configurator-checkout] Shopify draft order userErrors", { shop, errors });
      return jsonResponse(
        {
          ok: false,
          error: "Shopify could not create the draft order.",
          errors: sanitizeDraftOrderUserErrors(errors),
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
    // 15G.1: never serialize stack traces, tokens, or exception internals to
    // the public caller — log server-side, return the fixed generic message.
    // 15G.5B: status 400, not 500 — the app proxy swallows upstream 5xx and
    // serves the storefront theme page instead of our JSON.
    console.error("[configurator-checkout] unhandled checkout error", error);
    return jsonResponse(publicCheckoutFailure(), { status: 400 });
  }
}

