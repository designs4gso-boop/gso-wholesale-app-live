# GSO Nesting / Layout Contract (Patch 2B, 17D.3)

The canonical definition of **how a job is laid onto media**. One deterministic
engine — `app/lib/nesting-engine.server.ts` — serves jars, stickers, labels,
4x5 sticker bags, stock bags, DTP pouches, boxes, banners and every future
roll-fed product. Product families contribute items and runs through their own
adapter; they never get their own layout maths.

Status: **implemented, wired to nothing.** Imported only by
`jar-cost-inputs.server.ts` and the two test files. No storefront, checkout or
pricing path can move. `true-cost-engine.server.ts` was **not modified**.

---

## 1. What it produces — and what it does not

| Area | Produced here? | Definition | Consumer |
|---|---|---|---|
| `inkableArtworkSqft` | **No** | real printed shape area — a circular lid is `π r²` | ink |
| `ripLayoutSqft` | **Yes** | the box the RIP reports and the head traverses | machine recovery + operator attention |
| `materialFootprintSqft` | **Yes** | media physically consumed | materials |

The three are never collapsed. Ink keeps its own denominator because a circle
is not its bounding box; occupancy keeps its own because the head sweeps a
layout, not artwork.

**No waste percentage exists.** `materialWastePct`, `nestingWastePct`,
`wasteFactor`, `wastePct`, `wasteMultiplier` — none of them are fields here and
none ever will be. Physical loss *is* the layout: unused web width, blank slots
in the last row, and the feed the run actually consumes. See
`GSO_TRUE_COST_CONTRACT.md` §8c.

---

## 2. The placement law

Derived from production evidence, not invented:

```
usableWidth = printableWidthIn − leftMargin − rightMargin
columns     = floor((usableWidth + gutterH) / (itemWidth + gutterH))
rows        = ceil(quantity / columns)
bandFeed    = rows × itemHeight + (rows − 1) × gutterV
feedLength  = topMargin + Σ bandFeed + (bands − 1) × gutterV + bottomMargin
```

Each `groupKey` becomes one **band**. Bands stack along the feed in the
adapter's declared order — stable, never re-sorted, so the result is
reproducible.

**Reproduction against 555 accepted Roland production jobs**
(`analysis-output/roland/roland-cleaned-records.csv`, tracked in git):

| | jobs | share |
|---|---|---|
| feed within **5%** | 542 / 555 | **97.7%** |
| feed within 0.5% | 513 / 555 | 92.4% |
| rotation enabled | 542 | — |
| rotation disabled | 482 | — |

Regression threshold in `tests/nesting-engine.test.ts` is **≥90%**, and it is
never to be lowered to make a test pass.

---

## 3. Gutters and margins

Owner-approved defaults:

```
horizontalGutterIn = 0
verticalGutterIn   = 0
```

Evidence: the Mimaki 130-copy benchmark packs `13 × 3.989 = 51.857in` against
an observed `51.855in` — no horizontal gap. Across 481 multi-row Roland jobs the
vertical gutter `(areaY − rows × pageY) / (rows − 1)` has median **0.0000in**,
and 400/481 (83.2%) sit inside ±0.005in.

Both fields stay **explicit and overrideable** for future products and profiles.
Gutter support is never removed from the engine.

---

## 4. Rotation

90° rotation is **permitted by default** for jar side labels, jar tamper
labels, jar lid bounding boxes, stickers, labels, 4x5 sticker bags and stock
bags. An adapter disables it per item with `allowRotate: false`; a policy
disables it for a whole job with `allowRotation: false`.

The engine computes both orientations and takes the **smaller feed**. Ties
resolve **unrotated**, deterministically, so input order can never change the
answer.

Rotation is not decorative: it lifts the 555-job replay from 482 to 542 jobs.

---

## 5. Widths — three distinct fields, never conflated

| Field | Meaning |
|---|---|
| `mediaWidthIn` | nominal width of the loaded roll — the **media consumed** basis |
| `printableWidthIn` | placement window — what columns are computed against |
| `sweptWidthIn` | carriage sweep width the RIP reports (`swept_width` only) |

### Mimaki UCJV300-130 — `OWNER_APPROVED_PROVISIONAL`

```
printableWidth = min(loadedMediaWidthIn, 53.6)
   54in media -> 53.6in        50in media -> 50.0in
```

Not supplier- or RIP-verified. The 130-copy benchmark is **insensitive** to the
remaining uncertainty — 13 columns is the answer at 52.4, 52.9 and 53.6 alike.

### Roland TrueVIS LG-640 — `PROVISIONAL_EMPIRICAL`

`52.9in` is the **machine maximum** and is deliberately *not* used as every
job's swept width. Operational widths come from the 555-job evidence:

| Roll | Working width | Cluster |
|---|---|---|
| 54 in | **52.4** | n = 222 |
| 50 in | **49.1** | n = 39 |

An **unlisted roll blocks** with `MISSING_PRINTABLE_WIDTH` rather than
extrapolating. The table is data, not specification, and is overrideable.

### Actual beats default

When a historical job has a captured RIP `Print Area_X`, that value wins and is
classified `HISTORICAL_ACTUAL_RIP` — the effective imaging window is known, so
no roll-width argument is needed.

---

## 6. RIP box convention — per machine, never global

The two RIPs report a **different box**, and the live Patch 1 calibrations were
measured against those different boxes. One shared convention would silently
change printing minutes.

| Machine | `ripBoxConvention` | `ripWidthIn` is | Calibration measured on it |
|---|---|---|---|
| Mimaki (RasterLink) | `nest_bbox` | the nested bounding width `cols × itemWidth` | 1.444 min/sqft |
| Roland (VersaWorks) | `swept_width` | `Print Area_X`, the swept carriage width | 0.91 min/sqft |

Feed length is convention-free — both conventions return the same
`feedLengthIn` for the same layout. Only the width differs.

---

## 7. Material consumption

For a standalone roll-fed production run:

```
materialFootprintSqft = loadedMediaWidthIn × physicalFeedLengthIn / 144
```

The unused web width is **consumed/scrap** for that run. Never
`nestWidth × feed`, and never a percentage on top.

A future cross-job gang-scheduling system may allocate shared media
differently. That is outside Patch 2B.

---

## 8. Multiple physical runs

**Setup grouping and physical-run grouping are different concepts.**

| | Jars |
|---|---|
| **Setup grouping** | side + lid = ONE artwork/design. Optional tamper = a second design. |
| **Physical runs** | RUN 1 = side (+ optional tamper). RUN 2 = lid. |

Lid labels are a separate physical print run. Each run gets its own layout,
feed, `materialFootprintSqft`, `ripLayoutSqft` and machine occupancy; job
totals are the **sum**. Feeds are **never combined** across runs.

Two physical runs do **not** create a second print-setup charge. Setup stays
$12.50 art + $2.00 print for side+lid, $22.50 art + $2.00 print with tamper.
The nesting engine charges no money at all.

```
physicalRuns: [
  { key: "side-body-run", items: [side, tamper?] },
  { key: "lid-run",       items: [lid] },
]
```

A lid-only job produces exactly one run. Per-run policy overrides are supported
(a different media on the lid run).

---

## 9. Lid geometry — two bases, kept apart

| Purpose | Basis | 150 ml example |
|---|---|---|
| Ink | circle `π r²` | `π × 1² = 3.1416 sq in` |
| Nesting / material / placement | diameter bounding box | `2.0 × 2.0 = 4.0 sq in` |

The band reports both: `usedShapeAreaSqIn` carries the circle,
`boundingItemAreaSqIn` carries the square, and utilisation is honest about the
difference.

---

## 10. Blockers — a missing width never falls back

| Condition | Code |
|---|---|
| No loaded media width | `MISSING_MEDIA_WIDTH` |
| No resolved placement width, or an unlisted roll, or an unknown machine | `MISSING_PRINTABLE_WIDTH` |
| Item wider than the window in **both** orientations | `ITEM_EXCEEDS_PRINTABLE_WIDTH` |
| Non-positive width / height / quantity | `INVALID_NESTING_ITEM` |
| Run with no items | `EMPTY_PHYSICAL_RUN` |
| `groupingPolicy` other than `band_per_group` | `UNSUPPORTED_GROUPING_POLICY` |

A blocked nest returns `ripLayoutSqft: null`, which raises the true-cost
engine's existing `MISSING_NESTING_MODEL` and produces `DRAFT_ONLY` with a
**null unit cost**. Never a guessed width, never a silent number.

---

## 11. Validation results

### A — Mimaki 130 × 3.989 × 5.000

| | Derived | Observed | Delta |
|---|---|---|---|
| columns × rows | 13 × 10 | 13 × 10 | — |
| nest width | 51.857 in | 51.855 in | +0.002 |
| feed | 50.000 in | 50 in | 0 |
| `ripLayoutSqft` | **18.00590** | 18.005 | **+0.030%** |

Zero gutters, zero margins, no blank slots. Material at the full 54 in web =
18.75 sqft.

### B — Roland Flame Society 150 ml, 35 sets, side + tamper / lid

Swept width `49.1043in` (actual captured `Print Area_X`).

| | Derived | Observed |
|---|---|---|
| **inkable** | 7.214414 sqft | **7.2144** ✓ exact — proves the part mix |
| run 1 side | 6 cols × 6 rows → 18.750 in | |
| run 1 tamper | 6 cols × 6 rows → 3.600 in | |
| **run 1 feed** | **22.350 in** | |
| run 2 lid | 24 cols × 2 rows → 4.000 in | |
| **run 2 feed** | **4.000 in** | |
| total feed | 26.350 in | 26.1508 in |
| **`ripLayoutSqft`** | **8.98540** | **8.9175** → **+0.761%** |
| material (54 in web) | 9.88125 sqft | — |

Reported as a delta, not forced to equality. The residual is the last row of
each band packing looser than the RIP's own arrangement.

### C — Chiron 100 ml Wide, 1000 finished (1010 production), Mimaki, 54 in

```
run 1  side  8 cols x 127 rows          feed 330.20in   rip 121.0733 sqft
run 2  lid  28 cols x  37 rows          feed  70.30in   rip  25.9719 sqft
       ripLayoutSqft        147.0453   (Patch 2A proxy 145.6785, +0.94%)
       materialFootprint    150.1875   (Patch 2A proxy 145.6785, +3.09%)
       total  $2,511.3141   was $2,509.5458
       unit   $2.511314     was $2.509546      delta +$0.001768
```

### D — Miron 100 ml Tall, 1000 finished (1010 production), Mimaki, 54 in

```
run 1  side 17 cols x  60 rows ROTATED  feed 378.00in   rip 140.5687 sqft
run 2  lid  30 cols x  34 rows          feed  59.50in   rip  21.6927 sqft
       ripLayoutSqft        162.2615   (Patch 2A proxy 160.6707, +0.99%)
       materialFootprint    164.0625   (Patch 2A proxy 160.6707, +2.11%)
       total  $2,822.4962   was $2,821.0238
       unit   $2.822496     was $2.821024      delta +$0.001472
```

Rotation on the Miron side run (17 × 60 = 378.00 in beats 8 × 127 = 400.05 in)
saves 22.05 in of feed and is why D moves less than a bounding-box model would
predict.

### Residual gaps — REFERENCE ONLY, never asserted

| | after nesting | owner working target | residual | was |
|---|---|---|---|---|
| Chiron 100 ml Wide | $2.5113 | ≈ $2.53 | **$0.0187** | $0.0205 |
| Miron 100 ml Tall | $2.8225 | ≈ $2.84 | **$0.0175** | $0.0190 |

**Real nesting does not close the gap.** It closes roughly 9% of Chiron's and
8% of Miron's. The residual was previously attributed to the missing nesting
model; that attribution is now measured and mostly wrong. The two residuals
remain close to one another, which continues to point at a single shared cause
rather than a per-family error — still unidentified. Nothing here is tuned
toward $2.53 / $2.84.

---

## 12. Known gaps

1. **Mimaki captures no layout data at all.** `rasterlink-parse.server.ts`
   extracts zero dimensions and `PrintLogEntry` holds no RIP dims, so every
   Mimaki figure is n=1 owner-supplied. The JobInfo→CSV converter is
   unlocated. Outside Patch 2B.
2. **Placement widths are provisional** — Mimaki `OWNER_APPROVED_PROVISIONAL`,
   Roland `PROVISIONAL_EMPIRICAL`. Neither is supplier- or RIP-verified.
3. **Bands pack independently.** A real RIP may tuck a short last row of one
   band beside another; the engine does not. This is the +0.761% on validation
   B and it errs **high**, never low.
4. **No cutting, weeding or handling model.** Patch 2B deliberately implements
   none. It exposes `rows`, `columns`, `layouts`, `feedLengthIn`, `itemsPlaced`,
   `blankSlots` and per-band placement so those models can be built later on
   real diagnostics rather than on `ceil(sqft / 20.25)`.
5. **Cross-job ganging is not modelled.** Every run is priced standalone and
   pays for its full web width.

---

## 13. Live safety

Nothing is wired. `tests/nesting-engine.test.ts` asserts that ten live pricing
and storefront modules import neither `nesting-engine`, `true-cost-engine` nor
any `-cost-inputs` adapter, and that `true-cost-engine.server.ts` still has
exactly one import and its 17D.2 version stamp.

No schema change, no migration, no seed, no deploy. Jar selling prices, Stock
Bag pricing, sticker pricing, DTP pricing, checkout, Shopify variants and RIP
routing are all untouched.
