# GSO Ops Runtime Execution Audit

**Date:** 2026-10-04/05 (overnight, unattended) · **Audited commit:** `cd94033` (production main after Stage 4) plus branch `ops5-overnight-autonomy-2026-10-04` · **Method:** repository inspection only; no production access.

## 1. Runtime path summary

| Component | Where | Authority it holds |
|---|---|---|
| ActionIntent lifecycle | `app/lib/ops/action-intents.ts` | PROPOSED → VALIDATED → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED/FAILED/CANCELLED; approvals only by `staff`/`owner` actors with sufficient role; execution gated by `GSO_AGENT_EXECUTION_ENABLED` for consequential actions |
| Audit events | `OpsActionAuditEvent` via `appendAudit` | append-only, one row per transition |
| External event receipts | `OpsExternalEventReceipt` | one receipt per Slack event/click; replays are no-ops |
| Slack approvals | `api/slack/interactions` → `handleSlackInteraction` → `decideIntent` | decisions only; never executes |
| Outbox | `OpsOutboxMessage` | PENDING/PROCESSING/COMPLETED/FAILED/DEAD |
| Worker | `outbox-worker.ts`, `worker-runtime.server.ts`, `api/ops/worker/run` | executes only non-consequential, intent-approved or unbound internal work; **not scheduled** |
| Reasoning provider | `app/lib/reasoning/*` | Disabled by default; Fake for tests; OpenAI prepared, requires four settings |
| Tool gateway | `tool-gateway.ts` | 10 read + 6 proposal tools; the only model surface |
| Production transition executor | `production-transition-executor.ts` (+ `.server.ts` deps) | the only agent write path into `ProductionJob` |
| Ops Hub | `app/erp/ops-hub` | read-only dashboard + owner-only release-test controls (Stage 3/4) |
| Agent registry / matrix | `agent-registry.ts`, `autonomy.ts` | per-agent autonomy capped by platform ceilings |

## 2. Every runtime caller of a consequential capability

| Capability | Callers in `app/` | Reachable in production? |
|---|---|---|
| `executeIntent()` | `outbox-worker.ts` (worker loop), `production-transition-executor.ts` (inside the executor), `simulator.server.ts` (memory repos, mocked ERP) | worker: only via the authenticated trigger, and never for consequential actions; executor: only via the Stage 4 owner button; simulator: never writes |
| `requestProductionTransition()` | `stage4-test-transition.ts` (owner button, locked ticket), `simulator.server.ts` (mocks) | yes, owner click only, requires execution switch ON |
| Outbox processing (`processOutboxBatch`) | `worker-runtime.server.ts` → `api/ops/worker/run`, `simulator.server.ts` | trigger requires `GSO_OPS_WORKER_TOKEN` (unset) and a caller; nothing in the repo calls it |
| `ProductionJob` mutation | legacy staff route `app.erp.production.tsx` (status, dates, files, usage, finalize, reprint), proof routes, quote→job creation, calendar, `production-transition-executor.server.ts` (`applyTransition`) | staff UI paths are human-only; the executor path is owner-click-only |
| Customer communication | none in `app/lib/ops` or `app/lib/reasoning`; `send_customer_notification` is DISABLED at the ceiling | no |
| PO / invoice actions | none; `send_purchase_order` and `send_invoice` DISABLED; QuickBooks not connected | no |

## 3. Does anything execute automatically if `GSO_AGENT_EXECUTION_ENABLED=true`?

**No.** There is no scheduler, cron, interval or background service in the repository (`grep setInterval|cron|schedule\(` in `app/` returns nothing). The Slack endpoint records decisions only. The worker runs only when an authenticated caller POSTs to `api/ops/worker/run`, and even then `WORKER_FORBIDDEN_ACTIONS` dead-letters every consequential intent (job moves, QC, shipping, final art approval, customer messages, POs, invoices, refunds, cost/price changes, dispatch). The only consequential execution path is the owner's explicit Stage 4 button, which is locked to one ticket and one transition.

## 4. Does anything reason automatically if `GSO_AGENT_REASONING_ENABLED=true`?

**No.** `runOperationsSupervisor` is called only by the simulator (fake provider) and by no route. The OpenAI provider additionally requires `GSO_REASONING_PROVIDER=openai`, `OPENAI_API_KEY` and `GSO_OPENAI_MODEL`; absent any of them it reports disabled and loads no SDK. Tracing export and sensitive-data logging default off.

## 5. Findings and decisions this session

1. **Worker safety ceiling added** (Phase 3). Before: an APPROVED consequential intent bound to an outbox message would have executed through `executeIntent` when the execution switch was on. Now: `workerMayExecute()` denies every consequential action; such messages go DEAD for manual review and are never retried. Tests: `tests/ops-worker-runtime.test.ts`, `tests/ops-durable-operations.test.ts`.
2. **Worker trigger added, not scheduled** (Phase 2). `POST /api/ops/worker/run` with `Authorization: Bearer <GSO_OPS_WORKER_TOKEN>` (≥ 32 chars, timing-safe; 503 when unset, 401 otherwise). Ignores request bodies and query strings; one batch per process (409 when busy); returns counts only. `GET` returns sanitized diagnostics. `GSO_OPS_WORKER_TOKEN` is **not set anywhere**.
3. **Legacy manual status path hardened** (Phase 5). `changeStatus` now accepts only the staff vocabulary in `app/lib/production-status-vocabulary.ts` and rejects anything else with 400. It still emits only `status_change`, which the agent fact loader never treats as art-approval, QC or shipping evidence.
4. **Vocabulary gap documented, not invented around.** Staff statuses `prepress`, `proof_needed`, `ready_to_print`, `laminating`, `packing`, `ready_for_pickup` are not modelled by the agent transition guard; agents treat them as unknown and fail closed. Adding transitions for them is an owner decision.
5. **Executor fact loader** (Stage 4 audit, already live): art approval counts only when at least as recent as the latest proof/artwork revision marker and not after a changes-request; `status_change` never counts.
6. **Material readiness and routing readiness** remain unmodelled (`undefined`) in the Prisma fact loader; the guard blocks only on an explicit `false`. Documented on the hub.
7. **Simulator on hub load** runs with memory repositories and mocked dependencies; it cannot write.

## 6. Residual risks

- A compromised admin session could still use the staff `changeStatus` form within the vocabulary; that is the pre-existing human path and is out of scope for agent controls.
- Prisma-mode durability depends on the applied OPS-2 migration (applied 2026-10-04).
- Memory-mode Slack posting idempotency is per process; Prisma mode makes receipts durable.
