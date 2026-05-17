import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const DEFAULT_SHOP_LABOR_RATE_PER_HOUR = 25;
const DEFAULT_APPLICATION_LABOR_COST_PER_SIDE = 0.15;
const DEFAULT_AUDIT_LIMIT = 150;

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

function estimateRecipeVariantUnitCost(recipe: any, rule: any) {
  const qty = Math.max(1, Math.round(numberOr(recipe.defaultQuantity, numberOr(recipe.minQuantity, 1))));
  const laborRate = numberOr(recipe.laborRatePerHour, DEFAULT_SHOP_LABOR_RATE_PER_HOUR) || DEFAULT_SHOP_LABOR_RATE_PER_HOUR;
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
  const applicationLaborFloor = printedSides ? printedSides * DEFAULT_APPLICATION_LABOR_COST_PER_SIDE : 0;
  const applicationLaborCostPerUnit = Math.max(applicationLaborFromSeconds, applicationLaborFloor);
  const applicationLaborFloorApplied = applicationLaborCostPerUnit > applicationLaborFromSeconds + 0.00001;
  const applicationLaborLines = zoneLines.map((line: any) => {
    const secondsCost = (line.applicationSeconds / 3600) * laborRate;
    const floorCost = DEFAULT_APPLICATION_LABOR_COST_PER_SIDE;
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

function statusForMargin(currentMargin: number | null, targetMargin: number) {
  if (currentMargin === null) return { tone: "yellow", label: "no price" };
  if (currentMargin < targetMargin - 5) return { tone: "red", label: "price low" };
  if (currentMargin < targetMargin) return { tone: "yellow", label: "near target" };
  return { tone: "green", label: "healthy" };
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

export async function loader({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const search = String(url.searchParams.get("search") || "").trim();
  const recipeId = String(url.searchParams.get("recipeId") || "").trim();
  const status = String(url.searchParams.get("status") || "all");

  const prisma: any = db;

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
    const cost = estimateRecipeVariantUnitCost(recipe, rule);
    const shopify = variantMap.get(rule.shopifyVariantGid) || null;
    const currentPrice = numberOr(shopify?.price, 0);
    const targetMargin = numberOr(recipe.targetMarginPct, 40);
    const suggestedPrice = priceForMargin(cost.total, targetMargin);
    const currentMargin = safeMargin(currentPrice, cost.total);
    const delta = suggestedPrice - currentPrice;
    const statusInfo = statusForMargin(currentMargin, targetMargin);
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
    return true;
  }).slice(0, DEFAULT_AUDIT_LIMIT);

  const summary = {
    rows: filteredRows.length,
    belowTarget: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin < row.targetMargin).length,
    noPrice: filteredRows.filter((row: any) => !row.currentPrice).length,
    healthy: filteredRows.filter((row: any) => row.currentMargin !== null && row.currentMargin >= row.targetMargin).length,
    costReview: filteredRows.filter((row: any) => row.cost?.costReviewNeeded).length,
    avgCost: filteredRows.length ? filteredRows.reduce((sum: number, row: any) => sum + row.cost.total, 0) / filteredRows.length : 0,
  };

  return Response.json({ recipes: allRecipesForFilter, rows: filteredRows, summary, filters: { search, recipeId, status } });
}

function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${tone || "gray"}`}>{children}</span>;
}

export default function MarginReviewPage() {
  const { recipes, rows, summary, filters } = useLoaderData<any>();

  return (
    <div className="page">
      <style>{`
        .page { max-width: 1200px; margin: 0 auto; padding: 28px; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
        .hero { background: linear-gradient(135deg, #16002e, #4b0a74); color: white; border-radius: 14px; padding: 24px; margin-bottom: 16px; }
        .hero h1 { margin: 0 0 6px; font-size: 28px; }
        .hero p { margin: 0; color: #f2e8ff; }
        .card { background: white; border: 1px solid #dfe3e8; border-radius: 12px; padding: 16px; margin: 14px 0; box-shadow: 0 1px 0 rgba(0,0,0,0.02); }
        .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
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
        @media (max-width: 900px) { .grid, .filters { grid-template-columns: 1fr; } }
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
        <Badge tone="yellow">$0.15/side labor floor</Badge>
        <Badge tone="gray">Price update later</Badge>
      </section>

      <section className="card">
        <Form method="get" className="filters">
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
        <div className="stat"><span className="muted">Avg est. cost</span><strong>{money(summary.avgCost)}</strong></div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Audit rows</h2>
        <p className="muted">Showing up to {DEFAULT_AUDIT_LIMIT} linked Shopify variants. Start with one recipe like 4x5 Sticker Bag, then expand to more products once the numbers look right.</p>
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
                    {row.cost.applicationLaborFloorApplied ? <p className="muted warn">Labor floor applied because application seconds are lower than $0.15 per printed side.</p> : null}
                    {row.cost.missingBaseCost ? <p className="muted warn">No base/blank item detected in recipe material rows.</p> : null}
                    {row.cost.missingZones ? <p className="muted warn">No active label zones detected for this variant.</p> : null}
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
        <p className="muted">After this read-only audit is verified, the next patches should add tier-aware Shopify price comparison, approved price change queue, and safe Shopify price updates.</p>
        <Badge tone="gray">v4 tier-aware review</Badge>
        <Badge tone="gray">v5 price change queue</Badge>
        <Badge tone="gray">v6 update Shopify prices</Badge>
      </section>
    </div>
  );
}
