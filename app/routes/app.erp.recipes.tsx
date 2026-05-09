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

const productTypeDefaults: Record<
  string,
  {
    label: string;
    minQuantity: number;
    defaultQuantity: number;
    tiers: number[];
    targetMarginPct: number;
  }
> = {
  label: {
    label: "Labels",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 100, 250, 500, 1000, 2500, 5000],
    targetMarginPct: 50,
  },
  box: {
    label: "Boxes",
    minQuantity: 5,
    defaultQuantity: 5,
    tiers: [5, 10, 25, 50, 100, 250, 500],
    targetMarginPct: 50,
  },
  dtp_bag: {
    label: "DTP Bags",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000],
    targetMarginPct: 45,
  },
  die_cut_bag: {
    label: "Die Cut Bags",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2500, 5000, 10000],
    targetMarginPct: 45,
  },
  sourced_product: {
    label: "Sourced Products",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100, 250, 500],
    targetMarginPct: 40,
  },
  general: {
    label: "General",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100],
    targetMarginPct: 40,
  },
};

const productTypes = Object.entries(productTypeDefaults).map(([value, config]) => ({
  label: config.label,
  value,
}));

const statusOptions = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

const emptyOption = { label: "None", value: "" };

function defaultForProductType(productType: string) {
  return productTypeDefaults[productType] || productTypeDefaults.general;
}

function numberOrZero(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function nullableNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function positiveInt(value: any, fallback: number) {
  const numberValue = Math.round(Number(value));
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function parseTierBreakpoints(value: any) {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  }

  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeTierBreakpoints(value: any, minQuantity: number) {
  const unique = new Set<number>([minQuantity]);
  for (const qty of parseTierBreakpoints(value)) {
    if (qty >= minQuantity) unique.add(Math.round(qty));
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(4)}`;
}

function percent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value.toFixed(2)}%`;
}

function materialUnitCost(material: any) {
  return numberOrZero(material?.calculatedUnitCost || material?.costPerUnit);
}

function machineInkCost(machine: any, inkType: string, totalSqft: number, coveragePercent: number) {
  if (!machine || !coveragePercent || coveragePercent <= 0) return 0;

  const channels = (machine.inkChannels || []).filter(
    (channel: any) => channel.enabled !== false && channel.inkType === inkType,
  );

  return channels.reduce((sum: number, channel: any) => {
    const costPerMl = numberOrZero(channel.costPerMl);
    const mlPerSqft1Pct = numberOrZero(channel.mlPerSqft1Pct || channel.mlPerSqft100 / 100);
    return sum + totalSqft * coveragePercent * mlPerSqft1Pct * costPerMl;
  }, 0);
}

function calcLabelRecipe(input: any) {
  const widthIn = numberOrZero(input.widthIn);
  const heightIn = numberOrZero(input.heightIn);
  const minQuantity = positiveInt(input.minQuantity, 1);
  const quantity = Math.max(minQuantity, positiveInt(input.quantity, minQuantity));
  const wastePct = numberOrZero(input.wastePct);
  const targetMarginPct = numberOrZero(input.targetMarginPct);
  const setupCost = numberOrZero(input.setupCost);
  const laborMinutes = numberOrZero(input.laborMinutes);
  const laborRate = numberOrZero(input.laborRate || 25);
  const media = input.mediaMaterial;
  const laminate = input.laminateMaterial;
  const machine = input.machine;

  const sqinPerLabel = widthIn * heightIn;
  const sqftPerLabel = sqinPerLabel / 144;
  const totalSqftBeforeWaste = sqftPerLabel * quantity;
  const wasteMultiplier = 1 + wastePct / 100;
  const totalSqft = totalSqftBeforeWaste * wasteMultiplier;

  const mediaCost = totalSqft * materialUnitCost(media);
  const laminateCost = laminate ? totalSqft * materialUnitCost(laminate) : 0;

  const cmykInkCost = machineInkCost(machine, "cmyk", totalSqft, numberOrZero(input.cmykCoveragePct));
  const whiteInkCost = machineInkCost(machine, "white", totalSqft, numberOrZero(input.whiteCoveragePct));
  const glossInkCost = machineInkCost(machine, "gloss", totalSqft, numberOrZero(input.glossCoveragePct));
  const inkCost = cmykInkCost + whiteInkCost + glossInkCost;

  const sqftPerHour = numberOrZero(machine?.sqftPerHour);
  const machineCostPerHour = numberOrZero(machine?.costPerHour);
  const machineHours = sqftPerHour > 0 ? totalSqft / sqftPerHour : 0;
  const machineCost = machineHours * machineCostPerHour;

  const laborCost = (laborMinutes / 60) * laborRate;
  const totalCost = mediaCost + laminateCost + inkCost + machineCost + laborCost + setupCost;
  const unitCost = quantity > 0 ? totalCost / quantity : 0;
  const marginDecimal = Math.min(0.95, Math.max(0, targetMarginPct / 100));
  const recommendedUnitPrice = marginDecimal >= 0.95 ? unitCost : unitCost / (1 - marginDecimal);
  const totalSellPrice = recommendedUnitPrice * quantity;
  const grossProfit = totalSellPrice - totalCost;
  const actualMarginPct = totalSellPrice > 0 ? (grossProfit / totalSellPrice) * 100 : 0;

  return {
    quantity,
    sqinPerLabel,
    sqftPerLabel,
    totalSqftBeforeWaste,
    totalSqft,
    mediaCost,
    laminateCost,
    cmykInkCost,
    whiteInkCost,
    glossInkCost,
    inkCost,
    machineHours,
    machineCost,
    laborCost,
    setupCost,
    totalCost,
    unitCost,
    recommendedUnitPrice,
    totalSellPrice,
    grossProfit,
    actualMarginPct,
  };
}


const SHOPIFY_METAFIELD_NAMESPACE = "gso_erp";

function normalizeShopifyGid(value?: string, ownerType: "Product" | "ProductVariant" = "Product") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("gid://shopify/")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/${ownerType}/${trimmed}`;
  return trimmed;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        owner {
          __typename
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function pushRecipeQuantityRulesToShopify({
  admin,
  recipe,
  tierBreakpoints,
}: {
  admin: any;
  recipe: any;
  tierBreakpoints: number[];
}) {
  const productOwnerId = normalizeShopifyGid(recipe.shopifyProductId, "Product");
  const variantOwnerId = normalizeShopifyGid(recipe.shopifyVariantId, "ProductVariant");
  const ownerIds = [productOwnerId, variantOwnerId].filter(Boolean) as string[];

  if (ownerIds.length === 0) {
    throw new Error("Add a Shopify Product ID or Variant ID before syncing quantity rules.");
  }

  const metafields = ownerIds.flatMap((ownerId) => [
    {
      ownerId,
      namespace: SHOPIFY_METAFIELD_NAMESPACE,
      key: "min_quantity",
      type: "number_integer",
      value: String(recipe.minQuantity || 1),
    },
    {
      ownerId,
      namespace: SHOPIFY_METAFIELD_NAMESPACE,
      key: "default_quantity",
      type: "number_integer",
      value: String(recipe.defaultQuantity || recipe.minQuantity || 1),
    },
    {
      ownerId,
      namespace: SHOPIFY_METAFIELD_NAMESPACE,
      key: "quantity_tiers",
      type: "json",
      value: JSON.stringify(tierBreakpoints),
    },
    {
      ownerId,
      namespace: SHOPIFY_METAFIELD_NAMESPACE,
      key: "recipe_id",
      type: "single_line_text_field",
      value: recipe.id,
    },
  ]);

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: { metafields },
  });
  const result = await response.json();
  const graphqlErrors = result.errors || [];
  const userErrors = result.data?.metafieldsSet?.userErrors || [];

  if (graphqlErrors.length || userErrors.length) {
    const messages = [
      ...graphqlErrors.map((error: any) => error.message),
      ...userErrors.map((error: any) => error.message),
    ].filter(Boolean);
    throw new Error(messages.join("; ") || "Shopify metafield sync failed.");
  }

  return result.data?.metafieldsSet?.metafields || [];
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [recipes, materials, machines] = await Promise.all([
    db.productRecipe.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        materials: { include: { material: true } },
        inkRequirements: true,
        machineRules: { include: { preferredMachine: { include: { inkChannels: true } } } },
        tiers: { orderBy: { minQty: "asc" } },
      },
    }),
    db.material.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
    }),
    db.machine.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
    }),
  ]);

  return Response.json({ recipes, materials, machines });
}

export async function action({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveRecipe") {
    const productType = payload.productType || "label";
    const productDefault = defaultForProductType(productType);
    const minQuantity = positiveInt(payload.minQuantity, productDefault.minQuantity);
    const defaultQuantity = Math.max(minQuantity, positiveInt(payload.defaultQuantity, productDefault.defaultQuantity));
    const tierBreakpoints = normalizeTierBreakpoints(payload.tierBreakpoints, minQuantity);

    const data = {
      shop,
      name: payload.name || "Untitled recipe",
      sku: payload.sku || null,
      productType,
      shopifyProductId: normalizeShopifyGid(payload.shopifyProductId, "Product"),
      shopifyVariantId: normalizeShopifyGid(payload.shopifyVariantId, "ProductVariant"),
      shopifySyncEnabled: Boolean(payload.shopifySyncEnabled),
      widthIn: nullableNumber(payload.widthIn),
      heightIn: nullableNumber(payload.heightIn),
      minQuantity,
      defaultQuantity,
      targetMarginPct: numberOrZero(payload.targetMarginPct || productDefault.targetMarginPct),
      wastePct: numberOrZero(payload.wastePct),
      setupCost: numberOrZero(payload.setupCost),
      laborMinutes: numberOrZero(payload.laborMinutes),
      notes: payload.notes || null,
      active: true,
    };

    const recipe = await db.$transaction(async (tx) => {
      let savedRecipe;

      if (payload.id) {
        savedRecipe = await tx.productRecipe.update({
          where: { id: payload.id },
          data,
        });

        await tx.recipeTier.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeMachineRule.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeInkRequirement.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeMaterial.deleteMany({ where: { recipeId: payload.id, shop } });
      } else {
        savedRecipe = await tx.productRecipe.create({ data });
      }

      if (payload.mediaMaterialId) {
        await tx.recipeMaterial.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            materialId: payload.mediaMaterialId,
            usageType: "media",
            quantity: 1,
            unit: "sqft",
            includeWaste: true,
          },
        });
      }

      if (payload.laminateMaterialId) {
        await tx.recipeMaterial.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            materialId: payload.laminateMaterialId,
            usageType: "laminate",
            quantity: 1,
            unit: "sqft",
            includeWaste: true,
          },
        });
      }

      const inkRequirements = [
        { inkType: "cmyk", coveragePercent: numberOrZero(payload.cmykCoveragePct), required: numberOrZero(payload.cmykCoveragePct) > 0 },
        { inkType: "white", coveragePercent: numberOrZero(payload.whiteCoveragePct), required: numberOrZero(payload.whiteCoveragePct) > 0 },
        { inkType: "gloss", coveragePercent: numberOrZero(payload.glossCoveragePct), required: numberOrZero(payload.glossCoveragePct) > 0 },
      ];

      for (const ink of inkRequirements) {
        await tx.recipeInkRequirement.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            ...ink,
          },
        });
      }

      if (payload.machineId) {
        const requiredInkTypes = inkRequirements
          .filter((ink) => ink.required)
          .map((ink) => ink.inkType)
          .join(",");

        await tx.recipeMachineRule.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            preferredMachineId: payload.machineId,
            requiredInkTypes,
            allowOverflow: Boolean(payload.allowOverflow),
          },
        });
      }

      for (const minQty of tierBreakpoints) {
        await tx.recipeTier.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            minQty,
            marginPct: numberOrZero(payload.targetMarginPct || productDefault.targetMarginPct),
          },
        });
      }

      return savedRecipe;
    });

    let shopifySyncError = null;

    if (data.shopifySyncEnabled) {
      try {
        await pushRecipeQuantityRulesToShopify({
          admin,
          recipe,
          tierBreakpoints,
        });

        await db.productRecipe.update({
          where: { id: recipe.id },
          data: {
            lastShopifySyncAt: new Date(),
            shopifySyncError: null,
          },
        });
      } catch (error: any) {
        shopifySyncError = error?.message || "Shopify metafield sync failed.";
        await db.productRecipe.update({
          where: { id: recipe.id },
          data: { shopifySyncError },
        });
      }
    } else {
      await db.productRecipe.update({
        where: { id: recipe.id },
        data: { shopifySyncError: null },
      });
    }

    return Response.json({ ok: true, recipe, shopifySyncError });
  }

  if (payload.intent === "archiveRecipe") {
    await db.productRecipe.update({
      where: { id: payload.id },
      data: { active: false },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "restoreRecipe") {
    await db.productRecipe.update({
      where: { id: payload.id },
      data: { active: true },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "deleteRecipe") {
    await db.productRecipe.delete({ where: { id: payload.id } });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false });
}

export default function RecipesPage() {
  const { recipes, materials, machines } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const labelDefaults = defaultForProductType("label");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState("active");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [shopifyProductId, setShopifyProductId] = useState("");
  const [shopifyVariantId, setShopifyVariantId] = useState("");
  const [shopifySyncEnabled, setShopifySyncEnabled] = useState(false);
  const [productType, setProductType] = useState("label");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [minQuantity, setMinQuantity] = useState(String(labelDefaults.minQuantity));
  const [defaultQuantity, setDefaultQuantity] = useState(String(labelDefaults.defaultQuantity));
  const [tierBreakpoints, setTierBreakpoints] = useState(labelDefaults.tiers.join(", "));
  const [mediaMaterialId, setMediaMaterialId] = useState("");
  const [laminateMaterialId, setLaminateMaterialId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [cmykCoveragePct, setCmykCoveragePct] = useState("40");
  const [whiteCoveragePct, setWhiteCoveragePct] = useState("0");
  const [glossCoveragePct, setGlossCoveragePct] = useState("0");
  const [wastePct, setWastePct] = useState("10");
  const [setupCost, setSetupCost] = useState("0");
  const [laborMinutes, setLaborMinutes] = useState("0");
  const [laborRate, setLaborRate] = useState("25");
  const [targetMarginPct, setTargetMarginPct] = useState(String(labelDefaults.targetMarginPct));
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (fetcher.data?.ok) {
      resetForm();
      navigate(".");
    }
  }, [fetcher.data, navigate]);

  const materialOptions = [
    emptyOption,
    ...materials.map((material: any) => ({
      label: `${material.name} - ${money(materialUnitCost(material))}/${material.baseUnit || material.unit || "each"}`,
      value: material.id,
    })),
  ];

  const machineOptions = [
    emptyOption,
    ...machines.map((machine: any) => ({ label: machine.name, value: machine.id })),
  ];

  const mediaMaterial = materials.find((material: any) => material.id === mediaMaterialId);
  const laminateMaterial = materials.find((material: any) => material.id === laminateMaterialId);
  const selectedMachine = machines.find((machine: any) => machine.id === machineId);
  const normalizedMinQuantity = positiveInt(minQuantity, defaultForProductType(productType).minQuantity);
  const normalizedDefaultQuantity = Math.max(
    normalizedMinQuantity,
    positiveInt(defaultQuantity, defaultForProductType(productType).defaultQuantity),
  );
  const normalizedTiers = normalizeTierBreakpoints(tierBreakpoints, normalizedMinQuantity);

  const calculation = useMemo(
    () =>
      calcLabelRecipe({
        widthIn,
        heightIn,
        minQuantity: normalizedMinQuantity,
        quantity: normalizedDefaultQuantity,
        wastePct,
        targetMarginPct,
        setupCost,
        laborMinutes,
        laborRate,
        mediaMaterial,
        laminateMaterial,
        machine: selectedMachine,
        cmykCoveragePct,
        whiteCoveragePct,
        glossCoveragePct,
      }),
    [
      widthIn,
      heightIn,
      normalizedMinQuantity,
      normalizedDefaultQuantity,
      wastePct,
      targetMarginPct,
      setupCost,
      laborMinutes,
      laborRate,
      mediaMaterial,
      laminateMaterial,
      selectedMachine,
      cmykCoveragePct,
      whiteCoveragePct,
      glossCoveragePct,
    ],
  );

  const filteredRecipes = recipes.filter((recipe: any) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "archived") return recipe.active === false;
    return recipe.active !== false;
  });

  function applyProductTypeDefaults(value: string) {
    const defaults = defaultForProductType(value);
    setProductType(value);
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierBreakpoints(defaults.tiers.join(", "));
    setTargetMarginPct(String(defaults.targetMarginPct));
  }

  function resetForm() {
    const defaults = defaultForProductType("label");
    setEditingId(null);
    setName("");
    setSku("");
    setShopifyProductId("");
    setShopifyVariantId("");
    setShopifySyncEnabled(false);
    setProductType("label");
    setWidthIn("");
    setHeightIn("");
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierBreakpoints(defaults.tiers.join(", "));
    setMediaMaterialId("");
    setLaminateMaterialId("");
    setMachineId("");
    setCmykCoveragePct("40");
    setWhiteCoveragePct("0");
    setGlossCoveragePct("0");
    setWastePct("10");
    setSetupCost("0");
    setLaborMinutes("0");
    setLaborRate("25");
    setTargetMarginPct(String(defaults.targetMarginPct));
    setNotes("");
  }

  function saveRecipe() {
    fetcher.submit(
      {
        intent: "saveRecipe",
        id: editingId,
        name,
        sku,
        shopifyProductId,
        shopifyVariantId,
        shopifySyncEnabled,
        productType,
        widthIn,
        heightIn,
        minQuantity: normalizedMinQuantity,
        defaultQuantity: normalizedDefaultQuantity,
        tierBreakpoints: normalizedTiers.join(","),
        mediaMaterialId,
        laminateMaterialId,
        machineId,
        cmykCoveragePct,
        whiteCoveragePct,
        glossCoveragePct,
        wastePct,
        setupCost,
        laborMinutes,
        targetMarginPct,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  function editRecipe(recipe: any) {
    const media = recipe.materials?.find((item: any) => item.usageType === "media");
    const laminate = recipe.materials?.find((item: any) => item.usageType === "laminate");
    const machineRule = recipe.machineRules?.[0];
    const cmyk = recipe.inkRequirements?.find((item: any) => item.inkType === "cmyk");
    const white = recipe.inkRequirements?.find((item: any) => item.inkType === "white");
    const gloss = recipe.inkRequirements?.find((item: any) => item.inkType === "gloss");
    const defaults = defaultForProductType(recipe.productType || "label");

    setEditingId(recipe.id);
    setName(recipe.name || "");
    setSku(recipe.sku || "");
    setShopifyProductId(recipe.shopifyProductId || "");
    setShopifyVariantId(recipe.shopifyVariantId || "");
    setShopifySyncEnabled(Boolean(recipe.shopifySyncEnabled));
    setProductType(recipe.productType || "label");
    setWidthIn(recipe.widthIn !== null && recipe.widthIn !== undefined ? String(recipe.widthIn) : "");
    setHeightIn(recipe.heightIn !== null && recipe.heightIn !== undefined ? String(recipe.heightIn) : "");
    setMinQuantity(recipe.minQuantity ? String(recipe.minQuantity) : String(defaults.minQuantity));
    setDefaultQuantity(recipe.defaultQuantity ? String(recipe.defaultQuantity) : String(defaults.defaultQuantity));
    setTierBreakpoints(recipe.tiers?.length ? recipe.tiers.map((tier: any) => tier.minQty).join(", ") : defaults.tiers.join(", "));
    setMediaMaterialId(media?.materialId || "");
    setLaminateMaterialId(laminate?.materialId || "");
    setMachineId(machineRule?.preferredMachineId || "");
    setCmykCoveragePct(cmyk ? String(cmyk.coveragePercent) : "0");
    setWhiteCoveragePct(white ? String(white.coveragePercent) : "0");
    setGlossCoveragePct(gloss ? String(gloss.coveragePercent) : "0");
    setWastePct(recipe.wastePct !== null && recipe.wastePct !== undefined ? String(recipe.wastePct) : "0");
    setSetupCost(recipe.setupCost !== null && recipe.setupCost !== undefined ? String(recipe.setupCost) : "0");
    setLaborMinutes(recipe.laborMinutes !== null && recipe.laborMinutes !== undefined ? String(recipe.laborMinutes) : "0");
    setTargetMarginPct(recipe.targetMarginPct !== null && recipe.targetMarginPct !== undefined ? String(recipe.targetMarginPct) : String(defaults.targetMarginPct));
    setNotes(recipe.notes || "");
  }

  function archiveRecipe(id: string) {
    fetcher.submit({ intent: "archiveRecipe", id }, { method: "post", encType: "application/json" });
  }

  function restoreRecipe(id: string) {
    fetcher.submit({ intent: "restoreRecipe", id }, { method: "post", encType: "application/json" });
  }

  function deleteRecipe(id: string) {
    if (!window.confirm("Permanently delete this recipe? This cannot be undone.")) return;
    fetcher.submit({ intent: "deleteRecipe", id }, { method: "post", encType: "application/json" });
  }

  return (
    <Page title="Product Recipes" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Recipe Calculator
                  </Text>
                  <Text as="p" tone="subdued">
                    Pick a product type to auto-load the right minimum quantity and tier breakpoints. Label recipes also calculate area, media, laminate, ink, machine time, labor, waste, and margin.
                  </Text>
                </BlockStack>
                {editingId ? <Badge tone="info">Editing</Badge> : <Badge>New recipe</Badge>}
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 2 }}>
                  <TextField label="Recipe Name" value={name} onChange={setName} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="SKU" value={sku} onChange={setSku} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <Select label="Product Type" options={productTypes} value={productType} onChange={applyProductTypeDefaults} />
                </div>
              </InlineStack>

              <Card background="bg-surface-secondary">
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">
                        Shopify quantity sync
                      </Text>
                      <Text as="p" tone="subdued">
                        The ERP recipe stays the source of truth. When enabled, saving this recipe pushes the minimum quantity, default quantity, and tier breakpoints to Shopify metafields.
                      </Text>
                    </BlockStack>
                    <Checkbox
                      label="Sync to Shopify"
                      checked={shopifySyncEnabled}
                      onChange={setShopifySyncEnabled}
                    />
                  </InlineStack>

                  <InlineStack gap="300" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Shopify Product ID / GID"
                        value={shopifyProductId}
                        onChange={setShopifyProductId}
                        helpText="Use a Shopify Product GID if available, or paste the numeric product ID."
                        autoComplete="off"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Shopify Variant ID / GID Optional"
                        value={shopifyVariantId}
                        onChange={setShopifyVariantId}
                        helpText="Optional. If entered, the same quantity rules are also pushed to the variant."
                        autoComplete="off"
                      />
                    </div>
                  </InlineStack>

                  <Text as="p" tone="subdued">
                    Shopify metafields: gso_erp.min_quantity, gso_erp.default_quantity, gso_erp.quantity_tiers, and gso_erp.recipe_id.
                  </Text>
                </BlockStack>
              </Card>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Minimum Quantity" value={minQuantity} onChange={setMinQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Default Quote Quantity" value={defaultQuantity} onChange={setDefaultQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 2 }}>
                  <TextField
                    label="Pricing Tiers / Breakpoints"
                    value={tierBreakpoints}
                    onChange={setTierBreakpoints}
                    helpText="Comma-separated. The minimum quantity is always included automatically."
                    autoComplete="off"
                  />
                </div>
              </InlineStack>

              {fetcher.data?.shopifySyncError && (
                <Card>
                  <Text as="p" tone="critical">
                    Recipe saved, but Shopify sync failed: {fetcher.data.shopifySyncError}
                  </Text>
                </Card>
              )}

              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Product quantity rules
                  </Text>
                  <InlineStack gap="400">
                    <Text as="p">Minimum: {normalizedMinQuantity}</Text>
                    <Text as="p">Default quote qty: {normalizedDefaultQuantity}</Text>
                    <Text as="p">Tiers: {normalizedTiers.join(", ")}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Width In" value={widthIn} onChange={setWidthIn} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Height In" value={heightIn} onChange={setHeightIn} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Select label="Media Material" options={materialOptions} value={mediaMaterialId} onChange={setMediaMaterialId} />
                </div>
                <div style={{ flex: 1 }}>
                  <Select label="Laminate Optional" options={materialOptions} value={laminateMaterialId} onChange={setLaminateMaterialId} />
                </div>
              </InlineStack>

              <Select label="Preferred Machine" options={machineOptions} value={machineId} onChange={setMachineId} />

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="CMYK Coverage %" value={cmykCoveragePct} onChange={setCmykCoveragePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="White Coverage %" value={whiteCoveragePct} onChange={setWhiteCoveragePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Gloss Coverage %" value={glossCoveragePct} onChange={setGlossCoveragePct} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Waste %" value={wastePct} onChange={setWastePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Setup Cost" value={setupCost} onChange={setSetupCost} type="number" prefix="$" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Labor Minutes" value={laborMinutes} onChange={setLaborMinutes} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Labor Rate / Hr" value={laborRate} onChange={setLaborRate} type="number" prefix="$" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Target Margin %" value={targetMarginPct} onChange={setTargetMarginPct} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Live Cost Preview
                  </Text>
                  <InlineStack gap="500">
                    <Text as="p">Qty used: {calculation.quantity}</Text>
                    <Text as="p">Sq In / Label: {calculation.sqinPerLabel.toFixed(4)}</Text>
                    <Text as="p">Sq Ft / Label: {calculation.sqftPerLabel.toFixed(6)}</Text>
                    <Text as="p">Total Sq Ft w/ Waste: {calculation.totalSqft.toFixed(4)}</Text>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="500">
                    <Text as="p">Media: {money(calculation.mediaCost)}</Text>
                    <Text as="p">Laminate: {money(calculation.laminateCost)}</Text>
                    <Text as="p">Ink: {money(calculation.inkCost)}</Text>
                    <Text as="p">Machine: {money(calculation.machineCost)}</Text>
                    <Text as="p">Labor: {money(calculation.laborCost)}</Text>
                    <Text as="p">Setup: {money(calculation.setupCost)}</Text>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="500">
                    <Text as="p" fontWeight="bold">Total Cost: {money(calculation.totalCost)}</Text>
                    <Text as="p" fontWeight="bold">Unit Cost: {money(calculation.unitCost)}</Text>
                    <Text as="p" fontWeight="bold">Recommended Unit Price: {money(calculation.recommendedUnitPrice)}</Text>
                    <Text as="p" fontWeight="bold">Margin: {percent(calculation.actualMarginPct)}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <InlineStack gap="200">
                <Button variant="primary" onClick={saveRecipe} disabled={!name || !mediaMaterialId}>
                  {editingId ? "Update Recipe" : "Save Recipe"}
                </Button>
                <Button onClick={resetForm}>Clear</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Recipes</Text>
                <Select label="Status" labelHidden options={statusOptions} value={activeFilter} onChange={setActiveFilter} />
              </InlineStack>

              {filteredRecipes.length === 0 ? (
                <Text as="p" tone="subdued">No recipes yet.</Text>
              ) : (
                filteredRecipes.map((recipe: any) => {
                  const media = recipe.materials?.find((item: any) => item.usageType === "media")?.material;
                  const machine = recipe.machineRules?.[0]?.preferredMachine;
                  const recipeTiers = recipe.tiers?.map((tier: any) => tier.minQty).join(", ") || "No tiers";

                  return (
                    <Card key={recipe.id} background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">{recipe.name}</Text>
                            <Text as="p" tone="subdued">
                              {productTypeDefaults[recipe.productType]?.label || recipe.productType || "Recipe"} • Min {recipe.minQuantity || 1} • Default Qty {recipe.defaultQuantity || 1}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="100">
                            <Badge>{productTypeDefaults[recipe.productType]?.label || recipe.productType || "recipe"}</Badge>
                            {recipe.shopifySyncEnabled && !recipe.shopifySyncError && recipe.lastShopifySyncAt && <Badge tone="success">SHOPIFY SYNCED</Badge>}
                            {recipe.shopifySyncEnabled && recipe.shopifySyncError && <Badge tone="critical">SYNC ERROR</Badge>}
                            {recipe.shopifySyncEnabled && !recipe.lastShopifySyncAt && !recipe.shopifySyncError && <Badge tone="warning">SYNC PENDING</Badge>}
                            {recipe.active === false && <Badge tone="warning">ARCHIVED</Badge>}
                          </InlineStack>
                        </InlineStack>
                        <Text as="p">Size: {recipe.widthIn || 0} in x {recipe.heightIn || 0} in</Text>
                        <Text as="p">Tiers: {recipeTiers}</Text>
                        {recipe.shopifyProductId && <Text as="p">Shopify Product: {recipe.shopifyProductId}</Text>}
                        {recipe.shopifyVariantId && <Text as="p">Shopify Variant: {recipe.shopifyVariantId}</Text>}
                        {recipe.lastShopifySyncAt && <Text as="p">Last Shopify Sync: {new Date(recipe.lastShopifySyncAt).toLocaleString()}</Text>}
                        {recipe.shopifySyncError && <Text as="p" tone="critical">Shopify Sync Error: {recipe.shopifySyncError}</Text>}
                        <Text as="p">Media: {media?.name || "Not selected"}</Text>
                        <Text as="p">Machine: {machine?.name || "Not selected"}</Text>
                        <Text as="p">Waste: {recipe.wastePct || 0}% • Target Margin: {recipe.targetMarginPct || 0}%</Text>
                        <InlineStack gap="200">
                          <Button onClick={() => editRecipe(recipe)}>Edit</Button>
                          {recipe.active === false ? (
                            <>
                              <Button onClick={() => restoreRecipe(recipe.id)}>Restore</Button>
                              <Button tone="critical" onClick={() => deleteRecipe(recipe.id)}>Delete Forever</Button>
                            </>
                          ) : (
                            <Button tone="critical" onClick={() => archiveRecipe(recipe.id)}>Archive</Button>
                          )}
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  );
                })
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
