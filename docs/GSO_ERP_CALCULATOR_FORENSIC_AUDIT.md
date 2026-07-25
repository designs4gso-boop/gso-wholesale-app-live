# GSO ERP — Calculator Forensic Audit (Phase 15F.0, 2026-07-25)

Audit-only. Trigger: live quotes looked too low. Verdict up front: **the
engine's arithmetic is exact — every observed number reproduces to the cent
from production DB records. The quotes are low because real cost components
are structurally $0 (machine, cutting, packing, shipping), because the
margin applied comes from row-position interpolation instead of quantity,
and because no family except DTP has minimum job economics.** Machine-check
tests: tests/calculator-forensic-fixtures.test.ts (18 pins, all passing).

## A. Exact reconstruction — 100 x 3x3 matte kiss-cut stickers

| Step | Formula | Value |
|---|---|---|
| sqin/item | 3 x 3 | 9 |
| total sqin | 9 x 100 | 900 |
| base sqft | 900 / 144 | 6.25 |
| waste source | recipeWastePct hard-coded null -> PROVISIONAL 10% | 10% |
| waste-adjusted sqft | 6.25 / (1 - 0.10) | 6.944444 |
| material $/sqft | Material cmoxmgvx80000jj28acnr8ycp Poseidon Matte: $213/roll / (54in x 150ft = 675 sqft) | $0.3155556 |
| material | 0.3155556 x 6.944444 | **$2.1914** (observed 2.19 ✓) |
| CMYK ink | $0.176/ml x 0.6 ml/sqft x 6.944444 | **$0.7333** (observed 0.73 ✓) |
| white/gloss | 0 layers | $0 ✓ |
| machine time | machineMinutesPerSqft = 0 in product flow | **$0 — NOT COSTED** |
| art setup | 1 design x $8.3333 (owner standard) | $8.3333 ✓ |
| print setup | 1 design x $1.00 | $1.0000 ✓ |
| cutting | no line exists for any cut type | **$0 — NOT COSTED** |
| weeding | kiss cut, no weeding | $0 (correct exclusion) |
| packing | no sticker packout rule -> $0 "Estimated", non-blocking | **$0 — NOT COSTED** |
| freight | allowance defaults 0, nothing entered | **$0 — NOT COSTED** |
| min job charge / overhead / processing | do not exist | $0 |
| **total cost** | 2.1914 + 0.7333 + 8.3333 + 1.00 | **$12.2580** (observed 12.26 ✓) |
| margin applied | 6 rows (5 defaults + qty 100) -> curveForTierCount interpolates 65..40 -> index 1 | **60%** (researched curve point: 65%) |
| price | 12.2580 / (1 - 0.60) | **$30.645** (observed 30.65 ✓) |
| unit price | 30.645 / 100 (display rounds to cents) | $0.3065 -> "$0.31" ✓ |

Answers: **(2)** $12.26 is the CORRECT output of the current rules but an
INCOMPLETE cost — with the DB machine model (+$0.23), realistic cutting,
packing and shipping it is plausibly $14-17. **(3)** $30.65 is NOT
commercially appropriate: the researched curve itself says 65% -> $35.02;
complete costs at 65% -> ~$42-48; typical market for 100 3x3 custom die/kiss
cut stickers is roughly $50-80; and the job books only $18.39 gross profit
with no minimum-job rule to catch it.

## B. Unit and dimension audit — RESULT: no conversion defects
Verified exact (test-pinned): sqin->sqft /144 with quantity applied once;
roll->$/sqft ($213/675 = 0.3155556 matches stored calculatedUnitCost;
Banner $140/472.5 = 0.2962963); sqin-based materials x144; waste as divisor
base/(1-w) never a multiplier; weeding page (54x54)/144 = 20.25 sqft, pages
ceil; packout ceil(qty/unitsPerBox); tier below-lowest charges lowest tier
with warning; label rows sum per-row sqft, stale rows discarded; blank/zero
dimension inputs become MISSING blockers, never silent zeros; display labels
show base sqft AND waste. URL params: `Number(x || 0)` + blockers = no
blank-treated-as-cost path found. Loader and save read identical field names
(psearch replay) — no wrong-field source found.

## I. Margin and rounding — one real defect
- price = cost/(1-margin) everywhere (marginMath, suggestedPriceFromMargin,
  DTP profit = revenue - landed). NO markup-as-margin instance found.
- No per-unit rounding before multiplying: saved unitPrice/totalPrice are
  raw floats; $ display rounds at render only.
- **P0-1 (the defect): non-DTP tier margins map by ROW COUNT/POSITION**
  (curveForTierCount). Adding the requested quantity as a 6th row switches
  the researched 5-point curve [65,58,52,46,40] to linear [65,60,55,50,45,40]:
  the requested qty gets the wrong margin (100 -> 60% not 65%) AND the
  researched tiers shift (128: 58->55, 256: 52->50, 640: 46->45). Any
  requested qty above 1000 lands on 40% regardless of volume. Margin depends
  on how many rows render — exactly the bug class 15C.1 fixed for DTP only.
- Aggressive drop: stickers reach the 40% floor at qty 1000 by design of the
  5-band mapping; combined with near-zero unit cost this collapses volume
  prices (fixture 2: 1,000 stickers = $64.30 total). Cost-plus needs either
  quantity-banded curves re-anchored per family or owner price ladders.
- Gate note: checkMarginGate validates the LOWEST margin across the table
  (40% floor row) — fine today because floors align, but it gates the table,
  not the selected tier.

## J. Minimum price / minimum job economics — absent outside DTP
No minimum unit price, minimum order total, minimum gross profit, setup
recovery minimum, or small-order handling exists for any non-DTP family.
DTP (15C.2) is the working model: hard floor bands + $500 target/$350
strategic profit + statuses + override phrase. Owner decision points and
candidate values: docs/GSO_ERP_PRICING_CORRECTION_PLAN.md.

## K. Database truth (sampled 2026-07-25, read-only)
- Poseidon Matte Roll Media `cmoxmgvx80000jj28acnr8ycp` calculatedUnitCost
  0.3155556 (= $213 / 675 sqft) — current, verified, matches engine input.
  Poseidon Gloss `cmozzu35i0009fe28yb7xpk6v` identical. Banner Vinyl
  `cmrpkqxgp0006ef1sn52kwq5b` 0.2962963 (= $140 / 472.5 sqft).
- Mimaki UCJV300-130 `cmozcqiib000hfj28hcsc2wez`: costPerHour **$5**,
  sqftPerHour **150**, ink channels CMYK+White $0.176/ml, mlPerSqft1Pct
  0.0075 (x ~80% coverage = the calculator's 0.6). Roland LG-540
  `cmozcqi3w0000fj285by7l644`: all channels $0.198667/ml (=$149/750).
  INK_RATES constants match the DB exactly. **Machine cost model exists in
  the DB and is unused by the calculator.**
- 4x5 Blank Bag `cmrpjvdc50000av2atvnbt09e` $0.09 flat, no tiers ✓; 14x16
  `cmrpjvdgg0002av2a3g7029za` $1.00 ✓; 4x6 `cmrpjvdf10001av2aajhsnk4f` $0
  NO PRICE ✓ (blocks). Chiron `cmrzkm4om…` $1.80 / `cmrzkm4u8…` $1.90 flat,
  no tiers ✓. Spektra 4 records with 16 tiers match the seeded owner sheet
  (4x5x2 `cmrzqo6gv0002w61849d331gw` 0.9897/0.4922/0.4033/0.3232 etc.);
  ladder keys = vendorSkus ✓; 4x5x2 vs 5x4x2 remain distinct ✓. Legacy
  "DTP 4x5x2 Blank Pouch" preset is correctly EXCLUDED from the DTP picker
  by the classifier. Hygiene: "Template - 4x5 Outsourced Stock Bag"
  `cmozzu3fn000efe28rzrg0ew0` is active with six $0 tiers (classifies
  "other", so it cannot reach pickers — retire the record anyway).
- Zero/missing cost handling: a $0 record (4x6 bag) produces a MISSING
  blocker and Draft Only — verified in code and by the 4x6 policy. Recipes:
  17 exist, 16 carry wastePct>0 — never consulted (recipeWastePct: null).
- Standard jars/soda can remain CODE PRESETS (route `fixed(...)` list), not
  Vendor Cost Book records — documented 14C.2 limitation, still true.

## L. Display / save / snapshot parity — agree exactly
Loader (GET eparams) and action (psearch fRead) build byte-identical engine
inputs (same names, same 0.6 ink constant, same machine 0, same freight
panel); both run computeProductDrivenCost + the same margin resolution; the
selected tier is re-resolved BY QUANTITY server-side; posted totals ignored;
QuoteItem stores the raw unitPrice/unitCost and the full snapshot (engine
14C.2/15C.2 versions, lines, tiers, selected tier, margin sources).
Displayed values are the same floats rendered to cents. DTP save gates
(BLOCKED refuses; override phrase) verified present at the action. No
display-vs-save divergence found. (Historical caveat: quotes saved while a
NOW-changed DB cost existed reflect the cost at save time — snapshots make
this immutable, correct behavior.)

## O. Classified issue list
**P0**
1. Non-DTP margin maps by row position/count, not quantity (curveForTierCount
   + index) — requested-quantity insertion re-interpolates the researched
   curve and shifts every tier. Fix model exists: dtpMarginPctForQuantity.

**P1 (missing direct production cost — quotes read "Ready" while $0)**
1. Machine time: product flow passes machineMinutesPerSqft=0; DB has $5/hr
   at 150 sqft/hr; owner standard says $8/hr provisional; margin-review's
   $25 is quarantined legacy. Three rates, none applied.
2. Cutting/plotter time: no cost line exists for any cut type in any family
   (weeding is the only cut-adjacent cost; kiss vs die identical).
3. Outbound shipping/freight: allowance defaults to $0 and nothing prompts —
   most quotes embed free shipping.
4. Packing: rules exist only for 4x5 bags / 3oz / 4oz jars; stickers,
   banners, Chiron/Miron, 14x16, soda can pack at $0 (non-blocking note).
   (Product/vendor mapping audit: NO incorrect-mapping P1s found.)

**P2**
1. No minimum job economics outside DTP (no min price/total/profit).
2. Sticker volume pricing collapses commercially (fixture 2: 1,000 x 3x3 =
   $64.30 vs market ~$200-300) — needs owner ladder or re-anchored bands.
3. Blank/vendor items are NOT waste-adjusted in the product flow (manual
   pipeline does adjust) — jar/bag spoilage unmodeled; pipeline inconsistency.
4. recipeWastePct never wired (16/17 recipes have one) — always provisional 10%.
5. Machine-rate conflict unresolved ($5 DB vs $8 standard vs $25 legacy).
6. No overhead contribution or payment-processing allowance anywhere.
7. Display: "Ready" status does not distinguish verified-complete from
   estimated-$0 lines (machine/packing/freight all show as includable notes).
8. No reprint/spoilage allowance in quoted cost (actuals track it after the
   fact; nothing recovers it forward).

**P3**
1. Roll-width nesting/utilization unmodeled (flat 10% proxy).
2. Ink fixed at 0.6 ml/sqft (80% coverage assumption; 13A.8 calibration
   pending); per-channel DB usage model unused.
3. Weeding model is coarse area-based; contour complexity ignored.
4. Standard jars/soda can are code presets, not Cost Book records.
5. Zero-cost active template record (stock-bag) — data hygiene.

## Correction sequence, emergency patch, and owner decisions
See docs/GSO_ERP_PRICING_CORRECTION_PLAN.md. Fixtures with full component
tables: docs/GSO_ERP_CALCULATOR_QUOTE_FIXTURES.md. Component-by-family
matrix: docs/GSO_ERP_CALCULATOR_COST_MATRIX.md.
