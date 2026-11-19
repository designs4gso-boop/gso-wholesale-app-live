// Print Intake Patch F (2026-11-18) — RIP result matching against the files
// Print Intake actually delivered.
//
// The result pipeline itself (token upload, file + row de-duplication, exact
// identity matching, print-log storage) already exists. Patch F adds ONE
// matcher stage: a result whose RIP job name is exactly the routed print-file
// name recorded on a job (ProductionJobFile print_file / nas) links to that job.
// It links the print log only — it is NOT trusted for actual-cost linkage.
// Live activation of the RasterLink / VersaWorks sources is a separate,
// owner-run step (see docs/GSO_ERP_PROJECT_STATE.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTUALS_TRUSTED_CONFIDENCE, resolveRipIdentity } from "../app/lib/rip-identity-match.server";
import { matchMethodAllowsActuals } from "../app/lib/rip-capture.server";
import { looksLikeRasterlinkCsv, parseRasterlinkRows, rowDedupeWhere } from "../app/lib/rasterlink-parse.server";

type Item = { id: string; shop: string; jobId: string; itemTicket: string | null; ripJobName: string | null; suggestedFileName: string | null };
type Job = { id: string; shop: string; jobTicket: string | null };
type File = { shop: string; jobId: string; fileType: string; assetSource: string; fileName: string };
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function fakeDb(jobs: Job[], items: Item[], files: File[], calls: string[] = []) {
  return {
    productionJobItem: {
      findMany: async ({ where, take }: any) => {
        calls.push("productionJobItem.findMany");
        let hits = items.filter((item) => item.shop === where.shop);
        if (where.itemTicket) hits = hits.filter((item) => item.itemTicket === where.itemTicket);
        else if (where.ripJobName?.in) hits = hits.filter((item) => item.ripJobName && where.ripJobName.in.includes(item.ripJobName));
        else if (where.OR) hits = hits.filter((item) => item.ripJobName || item.suggestedFileName);
        return (take ? hits.slice(0, take) : hits).map((item) => ({ ...item }));
      },
    },
    productionJob: {
      findMany: async ({ where, take }: any) => {
        calls.push("productionJob.findMany");
        const hits = jobs.filter((job) => job.shop === where.shop && job.jobTicket === where.jobTicket);
        return (take ? hits.slice(0, take) : hits).map((job) => ({ id: job.id }));
      },
    },
    productionJobFile: {
      findMany: async ({ where, take }: any) => {
        calls.push("productionJobFile.findMany");
        const hits = files.filter((file) => file.shop === where.shop && file.fileType === where.fileType && file.assetSource === where.assetSource && file.fileName.startsWith(where.fileName.startsWith));
        return (take ? hits.slice(0, take) : hits).map((file) => ({ jobId: file.jobId, fileName: file.fileName }));
      },
    },
  };
}

const JOBS: Job[] = [
  { id: "job_a", shop: "shop-1", jobTicket: "GSO-20261118-0003" },
  { id: "job_b", shop: "shop-1", jobTicket: "GSO-20261118-0004" },
  { id: "job_x", shop: "other-shop", jobTicket: "GSO-20261118-0003" },
];
const ITEMS: Item[] = [
  { id: "item_a", shop: "shop-1", jobId: "job_a", itemTicket: "GSO-20261118-0003-01", ripJobName: "GSO-20261118-0003-01", suggestedFileName: null },
  { id: "item_b", shop: "shop-1", jobId: "job_b", itemTicket: "GSO-20261118-0004-01", ripJobName: "Flame Society Jar Front", suggestedFileName: null },
];
// what Patch E records after a real delivery (routed name with the original extension)
const FILES: File[] = [
  { shop: "shop-1", jobId: "job_a", fileType: "print_file", assetSource: "nas", fileName: "GSO-20261118-0003-01.pdf" },
  { shop: "shop-1", jobId: "job_b", fileType: "print_file", assetSource: "nas", fileName: "Flame_Society_Jar_Front__R2-A1.pdf" },
  { shop: "other-shop", jobId: "job_x", fileType: "print_file", assetSource: "nas", fileName: "Other Shop Routed Name.pdf" },
  { shop: "shop-1", jobId: "job_a", fileType: "artwork", assetSource: "manual", fileName: "customer upload.pdf" },
];

describe("1-3. deterministic matching, strongest identity first", () => {
  it("an item ticket in the routed name still matches job + item first (unchanged)", async () => {
    const calls: string[] = [];
    const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES, calls), "shop-1", { jobName: "GSO-20261118-0003-01.pdf" });
    expect(result).toMatchObject({ status: "matched", confidence: "exact_item_ticket", productionJobId: "job_a", productionJobItemId: "item_a" });
    expect(calls).not.toContain("productionJobFile.findMany"); // the new stage is never reached when a stronger identity answers
  });
  it("a routed name with no ticket and a run suffix matches the job through its recorded print file", async () => {
    for (const jobName of ["Flame_Society_Jar_Front__R2-A1.pdf", "Flame_Society_Jar_Front__R2-A1"]) {
      const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES), "shop-1", { jobName });
      expect(result, jobName).toMatchObject({ status: "matched", confidence: "exact_routed_print_file", matchMethod: "exact_routed_print_file", productionJobId: "job_b", productionJobItemId: null });
    }
  });
  it("an unknown result stays unmatched with a structured reason — never guessed", async () => {
    // a longer or shorter name that merely STARTS like a routed file is not that file
    for (const jobName of ["blue chip_pbb_w.pdf", "Flame Society Jar Back.pdf", "Flame_Society_Jar_Front__R2-A1 copy.pdf", "Flame_Society_Jar_Front__R2", "Flame_Society_Jar_Front__R2-A12.pdf", "customer upload.pdf"]) {
      const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES), "shop-1", { jobName });
      expect(result.status, jobName).toBe("unmatched");
      expect(result.productionJobId, jobName).toBeNull();
      expect(result.reasons, jobName).toContain("no_ticket_identity");
    }
  });
  it("only print_file / nas rows count: an artwork file name never matches a RIP result", async () => {
    const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES), "shop-1", { jobName: "customer upload.pdf" });
    expect(result.status).toBe("unmatched");
  });
});

describe("9. shop isolation and ambiguity", () => {
  it("another shop's routed file can never match", async () => {
    const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES), "shop-1", { jobName: "Other Shop Routed Name.pdf" });
    expect(result.status).toBe("unmatched");
    const own = await resolveRipIdentity(fakeDb(JOBS, ITEMS, FILES), "other-shop", { jobName: "Flame_Society_Jar_Front__R2-A1.pdf" });
    expect(own.status).toBe("unmatched");
  });
  it("the same routed name on two jobs is ambiguous — no first-match-wins", async () => {
    const twice = [...FILES, { shop: "shop-1", jobId: "job_a", fileType: "print_file", assetSource: "nas", fileName: "Flame_Society_Jar_Front__R2-A1.pdf" }];
    const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, twice), "shop-1", { jobName: "Flame_Society_Jar_Front__R2-A1.pdf" });
    expect(result.status).toBe("ambiguous");
    expect(result.productionJobId).toBeNull();
    expect([...result.candidateJobIds].sort()).toEqual(["job_a", "job_b"]);
  });
  it("several print files of ONE job with that name are still one job (multi-layer / re-recorded)", async () => {
    const sameJob = [...FILES, { shop: "shop-1", jobId: "job_b", fileType: "print_file", assetSource: "nas", fileName: "Flame_Society_Jar_Front__R2-A1.pdf" }];
    const result = await resolveRipIdentity(fakeDb(JOBS, ITEMS, sameJob), "shop-1", { jobName: "Flame_Society_Jar_Front__R2-A1.pdf" });
    expect(result).toMatchObject({ status: "matched", productionJobId: "job_b" });
  });
  it("a database client without the file model (older callers) simply skips the stage", async () => {
    const db: any = fakeDb(JOBS, ITEMS, FILES);
    delete db.productionJobFile;
    const result = await resolveRipIdentity(db, "shop-1", { jobName: "Flame_Society_Jar_Front__R2-A1.pdf" });
    expect(result.status).toBe("unmatched");
  });
});

describe("10-12. the result pipeline creates no job, no job file, and rewrites no cost", () => {
  it("the routed-print-file match is NOT trusted for actual-cost linkage or writeback", () => {
    expect(ACTUALS_TRUSTED_CONFIDENCE.has("exact_routed_print_file")).toBe(false);
    expect(matchMethodAllowsActuals("exact_routed_print_file")).toBe(false);
    for (const trusted of ["exact_item_ticket", "exact_rip_job_name", "exact_job_ticket", "exact_stored_filename"]) expect(ACTUALS_TRUSTED_CONFIDENCE.has(trusted), trusted).toBe(true); // unchanged
  });
  it("the upload endpoint only writes the import record and print-log rows", () => {
    const upload = src("app/routes/api.rip-imports.upload.tsx");
    expect(upload).not.toMatch(/productionJob\.(create|createMany|upsert|update|updateMany)\b/);
    expect(upload).not.toMatch(/productionJobItem\.(create|update|upsert|updateMany)\b/);
    expect(upload).not.toMatch(/productionJobFile\.(create|update|upsert)\b/);
    expect(upload).not.toMatch(/\b(unitCost|actualCost|actualCostFinalized)\s*:/);
    expect(upload).not.toContain("print-log-writeback");
    const writes = [...upload.matchAll(/db\.(\w+)\.(create|update|upsert|delete\w*|createMany|updateMany)\(/g)].map((match) => `${match[1]}.${match[2]}`);
    expect([...new Set(writes)].sort()).toEqual(["printLogAutoImportSetting.update", "printLogEntry.create", "printLogEntry.update", "printLogImport.create", "printLogImport.update"]);
    const matcher = src("app/lib/rip-identity-match.server.ts");
    expect(matcher).not.toMatch(/\.(create|update|upsert|delete\w*)\(/); // the matcher only reads
  });
  it("token protection on the upload endpoint is intact", () => {
    const upload = src("app/routes/api.rip-imports.upload.tsx");
    expect(upload).toContain('if (!token) return textResponse({ ok: false, error: "Missing upload token." }, 401);');
    expect(upload).toContain('if (!setting || !setting.enabled) return textResponse({ ok: false, error: "Invalid or disabled upload token." }, 403);');
  });
});

describe("4-8, 13. the real RasterLink result format: what the RIP reports is stored as reported", () => {
  // Shape copied from a real result file written by the installed RasterLink (2026-11-09); job name replaced.
  const REAL = [
    "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL",
    '"GSO-20261118-0003-01.pdf","OK","C:0.067cc M:0.070cc Y:0.014cc K:0.017cc W:0.036cc W:0.036cc Cl:0.000cc Cl:0.000cc ","20261109_092928","20261109_092931","20261109_093005","20261109_093640","40",',
  ].join("\r\n");
  const FILE_NAME = "20261109_093640_GSO-20261118-0003-01.pdf_1_OK_print.csv";

  it("is recognised; the job name, RIP time and print time are exactly what the RIP reported", () => {
    expect(looksLikeRasterlinkCsv(REAL)).toBe(true);
    const rows: any[] = parseRasterlinkRows(REAL, FILE_NAME);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.fileName).toBe("GSO-20261118-0003-01.pdf");
    expect(row.jobTicket).toBe("GSO-20261118-0003-01");
    expect((new Date(row.ripCompletedAt).getTime() - new Date(row.ripStartedAt).getTime()) / 1000).toBe(3); // RIP 09:29:28 -> 09:29:31
    expect((new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime()) / 1000).toBe(395); // print 09:30:05 -> 09:36:40
    expect(row.printMinutes).toBeCloseTo(395 / 60, 6);
  });
  it("ink is the RIP's own per-item figure times the arranged count, labelled an estimate — never invented", () => {
    const row: any = parseRasterlinkRows(REAL, FILE_NAME)[0];
    expect(row.raw.arrangeCnt).toBe(40);
    expect(row.raw.arrangeAssumed).toBe(false);
    expect(row.cmykInkMl).toBeCloseTo((0.067 + 0.07 + 0.014 + 0.017) * 40, 6);
    expect(row.whiteInkMl).toBeCloseTo((0.036 + 0.036) * 40, 6);
    expect(row.glossInkMl).toBe(0);
    expect(row.raw.inkBasis).toBe("rasterlink_rounded_per_item_estimate");
  });
  it("a missing field stays unknown: no print window on a failed job, a flagged assumption when the arranged count is absent, a missing-ink basis when KEY_INKUSE is absent", () => {
    const failed: any = parseRasterlinkRows(REAL.replace('"OK"', '"NG"').replace('"20261109_093005","20261109_093640"', ","), FILE_NAME.replace("_OK_", "_NG_"))[0];
    expect(failed.startedAt ?? null).toBeNull();
    expect(failed.completedAt ?? null).toBeNull();
    const noCount: any = parseRasterlinkRows(REAL.replace('"40",', ","), FILE_NAME)[0];
    expect(noCount.raw.arrangeCnt).toBeNull();
    expect(noCount.raw.arrangeAssumed).toBe(true); // the per-item figure is kept and FLAGGED, not silently multiplied
    const noInk: any = parseRasterlinkRows(REAL.replace(/"C:0\.067cc[^"]*"/, ""), FILE_NAME)[0];
    expect(noInk.raw.inkBasis).toBe("missing_inkuse");
  });
  it("the same result seen again de-duplicates: same file hash is refused, same row resolves to the same key", () => {
    const first: any = parseRasterlinkRows(REAL, FILE_NAME)[0];
    const again: any = parseRasterlinkRows(REAL, FILE_NAME)[0];
    expect(JSON.stringify(rowDedupeWhere("shop-1", first, "import_1"))).toBe(JSON.stringify(rowDedupeWhere("shop-1", again, "import_1")));
    const upload = src("app/routes/api.rip-imports.upload.tsx");
    expect(upload).toContain("duplicateFile: true");
    expect(upload).toContain("const existing = await db.printLogEntry.findFirst({ where: rowDedupeWhere(setting.shop, entry, importRecord.id) as any });");
  });
});

describe("15-16. the historical backlog cannot be swept up by the sync", () => {
  const sync = src("tools/gso-rasterlink-sync.ps1");
  it("the sync reads only files directly inside its incoming folder — never subfolders", () => {
    // 2026-11-18: cut results are now uploaded before print results (same direct-children-only scan).
    expect(sync).toContain("$files = Get-ResultUploadOrder @(Get-ChildItem -Path $config.IncomingFolder -Filter *.csv -File -ErrorAction SilentlyContinue)");
    const scanLines = sync.split("\n").filter((line) => line.includes("Get-ChildItem") && line.includes("IncomingFolder"));
    expect(scanLines.length).toBe(2);
    for (const line of scanLines) expect(line).not.toContain("-Recurse");
  });
  it("its dry run uploads and moves nothing", () => {
    expect(sync).toContain("#   -DryRun     detect + report only; no uploads, no moves");
  });
});
