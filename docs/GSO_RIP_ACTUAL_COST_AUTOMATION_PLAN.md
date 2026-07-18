# GSO RIP Actual Cost Automation — Audit + Plan (Patch 13A.4)

Audited 2026-07-17 against the live repo. Read-only audit; no behavior changed.
Naming note: the app's job-ticket prefix is **GSOQ** (quote-RIP results) / **GSO-** (production tickets), not "GSQ".

## 1. What already exists (audit findings)

### Routes / endpoints
| Route | Purpose | Writes |
|---|---|---|
| `api/quote-rip-results/sync` | Quote-time GSOQ RIP results pushed by the NAS sync script (token-authenticated). Stores per-channel cc + externally computed `estimatedInkCost` in `PrintLogEntry.rawRow` JSON | yes (PrintLogEntry) |
| `api/rip-imports/upload` | Production RIP log CSV upload (VersaWorks-style columns: "Nick Name" = machine, "Media Name", "Job Name", per-channel ink). **Already extracts the GSO ticket from the RIP job name, looks up `ProductionJob.jobTicket`, and stamps `productionJobId`**; tracks matched/unmatched counts on `PrintLogImport` | yes |
| `api/print-logs/upload` | Simpler print-log upload (no job matching in this path) | yes |
| `/app/erp/rip-imports`, `/app/erp/print-logs`, `/app/erp/print-intake`, `/app/erp/print-log-settings` | Staff pages for imports, log review, intake watcher settings (NAS folders, ticket pattern), tokens | settings/log rows |
| Cost Calculator "Actual GSOQ" mode | Prices quote estimates from synced GSOQ rows (per-piece or full-job ink) | read-only |

### Tools
- `tools/gso-print-intake-watcher.ps1` — watches the print-intake NAS folder, extracts the GSO ticket, renames files to `TICKET_Customer_Product_SIDE_Material_ROUTE_R1.ext`, and **routes them to RIP hot folders via a config-driven route map** (`routes[].match` → `hotFolder`, plus `defaultRoute`/`defaultHotFolder`). The ROUTE token ends up inside the RIP job name → machine attribution survives into the logs.
- `gso-sync-quote-rip-results-to-app.ps1` — referenced by the app but **not in the repo** (lives on the NAS). It computes `estimatedInkCost` with its own ink $/ml constant. Must be retrieved (see §5).

### Database models (all already in schema — no migration needed for phases 13A.5–13A.7)
- **`PrintLogEntry`**: `jobTicket`, `sourceJobName`, `printerSoftware`, `machineName`, `mediaName`, `sqft`, `inkMl` + `cmykInkMl`/`whiteInkMl`/`glossInkMl`, `printMinutes`, `startedAt`/`completedAt`, `rawRow` JSON, and **nullable `productionJobId`/`productionJobItemId` link columns**.
- **`PrintLogImport`**: source (versaworks/rasterlink/manual), rowCount, **matchedCount/unmatchedCount**, totals.
- **`ProductionJob`**: `jobTicket`, `quoteId`, plus a full **manual actuals block**: `actualLaborMinutes/Rate/Cost`, packing/shipping/outsource/other/reprint costs, `actualTotalCost/FinalProfit/FinalMargin`, finalized flags.
- **`ProductionJobItem`**: `itemTicket`, **`ripJobName`**, `quoteItemId`, `recipeId`, unitPrice/unitCost, **`costSnapshot`/`priceSnapshot`** (the estimate at quote time), `materialSummary`/`machineSummary`.
- **`ProductionMaterialUsage`**: estimated/pulled/used/waste/reprint qty, costPerUnit, totalCost, **`source: "print_log"` already an allowed value**.
- **`MachineInkChannel`**: verified $/ml (13.2.4: Mimaki $0.1760, Roland $0.19867); `Machine.costPerHour` (still $5-vs-$8 open).
- **`Material`**: verified roll $/sqft (13.2.4).
- Labor: owner standards live in the calculator (13A.3); no per-task labor actuals table yet (ProductionJob has aggregate `actualLaborMinutes`).

### What one GSOQ/production RIP row stores today
Quote path (GSOQ): per-channel cc (C/M/Y/K/white/clear), total cc, RIP seconds, file name, date, confidence, NAS-computed ink $. Production path: machine name, media name, job name/ticket, sqft, per-channel ml, print minutes, start/complete times, raw row. **In-app ink dollar cost is computed nowhere for production entries — but it is now computable exactly** (verified $/ml × per-channel ml).

## 2. Matching answer (audit Q4)

Yes — matching already works and has three usable keys, strongest first:
1. **`jobTicket`** (`GSO-…`): PrintLogEntry ↔ ProductionJob.jobTicket — already automated in `api/rip-imports/upload`.
2. **`ripJobName`/`sourceJobName`**: ProductionJobItem.ripJobName ↔ PrintLogEntry.sourceJobName — columns exist, matching not yet implemented (13A.6).
3. **GSOQ ticket ↔ quote**: quote-time results carry the GSOQ id the calculator already consumes; production tickets carry the ROUTE token (machine) from the watcher naming.
ProductionJob.quoteId then bridges to the Quote; ProductionJobItem.costSnapshot/priceSnapshot are the stored estimate for variance.

## 3. What is missing for full automation (audit Q5)

- **No schema needed** for: actual ink $ (compute from channels), media $ (mediaName → Material name-map), machine time $ (printMinutes × rate), per-job actual rollups (write into existing ProductionMaterialUsage + ProductionJob actual fields via a gated action), variance vs costSnapshot.
- **Small schema later (13A.8+)**: `mediaName → Material` mapping table (interim: name-matching + a review list), a `CalibrationSnapshot`/recommendation table (observed ml-per-sqft per channel, proposed profile values, owner approval stamp), per-task labor actuals if wanted, and the deferred verified-stamp columns.
- **Configuration, not code**: the NAS sync script recovered into the repo; VersaWorks/RasterLink CSV/log export enabled on both shop computers; cutter logs (none exist today — cut time stays estimated at 12.5 cm/s until a source exists).

## 4. Recommended architecture + phased plan (audit Q6, Q8)

**Principles**: initial quotes stay conservative (heavy-coverage estimates); actuals flow in automatically after print via the existing upload endpoints; the app **recommends** calibrations but never changes pricing assumptions without the owner typing the approval phrase (the 13.2.2 gate pattern).

- **13A.5 — Read-only Actual Cost Dashboard** — ✅ SHIPPED (patch 13A.5): `/app/erp/actual-costs` computes actual ink $ from verified channel $/ml with the attribution chain (machine name → software → route token), shows both $5/$8 machine costs, per-ticket rollups with multi-machine/media warnings, display-only media name-matching, the Mimaki white/gloss ROUTING warning, and the GSOQ quote-time section. Zero writes, no schema.
- **13A.6A — RasterLink parser + safe upload integration** — ✅ SHIPPED: `api/rip-imports/upload` now detects RasterLink KEY_* CSVs (header sniff; VersaWorks path byte-identical) and imports them via the pure parser `app/lib/rasterlink-parse.server.ts`. Validated conversion pinned by tests (codes 1-4 = CMYK, raw/1000 = cc/item, 0.168 x 40 = 6.72 flagged `rasterlink_rounded_per_item_estimate` — never presented as measured ink). Print and cut rows stay distinct (`status` = `print:<result>` / `cut:<result>`; cut/vec times + RIP times live in rawRow; RIP duration never counts as print). Blank KEY_INKUSE imports with `missing_inkuse` basis, never zero-faked. Dedupe: file-level sha256 marker in `PrintLogImport.notes` (processed imports only, so crashed partials can retry) + row-level natural-key findFirst on plain columns. Matching: exactly-one jobTicket hit attaches; zero stays unmatched; two+ stays unmatched with `ambiguous_ticket_needs_review` in rawRow. Watcher-renamed filenames extract the ticket from the first underscore segment. JobInfo.ini converter exists as a tested pure function, NOT wired (later patch).
- **13A.6B — Automatic Windows/NAS watcher + import audit reliability** — ✅ SHIPPED: `tools/gso-rasterlink-sync.ps1` (Windows PowerShell 5.1 compatible, UTF-8 BOM, ASCII-only) polls the NAS `rasterlink\incoming` folder and POSTs CSVs to `/api/rip-imports/upload` with the existing token — modes: poll loop (default), `-Once`, `-DryRun`, `-Health` (folder/endpoint/token probes, token always masked), `-SelfTest` (13 offline assertions). Reliability: atomic `.gsoclaim` files (CreateNew + stale reclaim) so two watchers never double-process; file-stability wait before upload; stepped-backoff retries (5xx/network); 401/403 = fatal config exit leaving files in incoming; other 4xx = terminal → error folder + `.error.json` sidecar (status/response/retryCount/scriptVersion); success + server-duplicate → processed folder with content-hash collision-safe renaming; daily UTC logs that never contain the token. Config from `gso-rasterlink-sync-config.example.json` (folders, PollSeconds 30, StableFileSeconds 20, MaxRetries 4, ClaimStaleMinutes 30). Server side: import notes now record `parseWarnings:<n> outcome:processed` and the upload response returns `fileHash`, `parseWarnings`, `outcome` so the watcher log is a complete audit trail. Setup card added to `/app/erp/print-log-settings` (config, health, single-pass test, `schtasks` install).
- **13A.6C — RIP Import Review + safe rematching UI** — ✅ SHIPPED: `/app/erp/rip-import-review` lists unmatched, ambiguous, and attached PrintLogEntry rows (RasterLink AND VersaWorks) with filters (status/source/window/search/warnings-only), parser warnings, timing details, import-level summaries (structured counters + short hash only — raw notes/token never sent to the client), and candidate suggestions ranked exact-ticket > ripJobName similarity > name similarity (suggestion-only, never auto-saved; 2+ exact hits all listed = the ambiguous case). Mutations update ONLY `PrintLogEntry.productionJobId` + `rawRow` (reserved `rematchAudit` key appended without touching any parser value; non-JSON rawRow preserved verbatim in a wrapper; history capped 20) plus a `ProductionJobEvent` audit row — with explicit confirm checkbox enforced server-side, expected-value stale-write rejection, shop-scoped lookups (cross-shop IDs never resolve), and bulk attach only when all checked rows are unresolved and share one exact ticket or source name (single transaction, whole-batch reject otherwise). No schema change. Pure logic in `app/lib/rip-import-review.server.ts` (24 tests).
- **13A.6D — VersaWorks matching hardening** (next): replace the upload/import-time silent first-`contains` VersaWorks match with the conservative decideMatch pattern + ambiguity flags; JobInfo.ini blank-INKUSE fallback wiring; `productionJobItemId` backfill.
- **13A.7 — Estimated-vs-actual variance report** (gated writes into existing fields): "Pull actuals from print logs" per job → writes `ProductionMaterialUsage` rows (`source: "print_log"`) + the ProductionJob actual-cost fields; report shows estimate (costSnapshot) vs actual $, margin vs margin, $ and % variance; quote linkage via quoteId.
- **13A.8 — Calibration recommendations (owner-approved)**: observed ml/sqft per channel and $/sqft by finish vs the seeded 0.0075 and the $0.50–2.50 profiles; recommendation cards with APPLY-phrase gate; small schema for snapshots/approvals.
- **13A.9 — Roland/Mimaki routing warnings**: rule — **ROLAND tag → Roland LG; no tag → Mimaki; Mimaki is CMYK-only for routing/pricing; white/gloss without the ROLAND tag → warn (later block)**. Wire into: calculator (warn when a white/gloss profile is chosen without a Roland route), production ticket creation, and the watcher config (`routes[].match: ["ROLAND"]` → Roland hot folder; default → Mimaki) — the watcher already supports exactly this config shape. `finish-presets.ts` already encodes preferredMachine per finish and can drive the warning.

**Automation availability split** (audit Q8): *Now*: ink $/media-sqft/machine-minutes per matched row, per-ticket rollups, GSOQ quote-time actual ink. *After small schema*: media mapping table, calibration snapshots, per-task labor actuals. *After RIP export/log sync configured*: continuous Roland+Mimaki coverage (today only what's been uploaded/synced — 1 GSOQ row, dated ~6/4/2026). *Not automatable*: hand-labor task timing (owner standards remain the source), cutter time (no logs exist), packing/shipping (manual entry stays).

## 5. Exactly what we need from the shop computers (audit Q7)

**Roland (VersaWorks / LG-540)**: the job-log/accounting CSV export (enable if off) — need one sample covering a real job: job name, media, W×H or sqft, per-channel ink ml, print time, status, timestamps; the current hot-folder path; a screenshot of VersaWorks' job properties/ink report for one job.
**Mimaki (RasterLink / UCJV300-130)**: RasterLink's job log/print result files (location + one sample); confirm whether per-channel ink ml is exported or only totals; hot-folder path; one screenshot of the job result panel.
**NAS**: copy of `gso-sync-quote-rip-results-to-app.ps1` (record its ink $/ml constant, then commit the script to `tools/`); the current `gso-print-intake-config.json` (routes/hot folders); confirmation of the folder layout the settings row expects (`rip-logs/versaworks/incoming`, `rasterlink/incoming`, `processed`, `error`).
**Cutter**: whether the Roland cutter produces any log/history at all (if not, cut time stays an estimate).
**Process**: confirm every printed file goes through the intake watcher (so tickets/routes are always embedded in RIP job names).

## 6. Do-not-touch until later (standing)
Calculator math (beyond 13A.3), pricing engine, quotes/production behavior, schema (until the 13A.8 batch, merged with the other deferred columns), Shopify.
