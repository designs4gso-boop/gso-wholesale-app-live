// 2026-11-12 — staged ADDITIVE migration 20261112090000_add_operational_records
// and the reservation accounting it enables (ready after migration).

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { availableStock, planConsumption, planRelease, planReservation, reservationKey, type ReservationRecord } from "../app/lib/inventory-reservation";
// plain .mjs activation script (allowJs resolves it)
import { MODEL_FIELDS, applyOperationalSchema } from "../prisma/migrations-pending/apply-20261112-operational-schema.mjs";

const SQL = readFileSync("prisma/migrations-pending/20261112090000_add_operational_records/migration.sql", "utf8");
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");

describe("staged migration is additive and NOT auto-applied", () => {
  it("lives in migrations-pending, not prisma/migrations (Render's migrate deploy never sees it)", () => {
    expect(readdirSync("prisma/migrations").some((name) => name.includes("operational_records"))).toBe(false);
  });

  it("contains no destructive / converting statements", () => {
    const code = SQL.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN/i);
    expect(code).not.toMatch(/\bTYPE\b/);
  });

  it("every added column is nullable or has a safe default", () => {
    for (const line of SQL.split("\n").filter((l) => /ADD COLUMN/.test(l))) {
      if (/NOT NULL/.test(line)) expect(line, line).toMatch(/DEFAULT/);
    }
  });

  it("the live schema does not declare the new columns yet (client stays compatible before activation)", () => {
    expect(SCHEMA).not.toContain("model InventoryReservation");
    expect(SCHEMA).not.toContain("shipTrackingNumber");
  });

  it("the activation script adds exactly the migrated fields / models and is idempotent", () => {
    const first = applyOperationalSchema(SCHEMA);
    expect(first.changed).toBe(true);
    for (const lines of Object.values(MODEL_FIELDS) as string[][]) for (const line of lines.filter((l) => !l.trim().startsWith("//"))) {
      const name = line.trim().split(/\s+/)[0];
      expect(first.text, name).toContain(line);
      expect(SQL, name).toContain(`"${name}"`);
    }
    expect(first.text).toContain("model InventoryReservation {");
    expect(first.text).toContain("@@unique([shop, idempotencyKey])");
    expect(first.text).toContain("model NotificationPreference {");
    expect(applyOperationalSchema(first.text).changed).toBe(false);
  });

  it("the README documents activation order and rollback", () => {
    const readme = readFileSync("prisma/migrations-pending/README.md", "utf8");
    expect(readme).toContain("20261112090000_add_operational_records");
    expect(readme).toMatch(/Rollback/);
    expect(readme).toContain("apply-20261112-operational-schema.mjs");
  });
});

describe("reservation accounting (pure)", () => {
  const base: ReservationRecord[] = [];

  it("scheduling reserves once per key and never over-commits stock", () => {
    const plan = planReservation({ reservations: base, stockOnHand: 100, jobId: "j1", materialId: "m1", quantity: 60 });
    expect(plan).toMatchObject({ action: "create", record: { idempotencyKey: reservationKey("j1", "m1"), status: "reserved", quantity: 60 } });
    const held: ReservationRecord[] = [{ idempotencyKey: reservationKey("j1", "m1"), jobId: "j1", materialId: "m1", quantity: 60, consumedQty: null, status: "reserved" }];
    expect(planReservation({ reservations: held, stockOnHand: 100, jobId: "j1", materialId: "m1", quantity: 60 }).action).toBe("noop"); // replay
    expect(availableStock(100, held, "m1")).toBe(40);
    expect(planReservation({ reservations: held, stockOnHand: 100, jobId: "j2", materialId: "m1", quantity: 41 })).toMatchObject({ action: "refuse", reason: "INSUFFICIENT_AVAILABLE_STOCK" });
    expect(planReservation({ reservations: held, stockOnHand: null, jobId: "j2", materialId: "m1", quantity: 1 }).action).toBe("refuse"); // untracked stock
    expect(planReservation({ reservations: held, stockOnHand: 100, jobId: "j2", materialId: "m1", quantity: 0 })).toMatchObject({ reason: "INVALID_QUANTITY" });
  });

  it("completion consumes the ACTUAL quantity exactly once; cancellation releases; consumed is never released", () => {
    const r: ReservationRecord = { idempotencyKey: "k", jobId: "j1", materialId: "m1", quantity: 60, consumedQty: null, status: "reserved" };
    expect(planConsumption(r, 57)).toEqual({ action: "consume", idempotencyKey: "k", consumedQty: 57, stockDelta: -57 });
    expect(planConsumption({ ...r, status: "consumed", consumedQty: 57 }, 57).action).toBe("noop");
    expect(planConsumption({ ...r, status: "released" }, 57)).toMatchObject({ action: "refuse", reason: "ALREADY_RELEASED" });
    expect(planRelease(r)).toEqual({ action: "release", idempotencyKey: "k" });
    expect(planRelease({ ...r, status: "released" }).action).toBe("noop");
    expect(planRelease({ ...r, status: "consumed" })).toMatchObject({ action: "refuse", reason: "ALREADY_CONSUMED" });
  });

  it("a reprint reserves only ADDITIONAL issued material under its own key (no double consumption)", () => {
    expect(reservationKey("j1", "m1", 1)).not.toBe(reservationKey("j1", "m1"));
    const held: ReservationRecord[] = [{ idempotencyKey: reservationKey("j1", "m1"), jobId: "j1", materialId: "m1", quantity: 60, consumedQty: 57, status: "consumed" }];
    const reprint = planReservation({ reservations: held, stockOnHand: 43, jobId: "j1", materialId: "m1", quantity: 10, issue: 1 });
    expect(reprint).toMatchObject({ action: "create", record: { idempotencyKey: reservationKey("j1", "m1", 1) } });
  });
});
