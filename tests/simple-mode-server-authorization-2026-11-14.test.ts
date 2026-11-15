// 2026-11-14 GSO ERP SIMPLE MODE — SERVER AUTHORIZATION HARDENING.
//
// Before this change a signed-in account with NO production role (Sales, or an
// account with no ERP role at all) could still: open the Simple Mode board and
// job page, move a job's status (including Complete job), tick checklist items,
// add notes and file links, create / mark-sent a customer proof link, save or
// approve a proof on the proof page, and reschedule from the calendar.
//
// Now every one of those needs an explicit production role, checked on the
// server BEFORE any database call. These tests drive the REAL loaders and
// actions for all six roles: a permitted role succeeds with the unchanged
// behaviour; a forged request from any other role gets 403 (or is turned away
// from the page) and causes not one database call.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", state: null as any, clock: Date.parse("2026-11-14T15:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "staff@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    // recorded only: the creation service has its own suites
    createProductionJobFromSource: async (_db: any, input: any) => { h.state.created.push(input); return { created: false, job: { id: "j1", jobTicket: "GSO-TEST-0001" } }; },
  };
});

vi.mock("../app/db.server", () => {
  const now = () => new Date((h.clock += 1000));
  const READS = ["findFirst", "findMany", "count", "findUnique", "aggregate", "groupBy"];
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const s = h.state;
      s.calls.push(`${name}.${method}`);
      if (!READS.includes(method)) s.writes.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findFirst") return { ...s.job, items: s.items.map((i: any) => ({ ...i })), files: s.files.map((f: any) => ({ ...f })), events: [], checklistItems: [], materialUsages: [] };
        if (method === "findMany") return [{ ...s.job, items: s.items.map((i: any) => ({ ...i })), events: [...s.events].reverse().slice(0, 20), files: s.files.map((f: any) => ({ ...f })), checklistItems: [], materialUsages: [], inventoryMovements: [] }];
        if (method === "update" || method === "updateMany") { Object.assign(s.job, args.data); return { count: 1 }; }
      }
      if (name === "productionJobItem" && method === "findMany") return s.items.map((i: any) => ({ ...i }));
      if (name === "productionJobEvent") {
        if (method === "create") { const row = { ...args.data, createdAt: now() }; s.events.push(row); return row; }
        if (method === "findMany") return s.events.filter((e: any) => !args.where?.eventType?.in || args.where.eventType.in.includes(e.eventType));
      }
      if (name === "productionJobFile") {
        if (method === "findFirst") return s.files.find((f: any) => f.id === args.where?.id) || null;
        if (method === "create") { s.files.push({ id: `f${s.files.length + 1}`, ...args.data }); return {}; }
        if (method === "update") { Object.assign(s.files.find((f: any) => f.id === args.where.id), args.data); return {}; }
      }
      if (name === "productionChecklistItem" && method === "updateMany") { s.checklist.push(args.data); return { count: 1 }; }
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

import { PRODUCTION_FLOOR_ROLES, PRODUCTION_INTENT_ROLES, PRODUCTION_ROLE_DENIED, roleMayRunProductionIntent, roleMayViewProduction, showsProductionControl } from "../app/lib/production-role-access";

const ROLES = { owner: "77055393857", manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", unassigned: "9999" } as const;
type Role = keyof typeof ROLES;
const ALL_ROLES = Object.keys(ROLES) as Role[];
const FLOOR: Role[] = ["owner", "manager", "print_operator", "bagger"];
const LEADS: Role[] = ["owner", "manager", "print_operator"];
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };

const SRC = {
  classic: readFileSync("app/routes/app.erp.production.tsx", "utf8"),
  proof: readFileSync("app/routes/app.erp.production.$id.proof.tsx", "utf8"),
  calendar: readFileSync("app/routes/app.erp.production-calendar.tsx", "utf8"),
  print: readFileSync("app/routes/app.erp.production.$id.print.tsx", "utf8"),
  quotes: readFileSync("app/routes/app.quotes.tsx", "utf8"),
  workspace: readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8"),
};

let classic: any, workspace: any, board: any, proof: any, calendar: any, print: any, quotes: any;
beforeAll(async () => {
  classic = await import("../app/routes/app.erp.production");
  workspace = await import("../app/routes/app.erp.production-job.$id");
  board = await import("../app/routes/app.erp.production-board");
  proof = await import("../app/routes/app.erp.production.$id.proof");
  calendar = await import("../app/routes/app.erp.production-calendar");
  print = await import("../app/routes/app.erp.production.$id.print");
  quotes = await import("../app/routes/app.quotes");
}, 240_000);

const reset = () => {
  h.state = {
    job: { id: "j1", shop: "shop-1", jobTicket: "GSO-TEST-0001", status: "printing", active: true, sourceType: "manual", company: "Test Co", priority: "normal", assignedTo: null, dueDate: null, proofApprovalToken: null, proofStatus: "draft", printedAt: null },
    items: [{ id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-TEST-0001-01", productTitle: "Test item", quantity: 10 }],
    files: [{ id: "f1", shop: "shop-1", jobId: "j1", fileName: "art.pdf", fileType: "artwork", fileUrl: "https://files.test/art.pdf", assetRole: "reference" }],
    events: [] as any[], checklist: [] as any[], calls: [] as string[], writes: [] as string[], created: [] as any[],
  };
};
beforeEach(() => { Object.assign(process.env, ENV); h.sub = ROLES.owner; reset(); });
afterEach(() => { for (const key of [...Object.keys(ENV), "GSO_MANAGER_AUTHORIZED_USER_IDS"]) delete process.env[key]; });

const form = (path: string, fields: Record<string, string>) => new Request(`https://app.test${path}`, { method: "POST", body: new URLSearchParams({ jobId: "j1", ...fields }) });
const read = async (res: Response) => ({ status: res.status, body: await res.json() });
const DOORS: Record<string, (fields: Record<string, string>) => Promise<{ status: number; body: any }>> = {
  workspace: async (fields) => read(await workspace.action({ request: form("/app/erp/production-job/j1", fields) })),
  classic: async (fields) => read(await classic.action({ request: form("/app/erp/production", fields) })),
  proof: async (fields) => read(await proof.action({ request: form("/app/erp/production/j1/proof", fields), params: { id: "j1" } })),
  calendar: async (fields) => read(await calendar.action({ request: form("/app/erp/production-calendar", fields) })),
  quotes: async (fields) => read(await quotes.action({ request: new Request("https://app.test/app/quotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }) })),
};
const touched = () => ({ calls: h.state.calls, writes: h.state.writes, created: h.state.created, events: h.state.events.length, files: h.state.files.length, checklist: h.state.checklist.length, status: h.state.job.status });
const NOTHING = (status = "printing") => ({ calls: [], writes: [], created: [], events: 0, files: 1, checklist: 0, status });
const QC_PASS = { eventType: "qc_result", newValue: "pass", oldValue: "GSO-TEST-0001-01", message: "QC PASS", createdAt: new Date("2026-11-14T10:00:00Z") };

// The owner-approved matrix, written out by hand (not derived from the code under test).
type Row = { door: keyof typeof DOORS; allowed: Role[]; fields: Record<string, string>; before?: () => void; effect: () => void; screen?: string };
const MATRIX: Record<string, Row> = {
  "status change": {
    door: "workspace", allowed: FLOOR, fields: { intent: "changeStatus", status: "cutting" }, screen: "changeStatus",
    effect: () => { expect(h.state.job.status).toBe("cutting"); expect(h.state.events.map((e: any) => e.eventType)).toEqual(["status_change"]); },
  },
  "Complete job": {
    door: "workspace", allowed: FLOOR, fields: { intent: "changeStatus", status: "completed" },
    before: () => { h.state.job.status = "shipped"; h.state.events.push({ ...QC_PASS }); },
    effect: () => { expect(h.state.job.status).toBe("completed"); expect(h.state.job.completedAt).toBeInstanceOf(Date); },
  },
  "cancel job": {
    door: "workspace", allowed: FLOOR, fields: { intent: "changeStatus", status: "cancelled" },
    effect: () => { expect(h.state.job.status).toBe("cancelled"); },
  },
  "checklist tick": {
    door: "workspace", allowed: FLOOR, fields: { intent: "toggleChecklist", checklistId: "c1", completed: "true" }, screen: "toggleChecklist",
    effect: () => { expect(h.state.checklist).toEqual([expect.objectContaining({ completed: true })]); },
  },
  "production note": {
    door: "workspace", allowed: FLOOR, fields: { intent: "addNote", note: "Roll changed at 2pm" }, screen: "addNote",
    effect: () => { expect(h.state.events).toEqual([expect.objectContaining({ eventType: "note", message: "Roll changed at 2pm" })]); },
  },
  "add file link": {
    door: "workspace", allowed: FLOOR, fields: { intent: "addFile", fileUrl: "https://files.test/new.pdf" }, screen: "addFile",
    effect: () => { expect(h.state.files).toHaveLength(2); expect(h.state.files[1].fileUrl).toBe("https://files.test/new.pdf"); },
  },
  "work order printed": {
    door: "workspace", allowed: FLOOR, fields: { intent: "markPrinted" }, screen: "markPrinted",
    effect: () => { expect(h.state.job.printedAt).toBeInstanceOf(Date); },
  },
  "create customer proof link": {
    door: "workspace", allowed: LEADS, fields: { intent: "createProofPortal" }, screen: "createProofPortal",
    effect: () => { expect(String(h.state.job.proofApprovalToken)).toMatch(/^gso_[0-9a-f]{48}$/); },
  },
  "mark proof sent": {
    door: "workspace", allowed: LEADS, fields: { intent: "markProofSent" }, screen: "markProofSent",
    effect: () => { expect(h.state.job).toMatchObject({ status: "proof_sent", proofStatus: "sent" }); },
  },
  "set file role": {
    door: "classic", allowed: LEADS, fields: { intent: "setFileRole", fileId: "f1", assetRole: "proof" },
    effect: () => { expect(h.state.files[0].assetRole).toBe("proof"); },
  },
  "ticket backfill": {
    door: "classic", allowed: ["owner", "manager"], fields: { intent: "backfillTickets" },
    effect: () => { expect(h.state.calls).toContain("productionJob.findMany"); },
  },
  "create job from quote (Production action)": {
    door: "classic", allowed: ["owner", "manager", "sales"], fields: { intent: "createFromQuote", quoteId: "q1" },
    effect: () => { expect(h.state.created).toEqual([expect.objectContaining({ source: { type: "erp_quote", quoteId: "q1" } })]); },
  },
  "proof page: save proof": {
    door: "proof", allowed: LEADS, fields: { intent: "saveProof", revision: "2", proofNotes: "Bleed fixed" },
    effect: () => { expect(h.state.files).toHaveLength(2); expect(h.state.events.map((e: any) => e.eventType)).toEqual(["proof_saved"]); },
  },
  "proof page: approve proof": {
    door: "proof", allowed: LEADS, fields: { intent: "approveProof" },
    before: () => { h.state.job.status = "proof_sent"; },
    effect: () => { expect(h.state.job.status).toBe("proof_approved"); },
  },
  "calendar: update schedule": {
    door: "calendar", allowed: ["owner", "manager"], fields: { intent: "updateSchedule", status: "cutting", priority: "rush", dueDate: "2026-11-20", assignedTo: "Sam" },
    effect: () => { expect(h.state.job).toMatchObject({ status: "cutting", priority: "rush", assignedTo: "Sam" }); },
  },
  "calendar: quick due date": {
    door: "calendar", allowed: ["owner", "manager"], fields: { intent: "quickDueDate", days: "2" },
    effect: () => { expect(h.state.job.dueDate).toBeInstanceOf(Date); },
  },
};

describe("ACTION MATRIX — every hardened action x every role (permitted use and forged request)", () => {
  for (const [name, row] of Object.entries(MATRIX)) {
    for (const role of ALL_ROLES) {
      const allowed = row.allowed.includes(role);
      it(`${name} · ${role} · ${allowed ? "permitted" : "forged request -> 403 before any database call"}`, async () => {
        row.before?.();
        const startStatus = h.state.job.status;
        const seededEvents = h.state.events.length;
        h.sub = ROLES[role];
        const res = await DOORS[row.door](row.fields);
        if (allowed) {
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.ok).toBe(true);
          h.state.events.splice(0, seededEvents);
          row.effect();
        } else {
          expect(res.status).toBe(403);
          expect(res.body.ok).toBe(false);
          expect(res.body.message).toContain(PRODUCTION_ROLE_DENIED);
          h.state.events.splice(0, seededEvents);
          expect(touched()).toEqual(NOTHING(startStatus));
        }
        if (row.screen) expect(showsProductionControl(role, row.screen), "screen agrees with server").toBe(allowed);
      });
    }
  }

  it("the same forged requests are refused through the full Production page's own action too", async () => {
    for (const row of Object.values(MATRIX).filter((r) => r.door === "workspace")) {
      for (const role of ALL_ROLES.filter((r) => !row.allowed.includes(r))) {
        reset();
        h.sub = ROLES[role];
        const res = await DOORS.classic(row.fields);
        expect(res.status, `${row.fields.intent} ${role}`).toBe(403);
        expect(touched(), `${row.fields.intent} ${role}`).toEqual(NOTHING());
      }
    }
  });
});

describe("Quotes page — turning a quote into a production job", () => {
  for (const role of ALL_ROLES) {
    const allowed = ["owner", "manager", "sales"].includes(role);
    it(`${role} · ${allowed ? "permitted" : "forged request -> 403, nothing created"}`, async () => {
      h.sub = ROLES[role];
      const res = await DOORS.quotes({ intent: "createProductionJobFromQuote", quoteId: "q1" });
      if (allowed) {
        expect(res.status).not.toBe(403);
        expect(h.state.created).toEqual([expect.objectContaining({ source: { type: "erp_quote", quoteId: "q1" }, actor: "quotes_page" })]);
      } else {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ ok: false, intent: "createProductionJobFromQuote" });
        expect(touched()).toEqual(NOTHING());
      }
    });
  }
});

describe("UNASSIGNED has zero production mutation capability; SALES keeps exactly one", () => {
  const intentsIn = (src: string) => [...new Set([...src.matchAll(/intent === "([A-Za-z]+)"/g)].map((m) => m[1]))];
  const CLASSIC_INTENTS = intentsIn(SRC.classic);
  const GENERIC = { status: "completed", note: "x", fileUrl: "https://files.test/x.pdf", checklistId: "c1", completed: "true", fileId: "f1", itemId: "i1", quoteId: "q1", materialId: "m1", usedQty: "5", deductInventory: "on", confirmLink: "yes", confirmReopen: "yes", days: "1", carrier: "UPS", trackingNumber: "1Z", qcResult: "pass", requestId: "r1", customerName: "X", itemTitle: "Y", quantity: "1" };

  it("the Production action handles a known, complete list of intents (a new one cannot slip in unreviewed)", () => {
    expect(CLASSIC_INTENTS.sort()).toEqual(["addFile", "addMaterialUsage", "addNote", "adjustInventory", "backfillTickets", "changeStatus", "createFromQuote", "createManualJob", "createProofPortal", "deleteFile", "deleteMaterialUsage", "linkJobToTarget", "markPrinted", "markProofSent", "pullPrintLogActuals", "qcItem", "recordPickup", "recordShipment", "reopenJobCost", "reopenReprint", "reprintItem", "revisionItem", "saveFinalCosts", "setFileRole", "toggleChecklist", "updateJob"].sort());
  });

  it("unassigned: EVERY Production-action intent, plus an invented one, is refused with no database call (both doors)", async () => {
    for (const door of ["workspace", "classic"] as const) {
      for (const intent of [...CLASSIC_INTENTS, "someFutureIntent", ""]) {
        reset();
        h.sub = ROLES.unassigned;
        const res = await DOORS[door]({ ...GENERIC, intent });
        expect(res.status, `${door} ${intent}`).toBe(403);
        expect(touched(), `${door} ${intent}`).toEqual(NOTHING());
      }
    }
  });

  it("unassigned: every proof-page and calendar intent is refused with no database call", async () => {
    for (const [door, src] of [["proof", SRC.proof], ["calendar", SRC.calendar]] as const) {
      const intents = intentsIn(src);
      expect(intents.length).toBeGreaterThanOrEqual(2);
      for (const intent of [...intents, "someFutureIntent"]) {
        reset();
        h.sub = ROLES.unassigned;
        const res = await DOORS[door]({ ...GENERIC, intent });
        expect(res.status, `${door} ${intent}`).toBe(403);
        expect(touched(), `${door} ${intent}`).toEqual(NOTHING());
      }
    }
  });

  it("sales: every Production-action intent except create-from-quote is refused with no database call", async () => {
    for (const intent of CLASSIC_INTENTS.filter((i) => i !== "createFromQuote")) {
      reset();
      h.sub = ROLES.sales;
      const res = await DOORS.workspace({ ...GENERIC, intent });
      expect(res.status, intent).toBe(403);
      expect(touched(), intent).toEqual(NOTHING());
    }
    for (const [door, src] of [["proof", SRC.proof], ["calendar", SRC.calendar]] as const) {
      for (const intent of intentsIn(src)) {
        reset();
        h.sub = ROLES.sales;
        expect((await DOORS[door]({ ...GENERIC, intent })).status, `${door} ${intent}`).toBe(403);
        expect(touched(), `${door} ${intent}`).toEqual(NOTHING());
      }
    }
  });

  it("the rule table gives unassigned nothing and Sales only createFromQuote; unlisted intents need a floor role", () => {
    for (const intent of [...Object.keys(PRODUCTION_INTENT_ROLES), ...CLASSIC_INTENTS, "someFutureIntent", "", "constructor", "toString", "__proto__"]) {
      for (const role of ["unassigned", "", "anything-else", null, undefined]) expect(roleMayRunProductionIntent(role, intent), `${role} ${intent}`).toBe(false);
      expect(roleMayRunProductionIntent("sales", intent), `sales ${intent}`).toBe(intent === "createFromQuote");
    }
    expect([...PRODUCTION_FLOOR_ROLES].sort()).toEqual(["bagger", "manager", "owner", "print_operator"]);
    for (const role of FLOOR) expect(roleMayRunProductionIntent(role, "someFutureIntent")).toBe(true);
  });

  it("each gate sits before the first database call of its action", () => {
    const GATE = "if (!roleMayRunProductionIntent(staffAccess.role, intent)) return Response.json({ ok: false, message: `${PRODUCTION_ROLE_DENIED} ${staffAccess.reason}` }, { status: 403 });";
    for (const [name, src] of [["classic", SRC.classic], ["proof", SRC.proof], ["calendar", SRC.calendar]] as const) {
      const actionStart = src.indexOf("export async function action(");
      const gate = src.indexOf(GATE, actionStart);
      expect(gate, name).toBeGreaterThan(actionStart);
      expect(src.slice(actionStart, gate), name).not.toMatch(/\bdb\.|createEvent\(|\$transaction/);
    }
    const quoteGate = SRC.quotes.indexOf('if (!roleMayRunProductionIntent(quoteStaff.role, "createFromQuote"))');
    expect(quoteGate).toBeGreaterThan(SRC.quotes.indexOf('if (payload.intent === "createProductionJobFromQuote") {'));
    expect(quoteGate).toBeLessThan(SRC.quotes.indexOf("await createProductionJobFromQuoteInQuotes(shop, payload.quoteId)"));
  });
});

describe("PAGE ACCESS — production pages are served to production roles only", () => {
  const open = async (fn: () => Promise<any>) => {
    try { const res = await fn(); return { status: res?.status ?? 200, location: null as string | null }; }
    catch (thrown) { if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location") }; throw thrown; }
  };
  const get = (path: string) => new Request(`https://app.test${path}`);
  const PAGES: Record<string, () => Promise<any>> = {
    "Simple board": () => board.loader({ request: get("/app/erp/production-board") }),
    "Simple job page": () => workspace.loader({ request: get("/app/erp/production-job/j1"), params: { id: "j1" } }),
    "Proof page": () => proof.loader({ request: get("/app/erp/production/j1/proof"), params: { id: "j1" } }),
    "Production calendar": () => calendar.loader({ request: get("/app/erp/production-calendar") }),
  };

  for (const [name, load] of Object.entries(PAGES)) {
    for (const role of ALL_ROLES) {
      const allowed = FLOOR.includes(role);
      it(`${name} · ${role} · ${allowed ? "opens" : "turned away to Home before any job is read"}`, async () => {
        h.sub = ROLES[role];
        const res = await open(load);
        if (allowed) {
          expect(res.status).toBe(200);
          expect(h.state.calls.length).toBeGreaterThan(0);
        } else {
          expect(res).toEqual({ status: 302, location: "/app" });
          expect(h.state.calls).toEqual([]);
        }
        expect(roleMayViewProduction(role)).toBe(allowed);
      });
    }
  }

  it("work order page and the full Production page turn Sales / unassigned away before any job is read", async () => {
    for (const role of ["sales", "unassigned"] as Role[]) {
      for (const load of [
        () => print.loader({ request: get("/app/erp/production/j1/print"), params: { id: "j1" } }),
        () => classic.loader({ request: get("/app/erp/production") }),
        () => classic.loader({ request: get("/app/erp/production?job=j1") }),
      ]) {
        reset();
        h.sub = ROLES[role];
        expect(await open(load), role).toEqual({ status: 302, location: "/app" });
        expect(h.state.calls, role).toEqual([]);
      }
    }
  });

  it("the page check precedes the first query in every production loader", () => {
    const CHECK = "if (!roleMayViewProduction(resolveStaffAccess(auth).role)) throw redirect(PRODUCTION_VIEW_DENIED_REDIRECT);";
    for (const [name, src] of [["classic", SRC.classic], ["proof", SRC.proof], ["calendar", SRC.calendar], ["print", SRC.print]] as const) {
      const loaderStart = src.indexOf("export async function loader(");
      const check = src.indexOf(CHECK, loaderStart);
      expect(check, name).toBeGreaterThan(loaderStart);
      expect(src.slice(loaderStart, check), name).not.toMatch(/\bdb\./);
    }
  });

  it("Simple Mode shows the customer-proof controls only to roles the server allows", () => {
    expect(SRC.workspace).toContain('{key === "artwork" && showsProductionControl(role, "createProofPortal") ? <CustomerProof job={job} /> : null}');
    expect(showsProductionControl("bagger", "createProofPortal")).toBe(false);
    expect(showsProductionControl("print_operator", "markProofSent")).toBe(true);
  });
});
