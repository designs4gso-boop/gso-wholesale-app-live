// 2026-11-14 LIVE QA — shipment details "disappeared" after refresh.
//
// Live (GSO-20260814-0001, internal test job): Save shipment moved the job to
// Shipped, but after a refresh the Record shipment form was blank. Root cause:
// the action DID write status + shipCarrier / shipTrackingNumber /
// shipPackageCount / shippedAt in one UPDATE, and the loader returned them, but
// the page never read them — the form was a blank uncontrolled form (it only
// looked filled right after save because the browser kept the typed values) and
// no saved-shipment summary existed. Also the shipped / tracking_added audit
// events were written AFTER the update, outside any transaction.
//
// Fix: the job update and both audit events are one transaction; the page
// shows a read-only SHIPMENT RECORDED summary from the loader
// (savedShipmentForJob) instead of the blank form once a shipment is saved.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", state: null as any, clock: Date.parse("2026-11-14T15:00:00Z"), failEvent: null as string | null, failJobWrite: false, raceOnce: null as any }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "owner@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const now = () => new Date((h.clock += 1000));
  const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : a === b);
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return true;
    if (value && typeof value === "object" && !(value instanceof Date) && "in" in value) return value.in.includes(row[key]);
    return same(row[key], value ?? null);
  });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const s = h.state;
      if (!["findFirst", "findMany", "count", "findUnique"].includes(method)) s.writes.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findFirst") return matches(s.job, args.where) ? { ...s.job, items: s.items.map((i: any) => ({ ...i })) } : null;
        if (method === "findMany") return [{ ...s.job, items: s.items.map((i: any) => ({ ...i })), events: [...s.events].reverse().slice(0, 20).map((e: any) => ({ ...e })), files: [], checklistItems: [], materialUsages: [], inventoryMovements: [] }];
        if (method === "update") { Object.assign(s.job, args.data); return { ...s.job }; }
        if (method === "updateMany") {
          if (h.failJobWrite) throw new Error("simulated shipment column write failure");
          if (h.raceOnce) { Object.assign(s.job, h.raceOnce); h.raceOnce = null; } // another request committed first
          if (!matches(s.job, args.where)) return { count: 0 };
          Object.assign(s.job, args.data);
          return { count: 1 };
        }
      }
      if (name === "productionJobItem") {
        if (method === "findMany") return s.items.filter((i: any) => matches(i, args.where));
        if (method === "updateMany") {
          const rows = s.items.filter((i: any) => matches(i, args.where));
          rows.forEach((i: any) => Object.assign(i, args.data));
          return { count: rows.length };
        }
      }
      if (name === "productionJobEvent") {
        if (method === "create") {
          if (h.failEvent && args.data.eventType === h.failEvent) throw new Error(`simulated ${h.failEvent} event failure`);
          const row = { ...args.data, createdAt: now() };
          s.events.push(row);
          return row;
        }
        if (method === "findMany") return s.events.filter((e: any) => matches(e, { shop: args.where?.shop, jobId: args.where?.jobId }) && (!args.where?.eventType?.in || args.where.eventType.in.includes(e.eventType)));
      }
      if (name === "inventoryReservation" || name === "materialInventoryMovement" || (name === "material" && method !== "findMany")) s.inventoryTouches.push(`${name}.${method}`);
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => key === "$transaction"
      ? async (fn: any) => {
          if (typeof fn !== "function") return Promise.all(fn);
          h.state.transactions += 1;
          const snapshot = structuredClone({ job: h.state.job, items: h.state.items, events: h.state.events });
          try { return await fn(db); } catch (error) { Object.assign(h.state, snapshot); throw error; } // rollback
        }
      : model(key),
  });
  return { default: db, db };
});

const OWNER = "77055393857";
const BAGGER = "1004";
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: OWNER, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const SRC = readFileSync("app/routes/app.erp.production.tsx", "utf8");

let route: any;
beforeAll(async () => { route = await import("../app/routes/app.erp.production"); }, 180_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = OWNER;
  h.failEvent = null;
  h.failJobWrite = false;
  h.raceOnce = null;
  // Synthetic stand-in for the internal QA job (no real customer data).
  h.state = {
    job: { id: "j1", shop: "shop-1", jobTicket: "GSO-20260814-0001", status: "qc", completedAt: null, active: true, actualCostFinalized: false, sourceType: "shopify", actualShippingCost: null, shippedAt: null, shipCarrier: null, shipTrackingNumber: null, shipPackageCount: null, pickedUpAt: null, pickedUpBy: null },
    items: [
      { id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-20260814-0001-01", productTitle: "Test item A", quantity: 1, qcResult: null, qcBy: null, qcAt: null, qcNote: null, lastReprintReason: null, lastReprintBy: null, lastReprintAt: null },
      { id: "i2", shop: "shop-1", jobId: "j1", itemTicket: "GSO-20260814-0001-02", productTitle: "Test item B", quantity: 1, qcResult: null, qcBy: null, qcAt: null, qcNote: null, lastReprintReason: null, lastReprintBy: null, lastReprintAt: null },
    ],
    events: [] as any[], writes: [] as string[], inventoryTouches: [] as string[], transactions: 0,
  };
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const post = async (fields: Record<string, string>) => {
  const res: Response = await route.action({ request: new Request("https://app.test/app/erp/production", { method: "POST", body: new URLSearchParams({ jobId: "j1", ...fields }) }) });
  return { status: res.status, body: await res.json() };
};
const passQc = async () => {
  for (const itemId of ["i1", "i2"]) expect((await post({ intent: "qcItem", itemId, qcResult: "pass", qcNote: "QA pass" })).body.ok).toBe(true);
};
const QA_SHIPMENT = { intent: "recordShipment", carrier: "TEST - Migration QA", trackingNumber: "TEST-SHIP-1012", packageCount: "1", shipDate: "2026-11-14", actualShippingCost: "" };
const ship = (overrides: Record<string, string> = {}) => post({ ...QA_SHIPMENT, ...overrides });
const load = async () => {
  // 2026-11-14: /app/erp/production itself now redirects non-financial staff to Simple Mode; staff reach this SAME loader through the Simple Mode routes, so the reload is made the way staff make it.
  const raw: any = await route.loader({ request: new Request("https://app.test/app/erp/production-board") });
  return raw instanceof Response ? raw.json() : raw;
};
const eventsOf = (type: string) => h.state.events.filter((e: any) => e.eventType === type);

import { formatShipDate, savedShipmentForJob } from "../app/lib/production-fulfillment";

describe("Save shipment through the real production action", () => {
  it("1-6. writes carrier, tracking, packages, shippedAt, null cost when blank, and status Shipped", async () => {
    await passQc();
    const res = await ship();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const job = h.state.job;
    expect(job.shipCarrier).toBe("TEST - Migration QA");
    expect(job.shipTrackingNumber).toBe("TEST-SHIP-1012");
    expect(job.shipPackageCount).toBe(1);
    expect(job.shippedAt).toBeInstanceOf(Date);
    expect(job.shippedAt.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(job.actualShippingCost).toBeNull();
    expect(job.status).toBe("shipped");
    expect(JSON.parse(eventsOf("shipped")[0].newValue)).toMatchObject({ carrier: "TEST - Migration QA", trackingNumber: "TEST-SHIP-1012", packageCount: 1, shipDate: "2026-11-14", actualShippingCost: null });
    expect(eventsOf("shipped")[0].createdBy).toBe("owner@gso.test");
    expect(eventsOf("tracking_added")).toHaveLength(1);
  });

  it("5b. an entered shipping cost is stored exactly as entered", async () => {
    await passQc();
    await ship({ actualShippingCost: "12.5" });
    expect(h.state.job.actualShippingCost).toBe(12.5);
  });

  it("7. the job update and both audit events run inside ONE transaction", async () => {
    await passQc();
    const before = h.state.transactions;
    await ship();
    expect(h.state.transactions).toBe(before + 1);
    const block = SRC.slice(SRC.indexOf('if (intent === "recordShipment") {'), SRC.indexOf("const parsed = parsePickupInput("));
    const tx = block.slice(block.indexOf("await db.$transaction(async (tx: any) => {"), block.indexOf("if (!shippedNow)"));
    expect(tx).toContain("tx.productionJob.updateMany(");
    expect(tx).toContain('tx.productionJobEvent.create({ data: { shop, jobId, eventType: "shipped"');
    expect(tx).toContain('tx.productionJobEvent.create({ data: { shop, jobId, eventType: "tracking_added"');
    expect(block).not.toContain("createEvent(");
    expect(block).not.toContain("db.productionJob.updateMany(");
  });

  it("8. reload: the loader returns the saved shipment fields", async () => {
    await passQc();
    await ship();
    const data: any = await load();
    expect(data.jobs[0]).toMatchObject({ status: "shipped", shipCarrier: "TEST - Migration QA", shipTrackingNumber: "TEST-SHIP-1012", shipPackageCount: 1 });
    expect(new Date(data.jobs[0].shippedAt).toISOString()).toBe("2026-11-14T12:00:00.000Z");
  }, 120_000);

  it("9. after refresh the page renders SHIPMENT RECORDED from the loader, not a blank form", async () => {
    await passQc();
    await ship();
    const data: any = await load();
    const saved = savedShipmentForJob(data.jobs[0], data.jobs[0].events);
    expect(saved).toMatchObject({ carrier: "TEST - Migration QA", trackingNumber: "TEST-SHIP-1012", packageCount: 1, shipDate: "2026-11-14", actualShippingCost: null, recordedBy: "owner@gso.test", source: "structured" });
    expect(saved?.recordedAt).toBeTruthy();
    expect(formatShipDate(saved!.shipDate)).toBe("11/14/2026");
    expect(SRC).toContain("const savedShipment = savedShipmentForJob(job, job.events || []);");
    expect(SRC).toContain("{savedShipment ? (");
    expect(SRC).toContain("SHIPMENT RECORDED</Text>");
    for (const line of ["Carrier: {savedShipment.carrier}", "Tracking: {savedShipment.trackingNumber", "Packages: {savedShipment.packageCount", "Ship date: {formatShipDate(savedShipment.shipDate)}", "Recorded by: {savedShipment.recordedBy", "Recorded at: {savedShipment.recordedAt"]) expect(SRC).toContain(line);
  }, 120_000);

  it("10-11. a replayed submission creates no second record/event and changes no saved metadata", async () => {
    await passQc();
    await ship();
    const snapshot = structuredClone({ job: h.state.job, events: h.state.events.length });
    const replay = await ship({ carrier: "UPS", trackingNumber: "OTHER", packageCount: "3", shipDate: "2026-11-20" });
    expect(replay.status).toBe(400);
    expect(replay.body.ok).toBe(false);
    expect(replay.body.message).toContain("SHIPMENT ALREADY RECORDED: TEST - Migration QA, tracking TEST-SHIP-1012, 1 package(s), ship date 11/14/2026");
    expect(h.state.job).toEqual(snapshot.job);
    expect(h.state.events).toHaveLength(snapshot.events);
    expect(eventsOf("shipped")).toHaveLength(1);
  });

  it("10b. a concurrent duplicate (job shipped by another request after the read) matches no row and records nothing", async () => {
    await passQc();
    const events = h.state.events.length;
    const other = { status: "shipped", shipCarrier: "FedEx", shipTrackingNumber: "FIRST", shipPackageCount: 2, shippedAt: new Date("2026-11-13T12:00:00Z") };
    h.raceOnce = other;
    const res = await ship();
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("SHIPMENT ALREADY RECORDED");
    expect(h.state.job).toMatchObject(other); // the first request's record is untouched
    expect(h.state.events).toHaveLength(events);
    expect(SRC).toContain("where: { shop, id: jobId, status: job.status },");
  });

  it("12. a failed audit-event write rolls back status and shipment columns (never Shipped without the record)", async () => {
    await passQc();
    const events = h.state.events.length;
    h.failEvent = "shipped";
    await expect(ship()).rejects.toThrow("simulated shipped event failure");
    expect(h.state.job).toMatchObject({ status: "qc", shipCarrier: null, shipTrackingNumber: null, shipPackageCount: null, shippedAt: null });
    expect(h.state.events).toHaveLength(events);
    h.failEvent = "tracking_added";
    await expect(ship()).rejects.toThrow();
    expect(h.state.job.status).toBe("qc");
    expect(h.state.job.shipCarrier).toBeNull();
    expect(h.state.events).toHaveLength(events);
  });

  it("12b. a failed shipment-column write leaves the job un-shipped", async () => {
    await passQc();
    h.failJobWrite = true;
    await expect(ship()).rejects.toThrow("simulated shipment column write failure");
    expect(h.state.job.status).toBe("qc");
    expect(eventsOf("shipped")).toHaveLength(0);
  });
});

describe("old / legacy jobs", () => {
  it("13. a job with no structured shipment fields loads safely and shows the form", async () => {
    const data: any = await load();
    expect(data.jobs[0].shipCarrier).toBeNull();
    expect(savedShipmentForJob(data.jobs[0], data.jobs[0].events)).toBeNull();
    expect(savedShipmentForJob({}, [])).toBeNull();
    expect(savedShipmentForJob(null, undefined as any)).toBeNull();
  }, 120_000);

  it("13b. a pre-migration shipment (event only, no columns) is still shown from the event JSON", () => {
    const legacyEvent = { eventType: "shipped", createdBy: "op@gso.test", createdAt: new Date("2026-11-11T18:00:00Z"), newValue: JSON.stringify({ carrier: "UPS", trackingNumber: "1Z999", packageCount: 2, shipDate: "2026-11-11", actualShippingCost: 9.5 }) };
    expect(savedShipmentForJob({ status: "shipped", shipCarrier: null }, [legacyEvent])).toEqual({ carrier: "UPS", trackingNumber: "1Z999", packageCount: 2, shipDate: "2026-11-11", actualShippingCost: 9.5, recordedBy: "op@gso.test", recordedAt: "2026-11-11T18:00:00.000Z", source: "event" });
    expect(savedShipmentForJob({}, [{ eventType: "shipped", newValue: "not json" }])).toBeNull();
  });

  it("13c. structured columns win over an older event", () => {
    const old = { eventType: "shipped", createdAt: new Date("2026-11-11T18:00:00Z"), newValue: JSON.stringify({ carrier: "UPS", packageCount: 2, shipDate: "2026-11-11" }) };
    const saved = savedShipmentForJob({ shipCarrier: "FedEx", shipTrackingNumber: null, shipPackageCount: 4, shippedAt: "2026-11-13T12:00:00.000Z" }, [old]);
    expect(saved).toMatchObject({ carrier: "FedEx", trackingNumber: null, packageCount: 4, shipDate: "2026-11-13", source: "structured" });
  });
});

describe("unchanged behaviour", () => {
  it("14. pickup still records picked_up with its own fields and never touches shipment columns", async () => {
    await passQc();
    const res = await post({ intent: "recordPickup", pickedUpBy: "Customer A", pickupNote: "" });
    expect(res.body.ok).toBe(true);
    expect(h.state.job.status).toBe("picked_up");
    expect(h.state.job.pickedUpBy).toBe("Customer A");
    expect(h.state.job.pickedUpAt).toBeInstanceOf(Date);
    expect(h.state.job).toMatchObject({ shipCarrier: null, shipTrackingNumber: null, shipPackageCount: null, shippedAt: null });
    expect(eventsOf("picked_up")).toHaveLength(1);
    expect((await post({ intent: "recordPickup", pickedUpBy: "Again" })).status).toBe(400);
    expect(eventsOf("picked_up")).toHaveLength(1);
  });

  it("15. completion still needs QC PASS and a shipment / pickup", async () => {
    const noQc = await ship();
    expect(noQc.status).toBe(400);
    expect(h.state.job.status).toBe("qc");
    await passQc();
    const early = await post({ intent: "changeStatus", status: "completed" });
    expect(early.status).toBe(400);
    expect(early.body.message).toContain("COMPLETION REQUIRES SHIPMENT OR PICKUP");
    const bare = await post({ intent: "changeStatus", status: "shipped" });
    expect(bare.status).toBe(400);
    expect(h.state.job.shipCarrier).toBeNull();
    await ship();
    const done = await post({ intent: "changeStatus", status: "completed" });
    expect(done.body.ok).toBe(true);
    expect(h.state.job.status).toBe("completed");
    expect(h.state.job.shipCarrier).toBe("TEST - Migration QA"); // completion keeps the shipment record
  });

  it("16. non-financial staff see the shipment but no shipping cost", async () => {
    await passQc();
    await ship({ actualShippingCost: "12.50" });
    h.sub = BAGGER;
    const staff: any = await load();
    expect(staff.showFinancials).toBe(false);
    expect(staff.jobs[0]).toMatchObject({ shipCarrier: "TEST - Migration QA", shipTrackingNumber: "TEST-SHIP-1012", shipPackageCount: 1, actualShippingCost: null });
    const staffView = savedShipmentForJob(staff.jobs[0], staff.jobs[0].events);
    expect(staffView).toMatchObject({ carrier: "TEST - Migration QA", trackingNumber: "TEST-SHIP-1012", packageCount: 1, actualShippingCost: null });
    expect(JSON.stringify(staff.jobs[0])).not.toContain("12.5");
    expect(SRC).toContain("{showFinancials ? <Text as=\"p\">Actual shipping cost:");
    h.sub = OWNER;
    const owner: any = await load();
    expect(savedShipmentForJob(owner.jobs[0], owner.jobs[0].events)?.actualShippingCost).toBe(12.5);
  }, 120_000);

  it("17. only the synthetic job is touched; no inventory, Shopify or other records are written", async () => {
    await passQc();
    h.state.writes = [];
    await ship();
    expect(new Set(h.state.writes)).toEqual(new Set(["productionJob.updateMany", "productionJobEvent.create"]));
    expect(h.state.inventoryTouches).toEqual([]);
    const block = SRC.slice(SRC.indexOf('if (intent === "recordShipment") {'), SRC.indexOf("const parsed = parsePickupInput("));
    expect(block).not.toMatch(/admin\.graphql|reserveInventory|consumeReservation|applyStockMovement/);
  });

  it("no new migration; the shipment columns already exist", async () => {
    const { readdirSync } = await import("node:fs");
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
    // 2026-11-19: the owner-approved ADDITIVE lineage migration (file -> item link, production runs, reorder lineage, staged transactions) is now the newest.
    expect(names[names.length - 1]).toBe("20261119120000_add_production_lineage");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    for (const field of ["shippedAt", "shipCarrier", "shipTrackingNumber", "shipPackageCount"]) expect(schema).toContain(`  ${field}`);
  });
});
