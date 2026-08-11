// Phase 15H.2 — ONE strict RIP-result identity matcher for every ingestion
// path (RasterLink, VersaWorks, legacy CSV, print-log uploads, manual UI).
//
// Deterministic order (owner-approved 15H.2-B):
//   1. exact ProductionJobItem.itemTicket   (canonical GSO-YYYYMMDD-NNNN-NN)
//   2. exact ProductionJobItem.ripJobName   (raw, then normalized equality)
//   3. exact canonical item ticket parsed from the source name (same as 1)
//   4. exact ProductionJob.jobTicket        (explicit or derived from item)
//   5. exact stored routed filename         (suggestedFileName, normalized)
//
// NOTHING loose: no contains, no substring, no first-match-wins, no recency
// proximity. Every lookup detects ambiguity (take:2 / full candidate sets)
// and two-plus candidates NEVER auto-attach. The DB unique indexes
// (shop, jobTicket) / (shop, itemTicket) from 15H.1 back these exact reads.

export const RIP_ITEM_TICKET_RE = /GSO-\d{8}-\d{4}-\d{2}(?!\d)/i;
export const RIP_JOB_TICKET_RE = /GSO-\d{8}-\d{4}(?!-?\d)/i;

export type RipMatchConfidence =
  | "exact_item_ticket"
  | "exact_rip_job_name"
  | "exact_job_ticket"
  | "exact_stored_filename"
  | "manual_owner_assignment"
  | "suggestion_only"
  | "ambiguous"
  | "unmatched";

export type RipIdentityResult = {
  status: "matched" | "unmatched" | "ambiguous";
  productionJobId: string | null;
  productionJobItemId: string | null;
  matchMethod: RipMatchConfidence | null;
  confidence: RipMatchConfidence;
  itemTicket: string | null;
  jobTicket: string | null;
  reasons: string[];
  candidateJobIds: string[];
};

// Only these confidences may authorize automatic actual-cost linkage or
// writeback (15H.2-I). Suggestions and ambiguity NEVER write costs.
export const ACTUALS_TRUSTED_CONFIDENCE: ReadonlySet<string> = new Set([
  "exact_item_ticket",
  "exact_rip_job_name",
  "exact_job_ticket",
  "exact_stored_filename",
  "manual_owner_assignment",
]);

export function normalizeRipIdentity(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type ParsedRipTickets = {
  itemTicket: string | null;
  jobTicket: string | null;
  // A GSO-prefixed token exists but is not a canonical ticket (legacy/test
  // names) — kept for DISPLAY continuity only; it never authorizes a match.
  noncanonicalTicket: string | null;
};

// Parse canonical tickets from RIP source names. Handles bare tickets,
// "TICKET_Customer_Product" watcher names, "TICKET__MACHINE__MODE__X__A1"
// routed names, and ".pdf"-suffixed variants — the regexes anchor on the
// exact canonical shapes so surrounding text can never distort them
// (15H.2-C: no blind stripping; the exact token is lifted wherever it sits).
export function parseRipTickets(...texts: Array<string | null | undefined>): ParsedRipTickets {
  let itemTicket: string | null = null;
  let jobTicket: string | null = null;
  let noncanonical: string | null = null;
  for (const text of texts) {
    const value = String(text || "");
    if (!value) continue;
    if (!itemTicket) {
      const item = value.match(RIP_ITEM_TICKET_RE);
      if (item) itemTicket = item[0].toUpperCase();
    }
    if (!jobTicket) {
      const job = value.match(RIP_JOB_TICKET_RE);
      if (job) jobTicket = job[0].toUpperCase();
    }
    if (!itemTicket && !jobTicket && !noncanonical) {
      const legacy = value.match(/\bGSO[-_ ][A-Z0-9][A-Z0-9 _-]{4,}\b/i);
      if (legacy) noncanonical = legacy[0].replace(/_/g, "-").replace(/\s+/g, "-").toUpperCase();
    }
  }
  if (!jobTicket && itemTicket) jobTicket = itemTicket.slice(0, -3); // GSO-YYYYMMDD-NNNN
  return { itemTicket, jobTicket, noncanonicalTicket: noncanonical };
}

export type RipNameIndexItem = {
  id: string;
  jobId: string;
  ripJobName: string | null;
  suggestedFileName: string | null;
};

// Bounded normalized-name index for stages 2b/5 (VersaWorks-parity behavior,
// now applied to EVERY source). One query per import file, newest first.
export async function loadRipNameIndex(db: any, shop: string): Promise<RipNameIndexItem[]> {
  return db.productionJobItem.findMany({
    where: { shop, OR: [{ ripJobName: { not: null } }, { suggestedFileName: { not: null } }] },
    select: { id: true, jobId: true, ripJobName: true, suggestedFileName: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
}

function unmatchedResult(parsed: ParsedRipTickets, reasons: string[]): RipIdentityResult {
  return {
    status: "unmatched",
    productionJobId: null,
    productionJobItemId: null,
    matchMethod: null,
    confidence: "unmatched",
    itemTicket: parsed.itemTicket,
    jobTicket: parsed.jobTicket || parsed.noncanonicalTicket,
    reasons,
    candidateJobIds: [],
  };
}

function ambiguousResult(parsed: ParsedRipTickets, reason: string, candidateJobIds: string[]): RipIdentityResult {
  return {
    status: "ambiguous",
    productionJobId: null,
    productionJobItemId: null,
    matchMethod: null,
    confidence: "ambiguous",
    itemTicket: parsed.itemTicket,
    jobTicket: parsed.jobTicket || parsed.noncanonicalTicket,
    reasons: [reason],
    candidateJobIds: candidateJobIds.slice(0, 5),
  };
}

function matchedResult(
  parsed: ParsedRipTickets,
  method: RipIdentityResult["matchMethod"] & string,
  jobId: string,
  itemId: string | null,
  reasons: string[],
): RipIdentityResult {
  return {
    status: "matched",
    productionJobId: jobId,
    productionJobItemId: itemId,
    matchMethod: method,
    confidence: method,
    itemTicket: parsed.itemTicket,
    jobTicket: parsed.jobTicket,
    reasons,
    candidateJobIds: [jobId],
  };
}

// The ONE resolver. `names` are the RIP-reported identifiers (job name,
// file name); `ripNameIndex` may be preloaded once per import file.
export async function resolveRipIdentity(
  db: any,
  shop: string,
  names: { jobName?: string | null; fileName?: string | null },
  options: { ripNameIndex?: RipNameIndexItem[] } = {},
): Promise<RipIdentityResult> {
  const parsed = parseRipTickets(names.jobName, names.fileName);
  const reasons: string[] = [];

  // 1+3. exact item ticket (parsed from wherever it sits in the name)
  if (parsed.itemTicket) {
    const items = await db.productionJobItem.findMany({
      where: { shop, itemTicket: parsed.itemTicket },
      select: { id: true, jobId: true },
      take: 2,
    });
    if (items.length === 1) return matchedResult(parsed, "exact_item_ticket", items[0].jobId, items[0].id, reasons);
    if (items.length > 1) return ambiguousResult(parsed, `ambiguous_item_ticket:${parsed.itemTicket}`, items.map((item: any) => item.jobId));
    reasons.push(`unknown_item_ticket:${parsed.itemTicket}`);
  }

  // 2. exact ripJobName — raw equality first (indexed), covering names with
  // and without the original extension.
  const rawNames = [...new Set([names.jobName, names.fileName]
    .map((value) => String(value || "").trim())
    .flatMap((value) => (value ? [value, value.replace(/\.[a-z0-9]{1,5}$/i, "")] : []))
    .filter((value) => value.length >= 4))];
  if (rawNames.length) {
    const items = await db.productionJobItem.findMany({
      where: { shop, ripJobName: { in: rawNames } },
      select: { id: true, jobId: true },
      take: 2,
    });
    if (items.length === 1) return matchedResult(parsed, "exact_rip_job_name", items[0].jobId, items[0].id, reasons);
    if (items.length > 1) return ambiguousResult(parsed, `ambiguous_rip_job_name:${rawNames[0]}`, items.map((item: any) => item.jobId));
  }

  // 2b. normalized ripJobName equality over the bounded index (VersaWorks
  // parity — case/punctuation tolerant, EQUALITY ONLY, never containment).
  const sourceIdentity = normalizeRipIdentity(names.jobName || names.fileName);
  const index = options.ripNameIndex ?? (sourceIdentity.length >= 4 ? await loadRipNameIndex(db, shop) : []);
  if (sourceIdentity.length >= 4) {
    const ripHits = index.filter((item) => normalizeRipIdentity(item.ripJobName) === sourceIdentity);
    const uniqueRip = [...new Map(ripHits.map((item) => [item.id, item])).values()];
    if (uniqueRip.length === 1) return matchedResult(parsed, "exact_rip_job_name", uniqueRip[0].jobId, uniqueRip[0].id, reasons);
    if (uniqueRip.length > 1) return ambiguousResult(parsed, `ambiguous_rip_job_name:${sourceIdentity}`, uniqueRip.map((item) => item.jobId));
  }

  // 4. exact job ticket (explicit, or derived from an unknown item ticket)
  if (parsed.jobTicket) {
    const jobs = await db.productionJob.findMany({
      where: { shop, jobTicket: parsed.jobTicket },
      select: { id: true },
      take: 2,
    });
    if (jobs.length === 1) {
      // Item stays null on job-level matches — item attribution is a separate,
      // labeled step (rip-duration) and single-item heuristics never persist
      // as exact (15H.2-H).
      return matchedResult(parsed, "exact_job_ticket", jobs[0].id, null, reasons);
    }
    if (jobs.length > 1) return ambiguousResult(parsed, `ambiguous_job_ticket:${parsed.jobTicket}`, jobs.map((job: any) => job.id));
    reasons.push(`unknown_job_ticket:${parsed.jobTicket}`);
  }

  // 5. exact stored routed filename (suggestedFileName, normalized equality)
  if (sourceIdentity.length >= 4) {
    const nameHits = index.filter((item) => normalizeRipIdentity(item.suggestedFileName) === sourceIdentity);
    const uniqueNames = [...new Map(nameHits.map((item) => [item.id, item])).values()];
    if (uniqueNames.length === 1) return matchedResult(parsed, "exact_stored_filename", uniqueNames[0].jobId, uniqueNames[0].id, reasons);
    if (uniqueNames.length > 1) return ambiguousResult(parsed, `ambiguous_stored_filename:${sourceIdentity}`, uniqueNames.map((item) => item.jobId));
  }

  if (!parsed.itemTicket && !parsed.jobTicket) {
    reasons.push(parsed.noncanonicalTicket ? `noncanonical_ticket_identity:${parsed.noncanonicalTicket}` : "no_ticket_identity");
  }
  return unmatchedResult(parsed, reasons);
}

// 15H.2-I: verification-based trust for actual-cost writeback over ALREADY
// ATTACHED rows. Historical rows may carry loose legacy labels — trust is
// therefore RE-VERIFIED against the attached job's own identity instead of
// believing stored method strings. Manual review rematches (rematchAudit)
// are owner assignments and always trusted.
export function assessEntryIdentityTrust(
  entry: { jobTicket: string | null; sourceJobName: string | null; rawRow?: string | null; productionJobItemId?: string | null },
  job: { jobTicket: string | null; items: Array<{ itemTicket?: string | null; ripJobName?: string | null; suggestedFileName?: string | null }> },
): { trusted: boolean; basis: RipMatchConfidence | "untrusted" } {
  const raw = (() => {
    try { return entry.rawRow ? JSON.parse(entry.rawRow) : null; } catch { return null; }
  })();
  if (raw && Array.isArray(raw.rematchAudit) && raw.rematchAudit.length) {
    return { trusted: true, basis: "manual_owner_assignment" };
  }
  const entryTicket = String(entry.jobTicket || "").trim().toUpperCase();
  const jobTicket = String(job.jobTicket || "").trim().toUpperCase();
  if (entryTicket && jobTicket && entryTicket === jobTicket) return { trusted: true, basis: "exact_job_ticket" };
  if (entryTicket && job.items.some((item) => String(item.itemTicket || "").trim().toUpperCase() === entryTicket)) {
    return { trusted: true, basis: "exact_item_ticket" };
  }
  const sourceIdentity = normalizeRipIdentity(entry.sourceJobName);
  if (sourceIdentity.length >= 4) {
    if (job.items.some((item) => normalizeRipIdentity(item.ripJobName) === sourceIdentity)) {
      return { trusted: true, basis: "exact_rip_job_name" };
    }
    if (job.items.some((item) => normalizeRipIdentity(item.suggestedFileName) === sourceIdentity)) {
      return { trusted: true, basis: "exact_stored_filename" };
    }
  }
  return { trusted: false, basis: "untrusted" };
}
