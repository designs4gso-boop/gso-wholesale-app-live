# GSO True Cost Contract (Patch 2A, 17D.2)

The canonical definition of **true manufacturing cost**. Commercial selling
price is a separate concern and is never computed by this engine.

Status: **implemented, wired to nothing.** `true-cost-engine.server.ts` is
imported only by its test. No storefront, checkout, or pricing path can move.

Layout is a separate contract: `GSO_NESTING_CONTRACT.md` (Patch 2B) defines how
`ripLayoutSqft` and `materialFootprintSqft` are produced.

---

## 1. The ten components

```
TRUE JOB COST =
    Materials
  + Ink
  + Setup Labor
  + Run Labor
  + Finishing / Application
  + Machine / Equipment Recovery
  + Planned Overage
  + Packaging / Packout
  + Inbound Freight
  + Outside Costs
```

Planned Overage is a **quantity effect, not a charge**. It raises production
quantity so blanks, media, ink and inbound freight already price at the higher
number. It contributes `$0` as a line so nothing is double-counted.

> **Jar 1% overage — OWNER-VERIFIED (2D-4D3, 2026-08-25).** Recorded as
> `OWNER_STANDARDS.jarPlannedOveragePct`, so the cost path reads the decision
> authority rather than a comment. 500 finished jars are produced as 505. It is
> applied ONCE to produced-quantity inputs — blank complete sets, print media,
> ink and their inbound freight allocation — never compounded, never a separate
> charge, and packout still counts finished jars. 2D-4D2 had disclosed it as an
> unverified assumption because the figure had no owner record at all; the owner
> has now confirmed the number, so the disclosure is gone rather than replaced.

---

## 2. The three areas — never collapse them

| Area | Definition | Used for |
|---|---|---|
| `inkableArtworkSqft` | printable artwork/shape area. **A circular lid uses its actual circle area** `π r²`. | ink |
| `ripLayoutSqft` | the nested layout the print head traverses | machine / equipment recovery |
| `materialFootprintSqft` | media physically consumed — bounding boxes plus nesting | materials |

They differ materially. For a 100 ml Wide lid:

```
circle  π × (1.9/2)²  = 2.8353 sq in
bbox    1.9 × 1.9     = 3.6100 sq in     → 27.3% larger
```

Substituting one for another is a costing error, not a rounding detail. Every
`MachineProfileCalibration` row therefore records its own `inkAreaBasis` and
`timeAreaBasis`, and the engine passes an `areas` map so each calibration
selects its own denominator.

**Coverage scales ink only.** The head traverses the full layout regardless of
how much of it carries ink, so occupancy is never coverage-scaled.

---

## 3. Quantity basis — which components use which

| Component | Basis |
|---|---|
| Blanks / complete sets | **production** qty |
| Print media | **production** qty (via area) |
| Ink | **production** qty (via area) |
| Inbound freight | **production** qty |
| Finishing / application | **customer finished** qty |
| Packout (boxes) | **customer finished** qty |
| Setup, run labor | per job |

```
productionQty = ceil(customerFinishedQty × (1 + overagePct/100))
              = ceil(1000 × 1.01) = 1010     (jars, 1% — see the note below)
```

---

## 4. Jar owner rules (Patch 2)

**Application labor** — $20/hr, on finished quantity only, charged once per
label actually applied. **Per size** (2D-4D2), from the owner timings live in
`RecipeLabelZone`:

All values below are owner-approved.

| Size | Side | Lid | Tamper / lid-side band |
|---|---|---|---|
| 50 ml | 12 s | 10 s | 12 s |
| 100 ml tall | 12 s | 10 s | 12 s |
| 100 ml wide | 12 s | 10 s | 12 s |
| 150 ml | 13 s | 10 s | 12 s |
| 250 ml | 15 s | 10 s | 12 s |
| 3 oz | 10 s | 8 s | **none recorded — blocks** |
| 4 oz | 10 s | 8 s | **none recorded — blocks** |

This replaces the flat side 45 s / lid 22 s / tamper 45 s that Patch 2A carried.
Those three numbers had no rate derivation, no measurement and no owner
citation, and Patch 2A's own header excluded application seconds from what it
claimed authority over. "Tamper" here and "Lid side label" in the zone rows are
the same optional band — same circumference width, same 0.5–0.6 in height, both
optional. The plain oz jars have no such band recorded, so asking for one
BLOCKS rather than borrowing another size's timing.

**Setup** — the **basis** is jar-specific and unchanged; the **rates** are the
owner-verified globals (2D-4D2):

| | Basis | Rate |
|---|---|---|
| Art | `PER_DESIGN` — side + lid together are **one design** | `OWNER_STANDARDS.artSetupPerDesign` = $8.333333 |
| Print | `PER_JOB` — once per job, whatever the design or run count | `OWNER_STANDARDS.printSetupPerDesign` = $1.000000 |

An optional tamper band is a **second design**, so it is a **second art setup
event** and still no extra print setup. This replaces art $12.50
("$25/hr at 2 designs/hr"), a flat +$10 tamper surcharge with no rate at all,
and print $2.00 ("$25/hr at 12.5 jobs/hr") — none of which had an owner-approved
jar-specific rate behind them.

**Packout** — $2.00 labor + $1.50 consumables = **$3.50 per finished box**.

| Size | Units/box | Size | Units/box |
|---|---|---|---|
| 50 ml | 100 | 250 ml | 25 |
| 100 ml tall | 100 | 3 oz | 150 |
| 100 ml wide | 100 | 4 oz | 100 |
| 150 ml | 50 | | |

`boxes = ceil(customerFinishedQty / unitsPerBox)`

**Geometry presets** — side and tamper rectangular, lid circular by diameter.
Recorded in `jar-cost-inputs.server.ts`. These are the Patch 2 authority and
deliberately do **not** overwrite the older `RecipeLabelZone` rows, which carry
different estimated geometry and application seconds and are read only by admin
screens — never by a cost path.

---

## 5. Inbound freight

| Family | Basis | Status |
|---|---|---|
| Genuine Miron | $315/pallet ÷ **verified supplier capacity** (50 ml 5376 · 100 ml tall 3360 · 100 ml wide 3080 · 150 ml 2400 · 250 ml 1760) | `PROVISIONAL_SUPPLIER_PALLET` |
| Chiron / standard | per-unit allowance from Safe Care invoices + physical carton measurement | `PROVISIONAL_INVOICE_DERIVED` |

Invoice-derived allowances (owner amendment):

| Family | $/jar |
|---|---|
| 100 ml Chiron Tall | 0.139 |
| 100 ml Chiron Wide | 0.139 |
| 150 ml Chiron | 0.160 |
| 3 oz Standard | 0.089 |
| 4 oz Standard | 0.129 |

Physical carton evidence: 100 ml 21.5×11×8.25 in / 100 jars / 15.56 kg ·
150 ml 12×12×9 in / 50 jars / 10.2 kg · 3 oz 23.5×12×8.5 in / 150 jars / 14.2 kg ·
4 oz 12.5×12.5×13 in / 100 jars / 13.2 kg.

Derived planning capacities (48×40 pallet, 60 in loaded height) are
`DERIVED_STANDARD_PALLET`, **not** supplier-confirmed: 100 ml 3600 · 150 ml 3600 ·
3 oz 5400 · 4 oz 3600.

Supporting invoices #16651, #16731, #16636 are **mixed shipments** and must never
be presented as standalone jar freight invoices.

**These are allowances, not tariffs.** A numeric cost may be produced, but the
job result stays `PROVISIONAL` until a stronger supplier/carrier basis replaces
them. Nothing here is ever classified `VALID`.

---

## 6. Purchasing vs calibration — kept apart

| Concern | Owns | Source |
|---|---|---|
| Calibration | mL/sqft/pass, min/sqft | `MachineProfileCalibration` (Patch 1) |
| Purchasing | $/mL, $/sqft | `ink-rates-shared.ts`, `APPROVED_ROLL_COSTS` |

```
inkCost = calculatedInkMl × currentCanonicalInkCostPerMl
```

**No money is ever stored on a calibration row.** Current provisional rates:
Roland $149/750 mL = $0.1986667/mL · Mimaki $176/1000 mL = $0.176/mL ·
Poseidon Matte $213 / 675 sqft = **$0.3155556/sqft** (verified 2026‑07‑17; the
historical $0.2889 is retired). Equipment recovery **$5/hr — OWNER APPROVED 2026-10-07** for both the Roland LG-640 and the Mimaki UCJV300-130 (basis: retail replacement value ~$24,395 / ~$21,995 vs ~$10,000 purchase each, high utilization — minimum 8 h/day x 5 d/wk, Roland normally 16–18 h/day, Mimaki 8–12 h/day — plus maintenance / electricity / contingency; covers capital replacement reserve, maintenance/service, electricity/operating allowance and equipment contingency only, never labor, ink, media, setup, cutting, weeding, application or commercial profit). Previous: $8/hr PROVISIONAL (13A.7B). Environment override `GSO_MACHINE_RATE_PER_HOUR` preserved; the canonical default is $5.00.

---

## 7. Machine routing

Roland LG‑640 is **required** for any White or Gloss work. CMYK‑only defaults to
the Mimaki UCJV300‑130 unless the filename / ERP assignment explicitly specifies
Roland, or owner routing chooses Roland for overflow or colour quality.

---

## 8. Result statuses — never a silent zero

| Status | Meaning |
|---|---|
| `VALID` | every input verified |
| `PROVISIONAL` | numeric, but at least one basis is provisional |
| `DRAFT_ONLY` | blocked; **`unitCost` is `null`** — a blocked job never publishes a per-unit number |

Blocking conditions, all explicit:

| Condition | Code |
|---|---|
| Unverified blank (e.g. Chiron 50 ml) | `MISSING_COST` |
| White selected with no coverage | `WHITE_COVERAGE_REQUIRED` |
| Emboss/Raised, or any uncalibrated profile | `MISSING_CALIBRATION` |
| No `ripLayoutSqft` | `MISSING_NESTING_MODEL` |
| No freight basis | `MISSING_FREIGHT_BASIS` |
| No print-media $/sqft | `MISSING_COST` |

Nothing falls back to a legacy constant. Emboss/Raised must never be faked by
multiplying GlossVarnish.

---

## 8b. Operator attention (run labor)

Normal printer tending is ~6 minutes or less of active operator attention per
60 minutes of machine occupancy, so run labor for a printed job is charged as a
**share of machine occupancy**, not as dedicated hours:

```
runLabor = machineOccupancyHours × operatorAttentionPct × operatorLaborRate
         = occupancyHours × 10% × $25/hr
```

The operator is **not** dedicated to the press and does other productive work
while it runs. The allowance covers tending only: checking output, checking
media remaining, monitoring ink, responding to ink changes, head-crash and
media problems, responding to warnings, periodic inspection.

**Print setup/launch is a separate component and is never double-counted here.**

Combined printer burden per machine-occupancy hour:

| | $/hr |
|---|---|
| Equipment recovery (owner approved 2026-10-07; was 8.00 provisional) | 5.00 |
| Operator attention (10% × $25) | 2.50 |
| **Combined** | **7.50** |

Classification `OWNER_APPROVED_PROVISIONAL` — it makes a job `PROVISIONAL`,
never `DRAFT_ONLY`. Currently 10% for Mimaki CMYK, Roland CMYK, Roland White
and Roland Gloss alike; the percentage and rate are overridable per
machine/profile when a future owner measurement justifies it. Occupancy is
resolved **once** and shared by both burdens, so they can never disagree.

Universal across jars, stickers, labels, 4x5 sticker bags, stock bags, DTP,
boxes and banners.

---

## 8c. No generic material-waste factor — by design

The engine has **no** `materialWastePct`, `nestingWastePct` or `wasteFactor`
field, and it never will. Physical media loss is not a percentage applied on
top of an idealised area; it is the layout itself.

The deterministic nesting/layout engine (Patch 2B,
`app/lib/nesting-engine.server.ts`) computes actual consumed media — gutters,
margins, unused roll width, row/column spacing, orientation/rotation
inefficiency and feed length — and **that result IS `materialFootprintSqft`**.
Adding a separate waste percentage on top of it would double-count. That engine
carries no waste field of any kind and a test pins the absence.

```
nesting engine  ──►  materialFootprintSqft   (actual consumed media)
                     no multiplier, no uplift, no waste %
```

**Planned overage is a different thing entirely.** It is a production-QUANTITY
policy (make 1010 to ship 1000) and must never be confused with physical
nesting loss. The two are independent and are never multiplied together.

Families without a nesting adapter still supply a bounding-box approximation
and label it, which forces `PROVISIONAL`. Jars no longer do.

**Planned overage and nesting are also never combined.** Overage sets the
production quantity, the nesting engine lays that quantity out, and the engine
never re-applies the percentage to any area.

---

## 9. Known gaps (block a `VALID` result today)

**Gaps 1 and 3 closed for jars in Patch 2B** — `app/lib/nesting-engine.server.ts`
now supplies real `ripLayoutSqft` and `materialFootprintSqft`. See
`GSO_NESTING_CONTRACT.md`. `true-cost-engine.server.ts` needed **no change**:
the adapter fills `areas` and the engine consumes summed totals unaltered.

1. ~~No nesting model~~ → **closed for jars.** A deterministic two-physical-run
   layout (run 1 side + optional tamper, run 2 lid) reproduces the Mimaki
   benchmark to +0.030% and 542/555 real Roland jobs within 5%. Families
   without an adapter still pass a labelled proxy and stay `PROVISIONAL`.
2. **Operator attention 10% is provisional**, not measured per machine/profile.
3. ~~Bounding-box material footprint~~ → **closed for jars.**
   `materialFootprintSqft` is now `loadedMediaWidthIn × feedLengthIn / 144` —
   the unused web width is real consumed scrap, not a percentage.
4. **Placement widths are provisional** — Mimaki `OWNER_APPROVED_PROVISIONAL`
   (`min(media, 53.6in)`), Roland `PROVISIONAL_EMPIRICAL` (54in roll → 52.4in,
   50in roll → 49.1in). Neither is supplier- or RIP-verified.
5. **The residual is no longer explained by nesting** — see below.

Derived reference figures (1000 finished, Matte, heavy CMYK, side+lid):

| | Chiron 100 ml Wide | Miron 100 ml Tall |
|---|---|---|
| Unit cost — proxy, before attention | $2.5008 | $2.8114 |
| Unit cost — proxy, with 10% attention | $2.5095 | $2.8210 |
| **Unit cost — REAL NESTING (2B)** | **$2.5113** | **$2.8225** |
| Owner working target | ≈ $2.53 | ≈ $2.84 |
| **Residual gap** | **$0.0187** | **$0.0175** |

Real nesting moved the numbers by **+$0.001768** and **+$0.001472** per unit —
it closed roughly 9% and 8% of the residuals, not the whole of them. The
residual had been attributed to the missing nesting model; that attribution is
now measured and mostly wrong. The two residuals remain close to one another,
which still points at one shared cause rather than a per-family error, and that
cause is **not yet identified**. The targets stay **reference only**, are
deliberately not asserted in tests, and are never to be closed with a plug
figure.

---

## 10. Legacy engines this replaces (Patch 2B/2C, not yet)

| Engine | Fate |
|---|---|
| `computeProductDrivenCost` | to be replaced for jars first, then bags/stickers |
| `computeAutoCost` | delete — superseded, reachable only from the Cost Calculator |
| `priceRecipeAtQuantity` | rival formula (`operatorLaborPct` used as $/hr); migrate quotes off it |
| `computeLineCosts` | delete — legacy line math |

Legacy constants this engine deliberately does **not** use: jar application
$0.20/label · packout $2.00/box · flat 100 units/box · 10% waste · Mimaki
0.6 mL/sqft · art setup $8.3333/design · print setup $1.00/design.

Parity fixtures must be captured **before** Patch 2B touches any live path.

---

## 11. October 2026 state — CORE release (2D-4C2 → 2D-4E6)

Recorded 2026-10-03 on local branch `costing-october-core-release-2026-10-03`.
**Nothing in this section is deployed**; GitHub `origin/main` still ends at
`fd55e51`.

### Production state (read-only verified 2026-10-03)

* **All four approved canonical machine calibrations already exist in
  production** and match the approved definitions exactly (Mimaki
  `cmyk_heavy` 1.89 mL/sqft/pass, 1.444 min/sqft; Roland `cmyk` 1.4133 / 0.91;
  Roland `white` 6.0 / 1.71; Roland `gloss` 4.18 / 0.91). The calibration
  seed is **not** a deployment blocker. **Do not apply it.**
* **Chiron 100ml tall VendorProduct row is missing.** The seed
  (`tools/seed-chiron-100ml-tall-2d4d2.mjs`) is production-only, dry-run by
  default, would CREATE exactly one row at $1.80, and awaits owner approval
  AFTER the application deploy and smoke test.

### Completed phases in CORE (all local)

| Phase | What it locked | Where |
|---|---|---|
| 2D-4C2A | GSO label cutline authority: -0.0625 in inward offset path; rectangle W-0.125 × H-0.125; circle Ø-0.125. 4.000×5.000 bag label cuts at 3.875×4.875. Historical 3.79×4.81 / 130 pcs / 2236.0 in / 11.0 min sets cutter **speed only**. | `app/lib/gso-cutline.ts`, `finishing-cost.server.ts` |
| 2D-4C2D | **SUPERSEDED 2026-10-08.** Was: 4x5 blank bag supplier base cost $0.09 before inbound freight (owner-corrected 2026-08-24), $0.11 retired, no Approved Cost Update entry. | `bag-cost-inputs.server.ts`, `approved-cost-updates.server.ts` |
| 4X5-BLANK-2026-10-08 | **4x5 blank bag true base cost $0.11 EACH, regardless of colour — OWNER DECISION 2026-10-08.** One authority: `BAG_4X5_BLANK_UNIT_COST = 0.11`, Material "4x5 Blank Bag", VendorProduct `preset:blank-4x5-bag`, calculator preset, Approved Cost Updates entry `bag-4x5` (flat $0.11, no creation spec). $0.09 survives only as `BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24`. No generic freight uplift; inbound freight stays `FREIGHT_NOT_MODELED`. Sticker Bag and Stock Bag share it (1,000 bags = $110.00 blank line). | `bag-cost-inputs.server.ts`, `approved-cost-updates.server.ts`, `owner-standards.ts` |
| 2D-4D1 | Active jar scope (ten owner combinations; 100ml → `100ml_wide`, 100ml tall → `100ml_tall`); jars promoted to `CANONICAL_COST_AUTHORITY`; fail-closed list emptied, mechanism kept. | `jar-active-scope.ts`, `canonical-quote-authority.server.ts` |
| 2D-4D2 | Per-size jar application seconds (owner table); jar setup on owner global rates — art $8.333333 `PER_DESIGN` (side+lid one design, tamper a second), print $1.00 `PER_JOB`; multi-line label artwork identity declared per line. | `jar-cost-inputs.server.ts`, calculator route |
| 2D-4D3 | **Jar planned overage 1% — OWNER VERIFIED** (`OWNER_STANDARDS.jarPlannedOveragePct`, applied once, $0 line, packout on finished qty). **Chiron 100ml tall $1.80 — OWNER VERIFIED** (`CHIRON_SET_COST`, provenance dated 2026-08-25). | `owner-standards.ts`, `jar-cost-inputs.server.ts` |
| 2D-4E1 | Multi-line label jobs quote from canonical cost (job cost, unit cost, status, blockers, save eligibility); commercial per-line bands fed the canonical cost; finished quantity = sum of entered lines. | `multi-line-label-authority.server.ts` |
| 2D-4E2 | Custom 4x5 Sticker Bag MOQ 50 enforced in the canonical adapter (`STICKER_BAG_BELOW_MOQ`, eligibility only). | `bag-cost-inputs.server.ts` |
| 2D-4E3 | Quotes editor cannot retype a canonical manufacturing unit cost; blocked or re-quantified canonical items refuse to save. | `quote-item-cost-authority.ts`, `app.quotes.tsx` |
| 2D-4E4 | Agent Review Queue refuses to convert canonical-authority families on recipe tier cost (`canonical_authority_required`). | `agent-quote-canonical-gate.server.ts` |
| 2D-4E5 | Emergency / legacy-auto saves of a known canonical family reach the canonical gate via the researched margin family. | `canonical-calculator-shared.ts`, calculator route |
| 2D-4E6 | Quotes editor "price from recipe" refuses canonical-authority families (same gate as E4). | `app.quotes.tsx` |

### Canonical-authority families (October 2026)

`stickers-labels`, `sticker-bags`, `stock-bags`, `banners`, `standard-jars`,
`premium-jars`. `dtp-bags` and `boxes` are `LEGACY_OUTSOURCED` and are never
routed through Mimaki/Roland, ink, cutting or weeding math.

### Deliberately NOT in CORE

Commit `14a125d` (storefront and admin-preview pricing on the canonical
manufacturing cost basis) is **held** on branch
`costing-october-full-review-2026-10-03` with the owner decision packet
`docs/GSO_STOREFRONT_PRICING_DECISION_PACKET.md`. In CORE the public
configurator, checkout, Pricing Rules preview and Configurator admin still
price 4x5 bags and stickers on the legacy `computeProductDrivenCost` engine —
exactly as production does today. The holographic, die-cut and 5X/7X
commercial questions are therefore NOT part of the CORE release.

### Still open (owner data / production actions)

* Production-only: Chiron 100ml tall seed `--apply` (dry-run first), after
  deploy + smoke test, with owner approval.
* 4x5 blank inbound pallet freight: recorded carton facts, no rate — not
  invented, disclosed as `FREIGHT_NOT_MODELED`, never blocking.
* Banner hemming / grommets / pole pockets / double-sided / tube packout:
  fail-closed until owner rates exist.
* DTP future model: vendor tier cost + Southwest inbound freight + GSO
  handling/setup + legitimate outside charges. Boxes: vendor box cost +
  tooling/die/setup + Southwest inbound freight + GSO handling. Owner/vendor
  data incomplete.


## Machine recovery rate change — 2026-10-07 ($8/hr provisional → $5/hr owner approved)

Only the machine-recovery lines of the canonical true cost moved; every other component was verified identical line by line (the historical $8 captures are still checked in the test suite with the rate pinned explicitly). New control values: 3x3 sticker control 1,000 = **$79.617252 / $0.079617** (was $84.143290 / $0.084143); Miron 100ml Tall 128 Side + Lid = **$428.5026 / $3.3477** (was $430.0861 / $3.3600). DTP (outsourced) does not move. Customer pricing authorities are unchanged; market-target-controlled prices did not move, cost-floor-controlled prices (specialty 5X / 7X gloss bags, holographic + 3X, cost-plus Product Setup recipes) follow the lower true cost by their existing owner-approved rule — see the release readiness document.

# Machine recovery rate impact — $8/hr (provisional) -> $5/hr (OWNER APPROVED 2026-10-07)

Only the machine-recovery lines move; every other component is identical (verified line by line). DTP (outsourced) does not move.

| Control | Old total @ $8 | New total @ $5 | $ diff | Old unit | New unit | Unit diff | % diff | Lines that changed |
|---|---|---|---|---|---|---|---|---|
| 3x3 sticker control (1,000 matte, AUTO CMYK) | $84.1433 | $79.6173 | -4.5260 | $0.084143 | $0.079617 | -0.004526 | -5.38% | machine 12.0694 -> 7.5434 |
| 4x5 Sticker Bag (100, 1 face, 40% coverage) | $38.9603 | $37.9174 | -1.0429 | $0.389603 | $0.379174 | -0.010429 | -2.68% | machine 2.7810 -> 1.7381 |
| Roland CMYK job (1,000 x 3x3 matte, explicit Roland) | $73.5176 | $70.5870 | -2.9306 | $0.073518 | $0.070587 | -0.002931 | -3.99% | machine 7.8149 -> 4.8843 |
| Roland WHITE job (1,000 x 3x3, 1 white layer, 100% coverage) | $167.2918 | $158.8543 | -8.4375 | $0.167292 | $0.158854 | -0.008437 | -5.04% | machine_white 14.6851 -> 9.1782; machine 7.8149 -> 4.8843 |
| Roland GLOSS job (1,000 x 3x3, 1 gloss layer) | $109.7254 | $103.8643 | -5.8612 | $0.109725 | $0.103864 | -0.005861 | -5.34% | machine_gloss 7.8149 -> 4.8843; machine 7.8149 -> 4.8843 |
| Miron jar control (100ml Tall, 128, Side + Lid, AUTO CMYK) | $430.0861 | $428.5026 | -1.5835 | $3.360048 | $3.347677 | -0.012371 | -0.37% | machine 4.2228 -> 2.6392 |
| Stock Bag (100, 1 face, matte, representative $0.25 blank) | $59.9266 | $58.8948 | -1.0318 | $0.599266 | $0.588948 | -0.010318 | -1.72% | (none) |
| Banner control (one 3x6 ft, plain) | $31.4672 | $30.1299 | -1.3372 | $31.467151 | $30.129941 | -1.337209 | -4.25% | machine 3.5659 -> 2.2287 |
| DTP 4x5x2 x 1,000 (outsourced — must not move) | $860.6958 | $860.6958 | 0.0000 | $0.860696 | $0.860696 | 0.000000 | 0.00% | (none) |
