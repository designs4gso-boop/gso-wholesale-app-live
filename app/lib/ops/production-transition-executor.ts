// GSO Operations Agent Platform — THE production transition executor (OPS-2).
//
// The single server-side path by which an agent-originated status change may
// reach a ProductionJob. Dependencies are injected so the executor runs with
// memory repositories and a mocked job store in tests, and with Prisma-backed
// dependencies (production-transition-executor.server.ts) at runtime.
//
// Order of checks — ALL must pass before the mutation callback is invoked:
//   1. intent exists, is move_production_job for this job/target, and is APPROVED
//   2. execution kill switch is on (GSO_AGENT_EXECUTION_ENABLED)
//   3. job exists; current status is known; target status is known
//   4. deterministic transition guard with real facts (art approval, QC, shipping, hold)
//   5. canonical machine routing has no BLOCK for print stages
//   6. idempotency: a COMPLETED intent never mutates twice; a job already at
//      target via this intent is a no-op
//   7. audit written via the intent engine; only then the mutation runs

import { executeIntent, type ActionIntent, type Actor } from "./action-intents";
import { evaluateTransition, normalizeStatus, type ProductionStatus, type TransitionFacts } from "./production-transitions";
import type { OpsRepositories } from "./repositories";
import type { OpsRuntimeConfig } from "./runtime-config";

export const PRODUCTION_TRANSITION_EXECUTOR_VERSION = "production-transition-executor/1.0.0-2026-10-04";

export type JobSnapshot = { id: string; shop: string; jobTicket: string | null; status: string; previousStatus?: string | null };

export type RoutingCheck = { blocked: boolean; reasons: string[] };

export type TransitionDeps = {
  loadJob(jobId: string): Promise<JobSnapshot | null>;
  /** Real facts from the ERP: art approval on the current version, recorded QC, shipping record, material/routing. */
  loadFacts(job: JobSnapshot, target: ProductionStatus): Promise<TransitionFacts>;
  /** Canonical routing check for print stages (decideMachine over the job's items). */
  checkRouting(job: JobSnapshot, target: ProductionStatus): Promise<RoutingCheck>;
  /** The ONLY write. Must set status and append a status_change event naming the intent. */
  applyTransition(job: JobSnapshot, target: ProductionStatus, intent: ActionIntent, actor: Actor): Promise<{ externalReference: string }>;
};

export type TransitionRequest = { jobId: string; targetStatus: string; actionIntentId: string; actor: Actor };

export type TransitionOutcome =
  | { ok: true; duplicate: boolean; from: ProductionStatus; to: ProductionStatus; intentId: string; externalReference: string | null }
  | { ok: false; stage: "intent" | "kill_switch" | "job" | "status" | "guard" | "routing" | "execution"; reasons: string[]; intentId: string };

const PRINT_STAGES: ProductionStatus[] = ["routed", "printing", "cutting", "production"];

export async function requestProductionTransition(req: TransitionRequest, deps: TransitionDeps, repos: OpsRepositories, config: OpsRuntimeConfig, now = new Date()): Promise<TransitionOutcome> {
  const intent = await repos.intents.getById(req.actionIntentId);
  if (!intent) return { ok: false, stage: "intent", reasons: ["action intent not found"], intentId: req.actionIntentId };
  if (intent.actionType !== "move_production_job") return { ok: false, stage: "intent", reasons: [`intent is ${intent.actionType}, not move_production_job`], intentId: intent.id };
  if (intent.entityType !== "job" || intent.entityId !== req.jobId) return { ok: false, stage: "intent", reasons: ["intent is bound to a different job"], intentId: intent.id };
  const intendedTarget = normalizeStatus(intent.payload.targetStatus);
  const target = normalizeStatus(req.targetStatus);
  if (!target) return { ok: false, stage: "status", reasons: [`unknown target status "${req.targetStatus}"`], intentId: intent.id };
  if (intendedTarget !== target) return { ok: false, stage: "intent", reasons: [`intent targets ${intendedTarget ?? "unknown"}, request targets ${target}`], intentId: intent.id };
  if (intent.status === "COMPLETED") return { ok: true, duplicate: true, from: target, to: target, intentId: intent.id, externalReference: intent.externalReference };
  if (intent.status !== "APPROVED") return { ok: false, stage: "intent", reasons: [`intent is ${intent.status}; approval required before any job movement`], intentId: intent.id };
  if (!config.executionEnabled) return { ok: false, stage: "kill_switch", reasons: ["GSO_AGENT_EXECUTION_ENABLED is false"], intentId: intent.id };

  const job = await deps.loadJob(req.jobId);
  if (!job) return { ok: false, stage: "job", reasons: ["job not found"], intentId: intent.id };
  const from = normalizeStatus(job.status);
  if (!from) return { ok: false, stage: "status", reasons: [`job has unknown status "${job.status}"`], intentId: intent.id };
  if (from === target) return { ok: false, stage: "status", reasons: ["job is already in the target status"], intentId: intent.id };

  const facts = await deps.loadFacts(job, target);
  const verdict = evaluateTransition(from, target, { ...facts, previousStatus: facts.previousStatus ?? (job.previousStatus ? normalizeStatus(job.previousStatus) : null) });
  if (!verdict.allowed) return { ok: false, stage: "guard", reasons: verdict.reasons, intentId: intent.id };

  if (PRINT_STAGES.includes(target)) {
    const routing = await deps.checkRouting(job, target);
    if (routing.blocked) return { ok: false, stage: "routing", reasons: routing.reasons.length ? routing.reasons : ["canonical machine routing BLOCK"], intentId: intent.id };
  }

  const result = await executeIntent(repos.intents, intent.id, async (approved) => deps.applyTransition(job, target, approved, req.actor), { now, gate: { executionEnabled: config.executionEnabled }, actor: req.actor });
  if (!result.ok) return { ok: false, stage: "execution", reasons: [result.reason], intentId: intent.id };
  return { ok: true, duplicate: result.duplicate, from, to: target, intentId: intent.id, externalReference: result.intent.externalReference };
}
