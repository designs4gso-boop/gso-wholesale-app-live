# GSO ERP — Acceptance Quote Fixtures (15F.0-FINAL, 2026-07-25)

Machine-checked in tests/calculator-forensic-fixtures.test.ts +
tests/production-ready-pricing.test.ts (605 total). Sources: Poseidon
$0.3155556/sqft ($213/675 sqft, cmoxmgvx8…); Banner Vinyl $0.2962963;
Mimaki $0.176/ml, Roland $0.198667/ml; 150 sqft/hr verified speed x $8/hr
owner recovery; square-rect cutting $6.53/54x54 page (owner-documented),
contour bands x1.15/x1.35/x1.60 PROVISIONAL; packing $2/box (stickers
5,000/box PROV; jars 100/box PROV; banners $4/tube PROV); banner finishing
$0.60/ft hems + $0.30/grommet @24in + $5 setup PROV; setup $8.3333 art +
$1.00 print per design; sticker AREA market floor $8.00->$3.20/sqft
(documented anchors, PROV) + setup recovery; family minimum profits
25/75/75/100/25/25 and order minimums stickers $25 / banners $40 / custom
$25 (PROV, owner $25/hr basis). Outbound shipping excluded and stated on
every quote.

## J. Fixture book (candidates -> final)

| # | Fixture | Cost | Cost-based | Area floor / ladder | Min-profit | Min-order | Premium | FINAL (controlling) | Profit | Margin | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100 x 3x3 matte square | 21.16 | **60.45** @65% | 59.33 | 46.16 | 25 | — | **$60.45** (cost-based) | 39.29 | 65% | READY TO QUOTE |
| 2 | 1,000 x 3x3 matte square | 70.40 | 117.34 @40% | **209.33** | 95.40 | 25 | — | **$209.33** (area market floor) | 138.93 | 66.4% | READY TO QUOTE |
| 3 | 100 x 3x3 simple contour | 22.14 | **63.25** @65% | 59.33 | 47.14 | 25 | — | **$63.25** (cost-based) | 41.11 | 65% | READY TO QUOTE |
| 4 | 1,000 x 3x3 simple contour | 74.32 | 123.87 @40% | **209.33** | 99.32 | 25 | — | **$209.33** (area market floor) | 135.01 | 64.5% | READY TO QUOTE |
| 5 | 585 x 7.13x3.13, 3 designs, 3 gloss (square) | 163.96 | 341.58 @52% | 318.12 | 188.96 | 25 | **372.63** @56% | **$372.63** (premium spot-gloss floor) | 208.68 | 56% | READY TO QUOTE |
| 6 | same, simple contour | 168.86 | 351.78 | 318.12 | 193.86 | 25 | **383.76** | **$383.76** (premium floor) | 214.91 | 56% | READY TO QUOTE |
| 7 | multi-line: 100x3x3 + 250x4x4 one-gloss | 63.94 | per line | A **59.33** + B **142.67** | 88.94 (job) | 25 (job) | B base | **$202.00** (sum of line prices; both floor-controlled) | 138.06 | 68.3% | READY TO QUOTE |
| 8 | 1,000 x 4x5 bags, one-sided | 298.39 | **542.53** @45% | — | 373.39 | — | — | **$542.53** (cost-based) | 244.14 | 45% | READY TO QUOTE |
| 9 | 1,000 x 4x5 bags, double-sided | 495.45 | **900.82** @45% | — | 570.45 | — | — | **$900.82** (cost-based) | 405.37 | 45% | READY TO QUOTE |
| 10 | 585 Chiron 150 ml, one 3x2 label | 1,275.74 | **2,551.49** @50% | — | 1,375.74 | — | — | **$2,551.49** (cost-based) | 1,275.74 | 50% | READY TO QUOTE |
| 11 | 585 jars, three labels (2x2/2x2/2x1) | 1,524.84 | **3,049.68** @50% | — | 1,624.84 | — | — | **$3,049.68** (cost-based) | 1,524.84 | 50% | READY TO QUOTE |
| 12 | 2,500 Spektra DTP 4x5x2 | 1,323.83 landed | — | **owner ladder $0.88 -> $2,200.00** | $500/$350 rules | — | — | **$2,200.00** (DTP owner ladder) | 876.17 | 39.83% | **READY TO QUOTE** (note: below 40% target; meets 35% floor + $500 target) |
| 13 | 3x6 ft banner, trimmed | 28.97 | **72.42** @60% | — | 53.97 | 40 | — | **$72.42** (cost-based) | 43.45 | 60% | READY TO QUOTE |
| 14 | 3x6 ft banner, hems + grommets | 47.47 | **118.67** @60% | — | 72.47 | 40 | — | **$118.67** (cost-based) | 71.20 | 60% | READY TO QUOTE |

## K. Market calibration — stickers/labels + banner

| Fixture | Cost | Cost-based | Commercial floor | FINAL | Competitor low/mid/high | GSO position |
|---|---|---|---|---|---|---|
| 100 x 3x3 (square) | 21.16 | 60.45 | 59.33 | **60.45** | 50 / 65 / 80 | in band, just under mid ✓ |
| 100 x 3x3 (contour) | 22.14 | 63.25 | 59.33 | **63.25** | 50 / 65 / 80 | in band, ~mid ✓ |
| 1,000 x 3x3 (square) | 70.40 | 117.34 | 209.33 | **209.33** | 200 / 250 / 300 | in band, LOW EDGE (conservative anchors — owner may raise) |
| 1,000 x 3x3 (contour) | 74.32 | 123.87 | 209.33 | **209.33** | 200 / 250 / 300 | in band, low edge |
| 585 large gloss labels | 163.96 | 341.58 | 318.12 | **372.63** | no documented premium range | premium-appropriate: above the basic band via the spot-gloss study (flagged: owner premium market check pending) |
| 3x6 banner trimmed | 28.97 | 72.42 | — | **72.42** | 60 / 75 / 90 | in band, ~mid ✓ |

No final price sits BELOW its documented band; none exceeds the high end.
The 1,000-sticker fixtures sit at the low edge by design (floor anchors use
the documented LOW end — raising them is an owner decision, editable 15F.1).
