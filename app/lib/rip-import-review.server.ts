// RIP Import Review (13A.6C): pure logic for the review + safe-rematch page.
// No Prisma, no network — the route passes data in, tests import directly.
//
// Safety contract enforced here:
// - a mutation updates ONLY PrintLogEntry.productionJobId + rawRow (audit),
//   never ink, timing, sourceJobName, jobTicket, or import fields;
// - rawRow audit appends preserve every original byte (verbatim wrap when the
//   stored text is not parseable JSON);
// - stale writes are rejected by expected-value comparison (PrintLogEntry has
//   no updatedAt column);
// - candidates are suggestions only — nothing here auto-attaches.

import type { CandidateConfidence, ReviewStatus } from "./rip-import-review-shared";

export const AMBIGUOUS_MATCH_FLAG = "ambiguous_ticket_needs_review";
export const REMATCH_METHOD = "manual_review";
export const MAX_AUDIT_ENTRIES = 20;

export type ReviewEntryInput = {
  id: string;
  importId: string;
  productionJobId: string | null;
  jobTicket: string | null;
  sourceJobName: string | null;
  printerSoftware: string | null;
  machineName: string | null;
  mediaName: string | null;
  status: string | null;
  inkMl: number;
  printMinutes: number;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  rawRow: string | null;
};

export type CandidateJob = {
  id: string;
  jobTicket: string | null;
  customerName: string | null;
  company: string | null;
  status: string;
  createdAt: Date | string;
};

export type Candidate = {
  job: CandidateJob;
  confidence: CandidateConfidence;
  reason: string;
};

export function parseRawRow(rawRow: string | null): Record<string, unknown> | null {
  if (!rawRow) return null;
  try {
    const parsed = JSON.parse(rawRow);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function classifyEntry(entry: Pick<ReviewEntryInput, "productionJobId" | "rawRow">): ReviewStatus {
  if (entry.productionJobId) return "attached";
  const raw = parseRawRow(entry.rawRow);
  if (raw && raw.matchFlag === AMBIGUOUS_MATCH_FLAG) return "ambiguous";
  return "unmatched";
}

// Human-readable parser warnings for one row, mirroring parseWarningCount's
// criteria (13A.6B) plus the ambiguity + missing-ticket review flags.
export function entryWarnings(entry: Pick<ReviewEntryInput, "jobTicket" | "rawRow" | "productionJobId">): string[] {
  const warnings: string[] = [];
  const raw = parseRawRow(entry.rawRow);
  if (raw) {
    if (raw.inkBasis === "missing_inkuse") warnings.push("Blank KEY_INKUSE — no ink reading (never zero-faked).");
    if (raw.arrangeAssumed === true) warnings.push("Arrange count missing — 1 assumed for the ink estimate.");
    if (raw.timingBasis === "rip_only_no_print_times") warnings.push("RIP times only — no print duration recorded.");
    if (raw.matchFlag === AMBIGUOUS_MATCH_FLAG) warnings.push("Two or more production jobs share this ticket — pick one below.");
    if (raw._originalRawRowParseFailed === true) warnings.push("Original raw row was not valid JSON — preserved verbatim.");
  } else if (entry.rawRow) {
    warnings.push("Raw row is not parseable JSON — details unavailable.");
  }
  if (!entry.jobTicket && !entry.productionJobId) warnings.push("No GSO ticket detected in the RIP job name.");
  // 15F.0J.4: widened-capture quality flags + match method (stored in the
  // immutable _gso block at import time) surface directly in review.
  const gso = raw && raw._gso && typeof raw._gso === "object" ? (raw._gso as Record<string, unknown>) : null;
  if (gso) {
    if (Array.isArray(gso.qualityFlags) && gso.qualityFlags.length) warnings.push(`Quality flags: ${(gso.qualityFlags as string[]).join(", ")}.`);
    if (gso.calibrationEligible === false && gso.actualCostEligible === true) warnings.push("Occupancy-cost eligible but EXCLUDED from speed calibration.");
    if (gso.eventClass === "canceled") warnings.push("CANCELED event — retained for audit, never a production actual.");
    if (gso.eventClass === "error") warnings.push("ERROR event — retained for audit, never a production actual.");
    if (typeof gso.matchMethod === "string" && gso.matchMethod === "PROBABLE_METADATA") warnings.push("PROBABLE match — review-only; cannot feed finalized actuals without manual approval.");
  }
  return warnings;
}

// Timing details for display, covering both stored formats: RasterLink rows
// keep RIP/cut/vec stamps inside rawRow; VersaWorks rows keep the original
// CSV column values. Display-only — nothing here feeds any computation.
export function timingDetails(entry: Pick<ReviewEntryInput, "rawRow">): { label: string; value: string }[] {
  const raw = parseRawRow(entry.rawRow);
  if (!raw) return [];
  const out: { label: string; value: string }[] = [];
  const push = (label: string, value: unknown) => {
    const text = value == null ? "" : String(value);
    if (text) out.push({ label, value: text });
  };
  push("RIP start", raw.ripStart ?? raw["RIP Start Time"]);
  push("RIP end", raw.ripEnd ?? raw["RIP End Time"]);
  push("Print start", raw["Print Start Time"]);
  push("Print end", raw["Print End Time"]);
  push("Cut start", raw.cutStart);
  push("Cut end", raw.cutEnd);
  push("Vector start", raw.vecStart);
  push("Vector end", raw.vecEnd);
  if (typeof raw.ripMinutes === "number" && raw.ripMinutes > 0) push("RIP minutes", raw.ripMinutes.toFixed(1));
  if (typeof raw.cutMinutes === "number" && raw.cutMinutes > 0) push("Cut minutes", raw.cutMinutes.toFixed(1));
  if (typeof raw.vecMinutes === "number" && raw.vecMinutes > 0) push("Vector minutes", raw.vecMinutes.toFixed(1));
  push("Timing basis", raw.timingBasis);
  return out;
}

export type ReviewFilters = {
  status: string; // unresolved | unmatched | ambiguous | attached | all
  source: string; // all | rasterlink | versaworks | other
  q: string;
  warningsOnly: boolean;
};

export type ClassifiedEntry = ReviewEntryInput & { reviewStatus: ReviewStatus; warnings: string[] };

export function classifyEntries(entries: ReviewEntryInput[]): ClassifiedEntry[] {
  return entries.map((entry) => ({ ...entry, reviewStatus: classifyEntry(entry), warnings: entryWarnings(entry) }));
}

function sourceBucket(printerSoftware: string | null): string {
  const value = String(printerSoftware || "").toLowerCase();
  if (value === "rasterlink") return "rasterlink";
  if (value === "versaworks") return "versaworks";
  return "other";
}

// In-memory filtering over a bounded fetch. Deliberate: ambiguity and parser
// warnings live inside rawRow JSON (not SQL-filterable per the no-rawRow-query
// rule), and contains-search behaves differently on SQLite vs Postgres — this
// keeps both correct and identical across dev/prod.
export function filterEntries(entries: ClassifiedEntry[], filters: ReviewFilters): ClassifiedEntry[] {
  const q = filters.q.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.status === "unresolved" && entry.reviewStatus === "attached") return false;
    if (filters.status === "unmatched" && entry.reviewStatus !== "unmatched") return false;
    if (filters.status === "ambiguous" && entry.reviewStatus !== "ambiguous") return false;
    if (filters.status === "attached" && entry.reviewStatus !== "attached") return false;
    if (filters.source !== "all" && sourceBucket(entry.printerSoftware) !== filters.source) return false;
    if (filters.warningsOnly && entry.warnings.length === 0) return false;
    if (q) {
      const haystack = [entry.sourceJobName, entry.jobTicket, entry.machineName, entry.mediaName, entry.status]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export function paginate<T>(list: T[], page: number, pageSize: number): { pageItems: T[]; page: number; pageCount: number; total: number } {
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  return { pageItems: list.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pageCount, total };
}

// Structured, safe subset of PrintLogImport.notes. The RasterLink pipeline
// writes "sha256:<hex>\nrows:N created:N ..." — we surface ONLY recognized
// key:value counters and a shortened hash. Free-text operator notes are never
// returned (they may contain anything; the upload token lives in a different
// table and is never queried by this page).
export function parseImportSummary(notes: string | null): {
  fileHashShort: string | null;
  outcome: string | null;
  counters: { label: string; value: number }[];
} {
  const text = String(notes || "");
  const hashMatch = text.match(/sha256:([0-9a-f]{8})[0-9a-f]*/i);
  const counterKeys: [string, string][] = [
    ["rows", "Rows"],
    ["created", "Created"],
    ["duplicatesSkipped", "Duplicates skipped"],
    ["matched", "Matched"],
    ["ambiguous", "Ambiguous"],
    ["parseWarnings", "Parse warnings"],
  ];
  const counters: { label: string; value: number }[] = [];
  for (const [key, label] of counterKeys) {
    const match = text.match(new RegExp(`\\b${key}:(\\d+)`));
    if (match) counters.push({ label, value: Number(match[1]) });
  }
  const outcomeMatch = text.match(/\boutcome:([a-z_]+)/);
  return {
    fileHashShort: hashMatch ? hashMatch[1] : null,
    outcome: outcomeMatch ? outcomeMatch[1] : null,
    counters,
  };
}

function normalizeName(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Candidate ranking — suggestions only, nothing auto-saves:
//   1. exact_ticket: job ticket equals the extracted ticket (case-insensitive)
//   2. rip_job_name: a ProductionJobItem.ripJobName matches the source name
//   3. name_similarity: the job's ticket appears inside the source job name
// Two+ exact hits are all listed (that IS the ambiguous case) and stay
// unresolved until the operator confirms one.
export function rankCandidates(
  entry: Pick<ReviewEntryInput, "jobTicket" | "sourceJobName">,
  jobs: CandidateJob[],
  ripNames: { jobId: string; ripJobName: string | null }[] = [],
  limit = 5,
): Candidate[] {
  const ticket = String(entry.jobTicket || "").trim().toUpperCase();
  const sourceNorm = normalizeName(entry.sourceJobName);
  const ripByJob = new Map<string, string[]>();
  for (const item of ripNames) {
    if (!item.ripJobName) continue;
    const list = ripByJob.get(item.jobId) || [];
    list.push(item.ripJobName);
    ripByJob.set(item.jobId, list);
  }

  const scored: (Candidate & { score: number })[] = [];
  for (const job of jobs) {
    const jobTicket = String(job.jobTicket || "").trim().toUpperCase();
    if (ticket && jobTicket && jobTicket === ticket) {
      scored.push({ job, confidence: "exact_ticket", reason: `Job ticket ${jobTicket} equals the extracted ticket.`, score: 3 });
      continue;
    }
    const ripMatch = (ripByJob.get(job.id) || []).find((name) => {
      const norm = normalizeName(name);
      return norm.length >= 4 && sourceNorm.length >= 4 && (norm === sourceNorm || norm.includes(sourceNorm) || sourceNorm.includes(norm));
    });
    if (ripMatch) {
      scored.push({ job, confidence: "rip_job_name", reason: `Job item RIP name "${ripMatch}" resembles the source file name.`, score: 2 });
      continue;
    }
    const ticketNorm = normalizeName(job.jobTicket);
    if (ticketNorm.length >= 4 && sourceNorm.includes(ticketNorm)) {
      scored.push({ job, confidence: "name_similarity", reason: `Job ticket ${jobTicket} appears inside the source job name.`, score: 1 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score: _score, ...candidate }) => candidate);
}

export type RematchAuditEntry = {
  action: "attach" | "detach";
  previousProductionJobId: string | null;
  newProductionJobId: string | null;
  at: string;
  method: typeof REMATCH_METHOD;
  shop: string;
  via: "rip-import-review";
};

export function makeAuditEntry(params: {
  action: "attach" | "detach";
  previousProductionJobId: string | null;
  newProductionJobId: string | null;
  shop: string;
  at?: Date;
}): RematchAuditEntry {
  return {
    action: params.action,
    previousProductionJobId: params.previousProductionJobId,
    newProductionJobId: params.newProductionJobId,
    at: (params.at || new Date()).toISOString(),
    method: REMATCH_METHOD,
    shop: params.shop,
    via: "rip-import-review",
  };
}

// Append audit metadata to rawRow WITHOUT touching any parser value.
// - Parseable JSON object: add/extend ONLY the reserved `rematchAudit` key.
// - Anything else (legacy/truncated text): preserve the original text verbatim
//   inside a wrapper object — no byte of parser output is ever lost.
// History is capped at MAX_AUDIT_ENTRIES (oldest dropped).
export function appendRematchAudit(rawRow: string | null, audit: RematchAuditEntry): string {
  const parsed = parseRawRow(rawRow);
  if (parsed) {
    const history = Array.isArray(parsed.rematchAudit) ? (parsed.rematchAudit as RematchAuditEntry[]) : [];
    return JSON.stringify({ ...parsed, rematchAudit: [...history, audit].slice(-MAX_AUDIT_ENTRIES) });
  }
  if (rawRow == null || rawRow === "") {
    return JSON.stringify({ rematchAudit: [audit] });
  }
  return JSON.stringify({ _originalRawRowText: rawRow, _originalRawRowParseFailed: true, rematchAudit: [audit] });
}

// The ONLY update payload mutations are allowed to produce: exactly
// { productionJobId, rawRow }. Ink, timing, names, tickets, and import
// linkage are immutable here by construction.
export function buildEntryUpdate(
  entry: Pick<ReviewEntryInput, "productionJobId" | "rawRow">,
  newProductionJobId: string | null,
  shop: string,
  at?: Date,
): { productionJobId: string | null; rawRow: string } {
  const audit = makeAuditEntry({
    action: newProductionJobId ? "attach" : "detach",
    previousProductionJobId: entry.productionJobId,
    newProductionJobId,
    shop,
    at,
  });
  return { productionJobId: newProductionJobId, rawRow: appendRematchAudit(entry.rawRow, audit) };
}

// Shop-scoped lookup filters — every entry/job read in the route goes through
// these, so a cross-shop ID can never resolve to a row.
export function scopedEntryWhere(shop: string, id: string): { id: string; shop: string } {
  return { id, shop };
}
export function scopedJobWhere(shop: string, id: string): { id: string; shop: string } {
  return { id, shop };
}

export type MutationValidation = { ok: true } | { ok: false; error: string };

// Server-side validation shared by attach/detach. `entry`/`job` are the
// results of shop-scoped lookups — null means "not found in this shop"
// (covers both missing and cross-shop IDs).
export function validateMutation(params: {
  intent: "rematch" | "unmatch";
  entry: Pick<ReviewEntryInput, "id" | "productionJobId"> | null;
  job: CandidateJob | null;
  expectedJobId: string;
  confirm: string;
}): MutationValidation {
  if (params.confirm !== "yes") {
    return { ok: false, error: "Confirmation checkbox is required — nothing was changed." };
  }
  if (!params.entry) {
    return { ok: false, error: "Print log row not found in this shop — it may have been deleted. Refresh the page." };
  }
  const currentJobId = params.entry.productionJobId || "";
  if (currentJobId !== params.expectedJobId) {
    return { ok: false, error: "This row changed since the page loaded (stale data) — refresh and review again. Nothing was changed." };
  }
  if (params.intent === "rematch") {
    if (!params.job) {
      return { ok: false, error: "Production job not found in this shop — refresh and pick again. Nothing was changed." };
    }
    if (params.job.id === currentJobId) {
      return { ok: false, error: "Row is already attached to that production job — nothing to change." };
    }
  }
  if (params.intent === "unmatch" && !currentJobId) {
    return { ok: false, error: "Row is not attached to a production job — nothing to detach." };
  }
  return { ok: true };
}

// Bulk attach is allowed ONLY when every selected row is unresolved and all
// rows share the same exact source job name OR the same extracted ticket —
// otherwise the whole batch is rejected (no partial writes, no blind bulk).
export function bulkEligibility(
  entries: Pick<ReviewEntryInput, "productionJobId" | "jobTicket" | "sourceJobName" | "rawRow">[],
): { eligible: boolean; reason: string } {
  if (entries.length < 2) return { eligible: false, reason: "Select at least two rows for a bulk attach." };
  if (entries.some((entry) => entry.productionJobId)) {
    return { eligible: false, reason: "Bulk attach only applies to unresolved rows — one selected row is already attached." };
  }
  const tickets = new Set(entries.map((entry) => String(entry.jobTicket || "").trim().toUpperCase()));
  const names = new Set(entries.map((entry) => String(entry.sourceJobName || "").trim().toLowerCase()));
  const sameTicket = tickets.size === 1 && !tickets.has("");
  const sameName = names.size === 1 && !names.has("");
  if (!sameTicket && !sameName) {
    return { eligible: false, reason: "Selected rows do not share one exact ticket or one exact source job name — bulk attach is disabled." };
  }
  return { eligible: true, reason: sameTicket ? "All rows share one ticket." : "All rows share one source job name." };
}
