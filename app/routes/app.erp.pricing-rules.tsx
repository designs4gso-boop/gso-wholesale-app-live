import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const VERSION = "Tier Rule Manager v1.0";
const DEFAULT_TIERS = [100, 250, 500, 1000, 2500, 5000, 10000];
const SCOPE_OPTIONS = ["global", "collection", "product", "variant"] as const;
const MODE_OPTIONS = ["percent_off", "fixed_price"] as const;

type TierRuleRow = {
  id: string;
  title: string;
  scopeType: string;
  scopeTarget: string;
  minQty: number;
  discountType: string;
  sellPrice: number | null;
  percentOff: number | null;
  minUnitPrice: number | null;
  active: boolean;
  priority: number;
  settings: {
    minMarginPct?: number;
    minOrderTotal?: number;
    rounding?: string;
    mode?: string;
  };
  createdAt: string;
  updatedAt: string;
};

function money(value: any) {
  const num = Number(value || 0);
  return `$${num.toFixed(2)}`;
}

function numberValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function settingString(values: { minMarginPct: number; minOrderTotal: number; rounding: string; mode: string }) {
  return `tier_settings|mode:${values.mode}|margin:${values.minMarginPct}|round:${values.rounding}|minTotal:${values.minOrderTotal}`;
}

function parseSettings(value: string | null | undefined) {
  const settings: TierRuleRow["settings"] = {};
  const raw = String(value || "");
  for (const part of raw.split("|")) {
    const [key, val] = part.split(":");
    if (key === "margin") settings.minMarginPct = Number(val || 0);
    if (key === "minTotal") settings.minOrderTotal = Number(val || 0);
    if (key === "round") settings.rounding = val || "0.05";
    if (key === "mode") settings.mode = val || "percent_off";
  }
  return settings;
}

function scopeFields(scopeType: string, target: string) {
  const scope = String(scopeType || "global").toLowerCase();
  const trimmed = String(target || "").trim();
  if (scope === "variant") {
    return { productTag: null, productGid: null, variantGid: trimmed || null };
  }
  if (scope === "product") {
    return { productTag: null, productGid: trimmed || null, variantGid: null };
  }
  if (scope === "collection") {
    return { productTag: `collection:${trimmed || "unassigned"}`, productGid: null, variantGid: null };
  }
  return { productTag: "global", productGid: null, variantGid: null };
}

function scopeLabel(rule: any) {
  if (rule.variantGid) return { scopeType: "variant", scopeTarget: rule.variantGid };
  if (rule.productGid) return { scopeType: "product", scopeTarget: rule.productGid };
  if (String(rule.productTag || "").startsWith("collection:")) return { scopeType: "collection", scopeTarget: String(rule.productTag).replace("collection:", "") };
  return { scopeType: "global", scopeTarget: "All products" };
}

function tierRowLabel(row: TierRuleRow) {
  if (row.discountType === "fixed_price") return `${money(row.sellPrice)} each`;
  return `${Number(row.percentOff || 0).toFixed(2)}% off`;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const rows = await db.pricingRule.findMany({
    where: { shop, customerTag: "gso_tier_rule" },
    orderBy: [{ priority: "asc" }, { title: "asc" }, { minQty: "asc" }],
  });

  const rules: TierRuleRow[] = rows.map((row: any) => {
    const scope = scopeLabel(row);
    return {
      id: row.id,
      title: row.title,
      scopeType: scope.scopeType,
      scopeTarget: scope.scopeTarget,
      minQty: row.minQty,
      discountType: row.discountType,
      sellPrice: row.sellPrice,
      percentOff: row.percentOff,
      minUnitPrice: row.unitCost,
      active: row.active,
      priority: row.priority,
      settings: parseSettings(row.sku),
      createdAt: row.createdAt?.toISOString?.() || "",
      updatedAt: row.updatedAt?.toISOString?.() || "",
    };
  });

  return { version: VERSION, rules };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "delete") {
    const title = String(form.get("title") || "").trim();
    const scopeType = String(form.get("scopeType") || "global").trim();
    const scopeTarget = String(form.get("scopeTarget") || "").trim();
    const fields = scopeFields(scopeType, scopeTarget === "All products" ? "" : scopeTarget);
    await db.pricingRule.deleteMany({
      where: {
        shop,
        customerTag: "gso_tier_rule",
        title,
        productTag: fields.productTag || undefined,
        productGid: fields.productGid || undefined,
        variantGid: fields.variantGid || undefined,
      },
    });
    return { ok: true, message: `Deleted tier rule group: ${title}` };
  }

  if (intent === "create") {
    const title = String(form.get("title") || "").trim() || "Untitled tier rule";
    const scopeType = String(form.get("scopeType") || "global").trim();
    const scopeTarget = String(form.get("scopeTarget") || "").trim();
    const mode = String(form.get("pricingMode") || "percent_off") === "fixed_price" ? "fixed_price" : "percent_off";
    const minMarginPct = numberValue(form.get("minMarginPct"), 50);
    const minOrderTotal = numberValue(form.get("minOrderTotal"), 0);
    const minUnitPrice = numberValue(form.get("minUnitPrice"), 0);
    const rounding = String(form.get("rounding") || "0.05");
    const active = String(form.get("active") || "on") === "on";
    const fields = scopeFields(scopeType, scopeTarget);
    const priority = scopeType === "variant" ? 10 : scopeType === "product" ? 25 : scopeType === "collection" ? 50 : 100;
    const settings = settingString({ minMarginPct, minOrderTotal, rounding, mode });

    const tierRows = DEFAULT_TIERS.map((qty) => {
      const discountPct = numberValue(form.get(`discount_${qty}`), 0);
      const fixedPrice = numberValue(form.get(`fixed_${qty}`), 0);
      return { qty, discountPct, fixedPrice };
    }).filter((tier) => tier.qty > 0 && (mode === "percent_off" || tier.fixedPrice > 0));

    if (!tierRows.length) {
      return { ok: false, message: "Add at least one valid tier row before saving." };
    }

    await db.pricingRule.deleteMany({
      where: {
        shop,
        customerTag: "gso_tier_rule",
        title,
        productTag: fields.productTag || undefined,
        productGid: fields.productGid || undefined,
        variantGid: fields.variantGid || undefined,
      },
    });

    await db.pricingRule.createMany({
      data: tierRows.map((tier) => ({
        shop,
        title,
        customerTag: "gso_tier_rule",
        productTag: fields.productTag,
        productGid: fields.productGid,
        variantGid: fields.variantGid,
        sku: settings,
        minQty: tier.qty,
        discountType: mode,
        sellPrice: mode === "fixed_price" ? tier.fixedPrice : null,
        percentOff: mode === "percent_off" ? tier.discountPct : null,
        unitCost: minUnitPrice || null,
        active,
        priority,
      })),
    });

    return { ok: true, message: `Saved ${tierRows.length} tier rows for ${title}.` };
  }

  return { ok: false, message: "Unknown tier rule action." };
}

function groupRules(rows: TierRuleRow[]) {
  const groups = new Map<string, TierRuleRow[]>();
  for (const row of rows) {
    const key = `${row.title}|${row.scopeType}|${row.scopeTarget}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, group]) => ({ key, group: group.sort((a, b) => a.minQty - b.minQty) }));
}

export default function ErpPricingRulesRoute() {
  const { version, rules } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const groups = groupRules(rules as TierRuleRow[]);

  return (
    <main style={{ maxWidth: 1180, margin: "32px auto", padding: 20, fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link to="/app">Dashboard</Link>
        <Link to="/app/erp/cost-calculator">Cost Calculator</Link>
        <Link to="/app/erp/product-setup">Product Setup</Link>
      </div>

      <section style={{ border: "1px solid #ddd", borderRadius: 14, padding: 20, marginBottom: 20, background: "#fff" }}>
        <p style={{ margin: "0 0 6px", color: "#666" }}>{version}</p>
        <h1 style={{ margin: 0 }}>Tier Rule Manager</h1>
        <p style={{ maxWidth: 900, lineHeight: 1.5 }}>
          Build tier rules that can later power product page live pricing, cart pricing, and Shopify Discount Function checkout enforcement. Rules support both percentage discounts and fixed unit prices. Rule priority will be: variant, product, collection, then global fallback.
        </p>
        {actionData?.message ? (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: actionData.ok ? "#e8f7ed" : "#fff3cd", border: "1px solid #ddd" }}>
            {actionData.message}
          </div>
        ) : null}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(360px, 0.95fr) minmax(420px, 1.25fr)", gap: 20, alignItems: "start" }}>
        <Form method="post" style={{ border: "1px solid #ddd", borderRadius: 14, padding: 20, background: "#fff" }}>
          <input type="hidden" name="intent" value="create" />
          <h2 style={{ marginTop: 0 }}>Create or replace tier rule</h2>
          <p style={{ color: "#666" }}>
            Use collection scope for bulk rules like Stock Bags. Use product or variant scope for overrides.
          </p>

          <label style={{ display: "block", marginTop: 12 }}>
            Rule name
            <input name="title" defaultValue="Stock Bags Tier Rule" style={inputStyle} />
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Scope
            <select name="scopeType" defaultValue="collection" style={inputStyle}>
              {SCOPE_OPTIONS.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
            </select>
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Target ID / handle
            <input name="scopeTarget" placeholder="Stock Bags, collection handle, product GID, or variant GID" defaultValue="Stock Bags" style={inputStyle} />
          </label>

          <label style={{ display: "block", marginTop: 12 }}>
            Pricing mode
            <select name="pricingMode" defaultValue="percent_off" style={inputStyle}>
              <option value="percent_off">Percentage discount tiers</option>
              <option value="fixed_price">Fixed unit price tiers</option>
            </select>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
            <label>
              Min margin %
              <input name="minMarginPct" type="number" step="0.01" defaultValue="50" style={inputStyle} />
            </label>
            <label>
              Min unit price
              <input name="minUnitPrice" type="number" step="0.01" defaultValue="0" style={inputStyle} />
            </label>
            <label>
              Min order total
              <input name="minOrderTotal" type="number" step="0.01" defaultValue="0" style={inputStyle} />
            </label>
          </div>

          <label style={{ display: "block", marginTop: 12 }}>
            Rounding rule
            <select name="rounding" defaultValue="0.05" style={inputStyle}>
              <option value="0.01">Round to nearest $0.01</option>
              <option value="0.05">Round up to nearest $0.05</option>
              <option value="0.10">Round up to nearest $0.10</option>
              <option value="0.25">Round up to nearest $0.25</option>
              <option value="1.00">Round up to nearest $1.00</option>
            </select>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <input name="active" type="checkbox" defaultChecked /> Active rule
          </label>

          <h3>Tier rows</h3>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr", gap: 8, fontWeight: 700 }}>
              <span>Qty</span><span>% off</span><span>Fixed price</span>
            </div>
            {DEFAULT_TIERS.map((qty, index) => (
              <div key={qty} style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr", gap: 8 }}>
                <input value={qty} readOnly style={{ ...inputStyle, background: "#f8f8f8" }} />
                <input name={`discount_${qty}`} type="number" step="0.01" defaultValue={index === 0 ? 0 : [5, 8, 12, 16, 20, 24][index - 1] || 0} style={inputStyle} />
                <input name={`fixed_${qty}`} type="number" step="0.01" placeholder="optional" style={inputStyle} />
              </div>
            ))}
          </div>

          <button type="submit" style={primaryButtonStyle}>Save tier rule</button>
        </Form>

        <section style={{ border: "1px solid #ddd", borderRadius: 14, padding: 20, background: "#fff" }}>
          <h2 style={{ marginTop: 0 }}>Saved rules</h2>
          {!groups.length ? <p>No tier rules saved yet.</p> : null}
          <div style={{ display: "grid", gap: 14 }}>
            {groups.map(({ key, group }) => {
              const first = group[0];
              return (
                <article key={key} style={{ border: "1px solid #e2e2e2", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <h3 style={{ margin: "0 0 4px" }}>{first.title}</h3>
                      <p style={{ margin: 0, color: "#666" }}>
                        Scope: <strong>{first.scopeType}</strong> · Target: <strong>{first.scopeTarget}</strong> · Mode: <strong>{first.discountType === "fixed_price" ? "Fixed unit price" : "Percentage discount"}</strong>
                      </p>
                      <p style={{ margin: "4px 0 0", color: "#666" }}>
                        Guardrails: min margin {first.settings.minMarginPct ?? 0}% · min unit {money(first.minUnitPrice)} · rounding ${first.settings.rounding || "0.05"}
                      </p>
                    </div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="title" value={first.title} />
                      <input type="hidden" name="scopeType" value={first.scopeType} />
                      <input type="hidden" name="scopeTarget" value={first.scopeTarget} />
                      <button type="submit" style={dangerButtonStyle}>Delete</button>
                    </Form>
                  </div>

                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Min qty</th>
                        <th style={thStyle}>Tier value</th>
                        <th style={thStyle}>Active</th>
                        <th style={thStyle}>Priority</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((row) => (
                        <tr key={row.id}>
                          <td style={tdStyle}>{row.minQty.toLocaleString()}</td>
                          <td style={tdStyle}>{tierRowLabel(row)}</td>
                          <td style={tdStyle}>{row.active ? "Yes" : "No"}</td>
                          <td style={tdStyle}>{row.priority}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              );
            })}
          </div>
        </section>
      </section>

      <section style={{ marginTop: 20, border: "1px solid #ddd", borderRadius: 14, padding: 20, background: "#fafafa" }}>
        <h2 style={{ marginTop: 0 }}>Build roadmap</h2>
        <ol style={{ lineHeight: 1.7 }}>
          <li><strong>v1.0:</strong> Save global, collection, product, and variant tier rules. This page.</li>
          <li><strong>v1.1:</strong> Add product/collection selector and preview affected variants.</li>
          <li><strong>v1.2:</strong> Generate safe tier prices from Cost Calculator backend costs.</li>
          <li><strong>v1.3:</strong> Store tier tables for product page and cart display.</li>
          <li><strong>v2.0:</strong> Shopify Discount Function checkout enforcement.</li>
        </ol>
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 10px",
  marginTop: 4,
  border: "1px solid #bbb",
  borderRadius: 8,
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop: 18,
  padding: "10px 14px",
  border: 0,
  borderRadius: 8,
  background: "#111827",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};

const dangerButtonStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #b91c1c",
  borderRadius: 8,
  background: "white",
  color: "#b91c1c",
  fontWeight: 700,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px" };
const tdStyle: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "8px" };
