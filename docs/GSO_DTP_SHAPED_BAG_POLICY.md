# GSO DTP Custom Shaped / Die-Cut Pouch Policy — OWNER DECISION 2026-10-06

**Classification: OWNER-APPROVED COMMERCIAL RULE.** The public Flex Packaging / Spektra site lists Die Cut Bag as COMING SOON and has no die-cut calculator; nothing here is a public Spektra price. Implemented in `app/lib/dtp-shaped-bag-policy.ts` (`dtp-shaped-bag-policy/1.0.0-2026-10-06`) and wired into the Cost Calculator (loader and save path, parity-pinned).

## Rules

| Rule | Value | Notes |
|---|---|---|
| Base | the matching STANDARD DTP configuration customer product price (size, material, finish, spot, zipper, features, quantity, SKU count) | standard vendor true-cost matrix untouched |
| Custom shape surcharge | **+10%** of the standard customer PRODUCT price (base subtotal + design fees; freight and tooling excluded) | applies to every shaped order including reorders |
| Custom shape tooling | **$700** per UNIQUE PHYSICAL SHAPE / DIE, customer-facing, separate line | NOT per design, SKU, artwork, quantity tier; NOT charged again on a reorder with the same usable die |
| Existing die | $0 tooling; surcharge still +10% | requires a Die ID / Shape ID or a clear staff reference; never matched by dimensions alone |
| SKUs / designs | normal Spektra SKU economics ($185 public / $138.75 wholesale per extra SKU; GSO design fees per the owner ladder) | never creates a die |
| Setup / prepress / plates / run charges | already inside the public Spektra price | never added again (test-pinned: no double charge) |
| Tooling in profit | excluded from gross profit (vendor die cost unknown) | shown as pass-through |

Examples (standard product price $1,000): custom shape $1,100 product; new die +$700 tooling = $1,800 total; 5 or 10 designs on one shape = one $700; two shapes = $1,400; three = $2,100; reorder on the same die = $1,100 (no tooling).

## Calculator behaviour

DTP form fields: `pdtpshape` (standard | custom), `pdtpdie` (new | existing), `pdtpdieid`, `pdtpdieref`. A custom shape with "existing" and no ID/reference is BLOCKED. The tier table total includes tooling; the customer summary presents the product subtotal and "CUSTOM TOOLING" as separate blocks and never folds the $700 into the unit price.

## Die ID / durable registry

Die ID and reference are saved inside the quote price snapshot (`tier.dtp.shaped`). **DURABLE DIE REGISTRY REQUIRES FUTURE SCHEMA APPROVAL** — no Prisma model or migration was added; staff identify an existing die by its ID or reference, and the ERP does not auto-match shapes.

## Tests

`tests/spektra-cost-book-and-shaped-bags-2026-10-06.test.ts` pins every rule above, the no-double-charge invariants, the calculator wiring in both pricing paths, and historical snapshot immutability.
