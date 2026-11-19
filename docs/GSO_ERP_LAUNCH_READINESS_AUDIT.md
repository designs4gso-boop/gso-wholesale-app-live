# GSO ERP — Launch Readiness Audit

**Date:** 2026-11-18 (overnight). **Code:** `main` at `4c37645` (started at `a1f7282`). **Deployed:** yes — Render is serving the build of `48c5046` / `4c37645` (the last commit changes only a shop-PC script).

This is the single authoritative readiness report. Everything marked *verified* was checked tonight against production (read-only), the live Shopify store (read-only), this shop PC, or the code. Anything that could not be checked is marked *unverified*. Scores are judgement, not arithmetic — they are deliberately conservative.

---

## The one finding that matters most

**The business is not running through the ERP yet, and that — not a bug — is why print files arrive with no job.**

- Production holds **18 production jobs in total. Every one is a test** or a leftover from testing (6 "Unlinked (print intake)" shells, 4 from Shopify draft-order tests, 7 from test quotes, 1 manual test). The newest is 2026-11-07.
- The Shopify store has **16 orders ever**. The four most recent (#1013–#1016, Oct–Nov) are test web orders. Real customers are not ordering through the storefront.
- Since the watcher went live, **31 real staff files** for a real customer (CRUD) have arrived. All are held in review, because no order, quote or manual job for that work was ever entered. Nothing is broken: Print Intake is correctly refusing to invent a job (Patch C).
- A job is created in exactly three ways: a **paid storefront configurator order** (automatic), a **fully paid quote** (someone clicks *Create Production Job*), or the **New Job form** (manual). Phone, email, repeat and invoice-outside-Shopify work has no automatic path by design.

So the remaining launch work is mostly **adoption**: real work has to be entered. The fastest safe path that exists today is in *Owner actions* below.

---

## A. Executive scorecard

| Area | Score | Why |
|---|---|---|
| Core ERP (quotes, product setup, cost engine, jobs) | **75%** | Built, tested (4,028 tests) and deployed. Never exercised by real orders. |
| Shopify / storefront | **55%** | Configurator → paid order → job works for stock bags, sticker bags, jars, DTP pouches, stickers. Store is not yet taking real orders; storefront bag/sticker prices come from an older cost engine than the ERP; no fulfilment sync back to Shopify. |
| Pricing / costing | **70%** | Canonical engine blocks on missing inputs. Pending: bag inbound freight, MIRON Ceres freight and price ladder, Mimaki gloss estimating, several families with no selling ladder. |
| Production (board, QC, shipping record) | **75%** | Complete and role-gated. Real jobs are not in it yet. |
| Print Intake | **90%** | Live, safe, verified end to end with one real file. Blocked only by jobs not existing. |
| RIP actuals | **55%** | Parser and JobInfo clear-ink reader deployed. No ERP-linked result verified yet; no Mimaki sync task; Roland manual; history uncorrected. |
| Shipping / fulfilment | **40%** | Shipment and pickup are recorded on the job. Nothing is sent to Shopify (no fulfilment scope), no labels, no tracking sync. |
| CRM / sales | **35%** | Quote → Shopify draft order → payment → job works. No lead, customer, follow-up or reorder records a salesperson can use. |
| Agents | **20%** | One real integration (signed lead-intake API + staff review queue). The 21 registry "agents" are library functions nothing in production calls. No LLM call path is live. |
| Marketing automation | **5%** | A draft scaffold only. Nothing can send. |
| Security / permissions | **80%** | Seven ungated pages and three cross-shop write paths fixed tonight. Open items below. |
| Deployment / operations | **70%** | Auto-deploy works and was verified three times today. Render settings and environment values cannot be seen from the repo. No health check, no background worker. |

**OVERALL LAUNCH READINESS: 60%** — the software is further along than the business's use of it.

---

## B. Ready now (verified)

- **Print Intake** (Patches A–E): watcher v1.9 running from `C:\GSO-Print-Intake-Agent\`, historical cutoff active, flood cap 60, true dry run, exact layer pairing, conflicts held, routed file recorded once on the job. Mimaki → `C:\MijCtrl\Hot\UCJV-300`, Roland → VersaWorks `Input-A`.
- **Routing rules are now the same everywhere a press is chosen for production**: explicit Roland → Roland; explicit Mimaki → Mimaki; nothing explicit + CMYK or CMYK + gloss → Mimaki; white unchanged. "No Spot Gloss" / "No Gloss" / "No Specialty" are no longer read as gloss.
- **Manual job entry** (New Job): works for owner, manager and print operator. *Printer: Auto* now resolves to the Mimaki for non-white work instead of failing on a load tie.
- **Quote → Shopify draft order → verified payment → Create Production Job**: works, snapshot-locked, margin-gated.
- **Storefront configurator checkout → paid order → production job** (automatic, idempotent on webhook retry) for the mapped families.
- **Cost Calculator / canonical cost engine**: blocks rather than guesses when an input is missing. Owner rules pinned by tests: Stock Bag MOQ 50, no Zakeke; $0.11 4x5 blank; gloss material = matte cost basis; holographic separate; jars 1% overage; MIRON Ceres freight pending; Mimaki clear $0.09/mL.
- **Role gates** on production, costing, pricing and settings pages; token-authenticated machine endpoints; webhook signatures.
- **Deploy pipeline**: push to `main` → Render build → live in about 2–3 minutes (observed three times today).

## C. Partial

- **RIP actuals (Patch F).** RasterLink result log is on and writing to `...\rasterlink\incoming\UCJV-300`. Composite CMYK + clear results carry no ink; the reader takes ink from the job's own `JobInfo.ini` (clear = slot 136 + slot 137, priced at $0.09/mL). Three real results have arrived (`crud_shortcakes` F and b, `crud_mixed berries` F) — all for work with no ERP job, so none was imported. First ERP-linked result still to be verified; then the sync task can be switched on (prepared, see E).
- **Storefront pricing.** Stock/sticker bags and stickers are priced on the storefront by an older engine (`product-driven-costing.server.ts`, its own ink constants) while quotes use the canonical engine with the database calibrations. The two do not agree. Stock Bag storefront price also includes an art setup that the canonical model treats as $0 (premade art). Changing either moves live prices — owner decision, not touched.
- **Gloss estimating.** Production routes gloss to the Mimaki, but quotes still *estimate* gloss on the Roland's calibration because no Mimaki gloss calibration exists. Three real observations are recorded (below); no rate was set.
- **Quotes for core families.** Sales cannot price bags, jars, labels or banners themselves (the Cost Calculator is owner-only); such lines wait for the owner.
- **Agent platform.** Action-intent → approval → execution → audit exists in code and schema, with a kill switch and human-only approval. Nothing in production creates intents or feeds the outbox, nothing schedules the worker, and intents are not shop-scoped.
- **Slack.** Production-job alerts post to a Slack webhook if the URL is configured (unverified in production). The approval endpoint only records approve/reject.

## D. Blockers

### P0 — cannot launch safely
None verified. **One unverified item would be P0 if true:** if Render has `GSO_OWNER_ENFORCEMENT=temporary_all_staff`, every signed-in staff account is treated as the owner and every role gate is void. The repo cannot see Render's environment. Check it first (E1).

### P1 — should fix before launch
1. **Real work is not being entered as jobs** (see the top of this document). Workaround available today (E2).
2. **Render environment unverified**: `GSO_OWNER_SHOPIFY_USER_IDS`, `GSO_STAFF_ROLES` (without it every non-owner sees only Home), `GSO_MANAGER_AUTHORIZED_USER_IDS`, `GSO_OPS_REPOSITORY=prisma`, Pre-Deploy `prisma migrate deploy`.
3. **Patch F live verification** and the Mimaki result-sync task.
4. **Quotes page has no role floor for viewing and saving.** Any signed-in account, including one with no ERP role, can open Quotes (customer email / phone) and save or re-status drafts. Tonight's fix covers deleting, creating Shopify draft orders and emailing invoices. The rest is pinned by existing tests as intended behaviour, so it needs the owner's decision.
5. **Storefront price authority** (two engines) before the storefront takes real orders at volume.
6. **Compliance webhooks do nothing.** `customers/redact`, `shop/redact` and `customers/data_request` are acknowledged but no customer data is removed.
7. **Storefront orders carry no cost snapshot** (unit cost 0, "pending cost book mapping"), so online orders have no cost basis for margin reporting.
8. **Print Intake watcher starts only when the user `golde` logs on** (logon trigger). After a reboot with nobody logged in, it is off.

### P2 — can launch with a workaround
- No Shopify fulfilment / tracking sync (record on the job; fulfil in Shopify by hand).
- New Job form is single-item (one job per order with a ticket-named folder works; multi-item needs item linking).
- Sales has no lead inbox (the lead queue is owner / authorized-manager only).
- Paid quotes waiting for *Create Production Job* are not surfaced on Home; deposit-only quotes cannot start production.
- A double click can create two Shopify draft orders for one quote; saving a new quote twice can duplicate it.
- Public quote link `/quote/:id` is protected only by the record id; the wholesale pricing app-proxy trusts an email in the query string.
- Roland RIP actuals by manual CSV; old "GSO Roland Result Sync" task still points at the old clone (E5).
- Bag inbound freight $0 (not modelled), MIRON Ceres freight pending, banner finishing options unverified.
- Jar MOQ: sales rules say 128, storefront enforces 50 — owner to pick one.
- The five known failing tests read a theme export file that is not in the repository; the live theme no longer contains the "fake legacy uploader" they guard against (verified). Not a launch risk.
- Live theme, stock-bag pilot template: the Zakeke *Customize* block is enabled and the deprecated minimum is 64. The server enforces 50 and the app's script hides Zakeke for Stock Bags, but the template should be cleaned (theme edit — not done).

### P3 — after launch
Customer / lead / follow-up / reorder records; a real agent runtime with a scheduler; Mimaki gloss and white calibration; pallet freight allocator; Southwest Cargo freight for DTP and boxes; boxes and apparel in the canonical engine; health endpoint with a database check; pin Node; turn off Prisma query logging in production; remove the hard-coded developer path in the Slack client; stale docs listed in H.

## E. Owner actions

1. **Check Render → Environment (2 minutes).** Confirm `GSO_OWNER_ENFORCEMENT` is absent or `enforced`; `GSO_OWNER_SHOPIFY_USER_IDS` holds your Shopify user id; `GSO_STAFF_ROLES` lists each employee as `id:role`; `GSO_OPS_REPOSITORY=prisma`. The **Owner Readiness** page in the app shows what the server sees.
2. **Put the CRUD work into the ERP (first thing tomorrow, ~5 minutes).**
   1. Production → **New Job**: customer `CRUD`, one item (e.g. "Mashups 21–30, 4x5"), quantity, finish, printer **Auto**. Note the ticket, e.g. `GSO-20261119-0001`.
   2. **Incoming Print Files** → search that ticket → select the held `CRUD_MASHUPS` files → **Assign** (up to 50 at a time). The watcher delivers them to the Mimaki on its next pass.
   3. From now on, for work that did not come from the storefront or a quote: create the job first, then have staff save print files into a folder named with the ticket inside *PRINTS FOR TODAY* (e.g. `GSO-20261119-0001 CRUD`). Those route with no review.
3. **Patch F verification.** When the first result for a file routed that way appears in `...\rasterlink\incoming\UCJV-300`, tell Claude; it imports that one result, checks CMYK + both clear slots + cost, and replays it. Then run, as the shop user:
   `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"`
   (prepared, not run; it dry-runs first and asks for YES. The config's cutoff excludes every result written before 2026-11-19 02:45 UTC.)
4. **Decide** (each is a business choice, none was made for you): who may open and edit Quotes; whether Sales gets the lead queue and the calculator; whether paid quotes should create jobs automatically; whether a deposit can start production; storefront price authority; jar MOQ 128 vs 50; whether Mimaki white is approved; the 155 + 128 historical RIP rows (F below).
5. **Disable the stale Roland task** (elevated PowerShell): `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\disable-old-roland-task-ELEVATED.ps1"`. It only disables; nothing is deleted.
6. **Retire the test jobs** (Patch G, below) from the Production page, or approve Claude doing it through the app.
7. **Agents:** create one real credential on **Agent Security** for the external lead agents and revoke the nine test credentials from July; nothing else is needed for approval-only intake.

### Patch G — the six "Unlinked (print intake)" jobs
`GSO-20260726-0001` (GSO PIPELINE TEST 3), `GSO-20260811-0001` (BUTTAWAY_bently_ROLAND), `GSO-20260811-0002` (PIPELINE TEST 3X), `GSO-20260811-0003` (PIPELINE TEST 2), `GSO-20260825-0001` (Pre roll … _TEST_ROLAND), `GSO-20261107-0001` (Neon Horror Glow Print Test Sheet).
All six: status *new*, one item, no files, no print-log rows, no material usage, no reservations, no quote or order. Five are tests by name; `BUTTAWAY_bently` cannot be proven a test from the data. The last has QC and reprint events from testing. **Safe retirement: set status to Cancelled from the Production page** (the normal path; history is kept; cancelled jobs leave the board and can no longer receive files). No deletion is needed. Not done tonight — it is production data. The other twelve jobs are tests as well and can be cancelled the same way.

### F. Historical RIP data — plan only, nothing applied
| Group | Rows | What it is | Recommendation |
|---|---|---|---|
| A. Provably correctable | 155 | Ink stored as a per-item value instead of per-item × arranged copies. Re-parsing each import's own stored source gives the corrected figure: 41.9 mL → 3,488.9 mL (+3,447 mL). | Apply in one reviewed batch after the first live result proves the pipeline. |
| B. Phantom rows | 128 | Rows created from orphan count lines; zero ink, no name. | Retire (mark, do not delete). |
| C. Unreproducible | 4 | Stored rows that the stored source no longer reproduces (0.4 mL total). | Leave as they are. |
| D. Backlog | 892 files | Results written June–Nov to `incoming\GSOP`, never imported. | No operational value for job costing (none can link to a job). Import only if the ink history is wanted for calibration. |

None of groups A–C is linked to a production job, so correcting them changes the print-log history only — **no job cost, quote or price moves**.

### Mimaki gloss calibration observations (recorded, not a rate)
Item 3.989 × 5.000 in = 0.1385 sq ft; 65 copies = 9.00 sq ft of page area (not inked area). RasterLink Properties (owner): `shortcakes F` CMYK 12.279 cc, clear 19.982 cc; `shortcakes b` CMYK 9.900 cc, clear 26.126 cc; `mixed berries F` clear 26.918 cc. JobInfo.ini (rounded per item × 65): 11.70 / 19.76, 9.23 / 26.00, 12.22 / 26.78. Gloss layer runs 32 passes against 16 for CMYK. Print + cut together took about 86 minutes per job; print-only time is not recorded by RasterLink.

## G. Agent matrix

| Agent / automation | Purpose | Trigger | Status | Reads | Writes | External actions | Approval gate | Provider | Worker | Launch-ready | Blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|
| External agent intake API (`/api/agent/intake`) | Receive leads from outside agents | External POST, signed | **READY** | Credential, submission log | Review queue item + event + log | None | Every item needs staff approval; can never become a quote by itself | none (caller's) | n/a | **Yes** | Only test credentials exist |
| Agent Review Queue (page) | Staff triage; create draft quote | Manual | **READY** | Queue | Queue status, draft quote | None | Human only | — | — | **Yes** (owner / authorized manager) | Sales cannot see it |
| Print Intake Agent (shop PC) | Route print files to the presses | Scheduled task, 30 s poll | **READY** | Watch folder, ERP plan | Hot-folder copy, report | Physical: file to RIP | Server decides; holds on any doubt | — | Running | **Yes** | Jobs must exist |
| RasterLink result sync (shop PC) | Upload RIP results + JobInfo ink | Task (not created) | **PARTIAL** | Result folder, job folders | Print-log rows | None | — | — | Not scheduled | No | First live verification |
| Roland result sync | Roland actuals | Old task, old clone | **OBSOLETE** | — | — | — | — | — | Stale | No | Manual CSV by decision |
| orders/paid webhook | Storefront order → job; quote payment | Shopify | **READY** | Order | Job, quote status, review items | Slack alert | Verified payment only | — | — | Yes | — |
| Production Slack alert | "New job" message | Job created | **PARTIAL** | Job | Job event | Slack webhook (internal) | None (internal only) | — | — | Unverified | Webhook URL unverified |
| Slack approval endpoint | Approve / reject intents | Slack button | **PARTIAL** | Intent | Intent status, audit | None | Mapped staff only | — | — | No | Nothing creates intents |
| Ops outbox worker (`/api/ops/worker/run`) | Deliver queued internal messages | External cron (none) | **BLOCKED** | Outbox | Outbox | Sandbox Slack only | Refuses consequential actions | — | Not scheduled | No | No scheduler, nothing enqueues |
| Operations supervisor + reasoning runtime | LLM planning | None in production | **DRAFT** | Fixtures | Agent run | None | Tool gateway | OpenAI (unset) | — | No | No caller; provider unconfigured |
| Lead manager, sales intake (library), quote prep, follow-up, reorder, art preflight, art approval, purchasing, planner, dispatcher, QA, shipping, sales / production reporting, status, exception, invoice coordinator | Deterministic helpers | Simulator and tests only | **DRAFT** | — | — | None | — | deterministic | — | No | Not wired to real data |
| Cannabis packaging lead finder | Prospecting | — | **External only** | — | — | — | — | external GPT | — | Research mode only | No repo code; lives outside |
| Commercial print lead finder | Prospecting | — | **External only** | — | — | — | — | external GPT | — | Research mode only | Same |
| Marketing agent | Campaign drafts | — | **DRAFT** | — | — | None | — | unset | — | No | Scaffold |
| Customer notifications | Email / SMS | — | **DRAFT** | — | — | Never sends (no provider) | — | none | — | No | No provider by design |

**Provider configuration (production values): UNKNOWN** for `OPENAI_API_KEY`, `GSO_OPENAI_MODEL`, `GSO_REASONING_PROVIDER`, `GSO_AGENT_REASONING_ENABLED`, `GSO_AGENT_EXECUTION_ENABLED`, `GSO_OPS_WORKER_TOKEN`, `SLACK_*`. All default to off. No Anthropic, email or SMS integration exists in the code. **No code path can send an email, SMS, DM or social post**; the only outbound customer contact is a `mailto:` link a person clicks, and the Shopify invoice email a person sends from a quote.

## H. End-to-end flow

| Handoff | Status | Note |
|---|---|---|
| Lead → review queue | YELLOW | Works through the signed intake API; Sales cannot see the queue; no customer record. |
| Lead → quote | YELLOW | Owner / authorized manager converts; core families must be re-entered in the calculator. |
| Quote → Shopify draft order → payment | GREEN | Verified against the quote's own draft order and subtotal. |
| Paid quote → ProductionJob | YELLOW | Manual click; full payment required; not surfaced on Home. |
| Storefront order → ProductionJob | GREEN | Automatic and idempotent for configurator lines. Other lines go to an owner-only review item. |
| Off-system order → ProductionJob | **RED** | Nobody enters it. New Job form is the path (E2). |
| ProductionJob → Print Intake | GREEN | Ticket in the file or folder name, or manual assign. |
| Print Intake → RIP | GREEN | Verified with one real file. |
| RIP → actuals | YELLOW | Code deployed; waiting for the first ERP-linked result; no sync task yet. |
| Actuals → job cost | YELLOW | Print-log actuals can be applied to a job by the owner; never automatic. |
| Production → fulfilment | YELLOW | Recorded on the job; Shopify not updated. |
| Fulfilment → reorder | RED | No customer reorder mechanism. |

## I. What changed overnight

**Commits (all on `main`, pushed, deployed):**
- `49fedaa` — shared press routing follows restored Mimaki gloss; negated gloss wording is not gloss; *Auto* for non-white work resolves to the Mimaki; white unchanged.
- `48c5046` — security and staff fixes from the audit (list below).
- `4c37645` — result sync v1.3: go-live cutoff (`NotBeforeUtc`).

**Fixed (each pinned by a test):**
- No role gate at all on: Print Log Settings (any staff account could rotate and read the shop-PC upload token, or switch imports off), Agent Security (mint / revoke agent credentials), Wholesale discount settings and price rules, Wholesale applications, Configurator Sync (bulk storefront write), Ops Hub. Each now has one.
- Quotes: deleting a quote, creating a Shopify draft order and emailing an invoice now need an assigned selling role; saving with another shop's quote id writes nothing; a quote that took money or reached production can no longer be deleted, or moved back to draft by staff (which unlocked its price snapshot).
- Vendor Cost Book and Production: ids from the request are checked against the shop before any write.
- Quote notes copied onto a production job no longer include the low-margin approval line (margin percentages) or internal audit lines — they were printing on the work order and proof sheet.
- orders/paid: a replayed full payment no longer pulls a quote back out of production; a paid order naming an unknown quote now leaves a review item.
- Stock Levels: forms the server refuses are no longer shown to roles that cannot use them. Two stale instructions corrected.

**Tests:** 4,028 passed, 2 skipped, 5 known failures (theme export file not in the repository). New: `shared-routing-gloss-restored-2026-11-18` (33), `launch-audit-security-2026-11-18` (18); 16 older routing test files re-pinned to the new rule. Typecheck 263 errors (unchanged baseline). Build passes. Sync script self-test passes on PowerShell 5.1.

**Migrations:** none. **Schema changes:** none.

**Prepared on this PC, not run:** `C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1`, with the v1.3 script and config beside it.

**Stale documents found (not rewritten):** `GSO_ERP_PRINT_INTAKE_JOB_CREATION.md` (describes intake creating jobs — removed by Patch C); parts of `GSO_ERP_JOB_IDENTITY_AND_ROUTING_CONTRACT.md` and `GSO_ERP_QUOTE_TO_PRODUCTION_AUDIT.md`; `GSO_OWNER_DECISIONS_BEFORE_RELEASE_2026-10-07.md` #9 ("Mimaki CMYK-only"); `GSO_PRICING_AUTHORITY_MATRIX.md` split-bag blank cost; `CLAUDE.md` ("There is no test suite").

## J. What was not touched

No customer email, outreach, post or campaign. No money spent, no refund, payment or accounting change. No supplier order. No fake order or job in production. No QA print. No production record deleted, cancelled or edited by hand — production counts are unchanged (18 jobs, 1,401 print-log rows, 942 imports, 5 job files). No RIP backlog import, no historical correction. No price, cost, margin or calibration invented or changed. No Shopify product, theme or order changed (Shopify was read only). No secret read out, rotated or added; no Render setting changed. No schema migration. No scheduled task created, changed or stopped; the live watcher was not touched and is running. No force push, no history rewrite, no deletions.
