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

## Completed Milestone: VersaWorks Import Hardening (Patch 13A.6D)

- The upload endpoint's VersaWorks path now has the same safety standard as RasterLink. New pure module `app/lib/versaworks-parse.server.ts` (no Prisma/network; 25 tests import it directly) + a hardened branch inserted in `api/rip-imports/upload` with **zero deletions** — the legacy path remains byte-identical for non-CSV placeholder uploads and unknown CSV shapes, so no supported format was narrowed.
- Format detection: `looksLikeVersaworksCsv` requires the `Job Name` header plus Ink Consumption/Nick Name/Print Area, and any KEY_* header disqualifies — mutually exclusive with the RasterLink sniffer in both directions (tested both ways). Sniffed files get the hardened branch; printerSoftware and import source are hard-set to "versaworks" (deterministic dedupe key; legacy stored whatever the form's source field said).
- Parsing helpers ported VERBATIM from the legacy branch (cleanText/parseCsv/inkSplit/sqft/date/ticket) so imported values are byte-identical: mm→sqft, colon-split ink classified white / gloss-clear-primer / CMYK, startedAt falls back to RIP times (legacy semantics preserved, now labeled `timingBasis: rip_times_fallback` + warning), greedy full-chain ticket extraction deliberately kept (matches every historical VersaWorks row; RasterLink's first-segment rule is watcher-specific).
- File dedupe: same sha256 marker pattern (notes startsWith, processed-only so crashed partials retry; duplicate upload → deterministic `{ok:true, duplicateFile:true}` with no import/entries). Row dedupe natural key on plain columns: shop + printerSoftware + sourceJobName + machineName + status/event + startedAt/completedAt, plus inkMl AND sqft when both timestamps are blank — repeated exports and overlapping date ranges skip (counted in duplicatesSkipped), never keyed on array position or import time. Fixes forward the dashboard double-counting from re-uploaded exports; historical duplicate rows are NOT rewritten (visible in review instead).
- Matching (never first-match-wins, never bare contains — both replaced): stage 1 exact ticket (`findMany take 5`): exactly one → attach `ticket_exact`; two+ → ambiguous. Stage 2 only when zero ticket hits: exact-NORMALIZED equality against a bounded ProductionJobItem.ripJobName index (300) — one distinct job → attach `rip_job_name_exact`; two+ → ambiguous; contains-only overlap stays unmatched (tested). Ambiguous rows carry the same top-level `matchFlag: "ambiguous_ticket_needs_review"` the review page classifies on — VersaWorks ambiguity appears in `/app/erp/rip-import-review` with zero review-page changes (proven by importing `classifyEntry` in the tests).
- rawRow: original CSV keys spread first and never overwritten (headers contain spaces/brackets so `matchFlag`/`matchMeta`/`timingBasis` cannot collide) + additive `matchMeta {matchMethod, normalizedTicket, normalizedJobName, ticketCandidateCount, ripNameCandidateCount, candidateJobIds ≤5, warnings}`. Source values (filename, job name, ticket, machine, media, ink, timing, event) are never modified by matching.
- Audit surface: import notes `sha256:…\nrows:… created:… duplicatesSkipped:… matched:… ambiguous:… parseWarnings:… outcome:processed` and the response `{ok, format:"versaworks", fileName, fileHash, rows, created, skippedDuplicates, matched, ambiguous, unmatched, parseWarnings, outcome}` — the same contract as RasterLink, already parsed by the review page's import summary.
- Deferred (identified, untouched): the print-logs page's `findMatchingJob` bare-contains matcher and rip-imports manual page findFirst (working routes; replacement in 13A.6E), JobInfo.ini fallback, `productionJobItemId` backfill.
- Validation: tests 220 -> 245 (25 new: format detection incl. BOM + mutual exclusion both directions, malformed/blank, full/RIP-times/minimal header parsing with exact value assertions, clear/primer classification, file-hash determinism, cross-file row-key equality (no double counting), key sensitivity to time/machine/event, blank-time inkMl+sqft key, cross-shop key isolation, all five match-decision outcomes, contains-only stays unmatched, short-name guard, counter aggregation, rawRow preservation + matchFlag + matchMeta, review-page classifyEntry compatibility, greedy ticket extraction). Full suite 245 passing; build clean; tsc 308 = baseline (0 errors in new files; the endpoint's 2 pre-existing errors just shifted lines). Safety scan: endpoint diff 122 insertions / 0 deletions; schema, RasterLink parser, watcher, review page, print-logs/rip-imports pages, actual-cost lib, and all protected pricing files untouched; no Shopify calls; writes limited to the same four operations the RasterLink branch uses.

## Completed Milestone: Legacy Matcher Safety + JobInfo.ini Fallback (Patch 13A.6E)

**Part 1 — legacy print-logs matcher hardened.** `findMatchingJob` (used by the paste/upload import intent) previously attached first-match-wins through three stages: exact findFirst, a bare `jobTicket: {contains}` findFirst, then an includes() scan over 100 recent jobs matching source names against tickets and even raw job IDs. Now: exact unique shop-scoped ticket only (pure `app/lib/print-log-matching.server.ts` — `decidePrintLogMatch` zero/one/many + `printLogTicketWhere`), zero or two+ candidates stay unresolved for the review page. The manual `matchEntry` intent is RETIRED, not forked: it attached with no confirmation, no stale-write protection, no audit metadata, and overwrote the row's parsed `jobTicket` — making it safe would duplicate the entire 13A.6C review workflow. The intent now returns a clear moved-to-review message and writes nothing; the unmatched-rows section links to `/app/erp/rip-import-review`. Listing/import/viewing functionality preserved; historical attachments untouched. Source-scanning regression tests pin the absence of contains/includes matching and of the ticket overwrite.

**Part 2 — JobInfo.ini fallback (implemented, disabled by default).** Architecture: server-side companion upload — smallest option; the web server never reads `C:\MijCtrl\Jobs`; only the folder NAME travels (full local paths are stripped by `safeJobInfoSourceId`); restart-safe by construction (enriched rows stop being eligible); fully offline-tested; the watcher is byte-untouched. Feature flag `GSO_ENABLE_JOBINFO_FALLBACK=1` (default OFF — no real shop JobInfo.ini sample exists in the repo, so per the do-not-guess rule live wiring stays disabled until one is validated). Behavior when enabled, via POST of a `.ini` file + `jobFolder` field to `/api/rip-imports/upload` (same token auth): parse `inkUsed` with the validated conversion (codes 1/2/3/4 = C/M/Y/K, raw/1000 = cc per arranged item — the 0.067/0.070/0.014/0.017 example is pinned); unknown channel codes are preserved verbatim with `unknown_channel:<code>` warnings and NEVER added to totals; malformed pairs warn, never guess. Pairing: exact normalized equality (case/extension/punctuation-insensitive) between the JobInfo folder name and a RasterLink row's stored KEY_FILENAME — exactly one eligible candidate pairs; zero keeps `missing_inkuse`; two+ is ambiguous (IDs reported, no write); never contains, never nearest-date. Eligibility: rawRow `inkBasis` must be `missing_inkuse` (valid CSV ink is NEVER overridden), not already enriched, and at least one timestamp present (**blank-time rows are refused** — their 13A.6A dedupe natural key includes inkMl, so enrichment would break re-upload idempotency). Enrichment writes exactly `{inkMl, cmykInkMl, whiteInkMl:0, glossInkMl:0, rawRow}`: arrange count known → per-item x count with `inkBasis: "jobinfo_arranged_estimate"`; unknown → per-item value with `"jobinfo_per_item"` + warning — both are ESTIMATES, never labeled measured (`estimate: true` in provenance). rawRow gains a `jobInfoFallback` block: sourceId, jobName, raw inkUsed string, per-channel cc, unknown channels, arrangeCnt, perItemTotalCc, estimatedTotalCc, warnings, originalInkBasis, appliedAt, version "13A.6E". Existing basis values are unchanged (valid CSV rows keep `rasterlink_rounded_per_item_estimate` = the spec's "rasterlink_csv" state; untouched blank rows keep `missing_inkuse` = "missing"). When the flag is off, `.ini` uploads are rejected with a clear message (previously the legacy non-CSV path would have created a junk placeholder row).

**Live validation step (REQUIRED before enabling the flag):** copy ONE real `JobInfo.ini` from `C:\MijCtrl\Jobs\<job folder>\` on the RIP PC; confirm its `inkUsed=` line matches the validated `code;raw` comma format and note any channel codes above 4 (report them for mapping approval before trusting white/gloss); with the flag ON in a non-production environment, upload it: `Invoke-RestMethod -Uri "<app>/api/rip-imports/upload" -Method Post -Form @{ token = "<upload token>"; jobFolder = "<job folder name>"; file = Get-Item .\JobInfo.ini }` against a blank-ink test row; verify the response outcome and the row's new inkBasis/provenance in RIP Import Review; only then consider enabling in production.

- Validation: tests 245 -> 273 (28 new: validated four-channel parse, malformed pairs never guessed, unknown-channel preservation/exclusion, ini parsing + bounded rawKeys + path stripping, all eligibility refusals incl. blank-time dedupe protection and already-enriched idempotency, paired/zero/ambiguous/ineligible-reported/short-name pairing, arranged 6.72 vs per-item 0.168 distinction with full provenance assertions, update-payload key pinning, no-usable-ink refusal, flag default-off, conservative print-log decisions, cross-shop where builder, and source-pinned route regressions). Full suite 273; build clean; tsc 308 = baseline (0 new — print-logs' 2 errors stash-proven pre-existing, only line-shifted). Safety: schema, watcher, RasterLink/VersaWorks parsers, review page, and protected pricing files untouched; no Shopify calls; the .ini branch's only write is one `printLogEntry.update`.

## Completed Milestone: Automatic Print Intake + RIP Routing (Patch 13A.6G)

- **Architecture (two separated agents):** the new Print Intake Agent (`tools/gso-print-intake-agent.ps1`, PS 5.1, ASCII+BOM, JSON transport only — no multipart) routes ARTWORK INTO the RIPs from `\\SynologyNAS\GSOP\GSOP\Prints For Today`; the existing RasterLink watcher imports RIP RESULTS back. Staff workflow: drop the file, done — no renaming, no ticket copying, no hot-folder choice, no PowerShell.
- **Deterministic mapping (server-side, read-only `/api/print-intake/route-plan`):** token-authenticated (existing upload token), shop-scoped (`eligibleJobsWhere`: shop + active, bounded 300 recent jobs), receives basenames only (never full local paths). Hierarchy: (a) exact item ticket `GSO-YYYYMMDD-NNNN-II` in the filename; (b) exact job ticket only when the job has exactly ONE item; (c) exact normalized filename equality vs suggestedFileName/ripJobName/job artwork+print-file basenames; (d) exact equality vs stored ProductionJobFile names (single-item jobs); (e) job subfolder identity ("TICKET - CUSTOMER - PRODUCT"); (f) review. Equality only — never contains/fuzzy/nearest-date/customer-name; 2+ candidates at ANY tier routes nothing and lists candidates safely. The server returns a machine KEY only; hot-folder paths exist solely in the local agent config.
- **RIP name:** routed copies are named `ripJobName > itemTicket > suggestedFileName` + original extension (sanitized) — ticket-led on purpose so the RasterLink result watcher's first-underscore-segment ticket extraction auto-matches the eventual result rows.
- **Machine routing (FINALIZED owner rules — 13A.6G continuation):** (1) white and/or gloss REQUIRED -> **Roland LG-540** (`machineRule: white_or_gloss`); (2) CMYK-only + explicit ERP Roland assignment -> Roland (`explicit_erp_machine`); (3) CMYK-only + standalone case-insensitive `ROLAND` filename tag -> Roland (`explicit_roland_tag`; delimiter-bounded — "Rolando" never matches); (4) all other CMYK-only -> **Mimaki UCJV300** default (`default_cmyk`; explicit ERP Mimaki reports `explicit_erp_machine`). Genuinely contradictory data still reviews: white/gloss or ROLAND-tag work explicitly assigned to the CMYK-only Mimaki, or a machineSummary naming both printers. The plan response gained the additive `machineRule` field (`rule` stays the MATCH rule — API contract preserved). Dry-run hardening: -DryRun now creates NO claim files (previously it claimed then released) — plans + logs only. Live routing still gated by config: both flags ship OFF and Roland additionally requires the confirmed `VersaWorksHotFolder`; Roland-bound plans surface as needs_review with the blocking reason until enabled.
- **Agent safety/restart behavior:** `.gsoclaim` atomic claims + stale reclaim, stability wait, sha256 content-hash ledger (`gso-print-intake-ledger.jsonl`) so content is never routed twice and unresolved files are not re-reported; collision-safe `-sha8` destination names; copy length verification; originals preserved ALWAYS (routed -> `_routed-archive` move after verified copy + report; needs-review files stay exactly where staff put them; nothing is ever deleted); 401/403 = fatal-config exit; plan/endpoint failures retry next pass. Modes: default one pass, `-Loop`, `-Once`, `-DryRun` (plans only, zero side effects), `-Health` (masked token, folder + endpoint + side-effect-free token probe: 400 = valid), `-SelfTest` (19 offline assertions, all passing under 5.1).
- **Outcome audit (no schema):** `/api/print-intake/report` is the flow's ONLY mutation — appends one outcome (routed/needs_review/duplicate/failed; basename, rule, reason, tickets, ripName, machine, hash8) to a marker-namespaced rolling 50-entry JSON inside `PrintLogAutoImportSetting.notes` (foreign operator text preserved verbatim; identical head report = idempotent no-op) and, for routed outcomes, one `print_file_routed` ProductionJobEvent on the shop-verified job (stale/cross-shop jobId rejects the whole report). Both in one transaction.
- **UI:** `/app/erp/print-intake` rewritten — live outcome table (Routed / Needs review / Duplicate / Failed with counts, file names only), staff workflow, the machine-routing v1 note incl. the open white/gloss decision, agent setup + `schtasks` install steps, retired-legacy-watcher warning, token card. RIP Import Review's stale "deferred to 13A.6D" VersaWorks banner refreshed to reflect the shipped hardening (pre-13A.6D rows still worth spot-checking).
- **Security/hygiene:** token never logged (masked in -Health only); `.gitignore` now explicitly covers the real watcher/agent configs (`tools/gso-*-config.json` variants) — the local `gso-rasterlink-sync.config.json` was confirmed untracked but previously protected only by a machine-global excludes file. Legacy `gso-print-intake-watcher.ps1` left in place undeleted but documented as retired (destructive renames of originals, contains-needle routing, filename-guessed material, PS7-only `Invoke-RestMethod -Form` upload that cannot work on 5.1 — do not schedule it).
- **Validation:** tests 273 -> 294 (21 new: ticket extraction/underscore tolerance, basename path-stripping, all six hierarchy tiers incl. multi-candidate/multi-item reviews, equality-not-contains proof, Mimaki default + explicit, Roland key, white/gloss review, contradictory machine review, RIP-name preference/sanitize/no-name review, rolling codec cap + foreign-text preservation + idempotent head + decision-change append, shop-scoped where builder). Agent: 0 parse errors, ASCII-only, BOM, SelfTest 19/19 exit 0 under Windows PowerShell 5.1. Build clean; tsc 308 = baseline (0 in new/edited files). Safety scan: schema, validated parsers, RasterLink watcher, review/actual-cost logic, and all protected pricing/calculator/configurator/production files untouched; plan endpoint has zero writes; report endpoint writes exactly `printLogAutoImportSetting.update` + `productionJobEvent.create`; no Shopify calls.
- **Go-live cutoff (13A.6G go-live safety):** the real Prints For Today folder holds ~9,758 historical artwork files that must never be processed. New optional config `ProcessFilesModifiedAfterUtc` (ISO-8601 UTC, e.g. `"2026-07-19T17:20:00Z"`; invalid values throw at config load — a typo can never silently process everything). Files with `LastWriteTimeUtc` at or BEFORE the cutoff (equal = ignored) are filtered at enumeration, before detection logging, claims, hashing, ledger lookups, plan calls, copies, moves, and reports — they never enter the per-file pipeline. Logging is one pass-level `scan_summary` line (`eligible=N historical_files_ignored=N cutoffUtc=...`), emitted only when counts change so -Loop does not spam; never one line per historical file. Reserved locations are excluded from recursive scanning entirely: `_agent-test` and `_routed-archive` folder names anywhere in the path plus the configured RoutedArchiveFolder/ErrorFolder/LogFolder roots. -Health now shows the cutoff value (or a NOT SET warning when >100 files are eligible), historical-ignored count, and eligible pending count. Self-test grew 20 -> 33 assertions (cutoff parse/invalid-throw/boundary semantics: older ignored, equal ignored, newer eligible, null-cutoff eligible; a real temp-folder scan proving only the fresh file survives, the historical count, reserved-name and configured-root exclusion, and that scanning creates no claim files). Routing flags remain config-controlled and OFF.
- **Before live routing:** owner must (1) set `ProcessFilesModifiedAfterUtc` to the go-live moment, (2) run -Health and -DryRun on the shop PC (health must show historical files ignored ~9758, eligible 0), (3) confirm the VersaWorks hot-folder path for Roland work, (4) flip `MimakiRoutingEnabled` (and later `RolandRoutingEnabled`) after the dry run, (5) install the scheduled task. Stop conditions honored: nothing committed/pushed/deployed, no task installed, routing flags ship OFF.

## Completed Milestone: Read-Only Estimated-vs-Actual Variance Report (Patch 13A.7A)

- New "Estimated vs Actual variance (13A.7A)" section on **Audit · Actual Costs** (extends the 13A.5 dashboard — no new navigation; Production Board and Reports Dashboard were evaluated and rejected: the board is a protected mutation-bearing page, the dashboard is generic KPI cards). READ-ONLY: grep-proven zero Prisma write verbs in the lib and the extended route; ProductionMaterialUsage, job actual-cost fields, quotes, and calibration are untouched.
- Pure engine `app/lib/actual-variance.server.ts` (data passed in; 16 tests import directly). Per production job with attached print rows: **Estimated** (revenue, cost, unit cost, profit, margin from qty x unitPrice/unitCost — the same fields the Production Board uses; items with unitCost 0 are flagged, with the costSnapshot estimate.totalCost surfaced in the warning when present; multi-item jobs warn that print rows are job-level). **Observed** (matched row count with duplicate-historical rows deduped in math but visibly counted; print vs cut rows split — cut rows are counted and never ink/time-costed so Color+Cut pairs cannot double-count; printers; match methods item_ticket / job_ticket / manual_review (from rawRow rematchAudit) / attached; channel ink ml; sqft; print minutes; run count = distinct print start stamps with reprintDetected flag — reprints are included in totals and flagged, never merged; timestamp-less rows report runs "unknown", never guessed as 1; zero-sqft and zero-minute rows are flagged). **Partial actual preview** from existing verified sources ONLY: ink = 13A.5 verified DB channel rates (partial when some rows lack attribution), machine time = the undecided $5/$8 per-hour range (both shown), media = display-only name-matched material $/sqft x area; every component reports calculated / partial / **"Not configured"** — nothing is invented. Labor, packing, shipping, outsourcing, reprint extras are EXCLUDED components listed on every row; `complete` is false by construction and each row carries a "NOT a final cost" warning. Variance $ and % as low-high ranges; severity high >25% / medium >10%; manually recorded final actuals (actualTotalCost/actualCostFinalized) display separately and never replace the preview.
- UI: summary cards (jobs analyzed, high variance, reprint jobs, estimated vs preview totals), GET-form filters (match method / printer / variance severity — embedded-safe RR Form), per-job cards with component badges, collapsible warnings, direct link to the production job print page, empty/loading/error states (loader try/catch to an in-page banner).
- **Data-quality finding for 13A.7B:** the Production Board's `roughActualPrintCost` uses hardcoded legacy ink rates (`156.99/750` Roland, `190/1000` Mimaki) that contradict the verified 13.2.4 channel costs (149/750 = 0.19867, 0.176) — the variance report deliberately uses the verified engine and this discrepancy must be reconciled before any writeback.
- **Gate before 13A.7B writeback (owner decisions):** (1) pick the machine rate ($5 vs $8); (2) reconcile the board's legacy ink rates with verified channel costs; (3) decide if name-matched media cost is write-grade or stays preview-only; (4) 13A.7B itself must be preview-then-confirm (the 13.2.2 APPLY-phrase gate pattern), writing ProductionMaterialUsage (`source:"print_log"`) + job actual fields from this same engine.
- Validation: tests 296 -> 312 (16 new covering matched item ticket, job-ticket-only, manual-review labeling, unmatched/empty jobs, duplicate-import protection, Color+Cut handling, reprint visibility + unknown-runs, estimate math, missing cost snapshot + snapshot hint, multi-item jobs, full partial-preview math incl. Not-configured paths, zero minutes/sqft flags, variance/margin rounding, finalized-separate display, all three filters). Build clean; tsc 308 = baseline (0 in touched files); git diff --check clean; protected pricing/board/quote/schema/tools files untouched.

## Completed Milestone: Guarded Print-Log Actual-Cost Writeback (Patch 13A.7B)

- **Action**: "Pull actuals from print logs" per job on the Production Board actual-cost section (no global write-all anywhere). Preview shows job ticket, matched rows, match methods, printers, ink ml + cost, minutes, rate + machine cost, cut rows excluded, duplicates ignored, runs/reprints, material preview-only note, proposed total, existing applied state, and warnings. Apply requires the typed phrase **`APPLY PRINT LOG ACTUALS`** (exact, case-sensitive — 13.2.2 gate standard); the server re-computes from the database at apply time and never trusts client numbers.
- **Rows written** (one `$transaction`): `ProductionMaterialUsage` with `source:"print_log"` — ink row (materialType "ink", unit ml, usedQty = deduped print-row ml, costPerUnit = blended verified $/ml, totalCost) and machine-time row (materialType "other", unit hour, costPerUnit = configured rate, totalCost) — each with `notes = component:<key>|<provenance JSON>` (engine 13A.7B, appliedAt, appliedBy production-board, ratesSource verified_machine_channel_costs, entry IDs, duplicatesIgnored, cutRowsExcluded, runCount, reprintDetected, printers, matchMethods, itemTicket when every print row attributes to one exact item, partial:true) plus one `print_log_actuals_applied` ProductionJobEvent. **Nothing else**: no job `actual*` field writes, no finalization, no media/material cost (owner decision: name matching is not write-grade), no quote/calibration changes.
- **Idempotency**: re-apply deletes ONLY `{shop, jobId, source:"print_log"}` rows and recreates them — manual usage rows, inventory deductions, packing rows, and every other source are untouched (source-pinned tests). Re-running with unchanged logs reproduces identical rows; new print runs increase cost and are flagged (distinct start stamps), never merged; duplicates never double-count; cut rows never cost.
- **Blocks** (clear reasons, nothing written): finalized job (`actualCostFinalized`), ambiguous-flagged attached rows, zero attached rows, cut-only rows, no computable component (no attributable ink rates AND no minutes). A partial import is labeled PARTIAL everywhere and never presented as a finalized cost.
- **Shared engine consolidation (owner decisions)**: the board's legacy hardcoded ink rates (Roland 156.99/750, Mimaki 190/1000) and $5 recovery constant are REMOVED — `summarizeActualPrintLogs` now uses `computeEntryCosts` + `buildBrandRates` (verified channel costs, same as Audit Actual Costs and 13A.7A) and skips cut rows. Machine rate = **$8/hr** through the ONE configurable source: `MACHINE_RATE_CURRENT` (shared constant) + `machineRatePerHour()` (env override `GSO_MACHINE_RATE_PER_HOUR`). Board final-cost math: recorded print_log rows win over the live preview (printCostSource recorded_print_log|live_preview); manual material rows are summed separately from print_log rows so nothing double-counts; `saveFinalCosts` inherits the same split.
- **LG-640 normalization**: the shop's Roland is the **LG-640** — operational evidence (VersaWorks hot folders `LG640-*`) beats the LG-540 display strings. finish-presets `preferredMachine` and routing-doc comments updated to LG-640; `attributeMachine` accepts `lg-540|lg-640` so historical LG-540-named rows stay attributable.
- **Server-bundle split**: `PRINT_LOG_USAGE_SOURCE`/`WRITEBACK_PHRASE` live in client-safe `print-log-writeback-shared.ts` (the board component references the source constant in render); computation stays in `print-log-writeback.server.ts` (re-exports for one import path) — the established pattern after the build caught a component->server reference.
- Validation: tests 312 -> 328 (16 new: full computation with provenance, exact phrase constant, finalized/ambiguous/no-component/cut-only blocks, duplicate ignore, cut exclusion, reprint run doubling, idempotent identical rerun, uniform multi-item attribution vs job-level warning, source-scoped deleteMany + no-manual-field-writes + $transaction source pins, legacy-constants-removed pin, audit-engine ink equality, $8 rate through the configurable source). Full suite 328; build clean; tsc 308 = baseline (2 introduced errors found and fixed during validation); intake routing/watcher/token/cutoff, quote pricing, calculator, configurator, and schema untouched.

## Completed Milestone: Audit Display Normalization (Patch 13A.7B.1)

- Audit · Actual Costs now presents costs identically to the Production Board / writeback: machine time at the ONE configured rate via `machineRatePerHour()` ($8/hr — the $5/$8 dual cards, dual table columns, and low-high preview ranges are removed everywhere on the page), and the variance section shows a single **partial print total = ink + machine** that always equals the board/writeback number. Media/material remains a separate preview-only reference line explicitly excluded from the total (not write-grade). The routing banner now states Roland **LG-640**, the current $8/hr rate, and the verified shared channel costs.
- `actual-variance.server.ts` reshaped to single-rate fields (`machineCost`, `machineRatePerHour`, `previewTotal`, `previewProfit`, `previewMarginPct`, `variance`, `variancePct`); severity thresholds unchanged (>25% high, >10% medium). Cost MATH unchanged: ink = same verified channel engine; machine = minutes/60 x rate (the $8 half of the old range); the only computational change is material's exclusion from the headline total, matching owner decision 4 and making audit = board = writeback everywhere.
- Historical compatibility preserved: `attributeMachine` still classifies LG-540-named rows (and LG-640/`LG 640`) as Roland — pinned by test. The `MACHINE_RATE_LOW/HIGH` constants remain in the shared lib for the untouched 13A.5 lib functions but no page displays them.
- Tests 328 -> 332 (variance suite updated to single-rate fields + 4 new pins: no $5/no-LOW-HIGH display in the audit source, no LG-540 display text, historical LG-540/LG-640 classification, and audit-preview == writeback-total equality on identical rows). Build clean; tsc 308 = baseline; page remains read-only (no writes added); writeback/routing/token/task/cutoff untouched.

## Completed Milestone: VersaWorks Print-Time Reliability + Exact Item Attribution (Patch 13A.7C)

- **Problem solved**: VersaWorks rows import with `printMinutes: 0` (deliberate 13A.6D semantics), understating Roland machine cost, and the hardened import branches never set `productionJobItemId`.
- **Duration precedence** (pure `app/lib/rip-duration.server.ts`, documented order): (1) native explicit VersaWorks duration field — **not available**: the proven export header set has no such field and no real sample exists to prove an alternate name; a guessed key's queue-vs-print semantics would be invented evidence, so this slot stays empty until a real export shows one; (2) **derived** from the row's OWN raw `Print Start Time`/`Print End Time` (same source row; end strictly after start; <= 1440 min plausibility bound; labeled `derived_print_timestamps`; original raw stamps preserved and recorded; **RIP times never derive** — RIP time is not print time); (3) stored imported minutes (`imported_native` — RasterLink print-stamp-computed values and legacy native columns); (4) `unknown` -> 0 with a warning — never derived from file/import/queue/submission times, unrelated stamps, speed, sqft, ink, or averages. Cut rows always 0.
- **Wired everywhere the same**: `computePrintLogWriteback` (machine minutes via resolver + `durationSources` counts in the machine-row provenance), `computeJobVariance`, and the Production Board's `summarizeActualPrintLogs` — board = audit = writeback still hold. Reapplying writeback on a job whose VersaWorks rows have print stamps now updates the machine-time component; ink is untouched; unknown-duration rows keep machine time at 0 with a "never guessed" warning; finalized jobs stay blocked.
- **Strict item attribution** (`attributeEntryToItem`): exact item ticket > exact normalized RIP name (`ripJobName`/`suggestedFileName`) > exact `ProductionJobFile` name (job-level only — the schema has no file->item link, so it reaches an item solely via the single-item rule) > single-item fallback (recorded reason, confidence "fallback") > job-level only on multi-item jobs; two-plus candidates unresolved; equality only, never contains/fuzzy/first-match; a stored `productionJobItemId` is respected and never re-attributed.
- **Migration decision: none.** `PrintLogEntry.productionJobItemId` already exists (now fillable by backfill); `ProductionMaterialUsage` item-provenance stays in notes JSON — sufficient until a consumer needs SQL-level item filtering (revisit at 13A.8 calibration).
- **RIP Import Review additions**: read-only "Roland duration & item attribution audit" — counts (Roland rows, native/derived/unknown duration, exact-item / single-item-fallback / job-level / unresolved attribution, fills available) + a bounded 50-row table (source row, ticket, printer+brand, raw print stamps, selected minutes + source, attribution method + confidence, planned fills, job link, warnings). Owner-gated **fill-only backfill**: exact phrase `APPLY VERIFIED RIP BACKFILL`, server recomputes eligibility fresh, one transaction, fills ONLY `printMinutes` (currently 0 + valid derived) and null `productionJobItemId` (exact or single-item-fallback tiers), appends `durationBackfill`/`itemAttributionBackfill` provenance blocks to rawRow (verbatim-wrap on unparseable), one `rip_backfill_applied` event per affected job; never overwrites nonzero minutes or a different item id; the audit table IS the dry preview; no global fix-all beyond the reviewed deterministic set.
- Validation: tests 332 -> 352 (20 new: derived stamps, native slot, derived-over-stored precedence, backwards/zero/over-24h rejection, RIP-fallback never derives, cut rows, raw-stamp preservation, all five attribution tiers + ambiguous + no-prefix-fuzzy + stored-id respect, writeback machine-cost gain with unchanged ink, idempotent reapply, unknown-stays-zero, finalized block, rawRow block append + verbatim wrap, phrase constant, LG-540/LG-640 classification). Full suite 352; build clean (no server-module-in-client); tsc 308 = baseline; no schema/migration diff.
- **Remaining before 13A.8**: real VersaWorks export sample still wanted (to check for a native duration field name); media/material write-grade decision; per-item usage column decision if calibration needs SQL-level item filtering.

## Completed Milestone: Read-Only Calibration Recommendations (Patch 13A.8A)

- New page **Audit · Calibration** (`/app/erp/calibration`, nav after Audit · Actual Costs) + pure engine `app/lib/calibration.server.ts`. READ-ONLY by construction: the route has NO action export and no write verbs (source-pinned by test); nothing changes pricing, machines, quotes, jobs, or history.
- **Trustworthy data rules**: rows must be job-attached, deduped (natural key), non-cut, non-ambiguous; TEST-token rows (standalone `TEST` in ticket/filename, incl. `_TEST.pdf`) excluded by default with a page toggle — there is NO production/test flag in the schema, so the token filter is the documented safe strategy (blocker recorded). Finish comes only from structured `selectedFinish` via exact/single-item attribution — never inferred from filenames. Per-metric exclusions: zero-sqft rows from ml/sqft metrics, unknown-duration rows from time/machine metrics, unresolved channel splits from channel metrics, missing quantity from per-100-unit metrics. Every exclusion carries an explicit reason shown in the data-quality summary.
- **Sample thresholds** (constants + UI): 5+ reliable runs, 3+ distinct jobs, 2+ distinct dates, no single job >50% of the sample; otherwise the exact message "Not enough verified production data yet" with observed values still displayed. **Outliers**: 1.5x IQR fences applied only at 8+ samples (thin-fence clipping on tiny samples is worse than showing the spread — documented); included/excluded partitions and fence values are listed per card; source rows are never altered.
- **Recommendation logic**: median-based (means shown alongside); +/-10% keep-current tolerance; statuses recommend_increase / recommend_decrease / keep_current / observed_only / not_enough_data. Cards show current value + ACTIVE source, observed median/mean, recommended value, abs/% difference, sample/job counts, date range, printers, min/max/stdev, included + excluded run IDs, rationale, and a representative-job dollar impact where a rate exists. **Confidence** (documented in code + UI): low = meets minimums; medium = 8+ runs, 4+ jobs, 3+ dates, CV <= 0.35; high = 15+ runs, 6+ jobs, 5+ dates, CV <= 0.20.
- **Active assumptions compared**: `MachineInkChannel.mlPerSqft1Pct` (the live recipe-pricing input; seeded 0.0075 fingerprint) stated at 100% reference coverage per channel group, verified `costPerMl` rates, and the single $8/hr `machineRatePerHour()`. The stale duplicate `erpAdminSetting.defaultMachineRecoveryHr` is FLAGGED on-page as contradictory, never used. Metrics with no active assumption (ink $/sqft, machine $/sqft, minutes/sqft, minutes/run, minutes/100 units) report observed_only baselines.
- **Migration decision: none** — runtime-only computation suffices for a read-only report; persistent snapshots/approvals (CalibrationSnapshot etc.) become justified only with the apply action. **Apply decision: NOT built** — the authoritative target (mlPerSqft1Pct) exists, but observed ml/sqft is total-per-area while the assumption is per-1%-coverage per channel; converting requires per-job coverage data the RIP logs do not record (or an owner-chosen reference-coverage policy). Building apply now would write a guessed coverage into live pricing. Gate for 13A.8B: owner supplies the coverage policy (or RIP coverage data), then per-recommendation apply with `APPLY CALIBRATION RECOMMENDATION`, snapshots, rollback, and stale-source refusal per the 13A.8 spec.
- Validation: tests 352 -> 374 (22 new: exclusion reasons incl. test/dup/cut/ambiguous/unmatched, TEST-token boundaries, structured-finish-only, zero-sqft/unknown-duration/quantity extractor guards, all three threshold failures + dominant-job + eligible fixture, median/mean, IQR partitioning + small-sample skip, confidence tiers vs documented constants, increase/decrease/keep/observed-only/not-enough cards, outlier-listed-not-hidden, representative impact, read-only source pins, active-source pins, LG-540 classify + LG-640 display). Full suite 374; build clean; tsc 308 = baseline; no schema/migration diff.
- **Data still needed for high-confidence recommendations**: real (non-TEST) production runs across 6+ jobs and 5+ dates per printer; per-job coverage% (or the reference-coverage policy) to unlock apply; the real VersaWorks export sample remains on the collection list.

## Completed Milestone: Full Cost Calculator & Pricing-System Audit (Patch 14A)

- READ-ONLY audit; zero behavior changes. Full findings in **docs/GSO_COST_CALCULATOR_PRICING_AUDIT.md** (executive summary, calculator flow, source-of-truth map, duplicates, missing costs, family coverage, tier/new-product/Shopify/quote/production findings, historical-safety review, UX findings, 14B–14G roadmap).
- Headline findings: THREE ink-cost systems coexist (calculator's route-hardcoded $0.50–$2.50/sqft estimate profiles vs the recipe engine's channel math vs actual-cost verified rates); TWO calculation engines (cost-calculator.server.ts vs recipe-pricing.server.ts — quotes/products use the latter, the calculator page the former, results can disagree); erpAdminSetting "Pricing"/"Production Cost" keys are **read by no pricing code** (decorative; defaultMachineRecoveryHr contradicts the real $8/hr source); owner labor standards are wired calculator-side only (the engine still uses per-recipe manual labor fields); margin falls back to a silent hardcoded 40; MOQ warn-only; RecipeTier rows are fixed/manual with no below-cost or overlap guard; Shopify product CREATION lives in margin-review/shopify-links, not Product Setup; no duplicate-recipe intent. History is SAFE: quote/production snapshots insulate old records from live assumption changes.
- The optional Audit · Pricing System page (K) was intentionally NOT built — the written audit takes priority and the page would have forced premature assumptions; revisit after 14B consolidation.
- Recommended order confirmed: 14B one shared engine (regression-locked to current quote outputs) → 14C calculator UX (Quick Quote / Detailed Costing / Product Builder modes) → 14D tier generator → 14E product-builder workflow → 14F approved Shopify sync → 14G validate/migrate existing products. Owner decisions queued: cutting/weeding/packout standards, explicit default margin, min-margin/min-price/min-order policy, admin-settings keys wire-or-delete, coverage policy, box family, tier policy, Shopify push authority.

## Completed Milestone: Emergency Cost Calculator Stabilization (Patch 14B.0)

- New pure lib `app/lib/calculator-emergency.server.ts` + "Emergency pricing" panel on the calculator (server-computed via GET params — ONE path; the save action re-computes server-side). Provisional 60/55/50/45/40 tier curve (editable, labeled provisional, highest tier 40%); setup spreads per tier; blank cost qty-aware via the shared `blankItemUnitCostAtQty`/`getBestRange`; every tier priced from its own cost. 40% floor enforced: below-floor blocks save unless the exact phrase `OWNER MARGIN OVERRIDE` + reason. Freight visible and separate (actual > ESTIMATED allowance, three allocation modes, never buried in supplier cost). Owner labor standards updated/split (art 8.3333 + print 1.00; weeding 1.3333/page; bag label 0.078125; packout 2.00/box). Mimaki gloss ink = null (missing, warned, never guessed); Roland uniform rate labeled owner-provisional. Missing costs block finalization with `COST NOT VERIFIED — OWNER REVIEW REQUIRED`; draft-with-warnings allowed. "Save as draft quote" snapshots tiers/freight/gate into a draft Quote (historical quotes untouched). Details: docs/GSO_COST_CALCULATOR_EMERGENCY_FIX.md.
- Tests 374 -> 386 (12 new: owner standards incl. $0.09 bag + rates + roll dims, margin-divisor equality with the engine helper, floor block/case-sensitive override, curve mapping, setup spread + vendor-tier qty awareness + independent tier pricing, below-floor flag, freight actual/estimated/manual+by-value, missing-cost + margin-gate finalization blocks). Build clean; tsc 308 = baseline. Deferred to 14B.1/14C: per-family recompute inside the panel, legacy profile retirement, full source badges.

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

## Completed Milestone: Family-Specific Margin Curves (Patch 14B.0A)
Nine researched family curves + family minimums implemented in calculator-emergency.server.ts (FAMILY_MARGIN_RULES; source "GSO 2026 competitor and margin study"); family selector + summary block on the emergency panel; three-level margin protection (target curve / family minimum / 40% global floor) through the existing phrase gate; documented tier-count mapping incl. >5 monotonic clamped interpolation; exact-alias family resolver (no fuzzy; unknown -> provisional curve + FAMILY MARGIN RULE NOT CONFIGURED); draft-quote snapshots carry full margin-rule metadata (engine 14B.0A-emergency). Tests 386 -> 391; build clean; tsc 308 = baseline; historical quotes untouched. Details: docs/GSO_COST_CALCULATOR_EMERGENCY_FIX.md.

## Milestone: Automatic Full Costing Engine Core (Patch 14B.1)
auto-costing.server.ts pure engine + loader auto-mode wiring (emode=auto) computing the full labeled five-family breakdown (D-spec lines with verified/owner-standard/estimated/missing sources) and feeding variable+setup into the 14B.0 tier pipeline; auto-mode draft saves are blocked pending 14B.1a server recomputation (no client-cost trust); manual mode stays as labeled fallback. Tests 391 -> 397; build clean; tsc 308 = baseline. Details: docs/GSO_COST_CALCULATOR_EMERGENCY_FIX.md.

## Milestone: Usable Automatic Calculator Form + Safe Auto Draft Save (Patch 14B.1a)
Automatic Costing form with CALCULATE COST, badge-labeled breakdown, missing-cost DRAFT ONLY banner, Finalizable indicator, copyable customer price summary; auto-mode draft saves recompute server-side (engine 14B.1a-auto, full autoBreakdown snapshot; client totals ignored); manual mode retained as fallback. Tests 397 passing (auto engine covered in 14B.1); build clean; tsc 308 = baseline. Deferred to 14C: DB pickers, per-family field hiding. Details: docs/GSO_COST_CALCULATOR_EMERGENCY_FIX.md.

## Milestone: Calculator Usability Cleanup (Patch 14B.1B)
Page restructured: header -> Cost Calculator section (auto form + breakdown + Pricing Tiers & Margin Review + customer summary + draft save) -> Legacy Manual Calculator wrapped in a collapsed "Fallback Only" details block with the unsupported-products warning (functionality preserved; no legacy content above the new tools). Renames applied; begin prompt added. Remaining for 14C: move the auto form physically above the tier/manual controls inside the section, per-family field hiding, freight/advanced collapse groups. Tests 397 -> 399; build clean; tsc 308 = baseline.

## Milestone: Daily-Use Calculator Layout (Patch 14C core)
Render order rebuilt: page opens directly with the Cost Calculator section (auto form first -> breakdown -> tiers/customer summary behind "View pricing rules & manual tier controls" collapse) -> collapsed "Advanced Pricing Tools" (old quote-builder header cards, sync/token/PowerShell content) -> collapsed "Legacy Manual Calculator - Fallback Only". All engines/gates/saves unchanged. Tests 399 -> 401; build clean; tsc 308 = baseline. Remaining polish: per-family field hiding, step headings, zero-state suppression of the tier table before first calculation.

## Milestone: Product-Driven Calculator Inputs (Patch 14C.1)
New pure engine app/lib/product-driven-costing.server.ts (engine 14C.1): server-derived sqft/waste/boxes/weeding/layer-ink from posted IDs + business inputs only; family-conditional form (What are you pricing? -> verified product/material pickers with price-status labels -> layers 0-14) replacing every manual technical field (blank cost, blank label, material $/sqft, waste %, boxes, weeding pages all removed from normal mode; Advanced overrides require reasons); provisional linear layer model documented; Mimaki gloss layers = DRAFT ONLY blocker; Chiron cap never doubled; Miron jar+lid separate tiered lines; Safe Care packout rules (1000/150/100 per box, $2/box); save re-fetches records and recomputes (engine 14C.1-product snapshot with selections+derived). Tests 401 -> 415 (14 new); build clean; tsc 308 = baseline. Rules doc: docs/GSO_COST_CALCULATOR_INPUT_RULES.md.

## Milestone: Standard + Premium Jar Families (Patch 14C.1B)
Shared classifier + compatibility + family mapping in product-driven-costing.server.ts; calculator families now 4x5 Bags / Standard Jars / Premium Jars (Chiron & Miron grouped via optgroups) / Stickers / Banners / Custom; 4x5 bag auto-selects the single verified blank; Miron jar-only records require a compatible top (size-token rule); save re-classifies from fetched records. Tests 421 -> 430; build clean; tsc 308 = baseline. NOTE: the original 14C.1B "lid-included sets skip the top selector" waiver was overruled by the owner and corrected by 14C.1B1 before commit (see next milestone). Data limitation: separate Miron top records may not exist yet in VendorProduct (seeds are combined sets) - add top records in the Vendor Cost Book to activate verified top pricing.

## Milestone: Required Miron Top Selection (Patch 14C.1B1)
Owner rule enforced: every Miron sale requires an explicit Top type selection in the UI, without exception - the 14C.1B combined-set waiver is removed (uiFamilyToEngine premium+jar_miron always -> miron-jars). Cost policy centralized in ONE shared function resolveMironTopLine (product-driven-costing.server.ts, TOP_ENGINE_VERSION 14C.1B1-required-miron-top): combined jar+lid sets charge the set price once; selecting the included standard top adds $0 incremental ("Standard top - included in selected Miron set", verified); a different compatible top adds ONLY the verified upgrade difference (max(0, top - included standard), both costs required); unverifiable difference = MISSING "TOP UPGRADE COST NOT VERIFIED - DRAFT ONLY" (never assumed $0); true jar-only records add the full qty-tiered top cost; no selection = MISSING "Top type - Required (Miron)" blocker. Canonical top types (type:standard-top / type:black-metal-top) render even with zero Vendor Cost Book top records so the selector is never absent. Loader + save action both build the mironTop policy server-side; snapshot engine 14C.1B1-required-miron-top records set/top selection, includes-standard-top flag, and basis. Chiron unchanged (cap included, no selector). Tests 430 -> 435; build clean; tsc 308 = baseline. Verified standard/black-metal top unit costs still needed in the Vendor Cost Book to unlock $-verified upgrades (until then upgrades stay Draft Only).

## Milestone: Complete Product-to-Price Quoting Flow (Patch 14C.2)
Chiron restored: classifier normalizes vendor/sku (real records are vendor
"SAFE CARE" with a space + productType plain "jar" — the old checks never
matched, so every Chiron jar fell to jar_standard and the Premium CHIRON group
rendered empty); owner precedence Miron top > Miron jar > Chiron/Safe Care >
standard jar > sticker bag > other; 5oz placeholder excluded before the Chiron
rule; family/class fit enforced at loader AND save (stale switches neutralized);
vendor-vs-material picker dedupe; empty optgroups never rendered. Sticker Bags
renamed + data-driven (bag_sticker class; 4x5/4x6/14x16/OZ today, future sizes
appear without route changes; single bag auto-selects; size-resolved owner
application rates — unknown sizes block). Jar multi-label builder (1-6 labels,
same-size or per-row type+dimensions, shared buildLabelRows for loader+save,
stale rows discarded, per-row missing blockers, application labor = labels
applied not jars). Automatic family pricing tiers straight from the calculated
job: per-quantity engine reruns, researched curves + 40% floor untouched,
requested quantity highlighted, no zero-row tables, customer price selection
("Use this price") -> customer-facing summary card (no internal cost/profit),
SAVE DRAFT QUOTE recomputes everything server-side (psearch GET-state
transport; selected tier resolved by quantity; posted totals ignored).
Snapshot engine 14C.2-multilabel-auto-tiers (topEngine
14C.1B1-required-miron-top preserved). Manual fields renamed/kept collapsed as
"Advanced Pricing Controls". Tests 435 -> 457; build clean; tsc 308 = baseline.
Limitations: no per-label material/layer overrides; application standards only
for 4x5/14x16 bags; standard jars + non-4x5 bags on the provisional universal
curve (labeled); Miron separate-top records still needed for verified upgrades.

## Milestone: Corrected Jar and Sticker-Bag Catalog Rules (Patch 14C.2A)
Owner-authoritative corrections to the (uncommitted) 14C.2 catalog pass. The
14C.2 classifier treated SAFE CARE vendor records as Chiron — WRONG: 3 oz /
4 oz / 5 oz normal jars are STANDARD jars (5 oz included in the calculator by
owner rule; caps counted once; no Top Type), and SAFE CARE alone never implies
Chiron. Chiron is now exactly two explicit records seeded additively via
tools/seed-chiron-jars.mjs against VendorProduct (Chiron 100 ml
cmrzkm4om0000w6ysvtyrt97k / chiron-100ml / $1.80; Chiron 150 ml
cmrzkm4u80001w6yslkmw0lfb / chiron-150ml / $1.90; vendor CHIRON; zero tiers;
nothing else touched — Miron tier records verified intact, 5 tiers each).
Chiron blank cost is FLAT at every quantity: enforceFlatChironCost() ignores
any stray tiers at loader AND save; labels render exactly "Chiron 100 ml — cap
included — $1.80 — Verified" / "Chiron 150 ml — cap included — $1.90 —
Verified". Miron unchanged (tiered cost, required Top Type, 14C.1B1 upgrade
logic). Sticker bags: owner size list 4x5/4x6/5x8/6x9/14x16 always renders —
OZ bag excluded from bag_sticker; unpriced records stay visible as NO PRICE;
5x8/6x9 (no records) render as canonical type:bag-<size> options that quote
Draft Only; size-specific application standards preserved (4x5/14x16 only).
Tests 457 -> 463; build clean; tsc 308 = baseline.

## Milestone: Neutralized Stale 4x6 Sticker-Bag Cost (Patch 14C.2A1)
tools/neutralize-4x6-bag-cost.mjs zeroed the never-verified $0.10 seed value
on VendorProduct cmrpjvdf10001av2aajhsnk4f (vendorSku preset:blank-4x6-bag)
and renamed it "4x6 Sticker Bag" — record active, no tiers, nothing deleted,
historical quotes untouched. The calculator now renders "4x6 Sticker Bag — NO
PRICE — not verified"; selection = missing blank-cost blocker, tiers Draft
Only, no borrowed 4x5 rules. Final sticker-bag statuses: 4x5 $0.09 Verified /
4x6 NO PRICE / 5x8 NO PRICE / 6x9 NO PRICE / 14x16 $1.00 Verified / OZ
excluded. Standard Jars confirmed: 3 oz + 4 oz + 5 oz + soda-can preset (owner
treats the can as a jar); Chiron/Miron/tops excluded. Tests 463 -> 467; build
clean; tsc 308 = baseline.

## Milestone: Unified Product Setup Foundation (Phase 15B)
ONE shared product-family registry (app/lib/product-family-registry.ts,
client-safe): canonical keys, owner labels, recipe-family vocabulary, legacy
aliases, calculator/product-setup/vendor-cost flags, marginRuleKey +
salesRuleKey indexes into the owner-approved tables, sort order — consumed by
the Cost Calculator (options + accepted URL values registry-driven; canonical
resolution in canonicalUiFamily) and Product Setup (registry-first recipe
vocabulary preserving every live string). Reserved dtp-bags entry registered
with calculatorEnabled=false — hidden from the live calculator until 15C.
Owner-standards registry (app/lib/owner-standards.ts): bag 4x5 $0.078125/label
($20/hr at 256), jar $0.20, art $8.3333 + print $1.00/design, weeding
$1.3333/page, packing $2.00/box, machine $8/hr PROVISIONAL — OWNER_LABOR and
all four calculator machine-rate call sites wired to it; legacy conflicting
rates ($0.1111 4x5, $25/hr, $0.15/side) quarantined in
LEGACY_CONFLICTING_RATES with tests proving they cannot override calculator
truth. Product Setup is the product home: grouped sections 1-6 (Basics /
Vendor Cost / Calculator Rules / Features / Shopify / Production Recipe),
read-only Vendor Cost panel over applied VendorProduct records with derived
status (Draft / Unverified / Verified x Active / Inactive via
deriveProductVerification — Cost Book review status upgrades the basis; cost>0
alone is labeled "implicit"), links into the Vendor Cost Book (single cost
store, unchanged apply flow), and the "+ New Product (guided wizard)" entry
(products/new keeps its URL and still redirects back with the draft selected).
Duplicate prevention (findLikelyDuplicates: sku / normalized name /
vendor+size-spec) WARNS before creating recipes (Add Product) and cost items
(Cost Book) — "Nothing was created or merged" unless "Create anyway" is
ticked. No schema change, no navigation change, no margin-curve change,
storefront/configurator/webhooks untouched. Tests 467 -> 481; build clean;
tsc 308 = baseline. 15C entry: flip dtp-bags calculatorEnabled + add the
bag_dtp class/engine family + Spektra seed per GSO_ERP_DTP_READINESS_PLAN.md.

## Milestone: Spektra DTP Bags Through the Unified Product Model (Phase 15C)
Custom Printed Pouches / DTP Bags is LIVE in the calculator via the shared
registry (dtp-bags calculatorEnabled=true; alias dtp-pouches preserved) — no
separate DTP page. Data seeded additively by tools/seed-spektra-dtp.mjs:
Vendor Spektra (cmrzqo6aa0000w618m9c8r624; USD, US, no customs/duty; $85 flat
freight per PO in shippingNotes) + four VendorProducts with EXACT owner tiers
(4x5x2 cmrzqo6gv0002w61849d331gw 0.9897/0.4922/0.4033/0.3232; 5x4x2
cmrzqo6yg000fw6189s0iy2r8 1.0504/0.5419/0.4697/0.3818; 6x5x2
cmrzqo7b4000sw6182tp2iwi6 1.1048/0.5864/0.5290/0.4341; 8x5x2
cmrzqo7no0015w61822yt0jd2 1.2418/0.6991/0.6799/0.5674 — 16 tiers as ranges
1000-2499/2500-4999/5000-7499/7500+) + 28 VendorProductAddOns (6 included
features + optional hang hole $0 per product). 4x5x2 vs 5x4x2 distinct (zipper
location). Engine: bag_dtp class (Spektra vendor/sku/name or non-preset dtp
type; legacy "DTP 4x5x2 Blank Pouch" preset stays out), dtp-bags engine family
= vendor-FINISHED branch: no dimensions/material/ink/machine/application/
weeding/packing/waste; MOQ 1,000 blocker below; vendor setup $0 verified line;
included-features line from DB add-ons; hang hole optional $0; $85 flat
freight as its own verified line INSIDE the cost/margin basis (tier pipeline
never double-adds; user-entered actual freight overrides the default); GSO
design charge = art $8.3333/design ONLY (owner rule: no in-house print setup
on outsourced production). Tier resolution = existing range-based resolver
(highest reached tier, never interpolated; above 7,500 stays on the top tier).
Automatic tiers default to vendor quantities 1000/2500/5000/7500 + requested
qty on the researched dtp-pouches curve (65/58/52/46/42, min 42; 40% floor
untouched). DTP form: size picker (unpriced future sizes NO PRICE/Draft Only),
qty (MOQ hint), designs, hang hole, customer name, notes, read-only included
spec; no in-house print inputs. Snapshot engine 15C-spektra-dtp with size/
vendor tier/unit cost/subtotal/freight+rule/design charge+rule/features/hang
hole/moq/tiers/selected tier; save re-fetches product+tiers+add-ons and
recomputes everything. Adding another DTP size = Vendor Cost Book records
only, zero code. Tests 481 -> 496; build clean; tsc 308 = baseline.

## Milestone: DTP Quantity-Based Margin Mapping (Patch 15C.1)
Corrected before commit: DTP margins now come from dtpMarginPctForQuantity()
(product-driven-costing.server.ts) — owner thresholds 1,000-2,499=65% /
2,500-4,999=58% / 5,000-7,499=52% / 7,500-9,999=46% / 10,000+=42%, values read
from the researched dtp-pouches curve (never duplicated). The generic
curveForTierCount row-count mapping (which compressed four rows to
65/58/46/42, dropping 52%) no longer applies to DTP; all other families keep
it unchanged. Vendor cost above 7,500 stays on the top Spektra tier while
margin follows the thresholds. Both the calculate and save tier pipelines use
the shared function. Tests 496 -> 501; build clean; tsc 308 = baseline.

## Milestone: DTP Size-Specific Owner Price Ladders (Patch 15C.2)
Hybrid pricing live: app/lib/dtp-owner-pricing.server.ts is the centralized
DTP CUSTOMER-price registry (vendor costs untouched in VendorProduct/Tier) —
20 owner prices keyed by vendorSku (4x5x2 1.67/0.88/0.74/0.61/0.60; 5x4x2
1.76/0.97/0.86/0.72/0.71; 6x5x2 1.84/1.04/0.96/0.81/0.81; 8x5x2
2.05/1.23/1.23/1.05/1.05 at 1,000/2,500/5,000/7,500/10,000), highest-reached
lookup, priceDtpQuote() as the ONE pricing function (loader + save). Tier
table rows are the ladder quantities + requested qty with Vendor tier / Owner
tier / Job cost / Owner unit price / Customer total / Gross profit / Gross
margin / Status columns. Safeguards: 40% warning target; hard floors 30/35/38
by band; $500 job-profit target; $350 strategic floor; BLOCKED (below cost /
under $350 / missing cost) never saves; below-floor or sub-$500 saves require
OWNER MARGIN OVERRIDE + reason (server-enforced; generic 40% gate bypassed
for DTP only). Design fees: first included, extras $25/$20/$15 by band,
repeat-order waiver checkbox; internal art cost keeps every design. Freight:
$85 internal, embedded by default; pass-through option backs it out of the
subtotal (never double-recovered). Custom owner unit price on the requested
qty recomputes server-side. Product mapping safeguard: ladders resolve by
vendorSku only — tests prove 4x5x2 and 5x4x2 never share (historical
mislabel regression). Product Setup shows the read-only DTP pricing-rules
card (ladders/floors/fees/source; editability = move the table to
ErpAdminSetting or a dedicated model — documented next step). Snapshot engine
15C.2-dtp-owner-price-ladders + costEngine 15C-spektra-dtp + dtpPricing
block. Tests 501 -> 509; build clean; tsc 308 = baseline.

## Milestone: Quote-to-Production Unification Audit (Phase 15D, audit-only)
No behavior changed. Inventoried: 3 quote creators (calculator draft save,
quote-builder save, agent-queue conversion) + the webhook payment updater;
approval chain (status gate + low-margin approval + approveCreateOrder
deposit/balance/full with boolean duplicate guards); 3 production-job creators
— quotes-page path (idempotent by quoteId findFirst but NO
jobTicket/assetInboxKey: intake/RIP tooling blind to those jobs), production-
page path (near-duplicate WITH tickets), orders_paid configurator branch
(pseudo-quoteId shopify_order_<gid> idempotency; unitCost 0). Gaps: no
transactional/unique-constraint duplicate protection; conversion does not
re-validate snapshot finalizability or DTP override state; quote holds no
productionJobId back-link. Plan: authoritative lifecycle on existing statuses
(draft->sent->approved->deposit_paid->paid=production-ready->production->
completed), ONE createProductionJobFromSource service with transactional
idempotency + always-assigned tickets + family checklist templates (DTP =
outsourced Spektra purchase checklist from the snapshot dtp/dtpPricing
blocks), webhook routed through the service only behind output-equivalence
tests. NO schema migration needed for 15D.1 (optional later: unique index on
(shop, quoteId); queryable vendor-PO fields). Docs:
GSO_ERP_QUOTE_TO_PRODUCTION_AUDIT.md + _PLAN.md.

## Milestone: Central Production-Job Creation Service (Patch 15D.1)
ONE creation path for all sources: app/lib/production-job-source.server.ts
(createProductionJobFromSource; erp_quote / shopify_order / manual_admin).
Concurrency-safe idempotency WITHOUT a migration: transaction-level
pg_advisory_xact_lock keyed by deterministic FNV-1a 32-bit hash pair of
shop|sourceType|sourceId (raw SQL documented; SQLite dev no-ops). The three
divergent creators are deleted (quotes page ~110 lines, production page ~120
lines, webhook ~300 lines; net -571): every job now gets
jobTicket/assetInboxKey/itemTicket/ripJobName/suggestedFileName (closes the
J1 gap — intake/RIP tooling sees quote-created jobs), full snapshot carry,
source event with actor, quote back-link note, and paid->production status
move. Conversion re-validates the STORED snapshot: missing costs refuse, DTP
BLOCKED refuses, DTP override without a written reason refuses. Family
checklists: sticker-bags/standard-jars/premium-jars (Miron top verification
step)/stickers-labels/banners/default + DTP outsourced Spektra purchase
workflow (artwork -> PO -> proof -> confirm -> receive -> QC -> deliver ->
complete; no print/machine/application). Webhook: payment branch byte-
identical; configurator branch through the service behind a field-for-field
parity fixture (pseudo-quoteId, tickets, filenames, summaries, snapshots).
UI: exact disabled reasons + Open Production Job + created date on Quotes;
source type/link on the production board. Tests 509 -> 522 (13 new incl. a
real concurrent-call test over an async advisory-lock fake); build clean; tsc
306 (TWO BELOW the 308 baseline — the deleted duplicates carried two
pre-existing errors). Alerts/proof-sheet behavior preserved (alerts stay in
the routes post-call).

## Milestone: Quote / Product Naming Cleanup (Patch 15D.2)
Root causes from live testing fixed. (1) "Unnamed Quote": calculator drafts
save without company/customer and the CRM header fell back to a literal —
getQuotes now attaches a server-resolved displayName
(resolveQuoteDisplayName: "Customer — Product" | product | customer |
"Custom Quote") and the literal is gone. (2) "NoProduction Test Sticker
selected / unknown": the calculator product-name input PREFILLED with the
manual panel fallback label "Not selected / unknown" (pm.productLabel ||
emergency.family.label); typing into it fused the fragments and nothing
sanitized server-side. Fixes: prefill now uses the real record name, else the
registry family label, else blank; the save action resolves the name through
ONE shared resolver (app/lib/commercial-name-resolver.server.ts) with the
authoritative precedence (explicit entry -> VendorProduct/record name ->
family owner label -> "Custom Quote") and placeholder-fragment stripping that
repairs the exact corruption ("NoProduction Test Sticker selected / unknown"
-> "Production Test Sticker") without ever touching legitimate No…-prefixed
names. Shopify order line titles pass through cleanCommercialName (quote-ID
note matching, totals, quantities untouched). Production service: quote/
manual item titles cleaned; quote-path suggested filenames use the shared
safeNameToken (PRODUCTION-TEST-STICKER; dimensions preserved; never blank;
tickets untouched); the Shopify-order namer stays VERBATIM for webhook
parity. Historical quotes/jobs are never mutated (display-time resolution
only; a backfill utility remains an optional future admin tool). Tests 522 ->
531; build clean; tsc 306 = current baseline.

## Milestone: Actual Cost & Final Margin Audit (Phase 15E, audit-only)
No behavior changed. Verified: saveFinalCosts recomputes revenue/print/
material server-side (revenue from item rows — never client-posted); recorded
print_log rows beat the live preview; manual-vs-print_log material split
prevents print/material double count; material formula matches the
(used+waste+reprint)×cost concept with pulled/estimated fallbacks; inventory
movements audited with before/after. Gaps found: finalize is an ungated
checkbox (zero actuals finalize freely; live-preview print cost silently
becomes final; finalizedBy hardcoded "GSO ERP"; finalized rows silently
editable; uncheck = unaudited reopen); labor rate defaults to legacy $25;
DTP has one flat outsource field (invoice/freight/credit unstructured —
freight double-count risk); no negative-stock guard confirmed; deduction qty
can diverge from costed qty. Plan: 15E.1 = pure assessFinalization gate
module (READY/WARNING with reason/BLOCKED incl. DTP invoice + preview
demotion + zero-revenue block), finalize snapshot + variance + actor,
reopen intent (owner phrase + reason + prior-totals audit event), DTP
three-field outsource entry summing into the existing column — NO schema
migration. Pricing feedback stays owner-reviewed (variance rollups ->
suggested standards -> approval -> Cost Book/standards edit; never
automatic). Docs: GSO_ERP_ACTUAL_COST_AUDIT.md + _PLAN.md.

## Milestone: Governed Actual-Cost Finalization (Patch 15E.1)
Finalization is now gated, audited, and immutable-by-default. Pure module
app/lib/actual-cost-finalize.server.ts (gate/formulas/variance/snapshot/
actor/zero-vs-missing) + production route governance: finalized jobs refuse
saveFinalCosts edits until reopenJobCost (phrase "OWNER COST REOPEN" + 5+
char reason; prior totals/components/finalizedAt/By embedded in the reopen
event); finalize runs the server-recomputed gate — BLOCKED refuses (zero/
negative revenue, negative components/total, DTP missing Spektra invoice or
invalid invoice/freight normalization, deducted-stock-with-no-costed-usage,
labor minutes without rate, already finalized), WARNING requires a typed
reason (live-preview print cost, missing expected material, unconfirmed $0
labor, missing DTP actual freight, >25% deduction drift), READY otherwise;
the actual_cost_finalized event embeds the complete input/component/variance
snapshot and the REAL session actor (email/name/user:id/shop-admin fallback —
"GSO ERP" hardcode removed). DTP actuals are structured (invoice subtotal +
additional charges - credit -> actualOutsourceCost; actual freight ->
actualShippingCost; includes-freight control backs freight out so it is
counted ONCE) and DTP requires no print logs/material/ink/machine/
application. Labor rate no longer defaults to the quarantined $25 (blank
until confirmed; explicit $0 needs its checkbox). Blank inputs are NOT
entered (null) and never become authoritative zeros; variance percent is
unavailable (not 0%) without an estimated cost. Board panel shows the gate
status + reasons + variance and locks inputs when finalized. Tests 531 ->
543 (12 new); build clean; tsc 306 = baseline; no schema migration;
historical finalized rows untouched.

## Milestone: Actual-Cost Reporting & Pricing Feedback (Patch 15E.2)
app/lib/actual-cost-reporting.server.ts + Reports Dashboard section:
finalized-only profitability (open jobs excluded + counted; legacy finals
labeled), executive summary (jobs/revenue/cost/profit/WEIGHTED margin/
variance/below-floor/warnings/reopened/reprint/top families), per-job report
with filters (family/customer/actor/margin-below/warnings/reopened/variance
sign) + leakage flags + source links, aggregates by family/product/customer
(provisional email->company->name grouping)/vendor/quantity band — weighted
margin is the KPI, never percentage averages; DTP rows carry invoice/freight/
tier/custom-price detail with 4x5x2 vs 5x4x2 kept distinct. Centralized
LEAKAGE_THRESHOLDS (40% target, family floors incl. banded DTP, 5-pt margin
drop, 10% cost, 20% freight, 5% vendor invoice, 12% waste, 2% reprint,
warning/reopen flags). Pricing feedback: 3+ comparable finalized jobs (5+ =
high confidence) -> evidence cards (current standard vs observed, variance,
supporting tickets) -> owner review queue accepted/dismissed/deferred stored
in ErpAdminSetting category "pricing-feedback" — destination pricing data is
never written automatically. CSV exports (jobs/families/products/vendors/
feedback) server-generated without snapshots/phrases. Variance % shows
"unavailable" when the estimate is zero. Tests 543 -> 554; build clean; tsc
306 = baseline; no schema migration; nothing mutated.

## Milestone: Report Event Readability + Historical Name Cleanup (Patch 15E.3)
app/lib/production-event-presenter.server.ts: finalize events summarize as
Final cost/profit/margin/Variance/Gate/Reason (SNAPSHOT payload parsed);
reopen events show previous final figures + reason (PRIOR FINAL payload);
job-created/proof/alert/status/note events titled; malformed JSON falls back
safely; blank/unknown events render compact "Legacy event" cards — raw JSON
only inside the collapsed "Show audit details" -> "Raw event data" block, and
original event data is never lost. Display-only historical name cleanup via
the shared resolver: dashboard top products + events, production board item
titles (displayTitle), CSVs; stored values/IDs/snapshots/tickets/filenames
untouched ("NoProduction Test Sticker selected / unknown" displays as
"Production Test Sticker"). New READ-ONLY dry-run name audit on the Reports
Dashboard (?nameaudit=1): assessCommercialName grades QuoteItem/
ProductionJobItem names HIGH (corruption pattern — only class eligible for
the documented future owner-approved backfill) / MEDIUM (placeholder-only) /
LOW (cosmetic); no write path exists (test-pinned). Backfill itself NOT
built. Tests 554 -> 561; build clean; tsc 306 = baseline.

## Phase 15F — Product setup & admin consolidation AUDIT (2026-07-24)
Audit-only; zero app-behavior changes. Delivered 4 new docs:
ADMIN_ROUTE_AUDIT (route decisions on top of the 15A inventory),
PRODUCT_SETUP_PLAN (9-tab true-tab home, query-state tabs, creation
workflow Draft->Unverified->Verified->Active with activation blockers),
SETTINGS_OWNERSHIP_PLAN (ownerConfig ErpAdminSetting contract: key-embedded
namespace because @@unique([shop,key]) spans categories; JSON envelope
carries schemaVersion/updatedBy/note/previous since no updatedBy column; no
migration needed), NAVIGATION_PERMISSION_PLAN (Daily Work / Products &
Pricing / Operations / Owner-Audit groups; verified NO role checks exist —
interim owner-email allowlist gate defined, honest about limits). Roadmap
15F.1-15F.5 recorded in CONSOLIDATION_PLAN. Tests 561, tsc 306, build clean
(docs-only).

## Phase 15F.0 — EMERGENCY calculator forensic audit (2026-07-25)
Audit-only (15F.1 owner settings PAUSED behind it). Owner-reported "quotes
too low" fully explained: the live 100x3x3 sticker quote reproduces TO THE
CENT from production records ($12.2580 cost -> $30.645 at 60%), so the
arithmetic is exact — the money is missing structurally. P0-1: non-DTP tier
margins map by ROW COUNT (curveForTierCount), so the requested quantity
re-interpolates the researched curve (100 -> 60% instead of 65%; neighbors
shift; >=1000 always 40%). P1: machine time (DB Mimaki $5/hr@150sqft/hr
exists, product flow passes 0 minutes), cutting time (no line exists),
outbound shipping (defaults $0), packing for stickers/banners/premium jars
(no rules) — all $0 on "Ready" quotes. P2: no minimum job economics outside
DTP; sticker volume pricing collapses (1,000 x 3x3 = $64.30 vs ~$200-300
market); blanks not waste-adjusted in product flow; recipe waste unwired;
machine-rate conflict $5/$8/$25. NO unit-conversion, mapping, rounding, or
display/save parity defects found; DTP verified working as designed (2,500
4x5x2 -> $1,323.83 landed, 39.83% WARNING). New docs:
CALCULATOR_FORENSIC_AUDIT (findings + P list), CALCULATOR_COST_MATRIX
(component x family), CALCULATOR_QUOTE_FIXTURES (7 reconstructed quotes),
PRICING_CORRECTION_PLAN (sequence 15F.0a-e + owner decision list; smallest
patch = 15F.0a quantity-based margins). Tests 561 -> 579 (18 forensic pins
in tests/calculator-forensic-fixtures.test.ts); tsc 306 = baseline; build
clean; no app behavior changed.

## Phase 15F.0 — PRODUCTION-READY PRICING ENGINE (2026-07-25, implemented)
The calculator now emits customer-ready prices or exact blockers. Delivered:
complete cost contract (machine $8/hr x verified 150 sqft/hr with formula
lines; square-rect cutting $6.53/54x54-page owner model, contour/die BLOCK;
packing never $0 — rules + jar 100/box default + single-box floor, labeled;
outbound shipping EXCLUDED-with-statement, inbound freight unchanged);
quantity-band margins via shared marginPctForQuantity (P0-1 dead: row count
can never shift margins; loader+save identical); NEW
app/lib/commercial-pricing-policy.server.ts (candidates -> max() ->
controlling rule; premium spot-gloss floor for gloss/white stickers; family
minimum slots null pending owner numbers); multi-design split display
(qty=total labels, designs share); multi-line sticker jobs (independent
lines, per-line bands/premium, job-level packing once, combined price; save
recomputes via fReadAll); READY TO QUOTE / BLOCKED presentation with
includes/not-includes; snapshots add commercialPricing/multiLine/designSplit
blocks under engine 15F.0-production-ready-pricing (DTP pipeline byte-
preserved at 15C.2). Acceptance: 11 fixtures in
GSO_ERP_CALCULATOR_QUOTE_FIXTURES.md (100x3x3 -> $60.45 at 65%, in market
range; DTP 2,500 unchanged $2,200/39.83% WARNING). Owner decisions listed in
GSO_ERP_PRICING_OWNER_DECISIONS.md (contour cutting, sticker ladder,
minimums, jar packing density, $8 ratification, banner finishing, blank
waste, recipe waste, overhead, band edges). Tests 579 -> 597 (new
production-ready-pricing.test.ts; forensic pins updated to corrected
values); tsc 306 = baseline; build clean; no migration; historical
quotes/snapshots and Shopify payment/production flows untouched.

## Phase 15F.0-FINAL — employee-ready commercial pricing (2026-07-25)
Closed the commercial gaps on the production-ready engine (no migration; DTP
ladders/vendor costs untouched; historical quotes untouched). Sticker AREA
market floor (sqft-banded $8.00-$3.20 + setup recovery; documented low-end
anchors) now controls volume stickers (1,000 x 3x3: $117.34 -> $209.33, in
the $200-300 band); provisional minimum gross profits (25/75/75/100/25/25,
owner $25/hr basis) + order minimums (stickers 25 / banners 40 / custom 25)
are live max() candidates — NO unit-price floors by design; contour kiss
cutting quotes automatically (x1.15/1.35/1.60 of the $6.53 page standard,
plain-language picker; die-irregular still BLOCKS); DTP normal-ladder quotes
are READY with an informational sub-40% note (floors/$500/$350/overrides
exact); banner finishing deterministic ($5 setup + $0.60/ft hems + $0.30
grommets @24in) and banners pack in $4 tubes; sticker boxes 5,000/box;
multi-line jobs apply job-level packing and minimums ONCE. 14-fixture
acceptance book + market calibration in
GSO_ERP_CALCULATOR_QUOTE_FIXTURES.md (no fixture below its market band).
Provisional-vs-ratify split in GSO_ERP_PRICING_OWNER_DECISIONS.md. Tests
597 -> 605; tsc 306 = baseline; build clean.

## Owner-corrected Roland print profiles (2026-07-25)
Machine-time model corrected per owner RIP screenshots: per-MODE speeds
(CMYK 150 sqft/hr verified; Gloss/Emboss 110 and White HD 75 sqft/hr PER
SELECTED LAYER; overprint 1x per layer — no hidden White-HD 3x), replacing
the equal-speed passes multiplier; minutes = hours x 60 with the full
formula on the machine line. Fixture 5 machine $21.49 -> $27.35 (owner
worked example matched to the cent); gloss/white fixtures repriced (F5
$385.95, F6 $397.09, F7 cost 64.54/final $202.00 unchanged); layerless jobs
unchanged. Tests 605 -> 606; tsc 306; build clean.

## Patch 15F.0G.1 — printer-specific Mimaki/Roland throughput (2026-07-25)
[SUPERSEDED by 15F.0G.2 below — the 169 figure was INCORRECT for the active
RasterLink profile and is retired; kept for log integrity only.]
Mimaki UCJV300 CMYK corrected to the then-assumed 169.0 sqft/hr via a
printer-mode registry that overrides the stale generic 150 Machine value
(documented rule: a deliberately updated record supersedes the registry; no
migration). Roland profiles unchanged (150 CMYK + 110/75 per layer). Mimaki
white pass time falls back to the CMYK baseline labeled provisional; Mimaki
gloss BLOCKS with "Verified Mimaki gloss production and ink profile
required"; Roland ratios never leak into Mimaki (test-pinned). Breakdown
names the printer-specific source; loader/save share the resolver. Mimaki
fixtures repriced (100x3x3 $60.33, bags $540.85/$897.45, Chiron $2,551.16/
$3,049.14, banners $72.12/$118.37); 1,000x3x3 final unchanged at $209.33
(area floor); Roland premium fixture stays 3.4191 hr; DTP untouched. Tests
606 -> 610; tsc 306; build clean.

## Patch 15F.0G.2 — Mimaki UCJV300-130 RasterLink throughput (2026-07-25)
The interim Mimaki single-rate figure was incorrect and is fully retired
(test-enforced absence). Mimaki now prices from the owner-verified COMBINED
RasterLink profile (600x1200 VD / 32-pass / Bi-direction / Fast Print High,
LUS-170): 1-layer 51.6 / 2-layer 18.2 / 3-layer 11.8 / 4-layer 8.6 sqft/hr
x 1.15 turnaround applied once (hours = sqft/rate x 1.15; minutes = hours x
60; recovery = hours x $8). Layer totals 5+ BLOCK ("Verified Mimaki
RasterLink layer profile required"); Mimaki gloss ink stays BLOCKED; Roland
remains the unchanged ADDITIVE model (150 + 110/75). Owner examples pinned:
19.26 sqft CMYK ~25.8 min; two-layer ~73.0 min; 100x3x3 ~9.29 min/$1.24;
1,000x3x3 ~92.9 min/$12.38. Mimaki fixtures repriced (100x3x3 $62.93;
1,000x3x3 final unchanged $209.33 via the area floor; bags $577.59/$970.94;
Chiron $2,558.26/$3,060.96; banners $78.67/$124.92; multi-line $202.00
unchanged). Roland premium fixture stays 3.4191 hr; DTP untouched. Tests
610 -> 612; tsc 306; build clean.

## Patch 15F.0G.3 — provisional Mimaki gloss ink + RIP calibration (2026-07-25)
Routine Mimaki gloss quotes are READY (owner decision): provisional gloss
estimate = adjustedSqft x 0.6 ml/sqft CMYK basis x layers x glossFactor
1.00 x $0.176/ml, labeled estimated with the full formula (blocks only for
missing basis/price, 5+ layers, or other missing components). White ink
stays verified; whiteFactor kept separate. New premium Mimaki quotes
snapshot premiumInkEstimate (profile, basis, layers, factors, estimated
ml/costs, source version) — immutable calibration baseline. New
app/lib/ink-calibration.server.ts: read-only estimate-vs-actual comparison
(never replaces quote estimates) + owner-review recommendations (group by
printer/profile/ink type/material family; weighted factor = actual ml /
base estimated ml; min 3 finalized jobs; confidence low/medium/high) —
never auto-applied; factors become editable via
ownerConfig.inkCalibration.mimaki.* in 15F.1. Customer summary notes
"Premium ink usage is estimated for quoting and reconciled against RIP
actuals after production." Live fixture: 585 x 7.13x3.13 x 3 gloss contour
on Mimaki = $249.65 cost -> $567.39 premium READY ($107.76 machine, $10.64
CMYK, $31.91 gloss est.). Tests 612 -> 621 (new ink-calibration suite +
G.3 fixtures; two obsolete gloss-block pins rewritten); tsc 306; build
clean; no migration; Roland/DTP untouched.

## Phase 15F.0J — print pipeline + calibration ground-truth AUDIT (2026-07-25)
Audit-only. Verified: the intake pipeline is REAL and largely built —
scheduled task "GSO Print Intake Agent" (this RasterLink PC) + deterministic
ERP route-plan (ticket-first matching, white/gloss->Roland LG-640 rules,
Roland hot folder ENABLED at VersaWorks7 Input-A), SHA-256 ledger dedupe,
originals preserved in _routed-archive; RasterLink result sync uploads CSVs
into PrintLogImport/Entry with raw text/rows retained; ONE authoritative
advisory-locked ticket generator (15D.1). Gaps: no Roland result watcher
(manual export only); JobInfo->CSV converter unlocated (owner question);
no PrintIntake DB record/ticket for unmatched files; layout/pass/copies/cut
fields not explicitly parsed. Measured Mimaki sample (owner data): 2-layer
job ran 6.08 sqft/hr vs the 18.2 provisional (3x slower, feed-length
dominated) and CMYK ~1.54 ml/sqft vs the 0.6 basis — calibration data
collection is the priority; combined-layer table stays provisional.
Multi-line sticker defects CONFIRMED (lines silently ignored below count 2;
qty-0 lines vanish; primary-line replacement unstated) -> smallest first
patch 15F.0J.1. 4x5 owner-truth matrix: engine underprices the owner bag
sheet at every cell ($0.29-$1.25/bag; owner-implied margins 58-68%) ->
recommend owner 4x5 ladder as a commercial candidate + operator-labor
model + min-profit-per-machine-hour. Roland all-time CSV NOT present in
this environment — forensic methodology locked, measured tables PENDING
DATA. 13 new docs (see GSO_ERP_PRINTER_CALIBRATION_PLAN.md for the phased
roadmap). Tests 621; tsc 306; build clean; git diff --check clean; no code
or data changed.

## Phase 15F.0J.1 — Roland LG-640 all-time log forensics (2026-07-26)
Read the NAS CSV in place (1.1MB, 5,219 rows, 2026-03-26..07-24; source
untouched, never copied into the repo). 695 accepted completion records
(dupes/cancels/queue events excluded; 1,125 duplicate-completion rows +
483 exact dupes detected). MEASURED LG-640: CMYK median 18.8 sqft/hr (p75
40.4, n=127 HIGH) vs assumed 150; gloss stage 6.6 (p75 11.9, n=164 HIGH)
vs assumed 110/layer; white ~5 (n=7-14) vs 75; ink CMYK 1.05 / white 1.9 /
gloss 2.83 ml/sqft vs the 0.6 basis. Utilization ~99% (layout ~= artwork;
feed-length-driven, fixed 5-50 min per stage present; stages additive;
gloss LAYER count not inferable from logs). Elapsed is wall-clock —
medians = occupancy truth, p75 ~= run speed; final runtime rates await the
attended-vs-idle capture (J.2). Fixture impact (calibration-fixtures.csv):
1,000 4x5 +3X gloss = 5.24 assumed hr vs 42.7 (p75) - 78.4 (median) hr
occupancy; ink $73.58 assumed vs $292 measured — confirms Roland premium
work is severely underquoted; owner-ladder + occupancy pricing justified.
Anonymized derived outputs committed under analysis-output/roland/ (8
files). Docs: ROLAND_LOG_FORENSIC_ANALYSIS + ROLAND_PROFILE_CALIBRATION
rewritten with measured tables; CALIBRATION_PLAN + COST_COMPLETENESS
updated. Tests 621; tsc 306; build clean; app behavior unchanged.

## Patch 15F.0J.2 — multi-line sticker quote safety (2026-07-26)
The audited silent-loss defects are fixed: additional lines activate at
count >= 1 ("01" works; invalid counts rejected with messages); the main
sticker form is ALWAYS Line 1 (additional = Line 2+, stated in the UI);
active incomplete lines surface exact field errors, block READY TO QUOTE,
and refuse the save (never silently dropped — the qty>0 silent filter is
removed from combineStickerLines); explicit Add/Remove line buttons; full
totals panel (lines/pieces/designs/sqft/adjusted/machine/ink/cutting/
line costs/job packing once/job cost/price) + per-line detail table.
Save mirrors the loader (normalizeAdditionalLineCount + validateStickerLine
shared); snapshot multiLine block now includes Line 1 and the totals; no
schema change; DTP/other families untouched. Tests 621 -> 629; tsc 306;
build clean.

## Patch 15F.0J.3 — Roland measured ink calibration (2026-07-26)
Quote-time Roland LG-640 ink now uses the MEASURED forensic medians via the
printer-specific ROLAND_INK_CALIBRATION profile (version
15F.0J.3-roland-measured-ink; source + period + confidence + area basis
documented in the constant and every ink line's formula/note): CMYK 1.05
(HIGH n=127) / white 1.90 x SELECTED layers (MEDIUM n=14-21, never assumed
3X) / gloss 2.83 x selected STAGES (HIGH n=164) ml per layout-proxy sqft
(waste-adjusted sqft, labeled; no second multiplier), coverage 1.00
default exposed. Generic 0.6 basis retired for Roland; Mimaki paths
byte-identical (test-pinned); runtime untouched. Snapshots record the
inkCalibration block whenever any line prints Roland (primary or
multi-line row). Fixture impacts: 585-label 3X gloss job $169.82 ->
$312.71 cost / premium price $385.95 -> $710.71; plain Roland CMYK
+$9.01/100.7 sqft; 0 gloss stays $0. Tests 629 -> 635; tsc 306; build
clean; no migration.

## Patch 15F.0J.4 — RIP capture widening + Roland actuals pipeline (2026-07-26)
Shipped without schema changes: NEW app/lib/rip-capture.server.ts (pure
VersaWorks all-time parser with name-mapped colon ink arrays + dual-channel
sums, event classes, mm->in dims, elapsed seconds, source-record
fingerprints, runtime quality flags with calibration-vs-occupancy
eligibility split, calibration candidate builder, Mimaki converter
contract + widened-field extractor). Active upload branch (13A.6D)
widened: elapsed print time now captured (printMinutes was 0), _gso block
(fingerprint/flags/eligibility/matchMethod) in every VersaWorks rawRow;
manual import path gains fingerprint dedupe + canceled/error audit
handling + match-method recording; review page surfaces quality flags,
eligibility split, canceled/error audit notes, and PROBABLE-match
warnings. Roland pipeline: NAS drop folders + SECOND instance of the
existing sync watcher (tools/gso-roland-sync-config.example.json; install
steps documented, task NOT installed); one manual step remains (VersaWorks
job-log export — no supported export API). Agent v1.3 reports full SHA-256
(fileHash) alongside hash8; live task deploys by script replacement.
JobInfo converter still unlocated (negative machine search documented);
required contract published. Pricing outputs byte-identical (test 20 +
unchanged calculator suites). Tests 635 -> 650; tsc 306; build clean.

## Patch 15F.0J.4A — non-recursive print intake inbox (2026-07-26)
Root cause: the agent's recursive scan treated archive/work subfolders as
intake, so one new test file waited behind 84 unrelated files. Fix: agent
v1.4 scans Get-ChildItem -LiteralPath <root> -File (no -Recurse) — root =
inbox, subfolders never traversed regardless of name; hashing/ledger only
for top-level files; routing, ticket generation, SHA-256 dedupe, archive
moves, destinations, API all unchanged. Self-test rewritten (root
pdf/ai/tiff/png eligible; 1-level and deep subfolder files ignored; 200
nested files leave the scan result unchanged; cutoff/reservation/claims
intact) — 0 failures; repo pin test added. Tests 650 -> 651; tsc 306;
build clean. Deploy by replacing the live task's script.

## Patch 15F.0J.5 — automatic print-intake job creation + linking (2026-07-26)
Dropped files no longer require ANY pre-existing quote/job: exact matches
reuse the existing job/ticket (13A.6G ladder unchanged); unmatched files
with deterministic printer/mode (safe filename hints — premium -> Roland,
explicit tokens, default CMYK -> Mimaki; bare "3x"/"White Widow" hazards
protected; conflicts block) AUTO-CREATE one PrintIntake record + one
controlled ProductionJob via the SAME advisory-locked ticket generator
(idempotent on shop+full-SHA-256: lock + in-transaction recheck + P2002
backstop). Nothing commercial fabricated (qty 0, $0, "Unlinked (print
intake)", source=print_intake, event logged); jobs appear on the Production
Board for later quote/order/customer linkage; routed copies named
<TICKET>__<PRINTER>__<MODE>__<SAFE-ORIGINAL>__A1 so RIP actuals match by
ticket automatically. Route-plan API records matched-file linkage and
returns routeable auto-created plans with linkage WARNINGS (needs_review
retired for deterministic files; true blockers still review). Agent v1.5
sends full hash+size on the plan call; archive-after-verified-route order
test-pinned. SCHEMA: focused PrintIntake migration CREATED but NOT applied
(deploys via npm run setup; rollback = drop table). Live fixture "GSO
PIPELINE TEST_3X SPOT GLOSS_Roland.pdf" -> Roland GLOSS-3X auto-create,
test-pinned end-to-end at the pure layer. Tests 651 -> 663; tsc 306; build
clean; agent self-test 0 failures.

## Patch 15F.0J.5A — print-intake auto-create transaction fix (2026-07-26)
Live-deploy failures fixed: advisory lock cast to ::text (VOID
deserialization error gone; lock still held; blanket catch narrowed —
only SQLite skips, real failures throw advisory_lock_failed); nonexistent
ProductionJob.source removed from create (PrintIntake owns provenance via
generatedProductionJobId + created_from_print_intake event + markers).
Route-plan catch returns actionable safe error codes with connection
strings redacted. New fixture pinned: "GSO PIPELINE TEST 3_1X SPOT
GLOSS_Roland.pdf" -> Roland GLOSS-1X (the bare "3" never counts) ->
GSO-...__ROLAND__GLOSS-1X__...__A1. Rollback-on-failure and duplicate-hash
reuse re-pinned. Tests 663 -> 665; tsc 306; build clean; agent self-test 0
failures; no schema change (migration from J.5 unchanged, already applied
in production).

## Patch 15F.0K.1 — ownerConfig plumbing + Pricing Settings (2026-07-26)
First slice of the 15F.0K market-calibration plan (audit approved; K.2-K.5
NOT started). NEW app/lib/owner-config.server.ts: validated JSON envelopes
in ErpAdminSetting (category OwnerConfig, valueType json, @@unique shop_key)
— { schemaVersion:1, payload, updatedAt, updatedBy (resolveActorFromSession),
note (required >=5 chars), previous (last-good envelope minus its own
previous; one-step restore) }. Fail-closed contract: missing row ->
code_fallback, corrupt/invalid -> invalid_config_fallback with exact reason;
validation all-or-nothing per key (no partial merges); validators reject
non-finite/zero/negative/over-cap values so a bad config can never zero or
corrupt a price; db failure -> code constants. K.1 wires EXACTLY three keys:
ownerConfig.pricing.minimumGrossProfit / .minimumOrderTotals /
.areaFloorBands. minimumUnitPrices is deliberately NOT read (unit floors
activate in K.2 — a rogue row is ignored, test-pinned). Commercial pricing
stays pure: computeCommercialPrice/combineStickerLines gained OPTIONAL
policyValues (absent = code constants, byte-identical — equivalence
test-pinned); the calculator loader AND save action resolve config once via
resolvePricingPolicyConfig and pass it through (loader/save parity). New
staff page /app/erp/pricing-settings (route registered + nav link): per-key
source badge (owner_config / code_fallback / invalid_config_fallback +
reason), effective values, edit forms with required change note, Restore
previous, and confirm-gated Reset to code defaults; component consumes
loader data only (no .server import in the client graph). Research margin
curves, market targets, unit floors, rounding, and override changes are NOT
loaded — with no saved config every price output is unchanged. DTP pipeline
untouched. Tests 665 -> 684 (19 new: defaults mirror constants, K.1
key-scope pin, validator rejections, envelope fail-closed parsing, resolver
shop-scoping + rogue-key ignore + db-failure fallback, save/restore/clear
audit + one-step previous, computeCommercialPrice/combineStickerLines
equivalence, wiring direction proof). Full suite 684; build clean; no
migration; no Shopify/intake/production/DTP surface touched.

## Patch 15F.0K.2 Stage A — config margin bands + tier ladders, equivalence-locked (2026-07-26)
Structural stage ONLY (research calibration = Stage B, NOT started). Margin
resolution is now per-family quantity BANDS resolvable through ownerConfig:
NEW keys ownerConfig.pricing.marginCurves ({families:{key:{familyMinPct,
bands:[{minQty,targetPct}]}}}) and ownerConfig.pricing.tierLadders
({defaultLadder, families:{canonical-ui-family:[qty...]}}) with strict
validators (curves: exactly the 8 configurable families required —
dtp-pouches + provisional-universal REJECTED (code-only), optional
allowlisted variant bags-4x5-double, first band minQty MUST be 1, strictly
ascending, targetPct 40-95 and >= familyMinPct; ladders: the 6 calculator
families required, dtp-bags REJECTED, 1-16 strictly ascending integers).
Stage-A defaults are the EXACT positional translation of the five-point
curves at the global edges: bands at minQty [1,128,256,640,1000] (1, not 64
— quantities 1-127 always took curve[0]) with every familyMinPct preserved;
ladders [64,128,256,640,1000] for every family. ONE shared resolver
(resolveMarginPctForQuantity: config bands -> positional rule ->
40% floor) now feeds computeCommercialPrice AND both route tier-default
maps (loader/save parity); marginCurveKeyFor gives double-sided 4x5 bags
the bags-4x5-double variant key, which falls back to bags-4x5 while no
config entry exists — sides price identically (test-pinned). DTP ladder
stays DTP_LADDER_QUANTITIES in code; a posted eqty list still overrides
config ladders. Pricing Settings gained editors for both keys (band text
format minQty:targetPct, per-family ladders, note/restore/reset). NO
research values loaded — with no saved config every price, candidate,
controlling rule, and snapshot field is byte-identical (oracles: untouched
dollar-pinned forensic/production-ready/DTP suites + NEW
tests/margin-curve-equivalence.test.ts proving old==new at every band
boundary for all nine families). Three obsolete STRUCTURE pins updated to
the new mechanism with the same invariants (production-ready loader/save
parity pin, dtp ladder-branch pin, product-driven curve/floor pin) — no
numeric expectation changed anywhere. Tests 684 -> 698; build clean; tsc
306 = baseline; no migration.

## Patch 15F.0K.2 Stage B — 4x5 bag research calibration (2026-07-26)
DELIBERATE repricing, owner-approved values only — 4x5 sticker-applied bags
and their display ladder; NOTHING else. Code defaults now carry the
study-calibrated curves: bags-4x5 single 1:65/128:64/256:61/500:58/640:57/
1000:55/1500:52/5000:50 and NEW bags-4x5-double 1:65/128:61/256:58/500:54/
1000:52/1500:49/5000:47 (both familyMinPct 45; 40% global floor untouched;
band 1 held at 65 so quantities 1-127 never reprice and NO price decreases
anywhere — engine-proven old-vs-new per approved ladder quantity,
test-pinned). Double-sided jobs (pfaces>=2) now price on their own curve
via the K.2-A variant key; clearing the config entry still falls back to
the single curve. Display ladder: sticker-bags 11-point
64/128/256/500/640/1000/1500/2000/2500/5000/10000 (other families + DTP
ladders unchanged). Exact anchors at 1,000 (costs UNCHANGED 317.68/534.02
— margin-only): single $577.59@45% -> $705.95@55%; double $970.94@45% ->
$1,112.54@52%. Positional FAMILY_MARGIN_RULES deliberately untouched
(legacy fallback-panel reference); ownerConfig overrides keep working; no
unit floors, market targets, crossover warnings, rounding, rush, holo, or
override changes; jars/DTP/labels/banners byte-identical (dollar-pinned
suites untouched except the two bag fixture rows). Fixture book rows 8/9
updated with the intentional-calibration note; owner-decisions ledger
updated (item 18 partially landed; unit floors pending).
margin-curve-equivalence suite restructured: non-bag equivalence still
enforced per boundary; new Stage-B pins (exact curve values, side spread,
64-unit unchanged, no-decrease proof, cleared-config fallback). Tests 698
-> 706; build clean; tsc 306 = baseline; no migration.

## Patch 15F.0K.3 — verified market targets for 4x5 bags (2026-07-26)
Owner decision implemented: standard 4x5 sticker-applied bags normally
target the VERIFIED competitor median — a RAISING-ONLY market-target
candidate in the commercial max() for EXACTLY bags-4x5 + bags-4x5-double
(validator rejects every other family; jars/DTP/direct-print/labels/
banners/specialty carry no market pricing). NEW key
ownerConfig.pricing.marketTargets (active/sourceDate/source/confidence per
family; bands minQty/low/median/high/target/negotiationFloor/premiumTarget/
crossover; strict validation, fail-closed to the ACTIVE code defaults from
the 2026-07-26 study). Shipped ACTIVE: anchors at 1,000 = single $0.85/unit
($850.00; cost-based candidate 705.95 unchanged) and double $1.13/unit
($1,130.00; cost-based 1,112.54). Targets are NULL at 5,000+ so they never
hide the direct-print crossover — cost-based pricing + STRONG advisory +
LIVE Spektra DTP 4x5x2 comparison (ownerPriceForQuantity, display only, no
auto-conversion); 2,500 = mild "price check" advisory. Researched floors =
negotiation-floor DISPLAY data only (below-floor -> stronger warning; never
a block or auto-raise — owner decision keeps unit floors inactive). An
explicit staff per-tier margin edit takes command: the target stops
contending and below-target/below-negotiation-floor badges show
(marketPosition block on every commercial result + quote snapshot);
margin floors and the OWNER MARGIN OVERRIDE gate unchanged. Disabling a
family restores Stage-B outputs exactly (test-pinned). UI: tier-row market
line + AT MARKET TARGET / ABOVE MARKET / BELOW MARKET TARGET / BELOW
NEGOTIATION FLOOR badges, customer-summary market-position line, crossover
banner, Pricing Settings market-target editor. Candidate validator lesson:
negotiationFloor is GSO's own floor and legitimately exceeds the collapsed
market band at crossover tiers — bounded only by positivity/cap. Fixture
book rows 8/9 updated (second deliberate bag change, documented); DTP/
jars/stickers/banners and all COST pins byte-identical. Tests 706 -> 722
(new tests/market-targets.test.ts: anchors, raising-only proof,
disable-restores-Stage-B, allowlist, crossover skip, warnings-never-price,
override-takes-command, validator + squeeze-data acceptance, fail-closed
fallback, resolver); build clean; tsc 306 = baseline; no migration.

## OWNER-VERIFIED SPECIALTY PRINT AND PRICING STANDARDS (2026-07-26)
Authoritative owner-confirmed standards, implemented in 15F.0K.4B:
- **Mimaki UCJV300-130 is CMYK ONLY.** It must never price white ink, clear
  ink, gloss, spot gloss, layered gloss, or raised-gloss work. Any such
  request BLOCKS with "Mimaki UCJV300-130 is CMYK ONLY" and routes to Roland.
- **Roland TrueVIS LG-640** handles CMYK, white, clear/gloss, spot gloss,
  layered gloss, and raised-gloss work.
- **Standard print setup: $1.00 per design/job** ($25/hr at 25 jobs/hr).
- **Gloss-layer Illustrator setup: $6.25 per applicable gloss design**
  ($25/hr at 4 jobs/hr) — charged ONCE per design that needs a gloss mask,
  NEVER multiplied by stage count (one design at 1X-7X = one $6.25; four
  gloss designs = $25.00); separate from standard print setup; white-only
  work does not receive it.
- **Gloss coverage: 90% ESTIMATED before final artwork/gloss-mask analysis
  (estimated_pre_art); the ACTUAL artwork percentage overrides when entered
  (actual_artwork).** Valid range 0-100, never defaulted to 100, out-of-range
  BLOCKS. Coverage scales gloss INK; stage machine time follows layout area.
  Lower actual coverage improves realized margin and never retroactively
  reduces an approved customer price (snapshots are immutable).
- **Machine recovery: $8/hour** (machineRatePerHour, env-overridable) —
  now used by BOTH the product-driven calculator AND the recipe-pricing
  engine (stale Machine.costPerHour can no longer underprice recipe quotes);
  live Machine records and presets corrected to $8.
- **Miron 100 ml tall authoritative base jar+lid cost: $2.78** (owner-approved
  2026-07-17 VendorProduct ladder 2.78/2.54/2.31/2.14/1.99; the stale $2.86
  Material duplicate is aligned).
- **Holographic media: $0.714146/sqft is authoritative** ($488 roll at
  50in x 164ft, owner-approved 13.2.4) — never $0.6624.
- **Stickers/labels minimum order total: $45** (ownerConfig, audited envelope).

## Patch 15F.0K.4B — Roland gloss routing + verified setup costs (2026-07-26)
Owner-verified standards above implemented in ONE patch. ENGINE
(product-driven-costing): Mimaki white/gloss requests BLOCK with the exact
CMYK-only capability line and layers zero (the 15F.0G.3 provisional Mimaki
gloss estimate is QUARANTINED/unreachable; Mimaki CMYK costing untouched);
NEW gloss_setup line $6.25 x designs (once per gloss design, never per
stage; inside setupTotal; white-only never charged); NEW glossCoveragePct
input — 90% estimated_pre_art default, actual_artwork override, 0-100
validated (out-of-range blocks), applied to Roland gloss ink (machine stage
time stays layout-driven); Roland gloss ink now = adjSqft x coverage x
stages x 2.83 x $0.19867. RECIPE ENGINE: machineHourlyCost =
machineRatePerHour() ($8) — stale Machine.costPerHour records can never
underprice again. ROUTE: pglosscoverage param (loader/save/multi-line
parity + UI field), snapshot inkCalibration gains
glossCoveragePctUsed/glossCoverageSource. Machines page presets $5->$8 +
LG-640; stale LG-540 display strings fixed (calendar label keeps lg-540
MATCHING for history). DATA (tools/apply-15f0k4b-data-corrections.mjs, run
once, before/after logged): Miron tall Material 2.86->2.78 (+history),
4x5 bag Material 0->0.09 (+history), both machines $5->$8 + Roland renamed
LG-640, ownerConfig minimumOrderTotals stickers-labels=45 (audited
envelope), blank pouch renamed "(unprinted)". FIXTURE REPRICES (deliberate,
Roland gloss only): 585x3X job cost 312.71->314.47 (gloss ink -10% coverage
+ $18.75 gloss setup), premium price 710.71->714.71; contour twin
317.61->319.37 / 725.84; ALL Mimaki premium fixtures now pin the CMYK-only
block. UNCHANGED (guardrails): 4x5 bag targets ($0.85/$1.13 @1,000
re-pinned), margin curves, DTP ladders, Chiron, holographic, application
labor, area floors, crossover behavior. NEW
tests/specialty-print-standards.test.ts (22: routing matrix, setup
once-per-design proofs, coverage validation/monotonicity, recipe-$8 proof,
preset pins, $45 config resolution, bag regression). Tests 722 -> 744;
build clean; tsc 306 = baseline; no migration.

## Patch 15F.0K.4C — specialty jobs vs standard market targets (2026-07-26)
The verified 4x5 market table is STANDARD matte/gloss data — premium
specialty jobs must never be compared against it. NEW pure classifier
specialtyFinishReasons (white ink / gloss stages / holographic-or-specialty
material; Poseidon matte+gloss = standard) feeds
computeCommercialPrice.marketTargetSpecialtyReasons (loader + save parity).
When non-empty: the market-target candidate stops contending (cost-led
premium pricing controls), comparison flags are suppressed (no
ABOVE MARKET +86/97/129% badges, finalVsMedianPct null, no below-target/
negotiation-floor warnings), and marketPosition carries applicable:false +
reasons + the exact messages ("Specialty finish selected — standard 4x5
market comparison is not applicable..." / "Standard matte reference only —
not a like-for-like specialty comparison."), with low/median/high preserved
as labeled reference data. Crossover advisories, costs, margin curves,
15F.0K.4B gloss setup/coverage, and DTP are byte-untouched; NO specialty
market table or invented 1X-7X medians. Standard bags unchanged
($0.85/$1.13 at 1,000 re-pinned). Tests 744 -> 751 (7 new: classifier
matrix, per-X skip proofs, white/holo skips, cost-led retention,
no-misleading-percentage, standard+crossover regression, route wiring +
message pins); build clean; tsc 306; no migration; no DB changes.

## Patch 15F.0K.4D — Pricing Intelligence evidence capture foundation (2026-07-26)
Minimum safe foundation so every future quote becomes usable pricing
evidence — NO automatic targeting, NO tiny-sample statistics, NO Shopify
order ingestion yet. SCHEMA (migration
20260726230000_add_quote_outcome_fields, two nullable Quote columns,
applied + verified: 5 quotes readable): outcomeAt / outcomeReason. QUOTE
OUTCOMES: status vocabulary gains won/lost/canceled/expired via the pure
resolveQuoteOutcomeChange helper — lost/canceled REQUIRE a reason (>=3
chars, server-enforced), won/expired stamp outcomeAt (reason optional),
draft/sent CLEAR outcome fields, existing ladder statuses untouched;
marking WON respects the low-margin acceptance gate (same as
sent/approved), NEVER creates a production job, NEVER sends email; the
paid->production conversion behavior is unchanged (test-pinned). Quotes
board UI: Mark Sent/Won/Lost/Canceled/Expired buttons + required-reason
field + outcome display. NEW app/lib/pricing-intelligence.server.ts: ONE
conservative shared test-data exclusion (test_ source ids, ALL-CAPS TEST
token, known audit artifacts incl. CMYK Routing Test / NoProduction /
PIPELINE TEST, test emails, [TEST DATA] markers, non-positive qty/price;
reasons returned; common words like "Taste Test Kit" NEVER silently
excluded), conservative basket classification (family/size/finished-vs-
labels/sides/material/white/gloss-stage/qty-band; snapshot selections win;
4X never equals 3X; unknown is its own segment and can never contaminate a
precise basket), hashed customerKey (sha256, identities never leave the
loader), and THRESHOLD-GATED aggregation: accepted low/median/high are
withheld until >=5 accepted + >=3 distinct customers + >=2 distinct months
("Not enough verified sales history yet" / "Insufficient customer
diversity" / "Insufficient time coverage"); eligibility is ADVISORY-ONLY
and creates no market target (pinned). NEW read-only page
/app/erp/pricing-intelligence (route + nav; loader-only, zero writes):
summary cards (reviewed / eligible / excluded / won / lost / open /
distinct-customer COUNT), per-basket readiness table, excluded-records
audit list, and the visible notice "Shopify historical-order evidence is
not yet connected. Current counts are based only on locally stored ERP
records." The evidence-record type carries source erp_quote /
production_job / shopify_order (reserved) so the later Shopify source slots
in without redesign. WHY THRESHOLD-GATED: the 2026-07-26 audit found only
~5-7 genuine accepted line items in all history — tiny-n medians would be
misleading. Tests 751 -> 771 (20 new); build clean; prisma validate clean;
tsc 306 = baseline.

## Patch 15F.0K.4E — Shopify historical-order evidence pull (2026-07-26)
Adds the Shopify order history as a SECOND read-only evidence source for
/app/erp/pricing-intelligence. SCOPE: shopify.app.toml scopes gain
read_all_orders (owner-approved; write_orders deliberately ABSENT and
test-pinned absent). NOT YET LIVE until the owner runs `shopify app
deploy` and reauthorizes the app in admin; until then order queries still
work under read_orders but only cover Shopify's recent (~60-day) window —
the page states this and degrades gracefully (no auth loop: the installed
token already authorizes the orders resource; this mirrors the 12B.2b.1
lesson). NEW app/lib/shopify-pricing-evidence.server.ts (read-only):
cursor-paginated Admin GraphQL order pull (50/page, 20-page defensive cap
with visible TRUNCATED flag; minimal fields — no addresses/phone, pinned),
normalization into the SAME 4D evidence records: order-level rules (test
orders / canceled / non-PAID+PARTIALLY_REFUNDED financial statuses / fully
refunded orders excluded with reasons; PARTIALLY_PAID excluded — no owner
policy), line-level rules (gift cards, refunded lines excluded
conservatively even when partial, shared 4D test-data exclusion, free/
zero-net lines, unclassifiable lines kept out of every basket), NET
selling price = gross line total − ALL allocated discounts (line + order
level; shipping/tax never included); missing price/discount data marks the
line pricingIncomplete and it NEVER enters medians. Classification reuses
the 4D classifier with new structured attributeText input (line
customAttributes + productType beat title inference; 4X≠3X, sides/finish/
form never mix — pinned). PRIVACY: customer id/email are hashed
server-side during normalization (guest orders get a stable per-order
key); raw identity never leaves the module, never serialized (pinned).
STORAGE: normalized summary cached in ErpAdminSetting
(pricingIntelligence.shopifyEvidence, JSON) — chosen over a new Prisma
model because volume is tiny, JSON-in-ErpAdminSetting is established
precedent (ownerConfig), no migration needed, and cached rows are already
normalized + privacy-safe; corrupt cache degrades to "not refreshed",
never breaks the page. PAGE: staff-triggered "Refresh Shopify evidence"
action (the ONLY fetch path — nothing automatic), last-refreshed timestamp
with STALE flag at 7+ days, per-source basket columns (ERP vs Shopify stay
distinguishable while combining toward the SAME 4D thresholds), summary
counts (local eligible, Shopify eligible/excluded/incomplete, evidence
window earliest→latest), access-blocked state shows the exact required
message ("Historical Shopify order access is not yet authorized.
Reauthorize the app with read_all_orders to include orders older than
Shopify's standard recent-order window."), refresh failures are cached as
a visible failed state and the rest of the page keeps working. NO Shopify
writes anywhere (query-only, pinned), NO automatic pricing from evidence,
thresholds/advisory-only behavior unchanged. Tests 771 -> 805 (34 new:
scope pins, order/line eligibility, net-price math, attribute
classification, privacy, combined-threshold aggregation, pagination cap,
blocked-state detection, cache round-trip + corruption, page wiring pins);
build clean; tsc 306 = baseline; no migration.

## Patch 15F.0K.4G — correct pricing evidence classification (2026-07-27)
Accuracy corrections from the 4F audit — evidence gets MORE honest, never
more invented. WHITE INK: bare "white" is COLOR vocabulary ("Matte Vinyl /
White / Front Only" is a white BAG; "3oz Black/White Jar" is the jar color
program; Bag Color / Jar Color values are colors) and NEVER implies white
ink; white classifies ONLY from explicit ink/layer context (white ink,
white layer(s), "+ White", white underbase, numeric whiteLayers, snapshot
selections). Explicit whiteLayers 0 stays 0; missing stays unknown, never
assumed zero. The 4 false white:1+ rows found in 4F all correct to
unknown (verified against production read-back: 0 white:1+ remain). JAR
LABEL ZONES: jar families take sides ONLY from the explicit label-zone
vocabulary (Label Set attribute / materialSummary / exact configurator
tokens): Side Only -> side, Lid Only -> lid, Side + Lid -> side_lid,
Side + Lid + Bottom -> side_lid_bottom, Side + Lid + Lid Side ->
side_lid_lidside; zones never merge; generic double/single tokens and
snapshot faces are IGNORED for jars because the paid-order webhook stamps
a meaningless "Double Sided" default into jar priceSnapshots (4F
finding). Both historical jar rows recover side_lid. SIZE: SIZE_RE is now
case-insensitive ("100ML Tall" parses), ml sizes keep orientation
(100ml-tall / 100ml-wide / bare 100ml are three segments), and decimal
dimensions are preserved (the 14x18 rows correctly become 14x18.6 —
distinct from a true 14x18). DEDUP: one Shopify sale = ONE accepted row.
gatherPricingEvidence takes a ShopifyEvidenceContext (built from the
cache); production-job twins of counted Shopify lines are excluded as
"Duplicate of Shopify order-line evidence" via exact id joins (primary:
priceSnapshot.lineItemId vs the Shopify line id digit-tail; fallback:
order id from quoteId shopify_order_<id>, both numeric and gid forms).
Shopify wins (realized net price, discounts, test flag, refund state).
Fixes the #1008/#1009 double count AND the doubled distinct-customer
counts (per-source hashes differed). Jobs are never deleted — dedup lives
only inside evidence gathering. TEST PROPAGATION: normalization now
returns excluded test orders (id digit-tail + order name, privacy-safe;
cached as testOrders); ERP jobs whose exact ids match are excluded as
"Paid by Shopify test order" (the Ritz #1007 leak). Names are NEVER used
to auto-exclude — "Apples Banana Pebbles" stays counted. STAFF REVIEW:
new page section for suspicious-but-not-deterministic evidence (still
counted): accepted quotes whose payment notes reference a Shopify test
order name (production read-back flags 2 quotes, #1010/#1011 payments),
and classification conflicts between a deduped twin and its Shopify line.
No customer names/emails anywhere. MATERIAL SUMMARY: job records feed
materialSummary (the webhook's clean "Key: Value | ..." echo of real line
properties) through the same classifier path as Shopify attributes;
priceSnapshot is used ONLY for id joins, never classification. REFRESH:
next staff refresh rebuilds classifications; the action compares basket-
key multisets and appends "Historical evidence was reclassified using
updated deterministic rules." when history reclassified. Old caches load
cleanly (testOrders optional). VERIFIED against production (read-only
simulation): 12 Shopify rows -> sides unknown 2->0, white:1+ 4->0 (all
unknown now — no real white evidence exists), gloss unknown stays 10
(2024 rows are honestly unrecoverable); 2 job twins deduped; 1 test-order
job excluded; combined accepted 17 -> 14; 4x5 gloss basket reaches 5
accepted but stays WITHHELD (1/3 customers, 1/2 months); every basket
ineligible, every median withheld, no market target, no repricing, no
Shopify writes, no migration. Tests 805 -> 833; build clean; tsc 306 =
baseline.

## Patch 15F.0K.4H — live sales evidence cutoff (2026-07-27)
OWNER CONFIRMATION: every Shopify order, paid quote, and production job
visible in Pricing Intelligence at activation was a TEST — zero real
storefront sales existed. New owner-controlled cutoff
pricingEvidenceLiveFrom (ErpAdminSetting `pricingIntelligence.liveFrom`,
audited JSON envelope: iso / owner note / changedAt / source / previous;
NO migration). Evidence dated STRICTLY BEFORE the cutoff is excluded from
every source (Shopify order lines during normalization; quotes and
production-job items during gathering — and any future source through the
same isPreLaunchEvidence helper) with the exact reason "Pre-launch test
evidence — before owner-approved live-sales start date": it never counts
as accepted evidence, a distinct customer, a distinct month, an
exact/near match, or a median input, and never feeds a market target.
Records are RETAINED (nothing deleted) and stay visible in the excluded
audit list plus a new "Pre-launch test evidence" summary card. Evidence
exactly AT or after the cutoff is eligible under all existing rules — the
cutoff is NOT a replacement for normal test detection (Shopify test
flags, test_ ids, [TEST DATA], shared helper, refund/cancel/dedup rules
all still apply afterward). DATE BASIS: Shopify processedAt (createdAt
fallback); quotes outcomeAt -> updatedAt ONLY for accepted/paid ->
createdAt (an open quote touched after launch can NOT be rescued by
updatedAt); jobs createdAt (their Shopify-linked orders govern the
Shopify record itself). STALE-CACHE DEFENSE: the page loader re-applies
the cutoff to cached Shopify records, so a cache refreshed before 4H can
never keep pre-launch rows eligible; the next staff refresh rebuilds the
cache and appends "Historical evidence was re-evaluated using the
owner-approved live-sales start date." STAFF REVIEW: pre-cutoff records
are no longer flagged for manual judgment (the cutoff already
deterministically excludes them) — the two 4G-flagged quotes (#1010/
#1011 payments) and Apples Banana Pebbles need no individual [TEST DATA]
notes for Pricing Intelligence anymore; [TEST DATA] remains supported for
future isolated tests. SETTINGS: read-only display on
/app/erp/pricing-settings (value + owner note + changedAt + source) with
explicit copy that moving the date is an owner action; the activation
script tools/apply-15f0k4h-live-from.mjs REFUSES to overwrite an existing
value without FORCE_15F0K4H=1 + a >=5-char CHANGE_NOTE, keeps one-step
`previous`, and can never clear the value. Missing/corrupt config
resolves to NO cutoff with a loud red warning on both pages (never a
silent exclude-everything). PRODUCTION ACTIVATION: script run once —
stored iso pins the live-from moment; verified read-back plus a read-only
pipeline simulation confirming Shopify eligible 0, local accepted 0,
combined accepted 0, distinct customers 0, all historical records listed
as pre-launch excluded, every median withheld. Nothing repriced; $0.85/
$1.13 @1,000 bag pins unchanged. Tests 833 -> 849.

## Phase 15G.1 + 15G.1A — security/data-safety lockdown (2026-08-09)
Commits d758e20 + 2f358b6. Both public configurator proxies now require
authenticate.public.appProxy (shop from session only, wildcard CORS removed,
cost/margin fields stripped from public payloads, checkout errors sanitized);
shop-scoping enforced on Machines/Materials/WholesaleRule/configurator-audit;
phrase gates: OWNER SHOPIFY PRICE PUSH (Margin Review), OWNER RESET SETTINGS
(Admin Settings — reset now deletes ONLY the page's own keys, never
ownerConfig.* / pricingIntelligence.*), RESET STOCK BAG PILOT (Configurator
reseed, now transactional and never loader-triggered); Machines loader no
longer auto-seeds; recipe delete + pricing-rule replace transactional;
production-agent credentials masked everywhere (loader JSON carries only
configured/****suffix; rotation reveals the new token exactly once; owner
must rotate the audit-exposed token after deploy). Shared helpers:
app/lib/security-guards-shared.ts. Tests 849 -> 886.

## Phase 15G.2 — single price truth (2026-08-09)
CANONICAL PRICING AUTHORITY (do not fork): ad-hoc/calculator jobs price via
computeProductDrivenCost + computeCommercialPrice (ownerConfig via
resolvePricingPolicyConfig); persisted recipe products price via
priceRecipeAtQuantity + blockingConversionIssues. Shared authorities under
both: owner-standards registry (labor/setup/application; machine recovery $8
— machineRatePerHour() is the one env-aware accessor, MACHINE_RATE_CURRENT is
bound to it), app/lib/ink-rates-shared.ts (Mimaki 176/1000, Roland 149/750,
Mimaki gloss null = CMYK-only; buildBrandRates + the recipe engine + the
calculator all read it), material cost = calculatedUnitCost -> costPerUnit
ONLY (raw purchaseCost is NEVER a pricing unit cost — fail-closed Cost
Review; blockingConversionIssues flags purchase-cost-only materials).
CONVERGED SURFACES: Quotes/CRM no longer loads/consults ProductCost or
PricingRule — Shopify search resolves quote-ready recipes server-side
(variant GID -> product GID -> SKU); matched lines auto-price through the
recipe engine, unmatched lines are explicit manual_unsupported with the
reason (Shopify list price is reference only, never auto-filled). Printable
work order actuals use computeEntryCosts + machineRatePerHour (retired $5/hr
+ old ink literals deleted). Margin Review cost/suggested price = canonical
recipe engine output (its private model is diagnostics-only; per-side
application floor demoted to reference; purchaseCost fallback removed; 15G.1
push gate intact). Pricing Rules preview prices from canonicalStockBagJob
(app/lib/canonical-bag-pricing.server.ts) — its hardcoded cost model
deleted; rule prices below the canonical recommendation are flagged, never
silently chosen. Configurator admin shows Canonical ERP Recommendation next
to the ConfiguratorPricingRule price, which is now labeled Legacy Storefront
Price (storefront ladder itself BYTE-UNTOUCHED — convergence is 15G.5).
SNAPSHOT STANDARD: app/lib/pricing-snapshot.ts
(15G.2-canonical-snapshot-v1) — Quotes recipe lines embed it; historical
snapshots never rewritten. LEGACY REMAINING (compatibility/history only):
ProductCost + PricingRule tables (rule metadata still edits via
/app/erp/pricing-rules; no pricing consumer besides that preview),
ConfiguratorPricingRule (live storefront until 15G.5), SourcedCostTier,
erpAdminSetting.defaultMachineRecoveryHr (reference-only, flagged stale in
Calibration + Admin Settings). Machine seed presets reconciled to canonical
ink rates (149/176). Owner pins re-proven end to end: 1,000 single $0.85 /
double $1.13; 500 double 3X @55% = $452.37 cost -> $983.41 @54%; Mimaki
CMYK-only; specialty market suppression. OPEN OWNER QUESTION: the 15G.2
brief described 4x5 bag application as 180 bags/hr @ $20 ($0.1111/label) but
the owner-verified registry (2026-07-24) says 256/hr ($0.078125/label) — the
registry value remains live; confirm which is correct (one-line
owner-standards edit if 180/hr is right). Tests 886 -> 906 (rip-actual-costs
missing-channel pin updated deliberately: canonical rates now price Mimaki
white actuals). No live Shopify prices changed.

## Phase 15G.2A — bag application throughput clarification (2026-08-09)
Owner-confirmed: application unit = applied LABEL (front+back bag = 2
labels). NORMAL 256 labels/hr @ $20 = $0.078125/label stays the one
canonical rate (engine already charged rate x quantity x faces — verified,
no pricing change). NEW conservative reference 180 labels/hr =
$0.111111/label added as owner-standards
bagApplicationPerLabel4x5Conservative + BAG_APPLICATION_THROUGHPUT (never
used in quoting). Corrected stale references: cost-verification-shared
LABOR_STANDARDS bag row (was "180 bags/hr" with per-side math), Margin
Review assumption copy + floor row labeled diagnostic-reference-only.
Example math pinned in tests/bag-application-standard.test.ts (500x1 =
$39.0625, 500x2 = $78.125, 1000x2 = $156.25; conservative 55.5556/111.1111/
222.2222). Tests 906 -> 912 (one stale cost-verification pin updated deliberately).

## Phase 15G.3 — canonical cost calculator simplification (2026-08-09)
/app/erp/cost-calculator is now SINGLE-ENGINE for staff: the canonical
product-driven flow (product -> job specs -> Calculate -> cost breakdown ->
commercial price -> tiers -> save) is the only normal path. Legacy tooling
(legacy per-line calculator, GSOQ sync diagnostics, 14B.1 auto-costing mode)
renders ONLY behind the explicit ?legacytools=1 opt-in, labeled "Legacy /
Unsupported Job Calculator — NOT canonical pricing"; the auto mode is
inert without the flag (loader + save parity). The emergency/manual tier
generator renders only when NO product family is engaged (labeled
manual/unsupported, no floors/market targets) — supported products show the
canonical tier table only. Manual cost-entry fields (variable/setup/blank/
waste) hide whenever a product drives the engine; the details section is
renamed "Advanced Overrides" (tier quantities, per-tier margins, freight,
owner override — job-level only). STALE PRESETS: the five Miron code
ladders (incl. the retired $2.86 100ml-tall base) are DELETED — Miron
resolves only through VendorProduct tiers ($2.78 approved ladder); the save
action now prefers a current DB Vendor Product for any preset: id and never
labels a code preset "verified" (remaining presets: customer-supplied, 4x5/
OZ/pound bags, SAFE CARE jars, soda can — all marked estimated at save).
NEW result-card blocks: specialty-gloss explainer (coverage basis 90%
pre-art vs actual mask; $6.25 Illustrator setup charged ONCE per design
never per stage; stage machine time location) and a compact trust card
(engine, $8/hr machine standard, 256 labels/hr application, cost-source
status, Mimaki CMYK-only / Roland specialty, policy source). Saved
calculator quotes embed the 15G.2 canonical snapshot (recomputed by the
action — posted totals still never trusted). No formula changes: all
dollar pins byte-identical ($0.85/$1.13 @1,000; 500 double 3X @55% =
452.37/983.41; 256 labels/hr; Mimaki CMYK-only). Four stale 14B.1B/14C
layout pins updated to the new structure. Next: 15G.4 specialty/gloss
commercial pricing research. Tests 912 -> 921.

## Phase 15G.4C — UV specialty pricing policy (2026-08-09)
Owner-approved 15G.4B model implemented. commercial-pricing-policy:
BAGS_4X5_FRONT_LADDER + BACK_LABEL_PREMIUM_BANDS (double = front+back,
5000+ target null), SpecialtyPricingValues + defaults, computeCommercialPrice
`specialty` input — specialty candidate = base x additive(holo+curve) with
$35/$60 small-run minimums, 40% floor (marginMath at floorPct), specialty
contenders REPLACE the cost-plus primary, DEEP_BUILD_MESSAGE at 9X+;
result.specialty context block. owner-config: PRICING_SPECIALTY_KEY +
validateSpecialtyPricing (fail-closed, additive-only, non-decreasing curve).
Calculator route: specialty context loader+save (holo from material name;
white = decorative unless holo → requiredWhite), $25 pfileprep customer
charge (never internal cost), specialty explainer card (base/tier %/holo %/
candidate/floor/"Cost safety floor controls this quote."/deep-build/file
prep/required-white notes); canonicalStockBagJob passes the same context
(admin previews stay parity-equal). DELIBERATE repricing pins updated:
1,000 single 850→1050, double 1130→1450; 500 dbl 3X commercial 983.41→960
(direct cost 452.37 UNCHANGED); 2,500 double target now controls (3,300);
64-unit band-1 rule superseded by the qty-50 ladder start (raising-only
proven). Direct-cost engine byte-untouched (pinned). New
tests/uv-specialty-pricing.test.ts (12: ladders, back premiums, 5000+ null,
1X-8X finals matrix @90 floors, minimums, deep build, holo additive vs
compound, white treatments, heavy-combo floor, validator, wiring). No
Shopify/storefront changes (15G.5). Tests 921 -> 933.

## Phase 15G.5 — storefront single-price-truth convergence (2026-08-10)
The public storefront now prices supported 4x5 stock bags through the SAME
canonical engine as the ERP. NEW app/lib/storefront-canonical-pricing.server.ts
(parseStorefrontFinish 0X-8X + Deep Build detection; priceStorefrontConfiguration
wraps canonicalStockBagJob — holo implies the REQUIRED white underbase bundled,
90% pre-art coverage internal, round-to-cents unit price, exact-quantity band
pricing so odd quantities can never undercharge; storefrontPriceBreaks at the
approved ladder 50/100/250/500/1000/2500 — no invented 5000+ break).
apps.wholesale-lite.configurator: bags return pricingSource "canonical_erp"
(fail-closed message when canonical inputs unavailable — NO silent legacy
fallback); jars stay "legacy_rule". apps.wholesale-lite.configurator-checkout:
every bag line is REPRICED canonically server-side (posted prices were never
read; unchanged), Deep Build 9X+ and malformed/unsupported combos rejected,
draft-order custom lines remain THE checkout mechanism (Option B — the dead
cart-transform extension stays inert/never used by the supported path;
physical removal deferred to an extension-deploy decision), and each line
carries a hidden `_GSO Canonical` JSON snapshot (profile/qty/faces/material/
bagColor/holo/whiteRequired/glossX/finishLabel/unitPrice/engine) for paid-
order production and future Ticket-First intake. Visible Material/Finish/
Bag Color attributes unchanged — the paid webhook's isConfiguratorLine
contract is a superset (pinned). Admin Configurator: matrix relabeled
"Deprecated / Compatibility"; parity line shows storefront = canonical
(MATCH) for bags, legacy-only for jars. ConfiguratorPricingRule = deprecated
compatibility/audit data for bags (still live for jars). One base Shopify
variant retained; ZERO Shopify price writes. ROLLOUT DELTAS (dbl matte):
64: 1.75→2.70 (+54% FLAG small runs), 100: 1.65-range→1.93 (cost-led; see
note), 250: 1.75→1.63, 500: 1.65→1.50, 1000: 1.55→1.45, 2500: 1.35→1.32;
specialty/holo now tier+floor-priced (e.g. 1000 dbl holo+3X = $2.24/unit
floor-controlled incl. white underbase + gloss setup). OWNER NOTE: the 4B
"qty-100 double decrease to $1.80" cannot materialize — the market target is
raising-only and the 65% band cost-based price ($1.93) wins; realizing 1.80
needs a margin-band edit (owner decision). ACTIVATION: web (Render) deploy
only — the theme block/JS payload shape is unchanged and no theme/extension
deploy is required; prices change the moment Render serves this commit.
Tests 933 -> 944 (tests/storefront-convergence.test.ts: finish mapping,
parity matrix standard/specialty/holo/combo, approved breaks, band step
function, deep-build/tamper/auth/no-variant-write pins, webhook superset,
rollout deltas). Next: Ticket-First Production Intake (owner review first).

## Phase 15G.5A — storefront launch calibration (2026-08-10)
Qty-100 double ratified at $1.80: BAGS_4X5_DOUBLE_BANDS 61% band starts at
100 (was 128); 1-99 unchanged at 65%. Storefront: bag minimum 50, approved
quantity ladder exposed as quantityOptions, 5,000+ = volume-quote response,
canonical 0X-8X finish options served from code (no DB writes), Deep Build
9X+ remains quote-only. Parity re-pinned across engine/admin/proxy/checkout
(double 2.70/1.80/1.63/1.50/1.45/1.32; front 2.15/1.30/1.15/1.05/1.05/0.95).
Deliberate pin updates: storefront-convergence qty-100 (1.93→1.80),
margin-curve-equivalence side-parity (100-127 double now 61%). Tests 944 ->
945. NOT customer-live until Render deploys this commit.

## Phase 15G.5B — storefront checkout handoff hardening (2026-08-11)
LIVE FAILURE ROOT CAUSE (forensically proven with signed direct-to-Render
probes + Admin API schema introspection): DraftOrderLineItemInput.
originalUnitPrice DOES NOT EXIST on the pinned 2025-10 Admin API — every
fully-valid checkout failed GraphQL schema validation (no draft orders were
ever created), our route returned its sanitized 500 JSON, and SHOPIFY'S APP
PROXY REPLACES UPSTREAM 5XX WITH THE STOREFRONT THEME ERROR PAGE — the
browser saw <!doctype html> and threw "Unexpected token '<'". All earlier
probes passed because pre-mutation rejections are 4xx, which the proxy
passes through as JSON. FIXES: (1) line items now use
originalUnitPriceWithCurrency {amount, currencyCode USD} — the exact shape
Quotes/CRM already used; (2) checkout NEVER emits 5xx through the proxy
(failure statuses 500→400 so JSON always reaches the browser); (3) theme JS
hardened — content-type-checked safe parsing for checkout POST and pricing
GET, one automatic 3s retry, friendly "Checkout is temporarily unavailable"
message, button re-enable, no raw HTML/token errors ever surface; (4) Deep
Build 9X+ can no longer enter any cart path client-side (Add button becomes
disabled "Request Custom Quote"; hard gate in the legacy cart path; server
rejection remains defense-in-depth); (5) stale "Minimum order: 64" display:
source = theme block setting minimum_quantity (default was 64) — JS now
syncs the visible minimum + input floor from the server's canonical
product.minQuantity (50), schema default corrected to 50 (no product/theme
data writes needed), and the Admin Configurator now uses the canonical 50
for stock bags (legacy 64 stays deprecated display only). Deployed-build
fingerprinting confirmed Render auto-deploys pushes to main (15G.5A was
already live). ACTIVATION: web deploy (auto on push) fixes checkout;
`shopify app deploy` is additionally required for the THEME extension
changes (JS resilience + MOQ display + liquid default). Tests 945 -> 950.

ROOT CAUSE #2 (found post-deploy, fixed in the follow-up commit): the first
fix alone did not restore checkout — live probes still returned the generic
failure. Replicating the exact mutation directly against 2025-10 proved the
mutation itself was now schema-clean, which localized the remaining failure
to the route: the legacy ConfiguratorPricingRule lookup (kept for jars and
for the "Production Finish" attribute) returns NULL for every canonical bag
line, because all 50 active stock_bag_4x5 rules carry only the old finish
labels ("1X-4X Spot Gloss"/"No Spot Gloss") and can never match the
canonical labels ("No Specialty — 0X" ... "Extreme Raised — 8X"). The
unguarded `rule.productionFinish` threw a TypeError BEFORE draftOrderCreate
ever ran — this was the crash the owner reproduced (old build: caught ->
500 -> proxy swallowed it into theme HTML; it also masked root cause #1,
which any request surviving to the mutation would then have hit). Fix:
`rule?.productionFinish || finish` — for canonical bags the finish label IS
the production finish; the guaranteed-rule jar path is unchanged. Regression
pin added (tests 950 -> 951).

## Phase 15G.5C — final storefront MOQ cleanup (2026-08-11)
The storefront pricing/checkout arc is COMPLETE: one customer-facing MOQ
authority for 4x5 stock bags = 50, served by the canonical server response.
Root causes of the residual 64s (all traced on the live page): (1) the theme
block INSTANCE saved `minimum_quantity: 64` — schema-default changes never
retro-update saved block settings, so the liquid kept rendering 64 into
`data-minimum-quantity`, the quantity input, and the pre-JS notice; (2) the
theme JS initialized from that dataset (with hardcoded "64" fallbacks) and
sent `quantity=64` on the FIRST pricing fetch — the server's raise-only
clamp (max(64,50)) legitimately echoed 64 back, which became the visible
input value; (3) the field-change clamp floored at the BLOCK value (64), so
even a corrected 50 would snap back to 64 on the next material/finish
change; (4) `ConfiguratorProduct.minQuantity` rows store legacy 64
(deprecated display data — canonical paths ignore it for bags); (5) nearly
the whole catalog (1,886 of 1,898 products) carries "Minimum order 64
units" INSIDE the Shopify product description (body_html) from the original
bulk-creation template — this also feeds the SEO/og/twitter meta
description. FIXES (code): liquid no longer renders the saved block setting
into any customer-facing output (canonical 50 literals; setting label marked
DEPRECATED); JS fallbacks 64->50; the FIRST pricing fetch now omits the
quantity param entirely so the server's canonical floor decides (fresh page
=> 50 priced at the 50 band); the change clamp floors at the server minimum
once known; admin Configurator presents "50 (canonical storefront MOQ)"
everywhere, demotes stored 64 as "legacy row value (deprecated)", previews
default to 50, and fresh compatibility seeds write 50. NOT fixed by code
(product DATA, owner decision required): the description sentence — exact
field `Product.descriptionHtml`, safest path is a dedicated owner-approved
bulk phase replacing "Minimum order 64 units" -> "Minimum order 50 units"
(or removing it); until then the app block beside it displays the canonical
copy. Jars keep their own MOQ path untouched. CLEANUP DEBT (documented, not
addressed): gso-product-configurator.js is ~16.3 KB vs the 10 KB theme-check
threshold — WARNING-ONLY, does not block `shopify app deploy`; splitting is
deferred to avoid destabilizing a proven checkout. ACTIVATION: web (Render)
auto-deploys; the theme-extension liquid/JS changes require one more
`shopify app deploy`. Tests 951 -> 958.

## Phase 15G.5D — single purchase path for configurator stock bags (2026-08-11)
On configurator-controlled stock-bag product pages the theme's NATIVE
purchase controls (Add to cart, Buy with Shop / accelerated checkout, More
payment options — Refresh 12.0.0 renders them as .product-form__buttons
wrapping the name="add" submit and .shopify-payment-button >
shopify-accelerated-checkout) created a second path that could bypass
canonical pricing. Lockout shipped in the theme extension only: the block
liquid emits data-gso-lockout="1" from existing deterministic signals
(product.type "Stock Bag" OR tag "configurator-pilot" — jars have neither),
CSS hides the native controls under BOTH body.gso-native-purchase-lockout
(JS-set, universal) and body:has([data-gso-lockout]) (instant, split into a
separate rule so non-:has browsers keep the class rule), and JS activates
the class at init from the marker plus response-confirmed for any active
non-jar configurator page, also hard-disabling name="add" submits as a
non-CSS backstop. The cart-drawer wallet element
(shopify-accelerated-checkout-cart) is deliberately untouched; the legacy
unscoped gso-configurator-hide-dynamic-checkout body class stays dead (no
CSS may hook it — it fires on jar pages too). Fail-closed by design: a
"Stock Bag"-typed product NOT connected to the configurator shows the
configurator error and no native buttons. Residual vector noted: theme
quick-add cards (9 occurrences on live product pages) can still add
recommended products natively — owner can disable quick-add in theme
settings; our CSS also hides form buttons inside quick-add modals opened
from locked pages. Description audit (read-only): 1,886/1,898 products
contain "Minimum order 64 units"; ALL are productType "Stock Bag" — zero
jars/unrelated. Safest bulk criteria for the owner-approved phase:
productType == "Stock Bag" AND exact sentence match, replace 64 -> 50.
ACTIVATION: `shopify app deploy` required (theme extension only; no app
server code changed). Tests 958 -> 959.

## Phase 15G.5E — Stock Bag MOQ description cleanup (2026-08-11)
OWNER-APPROVED Shopify CONTENT-data update, executed and verified: the exact
sentence "Minimum order 64 units" replaced with "Minimum order 50 units" in
Product.descriptionHtml for every qualifying product. Pre-write audit
(tools/audit-moq-descriptions.mjs, read-only) proved: 1,898 products
scanned, 1,886 candidates (productType "Stock Bag" + exact sentence, all
ACTIVE), 0 non-bag matches, 0 loose/case variants, 0 multi-occurrence, 0
pre-existing 50-sentences, 0 manually-saved SEO descriptions, 0
replacement-unsafe (split/join on the exact literal; 64->50 preserves
length). Update (tools/update-moq-descriptions.mjs --execute) used
productUpdate(product: { id, descriptionHtml }) ONLY — introspection-proven
2025-10 shape (the legacy `input` argument no longer exists) — with dry-run
default, per-product freshness re-read (fail-closed on drift), userErrors +
post-mutation content verification, checkpointed idempotent reruns, and a
5-consecutive-failure halt. RESULT: 1,886 updated, 0 skipped, 0 failures.
Post-write verification (tools/verify-moq-descriptions.mjs, read-only):
0 products anywhere still contain the old sentence; exactly 1,886 Stock
Bags carry the new one; 0 non-bag products gained it. Spot-checks (Ritz
Vanilla Cupcake + 4 more): id/title/type/tags/status/variant prices
byte-identical pre/post; live Ritz page shows "Minimum order 50 units" x5
(description, meta description, og:description, twitter:description,
JSON-LD) and zero 64s — SEO meta followed the description automatically
because no product had an independent manually-saved SEO description.
ROLLBACK: tools/moq-cleanup-data/rollback-15g5e.json (git-ignored, local)
holds every original descriptionHtml; restore via
tools/rollback-moq-descriptions.mjs --execute (dry-run default; --all for
every candidate). The audit script now refuses to overwrite an existing
rollback artifact (--refresh-rollback to override). No price, variant,
title, handle, tag, collection, metafield, jar, ERP, or configurator data
touched. Storefront customer-facing 64 debt is now ZERO.

## Phase 15H.1 — ticket identity foundation (2026-08-11)
15H.0's approved scope, implemented exactly: (A) read-only
tools/audit-ticket-uniqueness.mjs ran first against production — 11 jobs /
14 items, 0 duplicate (shop,jobTicket), 0 duplicate (shop,itemTicket), 0
duplicate (shop,quoteId), 0 malformed tickets, 0 null tickets -> PASS. (B)
schema gains @@unique([shop,jobTicket]) + @@unique([shop,itemTicket]);
unique(shop,quoteId) deliberately deferred. (C) migration STAGED at
prisma/migrations-pending/20260811120000_add_ticket_uniqueness — NOT under
prisma/migrations because Render auto-runs `prisma migrate deploy` at
deploy and the owner directed no automatic application; the exact
Prisma-generated SQL is two CREATE UNIQUE INDEX statements (shipped with
IF NOT EXISTS guards + README covering activation and DROP INDEX rollback).
(D/E) allocator exported as allocateJobTicket, exhaustion now throws
(epoch fallback removed — it emitted non-canonical unparseable tickets);
ticket P2002 reruns the whole creation transaction (bounded x3) in both
createProductionJobFromSource and createOrReusePrintIntakeJob. (F/G) local
generators deleted from app.erp.production.tsx (backfill -> central
allocator; NOT run) and the simulator (unticketed test jobs +
fail-closed ALLOW_PRODUCTION_SIMULATION gate). (H) paid-order source key
fails closed without a stable order id — Date.now() fallbacks removed in
BOTH the source key and buildShopifyOrderJobPayload. Tests 959 -> 971
(new tests/ticket-identity.test.ts, 12 tests incl. simulated cross-source
ticket race resolving to distinct tickets). NO production data changed; NO
routing/RIP/intake behavior changed; migration NOT applied. Phase 16
Shopify Store Rebuild roadmap (16A-16I) unchanged. Next: 15H.2 RIP
Identity Repair.

## Phase 15H.2 — RIP identity repair (2026-08-11)
The active Mimaki defect is fixed: RasterLink results whose routed names
carry ITEM tickets now resolve job + item exactly (they previously
searched only jobTicket and imported silently unmatched with no flag).
One strict shared matcher (rip-identity-match.server.ts) now backs all
five ingestion paths with take:2 ambiguity detection, structured
unmatched/ambiguous reasons in rawRow (surfaced in review), and
productionJobItemId population. Loose contains/substring/first-match
linking is deleted from print-logs and the legacy CSV branch; the manual
RIP Imports UI uses the shared matcher. Actual-cost writeback re-verifies
every attached row against the job (ticket/name equality or manual
rematch audit) and blocks anything unverifiable; fallback item
attributions are never persisted and never launder into exact.
Historical unmatched audit: 9 rows total, 8 unmatched, 0 recoverable, 0
ambiguous, 0 laundered — no relinking needed or performed. Watcher config
defects fixed script-side (filename convention + ClaimStaleMinutes
spelling; no Scheduled Task or token changes). Machine routing, pricing,
intake, and ticket allocation untouched. Tests 972 -> 985; tsc 306 -> 304
(two pre-existing errors cleaned). Phase 16 roadmap unchanged. Next:
15H.3 Intake Review + Retry.

## Phase 15H.3 — intake review + retry (2026-08-11)
Server-authoritative intake dispositions: PrintIntake.status now carries
routed/review/failed/retry_allowed/assigned/rejected; the agent ledger is
a CACHE reconciled through the new token-authenticated
/api/print-intake/status endpoint (fail-closed offline; routed entries
stay pure local skips; unknown ledgered hashes auto-surface as
legacy_ledger_blocked review rows). The /app/erp/print-intake page gained
the review queue with RELEASE/RETRY, ASSIGN (exact job/item, validated,
finalized/completed refuse), and confirmation-gated REJECT — all audited
in rawParsedHints JSON + ProductionJobEvent; files are never deleted or
moved by the server. Matched-row reuse fixed (both job pointers honored —
no duplicate jobs per hash). Agent bumped to 1.6. THE THREE BLOCKED FILES
(BUTTAWAY_bently_ROLAND.pdf -> Roland/CMYK, GSO PIPELINE TEST_3X SPOT
GLOSS_Roland.pdf -> Roland/GLOSS-3X, GSO PIPELINE TEST 2_1X SPOT
GLOSS_Roland.pdf -> Roland/GLOSS-1X — classifications pinned by test):
after deploy + agent restart they self-surface in the queue on the next
agent pass; owner clicks Release/Retry; the agent re-plans and current
auto-create logic tickets and routes them. No routing/pricing/RIP/ticket
changes; no schema change; no real files routed during tests. Tests 985
-> 996; tsc stays 304. Phase 16 roadmap unchanged. Next: 15H.4
Order/Manual Convergence (paid-order _GSO Canonical consumption, orderGid
linkage, manual job UI, merge/link action).

## Phase 15H.4A — order convergence foundation (2026-08-12)
Checkout's `_GSO Canonical` snapshot (previously write-only) is now the
authoritative production configuration for paid configurator orders:
config/specialty/price map into ProductionJobItem (explicit holo/white/
gloss tokens make intake route holo orders to Roland), the engine-stamped
unit price is preserved as commercial truth (mismatch = warning, never
recalculated), and unsupported lines are omitted-and-logged, never
fabricated. First-class ProductionJob.orderGid STAGED (additive nullable
column + (shop, orderGid) index) using the 15H.1 pattern PLUS a scripted
schema patch — the column cannot enter schema.prisma before the DB has it
(Prisma selects every declared scalar), so the webhook capability-probes
at runtime and deploying code-first is safe. Read-only live audit: 14
jobs / 3 Shopify-paid / 0 duplicates / 0 malformed; backfill tool ships
(3 deterministic candidates) but does NOT run until owner activation.
Webhook idempotency unchanged (stable GID source key; fail closed).
15H.3 smoke proof recorded: the three blocked files released from the ERP
routed live as GSO-20260811-0001/0002/0003 (Roland CMYK / GLOSS-3X /
GLOSS-1X). Tests 996 -> 1009; tsc 304. Phase 16 roadmap unchanged.
Next: 15H.4B manual/walk-in job UI; 15H.4C merge/link convergence.

## Phase 15H.4B — manual production job creation (2026-08-12)
"New Manual Job" on the Production Board creates permanent-ticket
production work with no Shopify/quote/payment dependency: loader-minted
requestId idempotency (Date.now key removed; manual exemption from the
source idempotency check removed), fail-closed validation, canonical
decideMachine resolution (white/gloss + Mimaki rejects; Auto routes by
owner rules), family-checklist items with resolved machine stored, zero
fabricated commercial data, created_manual_admin audit, and post-create
ticket + Copy Print File Name guidance proven intake-resolvable by all
four deterministic tiers. No schema change (requestId lives in the
existing quoteId source-key field as manual_<requestId>). Tests 1009 ->
1016; tsc 304. Owner smoke test: New Manual Job -> "GSO MANUAL TEST" /
"Manual CMYK Test" / qty 10 / Custom-Other / CMYK / Auto -> expect
Mimaki, fresh GSO ticket, one -01 item, $0 prices. Phase 16 roadmap
unchanged. Next: 15H.4C merge/link (fold unlinked intake jobs into
order/quote jobs without duplicates), then 15H.5 reprints/runs/QC.

## Phase 15H.4C — merge/link production convergence (2026-08-12)
"Link to Existing Job" on the Production Board folds unlinked intake
shells into the real Shopify/quote/manual job: fail-closed source
eligibility (intake provenance required; commercial jobs never shells;
finalized-cost and proof-active sources block), exact owner target
selection (orders first), target-ticket authority, PrintIntake
repointing with preserved shell provenance, file-record copies (physical
files untouched), both-sided audit events, advisory-locked idempotent
transaction, and an active=false tombstone that keeps the shell ticket
historical forever. Print-log history stays on the shell — never
double-counted. Intake Assign dropdown now prioritizes commercial jobs;
order/quote job cards show the attach-automatically filename guidance.
Read-only audit: the three live intake jobs are eligible shells; the
manual smoke job is not. No schema change; RIP matcher/agent/routing/
pricing untouched. Tests 1016 -> 1025; tsc 304 baseline. The 15H.4
convergence arc (A order, B manual, C merge/link) is COMPLETE. Phase 16
roadmap unchanged. Next: 15H.5 Reprints / Runs / QC (attempt/revision/
reprint counters live, R#/P# routed names, run-aware actuals, operator
flow).
