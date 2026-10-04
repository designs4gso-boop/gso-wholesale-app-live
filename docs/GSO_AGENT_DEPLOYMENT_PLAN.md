# GSO Agent Platform Deployment Plan

**Current state (2026-10-03):** all code on local branch `agents-operations-finishline-2026-10-03`. Production `main` = `dba23c6` (CORE costing release) is untouched. Nothing here is deployed.

## Impact if this branch were merged as-is

- Two new routes: `api/slack/interactions` (returns **503 slack_not_configured** until `SLACK_SIGNING_SECRET` exists on Render) and `app/erp/ops-hub` (admin-authenticated, read-only, runs the in-memory simulation per load).
- No schema change, no migration, no new dependency, no env var required.
- No change to any existing route, lib or test. Typecheck stays at the 305 Polaris-debt baseline.
- Slack posting from Render cannot happen: no token is configured there and `SLACK_SANDBOX_ONLY` defaults to true.

## Phased rollout (each step needs owner approval)

| Phase | What | Requires |
|---|---|---|
| 0 | Owner reviews branch, docs, simulation, sandbox evidence | this packet |
| 1 | Merge to `main`, deploy (routes inert) | `npm run build` green; owner push |
| 2 | **Durable store**: Prisma models `OpsActionIntent`, `OpsActionAudit`, `SlackEventReceipt`; replace `InMemoryActionIntentStore` behind the same interface | migration (owner runs `prisma migrate deploy`) |
| 3 | Add `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TEST_CHANNEL`, `SLACK_STAFF_MAP` on Render; keep `SLACK_SANDBOX_ONLY=true`; set Interactivity Request URL to `https://<render-host>/api/slack/interactions` | owner edits Render env + Slack app config |
| 4 | Sandbox verification from production host (same scenario set as `tests/slack-sandbox-live.test.ts`) | staff map with at least owner + one staff |
| 5 | Background worker (Render background worker or cron) for outbox draining and/or Socket Mode (`SLACK_APP_TOKEN`) | **new infrastructure → owner approval** |
| 6 | Map real destinations (`SLACK_CHANNEL_*`), flip `SLACK_SANDBOX_ONLY=false` | owner |
| 7 | Raise ceilings one action at a time (e.g. `mark_shipped` APPROVAL → real ERP write via intent executor) | owner, per action |
| 8 | LLM provider decision for the DRAFT sales/marketing agents | owner; separate security review |

QuickBooks remains **DEFERRED — NOT CONNECTED** throughout; it is not in this plan.

## Environment variables (names only)

`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (Socket Mode only), `SLACK_SIGNING_SECRET`, `SLACK_TEST_CHANNEL`, `SLACK_SANDBOX_ONLY` (default true), `SLACK_SOCKET_MODE`, `SLACK_STAFF_MAP` (JSON `{ "U…": { "staffId", "name", "role": "owner|staff" } }`), `SLACK_CHANNEL_SALES_LEADS`, `SLACK_CHANNEL_SALES_QUOTES`, `SLACK_CHANNEL_ART_APPROVAL`, `SLACK_CHANNEL_PRODUCTION`, `SLACK_CHANNEL_PRODUCTION_EXCEPTIONS`, `SLACK_CHANNEL_PURCHASING`, `SLACK_CHANNEL_SHIPPING`, `SLACK_CHANNEL_FINANCE`, `SLACK_CHANNEL_AGENT_APPROVALS`, `SLACK_CHANNEL_MANAGEMENT_REPORTS`, `GSO_SLACK_ENV_FILE` (local only; default `C:/Users/Desig/.gso-secrets/slack.env`).

## Rollback

Revert the merge commit(s); no data to migrate back until Phase 2. After Phase 2, the new tables are additive and can stay.

## Verification gates before every phase

`npx vitest run` green · `npm run build` green · `npm run typecheck` at baseline · `git diff --check` clean · simulation (`tests/ops-company-flow.test.ts`) all assertions passing.

## OPS-2 update (2026-10-04) — supersedes the Phase 2/5/7 details above

Durable store, outbox, worker, executor and the reasoning runtime are implemented on branch `agents-operations-productionize-2026-10-04`. The authoritative sequence is in `docs/GSO_OPERATIONS_PRODUCTION_READINESS.md`; OpenAI enablement is in `docs/GSO_OPENAI_AGENTS_RUNTIME.md`.

Additional environment variables (names only): `GSO_OPS_REPOSITORY` (memory|prisma), `GSO_AGENT_EXECUTION_ENABLED` (default false), `GSO_AGENT_REASONING_ENABLED` (default false), `GSO_REASONING_PROVIDER` (none|openai), `OPENAI_API_KEY` (secret), `GSO_OPENAI_MODEL`, `GSO_OPENAI_TRACING_ENABLED` (default false), `GSO_OPENAI_TRACE_SENSITIVE` (default false), `GSO_AGENT_MAX_TURNS`, `GSO_AGENT_TIMEOUT_MS`, `GSO_AGENT_MAX_TOOL_CALLS`, `GSO_AGENT_MAX_RETRIES`, `GSO_AGENT_MAX_CONCURRENCY`.

Merge impact as-is: new dependency `@openai/agents` (plus `zod` 4) installed server-side only and never imported unless the provider is enabled; six new Prisma models (migration STAGED in `prisma/migrations-pending/` so the next deploy does not auto-apply it; the owner activates it later, before setting `GSO_OPS_REPOSITORY=prisma`); no existing route or test changed behaviour; typecheck at baseline.
