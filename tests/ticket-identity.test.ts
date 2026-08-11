// Phase 15H.1 — production ticket identity foundation.
// The DB unique indexes (shop, jobTicket) / (shop, itemTicket) are the FINAL
// authority; these tests pin the allocator, the transaction-level P2002
// retry, fail-closed behaviors, and the retirement of every stray generator.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocateJobTicket,
  createOrReusePrintIntakeJob,
  createProductionJobFromSource,
  isTicketUniqueViolation,
  itemTicketFor,
  runWithTicketRetry,
} from "../app/lib/production-job-source.server";

const JOB_TICKET_CANONICAL = /^GSO-\d{8}-\d{4}$/;
const ITEM_TICKET_CANONICAL = /^GSO-\d{8}-\d{4}-\d{2}$/;

function ticketP2002(target: unknown = ["shop", "jobTicket"]) {
  const error: any = new Error("Unique constraint failed");
  error.code = "P2002";
  error.meta = { target };
  return error;
}

// Minimal fake tx for the allocator alone.
function allocatorTx(existingTickets: string[], countToday: number) {
  return {
    productionJob: {
      count: async () => countToday,
      findFirst: async ({ where }: any) => (existingTickets.includes(where.jobTicket) ? { id: "x" } : null),
    },
  };
}

// Minimal fake db for full service calls: no-op advisory lock, in-memory jobs.
function serviceDb(seedJobs: any[] = [], failCreateWithTicketP2002Times = 0) {
  const jobs = [...seedJobs];
  let remainingFailures = failCreateWithTicketP2002Times;
  let id = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    productionJob: {
      count: async () => jobs.length,
      findFirst: async ({ where }: any) =>
        jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
      create: async ({ data }: any) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          // Simulate another source committing the same ticket between the
          // probe and the insert — the DB unique index fires.
          jobs.push({ id: `racer_${++id}`, shop: data.shop, jobTicket: data.jobTicket });
          throw ticketP2002();
        }
        const job = { id: `job_${++id}`, ...data, items: (data.items?.create || []).map((item: any, i: number) => ({ id: `item_${i}`, ...item })) };
        jobs.push(job);
        return job;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.find((row) => row.id === where.id);
        if (job) Object.assign(job, data);
        return job;
      },
    },
    productionJobFile: { create: async () => ({}) },
    productionJobEvent: { create: async () => ({}) },
    quote: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    printIntake: { findUnique: async () => null, create: async ({ data }: any) => ({ id: "pi_1", ...data }), update: async ({ data }: any) => ({ id: "pi_1", ...data }) },
  };
  return { db: { $transaction: async (fn: any) => fn(tx), printIntake: tx.printIntake }, jobs };
}

describe("15H.1 ticket identity foundation", () => {
  it("1+3. allocator emits canonical GSO-YYYYMMDD-NNNN, sequentially, skipping collisions", async () => {
    expect(await allocateJobTicket(allocatorTx([], 0), "shop")).toMatch(/^GSO-\d{8}-0001$/);
    expect(await allocateJobTicket(allocatorTx([], 4), "shop")).toMatch(/^GSO-\d{8}-0005$/);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const busy = await allocateJobTicket(allocatorTx([`GSO-${stamp}-0005`], 4), "shop");
    expect(busy).toBe(`GSO-${stamp}-0006`);
    expect(busy).toMatch(JOB_TICKET_CANONICAL);
  });

  it("allocator FAILS CLOSED on exhaustion — the non-canonical epoch fallback is gone", async () => {
    const alwaysTaken = {
      productionJob: { count: async () => 0, findFirst: async () => ({ id: "taken" }) },
    };
    await expect(allocateJobTicket(alwaysTaken as any, "shop")).rejects.toThrow(/ticket_allocation_exhausted/);
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(source.includes("Date.now()).slice(-6)")).toBe(false);
  });

  it("2+11. item tickets stay canonical GSO-YYYYMMDD-NNNN-NN and unique within a job", () => {
    const tickets = Array.from({ length: 12 }, (_, index) => itemTicketFor("GSO-20260811-0007", index));
    expect(tickets[0]).toBe("GSO-20260811-0007-01");
    expect(tickets[11]).toBe("GSO-20260811-0007-12");
    for (const ticket of tickets) expect(ticket).toMatch(ITEM_TICKET_CANONICAL);
    expect(new Set(tickets).size).toBe(tickets.length);
  });

  it("5. runWithTicketRetry retries ONLY ticket-constraint P2002s, bounded, and rethrows everything else", async () => {
    let calls = 0;
    const eventuallyOk = async () => {
      calls += 1;
      if (calls < 3) throw ticketP2002(["shop", "itemTicket"]);
      return "ok";
    };
    await expect(runWithTicketRetry(eventuallyOk)).resolves.toBe("ok");
    expect(calls).toBe(3);

    let alwaysCalls = 0;
    const alwaysFails = async () => {
      alwaysCalls += 1;
      throw ticketP2002();
    };
    await expect(runWithTicketRetry(alwaysFails)).rejects.toMatchObject({ code: "P2002" });
    expect(alwaysCalls).toBe(3);

    let hashCalls = 0;
    const hashConflict = async () => {
      hashCalls += 1;
      throw ticketP2002(["shop", "fileHashSha256"]);
    };
    await expect(runWithTicketRetry(hashConflict)).rejects.toMatchObject({ code: "P2002" });
    expect(hashCalls).toBe(1); // not a ticket violation — no retry

    expect(isTicketUniqueViolation(ticketP2002("ProductionJob_shop_jobTicket_key"))).toBe(true);
    expect(isTicketUniqueViolation({ code: "P2001" })).toBe(false);
  });

  it("4+6. a cross-source ticket race resolves to two DISTINCT tickets via the transaction retry", async () => {
    const { db, jobs } = serviceDb([], 1); // first create hits the unique index
    const result = await createProductionJobFromSource(db, {
      shop: "shop.test",
      source: { type: "manual_admin", authorizedBy: "owner", payload: { customerName: "Test", items: [{ productTitle: "Thing", quantity: 1 }] } },
    });
    expect(result.created).toBe(true);
    const racer = jobs.find((job) => String(job.id).startsWith("racer_"));
    expect(racer).toBeTruthy();
    expect(result.job.jobTicket).toMatch(JOB_TICKET_CANONICAL);
    expect(result.job.jobTicket).not.toBe(racer.jobTicket); // regenerated, never reused
  });

  it("7. paid-order source without a stable Shopify identity FAILS CLOSED (no Date.now fallback)", async () => {
    await expect(
      createProductionJobFromSource({} as any, { shop: "shop.test", source: { type: "shopify_order", order: {} } }),
    ).rejects.toThrow(/stable order identity/);
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(/shopify_order_\$\{[^}]*Date\.now\(\)/.test(source)).toBe(false);
  });

  it("9. paid-order path stays idempotent on the stable source key", async () => {
    const orderGid = "gid://shopify/Order/12345";
    const { db } = serviceDb([{ id: "existing", shop: "shop.test", quoteId: `shopify_order_${orderGid}` }]);
    const result = await createProductionJobFromSource(db, {
      shop: "shop.test",
      source: { type: "shopify_order", order: { admin_graphql_api_id: orderGid, line_items: [] } },
    });
    expect(result.created).toBe(false);
    expect(result.job.id).toBe("existing");
  });

  it("8. quote path returns the existing job instead of a second one", async () => {
    const { db } = serviceDb([{ id: "quote_job", shop: "shop.test", quoteId: "quoteA" }]);
    const result = await createProductionJobFromSource(db, { shop: "shop.test", source: { type: "erp_quote", quoteId: "quoteA" } });
    expect(result.created).toBe(false);
    expect(result.job.id).toBe("quote_job");
  });

  it("10. print-intake path stays hash-idempotent (fast path returns the existing identity)", async () => {
    const existing = { id: "pi_9", generatedProductionJobId: "job_9", authoritativeTicket: "GSO-20260811-0009", routedFilename: "GSO-20260811-0009__ROLAND__GLOSS-3X__FILE__A1" };
    const db = { printIntake: { findUnique: async () => existing }, $transaction: async () => { throw new Error("must not open a transaction on the fast path"); } };
    const result = await createOrReusePrintIntakeJob(db, {
      shop: "shop.test",
      fileName: "whatever.pdf",
      fileHash: "a".repeat(64),
      machine: "roland",
      machineRule: "white_or_gloss",
      mode: "GLOSS-3X",
    });
    expect(result).toMatchObject({ created: false, productionJobId: "job_9", jobTicket: "GSO-20260811-0009" });
  });

  it("12. simulator fails closed against production and cannot mint tickets", () => {
    const simulator = readFileSync("tools/simulate-paid-configurator-order.mjs", "utf8");
    expect(simulator).toContain("YES_I_UNDERSTAND_THIS_WRITES_PRODUCTION");
    expect(simulator).toContain('databaseUrl.startsWith("file:")');
    expect(simulator).toContain("process.exit(3)");
    expect(simulator.includes("buildNextJobTicket")).toBe(false);
    expect(simulator.includes('padStart(4, "0")')).toBe(false);
  });

  it("13. backfill uses the central allocator inside the standard retry", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain("allocateJobTicket, createProductionJobFromSource");
    expect(board).toContain("runWithTicketRetry(() =>");
    expect(board).toContain("allocateJobTicket(tx, shop");
    expect(board.includes("async function buildNextJobTicket")).toBe(false);
  });

  it("14. no duplicate ticket-generation algorithm remains outside the authoritative service", () => {
    const central = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(central).toContain('String(sequence).padStart(4, "0")');
    for (const file of ["app/routes/app.erp.production.tsx", "tools/simulate-paid-configurator-order.mjs"]) {
      const text = readFileSync(file, "utf8");
      expect(text.includes('String(sequence).padStart(4, "0")')).toBe(false);
      expect(text.includes("GSO-${stamp}")).toBe(false);
    }
  });
});
