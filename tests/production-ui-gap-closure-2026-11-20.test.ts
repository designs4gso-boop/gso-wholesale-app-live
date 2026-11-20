// 2026-11-20 — PRODUCTION UI GAP CLOSURE (fixes 12, 16, 18, 19, 23, 24).
//
// Every scenario calls the REAL production loader / action (and the Simple Mode
// board, job page and New Job routes that wrap them) against an in-memory
// database double, and renders the real route components (React server render
// inside the Polaris provider and a router — the harness of
// ui-and-permission-smoke-2026-11-20.test.ts). Nothing touches Prisma, the
// network, Shopify or the NAS. No job is created outside this in-memory double.
//
// The database double: plain tables; `where` operators the code uses; `select`
// honoured; and `$transaction` SERIALIZED (one transaction at a time). That is
// the one property the concurrent reprint scenarios rely on: on the real
// database the second request's conditional claim on the item row waits for
// the first transaction to settle. A render check is not a browser check.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@shopify/polaris";
import { Outlet, createRoutesStub } from "react-router";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T05:00:00Z"), writes: [] as string[], chain: Promise.resolve() as Promise<any> }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ boundary: { error: () => null, headers: () => ({}) } }));

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "gte", "lte", "lt", "gt", "equals", "some", "none", "every", "notIn", "startsWith"]);
  const READS = new Set(["findFirst", "findMany", "findUnique", "count"]);
  const RELATIONS: Record<string, string[]> = { productionJob: ["items", "files", "events", "checklistItems", "materialUsages", "inventoryMovements"] };
  const CHILD_TABLE: Record<string, string> = { items: "productionJobItem", files: "productionJobFile", events: "productionJobEvent", checklistItems: "productionJobChecklistItem", materialUsages: "productionMaterialUsage", inventoryMovements: "inventoryMovement" };
  const time = (value: any) => (value == null ? null : new Date(value).getTime());
  const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? time(a) === time(b) : (a ?? null) === (b ?? null));
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part) => match(row, part));
    if (key === "NOT") return !(Array.isArray(value) ? value : [value]).some((part) => match(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value);
      if ("in" in value && !value.in.includes(row[key])) return false;
      if ("notIn" in value && value.notIn.includes(row[key])) return false;
      if ("not" in value && same(row[key], value.not)) return false;
      if ("contains" in value && !String(row[key] ?? "").includes(String(value.contains))) return false;
      if ("gte" in value && !(row[key] != null && time(row[key])! >= time(value.gte)!)) return false;
      if ("lte" in value && !(row[key] != null && time(row[key])! <= time(value.lte)!)) return false;
      return true;
    }
    return same(row[key], value);
  });
  const pick = (row: any, select: any): any => {
    if (!select || row == null) return row;
    if (Array.isArray(row)) return row.map((entry) => pick(entry, select));
    const out: any = {};
    for (const [key, rule] of Object.entries(select) as [string, any][]) if (rule) out[key] = rule === true ? row[key] : pick(row[key], rule.select);
    return out;
  };
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  // children are read from their own tables, so a row written by an action is what the next loader call sees
  const shape = (name: string, row: any, args: any) => {
    const full: any = { ...row };
    for (const relation of RELATIONS[name] || []) full[relation] = rows(CHILD_TABLE[relation]).filter((child) => child.jobId === row.id).map((child) => ({ ...child }));
    if (name === "productionJob" && Array.isArray(full.events)) full.events.sort((a: any, b: any) => time(b.createdAt)! - time(a.createdAt)!);
    if (name === "productionJob" && Array.isArray(full.items)) full.items.sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    return pick(full, args?.select);
  };
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      if (!READS.has(method)) h.writes.push(`${name}.${method}`);
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? shape(name, found, args) : null; }
      if (method === "findMany") {
        const found = list.filter((row) => match(row, args.where)).map((row) => shape(name, row, args));
        const order = ([] as any[]).concat(args.orderBy || [])[0];
        if (order) { const [field, direction] = Object.entries(order)[0] as [string, string]; found.sort((a: any, b: any) => { const x = a[field] instanceof Date ? time(a[field])! : a[field]; const y = b[field] instanceof Date ? time(b[field])! : b[field]; return (x > y ? 1 : x < y ? -1 : 0) * (direction === "desc" ? -1 : 1); }); }
        return found;
      }
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") {
        const own: any = {};
        const kids: Array<[string, any[]]> = [];
        for (const [key, value] of Object.entries(args.data || {}) as [string, any][]) {
          if ((RELATIONS[name] || []).includes(key) && value && typeof value === "object" && "create" in value) kids.push([CHILD_TABLE[key], ([] as any[]).concat(value.create)]);
          else own[key] = value;
        }
        const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...own };
        list.push(row);
        for (const [child, entries] of kids) for (const entry of entries) rows(child).push({ id: `${child}_${++h.seq}`, createdAt: new Date(h.clock), updatedAt: new Date(h.clock), shop: row.shop, ...entry, jobId: row.id });
        return shape(name, row, args);
      }
      if (method === "update" || method === "updateMany") {
        const found = list.filter((row) => match(row, args.where));
        found.forEach((row) => Object.assign(row, args.data, { updatedAt: new Date((h.clock += 1000)) }));
        return method === "update" ? (found[0] ? { ...found[0] } : null) : { count: found.length };
      }
      return null;
    },
  });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "then") return undefined;
      if (key === "$transaction") {
        return (work: any) => {
          if (typeof work !== "function") return Promise.all(work);
          const turn = h.chain.then(() => work(db)); // one transaction at a time
          h.chain = turn.catch(() => undefined);
          return turn;
        };
      }
      if (key === "$queryRawUnsafe" || key === "$queryRaw" || key === "$executeRawUnsafe") return async () => [];
      return model(key);
    },
  });
  return { default: db, db };
});

import { findReprintRequest, isReprintRequestId, newReprintRequestId, reprintRequestRecord } from "../app/lib/production-run";
import { ACTUAL_PLUS_ESTIMATE_LABEL, PARTIAL_COST_LABEL, quotedEstimateOf, runCostDollars } from "../app/lib/run-cost-dollars.server";
import { redactJobFinancials } from "../app/lib/production-financial-redaction";
import { boardCardDisplay, fileLayerOf, itemStageTrail, jobAssistLine, printerDestination, toBoardCard, toIntakeFileView } from "../app/lib/simple-production";
import { buildBrandRates } from "../app/lib/rip-actual-costs.server";

/* ---------------- roles ---------------- */

const ROLE_SUB = { owner: "1", manager: "2", print_operator: "4", bagger: "5" } as const;
type Role = keyof typeof ROLE_SUB;
const ENV: Record<string, string> = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" };
const as = (role: Role) => { h.sub = ROLE_SUB[role]; };

/* ---------------- seed: one two-item, two-press job ---------------- */

const JOB = "GSO-20261120-0042";
const OLD = "GSO-20261101-0007";
const MIMAKI = "Mimaki UCJV300";
const ROLAND = "Roland LG-640";
const HASH_1 = `a1b2c3d4${"e".repeat(56)}`;
const HASH_2 = `0f9e8d7c${"1".repeat(56)}`;
const HASH_3 = `77aa66bb${"2".repeat(56)}`;
// distinctive money values: none may reach a non-financial payload or screen
const MONEY = { unitPrice: 0.6213, unitCost: 0.3137, material: 41.57, application: 12.29, inkQuoted: 9.83, packing: 3.61, quotedTrueCost: 271.25, usageCost: 66.44 };
const MONEY_TEXT = /0\.6213|0\.3137|41\.57|12\.29|53\.86|9\.83|3\.61|271\.25|66\.44|4\.61/;
const SNAPSHOT = JSON.stringify({ productBreakdown: { lines: [
  { key: "material", label: "Poseidon matte", amount: MONEY.material, source: "verified" },
  { key: "ink_cmyk", label: "CMYK ink", amount: MONEY.inkQuoted, source: "estimated" },
  { key: "application", label: "Bag-label application", amount: MONEY.application, source: "owner_standard" },
  { key: "weeding", label: "Weeding — not required", amount: 0, source: "excluded" },
  { key: "cutting", label: "Cutting", amount: 7.77, source: "missing" },
  { key: "packing", label: "Packing", amount: MONEY.packing, source: "owner_standard" },
] } });

const T0 = new Date("2026-11-20T01:00:00Z");
const table = (name: string) => (h.t[name] = h.t[name] || []);

function seed() {
  h.t = {}; h.seq = 0; h.writes = []; h.chain = Promise.resolve();
  h.t.productionJob = [{
    id: "j1", shop: "shop-1", active: true, status: "printing", jobTicket: JOB, customerName: "Sam", company: "Krud Cafe", priority: "rush", assignedTo: "Dana", dueDate: new Date("2026-12-05T12:00:00Z"),
    sourceType: "manual", quoteId: null, orderGid: null, quoteNumber: null, proofApprovalToken: null, proofStatus: "draft", internalNotes: "", fulfillmentState: null,
    quotedTrueCost: MONEY.quotedTrueCost, actualCostFinalized: false, createdAt: T0, updatedAt: T0,
  }];
  h.t.productionJobItem = [
    { id: "i1", shop: "shop-1", jobId: "j1", sortOrder: 0, itemTicket: `${JOB}-01`, ripJobName: `${JOB}-01`, productTitle: "HEATH pouch", quantity: 500, unitPrice: MONEY.unitPrice, unitCost: MONEY.unitCost, selectedFinish: "CMYK + Gloss", machineSummary: MIMAKI, costSnapshot: SNAPSHOT, priceSnapshot: null, lastReprintAt: null, qcResult: null, qcAt: null, reorderSourceItemId: "old1", reorderArtworkMode: "same_artwork" },
    { id: "i2", shop: "shop-1", jobId: "j1", sortOrder: 1, itemTicket: `${JOB}-02`, ripJobName: `${JOB}-02`, productTitle: "SHORTCAKES label", quantity: 250, unitPrice: MONEY.unitPrice, unitCost: MONEY.unitCost, selectedFinish: "White", machineSummary: ROLAND, costSnapshot: null, priceSnapshot: null, lastReprintAt: null, qcResult: null, qcAt: null },
    // the earlier job's item this job reorders (its job is archived, so it is not on the board)
    { id: "old1", shop: "shop-1", jobId: "jOld", sortOrder: 0, itemTicket: `${OLD}-01`, productTitle: "HEATH pouch", quantity: 300, unitPrice: 0, unitCost: 0 },
  ];
  h.t.productionJobFile = [
    ...["CMYK", "g"].map((layer, index) => ({ id: `f${index}`, shop: "shop-1", jobId: "j1", productionJobItemId: "i1", fileType: "print_file", assetSource: "nas", fileName: `${JOB}-01__crud_HEATH_F_${layer}.pdf`, fileUrl: `\\\\GSO-NAS\\Prints For Today\\${JOB}\\crud_HEATH_F_${layer}.pdf`, notes: "Prints For Today / Mimaki", createdAt: T0 })),
    { id: "f9", shop: "shop-1", jobId: "j1", productionJobItemId: null, fileType: "proof", assetSource: "manual", fileName: "Krud proof sheet.pdf", fileUrl: "https://files.gso.test/proof.pdf", createdAt: T0 },
    { id: "f8", shop: "shop-1", jobId: "j1", productionJobItemId: null, fileType: "other", assetSource: "nas", fileName: "customer brief.docx", fileUrl: "//GSO-NAS/Customer Files/brief.docx", createdAt: T0 },
  ];
  h.t.printIntake = [
    { id: "p1", shop: "shop-1", originalFilename: "crud_HEATH_F_CMYK.pdf", fileHashSha256: HASH_1, status: "routed", matchedProductionJobId: "j1", generatedProductionJobId: null, authoritativeTicket: `${JOB}-01`, productionJobItemId: "i1", printer: "mimaki", routedFilename: `${JOB}-01__crud_HEATH_F_CMYK`, attemptNumber: 1, revisionNumber: 1, reprintNumber: 0, reviewReason: null, rawParsedHints: JSON.stringify({ secretHint: "INTERNAL-PARSE-DUMP" }), receivedAt: T0, updatedAt: T0 },
    { id: "p2", shop: "shop-1", originalFilename: "crud_HEATH_F_g.pdf", fileHashSha256: HASH_2, status: "routed", matchedProductionJobId: "j1", generatedProductionJobId: null, authoritativeTicket: `${JOB}-01`, productionJobItemId: "i1", printer: "mimaki", routedFilename: `${JOB}-01__crud_HEATH_F_g`, attemptNumber: 1, revisionNumber: 1, reprintNumber: 0, reviewReason: null, rawParsedHints: null, receivedAt: T0, updatedAt: new Date(T0.getTime() + 1000) },
    // item 2: the file was matched to the job but the intake is holding it
    { id: "p3", shop: "shop-1", originalFilename: "shortcakes_w_MIMAKI.pdf", fileHashSha256: HASH_3, status: "review", matchedProductionJobId: "j1", generatedProductionJobId: null, authoritativeTicket: `${JOB}-02`, productionJobItemId: "i2", printer: null, routedFilename: null, attemptNumber: 1, revisionNumber: 1, reprintNumber: 0, reviewReason: "printer_assignment_contradiction", rawParsedHints: null, receivedAt: T0, updatedAt: T0 },
  ];
  h.t.machine = [{ id: "m1", shop: "shop-1", active: true, name: MIMAKI }];
  h.t.printLogEntry = [];
  h.t.productionJobEvent = [];
  h.t.productionRun = [];
  h.t.productionMaterialUsage = [];
  h.writes = [];
}
const pressResult = (id: string, name: string, cmyk: number, minutes: number, itemId = "i1") => ({ id, shop: "shop-1", importId: "imp", productionJobId: "j1", productionJobItemId: itemId, sourceJobName: name, machineName: MIMAKI, printerSoftware: "RasterLink", cmykInkMl: cmyk, whiteInkMl: 0, glossInkMl: 0, inkMl: cmyk, printMinutes: minutes, sqft: 10, createdAt: T0 });

beforeEach(() => { seed(); h.shop = "shop-1"; as("owner"); Object.assign(process.env, ENV); delete process.env.GSO_OWNER_ENFORCEMENT; delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS; delete process.env.GSO_MACHINE_RATE_PER_HOUR; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

/* ---------------- helpers ---------------- */

const get = (path: string) => new Request(`https://erp.test${path}`);
type Seen = { status: number; body: any };
const seen = async (call: () => Promise<any>): Promise<Seen> => {
  let out: any;
  try { out = await call(); } catch (thrown) { if (!(thrown instanceof Response)) throw thrown; out = thrown; }
  if (!(out instanceof Response)) return { status: 200, body: out };
  const text = await out.clone().text();
  try { return { status: out.status, body: JSON.parse(text) }; } catch { return { status: out.status, body: text }; }
};
const post = async (fields: Record<string, string>, role: Role = "print_operator"): Promise<Seen> => {
  as(role);
  const route = await import("../app/routes/app.erp.production-job.$id");
  return seen(() => route.action({ request: new Request("https://erp.test/app/erp/production-job/j1", { method: "POST", body: new URLSearchParams(fields) }) }));
};
const loadJob = async (role: Role) => {
  as(role);
  const page = await import("../app/routes/app.erp.production-job.$id");
  const result = await seen(() => page.loader({ request: get("/app/erp/production-job/j1"), params: { id: "j1" } }));
  expect(result.status).toBe(200);
  return { page, data: result.body };
};
const loadBoard = async (role: Role) => {
  as(role);
  const page = await import("../app/routes/app.erp.production-board");
  const result = await seen(() => page.loader({ request: get("/app/erp/production-board") }));
  expect(result.status).toBe(200);
  const body = result.body;
  const cards = [...body.board.columns.flatMap((column: any) => column.cards), ...body.board.attention.onHold, ...body.board.attention.reprintNeeded];
  return { page, data: body, card: cards.find((card: any) => card.id === "j1") };
};

function render(Component: any, loaderData: any, options: { path?: string; url?: string; role?: string } = {}): string {
  const path = options.path || "/page";
  const page = { id: "page", path: options.role ? path.replace(/^\//, "") : path, Component, loader: () => loaderData, action: () => null };
  const routes: any[] = options.role ? [{ id: "routes/app", path: "/", Component: Outlet, loader: () => ({ role: options.role }), children: [page] }] : [page];
  const shell = options.role ? { "routes/app": { role: options.role } } : {};
  const Stub = createRoutesStub(routes);
  const html = renderToString(createElement(AppProvider, { i18n: {} } as any, createElement(Stub, { initialEntries: [options.url || path], hydrationData: { loaderData: { ...shell, page: loaderData } } } as any)));
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
}
const words = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const JOB_ROUTE = { path: "/job/:id", url: "/job/j1" };
const src = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");

const runsOf = (itemId = "i1") => table("productionRun").filter((run) => run.itemId === itemId).sort((a, b) => a.runNumber - b.runNumber).map((run) => [run.runNumber, run.kind, run.quantity, run.status]);
const reprintEvents = () => table("productionJobEvent").filter((event) => event.eventType === "production_reprint_requested");
const qcResets = () => table("productionJobEvent").filter((event) => event.eventType === "qc_result" && /QC reset by reprint/.test(event.message));
const item = (id = "i1") => table("productionJobItem").find((row) => row.id === id)!;
const intakeState = () => JSON.stringify(table("printIntake").map((row) => [row.id, row.status, row.reprintNumber, row.routedFilename, row.rawParsedHints]));
const REQUEST_A = "3f0c6d0e-1111-4aaa-8bbb-000000000001";
const REQUEST_B = "3f0c6d0e-2222-4aaa-8bbb-000000000002";
const REPRINT = { intent: "reprintItem", jobId: "j1", itemId: "i1", reprintReason: "machine_error", reprintQty: "25", chargeType: "internal" };
const qcPass = (itemId = "i1") => post({ intent: "qcItem", jobId: "j1", itemId, qcResult: "pass" });

/* ====================================================================== */
/* FIX 12 — reprint request identity                                        */
/* ====================================================================== */

describe("FIX 12 · a reprint form sent twice records ONE run (requestId)", () => {
  it("sequential double submit BEFORE QC: the second answer is 200 'already recorded' and nothing is written", async () => {
    const first = await post({ ...REPRINT, requestId: REQUEST_A });
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(first.body.alreadyRecorded).toBeUndefined();
    expect(first.body.message).toContain("REPRINT RECORDED");
    expect(runsOf()).toEqual([[1, "original", 500, "reprinted"], [2, "reprint", 25, "open"]]);
    const before = { intake: intakeState(), events: table("productionJobEvent").length, reprintAt: item().lastReprintAt };
    h.writes = [];
    const again = await post({ ...REPRINT, requestId: REQUEST_A });
    expect(again).toMatchObject({ status: 200, body: { ok: true, alreadyRecorded: true } });
    expect(again.body.message).toMatch(/^ALREADY RECORDED — this reprint of .*P1-A1.*No second run was created/);
    expect(h.writes).toEqual([]);
    expect(runsOf()).toEqual([[1, "original", 500, "reprinted"], [2, "reprint", 25, "open"]]);
    expect(intakeState()).toBe(before.intake);
    expect(table("productionJobEvent")).toHaveLength(before.events);
    expect(item().lastReprintAt).toEqual(before.reprintAt);
  }, 120_000);

  it("the SAME request replayed AFTER QC was recorded: still 200 'already recorded' — no third run, QC is not reset, nothing is re-routed", async () => {
    await post({ ...REPRINT, requestId: REQUEST_A });
    expect((await qcPass()).body.ok).toBe(true);
    expect(item().qcResult).toBe("pass");
    expect(runsOf()[1]).toEqual([2, "reprint", 25, "qc_passed"]);
    const before = { intake: intakeState(), events: table("productionJobEvent").length };
    h.writes = [];
    const replay = await post({ ...REPRINT, requestId: REQUEST_A });
    expect(replay).toMatchObject({ status: 200, body: { ok: true, alreadyRecorded: true } });
    expect(h.writes).toEqual([]);
    expect(runsOf()).toHaveLength(2);
    expect(item().qcResult).toBe("pass"); // the QC PASS stands
    expect(qcResets()).toHaveLength(1); // only the one from the real reprint
    expect(intakeState()).toBe(before.intake); // no second re-route
    expect(table("productionJobEvent")).toHaveLength(before.events);
  }, 120_000);

  it("CONCURRENT double submit before QC: both answers are 200, exactly one created the run", async () => {
    const results = await Promise.all([post({ ...REPRINT, requestId: REQUEST_A }), post({ ...REPRINT, requestId: REQUEST_A })]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.map((result) => Boolean(result.body.alreadyRecorded)).sort()).toEqual([false, true]);
    expect(runsOf()).toEqual([[1, "original", 500, "reprinted"], [2, "reprint", 25, "open"]]);
    expect(reprintEvents()).toHaveLength(1);
    expect(qcResets()).toHaveLength(1);
    expect(table("printIntake").filter((row) => row.productionJobItemId === "i1").map((row) => row.reprintNumber)).toEqual([1, 1]);
  }, 120_000);

  it("CONCURRENT double submit of a second reprint AFTER QC: one run 3, both answers 200; and two concurrent replays of the old request change nothing", async () => {
    await post({ ...REPRINT, requestId: REQUEST_A });
    await qcPass();
    const results = await Promise.all([post({ ...REPRINT, requestId: REQUEST_B }), post({ ...REPRINT, requestId: REQUEST_B })]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.map((result) => Boolean(result.body.alreadyRecorded)).sort()).toEqual([false, true]);
    expect(runsOf().map((run) => run[0])).toEqual([1, 2, 3]);
    expect(reprintEvents()).toHaveLength(2);
    await qcPass();
    h.writes = [];
    const replays = await Promise.all([post({ ...REPRINT, requestId: REQUEST_A }), post({ ...REPRINT, requestId: REQUEST_A })]);
    expect(replays.map((result) => [result.status, result.body.alreadyRecorded])).toEqual([[200, true], [200, true]]);
    expect(h.writes).toEqual([]);
    expect(runsOf()).toHaveLength(3);
    expect(item().qcResult).toBe("pass");
  }, 120_000);

  it("a legitimately separate LATER reprint (new requestId, same quantity and reason) is a new run and needs a new QC PASS", async () => {
    await post({ ...REPRINT, requestId: REQUEST_A });
    await qcPass();
    const second = await post({ ...REPRINT, requestId: REQUEST_B });
    expect(second).toMatchObject({ status: 200, body: { ok: true } });
    expect(second.body.alreadyRecorded).toBeUndefined();
    expect(runsOf()).toEqual([[1, "original", 500, "reprinted"], [2, "reprint", 25, "qc_passed"], [3, "reprint", 25, "open"]]);
    expect(item().qcResult).toBeNull();
    expect(qcResets()).toHaveLength(2);
    // each run's request is kept with the run it created (in the reprint event — no new column)
    expect(reprintEvents().map((event) => JSON.parse(event.oldValue))).toEqual([
      { requestId: REQUEST_A, itemId: "i1", runNumber: 2, runLabel: "P1-A1" },
      { requestId: REQUEST_B, itemId: "i1", runNumber: 3, runLabel: "P2-A1" },
    ]);
    expect(src("prisma/schema.prisma")).not.toMatch(/requestId\s+String[\s\S]{0,400}model ProductionRun|model ProductionRun \{[^}]*requestId/);
  }, 120_000);

  it("the same requestId on a DIFFERENT item is not a replay; a requestId is matched exactly", async () => {
    await post({ ...REPRINT, requestId: REQUEST_A });
    const other = await post({ ...REPRINT, itemId: "i2", requestId: REQUEST_A });
    expect(other).toMatchObject({ status: 200, body: { ok: true } });
    expect(other.body.alreadyRecorded).toBeUndefined();
    expect(runsOf("i2").map((run) => run[0])).toEqual([1, 2]);
    // a longer id that merely CONTAINS an earlier one is a different request
    await qcPass();
    const longer = await post({ ...REPRINT, requestId: `${REQUEST_A}-x` });
    expect(longer.body.alreadyRecorded).toBeUndefined();
    expect(runsOf().map((run) => run[0])).toEqual([1, 2, 3]);
  }, 120_000);

  it("no requestId keeps the earlier behaviour: 409 before QC, a new run after QC; a malformed requestId is refused and writes nothing", async () => {
    expect((await post(REPRINT)).status).toBe(200);
    const replay = await post(REPRINT);
    expect(replay.status).toBe(409);
    expect(replay.body.message).toMatch(/already recorded/);
    await qcPass();
    expect((await post(REPRINT)).status).toBe(200);
    expect(runsOf().map((run) => run[0])).toEqual([1, 2, 3]);
    expect(reprintEvents().map((event) => event.oldValue)).toEqual([null, null]);
    await qcPass();
    h.writes = [];
    for (const bad of ["short", "has spaces in it", '{"requestId":"x"}', "a".repeat(121)]) {
      const refused = await post({ ...REPRINT, requestId: bad });
      expect(refused.status, bad).toBe(400);
    }
    expect(h.writes).toEqual([]);
    expect(runsOf()).toHaveLength(3);
  }, 120_000);

  it("who pays and the kind are still never assumed, with or without a requestId", async () => {
    const { chargeType: _omitted, ...noCharge } = REPRINT;
    const missing = await post({ ...noCharge, requestId: REQUEST_A });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/who pays/i);
    expect((await post({ ...REPRINT, runKind: "redo", requestId: REQUEST_A })).status).toBe(400);
    expect(runsOf()).toEqual([]);
    // the refused request created nothing, so the SAME id is free for the corrected form
    expect((await post({ ...REPRINT, requestId: REQUEST_A })).body).toMatchObject({ ok: true });
    expect(runsOf()).toHaveLength(2);
  }, 120_000);

  it("the request id: fresh per call, valid, and recognised only for its own item", () => {
    const ids = Array.from({ length: 50 }, () => newReprintRequestId());
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(isReprintRequestId(id)).toBe(true);
    for (const bad of ["", "abc", "x y z 12345", null, 12345678, "a".repeat(121)]) expect(isReprintRequestId(bad)).toBe(false);
    const events = [{ eventType: "production_reprint_requested", oldValue: reprintRequestRecord({ requestId: REQUEST_A, itemId: "i1", runNumber: 2, runLabel: "P1-A1" }) }, { eventType: "production_reprint_requested", oldValue: null }, { eventType: "note", oldValue: reprintRequestRecord({ requestId: REQUEST_B, itemId: "i1", runNumber: 9, runLabel: "P8-A1" }) }];
    expect(findReprintRequest(events, REQUEST_A, "i1")).toEqual({ requestId: REQUEST_A, itemId: "i1", runNumber: 2, runLabel: "P1-A1" });
    expect(findReprintRequest(events, REQUEST_A, "i2")).toBeNull();
    expect(findReprintRequest(events, REQUEST_B, "i1")).toBeNull(); // a note is not a reprint record
    expect(findReprintRequest(events, "nope-nope", "i1")).toBeNull();
  });

  it("both reprint forms send a requestId: the job page form (per form, renewed after a successful submit) and the advanced page form", async () => {
    const { page, data } = await loadJob("print_operator");
    const html = render(page.default, data, { ...JOB_ROUTE, role: "print_operator" });
    // one reprint form per item, each with its own requestId field; the server render carries no id (made in the browser)
    expect(html.match(/name="intent" value="reprintItem"\/><input type="hidden" name="jobId" value="j1"\/><input type="hidden" name="requestId" value=""\/>/g)).toHaveLength(2);
    // who pays is chosen, not pre-selected
    expect(html).toContain("Choose who pays");
    expect(html).toMatch(/<select name="chargeType" required=""[^>]*><option value="" disabled="" selected="">Choose who pays<\/option>/);
    const job = src("app/routes/app.erp.production-job.$id.tsx");
    expect(job).toContain('<ActionForm jobId={job.id} intent="reprintItem" hidden={{ itemId: String(item.id) }} idempotent>');
    expect(job).toContain('if (fetcher.state === "idle" && fetcher.data?.ok && idempotent) setRequestId(newReprintRequestId());');
    const advanced = src("app/routes/app.erp.production.tsx");
    expect(advanced).toMatch(/name="intent" value="reprintItem" \/>\s*<input type="hidden" name="jobId" value=\{job\.id\} \/>\s*<input type="hidden" name="itemId" value=\{item\.id\} \/>\s*<ReprintRequestId \/>/);
  }, 120_000);
});

/* ====================================================================== */
/* FIX 16 — run cost structure                                              */
/* ====================================================================== */

describe("FIX 16 · run cost: components with a basis, PARTIAL COST, separate totals, nothing invented", () => {
  const rates = buildBrandRates([{ name: MIMAKI }] as any);
  const runs: any[] = [
    { itemId: "i1", runNumber: 1, kind: "original", quantity: 500, runLabel: "A1" },
    { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, chargeType: "internal", runLabel: "P1-A1" },
    { itemId: "i1", runNumber: 3, kind: "remake", quantity: 10, chargeType: "warranty", runLabel: "P2-A1" },
    { itemId: "i1", runNumber: 4, kind: "reprint", quantity: 40, chargeType: "customer_paid", runLabel: "P3-A1" },
  ];
  const entries = [pressResult("e1", `${JOB}-01__a_CMYK`, 12, 30), pressResult("e2", `${JOB}-01__a_CMYK__P1-A1`, 1, 6), pressResult("e3", `${JOB}-01__a_CMYK__P2-A1`, 2, 12), pressResult("e4", `${JOB}-01__a_CMYK__P3-A1`, 4, 24)];

  it("ink and press time are ACTUAL; material and finishing are a labelled QUOTED ESTIMATE on the original run only", () => {
    const cost = runCostDollars(runs, entries, rates, 5, { costSnapshot: SNAPSHOT });
    const [original, internal, warranty, paid] = cost.runs;
    expect(original.components).toMatchObject({
      ink: { amount: 2.11, basis: "actual" }, // 12 mL x 0.176
      pressTime: { amount: 2.5, basis: "actual" }, // 30 min x $5/h
      material: { amount: MONEY.material, basis: "estimate" },
      finishing: { amount: MONEY.application, basis: "estimate" },
    });
    expect(original.components.material.note).toMatch(/QUOTED ESTIMATE .* not an actual/);
    expect(original.components.finishing.note).toMatch(/QUOTED ESTIMATE .* not an actual/);
    // the estimate is never part of the actual number
    expect(original.knownCost).toBe(4.61);
    expect(original.estimateCost).toBe(53.86);
    expect(cost.original).toBe(4.61);
    expect(cost.originalEstimate).toBe(53.86);
    // a reprint / remake never gets an estimate: nothing records material or finishing per run
    for (const run of [internal, warranty, paid]) {
      expect(run.components.material).toMatchObject({ amount: null, basis: "not_recorded" });
      expect(run.components.finishing).toMatchObject({ amount: null, basis: "not_recorded" });
      expect(run.components.material.note).toMatch(/not recorded per run/);
      expect(run.estimateCost).toBeNull();
      expect(run.complete).toBe(false);
      expect(run.costLabel).toBe(PARTIAL_COST_LABEL);
    }
    // estimate + actual is not "complete" and is not called partial either: it says exactly what it is
    expect(original.complete).toBe(false);
    expect(original.costLabel).toBe(ACTUAL_PLUS_ESTIMATE_LABEL);
    expect(cost.complete).toBe(false);
    expect(cost.costLabel).toBe(PARTIAL_COST_LABEL);
  });

  it("only real snapshot lines count: 'missing', 'excluded' and zero lines are not an estimate; ink, packing and unit cost are never used", () => {
    expect(quotedEstimateOf(SNAPSHOT)).toMatchObject({ material: MONEY.material, finishing: MONEY.application }); // cutting is "missing", weeding is "excluded"
    for (const empty of [null, "", "not json", JSON.stringify({ source: "pending_cost_book_mapping" }), JSON.stringify({ trueUnitCost: 0.31, unitCost: 0.31 }), JSON.stringify({ productBreakdown: { lines: [{ key: "material", amount: 0, source: "missing" }, { key: "ink_cmyk", amount: 9 }, { key: "packing", amount: 3 }] } })]) {
      expect(quotedEstimateOf(empty)).toEqual({ material: null, finishing: null, source: null });
    }
    const none = runCostDollars([], [entries[0]], rates, 5, { costSnapshot: JSON.stringify({ source: "pending_cost_book_mapping" }), jobMaterialRows: 2 });
    expect(none.runs[0].components.material).toMatchObject({ amount: null, basis: "not_recorded" });
    expect(none.runs[0].components.material.note).toMatch(/2 material-use row\(s\).*whole job, not per item or run/);
    expect(none.runs[0].components.finishing).toMatchObject({ amount: null, basis: "not_recorded" });
    expect(none.runs[0].costLabel).toBe(PARTIAL_COST_LABEL);
    expect(none.originalEstimate).toBeNull();
  });

  it("totals stay apart: original / shop-absorbed (internal AND warranty) / customer-paid — and no revenue anywhere", () => {
    const cost = runCostDollars(runs, entries, rates, 5, { costSnapshot: SNAPSHOT });
    expect(cost.runs.map((run) => [run.runNumber, run.costClass, run.chargeType, run.knownCost])).toEqual([
      [1, "original", null, 4.61],
      [2, "internal_extra", "internal", 0.68], // 1 x 0.176 + 6 min x $5/h
      [3, "internal_extra", "warranty", 1.35], // 2 x 0.176 + 12 min
      [4, "customer_paid_extra", "customer_paid", 2.7], // 4 x 0.176 + 24 min
    ]);
    expect([cost.original, cost.shopAbsorbed, cost.shopAbsorbedInternal, cost.shopAbsorbedWarranty, cost.customerPaid]).toEqual([4.61, 2.03, 0.68, 1.35, 2.7]);
    expect(cost.revenueChange).toBe("none");
    expect(JSON.stringify(cost)).not.toMatch(/revenue"\s*:\s*\d|charged"\s*:\s*\d|invoice/i);
    expect(cost.runs[3].treatment).toMatch(/the ERP charges nothing/);
  });

  it("a run with no press result is listed and says so; an item with nothing at all still gets its original line — PARTIAL COST, no number invented", () => {
    const waiting = runCostDollars(runs.slice(0, 2), [entries[0]], rates, 5);
    expect(waiting.runs.map((run) => run.label)).toEqual(["Run 1 — Original", "Run 2 — Reprint"]);
    expect(waiting.runs[1]).toMatchObject({ entries: 0, knownCost: 0, inkCost: null, complete: false, costLabel: PARTIAL_COST_LABEL });
    expect(waiting.runs[1].components.ink).toEqual({ amount: null, basis: "not_recorded", note: "No press result received for this run yet." });
    expect(waiting.runs[1].components.pressTime).toEqual({ amount: null, basis: "not_recorded", note: "No press result received for this run yet." });
    const empty = runCostDollars([], [], rates, 5);
    expect(empty.runs).toHaveLength(1);
    expect(empty.runs[0]).toMatchObject({ label: "Run 1 — Original", knownCost: 0, costLabel: PARTIAL_COST_LABEL, complete: false });
    expect(Object.values(empty.runs[0].components).map((component) => [component.amount, component.basis])).toEqual([[null, "not_recorded"], [null, "not_recorded"], [null, "not_recorded"], [null, "not_recorded"]]);
    // a press result that cannot be costed is not given an invented ink cost
    const unknown = runCostDollars([], [{ ...entries[0], machineName: null, printerSoftware: null, sourceJobName: "mystery_file" } as any], rates, 5);
    expect(unknown.runs[0].components.ink).toMatchObject({ amount: null, basis: "not_recorded" });
    expect(unknown.runs[0].costLabel).toBe(PARTIAL_COST_LABEL);
    const source = src("app/lib/run-cost-dollars.server.ts");
    expect(source).not.toMatch(/db\.|prisma|applicationSeconds|labou?rRate\s*=|unitCost|unitPrice/);
  });

  it("job page, owner: an item with NO reprint shows its run cost; a reprint shows the separate totals", async () => {
    table("printLogEntry").push(pressResult("e1", `${JOB}-01__crud_HEATH_F_CMYK`, 12, 30));
    table("productionMaterialUsage").push({ id: "u1", shop: "shop-1", jobId: "j1", materialName: "Poseidon matte", unit: "sqft", usedQty: 40, totalCost: MONEY.usageCost, costPerUnit: 1.661, source: "manual", createdAt: T0 });
    const first = await loadJob("owner");
    expect(first.data.showFinancials).toBe(true);
    expect(first.data.job.items[0].runs).toEqual([]); // no reprint yet
    expect(first.data.job.items[0].runCosts).toMatchObject({ original: 4.61, shopAbsorbed: 0, customerPaid: 0, originalEstimate: 53.86, complete: false });
    // item 2 has no press result and no snapshot: it still has a cost line, with nothing in it
    expect(first.data.job.items[1].runCosts.runs[0]).toMatchObject({ label: "Run 1 — Original", knownCost: 0, costLabel: PARTIAL_COST_LABEL });
    const text = words(render(first.page.default, first.data, { ...JOB_ROUTE, role: "owner" }));
    for (const phrase of [
      "RUN COST — PARTIAL COST", "Run 1 — Original — ACTUAL PRESS COST + QUOTED ESTIMATE · actual so far $4.61",
      "Ink: $2.11 (actual)", "Press time: $2.50 (actual)", "Material: $41.57 (QUOTED ESTIMATE — not an actual)", "Finishing: $12.29 (QUOTED ESTIMATE — not an actual)",
      "The job has 1 material-use row(s); they are recorded for the whole job, not per item or run, so they are not split here.",
      "Run 1 — Original — PARTIAL COST · actual so far $0.00", "Ink: not recorded — No press result received for this run yet.", "Material: not recorded",
      "Original run, actual: $4.61", "Quoted estimate for the original run (material + finishing): $53.86 — an estimate, not in the actual totals above.",
      "Customer-paid replacement, actual: $0.00. Nothing was charged and no revenue is added here.", "Labour is not included in any line.",
    ]) expect(text, phrase).toContain(phrase);
    // the job-level material dollars are never split into a run
    expect(JSON.stringify(first.data.job.items.map((row: any) => row.runCosts))).not.toContain(String(MONEY.usageCost));

    // a shop-absorbed reprint and its press result
    expect((await post({ ...REPRINT, requestId: REQUEST_A }, "owner")).body.ok).toBe(true);
    table("printLogEntry").push(pressResult("e2", `${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, 1, 6));
    const second = await loadJob("owner");
    expect(second.data.job.items[0].runCosts).toMatchObject({ original: 4.61, shopAbsorbed: 0.68, shopAbsorbedInternal: 0.68, shopAbsorbedWarranty: 0, customerPaid: 0 });
    const after = words(render(second.page.default, second.data, { ...JOB_ROUTE, role: "owner" }));
    for (const phrase of ["Run 2 — Reprint — PARTIAL COST · actual so far $0.68", "Material: not recorded — Material is not recorded per run.", "Reprints absorbed by the shop (internal + warranty), actual: $0.68 (internal $0.68 · warranty $0.00). No revenue."]) expect(after, phrase).toContain(phrase);
  }, 120_000);

  it("REDACTION: print operator and bagger receive no run cost, no snapshot and no dollar sign — in the payload or on the screen", async () => {
    table("printLogEntry").push(pressResult("e1", `${JOB}-01__crud_HEATH_F_CMYK`, 12, 30));
    table("productionMaterialUsage").push({ id: "u1", shop: "shop-1", jobId: "j1", materialName: "Poseidon matte", unit: "sqft", usedQty: 40, totalCost: MONEY.usageCost, costPerUnit: 1.661, source: "manual", createdAt: T0 });
    await post({ ...REPRINT, requestId: REQUEST_A }, "print_operator");
    table("printLogEntry").push(pressResult("e2", `${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, 1, 6));
    for (const role of ["print_operator", "bagger"] as Role[]) {
      const { page, data } = await loadJob(role);
      expect(data.showFinancials).toBe(false);
      for (const row of data.job.items) expect([row.runCosts ?? null, row.costSnapshot, row.unitCost, row.unitPrice]).toEqual([null, null, null, null]);
      const payload = JSON.stringify(data);
      expect(payload, role).not.toMatch(MONEY_TEXT);
      expect(payload, role).not.toMatch(/0\.68|runCosts":\{|QUOTED ESTIMATE|knownCost/);
      // the operational numbers stay: mL and minutes per run
      expect(data.job.items[0].runActuals.map((row: any) => [row.label, row.inkMl, row.printMinutes])).toEqual([["Run 1 — Original", 12, 30], ["Run 2 — Reprint", 1, 6]]);
      const html = render(page.default, data, { ...JOB_ROUTE, role });
      expect(html, role).not.toMatch(/\$\s?\d/);
      expect(html, role).not.toMatch(MONEY_TEXT);
      expect(html, role).not.toMatch(/RUN COST|QUOTED ESTIMATE|PARTIAL COST|actual so far/);
      expect(words(html)).toContain("Run 1 — Original: 12.0 mL · 30.0 min");
    }
    // the redaction function itself drops the whole structure
    const cost = runCostDollars([], [], [], 5, { costSnapshot: SNAPSHOT });
    expect(redactJobFinancials({ items: [{ id: "i1", runCosts: cost, costSnapshot: SNAPSHOT }] }).items[0]).toMatchObject({ runCosts: null, costSnapshot: null });
    expect(src("app/routes/app.erp.production.tsx")).toContain("if (financials.show) item.runCosts = runCostDollars(");
  }, 120_000);
});

/* ====================================================================== */
/* FIX 18 — Production Board card                                           */
/* ====================================================================== */

describe("FIX 18 · board card on a multi-item, two-press job", () => {
  const CARD_KEYS = ["activeRunLabel", "assignedTo", "awaitingFiles", "customer", "dueDate", "filesLabel", "finish", "fulfillmentLabel", "holdReason", "id", "itemCount", "machine", "next", "nextTone", "overdue", "priority", "product", "qcLabel", "quantity", "reorder", "reprintLabel", "stage", "status", "statusLabel", "updatedAt"];

  it("the card's fields are unchanged (no new field, no ticket, no money); a held file is counted in the file state", async () => {
    const { card, data } = await loadBoard("print_operator");
    expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
    expect(card).toMatchObject({ customer: "Krud Cafe", product: "HEATH pouch (+1 more)", itemCount: 2, quantity: 750, priority: "rush", assignedTo: "Dana", machine: `${MIMAKI}, ${ROLAND}`, finish: "CMYK + Gloss, White", awaitingFiles: true, filesLabel: "Awaiting files for 1 of 2 items · 1 file(s) held", reorder: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(JOB); // owner rule: the job ticket is on the job page, not on the card
    expect(text).not.toMatch(MONEY_TEXT);
    expect(text).not.toMatch(/unitPrice|unitCost|costSnapshot|runCosts|intakeFiles|fileHash|rawParsedHints|GSO-NAS/);
    expect((await loadBoard("owner")).card).toEqual(card);
    // with nothing held the file state reads exactly as before
    table("printIntake").find((row) => row.id === "p3")!.status = "routed";
    expect((await loadBoard("print_operator")).card.filesLabel).toBe("Awaiting files for 1 of 2 items");
  }, 120_000);

  it("the screen says a summed quantity is a sum, and shows both presses and both finishes in full (not cut off in a half-width cell)", async () => {
    const { page, data, card } = await loadBoard("print_operator");
    expect(boardCardDisplay(card)).toEqual({
      quantityLabel: "Quantity (all items)", quantityValue: "750 across 2 items",
      machineLabel: "Printers (2 — differs by item)", machineValue: `${MIMAKI} + ${ROLAND}`, machineWrap: true,
      finishLabel: "Finishes (differs by item)", finishValue: "CMYK + Gloss · White", finishWrap: true, holdLine: "",
    });
    const html = render(page.default, data, { path: "/board", role: "print_operator" });
    const text = words(html);
    for (const phrase of ["Krud Cafe", "RUSH", "HEATH pouch (+1 more)", "Quantity (all items)", "750 across 2 items", "Items 2", "Printers (2 — differs by item)", `${MIMAKI} + ${ROLAND}`, "Finishes (differs by item)", "CMYK + Gloss · White", "Assigned to Dana", "Dec 5", "Awaiting files for 1 of 2 items · 1 file(s) held", "QC 0/2", "Reorder of an earlier item", "OPEN JOB"]) expect(text, phrase).toContain(phrase);
    // the two list lines take the full card width and wrap
    expect(html).toMatch(/grid-column:1 \/ -1"><div[^>]*>Printers \(2 — differs by item\)<\/div><div style="[^"]*overflow-wrap:anywhere/);
    expect(html).not.toContain(JOB);
    expect(html).not.toMatch(/\$\s?\d/);
  }, 120_000);

  it("a one-item or same-press job reads exactly as before; a hold with no written reason still says so", async () => {
    expect(boardCardDisplay({ quantity: 500, itemCount: 1, machine: MIMAKI, finish: "CMYK", status: "printing", holdReason: "" })).toEqual({
      quantityLabel: "Quantity", quantityValue: "500", machineLabel: "Machine", machineValue: MIMAKI, machineWrap: false, finishLabel: "Finish", finishValue: "CMYK", finishWrap: false, holdLine: "",
    });
    expect(boardCardDisplay({ quantity: 0, itemCount: 0, machine: "", finish: "", status: "new", holdReason: "" })).toMatchObject({ quantityValue: "Not set", machineValue: "Not assigned", finishValue: "Not set" });
    expect(boardCardDisplay({ quantity: 750, itemCount: 2, machine: MIMAKI, finish: "CMYK", status: "on_hold", holdReason: "" })).toMatchObject({ quantityValue: "750 across 2 items", machineLabel: "Machine", holdLine: "Hold: no reason written — open the job and add a note" });
    expect(boardCardDisplay({ quantity: 1, itemCount: 1, machine: MIMAKI, finish: "CMYK", status: "on_hold", holdReason: "Waiting on the customer's logo" }).holdLine).toBe("Hold: Waiting on the customer's logo");
    // open run, QC, hold reason and packed-and-waiting on the real card
    await post({ ...REPRINT, requestId: REQUEST_A });
    expect((await loadBoard("print_operator")).card).toMatchObject({ activeRunLabel: "Run 2 · Reprint · 25 pcs", reprintLabel: "1 reprint(s) · 25 pcs", qcLabel: "QC needed after reprint" });
    await post({ intent: "addNote", jobId: "j1", note: "Waiting on the customer's logo" });
    await post({ intent: "changeStatus", jobId: "j1", status: "on_hold" });
    const held = await loadBoard("print_operator");
    expect(held.card).toMatchObject({ status: "on_hold", holdReason: "Waiting on the customer's logo" });
    expect(words(render(held.page.default, held.data, { path: "/board", role: "print_operator" }))).toContain("Hold: Waiting on the customer's logo");
  }, 120_000);
});

/* ====================================================================== */
/* FIX 19 + 23 — job page production readiness and stage trail              */
/* ====================================================================== */

describe("FIX 19 / 23 · job page: per-item files, routing, runs, QC — in floor words", () => {
  it("the loader adds only read-only intake facts: no path, no parsed hints, no full fingerprint, no money", async () => {
    h.writes = [];
    const { data } = await loadJob("print_operator");
    expect(h.writes).toEqual([]); // the loader writes nothing
    expect(data.job.intakeFiles).toEqual([
      { itemId: "i1", fileName: "crud_HEATH_F_CMYK.pdf", layer: "CMYK", state: "routed", stateLabel: "Routed to the printer", routedName: `${JOB}-01__crud_HEATH_F_CMYK`, printer: "mimaki", destination: "Mimaki hot folder", heldReason: "", runLabel: "Attempt 1", sha8: "a1b2c3d4", receivedAt: T0.toISOString() },
      { itemId: "i2", fileName: "shortcakes_w_MIMAKI.pdf", layer: "White", state: "held", stateLabel: "Held for review", routedName: "", printer: "", destination: "", heldReason: "Filename printer tag contradicts the press assigned in the ERP.", runLabel: "Attempt 1", sha8: "77aa66bb", receivedAt: T0.toISOString() },
      { itemId: "i1", fileName: "crud_HEATH_F_g.pdf", layer: "Gloss", state: "routed", stateLabel: "Routed to the printer", routedName: `${JOB}-01__crud_HEATH_F_g`, printer: "mimaki", destination: "Mimaki hot folder", heldReason: "", runLabel: "Attempt 1", sha8: "0f9e8d7c", receivedAt: T0.toISOString() },
    ]);
    const payload = JSON.stringify(data);
    for (const secret of [HASH_1, HASH_2, HASH_3, "INTERNAL-PARSE-DUMP", "rawParsedHints", "fileHashSha256", "secretHint"]) expect(payload, secret).not.toContain(secret);
    expect(payload).not.toMatch(MONEY_TEXT);
    // reorder lineage: the earlier item, with the job it lives on
    expect(data.job.items[0].reorderOf).toEqual({ itemTicket: `${OLD}-01`, productTitle: "HEATH pouch", quantity: 300, jobId: "jOld", artworkMode: "same_artwork" });
  }, 120_000);

  it("the screen: item ticket + copy, which files belong to which item, layers, printer, routed name and destination, the held file and why, lineage link", async () => {
    const { page, data } = await loadJob("print_operator");
    const html = render(page.default, data, { ...JOB_ROUTE, role: "print_operator" });
    const text = words(html);
    for (const phrase of [
      "Job folder name", JOB, "Copy job folder name", `${JOB}-01`, `${JOB}-02`, "Copy item ticket",
      `Finish: CMYK + Gloss · Printer: ${MIMAKI} · Layers needed: CMYK + Gloss`, `Finish: White · Printer: ${ROLAND} · Layers needed: CMYK + White`,
      "Current run: Run 1 — Original",
      // item 1 trail
      "Files: File matched — 2 print file(s)", "Expected: CMYK + Gloss", "Routed: Routed — Mimaki hot folder", `${JOB}-01__crud_HEATH_F_CMYK → Mimaki hot folder`, `${JOB}-01__crud_HEATH_F_g → Mimaki hot folder`, "Press result: No press result yet", "QC: Not checked yet", "Ready: Not packed yet", "Complete: Not completed",
      // item 1 files, with their layer
      "Files for this item (2)", `${JOB}-01__crud_HEATH_F_CMYK.pdf · Production file · CMYK layer · on the shop NAS`, `${JOB}-01__crud_HEATH_F_g.pdf · Production file · Gloss layer · on the shop NAS`,
      "At the print intake", `crud_HEATH_F_CMYK.pdf · CMYK layer · Routed to the printer · routed name ${JOB}-01__crud_HEATH_F_CMYK → Mimaki hot folder · Attempt 1 · file id a1b2c3d4`,
      // item 2: held, and why
      "Files: File held — not at the printer (1)", "shortcakes_w_MIMAKI.pdf: Filename printer tag contradicts the press assigned in the ERP.", "Routed: Will go to: Roland VersaWorks input",
      "shortcakes_w_MIMAKI.pdf · White layer · Held for review · Filename printer tag contradicts the press assigned in the ERP. · Attempt 1 · file id 77aa66bb",
      // job-level files are named as such
      "Whole job — not tied to one item", "Krud proof sheet.pdf · Proof", "customer brief.docx · Other file · on the shop NAS",
      // the one line under the next step names the held file
      "File held: shortcakes_w_MIMAKI.pdf — Filename printer tag contradicts the press assigned in the ERP.. It is not at the printer.",
      "QC, reprint / remake and each item's run history are in step 4 (QC).",
    ]) expect(text, phrase).toContain(phrase);
    // a NAS path is never a link: only the web proof is
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(links.filter((href) => /GSO-NAS|\\\\|^\/\//.test(href))).toEqual([]);
    expect(links.filter((href) => href === "https://files.gso.test/proof.pdf").length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("GSO-NAS\\Prints For Today"); // the path itself is not printed either
    // reorder lineage opens the earlier job's page
    expect(html).toMatch(new RegExp(`Reorder of <a[^>]*href="/app/erp/production-job/jOld"[^>]*>${OLD}-01</a> \\(earlier quantity 300\\)`));
    // no debug internals
    for (const secret of [HASH_1, HASH_3, "INTERNAL-PARSE-DUMP", "printer_assignment_contradiction", "retry_allowed"]) expect(html, secret).not.toContain(secret);
    expect(html).not.toMatch(/\$\s?\d/);
  }, 120_000);

  it("the trail moves with the job: reprint routed back, result per run, QC, ready, shipped, complete", async () => {
    table("printIntake").find((row) => row.id === "p3")!.status = "routed";
    Object.assign(table("printIntake").find((row) => row.id === "p3")!, { printer: "roland", routedFilename: `${JOB}-02__shortcakes_w`, reviewReason: null });
    table("productionJobFile").push({ id: "f2", shop: "shop-1", jobId: "j1", productionJobItemId: "i2", fileType: "print_file", assetSource: "nas", fileName: `${JOB}-02__shortcakes_w.pdf`, fileUrl: "Z:\\Prints For Today\\x.pdf", createdAt: T0 });
    table("printLogEntry").push(pressResult("e1", `${JOB}-01__crud_HEATH_F_CMYK`, 12, 30));
    const trail = async (index = 0) => { const { data } = await loadJob("print_operator"); return Object.fromEntries(itemStageTrail(data.job, data.job.items[index]).map((stage) => [stage.key, [stage.state, stage.text]])); };
    expect(await trail(0)).toMatchObject({ files: ["done", "File matched — 2 print file(s)"], routed: ["done", "Routed — Mimaki hot folder"], press: ["done", "Result received — 1 run(s)"], qc: ["waiting", "Not checked yet"], ready: ["upcoming", "Not packed yet"], complete: ["upcoming", "Not completed"] });
    expect(await trail(1)).toMatchObject({ files: ["done", "File matched — 1 print file(s)"], routed: ["done", "Routed — Roland VersaWorks input"], press: ["waiting", "No press result yet"] });

    // reprint of item 1: both layers go back, the open run is the current run, its result is awaited
    await post({ ...REPRINT, requestId: REQUEST_A });
    const reprinting = await loadJob("print_operator");
    const stages = itemStageTrail(reprinting.data.job, reprinting.data.job.items[0]);
    expect(stages.find((stage) => stage.key === "routed")).toMatchObject({ state: "waiting", text: "Going back to the printer", details: [`${JOB}-01__crud_HEATH_F_CMYK__P1-A1 → Mimaki hot folder (Reprint 1 · Attempt 1)`, `${JOB}-01__crud_HEATH_F_g__P1-A1 → Mimaki hot folder (Reprint 1 · Attempt 1)`] });
    expect(stages.find((stage) => stage.key === "press")).toMatchObject({ state: "waiting", text: "Waiting for the press result of run 2", details: ["Run 1 — Original: 12.0 mL · 30.0 min"] });
    expect(stages.find((stage) => stage.key === "qc")).toMatchObject({ state: "waiting", text: "Requires new QC after reprint" });
    const text = words(render(reprinting.page.default, reprinting.data, { ...JOB_ROUTE, role: "print_operator" }));
    for (const phrase of ["Current run: Run 2 — Reprint · 25 pcs · waiting for QC", "Reprint open: Run 2 · Reprint · 25 pcs. It needs a new QC PASS before the job can ship.", "Run 2 — Reprint · 25 pcs · Machine error · Internal — no charge · Waiting for QC"]) expect(text, phrase).toContain(phrase);

    // the reprint's press result arrives, QC passes on both items
    table("printLogEntry").push(pressResult("e2", `${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, 1, 6));
    await qcPass("i1"); await qcPass("i2");
    expect(await trail(0)).toMatchObject({ press: ["done", "Result received — 2 run(s)"], qc: ["done", "QC PASS"], ready: ["waiting", "Not packed yet"] });
    // packed and waiting -> shipped -> complete
    expect((await post({ intent: "markFulfillmentReady", jobId: "j1", kind: "ship" })).body.ok).toBe(true);
    expect(await trail(0)).toMatchObject({ ready: ["done", "Ready to ship"], complete: ["waiting", "Not completed"] });
    expect((await post({ intent: "recordShipment", jobId: "j1", carrier: "UPS", trackingNumber: "1Z999", packageCount: "1", shipDate: "2026-11-20" })).body.ok).toBe(true);
    expect(await trail(0)).toMatchObject({ ready: ["done", "Shipped"] });
    expect((await post({ intent: "changeStatus", jobId: "j1", status: "completed" })).body.ok).toBe(true);
    const done = await trail(0);
    expect(Object.values(done).map((stage: any) => stage[0])).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(done.complete).toEqual(["done", "Completed"]);
  }, 120_000);

  it("pure pieces: layer and destination words; an unknown intake status is shown as held, never as routed", () => {
    expect([fileLayerOf("crud_HEATH_F_CMYK.pdf"), fileLayerOf(`${JOB}-01__crud_HEATH_F_g__P1-A1.pdf`), fileLayerOf("crud_HEATH_F_GLOSS.pdf"), fileLayerOf("x_art_w.pdf"), fileLayerOf("White_Rabbit_art.pdf"), fileLayerOf("plain.pdf"), fileLayerOf("\\\\NAS\\folder_g\\crud_HEATH_F_CMYK.pdf")]).toEqual(["CMYK", "Gloss", "Gloss", "White", "", "", "CMYK"]);
    expect([printerDestination("mimaki"), printerDestination(MIMAKI), printerDestination("roland"), printerDestination(ROLAND), printerDestination(""), printerDestination("Summa cutter")]).toEqual(["Mimaki hot folder", "Mimaki hot folder", "Roland VersaWorks input", "Roland VersaWorks input", "", ""]);
    const view = toIntakeFileView({ originalFilename: "C:\\drop\\a_CMYK.pdf", status: "something_new", reviewReason: "copy_verify_failed", routedFilename: "should-not-show", printer: "roland", fileHashSha256: HASH_1, revisionNumber: 2, reprintNumber: 1, attemptNumber: 3, authoritativeTicket: `${JOB}-02` }, new Map([[`${JOB}-02`, "i2"]]));
    expect(view).toMatchObject({ itemId: "i2", fileName: "a_CMYK.pdf", state: "held", stateLabel: "Held for review", routedName: "", heldReason: "copy_verify_failed", runLabel: "Revision 2 · Reprint 1 · Attempt 3", sha8: "a1b2c3d4" });
    expect(JSON.stringify(view)).not.toContain(HASH_1);
  });
});

/* ====================================================================== */
/* FIX 24 — the first-real-job path, end to end                             */
/* ====================================================================== */

describe("FIX 24 · New Job → job page → files → reprint → QC → ready → shipment → complete", () => {
  it("New Job (multi-item) answers with the job to open and every item ticket; the page offers OPEN THIS JOB and names the folder", async () => {
    as("print_operator");
    const page = await import("../app/routes/app.erp.production-new");
    const send = () => seen(() => page.action({ request: new Request("https://erp.test/app/erp/production-new", { method: "POST", body: new URLSearchParams({ intent: "createManualJob", requestId: "new-job-request-0001", customerName: "Walk-in — Jane D.", itemTitle: "HEATH pouch", quantity: "128", family: "default", finish: "CMYK", moreItems: "SHORTCAKES pouch | 64" }) }) }));
    const created = await send();
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, manualJob: { itemCount: 2 } });
    const jobId = created.body.manualJob.jobId;
    expect(table("productionJob").map((job) => job.id)).toContain(jobId);
    expect(created.body.manualJob.itemTickets).toHaveLength(2);
    // the same form sent again is the same job (existing rule) — and still names it
    const again = await send();
    expect(again.body.manualJob.jobId).toBe(jobId);
    expect(table("productionJob")).toHaveLength(2); // the seeded job + this one
    const source = src("app/routes/app.erp.production-new.tsx");
    for (const phrase of ["OPEN THIS JOB", "navigate(jobWorkspaceHref(result.manualJob.jobId))", "result.manualJob.itemTickets", "make a folder named <b>{result.manualJob.jobTicket}</b>", "Go to the Production Board"]) expect(source, phrase).toContain(phrase);
    // the new job opens, and tells the person what it is waiting for
    const createdRow = table("productionJob").find((job) => job.id === jobId)!;
    if (createdRow.active === undefined) createdRow.active = true; // the double has no column defaults (schema: active @default(true))
    as("print_operator");
    const jobPage = await import("../app/routes/app.erp.production-job.$id");
    const opened = await seen(() => jobPage.loader({ request: get(`/app/erp/production-job/${jobId}`), params: { id: jobId } }));
    expect(opened.status).toBe(200);
    const text = words(render(jobPage.default, opened.body, { path: "/job/:id", url: `/job/${jobId}`, role: "print_operator" }));
    const ticket = created.body.manualJob.jobTicket;
    for (const phrase of [`make a folder named ${ticket}`, "Awaiting files", "Files: Waiting for files — CMYK expected", "HEATH pouch · Qty 128", "SHORTCAKES pouch · Qty 64", "start each file name with its item ticket below"]) expect(text, phrase).toContain(phrase);
    expect(text).not.toMatch(/\$\s?\d/);
  }, 120_000);

  it("the one line under NEXT STEP follows the REAL statuses (it used to name statuses that do not exist)", () => {
    const base = (over: Record<string, any> = {}) => ({ id: "j", status: "new", jobTicket: JOB, events: [], checklistItems: [], files: [{ id: "f", fileType: "print_file", assetSource: "nas", productionJobItemId: "i", fileName: "x_CMYK.pdf" }], items: [{ id: "i", itemTicket: `${JOB}-01`, productTitle: "A", quantity: 10, selectedFinish: "CMYK", machineSummary: MIMAKI }], ...over });
    for (const status of ["new", "prepress", "proof_approved", "ready_to_print"]) expect(jobAssistLine(base({ status })), status).toBe("Print files received and sent to the printer. Print them, then mark the job printed.");
    for (const status of ["proof_needed", "proof_sent"]) expect(jobAssistLine(base({ status })), status).toBe("Print files received and sent to the printer. Wait for the proof approval before printing.");
    for (const status of ["printing", "cutting", "laminating", "qc", "packing"]) expect(jobAssistLine(base({ status })), status).toBe("QC 0/1. Every item needs QC PASS before it can be packed and shipped.");
    // dead ends that had no words
    expect(jobAssistLine(base({ status: "reprint_needed" }))).toMatch(/^Start the reprint under NEEDS REPRINT in the QC step/);
    expect(jobAssistLine(base({ status: "on_hold" }))).toBe("No hold reason was written. Add a note saying why, so the next person knows.");
    expect(jobAssistLine(base({ status: "on_hold", events: [{ eventType: "status_change", newValue: "on_hold", oldValue: "printing", createdAt: "2026-11-20T03:00:00Z" }, { eventType: "note", message: "Roll ran out", createdAt: "2026-11-20T03:01:00Z" }] }))).toBe("Hold reason: Roll ran out");
    expect(jobAssistLine(base({ intakeFiles: [{ itemId: "i", fileName: "x_w.pdf", state: "held", heldReason: "Manually placed in review." }] }))).toMatch(/^File held: x_w\.pdf — Manually placed in review\.\. It is not at the printer\./);
    // unchanged lines
    expect(jobAssistLine(base({ files: [] }))).toContain(`make a folder named ${JOB}`);
    expect(jobAssistLine(base({ status: "shipped" }))).toContain("Mark the job Completed");
    expect(jobAssistLine(base({ status: "completed" }))).toBe("");
    // and the board card built from the same job carries no new field
    expect(Object.keys(toBoardCard(base())).sort()).toHaveLength(25);
  });

  it("a bagger who records 'Needs reprint' is told who starts it (the bagger has no reprint control)", async () => {
    const answer = await post({ intent: "qcItem", jobId: "j1", itemId: "i1", qcResult: "reprint_required" }, "bagger");
    expect(answer.body).toMatchObject({ ok: true });
    expect(answer.body.message).toMatch(/needs a reprint\. A print operator, a manager or the owner starts it under NEEDS REPRINT/);
    expect((await post({ ...REPRINT, requestId: REQUEST_A }, "bagger")).status).toBe(403);
    expect(runsOf()).toEqual([]);
    const { page, data } = await loadJob("bagger");
    const html = render(page.default, data, { ...JOB_ROUTE, role: "bagger" });
    expect(html).not.toContain("START REPRINT");
    expect(words(html)).toContain("QC PASS");
  }, 120_000);

  it("the whole path on one job: reprint → QC → ready → pickup → complete, with no blocked step", async () => {
    table("printIntake").find((row) => row.id === "p3")!.status = "routed";
    // QC is required before ready / pickup (the guard answers in plain words, not a dead end)
    const early = await post({ intent: "markFulfillmentReady", jobId: "j1", kind: "pickup" });
    expect(early.body.ok).toBe(false);
    expect(String(early.body.message)).toMatch(/QC PASS/);
    expect((await post({ ...REPRINT, requestId: REQUEST_A })).body.ok).toBe(true);
    expect((await post({ intent: "recordPickup", jobId: "j1", pickedUpBy: "Sam" })).body.ok).toBe(false); // reprint not QC'd yet
    await qcPass("i1"); await qcPass("i2");
    expect((await post({ intent: "markFulfillmentReady", jobId: "j1", kind: "pickup" })).body.ok).toBe(true);
    expect((await post({ intent: "recordPickup", jobId: "j1", pickedUpBy: "Sam" }, "bagger")).body.ok).toBe(true);
    const picked = await loadJob("bagger");
    expect(picked.data.job.status).toBe("picked_up");
    const html = render(picked.page.default, picked.data, { ...JOB_ROUTE, role: "bagger" });
    for (const phrase of ["CUSTOMER PICKUP RECORDED", "COMPLETE JOB", "Recorded. Mark the job Completed when everything is done."]) expect(html, phrase).toContain(phrase);
    expect((await post({ intent: "changeStatus", jobId: "j1", status: "completed" }, "bagger")).body.ok).toBe(true);
    const done = await loadJob("print_operator");
    expect(done.data.job.status).toBe("completed");
    expect(words(render(done.page.default, done.data, { ...JOB_ROUTE, role: "print_operator" }))).toContain("DONE");
    // one job, two items, one reprint run — nothing was duplicated along the way
    expect(table("productionJob")).toHaveLength(1);
    expect(runsOf()).toEqual([[1, "original", 500, "reprinted"], [2, "reprint", 25, "qc_passed"]]);
  }, 120_000);
});
