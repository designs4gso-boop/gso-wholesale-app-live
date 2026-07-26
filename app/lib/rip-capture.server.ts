// RIP capture widening (15F.0J.4). PURE parsing/classification/fingerprint
// helpers for BOTH printers' actual-result capture — no Prisma, no network,
// no filesystem. print-logs.server.ts calls these during import; tests import
// directly. Raw source rows are always preserved verbatim (immutability
// contract); everything here only ADDS normalized/derived data.

import { createHash } from "node:crypto";

export const RIP_CAPTURE_VERSION = "15F.0J.4-rip-capture";
const MM_TO_IN = 1 / 25.4;

// ---------- VersaWorks job-log format (Roland LG-640 / LG-540) ----------
// Format verified in the 15F.0J.1 forensics: comma CSV, headers include
// "Ink Consumption[ml]" + "Ink Name" (colon arrays whose ORDER VARIES —
// always mapped by name), mm dimensions, per-stage rows, "Media Name" is
// the RIP PROFILE, Print Start/End are wall-clock.
export function isVersaWorksJobLogRow(row: Record<string, string>): boolean {
  const keys = Object.keys(row).map((key) => key.toLowerCase());
  return keys.some((key) => key.includes("ink consumption")) && keys.some((key) => key === "ink name");
}

const VW_CMYK = new Set(["cyan", "magenta", "yellow", "black"]);
const VW_WHITE = new Set(["white"]);
const VW_GLOSS = new Set(["gloss", "clear", "varnish"]);

// Strip known technical duplication suffixes ONLY (identity normalization;
// genuinely different jobs are never merged). Original names preserved.
export function normalizeRipJobName(name: string): string {
  let text = String(name || "").trim();
  let lowered = text.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of [" - copy 3", " - copy 2", " - copy", "- copy", " copy 2", " (2)", " (3)"]) {
      if (lowered.endsWith(suffix)) {
        text = text.slice(0, text.length - suffix.length).replace(/[\s\-_]+$/, "");
        lowered = text.toLowerCase();
        changed = true;
      }
    }
  }
  return text;
}

export type VersaWorksEventClass = "completed" | "canceled" | "error" | "queue" | "other";

export function classifyVersaWorksEvent(event: string): VersaWorksEventClass {
  const text = String(event || "").toLowerCase();
  if (text.includes("cancel")) return "canceled";
  if (text.includes("error")) return "error";
  if (text.includes("print end")) return "completed";
  if (text.includes("new job") || text === "print start" || text.includes("rip")) return "queue";
  return "other";
}

function vwDate(value: string): Date | null {
  const text = String(value || "").trim();
  if (!text) return null;
  // VersaWorks format: 2026/07/24 19:18:01
  const match = text.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
}

function elapsedSeconds(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  let seconds = (end.getTime() - start.getTime()) / 1000;
  if (seconds < 0) seconds += 86400; // midnight crossing
  return seconds;
}

export type VersaWorksParsedRow = {
  printer: string;
  event: string;
  eventClass: VersaWorksEventClass;
  jobName: string;
  normalizedJobName: string;
  jobTicket: string; // parsed from the routed name when present
  itemTicket: string;
  profile: string; // "Media Name" = RIP profile
  copies: number;
  pageWidthIn: number;
  pageFeedIn: number;
  outputWidthIn: number; // Print Area_X (configured print width)
  outputFeedIn: number; // Print Area_Y (feed length)
  layoutSqft: number;
  ripStart: Date | null;
  ripEnd: Date | null;
  printStart: Date | null;
  printEnd: Date | null;
  printSeconds: number | null;
  ripSeconds: number | null;
  inkByChannel: Record<string, number>; // mapped BY NAME, never position
  channelNames: string[];
  cmykMl: number;
  whiteMl: number;
  glossMl: number;
  otherMl: number;
  totalMl: number;
  inkArrayMismatch: boolean;
  unknownChannels: string[];
};

export function parseVersaWorksRow(row: Record<string, string>): VersaWorksParsedRow {
  const get = (key: string) => {
    const found = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return found ? String(row[found] || "") : "";
  };
  const num = (value: string) => {
    const parsed = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const jobName = get("Job Name");
  const names = get("Ink Name").split(":").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const rawValues = get("Ink Consumption[ml]").split(":").map((value) => value.trim());
  const values = rawValues.map((value) => (Number.isFinite(Number(value)) ? Number(value) : null));
  const inkByChannel: Record<string, number> = {};
  const unknownChannels: string[] = [];
  let cmykMl = 0;
  let whiteMl = 0;
  let glossMl = 0;
  let otherMl = 0;
  names.forEach((name, index) => {
    const value = values[index];
    if (value == null) return;
    // Two white / two gloss channels SUM into one total (never dropped).
    inkByChannel[name] = (inkByChannel[name] || 0) + value;
    if (VW_CMYK.has(name)) cmykMl += value;
    else if (VW_WHITE.has(name)) whiteMl += value;
    else if (VW_GLOSS.has(name)) glossMl += value;
    else {
      otherMl += value;
      if (!unknownChannels.includes(name)) unknownChannels.push(name);
    }
  });
  const ripStart = vwDate(get("RIP Start Time"));
  const ripEnd = vwDate(get("RIP End Time"));
  const printStart = vwDate(get("Print Start Time"));
  const printEnd = vwDate(get("Print End Time"));
  const outputWidthIn = num(get("Print Area_X[mm]")) * MM_TO_IN;
  const outputFeedIn = num(get("Print Area_Y[mm]")) * MM_TO_IN;
  const normalizedJobName = normalizeRipJobName(jobName);
  const ticketMatch = normalizedJobName.replace(/_/g, "-").match(/GSO-\d{8}-\d{4}(-\d{2})?/i);
  const ticket = ticketMatch ? ticketMatch[0].toUpperCase() : "";
  return {
    printer: get("Nick Name"),
    event: get("Event"),
    eventClass: classifyVersaWorksEvent(get("Event")),
    jobName,
    normalizedJobName,
    jobTicket: ticket,
    itemTicket: /-\d{2}$/.test(ticket) ? ticket : "",
    profile: get("Media Name"),
    copies: Math.max(0, Math.floor(num(get("Copy")))),
    pageWidthIn: num(get("Page Size_X[mm]")) * MM_TO_IN,
    pageFeedIn: num(get("Page Size_Y[mm]")) * MM_TO_IN,
    outputWidthIn,
    outputFeedIn,
    layoutSqft: (outputWidthIn * outputFeedIn) / 144,
    ripStart,
    ripEnd,
    printStart,
    printEnd,
    printSeconds: elapsedSeconds(printStart, printEnd),
    ripSeconds: elapsedSeconds(ripStart, ripEnd),
    inkByChannel,
    channelNames: names,
    cmykMl,
    whiteMl,
    glossMl,
    otherMl,
    totalMl: cmykMl + whiteMl + glossMl + otherMl,
    inkArrayMismatch: names.length !== rawValues.filter((value) => value !== "").length,
    unknownChannels,
  };
}

// ---------- source-record fingerprint (15F.0J.4-D) ----------
// Stable identity built from normalized SOURCE fields — row position is
// deliberately excluded (exports regenerate cumulatively). Same event in a
// bigger export -> same fingerprint -> imported exactly once.
export function sourceRecordFingerprint(parsed: Pick<VersaWorksParsedRow, "printer" | "event" | "jobName" | "printStart" | "printEnd" | "outputWidthIn" | "outputFeedIn" | "copies" | "channelNames"> & { inkByChannel: Record<string, number> }): string {
  const payload = [
    parsed.printer,
    parsed.event,
    parsed.jobName,
    parsed.printStart ? parsed.printStart.toISOString() : "",
    parsed.printEnd ? parsed.printEnd.toISOString() : "",
    parsed.outputWidthIn.toFixed(3),
    parsed.outputFeedIn.toFixed(3),
    String(parsed.copies),
    parsed.channelNames.join(":"),
    Object.entries(parsed.inkByChannel).sort(([a], [b]) => a.localeCompare(b)).map(([name, ml]) => `${name}=${ml.toFixed(3)}`).join(","),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

// ---------- runtime quality flags (15F.0J.4-I) ----------
// Calibration eligibility is SEPARATE from actual-cost inclusion: a
// completed stage may count toward occupancy cost while its wall-clock
// duration is excluded from speed calibration.
export type RuntimeQuality = {
  flags: string[];
  calibrationEligible: boolean;
  actualCostEligible: boolean;
  exclusionReason: string | null;
};

export function runtimeQualityFlags(parsed: Pick<VersaWorksParsedRow, "eventClass" | "printSeconds" | "layoutSqft" | "printStart" | "printEnd">, options: { duplicateCompletion?: boolean; overlappingStage?: boolean; canceledCompanion?: boolean } = {}): RuntimeQuality {
  const flags: string[] = [];
  const seconds = parsed.printSeconds;
  if (parsed.eventClass === "canceled") flags.push("canceled");
  if (parsed.eventClass === "error") flags.push("failed");
  if (seconds == null || !parsed.printStart || !parsed.printEnd) flags.push("missing_timestamps");
  if (seconds != null && seconds <= 0) flags.push("invalid_duration");
  if (!(parsed.layoutSqft > 0)) flags.push("missing_dimensions");
  if (seconds != null && seconds > 4 * 3600) flags.push("over_four_hours");
  if (options.duplicateCompletion) flags.push("duplicate_completion");
  if (options.overlappingStage) flags.push("overlapping_stage");
  if (options.canceledCompanion) flags.push("canceled_companion_stage");
  if (seconds != null && seconds > 0 && parsed.layoutSqft > 0) {
    const sqftPerHour = parsed.layoutSqft / (seconds / 3600);
    if (sqftPerHour > 200) flags.push("implausible_throughput");
    // wall-clock far below the plausible run band = probable idle inside
    if (sqftPerHour < 2) flags.push("possible_idle");
    if (seconds < 8 * 60 && parsed.layoutSqft < 5) flags.push("small_job_fixed_time_dominated");
    // uninterrupted CANDIDATE only (never auto-declared): inside the measured
    // p25-p75 run band with no other disqualifier
    if (!flags.length && sqftPerHour >= 4 && sqftPerHour <= 60) flags.push("high_confidence_uninterrupted_candidate");
  }
  const disqualifiers = ["canceled", "failed", "missing_timestamps", "invalid_duration", "missing_dimensions", "over_four_hours", "duplicate_completion", "overlapping_stage", "implausible_throughput", "possible_idle"];
  const blocking = flags.filter((flag) => disqualifiers.includes(flag));
  const calibrationEligible = blocking.length === 0;
  // actual-cost inclusion: completed with a real duration — idle-contaminated
  // wall time still counts as OCCUPANCY cost; canceled/failed/dupes never do.
  const actualCostEligible = parsed.eventClass === "completed" && seconds != null && seconds > 0
    && !options.duplicateCompletion && !flags.includes("invalid_duration");
  return {
    flags,
    calibrationEligible,
    actualCostEligible,
    exclusionReason: calibrationEligible ? null : `calibration-excluded: ${blocking.join(", ") || "not completed"}`,
  };
}

// ---------- match method ladder (15F.0J.4-G) ----------
export type RipMatchMethod = "EXACT_TICKET" | "EXACT_MANIFEST" | "EXACT_HASH" | "EXACT_ROUTED_FILENAME" | "EXACT_NORMALIZED_FILENAME" | "PROBABLE_METADATA" | "MANUAL" | "UNMATCHED";

// Only EXACT_* or approved MANUAL matches may feed finalized actual cost;
// PROBABLE stays review-only (the writeback path additionally sits behind
// the owner phrase).
export function matchMethodAllowsActuals(method: RipMatchMethod): boolean {
  return method.startsWith("EXACT_") || method === "MANUAL";
}

// ---------- calibration candidate (15F.0J.4-K) ----------
export type RipCalibrationCandidate = {
  version: string;
  ticket: string;
  printer: string;
  profile: string;
  stage: "cmyk" | "white" | "gloss" | "combined" | "cut";
  layoutSqft: number;
  coveragePct: number | null;
  quotedLayers: number | null;
  estimatedSeconds: number | null;
  actualSeconds: number | null;
  runtimeFactor: number | null; // actual / estimated
  estimatedMl: number | null;
  actualMl: number | null;
  inkFactor: number | null;
  qualityFlags: string[];
  calibrationEligible: boolean;
  exclusionReason: string | null;
};

export function buildRipCalibrationCandidate(input: {
  ticket: string;
  printer: string;
  profile: string;
  stage: RipCalibrationCandidate["stage"];
  layoutSqft: number;
  coveragePct?: number | null;
  quotedLayers?: number | null;
  estimatedSeconds?: number | null;
  actualSeconds?: number | null;
  estimatedMl?: number | null;
  actualMl?: number | null;
  quality: RuntimeQuality;
}): RipCalibrationCandidate {
  const runtimeFactor = input.estimatedSeconds && input.estimatedSeconds > 0 && input.actualSeconds != null
    ? input.actualSeconds / input.estimatedSeconds
    : null;
  const inkFactor = input.estimatedMl && input.estimatedMl > 0 && input.actualMl != null
    ? input.actualMl / input.estimatedMl
    : null;
  return {
    version: RIP_CAPTURE_VERSION,
    ticket: input.ticket,
    printer: input.printer,
    profile: input.profile,
    stage: input.stage,
    layoutSqft: input.layoutSqft,
    coveragePct: input.coveragePct ?? null,
    quotedLayers: input.quotedLayers ?? null,
    estimatedSeconds: input.estimatedSeconds ?? null,
    actualSeconds: input.actualSeconds ?? null,
    runtimeFactor,
    estimatedMl: input.estimatedMl ?? null,
    actualMl: input.actualMl ?? null,
    inkFactor,
    qualityFlags: input.quality.flags,
    calibrationEligible: input.quality.calibrationEligible,
    exclusionReason: input.quality.exclusionReason,
  };
}

// ---------- Mimaki capture widening (15F.0J.4-F) ----------
// The EXTERNAL JobInfo->CSV converter remains unlocated (verified negative on
// the RasterLink PC: scheduled tasks, startup folders, C:\ scan, C:\MijCtrl).
// This is the REQUIRED FIELD CONTRACT for whoever regenerates the incoming
// CSVs; the parser below consumes whichever of these columns are present and
// NEVER fabricates missing values.
export const MIMAKI_CONVERTER_CONTRACT = {
  version: RIP_CAPTURE_VERSION,
  requiredExisting: ["job name", "machine", "media/profile", "status", "sqft", "cmyk ml", "white ml", "clear/gloss ml", "print time", "start", "end"],
  widenedColumns: [
    "resolution", "pass count", "print direction", "quality/fast print", "overprint",
    "copies", "output scan width (in or mm)", "output feed length (in or mm)",
    "white 1 ml", "white 2 ml", "clear 1 ml", "clear 2 ml",
    "spool time", "rip time", "cut time", "source file",
  ],
  rule: "Two white / two clear channels must arrive as separate columns (the parser sums them) OR pre-summed — never silently dropped.",
} as const;

const MIMAKI_EXTENDED_ALIASES: Record<string, string[]> = {
  resolution: ["resolution", "dpi"],
  passCount: ["pass", "passes", "pass count"],
  direction: ["direction", "print direction", "scan direction"],
  quality: ["quality", "fast print", "print quality", "mode"],
  overprint: ["overprint", "overprints"],
  copies: ["copy", "copies", "copy count"],
  outputScanWidthIn: ["scan width", "output width", "output scan width", "width"],
  outputFeedLengthIn: ["feed length", "output length", "output feed length", "length", "feed"],
  white1Ml: ["white 1", "white1", "white ch1", "w1"],
  white2Ml: ["white 2", "white2", "white ch2", "w2"],
  clear1Ml: ["clear 1", "clear1", "clear ch1", "gloss 1", "c1"],
  clear2Ml: ["clear 2", "clear2", "clear ch2", "gloss 2", "c2"],
  spoolSeconds: ["spool time", "spool"],
  ripSeconds2: ["rip time", "rip"],
  cutSeconds: ["cut time", "cut"],
  sourceFile: ["source file", "source", "original file"],
};

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
}

function timeToSeconds(value: string): number | null {
  const text = String(value || "").trim();
  if (!text) return null;
  // Converter contract: three-part = H:MM:SS; TWO-part colon durations are
  // MINUTES:SECONDS (RasterLink displays "21 min 26 s" -> "21:26").
  const hms = text.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const ms = text.match(/^(\d{1,4}):(\d{2})$/);
  if (ms) return Number(ms[1]) * 60 + Number(ms[2]);
  const minSec = text.match(/(\d+)\s*min\s*(\d+)?\s*s(ec)?/i);
  if (minSec) return Number(minSec[1]) * 60 + Number(minSec[2] || 0);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

// Extract widened Mimaki fields WHEN the converter provides them. Returns
// null when no widened column is present (old CSVs stay byte-compatible).
export function extractMimakiExtended(row: Record<string, string>): Record<string, unknown> | null {
  const byAlias = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) byAlias.set(normalizeAliasKey(key), String(value ?? ""));
  const out: Record<string, unknown> = {};
  for (const [field, aliases] of Object.entries(MIMAKI_EXTENDED_ALIASES)) {
    for (const alias of aliases) {
      const value = byAlias.get(alias);
      if (value != null && value !== "") {
        if (["spoolSeconds", "ripSeconds2", "cutSeconds"].includes(field)) out[field] = timeToSeconds(value);
        else if (["white1Ml", "white2Ml", "clear1Ml", "clear2Ml", "copies", "passCount", "overprint", "outputScanWidthIn", "outputFeedLengthIn"].includes(field)) {
          const numeric = Number(value.replace(/,/g, ""));
          if (Number.isFinite(numeric)) out[field] = numeric;
        } else out[field] = value;
        break;
      }
    }
  }
  if (!Object.keys(out).length) return null;
  // dual-channel sums (never dropped)
  const white1 = Number(out.white1Ml) || 0;
  const white2 = Number(out.white2Ml) || 0;
  if (white1 || white2) out.whiteSummedMl = white1 + white2;
  const clear1 = Number(out.clear1Ml) || 0;
  const clear2 = Number(out.clear2Ml) || 0;
  if (clear1 || clear2) out.clearSummedMl = clear1 + clear2;
  return out;
}
