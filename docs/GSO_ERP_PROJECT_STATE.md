# GSO ERP Project State

## Current Repo And Branch

- Repo path: `C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp`
- Branch: `main`
- Latest stable commit: `42d9bc3 Separate setup wizard blockers and warnings`
- Working tree at closeout: Patch 11C (ERP Walkthrough / staff SOP page) pending commit

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

## Completed Milestone: Tier Rules Registry, Behavior Frozen (Patch 9B)

- `CUSTOMER_TIERS` registry now carries policy: `marginFloorPct` (40 for every tier by owner decision) and `manualTermsOnly` (true for house_account and custom). `tierRule(tier)` accessor falls back to standard. Hardcoded registry on purpose: floor changes must be reviewed code diffs, never runtime data.
- `quoteMarginState` uses the quote's tier floor as the low-margin threshold; since all floors are 40, behavior is identical to before (proven by behavior-freeze tests across all six tiers). `LOW_MARGIN_THRESHOLD_PCT` remains exported as the standard floor.
- Approval line and approval snapshot record the threshold actually used (`thresholdPct` parameterized end to end).
- Quotes board: "Manual terms" badge for house_account/custom (display only — no payment/deposit/order/production bypass) and the margin line shows the tier floor.
- No migration, no engine changes, no discount fields (deliberately absent until explicitly approved).
- Tests: 42 passing (8 new: per-tier freeze proofs, unknown-tier fallback, registry policy assertions, threshold plumbing proof at a hypothetical 35).
- Future (explicit owner approval required per change): lowering any tier floor (e.g. distributor 35) is a one-line registry diff + test flip; tier-based target margins / discounts remain unimplemented.

## Completed Milestone: Agent Platform Hardening (Patch 10A)

- New staff-only Agent Security page at `/app/erp/agent-security` (registered route + nav link): list credentials, create credentials, revoke with required reason, and view the last 50 intake submission logs.
- Credential creation is server-side only: `crypto.randomBytes` tokenId + 32-byte secret; only the sha256 `tokenHash` is stored; the raw `tokenId.tokenSecret` is shown exactly once in the creation response and never logged.
- Revocation is one-way (`isActive false` + `revokedAt` + reason + actor). Re-enabling means issuing a new credential.
- New credentials carry `scopes: ["intake:create"]` and optional `allowedProductFamilies` (jars / banners / labels-stickers / custom-other; none = all).
- `/api/agent/intake` hardening (all fail-closed, contract unchanged for legitimate agents):
  - Global auth-failure brake: 100 `rejected_auth` logs in 5 minutes -> 429, deliberately unlogged to prevent log-write amplification.
  - Per-credential rate limits: 60/hour and 10/minute burst -> 429 with a `rejected_rate_limit` log.
  - Scope enforcement: null scopes grandfathered (legacy); non-null scopes must include `intake:create` (`missing_scope`).
  - Product-family enforcement per credential (`family_not_allowed`).
  - Replay guard: same credential + same payload hash accepted within 10 minutes returns the original queue item as duplicate, closing the no-idempotency-key replay window.
- Rate limiting is powered by existing AgentSubmissionLog counts (indexed) - zero schema changes in 10A. Per-IP throttling deferred to a 10B index-only migration.
- External agents remain strictly intake-only: no quotes, orders, invoices, messages, production jobs, or gate bypasses.
- Tests: 51 passing (9 new pure-helper tests: scope grandfather/deny, malformed-shape safety, family allow/deny, approved rate-limit constants). Intake integration tests deferred (require DB + signed-request harness).

## Completed Milestone: Intake Auth Fix + Canonical Signer (Patch 10A.1)

- Root cause of the live 401s: the local test script sent unix SECONDS in `X-GSO-Agent-Timestamp` while the server compares millisecond time (~56-year skew -> `invalid_timestamp`); six auth failure classes share the same generic 401 body. The colon-format attempt failed at parse (dot was always the canonical separator).
- Server fix: `parseAgentTimestamp` now normalizes unix seconds to milliseconds (values < 1e11); the +/-5 minute tolerance window is unchanged. Bearer parsing tolerates `:` as a legacy separator when no valid dot split exists; the canonical displayed format remains `tokenId.tokenSecret`.
- Auth crypto (`sha256Hex`, `timingSafeEqualString`, `parseAgentBearer`, `parseAgentTimestamp`, `verifyAgentSignature`, `AGENT_TIMESTAMP_TOLERANCE_MS`) moved verbatim from the intake route into `app/lib/agent-security.server.ts` and covered by known-vector unit tests (61 passing total).
- `tools/test-agent-intake.ps1` replaced with a canonical signer: one-paste token, millisecond timestamps, byte-exact UTF-8 body send, replay test, never echoes the secret.
- Agent Security one-time-token banner now documents the exact wire format and points at the test script.
- Diagnostics reminder: every rejected intake attempt's exact `errorCode` is visible in the Agent Security submissions table.
- No weakening of HMAC/signature checks, rate limits, scope/family enforcement, or intake-only boundaries.

## Completed Milestone: Agent Security Polish + Launch Readiness (Patch 10B)

- LIVE SMOKE TEST PASSED after 10A.1: signed intake returned 201 accepted, exact replay returned 200 duplicate, replay guard and credential auth verified end to end against production.
- `AGENT_ERROR_CODE_EXPLANATIONS` documents all 14 intake errorCodes; a completeness test pins the map to the endpoint's emitted codes (adding a code without documenting it fails the suite).
- Agent Security submissions table shows a plain-language explanation under each errorCode (explanations delivered via loader data so the component never imports from a .server module).
- Client-side submission filters (All / Accepted / Duplicates / Failures, with counts) using component state only - no URL changes.
- Badge tones: accepted=success, duplicate=info, rejected_rate_limit=warning, other failures=critical.
- New "How to test & integrate" card: staff testing steps (create -> one-time token -> tools/test-agent-intake.ps1 -> 201 -> 200 duplicate -> verify logs and queue) plus the full wire contract for agent vendors (endpoint, Bearer tokenId.tokenSecret, timestamp rules, HMAC formula, rate limits, replay window, family restrictions). No secrets displayed beyond the placeholder format.
- tools/test-agent-intake.ps1 remains the official internal signer, unchanged.
- External agents remain strictly intake-only; no behavior changes to the intake endpoint in this patch.
- 10C candidates recorded: per-IP throttling (needs ipHash index migration), submission-log retention/pruning, per-credential rate-limit overrides, signed-request integration test harness.

## Completed Milestone: Setup Wizard Launch Readiness (Patch 11A)

- Extended the existing read-only Setup Wizard (which predated Phases 7-10) with three new step cards, all DB-count-only:
  - Quote Pipeline: quote-ready recipe count (shared QUOTE_READY_RECIPE_WHERE), total / deposit-paid / paid quote counts. Status ladder: no quote-ready recipes = Needs setup; no quotes = Partial; no paid quote = Needs review; paid quote exists = Ready. Notes that flag-ready is not full conversion readiness (Product Setup readiness box is the per-recipe truth).
  - Quote Safety Gates: always-Ready evidence card enumerating the armed gates (margin/unknown-cost approval, paid-only production, payment classification, split invoice send, portal privacy, intake-only agents) with usage counts (low-margin approvals recorded, deposit-paid quotes).
  - Agent Platform: active credentials, latest accepted signed intake timestamp, queue ready/converted counts. Status: no credentials = Needs setup; no accepted intake = Partial; proven = Ready.
- Launch Readiness card now carries the practical 9-step end-to-end checklist (recipes -> quote flow -> payment flow -> production gate -> signed intake -> margin gate -> portal privacy -> production/reporting review).
- Loader grew from 20 to 29 parallel lightweight queries (counts + one findFirst createdAt), all shop-scoped and indexed; memory-safe mode preserved; zero write actions; zero Shopify API calls.
- Known pre-existing issue confirmed via stash round-trip: the wizard's useLoaderData typing produced 14 tsc errors before this patch (documented loader-typing category); build is unaffected.
- Deferred to 11B/11C: deep per-recipe conversion-readiness scan (button-triggered, batched), Shopify API health checks, persisted checklist sign-offs (schema).

## Completed Milestone: Setup Wizard Blockers vs Warnings + Deep Readiness (Patch 11B)

- Every wizard step now carries a severity overlay (ready / warning / launch blocker) beside its status. Blockers: Cost Foundation missing materials or machines; Product Setup missing profiles/recipes; Quote Pipeline with zero quote-ready recipes or a deep sample passing 0/N. Everything else is at most a warning (Shopify Links / Storefront Configurator are labeled full-launch requirements, not internal-beta blockers; Agent Platform and Reporting are never blockers).
- Header shows a Launch Blockers list (with action links) or "No launch blockers - warnings only", plus Blockers and Warnings stat tiles; the suggested next action prefers blockers.
- Agent Platform status ladder fixed: signed-intake-tested with zero active credentials now shows Partial / Warning with "Signed intake was tested successfully; no active credential is currently issued" (the current live state) instead of Needs setup.
- Reporting copy states explicitly that missing actual-cost jobs is a warning that matures after completed jobs, not a blocker.
- Bounded deep readiness sample: the 10 most recently updated quote-ready recipes load with the shared pricing include and run through priceRecipeAtQuantity + blockingConversionIssues (per-recipe try/catch so the wizard cannot crash). The Quote Pipeline card shows "Deep check: X/N sampled recipe(s) fully conversion-ready" plus up to 3 failing names with their first blocking issue.
- Launch Readiness checklist split into "Internal beta launch" (7 staff-pipeline items) and "Full customer launch adds" (Shopify mappings, storefront configurator, portal with a real customer, agent vendor onboarding, actual-cost reporting loop).
- Cleanup: the wizard's 14 pre-existing loader-typing tsc errors are now 0 (loader data consumed per codebase convention; Step/StepCard keep real types). Still read-only: no actions, no writes, no Shopify calls.

## Completed Milestone: ERP Walkthrough / Staff SOP (Patch 11C)

- New read-only staff SOP at `/app/erp/walkthrough` (registered route + sidebar link "ERP Walkthrough" + "Open Walkthrough" secondary action on the Setup Wizard).
- The safest page in the app by construction: loader authenticates only - no database access, no action export, no Shopify calls, no writes.
- 13 sections covering the full internal-beta pipeline (daily flow, wizard, recipe readiness, quoting, margin/unknown-cost approval, payment requests, paid-to-production, agent security, queue-to-draft, portal privacy, reporting), a "What NOT to do" list (one-time tokens, Move-to-Paid discipline, no hand-typed approval markers, no seed/clear tools on production, developer Prisma guardrails pointer to docs/MIGRATIONS.md), and "Full customer launch additions".
- Every section: what it is, why it matters, click path, links to existing sections (all 13 link targets verified against routes.ts), and safety callouts for the sharp edges (Save sends nothing; order creation does not email; invoice email is explicit; deposit_paid is not paid; stale approvals re-block; agents are intake-only; portal stays customer-safe).
- Maintenance rule: when a patch changes a described flow, update the Walkthrough in the same patch.
- Deferred to the final audit phase: printable/export version, screenshots, live-status fusion with the wizard, customer-facing help.

## Completed Milestone: Cost Calculator Correctness + Cost Health Audit Warnings (Patch 12B.1a)

- Cost Calculator (`/app/erp/cost-calculator`, v2.0) print-media dropdown now uses real DB Materials (active + useInRecipes + shared classifier kind "print"); the four hardcoded roll-media presets and the name-based price overrides (e.g. "holographic" -> $0.72) are deleted. Costs resolve calculatedUnitCost -> costPerUnit -> 0 + warning; **never purchaseCost** (the $205-roll-as-$205/sqft trap). Custom one-time material price still works; materials without a usable unit cost mark the line incomplete with an exact warning.
- Blank/vendor items: DB blank materials + DB VendorProducts now load with their VendorProductTier rows and price via the engine's `getBestRange` at the entered quantity (below-lowest-tier quantities warn and charge the lowest tier, same rule as quotes). Hardcoded presets (SAFE CARE jars/bags, soda can, Miron jars) remain but are labeled "[Preset — code price, may be stale]", and a preset auto-hides when a VendorProduct exists with vendorSku equal to the preset id (the jar ERP seed created exactly those rows, so seeded jars show as DB items, not presets). Remaining presets must eventually be entered as Vendor Products with tiers, invoice-verified, then deleted from code.
- Waste math now matches the shared engine everywhere on the page: required input = base / (1 - waste%), via new shared `applyWasteDivisor` (100 sqft at 10% waste = 111.11 sqft; the old x(1+waste%) multiplier gave 110). Blank-item costed units round up (1,000 jars at 2% = 1,021).
- Hidden write removed: the loader's `printLogAutoImportSetting.upsert` is now a read-only `findUnique`; if the row is missing the sync panel points staff to RIP Imports / Print Log Settings. The route now performs **zero writes** and has no action export.
- Form safety: all `onChange -> requestSubmit()` auto-reloads removed; conditional fields reveal instantly via client state; Add/Remove line are `type="button"` with client-managed rows; exactly one submit button ("Calculate cost"), so pressing Enter in any input calculates and can never add/remove lines. Results recompute only on Calculate (the form remounts keyed on the query string after each calculation).
- Estimate-only banner added: "Estimate only — not saved to quote, recipe, or Shopify."
- New libs: `app/lib/cost-calculator.server.ts` (pure math: material cost resolution, tier selection, waste, line costs, suggested price) and `app/lib/material-classify.ts` (print/blank classifier moved verbatim from Product Setup; Product Setup imports it, zero behavior change). `recipe-pricing.server.ts` changes are additive only: `safeNumber`/`percentToDivisor` exported, `applyWasteDivisor` extracted verbatim — engine behavior unchanged, proven by the untouched existing tests.
- Cost Source Health Check (`/app/erp/cost-health`, v14) gained read-only pricing-audit checks: purchaseCost fallback traps (critical), roll materials missing roll dimensions, machine rate $5-preset vs calculator $8 conflict, stale `costPerMl` vs cartridge math, seeded Mimaki $190/1000ml estimate and 0.0075 ml/sqft default usage rates, vendor products with no cost at all, vendor tiers existing while the live engine still flat-costs in-house blank materials, recipes storing application/packing/prepress labor the engine does not price, SourcedCostTier dead rows, ProductCost/PricingRule legacy rows, and the standing hardcoded-preset notice. Plus a "Cost verification facts" section for the owner.
- Cost verification facts (from the 12B pricing audit, recorded for all agents):
  - **DB-backed does not automatically mean invoice-verified.** Jar/Miron costs, machine ink costs, and jar sell tiers were seeded from code constants.
  - Jar/Miron cost data currently exists in multiple places: calculator presets (code), VendorProductTier rows, flat Material.costPerUnit, and unused SourcedCostTier rows.
  - The owner must verify DB costs against invoices/vendor sheets (Miron tiers, SAFE CARE items, roll media $/sqft + roll dimensions, Roland $156.99/750ml and Mimaki $190/1000ml ink, 0.0075 ml/sqft/1% usage, machine $/hr, labor $25/hr, jar sell-price tiers). Use `costReviewNeeded` to track unverified materials.
  - The external NAS sync script (`gso-sync-quote-rip-results-to-app.ps1`) computes `estimatedInkCost` for RIP results outside this repo — its ink $/ml constant should be located and recorded.
- Deferred on purpose (each moves live quote pricing; separate owner approval required): engine purchaseCost-fallback removal; vendor-tier-aware blank costing for in-house recipes (2,500-jar quotes currently cost jars at the <250 price); pricing the stored application/packing/prepress labor fields (these two engine gaps partially offset each other in jar quotes today). Also deferred: 12B.1b multi-design/file groups, tier sell-price grid (12B.2), artwork attachments (12B.3), Shopify product publisher (12B.4), Mimaki/Roland actual-cost import (13A).
- Tests: 63 -> 82 passing (19 new in `tests/cost-calculator.test.ts`: waste parity/clamps, purchaseCost trap, sqin conversion, Miron tier selection + range labels, below-lowest-tier warning, flat fallback, margin divisor clamp, estimated/actual-per-piece/actual-full-job ink modes, classifier cases). Also fixed cost-health's one pre-existing implicit-any tsc error; the patch introduces zero new typecheck errors (remaining errors are the documented pre-existing baseline in untouched routes).

## Completed Milestone: Shopify Cost Audit, Read-Only (Patch 12B.2b)

- New read-only page `/app/erp/shopify-cost-audit` (route registered + nav link): pulls every Shopify product/variant on an explicit "Pull from Shopify" click (`?pull=1` — never on plain page load), matches them to ERP records, and compares Shopify's merchant-entered variant cost (InventoryItem.unitCost) to the most authoritative ERP cost.
- Pull mechanics: paginated read-only `admin.graphql` query, 50 products/page up to a 1,000-product cap, 100 variants/product; partial-result banners for throttling, the page cap, and >100-variant products. No Bulk Operation (that API is a mutation), no caching, zero database writes, no action export.
- Scope-resilient: the first page probes `inventoryItem { unitCost }`; on an access denial it automatically retries without the inventory block and shows the banner "Shopify cost/COGS access is unavailable — add/approve read_inventory ... then redeploy/reauthorize". Products, variants, prices, SKUs, and ERP matching all still work in degraded mode.
- `read_inventory` was ADDED to `shopify.app.toml` but is **not live until the owner runs `shopify app deploy` and re-approves permissions in the admin** (deliberately not run by the agent). Until then the page runs in degraded mode.
- Matching cascade (most specific wins, one shared lib `app/lib/shopify-cost-audit.server.ts`): variant GID (ProductRecipe.variantGid/shopifyVariantId/shopifyVariantIds, RecipeVariantRule.shopifyVariantGid, PricingRule.variantGid) > product GID/handle (ProductRecipe.productGid/shopifyProductId, ConfiguratorProduct.shopifyProductGid/shopifyHandle) > normalized SKU (VendorProduct.vendorSku, Material.sku, ProductRecipe.sku, RecipeVariantRule.sku, PricingRule.sku). Multiple distinct records = "Ambiguous — needs manual review".
- ERP cost authority order: engine-computed unit cost for matched quote-ready recipes (capped 50, per-recipe try/catch, priced at defaultQuantity) > VendorProductTier band (min-max) / defaultUnitCost > Material via the 12B.1a resolver (never purchaseCost) > ConfiguratorPricingRule costEach band by productType > PricingRule.unitCost (legacy display).
- Statuses with tolerance param (default ±5%, `?tolerancePct=`): Shopify cost missing / unavailable (scope) / ERP match missing / higher than ERP / lower than ERP / within tolerance / ambiguous / needs manual review. Summary cards, client-state filters, worst-delta-first sorting, on-screen cap 600 rows.
- Export: `?pull=1&format=csv` downloads one CSV row per variant (all rows, not just the on-screen cap) plus a Copy TSV clipboard fallback for embedded-iframe download quirks.
- Page banner states the governing caveat: Shopify cost is merchant-entered and may itself be wrong — a mismatch says where to pull the invoice first; invoice verification (12B.2a workbook work) decides truth.
- Rider fixes: registered the previously **unregistered** `/app/erp/cost-health` route (the page existed but was unreachable — 12B.1a's links to it 404'd) and added Cost Health + Shopify Cost Audit nav links; resolved the committed merge-conflict markers in `.gitignore` (union of both sides) and added `.shopify` + `.react-router/`; new `app/types/custom-elements.d.ts` declares the App Bridge `<s-app-nav>/<s-link>` elements, eliminating that whole pre-existing tsc error category (repo typecheck errors: 454 -> 398, zero new).
- Tests: 82 -> 97 passing (15 new in `tests/shopify-cost-audit.test.ts`: SKU/GID normalization, matcher precedence + handle + dedupe, ambiguity, cost-authority order, band delta math, exact tolerance boundaries, non-numeric statuses, CSV escaping). Pure logic lives in client-safe `app/lib/shopify-cost-audit-shared.ts` (the route component and tests import only this; the `.server` lib layers the Shopify pull + Prisma-parameterized index on top, so tests never construct Prisma against the production DATABASE_URL).
- Still not allowed / not built: any Shopify mutation, any ERP-database write from this page, any "sync cost" button (requires separate owner approval + write scope), Bulk Operations.

## Completed Milestone: Shopify Cost Audit Auth-Loop Fix (Patch 12B.2b.1)

- CORRECTION to 12B.2b: requiring `read_inventory` caused an embedded login loop in production — after `shopify app deploy`, the deployed config demanded the new scope while the installed token lacked it, so the graphql client's 401/403 handling threw a re-auth redirect on every Pull click that could never complete inside the iframe.
- `read_inventory` REMOVED from `shopify.app.toml` required scopes (no new required scope; `read_products` kept). Shopify research: InventoryItem is queryable with `read_products`; `InventoryItem.unitCost` may additionally require the staff "view product costs" granular permission — which a required scope cannot fix anyway. **Owner must run `shopify app deploy` again to publish the reverted scope list; the loop persists until that deploy.**
- Pull hardening (the mechanical anti-loop guarantee): `runProductsPage` now catches thrown redirect `Response`s from the graphql client and converts them into in-page access errors, so no redirect can ever escape the loader; field-level access denials that arrive alongside partial data now also trigger the degraded retry; if even the plain product query is denied, the page shows an error banner instead of redirecting.
- Degraded banner copy updated per owner wording: "Shopify cost/COGS access is unavailable. Inventory item cost may require product cost permission / granular Shopify permissions. Products, variants, prices, SKUs, and ERP matching still work."
- Everything else unchanged: read-only pull, no action export, no writes, no mutations, CSV/TSV export intact.

## Completed Milestone: Shopify Cost Audit Pull No Longer Escapes To Login (Patch 12B.2b.2)

- TRUE ROOT CAUSE of the persistent loop (scope revert in 12B.2b.1 was necessary but not sufficient): the Pull forms were plain lowercase `<form method="get">` elements and the CSV link was a raw `<a href>`. Those perform full document navigations inside the embedded iframe carrying only `pull=1&tolerancePct=...` — no shop/host/session-token context — so `authenticate.admin` at the top of the loader could not identify the session and rendered the login screen before any pull code (or its 12B.2b.1 hardening) ever ran.
- Fix: both pull forms are now React Router `<Form method="get">` (client-side navigation; App Bridge attaches the session token to the loader fetch — the exact pattern the Cost Calculator has used loop-free since 12B.1a). The server-side `?format=csv` path and raw CSV anchor are deleted; CSV now downloads client-side via Blob from the already-loaded rows (no navigation, no extra pull), Copy TSV unchanged. Loader returns up to 3,000 rows for export (`EXPORT_ROW_CAP`); the table renders the worst 600.
- Defense in depth: the loader's entire pull branch is wrapped in a try/catch — any escaped `Response` (301/302/303/307/308/401/403 or otherwise) or `Error` becomes the in-page banner "Shopify pull could not complete. The app stayed loaded instead of redirecting. Details: ..." (status/message only; never tokens). Combined with the 12B.2b.1 graphql-level Response catch, no redirect can leave this route from the pull path.
- Degraded cost mode unchanged: full query with `inventoryItem.unitCost` first, automatic retry without cost fields on denial, banner if even the plain product query fails.
- No scope changes this patch; still read-only end to end (no action export, no writes, no mutations).

## Completed Milestone: Shopify Cost Audit Cost-Factors Mode (Patch 12B.2b.3)

- Problem: the pull returned ~2,028 variants, mostly stock-bag configurator option combinations and other customer-facing sales variants — unauditable by a human. The page now defaults to **Cost factors only** and keeps the full audit behind explicit view modes.
- Six view modes (client-state buttons with counts): Cost factors only (default) / ERP matched / Missing Shopify cost / Ambiguous / Stock-configurator variants / All Shopify variants. The all-variant audit is preserved, not removed.
- Classification (`classifyAuditRow` in the shared lib, precedence order): (1) any SKU-level match into a cost table (VendorProduct/Material/ProductRecipe/variant rule/pricing rule) or variant-GID match to recipe/variant-rule/pricing-rule = cost factor — strongest evidence wins, so "Blank 4x5 bag" with a vendor SKU can never be buried as configurator noise; (2) configurator-only matches or stock-bag/configurator/4x5-named rows = stock/configurator noise; (3) any row with a Shopify cost = cost factor (either corroborates ERP or is a cost factor not yet entered in ERP); (4) cost-flavored text (blank/jar/bag/box/can/media/material/roll/ink/label/sticker/vendor/outsourced/pouch/tube) counts only when the row has a SKU; (5) everything else is hidden with an explicit reason: "No SKU and no Shopify cost", "Matched only by broad product mapping", or "No cost signals (customer-facing sales variant)".
- Seven summary cards: total variants pulled, cost-factor candidates, Shopify cost present, missing Shopify cost, ERP matched, ambiguous, hidden as stock/configurator noise. Page copy states the two jobs: Cost Factors mode verifies real cost inputs; All Variants mode is for storefront/configurator audits.
- CSV/TSV exports now respect the current view mode and carry three new columns (auditView / costFactorCandidate / hiddenReason); hidden rows show their reason inline in the table too.
- Tests: 97 -> 107 passing (10 new: classifier precedence incl. the Blank-4x5 protection, configurator-only and title-based noise, no-SKU hide/cost exception, Shopify-cost-without-ERP-match inclusion, broad-mapping hide, text-signal inclusion, view-mode filtering counts, summary counts).
- Still read-only end to end: no action export, no writes, no mutations, no scope changes.

## Completed Milestone: Master Audit + Nav & Safety Reorganization (Patch 13.0)

- MASTER AUDIT COMPLETED (read-only, before this patch): full inventory of every registered route, nav section, duplicate/legacy area, write surface, and cost source. Key findings now acted on or scheduled: five unregistered legacy ERP route files (recipes/setup/product-types/vendor-products/product-type-routes) plus three superseded compliance-webhook files are dead code; two routes ran Shopify mutations from their loaders on page visit; three generations of cost/pricing editors overlap (legacy ProductCost/PricingRule pages vs current Materials/Vendor Cost Book/Product Setup); the old wholesale calculator and legacy create-order duplicate current tools; dead schema (CostCalculator model, SourcedCostTier, mlPerSqft100, RecipeInkRequirement, RecipeMaterial.wastePct) awaits a migration batch.
- Nav reorganized into four groups expressed by ordering + label prefixes (the embedded flat nav has no section headers): unprefixed Daily Operations (Dashboard, Setup Wizard, Walkthrough, Quotes, Agent Review Queue, Production, Reports, Print Logs, RIP Imports, Print Intake, Cost Calculator); "Setup ·" (Product Setup, Add Product, Materials, Machines, Vendors, Vendor Cost Book); "Audit ·" (Cost Health, Shopify Cost Audit, Pricing Health, Configurator Audit); "Owner ·" (Admin Settings, Agent Security, Pricing Rules, Configurator, Configurator Sync, Manual Mapping, Jar Mapping, Shopify Links, Margin Review — Margin Review is newly linked but clearly owner-labeled; Agent Security moved from the staff area to Owner).
- Loader-mutation routes guarded: `/app/create-wholesale-discount` and `/app/create-configurator-cart-transform` (never nav-linked; URL-only) now require `?confirm=1` — without it they return a JSON warning ("Nothing was changed... re-open with ?confirm=1") and perform zero Shopify calls beyond auth; with it, behavior is exactly as before. Mutation code untouched.
- Owner-tool warning banner ("Owner / advanced tool — changes here can affect live pricing, mappings, or Shopify behavior.") added to the four highest-risk pages: Margin Review, Shopify Links, Configurator Sync, Pricing Rules. Remaining owner pages carry the nav label only; more banners can ride along with 13.1.
- STANDING RULE (owner decision): do NOT build multi-design/file groups (12B.1b), the Shopify product publisher, or any pricing-engine behavior change until cost verification is complete.
- Planned sequence: 13.1 retire/delete orphan legacy files + routes (wholesale calculator, ProductCost pages, create-order, migration report, dead compliance files) -> 13.2 Cost Verification Workbook (= 12B.2a plan) -> owner verification pass (invoices + T1-T7 known-job replays, results recorded here) -> 13.3 engine completeness (purchaseCost fallback, vendor-tier blank costing, stored-labor pricing; owner-approved, shipped together with before/after deltas) -> then preset deletion, 12B.1b, publisher track.
- Not touched in 13.0 (verified): quote/payment/production behavior, Cost Calculator math, pricing engine, Product Setup writes, api.agent.intake, schema/migrations, storefront/proxy routes; purchase/reorder reports remain unlinked as before (they were not in the nav).

## Completed Milestone: Retired Legacy Routes And Orphan Files (Patch 13.1)

- DELETED (verified unregistered and imported by nothing): the five pre-Product-Setup orphan pages `app.erp.recipes.tsx`, `app.erp.setup.tsx`, `app.erp.product-types.tsx`, `app.erp.vendor-products.tsx`, `app.erp.product-type-routes.tsx`; the three superseded compliance-webhook files `webhooks.compliance.customers-data-request.ts` / `customers-redact.ts` / `shop-redact.ts` (live compliance remains the registered `webhooks.compliance.ts` handling all three topics per the toml); and the one-time `app.erp.stock-bag-migration-report.tsx` (registration removed too — recreatable from git history if ever needed).
- REDIRECTED (registrations kept so bookmarks land on successors; loader AND action redirect so stray POSTs can never write): `/app/wholesale/calculator` -> `/app/erp/cost-calculator` (the old calculator could save duplicate quote drafts — that path is now closed); `/app/product-costs` -> `/app/erp/materials` (the `/app/erp/product-costs` shim re-exports default/loader/action from it, so the redirect module keeps all three exports and the shim inherits the redirect); `/app/create-order` -> `/app/quotes` (retirement pre-authorized by the Patch 4 milestone note; order creation is exclusively the gated Quotes / CRM flow).
- Cost Health nav links fixed: the dead "Product Type Routes" link (404 since that page was never registered) now points to Product Setup; the old wholesale "Product Cost Calculator" link removed (the ERP "Open Cost Calculator" link already exists).
- Core paths untouched (verified by scan): Quotes / CRM, Production, Product Setup, Cost Calculator, recipe pricing engine, api.agent.intake, schema/migrations, Shopify — zero edits, zero calls. The `ProductCost`/`PricingRule` tables and all other schema remain frozen until the planned migration batch.
- Side effect: deleting the orphan pages and rewriting the legacy calculator/product-costs pages removed 90 of the documented pre-existing typecheck errors (repo total 398 -> 308; zero new; net -6,502 lines of dead code).
- Next planned: 13.2 Cost Verification Workbook (the 12B.2a plan) -> owner verification pass (invoices + T1-T7 replays) -> 13.3 engine completeness (owner-approved) -> preset deletion -> 12B.1b design groups -> Shopify publisher track.

## Completed Milestone: Unconditional Legacy Redirects (Patch 13.1.1)

- Problem after 13.1 deploy: `/app/wholesale/calculator`, `/app/product-costs`, and `/app/create-order` showed the Shopify login screen instead of redirecting.
- TRUE ROOT CAUSE (not the redirect files — they contained zero auth calls): all four legacy paths were registered as CHILDREN of the `/app` layout route, and the layout's own loader calls `authenticate.admin`. On a direct visit React Router runs the parent layout loader too, so the layout's auth bounce fired before the child's redirect could matter.
- Fix: the four registrations (`app/wholesale/calculator`, `app/product-costs`, `app/erp/product-costs`, `app/create-order`) moved OUT of the `/app` layout to top-level routes — the same proven pattern as the confirm-gated create-discount/cart-transform routes. No auth runs on the legacy URLs; they redirect unconditionally, forwarding any query params (shop/host/embedded context) so the successor page authenticates in one hop. Successors then enforce auth normally.
- Redirect modules remain pure: no authenticate, no db, no Shopify, loader+action both redirect, default export kept for the product-costs shim.
- Next planned: 13.2 Cost Verification Workbook.

## Completed Milestone: Cost Verification Workbook (Patch 13.2)

- New read-only page `/app/erp/cost-verification` (nav: "Audit · Cost Verification"): the instrument for the owner's invoice verification pass. Purpose copy: "This page verifies the cost data feeding quotes, calculator, and production. It does not update prices, products, Shopify, or recipes." Zero writes, zero Shopify calls, no action export.
- Eleven sections: header warning (Shopify = helper only; seeded != proof), nine readiness cards (blank/material/ink/machine+labor/vendor tiers/RIP/known-job tests/criticals/warnings), master cost-source table (category, source, value/range, confidence, problem, verify-against, fix link), blank-item detail (per-vendor-product tier bands + MOQ), print-media detail ($/sqft + unit pair), ink detail (per-channel cost/ml + usage + fingerprint flags), finishing/prepress/packout + Shopify explanation, known-job replay checklist, and ordered next actions ending with the frozen sequence (engine completeness -> 12B.1b -> publisher).
- Provenance/confidence (no schema): `[VERIFIED yyyy-mm-dd inv#]` notes marker = Verified (outranks everything, interim convention documented on-page); value + cost history / plain notes = Manual; seed/preset notes text or fingerprint constants ($156.99/750ml Roland, $190/1000ml Mimaki, 0.0075 usage, $5/hr, 40% coverage, 15% allowance, $0.08/$0.05 overheads) = Seeded/estimated; no usable value = Missing. Machines/ink channels have no notes field, so their Verified stamps wait for the schema patch (documented on-page).
- Criticals: no-cost vendor products, purchaseCost traps, missing $/sqft, roll media without dims, enabled channels without cost/ml, machines without hourly cost. Warnings: every seeded fingerprint, non-monotonic vendor tiers (cost rising with quantity), flat-Material copies drifting outside vendor tier bands, stored-but-unpriced recipe labor, default estimating assumptions, costReviewNeeded flags, legacy PricingRule/ProductCost/SourcedCostTier rows, no RIP actuals yet.
- Known-job replay tests T1-T7 render as prefilled Cost Calculator links built in the loader from real record ids (3oz/4oz vendor items, holographic material, 4x5 bag, a tiered item for blank-only); real label dimensions are deliberately left for the owner to enter. T4 (multi-design) is a pending placeholder until 12B.1b; T7 (outsourced) routes to Product Setup's readiness price test because outsourced recipes price through the engine. Results are not stored yet - record them in this doc.
- Client-side CSV export (categories + issues + replay rows) and a print-friendly checklist button; deep links to Materials, Machines, Vendors, Vendor Cost Book, Product Setup, Cost Calculator, Cost Health, Shopify Cost Audit, Print Logs, RIP Imports. Cross-links added from Cost Health and Shopify Cost Audit (one line each).
- New client-safe lib `app/lib/cost-verification-shared.ts` (fingerprints, confidence classifier, tier sanity check, replay builder — pure and unit-tested); DB queries are bounded loader reads. Tests: 107 -> 119 passing (12 new).
- Deferred as planned: schema-backed verifiedAt/By/Source columns (migration batch), storing replay results, any engine/preset changes.

## Completed Milestone: Owner Cost Checklist Export (Patch 13.2.1)

- New "Download Owner Cost Checklist CSV" button on `/app/erp/cost-verification` (same route, no new registration; the 13.2 audit CSV remains as "Download audit CSV"). Client-side Blob download — no navigation, no writes, no Shopify.
- One row per cost fact, 15 columns: category, item name, vendor, current app cost, unit, tier min qty, tier max qty, MOQ, cost source table/model, confidence, issue/warning, verify against, fix page, OWNER STATUS (blank), OWNER NOTES (blank).
- Row groups: VendorProduct flat costs (one row each); VendorProductTier (one row PER TIER with min/max/MOQ); print media $/sqft; ink/coating materials per ml; blank-material flat copies (flagged "duplicate of vendor tiers" when a tiered vendor product shares the SKU); machine hourly rates; MachineInkChannel per-channel cost/ml with seeded-fingerprint flags; the Cost Calculator's hardcoded assumptions ($25/hr labor, $8/hr machine input, the seven ink profiles, application/cutting/prepress/packout heuristics, 10% default waste) as explicit seeded rows; plus context-only rows for recipes and legacy PricingRule/ProductCost/SourcedCostTier counts.
- Owner tier rule encoded (`tierPolicy`): Miron items (vendor MIRON or name match) are expected tiered — their tier rows carry no flag; non-Miron items WITH tiers get "Unexpected tiers — owner says only Miron should be tiered unless confirmed."; non-Miron items with no usable flat cost get "No usable flat cost — enter one via Vendor Cost Book."; a Miron item with neither tiers nor cost gets its own flag.
- Placeholder rule (`looksLikePlaceholder`): template/placeholder/sample/test (word-boundary) in name/SKU/notes, plus the 5oz jar special case (cost-only placeholder per CLAUDE.md) — issue "Possible placeholder — owner decide: delete, disable, or fill real cost." Advisory only; OWNER STATUS records the decision.
- Loader change is read-only: materials select adds `vendor`; checklist rows are assembled server-side from data already fetched.
- Tests: 119 -> 126 passing (7 new: tier policy, placeholder detection incl. word-boundary and 5oz cases, exact issue wording, exact 15-column header order, row serialization with blank owner cells, null-cell handling, assumption rows).
- Next: owner runs the checklist against invoices (Miron spreadsheet compare is planned as 13.2.2 — client-side paste-and-diff against VendorProductTier rows).

## Completed Milestone: Approved Cost Data Update Tool (Patch 13.2.2)

- FIRST WRITE FEATURE on the Cost Verification page, owner-gated: new "Approved Cost Updates (owner-only)" card at `/app/erp/cost-verification` applies the owner-approved cost truth list (2026-07-17). Nothing updates on deploy or page load — the card is a read-only preview (status per item: already correct / will update / missing record / ambiguous / manual review / do not update, with current vs approved values and exact per-tier changes) until the owner types `APPLY VERIFIED COSTS` and presses Apply.
- Apply safety: the action re-evaluates matching server-side (never trusts the client), requires the exact phrase, and updates ONLY unambiguously matched `VendorProduct` + `VendorProductTier` rows in one transaction. Matching is exact vendorSku first, then a unique anchored name match with template records (`Template|Outsourced|Stock Bag` names) excluded so e.g. "Template - 4x5 Outsourced Stock Bag" can never be mistaken for the real 4x5 blank bag. Zero Shopify, quote, production, recipe, engine, or schema writes.
- Approved truth encoded in `app/lib/approved-cost-updates.server.ts`: five Miron jars tiered (jar + normal SAN lid; **only 100ml tall differs from seeded data**: 2.86/2.63/2.41/2.22/2.07 -> 2.78/2.54/2.31/2.14/1.99); SAFECARE jars flat (0.50/0.62/0.60/0.65; 5oz 0.60 as cost-only placeholder, quote status untouched); blank bags flat (4x5 0.09, 4x6 0.10, 14x16/pound 1.00); DTP 4x5x2 pouch tiered (0.7138/0.4744/0.4029/0.3458/0.3117). Do-not-update: DTP 4x6x2 pouch (no pricing yet), Miron black metal lids (future optional add-on, never default). Manual review: both Template placeholder items.
- Verified markers appended to VendorProduct notes on apply (`[VERIFIED 2026-07-17 owner-approved ...]` per group); tier rows get "Owner-approved 2026-07-17" notes. Flat items with a single all-range tier row have that row updated in place; a flat-approved item with MULTIPLE tiers is demoted to manual review instead of silently flattened. Missing records (likely the bags and DTP pouch) are NOT auto-created in this patch — they show "missing record — manual create/review" and should be entered via the Vendor Cost Book, after which the preview will pick them up for marker/cost alignment.
- Tests: 126 -> 132 passing (6 new: exact confirmation phrase, pinned truth numbers incl. the 100ml-tall correction and DTP table, sku-then-name matching, template exclusion, ambiguous/missing behavior, 100ml-tall drift detection with change summaries and 50ml no-op proof).
- After the owner applies: re-download the Owner Cost Checklist to confirm Miron rows show Verified; then the T1-T7 replays become meaningful against verified data.

## Completed Milestone: Blank Bag + DTP Cost Records (Patch 13.2.3)

- Extends the 13.2.2 Approved Cost Updates tool with a "Will create" path: when an approved blank item has NO clean matching record, apply now CREATES the VendorProduct (same phrase gate `APPLY VERIFIED COSTS`, same server-side re-evaluation, same single transaction; nothing runs on deploy or page load).
- Creation is limited to the four owner-approved blanks with explicit creation specs: "4x5 Blank Bag" ($0.09 flat), "4x6 Blank Bag" ($0.10 flat), "14x16 Blank Bag" ($1.00 flat), "DTP 4x5x2 Blank Pouch" (tiered 1000-2499 $0.7138 / 2500-4999 $0.4744 / 5000-7499 $0.4029 / 7500-9999 $0.3458 / 10000+ $0.3117). Field shape proven safe by the Vendor Cost Book push + jar seed: shop/name/productType/vendor/vendorSku/moq(1)/defaultUnitCost/active/notes (+ nested tier rows for the pouch). Vendor is "Vendor TBD" per owner instruction (no real vendor guessed); productTypes use existing conventions ("bag", "dtp_bag").
- FLAT-VS-TIER DOCUMENTATION (rule I): the app does NOT require one-row tiers for flat items — calculator, Shopify Cost Audit, and the outsourced engine path all fall back to `defaultUnitCost` when no tiers exist, so the bags are created genuinely flat with zero tier rows. (Existing records that already have a single all-range tier row keep it, updated in place — 13.2.2 behavior.)
- Created vendorSkus reuse the calculator preset ids (`preset:blank-4x5-bag`, `preset:blank-4x6-bag`, `preset:pound-bag`, `preset:dtp-4x5x2-pouch`), so the stale hardcoded calculator presets for the 4x5 and pound bags auto-hide the moment the records exist (12B.1a supersede rule) — two more code presets retire themselves.
- Rules preserved: match by exact vendorSku then unique anchored name; one clean record with a blank cost is UPDATED not duplicated; ambiguous = no action; template/placeholder names are excluded from matching and stay manual review; DTP 4x6x2 stays do_not_update (no pricing, not activated, not verified); Miron/SAFECARE items have no creation specs (if somehow missing they stay missing_record). Verified markers appended on create/update.
- Tests: 132 -> 139 passing (7 new via the exported `evaluateApprovedItem`: pinned creation specs incl. Vendor TBD + preset SKUs, will_create for flat bag and tiered pouch, missing_record without a spec, blank-cost record updated not duplicated, template stays manual review, 4x6x2 stays do_not_update).
- After the owner applies: bags + pouch exist verified; the Owner Cost Checklist shows them; T3 (sticker bags) and blank-item replay tests become meaningful; remaining cost blockers shift to ink/machine/labor verification.

## Completed Milestone: Roll Material + Ink Cost Verification (Patch 13.2.4)

- Extends the Approved Cost Updates tool to two new record families with the same gate (preview-only on load, exact `APPLY VERIFIED COSTS` phrase, server-side re-evaluation, one transaction): Material rows and MachineInkChannel rows. Raw material costs only — waste, labor, machine speed, gloss layers, setup, and ink-usage profiles remain separate factors and are untouched.
- Roll materials (unique name match, template-excluded, full-precision values stored, never pre-rounded): Poseidon matte 213/675 = $0.3156/sqft (54in x 150ft), Poseidon gloss same, Holographic 488/683.33 = $0.7141/sqft (50in x 164ft), Banner Vinyl 140/472.5 = $0.2963/sqft (54in x 105ft). Updates set purchaseCost + roll dims + calculatedUnitCost + costPerUnit (Materials-page convention), clear costReviewNeeded, append the `[VERIFIED 2026-07-17 owner-approved roll/ink cost]` marker, and write a MaterialCostHistory row (old -> new, reason "Owner-approved roll cost (13.2.4)").
- Banner Vinyl is the only material creation (field shape proven by the Materials page create path): name "Banner Vinyl", type "banner", sqft base, roll purchase, vendor "Vendor TBD".
- Ink materials use BRAND-GROUP matching (`material_group`): every non-template ink material row matching /mimaki/ or /roland|lg-540|eco-uv/ updates to the approved per-ml cost (Mimaki 176/1000 = $0.1760/ml; Roland 149/750 = $0.19867/ml) — works whether the DB has per-type rows or one combined row per brand. Zero rows = missing_record; ink materials are never created (machine channels are the engine's source).
- Machine ink channels (`ink_channels` group per brand): all ENABLED CMYK/White/Gloss(Clear-named) channels of the single matching machine update costPerMl + cartridgeCost/Ml (Mimaki $176/1000ml, Roland $149/750ml); disabled and 'other' slots are skipped; two machines matching one brand = ambiguous, nothing updates. Channels have no notes field — the verified marker for them waits for the schema patch (shown as a note).
- `evaluateApprovedItem` now takes an EvalContext {vendorProducts, materials, machines}; vendor-product behavior (13.2.2/13.2.3) is unchanged.
- Tests: 139 -> 147 passing (8 new: full-precision cost pins incl. 213/675 exactness, Poseidon 0.2889 -> will_update with purchase details, already-correct roll with marker, Banner-Vinyl-only creation, ink group handling both row layouts, zero-row group = missing, Mimaki channel drift with disabled-slot exclusion, two-Roland ambiguity).
- After the owner applies: rolls + ink verified; remaining seeded-cost warnings shrink to machine hourly rate, labor/application heuristics, usage-rate calibration (13A), and sell-tier re-derivation via the T1-T7 replays.

## Completed Milestone: Warning Cleanup + Known Job Replay Prep (Patch 13.2.5)

- Reporting-only patch: no cost data changed, no new apply/write behavior, no schema. Cleans the Cost Verification workbook's false-positive warnings and rebuilds the replay section as the owner's seven-slot prep sheet.
- Warning cleanup (checklist builder + shared `tierPolicy`): (1) DTP 4x5x2 is now in the expected-tiered policy alongside Miron — its approved tier rows no longer flag "Unexpected tiers" (DTP 4x6x2 stays expected-flat); (2) a `[VERIFIED ...]` marker suppresses the unexpected-tiers warning entirely — verification IS the owner confirmation the warning asks for; (3) one-row tiers (the app's flat-storage convention, e.g. seeded SAFECARE jars) downgrade to the informational `SINGLE_TIER_FLAT_NOTE`, and even that disappears once the record is verified.
- Warnings intentionally KEPT: truly unexpected multi-tier non-approved items, DTP 4x6x2 unverified/do-not-update, both Template placeholders (manual review), seeded ink-usage-per-sqft assumptions (raw $/ml is verified; usage is NOT), the $5-vs-$8 machine hourly conflict (no value picked yet), estimated labor/application timing heuristics, non-monotonic tier sanity check, flat-Material-copy drift vs vendor tiers (true positive after the Miron 100ml-tall correction), and known-job replay 0/7.
- New "Remaining calibration work" section near the top: verified list (jars, blank bags, DTP 4x5x2 tiers, roll media at 0.3156/0.3156/0.7141/0.2963 per sqft, ink at 0.1760/0.1987 per ml) vs still-needs list (ink usage per sqft -> 13A, machine hourly rate, print speed/setup, labor/application timing, replay 0/7).
- "Known Job Replay Prep" rebuilt to the owner's seven slots: T1 600x3oz jar labels, T2 600x4oz, T3 1000x4x5 sticker bags, T4 DTP 4x5x2 pouch tier test (prefilled at 2,500 -> must price $0.4744; re-run at boundaries), T5 banner vinyl (real-size math check vs $0.2963/sqft), T6 heavy-white ink job (usage calibration vs verified $0.176/ml), T7 spot-gloss multi-layer (usage + speed). Each slot shows the 12 record fields (job name, quantity, product/material, label/art sqft, finish, estimated app cost, actual material, actual ink/RIP, actual labor min, actual machine min, variance, owner notes) as read-only fill-in boxes — results are recorded on a printout or in this doc until a schema-backed replay log is approved. Prefill links resolve live record ids; T6/T7 always link (profile-only).
- Tests: 147 -> 151 passing (rewritten replay suite for the new slots incl. prefill/degrade/12-field template cases + tier-policy DTP case + single-tier note wording + verified-DTP already-correct proof).

## Completed Milestone: Labor Standards Foundation (Patch 13A.1)

- Reporting/foundation only: owner-approved labor standards added to the Cost Verification workbook and Owner Cost Checklist CSV. NO data writes, no new apply workflow, no calculator math, engine, quote, production, or schema changes — the calculator still uses its old code heuristics until a separate approved wiring patch.
- Standards recorded FULL PRECISION in `LABOR_STANDARDS` (`app/lib/cost-verification-shared.ts`), owner-approved 2026-07-17:
  - Art setup $25/hr ÷ 3 designs/hr = $8.3333/design; Print setup $25/hr ÷ 25 = $1.00/design; Cut setup included in art setup ($0 extra).
  - Cutting = MACHINE-based (printer/cutter, not hand labor): 25 cm/s setting, conservative 12.5 cm/s effective estimate; cost basis will be cutter time later, not wired yet.
  - Weeding $20/hr ÷ 15 sheets/hr = $1.3333 per 54x54 sheet; Jar application $20/hr ÷ 100 = $0.20/jar; 4x5 bag application $20/hr ÷ 180 = $0.1111/side (front+back $0.2222/bag); 14x16 bag application $20/hr ÷ 20 = $1.00/side (front+back $2.00/bag); Packout $20/hr ÷ 10 = $2.00 per packout unit/order box.
  - Gloss/white setup $25/hr ÷ 3 = $8.3333/setup — setup LABOR only; white/gloss ink usage profiles unchanged.
- New "Labor Standards" section on `/app/erp/cost-verification`: hand-labor table (task, hourly, min speed, basis, calculated unit cost, "Verified / Owner-approved standard" badge, notes), a separate machine-based cutting block, and the framing line "Labor is owner-standard based. Ink, media, print time, and cut time will come from RIP/machine actuals later."
- Remaining Calibration Work now leads with "Labor standards entered / owner-approved — but NOT wired into the calculator yet, and still need actual job replay validation"; Known Job Replay Prep references the standards for hand-checking labor lines (differences vs the calculator's old heuristics are expected and worth recording).
- Owner Cost Checklist CSV: ten new "Labor standard (owner-approved)" rows (cost, unit basis, source shows the hourly÷speed derivation and the not-wired caveat; hand tasks show the new "Verified / Owner-approved standard" confidence, machine cutting shows n/a; notes carry the cut-setup-included, machine-based-cutting, and labor-only-gloss caveats). No existing rows removed.
- Tests: 151 -> 156 passing (5 new: ten-task inventory, full-precision unit-cost pins, cut-setup/cutting machine rules, gloss-labor-only wording, owner_standard CSV label).
- Next wiring decision (owner-approved patch later): replace the calculator's hardcoded application/cutting/prepress/packout heuristics with these standards, then validate via T1-T7 replays.

## Completed Milestone: Calculator Labor Wiring Preview (Patch 13A.2)

- Read-only preview comparing the calculator's CURRENT hardcoded labor rules against the 13A.1 owner standards — the calculator's live output is deliberately unchanged (verified: only a static note added to its estimate panel). No writes, no apply workflow, no engine/quote/production/schema changes.
- Current rules are MIRRORED exactly, never guessed (`CURRENT_CALC_LABOR` in the shared lib documents the source functions in app.erp.cost-calculator.tsx): $25/hr, jar 10s + 10 min setup, bag 10s/side + 5 min setup, prepress basic 15 min, gloss/white setup $0. The future wiring patch replaces the calculator's rules and deletes this mirror; a test pins the mirror so drift is caught.
- Rule-by-rule table: five comparable rules (jar app ~2.9x higher under the standard, 4x5 bag/side, 14x16 bag ~9.6x higher, design setup $6.25/job -> $9.3333/DESIGN, gloss/white setup $0 -> $8.3333) and three "needs calculator wiring review" rows where the bases differ and are never silently converted: Cutting (hand labor vs cutter time at 12.5 cm/s effective), Weeding (per unit vs per 54x54 sheet), Packout (per product unit vs per order box).
- Sample scenarios (labor portion only; media/ink/machine untouched): T1/T2 600 jar labels current $52.08 -> owner $129.33 (+$77.25, +148.3%; application alone 600 x $0.20 = $120.00); T3 1,000 4x5 bags front-only -> application $111.11; T3b front+back -> $222.22; T5 banner (setup-only change $6.25 -> $9.33); T7 gloss test adds the $8.33 gloss/white setup labor the live calculator charges nothing for (ink usage unchanged). Scary jumps shown deliberately.
- Staff readiness summary added: raw costs verified; labor standards verified; labor NOT live in calculator (estimates generally under-charge labor vs standards); RIP actual automation not built; normal jobs staff-estimable with owner review; complex white/gloss/heavy-coverage jobs still owner-review-only.
- Cost Calculator got a single static read-only note under the estimate: "Owner labor standards preview is available in Cost Verification. Current estimate still uses existing calculator labor rules." No output, math, submit, or field changes.
- Owner Cost Checklist CSV: new context row "Labor Wiring Preview (13A.2) — preview exists but is NOT live"; the 13A.1 labor-standard rows and the hardcoded-heuristics assumption rows remain.
- Tests: 156 -> 162 passing (6 new: mirror pins, T1 exact math incl. +148.3%, T3/T3b $111.11/$222.22, T7 gloss-setup-only, needs-wiring-review task list, scenario set coverage).
- Next: owner reviews the preview numbers, then approves the actual wiring patch (calculator labor rules replaced by the standards, mirror deleted, T1-T7 replays re-run as validation).

## Completed Milestone: Owner Labor Standards Wired Into Cost Calculator (Patch 13A.3)

- FIRST ESTIMATE-CHANGING labor patch, scoped strictly to the Cost Calculator path. Owner-approved standards are LIVE for comparable lines; quote/pricing-engine impact = ZERO, proven by the import graph: the new helpers live in `cost-calculator.server.ts` as NEW exports only, and that lib is imported solely by the calculator route, the Cost Verification workbook, and the read-only Shopify Cost Audit — quotes price through `recipe-pricing.server.ts`, untouched.
- WIRED (all-in per-unit dollar rates replace seconds x $25/hr; no separate application setup minutes): jar application $0.20/app (all apply-jar items incl. Miron/SAFECARE/soda can); 4x5 bag $0.1111/side; 14x16/pound bag $1.00/side (sides = label lines, so front+back = 2 lines doubles it); design setup — every preset prepress mode now charges art $8.3333 + print $1.00 = $9.3333 per design (1 design default; cut setup included per the standard; "custom" remains a user override; "none" remains $0; old prepressRule deleted); gloss/white setup $8.3333 once per job whenever any line prints white/gloss (estimated profile or actual RIP white/clear ink) — LABOR ONLY, ink usage profiles untouched, shown as its own estimate line.
- NOT wired (kept on previous calculator rules with review-needed notes, per owner instruction — no safe basis exists): cutting (no cut-length/machine-time model; 12.5 cm/s effective estimate recorded for later), weeding (per-unit seconds vs per-54x54-sheet basis), packout (per-product-unit vs per-order-box basis). Also legacy by design: oz/generic bags without a size signal, boxes, tubes, label sets (no owner standard given — never guessed).
- Calculator UI: v2.1 header; green "owner labor standards are now live for comparable labor lines" note (replacing the 13A.2 preview note) that also names cutting/weeding/packout as under review; estimate table shows "Application labor (owner standard): N apps x $rate/app" and a dedicated "Gloss/white setup (labor only)" row; line breakdown and shared-costs sections show the per-app rates so the owner can see labor changed.
- Cost Verification updates: the 13A.2 preview section is now the green "comparable standards are LIVE (13A.3)" historical before/after record (previous-vs-live columns, LIVE badges; review rows unchanged); Remaining Calibration says labor is partially live; staff readiness updated (comparable labor ✅ live, cutting/weeding/packout ⚠️ review); Labor Standards section notes which rows are live; Owner Cost Checklist context row updated to the live wording and the assumption rows note what was replaced. Labor standard rows remain Verified.
- Estimate impact (as previewed in 13A.2, now real): 600 jar labels labor $52.08 -> $129.33; 1,000 4x5 bags front-only application $111.11, front+back $222.22; white/gloss jobs gain the $8.33 setup line. Raw material/ink/vendor data, ink usage profiles, RIP logic, and Shopify untouched.
- Tests: 162 -> 167 passing (5 new in the calculator suite: WIRED_LABOR pins, mode/item rate mapping incl. oz-bag/box/label-set legacy nulls, the 120/111.11/222.22 scenario math, design-setup preset/none/custom behavior, gloss/white apply logic; verification suite updated in place: five rules assert LIVE-since-13A.3, review trio unchanged).
- Next: run the T1-T7 replays against the live standards, record results here, then decide cutting/weeding/packout wiring and the engine-completeness patch.

## Completed Milestone: RIP Actual Cost Automation Audit + Plan (Patch 13A.4)

- Docs-only audit patch: full plan in `docs/GSO_RIP_ACTUAL_COST_AUTOMATION_PLAN.md`. Zero app-code changes, zero writes, zero Shopify.
- HEADLINE FINDING: the automation substrate largely EXISTS. `PrintLogEntry` already stores machine, media, sqft, per-channel ink ml (cmyk/white/gloss), print minutes, timestamps, and nullable `productionJobId`/`productionJobItemId` links; `api/rip-imports/upload` ALREADY matches RIP rows to `ProductionJob.jobTicket` and tracks matched/unmatched counts; `ProductionJobItem` carries `ripJobName` + `costSnapshot`/`priceSnapshot` (the stored estimate for variance); `ProductionJob` has a full manual actual-cost block; `ProductionMaterialUsage` already allows `source: "print_log"`; the intake watcher already embeds ticket + ROUTE (machine) into RIP filenames via a config-driven hot-folder map. In-app actual ink DOLLARS are computed nowhere yet but are now exactly computable (verified 13.2.4 $/ml x channel ml) with no schema.
- Phased plan (no schema until 13A.8): 13A.5 read-only Actual Cost Dashboard (ink/media/machine-time $ per matched row + per-ticket rollups); 13A.6 matching hardening (re-match + ripJobName secondary key + unmatched review, gated writes to existing link columns); 13A.7 estimated-vs-actual variance report (gated "pull actuals" writing ProductionMaterialUsage print_log rows + ProductionJob actual fields; $ and % variance, margin vs margin); 13A.8 calibration recommendations with owner APPLY-phrase approval (observed ml/sqft vs seeded 0.0075 and the $/sqft profiles; small schema for snapshots); 13A.9 Roland/Mimaki routing warnings.
- MACHINE ROUTING RULE recorded (documentation only, no behavior change): ROLAND tag -> Roland LG-540; no tag -> Mimaki UCJV300-130; Mimaki treated as CMYK-only for routing/pricing; white/gloss without the ROLAND tag warns (later blocks). The watcher config's routes[].match already supports this; finish-presets already encode preferredMachine per finish.
- Shop-computer collection list recorded in the plan doc: VersaWorks job-log CSV sample + hot folder, RasterLink job result files + per-channel confirmation, the off-repo NAS sync script `gso-sync-quote-rip-results-to-app.ps1` (its ink $/ml constant must be recorded and the script committed to tools/), intake watcher config, cutter log existence check.
- Owner principles pinned: initial quotes stay conservative; actuals flow automatically post-print; the app recommends calibrations but NEVER changes pricing assumptions without owner approval.

## Completed Milestone: Read-Only Actual Cost Dashboard (Patch 13A.5)

- New read-only page `/app/erp/actual-costs` (registered + nav "Audit · Actual Costs"): turns existing PrintLogEntry rows into actual dollars. No action export, zero writes, no Shopify, no calculator/engine/production changes.
- Ink cost is computed from the VERIFIED database channel costs (13.2.4), never hardcoded: per-brand CMYK/white/gloss $/ml built from Machine ink channels; machine attribution by log machine name -> RIP software (VersaWorks=Roland, RasterLink=Mimaki) -> the ROUTE token the intake watcher embeds in job names. Unattributable rows get a loud warning and a null ink cost — nothing is guessed. Channel-split-unknown rows price total ml at the CMYK rate with an explicit note.
- Machine time cost shown at BOTH $5/hr and $8/hr (owner has not picked; formula minutes/60 x rate). Summary cards: production row count, matched/unmatched, date range, total ink ml, calculated ink cost (marked partial when any row was uncostable), print minutes, both machine costs, GSOQ count, and the channel rates in use.
- Per-row table (latest 200 of up to 500): date, machine, RIP job/ticket, media (+ display-only Material name-match with $/sqft and possible media cost — unique match only; ambiguous/none warn; NOTHING persisted), sqft, minutes, CMYK/white/gloss/total ml, ink cost, both machine costs, match status badge (matched / potentially matchable / quote-rip / missing ticket), warnings.
- Per-ticket rollup for matched + potentially-matchable rows: totals, partial-ink flag, machines/media seen with multiple-machine and multiple-media warnings, production job info (customer/status/quoteId) with a Production link.
- Warnings implemented per spec: no channel cost, media unmatched/ambiguous, no ticket match, missing minutes, missing ink ml, multi-machine/media per ticket, and the ROUTING warning for white/gloss ink on Mimaki (business rule: Mimaki is CMYK-only; warn-only in 13A.5, documented in a banner with the ROLAND-tag rule).
- GSOQ quote-time results shown in their own section (file, date, cc, RIP seconds, NAS-computed ink $) with the explanation that they are quote-time pricing inputs, priced by the off-repo NAS constant, distinct from production actuals.
- New pure lib `app/lib/rip-actual-costs.server.ts` (data passed as params) with client-safe constants split into `rip-actual-costs-shared.ts` (the component imports rates/status labels there — same server-bundle pattern as the other dashboards). Tests: 167 -> 177 passing (10 new: brand rates from channels, attribution chain, ink/machine cost math at both rates, no-attribution null + warning, missing-channel exclusion warning, Mimaki white/gloss routing flag, missing ml/minutes warnings, match statuses, media unique/ambiguous/none, ticket rollup with multi-machine/media flags).
- Next per the 13A.4 plan: 13A.6 matching hardening (gated), 13A.7 estimated-vs-actual variance, 13A.8 owner-approved calibration, 13A.9 routing enforcement — plus the shop-computer collection list (VersaWorks/RasterLink samples, NAS sync script).

## Completed Milestone: RasterLink Parser + Safe Upload Integration (Patch 13A.6A)

- `api/rip-imports/upload` now imports RasterLink result CSVs: KEY_* header sniffing routes them to a dedicated branch; the VersaWorks parser path is byte-identical (its code was not modified, only wrapped). New pure module `app/lib/rasterlink-parse.server.ts` (no Prisma/network).
- Validated ink conversion pinned by tests (owner-confirmed): JobInfo codes 1/2/3/4 = C/M/Y/K, raw value / 1000 = cc per arranged item; the confirmed example (C 0.067, M 0.070, Y 0.014, K 0.017; per-item 0.168 cc x 40 arranged = 6.72 cc) imports with `inkBasis: "rasterlink_rounded_per_item_estimate"` — a rounded per-item estimate, NEVER represented as exact measured ink (RasterLink's internal UI total is higher precision, e.g. 7.005 vs 6.72). Individual channels, per-item values, arrange count (and an arrangeAssumed flag when missing) are preserved in rawRow. Repeated W/Cl channels are summed.
- Semantics guarded: blank KEY_INKUSE imports with `inkBasis: "missing_inkuse"` (never zero-faked — the dashboard's missing-ink warning fires); RIP duration NEVER populates printMinutes (print timestamps only; RIP times/minutes recorded in rawRow with `timingBasis`); print and cut rows are distinct entries (`status` = `print:<result>` / `cut:<result>`; cut/vec timestamps + minutes live in rawRow until the schema batch adds cut fields).
- Conservative matching: `decideMatch` attaches ONLY on exactly one `ProductionJob.jobTicket` hit; zero = unmatched; two+ = unmatched with `matchFlag: "ambiguous_ticket_needs_review"` in rawRow — never the silent first match. Ticket extraction understands watcher-renamed files (first underscore segment) with the legacy greedy pattern as fallback.
- Duplicate protection, no schema: file-level (sha256 content marker stored in `PrintLogImport.notes`, exact fileName + marker startsWith match, PROCESSED imports only so crashed partial imports can be retried) + row-level (natural-key findFirst on plain queryable columns: shop + printerSoftware "rasterlink" + sourceJobName + status + startedAt/completedAt, with inkMl joining the key when both timestamps are blank). A forensic resultKey hash is stored inside rawRow but never queried (per the no-rawRow-query rule).
- Imported rows surface automatically through the existing 13A.5 Actual Cost Dashboard (printerSoftware "rasterlink" attributes to Mimaki). No calculator, engine, quote, production, dashboard-logic, or schema changes.
- Tests: 177 -> 195 passing (18 new: header detection incl. VersaWorks non-match, the confirmed CMYK example, JobInfo converter, repeated W/Cl summing, blank-INKUSE presence, the 6.72 estimate row with flags, RIP-only timing, cut-only rows, arrange-assumed flag, natural-key equality/divergence, blank-time ink-key case, file hashing, zero/one/many matching, ticket extraction). The endpoint's 2 pre-existing tsc errors (untouched VersaWorks union access) remain; zero new (stash-verified).
- Deferred to 13A.6B+: the Windows watcher script, JobInfo.ini blank-INKUSE fallback wiring, ambiguous/unmatched review UI, re-match tooling.

## Completed Milestone: Automatic RasterLink Watcher + Import Audit Reliability (Patch 13A.6B)

- New `tools/gso-rasterlink-sync.ps1` (~330 lines, Windows PowerShell 5.1 compatible — saved UTF-8 WITH BOM, ASCII-only after an em-dash/ANSI-decode parse failure was diagnosed and fixed) + `tools/gso-rasterlink-sync-config.example.json`. The watcher polls the NAS `rasterlink\incoming` folder and uploads CSVs to the existing token-authenticated `/api/rip-imports/upload` endpoint — no new endpoint, no new auth.
- Modes: default poll loop (PollSeconds), `-Once` single pass, `-DryRun` (logs `would_upload`, moves/uploads nothing), `-Health` (config echo with masked token, reach+write probes on all four folders, GET endpoint probe, side-effect-free POST token probe: 400 = token valid, 401/403 = rejected — token validated before file so no import is ever created), `-SelfTest` (13 offline assertions: duplicate/success response recognition, collision naming determinism, claim acquire/refuse/stale-reclaim/release, sidecar shape, token masking — all pass under 5.1).
- Reliability design: atomic claim files (`<file>.gsoclaim` via CreateNew, SMB-safe; `ClaimStaleMinutes` 30 reclaim) so two watcher instances never double-process; stability wait (`StableFileSeconds` + size/mtime recheck) so half-written RIP exports are not uploaded; retries with stepped backoff (`RetryDelaySeconds x attempt`) for 5xx/network; 401/403 = `fatal_config` (file stays in incoming, exit 2 — bad token never quarantines good files); other 4xx (except 429) = terminal → error folder + `<name>.error.json` sidecar (originalFileName, timestampUtc, retryCount, httpStatus, serverResponse truncated, exception, scriptVersion); success AND server-reported duplicate → processed folder; name collisions resolved with a deterministic content-hash `-<sha8>` suffix. Daily UTC log files; the token is never written to any log (masked as length + first 4 chars).
- Server audit metadata (only change to the upload route — response/notes fields, zero logic changes): RasterLink import notes now end `parseWarnings:<n> outcome:processed`, and the response adds `fileHash` (the sha256 marker), `parseWarnings`, `outcome`. New pure helper `parseWarningCount` in `rasterlink-parse.server.ts` counts rows with `missing_inkuse`, `arrangeAssumed`, or RIP-only timing — so the watcher's log line per file is a complete audit record.
- Setup documentation card added to `/app/erp/print-log-settings` (JSX-only): token location, config file steps, `-Health` / `-Once` / `-DryRun` testing sequence, `schtasks /Create ... /SC ONSTART` install, NAS account permission notes.
- Validation: script parses with 0 errors and `-SelfTest` passes 13/13 under Windows PowerShell 5.1; config validation rejects missing keys; `-Health` verified against scratch folders (graceful INCONCLUSIVE on unreachable endpoint); live fixture test: `-DryRun` leaves the file untouched, real run against an unreachable endpoint produced attempt 1 → `retry_scheduled` → attempt 2 → `moved_to_error` + complete sidecar + claim cleanup. `npm run build` clean; tests 195 -> 196 (new `parseWarningCount` coverage); tsc total 308 = baseline, and a stash round-trip proved the 12 errors matching the touched files are byte-identical pre-existing ones (the 2 upload-route errors only shifted line numbers). Safety scan: no schema/migration diff, no Shopify calls, no new Prisma write verbs, protected cost/quote/pricing files untouched, token never logged.
- Deferred to 13A.6C+: unmatched/ambiguous review + re-match UI, JobInfo.ini blank-INKUSE fallback wiring, machine routing enforcement (13A.9 — the ROLAND-tag rule stays documentation-only).

## Completed Milestone: RIP Import Review + Safe Rematching UI (Patch 13A.6C)

- New page `/app/erp/rip-import-review` (registered in routes.ts under the /app layout; nav link after RIP Imports; cross-links from Actual Costs and Print Log Settings). Shows unmatched / ambiguous / attached PrintLogEntry rows from BOTH RasterLink and VersaWorks with: source, import filename, source job filename, extracted ticket, result/status, software, machine, media, ink ml, print minutes, started/completed stamps, RIP/cut/vector timing details from rawRow, parser warnings (missing KEY_INKUSE, assumed arrange, RIP-only timing, ambiguity, missing ticket), import date, and the current attachment.
- Filters: status (default "unresolved" = unmatched + ambiguous), source (rasterlink/versaworks/other), window (7/30/90/365/all days), free-text search (file/ticket/machine/media), warnings-only. Filtering + ambiguity classification run in memory over a bounded fetch (400 rows, page size 50, prev/next links) — deliberate, because ambiguity lives in rawRow JSON (no-rawRow-SQL rule) and `contains` search differs between SQLite dev and Postgres prod.
- **No schema change.** Mutations write EXACTLY two PrintLogEntry columns — `productionJobId` and `rawRow` — plus a ProductionJobEvent audit row (`print_log_manual_match` / `print_log_manual_unmatch`, createdBy "rip-import-review", the established convention). Ink, timing, sourceJobName, jobTicket, and import linkage are immutable by construction (`buildEntryUpdate` returns only those two keys; pinned by test).
- rawRow audit: reserved `rematchAudit` key appended to the parsed JSON without touching any parser value; entries record action attach/detach, previousProductionJobId, newProductionJobId, ISO timestamp, method "manual_review", shop, via "rip-import-review"; history capped at 20 (oldest dropped). Unparseable/legacy rawRow text is preserved VERBATIM inside `{_originalRawRowText, _originalRawRowParseFailed:true, rematchAudit}` — no byte of parser output is ever lost.
- Safety: explicit confirm checkbox enforced server-side (`confirm=yes`); stale writes rejected by expected-value comparison (PrintLogEntry has no updatedAt — the form round-trips the productionJobId the operator saw); every entry/job lookup is shop-scoped `findFirst({id, shop})` so cross-shop IDs simply never resolve; unmatch requires the row to actually be attached. Bulk attach: server re-verifies every checked row is unresolved AND all share one exact source job name or one exact ticket, runs in a single $transaction, and rejects the whole batch otherwise — no blind bulk, no partial writes.
- Candidate suggestions (never auto-saved, confidence-labeled): exact ticket match first (bounded IN query on visible-page tickets), then ProductionJobItem.ripJobName similarity (the planned secondary key, suggestion-only), then job-ticket-inside-source-name similarity; two+ exact hits are all listed and stay unresolved until the operator confirms one. Manual dropdown shows ticket | customer | status | created date for every job before confirming.
- VersaWorks rows appear in the same list with a visible note that their import-time matching (silent first-`contains` match, no ambiguity detection, in api.rip-imports.upload legacy branch / rip-imports / print-logs) is weaker than RasterLink's — parser hardening deferred to 13A.6D. The old print-logs `matchEntry` mini-UI is untouched (working route) but the review page is the safe path (it does not overwrite jobTicket like matchEntry does).
- Import summaries on the page expose ONLY structured counters parsed from notes (rows/created/duplicatesSkipped/matched/ambiguous/parseWarnings), an 8-char hash prefix, and outcome — raw notes text and the upload token are never sent to the client.
- Files: new `app/lib/rip-import-review.server.ts` (pure logic: classify/filter/paginate/rank/validate/audit — no Prisma, tests import directly), `app/lib/rip-import-review-shared.ts` (client-safe labels, same server-bundle split pattern), `app/routes/app.erp.rip-import-review.tsx`, `tests/rip-import-review.test.ts`; edits: routes.ts, app.tsx (nav), actual-costs (link + warning text now points here), print-log-settings (review button).
- Validation: tests 196 -> 220 (24 new covering all required areas: unmatched/ambiguous listing, attached rows leaving the unresolved filter, VersaWorks rows + source filter, search/warnings filters, pagination bounds, shop-scoped where builders, cross-shop rejection, exact one-job rematch, missing/stale row rejection, confirm-flag rejection, unmatch + its stale/not-attached rejections, update-payload key pinning, audit append/preserve/verbatim-wrap/20-cap, suggestion ranking + labels + two-exact-listed + none, bulk eligibility, import-summary token safety, warnings extraction). Build clean; tsc 308 = baseline with 0 errors in every new/edited file; route verified in client manifest + server bundle; safety scan: no schema diff, no Shopify calls, writes limited to printLogEntry.update + productionJobEvent.create, RR Form/Link only, watcher/parser/upload endpoint untouched.

## Product Builder / Product Setup Scope

Current ERP/Product Builder priority:

- blank jars
- stickers / die cut stickers / regular stickers
- banners
- custom/other as safe catch-all

Stock bag configurator remains separate.
Do not build label-only/application options for 4x5 bags unless explicitly requested.

## Intentionally Deferred

- per-IP intake throttling (needs an ipHash index migration; 10B candidate)
- real production agent credentials (now unblocked: issue via Agent Security page)
- mockup/approval package workflow
- customer-facing quote sending

## Next Major Phase

Candidate tracks, sequencing to be confirmed with the owner:

- Agent platform hardening (aligned roadmap Patch 11): credential management UI, intake rate limiting + lockouts, idempotency unique constraint, submission-log viewer — prerequisite for onboarding real external sales/marketing agents.
- Tier-aware pricing activation (explicit owner approval per change): per-tier floor adjustments (one-line registry diffs), tier-scoped Shopify tag/pricing-rule mapping, function-config sync.
- Longer-term: CustomerProfile model once quote-level tiers prove out (backfill/dedupe strategy required).

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
