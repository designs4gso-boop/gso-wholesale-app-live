import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  BAG_COLORS,
  FALLBACK_PRICING_ROWS,
  FINISHES,
  MATERIALS,
  MIN_QTY,
  PILOT_PRODUCTS,
  PRODUCT_TYPE,
  PRODUCT_TYPE_LABEL,
  QTY_RANGES,
  rangeLabelFromRule,
} from "../lib/configurator-pricing";

const STOCK_PRODUCT_TYPE = PRODUCT_TYPE;

const JAR_PRODUCT_TYPES = [
  "jar_50ml",
  "jar_100ml_tall",
  "jar_100ml_wide",
  "jar_150ml",
  "jar_250ml",
  "jar_3oz_clear",
  "jar_3oz_black_white",
  "jar_4oz_clear",
  "jar_4oz_black_white",
];

const FAMILY_LABELS: Record<string, string> = {
  stock_bags: "Stock Bags",
  jars: "Jars",
};

function money(value: number) {
  return "$" + Number(value || 0).toFixed(2);
}

function pct(value: number) {
  return Number(value || 0).toFixed(1) + "%";
}

function intParam(url: URL, key: string, fallback: number) {
  const raw = url.searchParams.get(key);
  const parsed = parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textParam(url: URL, key: string, fallback: string) {
  const raw = url.searchParams.get(key);
  return raw && raw.trim() ? raw.trim() : fallback;
}

function uniqueValues(rows: any[], group: string) {
  return rows
    .filter((option) => option.group === group && option.active)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return String(a.value).localeCompare(String(b.value));
    })
    .map((option) => option.value);
}

function coerceOption(requested: string, validOptions: string[], fallback: string, wasMissing = false) {
  if (wasMissing) return validOptions[0] || fallback;
  if (validOptions.includes(requested)) return requested;
  return validOptions[0] || fallback;
}

function intFromText(value: string, fallback: number) {
  const parsed = parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fallbackRangeIndex(qty: number) {
  return Math.max(
    QTY_RANGES.findIndex((range) => {
      if (qty < range.min) return false;
      if (range.max === null) return true;
      return qty <= range.max;
    }),
    0,
  );
}

function fallbackRuleFor(material: string, finish: string, qty: number) {
  const safeQty = Math.max(qty, MIN_QTY);
  const rangeIndex = fallbackRangeIndex(safeQty);
  const row =
    FALLBACK_PRICING_ROWS.find(
      (item) =>
        item.material.toLowerCase() === material.toLowerCase() &&
        item.finish.toLowerCase() === finish.toLowerCase(),
    ) || FALLBACK_PRICING_ROWS[0];

  return {
    material: row.material,
    finish: row.finish,
    productionFinish: row.productionFinish,
    sides: "Double Sided",
    minQty: QTY_RANGES[rangeIndex].min,
    maxQty: QTY_RANGES[rangeIndex].max,
    priceEach: row.prices[rangeIndex] || row.prices[row.prices.length - 1],
    costEach: row.costEach,
    source: "fallback",
  };
}

function rangeLabel(rule: { minQty: number; maxQty: number | null }) {
  return rangeLabelFromRule(rule);
}

function buildRangeColumns(rules: any[]) {
  const map = new Map<string, { label: string; minQty: number; maxQty: number | null }>();

  for (const rule of rules) {
    const label = rangeLabel(rule);
    if (!map.has(label)) {
      map.set(label, {
        label,
        minQty: rule.minQty,
        maxQty: rule.maxQty,
      });
    }
  }

  const rows = Array.from(map.values()).sort((a, b) => a.minQty - b.minQty);

  if (rows.length) return rows;

  return QTY_RANGES.map((range) => ({
    label: range.label,
    minQty: range.min,
    maxQty: range.max,
  }));
}

function buildPricingMatrix(rules: any[]) {
  const grouped = new Map<string, any>();

  for (const rule of rules) {
    const key = `${rule.material}|||${rule.finish}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        material: rule.material,
        finish: rule.finish,
        productionFinish: rule.productionFinish,
        costEach: rule.costEach,
        prices: {},
      });
    }

    grouped.get(key).prices[rangeLabel(rule)] = rule.priceEach;
  }

  return Array.from(grouped.values());
}

function matrixPrice(row: any, range: { label: string; minQty: number; maxQty: number | null }) {
  const fallbackLabel = range.maxQty ? `${range.minQty}-${range.maxQty}` : `${range.minQty}+`;
  const openEndedLabel = `${range.minQty}+`;

  if (row.prices[range.label] !== undefined && row.prices[range.label] !== null) return row.prices[range.label];
  if (row.prices[fallbackLabel] !== undefined && row.prices[fallbackLabel] !== null) return row.prices[fallbackLabel];
  if (row.prices[openEndedLabel] !== undefined && row.prices[openEndedLabel] !== null) return row.prices[openEndedLabel];

  return null;
}

function productTypeForFamily(productFamily: string, requestedProductType: string) {
  if (productFamily === "jars") {
    return JAR_PRODUCT_TYPES.includes(requestedProductType) ? requestedProductType : "jar_50ml";
  }

  return STOCK_PRODUCT_TYPE;
}

function minQtyForProduct(productType: string, profile: any | null) {
  if (productType === STOCK_PRODUCT_TYPE) return MIN_QTY;
  return Number(profile?.minQuantity || 128);
}

function defaultQtyForProduct(productType: string, profile: any | null) {
  if (productType === STOCK_PRODUCT_TYPE) return MIN_QTY;
  return Number(profile?.defaultQuantity || profile?.minQuantity || 128);
}

async function resetPilotData(shop: string) {
  await db.configuratorPricingRule.deleteMany({
    where: { shop, productType: STOCK_PRODUCT_TYPE },
  });
  await db.configuratorOption.deleteMany({
    where: { shop, productType: STOCK_PRODUCT_TYPE },
  });

  await db.configuratorProduct.createMany({
    data: PILOT_PRODUCTS.map((title) => ({
      shop,
      title,
      productType: STOCK_PRODUCT_TYPE,
      defaultSides: "Double Sided",
      minQuantity: MIN_QTY,
      pilot: true,
      active: true,
      notes: "5-product stock bag configurator pilot",
    })),
    skipDuplicates: true,
  });

  const optionRows = [
    ...MATERIALS.map((value, index) => ({
      shop,
      productType: STOCK_PRODUCT_TYPE,
      group: "Material",
      value,
      label: value,
      sortOrder: index + 1,
      active: true,
    })),
    ...FINISHES.map((value, index) => ({
      shop,
      productType: STOCK_PRODUCT_TYPE,
      group: "Finish",
      value,
      label: value,
      sortOrder: index + 1,
      active: true,
    })),
    ...BAG_COLORS.map((value, index) => ({
      shop,
      productType: STOCK_PRODUCT_TYPE,
      group: "Bag Color",
      value,
      label: value,
      sortOrder: index + 1,
      active: true,
    })),
  ];

  await db.configuratorOption.createMany({
    data: optionRows,
    skipDuplicates: true,
  });

  const pricingRows = FALLBACK_PRICING_ROWS.flatMap((row) =>
    QTY_RANGES.map((range, index) => ({
      shop,
      productType: STOCK_PRODUCT_TYPE,
      material: row.material,
      finish: row.finish,
      productionFinish: row.productionFinish,
      sides: "Double Sided",
      minQty: range.min,
      maxQty: range.max,
      priceEach: row.prices[index] || row.prices[row.prices.length - 1],
      costEach: row.costEach,
      active: true,
      priority: 100,
      notes: "Seeded from GSO 4x5 stock bag pilot pricing sheet",
    })),
  );

  await db.configuratorPricingRule.createMany({
    data: pricingRows,
    skipDuplicates: true,
  });

  return {
    products: PILOT_PRODUCTS.length,
    options: optionRows.length,
    pricingRules: pricingRows.length,
  };
}

async function ensureStockPilotData(shop: string) {
  const [productCount, optionCount, pricingRuleCount] = await Promise.all([
    db.configuratorProduct.count({ where: { shop, productType: STOCK_PRODUCT_TYPE } }),
    db.configuratorOption.count({ where: { shop, productType: STOCK_PRODUCT_TYPE } }),
    db.configuratorPricingRule.count({ where: { shop, productType: STOCK_PRODUCT_TYPE } }),
  ]);

  if (productCount === 0 || optionCount === 0 || pricingRuleCount === 0) {
    await resetPilotData(shop);
  }
}

async function getDbPricingRule(shop: string, productType: string, material: string, finish: string, qty: number, minQty: number) {
  const safeQty = Math.max(qty, minQty);

  const rule = await db.configuratorPricingRule.findFirst({
    where: {
      shop,
      productType,
      active: true,
      material,
      finish,
      minQty: { lte: safeQty },
      OR: [{ maxQty: null }, { maxQty: { gte: safeQty } }],
    },
    orderBy: [{ priority: "asc" }, { minQty: "desc" }],
  });

  if (!rule && productType === STOCK_PRODUCT_TYPE) {
    return fallbackRuleFor(material, finish, safeQty);
  }

  if (!rule) {
    return {
      material,
      finish,
      productionFinish: finish,
      sides: productType.startsWith("jar_") ? "Jar Label Set" : "Double Sided",
      minQty,
      maxQty: null,
      priceEach: 0,
      costEach: 0,
      source: "missing",
    };
  }

  return {
    material: rule.material,
    finish: rule.finish,
    productionFinish: rule.productionFinish,
    sides: rule.sides,
    minQty: rule.minQty,
    maxQty: rule.maxQty,
    priceEach: rule.priceEach,
    costEach: rule.costEach,
    source: "database",
  };
}

async function calculate(shop: string, productType: string, material: string, finish: string, qty: number, minQty: number) {
  const safeQty = Math.max(qty, minQty);
  const rule = await getDbPricingRule(shop, productType, material, finish, safeQty, minQty);
  const priceEach = Number(rule.priceEach || 0);
  const costEach = Number(rule.costEach || 0);
  const profitEach = priceEach - costEach;
  const marginPct = priceEach > 0 ? (profitEach / priceEach) * 100 : 0;

  return {
    qty: safeQty,
    requestedQty: qty,
    range: { label: rangeLabel(rule), minQty: rule.minQty, maxQty: rule.maxQty },
    rule,
    priceEach,
    costEach,
    profitEach,
    marginPct,
    orderTotal: priceEach * safeQty,
    totalCost: costEach * safeQty,
    totalProfit: profitEach * safeQty,
  };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "resetPilotData") {
    const result = await resetPilotData(session.shop);
    return {
      ok: true,
      message: `Stock bag pilot rules reset: ${result.products} products, ${result.options} options, ${result.pricingRules} pricing rules.`,
    };
  }

  return { ok: false, message: "No action taken." };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  await ensureStockPilotData(session.shop);

  const url = new URL(request.url);
  const productFamily = textParam(url, "productFamily", "stock_bags");
  const safeFamily = productFamily === "jars" ? "jars" : "stock_bags";
  const requestedProductType = textParam(url, "productType", STOCK_PRODUCT_TYPE);
  const productType = productTypeForFamily(safeFamily, requestedProductType);

  const profile = await db.productTypeProfile.findFirst({
    where: {
      shop: session.shop,
      key: productType,
      active: true,
    },
  });

  const minQty = minQtyForProduct(productType, profile);
  const defaultQty = defaultQtyForProduct(productType, profile);

  const selectedProduct = textParam(url, "product", PILOT_PRODUCTS[0]);
  const rawMaterial = url.searchParams.get("material");
  const rawFinish = url.searchParams.get("finish");
  const rawBagColor = url.searchParams.get("bagColor");
  const rawLabelSet = url.searchParams.get("labelSet");
  const rawQty = url.searchParams.get("qty");
  const requestedMaterial = textParam(url, "material", "Matte");
  const requestedFinish = textParam(url, "finish", "No Spot Gloss");
  const requestedBagColor = textParam(url, "bagColor", "White");
  const requestedLabelSet = textParam(url, "labelSet", "Side + Lid");
  const requestedQty = intParam(url, "qty", defaultQty);

  const [stockProducts, jarProfiles, options, pricingRules] = await Promise.all([
    db.configuratorProduct.findMany({
      where: { shop: session.shop, productType: STOCK_PRODUCT_TYPE, active: true },
      orderBy: [{ pilot: "desc" }, { title: "asc" }],
    }),
    db.productTypeProfile.findMany({
      where: {
        shop: session.shop,
        key: { in: JAR_PRODUCT_TYPES },
        active: true,
      },
      orderBy: [{ key: "asc" }],
    }),
    db.configuratorOption.findMany({
      where: { shop: session.shop, productType, active: true },
      orderBy: [{ group: "asc" }, { sortOrder: "asc" }],
    }),
    db.configuratorPricingRule.findMany({
      where: { shop: session.shop, productType, active: true },
      orderBy: [{ material: "asc" }, { finish: "asc" }, { minQty: "asc" }],
    }),
  ]);

  const materialOptions = uniqueValues(options, "Material");
  const finishOptions = uniqueValues(options, "Finish");
  const bagColorOptions = uniqueValues(options, "Bag Color");
  const quantityOptions = uniqueValues(options, "Quantity");
  const labelSetOptions = uniqueValues(options, "Label Set");

  const material = coerceOption(requestedMaterial, materialOptions, "Matte", !rawMaterial?.trim());
  const finish = coerceOption(requestedFinish, finishOptions, "No Spot Gloss", !rawFinish?.trim());
  const bagColor = safeFamily === "jars"
    ? requestedBagColor
    : coerceOption(requestedBagColor, bagColorOptions, "White", !rawBagColor?.trim());
  const labelSet = coerceOption(requestedLabelSet, labelSetOptions, "Side + Lid", !rawLabelSet?.trim());
  const jarQtyFallback = quantityOptions.length ? intFromText(quantityOptions[0], defaultQty) : defaultQty;
  const jarRequestedQtyValid = Boolean(rawQty?.trim()) && quantityOptions.includes(String(requestedQty));
  const jarQty = jarRequestedQtyValid ? requestedQty : jarQtyFallback;
  const qty = Math.max(safeFamily === "jars" ? jarQty : requestedQty, minQty);
  const selectionCorrected =
    material !== requestedMaterial ||
    finish !== requestedFinish ||
    (safeFamily !== "jars" && bagColor !== requestedBagColor) ||
    labelSet !== requestedLabelSet ||
    qty !== requestedQty ||
    (safeFamily === "jars" && !jarRequestedQtyValid);
  const notice = selectionCorrected
    ? "Some selections were adjusted to match available options for this product."
    : "";
  const result = await calculate(session.shop, productType, material, finish, qty, minQty);
  const rangeColumns = buildRangeColumns(pricingRules);

  return {
    shop: session.shop,
    productFamily: safeFamily,
    productFamilyLabel: FAMILY_LABELS[safeFamily],
    productType,
    productTypeLabel: profile?.name || PRODUCT_TYPE_LABEL,
    selectedProduct,
    material,
    finish,
    bagColor,
    labelSet,
    qty,
    minQty,
    notice,
    result,
    stockProducts,
    jarProfiles,
    pricingRules,
    rangeColumns,
    pricingMatrix: buildPricingMatrix(pricingRules),
    options: {
      materials: materialOptions.length ? materialOptions : MATERIALS,
      finishes: finishOptions.length ? finishOptions : FINISHES,
      bagColors: bagColorOptions.length ? bagColorOptions : BAG_COLORS,
      quantities: quantityOptions,
      labelSets: labelSetOptions,
    },
    counts: {
      products: safeFamily === "jars" ? jarProfiles.length : stockProducts.length,
      options: options.length,
      pricingRules: pricingRules.length,
    },
  };
}

export default function GsoConfigurator() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const result = data.result;
  const isSubmitting = navigation.state !== "idle";
  const isJar = data.productFamily === "jars";

  return (
    <div className="gso-page">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      <div className="hero">
        <div>
          <p className="eyebrow">GSO ERP Configurator</p>
          <h1>Product Configurator</h1>
          <p>
            Database-backed configurator for Stock Bags and Applied Label Jars.
            Shopify can keep simple products while ERP controls pricing, costs,
            margins, option rules, and production logic.
          </p>
        </div>
        <div className="hero-card">
          <strong>{data.productFamilyLabel}</strong>
          <span>Product type: {data.productType}</span>
          <span>Pricing source: {result.rule.source}</span>
          <span>Min Qty: {data.minQty}</span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice success" : "notice warning"}>{actionData.message}</div>
      ) : null}

      {data.notice ? (
        <div className="notice warning">{data.notice}</div>
      ) : null}

      <div className="family-tabs">
        <Link className={data.productFamily === "stock_bags" ? "active" : ""} to="/app/erp/configurator?productFamily=stock_bags">Stock Bags</Link>
        <Link className={data.productFamily === "jars" ? "active" : ""} to="/app/erp/configurator?productFamily=jars">Jars</Link>
      </div>

      <div className="family-tabs">
        <Link to="/app/erp/configurator-jar-mapping">Jar Mapping</Link>
        <Link to="/app/erp/configurator-sync">Sync</Link>
        <Link to="/app/erp/configurator-mapping">Manual Mapping</Link>
        <Link to="/app/erp/configurator-audit">Audit</Link>
      </div>

      <div className="grid three">
        <div className="card stat">
          <span>{isJar ? "Jar Profiles" : "Configurator Products"}</span>
          <strong>{data.counts.products}</strong>
        </div>
        <div className="card stat">
          <span>Option Values</span>
          <strong>{data.counts.options}</strong>
        </div>
        <div className="card stat">
          <span>Pricing Rules</span>
          <strong>{data.counts.pricingRules}</strong>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>{isJar ? "Jar Test Calculator" : "Stock Bag Test Calculator"}</h2>
              <p className="muted">
                {isJar
                  ? "Customer-facing options: Jar Size, Material, Finish, Label Set, and Quantity."
                  : "Customer-facing options: Product, Material, Finish, Bag Color, and Quantity. Sides are hidden and defaulted to Double Sided."}
              </p>
            </div>
          </div>

          <Form method="get" className="form-grid">
            <input type="hidden" name="productFamily" value={data.productFamily} />

            {isJar ? (
              <label>
                Jar Size
                <select name="productType" defaultValue={data.productType}>
                  {data.jarProfiles.map((profile: any) => (
                    <option key={profile.key} value={profile.key}>{profile.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Product
                <select name="product" defaultValue={data.selectedProduct}>
                  {data.stockProducts.map((product: any) => (
                    <option key={product.id} value={product.title}>{product.title}</option>
                  ))}
                </select>
              </label>
            )}

            <label>
              Material
              <select name="material" defaultValue={data.material}>
                {data.options.materials.map((material: string) => (
                  <option key={material} value={material}>{material}</option>
                ))}
              </select>
            </label>

            <label>
              Finish
              <select name="finish" defaultValue={data.finish}>
                {data.options.finishes.map((finish: string) => (
                  <option key={finish} value={finish}>{finish}</option>
                ))}
              </select>
            </label>

            {isJar ? (
              <label>
                Label Set
                <select name="labelSet" defaultValue={data.labelSet}>
                  {data.options.labelSets.map((labelSet: string) => (
                    <option key={labelSet} value={labelSet}>{labelSet}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Bag Color
                <select name="bagColor" defaultValue={data.bagColor}>
                  {data.options.bagColors.map((color: string) => (
                    <option key={color} value={color}>{color}</option>
                  ))}
                </select>
              </label>
            )}

            <label>
              Quantity
              {isJar && data.options.quantities.length ? (
                <select name="qty" defaultValue={String(data.qty)}>
                  {data.options.quantities.map((qty: string) => (
                    <option key={qty} value={qty}>{qty === "2500" ? "2500+" : qty}</option>
                  ))}
                </select>
              ) : (
                <input name="qty" type="number" min={data.minQty} step="1" defaultValue={data.qty} />
              )}
            </label>

            <div className="button-row">
              <button type="submit">Calculate</button>
            </div>
          </Form>

          {!isJar ? (
            <div className="admin-actions">
              <Form method="post">
                <input type="hidden" name="intent" value="resetPilotData" />
                <button className="secondary" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Working..." : "Reset stock bag pilot database rules"}
                </button>
              </Form>
            </div>
          ) : null}
        </div>

        <div className="card result-card">
          <h2>ERP Result</h2>
          {result.requestedQty < data.minQty ? (
            <div className="warning">Quantity was under {data.minQty}, so ERP priced it at the {data.minQty} minimum.</div>
          ) : null}

          {result.rule.source === "missing" ? (
            <div className="warning">No pricing rule matched this option combo yet.</div>
          ) : null}

          <div className="metric-grid">
            <div><span>Price Each</span><strong>{money(result.priceEach)}</strong></div>
            <div><span>Cost Each</span><strong>{money(result.costEach)}</strong></div>
            <div><span>Profit Each</span><strong>{money(result.profitEach)}</strong></div>
            <div><span>Margin</span><strong>{pct(result.marginPct)}</strong></div>
            <div><span>Order Total</span><strong>{money(result.orderTotal)}</strong></div>
            <div><span>Total Cost</span><strong>{money(result.totalCost)}</strong></div>
            <div><span>Total Profit</span><strong>{money(result.totalProfit)}</strong></div>
            <div><span>Matched Range</span><strong>{result.range.label}</strong></div>
          </div>

          <div className="summary">
            <p><b>Family:</b> {data.productFamilyLabel}</p>
            <p><b>Product Type:</b> {data.productTypeLabel}</p>
            {!isJar ? <p><b>Product:</b> {data.selectedProduct}</p> : null}
            <p><b>Material:</b> {data.material}</p>
            <p><b>Finish:</b> {data.finish}</p>
            <p><b>Production Finish:</b> {result.rule.productionFinish}</p>
            {isJar ? <p><b>Label Set:</b> {data.labelSet}</p> : <p><b>Bag Color:</b> {data.bagColor}</p>}
            <p><b>Sides / Mode:</b> {result.rule.sides}</p>
            <p><b>Minimum Quantity:</b> {data.minQty}</p>
            <p><b>Pricing Source:</b> {result.rule.source}</p>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{isJar ? "Jar Product Profiles" : "Stock Bag Pilot Products"}</h2>
        <div className="pilot-list">
          {isJar
            ? data.jarProfiles.map((profile: any) => (
                <div key={profile.key} className="pilot-item">
                  <strong>{profile.name}</strong>
                  <span>Key: {profile.key}</span>
                  <span>Min Qty: {profile.minQuantity}</span>
                  <span>Tiers: {profile.tierBreakpoints || "-"}</span>
                </div>
              ))
            : data.stockProducts.map((product: any) => (
                <div key={product.id} className="pilot-item">
                  <strong>{product.title}</strong>
                  <span>Needs Shopify tag: configurator-pilot</span>
                  <span>Min Qty: {product.minQuantity}</span>
                  <span>Sides: {product.defaultSides}</span>
                </div>
              ))}
        </div>
      </div>

      <div className="card">
        <h2>Database Pricing Matrix For {isJar ? data.productTypeLabel : "4x5 Stock Bags"}</h2>
        <p className="muted">
          These rules are stored in Prisma/PostgreSQL. The calculator reads database rules first
          and only falls back to hardcoded pilot rules for stock bags if the database has no matching rule.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Finish</th>
                <th>Production Finish</th>
                <th>Cost Each</th>
                {data.rangeColumns.map((range: any) => (
                  <th key={range.label}>{range.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.pricingMatrix.map((row: any) => (
                <tr key={row.material + row.finish}>
                  <td>{row.material}</td>
                  <td>{row.finish}</td>
                  <td>{row.productionFinish}</td>
                  <td>{money(row.costEach)}</td>
                  {data.rangeColumns.map((range: any) => (
                    <td key={range.label}>{matrixPrice(row, range) !== null ? money(matrixPrice(row, range)) : "-"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Next Patch After This Works</h2>
        <ol>
          <li>Connect jar quote/configurator output to storefront/cart properties.</li>
          <li>Make paid order webhook map jar label zones into production job item notes.</li>
          <li>Add Shopify product mapping for jar products when ready.</li>
        </ol>
      </div>
    </div>
  );
}

const styles = `
.gso-page {
  padding: 24px;
  max-width: 1280px;
  margin: 0 auto;
  color: #202223;
}
.hero {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px;
  border-radius: 18px;
  background: linear-gradient(135deg, #111827, #312e81);
  color: white;
  margin-bottom: 20px;
}
.hero h1 {
  margin: 6px 0 8px;
  font-size: 34px;
}
.eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
  opacity: 0.8;
}
.hero-card {
  min-width: 240px;
  display: grid;
  gap: 8px;
  align-content: center;
  padding: 16px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.12);
}
.hero-card span {
  font-size: 13px;
  opacity: 0.92;
}
.family-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}
.family-tabs a {
  text-decoration: none;
  color: #202223;
  border: 1px solid #d1d5db;
  padding: 10px 14px;
  border-radius: 999px;
  background: #fff;
}
.family-tabs a.active {
  color: #fff;
  background: #312e81;
  border-color: #312e81;
}
.grid {
  display: grid;
  gap: 18px;
  margin-bottom: 18px;
}
.grid.two {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.card {
  background: #ffffff;
  border: 1px solid #dfe3e8;
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.card h2 {
  margin: 0 0 10px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.muted {
  color: #6b7280;
  margin-top: 0;
}
.stat span {
  display: block;
  color: #6b7280;
  font-size: 13px;
}
.stat strong {
  display: block;
  margin-top: 6px;
  font-size: 30px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}
select,
input {
  width: 100%;
  padding: 10px;
  border: 1px solid #c9cccf;
  border-radius: 10px;
  font: inherit;
}
.button-row {
  display: flex;
  align-items: end;
}
button,
.secondary {
  border: 0;
  border-radius: 10px;
  padding: 11px 16px;
  font-weight: 700;
  cursor: pointer;
  background: #111827;
  color: #fff;
}
.secondary {
  background: #f3f4f6;
  color: #111827;
  border: 1px solid #d1d5db;
}
.admin-actions {
  margin-top: 16px;
}
.notice {
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: 12px;
}
.notice.success {
  background: #ecfdf5;
  color: #065f46;
}
.notice.warning,
.warning {
  background: #fffbeb;
  color: #92400e;
  border-radius: 10px;
  padding: 10px;
  margin-bottom: 12px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.metric-grid div {
  padding: 12px;
  border-radius: 12px;
  background: #f9fafb;
}
.metric-grid span {
  display: block;
  color: #6b7280;
  font-size: 12px;
}
.metric-grid strong {
  display: block;
  margin-top: 4px;
  font-size: 20px;
}
.summary {
  margin-top: 14px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}
.summary p {
  margin: 6px 0;
}
.pilot-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.pilot-item {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #f9fafb;
}
.pilot-item span {
  color: #6b7280;
  font-size: 12px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  border-bottom: 1px solid #e5e7eb;
  padding: 10px;
  text-align: left;
  white-space: nowrap;
}
th {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
}
@media (max-width: 900px) {
  .hero,
  .grid.two,
  .grid.three,
  .pilot-list,
  .form-grid {
    grid-template-columns: 1fr;
    display: grid;
  }
}
`;

