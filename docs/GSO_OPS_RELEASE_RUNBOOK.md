# GSO Ops Release Runbook

**Updated:** 2026-10-05 (overnight build) · **Production main at start of session:** `cd94033dbca6d74efaa50b38ce1843727869ea22`

## Where production stands

| Item | State |
|---|---|
| OPS-2 migration | APPLIED |
| `GSO_OPS_REPOSITORY` | `prisma` (durable intents, audit, receipts, outbox, runs) |
| `GSO_AGENT_REASONING_ENABLED` | `false` (default OFF) |
| `GSO_AGENT_EXECUTION_ENABLED` | `false` (default OFF; was true briefly for the Stage 4 test, then reset) |
| Slack | HTTPS Interactivity at `/api/slack/interactions`; `SLACK_SANDBOX_ONLY=true`; owner mapped in `SLACK_STAFF_MAP` |
| Stage 3 | PASSED live (durable approval via sandbox card) |
| Stage 4 | PASSED live: `GSO-20260510-0004` moved `proof_approved → printing` through intent → Slack approval → executor → audit; the ticket is now **printing** |
| Worker | code present (`api/ops/worker/run`), **not scheduled**, trigger token **not set** |
| OpenAI | runtime prepared, no key, reasoning OFF |
| QuickBooks | DEFERRED |

## Stage 5 — worker (owner-gated)

1. Merge the overnight branch after review; deploy. Nothing changes at runtime (trigger returns 503 without the token; worker never scheduled).
2. Generate a ≥ 32-character random token; set `GSO_OPS_WORKER_TOKEN` on Render. Do not store it anywhere else.
3. From a trusted machine: `GET /api/ops/worker/run` with the bearer token → sanitized diagnostics (`claimableNow`, `dead`, `retrying`, `authConfigured: true`, `scheduled: false`).
4. Seed one `ops.noop` outbox message through a future owner tool (none exists yet) or accept an empty first run; `POST /api/ops/worker/run` → counts. Repeat the POST → `claimed: 0`.
5. Only then decide on a scheduler (Render Cron Job hitting the POST every N minutes). Execution stays OFF; the worker can only process `ops.noop` and sandbox `slack.post` in v1 and dead-letters every consequential intent.

## Stage 6 — reasoning (see GSO_REASONING_RELEASE_RUNBOOK.md)

## Rollback

- App: redeploy previous commit. Tables are additive and unread by old code.
- Worker: unset `GSO_OPS_WORKER_TOKEN` (trigger returns 503) or disable the cron job.
- Reasoning: `GSO_AGENT_REASONING_ENABLED=false`.
- Execution: `GSO_AGENT_EXECUTION_ENABLED=false`; approved intents stay approved and audited, nothing moves.

## Operating rules to keep

- Production job movement: never from Slack, never from the worker; owner button → `requestProductionTransition()` only.
- Legacy staff status form: canonical vocabulary only; never an agent path.
- Sandbox-only Slack until real channel mapping is reviewed.
- No AUTO permission broadening without a new owner decision.
