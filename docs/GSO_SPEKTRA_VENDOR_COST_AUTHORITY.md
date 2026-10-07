# GSO Spektra / Flex Packaging Vendor Cost Authority (2026-10-06)

Status legend used throughout: **VENDOR OBSERVED DATA** (read from the live public calculator), **OWNER-APPROVED COMMERCIAL RULE**, **MARKET RESEARCH**, **UNVERIFIED ASSUMPTION**.

## 1. What was found, and what was not

| Input named in the task | Status in the repository on 2026-10-06 |
|---|---|
| `docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv` | **NOT PRESENT** (not in the working tree, any branch, the stash, or the user's Downloads / Desktop / Documents) |
| `docs/vendor-research/SPEKTRA_FLEX_PRICING_RULES_2026-10-06.md` | NOT PRESENT |
| `docs/vendor-research/SPEKTRA_OLD_VS_CURRENT_2026-10-06.md` | NOT PRESENT |
| "master market-pricing research already collected in the branch" | NOT PRESENT (no market-pricing master document exists; the only competitor study, `GSO_ERP_COMPETITOR_MARGIN_STUDY.md` 2026-07-25, contains no DTP prices) |

Consequence: **no observed Spektra price was loaded.** Nothing was invented. The cost book, generator, lookup, catalog, freight labelling and shaped-bag policy are complete and tested; the observed-row artifact is empty and every vendor-cost lookup fails closed to REQUEST CURRENT VENDOR QUOTE until the CSV is committed and generated.

## 2. Architecture (VENDOR OBSERVED DATA container + rules)

- `app/lib/generated/spektra-live-price-matrix-2026-10-06.ts` — the generated observed-row artifact (checked in; currently `SPEKTRA_MATRIX_SOURCE_PRESENT = false`, 0 rows). Produced by `tools/generate-spektra-cost-book.mjs` from the CSV; the generator **refuses to run** without the file and refuses incomplete rows. The app never reads a CSV at runtime.
- `app/lib/spektra-live-cost-book.ts` (`spektra-live-cost-book/2026-10-06`): catalog, discount rule, SKU rule, lookup, matrix summary.
- `app/lib/dtp-catalog.ts`: current-vs-legacy size classification and the freight assumption marker.

### Catalog (VENDOR OBSERVED DATA, 2026-10-06)

| Axis | Values |
|---|---|
| Sizes (2 in bottom gusset) | 3.5x4.5x2 (1 g), 4x5x2 (3.5 g), 5x5x2 (7 g), 6x5x2 (14 g), 8x5x2 (28 g) |
| Materials | White PET, Silver PET, Hologram, Clear PET |
| Finishes | Soft Touch, Matte, Glossy |
| Spot gloss | None, Standard, Raised UV — **not available on Glossy** |
| Zipper | None, 10 mm, Child Resistant (priced identically in validated tests, but each keeps its own observed row; never assumed equal) |
| Top feature (exclusive) | No Tear Notch, Punch Hole, Sombrero; plus a separate Clear Gusset toggle |
| Published tiers | 500, 1000, 2500, 5000, 10000, 25000; research also tested 550, 999, 1100, 1200, 7500 |
| Included in the public price | setup, prepress, plates, run charges (never added again) |
| Die cut | COMING SOON on the public site — no calculator |

### Rules

- **Discount (OWNER-APPROVED, status OWNER_CONFIRMED_ACCOUNT_DISCOUNT):** wholesale total = EXACT public order total x 0.75; wholesale unit = discounted total / delivered quantity. Never applied to the rounded displayed unit price (test-pinned).
- **Extra SKU (VENDOR OBSERVED, validated at 1 / 2 / 5 / 10 SKUs):** public total(n) = total(1 SKU) + $185 x (n - 1); wholesale extra SKU = $138.75. The quantity tier stays the TOTAL order quantity. Separate from custom-shape tooling.
- **Lookup statuses:** exact row -> OBSERVED VENDOR PRICE; 1-SKU row + validated SKU arithmetic -> ESTIMATED FROM VALIDATED VENDOR RULE; anything else (unsupported configuration, custom quantity without a row, empty matrix) -> REQUEST CURRENT VENDOR QUOTE. No interpolation.
- **MOQ:** website says 500 minimum run / per SKU, but the calculator prices lower quantities; NOT fully resolved. GSO's owner-approved DTP MOQ (1,000) is unchanged.

## 3. Freight (UNVERIFIED ASSUMPTION)

The public site exposes no usable freight. The historical $85 per Spektra purchase order is **not** part of this cost book. The runtime still applies it because existing DTP quoting needs a freight line:

| Where $85 is used today | Behaviour (unchanged) | Label added tonight |
|---|---|---|
| `product-driven-costing.server.ts` `SPEKTRA_FREIGHT_PER_PO = 85`, freight line in the DTP engine run | one flat line per PO inside landed cost | — (engine) |
| Cost Calculator loader/save (`dtpInput.freightPerOrder`, `priceDtpQuote.freightAmount`, `dtpSpec.freightDefault`) | embedded in the owner ladder price by default; pass-through backs it out | DTP form: "FREIGHT ASSUMPTION — OWNER / VENDOR CONFIRMATION NEEDED"; customer summary freight line carries the same label; `dtpSpec.freightAssumption` and `tier.dtp.freightAssumption` in the loader data / snapshot |
| `actual-cost-finalize.server.ts`, `actual-cost-reporting.server.ts` | warn when actual freight is missing / differs from $85 | — (already treats it as an estimate) |
| Product Setup DTP rules card, Vendor Cost Book, Pricing Intelligence | display | labelled UNVERIFIED |

Before/after economics: unchanged (no price moved). Owner decision: confirm a freight basis with the vendor, then either replace $85 or make freight a quoted line.

## 4. Old vendor rows vs current research

Old seed (`tools/seed-spektra-dtp.mjs`, VendorProductTier, status owner-verified 15C): 4x5x2 0.9897 / 0.4922 / 0.4033 / 0.3232; 5x4x2 1.0504 / 0.5419 / 0.4697 / 0.3818; 6x5x2 1.1048 / 0.5864 / 0.5290 / 0.4341; 8x5x2 1.2418 / 0.6991 / 0.6799 / 0.5674 at 1,000 / 2,500 / 5,000 / 7,500. These remain on the historical VendorProduct rows for old quotes. **No savings figure is stated**: with no observed current rows loaded, and with the old rows' material / finish / zipper / feature / SKU / freight assumptions not preserved, a like-for-like comparison is not possible yet.

## 5. Historical quotes

Old DTP quote snapshots keep their vendor cost, sell price, margins, freight assumption and pricing source/version. New quotes record the policy version and shaped-bag context in the price snapshot. No recalculation of history (test-pinned).

## 6. To finish this authority

1. Commit the three research files under `docs/vendor-research/`.
2. `node tools/generate-spektra-cost-book.mjs` (deterministic; refuses incomplete rows).
3. Run `npx vitest run tests/spektra-cost-book-and-shaped-bags-2026-10-06.test.ts` and extend it with the exact observed 4x5 rows.
4. Recompute the DTP sell ladders (section 6 of `GSO_PRICING_AUTHORITY_MATRIX.md`) and record the owner's decision on freight and on the new 3.5x4.5x2 / 5x5x2 ladders.
