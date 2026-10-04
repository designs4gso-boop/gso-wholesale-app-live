// Stage 4 (2026-10-04) — guarded REAL test-job transition.
//
// Proves ONE owner-approved TEST ProductionJob can move
//   proof_approved -> printing
// through: durable ActionIntent -> Slack owner approval -> the centralized
// requestProductionTransition() -> deterministic guard -> one status write ->
// durable audit -> duplicate-execution protection.
//
// Everything is locked: exactly one ticket, exactly one source status, exactly
// one target. The job id is resolved server-side from the ticket (0 or >1 rows
// fail closed). Creation needs the Slack sandbox; execution needs the global
// execution switch AND an explicit owner click on the hub — never a Slack
// click, never a worker. This module has no database import and never writes
// a ProductionJob itself: the only write happens inside the executor's
// injected applyTransition. Client-safe; dependencies are injected.

import { proposeIntent, validateIntent, type ActionIntent, type Actor } from "./action-intents";
import { requestProductionTransition, type TransitionDeps, type TransitionOutcome } from "./production-transition-executor";
import { evaluateTransition, normalizeStatus, type TransitionFacts } from "./production-transitions";
import type { OpsRepositories } from "./repositories";
import type { OpsRuntimeConfig } from "./runtime-config";
import { recordSlackCardPosted, type SandboxSlackPoster } from "./sandbox-approval-test";
import { intentCard } from "../slack/slack-blocks";
import { SLACK_ENV_VARS, type SlackEnv } from "../slack/slack-config";

export const STAGE4_VERSION = "stage4-test-transition/1.0.0-2026-10-04";

export const STAGE4 = {
  ticket: "GSO-20260510-0004",
  from: "proof_approved",
  target: "printing",
  agentId: "production_planner",
  actionType: "move_production_job",
  reason: "Stage 4 guarded transition test on owner-approved TEST ProductionJob.",
} as const;

export type Stage4JobRow = { id: string; shop: string; jobTicket: string | null; status: string };

export type Stage4Deps = {
  repos: OpsRepositories;
  config: OpsRuntimeConfig;
  slackEnv: SlackEnv;
  slack: SandboxSlackPoster;
  /** Authoritative lookup by ticket within the shop (Prisma in the hub; a fake in tests). */
  findJobsByTicket(ticket: string): Promise<Stage4JobRow[]>;
  /** The SAME dependencies the centralized executor uses (prismaTransitionDeps at runtime). */
  transitionDeps: TransitionDeps;
  now?: Date;
};

export type GateCheck = { ok: boolean; reasons: string[]; checks: Record<string, boolean> };

export function stage4Gate(config: OpsRuntimeConfig, slackEnv: SlackEnv, phase: "create" | "execute"): GateCheck {
  const checks: Record<string, boolean> = {
    prismaRepository: config.repository === "prisma",
    reasoningDisabled: config.reasoningEnabled === false,
    sandboxOnlyTrue: String(slackEnv[SLACK_ENV_VARS.sandboxOnly] ?? "").trim().toLowerCase() === "true",
  };
  if (phase === "create") {
    checks.botTokenPresent = Boolean(slackEnv[SLACK_ENV_VARS.botToken]?.trim());
    checks.signingSecretPresent = Boolean(slackEnv[SLACK_ENV_VARS.signingSecret]?.trim());
    checks.testChannelPresent = Boolean(slackEnv[SLACK_ENV_VARS.testChannel]?.trim());
  } else {
    checks.executionEnabled = config.executionEnabled === true;
  }
  const reasons = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => `${k} failed`);
  return { ok: reasons.length === 0, reasons, checks };
}

export type JobResolution = { ok: true; job: Stage4JobRow } | { ok: false; reasons: string[]; matches: number };

/** Exactly one row, exactly the locked ticket, exactly the locked source status. */
export async function resolveStage4Job(deps: Stage4Deps, requireSourceStatus = true): Promise<JobResolution> {
  const rows = await deps.findJobsByTicket(STAGE4.ticket);
  if (rows.length !== 1) return { ok: false, reasons: [`expected exactly 1 ProductionJob with ticket ${STAGE4.ticket}, found ${rows.length}`], matches: rows.length };
  const job = rows[0];
  if (job.jobTicket !== STAGE4.ticket) return { ok: false, reasons: [`loaded job ticket "${job.jobTicket}" is not ${STAGE4.ticket}`], matches: 1 };
  if (requireSourceStatus && normalizeStatus(job.status) !== STAGE4.from) return { ok: false, reasons: [`job status is "${job.status}", expected ${STAGE4.from}`], matches: 1 };
  return { ok: true, job };
}

export type Stage4Preflight = {
  version: string;
  ticket: string;
  target: string;
  job: Stage4JobRow | null;
  currentStatus: string | null;
  facts: TransitionFacts | null;
  routing: { blocked: boolean; reasons: string[] } | null;
  guard: { allowed: boolean; reasons: string[]; requiredFacts: string[] } | null;
  blockers: string[];
  ok: boolean;
};

/** Loads the SAME real facts the executor will use and runs the SAME guard. Invents nothing. */
export async function stage4Preflight(deps: Stage4Deps): Promise<Stage4Preflight> {
  const base: Stage4Preflight = { version: STAGE4_VERSION, ticket: STAGE4.ticket, target: STAGE4.target, job: null, currentStatus: null, facts: null, routing: null, guard: null, blockers: [], ok: false };
  const resolved = await resolveStage4Job(deps, false);
  if (!resolved.ok) return { ...base, blockers: resolved.reasons };
  const job = resolved.job;
  const from = normalizeStatus(job.status);
  const blockers: string[] = [];
  if (from !== STAGE4.from) blockers.push(`current status "${job.status}" is not ${STAGE4.from}`);
  const facts = await deps.transitionDeps.loadFacts(job, STAGE4.target);
  const routing = await deps.transitionDeps.checkRouting(job, STAGE4.target);
  const guard = from ? evaluateTransition(from, STAGE4.target, facts) : { allowed: false, reasons: [`unknown status "${job.status}"`], requiredFacts: [] };
  if (!guard.allowed) blockers.push(...guard.reasons.map((r) => `guard: ${r}`));
  if (routing.blocked) blockers.push(...routing.reasons.map((r) => `routing: ${r}`));
  if (!facts.artApproved) blockers.push("fact artApproved is false (no portal approval and no staff proof_approved event)");
  return { ...base, job, currentStatus: job.status, facts, routing, guard: { allowed: guard.allowed, reasons: guard.reasons, requiredFacts: guard.requiredFacts }, blockers: Array.from(new Set(blockers)), ok: blockers.length === 0 };
}

export type Stage4CreateResult =
  | { ok: true; intent: ActionIntent; duplicateIntent: boolean; slack: { channel: string; ts: string; duplicate: boolean }; preflight: Stage4Preflight }
  | { ok: false; stage: "gate" | "runKey" | "preflight" | "intent" | "validate" | "destination" | "slack"; reasons: string[]; preflight?: Stage4Preflight; intentId?: string };

export async function createStage4Intent(deps: Stage4Deps, runKey: string, requestedBy: { id: string; name?: string }): Promise<Stage4CreateResult> {
  const gate = stage4Gate(deps.config, deps.slackEnv, "create");
  if (!gate.ok) return { ok: false, stage: "gate", reasons: gate.reasons };
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(runKey ?? ""))) return { ok: false, stage: "runKey", reasons: ["run key must be server-generated (8-80 url-safe chars)"] };
  const preflight = await stage4Preflight(deps);
  if (!preflight.ok || !preflight.job) return { ok: false, stage: "preflight", reasons: preflight.blockers, preflight };
  const now = deps.now ?? new Date();
  const job = preflight.job;

  const proposed = await proposeIntent(deps.repos.intents, {
    actionType: STAGE4.actionType,
    agentId: STAGE4.agentId,
    entityType: "job",
    entityId: job.id,
    payload: { targetStatus: STAGE4.target, stage4Test: true, jobTicket: STAGE4.ticket, runKey },
    reason: STAGE4.reason,
    idempotencyKey: `stage4:${job.id}:${runKey}`,
    actor: { type: "staff", id: requestedBy.id, name: requestedBy.name, source: "ops-hub:stage4" },
    now,
  });
  if (!proposed.ok) return { ok: false, stage: "intent", reasons: [proposed.reason], preflight };
  if (!proposed.duplicate) {
    const v = await validateIntent(deps.repos.intents, proposed.intent.id, { type: "system", id: "ops-hub" }, now);
    if (!v.ok) return { ok: false, stage: "validate", reasons: [v.reason], preflight, intentId: proposed.intent.id };
  }
  const intent = (await deps.repos.intents.getById(proposed.intent.id))!;
  if (intent.autonomyLevel !== "APPROVAL_REQUIRED" || !["AWAITING_APPROVAL", "APPROVED", "COMPLETED"].includes(intent.status)) {
    return { ok: false, stage: "validate", reasons: [`unexpected intent state ${intent.status}/${intent.autonomyLevel}`], preflight, intentId: intent.id };
  }

  const target = deps.slack.destination("production");
  const testChannel = String(deps.slackEnv[SLACK_ENV_VARS.testChannel]).replace(/^#/, "");
  if (!target.channel || !target.sandboxRedirected || String(target.channel).replace(/^#/, "") !== testChannel) {
    return { ok: false, stage: "destination", reasons: [`destination did not resolve to the sandbox channel (${target.reason})`], preflight, intentId: intent.id };
  }
  const blocks = intentCard({
    // The ticket is carried in the title: fact values pass through PII
    // redaction, which treats long digit runs like phone numbers.
    title: `STAGE 4 TEST — ${STAGE4.ticket}: ${job.status} → ${STAGE4.target}`,
    intent,
    facts: [
      ["Ticket", STAGE4.ticket.replace(/-/g, "‑")],
      ["Current status", job.status],
      ["Target status", STAGE4.target],
      ["Intent ID", intent.id],
      ["Guard / preflight", `allowed · artApproved=${String(preflight.facts?.artApproved)} · routing=${preflight.routing?.blocked ? "BLOCKED" : "clear"}`],
      ["Execution kill switch", deps.config.executionEnabled ? "ON" : "OFF — approval records only; a separate owner click on the hub executes"],
      ["Requested by", requestedBy.name || requestedBy.id],
    ],
    destination: "production",
    sandboxRedirected: true,
    erpPath: "/app/erp/ops-hub",
    footer: "SANDBOX · STAGE 4 TEST. Approving here never moves the job. Execution requires GSO_AGENT_EXECUTION_ENABLED=true and the owner's EXECUTE button on the Operations Hub.",
  });
  const posted = await deps.slack.postBlocks({ destination: "production", text: `SANDBOX STAGE 4 TEST ${STAGE4.ticket} ${job.status} -> ${STAGE4.target} (${intent.id})`, blocks, idempotencyKey: `stage4:${intent.id}` });
  if (!posted.ok) return { ok: false, stage: "slack", reasons: [posted.error], preflight, intentId: intent.id };
  if (!posted.duplicate) await recordSlackCardPosted(deps.repos, intent, posted, now);
  return { ok: true, intent, duplicateIntent: proposed.duplicate, slack: { channel: posted.channel, ts: posted.ts, duplicate: posted.duplicate }, preflight };
}

/** Stage 4 intents for a job id, newest first. */
export async function findStage4Intents(repos: OpsRepositories, jobId: string): Promise<ActionIntent[]> {
  const rows = await repos.intents.list({ entityType: "job", entityId: jobId });
  return rows.filter((i) => i.actionType === STAGE4.actionType && i.payload?.stage4Test === true).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type Stage4ExecuteResult =
  | { ok: true; duplicate: boolean; outcome: TransitionOutcome; intentId: string }
  | { ok: false; stage: "gate" | "intent" | "job" | "executor"; reasons: string[]; intentId: string | null; outcome?: TransitionOutcome };

/**
 * The owner's explicit final action. Every check repeats server-side; then the
 * ONLY call that can write is requestProductionTransition().
 */
export async function executeStage4(deps: Stage4Deps, intentId: string, actor: Actor): Promise<Stage4ExecuteResult> {
  const gate = stage4Gate(deps.config, deps.slackEnv, "execute");
  if (!gate.ok) return { ok: false, stage: "gate", reasons: gate.reasons, intentId };
  const intent = await deps.repos.intents.getById(String(intentId ?? ""));
  if (!intent) return { ok: false, stage: "intent", reasons: ["approved Stage 4 intent not found"], intentId: null };
  const intentReasons: string[] = [];
  if (intent.actionType !== STAGE4.actionType) intentReasons.push(`intent action is ${intent.actionType}`);
  if (intent.payload?.targetStatus !== STAGE4.target) intentReasons.push(`intent target is ${String(intent.payload?.targetStatus)}`);
  if (intent.payload?.stage4Test !== true || intent.payload?.jobTicket !== STAGE4.ticket) intentReasons.push("intent is not a Stage 4 intent for the locked ticket");
  if (intent.entityType !== "job") intentReasons.push(`intent entity type is ${intent.entityType}`);
  if (intentReasons.length) return { ok: false, stage: "intent", reasons: intentReasons, intentId: intent.id };

  // Already executed: no second business write, report the duplicate (ticket may now be printing).
  if (intent.status === "COMPLETED") {
    const resolved = await resolveStage4Job(deps, false);
    if (resolved.ok && resolved.job.id !== intent.entityId) return { ok: false, stage: "intent", reasons: ["intent entity does not match the loaded job"], intentId: intent.id };
    return { ok: true, duplicate: true, intentId: intent.id, outcome: { ok: true, duplicate: true, from: STAGE4.target, to: STAGE4.target, intentId: intent.id, externalReference: intent.externalReference } };
  }
  if (intent.status !== "APPROVED") return { ok: false, stage: "intent", reasons: [`intent is ${intent.status}; it must be APPROVED by a mapped human first`], intentId: intent.id };

  const resolved = await resolveStage4Job(deps, true);
  if (!resolved.ok) return { ok: false, stage: "job", reasons: resolved.reasons, intentId: intent.id };
  if (intent.entityId !== resolved.job.id) return { ok: false, stage: "intent", reasons: ["intent entity does not match the loaded job"], intentId: intent.id };

  const outcome = await requestProductionTransition({ jobId: resolved.job.id, targetStatus: STAGE4.target, actionIntentId: intent.id, actor }, deps.transitionDeps, deps.repos, deps.config, deps.now ?? new Date());
  if (!outcome.ok) return { ok: false, stage: "executor", reasons: outcome.reasons, intentId: intent.id, outcome };
  return { ok: true, duplicate: outcome.duplicate, outcome, intentId: intent.id };
}
