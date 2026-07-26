# GSO ERP — Mimaki Result Capture Contract (15F.0J.4, 2026-07-26)

The external JobInfo.ini->CSV converter is UNLOCATED (negative search on
the RasterLink PC: scheduled tasks, startup folders, C:\ *jobinfo* scan,
C:\MijCtrl). Until located/replaced, THIS is the required output contract;
the ERP parser (extractMimakiExtended) consumes whichever widened columns
are present and NEVER fabricates missing values — old CSVs parse
byte-identically.

## Existing required columns (unchanged)
job name (routed GSO ticket name), machine, media/profile, status, sqft,
cmyk ml, white ml, clear/gloss ml, print time, start, end.

## Widened columns (add when available)
resolution, pass count, print direction, quality/fast print, overprint,
copies, output scan width, output feed length, white 1 ml, white 2 ml,
clear 1 ml, clear 2 ml, spool time, rip time, cut time, source file.
Rules: dual white/clear channels arrive as separate columns (parser sums
into whiteSummedMl/clearSummedMl and the normalized totals) or pre-summed —
never dropped. Two-part colon durations are MINUTES:SECONDS ("21:26" =
21 min 26 s); three-part = H:MM:SS. Print time == cut time is legal
(simultaneous print&cut semantics — treat as job wall time, never added).
All widened fields land in PrintLogEntry.rawRow._gso (immutable) — no
migration; promote to columns only if aggregate querying demands it.
