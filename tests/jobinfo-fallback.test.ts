import { describe, expect, it } from "vitest";

import {
  INK_BASIS_JOBINFO_ARRANGED,
  INK_BASIS_JOBINFO_PER_ITEM,
  buildJobInfoEnrichment,
  decideJobInfoPairing,
  jobInfoEligibility,
  jobInfoFallbackEnabled,
  normalizeJobInfoName,
  parseInkUsedLine,
  parseJobInfoIni,
  safeJobInfoSourceId,
  type PairingCandidateRow,
} from "../app/lib/jobinfo-fallback.server";
import { INK_BASIS_ESTIMATE, INK_BASIS_MISSING } from "../app/lib/rasterlink-parse.server";

// The owner-validated conversion example from 13A.6A.
const VALID_INKUSED = "inkUsed=1;67,2;70,3;14,4;17";

function makeRow(overrides: Partial<PairingCandidateRow> & { rawOverrides?: Record<string, unknown> } = {}): PairingCandidateRow {
  const { rawOverrides, ...rest } = overrides;
  return {
    id: "row1",
    sourceJobName: "GSO-123_Cust_Jar_FRONT.pdf",
    startedAt: "2026-06-04T10:06:00.000Z",
    completedAt: "2026-06-04T10:26:00.000Z",
    rawRow: JSON.stringify({
      format: "rasterlink_print",
      arrangeCnt: 40,
      arrangeAssumed: false,
      inkBasis: INK_BASIS_MISSING,
      perItem: null,
      timingBasis: "print_times",
      ...rawOverrides,
    }),
    ...rest,
  };
}

const record = parseJobInfoIni(`[Job]\ninkUsed=1;67,2;70,3;14,4;17\nsomeKey=value`, "GSO-123_Cust_Jar_FRONT");

describe("inkUsed parsing (validated math)", () => {
  it("parses the confirmed four-channel example exactly: raw/1000, codes 1-4 = CMYK", () => {
    const ink = parseInkUsedLine(VALID_INKUSED);
    expect(ink.present).toBe(true);
    expect(ink.cyanCc).toBeCloseTo(0.067, 9);
    expect(ink.magentaCc).toBeCloseTo(0.07, 9);
    expect(ink.yellowCc).toBeCloseTo(0.014, 9);
    expect(ink.blackCc).toBeCloseTo(0.017, 9);
    expect(ink.perItemKnownCc).toBeCloseTo(0.168, 9);
    expect(ink.warnings).toHaveLength(0);
    expect(ink.unknownChannels).toHaveLength(0);
  });

  it("flags malformed pairs without inventing values", () => {
    const ink = parseInkUsedLine("inkUsed=1;67,garbage,2;,;9,3;14");
    expect(ink.cyanCc).toBeCloseTo(0.067, 9);
    expect(ink.yellowCc).toBeCloseTo(0.014, 9);
    expect(ink.magentaCc).toBe(0); // "2;" has no value — never zero-guessed into a reading
    expect(ink.warnings.filter((warning) => warning.startsWith("malformed_pair:"))).toHaveLength(3);
    expect(parseInkUsedLine("").present).toBe(false);
    expect(parseInkUsedLine("inkUsed=").present).toBe(false);
  });

  it("preserves unknown channel codes verbatim with a warning — never totaled, never guessed", () => {
    const ink = parseInkUsedLine("inkUsed=1;67,7;99");
    expect(ink.cyanCc).toBeCloseTo(0.067, 9);
    expect(ink.unknownChannels).toEqual([{ code: 7, raw: 99, cc: 0.099 }]);
    expect(ink.warnings).toContain("unknown_channel:7");
    expect(ink.perItemKnownCc).toBeCloseTo(0.067, 9); // unknown channel excluded from the known total
  });
});

describe("JobInfo.ini parsing and safe identifiers", () => {
  it("extracts inkUsed and bounded raw keys from an ini body", () => {
    expect(record.ink.present).toBe(true);
    expect(record.ink.perItemKnownCc).toBeCloseTo(0.168, 9);
    expect(record.rawKeys.someKey).toBe("value");
    expect(record.jobName).toBe("GSO-123_Cust_Jar_FRONT");
  });

  it("a full local path passed by mistake is reduced to its final segment — paths never leak", () => {
    expect(safeJobInfoSourceId("C:\\MijCtrl\\Jobs\\GSO-123_Cust")).toBe("GSO-123_Cust");
    expect(safeJobInfoSourceId("/mnt/jobs/GSO-9/")).toBe("GSO-9");
  });

  it("missing inkUsed line is reported, not guessed", () => {
    const empty = parseJobInfoIni("otherKey=1\n", "GSO-5_x");
    expect(empty.ink.present).toBe(false);
    expect(empty.warnings).toContain("no_inkused_line");
  });
});

describe("eligibility: valid CSV ink is never overridden", () => {
  it("rows with valid CSV ink are refused", () => {
    const valid = makeRow({ rawOverrides: { inkBasis: INK_BASIS_ESTIMATE } });
    expect(jobInfoEligibility(valid)).toEqual({ eligible: false, reason: "csv_ink_present_never_overridden" });
    expect(buildJobInfoEnrichment(valid, record).ok).toBe(false);
  });

  it("blank-ink rows with timestamps are eligible", () => {
    expect(jobInfoEligibility(makeRow()).eligible).toBe(true);
  });

  it("blank-time rows are refused — their dedupe key includes inkMl (idempotency protection)", () => {
    const blankTime = makeRow({ startedAt: null, completedAt: null });
    expect(jobInfoEligibility(blankTime)).toEqual({ eligible: false, reason: "blank_time_dedupe_protection" });
  });

  it("already-enriched and unparseable rows are refused (restart-safe)", () => {
    const enriched = makeRow({ rawOverrides: { jobInfoFallback: { version: "13A.6E" } } });
    expect(jobInfoEligibility(enriched).reason).toBe("already_enriched");
    expect(jobInfoEligibility(makeRow({ rawRow: "not json" })).reason).toBe("unparseable_rawrow");
  });
});

describe("deterministic pairing", () => {
  it("exactly one eligible name-equal row pairs (extension/case/punctuation-insensitive exact equality)", () => {
    const pairing = decideJobInfoPairing(record, [makeRow(), makeRow({ id: "other", sourceJobName: "different.pdf" })]);
    expect(pairing.outcome).toBe("paired");
    expect(pairing.row?.id).toBe("row1");
    expect(normalizeJobInfoName("GSO-123_Cust_Jar_FRONT")).toBe(normalizeJobInfoName("gso-123 cust jar front.pdf"));
  });

  it("zero matches keeps the row missing", () => {
    const pairing = decideJobInfoPairing(record, [makeRow({ sourceJobName: "unrelated.pdf" })]);
    expect(pairing.outcome).toBe("no_candidates");
    expect(pairing.row).toBeNull();
  });

  it("multiple eligible matches are ambiguous — never first-match-wins, never nearest-date", () => {
    const pairing = decideJobInfoPairing(record, [makeRow({ id: "a" }), makeRow({ id: "b" })]);
    expect(pairing.outcome).toBe("ambiguous");
    expect(pairing.row).toBeNull();
    expect(pairing.candidateRowIds).toEqual(["a", "b"]);
  });

  it("ineligible name-equal rows are reported but never paired; short names never match", () => {
    const validCsv = makeRow({ rawOverrides: { inkBasis: INK_BASIS_ESTIMATE } });
    const pairing = decideJobInfoPairing(record, [validCsv]);
    expect(pairing.outcome).toBe("no_candidates");
    expect(pairing.ineligible).toEqual([{ rowId: "row1", reason: "csv_ink_present_never_overridden" }]);
    const shortRecord = parseJobInfoIni("inkUsed=1;67\n", "ab");
    expect(decideJobInfoPairing(shortRecord, [makeRow({ sourceJobName: "ab.pdf" })]).outcome).toBe("no_candidates");
  });
});

describe("enrichment: per-item vs arranged estimate, provenance, immutability", () => {
  it("known arrange count: per-item x count = arranged ESTIMATE (0.168 x 40 = 6.72), never labeled measured", () => {
    const result = buildJobInfoEnrichment(makeRow(), record, new Date("2026-07-18T00:00:00Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.inkMl).toBeCloseTo(6.72, 9);
    expect(result.update.cmykInkMl).toBeCloseTo(6.72, 9);
    expect(result.update.whiteInkMl).toBe(0);
    expect(result.inkBasis).toBe(INK_BASIS_JOBINFO_ARRANGED);
    expect(Object.keys(result.update).sort()).toEqual(["cmykInkMl", "glossInkMl", "inkMl", "rawRow", "whiteInkMl"]);
    const raw = JSON.parse(result.update.rawRow);
    expect(raw.inkBasis).toBe(INK_BASIS_JOBINFO_ARRANGED);
    expect(raw.jobInfoFallback.estimate).toBe(true);
    expect(raw.jobInfoFallback.estimatedTotalCc).toBeCloseTo(6.72, 9);
    expect(raw.jobInfoFallback.perItemTotalCc).toBeCloseTo(0.168, 9);
    expect(raw.jobInfoFallback.perChannelCc).toEqual({ cyan: 0.067, magenta: 0.07, yellow: 0.014, black: 0.017 });
    expect(raw.jobInfoFallback.arrangeCnt).toBe(40);
    expect(raw.jobInfoFallback.originalInkBasis).toBe(INK_BASIS_MISSING);
    expect(raw.jobInfoFallback.inkUsedRaw).toBe(VALID_INKUSED);
    expect(raw.jobInfoFallback.sourceId).toBe("GSO-123_Cust_Jar_FRONT");
    expect(raw.jobInfoFallback.appliedAt).toBe("2026-07-18T00:00:00.000Z");
    expect(raw.jobInfoFallback.version).toBe("13A.6E");
    // original parser keys preserved untouched:
    expect(raw.format).toBe("rasterlink_print");
    expect(raw.timingBasis).toBe("print_times");
    expect(raw.arrangeCnt).toBe(40);
  });

  it("unknown arrange count: per-item value only, distinct basis, warned", () => {
    const row = makeRow({ rawOverrides: { arrangeCnt: null, arrangeAssumed: true } });
    const result = buildJobInfoEnrichment(row, record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.inkMl).toBeCloseTo(0.168, 9);
    expect(result.inkBasis).toBe(INK_BASIS_JOBINFO_PER_ITEM);
    expect(JSON.parse(result.update.rawRow).jobInfoFallback.warnings).toContain("arrange_unknown_per_item_only");
  });

  it("re-applying to an enriched row is refused (restart/dedupe-safe idempotency)", () => {
    const first = buildJobInfoEnrichment(makeRow(), record);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const enrichedRow = makeRow({ rawRow: first.update.rawRow });
    const second = buildJobInfoEnrichment(enrichedRow, record);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_enriched");
  });

  it("a JobInfo record without usable inkUsed enriches nothing", () => {
    const noInk = parseJobInfoIni("otherKey=1\n", "GSO-123_Cust_Jar_FRONT");
    const result = buildJobInfoEnrichment(makeRow(), noInk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jobinfo_has_no_usable_inkused");
  });

  it("unknown channels are excluded from totals and warned in provenance", () => {
    const withUnknown = parseJobInfoIni("inkUsed=1;67,7;99\n", "GSO-123_Cust_Jar_FRONT");
    const result = buildJobInfoEnrichment(makeRow(), withUnknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.inkMl).toBeCloseTo(0.067 * 40, 9);
    const provenance = JSON.parse(result.update.rawRow).jobInfoFallback;
    expect(provenance.unknownChannels).toEqual([{ code: 7, raw: 99, cc: 0.099 }]);
    expect(provenance.warnings).toContain("unknown_channels_excluded_from_totals");
  });
});

describe("feature flag", () => {
  it("defaults off; enables only on the exact value 1", () => {
    expect(jobInfoFallbackEnabled({})).toBe(false);
    expect(jobInfoFallbackEnabled({ GSO_ENABLE_JOBINFO_FALLBACK: "0" })).toBe(false);
    expect(jobInfoFallbackEnabled({ GSO_ENABLE_JOBINFO_FALLBACK: "true" })).toBe(false);
    expect(jobInfoFallbackEnabled({ GSO_ENABLE_JOBINFO_FALLBACK: "1" })).toBe(true);
  });
});
