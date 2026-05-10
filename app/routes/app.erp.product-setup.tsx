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
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type ProductTypeDefault = {
  name: string;
  productionMode: string;
  minQuantity: number;
  defaultQuantity: number;
  tiers: number[];
  defaultMarginPct: number;
  pricingMethod: string;
  defaultTags: string[];
};

const productTypeDefaults: Record<string, ProductTypeDefault> = {
  label: {
    name: "Labels",
    productionMode: "in_house",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 100, 250, 500, 1000, 2500, 5000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:labels", "gso:in-house", "gso:wholesale"],
  },
  dtp_bag: {
    name: "DTP Bags",
    productionMode: "in_house",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:dtp-bags", "gso:in-house", "gso:wholesale"],
  },
  stock_bag: {
    name: "Stock Bags",
    productionMode: "outsourced",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:stock-bags", "gso:outsourced", "gso:wholesale"],
  },
  box: {
    name: "Boxes",
    productionMode: "outsourced",
    minQuantity: 5,
    defaultQuantity: 5,
    tiers: [5, 10, 25, 50, 100, 250, 500],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:boxes", "gso:outsourced", "gso:wholesale"],
  },
  die_cut_bag: {
    name: "Die Cut Bags",
    productionMode: "hybrid",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:die-cut-bags", "gso:hybrid", "gso:wholesale"],
  },
  sourced_product: {
    name: "Sourced Products",
    productionMode: "outsourced",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100, 250, 500],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:sourced-products", "gso:outsourced", "gso:wholesale"],
  },
  general: {
    name: "General",
    productionMode: "in_house",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:general", "gso:wholesale"],
  },
};

const productionModeOptions = [
  { label: "In-house production", value: "in_house" },
  { label: "Outsourced / vendor produced", value: "outsourced" },
  { label: "Hybrid: vendor item + GSO finishing", value: "hybrid" },
];

const pricingMethodOptions = [
  { label: "Auto margin", value: "auto_margin" },
  { label: "Fixed unit price", value: "fixed_price" },
  { label: "Discount from first tier", value: "discount_from_first" },
  { label: "Markup over cost", value: "markup_over_cost" },
];

const emptyOption = { label: "None", value: "" };

function numberOrZero(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value: any, fallback = 1) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumberLines(value: any, fallback: number[] = [1]) {
  const parsed = String(value || "")
    .split(/[\n,]+/)
    .map((item) => positiveInt(item.trim(), 0))
    .filter((item) => item > 0);
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => a - b) : fallback;
}

function parseVendorCostTiers(value: any, fallbackQty: number, fallbackCost: number) {
  const parsed = String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        minQty: positiveInt(parts[0], fallbackQty),
        unitCost: numberOrZero(parts[1]),
        notes: parts.slice(2).join(" | ") || null,
      };
    })
    .filter((item) => item.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  if (parsed.length) return parsed;
  return [{ minQty: fallbackQty, unitCost: numberOrZero(fallbackCost), notes: null }];
}

function parseAddOns(value: any) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        name: parts[0] || "Add-on",
        pricingType: parts[1] || "per_unit",
        amount: numberOrZero(parts[2]),
        enabled: true,
        notes: parts.slice(3).join(" | ") || null,
      };
    })
    .filter((item) => item.name);
}

function marginPrice(cost: number, marginPct: number) {
  const margin = Math.min(Math.max(numberOrZero(marginPct), 0), 95);
  return cost / (1 - margin / 100);
}

function dollars(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function defaultRows(shop: string) {
  return Object.entries(productTypeDefaults).map(([key, defaults]) => ({
    shop,
    key,
    name: defaults.name,
    productionMode: defaults.productionMode,
    minQuantity: defaults.minQuantity,
    defaultQuantity: defaults.defaultQuantity,
    tierBreakpoints: defaults.tiers.join(", "),
    defaultMarginPct: defaults.defaultMarginPct,
    pricingMethod: defaults.pricingMethod,
    defaultTags: defaults.defaultTags.join(", "),
  }));
}

async function ensureProductTypeProfiles(shop: string) {
  const count = await db.productTypeProfile.count({ where: { shop } });
  if (count === 0) {
    await db.productTypeProfile.createMany({ data: defaultRows(shop) });
  }
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  await ensureProductTypeProfiles(shop);

  const [profiles, materials, machines, vendorProducts, recentRecipes] = await Promise.all([
    db.productTypeProfile.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.material.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.machine.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { tiers: { orderBy: { minQty: "asc" } }, addOns: { where: { enabled: true } } },
    }),
    db.productRecipe.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { productTypeProfile: true, vendorProduct: true, tiers: { orderBy: { minQty: "asc" } } },
    }),
  ]);

  return Response.json({ profiles, materials, machines, vendorProducts, recentRecipes });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent !== "quickCreateProduct") {
    return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  const productName = String(payload.productName || "").trim();
  if (!productName) {
    return Response.json({ ok: false, error: "Product name is required." }, { status: 400 });
  }

  const profile = await db.productTypeProfile.findFirst({ where: { id: payload.productTypeProfileId, shop } });
  if (!profile) {
    return Response.json({ ok: false, error: "Choose a product type." }, { status: 400 });
  }

  const productionMode = payload.productionMode || profile.productionMode || "in_house";
  const minQuantity = positiveInt(payload.minQuantity, profile.minQuantity || 1);
  const defaultQuantity = Math.max(minQuantity, positiveInt(payload.defaultQuantity, profile.defaultQuantity || minQuantity));
  const tiers = parseNumberLines(payload.tierBreakpoints, [minQuantity]).filter((qty) => qty >= minQuantity);
  const marginPct = numberOrZero(payload.targetMarginPct || profile.defaultMarginPct || 40);
  const pricingMethod = payload.pricingMethod || profile.pricingMethod || "auto_margin";

  let vendorProductId = payload.vendorProductId || null;

  await db.$transaction(async (tx) => {
    if ((productionMode === "outsourced" || productionMode === "hybrid") && !vendorProductId) {
      const vendorName = String(payload.vendorName || "").trim();
      const vendorProductName = String(payload.vendorProductName || productName).trim();
      const fallbackUnitCost = numberOrZero(payload.vendorFallbackUnitCost);
      const vendorTiers = parseVendorCostTiers(payload.vendorCostTiers, minQuantity, fallbackUnitCost);
      const addOns = parseAddOns(payload.vendorAddOns);

      const vendorProduct = await tx.vendorProduct.create({
        data: {
          shop,
          name: vendorProductName,
          productType: profile.key,
          vendor: vendorName || null,
          vendorSku: payload.vendorSku || null,
          moq: minQuantity,
          defaultUnitCost: fallbackUnitCost || vendorTiers[0]?.unitCost || 0,
          leadTimeDays: nullableNumber(payload.leadTimeDays) as any,
          notes: payload.vendorNotes || null,
          tiers: { create: vendorTiers.map((tier) => ({ shop, ...tier })) },
          addOns: { create: addOns.map((addOn) => ({ shop, ...addOn })) },
        },
      });

      vendorProductId = vendorProduct.id;
    }

    const recipe = await tx.productRecipe.create({
      data: {
        shop,
        productTypeProfileId: profile.id,
        name: productName,
        sku: payload.sku || null,
        productType: profile.key,
        productionMode,
        vendorProductId: vendorProductId || null,
        widthIn: nullableNumber(payload.widthIn),
        heightIn: nullableNumber(payload.heightIn),
        depthIn: nullableNumber(payload.depthIn),
        minQuantity,
        defaultQuantity,
        targetMarginPct: marginPct,
        wastePct: numberOrZero(payload.wastePct),
        baseCmykCoveragePct: numberOrZero(payload.baseCmykCoveragePct || 40),
        inkAllowancePct: numberOrZero(payload.inkAllowancePct || 15),
        maintenanceCostPerSqft: numberOrZero(payload.maintenanceCostPerSqft || 0.08),
        machineRecoveryCostPerSqft: numberOrZero(payload.machineRecoveryCostPerSqft || 0.05),
        operatorLaborPct: numberOrZero(payload.operatorLaborPct || 25),
        notes: [
          payload.notes || "",
          profile.defaultTags ? `Default Shopify tags to apply later: ${profile.defaultTags}` : "",
          `Pricing method: ${pricingMethod}`,
        ]
          .filter(Boolean)
          .join("\n"),
        tiers: {
          create: tiers.map((qty) => ({ shop, minQty: qty, marginPct })),
        },
      },
    });

    if (productionMode === "in_house" || productionMode === "hybrid") {
      const materialRows = [] as any[];
      if (payload.mediaMaterialId) {
        materialRows.push({
          shop,
          recipeId: recipe.id,
          materialId: payload.mediaMaterialId,
          usageType: "media",
          quantity: 1,
          unit: "sqft",
          wastePct: numberOrZero(payload.wastePct),
        });
      }
      if (payload.laminateMaterialId) {
        materialRows.push({
          shop,
          recipeId: recipe.id,
          materialId: payload.laminateMaterialId,
          usageType: "laminate",
          quantity: 1,
          unit: "sqft",
          wastePct: numberOrZero(payload.wastePct),
        });
      }
      if (materialRows.length) await tx.recipeMaterial.createMany({ data: materialRows });

      if (payload.machineId) {
        await tx.recipeMachineRule.create({
          data: {
            shop,
            recipeId: recipe.id,
            preferredMachineId: payload.machineId,
            requiredInkTypes: profile.key === "label" ? "cmyk,white,gloss" : "cmyk",
            allowOverflow: false,
          },
        });
      }
    }
  });

  return Response.json({ ok: true });
}

function profileDefaults(profile: any) {
  const fallback = productTypeDefaults[profile?.key] || productTypeDefaults.general;
  const minQuantity = positiveInt(profile?.minQuantity, fallback.minQuantity);
  return {
    productionMode: profile?.productionMode || fallback.productionMode,
    minQuantity,
    defaultQuantity: Math.max(minQuantity, positiveInt(profile?.defaultQuantity, fallback.defaultQuantity)),
    tiers: parseNumberLines(profile?.tierBreakpoints, fallback.tiers).filter((qty) => qty >= minQuantity),
    margin: numberOrZero(profile?.defaultMarginPct || fallback.defaultMarginPct),
    pricingMethod: profile?.pricingMethod || fallback.pricingMethod,
    tags: profile?.defaultTags || fallback.defaultTags.join(", "),
  };
}

function selectOptions(items: any[], labelKey = "name") {
  return [emptyOption, ...items.map((item) => ({ label: item[labelKey] || item.name || item.id, value: item.id }))];
}

function getBestVendorTier(vendorProduct: any, quantity: number) {
  const tiers = [...(vendorProduct?.tiers || [])].sort((a: any, b: any) => a.minQty - b.minQty);
  let best = tiers[0];
  for (const tier of tiers) {
    if (quantity >= tier.minQty) best = tier;
  }
  return best || { minQty: quantity, unitCost: numberOrZero(vendorProduct?.defaultUnitCost) };
}

export default function ProductSetupPage() {
  const { profiles, materials, machines, vendorProducts, recentRecipes } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [profileId, setProfileId] = useState(profiles?.[0]?.id || "");
  const selectedProfile = useMemo(() => profiles.find((profile: any) => profile.id === profileId), [profiles, profileId]);
  const defaults = useMemo(() => profileDefaults(selectedProfile), [selectedProfile]);

  const [productionMode, setProductionMode] = useState(defaults.productionMode);
  const [minQuantity, setMinQuantity] = useState(String(defaults.minQuantity));
  const [defaultQuantity, setDefaultQuantity] = useState(String(defaults.defaultQuantity));
  const [tierBreakpoints, setTierBreakpoints] = useState(defaults.tiers.join(", "));
  const [targetMarginPct, setTargetMarginPct] = useState(String(defaults.margin));
  const [pricingMethod, setPricingMethod] = useState(defaults.pricingMethod);

  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [depthIn, setDepthIn] = useState("");
  const [mediaMaterialId, setMediaMaterialId] = useState("");
  const [laminateMaterialId, setLaminateMaterialId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [wastePct, setWastePct] = useState("10");

  const [vendorProductId, setVendorProductId] = useState("");
  const [vendorProductName, setVendorProductName] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorFallbackUnitCost, setVendorFallbackUnitCost] = useState("");
  const [vendorCostTiers, setVendorCostTiers] = useState("");
  const [vendorAddOns, setVendorAddOns] = useState("Gloss finish | per_unit | 0.08\nSetup fee | flat_fee | 75\nFreight | flat_fee | 120");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setProductionMode(defaults.productionMode);
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierBreakpoints(defaults.tiers.join(", "));
    setTargetMarginPct(String(defaults.margin));
    setPricingMethod(defaults.pricingMethod);
  }, [profileId]);

  useEffect(() => {
    if (fetcher.data?.ok) {
      setProductName("");
      setSku("");
      setVendorProductName("");
      setVendorName("");
      setVendorSku("");
      setVendorFallbackUnitCost("");
      setVendorCostTiers("");
      setNotes("");
    }
  }, [fetcher.data]);

  const quantity = positiveInt(defaultQuantity, defaults.defaultQuantity);
  const tierList = parseNumberLines(tierBreakpoints, defaults.tiers);
  const selectedVendorProduct = vendorProducts.find((item: any) => item.id === vendorProductId);
  const bestVendorTier = getBestVendorTier(selectedVendorProduct, quantity);
  const vendorPreviewCost = selectedVendorProduct ? numberOrZero(bestVendorTier.unitCost) : numberOrZero(vendorFallbackUnitCost);
  const estimatedPrice = marginPrice(vendorPreviewCost, numberOrZero(targetMarginPct));

  const profileOptions = profiles.map((profile: any) => ({ label: profile.name, value: profile.id }));
  const materialOptions = selectOptions(materials);
  const machineOptions = selectOptions(machines);
  const vendorOptions = selectOptions(vendorProducts);
  const isOutsourced = productionMode === "outsourced";
  const isInHouse = productionMode === "in_house";
  const isHybrid = productionMode === "hybrid";

  function submit() {
    fetcher.submit(
      {
        intent: "quickCreateProduct",
        productName,
        sku,
        productTypeProfileId: profileId,
        productionMode,
        minQuantity,
        defaultQuantity,
        tierBreakpoints,
        targetMarginPct,
        pricingMethod,
        widthIn,
        heightIn,
        depthIn,
        mediaMaterialId,
        laminateMaterialId,
        machineId,
        wastePct,
        vendorProductId,
        vendorProductName: vendorProductName || productName,
        vendorName,
        vendorSku,
        vendorFallbackUnitCost,
        vendorCostTiers,
        vendorAddOns,
        leadTimeDays,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  return (
    <Page
      title="Product Setup"
      subtitle="One simple workflow that creates recipes, vendor costs, tiers, and product rules behind the scenes."
      primaryAction={{ content: "Go to Recipes", onAction: () => navigate("/app/erp/recipes") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Create pricing-ready product</Text>
                  <Text as="p" tone="subdued">
                    Employees should start here. Advanced sections stay available, but this flow builds the records for them.
                  </Text>
                </BlockStack>
                <Badge tone="success">Recommended workflow</Badge>
              </InlineStack>

              {fetcher.data?.error ? <Text as="p" tone="critical">{fetcher.data.error}</Text> : null}
              {fetcher.data?.ok ? <Text as="p" tone="success">Saved. The recipe and needed backend records were created.</Text> : null}

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Step 1: Product basics</Text>
                <TextField label="Product name" value={productName} onChange={setProductName} autoComplete="off" />
                <TextField label="SKU optional" value={sku} onChange={setSku} autoComplete="off" />
                <Select label="Product type" options={profileOptions} value={profileId} onChange={setProfileId} />
                <Select label="Production method" options={productionModeOptions} value={productionMode} onChange={setProductionMode} />
                <InlineStack gap="200">
                  <Badge>{selectedProfile?.name || "Product type"}</Badge>
                  <Badge>{productionModeOptions.find((item) => item.value === productionMode)?.label}</Badge>
                </InlineStack>
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Step 2: Quantity and pricing rules</Text>
                <InlineStack gap="300" wrap>
                  <div style={{ minWidth: 160, flex: 1 }}>
                    <TextField label="Minimum quantity" type="number" value={minQuantity} onChange={setMinQuantity} autoComplete="off" />
                  </div>
                  <div style={{ minWidth: 160, flex: 1 }}>
                    <TextField label="Default quote quantity" type="number" value={defaultQuantity} onChange={setDefaultQuantity} autoComplete="off" />
                  </div>
                  <div style={{ minWidth: 160, flex: 1 }}>
                    <TextField label="Target margin %" type="number" value={targetMarginPct} onChange={setTargetMarginPct} autoComplete="off" />
                  </div>
                </InlineStack>
                <TextField
                  label="Tier breakpoints"
                  value={tierBreakpoints}
                  onChange={setTierBreakpoints}
                  autoComplete="off"
                  helpText="Comma-separated. Lowest tier becomes the highest/max unit price."
                />
                <Select label="Pricing method" options={pricingMethodOptions} value={pricingMethod} onChange={setPricingMethod} />
                <InlineStack gap="200">
                  {tierList.slice(0, 8).map((qty) => <Badge key={qty}>{qty}</Badge>)}
                </InlineStack>
              </BlockStack>

              <Divider />

              {(isInHouse || isHybrid) ? (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Step 3: In-house production inputs</Text>
                  <InlineStack gap="300" wrap>
                    <div style={{ minWidth: 150, flex: 1 }}>
                      <TextField label="Width inches" type="number" value={widthIn} onChange={setWidthIn} autoComplete="off" />
                    </div>
                    <div style={{ minWidth: 150, flex: 1 }}>
                      <TextField label="Height inches" type="number" value={heightIn} onChange={setHeightIn} autoComplete="off" />
                    </div>
                    <div style={{ minWidth: 150, flex: 1 }}>
                      <TextField label="Depth/gusset optional" type="number" value={depthIn} onChange={setDepthIn} autoComplete="off" />
                    </div>
                    <div style={{ minWidth: 150, flex: 1 }}>
                      <TextField label="Waste %" type="number" value={wastePct} onChange={setWastePct} autoComplete="off" />
                    </div>
                  </InlineStack>
                  <Select label="Media material" options={materialOptions} value={mediaMaterialId} onChange={setMediaMaterialId} />
                  <Select label="Laminate optional" options={materialOptions} value={laminateMaterialId} onChange={setLaminateMaterialId} />
                  <Select label="Preferred machine" options={machineOptions} value={machineId} onChange={setMachineId} />
                </BlockStack>
              ) : null}

              {(isOutsourced || isHybrid) ? (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Step 3: Vendor / outsourced inputs</Text>
                  <Select
                    label="Use existing vendor product optional"
                    options={vendorOptions}
                    value={vendorProductId}
                    onChange={setVendorProductId}
                    helpText="Leave blank to create one automatically from the fields below."
                  />
                  {!vendorProductId ? (
                    <BlockStack gap="300">
                      <TextField label="Vendor product name" value={vendorProductName} onChange={setVendorProductName} autoComplete="off" />
                      <InlineStack gap="300" wrap>
                        <div style={{ minWidth: 180, flex: 1 }}>
                          <TextField label="Vendor" value={vendorName} onChange={setVendorName} autoComplete="off" />
                        </div>
                        <div style={{ minWidth: 180, flex: 1 }}>
                          <TextField label="Vendor SKU" value={vendorSku} onChange={setVendorSku} autoComplete="off" />
                        </div>
                        <div style={{ minWidth: 180, flex: 1 }}>
                          <TextField label="Fallback unit cost" type="number" value={vendorFallbackUnitCost} onChange={setVendorFallbackUnitCost} autoComplete="off" />
                        </div>
                        <div style={{ minWidth: 180, flex: 1 }}>
                          <TextField label="Lead time days" type="number" value={leadTimeDays} onChange={setLeadTimeDays} autoComplete="off" />
                        </div>
                      </InlineStack>
                      <TextField
                        label="Vendor cost tiers"
                        value={vendorCostTiers}
                        onChange={setVendorCostTiers}
                        multiline={5}
                        autoComplete="off"
                        helpText="One per line: quantity | unit cost. Example: 100 | 0.42"
                      />
                      <TextField
                        label="Vendor add-ons"
                        value={vendorAddOns}
                        onChange={setVendorAddOns}
                        multiline={5}
                        autoComplete="off"
                        helpText="One per line: name | per_unit/flat_fee/percent/included | amount"
                      />
                    </BlockStack>
                  ) : null}
                </BlockStack>
              ) : null}

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Step 4: Save</Text>
                <TextField label="Internal notes optional" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />
                <Button variant="primary" loading={fetcher.state !== "idle"} onClick={submit}>
                  Save product setup
                </Button>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">What this creates</Text>
              <Text as="p">Product Recipe</Text>
              {(isOutsourced || isHybrid) && !vendorProductId ? <Text as="p">Vendor Product + vendor tiers/add-ons</Text> : null}
              {(isInHouse || isHybrid) ? <Text as="p">Recipe materials + machine rule when selected</Text> : null}
              <Text as="p">Recipe tiers from the product type profile</Text>
              <Divider />
              <Text as="h3" variant="headingSm">Default Shopify tags later</Text>
              <Text as="p" tone="subdued">{defaults.tags}</Text>
              <Text as="p" tone="subdued">The next Shopify picker patch will apply these tags automatically after a product is selected.</Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Quick price preview</Text>
              {(isOutsourced || isHybrid) ? (
                <BlockStack gap="100">
                  <Text as="p">Quantity: {quantity}</Text>
                  <Text as="p">Estimated vendor cost each: {money(vendorPreviewCost)}</Text>
                  <Text as="p">Suggested price each: {money(estimatedPrice)}</Text>
                  <Text as="p">Suggested total: {dollars(estimatedPrice * quantity)}</Text>
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">In-house labels and print jobs get their detailed pricing table in Recipes after setup.</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recent recipes</Text>
              {recentRecipes.length ? recentRecipes.map((recipe: any) => (
                <BlockStack key={recipe.id} gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" fontWeight="semibold">{recipe.name}</Text>
                    <Badge>{recipe.active ? "Active" : "Archived"}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">{recipe.productTypeProfile?.name || recipe.productType} · Min {recipe.minQuantity}</Text>
                  <Divider />
                </BlockStack>
              )) : <Text as="p" tone="subdued">No recipes yet.</Text>}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
