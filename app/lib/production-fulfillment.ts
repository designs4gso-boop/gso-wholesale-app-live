// OWNER DECISIONS 2026-11-11 — production completion, shipment / pickup, reprint reasons.
//
// Workflow: quote -> approval -> payment -> scheduling -> printing ->
// finishing/application -> QC -> SHIPPED or PICKED UP -> COMPLETED.
//
//   - A job becomes COMPLETED only after it is SHIPPED or PICKED UP (never
//     merely because printing/production ended). Already-completed jobs are
//     never re-checked or reopened by this rule.
//   - SHIPPED / PICKED UP are set only through a shipment / pickup RECORD
//     (carrier, tracking, packages, ship date, actual cost / pickup time) —
//     never a bare status change — and require QC PASS for every item.
//   - Shipping cost is what the operator enters; it is never invented.
//   - Reprints carry one of the owner's reason categories, validated on the
//     server.
//
// Pure, client-safe, no Prisma. No schema change: records are
// ProductionJobEvent rows (eventType "shipped" / "tracking_added" /
// "picked_up") with the details as JSON in newValue.

export const FULFILLMENT_STATUSES = ["shipped", "picked_up"] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export const COMPLETION_REQUIRES_FULFILLMENT = "COMPLETION REQUIRES SHIPMENT OR PICKUP";
export const FULFILLMENT_RECORD_REQUIRED = "SHIPMENT / PICKUP RECORD REQUIRED";

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return (FULFILLMENT_STATUSES as readonly string[]).includes(norm(value));
}

/**
 * Guard for a STATUS-ONLY change (Production board / calendar dropdowns).
 * - Entering shipped / picked_up needs the shipment / pickup form.
 * - Entering completed needs the job to be shipped or picked up already.
 */
export function statusChangeFulfillmentVerdict(fromStatus: unknown, toStatus: unknown): { ok: true } | { ok: false; message: string } {
  const from = norm(fromStatus);
  const to = norm(toStatus);
  if (to === from) return { ok: true };
  if (isFulfillmentStatus(to)) {
    return { ok: false, message: `${FULFILLMENT_RECORD_REQUIRED} — use "Record shipment" or "Record pickup" so the carrier / tracking / packages / ship date (or pickup time) are captured.` };
  }
  if (to === "completed" && from !== "completed" && !isFulfillmentStatus(from)) {
    return { ok: false, message: `${COMPLETION_REQUIRES_FULFILLMENT} — a job is Completed only after it is Shipped or Picked Up (owner rule). Record the shipment or pickup first.` };
  }
  return { ok: true };
}

/** QC PASS is required when a job enters shipped / picked_up (and completed — production-qc-guard). */
export function fulfillmentQcGuardApplies(fromStatus: unknown, toStatus: unknown): boolean {
  return isFulfillmentStatus(toStatus) && !isFulfillmentStatus(fromStatus) && norm(fromStatus) !== "completed";
}

export type ShipmentRecord = {
  carrier: string;
  trackingNumber: string | null;
  packageCount: number;
  shipDate: string; // YYYY-MM-DD
  /** Actual shipping cost as entered; null when not entered (never invented). */
  actualShippingCost: number | null;
};

export type PickupRecord = {
  pickedUpAt: string; // ISO
  pickedUpBy: string | null;
  note: string | null;
};

type Parsed<T> = { ok: true; record: T } | { ok: false; errors: string[] };

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

export function parseShipmentInput(input: { carrier?: unknown; trackingNumber?: unknown; packageCount?: unknown; shipDate?: unknown; actualShippingCost?: unknown }): Parsed<ShipmentRecord> {
  const errors: string[] = [];
  const carrier = text(input.carrier, 60);
  if (!carrier) errors.push("Carrier is required.");
  const trackingNumber = text(input.trackingNumber, 120) || null;
  const packagesRaw = String(input.packageCount ?? "").trim();
  const packageCount = Number(packagesRaw);
  if (!packagesRaw || !Number.isInteger(packageCount) || packageCount < 1 || packageCount > 999) errors.push("Package count must be a whole number from 1 to 999.");
  const shipDate = text(input.shipDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate) || Number.isNaN(new Date(`${shipDate}T12:00:00Z`).getTime())) errors.push("Ship date is required (YYYY-MM-DD).");
  const costRaw = String(input.actualShippingCost ?? "").trim();
  let actualShippingCost: number | null = null;
  if (costRaw) {
    const cost = Number(costRaw.replace(/^\$/, ""));
    if (!Number.isFinite(cost) || cost < 0 || cost > 100000) errors.push("Actual shipping cost must be a dollar amount of 0 or more (leave blank if not known yet).");
    else actualShippingCost = Math.round(cost * 100) / 100;
  }
  return errors.length ? { ok: false, errors } : { ok: true, record: { carrier, trackingNumber, packageCount, shipDate, actualShippingCost } };
}

export function parsePickupInput(input: { pickedUpAt?: unknown; pickedUpBy?: unknown; note?: unknown }, now: Date = new Date()): Parsed<PickupRecord> {
  const raw = text(input.pickedUpAt, 40);
  const when = raw ? new Date(raw) : now;
  if (Number.isNaN(when.getTime())) return { ok: false, errors: ["Pickup time is not a valid date/time."] };
  return { ok: true, record: { pickedUpAt: when.toISOString(), pickedUpBy: text(input.pickedUpBy, 120) || null, note: text(input.note, 300) || null } };
}

export function shipmentSummary(record: ShipmentRecord): string {
  return `Shipped ${record.shipDate} via ${record.carrier}, ${record.packageCount} package(s)${record.trackingNumber ? `, tracking ${record.trackingNumber}` : ", no tracking number"}${record.actualShippingCost != null ? `, actual shipping $${record.actualShippingCost.toFixed(2)}` : ", shipping cost not entered"}.`;
}

/* ---------------- reprint reasons (owner categories) ---------------- */

export const REPRINT_REASONS = [
  { value: "machine_error", label: "Machine error" },
  { value: "operator_error", label: "Operator error" },
  { value: "artwork_prepress_error", label: "Artwork / prepress error" },
  { value: "customer_change_error", label: "Customer change / error" },
  { value: "material_defect", label: "Material defect" },
  { value: "color_quality_issue", label: "Color / quality issue" },
  { value: "shipping_damage", label: "Shipping damage" },
  { value: "other", label: "Other" },
] as const;
export type ReprintReason = (typeof REPRINT_REASONS)[number]["value"];

export function isReprintReason(value: unknown): value is ReprintReason {
  return REPRINT_REASONS.some((reason) => reason.value === value);
}

export function reprintReasonLabel(value: string): string {
  return REPRINT_REASONS.find((reason) => reason.value === value)?.label ?? value;
}
