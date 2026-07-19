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

import { INK_BASIS_MISSING } from "./rasterlink-parse.server";

export const JOBINFO_FALLBACK_VERSION = "13A.6E";
export const JOBINFO_FLAG_ENV = "GSO_ENABLE_JOBINFO_FALLBACK";
// Provenance basis values. Existing bases are untouched: valid CSV rows keep
// "rasterlink_rounded_per_item_estimate" (the spec's "rasterlink_csv" state)
// and never-enriched blank rows keep "missing_inkuse" (the "missing" state).
export const INK_BASIS_JOBINFO_PER_ITEM = "jobinfo_per_item";
export const INK_BASIS_JOBINFO_ARRANGED = "jobinfo_arranged_estimate";

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
  unknownChannels: JobInfoUnknownChannel[];
  warnings: string[];
};

export function parseInkUsedLine(value: unknown): ParsedInkUsed {
  const inkUsedRaw = String(value ?? "").trim();
  const text = inkUsedRaw.replace(/^inkUsed=/i, "").trim();
  const out: ParsedInkUsed = {
    present: false, inkUsedRaw, cyanCc: 0, magentaCc: 0, yellowCc: 0, blackCc: 0,
    perItemKnownCc: 0, unknownChannels: [], warnings: [],
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
    else {
      // Unproven channel code: preserve verbatim, warn, never total.
      out.unknownChannels.push({ code, raw, cc });
      out.warnings.push(`unknown_channel:${code}`);
    }
  }
  out.perItemKnownCc = out.cyanCc + out.magentaCc + out.yellowCc + out.blackCc;
  return out;
}

// ---------- JobInfo.ini parsing ----------

export type JobInfoRecord = {
  sourceId: string; // safe relative identifier (job folder name) — never a full local path
  jobName: string;
  ink: ParsedInkUsed;
  rawKeys: Record<string, string>; // verbatim key=value pairs, bounded, for forensics
  warnings: string[];
};

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
  };
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let keyCount = 0;
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (keyCount < 40) { record.rawKeys[key.slice(0, 60)] = value.slice(0, 200); keyCount += 1; }
    if (key.toLowerCase() === "inkused") record.ink = parseInkUsedLine(`inkUsed=${value}`);
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

export type JobInfoPairing = {
  outcome: "paired" | "no_candidates" | "ambiguous";
  row: PairingCandidateRow | null;
  candidateRowIds: string[];
  ineligible: { rowId: string; reason: string }[];
};

// Exact normalized name equality ONLY (folder/job name vs the row's stored
// KEY_FILENAME). One eligible candidate pairs; zero keeps missing; two+ is
// ambiguous and keeps missing. Never contains, never nearest-date.
export function decideJobInfoPairing(record: JobInfoRecord, rows: PairingCandidateRow[]): JobInfoPairing {
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
