import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type TierRow = {
  index: number;
  quantity: number;
  costEach: number;
  manualPriceEach: number;
  suggestedPriceEach: number;
  suggestedTotal: number;
  manualMargin: number | null;
  suggestedMargin: number | null;
  status: "below_cost" | "low_margin" | "safe" | "no_manual";
};

type CalculatorInput = {
  productName: string;
  category: string;
  vendor: string;
  targetMargin: number;
  costMode: "flat" | "breaks";
  flatCostEach: number;
  notes: string;
};

const DEFAULT_TIERS = [100, 500, 1000, 2500, 5000, 10000];
const CATEGORY_OPTIONS = [
  "Jar / Container",
  "Pop Top Jar",
  "Bag / Pouch",
  "Box",
  "Label / Sticker",
  "DTP Bag",
  "Bundle / Combo",
  "General Sourced Product",
];

function money(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pct(value: number | null | undefined, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "N/A";
  return `${Number(value || 0).toFixed(digits)}%`;
}

function numberParam(url: URL, key: string, fallback: number) {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringParam(url: URL, key: string, fallback: string) {
  const value = url.searchParams.get(key);
  return value && value.trim() ? value : fallback;
}

function roundNickel(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value * 20) / 20;
}

function priceForMargin(cost: number, marginPct: number) {
  const margin = Math.min(95, Math.max(0, marginPct)) / 100;
  return cost / (1 - margin);
}

function marginFromPrice(price: number, cost: number) {
  if (!price || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

function statusForManualPrice(manualPrice: number, cost: number, targetMargin: number): TierRow["status"] {
  if (!manualPrice || manualPrice <= 0) return "no_manual";
  if (manualPrice <= cost) return "below_cost";
  const margin = marginFromPrice(manualPrice, cost);
  if (margin != null && margin + 0.5 < targetMargin) return "low_margin";
  return "safe";
}

function statusLabel(status: TierRow["status"]) {
  if (status === "below_cost") return "Below cost";
  if (status === "low_margin") return "Low margin";
  if (status === "safe") return "Safe";
  return "No manual price";
}

function statusColor(status: TierRow["status"]) {
  if (status === "below_cost") return "#fee2e2";
  if (status === "low_margin") return "#fef3c7";
  if (status === "safe") return "#dcfce7";
  return "#f3f4f6";
}

function buildTierRows(url: URL, input: CalculatorInput): TierRow[] {
  return DEFAULT_TIERS.map((defaultQty, i) => {
    const index = i + 1;
    const quantity = Math.max(1, Math.round(numberParam(url, `qty${index}`, defaultQty)));
    const defaultCost = input.costMode === "flat" ? input.flatCostEach : input.flatCostEach;
    const costEach = Math.max(0, numberParam(url, `cost${index}`, defaultCost));
    const manualPriceEach = Math.max(0, numberParam(url, `price${index}`, 0));
    const suggestedPriceEach = roundNickel(priceForMargin(costEach, input.targetMargin));
    const suggestedMargin = marginFromPrice(suggestedPriceEach, costEach);
    const manualMargin = marginFromPrice(manualPriceEach, costEach);
    return {
      index,
      quantity,
      costEach,
      manualPriceEach,
      suggestedPriceEach,
      suggestedTotal: suggestedPriceEach * quantity,
      manualMargin,
      suggestedMargin,
      status: statusForManualPrice(manualPriceEach, costEach, input.targetMargin),
    };
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const settings = await db.marginReviewSetting.findFirst({ where: { shop, active: true }, orderBy: { updatedAt: "desc" } });
  const input: CalculatorInput = {
    productName: stringParam(url, "productName", "Pop Top Jar"),
    category: stringParam(url, "category", "Pop Top Jar"),
    vendor: stringParam(url, "vendor", ""),
    targetMargin: numberParam(url, "targetMargin", 60),
    costMode: stringParam(url, "costMode", "flat") === "breaks" ? "breaks" : "flat",
    flatCostEach: numberParam(url, "flatCostEach", 0.5),
    notes: stringParam(url, "notes", ""),
  };
  const tierRows = buildTierRows(url, input);
  const validCosts = tierRows.filter((row) => row.costEach > 0);
  const averageCost = validCosts.length ? validCosts.reduce((sum, row) => sum + row.costEach, 0) / validCosts.length : 0;
  const lowestSuggested = tierRows.reduce((min, row) => row.suggestedPriceEach > 0 ? Math.min(min, row.suggestedPriceEach) : min, Number.POSITIVE_INFINITY);
  const lowMarginCount = tierRows.filter((row) => row.status === "low_margin" || row.status === "below_cost").length;

  return Response.json({
    input,
    tierRows,
    categoryOptions: CATEGORY_OPTIONS,
    metrics: {
      averageCost,
      lowestSuggested: Number.isFinite(lowestSuggested) ? lowestSuggested : 0,
      lowMarginCount,
      laborRatePerHour: Number(settings?.laborRatePerHour || 25),
      applicationLaborFloorPerSide: Number(settings?.applicationLaborFloorPerSide || 0.2),
    },
  });
}

export default function WholesaleCalculator() {
  const data = useLoaderData<typeof loader>();
  const input = data.input as CalculatorInput;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif", color: "#111827" }}>
      <section style={{ background: "linear-gradient(90deg,#111827,#4b5563)", color: "white", borderRadius: 12, padding: 24, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Product Cost Calculator</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
          v12.3 reset: use this for new sourced products or custom products that are not already set up on Shopify. Enter supplier cost, supplier quantity breaks, target margin, and optional manual sell prices.
        </p>
      </section>

      <section style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <strong>Correct workflow:</strong> Existing Shopify products stay in Margin Review. This calculator is for a new item like a pop top jar, new box, new bag size, or any sourced product where you call the supplier and enter the cost.
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Product cost setup</h2>
        <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <label style={labelStyle("span 2")}>
            New product / item name
            <input name="productName" defaultValue={input.productName} placeholder="Pop Top Jar" style={fieldStyle} />
          </label>
          <label style={labelStyle("span 2")}>
            Product type / category
            <select name="category" defaultValue={input.category} style={fieldStyle}>
              {data.categoryOptions.map((category: string) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label style={labelStyle()}>
            Vendor / supplier
            <input name="vendor" defaultValue={input.vendor} placeholder="optional" style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Target margin %
            <input name="targetMargin" type="number" min="0" max="95" step="0.1" defaultValue={input.targetMargin} style={fieldStyle} />
          </label>

          <label style={labelStyle("span 2")}>
            Supplier cost type
            <select name="costMode" defaultValue={input.costMode} style={fieldStyle}>
              <option value="flat">Same cost at every quantity</option>
              <option value="breaks">Supplier cost breaks by quantity</option>
            </select>
          </label>
          <label style={labelStyle()}>
            Default / flat cost each
            <input name="flatCostEach" type="number" min="0" step="0.0001" defaultValue={input.flatCostEach} style={fieldStyle} />
          </label>
          <label style={labelStyle("span 3")}>
            Notes
            <input name="notes" defaultValue={input.notes} placeholder="Supplier quote, MOQ, cap included, shipping not included, etc." style={fieldStyle} />
          </label>

          <div style={{ gridColumn: "span 6", borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Supplier costs and selling tiers</h3>
            <p style={{ margin: "0 0 10px", color: "#6b7280", fontSize: 12 }}>
              If the supplier gives one cost, keep the same cost in each row. If the supplier gives breaks, enter the cost for each quantity. Manual sell price is optional and will be checked against your target margin.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                    <th style={cellHeader}>Tier</th>
                    <th style={cellHeader}>Quantity</th>
                    <th style={cellHeader}>Supplier cost each</th>
                    <th style={cellHeader}>Manual sell price each</th>
                    <th style={cellHeader}>Suggested price</th>
                    <th style={cellHeader}>Manual margin</th>
                    <th style={cellHeader}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tierRows.map((row: TierRow) => (
                    <tr key={row.index}>
                      <td style={cell}>{row.index}</td>
                      <td style={cell}><input name={`qty${row.index}`} type="number" min="1" defaultValue={row.quantity} style={smallInputStyle} /></td>
                      <td style={cell}><input name={`cost${row.index}`} type="number" min="0" step="0.0001" defaultValue={row.costEach} style={smallInputStyle} /></td>
                      <td style={cell}><input name={`price${row.index}`} type="number" min="0" step="0.01" defaultValue={row.manualPriceEach || ""} placeholder="optional" style={smallInputStyle} /></td>
                      <td style={{ ...cell, fontWeight: 800 }}>{money(row.suggestedPriceEach)}</td>
                      <td style={cell}>{row.manualMargin == null ? "N/A" : pct(row.manualMargin)}</td>
                      <td style={cell}><StatusBadge status={row.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button type="submit" style={{ padding: "12px 16px", borderRadius: 8, background: "#111827", color: "white", border: 0, fontWeight: 800, gridColumn: "span 2" }}>Calculate pricing</button>
          <p style={{ gridColumn: "span 4", margin: 0, fontSize: 12, color: "#6b7280" }}>
            This page does not update Shopify. It is for checking cost, margin, and suggested tiers before creating a quote or new product.
          </p>
        </Form>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <Metric title="Product" value={input.productName || "New product"} note={input.category} />
        <Metric title="Average supplier cost" value={money(data.metrics.averageCost)} note="Across entered tiers" />
        <Metric title="Lowest suggested price" value={money(data.metrics.lowestSuggested)} note={`${pct(input.targetMargin)} target margin`} strong />
        <Metric title="Manual price warnings" value={`${data.metrics.lowMarginCount}`} note="Low margin or below cost" />
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Suggested sell tiers</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={cellHeader}>Quantity</th>
                <th style={cellHeader}>Supplier cost</th>
                <th style={cellHeader}>Suggested sell price</th>
                <th style={cellHeader}>Suggested margin</th>
                <th style={cellHeader}>Suggested total</th>
                <th style={cellHeader}>Manual price</th>
                <th style={cellHeader}>Manual margin</th>
                <th style={cellHeader}>Check</th>
              </tr>
            </thead>
            <tbody>
              {data.tierRows.map((row: TierRow) => (
                <tr key={row.index}>
                  <td style={cell}>{row.quantity.toLocaleString()}</td>
                  <td style={cell}>{money(row.costEach)}</td>
                  <td style={{ ...cell, fontWeight: 800 }}>{money(row.suggestedPriceEach)}</td>
                  <td style={cell}>{pct(row.suggestedMargin)}</td>
                  <td style={cell}>{money(row.suggestedTotal)}</td>
                  <td style={cell}>{row.manualPriceEach > 0 ? money(row.manualPriceEach) : "—"}</td>
                  <td style={cell}>{row.manualMargin == null ? "—" : pct(row.manualMargin)}</td>
                  <td style={cell}><StatusBadge status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Next ERP actions</h2>
        <p style={{ margin: 0, fontSize: 13, color: "#4b5563" }}>
          Future buttons will save this as a quote draft, save it as a new pricing draft, or create a Shopify product draft. For now this is a safe calculator only.
        </p>
      </section>
    </main>
  );
}

const cellHeader = { padding: "10px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 700 };
const cell = { padding: "10px 8px", borderBottom: "1px solid #eef0f3", verticalAlign: "middle" };
const fieldStyle = { padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 };
const smallInputStyle = { ...fieldStyle, width: "100%", minWidth: 90, boxSizing: "border-box" as const };
function labelStyle(gridColumn = "span 1") {
  return { display: "grid", gap: 4, fontSize: 12, gridColumn };
}

function Metric({ title, value, note, strong = false }: { title: string; value: string; note: string; strong?: boolean }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{title}</div>
      <div style={{ fontSize: strong ? 24 : 20, fontWeight: 800, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{note}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: TierRow["status"] }) {
  return <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: statusColor(status), fontWeight: 800 }}>{statusLabel(status)}</span>;
}
