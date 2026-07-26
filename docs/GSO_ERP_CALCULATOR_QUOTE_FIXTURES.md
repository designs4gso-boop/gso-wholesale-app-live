# GSO ERP — Acceptance Quote Fixtures (15F.0-FINAL, 2026-07-25)

Machine-checked in tests/calculator-forensic-fixtures.test.ts +
tests/production-ready-pricing.test.ts (621 total). Sources: Poseidon
$0.3155556/sqft ($213/675 sqft, cmoxmgvx8…); Banner Vinyl $0.2962963;
Mimaki $0.176/ml, Roland $0.198667/ml; machine = PRINTER-SPECIFIC profiles
(Mimaki UCJV300-130 = COMBINED RasterLink table, 600x1200 VD / 32-pass /
Bi-direction / Fast Print High: 1-layer 51.6 / 2-layer 18.2 / 3-layer 11.8
/ 4-layer 8.6 sqft/hr x 1.15 turnaround applied once, owner-verified, 5+
layers BLOCK; Roland = ADDITIVE, CMYK 150 baseline + Gloss 110 / White HD
75 sqft/hr PER SELECTED LAYER; Mimaki gloss ink = PROVISIONAL estimate 0.6 ml/sqft x layers x factor
1.00 x $0.176/ml (15F.0G.3); minutes = hours x 60) x $8/hr recovery; square-rect cutting $6.53/54x54
page (owner-documented),
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
| 1 | 100 x 3x3 matte square (Mimaki) | 22.03 | **62.93** @65% | 59.33 | 47.03 | 25 | — | **$62.93** (cost-based) | 40.91 | 65% | READY TO QUOTE |
| 2 | 1,000 x 3x3 matte square (Mimaki) | 79.08 | 131.80 @40% | **209.33** | 104.08 | 25 | — | **$209.33** (area market floor) | 130.25 | 62.2% | READY TO QUOTE |
| 3 | 100 x 3x3 simple contour (Mimaki) | 23.01 | **65.73** @65% | 59.33 | 48.01 | 25 | — | **$65.73** (cost-based) | 42.72 | 65% | READY TO QUOTE |
| 4 | 1,000 x 3x3 simple contour (Mimaki) | 83.00 | 138.33 @40% | **209.33** | 108.00 | 25 | — | **$209.33** (area market floor) | 126.33 | 60.4% | READY TO QUOTE |
| 5 | 585 x 7.13x3.13, 3 designs, 3 gloss (square) | 169.82 | 353.79 @52% | 318.12 | 194.82 | 25 | **385.95** @56% | **$385.95** (premium spot-gloss floor) | 216.13 | 56% | READY TO QUOTE |
| 6 | same, simple contour | 174.72 | 364.00 | 318.12 | 199.72 | 25 | **397.09** | **$397.09** (premium floor) | 222.37 | 56% | READY TO QUOTE |
| 7 | multi-line: 100x3x3 Mimaki + 250x4x4 one-gloss Roland | 65.41 | per line | A **59.33** + B **142.67** | 90.41 (job) | 25 (job) | B base | **$202.00** (sum of line prices; both floor-controlled) | 136.59 | 67.6% | READY TO QUOTE |
| 8 | 1,000 x 4x5 bags, one-sided (Mimaki) | 317.68 | 705.95 @55% | **mkt target 850.00** | 392.68 | — | — | **$850.00** (verified market target) | 532.32 | 62.6% | READY TO QUOTE |
| 9 | 1,000 x 4x5 bags, double-sided (Mimaki) | 534.02 | 1,112.54 @52% | **mkt target 1,130.00** | 609.02 | — | — | **$1,130.00** (verified market target) | 595.98 | 52.7% | READY TO QUOTE |
| 10 | 585 Chiron 150 ml, one 3x2 label (Mimaki) | 1,279.13 | **2,558.26** @50% | — | 1,379.13 | — | — | **$2,558.26** (cost-based) | 1,279.13 | 50% | READY TO QUOTE |
| 11 | 585 jars, three labels (2x2/2x2/2x1, Mimaki) | 1,530.48 | **3,060.96** @50% | — | 1,630.48 | — | — | **$3,060.96** (cost-based) | 1,530.48 | 50% | READY TO QUOTE |
| 12 | 2,500 Spektra DTP 4x5x2 | 1,323.83 landed | — | **owner ladder $0.88 -> $2,200.00** | $500/$350 rules | — | — | **$2,200.00** (DTP owner ladder) | 876.17 | 39.83% | **READY TO QUOTE** (note: below 40% target; meets 35% floor + $500 target) |
| 13 | 3x6 ft banner, trimmed (Mimaki) | 31.47 | **78.67** @60% | — | 56.47 | 40 | — | **$78.67** (cost-based) | 47.20 | 60% | READY TO QUOTE |
| 14 | 3x6 ft banner, hems + grommets (Mimaki) | 49.97 | **124.92** @60% | — | 74.97 | 40 | — | **$124.92** (cost-based) | 74.95 | 60% | READY TO QUOTE |
| 15 | 585 x 7.13x3.13, 3 designs, 3 GLOSS, simple contour (MIMAKI — 15F.0G.3) | 249.65 | 520.10 @52% | 318.12 | 274.65 | 25 | **567.39** @56% | **$567.39** (premium spot-gloss floor) | 317.74 | 56% | READY TO QUOTE (machine $107.76 combined 4-layer; gloss $31.91 provisional estimate) |

### 15F.0K.2-B — INTENTIONAL 4x5 bag repricing (research calibration, owner-approved 2026-07-26)

Fixtures 8/9 changed DELIBERATELY: the competitor-pricing study proved 4x5 bag
volume tiers were priced under market, so the bag margin bands were calibrated
(single 1:65/128:64/256:61/500:58/640:57/1000:55/1500:52/5000:50; double-sided
variant 1:65/128:61/256:58/500:54/1000:52/1500:49/5000:47; familyMinPct 45;
40% global floor untouched). Costs did NOT change — margin-only. Exact
before -> after at 1,000: single **$577.59 @45% -> $705.95 @55%**
(+$128.35, +22.2%); double **$970.94 @45% -> $1,112.54 @52%** (+$141.60,
+14.6%). Band 1 stays 65% on both curves, so quantities 1–127 (including the
64-unit fixtures) are UNCHANGED, and no price decreased at any quantity
(test-pinned in tests/margin-curve-equivalence.test.ts). Other families, DTP,
and all non-bag fixtures are byte-identical. Research unit-price floors and
market/crossover warnings arrive in later approved phases.

### 15F.0K.3 — verified market targets for 4x5 bags (owner-approved 2026-07-26)

Fixtures 8/9 changed a second time, DELIBERATELY: owner decision — standard
4x5 sticker-applied bags normally target the VERIFIED competitor median, not
a cost-based price materially below market. The market target is a
RAISING-ONLY candidate (bags-4x5 / bags-4x5-double only; every other family
rejected): 1,000 single **$705.95 -> $850.00** ($0.85/unit at the median,
62.6% margin); 1,000 double **$1,112.54 -> $1,130.00** ($1.13/unit, 52.7%).
Cost-based candidates and all COSTS unchanged. Targets are OFF (null) at
5,000+ so they never hide the direct-print crossover — those tiers stay
cost-based with a STRONG advisory + live Spektra DTP comparison; 2,500 shows
the mild "price check" advisory. Researched floors ride along as
negotiation-floor DISPLAY data (below-floor = stronger warning, never a
block/raise). An explicit staff per-tier margin edit takes command: the
target stops contending and below-target/below-negotiation-floor warnings
show instead (margin floors + OWNER MARGIN OVERRIDE gate unchanged).
Disabling the family on Pricing Settings restores the Stage-B outputs
exactly (test-pinned in tests/market-targets.test.ts).

## K. Market calibration — stickers/labels + banner

| Fixture | Cost | Cost-based | Commercial floor | FINAL | Competitor low/mid/high | GSO position |
|---|---|---|---|---|---|---|
| 100 x 3x3 (square, Mimaki) | 22.03 | 62.93 | 59.33 | **62.93** | 50 / 65 / 80 | in band, ~mid ✓ |
| 100 x 3x3 (contour, Mimaki) | 23.01 | 65.73 | 59.33 | **65.73** | 50 / 65 / 80 | in band, ~mid ✓ |
| 1,000 x 3x3 (square, Mimaki) | 79.08 | 131.80 | 209.33 | **209.33** | 200 / 250 / 300 | in band, LOW EDGE (conservative anchors — owner may raise) |
| 1,000 x 3x3 (contour, Mimaki) | 83.00 | 138.33 | 209.33 | **209.33** | 200 / 250 / 300 | in band, low edge |
| 585 large gloss labels | 169.82 | 353.79 | 318.12 | **385.95** | no documented premium range | premium-appropriate: above the basic band via the spot-gloss study (flagged: owner premium market check pending) |
| 3x6 banner trimmed (Mimaki) | 31.47 | 78.67 | — | **78.67** | 60 / 75 / 90 | in band, upper-mid ✓ |

No final price sits BELOW its documented band; none exceeds the high end.
The 1,000-sticker fixtures sit at the low edge by design (floor anchors use
the documented LOW end — raising them is an owner decision, editable 15F.1).
