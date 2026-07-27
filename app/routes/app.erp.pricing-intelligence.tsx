import type React from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { aggregateEvidence, gatherPricingEvidence } from "../lib/pricing-intelligence.server";
import {
  SHOPIFY_ACCESS_BLOCKED_MESSAGE,
  fetchShopifyOrderEvidence,
  isAccessDeniedError,
  loadShopifyEvidenceCache,
  normalizeShopifyOrderEvidence,
  saveShopifyEvidenceCache,
} from "../lib/shopify-pricing-evidence.server";

// Pricing Intelligence (15F.0K.4D + 4E) — READ-ONLY evidence counting, not
// market conclusions. 4E adds the Shopify historical-order evidence source:
// a staff-triggered, read-only refresh normalizes paid storefront orders
// into the same privacy-safe baskets and caches the summary (ErpAdminSetting
// JSON — no raw orders, no PII). Accepted-price low/median/high stay
// THRESHOLD-GATED (>=5 accepted, >=3 distinct customers, >=2 distinct
// months). No market targets are created, no quotes/products are repriced,
// and NOTHING ever writes to Shopify.

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [local, shopify] = await Promise.all([
    gatherPricingEvidence(db, shop),
    loadShopifyEvidenceCache(db, shop),
  ]);
  const combined = [...local.records, ...shopify.records];
  const baskets = aggregateEvidence(combined);
  const cacheAgeDays = shopify.cache?.capturedAt
    ? Math.floor((Date.now() - new Date(shopify.cache.capturedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    totals: local.totals,
    excluded: local.excluded.slice(0, 50),
    baskets: baskets.slice(0, 100),
    shopify: {
      connected: Boolean(shopify.cache),
      ok: shopify.cache?.ok ?? false,
      accessBlocked: shopify.cache?.accessBlocked ?? false,
      // component must not import the .server module — message travels via data
      blockedMessage: SHOPIFY_ACCESS_BLOCKED_MESSAGE,
      error: shopify.cache?.error ?? null,
      capturedAt: shopify.cache?.capturedAt ?? null,
      cacheAgeDays,
      orderCount: shopify.cache?.orderCount ?? 0,
      pagesFetched: shopify.cache?.pagesFetched ?? 0,
      truncated: shopify.cache?.truncated ?? false,
      eligible: shopify.records.length,
      excluded: (shopify.cache?.excluded ?? []).slice(0, 50),
      incomplete: (shopify.cache?.incomplete ?? []).slice(0, 50),
      earliest: shopify.cache?.earliest ?? null,
      latest: shopify.cache?.latest ?? null,
    },
  };
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  if (String(form.get("intent")) !== "refreshShopifyEvidence") {
    return Response.json({ ok: false, message: "Unknown action." });
  }
  // READ-ONLY refresh: fetch -> normalize -> cache. Errors are cached as a
  // clear state (blocked/failed) so the rest of the page keeps working.
  try {
    const { orders, pagesFetched, truncated } = await fetchShopifyOrderEvidence(admin);
    const normalized = normalizeShopifyOrderEvidence(orders);
    await saveShopifyEvidenceCache(db, shop, {
      capturedAt: new Date().toISOString(),
      ok: true,
      error: null,
      accessBlocked: false,
      orderCount: normalized.orderCount,
      pagesFetched,
      truncated,
      earliest: normalized.earliest,
      latest: normalized.latest,
      records: normalized.records.map((record) => ({ ...record, evidenceAt: record.evidenceAt.toISOString() })),
      excluded: normalized.excluded,
      incomplete: normalized.incomplete,
    });
    return Response.json({ ok: true, message: `Shopify evidence refreshed: ${normalized.records.length} accepted line(s) from ${normalized.orderCount} order(s).` });
  } catch (error: any) {
    const message = String(error?.message || error || "Shopify refresh failed.");
    const accessBlocked = isAccessDeniedError(message);
    await saveShopifyEvidenceCache(db, shop, {
      capturedAt: new Date().toISOString(),
      ok: false,
      error: message.slice(0, 300),
      accessBlocked,
      orderCount: 0,
      pagesFetched: 0,
      truncated: false,
      earliest: null,
      latest: null,
      records: [],
      excluded: [],
      incomplete: [],
    });
    return Response.json({ ok: false, message: accessBlocked ? SHOPIFY_ACCESS_BLOCKED_MESSAGE : `Shopify refresh failed: ${message.slice(0, 200)}` });
  }
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const stat: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", minWidth: 150, background: "#f9fafb" };

export default function PricingIntelligence() {
  const { totals, excluded, baskets, shopify } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main style={{ maxWidth: 1240, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#3b0764)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Pricing Intelligence — evidence readiness</h1>
        <p style={{ margin: "8px 0 0", fontSize: 14 }}>
          Counts what real, accepted sales evidence exists per product basket — it deliberately does NOT show
          market conclusions from tiny samples. Accepted-price statistics unlock per basket only after
          <b> 5+ accepted items, 3+ distinct customers, and 2+ distinct months</b>. Everything here is
          <b> advisory-only</b>: no market targets are created, no prices change, and nothing ever writes to Shopify.
        </p>
      </section>

      {actionData?.message ? (
        <section style={{ ...card, borderColor: actionData.ok ? "#bbf7d0" : "#fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2" }}>
          <b style={{ color: actionData.ok ? "#166534" : "#991b1b" }}>{actionData.message}</b>
        </section>
      ) : null}

      <section style={{ ...card, borderColor: shopify.accessBlocked ? "#fecaca" : "#bfdbfe", background: shopify.accessBlocked ? "#fef2f2" : "#eff6ff" }}>
        <b>Shopify historical-order evidence (15F.0K.4E — read-only)</b>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          {shopify.accessBlocked ? (
            <span style={{ color: "#991b1b", fontWeight: 700 }}>{shopify.blockedMessage}</span>
          ) : !shopify.connected ? (
            <>Not refreshed yet — click Refresh to pull paid storefront orders (read-only). Until the owner deploys +
            reauthorizes the new <code>read_all_orders</code> scope, Shopify returns only its recent (~60-day) order window.</>
          ) : shopify.ok ? (
            <>
              Last refreshed {shopify.capturedAt ? new Date(shopify.capturedAt).toLocaleString() : "—"}
              {shopify.cacheAgeDays != null && shopify.cacheAgeDays >= 7 ? <b style={{ color: "#92400e" }}> (STALE — {shopify.cacheAgeDays} days old; refresh recommended)</b> : null}
              {" — "}{shopify.orderCount} order(s) reviewed across {shopify.pagesFetched} page(s){shopify.truncated ? " (TRUNCATED at the defensive cap — refine later)" : ""}.
              Evidence window: {shopify.earliest || "—"} → {shopify.latest || "—"}. Orders older than ~60 days appear only
              after <code>read_all_orders</code> reauthorization.
            </>
          ) : (
            <span style={{ color: "#991b1b" }}>Last refresh failed: {shopify.error}</span>
          )}
        </div>
        <Form method="post" style={{ marginTop: 10 }}>
          <input type="hidden" name="intent" value="refreshShopifyEvidence" />
          <button type="submit" disabled={busy} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #d1d5db", background: "#111827", color: "white", fontWeight: 600 }}>
            {busy ? "Refreshing…" : "Refresh Shopify evidence (read-only)"}
          </button>
        </Form>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 10px" }}>Summary</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={stat}><b>{totals.reviewed}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local line items reviewed</div></div>
          <div style={stat}><b>{totals.eligible}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local ERP eligible evidence</div></div>
          <div style={stat}><b>{shopify.eligible}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify eligible evidence</div></div>
          <div style={stat}><b>{shopify.excluded.length}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify excluded</div></div>
          <div style={stat}><b>{shopify.incomplete.length}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify incomplete price</div></div>
          <div style={stat}><b>{totals.excluded}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local excluded test records</div></div>
          <div style={stat}><b>{totals.won}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local accepted / won</div></div>
          <div style={stat}><b>{totals.lost}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local lost / canceled / expired</div></div>
          <div style={stat}><b>{totals.open}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local pending / open</div></div>
          <div style={stat}><b>{totals.distinctCustomers}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Distinct customers (count only)</div></div>
        </div>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Evidence readiness by basket</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Baskets never mix: finished vs label-only, one- vs double-sided, standard vs specialty finishes, and 4X is
          never treated as 3X. Unknown attributes form their own segments. Sources stay distinguishable (ERP vs
          Shopify) while combining toward the thresholds. Accepted low/median/high appear ONLY when all three
          thresholds pass — and even then they are advisory display, never a market target.
        </p>
        {baskets.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No eligible evidence yet — mark quotes Won/Lost on the Quotes board and refresh Shopify evidence above.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: 6, textAlign: "left" }}>Basket</th>
                  <th>ERP</th><th>Shopify</th><th>Combined accepted</th>
                  <th>Exact</th><th>Near</th><th>Lost</th><th>Open</th>
                  <th>Customers</th><th>Months</th><th>First</th><th>Latest</th>
                  <th style={{ textAlign: "left" }}>Confidence</th>
                  <th>Low / Median / High</th>
                </tr>
              </thead>
              <tbody>
                {baskets.map((basket) => (
                  <tr key={basket.key} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, maxWidth: 360 }}>{basket.key}</td>
                    <td align="center">{basket.sourceCounts.erp_quote + basket.sourceCounts.production_job}</td>
                    <td align="center">{basket.sourceCounts.shopify_order}</td>
                    <td align="center"><b>{basket.accepted}</b></td>
                    <td align="center">{basket.exactMatches}</td>
                    <td align="center">{basket.nearMatches}</td>
                    <td align="center">{basket.lost}</td>
                    <td align="center">{basket.open}</td>
                    <td align="center">{basket.distinctCustomers}</td>
                    <td align="center">{basket.distinctMonths}</td>
                    <td align="center">{basket.earliest || "—"}</td>
                    <td align="center">{basket.latest || "—"}</td>
                    <td style={{ color: basket.confidence.eligible ? "#166534" : "#92400e" }}>{basket.confidence.message}</td>
                    <td align="center">
                      {basket.confidence.eligible && basket.acceptedMedian != null
                        ? `$${basket.acceptedLow?.toFixed(2)} / $${basket.acceptedMedian?.toFixed(2)} / $${basket.acceptedHigh?.toFixed(2)}`
                        : "withheld (thresholds not met)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Excluded / incomplete records</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 8px" }}>
          Conservative shared exclusion (one helper everywhere) plus Shopify-specific rules: test orders, canceled,
          not-paid financial statuses, fully refunded orders, refunded lines, gift cards, free/zero-net lines, and
          unclassifiable lines. Incomplete-price rows (discount allocation unavailable) NEVER enter medians.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14, fontSize: 12 }}>
          <div>
            <b>Local ERP ({excluded.length} shown)</b>
            {excluded.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {excluded.map((row, index) => <li key={index}><b>{row.label || "(unnamed)"}</b> ({row.source}) — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
          <div>
            <b>Shopify excluded ({shopify.excluded.length} shown)</b>
            {shopify.excluded.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {shopify.excluded.map((row: any, index: number) => <li key={index}><b>{row.label}</b> — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
          <div>
            <b>Shopify incomplete price ({shopify.incomplete.length} shown)</b>
            {shopify.incomplete.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {shopify.incomplete.map((row: any, index: number) => <li key={index}><b>{row.label}</b> — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
