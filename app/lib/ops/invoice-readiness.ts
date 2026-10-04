// GSO Operations Agent Platform — Invoice Coordinator (ERP-side readiness).
//
// QUICKBOOKS IS DEFERRED — NOT CONNECTED. This module only decides whether the
// ERP has everything an invoice would need and prepares an approval summary.
// It never invents tax, discounts, terms, shipping or deposits, and never
// creates an invoice anywhere.

export const INVOICE_READINESS_VERSION = "invoice-readiness/1.0.0-2026-10-03";
export const ACCOUNTING_CONNECTOR_STATUS = "DEFERRED — NOT CONNECTED" as const;

export type InvoiceStatus = "INVOICE_READY_FOR_APPROVAL" | "ACCOUNTING_INFO_REQUIRED";

export type InvoiceQuoteFacts = {
  id: string;
  status: string;
  customerName?: string | null;
  company?: string | null;
  email?: string | null;
  items: Array<{ productName: string; quantity: number; unitPrice: number }>;
  depositAmount?: number | null;
  balanceDue?: number | null;
};

export type InvoiceFacts = {
  quote: InvoiceQuoteFacts;
  jobStatus?: string | null;
  shippingAmount?: number | null;
  shippingKnown: boolean;
  taxKnown: boolean;
  termsKnown: boolean;
};

export type InvoiceReadiness = {
  version: string;
  status: InvoiceStatus;
  connector: typeof ACCOUNTING_CONNECTOR_STATUS;
  missing: string[];
  lines: Array<{ description: string; quantity: number; unitPrice: number; lineTotal: number }>;
  subtotal: number;
  depositOnFile: number;
  balanceDue: number | null;
  approvalSummary: string;
};

const ACCEPTED_QUOTE_STATUSES = ["accepted", "approved", "won", "converted", "in_production", "completed"];

export function invoiceReadiness(f: InvoiceFacts): InvoiceReadiness {
  const missing: string[] = [];
  const q = f.quote;
  if (!String(q.customerName ?? "").trim() && !String(q.company ?? "").trim()) missing.push("customer name/company");
  if (!String(q.email ?? "").trim()) missing.push("billing email");
  if (!ACCEPTED_QUOTE_STATUSES.includes(String(q.status).toLowerCase())) missing.push(`quote status is "${q.status}", not an accepted/won status`);
  if (!q.items.length) missing.push("quote lines");
  const lines = q.items.map((i) => {
    if (!(Number(i.quantity) > 0)) missing.push(`quantity for ${i.productName}`);
    if (!(Number(i.unitPrice) > 0)) missing.push(`approved selling price for ${i.productName}`);
    return { description: i.productName, quantity: Number(i.quantity) || 0, unitPrice: Number(i.unitPrice) || 0, lineTotal: Math.round((Number(i.quantity) || 0) * (Number(i.unitPrice) || 0) * 100) / 100 };
  });
  if (!f.shippingKnown) missing.push("shipping amount (not invented)");
  if (!f.taxKnown) missing.push("tax treatment (not invented)");
  if (!f.termsKnown) missing.push("payment terms (not invented)");
  if (f.jobStatus && !["completed", "shipped"].includes(f.jobStatus)) missing.push(`production job is ${f.jobStatus}; final invoice usually waits for completion`);
  const subtotal = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  const deposit = Number(q.depositAmount) || 0;
  const balanceDue = missing.length ? null : Math.round((subtotal + (Number(f.shippingAmount) || 0) - deposit) * 100) / 100;
  const status: InvoiceStatus = missing.length ? "ACCOUNTING_INFO_REQUIRED" : "INVOICE_READY_FOR_APPROVAL";
  const approvalSummary = status === "INVOICE_READY_FOR_APPROVAL"
    ? `Invoice for ${q.company || q.customerName}: ${lines.length} line(s), subtotal $${subtotal.toFixed(2)}, deposit on file $${deposit.toFixed(2)}, balance $${balanceDue!.toFixed(2)}. Accounting connector: ${ACCOUNTING_CONNECTOR_STATUS}.`
    : `Not ready: ${missing.join("; ")}`;
  return { version: INVOICE_READINESS_VERSION, status, connector: ACCOUNTING_CONNECTOR_STATUS, missing, lines, subtotal, depositOnFile: deposit, balanceDue, approvalSummary };
}
