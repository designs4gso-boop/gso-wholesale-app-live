// GSO Operations Agent Platform — Production transition guard (pure).
//
// Uses the ACTUAL ProductionJob.status vocabulary observed in the ERP
// (app/routes/app.erp.production.tsx and the proof portal). The route's
// changeStatus handler accepts any string today; this guard is advisory and
// is NOT wired into the production write path tonight. It is the single
// source for "may this job move from A to B, and what must be true first".

export const PRODUCTION_TRANSITIONS_VERSION = "production-transitions/1.0.0-2026-10-03";

export type ProductionStatus =
  | "new" | "proof_sent" | "proof_approved" | "routed" | "printing" | "cutting" | "production"
  | "qc" | "reprint_needed" | "completed" | "shipped" | "on_hold" | "cancelled";

export const PRODUCTION_STATUSES: ProductionStatus[] = ["new", "proof_sent", "proof_approved", "routed", "printing", "cutting", "production", "qc", "reprint_needed", "completed", "shipped", "on_hold", "cancelled"];

export type StatusGroup = "new" | "prepress" | "printing" | "qc" | "completed" | "hold" | "cancelled";

export function normalizeStatus(value: unknown): ProductionStatus | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "canceled") return "cancelled";
  return (PRODUCTION_STATUSES as string[]).includes(s) ? (s as ProductionStatus) : null;
}

export function statusGroup(status: ProductionStatus): StatusGroup {
  switch (status) {
    case "new": return "new";
    case "proof_sent": case "proof_approved": return "prepress";
    case "routed": case "printing": case "cutting": case "production": case "reprint_needed": return "printing";
    case "qc": return "qc";
    case "completed": case "shipped": return "completed";
    case "on_hold": return "hold";
    case "cancelled": return "cancelled";
  }
}

const ALLOWED: Record<ProductionStatus, ProductionStatus[]> = {
  new: ["proof_sent", "proof_approved", "on_hold", "cancelled"],
  proof_sent: ["proof_approved", "new", "on_hold", "cancelled"],
  proof_approved: ["routed", "printing", "production", "proof_sent", "on_hold", "cancelled"],
  routed: ["printing", "production", "on_hold", "cancelled"],
  printing: ["cutting", "production", "qc", "reprint_needed", "on_hold"],
  cutting: ["production", "qc", "reprint_needed", "on_hold"],
  production: ["qc", "reprint_needed", "on_hold"],
  qc: ["completed", "reprint_needed", "on_hold"],
  reprint_needed: ["routed", "printing", "production", "on_hold", "cancelled"],
  completed: ["shipped", "qc"],
  shipped: [],
  on_hold: ["new", "proof_sent", "proof_approved", "routed", "printing", "cutting", "production", "qc", "reprint_needed", "cancelled"],
  cancelled: [],
};

export type TransitionFacts = {
  /** FINAL art approval recorded on the current version (art-approval.ts) or proofStatus approved. */
  artApproved?: boolean;
  /** QC pass recorded by a named person/device. */
  qcPassRecorded?: boolean;
  /** Tracking number or explicit hand-delivery record. */
  shippingRecorded?: boolean;
  /** Status the job was in before on_hold (release must return there or go to cancelled). */
  previousStatus?: ProductionStatus | null;
  /** Material / blanks confirmed available. */
  materialReady?: boolean;
  /** Routing decided (machine or vendor). */
  routingDecided?: boolean;
};

export type TransitionVerdict = { allowed: boolean; from: ProductionStatus | null; to: ProductionStatus | null; reasons: string[]; requiredFacts: string[] };

const PRINT_STAGES: ProductionStatus[] = ["routed", "printing", "cutting", "production"];

export function evaluateTransition(fromRaw: unknown, toRaw: unknown, facts: TransitionFacts = {}): TransitionVerdict {
  const from = normalizeStatus(fromRaw);
  const to = normalizeStatus(toRaw);
  if (!from || !to) {
    return { allowed: false, from, to, reasons: [`unknown status "${!from ? String(fromRaw) : String(toRaw)}"`], requiredFacts: [] };
  }
  const reasons: string[] = [];
  const required: string[] = [];
  if (from === to) return { allowed: false, from, to, reasons: ["already in that status"], requiredFacts: [] };
  if (!ALLOWED[from].includes(to)) reasons.push(`${from} -> ${to} is not a recognised move`);
  if (from === "on_hold" && to !== "cancelled" && facts.previousStatus && to !== facts.previousStatus) {
    reasons.push(`release from on_hold must return to ${facts.previousStatus}`);
  }
  if (PRINT_STAGES.includes(to) && from !== "on_hold") {
    if (!facts.artApproved) { reasons.push("art not approved on current version"); required.push("artApproved"); }
    if (to === "printing" && facts.materialReady === false) { reasons.push("material not ready"); required.push("materialReady"); }
    if (to === "printing" && facts.routingDecided === false) { reasons.push("machine routing not decided"); required.push("routingDecided"); }
  }
  if (to === "completed" && !facts.qcPassRecorded) { reasons.push("QC pass not recorded"); required.push("qcPassRecorded"); }
  if (to === "shipped") {
    if (from !== "completed") reasons.push("only completed jobs ship");
    if (!facts.shippingRecorded) { reasons.push("no tracking / delivery record"); required.push("shippingRecorded"); }
  }
  return { allowed: reasons.length === 0, from, to, reasons, requiredFacts: required };
}

export function nextStatuses(from: unknown): ProductionStatus[] {
  const s = normalizeStatus(from);
  return s ? ALLOWED[s] : [];
}
