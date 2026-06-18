import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { db } from "../db.server";

const STOCK_BAG_PRODUCT_TYPE = "stock_bag_4x5";
const STOCK_BAG_PRODUCT_TYPE_LABEL = "4x5 Stock Bag";
const STOCK_BAG_MIN_QTY = 64;
const STOCK_BAG_DEFAULT_SIDES = "Double Sided";

function norm(value: unknown) {
  return String(value ?? "").trim();
}

function sameText(a: unknown, b: string) {
  return norm(a).toLowerCase() === b.toLowerCase();
}

function productStatus(
  product: any,
  optionCount: number,
  pricingCount: number,
  shopifyLinksCount: number,
) {
  const issues: string[] = [];

  if (!norm(product.shopifyProductGid)) {
    issues.push("Missing Shopify Product GID");
  }

  if (!norm(product.shopifyVariantGid)) {
    issues.push("Missing Shopify Variant GID");
  }

  if (!norm(product.shopifyHandle)) {
    issues.push("Missing Shopify Handle");
  }

  if (!sameText(product.productType, STOCK_BAG_PRODUCT_TYPE)) {
    issues.push("Wrong ERP Product Type");
  }

  if (Number(product.minQuantity || 0) !== STOCK_BAG_MIN_QTY) {
    issues.push("Wrong Min Qty");
  }

  if (!sameText(product.defaultSides, STOCK_BAG_DEFAULT_SIDES)) {
    issues.push("Wrong Default Sides");
  }

  if (!product.active) {
    issues.push("Inactive");
  }

  if (optionCount <= 0) {
    issues.push("Missing options");
  }

  if (pricingCount <= 0) {
    issues.push("Missing pricing rules");
  }

  const baseReadyIssues = issues.filter((issue) => issue !== "Needs Shopify Links mapping");

  if (shopifyLinksCount <= 0) {
    issues.push("Needs Shopify Links mapping");
  }

  if (baseReadyIssues.length === 0 && shopifyLinksCount <= 0) {
    return {
      label: "Ready - Links Pending",
      tone: "info",
      details: "ERP setup is ready, but Shopify Links recipe mapping is still pending.",
      issues,
    };
  }

  if (issues.length) {
    return {
      label: "Needs Setup",
      tone: "warning",
      details: issues.join(", "),
      issues,
    };
  }

  return {
    label: "Ready",
    tone: "success",
    details: "Connected, priced, option-ready, and mapped in Shopify Links.",
    issues: [],
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const productTypeFilter = norm(url.searchParams.get("productType"));

  const products = await db.configuratorProduct.findMany({
    where: {
      ...(productTypeFilter ? { productType: productTypeFilter } : {}),
    },
    orderBy: [
      { productType: "asc" },
      { title: "asc" },
    ],
  });

  const options = await db.configuratorOption.findMany({
    where: {
      active: true,
      ...(productTypeFilter ? { productType: productTypeFilter } : {}),
    },
    select: {
      productType: true,
      group: true,
      value: true,
    },
  });

  const pricingRules = await db.configuratorPricingRule.findMany({
    where: {
      active: true,
      ...(productTypeFilter ? { productType: productTypeFilter } : {}),
    },
    select: {
      productType: true,
      material: true,
      finish: true,
      minQty: true,
      maxQty: true,
      priceEach: true,
      costEach: true,
      productionFinish: true,
    },
    orderBy: [
      { productType: "asc" },
      { material: "asc" },
      { finish: "asc" },
      { minQty: "asc" },
    ],
  });

  const shopifyLinks = await db.recipeVariantRule.findMany({
    where: {
      active: true,
    },
    select: {
      shopifyProductGid: true,
      shopifyVariantGid: true,
      recipeId: true,
    },
  });

  const productTypes = Array.from(
    new Set([
      ...products.map((p) => p.productType),
      ...options.map((o) => o.productType),
      ...pricingRules.map((r) => r.productType),
    ].filter(Boolean)),
  ).sort();

  const optionCountsByType = new Map<string, number>();
  for (const opt of options) {
    optionCountsByType.set(opt.productType, (optionCountsByType.get(opt.productType) || 0) + 1);
  }

  const pricingCountsByType = new Map<string, number>();
  for (const rule of pricingRules) {
    pricingCountsByType.set(rule.productType, (pricingCountsByType.get(rule.productType) || 0) + 1);
  }

  const linksByProductOrVariant = new Map<string, number>();
  for (const link of shopifyLinks) {
    const productGid = norm(link.shopifyProductGid);
    const variantGid = norm(link.shopifyVariantGid);

    if (productGid) {
      linksByProductOrVariant.set(productGid, (linksByProductOrVariant.get(productGid) || 0) + 1);
    }

    if (variantGid) {
      linksByProductOrVariant.set(variantGid, (linksByProductOrVariant.get(variantGid) || 0) + 1);
    }
  }

  const rows = products.map((product) => {
    const optionCount = optionCountsByType.get(product.productType) || 0;
    const pricingCount = pricingCountsByType.get(product.productType) || 0;
    const productLinkCount = linksByProductOrVariant.get(norm(product.shopifyProductGid)) || 0;
    const variantLinkCount = linksByProductOrVariant.get(norm(product.shopifyVariantGid)) || 0;
    const shopifyLinksCount = Math.max(productLinkCount, variantLinkCount);
    const status = productStatus(product, optionCount, pricingCount, shopifyLinksCount);

    return {
      id: product.id,
      title: product.title,
      productType: product.productType,
      expectedProductType: STOCK_BAG_PRODUCT_TYPE,
      expectedProductTypeLabel: STOCK_BAG_PRODUCT_TYPE_LABEL,
      shopifyHandle: product.shopifyHandle,
      shopifyProductGid: product.shopifyProductGid,
      shopifyVariantGid: product.shopifyVariantGid,
      sku: product.sku,
      active: product.active,
      minQuantity: product.minQuantity,
      expectedMinQuantity: STOCK_BAG_MIN_QTY,
      defaultSides: product.defaultSides,
      expectedDefaultSides: STOCK_BAG_DEFAULT_SIDES,
      optionCount,
      pricingCount,
      shopifyLinksCount,
      status,
    };
  });

  const totals = {
    products: rows.length,
    ready: rows.filter((r) => r.status.label === "Ready").length,
    readyLinksPending: rows.filter((r) => r.status.label === "Ready - Links Pending").length,
    needsSetup: rows.filter((r) => r.status.label === "Needs Setup").length,
    productTypes: productTypes.length,
    options: options.length,
    pricingRules: pricingRules.length,
    shopifyLinks: shopifyLinks.length,
  };

  return new Response(JSON.stringify({
    rows,
    totals,
    productTypes,
    productTypeFilter,
    contract: {
      productType: STOCK_BAG_PRODUCT_TYPE,
      productTypeLabel: STOCK_BAG_PRODUCT_TYPE_LABEL,
      minQuantity: STOCK_BAG_MIN_QTY,
      defaultSides: STOCK_BAG_DEFAULT_SIDES,
    },
  }), { headers: { "Content-Type": "application/json" } });
}

export default function ConfiguratorAudit() {
  const { rows, totals, productTypes, productTypeFilter, contract } = useLoaderData<typeof loader>();

  return (
    <main style={{ padding: 24, maxWidth: 1440, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/app/erp/configurator">? Back to Configurator</Link>
      </div>

      <section
        style={{
          background: "linear-gradient(135deg, #11183a, #3b0b63)",
          color: "white",
          borderRadius: 16,
          padding: 24,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.8 }}>GSO ERP AUDIT</div>
        <h1 style={{ margin: "6px 0 8px", fontSize: 34 }}>Configurator Readiness</h1>
        <p style={{ margin: 0, maxWidth: 860 }}>
          Use this read-only page to confirm which Shopify stock bag records are connected,
          priced, option-ready, mapped in Shopify Links, and safe for the ERP configurator.
        </p>
      </section>

      <section
        style={{
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <h2 style={{ margin: "0 0 8px" }}>Stock Bag ERP Readiness Contract</h2>
        <p style={{ margin: 0, color: "#475569" }}>
          Expected setup: <strong>{contract.productTypeLabel}</strong> /{" "}
          <strong>{contract.productType}</strong>, minimum quantity{" "}
          <strong>{contract.minQuantity}</strong>, default sides{" "}
          <strong>{contract.defaultSides}</strong>, active product, Shopify product GID,
          Shopify variant GID, options, pricing rules, and Shopify Links recipe mapping.
        </p>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <Stat label="Products" value={totals.products} />
        <Stat label="Ready" value={totals.ready} />
        <Stat label="Links Pending" value={totals.readyLinksPending} />
        <Stat label="Needs Setup" value={totals.needsSetup} />
        <Stat label="Product Types" value={totals.productTypes} />
        <Stat label="Options" value={totals.options} />
        <Stat label="Pricing Rules" value={totals.pricingRules} />
      </section>

      <section
        style={{
          background: "white",
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <form method="get" style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 700 }}>Product Type Filter</span>
            <select
              name="productType"
              defaultValue={productTypeFilter || ""}
              style={{ minWidth: 260, padding: "9px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
            >
              <option value="">All product types</option>
              {productTypes.map((type: string) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: 0,
              background: "#111827",
              color: "white",
              fontWeight: 700,
            }}
          >
            Filter
          </button>

          <Link
            to="/app/erp/configurator-audit"
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "#111827",
              fontWeight: 700,
            }}
          >
            Clear
          </Link>
        </form>
      </section>

      <section
        style={{
          background: "white",
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: 16, borderBottom: "1px solid #e5e7eb" }}>
          <h2 style={{ margin: 0 }}>Product Readiness</h2>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: "#f8fafc" }}>
              <tr>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Issues</Th>
                <Th>Shopify Handle</Th>
                <Th>Product GID</Th>
                <Th>Variant GID</Th>
                <Th>Min Qty</Th>
                <Th>Default Sides</Th>
                <Th>Options</Th>
                <Th>Pricing</Th>
                <Th>Links</Th>
                <Th>Active</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row: any) => (
                  <tr key={row.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <Td>
                      <strong>{row.title || "Untitled"}</strong>
                      <div style={{ color: "#64748b", marginTop: 3 }}>{row.sku || "No SKU"}</div>
                    </Td>
                    <Td>
                      <strong>{row.productType || "Missing"}</strong>
                      {row.productType !== row.expectedProductType ? (
                        <div style={{ color: "#b45309", marginTop: 3 }}>
                          Expected: {row.expectedProductType}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <StatusBadge tone={row.status.tone} label={row.status.label} />
                      <div style={{ marginTop: 5, color: "#64748b", maxWidth: 260 }}>
                        {row.status.details}
                      </div>
                    </Td>
                    <Td>
                      {row.status.issues.length ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 220 }}>
                          {row.status.issues.map((issue: string) => (
                            <IssueBadge key={issue} label={issue} />
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: "#16a34a", fontWeight: 800 }}>None</span>
                      )}
                    </Td>
                    <Td>{row.shopifyHandle || "Missing"}</Td>
                    <Td>{row.shopifyProductGid ? "Connected" : "Missing"}</Td>
                    <Td>{row.shopifyVariantGid ? "Connected" : "Missing"}</Td>
                    <Td>
                      {row.minQuantity ?? "Missing"}
                      {Number(row.minQuantity || 0) !== row.expectedMinQuantity ? (
                        <div style={{ color: "#b45309", marginTop: 3 }}>
                          Expected: {row.expectedMinQuantity}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      {row.defaultSides || "Missing"}
                      {row.defaultSides !== row.expectedDefaultSides ? (
                        <div style={{ color: "#b45309", marginTop: 3 }}>
                          Expected: {row.expectedDefaultSides}
                        </div>
                      ) : null}
                    </Td>
                    <Td>{row.optionCount}</Td>
                    <Td>{row.pricingCount}</Td>
                    <Td>{row.shopifyLinksCount}</Td>
                    <Td>{row.active ? "Yes" : "No"}</Td>
                  </tr>
                ))
              ) : (
                <tr>
                  <Td colSpan={13}>No configurator products found.</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section
        style={{
          background: "#fff7ed",
          border: "1px solid #fed7aa",
          borderRadius: 14,
          padding: 16,
          marginTop: 20,
        }}
      >
        <h3 style={{ marginTop: 0 }}>Next setup rule</h3>
        <p style={{ marginBottom: 0 }}>
          A stock bag should only be treated as fully live when this page says{" "}
          <strong>Ready</strong>. <strong>Ready - Links Pending</strong> means the ERP product
          record is ready, but Shopify Links recipe mapping still needs to be connected.
          <strong> Needs Setup</strong> means one or more readiness requirements are missing.
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
      <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function StatusBadge({ tone, label }: { tone: string; label: string }) {
  const styles =
    tone === "success"
      ? { background: "#dcfce7", color: "#166534" }
      : tone === "info"
        ? { background: "#dbeafe", color: "#1d4ed8" }
        : { background: "#fef3c7", color: "#92400e" };

  return (
    <span
      style={{
        display: "inline-flex",
        padding: "4px 9px",
        borderRadius: 999,
        fontWeight: 800,
        fontSize: 12,
        ...styles,
      }}
    >
      {label}
    </span>
  );
}

function IssueBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        padding: "3px 7px",
        borderRadius: 999,
        fontWeight: 800,
        fontSize: 11,
        background: "#fee2e2",
        color: "#991b1b",
      }}
    >
      {label}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ textAlign: "left", padding: "12px 14px", color: "#334155", whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return (
    <td colSpan={colSpan} style={{ padding: "12px 14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
      {children}
    </td>
  );
}


