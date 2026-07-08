# GSO ERP Project State

## Current Repo And Branch

- Repo path: `C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp`
- Branch: `main`
- Latest stable commit: `965d3c6 Add schema backed low margin approval`
- Working tree at closeout: Patch 9A (customer tier foundation on Quote) pending commit

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

## Completed Milestone: Quote Payment Status Flow (Patch 1)

- `webhooks.orders_paid.tsx` classifies quote payments as deposit / balance / full via order tags, note text, and line-item properties.
- Deposit payment sets `Quote.status = "deposit_paid"` and never marks the quote fully paid.
- Balance payment marks the quote `paid` only after the deposit is confirmed paid.
- Full payment marks the quote `paid`.
- Unclassifiable quote payments change nothing (fail closed) and are flagged in the webhook response text.
- Payments append `[GSO] ... invoice paid (Shopify order ...)` audit lines to `Quote.notes`.
- Quote status list: draft, sent, approved, deposit_paid, paid, production, completed.

## Completed Milestone: Shared Recipe Pricing Engine (Patch 2)

- Engine lives in `app/lib/recipe-pricing.server.ts`; finish presets in `app/lib/finish-presets.ts`.
- Exports: `QUOTE_READY_RECIPE_WHERE`, `QUOTE_RECIPE_PRICING_INCLUDE`, `priceRecipeAtQuantity`, `blockingConversionIssues`.
- Quotes / CRM `priceRecipeLine` and Agent Review Queue conversion both price through this engine.
- Queue conversion is fail-closed: no unambiguous recipe, non-positive unit cost or price, missing in-house inputs (width/height, materials, preferred machine), or quantity below recipe minimum = no draft quote.
- `defaultSellPrice` and `SourcedCostTier` no longer drive queue conversion pricing.

## Completed Milestone: Production After Full Payment (Patch 3)

- Owner rule: production starts only after full payment, never after deposit alone.
- Quotes / CRM offers Create Production Job only for `paid` or `production` quotes.
- Server gates in `app.quotes.tsx` and `app.erp.production.tsx` reject job creation for draft/sent/approved/deposit_paid quotes.
- `deposit_paid` rejection message: "Balance must be paid before production can start."
- Opening an already-existing production job remains allowed.
- The paid-order webhook (configurator auto-jobs from paid Shopify orders) is unchanged.

## Completed Milestone: Draft Order / Invoice Safety (Patch 4)

- Full payment and deposit draft orders require quote status `approved`.
- Remaining balance draft order requires quote status `deposit_paid` plus an existing deposit order.
- Duplicate full/deposit/balance draft orders are blocked server-side via the stored created flags.
- Full payment and deposit/balance tracks are mutually exclusive per quote.
- Balance order amounts come from stored `depositAmount` / `balanceDue`, never recomputed from current items.
- Draft order creation no longer sends invoice emails automatically.
- New `sendInvoiceEmail` intent sends Shopify invoices only on explicit staff click, is repeatable, and appends `[GSO] ... invoice email sent.` audit lines to quote notes.
- Legacy `/app/create-order` route is gated identically and now writes the full-order flags and `Full Payment` tag (kept registered in `app/routes.ts`; delete later in a patch allowed to touch route registration).
- Webhook classification strings (tags and note prefixes) are unchanged.

## Completed Milestone: Public Quote Portal Customer-Safe Projection (Patch 5)

- `quote.$id.tsx` loader uses an explicit Prisma select allowlist; full Quote/QuoteItem rows are never loaded or returned.
- Quote fields returned: id, customerName, company, status, created flags, invoice URLs.
- Item fields returned: id, productName, variant, sku, quantity, unitPrice, computed lineTotal.
- Excluded: unitCost, cost/price snapshots, margins, profit, recipe fields, pricingSource, add-on ids, quote/item notes, email, phone, depositAmount, balanceDue, draft order GIDs, artwork/proof URLs.
- Customer-safe status labels added (deposit_paid -> "Deposit received", production -> "In production").
- Portal pages send `X-Robots-Tag: noindex, nofollow` and a robots meta tag.
- Tokenized links and shop scoping deferred to a later schema-approved hardening patch.

## Completed Milestone: Queue Row Expansion + Staff Recipe Picker (Patch 6)

- Agent Review Queue rows expand inline (component state only) to show contact, request details, missing fields, escalation reasons, customer-safe summary, and internal notes.
- Ready-to-quote rows show a required quote-ready recipe dropdown inside the existing convert form.
- `create_quote_draft` requires `selectedRecipeId` in the POST body; silent auto-match no longer creates quotes.
- Auto-match (`resolveQuoteReadyRecipe`) now only preselects the dropdown when exactly one match exists.
- Selected recipe is validated server-side by id + shop + quote-ready gates before pricing.
- Conversion events record `selectedRecipeId` and `selectionSource` (staff_selected / staff_accepted_suggestion / none).
- All Phase 8B fail-closed gates and the shared pricing engine remain unchanged.
- No new routes, no itemId query params, no detail-route patterns (embedded login-loop bans respected).

## Completed Milestone: Exact Conversion Blocking Reasons (Patch 6B)

- Queue loader aggregation captures the latest `quote_draft_conversion_failed` event per item from already-fetched audit events (no new queries).
- Metadata is extracted defensively: reason, blockingIssues, selectedRecipeId, recipeName, selectionSource, actor, timestamp.
- Audit column shows a concise `Last failure: ...` line; the Details expansion shows a full "Last conversion failure" block with blocking issues as a list.
- Failure blocks are hidden once an item is converted.
- Conversion failure banners stay short and point staff to the row's Details.
- Conversion gates, pricing engine, and event writes are unchanged; reasons never travel through URL params.

## Completed Milestone: Product Setup Recipe Readiness + Test Pricing (Patch 7A)

- Product Setup shows a Recipe readiness box for the open recipe: gate flags, pricing test (unit cost / unit price / margin / tier), exact blocking issues, non-blocking cautions, and a final verdict.
- Readiness uses the shared engine (`priceRecipeAtQuantity` + `blockingConversionIssues`), so wording matches Agent Review Queue conversion failures exactly.
- Default test quantity is `minQuantity || 1`; staff can test any quantity via the side-effect-free `testRecipePrice` intent (zero writes, no Shopify calls).
- Selected-recipe loading spreads `QUOTE_RECIPE_PRICING_INCLUDE` (adds ink channels, add-ons, vendor product) while keeping existing UI relations; selected recipe only.
- Enabling Use in Quotes / CRM is now server-gated: other fields save, then post-save readiness must pass or the flag stays off with exact reasons ("Saved, but Use in Quotes stayed off: ...").
- Already-enabled recipes with blockers are never auto-disabled; they show a loud conversion-will-fail warning instead.
- Fixed pre-existing bug: saving Recipe Details silently wiped the recipe's preferred machine rule (the form posts no `machineId`, but the intent deleted rules unconditionally). Machine rules are now rewritten only when a form actually posts `machineId`.
- defaultSellPrice save gap fixed in Patch 7A.1: `createRecipe` and `updateRecipe` now persist positive values via `positiveOrNull` and store blank/invalid/zero/negative input as null. The shared pricing engine still does not read `defaultSellPrice`, so readiness verdicts are unchanged by this field.

## Completed Milestone: Product Setup Recipe Fix Tools (Patch 7B)

- Fixed critical pre-existing bug: `updateRecipe` overwrote every non-posted field with defaults on each save, silently wiping minQuantity (to 64), defaultQuantity (to 250), labor/prepress/application fields (to 0), template link, Shopify product/variant GIDs, pricingTemplateMode, and clearing the `costReviewNeeded` safety flag. `updateRecipe` is now a partial update: only fields the submitting form posts are written.
- `useInQuotes` is managed only by forms that post the `manageQuoteFlag` sentinel (Recipe Details form); the 7A enable-gate still runs post-save.
- New "Fix readiness blockers" card: width/height (positiveOrNull), minimum quantity (clamped >= 1), preferred machine dropdown (shop-validated, uses the guarded RecipeMachineRule rewrite).
- Revived material tools: attach existing material (recipe + material ownership checked) and remove material rows, using the previously orphaned intents.
- New minimal tier tools: `addBasicTier` (min/max qty, fixed price or margin clamped 0-95, rejects when both blank) and `deleteTier` (scoped by shop + recipe). No delete-all/bulk-parse behavior.
- Loader adds light lists only: active machines (id+name, take 100) and active materials (display fields, take 200); memory-safe mode preserved.
- Readiness box recomputes automatically after every fix (React Router revalidates loaders after actions).
- Known follow-up (7C candidates): data-repair audit for recipes already damaged by the old wipe behavior; label zones / media options / vendor-product linking UI.

## Completed Milestone: Print Materials vs Blank Items Split (Patch 7B.1)

- Product Setup material attach is now two separate forms: "Attach printed material" (print substrates only; defaults media / qty 1 / sqft / 10% waste) and "Apply to blank item (optional)" (jars/bags/boxes/pouches; fixed usageType blank + unit each, defaults qty 1 / 0% waste).
- Route-local classifier keyword-matches free-string `materialType` (real data includes seeded "blank_jars") with baseUnit fallback: sqft/sqin or label/dtp/laminate/banner/media/vinyl/roll hints = print; blank/jar/bag/box/pouch hints or each-based = blank item; ink/labor/machine excluded from both dropdowns.
- Recipe materials table shows a Print media / Blank item / Other chip per row.
- `addMaterial` positive-guards quantity: blank/zero/negative input saves 1, closing the `numberValue("") === 0` trap that silently zeroed a row's cost contribution. Global `numberValue` unchanged.
- No schema, engine, or pricing-math changes; usageType remains cosmetic to engine math (unit drives the formula).

## Completed Milestone: Below-40% Margin Approval Gate (Patch 7C)

- New `app/lib/quote-margin.server.ts`: `LOW_MARGIN_THRESHOLD_PCT = 40`, `itemMarginPct`, `quoteMarginState` (actual margin from unitPrice/unitCost; stored marginPct is never trusted).
- A quote is low-margin when any item has actual margin below 40%, non-positive unit price, or unknown cost (`unitCost <= 0` counts as low-margin by owner decision).
- Server gates block low-margin unapproved quotes from: status moves to sent/approved, full payment order, deposit order, balance order, invoice email, and the legacy `/app/create-order` route.
- New `approveLowMarginQuote` intent: staff-only, requires a reason (capped 300 chars), recomputes margin server-side, rejects non-low-margin quotes, appends an audit marker to quote notes, and has zero Shopify/order/invoice/message/production side effects.
- Approval marker format: `[GSO] Low-margin approved by <actor> at <ISO> (threshold 40%, blended X%, lowest item Y%): <reason>` (namespaced; no collision with payment/email markers).
- Quotes board cards show blended/lowest margins, critical "approval required" badge, warning "approved" badge, reason input + approve button; gated buttons (payment, invoice emails, portal copy/email) hide while blocked. Server gates are the real protection.
- Every quote returned by `getQuotes` carries a server-computed `marginState`; the client never imports the margin lib.
- Portal privacy: Patch 5 projection already excludes notes/costs/margins, verified again this patch.
- Known upgrade deferred to the migrations baseline: replace notes-marker approval with schema-backed approval columns (approvedAt/By/Reason/Threshold) including staleness invalidation when items change after approval.
- Patch 7C.1: `quoteMarginState` now returns per-item `kind` (below_threshold / unknown_cost / invalid_price) plus `hasBelowThreshold` / `hasUnknownCost` / `hasInvalidPrice` / `approvalLabel`; badges and block messages say "Unknown cost - approval required", "Low margin - approval required", "Low margin / unknown cost - approval required", or "Invalid price - approval required" as appropriate. Gates and approval logic unchanged.

## Completed Milestone: Engineering Baseline Files (Patch 8A)

- Owner-run read-only drift check against production returned "This is an empty migration." (production matches `prisma/schema.prisma`).
- Baseline migration files added: `prisma/migrations/0_init/migration.sql` (generated from the schema only, 55 tables, no database contact) and `migration_lock.toml` (postgresql).
- Vitest added (`npm test`): 20 passing pure unit tests over `quote-margin.server.ts` (labels, thresholds, marker detection, blended/lowest math) and `recipe-pricing.server.ts` (margin math, fixed tiers, tier selection, MOQ warning, vendor tiers, blocking issues). No database, no Shopify.
- `docs/MIGRATIONS.md` runbook added: never-do list, owner-executed baseline activation (`migrate resolve --applied 0_init`), Render Pre-Deploy `npx prisma migrate deploy`, rollback (`--rolled-back`), and the 8B authoring workflow.
- CRITICAL standing hazard documented: local `.env` `DATABASE_URL` currently points at production Postgres — every local prisma command must be treated as production until a local dev database is set up.
- Zero runtime behavior changes: no app/ files touched, schema untouched, no prisma command contacted any database.
- Patch 8B (next): schema-backed low-margin approval fields as the first real migration through the proven pipeline.

## Completed Milestone: Schema-Backed Low-Margin Approval (Patch 8B)

- First real migration after the 8A baseline: `20260707130000_add_low_margin_approval_fields` — five nullable Quote columns (`lowMarginApprovedAt/By/Reason/ThresholdPct/Snapshot`). Generated fully offline via the two-schema diff; applied only by Render Pre-Deploy `migrate deploy`.
- `approveLowMarginQuote` now writes the schema fields (actor, reason, threshold, item snapshot) and still appends the `[GSO] Low-margin approved ...` notes marker as human-readable history.
- Approval resolution order in `quoteMarginState`: schema fields with value-matched snapshot (source "schema") > stale schema approval (re-blocks, `approvalStale`) > legacy notes marker when fields are empty (source "legacy_marker", transition support) > unapproved.
- Snapshot comparison is value-based over deterministically sorted items (quote saves recreate QuoteItem rows, so ids are unstable); editing any item price/cost/quantity/line after approval re-blocks with "Items changed since approval - re-approve."
- Board card shows "Low margin approved by <actor> on <date>" from the fields and the stale re-approve message; all Patch 7C gates consume approvalRequired/blockMessage unchanged.
- Tests: 26 passing (6 new: schema approval, staleness, reorder-stability, legacy marker, fields-win-over-marker, snapshot shape).
- Portal privacy: explicit select in `quote.$id.tsx` excludes the new fields automatically; verified.

## Completed Milestone: Customer Tier Foundation (Patch 9A)

- Migration `20260707150000_add_quote_customer_tier`: `Quote.customerTier String @default("standard")` + `Quote.customerTierLabel String?`. Authored offline via the two-schema diff; applied only by Render Pre-Deploy.
- Tier registry in client-safe `app/lib/customer-tiers.ts`: standard, wholesale, vip, distributor, house_account, custom (string + validated registry by owner decision — no Prisma enum). Future per-tier config (margin floors) belongs here.
- Quotes / CRM: editor has a Customer tier select (Custom reveals a label field, capped 80 chars); board card shows the tier badge; `save` validates server-side (unknown values become standard; label persisted only for custom).
- Agent Review Queue untouched: the DB default stamps standard on conversion-created drafts.
- Deliberate non-behavior (owner-locked): tier does not affect pricing, does not bypass low-margin approval, does not stale approvals (tier is not in the approval snapshot), and is not exposed on the public quote portal.
- Tests: 34 passing (8 new: registry contents, validation, display labels, and a guard proving tier changes never alter margin state or stale schema approvals).

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
- mockup/approval package workflow
- customer-facing quote sending

## Next Major Phase

Patch 9B+ (per aligned roadmap), sequencing to be confirmed with the owner:

- Tier-aware pricing planning: canonical Shopify customer tags per tier (wholesale_approved and vip_wholesale exist; distributor / house_account to add), tier-scoped WholesaleRule/PricingRule mapping, function-config sync.
- Per-tier margin floors in the tier registry (replacing the flat 40% threshold) — connects tiers to the low-margin gate deliberately, not accidentally.
- Longer-term: CustomerProfile model once quote-level tiers prove out (backfill/dedupe strategy required).
- Alternative next track: agent platform hardening (credential management UI, intake rate limiting) per the aligned roadmap Patch 11.

Still not allowed:

- external-agent quote/order/production creation
- customer-facing sends without explicit staff action
- production before full payment
- bypassing recipe gates (`active`, `useInQuotes`, `costReviewNeeded: false`)

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
