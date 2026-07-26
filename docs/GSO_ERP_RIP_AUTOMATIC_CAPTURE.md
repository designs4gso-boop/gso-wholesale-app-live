# GSO ERP — RIP Automatic Capture (15F.0J.4, 2026-07-26)

## What is FULLY AUTOMATIC after deployment
- Prints For Today -> route-plan -> hot-folder routing (existing agent task,
  RasterLink PC). Agent v1.3 (repo) additionally reports the FULL SHA-256
  per file (fileHash) alongside hash8 — deploy by replacing the script the
  existing task runs; the task itself is unchanged.
- Mimaki results: converter CSV -> rip-logs/rasterlink/incoming ->
  gso-rasterlink-sync.ps1 -> /api/rip-imports/upload (existing; parser now
  captures widened fields WHEN the converter provides them).
- Roland results: CSV dropped in rip-logs/roland/incoming -> SECOND
  gso-rasterlink-sync.ps1 instance (tools/gso-roland-sync-config.example.json,
  Source=versaworks) -> the SAME upload endpoint -> hardened VersaWorks
  branch (13A.6D) now widened with elapsed print/rip seconds, copies, dims,
  layout sqft, event class, quality flags, calibration/actual-cost
  eligibility, source-record fingerprints, and match methods.

## What REMAINS MANUAL (documented, owner-visible)
1. VersaWorks7 job-log EXPORT: VersaWorks has no supported hot-export API;
   the one manual step is exporting the job log CSV (existing all-time
   export workflow) into \\SynologyNAS\GSOP\GSOP\rip-logs\roland\incoming.
   Weekly cadence recommended; cumulative exports are safe (fingerprint +
   natural-key dedupe import only new events). GUI automation was rejected
   as brittle; if Roland publishes a supported export scheduler, adopt it.
2. JobInfo.ini -> CSV converter (Mimaki): still EXTERNAL/UNLOCATED —
   verified negative on the RasterLink PC (scheduled tasks, startup folders,
   C:\ scan for *jobinfo*, C:\MijCtrl contents). The required field
   contract for whoever maintains it: GSO_ERP_MIMAKI_RESULT_CAPTURE_CONTRACT.md.

## Workers/tasks (design + install steps — NOT installed by this patch)
| Worker | Script | Machine | Trigger | Config |
|---|---|---|---|---|
| GSO Print Intake Agent (existing) | tools/gso-print-intake-agent.ps1 v1.3 | RasterLink PC | existing task (30s loop) | gso-print-intake-agent-config.json |
| RasterLink result sync (existing) | tools/gso-rasterlink-sync.ps1 | host TBD (owner confirm) | poll 30s | gso-rasterlink-sync.config.json |
| Roland result sync (NEW instance) | SAME gso-rasterlink-sync.ps1 | RasterLink PC recommended | poll 60s | gso-roland-sync.config.json (from the example) |
Install (when authorized): copy example config, paste token from
/app/erp/print-intake, create folders roland/{incoming,processed,error},
then: schtasks /Create /TN "GSO Roland Result Sync" /SC MINUTE /MO 5
/TR "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File
<repo>\tools\gso-rasterlink-sync.ps1 -Once -ConfigPath
<repo>\tools\gso-roland-sync.config.json" /RU <account>. Health:
-Health mode; logs in rip-logs/sync-logs. Rollback: schtasks /Delete.
NAS credentials: the task account needs read/write on rip-logs/roland.

## Recovery
Claims are stale-reclaimed after 30 min; error files carry .error.json
sidecars; re-uploading any file is safe (file-hash + row dedupe); raw
source rows/files retained on every import (PrintLogImport.rawText,
PrintLogEntry.rawRow immutable).
