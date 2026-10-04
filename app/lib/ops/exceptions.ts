// GSO Operations Agent Platform — Exception Manager (deterministic routing).
// Classifies an exception, picks the logical Slack destination, severity and
// next action. Blockers are never bypassed; every exception is routed to a
// human.

import type { SlackDestination } from "../slack/slack-config";
import type { AgentId } from "./agent-registry";

export const EXCEPTIONS_VERSION = "exceptions/1.0.0-2026-10-03";

export type ExceptionCode =
  | "MISSING_CANONICAL_DATA"
  | "ART_FAILURE"
  | "MACHINE_MISMATCH"
  | "MATERIAL_SHORTAGE"
  | "VENDOR_COST_MISSING"
  | "APPROVAL_MISSING"
  | "SLACK_FAILURE"
  | "DUPLICATE_WEBHOOK"
  | "LATE_PRODUCTION"
  | "UNTRUSTED_INSTRUCTION"
  | "DISABLED_ACTION_REQUESTED";

export type Severity = "info" | "warning" | "high" | "critical";

export type RoutedException = {
  version: string;
  code: ExceptionCode;
  severity: Severity;
  destination: SlackDestination;
  ownerAgent: AgentId;
  nextAction: string;
  entity: string;
  summary: string;
  at: string;
  idempotencyKey: string;
};

const TABLE: Record<ExceptionCode, { severity: Severity; destination: SlackDestination; ownerAgent: AgentId; nextAction: string }> = {
  MISSING_CANONICAL_DATA: { severity: "high", destination: "sales_quotes", ownerAgent: "quote_prep", nextAction: "Owner/staff: supply the missing canonical input (calibration, blank cost, white coverage); never estimate" },
  ART_FAILURE: { severity: "warning", destination: "art_approval", ownerAgent: "art_preflight", nextAction: "Designer: fix artwork or request a new customer file" },
  MACHINE_MISMATCH: { severity: "high", destination: "production_exceptions", ownerAgent: "production_dispatcher", nextAction: "Production: resolve the contradiction (white/gloss cannot run on the Mimaki)" },
  MATERIAL_SHORTAGE: { severity: "high", destination: "purchasing", ownerAgent: "purchasing_agent", nextAction: "Purchasing: review the prepared request; approve or source" },
  VENDOR_COST_MISSING: { severity: "warning", destination: "purchasing", ownerAgent: "purchasing_agent", nextAction: "Purchasing: obtain the vendor cost; the agent will not estimate" },
  APPROVAL_MISSING: { severity: "warning", destination: "agent_approvals", ownerAgent: "operations_supervisor", nextAction: "Approver: decide the pending intent" },
  SLACK_FAILURE: { severity: "warning", destination: "agent_approvals", ownerAgent: "operations_supervisor", nextAction: "Ops: check Slack token/scopes; intents are held, nothing lost" },
  DUPLICATE_WEBHOOK: { severity: "info", destination: "agent_approvals", ownerAgent: "operations_supervisor", nextAction: "none — duplicate ignored by idempotency" },
  LATE_PRODUCTION: { severity: "high", destination: "production_exceptions", ownerAgent: "production_planner", nextAction: "Production: re-plan or contact customer (staff)" },
  UNTRUSTED_INSTRUCTION: { severity: "warning", destination: "agent_approvals", ownerAgent: "operations_supervisor", nextAction: "Staff: read the flagged customer text; no agent acted on it" },
  DISABLED_ACTION_REQUESTED: { severity: "info", destination: "agent_approvals", ownerAgent: "operations_supervisor", nextAction: "none — action is disabled in this release" },
};

export function routeException(input: { code: ExceptionCode; entity: string; summary: string; now?: Date; dedupeKey?: string }): RoutedException {
  const t = TABLE[input.code];
  const at = (input.now ?? new Date()).toISOString();
  return {
    version: EXCEPTIONS_VERSION,
    code: input.code,
    severity: t.severity,
    destination: t.destination,
    ownerAgent: t.ownerAgent,
    nextAction: t.nextAction,
    entity: input.entity,
    summary: input.summary,
    at,
    idempotencyKey: input.dedupeKey ?? `exc:${input.code}:${input.entity}:${at.slice(0, 13)}`,
  };
}

export const EXCEPTION_CODES = Object.keys(TABLE) as ExceptionCode[];
