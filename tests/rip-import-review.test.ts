import { describe, expect, it } from "vitest";

import {
  AMBIGUOUS_MATCH_FLAG,
  appendRematchAudit,
  buildEntryUpdate,
  bulkEligibility,
  classifyEntries,
  classifyEntry,
  entryWarnings,
  filterEntries,
  makeAuditEntry,
  paginate,
  parseImportSummary,
  rankCandidates,
  scopedEntryWhere,
  scopedJobWhere,
  validateMutation,
  type CandidateJob,
  type ReviewEntryInput,
} from "../app/lib/rip-import-review.server";

function makeEntry(overrides: Partial<ReviewEntryInput> = {}): ReviewEntryInput {
  return {
    id: "entry1",
    importId: "import1",
    productionJobId: null,
    jobTicket: "GSO-123",
    sourceJobName: "GSO-123_Cust_Jar_FRONT_Matte_MIMAKI_R1.csv",
    printerSoftware: "rasterlink",
    machineName: "",
    mediaName: "",
    status: "print:Complete",
    inkMl: 6.72,
    printMinutes: 20,
    startedAt: "2026-06-04T10:06:00.000Z",
    completedAt: "2026-06-04T10:26:00.000Z",
    createdAt: "2026-06-05T00:00:00.000Z",
    rawRow: JSON.stringify({ format: "rasterlink_print", inkBasis: "rasterlink_rounded_per_item_estimate", timingBasis: "print_times" }),
    ...overrides,
  };
}

function makeJob(overrides: Partial<CandidateJob> = {}): CandidateJob {
  return { id: "job1", jobTicket: "GSO-123", customerName: "Cust", company: "Cust Co", status: "in_production", createdAt: "2026-06-01T00:00:00.000Z", ...overrides };
}

const ambiguousRaw = JSON.stringify({ format: "rasterlink_print", matchFlag: AMBIGUOUS_MATCH_FLAG });

describe("listing classification", () => {
  it("unmatched rows are listed as unmatched", () => {
    const classified = classifyEntries([makeEntry()]);
    expect(classified[0].reviewStatus).toBe("unmatched");
    expect(filterEntries(classified, { status: "unmatched", source: "all", q: "", warningsOnly: false })).toHaveLength(1);
  });

  it("ambiguous rows (rawRow matchFlag) are listed as ambiguous, not plain unmatched", () => {
    const classified = classifyEntries([makeEntry({ rawRow: ambiguousRaw })]);
    expect(classified[0].reviewStatus).toBe("ambiguous");
    expect(filterEntries(classified, { status: "ambiguous", source: "all", q: "", warningsOnly: false })).toHaveLength(1);
    expect(filterEntries(classified, { status: "unmatched", source: "all", q: "", warningsOnly: false })).toHaveLength(0);
    expect(classified[0].warnings.some((warning) => warning.includes("Two or more production jobs"))).toBe(true);
  });

  it("attached rows disappear from the default unresolved filter but appear in attached view", () => {
    const classified = classifyEntries([
      makeEntry({ id: "a", productionJobId: "job1" }),
      makeEntry({ id: "b" }),
      makeEntry({ id: "c", rawRow: ambiguousRaw }),
    ]);
    const unresolved = filterEntries(classified, { status: "unresolved", source: "all", q: "", warningsOnly: false });
    expect(unresolved.map((entry) => entry.id).sort()).toEqual(["b", "c"]);
    const attached = filterEntries(classified, { status: "attached", source: "all", q: "", warningsOnly: false });
    expect(attached.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("VersaWorks rows appear in the same list and are filterable by source", () => {
    const classified = classifyEntries([
      makeEntry({ id: "vw", printerSoftware: "versaworks", rawRow: JSON.stringify({ "Job Name": "GSO-9_banner", "RIP Start Time": "2026/06/04 10:00:00" }) }),
      makeEntry({ id: "rl" }),
    ]);
    const all = filterEntries(classified, { status: "unresolved", source: "all", q: "", warningsOnly: false });
    expect(all.map((entry) => entry.id).sort()).toEqual(["rl", "vw"]);
    const versaworks = filterEntries(classified, { status: "unresolved", source: "versaworks", q: "", warningsOnly: false });
    expect(versaworks.map((entry) => entry.id)).toEqual(["vw"]);
  });

  it("search and warnings-only filters narrow rows", () => {
    const classified = classifyEntries([
      makeEntry({ id: "warned", rawRow: JSON.stringify({ inkBasis: "missing_inkuse" }) }),
      makeEntry({ id: "clean", sourceJobName: "GSO-777_Bag_4x5.csv", jobTicket: "GSO-777" }),
    ]);
    expect(filterEntries(classified, { status: "unresolved", source: "all", q: "gso-777", warningsOnly: false }).map((entry) => entry.id)).toEqual(["clean"]);
    expect(filterEntries(classified, { status: "unresolved", source: "all", q: "", warningsOnly: true }).map((entry) => entry.id)).toEqual(["warned"]);
  });

  it("paginates with bounds", () => {
    const list = Array.from({ length: 120 }, (_value, index) => index);
    const page2 = paginate(list, 2, 50);
    expect(page2.pageItems[0]).toBe(50);
    expect(page2.pageCount).toBe(3);
    expect(paginate(list, 99, 50).page).toBe(3);
  });
});

describe("shop scoping", () => {
  it("entry and job lookups always embed the shop", () => {
    expect(scopedEntryWhere("shop-a.myshopify.com", "entry1")).toEqual({ id: "entry1", shop: "shop-a.myshopify.com" });
    expect(scopedJobWhere("shop-a.myshopify.com", "job1")).toEqual({ id: "job1", shop: "shop-a.myshopify.com" });
  });

  it("a cross-shop job ID (scoped lookup returns null) rejects the rematch", () => {
    const verdict = validateMutation({ intent: "rematch", entry: makeEntry(), job: null, expectedJobId: "", confirm: "yes" });
    expect(verdict.ok).toBe(false);
    expect((verdict as { error: string }).error).toContain("not found in this shop");
  });
});

describe("rematch and unmatch safety", () => {
  it("accepts an exact one-job rematch with confirmation", () => {
    const verdict = validateMutation({ intent: "rematch", entry: makeEntry(), job: makeJob(), expectedJobId: "", confirm: "yes" });
    expect(verdict).toEqual({ ok: true });
  });

  it("rejects a missing row and a stale row", () => {
    const missing = validateMutation({ intent: "rematch", entry: null, job: makeJob(), expectedJobId: "", confirm: "yes" });
    expect(missing.ok).toBe(false);
    // Stale: the operator saw an unattached row, but it is now attached.
    const stale = validateMutation({ intent: "rematch", entry: makeEntry({ productionJobId: "job9" }), job: makeJob(), expectedJobId: "", confirm: "yes" });
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toContain("stale");
  });

  it("rejects without the confirmation flag", () => {
    const verdict = validateMutation({ intent: "rematch", entry: makeEntry(), job: makeJob(), expectedJobId: "", confirm: "" });
    expect(verdict.ok).toBe(false);
  });

  it("unmatch requires an attached row and matching expected value", () => {
    const detach = validateMutation({ intent: "unmatch", entry: makeEntry({ productionJobId: "job1" }), job: null, expectedJobId: "job1", confirm: "yes" });
    expect(detach).toEqual({ ok: true });
    const notAttached = validateMutation({ intent: "unmatch", entry: makeEntry(), job: null, expectedJobId: "", confirm: "yes" });
    expect(notAttached.ok).toBe(false);
    const stale = validateMutation({ intent: "unmatch", entry: makeEntry({ productionJobId: "job2" }), job: null, expectedJobId: "job1", confirm: "yes" });
    expect(stale.ok).toBe(false);
  });

  it("the update payload contains ONLY productionJobId and rawRow — ink/timing untouched by construction", () => {
    const update = buildEntryUpdate(makeEntry(), "job1", "shop-a.myshopify.com");
    expect(Object.keys(update).sort()).toEqual(["productionJobId", "rawRow"]);
    expect(update.productionJobId).toBe("job1");
  });
});

describe("audit metadata", () => {
  it("appends rematch audit while preserving every original parser key", () => {
    const entry = makeEntry();
    const update = buildEntryUpdate(entry, "job1", "shop-a.myshopify.com", new Date("2026-07-18T00:00:00Z"));
    const parsed = JSON.parse(update.rawRow);
    expect(parsed.format).toBe("rasterlink_print");
    expect(parsed.inkBasis).toBe("rasterlink_rounded_per_item_estimate");
    expect(parsed.timingBasis).toBe("print_times");
    expect(parsed.rematchAudit).toHaveLength(1);
    expect(parsed.rematchAudit[0]).toEqual({
      action: "attach",
      previousProductionJobId: null,
      newProductionJobId: "job1",
      at: "2026-07-18T00:00:00.000Z",
      method: "manual_review",
      shop: "shop-a.myshopify.com",
      via: "rip-import-review",
    });
  });

  it("detach records previous and new IDs and stacks history", () => {
    const attachUpdate = buildEntryUpdate(makeEntry(), "job1", "shop-a.myshopify.com");
    const detachUpdate = buildEntryUpdate({ productionJobId: "job1", rawRow: attachUpdate.rawRow }, null, "shop-a.myshopify.com");
    const parsed = JSON.parse(detachUpdate.rawRow);
    expect(detachUpdate.productionJobId).toBeNull();
    expect(parsed.rematchAudit).toHaveLength(2);
    expect(parsed.rematchAudit[1].action).toBe("detach");
    expect(parsed.rematchAudit[1].previousProductionJobId).toBe("job1");
    expect(parsed.rematchAudit[1].newProductionJobId).toBeNull();
  });

  it("non-JSON rawRow is preserved verbatim in a wrapper, never discarded", () => {
    const audit = makeAuditEntry({ action: "attach", previousProductionJobId: null, newProductionJobId: "job1", shop: "s" });
    const result = JSON.parse(appendRematchAudit("Event,Job\ntruncated…", audit));
    expect(result._originalRawRowText).toBe("Event,Job\ntruncated…");
    expect(result._originalRawRowParseFailed).toBe(true);
    expect(result.rematchAudit).toHaveLength(1);
    expect(JSON.parse(appendRematchAudit(null, audit)).rematchAudit).toHaveLength(1);
  });

  it("audit history caps at 20 entries, dropping the oldest", () => {
    let rawRow: string | null = makeEntry().rawRow;
    for (let index = 0; index < 25; index += 1) {
      rawRow = appendRematchAudit(rawRow, makeAuditEntry({ action: "attach", previousProductionJobId: null, newProductionJobId: `job${index}`, shop: "s" }));
    }
    const parsed = JSON.parse(rawRow!);
    expect(parsed.rematchAudit).toHaveLength(20);
    expect(parsed.rematchAudit[19].newProductionJobId).toBe("job24");
    expect(parsed.rematchAudit[0].newProductionJobId).toBe("job5");
    expect(parsed.format).toBe("rasterlink_print"); // parser keys survive repeated appends
  });
});

describe("candidate suggestions", () => {
  it("ranks exact ticket first, then RIP job name, then name similarity — with labels", () => {
    const entry = makeEntry({ jobTicket: "GSO-123", sourceJobName: "GSO-123_Cust_Jar.csv" });
    const jobs = [
      makeJob({ id: "similar", jobTicket: "GSO-123-B" }), // not exact
      makeJob({ id: "exact", jobTicket: "gso-123" }),
      makeJob({ id: "ripname", jobTicket: "OTHER-1" }),
    ];
    // "similar" has ticket GSO-123-B which is NOT inside the source name; give it a similarity hook instead:
    const entrySimilar = makeEntry({ jobTicket: "", sourceJobName: "reprint GSO-123-B panel.csv" });
    const ranked = rankCandidates(entry, jobs, [{ jobId: "ripname", ripJobName: "GSO-123_Cust_Jar" }]);
    expect(ranked[0].job.id).toBe("exact");
    expect(ranked[0].confidence).toBe("exact_ticket");
    expect(ranked[1].job.id).toBe("ripname");
    expect(ranked[1].confidence).toBe("rip_job_name");

    const similarityOnly = rankCandidates(entrySimilar, [jobs[0]], []);
    expect(similarityOnly[0].confidence).toBe("name_similarity");
  });

  it("two exact hits are both listed (the ambiguous case) — ranking never picks silently", () => {
    const entry = makeEntry({ jobTicket: "GSO-123" });
    const ranked = rankCandidates(entry, [makeJob({ id: "j1" }), makeJob({ id: "j2" })], []);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((candidate) => candidate.confidence === "exact_ticket")).toBe(true);
  });

  it("no ticket and no similarity yields no suggestions", () => {
    const entry = makeEntry({ jobTicket: "", sourceJobName: "mystery-file.csv" });
    expect(rankCandidates(entry, [makeJob()], [])).toHaveLength(0);
  });
});

describe("bulk eligibility", () => {
  it("requires 2+ unresolved rows sharing one exact name or ticket", () => {
    const a = makeEntry({ id: "a" });
    const b = makeEntry({ id: "b" });
    expect(bulkEligibility([a, b]).eligible).toBe(true);
    expect(bulkEligibility([a]).eligible).toBe(false);
    expect(bulkEligibility([a, makeEntry({ id: "c", productionJobId: "job1" })]).eligible).toBe(false);
    const different = makeEntry({ id: "d", jobTicket: "GSO-999", sourceJobName: "other.csv" });
    expect(bulkEligibility([a, different]).eligible).toBe(false);
  });
});

describe("import summary safety", () => {
  it("returns only structured counters + short hash — never free text or tokens", () => {
    const notes = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\nrows:4 created:3 duplicatesSkipped:1 matched:2 ambiguous:1 parseWarnings:2 outcome:processed";
    const summary = parseImportSummary(notes);
    expect(summary.fileHashShort).toBe("abcdef01");
    expect(summary.outcome).toBe("processed");
    expect(summary.counters).toContainEqual({ label: "Rows", value: 4 });
    expect(summary.counters).toContainEqual({ label: "Parse warnings", value: 2 });
    expect(JSON.stringify(summary)).not.toContain("sha256:abcdef0123456789abcdef0123456789");
  });

  it("free-text operator notes produce an empty summary", () => {
    const summary = parseImportSummary("uploaded by Sam, token gso_plog_secret should never leak");
    expect(summary.fileHashShort).toBeNull();
    expect(summary.counters).toHaveLength(0);
    expect(JSON.stringify(summary)).not.toContain("gso_plog_secret");
  });
});

describe("warnings extraction", () => {
  it("surfaces missing ink, assumed arrange, RIP-only timing, and missing ticket", () => {
    const entry = makeEntry({
      jobTicket: "",
      rawRow: JSON.stringify({ inkBasis: "missing_inkuse", arrangeAssumed: true, timingBasis: "rip_only_no_print_times" }),
    });
    const warnings = entryWarnings(entry);
    expect(warnings.some((warning) => warning.includes("KEY_INKUSE"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("Arrange count"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("RIP times only"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("No GSO ticket"))).toBe(true);
    expect(classifyEntry(entry)).toBe("unmatched");
  });
});
