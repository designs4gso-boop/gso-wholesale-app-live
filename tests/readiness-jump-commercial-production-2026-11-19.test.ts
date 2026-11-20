// 2026-11-19 (night) — second half of the readiness jump:
// reorder picker on Release, QuickBooks read-only boundary, storefront cost
// snapshot, run cost accounting, fulfilment state + guarded Shopify boundary,
// board run visibility, sales rules, and replay safety across the bridge.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T07:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "equals", "some"]);
  const same = (a: any, b: any) => (a ?? null) === (b ?? null);
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "items") return true;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value);
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return !same(row[key], value.not);
      if ("equals" in value) return String(row[key] || "").toLowerCase() === String(value.equals).toLowerCase();
      if ("contains" in value) return String(row[key] || "").toLowerCase().includes(String(value.contains).toLowerCase());
      return true;
    }
    return same(row[key], value);
  });
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? { ...found } : null; }
      if (method === "findMany") return list.filter((row) => match(row, args.where)).map((row) => (name === "productionJob" ? { ...row, items: rows("productionJobItem").filter((item) => item.jobId === row.id) } : { ...row }));
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") { const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), ...args.data }; list.push(row); return { ...row }; }
      if (method === "update" || method === "updateMany") { const found = list.filter((row) => match(row, args.where)); found.forEach((row) => Object.assign(row, args.data)); return method === "update" ? { ...found[0] } : { count: found.length }; }
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : key === "$queryRawUnsafe" ? async () => [] : model(key)) });
  return { default: db, db };
});

import db from "../app/db.server";
import type { CanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import { canonicalStockBagJob } from "../app/lib/canonical-bag-pricing.server";
import { defaultPricingPolicyValues } from "../app/lib/commercial-pricing-policy.server";
import { DISABLED_FULFILLMENT_ADAPTER, FULFILLMENT_STATES, FULFILLMENT_WRITE_SCOPE, fulfillmentSyncDecision, fulfillmentSyncNote, readyMarkVerdict } from "../app/lib/fulfillment-sync";
import { productFamilySalesRuleFor } from "../app/lib/product-family-sales-rules";
import { roleMayRunProductionIntent } from "../app/lib/production-role-access";
import { actualsByRun, runCostAccounting, runCostClassOf } from "../app/lib/production-run";
import { QUICKBOOKS_NOT_CONNECTED, syncQuickBooksToStaging, toStageInput, type QuickBooksDocument, type QuickBooksReadAdapter } from "../app/lib/quickbooks-adapter.server";
import { activeRunLabelOf } from "../app/lib/simple-production";
import { linkStagedCustomer, readStagedLines, releaseStagedTransaction, stageTransaction } from "../app/lib/staged-transaction.server";
import { APPLICATION_TIMING_NOTE, applyStorefrontCostSnapshots, storefrontCostSnapshotFor } from "../app/lib/storefront-cost-snapshot.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const post = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return new Request("https://erp.test/app/erp/release-queue", { method: "POST", body }); };

beforeEach(() => {
  h.t = {}; h.seq = 0; h.shop = "shop-1"; h.sub = "1";
  Object.assign(process.env, { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" });
  delete process.env.GSO_OWNER_ENFORCEMENT;
});

const INVOICE: QuickBooksDocument = {
  type: "invoice", id: "1270", syncToken: "3", docNumber: "1270", customerId: "88", customerName: "krud Cafe", txnDate: "2026-11-18", totalAmount: 512, balance: 256, status: "Partially paid",
  updatedAt: "2026-11-19T10:00:00Z",
  lines: [{ id: "1", description: "Qty:128 - 20 designs", quantity: 128, amount: 512, itemId: "19", itemName: "Custom Item" }, { id: "2", description: "Old Balance", quantity: 1, amount: 0 }],
};

describe("TRACK M — QuickBooks: read-only boundary, staging only", () => {
  it("the adapter interface cannot write and the only adapter is not connected", async () => {
    const code = src("app/lib/quickbooks-adapter.server.ts");
    const iface = code.slice(code.indexOf("export interface QuickBooksReadAdapter"), code.indexOf("/** The only adapter"));
    expect(iface).toContain("listInvoices(");
    expect(iface).not.toMatch(/(create|update|void|send|delete|pay|refund)\w*\(/i); // no write method
    expect(code).not.toMatch(/fetch\(|intuit\.com|oauth|access_token|client_secret/i);
    expect(QUICKBOOKS_NOT_CONNECTED.connected).toBe(false);
    expect(await QUICKBOOKS_NOT_CONNECTED.listInvoices({})).toEqual([]);
    expect(await syncQuickBooksToStaging(db, "shop-1")).toMatchObject({ ok: false });
    expect(h.t.stagedTransaction || []).toEqual([]);
  });

  it("a document maps to staging facts: provider id, type, customer id, line ids, quantities, raw reference — nothing classified", () => {
    const input = toStageInput("shop-1", INVOICE);
    expect(input).toMatchObject({ source: "quickbooks_invoice", externalId: "1270", externalCustomerId: "88", provider: "quickbooks", transactionType: "invoice", rawReference: "invoice:1270@3", balance: 256, externalStatus: "Partially paid" });
    expect((input.lines as any[]).map((line) => [line.key, line.quantity, line.externalItemId])).toEqual([["1", 128, "19"], ["2", 1, undefined]]);
    expect(() => toStageInput("shop-1", { ...INVOICE, id: "" })).toThrow();
    expect(() => toStageInput("shop-1", { ...INVOICE, type: "payment" as any })).toThrow();
  });

  it("a connected adapter stages each document once; a second sync refreshes facts and never resets a review or makes a job", async () => {
    const adapter: QuickBooksReadAdapter = { connected: true, reason: null, async listInvoices() { return [INVOICE]; }, async listEstimates() { return []; } };
    expect(await syncQuickBooksToStaging(db, "shop-1", adapter)).toEqual({ ok: true, staged: 1, refreshed: 0 });
    const staged = h.t.stagedTransaction[0];
    expect(staged).toMatchObject({ status: "staged", provider: "quickbooks", transactionType: "invoice", rawReference: "invoice:1270@3" });
    expect(readStagedLines(staged.lines).every((line) => line.classification === "needs_review")).toBe(true);
    // a person reviews, then QuickBooks reports a payment
    staged.lines = JSON.stringify(readStagedLines(staged.lines).map((line, index) => ({ ...line, classification: index === 0 ? "production" : "non_production" })));
    const paid: QuickBooksReadAdapter = { ...adapter, async listInvoices() { return [{ ...INVOICE, balance: 0, status: "Paid", syncToken: "4" }]; } };
    expect(await syncQuickBooksToStaging(db, "shop-1", paid)).toEqual({ ok: true, staged: 0, refreshed: 1 });
    expect(h.t.stagedTransaction).toHaveLength(1);
    expect(h.t.stagedTransaction[0]).toMatchObject({ balance: 0, externalStatus: "Paid", status: "staged", rawReference: "invoice:1270@4" });
    expect(readStagedLines(h.t.stagedTransaction[0].lines)[0].classification).toBe("production");
    // paid in full still releases nothing by itself: the release rule is the admin's
    expect(h.t.productionJob || []).toEqual([]);
  });

  it("a customer link is set only by a person, only to an existing account of the same shop", async () => {
    const { id } = await stageTransaction(db, toStageInput("shop-1", INVOICE));
    h.t.crmAccount = [{ id: "acc-1", shop: "shop-1", company: "Krud Cafe" }, { id: "acc-2", shop: "shop-2", company: "Krud Cafe" }];
    expect(h.t.stagedTransaction[0].accountId ?? null).toBeNull();
    expect((await linkStagedCustomer(db, { shop: "shop-1", id, accountId: "acc-2", actor: "Admin" })).ok).toBe(false);
    expect((await linkStagedCustomer(db, { shop: "shop-1", id, accountId: "acc-1", actor: "" })).ok).toBe(false);
    expect((await linkStagedCustomer(db, { shop: "shop-1", id, accountId: "acc-1", actor: "Admin" })).ok).toBe(true);
    expect(h.t.stagedTransaction[0]).toMatchObject({ accountId: "acc-1", mappingState: "customer_mapped" });
    expect((await linkStagedCustomer(db, { shop: "shop-1", id, accountId: null, actor: "Admin" })).ok).toBe(true);
    expect(h.t.stagedTransaction[0]).toMatchObject({ accountId: null, mappingState: "unmapped" });
  });
});

describe("TRACK E — reorder picker on Release to Production", () => {
  const seed = async () => {
    const { id } = await stageTransaction(db, toStageInput("shop-1", INVOICE));
    h.t.productionJob = [
      { id: "old-job", shop: "shop-1", jobTicket: "GSO-20261001-0007", customerName: "Krud Cafe", status: "completed" },
      { id: "other-job", shop: "shop-1", jobTicket: "GSO-20261002-0001", customerName: "Leaf Labs", status: "completed" },
      { id: "foreign-job", shop: "shop-2", jobTicket: "GSO-20261001-0001", customerName: "krud Cafe", status: "completed" },
    ];
    h.t.productionJobItem = [
      { id: "old-heath", shop: "shop-1", jobId: "old-job", itemTicket: "GSO-20261001-0007-01", productTitle: "HEATH pouch", quantity: 128, selectedFinish: "CMYK + Gloss" },
      { id: "leaf-item", shop: "shop-1", jobId: "other-job", itemTicket: "GSO-20261002-0001-01", productTitle: "Leaf jar", quantity: 500 },
      { id: "foreign-item", shop: "shop-2", jobId: "foreign-job", itemTicket: "GSO-20261001-0001-01", productTitle: "HEATH pouch", quantity: 128 },
    ];
    return id;
  };
  const review = (id: string, extra: Record<string, string> = {}) => ({ intent: "review", id, class_0: "production", items_0: "HEATH pouch | 128\nSHORTCAKES pouch | 128", class_1: "non_production", family: "default", finish: "CMYK", ...extra });

  it("offers earlier items of the same customer name (case-insensitive) and nothing from another shop; nothing is pre-selected", async () => {
    await seed();
    const route = await import("../app/routes/app.erp.release-queue");
    const data = await (await route.loader({ request: new Request("https://erp.test/app/erp/release-queue") })).json();
    expect(data.reorderOptions.map((option: any) => option.id)).toEqual(["old-heath"]);
    expect(data.reorderOptions[0].label).toContain("GSO-20261001-0007-01");
    expect(JSON.stringify(data.reorderOptions)).not.toMatch(/price|cost/i);
    const found = await (await route.loader({ request: new Request("https://erp.test/app/erp/release-queue?find=Leaf") })).json();
    expect(found.reorderOptions.map((option: any) => option.id).sort()).toEqual(["leaf-item", "old-heath"]);
    expect(data.transactions[0].lines.every((line: any) => (line.productionItems || []).every((item: any) => !item.reorderSourceItemId))).toBe(true);
  }, 120_000);

  it("a person picks the earlier item and the artwork state per item; an unpicked item is simply not a reorder", async () => {
    const id = await seed();
    const route = await import("../app/routes/app.erp.release-queue");
    expect(await (await route.action({ request: post(review(id)) })).json()).toMatchObject({ ok: true });
    const picked = await (await route.action({ request: post(review(id, { reorder_0_0: "old-heath", reorderfor_0_0: "HEATH pouch", artwork_0_0: "revision", reorderfor_0_1: "SHORTCAKES pouch", reorder_0_1: "" })) })).json();
    expect(picked).toMatchObject({ ok: true });
    const items = readStagedLines(h.t.stagedTransaction[0].lines)[0].productionItems as any[];
    expect(items.map((item) => [item.productTitle, item.quantity, item.reorderSourceItemId ?? null, item.reorderArtworkMode ?? null])).toEqual([["HEATH pouch", 128, "old-heath", "revision"], ["SHORTCAKES pouch", 128, null, null]]);
  }, 120_000);

  it("an ambiguous or stale pick is refused, never guessed: changed item list, unknown item, another shop's item", async () => {
    const id = await seed();
    const route = await import("../app/routes/app.erp.release-queue");
    const stale = await (await route.action({ request: post(review(id, { items_0: "SHORTCAKES pouch | 128\nHEATH pouch | 128", reorder_0_0: "old-heath", reorderfor_0_0: "HEATH pouch" })) })).json();
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain("item list changed");
    for (const bad of ["no-such-item", "foreign-item"]) {
      const refused = await (await route.action({ request: post(review(id, { reorder_0_0: bad, reorderfor_0_0: "HEATH pouch" })) })).json();
      expect(refused.ok).toBe(false);
    }
    expect(readStagedLines(h.t.stagedTransaction[0].lines).every((line) => line.classification === "needs_review")).toBe(true);
    expect(h.t.productionJob).toHaveLength(3);
  }, 120_000);

  it("release hands the picked lineage to the ONE job service; releasing twice is one job", async () => {
    const id = await seed();
    const route = await import("../app/routes/app.erp.release-queue");
    await route.action({ request: post(review(id, { reorder_0_0: "old-heath", reorderfor_0_0: "HEATH pouch", artwork_0_0: "same_artwork" })) });
    const calls: any[] = [];
    const createJob: any = async (_db: any, input: any) => {
      calls.push(input);
      const existing = (h.t.productionJob || []).find((job) => job.quoteId === `released_${input.source.transactionId}`);
      if (existing) return { job: { ...existing, items: [] }, created: false };
      const job = { id: "new-job", shop: "shop-1", jobTicket: "GSO-20261120-0001", quoteId: `released_${input.source.transactionId}`, items: input.source.payload.items };
      h.t.productionJob.push(job);
      return { job, created: true };
    };
    const first = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "Admin" }, { createJob });
    const again = await releaseStagedTransaction(db, { shop: "shop-1", id, actor: "Admin" }, { createJob });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toMatchObject({ type: "released_transaction", transactionId: id, origin: "quickbooks_invoice" });
    expect(calls[0].source.payload.items.map((item: any) => [item.productTitle, item.reorderSourceItemId ?? null])).toEqual([["HEATH pouch", "old-heath"], ["SHORTCAKES pouch", null]]);
    expect(h.t.productionJob.filter((job) => job.id === "new-job")).toHaveLength(1);
    // the staged path has exactly one way to make a job
    expect(src("app/lib/staged-transaction.server.ts")).not.toMatch(/productionJob\.create|productionJobItem\.create/);
    expect(src("app/routes/app.erp.release-queue.tsx")).not.toMatch(/productionJob\.create|productionJobItem\.create/);
  }, 120_000);
});

const BAG_INPUTS: CanonicalBagInputs = {
  available: true, reasons: [], matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 }, holographic: { name: "Holographic", costPerSqft: 0.7141463415 },
  blank: { name: "Blank 4x5 bag", unitCost: 0.11, tiers: [] }, rolandSqftPerHour: 150, policyValues: defaultPricingPolicyValues(),
};
const bagItem = (overrides: Record<string, any> = {}, canonical: Record<string, any> = {}) => ({
  productTitle: "4x5 Sticker Bag", quantity: 1000, unitPrice: 0.62, unitCost: 0, costSnapshot: JSON.stringify({ source: "pending_cost_book_mapping" }),
  priceSnapshot: JSON.stringify({ source: "shopify_order_paid_webhook", productFamily: "Sticker Bags", quantity: 1000, unitPrice: 0.62, canonical: { v: "x", profile: "sticker_bag_4x5", qty: 1000, faces: 2, material: "Holographic", holo: true, whiteRequired: true, glossX: 3, finishLabel: "Raised Gloss+ — 3X", unitPrice: 0.62, engine: "canonical", ...canonical } }),
  ...overrides,
});

describe("TRACK F — storefront orders keep the cost basis in force when the job is created", () => {
  const now = new Date("2026-11-20T07:00:00Z");

  it("a bag line stores exactly the cost the storefront price engine uses for that configuration", () => {
    const engine = canonicalStockBagJob(BAG_INPUTS, { quantity: 1000, faces: 2, glossLayers: 3, whiteLayers: 1, holographic: true });
    if (!engine.available) throw new Error("fixture");
    const snapshot: any = storefrontCostSnapshotFor(bagItem(), BAG_INPUTS, now);
    expect(snapshot).toMatchObject({ source: "storefront_cost_snapshot", status: "captured", family: "Sticker Bags", quantity: 1000, faces: 2, glossLayers: 3, holographic: true, sellingUnitPrice: 0.62, sellingTotal: 620, capturedAt: now.toISOString() });
    expect(snapshot.totalCost).toBeCloseTo(engine.totalCost, 2);
    expect(snapshot.unitCost).toBeCloseTo(engine.unitCost, 4);
    expect(snapshot.marginPct).toBeCloseTo(((620 - engine.totalCost) / 620) * 100, 1);
    expect(snapshot.costLines.length).toBeGreaterThan(3);
    expect(snapshot.costLines.reduce((sum: number, line: any) => sum + line.amount, 0)).toBeCloseTo(engine.totalCost, 0);
    expect(snapshot.note).toBe(APPLICATION_TIMING_NOTE);
    expect(snapshot.note).toContain("PENDING REAL SHOP TIMING VALIDATION");
  });

  it("recording the cost changes no price: the storefront price for the same configuration is untouched", () => {
    const before = priceStorefrontConfiguration(BAG_INPUTS, { quantity: 1000, faces: 2, material: "Holographic", finish: "Raised Gloss+ — 3X" });
    storefrontCostSnapshotFor(bagItem(), BAG_INPUTS, now);
    expect(priceStorefrontConfiguration(BAG_INPUTS, { quantity: 1000, faces: 2, material: "Holographic", finish: "Raised Gloss+ — 3X" })).toEqual(before);
  });

  it("forward only and frozen: a later cost change does not move a stored snapshot", () => {
    const [stamped] = applyStorefrontCostSnapshots([bagItem()], BAG_INPUTS, now);
    const stored = JSON.parse(stamped.costSnapshot);
    expect(stamped.unitCost).toBe(stored.unitCost);
    const dearer: CanonicalBagInputs = { ...BAG_INPUTS, blank: { name: "Blank 4x5 bag", unitCost: 0.2, tiers: [] } };
    const later: any = storefrontCostSnapshotFor(bagItem(), dearer, new Date("2027-01-01T00:00:00Z"));
    expect(later.unitCost).toBeGreaterThan(stored.unitCost);
    expect(JSON.parse(stamped.costSnapshot).unitCost).toBe(stored.unitCost); // the stored text is what it was
    // only job CREATION stamps: there is no code that re-stamps an existing item
    const service = src("app/lib/production-job-source.server.ts");
    expect(service.split("applyStorefrontCostSnapshots(").length - 1).toBe(1);
    expect(service).toContain("payload.items = applyStorefrontCostSnapshots(payload.items as any[], storefrontBagInputs) as any;");
    expect(service.indexOf("storefrontBagInputs = await resolveCanonicalBagInputs(dbClient, shop);")).toBeLessThan(service.indexOf("dbClient.$transaction"));
  });

  it("when a cost cannot be captured it says so — never a $0 pretending to be a cost", () => {
    const jar: any = storefrontCostSnapshotFor({ quantity: 128, unitPrice: 2.1, priceSnapshot: JSON.stringify({ productFamily: "Jars", canonical: { family: "jars", profile: "jar_3_5g", baseFinish: "Clear" } }) }, BAG_INPUTS, now);
    expect(jar).toMatchObject({ status: "not_captured", family: "Jars" });
    expect(jar.unitCost).toBeUndefined();
    expect(storefrontCostSnapshotFor(bagItem(), null, now)).toMatchObject({ status: "not_captured" });
    expect(storefrontCostSnapshotFor(bagItem(), { ...BAG_INPUTS, available: false, reasons: ["No verified matte print material found"] }, now)).toMatchObject({ status: "not_captured" });
    expect(storefrontCostSnapshotFor({ quantity: 1, unitPrice: 1, priceSnapshot: "not json" }, BAG_INPUTS, now)).toMatchObject({ status: "not_captured" });
    const [unstamped] = applyStorefrontCostSnapshots([{ quantity: 128, unitPrice: 2.1, priceSnapshot: JSON.stringify({ productFamily: "Jars" }) }], BAG_INPUTS, now);
    expect(unstamped.unitCost).toBe(0);
    expect(JSON.parse(unstamped.costSnapshot).status).toBe("not_captured");
  });

  it("the snapshot is not shaped like the canonical cost block that quote cost authority trusts", async () => {
    const { canonicalCostBlockOf } = await import("../app/lib/quote-item-cost-authority");
    const [stamped] = applyStorefrontCostSnapshots([bagItem()], BAG_INPUTS, now);
    expect(canonicalCostBlockOf(stamped.costSnapshot)).toBeNull();
  });

  it("application timings are not touched by any of tonight's files", () => {
    for (const file of ["app/lib/storefront-cost-snapshot.server.ts", "app/lib/fulfillment-sync.ts", "app/lib/crm.server.ts", "app/lib/agent-approvals.server.ts"]) {
      expect(src(file)).not.toMatch(/applicationSeconds|secondsPerLabel|labelsPerHour\s*=|APPLICATION_SECONDS/);
    }
  });
});

describe("TRACK I — run cost accounting", () => {
  const runs: any[] = [
    { itemId: "i1", runNumber: 1, kind: "original", quantity: 500, status: "qc_failed" },
    { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, reasonCode: "banding", chargeType: "internal", runLabel: "P1-A1", status: "qc_passed" },
    { itemId: "i1", runNumber: 3, kind: "remake", quantity: 40, reasonCode: "customer_damage", chargeType: "customer_paid", runLabel: "P2-A1", status: "open" },
  ];
  const entries = [
    { sourceJobName: "GSO-20261119-0042-01__heath_CMYK", inkMl: 30, printMinutes: 20, sqft: 60 },
    { sourceJobName: "GSO-20261119-0042-01__heath_CMYK__P1-A1", inkMl: 1.5, printMinutes: 2, sqft: 3 },
    { sourceJobName: "GSO-20261119-0042-01__heath_CMYK__P2-A1", inkMl: 2.4, printMinutes: 3, sqft: 5 },
  ];

  it("original, shop-absorbed and customer-paid runs are kept apart; revenue never changes", () => {
    const cost = runCostAccounting(runs, actualsByRun(runs, entries));
    expect(cost.rows.map((row) => [row.runNumber, row.costClass, row.quantity, row.inkMl])).toEqual([[1, "original", 500, 30], [2, "internal_extra", 25, 1.5], [3, "customer_paid_extra", 40, 2.4]]);
    expect(cost.original).toEqual({ inkMl: 30, printMinutes: 20 });
    expect(cost.internalExtra).toEqual({ runs: 1, quantity: 25, inkMl: 1.5, printMinutes: 2 });
    expect(cost.customerPaidExtra).toEqual({ runs: 1, quantity: 40, inkMl: 2.4, printMinutes: 3 });
    expect(cost.revenueChange).toBe("none");
    expect(cost.rows[2].treatment).toContain("the ERP charges nothing");
    expect(runCostClassOf({ kind: "remake", chargeType: "warranty" })).toBe("internal_extra");
  });

  it("a run with no press result yet still appears; a press result with no recorded run keeps its own line", () => {
    const cost = runCostAccounting(runs, actualsByRun(runs, [entries[0], { sourceJobName: "x__heath__P7-A1", inkMl: 0.9, printMinutes: 1, sqft: 1 }]));
    expect(cost.rows.find((row) => row.runNumber === 2)).toMatchObject({ pressResult: false, inkMl: 0 });
    expect(cost.rows.at(-1)).toMatchObject({ runNumber: null, costClass: "internal_extra", inkMl: 0.9 });
    expect(runCostAccounting([], actualsByRun([], [entries[0]])).rows).toMatchObject([{ costClass: "original", inkMl: 30 }]);
  });

  it("nothing in run accounting writes, charges or changes the ordered quantity", () => {
    const code = src("app/lib/production-run.ts");
    expect(code).not.toMatch(/prisma|db\.|fetch\(|draftOrder|unitPrice\s*=/);
  });
});

describe("TRACK L — fulfilment state and the guarded Shopify boundary", () => {
  it("the four internal states, and who may mark a job ready", () => {
    expect([...FULFILLMENT_STATES]).toEqual(["ready_to_ship", "shipped", "pickup_ready", "picked_up"]);
    expect(readyMarkVerdict({ status: "qc" }, "ship")).toEqual({ ok: true, state: "ready_to_ship", unchanged: false });
    expect(readyMarkVerdict({ status: "qc", fulfillmentState: "pickup_ready" }, "pickup")).toMatchObject({ ok: true, unchanged: true });
    for (const status of ["shipped", "picked_up", "completed", "cancelled"]) expect(readyMarkVerdict({ status }, "ship").ok).toBe(false);
    expect(readyMarkVerdict({ status: "qc" }, "teleport").ok).toBe(false);
    for (const role of ["owner", "manager", "print_operator", "bagger"]) expect(roleMayRunProductionIntent(role, "markFulfillmentReady")).toBe(true);
    for (const role of ["sales", "unassigned"]) expect(roleMayRunProductionIntent(role, "markFulfillmentReady")).toBe(false);
  });

  it("Shopify is never marked fulfilled today: no scope, no switch, no adapter", async () => {
    expect(fulfillmentSyncDecision({ orderGid: null })).toEqual({ status: "not_applicable", reason: null });
    const order = { orderGid: "gid://shopify/Order/1" };
    expect(fulfillmentSyncDecision(order, { grantedScopes: "read_orders,write_products" })).toMatchObject({ status: "disabled" });
    const scoped = { grantedScopes: `read_orders,${FULFILLMENT_WRITE_SCOPE}` };
    expect(fulfillmentSyncDecision(order, { ...scoped, env: {} })).toMatchObject({ status: "disabled" });
    expect(fulfillmentSyncDecision(order, { ...scoped, env: { GSO_SHOPIFY_FULFILLMENT_SYNC: "enabled" } })).toMatchObject({ status: "disabled" });
    // all three gates together are the only way to "pending" — and no adapter is installed in this release
    expect(fulfillmentSyncDecision(order, { ...scoped, env: { GSO_SHOPIFY_FULFILLMENT_SYNC: "enabled" }, adapterInstalled: true })).toEqual({ status: "pending", reason: null });
    expect(DISABLED_FULFILLMENT_ADAPTER.installed).toBe(false);
    expect(await DISABLED_FULFILLMENT_ADAPTER.sync({ shop: "s", jobId: "j", orderGid: "g", kind: "shipped", idempotencyKey: "k" })).toMatchObject({ status: "disabled" });
    expect(fulfillmentSyncNote("disabled", "The app has no Shopify fulfilment permission. Mark the order fulfilled in Shopify by hand.")).toContain("by hand");
    expect(fulfillmentSyncNote("not_applicable")).toBe("");
  });

  it("the production action stores the state and the honest sync status; it calls no Shopify fulfilment API", () => {
    const route = src("app/routes/app.erp.production.tsx");
    expect(route).toContain('fulfillmentState: "shipped",');
    expect(route).toContain('fulfillmentState: "picked_up", fulfillmentSyncStatus: shopifySync.status, fulfillmentSyncError: shopifySync.reason');
    expect(route).toContain("adapterInstalled: false");
    expect(route).not.toMatch(/fulfillmentCreate|fulfillmentOrder|fulfillmentCreateV2/);
    const ready = route.slice(route.indexOf('if (intent === "markFulfillmentReady") {'), route.indexOf('if (intent === "recordShipment" || intent === "recordPickup") {'));
    expect(ready).toContain("evaluateQcForCompletion(qcItems, qcEvents as any)"); // QC PASS first
    expect(ready).toContain("where: { shop, id: jobId, status: job.status }"); // replay-safe
    expect(ready).not.toContain("status: \"shipped\"");
    expect(src("shopify.app.toml")).not.toContain("fulfillment");
  });
});

describe("TRACK J — the board shows the run on the press now", () => {
  it("names the open reprint / remake with its quantity; silent while only the original exists", () => {
    expect(activeRunLabelOf([{ runs: [{ runNumber: 1, kind: "original", quantity: 500, status: "open" }] }])).toBe("");
    expect(activeRunLabelOf([{ runs: [{ runNumber: 1, kind: "original", quantity: 500, status: "qc_failed" }, { runNumber: 2, kind: "reprint", quantity: 25, status: "open" }] }])).toBe("Run 2 · Reprint · 25 pcs");
    expect(activeRunLabelOf([{ runs: [{ runNumber: 2, kind: "remake", quantity: 40, status: "open" }] }, { runs: [{ runNumber: 2, kind: "reprint", quantity: 5, status: "open" }] }])).toBe("Run 2 · Remake · 40 pcs (+1 more)");
    expect(activeRunLabelOf([{ runs: [{ runNumber: 2, kind: "reprint", quantity: 25, status: "qc_passed" }] }])).toBe("");
    const board = src("app/routes/app.erp.production-board.tsx");
    expect(board).toContain('<Field label="On press now" value={card.activeRunLabel} />');
    expect(board).toContain('<Field label="Packed" value={card.fulfillmentLabel} />');
    expect(board).not.toMatch(/unitCost|marginPct|totalCost|unitPrice/);
  });
});

describe("TRACK H — product family rules that had a deterministic answer", () => {
  it("Stock Bags: MOQ 50, premade artwork; they no longer fall through to 'custom / other'", () => {
    for (const name of ["Stock Bags", "stock_bag_4x5", "4x5 stock bag"]) expect(productFamilySalesRuleFor(name)).toMatchObject({ key: "stock-bags", officialMoq: 50 });
    expect(productFamilySalesRuleFor("Stock Bags").salesRules.join(" ")).toContain("Premade artwork");
    expect(productFamilySalesRuleFor("Sticker Bags")).toMatchObject({ key: "sticker-bags", officialMoq: 50 });
  });
  it("a die-cut / shaped pouch is the 2,500 family, not the 1,000 DTP family", () => {
    for (const name of ["die-cut pouch", "shaped pouch", "Die Cut Bags", "custom shape bag"]) expect(productFamilySalesRuleFor(name)).toMatchObject({ key: "die-cut-shaped-bags", officialMoq: 2500 });
    expect(productFamilySalesRuleFor("DTP pouch")).toMatchObject({ key: "dtp-pouches", officialMoq: 1000 });
    expect(productFamilySalesRuleFor("3.5g jar").key).toBe("jars");
  });
});

describe("TRACK D / S — one path to production, safe to replay", () => {
  it("there is exactly one function that creates a ProductionJob", () => {
    const creators = ["app/lib", "app/routes"].flatMap((dir) => {
      const { readdirSync, statSync } = require("node:fs");
      const walk = (path: string): string[] => readdirSync(path).flatMap((name: string) => (statSync(`${path}/${name}`).isDirectory() ? walk(`${path}/${name}`) : [`${path}/${name}`]));
      return walk(dir).filter((file) => /\.(ts|tsx)$/.test(file) && /productionJob\.create\(/.test(src(file)));
    });
    expect(creators).toEqual(["app/lib/production-job-source.server.ts"]);
  });

  it("every source resolves to one idempotency key: quote, order, manual, released transaction", () => {
    const service = src("app/lib/production-job-source.server.ts");
    for (const key of ["sourceKey = `shopify_order_${stableOrderId}`;", "sourceKey = `released_${transactionId}`;", "sourceKey = `manual_${requestId}`;"]) expect(service).toContain(key);
    expect(service).toContain("refusing to create a production job from an unidempotent source");
  });

  it("the CRM, the approval queue and the QuickBooks boundary cannot create production work", () => {
    for (const file of ["app/lib/crm.server.ts", "app/lib/agent-approvals.server.ts", "app/lib/quickbooks-adapter.server.ts", "app/routes/app.erp.crm.tsx", "app/routes/app.erp.crm.$id.tsx", "app/routes/app.erp.agent-approvals.tsx"]) {
      expect(src(file)).not.toMatch(/productionJob\.(create|update)|productionJobItem\.create|createProductionJobFromSource\(/);
    }
  });

  it("a staged transaction stays one row however often the provider reports it", async () => {
    for (let i = 0; i < 4; i += 1) await stageTransaction(db, toStageInput("shop-1", INVOICE));
    await stageTransaction(db, toStageInput("shop-2", INVOICE));
    expect(h.t.stagedTransaction.map((row) => row.shop)).toEqual(["shop-1", "shop-2"]);
  });
});

describe("operations — build marker", () => {
  it("answers which build is serving and exposes nothing else", async () => {
    const health = await import("../app/routes/api.health");
    process.env.RENDER_GIT_COMMIT = "a2c2bab1234567890";
    const response = await health.loader();
    expect(await response.json()).toEqual({ ok: true, commit: "a2c2bab" });
    delete process.env.RENDER_GIT_COMMIT;
    expect(await (await health.loader()).json()).toEqual({ ok: true, commit: null });
    const code = src("app/routes/api.health.tsx");
    expect(code).not.toMatch(/db\.server|DATABASE_URL|SHOPIFY_API_SECRET|authenticate/);
    expect((health as any).action).toBeUndefined();
  });
});
