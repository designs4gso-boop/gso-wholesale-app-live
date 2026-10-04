// FakeReasoningProvider — deterministic, scriptable, network-free (OPS-2,
// Phase 39). Simulates a model that calls gateway tools and returns structured
// output. Scenarios cover normal classification, handoff, tool proposals,
// provider timeout/failure, malformed output, prompt injection, unauthorized
// tool/action requests and excessive turns. The gateway, not the fake, decides
// what is legal — exactly as with a real provider.

import type { ReasoningProvider, ProviderHealth, RunAgentInput, RunAgentResult } from "./provider";
import type { ToolCallRecord } from "./tool-gateway";

export type FakeScenario =
  | { kind: "classify"; output: unknown; toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }> }
  | { kind: "handoff"; to: string; reason: string }
  | { kind: "propose_then_output"; toolName: string; args: Record<string, unknown>; output: unknown }
  | { kind: "timeout" }
  | { kind: "provider_error"; message: string }
  | { kind: "malformed"; output: unknown }
  | { kind: "injection"; toolName: string; args: Record<string, unknown>; output: unknown }
  | { kind: "unauthorized_tool"; toolName: string; args: Record<string, unknown>; output: unknown }
  | { kind: "excessive_turns" };

export class FakeReasoningProvider implements ReasoningProvider {
  readonly providerId = "openai" as const; // reports as the preferred provider's shape; no network
  readonly capabilities = { tools: true, handoffs: true, structuredOutput: true, humanApproval: true, tracing: false, resumableRuns: true };
  private queue: FakeScenario[] = [];
  readonly runs: RunAgentInput[] = [];
  constructor(scenarios: FakeScenario[] = [], private readonly modelName = "fake-model") { this.queue = [...scenarios]; }
  script(...scenarios: FakeScenario[]) { this.queue.push(...scenarios); return this; }
  health(): ProviderHealth { return { providerId: "openai", configured: true, enabled: true, reasons: ["FAKE provider — no network, no billing"] }; }

  async runAgent(input: RunAgentInput): Promise<RunAgentResult> {
    this.runs.push(input);
    const scenario = this.queue.shift() ?? { kind: "classify", output: null } as FakeScenario;
    const toolCalls: ToolCallRecord[] = [];
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const result = await input.executeTool({ toolName, args, agentId: input.agentId, specialistKey: input.specialistKey, requestId: input.context.requestId, provider: "fake", model: this.modelName });
      toolCalls.push({ toolName, ok: result.ok, code: result.ok ? undefined : result.code, intentId: result.ok && result.kind === "proposal" ? result.intentId : undefined, at: new Date().toISOString() });
      return result;
    };
    const model = this.modelName;
    switch (scenario.kind) {
      case "timeout": return { status: "failed", kind: "timeout", error: `fake provider timed out after ${input.limits.timeoutMs}ms`, toolCalls, turns: 1, model };
      case "provider_error": return { status: "failed", kind: "provider_error", error: scenario.message, toolCalls, turns: 1, model };
      case "excessive_turns": return { status: "failed", kind: "max_turns", error: `max turns (${input.limits.maxTurns}) exceeded`, toolCalls, turns: input.limits.maxTurns + 1, model };
      case "malformed": return { status: "completed", output: scenario.output, toolCalls, turns: 1, model };
      case "handoff": return { status: "handoff", toSpecialistKey: scenario.to, reason: scenario.reason, toolCalls, turns: 1, model };
      case "classify": {
        for (const c of scenario.toolCalls ?? []) await call(c.toolName, c.args);
        return { status: "completed", output: scenario.output, toolCalls, turns: 1 + (scenario.toolCalls?.length ?? 0), model };
      }
      case "propose_then_output":
      case "injection":
      case "unauthorized_tool": {
        const r = await call(scenario.toolName, scenario.args);
        if (r.ok && r.kind === "proposal" && r.requiresApproval && !input.resumeState) {
          return { status: "paused_for_approval", intentId: r.intentId, state: JSON.stringify({ fake: true, specialist: input.specialistKey, intentId: r.intentId, pendingOutput: scenario.output }), toolCalls, turns: 2, model };
        }
        if (!r.ok && scenario.kind === "unauthorized_tool") return { status: "failed", kind: "unauthorized_tool", error: r.error, toolCalls, turns: 2, model };
        return { status: "completed", output: scenario.output, toolCalls, turns: 2, model };
      }
    }
  }
}
