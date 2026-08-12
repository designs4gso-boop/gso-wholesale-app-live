// Phase 15H.4B — manual / walk-in / internal production jobs.
// Pins: requestId idempotency (no Date.now), validation fail-closed,
// canonical machine resolution (no duplicated routing logic), ticket
// canonicality, item mapping, Print Intake resolvability, and untouched
// neighboring systems.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANUAL_JOB_FAMILIES,
  MANUAL_JOB_FINISHES,
  createProductionJobFromSource,
  validateManualJobInput,
} from "../app/lib/production-job-source.server";
import { decideIntakeRoute } from "../app/lib/print-intake-routing.server";

function fakeDb(seedJobs: any[] = []) {
  const jobs = [...seedJobs];
  const creates: any[] = [];
  let id = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    productionJob: {
      count: async () => jobs.length,
      findFirst: async ({ where }: any) => jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
      create: async ({ data }: any) => {
        const job = { id: `job_${++id}`, ...data, items: (data.items?.create || []).map((item: any, i: number) => ({ id: `item_${i}`, ...item })) };
        jobs.push(job);
        creates.push(data);
        return job;
      },
      update: async ({ where, data }: any) => jobs.find((row) => row.id === where.id),
    },
    productionJobFile: { create: async () => ({}) },
    productionJobEvent: { create: async () => ({}) },
    quote: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    printIntake: { findUnique: async () => null },
  };
  return { db: { $transaction: async (fn: any) => fn(tx), $queryRawUnsafe: async () => [] }, jobs, creates };
}

const manualSource = (over: Record<string, any> = {}, itemOver: Record<string, any> = {}) => ({
  type: "manual_admin" as const,
  authorizedBy: "owner@shop",
  requestId: "11111111-2222-3333-4444-555555555555",
  payload: {
    customerName: "Walk-in — Jane D.",
    items: [{ productTitle: "Manual CMYK Test", quantity: 10, family: "default", finish: "CMYK", printer: "auto" as const, ...itemOver }],
    ...over,
  },
});

describe("15H.4B manual job creation", () => {
  it("1-4+G. one job, one item, canonical tickets, family checklist, audit event", async () => {
    const { db, creates } = fakeDb();
    const result = await createProductionJobFromSource(db, { shop: "shop.test", source: manualSource({ reference: "WI-100", dueDate: "2026-08-20" }, { family: "sticker-bags", sku: "SKU9", size: '4" x 5"' }) });
    expect(result.created).toBe(true);
    expect(creates).toHaveLength(1);
    const data = creates[0];
    expect(data.jobTicket).toMatch(/^GSO-\d{8}-\d{4}$/);
    expect(data.quoteId).toBe("manual_11111111-2222-3333-4444-555555555555");
    expect(data.quoteNumber).toBe("WI-100");
    expect(data.dueDate).toBeInstanceOf(Date);
    expect(data.internalNotes).toContain("Source: manual_admin | Request: 11111111-2222-3333-4444-555555555555");
    expect(data.items.create).toHaveLength(1);
    const item = data.items.create[0];
    expect(item.itemTicket).toMatch(/^GSO-\d{8}-\d{4}-01$/);
    expect(item.ripJobName).toBe(item.itemTicket);
    expect(item.suggestedFileName).toContain(item.itemTicket);
    expect(item.materialSummary).toContain("Family: Stock Bags");
    expect(item.materialSummary).toContain('Size: 4" x 5"');
    expect(item.machineSummary).toBe("Mimaki UCJV300-130");
    expect(item.unitPrice).toBe(0); // never fabricated
    expect(item.unitCost).toBe(0);
    expect(data.status).toBe("new");
    // family checklist applied (sticker-bags has the Labels applied step)
    expect(data.checklistItems.create.some((check: any) => /applied to bags/i.test(check.label))).toBe(true);
    expect(data.events.create[0].eventType).toBe("created_manual_admin");
    expect(data.events.create[0].message).toContain("requested auto");
  });

  it("5+6. same requestId retried / double-clicked -> same job, no duplicate", async () => {
    const { db, creates } = fakeDb();
    const first = await createProductionJobFromSource(db, { shop: "shop.test", source: manualSource() });
    const retry = await createProductionJobFromSource(db, { shop: "shop.test", source: manualSource() });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
    expect(creates).toHaveLength(1);
  });

  it("7-11+M. validation fails closed", async () => {
    const { db } = fakeDb();
    await expect(createProductionJobFromSource(db, { shop: "s", source: { ...manualSource(), requestId: "" } as any })).rejects.toThrow(/requestId/);
    expect(validateManualJobInput({ requestId: "short", customerName: "x", items: [{ productTitle: "t", quantity: 1 }] }).ok).toBe(false);
    expect((validateManualJobInput({ requestId: "12345678", customerName: "", items: [{ productTitle: "t", quantity: 1 }] }) as any).reason).toContain("customer name");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [] }) as any).reason).toContain("At least one item");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "", quantity: 1 }] }) as any).reason).toContain("product name");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: 0 }] }) as any).reason).toContain("Quantity");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: -5 }] }) as any).reason).toContain("Quantity");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: 1, family: "nope" }] }) as any).reason).toContain("Unknown production family");
    expect((validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: 1, printer: "hp" as any }] }) as any).reason).toContain("Unknown printer");
  });

  it("12-17+E. machine resolution delegates to the canonical decider", () => {
    const resolve = (finish: string, printer: any) => {
      const verdict = validateManualJobInput({ requestId: "12345678", customerName: "c", items: [{ productTitle: "t", quantity: 1, finish, printer }] });
      return verdict.ok ? `${verdict.items[0].resolvedMachine}:${verdict.items[0].machineRule}` : `REJECT:${(verdict as any).reason}`;
    };
    expect(resolve("CMYK", "auto")).toBe("mimaki:default_cmyk");
    expect(resolve("CMYK", "roland")).toBe("roland:explicit_erp_machine");
    expect(resolve("CMYK", "mimaki")).toBe("mimaki:explicit_erp_machine");
    expect(resolve("White", "auto")).toBe("roland:white_or_gloss");
    expect(resolve("Gloss", "auto")).toBe("roland:white_or_gloss");
    expect(resolve("White + Gloss", "auto")).toBe("roland:white_or_gloss");
    expect(resolve("White", "roland")).toBe("roland:white_or_gloss");
    expect(resolve("White", "mimaki")).toContain("REJECT");
    expect(resolve("Gloss", "mimaki")).toContain("REJECT");
  });

  it("18-20+K. Print Intake resolves the manual job by item ticket, job ticket, and suggested filename", async () => {
    const { db, creates } = fakeDb();
    await createProductionJobFromSource(db, { shop: "shop.test", source: manualSource({}, { finish: "Gloss", printer: "auto" }) });
    const data = creates[0];
    const item = data.items.create[0];
    const intakeJob = {
      id: "j1", jobTicket: data.jobTicket, customerName: data.customerName, company: null, status: "new",
      artworkUrl: null, printFileUrl: null,
      items: [{ id: "i1", itemTicket: item.itemTicket, ripJobName: item.ripJobName, suggestedFileName: item.suggestedFileName, productTitle: item.productTitle, selectedFinish: item.selectedFinish, materialSummary: item.materialSummary, machineSummary: item.machineSummary }],
      fileNames: [],
    };
    const byItem = decideIntakeRoute({ fileName: `${item.itemTicket}_final.pdf`, jobs: [intakeJob] });
    expect(byItem.decision).toBe("route");
    expect(byItem.machine).toBe("roland"); // gloss manual job routes Roland at intake too
    expect(decideIntakeRoute({ fileName: `${data.jobTicket}.pdf`, jobs: [intakeJob] }).decision).toBe("route");
    expect(decideIntakeRoute({ fileName: `${item.suggestedFileName}.pdf`, jobs: [intakeJob] }).decision).toBe("route");
    expect(decideIntakeRoute({ fileName: "artwork.pdf", subfolder: `${data.jobTicket} - WALKIN`, jobs: [intakeJob] }).decision).toBe("route");
  });

  it("24. no Date.now-based manual source key remains; UI carries the requestId", () => {
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(/manual_\$\{[^}]*Date\.now/.test(source)).toBe(false);
    expect(source).toContain("sourceKey = `manual_${requestId}`");
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain('value="createManualJob"');
    expect(board).toContain("manualRequestId: crypto.randomUUID()");
    expect(board).toContain('name="requestId" value={manualRequestId}');
    expect(board).toContain("Copy Print File Name");
  });

  it("21-23. RIP matcher, pricing, and order convergence untouched", () => {
    expect(readFileSync("app/lib/rip-identity-match.server.ts", "utf8")).toContain("exact_item_ticket");
    expect(readFileSync("app/lib/commercial-pricing-policy.server.ts", "utf8")).toContain("BAGS_4X5_FRONT_LADDER");
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(source).toContain('sourceKey = `shopify_order_${stableOrderId}`');
    expect(source).toContain("parseCanonicalOrderLine");
    // vocabulary sanity: canonical families + finishes exported for the UI
    expect(MANUAL_JOB_FAMILIES.some((family) => family.value === "sticker-bags")).toBe(true);
    expect(MANUAL_JOB_FINISHES).toContain("CMYK");
  });
});
