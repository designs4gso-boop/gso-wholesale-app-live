# GSO Spektra / Flex Packaging Vendor Cost Authority (2026-10-06)

Status legend used throughout: **VENDOR OBSERVED DATA** (read from the live public calculator), **OWNER-APPROVED COMMERCIAL RULE**, **MARKET RESEARCH**, **UNVERIFIED ASSUMPTION**.

## 1. Research package status (UPDATED 2026-10-06, later the same day)

The three research files are now committed under `docs/vendor-research/`. The import contract was fixed (the research header uses `features`, e.g. "Sombrero + Clear Gusset", parsed into topFeature + clearGusset; the CSV was not modified). Generation result:

| Metric | Value |
|---|---|
| CSV rows read | 1,084 |
| unique rows accepted | 1,084 |
| rows rejected | 0 |
| exact duplicate rows | 0 |
| conflicting duplicates | 0 |
| generated artifact rows | 1,084 (all DIRECTLY OBSERVED; derived/estimated prices are never stored) |

Verified against the CSV (`tests/spektra-import-contract-2026-10-06.test.ts`): every one of the 1,084 rows round-trips through the lookup as OBSERVED with wholesale = exact website total x 0.75 (no intermediate cent rounding); 4x5x2 White PET Glossy / no spot / Child Resistant / No Tear Notch / 1 SKU at 1,000 / 2,500 / 5,000 / 10,000 / 25,000 = public $982.15 / $1,197.71 / $1,554.24 / $2,492.39 / $5,019.27 -> wholesale $736.6125 / $898.2825 / $1,165.68 / $1,869.2925 / $3,764.4525; plus one Clear Gusset, Punch Hole, Sombrero, Standard spot, Raised UV, non-White, 8x5x2, 10-SKU, 7,500 and 10 mm row each. Derived SKU counts are labelled ESTIMATED FROM VALIDATED VENDOR RULE; unsupported configurations and untested custom quantities still return REQUEST CURRENT VENDOR QUOTE.

## 2. Architecture (VENDOR OBSERVED DATA container + rules)

- `app/lib/generated/spektra-live-price-matrix-2026-10-06.ts` — the generated observed-row artifact (checked in; 1,084 rows, `SPEKTRA_MATRIX_SOURCE_PRESENT = true`). Produced by `tools/generate-spektra-cost-book.mjs` (import contract `tools/lib/spektra-csv-import.mjs`); the generator refuses to run without the file, with a missing required column, with any rejected row (unknown material / finish / spot / zipper / feature text, Glossy + spot, bad numbers, wrong discount, wholesale figures that disagree with website_total x 0.75) or with conflicting duplicates. The app never reads a CSV at runtime.
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

Old seed (`tools/seed-spektra-dtp.mjs`, VendorProductTier, status owner-verified 15C): 4x5x2 0.9897 / 0.4922 / 0.4033 / 0.3232; 5x4x2 1.0504 / 0.5419 / 0.4697 / 0.3818; 6x5x2 1.1048 / 0.5864 / 0.5290 / 0.4341; 8x5x2 1.2418 / 0.6991 / 0.6799 / 0.5674 at 1,000 / 2,500 / 5,000 / 7,500. These remain on the historical VendorProduct rows for old quotes. Scenario comparison (White PET / Soft Touch / no spot / CR zipper / No Tear Notch / 1 SKU, the legacy product spec): 4x5x2 -22.5% / -22.1% / -36.8% / -34.6% at 1,000 / 2,500 / 5,000 / 10,000 (live $0.7674 / $0.3833 / $0.2548 / $0.2113 vs old $0.9897 / $0.4922 / $0.4033 / $0.3232); 6x5x2 -23.2% / -23.8% / -40.4% / -36.5%; 8x5x2 -24.2% / -25.8% / -43.9% / -38.2%; Glossy is lower still (4x5x2 x5,000 -42.2%). These are scenarios, not proven like-for-like savings: the old rows did not record material / finish / zipper / feature / SKU / freight scope. 5x4x2 has no approved mapping and no comparison.

## 5. Historical quotes

Old DTP quote snapshots keep their vendor cost, sell price, margins, freight assumption and pricing source/version. New quotes record the policy version and shaped-bag context in the price snapshot. No recalculation of history (test-pinned).

## 6. Status

Loaded and verified. Runtime: the live book is shown in the Cost Calculator (LIVE SPEKTRA ECONOMICS line, configuration selects for material / finish / spot / zipper / top feature / clear gusset), the Vendor Cost Book card (filters + expandable rows) and Pricing Intelligence (economics tables). The quote price and status still come from the owner DTP ladder and the legacy vendor cost until the owner adopts the live book as the cost authority (see `GSO_PRICING_AUTHORITY_MATRIX.md`).
