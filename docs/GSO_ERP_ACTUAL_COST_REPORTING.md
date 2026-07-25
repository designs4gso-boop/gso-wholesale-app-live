# GSO ERP — Actual-Cost Reporting & Pricing Feedback (Patch 15E.2, 2026-07-24)

## Finalized-only policy
Profitability totals come EXCLUSIVELY from jobs with actualCostFinalized=true
(server columns + the immutable 15E.1 finalize-event snapshot). Open/
unfinalized jobs are counted and labeled EXCLUDED — never mixed into totals.
Finalized jobs without a 15E.1 snapshot event are "legacy final": columns
only, gateStatus LEGACY.

## Formulas
- Job row: revenue = snapshot.revenue (else item qty x unitPrice); estimated
  cost = item qty x unitCost; variance $ = final - estimated; variance % =
  null/"unavailable" when estimated <= 0 (never 0%); margin variance pts =
  final margin - estimated margin.
- Aggregate KPI = WEIGHTED margin (Σ profit / Σ revenue) — the simple average
  of percentages is shown separately and is never the KPI.
- Material waste cost share = materialCost x waste/(used+waste+reprint);
  labor variance = actual labor - estimated labor lines (art/print/application
  /weeding/packing snapshot lines); freight/vendor variance from the DTP
  snapshot vs entered actuals.

## Grouping rules
Product identity precedence: snapshot vendor selection (vendor:<id>) ->
recipe:<id> -> sku -> normalized clean name (DTP 4x5x2 / 5x4x2 can never
merge — different vendor selections). Customer grouping is PROVISIONAL:
normalized email -> company -> name -> "Unknown customer" until a Customer
model exists. Quantity bands: 1-99 … 7500+.

## Leakage thresholds (LEAKAGE_THRESHOLDS — centralized)
Below 40% target; below family floor (sticker-bags 45, jars 40 [premium
approximates the Chiron 40 minimum], stickers/banners 40, DTP 30/35/38 by
quantity); margin 5+ pts under estimate; cost 10%+ over estimate; DTP freight
20%+ over the $85 assumption; vendor invoice 5%+ over tier; waste > 12%;
reprint > 2% of revenue; warning finalizations; reopened jobs.

## Pricing feedback (never automatic)
Evidence = 3+ finalized jobs in the same family/product/quantity band (5+ =
high confidence, 3-4 = medium, <3 = no suggestion). Suggestion types:
cost-understated, vendor-cost, freight-allowance, price-below-target. Every
suggestion shows current standard, observed actuals, job count, date range,
variance, next step, and the exact supporting job tickets. Owner review queue
(Review -> accepted / dismissed / deferred + note) records decisions in
ErpAdminSetting (category "pricing-feedback") — destination data (Product
Setup / Vendor Cost Book / owner standards / DTP ladder) is NEVER changed
automatically.

## CSV exports
?export=jobs|families|products|vendors|feedback — server-generated from the
same finalized rows; no snapshots or override phrases are exported.

## Location
Lib: app/lib/actual-cost-reporting.server.ts. UI: Reports Dashboard
(finalized-profitability section with filters: date range [existing range
param], family, customer, actor, margin-below, warnings-only, reopened-only,
variance sign). Tests: tests/actual-cost-reporting.test.ts.

## 15E.3 addendum — event readability + historical names
Recent Production Events now render through the shared presenter (human
summaries, collapsed audit sections, raw payload preserved — see
GSO_ERP_EVENT_PRESENTATION.md). Product names across the dashboard/production
board/CSVs are display-cleaned via the commercial-name resolver; stored
values unchanged. A read-only dry-run name audit (?nameaudit=1) lists
malformed historical names with confidence grades; only HIGH-confidence rows
are eligible for the documented future owner-approved backfill.
