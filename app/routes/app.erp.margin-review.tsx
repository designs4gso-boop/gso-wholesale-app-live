import { Form, redirect, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const DEFAULT_SHOP_LABOR_RATE_PER_HOUR = 25;
const DEFAULT_APPLICATION_LABOR_COST_PER_SIDE = 0.15;
const DEFAULT_AUDIT_LIMIT = 150;
const DEFAULT_WARNING_BAND_PCT = 5;
const DEFAULT_COST_REVIEW_THRESHOLD_PCT = 0;

function money(value: any) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pct(value: any, digits = 1) {
  const number = Number(value || 0);
  return `${number.toFixed(digits)}%`;
}

function numberOr(value: any, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalize(value: any) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function safeMargin(price: number, cost: number) {
  if (!price || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

function priceForMargin(cost: number, marginPct: number) {
  const margin = Math.min(95, Math.max(0, numberOr(marginPct, 0))) / 100;
  if (margin >= 0.95) return cost;
  return cost / (1 - margin);
}

function unitCost(material: any) {
  return numberOr(material?.calculatedUnitCost, 0) || numberOr(material?.costPerUnit, 0) || numberOr(material?.purchaseCost, 0);
}

function zoneSqft(zone: any) {
  return (numberOr(zone?.widthIn, 0) * numberOr(zone?.heightIn, 0) * Math.max(1, numberOr(zone?.qtyPerUnit, 1))) / 144;
}

function activeRows(rows: any[] = []) {
  return (rows || []).filter((row: any) => row?.active !== false && !row?.archivedAt);
}

function findOption(options: any[] = [], id?: string | null) {
  return (options || []).find((option: any) => option?.id === id);
}

function defaultMediaOption(options: any[] = []) {
  return (options || []).find((option: any) => option?.defaultOption && option?.active !== false) || (options || []).find((option: any) => option?.active !== false) || null;
}

function optionFromRule(recipe: any, rule: any, side: "front" | "back") {
  const options = recipe.mediaOptions || [];
  if (side === "front") return findOption(options, rule?.frontMediaOptionId) || defaultMediaOption(options);
  if (rule?.backMediaMode === "specific") return findOption(options, rule?.backMediaOptionId) || defaultMediaOption(options);
  return optionFromRule(recipe, rule, "front");
}

function materialForZone(zone: any, zones: any[] = [], recipe: any = {}, rule: any = {}, side: "front" | "back" = "front") {
  if (zone?.mediaMode === "media_option") {
    const option = side === "back" ? optionFromRule(recipe, rule, "back") : optionFromRule(recipe, rule, "front");
    return option?.material || zone?.mediaOption?.material || zone?.material;
  }
  if (zone?.mediaMode === "same_as_zone") {
    const source = zones.find((candidate: any) => candidate.id === zone.sameAsZoneId) || zones.find((candidate: any) => String(candidate.position || candidate.name || "").toLowerCase().includes("front"));
    if (source) return materialForZone(source, zones, recipe, rule, side);
  }
  return zone?.material || zone?.mediaOption?.material;
}

function selectedZonesForRule(recipe: any, rule: any) {
  const zones = activeRows(recipe.labelZones || []);
  const frontZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("front")) || zones[0];
  const backZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("back")) || zones.find((zone: any) => zone?.id !== frontZone?.id) || null;
  const sideMode = String(rule?.sideMode || "").toLowerCase();
  const useFront = rule?.useFrontZone !== false && !!frontZone;
  const useBack = (rule?.useBackZone === true || sideMode.includes("double")) && !!backZone;
  const selected = [useFront ? { zone: frontZone, side: "front" as const } : null, useBack ? { zone: backZone, side: "back" as const } : null].filter(Boolean) as Array<{ zone: any; side: "front" | "back" }>;
  return { zones, frontZone, backZone, selected };
}

function estimateRecipeVariantUnitCost(recipe: any, rule: any, quantityOverride?: number, assumptions: any = {}) {
  const qty = Math.max(1, Math.round(numberOr(quantityOverride, numberOr(recipe.defaultQuantity, numberOr(recipe.minQuantity, 1)))));
  const laborRate = numberOr(assumptions.laborRatePerHour, numberOr(recipe.laborRatePerHour, DEFAULT_SHOP_LABOR_RATE_PER_HOUR)) || DEFAULT_SHOP_LABOR_RATE_PER_HOUR;
  const sideLaborFloor = numberOr(assumptions.applicationLaborCostPerSide, DEFAULT_APPLICATION_LABOR_COST_PER_SIDE) || DEFAULT_APPLICATION_LABOR_COST_PER_SIDE;
  const rows = activeRows(recipe.materials || []);

  const materialLines = rows.map((row: any) => {
    const quantity = numberOr(row.quantity, 0);
    const wasteMultiplier = row.includeWaste === false ? 1 : 1 + numberOr(row.wastePct, 0) / 100;
    const cost = unitCost(row.material) * quantity * wasteMultiplier;
    const name = row?.material?.name || row?.materialName || "Material row";
    const typeText = row?.usageType || row?.material?.materialType || "material";
    const unitText = row?.unit || row?.material?.unit || "unit";
    const normalized = normalize(`${row?.usageType || ""} ${row?.material?.materialType || ""} ${row?.material?.name || ""}`);
    const looksBase = normalized.includes("blank") || normalized.includes("base") || normalized.includes("bag") || normalized.includes("jar") || normalized.includes("box");
    return { name, typeText, unitText, quantity, wastePct: numberOr(row.wastePct, 0), includeWaste: row.includeWaste !== false, cost, looksBase };
  });

  const manualMaterialCostPerUnit = materialLines.reduce((sum: number, line: any) => sum + line.cost, 0);
  const baseMaterialCostPerUnit = materialLines.filter((line: any) => line.looksBase).reduce((sum: number, line: any) => sum + line.cost, 0);

  const { selected } = selectedZonesForRule(recipe, rule);
  const wasteMultiplier = 1 + numberOr(recipe.wastePct, 0) / 100;
  const labelSqftPerUnit = selected.reduce((sum, item) => sum + zoneSqft(item.zone), 0);
  const zoneLines = selected.map((item) => {
    const material = materialForZone(item.zone, recipe.labelZones || [], recipe, rule, item.side);
    const sqft = zoneSqft(item.zone);
    const cost = unitCost(material) * sqft * wasteMultiplier;
    return {
      side: item.side,
      name: item.zone?.name || item.zone?.position || item.side,
      materialName: material?.name || "Media material",
      sqft,
      cost,
      applicationSeconds: numberOr(item.zone?.applicationSecondsPerLabel, 0) * Math.max(1, numberOr(item.zone?.qtyPerUnit, 1)),
    };
  });

  const labelMediaCostPerUnit = zoneLines.reduce((sum: number, line: any) => sum + line.cost, 0);

  const printedSides = Math.max(0, selected.length);
  const applicationSecondsPerUnit = selected.reduce((sum, item) => sum + numberOr(item.zone?.applicationSecondsPerLabel, 0) * Math.max(1, numberOr(item.zone?.qtyPerUnit, 1)), 0);
  const applicationLaborFromSeconds = (applicationSecondsPerUnit / 3600) * laborRate;
  const applicationLaborFloor = printedSides ? printedSides * sideLaborFloor : 0;
  const applicationLaborCostPerUnit = Math.max(applicationLaborFromSeconds, applicationLaborFloor);
  const applicationLaborFloorApplied = applicationLaborCostPerUnit > applicationLaborFromSeconds + 0.00001;
  const applicationLaborLines = zoneLines.map((line: any) => {
    const secondsCost = (line.applicationSeconds / 3600) * laborRate;
    const floorCost = sideLaborFloor;
    const appliedCost = applicationLaborFloorApplied ? floorCost : secondsCost;
    return { ...line, secondsCost, floorCost, appliedCost };
  });

  const packingLaborSeconds = numberOr(recipe.packingLaborSecondsPerUnit, 0);
  const packingLaborCostPerUnit = (packingLaborSeconds / 3600) * laborRate;
  const prepressLaborCostPerUnit = (numberOr(recipe.prepressMinutes, 0) / 60) * laborRate / qty;
  const setupLaborCostPerUnit = (numberOr(recipe.laborMinutes, 0) / 60) * laborRate / qty;
  const setupCostPerUnit = numberOr(recipe.setupCost, 0) / qty;
  const total = manualMaterialCostPerUnit + labelMediaCostPerUnit + applicationLaborCostPerUnit + packingLaborCostPerUnit + prepressLaborCostPerUnit + setupLaborCostPerUnit + setupCostPerUnit;

  const missingBaseCost = baseMaterialCostPerUnit <= 0;
  const missingZones = !selected.length;
  const costReviewNeeded = missingBaseCost || missingZones || applicationLaborFloorApplied;

  return {
    qty,
    manualMaterialCostPerUnit,
    baseMaterialCostPerUnit,
    materialLines,
    labelMediaCostPerUnit,
    zoneLines,
    labelSqftPerUnit,
    printedSides,
    applicationSecondsPerUnit,
    applicationLaborFromSeconds,
    applicationLaborFloor,
    applicationLaborCostPerUnit,
    applicationLaborLines,
    applicationLaborFloorApplied,
    sideLaborFloor,
    packingLaborCostPerUnit,
    prepressLaborCostPerUnit,
    setupLaborCostPerUnit,
    setupCostPerUnit,
    laborRate,
    total,
    missingBaseCost,
    missingZones,
    costReviewNeeded,
  };
}

function ruleTitle(rule: any) {
  return rule.shopifyVariantTitle || rule.name || rule.sku || rule.shopifyVariantGid || "Variant rule";
}

function statusForMargin(currentMargin: number | null, targetMargin: number, warningBandPct = DEFAULT_WARNING_BAND_PCT) {
  const warningBand = Math.max(0, numberOr(warningBandPct, DEFAULT_WARNING_BAND_PCT));
  if (currentMargin === null) return { tone: "yellow", label: "no price" };
  if (currentMargin < targetMargin - warningBand) return { tone: "red", label: "price low" };
  if (currentMargin < targetMargin) return { tone: "yellow", label: "near target" };
  return { tone: "green", label: "healthy" };
}

function activeTiers(recipe: any) {
  const tiers = (recipe?.tiers || [])
    .filter((tier: any) => tier && numberOr(tier.minQty, 0) > 0)
    .sort((a: any, b: any) => numberOr(a.minQty, 0) - numberOr(b.minQty, 0));

  if (tiers.length) return tiers;

  const minQty = Math.max(1, Math.round(numberOr(recipe?.minQuantity, 1)));
  const defaultQty = Math.max(minQty, Math.round(numberOr(recipe?.defaultQuantity, minQty)));
  return [{ id: "default", minQty: minQty, maxQty: null, marginPct: recipe?.targetMarginPct, fixedPrice: null, notes: "Fallback default tier" }];
}

function tierLabel(tier: any) {
  const min = Math.max(1, Math.round(numberOr(tier?.minQty, 1)));
  const max = tier?.maxQty ? Math.round(numberOr(tier.maxQty, 0)) : null;
  return max ? `${min}-${max}` : `${min}+`;
}

function buildTierReview(recipe: any, rule: any, currentPrice: number, assumptions: any = {}) {
  return activeTiers(recipe).map((tier: any) => {
    const qty = Math.max(1, Math.round(numberOr(tier.minQty, recipe?.defaultQuantity || recipe?.minQuantity || 1)));
    const tierCost = estimateRecipeVariantUnitCost(recipe, rule, qty, assumptions);
    const tierTargetMargin = numberOr(tier.marginPct, numberOr(recipe?.targetMarginPct, 40));
    const suggestedPrice = priceForMargin(tierCost.total, tierTargetMargin);
    const fixedPrice = tier.fixedPrice === null || tier.fixedPrice === undefined ? null : numberOr(tier.fixedPrice, 0);
    const auditPrice = fixedPrice && fixedPrice > 0 ? fixedPrice : suggestedPrice;
    const auditMargin = safeMargin(auditPrice, tierCost.total);
    const shopifyMargin = currentPrice > 0 ? safeMargin(currentPrice, tierCost.total) : null;
    const status = statusForMargin(auditMargin, tierTargetMargin, assumptions.warningBandPct);
    return {
      id: tier.id || `${qty}`,
      label: tierLabel(tier),
      qty,
      tier,
      cost: tierCost,
      targetMargin: tierTargetMargin,
      fixedPrice,
      suggestedPrice,
      auditPrice,
      auditMargin,
      shopifyMargin,
      status,
      priceSource: fixedPrice && fixedPrice > 0 ? "fixed tier price" : "suggested from margin",
    };
  });
}

function clampAuditLimit(value: any) {
  return Math.min(600, Math.max(25, Math.round(numberOr(value, DEFAULT_AUDIT_LIMIT))));
}

async function getMarginReviewSettings(prisma: any, shop: string) {
  const existing = await prisma.marginReviewSetting.findFirst({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) return existing;

  return prisma.marginReviewSetting.create({
    data: {
      shop,
      laborRatePerHour: DEFAULT_SHOP_LABOR_RATE_PER_HOUR,
      applicationLaborFloorPerSide: 0.20,
      auditRowLimit: DEFAULT_AUDIT_LIMIT,
      warningBandPct: DEFAULT_WARNING_BAND_PCT,
      costReviewThresholdPct: DEFAULT_COST_REVIEW_THRESHOLD_PCT,
      active: true,
    },
  });
}

function assumptionsFromSettings(settings: any, url: URL) {
  const hasLaborOverride = url.searchParams.has("laborRatePerHour");
  const hasFloorOverride = url.searchParams.has("applicationLaborCostPerSide");
  const hasLimitOverride = url.searchParams.has("auditLimit");
  const hasWarningOverride = url.searchParams.has("warningBandPct");
  const hasCostReviewOverride = url.searchParams.has("costReviewThresholdPct");

  return {
    laborRatePerHour: numberOr(
      hasLaborOverride ? url.searchParams.get("laborRatePerHour") : settings?.laborRatePerHour,
      DEFAULT_SHOP_LABOR_RATE_PER_HOUR
    ),
    applicationLaborCostPerSide: numberOr(
      hasFloorOverride ? url.searchParams.get("applicationLaborCostPerSide") : settings?.applicationLaborFloorPerSide,
      0.20
    ),
    auditLimit: clampAuditLimit(hasLimitOverride ? url.searchParams.get("auditLimit") : settings?.auditRowLimit),
    warningBandPct: numberOr(
      hasWarningOverride ? url.searchParams.get("warningBandPct") : settings?.warningBandPct,
      DEFAULT_WARNING_BAND_PCT
    ),
    costReviewThresholdPct: numberOr(
      hasCostReviewOverride ? url.searchParams.get("costReviewThresholdPct") : settings?.costReviewThresholdPct,
      DEFAULT_COST_REVIEW_THRESHOLD_PCT
    ),
    usingUrlOverrides: hasLaborOverride || hasFloorOverride || hasLimitOverride || hasWarningOverride || hasCostReviewOverride,
  };
}

async function fetchShopifyVariantMap(admin: any, variantIds: string[]) {
  const uniqueIds = Array.from(new Set(variantIds.filter(Boolean))).slice(0, DEFAULT_AUDIT_LIMIT);
  if (!uniqueIds.length) return new Map<string, any>();

  const response = await admin.graphql(
    `#graphql
      query MarginReviewVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            sku
            price
            product {
              id
              title
              handle
            }
          }
        }
      }
    `,
    { variables: { ids: uniqueIds } }
  );
  const payload = await response.json();
  const map = new Map<string, any>();
  for (const node of payload?.data?.nodes || []) {
    if (node?.id) map.set(node.id, node);
  }
  return map;
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const prisma: any = db;
  const nextUrl = new URL(request.url);

  const data = {
    laborRatePerHour: numberOr(formData.get("laborRatePerHour"), DEFAULT_SHOP_LABOR_RATE_PER_HOUR),
    applicationLaborFloorPerSide: numberOr(formData.get("applicationLaborCostPerSide"), 0.20),
    auditRowLimit: clampAuditLimit(formData.get("auditLimit")),
    warningBandPct: numberOr(formData.get("warningBandPct"), DEFAULT_WARNING_BAND_PCT),
    costReviewThresholdPct: numberOr(formData.get("costReviewThresholdPct"), DEFAULT_COST_REVIEW_THRESHOLD_PCT),
    active: true,
  };

  const existing = await prisma.marginReviewSetting.findFirst({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    await prisma.marginReviewSetting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.marginReviewSetting.create({ data: { shop, ...data } });
  }

  for (const key of ["laborRatePerHour", "applicationLaborCostPerSide", "auditLimit", "warningBandPct", "costReviewThresholdPct"]) {
    nextUrl.searchParams.delete(key);
  }
  nextUrl.searchParams.set("saved", "1");
  return redirect(`${nextUrl.pathname}${nextUrl.search}`);
}

export async function loader({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const search = String(url.searchParams.get("search") || "").trim();
  const recipeId = String(url.searchParams.get("recipeId") || "").trim();
  const status = String(url.searchParams.get("status") || "all");

  const prisma: any = db;
  const savedSettings = await getMarginReviewSettings(prisma, shop);
  const assumptions = assumptionsFromSettings(savedSettings, url);
  const saved = url.searchParams.get("saved") === "1";

  const recipes = await prisma.productRecipe.findMany({
    where: { shop, active: true, ...(recipeId ? { id: recipeId } : {}) },
    include: {
      materials: { include: { material: true } },
      labelZones: { include: { material: true, mediaOption: { include: { material: true } } }, orderBy: { createdAt: "asc" } },
      mediaOptions: { include: { material: true }, orderBy: [{ active: "desc" }, { name: "asc" }] },
      tiers: { orderBy: { minQty: "asc" } },
    },
    orderBy: [{ name: "asc" }],
    take: 50,
  });

  const allRecipesForFilter = await prisma.productRecipe.findMany({
    where: { shop, active: true },
    select: { id: true, name: true, productType: true },
    orderBy: { name: "asc" },
    take: 250,
  });

  const recipeIds = recipes.map((recipe: any) => recipe.id);
  const linkedRules = recipeIds.length
    ? await prisma.recipeVariantRule.findMany({
        where: { shop, recipeId: { in: recipeIds }, active: true },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: 600,
      })
    : [];

  const variantMap = await fetchShopifyVariantMap(admin, linkedRules.map((rule: any) => rule.shopifyVariantGid));
  const recipeById = new Map(recipes.map((recipe: any) => [recipe.id, recipe]));

  const rows = linkedRules.map((rule: any) => {
    const recipe = recipeById.get(rule.recipeId) || {};
    const cost = estimateRecipeVariantUnitCost(recipe, rule, undefined, assumptions);
    const shopify = variantMap.get(rule.shopifyVariantGid) || null;
    const currentPrice = numberOr(shopify?.price, 0);
    const targetMargin = numberOr(recipe.targetMarginPct, 40);
    const suggestedPrice = priceForMargin(cost.total, targetMargin);
    const currentMargin = safeMargin(currentPrice, cost.total);
    const delta = suggestedPrice - currentPrice;
    const statusInfo = statusForMargin(currentMargin, targetMargin, assumptions.warningBandPct);
    const tierReview = buildTierReview(recipe, rule, currentPrice, assumptions);
    const tierIssues = tierReview.filter((tier: any) => tier.auditMargin !== null && tier.auditMargin < tier.targetMargin).length;
    return {
      rule,
      recipe,
      shopify,
      cost,
      currentPrice,
      targetMargin,
      suggestedPrice,
      currentMargin,
      delta,
      status: statusInfo,
      tierReview,
      tierIssues,
    };
  });

  const filteredRows = rows.filter((row: any) => {
    const haystack = normalize([
      row.recipe?.name,
      row.recipe?.sku,
      row.shopify?.product?.title,
      row.shopify?.title,
      row.rule?.shopifyVariantTitle,
      row.rule?.sku,
      row.rule?.bagColor,
      row.rule?.sideMode,
    ].join(" "));
    if (search && !haystack.includes(normalize(search))) return false;
    if (status === "needs_update" && !(row.currentMargin === null || row.currentMargin < row.targetMargin)) return false;
    if (status === "below_target" && !(row.currentMargin !== null && row.currentMargin < row.targetMargin)) return false;
    if (status === "no_price" && row.currentPrice > 0) return false;
    if (status === "cost_review" && !row.cost?.costReviewNeeded) return false;
    if (status === "tier_review" && !row.tierIssues) return false;
    if (status === "approval_queue" && !(!row.currentPrice || row.currentPrice + 0.005 < row.suggestedPrice || row.tierIssues > 0)) return false;
    return true;
  }).slice(0, assumptions.auditLimit);

  const summary = {
    rows: filteredRows.length,
    belowTarget: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin < row.targetMargin).length,
    noPrice: filteredRows.filter((row: any) => !row.currentPrice).length,
    healthy: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin >= row.targetMargin).length,
    costReview: filteredRows.filter((row: any) => row.cost?.costReviewNeeded).length,
    tierReview: filteredRows.filter((row: any) => row.tierIssues > 0).length,
    priceQueue: filteredRows.filter((row: any) => !row.currentPrice || row.currentPrice + 0.005 < row.suggestedPrice || row.tierIssues > 0).length,
    avgCost: filteredRows.length ? filteredRows.reduce((sum: number, row: any) => sum + row.cost.total, 0) / filteredRows.length : 0,
  };

  const approvalRows = filteredRows
    .filter((row: any) => !row.currentPrice || row.currentPrice + 0.005 < row.suggestedPrice || row.tierIssues > 0)
    .slice(0, 50)
    .map((row: any) => ({
      id: row.rule.id,
      productTitle: row.shopify?.product?.title || row.rule.shopifyProductGid || "Shopify product",
      variantTitle: row.shopify?.title || ruleTitle(row.rule),
      recipeName: row.recipe?.name,
      currentPrice: row.currentPrice,
      suggestedPrice: row.suggestedPrice,
      targetMargin: row.targetMargin,
      currentMargin: row.currentMargin,
      delta: row.suggestedPrice - row.currentPrice,
      estimatedCost: row.cost.total,
      costReviewNeeded: row.cost.costReviewNeeded,
      tierIssues: row.tierIssues,
      action: !row.currentPrice ? "Add price" : row.currentPrice + 0.005 < row.suggestedPrice ? "Raise price" : row.tierIssues > 0 ? "Review tiers" : "No action",
    }));

  return Response.json({ recipes: allRecipesForFilter, rows: filteredRows, summary, approvalRows, assumptions, savedSettings, saved, filters: { search, recipeId, status } });
}

function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${tone || "gray"}`}>{children}</span>;
}

export default function MarginReviewPage() {
  const { recipes, rows, summary, approvalRows, filters, assumptions, saved } = useLoaderData<any>();

  return (
    <div className="page">
      <style>{`
        .page { max-width: 1200px; margin: 0 auto; padding: 28px; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
        .hero { background: linear-gradient(135deg, #16002e, #4b0a74); color: white; border-radius: 14px; padding: 24px; margin-bottom: 16px; }
        .hero h1 { margin: 0 0 6px; font-size: 28px; }
        .hero p { margin: 0; color: #f2e8ff; }
        .card { background: white; border: 1px solid #dfe3e8; border-radius: 12px; padding: 16px; margin: 14px 0; box-shadow: 0 1px 0 rgba(0,0,0,0.02); }
        .grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
        .filters { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: end; }
        label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px; }
        input, select { width: 100%; padding: 9px 10px; border: 1px solid #c9cccf; border-radius: 8px; background: white; }
        button, .button { background: #111827; color: white; border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-block; }
        .muted { color: #6b7280; font-size: 12px; }
        .stat { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; background: #fafafa; }
        .stat strong { display: block; font-size: 22px; margin-top: 4px; }
        .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 700; margin-right: 6px; }
        .green { background: #dcfce7; color: #166534; }
        .yellow { background: #fef3c7; color: #92400e; }
        .red { background: #fee2e2; color: #991b1b; }
        .gray { background: #f3f4f6; color: #374151; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; background: #f6f6f7; padding: 10px; border-bottom: 1px solid #e5e7eb; }
        td { padding: 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
        .right { text-align: right; }
        .price-low { color: #991b1b; font-weight: 800; }
        .healthy-text { color: #166534; font-weight: 800; }
        details.cost-details { margin-top: 6px; text-align: left; }
        details.cost-details summary { cursor: pointer; font-weight: 700; color: #374151; }
        .cost-lines { margin-top: 6px; display: grid; gap: 3px; font-size: 12px; color: #4b5563; }
        .cost-line { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed #e5e7eb; padding-bottom: 2px; }
        .cost-line.child { padding-left: 14px; color: #6b7280; }
        .cost-line.note { color: #6b7280; background: #fafafa; }
        .cost-line.total { margin-top: 4px; padding-top: 4px; border-top: 1px solid #d1d5db; font-weight: 900; color: #111827; }
        .cost-line.formula { color: #374151; font-style: italic; border-bottom: 0; }
        .warn { color: #92400e; font-weight: 800; }
        .tier-table { margin-top: 8px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
        .tier-table table { font-size: 12px; }
        .tier-table th, .tier-table td { padding: 6px 8px; }
        .tier-note { margin-top: 6px; padding: 8px; border-radius: 8px; background: #f9fafb; color: #4b5563; font-size: 12px; }
        .queue-note { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .settings-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: end; }
        .queue-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        .button.secondary { background: #e5e7eb; color: #111827; }
        .button.disabled { opacity: 0.55; cursor: not-allowed; }
        @media (max-width: 900px) { .grid, .filters, .settings-grid { grid-template-columns: 1fr; } }
      `}</style>

      <section className="hero">
        <h1>Margin Review / Price Audit</h1>
        <p>Compare linked Shopify variant prices against recipe costs, target margins, and suggested prices before updating Shopify.</p>
      </section>

      <section className="card">
        <strong>Safe review workflow</strong>
        <p className="muted">
          This version is still read-only, but now uses the same recipe pieces we built in Product Setup: base materials, label zones, media options, waste, setup/prepress, packing, and per-side application labor. It does not update Shopify prices yet.
        </p>
        <Badge tone="green">Read-only</Badge>
        <Badge tone="yellow">Clear cost breakdown</Badge>
        <Badge tone="yellow">Tier-aware review</Badge>
        <Badge tone="yellow">Approval queue preview</Badge>
        <Badge tone="yellow">Saved shop assumptions</Badge>
        <Badge tone="gray">Price update later</Badge>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Cost Assumption Settings</h2>
        <p className="muted">Save your real shop defaults here so Margin Review opens with the correct numbers every time. URL overrides still work for quick tests, but saved settings are now the official defaults for this screen.</p>
        {saved ? <p className="muted" style={{ color: "#166534", fontWeight: 800 }}>Saved. Margin Review will now open with these shop assumptions.</p> : null}
        {assumptions.usingUrlOverrides ? <p className="muted warn">You are viewing temporary URL overrides. Click Save assumptions to make these the official shop defaults.</p> : null}
        <Form method="post" className="settings-grid">
          <input type="hidden" name="recipeId" value={filters.recipeId || ""} />
          <input type="hidden" name="search" value={filters.search || ""} />
          <input type="hidden" name="status" value={filters.status || "all"} />
          <div>
            <label>Shop labor rate / hour</label>
            <input name="laborRatePerHour" type="number" step="0.01" min="0" defaultValue={assumptions.laborRatePerHour} />
          </div>
          <div>
            <label>Application labor floor / printed side</label>
            <input name="applicationLaborCostPerSide" type="number" step="0.01" min="0" defaultValue={assumptions.applicationLaborCostPerSide} />
          </div>
          <div>
            <label>Audit row limit</label>
            <input name="auditLimit" type="number" step="25" min="25" max="600" defaultValue={assumptions.auditLimit} />
          </div>
          <div>
            <label>Target margin warning band %</label>
            <input name="warningBandPct" type="number" step="0.1" min="0" max="50" defaultValue={assumptions.warningBandPct} />
          </div>
          <div>
            <label>Cost review threshold %</label>
            <input name="costReviewThresholdPct" type="number" step="0.1" min="0" max="100" defaultValue={assumptions.costReviewThresholdPct} />
          </div>
          <div><button type="submit">Save assumptions</button></div>
        </Form>
        <p className="muted" style={{ marginTop: 8 }}>Current audit assumptions: {money(assumptions.laborRatePerHour)}/hr labor, {money(assumptions.applicationLaborCostPerSide)} per printed side floor, {assumptions.auditLimit} rows max, {assumptions.warningBandPct}% warning band.</p>
      </section>

      <section className="card">
        <Form method="get" className="filters">
          <input type="hidden" name="laborRatePerHour" value={assumptions.laborRatePerHour} />
          <input type="hidden" name="applicationLaborCostPerSide" value={assumptions.applicationLaborCostPerSide} />
          <input type="hidden" name="auditLimit" value={assumptions.auditLimit} />
          <input type="hidden" name="warningBandPct" value={assumptions.warningBandPct} />
          <input type="hidden" name="costReviewThresholdPct" value={assumptions.costReviewThresholdPct} />
          <div>
            <label>Recipe</label>
            <select name="recipeId" defaultValue={filters.recipeId || ""}>
              <option value="">All linked recipes</option>
              {recipes.map((recipe: any) => (
                <option key={recipe.id} value={recipe.id}>{recipe.name} ({recipe.productType})</option>
              ))}
            </select>
          </div>
          <div>
            <label>Search</label>
            <input name="search" defaultValue={filters.search || ""} placeholder="variant, product, SKU, color" />
          </div>
          <div>
            <label>Status</label>
            <select name="status" defaultValue={filters.status || "all"}>
              <option value="all">All audited rows</option>
              <option value="needs_update">Needs update / no price</option>
              <option value="below_target">Below target margin</option>
              <option value="no_price">No Shopify price found</option>
              <option value="cost_review">Cost review needed</option>
              <option value="tier_review">Tier below target</option>
              <option value="approval_queue">Price approval candidates</option>
            </select>
          </div>
          <div><button type="submit">Run audit</button></div>
        </Form>
      </section>

      <section className="grid">
        <div className="stat"><span className="muted">Rows shown</span><strong>{summary.rows}</strong></div>
        <div className="stat"><span className="muted">Healthy</span><strong>{summary.healthy}</strong></div>
        <div className="stat"><span className="muted">Below target</span><strong>{summary.belowTarget}</strong></div>
        <div className="stat"><span className="muted">Cost review</span><strong>{summary.costReview}</strong></div>
        <div className="stat"><span className="muted">Tier issues</span><strong>{summary.tierReview}</strong></div>
        <div className="stat"><span className="muted">Avg est. cost</span><strong>{money(summary.avgCost)}</strong></div>
      </section>


      <section className="card">
        <h2 style={{ marginTop: 0 }}>Price Change Approval Queue Preview</h2>
        <div className="queue-note">
          <strong>Read-only queue.</strong> This panel lists variants that would need a price increase, a missing price, or tier review. It does not update Shopify yet. Cost review rows should stay on hold until the recipe cost is approved.
        </div>
        <div className="queue-actions">
          <Badge tone={summary.priceQueue ? "yellow" : "green"}>{summary.priceQueue || 0} candidate row(s)</Badge>
          <span className="button secondary disabled">Approve selected later</span>
          <span className="button secondary disabled">Export queue later</span>
          <span className="button secondary disabled">Update Shopify later</span>
        </div>
        {approvalRows?.length ? (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Action</th>
                <th>Product / Variant</th>
                <th>Recipe</th>
                <th className="right">Cost</th>
                <th className="right">Current</th>
                <th className="right">Suggested</th>
                <th className="right">Delta</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {approvalRows.map((row: any) => (
                <tr key={`queue-${row.id}`}>
                  <td><strong>{row.action}</strong></td>
                  <td><strong>{row.productTitle}</strong><br /><span className="muted">{row.variantTitle}</span></td>
                  <td>{row.recipeName}</td>
                  <td className="right">{money(row.estimatedCost)}</td>
                  <td className="right">{row.currentPrice ? money(row.currentPrice) : "No price"}</td>
                  <td className="right"><strong>{money(row.suggestedPrice)}</strong></td>
                  <td className="right">{money(row.delta)}</td>
                  <td>{row.costReviewNeeded ? <Badge tone="yellow">hold: cost review</Badge> : null}{row.tierIssues ? <Badge tone="yellow">tier review</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>No price increase candidates in the current filtered audit. Healthy rows may still appear below for review.</p>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Audit rows</h2>
        <p className="muted">Showing up to {assumptions.auditLimit} linked Shopify variants. Start with one recipe like 4x5 Sticker Bag, then expand to more products once the numbers look right.</p>
        <table>
          <thead>
            <tr>
              <th>Product / Variant</th>
              <th>Recipe</th>
              <th className="right">Est. cost</th>
              <th className="right">Shopify price</th>
              <th className="right">Target</th>
              <th className="right">Current margin</th>
              <th className="right">Suggested</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row: any) => (
              <tr key={row.rule.id}>
                <td>
                  <strong>{row.shopify?.product?.title || row.rule.shopifyProductGid || "Shopify product"}</strong><br />
                  <span>{row.shopify?.title || ruleTitle(row.rule)}</span><br />
                  <span className="muted">{row.rule.sku || row.shopify?.sku || "No SKU"}</span>
                </td>
                <td>
                  <strong>{row.recipe?.name}</strong><br />
                  <span className="muted">Qty basis: {row.cost.qty}</span>
                </td>
                <td className="right">
                  <strong>{money(row.cost.total)}</strong><br />
                  {row.cost.costReviewNeeded ? <Badge tone="yellow">review cost</Badge> : null}
                  <details className="cost-details">
                    <summary>Breakdown</summary>
                    <div className="cost-lines">
                      <div className="cost-line"><span>Manual material total</span><strong>{money(row.cost.manualMaterialCostPerUnit)}</strong></div>
                      {(row.cost.materialLines || []).map((line: any, index: number) => (
                        <div className="cost-line child" key={`mat-${index}`}><span>↳ {line.name} ({line.quantity} {line.unitText}{line.includeWaste && line.wastePct ? ` + ${line.wastePct}% waste` : ""})</span><strong>{money(line.cost)}</strong></div>
                      ))}
                      <div className="cost-line note"><span>Base/blank portion inside material total</span><strong>{money(row.cost.baseMaterialCostPerUnit)}</strong></div>
                      <div className="cost-line"><span>Label/media zone total ({row.cost.printedSides} side{row.cost.printedSides === 1 ? "" : "s"}, {row.cost.labelSqftPerUnit.toFixed(4)} sqft)</span><strong>{money(row.cost.labelMediaCostPerUnit)}</strong></div>
                      {(row.cost.zoneLines || []).map((line: any, index: number) => (
                        <div className="cost-line child" key={`zone-${index}`}><span>↳ {line.side} {line.name}: {line.materialName} / {line.sqft.toFixed(4)} sqft</span><strong>{money(line.cost)}</strong></div>
                      ))}
                      <div className="cost-line"><span>Application labor total</span><strong>{money(row.cost.applicationLaborCostPerUnit)}</strong></div>
                      {(row.cost.applicationLaborLines || []).map((line: any, index: number) => (
                        <div className="cost-line child" key={`labor-${index}`}><span>↳ {line.side} application labor ({line.applicationSeconds.toFixed(1)} sec; floor {money(line.floorCost)})</span><strong>{money(line.appliedCost)}</strong></div>
                      ))}
                      <div className="cost-line note"><span>Application by seconds total ({row.cost.applicationSecondsPerUnit.toFixed(1)} sec @ {money(row.cost.laborRate)}/hr)</span><strong>{money(row.cost.applicationLaborFromSeconds)}</strong></div>
                      <div className="cost-line note"><span>Per-side labor floor total</span><strong>{money(row.cost.applicationLaborFloor)}</strong></div>
                      <div className="cost-line"><span>Packing labor</span><strong>{money(row.cost.packingLaborCostPerUnit)}</strong></div>
                      <div className="cost-line"><span>Prepress labor / unit</span><strong>{money(row.cost.prepressLaborCostPerUnit)}</strong></div>
                      <div className="cost-line"><span>Setup labor / unit</span><strong>{money(row.cost.setupLaborCostPerUnit)}</strong></div>
                      <div className="cost-line"><span>Setup cost / unit</span><strong>{money(row.cost.setupCostPerUnit)}</strong></div>
                      <div className="cost-line total"><span>Total estimated cost</span><strong>{money(row.cost.total)}</strong></div>
                      <div className="cost-line formula"><span>Suggested price formula</span><strong>cost ÷ (1 - target margin)</strong></div>
                    </div>
                    {row.cost.applicationLaborFloorApplied ? <p className="muted warn">Labor floor applied because application seconds are lower than the selected per-side labor floor.</p> : null}
                    {row.cost.missingBaseCost ? <p className="muted warn">No base/blank item detected in recipe material rows.</p> : null}
                    {row.cost.missingZones ? <p className="muted warn">No active label zones detected for this variant.</p> : null}
                  </details>
                  <details className="cost-details">
                    <summary>Tier review</summary>
                    <div className="tier-note">Tier costs are recalculated at each tier quantity so setup/prepress cost spreads correctly. This is read-only and does not update Shopify.</div>
                    <div className="tier-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Tier</th>
                            <th className="right">Cost</th>
                            <th className="right">Target</th>
                            <th className="right">Tier price</th>
                            <th className="right">Margin</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(row.tierReview || []).map((tier: any) => (
                            <tr key={tier.id}>
                              <td><strong>{tier.label}</strong><br /><span className="muted">Qty basis {tier.qty}</span></td>
                              <td className="right">{money(tier.cost.total)}</td>
                              <td className="right">{pct(tier.targetMargin)}</td>
                              <td className="right"><strong>{money(tier.auditPrice)}</strong><br /><span className="muted">{tier.priceSource}</span></td>
                              <td className="right">{tier.auditMargin === null ? "No price" : pct(tier.auditMargin)}</td>
                              <td><Badge tone={tier.status.tone}>{tier.status.label}</Badge>{tier.cost.costReviewNeeded ? <Badge tone="yellow">cost review</Badge> : null}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="tier-note">Current Shopify base price: {money(row.currentPrice)}. Future patches will compare/edit quantity-tier prices separately from base Shopify price.</div>
                  </details>
                </td>
                <td className="right"><strong>{money(row.currentPrice)}</strong></td>
                <td className="right">{pct(row.targetMargin)}</td>
                <td className="right">
                  {row.currentMargin === null ? <span className="price-low">No price</span> : <span className={row.currentMargin >= row.targetMargin ? "healthy-text" : "price-low"}>{pct(row.currentMargin)}</span>}
                </td>
                <td className="right"><strong>{money(row.suggestedPrice)}</strong><br /><span className="muted">Δ {money(row.delta)}</span></td>
                <td>
                  <Badge tone={row.status.tone}>{row.status.label}</Badge>
                  {row.cost.costReviewNeeded ? <Badge tone="yellow">cost review</Badge> : null}
                  {row.tierIssues ? <Badge tone="yellow">tier review</Badge> : null}
                </td>
              </tr>
            )) : (
              <tr><td colSpan={8}>No linked Shopify variant rows found for this filter yet. Link products/collections on Shopify Links first.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Next phase</h2>
        <p className="muted">This read-only audit now includes adjustable cost assumptions and tier-aware cost recalculation. Next patches should add approval records and safe Shopify price updates.</p>
        <Badge tone="green">v6 cost assumptions</Badge>
        <Badge tone="gray">v7 approval records</Badge>
        <Badge tone="gray">v8 update Shopify prices</Badge>
      </section>
    </div>
  );
}
