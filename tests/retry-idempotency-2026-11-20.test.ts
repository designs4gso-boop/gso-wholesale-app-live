// 2026-11-20 — RETRY / IDEMPOTENCY proof.
//
// Every scenario below calls REAL application code (the central job service,
// the real route actions, the real outbox worker, the real approval engine)
// against an in-memory database double. Nothing touches Prisma, the network,
// Shopify or Slack.
//
// The database double models the three things the code relies on:
//   * pg_advisory_xact_lock — an in-memory mutex per key, held until the
//     transaction settles (so concurrent calls really serialize);
//   * transaction ATOMICITY — a transaction that throws is rolled back (an undo
//     journal). `h.atomic = false` switches that off to show what the code
//     itself guarantees without it;
//   * the unique indexes in prisma/schema.prisma that matter here:
//     ProductionRun(itemId, runNumber), ProductionJob(shop, jobTicket),
//     ProductionJobItem(shop, itemTicket).
//
// A scenario marked `it.fails` is a REAL FINDING in application code: the body
// states the correct behaviour, the comment gives file:line, input, expected
// and actual. The application code is deliberately NOT changed here.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sub: "77055393857",
  shop: "shop-1",
  payload: null as any,
  t: {} as Record<string, any[]>,
  seq: 0,
  writes: [] as string[],
  alerts: [] as string[],
  alertThrows: false,
  atomic: true,
  hook: null as null | ((model: string, method: string, args: any) => void),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: h.shop, isOnline: false, email: "owner@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }),
    webhook: async () => ({ payload: h.payload, shop: h.shop, admin: { graphql: async () => ({ json: async () => ({ data: {} }) }) } }),
  },
  unauthenticated: { admin: async () => ({ session: null }) },
}));

// The Slack production alert is the only outbound call on these paths: replaced, and counted.
vi.mock("../app/lib/production-alert.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    sendProductionAlertSafe: async (job: any) => {
      if (h.alertThrows) throw new Error("alert transport down");
      h.alerts.push(String(job?.id));
      return { sent: false, reason: "test double" };
    },
  };
});

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "gte", "gt", "lt", "lte", "some"]);
  const CHILDREN: Record<string, Record<string, [string, string]>> = {
    productionJob: { items: ["productionJobItem", "jobId"], checklistItems: ["productionJobChecklistItem", "jobId"], events: ["productionJobEvent", "jobId"] },
    quote: { items: ["quoteItem", "quoteId"] },
  };
  const UNIQUE: Record<string, string[][]> = {
    productionRun: [["itemId", "runNumber"]],
    productionJob: [["shop", "jobTicket"]],
    productionJobItem: [["shop", "itemTicket"]],
  };
  const WRITES = new Set(["create", "update", "updateMany", "upsert", "delete", "deleteMany"]);
  const num = (value: any) => (value instanceof Date ? value.getTime() : typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : Number(value));
  const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : (a ?? null) === (b ?? null));
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "AND") return ([] as any[]).concat(value).every((part) => match(row, part));
    if (key === "NOT") return !match(row, value);
    if (key === "job" || key === "items") return true;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value); // compound unique key
      if ("in" in value && !value.in.includes(row[key])) return false;
      if ("not" in value && eq(row[key], value.not)) return false;
      if ("contains" in value && !String(row[key] || "").toLowerCase().includes(String(value.contains).toLowerCase())) return false;
      if ("gte" in value && !(row[key] != null && num(row[key]) >= num(value.gte))) return false;
      if ("gt" in value && !(row[key] != null && num(row[key]) > num(value.gt))) return false;
      if ("lte" in value && !(row[key] != null && num(row[key]) <= num(value.lte))) return false;
      if ("lt" in value && !(row[key] != null && num(row[key]) < num(value.lt))) return false;
      return true;
    }
    return eq(row[key], value);
  });
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const hydrate = (name: string, row: any, args: any) => {
    if (!row) return null;
    const out: any = { ...row };
    const include = args?.include || {};
    if (name === "productionJob" && include.items) out.items = rows("productionJobItem").filter((item) => item.jobId === row.id).map((item) => ({ ...item }));
    if (name === "quote" && include.items) out.items = rows("quoteItem").filter((item) => item.quoteId === row.id).map((item) => ({ ...item }));
    if (name === "productionJobItem" && include.job) { const job = rows("productionJob").find((candidate) => candidate.id === row.jobId); out.job = job ? { ...job } : null; }
    return out;
  };
  const insert = (name: string, data: any, journal: Array<() => void> | null): any => {
    const nested = CHILDREN[name] || {};
    const own: any = {};
    const kids: Array<[[string, string], any[]]> = [];
    for (const [key, value] of Object.entries(data || {})) {
      if (nested[key] && value && typeof value === "object" && "create" in (value as any)) kids.push([nested[key], ([] as any[]).concat((value as any).create)]);
      else own[key] = value;
    }
    for (const fields of UNIQUE[name] || []) {
      if (fields.every((field) => own[field] != null) && rows(name).some((row) => fields.every((field) => row[field] === own[field]))) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (${fields.join(",")})`), { code: "P2002", meta: { target: fields } });
      }
    }
    const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date(), updatedAt: new Date(), ...own };
    rows(name).push(row);
    journal?.push(() => { const list = rows(name); const index = list.indexOf(row); if (index >= 0) list.splice(index, 1); });
    for (const [[child, foreignKey], list] of kids) for (const kid of list) insert(child, { ...kid, [foreignKey]: row.id }, journal);
    return row;
  };
  const amend = (row: any, data: any, journal: Array<() => void> | null) => {
    const before = { ...row };
    journal?.push(() => { for (const key of Object.keys(row)) delete row[key]; Object.assign(row, before); });
    for (const [key, value] of Object.entries(data || {})) row[key] = value && typeof value === "object" && "increment" in (value as any) ? Number(row[key] || 0) + Number((value as any).increment) : value;
    row.updatedAt = new Date();
  };
  const model = (name: string, journal: Array<() => void> | null) => new Proxy({}, {
    get: (_target, method: string) => async (args: any = {}) => {
      if (h.hook) h.hook(name, method, args); // may throw: "the process died here"
      if (WRITES.has(method)) h.writes.push(`${name}.${method}`);
      const list = rows(name);
      const found = list.filter((row) => match(row, args.where));
      if (method === "findFirst" || method === "findUnique") return hydrate(name, found[0], args);
      if (method === "findMany") return found.map((row) => hydrate(name, row, args));
      if (method === "count") return found.length;
      if (method === "create") return hydrate(name, insert(name, args.data, journal), args);
      if (method === "update") { if (found[0]) amend(found[0], args.data, journal); return hydrate(name, found[0], args); }
      if (method === "updateMany") { found.forEach((row) => amend(row, args.data, journal)); return { count: found.length }; }
      if (method === "upsert") { if (found[0]) { amend(found[0], args.update, journal); return hydrate(name, found[0], args); } return hydrate(name, insert(name, args.create, journal), args); }
      return null;
    },
  });
  const locks = new Map<string, Promise<void>>();
  const client = (journal: Array<() => void> | null, held: Array<() => void> | null): any => new Proxy({}, {
    get: (_target, key: string) => {
      if (key === "then") return undefined;
      if (key === "$transaction") return transaction;
      if (key === "$queryRawUnsafe" || key === "$queryRaw" || key === "$executeRawUnsafe") {
        return async (sql: any) => {
          const lock = String(sql).match(/pg_advisory_xact_lock\((-?\d+), (-?\d+)\)/);
          if (!lock || !held) return [];
          const lockKey = `${lock[1]}:${lock[2]}`;
          while (locks.has(lockKey)) await locks.get(lockKey);
          let free!: () => void;
          locks.set(lockKey, new Promise<void>((resolve) => { free = resolve; }));
          held.push(() => { locks.delete(lockKey); free(); });
          return [{ gso_lock: "" }];
        };
      }
      return model(key, journal);
    },
  });
  const transaction = async (work: any) => {
    if (typeof work !== "function") return Promise.all(work);
    const journal: Array<() => void> = [];
    const held: Array<() => void> = [];
    try {
      return await work(client(journal, held));
    } catch (error) {
      if (h.atomic) for (const undo of journal.reverse()) undo(); // ROLLBACK
      throw error;
    } finally {
      for (const release of held) release(); // xact lock released at commit / rollback
    }
  };
  const db = client(null, null);
  return { default: db, db };
});

import db from "../app/db.server";
import { createProductionJobFromSource, recordRoutedPrintFile } from "../app/lib/production-job-source.server";
import { planReprintRuns } from "../app/lib/production-run";
import { parseReorderRequest } from "../app/lib/reorder";
import { decideIntent, proposeIntent, validateIntent } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { processOutboxBatch } from "../app/lib/ops/outbox-worker";
import { readOpsRuntimeConfig } from "../app/lib/ops/runtime-config";
import { _resetWorkerRuntimeForTests, runWorkerOnce } from "../app/lib/ops/worker-runtime.server";
import { decideApproval, listApprovals, submitApproval } from "../app/lib/agent-approvals.server";

const OWNER = "77055393857";
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: OWNER };
const JOB = "GSO-20261119-0042";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const count = (name: string) => (h.t[name] || []).length;
const productionWrites = () => h.writes.filter((write) => /^(productionJob|productionRun|quote|agentReviewQueueItem|printIntake)/.test(write));

// A paid configurator order as the GSO checkout creates it: CUSTOM draft-order
// lines (no variant_id), so the webhook does not hold it for price review.
const bagLine = (id: number, title: string, quantity: number, price: string, color: string) => ({
  id, title, quantity, price,
  properties: [
    { name: "Material", value: "Matte" }, { name: "Finish", value: "Glossy" }, { name: "Production Finish", value: "Spot Gloss" },
    { name: "Bag Color", value: color }, { name: "Sides", value: "Double Sided" }, { name: "Product Family", value: "Stock Bags" }, { name: "Product Type", value: "stock_bag_4x5" },
  ],
});
const paidOrder = (over: Record<string, any> = {}) => ({
  id: 880011, admin_graphql_api_id: "gid://shopify/Order/880011", name: "#2001", note: "", email: "buyer@example.com", phone: "", tags: "",
  customer: { first_name: "Sam", last_name: "Buyer", email: "buyer@example.com" },
  billing_address: { first_name: "Sam", last_name: "Buyer", company: "BuyCo", phone: "555-0100" },
  line_items: [bagLine(1, "Stock Bag 4x5", 1000, "0.55", "Black"), bagLine(2, "Stock Bag 4x5", 500, "0.60", "White")],
  ...over,
});
const fromOrder = (order: any) => createProductionJobFromSource(db, { shop: "shop-1", source: { type: "shopify_order", order }, actor: "test" });

const PAID_QUOTE = { id: "quoteA", shop: "shop-1", status: "paid", customerName: "Jane", company: "JarCo", email: "j@x.com", phone: null, notes: "Quote notes" };
const PAID_QUOTE_ITEM = {
  id: "qi1", quoteId: "quoteA", productName: "150ml Miron jar + lid", variant: null, sku: null, quantity: 500, unitPrice: 9.5, unitCost: 4.1, recipeId: null, recipeName: null,
  selectedFinish: null, selectedAddOnIds: null, notes: null,
  costSnapshot: JSON.stringify({ engine: "14C.2-multilabel-auto-tiers", productBreakdown: { canonicalFamily: "premium-jars", missing: [] } }),
  priceSnapshot: JSON.stringify({ unitPrice: 9.5 }),
};
const fromQuote = () => createProductionJobFromSource(db, { shop: "shop-1", source: { type: "erp_quote", quoteId: "quoteA" }, actor: "test" });

const seedProductionJob = () => {
  h.t.productionJob = [{ id: "j1", shop: "shop-1", jobTicket: JOB, status: "qc", active: true, customerName: "krud Cafe", company: null, email: null, phone: null, actualCostFinalized: false, quoteId: "manual_seed-request-1" }];
  h.t.productionJobItem = [
    { id: "i1", shop: "shop-1", jobId: "j1", itemTicket: `${JOB}-01`, ripJobName: `${JOB}-01`, productTitle: "HEATH pouch", quantity: 500, unitPrice: 1.25, unitCost: 0.4, selectedFinish: "CMYK + Gloss", machineSummary: "Mimaki UCJV300-130", qcResult: null, qcAt: null, lastReprintAt: null, sortOrder: 1 },
    { id: "i2", shop: "shop-1", jobId: "j1", itemTicket: `${JOB}-02`, ripJobName: `${JOB}-02`, productTitle: "SHORTCAKES pouch", quantity: 250, unitPrice: 1.4, unitCost: 0.45, selectedFinish: "CMYK", machineSummary: "Mimaki UCJV300-130", qcResult: null, qcAt: null, lastReprintAt: null, sortOrder: 2 },
  ];
  h.t.printIntake = [
    { id: "pi1", shop: "shop-1", originalFilename: "crud_HEATH_F_CMYK.pdf", fileHashSha256: HASH_A, status: "routed", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-01`, routedFilename: `${JOB}-01__crud_HEATH_F_CMYK`, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, rawParsedHints: null, updatedAt: new Date("2026-11-19T10:00:00Z") },
    { id: "pi2", shop: "shop-1", originalFilename: "crud_HEATH_F_g.pdf", fileHashSha256: HASH_B, status: "routed", matchedProductionJobId: "j1", authoritativeTicket: `${JOB}-01`, routedFilename: `${JOB}-01__crud_HEATH_F_g`, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, rawParsedHints: null, updatedAt: new Date("2026-11-19T10:01:00Z") },
  ];
};

let ordersPaid: any;
let quotesRoute: any;
let productionRoute: any;
beforeAll(async () => {
  ordersPaid = await import("../app/routes/webhooks.orders_paid");
  quotesRoute = await import("../app/routes/app.quotes");
  productionRoute = await import("../app/routes/app.erp.production");
}, 300_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = OWNER;
  h.shop = "shop-1";
  h.payload = null;
  h.t = {};
  h.seq = 0;
  h.writes = [];
  h.alerts = [];
  h.alertThrows = false;
  h.atomic = true;
  h.hook = null;
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const deliverWebhook = async (order: any) => {
  h.payload = order;
  const res: Response = await ordersPaid.action({ request: new Request("https://app.test/webhooks/orders_paid", { method: "POST" }) });
  return { status: res.status, text: await res.text() };
};

/* ===================================================================== *
 * a. DUPLICATE SHOPIFY PAID-ORDER WEBHOOK
 * ===================================================================== */

describe("a. duplicate paid-order webhook -> one job", () => {
  it("service: the same order delivered twice is one job, same items; the second call is created:false and writes nothing", async () => {
    const first = await fromOrder(paidOrder());
    expect(first.created).toBe(true);
    const itemsAfterFirst = JSON.stringify(h.t.productionJobItem);
    const eventsAfterFirst = count("productionJobEvent");
    const checklistAfterFirst = count("productionJobChecklistItem");
    h.writes = [];
    const second = await fromOrder(paidOrder());
    expect(second).toMatchObject({ created: false, reason: "Production job already exists." });
    expect(second.job.id).toBe(first.job.id);
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    expect(h.t.productionJobItem.map((item) => item.itemTicket)).toEqual([`${first.job.jobTicket}-01`, `${first.job.jobTicket}-02`]);
    // cost snapshot (and every other item field) is byte-identical: nothing was rewritten
    expect(JSON.stringify(h.t.productionJobItem)).toBe(itemsAfterFirst);
    expect(h.t.productionJobItem.every((item) => typeof item.costSnapshot === "string" && item.costSnapshot.length > 2)).toBe(true);
    expect(count("productionJobEvent")).toBe(eventsAfterFirst);
    expect(count("productionJobChecklistItem")).toBe(checklistAfterFirst);
    expect(productionWrites()).toEqual([]);
  });

  it("service: THREE concurrent deliveries create exactly one job (advisory lock covers check + create)", async () => {
    const results = await Promise.all([fromOrder(paidOrder()), fromOrder(paidOrder()), fromOrder(paidOrder())]);
    expect(results.map((result) => result.created).sort()).toEqual([false, false, true]);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    expect(h.t.productionJobEvent.filter((event) => event.eventType === "created_from_shopify_order")).toHaveLength(1);
  });

  it("service: a redelivery whose payload CHANGED (edited order) still resolves to the first job and rewrites nothing", async () => {
    const first = await fromOrder(paidOrder());
    const before = JSON.stringify(h.t.productionJobItem);
    const edited = paidOrder({ line_items: [bagLine(1, "Stock Bag 4x5", 9999, "0.10", "Black")] });
    const again = await fromOrder(edited);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(JSON.stringify(h.t.productionJobItem)).toBe(before);
  });

  it("service: the REST id and the GraphQL id of one order are the same source", async () => {
    const first = await fromOrder(paidOrder());
    const restOnly = paidOrder({ admin_graphql_api_id: undefined });
    const again = await fromOrder(restOnly);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(count("productionJob")).toBe(1);
  });

  it("service: a payload with no order identity is refused (it could never be deduplicated)", async () => {
    await expect(fromOrder(paidOrder({ id: undefined, admin_graphql_api_id: undefined }))).rejects.toThrow(/no stable order identity/);
    expect(count("productionJob")).toBe(0);
  });

  it("REAL ROUTE webhooks.orders_paid: delivered twice -> one job, one alert, nothing held for review, second delivery writes nothing", async () => {
    const first = await deliverWebhook(paidOrder());
    expect(first).toEqual({ status: 200, text: "Production job created from configurator order." });
    const itemsAfterFirst = JSON.stringify(h.t.productionJobItem);
    h.writes = [];
    const second = await deliverWebhook(paidOrder());
    expect(second).toEqual({ status: 200, text: "Production job already exists." });
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    expect(JSON.stringify(h.t.productionJobItem)).toBe(itemsAfterFirst);
    expect(h.alerts).toHaveLength(1);
    expect(count("agentReviewQueueItem")).toBe(0);
    expect(productionWrites()).toEqual([]);
  });

  it("REAL ROUTE webhooks.orders_paid: two CONCURRENT deliveries -> one job, one alert", async () => {
    const [one, two] = await Promise.all([deliverWebhook(paidOrder()), deliverWebhook(paidOrder())]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.text, two.text].sort()).toEqual(["Production job already exists.", "Production job created from configurator order."]);
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    expect(h.alerts).toHaveLength(1);
  });

  it("REAL ROUTE webhooks.orders_paid: the job is committed, the step after it fails, Shopify redelivers -> still one job", async () => {
    h.alertThrows = true; // the post-create trail throws after the job is committed
    expect((await deliverWebhook(paidOrder())).status).toBe(200);
    h.alertThrows = false;
    expect((await deliverWebhook(paidOrder())).text).toBe("Production job already exists.");
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    // boundary: the redelivery is created:false, so the alert that failed the first time is NOT sent again
    expect(h.alerts).toHaveLength(0);
  });
});

/* ===================================================================== *
 * b. DUPLICATE REORDER SUBMISSION
 * ===================================================================== */

describe("b. duplicate reorder submission (Quotes action intent createReorderQuote)", () => {
  const reorderPayload = { intent: "createReorderQuote", lines: [{ itemId: "i1", quantity: "750", artworkMode: "same_artwork" }] };
  const postReorder = async (payload: unknown = reorderPayload) => {
    const res: Response = await quotesRoute.action({ request: new Request("https://app.test/app/quotes", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }) });
    return { status: res.status, body: await res.json() };
  };
  beforeEach(seedProductionJob);

  it("one submission: one DRAFT quote with lineage, no production job, the earlier job untouched", async () => {
    const jobBefore = JSON.stringify(h.t.productionJob);
    const itemsBefore = JSON.stringify(h.t.productionJobItem);
    const res = await postReorder();
    expect(res.body).toMatchObject({ ok: true, intent: "createReorderQuote" });
    expect(count("quote")).toBe(1);
    expect(h.t.quote[0]).toMatchObject({ status: "draft", shop: "shop-1" });
    expect(h.t.quoteItem).toHaveLength(1);
    expect(h.t.quoteItem[0]).toMatchObject({ quoteId: res.body.quoteId, reorderSourceItemId: "i1", reorderArtworkMode: "same_artwork", quantity: 750, unitPrice: 0 });
    expect(JSON.stringify(h.t.productionJob)).toBe(jobBefore);
    expect(JSON.stringify(h.t.productionJobItem)).toBe(itemsBefore);
    expect(count("productionRun")).toBe(0);
  });

  it("since 2026-11-20 the form sends one requestId per submission (the line parser still keeps only itemId / quantity / artworkMode)", () => {
    const parsed = parseReorderRequest([{ itemId: "i1", quantity: "750", artworkMode: "same_artwork", requestId: "req-12345678" }]);
    expect(parsed).toEqual({ ok: true, lines: [{ itemId: "i1", quantity: 750, artworkMode: "same_artwork" }] });
    const client = readFileSync("app/routes/app.erp.reorder.tsx", "utf8");
    expect(client).toContain('fetcher.submit({ intent: "createReorderQuote", lines, requestId }');
  });

  // DEFECT (real finding, application code NOT changed).
  //   Where:    app/routes/app.quotes.tsx:1730-1769 (intent createReorderQuote); the create is the bare
  //             `db.quote.create` at :1748. app/routes/app.erp.reorder.tsx:71 submits `{ intent, lines }` only.
  //   Input:    the SAME JSON body POSTed twice (double click, a retried request after a timeout, a resent form):
  //             { intent: "createReorderQuote", lines: [{ itemId: "i1", quantity: "750", artworkMode: "same_artwork" }] }
  //   Expected: one draft reorder quote; the second POST resolves to the first quote.
  //   Actual:   TWO draft quotes (two Quote rows, two QuoteItem rows, both pointing at the same earlier item).
  //             There is no requestId, no idempotency key, no lock and no duplicate lookup on this path.
  //   Blast radius: quotes only. No ProductionJob / ProductionRun is created here, and each quote must still be
  //             paid and released separately — but both drafts are valid, so both CAN be sent, paid and produced.
  it("FIXED 2026-11-20: the same reorder POSTed twice creates ONE draft quote", async () => {
    const first = await postReorder();
    const second = await postReorder();
    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    expect(count("quote")).toBe(1);
    expect(second.body.quoteId).toBe(first.body.quoteId);
  });

  it("even duplicated, a reorder submission never creates a production job, item or run", async () => {
    await Promise.all([postReorder(), postReorder()]);
    expect(count("productionJob")).toBe(1);
    expect(count("productionJobItem")).toBe(2);
    expect(count("productionRun")).toBe(0);
    expect(h.t.quote.every((quote) => quote.status === "draft")).toBe(true);
  });
});

/* ===================================================================== *
 * c. OUTBOX WORKER RETRY
 * ===================================================================== */

describe("c. outbox worker retry", () => {
  const cfg = readOpsRuntimeConfig({});
  const T0 = new Date("2026-11-20T08:00:00Z");
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  /** "The process died": from now on no outbox / intent write succeeds, exactly as after a crash. */
  const killable = (repos: any) => {
    const state = { dead: false };
    for (const [target, methods] of [[repos.outbox, ["markCompleted", "markFailed"]], [repos.intents, ["save", "appendAudit"]]] as Array<[any, string[]]>) {
      for (const method of methods) {
        const real = target[method].bind(target);
        target[method] = async (...args: any[]) => { if (state.dead) throw new Error("process died"); return real(...args); };
      }
    }
    return state;
  };
  const approvedInternalIntent = async (repos: any, key: string) => {
    const proposed = await proposeIntent(repos.intents, { actionType: "create_review_queue_item", agentId: "lead_manager", entityType: "lead", entityId: "L1", reason: "t", idempotencyKey: key, now: T0 });
    if (!proposed.ok) throw new Error(proposed.reason);
    const validated = await validateIntent(repos.intents, proposed.intent.id, undefined, T0);
    expect(validated.ok && validated.intent.status).toBe("APPROVED");
    return proposed.intent.id;
  };

  it("a message that fails, then is retried, applies its effect ONCE and is never executed again", async () => {
    const repos = createMemoryRepositories();
    let calls = 0;
    let effects = 0;
    const handlers = { "test.effect": async () => { calls += 1; if (calls === 1) throw new Error("transient failure"); effects += 1; return { externalReference: "fx:1" }; } };
    const { message } = await repos.outbox.enqueue({ idempotencyKey: "retry-1", type: "test.effect", payload: {}, now: T0 });
    const failed = await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: T0 });
    expect(failed.retried).toEqual([message.id]);
    expect(effects).toBe(0);
    expect((await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: new Date(T0.getTime() + 10_000) })).claimed).toBe(0); // backoff not elapsed
    const retried = await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: at(1) });
    expect(retried.completed).toEqual([message.id]);
    expect(effects).toBe(1);
    for (const minutes of [2, 30, 600]) expect((await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: at(minutes) })).claimed).toBe(0);
    expect({ calls, effects }).toEqual({ calls: 2, effects: 1 });
    expect(await repos.outbox.get(message.id)).toMatchObject({ status: "COMPLETED", attempts: 2, externalReference: "fx:1" });
  });

  it("the same idempotencyKey enqueued twice (and again after completion) is ONE message, executed once", async () => {
    const repos = createMemoryRepositories();
    let effects = 0;
    const handlers = { "test.effect": async () => { effects += 1; return {}; } };
    const first = await repos.outbox.enqueue({ idempotencyKey: "same-key", type: "test.effect", payload: { n: 1 }, now: T0 });
    const second = await repos.outbox.enqueue({ idempotencyKey: "same-key", type: "test.effect", payload: { n: 2 }, now: T0 });
    expect([first.created, second.created]).toEqual([true, false]);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.payload).toEqual({ n: 1 }); // the first payload wins; the duplicate is discarded
    expect(await repos.outbox.list()).toHaveLength(1);
    await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: T0 });
    const afterCompletion = await repos.outbox.enqueue({ idempotencyKey: "same-key", type: "test.effect", payload: {}, now: at(5) });
    expect(afterCompletion).toMatchObject({ created: false, message: { status: "COMPLETED" } });
    await processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: at(6) });
    expect(effects).toBe(1);
  });

  it("two workers running at the same moment never both claim one message", async () => {
    const repos = createMemoryRepositories();
    let effects = 0;
    const handlers = { "test.effect": async () => { await Promise.resolve(); effects += 1; return {}; } };
    await repos.outbox.enqueue({ idempotencyKey: "race-1", type: "test.effect", payload: {}, now: T0 });
    const [a, b] = await Promise.all([processOutboxBatch(repos, cfg, handlers, { workerId: "wa", now: T0 }), processOutboxBatch(repos, cfg, handlers, { workerId: "wb", now: T0 })]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(effects).toBe(1);
  });

  it("the in-process trigger refuses an overlapping batch (busy) instead of running two", async () => {
    _resetWorkerRuntimeForTests();
    const repos = createMemoryRepositories();
    let effects = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const handlers = { "test.effect": async () => { await gate; effects += 1; return {}; } };
    await repos.outbox.enqueue({ idempotencyKey: "busy-1", type: "test.effect", payload: {}, now: T0 });
    const running = runWorkerOnce(repos, cfg, handlers, { now: T0 });
    expect(await runWorkerOnce(repos, cfg, handlers, { now: T0 })).toEqual({ ok: false, reason: "busy" });
    finish();
    expect(await running).toMatchObject({ ok: true, report: { claimed: 1 } });
    expect(effects).toBe(1);
    _resetWorkerRuntimeForTests();
  });

  it("a worker that claims a message and dies BEFORE the handler: reclaimed after the stale window, executed once", async () => {
    const repos = createMemoryRepositories();
    let effects = 0;
    const handlers = { "test.effect": async () => { effects += 1; return {}; } };
    const { message } = await repos.outbox.enqueue({ idempotencyKey: "dead-1", type: "test.effect", payload: {}, now: T0 });
    expect(await repos.outbox.claim("worker-that-dies", T0, 10)).toHaveLength(1); // claimed, then silence
    const early = await processOutboxBatch(repos, cfg, handlers, { workerId: "w2", now: at(5) });
    expect({ claimed: early.claimed, released: early.releasedStale, effects }).toEqual({ claimed: 0, released: 0, effects: 0 });
    const late = await processOutboxBatch(repos, cfg, handlers, { workerId: "w2", now: at(11) });
    expect({ released: late.releasedStale, completed: late.completed }).toEqual({ released: 1, completed: [message.id] });
    expect(effects).toBe(1);
  });

  // THE EXACT GUARANTEE for a plain (not intent-bound) message: AT-LEAST-ONCE.
  // The handler ran and succeeded, the process died before markCompleted. The row is still PROCESSING, so after
  // the stale window (10 min, outbox-worker.ts:68) it is released and the handler RUNS AGAIN. Nothing in the
  // worker remembers that the first run succeeded; the only protection is a handler that is itself idempotent
  // (slack.post passes `outbox:<idempotencyKey>` to the Slack client; ops.noop has no effect).
  it("GUARANTEE (plain message): handler succeeded, worker died before completion -> the handler runs a SECOND time on reclaim", async () => {
    const repos = createMemoryRepositories();
    const life = killable(repos);
    let effects = 0;
    const handlers = { "test.effect": async () => { effects += 1; life.dead = true; return {}; } };
    const { message } = await repos.outbox.enqueue({ idempotencyKey: "dead-2", type: "test.effect", payload: {}, now: T0 });
    await expect(processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: T0 })).rejects.toThrow("process died");
    expect(await repos.outbox.get(message.id)).toMatchObject({ status: "PROCESSING", claimedBy: "w1" });
    expect(effects).toBe(1);
    life.dead = false; // a new process
    const handlersAfterRestart = { "test.effect": async () => { effects += 1; return {}; } };
    expect((await processOutboxBatch(repos, cfg, handlersAfterRestart, { workerId: "w2", now: at(5) })).claimed).toBe(0); // not double-run inside the stale window
    const reclaimed = await processOutboxBatch(repos, cfg, handlersAfterRestart, { workerId: "w2", now: at(11) });
    expect(reclaimed.completed).toEqual([message.id]);
    expect(effects).toBe(2); // at-least-once, NOT exactly-once
  });

  // THE EXACT GUARANTEE for an INTENT-BOUND message: AT-MOST-ONCE. The intent is moved to COMPLETED by the
  // intent engine before the outbox row is; a reclaimed message whose intent is COMPLETED is closed without
  // calling the handler (outbox-worker.ts:80).
  it("GUARANTEE (intent-bound): handler succeeded, worker died before completion -> NOT executed again on reclaim", async () => {
    const repos = createMemoryRepositories();
    const intentId = await approvedInternalIntent(repos, "intent-dead-1");
    const life = killable(repos);
    let effects = 0;
    const handlers = { "review.queue": async () => { effects += 1; return { externalReference: "queue:1" }; } };
    const realMarkCompleted = (repos.outbox as any).markCompleted;
    (repos.outbox as any).markCompleted = async (...args: any[]) => { life.dead = true; return realMarkCompleted(...args); }; // dies exactly here
    const { message } = await repos.outbox.enqueue({ idempotencyKey: "intent-msg-1", type: "review.queue", payload: {}, intentId, now: T0 });
    await expect(processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: T0 })).rejects.toThrow("process died");
    expect((await repos.intents.getById(intentId))?.status).toBe("COMPLETED");
    expect((await repos.outbox.get(message.id))?.status).toBe("PROCESSING");
    life.dead = false;
    (repos.outbox as any).markCompleted = realMarkCompleted;
    const reclaimed = await processOutboxBatch(repos, cfg, handlers, { workerId: "w2", now: at(11) });
    expect(reclaimed.skipped).toEqual([{ id: message.id, reason: "intent already completed" }]);
    expect(effects).toBe(1);
    expect(await repos.outbox.get(message.id)).toMatchObject({ status: "COMPLETED", externalReference: "queue:1" });
  });

  it("GUARANTEE (intent-bound): worker died MID-handler -> the intent stays EXECUTING and the handler is never called again", async () => {
    const repos = createMemoryRepositories();
    const intentId = await approvedInternalIntent(repos, "intent-dead-2");
    const life = killable(repos);
    let calls = 0;
    const handlers = { "review.queue": async () => { calls += 1; life.dead = true; throw new Error("killed mid-handler"); } };
    const { message } = await repos.outbox.enqueue({ idempotencyKey: "intent-msg-2", type: "review.queue", payload: {}, intentId, now: T0 });
    await expect(processOutboxBatch(repos, cfg, handlers, { workerId: "w1", now: T0 })).rejects.toThrow("process died");
    expect((await repos.intents.getById(intentId))?.status).toBe("EXECUTING");
    life.dead = false;
    for (const minutes of [11, 60, 120, 180, 240, 300, 360, 420]) await processOutboxBatch(repos, cfg, handlers, { workerId: "w2", now: at(minutes) });
    expect(calls).toBe(1);
    const stuck = await repos.outbox.get(message.id);
    expect(stuck?.status).not.toBe("COMPLETED");
    expect(stuck?.lastError).toMatch(/intent is EXECUTING/);
    expect((await repos.intents.getById(intentId))?.status).toBe("EXECUTING"); // needs a person; never auto-resumed
  });
});

/* ===================================================================== *
 * d. RESTART MID-PROCESSING
 * ===================================================================== */

describe("d-i. job creation interrupted, then retried with the same source", () => {
  const crashOnce = (model: string, method: string) => {
    let fired = false;
    h.hook = (name, op) => { if (!fired && name === model && op === method) { fired = true; throw new Error("process killed mid-transaction"); } };
  };
  beforeEach(() => {
    h.t.quote = [{ ...PAID_QUOTE }];
    h.t.quoteItem = [{ ...PAID_QUOTE_ITEM }];
  });

  it("killed AFTER the job row is written, inside the transaction: rolled back; the retry creates the one and only job", async () => {
    crashOnce("productionJobFile", "create"); // job + items + checklist + event are already written at this point
    await expect(fromQuote()).rejects.toThrow("process killed mid-transaction");
    expect({ jobs: count("productionJob"), items: count("productionJobItem"), checklist: count("productionJobChecklistItem"), events: count("productionJobEvent"), files: count("productionJobFile") })
      .toEqual({ jobs: 0, items: 0, checklist: 0, events: 0, files: 0 });
    expect(h.t.quote[0]).toMatchObject({ status: "paid", notes: "Quote notes" }); // the quote did not move either
    const retry = await fromQuote();
    expect(retry.created).toBe(true);
    const again = await fromQuote();
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(retry.job.id);
    expect({ jobs: count("productionJob"), items: count("productionJobItem"), files: count("productionJobFile") }).toEqual({ jobs: 1, items: 1, files: 1 });
    expect(h.t.productionJobEvent.filter((event) => event.eventType === "created_from_quote")).toHaveLength(1);
    expect(h.t.quote[0].status).toBe("production");
    expect(h.t.quote[0].notes.match(/\[GSO\] Production job /g)).toHaveLength(1);
  });

  it("killed AFTER commit (the caller never got the answer): the retry returns the same job, created:false", async () => {
    const lost = await fromQuote(); // committed; pretend the response never arrived
    const retry = await fromQuote();
    expect(retry).toMatchObject({ created: false, reason: "Production job already exists." });
    expect(retry.job.id).toBe(lost.job.id);
    expect({ jobs: count("productionJob"), items: count("productionJobItem"), files: count("productionJobFile") }).toEqual({ jobs: 1, items: 1, files: 1 });
  });

  it("a retry racing the first attempt (two concurrent conversions) is one job", async () => {
    const results = await Promise.all([fromQuote(), fromQuote()]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect({ jobs: count("productionJob"), items: count("productionJobItem"), files: count("productionJobFile") }).toEqual({ jobs: 1, items: 1, files: 1 });
  });

  // BOUNDARY, stated precisely: the idempotency gate is `productionJob.findFirst({ shop, quoteId })`
  // (production-job-source.server.ts:1176). It only knows whether the JOB ROW exists. "No second job / no second
  // items" therefore holds even on a store with no rollback — but completing a half-written job does NOT: that
  // part is supplied entirely by the database transaction (Postgres in production), not by the service.
  it("BOUNDARY: without transaction rollback a retry still never duplicates the job or items, but the half-written job is not completed", async () => {
    h.atomic = false;
    crashOnce("productionJobFile", "create");
    await expect(fromQuote()).rejects.toThrow("process killed mid-transaction");
    expect({ jobs: count("productionJob"), items: count("productionJobItem") }).toEqual({ jobs: 1, items: 1 });
    const retry = await fromQuote();
    expect(retry.created).toBe(false);
    expect({ jobs: count("productionJob"), items: count("productionJobItem") }).toEqual({ jobs: 1, items: 1 });
    expect(count("productionJobFile")).toBe(0); // the proof-sheet row is never written by the retry
    expect(h.t.quote[0].status).toBe("paid"); // and the quote never moves to production
  });
});

describe("d-ii. a reprint request replayed (real route action, intent reprintItem)", () => {
  const reprintForm = { intent: "reprintItem", jobId: "j1", itemId: "i1", reprintReason: "machine_error", reprintQty: "10", chargeType: "internal" };
  const postReprint = async () => {
    const res: Response = await productionRoute.action({ request: new Request("https://app.test/app/erp/production", { method: "POST", body: new URLSearchParams(reprintForm) }) });
    return { status: res.status, body: await res.json() };
  };
  const runsOf = () => (h.t.productionRun || []).filter((run) => run.itemId === "i1").map((run) => [run.runNumber, run.kind, run.quantity]);
  beforeEach(seedProductionJob);

  it("the same request replayed: 409, no second run, layers not re-numbered, no extra events, no job created", async () => {
    const first = await postReprint();
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(runsOf()).toEqual([[1, "original", 500], [2, "reprint", 10]]);
    const intakeAfterFirst = JSON.stringify(h.t.printIntake);
    const eventsAfterFirst = count("productionJobEvent");
    h.writes = [];
    const replay = await postReprint();
    expect(replay.status).toBe(409);
    expect(replay.body.ok).toBe(false);
    expect(replay.body.message).toMatch(/already recorded/);
    expect(runsOf()).toEqual([[1, "original", 500], [2, "reprint", 10]]);
    expect(JSON.stringify(h.t.printIntake)).toBe(intakeAfterFirst);
    expect(count("productionJobEvent")).toBe(eventsAfterFirst);
    expect(productionWrites()).toEqual([]);
    expect(count("productionJob")).toBe(1);
    expect(h.t.productionJobItem[0].quantity).toBe(500);
  });

  it("two CONCURRENT identical requests: exactly one is recorded (the conditional claim on lastReprintAt)", async () => {
    const results = await Promise.all([postReprint(), postReprint()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(runsOf()).toEqual([[1, "original", 500], [2, "reprint", 10]]);
    expect(h.t.printIntake.map((row) => row.reprintNumber)).toEqual([1, 1]);
    expect(h.t.productionJobEvent.filter((event) => event.eventType === "production_reprint_requested")).toHaveLength(1);
  });

  it("backstop: two planners that read the same runs plan the SAME run numbers, and the schema makes (itemId, runNumber) unique", async () => {
    const item = { quantity: 500, qcResult: null };
    const a = planReprintRuns([], item, { kind: "reprint", quantity: 10 });
    const b = planReprintRuns([], item, { kind: "reprint", quantity: 10 });
    expect([a.original?.runNumber, a.next.runNumber]).toEqual([1, 2]);
    expect(b).toEqual(a);
    const schema = readFileSync("prisma/schema.prisma", "utf8").replace(/\r\n/g, "\n");
    const runModel = schema.slice(schema.indexOf("model ProductionRun {"), schema.indexOf("}", schema.indexOf("model ProductionRun {")));
    expect(runModel).toContain("@@unique([itemId, runNumber])");
    // the same pair written twice is refused by the store (the double models that index)
    await (db as any).productionRun.create({ data: { shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 2, kind: "reprint", quantity: 10 } });
    await expect((db as any).productionRun.create({ data: { shop: "shop-1", jobId: "j1", itemId: "i1", runNumber: 2, kind: "reprint", quantity: 10 } })).rejects.toMatchObject({ code: "P2002" });
  });

  // WHAT DOES NOT PREVENT IT, stated precisely: the reprint form carries NO request id. The only replay guard is
  // "this item's last reprint has not been QC'd yet" (app.erp.production.tsx:1582) plus the conditional claim on
  // lastReprintAt (:1631-1635). Once QC is recorded on the reprinted piece, the SAME form posted again is
  // indistinguishable from a new, intentional reprint: it creates the next run and resets QC again.
  it("BOUNDARY: once QC is recorded, the identical request posted again is a NEW run (no request id on the form)", async () => {
    await postReprint();
    Object.assign(h.t.productionJobItem[0], { qcResult: "pass", qcBy: "QC Person", qcAt: new Date(Date.now() + 60_000) });
    const later = await postReprint();
    expect(later.status).toBe(200);
    expect(runsOf()).toEqual([[1, "original", 500], [2, "reprint", 10], [3, "reprint", 10]]);
    expect(h.t.productionJobItem[0].qcResult).toBeNull();
    expect(count("productionJob")).toBe(1); // still never a second job
  });
});

describe("d-iii. recordRoutedPrintFile called twice for the same file hash", () => {
  const report = (over: Record<string, any> = {}) => recordRoutedPrintFile(db, {
    shop: "shop-1", jobId: "j1", jobTicket: JOB, fileHash: HASH_A, originalFileName: "crud_HEATH_F_CMYK.pdf", routedFileName: `${JOB}-01__crud_HEATH_F_CMYK`, machine: "mimaki", itemTicket: `${JOB}-01`, ...over,
  });
  const printFiles = () => (h.t.productionJobFile || []).filter((file) => file.fileType === "print_file");
  beforeEach(seedProductionJob);

  it("the same report twice writes ONE ProductionJobFile; the second is 'unchanged' and writes nothing", async () => {
    const first = await report();
    h.writes = [];
    const second = await report();
    expect([first.result, second.result]).toEqual(["created", "unchanged"]);
    expect(second.fileId).toBe(first.fileId);
    expect(printFiles()).toHaveLength(1);
    expect(printFiles()[0]).toMatchObject({ sourceRef: HASH_A, productionJobItemId: "i1", assetSource: "nas" });
    expect(h.writes).toEqual([]);
  });

  it("three CONCURRENT reports of one file: one row, exactly one 'created'", async () => {
    const results = await Promise.all([report(), report(), report()]);
    expect(results.map((result) => result.result).sort()).toEqual(["created", "unchanged", "unchanged"]);
    expect(printFiles()).toHaveLength(1);
  });

  it("the hash is case-insensitive; a re-delivery under a new routed name updates the ONE row; another file is its own row", async () => {
    const first = await report();
    expect((await report({ fileHash: HASH_A.toUpperCase() })).result).toBe("unchanged");
    const renamed = await report({ routedFileName: `${JOB}-01__crud_HEATH_F_CMYK__A2` });
    expect(renamed).toEqual({ result: "updated", fileId: first.fileId });
    expect(printFiles()).toHaveLength(1);
    expect((await report({ fileHash: HASH_B, originalFileName: "crud_HEATH_F_g.pdf", routedFileName: `${JOB}-01__crud_HEATH_F_g` })).result).toBe("created");
    expect(printFiles()).toHaveLength(2);
  });

  it("the row is keyed per job: the same file on another job is a separate record, never moved", async () => {
    h.t.productionJob.push({ id: "j2", shop: "shop-1", jobTicket: "GSO-20261119-0043", status: "new", active: true });
    await report();
    await report({ jobId: "j2", jobTicket: "GSO-20261119-0043", itemTicket: null });
    expect(printFiles().map((file) => file.jobId).sort()).toEqual(["j1", "j2"]);
  });
});

describe("d-iv. an approval decided twice (agent-approvals.server.ts)", () => {
  const owner = { userId: "1", actor: "Owner", role: "owner" };
  const manager = { userId: "2", actor: "Manager", role: "manager" };
  const proposal = (over: Record<string, unknown> = {}) => ({
    shop: "shop-1", actionType: "suggest_lead_assignment", entityType: "crm_lead", entityId: "lead-1", payload: { staffName: "Dana", staffId: "3" },
    reason: "Dana handles pouch accounts", idempotencyKey: "assign-1", proposedBy: { type: "agent" as const, id: "lead_manager" }, ...over,
  });
  const assignedEvents = () => (h.t.crmLeadEvent || []).filter((event) => event.event === "assigned");
  beforeEach(() => { h.t.crmLead = [{ id: "lead-1", shop: "shop-1", status: "new" }]; });

  it("the same proposal submitted twice (and concurrently) is ONE approval intent", async () => {
    const intents = createMemoryRepositories().intents;
    const first: any = await submitApproval(intents, proposal());
    const again: any = await submitApproval(intents, proposal());
    expect([first.duplicate, again.duplicate]).toEqual([false, true]);
    expect(again.intent.id).toBe(first.intent.id);
    expect(await listApprovals(intents, "shop-1")).toHaveLength(1);
    const other = createMemoryRepositories().intents;
    const raced: any[] = await Promise.all([submitApproval(other, proposal()), submitApproval(other, proposal())]);
    expect(new Set(raced.map((result) => result.intent?.id)).size).toBe(1);
    expect(await listApprovals(other, "shop-1")).toHaveLength(1);
  });

  it("approved twice, one after the other: applied ONCE", async () => {
    const intents = createMemoryRepositories().intents;
    const { intent }: any = await submitApproval(intents, proposal());
    const approve = (approver: any) => decideApproval(intents, db, { shop: "shop-1", id: intent.id, decision: "approve", approver });
    expect(await approve(manager)).toMatchObject({ ok: true, status: "COMPLETED" });
    h.writes = [];
    expect(await approve(manager)).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(await approve(owner)).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(assignedEvents()).toHaveLength(1);
    expect(h.writes).toEqual([]);
    expect(h.t.crmLead[0]).toMatchObject({ assignedStaffName: "Dana", status: "assigned" });
    const audit = await intents.listAudit(intent.id);
    expect(audit.filter((row: any) => row.event === "approved")).toHaveLength(1);
    expect(audit.filter((row: any) => row.event === "completed")).toHaveLength(1);
  });

  it("decided twice with DIFFERENT answers: the first decision stands, the second changes nothing", async () => {
    const intents = createMemoryRepositories().intents;
    const approved: any = await submitApproval(intents, proposal());
    await decideApproval(intents, db, { shop: "shop-1", id: approved.intent.id, decision: "approve", approver: owner });
    expect((await decideApproval(intents, db, { shop: "shop-1", id: approved.intent.id, decision: "reject", approver: owner, comment: "changed my mind" })).ok).toBe(false);
    expect((await intents.getById(approved.intent.id))?.status).toBe("COMPLETED");
    const rejected: any = await submitApproval(intents, proposal({ idempotencyKey: "assign-2" }));
    const reject = () => decideApproval(intents, db, { shop: "shop-1", id: rejected.intent.id, decision: "reject", approver: owner, comment: "Dana is out" });
    expect(await reject()).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(await reject()).toMatchObject({ ok: true, status: "CANCELLED" });
    expect((await decideApproval(intents, db, { shop: "shop-1", id: rejected.intent.id, decision: "approve", approver: owner })).ok).toBe(false);
    expect(assignedEvents()).toHaveLength(1);
    expect((await intents.listAudit(rejected.intent.id)).filter((row: any) => row.event === "rejected")).toHaveLength(1);
  });

  // DEFECT (real finding, application code NOT changed).
  //   Where:    app/lib/ops/action-intents.ts:301-312 (executeIntent) and :243-259 (decideIntent), reached from
  //             app/lib/agent-approvals.server.ts:117-120 (decideApproval).
  //   Input:    the SAME approve decision for one AWAITING_APPROVAL intent issued twice AT THE SAME TIME
  //             (a double click, or two people approving together): Promise.all([approve, approve]).
  //   Expected: applied once — one "approved" audit row, one "completed" audit row, ONE lead "assigned" event.
  //   Actual:   applied TWICE — both callers read APPROVED before either writes EXECUTING, so both run the
  //             executor: two "assigned" lead events, two "approved" and two "completed" audit rows.
  //   Why:      the status change is read-then-write with no compare-and-set. The repository `save` is an
  //             unconditional write (memory: Map.set; prisma-repositories.server.ts:65 is an upsert by id), so
  //             the APPROVED -> EXECUTING step is not a claim.
  //   Blast radius today: the two internal actions (lead assignee, lead follow-up date) set the same value twice,
  //             so the lead ends up correct; the damage is duplicate history / audit rows. Sequential replays
  //             (the test above) are safe.
  it("FIXED 2026-11-20: the same approval decided twice CONCURRENTLY applies once", async () => {
    const intents = createMemoryRepositories().intents;
    const { intent }: any = await submitApproval(intents, proposal());
    const approve = () => decideApproval(intents, db, { shop: "shop-1", id: intent.id, decision: "approve", approver: manager });
    const results = await Promise.all([approve(), approve()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await intents.getById(intent.id))?.status).toBe("COMPLETED");
    expect(assignedEvents()).toHaveLength(1);
    expect((await intents.listAudit(intent.id)).filter((row: any) => row.event === "completed")).toHaveLength(1);
  });

  it("an agent or system actor can never be the one who decides, however many times it tries", async () => {
    const intents = createMemoryRepositories().intents;
    const { intent }: any = await submitApproval(intents, proposal());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await decideIntent(intents, intent.id, "APPROVE", { type: "agent", id: "lead_manager", role: "owner" } as any)).ok).toBe(false);
    }
    expect((await intents.getById(intent.id))?.status).toBe("AWAITING_APPROVAL");
    expect(assignedEvents()).toHaveLength(0);
  });
});
