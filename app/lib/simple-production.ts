// GSO ERP SIMPLE MODE (2026-11-14) — production board stages, job steps and
// the NEXT STEP line.
//
// DISPLAY ONLY. Pure, client-safe, no Prisma. Nothing here writes, validates
// or transitions anything: backend statuses, QC rules, shipment / pickup rules
// and completion gates are unchanged and stay in their own modules. This file
// only GROUPS the existing statuses for the eye and reads existing evidence
// (checklist items, structured QC columns, shipment / pickup records) to say
// what a person should do next.

import { itemQcState, type ItemQcState } from "./production-qc-display";
import { qcEventItemKey, qcResultOf } from "./production-qc-guard";
import { staffStatusLabel } from "./production-status-vocabulary";
import { isPastDueDate } from "./business-date";
import { itemFileState, itemRunSummary } from "./production-run";

/* ---------------- 6 board stages (UI groups of existing statuses) ---------------- */

export const SIMPLE_STAGES = [
  { key: "new", label: "New", statuses: ["new"] },
  { key: "prepress", label: "Prepress", statuses: ["prepress", "proof_needed", "proof_sent", "proof_approved"] },
  { key: "production", label: "Production", statuses: ["ready_to_print", "printing"] },
  { key: "finish_qc", label: "Finish / QC", statuses: ["cutting", "laminating", "qc", "packing"] },
  // OWNER CORRECTION 2026-11-14: Shipped / Picked Up still need "Complete Job",
  // so they stay under READY. DONE means completed and nothing else.
  { key: "ready", label: "Ready", statuses: ["ready_for_pickup", "shipped", "picked_up"] },
  { key: "done", label: "Done", statuses: ["completed"] },
] as const;
export type SimpleStageKey = (typeof SIMPLE_STAGES)[number]["key"];

/** Pinned above the board, never inside a column. */
export const ATTENTION_STATUSES = ["on_hold", "reprint_needed"] as const;
/** Behind the "Show cancelled" filter. */
export const HIDDEN_STATUSES = ["cancelled"] as const;

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function simpleStageForStatus(status: unknown): SimpleStageKey | "attention" | "hidden" | "unknown" {
  const value = norm(status);
  if ((ATTENTION_STATUSES as readonly string[]).includes(value)) return "attention";
  if ((HIDDEN_STATUSES as readonly string[]).includes(value)) return "hidden";
  return SIMPLE_STAGES.find((stage) => (stage.statuses as readonly string[]).includes(value))?.key ?? "unknown";
}

/**
 * Default board focus by role (no staff-linked "My Jobs" yet — assignedTo is
 * free text). Print operators start on production work, baggers / finishing on
 * finish, QC, packing and ready work. Everyone can switch to all stages.
 */
export const ROLE_STAGE_FOCUS: Record<string, readonly SimpleStageKey[]> = {
  print_operator: ["production"],
  bagger: ["finish_qc", "ready"],
};

/* ---------------- job steps ---------------- */

export const JOB_STEPS = [
  { key: "artwork", label: "Artwork" },
  { key: "print", label: "Print" },
  { key: "finish", label: "Finish" },
  { key: "qc", label: "QC" },
  { key: "pack", label: "Pack" },
  { key: "fulfill", label: "Fulfill" },
] as const;
export type JobStepKey = (typeof JOB_STEPS)[number]["key"];

/** How far the STATUS alone says the job has got (index into JOB_STEPS; 6 = all steps behind it). */
const STATUS_STEP_FLOOR: Record<string, number> = {
  new: 0, prepress: 0, proof_needed: 0, proof_sent: 0,
  // the proof is approved: artwork is behind the job, printing is next
  proof_approved: 1,
  ready_to_print: 1, printing: 1,
  // a reprint goes back to the printer (artwork is not redone)
  reprint_needed: 1,
  cutting: 2, laminating: 2,
  qc: 3,
  packing: 4,
  ready_for_pickup: 5, shipped: 5, picked_up: 5,
  completed: 6,
};

/** The existing status a one-tap "move the job here" hint offers for each step (server guards still decide). */
export const STEP_SUGGESTED_STATUS: Record<JobStepKey, string> = {
  artwork: "prepress",
  print: "printing",
  finish: "cutting",
  qc: "qc",
  pack: "packing",
  fulfill: "ready_for_pickup",
};

export type StepState = "done" | "current" | "upcoming";
export type WorkspaceStep = { key: JobStepKey; label: string; number: number; state: StepState; checklist: any[] };
export type NextStep = { text: string; detail: string | null; tone: "action" | "waiting" | "problem" | "done" };
export type JobWorkspaceView = {
  steps: WorkspaceStep[];
  currentStep: JobStepKey | null;
  next: NextStep;
  machine: string;
  qcAllPass: boolean;
  fulfilled: boolean;
  /** An existing status the job could be moved to so the board matches the current step; null when already there. */
  suggestedStatus: string | null;
};

export function jobMachine(job: any): string {
  const fromItems = Array.from(new Set((job?.items || []).map((item: any) => String(item?.machineSummary || "").trim()).filter(Boolean))) as string[];
  return fromItems.length ? fromItems.join(", ") : "";
}

/** Split the existing checklist items across the six steps (by their existing section + order; nothing is renamed or saved). */
export function checklistByStep(checklistItems: any[] = []): Record<JobStepKey, any[]> {
  const out: Record<JobStepKey, any[]> = { artwork: [], print: [], finish: [], qc: [], pack: [], fulfill: [] };
  const sorted = [...(checklistItems || [])].sort((a, b) => Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0));
  const production = sorted.filter((item) => norm(item?.section) === "production");
  // everything up to and including the last "print" item is print prep / printing; the rest is finishing
  let lastPrint = -1;
  production.forEach((item, index) => { if (/print/i.test(String(item?.label || ""))) lastPrint = index; });
  for (const item of sorted) {
    const section = norm(item?.section);
    if (section === "prepress") out.artwork.push(item);
    else if (section === "qc") out.qc.push(item);
    else if (section === "packing") out.pack.push(item);
    else if (section === "production") (production.indexOf(item) <= lastPrint ? out.print : out.finish).push(item);
    else out.finish.push(item);
  }
  return out;
}

function finishActionFor(label: string): string {
  if (/weed/i.test(label)) return "Weed";
  if (/laminat/i.test(label)) return "Laminate";
  if (/appl/i.test(label)) return "Apply labels";
  if (/cut/i.test(label)) return "Cut";
  return "Cut / finish";
}

export const QC_NEEDED_AGAIN = "Needs a new QC PASS";

/**
 * QC state of one item as the job page shows it. Same as itemQcState, except
 * that a PASS which a LATER QC event has overturned (for example "reopen for
 * reprint" records a HOLD for every item) is shown as needing a new QC PASS,
 * which is what the server's shipment / completion guard already requires.
 * Display only.
 */
export function workspaceItemQc(item: any, events: any[] = []): ItemQcState {
  const base = itemQcState(item, events);
  if (base.status !== "pass" || !item?.qcAt) return base;
  const passedAt = new Date(item.qcAt).getTime();
  const keys = [norm(item.itemTicket), norm(item.productTitle)].filter(Boolean);
  const overturned = (events || []).some((event) => {
    const result = qcResultOf(event);
    return result != null && result !== "pass" && keys.includes(qcEventItemKey(event)) && new Date(event.createdAt || 0).getTime() > passedAt;
  });
  return overturned ? { status: "hold", label: QC_NEEDED_AGAIN, by: null, at: null } : base;
}

/** Where an On Hold job was before the hold (from its existing status-change history); 0 when unknown. */
function heldFromFloor(events: any[]): number {
  const hold = [...(events || [])]
    .filter((event) => event?.eventType === "status_change" && norm(event?.newValue) === "on_hold")
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];
  return hold ? STATUS_STEP_FLOOR[norm(hold.oldValue)] ?? 0 : 0;
}

/**
 * The job workspace view: which step is current and the one NEXT STEP line.
 *
 * A step counts as done when its existing checklist items are all ticked, or
 * when the job's status has already moved past it. Two steps need REAL
 * evidence and are never passed by status alone, because the server guards
 * need the same evidence: QC (QC PASS on every item) and Fulfill (a shipment
 * or pickup record).
 */
export function jobWorkspaceView(job: any): JobWorkspaceView {
  const status = norm(job?.status);
  const items = job?.items || [];
  const events = job?.events || [];
  const byStep = checklistByStep(job?.checklistItems || []);
  const machine = jobMachine(job);
  const floor = status === "on_hold" ? Math.min(heldFromFloor(events), 5) : STATUS_STEP_FLOOR[status] ?? 0;

  const qcStates = items.map((item: any) => workspaceItemQc(item, events));
  const qcAllPass = items.length > 0 && qcStates.every((state: any) => state.status === "pass");
  const awaitingReprintQc = qcStates.some((state: any) => state.status === "pending_reprint");
  // Shipped / Picked Up are only reachable through a shipment / pickup record, so the status IS the
  // evidence. A job reopened for reprint keeps its old record but must be shipped / handed over again.
  const fulfilled = ["shipped", "picked_up", "completed"].includes(status);

  const done = (key: JobStepKey, index: number): boolean => {
    if (status === "completed") return true;
    if (key === "qc") return qcAllPass || (items.length === 0 && floor > index);
    if (key === "fulfill") return fulfilled;
    const list = byStep[key];
    if (list.length && list.every((item) => item.completed)) return true;
    return floor > index;
  };

  const doneFlags = JOB_STEPS.map((step, index) => done(step.key, index));
  const currentIndex = doneFlags.findIndex((flag) => !flag);
  const currentStep = currentIndex === -1 ? null : JOB_STEPS[currentIndex].key;
  const steps: WorkspaceStep[] = JOB_STEPS.map((step, index) => ({
    key: step.key,
    label: step.label,
    number: index + 1,
    state: doneFlags[index] ? "done" : index === currentIndex ? "current" : "upcoming",
    checklist: byStep[step.key],
  }));

  let next: NextStep;
  if (status === "cancelled") next = { text: "Cancelled", detail: "No further work on this job.", tone: "done" };
  else if (status === "completed") next = { text: "DONE", detail: null, tone: "done" };
  else if (status === "on_hold") next = { text: "On hold — check the notes", detail: "Resolve the hold, then move the job back to its stage.", tone: "problem" };
  else if (currentStep === null) next = { text: "Complete Job", detail: status === "picked_up" ? "The customer has picked it up." : status === "shipped" ? "The job has shipped." : "Everything else is done.", tone: "action" };
  else {
    const open = byStep[currentStep].find((item) => !item.completed);
    const openLabel = open ? String(open.label || "") : "";
    if (currentStep === "artwork") {
      if (status === "proof_sent") next = { text: "Waiting for customer proof approval", detail: openLabel || null, tone: "waiting" };
      else if (/proof/i.test(openLabel)) next = { text: "Approve proof", detail: openLabel, tone: "action" };
      else if (!open || /artwork/i.test(openLabel)) next = { text: "Link artwork", detail: openLabel || null, tone: "action" };
      else next = { text: openLabel, detail: null, tone: "action" };
    } else if (currentStep === "print") {
      if (open && !/print/i.test(openLabel)) next = { text: openLabel, detail: "Before printing", tone: "action" };
      else next = { text: machine ? `Print on ${machine}` : "Print", detail: machine ? openLabel || null : "No machine is assigned yet.", tone: "action" };
    } else if (currentStep === "finish") next = { text: open ? finishActionFor(openLabel) : "Cut / finish", detail: openLabel || null, tone: "action" };
    else if (currentStep === "qc") next = { text: awaitingReprintQc ? "Record QC after reprint" : "Record QC", detail: "Every item needs QC PASS before the job can ship or be picked up.", tone: "action" };
    else if (currentStep === "pack") next = { text: "Pack and label", detail: openLabel || null, tone: "action" };
    else next = { text: "Record shipment or pickup", detail: status === "ready_for_pickup" ? "Ready for customer pickup." : null, tone: "action" };
    if (status === "reprint_needed") next = { text: "Reprint needed", detail: `Then: ${next.text}`, tone: "problem" };
  }

  // one-tap hint so the board column matches the step people are actually on
  let suggestedStatus: string | null = null;
  if (currentStep && !["on_hold", "reprint_needed", "cancelled", "completed", "shipped", "picked_up"].includes(status)) {
    const index = JOB_STEPS.findIndex((step) => step.key === currentStep);
    if ((STATUS_STEP_FLOOR[status] ?? 0) < index) suggestedStatus = STEP_SUGGESTED_STATUS[currentStep];
  }

  return { steps, currentStep, next, machine, qcAllPass, fulfilled, suggestedStatus };
}

/* ---------------- material use (display rule only) ---------------- */

/**
 * Which roles are SHOWN the "Material used" form on the job page: the roles
 * that work in Production. Display only — the form posts to the existing
 * Production action (addMaterialUsage), which keeps its own rules.
 */
export const MATERIAL_USE_ROLES: readonly string[] = ["owner", "manager", "print_operator", "bagger"];
export function showsMaterialUse(role: unknown): boolean {
  return MATERIAL_USE_ROLES.includes(norm(role));
}

/** The only material fields the job page needs for its picker — never a cost. */
export function toMaterialOption(material: any): { id: string; name: string; unit: string } {
  return { id: String(material.id), name: String(material.name || "Material"), unit: String(material.baseUnit || material.unit || "") };
}

/* ---------------- slim board card ---------------- */

export type BoardCard = {
  id: string;
  customer: string;
  product: string;
  quantity: number;
  dueDate: string | null;
  overdue: boolean;
  machine: string;
  assignedTo: string;
  priority: string;
  status: string;
  statusLabel: string;
  stage: SimpleStageKey | "attention" | "hidden" | "unknown";
  next: string;
  nextTone: NextStep["tone"];
  updatedAt: string | null;
  // 2026-11-19 shared board visibility (no cost, price or file URL)
  itemCount: number;
  filesLabel: string;
  awaitingFiles: boolean;
  qcLabel: string;
  reprintLabel: string;
  holdReason: string;
  finish: string;
  reorder: boolean;
  // 2026-11-19 (night): the run on the press right now, and packed-and-waiting
  activeRunLabel: string;
  fulfillmentLabel: string;
};

/**
 * Why an On Hold job is held, in the staff's own words: the newest job note
 * written when the job went On Hold or after it (within the events the board
 * already receives). Empty when nobody wrote one.
 */
export function holdReasonOf(job: any): string {
  if (norm(job?.status) !== "on_hold") return "";
  const time = (event: any) => new Date(event?.createdAt || 0).getTime();
  const events = [...(job?.events || [])].sort((a, b) => time(b) - time(a));
  const hold = events.find((event) => event?.eventType === "status_change" && norm(event?.newValue) === "on_hold");
  // a note written up to five minutes before the move counts (note first, then the status tap)
  if (!hold) return "";
  const since = time(hold) - 5 * 60 * 1000;
  const note = events.find((event) => event?.eventType === "note" && time(event) >= since);
  return String(note?.message || "").trim().slice(0, 140);
}

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function isJobOverdue(job: any, now: Date = new Date()): boolean {
  const due = iso(job?.dueDate);
  if (!due) return false;
  if (["completed", "shipped", "picked_up", "cancelled"].includes(norm(job?.status))) return false;
  // 2026-11-15: a due date is a calendar DATE. It is late only when that date is before
  // today in the business timezone (America/Los_Angeles) — never because UTC crossed midnight.
  return isPastDueDate(due, now);
}

/**
 * The ONLY job fields the simple board receives. Built on the server from the
 * full job, so no cost, price, file URL, checklist, event or technical id is
 * ever sent to a board card.
 */
export function toBoardCard(job: any, now: Date = new Date()): BoardCard {
  const items = job?.items || [];
  const first = items[0]?.displayTitle || items[0]?.productTitle || "";
  const view = jobWorkspaceView(job);
  return {
    id: String(job.id),
    customer: job.company || job.customerName || "Customer not set",
    product: !items.length ? "No items" : items.length > 1 ? `${first || "Item"} (+${items.length - 1} more)` : first || "Item",
    quantity: items.reduce((sum: number, item: any) => sum + Number(item?.quantity || 0), 0),
    dueDate: iso(job.dueDate),
    overdue: isJobOverdue(job, now),
    machine: view.machine,
    assignedTo: String(job.assignedTo || "").trim(),
    priority: norm(job.priority) || "normal",
    status: norm(job.status),
    statusLabel: staffStatusLabel(norm(job.status)),
    stage: simpleStageForStatus(job.status),
    next: view.next.text,
    nextTone: view.next.tone,
    updatedAt: iso(job.updatedAt),
    ...boardCardExtras(job, items),
  };
}

function boardCardExtras(job: any, items: any[]) {
  const fileStates = items.map((item: any) => itemFileState(item, job?.files || []));
  const awaitingCount = fileStates.filter((state) => state.awaiting).length;
  const qcStates = items.map((item: any) => workspaceItemQc(item, job?.events || []));
  const passed = qcStates.filter((state: any) => state.status === "pass").length;
  const reprints = items.map((item: any) => itemRunSummary(item, item?.runs || []));
  const reprintCount = reprints.reduce((sum, summary) => sum + summary.reprintCount, 0);
  const reprintQty = reprints.reduce((sum, summary) => sum + summary.reprintQuantity, 0);
  const legacyReprints = items.filter((item: any) => item?.lastReprintAt && !(item?.runs || []).length).length;
  return {
    itemCount: items.length,
    awaitingFiles: items.length > 0 && awaitingCount > 0,
    filesLabel: !items.length ? "No items" : awaitingCount === 0 ? "Files received" : awaitingCount === items.length ? "Awaiting files" : `Awaiting files for ${awaitingCount} of ${items.length} items`,
    qcLabel: !items.length ? "" : passed === items.length ? "QC passed" : qcStates.some((state: any) => state.status === "pending_reprint") ? "QC needed after reprint" : `QC ${passed}/${items.length}`,
    reprintLabel: reprintCount ? `${reprintCount} reprint(s) · ${reprintQty} pcs` : legacyReprints ? `${legacyReprints} reprint(s)` : "",
    holdReason: holdReasonOf(job),
    finish: (Array.from(new Set(items.map((item: any) => String(item?.selectedFinish || "").trim()).filter(Boolean))) as string[]).slice(0, 3).join(", "),
    reorder: items.some((item: any) => Boolean(item?.reorderSourceItemId)),
    activeRunLabel: activeRunLabelOf(items),
    fulfillmentLabel: job?.fulfillmentState === "ready_to_ship" ? "Ready to ship" : job?.fulfillmentState === "pickup_ready" ? "Ready for pickup" : "",
  };
}

/**
 * The reprint / remake that is open right now, in floor words:
 * "Run 2 · Reprint · 25 pcs". Empty while only the original run exists.
 */
export function activeRunLabelOf(items: any[]): string {
  const open = (items || []).flatMap((item: any) => ((item?.runs || []) as any[]).filter((run) => run?.status === "open" && run?.kind && run.kind !== "original"));
  if (!open.length) return "";
  const first = open[0];
  const kind = first.kind === "remake" ? "Remake" : "Reprint";
  return `Run ${first.runNumber} · ${kind} · ${Number(first.quantity) || 0} pcs${open.length > 1 ? ` (+${open.length - 1} more)` : ""}`;
}

export type SimpleBoard = {
  columns: { key: SimpleStageKey; label: string; cards: BoardCard[]; hiddenCount: number }[];
  attention: { onHold: BoardCard[]; reprintNeeded: BoardCard[]; overdue: BoardCard[] };
  cancelled: BoardCard[];
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, rush: 1, normal: 2, low: 3 };
const DONE_COLUMN_LIMIT = 12;

/** Group slim cards into the six columns + the attention strip. Done shows only the most recent jobs. */
export function buildSimpleBoard(cards: BoardCard[]): SimpleBoard {
  const byUrgency = (a: BoardCard, b: BoardCard) =>
    (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
    || (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity);
  const columns = SIMPLE_STAGES.map((stage) => {
    let list = cards.filter((card) => card.stage === stage.key);
    let hiddenCount = 0;
    if (stage.key === "done") {
      list = list.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
      hiddenCount = Math.max(0, list.length - DONE_COLUMN_LIMIT);
      list = list.slice(0, DONE_COLUMN_LIMIT);
    } else list = list.sort(byUrgency);
    return { key: stage.key, label: stage.label, cards: list, hiddenCount };
  });
  return {
    columns,
    attention: {
      onHold: cards.filter((card) => card.status === "on_hold").sort(byUrgency),
      reprintNeeded: cards.filter((card) => card.status === "reprint_needed").sort(byUrgency),
      overdue: cards.filter((card) => card.overdue).sort(byUrgency),
    },
    cancelled: cards.filter((card) => card.stage === "hidden"),
  };
}
