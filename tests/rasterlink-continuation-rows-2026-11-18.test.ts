// Patch F (2026-11-18) — RasterLink result files hold RECORDS, not one job per
// line. A job's result spans two physical rows (the job row, then a
// continuation row with the arranged count and sometimes a result / detail),
// records are separated by blank lines, and files may contain empty records.
//
// Before this fix the continuation row was read as a separate job: ink stayed
// at the per-item figure (under-reported by the arranged count) and an empty
// "print:unknown" row was created. Every fixture below is the layout of a real
// file from the shop's RasterLink (job names kept as written by staff).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INK_BASIS_ESTIMATE,
  INK_BASIS_MISSING,
  fileHashMarker,
  parseRasterlinkRows,
  parseWarningCount,
  readRasterlinkStructure,
  rowDedupeWhere,
} from "../app/lib/rasterlink-parse.server";
import { resolveRipIdentity } from "../app/lib/rip-identity-match.server";

const HEADER = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\r\n") + "\r\n";
const INK = '"C:0.028cc M:0.061cc Y:0.093cc K:0.003cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc "';
const PER_ITEM = 0.028 + 0.061 + 0.093 + 0.003;
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const parse = (text: string, name = "20260822_091726_1_OK_print.csv") => parseRasterlinkRows(text, name) as any[];

describe("1, 8-9. a normal one-row result is read exactly as before", () => {
  // real layout "Dai": count on the job row, with a print window
  const ONE_ROW = csv('"banner 1 cheeezezze.pdf","NG","C:17.715cc M:10.891cc Y:43.907cc K:3.422cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20261016_150430","20261016_150509","20261016_153427","20261016_153632","1","ERROR_PRINT"');
  it("count = 1 on the job row: one row, ink x 1, times and detail intact", () => {
    const rows = parse(ONE_ROW, "20261016_153633_banner 1 cheeezezze.pdf_1_NG_print.csv");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "print", fileName: "banner 1 cheeezezze.pdf", status: "print:NG" });
    expect(rows[0].cmykInkMl).toBeCloseTo(17.715 + 10.891 + 43.907 + 3.422, 6);
    expect(rows[0].raw).toMatchObject({ arrangeCnt: 1, arrangeAssumed: false, arrangeSource: "job_row", resultDetail: "ERROR_PRINT", inkBasis: INK_BASIS_ESTIMATE });
    expect(rows[0].printMinutes).toBeCloseTo((2 * 60 + 5) / 60, 6); // 15:34:27 -> 15:36:32
  });
  it("count > 1 on the job row multiplies, as it always did", () => {
    const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353","20260822_091400","20260822_092400","40",`));
    expect(rows).toHaveLength(1);
    expect(rows[0].cmykInkMl).toBeCloseTo(PER_ITEM * 40, 6);
    expect(rows[0].raw.arrangeSource).toBe("job_row");
  });
  it("a RIP-only result with count 0 and no ink (real layout 'Da') is unchanged: one row, ink missing, no assumption invented", () => {
    const rows = parse(csv('"kk_skittles up_f_.pdf","OK",,"20260822_093006","20260822_093011",,,"0",'), "20260822_093445_kk_skittles up_f_.pdf_1_OK_print.csv");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inkMl: 0, cmykInkMl: 0 });
    expect(rows[0].raw).toMatchObject({ inkBasis: INK_BASIS_MISSING, arrangeCnt: null, timingBasis: "rip_only_no_print_times" });
  });
});

describe("2-6. the continuation row belongs to the job row directly above it", () => {
  // real layout "Di C" (393 of 1,221 surveyed files)
  const CONTINUATION = csv(`"kk_skittles up_f_.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"130",');
  it("one job, one row — no empty phantom row", () => {
    const rows = parse(CONTINUATION);
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => !row.fileName)).toEqual([]);
    expect(rows[0].fileName).toBe("kk_skittles up_f_.pdf");
    expect(readRasterlinkStructure(CONTINUATION)).toMatchObject({ jobRows: 1, continuationsMerged: 1, orphanRowsDropped: 0, emptyRecords: 0 });
  });
  it("total ink = the RIP's per-item figure x the arranged count from the continuation row", () => {
    const row = parse(CONTINUATION)[0];
    expect(row.raw.arrangeCnt).toBe(130);
    expect(row.raw.arrangeAssumed).toBe(false);
    expect(row.raw.arrangeSource).toBe("continuation_row");
    expect(row.raw.perItem.totalCc).toBeCloseTo(PER_ITEM, 9); // the reported per-item figure is preserved untouched
    expect(row.cmykInkMl).toBeCloseTo(PER_ITEM * 130, 6);
    expect(row.inkMl).toBeCloseTo(PER_ITEM * 130, 6);
    expect(row.raw.inkBasis).toBe(INK_BASIS_ESTIMATE); // still labelled an estimate, never "measured"
  });
  it("RIP time is unchanged and correct; a RIP-only result still has no print time", () => {
    const row = parse(CONTINUATION)[0];
    expect((row.ripCompletedAt.getTime() - row.ripStartedAt.getTime()) / 1000).toBe(5); // 09:13:48 -> 09:13:53
    expect(row.raw.ripMinutes).toBeCloseTo(5 / 60, 9);
    expect(row.startedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.printMinutes).toBe(0);
  });
  it("print time is unchanged and correct when the job row carries a print window", () => {
    const row = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353","20260822_091400","20260822_092400",,`, ',,,,,,,"12",'))[0];
    expect(row.printMinutes).toBeCloseTo(10, 6);
    expect(row.cmykInkMl).toBeCloseTo(PER_ITEM * 12, 6);
  });
  it("7. every ink channel is multiplied by the same count — CMYK, both white slots, both clear slots", () => {
    const row = parse(csv('"blue chip_abuelitas cookies_w.pdf","OK","C:0.010cc M:0.020cc Y:0.030cc K:0.040cc W:0.029cc W:0.029cc Cl:0.005cc Cl:0.006cc ","20261002_143530","20261002_143531",,,,', ',,,,,,,"250",'))[0];
    expect(row.cmykInkMl).toBeCloseTo(0.1 * 250, 6);
    expect(row.whiteInkMl).toBeCloseTo(0.058 * 250, 6);
    expect(row.glossInkMl).toBeCloseTo(0.011 * 250, 6);
    expect(row.inkMl).toBeCloseTo((0.1 + 0.058 + 0.011) * 250, 6);
  });
  it("a continuation carrying a cut result (real layout 'Di X') gives the count and the detail to its job", () => {
    const rows = parse(csv('"KC_MOTIONSICKNESS_wrap.pdf","NG","C:0.014cc M:0.020cc Y:0.058cc K:0.001cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20260930_155848","20260930_160422",,,,', ',"NG",,,,,,"1","ERROR_CUT"'), "20261001_094410_1_NG_print.csv");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("print:NG");
    expect(rows[0].raw).toMatchObject({ arrangeCnt: 1, arrangeSource: "continuation_row", resultDetail: "ERROR_CUT", continuationResult: "NG" });
    expect(rows[0].cmykInkMl).toBeCloseTo(0.093, 6); // count 1: total = per item
  });
  it("a job row with no ink + continuation count (real layout 'D C') becomes one row with ink still MISSING, never zero-faked into an estimate", () => {
    const rows = parse(csv('"staydown_pop rockz_f.pdf","OK",,"20260824_102704","20260824_102707",,,,', ',,,,,,,"130",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toMatchObject({ inkBasis: INK_BASIS_MISSING, arrangeCnt: 130 });
    expect(rows[0].inkMl).toBe(0);
  });
});

describe("4. empty records and orphan count rows never become results and are never attached by guesswork", () => {
  it("real layout 'Di C _ E C': the job keeps its own count; the empty record is dropped", () => {
    const text = csv('"bc exotics_oreo straw_b.pdf","OK","C:0.016cc M:0.033cc Y:0.030cc K:0.017cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20260601_163310","20260601_163317",,,,', ',,,,,,,"65",', "", ",,,,,,,,", ',,,,,,,"65",');
    const rows = parse(text, "20260601_171103_1_OK_print.csv");
    expect(rows).toHaveLength(1);
    expect(rows[0].cmykInkMl).toBeCloseTo(0.096 * 65, 6);
    expect(readRasterlinkStructure(text)).toMatchObject({ jobRows: 1, continuationsMerged: 1, orphanRowsDropped: 1, emptyRecords: 1 });
  });
  it("real layout 'E C _ Di C': an empty record BEFORE the job does not leak its count", () => {
    const rows = parse(csv(",,,,,,,,", ',,,,,,,"40",', "", '"POUND FILES-Recovered_0011_Layer 19.pdf","OK","C:0.187cc M:0.067cc Y:0.047cc K:0.099cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc ","20260824_213125","20260824_213129",,,,', ',,,,,,,"7",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw.arrangeCnt).toBe(7); // its OWN continuation, not the 40 above
    expect(rows[0].cmykInkMl).toBeCloseTo(0.4 * 7, 6);
  });
  it("real layout 'Di E C': a count separated from the job by an all-empty row is NOT proven to be the job's — ink stays per-item and is flagged", () => {
    const rows = parse(csv('"blue chip_abuelitas cookies_w.pdf","OK","C:0.000cc M:0.000cc Y:0.000cc K:0.000cc W:0.029cc W:0.029cc Cl:0.000cc Cl:0.000cc ","20261002_143530","20261002_143531",,,,', ",,,,,,,,", ',,,,,,,"250",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toMatchObject({ arrangeCnt: null, arrangeAssumed: true, arrangeSource: null });
    expect(rows[0].whiteInkMl).toBeCloseTo(0.058, 6); // NOT x 250
    expect(parseWarningCount(rows)).toBe(1); // the caveat stays visible
  });
  it("a count separated by a blank line is not attached either", () => {
    const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, "", "", ',,,,,,,"99",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw.arrangeAssumed).toBe(true);
    expect(rows[0].cmykInkMl).toBeCloseTo(PER_ITEM, 6);
  });
  it("a job has ONE continuation: a second count row under it is dropped, not applied", () => {
    const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"10",', ',,,,,,,"999",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw.arrangeCnt).toBe(10);
  });
  it("a count already on the job row is never overwritten by a continuation", () => {
    const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,"3",`, ',,,,,,,"500",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toMatchObject({ arrangeCnt: 3, arrangeSource: "job_row" });
  });
  it("several jobs in one file (real layouts 'Da _ _ Da', 'Da Da') stay several rows, each with its own values", () => {
    const spaced = parse(csv('"POUND FILES-Recovered_0002_Layer 30.pdf","OK",,"20260825_095734","20260825_095746",,,"0",', "", "", '"POUND FILES-Recovered_0003_Layer 29.pdf","OK",,"20260825_095741","20260825_095746",,,"0",'));
    expect(spaced.map((row) => row.fileName)).toEqual(["POUND FILES-Recovered_0002_Layer 30.pdf", "POUND FILES-Recovered_0003_Layer 29.pdf"]);
    const adjacent = parse(csv(`"blue chip_pbb_w.pdf","OK",${INK},"20261002_144145","20261002_144150",,,,`, `"blue chip_pbb_cmyk.pdf","OK",${INK},"20261002_144146","20261002_144150",,,,`, ',,,,,,,"20",'));
    expect(adjacent).toHaveLength(2);
    expect(adjacent[0].raw.arrangeAssumed).toBe(true); // the count sits under the SECOND job only
    expect(adjacent[1].raw.arrangeCnt).toBe(20);
  });
});

describe("10. a malformed continuation row is handled safely", () => {
  it("a non-numeric, zero or negative count leaves the ink at the flagged per-item figure", () => {
    for (const bad of ['"abc"', '"0"', '"-5"', '""']) {
      const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, `,,,,,,,${bad},`));
      expect(rows, bad).toHaveLength(1);
      expect(rows[0].raw.arrangeAssumed, bad).toBe(true);
      expect(rows[0].cmykInkMl, bad).toBeCloseTo(PER_ITEM, 6);
    }
  });
  it("a short row, a row with extra cells, and a file that ends without a newline do not throw or invent rows", () => {
    expect(parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353"`, ',,,,,,,"5"')).length).toBe(1);
    expect(parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,,,,`, ',,,,,,,"5",,,,')).length).toBe(1);
    const noNewline = [HEADER, `"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"5",'].join("\n");
    expect(parse(noNewline)[0].raw.arrangeCnt).toBe(5);
    expect(parse(HEADER)).toEqual([]);
    expect(parse("")).toEqual([]);
  });
  it("a nameless row that carries ink or timestamps is left to the legacy path (not silently merged)", () => {
    const rows = parse(csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, `,"OK",${INK},"20260822_091400","20260822_091410",,,"4",`));
    expect(rows).toHaveLength(2);
    expect(rows[0].raw.arrangeAssumed).toBe(true); // its count row never came
    expect(rows[1].fileName).toBe("");
  });
  it("cut-result files are untouched: a cut row keeps its window and no print row appears", () => {
    const cut = ["KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL", '"art.pdf","OK","20260822_091348","20260822_091353","20260822_091400","20260822_091900",,', ',,,,,,"3",'].join("\r\n");
    const rows = parseRasterlinkRows(cut, "20260822_091900_art.pdf_1_OK_cut.csv") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "cut", inkMl: 0 });
    expect(rows[0].raw).toMatchObject({ arrangeCnt: 3, cutMinutes: 5 });
  });
});

describe("11. duplicate import stays idempotent", () => {
  const text = csv(`"art.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"130",');
  it("the same file gives the same content hash and the same row key every time", () => {
    expect(fileHashMarker(text)).toBe(fileHashMarker(text));
    const a = parse(text)[0];
    const b = parse(text)[0];
    expect(JSON.stringify(rowDedupeWhere("shop-1", a, "imp"))).toBe(JSON.stringify(rowDedupeWhere("shop-1", b, "imp")));
    // a print row with a complete RIP window keys on that window, not on ink — so the corrected ink does not split it from itself
    const where: any = rowDedupeWhere("shop-1", a, "imp");
    expect(where).toMatchObject({ sourceJobName: "art.pdf", status: "print:OK" });
    expect(where.ripStartedAt).toEqual(a.ripStartedAt);
    expect("inkMl" in where).toBe(false);
  });
  it("the upload endpoint still refuses a repeated file and skips a repeated row", () => {
    const upload = src("app/routes/api.rip-imports.upload.tsx");
    expect(upload).toContain("duplicateFile: true");
    expect(upload).toContain("if (existing) { skippedDuplicates += 1; continue; }");
  });
});

describe("12-14. matching is unchanged: exact routed name, ticket, or unmatched", () => {
  const items = [{ id: "item_a", shop: "s", jobId: "job_a", itemTicket: "GSO-20261118-0003-01", ripJobName: "GSO-20261118-0003-01", suggestedFileName: null }];
  const files = [{ shop: "s", jobId: "job_b", fileType: "print_file", assetSource: "nas", fileName: "Flame_Society_Jar_Front__R2-A1.pdf" }];
  const db: any = {
    productionJobItem: { findMany: async ({ where, take }: any) => { let hits = items.filter((item) => item.shop === where.shop); if (where.itemTicket) hits = hits.filter((item) => item.itemTicket === where.itemTicket); else if (where.ripJobName?.in) hits = hits.filter((item) => where.ripJobName.in.includes(item.ripJobName)); return take ? hits.slice(0, take) : hits; } },
    productionJob: { findMany: async () => [] },
    productionJobFile: { findMany: async ({ where }: any) => files.filter((file) => file.shop === where.shop && file.fileName.startsWith(where.fileName.startsWith)) },
  };
  it("a parsed continuation-row result matches by the item ticket in its routed name", async () => {
    const row = parse(csv(`"GSO-20261118-0003-01.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"130",'))[0];
    expect(await resolveRipIdentity(db, "s", { jobName: row.fileName })).toMatchObject({ status: "matched", confidence: "exact_item_ticket", productionJobId: "job_a", productionJobItemId: "item_a" });
  });
  it("…or by the exact routed print-file name", async () => {
    const row = parse(csv(`"Flame_Society_Jar_Front__R2-A1.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"2",'))[0];
    expect(await resolveRipIdentity(db, "s", { jobName: row.fileName })).toMatchObject({ status: "matched", confidence: "exact_routed_print_file", productionJobId: "job_b" });
  });
  it("an unknown job name stays unmatched; a dropped empty record can never match anything because it is not a row", async () => {
    const rows = parse(csv(`"kk_skittles up_f_.pdf","OK",${INK},"20260822_091348","20260822_091353",,,,`, ',,,,,,,"130",', "", ",,,,,,,,", ',,,,,,,"130",'));
    expect(rows).toHaveLength(1);
    expect((await resolveRipIdentity(db, "s", { jobName: rows[0].fileName })).status).toBe("unmatched");
  });
});

describe("15-17. the parser and the import path create no job, no job file and no cost", () => {
  it("the parser is a pure module with no database access", () => {
    const parser = src("app/lib/rasterlink-parse.server.ts");
    expect([...parser.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["crypto"]); // its only import
    expect(parser).not.toMatch(/\b(db|tx|prisma)\.\w+\.(create|update|upsert|delete\w*)\(/);
    expect(parser).not.toMatch(/unitCost|actualCost|jobCost/);
  });
  it("the upload endpoint's writes are exactly the import record and print-log rows", () => {
    const upload = src("app/routes/api.rip-imports.upload.tsx");
    const writes = [...upload.matchAll(/db\.(\w+)\.(create|update|upsert|delete\w*|createMany|updateMany)\(/g)].map((match) => `${match[1]}.${match[2]}`);
    expect([...new Set(writes)].sort()).toEqual(["printLogAutoImportSetting.update", "printLogEntry.create", "printLogEntry.update", "printLogImport.create", "printLogImport.update"]);
    expect(upload).not.toMatch(/productionJob(Item|File)?\.(create|update|upsert|updateMany)\b/);
    expect(upload).not.toContain("print-log-writeback");
  });
});
