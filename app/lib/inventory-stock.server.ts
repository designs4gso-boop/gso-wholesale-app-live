// 2026-11-11 OWNER DECISION — inventory safety (no schema change).
//
// Every stock change is ONE atomic database increment / decrement, written in
// the same transaction as its MaterialInventoryMovement row, so concurrent or
// replayed submissions can never read a stale stock value and overwrite it.
//   - A deduction never takes stock below zero (conditional decrement) and is
//     refused when the material's stock is not tracked (null).
//   - Receipts / reversals add atomically.
// Reservation at scheduling (owner rule: reserve at scheduling, consume at
// completion) needs a reservation model — a schema change — and is NOT built
// here; see docs/GSO_ERP_PROJECT_STATE.md.

export type StockMovementInput = {
  shop: string;
  materialId: string;
  /** Positive adds stock (receipt / reversal / adjustment up); negative consumes. */
  delta: number;
  movementType: "production_deduction" | "reversal" | "purchase" | "adjustment" | "waste";
  unit: string;
  costPerUnit: number;
  source: string;
  reference: string | null;
  notes: string | null;
  jobId?: string | null;
  materialUsageId?: string | null;
};

export type StockMovementResult =
  | { ok: true; beforeQty: number; afterQty: number; movementId: string }
  | { ok: false; reason: "STOCK_NOT_TRACKED" | "INSUFFICIENT_STOCK" | "MATERIAL_NOT_FOUND" | "INVALID_QUANTITY"; message: string };

/**
 * Apply one stock movement atomically. `tx` is a Prisma client or an
 * interactive-transaction client; callers that must group several writes pass
 * the transaction client.
 */
export async function applyStockMovement(tx: any, input: StockMovementInput): Promise<StockMovementResult> {
  const delta = Number(input.delta);
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: "INVALID_QUANTITY", message: "Stock movement quantity must be a non-zero number." };
  const material = await tx.material.findFirst({ where: { shop: input.shop, id: input.materialId }, select: { id: true, stockOnHand: true } });
  if (!material) return { ok: false, reason: "MATERIAL_NOT_FOUND", message: "Material not found." };
  if (delta < 0) {
    if (material.stockOnHand == null) return { ok: false, reason: "STOCK_NOT_TRACKED", message: "Stock is not tracked for this material (set Stock on hand first) — nothing was deducted." };
    const qty = Math.abs(delta);
    // Conditional atomic decrement: succeeds only if enough stock exists right now.
    const updated = await tx.material.updateMany({ where: { shop: input.shop, id: material.id, stockOnHand: { gte: qty } }, data: { stockOnHand: { decrement: qty } } });
    if (!updated.count) return { ok: false, reason: "INSUFFICIENT_STOCK", message: `Not enough stock to deduct ${qty} ${input.unit} — inventory never goes negative. Adjust stock first if the count is wrong.` };
  } else {
    await tx.material.updateMany({ where: { shop: input.shop, id: material.id }, data: { stockOnHand: { increment: delta } } });
  }
  const after = await tx.material.findFirst({ where: { shop: input.shop, id: material.id }, select: { stockOnHand: true } });
  const afterQty = Number(after?.stockOnHand ?? 0);
  const beforeQty = afterQty - delta;
  const movement = await tx.materialInventoryMovement.create({
    data: {
      shop: input.shop,
      materialId: material.id,
      jobId: input.jobId ?? null,
      materialUsageId: input.materialUsageId ?? null,
      movementType: input.movementType,
      quantity: delta,
      unit: input.unit,
      beforeQty,
      afterQty,
      costPerUnit: input.costPerUnit,
      costImpact: Math.abs(delta) * input.costPerUnit * (input.movementType === "reversal" ? -1 : 1),
      source: input.source,
      reference: input.reference,
      notes: input.notes,
    },
  });
  return { ok: true, beforeQty, afterQty, movementId: movement.id };
}
