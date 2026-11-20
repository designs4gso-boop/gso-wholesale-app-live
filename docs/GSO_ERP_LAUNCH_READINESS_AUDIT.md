# GSO ERP — Launch Readiness Audit

**Date:** 2026-11-19 (late night) — updates the 2026-11-18 audit. **Software readiness 84% · live operational readiness 40%** as of 2026-11-20 evening (see the first section). **Code:** `main` at the commit that carries this document (started the day at `2eb6bd6`). **Deployed:** yes — each push today was confirmed live on Render by a new route answering.

This is the single authoritative readiness report. Everything marked *verified* was checked tonight against production (read-only), the live Shopify store (read-only), this shop PC, or the code. Anything that could not be checked is marked *unverified*. Scores are judgement, not arithmetic — they are deliberately conservative.

---

## James software gap closure — 2026-11-20 evening (read this first)

**SOFTWARE READINESS: 84%** · **LIVE OPERATIONAL READINESS: 40%** (nothing new was proven with real work).

Every production-side defect listed in the afternoon section below as "known and NOT fixed" is now fixed, except where noted here.

**Fixed and deployed**
- **File names:** two different files whose names differ only by spaces or punctuation no longer get the same routed name (the second gets a short mark); a long name keeps its ticket, layer and run mark.
- **Corrected artwork during an open reprint** now belongs to that reprint (it carries the reprint's run mark), not to the original.
- **Same-artwork reorder:** the earlier job's file history is never moved; the new job gets its own record.
- **Revised reorder:** the file is held ("new proof approval required") until the job's proof is approved. Same-artwork reorders are not held.
- **Mimaki white:** one rule everywhere — white + Mimaki is refused or held; white with no printer goes to the Roland. In the Cost Calculator, a white job on Auto now resolves to the Roland (provisional) instead of stopping for missing load data. No price, rate or calibration changed.
- **Stock Bag orders** get their own nine-step checklist (no artwork / proof steps). New jobs only.
- **Reprint:** a repeated submission of the same request is recorded once, including after QC; a later, separate reprint still works. "Who pays" must be chosen — it is no longer pre-selected.
- **Finished jobs:** a file with a finished or cancelled job's ticket (item, job or folder form) is held; a late "routed" report cannot write to a closed job.
- **Run cost** (owner / authorized managers): ink and press time as actuals; material and finishing shown only as the quoted estimate for the original run, labelled as such; everything else "not recorded"; marked PARTIAL COST.
- **Job page:** per item — ticket, files by layer, routed name and printer destination, a six-step trail (waiting for files → matched → routed → result → QC → ready), held-file reasons in plain words, reorder link. New Job shows every item ticket and an "open this job" button.
- **Board:** quantity reads "750 across 2 items"; mixed printers / finishes say "differs by item"; held and reprint rows show why.

**Prepared, not switched on (James / Windows)**
- **Mimaki result sync v1.4** — READY TO ENABLE AFTER LIVE PATCH F VALIDATION. It refuses to run without an activation time, ignores everything older than activation (the 40 files in the folder today can never upload), uploads only ticketed results, and survives log and server failures. Installed in `C:\GSO-RIP-Result-Sync\`; no task registered. `docs/GSO_MIMAKI_RESULT_SYNC_ENABLEMENT.md`.
- **Print Intake watchdog** — a separate small task that restarts the existing watcher task only when it has gone quiet. Script ready, never run. `docs/GSO_PRINT_INTAKE_RUNTIME.md`.
- **Token rotation** — owner-only button verified by tests (old token refused on every endpoint); helper script updates the two local configs without showing the token. Not rotated.

**Still open on the software side (small)**
1. Watcher v1.11: a failed console write could still stop it in a rare case; the local fallback log has one location only; the banner can stay green while the Prints For Today folder is unreadable. Fixes are written up, not installed.
2. The watchdog cannot judge an idle watcher (empty inbox writes no log lines) until the watcher writes a small heartbeat file — it does nothing in that case, by design.
3. A reorder that reuses the **identical** file: the server now handles it correctly, but the watcher skips a file it has already delivered once. Re-export the file (or use Release on Incoming Print Files) for the reorder.
4. On a reprint, a revision that was saved with the ticket typed in front can be counted as a second layer.

---

## James production-side closeout — 2026-11-20 afternoon (read this first)

Live facts, checked on the RIP PC today (they supersede anything older in this document):

| Item | State |
|---|---|
| **GSO Roland Result Sync** task | **DISABLED.** Roland actuals: manual CSV. Not to be re-enabled. |
| **GSO Print Intake Agent** task | **RUNNING**, watcher **v1.11**, starts at logon of `golde`. |
| Mimaki result sync task | **Does not exist.** READY TO ENABLE AFTER LIVE PATCH F VALIDATION (`docs/GSO_MIMAKI_RESULT_SYNC_ENABLEMENT.md`). |
| Reboot survival | Not yet. Recommendation: keep the logon task, add the watchdog, and let Windows sign in by itself (`docs/GSO_PRINT_INTAKE_RUNTIME.md`). James's step. |
| Print Intake token | Exposed during troubleshooting; **not rotated yet**. Owner-only button exists; runbook in `docs/GSO_PRINT_INTAKE_RUNTIME.md` section 6. James's step. |
| Render roles | UNKNOWN from the code. One-minute check: `docs/GSO_STAFF_ROLE_SETUP.md`. |

**Fixed today (production side):**
- Watcher v1.11: a file can no longer be copied to the press a second time when the archive move fails; one watcher per PC; an unreadable ledger skips the pass instead of re-routing; the "routed" report is retried.
- A reprint with no "who pays", or with an unknown kind, is refused (it used to be recorded as internal / reprint).
- Two long file names that differ only in the middle no longer get the same routed name.
- A file literally named like a run mark (`A2.pdf`, `P1-A1.pdf`) is no longer read as one.
- A file saved with a finished or cancelled job's item ticket is held until the job is reopened.

**Known and NOT fixed (each is rare, each has a floor workaround in the SOP):**
1. Two files on one item whose names differ only by spaces / punctuation (`HEATH F.pdf`, `HEATH_F.pdf`) get the same routed name. Use names that really differ.
2. Corrected artwork saved **during** an open reprint is treated as a revision of the original and its press result counts on the original run.
3. A reorder with the **same artwork file**: the earlier job's file-history line in Incoming Print Files moves to the new job (the earlier job, its items, runs and press results are not changed).
4. "Revised artwork — new proof required" on a reorder is a label. Nothing stops the file from routing before the proof is approved.
5. A very long custom RIP name can lose its run mark.
6. The watcher banner is only on Incoming Print Files; nothing notifies anyone when it turns red.

**Decisions waiting for James** (`docs/GSO_JAMES_DECISIONS.md`): Stock Bag checklist wording; the bag / sticker cost basis (seven small questions, two answerable today); Mimaki white (the code still allows a white-only job with no printer chosen to be balanced onto the Mimaki — nothing was changed); and the employee timing study (`docs/GSO_APPLICATION_TIMING_WORKSHEET.md`).

**Handoff:** `docs/GSO_JAMES_TO_RAQUEL_HANDOFF.md`. Production checklist for the first job: `docs/GSO_FIRST_REAL_JOB_CHECKLIST.md`.

---

## Software push — 2026-11-20 (read this first)

**SOFTWARE READINESS: 81%** (was 76%) · **LIVE OPERATIONAL READINESS: 40%** (unchanged — nothing was proven with real work today).

Five kinds of status are kept apart below: **software complete**, **live validated**, **owner decision**, **external authorization**, **Windows admin**. A finished piece of software is not marked down because someone has not yet signed in to a provider or printed a job; it is also not called operational until that proof exists.

| Area | Software | Live | What it is waiting for |
|---|---|---|---|
| Core ERP | 90% | 55% | Live: real jobs. |
| Production | 90% | 50% | Live: real jobs; staff roles on Render (owner). |
| Print Intake | 92% | 80% | Live: first routed file. Windows admin: reboot survival. |
| Reprint / remake | 87% | 30% | Live: first real reprint. |
| Reorder | 85% | 25% | Live: first real reorder. |
| RIP actuals | 80% | 30% | Live: one ticketed Mimaki job (`docs/GSO_FIRST_REAL_JOB_CHECKLIST.md`). |
| Pricing | 75% | 60% | Owner decision: cost basis (`docs/GSO_PRICING_ENGINE_DECISION.md`). Shop timings. |
| Shopify | 72% | 50% | Owner decision: Stock Bag checklist wording; holographic sticker floor in the calculator. |
| Fulfilment | 70% | 30% | External: Shopify fulfilment permission. |
| CRM | 85% | 10% | Live: first real customer and lead. |
| Sales | 75% | 35% | Owner: `sales` role on Render. |
| Agents | 72% | 10% | External: one credential with proposals allowed. Software: no scheduler / internal runtime. |
| QuickBooks framework | 74% | 0% | External: Intuit app + consent. Raquel: release rules. |
| Raquel admin | 76% | 20% | Raquel's decisions; first real release. |
| Security | 92% | 65% | Owner: Render environment check. |
| Operations / deployment | 84% | 65% | Windows admin: two elevated scripts. |

### What was built on 2026-11-20
- **Customers** (Sales → Customers): one customer record with its leads, quotes, jobs, everything made for them, reorders, notes and history. Quotes and jobs are matched by exact e-mail or exact company name only. People who are on quotes or jobs but are not customers yet are offered — never added automatically.
- **Signed agent proposal endpoint** (`POST /api/agent/proposals`): an outside agent can submit a draft message, follow-up, lead assignment, quote proposal or reorder recommendation. Every one lands in Sales → Approvals and waits for a person. It needs a credential the owner created with *proposals allowed* ticked; older credentials are refused. It cannot send, order or charge.
- **Agent registry → approvals**: the registry decides which agent may propose what; Approvals shows the list.
- **New Job now has the More items box.** The simple New Job form could only create single-item jobs; multi-item entry existed only on the owner's advanced page. Fixed — this mattered for the first real job.
- **Reorder is safe to double click**: one request makes one draft quote.
- **Two approvals at the same moment apply once.**
- **Storefront fixes (owner rules, no price change):** a Stock Bag order no longer carries a Zakeke design; a jar with no launch size (the cost-only 5 oz) is no longer listed as active; configurator sync writes minimum 50 for Stock Bags instead of 64.
- **Cost snapshot now covers stickers.** Jars and DTP pouches stay "not captured", each with its exact reason (below).
- **Run cost in dollars** on the job page for the owner / authorized managers: ink and press time per run, marked partial. Material, labour and finishing are not included because nothing records them per run.
- **Release to Production** no longer assumes quantity 1 when a quantity is missing; an item with no quantity or no name blocks release.
- **First-job guidance**: one line under the next step on the job page says what the system is waiting for.
- **Quotes** no longer mentions cost or margin in headings shown to sales.

### Correction to last night's audit
The worked example in the 2026-11-19 section below ("the storefront price is about $75 higher") compared application labour only and pointed the wrong way. On the full engines, for 1,000 holographic 3X double-sided sticker bags the storefront cost basis is **lower**: the live price is $2,200 and the same price rules on the Cost Calculator's cost basis give $2,850. Plain matte bags are identical on both. The full comparison and the one decision are in `docs/GSO_PRICING_ENGINE_DECISION.md`. Nothing was changed.

### Cost snapshot coverage
| Family | Captured | Why not |
|---|---|---|
| Stock Bags, Sticker Bags | Yes | |
| Stickers | Yes (new) | |
| Jars | No | The checkout does not record which labels (side / lid / band) were ordered or the white coverage; the cost engine needs both. |
| DTP pouches | No | Inbound freight is not verified; vendor configuration and design count are not in the checkout record. |

### Storefront fixes reviewed
| # | Product | Safe without owner | Done |
|---|---|---|---|
| 1 | Stock Bag carrying a Zakeke design | Yes | Fixed — the id is dropped, never rejected; checkout cannot fail because of it. |
| 2 | Jar with no launch size listed as active | Yes | Fixed — all nine launch jars unchanged. |
| 3 | Configurator sync writes minimum 64 for Stock Bags | Yes | Fixed — writes 50. |
| 4 | Stock-Bag-only order gets the default production checklist | **No** | Not changed. The label checklist's "Artwork received" and "Proof approved" steps assume customer artwork; premade art needs your wording. |
| 5 | Holographic sticker floor (matte × 1.20) not in the Cost Calculator | **No** | Not changed. It would raise quoted prices. |

### Known limits found by today's tests (not defects in normal use)
- A background-worker message that is not tied to an approval can run twice if the worker dies after doing the work and before marking it done. Nothing uses that path in production today.
- A reprint posted again **after** QC was recorded is a new reprint (there is no request id on the reprint form). A replay before QC is refused.
- If the production-alert message fails on the first delivery of a paid order, it is not re-sent on the retry.

### P1 — remaining
1. No real work is in the ERP. *(live — James)*
2. Render environment unverified; sellers need the `sales` role. *(owner)*
3. Patch F not validated on the press. *(live — one Mimaki job)*
4. QuickBooks not connected; release rules undecided. *(external + Raquel)*
5. Storefront cost basis. *(owner decision)*
6. Watcher starts only at logon. *(Windows admin)* The stale Roland task is now disabled.

### Windows admin — exact commands (elevated PowerShell)
```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\disable-old-roland-task-ELEVATED.ps1"
cd C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp-release-20261017
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5
```
Neither script has ever been run; both were reviewed and parse-checked. The watcher task still needs someone signed in to Windows, so an unattended reboot also needs Windows automatic sign-in.

---

## Readiness jump — 2026-11-19 late night (read this first)

This section supersedes the scorecard (A) and the P1 list (D) below wherever they differ. Sections B–J are kept as the record of the earlier audit.

**Two numbers, because one number hid the real picture:**

| | Score | Meaning |
|---|---|---|
| **SOFTWARE READINESS** | **76%** | How much of the software exists, is tested and is deployed, leaving aside things only a person or an outside provider can do. |
| **LIVE OPERATIONAL READINESS** | **40%** | How much has been proven by real use: real jobs, real press results, real staff accounts, real settings. |

The earlier single figure (64%) blended the two. They differ because almost everything built this week has never carried a real job: there is still not one real job in the ERP.

**Found and fixed tonight — the print-file watcher was down.** It stopped at 4:47 PM on 2026-11-19 (one failed log write to the NAS ended the script) and nothing restarted it. It was down for about 4 h 50 min; no file was lost, because files wait in Prints For Today. The script (v1.10) now survives a failed log write and a failed pass, it was restarted at 9:39 PM, and the ERP now records a watcher heartbeat: **Incoming Print Files shows a red banner when the watcher stops checking in.**

### Scorecard by area

SOFTWARE COMPLETE = built, tested, deployed. LIVE VALIDATED = proven with real work. The last column is what is still needed and from whom.

| Area | Software | Live | Still needed |
|---|---|---|---|
| Core ERP | 88% | 55% | Real jobs entered (James). |
| Production | 88% | 50% | Real jobs; staff roles set on Render (James). |
| Print Intake | 92% | 80% | First routed file under the new name; reboot survival (Windows admin). |
| Reprint / remake | 85% | 30% | First real reprint on the floor. |
| Reorder | 80% | 25% | First real reorder. Release screen now has the reorder picker. |
| RIP actuals | 78% | 30% | SOFTWARE READY — LIVE PRESS VALIDATION REQUIRED (one ticketed Mimaki result). Roland stays manual. |
| Pricing | 72% | 60% | Owner decision on the storefront cost basis (below). Application timings pending shop timing. |
| Shopify | 65% | 50% | Storefront fixes that touch the live checkout were left for review (below). |
| Fulfilment | 70% | 30% | Shopify fulfilment permission (external). Until then Shopify is marked by hand and the job says so. |
| CRM | 70% | 10% | Built tonight; never used. No customer list page yet. |
| Sales | 65% | 35% | Sales must hold the `sales` role on Render to open Quotes. |
| Agents | 50% | 10% | Approval queue works for staff-made proposals. No signed agent endpoint for proposals yet; nothing is scheduled. |
| QuickBooks framework | 72% | 0% | Intuit app + Raquel's consent (external); Raquel's rules. |
| Raquel admin | 72% | 20% | Her decisions; first real release. |
| Security | 90% | 65% | Render environment check (James). |
| Operations / deployment | 82% | 65% | Elevated Windows steps; watcher reboot survival. |

### What was built and deployed tonight

- **One access table for every admin route** (`app/lib/route-access.ts`), enforced on the server. Quotes — the loader and every action — now needs a selling role (owner, manager, sales). Manual lead entry, the agent rule pages and Launch Readiness got a role floor too. A route registered without an entry in the table fails a test.
- **Internal CRM**: leads with the lifecycle new → qualified → assigned → contact pending → contacted → follow-up due → quote created → won / lost; assignment, follow-up date, notes, full history; conversion to a customer account and to an empty draft quote (both safe to click twice). Sales → Leads. It sends nothing.
- **Approvals queue** (Sales → Approvals, owner and managers): proposals wait for a person; approve or reject with a reason; every step audited; tenant-scoped. Approving never sends anything. An approved lead assignment or follow-up date is applied to the lead; an approved draft message is sent by a person by hand.
- **Reorder picker on Release to Production**: per production item, pick the earlier item it re-orders and whether the artwork is the same or revised. Nothing is pre-selected; a stale or unknown pick is refused.
- **Cost snapshot on storefront orders**: when a paid order becomes a job, each new bag item stores the cost basis in force at that moment (forward only). Families whose storefront engine returns no cost are stored as "not captured" with the reason — never as $0.
- **Fulfilment**: Ready to ship / Ready for pickup on the job and the board; shipment and pickup record whether Shopify was updated (today: never — the job says to mark Shopify by hand).
- **QuickBooks read-only boundary**: an adapter interface with no write method, provider facts on staged transactions, a person-set customer link. Not connected; no rule decided.
- **Run costing**: each run is classified original / shop-absorbed / customer-paid, with its own press ink and time; the board shows the reprint on the press now.
- **Privacy requests**: received → in progress → completed, working notes, append-only history, overdue flag; CRM contact details are included in an erasure. Nothing is deleted.
- **RIP results defect fixed**: a result file named after a ticketed layer no longer lends its ticket to an un-ticketed layer inside it.
- **Sales rules**: Stock Bags (MOQ 50) and die-cut pouches (MOQ 2,500) resolve to their own family.
- **`/api/health`**: says which build is serving, so a deploy can be verified without signing in.

### P0
None verified. Unchanged: `GSO_OWNER_ENFORCEMENT=temporary_all_staff` on Render would be P0 if set.

### P1 — closed tonight
- Quotes page had no role floor → closed.
- Storefront orders carried no cost snapshot → closed for Stock Bags and Sticker Bags; other families are recorded as not captured.
- Invoiced reorders had no picker on the Release screen → closed.
- No lead lifecycle / CRM → foundation built.
- The watcher could die silently → hardened, and the ERP now shows when it stops.

### P1 — remaining
1. **No real work is in the ERP.** (James)
2. **Render environment unverified.** New tonight: an account with **no role can no longer open Quotes**. Anyone who sells needs `sales` (or `manager`) in `GSO_STAFF_ROLES`. (James)
3. **Patch F not validated on the press.** Software ready; needs one ticketed Mimaki result. (real print job)
4. **QuickBooks not connected; release rules undecided.** (Intuit + Raquel)
5. **Storefront cost basis — owner decision.** Stock / sticker bags and stickers are priced on the storefront from an older cost model than the Cost Calculator uses. Both feed the same price policy, so prices differ only where cost controls the price. (The worked example that stood here was wrong — see the correction in the 2026-11-20 section above and `docs/GSO_PRICING_ENGINE_DECISION.md`.) Changing it moves live prices, so it was not changed. (James)
6. **Watcher starts only at logon.** `tools/register-print-intake-startup-task-ELEVATED.ps1` is ready. (Windows admin)
7. **Stale Roland task starts on the next reboot.** (Windows admin)

### Deterministic storefront fixes deliberately NOT made tonight
They are correct by the owner's stated rules but change the live checkout or the live storefront, which this work does not touch unattended:
- A Zakeke design id is still accepted on a Stock Bag order (rule: Stock Bags have no Zakeke).
- A jar with no launch size (for example the cost-only 5 oz) is still listed as active by the storefront loader; checkout already refuses it.
- The configurator sync still writes minimum quantity 64 to Stock Bag rows; the storefront ignores it and enforces 50.
- A Stock-Bag-only paid order gets the default production checklist.
- Holographic sticker floor (matte × 1.20) is applied on the storefront but not in the Cost Calculator.

### Owner actions (changes from the lists below)
- **James:** on Render, give every seller the `sales` role before they next open Quotes. Open Incoming Print Files and confirm the watcher banner is green.
- **Raquel:** unchanged, plus two small ones — should managers see invoice balances, and how should a QuickBooks customer be linked to an ERP customer.
- **Windows admin (elevated):**
  1. `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\disable-old-roland-task-ELEVATED.ps1"`
  2. `powershell -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WhatIf` then the same with `-WatchdogMinutes 5` (run from the repo folder). Without Windows auto sign-in the start-up trigger alone does not start the watcher at the sign-in screen; the script explains both choices.
- **External:** unchanged.

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

Scores are judgement, deliberately conservative. "Tested" means automated tests and a passing build; nothing below was exercised with a real customer job yet.

| Area | Score | Change | Why |
|---|---|---|---|
| Core ERP (quotes, product setup, cost engine, jobs) | **78%** | +3 | One job service now covers every source, including a reviewed release. Still never run by real orders. |
| Production Board | **85%** | new | Shared by owner, manager, production lead and finisher. Cards show items, quantity, due date, priority, assignment, printer, finish, files awaiting / received, QC, reprints, hold note and reorder marker. Not yet used on a real job. |
| Job / item backbone | **85%** | new | Master job, item tickets, exact file-to-item link, production runs and reorder lineage are in the schema and deployed. |
| Print Intake | **90%** | = | Live and healthy after today's deploys (watcher log clean). Routed names now carry item ticket + staff name; first real routed file not yet seen. |
| Reprints / remakes | **80%** | new | Quantity, type and who-pays are required; every layer is re-routed; each reprint is its own run; QC closes the run. Run actuals appear per run. Untested on the floor. |
| Reorders | **65%** | new | Reorder → draft quote with lineage and current pricing works. Most real jobs are manual, so their reorders arrive needing an owner price. Invoiced (QuickBooks) reorders have no screen yet. |
| RIP actuals | **58%** | +3 | Results are now attributed to the exact run. Still no ERP-linked Mimaki result to verify (all of today's results are un-ticketed CRUD files), so the sync task stays off. Roland manual. |
| Pricing / costing | **70%** | = | Unchanged. Application timings are frozen pending real shop timing. Two storefront price engines still disagree. |
| Product readiness | **60%** | new | Not re-audited tonight; carries last night's findings (below). |
| Shopify / storefront | **55%** | = | Unchanged. |
| Fulfilment | **40%** | = | Recorded on the job only. The app has no Shopify fulfilment permission, so nothing can be sent to Shopify without a scope change. |
| CRM | **30%** | new | A lead record exists (review queue) with assignment and conversion to a quote. No contacted / follow-up / won-lost lifecycle, no customer record. |
| Sales | **45%** | +10 | Quotes work; reorder is now a real action for sales. Sales still cannot price core families or see the lead queue. |
| Agents | **22%** | +2 | Agent-approved work now has a defined route into the one job service. Nothing new runs in production. |
| Marketing automation | **5%** | = | Draft scaffold. Nothing can send. |
| Admin workflow (Raquel) | **55%** | new | Release to Production screen, role lane and plain-language guide are ready. No QuickBooks connection; every business rule is still open. |
| Security / permissions | **85%** | +5 | Role lanes pinned by tests; privacy webhooks are now recorded. Render environment still unverified. |
| Deployment / operations | **72%** | +2 | Three additive deploys today, each confirmed live. Watcher still starts only at logon. |

**OVERALL LAUNCH READINESS: 64%** (was 60%). The software moved; the business's use of it did not — there is still not one real job in the system.

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

### P0 — unsafe to launch
None verified. **One unverified item would be P0 if true:** `GSO_OWNER_ENFORCEMENT=temporary_all_staff` on Render makes every signed-in staff account an owner and voids every role gate. It cannot be seen from the repo. Check it first (Owner actions, James 1).

### P1 — fix before broad rollout
1. **No real work is in the ERP.** Workaround exists today: New Job (now multi-item) with the invoice number as the reference.
2. **Render environment unverified:** `GSO_OWNER_SHOPIFY_USER_IDS`, `GSO_STAFF_ROLES` (without it the production lead sees only Home), `GSO_MANAGER_AUTHORIZED_USER_IDS`, `GSO_OPS_REPOSITORY`.
3. **Patch F not verified live.** No press result carries a ticket yet, so the Mimaki result sync stays unregistered.
4. **QuickBooks is not connected** and no release rule is decided (Raquel).
5. **Quotes page has no role floor for viewing and saving** — owner decision, unchanged.
6. **Storefront price authority** — two engines disagree for stock / sticker bags and stickers; unchanged.
7. **Storefront orders carry no cost snapshot** — unchanged.
8. **Print Intake watcher starts only when `golde` logs on.** After a reboot with nobody logged in it is off (Windows action 2).
9. **Stale "GSO Roland Result Sync" task has a boot trigger** and points at the old clone. It is Ready, so it will start on the next reboot (Windows action 1).

**Closed tonight:** compliance webhooks (were acknowledged and dropped; now recorded with a due date, owner-applied erasure); New Job single-item limit; reprint re-routing only the newest layer; file with no item link.

### P2 — launch with a workaround
- No Shopify fulfilment / tracking sync (fulfil in Shopify by hand). Needs a new app permission.
- Reorders of manual jobs need an owner price each time; invoiced reorders are entered through New Job without a lineage picker.
- Customer-paid reprints are only recorded; the invoice is made by hand.
- Press results are attributed to runs by name token, not stored as a link; fine for reading, not yet used in job costing.
- Erasure requests are applied by the owner by hand (by design); shop erasure after an uninstall is recorded only.
- Application timings (jars, bags) are in force but **pending real shop timing validation** — owner will supply measured times.
- Sales has no lead inbox; paid quotes waiting for *Create Production Job* are not on Home; deposit-only quotes cannot start production.
- A double click can create two Shopify draft orders for one quote.
- Public quote link `/quote/:id` is protected only by its id; the wholesale pricing app-proxy trusts an e-mail in the query string.
- Roland actuals by manual CSV. Bag inbound freight not modelled; MIRON Ceres freight pending.
- Jar MOQ: sales rules say 128, storefront enforces 50.
- Live theme pilot template still has the Zakeke block enabled and a minimum of 64 (the server enforces 50).
- The watcher re-reads each held 200 MB CRUD file every 30 seconds until those files are linked or moved.

### P3 — after launch
Lead lifecycle (contacted, follow-up due, won / lost) and a customer record; agent runtime with a scheduler; stored run link on print logs and run cost in job costing; Mimaki gloss and white calibration; pallet freight allocator; Southwest Cargo freight; boxes and apparel in the canonical engine; health endpoint with a database check.

## E. Owner actions

### James / production
1. **Check Render → Environment (2 minutes).** `GSO_OWNER_ENFORCEMENT` absent or `enforced`; your Shopify user id in `GSO_OWNER_SHOPIFY_USER_IDS`; each employee in `GSO_STAFF_ROLES` as `id:role` (production lead = `print_operator`). **Admin → Staff Access & Readiness** shows what the server sees.
2. **Put the CRUD work into the ERP.** Production → New Job: customer, invoice number as reference, first item, the rest under *More items* (`name | quantity`). Then Incoming Print Files → select the held CRUD files → Assign to the job and item.
3. **From then on: job first, files second** (`docs/GSO_PRODUCTION_WORKFLOW.md`). Watch the first routed file arrive at the press as `<item ticket>__<file name>`.
4. **Tell Claude when the first ticketed result appears** in `...\rasterlink\incoming\UCJV-300` so Patch F can be verified and the sync switched on.
5. **Time the application steps** (jars: body, lid, band, per size; bags: 4x5, split, 14x16) and send the measured seconds. Nothing changes until you do.
6. **Decide:** storefront price authority; jar MOQ 128 vs 50; whether Mimaki white is approved; who may open and edit Quotes; whether Sales gets the lead queue; the six test jobs (Patch G below); the 155 + 128 historical RIP rows.

### Raquel / admin
Everything is written out in `docs/GSO_RAQUEL_ADMIN_QUICKBOOKS_WORKFLOW.md`. In short: which invoice state releases work and what balance is acceptable; whether release is ever automatic; what a void or refund does to a job; which lines are never production; customer and product mapping; who else may release and see balances; whether a deposit-only or fully paid quote should start production by itself; how a customer-paid reprint is invoiced.

### Windows admin (elevated PowerShell on the RIP PC)
1. Disable the stale Roland task (disables only, deletes nothing):
   `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\disable-old-roland-task-ELEVATED.ps1"`
2. Make the Print Intake watcher survive a reboot. Either sign `golde` in automatically at start-up, or add a start-up trigger that runs as `golde` with the saved password (the NAS needs that account):
   `$t = Get-ScheduledTask 'GSO Print Intake Agent'; $t.Triggers += New-ScheduledTaskTrigger -AtStartup; Set-ScheduledTask -TaskName $t.TaskName -Trigger $t.Triggers -User "$env:COMPUTERNAME\golde" -Password (Read-Host 'Password for golde')`
   Not run: it needs the account password.
3. After Patch F is verified, as the shop user:
   `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"`

### External providers
- **Intuit / QuickBooks:** a developer app and Raquel's consent for read-only access (invoices, estimates, customers). Nothing is built against it until then.
- **Shopify:** fulfilment sync needs the fulfilment permissions added to the app, which means a reviewed `shopify app deploy` and re-approval in the store.
- **Agents:** one real credential on Agent Security for the outside lead agents; revoke the nine July test credentials. An LLM provider key only if the internal reasoning runtime is ever switched on.
- **Slack:** confirm the production-alert webhook URL is set if those alerts are wanted.

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
| **Commercial** | | |
| Lead → review queue | YELLOW | Signed intake API works; Sales cannot see the queue; no follow-up lifecycle. |
| Lead → quote | YELLOW | Owner / authorized manager converts; core families are priced in the calculator. |
| Quote → approval → payment | GREEN | Verified against the quote's own draft order. |
| Paid quote → production release | YELLOW | Manual click; full payment required. |
| QuickBooks invoice → production release | **RED** | Review and release are built; no connection brings invoices in. Workaround: New Job. |
| Storefront order → job | GREEN | Automatic and idempotent for configurator lines. |
| **Production** | | |
| Master job → items → tickets | GREEN | One service, every source; multi-item. |
| Job → artwork / files | GREEN | Job folder name and item tickets on the job page; files awaiting / received shown. |
| Files → printer | GREEN | Verified with one real file before the routed-name change; first file under the new name not yet seen. |
| Printer → RIP result | YELLOW | Results arrive; none carries a ticket yet. |
| RIP → actuals | YELLOW | Reader deployed; sync task off until one ERP-linked result is verified; Roland manual. |
| Actuals → run | YELLOW | Attributed per run by name token; not yet in job costing. |
| QC → complete | GREEN | Guards unchanged; QC now also closes the open run. |
| **After production** | | |
| Complete → fulfilment | YELLOW | Recorded on the job; Shopify not updated. |
| Fulfilment → reorder | YELLOW | Reorder action creates a new quote with lineage (was RED). |
| Reprint / remake | GREEN | Runs, quantity, all layers. Not yet used on a real job. |

## I0. What changed on 2026-11-19

**Deployed (all additive, all confirmed live):**
- Routed print-file name `<item ticket>__<staff file name>[__run]`; multi-item New Job.
- Shared backbone: exact file-to-item link, production runs, reprint quantity / type / who-pays, every layer re-routed, reorder with lineage and current pricing, staged transactions with Release to Production, role lanes described as capability groups.
- Privacy webhooks recorded for the owner (Admin → Privacy Requests); press results attributed per run; hand-added files linked to an item when certain; board cards show finish and a reorder marker.

**Migrations (both additive, applied by the deploy):** `20261119120000_add_production_lineage` and `20261119200000_add_compliance_requests`.

**Not changed:** application timings (frozen by the owner), selling prices, QuickBooks (no connection, no rule), agents' external actions (still none), the watcher script on the RIP PC, historical RIP data.

**Tests:** 4,092+ passed, 0 failed. The five long-standing failures read a local theme export that was never committed; they now skip when it is absent and run when it is present.

## I. What changed on 2026-11-18 (previous night)

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
