import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type Tier = { label: string; quantity: number };
type JobPreset = {
  key: string;
  label: string;
  description: string;
  defaultQuantity: number;
  defaultTargetMargin: number;
  defaultBaseCostEach: number;
  defaultBaseMaterialCostEach: number;
  defaultUpgradeMaterialCostEach: number;
  defaultPrintedSides: number;
  defaultApplicationSeconds: number;
  defaultPackingSeconds: number;
  defaultSetupCost: number;
  defaultPrepressCost: number;
  defaultWastePct: number;
  tiers: Tier[];
};

type CalcInput = {
  jobType: string;
  quantity: number;
  targetMargin: number;
  baseCostEach: number;
  baseMaterialCostEach: number;
  upgradeMaterialCostEach: number;
  useUpgradeMaterial: boolean;
  printedSides: number;
  applicationSeconds: number;
  packingSeconds: number;
  setupCost: number;
  prepressCost: number;
  wastePct: number;
  currentPriceEach: number;
};

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

function boolParam(url: URL, key: string, fallback: boolean) {
  const value = url.searchParams.get(key);
  if (value == null) return fallback;
  return value === "1" || value === "true" || value === "on";
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

const PRESETS: JobPreset[] = [
  {
    key: "custom_sticker_bag",
    label: "Custom sticker bag / label application",
    description: "Use for new sticker bag sizes, new materials, odd quantities, custom add-ons, or jobs not already built as Shopify products.",
    defaultQuantity: 1000,
    defaultTargetMargin: 60,
    defaultBaseCostEach: 0.16,
    defaultBaseMaterialCostEach: 0.28,
    defaultUpgradeMaterialCostEach: 0,
    defaultPrintedSides: 2,
    defaultApplicationSeconds: 10,
    defaultPackingSeconds: 5,
    defaultSetupCost: 5,
    defaultPrepressCost: 25,
    defaultWastePct: 15,
    tiers: [
      { label: "100", quantity: 100 },
      { label: "300", quantity: 300 },
      { label: "500", quantity: 500 },
      { label: "1,000", quantity: 1000 },
      { label: "2,000", quantity: 2000 },
      { label: "5,000", quantity: 5000 },
      { label: "10,000", quantity: 10000 },
    ],
  },
  {
    key: "custom_jar_label",
    label: "Custom jar label / application",
    description: "Use for jar jobs, Miron-style label jobs, side/top labels, new jar sizes, or custom label finish combinations.",
    defaultQuantity: 300,
    defaultTargetMargin: 58,
    defaultBaseCostEach: 1.25,
    defaultBaseMaterialCostEach: 0.55,
    defaultUpgradeMaterialCostEach: 0,
    defaultPrintedSides: 2,
    defaultApplicationSeconds: 18,
    defaultPackingSeconds: 6,
    defaultSetupCost: 10,
    defaultPrepressCost: 35,
    defaultWastePct: 10,
    tiers: [
      { label: "64", quantity: 64 },
      { label: "100", quantity: 100 },
      { label: "250", quantity: 250 },
      { label: "500", quantity: 500 },
      { label: "800", quantity: 800 },
      { label: "1,000", quantity: 1000 },
      { label: "2,000", quantity: 2000 },
    ],
  },
  {
    key: "custom_box_bundle",
    label: "Custom box / bundle",
    description: "Use for bag+box bundles, custom boxes, inserts, or jobs with combined components.",
    defaultQuantity: 500,
    defaultTargetMargin: 55,
    defaultBaseCostEach: 0.75,
    defaultBaseMaterialCostEach: 0.35,
    defaultUpgradeMaterialCostEach: 0,
    defaultPrintedSides: 1,
    defaultApplicationSeconds: 0,
    defaultPackingSeconds: 8,
    defaultSetupCost: 25,
    defaultPrepressCost: 50,
    defaultWastePct: 10,
    tiers: [
      { label: "100", quantity: 100 },
      { label: "250", quantity: 250 },
      { label: "500", quantity: 500 },
      { label: "1,000", quantity: 1000 },
      { label: "2,500", quantity: 2500 },
      { label: "5,000", quantity: 5000 },
    ],
  },
  {
    key: "general_custom",
    label: "General custom job",
    description: "Use when the job does not match a saved product or template yet. Enter cost assumptions manually.",
    defaultQuantity: 1000,
    defaultTargetMargin: 55,
    defaultBaseCostEach: 0,
    defaultBaseMaterialCostEach: 0,
    defaultUpgradeMaterialCostEach: 0,
    defaultPrintedSides: 1,
    defaultApplicationSeconds: 0,
    defaultPackingSeconds: 0,
    defaultSetupCost: 0,
    defaultPrepressCost: 0,
    defaultWastePct: 10,
    tiers: [
      { label: "100", quantity: 100 },
      { label: "250", quantity: 250 },
      { label: "500", quantity: 500 },
      { label: "1,000", quantity: 1000 },
      { label: "5,000", quantity: 5000 },
      { label: "10,000", quantity: 10000 },
    ],
  },
];

function findPreset(key: string) {
  return PRESETS.find((preset) => preset.key === key) || PRESETS[0];
}

function calculate(input: CalcInput, settings: any, quantityOverride?: number) {
  const quantity = Math.max(1, Math.round(quantityOverride || input.quantity || 1));
  const laborRate = Number(settings?.laborRatePerHour || 25);
  const laborFloorPerSide = Number(settings?.applicationLaborFloorPerSide || 0.2);
  const materialEach = input.useUpgradeMaterial ? input.upgradeMaterialCostEach : input.baseMaterialCostEach;
  const materialWithWaste = materialEach * (1 + Math.max(0, input.wastePct) / 100);
  const applicationBySeconds = (Math.max(0, input.applicationSeconds) / 3600) * laborRate;
  const applicationFloor = Math.max(0, input.printedSides) * laborFloorPerSide;
  const applicationLaborEach = Math.max(applicationBySeconds, applicationFloor);
  const packingLaborEach = (Math.max(0, input.packingSeconds) / 3600) * laborRate;
  const setupEach = (Math.max(0, input.setupCost) + Math.max(0, input.prepressCost)) / quantity;
  const costEach = Math.max(0, input.baseCostEach + materialWithWaste + applicationLaborEach + packingLaborEach + setupEach);
  const safePrice = roundNickel(priceForMargin(costEach, input.targetMargin));
  const manualMargin = input.currentPriceEach > 0 ? marginFromPrice(input.currentPriceEach, costEach) : null;
  const currentPriceStatus = !input.currentPriceEach
    ? "No manual price"
    : manualMargin != null && manualMargin + 0.5 < input.targetMargin
      ? "Low margin"
      : "Safe";
  return {
    quantity,
    laborRate,
    laborFloorPerSide,
    materialEach,
    materialWithWaste,
    applicationBySeconds,
    applicationFloor,
    applicationLaborEach,
    packingLaborEach,
    setupEach,
    costEach,
    safePrice,
    totalCost: costEach * quantity,
    totalPrice: safePrice * quantity,
    estimatedProfit: (safePrice - costEach) * quantity,
    manualMargin,
    currentPriceStatus,
    laborFloorUsed: applicationLaborEach === applicationFloor && applicationFloor > applicationBySeconds,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const preset = findPreset(stringParam(url, "jobType", "custom_sticker_bag"));
  const input: CalcInput = {
    jobType: preset.key,
    quantity: Math.max(1, Math.round(numberParam(url, "quantity", preset.defaultQuantity))),
    targetMargin: numberParam(url, "targetMargin", preset.defaultTargetMargin),
    baseCostEach: numberParam(url, "baseCostEach", preset.defaultBaseCostEach),
    baseMaterialCostEach: numberParam(url, "baseMaterialCostEach", preset.defaultBaseMaterialCostEach),
    upgradeMaterialCostEach: numberParam(url, "upgradeMaterialCostEach", preset.defaultUpgradeMaterialCostEach),
    useUpgradeMaterial: boolParam(url, "useUpgradeMaterial", false),
    printedSides: numberParam(url, "printedSides", preset.defaultPrintedSides),
    applicationSeconds: numberParam(url, "applicationSeconds", preset.defaultApplicationSeconds),
    packingSeconds: numberParam(url, "packingSeconds", preset.defaultPackingSeconds),
    setupCost: numberParam(url, "setupCost", preset.defaultSetupCost),
    prepressCost: numberParam(url, "prepressCost", preset.defaultPrepressCost),
    wastePct: numberParam(url, "wastePct", preset.defaultWastePct),
    currentPriceEach: numberParam(url, "currentPriceEach", 0),
  };

  const settings = await db.marginReviewSetting.findFirst({ where: { shop, active: true }, orderBy: { updatedAt: "desc" } });
  const result = calculate(input, settings);
  const baseComparisonInput = { ...input, useUpgradeMaterial: false };
  const baseComparison = calculate(baseComparisonInput, settings);
  const baseMargin = marginFromPrice(baseComparison.safePrice, baseComparison.costEach) ?? input.targetMargin;
  const matchedUpgradePrice = roundNickel(priceForMargin(result.costEach, baseMargin));
  const tierRows = preset.tiers.map((tier) => {
    const row = calculate(input, settings, tier.quantity);
    const rowBase = calculate(baseComparisonInput, settings, tier.quantity);
    const rowBaseMargin = marginFromPrice(rowBase.safePrice, rowBase.costEach) ?? input.targetMargin;
    const rowMatched = roundNickel(priceForMargin(row.costEach, rowBaseMargin));
    return {
      ...tier,
      costEach: row.costEach,
      safePrice: row.safePrice,
      matchedUpgradePrice: rowMatched,
      recommendedPrice: Math.max(row.safePrice, rowMatched),
      total: Math.max(row.safePrice, rowMatched) * tier.quantity,
      laborFloorUsed: row.laborFloorUsed,
    };
  });

  return Response.json({
    presets: PRESETS.map((item) => ({ key: item.key, label: item.label })),
    preset,
    input,
    result,
    baseComparison,
    matchedUpgradePrice,
    tierRows,
    settings: {
      laborRatePerHour: Number(settings?.laborRatePerHour || 25),
      applicationLaborFloorPerSide: Number(settings?.applicationLaborFloorPerSide || 0.2),
    },
  });
}

export default function WholesaleCalculator() {
  const data = useLoaderData<typeof loader>();
  const input = data.input as CalcInput;
  const result = data.result;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif", color: "#111827" }}>
      <section style={{ background: "linear-gradient(90deg,#220033,#4b0072)", color: "white", borderRadius: 12, padding: 24, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Custom Job Calculator</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
          v12.2 reset: use this for new items, custom jobs, odd quantities, new materials, and quotes that are not already set up as Shopify products. Existing Shopify product pricing stays in Margin Review.
        </p>
      </section>

      <section style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <strong>Important workflow:</strong> This page is not for repricing existing Shopify products like the standard 4x5 Sticker Bag product. Use Margin Review for existing products. Use this calculator when staff needs to price something custom or not built on the website yet.
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Custom job inputs</h2>
        <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <label style={labelStyle("span 3")}>
            Job type / starting template
            <select name="jobType" defaultValue={input.jobType} style={fieldStyle}>
              {data.presets.map((item: any) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label style={labelStyle()}>
            Quantity
            <input name="quantity" type="number" min="1" defaultValue={input.quantity} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Target margin %
            <input name="targetMargin" type="number" min="0" max="95" step="0.1" defaultValue={input.targetMargin} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Current/manual price each
            <input name="currentPriceEach" type="number" min="0" step="0.01" defaultValue={input.currentPriceEach || ""} placeholder="optional" style={fieldStyle} />
          </label>

          <label style={labelStyle()}>
            Base item cost each
            <input name="baseCostEach" type="number" min="0" step="0.01" defaultValue={input.baseCostEach} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Base material/media cost each
            <input name="baseMaterialCostEach" type="number" min="0" step="0.01" defaultValue={input.baseMaterialCostEach} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Upgrade material cost each
            <input name="upgradeMaterialCostEach" type="number" min="0" step="0.01" defaultValue={input.upgradeMaterialCostEach} style={fieldStyle} />
          </label>
          <label style={{ ...labelStyle(), alignContent: "end" }}>
            <span>Use upgrade material?</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center", height: 42 }}>
              <input name="useUpgradeMaterial" type="checkbox" defaultChecked={input.useUpgradeMaterial} /> Use upgrade cost instead of base material cost
            </span>
          </label>
          <label style={labelStyle()}>
            Printed sides / label zones
            <input name="printedSides" type="number" min="0" step="1" defaultValue={input.printedSides} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Waste %
            <input name="wastePct" type="number" min="0" step="0.1" defaultValue={input.wastePct} style={fieldStyle} />
          </label>

          <label style={labelStyle()}>
            Application seconds/unit
            <input name="applicationSeconds" type="number" min="0" step="0.1" defaultValue={input.applicationSeconds} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Packing seconds/unit
            <input name="packingSeconds" type="number" min="0" step="0.1" defaultValue={input.packingSeconds} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Setup cost total
            <input name="setupCost" type="number" min="0" step="0.01" defaultValue={input.setupCost} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Prepress/design total
            <input name="prepressCost" type="number" min="0" step="0.01" defaultValue={input.prepressCost} style={fieldStyle} />
          </label>
          <button type="submit" style={{ padding: "11px 16px", borderRadius: 8, background: "#111827", color: "white", border: 0, fontWeight: 700, gridColumn: "span 2" }}>Calculate custom job</button>
          <p style={{ gridColumn: "span 6", margin: 0, fontSize: 12, color: "#6b7280" }}>
            Saved shop labor assumptions are used automatically: {money(data.settings.laborRatePerHour)}/hr and {money(data.settings.applicationLaborFloorPerSide)} per printed side.
          </p>
        </Form>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        <Metric title="Estimated cost each" value={money(result.costEach)} note="All inputs included" />
        <Metric title="Suggested price each" value={money(result.safePrice)} note={`${pct(input.targetMargin)} target margin`} strong />
        <Metric title="Total quote" value={money(result.totalPrice)} note={`${result.quantity.toLocaleString()} units`} />
        <Metric title="Estimated profit" value={money(result.estimatedProfit)} note="Suggested price minus cost" />
        <Metric title="Manual price margin" value={result.manualMargin == null ? "N/A" : pct(result.manualMargin)} note={result.currentPriceStatus} />
      </section>

      <section style={{ background: "#f8fafc", border: "1px solid #d9dde6", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Cost breakdown</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, fontSize: 13 }}>
          <Breakdown label="Base item" value={input.baseCostEach} />
          <Breakdown label="Material/media with waste" value={result.materialWithWaste} />
          <Breakdown label="Application labor" value={result.applicationLaborEach} note={result.laborFloorUsed ? "floor used" : "seconds used"} />
          <Breakdown label="Packing labor" value={result.packingLaborEach} />
          <Breakdown label="Setup/prepress per unit" value={result.setupEach} />
        </div>
      </section>

      <section style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Material upgrade margin matching</h2>
        <p style={{ margin: 0, fontSize: 13 }}>
          Base material cost each is <strong>{money(input.baseMaterialCostEach)}</strong>. Upgrade material cost each is <strong>{money(input.upgradeMaterialCostEach)}</strong>. With the current inputs, the matched-margin upgrade price is <strong>{money(data.matchedUpgradePrice)}</strong> each. Use this when comparing matte vs holo, clear, white, premium laminate, or other upgraded materials.
        </p>
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Suggested quantity tiers for this custom job</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={cellHeader}>Tier quantity</th>
                <th style={cellHeader}>Cost each</th>
                <th style={cellHeader}>Safe price</th>
                <th style={cellHeader}>Matched upgrade price</th>
                <th style={cellHeader}>Recommended</th>
                <th style={cellHeader}>Quote total</th>
                <th style={cellHeader}>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.tierRows.map((row: any) => (
                <tr key={row.label}>
                  <td style={cell}>{row.label}</td>
                  <td style={cell}>{money(row.costEach)}</td>
                  <td style={cell}>{money(row.safePrice)}</td>
                  <td style={cell}>{money(row.matchedUpgradePrice)}</td>
                  <td style={{ ...cell, fontWeight: 800 }}>{money(row.recommendedPrice)}</td>
                  <td style={cell}>{money(row.total)}</td>
                  <td style={cell}>{row.laborFloorUsed ? <StatusBadge status="Labor floor" /> : <StatusBadge status="Calculated" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
          This calculator is for staff quoting only. It does not approve prices, does not update Shopify, and does not change product page pricing.
        </p>
      </section>
    </main>
  );
}

const cellHeader = { padding: "10px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 700 };
const cell = { padding: "10px 8px", borderBottom: "1px solid #eef0f3", verticalAlign: "top" };
const fieldStyle = { padding: 10, border: "1px solid #cfd4dc", borderRadius: 6 };
function labelStyle(gridColumn = "span 1") {
  return { display: "grid", gap: 4, fontSize: 12, gridColumn };
}

function Metric({ title, value, note, strong = false }: { title: string; value: string; note: string; strong?: boolean }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{title}</div>
      <div style={{ fontSize: strong ? 24 : 22, fontWeight: 800, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{note}</div>
    </div>
  );
}

function Breakdown({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{money(value)}</div>
      {note ? <div style={{ fontSize: 11, color: "#92400e", marginTop: 4 }}>{note}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "Labor floor" ? "#fef3c7" : "#dcfce7";
  return <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: color, fontWeight: 700 }}>{status}</span>;
}
