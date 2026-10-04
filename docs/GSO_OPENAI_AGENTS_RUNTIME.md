# GSO OpenAI Agents Runtime

**Package:** `@openai/agents` 0.18.0 (installed 2026-10-04; peer `zod ^4` → `zod` 4.6.5 added) · **Status:** code prepared, RUNTIME-DISABLED · **Live calls in this pass:** NONE · **API key required to build/test:** NO

## Dependency compatibility findings (Phase 3 / 49)

- Before install the repo had **no** `zod` anywhere (`npm ls zod` empty; no imports in app, tests or extensions). Adding `zod@4` therefore conflicts with nothing and no Zod upgrade of existing code was needed.
- `@openai/agents@0.18.0` pulls `@openai/agents-core`, `@openai/agents-openai`, `@openai/agents-realtime`, `openai@7.27.0`, `debug`, `@modelcontextprotocol/*`. All resolved cleanly; `package-lock.json` +268 lines.
- Bundle: the SDK is loaded with a dynamic `import("@openai/agents")` inside `app/lib/reasoning/openai-provider.server.ts` only. The React Router SSR build externalizes it (one `import("@openai/agents")` in `build/server/index.js`); nothing OpenAI-related appears in `build/client/`. The API key is read from `process.env` inside that server module and injected with `setDefaultOpenAIKey`; it never reaches a loader payload, the client bundle, logs, Slack, docs, tests or the database.
- Existing suites unaffected: 2220 tests pass, build green, typecheck at the 305 baseline.

## Runtime configuration (names only)

| Variable | Secret | Required to enable | Default / safe state |
|---|---|---|---|
| `GSO_REASONING_PROVIDER` | no | `openai` | `none` → DisabledReasoningProvider |
| `GSO_AGENT_REASONING_ENABLED` | no | `true` | `false` → deterministic agents only |
| `OPENAI_API_KEY` | **yes** | present | absent → provider reports `OPENAI_API_KEY absent`, fails closed |
| `GSO_OPENAI_MODEL` | no | a model id (configuration, never hardcoded) | unset → fails closed |
| `GSO_OPENAI_TRACING_ENABLED` | no | optional | `false` → `setTracingDisabled(true)` + Runner `tracingDisabled` |
| `GSO_OPENAI_TRACE_SENSITIVE` | no | optional | `false` → `traceIncludeSensitiveData=false` |
| `GSO_AGENT_EXECUTION_ENABLED` | no | separate kill switch | `false` → no consequential execution |
| `GSO_AGENT_MAX_TURNS / TIMEOUT_MS / MAX_TOOL_CALLS / MAX_RETRIES / MAX_CONCURRENCY` | no | optional | 8 / 45000 / 12 / 1 / 2, further capped per specialist |

`readOpsRuntimeConfig` (app/lib/ops/runtime-config.ts) computes `reasoningBlockers`; reasoning runs only when the list is empty. `describeOpsRuntime` exposes YES/NO status only — never the key, a suffix, or its length.

## SDK primitives used

- `Agent` per specialist with `instructions` (GSO policy + role), `tools` from the gateway, `outputType: { type: "json_schema", strict: true }` from `schemas.ts`, `model` from config.
- `tool()` with strict JSON Schema `parameters` (the gateway's provider-neutral definitions) and `needsApproval` for proposal tools; `execute` calls the gateway and returns its JSON result — the SDK never executes business logic itself.
- `Runner.run(agent, input, { maxTurns, signal })` with an AbortController timeout; `tracingDisabled` and `traceIncludeSensitiveData` from config.
- Interruptions (`result.interruptions`) → `paused_for_approval` with `result.state.toString()`; resume via `RunState.fromString` then `approve`/`reject` driven by the ActionIntent decision.
- `setSensitiveDataLoggingEnabled(false)` on load.
- NOT used: shell/apply_patch/computer tools, hosted web search, MCP servers, realtime, free-form multi-agent chat.

## Handoffs

Typed, one hop at a time, only supervisor → {cannabis_packaging_sales, commercial_print_sales, marketing_agent}, max 2 hops per request (`canHandoff`). Illegal handoffs fall back deterministically. Each specialist: narrow purpose, allow-listed tools, forbidden tools, output schema, maxTurns ≤ 8, timeout ≤ 45 s, maxToolCalls ≤ 12, fallback, escalation.

## Cost and loop controls

maxTurns, timeout (abort), tool-call cap, bounded handoffs, retries configurable (default 1, worker backoff bounded), concurrency cap, no automatic retry storm, no hidden live usage (provider off by default; live test opt-in only).

## Tracing and privacy policy (Phase 18/45)

The SDK enables tracing by default in Node. GSO disables it by default and never includes sensitive data unless the owner sets both flags. Recommendation: tracing OFF, sensitive trace content OFF, sensitive logging OFF until the owner approves an observability/data policy. If enabled later, prefer metadata (agent id, action type, duration, tool name, success/failure) over raw customer content. Audit rows never store chain-of-thought.

## Tests

- `tests/reasoning-runtime.test.ts` — gateway, schemas, specialists, fake provider scenarios, supervisor fallback, OpenAI provider disabled without credentials (no SDK load, no network).
- `tests/ops-company-flow.test.ts` — full offline flow with FakeReasoningProvider.
- `tests/openai-live-optin.test.ts` — SKIPPED unless `GSO_OPENAI_LIVE_TEST=1` and fully configured. Not run in this pass.

## Enablement sequence (owner)

1. Activate the OPS-2 migration (move it from `prisma/migrations-pending/` to `prisma/migrations/`, deploy, Render Pre-Deploy applies it); then set `GSO_OPS_REPOSITORY=prisma` (durable intents/runs).
2. Add `OPENAI_API_KEY` (secret) and `GSO_OPENAI_MODEL` on Render.
3. Set `GSO_REASONING_PROVIDER=openai`, keep `GSO_AGENT_REASONING_ENABLED=false`; verify hub shows Configured YES / Reasoning NO.
4. Run the opt-in live test from a trusted machine once; review output.
5. Set `GSO_AGENT_REASONING_ENABLED=true` with `GSO_AGENT_EXECUTION_ENABLED=false` (reasoning proposes, nothing executes).
6. Only after staff review of proposals: consider `GSO_AGENT_EXECUTION_ENABLED=true`, one action at a time.
Rollback at any step: unset `GSO_AGENT_REASONING_ENABLED` → deterministic operation continues unchanged.
