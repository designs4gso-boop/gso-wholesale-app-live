// GSO Operations Agent Platform — Art Approval Coordinator (deterministic).
//
// CONTRACT (docs/GSO_ART_APPROVAL_CONTRACT.md):
//   * Every approval is bound to ONE art version AND its file hash.
//   * An agent may record TECHNICAL_PREFLIGHT_PASSED and nothing else.
//   * CUSTOMER_APPROVED comes from the customer proof portal
//     (ProductionJob.proofStatus = "approved") or from a staff member
//     recording the customer's explicit decision with evidence.
//   * FINAL_ART_APPROVED requires staff/owner AND an existing customer
//     approval AND a technical pass on the SAME version + hash.
//   * A new version (new hash) invalidates every prior approval. Production
//     readiness is computed from live records, never stored as a loose flag.

export const ART_APPROVAL_VERSION = "art-approval/1.0.0-2026-10-03";

export type ArtVersion = { versionId: string; fileHash: string; fileName: string; createdAt: string };

export type ApprovalState = "TECHNICAL_PREFLIGHT_PASSED" | "CUSTOMER_APPROVED" | "FINAL_ART_APPROVED";

export type ApproverType = "agent" | "staff" | "owner" | "customer_portal";

export type ApprovalRecord = {
  versionId: string;
  fileHash: string;
  state: ApprovalState;
  approverType: ApproverType;
  approverId: string;
  /** e.g. "proof-portal", "slack:U123", "erp:staff", "agent:art_preflight" */
  source: string;
  at: string;
  evidence: string | null;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
};

export type RecordApprovalInput = {
  version: ArtVersion;
  state: ApprovalState;
  approverType: ApproverType;
  approverId: string;
  source: string;
  evidence?: string | null;
  /** staff recording a customer's decision must set this AND evidence */
  onBehalfOfCustomer?: boolean;
  now?: Date;
};

export type RecordApprovalResult =
  | { ok: true; record: ApprovalRecord; records: ApprovalRecord[]; duplicate: boolean }
  | { ok: false; reason: string; records: ApprovalRecord[] };

function live(records: ApprovalRecord[], version: ArtVersion) {
  return records.filter((r) => !r.invalidatedAt && r.versionId === version.versionId && r.fileHash === version.fileHash);
}

export function recordApproval(records: ApprovalRecord[], input: RecordApprovalInput): RecordApprovalResult {
  const now = (input.now ?? new Date()).toISOString();
  const v = input.version;
  if (!v.versionId || !v.fileHash) return { ok: false, reason: "Approval must bind to a versionId and fileHash.", records };

  if (input.approverType === "agent" && input.state !== "TECHNICAL_PREFLIGHT_PASSED") {
    return { ok: false, reason: `An agent may only record TECHNICAL_PREFLIGHT_PASSED, never ${input.state}.`, records };
  }
  if (input.state === "CUSTOMER_APPROVED") {
    const portal = input.approverType === "customer_portal";
    const staffWithEvidence = (input.approverType === "staff" || input.approverType === "owner") && input.onBehalfOfCustomer === true && String(input.evidence ?? "").trim().length > 0;
    if (!portal && !staffWithEvidence) {
      return { ok: false, reason: "CUSTOMER_APPROVED needs the proof portal, or staff recording the customer's decision with evidence.", records };
    }
  }
  if (input.state === "FINAL_ART_APPROVED") {
    if (input.approverType !== "staff" && input.approverType !== "owner") return { ok: false, reason: "FINAL_ART_APPROVED requires staff or owner.", records };
    const current = live(records, v);
    if (!current.some((r) => r.state === "CUSTOMER_APPROVED")) return { ok: false, reason: "FINAL_ART_APPROVED requires CUSTOMER_APPROVED on the same version and hash.", records };
    if (!current.some((r) => r.state === "TECHNICAL_PREFLIGHT_PASSED")) return { ok: false, reason: "FINAL_ART_APPROVED requires TECHNICAL_PREFLIGHT_PASSED on the same version and hash.", records };
  }
  const existing = live(records, v).find((r) => r.state === input.state);
  if (existing) return { ok: true, record: existing, records, duplicate: true };
  const record: ApprovalRecord = {
    versionId: v.versionId,
    fileHash: v.fileHash,
    state: input.state,
    approverType: input.approverType,
    approverId: input.approverId,
    source: input.source,
    at: now,
    evidence: input.evidence ?? null,
    invalidatedAt: null,
    invalidatedBy: null,
  };
  return { ok: true, record, records: [...records, record], duplicate: false };
}

/** A new version invalidates every live approval on any other version/hash. */
export function registerNewVersion(records: ApprovalRecord[], version: ArtVersion, now = new Date()): { records: ApprovalRecord[]; invalidated: number } {
  let invalidated = 0;
  const out = records.map((r) => {
    if (r.invalidatedAt) return r;
    if (r.versionId === version.versionId && r.fileHash === version.fileHash) return r;
    invalidated += 1;
    return { ...r, invalidatedAt: now.toISOString(), invalidatedBy: version.versionId };
  });
  return { records: out, invalidated };
}

export type ProductionReadiness = { ready: boolean; reasons: string[]; states: ApprovalState[] };

export function productionArtReadiness(records: ApprovalRecord[], current: ArtVersion): ProductionReadiness {
  const states = live(records, current).map((r) => r.state);
  const reasons: string[] = [];
  if (!states.includes("TECHNICAL_PREFLIGHT_PASSED")) reasons.push("technical preflight not passed on current version");
  if (!states.includes("CUSTOMER_APPROVED")) reasons.push("customer approval missing on current version");
  if (!states.includes("FINAL_ART_APPROVED")) reasons.push("final art approval missing on current version");
  return { ready: reasons.length === 0, reasons, states };
}

/** Read-side bridge: the ERP proof portal's approved state as a CUSTOMER_APPROVED input. */
export function approvalFromProofPortal(
  job: { proofStatus?: string | null; proofApprovedAt?: string | Date | null; proofCustomerName?: string | null; proofCustomerEmail?: string | null; proofUrl?: string | null },
  version: ArtVersion,
): RecordApprovalInput | null {
  if (job.proofStatus !== "approved" || !job.proofApprovedAt) return null;
  const at = new Date(job.proofApprovedAt);
  return {
    version,
    state: "CUSTOMER_APPROVED",
    approverType: "customer_portal",
    approverId: String(job.proofCustomerEmail || job.proofCustomerName || "customer"),
    source: "proof-portal",
    evidence: `proofStatus=approved at ${at.toISOString()}${job.proofUrl ? ` for ${job.proofUrl}` : ""}`,
    now: at,
  };
}
