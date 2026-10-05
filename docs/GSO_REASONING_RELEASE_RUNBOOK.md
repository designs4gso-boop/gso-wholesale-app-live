# GSO Reasoning Release Runbook (Stage 6 — PREPARED, NOT EXECUTED)

**Status:** reasoning OFF in production; no OpenAI key configured; no live model call has ever been made from this codebase.

## Readiness audit (2026-10-05, offline)

| Requirement | Evidence |
|---|---|
| No API key required when reasoning is disabled | `readOpsRuntimeConfig` reports `apiKeyPresent` only; `DisabledReasoningProvider` is the default; tests `tests/ops-durable-operations.test.ts`, `tests/reasoning-runtime.test.ts` |
| No provider call when reasoning is disabled | `runOperationsSupervisor` returns the deterministic fallback before touching the provider; `tests/ops-adversarial.test.ts` asserts `fake.runs.length === 0` |
| Tool gateway restrictive | 16 tools, all read or proposal; `FORBIDDEN_TOOL_PATTERNS` test; strict argument validation (unknown arguments such as `unitCost`/`price` are refused) |
| No shell/filesystem/Prisma/SQL/Shopify/Slack-send tools | none registered; `tests/reasoning-runtime.test.ts` |
| Models cannot move production jobs | proposals create APPROVAL_REQUIRED intents; execution only via the owner's executor action; `tests/ops-adversarial.test.ts` bypass cases |
| Models cannot send arbitrary Slack or customer messages | no such tool; `send_customer_notification` DISABLED; `post_slack_external` DISABLED |
| Structured output enforced | `schemas.ts` validators fail closed; drafts containing price/discount/guarantee language are rejected even when the model's own flags say otherwise |
| Tracing OFF, sensitive tracing OFF, sensitive logging OFF | defaults in `runtime-config.ts`; set on SDK load in `openai-provider.server.ts` |
| Provider errors fail closed | timeout / provider_error / max_turns / malformed / unauthorized handoff → deterministic fallback, no intents created |
| Prompt injection | `asUntrustedData` envelope + `scanUntrustedText`; injected tool arguments refused |

## Stage 6 plan (owner executes, step by step)

1. **Configure, keep OFF.** On Render set `OPENAI_API_KEY` (secret, dedicated project with a spend cap) and `GSO_OPENAI_MODEL`; set `GSO_REASONING_PROVIDER=openai`; leave `GSO_AGENT_REASONING_ENABLED=false` and `GSO_AGENT_EXECUTION_ENABLED=false`. Hub must show Provider OPENAI, Configured YES, Reasoning OFF.
2. **Provider diagnostic.** Open the hub; confirm `reasoningBlockers` lists only the reasoning switch. No call is made.
3. **One explicit reasoning test.** From a trusted machine run the opt-in test once: `GSO_OPENAI_LIVE_TEST=1 npx vitest run tests/openai-live-optin.test.ts` with the same env. Review output (one bounded supervisor turn, read-only tool, structured output). Record cost.
4. **Observation mode.** Set `GSO_AGENT_REASONING_ENABLED=true` with execution OFF. Any proposal becomes an AWAITING_APPROVAL intent visible on the hub and in the sandbox; nothing executes. Observe for an owner-defined period.
5. **Owner review.** Review intents, audit rows, tool-call records, and provider errors. Decide whether to keep reasoning on.
6. Execution for model proposals remains the same human path as Stage 4 (owner button + executor). No AUTO production writes.

## Rollback

Unset `GSO_AGENT_REASONING_ENABLED` (or set false) → deterministic operation continues unchanged. Remove the key to make the provider unconfigured.
