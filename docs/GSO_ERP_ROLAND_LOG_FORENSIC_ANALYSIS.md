# GSO ERP — Roland Log Forensic Analysis (15F.0J.1 EXECUTED, 2026-07-26)

Source (read in place, unmodified): \\SynologyNAS\GSOP\GSOP\downloads\
roland-all-time-job-log.csv — 1,102,030 bytes, modified 2026-07-26 09:03,
UTF-8 BOM, comma-delimited, 18 columns (Event, Nick Name, Job Name, Size,
Page Size_X/Y[mm], Media Name, Copy, Print Area_X/Y[mm],
Ink Consumption[ml], Ink Name, Input/RIP Start/RIP End/Print Start/
Print End Time, Details). Derived outputs: analysis-output/roland/ (8 CSVs;
job names ANONYMIZED via stable sha256 prefixes — customer-identifying
names stay out of Git; raw stays on the NAS only).

## Inventory
5,219 rows; dates 2026-03-26 -> 2026-07-24. Printers: LG-640 2,521 /
LG-540 2,698 (nicknames clean and reliable). Events: Print End 2,086,
Print Canceled 1,575, New Job(Queue A) 1,375, New Job(Main Que) 81,
Print Start 41, Print Error 49, RIP Canceled 6, RIP End 3, Error 3.
"Media Name" is the RIP PROFILE, not physical media: Generic Sign
Production 3,552 / Special Effects 1,628 / Generic Sign Quality 19 /
Generic Label 17. Blank rates: ink fields empty on 1,554 rows (queue
events), print times empty on ~1,500, Input/RIP times empty on ~3,760.
483 exact duplicate rows; 1,125 duplicate completion rows (same normalized
job + printer + area + start time) reclassified DUPLICATE_SUMMARY.

## Parsing decisions (validated from data)
Dimensions mm -> inches (/25.4). LAYOUT sqft = Print Area_X x Print
Area_Y / 144 — Area_X is the configured print width (~40in/1018mm typical)
and Area_Y the feed length; artwork sqft = Page X x Y x Copy. Measured
utilization artwork/layout: median 98.9% (p25 95.9) — full-width nesting;
layout ~= artwork area on this data. Ink arrays are colon-separated ml
MAPPED BY the Ink Name field per row (order varies: Yellow:Magenta:Black:
Cyan:White vs ...:Gloss) — never positional. Elapsed print seconds =
Print End - Print Start (midnight-crossing corrected). Job-name
normalization strips " - Copy"/"Copy 2"/"(2)" for identity only.

## Cleaning
ACCEPTED: 695 completed print rows with valid dims, parsable ink, elapsed
10s-4h (LG640: CMYK 127, GLOSS_ONLY 164, CMYK+WHITE 14, WHITE_ONLY 7;
LG540: CMYK 182, GLOSS_ONLY 197, CMYK+WHITE 4). EXCLUDED 4,524: canceled
1,581 / failed 52 / duplicate-completion 1,125 / queue+start+RIP events
1,500 / no-ink 5 / >4h possible-idle or bad rows (1,200 rows carried the
>4h idle flag). CRITICAL SEMANTIC: elapsed is WALL-CLOCK — it contains
pauses/idle (p25-p75 spreads of 5x prove it), so medians measure REAL
OCCUPANCY, while p75 approximates uninterrupted run speed. Layer counts
for gloss stages are NOT inferable from the log (one stage row regardless
of overprint) — per-stage figures only, never per-layer claims.

## Measured results: see GSO_ERP_ROLAND_PROFILE_CALIBRATION.md (tables) and
analysis-output/roland/*.csv (full detail).
