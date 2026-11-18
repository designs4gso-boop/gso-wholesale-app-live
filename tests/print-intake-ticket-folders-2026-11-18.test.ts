// Print Intake Patch D (2026-11-18) — ticket-named job folders + safer manual
// linking.
//   - A file inside a folder whose name BEGINS with an existing job ticket
//     inherits that job. Only the ticket is identity; nothing fuzzy.
//   - A multi-item job with no certain item is held (link to item).
//   - Incoming Print Files: job search (human aid only) and bulk assign.
//   - The agent scans the root plus ONE level of ticket folders.
// Drives the real route-plan, report and Incoming Print Files loader / action
// against an in-memory database.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const authState: { sub: string } = { sub: "9001" };
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; files: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], files: [], events: [], writes: [], seq: 0 };

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const findIntake = (where: any) => {
    if (where?.shop_fileHashSha256) return state.intakes.find((row) => row.shop === where.shop_fileHashSha256.shop && row.fileHashSha256 === where.shop_fileHashSha256.fileHashSha256) ?? null;
    return state.intakes.find((row) => (!where?.id || row.id === where.id) && (!where?.shop || row.shop === where.shop)) ?? null;
  };
  const printIntake = {
    findUnique: async ({ where }: any) => findIntake(where),
    findFirst: async ({ where }: any) => {
      if (where?.authoritativeTicket) return state.intakes.find((row) => row.shop === where.shop && row.authoritativeTicket === where.authoritativeTicket && row.status === where.status && row.fileHashSha256 !== where.NOT?.fileHashSha256) ?? null;
      return findIntake(where);
    },
    findMany: async ({ where }: any = {}) => state.intakes.filter((row) =>
      (!where?.shop || row.shop === where.shop)
      && (!where?.status?.not || row.status !== where.status.not)
      && (!where?.status?.in || where.status.in.includes(row.status))
      && (!where?.id?.in || where.id.in.includes(row.id))),
    create: async ({ data }: any) => {
      const row = { id: `pi_${++state.seq}`, matchedProductionJobId: null, generatedProductionJobId: null, authoritativeTicket: null, printer: null, printMode: null, routingRule: null, routedFilename: null, reviewReason: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, createdAt: new Date(), updatedAt: new Date(), ...data };
      state.intakes.push(row);
      return row;
    },
    update: async ({ where, data }: any) => { const row = findIntake(where)!; Object.assign(row, data); return row; },
    upsert: async ({ where, update, create }: any) => { const row = findIntake(where); if (row) { Object.assign(row, update); return row; } return printIntake.create({ data: create }); },
  };
  const matches = (row: Row, where: Row) => Object.entries(where || {}).every(([key, value]) => row[key] === value);
  const productionJobFile = {
    findFirst: async ({ where }: any) => state.files.find((row) => matches(row, where)) ?? null,
    create: async ({ data }: any) => { const row = { id: `file_${++state.seq}`, createdAt: new Date(), ...data }; state.files.push(row); return row; },
    update: async ({ where, data }: any) => { const row = state.files.find((file) => file.id === where.id)!; Object.assign(row, data); return row; },
  };
  // Enough of Prisma's where to exercise the real search filter.
  const jobMatches = (job: Row, where: any): boolean => {
    if (!where) return true;
    for (const [key, value] of Object.entries<any>(where)) {
      if (key === "OR") { if (!(value as any[]).some((clause) => jobMatches(job, clause))) return false; continue; }
      if (value && typeof value === "object" && "notIn" in value) { if (value.notIn.includes(job[key])) return false; continue; }
      if (value && typeof value === "object" && "contains" in value) { if (!String(job[key] ?? "").toLowerCase().includes(String(value.contains).toLowerCase())) return false; continue; }
      if (job[key] !== value) return false;
    }
    return true;
  };
  const productionJob = {
    findMany: async ({ where, take }: any) => state.jobs.filter((job) => jobMatches(job, where)).slice(0, take || 1000),
    findFirst: async ({ where }: any) => state.jobs.find((job) => jobMatches(job, where)) ?? null,
  };
  const other = (model: string) => new Proxy({}, { get: (_t, method: string) => async () => { if (/^(create|update|upsert|delete)/.test(method)) state.writes.push(`${model}.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "productionJobFile") return productionJobFile;
      if (key === "printLogAutoImportSetting") return {
        findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null,
        update: async ({ where, data }: any) => { Object.assign(state.settings.find((row) => row.id === where.id)!, data); return {}; },
        upsert: async () => state.settings[0],
      };
      if (key === "productionJob") return new Proxy(productionJob, { get: (target: any, method: string) => target[method] ?? (async () => { state.writes.push(`productionJob.${method}`); return {}; }) });
      if (key === "productionJobEvent") return { create: async ({ data }: any) => { state.events.push(data); return {}; } };
      if (key === "$queryRawUnsafe") return async () => [{ gso_lock: "" }];
      if (key === "$transaction") return async (arg: any) => (typeof arg === "function" ? arg(db) : Promise.all(arg));
      return other(key);
    },
  });
  return { default: db, db };
});

import { action as routePlan } from "../app/routes/api.print-intake.route-plan";
import { action as report } from "../app/routes/api.print-intake.report";
import { action as intakePageAction, loader as intakePageLoader } from "../app/routes/app.erp.print-intake";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { decideIntakeRoute, extractFolderJobTicket } from "../app/lib/print-intake-routing.server";
import {
  CONFIRM_PRINT_MODE_REASON,
  INTAKE_BULK_ASSIGN_MAX,
  NEEDS_LINK_TO_ITEM_LABEL,
  NEEDS_LINK_TO_ITEM_REASON,
  canonicalReviewReason,
  cleanIntakeJobSearch,
  intakeAssignableJobsWhere,
  parseBulkIntakeIds,
} from "../app/lib/print-intake-review.server";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const FOLDER = "GSO-20261118-0003 FLAVAZ";

function item(overrides: Row = {}): Row {
  return { id: "item_1", itemTicket: "GSO-20261118-0003-01", ripJobName: "GSO-20261118-0003-01_JAR_3OZ", suggestedFileName: null, productTitle: "3oz jar", selectedFinish: "CMYK", materialSummary: null, machineSummary: null, ...overrides };
}
function job(overrides: Row = {}): Row {
  return { id: "job_3", shop: "shop-1", active: true, status: "new", actualCostFinalized: false, jobTicket: "GSO-20261118-0003", quoteNumber: "#1042", customerName: "Flavaz Camp", company: "Flavaz LLC", artworkUrl: null, printFileUrl: null, items: [item()], files: [], ...overrides };
}
const twoItemJob = () => job({ items: [item(), item({ id: "item_2", itemTicket: "GSO-20261118-0003-02", ripJobName: "GSO-20261118-0003-02_JAR_4OZ", productTitle: "4oz jar" })] });
async function plan(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return ((await response.json()) as any).plan;
}
async function sendReport(fields: Row) {
  const response = await report({ request: new Request("https://app.test/api/print-intake/report", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return (await response.json()) as any;
}
async function deliver(fileName: string, hash: string, extra: Row = {}) {
  const planned = await plan({ fileName, fileHash: hash, fileSize: 10, ...extra });
  if (planned.decision !== "route") return { planned, reported: null };
  const reported = await sendReport({ fileName, decision: "routed", rule: planned.rule, jobId: planned.jobId, jobTicket: planned.jobTicket, itemTicket: planned.itemTicket, ripName: planned.ripName, machine: planned.machine, fileHash8: hash.slice(0, 8), fileHash: hash });
  return { planned, reported };
}
function pagePost(fields: Array<[string, string]>) {
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return intakePageAction({ request: new Request("https://app.test/app/erp/print-intake", { method: "POST", body }) }) as Promise<any>;
}
const pageLoad = (query = "") => intakePageLoader({ request: new Request(`https://app.test/app/erp/print-intake${query}`) }) as Promise<any>;
const intakeFor = (fileName: string) => state.intakes.find((row) => row.originalFilename === fileName)!;
const jobWrites = () => state.writes.filter((write) => /^productionJob\./.test(write));

beforeEach(() => {
  state.settings = [{ id: "set_1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null, incomingFolder: "x" }];
  state.jobs = [job()];
  state.intakes = [];
  state.files = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
  authState.sub = "9001";
  process.env[OWNER_USER_IDS_ENV] = "9001";
});

describe("1-5. the ticket folder name", () => {
  it("only a name that BEGINS with an exact job ticket is a job folder; trailing text is ignored", () => {
    for (const name of ["GSO-20261118-0003", "GSO-20261118-0003 FLAVAZ", "GSO-20261118-0003 - FLAVAZ CAMP", "GSO-20261118-0003-FLAVAZ", "gso_20261118_0003 flavaz", "  GSO-20261118-0003 anything at all 99"]) {
      expect(extractFolderJobTicket(name), name).toBe("GSO-20261118-0003");
    }
    for (const name of ["FLAVAZ", "KRUD", "PRINT TODAY", "PRINTS FOR TODAY", "Flavaz Camp", "FLAVAZ GSO-20261118-0003", "GSO-2026-0003", "GSO-20261118-00031", "GSO-20261118-0003-01 item folder", "GSO 20261118 0003", "", null]) {
      expect(extractFolderJobTicket(name as any), String(name)).toBe("");
    }
  });
  it("a ticket-only folder and a ticket + customer folder resolve the same existing job", async () => {
    const a = await plan({ fileName: "flavaz_og_3oz.pdf", subfolder: "GSO-20261118-0003", fileHash: HASH("a") });
    const b = await plan({ fileName: "flavaz_og_3oz v2.pdf", subfolder: "GSO-20261118-0003 - FLAVAZ CAMP", fileHash: HASH("b") });
    for (const result of [a, b]) expect(result).toMatchObject({ decision: "route", rule: "job_subfolder", jobId: "job_3", itemId: "item_1", jobTicket: "GSO-20261118-0003", matchedExisting: true, autoCreated: false });
    expect(state.intakes.every((row) => row.matchedProductionJobId === "job_3")).toBe(true);
  });
  it("the customer text after the ticket is never identity — even when it names a different customer's job", async () => {
    state.jobs.push(job({ id: "job_krud", jobTicket: "GSO-20261118-0009", customerName: "KRUD", company: "Krud Co", items: [item({ id: "item_k", itemTicket: "GSO-20261118-0009-01" })] }));
    const result = await plan({ fileName: "art.pdf", subfolder: "GSO-20261118-0003 KRUD", fileHash: HASH("a") });
    expect(result).toMatchObject({ decision: "route", jobId: "job_3" });
  });
  it("a customer / design / late-ticket folder does not auto-link — the file stays review-only", async () => {
    for (const [index, subfolder] of ["FLAVAZ", "Flavaz Camp", "PRINT TODAY", "flavaz og", "FLAVAZ GSO-20261118-0003", "GSO-2026-0003"].entries()) {
      const result = await plan({ fileName: "flavaz_og_3oz.pdf", subfolder, fileHash: HASH(String(index)) });
      expect(result, subfolder).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true });
    }
    expect(state.intakes.every((row) => row.status === "review" && row.matchedProductionJobId === null)).toBe(true);
  });
  it("a ticket folder for a job that does not exist is review-only (never falls through to another match)", async () => {
    state.jobs = [job({ files: [{ fileName: "flavaz_og_3oz.pdf", originalFileName: null }] })]; // the file name IS stored on job_3
    const result = await plan({ fileName: "flavaz_og_3oz.pdf", subfolder: "GSO-20261118-0777 SOMEONE", fileHash: HASH("a") });
    expect(result.decision).toBe("review");
    expect(result.reasons.join(" ")).toContain("folder_ticket_GSO-20261118-0777_not_found_in_eligible_jobs");
    expect(state.intakes[0].matchedProductionJobId).toBeNull();
  });
});

describe("6-7. job validation", () => {
  it("another shop's ticket is rejected", async () => {
    state.jobs = [job({ shop: "other-shop" })];
    const result = await plan({ fileName: "art.pdf", subfolder: FOLDER, fileHash: HASH("a") });
    expect(result).toMatchObject({ decision: "review", machine: null });
    expect(state.intakes[0].matchedProductionJobId).toBeNull();
  });
  it("an inactive, completed, cancelled or archived job is rejected", async () => {
    state.jobs = [job({ active: false })];
    expect((await plan({ fileName: "art.pdf", subfolder: FOLDER, fileHash: HASH("a") })).decision).toBe("review");
    for (const [index, status] of ["completed", "cancelled", "canceled", "archived"].entries()) {
      state.jobs = [job({ status })];
      const result = await plan({ fileName: `art ${status}.pdf`, subfolder: FOLDER, fileHash: HASH(String(index)) });
      expect(result.decision, status).toBe("review");
      expect(canonicalReviewReason(result.reasons), status).toBe("ticket_on_closed_job");
    }
    expect(state.intakes.every((row) => row.matchedProductionJobId === null && row.printer === null)).toBe(true);
  });
  it("a ticket in the filename that contradicts the folder ticket is held, not guessed", async () => {
    state.jobs.push(job({ id: "job_9", jobTicket: "GSO-20261118-0009", items: [item({ id: "item_9", itemTicket: "GSO-20261118-0009-01" })] }));
    const result = await plan({ fileName: "GSO-20261118-0009-01 art.pdf", subfolder: FOLDER, fileHash: HASH("a") });
    expect(result.decision).toBe("review");
    expect(canonicalReviewReason(result.reasons)).toBe("ticket_folder_mismatch");
  });
});

describe("8-9. root-level filename tickets still work, and outrank nothing they should not", () => {
  it("item ticket and job ticket in a root-level filename route as before", async () => {
    expect(await plan({ fileName: "GSO-20261118-0003-01 art.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "item_ticket", jobId: "job_3" });
    expect(await plan({ fileName: "GSO-20261118-0003 art.pdf", fileHash: HASH("b") })).toMatchObject({ decision: "route", rule: "job_ticket_single_item", jobId: "job_3" });
  });
  it("priority: filename ticket > folder ticket > stored names", () => {
    const jobs: any[] = [
      { ...job(), fileNames: [] },
      { ...job({ id: "job_9", jobTicket: "GSO-20261118-0009", items: [item({ id: "item_9", itemTicket: "GSO-20261118-0009-01", ripJobName: "shared stored name" })] }), fileNames: ["shared stored name.pdf"] },
    ];
    // same ticket in filename and folder -> the filename rule answers
    expect(decideIntakeRoute({ fileName: "GSO-20261118-0003-01 x.pdf", subfolder: FOLDER, jobs })).toMatchObject({ decision: "route", rule: "item_ticket", jobId: "job_3" });
    // the folder ticket beats a stored-name match on a DIFFERENT job
    expect(decideIntakeRoute({ fileName: "shared stored name.pdf", subfolder: FOLDER, jobs })).toMatchObject({ decision: "route", rule: "job_subfolder", jobId: "job_3" });
    // no folder -> the stored name still matches its own job
    expect(decideIntakeRoute({ fileName: "shared stored name.pdf", jobs })).toMatchObject({ decision: "route", rule: "stored_filename", jobId: "job_9" });
  });
});

describe("10. multi-layer files in one ticket folder keep one job identity and one press", () => {
  const CMYK = "flavaz_og_3oz_F_cmyk.pdf";
  const GLOSS = "flavaz_og_3oz_F_g.pdf";
  it("both layers inherit the folder's job; the sibling list sends the CMYK layer to the Roland on the first poll", async () => {
    const c = await plan({ fileName: CMYK, subfolder: FOLDER, fileHash: HASH("a"), folderFiles: [GLOSS] });
    const g = await plan({ fileName: GLOSS, subfolder: FOLDER, fileHash: HASH("b"), folderFiles: [CMYK] });
    expect(c).toMatchObject({ decision: "route", rule: "job_subfolder", jobId: "job_3", machine: "roland", machineRule: "gloss_requires_roland" });
    expect(g).toMatchObject({ decision: "route", rule: "job_subfolder", jobId: "job_3", machine: "roland" });
    expect(new Set(state.intakes.map((row) => row.matchedProductionJobId))).toEqual(new Set(["job_3"]));
  });
  it("sibling names only ever inform the press for the SAME design — they are not a matching signal", async () => {
    // an unrelated gloss file in the folder does not drag a different design to the Roland
    expect(await plan({ fileName: "flavaz_og_3oz_F_cmyk.pdf", subfolder: FOLDER, fileHash: HASH("a"), folderFiles: ["other_design_B_g.pdf", "GSO-20261118-0009-01.pdf", "random.pdf"] })).toMatchObject({ decision: "route", jobId: "job_3", machine: "mimaki" });
    // and sibling names never link an unmatched root file
    expect(await plan({ fileName: "loose.pdf", fileHash: HASH("b"), folderFiles: ["GSO-20261118-0003-01.pdf", CMYK] })).toMatchObject({ decision: "review", needsLinkToJob: true });
  });
});

describe("11-12. multi-item jobs never guess the item", () => {
  it("a file with no item identity in a multi-item job's folder is held as LINK TO ITEM", async () => {
    state.jobs = [twoItemJob()];
    const result = await plan({ fileName: "flavaz_og.pdf", subfolder: FOLDER, fileHash: HASH("a") });
    expect(result).toMatchObject({ decision: "review", machine: null, jobId: null, itemId: null });
    expect(canonicalReviewReason(result.reasons)).toBe(NEEDS_LINK_TO_ITEM_REASON);
    expect(NEEDS_LINK_TO_ITEM_LABEL).toBe("NEEDS REVIEW — LINK TO ITEM");
    expect(state.intakes[0]).toMatchObject({ status: "review", reviewReason: NEEDS_LINK_TO_ITEM_REASON, matchedProductionJobId: null, printer: null });
    const page = await pageLoad();
    expect(page.reviewRows[0].needsLinkLabel).toBe("NEEDS REVIEW — LINK TO ITEM");
  });
  it("a valid item ticket in the filename links the exact item; so does the item's exact stored name", async () => {
    state.jobs = [twoItemJob()];
    expect(await plan({ fileName: "GSO-20261118-0003-02 art.pdf", subfolder: FOLDER, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "item_ticket", jobId: "job_3", itemId: "item_2" });
    expect(await plan({ fileName: "GSO-20261118-0003-01_JAR_3OZ.pdf", subfolder: FOLDER, fileHash: HASH("b") })).toMatchObject({ decision: "route", itemId: "item_1" });
    state.jobs = [job({ items: [item({ ripJobName: "Flavaz OG front" }), item({ id: "item_2", itemTicket: "GSO-20261118-0003-02", ripJobName: "Flavaz OG back" })] })];
    expect(await plan({ fileName: "Flavaz OG back.pdf", subfolder: FOLDER, fileHash: HASH("c") })).toMatchObject({ decision: "route", rule: "job_subfolder", itemId: "item_2" });
  });
  it("after a person picks the item, the held file routes against that exact item", async () => {
    state.jobs = [twoItemJob()];
    await plan({ fileName: "flavaz_og.pdf", subfolder: FOLDER, fileHash: HASH("a") });
    const row = intakeFor("flavaz_og.pdf");
    expect((await pagePost([["intent", "assign"], ["intakeId", row.id], ["target", "job_3|"]])).ok).toBe(false); // no item picked -> refused
    expect((await pagePost([["intent", "assign"], ["intakeId", row.id], ["target", "job_3|item_2"]])).ok).toBe(true);
    expect(await plan({ fileName: "flavaz_og.pdf", subfolder: FOLDER, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", jobId: "job_3", itemId: "item_2" });
  });
});

describe("13-14, 17. manual and bulk assignment", () => {
  async function threeLooseFiles() {
    for (const [index, name] of ["a_cmyk.pdf", "a_g.pdf", "b.pdf"].entries()) await plan({ fileName: name, fileHash: HASH(String(index)) });
    return state.intakes.map((row) => row.id);
  }
  it("a single ticked row can still be assigned with the per-row Assign", async () => {
    const [first] = await threeLooseFiles();
    expect((await pagePost([["intent", "assign"], ["intakeId", first], ["target", "job_3|item_1"]])).ok).toBe(true);
    expect(state.intakes[0]).toMatchObject({ status: "assigned", matchedProductionJobId: "job_3", authoritativeTicket: "GSO-20261118-0003-01" });
    expect(state.intakes[1].status).toBe("review");
  });
  it("several ticked rows are assigned together to one existing job, each with its own audit event", async () => {
    const ids = await threeLooseFiles();
    const result = await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_1"], ...ids.map((id) => ["intakeIds", id] as [string, string])]);
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("3 file(s) assigned to GSO-20261118-0003");
    expect(state.intakes.every((row) => row.status === "assigned" && row.matchedProductionJobId === "job_3" && row.authoritativeTicket === "GSO-20261118-0003-01")).toBe(true);
    expect(state.events).toHaveLength(3);
    expect(state.events.every((event) => event.jobId === "job_3" && event.eventType === "intake_file_assigned")).toBe(true);
    expect(JSON.parse(state.intakes[0].rawParsedHints).assignedItemId).toBe("item_1");
    // the next plan routes them — the gloss layer pulls its CMYK sibling to the Roland
    expect(await plan({ fileName: "a_cmyk.pdf", fileHash: HASH("0") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", jobId: "job_3", machine: "roland" });
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
  });
  it("bulk assign is all-or-nothing: a multi-item job needs the exact item, and bad input assigns nothing", async () => {
    const ids = await threeLooseFiles();
    const tick = ids.map((id) => ["intakeIds", id] as [string, string]);
    state.jobs = [twoItemJob()];
    const noItem = await pagePost([["intent", "bulkAssign"], ["target", "job_3|"], ...tick]);
    expect(noItem.ok).toBe(false);
    expect(noItem.message).toContain("pick the exact item");
    expect((await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_zzz"], ...tick])).ok).toBe(false);
    expect((await pagePost([["intent", "bulkAssign"], ["target", ""], ...tick])).ok).toBe(false);
    expect((await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_1"]])).ok).toBe(false); // nothing ticked
    expect((await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_1"], ...tick, ["intakeIds", "pi_missing"]])).ok).toBe(false);
    state.jobs.push(job({ id: "job_closed", jobTicket: "GSO-20261118-0050", status: "completed" }), job({ id: "job_other", shop: "other-shop" }), job({ id: "job_final", jobTicket: "GSO-20261118-0051", actualCostFinalized: true }));
    for (const target of ["job_closed|item_1", "job_other|item_1", "job_final|item_1", "nope|"]) expect((await pagePost([["intent", "bulkAssign"], ["target", target], ...tick])).ok, target).toBe(false);
    state.intakes[2].status = "routed";
    expect((await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_2"], ...tick])).ok).toBe(false); // one ticked file already routed
    expect(state.intakes.slice(0, 2).every((row) => row.status === "review" && row.matchedProductionJobId === null)).toBe(true);
    expect(state.events).toEqual([]);
    state.intakes[2].status = "review";
    expect((await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_2"], ...tick])).ok).toBe(true);
    expect(state.intakes.every((row) => row.authoritativeTicket === "GSO-20261118-0003-02")).toBe(true);
  });
  it("the bulk limit and de-duplication are enforced", () => {
    expect(parseBulkIntakeIds(["a", "a", " b ", ""])).toEqual({ ok: true, ids: ["a", "b"] });
    expect(parseBulkIntakeIds([]).ok).toBe(false);
    expect(parseBulkIntakeIds(Array.from({ length: INTAKE_BULK_ASSIGN_MAX + 1 }, (_, i) => `id${i}`)).ok).toBe(false);
    expect(parseBulkIntakeIds(Array.from({ length: INTAKE_BULK_ASSIGN_MAX }, (_, i) => `id${i}`)).ok).toBe(true);
  });
  it("staff without intake rights cannot assign or bulk assign", async () => {
    const ids = await threeLooseFiles();
    authState.sub = "4242"; // not an owner / manager / print operator
    const bulk = await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_1"], ...ids.map((id) => ["intakeIds", id] as [string, string])]);
    expect(bulk.ok).toBe(false);
    expect((await pagePost([["intent", "assign"], ["intakeId", ids[0]], ["target", "job_3|item_1"]])).ok).toBe(false);
    expect(state.intakes.every((row) => row.status === "review" && row.matchedProductionJobId === null)).toBe(true);
    expect(state.events).toEqual([]);
    const page = src("app/routes/app.erp.print-intake.tsx");
    expect(page.indexOf('if (!staffAccess.can("manageIntake"))')).toBeGreaterThan(-1);
    expect(page.indexOf('if (!staffAccess.can("manageIntake"))')).toBeLessThan(page.indexOf('if (intent === "bulkAssign") {'));
  });
});

describe("15-16. job search is a human aid, never a link", () => {
  beforeEach(() => {
    state.jobs = [
      job(),
      job({ id: "job_krud", jobTicket: "GSO-20261118-0009", quoteNumber: "#2077", customerName: "KRUD", company: "Krud Co", items: [item({ id: "item_k", itemTicket: "GSO-20261118-0009-01" })] }),
      job({ id: "job_done", jobTicket: "GSO-20261101-0001", customerName: "Flavaz Camp", status: "completed" }),
      job({ id: "job_final", jobTicket: "GSO-20261101-0002", customerName: "Flavaz Camp", actualCostFinalized: true }),
      job({ id: "job_off", jobTicket: "GSO-20261101-0003", customerName: "Flavaz Camp", active: false }),
      job({ id: "job_x", shop: "other-shop", jobTicket: "GSO-20261118-0003", customerName: "Flavaz Camp" }),
    ];
  });
  it("finds eligible jobs by ticket, customer, company or order number — and only eligible ones in this shop", async () => {
    const ids = async (query: string) => (await pageLoad(query)).assignableJobs.map((entry: any) => entry.id).sort();
    expect(await ids("")).toEqual(["job_3", "job_krud"]);
    expect(await ids("?q=0009")).toEqual(["job_krud"]);
    expect(await ids("?q=flavaz")).toEqual(["job_3"]); // the completed / finalized / inactive / other-shop Flavaz jobs never appear
    expect(await ids("?q=KRUD%20CO")).toEqual(["job_krud"]);
    expect(await ids("?q=%231042")).toEqual(["job_3"]);
    expect(await ids("?q=nothing-matches")).toEqual([]);
    const loaded = await pageLoad("?q=flavaz");
    expect(loaded.jobQuery).toBe("flavaz");
    expect(loaded.assignableJobs[0].label).toContain("GSO-20261118-0003");
    expect(loaded.assignableJobs[0].label).toContain("Flavaz LLC");
  });
  it("the filter is shop-scoped and excludes closed / finalized / inactive jobs whatever the term", () => {
    expect(intakeAssignableJobsWhere("shop-1", "")).toEqual({ shop: "shop-1", active: true, actualCostFinalized: false, status: { notIn: ["completed", "cancelled", "canceled", "archived"] } });
    const filtered: any = intakeAssignableJobsWhere("shop-1", "  flavaz   camp ");
    expect(filtered).toMatchObject({ shop: "shop-1", active: true, actualCostFinalized: false });
    expect(filtered.OR.map((clause: any) => Object.keys(clause)[0])).toEqual(["jobTicket", "customerName", "company", "quoteNumber"]);
    expect(filtered.OR[0].jobTicket).toEqual({ contains: "flavaz camp", mode: "insensitive" });
    expect(cleanIntakeJobSearch("x".repeat(500)).length).toBe(80);
  });
  it("searching changes nothing: no intake row is linked, and the route-plan endpoint never uses search", async () => {
    await plan({ fileName: "flavaz og 3oz.pdf", fileHash: HASH("a") });
    const before = JSON.stringify(state.intakes);
    await pageLoad("?q=flavaz");
    await pageLoad("?q=GSO-20261118-0003");
    expect(JSON.stringify(state.intakes)).toBe(before);
    expect(state.events).toEqual([]);
    expect((await plan({ fileName: "flavaz og 3oz.pdf", fileHash: HASH("a") })).decision).toBe("review"); // a customer-name file still does not auto-link
    const route = src("app/routes/api.print-intake.route-plan.tsx");
    for (const name of ["intakeAssignableJobsWhere", "cleanIntakeJobSearch", "customerName: {", "contains:"]) expect(route, name).not.toContain(name);
    const lib = src("app/lib/print-intake-routing.server.ts");
    expect(lib).not.toMatch(/levenshtein|similarity|editDistance|\bscore\(/i); // no similarity scoring exists in the matcher
  });
});

describe("18-23. earlier patches still hold inside ticket folders", () => {
  it("unmatched stays review-only; a printer conflict stays review-only; the confirm-print-mode hold stays a hold", async () => {
    expect(await plan({ fileName: "loose.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true, autoCreated: false });
    state.jobs = [job({ items: [item({ selectedFinish: "Holo + White", machineSummary: "Mimaki UCJV300-130" })] })];
    const conflict = await plan({ fileName: "art.pdf", subfolder: FOLDER, fileHash: HASH("b") });
    expect(conflict.decision).toBe("review");
    expect(canonicalReviewReason(conflict.reasons)).toBe("premium_mode_mimaki_contradiction");
    state.jobs = [job({ items: [item({ selectedFinish: null })] })];
    const held = await plan({ fileName: "flavaz_og_cmyk.pdf", subfolder: FOLDER, fileHash: HASH("c") });
    expect(held.decision).toBe("review");
    expect(canonicalReviewReason(held.reasons)).toBe(CONFIRM_PRINT_MODE_REASON);
    expect(state.intakes.every((row) => row.printer === null)).toBe(true);
    expect(state.files).toEqual([]);
  });
  it("Patch E: a delivered ticket-folder file records one print file on the right job; a repeat report adds nothing", async () => {
    const CMYK = "flavaz_og_3oz_F_cmyk.pdf";
    const GLOSS = "flavaz_og_3oz_F_g.pdf";
    const c = await deliver(CMYK, HASH("a"), { subfolder: FOLDER, folderFiles: [GLOSS] });
    await deliver(GLOSS, HASH("b"), { subfolder: FOLDER, folderFiles: [CMYK] });
    expect(c.reported).toMatchObject({ ok: true, printFile: "created" });
    expect(state.files).toHaveLength(2);
    expect(state.files[0]).toMatchObject({ jobId: "job_3", fileType: "print_file", assetRole: "printFile", assetSource: "nas", originalFileName: CMYK, sourceRef: HASH("a"), fileName: "GSO-20261118-0003-01_JAR_3OZ.pdf", jobTicket: "GSO-20261118-0003" });
    expect(state.files[0].notes).toContain("Item: GSO-20261118-0003-01");
    expect(state.files.every((file) => /Sent to Roland/.test(file.notes))).toBe(true);
    const again = await sendReport({ fileName: CMYK, decision: "routed", jobId: "job_3", ripName: c.planned.ripName, machine: "roland", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(again.printFile).toBe("unchanged");
    expect(state.files).toHaveLength(2);
    expect(state.intakes.map((row) => row.originalSubfolder)).toEqual([FOLDER, FOLDER]);
  });
  it("no ProductionJob is created or changed anywhere by Patch D", async () => {
    await plan({ fileName: "art.pdf", subfolder: FOLDER, fileHash: HASH("a") });
    await plan({ fileName: "x.pdf", subfolder: "GSO-20261118-0777", fileHash: HASH("b") });
    await plan({ fileName: "y.pdf", subfolder: "FLAVAZ", fileHash: HASH("c") });
    await pagePost([["intent", "bulkAssign"], ["target", "job_3|item_1"], ["intakeIds", intakeFor("y.pdf").id]]);
    await pageLoad("?q=flavaz");
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    for (const file of ["app/routes/api.print-intake.route-plan.tsx", "app/routes/app.erp.print-intake.tsx", "app/lib/print-intake-routing.server.ts", "app/lib/print-intake-review.server.ts"]) {
      expect(src(file), file).not.toMatch(/productionJob\.(create|createMany|upsert|update|updateMany)\b/);
    }
  });
});

describe("24-26. the agent scans the root plus ONE level of ticket folders, and the cutoff is intact", () => {
  const agent = src("tools/gso-print-intake-agent.ps1");
  it("root + one level of ticket-named folders, by an exact-ticket-at-the-start pattern", () => {
    expect(agent).toContain("gso-print-intake-agent/1.8");
    expect(agent).toContain("$TicketJobFolderPattern = '^GSO[-_]\\d{8}[-_]\\d{4}(?!\\d)(?![-_]\\d)'");
    expect(agent).toContain("$all = @(Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue)"); // root files, unchanged
    expect(agent).toContain("foreach ($dir in @(Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -Directory -ErrorAction SilentlyContinue)) {"); // direct child folders only
    expect(agent).toContain("if (-not (Test-TicketJobFolderName $dir.Name)) { continue }");
    expect(agent).toContain("$all += @(Get-ChildItem -LiteralPath $jobFolder.FullName -File -ErrorAction SilentlyContinue)"); // files directly inside
    expect(agent).toContain("folderFiles = @($FolderFiles)");
  });
  it("nothing recursive was added to the scan: deeper folders are never read", () => {
    const scan = agent.slice(agent.indexOf("function Test-TicketJobFolderName"), agent.indexOf("# ---------- routing helpers"));
    expect(scan).not.toContain("-Recurse");
    const processing = agent.slice(agent.indexOf("function Invoke-ProcessIntakeFile"), agent.indexOf("# ---------- health"));
    expect(processing).not.toContain("-Recurse");
    expect(agent).toContain('Assert "a file nested below a ticket folder is NOT processed (one level only)"');
    expect(agent).toContain('Assert "customer-named, ticket-not-at-start and other subfolders stay ignored"');
  });
  it("the go-live cutoff, reserved folders and artwork filter apply unchanged to ticket-folder files", () => {
    expect(agent).toContain("if (-not (Test-FileEligibleByCutoff $file.LastWriteTimeUtc $Config.CutoffUtc)) { $ignoredHistorical++; continue }");
    expect(agent).toContain("if (Test-PathIsReserved $file.FullName $Config) { continue }");
    expect(agent).toContain("if (Test-PathIsReserved $dir.FullName $Config) { continue }");
    expect(agent).toContain("return ($LastWriteTimeUtc -gt $CutoffUtc)");
    expect(agent).toContain('throw "Config ProcessFilesModifiedAfterUtc is not a valid ISO-8601 UTC timestamp:');
    expect(agent).toContain('Assert "the go-live cutoff still applies inside a ticket folder"');
    const example = JSON.parse(src("tools/gso-print-intake-agent-config.example.json"));
    expect(example.ProcessFilesModifiedAfterUtc).toBe("2026-07-19T17:20:00Z"); // cutoff value untouched
    expect(example.MimakiRoutingEnabled).toBe(false);
    expect(example.RolandRoutingEnabled).toBe(false);
    expect(example.TicketJobFoldersEnabled).toBe(true);
  });
});
