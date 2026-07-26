# GSO ERP — Roland Profile Calibration (MEASURED, 15F.0J.1, 2026-07-26)

Wall-clock occupancy (median) vs approximate uninterrupted run (p75) from
695 accepted rows; per LAYOUT sqft (utilization ~99%, so ~= artwork sqft).

## LG-640 (the calculator's printer)
| Group | n | conf | weighted sqft/hr | median | p25 | p75 | fixed+variable fit |
|---|---|---|---|---|---|---|---|
| CMYK only (Generic Sign Production) | 127 | HIGH | 12.8 | 18.8 | 8.0 | 40.4 | 5.2 min + 13.9 sqft/hr (R2 0.17 — idle noise) |
| Gloss stage (Special Effects) | 164 | HIGH | 6.7 | 6.6 | 4.7 | 11.9 | 50.8 min + 12.9 sqft/hr (R2 0.16) |
| CMYK+White combined | 14 | HIGH-ish | 8.5 | 4.7 | 3.2 | 16.2 | 14.9 min + 14.3 (R2 0.44) |
| White only | 7 | MEDIUM | 4.0 | 5.3 | 3.7 | 5.6 | fixed-dominated (n small) |

| Ink | n | weighted ml/sqft | median | vs quote 0.6 |
|---|---|---|---|---|
| CMYK | 127 | 1.124 | 1.052 | ~1.8x MORE |
| White (combined stages) | 14-21 | 2.30 (combined) / 5.08 (white-only) | 1.92 / 5.72 | 3-9x MORE |
| Gloss (per STAGE, layers unknown) | 164 | 2.888 | 2.834 | ~4.7x MORE per stage |

## Verdicts vs current calculator assumptions
- CMYK 150 sqft/hr: NOT SUPPORTED — TOO HIGH. Even p75 (uninterrupted-ish)
  is 40 sqft/hr; median occupancy 18.8. 150 overstates real throughput
  4-8x. (Head-speed ratios did NOT predict wall throughput.)
- Gloss 110 sqft/hr/layer: NOT SUPPORTED — TOO HIGH by ~10-16x per stage.
- White 75 sqft/hr/layer: NOT SUPPORTED — TOO HIGH by ~13x.
- 0.6 ml/sqft: TOO LOW on every channel (see table).
- Width bands: 115/127 CMYK jobs ran at 48+ in configured width — width
  variation too small to model; layout sqft (== feed length x ~constant
  width) is the right driver. Fixed time exists (5-50 min by mode) —
  models 2/4 (fixed + variable) fit best; never force through zero.
- Stages are ADDITIVE by construction: CMYK and gloss appear as separate
  print events (the Flame Society sample: CMYK+White 15.9 min, then a
  separate gloss stage).

## LG-540 (background comparison ONLY — do not mix)
CMYK n=182: weighted 21.3 / median 45.1 sqft/hr; ml/sqft 1.006.
Gloss n=197: weighted 7.4 / median 6.6; 2.744 ml/sqft. The LG-540 history
is consistent with (slightly faster than) LG-640 — supports the same
conclusions; LG-640 drives the calculator.

## Q. Provisional recommendations (NOT implemented — owner approval gate)
| Input | Recommended provisional | Basis | Safe now? |
|---|---|---|---|
| LG-640 CMYK | 10 min fixed + 40 sqft/hr run + 1.5x occupancy safety | p75 n=127 HIGH | YES with safety factor |
| LG-640 white stage | 15 min fixed + 12 sqft/hr | combined p75, n=14-21 MED | conservative yes |
| LG-640 gloss stage | 20 min fixed + 12 sqft/hr PER STAGE (charge layers as stages ONLY if actually run; else 1 stage) | p75 n=164 HIGH; layers unknowable | YES per stage; layer multiplier NEEDS DATA |
| CMYK ml/sqft | 1.05 | median n=127 HIGH | YES |
| White ml/sqft | 1.9 (combined) | median n=14 MED | YES |
| Gloss ml/sqft | 2.83 per stage | median n=164 HIGH | YES |
| Small-job minimum runtime | 15 min | fixed-fit floor | YES |
| Outliers | exclude elapsed>4h + IQR fence in calibration | methodology | YES |
Additional data needed: attended-vs-idle split (J.2 capture), gloss layer
count per job (RIP-side capture or routed-name mode token), coverage %.
