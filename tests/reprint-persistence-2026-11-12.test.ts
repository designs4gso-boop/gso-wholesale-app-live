// 2026-11-12 LIVE QA — reprint persistence + CURRENT QC reset.
//
// Live: after QC PASS then Reprint (machine error), the lower QC summary still
// said "QC result recorded: PASS" and showed no reprint. The summary read only
// production_run_qc_* events (a reprint writes production_reprint_requested +
// a qc_result reset), never the structured item columns. Reprint recording is
// now one transaction that persists lastReprint*, clears the current QC and
// keeps every earlier event; the summary shows CURRENT QC STATUS and MOST
// RECENT REPRINT per item from the structured columns.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", state: null as any, clock: Date.parse("2026-11-12T15:00:00Z") }));

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
      if (name === "productionJob") {
        if (method === "findFirst") return matches(s.job, args.where) ? { ...s.job, items: s.items.map((i: any) => ({ ...i })) } : null;
        if (method === "findMany") return [{ ...s.job, items: s.items.map((i: any) => ({ ...i })), events: [...s.events].reverse().slice(0, 20), files: [], checklistItems: [], materialUsages: [], inventoryMovements: [] }];
        if (method === "update" || method === "updateMany") { Object.assign(s.job, args.data); s.jobWrites.push(args.data); return { count: 1 }; }
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
        if (method === "create") { const row = { ...args.data, createdAt: now() }; s.events.push(row); return row; }
        if (method === "findMany") return s.events.filter((e: any) => matches(e, { shop: args.where?.shop, jobId: args.where?.jobId }) && (!args.where?.eventType?.in || args.where.eventType.in.includes(e.eventType)));
      }
      if (name === "printIntake") {
        if (method === "findFirst") return s.intake ? { ...s.intake } : null;
        if (method === "update") { s.intakeWrites.push(args.data); return {}; }
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
          const snapshot = structuredClone({ items: h.state.items, events: h.state.events, intakeWrites: h.state.intakeWrites });
          try { return await fn(db); } catch (error) { Object.assign(h.state, snapshot); throw error; } // rollback
        }
      : model(key),
  });
  return { default: db, db };
});

const OWNER = "77055393857";
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: OWNER, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const TICKET = "GSO-20261107-0001-01";

let route: any;
beforeAll(async () => { route = await import("../app/routes/app.erp.production"); }, 180_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = OWNER;
  h.state = {
    job: { id: "j1", shop: "shop-1", jobTicket: "GSO-20261107-0001", status: "qc", completedAt: null, active: true, actualCostFinalized: false, sourceType: "print_intake" },
    items: [{ id: "i1", shop: "shop-1", jobId: "j1", itemTicket: TICKET, productTitle: "PRINT INTAKE — Neon Horror Glow Print Test Sheet", quantity: 1, qcResult: null, qcBy: null, qcAt: null, qcNote: null, lastReprintReason: null, lastReprintBy: null, lastReprintAt: null }],
    events: [] as any[], jobWrites: [] as any[], intakeWrites: [] as any[], inventoryTouches: [] as string[],
    intake: { id: "pi1", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, routedFilename: `${TICKET}.pdf`, rawParsedHints: null },
  };
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const post = async (fields: Record<string, string>) => {
  const res: Response = await route.action({ request: new Request("https://app.test/app/erp/production", { method: "POST", body: new URLSearchParams({ jobId: "j1", itemId: "i1", ...fields }) }) });
  return { status: res.status, body: await res.json() };
};
const qc = (result: string, note = "") => post({ intent: "qcItem", qcResult: result, qcNote: note });
const reprint = (reason = "machine_error", note = "Migration smoke test - reprint") => post({ intent: "reprintItem", reprintReason: reason, reprintNote: note });
const item = () => h.state.items[0];

import { QC_REQUIRED_AFTER_REPRINT, itemQcState, itemReprintSummary } from "../app/lib/production-qc-display";

describe("reprint persistence through the real production action", () => {
  it("1. QC PASS persists on the item", async () => {
    expect((await qc("pass", "Migration smoke test - QC pass")).body.ok).toBe(true);
    expect(item()).toMatchObject({ qcResult: "pass", qcBy: "owner@gso.test", qcNote: "Migration smoke test - QC pass" });
    expect(item().qcAt).toBeInstanceOf(Date);
  });

  it("2-3. a valid reprint persists reason, user and time", async () => {
    await qc("pass");
    const res = await reprint();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain("REPRINT RECORDED");
    expect(res.body.message).toContain("Machine error");
    expect(item()).toMatchObject({ lastReprintReason: "machine_error", lastReprintBy: "owner@gso.test" });
    expect(item().lastReprintAt).toBeInstanceOf(Date);
    expect(h.state.intakeWrites).toHaveLength(1); // re-routed as P1
  });

  it("4. earlier QC history is preserved (nothing deleted; reprint + reset events appended)", async () => {
    await qc("pass", "first pass");
    const before = h.state.events.map((e: any) => e.eventType);
    await reprint();
    const after = h.state.events.map((e: any) => e.eventType);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before).toEqual(["production_run_qc_passed", "qc_result"]);
    expect(after.slice(before.length)).toEqual(["production_reprint_requested", "qc_result"]);
    expect(h.state.events.find((e: any) => e.eventType === "production_reprint_requested").message).toContain("Note: Migration smoke test - reprint");
  });

  it("5. the CURRENT QC state is reset (a new PASS is required)", async () => {
    await qc("pass", "first pass");
    await reprint();
    expect(item()).toMatchObject({ qcResult: null, qcBy: null, qcAt: null, qcNote: null });
    expect(itemQcState(item(), h.state.events)).toMatchObject({ status: "pending_reprint", label: QC_REQUIRED_AFTER_REPRINT });
  });

  it("6. reload: the loader returns the persisted reprint fields (also to non-financial staff)", async () => {
    await qc("pass");
    await reprint();
    for (const sub of [OWNER, "1004"]) {
      h.sub = sub;
      const raw: any = await route.loader({ request: new Request("https://app.test/app/erp/production") });
      const data: any = raw instanceof Response ? await raw.json() : raw;
      const loaded = data.jobs[0].items[0];
      expect(loaded).toMatchObject({ lastReprintReason: "machine_error", lastReprintBy: "owner@gso.test", qcResult: null });
      expect(loaded.lastReprintAt).toBeTruthy();
    }
  }, 120_000);

  it("9-10. completion is blocked after a reprint until a NEW QC PASS, which restores eligibility", async () => {
    await qc("pass");
    h.state.job.status = "shipped";
    await reprint();
    const blocked = await post({ intent: "changeStatus", status: "completed" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain("QC PASS REQUIRED BEFORE COMPLETION");
    expect(h.state.job.status).toBe("shipped");
    await qc("pass", "reprinted piece OK");
    expect(itemQcState(item(), h.state.events).status).toBe("pass");
    const done = await post({ intent: "changeStatus", status: "completed" });
    expect(done.body.ok).toBe(true);
    expect(h.state.job.status).toBe("completed");
  });

  it("11. an invalid reprint reason is rejected and nothing is written", async () => {
    await qc("pass");
    const res = await reprint("because");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(item()).toMatchObject({ qcResult: "pass", lastReprintReason: null });
  });

  it("12. roles without recordReprint are rejected (Sales, Bagger, unassigned); authorization unchanged", async () => {
    for (const sub of ["1002", "1004", "9999"]) {
      h.sub = sub;
      const res = await reprint();
      expect(res.status, sub).toBe(403);
    }
    expect(item().lastReprintReason).toBeNull();
    for (const sub of ["1001", "1003"]) { // manager, print operator
      h.sub = sub;
      h.state.items[0].lastReprintAt = null;
      expect((await reprint()).body.ok, sub).toBe(true);
    }
  });

  it("13. a replayed reprint (no QC in between) changes nothing; a concurrent duplicate rolls back", async () => {
    await qc("pass");
    await reprint();
    const snapshot = structuredClone({ item: item(), events: h.state.events.length, intake: h.state.intakeWrites.length });
    const replay = await reprint();
    expect(replay.status).toBe(409);
    expect(replay.body.message).toContain("waiting for QC");
    expect(item()).toEqual(snapshot.item);
    expect(h.state.events).toHaveLength(snapshot.events);
    expect(h.state.intakeWrites).toHaveLength(snapshot.intake);
    // after a new QC result a further reprint is a real new run
    await qc("reprint_required");
    expect((await reprint("color_quality_issue")).body.ok).toBe(true);
    expect(item().lastReprintReason).toBe("color_quality_issue");
    expect(h.state.intakeWrites).toHaveLength(2);
  });

  it("13b. the item claim is conditional on the lastReprintAt that was read", () => {
    const src = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(src).toContain("where: { shop, id: item.id, lastReprintAt: item.lastReprintAt ?? null },");
    expect(src).toContain("if (!claimed.count) throw new Error(REPRINT_ALREADY_RECORDED);");
  });

  it("14. recording a reprint never reserves or consumes inventory", async () => {
    await qc("pass");
    await reprint();
    expect(h.state.inventoryTouches).toEqual([]);
    const src = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    const block = src.slice(src.indexOf('if (intent === "reprintItem")'), src.indexOf('if (intent === "revisionItem")'));
    expect(block).not.toMatch(/reserveInventory|consumeReservation|applyStockMovement/);
  });
});

describe("7-8. the lower QC summary", () => {
  const SRC = readFileSync("app/routes/app.erp.production.tsx", "utf8");
  const reprinted = { itemTicket: TICKET, qcResult: null, qcBy: null, qcAt: null, lastReprintReason: "machine_error", lastReprintBy: "owner@gso.test", lastReprintAt: new Date("2026-11-12T16:00:00Z") };

  it("7. shows MOST RECENT REPRINT reason / user / time", () => {
    expect(itemReprintSummary(reprinted)).toEqual({ reason: "Machine error", reasonCode: "machine_error", by: "owner@gso.test", at: "2026-11-12T16:00:00.000Z" });
    expect(SRC).toContain("<b>MOST RECENT REPRINT:</b> REPRINT RECORDED — Reason: {reprint.reason} · Recorded by: {reprint.by || \"staff\"} · Recorded at:");
    expect(SRC).toContain("reprint: itemReprintSummary(item)");
  });

  it("8. a stale PASS is never shown as CURRENT QC STATUS after a reprint", () => {
    // the earlier PASS event is still in history, the structured state wins
    const events = [{ eventType: "production_run_qc_passed", oldValue: TICKET, newValue: "pass", createdAt: new Date("2026-11-12T15:00:00Z"), createdBy: "owner@gso.test" }];
    expect(itemQcState(reprinted, events)).toMatchObject({ status: "pending_reprint", label: QC_REQUIRED_AFTER_REPRINT });
    expect(itemQcState({ ...reprinted, qcResult: "pass", qcBy: "op", qcAt: new Date("2026-11-12T17:00:00Z") }, events)).toMatchObject({ status: "pass", by: "op" });
    // pre-migration items fall back to events, including the reprint reset
    const legacy = [...events, { eventType: "qc_result", oldValue: TICKET, newValue: "reprint_required", message: `QC reset by reprint request for ${TICKET} (run P1-A1).`, createdAt: new Date("2026-11-12T15:05:00Z") }];
    expect(itemQcState({ itemTicket: TICKET }, legacy).status).toBe("pending_reprint");
    expect(SRC).toContain("<b>CURRENT QC STATUS:</b>");
    expect(SRC).not.toContain("<b>QC result recorded:</b>");
    expect(SRC).not.toMatch(/qcEvents\[0\]/);
  });
});

describe("15. schema / migration unchanged", () => {
  it("no new migration; the reprint / QC columns already exist", async () => {
    const { readdirSync } = await import("node:fs");
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names[names.length - 1]).toBe("20261112090000_add_operational_records");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    for (const field of ["qcResult", "qcBy", "qcAt", "qcNote", "lastReprintReason", "lastReprintBy", "lastReprintAt"]) expect(schema).toContain(`  ${field}`);
  });
});
