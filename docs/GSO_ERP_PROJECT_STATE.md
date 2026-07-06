# GSO ERP Project State

## Current Repo And Branch

- Repo path: `C:\Users\golde\shopify-apps\wholesale-lite-mvp`
- Branch: `main`
- Latest stable commit: `e00df35 Harden agent intake auth validation`
- Local/origin status at closeout: `HEAD` matches `origin/main`

## Golden Rule For All Agents

- Do not restart the project.
- Read this file before planning or patching.
- Do not change files outside the allowed list.
- Do not commit or push unless explicitly told.
- Always report changed files, build result, git status, and risks.
- For any route/schema/security change, plan first, patch second, audit third.
- Use small reversible phases.

## Completed Milestone: Agent Review Queue

Stable routes:

- `/app/erp/agent-review-queue`
- `/app/erp/agent-review-queue/new`

Working features:

- Staff can manually create internal queue items.
- Queue creation writes `AgentReviewQueueItem` and `AgentReviewQueueEvent`.
- Queue list is shop-scoped and admin-authenticated.
- Staff can update safe statuses inline.
- Status actions write `AgentReviewQueueEvent`.
- Reject and Missing info require notes.
- Notes are stored in audit event metadata.
- Audit summary column shows latest event/count.
- Status filters work:
  - All
  - Staff review
  - Missing info
  - Cost review
  - Ready
  - Rejected
  - Archived

Important caution:

- Dynamic detail route `/app/erp/agent-review-queue/:id` caused Shopify embedded login loop and was reverted.
- Query-param item detail panel also caused Shopify embedded login loop and was reverted.
- Do not re-add detail routes.
- Do not add `itemId` query detail behavior.
- Do not add selected queue item detail lookup.

## Completed Milestone: Secure Sales-Agent Intake

Stable endpoint:

- `POST /api/agent/intake`

Read-only rule endpoints:

- `/app/erp/agent-product-rules`
- `/app/erp/agent-intake-rules`
- `/app/erp/agent-quote-prep-rules`
- `/app/erp/agent-quote-prep-draft-shape`
- `/app/erp/agent-review-queue-rules`

Schema models:

- `AgentApiCredential`
- `AgentSubmissionLog`
- `AgentReviewQueueItem`
- `AgentReviewQueueEvent`

`/api/agent/intake` behavior:

- POST-only
- JSON-only
- raw-body HMAC verified before JSON parsing
- 32KB body limit
- no CORS headers
- no Shopify admin auth dependency
- not an embedded app route

Auth requires:

- `Authorization: Bearer <tokenId>.<tokenSecret>`
- `X-GSO-Agent-Timestamp`
- `X-GSO-Agent-Signature`

Confirmed security behavior:

- token hash comparison uses timing-safe comparison
- HMAC signature comparison uses timing-safe comparison
- timestamp tolerance is enforced
- ambiguous active `tokenId` matches are rejected
- revoked credentials are rejected
- shop comes only from `credential.shop`

Live tests passed:

- `GET /api/agent/intake` returned 405
- JSON POST without auth returned 401
- `text/plain` returned 415
- valid signed request returned 201
- one `AgentReviewQueueItem` was created
- duplicate idempotency request returned 200 duplicate true
- test credential was revoked
- no quote/order/message/production behavior was created

## Safety Boundaries

Agent endpoint may create only:

- `AgentReviewQueueItem`
- `AgentReviewQueueEvent`
- `AgentSubmissionLog`
- optional `AgentApiCredential.lastUsedAt` / `lastUsedIpHash`

Agent endpoint must not create:

- real quotes
- quote approvals
- final pricing
- Shopify draft orders
- invoices
- customer messages
- production jobs
- Shopify edits
- ERP product edits

## Existing Quote Recipe Safety Gates

Quote recipe gates remain:

- `active: true`
- `useInQuotes: true`
- `costReviewNeeded: false`

## Product Builder / Product Setup Scope

Current ERP/Product Builder priority:

- blank jars
- stickers / die cut stickers / regular stickers
- banners
- custom/other as safe catch-all

Stock bag configurator remains separate.
Do not build label-only/application options for 4x5 bags unless explicitly requested.

## Intentionally Deferred

- durable rate limiting
- credential management UI
- real production agent credentials
- Ready-to-Quote conversion
- Quote Draft creation
- mockup/approval package workflow
- customer-facing quote sending

## Next Major Phase

Phase 8A:
Ready-to-Quote -> Quote Draft planning.

Goal:
Plan a staff-only conversion from an approved Agent Review Queue item into a Quote Draft using only quote-ready recipes:

- `active: true`
- `useInQuotes: true`
- `costReviewNeeded: false`

Phase 8 must not:

- create Shopify draft orders yet
- send customer messages
- start production
- bypass staff approval
- let external agents convert queue items
- create final customer-facing quotes without human approval

## Tool Workflow

Use:

- ChatGPT project chat as project brain, roadmap, safety controller, and prompt writer.
- Claude/Fable 5 for larger coding/refactor execution when useful.
- Codex for focused repo patches, audits, and build verification.
- Render for live deploy, DB sync, shell testing.
- PowerShell for git commits, pushes, and local checks.

Every coding-agent prompt should start with:

```text
Read docs/GSO_ERP_PROJECT_STATE.md first.
Do not restart the project.
Do not change files outside the allowed list.
Do not commit or push unless explicitly told.
Report changed files, build result, git status, and risks.
```
