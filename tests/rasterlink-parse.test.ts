import { describe, expect, it } from "vitest";

import {
  INK_BASIS_CUT,
  INK_BASIS_ESTIMATE,
  INK_BASIS_MISSING,
  decideMatch,
  extractTicket,
  fileHashMarker,
  fileHashOf,
  looksLikeRasterlinkCsv,
  parseInkUse,
  parseJobInfoInkUsed,
  parseRasterlinkRows,
  parseWarningCount,
  resultKeyOf,
  rowDedupeWhere,
} from "../app/lib/rasterlink-parse.server";

const PRINT_HEADER = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const CUT_HEADER = "KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const INKUSE = "C:0.067cc M:0.070cc Y:0.014cc K:0.017cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc";

describe("header detection", () => {
  it("detects RasterLink KEY_* headers", () => {
    expect(looksLikeRasterlinkCsv(`${PRINT_HEADER}\nfoo`)).toBe(true);
    expect(looksLikeRasterlinkCsv(`${CUT_HEADER}\nfoo`)).toBe(true);
  });

  it("does NOT match VersaWorks headers — the existing upload path stays valid", () => {
    const versaworks = "Event,Nick Name,Job Name,Media Name,Ink Consumption[ml],Ink Name,Print Area_X[mm],Print Area_Y[mm],Print Start Time,Print End Time";
    expect(looksLikeRasterlinkCsv(`${versaworks}\nPrinted,Roland LG-540,GSO-1_job,Matte,1:2:3,Cyan:Magenta:Yellow,100,200,,`)).toBe(false);
  });
});

describe("validated ink conversion", () => {
  it("parses the confirmed C/M/Y/K example exactly", () => {
    const ink = parseInkUse(INKUSE);
    expect(ink.present).toBe(true);
    expect(ink.cyanCc).toBeCloseTo(0.067, 9);
    expect(ink.magentaCc).toBeCloseTo(0.07, 9);
    expect(ink.yellowCc).toBeCloseTo(0.014, 9);
    expect(ink.blackCc).toBeCloseTo(0.017, 9);
    expect(ink.perItemTotalCc).toBeCloseTo(0.168, 9);
  });

  it("JobInfo.ini inkUsed converts raw/1000 with codes 1-4 = CMYK (pure converter, not wired yet)", () => {
    const ink = parseJobInfoInkUsed("inkUsed=1;67,2;70,3;14,4;17");
    expect(ink.cyanCc).toBeCloseTo(0.067, 9);
    expect(ink.magentaCc).toBeCloseTo(0.07, 9);
    expect(ink.yellowCc).toBeCloseTo(0.014, 9);
    expect(ink.blackCc).toBeCloseTo(0.017, 9);
    expect(ink.perItemTotalCc).toBeCloseTo(0.168, 9);
  });

  it("sums repeated white and clear channels", () => {
    const ink = parseInkUse("C:0.010cc W:0.020cc W:0.030cc Cl:0.005cc Cl:0.015cc");
    expect(ink.whiteCc).toBeCloseTo(0.05, 9);
    expect(ink.clearCc).toBeCloseTo(0.02, 9);
  });

  it("blank KEY_INKUSE is present:false — never zero-faked into a real reading", () => {
    expect(parseInkUse("").present).toBe(false);
    expect(parseInkUse(null).present).toBe(false);
  });
});

describe("row building", () => {
  it("print row: 0.168 per-item x 40 arranged = 6.72 estimated total, flagged as estimate", () => {
    const csv = `${PRINT_HEADER}\nGSO-123_Cust_Jar_FRONT_Matte_MIMAKI_R1.pdf,Complete,${INKUSE},2026/06/04 10:00:00,2026/06/04 10:05:00,2026/06/04 10:06:00,2026/06/04 10:26:00,40,OK`;
    const rows = parseRasterlinkRows(csv, "result.csv");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("print");
    expect(row.inkMl).toBeCloseTo(6.72, 6);
    expect(row.cmykInkMl).toBeCloseTo(6.72, 6);
    expect(row.raw.inkBasis).toBe(INK_BASIS_ESTIMATE);
    expect((row.raw.perItem as any).totalCc).toBeCloseTo(0.168, 9);
    expect(row.raw.arrangeCnt).toBe(40);
    expect(row.jobTicket).toBe("GSO-123");
    // print duration from PRINT timestamps only (20 min), never RIP duration
    expect(row.printMinutes).toBeCloseTo(20, 6);
    expect(row.status).toBe("print:Complete");
  });

  it("RIP-only row: RIP times never become print duration", () => {
    const csv = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},2026/06/04 10:00:00,2026/06/04 10:05:00,,,40,OK`;
    const row = parseRasterlinkRows(csv, "r.csv")[0];
    expect(row.printMinutes).toBe(0);
    expect(row.startedAt).toBeNull();
    expect(row.raw.timingBasis).toBe("rip_only_no_print_times");
    expect(row.raw.ripMinutes).toBeCloseTo(5, 6);
  });

  it("blank KEY_INKUSE print row imports with missing-ink basis, not zero-faked", () => {
    const csv = `${PRINT_HEADER}\njob.pdf,Complete,,,,,,40,OK`;
    const rows = parseRasterlinkRows(csv, "r.csv");
    expect(rows).toHaveLength(1);
    expect(rows[0].inkMl).toBe(0);
    expect(rows[0].raw.inkBasis).toBe(INK_BASIS_MISSING);
    expect(rows[0].raw.perItem).toBeNull();
  });

  it("cut-only CSV produces distinct cut rows with no ink and no print minutes", () => {
    const csv = `${CUT_HEADER}\nGSO-77_job.pdf,Complete,2026/06/04 11:00:00,2026/06/04 11:02:00,2026/06/04 11:03:00,2026/06/04 11:10:00,12,OK`;
    const rows = parseRasterlinkRows(csv, "cut.csv");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("cut");
    expect(row.status).toBe("cut:Complete");
    expect(row.inkMl).toBe(0);
    expect(row.printMinutes).toBe(0);
    expect(row.raw.inkBasis).toBe(INK_BASIS_CUT);
    expect(row.raw.cutMinutes).toBeCloseTo(7, 6);
    expect(row.raw.vecMinutes).toBeCloseTo(2, 6);
    expect(row.jobTicket).toBe("GSO-77");
  });

  it("assumes arrange count 1 with a flag when the count is missing", () => {
    const csv = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,2026/06/04 10:00:00,2026/06/04 10:10:00,,OK`;
    const row = parseRasterlinkRows(csv, "r.csv")[0];
    expect(row.inkMl).toBeCloseTo(0.168, 6);
    expect(row.raw.arrangeAssumed).toBe(true);
  });
});

describe("parse warning count (13A.6B audit metadata)", () => {
  it("counts missing-ink, assumed-arrange, and RIP-only rows; clean rows count zero", () => {
    const clean = `${PRINT_HEADER}\nGSO-1_j.pdf,Complete,${INKUSE},,,2026/06/04 10:00:00,2026/06/04 10:20:00,40,OK`;
    expect(parseWarningCount(parseRasterlinkRows(clean, "a.csv"))).toBe(0);

    const warny = [
      PRINT_HEADER,
      `blank-ink.pdf,Complete,,,,,,40,OK`, // missing_inkuse
      `no-arrange.pdf,Complete,${INKUSE},,,2026/06/04 10:00:00,2026/06/04 10:10:00,,OK`, // arrangeAssumed
      `rip-only.pdf,Complete,${INKUSE},2026/06/04 09:00:00,2026/06/04 09:05:00,,,40,OK`, // rip_only timing
    ].join("\n");
    expect(parseWarningCount(parseRasterlinkRows(warny, "b.csv"))).toBe(3);

    const cut = `${CUT_HEADER}\nGSO-2_j.pdf,Complete,2026/06/04 11:00:00,2026/06/04 11:02:00,2026/06/04 11:03:00,2026/06/04 11:10:00,12,OK`;
    expect(parseWarningCount(parseRasterlinkRows(cut, "c.csv"))).toBe(0);
  });
});

describe("duplicate protection", () => {
  it("identical rows produce identical natural keys; different timestamps differ", () => {
    const csv = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,2026/06/04 10:00:00,2026/06/04 10:10:00,40,OK`;
    const a = parseRasterlinkRows(csv, "a.csv")[0];
    const b = parseRasterlinkRows(csv, "b.csv")[0];
    expect(rowDedupeWhere("shop1", a, "imp1")).toEqual(rowDedupeWhere("shop1", b, "imp1"));
    expect(resultKeyOf(a)).toBe(resultKeyOf(b));

    const later = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,2026/06/04 12:00:00,2026/06/04 12:10:00,40,OK`;
    const c = parseRasterlinkRows(later, "a.csv")[0];
    expect(rowDedupeWhere("shop1", c, "imp1")).not.toEqual(rowDedupeWhere("shop1", a, "imp1"));
    expect(resultKeyOf(c)).not.toBe(resultKeyOf(a));
  });

  it("blank-time rows include inkMl in the natural key so different ink is not conflated", () => {
    const blankA = parseRasterlinkRows(`${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,,,40,OK`, "a.csv")[0];
    const blankB = parseRasterlinkRows(`${PRINT_HEADER}\njob.pdf,Complete,C:0.500cc,,,,,40,OK`, "a.csv")[0];
    const whereA = rowDedupeWhere("shop1", blankA, "imp1");
    const whereB = rowDedupeWhere("shop1", blankB, "imp1");
    expect(whereA.inkMl).toBeDefined();
    expect(whereA).not.toEqual(whereB);
  });

  it("duplicate files share a content hash marker; different content differs", () => {
    const text = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,,,40,OK`;
    expect(fileHashOf(text)).toBe(fileHashOf(text));
    expect(fileHashMarker(text).startsWith("sha256:")).toBe(true);
    expect(fileHashOf(text)).not.toBe(fileHashOf(`${text}\nextra.pdf,Complete,,,,,,1,OK`));
  });
});

describe("conservative matching", () => {
  it("zero matches stay unmatched", () => {
    expect(decideMatch([])).toEqual({ productionJobId: null, ambiguous: false });
  });

  it("exactly one match attaches", () => {
    expect(decideMatch([{ id: "job1" }])).toEqual({ productionJobId: "job1", ambiguous: false });
  });

  it("multiple matches never silently attach — flagged ambiguous", () => {
    const decision = decideMatch([{ id: "job1" }, { id: "job2" }]);
    expect(decision.productionJobId).toBeNull();
    expect(decision.ambiguous).toBe(true);
  });

  it("ticket extraction matches the existing endpoint pattern", () => {
    expect(extractTicket("GSO-123_Cust_Jar_FRONT_Matte_MIMAKI_R1.pdf")).toBe("GSO-123");
    expect(extractTicket("no ticket here")).toBe("");
  });
});

/* ================================================================== *
 * 2C-1 — RASTERLINK NATIVE TIMESTAMP FORMAT (YYYYMMDD_HHMMSS)
 *
 * Every fixture below is the format the shop actually exports. Before this
 * patch `new Date("20260601_231501")` was Invalid Date, so:
 *   - cut-format rows were DROPPED ENTIRELY (no KEY_INKUSE column and no
 *     parsable cut/vec stamp => neither side present => zero rows), and
 *   - print rows imported with null startedAt/completedAt and 0 minutes.
 * The pre-existing ISO-style fixtures above still pass — that path is kept.
 * ================================================================== */

describe("2C-1 RasterLink native timestamps (YYYYMMDD_HHMMSS)", () => {
  // The real production cut CSV, byte-shaped as the shop exports it.
  const NATIVE_CUT = `${CUT_HEADER}\n"GSO-77_drumstick_b.pdf","OK","20260601_163444","20260601_163448","20260601_231501","20260601_235058","65",""`;

  it("CUT: a native-format row now produces a cut entry instead of ZERO rows", () => {
    const rows = parseRasterlinkRows(NATIVE_CUT, "20260601_235058_1_OK_cut.csv");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("cut");
    expect(row.status).toBe("cut:OK");
    expect(row.startedAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
    // 23:15:01 -> 23:50:58 = 35 min 57 s
    expect(row.raw.cutMinutes).toBeCloseTo(35 + 57 / 60, 9);
    expect(row.raw.vecMinutes).toBeCloseTo(4 / 60, 9); // 16:34:44 -> 16:34:48
    expect(row.raw.arrangeCnt).toBe(65);
    expect(row.inkMl).toBe(0);
    expect(row.printMinutes).toBe(0);
    expect(row.raw.inkBasis).toBe(INK_BASIS_CUT);
    expect(row.jobTicket).toBe("GSO-77");
  });

  it("CUT: the stamp resolves to the exact LOCAL wall-clock time the shop recorded", () => {
    const row = parseRasterlinkRows(NATIVE_CUT, "c.csv")[0];
    const start = row.startedAt!;
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5); // June, 0-indexed
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(23);
    expect(start.getMinutes()).toBe(15);
    expect(start.getSeconds()).toBe(1);
    // startedAt falls back to VEC start only when CUT start is absent
    expect(row.raw.cutStart).toBe(start.toISOString());
  });

  it("PRINT: native RIP stamps parse; EMPTY print stamps stay empty — no fabricated print time", () => {
    // Exactly what the 538 production print files look like: RIP times
    // populated, KEY_PRINT_S_TIME / KEY_PRINT_E_TIME blank.
    const csv = `${PRINT_HEADER}\n"job_b.pdf","OK","${INKUSE}","20260601_163310","20260601_163317","","","40",""`;
    const rows = parseRasterlinkRows(csv, "p.csv");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("print");
    expect(row.raw.ripMinutes).toBeCloseTo(7 / 60, 9); // 16:33:10 -> 16:33:17
    expect(row.startedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.printMinutes).toBe(0); // NEVER derived from RIP time
    expect(row.raw.timingBasis).toBe("rip_only_no_print_times");
    expect(row.inkMl).toBeCloseTo(0.168 * 40, 6); // ink still parses normally
  });

  it("PRINT: native print stamps parse when RasterLink does populate them", () => {
    const csv = `${PRINT_HEADER}\n"job.pdf","OK","${INKUSE}","20260601_100000","20260601_100030","20260601_101500","20260601_104500","40",""`;
    const row = parseRasterlinkRows(csv, "p.csv")[0];
    expect(row.printMinutes).toBeCloseTo(30, 9); // 10:15 -> 10:45
    expect(row.raw.timingBasis).toBe("print_times");
  });

  it("accepts the boundary stamps", () => {
    const cases: Array<[string, string, number[]]> = [
      ["20260101_000000", "20260101_000001", [2026, 0, 1, 0, 0, 0]],
      ["20261231_235958", "20261231_235959", [2026, 11, 31, 23, 59, 58]],
      ["20240229_120000", "20240229_120001", [2024, 1, 29, 12, 0, 0]], // leap day
    ];
    for (const [start, end, [y, mo, d, h, mi, s]] of cases) {
      const row = parseRasterlinkRows(`${CUT_HEADER}\nj.pdf,OK,,,${start},${end},1,`, "c.csv")[0];
      expect(row, start).toBeDefined();
      const at = row.startedAt!;
      expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()], start)
        .toEqual([y, mo, d, h, mi, s]);
    }
  });

  it("REJECTS malformed and impossible stamps rather than normalising them", () => {
    // A cut row whose ONLY stamps are malformed has no cut side at all, and a
    // cut CSV has no KEY_INKUSE column, so the row is correctly dropped.
    for (const bad of [
      "20260601",         // date only, no time part
      "20260601-231501",  // wrong separator
      "20261301_120000",  // month 13
      "20260230_120000",  // 30 February — must NOT roll into March
      "20260601_246000",  // hour 24, minute 60
      "20260601_235960",  // second 60
      "20250229_120000",  // 29 Feb in a non-leap year
      "202606011_231501", // too many digits
      "",                 // empty
    ]) {
      const rows = parseRasterlinkRows(`${CUT_HEADER}\nj.pdf,OK,,,${bad},${bad},1,`, "c.csv");
      expect(rows, bad).toHaveLength(0);
    }
  });

  it("a malformed CUT stamp does not fabricate a duration from the VEC stamps", () => {
    const csv = `${CUT_HEADER}\nj.pdf,OK,20260601_163444,20260601_163448,20260230_120000,20260230_130000,65,`;
    const row = parseRasterlinkRows(csv, "c.csv")[0];
    expect(row.kind).toBe("cut");
    expect(row.raw.cutMinutes).toBe(0); // impossible cut stamps -> no cut duration
    expect(row.raw.cutStart).toBeNull();
    expect(row.raw.vecMinutes).toBeCloseTo(4 / 60, 9);
    expect(row.startedAt).not.toBeNull(); // falls back to VEC start, as before
  });

  it("the pre-existing ISO-style path is untouched", () => {
    const csv = `${CUT_HEADER}\nGSO-77_job.pdf,Complete,2026/06/04 11:00:00,2026/06/04 11:02:00,2026/06/04 11:03:00,2026/06/04 11:10:00,12,OK`;
    const row = parseRasterlinkRows(csv, "cut.csv")[0];
    expect(row.raw.cutMinutes).toBeCloseTo(7, 6);
    expect(row.raw.vecMinutes).toBeCloseTo(2, 6);
  });

  it("native and ISO forms of the same instant are identical", () => {
    const native = parseRasterlinkRows(`${CUT_HEADER}\nj.pdf,OK,,,20260601_231501,20260601_235058,1,`, "c.csv")[0];
    const iso = parseRasterlinkRows(`${CUT_HEADER}\nj.pdf,OK,,,2026-06-01 23:15:01,2026-06-01 23:50:58,1,`, "c.csv")[0];
    expect(native.startedAt!.getTime()).toBe(iso.startedAt!.getTime());
    expect(native.completedAt!.getTime()).toBe(iso.completedAt!.getTime());
    expect(native.raw.cutMinutes).toBe(iso.raw.cutMinutes);
  });

  it("does NOT invent telemetry RasterLink never supplies", () => {
    const row = parseRasterlinkRows(NATIVE_CUT, "c.csv")[0];
    const raw = row.raw as Record<string, unknown>;
    // no layout width, feed length, scan width or cut mode exists in either
    // CSV variant — the parser must not conjure them
    for (const absent of ["widthIn", "feedLengthIn", "scanWidthIn", "layoutSqft", "cutMode", "sqft"]) {
      expect(absent in raw, absent).toBe(false);
    }
  });
});

/* ================================================================== *
 * 2C-2 — PRINT EVENT IDENTITY
 *
 * Batch 2 destroyed 18 real print events because RasterLink print rows carry
 * no print-execution stamps, so the global natural key degenerated to
 * (sourceJobName, status). The RIP window is the discriminator that was always
 * present but unqueryable. These tests pin BOTH halves of the fix: strong
 * identity dedupes globally, weak identity dedupes only inside its own import.
 *
 * Fixture stamps are the real production format (YYYYMMDD_HHMMSS).
 * ================================================================== */

import {
  BACKFILL_CANDIDATE_WHERE,
  BACKFILL_WRITABLE_FIELDS,
  parseStoredStamp,
  planBackfill,
} from "../tools/backfill-rasterlink-rip-timestamps.mjs";
import { hasStrongEventIdentity } from "../app/lib/rasterlink-parse.server";
import { parseVersaworksRows, versaworksRowDedupeWhere } from "../app/lib/versaworks-parse.server";

/** A print CSV with no ink and no print stamps — the shape that lost 18 rows. */
const printCsv = (job: string, ripS: string, ripE: string, ink = "") =>
  `${PRINT_HEADER}\n"${job}","OK","${ink}","${ripS}","${ripE}","","","",""`;

describe("2C-2 A. same artwork, different RIP windows -> BOTH survive", () => {
  it("distinct RIP windows produce distinct global keys", () => {
    // the real kk_apple jack_b.pdf case: five runs, minutes apart, same artwork
    const first = parseRasterlinkRows(printCsv("kk_apple jack_b.pdf", "20260612_000706", "20260612_000710"), "a.csv")[0];
    const later = parseRasterlinkRows(printCsv("kk_apple jack_b.pdf", "20260612_071639", "20260612_071645"), "b.csv")[0];

    expect(first.fileName).toBe(later.fileName);
    expect(first.status).toBe(later.status);
    expect(first.inkMl).toBe(later.inkMl); // ink identical (both absent)
    expect(rowDedupeWhere("shop1", first, "impA")).not.toEqual(rowDedupeWhere("shop1", later, "impB"));
  });

  it("the key is GLOBAL for these rows — importId must not appear", () => {
    const row = parseRasterlinkRows(printCsv("kk_apple jack_b.pdf", "20260612_000706", "20260612_000710"), "a.csv")[0];
    const where = rowDedupeWhere("shop1", row, "impA");
    expect(where.importId).toBeUndefined();
    expect(where.ripStartedAt).toBeInstanceOf(Date);
    expect(where.ripCompletedAt).toBeInstanceOf(Date);
    // ...and the SAME row from a different import still matches it
    expect(rowDedupeWhere("shop1", row, "impZ")).toEqual(where);
  });

  it("even under different importIds, five distinct runs stay five keys", () => {
    const runs = ["20260612_000706", "20260612_071639", "20260612_073005", "20260612_073707", "20260612_075418"];
    const keys = runs.map((s, i) =>
      JSON.stringify(rowDedupeWhere("shop1", parseRasterlinkRows(printCsv("kk_apple jack_b.pdf", s, s), `f${i}.csv`)[0], `imp${i}`)),
    );
    expect(new Set(keys).size).toBe(5);
  });
});

describe("2C-2 B/C. same event replayed -> still dedupes", () => {
  it("identical RIP window across DIFFERENT imports produces the SAME key", () => {
    const csv = printCsv("CANDI PAIN_icee_F.pdf", "20260718_152326", "20260718_152339");
    const original = parseRasterlinkRows(csv, "20260718_093551_CANDI PAIN_icee_F.pdf_1_OK_print.csv")[0];
    const renamed = parseRasterlinkRows(csv, "20260718_093551_CANDI PAIN_icee_F.pdf_1_OK_print-d596e66a.csv")[0];
    expect(rowDedupeWhere("shop1", original, "impOld")).toEqual(rowDedupeWhere("shop1", renamed, "impNew"));
  });

  it("byte-identical content still shares a file hash marker", () => {
    const csv = printCsv("CANDI PAIN_icee_F.pdf", "20260718_152326", "20260718_152339");
    expect(fileHashOf(csv)).toBe(fileHashOf(csv));
    expect(fileHashMarker(csv).startsWith("sha256:")).toBe(true);
  });
});

describe("2C-2 D/E. weak identity -> import-scoped only", () => {
  const weakCsv = `${PRINT_HEADER}\n"kk_apple jack_b.pdf","OK","","","","","","",""`;

  it("a row with NO usable timestamp is classified weak", () => {
    const row = parseRasterlinkRows(weakCsv, "a.csv")[0];
    expect(hasStrongEventIdentity(row)).toBe(false);
    expect(row.ripStartedAt).toBeNull();
    expect(row.startedAt).toBeNull();
  });

  it("D. two identical weak rows in the SAME import still collapse", () => {
    const a = parseRasterlinkRows(weakCsv, "a.csv")[0];
    const b = parseRasterlinkRows(weakCsv, "a.csv")[0];
    const where = rowDedupeWhere("shop1", a, "imp-SAME");
    expect(where).toEqual(rowDedupeWhere("shop1", b, "imp-SAME"));
    expect(where.importId).toBe("imp-SAME");
  });

  it("E. the same artwork in DIFFERENT imports is NOT collapsed on job/status alone", () => {
    const a = parseRasterlinkRows(weakCsv, "a.csv")[0];
    const b = parseRasterlinkRows(weakCsv, "b.csv")[0];
    expect(rowDedupeWhere("shop1", a, "imp-1")).not.toEqual(rowDedupeWhere("shop1", b, "imp-2"));
  });

  it("weak rows still keep inkMl in the key, as before", () => {
    const withInk = parseRasterlinkRows(`${PRINT_HEADER}\n"j.pdf","OK","${INKUSE}","","","","","",""`, "a.csv")[0];
    expect(rowDedupeWhere("shop1", withInk, "imp-1").inkMl).toBeDefined();
  });
});

describe("2C-2 F/G. cut and VersaWorks dedupe UNCHANGED", () => {
  it("F. cut rows key exactly as before — no RIP fields, no importId", () => {
    const csv = `${CUT_HEADER}\n"j.pdf","OK","20260601_163444","20260601_163448","20260601_231501","20260601_235058","65",""`;
    const row = parseRasterlinkRows(csv, "c.csv")[0];
    const where = rowDedupeWhere("shop1", row, "impA");
    expect(Object.keys(where).sort()).toEqual(
      ["completedAt", "printerSoftware", "shop", "sourceJobName", "startedAt", "status"].sort(),
    );
    expect(where.importId).toBeUndefined();
    expect(where.ripStartedAt).toBeUndefined();
    // same cut event from another import still matches -> global, as before
    expect(rowDedupeWhere("shop1", row, "impZ")).toEqual(where);
  });

  it("F2. cut rows carry null RIP columns", () => {
    const csv = `${CUT_HEADER}\n"j.pdf","OK","20260601_163444","20260601_163448","20260601_231501","20260601_235058","65",""`;
    const row = parseRasterlinkRows(csv, "c.csv")[0];
    expect(row.ripStartedAt).toBeNull();
    expect(row.ripCompletedAt).toBeNull();
  });

  it("G. VersaWorks key shape is untouched by 2C-2", () => {
    const vw = "Event,Nick Name,Job Name,Media Name,Ink Consumption[ml],Ink Name,Print Area_X[mm],Print Area_Y[mm],Print Start Time,Print End Time";
    const rows = parseVersaworksRows(`${vw}\nPrinted,Roland LG-640,GSO-1_job,Matte,1:2:3,Cyan:Magenta:Yellow,1000,2000,2026-06-01 10:00:00,2026-06-01 10:30:00`, "v.csv");
    expect(rows.length).toBeGreaterThan(0);
    const where = versaworksRowDedupeWhere("shop1", rows[0]);
    expect(where.importId).toBeUndefined();
    expect(where.ripStartedAt).toBeUndefined();
    expect(Object.keys(where)).toContain("machineName");
    expect(where.printerSoftware).toBe("versaworks");
  });
});

describe("2C-2 H/I. RIP timing never becomes print execution timing", () => {
  it("H. RIP stamps do not populate startedAt / completedAt / printMinutes", () => {
    const row = parseRasterlinkRows(printCsv("j.pdf", "20260601_163310", "20260601_163317", INKUSE), "p.csv")[0];
    expect(row.ripStartedAt).toBeInstanceOf(Date);
    expect(row.ripCompletedAt).toBeInstanceOf(Date);
    expect(row.startedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.printMinutes).toBe(0);
    expect(row.raw.timingBasis).toBe("rip_only_no_print_times");
  });

  it("H2. real print stamps still win and RIP stays separate", () => {
    const csv = `${PRINT_HEADER}\n"j.pdf","OK","${INKUSE}","20260601_100000","20260601_100030","20260601_101500","20260601_104500","40",""`;
    const row = parseRasterlinkRows(csv, "p.csv")[0];
    expect(row.printMinutes).toBeCloseTo(30, 9);
    expect(row.startedAt!.getHours()).toBe(10);
    expect(row.ripStartedAt!.getMinutes()).toBe(0);
    expect(row.raw.timingBasis).toBe("print_times");
  });

  it("I. native YYYYMMDD_HHMMSS parsing regression stays green", () => {
    const row = parseRasterlinkRows(printCsv("j.pdf", "20260601_163310", "20260601_163317"), "p.csv")[0];
    const s = row.ripStartedAt!;
    expect([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds()])
      .toEqual([2026, 5, 1, 16, 33, 10]);
    // malformed stays null rather than normalising
    expect(parseRasterlinkRows(printCsv("j.pdf", "20260230_120000", "20260230_130000"), "p.csv")[0].ripStartedAt).toBeNull();
  });
});

describe("2C-2 J. historical backfill tool", () => {
  const row = (id: string, raw: unknown) => ({ id, sourceJobName: "j.pdf", status: "print:OK", rawRow: raw === null ? null : JSON.stringify(raw) });

  it("only ever scans rasterlink PRINT rows, and uses OR so partials cannot strand", () => {
    expect(BACKFILL_CANDIDATE_WHERE).toEqual({
      printerSoftware: "rasterlink",
      status: { startsWith: "print:" },
      OR: [{ ripStartedAt: null }, { ripCompletedAt: null }],
    });
    // an AND filter would make a half-populated row invisible forever
    expect(BACKFILL_CANDIDATE_WHERE).not.toHaveProperty("ripStartedAt");
    expect(BACKFILL_CANDIDATE_WHERE).not.toHaveProperty("ripCompletedAt");
  });

  it("is permitted to write ONLY the two RIP columns", () => {
    expect(BACKFILL_WRITABLE_FIELDS).toEqual(["ripStartedAt", "ripCompletedAt"]);
    for (const forbidden of ["startedAt", "completedAt", "printMinutes", "rawRow", "inkMl", "status"]) {
      expect(BACKFILL_WRITABLE_FIELDS, forbidden).not.toContain(forbidden);
    }
  });

  it("valid stored RIP stamps become first-class values", () => {
    const { updates, counts } = planBackfill([
      row("r1", { ripStart: "2026-06-01T16:33:10.000Z", ripEnd: "2026-06-01T16:33:17.000Z" }),
    ]);
    expect(counts.updatable).toBe(1);
    expect(updates[0].id).toBe("r1");
    expect(updates[0].data.ripStartedAt.toISOString()).toBe("2026-06-01T16:33:10.000Z");
    expect(updates[0].data.ripCompletedAt.toISOString()).toBe("2026-06-01T16:33:17.000Z");
  });

  it("a PARTIALLY populated row stays a candidate and only its MISSING half is written", () => {
    const partial = {
      id: "half", sourceJobName: "j.pdf", status: "print:OK",
      ripStartedAt: new Date("2026-06-01T16:33:10.000Z"), ripCompletedAt: null,
      rawRow: JSON.stringify({ ripStart: "2026-06-01T16:33:10.000Z", ripEnd: "2026-06-01T16:33:17.000Z" }),
    };
    const { updates, counts } = planBackfill([partial]);
    expect(counts.updatable).toBe(1);
    expect(Object.keys(updates[0].data)).toEqual(["ripCompletedAt"]); // never rewrites the set one
    expect(updates[0].data.ripCompletedAt.toISOString()).toBe("2026-06-01T16:33:17.000Z");
  });

  it("a fully populated row is skipped, never overwritten", () => {
    const done = {
      id: "done", sourceJobName: "j.pdf", status: "print:OK",
      ripStartedAt: new Date("2026-06-01T16:33:10.000Z"),
      ripCompletedAt: new Date("2026-06-01T16:33:17.000Z"),
      rawRow: JSON.stringify({ ripStart: "2020-01-01T00:00:00.000Z", ripEnd: "2020-01-01T00:00:01.000Z" }),
    };
    const { updates, counts } = planBackfill([done]);
    expect(updates).toHaveLength(0);
    expect(counts.skippedAlreadySet).toBe(1);
  });

  it("missing / invalid / unparsable rows are skipped with an explicit reason", () => {
    const { updates, counts } = planBackfill([
      row("noRaw", null),
      { id: "badJson", sourceJobName: "j", status: "print:OK", rawRow: "{not json" },
      row("noStamps", { ripStart: null, ripEnd: null }),
      row("invalid", { ripStart: "not-a-date", ripEnd: "" }),
      row("implausible", { ripStart: "1899-01-01T00:00:00.000Z", ripEnd: null }),
      row("good", { ripStart: "2026-06-01T16:33:10.000Z", ripEnd: null }),
    ]);
    expect(counts.candidates).toBe(6);
    expect(counts.skippedNoRaw).toBe(2);
    expect(counts.skippedNoStamps).toBe(1);
    expect(counts.skippedInvalid).toBe(2);
    expect(counts.updatable).toBe(1);
    expect(updates.map((u) => u.id)).toEqual(["good"]);
    expect(Object.keys(updates[0].data)).toEqual(["ripStartedAt"]); // only the half that exists
  });

  it("a second pass over already-populated rows plans zero updates", () => {
    // the query filter removes them from the candidate set entirely
    const secondPass = planBackfill([]);
    expect(secondPass.updates).toHaveLength(0);
    expect(secondPass.counts.updatable).toBe(0);
  });

  it("parseStoredStamp refuses anything that is not a real instant", () => {
    expect(parseStoredStamp("2026-06-01T16:33:10.000Z")).toBeInstanceOf(Date);
    for (const bad of [null, undefined, "", "   ", "not-a-date", 12345, {}, "1899-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z"]) {
      expect(parseStoredStamp(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("2C-2 partial RIP window is NOT identity", () => {
  const half = (ripS: string, ripE: string) =>
    parseRasterlinkRows(`${PRINT_HEADER}\n"j.pdf","OK","","${ripS}","${ripE}","","","",""`, "a.csv")[0];

  it("a half window does not qualify as strong identity", () => {
    expect(hasStrongEventIdentity(half("20260601_163310", ""))).toBe(false);
    expect(hasStrongEventIdentity(half("", "20260601_163317"))).toBe(false);
    expect(hasStrongEventIdentity(half("20260601_163310", "20260601_163317"))).toBe(true);
  });

  it("a half window falls to the IMPORT-SCOPED key, never a global one", () => {
    const row = half("20260601_163310", "");
    const where = rowDedupeWhere("shop1", row, "imp-1");
    expect(where.importId).toBe("imp-1");
    expect(where.ripStartedAt).toBeUndefined();
    expect(where.ripCompletedAt).toBeUndefined();
    // ...so it can never collide globally with an un-backfilled historical row
    expect(rowDedupeWhere("shop1", row, "imp-2")).not.toEqual(where);
  });

  it("a COMPLETE window still keys globally", () => {
    const where = rowDedupeWhere("shop1", half("20260601_163310", "20260601_163317"), "imp-1");
    expect(where.importId).toBeUndefined();
    expect(where.ripStartedAt).toBeInstanceOf(Date);
    expect(where.ripCompletedAt).toBeInstanceOf(Date);
  });
});
