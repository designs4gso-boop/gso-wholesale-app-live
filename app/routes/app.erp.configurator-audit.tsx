import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "react-router";
import { db } from "../db.server";

function norm(value: unknown) {
  return String(value ?? "").trim();
}

function productStatus(product: any, optionCount: number, pricingCount: number) {
  const missing: string[] = [];

  if (!norm(product.shopifyProductGid) && !norm(product.shopifyHandle)) {
    missing.push("Shopify link");
  }

  if (optionCount <= 0) {
    missing.push("options");
  }

  if (pricingCount <= 0) {
    missing.push("pricing rules");
  }

  if (!product.active) {
    missing.push("inactive");
  }

  if (missing.length) {
    return {
      label: "Needs Setup",
      tone: "warning",
      details: `Missing: ${missing.join(", ")}`,
    };
  }

  return {
    label: "Ready",
    tone: "success",
    details: "Connected, priced, and option-ready.",
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

  const rows = products.map((product) => {
    const optionCount = optionCountsByType.get(product.productType) || 0;
    const pricingCount = pricingCountsByType.get(product.productType) || 0;
    const status = productStatus(product, optionCount, pricingCount);

    return {
      id: product.id,
      title: product.title,
      productType: product.productType,
      shopifyHandle: product.shopifyHandle,
      shopifyProductGid: product.shopifyProductGid,
      shopifyVariantGid: product.shopifyVariantGid,
      sku: product.sku,
      active: product.active,
      minQuantity: product.minQuantity,
      optionCount,
      pricingCount,
      status,
    };
  });

  const totals = {
    products: rows.length,
    ready: rows.filter((r) => r.status.label === "Ready").length,
    needsSetup: rows.filter((r) => r.status.label !== "Ready").length,
    productTypes: productTypes.length,
    options: options.length,
    pricingRules: pricingRules.length,
  };

  return new Response(JSON.stringify({
    rows,
    totals,
    productTypes,
    productTypeFilter,
  }), { headers: { "Content-Type": "application/json" } });}

export default function ConfiguratorAudit() {
  const { rows, totals, productTypes, productTypeFilter } = useLoaderData<typeof loader>();

  return (
    <main style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
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
        <p style={{ margin: 0, maxWidth: 760 }}>
          Use this page to confirm which Shopify products are connected, priced, option-ready,
          and safe to activate on the storefront configurator.
        </p>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <Stat label="Products" value={totals.products} />
        <Stat label="Ready" value={totals.ready} />
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
                <Th>Shopify Handle</Th>
                <Th>Shopify GID</Th>
                <Th>Min Qty</Th>
                <Th>Options</Th>
                <Th>Pricing Rules</Th>
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
                    <Td>{row.productType}</Td>
                    <Td>
                      <StatusBadge tone={row.status.tone} label={row.status.label} />
                      <div style={{ marginTop: 5, color: "#64748b" }}>{row.status.details}</div>
                    </Td>
                    <Td>{row.shopifyHandle || "Missing"}</Td>
                    <Td>{row.shopifyProductGid ? "Connected" : "Missing"}</Td>
                    <Td>{row.minQuantity || 64}</Td>
                    <Td>{row.optionCount}</Td>
                    <Td>{row.pricingCount}</Td>
                    <Td>{row.active ? "Yes" : "No"}</Td>
                  </tr>
                ))
              ) : (
                <tr>
                  <Td colSpan={9}>No configurator products found.</Td>
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
          A product should only go live on the storefront configurator when this page says
          <strong> Ready</strong>. If it says <strong>Needs Setup</strong>, fix the missing
          Shopify link, options, or pricing rules first.
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
  const isReady = tone === "success";
  return (
    <span
      style={{
        display: "inline-flex",
        padding: "4px 9px",
        borderRadius: 999,
        fontWeight: 800,
        fontSize: 12,
        background: isReady ? "#dcfce7" : "#fef3c7",
        color: isReady ? "#166534" : "#92400e",
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


