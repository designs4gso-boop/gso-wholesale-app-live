# GSO ERP — Printer Calibration Plan (15F.0J, 2026-07-25)

## W. Methodology (locked)
Comparable groups: printer model x RIP profile x material family x
resolution/pass x quality x mode x white layers x gloss layers x overprint
x cut type x layout-width band (+ coverage band when known). Per group:
n, weighted + median actual/estimated factor, weighted + median
throughput, weighted + median ml/sqft, variance, IQR, outliers, affected
fixtures. n>=3 before ANY recommendation; confidence 3-4 low / 5-9 medium
/ 10+ high; NEVER auto-apply; owner approval before runtime factors, ink
factors, or commercial prices change; historical quotes immutable.

## Phased roadmap
0. DATA (owner/ops, no code): deliver the Roland all-time CSV to a
   repo-visible path; locate/confirm the JobInfo->CSV converter + the
   rasterlink-sync host; pull a read-only _routed-archive filename listing
   for the compatibility corpus; answer the OWNER QUESTIONS list.
1. 15F.0J.1 — MULTI-LINE SAFETY (smallest first patch, quoting-money bug;
   no schema): see GSO_ERP_MULTILINE_STICKER_AUDIT.md target behavior.
2. 15F.0J.2 — CAPTURE WIDENING (no schema): converter/CSV carries output
   W x L, copies, pass/resolution, cut + RIP-est time, both white channels;
   parser maps them into rawRow-backed fields; Roland: define the recurring
   VersaWorks export drop into rip-logs (manual weekly until a watcher).
3. 15F.0J.3 — ROLAND FORENSICS: run the locked methodology on the CSV;
   publish measured tables; owner reviews rate models.
4. 15F.0J.4 — PRINT INTAKE RECORDS (first migration candidate of this
   arc): PrintIntake table (identity/hash/ticket/attempt/revision/review
   queue), routed-name contract + sidecar, print-only tickets via the
   existing generator. Defer until 1-3 prove the data flow.
5. 15F.0J.5 — OPERATOR LABOR + area-model correction (owner rates first).
6. 15F.0J.6 — OWNER 4x5 BAG LADDER + margin-floor ratification +
   min-profit-per-machine-hour candidate; competitor manual capture feeds
   the same review.
7. Then resume 15F.1 (editable settings) so every calibrated value lands
   owner-editable.

## Smallest safe first patch: 15F.0J.1 multi-line safety
Route-only + policy-module change, no schema, no printer/pipeline touch;
fixes silent money loss employees can hit TODAY. Exact prompt:

> PATCH 15F.0J.1 — MULTI-LINE STICKER SAFETY. Read AGENTS.md,
> docs/GSO_ERP_MULTILINE_STICKER_AUDIT.md. In app.erp.cost-calculator.tsx
> (loader AND action) + commercial-pricing-policy.server.ts: (1) a psl*
> row with ANY populated field is ACTIVE; active rows failing validation
> (quantity>=1, designs>=1, width/height>0, material selected) surface
> per-line field errors in the multi-line block and force BLOCKED (never
> silently dropped — remove the quantity>0 silent filter in
> combineStickerLines in favor of explicit blockers); (2) lineCount >= 1
> activates multi-line and the UI states that line entries replace the
> single-line form (or renders the main line as Line 1 — pick one,
> document); (3) totals panel shows active lines, total pieces, total
> designs, total printed sqft, total adjusted sqft, per-line subtotals;
> (4) tests: "01" activates one extra line and prices it; blank-quantity
> line blocks with the exact field error; totals include every active
> line; save/psearch replay parity; existing 621-test suite stays green.
> Run the full battery (tests, tsc vs 306, build, git diff --check) and
> report with the standard completion format including the commit command
> not run.
