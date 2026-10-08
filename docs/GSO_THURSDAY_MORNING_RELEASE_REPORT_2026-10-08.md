# GSO ERP — Thursday Morning Production Release Report (2026-10-08)

Unattended release run authorized by the owner on 2026-10-07. Everything below was executed under the stated safety gates; nothing was forced, bypassed, migrated, deleted or charged.

## Result

**PARTIAL RELEASE SUCCESSFUL — OWNER ACTION REQUIRED.** The web application release is live on Render (merge commit `a17efc3`), the production database was backed up and the single approved Spektra seed ran cleanly. Three steps need the owner because this workstation has no Shopify CLI session and no Render API access: the Shopify app / extension deploy (`shopify app deploy`), the Render environment variable `GSO_OPS_REPOSITORY=prisma`, and the embedded-admin "Save settings & sync functions" click.

## Git

| Item | Value |
|---|---|
| Starting HEAD | `ad1ef13` (branch `gso-erp-overnight-finishline-2026-10-05`, 41 ahead of `a3c79c8`) |
| Final pre-push gate | Vitest 133 files / 2,644 passed / 2 skipped · build green · typecheck 293 (baseline, 0 new) · diff-check clean |
| One technical fix before push | `61e0aba` — single trailing newline in a generated markdown artifact (`git diff --check main...HEAD` flagged a blank line at EOF); plus the read-only pre-check and logical backup tools. Gates rerun green. |
| Branch pushed | YES — `origin/gso-erp-overnight-finishline-2026-10-05` = `61e0aba` (normal push, no force) |
| PR | #1 https://github.com/designs4gso-boop/gso-wholesale-app-live/pull/1 — base `main`, head `61e0aba`, MERGEABLE / CLEAN |
| PR checks | none exist (no CI workflows, no branch protection on `main`); server-side diff scan: no prisma / migration / .env / theme / secret patterns; runtime authorities verified ($5/hr, LG-640, WORKER_SCHEDULED false, reasoning/execution default false) |
| Merged | YES — merge commit, 2026-10-08 05:55 UTC |
| Production `main` / `origin/main` | `a17efc3a115559f1145fe59b763a025ba32fca4f` (local `main` fast-forwarded; tree identical to the gated branch tree `d3d5f4f…`) |

## Render

| Item | Value |
|---|---|
| Previous production commit | `a3c79c8d693b9de69fc0c377605d713a6566fc96` (client bundle `entry.client-CbOo1W9j.js`) — remains selectable for rollback in the Render dashboard |
| Deploy method | Render auto-deploy on push to `main` (documented); no Render CLI / API key on this workstation, so no deployment id could be read |
| New deployment | detected 05:58:39 UTC; deployed client bundle `entry.client-BeecLoVI.js` = hash of the local build of `a17efc3` (deployed SHA confirmed by bundle identity) |
| Health | root `/` → 302 `/app`; `/auth/login` 200 with assets; app proxy `pricing` / `configurator` return their normal validation JSON through the live store; stable across 6 probes over 2 minutes and during the deploy window (no 5xx observed) |
| `GSO_OPS_REPOSITORY=prisma` | NOT SET (requires the Render dashboard — owner action); until set, the Operations Hub reports the in-memory repository (loud, safe) |
| Reasoning / execution / worker / Slack | code defaults OFF / OFF / manual-only / sandbox-decision-only; the Render environment values could not be read without API access (no evidence they were ever set to unsafe values; the app has no UI path to change them) |

## Database

| Item | Value |
|---|---|
| Backup | logical JSON dump via Prisma (pg_dump is not installed): `C:\Users\Desig\.gso-secrets\backups\gso-erp-logical-2026-10-08T05-53-05-355Z\` — 64 models, 21,652 rows, 17,778,594 bytes, sha256 per file, 0 errors, 0 zero-byte files (outside the repo, never committed) |
| Seed inspected | YES — `tools/seed-spektra-dtp-current-sizes-2026-10-07.mjs`: find Spektra vendor → for 2 SKUs find/create VendorProduct, replace only that product's own tiers/add-ons, createMany tiers + add-ons; no truncation, no unrelated updates, no quote / snapshot access, no migration; idempotent by vendorSku; no dry-run flag (none invented) |
| Read-only pre-check | Spektra vendor present and active; the 4 existing DTP products present (4 tiers / 7 add-ons each); the 2 target SKUs ABSENT → the run would CREATE only |
| Seed run | YES, once, 05:59 UTC: created `spektra-dtp-3.5x4.5x2` (`cmuz4mjnx00018yo48jhlfm22`) and `spektra-dtp-5x5x2` (`cmuz4mk67000d8yo4quf6kmyj`) |
| Records affected | VendorProduct 23 → 25, VendorProductTier 70 → 80, VendorProductAddOn 37 → 47 (+22 rows exactly) |
| Unexpected writes | NO — post-seed re-dump: 61 of 64 models byte-identical (Quote, ProductionJob, Machine, settings…); 4x5x2 / 5x4x2 / 6x5x2 / 8x5x2 keep their 2026-07-25 timestamps and tier counts |
| Availability | 3.5x4.5x2 and 5x5x2 now exist as vendor products (5 reference tiers each, comparable spec); 5x4x2 remains legacy (manual / vendor review in code) |

## Shopify

| Item | Value |
|---|---|
| App / extensions deployed | NO — the Shopify CLI is not installed and no CLI session exists on this workstation; an interactive login would be required (not attempted unattended). Owner action: `shopify app deploy` from `main` (`a17efc3`) |
| Cart transform | fix is in `main` (honours `_GSO Price Each` / `_GSO Matched Tier`); becomes live only after the extension deploy |
| Save settings & sync functions | NOT done — embedded-admin button only; no safe programmatic equivalent exists |
| Storefront safe smoke | storefront 200; app proxy `pricing` → 400 "product_id and variant_ids required", `configurator` → 200 `{ok:false, active:false, "Missing product identifier"}` (expected non-mutating responses); webhook route rejects a bare GET |
| Real payment created | NO |

## Pricing / production (code-level proofs on the deployed tree)

$5/hr machine recovery for both printers; five owner-approved DTP ladders with the step boundaries (2,499 / 2,500 / 4,999 / 5,000 / 9,999 / 10,000 / 24,999 / 25,000 / 25,001 → vendor quote); shaped +10% / $700 / MOQ 2,500; DTP outside machine recovery; QC PASS required before Completed; Roland LG-640 white/gloss, Mimaki UCJV300-130 CMYK default — all pinned by the focused suites (78 tests) on the identical tree. Note: the production machine records still store `costPerHour: 8` for both printers (seeded in July); pricing and actuals use the $5 owner standard, and Cost Health / Cost Verification now flag the records as differing — an informational data edit for the owner, not a release issue.

## Owner morning actions

1. Shopify: from `main` (`a17efc3`), run `shopify app deploy` for the configured production app (client id ending `…31ff7ae`, "GSO Wholesale Pricing Data"); confirm only the expected app / config / extensions. Then in the embedded admin click **Save settings & sync functions**.
2. Render dashboard → `gso-wholesale-app-live` → Environment: add `GSO_OPS_REPOSITORY=prisma` (the service restarts); confirm the Operations Hub shows Repository PRISMA, Reasoning OFF, Execution OFF, Worker manual only.
3. Live paid-order smoke (owner only; no non-charging test path is documented): one configured storefront line through checkout → job appears on the Production Board, Slack alert received.
4. Optional data alignment: set the two printer machine records to $5.00/hr on the Machines page so every screen shows the owner standard (pricing already uses $5).
5. Freight: confirm the Spektra freight basis when vendor data is available (still a labelled $85 provisional assumption; not a blocker).

## Rollback

Previous Render deploy (`a3c79c8`, bundle `CbOo1W9j`) is selectable in the dashboard; no migration to reverse; the seed is additive (two vendor products with their tiers / add-ons) and must not be auto-deleted; pre- and post-seed logical dumps are kept privately outside the repository.
