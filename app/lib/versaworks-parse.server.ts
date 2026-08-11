// VersaWorks import hardening (13A.6D): pure parsing + matching decisions for
// the upload endpoint's VersaWorks branch. No Prisma, no network — tests
// import this directly.
//
// The parsing helpers are ported VERBATIM from the legacy endpoint path so a
// hardened import produces byte-identical values (sqft, ink split, timing
// fallback, ticket extraction) for every currently supported CSV. What the
// hardened branch ADDS is safety: format sniffing, sha256 file dedupe, a
// natural-key row dedupe, conservative two-stage matching (never
// first-match-wins, never contains), and transparent matchMeta in rawRow that
// the 13A.6C review page already understands (top-level matchFlag).

import { classifyVersaWorksEvent, runtimeQualityFlags, sourceRecordFingerprint, RIP_CAPTURE_VERSION } from "./rip-capture.server";

export const VERSAWORKS_SOURCE = "versaworks";
// Same flag the RasterLink branch and the 13A.6C review page use — the review
// page classifies on rawRow.matchFlag, so VersaWorks ambiguity shows up there
// with zero review-page changes.
export const VERSAWORKS_AMBIGUOUS_FLAG = "ambiguous_ticket_needs_review";

// ---------- helpers ported verbatim from the legacy endpoint path ----------

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const d = new Date(raw.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extractVersaworksTicket(jobName: string, fileName = "") {
  const match = `${jobName} ${fileName}`.match(/\bGSO[-_ ]?(?:TEST[-_ ]?)?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\b/i);
  return match ? match[0].replace(/_/g, "-").replace(/\s+/g, "-").toUpperCase() : "";
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { field += '"'; i += 1; } else quoted = !quoted;
    } else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cleanText(cell))) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((cell) => cleanText(cell))) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(cleanText);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, index) => { obj[header] = cleanText(cells[index]); });
    return obj;
  });
}

function inkSplit(row: Record<string, string>) {
  const values = cleanText(row["Ink Consumption[ml]"]).split(":").map(parseNumber);
  const names = cleanText(row["Ink Name"]).split(":").map((name) => name.toLowerCase());
  let cmykInkMl = 0, whiteInkMl = 0, glossInkMl = 0;
  values.forEach((ml, index) => {
    const name = names[index] || "";
    if (name.includes("white")) whiteInkMl += ml;
    else if (name.includes("gloss") || name.includes("clear") || name.includes("primer")) glossInkMl += ml;
    else cmykInkMl += ml;
  });
  return { inkMl: values.reduce((sum, value) => sum + value, 0), cmykInkMl, whiteInkMl, glossInkMl };
}

// ---------- format detection ----------

// Header sniff for VersaWorks job-history CSVs. Mutually exclusive with
// RasterLink by construction: any KEY_* header disqualifies. Files that match
// neither sniffer keep the legacy endpoint path byte-identical (placeholder
// rows for non-CSV, generic parse for unknown CSVs) — compatibility is never
// narrowed.
export function looksLikeVersaworksCsv(text: string): boolean {
  const firstLine = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  if (/\bKEY_[A-Z_]+/.test(firstLine)) return false;
  if (!firstLine.includes("Job Name")) return false;
  return firstLine.includes("Ink Consumption[ml]") || firstLine.includes("Nick Name") || firstLine.includes("Print Area_X[mm]");
}

// ---------- row building ----------

export type VersaworksEntry = {
  jobName: string;
  event: string;
  eventClass: "completed" | "canceled" | "error" | "queue" | "other"; // 15F.0J.4
  machineName: string;
  mediaName: string;
  sqft: number;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  jobTicket: string;
  startedAt: Date | null;
  completedAt: Date | null;
  // 15F.0J.4 widened capture (E): dims in inches, copies, elapsed seconds,
  // and the stable source-record fingerprint.
  copies: number;
  pageWidthIn: number;
  pageFeedIn: number;
  outputWidthIn: number;
  outputFeedIn: number;
  printSeconds: number | null;
  ripSeconds: number | null;
  fingerprint: string;
  timingBasis: "print_times" | "rip_times_fallback" | "no_times";
  warnings: string[];
  raw: Record<string, string>;
};

export function parseVersaworksRows(text: string, fileName: string): VersaworksEntry[] {
  return parseCsv(text).map((row) => {
    const x = parseNumber(row["Print Area_X[mm]"]);
    const y = parseNumber(row["Print Area_Y[mm]"]);
    const jobName = cleanText(row["Job Name"]);
    const printStart = cleanText(row["Print Start Time"]);
    const ripStart = cleanText(row["RIP Start Time"]);
    // Legacy semantics preserved exactly: startedAt/completedAt fall back to
    // RIP times when print times are blank. timingBasis only LABELS that
    // fallback (its values deliberately differ from RasterLink's so the
    // review page's RasterLink-specific warning never misfires).
    const timingBasis: VersaworksEntry["timingBasis"] = printStart ? "print_times" : ripStart ? "rip_times_fallback" : "no_times";
    const warnings: string[] = [];
    if (!jobName) warnings.push("no_job_name");
    if (timingBasis === "rip_times_fallback") warnings.push("rip_times_fallback");
    if (timingBasis === "no_times") warnings.push("no_times");
    // 15F.0J.4 widened capture: elapsed seconds (midnight-corrected), copies,
    // dims in inches, event class, and the source-record fingerprint.
    const elapsed = (start: Date | null, end: Date | null) => {
      if (!start || !end) return null;
      let seconds = (end.getTime() - start.getTime()) / 1000;
      if (seconds < 0) seconds += 86400;
      return seconds;
    };
    const pStart = parseDate(row["Print Start Time"]);
    const pEnd = parseDate(row["Print End Time"]);
    const rStart = parseDate(row["RIP Start Time"]);
    const rEnd = parseDate(row["RIP End Time"]);
    const outputWidthIn = x / 25.4;
    const outputFeedIn = y / 25.4;
    const ink = inkSplit(row);
    const entryBase = {
      event: cleanText(row.Event),
      eventClass: classifyVersaWorksEvent(cleanText(row.Event)),
      machineName: cleanText(row["Nick Name"]),
      jobName,
      mediaName: cleanText(row["Media Name"]),
      sqft: x > 0 && y > 0 ? (x / 25.4) * (y / 25.4) / 144 : 0,
      ...ink,
      jobTicket: extractVersaworksTicket(jobName, fileName),
      startedAt: parseDate(row["Print Start Time"] || row["RIP Start Time"]),
      completedAt: parseDate(row["Print End Time"] || row["RIP End Time"]),
      copies: Math.max(0, Math.floor(parseNumber(row.Copy))),
      pageWidthIn: parseNumber(row["Page Size_X[mm]"]) / 25.4,
      pageFeedIn: parseNumber(row["Page Size_Y[mm]"]) / 25.4,
      outputWidthIn,
      outputFeedIn,
      printSeconds: elapsed(pStart, pEnd),
      ripSeconds: elapsed(rStart, rEnd),
      timingBasis,
      warnings,
      raw: row,
    };
    const fingerprint = sourceRecordFingerprint({
      printer: entryBase.machineName, event: entryBase.event, jobName,
      printStart: pStart, printEnd: pEnd, outputWidthIn, outputFeedIn,
      copies: entryBase.copies,
      channelNames: cleanText(row["Ink Name"]).split(":").map((name) => name.trim().toLowerCase()).filter(Boolean),
      inkByChannel: { cmyk: ink.cmykInkMl, white: ink.whiteInkMl, gloss: ink.glossInkMl },
    });
    return { ...entryBase, fingerprint };
  });
}

export function versaworksParseWarningCount(entries: VersaworksEntry[]): number {
  return entries.filter((entry) => entry.warnings.length > 0).length;
}

// ---------- row-level duplicate protection ----------

// Natural key on plain queryable columns only (never array position or import
// timestamp): shop + software + source job name + machine + status/event +
// start/end stamps. Blank-timestamp rows additionally key on inkMl and sqft so
// two different blank-time jobs with the same name are not conflated. Repeated
// exports and overlapping date ranges produce identical keys and are skipped.
export function versaworksRowDedupeWhere(shop: string, entry: VersaworksEntry): Record<string, unknown> {
  const where: Record<string, unknown> = {
    shop,
    printerSoftware: VERSAWORKS_SOURCE,
    sourceJobName: entry.jobName || "",
    machineName: entry.machineName || "",
    status: entry.event || "",
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
  if (!entry.startedAt && !entry.completedAt) {
    where.inkMl = entry.inkMl;
    where.sqft = entry.sqft;
  }
  return where;
}

// ---------- conservative matching ----------

export function normalizeJobName(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type VersaworksMatchDecision = {
  productionJobId: string | null;
  // 15H.2: widened — the shared strict resolver supplies its canonical
  // confidence names (exact_item_ticket / exact_rip_job_name / ...) while the
  // legacy pure decider keeps emitting ticket_exact / rip_job_name_exact.
  matchMethod: string | null;
  matchFlag: string | null;
  candidateJobIds: string[];
  ticketCandidateCount: number;
  ripNameCandidateCount: number;
  matchReasons?: string[];
};

// Two-stage, exact-only decision:
//   1. exact normalized ticket — one job attaches, two+ is ambiguous;
//   2. only when NO ticket candidates exist: exact normalized ripJobName
//      equality (never contains) — one attaches, two+ ambiguous.
// Anything non-exact stays unmatched; the review page computes similarity
// suggestions live and the operator confirms. Never first-match-wins.
export function decideVersaworksMatch(params: {
  ticketCandidates: { id: string }[];
  ripNameJobIds: string[];
}): VersaworksMatchDecision {
  const tickets = params.ticketCandidates.map((job) => job.id);
  if (tickets.length === 1) {
    return { productionJobId: tickets[0], matchMethod: "ticket_exact", matchFlag: null, candidateJobIds: tickets, ticketCandidateCount: 1, ripNameCandidateCount: 0 };
  }
  if (tickets.length > 1) {
    return { productionJobId: null, matchMethod: null, matchFlag: VERSAWORKS_AMBIGUOUS_FLAG, candidateJobIds: tickets.slice(0, 5), ticketCandidateCount: tickets.length, ripNameCandidateCount: 0 };
  }
  const ripIds = [...new Set(params.ripNameJobIds)];
  if (ripIds.length === 1) {
    return { productionJobId: ripIds[0], matchMethod: "rip_job_name_exact", matchFlag: null, candidateJobIds: ripIds, ticketCandidateCount: 0, ripNameCandidateCount: 1 };
  }
  if (ripIds.length > 1) {
    return { productionJobId: null, matchMethod: null, matchFlag: VERSAWORKS_AMBIGUOUS_FLAG, candidateJobIds: ripIds.slice(0, 5), ticketCandidateCount: 0, ripNameCandidateCount: ripIds.length };
  }
  return { productionJobId: null, matchMethod: null, matchFlag: null, candidateJobIds: [], ticketCandidateCount: 0, ripNameCandidateCount: 0 };
}

// Distinct job IDs whose stored ProductionJobItem.ripJobName is EXACTLY equal
// (normalized) to this row's job name. Containment is deliberately not
// considered — that is suggestion territory for the review page.
export function ripNameJobIdsFor(
  jobName: string,
  ripItems: { jobId: string; ripJobName: string | null }[],
): string[] {
  const target = normalizeJobName(jobName);
  if (target.length < 4) return [];
  const ids = new Set<string>();
  for (const item of ripItems) {
    if (normalizeJobName(item.ripJobName) === target) ids.add(item.jobId);
  }
  return [...ids];
}

// ---------- transparent rawRow metadata ----------

// Original CSV keys are spread first and NEVER overwritten (VersaWorks headers
// contain spaces/brackets, so `matchFlag`/`matchMeta` cannot collide). The
// top-level matchFlag keeps 13A.6C review-page classification working; the
// matchMeta block is additive forensic detail.
export function buildVersaworksRawRow(entry: VersaworksEntry, decision: VersaworksMatchDecision): Record<string, unknown> {
  // 15F.0J.4: widened-capture block. Quality/eligibility computed ONCE at
  // import; calibration eligibility is separate from actual-cost inclusion.
  const quality = runtimeQualityFlags({
    eventClass: entry.eventClass,
    printSeconds: entry.printSeconds,
    layoutSqft: entry.sqft,
    printStart: entry.startedAt,
    printEnd: entry.completedAt,
  });
  return {
    ...entry.raw,
    ...(decision.matchFlag ? { matchFlag: decision.matchFlag } : {}),
    timingBasis: entry.timingBasis,
    _gso: {
      captureVersion: RIP_CAPTURE_VERSION,
      sourceRecordFingerprint: entry.fingerprint,
      eventClass: entry.eventClass,
      copies: entry.copies,
      pageWidthIn: entry.pageWidthIn,
      pageFeedIn: entry.pageFeedIn,
      outputWidthIn: entry.outputWidthIn,
      outputFeedIn: entry.outputFeedIn,
      layoutSqft: entry.sqft,
      printSeconds: entry.printSeconds,
      ripSeconds: entry.ripSeconds,
      qualityFlags: quality.flags,
      calibrationEligible: quality.calibrationEligible,
      actualCostEligible: quality.actualCostEligible,
      exclusionReason: quality.exclusionReason,
      matchMethod:
        decision.matchMethod === "ticket_exact" || decision.matchMethod === "exact_job_ticket" || decision.matchMethod === "exact_item_ticket"
          ? "EXACT_TICKET"
          : decision.matchMethod === "rip_job_name_exact" || decision.matchMethod === "exact_rip_job_name" || decision.matchMethod === "exact_stored_filename"
            ? "EXACT_NORMALIZED_FILENAME"
            : decision.matchFlag
              ? "PROBABLE_METADATA"
              : "UNMATCHED",
    },
    matchMeta: {
      matchMethod: decision.matchMethod,
      matchReasons: decision.matchReasons || [],
      normalizedTicket: entry.jobTicket || null,
      normalizedJobName: normalizeJobName(entry.jobName) || null,
      ticketCandidateCount: decision.ticketCandidateCount,
      ripNameCandidateCount: decision.ripNameCandidateCount,
      candidateJobIds: decision.candidateJobIds.slice(0, 5),
      warnings: entry.warnings,
    },
  };
}
