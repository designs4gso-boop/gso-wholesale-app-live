// OPT-IN live OpenAI check. SKIPPED unless GSO_OPENAI_LIVE_TEST=1 AND the
// runtime is fully configured. NOT RUN in this pass; the normal suite never
// calls OpenAI and never requires OPENAI_API_KEY.

import { describe, expect, it } from "vitest";

import { readOpsRuntimeConfig, reasoningAvailable } from "../app/lib/ops/runtime-config";

const optIn = process.env.GSO_OPENAI_LIVE_TEST === "1";

describe.skipIf(!optIn)("openai live (opt-in)", () => {
  it("runs one bounded supervisor turn with a read-only tool and validates structured output", async () => {
    const config = readOpsRuntimeConfig(process.env as Record<string, string | undefined>);
    expect(reasoningAvailable(config), `not configured: ${config.reasoningBlockers.join("; ")}`).toBe(true);
    const { OpenAIReasoningProvider } = await import("../app/lib/reasoning/openai-provider.server");
    const { runOperationsSupervisor } = await import("../app/lib/reasoning/operations-supervisor");
    const { ToolGateway } = await import("../app/lib/reasoning/tool-gateway");
    const { SPECIALIST_TOOL_ALLOWLIST } = await import("../app/lib/reasoning/specialists");
    const { createFixtureGatewayServices } = await import("../app/lib/reasoning/gateway-services.server");
    const { createMemoryRepositories } = await import("../app/lib/ops/memory-repositories");
    const repos = createMemoryRepositories();
    const gateway = new ToolGateway({ intents: repos.intents, services: createFixtureGatewayServices({ leads: {}, jobs: {}, customers: {}, art: {}, canonicalBlockers: {} }) }, SPECIALIST_TOOL_ALLOWLIST);
    const out = await runOperationsSupervisor({ requestId: `live-${Date.now()}`, requester: { type: "owner", id: "owner" }, text: "What is the official MOQ for sticker bags?", facts: {} }, { provider: new OpenAIReasoningProvider(config), gateway, repos, config: { ...config, limits: { ...config.limits, maxTurns: 3 } } });
    expect(["completed", "fallback"]).toContain(out.status);
    expect((await repos.intents.list()).every((i) => i.status !== "COMPLETED")).toBe(true);
  }, 60_000);
});
