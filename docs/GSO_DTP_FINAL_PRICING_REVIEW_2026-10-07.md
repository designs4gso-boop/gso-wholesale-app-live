# GSO DTP Final Pricing Review — 2026-10-07 (Wednesday morning owner review)

Every figure below is produced by code in this branch (`app/lib/dtp-owner-pricing.server.ts`, `app/lib/dtp-market-benchmark.ts`, `app/lib/dtp-proposed-ladders.server.ts`) and pinned by tests. Three labels are used and never mixed:

- **OWNER APPROVED** — live in the quote engine now.
- **PROPOSED FOR OWNER APPROVAL** — computed, shown in Pricing Intelligence, NOT read by the quote engine.
- **NOT ENOUGH EVIDENCE** — stated as such; nothing invented.

Landed cost everywhere = live Spektra wholesale (exact public total × 0.75, White PET / Soft Touch / no spot / CR zipper / No Tear Notch / 1 SKU) + GSO art $8.3333 (1 design) + freight **$85 (UNVERIFIED ASSUMPTION)**.

## 1. 4x5x2 — OWNER APPROVED (2026-10-06)

Pricing source `OWNER_APPROVED_DTP_4X5_2026_10_06` · market benchmark `DESIGN_AND_CUSTOMIZE_PRIMARY` · quote cost authority = live Spektra book by exact configuration.

| Step range | Price | Landed / unit | GP target | GP | GM | D&C comparable CR | GSO premium |
|---|---|---|---|---|---|---|---|
| 1,000 – 2,499 | **$1.30** | $0.8607 | $350 (acquisition exception) | $439 | 33.8% | $1.05 | +23.8% |
| 2,500 – 4,999 | **$0.71** | $0.4206 | $500 | $723 | 40.8% | $0.63 | +12.7% |
| 5,000 – 9,999 | **$0.46** | $0.2735 | $500 | $933 | 40.6% | $0.42 | +9.5% |
| 10,000 – 24,999 | **$0.37** | $0.2206 | $500 | $1,494 | 40.4% | $0.315 | +17.5% |
| 25,000+ | OWNER PRICING REVIEW REQUIRED | $0.1784 | — | — | — | not published | — |

Examples (test-pinned): 1,500 → $1.30 · 2,499 → $1.30 · 2,500 → $0.71 · 4,999 → $0.71 · 7,500 → $0.46 · 9,999 → $0.46 · 10,000 → $0.37 · 24,999 → $0.37 · 25,000 → no activated ladder. Sell prices are never interpolated; vendor cost stays exact/observed per configuration (extra SKUs by the validated $138.75 rule; custom quantities by a labelled conservative step; unsupported combinations block the quote).

**1,000-unit exception:** only ladder `spektra-dtp-4x5x2`, tier 1,000. $350 GP target instead of $500; hard floor 30% and the $350 absolute floor still apply. 2,500+ keeps the normal protection; no other product or size inherits it.

## 2. Design & Customize — benchmark of record (MARKET EVIDENCE ONLY)

| | 1,000 | 1,500 | 2,500 | 5,000 | 10,000 |
|---|---|---|---|---|---|
| Published 4x5 Gloss / Matte | $1.00 | $0.80 | $0.60 | $0.40 | $0.30 |
| + CR zipper 5% = comparable CR | $1.05 | $0.84 | $0.63 | $0.42 | $0.315 |

Published upgrades (competitor selling rules, never GSO costs or add-on rules): Spot Gloss +5%, Holographic +5%, CR Zipper +5%, Custom Shape +10%, Inside Print +15%, Rush +20%.

Custom-shape evidence (3.5 g, Gloss or Matte): 1,250 $1.80 · 1,500 $1.55 · 2,000 $1.30 · 2,500 $1.20 · 4,000 $0.90 — supports GSO shaped positioning; not copied.

Status: PRIMARY / CONTROLLING DTP COMPETITOR. Other competitors: RESEARCH / CONTEXT ONLY. Exact-size competitor pricing for 3.5x4.5, 5x5, 6x5, 8x5: **NOT CURRENTLY VERIFIED**.

GSO position: PREMIUM DOMESTIC DTP — "premium / heavy-duty pouch positioning" (no thickness claim until documented).

## 3. Shaped bags — OWNER APPROVED

Standard DTP customer price × 1.10; new unique die +$700 as a separate line (never in the unit price, never surcharged); existing reusable die $0; same shape with several designs = one $700; different physical shape = new $700; shaped MOQ 2,500 (a 1,000-unit shaped quote is blocked).

4x5x2 × 2,500: $0.71 → **$0.781** / unit before customer-facing rounding; product $1,952.50; + $700 if a new die = $2,652.50; reorder on the same die $1,952.50.

## 4. Remaining sizes — PROPOSED FOR OWNER APPROVAL (not active)

Method (owner direction): 4x5x2 is the market anchor. Each size is priced from its real live landed-cost difference vs 4x5x2 at the same quantity (G = GP parity), lifted where the 30/35/38% floors (H) or the $500 GP rule (I) require more, then commercially rounded (≥ $1 to the next $0.05; < $1 to the next cent). 1,000-tier proposals use NORMAL protection; the optional acquisition price is shown separately and needs an explicit owner exception. 25,000 rows anchor on the 4x5 25k RECOMMENDATION (itself not approved).

Full A–I tables: `docs/generated/dtp-proposed-ladders-2026-10-07.md` and Pricing Intelligence → "PROPOSED OWNER PRICING".

### 3.5x4.5x2 (1 g)

| Qty | Landed / unit | Δ vs 4x5 | PROPOSED | GM | GP | 1,000 acquisition option |
|---|---|---|---|---|---|---|
| 1,000 | $0.8413 | −2.3% | **$1.35** | 37.7% | $509 | $1.30 (35.3% / $459; $41 under $500) |
| 2,500 | $0.4055 | −3.6% | **$0.70** | 42.1% | $736 | |
| 5,000 | $0.2598 | −5.0% | **$0.45** | 42.3% | $951 | |
| 10,000 | $0.2053 | −6.9% | **$0.36** | 43.0% | $1,547 | |
| 25,000 | $0.1628 | −8.7% | **$0.29** | 43.8% | $3,179 | |

Rationale: slightly cheaper than 4x5x2 at every tier, so it prices at or just under the anchor. Recommendation: approve as listed; keep 1,000 at $1.35 unless the owner wants an acquisition exception at $1.30.

### 5x5x2 (7 g)

| Qty | Landed / unit | Δ vs 4x5 | PROPOSED | GM | GP | 1,000 acquisition option |
|---|---|---|---|---|---|---|
| 1,000 | $0.9030 | +4.9% | **$1.45** | 37.7% | $547 | $1.35 (33.1% / $447) |
| 2,500 | $0.4536 | +7.8% | **$0.75** | 39.5% | $741 | |
| 5,000 | $0.3033 | +10.9% | **$0.49** | 38.1% | $934 | |
| 10,000 | $0.2540 | +15.1% | **$0.41** | 38.0% | $1,560 | |
| 25,000 | $0.2114 | +18.5% | **$0.35** | 39.6% | $3,464 | |

Rationale: the 38% floor controls at 5,000+ (GP parity alone would fall below it). Recommendation: approve as listed.

### 6x5x2 (14 g)

| Qty | Landed / unit | Δ vs 4x5 | PROPOSED | GM | GP | 1,000 acquisition option |
|---|---|---|---|---|---|---|
| 1,000 | $0.9423 | +9.5% | **$1.45** | 35.0% | $508 | $1.40 (32.7% / $458) |
| 2,500 | $0.4843 | +15.2% | **$0.78** | 37.9% | $739 | |
| 5,000 | $0.3340 | +22.2% | **$0.54** | 38.1% | $1,030 | |
| 10,000 | $0.2851 | +29.2% | **$0.46** | 38.0% | $1,749 | |
| 25,000 | $0.2429 | +36.1% | **$0.40** | 39.3% | $3,928 | |

Current (July 2026) ladder for comparison: $1.84 / $1.04 / $0.96 / $0.81 / $0.81 (1,000 / 2,500 / 5,000 / 7,500 / 10,000) — still in force for quoting until replaced. Recommendation: approve the proposal; the July ladder is 21–45% above it and above the premium position.

### 8x5x2 (28 g)

| Qty | Landed / unit | Δ vs 4x5 | PROPOSED | GM | GP | 1,000 acquisition option |
|---|---|---|---|---|---|---|
| 1,000 | $1.0342 | +20.2% | **$1.55** | 33.3% | $516 | $1.50 (31.1% / $466) |
| 2,500 | $0.5561 | +32.2% | **$0.86** | 35.3% | $760 | |
| 5,000 | $0.3999 | +46.2% | **$0.65** | 38.5% | $1,251 | |
| 10,000 | $0.3600 | +63.2% | **$0.59** | 39.0% | $2,300 | |
| 25,000 | $0.3168 | +77.6% | **$0.52** | 39.1% | $5,080 | |

Current (July 2026) ladder: $2.05 / $1.23 / $1.23 / $1.05 / $1.05. Recommendation: approve the proposal. Sourcing note: 8x5x2 vendor cost falls much less with quantity than 4x5x2 (+63% landed at 10,000 vs +20% at 1,000), so the floors, not GP parity, set the 5,000+ prices.

### 25,000 tier — RECOMMENDED, OWNER APPROVAL REQUIRED

4x5x2 at 25,000: **$0.30** (40% target on live landed $0.1784; GM 40.5%, GP $3,039; order-total drop at the 24,999 → 25,000 boundary 18.9%, in line with the approved 10,000 step's 19.6%). Design & Customize publishes no 25,000 price. Other sizes at 25,000 (above) anchor on this recommendation: 3.5x4.5x2 $0.29 · 5x5x2 $0.35 · 6x5x2 $0.40 · 8x5x2 $0.52.

## 5. Quantity continuity and cliffs

Every step ladder makes a larger order cheaper in total than one unit below the step; the approved 4x5x2 ladder drops 45% / 35% / 20% / 19% at 2,500 / 5,000 / 10,000 / 25,000. No proposal exceeds the 4x5x2 reference drop by more than 5 points at any boundary (test-pinned), so there is no new pricing cliff beyond the shape the owner already approved.

## 6. Economic warnings

- Freight is the unverified $85 inside every landed figure; a different real freight shifts every GP by the same dollar amount per order.
- The 1,000-tier GM on the larger sizes (33–38%) is thin by design of the owner's $500 GP rule; acquisition options go lower still and need explicit approval.
- 5x4x2 is legacy with no current catalog match: new quotes now require MANUAL / VENDOR REVIEW (storefront adapter and calculator both fail closed); history unchanged.
