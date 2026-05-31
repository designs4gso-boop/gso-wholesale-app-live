import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type TierRow = {
  index: number;
  quantity: number;
  supplierCostEach: number;
  calculatedCostEach: number;
  manualPriceEach: number;
  suggestedPriceEach: number;
  suggestedTotal: number;
  manualMargin: number | null;
  suggestedMargin: number | null;
  status: "below_cost" | "low_margin" | "safe" | "no_manual";
};

type FieldGroup =
  | "supplier_cost_tiers"
  | "size_area"
  | "material_cost"
  | "label_cost"
  | "application_labor"
  | "finishing_labor"
  | "packing_labor"
  | "freight_tooling"
  | "setup_prepress"
  | "manual_sell_tiers";

type RouteConfig = {
  key: string;
  name: string;
  help: string;
  fields: FieldGroup[];
};

type ProductTypeOption = {
  id: string;
  key: string;
  name: string;
  source: "erp" | "fallback";
  defaultMarginPct: number;
  tierBreakpoints: string;
  productionMode: string;
  kind: "label" | "box" | "dtp" | "jar" | "sticker_bag" | "sourced" | "general";
  routes: RouteConfig[];
};

type CalculatorInput = {
  productName: string;
  productTypeKey: string;
  routeKey: string;
  vendor: string;
  targetMargin: number;
  costMode: "flat" | "breaks";
  flatCostEach: number;
  widthIn: number;
  heightIn: number;
  materialCostEach: number;
  labelCostEach: number;
  applicationCount: number;
  applicationSecondsPerUnit: number;
  finishingSecondsPerUnit: number;
  packingSecondsPerUnit: number;
  freightTotal: number;
  toolingTotal: number;
  setupPrepressTotal: number;
  wastePct: number;
  notes: string;
};

const DEFAULT_TIERS = [100, 500, 1000, 2500, 5000, 10000];

const ROUTES: Record<ProductTypeOption["kind"], RouteConfig[]> = {
  label: [
    {
      key: "fully_in_house",
      name: "Fully in-house",
      help: "Use this when GSO produces the label/sticker work internally.",
      fields: ["size_area", "material_cost", "finishing_labor", "setup_prepress", "packing_labor", "manual_sell_tiers"],
    },
    {
      key: "outsourced_print_in_house_finish",
      name: "Outsourced print + in-house finishing",
      help: "Use this when print/lamination is bought from a supplier but GSO adds finishing, packing, or QC.",
      fields: ["supplier_cost_tiers", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  box: [
    {
      key: "fully_outsourced",
      name: "Fully outsourced",
      help: "Use this when the supplier provides the finished box and GSO only marks it up.",
      fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
    {
      key: "outsourced_blank_in_house_finish",
      name: "Outsourced blank + in-house finishing",
      help: "Use this when the box/blank is sourced and GSO adds finishing, packing, or other labor.",
      fields: ["supplier_cost_tiers", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  dtp: [
    {
      key: "fully_outsourced",
      name: "Fully outsourced",
      help: "Use this when the supplier provides the finished DTP/shape bag.",
      fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
    {
      key: "outsourced_print_in_house_finish",
      name: "Outsourced print/lamination + in-house finishing",
      help: "Use this when print/lamination is outsourced and GSO does finishing, QC, or packing.",
      fields: ["supplier_cost_tiers", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  jar: [
    {
      key: "fully_outsourced",
      name: "Fully outsourced",
      help: "Use this when the jar/container is purchased finished and sold as-is.",
      fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
    {
      key: "outsourced_item_in_house_label_application",
      name: "Outsourced item + in-house label/application",
      help: "Use this for pop tops, jars, or containers bought from a supplier and labeled by GSO.",
      fields: ["supplier_cost_tiers", "label_cost", "application_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  sticker_bag: [
    {
      key: "outsourced_blank_in_house_label_application",
      name: "Outsourced blank + in-house label/application",
      help: "Use this for custom sticker-bag work that is not already a Shopify product.",
      fields: ["supplier_cost_tiers", "label_cost", "application_labor", "packing_labor", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  sourced: [
    {
      key: "fully_outsourced",
      name: "Fully outsourced / sourced product",
      help: "Use this for new sourced products where you enter supplier cost and sell tiers.",
      fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
  general: [
    {
      key: "mixed_custom",
      name: "Mixed / custom route",
      help: "Use this when the job does not fit a standard route yet.",
      fields: ["supplier_cost_tiers", "material_cost", "label_cost", "application_labor", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"],
    },
  ],
};

const FALLBACK_PRODUCT_TYPES: ProductTypeOption[] = [
  {
    id: "fallback-sourced",
    key: "general_sourced_product",
    name: "General Sourced Product",
    source: "fallback",
    defaultMarginPct: 60,
    tierBreakpoints: "100,500,1000,2500,5000,10000",
    productionMode: "outsourced",
    kind: "sourced",
    routes: ROUTES.sourced,
  },
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

function boolField(route: RouteConfig, field: FieldGroup) {
  return route.fields.includes(field);
}

function inferKind(key: string, name: string, productionMode: string): ProductTypeOption["kind"] {
  const value = `${key} ${name} ${productionMode}`.toLowerCase();
  if (value.includes("label") || value.includes("sticker")) {
    if (value.includes("bag")) return "sticker_bag";
    return "label";
  }
  if (value.includes("box") || value.includes("carton")) return "box";
  if (value.includes("dtp") || value.includes("shape") || value.includes("pouch")) return "dtp";
  if (value.includes("jar") || value.includes("container") || value.includes("pop top") || value.includes("poptop")) return "jar";
  if (value.includes("source") || value.includes("outsourc")) return "sourced";
  return "general";
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function productTypeToOption(profile: { id: string; key: string; name: string; defaultMarginPct: number; tierBreakpoints: string; productionMode: string; }): ProductTypeOption {
  const kind = inferKind(profile.key, profile.name, profile.productionMode);
  return {
    id: profile.id,
    key: profile.key || normalizeKey(profile.name),
    name: profile.name,
    source: "erp",
    defaultMarginPct: Number(profile.defaultMarginPct || 60),
    tierBreakpoints: profile.tierBreakpoints || "100,500,1000,2500,5000,10000",
    productionMode: profile.productionMode || "hybrid",
    kind,
    routes: ROUTES[kind] || ROUTES.general,
  };
}

function parseTierDefaults(productType: ProductTypeOption) {
  const parsed = String(productType.tierBreakpoints || "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 6);
  const merged = parsed.length ? parsed : DEFAULT_TIERS;
  while (merged.length < 6) merged.push(DEFAULT_TIERS[merged.length] || merged[merged.length - 1] * 2);
  return merged.slice(0, 6);
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

function costBreakdownForRoute(route: RouteConfig, input: CalculatorInput, quantity: number, supplierCostEach: number, laborRatePerHour: number, appFloorPerSide: number) {
  const perUnitAllocation = (boolField(route, "freight_tooling") ? input.freightTotal + input.toolingTotal : 0) / Math.max(1, quantity);
  const setupPerUnit = boolField(route, "setup_prepress") ? input.setupPrepressTotal / Math.max(1, quantity) : 0;
  const sizeArea = Math.max(0, input.widthIn) * Math.max(0, input.heightIn);
  const materialCost = boolField(route, "size_area") || boolField(route, "material_cost") ? input.materialCostEach : 0;
  const labelCost = boolField(route, "label_cost") ? input.labelCostEach : 0;
  const applicationRaw = boolField(route, "application_labor") ? (input.applicationSecondsPerUnit / 3600) * laborRatePerHour * Math.max(1, input.applicationCount) : 0;
  const applicationFloor = boolField(route, "application_labor") ? appFloorPerSide * Math.max(1, input.applicationCount) : 0;
  const applicationLabor = boolField(route, "application_labor") ? Math.max(applicationRaw, applicationFloor) : 0;
  const finishingLabor = boolField(route, "finishing_labor") ? (input.finishingSecondsPerUnit / 3600) * laborRatePerHour : 0;
  const packingLabor = boolField(route, "packing_labor") ? (input.packingSecondsPerUnit / 3600) * laborRatePerHour : 0;
  const preWaste = supplierCostEach + perUnitAllocation + setupPerUnit + materialCost + labelCost;
  const wasteCost = preWaste * Math.max(0, input.wastePct) / 100;
  const total = preWaste + wasteCost + applicationLabor + finishingLabor + packingLabor;
  return { sizeArea, supplierCostEach, perUnitAllocation, setupPerUnit, materialCost, labelCost, wasteCost, applicationLabor, finishingLabor, packingLabor, total };
}

function buildTierRows(url: URL, input: CalculatorInput, productType: ProductTypeOption, route: RouteConfig, laborRatePerHour: number, appFloorPerSide: number): TierRow[] {
  return parseTierDefaults(productType).map((defaultQty, i) => {
    const index = i + 1;
    const quantity = Math.max(1, Math.round(numberParam(url, `qty${index}`, defaultQty)));
    const defaultCost = input.costMode === "flat" ? input.flatCostEach : input.flatCostEach;
    const supplierCostEach = boolField(route, "supplier_cost_tiers") ? Math.max(0, numberParam(url, `cost${index}`, defaultCost)) : 0;
    const manualPriceEach = Math.max(0, numberParam(url, `price${index}`, 0));
    const breakdown = costBreakdownForRoute(route, input, quantity, supplierCostEach, laborRatePerHour, appFloorPerSide);
    const calculatedCostEach = breakdown.total;
    const suggestedPriceEach = roundNickel(priceForMargin(calculatedCostEach, input.targetMargin));
    const suggestedMargin = marginFromPrice(suggestedPriceEach, calculatedCostEach);
    const manualMargin = marginFromPrice(manualPriceEach, calculatedCostEach);
    return {
      index,
      quantity,
      supplierCostEach,
      calculatedCostEach,
      manualPriceEach,
      suggestedPriceEach,
      suggestedTotal: suggestedPriceEach * quantity,
      manualMargin,
      suggestedMargin,
      status: statusForManualPrice(manualPriceEach, calculatedCostEach, input.targetMargin),
    };
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const settings = await db.marginReviewSetting.findFirst({ where: { shop, active: true }, orderBy: { updatedAt: "desc" } });
  const profiles = await db.productTypeProfile.findMany({
    where: { shop, active: true },
    select: { id: true, key: true, name: true, defaultMarginPct: true, tierBreakpoints: true, productionMode: true },
    orderBy: [{ name: "asc" }],
    take: 50,
  });

  const erpProductTypes = profiles.map(productTypeToOption);
  const productTypes = erpProductTypes.length ? [...erpProductTypes, ...FALLBACK_PRODUCT_TYPES] : FALLBACK_PRODUCT_TYPES;
  const selectedProductTypeKey = stringParam(url, "productTypeKey", productTypes[0]?.key || "general_sourced_product");
  const selectedProductType = productTypes.find((type) => type.key === selectedProductTypeKey) || productTypes[0] || FALLBACK_PRODUCT_TYPES[0];
  const requestedRouteKey = stringParam(url, "routeKey", selectedProductType.routes[0]?.key || "fully_outsourced");
  const selectedRoute = selectedProductType.routes.find((route) => route.key === requestedRouteKey) || selectedProductType.routes[0] || ROUTES.sourced[0];

  const input: CalculatorInput = {
    productName: stringParam(url, "productName", "New custom item"),
    productTypeKey: selectedProductType.key,
    routeKey: selectedRoute.key,
    vendor: stringParam(url, "vendor", ""),
    targetMargin: numberParam(url, "targetMargin", selectedProductType.defaultMarginPct || 60),
    costMode: stringParam(url, "costMode", "flat") === "breaks" ? "breaks" : "flat",
    flatCostEach: numberParam(url, "flatCostEach", 0.5),
    widthIn: numberParam(url, "widthIn", 0),
    heightIn: numberParam(url, "heightIn", 0),
    materialCostEach: numberParam(url, "materialCostEach", 0),
    labelCostEach: numberParam(url, "labelCostEach", 0),
    applicationCount: numberParam(url, "applicationCount", 1),
    applicationSecondsPerUnit: numberParam(url, "applicationSecondsPerUnit", 10),
    finishingSecondsPerUnit: numberParam(url, "finishingSecondsPerUnit", 0),
    packingSecondsPerUnit: numberParam(url, "packingSecondsPerUnit", 0),
    freightTotal: numberParam(url, "freightTotal", 0),
    toolingTotal: numberParam(url, "toolingTotal", 0),
    setupPrepressTotal: numberParam(url, "setupPrepressTotal", 0),
    wastePct: numberParam(url, "wastePct", 0),
    notes: stringParam(url, "notes", ""),
  };

  const laborRatePerHour = Number(settings?.laborRatePerHour || 25);
  const applicationLaborFloorPerSide = Number(settings?.applicationLaborFloorPerSide || 0.2);
  const tierRows = buildTierRows(url, input, selectedProductType, selectedRoute, laborRatePerHour, applicationLaborFloorPerSide);
  const validCosts = tierRows.filter((row) => row.calculatedCostEach > 0);
  const averageCost = validCosts.length ? validCosts.reduce((sum, row) => sum + row.calculatedCostEach, 0) / validCosts.length : 0;
  const lowestSuggested = tierRows.reduce((min, row) => row.suggestedPriceEach > 0 ? Math.min(min, row.suggestedPriceEach) : min, Number.POSITIVE_INFINITY);
  const lowMarginCount = tierRows.filter((row) => row.status === "low_margin" || row.status === "below_cost").length;
  const firstBreakdown = costBreakdownForRoute(selectedRoute, input, tierRows[0]?.quantity || 1, tierRows[0]?.supplierCostEach || 0, laborRatePerHour, applicationLaborFloorPerSide);

  return Response.json({
    input,
    productTypes,
    selectedProductType,
    selectedRoute,
    tierRows,
    routeFields: selectedRoute.fields,
    firstBreakdown,
    metrics: {
      averageCost,
      lowestSuggested: Number.isFinite(lowestSuggested) ? lowestSuggested : 0,
      lowMarginCount,
      laborRatePerHour,
      applicationLaborFloorPerSide,
    },
  });
}

export default function WholesaleCalculator() {
  const data = useLoaderData<typeof loader>();
  const input = data.input as CalculatorInput;
  const selectedRoute = data.selectedRoute as RouteConfig;
  const routeFields = data.routeFields as FieldGroup[];
  const show = (field: FieldGroup) => routeFields.includes(field);

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif", color: "#111827" }}>
      <section style={{ background: "linear-gradient(90deg,#111827,#4b5563)", color: "white", borderRadius: 12, padding: 24, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Product Cost Calculator</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
          v12.4: product type and production route driven. Product types come from ERP Product Type setup where available; each route opens only the calculator sections needed for that job.
        </p>
      </section>

      <section style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <strong>Correct workflow:</strong> Existing Shopify products stay in Margin Review. Use this calculator for new/custom products, outsourced items, or jobs that are not already priced on the website.
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Product type and route</h2>
        <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <label style={labelStyle("span 2")}>
            New product / item name
            <input name="productName" defaultValue={input.productName} placeholder="Pop top jar, custom box, shape bag" style={fieldStyle} />
          </label>
          <label style={labelStyle("span 2")}>
            Product type from ERP setup
            <select name="productTypeKey" defaultValue={input.productTypeKey} style={fieldStyle}>
              {data.productTypes.map((type: ProductTypeOption) => <option key={type.key} value={type.key}>{type.name}{type.source === "fallback" ? " (fallback)" : ""}</option>)}
            </select>
          </label>
          <label style={labelStyle("span 2")}>
            Production route
            <select name="routeKey" defaultValue={input.routeKey} style={fieldStyle}>
              {(data.selectedProductType.routes as RouteConfig[]).map((route: RouteConfig) => <option key={route.key} value={route.key}>{route.name}</option>)}
            </select>
          </label>

          <label style={labelStyle("span 2")}>
            Vendor / supplier
            <input name="vendor" defaultValue={input.vendor} placeholder="optional" style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Target margin %
            <input name="targetMargin" type="number" min="0" max="95" step="0.1" defaultValue={input.targetMargin} style={fieldStyle} />
          </label>
          <label style={labelStyle()}>
            Supplier cost mode
            <select name="costMode" defaultValue={input.costMode} disabled={!show("supplier_cost_tiers")} style={{ ...fieldStyle, opacity: show("supplier_cost_tiers") ? 1 : 0.5 }}>
              <option value="flat">Same cost at every quantity</option>
              <option value="breaks">Supplier cost breaks by quantity</option>
            </select>
          </label>
          <label style={labelStyle()}>
            Default supplier cost each
            <input name="flatCostEach" type="number" min="0" step="0.0001" defaultValue={input.flatCostEach} disabled={!show("supplier_cost_tiers")} style={{ ...fieldStyle, opacity: show("supplier_cost_tiers") ? 1 : 0.5 }} />
          </label>
          <label style={labelStyle()}>
            Waste %
            <input name="wastePct" type="number" min="0" step="0.1" defaultValue={input.wastePct} style={fieldStyle} />
          </label>

          <section style={{ gridColumn: "span 6", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
            <strong>{selectedRoute.name}</strong>
            <p style={{ margin: "4px 0 0", color: "#4b5563", fontSize: 12 }}>{selectedRoute.help}</p>
            <p style={{ margin: "8px 0 0", color: "#6b7280", fontSize: 12 }}>
              Active calculator sections: {routeFields.map((field) => field.replaceAll("_", " ")).join(", ")}
            </p>
          </section>

          {show("size_area") && (
            <>
              <label style={labelStyle()}>
                Width inches
                <input name="widthIn" type="number" min="0" step="0.001" defaultValue={input.widthIn} style={fieldStyle} />
              </label>
              <label style={labelStyle()}>
                Height inches
                <input name="heightIn" type="number" min="0" step="0.001" defaultValue={input.heightIn} style={fieldStyle} />
              </label>
            </>
          )}

          {show("material_cost") && (
            <label style={labelStyle()}>
              Material cost each
              <input name="materialCostEach" type="number" min="0" step="0.0001" defaultValue={input.materialCostEach} style={fieldStyle} />
            </label>
          )}

          {show("label_cost") && (
            <label style={labelStyle()}>
              Label cost each
              <input name="labelCostEach" type="number" min="0" step="0.0001" defaultValue={input.labelCostEach} style={fieldStyle} />
            </label>
          )}

          {show("application_labor") && (
            <>
              <label style={labelStyle()}>
                Application count
                <input name="applicationCount" type="number" min="1" step="1" defaultValue={input.applicationCount} style={fieldStyle} />
              </label>
              <label style={labelStyle()}>
                App seconds/unit
                <input name="applicationSecondsPerUnit" type="number" min="0" step="0.1" defaultValue={input.applicationSecondsPerUnit} style={fieldStyle} />
              </label>
            </>
          )}

          {show("finishing_labor") && (
            <label style={labelStyle()}>
              Finishing seconds/unit
              <input name="finishingSecondsPerUnit" type="number" min="0" step="0.1" defaultValue={input.finishingSecondsPerUnit} style={fieldStyle} />
            </label>
          )}

          {show("packing_labor") && (
            <label style={labelStyle()}>
              Packing seconds/unit
              <input name="packingSecondsPerUnit" type="number" min="0" step="0.1" defaultValue={input.packingSecondsPerUnit} style={fieldStyle} />
            </label>
          )}

          {show("freight_tooling") && (
            <>
              <label style={labelStyle()}>
                Freight total
                <input name="freightTotal" type="number" min="0" step="0.01" defaultValue={input.freightTotal} style={fieldStyle} />
              </label>
              <label style={labelStyle()}>
                Tooling/die total
                <input name="toolingTotal" type="number" min="0" step="0.01" defaultValue={input.toolingTotal} style={fieldStyle} />
              </label>
            </>
          )}

          {show("setup_prepress") && (
            <label style={labelStyle()}>
              Setup/prepress total
              <input name="setupPrepressTotal" type="number" min="0" step="0.01" defaultValue={input.setupPrepressTotal} style={fieldStyle} />
            </label>
          )}

          <label style={labelStyle("span 6")}>
            Notes
            <input name="notes" defaultValue={input.notes} placeholder="Supplier quote, MOQ, cap included, shipping not included, finishing notes, etc." style={fieldStyle} />
          </label>

          {show("supplier_cost_tiers") && (
            <div style={{ gridColumn: "span 6", borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Supplier costs and selling tiers</h3>
              <TierEditTable rows={data.tierRows as TierRow[]} />
            </div>
          )}

          {!show("supplier_cost_tiers") && (
            <div style={{ gridColumn: "span 6", borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Selling tiers</h3>
              <TierEditTable rows={data.tierRows as TierRow[]} hideSupplierCost />
            </div>
          )}

          <button type="submit" style={{ padding: "12px 16px", borderRadius: 8, background: "#111827", color: "white", border: 0, fontWeight: 800, gridColumn: "span 2" }}>Calculate pricing</button>
          <p style={{ gridColumn: "span 4", margin: 0, fontSize: 12, color: "#6b7280" }}>
            This page does not update Shopify. Product Type setup controls which routes and fields appear; this keeps staff from seeing irrelevant calculator inputs.
          </p>
        </Form>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <Metric title="Product" value={input.productName || "New product"} note={`${data.selectedProductType.name} / ${selectedRoute.name}`} />
        <Metric title="Average calculated cost" value={money(data.metrics.averageCost)} note="Across entered tiers" />
        <Metric title="Lowest suggested price" value={money(data.metrics.lowestSuggested)} note={`${pct(input.targetMargin)} target margin`} strong />
        <Metric title="Manual price warnings" value={`${data.metrics.lowMarginCount}`} note="Low margin or below cost" />
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Cost sections used by this route</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
          <Mini title="Supplier/item" value={money(data.firstBreakdown.supplierCostEach)} active={show("supplier_cost_tiers")} />
          <Mini title="Material" value={money(data.firstBreakdown.materialCost + data.firstBreakdown.labelCost)} active={show("material_cost") || show("label_cost")} />
          <Mini title="Labor" value={money(data.firstBreakdown.applicationLabor + data.firstBreakdown.finishingLabor + data.firstBreakdown.packingLabor)} active={show("application_labor") || show("finishing_labor") || show("packing_labor")} />
          <Mini title="Freight/tool/setup" value={money(data.firstBreakdown.perUnitAllocation + data.firstBreakdown.setupPerUnit)} active={show("freight_tooling") || show("setup_prepress")} />
          <Mini title="Waste" value={money(data.firstBreakdown.wasteCost)} active={input.wastePct > 0} />
        </div>
      </section>

      <section style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Suggested sell tiers</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={cellHeader}>Quantity</th>
                <th style={cellHeader}>Calculated cost</th>
                <th style={cellHeader}>Suggested sell price</th>
                <th style={cellHeader}>Suggested margin</th>
                <th style={cellHeader}>Suggested total</th>
                <th style={cellHeader}>Manual price</th>
                <th style={cellHeader}>Manual margin</th>
                <th style={cellHeader}>Check</th>
              </tr>
            </thead>
            <tbody>
              {(data.tierRows as TierRow[]).map((row) => (
                <tr key={row.index}>
                  <td style={cell}>{row.quantity.toLocaleString()}</td>
                  <td style={cell}>{money(row.calculatedCostEach)}</td>
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
          Next patch can add a Product Type setup editor so you can control allowed routes and field groups without code. For now this page reads ERP Product Type profiles and applies safe default route rules.
        </p>
      </section>
    </main>
  );
}

function TierEditTable({ rows, hideSupplierCost = false }: { rows: TierRow[]; hideSupplierCost?: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
            <th style={cellHeader}>Tier</th>
            <th style={cellHeader}>Quantity</th>
            {!hideSupplierCost && <th style={cellHeader}>Supplier cost each</th>}
            <th style={cellHeader}>Manual sell price each</th>
            <th style={cellHeader}>Calculated cost</th>
            <th style={cellHeader}>Suggested price</th>
            <th style={cellHeader}>Manual margin</th>
            <th style={cellHeader}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.index}>
              <td style={cell}>{row.index}</td>
              <td style={cell}><input name={`qty${row.index}`} type="number" min="1" defaultValue={row.quantity} style={smallInputStyle} /></td>
              {!hideSupplierCost && <td style={cell}><input name={`cost${row.index}`} type="number" min="0" step="0.0001" defaultValue={row.supplierCostEach} style={smallInputStyle} /></td>}
              <td style={cell}><input name={`price${row.index}`} type="number" min="0" step="0.01" defaultValue={row.manualPriceEach || ""} placeholder="optional" style={smallInputStyle} /></td>
              <td style={cell}>{money(row.calculatedCostEach)}</td>
              <td style={{ ...cell, fontWeight: 800 }}>{money(row.suggestedPriceEach)}</td>
              <td style={cell}>{row.manualMargin == null ? "N/A" : pct(row.manualMargin)}</td>
              <td style={cell}><StatusBadge status={row.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function Mini({ title, value, active }: { title: string; value: string; active: boolean }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: active ? "#fff" : "#f9fafb", opacity: active ? 1 : 0.55 }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{active ? "included" : "not used"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: TierRow["status"] }) {
  return <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: statusColor(status), fontWeight: 800 }}>{statusLabel(status)}</span>;
}
