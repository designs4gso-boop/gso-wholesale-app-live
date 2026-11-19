// Order-to-production O3 (2026-11-19) — several items on ONE manual job.
// An invoice often holds many designs; each is its own production item with its
// own item ticket under one master job. Same central service, same idempotency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANUAL_JOB_MAX_ITEMS,
  createProductionJobFromSource,
  parseAdditionalManualItems,
  validateManualJobInput,
} from "../app/lib/production-job-source.server";
import { decideIntakeRoute } from "../app/lib/print-intake-routing.server";

function fakeDb() {
  const jobs: any[] = [];
  let id = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    productionJob: {
      count: async () => jobs.length,
      findFirst: async ({ where }: any) => jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
      create: async ({ data }: any) => {
        const job = { id: `job_${++id}`, ...data, items: (data.items?.create || []).map((item: any, i: number) => ({ id: `item_${i + 1}`, ...item })) };
        jobs.push(job);
        return job;
      },
    },
    productionJobFile: { create: async () => ({}) },
    productionJobEvent: { create: async () => ({}) },
  };
  return { db: { $transaction: async (fn: any) => fn(tx), $queryRawUnsafe: async () => [] }, jobs };
}

const base = { quantity: 500, family: "default", finish: "CMYK", printer: "mimaki" as const, size: "" };
const source = (items: any[], requestId = "aaaaaaaa-1111-2222-3333-444444444444") => ({
  type: "manual_admin" as const,
  authorizedBy: "owner@shop",
  requestId,
  payload: { customerName: "CRUD", reference: "QuickBooks invoice 1270", items },
});

describe("extra items typed one per line", () => {
  it("1. name | quantity per line; a missing quantity takes the first item's; shared family / finish / printer", () => {
    const parsed = parseAdditionalManualItems("SHORTCAKES pouch | 500\n\n  MIXED BERRIES jar|250  \nGUMBO\nBIG RUN | 1,280", base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((item) => [item.productTitle, item.quantity])).toEqual([["SHORTCAKES pouch", 500], ["MIXED BERRIES jar", 250], ["GUMBO", 500], ["BIG RUN", 1280]]);
    expect(parsed.items.every((item) => item.family === "default" && item.finish === "CMYK" && item.printer === "mimaki")).toBe(true);
    expect(parseAdditionalManualItems("", base)).toEqual({ ok: true, items: [] });
  });

  it("2. a bad line rejects the form with its line number — nothing is guessed", () => {
    expect(parseAdditionalManualItems("A | 10\nB | ten", base)).toEqual({ ok: false, reason: "More items, line 2: quantity must be a whole number greater than zero." });
    expect(parseAdditionalManualItems("A | 0", base).ok).toBe(false);
    expect(parseAdditionalManualItems("A | 1 | 2", base).ok).toBe(false);
    expect(parseAdditionalManualItems(" | 5", base).ok).toBe(false);
  });

  it("3. item tickets are two digits, so a job is capped", () => {
    expect(MANUAL_JOB_MAX_ITEMS).toBe(50);
    expect(parseAdditionalManualItems(Array.from({ length: 49 }, (_, i) => `D${i}`).join("\n"), base).ok).toBe(true);
    expect(parseAdditionalManualItems(Array.from({ length: 50 }, (_, i) => `D${i}`).join("\n"), base).ok).toBe(false);
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ productTitle: `D${i}`, quantity: 1, printer: "mimaki" as const }));
    expect(validateManualJobInput({ requestId: "aaaaaaaa-1111", customerName: "X", items: tooMany }).ok).toBe(false);
  });
});

describe("one transaction -> one master job -> one item ticket per item", () => {
  const items = [
    { productTitle: "HEATH pouch", ...base },
    { productTitle: "SHORTCAKES pouch", ...base },
    { productTitle: "MIXED BERRIES jar", ...base, quantity: 250 },
  ];

  it("4. three items -> ONE job with -01 / -02 / -03 in order, quantities kept, reference kept", async () => {
    const { db, jobs } = fakeDb();
    const result = await createProductionJobFromSource(db as any, { shop: "shop.test", source: source(items) });
    expect(result.created).toBe(true);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job.jobTicket).toMatch(/^GSO-\d{8}-\d{4}$/);
    expect(job.quoteNumber).toBe("QuickBooks invoice 1270");
    expect(job.items.map((item: any) => item.itemTicket)).toEqual([`${job.jobTicket}-01`, `${job.jobTicket}-02`, `${job.jobTicket}-03`]);
    expect(job.items.map((item: any) => item.ripJobName)).toEqual(job.items.map((item: any) => item.itemTicket));
    expect(job.items.map((item: any) => item.quantity)).toEqual([500, 500, 250]);
    expect(job.items.map((item: any) => item.unitPrice)).toEqual([0, 0, 0]); // no price is invented
  });

  it("5. the same request retried returns the same job — no duplicate", async () => {
    const { db, jobs } = fakeDb();
    const first = await createProductionJobFromSource(db as any, { shop: "shop.test", source: source(items) });
    const again = await createProductionJobFromSource(db as any, { shop: "shop.test", source: source(items) });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(jobs).toHaveLength(1);
  });

  it("6. an invalid item creates nothing", async () => {
    const { db, jobs } = fakeDb();
    await expect(createProductionJobFromSource(db as any, { shop: "shop.test", source: source([...items, { productTitle: "", ...base }]) })).rejects.toThrow(/Item \/ product name is required/);
    expect(jobs).toHaveLength(0);
  });

  it("7. files for the multi-item job: an item ticket picks the item, the folder alone waits for a person", async () => {
    const { db, jobs } = fakeDb();
    await createProductionJobFromSource(db as any, { shop: "shop.test", source: source(items) });
    const job = jobs[0];
    const intakeJob = { id: job.id, jobTicket: job.jobTicket, customerName: "CRUD", company: null, status: "new", artworkUrl: null, printFileUrl: null, fileNames: [], items: job.items.map((item: any) => ({ id: item.id, itemTicket: item.itemTicket, ripJobName: item.ripJobName, suggestedFileName: item.suggestedFileName, productTitle: item.productTitle, selectedFinish: item.selectedFinish, materialSummary: item.materialSummary, machineSummary: item.machineSummary })) };
    const folder = `${job.jobTicket} CRUD`;
    const exact = decideIntakeRoute({ fileName: `${job.jobTicket}-02_crud_SHORTCAKES_F.pdf`, subfolder: folder, jobs: [intakeJob] });
    expect(exact.decision).toBe("route");
    expect(exact.itemTicket).toBe(`${job.jobTicket}-02`);
    expect(exact.ripName).toBe(`${job.jobTicket}-02__crud_SHORTCAKES_F`);
    const loose = decideIntakeRoute({ fileName: "crud_SHORTCAKES_F.pdf", subfolder: folder, jobs: [intakeJob] });
    expect(loose.decision).toBe("review");
    expect(loose.reasons).toContain("folder_job_has_multiple_items_needs_link_to_item");
  });

  it("8. the New Job form posts the extra items through the same central service", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8").replace(/\r\n/g, "\n");
    expect(board).toContain('name="moreItems"');
    expect(board).toContain('parseAdditionalManualItems(String(formData.get("moreItems") || ""), firstItem)');
    expect(board).toContain("}, ...moreItems.items],");
    expect(board).toContain("Copy Job Folder Name");
    expect(board).not.toContain("Gloss on the Mimaki is rejected");
  });
});
