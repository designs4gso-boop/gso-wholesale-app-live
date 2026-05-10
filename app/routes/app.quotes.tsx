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

type QuoteItemInput = {
  id?: string;
  productName: string;
  variant: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  notes: string;
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
};

type QuoteInput = {
  id?: string | null;
  customerName: string;
  company: string;
  email: string;
  phone: string;
  status: string;
  notes: string;
  items: QuoteItemInput[];
};

const statuses = [
  { label: "Draft", value: "draft" },
  { label: "Sent", value: "sent" },
  { label: "Approved", value: "approved" },
  { label: "Paid", value: "paid" },
  { label: "In Production", value: "production" },
  { label: "Completed", value: "completed" },
];

const finishPresets: Record<
  string,
  {
    label: string;
    whiteLayers: number;
    glossLayers: number;
    sqftPerHour: number;
    preferredMachine: string;
  }
> = {
  base: {
    label: "Base CMYK",
    whiteLayers: 0,
    glossLayers: 0,
    sqftPerHour: 150,
    preferredMachine: "Mimaki or Roland",
  },
  white: {
    label: "White",
    whiteLayers: 1,
    glossLayers: 0,
    sqftPerHour: 70,
    preferredMachine: "Mimaki or Roland",
  },
  gloss: {
    label: "Gloss",
    whiteLayers: 0,
    glossLayers: 1,
    sqftPerHour: 60,
    preferredMachine: "Roland LG-540",
  },
  white_gloss: {
    label: "White + Gloss",
    whiteLayers: 1,
    glossLayers: 1,
    sqftPerHour: 45,
    preferredMachine: "Roland LG-540",
  },
  emboss: {
    label: "Emboss",
    whiteLayers: 0,
    glossLayers: 2,
    sqftPerHour: 35,
    preferredMachine: "Roland LG-540",
  },
  white_emboss: {
    label: "White + Emboss",
    whiteLayers: 1,
    glossLayers: 2,
    sqftPerHour: 30,
    preferredMachine: "Roland LG-540",
  },
  emboss_3x: {
    label: "3x Emboss",
    whiteLayers: 0,
    glossLayers: 3,
    sqftPerHour: 25,
    preferredMachine: "Roland LG-540",
  },
  white_emboss_3x: {
    label: "White + 3x Emboss",
    whiteLayers: 1,
    glossLayers: 3,
    sqftPerHour: 20,
    preferredMachine: "Roland LG-540",
  },
};

const finishOptions = Object.entries(finishPresets).map(([value, preset]) => ({
  label: preset.label,
  value,
}));

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

function percentToDivisor(marginPct: number) {
  const safeMargin = Math.min(Math.max(marginPct, 0), 95);
  return 1 - safeMargin / 100;
}

function rangeLabel(row: any) {
  if (!row) return "No tier";
  return row.maxQty ? `${row.minQty}-${row.maxQty}` : `${row.minQty}+`;
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

function getBestRange(rows: any[], quantity: number) {
  const sorted = [...(rows || [])].sort(
    (a, b) => safeNumber(a.minQty) - safeNumber(b.minQty)
  );

  const exact = sorted.find((row) => {
    const minQty = safeNumber(row.minQty, 1);
    const maxQty = row.maxQty == null ? null : safeNumber(row.maxQty);
    return quantity >= minQty && (maxQty == null || quantity <= maxQty);
  });

  if (exact) return exact;

  const fallback = sorted
    .filter((row) => quantity >= safeNumber(row.minQty, 1))
    .pop();

  return fallback || sorted[0] || null;
}

function materialUnitCost(material: any) {
  return (
    safeNumber(material?.calculatedUnitCost) ||
    safeNumber(material?.costPerUnit) ||
    safeNumber(material?.purchaseCost)
  );
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
  return db.quote.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { items: true },
  });
}

async function getRecipeSummaries(shop: string) {
  return db.productRecipe.findMany({
    where: { shop, active: true },
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
            variants(first: 50) {
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

function calculateAddOns(addOns: any[], selectedAddOnIds: string[], quantity: number, baseCost: number) {
  let perUnitCost = 0;
  let flatCost = 0;
  let percentCost = 0;
  const selected: any[] = [];

  for (const addOn of addOns || []) {
    if (!selectedAddOnIds.includes(addOn.id)) continue;
    selected.push(addOn);

    const amount = safeNumber(addOn.amount);
    if (addOn.pricingType === "per_unit") perUnitCost += amount * quantity;
    else if (addOn.pricingType === "flat_fee") flatCost += amount;
    else if (addOn.pricingType === "percent") percentCost += baseCost * (amount / 100);
  }

  return {
    selected,
    total: perUnitCost + flatCost + percentCost,
    perUnitCost,
    flatCost,
    percentCost,
  };
}

function calculateInHouseRecipe(recipe: any, quantity: number, selectedFinish: string) {
  const finish = finishPresets[selectedFinish] || finishPresets.base;
  const widthIn = safeNumber(recipe.widthIn);
  const heightIn = safeNumber(recipe.heightIn);
  const sqftEach = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
  const rawSqft = sqftEach * quantity;
  const wastePct = safeNumber(recipe.wastePct);
  const wasteDivisor = Math.max(0.01, 1 - wastePct / 100);
  const totalSqft = rawSqft / wasteDivisor;
  const machine = recipe.machineRules?.[0]?.preferredMachine || null;
  const sqftPerHour = finish.sqftPerHour || safeNumber(machine?.sqftPerHour, 150) || 150;
  const runHours = sqftPerHour > 0 ? totalSqft / sqftPerHour : 0;
  const setupHours = safeNumber(recipe.laborMinutes) / 60;
  const operatorRate = safeNumber(recipe.operatorLaborPct, 25);
  const machineHourlyCost = safeNumber(machine?.costPerHour);

  let materialCost = 0;
  const materialBreakdown: any[] = [];

  for (const recipeMaterial of recipe.materials || []) {
    const material = recipeMaterial.material;
    const unitCost = materialUnitCost(material);
    const multiplier = safeNumber(recipeMaterial.quantity, 1) || 1;
    const unit = String(recipeMaterial.unit || material?.baseUnit || material?.unit || "each").toLowerCase();
    let cost = 0;

    if (unit === "sqft" || unit === "square_foot") {
      cost = totalSqft * unitCost * multiplier;
    } else if (unit === "sqin" || unit === "square_inch") {
      cost = totalSqft * 144 * unitCost * multiplier;
    } else if (unit === "each") {
      cost = quantity * unitCost * multiplier;
    } else if (unit === "hour") {
      cost = runHours * unitCost * multiplier;
    } else {
      cost = quantity * unitCost * multiplier;
    }

    materialCost += cost;
    materialBreakdown.push({
      name: material?.name || "Material",
      usageType: recipeMaterial.usageType,
      unit,
      unitCost,
      cost,
    });
  }

  const channels = (machine?.inkChannels || []).filter((channel: any) => channel.enabled !== false);
  const cmykChannels = channels.filter((channel: any) => clean(channel.inkType) === "cmyk");
  const whiteChannels = channels.filter((channel: any) => clean(channel.inkType) === "white");
  const glossChannels = channels.filter((channel: any) => clean(channel.inkType) === "gloss");

  const channelCost = (channel: any, coveragePct: number) => {
    const costPerMl = safeNumber(channel.costPerMl) || safeNumber(channel.cartridgeCost) / Math.max(1, safeNumber(channel.cartridgeMl, 1));
    return totalSqft * coveragePct * safeNumber(channel.mlPerSqft1Pct) * costPerMl;
  };

  const cmykCoverage = safeNumber(recipe.baseCmykCoveragePct, 40);
  const inkAllowance = 1 + safeNumber(recipe.inkAllowancePct, 15) / 100;
  const cmykInkCost = cmykChannels.reduce((sum: number, channel: any) => sum + channelCost(channel, cmykCoverage), 0);
  const whiteInkCost = whiteChannels.reduce(
    (sum: number, channel: any) => sum + channelCost(channel, 100 * finish.whiteLayers),
    0
  );
  const glossInkCost = glossChannels.reduce(
    (sum: number, channel: any) => sum + channelCost(channel, 100 * finish.glossLayers),
    0
  );
  const inkCost = (cmykInkCost + whiteInkCost + glossInkCost) * inkAllowance;

  const machineRunCost = runHours * machineHourlyCost;
  const laborCost = (runHours + setupHours) * operatorRate;
  const maintenanceCost = totalSqft * safeNumber(recipe.maintenanceCostPerSqft);
  const machineRecoveryCost = totalSqft * safeNumber(recipe.machineRecoveryCostPerSqft);
  const overheadCost = totalSqft * safeNumber(recipe.overheadCostPerSqft);
  const setupCost = safeNumber(recipe.setupCost);

  const totalCost =
    materialCost +
    inkCost +
    machineRunCost +
    laborCost +
    maintenanceCost +
    machineRecoveryCost +
    overheadCost +
    setupCost;

  const warnings: string[] = [];
  if (!widthIn || !heightIn) warnings.push("Recipe is missing label width or height.");
  if (!recipe.materials?.length) warnings.push("Recipe has no material attached.");
  if (!machine) warnings.push("Recipe has no preferred machine.");
  if (machine && !channels.length) warnings.push("Machine has no enabled ink channels, so ink may be under-costed.");
  if (finish.whiteLayers && !whiteChannels.length) warnings.push("White finish selected, but no white ink channel was found.");
  if (finish.glossLayers && !glossChannels.length) warnings.push("Gloss/emboss finish selected, but no gloss ink channel was found.");

  return {
    pricingSource: "recipe_in_house",
    finishLabel: finish.label,
    preferredMachine: machine?.name || finish.preferredMachine,
    quantity,
    sqftEach,
    totalSqft,
    runHours,
    costEach: quantity > 0 ? totalCost / quantity : 0,
    totalCost,
    warnings,
    breakdown: {
      materialCost,
      materialBreakdown,
      inkCost,
      cmykInkCost: cmykInkCost * inkAllowance,
      whiteInkCost: whiteInkCost * inkAllowance,
      glossInkCost: glossInkCost * inkAllowance,
      machineRunCost,
      laborCost,
      maintenanceCost,
      machineRecoveryCost,
      overheadCost,
      setupCost,
      sqftPerHour,
      wastePct,
      inkAllowancePct: safeNumber(recipe.inkAllowancePct, 15),
    },
  };
}

function calculateOutsourcedRecipe(recipe: any, quantity: number, selectedAddOnIds: string[]) {
  const vendorProduct = recipe.vendorProduct;
  const vendorTier = getBestRange(vendorProduct?.tiers || [], quantity);
  const baseUnitCost = vendorTier ? safeNumber(vendorTier.unitCost) : safeNumber(vendorProduct?.defaultUnitCost);
  const baseCost = quantity * baseUnitCost;
  const vendorAddOns = vendorProduct?.addOns || [];
  const recipeAddOns = recipe.addOns || [];
  const addOnCost = calculateAddOns([...vendorAddOns, ...recipeAddOns], selectedAddOnIds, quantity, baseCost);
  const setupCost = safeNumber(recipe.setupCost);
  const totalCost = baseCost + addOnCost.total + setupCost;

  const warnings: string[] = [];
  if (!vendorProduct) warnings.push("Outsourced recipe has no vendor product attached.");
  if (vendorProduct && !vendorTier && !vendorProduct.defaultUnitCost) {
    warnings.push("Vendor product has no matching tier cost or fallback unit cost.");
  }

  return {
    pricingSource: "recipe_outsourced",
    finishLabel: addOnCost.selected.length
      ? addOnCost.selected.map((addOn) => addOn.name).join(", ")
      : "No add-ons",
    preferredMachine: "Vendor produced",
    quantity,
    sqftEach: 0,
    totalSqft: 0,
    runHours: 0,
    costEach: quantity > 0 ? totalCost / quantity : 0,
    totalCost,
    warnings,
    breakdown: {
      vendor: vendorProduct?.vendor || "",
      vendorSku: vendorProduct?.vendorSku || "",
      vendorTier: rangeLabel(vendorTier),
      baseUnitCost,
      baseCost,
      addOnCost: addOnCost.total,
      selectedAddOns: addOnCost.selected.map((addOn) => ({
        id: addOn.id,
        name: addOn.name,
        pricingType: addOn.pricingType,
        amount: addOn.amount,
      })),
      setupCost,
    },
  };
}

async function priceRecipeLine(shop: string, payload: any) {
  const quantity = Math.max(1, Math.floor(safeNumber(payload.quantity, 1)));
  const recipe = await db.productRecipe.findFirst({
    where: { id: payload.recipeId, shop, active: true },
    include: {
      tiers: { orderBy: { minQty: "asc" } },
      materials: { include: { material: true } },
      addOns: { where: { enabled: true }, orderBy: { name: "asc" } },
      machineRules: {
        include: {
          preferredMachine: {
            include: { inkChannels: true },
          },
        },
      },
      vendorProduct: {
        include: {
          tiers: { orderBy: { minQty: "asc" } },
          addOns: { where: { enabled: true }, orderBy: { name: "asc" } },
        },
      },
    },
  });

  if (!recipe) {
    return { ok: false, error: "Recipe not found." };
  }

  const selectedAddOnIds = parseIdList(payload.selectedAddOnIds);
  const productionMode = String(recipe.productionMode || "in_house");
  const estimate =
    productionMode === "outsourced" && recipe.vendorProduct
      ? calculateOutsourcedRecipe(recipe, quantity, selectedAddOnIds)
      : calculateInHouseRecipe(recipe, quantity, payload.selectedFinish || "base");

  const recipeTier = getBestRange(recipe.tiers || [], quantity);
  const marginPct = safeNumber(recipeTier?.marginPct, safeNumber(recipe.targetMarginPct, 40));
  const fixedPrice = recipeTier?.fixedPrice == null ? null : safeNumber(recipeTier.fixedPrice);
  const unitCost = estimate.costEach;
  const unitPrice = fixedPrice != null ? fixedPrice : unitCost / percentToDivisor(marginPct);
  const totalPrice = unitPrice * quantity;
  const profit = totalPrice - estimate.totalCost;
  const marginActual = totalPrice > 0 ? (profit / totalPrice) * 100 : 0;
  const minQuantity = safeNumber(recipe.minQuantity, 1);
  const warnings = [...estimate.warnings];

  if (quantity < minQuantity) {
    warnings.push(`Quantity is below this recipe minimum of ${minQuantity}.`);
  }

  const costSnapshot = {
    recipeId: recipe.id,
    recipeName: recipe.name,
    productionMode: recipe.productionMode,
    quantity,
    estimate,
    warnings,
  };

  const priceSnapshot = {
    tierLabel: rangeLabel(recipeTier),
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
      pricingSource: estimate.pricingSource,
      tierLabel: rangeLabel(recipeTier),
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

  return Response.json({
    quotes,
    recipes,
    productOptions: [],
    productCosts,
    pricingRules,
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
    const result = await priceRecipeLine(shop, payload);
    return Response.json({ intent: "priceRecipe", itemId: payload.itemId, ...result });
  }

  if (payload.intent === "delete") {
    await db.quote.deleteMany({ where: { id: payload.id, shop, status: { not: "paid" } } });
    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  if (payload.intent === "status") {
    await db.quote.updateMany({
      where: { id: payload.id, shop, status: { not: "paid" } },
      data: { status: payload.status },
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

      const lineItems = quote.items.map((item: any) => ({
        title: item.productName || "Custom print item",
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
      if (draftOrder?.id) {
        await sendDraftOrderInvoice(admin, draftOrder.id);
      }

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
      if (draftOrder?.id) {
        await sendDraftOrderInvoice(admin, draftOrder.id);
      }

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
      if (draftOrder?.id) {
        await sendDraftOrderInvoice(admin, draftOrder.id);
      }

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

  if (payload.intent === "save") {
    const quote = payload.quote as QuoteInput;

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState("draft");
  const [notes, setNotes] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [items, setItems] = useState<QuoteItemInput[]>([emptyItem()]);
  const [lastMessage, setLastMessage] = useState("");

  useEffect(() => {
    if (fetcher.data?.quotes) setQuotes(fetcher.data.quotes);
    if (fetcher.data?.recipes) setRecipes(fetcher.data.recipes);
    if (fetcher.data?.productOptions) setProductOptions(fetcher.data.productOptions);
    if (fetcher.data?.productCosts) setProductCosts(fetcher.data.productCosts);
    if (fetcher.data?.pricingRules) setPricingRules(fetcher.data.pricingRules);

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

              {lastMessage ? <Text as="p" tone="subdued">{lastMessage}</Text> : null}

              <InlineStack gap="300">
                <TextField label="Customer Name" value={customerName} onChange={setCustomerName} autoComplete="off" />
                <TextField label="Company" value={company} onChange={setCompany} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Email" value={email} onChange={setEmail} autoComplete="off" />
                <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
                <Select label="Status" value={status} onChange={setStatus} options={statuses} />
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
                            return (
                              <Card key={quote.id}>
                                <BlockStack gap="200">
                                  <Text as="p" fontWeight="bold">{quote.company || quote.customerName || "Unnamed Quote"}</Text>
                                  {isPaid ? <Badge tone="success">PAID - Quote locked</Badge> : null}
                                  <Text as="p" tone="subdued">${quoteRevenue.toFixed(2)} | {new Date(quote.updatedAt || quote.createdAt).toLocaleString()}</Text>
                                  <Select label="Move" value={quote.status} disabled={isPaid} onChange={(value) => updateQuoteStatus(quote.id, value)} options={statuses} />
                                  <InlineStack gap="200">
                                    <Button onClick={() => loadQuote(quote)}>Open</Button>
                                    {!isPaid && !quote.depositCreated && !quote.fullOrderCreated ? (
                                      <Button variant="primary" onClick={() => approveAndCreateOrder(quote.id)}>Approve & Create Order</Button>
                                    ) : null}
                                    {!isPaid && !quote.depositCreated && !quote.fullOrderCreated ? (
                                      <Button onClick={() => createDepositOrder(quote.id, 50)}>Create 50% Deposit</Button>
                                    ) : null}
                                    {!isPaid && quote.depositCreated && !quote.balanceCreated ? (
                                      <Button onClick={() => createBalanceOrder(quote.id, 50)}>Create Remaining Balance</Button>
                                    ) : null}
                                    {!isPaid ? <Button tone="critical" onClick={() => deleteQuote(quote.id)}>Delete</Button> : null}
                                    <Button onClick={() => window.open(`https://gso-wholesale-app-live.onrender.com/quote/${quote.id}`, "_blank", "noopener,noreferrer")}>Client Portal</Button>
                                    <Button
                                      onClick={() => {
                                        const url = `https://gso-wholesale-app-live.onrender.com/quote/${quote.id}`;
                                        navigator.clipboard.writeText(url);
                                        alert("Client portal link copied!");
                                      }}
                                    >
                                      Copy Portal Link
                                    </Button>
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
