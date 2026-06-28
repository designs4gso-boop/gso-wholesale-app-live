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
import { useRef } from "react";
import { Form, useLoaderData, useNavigate, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type Health = "Healthy" | "Missing pricing" | "Missing costs" | "Missing mapping" | "Needs review" | "Partial";
type HealthFilter = "all" | "healthy" | "missing-pricing" | "missing-costs" | "missing-mapping" | "partial";
type FamilyFilter = "all" | "jars" | "stock-bags" | "other";

function pct(value: any) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function healthTone(health: Health) {
  if (health === "Healthy") return "success";
  if (health === "Partial") return "attention";
  return "warning";
}

function healthFromFilter(filter: HealthFilter): Health | null {
  if (filter === "healthy") return "Healthy";
  if (filter === "missing-pricing") return "Missing pricing";
  if (filter === "missing-costs") return "Missing costs";
  if (filter === "missing-mapping") return "Missing mapping";
  if (filter === "partial") return "Partial";
  return null;
}

function familyForProductType(productType: string) {
  if (productType.startsWith("jar_")) return "Jars";
  if (productType.startsWith("stock_bag")) return "Stock Bags";
  return "Configurator";
}

function matchesFamily(row: any, family: FamilyFilter) {
  const productType = String(row.productType || "").toLowerCase();
  const productFamily = String(row.productFamily || "").toLowerCase();
  const isJar = productType.includes("jar") || productFamily.includes("jar");
  const isStockBag = productType.includes("stock_bag") || productFamily.includes("stock bag");

  if (family === "jars") return isJar;
  if (family === "stock-bags") return isStockBag;
  if (family === "other") return !isJar && !isStockBag;
  return true;
}

function safeHealthFilter(value: string | null): HealthFilter {
  if (["healthy", "missing-pricing", "missing-costs", "missing-mapping", "partial"].includes(value || "")) {
    return value as HealthFilter;
  }
  return "all";
}

function safeFamilyFilter(value: string | null): FamilyFilter {
  if (["jars", "stock-bags", "other"].includes(value || "")) return value as FamilyFilter;
  return "all";
}

function authorityForRecipe(recipe: any) {
  if (recipe.productionMode === "outsourced" || recipe.costMethod?.startsWith("sourced")) {
    return "VendorProduct / vendor tiers";
  }
  return "ProductRecipe / RecipeTier";
}

function configHealth(product: any, optionCount: number, rules: any[]): Health {
  const mapped = Boolean(product.shopifyProductGid || product.shopifyHandle);
  if (!rules.length) return "Missing pricing";
  if (!rules.some((rule) => Number(rule.costEach || 0) > 0)) return "Missing costs";
  if (!mapped) return "Missing mapping";
  if (!optionCount || !rules.some((rule) => Number(rule.priceEach || 0) > 0 && Number(rule.costEach || 0) > 0)) return "Partial";
  return "Healthy";
}

function recipeHasVendorCost(recipe: any) {
  const vendorProduct = recipe.vendorProduct;
  return Boolean(
    vendorProduct &&
      (Number(vendorProduct.defaultUnitCost || 0) > 0 ||
        (vendorProduct.tiers || []).some((tier: any) => Number(tier.unitCost || 0) > 0)),
  );
}

function recipeHealth(recipe: any): Health {
  const count = recipe._count || {};
  const hasPricingBasis = count.tiers > 0 || Number(recipe.defaultSellPrice || 0) > 0 || Number(recipe.targetMarginPct || 0) > 0;
  const hasCostSource = count.materials > 0 || count.sourcedTiers > 0 || recipeHasVendorCost(recipe);
  const hasMapping = Boolean(
    count.variantRules > 0 ||
      recipe.productGid ||
      recipe.variantGid ||
      recipe.shopifyProductId ||
      recipe.shopifyVariantId ||
      recipe.shopifyVariantIds,
  );

  if (recipe.costReviewNeeded) return "Needs review";
  if (!hasCostSource) return "Missing costs";
  if (!hasMapping) return "Missing mapping";
  if (recipe.active && hasPricingBasis && hasCostSource) return "Healthy";
  return "Partial";
}

function averageConfiguratorMargin(rules: any[]) {
  const priced = rules
    .filter((rule) => Number(rule.priceEach || 0) > 0 && Number(rule.costEach || 0) > 0)
    .sort((a, b) => Number(a.minQty || 0) - Number(b.minQty || 0));
  const first = priced[0];
  if (!first) return null;
  const price = Number(first.priceEach || 0);
  const cost = Number(first.costEach || 0);
  return ((price - cost) / price) * 100;
}

function minRuleQty(rules: any[], fallback: number) {
  const values = rules.map((rule) => Number(rule.minQty || 0)).filter((qty) => qty > 0);
  return values.length ? Math.min(...values) : fallback;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const filters = {
    q: (url.searchParams.get("q") || "").trim(),
    health: safeHealthFilter(url.searchParams.get("health")),
    family: safeFamilyFilter(url.searchParams.get("family")),
  };

  const [
    allConfiguratorProducts,
    activeRecipes,
    configuratorPricingRuleCount,
    pricingRuleCount,
    wholesaleRuleCount,
    recipesNeedingCostReview,
    productionJobCount,
    jobsWithActualCosts,
  ] = await Promise.all([
    db.configuratorProduct.findMany({
      where: { shop, active: true },
      select: {
        id: true,
        title: true,
        productType: true,
        shopifyProductGid: true,
        shopifyHandle: true,
        minQuantity: true,
        active: true,
      },
      orderBy: [{ productType: "asc" }, { title: "asc" }],
    }),
    db.productRecipe.findMany({
      where: { shop, active: true },
      select: {
        id: true,
        name: true,
        productType: true,
        productFamily: true,
        productionMode: true,
        costMethod: true,
        defaultSellPrice: true,
        targetMarginPct: true,
        costReviewNeeded: true,
        productGid: true,
        variantGid: true,
        shopifyProductId: true,
        shopifyVariantId: true,
        shopifyVariantIds: true,
        active: true,
        vendorProduct: {
          select: {
            id: true,
            name: true,
            defaultUnitCost: true,
            tiers: { select: { id: true, unitCost: true }, take: 5 },
          },
        },
        _count: {
          select: {
            tiers: true,
            materials: true,
            variantRules: true,
            sourcedTiers: true,
          },
        },
      },
      orderBy: [{ productFamily: "asc" }, { name: "asc" }],
      take: 100,
    }),
    db.configuratorPricingRule.count({ where: { shop, active: true } }),
    db.pricingRule.count({ where: { shop, active: true } }),
    db.wholesaleRule.count({ where: { shop, active: true } }),
    db.productRecipe.count({ where: { shop, active: true, costReviewNeeded: true } }),
    db.productionJob.count({ where: { shop, active: true } }),
    db.productionJob.count({ where: { shop, active: true, actualTotalCost: { gt: 0 } } }),
  ]);

  const productTypes = Array.from(new Set(allConfiguratorProducts.map((product) => product.productType).filter(Boolean)));
  const [pricingRules, options] = productTypes.length
    ? await Promise.all([
        db.configuratorPricingRule.findMany({
          where: { shop, active: true, productType: { in: productTypes } },
          select: { id: true, productType: true, minQty: true, priceEach: true, costEach: true },
          orderBy: [{ productType: "asc" }, { minQty: "asc" }],
        }),
        db.configuratorOption.findMany({
          where: { shop, active: true, productType: { in: productTypes } },
          select: { id: true, productType: true },
        }),
      ])
    : [[], []];

  const rulesByType = new Map<string, any[]>();
  for (const rule of pricingRules) {
    const rows = rulesByType.get(rule.productType) || [];
    rows.push(rule);
    rulesByType.set(rule.productType, rows);
  }

  const optionsByType = new Map<string, number>();
  for (const option of options) {
    optionsByType.set(option.productType, (optionsByType.get(option.productType) || 0) + 1);
  }

  const allConfiguratorRows = allConfiguratorProducts.map((product) => {
    const rules = rulesByType.get(product.productType) || [];
    const optionCount = optionsByType.get(product.productType) || 0;
    return {
      id: product.id,
      title: product.title,
      productType: product.productType,
      productFamily: familyForProductType(product.productType),
      mappingLabel: product.shopifyProductGid ? "Product GID" : product.shopifyHandle ? "Handle" : "Missing",
      optionCount,
      pricingRuleCount: rules.length,
      minQuantity: minRuleQty(rules, Number(product.minQuantity || 0)),
      costSource: rules.some((rule) => Number(rule.costEach || 0) > 0) ? "Rule costEach" : "Missing costEach",
      estimatedMargin: averageConfiguratorMargin(rules),
      health: configHealth(product, optionCount, rules),
    };
  });
  const selectedHealth = healthFromFilter(filters.health);
  const q = filters.q.toLowerCase();
  const filteredConfiguratorRows = allConfiguratorRows.filter((row) => {
    const matchesSearch =
      !q ||
      row.title.toLowerCase().includes(q) ||
      row.productType.toLowerCase().includes(q) ||
      row.productFamily.toLowerCase().includes(q);
    return matchesSearch && matchesFamily(row, filters.family) && (!selectedHealth || row.health === selectedHealth);
  });
  const configuratorRows = filteredConfiguratorRows.slice(0, 100);

  const missingConfiguratorPricing = allConfiguratorProducts.filter((product) => !(rulesByType.get(product.productType) || []).length).length;
  const recipeRows = activeRecipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    productType: recipe.productType,
    productFamily: recipe.productFamily,
    authority: authorityForRecipe(recipe),
    tierCount: recipe._count.tiers,
    materialCount: recipe._count.materials,
    variantRuleCount: recipe._count.variantRules,
    sourcedTierCount: recipe._count.sourcedTiers,
    costReviewNeeded: recipe.costReviewNeeded,
    vendorCostSource: recipeHasVendorCost(recipe) ? "Vendor cost" : recipe.vendorProduct ? "Vendor missing cost" : "None",
    health: recipeHealth(recipe),
  }));

  const summary = {
    activeConfiguratorProducts: allConfiguratorProducts.length,
    missingConfiguratorPricing,
    activeProductRecipes: activeRecipes.length,
    recipesNeedingCostReview,
    pricingRules: pricingRuleCount,
    wholesaleRules: wholesaleRuleCount,
    configuratorPricingRules: configuratorPricingRuleCount,
    productionJobCount,
    jobsWithActualCosts,
  };

  return Response.json({
    shop,
    summary,
    filters,
    totalConfiguratorRows: allConfiguratorRows.length,
    filteredConfiguratorRows: filteredConfiguratorRows.length,
    configuratorRows,
    recipeRows,
  });
}

function SummaryCard({ label, value, help }: { label: string; value: string | number; help: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        <Text as="p" tone="subdued">{help}</Text>
      </BlockStack>
    </Card>
  );
}

function FixLinks({ links }: { links: { label: string; url: string }[] }) {
  const navigate = useNavigate();
  return (
    <InlineStack gap="100" wrap>
      {links.map((link) => (
        <Button key={link.url} size="slim" onClick={() => navigate(link.url)}>
          {link.label}
        </Button>
      ))}
    </InlineStack>
  );
}

function FilterLink({ label, params }: { label: string; params: Record<string, string> }) {
  const navigate = useNavigate();
  return (
    <Button size="slim" onClick={() => navigate(`/app/erp/pricing-health?${new URLSearchParams(params).toString()}`)}>
      {label}
    </Button>
  );
}

function ConfiguratorFilters({ filters }: { filters: { q: string; health: HealthFilter; family: FamilyFilter } }) {
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function submitFilters() {
    if (formRef.current) submit(formRef.current, { method: "get" });
  }

  function debounceSearch() {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(submitFilters, 500);
  }

  return (
    <Form method="get" ref={formRef}>
      <BlockStack gap="300">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 2fr) minmax(180px, 1fr) minmax(180px, 1fr) auto", gap: 12, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <Text as="span" tone="subdued">Search</Text>
            <input
              name="q"
              defaultValue={filters.q}
              onChange={debounceSearch}
              placeholder="Title, product type, or family"
              style={{ minHeight: 36, padding: "6px 10px", border: "1px solid #8c9196", borderRadius: 4 }}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <Text as="span" tone="subdued">Health</Text>
            <select name="health" defaultValue={filters.health} onChange={submitFilters} style={{ minHeight: 36, padding: "6px 10px", border: "1px solid #8c9196", borderRadius: 4 }}>
              <option value="all">All</option>
              <option value="healthy">Healthy</option>
              <option value="missing-pricing">Missing pricing</option>
              <option value="missing-costs">Missing costs</option>
              <option value="missing-mapping">Missing mapping</option>
              <option value="partial">Partial</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <Text as="span" tone="subdued">Family</Text>
            <select name="family" defaultValue={filters.family} onChange={submitFilters} style={{ minHeight: 36, padding: "6px 10px", border: "1px solid #8c9196", borderRadius: 4 }}>
              <option value="all">All</option>
              <option value="jars">Jars</option>
              <option value="stock-bags">Stock Bags</option>
              <option value="other">Other</option>
            </select>
          </label>
          <Button url="/app/erp/pricing-health">Clear Filters</Button>
        </div>
        <InlineStack gap="100" wrap>
          <FilterLink label="All" params={{ health: "all", family: "all" }} />
          <FilterLink label="Healthy" params={{ health: "healthy", family: "all" }} />
          <FilterLink label="Needs Review" params={{ health: "partial", family: "all" }} />
          <FilterLink label="Jars" params={{ health: "all", family: "jars" }} />
          <FilterLink label="Stock Bags" params={{ health: "all", family: "stock-bags" }} />
        </InlineStack>
      </BlockStack>
    </Form>
  );
}

const cellStyle = { padding: 10, borderBottom: "1px solid #e5e7eb", verticalAlign: "top" as const };
const headerStyle = { ...cellStyle, background: "#f6f6f7", fontWeight: 700 };
const productCellStyle = { ...cellStyle, minWidth: 260 };
const actionCellStyle = { ...cellStyle, minWidth: 230 };

export default function PricingHealth() {
  const data = useLoaderData<typeof loader>();
  const summary = data.summary;
  const filtered = data.filteredConfiguratorRows !== data.totalConfiguratorRows || data.filters.q;

  const configuratorFixLinks = [
    { label: "Configurator", url: "/app/erp/configurator" },
    { label: "Manual Mapping", url: "/app/erp/configurator-mapping" },
    { label: "Jar Mapping", url: "/app/erp/configurator-jar-mapping" },
    { label: "Shopify Links", url: "/app/erp/shopify-links" },
  ];
  const recipeFixLinks = [
    { label: "Product Setup", url: "/app/erp/product-setup" },
    { label: "Materials", url: "/app/erp/materials" },
    { label: "Vendors", url: "/app/erp/vendors" },
    { label: "Pricing Rules", url: "/app/erp/pricing-rules" },
    { label: "Margin Review", url: "/app/erp/margin-review" },
  ];

  return (
    <Page title="Pricing Health" subtitle="Pricing Authority & Margin Readiness">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                This page is read-only. It shows which pricing system controls each product and where setup needs review. It does not change Shopify prices or ERP pricing.
              </Text>
              <InlineStack gap="200" wrap>
                <Badge tone="success">No writes</Badge>
                <Badge tone="success">No Shopify Admin calls</Badge>
                <Badge>Shop: {data.shop}</Badge>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <SummaryCard label="Active configurator products" value={summary.activeConfiguratorProducts} help="Stock bag and jar storefront records." />
            <SummaryCard label="Configurator products missing pricing" value={summary.missingConfiguratorPricing} help="Active configurator products with no active pricing rules for their product type." />
            <SummaryCard label="Active product recipes" value={summary.activeProductRecipes} help="Quote/ERP products using recipe pricing." />
            <SummaryCard label="Recipes needing cost review" value={summary.recipesNeedingCostReview} help="Active recipes flagged for cost review." />
            <SummaryCard label="Pricing / wholesale rules" value={`${summary.pricingRules} / ${summary.wholesaleRules}`} help="Older/simple pricing rules and wholesale display rules." />
            <SummaryCard label="Jobs with actual costs" value={`${summary.jobsWithActualCosts}/${summary.productionJobCount}`} help="Production jobs with actualTotalCost greater than zero." />
          </div>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Pricing Authority Map</Text>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr><th style={headerStyle}>Area</th><th style={headerStyle}>Authority</th><th style={headerStyle}>Notes</th></tr>
                  </thead>
                  <tbody>
                    <tr><td style={cellStyle}>Stock bag storefront configurator</td><td style={cellStyle}>ConfiguratorPricingRule</td><td style={cellStyle}>Live proven path for customer pricing.</td></tr>
                    <tr><td style={cellStyle}>Jar storefront configurator</td><td style={cellStyle}>ConfiguratorPricingRule</td><td style={cellStyle}>Live proven path for jar color and label set routing.</td></tr>
                    <tr><td style={cellStyle}>Configurator checkout/draft order</td><td style={cellStyle}>ConfiguratorPricingRule.priceEach</td><td style={cellStyle}>Checkout validates the selected rule before creating the draft order.</td></tr>
                    <tr><td style={cellStyle}>Quote/ERP products</td><td style={cellStyle}>ProductRecipe + RecipeTier</td><td style={cellStyle}>Recipe cost engine powers quote pricing and margin review.</td></tr>
                    <tr><td style={cellStyle}>Outsourced/vendor products</td><td style={cellStyle}>VendorProduct / VendorProductTier / VendorCostBook tiers</td><td style={cellStyle}>Used as cost sources for outsourced products and vendor-backed recipes.</td></tr>
                    <tr><td style={cellStyle}>Wholesale display/rules</td><td style={cellStyle}>WholesaleRule / ShopSettings</td><td style={cellStyle}>Separate customer-tag wholesale pricing layer.</td></tr>
                    <tr><td style={cellStyle}>Margin audit</td><td style={cellStyle}>PriceApprovalRecord / ProductRecipe estimates</td><td style={cellStyle}>Review workflow lives in Margin Review.</td></tr>
                    <tr><td style={cellStyle}>Actual margin reporting</td><td style={cellStyle}>ProductionJob actual costs + print/material usage</td><td style={cellStyle}>Needs completed jobs with logged actual costs.</td></tr>
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Configurator Product Health</Text>
                  <Text as="p" tone="subdued">
                    Showing {data.configuratorRows.length} of {data.totalConfiguratorRows} configurator products
                    {filtered ? " matching current filters" : ""}
                  </Text>
                </BlockStack>
                <Badge>{data.filteredConfiguratorRows} match(es)</Badge>
              </InlineStack>
              <ConfiguratorFilters filters={data.filters} />
              <div style={{ overflowX: "auto", paddingBottom: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1320, tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ ...headerStyle, width: 280 }}>Product</th>
                      <th style={{ ...headerStyle, width: 180 }}>Type / Family</th>
                      <th style={headerStyle}>Mapping</th>
                      <th style={headerStyle}>Options</th>
                      <th style={headerStyle}>Pricing rules</th>
                      <th style={headerStyle}>Min qty</th>
                      <th style={headerStyle}>Cost source</th>
                      <th style={headerStyle}>Est. margin</th>
                      <th style={{ ...headerStyle, width: 130 }}>Health</th>
                      <th style={{ ...headerStyle, width: 240 }}>Fix links</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.configuratorRows.map((row: any) => (
                      <tr key={row.id}>
                        <td style={productCellStyle}><strong>{row.title}</strong></td>
                        <td style={cellStyle}>{row.productType}<br /><Text as="span" tone="subdued">{row.productFamily}</Text></td>
                        <td style={cellStyle}>{row.mappingLabel}</td>
                        <td style={cellStyle}>{row.optionCount}</td>
                        <td style={cellStyle}>{row.pricingRuleCount}</td>
                        <td style={cellStyle}>{row.minQuantity || "N/A"}</td>
                        <td style={cellStyle}>{row.costSource}</td>
                        <td style={cellStyle}>{row.estimatedMargin == null ? "N/A" : pct(row.estimatedMargin)}</td>
                        <td style={cellStyle}><Badge tone={healthTone(row.health) as any}>{row.health}</Badge></td>
                        <td style={actionCellStyle}><FixLinks links={configuratorFixLinks} /></td>
                      </tr>
                    ))}
                    {!data.configuratorRows.length ? (
                      <tr>
                        <td colSpan={10} style={cellStyle}>No configurator products match the current filters.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Product Recipe Health</Text>
                <Badge>Showing first {data.recipeRows.length}</Badge>
              </InlineStack>
              <div style={{ overflowX: "auto", paddingBottom: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1220, tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ ...headerStyle, width: 260 }}>Recipe</th>
                      <th style={headerStyle}>Type / Family</th>
                      <th style={headerStyle}>Authority</th>
                      <th style={headerStyle}>Tiers</th>
                      <th style={headerStyle}>Materials</th>
                      <th style={headerStyle}>Variant rules</th>
                      <th style={headerStyle}>Cost review</th>
                      <th style={headerStyle}>Vendor source</th>
                      <th style={{ ...headerStyle, width: 130 }}>Health</th>
                      <th style={{ ...headerStyle, width: 230 }}>Fix links</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recipeRows.map((row: any) => (
                      <tr key={row.id}>
                        <td style={cellStyle}><strong>{row.name}</strong></td>
                        <td style={cellStyle}>{row.productType}<br /><Text as="span" tone="subdued">{row.productFamily}</Text></td>
                        <td style={cellStyle}>{row.authority}</td>
                        <td style={cellStyle}>{row.tierCount}</td>
                        <td style={cellStyle}>{row.materialCount}</td>
                        <td style={cellStyle}>{row.variantRuleCount}</td>
                        <td style={cellStyle}>{row.costReviewNeeded ? "Needs review" : "Clear"}</td>
                        <td style={cellStyle}>{row.vendorCostSource}</td>
                        <td style={cellStyle}><Badge tone={healthTone(row.health) as any}>{row.health}</Badge></td>
                        <td style={actionCellStyle}><FixLinks links={recipeFixLinks} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Reporting / Actual Cost Readiness</Text>
              <InlineStack gap="300" wrap>
                <Badge>{summary.productionJobCount} production job(s)</Badge>
                <Badge tone={summary.jobsWithActualCosts > 0 ? "success" : "attention"}>{summary.jobsWithActualCosts} with actual costs</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Actual margin reporting is not fully validated until production jobs have logged actual costs or imported print logs.
              </Text>
              <Divider />
              <Text as="p" tone="subdued">
                Pricing Health is read-only in this version. Future versions can add approval workflows, recommended price changes, and Shopify price sync after review.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
