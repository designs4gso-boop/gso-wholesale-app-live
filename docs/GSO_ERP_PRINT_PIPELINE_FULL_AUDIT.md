# GSO ERP — Print Pipeline Full Audit (15F.0J, 2026-07-25)

Audit-only. Verified on the RasterLink PC (this machine hosts C:\MijCtrl and
the VersaWorks7 LG-640 input folder; the NAS is not reachable from this
session — NAS-side facts come from configs/scripts).

## Inventory (component | where | status)
| Component | Location | Runs on | Trigger | Status |
|---|---|---|---|---|
| Prints For Today monitoring + routing agent | tools/gso-print-intake-agent.ps1 (v1.2, 13A.6G) + gso-print-intake-agent-config.json | RasterLink PC — Windows Scheduled Task "GSO Print Intake Agent" (verified: Ready) | poll 30s, stable-file 20s | ACTIVE (production) |
| Route-plan brain | app/lib/print-intake-routing.server.ts + /api/print-intake/route-plan + /api/print-intake/report | Render server | agent JSON calls | ACTIVE |
| RasterLink result sync | tools/gso-rasterlink-sync.ps1 (v1.1, 13A.6B.1) + config -> /api/rip-imports/upload | NAS-adjacent machine (no task on THIS PC — location unconfirmed) | poll 30s on rip-logs/rasterlink/incoming | ACTIVE (per config; runtime host = OWNER QUESTION) |
| JobInfo.ini -> incoming CSV converter | NOT IN REPO — unlocated | unknown | unknown | EXTERNAL/UNKNOWN — the sync consumes CSVs; who writes them (RasterLink export? manual? another script?) is an OPEN OWNER QUESTION |
| Roland VersaWorks result capture | NONE (no exporter/watcher found) | — | — | MISSING — Roland actuals arrive only as the manual "all-time CSV" export |
| Legacy intake watcher | tools/gso-print-intake-watcher.ps1 + gso-print-intake-config.json | — | — | LEGACY (fuzzy ticket regex, config route table) — superseded by the agent; retire |
| CSV parse + entry creation | app/lib/print-logs.server.ts (alias-driven columns) + api.rip-imports.upload / api.print-logs.upload | Render | upload | ACTIVE |
| Import review / matching | app/lib/rip-import-review.server.ts + app.erp.rip-import-review | Render | UI | ACTIVE |
| Actual-cost math + writeback | rip-actual-costs.server.ts, print-log-writeback.server.ts (gate phrase "APPLY PRINT LOG ACTUALS"), rip-duration.server.ts, print-log-matching.server.ts | Render | UI action | ACTIVE |
| Models | PrintLogImport (rawText retained), PrintLogEntry (jobTicket, sourceJobName, machine/media, sqft, cmyk/white/gloss ml, printMinutes, started/completedAt, rawRow retained), PrintLogAutoImportSetting (tokens + rolling intake outcomes in notes) | Postgres | — | ACTIVE |
| Quote-time RIP rows | GSOQ- entries + api.quote-rip-results.sync | Render | sync | ACTIVE |
| NAS folders | Prints For Today, _routed-archive, print-intake/error+agent-logs, rip-logs/{incoming,processed,error,sync-logs}, processed/gso-rip-results-summary.csv | Synology | — | ACTIVE (per configs) |
| Local RIP folders | C:\MijCtrl\Hot\GSO_MIMAKI_CMYK_STANDARD (verified exists), C:\MijCtrl\Jobs (exists; no JobInfo samples present now), C:\ProgramData\Roland DG VersaWorks7\Printers\LG-640\Input-A | RasterLink PC | — | ACTIVE |

## Behaviors verified in code
- Stabilization: age>=20s + size/mtime recheck (both watchers). Claims:
  exclusive .gsoclaim files with 30-min stale reclaim. Restart-safe dedupe:
  SHA-256 content ledger (JSONL) — same content never re-routed/re-reported.
- Failure paths: plan/API unreachable -> retry next pass; 401/403 -> fatal
  stop (file untouched); copy length verified; sync 4xx -> error folder +
  .error.json sidecar; 5xx/timeout -> bounded backoff retries.
- Logging: daily logs on NAS; token never logged; outcomes echoed into the
  ERP (rolling 50 in PrintLogAutoImportSetting.notes, marker-namespaced).
- Data written: agent -> hot-folder copy + archive move + ERP outcome; sync
  -> PrintLogImport/Entry rows; review/writeback -> ProductionJob actuals.

## Gaps (ranked)
1. Roland actuals capture is manual-export only (no VersaWorks watcher).
2. JobInfo->CSV converter unlocated: resolution/passes/copies/output W x L /
   cut time may be flattened before upload (rawRow keeps whatever arrives).
3. No PrintIntake DB record for unmatched files (review lives in a rolling
   50-entry notes blob; no ticket for print-only work).
4. Original SHA-256 is computed but only hash8 reaches the ERP outcomes.
5. rasterlink-sync host machine + schedule unconfirmed.
6. Legacy watcher script still present (retire).

## 15F.0J.4 update (2026-07-26)
Gap closures: Roland actuals pipeline designed + shipped (drop-folder +
reused watcher + hardened widened import branch); capture gaps closed
(elapsed print/rip seconds, copies, dims, layout sqft, dual-channel sums,
event classes, fingerprints, quality flags); full SHA-256 now reported by
agent v1.3; review page surfaces quality/eligibility/match warnings.
Still open: PrintIntake DB records + print-only tickets (J-phase pending),
JobInfo converter location (contract published), rasterlink-sync host
confirmation.
