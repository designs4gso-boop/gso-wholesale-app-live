// 2026-11-20 — UI RENDER SMOKE (Job page, New Job, Quotes, Reorder) and the
// PERMISSION MATRIX through the real loaders and actions.
//
// PART A renders the real route components (React server render inside the
// Polaris provider and a router, the same harness as
// ui-render-smoke-2026-11-19.test.ts). Wherever possible the loader data is NOT
// hand-written: it is what the REAL loader returns for that role from an
// in-memory database, so the redaction and the screen are checked together.
// This is not a visual check in a browser: layout, spacing, touch behaviour,
// tab switching and anything that needs a click are still to be looked at.
//
// PART B drives the real loader and one real write action of every listed page
// as each of the six roles and compares the HTTP outcome with the route access
// table (route-access.ts) and the production action table
// (production-role-access.ts).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@shopify/polaris";
import { Outlet, createRoutesStub } from "react-router";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T05:00:00Z"), calls: [] as string[], writes: [] as string[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ boundary: { error: () => null, headers: () => ({}) } }));

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "gte", "lte", "lt", "gt", "equals", "some", "none", "every", "notIn", "startsWith"]);
  const READS = new Set(["findFirst", "findMany", "findUnique", "count", "aggregate", "groupBy", "findFirstOrThrow", "findUniqueOrThrow"]);
  const RELATIONS: Record<string, string[]> = { productionJob: ["items", "files", "events", "checklistItems", "materialUsages", "inventoryMovements"], quote: ["items"] };
  const time = (value: any) => (value == null ? null : new Date(value).getTime());
  const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? time(a) === time(b) : (a ?? null) === (b ?? null));
  const lower = (value: any) => String(value ?? "").toLowerCase();
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part) => match(row, part));
    if (key === "NOT") return !(Array.isArray(value) ? value : [value]).some((part) => match(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value); // compound unique key
      const insensitive = value.mode === "insensitive";
      if ("some" in value) return (row[key] || []).some((child: any) => match(child, value.some));
      if ("in" in value && !value.in.includes(row[key])) return false;
      if ("notIn" in value && value.notIn.includes(row[key])) return false;
      if ("not" in value && same(row[key], value.not)) return false;
      if ("equals" in value && !(insensitive ? lower(row[key]) === lower(value.equals) : same(row[key], value.equals))) return false;
      if ("contains" in value && !lower(row[key]).includes(lower(value.contains))) return false;
      if ("lte" in value && !(row[key] != null && time(row[key])! <= time(value.lte)!)) return false;
      if ("lt" in value && !(row[key] != null && time(row[key])! < time(value.lt)!)) return false;
      if ("gte" in value && !(row[key] != null && time(row[key])! >= time(value.gte)!)) return false;
      if ("gt" in value && !(row[key] != null && time(row[key])! > time(value.gt)!)) return false;
      return true;
    }
    return same(row[key], value);
  });
  // `select` is honoured (top level and nested), so a field the loader does not select never reaches the page here either
  const pick = (row: any, select: any): any => {
    if (!select || row == null) return row;
    if (Array.isArray(row)) return row.map((entry) => pick(entry, select));
    const out: any = {};
    for (const [key, rule] of Object.entries(select) as [string, any][]) {
      if (!rule) continue;
      out[key] = rule === true ? row[key] : pick(row[key], rule.select);
    }
    return out;
  };
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const shape = (name: string, row: any, args: any) => {
    const full: any = { ...row };
    for (const relation of RELATIONS[name] || []) full[relation] = (row[relation] || []).map((child: any) => ({ ...child }));
    return pick(full, args?.select);
  };
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      h.calls.push(`${name}.${method}`);
      if (!READS.has(method)) h.writes.push(`${name}.${method}`);
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? shape(name, found, args) : null; }
      if (method === "findMany") return list.filter((row) => match(row, args.where)).map((row) => shape(name, row, args));
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") {
        const data = { ...(args.data || {}) };
        for (const relation of RELATIONS[name] || []) if (data[relation]?.create) data[relation] = [].concat(data[relation].create).map((child: any) => ({ id: `${name}_${relation}_${++h.seq}`, ...child }));
        const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...data };
        list.push(row);
        return { ...row };
      }
      if (method === "update" || method === "updateMany") {
        const found = list.filter((row) => match(row, args.where));
        found.forEach((row) => Object.assign(row, args.data));
        return method === "update" ? (found[0] ? { ...found[0] } : null) : { count: found.length };
      }
      if (method === "delete" || method === "deleteMany") {
        const found = list.filter((row) => match(row, args.where));
        h.t[name] = list.filter((row) => !found.includes(row));
        return method === "delete" ? found[0] || null : { count: found.length };
      }
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : key === "$queryRawUnsafe" || key === "$queryRaw" ? async () => [] : model(key)) });
  return { default: db, db };
});

import { ROUTE_ACCESS, ROUTE_LEVEL_ROLES, viewerMayOpenRoute } from "../app/lib/route-access";
import { PRODUCTION_VIEW_DENIED_REDIRECT, roleMayRunProductionIntent, roleMayViewProduction } from "../app/lib/production-role-access";

/* ---------------- roles ---------------- */

const ROLE_SUB = { owner: "1", manager: "2", sales: "3", print_operator: "4", bagger: "5", unassigned: "9" } as const;
type Role = keyof typeof ROLE_SUB;
const ROLES = Object.keys(ROLE_SUB) as Role[];
const ENV: Record<string, string> = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" };
const as = (role: Role) => { h.sub = ROLE_SUB[role]; };

/* ---------------- seed: one multi-item job on reprint, one quote, one lead, one staged invoice, one privacy request ---------------- */

const TICKET = "GSO-20261120-0007";
// distinctive money values: none of them may reach a non-financial screen
const MONEY = { unitPrice1: 0.6213, unitCost1: 0.3137, unitPrice2: 0.7719, unitCost2: 0.3941, quotedTrueCost: 271.25, actualTotalCost: 293.47, variance: 22.22, shipping: 18.75 };
const MONEY_TEXT = /0\.6213|0\.3137|0\.7719|0\.3941|271\.25|293\.47|22\.22|18\.75/;

function seed() {
  h.t = {}; h.seq = 0; h.calls = []; h.writes = [];
  const items = [
    { id: "i1", shop: "shop-1", jobId: "j1", sortOrder: 0, itemTicket: `${TICKET}-01`, productTitle: "HEATH pouch", quantity: 500, unitPrice: MONEY.unitPrice1, unitCost: MONEY.unitCost1, selectedFinish: "CMYK", machineSummary: "Mimaki UCJV300", lastReprintAt: new Date("2026-11-20T03:00:00Z"), lastReprintReason: "color_quality_issue", lastReprintBy: "Dana", costSnapshot: JSON.stringify({ trueUnitCost: MONEY.unitCost1 }), priceSnapshot: null },
    { id: "i2", shop: "shop-1", jobId: "j1", sortOrder: 1, itemTicket: `${TICKET}-02`, productTitle: "SHORTCAKES pouch", quantity: 250, unitPrice: MONEY.unitPrice2, unitCost: MONEY.unitCost2, selectedFinish: "CMYK", machineSummary: "Mimaki UCJV300", costSnapshot: null, priceSnapshot: null },
  ];
  const job = {
    id: "j1", shop: "shop-1", active: true, status: "qc", jobTicket: TICKET, customerName: "Sam", company: "Krud Cafe", priority: "rush", assignedTo: "Dana", dueDate: new Date("2026-12-05T12:00:00Z"),
    sourceType: "manual", quoteId: null, orderGid: null, quoteNumber: null, proofApprovalToken: null, proofStatus: "draft", internalNotes: "Handle with gloves", fulfillmentState: null,
    quotedTrueCost: MONEY.quotedTrueCost, actualTotalCost: MONEY.actualTotalCost, actualVarianceAmount: MONEY.variance, actualShippingCost: MONEY.shipping, actualCostFinalized: true,
    createdAt: new Date("2026-11-19T10:00:00Z"), updatedAt: new Date("2026-11-20T04:00:00Z"),
    items,
    files: [{ id: "f1", shop: "shop-1", jobId: "j1", productionJobItemId: "i1", fileName: `${TICKET}-01__CMYK.pdf`, fileType: "print_file", assetSource: "nas", fileUrl: "\\\\NAS\\Prints For Today\\x.pdf", notes: "Prints For Today / Mimaki" }],
    events: [{ id: "e1", shop: "shop-1", jobId: "j1", eventType: "note", message: "Roll changed at 2pm", createdAt: new Date("2026-11-20T02:00:00Z"), createdBy: "Dana" }],
    checklistItems: [], materialUsages: [], inventoryMovements: [],
  };
  h.t.productionJob = [job];
  h.t.productionJobItem = items.map((item) => ({ ...item, job }));
  h.t.productionJobEvent = job.events.map((event) => ({ ...event }));
  h.t.productionRun = [
    { id: "r1", shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 1, kind: "original", quantity: 500, status: "qc_failed", runLabel: "A1" },
    { id: "r2", shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, reasonCode: "color_quality_issue", chargeType: "internal", status: "open", runLabel: "P1-A1", requestedBy: "Dana", notes: "banding on the left edge" },
  ];
  h.t.quote = [{
    id: "q1", shop: "shop-1", customerName: "Sam", company: "Krud Cafe", email: "sam@krud.test", phone: "555-0100", status: "draft", notes: "", customerTier: "standard",
    createdAt: new Date("2026-11-19T10:00:00Z"), updatedAt: new Date("2026-11-20T04:00:00Z"),
    items: [{ id: "qi1", quoteId: "q1", productName: "HEATH pouch", quantity: 500, unitPrice: MONEY.unitPrice1, unitCost: MONEY.unitCost1, marginPct: 49.5, costSnapshot: JSON.stringify({ trueUnitCost: MONEY.unitCost1 }), priceSnapshot: null }],
  }];
  h.t.crmLead = [{ id: "l1", shop: "shop-1", company: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", phone: "555-0100", source: "manual", status: "new", createdAt: new Date("2026-11-19T10:00:00Z"), updatedAt: new Date("2026-11-19T10:00:00Z"), createdBy: "Dana" }];
  h.t.stagedTransaction = [{ id: "st1", shop: "shop-1", source: "quickbooks_invoice", docNumber: "1270", customerName: "Krud Cafe", status: "staged", totalAmount: 512, balance: 256, lines: JSON.stringify([]), createdAt: new Date("2026-11-19T10:00:00Z") }];
  h.t.complianceRequest = [{ id: "c1", shop: "shop-1", topic: "customers/data_request", customerEmail: "sam@krud.test", customerId: "12", status: "received", receivedAt: new Date("2026-11-10T00:00:00Z"), dueAt: new Date("2026-12-10T00:00:00Z") }];
  h.calls = []; h.writes = [];
}

beforeEach(() => {
  seed(); h.shop = "shop-1"; as("owner");
  Object.assign(process.env, ENV);
  delete process.env.GSO_OWNER_ENFORCEMENT;
  delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS;
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

/* ---------------- helpers ---------------- */

const get = (path = "/x") => new Request(`https://erp.test${path}`);
const form = (fields: Record<string, string>, path = "/x") => new Request(`https://erp.test${path}`, { method: "POST", body: new URLSearchParams(fields) });
const json = (payload: unknown, path = "/app/quotes") => new Request(`https://erp.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
type Seen = { status: number; location: string | null; body: any };
const run = async (call: () => Promise<any>): Promise<Seen> => {
  let out: any;
  try { out = await call(); } catch (thrown) { if (!(thrown instanceof Response)) throw thrown; out = thrown; }
  if (!(out instanceof Response)) return { status: 200, location: null, body: out };
  const text = await out.clone().text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* plain text refusal */ }
  return { status: out.status, location: out.headers.get("Location"), body };
};
const data = async (call: () => Promise<any>) => { const seen = await run(call); expect(seen.status).toBe(200); return seen.body; };

function render(Component: any, loaderData: any, options: { path?: string; url?: string; ErrorBoundary?: any; error?: any; role?: string } = {}): string {
  const path = options.path || "/page";
  const page = { id: "page", path: options.role ? path.replace(/^\//, "") : path, Component, ErrorBoundary: options.ErrorBoundary, loader: () => loaderData, action: () => null };
  // the job page reads the role from the parent shell: useRouteLoaderData("routes/app")
  const routes: any[] = options.role ? [{ id: "routes/app", path: "/", Component: Outlet, loader: () => ({ role: options.role }), children: [page] }] : [page];
  const shell = options.role ? { "routes/app": { role: options.role } } : {};
  const hydrationData = options.error ? { errors: { page: options.error }, loaderData: { ...shell } } : { loaderData: { ...shell, page: loaderData } };
  const Stub = createRoutesStub(routes);
  const html = renderToString(createElement(AppProvider, { i18n: {} } as any, createElement(Stub, { initialEntries: [options.url || path], hydrationData } as any)));
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
}
/** What a person reads: tags, inline styles and attributes removed. */
const words = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
const routeError = (status: number, statusText: string) => Object.assign(Object.create(null), { status, statusText, data: "denied", internal: false, __type: "RouteErrorResponse" });
const JOB_ROUTE = { path: "/job/:id", url: "/job/j1" };

/* ====================================================================== */
/* PART A — render smoke                                                    */
/* ====================================================================== */

describe("A · Job page (app.erp.production-job.$id)", () => {
  const load = async (role: Role) => {
    as(role);
    const page = await import("../app/routes/app.erp.production-job.$id");
    return { page, loaderData: await data(() => page.loader({ request: get("/app/erp/production-job/j1"), params: { id: "j1" } })) };
  };

  it("print operator: a multi-item job with files awaiting, QC, an open reprint run, packed-and-waiting and the shipment form — and no money", async () => {
    const { page, loaderData } = await load("print_operator");
    expect(loaderData.showFinancials).toBe(false);
    // the real loader's payload for a non-financial viewer carries no money at all
    expect(JSON.stringify(loaderData)).not.toMatch(MONEY_TEXT);
    expect(loaderData.job.items.map((item: any) => [item.unitPrice, item.unitCost, item.costSnapshot])).toEqual([[null, null, null], [null, null, null]]);
    expect(loaderData.job.items[0].runs.map((entry: any) => [entry.runNumber, entry.kind, entry.quantity, entry.status])).toEqual([[1, "original", 500, "qc_failed"], [2, "reprint", 25, "open"]]);

    const html = render(page.default, loaderData, { ...JOB_ROUTE, role: "print_operator" });
    for (const text of [
      // header facts
      "Krud Cafe", "HEATH pouch (+1 more)", "750", "RUSH", "Dana", "NEXT STEP", "Record QC after reprint",
      // the six steps
      "ARTWORK", "PRINT", "FINISH", "QC", "PACK", "FULFILL",
      // QC step, per item
      "HEATH pouch · Qty 500", "SHORTCAKES pouch · Qty 250", "QC PASS", "Needs reprint", "Hold / review", "NEEDS REPRINT", "START REPRINT", "How many pieces to reprint (ordered: 500)", "Who pays",
      // the open reprint run and its cost treatment (no dollars)
      "Reprinted — Color / quality issue · Dana", "Ordered 500 · Reprinted 25 in 1 run(s)", "Run 1 — Original · 500 pcs · QC failed", "Run 2 — Reprint · 25 pcs · Color / quality issue · Internal — no charge · Waiting for QC · Dana · banding on the left edge",
      "Shop-absorbed reprints: 25 pcs in 1 run(s). The order total does not change.",
      // fulfil step
      "Packed and waiting", "Ready to ship", "Ready for pickup", "Shipping it", "Carrier (UPS, FedEx, USPS…)", "Tracking number", "Save shipment", "Customer is picking it up", "Save pickup (now)",
      // tickets and files
      "Job folder name", TICKET, `${TICKET}-01`, `${TICKET}-02`, "Copy job folder name", "Copy item ticket", "1 print file(s) received", "Awaiting files", "start each file name with its item ticket below",
      "FILES (1)", "On the shop NAS", "Prints For Today / Mimaki", `item ${TICKET}-01`, "Add a file link", "For the whole job",
      // material use and role tools for a print operator
      "MATERIAL USED", "Record material use", "NEW ARTWORK REVISION", "CHANGE STATUS", "MOVE JOB", "Roll changed at 2pm",
    ]) expect(html, text).toContain(text);
    for (const name of ["qcResult", "reprintReason", "reprintQty", "runKind", "chargeType", "carrier", "trackingNumber", "packageCount", "shipDate", "pickedUpBy"]) expect(html, name).toContain(`name="${name}"`);
    expect(html).toMatch(/name="intent" value="markFulfillmentReady"\/><input type="hidden" name="jobId" value="j1"\/><input type="hidden" name="kind" value="ship"/);
    expect(html).toMatch(/name="kind" value="pickup"/);
    // owner / manager tools and every money view are absent
    for (const text of ["COSTS", "Open advanced view", "Job settings", "SAVE JOB SETTINGS", "Reorder an item from this job", "Quoted true cost", "Actual total cost", "Actual shipping cost"]) expect(html, text).not.toContain(text);
    expect(html).not.toMatch(MONEY_TEXT);
    expect(html).not.toMatch(/\$\s?\d/);
  }, 120_000);

  it("bagger: QC, pack and ship controls stay; reprint, revision, job settings and reorder do not appear", async () => {
    const { page, loaderData } = await load("bagger");
    const html = render(page.default, loaderData, { ...JOB_ROUTE, role: "bagger" });
    for (const text of ["QC PASS", "Ready to ship", "Ready for pickup", "Save shipment", "Save pickup (now)", "MOVE JOB", "Record material use", "Awaiting files"]) expect(html, text).toContain(text);
    for (const text of ["NEEDS REPRINT", "START REPRINT", "NEW ARTWORK REVISION", "Job settings", "Reorder an item from this job", "Remove", "COSTS", "Open advanced view"]) expect(html, text).not.toContain(text);
    expect(html).not.toMatch(MONEY_TEXT);
    expect(html).not.toMatch(/\$\s?\d/);
  }, 120_000);

  it("owner: the Costs tab, the advanced view, job settings and the reorder link are offered", async () => {
    const { page, loaderData } = await load("owner");
    expect(loaderData.showFinancials).toBe(true);
    expect(loaderData.job.quotedTrueCost).toBe(MONEY.quotedTrueCost);
    const html = render(page.default, loaderData, { ...JOB_ROUTE, role: "owner" });
    for (const text of ["COSTS", "Open advanced view", "Job settings", "DUE DATE · PRIORITY · ASSIGNED TO", "SAVE JOB SETTINGS", "Reorder an item from this job (new quote)", "NEEDS REPRINT", "Yes, remove file", "Ready to ship"]) expect(html, text).toContain(text);
    expect(html).toContain(`/app/erp/reorder?q=${TICKET}`);
  }, 120_000);

  it("packed and waiting is shown once the job is marked ready; a shipped job offers COMPLETE JOB and no second shipment form", async () => {
    const { page, loaderData } = await load("print_operator");
    const ready = render(page.default, { ...loaderData, job: { ...loaderData.job, fulfillmentState: "ready_to_ship" } }, { ...JOB_ROUTE, role: "print_operator" });
    expect(ready).toContain("Packed and waiting — READY TO SHIP");
    const shipped = render(page.default, { ...loaderData, job: { ...loaderData.job, status: "shipped", shipCarrier: "UPS", shipTrackingNumber: "1Z999", shipPackageCount: 2, shippedAt: "2026-11-20T12:00:00.000Z" } }, { ...JOB_ROUTE, role: "print_operator" });
    for (const text of ["SHIPMENT RECORDED", "Carrier: UPS", "COMPLETE JOB"]) expect(shipped, text).toContain(text);
    for (const text of ["Save shipment", "Ready for pickup", "Actual shipping cost"]) expect(shipped, text).not.toContain(text);
  }, 120_000);

  it("without the parent shell the page falls back to a role with no controls (unassigned) for a non-financial viewer", async () => {
    const { page, loaderData } = await load("print_operator");
    const html = render(page.default, loaderData, JOB_ROUTE);
    expect(html).toContain("Krud Cafe");
    for (const text of ["NEEDS REPRINT", "Record material use", "MOVE JOB", "Job settings"]) expect(html, text).not.toContain(text);
  }, 120_000);

  it("a job that is not found shows the plain message (the page's own ErrorBoundary handles 404 only)", async () => {
    const page = await import("../app/routes/app.erp.production-job.$id");
    const html = render(page.default, null, { ...JOB_ROUTE, ErrorBoundary: page.ErrorBoundary, error: routeError(404, "Not Found") });
    expect(html).toContain("Job not available");
    expect(html).toContain("This job was not found. It may have been archived.");
    as("print_operator");
    expect((await run(() => page.loader({ request: get("/app/erp/production-job/nope"), params: { id: "nope" } }))).status).toBe(404);
  }, 120_000);
});

describe("A · New Job (app.erp.production-new)", () => {
  it("the form staff fill in; the printer choice appears only for roles the server lets choose", async () => {
    const page = await import("../app/routes/app.erp.production-new");
    const seen: Record<string, boolean> = {};
    for (const role of ["owner", "manager", "print_operator"] as Role[]) {
      as(role);
      const loaderData = await data(() => page.loader({ request: get("/app/erp/production-new") }));
      expect(loaderData.requestId).toMatch(/^[0-9a-f-]{36}$/);
      const html = render(page.default, loaderData);
      for (const text of ["New job", "Customer or job name", "What are we making?", "Quantity", "Due date (optional)", "Product type", "Finish", "Notes for production (optional)", "More details (size, SKU, reference, contact)", "CREATE JOB"]) expect(html, `${role}: ${text}`).toContain(text);
      for (const name of ["customerName", "itemTitle", "quantity", "dueDate", "family", "finish", "itemNotes", "size", "sku", "reference", "email", "phone"]) expect(html, `${role}: ${name}`).toContain(`name="${name}"`);
      expect(html).toContain('name="intent" value="createManualJob"');
      expect(html).toContain(`name="requestId" value="${loaderData.requestId}"`);
      expect(words(html), `${role}: no money wording on New Job`).not.toMatch(/\$\s?\d|cost|price|margin|profit/i);
      seen[role] = loaderData.canChoosePrinter;
      expect(html.includes('name="printer"'), `${role}: printer select`).toBe(loaderData.canChoosePrinter);
      if (loaderData.canChoosePrinter) for (const text of ["Auto (recommended)", "Mimaki UCJV300", "Roland LG-640"]) expect(html).toContain(text);
    }
    // staff-roles.server.ts: selectPrinter = owner and print operators; a manager always gets Auto
    expect(seen).toEqual({ owner: true, manager: false, print_operator: true });
  }, 120_000);

  it("the refused view", async () => {
    const page = await import("../app/routes/app.erp.production-new");
    const html = render(page.default, null, { ErrorBoundary: page.ErrorBoundary, error: routeError(403, "Forbidden") });
    expect(html).toContain("Your role can't create production jobs. Sales creates work from a quote or an order.");
    expect(html).not.toContain("CREATE JOB");
  }, 120_000);

  // GAP (not fixed here — app code is out of scope for this file):
  //   app/routes/app.erp.production-new.tsx:84-126 — the Simple Mode New Job form has NO "More items" field.
  //   The server accepts it: app/routes/app.erp.production.tsx:811 reads formData "moreItems"
  //   (parseAdditionalManualItems) and the Advanced page offers it at app.erp.production.tsx:2769-2771,
  //   but that page is owner / financial-manager only (advancedProductionRedirect). A print operator or a
  //   manager without financial access therefore cannot start a multi-item walk-in job from any screen.
  //   input: render NewProductionJob with the real loader data for print_operator
  //   expected: a control named "moreItems" ("More items on this job")
  //   actual: no such control — only "More details (size, SKU, reference, contact)"
  it("FIXED 2026-11-20: New Job offers the multi-item 'More items' field the server already accepts", async () => {
    const page = await import("../app/routes/app.erp.production-new");
    as("print_operator");
    const html = render(page.default, await data(() => page.loader({ request: get("/app/erp/production-new") })));
    expect(html).toContain('name="moreItems"');
  }, 120_000);
});

describe("A · Quotes (app.quotes)", () => {
  const load = async (role: Role) => {
    as(role);
    const page = await import("../app/routes/app.quotes");
    return { page, loaderData: await data(() => page.loader({ request: get("/app/quotes") })) };
  };
  const OWNER_ONLY = ["Total Cost", "Total Profit", "Profit Per Client", "Unit Cost", "Margin %", "Open Cost & Pricing Calculator", "Blended margin", "5 · Cost → 6 · Price → 7 · Margin", "Add priced items to see the margin check", "Total Revenue", "Approve low margin", "true cost"];

  it("owner: the builder with cost, price and margin controls and the pipeline card", async () => {
    const { page, loaderData } = await load("owner");
    expect(loaderData.ownerAccess.isOwner).toBe(true);
    expect(loaderData.quotes[0].items[0].unitCost).toBe(MONEY.unitCost1);
    const html = render(page.default, loaderData);
    for (const text of ["GSO Quote Builder", "Building a new quote", "1 · Customer", "Customer Name", "Company", "Customer tier", "8 · Notes → 9 · Save", "Quote Notes", "Save Quote", "Download / Print PDF", "Email Quote", "CRM Pipeline", "Krud Cafe", "Mark Sent", "Mark Won", "Mark Lost", "Client Portal", "Delete",
      "Total Revenue", "Total Cost", "Total Profit", "Profit Per Client", "Open Cost & Pricing Calculator", "Cost → 6 · Price → 7 · Margin", "Unit Cost", "Margin %"]) expect(html, text).toContain(text);
  }, 120_000);

  for (const role of ["sales", "manager"] as Role[]) {
    it(`${role}: the same builder with customer price only — no cost, profit or margin control, and none in the payload`, async () => {
      const { page, loaderData } = await load(role);
      expect(loaderData.ownerAccess.isOwner).toBe(false);
      // server redaction: the quote keeps its selling price; cost, margin and snapshots are gone
      expect(loaderData.quotes[0].items[0]).toMatchObject({ unitPrice: MONEY.unitPrice1, unitCost: null, marginPct: null, costSnapshot: null });
      expect(JSON.stringify(loaderData)).not.toMatch(/0\.3137|49\.5|trueUnitCost|271\.25|293\.47/);
      const html = render(page.default, loaderData);
      for (const text of ["GSO Quote Builder", "1 · Customer", "Customer Name", "Order of work: 1 Customer → 2 Product → 3 Quantity → 4 Specifications / options → 5 Customer price → 6 Notes → 7 Save.", "Owner Approval Required", "Quote total", "Save Quote", "CRM Pipeline", "Krud Cafe", "Mark Sent", "Open"]) expect(html, text).toContain(text);
      for (const text of OWNER_ONLY) expect(html, text).not.toContain(text);
      expect(html).not.toMatch(/0\.3137|49\.5/);
      expect(words(html)).not.toMatch(/profit/i);
      // no margin figure of any kind (a percentage next to the word, in either order)
      expect(words(html)).not.toMatch(/margin[^.<]{0,40}\d+(\.\d+)?\s?%|\d+(\.\d+)?\s?%[^.<]{0,40}margin/i);
      // Sales may not open Production pages, so no link into Production is offered; a manager gets one
      expect(loaderData.canOpenProduction).toBe(role === "manager");
    }, 120_000);
  }
});

// WORDING (not fixed here — app code is out of scope for this file). No number leaks: the payload and the
// screen carry no cost or margin value for Sales / a manager. But two fixed sentences on the builder are not
// switched by role the way every other heading on the page is (ownerAccess.isOwner):
//   app/routes/app.quotes.tsx:2373  heading "2–7 · Items: product, quantity, material / finish, cost, price, margin"
//   app/routes/app.quotes.tsx:2415  "A Product Setup recipe pulls saved costs, margins, tiers, finishes, and vendor add-ons automatically."
//   input: QuotesPage rendered with the real loader data for sales
//   expected: the staff wording used elsewhere ("5 · Customer price"), no mention of cost / margin
//   actual: both sentences are shown to Sales unchanged
describe("A · Quotes wording for non-owners", () => {
  it("FIXED 2026-11-20: the Sales builder does not talk about cost or margin at all", async () => {
    const page = await import("../app/routes/app.quotes");
    as("sales");
    const html = render(page.default, await data(() => page.loader({ request: get("/app/quotes") })));
    // two approved staff sentences name "cost" on purpose: the tier note, and "the owner supplies the internal cost" (manual items wait for the owner)
    expect(words(html).replace(/it never changes cost\./g, "").replace(/the owner supplies the internal cost/g, "")).not.toMatch(/\bcosts?\b|margins?\b/i);
  }, 120_000);
});

describe("A · Reorder (app.erp.reorder)", () => {
  it("sales: earlier items to pick, the search box and the create button — identity only, no price or cost", async () => {
    const page = await import("../app/routes/app.erp.reorder");
    as("sales");
    const loaderData = await data(() => page.loader({ request: get("/app/erp/reorder") }));
    expect(loaderData.options).toEqual([
      { itemId: "i1", itemTicket: `${TICKET}-01`, product: "HEATH pouch", quantity: 500, finish: "CMYK", customer: "Krud Cafe", jobTicket: TICKET, completedAt: null, status: "qc" },
      { itemId: "i2", itemTicket: `${TICKET}-02`, product: "SHORTCAKES pouch", quantity: 250, finish: "CMYK", customer: "Krud Cafe", jobTicket: TICKET, completedAt: null, status: "qc" },
    ]);
    expect(JSON.stringify(loaderData)).not.toMatch(MONEY_TEXT);
    const html = render(page.default, loaderData);
    for (const text of ["Reorder a past item", "A reorder is a new sale", "Customer, job ticket or product", "Search", "1. Pick the earlier item(s) — one customer at a time", "Krud Cafe — HEATH pouch", `${TICKET}-01 · earlier quantity 500 · CMYK`, "Krud Cafe — SHORTCAKES pouch", "2. Create the reorder quote", "the earlier price is never copied", "CREATE REORDER QUOTE"]) expect(html, text).toContain(text);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>CREATE REORDER QUOTE<\/button>/); // nothing picked yet
    expect((html.match(/type="checkbox"/g) || []).length).toBe(2);
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toMatch(MONEY_TEXT);
  }, 120_000);

  it("a search with no match, and the refused view", async () => {
    const page = await import("../app/routes/app.erp.reorder");
    as("manager");
    const none = await data(() => page.loader({ request: get("/app/erp/reorder?q=zzz-nothing") }));
    expect(none).toEqual({ options: [], q: "zzz-nothing" });
    expect(render(page.default, none, { url: "/page?q=zzz-nothing" })).toContain('No earlier items found for "zzz-nothing".');
    const denied = render(page.default, null, { ErrorBoundary: page.ErrorBoundary, error: routeError(403, "Forbidden") });
    expect(denied).toContain("Reorders are created by the owner, a manager or sales.");
    expect(denied).not.toContain("CREATE REORDER QUOTE");
  }, 120_000);
});

/* ====================================================================== */
/* PART B — permission matrix through the real loaders and actions          */
/* ====================================================================== */

// The expected matrix, written out by hand from route-access.ts / production-role-access.ts.
const COMMERCIAL: Role[] = ["owner", "manager", "sales"];
const ADMIN: Role[] = ["owner", "manager"];
const FLOOR: Role[] = ["owner", "manager", "print_operator", "bagger"];
const LEADS: Role[] = ["owner", "manager", "print_operator"];
const OWNER: Role[] = ["owner"];

type Door = {
  page: string; // file under app/routes
  routeKey?: string; // ROUTE_ACCESS key the row is checked against
  intent?: string; // production-role-access intent the row is checked against
  what: string;
  allowed: Role[];
  denied: 403 | "redirect";
  call: (mod: any) => Promise<any>;
  /** the status an allowed role receives (the write really ran) */
  ok?: number;
  /** extra rows the action needs to get past its own business guard */
  before?: () => void;
  wrote?: () => void;
};

const DOORS: Door[] = [
  // Leads
  { page: "app.erp.crm", routeKey: "erp/crm", what: "Leads · open the list", allowed: COMMERCIAL, denied: 403, call: (m) => m.loader({ request: get("/app/erp/crm") }) },
  { page: "app.erp.crm", routeKey: "erp/crm", what: "Leads · add a lead", allowed: COMMERCIAL, denied: 403, call: (m) => m.action({ request: form({ intent: "createLead", company: "Leaf Labs", email: "buyer@leaf.test" }) }), wrote: () => expect(h.t.crmLead.map((lead) => lead.company)).toEqual(["Krud Cafe", "Leaf Labs"]) },
  { page: "app.erp.crm.$id", routeKey: "erp/crm/:id", what: "Lead · open", allowed: COMMERCIAL, denied: 403, call: (m) => m.loader({ request: get("/app/erp/crm/l1"), params: { id: "l1" } }) },
  { page: "app.erp.crm.$id", routeKey: "erp/crm/:id", what: "Lead · add a note", allowed: COMMERCIAL, denied: 403, call: (m) => m.action({ request: form({ intent: "note", note: "Left a voicemail" }), params: { id: "l1" } }), wrote: () => expect((h.t.crmLeadEvent || []).map((event) => event.detail)).toContain("Left a voicemail") },
  // Approvals
  { page: "app.erp.agent-approvals", routeKey: "erp/agent-approvals", what: "Approvals · open", allowed: ADMIN, denied: 403, call: (m) => m.loader({ request: get("/app/erp/agent-approvals") }) },
  { page: "app.erp.agent-approvals", routeKey: "erp/agent-approvals", what: "Approvals · approve", allowed: ADMIN, denied: 403, call: (m) => m.action({ request: form({ intent: "approve", id: "missing" }) }) },
  // Production Board (read-only page: it exports no action)
  { page: "app.erp.production-board", routeKey: "erp/production-board", what: "Production Board · open", allowed: FLOOR, denied: "redirect", call: (m) => m.loader({ request: get("/app/erp/production-board") }) },
  // Job page
  { page: "app.erp.production-job.$id", routeKey: "erp/production-job/:id", what: "Job page · open", allowed: FLOOR, denied: "redirect", call: (m) => m.loader({ request: get("/app/erp/production-job/j1"), params: { id: "j1" } }) },
  { page: "app.erp.production-job.$id", intent: "addNote", what: "Job page · add a note", allowed: FLOOR, denied: 403, call: (m) => m.action({ request: form({ intent: "addNote", jobId: "j1", note: "Checked the roll" }) }), wrote: () => expect((h.t.productionJobEvent || []).map((event) => event.message)).toContain("Checked the roll") },
  { page: "app.erp.production-job.$id", intent: "markFulfillmentReady", what: "Job page · Ready to ship", allowed: FLOOR, denied: 403, call: (m) => m.action({ request: form({ intent: "markFulfillmentReady", jobId: "j1", kind: "ship" }) }),
    // the action's own guard needs QC PASS on every item (without it an allowed role gets 400 "QC PASS REQUIRED", never 403)
    before: () => { h.t.productionJobEvent.push(...[1, 2].map((n) => ({ id: `qc${n}`, shop: "shop-1", jobId: "j1", eventType: "qc_result", newValue: "pass", oldValue: `${TICKET}-0${n}`, message: "QC PASS", createdAt: new Date("2026-11-20T04:30:00Z"), createdBy: "Dana" }))); },
    wrote: () => expect(h.t.productionJob[0].fulfillmentState).toBe("ready_to_ship") },
  { page: "app.erp.production-job.$id", intent: "reprintItem", what: "Job page · start a reprint", allowed: LEADS, denied: 403, call: (m) => m.action({ request: form({ intent: "reprintItem", jobId: "j1", itemId: "i2", reprintReason: "operator_error", reprintQty: "10", runKind: "reprint", chargeType: "internal" }) }) },
  { page: "app.erp.production-job.$id", intent: "updateJob", what: "Job page · job settings (due date / priority / assignee)", allowed: ADMIN, denied: 403, call: (m) => m.action({ request: form({ intent: "updateJob", jobId: "j1", priority: "critical", assignedTo: "Sam", dueDate: "2026-12-01" }) }), wrote: () => expect(h.t.productionJob[0]).toMatchObject({ priority: "critical", assignedTo: "Sam" }) },
  // New Job
  { page: "app.erp.production-new", routeKey: "erp/production-new", what: "New Job · open", allowed: LEADS, denied: 403, call: (m) => m.loader({ request: get("/app/erp/production-new") }) },
  { page: "app.erp.production-new", intent: "createManualJob", what: "New Job · create", allowed: LEADS, denied: 403, call: (m) => m.action({ request: form({ intent: "createManualJob", requestId: "11111111-1111-4111-8111-111111111111", customerName: "Walk-in — Jane D.", itemTitle: "4x5 bag labels", quantity: "100", family: "default", finish: "CMYK" }) }), wrote: () => expect(h.t.productionJob.map((job) => job.customerName)).toContain("Walk-in — Jane D.") },
  // Release to Production
  { page: "app.erp.release-queue", routeKey: "erp/release-queue", what: "Release to Production · open", allowed: ADMIN, denied: 403, call: (m) => m.loader({ request: get("/app/erp/release-queue") }) },
  { page: "app.erp.release-queue", intent: "releaseStagedTransaction", what: "Release to Production · release", allowed: ADMIN, denied: 403, call: (m) => m.action({ request: form({ intent: "release", id: "st1" }) }) },
  { page: "app.erp.release-queue", intent: "dismissStagedTransaction", what: "Release to Production · dismiss", allowed: ADMIN, denied: 403, call: (m) => m.action({ request: form({ intent: "dismiss", id: "st1", reason: "Duplicate of invoice 1269" }) }), wrote: () => expect(h.t.stagedTransaction[0].status).not.toBe("staged") },
  // Reorder
  { page: "app.erp.reorder", routeKey: "erp/reorder", what: "Reorder · open", allowed: COMMERCIAL, denied: 403, call: (m) => m.loader({ request: get("/app/erp/reorder") }) },
  { page: "app.quotes", routeKey: "quotes", what: "Reorder · create the reorder quote (Quotes action createReorderQuote)", allowed: COMMERCIAL, denied: 403, call: (m) => m.action({ request: json({ intent: "createReorderQuote", lines: [{ itemId: "i2", quantity: "300", artworkMode: "same_artwork" }] }) }), wrote: () => expect(h.t.quote).toHaveLength(2) },
  // Quotes
  { page: "app.quotes", routeKey: "quotes", what: "Quotes · open", allowed: COMMERCIAL, denied: 403, call: (m) => m.loader({ request: get("/app/quotes") }) },
  { page: "app.quotes", routeKey: "quotes", what: "Quotes · delete a quote", allowed: COMMERCIAL, denied: 403, call: (m) => m.action({ request: json({ intent: "delete", id: "q1" }) }), wrote: () => expect(h.t.quote).toHaveLength(0) },
  { page: "app.quotes", routeKey: "quotes", what: "Quotes · move a quote (status)", allowed: COMMERCIAL, denied: 403, call: (m) => m.action({ request: json({ intent: "status", id: "q1", status: "lost", reason: "Went elsewhere" }) }), wrote: () => expect(h.t.quote[0]).toMatchObject({ status: "lost", outcomeReason: "Went elsewhere" }) },
  // Privacy Requests
  { page: "app.erp.privacy-requests", routeKey: "erp/privacy-requests", what: "Privacy Requests · open", allowed: OWNER, denied: 403, call: (m) => m.loader({ request: get("/app/erp/privacy-requests") }) },
  { page: "app.erp.privacy-requests", routeKey: "erp/privacy-requests", what: "Privacy Requests · add a working note", allowed: OWNER, denied: 403, call: (m) => m.action({ request: form({ intent: "note", id: "c1", note: "Checked quotes" }) }), wrote: () => expect(h.writes).toContain("complianceRequestEvent.create") },
];

const MODULES: Record<string, () => Promise<any>> = {
  "app.erp.crm": () => import("../app/routes/app.erp.crm"),
  "app.erp.crm.$id": () => import("../app/routes/app.erp.crm.$id"),
  "app.erp.agent-approvals": () => import("../app/routes/app.erp.agent-approvals"),
  "app.erp.production-board": () => import("../app/routes/app.erp.production-board"),
  "app.erp.production-job.$id": () => import("../app/routes/app.erp.production-job.$id"),
  "app.erp.production-new": () => import("../app/routes/app.erp.production-new"),
  "app.erp.release-queue": () => import("../app/routes/app.erp.release-queue"),
  "app.erp.reorder": () => import("../app/routes/app.erp.reorder"),
  "app.quotes": () => import("../app/routes/app.quotes"),
  "app.erp.privacy-requests": () => import("../app/routes/app.erp.privacy-requests"),
};

describe("B · permission matrix — real loaders and actions, six roles", () => {
  it("the hand-written matrix is the one in route-access.ts and production-role-access.ts", () => {
    for (const door of DOORS) {
      if (door.routeKey) {
        expect(ROUTE_ACCESS[door.routeKey], door.what).toBeDefined();
        const table = ROLES.filter((role) => viewerMayOpenRoute(door.routeKey!, { role, canViewFinancials: role === "owner" }));
        // a production action on a page may be narrower than the page (per-intent table); a page row must equal the table
        if (!door.intent) expect(door.allowed, `${door.what} vs ROUTE_ACCESS["${door.routeKey}"]`).toEqual(table);
      }
      if (door.intent) expect(door.allowed, `${door.what} vs PRODUCTION_INTENT_ROLES.${door.intent}`).toEqual(ROLES.filter((role) => roleMayRunProductionIntent(role, door.intent)));
    }
    expect(ROUTE_LEVEL_ROLES.production_view).toEqual(FLOOR);
    expect(ROLES.filter((role) => roleMayViewProduction(role))).toEqual(FLOOR);
  });

  for (const door of DOORS) {
    it(`${door.what} — allowed: ${door.allowed.join(", ")}; everyone else ${door.denied === 403 ? "403" : "sent to Home"}`, async () => {
      const mod = await MODULES[door.page]();
      const seen: Record<string, string> = {};
      const expected: Record<string, string> = {};
      for (const role of ROLES) {
        seed();
        door.before?.();
        h.calls = []; h.writes = [];
        as(role);
        const out = await run(() => door.call(mod));
        const allowed = door.allowed.includes(role);
        seen[role] = out.status === 403 ? "403" : out.status >= 300 && out.status < 400 ? `redirect ${out.location}` : `allowed (${out.status})`;
        expected[role] = allowed ? `allowed (${door.ok ?? 200})` : door.denied === 403 ? "403" : `redirect ${PRODUCTION_VIEW_DENIED_REDIRECT}`;
        if (!allowed) {
          // refused before anything is read or written
          expect(h.writes, `${door.what} · ${role} wrote`).toEqual([]);
          expect(h.calls, `${door.what} · ${role} read`).toEqual([]);
        } else if (door.wrote) door.wrote();
      }
      expect(seen).toEqual(expected);
    }, 120_000);
  }

  it("the Production Board is read-only: it exports no action at all", async () => {
    const board = await MODULES["app.erp.production-board"]();
    expect(board.action).toBeUndefined();
  }, 120_000);

  it("a manager with the owner's financial authorization still cannot open Privacy Requests (owner only)", async () => {
    process.env.GSO_MANAGER_AUTHORIZED_USER_IDS = "2";
    const privacy = await MODULES["app.erp.privacy-requests"]();
    as("manager");
    expect((await run(() => privacy.loader({ request: get() }))).status).toBe(403);
    expect((await run(() => privacy.action({ request: form({ intent: "note", id: "c1", note: "x" }) }))).status).toBe(403);
    expect(h.calls).toEqual([]);
  }, 120_000);

  // Customers (app.erp.customers / app.erp.customers.$id) was being built by another worker while this file
  // was written; the files and their route-access entries existed by the time it was finished. The rows are
  // skipped (not failed) if the files are absent. Expected: owner, manager, sales — everyone else 403.
  const CUSTOMER_PAGES = [
    { file: "app/routes/app.erp.customers.tsx", routeKey: "erp/customers", params: {} as Record<string, string>, post: { intent: "createCustomer", company: "Leaf Labs", email: "buyer@leaf.test" } as Record<string, string> },
    { file: "app/routes/app.erp.customers.$id.tsx", routeKey: "erp/customers/:id", params: { id: "a1" }, post: { intent: "note", note: "Called about the reorder" } },
  ];
  for (const customers of CUSTOMER_PAGES) {
    it.skipIf(!existsSync(customers.file))(`Customers · ${customers.file} — owner, manager, sales; everyone else 403 (loader and a posted write)`, async () => {
      const mod = await import(/* @vite-ignore */ resolve(customers.file));
      expect(ROUTE_ACCESS[customers.routeKey], `${customers.routeKey} is in the route access table`).toBe("commercial");
      const seen: Record<string, string[]> = {};
      for (const role of ROLES) {
        seed();
        h.t.crmAccount = [{ id: "a1", shop: "shop-1", active: true, company: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", createdAt: new Date("2026-11-19T10:00:00Z"), updatedAt: new Date("2026-11-19T10:00:00Z") }];
        as(role);
        const outcomes: string[] = [];
        for (const call of [() => mod.loader({ request: get("/app/erp/customers"), params: customers.params }), () => mod.action({ request: form(customers.post), params: customers.params })]) {
          h.calls = []; h.writes = [];
          const out = await run(call);
          outcomes.push(out.status === 403 ? "403" : out.status >= 300 && out.status < 400 ? "redirect" : `allowed (${out.status}${out.body?.ok === false ? `: ${out.body.message}` : ""})`);
          if (!COMMERCIAL.includes(role)) expect(h.calls, `${customers.file} · ${role}`).toEqual([]);
          else if (call !== undefined && h.calls.length === 0) throw new Error("an allowed role reached no data");
        }
        seen[role] = outcomes;
      }
      expect(seen).toEqual(Object.fromEntries(ROLES.map((role) => [role, Array(2).fill(COMMERCIAL.includes(role) ? "allowed (200)" : "403")])));
    }, 120_000);
  }
});
