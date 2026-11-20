// Track O — Mimaki Patch F SOFTWARE readiness (2026-11-19).
//
// Fixture proof, with NO live press result, that the chain holds end to end:
//
//   ticketed routed file name  (<ITEM TICKET>__<staff file name>[__R{n}-P{n}-A{n}].pdf)
//     -> ProductionJobFile -> ProductionJobItem -> ProductionRun (P1-A1 = reprint 1)
//     -> RasterLink result CSV -> JobInfo.ini (clear / gloss, both clear slots summed)
//     -> ink actuals on the print-log entry -> idempotent re-import.
//
// Everything below calls the REAL code: the real upload route action
// (app/routes/api.rip-imports.upload.tsx) with the multipart body the sync script
// posts (token, source, file[, jobFolder]), the real parsers, the real identity
// matcher, the real routed-file recorder and the real per-run actuals. Only the
// database is replaced by a small in-memory store.
//
// The fixtures have the layout of the shop's real RasterLink files (see
// tests/jobinfo-clear-actuals-2026-11-18.test.ts); the job names are the ticketed
// names Print Intake writes. This is NOT a live verification: no press, no NAS,
// no RIP PC and no production data were touched.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-19T16:00:00Z"), writes: [] as string[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, admin: {} }) },
}));

// In-memory database: equality (Date-aware, undefined == null), in / not /
// startsWith / contains, OR / NOT, the printLogEntry -> import relation,
// orderBy and take. Every write is recorded in h.writes.
vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "startsWith", "contains"]);
  const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : (a ?? null) === (b ?? null));
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "NOT") return !match(row, value);
    if (key === "import") {
      const parent = rows("printLogImport").find((candidate) => candidate.id === row.importId);
      return Boolean(parent) && match(parent, value);
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const ops = Object.keys(value);
      if (!ops.every((op) => OPS.has(op))) throw new Error(`test db: unsupported filter ${key}: ${JSON.stringify(value)}`);
      return ops.every((op) => {
        if (op === "in") return value.in.includes(row[key]);
        if (op === "not") return !eq(row[key], value.not);
        if (op === "startsWith") return String(row[key] ?? "").startsWith(String(value.startsWith));
        return String(row[key] ?? "").includes(String(value.contains));
      });
    }
    return eq(row[key], value);
  });
  const sorted = (list: any[], orderBy: any) => {
    const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
    if (!order) return list;
    const [field, direction] = Object.entries(order)[0] as [string, string];
    const value = (row: any) => (row[field] instanceof Date ? row[field].getTime() : row[field]);
    return [...list].sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (direction === "desc" ? -1 : 1));
  };
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") {
        const found = sorted(list.filter((row) => match(row, args.where)), args.orderBy)[0];
        return found ? { ...found } : null;
      }
      if (method === "findMany") {
        const found = sorted(list.filter((row) => match(row, args.where)), args.orderBy);
        return (args.take ? found.slice(0, args.take) : found).map((row) => ({ ...row }));
      }
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") {
        const data = Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined));
        const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...data };
        list.push(row);
        h.writes.push(`${name}.create`);
        return { ...row };
      }
      if (method === "update") {
        const found = list.find((row) => match(row, args.where));
        if (!found) throw new Error(`test db: ${name}.update found no row`);
        Object.assign(found, args.data, { updatedAt: new Date((h.clock += 1000)) });
        h.writes.push(`${name}.update`);
        return { ...found };
      }
      throw new Error(`test db: unsupported call ${name}.${method}`);
    },
  });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "$transaction") return async (fn: any) => fn(db);
      if (key === "$queryRawUnsafe") return async () => [];
      return model(key);
    },
  });
  return { default: db, db };
});

import db from "../app/db.server";
import { action } from "../app/routes/api.rip-imports.upload";
import { recordRoutedPrintFile } from "../app/lib/production-job-source.server";
import { applyRunSuffix, parseRunIdentity, ripFileBaseName } from "../app/lib/print-intake-routing.server";
import { actualsByRun, itemFileState, planReprintRuns, reprintNumberOfRipName, reprintNumberOfRun } from "../app/lib/production-run";
import { INK_BASIS_ESTIMATE, INK_BASIS_MISSING, looksLikeRasterlinkCsv, parseRasterlinkRows } from "../app/lib/rasterlink-parse.server";
import { INK_BASIS_JOBINFO_JOB_FOLDER, parseJobInfoIni } from "../app/lib/jobinfo-fallback.server";
import { ACTUALS_TRUSTED_CONFIDENCE, parseRipTickets, resolveRipIdentity } from "../app/lib/rip-identity-match.server";

const SHOP = "shop-1";
const TOKEN = "tok_patch_f_fixture";
const JOB = "GSO-20261119-0042";
const TICKET = `${JOB}-01`;
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// The names Print Intake gives the press — built by the real naming code.
const ITEM_ROW = { ripJobName: TICKET, itemTicket: TICKET, suggestedFileName: null } as any;
const CMYK = ripFileBaseName(ITEM_ROW, "crud_HEATH_F_CMYK.pdf");
const GLOSS = ripFileBaseName(ITEM_ROW, "crud_HEATH_F_g.pdf");
const CMYK_P1 = applyRunSuffix(CMYK, { revision: 1, reprint: 1, attempt: 1 });
const GLOSS_P1 = applyRunSuffix(GLOSS, { revision: 1, reprint: 1, attempt: 1 });

// ---------- RasterLink result files (real column layout) ----------
const PRINT_HEADER = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const CUT_HEADER = "KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const file = (header: string, ...lines: string[]) => [header, ...lines, ""].join("\r\n");

// Original production: a composite CMYK + gloss print-and-cut. As on the real
// press, the composite print rows carry NO ink and an arranged count of 0; the
// count (65) is on the paired cut result; the ink is in each layer's JobInfo.ini.
const ORIGINAL_PRINT_NAME = `20261119_134500_${CMYK}.pdf_1_OK_print.csv`;
const ORIGINAL_PRINT = file(
  PRINT_HEADER,
  `"${CMYK}.pdf","OK",,"20261119_101500","20261119_101512",,,"0",`,
  `"${GLOSS}.pdf","OK",,"20261119_101505","20261119_101512",,,"0",`,
);
const ORIGINAL_CUT_NAME = `20261119_134500_${CMYK}.pdf_1_OK_cut.csv`;
const ORIGINAL_CUT = file(CUT_HEADER, `"${CMYK}.pdf","OK","20261119_101508","20261119_101512","20261119_131000","20261119_134500","65",`);

// Reprint 1 (P1-A1): 3 pieces, plain print jobs — the result CSV reports ink itself.
const REPRINT_CMYK_NAME = `20261119_150700_${CMYK_P1}.pdf_1_OK_print.csv`;
const REPRINT_CMYK = file(PRINT_HEADER, `"${CMYK_P1}.pdf","OK","C:0.004cc M:0.070cc Y:0.099cc K:0.007cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261119_150000","20261119_150004","20261119_150100","20261119_150700","3",`);
const REPRINT_GLOSS_NAME = `20261119_151600_${GLOSS_P1}.pdf_1_OK_print.csv`;
const REPRINT_GLOSS = file(PRINT_HEADER, `"${GLOSS_P1}.pdf","OK","C:0.000cc M:0.000cc Y:0.000cc K:0.000cc W:0.000cc W:0.000cc Cl:0.152cc Cl:0.148cc ","20261119_150800","20261119_150803","20261119_150900","20261119_151600","3",`);

// What is in incoming\UCJV-300 today: a staff name with no ticket.
const UNTICKETED_NAME = "20261119_160000_crud_shortcakes F.pdf_1_OK_print.csv";
const UNTICKETED = file(PRINT_HEADER, '"crud_shortcakes F.pdf","OK","C:0.004cc M:0.070cc Y:0.099cc K:0.007cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261119_155000","20261119_155009","20261119_155100","20261119_160000","65",');

// A canonical-looking ticket that no job owns.
const UNKNOWN_TICKET = "GSO-20261119-0099-01";
const UNKNOWN_NAME = `20261119_170000_${UNKNOWN_TICKET}__mystery_F_CMYK.pdf_1_OK_print.csv`;
const UNKNOWN = file(PRINT_HEADER, `"${UNKNOWN_TICKET}__mystery_F_CMYK.pdf","OK","C:0.010cc M:0.010cc Y:0.010cc K:0.010cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261119_165000","20261119_165004","20261119_165100","20261119_170000","10",`);

// ---------- RasterLink job folders (real JobInfo.ini layout) ----------
const ini = (jobId: string, jobName: string, ripStart: string, ripEnd: string, inkUsed: string, primary: string) =>
  [
    "[Job]",
    `JobID="${jobId}"`,
    `Primary="${primary}"`,
    'DeviceName="UCJV-300"',
    "[Print]",
    `Member=("${jobId}";"${primary}")`,
    `jobName="${jobName}"`,
    `resultLogResult="${jobId}";"KEY_RIP_E_TIME";"${ripEnd}","${jobId}";"KEY_RIP_S_TIME";"${ripStart}"`,
    "[Rip]",
    "timeRIP=3496",
    `inkUsed=${inkUsed}`,
    "inkVolume=0;70,0;140",
  ].join("\r\n");
const CMYK_FOLDER = "S01_20261119101400111";
const GLOSS_FOLDER = "S01_20261119101400222";
const PRIMARY_FOLDER = "S01_20261119101400000";
const CMYK_INI = ini(CMYK_FOLDER, `${CMYK}.pdf`, "20261119_101500", "20261119_101512", "1;4,2;70,3;99,4;7,131;0,133;0,136;0,137;0", PRIMARY_FOLDER);
// The two clear slots differ on purpose: a SUM (0.152 + 0.148), not "one slot doubled".
const GLOSS_INI = ini(GLOSS_FOLDER, `${GLOSS}.pdf`, "20261119_101505", "20261119_101512", "1;0,2;0,3;0,4;0,131;0,133;0,136;152,137;148", PRIMARY_FOLDER);

const ARRANGED = 65;
const CMYK_PER_ITEM = 0.004 + 0.07 + 0.099 + 0.007; // 0.18 cc
const CLEAR_PER_ITEM = 0.152 + 0.148; // 0.30 cc

// ---------- the sync script's request, to the real route ----------
async function post(fileName: string, text: string, extra: Record<string, string> = {}, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const form = new FormData();
  if (token != null) form.set("token", token);
  form.set("source", "rasterlink");
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  form.set("file", new File([text], fileName, { type: "text/csv" }));
  const response = await action({ request: new Request("https://erp.test/api/rip-imports/upload", { method: "POST", body: form }) });
  return { status: response.status, body: await response.json() };
}
const postJobInfo = (folder: string, text: string) => post("JobInfo.ini", text, { jobFolder: folder });

const table = (name: string): any[] => h.t[name] || [];
const entries = () => table("printLogEntry");
const entryOf = (sourceJobName: string, kind: "print" | "cut" = "print") => entries().filter((entry) => entry.sourceJobName === sourceJobName && String(entry.status).startsWith(`${kind}:`));
const raw = (entry: any) => JSON.parse(entry.rawRow);
const jobSideCounts = () => ["productionJob", "productionJobItem", "productionJobFile", "productionRun", "productionJobEvent"].map((name) => table(name).length);
const snapshot = () => JSON.stringify(entries().map((entry) => [entry.id, entry.sourceJobName, entry.status, entry.productionJobId ?? null, entry.productionJobItemId ?? null, entry.inkMl, entry.cmykInkMl, entry.whiteInkMl, entry.glossInkMl, entry.printMinutes, entry.rawRow]));
/** The exact filter the production page applies before actualsByRun (app.erp.production.tsx). */
const itemActuals = (itemId: string) => actualsByRun(table("productionRun").filter((run) => run.itemId === itemId), entries().filter((entry) => entry.productionJobItemId === itemId));

let runLabelWritten = "";
const ROUTED = { shop: SHOP, jobId: "job_42", jobTicket: JOB, machine: "mimaki" as const, itemTicket: TICKET };

beforeEach(async () => {
  for (const key of Object.keys(h.t)) delete h.t[key];
  h.seq = 0;
  h.writes.length = 0;
  h.t.printLogAutoImportSetting = [{ id: "setting_1", shop: SHOP, uploadToken: TOKEN, enabled: true, lastAutoImportAt: null }];
  h.t.productionJob = [
    { id: "job_42", shop: SHOP, jobTicket: JOB },
    { id: "job_43", shop: SHOP, jobTicket: "GSO-20261119-0043" },
    { id: "job_other_shop", shop: "other-shop", jobTicket: JOB },
  ];
  h.t.productionJobItem = [
    { id: "item_42_01", shop: SHOP, jobId: "job_42", itemTicket: TICKET, ripJobName: TICKET, suggestedFileName: null, productTitle: "Crud HEATH jar label", quantity: 500, selectedFinish: "Gloss", updatedAt: new Date("2026-11-19T15:00:00Z") },
    { id: "item_42_02", shop: SHOP, jobId: "job_42", itemTicket: `${JOB}-02`, ripJobName: `${JOB}-02`, suggestedFileName: null, productTitle: "Crud shortcakes jar label", quantity: 500, selectedFinish: "Gloss", updatedAt: new Date("2026-11-19T15:00:01Z") },
    { id: "item_43_01", shop: SHOP, jobId: "job_43", itemTicket: "GSO-20261119-0043-01", ripJobName: "GSO-20261119-0043-01", suggestedFileName: null, productTitle: "Other customer label", quantity: 100, selectedFinish: "Gloss", updatedAt: new Date("2026-11-19T15:00:02Z") },
    { id: "item_other_shop", shop: "other-shop", jobId: "job_other_shop", itemTicket: TICKET, ripJobName: TICKET, suggestedFileName: null, productTitle: "Same ticket, another shop", quantity: 1, selectedFinish: "Gloss", updatedAt: new Date("2026-11-19T15:00:03Z") },
  ];
  // Print Intake delivered both layers of item 01 (the original production).
  await recordRoutedPrintFile(db, { ...ROUTED, fileHash: HASH("a"), originalFileName: "crud_HEATH_F_CMYK.pdf", routedFileName: CMYK });
  await recordRoutedPrintFile(db, { ...ROUTED, fileHash: HASH("b"), originalFileName: "crud_HEATH_F_g.pdf", routedFileName: GLOSS });
  // The reprint request writes run 1 (original) + run 2 (reprint), planned by the real planner.
  const planned = planReprintRuns([], { quantity: 500, qcResult: "pass" }, { kind: "reprint", quantity: 3 });
  runLabelWritten = `P${parseRunIdentity(CMYK_P1).reprint}-A1`; // the label the reprint action writes (source-pinned below)
  h.t.productionRun = [
    { id: "run_1", shop: SHOP, jobId: "job_42", itemId: "item_42_01", runNumber: planned.original!.runNumber, kind: "original", quantity: planned.original!.quantity, status: planned.original!.status, runLabel: "A1" },
    { id: "run_2", shop: SHOP, jobId: "job_42", itemId: "item_42_01", runNumber: planned.next.runNumber, kind: planned.next.kind, quantity: planned.next.quantity, status: planned.next.status, runLabel: runLabelWritten },
  ];
  h.writes.length = 0;
});

/** The whole original production as the sync sends it: cut result first, then the print result, then each layer's JobInfo.ini. */
async function importOriginal() {
  const cut = await post(ORIGINAL_CUT_NAME, ORIGINAL_CUT);
  const print = await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT);
  const cmykInk = await postJobInfo(CMYK_FOLDER, CMYK_INI);
  const glossInk = await postJobInfo(GLOSS_FOLDER, GLOSS_INI);
  return { cut, print, cmykInk, glossInk };
}

describe("LINK 1 — ticketed routed name -> ProductionJobFile -> ProductionJobItem", () => {
  it("the routed names are the item ticket + the staff file name, and a reprint only adds the run token at the end", () => {
    expect(CMYK).toBe(`${TICKET}__crud_HEATH_F_CMYK`);
    expect(GLOSS).toBe(`${TICKET}__crud_HEATH_F_g`);
    expect(CMYK_P1).toBe(`${TICKET}__crud_HEATH_F_CMYK__P1-A1`);
    expect(GLOSS_P1).toBe(`${TICKET}__crud_HEATH_F_g__P1-A1`);
    for (const name of [CMYK, GLOSS, CMYK_P1, GLOSS_P1]) expect(parseRipTickets(`${name}.pdf`), name).toMatchObject({ itemTicket: TICKET, jobTicket: JOB });
  });

  it("every delivered file is a print_file / nas row on the exact item (never the sibling item of the same job)", () => {
    const files = table("productionJobFile");
    expect(files.map((row) => [row.fileName, row.jobId, row.productionJobItemId, row.fileType, row.assetSource])).toEqual([
      [`${CMYK}.pdf`, "job_42", "item_42_01", "print_file", "nas"],
      [`${GLOSS}.pdf`, "job_42", "item_42_01", "print_file", "nas"],
    ]);
    const [item01, item02] = table("productionJobItem");
    expect(itemFileState(item01, files)).toMatchObject({ received: 2, awaiting: false, expected: ["CMYK", "Gloss"] });
    expect(itemFileState(item02, files)).toMatchObject({ received: 0, awaiting: true });
  });

  it("a reprint re-delivers the SAME file content: the file row is renamed to the run name (one row per content), and results under EITHER name still reach the item by its ticket", async () => {
    // Observed behaviour, stated as it is: ProductionJobFile is keyed by job + content hash,
    // so the reprint does not add rows — the original routed name is replaced on the row.
    const cmyk = await recordRoutedPrintFile(db, { ...ROUTED, fileHash: HASH("a"), originalFileName: "crud_HEATH_F_CMYK.pdf", routedFileName: CMYK_P1 });
    const gloss = await recordRoutedPrintFile(db, { ...ROUTED, fileHash: HASH("b"), originalFileName: "crud_HEATH_F_g.pdf", routedFileName: GLOSS_P1 });
    expect([cmyk.result, gloss.result]).toEqual(["updated", "updated"]);
    expect(table("productionJobFile").map((row) => [row.fileName, row.productionJobItemId])).toEqual([
      [`${CMYK_P1}.pdf`, "item_42_01"],
      [`${GLOSS_P1}.pdf`, "item_42_01"],
    ]);
    // The item link does not depend on the file row's current name: it is the ticket in the reported name.
    expect((await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT)).body).toMatchObject({ created: 2, matched: 2 });
    expect((await post(REPRINT_CMYK_NAME, REPRINT_CMYK)).body).toMatchObject({ created: 1, matched: 1 });
    for (const entry of entries()) expect(entry, entry.sourceJobName).toMatchObject({ productionJobId: "job_42", productionJobItemId: "item_42_01" });
  });
});

describe("LINK 2 — RasterLink result CSV -> exact item, by the item ticket in the name the press reports", () => {
  it("the ticketed composite result parses as two blank-ink print rows that keep the routed name verbatim", () => {
    expect(looksLikeRasterlinkCsv(ORIGINAL_PRINT)).toBe(true);
    const rows = parseRasterlinkRows(ORIGINAL_PRINT, ORIGINAL_PRINT_NAME);
    expect(rows.map((row) => [row.kind, row.fileName, row.status, row.inkMl, row.raw.inkBasis, row.raw.arrangeCnt])).toEqual([
      ["print", `${CMYK}.pdf`, "print:OK", 0, INK_BASIS_MISSING, null],
      ["print", `${GLOSS}.pdf`, "print:OK", 0, INK_BASIS_MISSING, null],
    ]);
    expect(rows[0].jobTicket).toBe(TICKET); // "__" keeps the ticket as the first "_" segment
    expect(rows[1].jobTicket).toBe(TICKET);
    expect((rows[0].ripCompletedAt!.getTime() - rows[0].ripStartedAt!.getTime()) / 1000).toBe(12);
    expect(rows[0].startedAt).toBeNull(); // RIP time is never stored as print time
    expect(rows[0].printMinutes).toBe(0);
  });

  it("the route links every row (CMYK, gloss, cut) to job 42 / item 01 as exact_item_ticket and writes print-log rows only", async () => {
    const before = jobSideCounts();
    const cut = await post(ORIGINAL_CUT_NAME, ORIGINAL_CUT);
    const print = await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT);
    expect(cut).toMatchObject({ status: 200, body: { ok: true, format: "rasterlink", rows: 1, created: 1, matched: 1, ambiguous: 0, unmatched: 0, skippedDuplicates: 0 } });
    expect(print).toMatchObject({ status: 200, body: { ok: true, format: "rasterlink", rows: 2, created: 2, matched: 2, ambiguous: 0, unmatched: 0, skippedDuplicates: 0 } });
    expect(entries()).toHaveLength(3);
    for (const entry of entries()) {
      expect(entry, entry.sourceJobName).toMatchObject({ shop: SHOP, productionJobId: "job_42", productionJobItemId: "item_42_01", jobTicket: TICKET, printerSoftware: "rasterlink" });
      expect(raw(entry)).toMatchObject({ matchMethod: "exact_item_ticket", matchCandidateJobIds: ["job_42"] });
      expect(raw(entry).matchFlag).toBeUndefined();
    }
    expect(ACTUALS_TRUSTED_CONFIDENCE.has("exact_item_ticket")).toBe(true);
    expect(entryOf(`${GLOSS}.pdf`)).toHaveLength(1); // the gloss layer is its own row on the same item
    expect(jobSideCounts()).toEqual(before); // no job, item, file, run or event is created by a result
    expect([...new Set(h.writes)].sort()).toEqual(["printLogAutoImportSetting.update", "printLogEntry.create", "printLogImport.create", "printLogImport.update"]);
  });

  it("the same ticket in another shop is never reached: the match is shop-scoped", async () => {
    const identity = await resolveRipIdentity(db, SHOP, { jobName: `${CMYK}.pdf`, fileName: ORIGINAL_PRINT_NAME });
    expect(identity).toMatchObject({ status: "matched", confidence: "exact_item_ticket", productionJobId: "job_42", productionJobItemId: "item_42_01", itemTicket: TICKET, jobTicket: JOB });
    const elsewhere = await resolveRipIdentity(db, "other-shop", { jobName: `${CMYK}.pdf`, fileName: ORIGINAL_PRINT_NAME });
    expect(elsewhere).toMatchObject({ status: "matched", productionJobId: "job_other_shop", productionJobItemId: "item_other_shop" });
  });

  it("an item ticket no item owns, on a job that exists, links the JOB only — it is never moved onto a sibling item", async () => {
    const name = `${JOB}-07__crud_OTHER_F_CMYK.pdf`;
    const result = await post(`20261119_180000_${name}_1_OK_print.csv`, file(PRINT_HEADER, `"${name}","OK","C:0.010cc M:0.010cc Y:0.010cc K:0.010cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261119_175000","20261119_175004","20261119_175100","20261119_180000","5",`));
    expect(result.body).toMatchObject({ created: 1, matched: 1 });
    const [entry] = entryOf(name);
    expect(entry.productionJobId).toBe("job_42");
    expect(entry.productionJobItemId ?? null).toBeNull();
    expect(raw(entry)).toMatchObject({ matchMethod: "exact_job_ticket", matchReasons: [`unknown_item_ticket:${JOB}-07`] });
    expect(itemActuals("item_42_01")).toEqual([]); // nothing lands on item 01's runs
    expect(itemActuals("item_42_02")).toEqual([]);
  });
});

describe("LINK 3 — JobInfo.ini -> clear / gloss ink on the print-log entry (both clear slots summed)", () => {
  it("the gloss layer's job folder states its own identity and both clear slots", () => {
    const record = parseJobInfoIni(GLOSS_INI, GLOSS_FOLDER);
    expect(record.rasterlinkJob).toEqual({ jobId: GLOSS_FOLDER, fileName: `${GLOSS}.pdf`, ripStartStamp: "20261119_101505", ripEndStamp: "20261119_101512" });
    expect(record.ink.clearSlot1Cc).toBeCloseTo(0.152, 9);
    expect(record.ink.clearSlot2Cc).toBeCloseTo(0.148, 9);
    expect(record.ink.clearCc).toBeCloseTo(CLEAR_PER_ITEM, 9);
    expect(record.ink.perItemKnownCc).toBe(0); // a gloss layer carries no CMYK
  });

  it("through the route: the CMYK row gets CMYK, the gloss row gets slot 136 + slot 137, each x the arranged count from the paired cut result", async () => {
    const { cmykInk, glossInk } = await importOriginal();
    const [cmyk] = entryOf(`${CMYK}.pdf`);
    const [gloss] = entryOf(`${GLOSS}.pdf`);
    expect(cmykInk).toMatchObject({ status: 200, body: { ok: true, jobInfo: true, jobFolder: true, outcome: "applied", updated: 1, updatedEntryId: cmyk.id, sourceId: CMYK_FOLDER, inkBasis: INK_BASIS_JOBINFO_JOB_FOLDER } });
    expect(glossInk).toMatchObject({ status: 200, body: { ok: true, jobInfo: true, jobFolder: true, outcome: "applied", updated: 1, updatedEntryId: gloss.id, sourceId: GLOSS_FOLDER, inkBasis: INK_BASIS_JOBINFO_JOB_FOLDER } });

    expect(cmyk.cmykInkMl).toBeCloseTo(CMYK_PER_ITEM * ARRANGED, 9); // 11.70 mL
    expect(cmyk.glossInkMl).toBe(0);
    expect(cmyk.whiteInkMl).toBe(0);
    expect(cmyk.inkMl).toBeCloseTo(11.7, 9);

    expect(gloss.cmykInkMl).toBe(0);
    expect(gloss.whiteInkMl).toBe(0);
    expect(gloss.glossInkMl).toBeCloseTo(CLEAR_PER_ITEM * ARRANGED, 9); // (0.152 + 0.148) x 65 = 19.50 mL
    expect(gloss.inkMl).toBeCloseTo(19.5, 9);
    expect(gloss.glossInkMl).not.toBeCloseTo(0.152 * ARRANGED, 3); // one slot alone would under-report
    expect(gloss.glossInkMl).not.toBeCloseTo(0.152 * 2 * ARRANGED, 3); // and it is a sum, not "slot 1 doubled"
    const provenance = raw(gloss).jobInfoFallback;
    expect(provenance).toMatchObject({ sourceId: GLOSS_FOLDER, linkage: "exact_job_id_file_name_rip_window", jobName: `${GLOSS}.pdf`, arrangeCnt: ARRANGED, arrangeSource: "paired_cut_result", estimate: true, originalInkBasis: INK_BASIS_MISSING });
    expect(provenance.clearSlot1TotalCc).toBeCloseTo(0.152 * ARRANGED, 9);
    expect(provenance.clearSlot2TotalCc).toBeCloseTo(0.148 * ARRANGED, 9);
    expect(provenance.clearTotalCc).toBeCloseTo(19.5, 9);
    expect(raw(gloss).inkBasis).toBe(INK_BASIS_JOBINFO_JOB_FOLDER);

    // The ink landed on rows that are still linked to the exact item, by the same trusted method.
    for (const entry of [cmyk, gloss]) {
      expect(entry).toMatchObject({ productionJobId: "job_42", productionJobItemId: "item_42_01", jobTicket: TICKET });
      expect(raw(entry).matchMethod).toBe("exact_item_ticket");
    }
    // Only the two print rows were updated; the cut row keeps no ink.
    expect(h.writes.filter((write) => write === "printLogEntry.update")).toHaveLength(2);
    expect(entryOf(`${CMYK}.pdf`, "cut")[0]).toMatchObject({ inkMl: 0, glossInkMl: 0 });
  });

  it("a job folder is refused unless folder name, file name and RIP window are all exactly this row's", async () => {
    await post(ORIGINAL_CUT_NAME, ORIGINAL_CUT);
    await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT);
    const before = snapshot();
    // the gloss file posted under the CMYK layer's folder name
    expect((await postJobInfo(CMYK_FOLDER, GLOSS_INI)).body).toMatchObject({ ok: true, outcome: "no_candidates", updated: 0 });
    // the un-ticketed twin of the same artwork
    expect((await postJobInfo(GLOSS_FOLDER, GLOSS_INI.replace(`${GLOSS}.pdf`, "crud_HEATH_F_g.pdf"))).body).toMatchObject({ outcome: "no_candidates", updated: 0 });
    // the reprint's name with the original's RIP window
    expect((await postJobInfo(GLOSS_FOLDER, GLOSS_INI.replace(`${GLOSS}.pdf`, `${GLOSS_P1}.pdf`))).body).toMatchObject({ outcome: "no_candidates", updated: 0 });
    // the right file, RIPped one second later
    expect((await postJobInfo(GLOSS_FOLDER, GLOSS_INI.replace("20261119_101512", "20261119_101513"))).body).toMatchObject({ outcome: "no_candidates", updated: 0 });
    expect(snapshot()).toBe(before);
  });

  it("without the cut result there is no arranged count: the per-item figure is never stored as the job total", async () => {
    await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT);
    const before = snapshot();
    expect((await postJobInfo(GLOSS_FOLDER, GLOSS_INI)).body).toMatchObject({ ok: true, outcome: "rejected", reason: "arrange_count_unknown", updated: 0 });
    expect(snapshot()).toBe(before);
    // The cut result arriving later makes the same job folder applicable — nothing was burned by the refusal.
    await post(ORIGINAL_CUT_NAME, ORIGINAL_CUT);
    expect((await postJobInfo(GLOSS_FOLDER, GLOSS_INI)).body).toMatchObject({ outcome: "applied", updated: 1 });
    expect(entryOf(`${GLOSS}.pdf`)[0].glossInkMl).toBeCloseTo(19.5, 9);
  });

  it("a plain (non-composite) gloss result that reports its own ink also sums both Cl values", async () => {
    await post(REPRINT_GLOSS_NAME, REPRINT_GLOSS);
    const [entry] = entryOf(`${GLOSS_P1}.pdf`);
    expect(entry.glossInkMl).toBeCloseTo(CLEAR_PER_ITEM * 3, 9); // 0.90 mL
    expect(entry.cmykInkMl).toBe(0);
    expect(raw(entry)).toMatchObject({ inkBasis: INK_BASIS_ESTIMATE, arrangeCnt: 3, arrangeAssumed: false });
    expect(entry.printMinutes).toBeCloseTo(7, 9); // 15:09:00 -> 15:16:00
  });
});

describe("LINK 4 — ProductionRun: the reprint's results belong to run 2, the original's to run 1", () => {
  it("the run token is read from the END of the reported name and equals the routing code's own reading", () => {
    for (const name of [`${CMYK}.pdf`, `${GLOSS}.pdf`, `${CMYK_P1}.pdf`, `${GLOSS_P1}.pdf`, `${CMYK}__A2.pdf`, `${CMYK}__R2-P2-A3.pdf`]) {
      expect(reprintNumberOfRipName(name), name).toBe(parseRunIdentity(name).reprint);
    }
    expect(reprintNumberOfRipName(`${CMYK_P1}.pdf`)).toBe(1);
    expect(reprintNumberOfRipName(`${CMYK}.pdf`)).toBe(0);
    expect(runLabelWritten).toBe("P1-A1");
    expect(reprintNumberOfRun({ itemId: "item_42_01", runNumber: 2, kind: "reprint", quantity: 3, runLabel: runLabelWritten })).toBe(1);
  });

  it("original (JobInfo ink) + reprint (CSV ink), imported through the route, split into Run 1 and Run 2 on the exact item", async () => {
    await importOriginal();
    expect((await post(REPRINT_CMYK_NAME, REPRINT_CMYK)).body).toMatchObject({ created: 1, matched: 1, unmatched: 0 });
    expect((await post(REPRINT_GLOSS_NAME, REPRINT_GLOSS)).body).toMatchObject({ created: 1, matched: 1, unmatched: 0 });
    for (const name of [CMYK_P1, GLOSS_P1]) {
      expect(entryOf(`${name}.pdf`)[0], name).toMatchObject({ productionJobId: "job_42", productionJobItemId: "item_42_01", jobTicket: TICKET });
    }

    const actuals = itemActuals("item_42_01");
    expect(actuals.map((row) => [row.runNumber, row.kind, row.label, row.entries])).toEqual([
      [1, "original", "Run 1 — Original", 3], // CMYK print + gloss print + cut (the cut row carries no ink)
      [2, "reprint", "Run 2 — Reprint", 2],
    ]);
    expect(actuals[0].inkMl).toBeCloseTo(11.7 + 19.5, 9); // 31.20 mL: CMYK + both clear slots
    expect(actuals[0].printMinutes).toBe(0); // composite rows report no print window; nothing is invented from RIP or cut time
    expect(actuals[1].inkMl).toBeCloseTo(CMYK_PER_ITEM * 3 + CLEAR_PER_ITEM * 3, 9); // 0.54 + 0.90 = 1.44 mL
    expect(actuals[1].printMinutes).toBeCloseTo(6 + 7, 9);
    // every linked mL is on exactly one run
    const linked = entries().filter((entry) => entry.productionJobItemId === "item_42_01").reduce((sum, entry) => sum + entry.inkMl, 0);
    expect(actuals.reduce((sum, row) => sum + row.inkMl, 0)).toBeCloseTo(linked, 9);
    expect(itemActuals("item_42_02")).toEqual([]); // the sibling item of the same job receives nothing
    expect(itemActuals("item_43_01")).toEqual([]);
  });

  it("a reprint result with no recorded run is listed on its own line, never added to another run", async () => {
    const name = `${applyRunSuffix(CMYK, { revision: 1, reprint: 7, attempt: 1 })}.pdf`;
    await post(`20261119_190000_${name}_1_OK_print.csv`, file(PRINT_HEADER, `"${name}","OK","C:0.004cc M:0.070cc Y:0.099cc K:0.007cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261119_185000","20261119_185004","20261119_185100","20261119_190000","2",`));
    expect(itemActuals("item_42_01").map((row) => [row.runNumber, row.label, row.entries])).toEqual([[null, "Reprint P7 — no run recorded", 1]]);
  });

  it("the production page feeds actualsByRun exactly this way (source pin: the loader itself is not executed here)", () => {
    const route = src("app/routes/app.erp.production.tsx");
    expect(route).toContain("item.runActuals = actualsByRun(item.runs, (entriesByJob[job.id] || []).filter((entry: any) => entry.productionJobItemId === item.id));");
    expect(route).toContain("const runLabel = nextRun ? `${nextRun.revision > 1 ? `R${nextRun.revision}-` : \"\"}P${nextRun.reprint}-A1` : \"P1-A1\";");
    expect(route).toContain("name: applyRunSuffix(layer.routedFilename || item.ripJobName || item.itemTicket || \"\", run)");
  });
});

describe("LINK 5 — idempotent re-import: no second PrintLogEntry, no doubled ink", () => {
  it("the same result files sent again are refused by name + content hash; nothing is written", async () => {
    await importOriginal();
    const before = snapshot();
    const imports = table("printLogImport").length;
    h.writes.length = 0;
    const cut = await post(ORIGINAL_CUT_NAME, ORIGINAL_CUT);
    const print = await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT);
    expect(cut.body).toMatchObject({ ok: true, duplicateFile: true });
    expect(print.body).toMatchObject({ ok: true, duplicateFile: true });
    expect(h.writes).toEqual([]);
    expect(table("printLogImport")).toHaveLength(imports);
    expect(snapshot()).toBe(before);
  });

  it("the same result replayed under ANOTHER file name collapses row by row, and the JobInfo ink already on the rows survives", async () => {
    await importOriginal();
    const before = snapshot();
    const print = await post(`20261119_999999_replayed_${CMYK}.pdf_1_OK_print.csv`, ORIGINAL_PRINT);
    const cut = await post(`20261119_999999_replayed_${CMYK}.pdf_1_OK_cut.csv`, ORIGINAL_CUT);
    expect(print.body).toMatchObject({ ok: true, rows: 2, created: 0, skippedDuplicates: 2, matched: 0 });
    expect(cut.body).toMatchObject({ ok: true, rows: 1, created: 0, skippedDuplicates: 1 });
    expect(entries()).toHaveLength(3);
    expect(snapshot()).toBe(before);
    expect(entryOf(`${GLOSS}.pdf`)[0].glossInkMl).toBeCloseTo(19.5, 9); // not reset to 0 by the blank-ink replay, not doubled
  });

  it("a replayed JobInfo.ini writes nothing: the row is already enriched", async () => {
    await importOriginal();
    const before = snapshot();
    h.writes.length = 0;
    const gloss = entryOf(`${GLOSS}.pdf`)[0];
    const again = await postJobInfo(GLOSS_FOLDER, GLOSS_INI);
    expect(again.body).toMatchObject({ ok: true, outcome: "no_candidates", updated: 0, ineligible: [{ rowId: gloss.id, reason: "already_enriched" }] });
    expect((await postJobInfo(CMYK_FOLDER, CMYK_INI)).body).toMatchObject({ outcome: "no_candidates", updated: 0 });
    expect(h.writes).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("the whole chain imported twice (same names, then new names) leaves the per-run actuals exactly as after the first import", async () => {
    await importOriginal();
    await post(REPRINT_CMYK_NAME, REPRINT_CMYK);
    await post(REPRINT_GLOSS_NAME, REPRINT_GLOSS);
    const actuals = JSON.stringify(itemActuals("item_42_01"));
    const before = snapshot();
    const count = entries().length;
    expect(count).toBe(5);

    await importOriginal();
    await post(REPRINT_CMYK_NAME, REPRINT_CMYK);
    await post(REPRINT_GLOSS_NAME, REPRINT_GLOSS);
    for (const [name, text] of [[ORIGINAL_CUT_NAME, ORIGINAL_CUT], [ORIGINAL_PRINT_NAME, ORIGINAL_PRINT], [REPRINT_CMYK_NAME, REPRINT_CMYK], [REPRINT_GLOSS_NAME, REPRINT_GLOSS]]) {
      const replay = await post(`again_${name}`, text);
      expect(replay.body, name).toMatchObject({ ok: true, created: 0 });
    }
    await postJobInfo(CMYK_FOLDER, CMYK_INI);
    await postJobInfo(GLOSS_FOLDER, GLOSS_INI);

    expect(entries()).toHaveLength(count);
    expect(snapshot()).toBe(before);
    expect(JSON.stringify(itemActuals("item_42_01"))).toBe(actuals);
  });

  it("the original and its reprint are DIFFERENT events: the reprint is never swallowed as a duplicate of the original", async () => {
    await importOriginal();
    expect((await post(REPRINT_CMYK_NAME, REPRINT_CMYK)).body).toMatchObject({ created: 1, skippedDuplicates: 0 });
    expect(entryOf(`${CMYK}.pdf`)).toHaveLength(1);
    expect(entryOf(`${CMYK_P1}.pdf`)).toHaveLength(1);
  });
});

describe("SAFETY — what has no ticket, or an unknown ticket, stays unmatched and reviewable", () => {
  it("an un-ticketed result (crud_shortcakes F) is stored unmatched with a structured reason; no job is created or guessed", async () => {
    const before = jobSideCounts();
    const result = await post(UNTICKETED_NAME, UNTICKETED);
    expect(result.body).toMatchObject({ ok: true, rows: 1, created: 1, matched: 0, ambiguous: 0, unmatched: 1 });
    const [entry] = entryOf("crud_shortcakes F.pdf");
    expect(entry.productionJobId ?? null).toBeNull();
    expect(entry.productionJobItemId ?? null).toBeNull();
    expect(raw(entry)).toMatchObject({ matchMethod: null, matchReasons: ["no_ticket_identity"], matchCandidateJobIds: [] });
    expect(entry.inkMl).toBeCloseTo(CMYK_PER_ITEM * 65, 9); // the result itself is kept in full for review
    expect(jobSideCounts()).toEqual(before);
    for (const itemId of ["item_42_01", "item_42_02", "item_43_01"]) expect(itemActuals(itemId)).toEqual([]);
    expect(table("printLogImport").at(-1)).toMatchObject({ status: "processed", matchedCount: 0, unmatchedCount: 1 });
  });

  it("an un-ticketed result does not match even when a ticketed file with the same staff name was routed", async () => {
    await recordRoutedPrintFile(db, { shop: SHOP, jobId: "job_42", jobTicket: JOB, machine: "mimaki", itemTicket: `${JOB}-02`, fileHash: HASH("c"), originalFileName: "crud_shortcakes F.pdf", routedFileName: ripFileBaseName({ ripJobName: `${JOB}-02`, itemTicket: `${JOB}-02`, suggestedFileName: null } as any, "crud_shortcakes F.pdf") });
    expect(table("productionJobFile").at(-1).fileName).toBe(`${JOB}-02__crud_shortcakes_F.pdf`);
    const result = await post(UNTICKETED_NAME, UNTICKETED);
    expect(result.body).toMatchObject({ created: 1, matched: 0, unmatched: 1 });
    expect(entryOf("crud_shortcakes F.pdf")[0].productionJobId ?? null).toBeNull();
  });

  it("a result for an unknown ticket stays unmatched: reasons name the ticket, nothing is created for it", async () => {
    const before = jobSideCounts();
    const result = await post(UNKNOWN_NAME, UNKNOWN);
    expect(result.body).toMatchObject({ ok: true, rows: 1, created: 1, matched: 0, ambiguous: 0, unmatched: 1 });
    const [entry] = entryOf(`${UNKNOWN_TICKET}__mystery_F_CMYK.pdf`);
    expect(entry.productionJobId ?? null).toBeNull();
    expect(entry.productionJobItemId ?? null).toBeNull();
    expect(entry.jobTicket).toBe(UNKNOWN_TICKET); // kept as reported, for the reviewer
    expect(raw(entry)).toMatchObject({ matchMethod: null, matchReasons: [`unknown_item_ticket:${UNKNOWN_TICKET}`, "unknown_job_ticket:GSO-20261119-0099"], matchCandidateJobIds: [] });
    expect(jobSideCounts()).toEqual(before);
    expect(table("productionJob").some((job) => job.jobTicket === "GSO-20261119-0099")).toBe(false);
  });

  it("unmatched rows are what RIP Import Review lists (source pin: the review page is not executed here)", () => {
    const review = src("app/routes/app.erp.rip-import-review.tsx");
    expect(review).toContain('...(filters.status === "attached" ? { productionJobId: { not: null } } : filters.status !== "all" ? { productionJobId: null } : {}),');
  });

  // DEFECT found by this fixture on 2026-11-19 (before the fix):
  // app/routes/api.rip-imports.upload.tsx:255 passes the RESULT FILE name to the matcher
  // for every row, and app/lib/rip-identity-match.server.ts:174 lifts a ticket from it
  // when the row's own name has none — so the un-ticketed row below is stored as
  // exact_item_ticket on job_42 / item_42_01 (a method trusted for actuals).
  // FIXED 2026-11-19: the result file name is used only for a row with no name of its own.
  it("an un-ticketed layer inside a composite whose RESULT FILE is named after a ticketed layer is not attributed to that ticket", async () => {
    // RasterLink names a composite's result file after its first job. The second
    // row here is a staff file with no ticket: it must stay unmatched.
    const name = `20261119_200000_${CMYK}.pdf_1_OK_print.csv`;
    const mixed = file(
      PRINT_HEADER,
      `"${CMYK}.pdf","OK",,"20261119_195000","20261119_195012",,,"0",`,
      '"crud_all_b_g.pdf","OK",,"20261119_195005","20261119_195012",,,"0",',
    );
    await post(name, mixed);
    const [stray] = entryOf("crud_all_b_g.pdf");
    expect(stray.productionJobId ?? null).toBeNull();
    expect(stray.productionJobItemId ?? null).toBeNull();
  });

  it("the upload is refused without the shop's token, and nothing is written", async () => {
    expect((await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT, {}, null)).status).toBe(401);
    expect((await post(ORIGINAL_PRINT_NAME, ORIGINAL_PRINT, {}, "wrong-token")).status).toBe(403);
    expect(entries()).toHaveLength(0);
    expect(h.writes).toEqual([]);
  });
});

describe("SCOPE — what this file does and does not prove", () => {
  it("the sync script posts exactly what these tests post (source pin: the PowerShell is not executed here)", () => {
    const sync = src("tools/gso-rasterlink-sync.ps1");
    expect(sync).toContain('$fields.Add("token", $Config.UploadToken)');
    expect(sync).toContain('$fields.Add("source", $Config.Source)');
    expect(sync).toContain('$body = New-GsoMultipartBody $boundary $fields "file" $FileName $fileBytes "text/csv"');
    expect(sync).toContain('$extra.Add("jobFolder", $folder.JobId)');
    expect(sync).toContain('$result = Invoke-RipUpload $Config $folder.IniPath "JobInfo.ini" $extra');
  });
});
