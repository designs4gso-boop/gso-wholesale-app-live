// RIP duration reliability + exact item attribution (13A.7C). Pure — no
// Prisma, no network; routes pass data in, tests import directly.
//
// Duration precedence (owner-approved order, documented in the state doc):
//   1. Native explicit VersaWorks duration field — NOT AVAILABLE in the proven
//      export format (no field exists in the known header set, and no real
//      sample proves an alternate name; queue-vs-print semantics of a guessed
//      key would be invented evidence). Revisit when a real export shows one.
//   2. Exact Print Start + Print End stamps from the SAME source row
//      (rawRow's own fields — never the startedAt/completedAt columns, which
//      may hold RIP-fallback times). Derived, labeled, plausibility-gated.
//   3. Existing valid imported printMinutes (> 0) — e.g. RasterLink rows
//      (computed from print stamps at import) or legacy native columns.
//   4. Otherwise 0 with source "unknown" and a warning. NEVER derived from
//      file/import/queue/submission times, unrelated stamp pairs, speed,
//      sqft, ink, or printer averages.
//
// Plausibility gates for derived durations: end strictly after start, and at
// most MAX_PLAUSIBLE_PRINT_MINUTES (24h) — outside that, the row stays
// unknown with a warning rather than writing an implausible number.

export const MAX_PLAUSIBLE_PRINT_MINUTES = 24 * 60;

export type DurationSource = "derived_print_timestamps" | "imported_native" | "unknown";

export type DurationResolution = {
  minutes: number;
  source: DurationSource;
  printStartRaw: string | null;
  printEndRaw: string | null;
  warnings: string[];
};

export type DurationEntryInput = {
  printMinutes: number;
  status: string | null;
  rawRow: string | null;
};

function parseRawObject(rawRow: string | null): Record<string, unknown> | null {
  if (!rawRow) return null;
  try {
    const parsed = JSON.parse(rawRow);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseStamp(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Exact print stamps from the row's OWN raw fields. VersaWorks CSV columns
// ("Print Start Time"/"Print End Time") and RasterLink parser fields are
// recognized; RIP stamps are deliberately NOT — RIP time is never print time.
export function derivePrintDurationFromRaw(rawRow: string | null): { minutes: number | null; printStartRaw: string | null; printEndRaw: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const raw = parseRawObject(rawRow);
  if (!raw) return { minutes: null, printStartRaw: null, printEndRaw: null, warnings };
  const startRaw = String(raw["Print Start Time"] ?? "").trim() || null;
  const endRaw = String(raw["Print End Time"] ?? "").trim() || null;
  if (!startRaw || !endRaw) return { minutes: null, printStartRaw: startRaw, printEndRaw: endRaw, warnings };
  const start = parseStamp(startRaw);
  const end = parseStamp(endRaw);
  if (!start || !end) {
    warnings.push("Print timestamps present but unparseable — duration stays unknown.");
    return { minutes: null, printStartRaw: startRaw, printEndRaw: endRaw, warnings };
  }
  const minutes = (end.getTime() - start.getTime()) / 60000;
  if (minutes <= 0) {
    warnings.push("Print end is not after print start — implausible interval rejected, duration stays unknown.");
    return { minutes: null, printStartRaw: startRaw, printEndRaw: endRaw, warnings };
  }
  if (minutes > MAX_PLAUSIBLE_PRINT_MINUTES) {
    warnings.push(`Derived duration ${minutes.toFixed(0)} min exceeds the ${MAX_PLAUSIBLE_PRINT_MINUTES} min plausibility bound — rejected, duration stays unknown.`);
    return { minutes: null, printStartRaw: startRaw, printEndRaw: endRaw, warnings };
  }
  return { minutes: Math.round(minutes * 100) / 100, printStartRaw: startRaw, printEndRaw: endRaw, warnings };
}

export function resolvePrintDuration(entry: DurationEntryInput): DurationResolution {
  // Cut rows have no print duration by definition.
  if (String(entry.status || "").toLowerCase().startsWith("cut:")) {
    return { minutes: 0, source: "unknown", printStartRaw: null, printEndRaw: null, warnings: [] };
  }
  const derived = derivePrintDurationFromRaw(entry.rawRow);
  if (derived.minutes != null) {
    return { minutes: derived.minutes, source: "derived_print_timestamps", printStartRaw: derived.printStartRaw, printEndRaw: derived.printEndRaw, warnings: derived.warnings };
  }
  const stored = Number(entry.printMinutes) || 0;
  if (stored > 0) {
    return { minutes: stored, source: "imported_native", printStartRaw: derived.printStartRaw, printEndRaw: derived.printEndRaw, warnings: derived.warnings };
  }
  return {
    minutes: 0,
    source: "unknown",
    printStartRaw: derived.printStartRaw,
    printEndRaw: derived.printEndRaw,
    warnings: [...derived.warnings, "No reliable print duration (no native value, no exact print stamps) — machine time stays 0."],
  };
}

// Additive rawRow provenance block (backfill audit trail). Parseable JSON
// gains ONLY the named key; unparseable text is preserved verbatim in a
// wrapper — same contract as the 13A.6C rematchAudit appends.
export function appendRawRowBlock(rawRow: string | null, key: string, block: Record<string, unknown>): string {
  const parsed = parseRawObject(rawRow);
  if (parsed) return JSON.stringify({ ...parsed, [key]: block }).slice(0, 16000);
  if (rawRow == null || rawRow === "") return JSON.stringify({ [key]: block });
  return JSON.stringify({ _originalRawRowText: rawRow, _originalRawRowParseFailed: true, [key]: block });
}

export const RIP_BACKFILL_PHRASE = "APPLY VERIFIED RIP BACKFILL"; // exact + case-sensitive

// ---------- strict item attribution (13A.7C, precedence D) ----------

export type AttributionItem = {
  id: string;
  itemTicket: string | null;
  ripJobName: string | null;
  suggestedFileName: string | null;
  productTitle: string;
};

export type AttributionJob = {
  id: string;
  jobTicket: string | null;
  items: AttributionItem[];
  fileNames?: string[]; // ProductionJobFile fileName/originalFileName values (job-level only — the schema has no file->item link)
};

export type AttributionMethod =
  | "item_ticket"
  | "rip_name"
  | "job_file_single_item"
  | "single_item_fallback"
  | "job_level_only"
  | "unresolved_multiple"
  | "none";

export type ItemAttribution = {
  productionJobId: string;
  productionJobItemId: string | null;
  method: AttributionMethod;
  candidateCount: number;
  confidence: "exact" | "fallback" | "job_level" | "unresolved";
  warnings: string[];
};

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Strict, equality-only attribution. Never contains, fuzzy, partial, or
// first-match: two or more candidates at any tier stay unresolved.
export function attributeEntryToItem(
  entry: { productionJobItemId?: string | null; jobTicket: string | null; sourceJobName: string | null },
  job: AttributionJob,
): ItemAttribution {
  const warnings: string[] = [];

  // Already attributed (legacy import or previous backfill): respect it.
  if (entry.productionJobItemId) {
    const known = job.items.find((item) => item.id === entry.productionJobItemId);
    return {
      productionJobId: job.id,
      productionJobItemId: entry.productionJobItemId,
      method: "item_ticket",
      candidateCount: known ? 1 : 0,
      confidence: "exact",
      warnings: known ? [] : ["Stored productionJobItemId does not match a current job item — verify manually."],
    };
  }

  // 1. exact item ticket equality
  const entryTicket = String(entry.jobTicket || "").trim().toUpperCase();
  if (entryTicket) {
    const ticketHits = job.items.filter((item) => String(item.itemTicket || "").trim().toUpperCase() === entryTicket);
    if (ticketHits.length === 1) {
      return { productionJobId: job.id, productionJobItemId: ticketHits[0].id, method: "item_ticket", candidateCount: 1, confidence: "exact", warnings };
    }
    if (ticketHits.length > 1) {
      return { productionJobId: job.id, productionJobItemId: null, method: "unresolved_multiple", candidateCount: ticketHits.length, confidence: "unresolved", warnings: ["Item ticket matches multiple items — unresolved."] };
    }
  }

  // 2. exact RIP name equality (normalized, extension-insensitive)
  const sourceIdentity = normalizeIdentity(entry.sourceJobName);
  if (sourceIdentity.length >= 4) {
    const nameHits = job.items.filter((item) => {
      const identities = [item.ripJobName, item.suggestedFileName].map(normalizeIdentity);
      return identities.some((identity) => identity && identity === sourceIdentity);
    });
    if (nameHits.length === 1) {
      return { productionJobId: job.id, productionJobItemId: nameHits[0].id, method: "rip_name", candidateCount: 1, confidence: "exact", warnings };
    }
    if (nameHits.length > 1) {
      return { productionJobId: job.id, productionJobItemId: null, method: "unresolved_multiple", candidateCount: nameHits.length, confidence: "unresolved", warnings: ["RIP name matches multiple items — unresolved."] };
    }

    // 3. exact ProductionJobFile name — the schema links files to JOBS only,
    // so this tier can confirm the job identity but reaches an item only via
    // the single-item rule.
    const fileHit = (job.fileNames || []).some((name) => normalizeIdentity(name) === sourceIdentity);
    if (fileHit && job.items.length === 1) {
      return {
        productionJobId: job.id,
        productionJobItemId: job.items[0].id,
        method: "job_file_single_item",
        candidateCount: 1,
        confidence: "exact",
        warnings: ["Attributed via exact job-file name on a single-item job."],
      };
    }
  }

  // 4. single-item job fallback (recorded as fallback, never silent)
  if (job.items.length === 1) {
    return {
      productionJobId: job.id,
      productionJobItemId: job.items[0].id,
      method: "single_item_fallback",
      candidateCount: 1,
      confidence: "fallback",
      warnings: ["Single-item job fallback — no exact item identifier in the row."],
    };
  }

  // 5. job-ticket-only on a multi-item job stays job-level
  if (job.items.length > 1) {
    return { productionJobId: job.id, productionJobItemId: null, method: "job_level_only", candidateCount: job.items.length, confidence: "job_level", warnings: ["Multi-item job without an exact item identifier — job-level only."] };
  }

  return { productionJobId: job.id, productionJobItemId: null, method: "none", candidateCount: 0, confidence: "unresolved", warnings: ["Job has no items."] };
}
