// 15F.0J.4 — RIP capture widening + Roland actuals pipeline. Sample rows use
// the REAL VersaWorks all-time job-log format verified in the forensics.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildRipCalibrationCandidate,
  classifyVersaWorksEvent,
  extractMimakiExtended,
  isVersaWorksJobLogRow,
  matchMethodAllowsActuals,
  normalizeRipJobName,
  parseVersaWorksRow,
  runtimeQualityFlags,
  sourceRecordFingerprint,
  MIMAKI_CONVERTER_CONTRACT,
} from "../app/lib/rip-capture.server";
import {
  buildVersaworksRawRow,
  decideVersaworksMatch,
  parseVersaworksRows,
  versaworksRowDedupeWhere,
} from "../app/lib/versaworks-parse.server";
import { parsePrintLogText } from "../app/lib/print-logs.server";
import { entryWarnings } from "../app/lib/rip-import-review.server";

const VW_HEADER = "Event,Nick Name,Job Name,Size,Page Size_X[mm],Page Size_Y[mm],Media Name,Copy,Print Area_X[mm],Print Area_Y[mm],Ink Consumption[ml],Ink Name,Input Time,RIP Start Time,RIP End Time,Print Start Time,Print End Time,Details";
const VW_COMPLETED = 'Print End,LG-640,GSO-20260726-0042-01__ROLAND__GLOSS-3X__Flame-Society__Cherry.pdf,170591571,231.9,94.89,Generic Sign Production,3,1018.35,94.89,0.324:0.363:0.053:0.130:1.391,Yellow:Magenta:Black:Cyan:White,,2026/07/24 17:56:46,2026/07/24 17:57:32,2026/07/24 17:56:46,2026/07/24 18:12:39,';
const VW_CANCELED = 'Print Canceled,LG-640,Flame Society_cherry_matte_Roland.pdf - Copy,170591571,231.9,94.89,Special Effects,3,1018.35,94.89,0.000:0.000:0.000:0.000:5.812,Yellow:Magenta:Black:Cyan:Gloss,,2026/07/24 19:18:01,2026/07/24 19:18:45,2026/07/24 19:18:01,2026/07/24 19:32:37,';

function rowOf(csvLine: string): Record<string, string> {
  const headers = VW_HEADER.split(",");
  const cells = csvLine.split(",");
  const row: Record<string, string> = {};
  headers.forEach((header, index) => { row[header] = cells[index] || ""; });
  return row;
}

describe("VersaWorks parsing (15F.0J.4-E)", () => {
  it("test 1: ink arrays map BY NAME — order changes never mis-assign channels", () => {
    const orderA = parseVersaWorksRow(rowOf(VW_COMPLETED)); // Yellow:Magenta:Black:Cyan:White
    expect(orderA.cmykMl).toBeCloseTo(0.324 + 0.363 + 0.053 + 0.13, 6);
    expect(orderA.whiteMl).toBeCloseTo(1.391, 6);
    const swapped = rowOf(VW_COMPLETED);
    swapped["Ink Name"] = "White:Cyan:Black:Magenta:Yellow"; // same values, different order
    const orderB = parseVersaWorksRow(swapped);
    expect(orderB.whiteMl).toBeCloseTo(0.324, 6); // first value now white
    expect(orderB.cmykMl).toBeCloseTo(0.363 + 0.053 + 0.13 + 1.391, 6);
  });

  it("tests 2/3: two white channels and two gloss channels SUM (never dropped)", () => {
    const dual = rowOf(VW_COMPLETED);
    dual["Ink Name"] = "Cyan:White:White:Gloss:Gloss";
    dual["Ink Consumption[ml]"] = "1.0:0.416:0.417:0.2:0.3";
    const parsed = parseVersaWorksRow(dual);
    expect(parsed.whiteMl).toBeCloseTo(0.833, 6);
    expect(parsed.glossMl).toBeCloseTo(0.5, 6);
    expect(parsed.inkByChannel.white).toBeCloseTo(0.833, 6);
  });

  it("dims normalize mm->in; layout sqft = output area; elapsed print seconds computed (midnight-safe)", () => {
    const parsed = parseVersaWorksRow(rowOf(VW_COMPLETED));
    expect(parsed.outputWidthIn).toBeCloseTo(1018.35 / 25.4, 4);
    expect(parsed.outputFeedIn).toBeCloseTo(94.89 / 25.4, 4);
    expect(parsed.layoutSqft).toBeCloseTo((1018.35 / 25.4) * (94.89 / 25.4) / 144, 6);
    expect(parsed.printSeconds).toBe(953); // 17:56:46 -> 18:12:39
    expect(parsed.copies).toBe(3);
    expect(classifyVersaWorksEvent("Print Canceled")).toBe("canceled");
    expect(classifyVersaWorksEvent("New Job(Queue A)")).toBe("queue");
  });

  it("test 4: exact system ticket parses from the routed RIP name", () => {
    const parsed = parseVersaWorksRow(rowOf(VW_COMPLETED));
    expect(parsed.jobTicket).toBe("GSO-20260726-0042-01");
    expect(parsed.itemTicket).toBe("GSO-20260726-0042-01");
    expect(isVersaWorksJobLogRow(rowOf(VW_COMPLETED))).toBe(true);
  });

  it("test 5/6: match ladder — exact methods allow actuals; PROBABLE stays review-only", () => {
    expect(matchMethodAllowsActuals("EXACT_TICKET")).toBe(true);
    expect(matchMethodAllowsActuals("EXACT_NORMALIZED_FILENAME")).toBe(true);
    expect(matchMethodAllowsActuals("MANUAL")).toBe(true);
    expect(matchMethodAllowsActuals("PROBABLE_METADATA")).toBe(false);
    expect(matchMethodAllowsActuals("UNMATCHED")).toBe(false);
    // decideVersaworksMatch stays exact-only (two candidates = ambiguous)
    const ambiguous = decideVersaworksMatch({ ticketCandidates: [{ id: "a" }, { id: "b" }], ripNameJobIds: [] });
    expect(ambiguous.productionJobId).toBeNull();
  });

  it("tests 7/8: fingerprint dedupe — same event identical across regenerated exports; new events differ; row position irrelevant", () => {
    const first = parseVersaWorksRow(rowOf(VW_COMPLETED));
    const again = parseVersaWorksRow(rowOf(VW_COMPLETED));
    expect(sourceRecordFingerprint(first)).toBe(sourceRecordFingerprint(again)); // cumulative export -> zero duplicates
    const newer = rowOf(VW_COMPLETED);
    newer["Print End Time"] = "2026/07/24 18:20:00"; // a different event
    expect(sourceRecordFingerprint(parseVersaWorksRow(newer))).not.toBe(sourceRecordFingerprint(first));
    // active upload path: natural-key dedupe where-clause keys on source fields
    const [entry] = parseVersaworksRows(`${VW_HEADER}\n${VW_COMPLETED}`, "log.csv");
    const where = versaworksRowDedupeWhere("shop", entry);
    expect(where.sourceJobName).toBe(entry.jobName);
    expect(where.startedAt).toEqual(entry.startedAt);
  });

  it("tests 9/10: canceled never calibration/actual-eligible but is retained; error retained for audit", () => {
    const canceled = parseVersaWorksRow(rowOf(VW_CANCELED));
    expect(canceled.eventClass).toBe("canceled");
    const quality = runtimeQualityFlags(canceled);
    expect(quality.calibrationEligible).toBe(false);
    expect(quality.actualCostEligible).toBe(false);
    expect(quality.flags).toContain("canceled");
    const errored = runtimeQualityFlags({ ...canceled, eventClass: "error" });
    expect(errored.actualCostEligible).toBe(false);
    expect(errored.flags).toContain("failed");
  });

  it("tests 11/14/15: duplicate completion + possible-idle excluded from CALIBRATION while completed stages stay occupancy-eligible", () => {
    const completed = parseVersaWorksRow(rowOf(VW_COMPLETED));
    const dupe = runtimeQualityFlags(completed, { duplicateCompletion: true });
    expect(dupe.calibrationEligible).toBe(false);
    expect(dupe.actualCostEligible).toBe(false); // duplicate never double-counts cost either
    const idle = runtimeQualityFlags({ ...completed, printSeconds: 3.8 * 3600 }); // 2.17 sqft over 3.8h -> idle
    expect(idle.flags).toContain("possible_idle");
    expect(idle.calibrationEligible).toBe(false);
    expect(idle.actualCostEligible).toBe(true); // occupancy cost still counts
    const clean = runtimeQualityFlags({ ...completed, printSeconds: 953 });
    expect(clean.actualCostEligible).toBe(true);
  });

  it("test 12: combined vs isolated stages carry distinct fingerprints and event identities (no double count)", () => {
    const cmykWhite = parseVersaWorksRow(rowOf(VW_COMPLETED)); // CMYK+White stage
    const glossStage = parseVersaWorksRow(rowOf(VW_CANCELED)); // separate gloss stage row
    expect(sourceRecordFingerprint(cmykWhite)).not.toBe(sourceRecordFingerprint(glossStage));
    expect(normalizeRipJobName("Flame Society_cherry_matte_Roland.pdf - Copy")).toBe("Flame Society_cherry_matte_Roland.pdf"); // stage variants share identity for grouping
  });

  it("test 13: an intentional reprint (same job, later run) fingerprints separately — attached by ticket, never merged", () => {
    const original = parseVersaWorksRow(rowOf(VW_COMPLETED));
    const reprint = rowOf(VW_COMPLETED);
    reprint["Print Start Time"] = "2026/07/25 09:00:00";
    reprint["Print End Time"] = "2026/07/25 09:16:00";
    const reprintParsed = parseVersaWorksRow(reprint);
    expect(reprintParsed.jobTicket).toBe(original.jobTicket); // same GSO ticket
    expect(sourceRecordFingerprint(reprintParsed)).not.toBe(sourceRecordFingerprint(original)); // own attempt identity
  });

  it("calibration candidate (K): factors computed, never auto-applied", () => {
    const completed = parseVersaWorksRow(rowOf(VW_COMPLETED));
    const quality = runtimeQualityFlags(completed);
    const candidate = buildRipCalibrationCandidate({
      ticket: completed.jobTicket, printer: completed.printer, profile: completed.profile,
      stage: "combined", layoutSqft: completed.layoutSqft,
      estimatedSeconds: 500, actualSeconds: completed.printSeconds,
      estimatedMl: 1.5, actualMl: completed.totalMl, quality,
    });
    expect(candidate.runtimeFactor).toBeCloseTo(953 / 500, 6);
    expect(candidate.inkFactor).toBeCloseTo(completed.totalMl / 1.5, 6);
    expect(candidate.calibrationEligible).toBe(quality.calibrationEligible);
    expect(candidate.version).toBe("15F.0J.4-rip-capture");
  });
});

describe("import + review integration (15F.0J.4)", () => {
  it("tests 16/19: legacy parsePrintLogText compatibility — old alias CSVs parse identically; VersaWorks rows widen; raw preserved", () => {
    const legacy = parsePrintLogText("Job Name,Printer,Ink,Minutes\nGSO-20260101-0001 job,Mimaki,12.5,30");
    expect(legacy).toHaveLength(1);
    expect(legacy[0].jobTicket).toBe("GSO-20260101-0001");
    expect(legacy[0].inkMl).toBe(12.5);
    expect(legacy[0].sourceFingerprint).toBeNull(); // legacy rows unchanged
    const versa = parsePrintLogText(`${VW_HEADER}\n${VW_COMPLETED}`);
    expect(versa[0].sourceFingerprint).toBeTruthy();
    expect(versa[0].printMinutes).toBeCloseTo(953 / 60, 4);
    const raw = JSON.parse(versa[0].rawRow);
    expect(raw["Ink Consumption[ml]"]).toBe("0.324:0.363:0.053:0.130:1.391"); // raw source verbatim
    expect(raw._gso.qualityFlags).toBeDefined();
  });

  it("tests 17/18: Mimaki old CSVs byte-compatible; widened columns captured + dual channels summed when present", () => {
    const old = parsePrintLogText("Job,Media,White,Clear,Minutes\nGSO-20260102-0002 run,Vinyl,2.5,1.1,12");
    expect(old[0].whiteInkMl).toBe(2.5);
    expect(JSON.parse(old[0].rawRow)._gso).toBeUndefined(); // no widened columns -> unchanged shape
    const widened = parsePrintLogText("Job,Media,Minutes,White 1,White 2,Clear 1,Clear 2,Pass Count,Copies,Scan Width,Feed Length,Cut Time\nGSO-20260103-0003 run,Vinyl,20,0.416,0.417,0.2,0.3,32,69,48.955,6.385,21:26");
    const gso = JSON.parse(widened[0].rawRow)._gso;
    expect(gso.whiteSummedMl).toBeCloseTo(0.833, 6);
    expect(gso.clearSummedMl).toBeCloseTo(0.5, 6);
    expect(gso.passCount).toBe(32);
    expect(gso.copies).toBe(69);
    expect(gso.cutSeconds).toBe(21 * 60 + 26);
    expect(widened[0].whiteInkMl).toBeCloseTo(0.833, 6); // summed into normalized totals
    expect(MIMAKI_CONVERTER_CONTRACT.widenedColumns.length).toBeGreaterThan(10);
  });

  it("review surfaces quality flags, eligibility split, canceled audit, and PROBABLE warnings from _gso", () => {
    const [entry] = parseVersaworksRows(`${VW_HEADER}\n${VW_CANCELED}`, "log.csv");
    const rawRow = JSON.stringify(buildVersaworksRawRow(entry, decideVersaworksMatch({ ticketCandidates: [], ripNameJobIds: [] })));
    const warnings = entryWarnings({ jobTicket: null, productionJobId: null, rawRow });
    expect(warnings.join(" ")).toContain("CANCELED event");
    expect(warnings.join(" ")).toContain("Quality flags:");
  });

  it("15F.0J.4A: intake agent is a NON-RECURSIVE inbox — root-only scan; routing/dedupe/archive unchanged", () => {
    const agent = readFileSync(new URL("../tools/gso-print-intake-agent.ps1", import.meta.url), "utf8");
    expect(agent).toContain("Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue");
    // the eligible-files scan never recurses (self-test recursion for claim checks is separate)
    expect(agent).not.toContain("Get-ChildItem -Path $Config.PrintsForTodayFolder -File -Recurse");
    expect(agent).toContain("NON-RECURSIVE inbox");
    expect(agent).toContain("gso-print-intake-agent/1.7"); // 15H.3 version bump // 15F.0J.5 supersedes 1.4; non-recursive scan retained below
    // unchanged behaviors: content-ledger dedupe, archive move, routing plan call
    expect(agent).toContain("ledger_skip");
    expect(agent).toContain("original_archived");
    expect(agent).toContain("Get-RoutePlan $Config $File.Name $subfolder");
  });

  it("test 20: no pricing output changes — calculator modules are untouched by capture code", () => {
    const src = readFileSync(new URL("../app/lib/rip-capture.server.ts", import.meta.url), "utf8");
    expect(src).not.toContain("commercial-pricing-policy");
    expect(src).not.toContain("computeCommercialPrice");
    expect(src).not.toContain("marginMath");
  });
});
