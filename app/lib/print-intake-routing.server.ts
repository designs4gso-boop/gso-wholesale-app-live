// Automatic Print Intake routing (13A.6G): pure decision engine for mapping a
// file dropped in "Prints For Today" to exactly one production job/item and a
// machine key. No Prisma, no network, no filesystem — the endpoints pass data
// in and tests import directly.
//
// Safety contract:
// - deterministic hierarchy only (item ticket in filename > job ticket in
//   filename w/ single item > job ticket at the START of the parent folder
//   name (Patch D) > exact stored filename > exact stored job file);
// - NEVER first-match-wins, contains-only, fuzzy, nearest-date, or
//   customer-name matching; two+ candidates at any tier route NOTHING;
// - the server returns a machine KEY only — hot-folder paths live exclusively
//   in the local agent config (no local paths cross the wire or reach the UI);
// - machine routing follows the owner rules (updated 2026-11-18 — Mimaki
//   gloss restored, see decideMachine): an explicit ERP assignment or a
//   standalone ROLAND / MIMAKI filename tag wins; with nothing explicit, CMYK
//   and CMYK + gloss go to the Mimaki; a WHITE layer keeps its 2026-11-11
//   handling (AUTO by complete load data, or review). Contradictory machine
//   data reviews, never guesses.
import { selectLessBusyPrinter, type MachineLoadSnapshot } from "./machine-load-balancing";

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
  // "white_or_gloss" / "default_cmyk" remain only so historical PrintIntake rows keep a valid label.
  machineRule: "gloss_requires_roland" | "white_requires_roland" | "white_or_gloss" | "explicit_roland_tag" | "explicit_mimaki_tag" | "explicit_erp_machine" | "auto_load_balanced" | "default_cmyk" | null;
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

// Patch D (2026-11-18): a TICKET-NAMED JOB FOLDER. The folder name must BEGIN
// with one exact job ticket ("GSO-20261118-0003", "GSO-20261118-0003 FLAVAZ",
// "GSO-20261118-0003 - FLAVAZ CAMP"). Only the ticket is identity — any text
// after it is ignored, a ticket later in the name is not accepted, and a name
// that is not a ticket (customer, design, "PRINT TODAY") is never a signal.
const FOLDER_JOB_TICKET_RE = /^GSO-\d{8}-\d{4}(?!\d)(?!-\d)/i;

export function extractFolderJobTicket(folderName: string | null | undefined): string {
  const match = basenameOf(String(folderName || "")).trim().replace(/_/g, "-").match(FOLDER_JOB_TICKET_RE);
  return match ? match[0].toUpperCase() : "";
}

// Job statuses a dropped file may no longer be linked to automatically (same
// set the manual Assign action refuses).
const INTAKE_CLOSED_JOB_STATUSES = new Set(["completed", "cancelled", "canceled", "archived"]);

// ---------- machine decision (conservative v1) ----------

const WHITE_GLOSS_TOKENS = ["white", "gloss", "clear", "varnish", "spot uv", "w+g"];
// 2026-11-11: only GLOSS-class finishes force the Roland.
const GLOSS_TOKENS = ["gloss", "varnish", "spot uv", "w+g"];
// 2026-11-11 owner decision: GSO does not run Primer on either press. A
// requested Primer is never routed (Mimaki or Roland), never priced and never
// silently dropped — the item reviews with PRIMER_NOT_CONFIGURED.
export const PRIMER_NOT_CONFIGURED = "PRIMER_NOT_CONFIGURED";
const PRIMER_TOKENS = ["primer"];

// Canonical summaries state zero counts explicitly ("Gloss Layers: 0X") —
// a stated ZERO is not a requirement, so it is removed before token checks.
const finishHaystack = (item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">) =>
  [item.selectedFinish, item.materialSummary, item.machineSummary]
    .map((value) => String(value || "").toLowerCase())
    .join(" ")
    .replace(/\b(gloss|white) layers:\s*0\s*x?\b/g, " ");

// 2026-11-18 (negation fix): a finish that says it has NO gloss ("No Spot Gloss",
// "No Gloss", "No UV", "No Varnish", "No Specialty", "No Specialty — 0X") is
// not a gloss requirement. Every real storefront / configurator order line
// that has no gloss carries exactly that wording, so reading it as gloss sent
// plain CMYK work to the Roland.
const NEGATED_GLOSS_RE = /\bno\s+(?:spot\s+)?(?:gloss|uv|varnish|specialty)\b/g;
const withoutNegatedGloss = (haystack: string) => haystack.replace(NEGATED_GLOSS_RE, " ");

export function needsWhiteOrGloss(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  const haystack = withoutNegatedGloss(finishHaystack(item));
  return WHITE_GLOSS_TOKENS.some((token) => haystack.includes(token));
}

/** True when Primer was requested — not configured on any GSO press. */
export function needsPrimer(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  const haystack = finishHaystack(item);
  return PRIMER_TOKENS.some((token) => haystack.includes(token));
}

/** True when the finish needs a gloss-class layer. Negation-aware. Since 2026-11-18 gloss no longer decides the press. */
export function needsGloss(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  const haystack = withoutNegatedGloss(finishHaystack(item));
  return GLOSS_TOKENS.some((token) => haystack.includes(token));
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

// Shared press decision (production dispatch, manual job entry, the agent
// transition check). Owner rules, updated 2026-11-18 — MIMAKI GLOSS RESTORED:
//   0. Primer requested                   -> review PRIMER_NOT_CONFIGURED (no press)
//   1. explicit ERP Roland / Mimaki       -> that press (explicit_erp_machine)
//   2. standalone ROLAND / MIMAKI tag     -> that press (explicit_*_tag)
//   3. nothing explicit, CMYK             -> Mimaki (default_cmyk)
//   4. nothing explicit, CMYK + gloss     -> Mimaki (default_cmyk) — gloss no
//      longer forces the Roland, and gloss + an explicit Mimaki is no longer a
//      contradiction.
//   5. nothing explicit, WHITE layer      -> UNCHANGED from 2026-11-11: AUTO by
//      COMPLETE load data (auto_load_balanced), else review — the operator
//      chooses. White + gloss untagged -> Roland, as before. White routing was
//      deliberately not touched here.
// Contradictory data reviews: a machineSummary naming both printers, a tag
// that contradicts the ERP assignment, or conflicting tags.
export function decideMachine(item: IntakeItem, fileName = "", machineLoad?: MachineLoadSnapshot | null): MachineDecision {
  if (needsPrimer(item)) return { machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] };
  const gloss = needsGloss(item);
  const assigned = assignedMachineOf(item);
  const rolandTag = hasRolandFilenameTag(fileName);
  const mimakiTag = hasMimakiFilenameTag(fileName);
  if (String(item.machineSummary || "").trim() && assigned === null) {
    return { machine: null, machineRule: null, reasons: ["machine_summary_contradictory_or_unknown"] };
  }
  if (rolandTag && mimakiTag) {
    return { machine: null, machineRule: null, reasons: ["conflicting_printer_tokens_in_filename"] };
  }
  if ((rolandTag && assigned === "mimaki") || (mimakiTag && assigned === "roland")) {
    return { machine: null, machineRule: null, reasons: [`${rolandTag ? "roland" : "mimaki"}_filename_tag_but_erp_assigned_${assigned}_contradiction`] };
  }
  if (assigned) {
    return { machine: assigned, machineRule: "explicit_erp_machine", reasons: [`explicit_erp_${assigned}_assignment`] };
  }
  if (rolandTag) return { machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] };
  if (mimakiTag) return { machine: "mimaki", machineRule: "explicit_mimaki_tag", reasons: ["standalone_mimaki_tag_in_filename"] };
  // 2026-11-18: no explicit press and no white layer -> the Mimaki, with or
  // without gloss (normal default production).
  const white = needsWhiteLayer(item);
  if (!white) {
    return { machine: "mimaki", machineRule: "default_cmyk", reasons: [gloss ? "cmyk_gloss_default_mimaki" : "cmyk_only_default_mimaki"] };
  }
  // WHITE is unchanged. Untagged white + gloss went to the Roland before 2026-11-18 and still does
  // (dropping the gloss rule must not let a white job reach the Mimaki by load balancing).
  if (gloss) return { machine: "roland", machineRule: "white_or_gloss", reasons: ["white_plus_gloss_stays_on_roland"] };
  const choice = selectLessBusyPrinter(["mimaki", "roland"], machineLoad);
  if (!choice.ok) return { machine: null, machineRule: null, reasons: ["auto_machine_load_unavailable_select_printer"] };
  return { machine: choice.printer, machineRule: "auto_load_balanced", reasons: [`auto_less_busy_${choice.printer}_by_${choice.metric}`] };
}

// ---------- Patch B (2026-11-18): PRINT INTAKE press decision ----------
// Owner-approved rules for files arriving through Print Intake ONLY. This is
// deliberately a separate resolver: `decideMachine` above is shared with
// production dispatch and manual job entry (it follows the same gloss rule
// since 2026-11-18); the Cost Calculator / quotes use machine-routing.server.ts.
//
// (hierarchy corrected by the owner the same day — safety follow-up):
//
//   2026-11-18 — MIMAKI GLOSS RESTORED: gloss / clear is no longer Roland-only
//   and no longer decides the press.
//     explicit ROLAND (ERP or filename)                 -> Roland (whole job)
//     explicit MIMAKI (ERP or filename)                 -> Mimaki (whole job)
//     nothing explicit, CMYK only                       -> Mimaki
//     nothing explicit, CMYK + gloss layer pair         -> Mimaki, kept together
//   WHITE is unchanged: the JOB needs white (any layer, incl. the holographic
//   white underbase) -> the Roland is required; white + explicit MIMAKI ->
//   PRINTER CONFLICT, never Mimaki.
//
// No load balancing, no "less busy" AUTO, no review for a plain CMYK file.
// Requirements are read at the JOB level: the item's ERP metadata first (it
// knows white / gloss before any layer file arrives), then every layer file
// known for the same item / design (so `_cmyk` + `_g` both go to the Roland).
// Conflicting instructions never route:
//   - both printer tags on the job's files, or a tag against the ERP press
//   - white work explicitly sent to the Mimaki
//   - a sibling layer already delivered to the other press (layer split)
// LATE-LAYER GUARD: a file that names itself a `_cmyk` LAYER, on a job whose
// ERP record states no finish at all, with no sibling layer known and no
// explicit press, is HELD (confirm print mode) instead of being sent to the
// Mimaki — a gloss / white sibling could still arrive and the job would split.

export type IntakeLayer = "cmyk" | "gloss" | "white";

// Staff layer suffixes, confirmed 2026-11-18 from the owner and production RIP
// logs: `_cmyk` = CMYK layer, `_g` = gloss layer, `_w` = white layer (the
// `_cmyk` / `_w` files of one design appear as same-day pairs; the `_g` file ran
// on the Roland RIP). `_F` / `_B` and every other suffix are NOT interpreted.
// 2026-11-18: `_gloss` / `_GLOSS` is the same gloss layer as `_g` (owner-confirmed
// Mimaki naming: crud_HEATH_F_CMYK.pdf + crud_HEATH_F_g.pdf = ONE Mimaki job,
// combined with RasterLink's Composition workflow).
const INTAKE_LAYER_BY_TOKEN: Record<string, IntakeLayer> = { cmyk: "cmyk", g: "gloss", gloss: "gloss", w: "white" };

/** Standalone layer tokens in a dropped filename, plus the design stem they belong to. */
export function parseIntakeLayerTokens(fileName: string | null | undefined): { layers: IntakeLayer[]; stem: string } {
  const text = basenameOf(String(fileName || "")).replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  const parts = text.split(/[_\-\s]+/).filter(Boolean);
  const layers: IntakeLayer[] = [];
  const stemParts: string[] = [];
  parts.forEach((part, index) => {
    const layer = index > 0 ? INTAKE_LAYER_BY_TOKEN[part.toLowerCase()] : undefined; // never the leading (customer) segment
    if (layer) {
      if (!layers.includes(layer)) layers.push(layer);
      return;
    }
    if (/^(roland|mimaki|ucjv)$/i.test(part)) return; // a printer tag is not part of the design name
    stemParts.push(part.toLowerCase());
  });
  return { layers, stem: stemParts.join(" ") };
}

/** True when the item's ERP metadata calls for a white layer (never a bag / jar colour, never a stated zero). */
export function needsWhiteLayer(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  const text = finishHaystack(item).replace(/\b(?:[a-z]+ )?colou?r:\s*[^|]*/g, " ");
  if (/\bwhite layers:\s*[1-9]/.test(text)) return true;
  if (/\bwhite[\s-]*(?:ink|layer|hd|underbase)\b/.test(text)) return true;
  if (/\+\s*white\b/.test(text) || /\bwhite\s*\+/.test(text)) return true;
  if (/(?<![a-z0-9])[1-9]\s*x[\s_-]*white\b/.test(text) || /\bwhite-[1-9]x/.test(text)) return true;
  return String(item.selectedFinish || "").trim().toLowerCase() === "white";
}

/**
 * Gloss requirement for PRINT INTAKE. Same tokens as the shared needsGloss, but
 * a NEGATED finish ("No Spot Gloss", "No Gloss", "No Specialty") is not a gloss
 * requirement. Intake-only: the shared needsGloss is left as it is.
 */
export function needsGlossLayer(item: Pick<IntakeItem, "selectedFinish" | "materialSummary" | "machineSummary">): boolean {
  return needsGloss(item); // the shared helper is negation-aware since 2026-11-18
}

export type IntakeMachineContext = {
  /** Other files known for the same item / design (their layer suffixes and printer tags count for the whole job). */
  relatedFileNames?: string[];
  /** Presses that sibling files of the same item / design were ALREADY routed to. */
  routedSiblingPrinters?: Array<"mimaki" | "roland">;
};

export const INTAKE_PRINTER_CONFLICT_PREFIX = "printer_conflict";
export const INTAKE_CONFIRM_PRINT_MODE = "print_mode_unknown_for_cmyk_layer_confirm_print_mode";

/**
 * True when the ERP record STATES the item's finish (whatever it is): a
 * selected finish, or a Finish / Specialty / layer-count / holographic entry in
 * the material summary. Order, manual and most quote items do; a quote item
 * converted with no finish at all does not — its print mode is unknown.
 */
export function intakePrintModeStated(item: Pick<IntakeItem, "selectedFinish" | "materialSummary">): boolean {
  if (String(item.selectedFinish || "").trim()) return true;
  return /\b(?:finish|specialty|gloss layers|white layers|holographic)\s*:/i.test(String(item.materialSummary || ""));
}

export function decideIntakeMachine(item: IntakeItem, fileName = "", context: IntakeMachineContext = {}): MachineDecision {
  const blocked = (reason: string): MachineDecision => ({ machine: null, machineRule: null, reasons: [reason] });
  if (needsPrimer(item)) return blocked(PRIMER_NOT_CONFIGURED);
  const assigned = assignedMachineOf(item);
  if (String(item.machineSummary || "").trim() && assigned === null) return blocked("machine_summary_contradictory_or_unknown");

  const related = (context.relatedFileNames || []).filter(Boolean);
  const files = [fileName, ...related].filter(Boolean);
  if (hasRolandFilenameTag(fileName) && hasMimakiFilenameTag(fileName)) return blocked("conflicting_printer_tokens_in_filename");
  const rolandTag = files.some(hasRolandFilenameTag);
  const mimakiTag = files.some(hasMimakiFilenameTag);
  if (rolandTag && mimakiTag) return blocked("conflicting_printer_tokens_across_job_files");
  if ((rolandTag && assigned === "mimaki") || (mimakiTag && assigned === "roland")) {
    return blocked(`${rolandTag ? "roland" : "mimaki"}_filename_tag_but_erp_assigned_${assigned}_contradiction`);
  }

  // JOB-level requirements: ERP metadata first, layer files supplement it.
  let gloss = needsGlossLayer(item);
  let white = needsWhiteLayer(item);
  for (const name of files) {
    const hints = parseFilenamePrintHints(name);
    const layers = parseIntakeLayerTokens(name).layers;
    if (hints.glossLayers > 0 || layers.includes("gloss")) gloss = true;
    if (hints.whiteLayers > 0 || layers.includes("white")) white = true;
  }

  // 2026-11-18 (owner): the Mimaki gloss / clear channel is restored — GLOSS NO
  // LONGER DECIDES THE PRESS. A CMYK + gloss job goes wherever a CMYK job goes
  // (Mimaki unless the ERP or a filename tag says Roland), and its layers stay
  // together. WHITE still requires the Roland: an explicit Mimaki on a white
  // job is a contradiction for a person to resolve.
  const explicit = assigned || (rolandTag ? "roland" : mimakiTag ? "mimaki" : null);
  if (white && explicit === "mimaki") return blocked("white_job_but_mimaki_selected_contradiction");

  // Late-layer guard (see the header): only a self-declared `_cmyk` layer with
  // nothing else known about the job is held. A stated finish, an explicit
  // press, or any known special layer all resolve immediately.
  if (!explicit && !gloss && !white && parseIntakeLayerTokens(fileName).layers.includes("cmyk") && !intakePrintModeStated(item)) { // a WHITE sibling could still arrive
    return blocked(INTAKE_CONFIRM_PRINT_MODE);
  }

  let decision: MachineDecision;
  if (assigned) decision = { machine: assigned, machineRule: "explicit_erp_machine", reasons: [`explicit_erp_${assigned}_assignment`] };
  else if (rolandTag) decision = { machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] };
  else if (mimakiTag) decision = { machine: "mimaki", machineRule: "explicit_mimaki_tag", reasons: ["standalone_mimaki_tag_in_filename"] };
  else if (white) decision = { machine: "roland", machineRule: "white_requires_roland", reasons: ["white_requires_roland"] };
  else decision = { machine: "mimaki", machineRule: "default_cmyk", reasons: [gloss ? "cmyk_gloss_default_mimaki" : "cmyk_only_default_mimaki"] };

  // One physical job is never split across presses: if a sibling layer was
  // already delivered elsewhere, a person decides (nothing is re-sent here).
  const elsewhere = (context.routedSiblingPrinters || []).find((printer) => printer !== decision.machine);
  if (elsewhere) return blocked(`layer_split_sibling_already_routed_to_${elsewhere}_this_file_resolves_${decision.machine}`);
  return decision;
}

export type IntakeSiblingRow = {
  fileHashSha256: string | null;
  originalFilename: string | null;
  authoritativeTicket: string | null;
  matchedProductionJobId: string | null;
  printer: string | null;
  status: string | null;
};

// Which known intake files belong to the same physical job as `fileName`:
// same item ticket, same single-item job, or the exact same design stem with a
// layer suffix on both files. Exact equality only — never fuzzy. Rejected rows
// and the file itself are ignored.
export function buildIntakeMachineContext(params: {
  fileName: string;
  fileHash?: string | null;
  jobId: string | null;
  jobItemCount: number;
  itemTicket: string | null;
  rows: IntakeSiblingRow[];
  /** File names already stored on the matched job (a sibling layer may be listed there before it is dropped). */
  jobFileNames?: string[];
}): IntakeMachineContext {
  const mine = parseIntakeLayerTokens(params.fileName);
  const ownHash = String(params.fileHash || "").toLowerCase();
  const ticket = String(params.itemTicket || "").toUpperCase();
  const relatedFileNames: string[] = [];
  const routedSiblingPrinters: Array<"mimaki" | "roland"> = [];
  const ownIdentity = normalizeFileIdentity(params.fileName);
  for (const name of params.jobFileNames || []) {
    if (!name || normalizeFileIdentity(name) === ownIdentity) continue;
    const theirs = parseIntakeLayerTokens(name);
    if (mine.layers.length > 0 && theirs.layers.length > 0 && mine.stem.length >= 4 && mine.stem === theirs.stem) relatedFileNames.push(name);
  }
  for (const row of params.rows) {
    if (!row || row.status === "rejected") continue;
    if (ownHash && String(row.fileHashSha256 || "").toLowerCase() === ownHash) continue;
    const sameItem = Boolean(ticket) && String(row.authoritativeTicket || "").toUpperCase() === ticket;
    const sameSingleItemJob = Boolean(params.jobId) && params.jobItemCount === 1 && row.matchedProductionJobId === params.jobId;
    const theirs = parseIntakeLayerTokens(row.originalFilename);
    const sameDesign = mine.layers.length > 0 && theirs.layers.length > 0 && mine.stem.length >= 4 && mine.stem === theirs.stem;
    if (!sameItem && !sameSingleItemJob && !sameDesign) continue;
    if (row.originalFilename) relatedFileNames.push(row.originalFilename);
    if (row.status === "routed" && (row.printer === "mimaki" || row.printer === "roland") && !routedSiblingPrinters.includes(row.printer)) {
      routedSiblingPrinters.push(row.printer);
    }
  }
  return { relatedFileNames, routedSiblingPrinters };
}

// ---------- RIP name ----------

// Exact ERP-generated RIP name for the routed copy (no extension; the agent
// appends the original file's extension). Prefers the stored ripJobName, then
// the ITEM TICKET, then suggestedFileName — a ticket-led name is what the
// RasterLink result watcher extracts tickets from, so results auto-match.
// Sanitized to safe filename characters; never empty on a routable item.
//
// 2026-11-19 (order-to-production O2): when the staff file name is passed and
// the item's RIP name is its canonical item ticket (every job the central
// service creates), the routed name is
//     <ITEM TICKET>__<staff file name>
// e.g. crud_HEATH_F_CMYK.pdf on item GSO-20261119-0042-01 routes as
// GSO-20261119-0042-01__crud_HEATH_F_CMYK(.pdf). Staff never type a ticket; the
// layer suffix and any ROLAND / MIMAKI tag stay readable at the press; two layer
// files of one item no longer collide on the bare ticket; the RIP result still
// carries the exact item ticket. Deterministic: same item + same staff name =
// same routed name. Without a staff name, or with a custom RIP name, the
// historical bare name is returned unchanged.
export const ROUTED_NAME_SEPARATOR = "__";
const ROUTED_STAFF_NAME_MAX = 80;
const CANONICAL_ITEM_TICKET_ONLY_RE = /^GSO-\d{8}-\d{4}-\d{2}$/i;

/** The staff file name as a safe routed-name segment ("" when nothing usable is left). */
export function routedStaffNameSegment(originalFileName: string | null | undefined): string {
  let stem = basenameOf(String(originalFileName || "")).replace(/\.[A-Za-z0-9]{1,5}$/, "");
  // A ticket the staff already typed is not repeated (the routed name leads with the item ticket).
  stem = stem.replace(/GSO[-_]\d{8}[-_]\d{4}(?:[-_]\d{2})?(?!\d)/gi, " ");
  // Windows-safe characters only; "__" is reserved as the segment separator.
  stem = stem.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/_+/g, "_").replace(/^[_.-]+|[_.-]+$/g, "");
  if (stem.length > ROUTED_STAFF_NAME_MAX) {
    // Keep the END (layer suffix / side) as well as the start.
    stem = `${stem.slice(0, ROUTED_STAFF_NAME_MAX - 26)}_${stem.slice(-25)}`.replace(/_+/g, "_");
  }
  return stem;
}

export function ripFileBaseName(item: Pick<IntakeItem, "ripJobName" | "suggestedFileName" | "itemTicket">, originalFileName?: string | null): string {
  const source = String(item.ripJobName || item.itemTicket || item.suggestedFileName || "").trim();
  const base = source.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  const itemTicket = String(item.itemTicket || "").trim().toUpperCase();
  if (!originalFileName || !CANONICAL_ITEM_TICKET_ONLY_RE.test(itemTicket) || base.toUpperCase() !== itemTicket) return base;
  const staffName = routedStaffNameSegment(originalFileName);
  return staffName ? `${itemTicket}${ROUTED_NAME_SEPARATOR}${staffName}` : base;
}

// ---------- deterministic mapping hierarchy ----------

function candidateOf(job: IntakeJob, item: IntakeItem | null, reason: string): IntakeCandidate {
  return { jobTicket: job.jobTicket, itemTicket: item ? item.itemTicket : null, productTitle: item ? item.productTitle : null, reason };
}

function review(reasons: string[], candidates: IntakeCandidate[] = []): IntakeDecision {
  return { decision: "review", rule: null, jobId: null, itemId: null, jobTicket: null, itemTicket: null, ripName: null, machine: null, machineRule: null, reasons, candidates: candidates.slice(0, 5) };
}

type IntakeContextResolver = (job: IntakeJob, item: IntakeItem) => IntakeMachineContext;

function routeItem(job: IntakeJob, item: IntakeItem, rule: NonNullable<IntakeDecision["rule"]>, fileName: string, contextFor?: IntakeContextResolver): IntakeDecision {
  // Patch B: Print Intake uses its own owner-approved resolver (no load balancing).
  const machineDecision = decideIntakeMachine(item, fileName, contextFor ? contextFor(job, item) : {});
  if (!machineDecision.machine) {
    return review([`matched_by_${rule}_but_machine_unresolved`, ...machineDecision.reasons], [candidateOf(job, item, rule)]);
  }
  const ripName = ripFileBaseName(item, fileName);
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

// `machineLoad` is accepted for backwards compatibility and IGNORED (Patch B:
// Print Intake never load-balances). `machineContextFor` supplies the sibling
// layer files of the matched item so the press is decided for the whole job.
export function decideIntakeRoute(params: { fileName: string; subfolder?: string | null; jobs: IntakeJob[]; machineLoad?: MachineLoadSnapshot | null; machineContextFor?: IntakeContextResolver }): IntakeDecision {
  const fileName = basenameOf(params.fileName);
  if (!isArtworkFileName(fileName)) return review(["not_an_artwork_file_type"]);
  const fileIdentity = normalizeFileIdentity(fileName);
  const subfolder = String(params.subfolder || "").trim();
  // Patch D: the ticket of the job folder the file sits in ("" when the file is
  // in the root or in a folder whose name does not begin with a ticket).
  const folderTicket = subfolder ? extractFolderJobTicket(subfolder) : "";

  // (a) exact item ticket in the filename
  const itemTicket = extractItemTicketFrom(fileName);
  // A ticket in the filename that contradicts the folder's ticket is never guessed.
  const fileNameJobTicket = itemTicket ? itemTicket.slice(0, 17) : extractJobTicketFrom(fileName);
  if (folderTicket && fileNameJobTicket && fileNameJobTicket !== folderTicket) {
    return review([`filename_ticket_${fileNameJobTicket}_and_folder_ticket_${folderTicket}_disagree`]);
  }
  if (itemTicket) {
    const hits: { job: IntakeJob; item: IntakeItem }[] = [];
    for (const job of params.jobs) {
      for (const item of job.items) {
        if (String(item.itemTicket || "").toUpperCase() === itemTicket) hits.push({ job, item });
      }
    }
    if (hits.length === 1) return routeItem(hits[0].job, hits[0].item, "item_ticket", fileName, params.machineContextFor);
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
      if (job.items.length === 1) return routeItem(job, job.items[0], "job_ticket_single_item", fileName, params.machineContextFor);
      return review(
        ["job_ticket_matches_job_with_multiple_items_pick_item_in_review"],
        job.items.map((item) => candidateOf(job, item, "job_ticket_multiple_items")),
      );
    }
    return review([`job_ticket_${jobTicket}_not_found_in_eligible_jobs`]);
  }

  // (c) Patch D: exact job ticket at the start of the PARENT FOLDER name. The
  // folder alone identifies the JOB; the item is only taken when it is certain
  // (single-item job, or the file's exact stored name on exactly one item).
  if (folderTicket) {
    const jobs = params.jobs.filter((job) => String(job.jobTicket || "").toUpperCase() === folderTicket);
    if (jobs.length > 1) return review(["subfolder_ticket_matches_multiple_jobs"], jobs.map((job) => candidateOf(job, null, "job_subfolder")));
    if (jobs.length === 0) return review([`folder_ticket_${folderTicket}_not_found_in_eligible_jobs`]);
    const job = jobs[0];
    if (INTAKE_CLOSED_JOB_STATUSES.has(String(job.status || "").toLowerCase())) {
      return review([`folder_ticket_${folderTicket}_on_closed_job`], [candidateOf(job, null, "job_subfolder")]);
    }
    if (job.items.length === 1) return routeItem(job, job.items[0], "job_subfolder", fileName, params.machineContextFor);
    const storedNameItems = fileIdentity.length >= 6
      ? job.items.filter((item) => [item.suggestedFileName, item.ripJobName].map(normalizeFileIdentity).some((identity) => identity && identity === fileIdentity))
      : [];
    if (storedNameItems.length === 1) return routeItem(job, storedNameItems[0], "job_subfolder", fileName, params.machineContextFor);
    return review(["folder_job_has_multiple_items_needs_link_to_item"], job.items.map((item) => candidateOf(job, item, "job_subfolder")));
  }

  // (d) exact normalized filename vs stored per-item/job print names
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
    if (uniqueNameHits.length === 1) return routeItem(uniqueNameHits[0].job, uniqueNameHits[0].item, "stored_filename", fileName, params.machineContextFor);
    if (uniqueNameHits.length > 1) return review(["stored_filename_matches_multiple_items"], uniqueNameHits.map((hit) => candidateOf(hit.job, hit.item, "stored_filename")));

    // (e) exact match vs stored ProductionJobFile names — job-level identity,
    // routable only when the job has exactly one item
    const fileJobHits = params.jobs.filter((job) => job.fileNames.some((name) => normalizeFileIdentity(name) === fileIdentity));
    if (fileJobHits.length === 1) {
      const job = fileJobHits[0];
      if (job.items.length === 1) return routeItem(job, job.items[0], "job_file_name", fileName, params.machineContextFor);
      return review(["job_file_matches_job_with_multiple_items"], job.items.map((item) => candidateOf(job, item, "job_file_name")));
    }
    if (fileJobHits.length > 1) return review(["job_file_matches_multiple_jobs"], fileJobHits.map((job) => candidateOf(job, null, "job_file_name")));
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
  // 2026-11-18: gloss + an explicit MIMAKI tag is no longer a contradiction (Mimaki gloss restored).
  return {
    printerToken,
    printerConflict,
    glossLayers,
    whiteLayers,
    mode,
    deterministic: !printerConflict,
    reasons,
  };
}

// Filename-only machine decision. NOT used by Print Intake any more: Patch C
// (2026-11-18) keeps unmatched files in review with no press, and Patch B
// routes matched files through decideIntakeMachine. Kept for its tests / any
// non-intake caller (spec 15F.0J.5-D). Same precedence family as decideMachine:
// explicit token; no white -> Mimaki (with or without gloss, 2026-11-18);
// white -> AUTO by complete load data, else review.
export function decideMachineFromFilename(fileName: string, machineLoad?: MachineLoadSnapshot | null): { machine: "mimaki" | "roland" | null; machineRule: IntakeDecision["machineRule"]; mode: string; reasons: string[] } {
  const hints = parseFilenamePrintHints(fileName);
  if (!hints.deterministic) return { machine: null, machineRule: null, mode: hints.mode, reasons: hints.reasons };
  if (hints.printerToken === "roland") return { machine: "roland", machineRule: "explicit_roland_tag", mode: hints.mode, reasons: ["standalone_roland_tag_in_filename"] };
  if (hints.printerToken === "mimaki") return { machine: "mimaki", machineRule: "explicit_mimaki_tag", mode: hints.mode, reasons: ["standalone_mimaki_tag_in_filename"] };
  // 2026-11-18: gloss no longer forces the Roland. No white -> Mimaki; white -> unchanged AUTO.
  if (hints.whiteLayers <= 0) {
    return { machine: "mimaki", machineRule: "default_cmyk", mode: hints.mode, reasons: [hints.glossLayers > 0 ? "cmyk_gloss_default_mimaki" : "cmyk_only_default_mimaki"] };
  }
  const choice = selectLessBusyPrinter(["mimaki", "roland"], machineLoad);
  if (!choice.ok) return { machine: null, machineRule: null, mode: hints.mode, reasons: ["auto_machine_load_unavailable_select_printer"] };
  return { machine: choice.printer, machineRule: "auto_load_balanced", mode: hints.mode, reasons: [`auto_less_busy_${choice.printer}_by_${choice.metric}`] };
}

// ---------- 15H.5: run identity (attempt / revision / reprint) ----------
// ONE grammar for the trailing run segment of routed names:
//   __A1                      first normal run (historical default — every
//                             pre-15H.5 routed file ends exactly like this)
//   __A2                      operational retry (transport failure re-delivery)
//   __R2-A1                   corrected artwork, second revision, first attempt
//   __P1-A1                   first intentional reprint
//   __R2-P2-A3                combinations, always R then P then A
// Absent tokens default to R1 / P0 / A1 (Q: historical names stay valid).
// ATTEMPT = operational re-delivery; REVISION = changed artwork (new hash);
// REPRINT = intentional physical re-production. Never mixed.

export type RunIdentity = { revision: number; reprint: number; attempt: number };

export const DEFAULT_RUN: RunIdentity = { revision: 1, reprint: 0, attempt: 1 };

const RUN_SEGMENT_RE = /__(?:R(\d+)-)?(?:P(\d+)-)?A(\d+)$/i;

export function parseRunIdentity(name: string | null | undefined): RunIdentity {
  const base = String(name || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const match = base.match(RUN_SEGMENT_RE);
  if (!match) return { ...DEFAULT_RUN };
  return {
    revision: match[1] ? Math.max(1, Number(match[1])) : 1,
    reprint: match[2] ? Math.max(0, Number(match[2])) : 0,
    attempt: Math.max(1, Number(match[3])),
  };
}

export function buildRunSuffix(run: Partial<RunIdentity> = {}): string {
  const revision = Math.max(1, Math.floor(run.revision ?? 1));
  const reprint = Math.max(0, Math.floor(run.reprint ?? 0));
  const attempt = Math.max(1, Math.floor(run.attempt ?? 1));
  const tokens = [
    ...(revision > 1 ? [`R${revision}`] : []),
    ...(reprint > 0 ? [`P${reprint}`] : []),
    `A${attempt}`,
  ];
  return `__${tokens.join("-")}`;
}

// Replace (or append) the trailing run segment of an existing routed name.
export function applyRunSuffix(baseName: string, run: Partial<RunIdentity>): string {
  const stripped = String(baseName || "").replace(RUN_SEGMENT_RE, "");
  return `${stripped}${buildRunSuffix(run)}`.slice(0, 120);
}

// Structured routed RIP name for auto-created intake jobs (contract F/E):
// <TICKET>__<PRINTER>__<MODE>__<SAFE-ORIGINAL>__<RUN> — system-generated
// only, safe charset, <=120 chars, ticket exactly parseable by the result
// watchers. Default run renders exactly the historical __A1.
export function buildIntakeRipName(ticket: string, machine: string, mode: string, originalFileName: string, attempt = 1, run: Partial<RunIdentity> = {}): string {
  const base = String(originalFileName || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const safe = base
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "FILE";
  const name = `${ticket}__${machine.toUpperCase()}__${mode}__${safe}${buildRunSuffix({ attempt, ...run })}`;
  return name.slice(0, 120);
}
