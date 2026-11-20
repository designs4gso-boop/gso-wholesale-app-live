// 2026-11-20 — PRODUCTION CLOSE-OUT for the production lead (role `print_operator`).
//
// Every block calls REAL application code (route loaders / actions, the routing
// and naming functions, the central job service, the run accounting) against an
// in-memory database double. Nothing touches Prisma, the network, Shopify, the
// NAS or a press. All data here is a test double.
//
// This file EXTENDS the existing proofs and does not repeat them. Where a point
// is already proven the test says which file covers it:
//   ui-and-permission-smoke-2026-11-20      six-role matrix for Leads / Approvals / Board / Job page / New Job /
//                                           Release / Reorder / Quotes / Privacy / Customers; render smoke
//   shared-production-backbone-2026-11-19   role tables, file -> item link, runs, reorder lineage
//   retry-idempotency-2026-11-20            replayed reprint, replayed routed-file report
//   order-to-production-routed-names-2026-11-19   the basic routed-name rules (1-12)
//   print-intake-ticket-folders-2026-11-18  ticket folders, multi-item "link to item", bulk assign
//   mimaki-patch-f-software-readiness-2026-11-19 + jobinfo-clear-actuals-2026-11-18   Patch F chain
//
// A scenario marked `it.fails` is a FINDING in application code: the body states
// the correct behaviour and the comment gives file:line, input, expected, actual
// and a minimal fix. Application code is deliberately NOT changed here.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: 0, calls: [] as string[], writes: [] as string[], fetches: [] as string[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
  unauthenticated: { admin: async () => ({ session: null }) },
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ boundary: { error: () => null, headers: () => ({}) } }));
// the Slack production alert is the only outbound call near these paths: replaced
vi.mock("../app/lib/production-alert.server", async (importOriginal) => ({ ...(await importOriginal<any>()), sendProductionAlertSafe: async () => ({ sent: false, reason: "test double" }) }));

// In-memory database. Relations are real tables joined on read (so an item updated through
// productionJobItem is the item a job `include` returns), `select` / `include` are honoured,
// and the unique indexes of prisma/schema.prisma that matter here are enforced.
vi.mock("../app/db.server", () => {
  const REL: Record<string, Record<string, [string, string, "many" | "one"]>> = {
    productionJob: {
      items: ["productionJobItem", "jobId", "many"], files: ["productionJobFile", "jobId", "many"], events: ["productionJobEvent", "jobId", "many"],
      checklistItems: ["productionChecklistItem", "jobId", "many"], materialUsages: ["productionMaterialUsage", "jobId", "many"], inventoryMovements: ["materialInventoryMovement", "jobId", "many"],
    },
    productionJobItem: { job: ["productionJob", "jobId", "one"] },
    quote: { items: ["quoteItem", "quoteId", "many"] },
  };
  const DEFAULTS: Record<string, Record<string, any>> = {
    productionJob: { active: true, status: "new", priority: "normal", proofStatus: "draft", actualCostFinalized: false },
    productionJobItem: { quantity: 1, unitPrice: 0, unitCost: 0, sortOrder: 0 },
    productionJobFile: { fileType: "artwork", assetRole: "reference", assetSource: "manual" },
    productionRun: { kind: "original", chargeType: "internal", status: "open" },
    printIntake: { status: "routed", attemptNumber: 1, revisionNumber: 1, reprintNumber: 0 },
  };
  const UNIQUE: Record<string, string[][]> = {
    productionRun: [["itemId", "runNumber"]], productionJob: [["shop", "jobTicket"]], productionJobItem: [["shop", "itemTicket"]], printIntake: [["shop", "fileHashSha256"]],
  };
  const OPS = new Set(["in", "notIn", "not", "equals", "contains", "startsWith", "endsWith", "mode", "gt", "gte", "lt", "lte"]);
  const READS = new Set(["findFirst", "findUnique", "findMany", "count", "aggregate", "groupBy", "findFirstOrThrow", "findUniqueOrThrow"]);
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const stamp = () => new Date((h.clock = Math.max(Date.now(), h.clock + 1)));
  const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a == null ? null : new Date(a).getTime()) === (b == null ? null : new Date(b).getTime()) : (a ?? null) === (b ?? null));
  const num = (value: any) => (value instanceof Date ? value.getTime() : typeof value === "string" && Number.isNaN(Number(value)) && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : Number(value));
  const isOps = (value: any) => value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
  const field = (row: any, key: string, want: any): boolean => {
    if (!isOps(want)) return same(row[key], want);
    const fold = (value: any) => (want.mode === "insensitive" ? String(value ?? "").toLowerCase() : String(value ?? ""));
    for (const [op, arg] of Object.entries(want) as [string, any][]) {
      const have = row[key];
      if (op === "mode") continue;
      else if (op === "in") { if (!arg.includes(have)) return false; }
      else if (op === "notIn") { if (arg.includes(have)) return false; }
      else if (op === "not") { if (isOps(arg) ? field(row, key, arg) : same(have, arg)) return false; }
      else if (op === "equals") { if (!(want.mode === "insensitive" ? fold(have) === fold(arg) : same(have, arg))) return false; }
      else if (op === "contains") { if (!fold(have).includes(fold(arg))) return false; }
      else if (op === "startsWith") { if (!fold(have).startsWith(fold(arg))) return false; }
      else if (op === "endsWith") { if (!fold(have).endsWith(fold(arg))) return false; }
      else if (op === "gt") { if (!(have != null && num(have) > num(arg))) return false; }
      else if (op === "gte") { if (!(have != null && num(have) >= num(arg))) return false; }
      else if (op === "lt") { if (!(have != null && num(have) < num(arg))) return false; }
      else if (op === "lte") { if (!(have != null && num(have) <= num(arg))) return false; }
      else throw new Error(`test db: unsupported filter ${key}.${op}`);
    }
    return true;
  };
  const match = (name: string, row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === "OR") return (value as any[]).some((part) => match(name, row, part));
    if (key === "AND") return ([] as any[]).concat(value).every((part) => match(name, row, part));
    if (key === "NOT") return !([] as any[]).concat(value).some((part) => match(name, row, part));
    const rel = REL[name]?.[key];
    if (rel) {
      const [child, fk, kind] = rel;
      if (kind === "one") { const parent = rows(child).find((candidate) => candidate.id === row[fk]); const cond = value?.is ?? value; return cond === null ? !parent : Boolean(parent) && match(child, parent, cond); }
      const kids = rows(child).filter((candidate) => candidate[fk] === row.id);
      if ("some" in value) return kids.some((kid) => match(child, kid, value.some));
      if ("none" in value) return !kids.some((kid) => match(child, kid, value.none));
      if ("every" in value) return kids.every((kid) => match(child, kid, value.every));
      return true;
    }
    if (isOps(value) && !Object.keys(value).some((op) => OPS.has(op))) return match(name, row, value); // compound unique key
    return field(row, key, value);
  });
  const sort = (list: any[], orderBy: any) => {
    const orders = ([] as any[]).concat(orderBy || []).flatMap((order) => Object.entries(order || {})) as [string, string][];
    if (!orders.length) return list;
    const key = (value: any) => (value instanceof Date ? value.getTime() : value ?? "");
    return [...list].sort((a, b) => { for (const [name, dir] of orders) { const x = key(a[name]), y = key(b[name]); if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1); } return 0; });
  };
  const relation = (name: string, row: any, key: string, rule: any): any => {
    const [child, fk, kind] = REL[name][key];
    const args = rule === true ? {} : rule || {};
    if (kind === "one") return shape(child, rows(child).find((candidate) => candidate.id === row[fk]), args);
    let kids = rows(child).filter((candidate) => candidate[fk] === row.id);
    if (args.where) kids = kids.filter((kid) => match(child, kid, args.where));
    kids = sort(kids, args.orderBy);
    if (args.take) kids = kids.slice(0, args.take);
    return kids.map((kid) => shape(child, kid, args));
  };
  const shape = (name: string, row: any, args: any = {}): any => {
    if (!row) return null;
    if (args.select) {
      const out: any = {};
      for (const [key, rule] of Object.entries(args.select) as [string, any][]) { if (rule) out[key] = REL[name]?.[key] ? relation(name, row, key, rule) : row[key]; }
      return out;
    }
    const out: any = { ...row };
    for (const [key, rule] of Object.entries(args.include || {}) as [string, any][]) if (rule && REL[name]?.[key]) out[key] = relation(name, row, key, rule);
    return out;
  };
  const insert = (name: string, data: any): any => {
    const own: any = {};
    const kids: Array<[string, string, any[]]> = [];
    for (const [key, value] of Object.entries(data || {}) as [string, any][]) {
      const rel = REL[name]?.[key];
      if (rel && rel[2] === "many") { if (value?.create) kids.push([rel[0], rel[1], ([] as any[]).concat(value.create)]); } else own[key] = value;
    }
    const row: any = { id: `${name}_${++h.seq}`, createdAt: stamp(), updatedAt: new Date(h.clock), ...(DEFAULTS[name] || {}), ...own };
    for (const fields of UNIQUE[name] || []) {
      if (fields.every((key) => row[key] != null) && rows(name).some((other) => fields.every((key) => other[key] === row[key]))) throw Object.assign(new Error(`Unique constraint failed on the fields: (${fields.join(",")})`), { code: "P2002", meta: { target: fields } });
    }
    rows(name).push(row);
    for (const [child, fk, list] of kids) for (const kid of list) insert(child, { ...kid, [fk]: row.id });
    return row;
  };
  const amend = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data || {}) as [string, any][]) row[key] = isOps(value) && "increment" in value ? Number(row[key] || 0) + Number(value.increment) : value;
    row.updatedAt = stamp();
  };
  const model = (name: string) => new Proxy({}, {
    get: (_target, method: string) => async (args: any = {}) => {
      h.calls.push(`${name}.${method}`);
      if (!READS.has(method)) h.writes.push(`${name}.${method}`);
      const found = sort(rows(name).filter((row) => match(name, row, args.where)), args.orderBy);
      if (method === "findFirst" || method === "findUnique") return shape(name, found[0], args);
      if (method === "findMany") return (args.take ? found.slice(0, args.take) : found).map((row) => shape(name, row, args));
      if (method === "count") return found.length;
      if (method === "create") return shape(name, insert(name, args.data), args);
      if (method === "createMany") { ([] as any[]).concat(args.data).forEach((data) => insert(name, data)); return { count: ([] as any[]).concat(args.data).length }; }
      if (method === "update") { if (found[0]) amend(found[0], args.data); return shape(name, found[0], args); }
      if (method === "updateMany") { found.forEach((row) => amend(row, args.data)); return { count: found.length }; }
      if (method === "upsert") { if (found[0]) { amend(found[0], args.update); return shape(name, found[0], args); } return shape(name, insert(name, args.create), args); }
      if (method === "delete" || method === "deleteMany") { h.t[name] = rows(name).filter((row) => !found.includes(row)); return method === "delete" ? found[0] || null : { count: found.length }; }
      return method === "groupBy" ? [] : null;
    },
  });
  const db: any = new Proxy({}, {
    get: (_target, key: string) => {
      if (key === "then") return undefined;
      if (key === "$transaction") return async (work: any) => (typeof work === "function" ? work(db) : Promise.all(work));
      if (key.startsWith("$")) return async () => [{ gso_lock: "" }];
      return model(key);
    },
  });
  return { default: db, db };
});

import db from "../app/db.server";
import { ROUTE_ACCESS, viewerMayOpenRoute } from "../app/lib/route-access";
import { PRODUCTION_VIEW_DENIED_REDIRECT, roleMayRunProductionIntent } from "../app/lib/production-role-access";
import { ROLE_PERMISSIONS } from "../app/lib/staff-roles.server";
import { DEFAULT_RUN, applyRunSuffix, extractItemTicketFrom, parseRunIdentity, ripFileBaseName, routedStaffNameSegment } from "../app/lib/print-intake-routing.server";
import { parseRipTickets, resolveRipIdentity } from "../app/lib/rip-identity-match.server";
import { actualsByRun, itemRunSummary, reprintNumberOfRipName, reprintNumberOfRun, runCostAccounting, runCostClassOf } from "../app/lib/production-run";
import { runCostDollars, RUN_COST_NOT_INCLUDED } from "../app/lib/run-cost-dollars.server";
import { buildBrandRates, computeEntryCosts, machineRatePerHour } from "../app/lib/rip-actual-costs.server";
import { CANONICAL_INK_RATES, channelInkRatePerMl } from "../app/lib/ink-rates-shared";
import { JOBINFO_CLEAR_SLOT_CODES, parseInkUsedLine } from "../app/lib/jobinfo-fallback.server";
import { REORDER_REUSE_SOURCE, createProductionJobFromSource } from "../app/lib/production-job-source.server";
import { evaluateQcForCompletion } from "../app/lib/production-qc-guard";
import { toBoardCard } from "../app/lib/simple-production";

/* ---------------- roles ---------------- */

const ROLE_SUB = { owner: "1", manager: "2", sales: "3", print_operator: "4", bagger: "5", unassigned: "9" } as const;
type Role = keyof typeof ROLE_SUB;
const ENV: Record<string, string> = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" };
const as = (role: Role) => { h.sub = ROLE_SUB[role]; };

/* ---------------- seed ---------------- */

const TOKEN = "tok-closeout";
const JOB = "GSO-20261120-0007"; // two items
const SOLO = "GSO-20261120-0008"; // one item
const PICK = "GSO-20261120-0009"; // one item (pickup)
const OLD = "GSO-20261101-0003"; // an earlier, completed job (reorder source)
const HASH = (char: string) => char.repeat(64);
const MIMAKI = "Mimaki UCJV300-130";
const ROLAND = "Roland LG-640";
// distinctive money values: none may reach a non-financial payload
const MONEY = { unitPrice1: 0.6213, unitCost1: 0.3137, unitPrice2: 0.7719, unitCost2: 0.3941, quotedTrueCost: 271.25, actualTotalCost: 293.47, variance: 22.22, shipping: 18.75, labor: 41.37 };
const MONEY_TEXT = /0\.6213|0\.3137|0\.7719|0\.3941|271\.25|293\.47|22\.22|18\.75|41\.37/;
const T0 = new Date("2026-11-19T10:00:00Z");

const jobRow = (id: string, jobTicket: string, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", active: true, status: "new", priority: "normal", jobTicket, customerName: "Sam", company: null, email: null, phone: null, assignedTo: null, dueDate: null,
  quoteId: `manual_seed-${id}`, quoteNumber: null, orderGid: null, proofApprovalToken: null, proofStatus: "draft", internalNotes: null, fulfillmentState: null, actualCostFinalized: false, completedAt: null,
  createdAt: T0, updatedAt: T0, ...over,
});
const itemRow = (id: string, jobId: string, itemTicket: string, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", jobId, itemTicket, ripJobName: itemTicket, suggestedFileName: null, productTitle: "HEATH pouch", quantity: 500, unitPrice: 0, unitCost: 0, selectedFinish: "CMYK", materialSummary: null,
  machineSummary: MIMAKI, costSnapshot: null, priceSnapshot: null, qcResult: null, qcBy: null, qcAt: null, qcNote: null, lastReprintAt: null, lastReprintReason: null, lastReprintBy: null,
  reorderSourceItemId: null, reorderArtworkMode: null, sortOrder: 1, createdAt: T0, updatedAt: T0, ...over,
});
const intakeRow = (id: string, originalFilename: string, hash: string, jobId: string, itemId: string, ticket: string, routedFilename: string, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", originalFilename, originalSubfolder: null, fileHashSha256: hash, fileSize: 10, status: "routed", matchedProductionJobId: jobId, generatedProductionJobId: null, authoritativeTicket: ticket, productionJobItemId: itemId,
  printer: "mimaki", printMode: null, routingRule: "job_subfolder", routedFilename, attemptNumber: 1, revisionNumber: 1, reprintNumber: 0, reviewReason: null, rawParsedHints: null, createdAt: T0, updatedAt: T0, ...over,
});

function seed() {
  h.t = {}; h.seq = 0;
  h.t.printLogAutoImportSetting = [{ id: "set1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null, incomingFolder: "x" }];
  h.t.productionJob = [
    jobRow("j1", JOB, {
      company: "Krud Cafe", priority: "rush", assignedTo: "Dana", dueDate: new Date("2026-12-05T12:00:00Z"),
      quotedTrueCost: MONEY.quotedTrueCost, actualTotalCost: MONEY.actualTotalCost, actualVarianceAmount: MONEY.variance, actualShippingCost: MONEY.shipping, actualLaborCost: MONEY.labor,
    }),
    jobRow("j2", SOLO, { customerName: "Walk-in Jane" }),
    jobRow("j3", PICK, { customerName: "Pickup Pat" }),
  ];
  h.t.productionJobItem = [
    itemRow("i1", "j1", `${JOB}-01`, { selectedFinish: "CMYK + Gloss", unitPrice: MONEY.unitPrice1, unitCost: MONEY.unitCost1, costSnapshot: JSON.stringify({ trueUnitCost: MONEY.unitCost1 }), priceSnapshot: JSON.stringify({ unitPrice: MONEY.unitPrice1 }) }),
    itemRow("i2", "j1", `${JOB}-02`, { productTitle: "SHORTCAKES pouch", quantity: 250, unitPrice: MONEY.unitPrice2, unitCost: MONEY.unitCost2, sortOrder: 2 }),
    itemRow("s1", "j2", `${SOLO}-01`, { productTitle: "4x5 bag labels", quantity: 100, selectedFinish: "CMYK + Gloss" }),
    itemRow("p1", "j3", `${PICK}-01`, { productTitle: "Jar labels", quantity: 60 }),
  ];
  h.calls = []; h.writes = []; h.fetches = [];
}
/** the two layer files of item i1 as Print Intake routed them (CMYK + gloss pair, one press) */
const seedLayers = () => {
  h.t.printIntake = [
    intakeRow("pi1", "crud_HEATH_F_CMYK.pdf", HASH("a"), "j1", "i1", `${JOB}-01`, `${JOB}-01__crud_HEATH_F_CMYK`),
    intakeRow("pi2", "crud_HEATH_F_g.pdf", HASH("b"), "j1", "i1", `${JOB}-01`, `${JOB}-01__crud_HEATH_F_g`, { updatedAt: new Date(T0.getTime() + 60_000) }),
  ];
};

beforeEach(() => {
  seed(); h.shop = "shop-1"; as("owner");
  Object.assign(process.env, ENV);
  for (const key of ["GSO_OWNER_ENFORCEMENT", "GSO_MANAGER_AUTHORIZED_USER_IDS", "SLACK_WEBHOOK_URL", "PRODUCTION_SLACK_WEBHOOK_URL", "GSO_MACHINE_RATE_PER_HOUR"]) delete process.env[key];
  vi.stubGlobal("fetch", async (url: any) => { h.fetches.push(String(url)); throw new Error("network is not available in this test"); });
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; vi.unstubAllGlobals(); });

/* ---------------- helpers ---------------- */

const get = (path = "/x") => new Request(`https://erp.test${path}`);
const form = (fields: Record<string, string>, path = "/x") => new Request(`https://erp.test${path}`, { method: "POST", body: new URLSearchParams(fields) });
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
const production = () => import("../app/routes/app.erp.production");
const jobPage = () => import("../app/routes/app.erp.production-job.$id");
const post = async (fields: Record<string, string>) => { const mod = await jobPage(); return run(() => mod.action({ request: form(fields, "/app/erp/production-job/x") })); };
const loadJob = async (role: Role, id: string) => { as(role); const mod = await jobPage(); const seen = await run(() => mod.loader({ request: get(`/app/erp/production-job/${id}`), params: { id } })); expect(seen.status).toBe(200); return seen.body; };
const plan = async (fields: Record<string, any>) => {
  const mod = await import("../app/routes/api.print-intake.route-plan");
  const response: Response = await mod.action({ request: new Request("https://erp.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, fileSize: 10, ...fields }) }) });
  return ((await response.json()) as any).plan;
};
const table = (name: string) => h.t[name] || [];
const intakeOf = (hash: string) => table("printIntake").find((row) => row.fileHashSha256 === hash);
const runsOf = (itemId: string) => table("productionRun").filter((row) => row.itemId === itemId).sort((a, b) => a.runNumber - b.runNumber);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const REPRINT = { intent: "reprintItem", jobId: "j1", itemId: "i1", reprintReason: "color_quality_issue", reprintQty: "25", runKind: "reprint", chargeType: "internal" };

/* ====================================================================== */
/* A — PRODUCTION LEAD (print_operator): final access                       */
/* ====================================================================== */

describe("A · production lead (print_operator) — what the role CAN do, through the real loaders and actions", () => {
  // Board / Job page / New Job open + a note + Ready to ship + start a reprint for all six roles:
  // ui-and-permission-smoke-2026-11-20 PART B. The tests here add what that matrix does not drive.

  it("New Job: the lead's printer choice is honoured (selectPrinter); a manager's forged choice is ignored (Auto)", async () => {
    const created = async (role: Role, requestId: string) => {
      seed(); as(role);
      const mod = await import("../app/routes/app.erp.production-new");
      const seen = await run(() => mod.action({ request: form({ intent: "createManualJob", requestId, customerName: "Walk-in Rae", itemTitle: "Sticker sheet", quantity: "120", family: "stickers-labels", finish: "CMYK", printer: "roland" }) }));
      expect(seen.status).toBe(200);
      expect(seen.body.ok, seen.body.message).toBe(true);
      const job = table("productionJob").find((row) => row.customerName === "Walk-in Rae");
      return table("productionJobItem").filter((row) => row.jobId === job.id).map((row) => row.machineSummary);
    };
    expect(ROLE_PERMISSIONS.print_operator).toContain("selectPrinter");
    expect(ROLE_PERMISSIONS.manager).not.toContain("selectPrinter");
    expect(await created("print_operator", "11111111-1111-4111-8111-111111111111")).toEqual([ROLAND]);
    expect(await created("manager", "22222222-2222-4222-8222-222222222222")).toEqual([MIMAKI]); // CMYK, nothing explicit -> Mimaki
    expect(await created("owner", "33333333-3333-4333-8333-333333333333")).toEqual([ROLAND]);
  }, 120_000);

  it("New Job: the lead creates a MULTI-ITEM job through the real action — one job, item tickets -01..-03, no price, retry-safe", async () => {
    // service-level proof: manual-job-multi-item-2026-11-19 (4, 5). This is the same thing through the route, as the lead.
    as("print_operator");
    const mod = await import("../app/routes/app.erp.production-new");
    const fields = { intent: "createManualJob", requestId: "44444444-4444-4444-8444-444444444444", customerName: "Leaf Labs", itemTitle: "HEATH pouch", quantity: "128", family: "sticker-bags", finish: "CMYK", printer: "mimaki", moreItems: "SHORTCAKES pouch | 64\nGELATO pouch" };
    const first = await run(() => mod.action({ request: form(fields) }));
    expect(first.body).toMatchObject({ ok: true, manualJob: { itemCount: 3 } });
    const job = table("productionJob").find((row) => row.customerName === "Leaf Labs");
    const items = table("productionJobItem").filter((row) => row.jobId === job.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(items.map((row) => [row.itemTicket, row.productTitle, row.quantity, row.unitPrice, row.unitCost, row.machineSummary])).toEqual([
      [`${job.jobTicket}-01`, "HEATH pouch", 128, 0, 0, MIMAKI], [`${job.jobTicket}-02`, "SHORTCAKES pouch", 64, 0, 0, MIMAKI], [`${job.jobTicket}-03`, "GELATO pouch", 128, 0, 0, MIMAKI],
    ]);
    const again = await run(() => mod.action({ request: form(fields) }));
    expect(again.body.message).toContain("Already created");
    expect(table("productionJob").filter((row) => row.customerName === "Leaf Labs")).toHaveLength(1);
    // a bad extra line creates nothing
    const bad = await run(() => mod.action({ request: form({ ...fields, requestId: "55555555-5555-4555-8555-555555555555", customerName: "Nobody", moreItems: "x | 0" }) }));
    expect(bad.body.ok).toBe(false);
    expect(table("productionJob").some((row) => row.customerName === "Nobody")).toBe(false);
  }, 120_000);

  it("Incoming Print Files: the lead opens the page and assigns, releases and rejects files", async () => {
    as("print_operator");
    const mod = await import("../app/routes/app.erp.print-intake");
    const review = (id: string, name: string, hash: string) => intakeRow(id, name, hash, null as any, null as any, null as any, null as any, { status: "review", matchedProductionJobId: null, productionJobItemId: null, authoritativeTicket: null, routedFilename: null, printer: null, reviewReason: "needs_link_to_job" });
    h.t.printIntake = [review("r1", "mystery_F_CMYK.pdf", HASH("1")), review("r2", "held.pdf", HASH("2")), review("r3", "wrong.pdf", HASH("3"))];
    const page = await run(() => mod.loader({ request: get("/app/erp/print-intake") }));
    expect(page.status).toBe(200);
    expect(page.body.reviewRows.map((row: any) => row.fileName).sort()).toEqual(["held.pdf", "mystery_F_CMYK.pdf", "wrong.pdf"]);
    expect(page.body.credential).not.toContain(TOKEN); // the upload token never reaches the browser
    expect(JSON.stringify(page.body)).not.toMatch(MONEY_TEXT);
    // a multi-item job needs the exact item — never guessed (also print-intake-ticket-folders 11-14)
    expect((await run(() => mod.action({ request: form({ intent: "assign", intakeId: "r1", target: "j1" }) }))).body).toMatchObject({ ok: false });
    expect((await run(() => mod.action({ request: form({ intent: "assign", intakeId: "r1", target: "j1|i2" }) }))).body.ok).toBe(true);
    expect(table("printIntake")[0]).toMatchObject({ status: "assigned", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-02` });
    expect((await run(() => mod.action({ request: form({ intent: "release", intakeId: "r2" }) }))).body.ok).toBe(true);
    expect(table("printIntake")[1].status).toBe("retry_allowed");
    expect((await run(() => mod.action({ request: form({ intent: "reject", intakeId: "r3" }) }))).body.ok).toBe(false); // needs the confirmation box
    expect((await run(() => mod.action({ request: form({ intent: "reject", intakeId: "r3", confirmReject: "yes", rejectReason: "not ours" }) }))).body.ok).toBe(true);
    expect(table("printIntake")[2]).toMatchObject({ status: "rejected", reviewReason: "rejected_by_owner" });
    // the assigned file then routes against that exact item under <item ticket>__<staff name>
    const routed = await plan({ fileName: "mystery_F_CMYK.pdf", fileHash: HASH("1") });
    expect(routed).toMatchObject({ decision: "route", rule: "assigned_by_owner", itemId: "i2", itemTicket: `${JOB}-02`, ripName: `${JOB}-02__mystery_F_CMYK`, machine: "mimaki" });
    expect(table("productionJob")).toHaveLength(3); // Print Intake never creates a job
  }, 120_000);

  it("floor lifecycle as the lead: note -> status -> QC -> ready -> shipment -> COMPLETE (and the guards still apply to the lead)", async () => {
    as("print_operator");
    const act = (fields: Record<string, string>) => post({ jobId: "j2", ...fields });
    expect((await act({ intent: "addNote", note: "Roll changed at 2pm" })).body.ok).toBe(true);
    expect((await act({ intent: "changeStatus", status: "printing" })).body.ok).toBe(true);
    expect(table("productionJob")[1].status).toBe("printing");
    // guards are not relaxed for the lead: no completion before fulfilment, no "shipped" by status tap, no ready-mark before QC PASS
    expect((await act({ intent: "changeStatus", status: "completed" })).status).toBe(400);
    expect((await act({ intent: "changeStatus", status: "shipped" })).status).toBe(400);
    expect((await act({ intent: "markFulfillmentReady", kind: "ship" })).status).toBe(400);
    expect((await act({ intent: "recordShipment", carrier: "UPS", packageCount: "2", shipDate: "2026-11-21" })).status).toBe(400);
    expect((await act({ intent: "qcItem", itemId: "s1", qcResult: "pass" })).body.ok).toBe(true);
    expect(table("productionJobItem").find((row) => row.id === "s1")).toMatchObject({ qcResult: "pass" });
    expect((await act({ intent: "markFulfillmentReady", kind: "ship" })).body.ok).toBe(true);
    expect(table("productionJob")[1].fulfillmentState).toBe("ready_to_ship");
    const shipped = await act({ intent: "recordShipment", carrier: "UPS", trackingNumber: "1Z999", packageCount: "2", shipDate: "2026-11-21" });
    expect(shipped.body.ok, shipped.body.message).toBe(true);
    expect(table("productionJob")[1]).toMatchObject({ status: "shipped", shipCarrier: "UPS", shipTrackingNumber: "1Z999", shipPackageCount: 2, fulfillmentState: "shipped" });
    expect((await act({ intent: "changeStatus", status: "completed" })).body.ok).toBe(true);
    expect(table("productionJob")[1].status).toBe("completed");
    expect(table("productionJob")[1].completedAt).toBeInstanceOf(Date);
    expect(table("productionJobEvent").filter((row) => row.jobId === "j2").map((row) => row.eventType)).toEqual(expect.arrayContaining(["note", "status_change", "qc_result", "fulfillment_ready", "shipped", "tracking_added"]));
    expect(h.fetches).toEqual([]); // nothing left the process (no Shopify fulfilment, no Slack)
  }, 120_000);

  it("pickup as the lead: QC PASS -> ready for pickup -> pickup recorded -> completed", async () => {
    as("print_operator");
    const act = (fields: Record<string, string>) => post({ jobId: "j3", ...fields });
    expect((await act({ intent: "recordPickup", pickedUpBy: "Pat" })).status).toBe(400); // QC first
    expect((await act({ intent: "qcItem", itemId: "p1", qcResult: "pass" })).body.ok).toBe(true);
    expect((await act({ intent: "markFulfillmentReady", kind: "pickup" })).body.ok).toBe(true);
    expect(table("productionJob")[2].fulfillmentState).toBe("pickup_ready");
    expect((await act({ intent: "recordPickup", pickedUpBy: "Pat" })).body.ok).toBe(true);
    expect(table("productionJob")[2]).toMatchObject({ status: "picked_up", pickedUpBy: "Pat", fulfillmentState: "picked_up" });
    expect((await act({ intent: "changeStatus", status: "completed" })).body.ok).toBe(true);
  }, 120_000);

  it("the job payload the lead receives carries NO money, even when press results and run dollars exist for the owner", async () => {
    seedLayers();
    as("print_operator");
    expect((await post(REPRINT)).body.ok).toBe(true);
    h.t.machine = [{ id: "m1", shop: "shop-1", active: true, name: MIMAKI }];
    h.t.printLogEntry = [
      { id: "e1", shop: "shop-1", importId: "imp", productionJobId: "j1", productionJobItemId: "i1", sourceJobName: `${JOB}-01__crud_HEATH_F_CMYK`, machineName: MIMAKI, printerSoftware: "RasterLink", cmykInkMl: 12, whiteInkMl: 0, glossInkMl: 0, inkMl: 12, printMinutes: 30, sqft: 40, createdAt: T0 },
      { id: "e2", shop: "shop-1", importId: "imp", productionJobId: "j1", productionJobItemId: "i1", sourceJobName: `${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, machineName: MIMAKI, printerSoftware: "RasterLink", cmykInkMl: 1, whiteInkMl: 0, glossInkMl: 0, inkMl: 1, printMinutes: 6, sqft: 2, createdAt: T0 },
    ];
    const owner = await loadJob("owner", "j1");
    expect(owner.showFinancials).toBe(true);
    expect(owner.job.items[0].runCosts.runs.map((row: any) => row.knownCost)).toEqual([4.61, 0.68]); // 12 x 0.176 + 30 min x $5/h ; 1 x 0.176 + 6 min x $5/h
    expect(owner.job.quotedTrueCost).toBe(MONEY.quotedTrueCost);

    const lead = await loadJob("print_operator", "j1");
    expect(lead.showFinancials).toBe(false);
    expect(JSON.stringify(lead)).not.toMatch(MONEY_TEXT);
    expect(JSON.stringify(lead)).not.toMatch(/4\.61|0\.68/);
    for (const item of lead.job.items) {
      expect([item.unitPrice, item.unitCost, item.costSnapshot, item.priceSnapshot]).toEqual([null, null, null, null]);
      expect(item.runCosts ?? null).toBeNull();
    }
    // every actual* figure is blank; only the finalized flag / stamp (not money) may remain
    const actualKeys = Object.keys(lead.job).filter((key) => /^actual/.test(key) && !/^actualCostFinalized/.test(key) && key !== "actuals");
    expect(actualKeys.length).toBeGreaterThan(8);
    for (const key of actualKeys) expect(lead.job[key], key).toBeNull();
    expect([lead.job.quotedTrueCost, lead.job.writebackPreview, lead.job.printLogApplied]).toEqual([null, null, null]);
    expect(Object.keys(lead.job.actuals || {}).sort()).toEqual(["actualInkMl", "actualPrintMinutes", "actualSqft", "entryCount"]);
    // what the floor needs is still there: runs and press quantities (mL / minutes), no dollars
    expect(lead.job.items[0].runs.map((row: any) => [row.runNumber, row.kind, row.quantity])).toEqual([[1, "original", 500], [2, "reprint", 25]]);
    expect(lead.job.items[0].runActuals.map((row: any) => [row.runNumber, row.inkMl, row.printMinutes])).toEqual([[1, 12, 30], [2, 1, 6]]);
  }, 120_000);
});

describe("A · production lead — what the role CANNOT do (403 before anything is read or written)", () => {
  // The production-job intents, posted through the real Job page action. Expected column is hand-written;
  // it is then compared with production-role-access.ts / staff-roles.server.ts AND with what the server does.
  const INTENTS: Array<{ intent: string; lead: boolean; bagger: boolean; fields?: Record<string, string> }> = [
    { intent: "changeStatus", lead: true, bagger: true, fields: { status: "printing" } },
    { intent: "addNote", lead: true, bagger: true, fields: { note: "x" } },
    { intent: "qcItem", lead: true, bagger: true, fields: { itemId: "s1", qcResult: "hold" } },
    { intent: "markFulfillmentReady", lead: true, bagger: true, fields: { kind: "ship" } },
    { intent: "recordShipment", lead: true, bagger: true },
    { intent: "recordPickup", lead: true, bagger: true },
    { intent: "reprintItem", lead: true, bagger: false, fields: { itemId: "s1" } },
    { intent: "revisionItem", lead: true, bagger: false, fields: { itemId: "s1" } },
    { intent: "createManualJob", lead: true, bagger: false },
    // job settings, money and admin actions
    { intent: "updateJob", lead: false, bagger: false, fields: { priority: "critical", assignedTo: "Me", dueDate: "2026-12-01" } },
    { intent: "updateSchedule", lead: false, bagger: false },
    { intent: "quickDueDate", lead: false, bagger: false },
    { intent: "saveFinalCosts", lead: false, bagger: false },
    { intent: "reopenJobCost", lead: false, bagger: false },
    { intent: "pullPrintLogActuals", lead: false, bagger: false },
    { intent: "adjustInventory", lead: false, bagger: false },
    { intent: "reopenReprint", lead: false, bagger: false, fields: { confirmReopen: "yes", reopenReason: "x" } },
    { intent: "backfillTickets", lead: false, bagger: false },
    { intent: "createFromQuote", lead: false, bagger: false },
    { intent: "releaseStagedTransaction", lead: false, bagger: false },
    { intent: "notARealIntent", lead: false, bagger: false }, // default deny
  ];
  const PERMISSION: Record<string, string> = { qcItem: "recordQc", reprintItem: "recordReprint", recordShipment: "recordShipment", recordPickup: "recordShipment" };
  const OWNER_COST = ["saveFinalCosts", "reopenJobCost", "pullPrintLogActuals", "adjustInventory"];

  it("the hand-written column equals the role tables", () => {
    for (const row of INTENTS) {
      for (const role of ["print_operator", "bagger"] as const) {
        const tables = roleMayRunProductionIntent(role, row.intent) && (!PERMISSION[row.intent] || (ROLE_PERMISSIONS[role] as readonly string[]).includes(PERMISSION[row.intent])) && !OWNER_COST.includes(row.intent);
        expect(role === "print_operator" ? row.lead : row.bagger, `${row.intent} · ${role}`).toBe(tables);
      }
    }
  });

  for (const role of ["print_operator", "bagger"] as const) {
    it(`${role}: every intent — the server's answer equals the tables; a refusal reads and writes nothing`, async () => {
      const seenAllowed: Record<string, boolean> = {};
      const expected: Record<string, boolean> = {};
      for (const row of INTENTS) {
        seed(); as(role);
        const before = JSON.stringify(h.t);
        const out = await post({ intent: row.intent, jobId: "j2", ...(row.fields || {}) });
        seenAllowed[row.intent] = out.status !== 403;
        expected[row.intent] = role === "print_operator" ? row.lead : row.bagger;
        if (out.status === 403) {
          expect(h.calls, `${row.intent} · ${role} touched the database`).toEqual([]);
          expect(JSON.stringify(h.t)).toBe(before);
        }
      }
      expect(seenAllowed).toEqual(expected);
    }, 120_000);
  }

  it("job settings stay as they were when the lead posts updateJob (due date / priority / assignment)", async () => {
    as("print_operator");
    const out = await post({ intent: "updateJob", jobId: "j1", priority: "low", assignedTo: "Me", dueDate: "2027-01-01" });
    expect(out.status).toBe(403);
    expect(table("productionJob")[0]).toMatchObject({ priority: "rush", assignedTo: "Dana", dueDate: new Date("2026-12-05T12:00:00Z") });
    // the calendar's scheduling action is the same rule on its own route
    const calendar = await import("../app/routes/app.erp.production-calendar");
    h.calls = [];
    expect((await run(() => calendar.action({ request: form({ intent: "updateSchedule", jobId: "j1", dueDate: "2027-01-01" }) }))).status).toBe(403);
    expect(h.calls).toEqual([]);
  }, 120_000);

  it("Release to Production: the loader and EVERY action are refused for the lead and the bagger", async () => {
    // owner / manager allowed, others 403 for open / release / dismiss: ui-and-permission-smoke PART B. Added here: review + unknown.
    const mod = await import("../app/routes/app.erp.release-queue");
    h.t.stagedTransaction = [{ id: "st1", shop: "shop-1", source: "quickbooks_invoice", docNumber: "1270", customerName: "Krud Cafe", status: "staged", totalAmount: 512, balance: 256, lines: "[]", createdAt: T0 }];
    for (const role of ["print_operator", "bagger"] as const) {
      as(role); h.calls = []; h.writes = [];
      expect((await run(() => mod.loader({ request: get("/app/erp/release-queue") }))).status, role).toBe(403);
      for (const intent of ["review", "release", "dismiss", "", "anythingElse"]) expect((await run(() => mod.action({ request: form({ intent, id: "st1", reason: "x" }) }))).status, `${role} · ${intent}`).toBe(403);
      expect(h.calls, role).toEqual([]);
    }
    expect(table("stagedTransaction")[0].status).toBe("staged");
  }, 120_000);

  // Commercial, admin, pricing and cost pages. Each row: route file, its ROUTE_ACCESS key.
  const CLOSED_PAGES: Array<[string, string]> = [
    ["app.quotes", "quotes"], ["app.erp.customers", "erp/customers"], ["app.erp.customers.$id", "erp/customers/:id"], ["app.erp.crm", "erp/crm"], ["app.erp.crm.$id", "erp/crm/:id"],
    ["app.erp.agent-approvals", "erp/agent-approvals"], ["app.erp.privacy-requests", "erp/privacy-requests"], ["app.erp.reorder", "erp/reorder"],
    ["app.erp.cost-calculator", "erp/cost-calculator"], ["app.erp.pricing-settings", "erp/pricing-settings"], ["app.erp.pricing-rules", "erp/pricing-rules"], ["app.erp.admin-settings", "erp/admin-settings"],
    ["app.erp.vendors", "erp/vendors"], ["app.erp.vendor-cost-book", "erp/vendor-cost-book"], ["app.erp.reports-dashboard", "erp/reports-dashboard"], ["app.erp.owner-readiness", "erp/owner-readiness"],
    ["app.erp.agent-security", "erp/agent-security"], ["app.erp.ops-hub", "erp/ops-hub"], ["app.erp.product-setup", "erp/product-setup"], ["app.erp.materials", "erp/materials"],
    ["app.erp.machines", "erp/machines"], ["app.erp.margin-review", "erp/margin-review"], ["app.erp.actual-costs", "erp/actual-costs"], ["app.erp.cost-verification", "erp/cost-verification"],
  ];
  for (const [file, routeKey] of CLOSED_PAGES) {
    it(`${file}: closed to the lead and the bagger (loader${file === "app.erp.owner-readiness" ? "" : " and a posted write"}), exactly as ROUTE_ACCESS["${routeKey}"] says`, async () => {
      const path = resolve(`app/routes/${file}.tsx`);
      expect(existsSync(path), path).toBe(true);
      const mod = await import(/* @vite-ignore */ path);
      for (const role of ["print_operator", "bagger"] as const) {
        expect(viewerMayOpenRoute(routeKey, { role, canViewFinancials: false }), `${routeKey} in the table`).toBe(false);
        as(role); h.calls = []; h.writes = [];
        const params = { id: "x1" };
        const opened = await run(() => mod.loader({ request: get(`/app/${routeKey}`), params }));
        expect(opened.status, `${file} loader · ${role}`).toBe(403);
        if (typeof mod.action === "function") {
          const wrote = await run(() => mod.action({ request: new Request(`https://erp.test/app/${routeKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "delete", id: "x1" }) }), params }));
          expect(wrote.status, `${file} action · ${role}`).toBe(403);
        }
        expect(h.calls, `${file} · ${role} touched the database`).toEqual([]);
      }
    }, 120_000);
  }

  it("bagger: cannot assign / release / reject intake files, create a job, choose a printer or start a reprint", async () => {
    as("bagger");
    const intake = await import("../app/routes/app.erp.print-intake");
    h.t.printIntake = [intakeRow("r1", "mystery.pdf", HASH("1"), null as any, null as any, null as any, null as any, { status: "review", matchedProductionJobId: null, authoritativeTicket: null, routedFilename: null, printer: null })];
    const before = JSON.stringify(table("printIntake"));
    for (const fields of [{ intent: "assign", intakeId: "r1", target: "j2" }, { intent: "bulkAssign", intakeIds: "r1", target: "j2" }, { intent: "release", intakeId: "r1" }, { intent: "reject", intakeId: "r1", confirmReject: "yes" }]) {
      h.calls = [];
      const out = await run(() => intake.action({ request: form(fields as any) }));
      expect(out.body.ok, fields.intent).toBe(false);
      expect(out.body.message).toContain("Print Intake review actions are limited to owners, managers and print operators.");
      expect(h.calls, fields.intent).toEqual([]);
    }
    expect(JSON.stringify(table("printIntake"))).toBe(before);
    const newJob = await import("../app/routes/app.erp.production-new");
    expect((await run(() => newJob.loader({ request: get("/app/erp/production-new") }))).status).toBe(403); // no form, so no printer choice
    expect((await run(() => newJob.action({ request: form({ intent: "createManualJob", requestId: "66666666-6666-4666-8666-666666666666", customerName: "X", itemTitle: "Y", quantity: "1", printer: "roland" }) }))).status).toBe(403);
    expect(ROLE_PERMISSIONS.bagger).not.toContain("selectPrinter");
    expect((await post({ ...REPRINT })).status).toBe(403);
    expect(table("productionJob")).toHaveLength(3);
    expect(table("productionRun")).toHaveLength(0);
  }, 120_000);

  // DIFFERENCE (reported, not a hole): every other refusal in this block is HTTP 403. The Incoming Print
  // Files action refuses with HTTP 200 + { ok: false } (app/routes/app.erp.print-intake.tsx:134), and the
  // page itself opens for a bagger (ROUTE_ACCESS "erp/print-intake" = production_view) although the bagger
  // holds no action on it. Nothing is read or written in either case (asserted above).
  it("DIFFERENCE pinned: the intake action refuses with 200 + ok:false (not 403), and a bagger can open the page read-only", async () => {
    as("bagger");
    const intake = await import("../app/routes/app.erp.print-intake");
    expect((await run(() => intake.action({ request: form({ intent: "release", intakeId: "nope" }) }))).status).toBe(200);
    expect(ROUTE_ACCESS["erp/print-intake"]).toBe("production_view");
    expect((await run(() => intake.loader({ request: get("/app/erp/print-intake") }))).status).toBe(200);
    as("sales");
    expect((await run(() => intake.loader({ request: get("/app/erp/print-intake") }))).location).toBe(PRODUCTION_VIEW_DENIED_REDIRECT);
  }, 120_000);
});

/* ====================================================================== */
/* B — ROUTED FILENAME  <ITEM TICKET>__<STAFF FILE NAME>[__RUN].ext         */
/* ====================================================================== */

describe("B · routed filename — lifecycle of one item through the real route-plan and reprint actions", () => {
  const CMYK = "crud_HEATH_F_CMYK.pdf";
  const GLOSS = "crud_HEATH_F_g.pdf";
  const drop = (fileName: string, hash: string) => plan({ fileName, fileHash: hash, subfolder: SOLO, folderFiles: [CMYK, GLOSS] });
  const reprint = (fields: Record<string, string>) => post({ intent: "reprintItem", jobId: "j2", itemId: "s1", reprintReason: "machine_error", reprintQty: "10", chargeType: "internal", ...fields });

  it("CMYK -> gloss pair -> retry -> revision -> reprint -> remake: every name is unique, parses to the item, and carries the right run", async () => {
    // basic rules (pair is not a revision, retry writes nothing, same staff name = R2): order-to-production-routed-names 1-5, 11.
    // New here: the whole chain on ONE item, the remake, and a collision / parse check over every name ever issued.
    const issued: string[] = [];
    const take = (planned: any) => { expect(planned.decision, JSON.stringify(planned.reasons)).toBe("route"); expect(planned).toMatchObject({ itemId: "s1", itemTicket: `${SOLO}-01`, machine: "mimaki" }); issued.push(planned.ripName); return planned.ripName; };

    expect(take(await drop(CMYK, HASH("a")))).toBe(`${SOLO}-01__crud_HEATH_F_CMYK`); // CMYK only
    expect(take(await drop(GLOSS, HASH("b")))).toBe(`${SOLO}-01__crud_HEATH_F_g`); // gloss layer: same item, same press, own name
    expect(table("printIntake").map((row) => [row.revisionNumber, row.reprintNumber, row.printer])).toEqual([[1, 0, "mimaki"], [1, 0, "mimaki"]]); // a second layer is not a revision

    // retry / replay of the same hash: same name, no new row
    const rowsBefore = JSON.stringify(table("printIntake").map((row) => [row.id, row.routedFilename, row.revisionNumber, row.reprintNumber, row.attemptNumber]));
    expect((await drop(CMYK, HASH("a"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK`);
    expect(JSON.stringify(table("printIntake").map((row) => [row.id, row.routedFilename, row.revisionNumber, row.reprintNumber, row.attemptNumber]))).toBe(rowsBefore);

    // revision: the same staff name saved again (new content)
    expect(take(await drop(CMYK, HASH("c")))).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-A1`);
    expect(table("printIntake")).toHaveLength(3);

    // reprint: both CURRENT layers (CMYK revision 2 + gloss) go back under ONE reprint number
    as("print_operator");
    expect((await reprint({})).body.ok).toBe(true);
    expect(take(await drop(CMYK, HASH("c")))).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`);
    expect(take(await drop(GLOSS, HASH("b")))).toBe(`${SOLO}-01__crud_HEATH_F_g__P1-A1`);
    expect(intakeOf(HASH("a"))).toMatchObject({ routedFilename: `${SOLO}-01__crud_HEATH_F_CMYK`, reprintNumber: 0, status: "routed" }); // the superseded revision 1 is not re-routed

    // remake (after QC on the reprint)
    expect((await post({ intent: "qcItem", jobId: "j2", itemId: "s1", qcResult: "pass" })).body.ok).toBe(true);
    expect((await reprint({ runKind: "remake", reprintReason: "material_defect", reprintQty: "5", chargeType: "warranty" })).body.ok).toBe(true);
    expect(take(await drop(CMYK, HASH("c")))).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P2-A1`);
    expect(take(await drop(GLOSS, HASH("b")))).toBe(`${SOLO}-01__crud_HEATH_F_g__P2-A1`);
    expect(runsOf("s1").map((row) => [row.runNumber, row.kind, row.quantity, row.chargeType, reprintNumberOfRun(row)])).toEqual([[1, "original", 100, "customer_paid", 0], [2, "reprint", 10, "internal", 1], [3, "remake", 5, "warranty", 2]]);

    // no silent collision anywhere in the chain; every name is a safe file name within the limit and resolves to THIS item
    expect(new Set(issued).size).toBe(issued.length);
    for (const name of issued) {
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(name.length).toBeLessThanOrEqual(120);
      expect(parseRipTickets(`${name}.pdf`)).toMatchObject({ itemTicket: `${SOLO}-01`, jobTicket: SOLO });
      expect((await resolveRipIdentity(db, "shop-1", { jobName: name })).productionJobItemId).toBe("s1");
    }
    expect(issued.map((name) => reprintNumberOfRipName(name))).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(table("productionJob")).toHaveLength(3); // never a new job
    expect(table("productionJobItem").find((row) => row.id === "s1").quantity).toBe(100);
  }, 120_000);

  it("multi-item job: the item ticket prefix picks the item; a file with no prefix is NOT guessed", async () => {
    // also order-to-production-routed-names 5 and print-intake-ticket-folders 11-12
    expect(await plan({ fileName: `${JOB}-02 shortcakes_F_CMYK.pdf`, fileHash: HASH("d"), subfolder: JOB })).toMatchObject({ decision: "route", itemId: "i2", ripName: `${JOB}-02__shortcakes_F_CMYK` });
    const held = await plan({ fileName: "shortcakes_B_CMYK.pdf", fileHash: HASH("e"), subfolder: JOB });
    expect(held).toMatchObject({ decision: "review", machine: null, ripName: null, itemId: null });
    const row = intakeOf(HASH("e"));
    expect([row.status, row.printer ?? null, row.routedFilename ?? null, row.productionJobItemId ?? null, row.matchedProductionJobId ?? null]).toEqual(["review", null, null, null, null]);
  }, 120_000);

  it("a conflicting printer hint is held for review, never routed to the hint", async () => {
    // (1) a `_w` white layer on an item the ERP put on the Mimaki
    const white = await plan({ fileName: "crud_HEATH_F_w.pdf", fileHash: HASH("1"), subfolder: SOLO });
    expect(white).toMatchObject({ decision: "review", machine: null });
    expect(white.reasons.join(" ")).toContain("white_job_but_mimaki_selected_contradiction");
    // (2) a ROLAND tag in the staff name against the ERP's Mimaki
    const tagged = await plan({ fileName: "crud_HEATH_F_CMYK_ROLAND.pdf", fileHash: HASH("2"), subfolder: SOLO });
    expect(tagged).toMatchObject({ decision: "review", machine: null });
    expect(tagged.reasons.join(" ")).toContain("roland_filename_tag_but_erp_assigned_mimaki_contradiction");
    // (3) a folder that merely names a press is not a job folder: nothing is matched, nothing is routed
    const folder = await plan({ fileName: "crud_HEATH_F_CMYK.pdf", fileHash: HASH("3"), subfolder: "ROLAND" });
    expect(folder).toMatchObject({ decision: "review", machine: null, jobId: null });
    for (const hash of [HASH("1"), HASH("2"), HASH("3")]) { const row = intakeOf(hash); expect([row.status, row.printer ?? null, row.routedFilename ?? null], hash[0]).toEqual(["review", null, null]); }
    // (4) both tags in one name
    expect((await plan({ fileName: "x_ROLAND_MIMAKI_CMYK.pdf", fileHash: HASH("4"), subfolder: SOLO })).decision).toBe("review");
  }, 120_000);
});

describe("B · routed filename — the naming functions on awkward staff names", () => {
  const ITEM = { itemTicket: `${JOB}-02`, ripJobName: `${JOB}-02`, suggestedFileName: null };
  const TICKET = `${JOB}-02`;
  const AWKWARD = [
    "art__P1-A1.pdf", // looks like a run token
    "crud_HEATH_F_CMYK__R2-A1.pdf",
    "x__A9.pdf",
    "R2-P1-A1 notes.pdf",
    "GSO-20260101-0001-01 old.pdf", // another item's ticket typed by staff
    "gso_20260101_0001_01_final.pdf",
    "GSO-20260101-0001 proof v2.pdf", // a job ticket
    "old GSO-20260101-0001-01 and GSO-20250101-0009-03.pdf",
    "GSO 20260101 0001 01 spaced.pdf", // not a canonical ticket
    "HEATH F (final) #2 — côté A.pdf",
    "naïve café_Ünïcode ✓ label.pdf",
    "a  b\tc.pdf",
    "..weird..name...pdf",
    "name.with.dots.v1.2.pdf",
    "日本語ラベル_CMYK.pdf",
    "C:\\Users\\dana\\Desktop\\crud HEATH B_g.PDF",
  ];

  it("punctuation, spaces, unicode, `__`, run-like text and embedded tickets: the routed name always resolves to the ROUTED item", () => {
    for (const staffName of AWKWARD) {
      const routed = ripFileBaseName(ITEM, staffName);
      expect(routed.startsWith(`${TICKET}__`), `${staffName} -> ${routed}`).toBe(true);
      expect(routed, staffName).toMatch(/^[A-Za-z0-9._-]+$/); // Windows-safe
      expect(routed.slice(TICKET.length + 2), staffName).not.toContain("__"); // exactly one separator
      // a ticket typed in its canonical form (hyphens / underscores) is not carried along
      if (!/GSO \d/.test(staffName)) expect(routed, staffName).not.toMatch(/GSO[-_]\d{8}[-_]\d{4}.*GSO[-_]\d{8}[-_]\d{4}/i);
      // the item — never a ticket embedded in the staff name — for BOTH parsers (press results and Print Intake)
      expect(parseRipTickets(`${routed}.pdf`), staffName).toMatchObject({ itemTicket: TICKET, jobTicket: JOB });
      expect(extractItemTicketFrom(`${routed}.pdf`), staffName).toBe(TICKET);
      // run parsing stays unambiguous: no run is read out of the staff name
      expect(parseRunIdentity(routed), staffName).toEqual(DEFAULT_RUN);
      expect(reprintNumberOfRipName(routed), staffName).toBe(0);
      // and a real run token only ever adds to the end
      const reprinted = applyRunSuffix(routed, { revision: 2, reprint: 1, attempt: 1 });
      expect(reprinted, staffName).toBe(`${routed}__R2-P1-A1`);
      expect(parseRipTickets(reprinted).itemTicket).toBe(TICKET);
      expect(reprintNumberOfRipName(`${reprinted}.pdf`)).toBe(1);
      expect(reprinted.length).toBeLessThanOrEqual(120);
    }
    expect(ripFileBaseName(ITEM, "GSO-20260101-0001-01 old.pdf")).toBe(`${TICKET}__old`);
    expect(ripFileBaseName(ITEM, "art__P1-A1.pdf")).toBe(`${TICKET}__art_P1-A1`);
    // OBSERVATION (safe today): a ticket typed with SPACES is not recognised as a ticket by routedStaffNameSegment
    // (print-intake-routing.server.ts:465) and comes out in underscore form after the separator. Both parsers take the
    // FIRST ticket in a name, which is always the routed item's, so it resolves correctly.
    expect(ripFileBaseName(ITEM, "GSO 20260101 0001 01 spaced.pdf")).toBe(`${TICKET}__GSO_20260101_0001_01_spaced`);
  });

  it("through the real routes: a file carrying ANOTHER ticket, assigned by the lead to item 02, routes as item 02", async () => {
    as("print_operator");
    const staffName = "GSO-20260101-0001-01 old.pdf";
    const first = await plan({ fileName: staffName, fileHash: HASH("f") });
    expect(first).toMatchObject({ decision: "review", jobId: null, machine: null }); // the typed ticket matches no job: held, never guessed
    const intake = await import("../app/routes/app.erp.print-intake");
    expect((await run(() => intake.action({ request: form({ intent: "assign", intakeId: intakeOf(HASH("f")).id, target: "j1|i2" }) }))).body.ok).toBe(true);
    const routed = await plan({ fileName: staffName, fileHash: HASH("f") });
    expect(routed).toMatchObject({ decision: "route", itemId: "i2", itemTicket: TICKET, ripName: `${TICKET}__old` });
    expect((await resolveRipIdentity(db, "shop-1", { jobName: routed.ripName })).productionJobItemId).toBe("i2");
    // the other job's ticket in the name, dropped in THIS job's folder, is a mismatch for a person: print-intake-ticket-folders "6-7"
  }, 120_000);

  it("long staff name: cut to the documented limit, start and layer suffix kept, still parseable; names that differ at the END stay different", () => {
    expect(src("app/lib/print-intake-routing.server.ts")).toContain("const ROUTED_STAFF_NAME_MAX = 80;");
    const stem = `${"KRUD_CAFE_HEATH_BAR_LIMITED_EDITION_".repeat(5)}`; // 180 characters
    const front = routedStaffNameSegment(`${stem}_F_CMYK.pdf`);
    const back = routedStaffNameSegment(`${stem}_B_CMYK.pdf`);
    const gloss = routedStaffNameSegment(`${stem}_F_g.pdf`);
    for (const segment of [front, back, gloss]) expect(segment.length).toBeLessThanOrEqual(80);
    expect(front.startsWith("KRUD_CAFE_HEATH_BAR")).toBe(true);
    expect(front.endsWith("_F_CMYK")).toBe(true);
    expect(new Set([front, back, gloss]).size).toBe(3);
    const routed = ripFileBaseName(ITEM, `${stem}_F_CMYK.pdf`);
    expect(routed.length).toBeLessThanOrEqual(TICKET.length + 2 + 80);
    const withRun = applyRunSuffix(routed, { revision: 12, reprint: 12, attempt: 12 });
    expect(withRun.length).toBeLessThanOrEqual(120);
    expect(parseRunIdentity(withRun)).toEqual({ revision: 12, reprint: 12, attempt: 12 }); // the run token is never cut off
    expect(parseRipTickets(withRun).itemTicket).toBe(TICKET);
  });
});

describe("B · routed filename — DEFECTS (two different files, one routed name)", () => {
  const both = async (first: string, second: string) => {
    const a = await plan({ fileName: first, fileHash: HASH("a"), subfolder: SOLO });
    const b = await plan({ fileName: second, fileHash: HASH("b"), subfolder: SOLO });
    expect([a.decision, b.decision]).toEqual(["route", "route"]);
    return [a.ripName, b.ripName, table("printIntake").map((row) => row.revisionNumber).join(",")];
  };

  // DEFECT B1 — truncation collision.
  //   app/lib/print-intake-routing.server.ts:468-471 (routedStaffNameSegment) keeps the first 54 and the last 25
  //   characters of a staff name longer than 80; whatever differs in between is dropped.
  //   input: two different files on the same item whose 100+ character names differ only in the middle
  //   expected: two different routed names (or the second held for review)
  //   actual: both route, both revision 1, with the IDENTICAL routed name — the second overwrites the first at the press
  //   fix: when truncating, put a short digest of the full stem in the kept part, e.g.
  //        `${stem.slice(0, MAX - 34)}_${sha1(stem).slice(0, 7)}_${stem.slice(-25)}`
  it("FIXED 2026-11-20 — B1: two long staff names that differ only in the MIDDLE get different routed names", async () => {
    const head = "KRUD_CAFE_SEASONAL_COLLECTION_AUTUMN_2026_POUCH_ARTWORK_FINAL_"; // > 54 characters
    const [a, b] = await both(`${head}STRAWBERRY_SHORTCAKE_approved_by_customer_F_CMYK.pdf`, `${head}BLUEBERRY__CHEESECAKE_approved_by_customer_F_CMYK.pdf`);
    expect(a).not.toBe(b);
  }, 120_000);

  // DEFECT B2 — normalisation collision.
  //   app/lib/print-intake-routing.server.ts:463-467 maps every run of characters outside [A-Za-z0-9.-] to "_", drops the
  //   extension and drops a typed ticket; app/routes/api.print-intake.route-plan.tsx:278-283 only treats a file as a
  //   REVISION when `originalFilename` is byte-equal. So two files whose names differ only by punctuation / spaces /
  //   a typed ticket / non-ASCII text are neither a revision nor distinct: same routed name, both revision 1.
  //   expected: different routed names, or revision 2, or a review hold — never the same name twice at revision 1
  //   actual: identical routed name, revisionNumber 1 on both rows
  //   fix (route-plan.tsx, before the upsert): look for another routed row with the same authoritativeTicket and the
  //        same routedFilename base but a different hash; if found treat it as the next revision (R+1) —
  //        i.e. key the revision lookup on the ROUTED name, not on the raw staff name.
  it.fails.each([
    ["a space vs an underscore", "HEATH F.pdf", "HEATH_F.pdf"],
    ["brackets", "art (1).pdf", "art_1.pdf"],
    ["corrected artwork re-saved with the ticket typed in front", "crud_HEATH_F_CMYK.pdf", `${SOLO}-01 crud_HEATH_F_CMYK.pdf`],
    ["two names with no ASCII letters at all (both fall back to the bare ticket)", "日本語.pdf", "한국어.pdf"],
  ])("B2: %s — %s / %s do not end up as one routed name at revision 1", async (_label, first, second) => {
    const [a, b, revisions] = await both(first, second);
    expect(a === b && revisions === "1,1").toBe(false);
  }, 120_000);

  // DEFECT B3 — a staff name that IS a run token.
  //   app/lib/print-intake-routing.server.ts:481 joins `${itemTicket}__${staffName}`; RUN_SEGMENT_RE (:770) and
  //   production-run.ts:201 (RUN_TOKEN_RE) read `__A1`, `__P1-A1`, `__R2-A1` at the end of a name as the run.
  //   input: staff files named "A2.pdf" (a paper size), "P1-A1.pdf", "R2-A1.pdf"
  //   expected: the original run (R1 / P0 / A1); a reprint appends its token after the staff name
  //   actual: "…-01__P1-A1" reads as reprint 1 (its press result is listed as "Reprint P1 — no run recorded"),
  //           "…-01__A2" reads as attempt 2, and applyRunSuffix REPLACES the staff name, so "A1.pdf" and "A2.pdf"
  //           of one item both become "…-01__P1-A1" on a reprint
  //   fix: in routedStaffNameSegment, if the stem matches /^(?:R\d+-)?(?:P\d+-)?A\d+$/i prefix it (e.g. `file_${stem}`)
  it.each(["A2.pdf", "P1-A1.pdf", "R2-A1.pdf"])("FIXED 2026-11-20 — B3: a staff file called %s is not read as a run token", (staffName) => {
    const routed = ripFileBaseName({ itemTicket: `${SOLO}-01`, ripJobName: `${SOLO}-01`, suggestedFileName: null }, staffName);
    expect(parseRunIdentity(routed)).toEqual(DEFAULT_RUN);
    expect(reprintNumberOfRipName(routed)).toBe(0);
    expect(applyRunSuffix(routed, { reprint: 1 })).toBe(`${routed}__P1-A1`);
  });

  // DEFECT B4 — a custom RIP name can lose its run token.
  //   app/lib/print-intake-routing.server.ts:477 allows a 120-character base and :798 cuts base + run to 120.
  //   input: an item whose stored ripJobName is 118 characters, reprint 1
  //   expected: the name still ends in __P1-A1
  //   actual: the token is cut ("…__"), so the reprint's press result is counted as the original run
  //   fix: cut the BASE, not the result — `${stripped.slice(0, 120 - suffix.length)}${suffix}`
  it.fails("B4: the run token survives on a long custom RIP name", () => {
    const routed = ripFileBaseName({ itemTicket: `${SOLO}-01`, ripJobName: `${SOLO}-01_${"X".repeat(98)}`, suggestedFileName: null }, "art.pdf");
    expect(reprintNumberOfRipName(applyRunSuffix(routed, { reprint: 1 }))).toBe(1);
  });
});

/* ====================================================================== */
/* C — PATCH F re-confirmation (only what the existing fixtures do not pin)  */
/* ====================================================================== */

describe("C · Patch F — clear ink in ACTUAL dollars, no assumed white slot, nothing historical attached", () => {
  // slot 136 + 137 parsing, the JobInfo pairing rules and idempotent re-import: jobinfo-clear-actuals-2026-11-18 (1-12)
  // and mimaki-patch-f-software-readiness-2026-11-19 (LINK 1-5, SAFETY). Not repeated.

  it("clear = slot 136 + slot 137, and the actual-cost path prices it at $0.09 / mL whatever the machine row says", () => {
    expect([...JOBINFO_CLEAR_SLOT_CODES]).toEqual([136, 137]);
    const perItem = parseInkUsedLine("inkUsed=1;0,2;0,3;0,4;0,136;152,137;152").clearCc; // 0.304 cc per arranged item
    expect(perItem).toBeCloseTo(0.304, 9);
    const clearMl = perItem * 65; // 19.76 mL for 65 arranged copies
    // where the rate lives
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBe(0.09);
    expect(channelInkRatePerMl("mimaki", "gloss")).toBe(0.09);
    expect(src("app/lib/ink-rates-shared.ts")).toContain("mimakiGlossPerMl: (90 / 1000) as number | null");
    // a machine row with another clear price cannot change it (the canonical rate wins)
    const rates = buildBrandRates([{ name: MIMAKI, inkChannels: [{ inkType: "gloss", inkName: "Clear", enabled: true, costPerMl: 0.5, cartridgeCost: 500, cartridgeMl: 1000 }] }]);
    expect(rates[0]).toMatchObject({ brand: "mimaki", glossPerMl: 0.09, cmykPerMl: 0.176 });
    const entry = { machineName: MIMAKI, sourceJobName: `${JOB}-01__crud_HEATH_F_g`, cmykInkMl: 0, whiteInkMl: 0, glossInkMl: clearMl, inkMl: clearMl, printMinutes: 12 };
    expect(computeEntryCosts(entry, rates).inkCost).toBeCloseTo(19.76 * 0.09, 9); // $1.7784 — not the CMYK rate, no freight
    // and the per-run dollars the owner sees use the same function
    const dollars = runCostDollars([], [entry], rates, machineRatePerHour({}));
    expect(dollars.runs[0]).toMatchObject({ label: "Run 1 — Original", inkCost: 1.78, pressCost: 1, knownCost: 2.78, inkIncomplete: false });
    expect(dollars.notIncluded).toEqual(RUN_COST_NOT_INCLUDED);
  });

  it("no white slot is assumed from JobInfo for the Mimaki: 131 / 133 / any other code stay unknown and reach no total", () => {
    const ink: any = parseInkUsedLine("inkUsed=1;10,2;10,3;10,4;10,131;500,133;400,134;300,135;200,136;152,137;152");
    expect(ink.clearCc).toBeCloseTo(0.304, 9);
    expect(ink.perItemKnownCc).toBeCloseTo(0.04, 9);
    expect(ink.unknownChannels.map((channel: any) => channel.code)).toEqual([131, 133, 134, 135]);
    expect(Object.keys(ink).filter((key) => /white/i.test(key))).toEqual([]); // the parser has no white field at all
    const source = src("app/lib/jobinfo-fallback.server.ts");
    expect(source.match(/code === [^)]+\)/g)).toEqual(["code === 1)", "code === 2)", "code === 3)", "code === 4)", "code === JOBINFO_CLEAR_SLOT_CODES[0])", "code === JOBINFO_CLEAR_SLOT_CODES[1])"]);
  });

  it("an un-ticketed historical result is attached to no job — even with the same customer, staff name and a routed file on record", async () => {
    // through the upload route: mimaki-patch-f "SAFETY". Here: the matcher itself, against this file's jobs.
    h.t.productionJobFile = [{ id: "f1", shop: "shop-1", jobId: "j1", productionJobItemId: "i1", fileType: "print_file", assetSource: "nas", fileName: `${JOB}-01__crud_HEATH_F_CMYK.pdf`, originalFileName: "crud_HEATH_F_CMYK.pdf", sourceRef: HASH("a"), fileUrl: "gso:nas-print-file/x", createdAt: T0 }];
    for (const name of ["crud_HEATH_F_CMYK", "crud_HEATH_F_CMYK.pdf", "Krud Cafe HEATH pouch", "HEATH pouch 500", "S01_20251017175118550"]) {
      const result = await resolveRipIdentity(db, "shop-1", { jobName: name });
      expect(result, name).toMatchObject({ status: "unmatched", productionJobId: null, productionJobItemId: null });
    }
    // a ticket that no job owns (an old, pre-ERP numbering) is not attached either
    expect(await resolveRipIdentity(db, "shop-1", { jobName: "GSO-20250101-0001-01__crud_HEATH_F_CMYK" })).toMatchObject({ status: "unmatched", productionJobId: null });
    expect(h.writes).toEqual([]);
  });

  it("SOURCE PIN: the go-live cutoff lives in the sync script on the RIP PC (the server has no date filter of its own)", () => {
    // jobinfo-clear-actuals-2026-11-18 test 12 pins the main-loop call; this pins fail-closed parsing and the server side.
    const script = src("tools/gso-rasterlink-sync.ps1");
    expect(script).toContain("NotBeforeUtc      = if ($raw.NotBeforeUtc) { [string]$raw.NotBeforeUtc } else { \"\" }");
    expect(script).toContain("if (-not [datetime]::TryParse($NotBeforeUtc, [System.Globalization.CultureInfo]::InvariantCulture, $style, [ref]$cutoff)) { return ,$kept }");
    expect(src("app/routes/api.rip-imports.upload.tsx")).not.toMatch(/NotBeforeUtc|cutoff/i);
  });
});

/* ====================================================================== */
/* D — REPRINT / REMAKE live-readiness                                      */
/* ====================================================================== */

describe("D · reprint / remake — as the production lead, test doubles only", () => {
  beforeEach(() => { seedLayers(); as("print_operator"); });

  it("quantity, reason and a valid who-pays are required; a refused request changes nothing", async () => {
    // quantity rule (service + route): shared-production-backbone "the reprint quantity is required and never guessed"
    const before = JSON.stringify(h.t);
    const refused: Array<[string, Record<string, string>]> = [
      ["no quantity", { reprintQty: "" }], ["zero", { reprintQty: "0" }], ["not whole", { reprintQty: "12.5" }], ["negative", { reprintQty: "-3" }],
      ["no reason", { reprintReason: "" }], ["unknown reason", { reprintReason: "because" }], ["unknown who-pays", { chargeType: "banana" }],
    ];
    for (const [label, over] of refused) {
      h.writes = [];
      const out = await post({ ...REPRINT, ...over });
      expect(out.status, label).toBe(400);
      expect(out.body.ok, label).toBe(false);
      expect(h.writes, label).toEqual([]);
    }
    expect(JSON.stringify(h.t)).toBe(before);
  }, 120_000);

  // DEFECT D1 — who-pays is not required.
  //   app/routes/app.erp.production.tsx:1598  `const chargeRaw = String(formData.get("chargeType") || "internal");`
  //   input: reprintItem posted with reason and quantity but NO chargeType field
  //   expected: 400 "Pick who pays for this reprint…", nothing written
  //   actual: 200, a run recorded as chargeType "internal"
  //   fix: `const chargeRaw = String(formData.get("chargeType") || "");` (the isRunChargeType check on :1599 then refuses it)
  it("FIXED 2026-11-20 — D1: a reprint posted with NO who-pays choice is refused", async () => {
    const { chargeType: _omitted, ...fields } = REPRINT;
    const out = await post(fields);
    expect(out.status).toBe(400);
    expect(runsOf("i1")).toEqual([]);
  }, 120_000);

  // DEFECT D2 — an invalid kind silently becomes "reprint".
  //   app/routes/app.erp.production.tsx:1597  `const runKind = isRunKind(runKindRaw) ? runKindRaw : "reprint";`
  //   input: runKind "banana"   expected: 400   actual: 200, kind "reprint"
  //   fix: refuse when a runKind was posted and !isRunKind(runKindRaw)
  it("FIXED 2026-11-20 — D2: a reprint posted with an unknown kind is refused, not recorded as a reprint", async () => {
    const out = await post({ ...REPRINT, runKind: "banana" });
    expect(out.status).toBe(400);
  }, 120_000);

  it("internal reprint: new run, QC reset, BOTH layers re-routed under one run token, press results on that run, cost only", async () => {
    const itemBefore = { ...table("productionJobItem")[0] };
    // the original passed QC first, so the reset is visible
    expect((await post({ intent: "qcItem", jobId: "j1", itemId: "i1", qcResult: "pass" })).body.ok).toBe(true);
    expect((await post({ intent: "qcItem", jobId: "j1", itemId: "i2", qcResult: "pass" })).body.ok).toBe(true);
    h.writes = [];
    const out = await post({ ...REPRINT, reprintNote: "banding on the left edge" });
    expect(out.body.ok, out.body.message).toBe(true);
    expect(out.body.message).toContain("all 2 layer files");

    // ordered quantity and unit price unchanged
    const item = table("productionJobItem")[0];
    expect([item.quantity, item.unitPrice, item.unitCost, item.itemTicket]).toEqual([itemBefore.quantity, itemBefore.unitPrice, itemBefore.unitCost, itemBefore.itemTicket]);
    // a new ProductionRun (run 1 is written from the ordered quantity the first time it is needed)
    expect(runsOf("i1").map((row) => [row.runNumber, row.kind, row.quantity, row.reasonCode ?? null, row.chargeType, row.status, row.runLabel])).toEqual([
      [1, "original", 500, null, "customer_paid", "qc_passed", "A1"], [2, "reprint", 25, "color_quality_issue", "internal", "open", "P1-A1"],
    ]);
    expect(itemRunSummary(item, runsOf("i1"))).toMatchObject({ orderedQuantity: 500, billableQuantity: 500, reprintQuantity: 25, internalReprintQuantity: 25, customerPaidReprintQuantity: 0 });
    // QC reset: a new pass is needed on THIS item (the other item's pass stands), and the job cannot be marked ready
    expect([item.qcResult, item.qcBy, item.qcAt]).toEqual([null, null, null]);
    const verdict = evaluateQcForCompletion(table("productionJobItem").filter((row) => row.jobId === "j1"), table("productionJobEvent").filter((row) => row.jobId === "j1") as any);
    expect(verdict.ok).toBe(false);
    expect((await post({ intent: "markFulfillmentReady", jobId: "j1", kind: "ship" })).status).toBe(400);
    expect(table("productionJob")[0].fulfillmentState).toBeNull();

    // EVERY layer file is re-routed with the same run token — recorded, then issued by the real route-plan
    expect(table("printIntake").map((row) => [row.routedFilename, row.reprintNumber, row.attemptNumber, row.status])).toEqual([
      [`${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, 1, 1, "retry_allowed"], [`${JOB}-01__crud_HEATH_F_g__P1-A1`, 1, 1, "retry_allowed"],
    ]);
    const cmyk = await plan({ fileName: "crud_HEATH_F_CMYK.pdf", fileHash: HASH("a") });
    const gloss = await plan({ fileName: "crud_HEATH_F_g.pdf", fileHash: HASH("b") });
    expect([cmyk.decision, cmyk.itemId, cmyk.ripName, cmyk.machine]).toEqual(["route", "i1", `${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, "mimaki"]);
    expect([gloss.decision, gloss.itemId, gloss.ripName, gloss.machine]).toEqual(["route", "i1", `${JOB}-01__crud_HEATH_F_g__P1-A1`, "mimaki"]);
    expect(table("printIntake")).toHaveLength(2);
    expect(table("productionJob")).toHaveLength(3);

    // press results: the run token in the name the press reports decides the run
    const entry = (sourceJobName: string, cmykInkMl: number, glossInkMl: number, printMinutes: number) => ({ sourceJobName, machineName: MIMAKI, cmykInkMl, whiteInkMl: 0, glossInkMl, inkMl: cmykInkMl + glossInkMl, printMinutes, sqft: 0 });
    const entries = [
      entry(`${JOB}-01__crud_HEATH_F_CMYK`, 12, 0, 30), entry(`${JOB}-01__crud_HEATH_F_g`, 0, 19.76, 20),
      entry(cmyk.ripName, 1, 0, 6), entry(gloss.ripName, 0, 2, 3),
    ];
    const actuals = actualsByRun(runsOf("i1"), entries);
    expect(actuals.map((row) => [row.runNumber, row.kind, row.entries, Number(row.inkMl.toFixed(2)), row.printMinutes])).toEqual([[1, "original", 2, 31.76, 50], [2, "reprint", 2, 3, 9]]);
    const accounting = runCostAccounting(runsOf("i1"), actuals);
    expect(accounting.internalExtra).toEqual({ runs: 1, quantity: 25, inkMl: 3, printMinutes: 9 });
    expect(accounting.customerPaidExtra.runs).toBe(0);
    expect(accounting.revenueChange).toBe("none");
    const dollars = runCostDollars(runsOf("i1"), entries, buildBrandRates([{ name: MIMAKI }]), 5);
    expect(dollars.runs.map((row) => [row.runNumber, row.costClass, row.inkCost, row.pressCost, row.knownCost])).toEqual([
      [1, "original", 3.89, 4.17, 8.06], // 12 x 0.176 + 19.76 x 0.09 ; 50 min x $5/h
      [2, "internal_extra", 0.36, 0.75, 1.11], // 1 x 0.176 + 2 x 0.09 ; 9 min x $5/h
    ]);
    expect([dollars.original, dollars.shopAbsorbed, dollars.customerPaid, dollars.revenueChange]).toEqual([8.06, 1.11, 0, "none"]);
    // revenue is what it was: ordered quantity x unit price
    expect(item.quantity * item.unitPrice).toBe(500 * MONEY.unitPrice1);
  }, 120_000);

  it("remake after QC: a further run of the same item, kind remake, next run token, still no revenue", async () => {
    expect((await post(REPRINT)).body.ok).toBe(true);
    expect((await post(REPRINT)).status).toBe(409); // not doubled while QC is pending (retry-idempotency d-ii)
    expect((await post({ intent: "qcItem", jobId: "j1", itemId: "i1", qcResult: "reprint_required", qcNote: "seal failed" })).body.ok).toBe(true);
    const out = await post({ ...REPRINT, runKind: "remake", reprintReason: "material_defect", reprintQty: "40", chargeType: "warranty" });
    expect(out.body.ok, out.body.message).toBe(true);
    expect(out.body.message).toContain("Warranty / replacement — no charge");
    expect(runsOf("i1").map((row) => [row.runNumber, row.kind, row.quantity, row.chargeType, row.status, row.runLabel])).toEqual([
      [1, "original", 500, "customer_paid", "reprinted", "A1"], [2, "reprint", 25, "internal", "qc_failed", "P1-A1"], [3, "remake", 40, "warranty", "open", "P2-A1"],
    ]);
    expect(table("printIntake").map((row) => row.routedFilename)).toEqual([`${JOB}-01__crud_HEATH_F_CMYK__P2-A1`, `${JOB}-01__crud_HEATH_F_g__P2-A1`]);
    expect(runsOf("i1").map((row) => runCostClassOf(row))).toEqual(["original", "internal_extra", "internal_extra"]);
    expect(itemRunSummary(table("productionJobItem")[0], runsOf("i1"))).toMatchObject({ billableQuantity: 500, reprintCount: 2, reprintQuantity: 65, internalReprintQuantity: 65 });
    expect(table("productionJobItem")[0]).toMatchObject({ quantity: 500, unitPrice: MONEY.unitPrice1 });
  }, 120_000);

  it("customer-paid: recorded for the floor only — no order, invoice, charge, quote or outbound call", async () => {
    h.writes = [];
    const out = await post({ ...REPRINT, chargeType: "customer_paid", reprintReason: "customer_change_error", reprintQty: "100" });
    expect(out.body.ok).toBe(true);
    expect(out.body.message).toContain("CUSTOMER-PAID: nothing was charged here");
    expect([...new Set(h.writes)].sort()).toEqual(["printIntake.update", "productionJobEvent.create", "productionJobItem.updateMany", "productionRun.create"]);
    for (const name of ["quote", "quoteItem", "stagedTransaction", "order", "draftOrder", "invoice", "payment", "agentReviewQueueItem", "opsOutboxMessage"]) expect(table(name), name).toEqual([]);
    expect(h.fetches).toEqual([]);
    expect(table("productionJob")).toHaveLength(3);
    const item = table("productionJobItem")[0];
    expect([item.quantity, item.unitPrice]).toEqual([500, MONEY.unitPrice1]);
    expect(runsOf("i1").map((row) => runCostClassOf(row))).toEqual(["original", "customer_paid_extra"]);
    expect(itemRunSummary(item, runsOf("i1"))).toMatchObject({ billableQuantity: 500, customerPaidReprintQuantity: 100, internalReprintQuantity: 0 });
    expect(runCostAccounting(runsOf("i1"), []).revenueChange).toBe("none");
  }, 120_000);

  // DEFECT D3 — corrected artwork dropped while a reprint run is open loses the run.
  //   app/routes/api.print-intake.route-plan.tsx:278-283. A NEW hash under the same staff name looks for a prior row with
  //   status "routed" and then sets `run = { revision: prior.revisionNumber + 1, reprint: 0, attempt: 1 }`.
  //   input: single-item job with a routed CMYK layer; the lead starts reprint P1 (reason: artwork / prepress error);
  //          staff save the CORRECTED artwork under the same name in the job folder
  //   expected: …__R2-P1-A1 — the corrected file belongs to the open reprint run
  //   actual (a) after the agent re-routed the old layer (row "routed", P1): …__R2-A1, reprint 0
  //          (b) before the agent's next pass (row still "retry_allowed"): no prior row is found at all, so the corrected
  //              file gets the BARE original name …__crud_HEATH_F_CMYK (revision 1) — the same name the original run printed under
  //          either way its press result is counted on Run 1 (cost of the order) and the open reprint run shows none
  //   fix: look the prior row up with status in ["routed", "retry_allowed", "assigned"], select reprintNumber too, and
  //        carry it: `run = { revision: prior.revisionNumber + 1, reprint: prior.reprintNumber, attempt: 1 }`
  describe("D3", () => {
    const CMYK = "crud_HEATH_F_CMYK.pdf";
    const openReprintOnSolo = async () => {
      h.t.printIntake = [intakeRow("sp1", CMYK, HASH("a"), "j2", "s1", `${SOLO}-01`, `${SOLO}-01__crud_HEATH_F_CMYK`)];
      expect((await post({ ...REPRINT, jobId: "j2", itemId: "s1", reprintReason: "artwork_prepress_error" })).body.ok).toBe(true);
      expect(runsOf("s1").map((row) => [row.runNumber, row.kind, row.status, row.runLabel])).toEqual([[1, "original", "reprinted", "A1"], [2, "reprint", "open", "P1-A1"]]);
    };
    it.fails("D3a: corrected artwork saved AFTER the old layer was re-routed keeps the reprint's run token", async () => {
      await openReprintOnSolo();
      expect((await plan({ fileName: CMYK, fileHash: HASH("a"), subfolder: SOLO })).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__P1-A1`);
      const corrected = await plan({ fileName: CMYK, fileHash: HASH("c"), subfolder: SOLO });
      expect(corrected.decision).toBe("route");
      expect(corrected.ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`);
    }, 120_000);
    it.fails("D3b: corrected artwork saved BEFORE the agent's next pass is a revision of the open reprint, not the original name again", async () => {
      await openReprintOnSolo();
      const corrected = await plan({ fileName: CMYK, fileHash: HASH("c"), subfolder: SOLO });
      expect(corrected.decision).toBe("route");
      expect(corrected.ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`);
    }, 120_000);
    it("what happens today (pinned so a fix shows up here): (a) R2 with reprint 0, (b) the bare original name at revision 1", async () => {
      await openReprintOnSolo();
      const early = await plan({ fileName: CMYK, fileHash: HASH("c"), subfolder: SOLO });
      expect([early.decision, early.ripName]).toEqual(["route", `${SOLO}-01__crud_HEATH_F_CMYK`]);
      expect(reprintNumberOfRipName(early.ripName)).toBe(0);
      seed(); seedLayers(); as("print_operator");
      await openReprintOnSolo();
      await plan({ fileName: CMYK, fileHash: HASH("a"), subfolder: SOLO });
      const late = await plan({ fileName: CMYK, fileHash: HASH("d"), subfolder: SOLO });
      expect([late.decision, late.ripName]).toEqual(["route", `${SOLO}-01__crud_HEATH_F_CMYK__R2-A1`]);
    }, 120_000);
  });
});

/* ====================================================================== */
/* E — REORDER, production side                                             */
/* ====================================================================== */

describe("E · reorder — a new job beside an untouched old one", () => {
  const seedOldJob = () => {
    h.t.productionJob.push(jobRow("j0", OLD, { company: "Krud Cafe", status: "completed", completedAt: new Date("2026-11-05T18:00:00Z"), proofStatus: "approved", actualCostFinalized: true, actualTotalCost: 88.5 }));
    h.t.productionJobItem.push(
      itemRow("o1", "j0", `${OLD}-01`, { quantity: 500, unitPrice: 1.25, unitCost: 0.4, qcResult: "pass", qcAt: new Date("2026-11-05T17:00:00Z") }),
      itemRow("o2", "j0", `${OLD}-02`, { productTitle: "SHORTCAKES pouch", quantity: 250, unitPrice: 1.4, unitCost: 0.45, sortOrder: 2, qcResult: "pass", qcAt: new Date("2026-11-05T17:00:00Z") }),
    );
    const file = (id: string, itemId: string, fileName: string, hash: string) => ({ id, shop: "shop-1", jobId: "j0", productionJobItemId: itemId, fileType: "print_file", assetSource: "nas", assetRole: "printFile", fileName, originalFileName: fileName.split("__")[1], sourceRef: hash, fileUrl: `gso:nas-print-file/${hash}`, matchedBy: "print_intake", jobTicket: OLD, notes: "Sent to Mimaki.", createdAt: T0 });
    h.t.productionJobFile = [file("of1", "o1", `${OLD}-01__crud_HEATH_F_CMYK.pdf`, HASH("7")), file("of2", "o2", `${OLD}-02__crud_SHORTCAKES_F_CMYK.pdf`, HASH("8"))];
    h.t.printIntake = [
      intakeRow("op1", "crud_HEATH_F_CMYK.pdf", HASH("7"), "j0", "o1", `${OLD}-01`, `${OLD}-01__crud_HEATH_F_CMYK`),
      intakeRow("op2", "crud_SHORTCAKES_F_CMYK.pdf", HASH("8"), "j0", "o2", `${OLD}-02`, `${OLD}-02__crud_SHORTCAKES_F_CMYK`),
    ];
    h.t.productionRun = [{ id: "or1", shop: "shop-1", jobId: "j0", itemId: "o1", runNumber: 1, kind: "original", quantity: 500, chargeType: "customer_paid", status: "qc_passed", runLabel: "A1", createdAt: T0 }];
    h.t.printLogEntry = [{ id: "oe1", shop: "shop-1", importId: "imp0", productionJobId: "j0", productionJobItemId: "o1", jobTicket: `${OLD}-01`, sourceJobName: `${OLD}-01__crud_HEATH_F_CMYK`, machineName: MIMAKI, cmykInkMl: 11, whiteInkMl: 0, glossInkMl: 0, inkMl: 11, printMinutes: 28, sqft: 30, createdAt: T0 }];
  };
  const oldSide = () => JSON.stringify([
    table("productionJob").filter((row) => row.id === "j0"), table("productionJobItem").filter((row) => row.jobId === "j0"), table("productionJobFile").filter((row) => row.jobId === "j0"),
    table("productionRun").filter((row) => row.jobId === "j0"), table("printLogEntry").filter((row) => row.productionJobId === "j0"), table("productionJobEvent").filter((row) => row.jobId === "j0"),
  ]);
  const oldIntake = () => JSON.stringify(table("printIntake").filter((row) => ["op1", "op2"].includes(row.id)));
  const release = async () => {
    const result = await createProductionJobFromSource(db, {
      shop: "shop-1", actor: "owner@gso.test",
      source: { type: "released_transaction", authorizedBy: "owner@gso.test", transactionId: "reorder-release-closeout-1", origin: "agent_proposal", payload: { customerName: "Krud Cafe", items: [
        { productTitle: "HEATH pouch", quantity: 750, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "o1", reorderArtworkMode: "same_artwork" },
        { productTitle: "SHORTCAKES pouch", quantity: 300, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "o2", reorderArtworkMode: "revision" },
      ] } },
    } as any);
    const items = table("productionJobItem").filter((row) => row.jobId === result.job.id).sort((a, b) => a.sortOrder - b.sortOrder);
    return { job: result.job, items };
  };
  beforeEach(seedOldJob);

  it("same artwork: new job, new item tickets, new quantity, the approved file listed as a reference; the old job, items, files, run and press results are byte-identical", async () => {
    // lineage / reference rows / "a reference is not a received file": shared-production-backbone "REORDER". Added here:
    // the old FILES, runs, press results and intake rows are compared byte for byte, and the price is shown not to be copied.
    const before = oldSide();
    const intakeBefore = oldIntake();
    const { job, items } = await release();
    expect(job.id).not.toBe("j0");
    expect(job.jobTicket).toMatch(/^GSO-\d{8}-\d{4}$/);
    expect(job.jobTicket).not.toBe(OLD);
    expect(items.map((row) => [row.itemTicket, row.quantity, row.reorderSourceItemId, row.reorderArtworkMode, row.unitPrice, row.unitCost])).toEqual([
      [`${job.jobTicket}-01`, 750, "o1", "same_artwork", 0, 0], [`${job.jobTicket}-02`, 300, "o2", "revision", 0, 0], // the earlier 1.25 / 1.40 is never copied
    ]);
    expect(items.map((row) => [row.qcResult ?? null, row.lastReprintAt ?? null])).toEqual([[null, null], [null, null]]); // its own history
    const refs = table("productionJobFile").filter((row) => row.jobId === job.id);
    expect(refs.map((row) => [row.assetSource, row.assetRole, row.fileName, row.productionJobItemId, row.reusedFromFileId])).toEqual([
      [REORDER_REUSE_SOURCE, "reference", `${OLD}-01__crud_HEATH_F_CMYK.pdf`, items[0].id, "of1"],
      [REORDER_REUSE_SOURCE, "reference", `${OLD}-02__crud_SHORTCAKES_F_CMYK.pdf`, items[1].id, "of2"],
    ]);
    expect(refs[0].notes).toContain("Reuse approved artwork");
    expect(table("productionRun").filter((row) => row.jobId === job.id)).toEqual([]); // no run is copied
    expect(oldSide()).toBe(before);
    expect(oldIntake()).toBe(intakeBefore);
    // released twice -> the same job
    expect((await release()).job.id).toBe(job.id);
    expect(oldSide()).toBe(before);
  }, 120_000);

  it("revision: the old file is REFERENCE ONLY on the new item — and that is a label (see E1 for what enforces it)", async () => {
    const { job, items } = await release();
    const ref = table("productionJobFile").find((row) => row.jobId === job.id && row.productionJobItemId === items[1].id);
    expect(ref).toMatchObject({ assetSource: REORDER_REUSE_SOURCE, assetRole: "reference" });
    expect(ref.notes).toContain("REFERENCE ONLY");
    expect(ref.notes).toContain("A new proof approval and a new production file are required.");
    const event = table("productionJobEvent").find((row) => row.jobId === job.id && row.eventType === "reorder_lineage_recorded" && /REVISION/.test(row.message));
    expect(event.message).toContain("New proof approval required");
    expect(job.proofStatus ?? "draft").toBe("draft"); // nothing is pre-approved
    // SOURCE PIN — where reorderArtworkMode is read: creation (the note + event above), the job page payload, the two
    // forms. Neither Print Intake nor the status action reads it or the proof state.
    for (const file of ["app/routes/api.print-intake.route-plan.tsx", "app/lib/print-intake-routing.server.ts", "app/lib/production-fulfillment.ts", "app/lib/production-qc-guard.ts"]) expect(src(file), file).not.toMatch(/reorderArtworkMode|proofStatus|proofApprovedAt/);
  }, 120_000);

  // FINDING E1 — "new proof required before printing" is a LABEL, nothing enforces it.
  //   app/lib/production-job-source.server.ts:1530 / :1541 write the words into a file note and an event; no other code
  //   reads reorderArtworkMode to block anything (grep: production.tsx:701 display, release-queue.tsx:136 / app.quotes.tsx:698 input).
  //   input: a revision reorder item, job proofStatus "draft" (no proof sent, none approved); a new file named with its item ticket is dropped
  //   expected: held for review ("proof approval required") until proofStatus is "approved"
  //   actual: decision "route" to the Mimaki; changeStatus "printing" is also accepted
  //   fix: in api.print-intake.route-plan.tsx, select items.reorderArtworkMode + job.proofStatus and return a review
  //        (canonical reason e.g. "revision_needs_proof_approval") when the item is a revision and proofStatus !== "approved"
  it.fails("E1: a file for a revision reorder item is held until the new proof is approved", async () => {
    const { job, items } = await release();
    const planned = await plan({ fileName: `${items[1].itemTicket} crud_SHORTCAKES_v2_F_CMYK.pdf`, fileHash: HASH("9"), subfolder: job.jobTicket });
    expect(planned.decision).toBe("review");
  }, 120_000);

  it("the new job's press results resolve to the NEW item; nothing is added to the old job", async () => {
    const before = oldSide();
    const { job, items } = await release();
    const planned = await plan({ fileName: `${items[0].itemTicket} crud_HEATH_F_CMYK_v2.pdf`, fileHash: HASH("9"), subfolder: job.jobTicket });
    expect(planned).toMatchObject({ decision: "route", jobId: job.id, itemId: items[0].id, ripName: `${items[0].itemTicket}__crud_HEATH_F_CMYK_v2` });
    for (const name of [planned.ripName, `${planned.ripName}.pdf`, `${planned.ripName}__P1-A1`]) {
      expect(await resolveRipIdentity(db, "shop-1", { jobName: name }), name).toMatchObject({ status: "matched", productionJobId: job.id, productionJobItemId: items[0].id, confidence: "exact_item_ticket" });
    }
    // the reference row on the new job carries the OLD routed name: a result under that name still belongs to the OLD item
    expect(await resolveRipIdentity(db, "shop-1", { jobName: `${OLD}-01__crud_HEATH_F_CMYK` })).toMatchObject({ productionJobId: "j0", productionJobItemId: "o1" });
    // per-run actuals of the new item start empty: the old press result is not in them
    const newEntries = table("printLogEntry").filter((row) => row.productionJobItemId === items[0].id);
    expect(actualsByRun([], newEntries)).toEqual([]);
    expect(oldSide()).toBe(before);
    // a file still carrying the OLD ticket, saved into the NEW job's folder, is held (never sent to either job by guess)
    const mismatch = await plan({ fileName: `${OLD}-01__crud_HEATH_F_CMYK_copy.pdf`, fileHash: HASH("6"), subfolder: job.jobTicket });
    expect(mismatch).toMatchObject({ decision: "review", machine: null });
    expect(mismatch.reasons.join(" ")).toMatch(/_and_folder_ticket_.*_disagree/);
    expect(oldSide()).toBe(before);
  }, 120_000);

  // DEFECT E2 — reusing the SAME file for a reorder takes the old job's intake record away.
  //   prisma/schema.prisma PrintIntake @@unique([shop, fileHashSha256]) + app/routes/api.print-intake.route-plan.tsx:287-289:
  //   the upsert's `update` overwrites matchedProductionJobId / authoritativeTicket / routedFilename / productionJobItemId.
  //   input: same-artwork reorder; staff copy the approved file from the archive (identical bytes -> identical hash)
  //          into the new job's folder, named with the new item ticket — exactly what the reuse note tells them to do
  //   expected: the old job's intake row is unchanged; the new job gets its own record
  //   actual: the ONE row is re-pointed at the new job / item. The old item has no routed layer on record any more
  //           (a later reprint of the old item re-routes nothing; its run identity is gone from the job page)
  //   fix: when existingIntake.matchedProductionJobId is another job, do not overwrite — hold for review
  //        ("file already routed for <old ticket>") or record the reuse on a second row (needs the unique key widened to include the job)
  it.fails("E2: routing the identical approved file for the reorder leaves the old job's intake row as it was", async () => {
    const before = oldIntake();
    const { job, items } = await release();
    const planned = await plan({ fileName: `${items[0].itemTicket} crud_HEATH_F_CMYK.pdf`, fileHash: HASH("7"), subfolder: job.jobTicket });
    expect(planned.decision).toBe("route");
    expect(oldIntake()).toBe(before);
  }, 120_000);

  // DEFECT E3 — a completed job still accepts files by a ticket in the FILE NAME.
  //   app/lib/print-intake-routing.server.ts:540-550 (item ticket) and :554-566 (job ticket) never check the job status;
  //   only the folder rule does (:576, INTAKE_CLOSED_JOB_STATUSES), and the manual Assign refuses a closed job too.
  //   input: old job status "completed", cost finalized; a new file named with its item ticket is dropped in the root
  //   expected: review, reason ticket_on_closed_job (use reopen / reprint)
  //   actual: routed to the press as revision 2 of the completed item
  //   fix: apply the same INTAKE_CLOSED_JOB_STATUSES check to the item-ticket and job-ticket hits before routeItem
  it("FIXED 2026-11-20 — E3: a new file named with a COMPLETED job's item ticket is held, like the folder rule and the manual Assign", async () => {
    const planned = await plan({ fileName: `${OLD}-01 crud_HEATH_F_CMYK.pdf`, fileHash: HASH("5") });
    expect(planned.decision).toBe("review");
  }, 120_000);
});

/* ====================================================================== */
/* F — PRODUCTION BOARD card                                                */
/* ====================================================================== */

describe("F · Production Board card — what the lead sees for a realistic multi-item job", () => {
  const CARD_KEYS = ["activeRunLabel", "assignedTo", "awaitingFiles", "customer", "dueDate", "filesLabel", "finish", "fulfillmentLabel", "holdReason", "id", "itemCount", "machine", "next", "nextTone", "overdue", "priority", "product", "qcLabel", "quantity", "reorder", "reprintLabel", "stage", "status", "statusLabel", "updatedAt"];
  const cardFor = async (role: Role, id = "j1") => {
    as(role);
    const board = await import("../app/routes/app.erp.production-board");
    const seen = await run(() => board.loader({ request: get("/app/erp/production-board") }));
    expect(seen.status).toBe(200);
    const all = [...seen.body.board.columns.flatMap((column: any) => column.cards), ...seen.body.board.attention.onHold, ...seen.body.board.attention.reprintNeeded, ...seen.body.board.cancelled];
    return { card: all.find((card: any) => card.id === id), body: seen.body };
  };
  const realistic = () => {
    // item 1: Mimaki, CMYK + Gloss, both layer files in, a reprint of 25 open; item 2: Roland, white, no file yet
    Object.assign(table("productionJobItem")[0], { lastReprintAt: new Date("2026-11-20T03:00:00Z"), lastReprintReason: "color_quality_issue", lastReprintBy: "Dana" });
    Object.assign(table("productionJobItem")[1], { machineSummary: ROLAND, selectedFinish: "White" });
    h.t.productionJobFile = ["CMYK", "g"].map((layer, index) => ({ id: `f${index}`, shop: "shop-1", jobId: "j1", productionJobItemId: "i1", fileType: "print_file", assetSource: "nas", fileName: `${JOB}-01__crud_HEATH_F_${layer}.pdf`, fileUrl: "\\\\NAS\\secret\\path.pdf", createdAt: T0 }));
    h.t.productionRun = [
      { id: "r1", shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 1, kind: "original", quantity: 500, status: "qc_failed", runLabel: "A1", createdAt: T0 },
      { id: "r2", shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, reasonCode: "color_quality_issue", chargeType: "internal", status: "open", runLabel: "P1-A1", createdAt: T0 },
    ];
  };

  it("in production: customer, items, quantity, due date, priority, assignment, printers, finish, file state, open run, QC — and no money", async () => {
    realistic();
    table("productionJob")[0].status = "printing";
    const { card, body } = await cardFor("print_operator");
    expect(card).toMatchObject({
      customer: "Krud Cafe", product: "HEATH pouch (+1 more)", itemCount: 2, quantity: 750, dueDate: "2026-12-05T12:00:00.000Z", overdue: false, priority: "rush", assignedTo: "Dana",
      machine: `${MIMAKI}, ${ROLAND}`, finish: "CMYK + Gloss, White", awaitingFiles: true, filesLabel: "Awaiting files for 1 of 2 items",
      activeRunLabel: "Run 2 · Reprint · 25 pcs", reprintLabel: "1 reprint(s) · 25 pcs", qcLabel: "QC needed after reprint", holdReason: "", fulfillmentLabel: "", status: "printing", statusLabel: "Printing", reorder: false,
    });
    // exactly these fields and nothing else: no price, cost, snapshot, file URL, ticket of a file or database id of an item
    expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(MONEY_TEXT);
    expect(text).not.toMatch(/unitPrice|unitCost|costSnapshot|priceSnapshot|runCosts|actualTotalCost|quotedTrueCost|secret/);
    // the owner's card is the same card (the board never carries money for anyone)
    expect((await cardFor("owner")).card).toEqual(card);
    expect(card).toEqual(toBoardCard({ ...card, ...(await loadJob("print_operator", "j1")).job }, new Date()));
  }, 120_000);

  it("on hold: the reason the staff wrote; packed: ready to ship / ready for pickup; QC passed on every item", async () => {
    realistic();
    const job = table("productionJob")[0];
    job.status = "on_hold";
    h.t.productionJobEvent = [
      { id: "ev1", shop: "shop-1", jobId: "j1", eventType: "note", message: "Waiting on white ink delivery", createdAt: new Date("2026-11-20T02:00:00Z"), createdBy: "Dana" },
      { id: "ev2", shop: "shop-1", jobId: "j1", eventType: "status_change", message: "Status changed from Printing to On Hold.", oldValue: "printing", newValue: "on_hold", createdAt: new Date("2026-11-20T02:01:00Z") },
    ];
    const held = (await cardFor("print_operator")).card;
    expect(held).toMatchObject({ status: "on_hold", statusLabel: "On Hold", holdReason: "Waiting on white ink delivery", quantity: 750, itemCount: 2 });

    // QC passed on both, reprint closed, packed
    const passedAt = new Date("2026-11-20T04:30:00Z");
    for (const item of table("productionJobItem").filter((row) => row.jobId === "j1")) Object.assign(item, { qcResult: "pass", qcBy: "Dana", qcAt: passedAt });
    table("productionRun")[1].status = "qc_passed";
    h.t.productionJobFile.push({ id: "f9", shop: "shop-1", jobId: "j1", productionJobItemId: "i2", fileType: "print_file", assetSource: "nas", fileName: `${JOB}-02__shortcakes_w.pdf`, fileUrl: "x", createdAt: T0 });
    Object.assign(job, { status: "packing", fulfillmentState: "ready_to_ship" });
    expect((await cardFor("print_operator")).card).toMatchObject({ qcLabel: "QC passed", fulfillmentLabel: "Ready to ship", awaitingFiles: false, filesLabel: "Files received", activeRunLabel: "", reprintLabel: "1 reprint(s) · 25 pcs", holdReason: "" });
    job.fulfillmentState = "pickup_ready";
    expect((await cardFor("bagger")).card).toMatchObject({ fulfillmentLabel: "Ready for pickup", status: "packing" });
  }, 120_000);

  // GAPS (reported — a card field that the floor needs and the card does not carry; no wrong value was found):
  //   1. app/lib/simple-production.ts:263-291 (BoardCard) / :330 (toBoardCard) has NO job ticket. The ticket is what staff name the
  //      Prints For Today folder with; on the board a job is identified by customer + first product only.
  //   2. `quantity` is the SUM across items (500 + 250 = 750 above) and `machine` / `finish` are joined lists:
  //      which item runs on which press, and each item's own quantity, are only on the job page.
  //   3. `product` names the first item only ("HEATH pouch (+1 more)").
  //   fix for 1: add `ticket: String(job.jobTicket || "")` in toBoardCard (identity only, no money).
  // OWNER RULE (2026-11-19): the job ticket is deliberately NOT on the board card — it is on the job page.
  // This was first reported as a gap (F1); it is the owner's decision, so the test pins the rule.
  it("F1: the board card does not carry the job ticket (owner rule); the ticket is on the job page", async () => {
    realistic();
    const { card } = await cardFor("print_operator");
    expect(JSON.stringify(card)).not.toContain(JOB);
  }, 120_000);
});
