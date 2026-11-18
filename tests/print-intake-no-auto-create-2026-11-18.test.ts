// Print Intake Patch C (2026-11-18) — a dropped print file can NEVER create a
// ProductionJob. An unmatched file gets a PrintIntake review row ("NEEDS
// REVIEW — LINK TO JOB"), no printer and no route, and waits for a person to
// assign it to a job that already exists. Deterministic matching to existing
// jobs and the manual Assign flow are unchanged.
//
// These tests drive the real route-plan action and the real Incoming Print
// Files action against an in-memory database (no live data).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

type Row = Record<string, any>;
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], events: [], writes: [], seq: 0 };

vi.mock("../app/db.server", () => {
  const stamp = () => new Date();
  const findIntake = (where: any) => {
    if (where?.shop_fileHashSha256) return state.intakes.find((row) => row.shop === where.shop_fileHashSha256.shop && row.fileHashSha256 === where.shop_fileHashSha256.fileHashSha256) ?? null;
    return state.intakes.find((row) => (!where?.id || row.id === where.id) && (!where?.shop || row.shop === where.shop)) ?? null;
  };
  const printIntake = {
    findUnique: async ({ where }: any) => findIntake(where),
    findFirst: async ({ where }: any) => {
      if (where?.authoritativeTicket) {
        return state.intakes.find((row) => row.shop === where.shop && row.authoritativeTicket === where.authoritativeTicket && row.status === where.status && row.fileHashSha256 !== where.NOT?.fileHashSha256) ?? null;
      }
      return findIntake(where);
    },
    findMany: async () => state.intakes,
    create: async ({ data }: any) => {
      const row = { id: `pi_${++state.seq}`, matchedProductionJobId: null, generatedProductionJobId: null, authoritativeTicket: null, printer: null, printMode: null, routingRule: null, routedFilename: null, reviewReason: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, createdAt: stamp(), updatedAt: stamp(), ...data };
      state.intakes.push(row);
      state.writes.push("printIntake.create");
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = findIntake(where)!;
      Object.assign(row, data, { updatedAt: stamp() });
      state.writes.push("printIntake.update");
      return row;
    },
    upsert: async ({ where, update, create }: any) => {
      const row = findIntake(where);
      if (row) { Object.assign(row, update); state.writes.push("printIntake.upsert:update"); return row; }
      return printIntake.create({ data: create });
    },
  };
  const productionJob = {
    findMany: async ({ where }: any) => state.jobs.filter((job) => job.shop === where.shop && job.active !== false),
    findFirst: async ({ where }: any) => state.jobs.find((job) => job.id === where.id && job.shop === where.shop && (where.active === undefined || job.active === where.active)) ?? null,
  };
  const forbidden = (model: string) => new Proxy({}, {
    get: (_t, method: string) => async () => {
      if (/^(create|update|upsert|delete)/.test(method)) { state.writes.push(`${model}.${method}`); return {}; }
      return method === "findMany" ? [] : null;
    },
  });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "printLogAutoImportSetting") return { findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null };
      if (key === "productionJob") return new Proxy(productionJob, { get: (target: any, method: string) => target[method] ?? (async () => { state.writes.push(`productionJob.${method}`); return {}; }) });
      if (key === "productionJobEvent") return { create: async ({ data }: any) => { state.events.push(data); return {}; } };
      if (key === "$transaction") return async (fn: any) => { state.writes.push("$transaction"); return fn(db); };
      return forbidden(key);
    },
  });
  return { default: db, db };
});

import { action as routePlan } from "../app/routes/api.print-intake.route-plan";
import { action as intakePageAction } from "../app/routes/app.erp.print-intake";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { NEEDS_LINK_TO_JOB_LABEL, NEEDS_LINK_TO_JOB_REASON, dispositionOf, reviewReasonLabel } from "../app/lib/print-intake-review.server";
import * as jobSource from "../app/lib/production-job-source.server";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function job(overrides: Row = {}): Row {
  return {
    id: "job_1", shop: "shop-1", active: true, status: "new", actualCostFinalized: false,
    jobTicket: "GSO-20261118-0001", customerName: "Real Customer", company: null, artworkUrl: null, printFileUrl: null,
    items: [{ id: "item_1", itemTicket: "GSO-20261118-0001-01", ripJobName: "GSO-20261118-0001-01_JAR_MATTE_QTY40", suggestedFileName: "GSO-20261118-0001-01_JAR_MATTE_QTY40", productTitle: "Jar label", selectedFinish: "Matte", materialSummary: "Matte vinyl", machineSummary: "Mimaki UCJV300-130" }],
    files: [],
    ...overrides,
  };
}
async function plan(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return { status: response.status, body: (await response.json()) as any };
}
async function pageAction(fields: Record<string, string>) {
  return intakePageAction({ request: new Request("https://app.test/app/erp/print-intake", { method: "POST", body: new URLSearchParams(fields) }) }) as Promise<any>;
}
const jobWrites = () => state.writes.filter((write) => /^productionJob|^\$transaction/.test(write));

beforeEach(() => {
  state.settings = [{ shop: "shop-1", uploadToken: TOKEN, enabled: true }];
  state.jobs = [job()];
  state.intakes = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
  authState.sub = "9001";
  process.env[OWNER_USER_IDS_ENV] = "9001";
});

describe("1-5. an unmatched file goes to review and creates nothing", () => {
  it("creates NO ProductionJob, item, event or transaction — only one PrintIntake review row", async () => {
    const { status, body } = await plan({ fileName: "BUTTAWAY_bently_ROLAND.pdf", fileHash: HASH("a"), fileSize: 1234 });
    expect(status).toBe(200);
    expect(jobWrites()).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    expect(state.writes).toEqual(["printIntake.create"]);
    expect(state.intakes).toHaveLength(1);
    const row = state.intakes[0];
    expect(row.status).toBe("review");
    expect(row.reviewReason).toBe(NEEDS_LINK_TO_JOB_REASON);
    expect(row.matchedProductionJobId).toBeNull();
    expect(row.generatedProductionJobId).toBeNull();
    expect(row.printer).toBeNull();
    expect(row.routedFilename).toBeNull();
    expect(row.originalFilename).toBe("BUTTAWAY_bently_ROLAND.pdf");
    expect(body.plan.decision).toBe("review");
  });

  it("returns no printer destination and no route, even when the filename names a press or a gloss mode", async () => {
    for (const [index, fileName] of ["BUTTAWAY_bently_ROLAND.pdf", "Cust_art_MIMAKI.pdf", "GSO PIPELINE TEST_3X SPOT GLOSS_Roland.pdf", "Customer_Product_CMYK.pdf"].entries()) {
      const { body } = await plan({ fileName, fileHash: HASH(String(index)), fileSize: 10 });
      expect(body.plan.decision, fileName).toBe("review");
      expect(body.plan.machine, fileName).toBeNull();
      expect(body.plan.ripName, fileName).toBeNull();
      expect(body.plan.jobId, fileName).toBeNull();
      expect(body.plan.rule, fileName).toBeNull();
      expect(body.plan.autoCreated, fileName).toBe(false);
      expect(body.plan.needsLinkToJob, fileName).toBe(true);
      expect(body.plan.reasons, fileName).toContain(NEEDS_LINK_TO_JOB_REASON);
    }
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    expect(state.intakes.every((row) => row.status === "review" && row.printer === null)).toBe(true);
  });

  it("the agent is told to keep it blocked (not routed) and the queue shows NEEDS REVIEW — LINK TO JOB", async () => {
    await plan({ fileName: "new art.pdf", fileHash: HASH("b"), fileSize: 10 });
    expect(dispositionOf(state.intakes[0] as any)).toEqual({ disposition: "keep_blocked", retryAllowed: false });
    expect(NEEDS_LINK_TO_JOB_LABEL).toBe("NEEDS REVIEW — LINK TO JOB");
    expect(reviewReasonLabel(NEEDS_LINK_TO_JOB_REASON)).toContain("No existing production job matches this file");
    const page = src("app/routes/app.erp.print-intake.tsx");
    expect(page).toContain('needsLinkLabel: row.status === "review" && !row.matchedProductionJobId ? NEEDS_LINK_TO_JOB_LABEL : null,');
    expect(page).toContain("{row.needsLinkLabel ? row.needsLinkLabel : (");
  });

  it("a ticket that is on no eligible job, with no jobs at all, and a file with no hash — all review, no job", async () => {
    expect((await plan({ fileName: "GSO-20200101-0099-01 art.pdf", fileHash: HASH("c") })).body.plan.decision).toBe("review");
    state.jobs = [];
    expect((await plan({ fileName: "anything.pdf", fileHash: HASH("d") })).body.plan.decision).toBe("review");
    const noHash = await plan({ fileName: "nohash.pdf" });
    expect(noHash.body.plan.decision).toBe("review");
    expect(noHash.body.plan.machine).toBeNull();
    expect(jobWrites()).toEqual([]);
    expect(state.intakes).toHaveLength(2); // the hashless file leaves no row, and never a job
  });

  it("two existing jobs that both match stay in review as ambiguous — no controlled job is created", async () => {
    state.jobs = [job({ files: [{ fileName: "shared art.pdf", originalFileName: null }] }), job({ id: "job_2", jobTicket: "GSO-20261118-0002", items: [{ ...job().items[0], id: "item_2", itemTicket: "GSO-20261118-0002-01", ripJobName: "GSO-20261118-0002-01", suggestedFileName: null }], files: [{ fileName: "shared art.pdf", originalFileName: null }] })];
    const { body } = await plan({ fileName: "shared art.pdf", fileHash: HASH("e") });
    expect(body.plan.decision).toBe("review");
    expect(body.plan.machine).toBeNull();
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(2);
    expect(state.intakes[0].status).toBe("review");
    expect(state.intakes[0].matchedProductionJobId).toBeNull();
  });
});

describe("6. repeated polling of the same unmatched file is idempotent", () => {
  it("five identical requests leave one row, one write, no job, no event", async () => {
    const responses = [];
    for (let i = 0; i < 5; i += 1) responses.push((await plan({ fileName: "new art.pdf", fileHash: HASH("f"), fileSize: 99 })).body.plan);
    expect(state.intakes).toHaveLength(1);
    expect(state.writes).toEqual(["printIntake.create"]);
    expect(state.events).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    expect(new Set(responses.map((entry) => JSON.stringify(entry))).size).toBe(1);
    const audit = JSON.parse(state.intakes[0].rawParsedHints).audit;
    expect(audit).toHaveLength(1);
  });

  it("a rejected file stays rejected and a routed file is never downgraded", async () => {
    state.intakes = [
      { id: "pi_r", shop: "shop-1", fileHashSha256: HASH("1"), status: "rejected", originalFilename: "x.pdf", rawParsedHints: null, matchedProductionJobId: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
      { id: "pi_done", shop: "shop-1", fileHashSha256: HASH("2"), status: "routed", originalFilename: "old test.pdf", rawParsedHints: null, matchedProductionJobId: null, generatedProductionJobId: "old_shell_job", authoritativeTicket: "GSO-20260726-0007", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
    ];
    expect((await plan({ fileName: "x.pdf", fileHash: HASH("1") })).body.plan.rejected).toBe(true);
    const old = await plan({ fileName: "old test.pdf", fileHash: HASH("2") });
    expect(old.body.plan.decision).toBe("review"); // an old auto-created shell is not re-routed
    expect(old.body.plan.machine).toBeNull();
    expect(state.intakes.find((row) => row.id === "pi_done")!.status).toBe("routed");
    expect(state.writes).toEqual([]);
  });
});

describe("7-10. deterministic matching to an EXISTING job still routes", () => {
  it("item ticket in the filename", async () => {
    const { body } = await plan({ fileName: "GSO-20261118-0001-01 labels.pdf", fileHash: HASH("a") });
    expect(body.plan).toMatchObject({ decision: "route", rule: "item_ticket", jobId: "job_1", itemId: "item_1", machine: "mimaki", matchedExisting: true, autoCreated: false });
    expect(state.intakes[0]).toMatchObject({ status: "routed", matchedProductionJobId: "job_1", printer: "mimaki" });
    expect(jobWrites()).toEqual([]);
  });
  it("job ticket in the filename (single-item job)", async () => {
    const { body } = await plan({ fileName: "GSO-20261118-0001 labels.pdf", fileHash: HASH("b") });
    expect(body.plan).toMatchObject({ decision: "route", rule: "job_ticket_single_item", jobId: "job_1", machine: "mimaki" });
    expect(jobWrites()).toEqual([]);
  });
  it("exact stored RIP filename", async () => {
    state.jobs = [job({ items: [{ ...job().items[0], ripJobName: "Flame Society Jar Front", suggestedFileName: "Flame Society Jar Front" }] })];
    const { body } = await plan({ fileName: "Flame Society Jar Front.pdf", fileHash: HASH("c") });
    expect(body.plan).toMatchObject({ decision: "route", rule: "stored_filename", jobId: "job_1", itemId: "item_1" });
    expect(jobWrites()).toEqual([]);
  });
  it("exact stored job file name", async () => {
    state.jobs = [job({ files: [{ fileName: "customer upload final.pdf", originalFileName: null }] })];
    const { body } = await plan({ fileName: "customer upload final.pdf", fileHash: HASH("d") });
    expect(body.plan).toMatchObject({ decision: "route", rule: "job_file_name", jobId: "job_1" });
    expect(jobWrites()).toEqual([]);
  });
  it("a near-miss name is NOT matched (no fuzzy linking was added)", async () => {
    state.jobs = [job({ customerName: "Flame Society", files: [{ fileName: "customer upload final.pdf", originalFileName: null }] })];
    for (const [index, fileName] of ["customer upload final v2.pdf", "Flame Society labels.pdf", "Jar label.pdf"].entries()) {
      expect((await plan({ fileName, fileHash: HASH(String(index + 5)) })).body.plan.decision, fileName).toBe("review");
    }
    expect(state.intakes.every((row) => row.matchedProductionJobId === null)).toBe(true);
  });
});

describe("11. manual Assign still links the file to an existing job, and the next plan routes it", () => {
  it("unmatched → NEEDS REVIEW → Assign to an existing job → next plan routes against that job", async () => {
    await plan({ fileName: "BUTTAWAY_bently.pdf", fileHash: HASH("a"), fileSize: 10 });
    const intake = state.intakes[0];
    expect(intake.status).toBe("review");

    const assigned = await pageAction({ intent: "assign", intakeId: intake.id, target: "job_1|item_1" });
    expect(assigned.ok).toBe(true);
    expect(intake).toMatchObject({ status: "assigned", matchedProductionJobId: "job_1", authoritativeTicket: "GSO-20261118-0001-01" });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ jobId: "job_1", eventType: "intake_file_assigned" });
    expect(dispositionOf(intake as any)).toEqual({ disposition: "assigned", retryAllowed: true });

    const { body } = await plan({ fileName: "BUTTAWAY_bently.pdf", fileHash: HASH("a"), fileSize: 10 });
    expect(body.plan).toMatchObject({ decision: "route", rule: "assigned_by_owner", jobId: "job_1", itemId: "item_1", machine: "mimaki", matchedExisting: true, autoCreated: false });
    expect(intake).toMatchObject({ status: "routed", printer: "mimaki", matchedProductionJobId: "job_1" });
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
  });

  it("Release / Retry on an unmatched file just re-plans it back into review — still no job", async () => {
    await plan({ fileName: "loose file.pdf", fileHash: HASH("b") });
    const intake = state.intakes[0];
    expect((await pageAction({ intent: "release", intakeId: intake.id })).ok).toBe(true);
    expect(intake.status).toBe("retry_allowed");
    const { body } = await plan({ fileName: "loose file.pdf", fileHash: HASH("b") });
    expect(body.plan.decision).toBe("review");
    expect(intake.status).toBe("review");
    expect(jobWrites()).toEqual([]);
  });

  it("Assign refuses a job from another shop or a closed job, and a staff member without intake rights", async () => {
    await plan({ fileName: "loose file.pdf", fileHash: HASH("c") });
    const intake = state.intakes[0];
    state.jobs.push(job({ id: "job_other", shop: "other-shop" }), job({ id: "job_closed", status: "completed" }));
    expect((await pageAction({ intent: "assign", intakeId: intake.id, target: "job_other|" })).ok).toBe(false);
    expect((await pageAction({ intent: "assign", intakeId: intake.id, target: "job_closed|item_1" })).ok).toBe(false);
    authState.sub = "4242";
    expect((await pageAction({ intent: "assign", intakeId: intake.id, target: "job_1|item_1" })).ok).toBe(false);
    expect(intake.status).toBe("review");
    expect(intake.matchedProductionJobId).toBeNull();
  });
});

describe("12. token protection is unchanged", () => {
  it("missing, unknown and disabled tokens are refused before anything is read or written", async () => {
    const noToken = await routePlan({ request: new Request("https://app.test/x", { method: "POST", body: JSON.stringify({ fileName: "a.pdf", fileHash: HASH("a") }) }) });
    expect(noToken.status).toBe(401);
    expect((await plan({ token: "wrong", fileName: "a.pdf", fileHash: HASH("a") })).status).toBe(403);
    state.settings[0].enabled = false;
    expect((await plan({ fileName: "a.pdf", fileHash: HASH("a") })).status).toBe(403);
    expect(state.writes).toEqual([]);
    expect(state.intakes).toEqual([]);
  });
  it("another shop's jobs are never matched", async () => {
    state.jobs = [job({ shop: "other-shop" })];
    const { body } = await plan({ fileName: "GSO-20261118-0001-01 labels.pdf", fileHash: HASH("a") });
    expect(body.plan.decision).toBe("review");
    expect(state.intakes[0].matchedProductionJobId).toBeNull();
  });
});

describe("13. server-side guarantee and unaffected job creation elsewhere", () => {
  it("the endpoint and its helpers contain no ProductionJob write of any kind", () => {
    for (const file of ["app/routes/api.print-intake.route-plan.tsx", "app/routes/api.print-intake.report.tsx", "app/routes/api.print-intake.status.tsx", "app/lib/print-intake-routing.server.ts", "app/lib/print-intake-review.server.ts"]) {
      const text = src(file);
      expect(text, file).not.toMatch(/productionJob\.(create|createMany|upsert)\b/);
      expect(text, file).not.toMatch(/productionJobItem\.(create|createMany|upsert)\b/);
      expect(text, file).not.toContain("createOrReusePrintIntakeJob");
      expect(text, file).not.toContain("createProductionJobFromSource");
    }
  });
  it("no source file anywhere still creates an Unlinked print-intake job", () => {
    expect((jobSource as any).createOrReusePrintIntakeJob).toBeUndefined();
    const source = src("app/lib/production-job-source.server.ts");
    expect(source).not.toContain('customerName: "Unlinked (print intake)"');
    expect(source).not.toContain("print_intake_auto_created");
  });
  it("legitimate job creation is untouched: order, quote and manual creators still exist and are the only job creators", () => {
    expect(typeof jobSource.createProductionJobFromSource).toBe("function");
    expect(typeof jobSource.allocateJobTicket).toBe("function");
    expect(typeof jobSource.runWithTicketRetry).toBe("function");
    const source = src("app/lib/production-job-source.server.ts");
    expect((source.match(/tx\.productionJob\.create\(/g) || []).length).toBe(3); // was 4: the print-intake one is gone
    expect(source).toContain("sourceKey = `manual_${requestId}`");
    expect(source).toContain("shopify_order_");
  });
  it("no schema change: PrintIntake keeps its existing status column and unique key", () => {
    const schema = src("prisma/schema.prisma");
    expect(schema).toContain("@@unique([shop, fileHashSha256])");
    const model = schema.split("model PrintIntake {")[1].split("\n}")[0];
    expect(model).toMatch(/\n\s+status\s+String/);
    expect(model).toMatch(/\n\s+reviewReason\s+String\?/);
  });
});
