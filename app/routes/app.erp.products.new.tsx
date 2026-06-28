import {
  Badge,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { Form, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const FAMILIES = [
  { label: "Stock Bags", value: "stock-bags" },
  { label: "Jars", value: "jars" },
  { label: "Labels", value: "labels" },
  { label: "Boxes", value: "boxes" },
  { label: "DTP Pouches", value: "dtp-pouches" },
  { label: "Apparel", value: "apparel" },
  { label: "Other", value: "other" },
];

const PRICING_MODES = [
  { label: "Storefront configurator", value: "storefront-configurator" },
  { label: "ERP recipe", value: "erp-recipe" },
  { label: "Wholesale display", value: "wholesale-display" },
  { label: "Unknown", value: "unknown" },
];

const COST_SOURCES = [
  { label: "Materials + machines", value: "materials-machines" },
  { label: "Vendor cost", value: "vendor-cost" },
  { label: "Vendor cost book", value: "vendor-cost-book" },
  { label: "Outsourced", value: "outsourced" },
  { label: "Unknown", value: "unknown" },
];

function clean(value: string | null, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function parseNumber(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeChoice(value: string, allowed: { value: string }[], fallback: string) {
  return allowed.some((item) => item.value === value) ? value : fallback;
}

function normalizeGid(value: string) {
  const text = value.trim();
  if (text.startsWith("gid://shopify/")) return text;
  const digitsOnly = text.replace(/[^0-9]/g, "");
  return digitsOnly ? `gid://shopify/Product/${digitsOnly}` : "";
}

function familyLabel(value: string) {
  return FAMILIES.find((family) => family.value === value)?.label || "Other";
}

function parseTiers(value: string) {
  return value
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .sort((a, b) => a - b);
}

function isStorefrontFamily(family: string) {
  return family === "stock-bags" || family === "jars";
}

function recommendedAuthority(family: string, pricingMode: string) {
  if (isStorefrontFamily(family) && pricingMode === "storefront-configurator") {
    return {
      label: "ConfiguratorProduct + ConfiguratorOption + ConfiguratorPricingRule",
      reason: "Stock bag and jar storefront pricing is controlled by configurator records before checkout.",
    };
  }

  if (pricingMode === "erp-recipe" || ["labels", "boxes", "dtp-pouches", "apparel"].includes(family)) {
    return {
      label: "ProductRecipe + RecipeTier + cost inputs",
      reason: "ERP/quote products use recipe tiers, materials, vendor costs, and margin review.",
    };
  }

  if (pricingMode === "wholesale-display") {
    return {
      label: "WholesaleRule / ShopSettings",
      reason: "Wholesale display rules are separate from configurator and recipe pricing.",
    };
  }

  return {
    label: "Choose pricing mode to determine authority",
    reason: "Select storefront configurator, ERP recipe, or wholesale display before creating records.",
  };
}

function statusForPlan(params: any, duplicateCount: number, warnings: string[]) {
  if (!params.title && !params.productType && !params.sku) return "Needs identity";
  if (duplicateCount > 0) return "Duplicate risk";
  if (params.pricingMode === "unknown") return "Needs pricing mode";
  if (params.costSource === "unknown") return "Needs cost source";
  if (warnings.length) return "Ready to plan";
  return "Ready for manual setup";
}

function statusTone(status: string) {
  if (status === "Ready for manual setup") return "success";
  if (status === "Ready to plan") return "attention";
  return "warning";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <Text as="span" tone="subdued">{label}</Text>
      {children}
    </label>
  );
}

function inputStyle() {
  return { minHeight: 36, padding: "6px 10px", border: "1px solid #8c9196", borderRadius: 4 };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const params = {
    family: safeChoice(clean(url.searchParams.get("family"), "stock-bags"), FAMILIES, "stock-bags"),
    title: clean(url.searchParams.get("title")),
    productType: clean(url.searchParams.get("productType")),
    sku: clean(url.searchParams.get("sku")),
    shopifyHandle: clean(url.searchParams.get("shopifyHandle")),
    moq: clean(url.searchParams.get("moq")),
    pricingMode: safeChoice(clean(url.searchParams.get("pricingMode"), "unknown"), PRICING_MODES, "unknown"),
    costSource: safeChoice(clean(url.searchParams.get("costSource"), "unknown"), COST_SOURCES, "unknown"),
    targetMargin: clean(url.searchParams.get("targetMargin")),
    markup: clean(url.searchParams.get("markup")),
    tiers: clean(url.searchParams.get("tiers")),
  };

  const shopifyProductGid = normalizeGid(params.shopifyHandle);
  const tiers = parseTiers(params.tiers);
  const hasInput = Boolean(params.title || params.productType || params.sku || params.shopifyHandle);

  const profileOr: any[] = [];
  if (params.productType) profileOr.push({ key: params.productType });
  if (params.title) profileOr.push({ name: { equals: params.title, mode: "insensitive" } });

  const recipeOr: any[] = [];
  if (params.title) recipeOr.push({ name: { equals: params.title, mode: "insensitive" } });
  if (params.productType) recipeOr.push({ productType: params.productType });
  if (params.sku) recipeOr.push({ sku: params.sku });

  const configuratorOr: any[] = [];
  if (params.title) configuratorOr.push({ title: { equals: params.title, mode: "insensitive" } });
  if (params.productType) configuratorOr.push({ productType: params.productType });
  if (params.shopifyHandle) configuratorOr.push({ shopifyHandle: params.shopifyHandle });
  if (shopifyProductGid) configuratorOr.push({ shopifyProductGid });

  const variantRuleOr: any[] = [];
  if (params.sku) variantRuleOr.push({ sku: params.sku });
  if (shopifyProductGid) variantRuleOr.push({ shopifyProductGid });

  const [profiles, recipes, configuratorProducts, variantRules] = await Promise.all([
    profileOr.length
      ? db.productTypeProfile.findMany({
          where: { shop, OR: profileOr },
          select: { id: true, key: true, name: true, active: true },
          take: 10,
        })
      : Promise.resolve([]),
    recipeOr.length
      ? db.productRecipe.findMany({
          where: { shop, OR: recipeOr },
          select: { id: true, name: true, sku: true, productType: true, productFamily: true, active: true },
          take: 10,
        })
      : Promise.resolve([]),
    configuratorOr.length
      ? db.configuratorProduct.findMany({
          where: { shop, OR: configuratorOr },
          select: { id: true, title: true, productType: true, shopifyHandle: true, shopifyProductGid: true, active: true },
          take: 10,
        })
      : Promise.resolve([]),
    variantRuleOr.length
      ? db.recipeVariantRule.findMany({
          where: { shop, OR: variantRuleOr },
          select: { id: true, name: true, sku: true, shopifyProductGid: true, shopifyVariantGid: true, active: true },
          take: 10,
        })
      : Promise.resolve([]),
  ]);

  const authority = recommendedAuthority(params.family, params.pricingMode);
  const isStorefront = params.pricingMode === "storefront-configurator";
  const warnings = [
    params.costSource === "unknown" ? "Select a cost source before creating pricing." : null,
    !params.targetMargin && !params.markup ? "Add target margin or markup before setting sell prices." : null,
    !tiers.length ? "Add quantity tiers before building tiered pricing." : null,
    !parseNumber(params.moq) ? "Add MOQ/default quantity." : null,
    isStorefront && !params.shopifyHandle ? "Storefront products need a Shopify handle or Product GID before launch." : null,
  ].filter(Boolean);

  const duplicateCount = profiles.length + recipes.length + configuratorProducts.length + variantRules.length;
  const status = statusForPlan(params, duplicateCount, warnings);

  return Response.json({
    shop,
    params,
    hasInput,
    tiers,
    authority,
    warnings,
    status,
    duplicates: {
      profiles,
      recipes,
      configuratorProducts,
      variantRules,
      checked: {
        productTypeProfile: profileOr.length > 0,
        productRecipe: recipeOr.length > 0,
        configuratorProduct: configuratorOr.length > 0,
        recipeVariantRule: variantRuleOr.length > 0,
      },
    },
  });
}

function LinkButtons({ links }: { links: { label: string; url: string }[] }) {
  const navigate = useNavigate();
  return (
    <InlineStack gap="200" wrap>
      {links.map((link) => (
        <Button key={link.url} onClick={() => navigate(link.url)}>{link.label}</Button>
      ))}
    </InlineStack>
  );
}

function DuplicateList({ title, rows, render }: { title: string; rows: any[]; render: (row: any) => string }) {
  return (
    <BlockStack gap="100">
      <Text as="h3" variant="headingSm">{title}</Text>
      {rows.length ? (
        <BlockStack gap="050">
          {rows.map((row) => <Text as="p" key={row.id}>{render(row)}</Text>)}
        </BlockStack>
      ) : (
        <Text as="p" tone="subdued">No matches found.</Text>
      )}
    </BlockStack>
  );
}

export default function ProductBuilderPlan() {
  const data = useLoaderData<typeof loader>();
  const { params } = data;
  const isStorefront = data.params.pricingMode === "storefront-configurator";
  const requiredRecords = isStorefront
    ? [
        "ProductTypeProfile if a new product type is needed",
        "ConfiguratorProduct",
        "ConfiguratorOption",
        "ConfiguratorPricingRule",
        "Shopify product handle/GID mapping",
        "Storefront test",
        "Production test",
      ]
    : [
        "ProductTypeProfile",
        "ProductRecipe",
        "RecipeTier",
        "RecipeMaterial or vendor cost source",
        "RecipeVariantRule / Shopify Link if mapped",
        "Margin review",
        "Production test",
      ];

  const links = [
    { label: "Product Setup", url: "/app/erp/product-setup" },
    { label: "Configurator", url: "/app/erp/configurator" },
    { label: "Manual Mapping", url: "/app/erp/configurator-mapping" },
    { label: "Jar Mapping", url: "/app/erp/configurator-jar-mapping" },
    { label: "Shopify Links", url: "/app/erp/shopify-links" },
    { label: "Materials", url: "/app/erp/materials" },
    { label: "Vendors", url: "/app/erp/vendors" },
    { label: "Pricing Health", url: "/app/erp/pricing-health" },
    { label: "Margin Review", url: "/app/erp/margin-review" },
  ];

  return (
    <Page title="Product Builder" subtitle="Add New Product Plan">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                This page is read-only. It creates a setup plan and duplicate checks before any ERP or Shopify records are created.
              </Text>
              <InlineStack gap="200" wrap>
                <Badge tone="success">No writes</Badge>
                <Badge tone="success">No Shopify Admin calls</Badge>
                <Badge tone={statusTone(data.status) as any}>{data.status}</Badge>
                <Badge>Shop: {data.shop}</Badge>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Plan Inputs</Text>
              <Form method="get">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                  <Field label="Product family">
                    <select name="family" defaultValue={params.family} style={inputStyle()}>
                      {FAMILIES.map((family) => <option key={family.value} value={family.value}>{family.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Product title">
                    <input name="title" defaultValue={params.title} placeholder="3oz Black Jar Labels" style={inputStyle()} />
                  </Field>
                  <Field label="Product type key">
                    <input name="productType" defaultValue={params.productType} placeholder="jar_3oz_black_white" style={inputStyle()} />
                  </Field>
                  <Field label="SKU">
                    <input name="sku" defaultValue={params.sku} placeholder="JAR-3OZ-BW-LABEL" style={inputStyle()} />
                  </Field>
                  <Field label="Shopify handle/GID">
                    <input name="shopifyHandle" defaultValue={params.shopifyHandle} placeholder="shopify-handle or gid://shopify/Product/..." style={inputStyle()} />
                  </Field>
                  <Field label="MOQ / default quantity">
                    <input name="moq" type="number" min="1" defaultValue={params.moq} placeholder="128" style={inputStyle()} />
                  </Field>
                  <Field label="Pricing mode">
                    <select name="pricingMode" defaultValue={params.pricingMode} style={inputStyle()}>
                      {PRICING_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Cost source">
                    <select name="costSource" defaultValue={params.costSource} style={inputStyle()}>
                      {COST_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Target margin %">
                    <input name="targetMargin" type="number" step="0.01" defaultValue={params.targetMargin} placeholder="40" style={inputStyle()} />
                  </Field>
                  <Field label="Markup %">
                    <input name="markup" type="number" step="0.01" defaultValue={params.markup} placeholder="80" style={inputStyle()} />
                  </Field>
                  <Field label="Quantity tiers">
                    <input name="tiers" defaultValue={params.tiers} placeholder="64,128,256,640,1280" style={inputStyle()} />
                  </Field>
                  <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
                    <Button submit variant="primary">Preview Plan</Button>
                    <Button url="/app/erp/products/new">Clear</Button>
                  </div>
                </div>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Product Identity</Text>
                <Badge tone={data.duplicates.profiles.length || data.duplicates.recipes.length || data.duplicates.configuratorProducts.length || data.duplicates.variantRules.length ? "warning" : "success"}>
                  {data.hasInput ? "Duplicate check complete" : "Enter identity to check"}
                </Badge>
              </InlineStack>
              <Text as="p"><strong>Title:</strong> {params.title || "Not entered"}</Text>
              <Text as="p"><strong>Product type key:</strong> {params.productType || "Not entered"}</Text>
              <Text as="p"><strong>SKU:</strong> {params.sku || "Not entered"}</Text>
              <Text as="p"><strong>Family:</strong> {familyLabel(params.family)}</Text>
              <Divider />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
                <DuplicateList title="ProductTypeProfile" rows={data.duplicates.profiles} render={(row) => `${row.key} - ${row.name} (${row.active ? "active" : "inactive"})`} />
                <DuplicateList title="ProductRecipe" rows={data.duplicates.recipes} render={(row) => `${row.name} / ${row.productType} / ${row.sku || "no SKU"} (${row.active ? "active" : "inactive"})`} />
                <DuplicateList title="ConfiguratorProduct" rows={data.duplicates.configuratorProducts} render={(row) => `${row.title} / ${row.productType} / ${row.shopifyHandle || row.shopifyProductGid || "no Shopify mapping"} (${row.active ? "active" : "inactive"})`} />
                <DuplicateList title="RecipeVariantRule" rows={data.duplicates.variantRules} render={(row) => `${row.name} / ${row.sku || "no SKU"} / ${row.shopifyProductGid || "no Product GID"} (${row.active ? "active" : "inactive"})`} />
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Pricing Authority</Text>
              <Badge tone={params.pricingMode === "unknown" ? "warning" : "success"}>{params.pricingMode === "unknown" ? "Needs pricing mode" : "Ready to plan"}</Badge>
              <Text as="p"><strong>{data.authority.label}</strong></Text>
              <Text as="p" tone="subdued">{data.authority.reason}</Text>
              <Button url="/app/erp/pricing-health">Open Pricing Health</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Required Records Checklist</Text>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {requiredRecords.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <Text as="p" tone="subdued">This planner does not create these records. Use the linked tools after reviewing duplicates and cost assumptions.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Cost And Margin Plan</Text>
              <InlineStack gap="200" wrap>
                <Badge>Cost source: {params.costSource}</Badge>
                <Badge>Target margin: {params.targetMargin || "Not set"}</Badge>
                <Badge>Markup: {params.markup || "Not set"}</Badge>
                <Badge>MOQ: {params.moq || "Not set"}</Badge>
              </InlineStack>
              <Text as="p"><strong>Quantity tiers:</strong> {data.tiers.length ? data.tiers.join(", ") : "None parsed"}</Text>
              {data.warnings.length ? (
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">Warnings</Text>
                  {data.warnings.map((warning: string) => <Badge key={warning} tone="warning">{warning}</Badge>)}
                </BlockStack>
              ) : (
                <Badge tone="success">No planning warnings</Badge>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Fix / Action Links</Text>
              <LinkButtons links={links} />
              <Divider />
              <Text as="p" tone="subdued">Next version can create ERP recipe drafts after this plan is reviewed.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
