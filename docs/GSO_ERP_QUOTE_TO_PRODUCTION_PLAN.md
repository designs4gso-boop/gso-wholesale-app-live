# GSO ERP — Quote-to-Production Unification Plan (Phase 15D, 2026-07-24)

Plan only — no behavior changed. Companion: GSO_ERP_QUOTE_TO_PRODUCTION_AUDIT.md.

## B. Authoritative lifecycle (uses EXISTING status strings; two additions)

Quote.status: `draft` → `sent` (Reviewed/sent to customer) → `approved` →
[payment: `deposit_paid` → ] `paid` (= Production Ready) → `production` (job
created) → `completed` → `closed` (NEW, optional final archival state).
ProductionJob.status: `new` → in-production states (existing board vocabulary)
→ `completed` → delivered/closed. Payment remains the production gate
(pay-before-production is the shop's working rule); `approved` is the
commercial approval, `paid` is production-ready.

Ownership (single source per fact): customer contact = Quote (until a Customer
model exists); product/config/quantity/selling price/estimated cost/margin/
vendor selection/freight assumptions = QuoteItem.costSnapshot+priceSnapshot
(write-once) with quoteItem columns as the indexed copy; production recipe =
ProductRecipe via quoteItem.recipeId; artwork/proof = ProductionJob(+Files);
production status + actual cost = ProductionJob; historical snapshot = the
JSON snapshots, never mutated.

## C/F. Central service design (the 15D.1 patch core)

NEW `app/lib/production-job-source.server.ts`:

```
createProductionJobFromSource(db, {
  shop,
  source: { type: "erp_quote", quoteId } | { type: "shopify_order", order } | { type: "manual_admin", payload, authorizedBy },
})
```

One internal builder + three thin validators:
- validate: erp_quote → re-fetch quote+items; require status paid|production;
  re-validate snapshot finalizability (missing-cost lines, DTP status BLOCKED,
  DTP override present when overrideRequired — re-read from costSnapshot);
  shopify_order → configurator-line detection exactly as today; manual_admin →
  explicit authorization string.
- idempotency: sourceKey = quoteId (erp) / `shopify_order_<gid>` (order) /
  caller-supplied key (manual). Wrap findFirst+create in a
  `db.$transaction` and re-check inside; return { job, created:false } when
  existing. (Optional hardening later: unique index on (shop, quoteId) — the
  smallest possible migration, NOT required for 15D.1 because the transaction
  closes the practical race.)
- normalized payload: ALWAYS assigns jobTicket + assetInboxKey + per-item
  itemTicket/ripJobName/suggestedFileName (fixes the J1 gap), copies customer
  block, items with quoteItemId/recipe/finish/addOns/cost+price snapshots,
  checklist by FAMILY (see D), creation event with source type + actor, and
  writes the quote-side back-link (quote.status → `production`, note with
  jobTicket; productionJobId column is optional later — the note + job.quoteId
  keep two-way traceability today).
- Shopify path output must remain byte-compatible with today's webhook job
  (same tickets/summaries) — verified by tests before switching the webhook to
  the service.

Wrappers: quotes.tsx + production.tsx call the service (both local functions
deleted); webhooks.orders_paid calls the service for the configurator branch;
payment-classification branch unchanged.

## D. Family handoff → checklist templates (data-driven by engine family)

- sticker-bags / stickers-labels / banners: existing in-house checklist
  (prepress→print→cut/finish→QC→pack).
- standard-jars / premium-jars: jar checklist (labels printed → tops/caps
  verified (Miron top type from snapshot) → application → QC → pack).
- custom-item: manual checklist (existing default) until structured.
- dtp-bags: OUTSOURCED PURCHASE checklist (no print/machine/application):
  artwork collected → PO sent to Spektra → proof received/approved → ordered →
  received → QC → deliver. Vendor detail comes from the snapshot dtp/dtpPricing
  blocks (vendor sku, tier, unit cost, subtotal, $85 freight, designs, hang
  hole, features, selling price, profit, override reason).

## E. Shopify paid-order protection

Current path stays live and untouched during 15D.1 development; the webhook
switches to the central service ONLY behind output-equivalence tests
(identical job shape for a recorded real order payload). Recommendation
between the two options in the spec: **(2) create the production job directly
through the shared service** — configurator orders already carry their
commercial snapshot on the order lines; synthesizing a Quote record would
create a second commercial system for no owner benefit now. A quote-like
snapshot remains a later option once a Customer/orders model lands.

## G. DTP purchase-job design (no migration required for 15D.1)

Everything commercial already exists in QuoteItem.costSnapshot.dtp +
.dtpPricing (vendor sku/tier/unit cost/subtotal/freight/designs/hang hole/
features/selling price/profit/margin/status/override). The job carries it via
costSnapshot copy. Workflow state (PO status, ordered/expected/received dates,
QC, delivery) maps onto: checklist items (statuses) + ProductionJobEvent rows
(dated transitions) + internalNotes. This is sufficient for 15D.1. IF the
owner later wants queryable PO fields (reports filtered by expected date etc.),
the smallest migration is a nullable `ProductionJob.vendorPoSnapshot Json` OR
a small ProductionPurchaseOrder table — deferred; JSON/checklist/events cover
the workflow until then, and that is why no schema change is needed now.

## H. Test plan (15D.1)

Service-level (new tests/production-job-source.test.ts, mock-db pattern):
repeated conversion returns existing job (created:false); concurrent calls →
one job (transaction); webhook same-order twice → one job; blocked/draft/
unpaid quote conversion rejected with exact messages; DTP overrideRequired
without recorded reason rejected; quote link written; historical snapshots
byte-identical after conversion; jobTicket/assetInboxKey always assigned;
Shopify output-equivalence fixture. Route pins: both pages call the service;
webhook calls the service; no local create functions remain.

## I. Smallest UI changes (15D.1, no redesign)

Quotes page: status badge already exists; add "Create Production Job" button
enable/disable with the exact blocked reason (unpaid / blocked snapshot / DTP
override missing) + "Open Production Job" link when job exists + created
timestamp from the event. Production page: show source type + source link
(quote id or Shopify order name) + family checklist template label. Nothing
else moves.

## Phase 15D.1 exit criteria

One shared creation service used by all three paths; J1 ticket gap closed;
conversion re-validation live; duplicate-click/concurrency safe; Shopify
webhook output proven unchanged; 509+ tests green; tsc 308; build clean.

## 15D.1 SHIPPED (2026-07-24)
createProductionJobFromSource is live in app/lib/production-job-source.
server.ts. Contract: (dbClient, { shop, source, actor }) with sources
erp_quote / shopify_order / manual_admin; returns { job, created, reason }.
Idempotency: ONE Prisma transaction that first takes
pg_advisory_xact_lock(keyA, keyB) — two deterministic signed-32-bit FNV-1a
hashes of `shop|sourceType|sourceId` — via the smallest raw SQL call
($queryRawUnsafe, numeric params only), THEN checks for the existing job,
THEN creates. Lock releases at commit; concurrent duplicates impossible on
Postgres (SQLite dev ignores the lock — single-instance). Both pages and the
webhook configurator branch now call the service; the two local page creators
and the webhook creator are deleted (net -571 lines). Webhook parity proven
by a recorded fixture pinning every important field (pseudo-quoteId, tickets,
file names, summaries, snapshots, add-ons). Conversion re-validation:
paid/production status + snapshot missing-cost refusal + DTP BLOCKED refusal
+ DTP override written-reason requirement. Quote gains a
"[GSO] Production job <ticket> created" note and moves paid->production.
Family checklists shipped incl. the DTP outsourced Spektra purchase workflow
(12 steps, no in-house print/machine/application). Future optional hardening:
unique index on (shop, quoteId).
