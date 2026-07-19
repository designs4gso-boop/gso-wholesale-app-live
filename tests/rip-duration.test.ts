import { describe, expect, it } from "vitest";

import {
  MAX_PLAUSIBLE_PRINT_MINUTES,
  RIP_BACKFILL_PHRASE,
  appendRawRowBlock,
  attributeEntryToItem,
  derivePrintDurationFromRaw,
  resolvePrintDuration,
  type AttributionJob,
} from "../app/lib/rip-duration.server";
import { computePrintLogWriteback } from "../app/lib/print-log-writeback.server";
import { attributeMachine, type BrandInkRates } from "../app/lib/rip-actual-costs.server";
import type { VarianceEntryInput } from "../app/lib/actual-variance.server";

const RATES: BrandInkRates[] = [
  { brand: "roland", machineName: "Roland LG-640", cmykPerMl: 0.19867, whitePerMl: 0.19867, glossPerMl: 0.19867 },
  { brand: "mimaki", machineName: "Mimaki UCJV300", cmykPerMl: 0.176, whitePerMl: null, glossPerMl: null },
];

const VW_RAW = JSON.stringify({
  "Event": "Printed", "Nick Name": "Roland LG-640", "Job Name": "GSO-20260718-0001-01_Banner",
  "Print Start Time": "2026/07/18 10:00:00", "Print End Time": "2026/07/18 10:24:00",
  timingBasis: "print_times",
});

function makeVwEntry(overrides: Partial<VarianceEntryInput> = {}): VarianceEntryInput {
  return {
    id: "vw1", productionJobItemId: null, jobTicket: "GSO-20260718-0001-01",
    sourceJobName: "GSO-20260718-0001-01_Banner", printerSoftware: "versaworks", machineName: "Roland LG-640",
    mediaName: "Banner Vinyl", status: "Printed", sqft: 24, inkMl: 38, cmykInkMl: 38, whiteInkMl: 0, glossInkMl: 0,
    printMinutes: 0, // the 13A.7C problem: VersaWorks rows import with zero minutes
    startedAt: "2026-07-18T10:00:00.000Z", completedAt: "2026-07-18T10:24:00.000Z",
    rawRow: VW_RAW,
    ...overrides,
  };
}

const ITEM = { id: "i1", itemTicket: "GSO-20260718-0001-01", ripJobName: "GSO-20260718-0001-01", suggestedFileName: "GSO-20260718-0001-01_BANNER_QTY1", productTitle: "Banner" };

function makeJob(overrides: Partial<AttributionJob> = {}): AttributionJob {
  return { id: "job1", jobTicket: "GSO-20260718-0001", items: [ITEM], fileNames: [], ...overrides };
}

describe("duration precedence", () => {
  it("derives duration from exact print start/end stamps in the row's own raw fields (labeled derived)", () => {
    const resolved = resolvePrintDuration(makeVwEntry());
    expect(resolved.source).toBe("derived_print_timestamps");
    expect(resolved.minutes).toBeCloseTo(24, 6);
    expect(resolved.printStartRaw).toBe("2026/07/18 10:00:00");
    expect(resolved.printEndRaw).toBe("2026/07/18 10:24:00");
  });

  it("stored imported minutes act as the native slot when no print stamps exist", () => {
    const rasterlinkStyle = makeVwEntry({ printMinutes: 20, rawRow: JSON.stringify({ format: "rasterlink_print", timingBasis: "print_times" }) });
    const resolved = resolvePrintDuration(rasterlinkStyle);
    expect(resolved.source).toBe("imported_native");
    expect(resolved.minutes).toBe(20);
  });

  it("derived stamps take precedence over stored minutes and match them for RasterLink-era rows", () => {
    const both = makeVwEntry({ printMinutes: 24 });
    const resolved = resolvePrintDuration(both);
    expect(resolved.source).toBe("derived_print_timestamps");
    expect(resolved.minutes).toBeCloseTo(24, 6);
  });

  it("rejects end-not-after-start and zero intervals", () => {
    const backwards = makeVwEntry({ rawRow: JSON.stringify({ "Print Start Time": "2026/07/18 10:24:00", "Print End Time": "2026/07/18 10:00:00" }) });
    const resolvedBackwards = resolvePrintDuration(backwards);
    expect(resolvedBackwards.source).toBe("unknown");
    expect(resolvedBackwards.minutes).toBe(0);
    expect(resolvedBackwards.warnings.some((warning) => warning.includes("implausible interval"))).toBe(true);
    const zero = makeVwEntry({ rawRow: JSON.stringify({ "Print Start Time": "2026/07/18 10:00:00", "Print End Time": "2026/07/18 10:00:00" }) });
    expect(resolvePrintDuration(zero).minutes).toBe(0);
  });

  it("rejects implausibly long durations (over 24h) with a warning", () => {
    const marathon = makeVwEntry({ rawRow: JSON.stringify({ "Print Start Time": "2026/07/10 10:00:00", "Print End Time": "2026/07/18 10:00:00" }) });
    const resolved = resolvePrintDuration(marathon);
    expect(resolved.source).toBe("unknown");
    expect(resolved.minutes).toBe(0);
    expect(resolved.warnings.some((warning) => warning.includes(`${MAX_PLAUSIBLE_PRINT_MINUTES}`))).toBe(true);
  });

  it("RIP-fallback rows never derive (RIP time is not print time) and stay unknown with a warning", () => {
    const ripOnly = makeVwEntry({ rawRow: JSON.stringify({ "RIP Start Time": "2026/07/18 09:00:00", "RIP End Time": "2026/07/18 09:30:00", timingBasis: "rip_times_fallback" }) });
    const resolved = resolvePrintDuration(ripOnly);
    expect(resolved.source).toBe("unknown");
    expect(resolved.minutes).toBe(0);
    expect(resolved.warnings.some((warning) => warning.includes("No reliable print duration"))).toBe(true);
  });

  it("cut rows never carry print duration", () => {
    expect(resolvePrintDuration(makeVwEntry({ status: "cut:Complete" })).minutes).toBe(0);
  });

  it("derivePrintDurationFromRaw preserves the original raw stamp strings", () => {
    const derived = derivePrintDurationFromRaw(VW_RAW);
    expect(derived.printStartRaw).toBe("2026/07/18 10:00:00");
    expect(derived.printEndRaw).toBe("2026/07/18 10:24:00");
  });
});

describe("strict item attribution", () => {
  it("exact item ticket attributes exactly", () => {
    const attribution = attributeEntryToItem(makeVwEntry(), makeJob());
    expect(attribution.method).toBe("item_ticket");
    expect(attribution.productionJobItemId).toBe("i1");
    expect(attribution.confidence).toBe("exact");
  });

  it("exact RIP name attributes when the ticket is absent", () => {
    const entry = makeVwEntry({ jobTicket: "GSO-20260718-0001", sourceJobName: "gso-20260718-0001-01 banner qty1.pdf" });
    const job = makeJob({ items: [{ ...ITEM, itemTicket: "GSO-20260718-0001-99" }, { ...ITEM, id: "i2", itemTicket: "GSO-20260718-0001-98", ripJobName: "other", suggestedFileName: "other2" }] });
    const attribution = attributeEntryToItem(entry, job);
    expect(attribution.method).toBe("rip_name");
    expect(attribution.productionJobItemId).toBe("i1");
  });

  it("exact ProductionJobFile name reaches an item only on single-item jobs", () => {
    const entry = makeVwEntry({ jobTicket: "", sourceJobName: "customer artwork final.pdf" });
    const single = makeJob({ items: [{ ...ITEM, itemTicket: "X", ripJobName: "y", suggestedFileName: "z" }], fileNames: ["Customer Artwork FINAL.pdf"] });
    const attribution = attributeEntryToItem(entry, single);
    expect(attribution.method).toBe("job_file_single_item");
    expect(attribution.productionJobItemId).toBe("i1");
  });

  it("single-item fallback records its reason; multi-item job-ticket-only stays job-level", () => {
    const noSignal = makeVwEntry({ jobTicket: "GSO-20260718-0001", sourceJobName: "mystery.pdf" });
    const fallback = attributeEntryToItem(noSignal, makeJob());
    expect(fallback.method).toBe("single_item_fallback");
    expect(fallback.confidence).toBe("fallback");
    expect(fallback.warnings.some((warning) => warning.includes("fallback"))).toBe(true);

    const multi = makeJob({ items: [ITEM, { ...ITEM, id: "i2", itemTicket: "GSO-20260718-0001-02" }] });
    const jobLevel = attributeEntryToItem(noSignal, multi);
    expect(jobLevel.method).toBe("job_level_only");
    expect(jobLevel.productionJobItemId).toBeNull();
  });

  it("ambiguous candidates stay unresolved; no contains/fuzzy matching ever attaches", () => {
    const dupTickets = makeJob({ items: [ITEM, { ...ITEM, id: "i2" }] });
    const ambiguous = attributeEntryToItem(makeVwEntry(), dupTickets);
    expect(ambiguous.method).toBe("unresolved_multiple");
    expect(ambiguous.productionJobItemId).toBeNull();
    // "banner" is a PREFIX of the stored name, not equal — never attaches by name.
    const prefix = makeVwEntry({ jobTicket: "", sourceJobName: "banner.pdf" });
    const multi = makeJob({ items: [{ ...ITEM, itemTicket: "A", ripJobName: "banner-v2-final", suggestedFileName: "other" }, { ...ITEM, id: "i2", itemTicket: "B", ripJobName: "x", suggestedFileName: "y" }] });
    expect(attributeEntryToItem(prefix, multi).productionJobItemId).toBeNull();
  });

  it("an already-stored productionJobItemId is respected, never re-attributed", () => {
    const attribution = attributeEntryToItem(makeVwEntry({ productionJobItemId: "i1" }), makeJob());
    expect(attribution.productionJobItemId).toBe("i1");
    expect(attribution.confidence).toBe("exact");
  });
});

describe("writeback interaction (13A.7C)", () => {
  const job = { id: "job1", jobTicket: "GSO-20260718-0001", items: [{ id: "i1", itemTicket: "GSO-20260718-0001-01", productTitle: "Banner", quantity: 1, unitPrice: 100, unitCost: 40, costSnapshot: null }], actualCostFinalized: false };

  it("zero-minute VersaWorks rows with exact print stamps now produce machine cost; ink does not duplicate", () => {
    const result = computePrintLogWriteback({ job, entries: [makeVwEntry()], rates: RATES, machineRatePerHour: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printMinutes).toBeCloseTo(24, 6); // derived, was 0 before 13A.7C
    expect(result.machineCost).toBeCloseTo(3.2, 2); // 24/60 x 8
    expect(result.inkCost).toBeCloseTo(7.55, 2); // 38 x 0.19867 — unchanged by duration work
    expect(result.totalCost).toBeCloseTo(10.75, 2);
    expect(result.warnings.some((warning) => warning.includes("DERIVED"))).toBe(true);
  });

  it("reapply is idempotent and updates machine cost only through reliable duration; unknown-duration rows stay zero", () => {
    const first = computePrintLogWriteback({ job, entries: [makeVwEntry()], rates: RATES, machineRatePerHour: 8 });
    const second = computePrintLogWriteback({ job, entries: [makeVwEntry()], rates: RATES, machineRatePerHour: 8 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.totalCost).toBe(first.totalCost);

    const noStamps = makeVwEntry({ rawRow: JSON.stringify({ "RIP Start Time": "2026/07/18 09:00:00" }) });
    const unknownResult = computePrintLogWriteback({ job, entries: [noStamps], rates: RATES, machineRatePerHour: 8 });
    expect(unknownResult.ok).toBe(true);
    if (!unknownResult.ok) return;
    expect(unknownResult.machineCost).toBeNull(); // zero stays zero with warning — never guessed
    expect(unknownResult.warnings.some((warning) => warning.includes("never guessed"))).toBe(true);
    expect(unknownResult.inkCost).toBeCloseTo(7.55, 2); // ink still costed
  });

  it("finalized jobs remain blocked", () => {
    const result = computePrintLogWriteback({ job: { ...job, actualCostFinalized: true }, entries: [makeVwEntry()], rates: RATES, machineRatePerHour: 8 });
    expect(result.ok).toBe(false);
  });
});

describe("provenance and compatibility", () => {
  it("appendRawRowBlock adds only the named key and preserves unparseable text verbatim", () => {
    const appended = JSON.parse(appendRawRowBlock(VW_RAW, "durationBackfill", { minutes: 24 }));
    expect(appended["Print Start Time"]).toBe("2026/07/18 10:00:00");
    expect(appended.durationBackfill.minutes).toBe(24);
    const wrapped = JSON.parse(appendRawRowBlock("not json", "durationBackfill", { minutes: 1 }));
    expect(wrapped._originalRawRowText).toBe("not json");
    expect(wrapped._originalRawRowParseFailed).toBe(true);
  });

  it("the backfill phrase is exact and case-sensitive", () => {
    expect(RIP_BACKFILL_PHRASE).toBe("APPLY VERIFIED RIP BACKFILL");
  });

  it("historical LG-540 rows still classify as Roland; LG-640 is the current model", () => {
    expect(attributeMachine({ machineName: "Roland TrueVIS LG-540" })).toBe("roland");
    expect(attributeMachine({ machineName: "Roland LG-640" })).toBe("roland");
  });
});
