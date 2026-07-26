# GSO ERP — RIP Actual Normalization (15F.0J, 2026-07-25)

## U. Contract vs current storage
PrintLogEntry ALREADY holds: shop, importId, productionJobId/ItemId,
jobTicket, sourceJobName, printerSoftware, machineName, mediaName, status,
sqft, cmyk/white/gloss/total ml, printMinutes, startedAt/completedAt,
rawRow (raw source, immutable), createdAt. PrintLogImport holds source,
fileName, rawText (whole file), counts, totals.
JSON-CARRIED (rawRow) until a migration is justified: profileName,
resolution, passCount, direction, quality, mode, overprints, white/gloss
layer counts, copies, outputWidthIn/outputFeedIn, layoutSqft, finishedSqft,
utilizationPct, spool/rip/print/cut seconds, routedFilename, fileHash,
matchMethod, matchConfidence, printIntakeId, quoteId.
FUTURE MIGRATION (only when querying/aggregating at scale): promote
layoutSqft, cut seconds, copies, matchMethod, printIntakeId to columns.
DEFERRABLE: yes — calibration reads can JSON-parse rawRow (same pattern the
15E reporting uses for event snapshots).

## V. Matching ladder (target; stored as matchMethod)
EXACT_TICKET (routed name ticket — exists today) > EXACT_MANIFEST
(productionJobId from the sidecar) > EXACT_HASH > EXACT_ROUTED_FILENAME >
EXACT_NORMALIZED_FILENAME (existing normalizeFileIdentity equality) >
PROBABLE_METADATA (printer+date+dims+copies+hints -> review suggestion
only) > MANUAL (actor+reason) > UNMATCHED. Only EXACT_* or approved MANUAL
may feed actual-cost writeback (writeback already sits behind the owner
phrase "APPLY PRINT LOG ACTUALS").

## T. Three immutable layers + comparison fields
QUOTE ESTIMATE (snapshot, never rewritten) / RIP PRE-PRINT ESTIMATE
(layout, profile, est time+ink; internal variance preview; keep-or-adjust
suggestion, never silent) / POST-PRINT ACTUAL (logged time/ink/material/
labor/reprints -> finalization + calibration). Comparison set (stored with
the finalized job, quote untouched): quoted sqft vs RIP-layout sqft; quoted
vs actual material; est runtime vs RIP est vs actual; est vs actual CMYK/
white/gloss ml; est vs actual cut time; est vs actual labor; est vs actual
total cost; quoted price vs invoice; quoted vs actual margin. The
premiumInkEstimate snapshot (15F.0G.3) is the quote-side anchor.

## 15F.0J.4 update (2026-07-26) — IMPLEMENTED capture widening
The normalized contract now materializes: VersaWorks rows store the full E
field set (dims/copies/elapsed/channels/fingerprints/quality/eligibility/
matchMethod) in normalized columns + the immutable rawRow._gso block;
Mimaki rows gain the widened fields whenever the converter supplies them
(dual channels summed). Match ladder labels live in code
(rip-capture.server matchMethodAllowsActuals): only EXACT_*/MANUAL feed
actuals; PROBABLE stays review-only (the writeback additionally sits
behind the owner phrase). Calibration eligibility is SEPARATE from
actual-cost inclusion (runtimeQualityFlags): completed idle-contaminated
stages count as occupancy cost but never as speed-calibration samples.
buildRipCalibrationCandidate emits the K candidate records (factors,
flags, eligibility, exclusion reasons) — nothing auto-applies; the >=3
comparable-jobs rule stands.
