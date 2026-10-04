// DisabledReasoningProvider — the DEFAULT. Every run returns `disabled` so the
// deterministic layer falls back; nothing is called, nothing is billed.

import type { ReasoningProvider, ProviderHealth, RunAgentInput, RunAgentResult } from "./provider";

export class DisabledReasoningProvider implements ReasoningProvider {
  readonly providerId = "none" as const;
  readonly capabilities = { tools: false, handoffs: false, structuredOutput: false, humanApproval: false, tracing: false, resumableRuns: false };
  constructor(private readonly reasons: string[] = ["reasoning provider is none"]) {}
  health(): ProviderHealth { return { providerId: "none", configured: false, enabled: false, reasons: this.reasons }; }
  async runAgent(_input: RunAgentInput): Promise<RunAgentResult> { return { status: "disabled", reason: this.reasons.join("; ") }; }
}
