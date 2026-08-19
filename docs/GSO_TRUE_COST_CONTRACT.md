# GSO True Cost Contract (Patch 2A, 17D.2)

The canonical definition of **true manufacturing cost**. Commercial selling
price is a separate concern and is never computed by this engine.

Status: **implemented, wired to nothing.** `true-cost-engine.server.ts` is
imported only by its test. No storefront, checkout, or pricing path can move.

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
              = ceil(1000 × 1.01) = 1010     (jars, 1% owner standard)
```

---

## 4. Jar owner rules (Patch 2)

**Application labor** — $20/hr, on finished quantity only:
side 45 s = $0.25 · lid 22 s = $0.12222 · **side+lid 67 s = $0.372222** ·
tamper +45 s = $0.25.

**Setup** — side + lid together are **one design**.
Art $12.50 ($25/hr at 2 designs/hr) + print $2.00 ($25/hr at 12.5 jobs/hr).
Optional tamper is a **second design at +$10 art with no extra print setup**,
so side+lid+tamper = $22.50 art + $2.00 print.

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
historical $0.2889 is retired). Equipment recovery $8/hr.

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
| Equipment recovery | 8.00 |
| Operator attention (10% × $25) | 2.50 |
| **Combined** | **10.50** |

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

The future deterministic nesting/layout engine computes actual consumed media —
gutters, margins, unused roll width, row/column spacing, orientation/rotation
inefficiency and feed length — and **that result IS `materialFootprintSqft`**.
Adding a separate waste percentage on top of it would double-count.

```
nesting engine  ──►  materialFootprintSqft   (actual consumed media)
                     no multiplier, no uplift, no waste %
```

**Planned overage is a different thing entirely.** It is a production-QUANTITY
policy (make 1010 to ship 1000) and must never be confused with physical
nesting loss. The two are independent and are never multiplied together.

Until the nesting engine exists, adapters supply a bounding-box approximation
and label it, which forces `PROVISIONAL`.

---

## 9. Known gaps (block a `VALID` result today)

1. **No nesting model → no real `ripLayoutSqft`.** Tests pass the material
   footprint as a *labelled proxy*, which forces `PROVISIONAL`. Machine recovery
   AND operator attention are both approximate until a nesting model exists.
2. **Operator attention 10% is provisional**, not measured per machine/profile.
3. **`materialFootprintSqft` is still a bounding-box approximation.** It is
   superseded by the same nesting engine as gap 1, not by a waste percentage —
   see the note below.

Derived reference figures (1000 finished, Matte, heavy CMYK, side+lid, using the
proxy above):

| | Chiron 100 ml Wide | Miron 100 ml Tall |
|---|---|---|
| Derived unit cost (before attention) | $2.5008 | $2.8114 |
| **Derived unit cost (with 10% attention)** | **$2.5095** | **$2.8210** |
| Owner working target | ≈ $2.53 | ≈ $2.84 |
| Residual gap | $0.0205 | $0.0190 |

Adding operator attention closed roughly a third of each residual and the two
remain consistent with one another, which continues to point at a single
shared cause rather than a per-family error. The targets are recorded as
**reference only** and are deliberately not asserted in tests; closing what
remains requires the deterministic nesting engine, not a plug figure.

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
