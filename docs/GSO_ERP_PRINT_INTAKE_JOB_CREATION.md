# GSO ERP — Print Intake Job Creation (15F.0J.5, 2026-07-26)

## Final employee workflow (nothing manual beyond the drop)
Drop a NORMAL file into Prints For Today (root)
-> agent hashes it (full SHA-256) and asks the route-plan API
-> EXACT existing production match reuses that job + ticket (13A.6G ladder
   unchanged: item ticket > job ticket > stored filename > job file >
   subfolder identity)
-> otherwise the server AUTO-CREATES a controlled print-intake ProductionJob
   through the SAME advisory-locked ticket generator (GSO-YYYYMMDD-NNNN;
   never a second sequence) + one PrintIntake identity record
-> printer/mode from SAFE filename hints (premium gloss/white -> Roland;
   explicit ROLAND/MIMAKI word tokens; default CMYK -> Mimaki; a bare "3x"
   or "White Widow" never mis-routes; conflicts BLOCK)
-> routed copy named <TICKET>__<PRINTER>__<MODE>__<SAFE-ORIGINAL>__A1
-> original preserved and archived ONLY after the routed copy verifies
-> RIP actuals match back by the exact leading ticket
-> quote/order/customer linked LATER from the Production Board.

## Review split (H)
ROUTING BLOCKERS (file stays for review/retry): conflicting printer tokens,
premium-mode + Mimaki-token contradiction, unsupported mode, ticket/DB
creation failure, unreachable destination. COMMERCIAL/LINKAGE REVIEW
(warnings on a ROUTED job — never blocks): unknown customer/quote/order/
quantity/price, ambiguous existing candidates (job still auto-creates; the
ambiguity note rides the intake record for later resolution).

## Identity + idempotency (B/G/K)
PrintIntake is unique on (shop, full SHA-256): same file dropped twice
reuses the record/job/ticket (agent ledger already prevents the re-drop
reaching the API; the server is idempotent anyway — advisory lock keyed on
the hash, in-transaction recheck, P2002 backstop). Different hash = new
record (revision relationships resolved in review). Reprints act on the
existing ticket with attempt/reprint counters. Failed route retries reuse
the same intake/job/ticket.

## What the auto-created job is (C)
source=print_intake, status new, customerName "Unlinked (print intake)",
item quantity 0 / $0 prices (NOTHING fabricated — no revenue, payment,
approval), productTitle "PRINT INTAKE — <original name>", internal notes +
created_from_print_intake event carry the full story. Visible on the
Production Board immediately; linkable to quote/order/customer later.

## Schema decision (M)
One focused migration: prisma/migrations/20260726120000_add_print_intake
(PrintIntake table + unique(shop,fileHashSha256) + indexes). NOT applied
from this session (local env points at production Postgres) — it applies at
deploy via `npm run setup` (prisma migrate deploy). Rollback: DROP TABLE
"PrintIntake". No historical rewrites; no mass backfill (optional
owner-triggered backfill limited to unresolved current inbox files).

## 15F.0J.5A hotfix (2026-07-26) — transaction fixed after live deploy
Two live failures corrected: (1) the advisory lock now selects
pg_advisory_xact_lock(...)::text (Prisma cannot deserialize VOID) — the
lock is still acquired transaction-scoped with the same two-int keys, and
the old blanket catch is NARROWED so only a SQLite dev database may skip
locking; any real lock failure throws advisory_lock_failed loudly. (2)
ProductionJob.create no longer sends the nonexistent `source` field —
PrintIntake remains the authoritative source record (generatedProductionJobId
+ created_from_print_intake event + notes/customer markers carry
provenance; the board infers Print Intake from those). Transaction order
verified lock -> recheck -> ticket -> job(+item) -> intake -> event; any
failure rolls back everything (no ticket consumed, file left for retry) and
the route-plan now returns actionable, credential-safe error codes:
advisory_lock_failed / schema_mismatch / print_intake_create_failed /
unique_conflict_recovered / production_job_create_failed.
