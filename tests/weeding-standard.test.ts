// 2026-10-05 — ONE weeding standard object, ZERO pricing change, and a
// benchmark helper that can never write to production.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { WEEDING_STANDARD, WEEDING_COST_PER_REFERENCE_PAGE, WEEDING_LABOR_RATE_PER_HOUR, WEEDING_PAGES_PER_HOUR, WEEDING_REFERENCE_PAGE_IN } from "../app/lib/weeding-standard";
import * as finishing from "../app/lib/finishing-cost.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { analyzeWeedingSample, parseWeedingSamplesCsv, summarizeWeedingBenchmark } from "../app/lib/weeding-benchmark";

describe("WEEDING_STANDARD is initialised to the exact current behaviour", () => {
  it("$20/hr at 15 pages/hr, 54 x 54 in page, ceil per physical run then sum", () => {
    expect(WEEDING_STANDARD.laborRatePerHour).toBe(20);
    expect(WEEDING_STANDARD.pagesPerHour).toBe(15);
    expect(WEEDING_STANDARD.costPerPage).toBeCloseTo(20 / 15, 12);
    expect(WEEDING_STANDARD.pageLengthIn).toBe(54);
    expect(WEEDING_STANDARD.pageWidthIn).toBe(54);
    expect(WEEDING_STANDARD.rounding).toBe("ceil_per_physical_run_then_sum");
    expect(WEEDING_STANDARD.status).toBe("owner_verified");
    expect(WEEDING_STANDARD.notes.join(" ")).toMatch(/PENDING: owner timing measurements/);
  });

  it("the finishing engine reads the SAME values (re-exported, not copied)", () => {
    expect(finishing.WEEDING_LABOR_RATE_PER_HOUR).toBe(20);
    expect(finishing.WEEDING_PAGES_PER_HOUR).toBe(15);
    expect(finishing.WEEDING_COST_PER_REFERENCE_PAGE).toBeCloseTo(1.3333333333, 9);
    expect(finishing.WEEDING_REFERENCE_PAGE_IN).toBe(54);
    expect(finishing.WEEDING_STANDARD).toBe(WEEDING_STANDARD);
    expect(WEEDING_COST_PER_REFERENCE_PAGE).toBe(WEEDING_STANDARD.costPerPage);
    expect(WEEDING_LABOR_RATE_PER_HOUR).toBe(WEEDING_STANDARD.laborRatePerHour);
    expect(WEEDING_PAGES_PER_HOUR).toBe(WEEDING_STANDARD.pagesPerHour);
    expect(WEEDING_REFERENCE_PAGE_IN).toBe(WEEDING_STANDARD.pageLengthIn);
  });

  it("OWNER_STANDARDS.weedingPerPage54x54 is wired to the standard — $1.3333 unchanged", () => {
    expect(OWNER_STANDARDS.weedingPerPage54x54.value).toBe(WEEDING_STANDARD.costPerPage);
    expect(OWNER_STANDARDS.weedingPerPage54x54.value).toBeCloseTo(1.3333333333, 9);
    expect(OWNER_STANDARDS.weedingPerPage54x54.basis).toBe("$20/hour at 15 pages/hour");
    expect(OWNER_STANDARDS.weedingPerPage54x54.unit).toBe("$ per 54x54in weeding page");
  });

  it("no module still hard-codes its own weeding numbers", () => {
    const fin = readFileSync("app/lib/finishing-cost.server.ts", "utf8");
    expect(fin).not.toMatch(/WEEDING_LABOR_RATE_PER_HOUR = 20/);
    expect(fin).not.toMatch(/WEEDING_PAGES_PER_HOUR = 15/);
    expect(fin).toMatch(/from "\.\/weeding-standard"/);
    const owner = readFileSync("app/lib/owner-standards.ts", "utf8");
    expect(owner).toMatch(/WEEDING_STANDARD\.costPerPage/);
  });

  it("pinned outputs: pages and cost for representative runs (before == after)", () => {
    expect(finishing.weedingPagesForRun(0.1)).toBe(1);
    expect(finishing.weedingPagesForRun(54)).toBe(1);
    expect(finishing.weedingPagesForRun(54.01)).toBe(2);
    expect(finishing.weedingPagesForRun(108)).toBe(2);
    expect(finishing.weedingPagesForRun(300)).toBe(6);
    const two = finishing.computeWeeding([{ key: "a", feedLengthIn: 30 }, { key: "b", feedLengthIn: 30 }]);
    expect(two.totalPages).toBe(2); // rounded PER RUN, never combined (60/54 would be 2 anyway, 30+30 each ceil to 1)
    expect(two.cost).toBeCloseTo(2 * (20 / 15), 12);
    const one = finishing.computeWeeding([{ key: "a", feedLengthIn: 100 }]);
    expect(one.totalPages).toBe(2);
    expect(one.cost).toBeCloseTo(2.6666666667, 9);
    expect(finishing.computeWeeding([{ key: "a", feedLengthIn: 100 }], false).cost).toBe(0);
  });
});

describe("weeding benchmark helper (analysis only)", () => {
  it("3 pages in 12 minutes = 4 min/page, 15 pages/hr, $1.3333/page = exactly the current standard", () => {
    const s = analyzeWeedingSample({ id: "s1", pages: 3, pieces: 300, elapsedMinutes: 12, difficulty: "contour" });
    if ("rejected" in s) throw new Error(s.reason);
    expect(s.minutesPerPage).toBe(4);
    expect(s.pagesPerHour).toBe(15);
    expect(s.piecesPerMinute).toBe(25);
    expect(s.secondsPerPiece).toBe(2.4);
    expect(s.laborCostPerPage).toBeCloseTo(1.333333, 6);
    expect(s.laborCostPerPiece).toBeCloseTo(0.013333, 6);
    expect(s.vsCurrentStandardPct).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it("slower work shows as +% cost per page; faster as -%", () => {
    const slow = analyzeWeedingSample({ id: "slow", pages: 2, pieces: 100, elapsedMinutes: 16, difficulty: "complex_contour" });
    const fast = analyzeWeedingSample({ id: "fast", pages: 4, pieces: 100, elapsedMinutes: 8, difficulty: "simple_rect" });
    if ("rejected" in slow || "rejected" in fast) throw new Error("rejected");
    expect(slow.pagesPerHour).toBe(7.5);
    expect(slow.laborCostPerPage).toBeCloseTo(2.666667, 6);
    expect(slow.vsCurrentStandardPct).toBe(100);
    expect(fast.pagesPerHour).toBe(30);
    expect(fast.vsCurrentStandardPct).toBe(-50);
  });

  it("rejects impossible samples and warns on suspicious ones", () => {
    expect(analyzeWeedingSample({ id: "a", pages: 0, pieces: 1, elapsedMinutes: 5, difficulty: "mixed" })).toEqual({ rejected: true, reason: "pages must be > 0" });
    expect(analyzeWeedingSample({ id: "b", pages: 1, pieces: 1, elapsedMinutes: 0, difficulty: "mixed" })).toEqual({ rejected: true, reason: "elapsedMinutes must be > 0" });
    expect(analyzeWeedingSample({ id: "c", pages: 1, pieces: -1, elapsedMinutes: 5, difficulty: "mixed" })).toEqual({ rejected: true, reason: "pieces must be >= 0" });
    const tooFast = analyzeWeedingSample({ id: "d", pages: 10, pieces: 10, elapsedMinutes: 2, difficulty: "mixed" });
    if ("rejected" in tooFast) throw new Error("unexpected");
    expect(tooFast.warnings.join(" ")).toMatch(/very short sample/);
    expect(tooFast.warnings.join(" ")).toMatch(/more than 3x/);
  });

  it("summary aggregates by time-weighting, offers candidates, and NEVER mutates the standard", () => {
    const before = JSON.stringify(WEEDING_STANDARD);
    const summary = summarizeWeedingBenchmark([
      { id: "1", pages: 3, pieces: 300, elapsedMinutes: 12, difficulty: "contour" },
      { id: "2", pages: 2, pieces: 100, elapsedMinutes: 16, difficulty: "complex_contour" },
      { id: "bad", pages: 0, pieces: 0, elapsedMinutes: 1, difficulty: "mixed" },
    ]);
    expect(summary.rejected).toEqual([{ id: "bad", reason: "pages must be > 0" }]);
    expect(summary.aggregate).toMatchObject({ sampleCount: 2, totalPages: 5, totalPieces: 400, totalMinutes: 28 });
    expect(summary.aggregate!.weightedPagesPerHour).toBeCloseTo((5 / 28) * 60, 3);
    expect(summary.aggregate!.medianPagesPerHour).toBe(11.25);
    expect(summary.aggregate!.minPagesPerHour).toBe(7.5);
    expect(summary.aggregate!.maxPagesPerHour).toBe(15);
    expect(summary.aggregate!.byDifficulty.contour.weightedPagesPerHour).toBe(15);
    expect(summary.candidates.map((c) => c.label)).toEqual([
      "Time-weighted (all samples)", "Median of samples", "Conservative (slowest sample)", "Current standard (unchanged)",
    ]);
    expect(summary.candidates[3]).toMatchObject({ pagesPerHour: 15 });
    expect(JSON.stringify(WEEDING_STANDARD)).toBe(before);
    expect(OWNER_STANDARDS.weedingPerPage54x54.value).toBeCloseTo(20 / 15, 12);
  });

  it("empty input yields no aggregate and no candidates", () => {
    const s = summarizeWeedingBenchmark([]);
    expect(s.aggregate).toBeNull();
    expect(s.candidates).toEqual([]);
  });

  it("parses the owner CSV line format and reports bad lines", () => {
    const parsed = parseWeedingSamplesCsv("# id,pages,pieces,minutes,difficulty,notes\nrun1,3,300,12,contour,100ml side labels\nrun2,2,,16\n,1,1,1,mixed\nrun4,1,1,1,weird");
    expect(parsed.samples).toEqual([
      { id: "run1", pages: 3, pieces: 300, elapsedMinutes: 12, difficulty: "contour", notes: "100ml side labels" },
      { id: "run2", pages: 2, pieces: 0, elapsedMinutes: 16, difficulty: "mixed", notes: undefined },
    ]);
    expect(parsed.errors).toEqual(["line 3: missing id", "line 4: difficulty must be one of simple_rect|contour|complex_contour|specialty|mixed"]);
  });

  it("the benchmark module has no write path into the standard or the database", () => {
    const src = readFileSync("app/lib/weeding-benchmark.ts", "utf8");
    expect(src).not.toMatch(/writeFile|prisma|db\.|OWNER_STANDARDS|WEEDING_STANDARD\.\w+\s*=/);
  });
});
