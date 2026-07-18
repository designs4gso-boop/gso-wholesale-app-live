import { describe, expect, it } from "vitest";

import {
  VERSAWORKS_AMBIGUOUS_FLAG,
  VERSAWORKS_SOURCE,
  buildVersaworksRawRow,
  decideVersaworksMatch,
  extractVersaworksTicket,
  looksLikeVersaworksCsv,
  normalizeJobName,
  parseVersaworksRows,
  ripNameJobIdsFor,
  versaworksParseWarningCount,
  versaworksRowDedupeWhere,
} from "../app/lib/versaworks-parse.server";
import { fileHashMarker, looksLikeRasterlinkCsv } from "../app/lib/rasterlink-parse.server";
import { classifyEntry } from "../app/lib/rip-import-review.server";

// Realistic fixtures mirroring the header set the legacy endpoint has always
// parsed (the only supported VersaWorks CSV shape) plus its tolerated
// column-subset variants.
const FULL_HEADER = "Event,Nick Name,Job Name,Media Name,Ink Consumption[ml],Ink Name,Print Area_X[mm],Print Area_Y[mm],Print Start Time,Print End Time";
const RIP_TIMES_HEADER = "Event,Nick Name,Job Name,Media Name,Ink Consumption[ml],Ink Name,Print Area_X[mm],Print Area_Y[mm],RIP Start Time,RIP End Time";
const MINIMAL_HEADER = "Event,Nick Name,Job Name";
const RASTERLINK_HEADER = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT";

const FULL_ROW = `Printed,Roland LG-540,GSO-55_Cust_Banner,GlossVinyl,"1.5:2.5:3","Cyan:White:Gloss",254,254,2026/06/04 10:00:00,2026/06/04 10:20:00`;
const fullCsv = `${FULL_HEADER}\n${FULL_ROW}`;

describe("format detection (mutually exclusive with RasterLink)", () => {
  it("detects the supported VersaWorks header formats", () => {
    expect(looksLikeVersaworksCsv(fullCsv)).toBe(true);
    expect(looksLikeVersaworksCsv(`${RIP_TIMES_HEADER}\nPrinted,Roland,GSO-1_x,Matte,1,Cyan,10,10,2026/06/04 09:00:00,2026/06/04 09:05:00`)).toBe(true);
    expect(looksLikeVersaworksCsv(`${MINIMAL_HEADER}\nPrinted,Roland,GSO-2_y`)).toBe(true);
    expect(looksLikeVersaworksCsv("﻿" + fullCsv)).toBe(true); // BOM tolerated
  });

  it("never claims RasterLink files, and RasterLink never claims VersaWorks (regression)", () => {
    const rasterlink = `${RASTERLINK_HEADER}\nGSO-1_j.pdf,Complete,C:0.067cc,2026/06/04 10:00:00,2026/06/04 10:20:00,40`;
    expect(looksLikeVersaworksCsv(rasterlink)).toBe(false);
    expect(looksLikeRasterlinkCsv(rasterlink)).toBe(true);
    expect(looksLikeRasterlinkCsv(fullCsv)).toBe(false);
  });

  it("rejects malformed, blank, and unknown files", () => {
    expect(looksLikeVersaworksCsv("")).toBe(false);
    expect(looksLikeVersaworksCsv("just some text\nwith lines")).toBe(false);
    expect(looksLikeVersaworksCsv("colA,colB\n1,2")).toBe(false);
    expect(parseVersaworksRows("", "empty.csv")).toHaveLength(0);
    expect(parseVersaworksRows(`${FULL_HEADER}\n`, "header-only.csv")).toHaveLength(0);
  });
});

describe("parsing preserves legacy value semantics", () => {
  it("parses the full-format row: sqft from mm, ink split by channel name, print times, ticket", () => {
    const rows = parseVersaworksRows(fullCsv, "export.csv");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.event).toBe("Printed");
    expect(row.machineName).toBe("Roland LG-540");
    expect(row.jobName).toBe("GSO-55_Cust_Banner");
    expect(row.mediaName).toBe("GlossVinyl");
    expect(row.sqft).toBeCloseTo((254 / 25.4) * (254 / 25.4) / 144, 9); // 10in x 10in
    expect(row.cmykInkMl).toBeCloseTo(1.5, 9);
    expect(row.whiteInkMl).toBeCloseTo(2.5, 9);
    expect(row.glossInkMl).toBeCloseTo(3, 9);
    expect(row.inkMl).toBeCloseTo(7, 9);
    // Greedy legacy extraction preserved verbatim: full-chain tickets, exactly
    // what historical VersaWorks rows store (RasterLink's first-segment rule
    // applies only to watcher-renamed RasterLink files).
    expect(row.jobTicket).toBe("GSO-55-CUST-BANNER");
    expect(row.startedAt?.toISOString()).toBe(new Date("2026-06-04T10:00:00").toISOString());
    expect(row.timingBasis).toBe("print_times");
    expect(row.warnings).toHaveLength(0);
  });

  it("keeps the legacy RIP-time fallback for startedAt but labels and warns about it", () => {
    const csv = `${RIP_TIMES_HEADER}\nPrinted,Roland,GSO-9_x,Matte,1,Cyan,10,10,2026/06/04 09:00:00,2026/06/04 09:05:00`;
    const row = parseVersaworksRows(csv, "r.csv")[0];
    expect(row.startedAt).not.toBeNull(); // legacy semantics preserved
    expect(row.timingBasis).toBe("rip_times_fallback");
    expect(row.warnings).toContain("rip_times_fallback");
  });

  it("minimal-header rows still parse (zero ink/sqft, no times) with warnings", () => {
    const csv = `${MINIMAL_HEADER}\nPrinted,Roland,GSO-3_thing`;
    const row = parseVersaworksRows(csv, "m.csv")[0];
    expect(row.inkMl).toBe(0);
    expect(row.sqft).toBe(0);
    expect(row.timingBasis).toBe("no_times");
    expect(row.jobTicket).toBe("GSO-3-THING");
    expect(versaworksParseWarningCount([row])).toBe(1);
  });

  it("clear/primer ink names classify as gloss, matching the legacy splitter", () => {
    const csv = `${FULL_HEADER}\nPrinted,Roland,GSO-4_j,Matte,"1:2:4","Magenta:Primer:Clear",0,0,,`;
    const row = parseVersaworksRows(csv, "c.csv")[0];
    expect(row.cmykInkMl).toBeCloseTo(1, 9);
    expect(row.glossInkMl).toBeCloseTo(6, 9);
  });
});

describe("file and row dedupe", () => {
  it("same file content yields the same sha256 marker; different content differs", () => {
    expect(fileHashMarker(fullCsv)).toBe(fileHashMarker(fullCsv));
    expect(fileHashMarker(fullCsv)).not.toBe(fileHashMarker(`${fullCsv}\nextra`));
    expect(fileHashMarker(fullCsv).startsWith("sha256:")).toBe(true);
  });

  it("the same row in two different export files produces an identical natural key (no double counting)", () => {
    const a = parseVersaworksRows(fullCsv, "export-june.csv")[0];
    const b = parseVersaworksRows(fullCsv, "export-june-and-july.csv")[0];
    expect(versaworksRowDedupeWhere("shop1", a)).toEqual(versaworksRowDedupeWhere("shop1", b));
  });

  it("the key uses real fields, never position or import time: times, machine, and event distinguish rows", () => {
    const later = fullCsv.replace("10:00:00", "12:00:00");
    const otherMachine = fullCsv.replace("Roland LG-540", "Roland LG-640");
    const cancelled = fullCsv.replace("Printed", "Cancelled");
    const base = versaworksRowDedupeWhere("shop1", parseVersaworksRows(fullCsv, "a.csv")[0]);
    expect(versaworksRowDedupeWhere("shop1", parseVersaworksRows(later, "a.csv")[0])).not.toEqual(base);
    expect(versaworksRowDedupeWhere("shop1", parseVersaworksRows(otherMachine, "a.csv")[0])).not.toEqual(base);
    expect(versaworksRowDedupeWhere("shop1", parseVersaworksRows(cancelled, "a.csv")[0])).not.toEqual(base);
  });

  it("blank-time rows add inkMl and sqft to the key so different jobs are not conflated", () => {
    const blankA = parseVersaworksRows(`${FULL_HEADER}\nPrinted,R,GSO-7_j,M,"1","Cyan",0,0,,`, "a.csv")[0];
    const blankB = parseVersaworksRows(`${FULL_HEADER}\nPrinted,R,GSO-7_j,M,"9","Cyan",0,0,,`, "a.csv")[0];
    const whereA = versaworksRowDedupeWhere("shop1", blankA);
    expect(whereA.inkMl).toBeDefined();
    expect(whereA.sqft).toBeDefined();
    expect(whereA).not.toEqual(versaworksRowDedupeWhere("shop1", blankB));
  });

  it("cross-shop isolation: the key and therefore every lookup embeds the shop", () => {
    const row = parseVersaworksRows(fullCsv, "a.csv")[0];
    expect(versaworksRowDedupeWhere("shop-a", row).shop).toBe("shop-a");
    expect(versaworksRowDedupeWhere("shop-a", row)).not.toEqual(versaworksRowDedupeWhere("shop-b", row));
  });
});

describe("conservative matching decisions", () => {
  it("exactly one ticket candidate attaches with ticket_exact", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [{ id: "job1" }], ripNameJobIds: [] });
    expect(decision.productionJobId).toBe("job1");
    expect(decision.matchMethod).toBe("ticket_exact");
    expect(decision.matchFlag).toBeNull();
  });

  it("two+ ticket candidates never attach — flagged ambiguous with candidates listed", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [{ id: "job1" }, { id: "job2" }], ripNameJobIds: [] });
    expect(decision.productionJobId).toBeNull();
    expect(decision.matchFlag).toBe(VERSAWORKS_AMBIGUOUS_FLAG);
    expect(decision.candidateJobIds).toEqual(["job1", "job2"]);
    expect(decision.ticketCandidateCount).toBe(2);
  });

  it("with zero ticket candidates, exactly one exact RIP-name job attaches with rip_job_name_exact", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: ["job7"] });
    expect(decision.productionJobId).toBe("job7");
    expect(decision.matchMethod).toBe("rip_job_name_exact");
    expect(decision.ripNameCandidateCount).toBe(1);
  });

  it("multiple RIP-name jobs are ambiguous; zero everything is unmatched", () => {
    const ambiguous = decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: ["job7", "job8"] });
    expect(ambiguous.productionJobId).toBeNull();
    expect(ambiguous.matchFlag).toBe(VERSAWORKS_AMBIGUOUS_FLAG);
    const unmatched = decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: [] });
    expect(unmatched.productionJobId).toBeNull();
    expect(unmatched.matchFlag).toBeNull();
    expect(unmatched.candidateJobIds).toEqual([]);
  });

  it("RIP-name matching is exact-normalized equality — a contains-only overlap stays unmatched", () => {
    const items = [
      { jobId: "jobA", ripJobName: "GSO-55_Cust_Banner_REPRINT" }, // contains the name but is not equal
      { jobId: "jobB", ripJobName: "totally-different" },
    ];
    expect(ripNameJobIdsFor("GSO-55_Cust_Banner", items)).toEqual([]);
    // Exact (case/extension/punctuation-insensitive) equality does match:
    expect(ripNameJobIdsFor("GSO-55_Cust_Banner", [{ jobId: "jobC", ripJobName: "gso-55 cust banner.pdf" }])).toEqual(["jobC"]);
    expect(normalizeJobName("GSO-55_Cust_Banner")).toBe(normalizeJobName("gso-55 cust banner.pdf"));
  });

  it("short/blank names never match anything (guards against trivial keys)", () => {
    expect(ripNameJobIdsFor("", [{ jobId: "j", ripJobName: "" }])).toEqual([]);
    expect(ripNameJobIdsFor("ab", [{ jobId: "j", ripJobName: "ab" }])).toEqual([]);
  });

  it("counters aggregate correctly over a mixed batch (matched/ambiguous/unmatched)", () => {
    const decisions = [
      decideVersaworksMatch({ ticketCandidates: [{ id: "j1" }], ripNameJobIds: [] }),
      decideVersaworksMatch({ ticketCandidates: [{ id: "j1" }, { id: "j2" }], ripNameJobIds: [] }),
      decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: [] }),
      decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: ["j9"] }),
    ];
    const matched = decisions.filter((decision) => decision.productionJobId).length;
    const ambiguous = decisions.filter((decision) => decision.matchFlag).length;
    expect(matched).toBe(2);
    expect(ambiguous).toBe(1);
    expect(decisions.length - matched).toBe(2); // unmatched incl. ambiguous, matching the endpoint counter
  });
});

describe("rawRow metadata and source preservation", () => {
  const entry = parseVersaworksRows(fullCsv, "export.csv")[0];

  it("preserves every original CSV key and value untouched", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [{ id: "j1" }, { id: "j2" }], ripNameJobIds: [] });
    const raw = buildVersaworksRawRow(entry, decision);
    expect(raw["Job Name"]).toBe("GSO-55_Cust_Banner");
    expect(raw["Nick Name"]).toBe("Roland LG-540");
    expect(raw["Media Name"]).toBe("GlossVinyl");
    expect(raw["Ink Consumption[ml]"]).toBe("1.5:2.5:3");
    expect(raw["Print Start Time"]).toBe("2026/06/04 10:00:00");
    // and the parsed entry's own source values were never overwritten:
    expect(entry.jobTicket).toBe("GSO-55-CUST-BANNER");
    expect(entry.jobName).toBe("GSO-55_Cust_Banner");
  });

  it("ambiguous rows carry the shared top-level matchFlag plus matchMeta — and the 13A.6C review page classifies them", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [{ id: "j1" }, { id: "j2" }], ripNameJobIds: [] });
    const raw = buildVersaworksRawRow(entry, decision);
    expect(raw.matchFlag).toBe(VERSAWORKS_AMBIGUOUS_FLAG);
    const meta = raw.matchMeta as Record<string, unknown>;
    expect(meta.matchMethod).toBeNull();
    expect(meta.normalizedTicket).toBe("GSO-55-CUST-BANNER");
    expect(meta.normalizedJobName).toBe("gso-55-cust-banner");
    expect(meta.ticketCandidateCount).toBe(2);
    expect(meta.candidateJobIds).toEqual(["j1", "j2"]);
    const reviewStatus = classifyEntry({ productionJobId: null, rawRow: JSON.stringify(raw) });
    expect(reviewStatus).toBe("ambiguous");
  });

  it("clean unmatched rows have no matchFlag and classify as unmatched in review", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: [] });
    const raw = buildVersaworksRawRow(entry, decision);
    expect("matchFlag" in raw).toBe(false);
    expect(classifyEntry({ productionJobId: null, rawRow: JSON.stringify(raw) })).toBe("unmatched");
  });

  it("matched rows record the method and single candidate", () => {
    const decision = decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: ["j7"] });
    const raw = buildVersaworksRawRow(entry, decision);
    const meta = raw.matchMeta as Record<string, unknown>;
    expect(meta.matchMethod).toBe("rip_job_name_exact");
    expect(meta.ripNameCandidateCount).toBe(1);
    expect(raw.timingBasis).toBe("print_times");
    expect(meta.warnings).toEqual([]);
  });
});

describe("source constant", () => {
  it("hardened rows always store printerSoftware versaworks (deterministic dedupe key)", () => {
    expect(VERSAWORKS_SOURCE).toBe("versaworks");
  });

  it("ticket extraction matches the legacy endpoint pattern (greedy full chain)", () => {
    expect(extractVersaworksTicket("GSO-55_Cust_Banner")).toBe("GSO-55-CUST-BANNER");
    expect(extractVersaworksTicket("no ticket", "also none.csv")).toBe("");
  });
});
