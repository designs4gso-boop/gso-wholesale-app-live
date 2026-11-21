// 2026-11-20 — the Cost Calculator panel for a COST-ONLY jar (Eris).
//
// Presentation only. Every figure and every word comes from the summary the
// server built (jar-cost-inputs.server.ts costOnlyJarSummary) — this component
// does no arithmetic and holds no cost data.
//
// A cost-only jar is a VALID product whose costing inputs are incomplete, so
// the panel is informational (neutral blue), not the red error treatment. What
// is known is listed as known; what was never provided is listed as PENDING —
// never as a zero.

import type { CSSProperties } from "react";
import type { CanonicalCostOnlyJar } from "../lib/canonical-calculator-shared";

const box: CSSProperties = { border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 10, padding: "8px 10px", fontSize: 12, color: "#1e3a8a" };
const chip: CSSProperties = { marginLeft: 8, fontSize: 11, padding: "1px 8px", borderRadius: 999, border: "1px solid #bfdbfe", background: "white", color: "#1e40af", fontWeight: 800 };
const heading: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: "#475569", marginTop: 6 };
const cellLabel: CSSProperties = { padding: "1px 12px 1px 0", color: "#334155", whiteSpace: "nowrap", verticalAlign: "top" };
const cellValue: CSSProperties = { padding: "1px 0", color: "#0f172a", fontWeight: 700 };

export function CostOnlyJarPanel({ summary, style }: { summary: CanonicalCostOnlyJar; style?: CSSProperties }) {
  const partial = summary.status === "COST_DATA_PARTIAL";
  return (
    <div data-cost-only-jar={summary.productKey} data-cost-status={summary.status} style={{ ...box, ...style }}>
      <div>
        <b style={{ fontSize: 13 }}>{summary.productName}</b>
        <span style={chip}>{summary.statusLabel}</span>
      </div>
      <div style={{ color: "#334155", marginTop: 2 }}>
        Cost only — not for sale. {partial ? "No landed cost and no selling price are shown until the pending items below are provided." : "No selling price is set for this product."}
      </div>
      <div style={heading}>KNOWN</div>
      <table style={{ borderCollapse: "collapse" }}>
        <tbody>
          {summary.known.map((row) => (
            <tr key={row.label}><td style={cellLabel}>{row.label}</td><td style={cellValue}>{row.value}</td></tr>
          ))}
        </tbody>
      </table>
      {summary.pending.length ? (<>
        <div style={heading}>PENDING</div>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            {summary.pending.map((row) => (
              <tr key={row.label}><td style={cellLabel}>{row.label}</td><td style={cellValue}>{row.value}</td></tr>
            ))}
          </tbody>
        </table>
      </>) : null}
    </div>
  );
}
