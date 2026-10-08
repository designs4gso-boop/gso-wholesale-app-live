# Owner decisions before release — 2026-10-07 (updated after the owner review)

## Answered and applied locally on 2026-10-07 (no longer open)

| # | Decision | Owner answer | Where it lives |
|---|---|---|---|
| 1 | Remaining DTP ladders (3.5x4.5x2 / 5x5x2 / 6x5x2 / 8x5x2) | APPROVED at the 1,000 acquisition prices ($1.30 / $1.35 / $1.40 / $1.50) and the proposed 2,500+ values | `app/lib/dtp-owner-pricing.server.ts` (`OWNER_APPROVED_DTP_LADDERS_2026_10_07`) |
| 2 | 25,000 tier | APPROVED: 3.5x4.5x2 $0.29 · 4x5x2 $0.30 · 5x5x2 $0.35 · 6x5x2 $0.40 · 8x5x2 $0.52; above 25,000 = REQUEST CURRENT VENDOR QUOTE | same module; `DTP_MAX_APPROVED_QUANTITY` |
| 3 | 1,000-tier acquisition exception for the other sizes | YES — $350 GP target on the 1,000 tier of every current size; 2,500+ normal | `DTP_ACQUISITION_TIER_EXCEPTIONS` |
| 4 | Freight | KEEP $85 per Spektra PO as the provisional landed-cost assumption, status UNVERIFIED OWNER ASSUMPTION, never vendor-confirmed; product cost and freight stay separate | `dtp-catalog.ts` `SPEKTRA_FREIGHT_ASSUMPTION` |
| 5 | Legacy 5x4x2 | Stays LEGACY / NO CURRENT STANDARD CATALOG MATCH; new quotes MANUAL / VENDOR REVIEW; history intact; no mapping | `dtp-quote-cost-authority.server.ts`, `canonical-dtp-pricing.server.ts` |
| 6 | Die ID registry | Launch with Die ID / Shape ID in the quote snapshot; durable registry POST-LAUNCH; no migration | unchanged |
| 7 | Production QC guard | ENFORCE: no transition to COMPLETED without a valid QC PASS ("QC PASS REQUIRED BEFORE COMPLETION"); earlier stages untouched; completed history untouched; no schema | `app/lib/production-qc-guard.ts`, Production Board + Calendar |
| 8 | Owner-only gating | Keep the typed-phrase gates; e-mail allow-list POST-LAUNCH | unchanged |
| 9 | Mimaki white | Mimaki UCJV300 is CMYK-only for ERP routing; white and gloss on the Roland only; no Mimaki white channel exposed | `app.erp.machines.tsx` preset (white slots disabled); routing authority unchanged |
| 10 | Jar MOQ | KEEP 128 (50 belongs to other product rules) | unchanged |
| 11 | Machine rate | NOT changed in this pass (see the report for the exact current values) | unchanged |
| 12 | Shaped pouch policy | unchanged (MOQ 2,500; ×1.10; $700 per new die separately; $0 reuse; one fee per physical shape) | unchanged |
| 13 | Design & Customize | remains PRIMARY / CONTROLLING; secondary competitors never change owner ladders automatically | `dtp-market-benchmark.ts` |

## Still genuinely open (do not block the release)

1. **Machine hourly rate** — the owner standard used by every pricing and actual-cost path is `OWNER_STANDARDS.machineRecoveryPerHour` = **$8/hr** (`app/lib/rip-actual-costs-shared.ts` → `machineRatePerHour()`, env override `GSO_MACHINE_RATE_PER_HOUR`); the Machines page preset also seeds `costPerHour: 8`. The Cost Health page still reports a legacy "$5/hr" machine record where one exists in the database. Decide separately whether the stored machine record should be aligned to $8 (SMALL, data only).
2. **Freight basis** — when the vendor confirms a freight basis, replace the $85 constant or switch to a quoted line (SMALL).
3. **Post-launch schema items** — durable die registry; owner e-mail allow-list; unique index on the production-job source key plus a webhook-receipt table.

No other owner decision is required for the Thursday deployment.
