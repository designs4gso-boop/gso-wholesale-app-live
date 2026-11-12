// 2026-11-11 OWNER DECISIONS — inventory safety and purchasing approval.
//
// Stock changes are atomic increments / conditional decrements in one
// transaction with the movement row: never negative, never double-applied,
// untracked stock is never deducted. Staff create purchase requests; only the
// owner / authorized managers order, re-price or cancel them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyStockMovement } from "../app/lib/inventory-stock.server";

/** Minimal in-memory stand-in for the two Prisma models the helper touches. */
function fakeTx(stock: number | null) {
  const material = { id: "m1", shop: "s", stockOnHand: stock as number | null };
  const movements: any[] = [];
  const tx = {
    material: {
      findFirst: async ({ where }: any) => (where.id === material.id && where.shop === material.shop ? { ...material } : null),
      updateMany: async ({ where, data }: any) => {
        if (where.id !== material.id) return { count: 0 };
        if (where.stockOnHand?.gte != null && !(material.stockOnHand != null && material.stockOnHand >= where.stockOnHand.gte)) return { count: 0 };
        if (data.stockOnHand.decrement != null) material.stockOnHand = Number(material.stockOnHand) - data.stockOnHand.decrement;
        if (data.stockOnHand.increment != null) material.stockOnHand = Number(material.stockOnHand ?? 0) + data.stockOnHand.increment;
        return { count: 1 };
      },
    },
    materialInventoryMovement: { create: async ({ data }: any) => { movements.push(data); return { id: `mv${movements.length}`, ...data }; } },
  };
  return { tx, material, movements };
}
const base = { shop: "s", materialId: "m1", unit: "sqft", costPerUnit: 0.5, source: "test", reference: null, notes: null } as const;

describe("atomic stock movements", () => {
  it("a deduction decrements atomically and records before / after", async () => {
    const { tx, material, movements } = fakeTx(100);
    const r = await applyStockMovement(tx, { ...base, delta: -30, movementType: "production_deduction" });
    expect(r).toMatchObject({ ok: true, beforeQty: 100, afterQty: 70 });
    expect(material.stockOnHand).toBe(70);
    expect(movements[0]).toMatchObject({ quantity: -30, beforeQty: 100, afterQty: 70, costImpact: 15 });
  });

  it("inventory never goes negative: an over-deduction is refused and changes nothing", async () => {
    const { tx, material, movements } = fakeTx(10);
    const r = await applyStockMovement(tx, { ...base, delta: -11, movementType: "production_deduction" });
    expect(r).toMatchObject({ ok: false, reason: "INSUFFICIENT_STOCK" });
    expect(material.stockOnHand).toBe(10);
    expect(movements).toHaveLength(0);
  });

  it("untracked stock (null) is never deducted, and zero / invalid quantities are refused", async () => {
    const { tx, material } = fakeTx(null);
    expect(await applyStockMovement(tx, { ...base, delta: -1, movementType: "production_deduction" })).toMatchObject({ ok: false, reason: "STOCK_NOT_TRACKED" });
    expect(material.stockOnHand).toBeNull();
    expect(await applyStockMovement(tx, { ...base, delta: 0, movementType: "adjustment" })).toMatchObject({ ok: false, reason: "INVALID_QUANTITY" });
    expect(await applyStockMovement(tx, { ...base, materialId: "nope", delta: 5, movementType: "purchase" })).toMatchObject({ ok: false, reason: "MATERIAL_NOT_FOUND" });
  });

  it("receipts / reversals increment atomically; a reversal's cost impact is negative", async () => {
    const { tx, material, movements } = fakeTx(5);
    expect(await applyStockMovement(tx, { ...base, delta: 20, movementType: "purchase" })).toMatchObject({ ok: true, beforeQty: 5, afterQty: 25 });
    expect(await applyStockMovement(tx, { ...base, delta: 3, movementType: "reversal" })).toMatchObject({ ok: true, afterQty: 28 });
    expect(material.stockOnHand).toBe(28);
    expect(movements[1].costImpact).toBeCloseTo(-1.5, 9);
  });
});

describe("route wiring", () => {
  const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
  const pr = readFileSync("app/routes/app.erp.purchase-requests.tsx", "utf8");

  it("the Production board uses the helper inside transactions for deduct / reverse / adjust; no read-modify-write stock writes remain", () => {
    expect(board.match(/applyStockMovement\(tx,/g)?.length).toBeGreaterThanOrEqual(3);
    expect(board).not.toMatch(/data: \{ stockOnHand: afterQty \}/);
    expect(board).toContain("const removed = await tx.productionMaterialUsage.deleteMany({ where: { shop, id: usage.id, jobId } });"); // replay restores nothing twice
  });

  it("purchase receipts are transactional and replay-safe; only ordered requests can be received", () => {
    expect(pr).toContain("where: { shop, id: purchaseRequest.id, receivedQty: purchaseRequest.receivedQty, status: purchaseRequest.status }");
    expect(pr).toContain('if (!["ordered", "partially_received"].includes(String(purchaseRequest.status)))');
    expect(pr).not.toMatch(/data: \{ stockOnHand: afterQty \}/);
  });

  it("staff create requests; ordering / re-pricing / cancelling needs approvePurchasing (owner / authorized manager); nothing auto-orders", () => {
    expect(pr).toContain('createManual: "createPurchaseRequest"');
    expect(pr).toContain('markOrdered: "approvePurchasing"');
    expect(pr).toContain('markSent: "approvePurchasing"');
    expect(pr).toContain('applyBestCost: "approvePurchasing"');
    expect(pr).toContain('if (approvalNeeded && !staffAccess.can("approvePurchasing"))');
    expect(readFileSync("app/lib/ops/outbox-worker.ts", "utf8")).toContain("send_purchase_order"); // still a forbidden autonomous action
  });
});
