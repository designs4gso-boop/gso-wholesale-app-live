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

## 15H.1 IMPLEMENTED (2026-08-11) — DB-backed ticket identity
Ticket uniqueness is now DATABASE-AUTHORITATIVE, not merely procedural:
schema declares @@unique([shop, jobTicket]) on ProductionJob and
@@unique([shop, itemTicket]) on ProductionJobItem (nullable preserved;
Postgres treats NULLs as distinct). The migration is STAGED in
prisma/migrations-pending/20260811120000_add_ticket_uniqueness (Render runs
`prisma migrate deploy` on every push, so the folder is deliberately outside
prisma/migrations until the OWNER activates it — see that folder's README
for the exact steps + rollback). Pre-verified by the read-only
tools/audit-ticket-uniqueness.mjs: 11 jobs / 14 items, ZERO duplicate
tickets, ZERO malformed, zero null tickets.

Allocator: allocateJobTicket (exported; buildNextJobTicket delegates) keeps
the advisory-lock + count + probe design and now FAILS CLOSED on exhaustion
— the old non-canonical 6-digit epoch fallback (which no ticket parser
matched) is removed. Ticket-constraint P2002s rerun the ENTIRE creation
transaction (runWithTicketRetry, bounded x3) because Postgres aborts a
transaction on unique violation — each rerun re-locks, re-checks source
idempotency, and allocates a fresh candidate. The PrintIntake (shop, hash)
P2002 backstop is untouched and now explicitly excludes ticket violations.

Stray generators RETIRED: app.erp.production.tsx (backfillTickets now uses
the central allocator inside the standard retry; local copy deleted) and
tools/simulate-paid-configurator-order.mjs (cannot mint tickets at all —
creates unticketed test jobs, assigned later via Backfill Tickets; refuses
to run against any non-SQLite DATABASE_URL without
ALLOW_PRODUCTION_SIMULATION=YES_I_UNDERSTAND_THIS_WRITES_PRODUCTION).

Order-source idempotency: the `|| Date.now()` fallback is GONE in both the
source key and buildShopifyOrderJobPayload — a paid-order payload without
admin_graphql_api_id/id FAILS CLOSED (no unidempotent job can ever mint).

NEXT: 15H.2 — RIP Identity Repair (RasterLink item-ticket stage-2 matching,
matcher unification, loose-path quarantine, unmatched flagging).

## 15H.2 IMPLEMENTED (2026-08-11) — strict RIP identity matching
ONE shared matcher (app/lib/rip-identity-match.server.ts) now serves every
result-ingestion path: RasterLink, VersaWorks, the legacy CSV fallback,
print-log uploads, and the manual RIP Imports UI. Deterministic order:
exact ProductionJobItem.itemTicket -> exact ripJobName (raw, then
normalized equality over a bounded newest-300 index) -> exact
ProductionJob.jobTicket (explicit or derived from an unknown item ticket)
-> exact stored suggestedFileName. Every lookup is take:2/ambiguity-aware;
two-plus candidates NEVER auto-attach (status ambiguous + shared
matchFlag). Canonical tickets are lifted exactly from decorated names
(bare, .pdf, TICKET_Customer, TICKET__MACHINE__MODE__X__A1). THE MIMAKI
FIX: item-ticket routed names (GSO-YYYYMMDD-NNNN-01) previously searched
only ProductionJob.jobTicket and imported silently unmatched — they now
resolve the ITEM first and populate productionJobItemId on all paths.
Roland kept its normalized-name strength (applied everywhere now) and
gained item resolution. Loose matching is GONE from automatic linking:
print-logs' contains/substring/first-match tiers (which mislabeled
themselves as exact) are deleted; suggestions live only in the review
page's candidate ranking behind an explicit operator click.

Structured reasons ride the immutable rawRow (top-level matchReasons /
matchMeta.matchReasons / _gso.matchReasons): unknown_item_ticket:<T>,
unknown_job_ticket:<T>, ambiguous_*:<T>, no_ticket_identity,
noncanonical_ticket_identity:<token> — surfaced in RIP Import Review via
entryWarnings. ACTUALS POLICY: only exact_item_ticket / exact_rip_job_name
/ exact_job_ticket / exact_stored_filename / manual_owner_assignment (and
the legitimate legacy EXACT_* capture methods) may authorize actual-cost
writeback; writeback additionally RE-VERIFIES every attached row's
identity against the job itself (assessEntryIdentityTrust) instead of
believing stored labels, and blocks untrusted rows with a rematch
instruction. NO-LAUNDERING: single_item_fallback attributions are no
longer persisted by backfill (exact only), and a historically persisted
fallback id keeps reporting fallback (provenance block read back) — saving
a weak match can never upgrade it. Historical audit (read-only): 9
PrintLogEntry rows, 8 unmatched, 0 recoverable (7 no-ticket, 1 unknown
ticket), 0 ambiguous, 0 laundered — nothing to relink; the repair protects
FUTURE imports. Watcher fixes: the sync script accepts both
-config.json/.config.json filenames and both ClaimStaleMinutes spellings.
NEXT: 15H.3 — Intake Review + Retry.
