// 2026-11-12 OWNER RULE — inventory reservation accounting (READY AFTER MIGRATION).
//
//   At production SCHEDULING: RESERVE expected inventory (stock on hand is
//     untouched; "available" = on hand - active reservations).
//   At production COMPLETION: CONSUME the ACTUAL quantity (the stock decrement
//     itself goes through inventory-stock.server.ts applyStockMovement).
//   On CANCELLATION: RELEASE the reservation.
//   REPRINT: only additional material actually issued is reserved/consumed —
//     it gets its own key, so the original reservation is never consumed twice.
//
// Pure decision logic; the InventoryReservation table arrives with the staged
// migration 20261112090000_add_operational_records. Every plan is idempotent
// by idempotencyKey: replays return "noop", never a second movement.

export type ReservationStatus = "reserved" | "consumed" | "released";

export type ReservationRecord = {
  idempotencyKey: string;
  jobId: string;
  materialId: string;
  quantity: number;
  consumedQty: number | null;
  status: ReservationStatus;
};

export type ReservationPlan =
  | { action: "create"; record: Omit<ReservationRecord, "consumedQty"> & { consumedQty: null } }
  | { action: "consume"; idempotencyKey: string; consumedQty: number; stockDelta: number }
  | { action: "release"; idempotencyKey: string }
  | { action: "noop"; reason: string }
  | { action: "refuse"; reason: "INSUFFICIENT_AVAILABLE_STOCK" | "INVALID_QUANTITY" | "ALREADY_CONSUMED" | "ALREADY_RELEASED" | "NOT_FOUND"; message: string };

export function reservationKey(jobId: string, materialId: string, issue = 0): string {
  return issue > 0 ? `job:${jobId}:material:${materialId}:reprint:${issue}` : `job:${jobId}:material:${materialId}`;
}

/** Stock still free to promise: on hand minus every ACTIVE reservation (never below zero). */
export function availableStock(stockOnHand: number | null | undefined, reservations: ReservationRecord[], materialId: string): number | null {
  if (stockOnHand == null) return null;
  const held = reservations.filter((r) => r.materialId === materialId && r.status === "reserved").reduce((sum, r) => sum + r.quantity, 0);
  return Math.max(0, Number(stockOnHand) - held);
}

/** Scheduling: reserve once per key; never over-commit stock. */
export function planReservation(input: {
  reservations: ReservationRecord[];
  stockOnHand: number | null;
  jobId: string;
  materialId: string;
  quantity: number;
  issue?: number;
}): ReservationPlan {
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { action: "refuse", reason: "INVALID_QUANTITY", message: "Reservation quantity must be greater than zero." };
  const key = reservationKey(input.jobId, input.materialId, input.issue ?? 0);
  const existing = input.reservations.find((r) => r.idempotencyKey === key);
  if (existing) return { action: "noop", reason: `Already ${existing.status} (${key}).` };
  const available = availableStock(input.stockOnHand, input.reservations, input.materialId);
  if (available == null || quantity > available + 1e-9) {
    return { action: "refuse", reason: "INSUFFICIENT_AVAILABLE_STOCK", message: `Only ${available ?? "untracked"} available after existing reservations — ${quantity} cannot be reserved (stock is never over-committed).` };
  }
  return { action: "create", record: { idempotencyKey: key, jobId: input.jobId, materialId: input.materialId, quantity, consumedQty: null, status: "reserved" } };
}

/** Completion: consume the ACTUAL quantity exactly once. */
export function planConsumption(reservation: ReservationRecord | null | undefined, actualQty: number): ReservationPlan {
  if (!reservation) return { action: "refuse", reason: "NOT_FOUND", message: "No reservation to consume." };
  if (reservation.status === "consumed") return { action: "noop", reason: `Already consumed (${reservation.idempotencyKey}) — never consumed twice.` };
  if (reservation.status === "released") return { action: "refuse", reason: "ALREADY_RELEASED", message: "This reservation was released (job cancelled) and cannot be consumed." };
  const qty = Number(actualQty);
  if (!Number.isFinite(qty) || qty < 0) return { action: "refuse", reason: "INVALID_QUANTITY", message: "Actual consumed quantity must be zero or more." };
  return { action: "consume", idempotencyKey: reservation.idempotencyKey, consumedQty: qty, stockDelta: -qty };
}

/** Cancellation: release an active reservation; consumed stock is never "released" back. */
export function planRelease(reservation: ReservationRecord | null | undefined): ReservationPlan {
  if (!reservation) return { action: "noop", reason: "Nothing reserved." };
  if (reservation.status === "released") return { action: "noop", reason: "Already released." };
  if (reservation.status === "consumed") return { action: "refuse", reason: "ALREADY_CONSUMED", message: "Consumed material cannot be released; record an inventory adjustment or reversal instead." };
  return { action: "release", idempotencyKey: reservation.idempotencyKey };
}
