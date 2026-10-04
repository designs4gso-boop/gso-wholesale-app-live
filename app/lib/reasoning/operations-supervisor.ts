// GSO Operations Supervisor runtime (OPS-2, Phases 8, 16, 17, 19, 20).
//
// Orchestrates ONE reasoning request end to end, provider-neutral:
//   normalize request -> reasoning kill switch -> provider.runAgent with the
//   specialist's allow-listed tools (through the Tool Gateway) -> validate the
//   structured output -> typed handoff (bounded) -> paused_for_approval maps to
//   an ActionIntent + persisted AgentRun -> deterministic fallback on every
//   failure. The model never touches business state; the gateway does, via
//   intents.

import type { OpsRepositories, AgentRun } from "../ops/repositories";
import type { OpsRuntimeConfig } from "../ops/runtime-config";
import { reasoningAvailable } from "../ops/runtime-config";
import { asUntrustedData, scanUntrustedText } from "../ops/untrusted-text";
import { classifyLead, type LeadInput } from "../ops/sales-intake";
import type { ReasoningProvider, ReasoningContext, RunAgentResult } from "./provider";
import { validateOutput } from "./schemas";
import { SPECIALISTS, canHandoff, specialistFor } from "./specialists";
import type { ToolGateway, ToolCallRecord } from "./tool-gateway";

export const OPERATIONS_SUPERVISOR_VERSION = "operations-supervisor/1.0.0-2026-10-04";

export type SupervisorRequest = {
  requestId: string;
  requester: ReasoningContext["requester"];
  /** Staff/customer text — UNTRUSTED. */
  text: string | null;
  facts: ReasoningContext["facts"];
  /** Optional deterministic hint (e.g. from a lead already classified). */
  lead?: LeadInput | null;
  specialistKey?: string;
};

export type SupervisorOutcome = {
  version: string;
  mode: "reasoning" | "deterministic_fallback";
  specialistKey: string;
  provider: string;
  model: string | null;
  status: "completed" | "paused_for_approval" | "fallback";
  output: unknown;
  fallbackReason: string | null;
  intentId: string | null;
  runId: string | null;
  handoffs: string[];
  toolCalls: ToolCallRecord[];
  injectionFlags: string[];
};

export type SupervisorDeps = { provider: ReasoningProvider; gateway: ToolGateway; repos: OpsRepositories; config: OpsRuntimeConfig; now?: () => Date };

const MAX_HANDOFFS = 2;

/** Deterministic fallback (Phase 20): routing by keyword + a plain recommendation. Never prices. */
export function deterministicFallback(req: SupervisorRequest, reason: string): SupervisorOutcome {
  const lead = req.lead ?? (req.text ? { source: "supervisor", freeText: req.text } : null);
  const classification = lead ? classifyLead(lead) : null;
  const specialist = classification?.routeTo === "cannabis_packaging_sales" || classification?.routeTo === "commercial_print_sales" ? classification.routeTo : "operations_supervisor";
  return {
    version: OPERATIONS_SUPERVISOR_VERSION,
    mode: "deterministic_fallback",
    specialistKey: specialist,
    provider: "none",
    model: null,
    status: "fallback",
    output: {
      summary: classification?.family ? `Deterministic routing: ${classification.family} -> ${specialist}.` : "Deterministic routing: family unknown; sales intake collects standard fields.",
      nextSteps: ["Staff review in the Agent Review Queue", "Quote readiness via quote_prep (deterministic)"],
      escalate: false,
      escalationReason: null,
      proposals: [],
    },
    fallbackReason: reason,
    intentId: null,
    runId: null,
    handoffs: [],
    toolCalls: [],
    injectionFlags: req.text ? scanUntrustedText(req.text).flags : [],
  };
}

export async function runOperationsSupervisor(req: SupervisorRequest, deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const now = deps.now?.() ?? new Date();
  if (!reasoningAvailable(deps.config)) return deterministicFallback(req, `reasoning unavailable: ${deps.config.reasoningBlockers.join("; ")}`);
  const health = deps.provider.health();
  if (!health.enabled || !health.configured) return deterministicFallback(req, `provider not ready: ${health.reasons.join("; ")}`);

  const scan = scanUntrustedText(req.text);
  const context: ReasoningContext = {
    requestId: req.requestId,
    requester: req.requester,
    untrustedText: req.text ? asUntrustedData("staff_or_customer_text", req.text) : null,
    facts: { ...req.facts, ...(scan.instructionLike ? { untrustedInstructionFlagged: true } : {}) },
  };

  let specialistKey = req.specialistKey ?? "operations_supervisor";
  const handoffs: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let result: RunAgentResult | null = null;

  for (let hop = 0; hop <= MAX_HANDOFFS; hop += 1) {
    const spec = specialistFor(specialistKey);
    if (!spec) return deterministicFallback(req, `unknown specialist "${specialistKey}"`);
    const limits = { maxTurns: Math.min(spec.maxTurns, deps.config.limits.maxTurns), timeoutMs: Math.min(spec.timeoutMs, deps.config.limits.timeoutMs), maxToolCalls: Math.min(spec.maxToolCalls, deps.config.limits.maxToolCalls) };
    result = await deps.provider.runAgent({
      agentId: spec.agentId, specialistKey: spec.key, allowedTools: [...spec.allowedTools], outputSchema: spec.outputSchema, context, limits,
      executeTool: (request) => deps.gateway.execute({ ...request, agentId: spec.agentId, specialistKey: spec.key, requestId: req.requestId }),
    });
    if (result.status !== "disabled") toolCalls.push(...result.toolCalls);
    if (result.status === "handoff") {
      if (!canHandoff(spec.key, result.toSpecialistKey)) return { ...deterministicFallback(req, `unauthorized handoff ${spec.key} -> ${result.toSpecialistKey} refused`), toolCalls, handoffs };
      handoffs.push(result.toSpecialistKey);
      specialistKey = result.toSpecialistKey;
      if (hop === MAX_HANDOFFS) return { ...deterministicFallback(req, `handoff limit (${MAX_HANDOFFS}) reached`), toolCalls, handoffs };
      continue;
    }
    break;
  }
  if (!result) return deterministicFallback(req, "no provider result");
  const spec = SPECIALISTS[specialistKey as keyof typeof SPECIALISTS];
  const base = { version: OPERATIONS_SUPERVISOR_VERSION, mode: "reasoning" as const, specialistKey, provider: deps.provider.providerId, handoffs, toolCalls, injectionFlags: scan.flags };

  if (result.status === "disabled") return deterministicFallback(req, result.reason);
  if (result.status === "failed") return { ...deterministicFallback(req, `provider ${result.kind}: ${result.error}`), toolCalls, handoffs, injectionFlags: scan.flags };

  if (result.status === "handoff") return { ...deterministicFallback(req, "handoff not resolved"), toolCalls, handoffs };

  if (result.status === "paused_for_approval") {
    const run: AgentRun = { id: `run_${req.requestId}_${now.getTime().toString(36)}`, agentId: spec.agentId, provider: deps.provider.providerId, model: result.model, status: "PAUSED_FOR_APPROVAL", intentId: result.intentId, state: result.state, turns: result.turns, startedAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: null, error: null };
    await deps.repos.runs.save(run);
    return { ...base, model: result.model, status: "paused_for_approval", output: null, fallbackReason: null, intentId: result.intentId, runId: run.id };
  }

  const validated = validateOutput(spec.outputSchema, result.output);
  if (!validated.ok) return { ...deterministicFallback(req, `malformed model output: ${validated.errors.join("; ")}`), toolCalls, handoffs, injectionFlags: scan.flags };
  return { ...base, model: result.model, status: "completed", output: validated.value, fallbackReason: null, intentId: null, runId: null };
}

/**
 * Resume a paused run after the human decision was recorded on the
 * ActionIntent (the ONLY approval authority). The provider resumes with the
 * decision; a rejection resumes as rejected so the model can summarise.
 */
export async function resumeAfterDecision(runId: string, deps: SupervisorDeps, requester: ReasoningContext["requester"]): Promise<{ ok: true; outcome: SupervisorOutcome } | { ok: false; reason: string }> {
  const run = await deps.repos.runs.get(runId);
  if (!run || run.status !== "PAUSED_FOR_APPROVAL" || !run.intentId) return { ok: false, reason: "run is not paused for approval" };
  const intent = await deps.repos.intents.getById(run.intentId);
  if (!intent) return { ok: false, reason: "intent not found" };
  if (intent.status === "AWAITING_APPROVAL") return { ok: false, reason: "intent still awaiting a human decision" };
  const decision = intent.status === "APPROVED" || intent.status === "COMPLETED" ? "approved" : "rejected";
  const spec = Object.values(SPECIALISTS).find((s) => s.agentId === run.agentId) ?? SPECIALISTS.operations_supervisor;
  const now = deps.now?.() ?? new Date();
  const result = await deps.provider.runAgent({
    agentId: spec.agentId, specialistKey: spec.key, allowedTools: [...spec.allowedTools], outputSchema: spec.outputSchema,
    context: { requestId: run.id, requester, untrustedText: null, facts: { resumedIntent: run.intentId, decision } },
    limits: { maxTurns: spec.maxTurns, timeoutMs: spec.timeoutMs, maxToolCalls: spec.maxToolCalls },
    executeTool: (request) => deps.gateway.execute({ ...request, agentId: spec.agentId, specialistKey: spec.key, requestId: run.id }),
    resumeState: run.state, resumeDecision: decision,
  });
  const updated: AgentRun = { ...run, status: result.status === "completed" ? "COMPLETED" : result.status === "failed" ? "FAILED" : run.status, updatedAt: now.toISOString(), completedAt: result.status === "completed" ? now.toISOString() : null, error: result.status === "failed" ? result.error : null, turns: run.turns + ("turns" in result ? result.turns : 0) };
  await deps.repos.runs.save(updated);
  const outcome: SupervisorOutcome = { version: OPERATIONS_SUPERVISOR_VERSION, mode: "reasoning", specialistKey: spec.key, provider: deps.provider.providerId, model: "model" in result ? result.model : null, status: result.status === "completed" ? "completed" : "fallback", output: result.status === "completed" ? result.output : null, fallbackReason: result.status === "completed" ? null : `resume ${result.status}`, intentId: run.intentId, runId: run.id, handoffs: [], toolCalls: "toolCalls" in result ? result.toolCalls : [], injectionFlags: [] };
  return { ok: true, outcome };
}
