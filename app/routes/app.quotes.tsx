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
import { createProductionJobFromSource } from "../lib/production-job-source.server";
import { cleanCommercialName, resolveQuoteDisplayName } from "../lib/commercial-name-resolver.server";
import db from "../db.server";
import { finishOptions } from "../lib/finish-presets";
import {
  QUOTE_READY_RECIPE_WHERE,
  QUOTE_RECIPE_PRICING_INCLUDE,
  priceRecipeAtQuantity,
} from "../lib/recipe-pricing.server";
import { buildApprovalSnapshot, lowMarginApprovalLine, quoteMarginState } from "../lib/quote-margin.server";
import { CUSTOMER_TIERS, customerTierDisplayLabel, isCustomerTier, tierRule } from "../lib/customer-tiers";

type QuoteItemInput = {
  id?: string;
  productName: string;
  variant: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  notes: string;
  productImageUrl?: string;
  artworkUrl?: string;
  proofUrl?: string;
  shopifyProductGid?: string;
  shopifyVariantGid?: string;
  recipeId?: string;
  recipeName?: string;
  selectedFinish?: string;
  selectedAddOnIds?: string[];
  pricingSource?: string;
  tierLabel?: string;
  minQuantity?: string;
  marginPct?: string;
  costSnapshot?: string;
  priceSnapshot?: string;
};

type ShopifyVariantOption = {
  label: string;
  value: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  price: string;
  productImageUrl?: string;
  variantImageUrl?: string;
};

type QuoteInput = {
  id?: string | null;
  customerName: string;
  company: string;
  email: string;
  phone: string;
  customerTier: string;
  customerTierLabel: string;
  status: string;
  notes: string;
  items: QuoteItemInput[];
};

const statuses = [
  { label: "Draft", value: "draft" },
  { label: "Sent", value: "sent" },
  { label: "Approved", value: "approved" },
  { label: "Deposit Paid", value: "deposit_paid" },
  { label: "Paid", value: "paid" },
  { label: "In Production", value: "production" },
  { label: "Completed", value: "completed" },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clean(value: any) {
  return String(value || "").trim().toLowerCase();
}

function money(value: any) {
  const numeric = Number(value) || 0;
  return numeric.toFixed(2);
}

function safeNumber(value: any, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseIdList(value: any): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeIdList(value: any) {
  return parseIdList(value).join(",");
}

function parseJsonSafe(value: any) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

function quoteItemSnapshotValue(item: any, key: string) {
  return item?.[key] || parseJsonSafe(item?.costSnapshot)?.[key] || parseJsonSafe(item?.priceSnapshot)?.[key] || "";
}

function firstProductionImageFromQuoteItem(item: any) {
  return (
    item?.productImageUrl ||
    quoteItemSnapshotValue(item, "productImageUrl") ||
    quoteItemSnapshotValue(item, "imageUrl") ||
    ""
  );
}

const productionChecklistDefaults = [
  { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
  { section: "prepress", label: "Dieline / size confirmed", sortOrder: 20 },
  { section: "prepress", label: "Proof sent if required", sortOrder: 30 },
  { section: "prepress", label: "Proof approved", sortOrder: 40 },
  { section: "production", label: "Material pulled", sortOrder: 50 },
  { section: "production", label: "Machine assigned", sortOrder: 60 },
  { section: "production", label: "Print complete", sortOrder: 70 },
  { section: "production", label: "Cut / laminate / finish complete", sortOrder: 80 },
  { section: "qc", label: "QC passed", sortOrder: 90 },
  { section: "packing", label: "Packed and labeled", sortOrder: 100 },
];

async function sendProductionJobAlert(job: any) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.PRODUCTION_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: "No Slack webhook configured." };

  try {
    const text = [
      "🚨 New GSO Production Job",
      `Customer: ${job.company || job.customerName || "Unknown"}`,
      `Job: ${job.id}`,
      `Quote: ${job.quoteId || "N/A"}`,
      `Priority: ${job.priority || "normal"}`,
    ].join("\n");

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    return { sent: response.ok, reason: response.ok ? "Slack alert sent." : `Slack returned ${response.status}` };
  } catch (error: any) {
    return { sent: false, reason: error?.message || "Slack alert failed." };
  }
}

// 15D.1: thin wrapper over the CENTRAL creation service (advisory-lock
// idempotent, snapshot re-validated, always ticketed). Alerts stay here so
// user-visible behavior is unchanged.
async function createProductionJobFromQuoteInQuotes(shop: string, quoteId: string) {
  const result = await createProductionJobFromSource(db, { shop, source: { type: "erp_quote", quoteId }, actor: "quotes_page" });
  if (result.created && result.job) {
    const alertResult = await sendProductionJobAlert(result.job);
    await db.productionJobEvent.create({
      data: { shop, jobId: result.job.id, eventType: alertResult.sent ? "alert_sent" : "alert_skipped", message: alertResult.reason || "Production alert processed." },
    });
    await db.productionJob.update({ where: { id: result.job.id }, data: { alertSentAt: alertResult.sent ? new Date() : null } });
  }
  return { job: result.job, created: result.created };
}

function emptyItem(): QuoteItemInput {
  return {
    id: uid(),
    productName: "",
    variant: "",
    sku: "",
    quantity: "1",
    unitPrice: "",
    unitCost: "",
    notes: "",
    productImageUrl: "",
    artworkUrl: "",
    proofUrl: "",
    shopifyProductGid: "",
    shopifyVariantGid: "",
    recipeId: "",
    recipeName: "",
    selectedFinish: "base",
    selectedAddOnIds: [],
    pricingSource: "manual",
    tierLabel: "",
    minQuantity: "",
    marginPct: "",
    costSnapshot: "",
    priceSnapshot: "",
  };
}

function normalizeQuote(quote: any): QuoteInput {
  return {
    id: quote.id,
    customerName: quote.customerName || "",
    company: quote.company || "",
    email: quote.email || "",
    phone: quote.phone || "",
    customerTier: isCustomerTier(quote.customerTier) ? quote.customerTier : "standard",
    customerTierLabel: quote.customerTierLabel || "",
    status: quote.status || "draft",
    notes: quote.notes || "",
    items: (quote.items || []).map((item: any) => ({
      id: item.id,
      productName: item.productName || "",
      variant: item.variant || "",
      sku: item.sku || "",
      quantity: String(item.quantity || 1),
      unitPrice: String(item.unitPrice || 0),
      unitCost: String(item.unitCost || 0),
      notes: item.notes || "",
      productImageUrl: item.productImageUrl || "",
      artworkUrl: item.artworkUrl || "",
      proofUrl: item.proofUrl || "",
      shopifyProductGid: item.shopifyProductGid || "",
      shopifyVariantGid: item.shopifyVariantGid || "",
      recipeId: item.recipeId || "",
      recipeName: item.recipeName || "",
      selectedFinish: item.selectedFinish || "base",
      selectedAddOnIds: parseIdList(item.selectedAddOnIds),
      pricingSource: item.pricingSource || (item.recipeId ? "recipe" : "manual"),
      tierLabel: item.tierLabel || "",
      minQuantity:
        item.minQuantity !== null && item.minQuantity !== undefined
          ? String(item.minQuantity)
          : "",
      marginPct:
        item.marginPct !== null && item.marginPct !== undefined
          ? String(item.marginPct)
          : "",
      costSnapshot: item.costSnapshot || "",
      priceSnapshot: item.priceSnapshot || "",
    })),
  };
}

async function getQuotes(shop: string) {
  const quotes = await db.quote.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { items: true },
  });

  // 15D.2: server-resolved display name (customer stays a separate field;
  // historical records are NOT mutated, only displayed cleanly)
  return quotes.map((quote) => ({
    ...quote,
    marginState: quoteMarginState(quote),
    displayName: resolveQuoteDisplayName({ company: quote.company, customerName: quote.customerName, productName: quote.items[0]?.productName }),
  }));
}

async function getRecipeSummaries(shop: string) {
  return db.productRecipe.findMany({
    where: { shop, active: true, useInQuotes: true, costReviewNeeded: false },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    include: {
      productTypeProfile: true,
      tiers: { orderBy: { minQty: "asc" } },
      addOns: { where: { enabled: true }, orderBy: { name: "asc" } },
      vendorProduct: {
        include: {
          tiers: { orderBy: { minQty: "asc" } },
          addOns: { where: { enabled: true }, orderBy: { name: "asc" } },
        },
      },
    },
  });
}

async function searchShopifyProducts(admin: any, search: string) {
  const trimmed = String(search || "").trim();
  if (!trimmed) return [];

  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String!) {
        products(first: 20, query: $query) {
          nodes {
            id
            title
            featuredImage {
              url
              altText
            }
            images(first: 1) {
              nodes {
                url
                altText
              }
            }
            variants(first: 50) {
              nodes {
                id
                title
                sku
                price
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        query: `title:*${trimmed}*`,
      },
    }
  );

  const json = await response.json();
  const options: ShopifyVariantOption[] = [];

  for (const product of json.data?.products?.nodes || []) {
    for (const variant of product.variants?.nodes || []) {
      options.push({
        label: `${product.title} | ${variant.title} | $${variant.price}`,
        value: variant.id,
        productId: product.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku || "",
        price: String(variant.price || "0"),
        productImageUrl: product.featuredImage?.url || product.images?.nodes?.[0]?.url || "",
        variantImageUrl: variant.image?.url || "",
      });
    }
  }

  return options;
}

async function sendDraftOrderInvoice(admin: any, draftOrderId: string) {
  if (!draftOrderId) return null;

  const response = await admin.graphql(
    `#graphql
      mutation draftOrderInvoiceSend($id: ID!) {
        draftOrderInvoiceSend(id: $id) {
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
      variables: {
        id: draftOrderId,
      },
    }
  );

  const data = await response.json();
  const userErrors = data.data?.draftOrderInvoiceSend?.userErrors || [];

  if (userErrors.length) {
    console.error("DRAFT_ORDER_INVOICE_SEND_ERRORS", userErrors);
  }

  return data;
}

async function resolveShopifyImageByIds(admin: any, productGid?: string | null, variantGid?: string | null) {
  let productImageUrl = "";
  let variantImageUrl = "";
  let resolvedProductGid = productGid || "";
  let resolvedVariantGid = variantGid || "";

  if (variantGid) {
    const response = await admin.graphql(
      `#graphql
        query VariantImage($id: ID!) {
          node(id: $id) {
            ... on ProductVariant {
              id
              title
              image {
                url
              }
              product {
                id
                featuredImage {
                  url
                }
                images(first: 1) {
                  nodes {
                    url
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { id: variantGid } },
    );
    const json = await response.json();
    const variant = json.data?.node;
    if (variant) {
      resolvedVariantGid = variant.id || resolvedVariantGid;
      resolvedProductGid = variant.product?.id || resolvedProductGid;
      variantImageUrl = variant.image?.url || "";
      productImageUrl = variant.product?.featuredImage?.url || variant.product?.images?.nodes?.[0]?.url || "";
    }
  }

  if (!productImageUrl && productGid) {
    const response = await admin.graphql(
      `#graphql
        query ProductImage($id: ID!) {
          node(id: $id) {
            ... on Product {
              id
              title
              featuredImage {
                url
              }
              images(first: 1) {
                nodes {
                  url
                }
              }
            }
          }
        }
      `,
      { variables: { id: productGid } },
    );
    const json = await response.json();
    const product = json.data?.node;
    if (product) {
      resolvedProductGid = product.id || resolvedProductGid;
      productImageUrl = product.featuredImage?.url || product.images?.nodes?.[0]?.url || "";
    }
  }

  return {
    productImageUrl: variantImageUrl || productImageUrl || "",
    shopifyProductGid: resolvedProductGid || null,
    shopifyVariantGid: resolvedVariantGid || null,
  };
}

async function priceRecipeLine(shop: string, payload: any, admin?: any) {
  const recipe = await db.productRecipe.findFirst({
    where: { id: payload.recipeId, shop, ...QUOTE_READY_RECIPE_WHERE },
    include: QUOTE_RECIPE_PRICING_INCLUDE,
  });

  if (!recipe) {
    return { ok: false, error: "Recipe not found." };
  }

  const recipeShopifyProductGid = recipe.productGid || recipe.shopifyProductId || null;
  const recipeShopifyVariantGid = recipe.variantGid || recipe.shopifyVariantId || null;
  const shopifyImage = admin
    ? await resolveShopifyImageByIds(admin, recipeShopifyProductGid, recipeShopifyVariantGid)
    : { productImageUrl: "", shopifyProductGid: recipeShopifyProductGid, shopifyVariantGid: recipeShopifyVariantGid };

  const priced = priceRecipeAtQuantity(recipe, payload.quantity, {
    selectedFinish: payload.selectedFinish || "base",
    selectedAddOnIds: parseIdList(payload.selectedAddOnIds),
  });
  const {
    quantity,
    selectedAddOnIds,
    estimate,
    tierLabel,
    marginPct,
    fixedPrice,
    unitCost,
    unitPrice,
    totalPrice,
    profit,
    marginActual,
    minQuantity,
    warnings,
  } = priced;

  const costSnapshot = {
    recipeId: recipe.id,
    recipeName: recipe.name,
    productionMode: recipe.productionMode,
    quantity,
    productImageUrl: shopifyImage.productImageUrl,
    shopifyProductGid: shopifyImage.shopifyProductGid,
    shopifyVariantGid: shopifyImage.shopifyVariantGid,
    estimate,
    warnings,
  };

  const priceSnapshot = {
    tierLabel,
    marginPct,
    fixedPrice,
    unitCost,
    unitPrice,
    totalCost: estimate.totalCost,
    totalPrice,
    profit,
    marginActual,
  };

  return {
    ok: true,
    warnings,
    estimate,
    priceSnapshot,
    line: {
      recipeId: recipe.id,
      recipeName: recipe.name,
      productName: recipe.name,
      variant: estimate.finishLabel,
      sku: recipe.sku || "",
      quantity: String(quantity),
      unitCost: money(unitCost),
      unitPrice: money(unitPrice),
      notes: warnings.length ? `Warnings: ${warnings.join(" ")}` : "Priced from Product Setup recipe.",
      selectedFinish: payload.selectedFinish || "base",
      selectedAddOnIds,
      productImageUrl: shopifyImage.productImageUrl,
      shopifyProductGid: shopifyImage.shopifyProductGid || "",
      shopifyVariantGid: shopifyImage.shopifyVariantGid || "",
      pricingSource: estimate.pricingSource,
      tierLabel,
      minQuantity: String(minQuantity),
      marginPct: marginPct.toFixed(1),
      costSnapshot: JSON.stringify(costSnapshot),
      priceSnapshot: JSON.stringify(priceSnapshot),
    },
  };
}

function quoteItemData(item: QuoteItemInput, quoteId?: string) {
  return {
    ...(quoteId ? { quoteId } : {}),
    productName: item.productName || "Custom item",
    variant: item.variant || null,
    sku: item.sku || null,
    quantity: Math.max(1, Math.floor(safeNumber(item.quantity, 1))),
    unitPrice: safeNumber(item.unitPrice),
    unitCost: safeNumber(item.unitCost),
    notes: item.notes || null,
    productImageUrl: item.productImageUrl || null,
    artworkUrl: item.artworkUrl || null,
    proofUrl: item.proofUrl || null,
    shopifyProductGid: item.shopifyProductGid || null,
    shopifyVariantGid: item.shopifyVariantGid || null,
    recipeId: item.recipeId || null,
    recipeName: item.recipeName || null,
    selectedFinish: item.selectedFinish || null,
    selectedAddOnIds: serializeIdList(item.selectedAddOnIds),
    pricingSource: item.pricingSource || null,
    tierLabel: item.tierLabel || null,
    minQuantity: item.minQuantity ? Math.floor(safeNumber(item.minQuantity)) : null,
    marginPct: item.marginPct ? safeNumber(item.marginPct) : null,
    costSnapshot: item.costSnapshot || null,
    priceSnapshot: item.priceSnapshot || null,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const quotes = await getQuotes(session.shop);
  const recipes = await getRecipeSummaries(session.shop);
  const productCosts = await db.productCost.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const pricingRules = await db.pricingRule.findMany({
    where: {
      shop: session.shop,
      active: true,
    },
    orderBy: [{ priority: "asc" }, { minQty: "desc" }],
  });

  const productionJobs = await db.productionJob.findMany({
    where: { shop: session.shop, active: true },
    select: { id: true, quoteId: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    quotes,
    recipes,
    productOptions: [],
    productCosts,
    pricingRules,
    productionJobs,
  });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "searchProducts") {
    const productOptions = await searchShopifyProducts(admin, payload.search || "");
    return Response.json({ ok: true, productOptions });
  }

  if (payload.intent === "priceRecipe") {
    const result = await priceRecipeLine(shop, payload, admin);
    return Response.json({ intent: "priceRecipe", itemId: payload.itemId, ...result });
  }

  if (payload.intent === "createProductionJobFromQuote") {
    try {
      const result = await createProductionJobFromQuoteInQuotes(shop, payload.quoteId);
      const quotes = await getQuotes(shop);
      const productionJobs = await db.productionJob.findMany({
        where: { shop, active: true },
        select: { id: true, quoteId: true, status: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      });

      return Response.json({
        intent: "createProductionJobFromQuote",
        ok: true,
        quotes,
        productionJobs,
        jobId: result.job.id,
        created: result.created,
        message: result.created ? "Production job created." : "Production job already exists.",
      });
    } catch (error: any) {
      return Response.json({
        intent: "createProductionJobFromQuote",
        ok: false,
        error: error?.message || "Could not create production job.",
      });
    }
  }

  if (payload.intent === "delete") {
    await db.quote.deleteMany({ where: { id: payload.id, shop, status: { not: "paid" } } });
    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  if (payload.intent === "status") {
    const nextStatus = String(payload.status || "");

    if (nextStatus === "sent" || nextStatus === "approved") {
      const quote = await db.quote.findFirst({
        where: { id: payload.id, shop },
        include: { items: true },
      });

      if (quote) {
        const marginState = quoteMarginState(quote);
        if (marginState.approvalRequired) {
          const quotes = await getQuotes(shop);
          return Response.json({ intent: "status", ok: false, error: marginState.blockMessage, quotes });
        }
      }
    }

    await db.quote.updateMany({
      where: { id: payload.id, shop, status: { not: "paid" } },
      data: { status: nextStatus },
    });

    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  if (payload.intent === "approveCreateOrder") {
    try {
      const quote = await db.quote.findFirst({
        where: { id: payload.quoteId, shop },
        include: { items: true },
      });

      if (!quote) {
        return Response.json({
          intent: "approveCreateOrder",
          ok: false,
          error: "Quote not found",
        });
      }

      if (quote.status !== "approved") {
        return Response.json({
          intent: "approveCreateOrder",
          ok: false,
          error: "Quote must be Approved before creating a payment request.",
        });
      }

      if (quote.fullOrderCreated) {
        return Response.json({
          intent: "approveCreateOrder",
          ok: false,
          error: "A full payment order already exists for this quote.",
        });
      }

      if (quote.depositCreated || quote.balanceCreated) {
        return Response.json({
          intent: "approveCreateOrder",
          ok: false,
          error: "This quote is on the deposit/balance track. Use the balance order instead.",
        });
      }

      {
        const marginState = quoteMarginState(quote);
        if (marginState.approvalRequired) {
          return Response.json({ intent: "approveCreateOrder", ok: false, error: marginState.blockMessage });
        }
      }

      const lineItems = quote.items.map((item: any) => ({
        title: cleanCommercialName(item.productName) || "Custom print item", // 15D.2: never a placeholder line title
        quantity: Math.max(1, Number(item.quantity) || 1),
        originalUnitPriceWithCurrency: {
          amount: String(Number(item.unitPrice) || 0),
          currencyCode: "USD",
        },
        customAttributes: [
          { key: "Variant", value: item.variant || "" },
          { key: "SKU", value: item.sku || "" },
          { key: "Recipe", value: item.recipeName || "" },
          { key: "Tier", value: item.tierLabel || "" },
          { key: "Pricing Source", value: item.pricingSource || "" },
          { key: "Product Image", value: item.productImageUrl || "" },
          { key: "Notes", value: item.notes || "" },
        ],
      }));

      const response = await admin.graphql(
        `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
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
          variables: {
            input: {
              email: quote.email || null,
              presentmentCurrencyCode: "USD",
              note: `Created from GSO Quote Builder. Quote ID: ${quote.id}`,
              tags: ["GSO Quote", "Wholesale", "Full Payment"],
              lineItems,
            },
          },
        }
      );

      const data = await response.json();
      const graphqlErrors = data.errors || data.graphQLErrors || [];
      const userErrors = data.data?.draftOrderCreate?.userErrors || [];

      if (graphqlErrors.length || userErrors.length) {
        return Response.json({
          intent: "approveCreateOrder",
          ok: false,
          error: "Shopify rejected the draft order.",
          graphqlErrors,
          userErrors,
          raw: data,
        });
      }

      const draftOrder = data.data?.draftOrderCreate?.draftOrder;

      await db.quote.update({
        where: { id: quote.id },
        data: {
          status: "approved",
          fullOrderCreated: true,
          fullDraftOrderId: draftOrder?.id || null,
          fullInvoiceUrl: draftOrder?.invoiceUrl || null,
        },
      });

      const quotes = await getQuotes(shop);

      return Response.json({
        intent: "approveCreateOrder",
        ok: true,
        quotes,
        invoiceUrl: draftOrder?.invoiceUrl,
        draftOrderId: draftOrder?.id,
      });
    } catch (error: any) {
      console.error("CREATE_FULL_ORDER_ERROR", JSON.stringify(error, null, 2));

      return Response.json({
        intent: "approveCreateOrder",
        ok: false,
        error: error?.message || "Unknown draft order error",
        graphQLErrors: error?.graphQLErrors || [],
      });
    }
  }

  if (payload.intent === "createDepositOrder") {
    try {
      const quote = await db.quote.findFirst({
        where: { id: payload.quoteId, shop },
        include: { items: true },
      });

      if (!quote) {
        return Response.json({
          intent: "createDepositOrder",
          ok: false,
          error: "Quote not found",
        });
      }

      if (quote.status !== "approved") {
        return Response.json({
          intent: "createDepositOrder",
          ok: false,
          error: "Quote must be Approved before creating a deposit request.",
        });
      }

      if (quote.depositCreated) {
        return Response.json({
          intent: "createDepositOrder",
          ok: false,
          error: "A deposit order already exists for this quote.",
        });
      }

      if (quote.fullOrderCreated) {
        return Response.json({
          intent: "createDepositOrder",
          ok: false,
          error: "A full payment order already exists for this quote.",
        });
      }

      {
        const marginState = quoteMarginState(quote);
        if (marginState.approvalRequired) {
          return Response.json({ intent: "createDepositOrder", ok: false, error: marginState.blockMessage });
        }
      }

      const quoteTotal = quote.items.reduce((sum: number, item: any) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const unitPrice = Number(item.unitPrice) || 0;
        return sum + qty * unitPrice;
      }, 0);

      const depositPercent = Number(payload.depositPercent) || 50;
      const depositAmount = Math.round(quoteTotal * (depositPercent / 100) * 100) / 100;
      const balanceDue = Math.round((quoteTotal - depositAmount) * 100) / 100;

      const lineItems = [
        {
          title: `Deposit Payment - ${depositPercent}%`,
          quantity: 1,
          originalUnitPriceWithCurrency: {
            amount: String(depositAmount),
            currencyCode: "USD",
          },
          customAttributes: [
            { key: "Quote ID", value: quote.id },
            { key: "Quote Total", value: `$${quoteTotal.toFixed(2)}` },
            { key: "Deposit Percent", value: `${depositPercent}%` },
            { key: "Balance Due", value: `$${balanceDue.toFixed(2)}` },
          ],
        },
      ];

      const response = await admin.graphql(
        `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
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
          variables: {
            input: {
              email: quote.email || null,
              presentmentCurrencyCode: "USD",
              note: `Deposit created from GSO Quote Builder. Quote ID: ${quote.id}. Quote total: $${quoteTotal.toFixed(2)}. Balance due: $${balanceDue.toFixed(2)}.`,
              tags: ["GSO Quote", "Wholesale", "Deposit"],
              lineItems,
            },
          },
        }
      );

      const data = await response.json();
      const graphqlErrors = data.errors || data.graphQLErrors || [];
      const userErrors = data.data?.draftOrderCreate?.userErrors || [];

      if (graphqlErrors.length || userErrors.length) {
        return Response.json({
          intent: "createDepositOrder",
          ok: false,
          error: "Shopify rejected the deposit draft order.",
          graphqlErrors,
          userErrors,
          raw: data,
        });
      }

      const draftOrder = data.data?.draftOrderCreate?.draftOrder;

      await db.quote.update({
        where: { id: quote.id },
        data: {
          status: "approved",
          depositCreated: true,
          depositAmount,
          balanceDue,
          depositDraftOrderId: draftOrder?.id || null,
          depositInvoiceUrl: draftOrder?.invoiceUrl || null,
        },
      });

      const quotes = await getQuotes(shop);

      return Response.json({
        intent: "createDepositOrder",
        ok: true,
        quotes,
        invoiceUrl: draftOrder?.invoiceUrl,
        draftOrderId: draftOrder?.id,
        depositAmount,
        balanceDue,
      });
    } catch (error: any) {
      console.error("CREATE_DEPOSIT_ORDER_ERROR", JSON.stringify(error, null, 2));

      return Response.json({
        intent: "createDepositOrder",
        ok: false,
        error: error?.message || "Unknown deposit draft order error",
        graphQLErrors: error?.graphQLErrors || [],
      });
    }
  }

  if (payload.intent === "createBalanceOrder") {
    try {
      const quote = await db.quote.findFirst({
        where: { id: payload.quoteId, shop },
        include: { items: true },
      });

      if (!quote) {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "Quote not found",
        });
      }

      if (quote.status !== "deposit_paid") {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "Balance order can be created only after the deposit is paid.",
        });
      }

      if (!quote.depositCreated) {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "No deposit order exists for this quote.",
        });
      }

      if (quote.balanceCreated) {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "A remaining balance order already exists for this quote.",
        });
      }

      {
        const marginState = quoteMarginState(quote);
        if (marginState.approvalRequired) {
          return Response.json({ intent: "createBalanceOrder", ok: false, error: marginState.blockMessage });
        }
      }

      const depositAmount = Math.round((Number(quote.depositAmount) || 0) * 100) / 100;
      const balanceDue = Math.round((Number(quote.balanceDue) || 0) * 100) / 100;

      if (depositAmount <= 0 || balanceDue <= 0) {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "Deposit record incomplete. Re-check the deposit order before creating the balance.",
        });
      }

      const quoteTotal = Math.round((depositAmount + balanceDue) * 100) / 100;

      const lineItems = [
        {
          title: `Remaining Balance - Quote ${quote.id}`,
          quantity: 1,
          originalUnitPriceWithCurrency: {
            amount: String(balanceDue),
            currencyCode: "USD",
          },
          customAttributes: [
            { key: "Quote ID", value: quote.id },
            { key: "Quote Total", value: `$${quoteTotal.toFixed(2)}` },
            { key: "Deposit Paid", value: `$${depositAmount.toFixed(2)}` },
            { key: "Balance Due", value: `$${balanceDue.toFixed(2)}` },
          ],
        },
      ];

      const response = await admin.graphql(
        `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
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
          variables: {
            input: {
              email: quote.email || null,
              presentmentCurrencyCode: "USD",
              note: `Remaining balance created from GSO Quote Builder. Quote ID: ${quote.id}. Quote total: $${quoteTotal.toFixed(2)}. Deposit paid: $${depositAmount.toFixed(2)}. Balance due: $${balanceDue.toFixed(2)}.`,
              tags: ["GSO Quote", "Wholesale", "Remaining Balance"],
              lineItems,
            },
          },
        }
      );

      const data = await response.json();
      const graphqlErrors = data.errors || data.graphQLErrors || [];
      const userErrors = data.data?.draftOrderCreate?.userErrors || [];

      if (graphqlErrors.length || userErrors.length) {
        return Response.json({
          intent: "createBalanceOrder",
          ok: false,
          error: "Shopify rejected the balance draft order.",
          graphqlErrors,
          userErrors,
          raw: data,
        });
      }

      const draftOrder = data.data?.draftOrderCreate?.draftOrder;

      await db.quote.update({
        where: { id: quote.id },
        data: {
          balanceCreated: true,
          balanceDraftOrderId: draftOrder?.id || null,
          balanceInvoiceUrl: draftOrder?.invoiceUrl || null,
        },
      });

      const quotes = await getQuotes(shop);

      return Response.json({
        intent: "createBalanceOrder",
        ok: true,
        quotes,
        invoiceUrl: draftOrder?.invoiceUrl,
        draftOrderId: draftOrder?.id,
        balanceDue,
      });
    } catch (error: any) {
      console.error("CREATE_BALANCE_ORDER_ERROR", JSON.stringify(error, null, 2));

      return Response.json({
        intent: "createBalanceOrder",
        ok: false,
        error: error?.message || "Unknown balance draft order error",
        graphQLErrors: error?.graphQLErrors || [],
      });
    }
  }

  if (payload.intent === "sendInvoiceEmail") {
    const which = String(payload.which || "");
    const quote = await db.quote.findFirst({
      where: { id: payload.quoteId, shop },
      include: { items: true },
    });

    if (!quote) {
      return Response.json({ intent: "sendInvoiceEmail", ok: false, error: "Quote not found" });
    }

    {
      const marginState = quoteMarginState(quote);
      if (marginState.approvalRequired) {
        return Response.json({ intent: "sendInvoiceEmail", ok: false, error: marginState.blockMessage });
      }
    }

    const orderIdByWhich: Record<string, string | null> = {
      full: quote.fullDraftOrderId,
      deposit: quote.depositDraftOrderId,
      balance: quote.balanceDraftOrderId,
    };

    if (!(which in orderIdByWhich)) {
      return Response.json({ intent: "sendInvoiceEmail", ok: false, error: "Unknown invoice type." });
    }

    const draftOrderId = orderIdByWhich[which];
    if (!draftOrderId) {
      return Response.json({ intent: "sendInvoiceEmail", ok: false, error: "No draft order exists for this invoice type yet." });
    }

    try {
      const data = await sendDraftOrderInvoice(admin, draftOrderId);
      const userErrors = data?.data?.draftOrderInvoiceSend?.userErrors || [];

      if (userErrors.length) {
        return Response.json({ intent: "sendInvoiceEmail", ok: false, error: "Shopify rejected the invoice send.", userErrors });
      }

      const label = which === "full" ? "Full payment" : which === "deposit" ? "Deposit" : "Balance";
      const auditLine = `[GSO] ${label} invoice email sent.`;
      const existingNotes = String(quote.notes || "");
      await db.quote.updateMany({
        where: { id: quote.id, shop },
        data: { notes: existingNotes ? `${existingNotes}\n${auditLine}` : auditLine },
      });

      const quotes = await getQuotes(shop);
      return Response.json({ intent: "sendInvoiceEmail", ok: true, quotes, which, message: `${label} invoice email sent.` });
    } catch (error: any) {
      return Response.json({ intent: "sendInvoiceEmail", ok: false, error: error?.message || "Invoice email failed." });
    }
  }

  if (payload.intent === "approveLowMarginQuote") {
    const reason = String(payload.reason || "").trim().slice(0, 300);
    const quote = await db.quote.findFirst({
      where: { id: payload.quoteId, shop },
      include: { items: true },
    });

    if (!quote) {
      return Response.json({ intent: "approveLowMarginQuote", ok: false, error: "Quote not found" });
    }

    const marginState = quoteMarginState(quote);

    if (!marginState.isLowMargin) {
      return Response.json({
        intent: "approveLowMarginQuote",
        ok: false,
        error: "This quote is not low-margin; no approval is needed.",
      });
    }

    if (!reason) {
      return Response.json({ intent: "approveLowMarginQuote", ok: false, error: "An approval reason is required." });
    }

    const actor = String(
      (session as any).email ||
        [(session as any).firstName, (session as any).lastName].filter(Boolean).join(" ") ||
        "staff",
    );
    const approvalLine = lowMarginApprovalLine({
      actor,
      thresholdPct: marginState.thresholdPct,
      blendedMarginPct: marginState.blendedMarginPct,
      lowestMarginPct: marginState.lowestMarginPct,
      reason,
    });
    const approvalSnapshot = buildApprovalSnapshot(quote, marginState);
    const existingNotes = String(quote.notes || "");

    await db.quote.updateMany({
      where: { id: quote.id, shop },
      data: {
        notes: existingNotes ? `${existingNotes}\n${approvalLine}` : approvalLine,
        lowMarginApprovedAt: new Date(),
        lowMarginApprovedBy: actor,
        lowMarginApprovalReason: reason,
        lowMarginApprovalThresholdPct: marginState.thresholdPct,
        lowMarginApprovedSnapshot: approvalSnapshot,
      },
    });

    const quotes = await getQuotes(shop);
    return Response.json({
      intent: "approveLowMarginQuote",
      ok: true,
      quotes,
      message: "Low-margin quote approved.",
    });
  }

  if (payload.intent === "save") {
    const quote = payload.quote as QuoteInput;
    const customerTier = isCustomerTier(quote.customerTier) ? quote.customerTier : "standard";
    const customerTierLabel =
      customerTier === "custom" ? String(quote.customerTierLabel || "").trim().slice(0, 80) || null : null;

    if (quote.id) {
      const existingQuote = await db.quote.findFirst({ where: { id: quote.id, shop } });
      if (existingQuote?.status === "paid") {
        const quotes = await getQuotes(shop);
        return Response.json({ ok: false, error: "Paid quotes are locked and cannot be edited.", quotes });
      }

      await db.$transaction([
        db.quote.updateMany({
          where: { id: quote.id, shop },
          data: {
            customerName: quote.customerName,
            company: quote.company,
            email: quote.email,
            phone: quote.phone,
            customerTier,
            customerTierLabel,
            status: quote.status,
            notes: quote.notes,
          },
        }),
        db.quoteItem.deleteMany({ where: { quoteId: quote.id } }),
        db.quoteItem.createMany({
          data: quote.items.map((item) => quoteItemData(item, quote.id as string)),
        }),
      ]);
    } else {
      await db.quote.create({
        data: {
          shop,
          customerName: quote.customerName,
          company: quote.company,
          email: quote.email,
          phone: quote.phone,
          customerTier,
          customerTierLabel,
          status: quote.status,
          notes: quote.notes,
          items: {
            create: quote.items.map((item) => quoteItemData(item)),
          },
        },
      });
    }

    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  const quotes = await getQuotes(shop);
  return Response.json({ ok: false, quotes });
}

export default function QuotesPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [quotes, setQuotes] = useState<any[]>(loaderData.quotes || []);
  const [recipes, setRecipes] = useState<any[]>(loaderData.recipes || []);
  const [productOptions, setProductOptions] = useState<ShopifyVariantOption[]>(loaderData.productOptions || []);
  const [productCosts, setProductCosts] = useState<any[]>(loaderData.productCosts || []);
  const [pricingRules, setPricingRules] = useState<any[]>(loaderData.pricingRules || []);
  const [productionJobs, setProductionJobs] = useState<any[]>(loaderData.productionJobs || []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState("draft");
  const [notes, setNotes] = useState("");
  const [customerTier, setCustomerTier] = useState("standard");
  const [customerTierLabel, setCustomerTierLabel] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [items, setItems] = useState<QuoteItemInput[]>([emptyItem()]);
  const [lastMessage, setLastMessage] = useState("");
  const [lowMarginReasons, setLowMarginReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fetcher.data?.quotes) setQuotes(fetcher.data.quotes);
    if (fetcher.data?.recipes) setRecipes(fetcher.data.recipes);
    if (fetcher.data?.productOptions) setProductOptions(fetcher.data.productOptions);
    if (fetcher.data?.productCosts) setProductCosts(fetcher.data.productCosts);
    if (fetcher.data?.pricingRules) setPricingRules(fetcher.data.pricingRules);
    if (fetcher.data?.productionJobs) setProductionJobs(fetcher.data.productionJobs);

    if (fetcher.data?.intent === "createProductionJobFromQuote") {
      if (!fetcher.data.ok) {
        setLastMessage(fetcher.data.error || "Production job could not be created.");
        return;
      }
      setLastMessage(fetcher.data.message || "Production job ready.");
      return;
    }

    if (fetcher.data?.intent === "priceRecipe") {
      if (!fetcher.data.ok) {
        setLastMessage(fetcher.data.error || "Recipe pricing failed.");
        return;
      }

      setItems((prev) =>
        prev.map((item) =>
          item.id === fetcher.data.itemId
            ? {
                ...item,
                ...fetcher.data.line,
              }
            : item
        )
      );

      const warnings = fetcher.data.warnings || [];
      setLastMessage(warnings.length ? warnings.join(" ") : "Recipe price calculated and applied to quote item.");
    }

    if (fetcher.data?.error && fetcher.data?.intent !== "priceRecipe") {
      setLastMessage(fetcher.data.error);
    }

    if (fetcher.data?.intent === "sendInvoiceEmail" && fetcher.data?.ok) {
      setLastMessage(fetcher.data.message || "Invoice email sent.");
    }

    if (fetcher.data?.intent === "approveLowMarginQuote" && fetcher.data?.ok) {
      setLastMessage(fetcher.data.message || "Low-margin quote approved.");
    }

    if (
      fetcher.data?.intent === "approveCreateOrder" ||
      fetcher.data?.intent === "createDepositOrder" ||
      fetcher.data?.intent === "createBalanceOrder"
    ) {
      if (!fetcher.data.ok) {
        console.error("Draft order error:", fetcher.data);
        alert("Draft order failed. Check logs.");
        return;
      }

      if (fetcher.data.invoiceUrl) {
        window.open(fetcher.data.invoiceUrl, "_blank", "noopener,noreferrer");
      }
    }
  }, [fetcher.data]);

  const recipeSelectOptions = useMemo(
    () => [
      { label: "Manual quote item", value: "" },
      ...recipes.map((recipe: any) => ({
        label: `${recipe.name} | ${recipe.productionMode === "outsourced" ? "Outsourced" : "In-house"}`,
        value: recipe.id,
      })),
    ],
    [recipes]
  );

  const productSelectOptions = [
    { label: "Select Shopify product / variant", value: "" },
    ...productOptions.map((option) => ({
      label: option.label,
      value: option.value,
    })),
  ];

  function resetQuote() {
    setEditingId(null);
    setCustomerName("");
    setCompany("");
    setEmail("");
    setPhone("");
    setStatus("draft");
    setNotes("");
    setCustomerTier("standard");
    setCustomerTierLabel("");
    setItems([emptyItem()]);
    setLastMessage("");
  }

  function searchProducts() {
    fetcher.submit(
      { intent: "searchProducts", search: productSearch },
      { method: "post", encType: "application/json" }
    );
  }

  function addItem() {
    setItems([...items, emptyItem()]);
  }

  function updateItem(id: string | undefined, field: keyof QuoteItemInput, value: any) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  }

  function getSelectedRecipe(recipeId?: string) {
    return recipes.find((recipe: any) => recipe.id === recipeId);
  }

  function getItemPricingMode(item: QuoteItemInput) {
    return item.recipeId || (item.pricingSource && item.pricingSource !== "manual") ? "erp" : "manual";
  }

  function setItemPricingMode(itemId: string | undefined, mode: "erp" | "manual") {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;

        if (mode === "manual") {
          return {
            ...item,
            recipeId: "",
            recipeName: "",
            selectedFinish: "base",
            selectedAddOnIds: [],
            pricingSource: "manual",
            tierLabel: "",
            minQuantity: "",
            costSnapshot: "",
            priceSnapshot: "",
          };
        }

        return {
          ...item,
          pricingSource: item.recipeId ? "recipe_pending" : "recipe_pending",
        };
      })
    );
  }

  function recipeAddOns(recipe: any) {
    const vendorAddOns = recipe?.vendorProduct?.addOns || [];
    const directAddOns = recipe?.addOns || [];
    return [...vendorAddOns, ...directAddOns];
  }

  function selectRecipe(itemId: string | undefined, recipeId: string) {
    const recipe = getSelectedRecipe(recipeId);

    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        if (!recipe) {
          return {
            ...item,
            recipeId: "",
            recipeName: "",
            pricingSource: "manual",
            selectedFinish: "base",
            selectedAddOnIds: [],
          };
        }

        return {
          ...item,
          recipeId: recipe.id,
          recipeName: recipe.name,
          productName: recipe.name,
          sku: recipe.sku || item.sku,
          quantity: String(recipe.defaultQuantity || recipe.minQuantity || item.quantity || 1),
          selectedFinish: "base",
          selectedAddOnIds: [],
          minQuantity: String(recipe.minQuantity || ""),
          pricingSource: "recipe_pending",
          tierLabel: "",
          marginPct: String(recipe.targetMarginPct || ""),
        };
      })
    );
  }

  function priceRecipeForItem(item: QuoteItemInput) {
    if (!item.recipeId) {
      setLastMessage("Choose a Product Setup / Recipe first.");
      return;
    }

    fetcher.submit(
      {
        intent: "priceRecipe",
        itemId: item.id,
        recipeId: item.recipeId,
        quantity: item.quantity,
        selectedFinish: item.selectedFinish || "base",
        selectedAddOnIds: item.selectedAddOnIds || [],
      },
      { method: "post", encType: "application/json" }
    );
  }

  function toggleAddOn(item: QuoteItemInput, addOnId: string, checked: boolean) {
    const existing = item.selectedAddOnIds || [];
    const next = checked
      ? Array.from(new Set([...existing, addOnId]))
      : existing.filter((id) => id !== addOnId);
    updateItem(item.id, "selectedAddOnIds", next);
  }

  function getMatchedProductCost(selected: ShopifyVariantOption, variantId: string) {
    return productCosts.find((cost: any) => {
      const costVariantId = clean(cost.variantId);
      const selectedVariantId = clean(variantId);
      const costSku = clean(cost.sku);
      const selectedSku = clean(selected.sku);
      const costProductName = clean(cost.productName || cost.name || cost.title || cost.productTitle);
      const selectedProductTitle = clean(selected.productTitle);

      return (
        (costVariantId && costVariantId === selectedVariantId) ||
        (costSku && selectedSku && costSku === selectedSku) ||
        (costProductName && selectedProductTitle && costProductName === selectedProductTitle)
      );
    });
  }

  function getBestPricingRule(selected: ShopifyVariantOption, variantId: string, qty: string) {
    const quantity = Number(qty) || 1;
    const customerKey = clean(email || company || customerName);

    return pricingRules.find((rule: any) => {
      if (!rule.active) return false;
      if (quantity < Number(rule.minQty || 1)) return false;

      const matchesCustomer = !rule.customerTag || customerKey.includes(clean(rule.customerTag));
      const matchesVariant = rule.variantGid && clean(rule.variantGid) === clean(variantId);
      const matchesSku = rule.sku && clean(rule.sku) === clean(selected.sku);
      const matchesProduct = rule.productGid && clean(rule.productGid) === clean(selected.productId);
      const matchesProductTag = rule.productTag && clean(selected.productTitle).includes(clean(rule.productTag));
      const hasProductMatch = matchesVariant || matchesSku || matchesProduct || matchesProductTag;

      return matchesCustomer && hasProductMatch;
    });
  }

  function selectProductVariant(itemId: string | undefined, variantId: string) {
    const selected = productOptions.find((option) => option.value === variantId);
    if (!selected) return;

    const matchedCost = getMatchedProductCost(selected, variantId);
    const currentItem = items.find((item) => item.id === itemId);
    const pricingRule = getBestPricingRule(selected, variantId, currentItem?.quantity || "1");

    const savedUnitCost = matchedCost
      ? (
          Number(matchedCost.materialCost || 0) +
          Number(matchedCost.printCost || 0) +
          Number(matchedCost.laborCost || 0) +
          Number(matchedCost.machineCost || 0) +
          Number(matchedCost.packagingCost || 0)
        ).toFixed(2)
      : undefined;

    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? {
              ...item,
              productName: selected.productTitle,
              variant: selected.variantTitle,
              sku: selected.sku,
              productImageUrl: selected.variantImageUrl || selected.productImageUrl || item.productImageUrl || "",
              shopifyProductGid: selected.productId,
              shopifyVariantGid: selected.value,
              unitPrice:
                pricingRule?.discountType === "percent_off"
                  ? (Number(selected.price) * (1 - Number(pricingRule.percentOff || 0) / 100)).toFixed(2)
                  : pricingRule?.sellPrice
                    ? String(pricingRule.sellPrice)
                    : selected.price,
              unitCost: savedUnitCost || item.unitCost,
              pricingSource: pricingRule ? "shopify_pricing_rule" : "shopify_manual",
            }
          : item
      )
    );
  }

  function deleteItem(id: string | undefined) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  const totals = useMemo(() => {
    let revenue = 0;
    let cost = 0;

    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      revenue += qty * (Number(item.unitPrice) || 0);
      cost += qty * (Number(item.unitCost) || 0);
    }

    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    return { revenue, cost, profit, margin };
  }, [items]);

  const clientProfitStats = useMemo(() => {
    const stats: Record<string, any> = {};

    for (const quote of quotes) {
      const key = quote.email || quote.company || quote.customerName || "Unknown Client";

      if (!stats[key]) {
        stats[key] = {
          client: quote.company || quote.customerName || key,
          email: quote.email || "",
          revenue: 0,
          cost: 0,
          profit: 0,
          quotes: 0,
        };
      }

      let quoteRevenue = 0;
      let quoteCost = 0;

      for (const item of quote.items || []) {
        const qty = Number(item.quantity) || 0;
        quoteRevenue += qty * (Number(item.unitPrice) || 0);
        quoteCost += qty * (Number(item.unitCost) || 0);
      }

      stats[key].revenue += quoteRevenue;
      stats[key].cost += quoteCost;
      stats[key].profit += quoteRevenue - quoteCost;
      stats[key].quotes += 1;
    }

    return Object.values(stats)
      .map((client: any) => ({
        ...client,
        margin: client.revenue > 0 ? (client.profit / client.revenue) * 100 : 0,
      }))
      .sort((a: any, b: any) => b.profit - a.profit);
  }, [quotes]);

  function currentQuote(): QuoteInput {
    return {
      id: editingId,
      customerName,
      company,
      email,
      phone,
      customerTier,
      customerTierLabel,
      status,
      notes,
      items,
    };
  }

  function saveQuote() {
    fetcher.submit(
      { intent: "save", quote: currentQuote() },
      { method: "post", encType: "application/json" }
    );
  }

  function loadQuote(quote: any) {
    const normalized = normalizeQuote(quote);

    setEditingId(normalized.id || null);
    setCustomerName(normalized.customerName);
    setCompany(normalized.company);
    setEmail(normalized.email);
    setPhone(normalized.phone);
    setStatus(normalized.status);
    setNotes(normalized.notes);
    setCustomerTier(normalized.customerTier);
    setCustomerTierLabel(normalized.customerTierLabel);
    setItems(normalized.items.length ? normalized.items : [emptyItem()]);
  }

  function deleteQuote(id: string) {
    fetcher.submit({ intent: "delete", id }, { method: "post", encType: "application/json" });
    if (editingId === id) resetQuote();
  }

  function updateQuoteStatus(id: string, nextStatus: string) {
    fetcher.submit(
      { intent: "status", id, status: nextStatus },
      { method: "post", encType: "application/json" }
    );
  }

  function printQuote() {
    window.print();
  }

  function emailQuote() {
    const body = encodeURIComponent(
      `GSO Packaging Quote\n\nCustomer: ${customerName}\nCompany: ${company}\n\nTotal: $${totals.revenue.toFixed(2)}\nProfit: $${totals.profit.toFixed(2)}\nMargin: ${totals.margin.toFixed(1)}%\n\nNotes:\n${notes}`
    );

    window.location.href = `mailto:${email}?subject=GSO Packaging Quote&body=${body}`;
  }

  function approveAndCreateOrder(quoteId: string) {
    fetcher.submit({ intent: "approveCreateOrder", quoteId }, { method: "post", encType: "application/json" });
  }

  function createDepositOrder(quoteId: string, depositPercent: number) {
    fetcher.submit(
      { intent: "createDepositOrder", quoteId, depositPercent },
      { method: "post", encType: "application/json" }
    );
  }

  function createBalanceOrder(quoteId: string, depositPercent: number) {
    fetcher.submit(
      { intent: "createBalanceOrder", quoteId, depositPercent },
      { method: "post", encType: "application/json" }
    );
  }

  function approveLowMargin(quoteId: string) {
    const reason = String(lowMarginReasons[quoteId] || "").trim();
    fetcher.submit(
      { intent: "approveLowMarginQuote", quoteId, reason },
      { method: "post", encType: "application/json" }
    );
  }

  function sendInvoiceEmail(quoteId: string, which: string) {
    fetcher.submit(
      { intent: "sendInvoiceEmail", quoteId, which },
      { method: "post", encType: "application/json" }
    );
  }

  function productionJobForQuote(quoteId: string) {
    return productionJobs.find((job: any) => job.quoteId === quoteId);
  }

  function createProductionJob(quoteId: string) {
    fetcher.submit(
      { intent: "createProductionJobFromQuote", quoteId },
      { method: "post", encType: "application/json" }
    );
  }

  function openProductionJob(jobId?: string) {
    if (jobId) {
      navigate(`/app/erp/production?job=${jobId}`);
    } else {
      navigate("/app/erp/production");
    }
  }

  let tone: "success" | "warning" | "critical" = "success";
  if (totals.margin < 25) tone = "critical";
  else if (totals.margin < 40) tone = "warning";

  return (
    <Page
      title="GSO Quote Builder"
      subtitle="Build quotes from Product Setup recipes, vendor tiers, label finishes, and manual fallback items."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: editingId ? "Update Quote" : "Save Quote", onAction: saveQuote }}
      secondaryActions={[
        { content: "New Quote", onAction: resetQuote },
        { content: "Print", onAction: printQuote },
        { content: "Email", onAction: emailQuote },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Quote Details</Text>
                  <Text as="p" tone="subdued">
                    Pick a product setup recipe first whenever possible. Manual lines are still available for one-off work.
                  </Text>
                </BlockStack>
                <Badge tone={tone}>Margin {totals.margin.toFixed(1)}%</Badge>
              </InlineStack>

              {lastMessage ? <Text as="p" tone={fetcher.data?.error ? "critical" : "subdued"}>{lastMessage}</Text> : null}

              <InlineStack gap="300">
                <TextField label="Customer Name" value={customerName} onChange={setCustomerName} autoComplete="off" />
                <TextField label="Company" value={company} onChange={setCompany} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Email" value={email} onChange={setEmail} autoComplete="off" />
                <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
                <Select label="Status" value={status} onChange={setStatus} options={statuses} />
                <Select
                  label="Customer tier"
                  value={customerTier}
                  onChange={setCustomerTier}
                  options={CUSTOMER_TIERS.map((tier) => ({ label: tier.label, value: tier.value }))}
                />
                {customerTier === "custom" ? (
                  <TextField
                    label="Custom tier label"
                    value={customerTierLabel}
                    onChange={setCustomerTierLabel}
                    autoComplete="off"
                    placeholder="e.g. Net-30 Partner"
                  />
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Optional Shopify Product Picker</Text>
              <InlineStack gap="300" blockAlign="end">
                <TextField
                  label="Search Shopify products"
                  value={productSearch}
                  onChange={setProductSearch}
                  autoComplete="off"
                  placeholder="Example: 4x5 Custom Pouch"
                />
                <Button onClick={searchProducts}>Search Products</Button>
              </InlineStack>
              <Text as="p" tone="subdued">
                Use this only when quoting an item that has not been set up in Product Setup yet.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Quote Items</Text>
                <Button onClick={addItem}>Add Item</Button>
              </InlineStack>

              {items.map((item, index) => {
                const selectedRecipe = getSelectedRecipe(item.recipeId);
                const selectedAddOns = item.selectedAddOnIds || [];
                const addOns = recipeAddOns(selectedRecipe);
                const belowMinimum = Number(item.minQuantity || 0) > 0 && Number(item.quantity || 0) < Number(item.minQuantity || 0);
                const pricingMode = getItemPricingMode(item);
                const isErpMode = pricingMode === "erp";
                const lineRevenue = Number(item.quantity || 0) * Number(item.unitPrice || 0);
                const lineCost = Number(item.quantity || 0) * Number(item.unitCost || 0);
                const lineProfit = lineRevenue - lineCost;

                return (
                  <Card key={item.id || index}>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">Item {index + 1}</Text>
                          <Text as="p" tone="subdued">
                            Start with ERP pricing whenever this product has been set up. Manual is only for one-off items.
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          {isErpMode ? <Badge tone="success">ERP mode</Badge> : <Badge>Manual mode</Badge>}
                          {item.pricingSource && item.pricingSource !== "manual" && item.pricingSource !== "recipe_pending" ? <Badge tone="success">ERP priced</Badge> : null}
                          {item.tierLabel ? <Badge>{item.tierLabel}</Badge> : null}
                          {belowMinimum ? <Badge tone="critical">Below minimum</Badge> : null}
                        </InlineStack>
                      </InlineStack>

                      <Card>
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="100">
                              <Text as="h3" variant="headingSm">Pricing Source</Text>
                              <Text as="p" tone="subdued">
                                Use Product Setup to pull saved costs, margins, tiers, finishes, and vendor add-ons automatically.
                              </Text>
                            </BlockStack>
                            <InlineStack gap="200">
                              <Button pressed={isErpMode} variant={isErpMode ? "primary" : "secondary"} onClick={() => setItemPricingMode(item.id, "erp")}>
                                ERP Recipe
                              </Button>
                              <Button pressed={!isErpMode} onClick={() => setItemPricingMode(item.id, "manual")}>
                                Manual Item
                              </Button>
                            </InlineStack>
                          </InlineStack>

                          {isErpMode ? (
                            <BlockStack gap="300">
                              <Select
                                label="Product Setup / ERP Recipe"
                                value={item.recipeId || ""}
                                onChange={(recipeId) => selectRecipe(item.id, recipeId)}
                                options={recipeSelectOptions}
                              />

                              {selectedRecipe ? (
                                <BlockStack gap="300">
                                  <InlineStack gap="300">
                                    <Badge>{selectedRecipe.productTypeProfile?.name || selectedRecipe.productType}</Badge>
                                    <Badge>{selectedRecipe.productionMode}</Badge>
                                    <Badge>Min {selectedRecipe.minQuantity || 1}</Badge>
                                  </InlineStack>

                                  <InlineStack gap="300" blockAlign="end">
                                    <TextField
                                      label="Quantity"
                                      value={item.quantity}
                                      onChange={(value) => updateItem(item.id, "quantity", value)}
                                      autoComplete="off"
                                    />
                                    <Button onClick={() => priceRecipeForItem(item)} variant="primary">
                                      Calculate from ERP
                                    </Button>
                                    {belowMinimum ? (
                                      <Button onClick={() => updateItem(item.id, "quantity", item.minQuantity || "1")}>
                                        Use minimum quantity
                                      </Button>
                                    ) : null}
                                  </InlineStack>

                                  {selectedRecipe.productionMode === "outsourced" ? (
                                    addOns.length ? (
                                      <BlockStack gap="150">
                                        <Text as="p" fontWeight="bold">Vendor add-ons for this quote</Text>
                                        {addOns.map((addOn: any) => (
                                          <Checkbox
                                            key={addOn.id}
                                            label={`${addOn.name} (${addOn.pricingType}: $${money(addOn.amount)})`}
                                            checked={selectedAddOns.includes(addOn.id)}
                                            onChange={(checked) => toggleAddOn(item, addOn.id, checked)}
                                          />
                                        ))}
                                      </BlockStack>
                                    ) : (
                                      <Text as="p" tone="subdued">No vendor add-ons are attached to this product setup.</Text>
                                    )
                                  ) : (
                                    <Select
                                      label="Label finish / production option"
                                      value={item.selectedFinish || "base"}
                                      onChange={(value) => updateItem(item.id, "selectedFinish", value)}
                                      options={finishOptions}
                                    />
                                  )}
                                </BlockStack>
                              ) : (
                                <Text as="p" tone="subdued">
                                  Choose a Product Setup / ERP Recipe, enter a quantity, then click Calculate from ERP.
                                </Text>
                              )}
                            </BlockStack>
                          ) : (
                            <BlockStack gap="300">
                              <Select
                                label="Optional Shopify product / variant"
                                value=""
                                onChange={(variantId) => selectProductVariant(item.id, variantId)}
                                options={productSelectOptions}
                              />
                              <InlineStack gap="300">
                                <TextField label="Product / Service" value={item.productName} onChange={(value) => updateItem(item.id, "productName", value)} autoComplete="off" />
                                <TextField label="Variant / Options" value={item.variant} onChange={(value) => updateItem(item.id, "variant", value)} autoComplete="off" />
                                <TextField label="SKU" value={item.sku} onChange={(value) => updateItem(item.id, "sku", value)} autoComplete="off" />
                              </InlineStack>
                              <InlineStack gap="300">
                                <TextField
                                  label="Quantity"
                                  value={item.quantity}
                                  onChange={(value) => updateItem(item.id, "quantity", value)}
                                  autoComplete="off"
                                />
                                <TextField label="Unit Price" prefix="$" value={item.unitPrice} onChange={(value) => updateItem(item.id, "unitPrice", value)} autoComplete="off" />
                                <TextField label="Unit Cost" prefix="$" value={item.unitCost} onChange={(value) => updateItem(item.id, "unitCost", value)} autoComplete="off" />
                              </InlineStack>
                            </BlockStack>
                          )}
                        </BlockStack>
                      </Card>

                      <Card>
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h3" variant="headingSm">Pricing Output</Text>
                            {isErpMode ? (
                              <Text as="p" tone="subdued">ERP values fill after Calculate from ERP. Override only when needed.</Text>
                            ) : (
                              <Text as="p" tone="subdued">Manual item values are controlled by the user.</Text>
                            )}
                          </InlineStack>
                          {isErpMode ? (
                            <InlineStack gap="300">
                              <TextField label="Product / Service" value={item.productName} onChange={(value) => updateItem(item.id, "productName", value)} autoComplete="off" />
                              <TextField label="Variant / Options" value={item.variant} onChange={(value) => updateItem(item.id, "variant", value)} autoComplete="off" />
                              <TextField label="SKU" value={item.sku} onChange={(value) => updateItem(item.id, "sku", value)} autoComplete="off" />
                            </InlineStack>
                          ) : null}
                          <InlineStack gap="300">
                            <TextField label="Unit Cost" prefix="$" value={item.unitCost} onChange={(value) => updateItem(item.id, "unitCost", value)} autoComplete="off" />
                            <TextField label="Unit Price" prefix="$" value={item.unitPrice} onChange={(value) => updateItem(item.id, "unitPrice", value)} autoComplete="off" />
                            <TextField label="Margin %" value={item.marginPct || ""} onChange={(value) => updateItem(item.id, "marginPct", value)} autoComplete="off" />
                          </InlineStack>
                          <InlineStack gap="300" blockAlign="end">
                            {item.productImageUrl ? <img src={item.productImageUrl} alt="Product" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, border: "1px solid #ddd" }} /> : null}
                            <TextField label="Product image URL" value={item.productImageUrl || ""} onChange={(value) => updateItem(item.id, "productImageUrl", value)} autoComplete="off" />
                            <TextField label="Artwork URL optional" value={item.artworkUrl || ""} onChange={(value) => updateItem(item.id, "artworkUrl", value)} autoComplete="off" />
                          </InlineStack>
                          <InlineStack gap="300">
                            <Text as="p">Line Revenue: ${lineRevenue.toFixed(2)}</Text>
                            <Text as="p">Line Cost: ${lineCost.toFixed(2)}</Text>
                            <Text as="p">Line Profit: ${lineProfit.toFixed(2)}</Text>
                          </InlineStack>
                        </BlockStack>
                      </Card>

                      <TextField label="Item Notes" value={item.notes} onChange={(value) => updateItem(item.id, "notes", value)} autoComplete="off" multiline={2} />

                      <InlineStack gap="300">
                        <Button tone="critical" onClick={() => deleteItem(item.id)}>Delete Item</Button>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                );
              })}

            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Quote Summary</Text>
              <Divider />
              <Text as="p">Total Revenue: ${totals.revenue.toFixed(2)}</Text>
              <Text as="p">Total Cost: ${totals.cost.toFixed(2)}</Text>
              <Text as="p">Total Profit: ${totals.profit.toFixed(2)}</Text>
              <Text as="p">Margin: {totals.margin.toFixed(1)}%</Text>
              <TextField label="Quote Notes" value={notes} onChange={setNotes} multiline={4} autoComplete="off" />
              <InlineStack gap="300">
                <Button variant="primary" onClick={saveQuote}>{editingId ? "Update Quote" : "Save Quote"}</Button>
                <Button onClick={printQuote}>Download / Print PDF</Button>
                <Button onClick={emailQuote}>Email Quote</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Profit Per Client</Text>
              <Divider />
              {clientProfitStats.length === 0 ? (
                <Text as="p" tone="subdued">No client profit data yet.</Text>
              ) : (
                clientProfitStats.slice(0, 8).map((client: any) => (
                  <Card key={client.email || client.client}>
                    <BlockStack gap="100">
                      <Text as="p" fontWeight="bold">{client.client}</Text>
                      <Text as="p" tone="subdued">{client.email || "No email"} | {client.quotes} quote(s)</Text>
                      <Text as="p">Revenue: ${client.revenue.toFixed(2)} | Cost: ${client.cost.toFixed(2)} | Profit: ${client.profit.toFixed(2)} | Margin: {client.margin.toFixed(1)}%</Text>
                    </BlockStack>
                  </Card>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">CRM Pipeline</Text>
              <InlineStack gap="300" align="start">
                {statuses.map((stage) => {
                  const stageQuotes = quotes.filter((q) => q.status === stage.value);

                  return (
                    <Card key={stage.value}>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">{stage.label} ({stageQuotes.length})</Text>
                        {stageQuotes.length === 0 ? (
                          <Text as="p" tone="subdued">No quotes</Text>
                        ) : (
                          stageQuotes.map((quote) => {
                            const isPaid = quote.status === "paid";
                            const quoteRevenue = (quote.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
                            const productionJob = productionJobForQuote(quote.id);
                            const canCreateProductionJob = ["paid", "production"].includes(quote.status);
                            return (
                              <Card key={quote.id}>
                                <BlockStack gap="200">
                                  <Text as="p" fontWeight="bold">{quote.displayName || quote.company || quote.customerName || "Custom Quote"}</Text>
                                  {isPaid ? <Badge tone="success">PAID - Quote locked</Badge> : null}
                                  <Badge>{customerTierDisplayLabel(quote.customerTier, quote.customerTierLabel)}</Badge>
                                  {tierRule(quote.customerTier).manualTermsOnly ? (
                                    <Badge tone="attention">Manual terms</Badge>
                                  ) : null}
                                  {productionJob ? <Badge tone="success">Production: {productionJob.status}</Badge> : null}
                                  <Text as="p" tone="subdued">${quoteRevenue.toFixed(2)} | {new Date(quote.updatedAt || quote.createdAt).toLocaleString()}</Text>
                                  {quote.marginState ? (
                                    <Text as="p" tone="subdued">
                                      Blended margin {Number(quote.marginState.blendedMarginPct || 0).toFixed(1)}%
                                      {quote.marginState.lowestMarginPct != null ? ` | lowest item ${Number(quote.marginState.lowestMarginPct).toFixed(1)}%` : ""}
                                      {` | floor ${Number(quote.marginState.thresholdPct || 40)}%`}
                                    </Text>
                                  ) : null}
                                  {quote.marginState?.approvalRequired ? (
                                    <Badge tone="critical">{quote.marginState.approvalLabel || "Low margin - approval required"}</Badge>
                                  ) : null}
                                  {quote.marginState?.isLowMargin && quote.marginState?.isApproved ? (
                                    <Badge tone="warning">
                                      {quote.marginState.approvedBy && quote.marginState.approvedAt
                                        ? `Low margin approved by ${quote.marginState.approvedBy} on ${new Date(quote.marginState.approvedAt).toLocaleDateString()}`
                                        : "Low margin approved"}
                                    </Badge>
                                  ) : null}
                                  {quote.marginState?.approvalStale ? (
                                    <Text as="p" tone="critical">Items changed since approval - re-approve.</Text>
                                  ) : null}
                                  {quote.marginState?.approvalRequired ? (
                                    <InlineStack gap="200">
                                      <TextField
                                        label="Low-margin approval reason"
                                        labelHidden
                                        placeholder="Approval reason (required)"
                                        value={lowMarginReasons[quote.id] || ""}
                                        onChange={(value) => setLowMarginReasons((current) => ({ ...current, [quote.id]: value }))}
                                        autoComplete="off"
                                      />
                                      <Button tone="critical" onClick={() => approveLowMargin(quote.id)}>Approve low margin</Button>
                                    </InlineStack>
                                  ) : null}
                                  <Select label="Move" value={quote.status} disabled={isPaid} onChange={(value) => updateQuoteStatus(quote.id, value)} options={statuses} />
                                  <InlineStack gap="200">
                                    <Button onClick={() => loadQuote(quote)}>Open</Button>
                                    {productionJob ? (
                                      <InlineStack gap="100" blockAlign="center">
                                        <Button variant="primary" onClick={() => openProductionJob(productionJob.id)}>Open Production Job</Button>
                                        <Text as="span" tone="subdued" variant="bodySm">created {productionJob.updatedAt ? new Date(productionJob.updatedAt).toLocaleDateString() : ""}</Text>
                                      </InlineStack>
                                    ) : canCreateProductionJob ? (
                                      <Button variant="primary" onClick={() => createProductionJob(quote.id)}>Create Production Job</Button>
                                    ) : (
                                      /* 15D.1: exact disabled reason */
                                      <Text as="span" tone="subdued" variant="bodySm">
                                        {quote.status === "deposit_paid" ? "Production: balance must be paid first" : quote.status === "approved" ? "Production: available after full payment" : "Production: quote must be approved and paid"}
                                      </Text>
                                    )}
                                    {!quote.marginState?.approvalRequired && quote.status === "approved" && !quote.fullOrderCreated && !quote.depositCreated && !quote.balanceCreated ? (
                                      <Button variant="primary" onClick={() => approveAndCreateOrder(quote.id)}>Create Full Payment Order</Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired && quote.status === "approved" && !quote.depositCreated && !quote.fullOrderCreated ? (
                                      <Button onClick={() => createDepositOrder(quote.id, 50)}>Create 50% Deposit</Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired && quote.status === "deposit_paid" && quote.depositCreated && !quote.balanceCreated ? (
                                      <Button onClick={() => createBalanceOrder(quote.id, 50)}>Create Remaining Balance</Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired && quote.status === "approved" && quote.fullDraftOrderId ? (
                                      <Button onClick={() => sendInvoiceEmail(quote.id, "full")}>Email full invoice</Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired && quote.status === "approved" && quote.depositDraftOrderId ? (
                                      <Button onClick={() => sendInvoiceEmail(quote.id, "deposit")}>Email deposit invoice</Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired && quote.status === "deposit_paid" && quote.balanceDraftOrderId ? (
                                      <Button onClick={() => sendInvoiceEmail(quote.id, "balance")}>Email balance invoice</Button>
                                    ) : null}
                                    {!isPaid ? <Button tone="critical" onClick={() => deleteQuote(quote.id)}>Delete</Button> : null}
                                    <Button onClick={() => window.open(`https://gso-wholesale-app-live.onrender.com/quote/${quote.id}`, "_blank", "noopener,noreferrer")}>Client Portal</Button>
                                    {!quote.marginState?.approvalRequired ? (
                                      <Button
                                        onClick={() => {
                                          const url = `https://gso-wholesale-app-live.onrender.com/quote/${quote.id}`;
                                          navigator.clipboard.writeText(url);
                                          alert("Client portal link copied!");
                                        }}
                                      >
                                        Copy Portal Link
                                      </Button>
                                    ) : null}
                                    {!quote.marginState?.approvalRequired ? (
                                      <Button
                                        onClick={() => {
                                          const url = `https://gso-wholesale-app-live.onrender.com/quote/${quote.id}`;
                                          const subject = encodeURIComponent(`Your GSO Packaging Quote - ${quote.company || ""}`);
                                          const body = encodeURIComponent(`Hi ${quote.customerName || "there"},\n\nYour custom packaging quote is ready.\n\nYou can view and pay here:\n${url}\n\nIf you have any questions, feel free to reach out.\n\n- GSO Packaging`);
                                          window.open(`mailto:${quote.email}?subject=${subject}&body=${body}`);
                                        }}
                                      >
                                        Email Client Portal
                                      </Button>
                                    ) : null}
                                  </InlineStack>
                                </BlockStack>
                              </Card>
                            );
                          })
                        )}
                      </BlockStack>
                    </Card>
                  );
                })}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
