// 2026-11-14 GSO ERP SIMPLE MODE — Phase 1 + Phase 2 foundation.
//
// Role-aware navigation, employee wording, the 6-stage board mapping, the
// NEXT STEP line, the slim board payload and the Job Workspace. The workspace
// and board add no production logic: they reuse the Production page's loader
// and action, so these tests drive the REAL action through the workspace route
// and check that guards, permissions and redaction behave exactly as before.

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
  const raw: any = await route.loader({ request: new Request("https://app.test/app/erp/production") });
  return raw instanceof Response ? raw.json() : raw;
};
const eventsOf = (type: string) => h.state.events.filter((e: any) => e.eventType === type);

import { friendlyMessage } from "../app/lib/employee-messages";
import { PRODUCTION_STATUS_OPTIONS } from "../app/lib/production-status-vocabulary";
import { navForRole } from "../app/lib/simple-nav";
import { ATTENTION_STATUSES, HIDDEN_STATUSES, ROLE_STAGE_FOCUS, SIMPLE_STAGES, buildSimpleBoard, checklistByStep, jobWorkspaceView, simpleStageForStatus, toBoardCard } from "../app/lib/simple-production";

let board: any;
let workspace: any;
beforeAll(async () => {
  board = await import("../app/routes/app.erp.production-board");
  workspace = await import("../app/routes/app.erp.production-job.$id");
}, 180_000);

const json = async (raw: any) => (raw instanceof Response ? raw.json() : raw);
const loadBoard = async () => json(await board.loader({ request: new Request("https://app.test/app/erp/production-board") }));
const loadJob = async (id = "j1") => json(await workspace.loader({ request: new Request(`https://app.test/app/erp/production-job/${id}`), params: { id } }));
const postJob = async (fields: Record<string, string>) => {
  const res: Response = await workspace.action({ request: new Request("https://app.test/app/erp/production-job/j1", { method: "POST", body: new URLSearchParams({ jobId: "j1", ...fields }) }) });
  return { status: res.status, body: await res.json() };
};
const withMoney = () => {
  Object.assign(h.state.job, { company: "Acme Labels", priority: "rush", assignedTo: "Sam", dueDate: new Date("2026-11-10T12:00:00Z"), quotedTrueCost: 4205.68, actualTotalCost: 4311.11, actualShippingCost: 77.77, actualFinalProfit: 3999.99 });
  h.state.items.forEach((item: any) => Object.assign(item, { unitPrice: 2.15, unitCost: 1.0952, machineSummary: "Roland LG-640" }));
};

describe("Phase 1A — role-aware navigation (display only)", () => {
  const labels = (role: string, viewFinancials = false) => navForRole(role, { viewFinancials }).map((section) => section.label);
  const hrefs = (role: string, viewFinancials = false) => navForRole(role, { viewFinancials }).flatMap((section) => [section.href, ...section.links.map((link) => link.href)]);

  it("each role sees only its areas", () => {
    expect(labels("owner")).toEqual(["Home", "Sales", "Production", "Inventory", "Purchasing", "Admin"]);
    expect(labels("manager")).toEqual(["Home", "Sales", "Production", "Inventory", "Purchasing", "Admin"]);
    expect(labels("sales")).toEqual(["Home", "Sales"]);
    expect(labels("print_operator")).toEqual(["Home", "Production", "Inventory", "Request Material"]);
    expect(labels("bagger")).toEqual(["Home", "Production", "Inventory", "Request Material"]);
    expect(labels("unassigned")).toEqual(["Home"]);
  });

  it("no role's nav has more than six areas, and labels are plain words", () => {
    for (const role of ["owner", "manager", "sales", "print_operator", "bagger", "unassigned"]) {
      const nav = navForRole(role, { viewFinancials: true });
      expect(nav.length, role).toBeLessThanOrEqual(6);
      for (const section of nav) expect(section.label).not.toMatch(/·|_/);
    }
  });

  it("pricing, cost, setup and audit pages are listed for the owner only", () => {
    const ownerOnly = ["/app/erp/cost-calculator", "/app/erp/pricing-settings", "/app/erp/pricing-intelligence", "/app/erp/margin-review", "/app/erp/cost-verification", "/app/erp/product-setup", "/app/erp/vendor-cost-book", "/app/erp/materials", "/app/erp/owner-readiness", "/app#advanced"];
    for (const href of ownerOnly) expect(hrefs("owner"), href).toContain(href);
    for (const role of ["manager", "sales", "print_operator", "bagger", "unassigned"]) {
      for (const href of ownerOnly) expect(hrefs(role, true), `${role} ${href}`).not.toContain(href);
    }
  });

  it("shop-floor roles get the simple board, redacted stock levels and a request-material entry — no sales pages", () => {
    for (const role of ["print_operator", "bagger"]) {
      expect(hrefs(role)).toContain("/app/erp/production-board");
      expect(hrefs(role)).toContain("/app/erp/reorder-report");
      expect(hrefs(role)).toContain("/app/erp/purchase-requests");
      expect(hrefs(role)).not.toContain("/app/quotes");
    }
    expect(hrefs("sales")).not.toContain("/app/erp/production-board");
  });

  it("a manager is shown Reports only when financially authorized", () => {
    expect(hrefs("manager", false)).not.toContain("/app/erp/reports-dashboard");
    expect(hrefs("manager", true)).toContain("/app/erp/reports-dashboard");
  });

  it("the shell resolves the role for display only; server permission code is untouched", () => {
    const shell = readFileSync("app/routes/app.tsx", "utf8");
    expect(shell).toContain("const staff = resolveStaffAccess(auth);");
    expect(shell).toContain("role: staff.role,");
    const roles = readFileSync("app/lib/staff-roles.server.ts", "utf8");
    expect(roles).toContain('sales: ["createPurchaseRequest", "sendQuote"],');
    expect(roles).toContain('bagger: ["createPurchaseRequest", "recordQc", "recordShipment"],');
  });
});

describe("Phase 1B — employee wording (presentation only)", () => {
  it("maps the owner-approved phrases and keeps the original as detail", () => {
    const cases: [string, string][] = [
      ["PRICING AUTHORITY REQUIRED — family floor", "Owner approval needed"],
      ["AUTO_MACHINE_LOAD_UNAVAILABLE", "Select Mimaki or Roland"],
      ["MIMAKI_GLOSS_UNSUPPORTED", "Gloss needs the Roland"],
      ["WHITE_COVERAGE_REQUIRED", "Enter how much of the design is white"],
      ["QC PASS REQUIRED BEFORE COMPLETION — no QC result for: A", "Record QC PASS on every item first"],
      ["SHIPMENT / PICKUP RECORD REQUIRED — use Record shipment", "Record the shipment or pickup first"],
      ["COMPLETION REQUIRES SHIPMENT OR PICKUP — owner rule", "Ship or hand over the job before completing it"],
      ["DTP MANUAL REVIEW REQUIRED — MULTI-DESIGN JOB", "Owner review needed before offering DTP"],
      ["BELOW FAMILY FLOOR", "Price is too low — owner approval needed"],
      ["FAMILY MARGIN RULE NOT CONFIGURED", "Pricing isn't set up for this product — ask the owner"],
    ];
    for (const [raw, primary] of cases) expect(friendlyMessage(raw)).toEqual({ primary, detail: raw });
  });

  it("plain messages pass through unchanged; empty stays empty", () => {
    expect(friendlyMessage("Checklist updated.")).toEqual({ primary: "Checklist updated.", detail: null });
    expect(friendlyMessage(null)).toEqual({ primary: "", detail: null });
  });

  it("the server still returns the original guard messages (semantics unchanged)", async () => {
    const early = await postJob({ intent: "changeStatus", status: "completed" });
    expect(early.status).toBe(400);
    expect(early.body.message).toContain("COMPLETION REQUIRES SHIPMENT OR PICKUP");
    expect(friendlyMessage(early.body.message).primary).toBe("Ship or hand over the job before completing it");
  });
});

describe("Phase 2 — six board stages over existing statuses", () => {
  it("every backend status belongs to exactly one place; no status is invented", () => {
    const known = PRODUCTION_STATUS_OPTIONS.map((option) => option.value as string);
    const mapped = [...SIMPLE_STAGES.flatMap((stage) => [...stage.statuses] as string[]), ...ATTENTION_STATUSES, ...HIDDEN_STATUSES];
    expect([...mapped].sort()).toEqual([...known].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(SIMPLE_STAGES.map((stage) => stage.label)).toEqual(["New", "Prepress", "Production", "Finish / QC", "Ready", "Done"]);
  });

  it("exact mapping", () => {
    const map = Object.fromEntries(PRODUCTION_STATUS_OPTIONS.map((option) => [option.value, simpleStageForStatus(option.value)]));
    expect(map).toEqual({
      new: "new",
      prepress: "prepress", proof_needed: "prepress", proof_sent: "prepress", proof_approved: "prepress",
      ready_to_print: "production", printing: "production",
      cutting: "finish_qc", laminating: "finish_qc", qc: "finish_qc", packing: "finish_qc",
      // OWNER CORRECTION 2026-11-14: Shipped / Picked Up stay under READY; DONE is completed only
      ready_for_pickup: "ready", shipped: "ready", picked_up: "ready",
      completed: "done",
      on_hold: "attention", reprint_needed: "attention",
      cancelled: "hidden",
    });
  });

  it("role focus: print operator -> Production; bagger -> Finish / QC + Ready; nobody else is narrowed", () => {
    expect(ROLE_STAGE_FOCUS.print_operator).toEqual(["production"]);
    expect(ROLE_STAGE_FOCUS.bagger).toEqual(["finish_qc", "ready"]);
    for (const role of ["owner", "manager", "sales"]) expect(ROLE_STAGE_FOCUS[role]).toBeUndefined();
  });

  it("attention strip: on hold, reprint needed and overdue; cancelled only behind the filter", () => {
    const now = new Date("2026-11-14T15:00:00");
    const mk = (id: string, status: string, due?: string) => toBoardCard({ id, status, dueDate: due ? new Date(due) : null, items: [] }, now);
    const built = buildSimpleBoard([mk("a", "on_hold"), mk("b", "reprint_needed"), mk("c", "printing", "2026-11-10T12:00:00"), mk("d", "printing", "2026-11-20T12:00:00"), mk("e", "cancelled", "2026-11-01T12:00:00"), mk("f", "shipped", "2026-11-01T12:00:00")]);
    expect(built.attention.onHold.map((card) => card.id)).toEqual(["a"]);
    expect(built.attention.reprintNeeded.map((card) => card.id)).toEqual(["b"]);
    expect(built.attention.overdue.map((card) => card.id)).toEqual(["c"]); // shipped / cancelled are never overdue
    expect(built.cancelled.map((card) => card.id)).toEqual(["e"]);
    const inColumns = built.columns.flatMap((column) => column.cards.map((card) => card.id));
    expect(inColumns.sort()).toEqual(["c", "d", "f"]);
  });
});

describe("OWNER CORRECTION — DONE means completed", () => {
  const full = [
    { id: "c1", section: "prepress", label: "Artwork received / linked", sortOrder: 10, completed: true },
    { id: "c3", section: "production", label: "Labels printed", sortOrder: 30, completed: true },
    { id: "c7", section: "packing", label: "Packed and labeled", sortOrder: 80, completed: true },
  ];
  const passed = { id: "i1", itemTicket: "T-01", quantity: 5, qcResult: "pass", qcBy: "op", qcAt: new Date("2026-11-14T10:00:00Z"), lastReprintAt: null };
  const shipped = { id: "s", status: "shipped", shipCarrier: "UPS", shippedAt: new Date("2026-11-14T12:00:00Z"), items: [passed], checklistItems: full, events: [] };
  const pickedUp = { id: "p", status: "picked_up", pickedUpAt: new Date("2026-11-14T12:00:00Z"), pickedUpBy: "Customer", items: [passed], checklistItems: full, events: [] };
  const completed = { id: "c", status: "completed", items: [passed], checklistItems: full, events: [] };

  it("1-3. shipped and picked-up jobs are under READY; only completed jobs are under DONE", () => {
    const built = buildSimpleBoard([shipped, pickedUp, completed].map((job) => toBoardCard(job)));
    const ids = (key: string) => built.columns.find((column) => column.key === key)!.cards.map((card) => card.id).sort();
    expect(ids("ready")).toEqual(["p", "s"]);
    expect(ids("done")).toEqual(["c"]);
    expect(SIMPLE_STAGES.find((stage) => stage.key === "done")!.statuses).toEqual(["completed"]);
    expect(SIMPLE_STAGES.find((stage) => stage.key === "ready")!.statuses).toEqual(["ready_for_pickup", "shipped", "picked_up"]);
  });

  it("4-5. their card reads Status: Shipped / Picked Up and NEXT: Complete Job", () => {
    expect(toBoardCard(shipped)).toMatchObject({ stage: "ready", statusLabel: "Shipped", next: "Complete Job" });
    expect(toBoardCard(pickedUp)).toMatchObject({ stage: "ready", statusLabel: "Picked Up", next: "Complete Job" });
    expect(toBoardCard(completed)).toMatchObject({ stage: "done", statusLabel: "Completed", next: "DONE" });
  });

  it("no card under DONE ever still asks for an action", () => {
    for (const status of PRODUCTION_STATUS_OPTIONS.map((option) => option.value as string)) {
      const card = toBoardCard({ id: status, status, items: [passed], checklistItems: full, events: [], shipCarrier: "UPS", shippedAt: new Date() });
      if (card.stage === "done") expect(card.next, status).toBe("DONE");
    }
  });

  it("the finish stage still names the actual task (packing stays in Finish / QC)", () => {
    const base = [
      { id: "a", section: "prepress", label: "Proof approved", sortOrder: 10, completed: true },
      { id: "b", section: "production", label: "Labels printed", sortOrder: 20, completed: true },
    ];
    const open = (label: string, section = "production") => [...base, { id: "x", section, label, sortOrder: 50, completed: false }];
    const todo = { id: "i1", itemTicket: "T-01", quantity: 5, qcResult: null, lastReprintAt: null };
    expect(toBoardCard({ id: "1", status: "cutting", items: [todo], checklistItems: open("Labels applied to bags"), events: [] })).toMatchObject({ stage: "finish_qc", next: "Apply labels" });
    expect(toBoardCard({ id: "2", status: "laminating", items: [todo], checklistItems: open("Laminate complete"), events: [] })).toMatchObject({ stage: "finish_qc", next: "Laminate" });
    expect(toBoardCard({ id: "3", status: "cutting", items: [todo], checklistItems: open("Cut complete"), events: [] })).toMatchObject({ stage: "finish_qc", next: "Cut" });
    expect(toBoardCard({ id: "4", status: "qc", items: [todo], checklistItems: base, events: [] })).toMatchObject({ stage: "finish_qc", next: "Record QC" });
    expect(toBoardCard({ id: "5", status: "packing", items: [passed], checklistItems: open("Packed and labeled", "packing"), events: [] })).toMatchObject({ stage: "finish_qc", next: "Pack and label" });
  });
});

describe("Phase 2 — NEXT STEP", () => {
  const checklist = (done: string[] = []) => [
    { id: "c1", section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { id: "c2", section: "prepress", label: "Proof approved", sortOrder: 20 },
    { id: "c3", section: "production", label: "Labels printed", sortOrder: 30 },
    { id: "c4", section: "production", label: "Cut complete", sortOrder: 40 },
    { id: "c5", section: "production", label: "Labels applied to bags", sortOrder: 60 },
    { id: "c6", section: "qc", label: "QC passed", sortOrder: 70 },
    { id: "c7", section: "packing", label: "Packed and labeled", sortOrder: 80 },
  ].map((item) => ({ ...item, completed: done.includes(item.id) }));
  const item = (qcResult: string | null = null) => ({ id: "i1", itemTicket: "T-01", quantity: 100, machineSummary: "Roland LG-640", qcResult, qcBy: qcResult ? "op" : null, qcAt: qcResult ? new Date("2026-11-14T10:00:00Z") : null, lastReprintAt: null });
  const next = (job: any) => jobWorkspaceView({ events: [], ...job }).next.text;

  it("existing checklist items are split across the steps without renaming anything", () => {
    const split = checklistByStep(checklist());
    expect(split.artwork.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(split.print.map((c) => c.id)).toEqual(["c3"]);
    expect(split.finish.map((c) => c.id)).toEqual(["c4", "c5"]);
    expect(split.qc.map((c) => c.id)).toEqual(["c6"]);
    expect(split.pack.map((c) => c.id)).toEqual(["c7"]);
  });

  it("walks the owner's examples in order", () => {
    expect(next({ status: "new", items: [item()], checklistItems: checklist() })).toBe("Link artwork");
    expect(next({ status: "prepress", items: [item()], checklistItems: checklist(["c1"]) })).toBe("Approve proof");
    expect(next({ status: "proof_sent", items: [item()], checklistItems: checklist(["c1"]) })).toBe("Waiting for customer proof approval");
    expect(next({ status: "ready_to_print", items: [item()], checklistItems: checklist(["c1", "c2"]) })).toBe("Print on Roland LG-640");
    expect(next({ status: "printing", items: [item()], checklistItems: checklist(["c1", "c2", "c3"]) })).toBe("Cut");
    expect(next({ status: "cutting", items: [item()], checklistItems: checklist(["c1", "c2", "c3", "c4"]) })).toBe("Apply labels");
    expect(next({ status: "qc", items: [item()], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5"]) })).toBe("Record QC");
    expect(next({ status: "qc", items: [item("pass")], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5", "c6"]) })).toBe("Pack and label");
    expect(next({ status: "packing", items: [item("pass")], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]) })).toBe("Record shipment or pickup");
    expect(next({ status: "shipped", shipCarrier: "UPS", shippedAt: new Date(), items: [item("pass")], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]) })).toBe("Complete Job");
    expect(next({ status: "completed", items: [item("pass")], checklistItems: checklist() })).toBe("DONE");
  });

  it("status alone never skips QC or fulfillment (the server guards need the same evidence)", () => {
    // moved to Packing without a QC PASS: the next step is still QC
    expect(next({ status: "packing", items: [item()], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5", "c7"]) })).toBe("Record QC");
    // Ready for Pickup without a record: still needs the shipment / pickup record
    const view = jobWorkspaceView({ status: "ready_for_pickup", items: [item("pass")], checklistItems: checklist(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]), events: [] });
    expect(view.next.text).toBe("Record shipment or pickup");
    expect(view.fulfilled).toBe(false);
  });

  it("a job whose status is ahead of its checklist follows the status (earlier steps count as done)", () => {
    const view = jobWorkspaceView({ status: "printing", items: [item()], checklistItems: checklist(), events: [] });
    expect(view.currentStep).toBe("print");
    expect(view.steps.find((step) => step.key === "artwork")?.state).toBe("done");
  });

  it("problem and closed states", () => {
    expect(jobWorkspaceView({ status: "on_hold", items: [item()], checklistItems: checklist(), events: [] }).next).toMatchObject({ text: "On hold — check the notes", tone: "problem" });
    expect(jobWorkspaceView({ status: "reprint_needed", items: [item()], checklistItems: checklist(["c1", "c2"]), events: [] }).next).toMatchObject({ text: "Reprint needed", tone: "problem" });
    expect(jobWorkspaceView({ status: "cancelled", items: [], checklistItems: [], events: [] }).next.text).toBe("Cancelled");
    expect(() => jobWorkspaceView({})).not.toThrow(); // legacy / empty jobs load safely
  });

  it("offers a one-tap board move only when the checklist is ahead of the status, using an existing status", () => {
    const view = jobWorkspaceView({ status: "new", items: [item()], checklistItems: checklist(["c1", "c2"]), events: [] });
    expect(view.currentStep).toBe("print");
    expect(view.suggestedStatus).toBe("printing");
    expect(PRODUCTION_STATUS_OPTIONS.map((option) => option.value as string)).toContain(view.suggestedStatus);
    expect(jobWorkspaceView({ status: "printing", items: [item()], checklistItems: checklist(["c1", "c2"]), events: [] }).suggestedStatus).toBeNull();
  });
});

describe("Phase 2 — slim board (real loader)", () => {
  const CARD_KEYS = ["assignedTo", "customer", "dueDate", "id", "machine", "next", "nextTone", "overdue", "priority", "product", "quantity", "stage", "status", "statusLabel", "updatedAt"];

  it("a card carries only the approved fields — never money, files, checklist, events or technical ids", async () => {
    withMoney();
    h.state.job.jobTicket = "GSO-20260814-0001";
    for (const sub of [OWNER, BAGGER]) {
      h.sub = sub;
      const data: any = await loadBoard();
      const cards = data.board.columns.flatMap((column: any) => column.cards);
      expect(cards).toHaveLength(1);
      expect(Object.keys(cards[0]).sort()).toEqual(CARD_KEYS);
      expect(cards[0]).toMatchObject({ customer: "Acme Labels", quantity: 2, machine: "Roland LG-640", assignedTo: "Sam", priority: "rush", status: "qc", statusLabel: "QC", stage: "finish_qc", next: "Record QC", overdue: true });
      const text = JSON.stringify(data);
      for (const secret of ["4205.68", "4311.11", "77.77", "3999.99", "2.15", "1.0952", "GSO-20260814-0001"]) expect(text, `${sub} ${secret}`).not.toContain(secret);
    }
  }, 120_000);

  it("the board is read-only: no action, no form, no database import", () => {
    const src = readFileSync("app/routes/app.erp.production-board.tsx", "utf8");
    expect(src).not.toContain("export async function action");
    expect(src).not.toMatch(/<Form|fetcher|db\.server/);
    expect(src).toContain("OPEN JOB");
    expect(src).toContain("NEXT: {card.next}");
    for (const title of ["ON HOLD", "REPRINT NEEDED", "OVERDUE"]) expect(src).toContain(`title="${title}"`);
  });
});

describe("Phase 2 — Job Workspace reuses the real Production loader and action", () => {
  it("loads one job; an unknown job is a 404", async () => {
    const data: any = await loadJob();
    expect(data.job.id).toBe("j1");
    expect(data.showFinancials).toBe(true);
    await expect(loadJob("nope")).rejects.toMatchObject({ status: 404 });
  }, 120_000);

  it("financial redaction is the Production page's own: staff get no money and no Costs tab", async () => {
    withMoney();
    h.sub = BAGGER;
    const staff: any = await loadJob();
    expect(staff.showFinancials).toBe(false);
    expect(staff.job).toMatchObject({ quotedTrueCost: null, actualTotalCost: null, actualShippingCost: null });
    expect(staff.job.items[0]).toMatchObject({ unitPrice: null, unitCost: null });
    const text = JSON.stringify(staff);
    for (const secret of ["4205.68", "4311.11", "77.77", "3999.99", "1.0952"]) expect(text).not.toContain(secret);
    const src = readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8");
    expect(src).toContain('...(showFinancials ? [{ key: "costs", label: "Costs" }] : []),');
    expect(src).toContain('{tab === "costs" && showFinancials ? <CostsTab job={job} /> : null}');
  }, 120_000);

  it("QC, shipment and completion go through the unchanged action and guards", async () => {
    // shipment is refused without QC PASS
    const noQc = await postJob({ ...QA_SHIPMENT });
    expect(noQc.status).toBe(400);
    expect(noQc.body.message).toContain("QC PASS");
    expect(h.state.job.status).toBe("qc");
    // QC PASS through the workspace persists on the item
    for (const itemId of ["i1", "i2"]) expect((await postJob({ intent: "qcItem", itemId, qcResult: "pass", qcNote: "" })).body.ok).toBe(true);
    expect(h.state.items.every((item: any) => item.qcResult === "pass")).toBe(true);
    // completion is refused until shipped / picked up; a bare status change to shipped is refused
    expect((await postJob({ intent: "changeStatus", status: "completed" })).status).toBe(400);
    expect((await postJob({ intent: "changeStatus", status: "shipped" })).status).toBe(400);
    // shipment saves atomically, replay refused, then completion is allowed
    expect((await postJob({ ...QA_SHIPMENT })).body.ok).toBe(true);
    expect(h.state.job).toMatchObject({ status: "shipped", shipCarrier: "TEST - Migration QA", shipTrackingNumber: "TEST-SHIP-1012" });
    expect((await postJob({ ...QA_SHIPMENT, carrier: "Other" })).status).toBe(400);
    expect(eventsOf("shipped")).toHaveLength(1);
    const loaded: any = await loadJob();
    expect(jobWorkspaceView(loaded.job).next.text).toBe("Complete Job");
    // still READY (not DONE) until the existing completion action succeeds
    expect((await loadBoard()).board.columns.find((column: any) => column.key === "ready").cards.map((card: any) => card.status)).toEqual(["shipped"]);
    expect((await loadBoard()).board.columns.find((column: any) => column.key === "done").cards).toHaveLength(0);
    expect((await postJob({ intent: "changeStatus", status: "completed" })).body.ok).toBe(true);
    expect(h.state.job.status).toBe("completed");
    const after: any = await loadBoard();
    expect(after.board.columns.find((column: any) => column.key === "done").cards.map((card: any) => card.next)).toEqual(["DONE"]);
    expect(after.board.columns.find((column: any) => column.key === "ready").cards).toHaveLength(0);
  }, 120_000);

  it("pickup and reprint go through the unchanged action", async () => {
    for (const itemId of ["i1", "i2"]) await postJob({ intent: "qcItem", itemId, qcResult: "pass", qcNote: "" });
    expect((await postJob({ intent: "reprintItem", itemId: "i1", reprintReason: "machine_error", reprintNote: "smoke" })).body.ok).toBe(true);
    expect(h.state.items[0]).toMatchObject({ lastReprintReason: "machine_error", qcResult: null });
    // QC is required again after the reprint: pickup is refused, and the workspace says so
    const refused = await postJob({ intent: "recordPickup", pickedUpBy: "Migration QA", pickupNote: "n" });
    expect(refused.status).toBe(400);
    const loaded: any = await loadJob();
    expect(jobWorkspaceView(loaded.job).next.text).toBe("Record QC after reprint");
    await postJob({ intent: "qcItem", itemId: "i1", qcResult: "pass", qcNote: "" });
    expect((await postJob({ intent: "recordPickup", pickedUpBy: "Migration QA", pickupNote: "n" })).body.ok).toBe(true);
    expect(h.state.job).toMatchObject({ status: "picked_up", pickedUpBy: "Migration QA" });
  }, 120_000);

  it("permissions are the server's: a role without the permission is refused through the workspace too", async () => {
    for (const itemId of ["i1", "i2"]) await postJob({ intent: "qcItem", itemId, qcResult: "pass", qcNote: "" });
    h.sub = "1002"; // sales: no recordQc / recordShipment
    expect((await postJob({ intent: "qcItem", itemId: "i1", qcResult: "pass", qcNote: "" })).status).toBe(403);
    expect((await postJob({ ...QA_SHIPMENT })).status).toBe(403);
    expect(h.state.job.status).toBe("qc");
    h.sub = BAGGER; // bagger: recordShipment allowed, reprint not
    expect((await postJob({ intent: "reprintItem", itemId: "i1", reprintReason: "machine_error", reprintNote: "" })).status).toBe(403);
    expect((await postJob({ ...QA_SHIPMENT })).body.ok).toBe(true);
  });

  it("the workspace file holds no production logic of its own", () => {
    const src = readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8");
    expect(src).toContain('import { action as productionAction, loader as productionLoader } from "./app.erp.production";');
    expect(src).toContain("return productionAction({ request: args.request });");
    expect(src).not.toMatch(/db\.server|prisma|\$transaction|updateMany|resolveStaffAccess/);
    // saved shipment / pickup and QC state come from the existing helpers
    for (const helper of ["savedShipmentForJob(job, job.events || [])", "savedPickupForJob(job, job.events || [])", "itemQcState(item, job.events || [])", "itemReprintSummary(item)"]) expect(src).toContain(helper);
    for (const text of ["NEXT STEP", "Open advanced view", "Advanced / details"]) expect(src).toContain(text);
    // action feedback renders inside each form, next to its button
    expect(src).toContain("<Feedback data={fetcher.data} />");
  });
});

describe("Advanced (classic) view is kept", () => {
  const SRC_CLASSIC = readFileSync("app/routes/app.erp.production.tsx", "utf8");
  it("the full Production page still has every section and intent", () => {
    for (const section of ["Actual Cost Summary", "Final Actual Cost", "Material Usage + Waste", "Inventory Snapshot", "Asset Manager", "Checklist", "Event log / notes", "Record shipment", "Record customer pickup", "QC / Reprint / Revision"]) expect(SRC_CLASSIC, section).toContain(section);
    for (const intent of ["saveFinalCosts", "pullPrintLogActuals", "addMaterialUsage", "adjustInventory", "linkJobToTarget", "createFromQuote", "createManualJob", "recordShipment", "recordPickup", "qcItem", "reprintItem"]) expect(SRC_CLASSIC, intent).toContain(`intent === "${intent}"`);
  });

  it("?job=<id> only narrows what is displayed", () => {
    expect(SRC_CLASSIC).toContain('const focusJobId = searchParams.get("job");');
    expect(SRC_CLASSIC).toContain("const visibleJobs = focusJobId ? jobs.filter((job: any) => String(job.id) === focusJobId) : jobs;");
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toContain('route("erp/production", "routes/app.erp.production.tsx"),');
    expect(routes).toContain('route("erp/production-board", "routes/app.erp.production-board.tsx"),');
    expect(routes).toContain('route("erp/production-job/:id", "routes/app.erp.production-job.$id.tsx"),');
  });

  it("no schema change", async () => {
    const { readdirSync } = await import("node:fs");
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names[names.length - 1]).toBe("20261112090000_add_operational_records");
  });
});
