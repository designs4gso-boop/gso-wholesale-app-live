// GSO Operations Agent Platform — QA / QC Agent (deterministic).
//
// Builds the family-aware QC checklist from the ERP's own FAMILY_CHECKLISTS
// and reports whether a QC result has been RECORDED by a named person or
// device. It never asserts that an inspection happened.

import { checklistForFamily } from "../production-job-source.server";

export const QA_CHECKLIST_VERSION = "qa-checklist/1.0.0-2026-10-03";

export type QcStatus = "QC_REQUIRED" | "QC_PASS_RECORDED" | "QC_FAIL_RECORDED";

export type ChecklistFact = { section: string; label: string; completed: boolean };

export type RecordedQc = { result: "pass" | "fail"; recordedBy: string; recordedAt: string; notes?: string | null } | null;

export type QcAssessment = {
  version: string;
  status: QcStatus;
  family: string;
  requiredItems: Array<{ section: string; label: string }>;
  incompleteProductionItems: string[];
  incompleteQcItems: string[];
  reasons: string[];
  nextAction: string;
};

export function assessQc(input: { family: string; checklist?: ChecklistFact[]; recorded?: RecordedQc }): QcAssessment {
  const required = checklistForFamily(input.family).map((c) => ({ section: c.section, label: c.label }));
  const checklist = input.checklist ?? [];
  const incomplete = (section: string) => required.filter((r) => r.section === section).filter((r) => !checklist.some((c) => c.section === r.section && c.label === r.label && c.completed)).map((r) => r.label);
  const incompleteProduction = [...incomplete("prepress"), ...incomplete("production")];
  const incompleteQc = incomplete("qc");
  const reasons: string[] = [];
  let status: QcStatus = "QC_REQUIRED";
  if (input.recorded && String(input.recorded.recordedBy || "").trim()) {
    status = input.recorded.result === "pass" ? "QC_PASS_RECORDED" : "QC_FAIL_RECORDED";
    if (input.recorded.result === "pass" && incompleteProduction.length) reasons.push(`pass recorded but production steps incomplete: ${incompleteProduction.join(", ")}`);
  } else {
    if (input.recorded) reasons.push("QC result has no recorded actor; not accepted");
    reasons.push("no QC result recorded");
  }
  const nextAction = status === "QC_PASS_RECORDED" ? "Mark completed (transition guard requires qcPassRecorded)" : status === "QC_FAIL_RECORDED" ? "Route to reprint_needed; exception manager notified" : "QC: inspect against checklist and record pass/fail with your name";
  return { version: QA_CHECKLIST_VERSION, status, family: input.family, requiredItems: required, incompleteProductionItems: incompleteProduction, incompleteQcItems: incompleteQc, reasons, nextAction };
}
