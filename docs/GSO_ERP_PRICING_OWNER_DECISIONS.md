# GSO ERP — Remaining Pricing Owner Decisions (15F.0-FINAL, 2026-07-25)

Two classes now: **RATIFY** = a PROVISIONAL conservative rule is LIVE and
labeled — the owner confirms or adjusts (editable in 15F.1); **PROVIDE** =
still blocked/absent until the owner supplies it. Nothing here requires
routine owner review of ordinary quotes.

## RATIFY (live provisional rules)
1. Sticker AREA market floor bands ($8.00/$6.40/$4.80/$4.00/$3.20 per sqft;
   low-end anchors) — 1,000 x 3x3 prices at the LOW edge ($209.33 vs
   $200-300); raise bands to move up-market.
2. Minimum gross profits: stickers $25 / bags $75 / standard jars $75 /
   premium jars $100 / banners $25 / custom $25 (owner $25/hr labor basis).
3. Minimum order totals: stickers $25 / banners $40 / custom $25.
4. Contour cutting multipliers x1.15 / x1.35 / x1.60 of the $6.53 page
   standard.
5. Banner finishing: $5 setup + $0.60/ft hems + $0.30/grommet @24in; $4
   tube packing (5 banners/tube).
6. Packing densities: stickers 5,000/box; jars 100/box (Safe Care 4oz
   basis); machine recovery $8/hr vs the stale $5 Machine records; ROLAND
   RIP mode rates Gloss 110 / White HD 75 sqft/hr per layer (owner-approved
   provisional 2026-07-25). Mimaki UCJV300-130 RasterLink combined-layer
   profile (600x1200 VD / 32-pass / Bi / Fast Print High: 51.6/18.2/11.8/
   8.6 sqft/hr x 1.15 turnaround) is OWNER-VERIFIED — not a ratify item;
   the stale generic Machine-record speed is deliberately unused for it
   (the interim single-rate figure was retired as incorrect).
7. Margin band edges 64/128/256/640/1000 (margin-study tier structure).

## PROVIDE (blocked or absent until supplied)
8. Die-cut/irregular cutting model — BLOCKS with the exact message.
8b. Mimaki gloss INK ACTUALS — gloss now quotes PROVISIONALLY (owner
    decision 2026-07-25): CMYK 0.6 ml/sqft basis x layers x glossFactor 1.00
    x $0.176/ml, labeled estimated. RATIFY/refine the factor only through
    the read-only RIP calibration report (min 3 finalized comparable jobs;
    weighted factor = actual ml / base estimated ml; 3-4 low / 5-9 medium /
    10+ high confidence) — never automatic, editable as
    ownerConfig.inkCalibration.mimaki.glossFactor in 15F.1 (whiteFactor kept
    separate; white ink itself remains verified). Layer totals of 5+ still
    BLOCK ("Verified Mimaki RasterLink layer profile required").
9. Premium-label market range check (fixture 5 ~$372) — the spot-gloss curve
   is owner-approved; a market cross-check is pending.
10. Unpriced bag sizes (4x6/5x8/6x9) — Vendor Cost Book entries.
11. Mimaki gloss ink cost — stays a blocker on Mimaki gloss jobs.
12. Blank waste policy; recipe waste wiring; overhead/payment-processing
    allowance — unchanged open items from 15F.0.

All RATIFY values land in ownerConfig (ErpAdminSetting) during 15F.1/15F.2
per GSO_ERP_SETTINGS_OWNERSHIP_PLAN.md.

## 15F.0J additions (2026-07-25)
PROVIDE (data/answers):
13. Roland all-time CSV to a repo-visible path (forensics blocked on it).
14. Locate/confirm the JobInfo->CSV converter + rasterlink-sync host
    machine; confirm whether output W x L, copies, pass/resolution, cut
    time, and BOTH white channels can be included in the incoming CSV.
15. _routed-archive filename listing (read-only) for the compatibility
    corpus; confirm VersaWorks weekly export cadence for Roland actuals.
16. Holographic media: add the Material record + verified cost (holo
    quoting is BLOCKED without it).
RATIFY (numbers before J.5/J.6 implement):
17. Operator-labor model values (fixedSetup ~10-15 min, unload/QC ~5-10,
    attended 10-20%, per-design 1-2, special-mode ~5; $25/hr basis).
18. 4x5 double-sided bag ladder transcription (matte 1.80/1.65/1.50/1.35/
    1.25 ... 4X 2.85-2.05 + holo rows) as the bag commercial ladder.
19. Min gross profit per MACHINE HOUR candidate (provisional $75/hr).
20. Top-tier margin floors by finish (bags matte >=55%, spot gloss >=60%,
    sticker volume >=55%) after the manual competitor captures (8-10
    configurator quotes; template in GSO_ERP_COMPETITOR_MARGIN_STUDY.md).

## 15F.0J.3 note (2026-07-26)
Roland measured ink rates (1.05/1.90/2.83) are LIVE as owner-ratified
provisional. Remaining on this thread: white coverage % collection
(MEDIUM->HIGH), Roland RUNTIME adoption after the J.2 attended-time split,
and any future rate change only via new measured actuals + owner approval.
