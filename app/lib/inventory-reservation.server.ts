// 2026-11-12 — inventory reservation EXECUTION against the InventoryReservation
// table (migration 20261112090000_add_operational_records). The decisions come
// from the pure planners in inventory-reservation.ts; this module only applies
// them atomically.
//
//   reserveInventory     — scheduling: hold expected stock (stockOnHand untouched).
//   consumeReservation   — completion: deduct the ACTUAL quantity exactly once
//                          (through applyStockMovement: never negative).
//   releaseJobReservations — cancellation: release every active hold exactly once.
//
// Every call takes a Prisma interactive-transaction client (or the client).
// Replays are no-ops: the (shop, idempotencyKey) unique index blocks a second
// reservation, and consume / release are conditional on status "reserved", so
// a second submission matches zero rows and changes nothing.

import { applyStockMovement } from "./inventory-stock.server";
import { planConsumption, planReservation, reservationKey, type ReservationPlan, type ReservationRecord } from "./inventory-reservation";

const toRecord = (row: any): ReservationRecord => ({
  idempotencyKey: row.idempotencyKey,
  jobId: row.jobId,
  materialId: row.materialId,
  quantity: Number(row.quantity),
  consumedQty: row.consumedQty == null ? null : Number(row.consumedQty),
  status: row.status,
});

const isUniqueViolation = (error: any) => error?.code === "P2002";

export async function reserveInventory(tx: any, input: {
  shop: string; jobId: string; jobItemId?: string | null; materialId: string; quantity: number; unit: string; issue?: number; actor?: string | null; notes?: string | null;
}): Promise<ReservationPlan> {
  const material = await tx.material.findFirst({ where: { shop: input.shop, id: input.materialId }, select: { id: true, stockOnHand: true } });
  if (!material) return { action: "refuse", reason: "NOT_FOUND", message: "Material not found." };
  // Row lock on the material (an UPDATE holds it until the transaction ends) so
  // two concurrent reservations of the same material cannot both see the same
  // free stock and over-commit it.
  await tx.material.updateMany({ where: { shop: input.shop, id: material.id }, data: { updatedAt: new Date() } });
  const active = (await tx.inventoryReservation.findMany({
    where: { shop: input.shop, materialId: material.id, OR: [{ status: "reserved" }, { idempotencyKey: reservationKey(input.jobId, material.id, input.issue ?? 0) }] },
  })).map(toRecord);
  const plan = planReservation({ reservations: active, stockOnHand: material.stockOnHand, jobId: input.jobId, materialId: material.id, quantity: input.quantity, issue: input.issue });
  if (plan.action !== "create") return plan;
  try {
    await tx.inventoryReservation.create({
      data: {
        shop: input.shop, materialId: material.id, jobId: input.jobId, jobItemId: input.jobItemId ?? null,
        quantity: plan.record.quantity, unit: input.unit, status: "reserved", idempotencyKey: plan.record.idempotencyKey,
        reservedBy: input.actor ?? null, notes: input.notes ?? null,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { action: "noop", reason: `Already reserved (${plan.record.idempotencyKey}).` };
    throw error;
  }
  return plan;
}

export async function consumeReservation(tx: any, input: {
  shop: string; idempotencyKey: string; actualQty: number; costPerUnit: number; actor?: string | null;
}): Promise<ReservationPlan | { action: "refuse"; reason: string; message: string }> {
  const row = await tx.inventoryReservation.findFirst({ where: { shop: input.shop, idempotencyKey: input.idempotencyKey } });
  const plan = planConsumption(row ? toRecord(row) : null, input.actualQty);
  if (plan.action !== "consume") return plan;
  // Claim the reservation first: only one submission can move it out of "reserved".
  const claimed = await tx.inventoryReservation.updateMany({
    where: { shop: input.shop, idempotencyKey: input.idempotencyKey, status: "reserved" },
    data: { status: "consumed", consumedQty: plan.consumedQty, consumedAt: new Date() },
  });
  if (!claimed.count) return { action: "noop", reason: `Already consumed or released (${input.idempotencyKey}).` };
  if (plan.consumedQty > 0) {
    const moved = await applyStockMovement(tx, {
      shop: input.shop, materialId: row.materialId, delta: plan.stockDelta, movementType: "production_deduction", unit: row.unit,
      costPerUnit: input.costPerUnit, source: "reservation", reference: input.idempotencyKey,
      notes: `Actual quantity consumed at completion${input.actor ? ` by ${input.actor}` : ""}.`, jobId: row.jobId,
    });
    // Throwing rolls the claim back with the transaction: the hold stays "reserved".
    if (!moved.ok) throw Object.assign(new Error(moved.message), { reservationRefusal: moved.reason });
  }
  return plan;
}

/** Cancellation: release every ACTIVE hold of the job; consumed rows are never touched. */
export async function releaseJobReservations(tx: any, input: { shop: string; jobId: string }): Promise<{ released: number }> {
  const result = await tx.inventoryReservation.updateMany({
    where: { shop: input.shop, jobId: input.jobId, status: "reserved" },
    data: { status: "released", releasedAt: new Date() },
  });
  return { released: Number(result?.count ?? 0) };
}
