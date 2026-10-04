// GSO Operations Agent Platform — runtime configuration (OPS-2).
//
// Two INDEPENDENT kill switches plus provider selection. Every default is the
// SAFE value: no reasoning provider, reasoning disabled, consequential
// execution disabled, tracing disabled. Secrets are reported as present /
// absent only; their values never leave this module.
//
//   GSO_AGENT_EXECUTION_ENABLED   consequential execution (job moves, sends, money) — default false
//   GSO_AGENT_REASONING_ENABLED   LLM reasoning layer — default false (deterministic agents keep working)
//   GSO_REASONING_PROVIDER        none | openai | (future) anthropic — default none
//   OPENAI_API_KEY                secret; presence only is ever reported
//   GSO_OPENAI_MODEL              model id; configuration, never hardcoded policy
//   GSO_OPENAI_TRACING_ENABLED    trace export — default false
//   GSO_OPENAI_TRACE_SENSITIVE    include prompt/tool content in traces — default false
//   GSO_OPS_REPOSITORY            memory | prisma — default memory until the OPS-2 migration is applied
//   GSO_AGENT_MAX_TURNS / GSO_AGENT_TIMEOUT_MS / GSO_AGENT_MAX_TOOL_CALLS / GSO_AGENT_MAX_RETRIES / GSO_AGENT_MAX_CONCURRENCY

export const OPS_RUNTIME_CONFIG_VERSION = "ops-runtime-config/2.0.0-2026-10-04";

export type ReasoningProviderId = "none" | "openai" | "anthropic";

export type OpsRuntimeConfig = {
  executionEnabled: boolean;
  reasoningEnabled: boolean;
  provider: ReasoningProviderId;
  repository: "memory" | "prisma";
  openai: {
    apiKeyPresent: boolean;
    model: string | null;
    tracingEnabled: boolean;
    traceIncludeSensitiveData: boolean;
  };
  limits: {
    maxTurns: number;
    timeoutMs: number;
    maxToolCalls: number;
    maxRetries: number;
    maxConcurrency: number;
  };
  /** Why reasoning cannot run right now (empty when it can). */
  reasoningBlockers: string[];
};

type Env = Record<string, string | undefined>;

const flag = (v: string | undefined, fallback = false): boolean => {
  if (v == null || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};
const int = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

export function readOpsRuntimeConfig(env: Env = typeof process !== "undefined" ? (process.env as Env) : {}): OpsRuntimeConfig {
  const providerRaw = String(env.GSO_REASONING_PROVIDER ?? "none").trim().toLowerCase();
  const provider: ReasoningProviderId = providerRaw === "openai" ? "openai" : providerRaw === "anthropic" ? "anthropic" : "none";
  const reasoningEnabled = flag(env.GSO_AGENT_REASONING_ENABLED, false);
  const openai = {
    apiKeyPresent: Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()),
    model: env.GSO_OPENAI_MODEL?.trim() || null,
    tracingEnabled: flag(env.GSO_OPENAI_TRACING_ENABLED, false),
    traceIncludeSensitiveData: flag(env.GSO_OPENAI_TRACE_SENSITIVE, false),
  };
  const blockers: string[] = [];
  if (!reasoningEnabled) blockers.push("GSO_AGENT_REASONING_ENABLED is not true");
  if (provider === "none") blockers.push("GSO_REASONING_PROVIDER is none");
  if (provider === "openai") {
    if (!openai.apiKeyPresent) blockers.push("OPENAI_API_KEY absent");
    if (!openai.model) blockers.push("GSO_OPENAI_MODEL not configured");
  }
  if (provider === "anthropic") blockers.push("anthropic provider is not implemented in this release");
  return {
    executionEnabled: flag(env.GSO_AGENT_EXECUTION_ENABLED, false),
    reasoningEnabled,
    provider,
    repository: String(env.GSO_OPS_REPOSITORY ?? "memory").trim().toLowerCase() === "prisma" ? "prisma" : "memory",
    openai,
    limits: {
      maxTurns: int(env.GSO_AGENT_MAX_TURNS, 8, 1, 50),
      timeoutMs: int(env.GSO_AGENT_TIMEOUT_MS, 45_000, 1_000, 600_000),
      maxToolCalls: int(env.GSO_AGENT_MAX_TOOL_CALLS, 12, 1, 100),
      maxRetries: int(env.GSO_AGENT_MAX_RETRIES, 1, 0, 5),
      maxConcurrency: int(env.GSO_AGENT_MAX_CONCURRENCY, 2, 1, 16),
    },
    reasoningBlockers: blockers,
  };
}

/** True only when the reasoning layer may call a model. */
export function reasoningAvailable(config: OpsRuntimeConfig): boolean {
  return config.reasoningBlockers.length === 0;
}

/** Safe, display-only view (no secrets, no key suffixes, no lengths). */
export function describeOpsRuntime(config: OpsRuntimeConfig) {
  return {
    provider: config.provider.toUpperCase(),
    providerConfigured: config.provider === "openai" ? (config.openai.apiKeyPresent && Boolean(config.openai.model) ? "YES" : "NO") : "N/A",
    reasoningEnabled: config.reasoningEnabled ? "YES" : "NO",
    reasoningAvailable: reasoningAvailable(config) ? "YES" : "NO",
    executionEnabled: config.executionEnabled ? "YES" : "NO",
    tracingEnabled: config.openai.tracingEnabled ? "YES" : "NO",
    sensitiveTracing: config.openai.traceIncludeSensitiveData ? "YES" : "NO",
    repository: config.repository,
    model: config.openai.model ?? "unset",
    blockers: config.reasoningBlockers,
  };
}
