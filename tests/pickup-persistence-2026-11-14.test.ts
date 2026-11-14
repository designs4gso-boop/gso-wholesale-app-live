// 2026-11-14 LIVE QA — customer pickup details "disappeared" after refresh.
//
// Live (GSO-20260626-0004, internal test job, status New): Save pickup (now)
// with "Migration QA" / "Pickup persistence smoke test", then refresh — the
// pickup form was blank. Same shape as the shipment bug (9a67b55): the action
// writes status + pickedUpAt + pickedUpBy in one conditional UPDATE and the
// loader returns them, but the page always rendered a blank uncontrolled form
// and never showed a saved pickup. The picked_up audit event (the ONLY place
// the pickup note is stored — there is no note column) was written after the
// update, outside any transaction. NOTE: from New, QC PASS on every item is
// required first; without it the action refuses and nothing is saved.
//
// Fix: job update + picked_up event are one transaction; the page shows a
// read-only CUSTOMER PICKUP RECORDED summary (savedPickupForJob) instead of the
// blank form once a pickup is saved.

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

import { savedPickupForJob, savedShipmentForJob } from "../app/lib/production-fulfillment";

const QA_PICKUP = { intent: "recordPickup", pickedUpBy: "Migration QA", pickupNote: "Pickup persistence smoke test" };
const pickup = (overrides: Record<string, string> = {}) => post({ ...QA_PICKUP, ...overrides });
const fromNew = () => { h.state.job.status = "new"; };

describe("Save pickup through the real production action", () => {
  it("1-4. writes pickedUpAt, pickedUpBy, keeps the note in the event, status Picked Up", async () => {
    fromNew();
    await passQc();
    const res = await pickup();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(h.state.job.status).toBe("picked_up");
    expect(h.state.job.pickedUpAt).toBeInstanceOf(Date);
    expect(h.state.job.pickedUpBy).toBe("Migration QA");
    const events = eventsOf("picked_up");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].newValue)).toMatchObject({ pickedUpBy: "Migration QA", note: "Pickup persistence smoke test" });
    expect(JSON.parse(events[0].newValue).pickedUpAt).toBe(h.state.job.pickedUpAt.toISOString());
    expect(events[0]).toMatchObject({ oldValue: "new", createdBy: "owner@gso.test" });
    // no note column exists — the event is the designed home of the note
    expect(readFileSync("prisma/schema.prisma", "utf8")).not.toMatch(/pickupNote|pickedUpNote/);
  });

  it("5. the job update and the audit event run inside ONE transaction", async () => {
    fromNew();
    await passQc();
    const before = h.state.transactions;
    await pickup();
    expect(h.state.transactions).toBe(before + 1);
    const block = SRC.slice(SRC.indexOf("const parsed = parsePickupInput("), SRC.indexOf('if (intent === "updateJob")'));
    const tx = block.slice(block.indexOf("await db.$transaction(async (tx: any) => {"), block.indexOf("if (!pickedUpNow)"));
    expect(tx).toContain("tx.productionJob.updateMany(");
    expect(tx).toContain('tx.productionJobEvent.create({ data: { shop, jobId, eventType: "picked_up"');
    expect(block).not.toContain("createEvent(");
    expect(block).not.toContain("db.productionJob.updateMany(");
  });

  it("6. a failed audit-event write rolls back pickup fields and status", async () => {
    fromNew();
    await passQc();
    const events = h.state.events.length;
    h.failEvent = "picked_up";
    await expect(pickup()).rejects.toThrow("simulated picked_up event failure");
    expect(h.state.job).toMatchObject({ status: "new", pickedUpAt: null, pickedUpBy: null });
    expect(h.state.events).toHaveLength(events);
  });

  it("7. a failed structured-field write leaves nothing saved", async () => {
    fromNew();
    await passQc();
    h.failJobWrite = true;
    await expect(pickup()).rejects.toThrow("simulated shipment column write failure");
    expect(h.state.job).toMatchObject({ status: "new", pickedUpAt: null, pickedUpBy: null });
    expect(eventsOf("picked_up")).toHaveLength(0);
  });

  it("8. reload: the loader returns the saved pickup fields", async () => {
    fromNew();
    await passQc();
    await pickup();
    const data: any = await load();
    expect(data.jobs[0]).toMatchObject({ status: "picked_up", pickedUpBy: "Migration QA" });
    expect(new Date(data.jobs[0].pickedUpAt).toISOString()).toBe(h.state.job.pickedUpAt.toISOString());
  }, 120_000);

  it("9-10. after refresh the page shows CUSTOMER PICKUP RECORDED, not a blank form", async () => {
    fromNew();
    await passQc();
    await pickup();
    const data: any = await load();
    const saved = savedPickupForJob(data.jobs[0], data.jobs[0].events);
    expect(saved).toMatchObject({ pickedUpBy: "Migration QA", note: "Pickup persistence smoke test", recordedBy: "owner@gso.test", source: "structured" });
    expect(saved?.pickedUpAt).toBe(h.state.job.pickedUpAt.toISOString());
    expect(saved?.recordedAt).toBeTruthy();
    expect(SRC).toContain("const savedPickup = savedPickupForJob(job, job.events || []);");
    expect(SRC).toContain("{savedPickup ? (");
    expect(SRC).toContain("CUSTOMER PICKUP RECORDED</Text>");
    for (const line of ["Picked up by: {savedPickup.pickedUpBy", "Pickup date/time: {savedPickup.pickedUpAt", "Note: {savedPickup.note}", "Recorded by: {savedPickup.recordedBy", "Recorded at: {savedPickup.recordedAt"]) expect(SRC).toContain(line);
    // the blank form sits in the else-branch of the saved-pickup check
    const ui = SRC.slice(SRC.indexOf("{savedPickup ? ("), SRC.indexOf('name="pickupNote"'));
    expect(ui).toContain(") : (");
    expect(ui).toContain('value="recordPickup"');
  }, 120_000);

  it("11-12. a replayed pickup creates no event and never overwrites pickedUpAt / pickedUpBy", async () => {
    fromNew();
    await passQc();
    await pickup();
    const snapshot = structuredClone({ job: h.state.job, events: h.state.events.length });
    const replay = await pickup({ pickedUpBy: "Someone else", pickupNote: "second" });
    expect(replay.status).toBe(400);
    expect(replay.body.message).toContain("CUSTOMER PICKUP ALREADY RECORDED");
    expect(replay.body.message).toContain("by Migration QA");
    expect(h.state.job).toEqual(snapshot.job);
    expect(h.state.events).toHaveLength(snapshot.events);
    expect(eventsOf("picked_up")).toHaveLength(1);
  });

  it("11b. a simultaneous duplicate (picked up by another request after the read) records nothing", async () => {
    fromNew();
    await passQc();
    const events = h.state.events.length;
    const other = { status: "picked_up", pickedUpAt: new Date("2026-11-14T10:00:00Z"), pickedUpBy: "First request" };
    h.raceOnce = other;
    const res = await pickup();
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("CUSTOMER PICKUP ALREADY RECORDED");
    expect(h.state.job).toMatchObject(other);
    expect(h.state.events).toHaveLength(events);
  });
});

describe("old / legacy jobs", () => {
  it("13. pre-migration pickup-event-only jobs display from the event; jobs without a pickup load safely", async () => {
    const legacy = { eventType: "picked_up", createdBy: "op@gso.test", createdAt: new Date("2026-11-11T19:00:00Z"), newValue: JSON.stringify({ pickedUpAt: "2026-11-11T18:55:00.000Z", pickedUpBy: "Customer A", note: "counter pickup" }) };
    expect(savedPickupForJob({ status: "picked_up", pickedUpAt: null }, [legacy])).toEqual({ pickedUpAt: "2026-11-11T18:55:00.000Z", pickedUpBy: "Customer A", note: "counter pickup", recordedBy: "op@gso.test", recordedAt: "2026-11-11T19:00:00.000Z", source: "event" });
    expect(savedPickupForJob({}, [{ eventType: "picked_up", newValue: "not json" }])).toBeNull();
    expect(savedPickupForJob(null, undefined as any)).toBeNull();
    const data: any = await load();
    expect(data.jobs[0].pickedUpAt).toBeNull();
    expect(savedPickupForJob(data.jobs[0], data.jobs[0].events)).toBeNull();
  }, 120_000);
});

describe("unchanged behaviour", () => {
  it("14. shipment (9a67b55) still records and displays; a shipped job refuses pickup", async () => {
    await passQc();
    expect((await post({ intent: "recordShipment", carrier: "TEST - Migration QA", trackingNumber: "TEST-SHIP-1012", packageCount: "1", shipDate: "2026-11-14", actualShippingCost: "" })).body.ok).toBe(true);
    expect(savedShipmentForJob(h.state.job, h.state.events)).toMatchObject({ carrier: "TEST - Migration QA", source: "structured" });
    const refused = await pickup();
    expect(refused.status).toBe(400);
    expect(h.state.job).toMatchObject({ status: "shipped", pickedUpAt: null, pickedUpBy: null });
    expect(eventsOf("picked_up")).toHaveLength(0);
  });

  it("15-16. QC PASS is still required before pickup; completion needs pickup + QC PASS", async () => {
    fromNew();
    const noQc = await pickup();
    expect(noQc.status).toBe(400);
    expect(noQc.body.message).toContain("QC PASS");
    expect(h.state.job).toMatchObject({ status: "new", pickedUpAt: null, pickedUpBy: null });
    expect(eventsOf("picked_up")).toHaveLength(0);
    await passQc();
    const early = await post({ intent: "changeStatus", status: "completed" });
    expect(early.status).toBe(400);
    expect(early.body.message).toContain("COMPLETION REQUIRES SHIPMENT OR PICKUP");
    expect((await post({ intent: "changeStatus", status: "picked_up" })).status).toBe(400); // bare status change refused
    await pickup();
    const done = await post({ intent: "changeStatus", status: "completed" });
    expect(done.body.ok).toBe(true);
    expect(h.state.job.status).toBe("completed");
    expect(h.state.job.pickedUpBy).toBe("Migration QA");
  });

  it("17. financial redaction unchanged: staff get the pickup, never money", async () => {
    fromNew();
    await passQc();
    h.state.job.actualShippingCost = 7.25;
    await pickup();
    h.sub = BAGGER;
    const staff: any = await load();
    expect(staff.showFinancials).toBe(false);
    expect(staff.jobs[0]).toMatchObject({ pickedUpBy: "Migration QA", actualShippingCost: null });
    expect(savedPickupForJob(staff.jobs[0], staff.jobs[0].events)).toMatchObject({ pickedUpBy: "Migration QA", note: "Pickup persistence smoke test" });
    expect(JSON.stringify(staff.jobs[0])).not.toContain("7.25");
  }, 120_000);

  it("only the synthetic job is touched; no inventory or Shopify writes; no migration", async () => {
    fromNew();
    await passQc();
    h.state.writes = [];
    await pickup();
    expect(new Set(h.state.writes)).toEqual(new Set(["productionJob.updateMany", "productionJobEvent.create"]));
    expect(h.state.inventoryTouches).toEqual([]);
    const { readdirSync } = await import("node:fs");
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names[names.length - 1]).toBe("20261112090000_add_operational_records");
  });
});
