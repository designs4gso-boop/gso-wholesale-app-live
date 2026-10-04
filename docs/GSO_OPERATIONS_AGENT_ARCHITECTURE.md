# GSO Operations Agent Architecture

One operations agent platform with 21 roles, one intent engine, one Slack adapter. Built 2026-10-03 on branch `agents-operations-finishline-2026-10-03`. Not deployed.

## Module map

```
app/lib/ops/
  autonomy.ts                 levels, action types, platform ceilings, permission mapping
  agent-registry.ts           21 agent definitions + permissionMatrix()
  action-intents.ts           ActionIntent lifecycle, idempotency, approvals, execution, audit
  intent-store.server.ts      process singleton store (NON-DURABLE)
  untrusted-text.ts           injection scan, data envelope, log redaction
  sales-intake.ts             lead classify / dedupe / missing fields / escalations / safe reply
  quote-prep.server.ts        READY_FOR_STAFF_QUOTE | NEEDS_INFO | CANONICAL_BLOCKED | OUTSOURCED_REVIEW | UNSUPPORTED
  followup.ts                 stale lead/quote drafts (staff send)
  art-preflight.server.ts     PASS | WARN | FAIL | NEEDS_DESIGNER on supplied file facts
  art-approval.ts             version+hash-bound approvals; agent = technical only
  production-transitions.ts   pure guard over ACTUAL ProductionJob statuses
  production-planner.ts       read-only queue ordering + blockers
  production-dispatch.server.ts  plan via decideMachine (CMYK→Mimaki, white/gloss→Roland, contradiction→BLOCK)
  qa-checklist.server.ts      FAMILY_CHECKLISTS + recorded-result validation
  shipping.ts                 readiness; drafts; no labels, no sends
  purchasing.ts               PurchaseRequest-shaped drafts; never invents cost/freight
  invoice-readiness.ts        ERP-side readiness; QuickBooks DEFERRED
  reporting.ts                sales + production report lines
  production-status.ts        read-only status answers with named unknowns
  exceptions.ts               code → destination/severity/next action
  reorder-marketing.ts        reorder opportunities, marketing brief scaffold
  simulator.server.ts         full company-flow simulation with mocked executors
app/lib/slack/
  slack-config.ts             destinations, env var names, sandbox-only resolution, staff map
  slack-security.server.ts    v0 HMAC signature verify, replay window, dedupe
  slack-blocks.ts             Block Kit cards; fixed action ids; intent id in button value
  slack-client.server.ts      fetch Web API client; idempotent posts; secrets never logged
  slack-interactions.ts       parse + apply decisions to the LOCAL intent store
  socket-mode.server.ts       minimal Socket Mode on global WebSocket (verification only)
app/routes/
  api.slack.interactions.tsx  signed HTTP endpoint (503 until configured)
  app.erp.ops-hub.tsx         staff hub: registry, matrix, intents, Slack state, simulation
```

## Data flow

```
lead / job / quote facts ──► deterministic agent module ──► proposal
                                                     │
                                   proposeIntent(idempotencyKey) ─► PROPOSED
                                   validateIntent ─► APPROVED (AUTO_*) | AWAITING_APPROVAL | FAILED (DISABLED)
                                                     │
                     Slack card (sandbox) ◄── intentCard(intent) ── AWAITING_APPROVAL
                     staff click ─► verify signature ─► dedupe ─► parse allowlist ─► staff map ─► decideIntent
                                                     │
                                   executeIntent(executor) ─► COMPLETED (once) | FAILED
```

## What is reused, not duplicated

- Leads enter the **Agent Review Queue** (`AgentReviewQueueItem`, statuses `needs_staff_review` / `missing_customer_info` / `needs_cost_review`).
- Production statuses are the ERP's own (`new, proof_sent, proof_approved, routed, printing, cutting, production, qc, reprint_needed, completed, shipped, on_hold, cancelled`).
- Machine routing: `decideMachine` from `print-intake-routing.server.ts`; machine keys from `machine-routing.server.ts`.
- Checklists: `FAMILY_CHECKLISTS` / `checklistForFamily`.
- Customer art approval: the proof portal (`proofStatus = approved`) bridged by `approvalFromProofPortal`.
- Purchasing drafts mirror `PurchaseRequest` columns.
- Cost readiness: `familyCostModel` / `isCanonicalFailClosedFamily` from the canonical quote authority.

## Not built tonight (deliberately)

- **No LLM provider.** No API key, no client. Model-dependent agents are DRAFT.
- **No durable intent store.** `InMemoryActionIntentStore` only; a Prisma model is the first deployment step.
- **No background worker / cron / outbox.** Socket Mode needs a long-running process; Render web service is request-driven. Design in `GSO_AGENT_DEPLOYMENT_PLAN.md`.
- **No writes to ProductionJob, Quote, PurchaseRequest, Shopify, QuickBooks** from any agent path.
- **No wiring of the transition guard into `app.erp.production.tsx`** (recommended follow-up; the handler currently accepts any status string).
- **No PDF parsing** in art preflight; unknown geometry → NEEDS_DESIGNER.

## Background automation design (Phase 32)

Today the ERP has no cron, worker or outbox. Proposed (not built): an `OpsOutbox` table written in the same transaction as the ERP change (status_change event, queue item created, purchase request created); a single worker (Render background worker, owner approval required) drains it, runs the deterministic agents, creates intents, posts Slack cards (sandbox first). Idempotency = outbox row id. Failure = row stays, exception `SLACK_FAILURE` raised once per row.
