import type React from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { aggregateEvidence, gatherPricingEvidence } from "../lib/pricing-intelligence.server";

// Pricing Intelligence (15F.0K.4D) — READ-ONLY evidence counting, not market
// conclusions. The 2026-07-26 audit found only ~5-7 genuine accepted line
// items in all history, so accepted-price low/median/high are THRESHOLD-
// GATED (>=5 accepted, >=3 distinct customers, >=2 distinct months) and
// everything on this page is advisory-only: no market targets are created,
// no quotes are repriced. Customer identities never reach the client — only
// hashed distinct counts. No action export; zero writes.

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const evidence = await gatherPricingEvidence(db, shop);
  const baskets = aggregateEvidence(evidence.records);
  return {
    totals: evidence.totals,
    excluded: evidence.excluded.slice(0, 50),
    baskets: baskets.slice(0, 100),
  };
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const stat: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", minWidth: 150, background: "#f9fafb" };

export default function PricingIntelligence() {
  const { totals, excluded, baskets } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 1200, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#3b0764)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Pricing Intelligence — evidence readiness</h1>
        <p style={{ margin: "8px 0 0", fontSize: 14 }}>
          Counts what real, accepted sales evidence exists per product basket — it deliberately does NOT show
          market conclusions from tiny samples. Accepted-price statistics unlock per basket only after
          <b> 5+ accepted items, 3+ distinct customers, and 2+ distinct months</b>. Everything here is
          <b> advisory-only</b>: no market targets are created and no quote is ever repriced by this page.
        </p>
      </section>

      <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
        <b>Shopify historical-order evidence is not yet connected. Current counts are based only on locally stored ERP records.</b>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
          Quote outcomes (Won / Lost / Canceled / Expired on the Quotes board) are the capture mechanism — every
          future quote decision becomes evidence here. Customer identities are hashed; this page shows counts only.
        </div>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 10px" }}>Summary</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={stat}><b>{totals.reviewed}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Line items reviewed</div></div>
          <div style={stat}><b>{totals.eligible}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Eligible real evidence</div></div>
          <div style={stat}><b>{totals.excluded}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Excluded test records</div></div>
          <div style={stat}><b>{totals.won}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Accepted / won items</div></div>
          <div style={stat}><b>{totals.lost}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Lost / canceled / expired</div></div>
          <div style={stat}><b>{totals.open}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Pending / open</div></div>
          <div style={stat}><b>{totals.distinctCustomers}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Distinct customers (count only)</div></div>
        </div>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Evidence readiness by basket</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Baskets never mix: finished vs label-only, one- vs double-sided, standard vs specialty finishes, and 4X is
          never treated as 3X. Unknown attributes form their own basket segments — an unclassified record can never
          contaminate a precise basket. Accepted low/median/high appear ONLY when a basket passes all three
          thresholds.
        </p>
        {baskets.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No eligible evidence yet — mark quotes Won/Lost on the Quotes board to start building history.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: 6, textAlign: "left" }}>Basket</th>
                  <th>Accepted</th><th>Exact</th><th>Near</th><th>Lost</th><th>Open</th>
                  <th>Customers</th><th>Months</th><th>First</th><th>Latest</th>
                  <th style={{ textAlign: "left" }}>Confidence</th>
                  <th>Low / Median / High</th>
                </tr>
              </thead>
              <tbody>
                {baskets.map((basket) => (
                  <tr key={basket.key} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, maxWidth: 380 }}>{basket.key}</td>
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
        <h2 style={{ margin: "0 0 6px" }}>Excluded test records ({excluded.length} shown)</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 8px" }}>
          Conservative shared exclusion (one helper everywhere): test_ source ids, ALL-CAPS TEST markers, known audit
          artifacts, test emails, explicit [TEST DATA] markers, and non-positive quantity/price. Ambiguous records are
          NEVER silently excluded.
        </p>
        {excluded.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
          <ul style={{ fontSize: 12, margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {excluded.map((row, index) => (
              <li key={index}><b>{row.label || "(unnamed)"}</b> ({row.source}) — {row.reasons.join("; ")}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
