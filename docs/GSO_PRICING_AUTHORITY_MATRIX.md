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
| DTP pouches (Spektra, standard shape) | landed = vendor tier cost (VendorProduct tiers, 15C seed) + GSO art per design + **$85 freight (UNVERIFIED ASSUMPTION)**; NEW: `spektra-live-cost-book` (2026-10-06, 25% off exact public total) — **no observed rows loaded yet** | legacy tiers OWNER-VERIFIED 15C; live book VENDOR OBSERVED DATA (pending CSV) | owner DTP sell ladders (2026-07-24) + hard floors + min job profit | OWNER-APPROVED | freight; ladders for 3.5x4.5x2 and 5x5x2; 5x4x2 legacy; MOQ 1,000 retained |
| DTP pouches (custom shape) | same as standard shape | same | standard price **+10%** shape surcharge; **$700** per unique new die, separate line; $0 on reuse | OWNER-APPROVED COMMERCIAL RULE (2026-10-06) | durable Die ID registry (schema) |
| Boxes | legacy / manual | — | legacy / manual | — | out of scope |

## Final proposed standard DTP sell tables

**NOT PRODUCED.** The live Spektra price matrix (`SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv`) and the market-pricing master document are not in the repository, so vendor unit, landed unit, recommended sell, GM, GP and market position cannot be computed honestly for 3.5x4.5x2 / 4x5x2 / 5x5x2 / 6x5x2 / 8x5x2 at 500 / 1000 / 2500 / 5000 / 10000 / 25000. The current owner ladders (4x5x2 $1.67 / $0.88 / $0.74 / $0.61 / $0.60 at 1,000 / 2,500 / 5,000 / 7,500 / 10,000; 5x4x2 $1.76 / $0.97 / $0.86 / $0.72 / $0.71; 6x5x2 $1.84 / $1.04 / $0.96 / $0.81 / $0.81; 8x5x2 $2.05 / $1.23 / $1.23 / $1.05 / $1.05) remain in force unchanged. Shaped equivalents = those prices +10% with $700 tooling shown separately.

The table template the test suite and Pricing Intelligence are ready to fill once rows exist: vendor unit (wholesale = public x 0.75 / qty), extra-SKU cost, freight assumption, internal art ($8.3333 per design), landed unit, current sell, current GM / GP, market reference, recommended sell, recommended GM / GP, commercial position (including "MARKET BELOW CURRENT VENDOR ECONOMICS" where applicable).
