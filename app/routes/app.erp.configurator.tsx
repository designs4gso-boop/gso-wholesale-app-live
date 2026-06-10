import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

const PRODUCT_TYPE = "stock_bag_4x5";
const MIN_QTY = 64;

const PILOT_PRODUCTS = [
  "Ritz Vanilla Cupcake",
  "Bubble Tape Lemonade Lightning",
  "Trolli Worms Pineapple Pop",
  "Bubble Tape Blue Raspberry",
  "Ritz Orange Creamsicle",
];

const MATERIALS = ["Matte", "Holographic"];

const FINISHES = [
  "No Spot Gloss",
  "1X Spot Gloss",
  "2X Spot Gloss",
  "3X Spot Gloss",
  "4X Spot Gloss",
];

const BAG_COLORS = [
  "White",
  "Blue",
  "Red",
  "Pink",
  "Orange",
  "Green",
  "Gold-Holo",
  "Silver-Holo",
  "Purple-Holo",
  "Teal",
  "Black",
  "Light Pink",
  "Light Purple",
  "Clear",
];

const QTY_RANGES = [
  { label: "64-256", min: 64, max: 256 },
  { label: "257-640", min: 257, max: 640 },
  { label: "641-1280", min: 641, max: 1280 },
  { label: "1281-1920", min: 1281, max: 1920 },
  { label: "1921-2560+", min: 1921, max: null as number | null },
];

const FALLBACK_PRICING_ROWS = [
  {
    material: "Matte",
    finish: "No Spot Gloss",
    productionFinish: "Matte",
    costEach: 0.60,
    prices: [1.80, 1.65, 1.50, 1.35, 1.25],
  },
  {
    material: "Matte",
    finish: "1X Spot Gloss",
    productionFinish: "Matte + 1X Spot Gloss",
    costEach: 0.75,
    prices: [2.25, 2.05, 1.90, 1.75, 1.60],
  },
  {
    material: "Matte",
    finish: "2X Spot Gloss",
    productionFinish: "Matte + 2X Spot Gloss",
    costEach: 0.90,
    prices: [2.40, 2.20, 2.05, 1.90, 1.75],
  },
  {
    material: "Matte",
    finish: "3X Spot Gloss",
    productionFinish: "Matte + 3X Spot Gloss",
    costEach: 1.02,
    prices: [2.55, 2.35, 2.15, 1.95, 1.85],
  },
  {
    material: "Matte",
    finish: "4X Spot Gloss",
    productionFinish: "Matte + 4X Spot Gloss",
    costEach: 1.21,
    prices: [2.85, 2.65, 2.45, 2.25, 2.05],
  },
  {
    material: "Holographic",
    finish: "No Spot Gloss",
    productionFinish: "Holographic Vinyl + CMYK + White",
    costEach: 0.88,
    prices: [1.75, 1.65, 1.55, 1.45, 1.35],
  },
  {
    material: "Holographic",
    finish: "1X Spot Gloss",
    productionFinish: "Holo + White + 1X Spot Gloss",
    costEach: 1.03,
    prices: [2.05, 1.95, 1.85, 1.75, 1.65],
  },
  {
    material: "Holographic",
    finish: "2X Spot Gloss",
    productionFinish: "Holo + White + 2X Spot Gloss",
    costEach: 1.03,
    prices: [2.15, 2.05, 1.95, 1.85, 1.75],
  },
  {
    material: "Holographic",
    finish: "3X Spot Gloss",
    productionFinish: "Holo + White + 3X Spot Gloss",
    costEach: 1.18,
    prices: [2.40, 2.30, 2.20, 2.10, 2.00],
  },
  {
    material: "Holographic",
    finish: "4X Spot Gloss",
    productionFinish: "Holo + White + 4X Spot Gloss",
    costEach: 1.18,
    prices: [2.80, 2.60, 2.40, 2.20, 2.05],
  },
];

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

function findRange(qty: number) {
  return (
    QTY_RANGES.find((range) => {
      if (qty < range.min) return false;
      if (range.max === null) return true;
      return qty <= range.max;
    }) || QTY_RANGES[0]
  );
}

function findRangeIndex(qty: number) {
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
  const rangeIndex = findRangeIndex(safeQty);
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

async function resetPilotData(shop: string) {
  await db.configuratorPricingRule.deleteMany({
    where: { shop, productType: PRODUCT_TYPE },
  });
  await db.configuratorOption.deleteMany({
    where: { shop, productType: PRODUCT_TYPE },
  });

  await db.configuratorProduct.createMany({
    data: PILOT_PRODUCTS.map((title) => ({
      shop,
      title,
      productType: PRODUCT_TYPE,
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
      productType: PRODUCT_TYPE,
      group: "Material",
      value,
      label: value,
      sortOrder: index + 1,
      active: true,
    })),
    ...FINISHES.map((value, index) => ({
      shop,
      productType: PRODUCT_TYPE,
      group: "Finish",
      value,
      label: value,
      sortOrder: index + 1,
      active: true,
    })),
    ...BAG_COLORS.map((value, index) => ({
      shop,
      productType: PRODUCT_TYPE,
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
      productType: PRODUCT_TYPE,
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

async function ensurePilotData(shop: string) {
  const [productCount, optionCount, pricingRuleCount] = await Promise.all([
    db.configuratorProduct.count({ where: { shop, productType: PRODUCT_TYPE } }),
    db.configuratorOption.count({ where: { shop, productType: PRODUCT_TYPE } }),
    db.configuratorPricingRule.count({ where: { shop, productType: PRODUCT_TYPE } }),
  ]);

  if (productCount === 0 || optionCount === 0 || pricingRuleCount === 0) {
    await resetPilotData(shop);
  }
}

async function getDbPricingRule(shop: string, material: string, finish: string, qty: number) {
  const safeQty = Math.max(qty, MIN_QTY);

  const rule = await db.configuratorPricingRule.findFirst({
    where: {
      shop,
      productType: PRODUCT_TYPE,
      active: true,
      material,
      finish,
      minQty: { lte: safeQty },
      OR: [{ maxQty: null }, { maxQty: { gte: safeQty } }],
    },
    orderBy: [{ priority: "asc" }, { minQty: "desc" }],
  });

  if (!rule) {
    return fallbackRuleFor(material, finish, safeQty);
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

async function calculate(shop: string, material: string, finish: string, qty: number) {
  const safeQty = Math.max(qty, MIN_QTY);
  const rule = await getDbPricingRule(shop, material, finish, safeQty);
  const range = findRange(safeQty);
  const priceEach = Number(rule.priceEach || 0);
  const costEach = Number(rule.costEach || 0);
  const profitEach = priceEach - costEach;
  const marginPct = priceEach > 0 ? (profitEach / priceEach) * 100 : 0;

  return {
    qty: safeQty,
    requestedQty: qty,
    range,
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

function rangeLabel(rule: { minQty: number; maxQty: number | null }) {
  return rule.maxQty ? `${rule.minQty}-${rule.maxQty}` : `${rule.minQty}+`;
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


function matrixPrice(row: any, range: { label: string; min: number; max: number | null }) {
  const fallbackLabel = range.max ? `${range.min}-${range.max}` : `${range.min}+`;
  const openEndedLabel = `${range.min}+`;

  if (row.prices[range.label] !== undefined && row.prices[range.label] !== null) {
    return row.prices[range.label];
  }

  if (row.prices[fallbackLabel] !== undefined && row.prices[fallbackLabel] !== null) {
    return row.prices[fallbackLabel];
  }

  if (row.prices[openEndedLabel] !== undefined && row.prices[openEndedLabel] !== null) {
    return row.prices[openEndedLabel];
  }

  return null;
}
export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "resetPilotData") {
    const result = await resetPilotData(session.shop);
    return {
      ok: true,
      message: `Pilot rules reset: ${result.products} products, ${result.options} options, ${result.pricingRules} pricing rules.`,
    };
  }

  return { ok: false, message: "No action taken." };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  await ensurePilotData(session.shop);

  const url = new URL(request.url);
  const selectedProduct = textParam(url, "product", PILOT_PRODUCTS[0]);
  const material = textParam(url, "material", "Matte");
  const finish = textParam(url, "finish", "No Spot Gloss");
  const bagColor = textParam(url, "bagColor", "White");
  const qty = intParam(url, "qty", 64);

  const [products, options, pricingRules, result] = await Promise.all([
    db.configuratorProduct.findMany({
      where: { shop: session.shop, productType: PRODUCT_TYPE, active: true },
      orderBy: [{ pilot: "desc" }, { title: "asc" }],
    }),
    db.configuratorOption.findMany({
      where: { shop: session.shop, productType: PRODUCT_TYPE, active: true },
      orderBy: [{ group: "asc" }, { sortOrder: "asc" }],
    }),
    db.configuratorPricingRule.findMany({
      where: { shop: session.shop, productType: PRODUCT_TYPE, active: true },
      orderBy: [{ material: "asc" }, { finish: "asc" }, { minQty: "asc" }],
    }),
    calculate(session.shop, material, finish, qty),
  ]);

  const materialOptions = options.filter((option) => option.group === "Material").map((option) => option.value);
  const finishOptions = options.filter((option) => option.group === "Finish").map((option) => option.value);
  const bagColorOptions = options.filter((option) => option.group === "Bag Color").map((option) => option.value);

  return {
    shop: session.shop,
    selectedProduct,
    material,
    finish,
    bagColor,
    qty,
    result,
    products,
    pricingRules,
    pricingMatrix: buildPricingMatrix(pricingRules),
    options: {
      materials: materialOptions.length ? materialOptions : MATERIALS,
      finishes: finishOptions.length ? finishOptions : FINISHES,
      bagColors: bagColorOptions.length ? bagColorOptions : BAG_COLORS,
    },
    counts: {
      products: products.length,
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

  return (
    <div className="gso-page">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      <div className="hero">
        <div>
          <p className="eyebrow">GSO ERP Pilot</p>
          <h1>Product Configurator</h1>
          <p>
            Database-backed pilot for moving stock bags away from Shopify variant overload.
            Shopify keeps 1 product and 1 base variant. ERP controls pricing, costs,
            margins, option rules, and production logic.
          </p>
        </div>
        <div className="hero-card">
          <strong>Activation</strong>
          <span>Live theme later</span>
          <span>Only products tagged configurator-pilot</span>
          <span>Pricing source: {result.rule.source}</span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice success" : "notice warning"}>{actionData.message}</div>
      ) : null}

      <div className="grid three">
        <div className="card stat">
          <span>Configurator Products</span>
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
              <h2>Test Calculator</h2>
              <p className="muted">
                Customer-facing options: Material, Finish, Bag Color, and Quantity.
                Sides are hidden and defaulted to Double Sided.
              </p>
            </div>
          </div>

          <Form method="get" className="form-grid">
            <label>
              Product
              <select name="product" defaultValue={data.selectedProduct}>
                {data.products.map((product: any) => (
                  <option key={product.id} value={product.title}>{product.title}</option>
                ))}
              </select>
            </label>

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

            <label>
              Bag Color
              <select name="bagColor" defaultValue={data.bagColor}>
                {data.options.bagColors.map((color: string) => (
                  <option key={color} value={color}>{color}</option>
                ))}
              </select>
            </label>

            <label>
              Quantity
              <input name="qty" type="number" min={MIN_QTY} step="1" defaultValue={data.qty} />
            </label>

            <div className="button-row">
              <button type="submit">Calculate</button>
            </div>
          </Form>

          <div className="admin-actions">
            <Form method="post">
              <input type="hidden" name="intent" value="resetPilotData" />
              <button className="secondary" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Working..." : "Reset pilot database rules"}
              </button>
            </Form>
          </div>
        </div>

        <div className="card result-card">
          <h2>ERP Result</h2>
          {result.requestedQty < MIN_QTY ? (
            <div className="warning">Quantity was under 64, so ERP priced it at the 64 minimum.</div>
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
            <p><b>Product:</b> {data.selectedProduct}</p>
            <p><b>Material:</b> {data.material}</p>
            <p><b>Finish:</b> {data.finish}</p>
            <p><b>Production Finish:</b> {result.rule.productionFinish}</p>
            <p><b>Bag Color:</b> {data.bagColor}</p>
            <p><b>Sides:</b> {result.rule.sides} hidden/default</p>
            <p><b>Minimum Quantity:</b> 64</p>
            <p><b>Pricing Source:</b> {result.rule.source}</p>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>5-Product Pilot</h2>
        <div className="pilot-list">
          {data.products.map((product: any) => (
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
        <h2>Database Pricing Matrix For 4x5 Stock Bags</h2>
        <p className="muted">
          These rules are now stored in Prisma/PostgreSQL. The calculator reads database rules first
          and only falls back to hardcoded pilot rules if the database has no matching rule.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Finish</th>
                <th>Production Finish</th>
                <th>Cost Each</th>
                {QTY_RANGES.map((range) => (
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
                  {QTY_RANGES.map((range) => (
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
          <li>Add Shopify product mapping for the 5 pilot products.</li>
          <li>Create storefront configurator block for products tagged configurator-pilot.</li>
          <li>Send Material, Finish, Bag Color, Quantity, ERP Product ID, and ERP Config ID as line item properties.</li>
          <li>Update order paid webhook to create production jobs from selected properties.</li>
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
  margin: 0 0 8px;
  font-size: 34px;
}
.hero p {
  max-width: 760px;
  margin: 0;
  color: #e5e7eb;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px !important;
}
.hero-card {
  min-width: 230px;
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grid.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.grid.three {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}
.card {
  background: white;
  border: 1px solid #dfe3e8;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.card h2 {
  margin-top: 0;
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.stat span {
  display: block;
  color: #6d7175;
  font-size: 13px;
}
.stat strong {
  display: block;
  margin-top: 4px;
  font-size: 28px;
}
.muted {
  color: #6d7175;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 650;
}
input, select {
  min-height: 42px;
  border: 1px solid #c9cccf;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 14px;
}
.button-row {
  display: flex;
  align-items: end;
}
button {
  min-height: 42px;
  border: none;
  border-radius: 10px;
  padding: 10px 16px;
  background: #111827;
  color: white;
  font-weight: 700;
  cursor: pointer;
}
button.secondary {
  background: #f6f6f7;
  color: #111827;
  border: 1px solid #c9cccf;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.admin-actions {
  margin-top: 16px;
  border-top: 1px solid #e1e3e5;
  padding-top: 16px;
}
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.metric-grid div {
  background: #f6f6f7;
  border: 1px solid #e1e3e5;
  border-radius: 12px;
  padding: 12px;
}
.metric-grid span {
  display: block;
  color: #6d7175;
  font-size: 12px;
}
.metric-grid strong {
  display: block;
  margin-top: 4px;
  font-size: 22px;
}
.summary {
  margin-top: 16px;
  background: #f9fafb;
  border-radius: 12px;
  padding: 12px;
}
.summary p {
  margin: 6px 0;
}
.warning,
.notice {
  padding: 10px;
  border-radius: 10px;
  margin-bottom: 12px;
}
.warning,
.notice.warning {
  background: #fff4e5;
  border: 1px solid #ffb84d;
  color: #7a4b00;
}
.notice.success {
  background: #ecfdf3;
  border: 1px solid #86efac;
  color: #14532d;
}
.pilot-list {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.pilot-item {
  border: 1px solid #dfe3e8;
  border-radius: 12px;
  padding: 12px;
  background: #f9fafb;
}
.pilot-item strong,
.pilot-item span {
  display: block;
}
.pilot-item span {
  margin-top: 6px;
  color: #6d7175;
  font-size: 12px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border-bottom: 1px solid #e1e3e5;
  padding: 10px;
  text-align: left;
  white-space: nowrap;
}
th {
  background: #f6f6f7;
}
ol {
  margin-bottom: 0;
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




