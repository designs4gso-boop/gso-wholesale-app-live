// 2026-11-11 — Mimaki White CALIBRATION EVIDENCE (read-only, no schema change).
//
// Owner decision: no Mimaki White rate is activated from history, because
// White mL / total layout sqft is not a normalized 100%-coverage calibration.
// This builder joins what the EXISTING architecture already keeps for a
// Mimaki print so future White jobs accumulate defensible evidence:
//
//   PrintLogEntry          sqft, whiteInkMl, printMinutes, mediaName (profile),
//                          completedAt, jobTicket / sourceJobName, and rawRow._gso
//                          (resolution, passCount, quality, outputScanWidthIn,
//                          outputFeedLengthIn, white1Ml/white2Ml, copies, times)
//                          WHEN the RasterLink converter supplies them;
//   linked ProductionJobItem the quote snapshot's operator-entered White
//                          coverage % and layer count, and the costed press.
//
// Nothing is fabricated: a value the sources do not carry is listed in
// `missing`, and only a record with nothing missing is `calibrationUsable`.
// Coverage from the quote is an operator ESTIMATE and is labelled as such.

export type MimakiWhiteEvidence = {
  jobIdentity: string | null;
  completedAt: string | null;
  profile: string | null;
  resolution: string | null;
  passConfig: string | null;
  quality: string | null;
  layoutSqft: number | null;
  layoutSource: "rip_output_dimensions" | "print_log_sqft" | null;
  whiteMl: number | null;
  whiteMlSource: "rip_dual_channel" | "print_log" | null;
  whiteCoveragePct: number | null;
  whiteCoverageSource: "quote_operator_estimate" | null;
  whiteLayers: number | null;
  durationMinutes: number | null;
  /** White mL per (layout sqft x coverage x layers) — only when every input is present. */
  normalizedWhiteMlPerSqftAt100: number | null;
  missing: string[];
  calibrationUsable: boolean;
};

const parse = (value: unknown): any => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value ?? null;
  } catch {
    return null;
  }
};
const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function mimakiWhiteCalibrationEvidence(
  entry: {
    jobTicket?: string | null;
    sourceJobName?: string | null;
    machineName?: string | null;
    mediaName?: string | null;
    sqft?: number | null;
    whiteInkMl?: number | null;
    printMinutes?: number | null;
    completedAt?: Date | string | null;
    rawRow?: string | null;
  },
  item?: { costSnapshot?: string | null } | null,
): MimakiWhiteEvidence | null {
  if (!/mimaki|ucjv|rasterlink/i.test(String(entry.machineName || ""))) return null;
  const gso = parse(entry.rawRow)?._gso ?? {};
  const canonical = parse(item?.costSnapshot)?.canonical ?? null;
  const whiteChannel = Array.isArray(canonical?.inkChannels) ? canonical.inkChannels.find((c: any) => c?.kind === "white") : null;

  const ripWidth = positive(gso.outputScanWidthIn);
  const ripLength = positive(gso.outputFeedLengthIn);
  const layoutFromRip = ripWidth && ripLength ? (ripWidth * ripLength) / 144 : null;
  const layoutSqft = layoutFromRip ?? positive(entry.sqft);
  const whiteRip = positive(gso.whiteSummedMl);
  const whiteMl = whiteRip ?? positive(entry.whiteInkMl);
  const whiteCoveragePct = positive(whiteChannel?.coveragePct);
  const whiteLayers = positive(canonical?.routing?.whiteLayers) ?? positive(whiteChannel?.passes);

  const evidence: MimakiWhiteEvidence = {
    jobIdentity: String(entry.jobTicket || entry.sourceJobName || "").trim() || null,
    completedAt: entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
    profile: String(entry.mediaName || "").trim() || null,
    resolution: gso.resolution != null ? String(gso.resolution) : null,
    passConfig: gso.passCount != null ? String(gso.passCount) : null,
    quality: gso.quality != null ? String(gso.quality) : null,
    layoutSqft,
    layoutSource: layoutFromRip ? "rip_output_dimensions" : layoutSqft ? "print_log_sqft" : null,
    whiteMl,
    whiteMlSource: whiteRip ? "rip_dual_channel" : whiteMl ? "print_log" : null,
    whiteCoveragePct,
    whiteCoverageSource: whiteCoveragePct ? "quote_operator_estimate" : null,
    whiteLayers,
    durationMinutes: positive(entry.printMinutes),
    normalizedWhiteMlPerSqftAt100: null,
    missing: [],
    calibrationUsable: false,
  };
  const required: Array<[keyof MimakiWhiteEvidence, string]> = [
    ["jobIdentity", "actual job identity"],
    ["layoutSqft", "layout sqft"],
    ["whiteMl", "White ink mL"],
    ["whiteCoveragePct", "White coverage % (link the print to its ERP item)"],
    ["whiteLayers", "White layer count (link the print to its ERP item)"],
    ["profile", "RIP profile / media"],
    ["resolution", "resolution (converter column not supplied)"],
    ["passConfig", "pass config (converter column not supplied)"],
    ["durationMinutes", "production duration"],
  ];
  evidence.missing = required.filter(([key]) => evidence[key] == null).map(([, label]) => label);
  if (evidence.whiteMl && evidence.layoutSqft && evidence.whiteCoveragePct && evidence.whiteLayers) {
    evidence.normalizedWhiteMlPerSqftAt100 = evidence.whiteMl / (evidence.layoutSqft * (evidence.whiteCoveragePct / 100) * evidence.whiteLayers);
  }
  evidence.calibrationUsable = evidence.missing.length === 0;
  return evidence;
}
