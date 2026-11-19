// Patch F (2026-11-18): Mimaki clear / gloss actuals from RasterLink JobInfo.ini.
// Owner-verified in RasterLink Properties: the UCJV300 reports clear on TWO
// slots (JobInfo codes 136 and 137) and BOTH are real consumption — summed.
// Fixtures are the real lines from the shop's own job folders (2026-11-18).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  INK_BASIS_JOBINFO_JOB_FOLDER,
  JOBINFO_CLEAR_SLOT_CODES,
  arrangeCountFromCutRows,
  buildJobFolderEnrichment,
  decideJobInfoPairing,
  jobFolderEligibility,
  pairedCutResultFileName,
  parseInkUsedLine,
  parseJobInfoIni,
  type PairingCandidateRow,
} from "../app/lib/jobinfo-fallback.server";
import { CANONICAL_INK_RATES, channelInkRatePerMl } from "../app/lib/ink-rates-shared";
import { parseRasterlinkRows, rowDedupeWhere } from "../app/lib/rasterlink-parse.server";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

// --- real job folders ------------------------------------------------------
const ini = (jobId: string, jobName: string, ripStart: string, ripEnd: string, inkUsed: string, primary = jobId) =>
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

const F_CMYK = ini("S01_20261117175201050", "crud_shortcakes_F_cmyk.pdf", "20261118_095815", "20261118_095824", "1;4,2;70,3;99,4;7,131;0,133;0,136;0,137;0", "S01_20261117175118982");
const F_GLOSS = ini("S01_20261117175118550", "crud_shortcakes_F_g.pdf", "20261118_095819", "20261118_095824", "1;0,2;0,3;0,4;0,131;0,133;0,136;152,137;152", "S01_20261117175118982");
const B_CMYK = ini("S01_20261117175222598", "crud_shortcakes_b_cmyk.pdf", "20261118_095827", "20261118_095832", "1;8,2;46,3;64,4;24,131;0,133;0,136;0,137;0", "S01_20261117175120250");
const B_GLOSS = ini("S01_20261117175423829", "crud_all_b_g.pdf", "20261118_095829", "20261118_095832", "1;0,2;0,3;0,4;0,131;0,133;0,136;200,137;200", "S01_20261117175120250");

// --- the real composite result CSV (blank ink, arranged count 0) -------------
const PRINT_CSV_NAME = "20261118_153948_crud_shortcakes_F_cmyk.pdf_1_OK_print.csv";
const PRINT_CSV = [
  "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL",
  '"crud_shortcakes_F_cmyk.pdf","OK",,"20261118_095815","20261118_095824",,,"0",',
  '"crud_shortcakes_F_g.pdf","OK",,"20261118_095819","20261118_095824",,,"0",',
  "",
].join("\r\n");
const CUT_CSV_NAME = "20261118_153948_crud_shortcakes_F_cmyk.pdf_1_OK_cut.csv";
const CUT_CSV = [
  "KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL",
  '"crud_shortcakes_F_cmyk.pdf","OK","20261118_095821","20261118_095824","20261118_141418","20261118_144037","65",',
  "",
].join("\r\n");

const entries = parseRasterlinkRows(PRINT_CSV, PRINT_CSV_NAME);
const rowOf = (index: number, id: string): PairingCandidateRow => {
  const entry = entries[index];
  return {
    id,
    sourceJobName: entry.fileName,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    ripStartedAt: entry.ripStartedAt,
    ripCompletedAt: entry.ripCompletedAt,
    status: entry.status,
    rawRow: JSON.stringify(entry.raw),
  };
};
const cmykRow = rowOf(0, "row_cmyk");
const glossRow = rowOf(1, "row_gloss");
const rows = [cmykRow, glossRow];
const cutArrange = arrangeCountFromCutRows(parseRasterlinkRows(CUT_CSV, CUT_CSV_NAME).map((entry) => entry.raw.arrangeCnt));

describe("clear / gloss channel mapping (tests 1-4, 6, 7)", () => {
  it("1 + 2. codes 136 and 137 are the two clear slots", () => {
    expect([...JOBINFO_CLEAR_SLOT_CODES]).toEqual([136, 137]);
    const ink = parseInkUsedLine("inkUsed=1;0,2;0,3;0,4;0,131;0,133;0,136;152,137;152");
    expect(ink.clearSlot1Cc).toBeCloseTo(0.152, 9);
    expect(ink.clearSlot2Cc).toBeCloseTo(0.152, 9);
    expect(parseInkUsedLine("inkUsed=136;200").clearSlot1Cc).toBeCloseTo(0.2, 9);
    expect(parseInkUsedLine("inkUsed=136;200").clearSlot2Cc).toBe(0);
    expect(parseInkUsedLine("inkUsed=137;200").clearSlot2Cc).toBeCloseTo(0.2, 9);
    expect(parseInkUsedLine("inkUsed=137;200").present).toBe(true);
  });

  it("3. both clear values are summed", () => {
    expect(parseInkUsedLine("inkUsed=136;152,137;152").clearCc).toBeCloseTo(0.304, 9);
    expect(parseInkUsedLine("inkUsed=136;200,137;200").clearCc).toBeCloseTo(0.4, 9);
    expect(parseInkUsedLine("inkUsed=136;120,137;80").clearCc).toBeCloseTo(0.2, 9); // a sum, not "double one slot"
  });

  it("4. the summed rule reproduces RasterLink's displayed totals (owner screenshots), and JobInfo agrees with RasterLink's two Clear rows", () => {
    // RasterLink Properties: CMYK + Clear + Clear = displayed Total (within its own rounding).
    const shown = [
      { cmyk: [0.763, 3.136, 4.359, 1.642], clear: [13.063, 13.063], total: 36.025, perItemSlot: 0.2 },
      { cmyk: [0.335, 4.74, 6.567, 0.637], clear: [9.991, 9.991], total: 32.261, perItemSlot: 0.152 },
    ];
    for (const job of shown) {
      const sum = job.cmyk.reduce((a, b) => a + b, 0) + job.clear[0] + job.clear[1];
      expect(Math.abs(sum - job.total)).toBeLessThanOrEqual(0.0015);
      // Counting ONE clear slot can never reach the displayed total.
      expect(job.cmyk.reduce((a, b) => a + b, 0) + job.clear[0]).toBeLessThan(job.total - 5);
      // JobInfo slot value x 65 arranged copies lands on RasterLink's per-slot Clear figure
      // (JobInfo is rounded per item, so within 2%, never exact).
      expect(Math.abs(job.perItemSlot * 65 - job.clear[0]) / job.clear[0]).toBeLessThan(0.02);
    }
    // The two real gloss job folders carry IDENTICAL values on 136 and 137 — the two identical Clear rows.
    for (const text of [F_GLOSS, B_GLOSS]) {
      const ink = parseJobInfoIni(text, "x").ink;
      expect(ink.clearSlot1Cc).toBe(ink.clearSlot2Cc);
      expect(ink.clearSlot1Cc).toBeGreaterThan(0);
      expect(ink.perItemKnownCc).toBe(0); // a gloss layer carries no CMYK
    }
  });

  it("6 + 7. primer, white and every other unvalidated code are never counted as clear (or as anything)", () => {
    const ink = parseInkUsedLine("inkUsed=1;10,131;500,133;400,136;152,137;152,140;900,15;70,24;60");
    expect(ink.clearCc).toBeCloseTo(0.304, 9);
    expect(ink.perItemKnownCc).toBeCloseTo(0.01, 9);
    expect(ink.unknownChannels.map((channel) => channel.code)).toEqual([131, 133, 140, 15, 24]);
    expect(ink.warnings).toEqual(expect.arrayContaining(["unknown_channel:131", "unknown_channel:133", "unknown_channel:140"]));
    const row = { ...glossRow };
    const record = parseJobInfoIni(F_GLOSS.replace("131;0,133;0", "131;500,133;400"), "S01_20261117175118550");
    const result = buildJobFolderEnrichment(row, record, { cutArrangeCnt: 65 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.whiteInkMl).toBe(0); // white codes are not validated: never guessed
    expect(result.update.glossInkMl).toBeCloseTo(0.304 * 65, 9);
    expect(result.update.inkMl).toBeCloseTo(0.304 * 65, 9); // the unknown 131 / 133 values are in no total
    const provenance = JSON.parse(result.update.rawRow).jobInfoFallback;
    expect(provenance.warnings).toContain("unknown_channels_excluded_from_totals");
    expect(provenance.unknownChannels).toEqual([{ code: 131, raw: 500, cc: 0.5 }, { code: 133, raw: 400, cc: 0.4 }]);
    expect(read("app/lib/jobinfo-fallback.server.ts")).not.toMatch(/code === 13[13]/); // 131 / 133 are mapped to nothing
  });
});

describe("clear cost (test 5)", () => {
  it("5. clear cost = (slot 1 + slot 2) x $0.09 per mL, landed, on its own channel", () => {
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBeCloseTo(0.09, 12);
    const result = buildJobFolderEnrichment(glossRow, parseJobInfoIni(F_GLOSS, "S01_20261117175118550"), { cutArrangeCnt: cutArrange });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clearMl = result.update.glossInkMl;
    expect(clearMl).toBeCloseTo((0.152 + 0.152) * 65, 9); // 19.76 mL
    const rate = channelInkRatePerMl("mimaki", "gloss")!;
    expect(clearMl * rate).toBeCloseTo(19.76 * 0.09, 9); // $1.7784 — no freight added, not the CMYK rate
    expect(rate).not.toBe(channelInkRatePerMl("mimaki", "cmyk"));
  });
});

describe("composite result CSV + exact JobInfo linkage (tests 8, 9)", () => {
  it("the real composite result parses as two blank-ink print rows with a complete RIP window and no arranged count", () => {
    expect(entries.map((entry) => [entry.fileName, entry.inkMl, entry.raw.arrangeCnt, entry.raw.inkBasis])).toEqual([
      ["crud_shortcakes_F_cmyk.pdf", 0, null, "missing_inkuse"],
      ["crud_shortcakes_F_g.pdf", 0, null, "missing_inkuse"],
    ]);
    expect(jobFolderEligibility(cmykRow)).toEqual({ eligible: true, reason: null });
    expect(cutArrange).toBe(65);
    expect(pairedCutResultFileName(PRINT_CSV_NAME)).toBe(CUT_CSV_NAME);
    expect(pairedCutResultFileName("something.csv")).toBe("");
  });

  it("8. a composite row with blank ink is enriched from its exact JobInfo.ini: CMYK row gets CMYK, gloss row gets both clear slots", () => {
    const cmykRecord = parseJobInfoIni(F_CMYK, "S01_20261117175201050");
    expect(cmykRecord.rasterlinkJob).toEqual({ jobId: "S01_20261117175201050", fileName: "crud_shortcakes_F_cmyk.pdf", ripStartStamp: "20261118_095815", ripEndStamp: "20261118_095824" });
    const cmykPairing = decideJobInfoPairing(cmykRecord, rows);
    expect(cmykPairing.outcome).toBe("paired");
    expect(cmykPairing.row?.id).toBe("row_cmyk");
    const cmyk = buildJobFolderEnrichment(cmykPairing.row!, cmykRecord, { cutArrangeCnt: cutArrange, at: new Date("2026-11-18T23:00:00Z") });
    expect(cmyk.ok).toBe(true);
    if (!cmyk.ok) return;
    expect(cmyk.update.cmykInkMl).toBeCloseTo(0.18 * 65, 9); // 11.70
    expect(cmyk.update.glossInkMl).toBe(0);
    expect(cmyk.update.whiteInkMl).toBe(0);
    expect(cmyk.inkBasis).toBe(INK_BASIS_JOBINFO_JOB_FOLDER);

    const glossRecord = parseJobInfoIni(F_GLOSS, "S01_20261117175118550");
    const glossPairing = decideJobInfoPairing(glossRecord, rows);
    expect(glossPairing.row?.id).toBe("row_gloss");
    const gloss = buildJobFolderEnrichment(glossPairing.row!, glossRecord, { cutArrangeCnt: cutArrange });
    expect(gloss.ok).toBe(true);
    if (!gloss.ok) return;
    expect(gloss.update.cmykInkMl).toBe(0);
    expect(gloss.update.glossInkMl).toBeCloseTo(19.76, 9);
    const provenance = JSON.parse(gloss.update.rawRow).jobInfoFallback;
    expect(provenance.clearSlot1TotalCc).toBeCloseTo(9.88, 9);
    expect(provenance.clearSlot2TotalCc).toBeCloseTo(9.88, 9);
    expect(provenance.clearTotalCc).toBeCloseTo(19.76, 9);
    expect(provenance.arrangeCnt).toBe(65);
    expect(provenance.arrangeSource).toBe("paired_cut_result");
    expect(provenance.linkage).toBe("exact_job_id_file_name_rip_window");
    expect(provenance.estimate).toBe(true); // rounded per item: never presented as RasterLink's exact metered total
    // The result CSV keeps its identity: name, status and RIP stamps are untouched.
    const raw = JSON.parse(gloss.update.rawRow);
    expect(raw.ripStart).toBe(JSON.parse(glossRow.rawRow!).ripStart);
    expect(raw.result).toBe("OK");
  });

  it("without a known arranged count nothing is written (a per-item figure is never stored as a job total)", () => {
    const record = parseJobInfoIni(F_GLOSS, "S01_20261117175118550");
    expect(buildJobFolderEnrichment(glossRow, record, {})).toEqual({ ok: false, reason: "arrange_count_unknown" });
    expect(buildJobFolderEnrichment(glossRow, record, { cutArrangeCnt: 0 })).toEqual({ ok: false, reason: "arrange_count_unknown" });
    expect(arrangeCountFromCutRows([65, 65])).toBe(65);
    expect(arrangeCountFromCutRows([65, 40])).toBeNull(); // disagreeing cut rows: no count
    expect(arrangeCountFromCutRows([null, "65", 0])).toBeNull();
  });

  it("9. a wrong JobInfo directory cannot attach", () => {
    const paired = (text: string, folder: string) => decideJobInfoPairing(parseJobInfoIni(text, folder), rows).outcome;
    // another job's folder (different file, different RIP window)
    expect(paired(B_CMYK, "S01_20261117175222598")).toBe("no_candidates");
    expect(paired(B_GLOSS, "S01_20261117175423829")).toBe("no_candidates");
    // same file name, RIPped at another time (a re-run of the same artwork)
    expect(paired(F_CMYK.replace(/20261118_0958/g, "20261117_0958"), "S01_20261117175201050")).toBe("no_candidates");
    // same file name and start, different end
    expect(paired(F_CMYK.replace("20261118_095824", "20261118_095825"), "S01_20261117175201050")).toBe("no_candidates");
    // right content uploaded under a folder name that is not its JobID
    expect(paired(F_CMYK, "S01_20261117175118550")).toBe("no_candidates");
    expect(paired(F_CMYK, "crud_shortcakes_F_cmyk")).toBe("no_candidates");
    // a similar file name is not the file
    expect(paired(F_CMYK.replace("crud_shortcakes_F_cmyk.pdf", "crud_shortcakes_F_cmyk_v2.pdf"), "S01_20261117175201050")).toBe("no_candidates");
    expect(paired(F_CMYK.replace("crud_shortcakes_F_cmyk.pdf", "CRUD_shortcakes_F_cmyk.pdf"), "S01_20261117175201050")).toBe("no_candidates");
    // the composite's PRIMARY folder: same file name, but no RIP window of its own and no ink
    const primary = ["[Job]", 'JobID="S01_20261117175118982"', 'jobName="crud_shortcakes_F_cmyk.pdf"', 'resultLogResult="S01_20261117175118982";"KEY_VEC_E_TIME";"20261118_095824","S01_20261117175118982";"KEY_VEC_S_TIME";"20261118_095821"', "inkUsed="].join("\n");
    expect(paired(primary, "S01_20261117175118982")).toBe("no_candidates");
    // stamps that belong to a DIFFERENT JobID inside the file are not this job's identity
    expect(paired(F_CMYK.replace(/"S01_20261117175201050";"KEY_RIP/g, '"S01_OTHER";"KEY_RIP'), "S01_20261117175201050")).toBe("no_candidates");
    // a job-folder file never falls back to the old name pairing
    const nameAlike = [{ ...cmykRow, sourceJobName: "S01_20261117175201050.pdf", startedAt: "2026-11-18T10:00:00Z" }];
    expect(decideJobInfoPairing(parseJobInfoIni(F_CMYK, "S01_20261117175201050"), nameAlike).outcome).toBe("no_candidates");
    // two rows with the same exact identity: ambiguous, nothing written
    expect(decideJobInfoPairing(parseJobInfoIni(F_CMYK, "S01_20261117175201050"), [cmykRow, { ...cmykRow, id: "dup" }]).outcome).toBe("ambiguous");
  });

  it("rows that already carry CSV ink, cut rows and rows without a full RIP window are refused", () => {
    const withInk = { ...cmykRow, rawRow: JSON.stringify({ ...JSON.parse(cmykRow.rawRow!), inkBasis: "rasterlink_rounded_per_item_estimate" }) };
    expect(jobFolderEligibility(withInk).reason).toBe("csv_ink_present_never_overridden");
    expect(jobFolderEligibility({ ...cmykRow, status: "cut:OK" }).reason).toBe("not_a_print_row");
    expect(jobFolderEligibility({ ...cmykRow, ripCompletedAt: null }).reason).toBe("no_complete_rip_window");
  });
});

describe("idempotency and scope (tests 10, 11, 12)", () => {
  it("10. a replayed result stays one row, and a replayed JobInfo.ini writes nothing", () => {
    // The dedupe key of a composite print row is its RIP window: ink is not part of it,
    // so the enriched row is still found when the same result CSV is sent again.
    const where = rowDedupeWhere("shop", entries[1], "import_2");
    expect(where).not.toHaveProperty("inkMl");
    expect(where).not.toHaveProperty("importId");
    expect(where.ripStartedAt).toEqual(entries[1].ripStartedAt);
    expect(where.ripCompletedAt).toEqual(entries[1].ripCompletedAt);
    const record = parseJobInfoIni(F_GLOSS, "S01_20261117175118550");
    const first = buildJobFolderEnrichment(glossRow, record, { cutArrangeCnt: 65 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const enriched = { ...glossRow, rawRow: first.update.rawRow };
    expect(buildJobFolderEnrichment(enriched, record, { cutArrangeCnt: 65 })).toEqual({ ok: false, reason: "already_enriched" });
    const again = decideJobInfoPairing(record, [cmykRow, enriched]);
    expect(again.outcome).toBe("no_candidates");
    expect(again.ineligible).toEqual([{ rowId: "row_gloss", reason: "already_enriched" }]);
  });

  it("11. the only write is the ink columns + provenance of one print-log row: no job, cost, quote or price", () => {
    const result = buildJobFolderEnrichment(glossRow, parseJobInfoIni(F_GLOSS, "S01_20261117175118550"), { cutArrangeCnt: 65 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.update).sort()).toEqual(["cmykInkMl", "glossInkMl", "inkMl", "rawRow", "whiteInkMl"]);
    const route = read("app/routes/api.rip-imports.upload.tsx");
    const start = route.indexOf("if (jobFolderRecord.rasterlinkJob) {");
    const end = route.indexOf("if (!jobInfoFallbackEnabled()) {");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const branch = route.slice(start, end);
    const writes = branch.match(/db\.\w+\.(create|update|upsert|delete|updateMany|deleteMany|createMany)\(/g) || [];
    expect(writes).toEqual(["db.printLogEntry.update("]);
    expect(branch).toContain("data: enrichment.update");
    expect(branch).not.toMatch(/productionJob|quote|actualCost|price/i);
    // The older, never-validated name pairing is still behind its flag.
    expect(route.slice(end, end + 400)).toContain("JobInfo fallback is disabled");
  });

  it("12. the result sync reads only the printer subfolder: the historical backlog stays excluded", () => {
    const script = read("tools/gso-rasterlink-sync.ps1");
    expect(script).not.toMatch(/Get-ChildItem[^\n]*IncomingFolder[^\n]*-Recurse/);
    expect(script).toContain("Get-ChildItem -Path $config.IncomingFolder -Filter *.csv -File");
    // v1.3: a go-live cutoff — older result files are never uploaded or moved; an unreadable cutoff keeps nothing.
    expect(script).toContain("$files = @(Select-FilesAfterCutoff $files $config.NotBeforeUtc | ForEach-Object { $_ })");
    expect(script).toContain("if ($f.LastWriteTimeUtc -ge $cutoff) { [void]$kept.Add($f) }");
    expect(script).toContain("Refusing to run");
    const config = JSON.parse(read("tools/gso-rasterlink-sync-config.example.json"));
    expect(config.IncomingFolder).toBe("\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming\\UCJV-300");
    expect(config.IncomingFolder).not.toMatch(/incoming\\GSOP/);
    expect(config.JobsFolder).toBe("C:\\MijCtrl\\Jobs\\1");
    // JobInfo.ini is read, never written or moved.
    const companion = script.slice(script.indexOf("# ---------- JobInfo.ini companion"), script.indexOf("# ---------- moves + sidecars"));
    expect(companion).not.toMatch(/Set-Content|Add-Content|Move-Item|Remove-Item|Out-File|WriteAll/);
  });
});
