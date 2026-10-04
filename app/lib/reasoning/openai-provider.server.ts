// OpenAIReasoningProvider — the preferred production reasoning runtime (OPS-2,
// Phase 6), built on the official OpenAI Agents SDK (@openai/agents 0.18).
//
// SERVER-ONLY. RUNTIME-DISABLED unless ALL of: GSO_REASONING_PROVIDER=openai,
// GSO_AGENT_REASONING_ENABLED=true, OPENAI_API_KEY present, GSO_OPENAI_MODEL set.
// The SDK is loaded lazily (dynamic import) so the ERP never pays for it, and
// no key is ever read outside this module. Tracing export is DISABLED by
// default and sensitive data is never included unless the owner opts in.
//
// Division of labour: the SDK runs the turn loop, tool-call protocol, typed
// handoffs, guardrails and approval interruptions. GSO owns tool semantics
// (Tool Gateway), permissions, ActionIntents, approvals, audit, idempotency,
// execution and all business rules. The SDK's interruption for a tool with
// needsApproval=true is mapped to the ActionIntent the gateway already
// created; resuming is driven by the intent's human decision, never the SDK.
//
// Engineering tools (shell, apply_patch, computer, MCP, hosted web) are never
// registered — see FORBIDDEN_TOOL_PATTERNS in tool-gateway.ts.

import type { OpsRuntimeConfig } from "../ops/runtime-config";
import type { ReasoningProvider, ProviderHealth, RunAgentInput, RunAgentResult } from "./provider";
import { SCHEMAS } from "./schemas";
import { SPECIALISTS } from "./specialists";
import { definitionFor, type ToolCallRecord, type ToolDefinition } from "./tool-gateway";

export const OPENAI_PROVIDER_VERSION = "openai-provider/1.0.0-2026-10-04";

type Env = Record<string, string | undefined>;

type SdkModule = typeof import("@openai/agents");

export class OpenAIReasoningProvider implements ReasoningProvider {
  readonly providerId = "openai" as const;
  readonly capabilities = { tools: true, handoffs: true, structuredOutput: true, humanApproval: true, tracing: true, resumableRuns: true };
  private sdk: Promise<SdkModule> | null = null;

  constructor(private readonly config: OpsRuntimeConfig, private readonly env: Env = process.env as Env) {}

  health(): ProviderHealth {
    const reasons: string[] = [];
    if (this.config.provider !== "openai") reasons.push("GSO_REASONING_PROVIDER is not openai");
    if (!this.config.reasoningEnabled) reasons.push("GSO_AGENT_REASONING_ENABLED is not true");
    if (!this.config.openai.apiKeyPresent) reasons.push("OPENAI_API_KEY absent");
    if (!this.config.openai.model) reasons.push("GSO_OPENAI_MODEL not configured");
    const configured = this.config.openai.apiKeyPresent && Boolean(this.config.openai.model);
    return { providerId: "openai", configured, enabled: reasons.length === 0, reasons: reasons.length ? reasons : ["ready (no call has been made)"] };
  }

  /** Loads the SDK once and applies GSO's privacy defaults BEFORE any run. */
  private async loadSdk(): Promise<SdkModule> {
    if (!this.sdk) {
      this.sdk = import("@openai/agents").then((mod) => {
        // Privacy defaults (Phase 18): no trace export, no sensitive logging, unless explicitly enabled.
        mod.setTracingDisabled(!this.config.openai.tracingEnabled);
        mod.setSensitiveDataLoggingEnabled?.(false);
        const key = this.env.OPENAI_API_KEY;
        if (key) mod.setDefaultOpenAIKey(key); // the key never leaves this closure
        return mod;
      });
    }
    return this.sdk;
  }

  private sdkTool(sdk: SdkModule, def: ToolDefinition, input: RunAgentInput, calls: ToolCallRecord[]) {
    return sdk.tool({
      name: def.name,
      description: def.description,
      parameters: def.parameters as any,
      strict: true,
      needsApproval: def.needsApproval,
      execute: async (args: unknown) => {
        const result = await input.executeTool({ toolName: def.name, args: (args ?? {}) as Record<string, unknown>, agentId: input.agentId, specialistKey: input.specialistKey, requestId: input.context.requestId, provider: "openai", model: this.config.openai.model });
        calls.push({ toolName: def.name, ok: result.ok, code: result.ok ? undefined : result.code, intentId: result.ok && result.kind === "proposal" ? result.intentId : undefined, at: new Date().toISOString() });
        return JSON.stringify(result);
      },
    } as any);
  }

  private buildAgent(sdk: SdkModule, input: RunAgentInput, calls: ToolCallRecord[]) {
    const spec = SPECIALISTS[input.specialistKey as keyof typeof SPECIALISTS];
    const schema = SCHEMAS[input.outputSchema as keyof typeof SCHEMAS];
    const tools = input.allowedTools.map((name) => definitionFor(name)).filter((d): d is ToolDefinition => Boolean(d)).map((d) => this.sdkTool(sdk, d, input, calls));
    return new sdk.Agent({
      name: `gso_${input.specialistKey}`,
      instructions: spec?.instructions ?? "Return only the requested structured output.",
      model: this.config.openai.model ?? undefined,
      tools,
      outputType: { type: "json_schema", name: schema.name, strict: true, schema: schema.jsonSchema } as any,
      modelSettings: { toolChoice: "auto" },
    } as any);
  }

  async runAgent(input: RunAgentInput): Promise<RunAgentResult> {
    const health = this.health();
    if (!health.enabled) return { status: "disabled", reason: health.reasons.join("; ") };
    const calls: ToolCallRecord[] = [];
    let sdk: SdkModule;
    try { sdk = await this.loadSdk(); } catch (error: any) { return { status: "failed", kind: "provider_error", error: `SDK load failed: ${String(error?.message || error)}`, toolCalls: calls, turns: 0, model: this.config.openai.model }; }

    const agent = this.buildAgent(sdk, input, calls);
    const runner = new sdk.Runner({ tracingDisabled: !this.config.openai.tracingEnabled, traceIncludeSensitiveData: this.config.openai.traceIncludeSensitiveData, workflowName: `gso:${input.specialistKey}` } as any);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.limits.timeoutMs);
    try {
      let runInput: any;
      if (input.resumeState) {
        const state: any = await sdk.RunState.fromString(agent as any, input.resumeState);
        for (const interruption of state.getInterruptions?.() ?? []) {
          if (input.resumeDecision === "approved") state.approve(interruption); else state.reject(interruption);
        }
        runInput = state;
      } else {
        const lines = [`Request id: ${input.context.requestId}`, `Requester: ${input.context.requester.type}:${input.context.requester.id}`, `Facts: ${JSON.stringify(input.context.facts)}`];
        if (input.context.untrustedText) lines.push(input.context.untrustedText);
        runInput = lines.join("\n");
      }
      const result: any = await runner.run(agent as any, runInput, { maxTurns: input.limits.maxTurns, signal: controller.signal } as any);
      const turns = Number(result?.state?._currentTurn ?? result?.rawResponses?.length ?? 1);
      if (Array.isArray(result.interruptions) && result.interruptions.length) {
        const intentId = calls.filter((c) => c.intentId).map((c) => c.intentId!).at(-1) ?? null;
        if (!intentId) return { status: "failed", kind: "unauthorized_tool", error: "approval interruption without a GSO intent", toolCalls: calls, turns, model: this.config.openai.model };
        return { status: "paused_for_approval", intentId, state: result.state.toString(), toolCalls: calls, turns, model: this.config.openai.model };
      }
      return { status: "completed", output: result.finalOutput, toolCalls: calls, turns, model: this.config.openai.model };
    } catch (error: any) {
      const name = String(error?.name || "");
      const message = String(error?.message || error).slice(0, 300);
      const kind: "timeout" | "max_turns" | "provider_error" | "guardrail" = controller.signal.aborted ? "timeout" : /MaxTurnsExceeded/.test(name) ? "max_turns" : /Guardrail/.test(name) ? "guardrail" : "provider_error";
      return { status: "failed", kind, error: message, toolCalls: calls, turns: 0, model: this.config.openai.model };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Factory honouring the kill switches: returns the Disabled provider unless OpenAI is fully configured. */
export async function createConfiguredProvider(config: OpsRuntimeConfig, env: Env = process.env as Env): Promise<ReasoningProvider> {
  const { DisabledReasoningProvider } = await import("./disabled-provider");
  if (config.reasoningBlockers.length) return new DisabledReasoningProvider(config.reasoningBlockers);
  if (config.provider === "openai") return new OpenAIReasoningProvider(config, env);
  return new DisabledReasoningProvider([`provider ${config.provider} not implemented`]);
}

/** OpenAI-specific assumptions a future AnthropicReasoningProvider must adapt (Phase 46). */
export const OPENAI_RUNTIME_ASSUMPTIONS = [
  "tool parameters are strict JSON Schema objects (gateway definitions are already provider-neutral JSON Schema)",
  "structured output via json_schema outputType; GSO re-validates with schemas.ts regardless of provider",
  "approval interruptions pause the run and are resumed from serialized RunState; GSO maps them to ActionIntents",
  "tracing/sensitive-data flags are SDK globals + Runner config; disabled by default here",
  "the API key is injected via setDefaultOpenAIKey inside this module only",
];
