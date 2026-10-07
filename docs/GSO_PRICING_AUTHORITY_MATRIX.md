# GSO Pricing Authority Matrix (2026-10-06)

One table: for each product family, where TRUE COST comes from, where the CUSTOMER PRICE comes from, and the evidence class of each. Evidence classes: **VENDOR OBSERVED DATA**, **OWNER-APPROVED COMMERCIAL RULE**, **MARKET RESEARCH**, **UNVERIFIED ASSUMPTION**, **OWNER STANDARD (labor/machine)**.

| Family | True cost authority | Evidence | Customer price authority | Evidence | Open owner items |
|---|---|---|---|---|---|
| Stickers & labels | canonical true-cost engine (`canonical-calculator.server.ts`, calibrated ink/machine, approved roll costs, GSO cutline, weeding standard) | OWNER STANDARD + measured calibration | `computeCommercialPrice`: stickers-labels curve + area market floor (provisional research anchors) + min profit/order | MARKET RESEARCH (provisional) + OWNER RULE | cliff at band edges (reported) |
| 4x5 sticker / stock bags | canonical engine (ERP) / legacy product-driven engine (storefront) | OWNER STANDARD; two engines (documented conflict) | owner-calibrated bands (2026-07-26) + verified market targets (raising-only) | MARKET RESEARCH ratified by owner | cliff 99 -> 100 (reported); engine consolidation |
| Premium jars (Miron) | canonical engine, Patch 2A geometry (pending physical confirmation) | OWNER STANDARD; geometry UNVERIFIED | owner 16D ladder + 45% minimum-margin protection + quantity-break envelope | OWNER-APPROVED (ladder) + OWNER RULE (floor) | jar floor vs ladder; geometry confirmation |
| Premium jars (Chiron) | canonical engine (shared Miron size key) | UNVERIFIED geometry | chiron-jars curve + envelope | unsourced family default | ladder, geometry |
| Standard jars (3oz/4oz) | canonical engine | OWNER STANDARD | owner 16D ladder + 40% floor + envelope | OWNER-APPROVED | tamper timing |
| Banners | canonical engine | OWNER STANDARD | banners curve + $40 minimum | unsourced family default | cliff at 128 (reported) |
| DTP pouches (Spektra, standard shape) | **4x5x2:** landed = live `spektra-live-cost-book` cost by EXACT configuration (2026-10-06 owner decision) + GSO art per design + **$85 freight (UNVERIFIED ASSUMPTION)**; **other sizes:** legacy VendorProduct tiers (15C seed) until reviewed, live book shown side by side | legacy tiers OWNER-VERIFIED 15C; live book VENDOR OBSERVED DATA | owner DTP sell ladders (2026-07-24) + hard floors + min job profit | OWNER-APPROVED | freight; ladders for 3.5x4.5x2 and 5x5x2; 5x4x2 legacy; MOQ 1,000 retained |
| DTP pouches (custom shape) | same as standard shape | same | standard price **+10%** shape surcharge; **$700** per unique new die, separate line; $0 on reuse | OWNER-APPROVED COMMERCIAL RULE (2026-10-06) | durable Die ID registry (schema) |
| Boxes | legacy / manual | — | legacy / manual | — | out of scope |

## DTP economics (loaded matrix, 2026-10-06) — 4x5x2 OWNER-APPROVED, other sizes under review

**4x5x2 is decided (owner 2026-10-06):** $1.30 / $0.71 / $0.46 / $0.37 at 1,000 / 2,500 / 5,000 / 10,000 — pricing source OWNER_APPROVED_DTP_4X5_2026_10_06, benchmark DESIGN_AND_CUSTOMIZE_PRIMARY (comparable CR $1.05 / $0.63 / $0.42 / $0.315 -> GSO premium +23.8% / +12.7% / +9.5% / +17.5%), 1,000 tier = acquisition exception ($350+ GP target; actual ~$439 / 33.8%), 25,000 = OWNER PRICING REVIEW REQUIRED. Full record: `GSO_DTP_4X5_OWNER_PRICING_2026-10-06.md`. The former options A / B / C for 4x5x2 are superseded and no longer shown.

Vendor = live Spektra cost book (exact public total x 0.75); landed = vendor + GSO art $8.3333 (1 design) + freight $85 (UNVERIFIED ASSUMPTION). Current sell for 6x5x2 / 8x5x2 = the 2026-07-24 ladders, flagged OWNER PRICING REVIEW REQUIRED (still in force for quoting; not derived from 4x5x2). Options A / B / C remain PROPOSALS for those sizes only; 3.5x4.5x2 and 5x5x2 show floor / target anchors only. No live price changes without an owner decision.

### Comparable configuration (legacy spec: Soft Touch)
| size | qty | ladder status | vendor unit (live) | old seed unit | change | landed unit | current sell | current GM | current GP | floor / GP target | protection | D&C comparable CR | GSO premium | A hold price GM/GP | B pass-through sell GM/GP | C split sell GM/GP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3.5x4.5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.369650 | — | — | $1.556317 | — | — | — | 30% / $500 | — | — | — | — | $2.2233 30.0% / $334 <$500 | $2.5939 40.0% / $519 |
| 3.5x4.5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.747968 | — | — | $0.841301 | — | — | — | 30% / $500 | — | $1.0500 | — | — | $1.2019 30.0% / $361 <$500 | $1.4022 40.0% / $561 |
| 3.5x4.5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.368163 | — | — | $0.405496 | — | — | — | 35% / $500 | — | $0.6300 | — | — | $0.6238 35.0% / $546 | $0.6758 40.0% / $676 |
| 3.5x4.5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.241115 | — | — | $0.259781 | — | — | — | 38% / $500 | — | $0.4200 | — | — | $0.4190 38.0% / $796 | $0.4330 40.0% / $866 |
| 3.5x4.5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.195982 | — | — | $0.205315 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.3312 38.0% / $1258 | $0.3422 40.0% / $1369 |
| 3.5x4.5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.159110 | — | — | $0.162843 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2627 38.0% / $2495 | $0.2714 40.0% / $2714 |
| 4x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.394700 | — | — | $1.581367 | — | — | — | 30% / $500 | — | — | — | — | $2.2591 30.0% / $339 <$500 | $2.6356 40.0% / $527 |
| 4x5x2 | 1,000 | OWNER APPROVED 2026-10-06 | $0.767363 | $0.9897 | -22.5% | $0.860696 | $1.30 | 33.8% | $439 | 30% / $350 | meets | $1.0500 | +23.8% | — | — | — |
| 4x5x2 | 2,500 | OWNER APPROVED 2026-10-06 | $0.383280 | $0.4922 | -22.1% | $0.420613 | $0.71 | 40.8% | $723 | 35% / $500 | meets | $0.6300 | +12.7% | — | — | — |
| 4x5x2 | 5,000 | OWNER APPROVED 2026-10-06 | $0.254793 | $0.4033 | -36.8% | $0.273460 | $0.46 | 40.6% | $933 | 38% / $500 | meets | $0.4200 | +9.5% | — | — | — |
| 4x5x2 | 10,000 | OWNER APPROVED 2026-10-06 | $0.211286 | $0.3232 | -34.6% | $0.220619 | $0.37 | 40.4% | $1494 | 38% / $500 | meets | $0.3150 | +17.5% | — | — | — |
| 4x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.174687 | $0.3232 | -46.0% | $0.178420 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2878 38.0% / $2734 | $0.2974 40.0% / $2974 |
| 5x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.449195 | — | — | $1.635862 | — | — | — | 30% / $500 | — | — | — | — | $2.3369 30.0% / $351 <$500 | $2.7264 40.0% / $545 |
| 5x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.809625 | — | — | $0.902958 | — | — | — | 30% / $500 | — | $1.0500 | — | — | $1.2899 30.0% / $387 <$500 | $1.5049 40.0% / $602 |
| 5x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.416286 | — | — | $0.453619 | — | — | — | 35% / $500 | — | $0.6300 | — | — | $0.6979 35.0% / $611 | $0.7560 40.0% / $756 |
| 5x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.284631 | — | — | $0.303298 | — | — | — | 38% / $500 | — | $0.4200 | — | — | $0.4892 38.0% / $929 | $0.5055 40.0% / $1011 |
| 5x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.244684 | — | — | $0.254017 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.4097 38.0% / $1557 | $0.4234 40.0% / $1693 |
| 5x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.207716 | — | — | $0.211449 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.3410 38.0% / $3240 | $0.3524 40.0% / $3524 |
| 6x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.499955 | — | — | $1.686622 | — | — | — | 30% / $500 | — | — | — | — | $2.4095 30.0% / $361 <$500 | $2.8110 40.0% / $562 |
| 6x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.848948 | $1.1048 | -23.2% | $0.942281 | $1.84 | 48.8% | $898 | 30% / $500 | meets | $1.0500 | — | $1.8400 48.8% / $898 | $1.4471 34.9% / $505 | $1.6435 42.7% / $701 |
| 6x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.446988 | $0.5864 | -23.8% | $0.484321 | $1.04 | 53.4% | $1389 | 35% / $500 | meets | $0.6300 | — | $1.0400 53.4% / $1389 | $0.8075 40.0% / $808 | $0.9238 47.6% / $1099 |
| 6x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.315357 | $0.5290 | -40.4% | $0.334024 | $0.96 | 65.2% | $3130 | 38% / $500 | meets | $0.4200 | — | $0.9600 65.2% / $3130 | $0.5855 43.0% / $1257 | $0.7728 56.8% / $2194 |
| 6x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.275754 | $0.4341 | -36.5% | $0.285087 | $0.81 | 64.8% | $5249 | 38% / $500 | meets | $0.3150 | — | $0.8100 64.8% / $5249 | $0.5208 45.3% / $2357 | $0.6654 57.2% / $3803 |
| 6x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.239143 | $0.4341 | -44.9% | $0.242877 | $0.81 | 70.0% | $14178 | 38% / $500 | meets | $0.3150 | — | $0.8100 70.0% / $14178 | $0.4493 45.9% / $5161 | $0.6297 61.4% / $9670 |
| 8x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.618515 | — | — | $1.805182 | — | — | — | 30% / $500 | — | — | — | — | $2.5788 30.0% / $387 <$500 | $3.0086 40.0% / $602 |
| 8x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.940838 | $1.2418 | -24.2% | $1.034171 | $2.05 | 49.6% | $1016 | 30% / $500 | meets | $1.0500 | — | $2.0500 49.6% / $1016 | $1.5879 34.9% / $554 | $1.8189 43.1% / $785 |
| 8x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.518730 | $0.6991 | -25.8% | $0.556063 | $1.23 | 54.8% | $1685 | 35% / $500 | meets | $0.6300 | — | $1.2300 54.8% / $1685 | $0.9287 40.1% / $932 | $1.0794 48.5% / $1308 |
| 8x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.381188 | $0.6799 | -43.9% | $0.399854 | $1.23 | 67.5% | $4151 | 38% / $500 | meets | $0.4200 | — | $1.2300 67.5% / $4151 | $0.7040 43.2% / $1521 | $0.9670 58.7% / $2836 |
| 8x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.350652 | $0.5674 | -38.2% | $0.359985 | $1.05 | 65.7% | $6900 | 38% / $500 | meets | $0.3150 | — | $1.0500 65.7% / $6900 | $0.6554 45.1% / $2954 | $0.8527 57.8% / $4927 |
| 8x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.313086 | $0.5674 | -44.8% | $0.316819 | $1.05 | 69.8% | $18330 | 38% / $500 | meets | $0.3150 | — | $1.0500 69.8% / $18330 | $0.5825 45.6% / $6641 | $0.8162 61.2% / $12485 |

### Lowest-cost configuration (Glossy)
| size | qty | ladder status | vendor unit (live) | old seed unit | change | landed unit | current sell | current GM | current GP | floor / GP target | protection | D&C comparable CR | GSO premium | A hold price GM/GP | B pass-through sell GM/GP | C split sell GM/GP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3.5x4.5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.334640 | — | — | $1.521307 | — | — | — | 30% / $500 | — | — | — | — | $2.1733 30.0% / $326 <$500 | $2.5355 40.0% / $507 |
| 3.5x4.5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.720833 | — | — | $0.814166 | — | — | — | 30% / $500 | — | $1.0500 | — | — | $1.1631 30.0% / $349 <$500 | $1.3569 40.0% / $543 |
| 3.5x4.5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.347013 | — | — | $0.384346 | — | — | — | 35% / $500 | — | $0.6300 | — | — | $0.5913 35.0% / $517 | $0.6406 40.0% / $641 |
| 3.5x4.5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.222003 | — | — | $0.240670 | — | — | — | 38% / $500 | — | $0.4200 | — | — | $0.3882 38.0% / $738 | $0.4011 40.0% / $802 |
| 3.5x4.5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.174490 | — | — | $0.183823 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2965 38.0% / $1127 | $0.3064 40.0% / $1225 |
| 3.5x4.5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.137904 | — | — | $0.141638 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2284 38.0% / $2170 | $0.2361 40.0% / $2361 |
| 4x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.355025 | — | — | $1.541692 | — | — | — | 30% / $500 | — | — | — | — | $2.2024 30.0% / $330 <$500 | $2.5695 40.0% / $514 |
| 4x5x2 | 1,000 | OWNER APPROVED 2026-10-06 | $0.736613 | $0.9897 | -25.6% | $0.829946 | $1.30 | 36.2% | $470 | 30% / $350 | meets | $1.0500 | +23.8% | — | — | — |
| 4x5x2 | 2,500 | OWNER APPROVED 2026-10-06 | $0.359313 | $0.4922 | -27.0% | $0.396646 | $0.71 | 44.1% | $783 | 35% / $500 | meets | $0.6300 | +12.7% | — | — | — |
| 4x5x2 | 5,000 | OWNER APPROVED 2026-10-06 | $0.233136 | $0.4033 | -42.2% | $0.251803 | $0.46 | 45.3% | $1041 | 38% / $500 | meets | $0.4200 | +9.5% | — | — | — |
| 4x5x2 | 10,000 | OWNER APPROVED 2026-10-06 | $0.186929 | $0.3232 | -42.2% | $0.196263 | $0.37 | 47.0% | $1737 | 38% / $500 | meets | $0.3150 | +17.5% | — | — | — |
| 4x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.150578 | $0.3232 | -53.4% | $0.154311 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2489 38.0% / $2364 | $0.2572 40.0% / $2572 |
| 5x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.400190 | — | — | $1.586857 | — | — | — | 30% / $500 | — | — | — | — | $2.2669 30.0% / $340 <$500 | $2.6448 40.0% / $529 |
| 5x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.771645 | — | — | $0.864978 | — | — | — | 30% / $500 | — | $1.0500 | — | — | $1.2357 30.0% / $371 <$500 | $1.4416 40.0% / $577 |
| 5x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.386685 | — | — | $0.424018 | — | — | — | 35% / $500 | — | $0.6300 | — | — | $0.6523 35.0% / $571 | $0.7067 40.0% / $707 |
| 5x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.257883 | — | — | $0.276550 | — | — | — | 38% / $500 | — | $0.4200 | — | — | $0.4460 38.0% / $847 | $0.4609 40.0% / $922 |
| 5x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.214603 | — | — | $0.223936 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.3612 38.0% / $1373 | $0.3732 40.0% / $1493 |
| 5x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.177939 | — | — | $0.181672 | — | — | — | 38% / $500 | — | $0.3150 | — | — | $0.2930 38.0% / $2784 | $0.3028 40.0% / $3028 |
| 6x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.441620 | — | — | $1.628287 | — | — | — | 30% / $500 | — | — | — | — | $2.3261 30.0% / $349 <$500 | $2.7138 40.0% / $543 |
| 6x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.803745 | $1.1048 | -27.3% | $0.897078 | $1.84 | 51.2% | $943 | 30% / $500 | meets | $1.0500 | — | $1.8400 51.2% / $943 | $1.3777 34.9% / $481 <$500 | $1.6088 44.2% / $712 |
| 6x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.411756 | $0.5864 | -29.8% | $0.449089 | $1.04 | 56.8% | $1477 | 35% / $500 | meets | $0.6300 | — | $1.0400 56.8% / $1477 | $0.7488 40.0% / $749 | $0.8944 49.8% / $1113 |
| 6x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.283043 | $0.5290 | -46.5% | $0.301709 | $0.96 | 68.6% | $3291 | 38% / $500 | meets | $0.4200 | — | $0.9600 68.6% / $3291 | $0.5289 43.0% / $1136 | $0.7444 59.5% / $2214 |
| 6x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.239946 | $0.4341 | -44.7% | $0.249279 | $0.81 | 69.2% | $5607 | 38% / $500 | meets | $0.3150 | — | $0.8100 69.2% / $5607 | $0.4553 45.3% / $2061 | $0.6327 60.6% / $3834 |
| 6x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.203582 | $0.4341 | -53.1% | $0.207316 | $0.81 | 74.4% | $15067 | 38% / $500 | meets | $0.3150 | — | $0.8100 74.4% / $15067 | $0.3835 45.9% / $4406 | $0.5968 65.3% / $9736 |
| 8x5x2 | 500 | OWNER PRICING REVIEW REQUIRED | $1.541520 | — | — | $1.728187 | — | — | — | 30% / $500 | — | — | — | — | $2.4688 30.0% / $370 <$500 | $2.8803 40.0% / $576 |
| 8x5x2 | 1,000 | OWNER PRICING REVIEW REQUIRED | $0.881168 | $1.2418 | -29.0% | $0.974501 | $2.05 | 52.5% | $1076 | 30% / $500 | meets | $1.0500 | — | $2.0500 52.5% / $1076 | $1.4963 34.9% / $522 | $1.7731 45.0% / $799 |
| 8x5x2 | 2,500 | OWNER PRICING REVIEW REQUIRED | $0.472224 | $0.6991 | -32.5% | $0.509557 | $1.23 | 58.6% | $1801 | 35% / $500 | meets | $0.6300 | — | $1.2300 58.6% / $1801 | $0.8511 40.1% / $854 | $1.0405 51.0% / $1327 |
| 8x5x2 | 5,000 | OWNER PRICING REVIEW REQUIRED | $0.338536 | $0.6799 | -50.2% | $0.357203 | $1.23 | 71.0% | $4364 | 38% / $500 | meets | $0.4200 | — | $1.2300 71.0% / $4364 | $0.6289 43.2% / $1359 | $0.9295 61.6% / $2861 |
| 8x5x2 | 10,000 | OWNER PRICING REVIEW REQUIRED | $0.303024 | $0.5674 | -46.6% | $0.312357 | $1.05 | 70.3% | $7376 | 38% / $500 | meets | $0.3150 | — | $1.0500 70.3% / $7376 | $0.5687 45.1% / $2563 | $0.8093 61.4% / $4970 |
| 8x5x2 | 25,000 | OWNER PRICING REVIEW REQUIRED | $0.265846 | $0.5674 | -53.1% | $0.269579 | $1.05 | 74.3% | $19511 | 38% / $500 | meets | $0.3150 | — | $1.0500 74.3% / $19511 | $0.4956 45.6% / $5651 | $0.7728 65.1% / $12581 |

### Shaped equivalents

Shaped = the standard sell price +10% (product), plus $700 tooling as a separate line for a new die ($0 on reuse); shaped MOQ 2,500. Example 4x5x2 x 2,500 at the approved $0.71: shaped unit $0.781 (before customer-facing rounding), product $1,952.50 + $700 tooling = $2,652.50 (reorder on the same die: $1,952.50).
