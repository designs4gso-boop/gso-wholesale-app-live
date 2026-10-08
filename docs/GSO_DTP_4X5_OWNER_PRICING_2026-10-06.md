# GSO DTP 4x5x2 Owner-Approved Pricing — OWNER DECISION 2026-10-06

**Classification: OWNER-APPROVED COMMERCIAL ANCHOR.** Pricing source `OWNER_APPROVED_DTP_4X5_2026_10_06`; market benchmark `DESIGN_AND_CUSTOMIZE_PRIMARY`. Implemented in `app/lib/dtp-owner-pricing.server.ts` (ladder, sources, 1,000-unit exception), `app/lib/dtp-market-benchmark.ts` (benchmark of record), `app/lib/dtp-quote-cost-authority.server.ts` (quote cost by exact configuration), `app/lib/dtp-shaped-bag-policy.ts` (shaped MOQ 2,500). Local branch only — not pushed, not deployed.

## Approved 4x5x2 ladder (before / after)

Landed = live Spektra cost book (exact public total x 0.75, White PET / Soft Touch / no spot / CR zipper / No Tear Notch / 1 SKU) + GSO art $8.3333 + freight $85 (**UNVERIFIED ASSUMPTION**). D&C = Design & Customize comparable CR reference (published Gloss/Matte base + 5% CR zipper; market evidence, not a GSO cost).

| Qty | Old ladder (2026-07-24) | **Approved 2026-10-06** | Landed / unit | Landed total | Revenue | GP | GM | GP target | D&C comparable CR | GSO premium |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | $1.67 | **$1.30** | $0.860696 | $860.70 | $1,300.00 | $439.30 | 33.8% | $350 (acquisition exception) | $1.05 | +23.8% |
| 2,500 | $0.88 | **$0.71** | $0.420613 | $1,051.53 | $1,775.00 | $723.47 | 40.8% | $500 | $0.63 | +12.7% |
| 5,000 | $0.74 | **$0.46** | $0.273460 | $1,367.30 | $2,300.00 | $932.70 | 40.6% | $500 | $0.42 | +9.5% |
| 7,500 | $0.61 | steps to the 5,000 price ($0.46) | — | — | — | — | — | $500 | — | — |
| 10,000 | $0.60 | **$0.37** | $0.220619 | $2,206.19 | $3,700.00 | $1,493.81 | 40.4% | $500 | $0.315 | +17.5% |
| 25,000 | $0.60 (step) | **OWNER PRICING REVIEW REQUIRED** — no invented price; vendor cost shown ($0.174687 / unit) | $0.178420 | — | — | — | — | — | — | — |

Hard floors unchanged: 30% (1,000–2,499), 35% (2,500–4,999), 38% (5,000+); absolute floor $350; 40% remains the informational target.

## 1,000-unit exception (owner-approved)

The 4x5x2 1,000 tier is a competitive / acquisition tier with an approximately **$350+** gross-profit target instead of $500. It applies ONLY to ladder `spektra-dtp-4x5x2` at the 1,000 tier (quantities 1,000–2,499). 2,500+ tiers, every other DTP size and every other product keep the normal $500 protection (test-pinned). The $350 absolute floor and the 30% hard floor still apply to the tier; a custom price below them is blocked / override-required as before.

## Quote cost authority (4x5x2 only)

The approved prices were set against the LIVE landed cost, so new 4x5x2 quotes cost from the live Spektra book resolved by the EXACT configuration (material / finish / spot / zipper / top feature / clear gusset / SKU count). Option combinations are never flattened: a higher-cost option (e.g. Hologram + Raised UV) lowers the computed margin at the same $1.30 and trips the existing protection (OWNER OVERRIDE REQUIRED / BLOCKED). Statuses: OBSERVED VENDOR PRICE; ESTIMATED FROM VALIDATED VENDOR RULE (extra SKUs); ESTIMATED CONSERVATIVE STEP (custom quantity priced at the highest observed lower tier's unit cost — labelled, request a vendor quote before the PO); REQUEST CURRENT VENDOR QUOTE (unsupported configuration — quote BLOCKED). Other sizes keep the legacy 15C vendor tiers as quote cost until reviewed; 5x4x2 stays LEGACY / NO CURRENT STANDARD CATALOG MATCH.

## Market benchmark of record

| Competitor | Status | Published 4x5 base (Gloss or Matte) | Published upgrades |
|---|---|---|---|
| Design & Customize | PRIMARY / CONTROLLING DTP COMPETITOR | 1,000 $1.00 · 1,500 $0.80 · 2,500 $0.60 · 5,000 $0.40 · 10,000 $0.30 | CR zipper +5%, spot gloss +5%, holographic +5%, custom shape +10%, inside print +15%, rush +20% |

Comparable CR reference: 1,000 $1.05 · 2,500 $0.63 · 5,000 $0.42 · 10,000 $0.315. GSO position: **PREMIUM DOMESTIC DTP — premium / heavy-duty pouch positioning** (no thickness claim until documented). Competitor prices are market evidence only, never GSO costs; competitor add-on percentages are never copied into GSO vendor costing. Other competitors remain research / reference and never change these prices automatically.

## Shaped 4x5x2 (owner policy, unchanged rules + MOQ)

Standard customer product price **+10%**; **$700** per unique NEW die as a separate line (never in the unit price); $0 on reuse with a Die ID / reference; same physical shape with several designs = one $700; a different physical shape = a new $700; shaped MOQ **2,500**. Example 4x5x2 x 2,500: $0.71 -> shaped $0.781 / unit before customer-facing rounding; product $1,952.50 (+ $700 tooling if a new die = $2,652.50; reorder on the same die $1,952.50).

## Other DTP sizes

3.5x4.5x2, 5x5x2, 6x5x2, 8x5x2: live vendor costs valid; customer ladders **OWNER PRICING REVIEW REQUIRED** — not derived from 4x5x2 by any percentage. The 2026-07-24 ladders for 6x5x2 / 8x5x2 (and legacy 5x4x2) remain in force for quoting meanwhile and are labelled accordingly.

## Historical safety

Historical quote snapshots are unchanged (test-pinned). New 4x5x2 quotes record: vendor cost (authority, status, configuration, subtotal, unit, art, freight UNVERIFIED, cost-book version), landed cost, customer price, GM, GP, pricing source, ladder status, market benchmark + competitor comparable + premium %, commercial policy (incl. the acquisition exception), and the override reason if any.

## Tests

`tests/dtp-4x5-owner-pricing-2026-10-06.test.ts` (16 tests) plus updated pins in `dtp-spektra`, `canonical-dtp-pricing`, `calculator-forensic-fixtures`, `dtp-live-economics-2026-10-06`, `spektra-cost-book-and-shaped-bags-2026-10-06`.
