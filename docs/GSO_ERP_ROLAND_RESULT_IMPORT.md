# GSO ERP — Roland Result Import (15F.0J.4, 2026-07-26)

Source: VersaWorks7 job-log CSV (the all-time format verified in the
forensics — colon ink arrays mapped BY NAME, mm dims, per-stage events).
Automatic-source findings: options 1/3/5 (export automation, supported
API/db read) do NOT exist for VersaWorks7; option 4 (incremental processing
of a refreshed export) is the supported path -> designated NAS drop
(rip-logs/roland/incoming) + the reused sync watcher. No UI scraping.

## Normalized per row (active upload branch, 13A.6D widened)
printer nickname, event + eventClass (completed/canceled/error/queue),
job name + normalized name, ticket from the routed name, profile
(Media Name), page W/F in, output W/F in (Print Area X/Y), layout sqft,
copies, RIP start/end + elapsed, print start/end + elapsed seconds
(midnight-safe; printMinutes now stored — was 0), per-channel ink mapped
by Ink Name (dual white/gloss summed), CMYK/white/gloss/other totals,
unknown channels flagged, raw row verbatim + _gso block (capture version,
source-record fingerprint, quality flags, calibrationEligible,
actualCostEligible, exclusionReason, matchMethod).

## Dedupe (D)
Two independent layers: file level (sha256 marker on PrintLogImport —
"duplicateFile" response) and row level (natural key on shop + source +
job name + machine + event + start/end; blank-time rows add inkMl+sqft)
PLUS the stable sourceRecordFingerprint recorded in _gso (printer, event,
name, times, dims, copies, channel names, per-channel ml — never row
position). Same export twice -> zero new rows; cumulative export -> only
new events; corrected rows (changed fields) -> new fingerprint -> imported
alongside and visible in review; canceled/error retained, never actuals.

## Stage/attempt semantics (H)
Stages arrive as separate print events (CMYK+White vs gloss rows).
Fingerprints keep combined vs isolated stages distinct; duplicate
completion rows are import-skipped (natural key) or quality-flagged;
reprints share the GSO ticket but carry their own fingerprint/attempt
identity and are never merged into the original run.
