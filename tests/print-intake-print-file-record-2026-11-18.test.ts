// Print Intake Patch E (2026-11-18) — when the intake agent reports that a
// matched file was actually delivered to a press, the routed production print
// file is recorded ONCE on the EXISTING job as a ProductionJobFile
// (print_file / printFile / nas). It is not source artwork, it never fills
// job.printFileUrl, and a plan alone or a failed delivery records nothing.
//
// Drives the real route-plan, report and Incoming Print Files actions against
// an in-memory database (no live data).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; files: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], files: [], events: [], writes: [], seq: 0 };

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: "9001" }, admin: {} }) },
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
    findMany: async ({ where }: any = {}) => state.intakes.filter((row) => (!where?.shop || row.shop === where.shop) && (!where?.status?.not || row.status !== where.status.not)),
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
    findMany: async ({ where }: any = {}) => state.files.filter((row) => matches(row, where || {})),
    create: async ({ data }: any) => { const row = { id: `file_${++state.seq}`, createdAt: new Date(), ...data }; state.files.push(row); state.writes.push("productionJobFile.create"); return row; },
    update: async ({ where, data }: any) => { const row = state.files.find((file) => file.id === where.id)!; Object.assign(row, data); state.writes.push("productionJobFile.update"); return row; },
  };
  const productionJob = {
    findMany: async ({ where }: any) => state.jobs.filter((job) => job.shop === where.shop && job.active !== false),
    findFirst: async ({ where }: any) => state.jobs.find((job) => job.id === where.id && job.shop === where.shop && (where.active === undefined || job.active === where.active)) ?? null,
  };
  const other = (model: string) => new Proxy({}, { get: (_t, method: string) => async () => { if (/^(create|update|upsert|delete)/.test(method)) state.writes.push(`${model}.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "productionJobFile") return productionJobFile;
      if (key === "printLogAutoImportSetting") return {
        findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null,
        update: async ({ where, data }: any) => { Object.assign(state.settings.find((row) => row.id === where.id)!, data); return {}; },
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
import { action as intakePageAction } from "../app/routes/app.erp.print-intake";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import db from "../app/db.server";
import { NAS_PRINT_FILE_URL_PREFIX, recordRoutedPrintFile } from "../app/lib/production-job-source.server";
import { assetStateLabel, isFetchableAssetUrl } from "../app/lib/security-guards-shared";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function item(overrides: Row = {}): Row {
  return { id: "item_1", itemTicket: "GSO-20261118-0001-01", ripJobName: "GSO-20261118-0001-01_BAG_MATTE_QTY500", suggestedFileName: null, productTitle: "Bag", selectedFinish: "CMYK", materialSummary: null, machineSummary: null, ...overrides };
}
function job(overrides: Row = {}): Row {
  return { id: "job_1", shop: "shop-1", active: true, status: "new", actualCostFinalized: false, jobTicket: "GSO-20261118-0001", customerName: "Real Customer", company: null, artworkUrl: null, printFileUrl: null, items: [item()], files: [], ...overrides };
}
async function plan(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return ((await response.json()) as any).plan;
}
async function sendReport(fields: Row) {
  const response = await report({ request: new Request("https://app.test/api/print-intake/report", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return { status: response.status, body: (await response.json()) as any };
}
/** What the agent does after a route plan: copy the file, then report the delivery. */
async function deliver(fileName: string, hash: string) {
  const planned = await plan({ fileName, fileHash: hash, fileSize: 10 });
  if (planned.decision !== "route") return { planned, reported: null };
  const reported = await sendReport({ fileName, decision: "routed", rule: planned.rule, jobId: planned.jobId, jobTicket: planned.jobTicket, itemTicket: planned.itemTicket, ripName: planned.ripName, machine: planned.machine, fileHash8: hash.slice(0, 8), fileHash: hash });
  return { planned, reported };
}
const assign = (intakeId: string) => intakePageAction({ request: new Request("https://app.test/app/erp/print-intake", { method: "POST", body: new URLSearchParams({ intent: "assign", intakeId, target: "job_1|item_1" }) }) }) as Promise<any>;
const intakeFor = (fileName: string) => state.intakes.find((row) => row.originalFilename === fileName)!;
const jobWrites = () => state.writes.filter((write) => /^productionJob\./.test(write) || /Checklist/i.test(write));

beforeEach(() => {
  state.settings = [{ id: "set_1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null }];
  state.jobs = [job()];
  state.intakes = [];
  state.files = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
  process.env[OWNER_USER_IDS_ENV] = "9001";
});

describe("1-7. a successfully routed, matched file is recorded once on the existing job", () => {
  it("creates one ProductionJobFile with the production print-file shape", async () => {
    const { planned, reported } = await deliver("GSO-20261118-0001-01 final art.pdf", HASH("a"));
    expect(planned).toMatchObject({ decision: "route", jobId: "job_1", machine: "mimaki" });
    expect(reported!.body).toMatchObject({ ok: true, recorded: true, printFile: "created" });
    expect(state.files).toHaveLength(1);
    const file = state.files[0];
    expect(file).toMatchObject({
      shop: "shop-1",
      jobId: "job_1",
      fileType: "print_file",
      assetRole: "printFile",
      assetSource: "nas",
      fileName: "GSO-20261118-0001-01_BAG_MATTE_QTY500.pdf", // the routed ERP / RIP name
      originalFileName: "GSO-20261118-0001-01 final art.pdf", // the staff file name
      sourceRef: HASH("a"), // stable identity: full SHA-256
      jobTicket: "GSO-20261118-0001",
      matchedBy: "print_intake",
      createdBy: "print-intake-agent",
    });
    expect(file.notes).toContain("Sent to Mimaki as GSO-20261118-0001-01_BAG_MATTE_QTY500.pdf.");
    expect(file.notes).toContain("Original file: GSO-20261118-0001-01 final art.pdf");
    expect(file.notes).toContain("Item: GSO-20261118-0001-01");
    expect(file.notes).toContain("not source artwork");
  });

  it("a Roland job says Roland; the PrintIntake row stays, linked to the same job, routed", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: "Matte + 4X Spot Gloss" })] })];
    await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    expect(state.files[0].notes).toContain("Sent to Roland as ");
    expect(state.intakes).toHaveLength(1);
    expect(state.intakes[0]).toMatchObject({ status: "routed", matchedProductionJobId: "job_1", printer: "roland" });
  });

  it("the stored value is a non-fetchable NAS marker — never a link, never a path", async () => {
    await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    const url = state.files[0].fileUrl;
    expect(url).toBe(`${NAS_PRINT_FILE_URL_PREFIX}${HASH("a")}`);
    expect(isFetchableAssetUrl(url)).toBe(false);
    expect(assetStateLabel(url)).toBe("Production print file on the shop NAS (no download link)");
    expect(url).not.toMatch(/\\\\|[A-Za-z]:\\|SynologyNAS/);
  });

  it("the existing 'print file routed' production event is still written, once", async () => {
    await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ jobId: "job_1", eventType: "print_file_routed", createdBy: "print-intake-agent" });
  });
});

describe("8-9. idempotency and multi-layer jobs", () => {
  it("repeating the same successful report creates no duplicate file and no duplicate event", async () => {
    const first = await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    const body = { fileName: "GSO-20261118-0001-01 art.pdf", decision: "routed", jobId: "job_1", ripName: first.planned.ripName, machine: "mimaki", itemTicket: first.planned.itemTicket, fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") };
    expect((await sendReport(body)).body).toMatchObject({ ok: true, recorded: false, duplicateReport: true, printFile: "unchanged" });
    // another file is reported in between, then the first report is repeated again (no longer at the head of the log)
    await deliver("GSO-20261118-0001-01 second.pdf", HASH("b"));
    expect((await sendReport(body)).body.printFile).toBe("unchanged");
    expect(state.files.filter((file) => file.sourceRef === HASH("a"))).toHaveLength(1);
    expect(state.events.filter((event) => String(event.message).includes("GSO-20261118-0001-01 art.pdf"))).toHaveLength(1);
  });

  it("two distinct layer files of one job create two legitimate rows; repeating either adds nothing", async () => {
    const CMYK = "crud_TOAD KILLA_F_cmyk.pdf";
    const GLOSS = "crud_TOAD KILLA_F_g.pdf";
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await plan({ fileName: GLOSS, fileHash: HASH("b") });
    await assign(intakeFor(CMYK).id);
    await assign(intakeFor(GLOSS).id);
    const c = await deliver(CMYK, HASH("a"));
    const g = await deliver(GLOSS, HASH("b"));
    expect(c.planned.machine).toBe("roland");
    expect(g.planned.machine).toBe("roland");
    expect(state.files).toHaveLength(2);
    expect(state.files.map((file) => file.originalFileName).sort()).toEqual([CMYK, GLOSS].sort());
    expect(new Set(state.files.map((file) => file.jobId))).toEqual(new Set(["job_1"]));
    expect(new Set(state.files.map((file) => file.sourceRef)).size).toBe(2);
    expect(state.files.every((file) => file.fileType === "print_file" && file.assetRole === "printFile" && /Sent to Roland/.test(file.notes))).toBe(true);
    await sendReport({ fileName: CMYK, decision: "routed", jobId: "job_1", ripName: c.planned.ripName, machine: "roland", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toHaveLength(2);
  });

  it("the helper itself is idempotent, and a re-delivery under a new routed name updates the one row", async () => {
    const input = { shop: "shop-1", jobId: "job_1", jobTicket: "GSO-20261118-0001", fileHash: HASH("c"), originalFileName: "art.PDF", routedFileName: "GSO-20261118-0001-01", machine: "mimaki" as const, itemTicket: "GSO-20261118-0001-01" };
    expect((await recordRoutedPrintFile(db, input)).result).toBe("created");
    expect((await recordRoutedPrintFile(db, input)).result).toBe("unchanged");
    expect((await recordRoutedPrintFile(db, { ...input, routedFileName: "GSO-20261118-0001-01__A2" })).result).toBe("updated");
    expect(state.files).toHaveLength(1);
    expect(state.files[0].fileName).toBe("GSO-20261118-0001-01__A2.PDF");
    await expect(recordRoutedPrintFile(db, { ...input, fileHash: "abc" })).rejects.toThrow(/full SHA-256/);
    await expect(recordRoutedPrintFile(db, { ...input, routedFileName: " " })).rejects.toThrow(/routed file name/);
  });
});

describe("10-14. nothing is recorded when no delivery happened", () => {
  it("a route plan alone records nothing", async () => {
    expect((await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") })).decision).toBe("route");
    expect(state.files).toEqual([]);
  });
  it("a failed delivery report records nothing", async () => {
    const planned = await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") });
    const failed = await sendReport({ fileName: "GSO-20261118-0001-01 art.pdf", decision: "failed", reason: "copy_length_mismatch", jobId: planned.jobId, ripName: planned.ripName, machine: planned.machine, fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(failed.body).toMatchObject({ ok: true, printFile: null });
    for (const decision of ["needs_review", "duplicate"]) {
      await sendReport({ fileName: `x-${decision}.pdf`, decision, jobId: planned.jobId, ripName: planned.ripName, machine: planned.machine, fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    }
    expect(state.files).toEqual([]);
  });
  it("an unmatched file records nothing — even if a 'routed' report is sent for it", async () => {
    expect((await plan({ fileName: "loose art.pdf", fileHash: HASH("a") })).decision).toBe("review");
    const forced = await sendReport({ fileName: "loose art.pdf", decision: "routed", jobId: "job_1", ripName: "whatever", machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(forced.body.printFile).toBeNull();
    expect(state.files).toEqual([]);
  });
  it("an ambiguous match records nothing", async () => {
    state.jobs = [job({ files: [{ fileName: "shared art.pdf", originalFileName: null }] }), job({ id: "job_2", jobTicket: "GSO-20261118-0002", items: [item({ id: "item_2", itemTicket: "GSO-20261118-0002-01" })], files: [{ fileName: "shared art.pdf", originalFileName: null }] })];
    const { planned, reported } = await deliver("shared art.pdf", HASH("a"));
    expect(planned.decision).toBe("review");
    expect(reported).toBeNull();
    await sendReport({ fileName: "shared art.pdf", decision: "routed", jobId: "job_2", ripName: "x", machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toEqual([]);
  });
  it("a printer conflict records nothing", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: "Holo + White", machineSummary: "Mimaki UCJV300-130" })] })];
    const { planned } = await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    expect(planned.decision).toBe("review");
    await sendReport({ fileName: "GSO-20261118-0001-01 art.pdf", decision: "routed", jobId: "job_1", ripName: "x", machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toEqual([]);
  });
  it("a confirm-print-mode hold records nothing", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: null })] })];
    const CMYK = "crud_TOAD KILLA_F_cmyk.pdf";
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await assign(intakeFor(CMYK).id);
    expect((await plan({ fileName: CMYK, fileHash: HASH("a") })).decision).toBe("review");
    await sendReport({ fileName: CMYK, decision: "routed", jobId: "job_1", ripName: "x", machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toEqual([]);
  });
  it("a report naming a different job than the one the server routed to, a rejected file, or no full hash records nothing", async () => {
    state.jobs.push(job({ id: "job_9", jobTicket: "GSO-20261118-0009", items: [item({ id: "item_9", itemTicket: "GSO-20261118-0009-01" })] }));
    const planned = await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") });
    await sendReport({ fileName: "GSO-20261118-0001-01 art.pdf", decision: "routed", jobId: "job_9", ripName: planned.ripName, machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toEqual([]);
    await sendReport({ fileName: "GSO-20261118-0001-01 other.pdf", decision: "routed", jobId: "job_1", ripName: planned.ripName, machine: "mimaki", fileHash8: "aaaaaaaa" });
    expect(state.files).toEqual([]);
    state.intakes[0].status = "rejected";
    await sendReport({ fileName: "GSO-20261118-0001-01 again.pdf", decision: "routed", jobId: "job_1", ripName: planned.ripName, machine: "mimaki", fileHash8: HASH("a").slice(0, 8), fileHash: HASH("a") });
    expect(state.files).toEqual([]);
  });
  it("the token and shop checks are unchanged", async () => {
    const noToken = await report({ request: new Request("https://app.test/x", { method: "POST", body: JSON.stringify({ fileName: "a.pdf", decision: "routed", jobId: "job_1" }) }) });
    expect(noToken.status).toBe(401);
    expect((await sendReport({ token: "wrong", fileName: "a.pdf", decision: "routed", jobId: "job_1" })).status).toBe(403);
    state.jobs = [job({ shop: "other-shop" })];
    expect((await sendReport({ fileName: "a.pdf", decision: "routed", jobId: "job_1", fileHash: HASH("a") })).status).toBe(400);
    expect(state.files).toEqual([]);
  });
});

describe("15-17. source artwork stays separate", () => {
  it("recording the print file does not touch the job, its print-file URL, its artwork or its checklist", async () => {
    const before = JSON.stringify(state.jobs[0]);
    await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    expect(state.files).toHaveLength(1);
    expect(JSON.stringify(state.jobs[0])).toBe(before);
    expect(state.jobs[0].printFileUrl).toBeNull();
    expect(state.jobs[0].artworkUrl).toBeNull();
    expect(jobWrites()).toEqual([]); // no productionJob.update / create, no checklist write
    const helper = src("app/lib/production-job-source.server.ts");
    const body = helper.slice(helper.indexOf("export async function recordRoutedPrintFile("));
    expect(body).not.toMatch(/productionJob\.(update|updateMany|create)\b/);
    expect(body).not.toContain("printFileUrl");
    expect(body).not.toContain("artworkUrl");
    expect(body).not.toMatch(/checklist/i);
  });
  it("the Production page does not count it as artwork and cannot promote it into the job's print-file URL", () => {
    const page = src("app/routes/app.erp.production.tsx");
    expect(page).toContain('const hasArtwork = Boolean(job.artworkUrl) || (job.files || []).some((file: any) => file.assetRole === "artwork" || file.fileType === "artwork");');
    expect(page).toContain("if (!isFetchableAssetUrl(fileUrl)) return {};"); // setFileRole / addFile never push a marker into printFileUrl
    expect(page).toContain('{file.notes ? <Text as="p" tone="subdued">{file.notes}</Text> : null}'); // "Sent to Roland as ..." is shown
    expect(page).toContain('String(file.fileUrl || "").startsWith("gso:nas-print-file/") ? "subdued" : "critical"');
  });
  it("the existing manual Add File path is unchanged", () => {
    const page = src("app/routes/app.erp.production.tsx");
    expect(page).toContain('if (intent === "addFile") {');
    expect(page).toContain('if (!fileUrl) return Response.json({ ok: false, message: "File URL is required." }, { status: 400 });');
    expect(page).toContain('const assetRole = String(formData.get("assetRole") || roleFromFileType(fileType));');
    expect(page).toContain('await createEvent(shop, jobId, "file_added", `${fileType} file added from ${sourceLabel(assetSource)}: ${fileName}.`);');
    expect(page).toContain('if (fileType === "print_file") return "printFile";');
  });
});

describe("18-20. earlier patches still hold and no job is created", () => {
  it("no ProductionJob write of any kind on any path above; the report endpoint has no job creator", async () => {
    await deliver("GSO-20261118-0001-01 art.pdf", HASH("a"));
    await deliver("loose art.pdf", HASH("b"));
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    const reportSrc = src("app/routes/api.print-intake.report.tsx");
    expect(reportSrc).not.toMatch(/productionJob\.(create|createMany|upsert|update|updateMany)\b/);
    expect(reportSrc).not.toContain("createProductionJobFromSource");
    expect(reportSrc).toContain("routedIntake.matchedProductionJobId === job.id");
  });
  it("a recorded print file makes a re-drop of the same staff file name match the same job (existing stored-name rule)", async () => {
    await plan({ fileName: "customer final.pdf", fileHash: HASH("a") });
    await assign(intakeFor("customer final.pdf").id);
    await deliver("customer final.pdf", HASH("a"));
    expect(state.files).toHaveLength(1);
    state.jobs[0].files = state.files.map((file) => ({ fileName: file.fileName, originalFileName: file.originalFileName }));
    const revised = await plan({ fileName: "customer final.pdf", fileHash: HASH("b") });
    expect(revised).toMatchObject({ decision: "route", rule: "job_file_name", jobId: "job_1" });
  });
  it("no schema change: ProductionJobFile is used exactly as it is", () => {
    const schema = src("prisma/schema.prisma");
    const model = schema.split("model ProductionJobFile {")[1].split("\n}")[0];
    for (const field of ["fileName", "fileType", "fileUrl", "assetRole", "assetSource", "sourceRef", "matchedBy", "jobTicket", "originalFileName", "notes", "createdBy"]) expect(model, field).toMatch(new RegExp(`\\n\\s+${field}\\s+String`));
    expect(model).toContain("print_file");
    expect(model).toContain("nas");
  });
});
