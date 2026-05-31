import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type TierPrice = { min: number; max?: number | null; label: string; price: number | null };
type FinishOption = {
  key: string;
  label: string;
  group?: string;
  defaultCost: number;
  tierPrices: TierPrice[];
  baseKey?: string;
};
type ProductTemplate = {
  key: string;
  label: string;
  description: string;
  defaultMargin: number;
  defaultQuantity: number;
  finishes: FinishOption[];
};

type RecipeEstimate = {
  recipeId: string;
  recipeName: string;
  costEach: number;
  materialCost: number;
  zoneMediaCost: number;
  applicationLaborCost: number;
  packingLaborCost: number;
  setupCostEach: number;
  warning: string | null;
};

function money(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pct(value: number | null | undefined, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function numberParam(url: URL, key: string, fallback: number) {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function stringParam(url: URL, key: string, fallback: string) {
  const value = url.searchParams.get(key);
  return value && value.trim() ? value : fallback;
}

function tier(label: string, min: number, max: number | null, price: number | null): TierPrice {
  return { label, min, max, price };
}

const STICKER_TIERS = [
  tier("1-499", 1, 499, null),
  tier("500-999", 500, 999, null),
  tier("1K-4,999", 1000, 4999, null),
  tier("5K-9,999", 5000, 9999, null),
  tier("10K+", 10000, null, null),
];

const MIRON_TIERS = [
  tier("1-250", 1, 250, null),
  tier("251-500", 251, 500, null),
  tier("501-1K", 501, 1000, null),
  tier("1K-2K+", 1001, null, null),
];

const JAR3_TIERS = [
  tier("64", 64, 99, null),
  tier("100", 100, 299, null),
  tier("300", 300, 499, null),
  tier("500", 500, 799, null),
  tier("800", 800, 999, null),
  tier("1,000", 1000, null, null),
];

function withPrices(base: TierPrice[], prices: Array<number | null>) {
  return base.map((row, index) => ({ ...row, price: prices[index] ?? null }));
}

const PRODUCT_TEMPLATES: ProductTemplate[] = [
  {
    key: "sticker_4x5_single",
    label: "4x5 Sticker Bag - Single Sided",
    description: "GSO current 4x5 matte single-sided sticker bag price list.",
    defaultMargin: 55,
    defaultQuantity: 1000,
    finishes: [
      { key: "matte", label: "Matte", defaultCost: 0.42, tierPrices: withPrices(STICKER_TIERS, [1.00, 0.90, 0.85, 0.80, 0.78]) },
      { key: "spot_gloss", label: "Spot Gloss", defaultCost: 0.48, baseKey: "matte", tierPrices: withPrices(STICKER_TIERS, [1.10, 1.00, 0.95, 0.90, 0.88]) },
    ],
  },
  {
    key: "sticker_4x5_double",
    label: "4x5 Sticker Bag - Double Sided",
    description: "GSO current 4x5 matte double-sided sticker bag price list.",
    defaultMargin: 60,
    defaultQuantity: 1000,
    finishes: [
      { key: "matte", label: "Matte", defaultCost: 0.67, tierPrices: withPrices(STICKER_TIERS, [1.60, 1.45, 1.38, 1.36, 1.34]) },
      { key: "sg", label: "SG", defaultCost: 0.74, baseKey: "matte", tierPrices: withPrices(STICKER_TIERS, [1.95, 1.75, 1.65, 1.58, 1.55]) },
      { key: "2x_sg", label: "2x SG", defaultCost: 0.79, baseKey: "matte", tierPrices: withPrices(STICKER_TIERS, [2.20, 1.95, 1.85, 1.80, 1.78]) },
      { key: "3x_sg", label: "3x SG", defaultCost: 0.84, baseKey: "matte", tierPrices: withPrices(STICKER_TIERS, [2.35, 2.10, 2.00, 1.97, 1.95]) },
      { key: "4x_sg", label: "4x SG", defaultCost: 0.89, baseKey: "matte", tierPrices: withPrices(STICKER_TIERS, [2.55, 2.30, 2.20, 2.18, 2.15]) },
    ],
  },
  {
    key: "miron_100ml",
    label: "Miron Jar - 100 ML",
    description: "Jar + side label + top label + application.",
    defaultMargin: 58,
    defaultQuantity: 251,
    finishes: [
      { key: "matte", group: "Matte", label: "Matte", defaultCost: 2.10, tierPrices: withPrices(MIRON_TIERS, [5.10, 4.70, 4.55, 4.49]) },
      { key: "spot_gloss", group: "Matte", label: "+ Spot Gloss", defaultCost: 2.25, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [5.45, 5.00, 4.82, 4.65]) },
      { key: "2x_sg", group: "Matte", label: "2x SG", defaultCost: 2.35, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [5.60, 5.13, 4.92, 4.82]) },
      { key: "3x_sg", group: "Matte", label: "3x SG", defaultCost: 2.45, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [5.85, 5.37, 5.15, 4.92]) },
      { key: "holo", group: "Holographic", label: "Holographic", defaultCost: 2.30, tierPrices: withPrices(MIRON_TIERS, [5.40, 5.16, 4.97, 4.82]) },
      { key: "holo_white", group: "Holographic", label: "+ White", defaultCost: 2.42, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [5.65, 5.41, 5.20, 5.00]) },
      { key: "holo_sg", group: "Holographic", label: "+ SG", defaultCost: 2.50, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [5.75, 5.50, 5.28, 5.05]) },
      { key: "holo_w_2xsg", group: "Holographic", label: "W + 2xSG", defaultCost: 2.62, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [6.00, 5.72, 5.40, 5.27]) },
    ],
  },
  {
    key: "miron_150ml",
    label: "Miron Jar - 150 ML",
    description: "Jar + side label + top label + application.",
    defaultMargin: 58,
    defaultQuantity: 251,
    finishes: [
      { key: "matte", group: "Matte", label: "Matte", defaultCost: 2.35, tierPrices: withPrices(MIRON_TIERS, [5.66, 5.70, 5.60, 5.08]) },
      { key: "spot_gloss", group: "Matte", label: "+ Spot Gloss", defaultCost: 2.48, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [5.81, 5.66, 5.55, 5.33]) },
      { key: "2x_sg", group: "Matte", label: "2x SG", defaultCost: 2.60, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [6.16, 5.88, 5.76, 5.53]) },
      { key: "3x_sg", group: "Matte", label: "3x SG", defaultCost: 2.72, baseKey: "matte", tierPrices: withPrices(MIRON_TIERS, [6.21, 6.13, 5.91, 5.68]) },
      { key: "holo", group: "Holographic", label: "Holographic", defaultCost: 2.50, tierPrices: withPrices(MIRON_TIERS, [5.86, 5.70, 5.60, 5.08]) },
      { key: "holo_spot", group: "Holographic", label: "+ Spot Gloss", defaultCost: 2.62, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [6.01, 5.76, 5.55, 5.33]) },
      { key: "holo_2xsg", group: "Holographic", label: "2x SG", defaultCost: 2.72, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [6.16, 5.88, 5.76, 5.53]) },
      { key: "holo_3xsg", group: "Holographic", label: "3x SG", defaultCost: 2.85, baseKey: "holo", tierPrices: withPrices(MIRON_TIERS, [6.41, 6.31, 6.21, 6.00]) },
    ],
  },
  {
    key: "jar_3oz",
    label: "3oz Jar",
    description: "3oz jar market/current price table from current reference screenshots.",
    defaultMargin: 55,
    defaultQuantity: 300,
    finishes: [
      { key: "matte", label: "Matte", defaultCost: 1.20, tierPrices: withPrices(JAR3_TIERS, [3.20, 2.95, 2.75, 2.70, 2.68, 2.65]) },
      { key: "holo_spot", label: "Holo + Spot Gloss", defaultCost: 1.35, baseKey: "matte", tierPrices: withPrices(JAR3_TIERS, [null, 3.25, 3.00, 2.80, 2.70, 2.60]) },
      { key: "matte_1x_sg", label: "Matte + 1x Spot Gloss", defaultCost: 1.28, baseKey: "matte", tierPrices: withPrices(JAR3_TIERS, [null, 2.90, 2.70, 2.60, 2.50, 2.45]) },
      { key: "matte_2x_sg", label: "Matte + 2x Spot Gloss", defaultCost: 1.38, baseKey: "matte", tierPrices: withPrices(JAR3_TIERS, [null, 3.10, 2.90, 2.75, 2.65, 2.55]) },
      { key: "matte_3x_sg", label: "Matte + 3x Spot Gloss", defaultCost: 1.48, baseKey: "matte", tierPrices: withPrices(JAR3_TIERS, [null, 3.30, 3.05, 2.90, 2.75, 2.65]) },
    ],
  },
];

function findTemplate(key: string) {
  return PRODUCT_TEMPLATES.find((template) => template.key === key) || PRODUCT_TEMPLATES[0];
}

function findFinish(template: ProductTemplate, key: string) {
  return template.finishes.find((finish) => finish.key === key) || template.finishes[0];
}

function tierForQuantity(finish: FinishOption, quantity: number) {
  return finish.tierPrices.find((tier) => quantity >= tier.min && (tier.max == null || quantity <= tier.max)) || finish.tierPrices[finish.tierPrices.length - 1];
}

function marginFromPrice(price: number | null | undefined, cost: number) {
  if (!price || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

function priceForMargin(cost: number, marginPct: number) {
  const margin = Math.min(95, Math.max(0, marginPct)) / 100;
  return cost / (1 - margin);
}

function statusFor(currentPrice: number | null, safePrice: number, currentMargin: number | null, targetMargin: number) {
  if (!currentPrice) return "No current price";
  if (currentMargin == null) return "Review";
  if (currentMargin + 0.5 < targetMargin) return "Low margin";
  if (currentPrice > safePrice * 1.25) return "Market high";
  return "Safe";
}

function roundNickel(value: number) {
  return Math.ceil(value * 20) / 20;
}

function selectedMarginBase(template: ProductTemplate, selected: FinishOption, quantity: number) {
  const base = template.finishes.find((finish) => finish.key === selected.baseKey) || template.finishes[0];
  const baseTier = tierForQuantity(base, quantity);
  const baseMargin = marginFromPrice(baseTier?.price, base.defaultCost);
  return { base, baseTier, baseMargin: baseMargin ?? template.defaultMargin };
}


function unitCost(material: any) {
  const calculated = Number(material?.calculatedUnitCost || 0);
  const base = Number(material?.costPerUnit || 0);
  return calculated > 0 ? calculated : base;
}

function materialUsageCost(row: any) {
  const qty = Number(row?.quantity || 0);
  const cost = unitCost(row?.material);
  const wastePct = row?.includeWaste ? Number(row?.wastePct || 0) : 0;
  return qty * cost * (1 + wastePct / 100);
}

function labelZoneCost(zone: any) {
  const qty = Number(zone?.qtyPerUnit || 1);
  const width = Number(zone?.widthIn || 0);
  const height = Number(zone?.heightIn || 0);
  const areaSqin = width * height * qty;
  const areaSqft = areaSqin / 144;
  const material = zone?.mediaOption?.material || zone?.material;
  const cost = unitCost(material);
  const unit = String(material?.unit || material?.baseUnit || "sqft").toLowerCase();
  if (!material || cost <= 0) return 0;
  if (unit.includes("sqin")) return areaSqin * cost;
  if (unit.includes("each")) return qty * cost;
  return areaSqft * cost;
}

function recipeEstimate(recipe: any, settings: any, quantity: number): RecipeEstimate {
  const laborRate = Number(settings?.laborRatePerHour || 25);
  const laborFloor = Number(settings?.applicationLaborFloorPerSide || 0.2);
  const materialCost = (recipe?.materials || []).filter((row: any) => row.active !== false).reduce((sum: number, row: any) => sum + materialUsageCost(row), 0);
  const activeZones = (recipe?.labelZones || []).filter((zone: any) => zone.active !== false);
  const zoneMediaCost = activeZones.reduce((sum: number, zone: any) => sum + labelZoneCost(zone), 0);
  const zoneLaborBySeconds = activeZones.reduce((sum: number, zone: any) => {
    const seconds = Number(zone?.applicationSecondsPerLabel || 0) * Number(zone?.qtyPerUnit || 1);
    return sum + (seconds / 3600) * laborRate;
  }, 0);
  const printedSides = Math.max(1, activeZones.length || 1);
  const applicationLaborCost = Math.max(zoneLaborBySeconds, printedSides * laborFloor);
  const packingLaborCost = (Number(recipe?.packingLaborSecondsPerUnit || 0) / 3600) * laborRate;
  const safeQuantity = Math.max(1, quantity || Number(recipe?.defaultQuantity || 1));
  const setupCostEach = Number(recipe?.setupCost || 0) / safeQuantity;
  const rawCost = materialCost + zoneMediaCost + applicationLaborCost + packingLaborCost + setupCostEach;
  const costEach = Math.max(0, rawCost);
  let warning = null;
  if (!recipe) warning = "No recipe selected.";
  else if (costEach <= 0) warning = "Recipe cost came back as zero, using manual/template cost instead.";
  else if (zoneLaborBySeconds < printedSides * laborFloor) warning = "Recipe labor seconds are below the saved labor floor, so the calculator used the floor.";
  return {
    recipeId: recipe?.id || "",
    recipeName: recipe?.name || "",
    costEach,
    materialCost,
    zoneMediaCost,
    applicationLaborCost,
    packingLaborCost,
    setupCostEach,
    warning,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const templateKey = stringParam(url, "template", "sticker_4x5_double");
  const template = findTemplate(templateKey);
  const finishKey = stringParam(url, "finish", template.finishes[0].key);
  const finish = findFinish(template, finishKey);
  const quantity = Math.max(1, Math.round(numberParam(url, "quantity", template.defaultQuantity)));
  const targetMargin = numberParam(url, "targetMargin", template.defaultMargin);
  const manualCost = numberParam(url, "estimatedCost", finish.defaultCost);
  const recipeId = stringParam(url, "recipeId", "");

  const settings = await db.marginReviewSetting.findFirst({ where: { shop, active: true }, orderBy: { updatedAt: "desc" } });

  const recipes = await db.productRecipe.findMany({
    where: { shop, active: true },
    orderBy: [{ costReviewNeeded: "desc" }, { name: "asc" }],
    take: 50,
    select: { id: true, name: true, sku: true, productFamily: true, targetMarginPct: true, defaultQuantity: true },
  });

  const selectedRecipe = recipeId
    ? await db.productRecipe.findFirst({
        where: { shop, id: recipeId, active: true },
        include: {
          materials: { where: { active: true }, include: { material: true } },
          labelZones: { where: { active: true }, include: { material: true, mediaOption: { include: { material: true } } } },
        },
      })
    : null;

  const recipeCost = selectedRecipe ? recipeEstimate(selectedRecipe, settings, quantity) : null;
  const estimatedCost = recipeCost && recipeCost.costEach > 0 ? recipeCost.costEach : manualCost;
  const costSource = recipeCost && recipeCost.costEach > 0 ? "recipe" : "manual";

  const selectedTier = tierForQuantity(finish, quantity);
  const currentPrice = selectedTier?.price ?? null;
  const currentMargin = marginFromPrice(currentPrice, estimatedCost);
  const safePriceRaw = priceForMargin(estimatedCost, targetMargin);
  const safePrice = roundNickel(safePriceRaw);
  const baseInfo = selectedMarginBase(template, finish, quantity);
  const matchedMarginPrice = roundNickel(priceForMargin(estimatedCost, baseInfo.baseMargin));
  const recommendedPrice = Math.max(safePrice, matchedMarginPrice, currentPrice || 0);
  const tierRows = finish.tierPrices.map((tier) => {
    const rowCost = estimatedCost;
    const rowMargin = marginFromPrice(tier.price, rowCost);
    const rowSafe = roundNickel(priceForMargin(rowCost, targetMargin));
    const rowMatched = roundNickel(priceForMargin(rowCost, baseInfo.baseMargin));
    return {
      ...tier,
      cost: rowCost,
      currentMargin: rowMargin,
      safePrice: rowSafe,
      matchedMarginPrice: rowMatched,
      recommendedPrice: Math.max(rowSafe, rowMatched, tier.price || 0),
      status: statusFor(tier.price, rowSafe, rowMargin, targetMargin),
    };
  });

  return Response.json({
    templates: PRODUCT_TEMPLATES.map((item) => ({ key: item.key, label: item.label })),
    template,
    finish,
    quantity,
    targetMargin,
    manualCost,
    estimatedCost,
    costSource,
    recipeId,
    recipes,
    recipeCost,
    selectedTier,
    currentPrice,
    currentMargin,
    safePrice,
    matchedMarginPrice,
    recommendedPrice,
    baseInfo,
    tierRows,
  });
}

export default function WholesaleCalculator() {
  const data = useLoaderData<typeof loader>();
  const template = data.template as ProductTemplate;
  const finish = data.finish as FinishOption;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif", color: "#111827" }}>
      <section style={{ background: "linear-gradient(90deg,#220033,#4b0072)", color: "white", borderRadius: 12, padding: 24, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Pricing Calculator</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>v12 foundation: product templates, current GSO pricing, estimated cost, margin-safe tier suggestions, and material upgrade margin matching.</p>
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Calculator inputs</h2>
        <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "span 2" }}>
            Product template
            <select name="template" defaultValue={template.key} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }}>
              {data.templates.map((item: any) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "span 2" }}>
            Style / finish
            <select name="finish" defaultValue={finish.key} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }}>
              {template.finishes.map((option) => <option key={option.key} value={option.key}>{option.group ? `${option.group} - ${option.label}` : option.label}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Quantity
            <input name="quantity" type="number" min="1" defaultValue={data.quantity} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Target margin %
            <input name="targetMargin" type="number" min="0" max="95" step="0.1" defaultValue={data.targetMargin} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "span 2" }}>
            Product Setup recipe cost source
            <select name="recipeId" defaultValue={data.recipeId || ""} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }}>
              <option value="">Manual/template cost fallback</option>
              {data.recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name}{recipe.sku ? ` / ${recipe.sku}` : ""}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "span 2" }}>
            Manual fallback cost each
            <input name="estimatedCost" type="number" min="0" step="0.01" defaultValue={data.manualCost} style={{ padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 }} />
          </label>
          <button type="submit" style={{ padding: "11px 16px", borderRadius: 8, background: "#111827", color: "white", border: 0, fontWeight: 700, gridColumn: "span 2" }}>Calculate price</button>
          <p style={{ gridColumn: "span 6", margin: 0, fontSize: 12, color: "#6b7280" }}>
            v12.1 uses selected Product Setup recipe costs when available. If no recipe is selected or the recipe cost is zero, the calculator uses the manual fallback cost.
          </p>
        </Form>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        <Metric title="Current GSO price" value={data.currentPrice ? money(data.currentPrice) : "No price"} note={data.selectedTier?.label || "No tier"} />
        <Metric title="Estimated cost" value={money(data.estimatedCost)} note={data.costSource === "recipe" ? "From Product Setup recipe" : "Manual/template fallback"} />
        <Metric title="Current margin" value={data.currentMargin == null ? "N/A" : pct(data.currentMargin)} note="Using current GSO price" />
        <Metric title="Safe price" value={money(data.safePrice)} note={`${pct(data.targetMargin)} target margin`} />
        <Metric title="Recommended" value={money(data.recommendedPrice)} note="Highest safe/current/matched" strong />
      </section>

      <section style={{ background: data.costSource === "recipe" ? "#ecfdf5" : "#f8fafc", border: "1px solid #d9dde6", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Recipe cost connection</h2>
        {data.costSource === "recipe" && data.recipeCost ? (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <p style={{ margin: 0 }}>Using real Product Setup recipe: <strong>{data.recipeCost.recipeName}</strong>.</p>
            <p style={{ margin: "4px 0 0" }}>
              Materials: <strong>{money(data.recipeCost.materialCost)}</strong> · Label/media zones: <strong>{money(data.recipeCost.zoneMediaCost)}</strong> · Application labor: <strong>{money(data.recipeCost.applicationLaborCost)}</strong> · Packing: <strong>{money(data.recipeCost.packingLaborCost)}</strong> · Setup/unit: <strong>{money(data.recipeCost.setupCostEach)}</strong>
            </p>
            {data.recipeCost.warning ? <p style={{ margin: "6px 0 0", color: "#92400e", fontWeight: 700 }}>{data.recipeCost.warning}</p> : null}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13 }}>No Product Setup recipe is selected. The calculator is using the manual/template fallback cost.</p>
        )}
      </section>

      <section style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Material / finish margin matching</h2>
        <p style={{ margin: 0, fontSize: 13 }}>
          Base comparison: <strong>{data.baseInfo.base.label}</strong> at <strong>{data.baseInfo.baseTier.label}</strong> has an estimated margin of <strong>{pct(data.baseInfo.baseMargin)}</strong>. To keep that same margin for <strong>{finish.label}</strong>, charge about <strong>{money(data.matchedMarginPrice)}</strong> each.
        </p>
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Tier suggestions</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={cellHeader}>Tier</th>
                <th style={cellHeader}>Current GSO</th>
                <th style={cellHeader}>Cost</th>
                <th style={cellHeader}>Current margin</th>
                <th style={cellHeader}>Safe target price</th>
                <th style={cellHeader}>Matched-margin price</th>
                <th style={cellHeader}>Recommended</th>
                <th style={cellHeader}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.tierRows.map((row: any) => (
                <tr key={row.label}>
                  <td style={cell}>{row.label}</td>
                  <td style={cell}>{row.price ? money(row.price) : "-"}</td>
                  <td style={cell}>{money(row.cost)}</td>
                  <td style={cell}>{row.currentMargin == null ? "N/A" : pct(row.currentMargin)}</td>
                  <td style={cell}>{money(row.safePrice)}</td>
                  <td style={cell}>{money(row.matchedMarginPrice)}</td>
                  <td style={{ ...cell, fontWeight: 800 }}>{money(row.recommendedPrice)}</td>
                  <td style={cell}><StatusBadge status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
          v12 is calculator-only. It does not approve prices and does not update Shopify. Approval and Shopify updates stay in Margin Review.
        </p>
      </section>
    </main>
  );
}

const cellHeader = { padding: "10px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 700 };
const cell = { padding: "10px 8px", borderBottom: "1px solid #eef0f3", verticalAlign: "top" };

function Metric({ title, value, note, strong = false }: { title: string; value: string; note: string; strong?: boolean }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{title}</div>
      <div style={{ fontSize: strong ? 24 : 22, fontWeight: 800, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{note}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "Safe" ? "#dcfce7" : status === "Low margin" ? "#fee2e2" : status === "Market high" ? "#fef3c7" : "#e0f2fe";
  return <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: color, fontWeight: 700 }}>{status}</span>;
}
