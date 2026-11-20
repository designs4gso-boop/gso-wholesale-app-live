// 2026-11-20 — INTAKE / LINEAGE FIXES. Regression tests for the defects the production close-out
// (tests/james-production-closeout-2026-11-20.test.ts) reported and that were fixed the same day:
//   FIX 1  (B2)   two different staff files never share one routed name
//   FIX 2  (B4)   a long name never loses its run token / layer suffix
//   FIX 3  (D3)   corrected artwork saved while a reprint / remake is open belongs to the OPEN run
//   FIX 13        every file of a reprint / remake carries one run identity (CMYK + gloss stay paired)
//   FIX 4  (E2)   the identical file routed for a reorder never takes the old job's intake record
//   FIX 14 (E1)   a reorder with REVISED artwork is held until the job's proof is approved
//   FIX 15        a SAME-ARTWORK reorder is not held
//   FIX 5         Mimaki white is NOT approved — one rule on every path
//   FIX 17        Stock Bag checklist
//   FIX 20 / 21   Incoming Print Files cases; a finished job is never changed by a dropped file
//
// Every block drives REAL application code (the route-plan / report / status endpoints, the Incoming
// Print Files action, the reprint action, the central job service) against an in-memory database
// double. Nothing touches Prisma, the network, Shopify, the NAS or a press. All data is a test double.

import { readFileSync } from "node:fs";
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
import {
  DEFAULT_RUN, applyRunSuffix, decideIntakeMachine, decideMachine, decideMachineFromFilename, disambiguatedRoutedName, parseRunIdentity, revisionReorderProofHold,
  ripFileBaseName, staffFileKey, stripRunSuffix,
} from "../app/lib/print-intake-routing.server";
import { REVIEW_REASON_LABELS, canonicalReviewReason, intakeContentHash, intakeReuseKey, isIntakeReuseKey, validateIntakeAssignment } from "../app/lib/print-intake-review.server";
import { parseRipTickets, resolveRipIdentity } from "../app/lib/rip-identity-match.server";
import { actualsByRun, reprintNumberOfRipName } from "../app/lib/production-run";
import { FAMILY_CHECKLISTS, MANUAL_JOB_FAMILIES, REORDER_REUSE_SOURCE, STOCK_BAG_CHECKLIST_FAMILY, buildShopifyOrderJobPayload, checklistForManualFamily, createProductionJobFromSource, validateManualJobInput } from "../app/lib/production-job-source.server";
import { MACHINE_CAPABILITIES, ROUTING_REASONS, resolveCanonicalMachineRouting } from "../app/lib/machine-routing.server";
import { planDispatch } from "../app/lib/ops/production-dispatch.server";

/* ---------------- seed ---------------- */

const ENV: Record<string, string> = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" };
const TOKEN = "tok-lineage";
const JOB = "GSO-20261120-0007"; // two items
const SOLO = "GSO-20261120-0008"; // one item
const OLD = "GSO-20261101-0003"; // an earlier, completed job
const HASH = (char: string) => char.repeat(64);
const MIMAKI = "Mimaki UCJV300-130";
const ROLAND = "Roland LG-640";
const T0 = new Date("2026-11-19T10:00:00Z");
const CMYK = "crud_HEATH_F_CMYK.pdf";
const GLOSS = "crud_HEATH_F_g.pdf";

const jobRow = (id: string, jobTicket: string, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", active: true, status: "new", priority: "normal", jobTicket, customerName: "Sam", company: null, email: null, phone: null, assignedTo: null, dueDate: null,
  quoteId: `manual_seed-${id}`, quoteNumber: null, orderGid: null, proofApprovalToken: null, proofStatus: "draft", internalNotes: null, fulfillmentState: null, actualCostFinalized: false, completedAt: null,
  artworkUrl: null, printFileUrl: null, createdAt: T0, updatedAt: T0, ...over,
});
const itemRow = (id: string, jobId: string, itemTicket: string, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", jobId, itemTicket, ripJobName: itemTicket, suggestedFileName: null, productTitle: "HEATH pouch", quantity: 500, unitPrice: 0, unitCost: 0, selectedFinish: "CMYK", materialSummary: null,
  machineSummary: MIMAKI, costSnapshot: null, priceSnapshot: null, qcResult: null, qcBy: null, qcAt: null, qcNote: null, lastReprintAt: null, lastReprintReason: null, lastReprintBy: null,
  reorderSourceItemId: null, reorderArtworkMode: null, sortOrder: 1, createdAt: T0, updatedAt: T0, ...over,
});
const intakeRow = (id: string, originalFilename: string, hash: string, jobId: string | null, itemId: string | null, ticket: string | null, routedFilename: string | null, over: Record<string, any> = {}) => ({
  id, shop: "shop-1", originalFilename, originalSubfolder: null, fileHashSha256: hash, fileSize: 10, status: "routed", matchedProductionJobId: jobId, generatedProductionJobId: null, authoritativeTicket: ticket, productionJobItemId: itemId,
  printer: "mimaki", printMode: null, routingRule: "job_subfolder", routedFilename, attemptNumber: 1, revisionNumber: 1, reprintNumber: 0, reviewReason: null, rawParsedHints: null, createdAt: T0, updatedAt: T0, ...over,
});

function seed() {
  h.t = {}; h.seq = 0; h.clock = 0;
  h.t.printLogAutoImportSetting = [{ id: "set1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null, incomingFolder: "x" }];
  h.t.productionJob = [jobRow("j1", JOB, { company: "Krud Cafe" }), jobRow("j2", SOLO)];
  h.t.productionJobItem = [
    itemRow("i1", "j1", `${JOB}-01`, { selectedFinish: "CMYK + Gloss" }),
    itemRow("i2", "j1", `${JOB}-02`, { productTitle: "SHORTCAKES pouch", quantity: 250, sortOrder: 2 }),
    itemRow("s1", "j2", `${SOLO}-01`, { productTitle: "4x5 bag labels", quantity: 100, selectedFinish: "CMYK + Gloss" }),
  ];
  h.calls = []; h.writes = []; h.fetches = [];
}
/** an earlier, COMPLETED job with two items, their routed files and intake rows */
function seedOldJob() {
  h.t.productionJob.push(jobRow("j0", OLD, { company: "Krud Cafe", status: "completed", completedAt: new Date("2026-11-05T18:00:00Z"), proofStatus: "approved", actualCostFinalized: true }));
  h.t.productionJobItem.push(
    itemRow("o1", "j0", `${OLD}-01`, { qcResult: "pass" }),
    itemRow("o2", "j0", `${OLD}-02`, { productTitle: "SHORTCAKES pouch", quantity: 250, sortOrder: 2, qcResult: "pass" }),
  );
  const file = (id: string, itemId: string, fileName: string, hash: string) => ({ id, shop: "shop-1", jobId: "j0", productionJobItemId: itemId, fileType: "print_file", assetSource: "nas", assetRole: "printFile", fileName, originalFileName: fileName.split("__")[1], sourceRef: hash, fileUrl: `gso:nas-print-file/${hash}`, matchedBy: "print_intake", jobTicket: OLD, notes: "Sent to Mimaki.", createdAt: T0 });
  h.t.productionJobFile = [file("of1", "o1", `${OLD}-01__crud_HEATH_F_CMYK.pdf`, HASH("7")), file("of2", "o2", `${OLD}-02__crud_SHORTCAKES_F_CMYK.pdf`, HASH("8"))];
  h.t.printIntake = [
    intakeRow("op1", CMYK, HASH("7"), "j0", "o1", `${OLD}-01`, `${OLD}-01__crud_HEATH_F_CMYK`),
    intakeRow("op2", "crud_SHORTCAKES_F_CMYK.pdf", HASH("8"), "j0", "o2", `${OLD}-02`, `${OLD}-02__crud_SHORTCAKES_F_CMYK`),
  ];
}

beforeEach(() => {
  seed(); h.shop = "shop-1"; h.sub = "1";
  Object.assign(process.env, ENV);
  for (const key of ["GSO_OWNER_ENFORCEMENT", "GSO_MANAGER_AUTHORIZED_USER_IDS", "SLACK_WEBHOOK_URL", "PRODUCTION_SLACK_WEBHOOK_URL"]) delete process.env[key];
  vi.stubGlobal("fetch", async (url: any) => { h.fetches.push(String(url)); throw new Error("network is not available in this test"); });
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; vi.unstubAllGlobals(); });

/* ---------------- helpers ---------------- */

const table = (name: string) => h.t[name] || [];
const rowOf = (key: string) => table("printIntake").find((row) => row.fileHashSha256 === key);
const snapshot = (rows: any[]) => JSON.stringify(rows);
const form = (fields: Record<string, string>) => new Request("https://erp.test/x", { method: "POST", body: new URLSearchParams(fields) });
const bodyOf = async (out: any) => { if (!(out instanceof Response)) return out; const text = await out.clone().text(); try { return JSON.parse(text); } catch { return text; } };
const callAction = async (mod: any, request: Request) => { try { return await mod.action({ request, params: {} }); } catch (thrown) { if (thrown instanceof Response) return thrown; throw thrown; } };
const api = async (route: "route-plan" | "report" | "status", fields: Record<string, any>) => {
  const mod: any = route === "route-plan" ? await import("../app/routes/api.print-intake.route-plan") : route === "report" ? await import("../app/routes/api.print-intake.report") : await import("../app/routes/api.print-intake.status");
  const response: Response = await mod.action({ request: new Request(`https://erp.test/api/print-intake/${route}`, { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return (await response.json()) as any;
};
const plan = async (fields: Record<string, any>) => (await api("route-plan", { fileSize: 10, ...fields })).plan;
/** what the watcher sends after it copied the file to the hot folder */
const reportRouted = (planned: any, fileName: string, hash: string) => api("report", { fileName, decision: "routed", rule: planned.rule, jobId: planned.jobId, jobTicket: planned.jobTicket, itemTicket: planned.itemTicket, ripName: planned.ripName, machine: planned.machine, fileHash8: hash.slice(0, 8), fileHash: hash });
const jobAction = async (fields: Record<string, string>) => { const mod = await import("../app/routes/app.erp.production-job.$id"); const out = await callAction(mod, form(fields)); return { status: out instanceof Response ? out.status : 200, body: await bodyOf(out) }; };
const intakeAction = async (fields: Record<string, string>) => bodyOf(await callAction(await import("../app/routes/app.erp.print-intake"), form(fields)));
const reprint = (itemId: string, jobId: string, over: Record<string, string> = {}) => jobAction({ intent: "reprintItem", jobId, itemId, reprintReason: "color_quality_issue", reprintQty: "10", runKind: "reprint", chargeType: "internal", ...over });
const runsOf = (itemId: string) => table("productionRun").filter((row) => row.itemId === itemId).sort((a, b) => a.runNumber - b.runNumber);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const SAFE = /^[A-Za-z0-9._-]+$/;
const inSolo = (fileName: string, hash: string, more: Record<string, any> = {}) => plan({ fileName, fileHash: hash, subfolder: SOLO, ...more });

/* ====================================================================== */
/* FIX 1 — two different staff files never share a routed name             */
/* ====================================================================== */

describe("FIX 1 · routed name collisions (spaces, punctuation, non-ASCII, a typed ticket)", () => {
  const PAIRS: Array<[string, string, string]> = [
    ["space vs underscore", "HEATH F.pdf", "HEATH_F.pdf"],
    ["underscore vs double underscore", "HEATH_F.pdf", "HEATH__F.pdf"],
    ["en dash vs em dash", "HEATH–F.pdf", "HEATH—F.pdf"],
    ["parentheses", "art (1).pdf", "art_1.pdf"],
    ["punctuation", "art, final!.pdf", "art_final.pdf"],
    ["accent vs none", "café.pdf", "caf.pdf"],
    ["no ASCII letters at all", "日本語.pdf", "한국어.pdf"],
    ["letter case of the extension only is the same file — see below; a different extension is another file", "label.pdf", "label.tif"],
    ["a layer file: the mark goes in FRONT of the layer suffix", "HEATH F_CMYK.pdf", "HEATH_F_CMYK.pdf"],
  ];

  it.each(PAIRS)("%s: %s then %s — both route, different names, each revision 1, both resolve to the item", async (_label, first, second) => {
    const a = await inSolo(first, HASH("a"));
    const b = await inSolo(second, HASH("b"));
    expect([a.decision, b.decision], JSON.stringify([a.reasons, b.reasons])).toEqual(["route", "route"]);
    expect(a.ripName).not.toBe(b.ripName);
    expect(a.ripName.toLowerCase()).not.toBe(b.ripName.toLowerCase()); // a Windows hot folder ignores letter case
    expect(a.ripName).toBe(ripFileBaseName({ itemTicket: `${SOLO}-01`, ripJobName: `${SOLO}-01`, suggestedFileName: null }, first)); // the FIRST file keeps the plain name: no mark without a collision
    for (const name of [a.ripName, b.ripName]) {
      expect(name.startsWith(`${SOLO}-01`), name).toBe(true); // item ticket first
      expect(name, name).toMatch(SAFE); // Windows-safe
      expect(name.length).toBeLessThanOrEqual(120);
      expect(parseRunIdentity(name)).toEqual(DEFAULT_RUN); // the mark is never read as a run
      expect(parseRipTickets(`${name}.pdf`)).toMatchObject({ itemTicket: `${SOLO}-01`, jobTicket: SOLO });
      expect((await resolveRipIdentity(db, "shop-1", { jobName: name })).productionJobItemId).toBe("s1");
    }
    expect(b.ripName).toMatch(/-x[0-9a-f]{6}(?:_CMYK)?$/);
    expect(table("printIntake").map((row) => [row.revisionNumber, row.reprintNumber, row.productionJobItemId])).toEqual([[1, 0, "s1"], [1, 0, "s1"]]);
  }, 120_000);

  it("the layer suffix stays at the END of a marked name, and the extension is the agent's (not part of the routed name)", async () => {
    await inSolo("HEATH F_g.pdf", HASH("a"));
    const second = await inSolo("HEATH_F_g.pdf", HASH("b"));
    expect(second.ripName).toMatch(new RegExp(`^${SOLO}-01__HEATH_F-x[0-9a-f]{6}_g$`));
    expect(second.machine).toBe("mimaki");
  }, 120_000);

  it("deterministic: the same two files in a fresh database get the same two names", async () => {
    const once = [(await inSolo("art (1).pdf", HASH("a"))).ripName, (await inSolo("art_1.pdf", HASH("b"))).ripName];
    seed();
    const again = [(await inSolo("art (1).pdf", HASH("a"))).ripName, (await inSolo("art_1.pdf", HASH("b"))).ripName];
    expect(again).toEqual(once);
    expect(disambiguatedRoutedName(`${SOLO}-01__art_1`, "art_1.pdf")).toBe(once[1]);
  }, 120_000);

  it("retry-safe: the same source (same hash) asked again gets the same name and writes no new row — marked or not", async () => {
    const a = await inSolo("HEATH F.pdf", HASH("a"));
    const b = await inSolo("HEATH_F.pdf", HASH("b"));
    const before = snapshot(table("printIntake").map((row) => [row.id, row.routedFilename, row.revisionNumber, row.reprintNumber, row.attemptNumber, row.status]));
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await inSolo("HEATH F.pdf", HASH("a"))).ripName).toBe(a.ripName);
      expect((await inSolo("HEATH_F.pdf", HASH("b"))).ripName).toBe(b.ripName);
    }
    expect(snapshot(table("printIntake").map((row) => [row.id, row.routedFilename, row.revisionNumber, row.reprintNumber, row.attemptNumber, row.status]))).toBe(before);
    expect(table("printIntake")).toHaveLength(2);
  }, 120_000);

  it("the SAME staff name saved again is a true revision (R2), not a marked name — also with a ticket typed in front or other letter case", async () => {
    expect((await inSolo(CMYK, HASH("a"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK`);
    expect((await inSolo(CMYK, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-A1`);
    expect((await inSolo(`${SOLO}-01 ${CMYK}`, HASH("c"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R3-A1`); // what the Revision button tells staff to do
    expect((await inSolo("CRUD_heath_f_cmyk.PDF", HASH("d"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R4-A1`);
    expect(table("printIntake").map((row) => row.revisionNumber)).toEqual([1, 2, 3, 4]);
    expect(staffFileKey(`${SOLO}-01 ${CMYK}`)).toBe(staffFileKey(CMYK));
    expect(staffFileKey("HEATH F.pdf")).not.toBe(staffFileKey("HEATH_F.pdf"));
  }, 120_000);

  it("a revision of a MARKED file keeps its marked base; three colliding files get three names", async () => {
    const first = await inSolo("art (1).pdf", HASH("a"));
    const second = await inSolo("art_1.pdf", HASH("b"));
    const third = await inSolo("art[1].pdf", HASH("c"));
    expect(new Set([first.ripName, second.ripName, third.ripName]).size).toBe(3);
    const revised = await inSolo("art_1.pdf", HASH("d"));
    expect(revised.ripName).toBe(`${second.ripName}__R2-A1`);
    expect(stripRunSuffix(revised.ripName)).toBe(second.ripName);
  }, 120_000);

  it("a file linked by a PERSON (Assign) follows the same rule", async () => {
    await inSolo("HEATH F.pdf", HASH("a"));
    const held = await plan({ fileName: "HEATH_F.pdf", fileHash: HASH("b") }); // no folder, no ticket: waits for a person
    expect(held.decision).toBe("review");
    expect((await intakeAction({ intent: "assign", intakeId: rowOf(HASH("b")).id, target: "j2" })).ok).toBe(true);
    const routed = await plan({ fileName: "HEATH_F.pdf", fileHash: HASH("b") });
    expect(routed).toMatchObject({ decision: "route", rule: "assigned_by_owner", itemId: "s1" });
    expect(routed.ripName).toMatch(new RegExp(`^${SOLO}-01__HEATH_F-x[0-9a-f]{6}$`));
    expect(rowOf(HASH("b"))).toMatchObject({ status: "routed", routedFilename: routed.ripName, revisionNumber: 1, productionJobItemId: "s1" });
  }, 120_000);

  it("a custom RIP name on the item: the second, different file no longer collides on the bare name", async () => {
    table("productionJobItem").find((row) => row.id === "s1").ripJobName = "KRUD_CUSTOM_JOB";
    const a = await inSolo(CMYK, HASH("a"));
    const b = await inSolo(GLOSS, HASH("b"));
    expect(a.ripName).toBe("KRUD_CUSTOM_JOB"); // historical bare name, unchanged
    expect(b.ripName).toMatch(/^KRUD_CUSTOM_JOB__crud_HEATH_F-x[0-9a-f]{6}_g$/);
  }, 120_000);
});

/* ====================================================================== */
/* FIX 2 — long names keep ticket, layer suffix and run token              */
/* ====================================================================== */

describe("FIX 2 · long names: only the readable middle is cut", () => {
  const TICKET = `${SOLO}-01`;
  const ITEM = { itemTicket: TICKET, ripJobName: TICKET, suggestedFileName: null };
  const LONG = "KRUD_CAFE_HEATH_BAR_LIMITED_EDITION_".repeat(6); // 216 characters
  const RUNS: Array<[string, { revision?: number; reprint?: number; attempt?: number }, string]> = [
    ["revision", { revision: 2 }, "__R2-A1"], ["reprint", { reprint: 1 }, "__P1-A1"], ["remake (second extra run)", { reprint: 2 }, "__P2-A1"],
    ["revision + reprint + retry", { revision: 12, reprint: 12, attempt: 12 }, "__R12-P12-A12"],
  ];

  it.each([["CMYK", "_CMYK"], ["gloss", "_g"], ["white", "_w"]])("long original, %s layer: ticket first, layer suffix kept, every run token intact, within 120", (_layer, suffix) => {
    const routed = ripFileBaseName(ITEM, `${LONG}F${suffix}.pdf`);
    expect(routed.startsWith(`${TICKET}__KRUD_CAFE`)).toBe(true);
    expect(routed.endsWith(suffix)).toBe(true);
    for (const [label, run, token] of RUNS) {
      const named = applyRunSuffix(routed, run);
      expect(named.length, label).toBeLessThanOrEqual(120);
      expect(named.endsWith(`${suffix}${token}`), `${label}: ${named}`).toBe(true);
      expect(named.startsWith(`${TICKET}__`), label).toBe(true);
      expect(parseRunIdentity(named), label).toEqual({ revision: run.revision ?? 1, reprint: run.reprint ?? 0, attempt: run.attempt ?? 1 });
      expect(reprintNumberOfRipName(`${named}.pdf`), label).toBe(run.reprint ?? 0);
      expect(parseRipTickets(`${named}.pdf`).itemTicket, label).toBe(TICKET);
    }
  });

  it.each([[118, ""], [120, ""], [160, ""], [118, "_CMYK"], [150, "_g"], [150, "_w"]])("long CUSTOM RIP name (%i characters%s): the run token is never cut; a layer suffix survives the cut", (length, suffix) => {
    const custom = `${TICKET}_${"X".repeat(length - TICKET.length - 1 - suffix.length)}${suffix}`;
    const routed = ripFileBaseName({ itemTicket: TICKET, ripJobName: custom, suggestedFileName: null }, "art.pdf");
    for (const [label, run, token] of RUNS) {
      const named = applyRunSuffix(routed, run);
      expect(named.length, label).toBeLessThanOrEqual(120);
      expect(named.endsWith(`${suffix}${token}`), `${label}: ${named}`).toBe(true);
      expect(named.startsWith(TICKET), label).toBe(true);
      expect(reprintNumberOfRipName(named), label).toBe(run.reprint ?? 0);
    }
  });

  it("a short name is not touched, and a marked long name keeps its mark", () => {
    expect(applyRunSuffix(`${TICKET}__crud_HEATH_F_CMYK`, { reprint: 1 })).toBe(`${TICKET}__crud_HEATH_F_CMYK__P1-A1`);
    expect(applyRunSuffix(`${TICKET}__crud_HEATH_F_CMYK__P1-A1`, { reprint: 2 })).toBe(`${TICKET}__crud_HEATH_F_CMYK__P2-A1`); // replaces, never stacks
    const marked = disambiguatedRoutedName(ripFileBaseName(ITEM, `${LONG}F_CMYK.pdf`), `${LONG}F_CMYK.pdf`);
    expect(marked.length).toBeLessThanOrEqual(TICKET.length + 2 + 80);
    expect(marked).toMatch(/-x[0-9a-f]{6}_CMYK$/);
    expect(applyRunSuffix(marked, { revision: 12, reprint: 12, attempt: 12 })).toMatch(/-x[0-9a-f]{6}_CMYK__R12-P12-A12$/);
  });

  it("through the real routes: a long staff name on a reprint and a remake", async () => {
    const longName = `${LONG}F_CMYK.pdf`;
    const first = await inSolo(longName, HASH("a"));
    expect(first.decision).toBe("route");
    h.sub = "4"; // production lead
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    const again = await inSolo(longName, HASH("a"));
    expect(again.ripName).toBe(`${first.ripName}__P1-A1`);
    expect(again.ripName.length).toBeLessThanOrEqual(120);
    const corrected = await inSolo(longName, HASH("b"));
    expect(corrected.ripName).toBe(`${first.ripName}__R2-P1-A1`);
  }, 120_000);
});

/* ====================================================================== */
/* FIX 3 + FIX 13 — the open run owns every file routed while it is open    */
/* ====================================================================== */

describe("FIX 3 / FIX 13 · reprint and remake: one run identity for every file, corrected artwork included", () => {
  beforeEach(() => {
    h.sub = "4"; // production lead
    h.t.printIntake = [
      intakeRow("pa", CMYK, HASH("a"), "j2", "s1", `${SOLO}-01`, `${SOLO}-01__crud_HEATH_F_CMYK`),
      intakeRow("pb", GLOSS, HASH("b"), "j2", "s1", `${SOLO}-01`, `${SOLO}-01__crud_HEATH_F_g`, { updatedAt: new Date(T0.getTime() + 60_000) }),
    ];
  });
  const names = () => table("printIntake").map((row) => row.routedFilename);

  it("corrected artwork saved BEFORE the agent re-routed the old layer: R2 of the OPEN reprint, on the same item", async () => {
    expect((await reprint("s1", "j2", { reprintReason: "artwork_prepress_error" })).body.ok).toBe(true);
    const corrected = await inSolo(CMYK, HASH("c"));
    expect(corrected).toMatchObject({ decision: "route", itemId: "s1", jobId: "j2", machine: "mimaki", ripName: `${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1` });
    expect(rowOf(HASH("c"))).toMatchObject({ productionJobItemId: "s1", matchedProductionJobId: "j2", revisionNumber: 2, reprintNumber: 1, attemptNumber: 1 });
  }, 120_000);

  it("corrected artwork saved AFTER the old layer was re-routed: the same answer", async () => {
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    expect((await inSolo(CMYK, HASH("a"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__P1-A1`);
    expect((await inSolo(GLOSS, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_g__P1-A1`);
    expect((await inSolo(CMYK, HASH("c"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`);
    // a REPLACEMENT saved under a new name while the run is open also belongs to that run
    expect((await inSolo("crud_HEATH_F_CMYK_fixed.pdf", HASH("d"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK_fixed__P1-A1`);
  }, 120_000);

  it("the original run's records are not rewritten by the corrected file, and results attribute by name: original / reprint / remake", async () => {
    const original = names();
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    const afterReprintAction = snapshot(table("printIntake").filter((row) => ["pa", "pb"].includes(row.id)));
    const corrected = await inSolo(CMYK, HASH("c"));
    expect(snapshot(table("printIntake").filter((row) => ["pa", "pb"].includes(row.id)))).toBe(afterReprintAction); // the corrected file is its OWN row
    const gloss = await inSolo(GLOSS, HASH("b"));
    expect(gloss.ripName).toBe(`${SOLO}-01__crud_HEATH_F_g__P1-A1`);
    // remake after QC
    expect((await jobAction({ intent: "qcItem", jobId: "j2", itemId: "s1", qcResult: "reprint_required" })).body.ok).toBe(true);
    expect((await reprint("s1", "j2", { runKind: "remake", reprintReason: "material_defect", reprintQty: "5", chargeType: "warranty" })).body.ok).toBe(true);
    const remakeCmyk = await inSolo(CMYK, HASH("c"));
    const remakeGloss = await inSolo(GLOSS, HASH("b"));
    expect([remakeCmyk.ripName, remakeGloss.ripName]).toEqual([`${SOLO}-01__crud_HEATH_F_CMYK__R2-P2-A1`, `${SOLO}-01__crud_HEATH_F_g__P2-A1`]);
    // an updated file DURING the remake
    const updated = await inSolo(CMYK, HASH("e"));
    expect(updated.ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R3-P2-A1`);
    expect(runsOf("s1").map((row) => [row.runNumber, row.kind, row.runLabel])).toEqual([[1, "original", "A1"], [2, "reprint", "P1-A1"], [3, "remake", "P2-A1"]]);

    const entry = (sourceJobName: string, inkMl: number) => ({ sourceJobName, inkMl, printMinutes: inkMl * 2, sqft: 0 });
    const actuals = actualsByRun(runsOf("s1"), [
      entry(original[0], 12), entry(original[1], 20), // run 1: CMYK + gloss
      entry(corrected.ripName, 2), entry(gloss.ripName, 3), // run 2: corrected CMYK + gloss
      entry(remakeCmyk.ripName, 1), entry(remakeGloss.ripName, 1.5), entry(updated.ripName, 1), // run 3
    ]);
    expect(actuals.map((row) => [row.runNumber, row.kind, row.entries, row.inkMl])).toEqual([[1, "original", 2, 32], [2, "reprint", 2, 5], [3, "remake", 3, 3.5]]);
    // every name ever issued is unique, safe and resolves to the item
    const issued = [...original, corrected.ripName, gloss.ripName, remakeCmyk.ripName, remakeGloss.ripName, updated.ripName];
    expect(new Set(issued).size).toBe(issued.length);
    for (const name of issued) { expect(name).toMatch(SAFE); expect((await resolveRipIdentity(db, "shop-1", { jobName: name })).productionJobItemId).toBe("s1"); }
    expect(table("productionJob")).toHaveLength(2); // never a new job
  }, 120_000);

  it("CMYK + gloss stay one pair through route, retry, a FAILED delivery, reprint and remake — same run, same press", async () => {
    // retry of the pair: same names, nothing written
    const before = snapshot(table("printIntake"));
    expect((await inSolo(CMYK, HASH("a"), { folderFiles: [CMYK, GLOSS] })).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK`);
    expect((await inSolo(GLOSS, HASH("b"), { folderFiles: [CMYK, GLOSS] })).ripName).toBe(`${SOLO}-01__crud_HEATH_F_g`);
    expect(JSON.parse(snapshot(table("printIntake"))).map((row: any) => [row.routedFilename, row.printer, row.reprintNumber])).toEqual(JSON.parse(before).map((row: any) => [row.routedFilename, row.printer, row.reprintNumber]));

    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    expect(table("printIntake").map((row) => [row.routedFilename, row.reprintNumber, row.status])).toEqual([
      [`${SOLO}-01__crud_HEATH_F_CMYK__P1-A1`, 1, "retry_allowed"], [`${SOLO}-01__crud_HEATH_F_g__P1-A1`, 1, "retry_allowed"],
    ]);
    const cmyk = await inSolo(CMYK, HASH("a"));
    const gloss = await inSolo(GLOSS, HASH("b"));
    expect([cmyk.machine, gloss.machine, cmyk.itemId, gloss.itemId]).toEqual(["mimaki", "mimaki", "s1", "s1"]);
    expect([reprintNumberOfRipName(cmyk.ripName), reprintNumberOfRipName(gloss.ripName)]).toEqual([1, 1]);
    // the watcher reports both delivered: one ProductionJobFile per layer, on the item
    expect((await reportRouted(cmyk, CMYK, HASH("a"))).ok).toBe(true);
    expect((await reportRouted(gloss, GLOSS, HASH("b"))).ok).toBe(true);
    expect(table("productionJobFile").map((row) => [row.fileName, row.productionJobItemId, row.sourceRef])).toEqual([
      [`${SOLO}-01__crud_HEATH_F_CMYK__P1-A1.pdf`, "s1", HASH("a")], [`${SOLO}-01__crud_HEATH_F_g__P1-A1.pdf`, "s1", HASH("b")],
    ]);
    // remake: both layers move to P2 together
    expect((await jobAction({ intent: "qcItem", jobId: "j2", itemId: "s1", qcResult: "reprint_required" })).body.ok).toBe(true);
    expect((await reprint("s1", "j2", { runKind: "remake", reprintReason: "material_defect", chargeType: "warranty" })).body.ok).toBe(true);
    expect((await inSolo(CMYK, HASH("a"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__P2-A1`);
    expect((await inSolo(GLOSS, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_g__P2-A1`);
    expect(table("printIntake").map((row) => [row.reprintNumber, row.printer, row.productionJobItemId, row.status])).toEqual([[2, "mimaki", "s1", "routed"], [2, "mimaki", "s1", "routed"]]);
    expect(table("printIntake")).toHaveLength(2);
  }, 120_000);
});

/* ====================================================================== */
/* FIX 4 — the identical file for a reorder: the old job keeps its record   */
/* ====================================================================== */

describe("FIX 4 / FIX 14 / FIX 15 · reorder: same artwork vs revision", () => {
  beforeEach(seedOldJob);
  const oldSide = () => snapshot([
    table("productionJob").filter((row) => row.id === "j0"), table("productionJobItem").filter((row) => row.jobId === "j0"), table("productionJobFile").filter((row) => row.jobId === "j0"),
    table("productionRun").filter((row) => row.jobId === "j0"), table("productionJobEvent").filter((row) => row.jobId === "j0"), table("printIntake").filter((row) => ["op1", "op2"].includes(row.id)),
  ]);
  const release = async () => {
    const result = await createProductionJobFromSource(db, {
      shop: "shop-1", actor: "owner@gso.test",
      source: { type: "released_transaction", authorizedBy: "owner@gso.test", transactionId: "reorder-release-lineage-1", origin: "agent_proposal", payload: { customerName: "Krud Cafe", items: [
        { productTitle: "HEATH pouch", quantity: 750, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "o1", reorderArtworkMode: "same_artwork" },
        { productTitle: "SHORTCAKES pouch", quantity: 300, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "o2", reorderArtworkMode: "revision" },
      ] } },
    } as any);
    const items = table("productionJobItem").filter((row) => row.jobId === result.job.id).sort((a, b) => a.sortOrder - b.sortOrder);
    return { job: result.job, items };
  };

  it("SAME ARTWORK, identical bytes: routes for the new item at once (no proof needed), new job / item / record; the old job is byte-identical", async () => {
    const before = oldSide();
    const { job, items } = await release();
    expect(job.proofStatus ?? "draft").toBe("draft"); // no proof was approved on the new job — and none is required for same artwork
    const fileName = `${items[0].itemTicket} ${CMYK}`;
    const planned = await plan({ fileName, fileHash: HASH("7"), subfolder: job.jobTicket });
    expect(planned).toMatchObject({ decision: "route", jobId: job.id, itemId: items[0].id, itemTicket: items[0].itemTicket, machine: "mimaki", ripName: `${items[0].itemTicket}__crud_HEATH_F_CMYK` });
    expect(oldSide()).toBe(before);

    // the new item's own record: a second row for the same content, linked back to the first
    const reuseKey = intakeReuseKey(HASH("7"), items[0].id);
    const mine = rowOf(reuseKey);
    expect(mine).toMatchObject({ matchedProductionJobId: job.id, productionJobItemId: items[0].id, authoritativeTicket: items[0].itemTicket, status: "routed", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, originalFilename: fileName });
    expect([isIntakeReuseKey(reuseKey), intakeContentHash(reuseKey), isIntakeReuseKey(HASH("7"))]).toEqual([true, HASH("7"), false]);
    expect(JSON.parse(mine.rawParsedHints)).toMatchObject({ contentHashSha256: HASH("7"), reuseOf: { printIntakeId: "op1", productionJobId: "j0", ticket: `${OLD}-01`, routedFilename: `${OLD}-01__crud_HEATH_F_CMYK` } });
    expect(table("printIntake").filter((row) => intakeContentHash(row.fileHashSha256) === HASH("7"))).toHaveLength(2);

    // the watcher's report: the routed print file is recorded on the NEW job; the old job's file row is not touched
    expect(await reportRouted(planned, fileName, HASH("7"))).toMatchObject({ ok: true, recorded: true, printFile: "created" });
    const newFiles = table("productionJobFile").filter((row) => row.jobId === job.id && row.assetSource === "nas");
    expect(newFiles.map((row) => [row.fileName, row.productionJobItemId, row.sourceRef, row.fileType])).toEqual([[`${items[0].itemTicket}__crud_HEATH_F_CMYK.pdf`, items[0].id, HASH("7"), "print_file"]]);
    // the reuse relationship written at release is still there, beside the routed file
    expect(table("productionJobFile").filter((row) => row.jobId === job.id && row.assetSource === REORDER_REUSE_SOURCE && row.productionJobItemId === items[0].id).map((row) => row.reusedFromFileId)).toEqual(["of1"]);
    expect(table("productionJobEvent").filter((row) => row.jobId === job.id && row.eventType === "print_file_routed")).toHaveLength(1);
    expect(oldSide()).toBe(before);

    // replayed plan and replayed report: same name, nothing new
    const facts = () => snapshot(table("printIntake").map(({ updatedAt: _stamp, ...row }) => row));
    const rowsBefore = facts();
    expect((await plan({ fileName, fileHash: HASH("7"), subfolder: job.jobTicket })).ripName).toBe(planned.ripName);
    expect(await reportRouted(planned, fileName, HASH("7"))).toMatchObject({ ok: true, printFile: "unchanged" });
    expect(facts()).toBe(rowsBefore);
    expect(oldSide()).toBe(before); // the old job's rows: not even a timestamp
    expect(table("productionJobFile").filter((row) => row.jobId === job.id && row.assetSource === "nas")).toHaveLength(1);

    // press results: each name belongs to its own job
    expect(await resolveRipIdentity(db, "shop-1", { jobName: planned.ripName })).toMatchObject({ productionJobId: job.id, productionJobItemId: items[0].id });
    expect(await resolveRipIdentity(db, "shop-1", { jobName: `${OLD}-01__crud_HEATH_F_CMYK` })).toMatchObject({ productionJobId: "j0", productionJobItemId: "o1" });
  }, 120_000);

  it("a reprint of the NEW item re-routes the new item's record only (new run history); the old job stays as it was", async () => {
    const before = oldSide();
    const { job, items } = await release();
    const fileName = `${items[0].itemTicket} ${CMYK}`;
    await plan({ fileName, fileHash: HASH("7"), subfolder: job.jobTicket });
    h.sub = "4";
    expect((await reprint(items[0].id, job.id)).body.ok).toBe(true);
    const reuseKey = intakeReuseKey(HASH("7"), items[0].id);
    expect(rowOf(reuseKey)).toMatchObject({ status: "retry_allowed", reprintNumber: 1, routedFilename: `${items[0].itemTicket}__crud_HEATH_F_CMYK__P1-A1` });
    expect(oldSide()).toBe(before);
    // the file comes back from the archive under its ORIGINAL name, in no job folder: the pending record decides
    const again = await plan({ fileName: CMYK, fileHash: HASH("7") });
    expect(again).toMatchObject({ decision: "route", rule: "assigned_by_owner", jobId: job.id, itemId: items[0].id, ripName: `${items[0].itemTicket}__crud_HEATH_F_CMYK__P1-A1` });
    expect(runsOf(items[0].id).map((row) => [row.runNumber, row.kind])).toEqual([[1, "original"], [2, "reprint"]]);
    expect(runsOf("o1")).toEqual([]);
    expect(oldSide()).toBe(before);
  }, 120_000);

  it("WATCHER CONTRACT: the status endpoint still answers for the plain hash from the first job's record; a pending reuse row is listed under the file's sha256", async () => {
    const { job, items } = await release();
    await plan({ fileName: `${items[0].itemTicket} ${CMYK}`, fileHash: HASH("7"), subfolder: job.jobTicket });
    const status = await api("status", { hash: HASH("7"), fileName: CMYK });
    expect(status.results).toEqual([{ hash: HASH("7"), status: "routed", disposition: "already_routed", retryAllowed: false, reasonCode: null, productionJobId: "j0", authoritativeTicket: `${OLD}-01` }]);
    expect((await api("status", { pending: true })).pending).toEqual([]);
    h.sub = "4";
    expect((await reprint(items[0].id, job.id)).body.ok).toBe(true);
    // KNOWN LIMIT (reported; app/routes/api.print-intake.status.tsx is not part of this change): the pending list returns
    // the row key. Watcher v1.11 only uses pending entries whose hash is in its ledger, so this entry is ignored by it
    // (harmless) until status.tsx returns the first 64 characters. The plain-hash contract is unchanged.
    // FIXED 2026-11-20 (status.tsx): the pending list now returns the file's own sha256 (first 64 characters of the row key),
    // so the watcher re-delivers a reprint of a reused file.
    expect((await api("status", { pending: true })).pending).toEqual([{ hash: HASH("7"), fileName: `${items[0].itemTicket} ${CMYK}`, status: "retry_allowed" }]);
  }, 120_000);

  it("a reprint of the OLD item later still finds the old record (it was never moved)", async () => {
    const { job, items } = await release();
    await plan({ fileName: `${items[0].itemTicket} ${CMYK}`, fileHash: HASH("7"), subfolder: job.jobTicket });
    expect(rowOf(HASH("7"))).toMatchObject({ id: "op1", matchedProductionJobId: "j0", productionJobItemId: "o1", routedFilename: `${OLD}-01__crud_HEATH_F_CMYK` });
  }, 120_000);

  it("the same file for a SECOND item of the same job is also its own record (an item's record is not re-pointed either)", async () => {
    h.t.printIntake = [];
    const first = await plan({ fileName: `${JOB}-01 shared_art_CMYK.pdf`, fileHash: HASH("a"), subfolder: JOB });
    const second = await plan({ fileName: `${JOB}-02 shared_art_CMYK.pdf`, fileHash: HASH("a"), subfolder: JOB });
    expect([first.itemId, second.itemId, first.ripName, second.ripName]).toEqual(["i1", "i2", `${JOB}-01__shared_art_CMYK`, `${JOB}-02__shared_art_CMYK`]);
    expect(table("printIntake").map((row) => [row.fileHashSha256, row.productionJobItemId, row.authoritativeTicket])).toEqual([[HASH("a"), "i1", `${JOB}-01`], [intakeReuseKey(HASH("a"), "i2"), "i2", `${JOB}-02`]]);
  }, 120_000);

  it("a file that only WAITED in review (never linked to a job) keeps its one record when it is finally matched", async () => {
    h.t.printIntake = [];
    expect((await plan({ fileName: "mystery_CMYK.pdf", fileHash: HASH("a") })).decision).toBe("review");
    const routed = await plan({ fileName: "mystery_CMYK.pdf", fileHash: HASH("a"), subfolder: SOLO });
    expect(routed).toMatchObject({ decision: "route", itemId: "s1" });
    expect(table("printIntake").map((row) => [row.fileHashSha256, row.status, row.productionJobItemId])).toEqual([[HASH("a"), "routed", "s1"]]);
  }, 120_000);

  it("REVISION reorder: the new file is HELD with a clear reason until the job's proof is approved, then routes after Release", async () => {
    const before = oldSide();
    const { job, items } = await release();
    const fileName = `${items[1].itemTicket} crud_SHORTCAKES_v2_F_CMYK.pdf`;
    const held = await plan({ fileName, fileHash: HASH("9"), subfolder: job.jobTicket });
    expect(held).toMatchObject({ decision: "review", machine: null, ripName: null, jobId: null, itemId: null });
    expect(held.reasons).toContain("revision_reorder_needs_new_proof_approval");
    expect(held.candidates).toEqual([{ jobTicket: job.jobTicket, itemTicket: items[1].itemTicket, productTitle: "SHORTCAKES pouch", reason: "item_ticket" }]);
    const row = rowOf(HASH("9"));
    expect(row).toMatchObject({ status: "review", reviewReason: "revision_needs_proof_approval" });
    expect([row.printer ?? null, row.routedFilename ?? null, row.matchedProductionJobId ?? null]).toEqual([null, null, null]);
    expect(REVIEW_REASON_LABELS.revision_needs_proof_approval).toContain("REVISED artwork");
    // Incoming Print Files shows the reason, not "LINK TO JOB"
    const page: any = await (await import("../app/routes/app.erp.print-intake")).loader({ request: new Request("https://erp.test/app/erp/print-intake") });
    expect(page.reviewRows.find((entry: any) => entry.id === row.id)).toMatchObject({ needsLinkLabel: "HELD — NEW PROOF APPROVAL REQUIRED", reviewReason: "revision_needs_proof_approval" });
    // every match rule holds it: folder + stored name, and the job folder alone on a single-item job
    expect((await plan({ fileName, fileHash: HASH("9"), subfolder: job.jobTicket })).decision).toBe("review");
    // a person cannot push it through by Release while the proof is still open
    expect((await intakeAction({ intent: "release", intakeId: row.id })).ok).toBe(true);
    expect((await plan({ fileName, fileHash: HASH("9"), subfolder: job.jobTicket })).decision).toBe("review");
    // ... nor by Assign to the revision item
    expect((await intakeAction({ intent: "assign", intakeId: row.id, target: `${job.id}|${items[1].id}` })).ok).toBe(true);
    const assignedHeld = await plan({ fileName, fileHash: HASH("9") });
    expect(assignedHeld).toMatchObject({ decision: "review", machine: null });
    expect(assignedHeld.reasons).toEqual(["assigned_but_held", "revision_reorder_needs_new_proof_approval"]);
    expect(rowOf(HASH("9"))).toMatchObject({ status: "assigned", reviewReason: "revision_needs_proof_approval" });

    // the EXISTING proof state is the gate: nothing but "approved" opens it
    const jobRecord = table("productionJob").find((entry) => entry.id === job.id);
    for (const state of ["sent", "viewed", "changes_requested"]) { jobRecord.proofStatus = state; expect((await plan({ fileName, fileHash: HASH("9") })).decision, state).toBe("review"); }
    jobRecord.proofStatus = "approved";
    const routed = await plan({ fileName, fileHash: HASH("9") });
    expect(routed).toMatchObject({ decision: "route", jobId: job.id, itemId: items[1].id, machine: "mimaki", ripName: `${items[1].itemTicket}__crud_SHORTCAKES_v2_F_CMYK` });
    expect(oldSide()).toBe(before);
  }, 120_000);

  it("SAME ARTWORK vs REVISION on one job: only the revision item waits; the pure rule", async () => {
    const { job, items } = await release();
    const same = await plan({ fileName: `${items[0].itemTicket} new_export_CMYK.pdf`, fileHash: HASH("1"), subfolder: job.jobTicket });
    const revised = await plan({ fileName: `${items[1].itemTicket} new_export_CMYK.pdf`, fileHash: HASH("2"), subfolder: job.jobTicket });
    expect([same.decision, revised.decision]).toEqual(["route", "review"]);
    expect(revisionReorderProofHold({ proofStatus: "draft" }, { reorderArtworkMode: "same_artwork" })).toBeNull();
    expect(revisionReorderProofHold({ proofStatus: "draft" }, { reorderArtworkMode: null })).toBeNull(); // not a reorder: never held by this
    expect(revisionReorderProofHold({ proofStatus: null }, { reorderArtworkMode: "revision" })).toBe("revision_reorder_needs_new_proof_approval");
    expect(revisionReorderProofHold({ proofStatus: "approved" }, { reorderArtworkMode: "revision" })).toBeNull();
    expect(canonicalReviewReason(["matched_by_item_ticket_but_held_for_proof", "revision_reorder_needs_new_proof_approval"])).toBe("revision_needs_proof_approval");
    // a job that is NOT a reorder is untouched by the proof rule (draft proof, routes)
    expect((await inSolo(CMYK, HASH("3"))).decision).toBe("route");
  }, 120_000);
});

/* ====================================================================== */
/* FIX 5 — Mimaki white is NOT approved: one rule on every path             */
/* ====================================================================== */

describe("FIX 5 · Mimaki white is not approved — New Job, quote routing, dispatch, Print Intake, reprint", () => {
  const HELD = "white_job_but_mimaki_selected_contradiction";
  const item = (over: Record<string, any> = {}) => ({ id: "x", itemTicket: "GSO-20261120-0001-01", ripJobName: null, suggestedFileName: null, productTitle: "Label", selectedFinish: null, materialSummary: null, machineSummary: null, ...over });
  const load = (mimaki: number, roland: number) => ({ source: "t", capturedAt: "t", unattributedOpenItems: 0, byPrinter: { mimaki: { openItems: mimaki, estimatedMinutes: null }, roland: { openItems: roland, estimatedMinutes: null } } }) as any;
  const WHITE_FINISHES = ["White", "White ink", "CMYK + White", "White + Gloss", "Holographic white underbase"];

  it("shared press decision: white + Mimaki is HELD; white with no press is the Roland whatever the load; Roland white and Mimaki gloss unchanged", () => {
    for (const finish of WHITE_FINISHES.slice(0, 4)) {
      expect(decideMachine(item({ selectedFinish: finish, machineSummary: MIMAKI })), finish).toEqual({ machine: null, machineRule: null, reasons: [HELD] });
      expect(decideMachine(item({ selectedFinish: finish }), "art_MIMAKI.pdf"), finish).toEqual({ machine: null, machineRule: null, reasons: [HELD] });
      for (const machineLoad of [undefined, null, load(0, 9), load(9, 0), load(3, 3)]) expect(decideMachine(item({ selectedFinish: finish }), "", machineLoad).machine, finish).toBe("roland");
      expect(decideMachine(item({ selectedFinish: finish, machineSummary: ROLAND })), finish).toMatchObject({ machine: "roland", machineRule: "explicit_erp_machine" });
    }
    expect(decideMachine(item({ selectedFinish: "White" }))).toEqual({ machine: "roland", machineRule: "white_requires_roland", reasons: ["white_requires_roland"] });
    // a `_w` layer file / white wording in the file name counts, as it does in Print Intake
    expect(decideMachine(item({ machineSummary: MIMAKI }), "crud_HEATH_F_w.pdf").reasons).toEqual([HELD]);
    expect(decideMachine(item(), "crud_HEATH_F_w.pdf")).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    // unchanged: CMYK and gloss
    expect(decideMachine(item({ selectedFinish: "Gloss", machineSummary: MIMAKI }))).toMatchObject({ machine: "mimaki", machineRule: "explicit_erp_machine" });
    expect(decideMachine(item({ selectedFinish: "Gloss" }))).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    expect(decideMachine(item({ selectedFinish: "CMYK" }))).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    expect(decideMachine(item({ materialSummary: "Bag Color: White | Finish: No Specialty — 0X | White Layers: 0X" }))).toMatchObject({ machine: "mimaki" }); // a white BAG is not white ink
    // filename-only decision
    expect(decideMachineFromFilename("Cust_2x white_MIMAKI.pdf")).toMatchObject({ machine: null, reasons: [HELD] });
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf", load(0, 9))).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    // the shared decision and Print Intake's own decision now agree on every white case
    for (const finish of WHITE_FINISHES.slice(0, 4)) {
      for (const machineSummary of [null, MIMAKI, ROLAND]) expect(decideMachine(item({ selectedFinish: finish, machineSummary })).machine, `${finish} / ${machineSummary}`).toBe(decideIntakeMachine(item({ selectedFinish: finish, machineSummary }) as any).machine);
    }
    expect(src("app/lib/print-intake-routing.server.ts")).not.toContain("selectLessBusyPrinter(");
  });

  it("New Job (validation + the real action): Mimaki + white is refused with a plain sentence; Auto + white goes to the Roland", async () => {
    const check = (finish: string, printer: any, machineLoad: any = null) => validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: 1, finish, printer }], machineLoad }) as any;
    for (const finish of ["White", "White + Gloss"]) {
      expect(check(finish, "mimaki")).toEqual({ ok: false, reason: "White ink is not approved on the Mimaki — a white job runs on the Roland. Choose the Roland (or Auto) for this item." });
      expect(check(finish, "auto", load(0, 9)).items[0].resolvedMachine).toBe("roland");
      expect(check(finish, "auto").items[0].resolvedMachine).toBe("roland");
      expect(check(finish, "roland").items[0]).toMatchObject({ resolvedMachine: "roland", machineRule: "explicit_erp_machine" });
    }
    expect(check("Gloss", "mimaki").items[0].resolvedMachine).toBe("mimaki");
    expect(check("CMYK", "auto").items[0].resolvedMachine).toBe("mimaki");

    h.sub = "4"; // the production lead may choose the printer
    const mod = await import("../app/routes/app.erp.production-new");
    const post = async (fields: Record<string, string>) => bodyOf(await callAction(mod, form({ intent: "createManualJob", customerName: "Walk-in White", itemTitle: "White label", quantity: "40", family: "stickers-labels", ...fields })));
    const refused = await post({ requestId: "aaaaaaaa-1111-4111-8111-111111111111", finish: "White", printer: "mimaki" });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("White ink is not approved on the Mimaki");
    expect(table("productionJob").some((row) => row.customerName === "Walk-in White")).toBe(false); // nothing was created
    const auto = await post({ requestId: "bbbbbbbb-2222-4222-8222-222222222222", finish: "White", printer: "auto" });
    expect(auto.ok, JSON.stringify(auto)).toBe(true);
    const created = table("productionJob").find((row) => row.customerName === "Walk-in White");
    expect(table("productionJobItem").filter((row) => row.jobId === created.id).map((row) => row.machineSummary)).toEqual([ROLAND]);
  }, 120_000);

  it("quote / Cost Calculator routing: explicit Mimaki + white is BLOCKED; Auto + white never picks the Mimaki; capabilities and calibration identities unchanged", () => {
    const blocked = resolveCanonicalMachineRouting({ printerSelection: "mimaki", whiteLayers: 1, whiteCoveragePct: 60 });
    expect(blocked.reasons).toContain(ROUTING_REASONS.mimakiWhiteNotApproved);
    expect(blocked.blockers.join(" ")).toContain("white ink is not approved on the Mimaki");
    expect(blocked.channels.find((channel) => channel.kind === "white")!.calibrationKey).toBe("mimaki-white"); // nothing borrowed from the Roland
    for (const machineLoad of [load(0, 9), load(9, 0), undefined]) {
      const auto = resolveCanonicalMachineRouting({ printerSelection: "auto", whiteLayers: 1, whiteCoveragePct: 60, machineLoad } as any);
      expect(auto.effectivePrinter).toBe("roland");
      expect(auto.reasons).not.toContain(ROUTING_REASONS.mimakiWhiteNotApproved);
      expect(auto.channels.find((channel) => channel.kind === "white")!.calibrationKey).toBe("roland-white");
    }
    const roland = resolveCanonicalMachineRouting({ printerSelection: "roland", whiteLayers: 1, whiteCoveragePct: 60 });
    expect([roland.effectivePrinter, roland.blockers]).toEqual(["roland", []]);
    expect(resolveCanonicalMachineRouting({ printerSelection: "mimaki" }).blockers).toEqual([]); // Mimaki CMYK unchanged
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", machineLoad: load(1, 4) } as any).effectivePrinter).toBe("mimaki"); // CMYK AUTO still load-balances
    expect(MACHINE_CAPABILITIES).toEqual({ mimaki: { cmyk: true, white: true, gloss: false }, roland: { cmyk: true, white: true, gloss: true } }); // physical capability table untouched
  });

  it("dispatch plan: a white item recorded on the Mimaki is BLOCKED with the reason; an unassigned white item dispatches to the Roland", () => {
    const planned = planDispatch([
      { id: "a", itemTicket: "T-01", productTitle: "x", selectedFinish: "White", materialSummary: null, machineSummary: MIMAKI },
      { id: "b", itemTicket: "T-02", productTitle: "x", selectedFinish: "White", materialSummary: null, machineSummary: null },
      { id: "c", itemTicket: "T-03", productTitle: "x", selectedFinish: "CMYK", materialSummary: null, machineSummary: MIMAKI, fileName: "art_w.pdf" },
      { id: "d", itemTicket: "T-04", productTitle: "x", selectedFinish: "Gloss", materialSummary: null, machineSummary: MIMAKI },
    ], load(0, 9));
    expect(planned.lines.map((line) => [line.itemId, line.decision, line.machine, line.reasons[0]])).toEqual([
      ["a", "BLOCK", null, HELD], ["b", "DISPATCH", "roland", "white_requires_roland"], ["c", "BLOCK", null, HELD], ["d", "DISPATCH", "mimaki", "explicit_erp_mimaki_assignment"],
    ]);
  });

  it("Print Intake and a reprint re-route: white + Mimaki is held with the conflict reason; white with no press routes to the Roland", async () => {
    const solo = table("productionJobItem").find((row) => row.id === "s1");
    Object.assign(solo, { selectedFinish: "White", machineSummary: MIMAKI });
    const held = await inSolo(CMYK, HASH("a"));
    expect(held).toMatchObject({ decision: "review", machine: null });
    expect(held.reasons).toContain(HELD);
    expect(rowOf(HASH("a"))).toMatchObject({ status: "review", reviewReason: "premium_mode_mimaki_contradiction" });
    expect(REVIEW_REASON_LABELS.premium_mode_mimaki_contradiction).toContain("not approved on the Mimaki");
    // a legacy record that says this file once went to the Mimaki: a reprint does not send white there again
    h.t.printIntake = [intakeRow("pw", "crud_HEATH_F_w.pdf", HASH("b"), "j2", "s1", `${SOLO}-01`, `${SOLO}-01__crud_HEATH_F_w`)];
    h.sub = "4";
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    const again = await plan({ fileName: "crud_HEATH_F_w.pdf", fileHash: HASH("b") });
    expect(again).toMatchObject({ decision: "review", machine: null });
    expect(again.reasons).toEqual(["assigned_but_machine_unresolved", HELD]);
    expect(rowOf(HASH("b"))).toMatchObject({ status: "retry_allowed", reviewReason: "premium_mode_mimaki_contradiction" });
    // no press on the item: white goes to the Roland
    Object.assign(solo, { machineSummary: null });
    const routed = await plan({ fileName: "crud_HEATH_F_w.pdf", fileHash: HASH("b") });
    expect(routed).toMatchObject({ decision: "route", machine: "roland", machineRule: "white_requires_roland", ripName: `${SOLO}-01__crud_HEATH_F_w__P1-A1` });
  }, 120_000);
});

/* ====================================================================== */
/* FIX 17 — Stock Bag checklist                                             */
/* ====================================================================== */

describe("FIX 17 · Stock Bag checklist (new jobs only)", () => {
  const STEPS = [
    "Stock design, bag colour, sides and quantity checked against the order",
    "Customer logo / QR placed on the design (only if one was uploaded)",
    "Blank bags pulled and counted",
    "Labels printed",
    "Labels cut",
    "Weeded (if required)",
    "Labels applied to bags",
    "QC passed",
    "Packed and labeled",
  ];
  const canonical = (profile: string) => JSON.stringify({ v: "15G.5-storefront-canonical", profile, qty: 50, faces: 2, material: "Matte", bagColor: "White", holo: false, whiteRequired: false, glossX: 0, finishLabel: "No Specialty — 0X", unitPrice: 2.7, engine: "canonical-bag-pricing/15G.4C" });
  const bagLine = (id: number, family: string, type: string, withVisible = true) => ({
    id, title: type.startsWith("stock") ? "Ritz Vanilla Cupcake" : "4X5 Sticker Bag", quantity: 50, price: "2.70",
    properties: [...(withVisible ? [{ name: "Product Family", value: family }, { name: "Product Type", value: type }] : []), { name: "Material", value: "Matte" }, { name: "Finish", value: "No Specialty — 0X" }, { name: "Bag Color", value: "White" }, { name: "_GSO Canonical", value: canonical(type) }],
  });
  const order = (...lines: any[]) => ({ id: 99501, name: "#1501", admin_graphql_api_id: "gid://shopify/Order/99501", email: "buyer@example.com", line_items: lines });
  const familyOf = (...lines: any[]) => (buildShopifyOrderJobPayload(order(...lines), "GSO-20261120-0100") as any).checklistFamily;

  it("the nine steps, in order — and NO mandatory proof / artwork-received step", () => {
    expect(STOCK_BAG_CHECKLIST_FAMILY).toBe("stock-bags");
    const list = FAMILY_CHECKLISTS["stock-bags"];
    expect(list.map((step) => step.label)).toEqual(STEPS);
    expect(list.map((step) => step.sortOrder)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(list.map((step) => step.section)).toEqual(["prepress", "prepress", "production", "production", "production", "production", "production", "qc", "packing"]);
    expect(list.some((step) => /proof|artwork received|dieline/i.test(step.label))).toBe(false);
    expect(src("app/lib/production-job-source.server.ts")).toContain("JAMES DECISION REQUIRED"); // proof on logo / QR is an open owner decision
  });

  it("a Stock-Bag-ONLY paid order gets it (canonical snapshot, or visible properties alone); mixed orders and other families keep today's checklist", () => {
    expect(familyOf(bagLine(1, "Stock Bags", "stock_bag_4x5"))).toBe("stock-bags");
    expect(familyOf(bagLine(1, "Stock Bags", "stock_bag_4x5"), bagLine(2, "Stock Bags", "stock_bag_4x5"))).toBe("stock-bags");
    expect(familyOf(bagLine(1, "Stock Bags", "stock_bag_4x5", false))).toBe("stock-bags"); // stripped line: the snapshot profile decides
    expect(familyOf(bagLine(1, "Stock Bags", "stock_bag_4x5"), bagLine(2, "Sticker Bags", "sticker_bag_4x5"))).toBe("default"); // mixed: unchanged
    expect(familyOf(bagLine(1, "Sticker Bags", "sticker_bag_4x5"))).toBe("sticker-bags"); // unchanged
    expect(FAMILY_CHECKLISTS["sticker-bags"].map((step) => step.label)).toEqual(["Artwork received / linked", "Proof approved", "Labels printed", "Cut complete", "Weeded (if required)", "Labels applied to bags", "QC passed", "Packed and labeled"]);
    expect(FAMILY_CHECKLISTS.default).toHaveLength(10);
  });

  it("manual New Job 'Stock Bags' now gets the Stock Bag checklist; the other manual families are unchanged; an existing job's checklist is not rewritten", async () => {
    expect(MANUAL_JOB_FAMILIES.find((option) => option.label === "Stock Bags")!.value).toBe("sticker-bags"); // the stored value did not change
    expect(checklistForManualFamily("sticker-bags")).toBe(FAMILY_CHECKLISTS["stock-bags"]);
    for (const family of ["standard-jars", "premium-jars", "stickers-labels", "dtp-bags", "banners", "default"]) expect(checklistForManualFamily(family), family).toBe(FAMILY_CHECKLISTS[family]);
    // an EXISTING job with the old checklist
    h.t.productionChecklistItem = FAMILY_CHECKLISTS["sticker-bags"].map((step, index) => ({ id: `old${index}`, shop: "shop-1", jobId: "j2", ...step, completed: index < 2 }));
    const existing = snapshot(table("productionChecklistItem"));
    const make = (requestId: string, family: string) => createProductionJobFromSource(db, { shop: "shop-1", actor: "lead@gso.test", source: { type: "manual_admin", authorizedBy: "lead@gso.test", requestId, payload: { customerName: `Walk-in ${family}`, items: [{ productTitle: "Vanilla Cupcake bag", quantity: 50, family, finish: "CMYK", printer: "auto" }] } } } as any);
    const stock = await make("cccccccc-3333-4333-8333-333333333333", "sticker-bags");
    const stockSteps = table("productionChecklistItem").filter((row) => row.jobId === stock.job.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(stockSteps.map((row) => row.label)).toEqual(STEPS);
    const stickers = await make("dddddddd-4444-4444-8444-444444444444", "stickers-labels");
    expect(table("productionChecklistItem").filter((row) => row.jobId === stickers.job.id).map((row) => row.label)).toEqual(FAMILY_CHECKLISTS["stickers-labels"].map((step) => step.label));
    expect(snapshot(table("productionChecklistItem").filter((row) => row.jobId === "j2"))).toBe(existing);
  }, 120_000);
});

/* ====================================================================== */
/* FIX 20 / 21 — Incoming Print Files; a finished job is never changed      */
/* ====================================================================== */

describe("FIX 20 / FIX 21 · Incoming Print Files cases and finished-job protection (real route-plan / review / report code)", () => {
  beforeEach(seedOldJob);
  const oldSide = () => snapshot([
    table("productionJob").filter((row) => row.id === "j0"), table("productionJobItem").filter((row) => row.jobId === "j0"), table("productionJobFile").filter((row) => row.jobId === "j0"),
    table("productionRun").filter((row) => row.jobId === "j0"), table("productionJobEvent").filter((row) => row.jobId === "j0"), table("printIntake").filter((row) => ["op1", "op2"].includes(row.id)),
  ]);
  const reviewState = (hash: string) => { const row = rowOf(hash); return [row?.status ?? null, row?.reviewReason ?? null, row?.printer ?? null, row?.routedFilename ?? null, row?.matchedProductionJobId ?? null]; };

  it("exact match: item ticket in the name, job ticket on a single-item job, the job folder, the stored name", async () => {
    table("productionJobItem").find((row) => row.id === "s1").suggestedFileName = "krud-bag-labels-final";
    expect(await plan({ fileName: `${JOB}-02 shortcakes_CMYK.pdf`, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "item_ticket", itemId: "i2", ripName: `${JOB}-02__shortcakes_CMYK` });
    expect(await plan({ fileName: `${SOLO} labels_CMYK.pdf`, fileHash: HASH("b") })).toMatchObject({ decision: "route", rule: "job_ticket_single_item", itemId: "s1", ripName: `${SOLO}-01__labels_CMYK` });
    expect(await plan({ fileName: "anything_CMYK.pdf", fileHash: HASH("c"), subfolder: `${SOLO} KRUD CAFE` })).toMatchObject({ decision: "route", rule: "job_subfolder", itemId: "s1" });
    expect(await plan({ fileName: "Krud Bag Labels FINAL.pdf", fileHash: HASH("d") })).toMatchObject({ decision: "route", rule: "stored_filename", itemId: "s1" });
    expect(table("productionJob")).toHaveLength(3); // never a new job
  }, 120_000);

  it("ambiguous match and multi-item job: held with the candidates, no press, no job link", async () => {
    table("productionJobItem").find((row) => row.id === "i1").suggestedFileName = "shared-name";
    table("productionJobItem").find((row) => row.id === "s1").suggestedFileName = "shared-name";
    const ambiguous = await plan({ fileName: "shared-name.pdf", fileHash: HASH("a") });
    expect(ambiguous).toMatchObject({ decision: "review", machine: null, jobId: null, itemId: null });
    expect(ambiguous.reasons).toContain("stored_filename_matches_multiple_items");
    expect(ambiguous.candidates).toHaveLength(2);
    expect(reviewState(HASH("a"))).toEqual(["review", "ambiguous_candidates", null, null, null]);
    const multi = await plan({ fileName: "front_CMYK.pdf", fileHash: HASH("b"), subfolder: JOB });
    expect(multi.reasons).toContain("folder_job_has_multiple_items_needs_link_to_item");
    expect(reviewState(HASH("b"))).toEqual(["review", "needs_link_to_item", null, null, null]);
    const jobTicketMulti = await plan({ fileName: `${JOB} front_CMYK.pdf`, fileHash: HASH("c") });
    expect(jobTicketMulti.reasons).toContain("job_ticket_matches_job_with_multiple_items_pick_item_in_review");
    expect(jobTicketMulti.machine).toBeNull();
  }, 120_000);

  it("unmatched: held as LINK TO JOB; a repeat poll writes nothing; no job is created", async () => {
    const first = await plan({ fileName: "who_knows_CMYK.pdf", fileHash: HASH("a") });
    expect(first).toMatchObject({ decision: "review", needsLinkToJob: true, machine: null, jobId: null });
    expect(reviewState(HASH("a"))).toEqual(["review", "needs_link_to_job", null, null, null]);
    h.writes = [];
    await plan({ fileName: "who_knows_CMYK.pdf", fileHash: HASH("a") });
    expect(h.writes).toEqual([]);
    expect(table("productionJob")).toHaveLength(3);
  }, 120_000);

  it.each([
    ["item ticket in the file name", { fileName: `${OLD}-01 crud_HEATH_F_CMYK_new.pdf` }, /item_ticket_.*_on_closed_job/],
    ["JOB ticket in the file name (multi-item job)", { fileName: `${OLD} crud_new.pdf` }, /job_ticket_.*_on_closed_job/],
    ["ticket-named job folder", { fileName: "crud_new.pdf", subfolder: `${OLD} KRUD` }, /folder_ticket_.*_on_closed_job/],
    ["item ticket in the name inside the job folder", { fileName: `${OLD}-02 crud_new.pdf`, subfolder: OLD }, /_on_closed_job/],
  ])("COMPLETED job, %s: held (ticket_on_closed_job); the finished job is byte-identical", async (_label, fields, reason) => {
    const before = oldSide();
    const planned = await plan({ fileHash: HASH("5"), ...fields });
    expect(planned).toMatchObject({ decision: "review", machine: null, ripName: null, jobId: null, itemId: null });
    expect(planned.reasons.join(" ")).toMatch(reason);
    expect(reviewState(HASH("5"))).toEqual(["review", "ticket_on_closed_job", null, null, null]);
    expect(oldSide()).toBe(before);
  }, 120_000);

  it("COMPLETED / CANCELLED single-item job: job ticket in the name, the stored name and the stored job file name are held too", async () => {
    for (const status of ["completed", "cancelled", "canceled", "archived"]) {
      seed(); seedOldJob();
      Object.assign(table("productionJob").find((row) => row.id === "j2"), { status });
      Object.assign(table("productionJobItem").find((row) => row.id === "s1"), { suggestedFileName: "krud-bag-labels-final" });
      h.t.productionJobFile.push({ id: "sf1", shop: "shop-1", jobId: "j2", productionJobItemId: "s1", fileType: "artwork", assetSource: "manual", fileName: "customer upload v7.pdf", originalFileName: "customer upload v7.pdf", createdAt: T0 });
      const cases: Array<[Record<string, any>, RegExp]> = [
        [{ fileName: `${SOLO} labels.pdf` }, /job_ticket_.*_on_closed_job/],
        [{ fileName: "Krud Bag Labels FINAL.pdf" }, /stored_filename_match_on_closed_job/],
        [{ fileName: "Customer Upload V7.pdf" }, /job_file_name_match_on_closed_job/],
        [{ fileName: `${SOLO}-01 labels.pdf` }, /item_ticket_.*_on_closed_job/],
        [{ fileName: "labels.pdf", subfolder: SOLO }, /folder_ticket_.*_on_closed_job/],
      ];
      for (const [index, [fields, reason]] of cases.entries()) {
        const planned = await plan({ fileHash: HASH(String(index + 1)), ...fields });
        expect([planned.decision, planned.machine, planned.jobId], `${status} · ${JSON.stringify(fields)}`).toEqual(["review", null, null]);
        expect(planned.reasons.join(" "), `${status} · ${JSON.stringify(fields)}`).toMatch(reason);
        expect(reviewState(HASH(String(index + 1)))[1]).toBe("ticket_on_closed_job");
      }
      expect(table("printIntake").filter((row) => row.matchedProductionJobId === "j2")).toEqual([]);
    }
  }, 120_000);

  it("revision, reprint and remake on an OPEN job route", async () => {
    expect((await inSolo(CMYK, HASH("a"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK`);
    expect((await inSolo(CMYK, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-A1`); // revision
    h.sub = "4";
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    expect((await inSolo(CMYK, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`); // reprint
    expect(rowOf(HASH("a"))).toMatchObject({ status: "routed", reprintNumber: 0 }); // the superseded revision 1 is not re-routed
    expect((await jobAction({ intent: "qcItem", jobId: "j2", itemId: "s1", qcResult: "reprint_required" })).body.ok).toBe(true);
    expect((await reprint("s1", "j2", { runKind: "remake", reprintReason: "material_defect", chargeType: "warranty" })).body.ok).toBe(true);
    expect((await inSolo(CMYK, HASH("b"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P2-A1`); // remake
  }, 120_000);

  it("held file -> Release -> still held while the cause stands -> routes once a person fixes the cause", async () => {
    // a held file: printer conflict (ROLAND tag against the ERP's Mimaki)
    const held = await inSolo("crud_HEATH_B_CMYK_ROLAND.pdf", HASH("c"));
    expect(held.decision).toBe("review");
    expect(reviewState(HASH("c"))).toEqual(["review", "printer_assignment_contradiction", null, null, null]);
    expect((await api("status", { hash: HASH("c") })).results[0]).toMatchObject({ disposition: "keep_blocked", retryAllowed: false });
    expect((await intakeAction({ intent: "release", intakeId: rowOf(HASH("c")).id })).ok).toBe(true);
    expect((await api("status", { hash: HASH("c") })).results[0]).toMatchObject({ disposition: "retry_allowed", retryAllowed: true });
    expect((await inSolo("crud_HEATH_B_CMYK_ROLAND.pdf", HASH("c"))).decision).toBe("review"); // still a conflict: Release does not override the rule
    table("productionJobItem").find((row) => row.id === "s1").machineSummary = ROLAND; // a person fixes the cause on the job
    expect(await inSolo("crud_HEATH_B_CMYK_ROLAND.pdf", HASH("c"))).toMatchObject({ decision: "route", machine: "roland", itemId: "s1" });
  }, 120_000);

  it("manual assignment: closed / finalized / inactive / other-shop jobs are refused; a multi-item job needs the item", async () => {
    const job = (over: Record<string, any> = {}) => ({ id: "j", shop: "shop-1", active: true, status: "printing", actualCostFinalized: false, jobTicket: "T", items: [{ id: "a", itemTicket: "T-01" }], ...over });
    expect(validateIntakeAssignment({ shop: "shop-1", job: job(), itemId: null })).toEqual({ ok: true, item: { id: "a", itemTicket: "T-01" } });
    for (const status of ["completed", "cancelled", "canceled", "archived", "COMPLETED"]) expect(validateIntakeAssignment({ shop: "shop-1", job: job({ status }), itemId: null }).ok, status).toBe(false);
    expect(validateIntakeAssignment({ shop: "shop-1", job: job({ actualCostFinalized: true }), itemId: null }).ok).toBe(false);
    expect(validateIntakeAssignment({ shop: "shop-1", job: job({ active: false }), itemId: null }).ok).toBe(false);
    expect(validateIntakeAssignment({ shop: "other", job: job(), itemId: null })).toEqual({ ok: false, reason: "Job not found." });
    expect(validateIntakeAssignment({ shop: "shop-1", job: job({ items: [{ id: "a", itemTicket: "T-01" }, { id: "b", itemTicket: "T-02" }] }), itemId: null }).ok).toBe(false);
    expect(validateIntakeAssignment({ shop: "shop-1", job: job({ items: [{ id: "a", itemTicket: "T-01" }, { id: "b", itemTicket: "T-02" }] }), itemId: "zzz" }).ok).toBe(false);
    // through the real page action: a completed job cannot be the target, single or bulk
    const before = oldSide();
    await plan({ fileName: "mystery_CMYK.pdf", fileHash: HASH("a") });
    const id = rowOf(HASH("a")).id;
    for (const fields of [{ intent: "assign", intakeId: id, target: "j0|o1" }, { intent: "bulkAssign", intakeIds: id, target: "j0|o1" }]) {
      const out = await intakeAction(fields as any);
      expect(out.ok, fields.intent).toBe(false);
      expect(out.message, fields.intent).toContain("use the reprint/reopen flow");
    }
    expect(reviewState(HASH("a"))).toEqual(["review", "needs_link_to_job", null, null, null]);
    expect(oldSide()).toBe(before);
  }, 120_000);

  it("a record whose file was already DELIVERED for one job is not re-pointed at another job by Assign", async () => {
    // routed + delivered for the solo job, then a reprint leaves the row waiting (retry_allowed)
    const planned = await inSolo(CMYK, HASH("a"));
    expect((await reportRouted(planned, CMYK, HASH("a"))).printFile).toBe("created");
    h.sub = "4";
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    const row = rowOf(HASH("a"));
    const before = snapshot([row]);
    for (const fields of [{ intent: "assign", intakeId: row.id, target: "j1|i2" }, { intent: "bulkAssign", intakeIds: row.id, target: "j1|i2" }]) {
      const out = await intakeAction(fields as any);
      expect(out.ok, fields.intent).toBe(false);
      expect(out.message, fields.intent).toContain(`was already sent to a press for ${SOLO}`);
    }
    expect(snapshot([rowOf(HASH("a"))])).toBe(before);
    // a record that was never delivered (held, linked by mistake) can still be moved to the right job
    await plan({ fileName: "wrong_link_CMYK.pdf", fileHash: HASH("b") });
    const loose = rowOf(HASH("b"));
    expect((await intakeAction({ intent: "assign", intakeId: loose.id, target: "j2" })).ok).toBe(true);
    expect((await intakeAction({ intent: "assign", intakeId: loose.id, target: "j1|i2" })).ok).toBe(true);
    expect(rowOf(HASH("b"))).toMatchObject({ status: "assigned", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-02` });
  }, 120_000);

  it("a waiting assignment does not attach a file to a job that was FINISHED in the meantime — only an explicit reprint request does", async () => {
    await plan({ fileName: "late_CMYK.pdf", fileHash: HASH("a") });
    expect((await intakeAction({ intent: "assign", intakeId: rowOf(HASH("a")).id, target: "j2" })).ok).toBe(true);
    const job = table("productionJob").find((row) => row.id === "j2");
    job.status = "completed";
    const held = await plan({ fileName: "late_CMYK.pdf", fileHash: HASH("a") });
    expect(held).toMatchObject({ decision: "review", machine: null });
    expect(held.reasons).toEqual(["assigned_but_held", "assigned_job_on_closed_job"]);
    expect(rowOf(HASH("a"))).toMatchObject({ status: "assigned", reviewReason: "ticket_on_closed_job" });
    expect([rowOf(HASH("a")).routedFilename ?? null, rowOf(HASH("a")).printer ?? null]).toEqual([null, null]);
    expect(table("productionJobFile").filter((row) => row.jobId === "j2")).toEqual([]);
    // the explicit action: a reprint requested on the finished job re-routes its EXISTING layer
    h.t.printIntake = [intakeRow("pa", CMYK, HASH("b"), "j2", "s1", `${SOLO}-01`, `${SOLO}-01__crud_HEATH_F_CMYK`)];
    h.sub = "1";
    expect((await reprint("s1", "j2")).body.ok).toBe(true);
    expect(await plan({ fileName: CMYK, fileHash: HASH("b") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", ripName: `${SOLO}-01__crud_HEATH_F_CMYK__P1-A1` });
    // ... but NEW artwork for the finished job is still held until the job is reopened
    expect((await inSolo(CMYK, HASH("c"))).decision).toBe("review");
    job.status = "reprint_needed"; // what "Reopen for Reprint" sets
    expect((await inSolo(CMYK, HASH("c"))).ripName).toBe(`${SOLO}-01__crud_HEATH_F_CMYK__R2-P1-A1`);
  }, 120_000);

  it("report: a 'routed' report naming a FINISHED job that the server never planned writes nothing on that job", async () => {
    const before = oldSide();
    const stale = await api("report", { fileName: "stray.pdf", decision: "routed", rule: "item_ticket", jobId: "j0", jobTicket: OLD, itemTicket: `${OLD}-01`, ripName: `${OLD}-01__stray`, machine: "mimaki", fileHash8: "99999999", fileHash: HASH("9") });
    expect(stale).toMatchObject({ ok: true, printFile: null }); // the watcher's call still succeeds (contract unchanged)
    expect(oldSide()).toBe(before);
    expect(rowOf(HASH("9"))).toBeUndefined();
    // an open job with no server plan behaves as before: the event is written, no print file
    const open = await api("report", { fileName: "stray2.pdf", decision: "routed", rule: "item_ticket", jobId: "j2", jobTicket: SOLO, itemTicket: `${SOLO}-01`, ripName: `${SOLO}-01__stray2`, machine: "mimaki", fileHash8: "88888888", fileHash: HASH("8").replace(/8/g, "e") });
    expect(open).toMatchObject({ ok: true, recorded: true, printFile: null });
    expect(table("productionJobEvent").filter((row) => row.jobId === "j2").map((row) => row.eventType)).toEqual(["print_file_routed"]);
    expect(table("productionJobFile").filter((row) => row.jobId === "j2")).toEqual([]);
    // a cross-shop / unknown job is refused outright, as before
    const mod = await import("../app/routes/api.print-intake.report");
    const refused: Response = await mod.action({ request: new Request("https://erp.test/api/print-intake/report", { method: "POST", body: JSON.stringify({ token: TOKEN, fileName: "x.pdf", decision: "routed", jobId: "nope" }) }) });
    expect(refused.status).toBe(400);
  }, 120_000);

  it("AUDIT (source pins): the only writers of a PrintIntake job link, and Print Intake never creates a job", () => {
    const routePlan = src("app/routes/api.print-intake.route-plan.tsx");
    expect(routePlan).not.toContain("productionJob.create");
    expect(routePlan).not.toContain("productionJob.update");
    expect(routePlan).toContain("const reuseOf = !targetRow && existingIntake ? existingIntake : null;"); // another job's row is never the upsert target
    expect(routePlan).toContain("isClosedIntakeJobStatus(assignedJob.status) && !explicitReprint");
    const routing = src("app/lib/print-intake-routing.server.ts");
    expect(routing).toContain("if (isClosedIntakeJobStatus(job.status)) {"); // routeItem: every rule
    const report = src("app/routes/api.print-intake.report.tsx");
    expect(report).toContain("routedIntake.matchedProductionJobId === job.id"); // a print file only for the server's own plan
    expect(report).toContain("const closedAndUnplanned = Boolean(job) && isClosedIntakeJobStatus(job?.status) && !serverPlanned;");
    const page = src("app/routes/app.erp.print-intake.tsx");
    expect(page.match(/validateIntakeAssignment\(/g)).toHaveLength(2); // single + bulk Assign
    expect(page.match(/await deliveredElsewhere\(/g)).toHaveLength(2);
  });
});
