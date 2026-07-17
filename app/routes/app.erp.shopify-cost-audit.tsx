import type React from "react";
import { useMemo, useState } from "react";
import { Form, Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  AUDIT_STATUS_LABELS,
  AUDIT_STATUS_RANK,
  AUDIT_VIEW_LABELS,
  DEFAULT_TOLERANCE_PCT,
  EXPORT_ROW_CAP,
  MAX_UI_ROWS,
  buildCsv,
  classifyAuditRow,
  deltaAgainstBand,
  matchVariantToErp,
  pickErpCost,
  rowMatchesViewMode,
  summarizeAuditRows,
  auditStatus,
  type AuditStatus,
  type AuditViewMode,
  type ErpCost,
  type ErpMatch,
  type RowClassification,
} from "../lib/shopify-cost-audit-shared";
import { buildErpIndex, computeRecipeCosts, pullShopifyCatalog } from "../lib/shopify-cost-audit.server";

// Read-only Shopify cost audit (12B.2b). No action export, no database writes,
// no Shopify writes: the loader reads ERP tables and runs one paginated
// Shopify product query when (and only when) staff presses Pull.

type AuditRow = {
  productTitle: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string;
  productStatus: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  price: number | null;
  compareAtPrice: number | null;
  inventoryItemId: string;
  tracked: boolean | null;
  unitCost: number | null;
  currency: string | null;
  matchLevel: string;
  matchSummary: string;
  ambiguous: boolean;
  erpCostLabel: string;
  erpCostLow: number | null;
  erpCostHigh: number | null;
  erpCostSource: string;
  delta: number;
  deltaPct: number;
  status: AuditStatus;
  view: RowClassification["view"];
  costFactorCandidate: boolean;
  hiddenReason: string | null;
};

function matchSummaryText(matches: ErpMatch[]) {
  const parts = matches.slice(0, 3).map((match) => `${match.table.replace("_", " ")}: ${match.name}`);
  if (matches.length > 3) parts.push(`+${matches.length - 3} more`);
  return parts.join("; ");
}

function clampTolerance(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TOLERANCE_PCT;
  return Math.min(Math.max(value, 0), 50);
}

const CSV_HEADER = [
  "productTitle", "handle", "vendor", "productType", "tags", "productStatus",
  "variantTitle", "sku", "barcode", "price", "compareAtPrice",
  "inventoryItemId", "tracked", "shopifyUnitCost", "currency",
  "matchLevel", "matchSummary", "erpCostLow", "erpCostHigh", "erpCostSource", "erpCostLabel",
  "deltaPct", "status",
  "auditView", "costFactorCandidate", "hiddenReason",
];

function rowToCsvCells(row: AuditRow) {
  return [
    row.productTitle, row.handle, row.vendor, row.productType, row.tags, row.productStatus,
    row.variantTitle, row.sku, row.barcode,
    row.price == null ? "" : row.price, row.compareAtPrice == null ? "" : row.compareAtPrice,
    row.inventoryItemId, row.tracked == null ? "" : String(row.tracked),
    row.unitCost == null ? "" : row.unitCost, row.currency || "",
    row.matchLevel, row.matchSummary,
    row.erpCostLow == null ? "" : row.erpCostLow, row.erpCostHigh == null ? "" : row.erpCostHigh,
    row.erpCostSource, row.erpCostLabel,
    row.deltaPct ? row.deltaPct.toFixed(2) : "0",
    AUDIT_STATUS_LABELS[row.status],
    row.view, String(row.costFactorCandidate), row.hiddenReason || "",
  ];
}

export async function loader({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const pull = url.searchParams.get("pull") === "1";
  const tolerancePct = clampTolerance(Number(url.searchParams.get("tolerancePct") ?? DEFAULT_TOLERANCE_PCT));

  if (!pull) {
    const [vendorProductCount, materialCount, mappedRecipeCount, configuratorCount] = await Promise.all([
      db.vendorProduct.count({ where: { shop, active: true } }),
      db.material.count({ where: { shop, active: true } }),
      db.productRecipe.count({
        where: {
          shop,
          active: true,
          OR: [{ productGid: { not: null } }, { variantGid: { not: null } }, { shopifyProductId: { not: null } }, { shopifyVariantId: { not: null } }],
        },
      }),
      db.configuratorProduct.count({ where: { shop } }),
    ]);
    return {
      pulled: false as const,
      tolerancePct,
      context: { vendorProductCount, materialCount, mappedRecipeCount, configuratorCount },
    };
  }

  // 12B.2b.2: nothing inside the pull branch may escape as a redirect. The
  // graphql helper already converts thrown auth Responses, but this outer
  // catch is the last line of defense — any Response or Error becomes an
  // in-page banner and the route stays loaded.
  try {
  const [index, pullResult] = await Promise.all([buildErpIndex(db, shop), pullShopifyCatalog(admin)]);

  // Match every variant, then compute engine costs only for matched quote-ready recipes.
  const matched = pullResult.variants.map((variant) => ({
    variant,
    match: matchVariantToErp(index, {
      variantId: variant.variantId,
      productId: variant.productId,
      handle: variant.handle,
      sku: variant.sku,
    }),
  }));
  const matchedRecipeIds = [...new Set(
    matched.flatMap((entry) => entry.match.matches.filter((m) => m.table === "recipe").map((m) => m.id)),
  )];
  const recipeCosts = await computeRecipeCosts(db, shop, matchedRecipeIds, index);

  const rows: AuditRow[] = matched.map(({ variant, match }) => {
    const ambiguous = match.matches.length > 1;
    const erpCost: ErpCost | null = pickErpCost(match.matches, index, recipeCosts);
    const status = auditStatus({
      inventoryAccess: pullResult.inventoryAccess,
      shopifyCost: variant.unitCost,
      ambiguous,
      matched: match.matches.length > 0,
      erpCost,
      tolerancePct,
    });
    const band = erpCost && variant.unitCost != null
      ? deltaAgainstBand(variant.unitCost, erpCost.low, erpCost.high)
      : { delta: 0, deltaPct: 0 };
    const classification = classifyAuditRow({
      sku: variant.sku,
      shopifyCost: variant.unitCost,
      matchLevel: match.level,
      matches: match.matches,
      productType: variant.productType,
      vendor: variant.vendor,
      tags: variant.tags,
      title: variant.productTitle,
      handle: variant.handle,
    });
    return {
      view: classification.view,
      costFactorCandidate: classification.costFactorCandidate,
      hiddenReason: classification.hiddenReason,
      productTitle: variant.productTitle,
      handle: variant.handle,
      vendor: variant.vendor,
      productType: variant.productType,
      tags: variant.tags,
      productStatus: variant.productStatus,
      variantTitle: variant.variantTitle,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      inventoryItemId: variant.inventoryItemId,
      tracked: variant.tracked,
      unitCost: variant.unitCost,
      currency: variant.currency,
      matchLevel: match.level,
      matchSummary: matchSummaryText(match.matches),
      ambiguous,
      erpCostLabel: erpCost?.label || "",
      erpCostLow: erpCost ? erpCost.low : null,
      erpCostHigh: erpCost ? erpCost.high : null,
      erpCostSource: erpCost?.source || "",
      delta: band.delta,
      deltaPct: band.deltaPct,
      status,
    };
  });

  rows.sort((a, b) =>
    AUDIT_STATUS_RANK[a.status] - AUDIT_STATUS_RANK[b.status]
    || Math.abs(b.deltaPct) - Math.abs(a.deltaPct)
    || a.productTitle.localeCompare(b.productTitle),
  );

  const summary = summarizeAuditRows(rows);

  return {
    pulled: true as const,
    tolerancePct,
    pull: {
      ok: pullResult.ok,
      error: pullResult.error,
      inventoryAccess: pullResult.inventoryAccess,
      inventoryAccessError: pullResult.inventoryAccessError,
      throttled: pullResult.throttled,
      truncated: pullResult.truncated,
      pageCount: pullResult.pageCount,
      productCount: pullResult.productCount,
      variantCount: pullResult.variants.length,
      variantsTruncatedProducts: [...new Set(pullResult.variants.filter((v) => v.variantsTruncated).map((v) => v.productTitle))].slice(0, 10),
    },
    summary,
    rowTotal: rows.length,
    rows: rows.slice(0, EXPORT_ROW_CAP),
  };
  } catch (error) {
    const detail = error instanceof Response
      ? `Shopify auth/redirect response (HTTP ${error.status}) was intercepted.`
      : error instanceof Error
        ? error.message
        : "Unknown error.";
    return {
      pulled: true as const,
      tolerancePct,
      pull: {
        ok: false,
        error: `Shopify pull could not complete. The app stayed loaded instead of redirecting. Details: ${detail}`,
        inventoryAccess: true,
        inventoryAccessError: null,
        throttled: false,
        truncated: false,
        pageCount: 0,
        productCount: 0,
        variantCount: 0,
        variantsTruncatedProducts: [] as string[],
      },
      summary: summarizeAuditRows([]),
      rowTotal: 0,
      rows: [] as AuditRow[],
    };
  }
}

const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };
const badgeStyle: Record<string, React.CSSProperties> = {
  bad: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  warn: { background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  ok: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  info: { background: "#e0e7ff", color: "#3730a3", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
};

function statusTone(status: AuditStatus) {
  if (status === "within_tolerance") return "ok";
  if (status === "above_erp" || status === "below_erp" || status === "ambiguous") return "bad";
  if (status === "cost_unavailable" || status === "no_erp_match") return "info";
  return "warn";
}

function money(value: number | null) {
  if (value == null) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

const VIEW_MODE_ORDER: AuditViewMode[] = ["cost_factors", "erp_matched", "missing_cost", "ambiguous", "stock_configurator", "all"];

export default function ShopifyCostAuditRoute() {
  const data = useLoaderData<typeof loader>();
  const [viewMode, setViewMode] = useState<AuditViewMode>("cost_factors");
  const [copied, setCopied] = useState(false);

  const rows = data.pulled ? data.rows : [];
  const filteredRows = useMemo(
    () => rows.filter((row) => rowMatchesViewMode(row, viewMode)),
    [rows, viewMode],
  );
  const displayRows = filteredRows.slice(0, MAX_UI_ROWS);
  const viewCounts: Record<AuditViewMode, number> = data.pulled
    ? {
        cost_factors: data.summary.costFactorCandidates,
        erp_matched: data.summary.erpMatched,
        missing_cost: data.summary.missingShopifyCost,
        ambiguous: data.summary.ambiguous,
        stock_configurator: data.summary.stockConfiguratorHidden,
        all: data.summary.totalVariants,
      }
    : { cost_factors: 0, erp_matched: 0, missing_cost: 0, ambiguous: 0, stock_configurator: 0, all: 0 };

  // Exports respect the current view mode (12B.2b.3); the auditView /
  // costFactorCandidate / hiddenReason columns make the classification
  // visible in the sheet either way.
  const copyTsv = () => {
    const clean = (value: unknown) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
    const lines = [CSV_HEADER.join("\t"), ...filteredRows.map((row) => rowToCsvCells(row).map(clean).join("\t"))];
    navigator.clipboard?.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  // Client-side download from already-loaded rows: no navigation, no extra
  // Shopify pull, and no way to lose the embedded session (12B.2b.2).
  const downloadCsv = () => {
    const csv = buildCsv(CSV_HEADER, filteredRows.map(rowToCsvCells));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `shopify-cost-audit-${viewMode}.csv`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <main style={{ maxWidth: 1320, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p>
        <Link to="/app/erp/cost-health">← Cost Health</Link> · <Link to="/app/erp/cost-verification">Cost Verification Workbook</Link> · <Link to="/app/erp/cost-calculator">Cost Calculator</Link> · <Link to="/app/erp/shopify-links">Shopify Links</Link> · <Link to="/app/erp/vendor-cost-book">Vendor Cost Book</Link>
      </p>
      <section style={{ background: "linear-gradient(135deg,#111827,#1e3a8a)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>Shopify Cost Audit</h1>
        <p style={{ marginBottom: 0 }}>
          v1 (12B.2b): read-only pull of every Shopify product/variant (price, SKU, and cost/COGS where accessible), matched against ERP records
          and compared to the most authoritative ERP cost. Nothing is written to Shopify or the ERP database.
        </p>
      </section>

      <section style={{ marginTop: 16, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e3a8a", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
        <b>Read this first:</b> This page has two jobs: <b>Cost Factors mode</b> (the default) helps verify real cost inputs — vendor items, blank
        jars/bags, media, and anything carrying a Shopify cost. <b>All Variants mode</b> is for storefront/configurator audits and shows every sales
        variant, including the thousands of stock-bag option combinations. In both: Shopify's variant cost is merchant-entered and can be just as
        wrong as any other number — a mismatch tells you <b>where to pull the invoice first</b>, it does not tell you which side is right. Invoice
        verification (the Cost Verification Workbook work from 12B.2a) decides the truth; this page finds the disagreements fast.
      </section>

      {data.pulled && !data.pull.inventoryAccess ? (
        <section style={{ marginTop: 16, border: "2px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
          <b>Shopify cost/COGS access is unavailable.</b> Inventory item cost may require product cost permission / granular Shopify permissions.
          Products, variants, prices, SKUs, and ERP matching still work; the cost column is disabled for this pull.
          {data.pull.inventoryAccessError ? <div style={smallHelp}>Shopify said: {data.pull.inventoryAccessError}</div> : null}
        </section>
      ) : null}

      {!data.pulled ? (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Pull Shopify catalog</h2>
          <p style={{ fontSize: 13, color: "#4b5563" }}>
            Nothing has been pulled yet — this page never calls Shopify until you press the button. The pull reads up to 1,000 products
            (50 per page) with up to 100 variants each, then matches them against {data.context.mappedRecipeCount} Shopify-mapped recipe(s),
            {" "}{data.context.vendorProductCount} vendor product(s), {data.context.materialCount} material(s), and {data.context.configuratorCount} configurator product(s).
          </p>
          <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <input type="hidden" name="pull" value="1" />
            <label style={{ fontSize: 13 }}>Tolerance %<br />
              <input name="tolerancePct" type="number" step="0.5" min="0" max="50" defaultValue={data.tolerancePct} style={{ padding: 8, border: "1px solid #d1d5db", borderRadius: 8, width: 110 }} />
            </label>
            <button type="submit" style={{ background: "#111827", color: "white", border: 0, borderRadius: 10, padding: "12px 18px", fontWeight: 800 }}>
              Pull from Shopify
            </button>
          </Form>
        </section>
      ) : (
        <>
          {data.pull.error ? (
            <section style={{ marginTop: 16, border: "2px solid #ef4444", background: "#fef2f2", color: "#991b1b", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
              <b>Pull stopped early:</b> {data.pull.error}. Results below are partial ({data.pull.productCount} product(s) read).
            </section>
          ) : null}
          {data.pull.throttled ? (
            <section style={{ marginTop: 16, border: "1px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
              Shopify rate-limited the pull; results are partial ({data.pull.productCount} product(s)). Wait a minute and pull again.
            </section>
          ) : null}
          {data.pull.truncated ? (
            <section style={{ marginTop: 16, border: "1px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
              Catalog is larger than the 1,000-product safety cap; results are partial. Tell the developer if this shop really has more products than that.
            </section>
          ) : null}
          {data.pull.variantsTruncatedProducts.length ? (
            <section style={{ marginTop: 16, border: "1px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
              Some products have more than 100 variants; extra variants were not audited: {data.pull.variantsTruncatedProducts.join(", ")}
            </section>
          ) : null}

          <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10, marginTop: 16 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Total variants pulled</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.totalVariants}</div>
              <div style={smallHelp}>{data.pull.productCount} products · {data.pull.pageCount} page(s) · tolerance ±{data.tolerancePct}%</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Cost-factor candidates</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.costFactorCandidates}</div>
              <span style={badgeStyle.ok}>the list worth auditing</span>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Shopify cost present</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.shopifyCostPresent}</div>
              <span style={badgeStyle.info}>merchant-entered COGS</span>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Missing Shopify cost</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.missingShopifyCost}</div>
              <span style={badgeStyle.warn}>no COGS entered / unavailable</span>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>ERP matched</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.erpMatched}</div>
              <span style={badgeStyle.info}>linked to an ERP record</span>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Ambiguous</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.ambiguous}</div>
              <span style={badgeStyle.bad}>needs manual review</span>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Hidden as stock/configurator noise</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{data.summary.stockConfiguratorHidden}</div>
              <span style={badgeStyle.info}>sales-variant combinations</span>
            </div>
          </section>

          <section style={{ ...cardStyle, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <b style={{ fontSize: 13 }}>View:</b>
              {VIEW_MODE_ORDER.map((mode) => (
                <button key={mode} type="button" onClick={() => setViewMode(mode)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: viewMode === mode ? "#111827" : "white", color: viewMode === mode ? "white" : "#111827", fontSize: 12 }}>
                  {AUDIT_VIEW_LABELS[mode]} ({viewCounts[mode]})
                </button>
              ))}
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button type="button" onClick={downloadCsv} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 12 }}>
                  Download CSV (this view)
                </button>
                <button type="button" onClick={copyTsv} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 12 }}>
                  {copied ? "Copied!" : "Copy TSV (this view)"}
                </button>
              </span>
            </div>
            {viewMode === "cost_factors" ? (
              <div style={{ ...smallHelp, marginTop: 8 }}>
                Cost Factors mode hides {Math.max(data.summary.totalVariants - data.summary.costFactorCandidates, 0)} row(s): stock/configurator sales
                variants, no-SKU rows without a Shopify cost, and rows matched only by broad product mapping. Switch views to see them.
              </div>
            ) : null}
            {displayRows.length < filteredRows.length ? (
              <div style={{ ...smallHelp, marginTop: 8 }}>Showing the worst {displayRows.length} of {filteredRows.length} rows for this view on screen; CSV/TSV export includes all {filteredRows.length} rows of this view.</div>
            ) : null}

            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f3f4f6" }}>
                    <th align="left" style={{ padding: 8 }}>Status</th>
                    <th align="left" style={{ padding: 8 }}>Product / variant</th>
                    <th align="left" style={{ padding: 8 }}>SKU</th>
                    <th align="right" style={{ padding: 8 }}>Price</th>
                    <th align="right" style={{ padding: 8 }}>Shopify cost</th>
                    <th align="left" style={{ padding: 8 }}>ERP cost</th>
                    <th align="right" style={{ padding: 8 }}>Delta</th>
                    <th align="left" style={{ padding: 8 }}>ERP match</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, idx) => (
                    <tr key={`${row.inventoryItemId || row.sku || row.productTitle}-${idx}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td style={{ padding: 8 }}><span style={badgeStyle[statusTone(row.status)]}>{AUDIT_STATUS_LABELS[row.status]}</span></td>
                      <td style={{ padding: 8 }}>
                        <b>{row.productTitle}</b>{row.variantTitle && row.variantTitle !== "Default Title" ? ` — ${row.variantTitle}` : ""}
                        <div style={smallHelp}>{row.handle} · {row.productType || "no type"} · {row.productStatus.toLowerCase()}</div>
                      </td>
                      <td style={{ padding: 8, fontFamily: "ui-monospace, monospace" }}>{row.sku || "—"}</td>
                      <td style={{ padding: 8 }} align="right">{money(row.price)}</td>
                      <td style={{ padding: 8 }} align="right"><b>{row.unitCost == null ? "—" : money(row.unitCost)}</b></td>
                      <td style={{ padding: 8 }}>{row.erpCostLabel || "—"}{row.erpCostSource ? <div style={smallHelp}>{row.erpCostSource.replace(/_/g, " ")}</div> : null}</td>
                      <td style={{ padding: 8 }} align="right">{row.deltaPct ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</td>
                      <td style={{ padding: 8 }}>
                        {row.matchSummary || "No ERP record matched"}
                        {row.matchLevel !== "none" ? <div style={smallHelp}>matched by {row.matchLevel.replace(/_/g, " ")}</div> : null}
                        {row.hiddenReason ? <div style={{ ...smallHelp, color: "#92400e" }}>Hidden from Cost Factors: {row.hiddenReason}</div> : null}
                      </td>
                    </tr>
                  ))}
                  {!filteredRows.length ? (
                    <tr><td colSpan={8} style={{ padding: 14, color: "#6b7280" }}>No rows for this filter.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ ...cardStyle, marginTop: 16 }}>
            <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <input type="hidden" name="pull" value="1" />
              <label style={{ fontSize: 13 }}>Tolerance %<br />
                <input name="tolerancePct" type="number" step="0.5" min="0" max="50" defaultValue={data.tolerancePct} style={{ padding: 8, border: "1px solid #d1d5db", borderRadius: 8, width: 110 }} />
              </label>
              <button type="submit" style={{ background: "#111827", color: "white", border: 0, borderRadius: 10, padding: "12px 18px", fontWeight: 800 }}>
                Pull again
              </button>
              <span style={smallHelp}>Pulls are never cached — every pull reads Shopify live and stores nothing.</span>
            </Form>
          </section>
        </>
      )}
    </main>
  );
}
