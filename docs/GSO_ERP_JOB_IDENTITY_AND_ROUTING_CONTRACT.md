# GSO ERP — Job Identity + Routing Contract (15F.0J, 2026-07-25)

## C. Ticket audit (current truth)
ONE authoritative generator exists: createProductionJobFromSource
(app/lib/production-job-source.server.ts, 15D.1) issues GSO-YYYYMMDD-NNNN
(date-based, per-day sequence) inside a Prisma transaction protected by a
PostgreSQL advisory lock — duplicates are not possible through it; ALL
production jobs (quote, Shopify order, manual admin) get tickets. Item
tickets append -NN. Quote-time RIP rows use GSOQ- names (separate, never
production tickets). The ticket IS embedded in routed RIP filenames
(ripFileBaseName: ripJobName > itemTicket > suggestedFileName) and survives:
quote -> job -> routed file -> RasterLink job name -> imported PrintLogEntry
(ticket regexes) -> actual-cost writeback -> (15F.0G.3) calibration rows.
No script invents its own IDs (legacy watcher did fuzzy extraction — retire).
GAP: a file with no production-job match gets NO ticket (review only).

## Permanent ticket behavior (design — reuse, never a second system)
- Matched file -> reuse the production job/item ticket (unchanged).
- Unmatched file -> create a controlled PrintIntake record and atomically
  assign the next ticket from the SAME generator (advisory-lock path),
  flagged origin=print_intake, connectable later to quote/order/customer.
- Standard job: A1. Retry (same content, failed copy): same ticket+attempt
  (ledger allows re-copy after failure only). Corrected artwork (same job,
  new hash): revision R2 -> attempt resets A1 (GSO-...__...__R2-A1).
  Intentional reprint: same ticket, P2 attempt series + reason. Replacement
  print: reprint with reason=replacement. Split across printers: item-level
  suffixes -01/-02 already exist — one per routed file/printer. Multi-file
  job: item tickets per file; job ticket never re-issued.

## F. Routed filename contract (system-generated ONLY)
<TICKET-OR-ITEMTICKET>__<PRINTER>__<MODE>__<Customer>__<Product>__<A#>.pdf
- PRINTER: MIMAKI | ROLAND. MODE: CMYK | WHITE-1X..4X | GLOSS-1X..4X |
  WHITE-GLOSS-mXnX. Customer/Product: Title-Case hyphen slugs from ERP data
  (safeNameToken family), each <=24 chars. Attempt: A1..; revision R2+ and
  reprint P2+ prefix the attempt. Charset [A-Za-z0-9._-]; total <=120 chars
  (RIP-safe; current agent cap); collisions get -<sha8> (existing rule).
  Ticket parse pattern: /GSO-\d{8}-\d{4}(-\d{2})?/ anchored at start.
- Back-compat: current names (bare ticket) keep matching; the new name only
  ADDS readable context. Employee originals are never renamed (archive copy
  keeps the original name exactly — existing behavior).

## G. Sidecar manifest (design)
<routedName>.gso.json written next to the routed copy + stored in ERP
(PrintIntake JSON). Fields exactly as the 15F.0J spec list; schemaVersion 1;
regenerated on every retry/revision (attempt-stamped); RIP hot folders
ignore non-artwork extensions (verify .json is inert in RasterLink/
VersaWorks before enabling — validation step in the patch). ERP remains the
source of truth; the sidecar is a convenience mirror.

## H. Routing rules
CURRENT (implemented, deterministic): ERP metadata first (white/gloss ->
Roland; explicit ERP machine; contradictions -> review), standalone ROLAND
filename token (word-boundary — "Rolando" safe), default CMYK -> Mimaki,
everything else review. Roland hot-folder automation EXISTS and is enabled.
Routed machine reaches the ERP outcomes echo (not a job column). TARGET
adds: safe print-mode tokens from employee names (GLOSS-3X etc.) parsed
ONLY with finish-context anchors (see EMPLOYEE_FILENAME_COMPATIBILITY);
bare "3x" NEVER routes. Precedence: ERP metadata > explicit printer token >
explicit mode token > compat convention > default CMYK Mimaki > quarantine.
Reroute: controlled action (actor+reason), new attempt, old routed copy
tombstoned in the intake record, actuals import keyed to ticket+attempt so
a wrong-printer import cannot double-count.

## I. Idempotency (current vs target)
Current: content-hash ledger (never route same bytes twice), claim files,
cutoff, collision-safe names, upload dedupe (duplicateFile), CSV row dedupe
(skippedDuplicates), writeback behind an owner phrase. Target identity adds
ticket+attempt+revision+hash as DB uniqueness on PrintIntake (same file
twice -> show existing result; new hash same job -> revision; reprint ->
new attempt) — ledger becomes a cache of DB truth instead of the truth.

## J. Review/quarantine (design)
Replace the 50-entry notes blob with PrintIntake records (status
needs_review) surfaced on app.erp.print-intake: original name, hash, size,
detected hints, proposed printer/mode/ticket, confidence, reasons (spec
list), candidate jobs; actions route-to/assign-job/create-print-only-
ticket/reject, each recording actor+reason+timestamp (resolveActorFromSession).
Workers never type tickets.

## AB. Security controls (recommend)
Imported actuals immutable (rawText/rawRow already kept; add: entries never
UPDATE — corrections append); manual matches + reroutes + duplicate
overrides audited with actor/reason; reprints attach to the original
ticket; calibration factor approvals owner-gated (15F.1 ownerConfig);
pricing versioned (already: engine/version strings in snapshots); quote
snapshots immutable (already enforced); upload tokens rotate + mask (known
15A finding).

## 15F.0J.5 IMPLEMENTED (2026-07-26)
The unmatched-file gap is closed: PrintIntake records + auto-created
print-intake ProductionJobs through the SAME advisory-locked generator
(design above now live; see GSO_ERP_PRINT_INTAKE_JOB_CREATION.md). Routed
names follow the contract (<TICKET>__<PRINTER>__<MODE>__<SAFE>__A1, <=120
chars, ticket-led so result watchers match automatically). The
"needs_review because no quote exists" behavior is retired — commercial
linkage is a warning on a routed job, never a routing blocker.
