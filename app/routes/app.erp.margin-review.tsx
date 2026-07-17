import { Form, redirect, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const DEFAULT_SHOP_LABOR_RATE_PER_HOUR = 25;
const DEFAULT_APPLICATION_LABOR_COST_PER_SIDE = 0.15;
const DEFAULT_AUDIT_LIMIT = 150;
const DEFAULT_WARNING_BAND_PCT = 5;
const DEFAULT_COST_REVIEW_THRESHOLD_PCT = 0;
const DEFAULT_WHOLESALE_QTY_BREAKS = [1000, 2000, 5000, 10000];

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
  const missingMediaCost = !missingZones && zoneLines.some((line: any) => numberOr(line.cost, 0) <= 0);
  const costReviewReasons = uniqueStrings([
    missingBaseCost ? "Missing base/blank cost. Add a blank bag, jar, box, or base material with a real unit cost." : "",
    missingZones ? "Missing active label/application zones. Add active front/back zones so media and application labor can be calculated." : "",
    missingMediaCost ? "One or more active label/media zones has missing or zero media cost." : "",
  ]);
  const costReviewWarnings = uniqueStrings([
    applicationLaborFloorApplied ? `Warning only: application labor floor applied because zone labor seconds are too low. Current floor: ${money(sideLaborFloor)} per printed side.` : "",
  ]);
  const costReviewNeeded = costReviewReasons.length > 0;

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
    missingMediaCost,
    costReviewReasons,
    costReviewReasonText: costReviewReasons.join("\n"),
    costReviewWarnings,
    costReviewWarningText: costReviewWarnings.join("\n"),
    costReviewSeverity: costReviewNeeded ? "hard_hold" : costReviewWarnings.length ? "warning" : "clean",
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

function idsFromCsv(value: any) {
  return Array.from(new Set(String(value || "").split(",").map((id) => id.trim()).filter(Boolean)));
}

function uniqueStrings(values: any[] = []) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function parseJsonObject(value: any) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function parseJsonArray(value: any) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}


function buildWholesaleBreakReview(recipe: any, rule: any, currentPrice: number, assumptions: any = {}) {
  const targetMargin = numberOr(recipe?.targetMarginPct, 40);
  const breaks = DEFAULT_WHOLESALE_QTY_BREAKS.map((qty) => {
    const cost = estimateRecipeVariantUnitCost(recipe, rule, qty, assumptions);
    const safePrice = priceForMargin(cost.total, targetMargin);
    const currentMargin = currentPrice > 0 ? safeMargin(currentPrice, cost.total) : null;
    return {
      qty,
      cost,
      safePrice,
      currentPrice,
      targetMargin,
      currentMargin,
      costReviewNeeded: cost.costReviewNeeded,
      warnings: cost.costReviewWarnings || [],
    };
  });
  const baseSafePrice = breaks[0]?.safePrice || 0;
  return breaks.map((item) => ({
    ...item,
    discountFromFirstPct: baseSafePrice > 0 ? Math.max(0, ((baseSafePrice - item.safePrice) / baseSafePrice) * 100) : 0,
    status: item.costReviewNeeded
      ? { tone: "yellow", label: "cost hold" }
      : item.currentMargin !== null && item.currentMargin >= item.targetMargin
        ? { tone: "green", label: "safe" }
        : { tone: "yellow", label: "review price" },
  }));
}

function summarizeWholesaleBreaks(breaks: any[] = []) {
  const clean = (breaks || []).filter((item: any) => !item.costReviewNeeded);
  const hardHolds = (breaks || []).filter((item: any) => item.costReviewNeeded).length;
  const reviewPrices = clean.filter((item: any) => item.currentMargin === null || item.currentMargin < item.targetMargin).length;
  return { clean: clean.length, hardHolds, reviewPrices };
}

function approvalStatusForRow(row: any) {
  return row?.costReviewNeeded ? "cost_review_hold" : "needs_review";
}

function approvalReasonForRow(row: any) {
  const warningText = Array.isArray(row?.costReviewWarnings)
    ? row.costReviewWarnings.join("\n")
    : String(row?.costReviewWarningText || "");
  return uniqueStrings([
    row?.costReviewNeeded ? "Hard cost-review hold. Fix missing recipe costs/setup before approval." : "",
    warningText ? warningText : "",
    numberOr(row?.tierIssues, 0) > 0 ? "One or more pricing tiers is below target margin." : "",
    !numberOr(row?.currentPrice, 0) ? "Shopify variant has no current price." : "",
    numberOr(row?.currentPrice, 0) && numberOr(row?.currentPrice, 0) + 0.005 < numberOr(row?.suggestedPrice, 0) ? "Current Shopify price is below suggested target-margin price." : "",
  ]).join("\n");
}

function cleanApprovalRows(value: any) {
  return parseJsonArray(value).map((row: any) => ({
    variantRuleId: String(row?.variantRuleId || row?.id || "").trim(),
    recipeId: String(row?.recipeId || "").trim() || null,
    recipeName: String(row?.recipeName || "").trim() || null,
    shopifyProductGid: String(row?.shopifyProductGid || "").trim() || null,
    shopifyVariantGid: String(row?.shopifyVariantGid || "").trim() || null,
    productTitle: String(row?.productTitle || "").trim() || null,
    variantTitle: String(row?.variantTitle || "").trim() || null,
    currentPrice: row?.currentPrice === null || row?.currentPrice === undefined ? null : numberOr(row.currentPrice, 0),
    suggestedPrice: numberOr(row?.suggestedPrice, 0),
    estimatedCost: numberOr(row?.estimatedCost, 0),
    targetMarginPct: numberOr(row?.targetMargin, 0),
    currentMarginPct: row?.currentMargin === null || row?.currentMargin === undefined ? null : numberOr(row.currentMargin, 0),
    delta: numberOr(row?.delta, 0),
    action: String(row?.action || "Review price").trim(),
    costReviewNeeded: !!row?.costReviewNeeded,
    costReviewWarnings: Array.isArray(row?.costReviewWarnings) ? row.costReviewWarnings.map((item: any) => String(item || "").trim()).filter(Boolean) : [],
    costReviewWarningText: String(row?.costReviewWarningText || "").trim(),
    costReviewSeverity: String(row?.costReviewSeverity || (row?.costReviewNeeded ? "hard_hold" : "clean")),
    tierIssues: Math.max(0, Math.round(numberOr(row?.tierIssues, 0))),
  })).filter((row: any) => row.variantRuleId && row.suggestedPrice > 0);
}


function formIds(formData: FormData, field = "recordIds") {
  return Array.from(new Set(formData.getAll(field).map((id) => String(id || "").trim()).filter(Boolean)));
}

function approvalBadgeTone(status: string) {
  if (status === "approved" || status === "updated_in_shopify") return "green";
  if (status === "cost_review_hold") return "yellow";
  if (status === "rejected") return "red";
  if (status === "skipped") return "gray";
  return "blue";
}

function approvalStatusLabel(status: string) {
  const labels: Record<string, string> = {
    needs_review: "needs review",
    cost_review_hold: "cost-review hold",
    approved: "approved",
    rejected: "rejected",
    skipped: "skipped",
    updated_in_shopify: "updated in Shopify",
  };
  return labels[status] || status;
}

async function updateShopifyVariantPrice(admin: any, variantId: string, price: number) {
  const response = await admin.graphql(
    `#graphql
      mutation MarginReviewUpdateVariantPrice($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          productVariant { id price }
          userErrors { field message }
        }
      }
    `,
    { variables: { input: { id: variantId, price: price.toFixed(2) } } }
  );
  const payload = await response.json();
  const errors = payload?.data?.productVariantUpdate?.userErrors || payload?.errors || [];
  if (errors.length) {
    return { ok: false, error: errors.map((item: any) => item.message || JSON.stringify(item)).join("; ") };
  }
  return { ok: true, variant: payload?.data?.productVariantUpdate?.productVariant || null };
}

export async function action({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const prisma: any = db;
  const nextUrl = new URL(request.url);
  const intent = String(formData.get("intent") || "saveAssumptions");

  if (intent === "reviewApprovalRecords") {
    const ids = formIds(formData).slice(0, 100);
    const nextStatus = String(formData.get("nextStatus") || "");
    const allowed = new Set(["approved", "rejected", "skipped"]);
    let changed = 0;
    let heldBlocked = 0;

    if (ids.length && allowed.has(nextStatus)) {
      const records = await prisma.priceApprovalRecord.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, status: true, costReviewNeeded: true },
      });

      for (const record of records) {
        if (nextStatus === "approved" && (record.costReviewNeeded || record.status === "cost_review_hold")) {
          heldBlocked += 1;
          continue;
        }
        const data: any = { status: nextStatus };
        if (nextStatus === "approved") data.approvedAt = new Date();
        if (nextStatus === "rejected") data.rejectedAt = new Date();
        await prisma.priceApprovalRecord.update({ where: { id: record.id }, data });
        changed += 1;
      }
    }

    nextUrl.searchParams.set("approvalAction", "1");
    nextUrl.searchParams.set("approvalChanged", String(changed));
    nextUrl.searchParams.set("approvalBlocked", String(heldBlocked));
    return redirect(`${nextUrl.pathname}${nextUrl.search}`);
  }

  if (intent === "safeShopifyPriceUpdate") {
    const approvedRecords = await prisma.priceApprovalRecord.findMany({
      where: {
        shop,
        status: "approved",
        costReviewNeeded: false,
        shopifyVariantGid: { not: null },
        suggestedPrice: { gt: 0 },
      },
      orderBy: [{ approvedAt: "asc" }, { updatedAt: "asc" }],
      take: 25,
    });

    let updated = 0;
    let failed = 0;
    for (const record of approvedRecords) {
      const result = await updateShopifyVariantPrice(admin, record.shopifyVariantGid, record.suggestedPrice);
      if (result.ok) {
        await prisma.priceApprovalRecord.update({
          where: { id: record.id },
          data: {
            status: "updated_in_shopify",
            currentPrice: record.suggestedPrice,
            delta: 0,
            updatedInShopifyAt: new Date(),
            reason: [record.reason, `Updated Shopify price to ${money(record.suggestedPrice)} from Margin Review approval.`].filter(Boolean).join("\n"),
          },
        });
        updated += 1;
      } else {
        await prisma.priceApprovalRecord.update({
          where: { id: record.id },
          data: {
            reason: [record.reason, `Shopify update failed: ${result.error}`].filter(Boolean).join("\n"),
          },
        });
        failed += 1;
      }
    }

    nextUrl.searchParams.set("shopifyUpdated", "1");
    nextUrl.searchParams.set("shopifyUpdatedCount", String(updated));
    nextUrl.searchParams.set("shopifyFailedCount", String(failed));
    return redirect(`${nextUrl.pathname}${nextUrl.search}`);
  }

  if (intent === "createPriceApprovalRecords") {
    const approvalRows = cleanApprovalRows(formData.get("approvalRowsJson")).slice(0, 100);
    const createdAt = new Date();
    let written = 0;
    let held = 0;

    for (const row of approvalRows) {
      const desiredStatus = approvalStatusForRow(row);
      if (desiredStatus === "cost_review_hold") held += 1;
      const existing = await prisma.priceApprovalRecord.findUnique({
        where: { shop_variantRuleId: { shop, variantRuleId: row.variantRuleId } },
        select: { id: true, status: true },
      });
      const status = existing?.status === "approved" || existing?.status === "rejected" || existing?.status === "updated_in_shopify"
        ? existing.status
        : desiredStatus;

      await prisma.priceApprovalRecord.upsert({
        where: { shop_variantRuleId: { shop, variantRuleId: row.variantRuleId } },
        create: {
          shop,
          source: "margin_review_v9",
          variantRuleId: row.variantRuleId,
          recipeId: row.recipeId,
          recipeName: row.recipeName,
          shopifyProductGid: row.shopifyProductGid,
          shopifyVariantGid: row.shopifyVariantGid,
          productTitle: row.productTitle,
          variantTitle: row.variantTitle,
          currentPrice: row.currentPrice,
          suggestedPrice: row.suggestedPrice,
          estimatedCost: row.estimatedCost,
          targetMarginPct: row.targetMarginPct,
          currentMarginPct: row.currentMarginPct,
          delta: row.delta,
          action: row.action,
          status,
          reason: approvalReasonForRow(row),
          costReviewNeeded: row.costReviewNeeded,
          tierIssues: row.tierIssues,
          createdAt,
        },
        update: {
          source: "margin_review_v9",
          recipeId: row.recipeId,
          recipeName: row.recipeName,
          shopifyProductGid: row.shopifyProductGid,
          shopifyVariantGid: row.shopifyVariantGid,
          productTitle: row.productTitle,
          variantTitle: row.variantTitle,
          currentPrice: row.currentPrice,
          suggestedPrice: row.suggestedPrice,
          estimatedCost: row.estimatedCost,
          targetMarginPct: row.targetMarginPct,
          currentMarginPct: row.currentMarginPct,
          delta: row.delta,
          action: row.action,
          status,
          reason: approvalReasonForRow(row),
          costReviewNeeded: row.costReviewNeeded,
          tierIssues: row.tierIssues,
        },
      });
      written += 1;
    }

    nextUrl.searchParams.set("approvalsCreated", "1");
    nextUrl.searchParams.set("approvalCount", String(written));
    nextUrl.searchParams.set("approvalHeld", String(held));
    return redirect(`${nextUrl.pathname}${nextUrl.search}`);
  }

  if (intent === "syncCostReviewFlags") {
    const flagRecipeIds = idsFromCsv(formData.get("flagRecipeIds"));
    const clearRecipeIds = idsFromCsv(formData.get("clearRecipeIds")).filter((id) => !flagRecipeIds.includes(id));
    const flagRecipeReasons = parseJsonObject(formData.get("flagRecipeReasonsJson"));
    const syncedAt = new Date();

    if (flagRecipeIds.length) {
      await Promise.all(flagRecipeIds.map((id) => prisma.productRecipe.updateMany({
        where: { shop, id },
        data: {
          costReviewNeeded: true,
          costReviewReasons: Array.isArray(flagRecipeReasons[id]) ? flagRecipeReasons[id].join("\n") : String(flagRecipeReasons[id] || "Needs recipe cost review before price approval."),
          costReviewSyncedAt: syncedAt,
          costReviewSource: "margin_review_v8_1",
        },
      })));
    }

    if (clearRecipeIds.length) {
      await prisma.productRecipe.updateMany({
        where: { shop, id: { in: clearRecipeIds } },
        data: {
          costReviewNeeded: false,
          costReviewReasons: null,
          costReviewSyncedAt: syncedAt,
          costReviewSource: "margin_review_v8_1",
        },
      });
    }

    nextUrl.searchParams.set("flagsSynced", "1");
    nextUrl.searchParams.set("flagged", String(flagRecipeIds.length));
    nextUrl.searchParams.set("cleared", String(clearRecipeIds.length));
    return redirect(`${nextUrl.pathname}${nextUrl.search}`);
  }

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
  const flagsSynced = url.searchParams.get("flagsSynced") === "1";
  const syncedFlagged = Math.max(0, Math.round(numberOr(url.searchParams.get("flagged"), 0)));
  const syncedCleared = Math.max(0, Math.round(numberOr(url.searchParams.get("cleared"), 0)));
  const approvalsCreated = url.searchParams.get("approvalsCreated") === "1";
  const approvalCount = Math.max(0, Math.round(numberOr(url.searchParams.get("approvalCount"), 0)));
  const approvalHeld = Math.max(0, Math.round(numberOr(url.searchParams.get("approvalHeld"), 0)));
  const approvalAction = url.searchParams.get("approvalAction") === "1";
  const approvalChanged = Math.max(0, Math.round(numberOr(url.searchParams.get("approvalChanged"), 0)));
  const approvalBlocked = Math.max(0, Math.round(numberOr(url.searchParams.get("approvalBlocked"), 0)));
  const shopifyUpdated = url.searchParams.get("shopifyUpdated") === "1";
  const shopifyUpdatedCount = Math.max(0, Math.round(numberOr(url.searchParams.get("shopifyUpdatedCount"), 0)));
  const shopifyFailedCount = Math.max(0, Math.round(numberOr(url.searchParams.get("shopifyFailedCount"), 0)));

  const approvalStatusCounts = await prisma.priceApprovalRecord.groupBy({
    by: ["status"],
    where: { shop },
    _count: { _all: true },
  }).catch(() => []);
  const approvalSummary = approvalStatusCounts.reduce((map: any, item: any) => {
    map[item.status] = item._count?._all || 0;
    return map;
  }, {});

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
    const wholesaleBreaks = buildWholesaleBreakReview(recipe, rule, currentPrice, assumptions);
    const wholesaleSummary = summarizeWholesaleBreaks(wholesaleBreaks);
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
      wholesaleBreaks,
      wholesaleSummary,
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

  const auditedRecipeIds = Array.from(new Set(filteredRows.map((row: any) => row.recipe?.id).filter(Boolean)));
  const flagRecipeIds = Array.from(new Set(filteredRows.filter((row: any) => row.cost?.costReviewNeeded).map((row: any) => row.recipe?.id).filter(Boolean)));
  const clearRecipeIds = auditedRecipeIds.filter((id: any) => !flagRecipeIds.includes(id));
  const flagRecipeNames = recipes.filter((recipe: any) => flagRecipeIds.includes(recipe.id)).map((recipe: any) => recipe.name).slice(0, 8);
  const flagRecipeReasons = filteredRows.reduce((map: any, row: any) => {
    if (!row.recipe?.id || !row.cost?.costReviewNeeded) return map;
    map[row.recipe.id] = uniqueStrings([...(map[row.recipe.id] || []), ...(row.cost?.costReviewReasons || [])]);
    return map;
  }, {});
  const flagRecipeReasonPreview = Object.entries(flagRecipeReasons).slice(0, 5).map(([id, reasons]: any) => {
    const recipe = recipes.find((item: any) => item.id === id);
    return { id, name: recipe?.name || id, reasons };
  });

  const recipeFlagPreview = {
    auditedRecipeIds,
    flagRecipeIds,
    clearRecipeIds,
    flagRecipeReasons,
    flagRecipeReasonPreview,
    flagCount: flagRecipeIds.length,
    clearCount: clearRecipeIds.length,
    flagRecipeNames,
  };

  const summary = {
    rows: filteredRows.length,
    belowTarget: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin < row.targetMargin).length,
    noPrice: filteredRows.filter((row: any) => !row.currentPrice).length,
    healthy: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin >= row.targetMargin).length,
    costReview: filteredRows.filter((row: any) => row.cost?.costReviewNeeded).length,
    costWarnings: filteredRows.filter((row: any) => !row.cost?.costReviewNeeded && row.cost?.costReviewWarnings?.length).length,
    tierReview: filteredRows.filter((row: any) => row.tierIssues > 0).length,
    priceQueue: filteredRows.filter((row: any) => !row.currentPrice || row.currentPrice + 0.005 < row.suggestedPrice || row.tierIssues > 0).length,
    wholesaleRows: filteredRows.filter((row: any) => row.wholesaleBreaks?.length).length,
    wholesaleReview: filteredRows.reduce((sum: number, row: any) => sum + numberOr(row.wholesaleSummary?.reviewPrices, 0), 0),
    avgCost: filteredRows.length ? filteredRows.reduce((sum: number, row: any) => sum + row.cost.total, 0) / filteredRows.length : 0,
  };

  const approvalRows = filteredRows
    .filter((row: any) => !row.currentPrice || row.currentPrice + 0.005 < row.suggestedPrice || row.tierIssues > 0)
    .slice(0, 50)
    .map((row: any) => ({
      id: row.rule.id,
      variantRuleId: row.rule.id,
      recipeId: row.recipe?.id,
      shopifyProductGid: row.rule.shopifyProductGid || row.shopify?.product?.id || null,
      shopifyVariantGid: row.rule.shopifyVariantGid || row.shopify?.id || null,
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
      costReviewWarnings: row.cost.costReviewWarnings || [],
      costReviewWarningText: row.cost.costReviewWarningText || "",
      costReviewSeverity: row.cost.costReviewSeverity || (row.cost.costReviewNeeded ? "hard_hold" : "clean"),
      tierIssues: row.tierIssues,
      action: !row.currentPrice ? "Add price" : row.currentPrice + 0.005 < row.suggestedPrice ? "Raise price" : row.tierIssues > 0 ? "Review tiers" : "No action",
    }));

  const savedApprovalRecords = await prisma.priceApprovalRecord.findMany({
    where: { shop },
    orderBy: [{ updatedAt: "desc" }],
    take: 100,
  }).catch(() => []);

  return Response.json({ recipes: allRecipesForFilter, rows: filteredRows, summary, approvalRows, savedApprovalRecords, approvalSummary, approvalsCreated, approvalCount, approvalHeld, approvalAction, approvalChanged, approvalBlocked, shopifyUpdated, shopifyUpdatedCount, shopifyFailedCount, assumptions, savedSettings, saved, flagsSynced, syncedFlagged, syncedCleared, recipeFlagPreview, filters: { search, recipeId, status } });
}

function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${tone || "gray"}`}>{children}</span>;
}

export default function MarginReviewPage() {
  const { recipes, rows, summary, approvalRows, savedApprovalRecords, approvalSummary, approvalsCreated, approvalCount, approvalHeld, approvalAction, approvalChanged, approvalBlocked, shopifyUpdated, shopifyUpdatedCount, shopifyFailedCount, filters, assumptions, saved, flagsSynced, syncedFlagged, syncedCleared, recipeFlagPreview } = useLoaderData<any>();

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
        .wholesale-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
        .wholesale-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; background: #fff; }
        .wholesale-card strong { display: block; font-size: 16px; margin-top: 2px; }
        .success-note { background: #ecfdf5; border: 1px solid #bbf7d0; color: #166534; border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 13px; font-weight: 700; }
        .flag-panel { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 12px; margin-top: 12px; }
        .button.secondary { background: #e5e7eb; color: #111827; }
        .button.disabled { opacity: 0.55; cursor: not-allowed; }
        @media (max-width: 900px) { .grid, .filters, .settings-grid { grid-template-columns: 1fr; } }
      `}</style>

      <section className="hero">
        <h1>Margin Review / Price Audit</h1>
        <p>Compare linked Shopify variant prices against recipe costs, target margins, and suggested prices before updating Shopify.</p>
      </section>

      <section style={{ border: "2px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700, margin: "12px 0" }}>
        Owner / advanced tool — changes here can affect live pricing, mappings, or Shopify behavior.
      </section>

      <section className="card">
        <strong>Safe review workflow</strong>
        <p className="muted">
          This version is still read-only, but now uses the same recipe pieces we built in Product Setup: base materials, label zones, media options, waste, setup/prepress, packing, and per-side application labor. It does not update Shopify prices yet.
        </p>
        <Badge tone="green">Read-only</Badge>
        <Badge tone="yellow">Clear cost breakdown</Badge>
        <Badge tone="yellow">Tier-aware review</Badge>
        <Badge tone="yellow">v11 wholesale quantity breaks</Badge>
        <Badge tone="yellow">Approval queue records</Badge>
        <Badge tone="yellow">Saved shop assumptions</Badge>
        <Badge tone="yellow">Recipe cost review flags</Badge>
        <Badge tone="yellow">Approved-only Shopify updater</Badge>
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
        {flagsSynced ? (
          <div className="success-note">Recipe cost review flags synced. Flagged {syncedFlagged} recipe(s) and cleared {syncedCleared} recipe(s) from the current audit.</div>
        ) : null}
        {approvalsCreated ? (
          <div className="success-note">Price approval records saved. Wrote {approvalCount} approval record(s); {approvalHeld} are on cost-review hold until recipe issues are fixed.</div>
        ) : null}
        {approvalAction ? (
          <div className="success-note">Approval review saved. Changed {approvalChanged} record(s). Blocked {approvalBlocked} cost-review hold approval attempt(s).</div>
        ) : null}
        {shopifyUpdated ? (
          <div className="success-note">Shopify price updater ran. Updated {shopifyUpdatedCount} approved record(s). Failed {shopifyFailedCount} record(s).</div>
        ) : null}
        <div className="flag-panel">
          <strong>v8.1 Recipe Cost Review Flags + Details</strong>
          <p className="muted">
            This sync pushes hard cost-review results back into Product Setup. Missing base cost, missing zones, or missing media cost will show as Cost Review in Product Setup. Labor floor use is now a warning only and will not block approval by itself. This still does not update Shopify prices.
          </p>
          <div className="queue-actions">
            <Badge tone={recipeFlagPreview?.flagCount ? "yellow" : "green"}>{recipeFlagPreview?.flagCount || 0} recipe(s) to flag</Badge>
            <Badge tone="gray">{recipeFlagPreview?.clearCount || 0} audited recipe(s) to clear</Badge>
          </div>
          {recipeFlagPreview?.flagRecipeNames?.length ? (
            <div style={{ marginTop: 8 }}>
              <p className="muted">Will flag: {recipeFlagPreview.flagRecipeNames.join(", ")}{recipeFlagPreview.flagCount > recipeFlagPreview.flagRecipeNames.length ? "..." : ""}</p>
              {recipeFlagPreview.flagRecipeReasonPreview?.length ? (
                <details className="cost-details">
                  <summary>Preview review reasons</summary>
                  <div className="cost-lines">
                    {recipeFlagPreview.flagRecipeReasonPreview.map((item: any) => (
                      <div key={item.id} className="tier-note">
                        <strong>{item.name}</strong>
                        <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                          {(item.reasons || []).map((reason: string) => <li key={reason}>{reason}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 8 }}>No cost-review recipes found in the current audit filter.</p>
          )}
          <Form method="post" className="queue-actions">
            <input type="hidden" name="intent" value="syncCostReviewFlags" />
            <input type="hidden" name="flagRecipeIds" value={(recipeFlagPreview?.flagRecipeIds || []).join(",")} />
            <input type="hidden" name="clearRecipeIds" value={(recipeFlagPreview?.clearRecipeIds || []).join(",")} />
            <input type="hidden" name="flagRecipeReasonsJson" value={JSON.stringify(recipeFlagPreview?.flagRecipeReasons || {})} />
            <button type="submit">Sync recipe review flags</button>
            <span className="button secondary disabled">Shopify updates still locked</span>
          </Form>
        </div>
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
        <div className="stat"><span className="muted">Hard cost holds</span><strong>{summary.costReview}</strong></div>
        <div className="stat"><span className="muted">Cost warnings</span><strong>{summary.costWarnings || 0}</strong></div>
        <div className="stat"><span className="muted">Tier issues</span><strong>{summary.tierReview}</strong></div>
        <div className="stat"><span className="muted">Avg est. cost</span><strong>{money(summary.avgCost)}</strong></div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>v11 Wholesale Quantity Break Preview</h2>
        <div className="queue-note">
          <strong>Margin-safe quantity discounts.</strong> This preview calculates safe wholesale prices for 1,000 / 2,000 / 5,000 / 10,000 units using the same recipe cost engine, saved labor assumptions, and target margin. It does not update Shopify yet.
        </div>
        <div className="queue-actions">
          <Badge tone="green">{summary.wholesaleRows || 0} row(s) checked</Badge>
          <Badge tone={(summary.wholesaleReview || 0) ? "yellow" : "green"}>{summary.wholesaleReview || 0} tier price review(s)</Badge>
          <Badge tone="yellow">Shopify quantity pricing still locked</Badge>
        </div>
        {rows?.length ? (
          <div className="wholesale-grid">
            {(rows || []).slice(0, 4).map((row: any) => (
              <div className="wholesale-card" key={`wholesale-${row.rule.id}`}>
                <div className="muted">{row.shopify?.product?.title || row.recipe?.name || "Product"}</div>
                <strong>{row.shopify?.title || ruleTitle(row.rule)}</strong>
                <div className="tier-table" style={{ marginTop: 8 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Qty</th>
                        <th className="right">Safe price</th>
                        <th className="right">Cost</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(row.wholesaleBreaks || []).map((tier: any) => (
                        <tr key={`${row.rule.id}-${tier.qty}`}>
                          <td>{tier.qty.toLocaleString()}</td>
                          <td className="right"><strong>{money(tier.safePrice)}</strong></td>
                          <td className="right">{money(tier.cost.total)}</td>
                          <td><Badge tone={tier.status.tone}>{tier.status.label}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ marginBottom: 0 }}>Target margin: {pct(row.targetMargin)}. Quantity pricing is preview-only until v12/v13.</p>
              </div>
            ))}
          </div>
        ) : <p className="muted">Run an audit to preview wholesale quantity breaks.</p>}
      </section>


      <section className="card">
        <h2 style={{ marginTop: 0 }}>Price Change Approval Queue</h2>
        <div className="queue-note">
          <strong>v10.1 approval workflow.</strong> This panel saves real approval queue rows, lets you approve/reject/skip records, and can update Shopify only for approved rows with no hard cost-review hold. Labor-floor use is now a warning, not an automatic block.
        </div>
        <div className="queue-actions">
          <Badge tone={summary.priceQueue ? "yellow" : "green"}>{summary.priceQueue || 0} current audit candidates</Badge>
          <Badge tone="blue">{approvalSummary?.needs_review || 0} saved clean review</Badge>
          <Badge tone="yellow">{approvalSummary?.cost_review_hold || 0} saved cost holds</Badge>
          <Badge tone="green">{approvalSummary?.approved || 0} approved</Badge>
          <Badge tone="gray">{approvalSummary?.rejected || 0} rejected</Badge>
          <Badge tone="gray">{approvalSummary?.skipped || 0} skipped</Badge>
          <Badge tone="green">{approvalSummary?.updated_in_shopify || 0} updated</Badge>
        </div>
        {approvalRows?.length ? (
          <Form method="post" className="queue-actions">
            <input type="hidden" name="intent" value="createPriceApprovalRecords" />
            <input type="hidden" name="approvalRowsJson" value={JSON.stringify(approvalRows)} />
            <button type="submit">Create / refresh approval records</button>
          </Form>
        ) : null}
        {savedApprovalRecords?.length ? (
          <Form method="post" style={{ marginTop: 12 }}>
            <div className="queue-actions">
              <button type="submit" name="nextStatus" value="approved">Approve selected</button>
              <button type="submit" name="nextStatus" value="rejected">Reject selected</button>
              <button type="submit" name="nextStatus" value="skipped">Skip selected</button>
              <span className="muted">Approvals are blocked only for hard cost-review holds. Warning-only rows can be approved.</span>
            </div>
            <input type="hidden" name="intent" value="reviewApprovalRecords" />
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Select</th>
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
                {savedApprovalRecords.map((row: any) => (
                  <tr key={`approval-${row.id}`}>
                    <td><input type="checkbox" name="recordIds" value={row.id} disabled={row.status === "updated_in_shopify"} /></td>
                    <td><strong>{row.productTitle || "Shopify product"}</strong><br /><span className="muted">{row.variantTitle || "Variant"}</span></td>
                    <td>{row.recipeName || "No recipe"}</td>
                    <td className="right">{money(row.estimatedCost)}</td>
                    <td className="right">{row.currentPrice ? money(row.currentPrice) : "No price"}</td>
                    <td className="right"><strong>{money(row.suggestedPrice)}</strong></td>
                    <td className="right">{money(row.delta)}</td>
                    <td>
                      <Badge tone={approvalBadgeTone(row.status)}>{approvalStatusLabel(row.status)}</Badge>
                      {row.reason ? <details><summary className="muted">Reason</summary><div className="muted" style={{ whiteSpace: "pre-wrap" }}>{row.reason}</div></details> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Form>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>No saved approval records yet. Run the audit, then create approval records.</p>
        )}
        <Form method="post" className="queue-actions">
          <input type="hidden" name="intent" value="safeShopifyPriceUpdate" />
          <button type="submit">Update approved Shopify prices</button>
          <span className="muted">Updates max 25 approved clean records per run. Cost-review holds, rejected rows, skipped rows, and already-updated rows are ignored.</span>
        </Form>
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
                    <div className="tier-note">Current Shopify base price: {money(row.currentPrice)}. v11 now previews quantity-break wholesale pricing. Future patches will let staff edit/approve those tiers and sync them to product pages safely.</div>
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
        <p className="muted">This read-only audit now includes saved shop assumptions, tier-aware cost recalculation, and safe recipe cost-review flag syncing. Next patches should add approval records and safe Shopify price updates.</p>
        <Badge tone="green">v7 saved assumptions</Badge>
        <Badge tone="green">v8 recipe review flags</Badge>
        <Badge tone="gray">v9 approval records</Badge>
        <Badge tone="gray">v10 update Shopify prices</Badge>
      </section>
    </div>
  );
}
