import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type FieldGroup =
  | "supplier_cost_tiers"
  | "size_area"
  | "material_cost"
  | "ink_machine_cost"
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

type ProductKind = "label" | "box" | "dtp" | "jar" | "sticker_bag" | "sourced" | "general";

const FIELD_LABELS: Record<FieldGroup, string> = {
  supplier_cost_tiers: "Supplier cost tiers",
  size_area: "Size / area",
  material_cost: "Material / media cost",
  ink_machine_cost: "Ink / machine cost",
  label_cost: "Manual label cost",
  application_labor: "Application labor",
  finishing_labor: "Finishing labor",
  packing_labor: "Packing labor",
  freight_tooling: "Freight / tooling",
  setup_prepress: "Setup / prepress",
  manual_sell_tiers: "Manual sell tiers",
};

const ROUTES: Record<ProductKind, RouteConfig[]> = {
  label: [
    { key: "fully_in_house", name: "Fully in-house label/sticker", help: "GSO produces the label/sticker work internally. Opens label size, material, finish, setup, and labor fields.", fields: ["size_area", "material_cost", "ink_machine_cost", "finishing_labor", "setup_prepress", "packing_labor", "manual_sell_tiers"] },
    { key: "outsourced_print_in_house_finish", name: "Outsourced print + in-house finishing", help: "Supplier prints/laminates; GSO adds finishing, packing, or QC. Label size/material fields remain visible for quote clarity.", fields: ["supplier_cost_tiers", "size_area", "material_cost", "ink_machine_cost", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
    { key: "outsourced_item_in_house_label_application", name: "Outsourced item + in-house label/application", help: "GSO buys an item like a jar, bag, or container, then produces/applies labels in-house.", fields: ["supplier_cost_tiers", "size_area", "material_cost", "ink_machine_cost", "label_cost", "application_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
  box: [
    { key: "fully_outsourced", name: "Fully outsourced", help: "Supplier provides the finished box and GSO marks it up.", fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
    { key: "outsourced_blank_in_house_finish", name: "Outsourced blank + in-house finishing", help: "Box/blank is sourced and GSO adds finishing, packing, or labor.", fields: ["supplier_cost_tiers", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
  dtp: [
    { key: "fully_outsourced", name: "Fully outsourced", help: "Supplier provides the finished DTP/shape bag.", fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
    { key: "outsourced_print_in_house_finish", name: "Outsourced print/lamination + in-house finishing", help: "Print/lamination is outsourced and GSO does finishing, QC, or packing.", fields: ["supplier_cost_tiers", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
  jar: [
    { key: "fully_outsourced", name: "Fully outsourced", help: "Jar/container is purchased finished and sold as-is.", fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
    { key: "outsourced_item_in_house_label_application", name: "Outsourced item + in-house label/application", help: "Pop tops, jars, or containers bought from a supplier and labeled by GSO.", fields: ["supplier_cost_tiers", "size_area", "material_cost", "ink_machine_cost", "label_cost", "application_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
  sticker_bag: [
    { key: "outsourced_blank_in_house_label_application", name: "Outsourced blank + in-house label/application", help: "Custom sticker-bag work that is not already a Shopify product.", fields: ["supplier_cost_tiers", "size_area", "material_cost", "ink_machine_cost", "label_cost", "application_labor", "packing_labor", "setup_prepress", "manual_sell_tiers"] },
  ],
  sourced: [
    { key: "fully_outsourced", name: "Fully outsourced / sourced product", help: "New sourced products where staff enters supplier cost and sell tiers.", fields: ["supplier_cost_tiers", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
  general: [
    { key: "mixed_custom", name: "Mixed / custom route", help: "Jobs that do not fit a standard route yet.", fields: ["supplier_cost_tiers", "material_cost", "label_cost", "application_labor", "finishing_labor", "packing_labor", "freight_tooling", "setup_prepress", "manual_sell_tiers"] },
  ],
};

const KIND_OPTIONS: { key: ProductKind; label: string }[] = [
  { key: "label", label: "Labels" },
  { key: "box", label: "Boxes" },
  { key: "dtp", label: "DTP / Shape Bags" },
  { key: "jar", label: "Jars / Containers" },
  { key: "sticker_bag", label: "Sticker Bags" },
  { key: "sourced", label: "General Sourced Product" },
  { key: "general", label: "Mixed / General Custom" },
];

function cleanProductTypeName(name: string, key: string) {
  return String(name || key || "Product Type")
    .replace(/\s*[-–—]?\s*Pricing\s+Template\s*$/i, "")
    .replace(/\s*[-–—]?\s*Calculator\s+Template\s*$/i, "")
    .replace(/\s*[-–—]?\s*Template\s*$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Product Type";
}

function inferKind(key: string, name: string, productionMode: string): ProductKind {
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

function validKind(value: unknown): ProductKind | null {
  const key = String(value || "").trim();
  if (["label", "box", "dtp", "jar", "sticker_bag", "sourced", "general"].includes(key)) return key as ProductKind;
  return null;
}

function parseRouteKeys(json: string | null | undefined) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((route: any) => String(route?.key || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const saved = url.searchParams.get("saved") === "1";

  const profiles = await db.productTypeProfile.findMany({
    where: { shop, active: true },
    select: {
      id: true,
      key: true,
      name: true,
      productionMode: true,
      defaultMarginPct: true,
      tierBreakpoints: true,
      calculatorKind: true,
      calculatorRoutesJson: true,
    },
    orderBy: [{ name: "asc" }],
    take: 50,
  });

  return Response.json({
    saved,
    profiles: profiles.map((profile) => {
      const kind = validKind(profile.calculatorKind) || inferKind(profile.key, profile.name, profile.productionMode);
      const routeKeys = parseRouteKeys(profile.calculatorRoutesJson);
      return {
        ...profile,
        displayName: cleanProductTypeName(profile.name, profile.key),
        resolvedKind: kind,
        savedRouteKeys: routeKeys.length ? routeKeys : ROUTES[kind].map((route) => route.key),
        availableRoutes: ROUTES[kind],
      };
    }),
    kindOptions: KIND_OPTIONS,
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const id = String(formData.get("id") || "");
  const kind = validKind(formData.get("calculatorKind")) || "general";
  const intent = String(formData.get("intent") || "save");
  const selectedRoutes = intent === "reset"
    ? (ROUTES[kind] || ROUTES.general).map((route) => route.key)
    : formData.getAll("routeKeys").map((value) => {
        const key = String(value);
        return kind === "label" && key === "outsourced_blank_in_house_finish" ? "outsourced_item_in_house_label_application" : key;
      });
  const routes = (ROUTES[kind] || ROUTES.general).filter((route) => selectedRoutes.includes(route.key));
  const routesToSave = routes.length ? routes : [ROUTES[kind][0] || ROUTES.general[0]];

  await db.productTypeProfile.update({
    where: { id, shop },
    data: {
      calculatorKind: kind,
      calculatorRoutesJson: JSON.stringify(routesToSave),
    },
  });

  return new Response(null, {
    status: 302,
    headers: { Location: "/app/erp/product-type-routes?saved=1" },
  });
}

function kindLabel(kind: ProductKind) {
  return KIND_OPTIONS.find((option) => option.key === kind)?.label || "Product Type";
}

function routeNamesFor(profile: any) {
  const routes = ROUTES[profile.resolvedKind as ProductKind] || ROUTES.general;
  return routes
    .filter((route) => profile.savedRouteKeys.includes(route.key))
    .map((route) => route.name);
}

const pillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 999,
  padding: "4px 9px",
  fontSize: 12,
  fontWeight: 700,
  background: "#eef2ff",
  color: "#3730a3",
  marginRight: 6,
  marginTop: 6,
};

export default function ProductTypeRoutes() {
  const data = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif", color: "#111827" }}>
      <section style={{ background: "linear-gradient(90deg,#111827,#4b5563)", color: "white", borderRadius: 12, padding: 24, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Product Type Route Setup</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
          v12.7: clean route setup. Each product type controls the routes staff can use and the calculator field groups that appear for that route.
        </p>
      </section>

      {data.saved && (
        <section style={{ background: "#dcfce7", border: "1px solid #86efac", borderRadius: 12, padding: 14, marginBottom: 16, color: "#166534", fontWeight: 700 }}>
          Product type calculator route settings saved.
        </section>
      )}

      <section style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <strong>Setup rule:</strong> Product Type controls the route dropdown. Production Route controls the calculator fields. Existing Shopify product prices still stay in Margin Review; this setup only controls custom/new-product calculator jobs.
        <div style={{ marginTop: 10 }}>
          <a href="/app/wholesale/calculator" style={{ color: "#1d4ed8", fontWeight: 800 }}>Open Product Cost Calculator</a>
        </div>
      </section>

      <div style={{ display: "grid", gap: 14 }}>
        {data.profiles.map((profile: any) => {
          const routes = ROUTES[profile.resolvedKind as ProductKind] || ROUTES.general;
          const selectedRouteNames = routeNamesFor(profile);
          return (
            <section key={profile.id} style={{ background: "#fff", border: "1px solid #d9dde6", borderRadius: 12, padding: 16 }}>
              <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, alignItems: "start" }}>
                <input type="hidden" name="id" value={profile.id} />
                <div style={{ gridColumn: "span 2" }}>
                  <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>{profile.displayName}</h2>
                  <p style={{ margin: 0, color: "#6b7280", fontSize: 12 }}>ERP key: {profile.key}</p>
                  <p style={{ margin: "6px 0 0", color: "#6b7280", fontSize: 12 }}>Default margin: {Number(profile.defaultMarginPct || 0).toFixed(1)}%</p>
                  <div style={{ marginTop: 8 }}>
                    <span style={pillStyle}>{kindLabel(profile.resolvedKind)}</span>
                    <span style={{ ...pillStyle, background: "#dcfce7", color: "#166534" }}>{selectedRouteNames.length} active route(s)</span>
                  </div>
                </div>

                <label style={{ gridColumn: "span 2", fontSize: 12, fontWeight: 700 }}>
                  Calculator kind
                  <select name="calculatorKind" defaultValue={profile.resolvedKind} style={fieldStyle}>
                    {data.kindOptions.map((kind: any) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
                  </select>
                  <span style={{ display: "block", color: "#6b7280", fontWeight: 400, marginTop: 4 }}>
                    This maps existing ERP profiles into clean calculator categories like Labels, Boxes, DTP Bags, Sticker Bags, and Sourced Products. Save after changing kind.
                  </span>
                </label>

                <div style={{ gridColumn: "span 2" }}>
                  <button type="submit" name="intent" value="save" style={buttonStyle}>Save route setup</button>
                  <button type="submit" name="intent" value="reset" style={secondaryButtonStyle}>Reset to recommended routes</button>
                </div>

                <div style={{ gridColumn: "span 6", borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
                  <strong style={{ fontSize: 13 }}>Allowed production routes for this product type</strong>
                  <p style={{ margin: "6px 0 0", color: "#6b7280", fontSize: 12 }}>Only checked routes will appear in the calculator. Each route displays only its listed calculator field groups.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 8 }}>
                    {routes.map((route) => (
                      <label key={route.key} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "block", fontSize: 12 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input type="checkbox" name="routeKeys" value={route.key} defaultChecked={profile.savedRouteKeys.includes(route.key)} />
                          <strong>{route.name}</strong>
                        </div>
                        <p style={{ margin: "6px 0", color: "#6b7280" }}>{route.help}</p>
                        <div style={{ marginTop: 8 }}>
                          {route.fields.map((field) => (
                            <span key={field} style={{ ...pillStyle, background: "#f3f4f6", color: "#374151", fontWeight: 600 }}>{FIELD_LABELS[field]}</span>
                          ))}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </Form>
            </section>
          );
        })}
      </div>
    </main>
  );
}

const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid #cfd6e4", borderRadius: 6, padding: "9px 10px", marginTop: 4 };
const buttonStyle: React.CSSProperties = { width: "100%", background: "#111827", color: "#fff", border: 0, borderRadius: 8, padding: "11px 14px", fontWeight: 800, cursor: "pointer", marginTop: 18 };
const secondaryButtonStyle: React.CSSProperties = { width: "100%", background: "#f3f4f6", color: "#111827", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer", marginTop: 8 };
