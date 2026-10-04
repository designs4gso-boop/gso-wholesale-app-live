// GSO Operations Agent Platform — Purchasing Agent (deterministic).
//
// Prepares a PurchaseRequest-shaped draft from KNOWN vendor data. It never
// invents a unit cost, freight, lead time or vendor. Sending a PO is DISABLED
// in this release; the output is an approval request for a human.

export const PURCHASING_VERSION = "purchasing/1.0.0-2026-10-03";

export type PurchasingStatus = "PO_READY_FOR_APPROVAL" | "PURCHASING_INFO_REQUIRED" | "VENDOR_COST_REQUIRED";

export type MaterialNeed = {
  materialId?: string | null;
  materialName: string;
  materialType?: string | null;
  unit?: string | null;
  quantity: number;
  neededBy?: string | null;
  source?: "production" | "low_stock" | "reorder_report" | "manual";
  jobTicket?: string | null;
};

export type VendorProductFacts = {
  vendor?: string | null;
  vendorId?: string | null;
  vendorSku?: string | null;
  moq?: number | null;
  defaultUnitCost?: number | null;
  leadTimeDays?: number | null;
};

export type PurchaseDraft = {
  status: "draft";
  priority: "low" | "normal" | "rush" | "critical";
  materialId: string | null;
  materialName: string;
  materialType: string | null;
  unit: string;
  vendor: string | null;
  vendorId: string | null;
  vendorSku: string | null;
  moq: number | null;
  leadTimeDays: number | null;
  requestedQty: number;
  unitCost: number;
  estimatedCost: number;
  /** Always null here: freight is never invented. */
  freight: null;
  neededBy: string | null;
  source: string;
  notes: string;
};

export type PurchasingResult = {
  version: string;
  status: PurchasingStatus;
  missing: string[];
  warnings: string[];
  draft: PurchaseDraft | null;
  approvalSummary: string;
};

export function preparePurchaseOrder(need: MaterialNeed, vendorProduct: VendorProductFacts | null, now = new Date()): PurchasingResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!String(need.materialName ?? "").trim()) missing.push("materialName");
  if (!(Number(need.quantity) > 0)) missing.push("quantity");
  if (!vendorProduct || !String(vendorProduct.vendor ?? "").trim()) missing.push("vendor");
  const unitCost = Number(vendorProduct?.defaultUnitCost);
  const costKnown = Number.isFinite(unitCost) && unitCost > 0;

  let status: PurchasingStatus;
  if (missing.length) status = "PURCHASING_INFO_REQUIRED";
  else if (!costKnown) status = "VENDOR_COST_REQUIRED";
  else status = "PO_READY_FOR_APPROVAL";

  let qty = Number(need.quantity) || 0;
  const moq = vendorProduct?.moq ?? null;
  if (moq && qty > 0 && qty < moq) { warnings.push(`requested ${qty} is below vendor MOQ ${moq}; draft uses MOQ`); qty = moq; }
  let priority: PurchaseDraft["priority"] = "normal";
  if (need.neededBy) {
    const days = (new Date(need.neededBy).getTime() - now.getTime()) / 86400000;
    const lead = vendorProduct?.leadTimeDays ?? null;
    if (lead != null && days < lead) { priority = "critical"; warnings.push(`needed in ${Math.floor(days)} days but vendor lead time is ${lead} days`); }
    else if (days < 7) priority = "rush";
  }
  if (vendorProduct && vendorProduct.leadTimeDays == null) warnings.push("vendor lead time unknown");

  const draft: PurchaseDraft | null = status === "PO_READY_FOR_APPROVAL" && vendorProduct ? {
    status: "draft",
    priority,
    materialId: need.materialId ?? null,
    materialName: need.materialName,
    materialType: need.materialType ?? null,
    unit: need.unit || "each",
    vendor: vendorProduct.vendor ?? null,
    vendorId: vendorProduct.vendorId ?? null,
    vendorSku: vendorProduct.vendorSku ?? null,
    moq,
    leadTimeDays: vendorProduct.leadTimeDays ?? null,
    requestedQty: qty,
    unitCost,
    estimatedCost: Math.round(qty * unitCost * 100) / 100,
    freight: null,
    neededBy: need.neededBy ?? null,
    source: need.source ?? "production",
    notes: [need.jobTicket ? `for job ${need.jobTicket}` : null, "prepared by purchasing_agent; freight not included; approval required before sending"].filter(Boolean).join("; "),
  } : null;

  const approvalSummary = draft
    ? `${draft.requestedQty} ${draft.unit} ${draft.materialName} from ${draft.vendor} at $${draft.unitCost.toFixed(4)}/${draft.unit} (est. $${draft.estimatedCost.toFixed(2)}, freight excluded)`
    : status === "VENDOR_COST_REQUIRED" ? `vendor cost for ${need.materialName} is not on file; staff must obtain it` : `missing: ${missing.join(", ")}`;

  return { version: PURCHASING_VERSION, status, missing, warnings, draft, approvalSummary };
}
