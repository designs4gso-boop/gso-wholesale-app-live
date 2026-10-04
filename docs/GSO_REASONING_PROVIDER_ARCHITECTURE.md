# GSO Reasoning Provider Architecture

**Version:** reasoning-provider/1.0.0-2026-10-04 (OPS-2) · **Status:** LOCAL BRANCH, NOT DEPLOYED · **Live model calls:** NONE performed · **Preferred provider:** OpenAI Agents SDK · **Anthropic:** future-capable, not implemented

## The rule

AI handles reasoning. GSO code handles authority. The model never becomes the authority for cost, price, MOQ, production status, machine routing, art approval, QC, financial state, permissions, customer authorization or business rules.

```
STAFF / CUSTOMER
   │
Slack / ERP UI
   │
GSO Operations Supervisor      app/lib/reasoning/operations-supervisor.ts
   │
ReasoningProvider              app/lib/reasoning/provider.ts
   ├─ DisabledReasoningProvider  (default)
   ├─ FakeReasoningProvider      (tests / simulation)
   ├─ OpenAIReasoningProvider    (server-only, runtime-disabled until configured)
   └─ AnthropicReasoningProvider (future; same contract)
   │
GSO AGENT TOOL GATEWAY         app/lib/reasoning/tool-gateway.ts
   │  allow-list → JSON validation → specialist allow-list → permission matrix → untrusted-text scan
   ├─ READ tools   → deterministic services (gateway-services.server.ts)
   └─ PROPOSAL tools → ActionIntent (action-intents.ts) → approval policy → durable audit
   │
Deterministic executors        outbox-worker.ts, production-transition-executor.ts
   │
ERP / Shopify / Slack          (QuickBooks DEFERRED)
```

Every consequential model-requested action flows: model → typed tool request → deterministic input validation → permission matrix → canonical business-rule validation → ActionIntent → approval policy → durable audit → deterministic executor → result. The model cannot bypass this path: it has no other tools.

## Provider contract (`provider.ts`)

`ReasoningProvider { providerId, capabilities, health(), runAgent(input) }`. `runAgent` receives: agent id, specialist key, allow-listed tool names, output schema name, minimum context (facts + untrusted text envelope), limits (maxTurns, timeoutMs, maxToolCalls), a `executeTool` callback into the gateway, and optional resume state + decision. It returns one of `completed | paused_for_approval | handoff | disabled | failed(kind)`. Nothing in the contract references OpenAI classes.

## Which agents reason

| Agent | Reasoning | Deterministic fallback |
|---|---|---|
| operations_supervisor | yes (routing, summary, next-action proposal) | classifyLead keyword routing; production-status answers |
| cannabis_packaging_sales | yes (lead interpretation, clarification, draft reply) | sales-intake draftCustomerSafeReply + intake questions |
| commercial_print_sales | yes (same) | same |
| marketing_agent | yes (concepts, copy drafts, briefs) | marketingBrief scaffold with copy null |
| everything else (costing, price, MOQ, readiness blockers, routing, art state, transitions, QC, shipping, invoice facts, purchasing math, idempotency, permissions, financial authorization, audit) | **never** | n/a |

Later candidates (not enabled): customer_followup, exception_manager.

## Structured output (`schemas.ts`)

SalesClassification, LeadQualification, MissingInformationRequest, CustomerReplyDraft, NextActionProposal, AgentRecommendation, MarketingBrief, ExceptionAnalysis. Each is JSON Schema (for the provider) plus a GSO validator that fails closed: unknown fields, `containsPricing: true`, `requiresApproval: false`, discount language in marketing copy and free prose are all rejected. Malformed output → deterministic fallback.

## Tool gateway (`tool-gateway.ts`)

READ: getProductRules, getQuoteReadiness, getCanonicalCostStatus (never returns a price), getCustomerSummary, getLeadStatus, getArtStatus, getProductionStatus, getPurchasingStatus, getShippingStatus, getAgentCapabilities.
PROPOSAL: proposeQuoteAction, proposeFollowup, proposeArtReview, proposeProductionTransition, proposePurchaseRequest, proposeExceptionEscalation.

Forbidden for every production agent (tested by `FORBIDDEN_TOOL_PATTERNS`): shell, apply_patch, computer use, filesystem, Prisma/SQL, Shopify mutations, Slack sends, invoice/PO/refund APIs, HTTP/web, exec/PowerShell. Engineering tools belong to Claude Code, not to the Operations Agent.

## Prompt injection (`untrusted-text.ts`, gateway)

All customer/Slack/vendor/email/artwork text is wrapped in an `<untrusted>` envelope with the policy restated after it. Instruction-like text (ignore policy, override price, set MOQ to 1, approve art, move job, refund, send invoice, reveal prompt, access other customers) is flagged, routed as an exception, and any tool argument carrying it is refused. Customer text can never change permissions, policies, tool availability, pricing, canonical rules, agent role or autonomy level — none of those are inputs to the model.

## Context and memory policy

Minimum structured context only (display name, ids, family, quantity, status, missing fields, rule output). Never secrets, raw rows, private notes, tax ids, payment data. Session memory is continuity only; the ERP wins on any conflict (approved price, art approval, production status, payment, QC, authorization).

## Human-in-the-loop mapping

Proposal tools with `needsApproval=true` pause the SDK run. The gateway has ALREADY created the ActionIntent; the pause is mapped to it and an `OpsAgentRun` (workflow state, not authorization) is saved with the serialized run state. Approval is recorded only on the ActionIntent (Slack / ERP / hub). `resumeAfterDecision` resumes the run as approved or rejected from the intent's status. There is one approval authority: the ActionIntent.

## Fallback

If the provider is disabled, unconfigured, errors, times out, exceeds turns, hands off illegally or returns malformed output, `runOperationsSupervisor` returns a deterministic outcome. Sales intake, quote prep, canonical costing, production status, art state, reporting and Slack deterministic approvals keep working with the model off.

## Anthropic future compatibility

A future `AnthropicReasoningProvider` implements the same `ReasoningProvider` contract. OpenAI-specific assumptions to adapt (listed in `OPENAI_RUNTIME_ASSUMPTIONS`): strict JSON Schema tool parameters (already provider-neutral), json_schema output type (GSO re-validates anyway), approval interruptions via serialized RunState, SDK-global tracing flags, key injection inside the provider module. No business tool depends on OpenAI classes; no Anthropic package is installed.
