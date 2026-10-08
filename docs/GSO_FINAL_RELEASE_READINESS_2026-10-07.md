# GSO ERP — Final Release Readiness (2026-10-07, FINAL after the owner review)

Owner decisions 1–13 are applied locally (see `GSO_OWNER_DECISIONS_BEFORE_RELEASE_2026-10-07.md`). Nothing is pushed or deployed.

Branch `gso-erp-overnight-finishline-2026-10-05` (local only, never pushed). Production = `main` / `origin/main` `a3c79c8`. Every item below was verified in code tonight; nothing is padded. Scope: SMALL = under an hour, MEDIUM = half a day, LARGE = more than a day.

Columns: **Area · Problem · Impact · Severity · Owner decision needed · Next action · Scope**.

## A. MUST FIX BEFORE FRIDAY RELEASE

| # | Area | Problem | Impact | Severity | Owner decision | Next action | Scope |
|---|---|---|---|---|---|---|---|
| A1 | Release path | The 31 local commits are not on `origin/main`; Render and `shopify app deploy` have not run | Nothing tonight is live | BLOCKER (process) | NO | Push the branch, review, merge to `main`, deploy Render, then `shopify app deploy`, then "Save settings & sync functions" (Thursday plan) | SMALL |
| A2 | Storefront pricing guard | Cart-transform Function read `_GSO ERP Price Each` while the live theme writes `_GSO Price Each`; fixed in code tonight (both keys honoured) but the Function is only live after `shopify app deploy` | Until deployed, a native /cart/add line is priced only by the theme's client-side lockout | BLOCKER until deployed | NO | Deploy the extension with the app release; smoke-test one configured line in a cart | SMALL |
| A3 | Paid orders | A paid order with no recognisable production line used to vanish (HTTP 200, no job, no record); fixed tonight: review-queue item + Slack alert on webhook-created jobs | Lost orders were invisible | BLOCKER until deployed | NO | Deploy; confirm one test order (not a Shopify mutation from this session) lands on the board and alerts | SMALL |
| A4 | Owner pricing activation | RESOLVED 2026-10-07: all five current sizes carry OWNER-APPROVED ladders incl. 25,000; above 25,000 = vendor quote | — | done | NO | Deployment step A6 creates the two new VendorProduct rows | — |
| A6 | New-size vendor records | 3.5x4.5x2 and 5x5x2 have no VendorProduct row in production, so they will not appear in the calculator picker until seeded | Two approved sizes not quotable until the seed runs | DEPLOYMENT STEP | NO | Run `node tools/seed-spektra-dtp-current-sizes-2026-10-07.mjs` against production during the approved deployment (additive, idempotent, no Shopify product) | SMALL |
| A5 | Ops runtime config | `GSO_OPS_REPOSITORY` still defaults to in-memory; Operations Hub shows "Repository is in-memory — intents are not durable" | Agent review intents are not durable in production | MINOR for staff use, BLOCKER for ops platform | NO | Set `GSO_OPS_REPOSITORY=prisma` in the Render environment at deploy time (no code change) | SMALL |

## B. OWNER DECISION REQUIRED BEFORE RELEASE

None remaining for the release. All 13 decisions plus the machine recovery rate ($5/hr, 2026-10-07) are answered and applied; the only open items (vendor freight basis, post-launch schema work) do not block deployment.

### Machine recovery rate $8 → $5/hr (OWNER APPROVED 2026-10-07) — effect on customer prices

True manufacturing cost fell on every in-house printed job (only the machine-recovery lines moved; DTP is outsourced and did not move). Customer pricing authorities were NOT changed; prices moved only where the existing owner-approved rule is cost-based:

| Surface | Rule | Price effect |
|---|---|---|
| Standard 4x5 sticker bags (1X / 3X, single and double) | market target controls | unchanged ($1.05 / $1.45 at 1,000 etc.) |
| Specialty 4x5 bags where the 40% cost floor controls (5X / 7X double) | floor = cost / 0.60 | 500 double: 5X $1,203.53 → $1,165; 7X $1,501.23 → $1,445. 1,000 double: 5X $2,377.67 → $2,300; 7X $2,973.07 → $2,860 |
| Holographic + 3X double at 1,000 | floor-controlled | $2.24 → $2.16 per unit |
| Product Setup cost-plus recipes (margin % on cost) | cost / (1 − margin) | moves with the lower machine cost (e.g. the 10-sqft recipe fixture $2.0533 → $2.0333 per unit) |
| Stickers / labels, banners, jars | market floors / owner ladders / 16D jar ladder | ladders and market floors unchanged; cost-based candidates and margins improve |
| DTP | owner ladders | unchanged |

Margins on every market-target or ladder-priced item rise by the machine-cost saving (e.g. 3x3 sticker control GM improves by $4.53 per 1,000; Miron 128 jar set by $1.58). If the owner wants the floor-controlled specialty bag prices held at their former values, that is a new owner pricing rule (not applied).

## C. MEASUREMENT / VENDOR DATA STILL NEEDED

| # | Area | Problem | Impact | Severity | Owner decision | Next action | Scope |
|---|---|---|---|---|---|---|---|
| C1 | DTP freight | $85 per Spektra PO is an unverified assumption inside every DTP landed cost and GP | GP figures shift by the real freight difference per order | MINOR (labelled everywhere) | YES (#4) | Get the vendor freight basis; replace the constant or make it a quoted line | SMALL |
| C2 | Vendor MOQ | Spektra site says 500 minimum, the calculator prices lower; GSO keeps 1,000 | None at launch | COSMETIC | NO | Confirm with vendor when convenient | SMALL |
| C3 | Exact-size competitor prices | No published Design & Customize price for 3.5x4.5 / 5x5 / 6x5 / 8x5 | Proposals anchor on 4x5 by landed-cost delta | MINOR | NO | Capture when a true 1:1 is found | SMALL |
| C4 | RIP print minutes | Imported RIP rows store 0 minutes; the shared duration resolver derives time | Screens now say "not recorded" instead of 0.0 min | MINOR | NO | Keep the resolver; capture durations in the import when the format is confirmed | MEDIUM |

## D. SAFE TO LAUNCH WITH KNOWN LIMITATION

| # | Area | Limitation | Why safe | Severity |
|---|---|---|---|---|
| D1 | Production statuses | "Move job to" still offers every status from any state EXCEPT Completed, which now requires a valid QC PASS on every item ("QC PASS REQUIRED BEFORE COMPLETION", Production Board + Calendar) | Earlier stages remain staff discipline; the QC card shows disagreement | MINOR |
| D2 | Proof portal | Opening the customer proof link records a "viewed" event on GET (prefetchers can trigger it) | Informational only | COSMETIC |
| D3 | Legacy calculator toggle | `?legacytools=1` reloads without the priced job's query string | Legacy tool is opt-in and labelled | COSMETIC |
| D4 | Cost Calculator duplicates | A second "Save as draft quote" form inside Advanced Overrides and an "Approved Customer Price summary" block in the legacy section can disagree with the selected tier | Both live in the legacy/advanced section; the main summary and save use the selected tier | MINOR |
| D5 | Admin Settings | 29 of 31 settings are stored but unread — now labelled NOT CURRENTLY USED | Honest labelling; live pricing is on Pricing Settings | COSMETIC |
| D6 | Pricing Rules page | Legacy tier rules only feed the Shopify Cost Audit — now labelled LEGACY / DIAGNOSTIC | No pricing path reads them | COSMETIC |
| D7 | Shopify-order accounting | Webhook-created items carry unitCost 0 until actual-cost finalization; discounts/tax/shipping are not read | Margin reporting is explicit about "finalized jobs only" | MINOR |
| D8 | Wholesale applications | Approve / Reject updates the application status only (no Shopify tag, no link to a quote) | Page is reachable from the nav now; manual follow-up | MINOR |
| D9 | Worker trigger | Manual worker run is API-only (bearer token), no UI button; worker not scheduled by design | Agent execution is OFF; nothing to drain at launch | MINOR |
| D10 | "Canonical" vocabulary | Staff screens still say "canonical true cost" | Consistent, explained on screen; renaming is a wording decision | COSMETIC |

## E. POST-LAUNCH CLEANUP

| # | Item | Scope |
|---|---|---|
| E1 | Reconcile the production status vocabulary (17 staff statuses vs 13 in the transition guard) and wire the remaining transitions (the Completed guard is live) | MEDIUM |
| E2 | Retire the four redirect shims (`app.wholesale.calculator`, `app.product-costs`, `app.erp.product-costs`, `app.create-order`) and the five unlinked agent-rules JSON routes once bookmarks are confirmed dead | SMALL |
| E3 | Unique index on `ProductionJob(shop, quoteId)` + a webhook-receipt table (currently idempotency relies on an advisory lock) | MEDIUM (schema) |
| E4 | Cost Calculator: remove the second draft-save form and the legacy "Approved Customer Price summary" block (D4) | SMALL |
| E5 | Owner identity (e-mail allow-list) for owner-only pages (decision #8) | MEDIUM |
| E6 | Die ID registry model (decision #6) | MEDIUM (schema) |
| E7 | Remaining raw enum/slug labels (agent review queue source/status, print-intake outcome rules) and remaining patch-era wording in Cost Verification / Cost Health | SMALL |
| E8 | Reports: honest "not recorded" for stockOnHand nulls, raw family keys in the suggestion select | SMALL |
| E9 | Pricing Intelligence: "Needs review" filter on Pricing Health, per-row fix-link repetition | SMALL |
| E10 | `DEFAULT_SLACK_ENV_FILE` developer path in `slack-client.server.ts` → env-only | SMALL |

## F. OPTIONAL ENHANCEMENT

| # | Item | Scope |
|---|---|---|
| F1 | Wholesale application approve → Shopify customer tag + "start quote" link | MEDIUM |
| F2 | Paid-order re-import UI (recreate a dropped order's job from the Shopify order) | MEDIUM |
| F3 | Owner-gated "Run one worker batch now" button on the Operations Hub | SMALL |
| F4 | Setup Wizard / Walkthrough "Agent safety" row (reasoning OFF, execution OFF, worker unscheduled, Slack decision-only) | SMALL |
| F5 | In-app editor for DTP owner ladders (today: code + tests) | MEDIUM |

## Verification at the end of the overnight pass

See the Wednesday morning report (section K) for the exact counts. Baselines required: Vitest ≥ 2,606 passing (now higher), build green, typecheck ≤ 293 existing errors with zero new, `git diff --check` clean, no unexpected dirty tracked files.
