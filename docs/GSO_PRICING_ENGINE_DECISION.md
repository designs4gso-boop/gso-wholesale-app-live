# GSO pricing engines — which cost should the storefront price bags and stickers from?

**Date:** 2026-11-20. **For:** James (owner decision). **Nothing was changed.** No price, no timing, no formula, no setting and no existing file was touched to produce this. It is a comparison only.

## The short version

Stock Bags, Sticker Bags and stickers are costed two different ways today:

- **Engine A — the storefront.** The older cost model. This is what the website and checkout price from right now.
- **Engine B — the Cost Calculator.** The newer "true cost" model you see in the Cost & Pricing Calculator.

Both hand their cost to the **same** price rules (market targets, specialty tiers, margin bands, the 40% floor). So the two only produce a different price where the price is worked out from cost.

What the comparison found (168 configurations, quantities 50 to 2,500):

1. **Plain matte bags: no difference at all.** All 24 matte, no-gloss rows (both bag families) give the identical price on either engine, because your market target sets the price, not the cost.
2. **Specialty bags at volume would go UP on Engine B, not down.** 10 of 48 configurations per bag family move, every one upward, from +$24 to +$1,625 per order. Engine B charges much more for white ink, gloss ink and press time than Engine A does.
3. **Stickers move both ways.** 55 of 72 sticker configurations change: 20 small orders get cheaper (-$2 to -$34), 35 larger or specialty orders get dearer (+$2.50 to +$725).
4. **The example in the readiness audit pointed the wrong way.** It said the storefront price for 1,000 holographic 3X double-sided sticker bags is "about $75 higher" than the calculator basis. That looked at application labour alone. With every cost line included, Engine B costs that job **$1,707 against $1,318** and would price it at **$2,850 against today's $2,200** — $650 higher, not $75 lower.

Headline rows:

| Product | Configuration | Qty | A cost | B cost | Live price (A) | Price on B | Change |
|---|---|---:|---:|---:|---:|---:|---:|
| Stock Bag | Matte, no gloss, double sided | 1,000 | $533.38 | $507.43 | $1,450.00 | $1,450.00 | none |
| Stock Bag | Matte, 3X gloss, double sided | 1,000 | $1,057.93 | $1,187.76 | $1,860.00 | $1,980.00 | +$120.00 |
| Sticker Bag | Holographic, 3X gloss, double sided | 1,000 | $1,318.03 | $1,707.39 | $2,200.00 | $2,850.00 | +$650.00 |
| Sticker | 3x3 in, Matte, no gloss | 50 | $19.71 | $15.84 | $56.50 | $45.50 | -$11.00 |
| Sticker | 3x3 in, Holographic, 3X gloss | 1,000 | $255.83 | $346.91 | $430.00 | $580.00 | +$150.00 |

## How to read the tables

- **A cost / B cost** — what each engine says the whole order costs to make.
- **A price (live)** — what the storefront charges today.
- **B price** — what the storefront would charge if it used Engine B's cost with the same price rules. Nobody is charged this today.
- **Price change** — B price minus A price, for the whole order.
- **A margin / B margin** — each price measured against its own engine's cost. **Margin change** is the difference in points.
- **Live price on B cost** — today's live price measured against Engine B's cost. If Engine B is the truer cost, this is the margin those orders really earn today.
- **What sets the price** — the rule that wins. "market target" and "specialty tier" are your fixed prices; "40% cost floor" and "cost + N% margin" follow cost.

The numbers come from `tests/pricing-engine-comparison-2026-11-20.test.ts`. See "Limits of this comparison" near the end before relying on any single figure.

## Stock Bags (4x5)

38 of 48 configurations are unchanged. The 10 that move all move up.

| Configuration | Qty | A cost | B cost | A price (live) | B price | Price change | A margin | B margin | Margin change | Live price on B cost | What sets the price (A → B) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Matte, 0X, single | 50 | $31.38 | $19.33 | $107.50 | $107.50 | none | 70.8% | 82.0% | +11.2 pts | 82.0% | market target |
| Matte, 0X, single | 100 | $44.89 | $34.33 | $130.00 | $130.00 | none | 65.5% | 73.6% | +8.1 pts | 73.6% | market target |
| Matte, 0X, single | 250 | $91.97 | $80.66 | $287.50 | $287.50 | none | 68.0% | 71.9% | +3.9 pts | 71.9% | market target |
| Matte, 0X, single | 500 | $172.61 | $157.40 | $525.00 | $525.00 | none | 67.1% | 70.0% | +2.9 pts | 70.0% | market target |
| Matte, 0X, single | 1000 | $327.36 | $310.88 | $1050.00 | $1050.00 | none | 68.8% | 70.4% | +1.6 pts | 70.4% | market target |
| Matte, 0X, single | 2500 | $808.66 | $770.50 | $2375.00 | $2375.00 | none | 66.0% | 67.6% | +1.6 pts | 67.6% | market target |
| Matte, 0X, double | 50 | $39.39 | $28.83 | $135.00 | $135.00 | none | 70.8% | 78.6% | +7.8 pts | 78.6% | market target |
| Matte, 0X, double | 100 | $67.46 | $54.66 | $180.00 | $180.00 | none | 62.5% | 69.6% | +7.1 pts | 69.6% | market target |
| Matte, 0X, double | 250 | $145.11 | $129.90 | $407.50 | $407.50 | none | 64.4% | 68.1% | +3.7 pts | 68.1% | market target |
| Matte, 0X, double | 500 | $272.36 | $255.88 | $750.00 | $750.00 | none | 63.7% | 65.9% | +2.2 pts | 65.9% | market target |
| Matte, 0X, double | 1000 | $533.38 | $507.43 | $1450.00 | $1450.00 | none | 63.2% | 65.0% | +1.8 pts | 65.0% | market target |
| Matte, 0X, double | 2500 | $1320.46 | $1262.08 | $3300.00 | $3300.00 | none | 60.0% | 61.8% | +1.8 pts | 61.8% | market target |
| Matte, 3X, single | 50 | $50.59 | $36.42 | $142.50 | $142.50 | none | 64.5% | 74.4% | +9.9 pts | 74.4% | specialty tier |
| Matte, 3X, single | 100 | $77.06 | $68.50 | $166.00 | $166.00 | none | 53.6% | 58.7% | +5.2 pts | 58.7% | specialty tier |
| Matte, 3X, single | 250 | $163.01 | $166.08 | $367.50 | $367.50 | none | 55.6% | 54.8% | -0.8 pts | 54.8% | specialty tier |
| Matte, 3X, single | 500 | $308.43 | $327.73 | $670.00 | $670.00 | none | 54.0% | 51.1% | -2.9 pts | 51.1% | specialty tier |
| Matte, 3X, single | 1000 | $592.76 | $651.05 | $1340.00 | $1340.00 | none | 55.8% | 51.4% | -4.4 pts | 51.4% | specialty tier |
| Matte, 3X, single | 2500 | $1462.78 | $1621.16 | $3050.00 | $3050.00 | none | 52.0% | 46.8% | -5.2 pts | 46.8% | specialty tier |
| Matte, 3X, double | 50 | $71.56 | $63.00 | $173.00 | $173.00 | none | 58.6% | 63.6% | +4.9 pts | 63.6% | specialty tier |
| Matte, 3X, double | 100 | $125.54 | $122.99 | $230.00 | $230.00 | none | 45.4% | 46.5% | +1.1 pts | 46.5% | specialty tier |
| Matte, 3X, double | 250 | $280.93 | $300.23 | $522.50 | $522.50 | none | 46.2% | 42.5% | -3.7 pts | 42.5% | specialty tier |
| Matte, 3X, double | 500 | $537.76 | $596.05 | $960.00 | $995.00 | +35.00 | 44.0% | 40.1% | -3.9 pts | 37.9% | specialty tier → 40% cost floor |
| Matte, 3X, double | 1000 | $1057.93 | $1187.76 | $1860.00 | $1980.00 | +120.00 | 43.1% | 40.0% | -3.1 pts | 36.1% | specialty tier → 40% cost floor |
| Matte, 3X, double | 2500 | $2622.44 | $2962.90 | $4375.00 | $4950.00 | +575.00 | 40.1% | 40.1% | +0.1 pts | 32.3% | 40% cost floor |
| Holographic, 0X, single | 50 | $38.07 | $32.08 | $129.00 | $129.00 | none | 70.5% | 75.1% | +4.6 pts | 75.1% | specialty tier |
| Holographic, 0X, single | 100 | $58.28 | $58.74 | $156.00 | $156.00 | none | 62.6% | 62.3% | -0.3 pts | 62.3% | specialty tier |
| Holographic, 0X, single | 250 | $125.45 | $138.98 | $345.00 | $345.00 | none | 63.6% | 59.7% | -3.9 pts | 59.7% | specialty tier |
| Holographic, 0X, single | 500 | $239.56 | $274.97 | $630.00 | $630.00 | none | 62.0% | 56.4% | -5.6 pts | 56.4% | specialty tier |
| Holographic, 0X, single | 1000 | $461.25 | $546.94 | $1260.00 | $1260.00 | none | 63.4% | 56.6% | -6.8 pts | 56.6% | specialty tier |
| Holographic, 0X, single | 2500 | $1143.39 | $1361.04 | $2850.00 | $2850.00 | none | 59.9% | 52.2% | -7.6 pts | 52.2% | specialty tier |
| Holographic, 0X, double | 50 | $52.78 | $53.24 | $162.00 | $162.00 | none | 67.4% | 67.1% | -0.3 pts | 67.1% | specialty tier |
| Holographic, 0X, double | 100 | $94.23 | $101.68 | $216.00 | $216.00 | none | 56.4% | 52.9% | -3.4 pts | 52.9% | specialty tier |
| Holographic, 0X, double | 250 | $212.06 | $247.47 | $490.00 | $490.00 | none | 56.7% | 49.5% | -7.2 pts | 49.5% | specialty tier |
| Holographic, 0X, double | 500 | $406.25 | $491.94 | $900.00 | $900.00 | none | 54.9% | 45.3% | -9.5 pts | 45.3% | specialty tier |
| Holographic, 0X, double | 1000 | $801.17 | $979.08 | $1740.00 | $1740.00 | none | 54.0% | 43.7% | -10.2 pts | 43.7% | specialty tier |
| Holographic, 0X, double | 2500 | $1989.92 | $2440.96 | $3950.00 | $4075.00 | +125.00 | 49.6% | 40.1% | -9.5 pts | 38.2% | specialty tier → 40% cost floor |
| Holographic, 3X, single | 50 | $57.09 | $50.44 | $159.00 | $159.00 | none | 64.1% | 68.3% | +4.2 pts | 68.3% | specialty tier |
| Holographic, 3X, single | 100 | $90.06 | $95.12 | $192.00 | $192.00 | none | 53.1% | 50.5% | -2.6 pts | 50.5% | specialty tier |
| Holographic, 3X, single | 250 | $195.52 | $229.05 | $425.00 | $425.00 | none | 54.0% | 46.1% | -7.9 pts | 46.1% | specialty tier |
| Holographic, 3X, single | 500 | $373.46 | $455.11 | $775.00 | $775.00 | none | 51.8% | 41.3% | -10.5 pts | 41.3% | specialty tier |
| Holographic, 3X, single | 1000 | $722.81 | $907.22 | $1550.00 | $1550.00 | none | 53.4% | 41.5% | -11.9 pts | 41.5% | specialty tier |
| Holographic, 3X, single | 2500 | $1787.90 | $2261.16 | $3525.00 | $3775.00 | +250.00 | 49.3% | 40.1% | -9.2 pts | 35.9% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 50 | $84.56 | $89.62 | $200.00 | $200.00 | none | 57.7% | 55.2% | -2.5 pts | 55.2% | specialty tier |
| Holographic, 3X, double | 100 | $151.55 | $173.85 | $266.00 | $290.00 | +24.00 | 43.0% | 40.1% | -3.0 pts | 34.6% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 250 | $345.96 | $427.61 | $602.50 | $712.50 | +110.00 | 42.6% | 40.0% | -2.6 pts | 29.0% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 500 | $667.81 | $852.22 | $1115.00 | $1420.00 | +305.00 | 40.1% | 40.0% | -0.1 pts | 23.6% | 40% cost floor |
| Holographic, 3X, double | 1000 | $1318.03 | $1699.05 | $2200.00 | $2830.00 | +630.00 | 40.1% | 40.0% | -0.1 pts | 22.8% | 40% cost floor |
| Holographic, 3X, double | 2500 | $3272.69 | $4240.61 | $5450.00 | $7075.00 | +1625.00 | 40.0% | 40.1% | +0.1 pts | 22.2% | 40% cost floor |

## Sticker Bags (custom 4x5)

Engine A costs a Sticker Bag exactly like a Stock Bag (one shared engine). Engine B adds one $8.33 art setup for the customer's design, which a Stock Bag does not carry. 38 of 48 configurations are unchanged; the 10 that move all move up.

| Configuration | Qty | A cost | B cost | A price (live) | B price | Price change | A margin | B margin | Margin change | Live price on B cost | What sets the price (A → B) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Matte, 0X, single | 50 | $31.38 | $27.67 | $107.50 | $107.50 | none | 70.8% | 74.3% | +3.5 pts | 74.3% | market target |
| Matte, 0X, single | 100 | $44.89 | $42.66 | $130.00 | $130.00 | none | 65.5% | 67.2% | +1.7 pts | 67.2% | market target |
| Matte, 0X, single | 250 | $91.97 | $88.99 | $287.50 | $287.50 | none | 68.0% | 69.0% | +1.0 pts | 69.0% | market target |
| Matte, 0X, single | 500 | $172.61 | $165.73 | $525.00 | $525.00 | none | 67.1% | 68.4% | +1.3 pts | 68.4% | market target |
| Matte, 0X, single | 1000 | $327.36 | $319.22 | $1050.00 | $1050.00 | none | 68.8% | 69.6% | +0.8 pts | 69.6% | market target |
| Matte, 0X, single | 2500 | $808.66 | $778.83 | $2375.00 | $2375.00 | none | 66.0% | 67.2% | +1.3 pts | 67.2% | market target |
| Matte, 0X, double | 50 | $39.39 | $37.16 | $135.00 | $135.00 | none | 70.8% | 72.5% | +1.7 pts | 72.5% | market target |
| Matte, 0X, double | 100 | $67.46 | $62.99 | $180.00 | $180.00 | none | 62.5% | 65.0% | +2.5 pts | 65.0% | market target |
| Matte, 0X, double | 250 | $145.11 | $138.23 | $407.50 | $407.50 | none | 64.4% | 66.1% | +1.7 pts | 66.1% | market target |
| Matte, 0X, double | 500 | $272.36 | $264.22 | $750.00 | $750.00 | none | 63.7% | 64.8% | +1.1 pts | 64.8% | market target |
| Matte, 0X, double | 1000 | $533.38 | $515.77 | $1450.00 | $1450.00 | none | 63.2% | 64.4% | +1.2 pts | 64.4% | market target |
| Matte, 0X, double | 2500 | $1320.46 | $1270.41 | $3300.00 | $3300.00 | none | 60.0% | 61.5% | +1.5 pts | 61.5% | market target |
| Matte, 3X, single | 50 | $50.59 | $44.75 | $142.50 | $142.50 | none | 64.5% | 68.6% | +4.1 pts | 68.6% | specialty tier |
| Matte, 3X, single | 100 | $77.06 | $76.83 | $166.00 | $166.00 | none | 53.6% | 53.7% | +0.1 pts | 53.7% | specialty tier |
| Matte, 3X, single | 250 | $163.01 | $174.41 | $367.50 | $367.50 | none | 55.6% | 52.5% | -3.1 pts | 52.5% | specialty tier |
| Matte, 3X, single | 500 | $308.43 | $336.07 | $670.00 | $670.00 | none | 54.0% | 49.8% | -4.1 pts | 49.8% | specialty tier |
| Matte, 3X, single | 1000 | $592.76 | $659.38 | $1340.00 | $1340.00 | none | 55.8% | 50.8% | -5.0 pts | 50.8% | specialty tier |
| Matte, 3X, single | 2500 | $1462.78 | $1629.49 | $3050.00 | $3050.00 | none | 52.0% | 46.6% | -5.5 pts | 46.6% | specialty tier |
| Matte, 3X, double | 50 | $71.56 | $71.33 | $173.00 | $173.00 | none | 58.6% | 58.8% | +0.1 pts | 58.8% | specialty tier |
| Matte, 3X, double | 100 | $125.54 | $131.33 | $230.00 | $230.00 | none | 45.4% | 42.9% | -2.5 pts | 42.9% | specialty tier |
| Matte, 3X, double | 250 | $280.93 | $308.57 | $522.50 | $522.50 | none | 46.2% | 40.9% | -5.3 pts | 40.9% | specialty tier |
| Matte, 3X, double | 500 | $537.76 | $604.38 | $960.00 | $1005.00 | +45.00 | 44.0% | 39.9% | -4.1 pts | 37.0% | specialty tier → 40% cost floor |
| Matte, 3X, double | 1000 | $1057.93 | $1196.09 | $1860.00 | $1990.00 | +130.00 | 43.1% | 39.9% | -3.2 pts | 35.7% | specialty tier → 40% cost floor |
| Matte, 3X, double | 2500 | $2622.44 | $2971.23 | $4375.00 | $4950.00 | +575.00 | 40.1% | 40.0% | -0.1 pts | 32.1% | 40% cost floor |
| Holographic, 0X, single | 50 | $38.07 | $40.41 | $129.00 | $129.00 | none | 70.5% | 68.7% | -1.8 pts | 68.7% | specialty tier |
| Holographic, 0X, single | 100 | $58.28 | $67.07 | $156.00 | $156.00 | none | 62.6% | 57.0% | -5.6 pts | 57.0% | specialty tier |
| Holographic, 0X, single | 250 | $125.45 | $147.32 | $345.00 | $345.00 | none | 63.6% | 57.3% | -6.3 pts | 57.3% | specialty tier |
| Holographic, 0X, single | 500 | $239.56 | $283.30 | $630.00 | $630.00 | none | 62.0% | 55.0% | -6.9 pts | 55.0% | specialty tier |
| Holographic, 0X, single | 1000 | $461.25 | $555.27 | $1260.00 | $1260.00 | none | 63.4% | 55.9% | -7.5 pts | 55.9% | specialty tier |
| Holographic, 0X, single | 2500 | $1143.39 | $1369.38 | $2850.00 | $2850.00 | none | 59.9% | 52.0% | -7.9 pts | 52.0% | specialty tier |
| Holographic, 0X, double | 50 | $52.78 | $61.57 | $162.00 | $162.00 | none | 67.4% | 62.0% | -5.4 pts | 62.0% | specialty tier |
| Holographic, 0X, double | 100 | $94.23 | $110.01 | $216.00 | $216.00 | none | 56.4% | 49.1% | -7.3 pts | 49.1% | specialty tier |
| Holographic, 0X, double | 250 | $212.06 | $255.80 | $490.00 | $490.00 | none | 56.7% | 47.8% | -8.9 pts | 47.8% | specialty tier |
| Holographic, 0X, double | 500 | $406.25 | $500.27 | $900.00 | $900.00 | none | 54.9% | 44.4% | -10.4 pts | 44.4% | specialty tier |
| Holographic, 0X, double | 1000 | $801.17 | $987.41 | $1740.00 | $1740.00 | none | 54.0% | 43.3% | -10.7 pts | 43.3% | specialty tier |
| Holographic, 0X, double | 2500 | $1989.92 | $2449.29 | $3950.00 | $4075.00 | +125.00 | 49.6% | 39.9% | -9.7 pts | 38.0% | specialty tier → 40% cost floor |
| Holographic, 3X, single | 50 | $57.09 | $58.77 | $159.00 | $159.00 | none | 64.1% | 63.0% | -1.1 pts | 63.0% | specialty tier |
| Holographic, 3X, single | 100 | $90.06 | $103.45 | $192.00 | $192.00 | none | 53.1% | 46.1% | -7.0 pts | 46.1% | specialty tier |
| Holographic, 3X, single | 250 | $195.52 | $237.39 | $425.00 | $425.00 | none | 54.0% | 44.1% | -9.9 pts | 44.1% | specialty tier |
| Holographic, 3X, single | 500 | $373.46 | $463.44 | $775.00 | $775.00 | none | 51.8% | 40.2% | -11.6 pts | 40.2% | specialty tier |
| Holographic, 3X, single | 1000 | $722.81 | $915.55 | $1550.00 | $1550.00 | none | 53.4% | 40.9% | -12.4 pts | 40.9% | specialty tier |
| Holographic, 3X, single | 2500 | $1787.90 | $2269.50 | $3525.00 | $3775.00 | +250.00 | 49.3% | 39.9% | -9.4 pts | 35.6% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 50 | $84.56 | $97.95 | $200.00 | $200.00 | none | 57.7% | 51.0% | -6.7 pts | 51.0% | specialty tier |
| Holographic, 3X, double | 100 | $151.55 | $182.19 | $266.00 | $304.00 | +38.00 | 43.0% | 40.1% | -3.0 pts | 31.5% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 250 | $345.96 | $435.94 | $602.50 | $727.50 | +125.00 | 42.6% | 40.1% | -2.5 pts | 27.6% | specialty tier → 40% cost floor |
| Holographic, 3X, double | 500 | $667.81 | $860.55 | $1115.00 | $1435.00 | +320.00 | 40.1% | 40.0% | -0.1 pts | 22.8% | 40% cost floor |
| Holographic, 3X, double | 1000 | $1318.03 | $1707.39 | $2200.00 | $2850.00 | +650.00 | 40.1% | 40.1% | +0.0 pts | 22.4% | 40% cost floor |
| Holographic, 3X, double | 2500 | $3272.69 | $4248.94 | $5450.00 | $7075.00 | +1625.00 | 40.0% | 39.9% | -0.0 pts | 22.0% | 40% cost floor |

## Stickers (square / rectangle, one design)

17 of 72 configurations are unchanged, 20 go down and 35 go up. Stickers have no fixed market target, so cost reaches the price far more often than it does on bags. Die-cut stickers are not in this table (see "Limits").

| Configuration | Qty | A cost | B cost | A price (live) | B price | Price change | A margin | B margin | Margin change | Live price on B cost | What sets the price (A → B) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2x2 in, Matte, 0X | 50 | $18.69 | $14.19 | $53.50 | $40.50 | -13.00 | 65.1% | 65.0% | -0.1 pts | 73.5% | cost + 65% margin |
| 2x2 in, Matte, 0X | 100 | $19.51 | $15.70 | $56.00 | $45.00 | -11.00 | 65.2% | 65.1% | -0.0 pts | 72.0% | cost + 65% margin |
| 2x2 in, Matte, 0X | 250 | $21.97 | $20.26 | $65.00 | $65.00 | none | 66.2% | 68.8% | +2.6 pts | 68.8% | area floor |
| 2x2 in, Matte, 0X | 500 | $26.08 | $27.86 | $100.00 | $100.00 | none | 73.9% | 72.1% | -1.8 pts | 72.1% | area floor |
| 2x2 in, Matte, 0X | 1000 | $40.83 | $44.01 | $140.00 | $140.00 | none | 70.8% | 68.6% | -2.3 pts | 68.6% | area floor |
| 2x2 in, Matte, 0X | 2500 | $78.55 | $91.51 | $225.00 | $225.00 | none | 65.1% | 59.3% | -5.8 pts | 59.3% | area floor |
| 2x2 in, Matte, 3X | 50 | $27.53 | $17.57 | $78.50 | $50.00 | -28.50 | 64.9% | 64.9% | -0.1 pts | 77.6% | cost + 65% margin |
| 2x2 in, Matte, 3X | 100 | $30.94 | $22.47 | $88.00 | $64.00 | -24.00 | 64.8% | 64.9% | +0.0 pts | 74.5% | cost + 65% margin |
| 2x2 in, Matte, 3X | 250 | $41.18 | $37.19 | $97.50 | $87.50 | -10.00 | 57.8% | 57.5% | -0.3 pts | 61.9% | cost + 58% margin |
| 2x2 in, Matte, 3X | 500 | $58.25 | $61.70 | $120.00 | $130.00 | +10.00 | 51.5% | 52.5% | +1.1 pts | 48.6% | cost + 52% margin |
| 2x2 in, Matte, 3X | 1000 | $98.91 | $111.51 | $160.00 | $190.00 | +30.00 | 38.2% | 41.3% | +3.1 pts | 30.3% | cost + 40% margin |
| 2x2 in, Matte, 3X | 2500 | $214.37 | $260.15 | $350.00 | $425.00 | +75.00 | 38.8% | 38.8% | +0.0 pts | 25.7% | cost + 40% margin |
| 2x2 in, Holographic, 0X | 50 | $20.02 | $17.13 | $64.00 | $49.00 | -15.00 | 68.7% | 65.0% | -3.7 pts | 73.2% | holo x1.2 → cost + 65% margin |
| 2x2 in, Holographic, 0X | 100 | $22.18 | $20.88 | $67.00 | $60.00 | -7.00 | 66.9% | 65.2% | -1.7 pts | 68.8% | holo x1.2 → cost + 65% margin |
| 2x2 in, Holographic, 0X | 250 | $28.67 | $32.13 | $77.50 | $77.50 | none | 63.0% | 58.5% | -4.5 pts | 58.5% | holo x1.2 → cost + 58% margin |
| 2x2 in, Holographic, 0X | 500 | $39.47 | $50.87 | $120.00 | $120.00 | none | 67.1% | 57.6% | -9.5 pts | 57.6% | holo x1.2 |
| 2x2 in, Holographic, 0X | 1000 | $67.61 | $90.40 | $170.00 | $170.00 | none | 60.2% | 46.8% | -13.4 pts | 46.8% | holo x1.2 |
| 2x2 in, Holographic, 0X | 2500 | $145.49 | $207.67 | $275.00 | $350.00 | +75.00 | 47.1% | 40.7% | -6.4 pts | 24.5% | holo x1.2 → cost + 40% margin |
| 2x2 in, Holographic, 3X | 50 | $28.83 | $20.95 | $94.00 | $60.00 | -34.00 | 69.3% | 65.1% | -4.2 pts | 77.7% | holo x1.2 → cost + 65% margin |
| 2x2 in, Holographic, 3X | 100 | $33.54 | $28.27 | $106.00 | $81.00 | -25.00 | 68.4% | 65.1% | -3.3 pts | 73.3% | holo x1.2 → cost + 65% margin |
| 2x2 in, Holographic, 3X | 250 | $47.68 | $50.26 | $117.50 | $120.00 | +2.50 | 59.4% | 58.1% | -1.3 pts | 57.2% | holo x1.2 → cost + 58% margin |
| 2x2 in, Holographic, 3X | 500 | $71.25 | $86.90 | $150.00 | $180.00 | +30.00 | 52.5% | 51.7% | -0.8 pts | 42.1% | cost + 52% margin |
| 2x2 in, Holographic, 3X | 1000 | $124.92 | $162.46 | $210.00 | $270.00 | +60.00 | 40.5% | 39.8% | -0.7 pts | 22.6% | cost + 40% margin |
| 2x2 in, Holographic, 3X | 2500 | $279.40 | $387.81 | $475.00 | $650.00 | +175.00 | 41.2% | 40.3% | -0.8 pts | 18.4% | cost + 40% margin |
| 3x3 in, Matte, 0X | 50 | $19.71 | $15.84 | $56.50 | $45.50 | -11.00 | 65.1% | 65.2% | +0.1 pts | 72.0% | cost + 65% margin |
| 3x3 in, Matte, 0X | 100 | $21.56 | $19.02 | $62.00 | $59.00 | -3.00 | 65.2% | 67.8% | +2.5 pts | 69.3% | cost + 65% margin → area floor |
| 3x3 in, Matte, 0X | 250 | $27.11 | $28.54 | $110.00 | $110.00 | none | 75.4% | 74.1% | -1.3 pts | 74.1% | area floor |
| 3x3 in, Matte, 0X | 500 | $42.89 | $45.75 | $160.00 | $160.00 | none | 73.2% | 71.4% | -1.8 pts | 71.4% | area floor |
| 3x3 in, Matte, 0X | 1000 | $74.44 | $79.62 | $210.00 | $210.00 | none | 64.6% | 62.1% | -2.5 pts | 62.1% | area floor |
| 3x3 in, Matte, 0X | 2500 | $156.04 | $180.98 | $500.00 | $500.00 | none | 68.8% | 63.8% | -5.0 pts | 63.8% | area floor |
| 3x3 in, Matte, 3X | 50 | $31.79 | $23.51 | $91.00 | $67.00 | -24.00 | 65.1% | 64.9% | -0.2 pts | 74.2% | cost + 65% margin |
| 3x3 in, Matte, 3X | 100 | $39.47 | $34.36 | $113.00 | $98.00 | -15.00 | 65.1% | 64.9% | -0.1 pts | 69.6% | cost + 65% margin |
| 3x3 in, Matte, 3X | 250 | $62.51 | $66.89 | $150.00 | $160.00 | +10.00 | 58.3% | 58.2% | -0.1 pts | 55.4% | cost + 58% margin |
| 3x3 in, Matte, 3X | 500 | $107.44 | $122.44 | $225.00 | $255.00 | +30.00 | 52.2% | 52.0% | -0.3 pts | 45.6% | cost + 52% margin |
| 3x3 in, Matte, 3X | 1000 | $197.31 | $232.70 | $330.00 | $390.00 | +60.00 | 40.2% | 40.3% | +0.1 pts | 29.5% | cost + 40% margin |
| 3x3 in, Matte, 3X | 2500 | $453.83 | $563.84 | $750.00 | $950.00 | +200.00 | 39.5% | 40.6% | +1.2 pts | 24.8% | cost + 40% margin |
| 3x3 in, Holographic, 0X | 50 | $22.73 | $21.99 | $68.00 | $63.00 | -5.00 | 66.6% | 65.1% | -1.5 pts | 67.7% | holo x1.2 → cost + 65% margin |
| 3x3 in, Holographic, 0X | 100 | $27.59 | $30.23 | $79.00 | $86.00 | +7.00 | 65.1% | 64.8% | -0.2 pts | 61.7% | cost + 65% margin |
| 3x3 in, Holographic, 0X | 250 | $42.17 | $54.97 | $132.50 | $132.50 | none | 68.2% | 58.5% | -9.7 pts | 58.5% | holo x1.2 |
| 3x3 in, Holographic, 0X | 500 | $73.01 | $98.60 | $190.00 | $205.00 | +15.00 | 61.6% | 51.9% | -9.7 pts | 48.1% | holo x1.2 → cost + 52% margin |
| 3x3 in, Holographic, 0X | 1000 | $134.69 | $184.79 | $250.00 | $310.00 | +60.00 | 46.1% | 40.4% | -5.7 pts | 26.1% | holo x1.2 → cost + 40% margin |
| 3x3 in, Holographic, 0X | 2500 | $306.67 | $443.09 | $600.00 | $750.00 | +150.00 | 48.9% | 40.9% | -8.0 pts | 26.2% | holo x1.2 → cost + 40% margin |
| 3x3 in, Holographic, 3X | 50 | $34.72 | $30.39 | $109.00 | $87.00 | -22.00 | 68.1% | 65.1% | -3.1 pts | 72.1% | holo x1.2 → cost + 65% margin |
| 3x3 in, Holographic, 3X | 100 | $45.33 | $46.69 | $136.00 | $133.00 | -3.00 | 66.7% | 64.9% | -1.8 pts | 65.7% | holo x1.2 → cost + 65% margin |
| 3x3 in, Holographic, 3X | 250 | $77.14 | $95.59 | $182.50 | $227.50 | +45.00 | 57.7% | 58.0% | +0.3 pts | 47.6% | cost + 58% margin |
| 3x3 in, Holographic, 3X | 500 | $136.71 | $179.84 | $285.00 | $375.00 | +90.00 | 52.0% | 52.0% | +0.0 pts | 36.9% | cost + 52% margin |
| 3x3 in, Holographic, 3X | 1000 | $255.83 | $346.91 | $430.00 | $580.00 | +150.00 | 40.5% | 40.2% | -0.3 pts | 19.3% | cost + 40% margin |
| 3x3 in, Holographic, 3X | 2500 | $600.13 | $848.23 | $1000.00 | $1425.00 | +425.00 | 40.0% | 40.5% | +0.5 pts | 15.2% | cost + 40% margin |
| 4x4 in, Matte, 0X | 50 | $21.15 | $18.12 | $60.50 | $54.00 | -6.50 | 65.0% | 66.4% | +1.4 pts | 70.0% | cost + 65% margin → area floor |
| 4x4 in, Matte, 0X | 100 | $24.44 | $23.57 | $80.00 | $80.00 | none | 69.5% | 70.5% | +1.1 pts | 70.5% | area floor |
| 4x4 in, Matte, 0X | 250 | $40.83 | $41.26 | $142.50 | $142.50 | none | 71.3% | 71.0% | -0.3 pts | 71.0% | area floor |
| 4x4 in, Matte, 0X | 500 | $63.80 | $69.11 | $230.00 | $230.00 | none | 72.3% | 70.0% | -2.3 pts | 70.0% | area floor |
| 4x4 in, Matte, 0X | 1000 | $116.27 | $126.16 | $360.00 | $360.00 | none | 67.7% | 65.0% | -2.7 pts | 65.0% | area floor |
| 4x4 in, Matte, 0X | 2500 | $267.13 | $298.77 | $900.00 | $900.00 | none | 70.3% | 66.8% | -3.5 pts | 66.8% | area floor |
| 4x4 in, Matte, 3X | 50 | $37.77 | $31.77 | $108.00 | $91.00 | -17.00 | 65.0% | 65.1% | +0.1 pts | 70.6% | cost + 65% margin |
| 4x4 in, Matte, 3X | 100 | $51.42 | $50.88 | $147.00 | $145.00 | -2.00 | 65.0% | 64.9% | -0.1 pts | 65.4% | cost + 65% margin |
| 4x4 in, Matte, 3X | 250 | $98.91 | $109.52 | $235.00 | $260.00 | +25.00 | 57.9% | 57.9% | -0.0 pts | 53.4% | cost + 58% margin |
| 4x4 in, Matte, 3X | 500 | $173.71 | $205.24 | $360.00 | $430.00 | +70.00 | 51.7% | 52.3% | +0.5 pts | 43.0% | cost + 52% margin |
| 4x4 in, Matte, 3X | 1000 | $329.83 | $398.02 | $550.00 | $660.00 | +110.00 | 40.0% | 39.7% | -0.3 pts | 27.6% | cost + 40% margin |
| 4x4 in, Matte, 3X | 2500 | $791.68 | $978.61 | $1325.00 | $1625.00 | +300.00 | 40.3% | 39.8% | -0.5 pts | 26.1% | cost + 40% margin |
| 4x4 in, Holographic, 0X | 50 | $26.51 | $28.59 | $75.50 | $81.50 | +6.00 | 64.9% | 64.9% | +0.0 pts | 62.1% | cost + 65% margin |
| 4x4 in, Holographic, 0X | 100 | $35.15 | $43.07 | $100.00 | $123.00 | +23.00 | 64.8% | 65.0% | +0.1 pts | 56.9% | cost + 65% margin |
| 4x4 in, Holographic, 0X | 250 | $67.61 | $87.85 | $170.00 | $210.00 | +40.00 | 60.2% | 58.2% | -2.1 pts | 48.3% | holo x1.2 → cost + 58% margin |
| 4x4 in, Holographic, 0X | 500 | $117.36 | $163.03 | $275.00 | $340.00 | +65.00 | 57.3% | 52.0% | -5.3 pts | 40.7% | holo x1.2 → cost + 52% margin |
| 4x4 in, Holographic, 0X | 1000 | $223.38 | $314.73 | $430.00 | $520.00 | +90.00 | 48.1% | 39.5% | -8.6 pts | 26.8% | holo x1.2 → cost + 40% margin |
| 4x4 in, Holographic, 0X | 2500 | $534.92 | $768.39 | $1075.00 | $1275.00 | +200.00 | 50.2% | 39.7% | -10.5 pts | 28.5% | holo x1.2 → cost + 40% margin |
| 4x4 in, Holographic, 3X | 50 | $42.97 | $43.37 | $129.50 | $124.00 | -5.50 | 66.8% | 65.0% | -1.8 pts | 66.5% | holo x1.2 → cost + 65% margin |
| 4x4 in, Holographic, 3X | 100 | $61.82 | $72.17 | $177.00 | $206.00 | +29.00 | 65.1% | 65.0% | -0.1 pts | 59.2% | cost + 65% margin |
| 4x4 in, Holographic, 3X | 250 | $124.92 | $159.91 | $297.50 | $380.00 | +82.50 | 58.0% | 57.9% | -0.1 pts | 46.2% | cost + 58% margin |
| 4x4 in, Holographic, 3X | 500 | $225.73 | $307.14 | $470.00 | $640.00 | +170.00 | 52.0% | 52.0% | +0.0 pts | 34.7% | cost + 52% margin |
| 4x4 in, Holographic, 3X | 1000 | $433.87 | $602.95 | $720.00 | $1000.00 | +280.00 | 39.7% | 39.7% | -0.0 pts | 16.3% | cost + 40% margin |
| 4x4 in, Holographic, 3X | 2500 | $1051.78 | $1488.48 | $1750.00 | $2475.00 | +725.00 | 39.9% | 39.9% | -0.0 pts | 14.9% | cost + 40% margin |

## Exactly which cost inputs differ

Per bag, on a 1,000-bag double-sided order (single-sided is roughly half for the per-label lines). Amounts are cost, not price.

| Cost input | Engine A (storefront) | Engine B (calculator) | Difference per bag |
|---|---|---|---:|
| Label application labour | 256 labels an hour at $20/hr = $0.0781 a label, **$0.1563** a bag | 10 seconds a side at $20/hr = $0.0556 a side, **$0.1111** a bag | B lower by $0.045 |
| Art setup, Stock Bag | $8.33 an order | $0 (premade GSO design) | B lower by $8.33 an order |
| Art setup, Sticker Bag and stickers | $8.33 an order | $8.33 an order | same |
| Colour ink, plain matte (Mimaki) | 0.6 mL a sq ft = $0.033 | 1.89 mL a sq ft = $0.092 | B higher by $0.060 |
| Colour ink, specialty work (Roland) | 1.05 mL a sq ft = $0.064 | 1.4133 mL a sq ft = $0.078 | B higher by $0.014 |
| White ink under holographic | 1.9 mL a sq ft = $0.117 | 6.0 mL a sq ft at 100% coverage = $0.331 | B higher by $0.215 |
| Gloss ink, 3X | 2.83 mL a sq ft a layer = $0.469 | 4.18 mL a sq ft a layer = $0.623 | B higher by $0.154 |
| Press time, plain matte | $0.034 | $0.033 machine + $0.017 operator attention | B higher by $0.016 |
| Press time, holographic 3X | $0.073 | $0.127 machine + $0.063 operator attention | B higher by $0.117 |
| Cutting and weeding | $6.53 a cut page = $0.091 | cutter time + attention + weeding = $0.050 | B lower by $0.042 |
| Label media | net area + 10% waste = $0.097 | nested footprint = $0.091 | B lower by $0.006 |
| Gloss mask setup (gloss orders) | $6.25 an order | $0 unless staff tick file prep | B lower by $6.25 an order |
| Blank bag | the 4x5 blank record in the database | fixed $0.11 | none if the record says $0.11 (not checked here) |
| Inbound freight | $0 | $0, shown as "not modelled" | same |

For stickers the same ink, press-time and cutting differences apply by area. Example, 1,000 plain matte 3x3 stickers: ink $7.33 on A against $20.79 on B; cutting $26.12 on A against $15.23 on B; operator attention $0 on A against $3.77 on B.

**Why small sticker orders get cheaper on B and big specialty orders get dearer:** A charges a flat $6.53 for every cut page and $6.25 for every gloss order, which weighs heavily on a 50-piece order. B charges more for every square foot of ink and press time, which weighs heavily on a 2,500-piece gloss or holographic order.

## Where the two already agree

- Every plain matte bag price, single or double sided, 50 to 2,500.
- Every bag price set by your market target or specialty tier — 38 of 48 configurations in each bag family.
- The blank bag at $0.11, the label media rate per square foot, print setup ($1), packing ($2), the $5/hr machine rate, and art setup on Sticker Bags and stickers.
- Which press runs the job: Mimaki for plain colour, Roland for anything with gloss, white or holographic.
- The price rules themselves. There is one set, and both engines feed it.

## Is either engine demonstrably wrong against a rule you already approved?

**Engine A, yes, on two inputs. Reported only — nothing was fixed.**

1. **Application labour.** The storefront still costs 4x5 application at 256 labels an hour. The code records that rate as superseded on 2026-08-22 by 10 seconds a side and kept for the "legacy calculator path only":
   - `app/lib/owner-standards.ts:45-50` and `:143-147` (the superseded marker)
   - `app/lib/bag-cost-inputs.server.ts:142-150` (the 10 seconds a side rule and the note that it supersedes 256 an hour)
   - Where the storefront still uses it: `app/lib/product-driven-costing.server.ts:842`, reached from `app/lib/canonical-bag-pricing.server.ts:110`
   - Note: you froze every bag and jar application timing on 2026-11-19 until measured shop times arrive. This document does not propose changing either figure. Both stay as they are. The only open question is which of the two existing figures the storefront reads.
2. **Stock Bag art setup.** The storefront adds $8.33 of art setup to every Stock Bag order (`app/lib/canonical-bag-pricing.server.ts:113`, `app/lib/product-driven-costing.server.ts:819-822`). The approved rule says a Stock Bag is premade GSO artwork with $0 art setup (`app/lib/bag-cost-inputs.server.ts:547-565`).

Neither of these moves a plain matte bag price today. They overstate the storefront's cost by roughly $0.045 a double-sided bag plus $8.33 an order.

**Engine B, no approved rule is broken — but two things are flagged.**

- Its white and gloss ink figures (6.0 and 4.18 mL a sq ft) are the approved calibrations (`docs/GSO_TRUE_COST_CONTRACT.md:369`). The Roland production audit of 2026-11-11 measured real usage at about half that for gloss and about a third for white, and left the calibration unchanged pending your review (`docs/GSO_ERP_PROJECT_STATE.md:517`). Those two figures are exactly what drives every price increase in the tables above.
- Engine B has no default for white coverage (`app/lib/machine-routing.server.ts:416`). The storefront does not ask for one. This comparison assumed 100% for holographic. A real switch needs you to choose that figure.

**One related decision already on record.** On 2026-10-19 you decided that Stock Bag quotes in the calculator charge the live storefront price (`app/lib/stock-bag-quote-pricing.server.ts:1-16`). So if the storefront price moves, Stock Bag quote prices move with it.

**One correction to an earlier document.** `docs/GSO_ERP_LAUNCH_READINESS_AUDIT.md:77` says the storefront price in its worked example is about $75 higher. That compared application labour only. On the full engines it is $650 lower (see the headline table).

## The one decision

**Which cost basis should the storefront price bags and stickers from?**

**Choice 1 — Keep Engine A (the storefront basis). Nothing changes.**
- No live price moves.
- The storefront keeps a labour rate and a Stock Bag art charge that your own rules have replaced. On bags this affects the recorded cost, not the price.
- The cost stored on each storefront order keeps differing from what the calculator shows for the same job.
- If Engine B is the truer cost, some live prices earn less than they appear to: the lowest are 22% on bags (holographic 3X double sided at 2,500) and 15% on stickers (4x4 holographic 3X at 2,500). 10 bag configurations per family and 19 sticker configurations sit under 40% on that measure.

**Choice 2 — Switch the storefront to Engine B (the calculator basis).**
- Plain matte bags: no change.
- Specialty bags at volume: 10 of 48 configurations rise, +$24 to +$1,625 an order. Example: 1,000 holographic 3X double-sided bags go from $2,200 to $2,830 (Stock) or $2,850 (Sticker Bag).
- Stickers: 20 of 72 configurations fall (-$2 to -$34, all small orders), 35 rise (+$2.50 to +$725).
- Stock Bag quotes in the calculator follow the storefront, so they move too.
- You would first need to choose a white-coverage figure for holographic, and decide whether the white and gloss ink calibrations questioned on 2026-11-11 stand.

**Choice 3 — Decide later, after two things you already have in motion.**
- The measured application timings from the shop, and your review of the white and gloss ink calibrations.
- Until then nothing changes, exactly as in Choice 1.
- The comparison test can be re-run in seconds once those land.

*For what it is worth, my read is Choice 3:* every price increase under Choice 2 comes from the two ink figures the 2026-11-11 audit questioned, and the labour figure is frozen pending shop timing. Switching now would raise specialty prices on numbers that are under review. That is a judgement, not a finding — the decision is yours.

## Limits of this comparison

- **No database was read.** Material rates ($0.3156 a sq ft matte, $0.7141 holographic), the Roland speed (150 sq ft an hour), the blank ($0.11) and the price-policy values are the fixtures the existing price-safety tests use. Live values may differ, which would shift the cost columns.
- **Engine B's press calibrations live only in the database.** The four values used are the approved definitions recorded in `docs/GSO_TRUE_COST_CONTRACT.md:369` and `tools/seed-machine-profile-calibrations.mjs`. They were not read from production.
- **White coverage of 100% for holographic is an assumption** made for this comparison. Gloss coverage is the 90% pre-art estimate both engines already use.
- **"B price" is a what-if.** It is Engine B's cost run through the storefront's own price rules, including the holographic sticker x1.2 floor. No such price exists anywhere today.
- **Die-cut stickers are not compared.** Engine B needs the real contour length and shape area, which the storefront does not collect.
- **Split Bags and 14x16 bags are not compared.** They are not sold through the storefront engine.
- 0X and 3X gloss only. Other gloss levels follow the same pattern but were not tabulated.

---

## Appendix for engineers — cost snapshot coverage (jars, stickers, DTP pouches)

Read-only analysis. `app/lib/storefront-cost-snapshot.server.ts` captures bag lines only. The question for each other family: can a cost be computed when the job is created, from approved data plus the fields in the checkout snapshot (`priceSnapshot.canonical`), without inventing a value?

### Stickers — YES, can be captured

- **Function:** `priceStickerConfiguration(inputs, selection)` in `app/lib/canonical-sticker-pricing.server.ts`. It already computes `run.totalCost` internally (the `computeProductDrivenCost` call) but does not return it.
- **One additive change needed:** return `totalCost: run.totalCost`, `unitCost: run.unitCost` and `costLines: run.lines.map(...)` on the `ok: true` result — the same additive pattern `canonicalStockBagJob` got on 2026-11-19. No price reads them.
- **From the snapshot:** `profile` (productType), `widthIn`, `heightIn`, `material`, `finishLabel` (the specialty label). Quantity from the paid line.
- **From the database, before the transaction:** `resolveCanonicalStickerInputs(db, shop)` — `material.findMany`, `machine.findFirst` (Roland), and the pricing policy config. Read-only; same shape as the bag read at `app/lib/production-job-source.server.ts:1162`.
- **Blocker:** none. It is the Engine A basis, the same basis the bag snapshot records, so the two stay consistent.

```ts
// storefront-cost-snapshot.server.ts — call before the bag branch; null = not a sticker line.
function stickerSnapshotFor(item, price, stickerInputs: CanonicalStickerInputs | null, capturedAt: string, missing: (r: string) => StorefrontCostSnapshot): StorefrontCostSnapshot | null {
  const s = parseCanonicalStickerOrderLine(JSON.stringify(price?.canonical ?? null));
  if (!s) return null;
  if (!stickerInputs?.available) return missing(`Sticker cost inputs were not available when the order was placed${stickerInputs?.reasons?.length ? `: ${stickerInputs.reasons.join("; ")}` : "."}`);
  const quantity = Math.max(1, Math.floor(Number(item.quantity) || 0));
  const priced = priceStickerConfiguration(stickerInputs, { productType: s.profile, widthIn: s.widthIn, heightIn: s.heightIn, quantity, material: s.material, specialty: s.finishLabel });
  if (!priced.ok) return missing(`The cost engine could not cost this configuration: ${priced.reason}`);
  if (!(priced.totalCost > 0) || !Number.isFinite(priced.unitCost)) return missing("The cost engine returned no cost.");
  const sellingUnitPrice = Number(item.unitPrice) || 0;
  const sellingTotal = round(sellingUnitPrice * quantity, 2);
  return {
    source: STOREFRONT_COST_SOURCE, version: STOREFRONT_COST_SNAPSHOT_VERSION, status: "captured", capturedAt,
    basis: "The cost the storefront price engine used for this configuration when the order was placed.",
    note: "Stickers carry no application labour.", family: "Stickers", pricingVersion: STICKER_PRICING_VERSION,
    quantity, faces: 1, glossLayers: s.specialtyX, holographic: s.holo,
    unitCost: round(priced.unitCost), totalCost: round(priced.totalCost, 2), sellingUnitPrice, sellingTotal,
    marginPct: sellingTotal > 0 ? round(((sellingTotal - priced.totalCost) / sellingTotal) * 100, 2) : null,
    costLines: priced.costLines.map((l) => ({ label: String(l.label), amount: round(Number(l.amount) || 0, 2) })),
  };
}
// production-job-source.server.ts, beside the bag read (~line 1162):
//   storefrontStickerInputs = await resolveCanonicalStickerInputs(dbClient, shop);   // in its own try/catch
// and pass it as a third argument through applyStorefrontCostSnapshots.
```

### Jars — KEEP NOT CAPTURED

- **Function that would be used:** `computeCanonicalJob({ db, shop }, input)` in `app/lib/canonical-calculator.server.ts` with `family: "premium-jars" | "standard-jars"` and `jar: { brand, size, selection: { side, lid, tamper }, materialKey }`. It returns `totalCost`, `unitCost`, `status` and `trueCost.lines`. Database reads: the four `machineProfileCalibration` identities (`preloadCanonicalCalibrations`). Blank cost, freight and application seconds come from code tables in `app/lib/jar-cost-inputs.server.ts`.
- **Why it cannot be done honestly — the snapshot does not carry what the engine requires:**
  1. **Which labels the jar gets.** The engine needs `selection.side / lid / tamper`; with none it returns `NO_PRINTED_COMPONENT`. The jar snapshot (`CanonicalJarOrderLine`, `app/lib/order-canonical.server.ts`) has no label-set field, and the storefront jar engine only says "printed label" (`app/lib/canonical-jar-pricing.ts:15`). Side only against side + lid changes the cost (Miron 100 mL x 100: $335.86 against $345.30).
  2. **White coverage for holographic.** `WHITE_COVERAGE_REQUIRED` — "white has NO default coverage" (`app/lib/machine-routing.server.ts:416`). Not in the snapshot.
  3. **What "Gloss" base finish means in cost terms** (gloss media, or printed gloss layers). The snapshot has `baseFinish` only; mapping it to `materialKey` would be a guess.
  4. **Brand.** The profile is a size (`jar_100ml_tall`). The storefront file header says Miron, but nothing in the snapshot states it.
- Not a blocker for the storefront sizes: MIRON Ceres freight is pending (`JAR_FREIGHT_PENDING`), but Ceres sets are not storefront jars. Every lid job reports `PROVISIONAL` (`CUT_PATH_ESTIMATE_REQUIRED` — no contour cutting benchmark), so even a captured jar cost would be provisional.
- **To unblock:** add `labelSet` (and, for holographic, an approved white coverage) to `buildCanonicalJarLineMetadata` going forward. Then the call is:

```ts
// Only once the snapshot carries labelSet. Calibrations preloaded before the transaction.
const sizeKey = jar.profile.replace(/^jar_/, "").replace(/_(clear|black_white)$/, "");            // "100ml_tall", "3oz"
const standard = sizeKey === "3oz" || sizeKey === "4oz";
const input = normalizeCanonicalInput(new URLSearchParams({
  pfamily: standard ? "standard-jars" : "premium-jars", pqty: String(quantity),
  pjar: `${standard ? "standard" : "miron"}/${sizeKey === "100ml" ? "100ml_wide" : sizeKey}`,
  pjarside: selection.side ? "1" : "", pjarlid: selection.lid ? "1" : "", pjartamper: selection.tamper ? "1" : "",
  pjarmat: jar.holo ? "holographic" : "matte", pprinter: jar.holo || jar.specialtyX > 0 ? "auto" : "mimaki",
  pwhitelayers: jar.holo ? "1" : "0", pglosslayers: String(jar.specialtyX),
  // pwhitecoverage: REQUIRED for holographic — no approved value exists.
}));
const job = assembleCanonicalJob(input!, resolveCanonicalMachineInputsFromCache(input!, calibrationCache));
if (job.unitCost == null || job.blockers.length) return missing(`Jar cost blocked: ${job.blockers.join("; ")}`);
// captured: totalCost job.totalCost, unitCost job.unitCost, costLines job.trueCost.lines, plus job.status ("PROVISIONAL").
```

### DTP pouches — KEEP NOT CAPTURED

- **Function that would be used:** `resolveDtpQuoteCost({ vendorSku, quantity, designs, selection, legacy, freightPerOrder })` in `app/lib/dtp-quote-cost-authority.server.ts`. It is pure (no database): it reads the Spektra live cost book in code. It returns `landedCost` (vendor subtotal + art + entered freight), `vendorUnit`, `status`, `freightStatus` and `missing`.
- **From the snapshot:** `ladderSku` (vendorSku), quantity. That is all it carries.
- **Why it cannot be done honestly:**
  1. **Inbound freight is not verified.** With no entered freight the function returns `freightStatus: "FREIGHT_NOT_VERIFIED"` and leaves freight out. The historical $85 a PO is explicitly barred from quoting (`app/lib/dtp-catalog.ts:61-72`). A snapshot would be a cost with a known missing component.
  2. **The vendor configuration is not in the snapshot and the code disagrees with itself about it.** The storefront describes "Silver PET ... tear notches ... included" (`app/lib/canonical-dtp-pricing.server.ts:8-11`); the cost book default is White PET, No Tear Notch (`DTP_COMPARABLE_CONFIG`, `app/lib/dtp-catalog.ts:76`). Choosing either is inventing the configuration.
  3. **Design (SKU) count is not in the snapshot.** It drives art cost and the extra-SKU vendor charge.
- **To unblock:** owner confirmation of the storefront pouch configuration and of a freight basis, and a design count on the line. Then:

```ts
const dtp = parseCanonicalDtpOrderLine(JSON.stringify(price?.canonical ?? null));
if (!dtp) return null;
const cost = resolveDtpQuoteCost({
  vendorSku: dtp.ladderSku, quantity, designs: 1 /* NOT in the snapshot — needs confirming */,
  selection: {} /* falls back to DTP_COMPARABLE_CONFIG — needs owner confirmation */,
  legacy: { totalCost: 0, missing: true, vendorSubtotal: null }, freightPerOrder: 0,
});
if (cost.missing || !(cost.landedCost > 0)) return missing(`DTP cost not available: ${cost.missingReason || cost.basis}`);
if (cost.freightStatus !== "ENTERED") return missing("DTP inbound freight is not verified, so no complete cost can be recorded.");
// captured: totalCost cost.landedCost, unitCost cost.landedCost / quantity,
// costLines: vendor cost.vendorSubtotal, art cost.artCost, freight cost.freight.
```
