// GSO Reasoning Provider boundary (OPS-2). Client-safe types only.
//
// A ReasoningProvider runs ONE bounded agent turn-loop against a model and
// returns a STRUCTURED result. It never executes business side effects: every
// tool call is routed through the GSO Tool Gateway (tool-gateway.ts), which
// performs validation, permission checks and ActionIntent creation. The
// provider does not know about Prisma, Slack, canonical costing or approvals.
//
// Implementations: DisabledReasoningProvider (default), FakeReasoningProvider
// (tests/simulation), OpenAIReasoningProvider (server-only, runtime-disabled
// until configured). AnthropicReasoningProvider is a documented future
// implementation of this same contract.

import type { ReasoningProviderId } from "../ops/runtime-config";
import type { ToolCallRecord, ToolRequest, ToolResult } from "./tool-gateway";

export const REASONING_PROVIDER_CONTRACT_VERSION = "reasoning-provider/1.0.0-2026-10-04";

export type ProviderCapabilities = {
  tools: boolean;
  handoffs: boolean;
  structuredOutput: boolean;
  humanApproval: boolean;
  tracing: boolean;
  resumableRuns: boolean;
};

export type ProviderHealth = { providerId: ReasoningProviderId; configured: boolean; enabled: boolean; reasons: string[] };

export type RunLimits = { maxTurns: number; timeoutMs: number; maxToolCalls: number };

/** Minimum context handed to a model (Phase 13). Never raw rows, never secrets. */
export type ReasoningContext = {
  requestId: string;
  requester: { type: "staff" | "owner" | "system"; id: string; name?: string };
  /** Free text from staff/customer is wrapped as UNTRUSTED data by the gateway before use. */
  untrustedText: string | null;
  facts: Record<string, string | number | boolean | null>;
};

export type ToolExecutor = (request: ToolRequest) => Promise<ToolResult>;

export type RunAgentInput = {
  agentId: string;
  specialistKey: string;
  /** Names of gateway tools this run may call (already filtered by the specialist's allow-list). */
  allowedTools: string[];
  outputSchema: string;
  context: ReasoningContext;
  limits: RunLimits;
  executeTool: ToolExecutor;
  /** Serialized state to resume a paused run (provider-specific; no secrets). */
  resumeState?: string | null;
  resumeDecision?: "approved" | "rejected" | null;
};

export type RunAgentResult =
  | { status: "completed"; output: unknown; toolCalls: ToolCallRecord[]; turns: number; model: string | null }
  | { status: "paused_for_approval"; intentId: string; state: string; toolCalls: ToolCallRecord[]; turns: number; model: string | null }
  | { status: "handoff"; toSpecialistKey: string; reason: string; toolCalls: ToolCallRecord[]; turns: number; model: string | null }
  | { status: "disabled"; reason: string }
  | { status: "failed"; error: string; kind: "timeout" | "max_turns" | "provider_error" | "malformed_output" | "guardrail" | "unauthorized_tool"; toolCalls: ToolCallRecord[]; turns: number; model: string | null };

export interface ReasoningProvider {
  readonly providerId: ReasoningProviderId;
  readonly capabilities: ProviderCapabilities;
  health(): ProviderHealth;
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
}
