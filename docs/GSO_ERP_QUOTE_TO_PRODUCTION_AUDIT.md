# GSO ERP — Quote-to-Production Audit (Phase 15D, 2026-07-24)

Audit-only: no behavior changed. Baseline commit 71b1eac.

## A1. Quote CREATION paths (4)

| # | File / action | Source → destination | Status | Snapshot format | Live | Disposition |
|---|---|---|---|---|---|---|
| Q1 | app.erp.cost-calculator.tsx action `saveEmergencyQuoteDraft` | calculator GET state (psearch) → Quote(status draft)+QuoteItem | always draft | costSnapshot JSON (engine-versioned: 14B.0A/14B.1a/14C.1/14C.2/15C.2-dtp incl. dtpPricing block) + priceSnapshot tiers | live, daily | KEEP — the quoting front door |
| Q2 | app.quotes.tsx intent `save` (db.quote.create ~1406) | manual Quote Builder form → Quote+items | draft (editable) | priceRecipe-based snapshots when recipes used | live | KEEP |
| Q3 | app.erp.agent-review-queue.tsx approve/convert (tx.quote.create ~563) | approved AgentReviewQueueItem → draft Quote | draft only; explicit "no order/production created" note | agent quote-prep line | live | KEEP |
| Q4 | webhooks.orders_paid.tsx | does NOT create quotes — configurator orders write a PSEUDO quoteId string (`shopify_order_<gid>`) directly onto the ProductionJob | n/a | priceSnapshot per line (order data); costSnapshot = "pending_cost_book_mapping" | live, PROTECTED | KEEP (see central-service plan) |

## A2. Quote UPDATE / APPROVAL paths

| # | File / intent | What it does | Guards |
|---|---|---|---|
| U1 | app.quotes.tsx `status` | draft→sent→approved→…; blocked to `sent`/`approved` when quoteMarginState.approvalRequired (low-margin gate) | never touches status "paid" rows (`status: { not: "paid" }`) |
| U2 | app.quotes.tsx `approveLowMarginQuote` | records lowMarginApproved* fields (phrase-gated approval snapshot) | owner approval fields persisted |
| U3 | app.quotes.tsx `approveCreateOrder` / `createDepositOrder` / `createBalanceOrder` | Shopify draft-order/invoice creation; flags depositCreated/balanceCreated/fullOrderCreated (duplicate-order guards) | requires status `approved`; refuses if flag already set |
| U4 | webhooks.orders_paid `applyQuotePaymentFromOrder` | note "Quote ID: X" → classify deposit/balance/full via tags/notes/line props → status deposit_paid/paid with note markers; NEVER pulls a later status backward; deposit+balance both = paid | idempotent via note markers (`[GSO] … paid` appended once) |
| U5 | app.quotes.tsx `delete` | deleteMany where status != paid | paid quotes undeletable |
| U6 | quote.$id public page | read-only customer view (whitelisted fields) | no writes |

Statuses in live use: `draft, sent, approved, deposit_paid, paid, production, completed` (+ webhook-preserved ordering).

## A3. PRODUCTION JOB creation paths (3) — the core problem

| # | Path | Guard | Idempotency | Fields written | Fields LOST | Disposition |
|---|---|---|---|---|---|---|
| J1 | app.quotes.tsx `createProductionJobFromQuote` → local `createProductionJobFromQuoteInQuotes` (~line 180) | quote status must be `paid` or `production`; items required | findFirst({shop, quoteId}) then create — NOT transactional, NO unique constraint (double-click / concurrent race can duplicate) | quoteId, quoteNumber(=quote.id), customer block, items with quoteItemId/recipe/finish/addOns/costSnapshot/priceSnapshot, checklist, event, proofUrl+file | **jobTicket, assetInboxKey, itemTicket, ripJobName, suggestedFileName ALL MISSING** — print-intake/RIP/asset tooling keys on jobTicket, so quote-created jobs are invisible to it | MERGE into central service |
| J2 | app.erp.production.tsx intent `createFromQuote` → local `createProductionJobFromQuote` (~line 480) | same paid/production guard | same findFirst race | same as J1 PLUS jobTicket + assetInboxKey (buildNextJobTicket) | near-duplicate of J1 with DIFFERENT field coverage — the two implementations have already drifted | MERGE (this one is closer to correct) |
| J3 | webhooks.orders_paid `createProductionJobFromConfiguratorOrder` | order has configurator line properties; no Quote record involved | findFirst by pseudo-quoteId `shopify_order_<gid>` — webhook-retry safe in the normal case, still racy on concurrent delivery | jobTicket, assetInboxKey, itemTicket, ripJobName, suggestedFileName, materialSummary, per-line priceSnapshot, checklist, event | unitCost = 0 and costSnapshot = "pending_cost_book_mapping" (no ERP cost linkage); no recipeId; customer selling price only | KEEP behavior, route THROUGH central service unchanged-in-output |
| — | api.rip-imports.upload / print-intake APIs | attach/match to EXISTING jobs only | n/a | — | — | no job creation ✓ |
| — | app.erp.production.tsx `backfillTickets` | admin utility assigns missing jobTickets (evidence J1's gap is real) | per-job | jobTicket | — | retire after unification |

## A4. Duplicate-prevention & idempotency inventory

- Quote→job: quoteId findFirst (J1/J2) — works for sequential clicks, unsafe under concurrency; no DB unique constraint on ProductionJob.quoteId.
- Webhook: pseudo-quoteId findFirst (J3) — same shape; Shopify webhook retries are effectively deduped except concurrent deliveries.
- Payment webhook: note-marker idempotency (U4) — solid.
- Shopify order creation: depositCreated/balanceCreated/fullOrderCreated booleans — solid.
- No idempotency KEY column exists; the quoteId column doubles as one by convention (real quote id vs `shopify_order_*`).

## A5. Fields lost between quote and job (summary)

1. jobTicket/assetInboxKey/itemTicket/ripJobName/suggestedFileName on the J1 path (breaks intake/RIP linkage until backfillTickets is run).
2. DTP commercial detail (dtpPricing: owner tier, custom price, freight treatment, profit/status, override reason) survives ONLY inside costSnapshot JSON — no first-class job fields and no vendor-PO workflow fields (PO status/dates/received/QC do not exist anywhere).
3. Webhook jobs carry no internal cost (unitCost 0) and no recipe linkage — quoted-vs-actual comparison impossible for configurator orders.
4. Quote label-row/multi-label configuration reaches the job only inside snapshot JSON (acceptable for print packet; not surfaced).
5. No "createdBy"/timestamp surfaced in UI for conversion actions (events exist).

## A6. Gap vs the required rules (spec C)

- Conversion requires `paid`/`production` — NOT `approved` (deliberate: pay-before-production). The lifecycle plan keeps payment gating and adds the approved→production-ready distinction.
- Blocked/missing-cost quotes: NOT re-checked at conversion (a draft-with-warnings quote that later got paid converts silently — snapshot warnings are not re-validated). Gap.
- DTP override phrase/reason: enforced at SAVE (15C.2) but not re-verified at conversion. Gap.
- Quote does not store productionJobId (link is one-way job→quoteId; UI derives it). Gap (works, but fragile).
- Concurrency: no transaction/unique constraint. Gap.
