# GSO ERP — Roland Log Forensic Analysis (15F.0J, 2026-07-25)

## Source status: PENDING DATA
"rolansd csv all time.csv" is NOT present in this environment (searched
Downloads/Desktop/Documents/workspace; /mnt/data is a different-session
path). The NAS is unreachable from this PC session. ACTION FOR OWNER: place
the export at a repo-visible path (suggest docs/data/roland-all-time.csv or
Downloads) and rerun the analyzer below. Nothing was modified.

## Methodology (locked now so results are reproducible)
1. Ingest read-only; sniff encoding (expect UTF-8/UTF-16 VersaWorks export)
   + delimiter (comma/semicolon/tab); inventory EXACT columns + row count.
2. Printer split: LG-640 vs LG-540 vs nicknames from the printer column.
3. Row classes: completed print / cut-only / canceled-error / summary or
   duplicate (same job+timestamps repeated) / ambiguous.
4. Cleaning acceptance: completed status; width>0 and length>0; elapsed>0;
   parsable ink array; not canceled; not duplicate; stage overlap resolved
   so one wall-clock interval is never counted twice; idle gaps > 15 min
   inside one job flagged separately (attended-time analysis), excluded
   from throughput.
5. Name normalization: strip Copy/Copy 2/(n)/final/revised for identity;
   preserve source name; extract GSO tickets when present; group stage
   variants (same identity, different mode) for additivity testing.
6. Metrics per accepted row: layout sqft (output W x L), print s, cut s,
   sqft/hr, per-channel ml (ink array mapped by ink-name row order:
   WWGGCMYK), ml/sqft per channel class, ink cost at DB rates.
7. Aggregate per group (printer x mode x quality/profile x media class):
   MEDIAN + throughput-WEIGHTED mean + IQR + outlier count + n. Never a
   plain unfiltered average. Confidence n:3-4 low / 5-9 med / 10+ high.
8. Mode classes: CMYK-only / white-only / gloss-only / CMYK+white /
   CMYK+gloss / other combined; overprint inferred where the profile or
   name states it — otherwise unknown, never assumed.
9. Outputs: measured sqft/hr and ml/sqft tables by mode; additive-stage
   test (does CMYK+gloss elapsed ~= CMYK + gloss alone?); small-job fixed-
   time fit (elapsed = a + sqft/rate regression); coverage sensitivity where
   coverage is inferable.
Deliverable table skeletons live in GSO_ERP_ROLAND_PROFILE_CALIBRATION.md;
every measured cell is marked PENDING until the CSV runs through this.
