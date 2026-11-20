// 2026-11-19 (night) — privacy webhooks are recorded, never auto-erasing; RIP
// actuals are attributed to the exact production run by the run token in the
// press's own job name; a hand-added file is linked to an item only when that
// is certain.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_DUE_DAYS, REDACTED_TEXT, applyCustomerRedaction, closeComplianceRequest, complianceFacts, customerIdForms, normalizeComplianceTopic, planCustomerRedaction, recordComplianceRequest } from "../app/lib/privacy-compliance.server";
import { actualsByRun, reprintNumberOfRipName, reprintNumberOfRun } from "../app/lib/production-run";
import { applyRunSuffix, parseRunIdentity, ripFileBaseName } from "../app/lib/print-intake-routing.server";
import { parseRipTickets } from "../app/lib/rip-identity-match.server";

function memoryDb(seed: Record<string, any[]>) {
  const t: Record<string, any[]> = seed;
  let seq = 0;
  const lower = (value: any) => String(value ?? "").toLowerCase();
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("equals" in value) return value.mode === "insensitive" ? lower(row[key]) === lower(value.equals) : row[key] === value.equals;
      if ("in" in value) return value.in.includes(row[key]);
      return true;
    }
    return (row[key] ?? null) === (value ?? null);
  });
  const writes: string[] = [];
  const db: any = new Proxy({}, {
    get: (_target, name: string) => {
      if (name === "$transaction") return async (fn: any) => fn(db);
      const rows = (t[name] = t[name] || []);
      return {
        findFirst: async ({ where }: any) => rows.find((row) => match(row, where)) || null,
        count: async ({ where }: any) => rows.filter((row) => match(row, where)).length,
        create: async ({ data }: any) => { const row = { id: `${name}_${++seq}`, ...data }; rows.push(row); writes.push(`${name}.create`); return row; },
        update: async ({ where, data }: any) => { const row = rows.find((candidate) => match(candidate, where)); Object.assign(row, data); writes.push(`${name}.update`); return row; },
        updateMany: async ({ where, data }: any) => { const found = rows.filter((row) => match(row, where)); found.forEach((row) => Object.assign(row, data)); writes.push(`${name}.updateMany`); return { count: found.length }; },
        deleteMany: async () => { throw new Error(`${name}.deleteMany must never be called`); },
        delete: async () => { throw new Error(`${name}.delete must never be called`); },
      };
    },
  });
  return { db, t, writes };
}

const seedCustomer = () => ({
  quote: [{ id: "q1", shop: "s", customerName: "Jane Doe", email: "Jane@Example.com", phone: "555", notes: "keep" }, { id: "q2", shop: "s", customerName: "Other", email: "other@example.com", phone: "1" }],
  productionJob: [{ id: "j1", shop: "s", customerName: "Jane Doe", email: "jane@example.com", phone: "555", jobTicket: "GSO-20261119-0042", proofCustomerEmail: "jane@example.com", proofCustomerName: "Jane" }],
  wholesaleApplication: [{ id: 1, shop: "s", customerId: "gid://shopify/Customer/12", email: "jane@example.com", phone: "555" }, { id: 2, shop: "s", customerId: "gid://shopify/Customer/123", email: "x@example.com", phone: "9" }],
  agentReviewQueueItem: [{ id: "l1", shop: "s", customerName: "Jane", email: "jane@example.com", phone: "555" }],
  complianceRequest: [] as any[],
});
const redactPayload = { shop_domain: "s", customer: { id: 12, email: "jane@example.com", phone: "555" }, orders_to_redact: [1001, 1002] };

describe("privacy webhooks — recorded for the owner, nothing erased automatically", () => {
  it("normalizes the three topics and ignores anything else", () => {
    expect(normalizeComplianceTopic("CUSTOMERS_REDACT")).toBe("customers/redact");
    expect(normalizeComplianceTopic("customers/data_request")).toBe("customers/data_request");
    expect(normalizeComplianceTopic("CUSTOMERS_DATA_REQUEST")).toBe("customers/data_request");
    expect(normalizeComplianceTopic("SHOP_REDACT")).toBe("shop/redact");
    expect(normalizeComplianceTopic("ORDERS_PAID")).toBeNull();
  });

  it("records a request once with a 30-day due date; a redelivery writes nothing; no customer record is touched", async () => {
    const { db, t, writes } = memoryDb(seedCustomer());
    const before = JSON.stringify([t.quote, t.productionJob, t.wholesaleApplication, t.agentReviewQueueItem]);
    const now = new Date("2026-11-19T12:00:00Z");
    const first = await recordComplianceRequest(db, { shop: "s", topic: "CUSTOMERS_REDACT", webhookId: "wh-1", payload: redactPayload, now });
    const again = await recordComplianceRequest(db, { shop: "s", topic: "CUSTOMERS_REDACT", webhookId: "wh-1", payload: redactPayload, now });
    expect(first.result).toBe("recorded");
    expect(again).toEqual({ result: "duplicate", id: first.id });
    expect(t.complianceRequest).toHaveLength(1);
    expect(t.complianceRequest[0]).toMatchObject({ topic: "customers/redact", customerId: "12", customerEmail: "jane@example.com", status: "received", ordersRequested: '["1001","1002"]' });
    expect((t.complianceRequest[0].dueAt.getTime() - now.getTime()) / 86_400_000).toBe(COMPLIANCE_DUE_DAYS);
    expect(writes).toEqual(["complianceRequest.create"]);
    expect(JSON.stringify([t.quote, t.productionJob, t.wholesaleApplication, t.agentReviewQueueItem])).toBe(before);
    expect((await recordComplianceRequest(db, { shop: "s", topic: "ORDERS_PAID", webhookId: "wh-2", payload: {} })).result).toBe("ignored");
  });

  it("a shop erasure request is only recorded — an uninstall never wipes the ERP", async () => {
    const { db, t, writes } = memoryDb(seedCustomer());
    await recordComplianceRequest(db, { shop: "s", topic: "SHOP_REDACT", webhookId: "wh-9", payload: { shop_id: 1, shop_domain: "s" } });
    expect(writes).toEqual(["complianceRequest.create"]);
    expect(t.quote).toHaveLength(2);
    const applied = await applyCustomerRedaction(db, { shop: "s", requestId: t.complianceRequest[0].id, actor: "owner@gso.test" });
    expect(applied.ok).toBe(false);
  });

  it("the preview matches by exact e-mail (any case) and exact customer id — never a partial id", async () => {
    const { db } = memoryDb(seedCustomer());
    expect(customerIdForms("12")).toEqual(["12", "gid://shopify/Customer/12"]);
    expect(await planCustomerRedaction(db, "s", { customerId: "12", customerEmail: "JANE@example.com" })).toEqual({ quotes: 1, productionJobs: 1, wholesaleApplications: 1, leads: 1, total: 4, matchable: true });
    expect(await planCustomerRedaction(db, "s", { customerId: "12", customerEmail: null })).toMatchObject({ wholesaleApplications: 1, total: 1 }); // not customer 123
    expect(await planCustomerRedaction(db, "s", {})).toMatchObject({ matchable: false, total: 0 });
    expect(complianceFacts({})).toEqual({ customerId: null, customerEmail: null, customerPhone: null, ordersRequested: [] });
  });

  it("the owner's erasure blanks contact fields, keeps every record, and is audited; other customers are untouched", async () => {
    const { db, t } = memoryDb(seedCustomer());
    const { id } = await recordComplianceRequest(db, { shop: "s", topic: "customers/redact", webhookId: "wh-1", payload: redactPayload });
    expect((await applyCustomerRedaction(db, { shop: "s", requestId: id!, actor: "" })).ok).toBe(false);
    const result = await applyCustomerRedaction(db, { shop: "s", requestId: id!, actor: "owner@gso.test" });
    expect(result.ok).toBe(true);
    expect(t.quote[0]).toMatchObject({ id: "q1", customerName: REDACTED_TEXT, email: null, phone: null, notes: "keep" });
    expect(t.quote[1]).toMatchObject({ customerName: "Other", email: "other@example.com" });
    expect(t.productionJob[0]).toMatchObject({ jobTicket: "GSO-20261119-0042", customerName: REDACTED_TEXT, email: null, proofCustomerEmail: null });
    expect(t.wholesaleApplication[0]).toMatchObject({ email: REDACTED_TEXT, phone: null });
    expect(t.wholesaleApplication[1]).toMatchObject({ email: "x@example.com", phone: "9" });
    expect([t.quote.length, t.productionJob.length, t.wholesaleApplication.length, t.agentReviewQueueItem.length]).toEqual([2, 1, 2, 1]);
    expect(t.complianceRequest[0]).toMatchObject({ status: "completed", completedBy: "owner@gso.test", customerEmail: null });
    expect(t.complianceRequest[0].resultSummary).toContain("Records kept");
    expect((await applyCustomerRedaction(db, { shop: "s", requestId: id!, actor: "owner@gso.test" })).ok).toBe(false); // not twice
  });

  it("a data request is closed by hand with a note", async () => {
    const { db, t } = memoryDb(seedCustomer());
    const { id } = await recordComplianceRequest(db, { shop: "s", topic: "customers/data_request", webhookId: "wh-3", payload: redactPayload });
    expect((await closeComplianceRequest(db, { shop: "s", requestId: id!, actor: "owner", note: "" })).ok).toBe(false);
    expect((await closeComplianceRequest(db, { shop: "s", requestId: id!, actor: "owner", note: "Data sent by e-mail 2026-11-20" })).ok).toBe(true);
    expect(t.complianceRequest[0].status).toBe("completed");
  });

  it("the webhook verifies the signature, records, and asks Shopify to retry when it cannot record; the page is owner only", () => {
    const hook = readFileSync("app/routes/webhooks.compliance.ts", "utf8");
    expect(hook.indexOf("authenticate.webhook(request)")).toBeGreaterThan(0);
    expect(hook.indexOf("await recordComplianceRequest(")).toBeGreaterThan(hook.indexOf("authenticate.webhook(request)"));
    expect(hook).toContain("status: 500");
    expect(hook).not.toMatch(/deleteMany|\.delete\(/);
    const page = readFileSync("app/routes/app.erp.privacy-requests.tsx", "utf8");
    expect(page.match(/requireOwner\(auth\)/g)).toHaveLength(2);
    expect(readFileSync("app/lib/privacy-compliance.server.ts", "utf8")).not.toMatch(/deleteMany|\.delete\(/);
    const sql = readFileSync("prisma/migrations/20261119200000_add_compliance_requests/migration.sql", "utf8").replace(/^--.*$/gm, "");
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
  });
});

describe("RIP actuals per production run — linked by the run token the press reports", () => {
  const TICKET = "GSO-20261119-0042-01";
  const runs = [
    { itemId: "i1", runNumber: 1, kind: "original", quantity: 500, runLabel: "A1" },
    { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, runLabel: "P1-A1" },
    { itemId: "i1", runNumber: 3, kind: "remake", quantity: 5, runLabel: "R2-P2-A1" },
  ];

  it("reads the reprint number from the end of the name, with or without an extension", () => {
    expect(reprintNumberOfRipName(`${TICKET}__crud_HEATH_F_CMYK`)).toBe(0);
    expect(reprintNumberOfRipName(`${TICKET}__crud_HEATH_F_CMYK__A2.pdf`)).toBe(0);
    expect(reprintNumberOfRipName(`${TICKET}__crud_HEATH_F_CMYK__P1-A1.pdf`)).toBe(1);
    expect(reprintNumberOfRipName(`${TICKET}__crud_HEATH_F_g__R2-P2-A3`)).toBe(2);
    expect(reprintNumberOfRipName("crud_P1-A1_notatoken.pdf")).toBe(0);
    expect(runs.map(reprintNumberOfRun)).toEqual([0, 1, 2]);
  });

  it("agrees with the routing module's own run grammar for every name it can produce", () => {
    const base = ripFileBaseName({ ripJobName: TICKET, itemTicket: TICKET, suggestedFileName: null } as any, "crud_HEATH_F_CMYK.pdf");
    for (const run of [{ revision: 1, reprint: 0, attempt: 1 }, { revision: 1, reprint: 1, attempt: 1 }, { revision: 2, reprint: 3, attempt: 2 }, { revision: 3, reprint: 0, attempt: 4 }]) {
      const name = applyRunSuffix(base, run);
      expect(reprintNumberOfRipName(name), name).toBe(parseRunIdentity(name).reprint);
      expect(parseRipTickets(name).itemTicket, name).toBe(TICKET); // the result still matches the exact item
      expect(name.length).toBeLessThanOrEqual(120);
      expect(name).not.toMatch(/[<>:"/\\|?*]/); // legal on Windows
    }
  });

  it("original and each reprint carry their own ink and time; both layers of a run add up; nothing is guessed", () => {
    const entries = [
      { sourceJobName: `${TICKET}__crud_HEATH_F_CMYK.pdf`, inkMl: 40, printMinutes: 12, sqft: 30 },
      { sourceJobName: `${TICKET}__crud_HEATH_F_g.pdf`, inkMl: 15, printMinutes: 9, sqft: 30 },
      { sourceJobName: `${TICKET}__crud_HEATH_F_CMYK__P1-A1.pdf`, inkMl: 2, printMinutes: 1, sqft: 1.5 },
      { sourceJobName: `${TICKET}__crud_HEATH_F_g__P1-A1.pdf`, inkMl: 0.8, printMinutes: 0.5, sqft: 1.5 },
      { sourceJobName: `${TICKET}__crud_HEATH_F_CMYK__P7-A1.pdf`, inkMl: 1, printMinutes: 1, sqft: 1 },
    ];
    const result = actualsByRun(runs, entries);
    expect(result.map((row) => [row.label, row.entries, Number(row.inkMl.toFixed(2)), row.printMinutes])).toEqual([
      ["Run 1 — Original", 2, 55, 21],
      ["Run 2 — Reprint", 2, 2.8, 1.5],
      ["Reprint P7 — no run recorded", 1, 1, 1],
    ]);
    expect(result.reduce((sum, row) => sum + row.inkMl, 0)).toBeCloseTo(58.8, 6); // no entry dropped or counted twice
    expect(actualsByRun([], [{ sourceJobName: `${TICKET}.pdf`, inkMl: 3, printMinutes: 1 }])).toMatchObject([{ label: "Run 1 — Original", runNumber: 1 }]);
    expect(actualsByRun(runs, [])).toEqual([]);
  });
});

describe("hand-added files — linked to an item only when certain", () => {
  const route = readFileSync("app/routes/app.erp.production.tsx", "utf8");
  it("uses the chosen item only if it belongs to the job, else the only item of a single-item job, else none", () => {
    const helper = route.slice(route.indexOf("const fileItemIdFor"), route.indexOf('if (intent === "addFile") {'));
    expect(helper).toContain("where: { shop, jobId }");
    expect(helper).toContain("if (wanted) return items.some((item) => item.id === wanted) ? wanted : null;");
    expect(helper).toContain("return items.length === 1 ? items[0].id : null;");
    expect(route).toContain('productionJobItemId: await fileItemIdFor(jobId, String(formData.get("fileItemId") || "")),');
  });
});

describe("frozen by the owner on 2026-11-19 — application timings are unchanged", () => {
  it("jar and bag application seconds are exactly the values in force", async () => {
    const jars = await import("../app/lib/jar-cost-inputs.server");
    const bags = await import("../app/lib/bag-cost-inputs.server");
    expect(jars.JAR_APPLICATION_SECONDS_BY_SIZE).toEqual({
      "50ml": { side: 12, lid: 10, tamper: 12 }, "100ml_tall": { side: 12, lid: 10, tamper: 12 }, "100ml_wide": { side: 12, lid: 10, tamper: 12 },
      "150ml": { side: 13, lid: 10, tamper: 12 }, "250ml": { side: 15, lid: 10, tamper: 12 }, "3oz": { side: 10, lid: 8, tamper: null }, "4oz": { side: 10, lid: 8, tamper: null },
      ceres_50ml: { side: 12, lid: 10, tamper: 12 }, ceres_100ml: { side: 12, lid: 10, tamper: 12 },
    });
    expect(jars.APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(bags.BAG_APPLICATION_SECONDS_PER_SIDE).toBe(10);
    expect(bags.BAG_APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(bags.bagApplicationSecondsPerBag("pound_bag_14x16", 1)).toBe(72); // 50 bags / hour
    expect(bags.bagApplicationSecondsPerBag("pound_bag_14x16", 2)).toBe(120); // 30 bags / hour
  });
});
