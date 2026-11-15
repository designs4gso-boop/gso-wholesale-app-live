// 2026-11-15 — OPERATIONAL QA (code level): ACTUAL COST / VARIANCE, FINANCIAL
// REDACTION and the manual material-use stock guard.
//
// Drives the REAL Production loader and action against one in-memory job, as
// each of the six roles. What is locked here:
//   - the quoted cost snapshot is immutable; actual cost is stored separately;
//   - variance = actual - quoted (dollars and percent), never a fake 0%;
//   - only the owner or a financially authorized manager can save, finalize or
//     reopen actual cost — a forged POST from anyone else changes nothing;
//   - finalization records who and when (the verified staff user, not a
//     generic "offline session" label); reopen keeps the prior figures;
//   - no cost / profit / margin / variance reaches a non-financial role in the
//     SERVER payload (checked before any rendering);
//   - a double-submitted material use is recorded and deducted once.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", s: null as any, clock: Date.parse("2026-11-15T18:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  // offline session, exactly like production: the person is only known from the session token
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/lib/inventory-stock.server", () => ({
  applyStockMovement: async (_tx: any, args: any) => {
    const before = h.s.stock;
    if (before + args.delta < 0) return { ok: false, message: "Not enough stock." };
    h.s.stock = before + args.delta;
    h.s.moves.push(args);
    return { ok: true, beforeQty: before, afterQty: h.s.stock };
  },
}));

vi.mock("../app/db.server", () => {
  const READS = ["findFirst", "findMany", "count", "findUnique", "aggregate", "groupBy"];
  const fullJob = () => ({ ...h.s.job, items: h.s.items.map((i: any) => ({ ...i })), files: [], events: [...h.s.events].reverse().slice(0, 20), checklistItems: [], materialUsages: h.s.usages.map((u: any) => ({ ...u })), inventoryMovements: [] });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const s = h.s;
      if (!READS.includes(method)) s.writes.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findFirst") return fullJob();
        if (method === "findMany") return [fullJob()];
        if (method === "update" || method === "updateMany") { Object.assign(s.job, args.data); return { count: 1 }; }
      }
      if (name === "productionJobItem" && method === "findMany") return s.items.map((i: any) => ({ ...i }));
      if (name === "productionJobEvent") {
        if (method === "create") { const row = { id: `e${s.events.length + 1}`, ...args.data, createdAt: new Date((h.clock += 1000)) }; s.events.push(row); return row; }
        if (method === "findMany") return s.events.filter((e: any) => !args.where?.eventType?.in || args.where.eventType.in.includes(e.eventType));
      }
      if (name === "material") {
        if (method === "findFirst") return args.where?.id === s.material.id ? { ...s.material, stockOnHand: s.stock } : null;
        if (method === "findMany") return [{ ...s.material, stockOnHand: s.stock }];
      }
      if (name === "productionMaterialUsage") {
        if (method === "findFirst") {
          const w = args.where || {};
          const since = w.createdAt?.gte ? new Date(w.createdAt.gte).getTime() : null;
          const rows = s.usages.filter((u: any) => ["id", "jobId", "materialId", "materialName", "unit", "usedQty", "pulledQty", "wasteQty", "reprintQty"].every((k) => !(k in w) || u[k] === w[k]) && (since == null || new Date(u.createdAt).getTime() >= since));
          return rows.length ? { ...rows[rows.length - 1] } : null;
        }
        if (method === "create") { const row = { id: `u${s.usages.length + 1}`, stockDeductedQty: 0, stockDeductedAt: null, ...args.data, createdAt: new Date() }; s.usages.push(row); return { ...row }; }
        if (method === "update") { Object.assign(s.usages.find((u: any) => u.id === args.where.id), args.data); return {}; }
      }
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

import { findInternalFinancialKeys } from "../app/lib/financial-redaction";
import { redactJobFinancials } from "../app/lib/production-financial-redaction";
import { computeEstimateVariance } from "../app/lib/actual-cost-finalize.server";
import { MATERIAL_USAGE_REPLAY_WINDOW_MS, isMaterialUsageReplay, manualUsageSource } from "../app/lib/material-usage-guard";

const ROLES = { owner: "77055393857", manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", authorized_manager: "1005", unassigned: "9999" } as const;
type Role = keyof typeof ROLES;
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger,1005:manager", GSO_MANAGER_AUTHORIZED_USER_IDS: "1005" };
const FINANCIAL: Role[] = ["owner", "authorized_manager"];
const NON_FINANCIAL: Role[] = ["manager", "sales", "print_operator", "bagger", "unassigned"];
const FLOOR_NON_FINANCIAL: Role[] = ["manager", "print_operator", "bagger"];

// A quote-sourced job: 1,000 custom items quoted at $0.30 true cost and sold at $0.75.
const QUOTED_UNIT_COST = 0.3;
const QUOTED_TOTAL = 300;
const COST_SNAPSHOT = JSON.stringify({ source: "quote", unitCost: QUOTED_UNIT_COST, totalCost: QUOTED_TOTAL });
const PRICE_SNAPSHOT = JSON.stringify({ unitPrice: 0.75, total: 750 });
const reset = () => {
  h.s = {
    job: {
      id: "j1", shop: "shop-1", jobTicket: "GSO-20261115-0001", status: "completed", active: true, sourceType: "quote", quoteId: "q1", company: "Test Co", priority: "normal", dueDate: null,
      actualLaborRate: 25, actualLaborMinutes: 0, actualLaborCost: 0, actualPackingCost: 0, actualShippingCost: 0, actualOutsourceCost: 0, actualOtherCost: 0, actualReprintCost: 0,
      actualTotalCost: 0, actualFinalProfit: 0, actualFinalMargin: 0, actualCostNotes: null, quotedTrueCost: null, actualVarianceAmount: null, actualVariancePct: null,
      actualCostFinalized: false, actualCostFinalizedAt: null, actualCostFinalizedBy: null,
    },
    items: [{ id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-20261115-0001-01", productTitle: "Custom item", productFamily: "custom-item", quantity: 1000, unitPrice: 0.75, unitCost: QUOTED_UNIT_COST, costSnapshot: COST_SNAPSHOT, priceSnapshot: PRICE_SNAPSHOT }],
    usages: [] as any[], events: [] as any[], writes: [] as string[], moves: [] as any[], stock: 500,
    material: { id: "m1", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", unit: "sqft", baseUnit: "sqft", costPerUnit: 0.3155, calculatedUnitCost: 0.3155, purchaseCost: 213, active: true },
  };
};

let production: any, workspace: any, board: any, actualCosts: any;
beforeAll(async () => {
  production = await import("../app/routes/app.erp.production");
  workspace = await import("../app/routes/app.erp.production-job.$id");
  board = await import("../app/routes/app.erp.production-board");
  actualCosts = await import("../app/routes/app.erp.actual-costs");
}, 240_000);
beforeEach(() => { Object.assign(process.env, ENV); h.sub = ROLES.owner; reset(); });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const post = async (role: Role, fields: Record<string, string>, door: "production" | "workspace" = "production") => {
  h.sub = ROLES[role];
  const request = new Request(door === "production" ? "https://app.test/app/erp/production" : "https://app.test/app/erp/production-job/j1", { method: "POST", body: new URLSearchParams({ jobId: "j1", ...fields }) });
  const res: Response = door === "production" ? await production.action({ request }) : await workspace.action({ request, params: { id: "j1" } });
  return { status: res.status, body: await res.json() };
};
const load = async (role: Role, route: any, url: string, params: Record<string, string> = {}): Promise<{ status: number; body: any; location: string | null }> => {
  h.sub = ROLES[role];
  try {
    const res: Response = await route.loader({ request: new Request(url), params });
    return { status: res.status, body: res.status === 200 ? await res.json() : null, location: res.headers.get("Location") };
  } catch (thrown: any) {
    if (thrown instanceof Response) return { status: thrown.status, body: null, location: thrown.headers.get("Location") };
    throw thrown;
  }
};
// $180 labor + $60 packing + $90 other = $330 actual against the $300 quoted cost.
const ACTUALS = { intent: "saveFinalCosts", actualLaborMinutes: "540", actualLaborRate: "20", actualPackingCost: "60", actualOtherCost: "90", actualCostNotes: "ran long" };
const FINALIZE = { ...ACTUALS, actualCostFinalized: "true", finalizeReason: "owner reviewed the entered actuals" };
const itemSnapshot = () => ({ unitCost: h.s.items[0].unitCost, unitPrice: h.s.items[0].unitPrice, costSnapshot: h.s.items[0].costSnapshot, priceSnapshot: h.s.items[0].priceSnapshot, quantity: h.s.items[0].quantity });
const QUOTE_SNAPSHOT = { unitCost: QUOTED_UNIT_COST, unitPrice: 0.75, costSnapshot: COST_SNAPSHOT, priceSnapshot: PRICE_SNAPSHOT, quantity: 1000 };

describe("ACTUAL COST / VARIANCE — the quote snapshot is immutable and actual cost is separate", () => {
  it("1-2. entering actual cost saves it in the actual-cost fields and leaves the quoted cost snapshot untouched", async () => {
    const r = await post("owner", ACTUALS);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.s.job).toMatchObject({ actualLaborMinutes: 540, actualLaborRate: 20, actualLaborCost: 180, actualPackingCost: 60, actualOtherCost: 90, actualTotalCost: 330, actualCostNotes: "ran long", actualCostFinalized: false });
    expect(itemSnapshot()).toEqual(QUOTE_SNAPSHOT);
    expect(h.s.writes.filter((w: string) => w.startsWith("productionJobItem."))).toEqual([]); // the quote-item snapshot rows are never written
    // the frozen quoted cost is the quote snapshot, not the actual
    expect(h.s.job.quotedTrueCost).toBe(QUOTED_TOTAL);
  }, 120_000);

  it("1. the frozen quoted cost is written once: later actual-cost saves (and a changed item) never overwrite it", async () => {
    await post("owner", ACTUALS);
    expect(h.s.job.quotedTrueCost).toBe(300);
    h.s.items[0].unitCost = 0.99; // even if an item figure were to differ later, the frozen quote figure stays
    await post("owner", { ...ACTUALS, actualOtherCost: "500" });
    expect(h.s.job.quotedTrueCost).toBe(300);
    expect(h.s.job.actualTotalCost).toBe(740);
  }, 120_000);

  it("3-4. variance = actual - quoted: +$30.00 and +10% here; under-estimate is negative; no estimate means no percent (never 0%)", async () => {
    await post("owner", ACTUALS);
    expect(h.s.job.actualVarianceAmount).toBeCloseTo(30, 9);
    expect(h.s.job.actualVariancePct).toBeCloseTo(10, 9);
    await post("owner", { ...ACTUALS, actualOtherCost: "0", actualPackingCost: "30" }); // $210 actual
    expect(h.s.job.actualVarianceAmount).toBeCloseTo(-90, 9);
    expect(h.s.job.actualVariancePct).toBeCloseTo(-30, 9);
    expect(computeEstimateVariance(330, 300)).toEqual({ varianceDollars: 30, variancePct: 10 });
    expect(computeEstimateVariance(210, 300).varianceDollars).toBe(-90);
    expect(computeEstimateVariance(210, 300).variancePct).toBeCloseTo(-30, 9);
    expect(computeEstimateVariance(120, 0)).toEqual({ varianceDollars: 120, variancePct: null });
    // a job with no quoted cost stores NO variance at all rather than inventing one
    reset();
    h.s.items[0].unitCost = 0;
    await post("owner", ACTUALS);
    expect(h.s.job).toMatchObject({ quotedTrueCost: null, actualVarianceAmount: null, actualVariancePct: null, actualTotalCost: 330 });
  }, 120_000);

  it("5. a reload returns the saved actual cost, quoted cost and variance to the owner", async () => {
    await post("owner", ACTUALS);
    const { body } = await load("owner", production, "https://app.test/app/erp/production");
    const job = body.jobs.find((j: any) => j.id === "j1");
    expect(job).toMatchObject({ actualTotalCost: 330, actualLaborCost: 180, actualPackingCost: 60, actualOtherCost: 90, quotedTrueCost: 300, actualCostNotes: "ran long" });
    expect(job.actualVarianceAmount).toBeCloseTo(30, 9);
    expect(job.actualVariancePct).toBeCloseTo(10, 9);
    expect(job.items[0]).toMatchObject({ unitCost: QUOTED_UNIT_COST, unitPrice: 0.75, costSnapshot: COST_SNAPSHOT });
  }, 120_000);

  it.each(FINANCIAL)("8-9. %s can finalize: who and when are recorded as the verified staff user, with a history event", async (role) => {
    const r = await post(role, FINALIZE);
    expect(r.body.ok, r.body.message).toBe(true);
    expect(h.s.job.actualCostFinalized).toBe(true);
    expect(h.s.job.actualCostFinalizedAt).toBeInstanceOf(Date);
    expect(h.s.job.actualCostFinalizedBy).toBe(`shopify-user:${ROLES[role]}`);
    expect(h.s.job.actualCostFinalizedBy).not.toMatch(/offline session|unidentified/);
    const event = h.s.events.find((e: any) => e.eventType === "actual_cost_finalized");
    expect(event.message).toContain(`FINALIZED by shopify-user:${ROLES[role]}`);
    expect(event.message).toContain("SNAPSHOT ");
    expect(itemSnapshot()).toEqual(QUOTE_SNAPSHOT);
    expect(h.s.job.quotedTrueCost).toBe(300);
  }, 120_000);

  it("a finalized job refuses further cost edits until it is reopened (nothing is silently overwritten)", async () => {
    await post("owner", FINALIZE);
    const before = { ...h.s.job };
    const r = await post("owner", { ...ACTUALS, actualOtherCost: "9999" });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toContain("Nothing was changed.");
    expect(h.s.job).toEqual(before);
    // an entered shipment cost does not rewrite a finalized job's cost either
    h.s.events.push({ eventType: "qc_result", newValue: "pass", oldValue: "GSO-20261115-0001-01", message: "QC PASS", createdAt: new Date() });
    h.s.job.status = "ready_to_ship";
    const shipped = await post("owner", { intent: "recordShipment", carrier: "UPS", trackingNumber: "1Z999", packageCount: "1", shipDate: "2026-11-15", actualShippingCost: "45" });
    expect(shipped.body.ok, shipped.body.message).toBe(true);
    expect(h.s.job.status).toBe("shipped");
    expect(h.s.job.actualShippingCost).toBe(before.actualShippingCost);
    expect(h.s.job.actualTotalCost).toBe(before.actualTotalCost);
  }, 120_000);

  it("10. reopen needs the owner phrase and a reason, keeps the prior final figures in history, and re-finalizing keeps the quoted cost", async () => {
    await post("owner", FINALIZE);
    const finalizedAt = h.s.job.actualCostFinalizedAt;
    expect((await post("owner", { intent: "reopenJobCost", reopenPhrase: "please", reopenReason: "invoice arrived late" })).body.ok).toBe(false);
    expect((await post("owner", { intent: "reopenJobCost", reopenPhrase: "OWNER COST REOPEN", reopenReason: "no" })).body.ok).toBe(false);
    expect(h.s.job.actualCostFinalized).toBe(true);
    const r = await post("authorized_manager", { intent: "reopenJobCost", reopenPhrase: "OWNER COST REOPEN", reopenReason: "invoice arrived late" });
    expect(r.body.ok, r.body.message).toBe(true);
    expect(h.s.job).toMatchObject({ actualCostFinalized: false, actualCostFinalizedAt: null, actualCostFinalizedBy: null, actualTotalCost: 330, quotedTrueCost: 300 });
    const reopened = h.s.events.find((e: any) => e.eventType === "actual_cost_reopened");
    expect(reopened.message).toContain(`REOPENED by shopify-user:${ROLES.authorized_manager}`);
    expect(reopened.message).toContain("Reason: invoice arrived late");
    const prior = JSON.parse(reopened.message.slice(reopened.message.indexOf("PRIOR FINAL ") + "PRIOR FINAL ".length));
    expect(prior).toMatchObject({ totalCost: 330, laborCost: 180, packingCost: 60, otherCost: 90, finalizedBy: `shopify-user:${ROLES.owner}`, finalizedAt: new Date(finalizedAt).toISOString() });
    // the first finalization is still in history, and the job can be corrected and finalized again
    expect(h.s.events.filter((e: any) => e.eventType === "actual_cost_finalized")).toHaveLength(1);
    expect((await post("owner", { ...FINALIZE, actualOtherCost: "120" })).body.ok).toBe(true);
    expect(h.s.job).toMatchObject({ actualCostFinalized: true, actualTotalCost: 360, quotedTrueCost: 300 });
    expect(h.s.job.actualVarianceAmount).toBeCloseTo(60, 9);
    expect(h.s.events.filter((e: any) => e.eventType === "actual_cost_finalized")).toHaveLength(2);
    expect(itemSnapshot()).toEqual(QUOTE_SNAPSHOT);
  }, 120_000);

  it.each(NON_FINANCIAL)("7. %s: a forged POST cannot save, finalize, reopen, pull print-log costs or adjust stock value — nothing changes", async (role) => {
    h.s.job = { ...h.s.job, actualCostFinalized: true, actualCostFinalizedAt: new Date("2026-11-10T00:00:00Z"), actualCostFinalizedBy: "shopify-user:77055393857", actualTotalCost: 330 };
    const before = JSON.stringify(h.s.job);
    for (const door of ["production", "workspace"] as const) {
      for (const fields of [
        ACTUALS, FINALIZE,
        { intent: "reopenJobCost", reopenPhrase: "OWNER COST REOPEN", reopenReason: "forged reopen" },
        { intent: "pullPrintLogActuals" },
        { intent: "adjustInventory", materialId: "m1", adjustQty: "-100", adjustReason: "forged" },
      ]) {
        const r = await post(role, fields as Record<string, string>, door);
        expect(r.status, `${role} ${door} ${fields.intent}`).toBe(403);
      }
    }
    expect(JSON.stringify(h.s.job)).toBe(before);
    expect(h.s.writes).toEqual([]);
    expect(h.s.events).toEqual([]);
    expect(h.s.stock).toBe(500);
  }, 120_000);
});

describe("FINANCIAL REDACTION — server payloads, before any rendering", () => {
  const MONEY_KEYS = ["actualLaborRate", "actualLaborCost", "actualPackingCost", "actualShippingCost", "actualOutsourceCost", "actualOtherCost", "actualReprintCost", "actualTotalCost", "actualFinalProfit", "actualFinalMargin", "actualCostNotes", "quotedTrueCost", "actualVarianceAmount", "actualVariancePct"];
  const seed = async () => {
    await post("owner", FINALIZE);
    h.s.usages.push(
      { id: "u1", shop: "shop-1", jobId: "j1", materialId: "m1", materialName: "Poseidon Matte", unit: "sqft", usedQty: 50, costPerUnit: 0.3155, totalCost: 15.78, source: "manual", notes: "second roll", createdAt: new Date() },
      { id: "u2", shop: "shop-1", jobId: "j1", materialId: null, materialName: "Print-log machine time (imported)", unit: "hour", usedQty: 2, costPerUnit: 37.5, totalCost: 75, source: "print_log", notes: JSON.stringify({ component: "machine_time", printMinutes: 120, machineRatePerHour: 37.5 }), createdAt: new Date() },
    );
  };
  // Money that must never appear anywhere in a non-financial payload, as raw text.
  const SECRETS = [/37\.5/, /0\.3155/, /15\.78/, /machineRatePerHour/, /"totalCost":\s*300/, /ran long/, /SNAPSHOT/, /Profit: \$/, /Margin: /];

  it.each(FINANCIAL)("%s receives the full financial job on the Advanced Production page", async (role) => {
    await seed();
    const { status, body } = await load(role, production, "https://app.test/app/erp/production");
    expect(status).toBe(200);
    const job = body.jobs[0];
    expect(job).toMatchObject({ actualTotalCost: 330, quotedTrueCost: 300 });
    expect(job.items[0]).toMatchObject({ unitCost: 0.3, unitPrice: 0.75 });
    expect(job.materialUsages.find((u: any) => u.id === "u2").notes).toContain("machineRatePerHour");
  }, 120_000);

  it.each(FLOOR_NON_FINANCIAL)("6. %s: the job page payload carries no quoted cost, actual cost, variance, price, profit, margin or cost note", async (role) => {
    await seed();
    const { status, body } = await load(role, workspace, "https://app.test/app/erp/production-job/j1", { id: "j1" });
    expect(status).toBe(200);
    const text = JSON.stringify(body);
    const job = body.job ?? body.jobs?.[0];
    expect(job).toBeTruthy();
    for (const key of MONEY_KEYS) expect(job[key] ?? null, key).toBeNull();
    for (const item of job.items) expect({ unitPrice: item.unitPrice ?? null, unitCost: item.unitCost ?? null, costSnapshot: item.costSnapshot ?? null, priceSnapshot: item.priceSnapshot ?? null }).toEqual({ unitPrice: null, unitCost: null, costSnapshot: null, priceSnapshot: null });
    for (const usage of job.materialUsages || []) {
      expect(usage.costPerUnit ?? null).toBeNull();
      expect(usage.totalCost ?? null).toBeNull();
    }
    // the imported print-log row keeps its quantities but not its cost provenance; a staff note is kept
    const imported = (job.materialUsages || []).find((u: any) => u.id === "u2");
    expect(imported, "print-log usage row present").toBeTruthy();
    expect(imported.usedQty).toBe(2);
    expect(imported.notes ?? null).toBeNull();
    const manual = (job.materialUsages || []).find((u: any) => u.id === "u1");
    expect(manual.notes).toBe("second roll");
    for (const secret of SECRETS) expect(text, String(secret)).not.toMatch(secret);
    // the finalize / reopen history lines (they quote totals, profit, margin) are masked
    for (const event of job.events || []) expect(String(event.message)).not.toMatch(/\$\s?\d|profit|margin|cost/i);
  }, 120_000);

  it.each(FLOOR_NON_FINANCIAL)("6. %s: the board payload carries no money at all", async (role) => {
    await seed();
    h.s.job.status = "printing";
    const { status, body } = await load(role, board, "https://app.test/app/erp/production-board");
    expect(status).toBe(200);
    const text = JSON.stringify(body);
    expect(findInternalFinancialKeys(body)).toEqual([]);
    for (const secret of SECRETS) expect(text, String(secret)).not.toMatch(secret);
    expect(text).not.toMatch(/"unitPrice":\s*0\.75|"actualTotalCost":\s*330|"quotedTrueCost":\s*300/);
  }, 120_000);

  it.each(FLOOR_NON_FINANCIAL)("%s is sent from the Advanced Production page to the board, and cannot open Actual Costs", async (role) => {
    await seed();
    const advanced = await load(role, production, "https://app.test/app/erp/production");
    expect(advanced.status).toBe(302);
    expect(advanced.location).toBe("/app/erp/production-board");
    expect((await load(role, actualCosts, "https://app.test/app/erp/actual-costs")).status).toBe(403);
  }, 120_000);

  it.each(["sales", "unassigned"] as Role[])("%s receives no production data: every production page turns them away before a job is read", async (role) => {
    await seed();
    h.s.writes = [];
    for (const [route, url, params] of [
      [production, "https://app.test/app/erp/production", {}],
      [board, "https://app.test/app/erp/production-board", {}],
      [workspace, "https://app.test/app/erp/production-job/j1", { id: "j1" }],
    ] as Array<[any, string, Record<string, string>]>) {
      const r = await load(role, route, url, params);
      expect(r.status, url).toBe(302);
      expect(r.location, url).toBe("/app");
      expect(r.body).toBeNull();
    }
    expect((await load(role, actualCosts, "https://app.test/app/erp/actual-costs")).status).toBe(403);
  }, 120_000);

  it("the redaction helper strips money from a job and drops print-log cost provenance, keeping operational quantities", () => {
    const job = redactJobFinancials({
      id: "j1", actualTotalCost: 330, quotedTrueCost: 300, actualVarianceAmount: 30, actualVariancePct: 10, actualFinalProfit: 420, actualFinalMargin: 56,
      items: [{ id: "i1", quantity: 1000, unitPrice: 0.75, unitCost: 0.3, costSnapshot: "{}", priceSnapshot: "{}" }],
      materialUsages: [
        { id: "u1", usedQty: 50, costPerUnit: 0.3155, totalCost: 15.78, source: "manual", notes: "second roll" },
        { id: "u2", usedQty: 2, costPerUnit: 37.5, totalCost: 75, source: "print_log", notes: '{"machineRatePerHour":37.5}' },
      ],
      events: [{ message: "Actual cost FINALIZED by x. Total: $330.00" }, { message: "Status changed from Printing to Cutting." }],
    });
    expect(job).toMatchObject({ actualTotalCost: null, quotedTrueCost: null, actualVarianceAmount: null, actualVariancePct: null, actualFinalProfit: null, actualFinalMargin: null });
    expect(job.items[0]).toEqual({ id: "i1", quantity: 1000, unitPrice: null, unitCost: null, costSnapshot: null, priceSnapshot: null });
    expect(job.materialUsages).toEqual([
      { id: "u1", usedQty: 50, costPerUnit: null, totalCost: null, source: "manual", notes: "second roll" },
      { id: "u2", usedQty: 2, costPerUnit: null, totalCost: null, source: "print_log", notes: null },
    ]);
    expect(job.events.map((e: any) => e.message)).toEqual(["(financial detail — owner only)", "Status changed from Printing to Cutting."]);
    expect(JSON.stringify(job)).not.toMatch(/37\.5|330|0\.3155/);
  });
});

describe("MANUAL MATERIAL USE — one entry is recorded and deducted once (automatic inventory stays OFF)", () => {
  const USE = { intent: "addMaterialUsage", materialId: "m1", usedQty: "50", deductInventory: "on" };

  it("a double-submitted entry is recorded once and stock is deducted once", async () => {
    const first = await post("bagger", USE, "workspace");
    const replay = await post("bagger", USE, "workspace");
    expect(first.body).toMatchObject({ ok: true });
    expect(first.body.message).toContain("inventory deducted");
    expect(replay.body.ok).toBe(true);
    expect(replay.body.message).toContain("already recorded");
    expect(h.s.usages).toHaveLength(1);
    expect(h.s.moves.map((m: any) => m.delta)).toEqual([-50]);
    expect(h.s.stock).toBe(450);
  }, 120_000);

  it("a genuinely different entry, or the same entry later, is still recorded", async () => {
    await post("print_operator", USE, "workspace");
    await post("print_operator", { ...USE, usedQty: "25" }, "workspace"); // different quantity
    expect(h.s.usages).toHaveLength(2);
    expect(h.s.stock).toBe(425);
    h.s.usages.forEach((u: any) => { u.createdAt = new Date(Date.now() - MATERIAL_USAGE_REPLAY_WINDOW_MS - 1000); });
    await post("print_operator", USE, "workspace"); // same quantities, but well after the replay window
    expect(h.s.usages).toHaveLength(3);
    expect(h.s.stock).toBe(375);
  }, 120_000);

  it("without the Deduct option nothing is deducted — recording use never consumes stock on its own", async () => {
    const r = await post("bagger", { intent: "addMaterialUsage", materialId: "m1", usedQty: "50" }, "workspace");
    expect(r.body.ok).toBe(true);
    expect(h.s.usages).toHaveLength(1);
    expect(h.s.moves).toEqual([]);
    expect(h.s.stock).toBe(500);
  }, 120_000);

  it("status changes, QC and completion never move stock (no automatic reservation or consumption)", async () => {
    h.s.job.status = "printing";
    for (const status of ["cutting", "ready_to_ship", "cancelled"]) await post("owner", { intent: "changeStatus", status });
    expect(h.s.moves).toEqual([]);
    expect(h.s.stock).toBe(500);
  }, 120_000);

  it("a manual entry can never be stored under the print-log source (those rows are replaced on re-import without a stock restore)", async () => {
    expect(manualUsageSource("print_log")).toBe("manual");
    expect(manualUsageSource("")).toBe("manual");
    expect(manualUsageSource(null)).toBe("manual");
    expect(manualUsageSource("vendor_invoice")).toBe("vendor_invoice");
    await post("owner", { ...USE, source: "print_log" });
    expect(h.s.usages[0].source).toBe("manual");
  }, 120_000);

  it("the replay rule compares every quantity and the time window; it never trusts a loose query result", () => {
    const entry = { jobId: "j1", materialId: "m1", materialName: "Poseidon Matte", unit: "sqft", usedQty: 50, pulledQty: 0, wasteQty: 0, reprintQty: 0 };
    const now = new Date("2026-11-15T18:00:10Z");
    const row = { ...entry, source: "manual", createdAt: new Date("2026-11-15T18:00:05Z") };
    expect(isMaterialUsageReplay(row, entry, now)).toBe(true);
    expect(isMaterialUsageReplay(null, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, usedQty: 51 }, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, wasteQty: 1 }, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, materialId: "m2" }, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, jobId: "j2" }, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, source: "print_log" }, entry, now)).toBe(false);
    expect(isMaterialUsageReplay({ ...row, createdAt: new Date("2026-11-15T17:59:00Z") }, entry, now)).toBe(false); // too old
    expect(isMaterialUsageReplay({ ...row, createdAt: null }, entry, now)).toBe(false);
    expect(MATERIAL_USAGE_REPLAY_WINDOW_MS).toBe(15_000);
  });
});
