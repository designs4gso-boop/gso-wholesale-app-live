# GSO ERP — Mimaki Profile Calibration (15F.0J, 2026-07-25)

## M. Capture audit (current)
The upload pipeline flattens results to the alias columns (job name,
machine, media/profile, status, sqft, cmyk/white/gloss/total ml,
print minutes, started/completed) and PRESERVES the raw row (rawRow) and
raw file (rawText). NOT explicitly parsed today: resolution, pass count,
direction, fast-print, copies, output scan width, output feed length, cut
time, spool/RIP time, per-channel duplicates — they survive ONLY if the
external JobInfo->CSV converter includes them (converter unlocated: OWNER
QUESTION — locate/confirm what writes rip-logs/rasterlink/incoming CSVs and
gso-rip-results-summary.csv). Two white channels summing: parser takes ONE
"white" column; if the converter emits two, the second is currently lost
unless pre-summed. Original filename: not in results (RasterLink shows the
routed name — which is the ticket, so matching works by design).

## Worked REAL sample (owner-provided, n=1 each — low confidence)
Sample A (white+CMYK, 69 copies of 2.128x2.128in):
- layout = 48.955 x 6.385 in = 312.6 sqin = 2.171 sqft; finished = 69 x
  4.528 sqin = 2.170 sqft -> utilization ~99.9% of the stated OUTPUT box
  (the output box is the nested bounding area, near-lossless here).
- print 21m26s = 21.433 min -> measured throughput 2.171 / 0.3572 hr =
  6.08 sqft/hr for a 2-layer job — the provisional table says 18.2:
  ACTUAL IS ~3x SLOWER on this small narrow-feed job. Feed length is only
  6.385 in: fixed start/lead-in dominates. Cut time equals print time
  (21m26s both) -> almost certainly ONE combined duration field or
  simultaneous print+cut semantics — treat as job wall-time, do NOT add.
- ink: total 4.183 cc / 2.171 sqft = 1.93 ml/sqft ALL channels;
  CMYK 3.35 cc -> 1.54 ml/sqft (quote basis assumes 0.6 — 2.6x low);
  white 0.416+0.417 = 0.833 cc -> 0.38 ml/sqft (two channels MUST be
  summed — confirms the dual-white risk above).
Sample B (CMYK job): total ink 40.008 cc — magnitude only (no dims given).

## N. Model findings + research framing
Separate rigorously: official spec (UCJV300-130 catalog speeds are
draft-mode maxima — NOT applicable), official profile table (600x1200 VD
32-pass numbers — obtain from Mimaki profile docs/RasterLink display),
RIP estimate (RasterLink shows predicted time/ink per job — capture it as
the PRE-PRINT layer), GSO measured (the only calibration truth), and the
provisional combined-layer table (51.6/18.2/11.8/8.6 x1.15 — UNVERIFIED;
sample A suggests it is OPTIMISTIC for small jobs, and the 13.47-hr premium
fixture complaint suggests it may also mis-scale large jobs).
RECOMMENDED RUNTIME MODEL to validate: time = fixedStart + feedLengthIn x
minutesPerFeedInch(profile, layers) — carriage sweeps the full scan width
regardless of art, so FEED LENGTH (layout), not finished area, drives time;
per-sqft-of-layout is equivalent only at constant width utilization. Until
>=10 measured jobs per profile band exist, the combined-layer table stays
labeled provisional. Data collection: enable capture of output W x L +
copies + pass/resolution + RIP-estimated time in the incoming CSV
(converter change), then run the calibration report (ink-calibration lib
extends to runtime rows).
