// Automatic Print Intake routing (13A.6G): pure decision engine for mapping a
// file dropped in "Prints For Today" to exactly one production job/item and a
// machine key. No Prisma, no network, no filesystem — the endpoints pass data
// in and tests import directly.
//
// Safety contract:
// - deterministic hierarchy only (item ticket > job ticket w/ single item >
//   exact stored filename > exact stored job file > job subfolder identity);
// - NEVER first-match-wins, contains-only, fuzzy, nearest-date, or
//   customer-name matching; two+ candidates at any tier route NOTHING;
// - the server returns a machine KEY only — hot-folder paths live exclusively
//   in the local agent config (no local paths cross the wire or reach the UI);
// - machine routing follows the FINALIZED owner rules (see decideMachine):
//   white/gloss -> Roland LG-640 (normalized 13A.7B); explicit ERP Roland or a standalone ROLAND
//   filename tag -> Roland; all other CMYK-only -> Mimaki UCJV300 default.
//   Genuinely contradictory machine data still reviews, never guesses.

export const INTAKE_OUTCOMES_MARKER = "gso-print-intake-outcomes-v1";
export const MAX_INTAKE_OUTCOMES = 50;

export const ITEM_TICKET_RE = /GSO-\d{8}-\d{4}-\d{2}/i;
export const JOB_TICKET_RE = /GSO-\d{8}-\d{4}(?!-\d)/i;

export const ARTWORK_EXTENSIONS = [".pdf", ".eps", ".ai", ".tif", ".tiff", ".png", ".jpg", ".jpeg"];

export type IntakeJob = {
  id: string;
  jobTicket: string | null;
  customerName: string | null;
  company: string | null;
  status: string;
  artworkUrl: string | null;
  printFileUrl: string | null;
  items: IntakeItem[];
  fileNames: string[]; // ProductionJobFile fileName + originalFileName values
};

export type IntakeItem = {
  id: string;
  itemTicket: string | null;
  ripJobName: string | null;
  suggestedFileName: string | null;
  productTitle: string;
  selectedFinish: string | null;
  materialSummary: string | null;
  machineSummary: string | null;
};

export type IntakeCandidate = { jobTicket: string | null; itemTicket: string | null; productTitle: string | null; reason: string };

export type IntakeDecision = {
  decision: "route" | "review";
  rule: "item_ticket" | "job_ticket_single_item" | "stored_filename" | "job_file_name" | "job_subfolder" | null;
  jobId: string | null;
  itemId: string | null;
  jobTicket: string | null;
  itemTicket: string | null;
  ripName: string | null; // WITHOUT extension — the agent appends the original extension
  machine: "mimaki" | "roland" | null;
  machineRule: "white_or_gloss" | "explicit_roland_tag" | "explicit_erp_machine" | "default_cmyk" | null;
  reasons: string[];
  candidates: IntakeCandidate[];
};

// Normalized, extension-insensitive filename identity (same family as the
// ripJobName/jobinfo normalizers — lowercase, strip extension, collapse
// punctuation). Used ONLY for exact equality, never containment.
export function normalizeFileIdentity(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function basenameOf(value: string | null | undefined): string {
  const parts = String(value || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

export function isArtworkFileName(fileName: string): boolean {
  const lower = String(fileName || "").toLowerCase();
  return ARTWORK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function extractItemTicketFrom(text: string): string {
  const match = String(text || "").replace(/_/g, "-").match(ITEM_TICKET_RE);
  return match ? match[0].toUpperCase() : "";
}

export function extractJobTicketFrom(text: string): string {
  const match = String(text || "").replace(/_/g, "-").match(JOB_TICKET_RE);
  return match ? match[0].toUpperCase() : "";
}

// ---------- machine decision (conservative v1) ----------

const WHITE_GLOSS_TOKENS = ["white", "gloss", "clear", "varnish", "primer", "spot uv", "w+g"];

export function needsWhiteOrGloss(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  const haystack = [item.selectedFinish, item.materialSummary, item.machineSummary]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return WHITE_GLOSS_TOKENS.some((token) => haystack.includes(token));
}

export function assignedMachineOf(item: Pick<IntakeItem, "machineSummary">): "mimaki" | "roland" | null {
  const text = String(item.machineSummary || "").toLowerCase();
  const mimaki = text.includes("mimaki") || text.includes("ucjv");
  const roland = text.includes("roland") || text.includes("lg-540") || text.includes("lg-640") || text.includes("versaworks");
  if (mimaki && roland) return null; // contradictory
  if (mimaki) return "mimaki";
  if (roland) return "roland";
  return null;
}

// Standalone printer tag in the dropped filename: ROLAND delimited by
// non-letters (matches _ROLAND_, -roland., " ROLAND ") but never a substring
// of another word ("Rolando" does not match).
export function hasRolandFilenameTag(fileName: string): boolean {
  return /(?<![A-Za-z])ROLAND(?![A-Za-z])/i.test(String(fileName || ""));
}

export type MachineDecision = {
  machine: "mimaki" | "roland" | null;
  machineRule: IntakeDecision["machineRule"];
  reasons: string[];
};

// Finalized business routing rules (owner-approved, 13A.6G continuation):
//   1. white and/or gloss required        -> Roland LG-640 (normalized 13A.7B) (white_or_gloss)
//   2. CMYK-only + explicit ERP Roland    -> Roland (explicit_erp_machine)
//   3. CMYK-only + standalone ROLAND tag  -> Roland (explicit_roland_tag)
//   4. all other CMYK-only jobs           -> Mimaki UCJV300 (default_cmyk;
//      explicit ERP Mimaki also reports explicit_erp_machine)
// Genuinely contradictory data still reviews: an explicit Mimaki assignment
// on a job that needs white/gloss or carries the ROLAND tag, or a
// machineSummary naming both printers, never auto-routes.
export function decideMachine(item: IntakeItem, fileName = ""): MachineDecision {
  const whiteGloss = needsWhiteOrGloss(item);
  const assigned = assignedMachineOf(item);
  const rolandTag = hasRolandFilenameTag(fileName);
  if (String(item.machineSummary || "").trim() && assigned === null) {
    return { machine: null, machineRule: null, reasons: ["machine_summary_contradictory_or_unknown"] };
  }
  if (whiteGloss) {
    if (assigned === "mimaki") {
      // Mimaki is CMYK-only — an explicit Mimaki assignment on white/gloss
      // work is contradictory data, not a routable instruction.
      return { machine: null, machineRule: null, reasons: ["white_gloss_job_but_erp_assigned_mimaki_contradiction"] };
    }
    return { machine: "roland", machineRule: "white_or_gloss", reasons: ["white_or_gloss_requires_roland"] };
  }
  if (rolandTag) {
    if (assigned === "mimaki") {
      return { machine: null, machineRule: null, reasons: ["roland_filename_tag_but_erp_assigned_mimaki_contradiction"] };
    }
    return { machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] };
  }
  if (assigned === "roland") {
    return { machine: "roland", machineRule: "explicit_erp_machine", reasons: ["explicit_erp_roland_assignment"] };
  }
  if (assigned === "mimaki") {
    return { machine: "mimaki", machineRule: "explicit_erp_machine", reasons: ["explicit_erp_mimaki_assignment"] };
  }
  return { machine: "mimaki", machineRule: "default_cmyk", reasons: ["default_cmyk_to_mimaki"] };
}

// ---------- RIP name ----------

// Exact ERP-generated RIP name for the routed copy (no extension; the agent
// appends the original file's extension). Prefers the stored ripJobName, then
// the ITEM TICKET, then suggestedFileName — a ticket-led name is what the
// RasterLink result watcher extracts tickets from, so results auto-match.
// Sanitized to safe filename characters; never empty on a routable item.
export function ripFileBaseName(item: Pick<IntakeItem, "ripJobName" | "suggestedFileName" | "itemTicket">): string {
  const source = String(item.ripJobName || item.itemTicket || item.suggestedFileName || "").trim();
  return source.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

// ---------- deterministic mapping hierarchy ----------

function candidateOf(job: IntakeJob, item: IntakeItem | null, reason: string): IntakeCandidate {
  return { jobTicket: job.jobTicket, itemTicket: item ? item.itemTicket : null, productTitle: item ? item.productTitle : null, reason };
}

function review(reasons: string[], candidates: IntakeCandidate[] = []): IntakeDecision {
  return { decision: "review", rule: null, jobId: null, itemId: null, jobTicket: null, itemTicket: null, ripName: null, machine: null, machineRule: null, reasons, candidates: candidates.slice(0, 5) };
}

function routeItem(job: IntakeJob, item: IntakeItem, rule: NonNullable<IntakeDecision["rule"]>, fileName: string): IntakeDecision {
  const machineDecision = decideMachine(item, fileName);
  if (!machineDecision.machine) {
    return review([`matched_by_${rule}_but_machine_unresolved`, ...machineDecision.reasons], [candidateOf(job, item, rule)]);
  }
  const ripName = ripFileBaseName(item);
  if (!ripName) {
    return review([`matched_by_${rule}_but_no_rip_name_on_item`], [candidateOf(job, item, rule)]);
  }
  return {
    decision: "route",
    rule,
    jobId: job.id,
    itemId: item.id,
    jobTicket: job.jobTicket,
    itemTicket: item.itemTicket,
    ripName,
    machine: machineDecision.machine,
    machineRule: machineDecision.machineRule,
    reasons: machineDecision.reasons,
    candidates: [candidateOf(job, item, rule)],
  };
}

export function decideIntakeRoute(params: { fileName: string; subfolder?: string | null; jobs: IntakeJob[] }): IntakeDecision {
  const fileName = basenameOf(params.fileName);
  if (!isArtworkFileName(fileName)) return review(["not_an_artwork_file_type"]);
  const fileIdentity = normalizeFileIdentity(fileName);
  const subfolder = String(params.subfolder || "").trim();

  // (a) exact item ticket in the filename
  const itemTicket = extractItemTicketFrom(fileName);
  if (itemTicket) {
    const hits: { job: IntakeJob; item: IntakeItem }[] = [];
    for (const job of params.jobs) {
      for (const item of job.items) {
        if (String(item.itemTicket || "").toUpperCase() === itemTicket) hits.push({ job, item });
      }
    }
    if (hits.length === 1) return routeItem(hits[0].job, hits[0].item, "item_ticket", fileName);
    if (hits.length > 1) return review(["item_ticket_matches_multiple_items"], hits.map((hit) => candidateOf(hit.job, hit.item, "item_ticket")));
    return review([`item_ticket_${itemTicket}_not_found_in_eligible_jobs`]);
  }

  // (b) exact job ticket in the filename — single eligible item only
  const jobTicket = extractJobTicketFrom(fileName);
  if (jobTicket) {
    const jobs = params.jobs.filter((job) => String(job.jobTicket || "").toUpperCase() === jobTicket);
    if (jobs.length > 1) return review(["job_ticket_matches_multiple_jobs"], jobs.map((job) => candidateOf(job, null, "job_ticket")));
    if (jobs.length === 1) {
      const job = jobs[0];
      if (job.items.length === 1) return routeItem(job, job.items[0], "job_ticket_single_item", fileName);
      return review(
        ["job_ticket_matches_job_with_multiple_items_pick_item_in_review"],
        job.items.map((item) => candidateOf(job, item, "job_ticket_multiple_items")),
      );
    }
    return review([`job_ticket_${jobTicket}_not_found_in_eligible_jobs`]);
  }

  // (c) exact normalized filename vs stored per-item/job print names
  if (fileIdentity.length >= 6) {
    const nameHits: { job: IntakeJob; item: IntakeItem }[] = [];
    for (const job of params.jobs) {
      for (const item of job.items) {
        const identities = [item.suggestedFileName, item.ripJobName].map(normalizeFileIdentity);
        if (identities.some((identity) => identity && identity === fileIdentity)) nameHits.push({ job, item });
      }
      const jobIdentities = [basenameOf(job.printFileUrl), basenameOf(job.artworkUrl)].map(normalizeFileIdentity);
      if (jobIdentities.some((identity) => identity && identity === fileIdentity) && job.items.length === 1) {
        nameHits.push({ job, item: job.items[0] });
      }
    }
    const uniqueNameHits = nameHits.filter((hit, index) => nameHits.findIndex((other) => other.item.id === hit.item.id) === index);
    if (uniqueNameHits.length === 1) return routeItem(uniqueNameHits[0].job, uniqueNameHits[0].item, "stored_filename", fileName);
    if (uniqueNameHits.length > 1) return review(["stored_filename_matches_multiple_items"], uniqueNameHits.map((hit) => candidateOf(hit.job, hit.item, "stored_filename")));

    // (d) exact match vs stored ProductionJobFile names — job-level identity,
    // routable only when the job has exactly one item
    const fileJobHits = params.jobs.filter((job) => job.fileNames.some((name) => normalizeFileIdentity(name) === fileIdentity));
    if (fileJobHits.length === 1) {
      const job = fileJobHits[0];
      if (job.items.length === 1) return routeItem(job, job.items[0], "job_file_name", fileName);
      return review(["job_file_matches_job_with_multiple_items"], job.items.map((item) => candidateOf(job, item, "job_file_name")));
    }
    if (fileJobHits.length > 1) return review(["job_file_matches_multiple_jobs"], fileJobHits.map((job) => candidateOf(job, null, "job_file_name")));
  }

  // (e) generated job subfolder identity ("TICKET - CUSTOMER - PRODUCT")
  if (subfolder) {
    const subTicket = extractJobTicketFrom(subfolder);
    if (subTicket) {
      const jobs = params.jobs.filter((job) => String(job.jobTicket || "").toUpperCase() === subTicket);
      if (jobs.length === 1) {
        const job = jobs[0];
        if (job.items.length === 1) return routeItem(job, job.items[0], "job_subfolder", fileName);
        return review(["subfolder_job_has_multiple_items_pick_item_in_review"], job.items.map((item) => candidateOf(job, item, "job_subfolder")));
      }
      if (jobs.length > 1) return review(["subfolder_ticket_matches_multiple_jobs"], jobs.map((job) => candidateOf(job, null, "job_subfolder")));
    }
  }

  return review(["no_deterministic_match"]);
}

// ---------- rolling intake outcomes in PrintLogAutoImportSetting.notes ----------

export type IntakeOutcome = {
  at: string;
  fileName: string; // basename only — no local paths
  decision: "routed" | "needs_review" | "duplicate" | "failed";
  rule: string | null;
  reason: string | null;
  jobTicket: string | null;
  itemTicket: string | null;
  ripName: string | null;
  machine: string | null;
  fileHash8: string | null;
  fileHash?: string | null; // 15F.0J.4: full SHA-256 (agent >= 1.3); hash8 kept for back-compat
};

// The notes column may contain operator text; our block is namespaced by a
// marker line and any foreign text is preserved verbatim above it.
export function decodeIntakeOutcomes(notes: string | null): { outcomes: IntakeOutcome[]; foreignText: string } {
  const text = String(notes || "");
  const markerIndex = text.indexOf(INTAKE_OUTCOMES_MARKER);
  if (markerIndex === -1) return { outcomes: [], foreignText: text };
  const foreignText = text.slice(0, markerIndex).replace(/\n+$/, "");
  const jsonPart = text.slice(markerIndex + INTAKE_OUTCOMES_MARKER.length).trim();
  try {
    const parsed = JSON.parse(jsonPart);
    return { outcomes: Array.isArray(parsed) ? (parsed as IntakeOutcome[]) : [], foreignText };
  } catch {
    return { outcomes: [], foreignText };
  }
}

export function encodeIntakeOutcomes(existingNotes: string | null, outcome: IntakeOutcome): string {
  const { outcomes, foreignText } = decodeIntakeOutcomes(existingNotes);
  // Idempotent: an identical fileName+fileHash8+decision already at the head
  // is not appended twice (agent restarts re-report safely).
  const head = outcomes[0];
  const isDuplicateReport = head
    && head.fileName === outcome.fileName
    && head.decision === outcome.decision
    && String(head.fileHash8 || "") === String(outcome.fileHash8 || "");
  const nextOutcomes = isDuplicateReport ? outcomes : [outcome, ...outcomes].slice(0, MAX_INTAKE_OUTCOMES);
  const prefix = foreignText ? `${foreignText}\n` : "";
  return `${prefix}${INTAKE_OUTCOMES_MARKER}\n${JSON.stringify(nextOutcomes)}`;
}

// Shop-scoped eligibility filter for candidate jobs — every plan query goes
// through this builder.
export function eligibleJobsWhere(shop: string): { shop: string; active: boolean } {
  return { shop, active: true };
}

// ---------- 15F.0J.5: filename-only print hints (compat parser) ----------
// SAFE context-anchored parsing per GSO_ERP_EMPLOYEE_FILENAME_COMPATIBILITY:
// - NX counts ONLY with a finish context ("3X SPOT GLOSS", "gloss 2x") — a
//   bare "3x" in a strain/product name NEVER routes;
// - "white" counts only with finish adjacency (white ink/layer/hd, Nx white,
//   holo white) — "White Widow" stays an ordinary CMYK name;
// - printer words match on word boundaries only (existing ROLAND rule; the
//   MIMAKI mirror added here).
export type FilenamePrintHints = {
  printerToken: "roland" | "mimaki" | null;
  printerConflict: boolean;
  glossLayers: number;
  whiteLayers: number;
  mode: string; // CMYK | GLOSS-NX | WHITE-NX | WHITE-NXGLOSS-MX
  deterministic: boolean; // printer+mode resolvable without review
  reasons: string[];
};

export function hasMimakiFilenameTag(fileName: string): boolean {
  return /(?<![A-Za-z])(MIMAKI|UCJV)(?![A-Za-z])/i.test(String(fileName || ""));
}

export function parseFilenamePrintHints(fileName: string): FilenamePrintHints {
  const text = String(fileName || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const reasons: string[] = [];
  const roland = hasRolandFilenameTag(text);
  const mimaki = hasMimakiFilenameTag(text);
  const printerConflict = roland && mimaki;
  const printerToken = printerConflict ? null : roland ? "roland" : mimaki ? "mimaki" : null;
  if (printerConflict) reasons.push("conflicting_printer_tokens_in_filename");

  // gloss: NX before or after a gloss/uv/emboss context; bare "spot gloss"/
  // "emboss" without a count = 1 layer
  let glossLayers = 0;
  const glossBefore = text.match(/(?<![a-z0-9])([1-9])\s*x[\s_-]*(?:spot[\s_-]*)?(?:gloss|uv|emboss)/i);
  const glossAfter = text.match(/(?:gloss|uv|emboss)[\s_-]*([1-9])\s*x(?![a-z0-9])/i);
  if (glossBefore) glossLayers = Number(glossBefore[1]);
  else if (glossAfter) glossLayers = Number(glossAfter[1]);
  else if (/(?:spot[\s_-]*gloss|emboss)(?![a-z])/i.test(text)) glossLayers = 1;

  // white: only with finish adjacency (never a bare strain word)
  let whiteLayers = 0;
  const whiteCount = text.match(/(?<![a-z0-9])([1-9])\s*x[\s_-]*white(?![a-z])/i) || text.match(/white[\s_-]*([1-9])\s*x(?![a-z0-9])/i);
  if (whiteCount) whiteLayers = Number(whiteCount[1]);
  else if (/white[\s_-]*(ink|layer|hd)(?![a-z])/i.test(text) || /holo(?:graphic)?[\s_-]*white(?![a-z])/i.test(text)) whiteLayers = 1;

  const mode = glossLayers > 0 && whiteLayers > 0
    ? `WHITE-${whiteLayers}XGLOSS-${glossLayers}X`
    : glossLayers > 0 ? `GLOSS-${glossLayers}X`
    : whiteLayers > 0 ? `WHITE-${whiteLayers}X`
    : "CMYK";
  const premium = glossLayers > 0 || whiteLayers > 0;
  // premium + explicit Mimaki = contradiction (Mimaki premium unsupported here)
  const premiumConflict = premium && printerToken === "mimaki";
  if (premiumConflict) reasons.push("premium_mode_but_mimaki_token_contradiction");
  return {
    printerToken,
    printerConflict,
    glossLayers,
    whiteLayers,
    mode,
    deterministic: !printerConflict && !premiumConflict,
    reasons,
  };
}

// Filename-only machine decision for UNMATCHED files (no quote/job required —
// spec 15F.0J.5-D). Same precedence family as decideMachine: premium ->
// Roland; explicit token; default CMYK -> Mimaki; conflicts review.
export function decideMachineFromFilename(fileName: string): { machine: "mimaki" | "roland" | null; machineRule: IntakeDecision["machineRule"]; mode: string; reasons: string[] } {
  const hints = parseFilenamePrintHints(fileName);
  if (!hints.deterministic) return { machine: null, machineRule: null, mode: hints.mode, reasons: hints.reasons };
  if (hints.glossLayers > 0 || hints.whiteLayers > 0) {
    return { machine: "roland", machineRule: "white_or_gloss", mode: hints.mode, reasons: ["white_or_gloss_requires_roland"] };
  }
  if (hints.printerToken === "roland") return { machine: "roland", machineRule: "explicit_roland_tag", mode: "CMYK", reasons: ["standalone_roland_tag_in_filename"] };
  if (hints.printerToken === "mimaki") return { machine: "mimaki", machineRule: "explicit_erp_machine", mode: "CMYK", reasons: ["standalone_mimaki_tag_in_filename"] };
  return { machine: "mimaki", machineRule: "default_cmyk", mode: "CMYK", reasons: ["default_cmyk_to_mimaki"] };
}

// Structured routed RIP name for auto-created intake jobs (contract F/E):
// <TICKET>__<PRINTER>__<MODE>__<SAFE-ORIGINAL>__A1 — system-generated only,
// safe charset, <=120 chars, ticket exactly parseable by the result watchers.
export function buildIntakeRipName(ticket: string, machine: string, mode: string, originalFileName: string, attempt = 1): string {
  const base = String(originalFileName || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const safe = base
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "FILE";
  const name = `${ticket}__${machine.toUpperCase()}__${mode}__${safe}__A${Math.max(1, Math.floor(attempt))}`;
  return name.slice(0, 120);
}
