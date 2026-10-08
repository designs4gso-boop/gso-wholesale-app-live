// ERP UI tokens (2026-10-05 overnight finish-line) — ONE place for the
// inline-style idioms that were copy-pasted across the inline-styled ERP
// routes (card, small help, table cells) and ONE status vocabulary so the
// same meaning looks the same everywhere.
//
// Client-safe, no imports. Polaris routes keep Polaris; this is for the
// inline-styled routes (cost calculator, cost verification, actual costs,
// shopify cost audit, ...). Not a framework: a handful of constants.

import type React from "react";

export const ERP_CARD_STYLE: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "white" };
export const ERP_SMALL_HELP: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };
export const ERP_TH_STYLE: React.CSSProperties = { background: "#f3f4f6", textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12 };
export const ERP_TD_STYLE: React.CSSProperties = { padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12, verticalAlign: "top" };
export const ERP_INPUT_STYLE: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
export const ERP_SECONDARY_BUTTON: React.CSSProperties = { padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" };

/**
 * STATUS VOCABULARY. Green = verified / ready / completed ONLY. Amber =
 * provisional, pending owner confirmation, needs a human decision. Red =
 * blocked / failed / execution blocked. Grey = informational.
 */
export type ErpStatusKey =
  | "READY_TO_QUOTE" | "VERIFIED" | "COMPLETED"
  | "PROVISIONAL" | "OWNER_CONFIRMATION_PENDING" | "NEEDS_DECISION"
  | "BLOCKED" | "FAILED" | "EXECUTION_BLOCKED"
  | "INFO";

export type ErpStatusTone = { label: string; bg: string; fg: string; border: string };

export const ERP_STATUS: Record<ErpStatusKey, ErpStatusTone> = {
  READY_TO_QUOTE: { label: "READY TO QUOTE", bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  VERIFIED: { label: "VERIFIED", bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  COMPLETED: { label: "COMPLETED", bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  PROVISIONAL: { label: "PROVISIONAL", bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
  OWNER_CONFIRMATION_PENDING: { label: "OWNER CONFIRMATION PENDING", bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
  NEEDS_DECISION: { label: "NEEDS DECISION", bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
  BLOCKED: { label: "BLOCKED", bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  FAILED: { label: "FAILED", bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  EXECUTION_BLOCKED: { label: "EXECUTION BLOCKED", bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  INFO: { label: "INFO", bg: "#f3f4f6", fg: "#374151", border: "#e5e7eb" },
};

export function erpBadgeStyle(key: ErpStatusKey): React.CSSProperties {
  const tone = ERP_STATUS[key];
  return { display: "inline-block", background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}`, borderRadius: 999, padding: "2px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" };
}

export function erpPanelStyle(key: ErpStatusKey): React.CSSProperties {
  const tone = ERP_STATUS[key];
  return { border: `1px solid ${tone.border}`, background: tone.bg, color: tone.fg, borderRadius: 10, padding: 10 };
}
