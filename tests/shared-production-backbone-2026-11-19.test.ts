// 2026-11-19 — shared order-to-production backbone (admin lane + production lane).
//
// One job system for both lanes: roles decide who does what, never a person's
// name. Pins: role / capability access, the exact file -> item link, production
// runs (reprint quantity, several runs, every layer re-routed, no revenue
// change), reorders (new sale, lineage, current pricing, artwork reuse /
// revision) and staged business transactions (never a job until a person
// releases one through the canonical job service).

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-19T16:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "owner@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

// A small in-memory database: equality / in / not / contains / OR / NOT, compound unique keys, nested job creates.
vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "gte", "lt", "some"]);
  const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : (a ?? null) === (b ?? null));
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "NOT") return !match(row, value);
    if (key === "job" || key === "items") return true;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value); // compound unique key
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return !eq(row[key], value.not);
      if ("contains" in value) return String(row[key] || "").toLowerCase().includes(String(value.contains).toLowerCase());
      return true;
    }
    return eq(row[key], value);
  });
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const withItems = (job: any, args: any) => (job && args?.include?.items ? { ...job, items: rows("productionJobItem").filter((item) => item.jobId === job.id).map((item) => ({ ...item })) } : job && { ...job });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") {
        const found = list.filter((row) => match(row, args.where))[0] || null;
        if (name === "productionJob") return withItems(found, args);
        if (name === "productionJobItem" && found && args.include?.job) return { ...found, job: rows("productionJob").find((job) => job.id === found.jobId) || null };
        return found ? { ...found } : null;
      }
      if (method === "findMany") {
        const found = list.filter((row) => match(row, args.where));
        if (name === "productionJob") return found.map((job) => ({ ...withItems(job, { include: { items: true } }), files: rows("productionJobFile").filter((f) => f.jobId === job.id), events: rows("productionJobEvent").filter((e) => e.jobId === job.id), checklistItems: [], materialUsages: [], inventoryMovements: [] }));
        if (name === "productionJobItem" && args.include?.job) return found.map((item) => ({ ...item, job: rows("productionJob").find((job) => job.id === item.jobId) || null }));
        return found.map((row) => ({ ...row }));
      }
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") {
        const { items, events, checklistItems, ...data } = args.data;
        const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...data };
        list.push(row);
        for (const item of items?.create || []) rows(name === "quote" ? "quoteItem" : "productionJobItem").push({ id: `item_${++h.seq}`, ...(name === "quote" ? { quoteId: row.id } : { jobId: row.id }), ...item });
        for (const event of events?.create || []) rows("productionJobEvent").push({ id: `event_${++h.seq}`, jobId: row.id, createdAt: new Date((h.clock += 1000)), ...event });
        return name === "productionJob" ? withItems(row, args) : { ...row };
      }
      if (method === "update" || method === "updateMany") {
        const found = list.filter((row) => match(row, args.where));
        found.forEach((row) => Object.assign(row, args.data, { updatedAt: new Date((h.clock += 1000)) }));
        return method === "update" ? { ...found[0] } : { count: found.length };
      }
      return null;
    },
  });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "$transaction") return async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn));
      if (key === "$queryRawUnsafe") return async () => [];
      return model(key);
    },
  });
  return { default: db, db };
});

import db from "../app/db.server";
import { CAPABILITY_GROUPS, PRODUCTION_INTENT_ROLES, roleHasCapabilityGroup, roleMayRunProductionIntent, roleMayViewProduction, workspacesForRole } from "../app/lib/production-role-access";
import { ROLE_PERMISSIONS, resolveStaffAccess } from "../app/lib/staff-roles.server";
import { navForRole } from "../app/lib/simple-nav";
import { createProductionJobFromSource, priorItemFiles, recordRoutedPrintFile, resolveRoutedFileItemId } from "../app/lib/production-job-source.server";
import { ripFileBaseName } from "../app/lib/print-intake-routing.server";
import { itemFileState, itemRunSummary, layersToReroute, nextReprintNumber, openRunOf, parseReprintQuantity, planReprintRuns, runStatusForQc } from "../app/lib/production-run";
import { REORDER_PRICING_REQUIRED, buildReorderQuoteDraft, parseReorderRequest, withStoredReorderLineage } from "../app/lib/reorder";
import { normalizeIncomingLines, releaseReadiness, releaseStagedTransaction, saveStagedReview, stageTransaction } from "../app/lib/staged-transaction.server";
import { toBoardCard } from "../app/lib/simple-production";

const OWNER = "77055393857";
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: OWNER, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const SUB = { owner: OWNER, manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", unassigned: "9999" } as const;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const JOB = "GSO-20261119-0042";

let production: any;
let releaseQueue: any;
let reorderRoute: any;
beforeAll(async () => {
  production = await import("../app/routes/app.erp.production");
  releaseQueue = await import("../app/routes/app.erp.release-queue");
  reorderRoute = await import("../app/routes/app.erp.reorder");
}, 240_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = OWNER;
  h.seq = 0;
  h.t = {
    productionJob: [{ id: "j1", shop: "shop-1", jobTicket: JOB, status: "qc", active: true, customerName: "krud Cafe", company: null, email: null, actualCostFinalized: false, quoteId: "manual_seed-request-1" }],
    productionJobItem: [
      { id: "i1", shop: "shop-1", jobId: "j1", itemTicket: `${JOB}-01`, ripJobName: `${JOB}-01`, productTitle: "HEATH pouch", quantity: 500, unitPrice: 1.25, unitCost: 0.4, selectedFinish: "CMYK + Gloss", machineSummary: "Mimaki UCJV300-130", qcResult: null, lastReprintAt: null, sortOrder: 1 },
      { id: "i2", shop: "shop-1", jobId: "j1", itemTicket: `${JOB}-02`, ripJobName: `${JOB}-02`, productTitle: "SHORTCAKES pouch", quantity: 250, unitPrice: 1.4, unitCost: 0.45, selectedFinish: "CMYK", machineSummary: "Mimaki UCJV300-130", qcResult: null, lastReprintAt: null, sortOrder: 2 },
    ],
    printIntake: [
      { id: "pi1", shop: "shop-1", originalFilename: "crud_HEATH_F_CMYK.pdf", fileHashSha256: HASH_A, status: "routed", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-01`, routedFilename: `${JOB}-01__crud_HEATH_F_CMYK`, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, rawParsedHints: null, updatedAt: new Date("2026-11-19T10:00:00Z") },
      { id: "pi2", shop: "shop-1", originalFilename: "crud_HEATH_F_g.pdf", fileHashSha256: HASH_B, status: "routed", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-01`, routedFilename: `${JOB}-01__crud_HEATH_F_g`, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, rawParsedHints: null, updatedAt: new Date("2026-11-19T10:01:00Z") },
    ],
  };
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const post = async (fields: Record<string, string>) => {
  const res: Response = await production.action({ request: new Request("https://app.test/app/erp/production", { method: "POST", body: new URLSearchParams({ jobId: "j1", itemId: "i1", ...fields }) }) });
  return { status: res.status, body: await res.json() };
};
const statusOf = async (run: () => Promise<any>) => { try { const res = await run(); return res instanceof Response ? res.status : 200; } catch (thrown: any) { return thrown instanceof Response ? thrown.status : 500; } };

/* ============================== ROLES ============================== */

describe("ROLES — one job system, two lanes, capabilities not names", () => {
  it("no person's name is written into the authorization code", () => {
    for (const file of ["app/lib/production-role-access.ts", "app/lib/staff-roles.server.ts", "app/lib/simple-nav.ts", "app/routes/app.erp.release-queue.tsx", "app/routes/app.erp.reorder.tsx", "app/lib/staged-transaction.server.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/raquel/i);
    }
  });

  it("the owner / admin holds BOTH lanes: board, reprints, QC, completion, scheduling, release", () => {
    expect(roleMayViewProduction("owner")).toBe(true);
    expect(workspacesForRole("owner")).toEqual(["admin", "production"]);
    for (const intent of ["changeStatus", "qcItem", "reprintItem", "revisionItem", "reopenReprint", "updateJob", "quickDueDate", "addNote", "recordShipment", "recordPickup", "createManualJob", "linkJobToTarget", "releaseStagedTransaction", "reviewStagedTransaction"]) {
      expect(roleMayRunProductionIntent("owner", intent), intent).toBe(true);
    }
    for (const permission of ["recordQc", "recordReprint", "recordShipment", "manageIntake", "selectPrinter", "viewFinancials", "sendQuote"] as const) expect(ROLE_PERMISSIONS.owner).toContain(permission);
    for (const group of Object.keys(CAPABILITY_GROUPS) as Array<keyof typeof CAPABILITY_GROUPS>) expect(roleHasCapabilityGroup("owner", group), group).toBe(true);
  });

  it("the production lead (print_operator) holds the production lane", () => {
    expect(roleMayViewProduction("print_operator")).toBe(true);
    expect(workspacesForRole("print_operator")).toEqual(["production"]);
    for (const intent of ["changeStatus", "qcItem", "reprintItem", "revisionItem", "addNote", "addFile", "setFileRole", "createManualJob", "linkJobToTarget", "recordShipment", "recordPickup", "toggleChecklist"]) {
      expect(roleMayRunProductionIntent("print_operator", intent), intent).toBe(true);
    }
    for (const permission of ["recordQc", "recordReprint", "recordShipment", "manageIntake", "selectPrinter"] as const) expect(ROLE_PERMISSIONS.print_operator).toContain(permission);
  });

  it("the production lead is refused admin / accounting-sensitive actions", () => {
    for (const intent of ["reviewStagedTransaction", "releaseStagedTransaction", "dismissStagedTransaction", "updateJob", "quickDueDate", "saveFinalCosts", "reopenJobCost", "pullPrintLogActuals", "adjustInventory", "createFromQuote", "reopenReprint"]) {
      expect(roleMayRunProductionIntent("print_operator", intent), intent).toBe(false);
    }
    for (const permission of ["viewFinancials", "ownerOverrides", "approvePurchasing", "approveExceptionPricing", "sendQuote"] as const) expect(ROLE_PERMISSIONS.print_operator).not.toContain(permission);
    expect(roleHasCapabilityGroup("print_operator", "ADMIN_WORKFLOW")).toBe(false);
    expect(roleHasCapabilityGroup("print_operator", "COMMERCIAL")).toBe(false);
    const links = navForRole("print_operator").flatMap((section) => section.links.map((link) => link.href));
    expect(links).toContain("/app/erp/production-board");
    expect(links).toContain("/app/erp/print-intake");
    expect(links).not.toContain("/app/erp/release-queue");
    expect(links).not.toContain("/app/erp/reorder");
  });

  it("Sales and unassigned accounts still hold no production access", () => {
    for (const role of ["sales", "unassigned"]) {
      expect(roleMayViewProduction(role)).toBe(false);
      for (const intent of Object.keys(PRODUCTION_INTENT_ROLES).filter((name) => name !== "createFromQuote")) expect(roleMayRunProductionIntent(role, intent), `${role} ${intent}`).toBe(false);
    }
  });

  it("the Release to Production page and its actions are owner / manager only (server)", async () => {
    const load = () => releaseQueue.loader({ request: new Request("https://app.test/app/erp/release-queue") });
    for (const [role, expected] of [["owner", 200], ["manager", 200], ["print_operator", 403], ["bagger", 403], ["sales", 403], ["unassigned", 403]] as const) {
      h.sub = SUB[role];
      expect(await statusOf(load), role).toBe(expected);
      const res: Response = await releaseQueue.action({ request: new Request("https://app.test/app/erp/release-queue", { method: "POST", body: new URLSearchParams({ intent: "release", id: "nope" }) }) });
      expect(res.status === 403, `${role} action`).toBe(expected === 403);
    }
    expect(h.t.productionJob).toHaveLength(1); // nothing was created by any of it
  });

  it("the Reorder page is for selling roles; amounts never reach it", async () => {
    const load = () => reorderRoute.loader({ request: new Request("https://app.test/app/erp/reorder?q=krud") });
    for (const [role, expected] of [["owner", 200], ["manager", 200], ["sales", 200], ["print_operator", 403], ["bagger", 403], ["unassigned", 403]] as const) {
      h.sub = SUB[role];
      expect(await statusOf(load), role).toBe(expected);
    }
    h.sub = SUB.sales;
    const data = await (await load()).json();
    expect(data.options.map((option: any) => option.itemTicket)).toEqual([`${JOB}-01`, `${JOB}-02`]);
    expect(JSON.stringify(data)).not.toMatch(/unitPrice|unitCost|1\.25|0\.45/);
  });

  it("staff access resolves from the verified Shopify user id only", () => {
    const access = resolveStaffAccess({ session: { shop: "shop-1" }, sessionToken: { sub: SUB.print_operator } } as any, ENV);
    expect(access.role).toBe("print_operator");
    expect(access.can("recordReprint")).toBe(true);
    expect(access.can("viewFinancials")).toBe(false);
  });
});

/* ============================== FILES ============================== */

describe("FILES — exact file -> item link", () => {
  const items = [{ id: "i1", itemTicket: `${JOB}-01` }, { id: "i2", itemTicket: `${JOB}-02` }];

  it("resolves the item by id, then by exact ticket, never by guess", () => {
    expect(resolveRoutedFileItemId(items, { itemId: "i2" })).toBe("i2");
    expect(resolveRoutedFileItemId(items, { itemTicket: `${JOB}-01` })).toBe("i1");
    expect(resolveRoutedFileItemId(items, { itemId: "other-job-item", itemTicket: `${JOB}-02` })).toBe("i2");
    expect(resolveRoutedFileItemId(items, { itemTicket: JOB })).toBeNull(); // job ticket on a multi-item job proves no item
    expect(resolveRoutedFileItemId(items, {})).toBeNull();
    expect(resolveRoutedFileItemId([items[0]], {})).toBe("i1"); // single-item job
  });

  it("a routed file is recorded with its item; two layers of one item are two rows on the same item", async () => {
    const base = { shop: "shop-1", jobId: "j1", jobTicket: JOB, machine: "mimaki" as const, itemTicket: `${JOB}-01` };
    const cmyk = await recordRoutedPrintFile(db, { ...base, fileHash: HASH_A, originalFileName: "crud_HEATH_F_CMYK.pdf", routedFileName: `${JOB}-01__crud_HEATH_F_CMYK`, itemId: "i1" });
    const gloss = await recordRoutedPrintFile(db, { ...base, fileHash: HASH_B, originalFileName: "crud_HEATH_F_g.pdf", routedFileName: `${JOB}-01__crud_HEATH_F_g` });
    expect([cmyk.result, gloss.result]).toEqual(["created", "created"]);
    expect(h.t.productionJobFile.map((file) => [file.fileName, file.productionJobItemId])).toEqual([
      [`${JOB}-01__crud_HEATH_F_CMYK.pdf`, "i1"],
      [`${JOB}-01__crud_HEATH_F_g.pdf`, "i1"],
    ]);
  });

  it("multi-item job: each file lands on its own item; a retry writes nothing", async () => {
    const other = "c".repeat(64);
    await recordRoutedPrintFile(db, { shop: "shop-1", jobId: "j1", jobTicket: JOB, machine: "mimaki", fileHash: HASH_A, originalFileName: "heath.pdf", routedFileName: `${JOB}-01__heath`, itemTicket: `${JOB}-01` });
    await recordRoutedPrintFile(db, { shop: "shop-1", jobId: "j1", jobTicket: JOB, machine: "mimaki", fileHash: other, originalFileName: "shortcakes.pdf", routedFileName: `${JOB}-02__shortcakes`, itemTicket: `${JOB}-02` });
    const retry = await recordRoutedPrintFile(db, { shop: "shop-1", jobId: "j1", jobTicket: JOB, machine: "mimaki", fileHash: other, originalFileName: "shortcakes.pdf", routedFileName: `${JOB}-02__shortcakes`, itemTicket: `${JOB}-02` });
    expect(retry.result).toBe("unchanged");
    expect(h.t.productionJobFile.map((file) => file.productionJobItemId)).toEqual(["i1", "i2"]);
  });

  it("the routed name keeps the item ticket and the staff file name", () => {
    expect(ripFileBaseName({ ripJobName: `${JOB}-01`, itemTicket: `${JOB}-01`, suggestedFileName: null } as any, "crud_HEATH_F_CMYK.pdf")).toBe(`${JOB}-01__crud_HEATH_F_CMYK`);
    expect(ripFileBaseName({ ripJobName: `${JOB}-01`, itemTicket: `${JOB}-01`, suggestedFileName: null } as any, "crud_HEATH_F_g.pdf")).toBe(`${JOB}-01__crud_HEATH_F_g`);
  });

  it("files expected / received per item, and the board card says who is awaiting files", () => {
    const files = [{ fileType: "print_file", assetSource: "nas", productionJobItemId: "i1", fileName: "x.pdf" }, { fileType: "print_file", assetSource: "reorder_reuse", productionJobItemId: "i2", fileName: "old.pdf" }];
    expect(itemFileState(h.t.productionJobItem[0], files)).toMatchObject({ received: 1, awaiting: false, expected: ["CMYK", "Gloss"] });
    expect(itemFileState(h.t.productionJobItem[1], files)).toMatchObject({ received: 0, awaiting: true }); // a reuse reference is not a received print file
    const card = toBoardCard({ ...h.t.productionJob[0], items: h.t.productionJobItem, files, events: [] });
    expect(card).toMatchObject({ itemCount: 2, awaitingFiles: true, filesLabel: "Awaiting files for 1 of 2 items" });
    expect(JSON.stringify(card)).not.toMatch(/1\.25|unitPrice|unitCost/);
  });

  it("the migration is additive only", () => {
    const sql = readFileSync("prisma/migrations/20261119120000_add_production_lineage/migration.sql", "utf8").replace(/^--.*$/gm, "");
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|ALTER\s+COLUMN|NOT NULL(?!\s+DEFAULT)[^,\n]*ADD|REFERENCES)\b/i);
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      expect(statement, statement.slice(0, 60)).toMatch(/^(ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS "\w+" TEXT|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/);
    }
  });
});

/* ============================== REPRINTS ============================== */

describe("REPRINTS — production runs on the same item", () => {
  it("the reprint quantity is required and never guessed", async () => {
    expect(parseReprintQuantity("")).toMatchObject({ ok: false });
    expect(parseReprintQuantity("0")).toMatchObject({ ok: false });
    expect(parseReprintQuantity("2.5")).toMatchObject({ ok: false });
    expect(parseReprintQuantity("25")).toEqual({ ok: true, quantity: 25 });
    const refused = await post({ intent: "reprintItem", reprintReason: "machine_error" });
    expect(refused.status).toBe(400);
    expect(h.t.productionRun || []).toHaveLength(0);
    expect(h.t.printIntake.every((row) => row.reprintNumber === 0)).toBe(true);
  });

  it("500 ordered + 25 reprinted stays 500 ordered: quantity, price and revenue are untouched", async () => {
    const res = await post({ intent: "reprintItem", reprintReason: "color_quality_issue", reprintQty: "25", chargeType: "internal", reprintNote: "banding" });
    expect(res.body.ok, res.body.message).toBe(true);
    const item = h.t.productionJobItem[0];
    expect(item).toMatchObject({ quantity: 500, unitPrice: 1.25, lastReprintReason: "color_quality_issue", qcResult: null });
    expect(h.t.productionRun.map((run) => [run.runNumber, run.kind, run.quantity, run.chargeType, run.status])).toEqual([
      [1, "original", 500, "customer_paid", "reprinted"],
      [2, "reprint", 25, "internal", "open"],
    ]);
    const summary = itemRunSummary(item, h.t.productionRun);
    expect(summary).toMatchObject({ orderedQuantity: 500, billableQuantity: 500, reprintQuantity: 25, internalReprintQuantity: 25, customerPaidReprintQuantity: 0, reprintCount: 1 });
    expect(h.t.productionJob).toHaveLength(1); // a reprint never creates a job
  });

  it("a two-layer item re-routes BOTH layers under one reprint number, run token at the end", async () => {
    await post({ intent: "reprintItem", reprintReason: "machine_error", reprintQty: "10", chargeType: "internal" });
    expect(h.t.printIntake.map((row) => [row.routedFilename, row.reprintNumber, row.attemptNumber, row.status])).toEqual([
      [`${JOB}-01__crud_HEATH_F_CMYK__P1-A1`, 1, 1, "retry_allowed"],
      [`${JOB}-01__crud_HEATH_F_g__P1-A1`, 1, 1, "retry_allowed"],
    ]);
  });

  it("only the newest revision of a staff file is re-routed; rejected files never are", () => {
    const rows = [
      { id: "a", originalFilename: "f_CMYK.pdf", status: "routed", routedFilename: "x", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
      { id: "b", originalFilename: "f_CMYK.pdf", status: "routed", routedFilename: "x__R2-A1", revisionNumber: 2, reprintNumber: 1, attemptNumber: 1 },
      { id: "c", originalFilename: "f_g.pdf", status: "routed", routedFilename: "y", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
      { id: "d", originalFilename: "old.pdf", status: "rejected", routedFilename: "z", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
    ];
    expect(layersToReroute(rows).map((row) => row.id)).toEqual(["b", "c"]);
    expect(nextReprintNumber(layersToReroute(rows))).toBe(2);
  });

  it("several runs: QC closes the open run, then a second reprint is run 3; a reprint awaiting QC is not doubled", async () => {
    await post({ intent: "reprintItem", reprintReason: "machine_error", reprintQty: "25", chargeType: "internal" });
    expect((await post({ intent: "reprintItem", reprintReason: "machine_error", reprintQty: "5", chargeType: "internal" })).status).toBe(409);
    expect((await post({ intent: "qcItem", qcResult: "pass", qcNote: "" })).body.ok).toBe(true);
    expect(h.t.productionRun[1]).toMatchObject({ runNumber: 2, status: "qc_passed" });
    expect((await post({ intent: "reprintItem", reprintReason: "shipping_damage", reprintQty: "5", runKind: "remake", chargeType: "customer_paid" })).body.ok).toBe(true);
    expect(h.t.productionRun.map((run) => [run.runNumber, run.kind, run.quantity, run.chargeType])).toEqual([[1, "original", 500, "customer_paid"], [2, "reprint", 25, "internal"], [3, "remake", 5, "customer_paid"]]);
    expect(h.t.printIntake.map((row) => row.reprintNumber)).toEqual([2, 2]);
    const summary = itemRunSummary(h.t.productionJobItem[0], h.t.productionRun);
    expect(summary).toMatchObject({ billableQuantity: 500, reprintQuantity: 30, internalReprintQuantity: 25, customerPaidReprintQuantity: 5 });
    expect(h.t.productionJobItem[0]).toMatchObject({ quantity: 500, unitPrice: 1.25 }); // a customer-paid remake charges nothing here
  });

  it("run planning and QC mapping (pure)", () => {
    expect(planReprintRuns([], { quantity: 500, qcResult: "pass" }, { kind: "reprint", quantity: 25 })).toEqual({ original: { runNumber: 1, kind: "original", quantity: 500, status: "qc_passed" }, next: { runNumber: 2, kind: "reprint", quantity: 25, status: "open" } });
    const existing = [{ itemId: "i1", runNumber: 1, kind: "original", quantity: 500, status: "reprinted" }, { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, status: "open" }];
    expect(planReprintRuns(existing, { quantity: 500 }, { kind: "remake", quantity: 5 })).toEqual({ original: null, next: { runNumber: 3, kind: "remake", quantity: 5, status: "open" } });
    expect(openRunOf(existing)?.runNumber).toBe(2);
    expect([runStatusForQc("pass"), runStatusForQc("reprint_required"), runStatusForQc("hold")]).toEqual(["qc_passed", "qc_failed", null]);
  });

  it("roles: the production lead and the owner may reprint; bagger and sales may not", async () => {
    for (const [role, ok] of [["print_operator", true], ["bagger", false], ["sales", false]] as const) {
      h.sub = SUB[role];
      const res = await post({ intent: "reprintItem", itemId: "i2", reprintReason: "machine_error", reprintQty: "3", chargeType: "internal" });
      expect(res.status === 200 && res.body.ok, role).toBe(ok);
    }
  });
});

/* ============================== REORDER ============================== */

describe("REORDER — a new sale with explicit lineage", () => {
  const source = () => ({ item: h.t.productionJobItem[0], job: h.t.productionJob[0] });

  it("the request names the earlier item, a new quantity and the artwork choice", () => {
    expect(parseReorderRequest([])).toMatchObject({ ok: false });
    expect(parseReorderRequest([{ itemId: "i1", quantity: "", artworkMode: "same_artwork" }])).toMatchObject({ ok: false });
    expect(parseReorderRequest([{ itemId: "i1", quantity: "750", artworkMode: "copy" }])).toMatchObject({ ok: false });
    expect(parseReorderRequest([{ itemId: "i1", quantity: "750", artworkMode: "revision" }])).toEqual({ ok: true, lines: [{ itemId: "i1", quantity: 750, artworkMode: "revision" }] });
  });

  it("the earlier selling price is never copied: no current price = provisional, owner approval required", () => {
    const built = buildReorderQuoteDraft([source()] as any, [{ itemId: "i1", quantity: 750, artworkMode: "same_artwork" }], new Map(), "owner@gso.test", "2026-11-19T16:00:00Z");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const line = built.draft.items[0];
    expect(line).toMatchObject({ quantity: "750", unitPrice: "0", unitCost: "0", pricingSource: REORDER_PRICING_REQUIRED, reorderSourceItemId: "i1", reorderArtworkMode: "same_artwork" });
    expect(JSON.parse(line.priceSnapshot).pricingAuthority).toMatchObject({ approved: false });
    expect(JSON.stringify(built.draft)).not.toContain("1.25");
    expect(built.draft.provisionalCount).toBe(1);
  });

  it("a recipe line takes the CURRENT engine price for the NEW quantity", () => {
    const current = { recipeId: "r1", productName: "HEATH pouch", quantity: "750", unitPrice: "0.98", unitCost: "0.31", pricingSource: "tier", priceSnapshot: "{}", costSnapshot: "{}" };
    const built = buildReorderQuoteDraft([source()] as any, [{ itemId: "i1", quantity: 750, artworkMode: "revision" }], new Map([["i1", current]]), "owner@gso.test", "now");
    expect(built.ok && built.draft.items[0]).toMatchObject({ unitPrice: "0.98", quantity: "750", reorderSourceItemId: "i1", reorderArtworkMode: "revision" });
    expect(built.ok && built.draft.provisionalCount).toBe(0);
  });

  it("items of two customers are refused; lineage on save comes from the database row, not the browser", () => {
    const other = { item: { ...h.t.productionJobItem[1], id: "x9" }, job: { ...h.t.productionJob[0], id: "j9", customerName: "Someone Else" } };
    expect(buildReorderQuoteDraft([source(), other] as any, [{ itemId: "i1", quantity: 1, artworkMode: "same_artwork" }, { itemId: "x9", quantity: 1, artworkMode: "same_artwork" }], new Map(), "a", "b")).toMatchObject({ ok: false });
    const stored = [{ id: "q1", reorderSourceItemId: "i1", reorderArtworkMode: "revision" }];
    expect(withStoredReorderLineage({ id: "q1", reorderSourceItemId: "forged", reorderArtworkMode: "same_artwork" } as any, stored)).toMatchObject({ reorderSourceItemId: "i1", reorderArtworkMode: "revision" });
    expect(withStoredReorderLineage({ id: "new", reorderSourceItemId: "forged" } as any, stored)).toMatchObject({ reorderSourceItemId: null, reorderArtworkMode: null });
  });

  it("release creates a NEW master job and NEW item tickets with lineage; same artwork lists the earlier file for reuse; the old job is untouched", async () => {
    await recordRoutedPrintFile(db, { shop: "shop-1", jobId: "j1", jobTicket: JOB, machine: "mimaki", fileHash: HASH_A, originalFileName: "crud_HEATH_F_CMYK.pdf", routedFileName: `${JOB}-01__crud_HEATH_F_CMYK`, itemId: "i1" });
    const oldJob = JSON.stringify([h.t.productionJob[0], h.t.productionJobItem[0], h.t.productionJobItem[1]]);
    const result = await createProductionJobFromSource(db, {
      shop: "shop-1", actor: "owner@gso.test",
      source: { type: "released_transaction", authorizedBy: "owner@gso.test", transactionId: "reorder-release-0001", origin: "agent_proposal", payload: { customerName: "krud Cafe", items: [
        { productTitle: "HEATH pouch", quantity: 750, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "i1", reorderArtworkMode: "same_artwork" },
        { productTitle: "SHORTCAKES pouch", quantity: 300, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "i2", reorderArtworkMode: "revision" },
        { productTitle: "Brand new", quantity: 10, finish: "CMYK", printer: "mimaki", reorderSourceItemId: "not-a-real-item" },
      ] } },
    });
    expect(result.created).toBe(true);
    expect(result.job.id).not.toBe("j1");
    expect(result.job.jobTicket).not.toBe(JOB);
    const items = h.t.productionJobItem.filter((item) => item.jobId === result.job.id);
    expect(items.map((item) => [item.quantity, item.reorderSourceItemId, item.reorderArtworkMode])).toEqual([[750, "i1", "same_artwork"], [300, "i2", "revision"], [10, null, null]]);
    for (const item of items) expect(item.itemTicket).toMatch(new RegExp(`^${result.job.jobTicket}-0\\d$`));
    const reuse = h.t.productionJobFile.filter((file) => file.jobId === result.job.id);
    expect(reuse).toHaveLength(1);
    expect(reuse[0]).toMatchObject({ assetSource: "reorder_reuse", assetRole: "reference", productionJobItemId: items[0].id, fileName: `${JOB}-01__crud_HEATH_F_CMYK.pdf` });
    expect(reuse[0].reusedFromFileId).toBe(h.t.productionJobFile[0].id);
    const lineage = h.t.productionJobEvent.filter((event) => event.jobId === result.job.id && event.eventType === "reorder_lineage_recorded").map((event) => event.message);
    expect(lineage[0]).toContain("SAME ARTWORK");
    expect(lineage[1]).toContain("REORDER WITH REVISION");
    expect(lineage[1]).toContain("New proof approval required");
    expect(JSON.stringify([h.t.productionJob[0], h.t.productionJobItem[0], h.t.productionJobItem[1]])).toBe(oldJob);
    expect(itemFileState(items[0], reuse).awaiting).toBe(true); // a reuse reference is not a received file
    expect(priorItemFiles({ id: items[0].id, itemTicket: items[0].itemTicket }, reuse)).toEqual([]); // a reference is never chained
  });
});

/* ============================== QUICKBOOKS FRAMEWORK ============================== */

describe("STAGED TRANSACTIONS — prepared for review, never a job on their own", () => {
  const invoice = { shop: "shop-1", source: "quickbooks_invoice" as const, externalId: "qb-inv-1270", docNumber: "1270", customerName: "krud Cafe", totalAmount: 3200, balance: 3200, externalStatus: "Unpaid", lines: [{ description: "Qty:128 - 20 designs", quantity: 2560, amount: 3000 }, { description: "Shipping", quantity: 1, amount: 200 }] };
  const staged = () => h.t.stagedTransaction[0];

  it("staging creates no job and maps nothing automatically; staging again refreshes facts only", async () => {
    const first = await stageTransaction(db, invoice);
    expect(first.result).toBe("staged");
    expect(h.t.productionJob).toHaveLength(1);
    expect(normalizeIncomingLines(invoice.lines).every((line) => line.classification === "needs_review" && line.productionItems.length === 0)).toBe(true);
    const again = await stageTransaction(db, { ...invoice, balance: 0, externalStatus: "Paid" });
    expect(again).toEqual({ result: "refreshed", id: first.id });
    expect(h.t.stagedTransaction).toHaveLength(1);
    expect(staged()).toMatchObject({ balance: 0, externalStatus: "Paid", status: "staged" });
    expect(h.t.productionJob).toHaveLength(1); // a paid invoice still releases nothing by itself
  });

  it("an unreviewed line keeps the transaction in review: release is refused and the job service is not called", async () => {
    const { id } = await stageTransaction(db, invoice);
    const createJob = vi.fn();
    expect(releaseReadiness(staged())).toMatchObject({ ok: false });
    const refused = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "owner@gso.test" }, { createJob: createJob as any });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("2 line(s) still need review");
    expect(createJob).not.toHaveBeenCalled();
    expect(staged().status).toBe("staged");
  });

  it("a release needs a person, and calls the canonical job service exactly once", async () => {
    const { id } = await stageTransaction(db, invoice);
    const lines = JSON.parse(staged().lines);
    await saveStagedReview(db, { shop: "shop-1", id, actor: "owner@gso.test", lines: [
      { ...lines[0], classification: "production", productionItems: [{ productTitle: "HEATH pouch", quantity: 128, finish: "CMYK", printer: "mimaki" }, { productTitle: "SHORTCAKES pouch", quantity: 128, finish: "CMYK", printer: "mimaki" }] },
      { ...lines[1], classification: "non_production", productionItems: [] },
    ] });
    const createJob = vi.fn(async () => ({ job: { id: "new-job", jobTicket: "GSO-20261119-0099", items: [{}, {}] }, created: true, reason: "ok" }));
    expect((await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "" }, { createJob: createJob as any })).ok).toBe(false);
    expect(createJob).not.toHaveBeenCalled();
    const released = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "owner@gso.test" }, { createJob: createJob as any });
    expect(released.ok).toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
    const call: any = (createJob.mock.calls[0] as any[])[1];
    expect(call.source).toMatchObject({ type: "released_transaction", authorizedBy: "owner@gso.test", transactionId: id, origin: "quickbooks_invoice" });
    expect(call.source.payload).toMatchObject({ customerName: "krud Cafe", reference: "QuickBooks invoice 1270" });
    expect(call.source.payload.items.map((item: any) => item.productTitle)).toEqual(["HEATH pouch", "SHORTCAKES pouch"]); // the shipping line is not production
    expect(staged()).toMatchObject({ status: "released", releasedJobId: "new-job", releasedBy: "owner@gso.test" });
  });

  it("end to end through the real service: one job, item tickets, and a second release returns the same job", async () => {
    const { id } = await stageTransaction(db, invoice);
    const lines = JSON.parse(staged().lines);
    await saveStagedReview(db, { shop: "shop-1", id, actor: "owner@gso.test", lines: [
      { ...lines[0], classification: "production", productionItems: [{ productTitle: "HEATH pouch", quantity: 128, finish: "CMYK", printer: "mimaki" }] },
      { ...lines[1], classification: "non_production", productionItems: [] },
    ] });
    const first = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "owner@gso.test" });
    expect(first.ok, first.message).toBe(true);
    if (!first.ok) return;
    expect(first.job.quoteId).toBe(`released_${id}`);
    expect(first.job.jobTicket).toMatch(/^GSO-\d{8}-\d{4}$/);
    expect(first.job.items[0].itemTicket).toBe(`${first.job.jobTicket}-01`);
    expect(first.job.items[0].ripJobName).toBe(first.job.items[0].itemTicket);
    const second = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "owner@gso.test" });
    expect(second.ok && second.created).toBe(false);
    expect(second.ok && second.job.id).toBe(first.job.id);
    expect(h.t.productionJob).toHaveLength(2);
  });

  it("no QuickBooks call, release rule or write exists in the framework", () => {
    const lib = readFileSync("app/lib/staged-transaction.server.ts", "utf8");
    const page = readFileSync("app/routes/app.erp.release-queue.tsx", "utf8");
    for (const src of [lib, page]) {
      expect(src).not.toMatch(/fetch\(|intuit\.com|quickbooks\.api|oauth/i);
      expect(src).not.toMatch(/balance\s*(===|<=|<|>)\s*0|externalStatus\s*===/); // no "paid = release" rule is encoded
    }
    // the only job creator anywhere is the canonical service
    for (const file of ["app/lib/staged-transaction.server.ts", "app/routes/app.erp.release-queue.tsx", "app/routes/app.erp.reorder.tsx", "app/lib/reorder.ts", "app/lib/production-run.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/productionJob\.create\(/);
    }
    expect(readFileSync("app/routes/api.print-intake.route-plan.tsx", "utf8")).not.toMatch(/productionJob\.create\(|createProductionJobFromSource/);
  });
});
