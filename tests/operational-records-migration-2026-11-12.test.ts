// 2026-11-12 — ACTIVATED additive migration 20261112090000_add_operational_records,
// the reservation accounting it enables and the structured operational records
// wired onto the existing production / purchasing actions.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { availableStock, planConsumption, planRelease, planReservation, reservationKey, type ReservationRecord } from "../app/lib/inventory-reservation";
import { consumeReservation, releaseJobReservations, reserveInventory } from "../app/lib/inventory-reservation.server";
import { REPRINT_REASONS, isReprintReason, statusChangeFulfillmentVerdict } from "../app/lib/production-fulfillment";
import { evaluateQcForCompletion } from "../app/lib/production-qc-guard";
import { redactJobFinancials } from "../app/lib/production-financial-redaction";
import { CUSTOMER_NOTIFICATION_CHANNELS, CUSTOMER_NOTIFICATION_EVENTS, planCustomerNotification } from "../app/lib/customer-notification-events";
import { MANAGER_AUTHORIZED_ENV, STAFF_ROLES_ENV, resolveStaffAccess } from "../app/lib/staff-roles.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
// plain .mjs activation script (allowJs resolves it)
import { MODEL_FIELDS, applyOperationalSchema } from "../prisma/migrations-pending/apply-20261112-operational-schema.mjs";

const MIGRATION_DIR = "prisma/migrations/20261112090000_add_operational_records";
const SQL = readFileSync(`${MIGRATION_DIR}/migration.sql`, "utf8");
const SQL_CODE = SQL.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");
const PRODUCTION = readFileSync("app/routes/app.erp.production.tsx", "utf8");
const PURCHASING = readFileSync("app/routes/app.erp.purchase-requests.tsx", "utf8");

const addedColumns = () => [...SQL_CODE.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "(\w+)" ([^;]+);/g)].map((m) => ({ table: m[1], column: m[2], def: m[3] }));
const modelBlock = (name: string) => {
  const start = SCHEMA.indexOf(`model ${name} {`);
  return SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
};
const fieldLine = (model: string, field: string) => modelBlock(model).split("\n").find((line) => line.trim().split(/\s+/)[0] === field);

/* In-memory Prisma transaction double: unique (shop, idempotencyKey), conditional updateMany. */
function fakeDb(stockOnHand: number | null) {
  const state = { material: { id: "m1", shop: "s", stockOnHand }, reservations: [] as any[], movements: [] as any[] };
  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((w) => matches(row, w));
    if (value && typeof value === "object" && "gte" in value) return Number(row[key]) >= value.gte;
    return row[key] === value;
  });
  const tx: any = {
    material: {
      findFirst: async ({ where }: any) => (matches(state.material, where) ? { ...state.material } : null),
      updateMany: async ({ where, data }: any) => {
        if (!matches(state.material, where)) return { count: 0 };
        if (data.stockOnHand?.decrement != null) state.material.stockOnHand = Number(state.material.stockOnHand) - data.stockOnHand.decrement;
        if (data.stockOnHand?.increment != null) state.material.stockOnHand = Number(state.material.stockOnHand) + data.stockOnHand.increment;
        return { count: 1 };
      },
    },
    inventoryReservation: {
      findMany: async ({ where }: any) => state.reservations.filter((r) => matches(r, where)),
      findFirst: async ({ where }: any) => state.reservations.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: any) => {
        if (state.reservations.some((r) => r.shop === data.shop && r.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { consumedQty: null, ...data };
        state.reservations.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.reservations.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    materialInventoryMovement: { create: async ({ data }: any) => { state.movements.push(data); return { id: `mv${state.movements.length}` }; } },
  };
  return { tx, state };
}

describe("1-3, 22. migration is ACTIVE, additive and needs no backfill", () => {
  it("lives in prisma/migrations (Render's migrate deploy applies it) and no longer in migrations-pending", () => {
    expect(readdirSync("prisma/migrations")).toContain("20261112090000_add_operational_records");
    expect(readdirSync("prisma/migrations-pending")).not.toContain("20261112090000_add_operational_records");
    // it sorts after every earlier migration, so the chain stays linear
    const earlier = readdirSync("prisma/migrations").filter((name) => /^\d/.test(name) && name !== "20261112090000_add_operational_records");
    expect(earlier.length).toBeGreaterThan(0);
    for (const name of earlier) expect(name < "20261112090000_add_operational_records", name).toBe(true);
  });

  it("1. contains no destructive / converting / data-rewriting statement", () => {
    expect(SQL_CODE).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
    expect(SQL_CODE).not.toMatch(/ALTER\s+COLUMN/i);
    expect(SQL_CODE).not.toMatch(/\bTYPE\b/);
    expect(SQL_CODE).not.toMatch(/FOREIGN KEY|REFERENCES/i); // no constraint on existing rows
    for (const statement of SQL_CODE.split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(statement, statement).toMatch(/^(ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/);
    }
  });

  it("2-3. every added column is nullable or has a constant default — existing rows stay valid with no backfill", () => {
    const columns = addedColumns();
    expect(columns).toHaveLength(30);
    for (const { table, column, def } of columns) {
      if (/NOT NULL/.test(def)) expect(def, `${table}.${column}`).toMatch(/DEFAULT (false|0|'[^']*')/);
      const line = fieldLine(table, column);
      expect(line, `${table}.${column} in schema.prisma`).toBeTruthy();
      expect(line!, `${table}.${column}`).toMatch(/\?|@default/);
    }
    // the only unique indexes are on the two NEW (empty) tables
    for (const unique of SQL_CODE.match(/CREATE UNIQUE INDEX[^;]+/g) ?? []) expect(unique).toMatch(/ON "(InventoryReservation|NotificationPreference)"/);
  });

  it("22. schema.prisma declares exactly the migrated structure (activation script is idempotent)", () => {
    expect(applyOperationalSchema(SCHEMA).changed).toBe(false);
    const declared = new Set<string>();
    for (const [model, lines] of Object.entries(MODEL_FIELDS) as [string, string[]][]) {
      for (const line of lines.filter((l) => !l.trim().startsWith("//"))) {
        const name = line.trim().split(/\s+/)[0];
        declared.add(`${model}.${name}`);
        expect(fieldLine(model, name), `${model}.${name}`).toBeTruthy();
      }
    }
    expect(new Set(addedColumns().map((c) => `${c.table}.${c.column}`))).toEqual(declared);
    for (const model of ["InventoryReservation", "NotificationPreference"]) {
      expect(SCHEMA).toContain(`model ${model} {`);
      expect(SQL_CODE).toContain(`CREATE TABLE IF NOT EXISTS "${model}"`);
    }
    expect(modelBlock("InventoryReservation")).toContain("@@unique([shop, idempotencyKey])");
    expect(modelBlock("NotificationPreference")).toContain("@@unique([shop, recipientKey, eventType, channel])");
  });
});

describe("4-10. inventory reservation accounting (pure planners + transactional executors)", () => {
  it("4-5. reservation creation is idempotent: a duplicate scheduling submission is a no-op", async () => {
    const { tx, state } = fakeDb(100);
    const first = await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    const replay = await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    expect(first.action).toBe("create");
    expect(replay.action).toBe("noop");
    expect(state.reservations).toHaveLength(1);
    expect(state.material.stockOnHand).toBe(100); // reserving never moves stock
  });

  it("5. a concurrent duplicate that slips past the read is stopped by the unique index", async () => {
    const { tx, state } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 10, unit: "sqft" });
    const blind = { ...tx, inventoryReservation: { ...tx.inventoryReservation, findMany: async () => [] } };
    expect((await reserveInventory(blind, { shop: "s", jobId: "j1", materialId: "m1", quantity: 10, unit: "sqft" })).action).toBe("noop");
    expect(state.reservations).toHaveLength(1);
  });

  it("6. a reservation can never over-commit stock (or reserve untracked stock)", async () => {
    const { tx } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    expect(await reserveInventory(tx, { shop: "s", jobId: "j2", materialId: "m1", quantity: 41, unit: "sqft" })).toMatchObject({ action: "refuse", reason: "INSUFFICIENT_AVAILABLE_STOCK" });
    expect((await reserveInventory(tx, { shop: "s", jobId: "j2", materialId: "m1", quantity: 40, unit: "sqft" })).action).toBe("create");
    expect(await reserveInventory(fakeDb(null).tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 1, unit: "sqft" })).toMatchObject({ reason: "INSUFFICIENT_AVAILABLE_STOCK" });
    const held: ReservationRecord[] = [{ idempotencyKey: "k", jobId: "j1", materialId: "m1", quantity: 60, consumedQty: null, status: "reserved" }];
    expect(availableStock(100, held, "m1")).toBe(40);
  });

  it("7. cancellation releases the job's active reservations exactly once; consumed stock is never released", async () => {
    const { tx, state } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 30, unit: "sqft" });
    expect(await releaseJobReservations(tx, { shop: "s", jobId: "j1" })).toEqual({ released: 1 });
    expect(await releaseJobReservations(tx, { shop: "s", jobId: "j1" })).toEqual({ released: 0 }); // replay
    expect(state.reservations[0].status).toBe("released");
    expect(state.material.stockOnHand).toBe(100);
    expect(planRelease({ idempotencyKey: "k", jobId: "j1", materialId: "m1", quantity: 1, consumedQty: 1, status: "consumed" })).toMatchObject({ action: "refuse", reason: "ALREADY_CONSUMED" });
    // wired: the status change to cancelled releases in the same transaction as the update
    expect(PRODUCTION).toContain('return status === "cancelled" ? releaseJobReservations(tx, { shop, jobId }) : { released: 0 };');
  });

  it("8. completion consumes the ACTUAL quantity exactly once", async () => {
    const { tx, state } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    const key = reservationKey("j1", "m1");
    expect(await consumeReservation(tx, { shop: "s", idempotencyKey: key, actualQty: 57, costPerUnit: 1 })).toMatchObject({ action: "consume", consumedQty: 57 });
    expect((await consumeReservation(tx, { shop: "s", idempotencyKey: key, actualQty: 57, costPerUnit: 1 })).action).toBe("noop");
    expect(state.material.stockOnHand).toBe(43);
    expect(state.movements).toHaveLength(1);
    expect(state.reservations[0]).toMatchObject({ status: "consumed", consumedQty: 57 });
    expect(planConsumption({ ...state.reservations[0], status: "released" }, 1)).toMatchObject({ reason: "ALREADY_RELEASED" });
  });

  it("9. a reprint reserves / consumes only the ADDITIONAL issued material under its own key", async () => {
    const { tx, state } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    await consumeReservation(tx, { shop: "s", idempotencyKey: reservationKey("j1", "m1"), actualQty: 57, costPerUnit: 1 });
    expect((await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 10, unit: "sqft", issue: 1 })).action).toBe("create");
    await consumeReservation(tx, { shop: "s", idempotencyKey: reservationKey("j1", "m1", 1), actualQty: 8, costPerUnit: 1 });
    expect(state.material.stockOnHand).toBe(35); // 100 - 57 - 8: the original is never consumed twice
    expect(planReservation({ reservations: [], stockOnHand: 10, jobId: "j", materialId: "m", quantity: 0 })).toMatchObject({ reason: "INVALID_QUANTITY" });
  });

  it("10. inventory can never go negative: a short consume rolls back and the hold stays reserved", async () => {
    const { tx, state } = fakeDb(100);
    await reserveInventory(tx, { shop: "s", jobId: "j1", materialId: "m1", quantity: 60, unit: "sqft" });
    state.material.stockOnHand = 5; // a manual count correction happened after scheduling
    await expect(consumeReservation(tx, { shop: "s", idempotencyKey: reservationKey("j1", "m1"), actualQty: 57, costPerUnit: 1 })).rejects.toThrow(/never goes negative/);
    expect(state.material.stockOnHand).toBe(5);
    expect(state.movements).toHaveLength(0);
  });
});

describe("11-15. structured QC / reprint / shipment records keep the existing guards", () => {
  const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
  const ENV = { [OWNER_USER_IDS_ENV]: "1", [STAFF_ROLES_ENV]: "2:manager,3:print_operator,4:bagger,5:sales,6:manager", [MANAGER_AUTHORIZED_ENV]: "6" };

  it("11. structured QC accepts Owner / Manager / Print Operator / Bagger only, and is written on the item", () => {
    for (const sub of ["1", "2", "3", "4"]) expect(resolveStaffAccess(as(sub), ENV).can("recordQc"), sub).toBe(true);
    for (const sub of ["5", "999"]) expect(resolveStaffAccess(as(sub), ENV).can("recordQc"), sub).toBe(false);
    expect(PRODUCTION).toContain('qcItem: "recordQc"');
    expect(PRODUCTION).toContain("data: { qcResult: result, qcBy: actor, qcAt: new Date(), qcNote: note || null }");
    // failed QC never completes: the guard still reads the latest QC result per item
    expect(evaluateQcForCompletion([{ id: "i1", itemTicket: "T1" }], [{ eventType: "qc_result", oldValue: "T1", newValue: "reprint_required" }]).ok).toBe(false);
  });

  it("12. the reprint reason is validated on the server before the structured record is written", () => {
    expect(REPRINT_REASONS.map((r) => r.value)).toEqual(["machine_error", "operator_error", "artwork_prepress_error", "customer_change_error", "material_defect", "color_quality_issue", "shipping_damage", "other"]);
    expect(isReprintReason("because")).toBe(false);
    const validated = PRODUCTION.indexOf("if (!isReprintReason(reasonCode))");
    const written = PRODUCTION.indexOf("lastReprintReason: reasonCode, lastReprintBy: actor");
    expect(validated).toBeGreaterThan(0);
    expect(written).toBeGreaterThan(validated);
  });

  it("13. shipment / pickup columns are written by a conditional update, so a replay records nothing twice", () => {
    expect(PRODUCTION).toContain("where: { shop, id: jobId, status: job.status },");
    expect(PRODUCTION).toMatch(/shipCarrier: record\.carrier,\s+shipTrackingNumber: record\.trackingNumber,\s+shipPackageCount: record\.packageCount,/);
    expect(PRODUCTION).toContain("pickedUpAt: new Date(parsed.record.pickedUpAt), pickedUpBy: parsed.record.pickedUpBy");
    expect(PRODUCTION).toContain('if (["cancelled", "shipped", "picked_up"].includes(String(job.status)))');
  });

  it("14. Completed still requires Shipped or Picked Up", () => {
    expect(statusChangeFulfillmentVerdict("packing", "completed").ok).toBe(false);
    expect(statusChangeFulfillmentVerdict("shipped", "completed").ok).toBe(true);
    expect(statusChangeFulfillmentVerdict("picked_up", "completed").ok).toBe(true);
  });

  it("15. purchasing approval stays Owner / authorized Manager only; the approver is recorded", () => {
    expect(resolveStaffAccess(as("1"), ENV).can("approvePurchasing")).toBe(true);
    expect(resolveStaffAccess(as("6"), ENV).can("approvePurchasing")).toBe(true);
    for (const sub of ["2", "3", "4", "5"]) expect(resolveStaffAccess(as(sub), ENV).can("approvePurchasing"), sub).toBe(false);
    for (const intent of ["markOrdered", "markSent", "cancelRequest", "applyBestCost"]) expect(PURCHASING).toContain(`${intent}: "approvePurchasing"`);
    expect(PURCHASING.match(/requestedBy: staffAccess\.actor/g)).toHaveLength(2);
    expect(PURCHASING.match(/approvedBy: staffAccess\.actor, approvedAt: new Date\(\)/g)!.length).toBe(4);
    expect(PURCHASING).not.toMatch(/sendPurchaseOrder|send_purchase_order|fetch\(/); // no automatic vendor ordering
  });
});

describe("16-21. financial redaction, actual cost, rush and notifications", () => {
  it("16-17. non-financial staff never receive quoted / actual cost or variance", () => {
    const job = { id: "j", quotedTrueCost: 120, actualTotalCost: 130, actualVarianceAmount: 10, actualVariancePct: 8.3, shipCarrier: "UPS", items: [] };
    const redacted = redactJobFinancials(job);
    expect(redacted).toMatchObject({ quotedTrueCost: null, actualTotalCost: null, actualVarianceAmount: null, actualVariancePct: null, shipCarrier: "UPS" });
    const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
    const ENV = { [OWNER_USER_IDS_ENV]: "1", [STAFF_ROLES_ENV]: "3:print_operator,4:bagger,5:sales" };
    for (const sub of ["3", "4", "5"]) expect(resolveStaffAccess(as(sub), ENV).can("viewFinancials"), sub).toBe(false);
    expect(PRODUCTION).toContain("jobs: financials.show ? jobsWithActuals : jobsWithActuals.map(redactJobFinancials)");
  });

  it("18-19. the quoted cost snapshot is immutable; actual cost and variance are stored separately", () => {
    const save = PRODUCTION.slice(PRODUCTION.indexOf('if (intent === "saveFinalCosts")'), PRODUCTION.indexOf('if (intent === "reopenJobCost")'));
    expect(save).toContain("quotedTrueCost: job.quotedTrueCost ?? (assessment.estimatedTotalCost > 0 ? assessment.estimatedTotalCost : null)");
    expect(save).toContain("actualVarianceAmount: assessment.estimatedTotalCost > 0 ? assessment.varianceDollars : null");
    expect(save).not.toMatch(/productionJobItem\.update|quoteItem\.update|costSnapshot:/); // quote history is never rewritten
  });

  it("20. rush fields carry no fee and no promised turnaround", () => {
    expect(SQL_CODE).not.toMatch(/fee|surcharge/i);
    expect(SCHEMA).not.toMatch(/rush(Fee|Surcharge|Price)/i);
    const appSources = ["app/lib/quote-pricing-authority.ts", "app/lib/quote-margin.server.ts", "app/lib/canonical-calculator.server.ts"].map((p) => readFileSync(p, "utf8")).join("\n");
    expect(appSources).not.toContain("rushRequested");
  });

  it("21. notification preferences send nothing: no provider, every plan is send=false", () => {
    for (const event of CUSTOMER_NOTIFICATION_EVENTS) for (const channel of CUSTOMER_NOTIFICATION_CHANNELS) {
      expect(planCustomerNotification(event.key, channel, true).send).toBe(false);
    }
    expect(planCustomerNotification("shipped", "email", true, { email: "provider", sms: null }).send).toBe(false);
    expect(modelBlock("NotificationPreference")).toContain("enabled      Boolean  @default(false)");
  });
});
