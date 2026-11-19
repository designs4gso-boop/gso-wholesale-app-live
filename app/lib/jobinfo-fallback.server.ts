// RasterLink JobInfo.ini fallback (13A.6E): pure parser + deterministic
// pairing engine + enrichment builder. No Prisma, no network, no filesystem —
// the web server NEVER reads C:\MijCtrl\Jobs; a companion upload supplies the
// file content plus a safe folder identifier.
//
// FEATURE-FLAGGED OFF BY DEFAULT (GSO_ENABLE_JOBINFO_FALLBACK=1 to enable).
// No real shop JobInfo.ini sample exists in the repo yet, so the engine is
// implemented and offline-tested against the owner-validated inkUsed format,
// but live wiring stays disabled until one real file is validated (the exact
// step is documented in the project state doc). Nothing here guesses.
//
// Validated conversion (owner-confirmed, 13A.6A): inkUsed=1;67,2;70,3;14,4;17
// -> raw / 1000 = cc PER ARRANGED ITEM; codes 1/2/3/4 = C/M/Y/K. Codes beyond
// 4 are UNPROVEN: preserved verbatim as unknown channels with a warning,
// never added to totals, never guessed.
//
// Enrichment applies ONLY to RasterLink print rows whose inkBasis is
// "missing_inkuse" (blank KEY_INKUSE). Valid CSV ink is never overridden.
// Rows with BOTH timestamps blank are refused: their row-dedupe natural key
// includes inkMl (13A.6A), so changing it would break re-upload idempotency.

import { INK_BASIS_MISSING, parseRasterlinkStamp } from "./rasterlink-parse.server";

export const JOBINFO_FALLBACK_VERSION = "13A.6E";
export const JOBINFO_FLAG_ENV = "GSO_ENABLE_JOBINFO_FALLBACK";
// Provenance basis values. Existing bases are untouched: valid CSV rows keep
// "rasterlink_rounded_per_item_estimate" (the spec's "rasterlink_csv" state)
// and never-enriched blank rows keep "missing_inkuse" (the "missing" state).
export const INK_BASIS_JOBINFO_PER_ITEM = "jobinfo_per_item";
export const INK_BASIS_JOBINFO_ARRANGED = "jobinfo_arranged_estimate";

// 2026-11-18 (owner, Patch F): a REAL RasterLink job folder (S01_...) is now a
// validated, always-available ink source for composite CMYK + clear jobs whose
// result CSV carries no ink. It is linked by exact identity only (see
// decideJobInfoPairing). The flag above still gates ONLY the older, never
// validated "folder is named like the file" pairing.
export const INK_BASIS_JOBINFO_JOB_FOLDER = "jobinfo_job_folder_arranged_estimate";
export const JOBINFO_CLEAR_VERSION = "F.clear-136-137";
// Owner-verified against RasterLink Properties (2026-11-18): the Mimaki
// UCJV300 reports clear / gloss on TWO slots, codes 136 and 137, and BOTH are
// real consumption: the total is their SUM. Clear is not primer and not white.
export const JOBINFO_CLEAR_SLOT_CODES = [136, 137] as const;

export function jobInfoFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[JOBINFO_FLAG_ENV] === "1";
}

// ---------- inkUsed parsing (unknown channels preserved, never guessed) ----------

export type JobInfoUnknownChannel = { code: number; raw: number; cc: number };

export type ParsedInkUsed = {
  present: boolean;
  inkUsedRaw: string;
  cyanCc: number;
  magentaCc: number;
  yellowCc: number;
  blackCc: number;
  perItemKnownCc: number; // validated C+M+Y+K only — unknown channels excluded
  clearSlot1Cc: number; // code 136
  clearSlot2Cc: number; // code 137
  clearCc: number; // BOTH clear slots summed (owner rule): never white, never primer, never an unknown code
  unknownChannels: JobInfoUnknownChannel[];
  warnings: string[];
};

export function parseInkUsedLine(value: unknown): ParsedInkUsed {
  const inkUsedRaw = String(value ?? "").trim();
  const text = inkUsedRaw.replace(/^inkUsed=/i, "").trim();
  const out: ParsedInkUsed = {
    present: false, inkUsedRaw, cyanCc: 0, magentaCc: 0, yellowCc: 0, blackCc: 0,
    perItemKnownCc: 0, clearSlot1Cc: 0, clearSlot2Cc: 0, clearCc: 0, unknownChannels: [], warnings: [],
  };
  if (!text) return out;
  for (const pair of text.split(",")) {
    const [codeRaw, rawValue] = pair.split(";");
    const code = Number(codeRaw);
    const raw = Number(rawValue);
    if (!codeRaw?.trim() || !rawValue?.trim() || !Number.isFinite(code) || !Number.isFinite(raw)) {
      out.warnings.push(`malformed_pair:${pair.slice(0, 40)}`);
      continue;
    }
    const cc = raw / 1000; // validated: raw / 1000 = cc per arranged item
    if (code === 1) { out.cyanCc += cc; out.present = true; }
    else if (code === 2) { out.magentaCc += cc; out.present = true; }
    else if (code === 3) { out.yellowCc += cc; out.present = true; }
    else if (code === 4) { out.blackCc += cc; out.present = true; }
    else if (code === JOBINFO_CLEAR_SLOT_CODES[0]) { out.clearSlot1Cc += cc; out.present = true; }
    else if (code === JOBINFO_CLEAR_SLOT_CODES[1]) { out.clearSlot2Cc += cc; out.present = true; }
    else {
      // Unproven channel code: preserve verbatim, warn, never total.
      out.unknownChannels.push({ code, raw, cc });
      out.warnings.push(`unknown_channel:${code}`);
    }
  }
  out.perItemKnownCc = out.cyanCc + out.magentaCc + out.yellowCc + out.blackCc;
  out.clearCc = out.clearSlot1Cc + out.clearSlot2Cc;
  return out;
}

// ---------- JobInfo.ini parsing ----------

export type JobInfoRecord = {
  sourceId: string; // safe relative identifier (job folder name) — never a full local path
  jobName: string;
  ink: ParsedInkUsed;
  rawKeys: Record<string, string>; // verbatim key=value pairs, bounded, for forensics
  warnings: string[];
  // Real RasterLink job folder identity (null for anything else). Read from the
  // file itself, never inferred.
  rasterlinkJob: {
    jobId: string; // [Job] JobID
    fileName: string; // jobName = the file RasterLink reports as KEY_FILENAME
    ripStartStamp: string; // this job's own result-log KEY_RIP_S_TIME, verbatim
    ripEndStamp: string; // this job's own result-log KEY_RIP_E_TIME, verbatim
  } | null;
};

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");

// resultLogResult="<JobID>";"KEY_RIP_E_TIME";"20261118_095824","<JobID>";"KEY_RIP_S_TIME";"20261118_095815"
// Only triples that name THIS job's own JobID are read.
function resultLogStamp(resultLogResult: string, jobId: string, key: string): string {
  let found = "";
  let count = 0;
  for (const triple of resultLogResult.split(",")) {
    const parts = triple.split(";").map(unquote);
    if (parts.length !== 3 || parts[0] !== jobId || parts[1] !== key) continue;
    found = parts[2];
    count += 1;
  }
  return count === 1 ? found : ""; // absent or stated twice -> no identity
}

// The folder name is the only proven job identifier; strip any path prefixes
// so a full local path passed by mistake is reduced to its final segment.
export function safeJobInfoSourceId(value: unknown): string {
  const parts = String(value ?? "").trim().replace(/[\\/]+$/, "").split(/[\\/]/);
  return (parts[parts.length - 1] || "").slice(0, 120);
}

export function parseJobInfoIni(text: string, sourceIdInput: string): JobInfoRecord {
  const sourceId = safeJobInfoSourceId(sourceIdInput);
  const record: JobInfoRecord = {
    sourceId,
    jobName: sourceId.replace(/\.ini$/i, ""),
    ink: parseInkUsedLine(""),
    rawKeys: {},
    warnings: [],
    rasterlinkJob: null,
  };
  let iniJobId = "";
  let iniFileName = "";
  let iniResultLog = "";
  let section = "";
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let keyCount = 0;
  for (const line of lines) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    // First statement wins; a real file states each of these once.
    if (section === "Job" && key === "JobID" && !iniJobId) iniJobId = unquote(value);
    if (key === "jobName" && !iniFileName) iniFileName = unquote(value);
    if (key === "resultLogResult" && !iniResultLog) iniResultLog = value;
    if (keyCount < 40) { record.rawKeys[key.slice(0, 60)] = value.slice(0, 200); keyCount += 1; }
    if (key.toLowerCase() === "inkused") record.ink = parseInkUsedLine(`inkUsed=${value}`);
  }
  if (iniJobId) {
    record.rasterlinkJob = {
      jobId: iniJobId,
      fileName: iniFileName,
      ripStartStamp: resultLogStamp(iniResultLog, iniJobId, "KEY_RIP_S_TIME"),
      ripEndStamp: resultLogStamp(iniResultLog, iniJobId, "KEY_RIP_E_TIME"),
    };
  }
  if (!record.ink.present && !record.ink.inkUsedRaw) record.warnings.push("no_inkused_line");
  if (!record.jobName) record.warnings.push("no_job_identifier");
  return record;
}

// ---------- deterministic pairing ----------

export function normalizeJobInfoName(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type PairingCandidateRow = {
  id: string;
  sourceJobName: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  rawRow: string | null;
  // Needed only for the RasterLink job-folder linkage (optional so older callers are unchanged).
  ripStartedAt?: Date | string | null;
  ripCompletedAt?: Date | string | null;
  status?: string | null;
};

function parsedRawRowOf(row: Pick<PairingCandidateRow, "rawRow">): Record<string, unknown> | null {
  if (!row.rawRow) return null;
  try {
    const parsed = JSON.parse(row.rawRow);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A row may receive JobInfo ink ONLY when its CSV ink was blank AND enriching
// it cannot corrupt anything else.
export function jobInfoEligibility(row: PairingCandidateRow): { eligible: boolean; reason: string | null } {
  const raw = parsedRawRowOf(row);
  if (!raw) return { eligible: false, reason: "unparseable_rawrow" };
  if (raw.jobInfoFallback) return { eligible: false, reason: "already_enriched" };
  if (raw.inkBasis !== INK_BASIS_MISSING) return { eligible: false, reason: "csv_ink_present_never_overridden" };
  if (!row.startedAt && !row.completedAt) return { eligible: false, reason: "blank_time_dedupe_protection" };
  return { eligible: true, reason: null };
}

const instantOf = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? null : time;
};

// Job-folder path: the row must be a blank-ink PRINT row with a COMPLETE RIP
// window. That window is the row's dedupe identity (rowDedupeWhere) and ink is
// not part of it, so filling the ink cannot break re-upload idempotency.
export function jobFolderEligibility(row: PairingCandidateRow): { eligible: boolean; reason: string | null } {
  const raw = parsedRawRowOf(row);
  if (!raw) return { eligible: false, reason: "unparseable_rawrow" };
  if (raw.jobInfoFallback) return { eligible: false, reason: "already_enriched" };
  if (raw.inkBasis !== INK_BASIS_MISSING) return { eligible: false, reason: "csv_ink_present_never_overridden" };
  if (row.status != null && !String(row.status).startsWith("print:")) return { eligible: false, reason: "not_a_print_row" };
  if (instantOf(row.ripStartedAt) == null || instantOf(row.ripCompletedAt) == null) return { eligible: false, reason: "no_complete_rip_window" };
  return { eligible: true, reason: null };
}

export type JobInfoPairing = {
  outcome: "paired" | "no_candidates" | "ambiguous";
  row: PairingCandidateRow | null;
  candidateRowIds: string[];
  ineligible: { rowId: string; reason: string }[];
};

// Exact normalized name equality ONLY (folder/job name vs the row's stored
// KEY_FILENAME). One eligible candidate pairs; zero keeps missing; two+ is
// ambiguous and keeps missing. Never contains, never nearest-date.
/**
 * EXACT linkage between a result row and a RasterLink job folder. All of:
 *   - the uploaded folder name IS the JobID written inside the file;
 *   - the file jobName equals the row KEY_FILENAME character for character;
 *   - the job result-log RIP start AND end stamps equal the row RIP window.
 * Anything less links nothing. No contains, no nearest time, no name similarity.
 */
function decideJobFolderPairing(record: JobInfoRecord, rows: PairingCandidateRow[]): JobInfoPairing {
  const none: JobInfoPairing = { outcome: "no_candidates", row: null, candidateRowIds: [], ineligible: [] };
  const job = record.rasterlinkJob;
  if (!job || !job.jobId || record.sourceId !== job.jobId) return { ...none, ineligible: [{ rowId: "", reason: "job_folder_name_is_not_the_job_id" }] };
  const ripStart = instantOf(parseRasterlinkStamp(job.ripStartStamp));
  const ripEnd = instantOf(parseRasterlinkStamp(job.ripEndStamp));
  if (!job.fileName || ripStart == null || ripEnd == null) return { ...none, ineligible: [{ rowId: "", reason: "jobinfo_has_no_result_identity" }] };
  const ineligible: { rowId: string; reason: string }[] = [];
  const candidates: PairingCandidateRow[] = [];
  for (const row of rows) {
    if (row.sourceJobName !== job.fileName) continue;
    if (instantOf(row.ripStartedAt) !== ripStart || instantOf(row.ripCompletedAt) !== ripEnd) continue;
    const check = jobFolderEligibility(row);
    if (check.eligible) candidates.push(row);
    else ineligible.push({ rowId: row.id, reason: check.reason || "ineligible" });
  }
  if (candidates.length === 1) return { outcome: "paired", row: candidates[0], candidateRowIds: [candidates[0].id], ineligible };
  if (candidates.length > 1) return { outcome: "ambiguous", row: null, candidateRowIds: candidates.slice(0, 5).map((row) => row.id), ineligible };
  return { ...none, ineligible };
}

export function decideJobInfoPairing(record: JobInfoRecord, rows: PairingCandidateRow[]): JobInfoPairing {
  // A file that states a RasterLink JobID is a job folder: it links by the
  // exact identity above or not at all. It never falls back to name pairing.
  if (record.rasterlinkJob) return decideJobFolderPairing(record, rows);
  const target = normalizeJobInfoName(record.jobName);
  const ineligible: { rowId: string; reason: string }[] = [];
  const candidates: PairingCandidateRow[] = [];
  if (target.length >= 4) {
    for (const row of rows) {
      if (normalizeJobInfoName(row.sourceJobName) !== target) continue;
      const check = jobInfoEligibility(row);
      if (check.eligible) candidates.push(row);
      else ineligible.push({ rowId: row.id, reason: check.reason || "ineligible" });
    }
  }
  if (candidates.length === 1) return { outcome: "paired", row: candidates[0], candidateRowIds: [candidates[0].id], ineligible };
  if (candidates.length > 1) return { outcome: "ambiguous", row: null, candidateRowIds: candidates.slice(0, 5).map((row) => row.id), ineligible };
  return { outcome: "no_candidates", row: null, candidateRowIds: [], ineligible };
}

// ---------- enrichment (the ONLY write payload this feature can produce) ----------

export type JobInfoEnrichment =
  | { ok: true; update: { inkMl: number; cmykInkMl: number; whiteInkMl: number; glossInkMl: number; rawRow: string }; inkBasis: string; estimatedTotalCc: number }
  | { ok: false; reason: string };

/**
 * The arranged copy count of a composite job, taken from the CUT result of the
 * same RasterLink result (the print rows of a composite report 0). `values` are
 * the arrange counts of the cut rows that came from the exactly paired
 * "..._cut.csv". One distinct positive count -> that count; anything else -> null.
 */
export function arrangeCountFromCutRows(values: unknown[]): number | null {
  const counts = new Set<number>();
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) counts.add(value);
  }
  return counts.size === 1 ? [...counts][0] : null;
}

/** "X_1_OK_print.csv" -> "X_1_OK_cut.csv" (exact sibling of the same result); "" when the name is not a print result. */
export function pairedCutResultFileName(printUploadFileName: unknown): string {
  const name = String(printUploadFileName ?? "");
  return /_print\.csv$/i.test(name) ? name.replace(/_print\.csv$/i, "_cut.csv") : "";
}

/**
 * Job-folder enrichment (owner-approved 2026-11-18). Writes EXACTLY the ink
 * columns + rawRow: CMYK from codes 1-4, clear / gloss = slot 136 + slot 137,
 * white stays 0 (its codes are not validated), unknown codes are kept verbatim
 * and never totalled. Refuses without a positive arranged count: a per-item
 * figure is never stored as a job total.
 */
export function buildJobFolderEnrichment(row: PairingCandidateRow, record: JobInfoRecord, options: { cutArrangeCnt?: number | null; at?: Date } = {}): JobInfoEnrichment {
  if (!record.rasterlinkJob) return { ok: false, reason: "not_a_rasterlink_job_folder" };
  const check = jobFolderEligibility(row);
  if (!check.eligible) return { ok: false, reason: check.reason || "ineligible" };
  if (!record.ink.present) return { ok: false, reason: "jobinfo_has_no_usable_inkused" };
  const raw = parsedRawRowOf(row);
  if (!raw) return { ok: false, reason: "unparseable_rawrow" };
  const own = typeof raw.arrangeCnt === "number" && raw.arrangeCnt >= 1 ? raw.arrangeCnt : null;
  const cut = typeof options.cutArrangeCnt === "number" && options.cutArrangeCnt >= 1 ? options.cutArrangeCnt : null;
  const arrangeCnt = own ?? cut;
  if (!arrangeCnt) return { ok: false, reason: "arrange_count_unknown" };
  const warnings = [...record.ink.warnings];
  if (record.ink.unknownChannels.some((channel) => channel.raw !== 0)) warnings.push("unknown_channels_excluded_from_totals");
  const cmykTotal = record.ink.perItemKnownCc * arrangeCnt;
  const clearSlot1 = record.ink.clearSlot1Cc * arrangeCnt;
  const clearSlot2 = record.ink.clearSlot2Cc * arrangeCnt;
  const clearTotal = clearSlot1 + clearSlot2;
  const total = cmykTotal + clearTotal;
  const rawRow = JSON.stringify({
    ...raw,
    inkBasis: INK_BASIS_JOBINFO_JOB_FOLDER,
    jobInfoFallback: {
      sourceId: record.sourceId,
      linkage: "exact_job_id_file_name_rip_window",
      jobName: record.rasterlinkJob.fileName,
      ripStartStamp: record.rasterlinkJob.ripStartStamp,
      ripEndStamp: record.rasterlinkJob.ripEndStamp,
      inkUsedRaw: record.ink.inkUsedRaw,
      perChannelCc: { cyan: record.ink.cyanCc, magenta: record.ink.magentaCc, yellow: record.ink.yellowCc, black: record.ink.blackCc, clearSlot1: record.ink.clearSlot1Cc, clearSlot2: record.ink.clearSlot2Cc },
      unknownChannels: record.ink.unknownChannels,
      perItemTotalCc: record.ink.perItemKnownCc + record.ink.clearCc,
      arrangeCnt,
      arrangeSource: own ? "print_row" : "paired_cut_result",
      cmykTotalCc: cmykTotal,
      clearSlot1TotalCc: clearSlot1,
      clearSlot2TotalCc: clearSlot2,
      clearTotalCc: clearTotal,
      estimatedTotalCc: total,
      estimate: true, // rounded per-item x arranged count, NOT the exact metered total RasterLink shows
      originalInkBasis: INK_BASIS_MISSING,
      warnings,
      appliedAt: (options.at || new Date()).toISOString(),
      version: JOBINFO_CLEAR_VERSION,
    },
  }).slice(0, 16000);
  return {
    ok: true,
    update: { inkMl: total, cmykInkMl: cmykTotal, whiteInkMl: 0, glossInkMl: clearTotal, rawRow },
    inkBasis: INK_BASIS_JOBINFO_JOB_FOLDER,
    estimatedTotalCc: total,
  };
}

export function buildJobInfoEnrichment(row: PairingCandidateRow, record: JobInfoRecord, at?: Date): JobInfoEnrichment {
  const check = jobInfoEligibility(row);
  if (!check.eligible) return { ok: false, reason: check.reason || "ineligible" };
  if (!record.ink.present) return { ok: false, reason: "jobinfo_has_no_usable_inkused" };
  const raw = parsedRawRowOf(row);
  if (!raw) return { ok: false, reason: "unparseable_rawrow" };

  const arrangeCnt = typeof raw.arrangeCnt === "number" && raw.arrangeCnt >= 1 ? raw.arrangeCnt : null;
  const warnings = [...record.ink.warnings];
  // Per-item vs arranged estimate distinction (validated multiplication rule):
  // with a known arrange count the stored total is per-item x count, and it is
  // ALWAYS an estimate — never exact measured ink.
  const multiplier = arrangeCnt ?? 1;
  const inkBasis = arrangeCnt ? INK_BASIS_JOBINFO_ARRANGED : INK_BASIS_JOBINFO_PER_ITEM;
  if (!arrangeCnt) warnings.push("arrange_unknown_per_item_only");
  const cmykTotal = record.ink.perItemKnownCc * multiplier;
  if (record.ink.unknownChannels.length) warnings.push("unknown_channels_excluded_from_totals");

  const rawRow = JSON.stringify({
    ...raw,
    inkBasis,
    jobInfoFallback: {
      sourceId: record.sourceId,
      jobName: record.jobName,
      inkUsedRaw: record.ink.inkUsedRaw,
      perChannelCc: { cyan: record.ink.cyanCc, magenta: record.ink.magentaCc, yellow: record.ink.yellowCc, black: record.ink.blackCc },
      unknownChannels: record.ink.unknownChannels,
      perItemTotalCc: record.ink.perItemKnownCc,
      arrangeCnt,
      estimatedTotalCc: cmykTotal,
      estimate: true, // NEVER exact measured ink
      originalInkBasis: INK_BASIS_MISSING,
      warnings,
      appliedAt: (at || new Date()).toISOString(),
      version: JOBINFO_FALLBACK_VERSION,
    },
  }).slice(0, 16000);

  return {
    ok: true,
    // Exactly these keys — timing, names, status, tickets are immutable here.
    update: { inkMl: cmykTotal, cmykInkMl: cmykTotal, whiteInkMl: 0, glossInkMl: 0, rawRow },
    inkBasis,
    estimatedTotalCc: cmykTotal,
  };
}
