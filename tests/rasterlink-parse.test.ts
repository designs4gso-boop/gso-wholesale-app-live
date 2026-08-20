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
    expect(rowDedupeWhere("shop1", a)).toEqual(rowDedupeWhere("shop1", b));
    expect(resultKeyOf(a)).toBe(resultKeyOf(b));

    const later = `${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,2026/06/04 12:00:00,2026/06/04 12:10:00,40,OK`;
    const c = parseRasterlinkRows(later, "a.csv")[0];
    expect(rowDedupeWhere("shop1", c)).not.toEqual(rowDedupeWhere("shop1", a));
    expect(resultKeyOf(c)).not.toBe(resultKeyOf(a));
  });

  it("blank-time rows include inkMl in the natural key so different ink is not conflated", () => {
    const blankA = parseRasterlinkRows(`${PRINT_HEADER}\njob.pdf,Complete,${INKUSE},,,,,40,OK`, "a.csv")[0];
    const blankB = parseRasterlinkRows(`${PRINT_HEADER}\njob.pdf,Complete,C:0.500cc,,,,,40,OK`, "a.csv")[0];
    const whereA = rowDedupeWhere("shop1", blankA);
    const whereB = rowDedupeWhere("shop1", blankB);
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
