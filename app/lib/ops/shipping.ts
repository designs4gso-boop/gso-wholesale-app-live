// GSO Operations Agent Platform — Shipping / Completion Agent (deterministic).
// Readiness only. No labels are purchased and no notifications are sent.

export const SHIPPING_VERSION = "shipping/1.0.0-2026-10-03";

export type ShippingFacts = {
  jobTicket: string | null;
  status: string;
  qcPassRecorded: boolean;
  packedAndLabeled: boolean;
  shipToKnown: boolean;
  tracking?: string | null;
  carrier?: string | null;
  handDelivered?: boolean;
  customerName?: string | null;
};

export type ShippingReadiness = {
  version: string;
  ready: boolean;
  canMarkShipped: boolean;
  reasons: string[];
  customerUpdateDraft: string | null;
};

export function shippingReadiness(f: ShippingFacts): ShippingReadiness {
  const reasons: string[] = [];
  if (f.status !== "completed") reasons.push(`job is ${f.status}, not completed`);
  if (!f.qcPassRecorded) reasons.push("QC pass not recorded");
  if (!f.packedAndLabeled) reasons.push("packing checklist incomplete");
  if (!f.shipToKnown) reasons.push("ship-to address not confirmed");
  const ready = reasons.length === 0;
  const hasRecord = Boolean(String(f.tracking ?? "").trim()) || f.handDelivered === true;
  const canMarkShipped = ready && hasRecord;
  if (ready && !hasRecord) reasons.push("no tracking number or hand-delivery record yet");
  const draft = canMarkShipped
    ? `Hi${f.customerName ? ` ${String(f.customerName).split(" ")[0]}` : ""}, your order${f.jobTicket ? ` ${f.jobTicket}` : ""} has shipped${f.carrier ? ` via ${f.carrier}` : ""}${f.tracking ? ` — tracking ${f.tracking}` : ""}. Thank you for working with GSO.`
    : null;
  return { version: SHIPPING_VERSION, ready, canMarkShipped, reasons, customerUpdateDraft: draft };
}
