import { Form, Link, useActionData, useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const VERSION = "Tier Rule Manager v1.4";
const DEFAULT_TIERS = [100, 250, 500, 1000, 2500, 5000, 10000];
const SCOPE_OPTIONS = ["global", "collection", "product", "variant"] as const;
const MODE_OPTIONS = ["cost_margin", "percent_off", "fixed_price", "manual_cost_margin"] as const;

type TierRuleRow = {
  id: string;
  title: string;
  scopeType: string;
  scopeTarget: string;
  minQty: number;
  discountType: string;
  sellPrice: number | null;
  percentOff: number | null;
  minUnitPrice: number | null;
  active: boolean;
  priority: number;
  settings: {
    minMarginPct?: number;
    minOrderTotal?: number;
    minOrderQty?: number;
    quantityIncrement?: number;
    defaultQuantity?: number;
    casePackQty?: number;
    rounding?: string;
    mode?: string;
    recipe?: any;
  };
  createdAt: string;
  updatedAt: string;
};

function money(value: any) {
  const num = Number(value || 0);
  return `$${num.toFixed(2)}`;
}

function numberValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function settingString(values: {
  minMarginPct: number;
  minOrderTotal: number;
  minOrderQty: number;
  quantityIncrement: number;
  defaultQuantity: number;
  casePackQty: number;
  rounding: string;
  mode: string;
  recipe?: any;
}) {
  const recipePart = values.recipe
    ? `|recipe:${encodeURIComponent(JSON.stringify(values.recipe))}`
    : "";
  return `tier_settings|mode:${values.mode}|margin:${values.minMarginPct}|round:${values.rounding}|minTotal:${values.minOrderTotal}|minQty:${values.minOrderQty}|increment:${values.quantityIncrement}|defaultQty:${values.defaultQuantity}|casePack:${values.casePackQty}${recipePart}`;
}

function parseSettings(value: string | null | undefined) {
  const settings: TierRuleRow["settings"] = {};
  const raw = String(value || "");
  for (const part of raw.split("|")) {
    const [key, val] = part.split(":");
    if (key === "margin") settings.minMarginPct = Number(val || 0);
    if (key === "minTotal") settings.minOrderTotal = Number(val || 0);
    if (key === "minQty") settings.minOrderQty = Number(val || 0);
    if (key === "increment") settings.quantityIncrement = Number(val || 0);
    if (key === "defaultQty") settings.defaultQuantity = Number(val || 0);
    if (key === "casePack") settings.casePackQty = Number(val || 0);
    if (key === "round") settings.rounding = val || "0.05";
    if (key === "mode") settings.mode = val || "percent_off";
    if (key === "recipe") {
      try {
        settings.recipe = JSON.parse(decodeURIComponent(val || ""));
      } catch (error) {
        settings.recipe = null;
      }
    }
  }
  return settings;
}

function scopeFields(scopeType: string, target: string) {
  const scope = String(scopeType || "global").toLowerCase();
  const trimmed = String(target || "").trim();
  if (scope === "variant") {
    return { productTag: null, productGid: null, variantGid: trimmed || null };
  }
  if (scope === "product") {
    return { productTag: null, productGid: trimmed || null, variantGid: null };
  }
  if (scope === "collection") {
    return {
      productTag: `collection:${trimmed || "unassigned"}`,
      productGid: null,
      variantGid: null,
    };
  }
  return { productTag: "global", productGid: null, variantGid: null };
}

function scopeLabel(rule: any) {
  if (rule.variantGid)
    return { scopeType: "variant", scopeTarget: rule.variantGid };
  if (rule.productGid)
    return { scopeType: "product", scopeTarget: rule.productGid };
  if (String(rule.productTag || "").startsWith("collection:"))
    return {
      scopeType: "collection",
      scopeTarget: String(rule.productTag).replace("collection:", ""),
    };
  return { scopeType: "global", scopeTarget: "All products" };
}

function tierRowLabel(row: TierRuleRow) {
  if (row.discountType === "fixed_price") return `${money(row.sellPrice)} each`;
  if (row.discountType === "manual_cost_margin") {
    return `${money(row.sellPrice)} cost + ${Number(row.percentOff || 0).toFixed(2)}% margin`;
  }
  if (row.discountType === "cost_margin") return `${Number(row.percentOff || 0).toFixed(2)}% margin`;
  return `${Number(row.percentOff || 0).toFixed(2)}% off`;
}

async function searchShopifyProducts(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query TierRuleProductSearch($query: String!) {
        products(first: 20, query: $query) {
          edges {
            node {
              id
              title
              handle
              status
              totalVariants
              variants(first: 8) {
                edges { node { id title sku price selectedOptions { name value } } }
              }
              collections(first: 5) {
                edges { node { id title handle } }
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        query: `title:*${safeQuery}* OR sku:*${safeQuery}* OR handle:*${safeQuery}*`,
      },
    },
  );

  const payload = await response.json();
  if (payload?.errors?.length)
    throw new Error(
      payload.errors.map((error: any) => error.message).join(", "),
    );
  return (payload?.data?.products?.edges || []).map((edge: any) => {
    const product = edge.node;
    return {
      id: product.id,
      type: "product",
      title: product.title,
      handle: product.handle,
      status: product.status,
      totalVariants: product.totalVariants || 0,
      variants: (product.variants?.edges || []).map(
        (variantEdge: any) => variantEdge.node,
      ),
      collections: (product.collections?.edges || []).map(
        (collectionEdge: any) => collectionEdge.node,
      ),
    };
  });
}

async function searchShopifyCollections(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query TierRuleCollectionSearch($query: String!) {
        collections(first: 20, query: $query) {
          edges {
            node {
              id
              title
              handle
              products(first: 5) {
                pageInfo { hasNextPage }
                edges {
                  node {
                    id
                    title
                    handle
                    totalVariants
                    variants(first: 3) { edges { node { id title sku price selectedOptions { name value } } } }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: `title:*${safeQuery}* OR handle:*${safeQuery}*` } },
  );

  const payload = await response.json();
  if (payload?.errors?.length)
    throw new Error(
      payload.errors.map((error: any) => error.message).join(", "),
    );
  return (payload?.data?.collections?.edges || []).map((edge: any) => {
    const collection = edge.node;
    return {
      id: collection.id,
      type: "collection",
      title: collection.title,
      handle: collection.handle,
      products: (collection.products?.edges || []).map((productEdge: any) => ({
        ...productEdge.node,
        variants: (productEdge.node?.variants?.edges || []).map(
          (variantEdge: any) => variantEdge.node,
        ),
      })),
      hasMoreProducts: Boolean(collection.products?.pageInfo?.hasNextPage),
    };
  });
}

export async function loader({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const targetSearch = String(
    url.searchParams.get("targetSearch") || "",
  ).trim();
  const targetType =
    String(url.searchParams.get("targetType") || "collection") === "product"
      ? "product"
      : "collection";

  const rows = await db.pricingRule.findMany({
    where: { shop, customerTag: "gso_tier_rule" },
    orderBy: [{ priority: "asc" }, { title: "asc" }, { minQty: "asc" }],
  });

  const rules: TierRuleRow[] = rows.map((row: any) => {
    const scope = scopeLabel(row);
    return {
      id: row.id,
      title: row.title,
      scopeType: scope.scopeType,
      scopeTarget: scope.scopeTarget,
      minQty: row.minQty,
      discountType: row.discountType,
      sellPrice: row.sellPrice,
      percentOff: row.percentOff,
      minUnitPrice: row.unitCost,
      active: row.active,
      priority: row.priority,
      settings: parseSettings(row.sku),
      createdAt: row.createdAt?.toISOString?.() || "",
      updatedAt: row.updatedAt?.toISOString?.() || "",
    };
  });

  const targetOptions = targetSearch
    ? targetType === "product"
      ? await searchShopifyProducts(admin, targetSearch)
      : await searchShopifyCollections(admin, targetSearch)
    : [];

  return { version: VERSION, rules, targetSearch, targetType, targetOptions };
}

export async function action({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const targetSearch = String(
    url.searchParams.get("targetSearch") || "",
  ).trim();
  const targetType =
    String(url.searchParams.get("targetType") || "collection") === "product"
      ? "product"
      : "collection";
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "delete") {
    const title = String(form.get("title") || "").trim();
    const scopeType = String(form.get("scopeType") || "global").trim();
    const scopeTarget = String(form.get("scopeTarget") || "").trim();
    const fields = scopeFields(
      scopeType,
      scopeTarget === "All products" ? "" : scopeTarget,
    );
    await db.pricingRule.deleteMany({
      where: {
        shop,
        customerTag: "gso_tier_rule",
        title,
        productTag: fields.productTag || undefined,
        productGid: fields.productGid || undefined,
        variantGid: fields.variantGid || undefined,
      },
    });
    return { ok: true, message: `Deleted tier rule group: ${title}` };
  }

  if (intent === "create") {
    const title =
      String(form.get("title") || "").trim() || "Untitled tier rule";
    const scopeType = String(form.get("scopeType") || "global").trim();
    const scopeTarget = String(form.get("scopeTarget") || "").trim();
    const requestedMode = String(form.get("pricingMode") || "cost_margin").trim();
    const mode = MODE_OPTIONS.includes(requestedMode as any)
      ? requestedMode
      : "cost_margin";
    const minMarginPct = numberValue(form.get("minMarginPct"), 50);
    const minOrderTotal = numberValue(form.get("minOrderTotal"), 0);
    const minUnitPrice = numberValue(form.get("minUnitPrice"), 0);
    const minOrderQty = intValue(form.get("minOrderQty"), DEFAULT_TIERS[0] || 0);
    const quantityIncrement = intValue(form.get("quantityIncrement"), 1);
    const defaultQuantity = intValue(form.get("defaultQuantity"), minOrderQty || DEFAULT_TIERS[0] || 0);
    const casePackQty = intValue(form.get("casePackQty"), 0);
    const rounding = String(form.get("rounding") || "0.05");
    const active = String(form.get("active") || "on") === "on";
    const fields = scopeFields(scopeType, scopeTarget);
    const priority =
      scopeType === "variant"
        ? 10
        : scopeType === "product"
          ? 25
          : scopeType === "collection"
            ? 50
            : 100;
    const recipeFamily = String(form.get("recipeFamily") || "stock_bag").trim();
    const frontLabelWidth = numberValue(form.get("frontLabelWidth"), numberValue(form.get("sideLabelWidth"), 0));
    const frontLabelHeight = numberValue(form.get("frontLabelHeight"), numberValue(form.get("sideLabelHeight"), 0));
    const backLabelWidth = numberValue(form.get("backLabelWidth"), numberValue(form.get("lidLabelWidth"), 0));
    const backLabelHeight = numberValue(form.get("backLabelHeight"), numberValue(form.get("lidLabelHeight"), 0));
    const recipe = {
      family: recipeFamily,
      labelMode:
        recipeFamily === "stock_bag" || recipeFamily === "bag_label_set"
          ? "double_sided_bag"
          : recipeFamily === "jar"
            ? "jar_side_lid"
            : recipeFamily === "sticker_label"
              ? "single_label"
              : "custom",
      stockBag: {
        doubleSided: true,
        front: {
          width: frontLabelWidth,
          height: frontLabelHeight,
          required: recipeFamily === "stock_bag" || recipeFamily === "bag_label_set",
        },
        back: {
          width: backLabelWidth || frontLabelWidth,
          height: backLabelHeight || frontLabelHeight,
          required: recipeFamily === "stock_bag" || recipeFamily === "bag_label_set",
        },
        blankItemRule: String(form.get("blankItemRule") || "4x5 sticker bag / stock bag color variant").trim(),
        applicationType: String(form.get("applicationType") || "Apply label to flat bag/pouch").trim(),
      },
      baseLabels: {
        side: {
          width: recipeFamily === "jar" ? numberValue(form.get("sideLabelWidth"), 0) : frontLabelWidth,
          height: recipeFamily === "jar" ? numberValue(form.get("sideLabelHeight"), 0) : frontLabelHeight,
          required: true,
        },
        lid: {
          width: recipeFamily === "jar" ? numberValue(form.get("lidLabelWidth"), 0) : backLabelWidth,
          height: recipeFamily === "jar" ? numberValue(form.get("lidLabelHeight"), 0) : backLabelHeight,
          required: recipeFamily === "jar",
        },
      },
      optionalLabels: {
        sideLid: {
          width: numberValue(form.get("sideLidLabelWidth"), 0),
          height: numberValue(form.get("sideLidLabelHeight"), 0),
          enabledByOption: String(form.get("sideLidOptionName") || "Side Lid + application").trim(),
          enabledByValue: String(form.get("sideLidOptionValue") || "yes").trim(),
        },
      },
      variantMappings: {
        materialOptionName: String(form.get("materialOptionName") || "Material").trim(),
        glossOptionName: String(form.get("glossOptionName") || "Gloss").trim(),
        bagColorOptionName: String(form.get("bagColorOptionName") || "Bag Color").trim(),
        applicationOptionName: String(form.get("applicationOptionName") || "Side Lid + application").trim(),
      },
      notes: String(form.get("recipeNotes") || "").trim(),
    };
    const settings = settingString({
      minMarginPct,
      minOrderTotal,
      minOrderQty,
      quantityIncrement,
      defaultQuantity,
      casePackQty,
      rounding,
      mode,
      recipe,
    });

    const tierRows = DEFAULT_TIERS.map((qty) => {
      const discountPct = numberValue(form.get(`discount_${qty}`), 0);
      const fixedPrice = numberValue(form.get(`fixed_${qty}`), 0);
      const marginPct = numberValue(form.get(`margin_${qty}`), minMarginPct);
      const manualCost = numberValue(form.get(`manualCost_${qty}`), 0);
      return { qty, discountPct, fixedPrice, marginPct, manualCost };
    }).filter((tier) => {
      if (tier.qty <= 0) return false;
      if (mode === "fixed_price") return tier.fixedPrice > 0;
      if (mode === "manual_cost_margin") return tier.manualCost > 0 && tier.marginPct > 0;
      if (mode === "cost_margin") return tier.marginPct > 0;
      return true;
    });

    if (!tierRows.length) {
      return {
        ok: false,
        message: "Add at least one valid tier row before saving.",
      };
    }

    await db.pricingRule.deleteMany({
      where: {
        shop,
        customerTag: "gso_tier_rule",
        title,
        productTag: fields.productTag || undefined,
        productGid: fields.productGid || undefined,
        variantGid: fields.variantGid || undefined,
      },
    });

    await db.pricingRule.createMany({
      data: tierRows.map((tier) => ({
        shop,
        title,
        customerTag: "gso_tier_rule",
        productTag: fields.productTag,
        productGid: fields.productGid,
        variantGid: fields.variantGid,
        sku: settings,
        minQty: tier.qty,
        discountType: mode,
        sellPrice:
          mode === "fixed_price"
            ? tier.fixedPrice
            : mode === "manual_cost_margin"
              ? tier.manualCost
              : null,
        percentOff:
          mode === "percent_off"
            ? tier.discountPct
            : mode === "cost_margin" || mode === "manual_cost_margin"
              ? tier.marginPct
              : null,
        unitCost: minUnitPrice || null,
        active,
        priority,
      })),
    });

    return {
      ok: true,
      message: `Saved ${tierRows.length} tier rows for ${title}.`,
    };
  }

  return { ok: false, message: "Unknown tier rule action." };
}

function groupRules(rows: TierRuleRow[]) {
  const groups = new Map<string, TierRuleRow[]>();
  for (const row of rows) {
    const key = `${row.title}|${row.scopeType}|${row.scopeTarget}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, group]) => ({
    key,
    group: group.sort((a, b) => a.minQty - b.minQty),
  }));
}

export default function ErpPricingRulesRoute() {
  const { version, rules, targetSearch, targetType, targetOptions } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const groups = groupRules(rules as TierRuleRow[]);
  const [recipeFamily, setRecipeFamily] = useState("stock_bag");
  const isBagRecipe = recipeFamily === "stock_bag" || recipeFamily === "bag_label_set";
  const isJarRecipe = recipeFamily === "jar";
  const isStickerRecipe = recipeFamily === "sticker_label";

  return (
    <main
      style={{
        maxWidth: 1180,
        margin: "32px auto",
        padding: 20,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap" }}
      >
        <Link to="/app">Dashboard</Link>
        <Link to="/app/erp/cost-calculator">Cost Calculator</Link>
        <Link to="/app/erp/product-setup">Product Setup</Link>
      </div>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 20,
          marginBottom: 20,
          background: "#fff",
        }}
      >
        <p style={{ margin: "0 0 6px", color: "#666" }}>{version}</p>
        <h1 style={{ margin: 0 }}>Tier Rule Manager</h1>
        <p style={{ maxWidth: 900, lineHeight: 1.5 }}>
          Build tier rules connected to existing Shopify products and
          collections. v1.1 pulls Shopify targets into the setup, stores
          label-size recipe data, variant option mappings, and flexible pricing
          methods so tier pricing can become automatic later.
        </p>
        {actionData?.message ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              background: actionData.ok ? "#e8f7ed" : "#fff3cd",
              border: "1px solid #ddd",
            }}
          >
            {actionData.message}
          </div>
        ) : null}
      </section>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 20,
          marginBottom: 20,
          background: "#fff",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Find existing Shopify target</h2>
        <p style={{ color: "#666" }}>
          Search an existing collection or product first. Then use the exact
          Shopify GID in the rule so future product creation, tier pricing,
          storefront pricing, and Discount Function enforcement all point to the
          same source of truth.
        </p>
        <Form
          method="get"
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <label>
            Target type
            <select
              name="targetType"
              defaultValue={targetType}
              style={inputStyle}
            >
              <option value="collection">Collection</option>
              <option value="product">Product</option>
            </select>
          </label>
          <label>
            Search Shopify
            <input
              name="targetSearch"
              defaultValue={targetSearch}
              placeholder="Stock Bags, 150ML Miron Jars, product handle..."
              style={inputStyle}
            />
          </label>
          <button type="submit" style={secondaryButtonStyle}>
            Search
          </button>
        </Form>
        {targetOptions?.length ? (
          <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
            <strong>Found Shopify targets</strong>
            {targetOptions.map((target: any) => (
              <div
                key={target.id}
                style={{
                  border: "1px solid #e2e2e2",
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <strong>{target.title}</strong>{" "}
                    <span style={{ color: "#666" }}>/{target.handle}</span>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>
                      {target.id}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {target.type === "collection"
                      ? `${target.products?.length || 0} preview products${target.hasMoreProducts ? " + more" : ""}`
                      : `${target.totalVariants || 0} variants`}
                  </div>
                </div>
                {target.products?.length ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
                    Preview:{" "}
                    {target.products
                      .slice(0, 3)
                      .map((product: any) => product.title)
                      .join(", ")}
                    {target.hasMoreProducts ? "..." : ""}
                  </div>
                ) : null}
                {target.variants?.length ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
                    Variants:{" "}
                    {target.variants
                      .slice(0, 4)
                      .map(
                        (variant: any) =>
                          `${variant.title} @ ${money(variant.price)}`,
                      )
                      .join(" | ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : targetSearch ? (
          <p style={{ marginTop: 12 }}>
            No Shopify targets found for this search.
          </p>
        ) : null}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(360px, 0.95fr) minmax(420px, 1.25fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        <Form
          method="post"
          style={{
            border: "1px solid #ddd",
            borderRadius: 14,
            padding: 20,
            background: "#fff",
          }}
        >
          <input type="hidden" name="intent" value="create" />
          <h2 style={{ marginTop: 0 }}>Create or replace tier rule</h2>
          <p style={{ color: "#666" }}>
            Use collection scope for bulk rules like Stock Bags. Use product or
            variant scope for overrides.
          </p>

          <label style={{ display: "block", marginTop: 12 }}>
            Rule name
            <input
              name="title"
              defaultValue="Stock Bags Tier Rule"
              style={inputStyle}
            />
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Scope
            <select
              name="scopeType"
              defaultValue={targetType || "collection"}
              style={inputStyle}
            >
              {SCOPE_OPTIONS.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Target ID / handle
            {targetOptions?.length ? (
              <select
                name="scopeTarget"
                defaultValue={targetOptions[0]?.id || ""}
                style={inputStyle}
              >
                {targetOptions.map((target: any) => (
                  <option key={target.id} value={target.id}>
                    {target.title} / {target.handle} — {target.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name="scopeTarget"
                placeholder="Search above first, or paste collection/product/variant GID"
                defaultValue="Stock Bags"
                style={inputStyle}
              />
            )}
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Pricing method
            <select
              name="pricingMode"
              defaultValue="cost_margin"
              style={inputStyle}
            >
              <option value="cost_margin">Cost-based margin % by tier</option>
              <option value="percent_off">Shopify/base price % off by tier</option>
              <option value="manual_cost_margin">Manual unit cost + margin %</option>
              <option value="fixed_price">Manual fixed unit price</option>
            </select>
          </label>
          <p style={{ margin: "6px 0 0", color: "#666", fontSize: 13 }}>
            Cost-based margin uses the recipe/backend cost for each variant. % off uses the Shopify/base price. Manual cost is for products not fully mapped yet. Fixed price is an override.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 10,
              marginTop: 12,
            }}
          >
            <label>
              Min margin %
              <input
                name="minMarginPct"
                type="number"
                step="0.01"
                defaultValue="50"
                style={inputStyle}
              />
            </label>
            <label>
              Min unit price
              <input
                name="minUnitPrice"
                type="number"
                step="0.01"
                defaultValue="0"
                style={inputStyle}
              />
            </label>
            <label>
              Min order total
              <input
                name="minOrderTotal"
                type="number"
                step="0.01"
                defaultValue="0"
                style={inputStyle}
              />
            </label>
          </div>

          <section
            style={{
              marginTop: 12,
              padding: 12,
              border: "1px solid #dbeafe",
              background: "#eff6ff",
              borderRadius: 12,
            }}
          >
            <h3 style={{ margin: "0 0 6px" }}>Quantity rules</h3>
            <p style={{ margin: "0 0 10px", color: "#475569", fontSize: 13 }}>
              These replace scattered Shopify min-quantity metafields. Storefront quantity boxes, carts, tier previews, and checkout enforcement should all use these values.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <label>
                Minimum order qty
                <input
                  name="minOrderQty"
                  type="number"
                  step="1"
                  min="0"
                  defaultValue="100"
                  style={inputStyle}
                />
              </label>
              <label>
                Quantity increment
                <input
                  name="quantityIncrement"
                  type="number"
                  step="1"
                  min="1"
                  defaultValue="1"
                  style={inputStyle}
                />
              </label>
              <label>
                Default quantity
                <input
                  name="defaultQuantity"
                  type="number"
                  step="1"
                  min="0"
                  defaultValue="100"
                  style={inputStyle}
                />
              </label>
              <label>
                Case pack / box qty
                <input
                  name="casePackQty"
                  type="number"
                  step="1"
                  min="0"
                  defaultValue="0"
                  style={inputStyle}
                />
              </label>
            </div>
          </section>

          <label style={{ display: "block", marginTop: 12 }}>
            Rounding rule
            <select name="rounding" defaultValue="0.05" style={inputStyle}>
              <option value="0.01">Round to nearest $0.01</option>
              <option value="0.05">Round up to nearest $0.05</option>
              <option value="0.10">Round up to nearest $0.10</option>
              <option value="0.25">Round up to nearest $0.25</option>
              <option value="1.00">Round up to nearest $1.00</option>
            </select>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            <input name="active" type="checkbox" defaultChecked /> Active rule
          </label>

          <h3>Tier rows</h3>
          <p style={{ marginTop: 0, color: "#666", fontSize: 13 }}>
            Fill the column that matches the selected pricing method. The extra columns stay available as future override/reference fields.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr 1fr 1fr 1fr",
                gap: 8,
                fontWeight: 700,
              }}
            >
              <span>Qty</span>
              <span>Margin %</span>
              <span>% off</span>
              <span>Manual cost</span>
              <span>Fixed price</span>
            </div>
            {DEFAULT_TIERS.map((qty, index) => {
              const defaultMargins = [60, 55, 50, 47, 45, 45, 45];
              const defaultDiscounts = [0, 5, 8, 12, 16, 20, 24];
              return (
              <div
                key={qty}
                style={{
                  display: "grid",
                  gridTemplateColumns: "72px 1fr 1fr 1fr 1fr",
                  gap: 8,
                }}
              >
                <input
                  value={qty}
                  readOnly
                  style={{ ...inputStyle, background: "#f8f8f8" }}
                />
                <input
                  name={`margin_${qty}`}
                  type="number"
                  step="0.01"
                  defaultValue={defaultMargins[index] || 45}
                  style={inputStyle}
                />
                <input
                  name={`discount_${qty}`}
                  type="number"
                  step="0.01"
                  defaultValue={defaultDiscounts[index] || 0}
                  style={inputStyle}
                />
                <input
                  name={`manualCost_${qty}`}
                  type="number"
                  step="0.01"
                  placeholder="optional"
                  style={inputStyle}
                />
                <input
                  name={`fixed_${qty}`}
                  type="number"
                  step="0.01"
                  placeholder="optional"
                  style={inputStyle}
                />
              </div>
            )})}
          </div>

          <section
            style={{
              marginTop: 18,
              padding: 14,
              border: "1px solid #dbeafe",
              borderRadius: 12,
              background: "#eff6ff",
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              Production recipe attached to this rule
            </h3>
            <p style={{ color: "#475569", marginTop: 0 }}>
              These fields save the label sizes and variant meanings with the
              Shopify product/collection rule. The next preview/pricing patch
              will use this data to calculate sqft, ink/gloss/white, labor, and
              safe tier prices automatically.
            </p>
            <label style={{ display: "block", marginTop: 10 }}>
              Recipe family
              <select
                name="recipeFamily"
                value={recipeFamily}
                onChange={(event) => setRecipeFamily(event.currentTarget.value)}
                style={inputStyle}
              >
                <option value="stock_bag">Stock/sticker bag - double sided</option>
                <option value="bag_label_set">Bag + label set - double sided</option>
                <option value="jar">Jar / lid label set</option>
                <option value="dtp_bag">DTP bag</option>
                <option value="box">Box</option>
                <option value="sticker_label">Sticker / label only</option>
                <option value="custom">Custom</option>
              </select>
            </label>

            {isBagRecipe ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ padding: 10, borderRadius: 10, background: "#ecfdf5", border: "1px solid #bbf7d0", marginBottom: 10 }}>
                  <strong>Bag recipe:</strong> applies to 4x5 sticker bags and Stock Bags. This recipe is double-sided by default and calculates front label + back label, material/ink/gloss for both sides, blank bag color, and flat-bag application labor.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label>
                    Front label width
                    <input name="frontLabelWidth" type="number" step="0.001" defaultValue="4" style={inputStyle} />
                  </label>
                  <label>
                    Front label height
                    <input name="frontLabelHeight" type="number" step="0.001" defaultValue="5" style={inputStyle} />
                  </label>
                  <label>
                    Back label width
                    <input name="backLabelWidth" type="number" step="0.001" defaultValue="4" style={inputStyle} />
                  </label>
                  <label>
                    Back label height
                    <input name="backLabelHeight" type="number" step="0.001" defaultValue="5" style={inputStyle} />
                  </label>
                  <label>
                    Material option name
                    <input name="materialOptionName" defaultValue="Material" style={inputStyle} />
                  </label>
                  <label>
                    Gloss option name
                    <input name="glossOptionName" defaultValue="Gloss" style={inputStyle} />
                  </label>
                  <label>
                    Bag color option name
                    <input name="bagColorOptionName" defaultValue="Bag Color" style={inputStyle} />
                  </label>
                  <label>
                    Application type
                    <input name="applicationType" defaultValue="Apply label to flat bag/pouch" style={inputStyle} />
                  </label>
                </div>
                <label style={{ display: "block", marginTop: 10 }}>
                  Blank item rule
                  <input name="blankItemRule" defaultValue="4x5 sticker bag / stock bag color variant" style={inputStyle} />
                </label>
                <label style={{ display: "block", marginTop: 10 }}>
                  Recipe notes
                  <textarea name="recipeNotes" defaultValue="Stock/sticker bag collection rule. Always double-sided: front label + back label. Material, Gloss, and Bag Color are Shopify variant options. No jar lid or side-lid fields apply." style={{ ...inputStyle, minHeight: 76 }} />
                </label>
              </div>
            ) : null}

            {isJarRecipe ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ padding: 10, borderRadius: 10, background: "#fff7ed", border: "1px solid #fed7aa", marginBottom: 10 }}>
                  <strong>Jar recipe:</strong> side label and lid label are always included. Side-lid label is only added when the mapped Shopify option/value is selected.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label>Side label width<input name="sideLabelWidth" type="number" step="0.001" placeholder="ex: 7.2" style={inputStyle} /></label>
                  <label>Side label height<input name="sideLabelHeight" type="number" step="0.001" placeholder="ex: 3.2" style={inputStyle} /></label>
                  <label>Lid label width<input name="lidLabelWidth" type="number" step="0.001" placeholder="ex: 2" style={inputStyle} /></label>
                  <label>Lid label height<input name="lidLabelHeight" type="number" step="0.001" placeholder="ex: 2" style={inputStyle} /></label>
                  <label>Side-lid label width<input name="sideLidLabelWidth" type="number" step="0.001" placeholder="optional" style={inputStyle} /></label>
                  <label>Side-lid label height<input name="sideLidLabelHeight" type="number" step="0.001" placeholder="optional" style={inputStyle} /></label>
                  <label>Material option name<input name="materialOptionName" defaultValue="Material" style={inputStyle} /></label>
                  <label>Gloss option name<input name="glossOptionName" defaultValue="Gloss" style={inputStyle} /></label>
                  <label>Side-lid option name<input name="sideLidOptionName" defaultValue="Side Lid + application" style={inputStyle} /></label>
                  <label>Side-lid option value<input name="sideLidOptionValue" defaultValue="yes" style={inputStyle} /></label>
                </div>
                <label style={{ display: "block", marginTop: 10 }}>
                  Recipe notes
                  <textarea name="recipeNotes" placeholder="Example: For jars, side + lid are always included. Side-lid label is only included when variant option is yes." style={{ ...inputStyle, minHeight: 76 }} />
                </label>
              </div>
            ) : null}

            {isStickerRecipe ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ padding: 10, borderRadius: 10, background: "#f8fafc", border: "1px solid #cbd5e1", marginBottom: 10 }}>
                  <strong>Sticker recipe:</strong> one printed label/sticker only. No blank bag, jar, lid, or application item is included unless later overridden.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label>Label width<input name="frontLabelWidth" type="number" step="0.001" placeholder="ex: 3" style={inputStyle} /></label>
                  <label>Label height<input name="frontLabelHeight" type="number" step="0.001" placeholder="ex: 3" style={inputStyle} /></label>
                  <label>Material option name<input name="materialOptionName" defaultValue="Material" style={inputStyle} /></label>
                  <label>Gloss option name<input name="glossOptionName" defaultValue="Gloss" style={inputStyle} /></label>
                </div>
              </div>
            ) : null}

            {!isBagRecipe && !isJarRecipe && !isStickerRecipe ? (
              <label style={{ display: "block", marginTop: 10 }}>
                Recipe notes
                <textarea name="recipeNotes" placeholder="Describe what this recipe includes. More recipe-specific fields will be added for DTP bags, boxes, and custom products in the next build." style={{ ...inputStyle, minHeight: 90 }} />
              </label>
            ) : null}
          </section>

          <button type="submit" style={primaryButtonStyle}>
            Save tier rule
          </button>
        </Form>

        <section
          style={{
            border: "1px solid #ddd",
            borderRadius: 14,
            padding: 20,
            background: "#fff",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Saved rules</h2>
          {!groups.length ? <p>No tier rules saved yet.</p> : null}
          <div style={{ display: "grid", gap: 14 }}>
            {groups.map(({ key, group }) => {
              const first = group[0];
              return (
                <article
                  key={key}
                  style={{
                    border: "1px solid #e2e2e2",
                    borderRadius: 12,
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <h3 style={{ margin: "0 0 4px" }}>{first.title}</h3>
                      <p style={{ margin: 0, color: "#666" }}>
                        Scope: <strong>{first.scopeType}</strong> · Target:{" "}
                        <strong>{first.scopeTarget}</strong> · Mode:{" "}
                        <strong>
                          {first.discountType === "fixed_price"
                            ? "Manual fixed unit price"
                            : first.discountType === "manual_cost_margin"
                              ? "Manual unit cost + margin"
                              : first.discountType === "cost_margin"
                                ? "Cost-based margin"
                                : "Percentage discount"}
                        </strong>
                      </p>
                      <p style={{ margin: "4px 0 0", color: "#666" }}>
                        Guardrails: min margin{" "}
                        {first.settings.minMarginPct ?? 0}% · min unit{" "}
                        {money(first.minUnitPrice)} · rounding $
                        {first.settings.rounding || "0.05"}
                      </p>
                      <p style={{ margin: "4px 0 0", color: "#666" }}>
                        Qty rules: MOQ {Number(first.settings.minOrderQty || 0).toLocaleString()} · increment {Number(first.settings.quantityIncrement || 1).toLocaleString()} · default {Number(first.settings.defaultQuantity || first.settings.minOrderQty || 0).toLocaleString()} · case pack {Number(first.settings.casePackQty || 0).toLocaleString()}
                      </p>
                      {first.settings.recipe ? (
                        <p style={{ margin: "4px 0 0", color: "#2563eb" }}>
                          Recipe: {first.settings.recipe.family || "custom"} ·
                          {first.settings.recipe.labelMode === "double_sided_bag"
                            ? `Front ${first.settings.recipe.stockBag?.front?.width || 0} x ${first.settings.recipe.stockBag?.front?.height || 0} · Back ${first.settings.recipe.stockBag?.back?.width || 0} x ${first.settings.recipe.stockBag?.back?.height || 0} · Bag color option ${first.settings.recipe.variantMappings?.bagColorOptionName || "Bag Color"}`
                            : `Side ${first.settings.recipe.baseLabels?.side?.width || 0} x ${first.settings.recipe.baseLabels?.side?.height || 0} · Lid ${first.settings.recipe.baseLabels?.lid?.width || 0} x ${first.settings.recipe.baseLabels?.lid?.height || 0} · Side-lid ${first.settings.recipe.optionalLabels?.sideLid?.width || 0} x ${first.settings.recipe.optionalLabels?.sideLid?.height || 0}`}
                        </p>
                      ) : null}
                    </div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="title" value={first.title} />
                      <input
                        type="hidden"
                        name="scopeType"
                        value={first.scopeType}
                      />
                      <input
                        type="hidden"
                        name="scopeTarget"
                        value={first.scopeTarget}
                      />
                      <button type="submit" style={dangerButtonStyle}>
                        Delete
                      </button>
                    </Form>
                  </div>

                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      marginTop: 12,
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={thStyle}>Min qty</th>
                        <th style={thStyle}>Tier value</th>
                        <th style={thStyle}>Active</th>
                        <th style={thStyle}>Priority</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((row) => (
                        <tr key={row.id}>
                          <td style={tdStyle}>{row.minQty.toLocaleString()}</td>
                          <td style={tdStyle}>{tierRowLabel(row)}</td>
                          <td style={tdStyle}>{row.active ? "Yes" : "No"}</td>
                          <td style={tdStyle}>{row.priority}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              );
            })}
          </div>
        </section>
      </section>

      <section
        style={{
          marginTop: 20,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 20,
          background: "#fafafa",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Build roadmap</h2>
        <ol style={{ lineHeight: 1.7 }}>
          <li>
            <strong>v1.0:</strong> Save global, collection, product, and variant
            tier rules. This page.
          </li>
          <li>
            <strong>v1.1:</strong> Add Shopify product/collection search and
            attach production recipe metadata. This page.
          </li>
          <li>
            <strong>v1.2:</strong> Recipe-specific setup fields for stock/sticker bags, jars, and stickers. This page.
          </li>
          <li>
            <strong>v1.3:</strong> Flexible pricing methods: cost-based margin, % off, manual cost + margin, or fixed price.
          </li>
          <li>
            <strong>v1.4:</strong> MOQ, quantity increment, default quantity, and case-pack rules attached to pricing rules.
          </li>
          <li>
            <strong>v1.5:</strong> Preview affected variants and generate safe tier prices from Cost Calculator backend costs.
          </li>
          <li>
            <strong>v2.0:</strong> Shopify Discount Function checkout enforcement.
          </li>
        </ol>
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 10px",
  marginTop: 4,
  border: "1px solid #bbb",
  borderRadius: 8,
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop: 18,
  padding: "10px 14px",
  border: 0,
  borderRadius: 8,
  background: "#111827",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  border: "1px solid #111827",
  borderRadius: 8,
  background: "white",
  color: "#111827",
  fontWeight: 700,
  cursor: "pointer",
};

const dangerButtonStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #b91c1c",
  borderRadius: 8,
  background: "white",
  color: "#b91c1c",
  fontWeight: 700,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid #ddd",
  padding: "8px",
};
const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "8px",
};
