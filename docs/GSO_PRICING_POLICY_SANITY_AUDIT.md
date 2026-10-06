# GSO Pricing Policy Sanity Audit (2026-10-05 overnight)

Reusable suite: `tests/pricing-policy-sanity-2026-10-05.test.ts` (29 tests). It prices every integer quantity 50..1000 for the live jar fixture, every supported jar at every break quantity, and audits the other canonical families. True manufacturing cost is the unchanged canonical engine (production-shaped Mimaki CMYK calibration).

## Invariants enforced for jars (premium-jars, standard-jars)

| Invariant | Result |
|---|---|
| price >= true cost, gross profit > 0 | holds at every quantity |
| realized margin >= family minimum (Miron 45%, standard/Chiron 40%) | holds at every quantity (the envelope never caps below the floor) |
| TOTAL price non-decreasing as quantity rises by one | holds everywhere except three vendor cost tiers (247, 495, 990 for 100ml Tall) where the floor binds; those rows are flagged and staff are told the larger order is cheaper |
| no single-step unit-price jump > 15%; unit price may tick up only by a packout box step (<= 2%) | holds |
| 127 vs 128 | $776.40 vs $781.97 total; $6.11 both — cliff eliminated |
| route-equivalent computation (ladder + hidden support rows + requested) equals the full integer walk | holds at 16 probe quantities |
| owner ladder refused for Chiron, below 50, 5,000+, 9X+ deep build, unknown sizes | holds |
| without an owner ladder, `computeCommercialPrice` output is byte-identical to before | holds |
| staff per-tier margin override still wins over the ladder | holds |
| historical snapshot JSON unaffected by the new policy; old band margins still resolvable | holds |

Generated table: `docs/generated/jar-pricing-sanity-100ml-tall-miron-2026-10-05.md`.

## Other canonical families — audited, NOT changed tonight

Floors hold (price > cost, profit > 0, margin >= floor) for 4x5 sticker bags, 3x3 matte stickers and 3x6 banners at every audited quantity. Quantity cliffs found (`docs/generated/pricing-cliff-report-other-families-2026-10-05.md`):

| family | step | total before -> after | note |
|---|---|---|---|
| 4x5 sticker bag (1 side) | 99 -> 100 | $212.85 -> $130.00 | min-profit candidate controls below 100; owner-approved market target controls from 100 |
| 4x5 sticker bag (1 side) | 499 -> 500 | $573.85 -> $525.00 | band 58% starts at 500 |
| 3x3 matte sticker | 127 -> 128, 255 -> 256, 639 -> 640, 999 -> 1000 | $10-16 drops | band edges of the stickers curve |
| 3x6 banner | 127 -> 128 | $5,967.59 -> $5,346.13 | band edge of the banners curve |

These families carry owner-approved or researched curves (bags: 2026-07-26 ratified). Changing them needs the owner's call; the envelope helper is generic and can be enabled per family in one line once approved. Listed in the owner checklist.

## Pricing sources exposed per tier

Each calculator tier row now carries: quantity, true job cost, true unit cost, owner ladder unit price (jars), recommended unit price, total, gross profit, realized gross margin, controlling rule (including envelope caps), and the ladder-vs-floor context for the requested row.
