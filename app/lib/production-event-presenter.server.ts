// Production-event presenter (Patch 15E.3). Pure: turns raw ProductionJob
// events (whose messages may embed audit JSON like "SNAPSHOT {…}" /
// "PRIOR FINAL {…}") into human-readable summaries with collapsed audit
// detail. NOTHING is lost: the original message and pretty-printed payload
// stay available under "Raw event data"; event records are never modified.

import { cleanCommercialName } from "./commercial-name-resolver.server";

export type PresentedEventSection = { title: string; rows: Array<[string, string]> };

export type PresentedEvent = {
  id: string;
  title: string;
  summaryLines: string[]; // human-readable, no raw JSON, no empty fields
  actor: string | null;
  timestamp: string | null;
  jobTicket: string | null;
  customer: string | null;
  product: string | null;
  legacy: boolean;
  auditSections: PresentedEventSection[]; // formatted key/value detail (collapsed by default)
  rawJson: string | null; // pretty-printed embedded payload, when present
  rawMessage: string; // always preserved
};

const money = (value: unknown) => `$${(Number(value) || 0).toFixed(2)}`;
const pct = (value: unknown) => `${(Number(value) || 0).toFixed(1)}%`;

function extractJsonAfter(message: string, marker: string): { payload: any | null; plainMessage: string } {
  const index = message.indexOf(marker);
  if (index < 0) return { payload: null, plainMessage: message };
  const plainMessage = message.slice(0, index).trim().replace(/\|\s*$/, "").trim();
  try {
    return { payload: JSON.parse(message.slice(index + marker.length)), plainMessage };
  } catch {
    return { payload: null, plainMessage }; // malformed JSON — fall back safely, keep the readable head
  }
}

function pushRow(rows: Array<[string, string]>, label: string, value: unknown) {
  const text = value == null ? "" : String(value);
  if (text !== "" && text !== "null" && text !== "undefined") rows.push([label, text]);
}

function titleForEventType(eventType: string): string {
  const map: Record<string, string> = {
    actual_cost_finalized: "Actual cost finalized",
    actual_cost_reopened: "Actual cost reopened",
    actual_cost_updated: "Actual cost updated",
    created_from_quote: "Production job created (ERP quote)",
    created_from_quote_builder: "Production job created (quote builder)",
    created_from_shopify_order: "Production job created (Shopify order)",
    created_manual_admin: "Production job created (manual admin)",
    proof_created: "Proof sheet created",
    proof_sent: "Proof sent",
    proof_approved: "Proof approved",
    proof_rejected: "Proof rejected",
    status_changed: "Status changed",
    note_added: "Note added",
    alert_sent: "Production alert sent",
    alert_skipped: "Production alert skipped",
  };
  if (map[eventType]) return map[eventType];
  const cleaned = String(eventType || "").replace(/_/g, " ").trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Production event";
}

export function presentProductionEvent(event: {
  id?: string;
  eventType?: string | null;
  message?: string | null;
  createdBy?: string | null;
  createdAt?: string | Date | null;
  jobTicket?: string | null;
  customer?: string | null;
  product?: string | null;
}): PresentedEvent {
  const eventType = String(event.eventType || "");
  const rawMessage = String(event.message || "");
  const timestamp = event.createdAt ? new Date(event.createdAt).toISOString() : null;
  const base: PresentedEvent = {
    id: String(event.id || `${eventType}-${timestamp || "unknown"}`),
    title: titleForEventType(eventType),
    summaryLines: [],
    actor: event.createdBy || null,
    timestamp,
    jobTicket: event.jobTicket || null,
    customer: event.customer || null,
    product: cleanCommercialName(event.product) || event.product || null,
    legacy: false,
    auditSections: [],
    rawJson: null,
    rawMessage,
  };

  if (eventType === "actual_cost_finalized") {
    const { payload } = extractJsonAfter(rawMessage, "SNAPSHOT ");
    if (payload) {
      base.summaryLines = [
        `Final cost: ${money(payload.finalTotalCost)}`,
        `Final profit: ${money(payload.finalGrossProfit)}`,
        `Final margin: ${pct(payload.finalGrossMarginPct)}`,
        `Variance: ${payload.varianceDollars < 0 ? "-" : ""}${money(Math.abs(Number(payload.varianceDollars) || 0))}${payload.variancePct != null ? ` (${pct(payload.variancePct)})` : ""}`,
        `Gate: ${payload.gateStatus || "READY"}`,
        ...(payload.finalizeReason ? [`Reason: ${payload.finalizeReason}`] : []),
      ];
      base.actor = base.actor || payload.actor || null;
      const inputs: Array<[string, string]> = [];
      const entered = payload.enteredInputs || {};
      pushRow(inputs, "Labor minutes", entered.laborMinutes);
      pushRow(inputs, "Labor rate", entered.laborRate != null ? money(entered.laborRate) : null);
      pushRow(inputs, "Labor override", entered.laborCostOverride != null ? money(entered.laborCostOverride) : null);
      pushRow(inputs, "Labor $0 confirmed", entered.laborZeroConfirmed ? "yes" : null);
      pushRow(inputs, "Packing", entered.packingCost != null ? money(entered.packingCost) : null);
      pushRow(inputs, "Shipping", entered.shippingCost != null ? money(entered.shippingCost) : null);
      pushRow(inputs, "Outsource", entered.outsourceCost != null ? money(entered.outsourceCost) : null);
      pushRow(inputs, "Reprint", entered.reprintCost != null ? money(entered.reprintCost) : null);
      pushRow(inputs, "Other", entered.otherCost != null ? money(entered.otherCost) : null);
      const components: Array<[string, string]> = [];
      const parts = payload.components || {};
      pushRow(components, "Print cost", parts.printCost != null ? `${money(parts.printCost)} (${parts.printCostSource || ""})` : null);
      pushRow(components, "Material", parts.materialCost != null ? money(parts.materialCost) : null);
      pushRow(components, "Labor", parts.laborCost != null ? `${money(parts.laborCost)} (${parts.laborBasis || ""})` : null);
      pushRow(components, "Packing", parts.packingCost != null ? money(parts.packingCost) : null);
      pushRow(components, "Shipping", parts.shippingCost != null ? money(parts.shippingCost) : null);
      pushRow(components, "Outsource/vendor", parts.outsourceCost != null ? money(parts.outsourceCost) : null);
      pushRow(components, "Reprint", parts.reprintCost != null ? money(parts.reprintCost) : null);
      pushRow(components, "Other", parts.otherCost != null ? money(parts.otherCost) : null);
      const totals: Array<[string, string]> = [];
      pushRow(totals, "Revenue", money(payload.revenue));
      pushRow(totals, "Final total cost", money(payload.finalTotalCost));
      pushRow(totals, "Final gross profit", money(payload.finalGrossProfit));
      pushRow(totals, "Final gross margin", pct(payload.finalGrossMarginPct));
      const variance: Array<[string, string]> = [];
      pushRow(variance, "Estimated total cost", money(payload.estimatedTotalCost));
      pushRow(variance, "Variance $", money(payload.varianceDollars));
      pushRow(variance, "Variance %", payload.variancePct != null ? pct(payload.variancePct) : "unavailable (no estimated cost)");
      const gate: Array<[string, string]> = [];
      pushRow(gate, "Gate status", payload.gateStatus);
      pushRow(gate, "Warnings", (payload.warningReasons || []).join("; "));
      pushRow(gate, "Finalize reason", payload.finalizeReason);
      const meta: Array<[string, string]> = [];
      pushRow(meta, "Actor", payload.actor);
      pushRow(meta, "Finalized at", payload.finalizedAt);
      pushRow(meta, "Family", payload.family);
      base.auditSections = [
        { title: "Inputs", rows: inputs },
        { title: "Cost components", rows: components },
        { title: "Revenue and totals", rows: totals },
        { title: "Variance", rows: variance },
        { title: "Gate and warnings", rows: gate },
        { title: "Actor and timestamp", rows: meta },
        ...(entered.dtp ? [{ title: "DTP details", rows: (() => { const rows: Array<[string, string]> = []; pushRow(rows, "Invoice subtotal", entered.dtp.invoiceSubtotal != null ? money(entered.dtp.invoiceSubtotal) : null); pushRow(rows, "Additional charges", entered.dtp.additionalCharges != null ? money(entered.dtp.additionalCharges) : null); pushRow(rows, "Credit", entered.dtp.credit != null ? money(entered.dtp.credit) : null); pushRow(rows, "Actual freight", entered.dtp.freight != null ? money(entered.dtp.freight) : null); pushRow(rows, "Invoice includes freight", entered.dtp.invoiceIncludesFreight ? "yes" : "no"); return rows; })() }] : []),
      ].filter((section) => section.rows.length);
      base.rawJson = JSON.stringify(payload, null, 2);
      return base;
    }
  }

  if (eventType === "actual_cost_reopened") {
    const { payload, plainMessage } = extractJsonAfter(rawMessage, "PRIOR FINAL ");
    const reasonMatch = plainMessage.match(/Reason:\s*(.+?)\.?$/);
    if (payload) {
      base.summaryLines = [
        `Previous final cost: ${money(payload.totalCost)}`,
        `Previous profit: ${money(payload.profit)}`,
        `Previous margin: ${pct(payload.marginPct)}`,
        ...(reasonMatch ? [`Reason: ${reasonMatch[1]}`] : []),
      ];
      const prior: Array<[string, string]> = [];
      pushRow(prior, "Prior labor", money(payload.laborCost));
      pushRow(prior, "Prior packing", money(payload.packingCost));
      pushRow(prior, "Prior shipping", money(payload.shippingCost));
      pushRow(prior, "Prior outsource", money(payload.outsourceCost));
      pushRow(prior, "Prior reprint", money(payload.reprintCost));
      pushRow(prior, "Prior other", money(payload.otherCost));
      pushRow(prior, "Previously finalized at", payload.finalizedAt);
      pushRow(prior, "Previously finalized by", payload.finalizedBy);
      base.auditSections = [{ title: "Prior final figures", rows: prior }];
      base.rawJson = JSON.stringify(payload, null, 2);
      return base;
    }
  }

  // generic path: strip any embedded JSON blobs from the visible summary but
  // preserve them for the raw section; malformed JSON never breaks display
  const withoutSnapshot = extractJsonAfter(rawMessage, "SNAPSHOT ");
  const withoutPrior = extractJsonAfter(withoutSnapshot.plainMessage, "PRIOR FINAL ");
  const readable = withoutPrior.plainMessage.trim();
  const embedded = withoutSnapshot.payload || withoutPrior.payload;
  if (embedded) base.rawJson = JSON.stringify(embedded, null, 2);
  if (readable) {
    base.summaryLines = [readable.length > 260 ? `${readable.slice(0, 260)}…` : readable];
  } else if (rawMessage.trim()) {
    base.summaryLines = ["Legacy event — open audit details for the original data."];
    base.legacy = true;
    base.rawJson = base.rawJson || rawMessage;
  } else {
    base.summaryLines = ["Legacy event"];
    base.legacy = true;
  }
  return base;
}
