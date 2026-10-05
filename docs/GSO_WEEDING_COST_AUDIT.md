# GSO Weeding Cost Audit (2026-10-05)

Scope: every place weeding is costed, what drives it, and how the single calibration object introduced today keeps the current rate exactly unchanged. **The weeding rate was NOT changed. The owner has NOT approved a new weeding rate. Owner timing data is pending.**

## 1. The standard in force

| Field | Value | Source |
|---|---|---|
| Labor rate | $20.00 / hour | `OWNER_STANDARDS.weedingPerPage54x54` basis (owner_verified) |
| Throughput | 15 reference pages / hour | same |
| Cost per page | $1.3333 (= 20 / 15) | same |
| Reference page | 54 in of feed length on the loaded roll (a 54 x 54 in page) | `WEEDING_REFERENCE_PAGE_IN` |
| Counting rule | pages = ceil(feedLengthIn / 54) PER PHYSICAL RUN, then summed; feeds are never combined before rounding | `finishing-cost.server.ts` `weedingPagesForRun` / `computeWeeding` |
| Applies to | every physical printed run off either printer; stickers/labels, sticker bags, stock bags, jar labels. Banners: not weeded | adapters pass `requiresWeeding` (bags true, labels true, jars true, banners false) |
| Status | owner_verified, effective 2026-08-19 (17D.4A) | `weeding-standard.ts` |

Since 2026-10-05 all of the above lives in ONE object: `app/lib/weeding-standard.ts` `WEEDING_STANDARD`. `finishing-cost.server.ts` re-exports its constants from that object and `OWNER_STANDARDS.weedingPerPage54x54.value` reads `WEEDING_STANDARD.costPerPage`. Tests pin that every number is identical before and after (`tests/weeding-standard.test.ts`, `tests/finishing-cost.test.ts`, `tests/product-family-registry.test.ts`).

## 2. Every code path that charges weeding

| Path | Driver | Rate source | Status |
|---|---|---|---|
| Canonical finishing (`finishing-cost.server.ts` `computeFinishing` -> stage key `weeding`, category finishing_application) | feed length per physical run from the nesting engine (`nesting-engine.server.ts`: margins + band feeds + gutters) | `WEEDING_STANDARD` | AUTHORITY for all canonical families |
| Jar adapter (`jar-cost-inputs.server.ts` `jarFinishingStages`) | side-body run + lid run feeds, `requiresWeeding: true` | same | canonical |
| Bag adapter (`bag-cost-inputs.server.ts`) | per printed side run | same | canonical |
| Label adapter (`label-cost-inputs.server.ts`) | per line run | same | canonical |
| Banner adapter | `requiresWeeding: false` | — | canonical (no weeding) |
| Legacy product-driven (`product-driven-costing.server.ts` ~l.823) | `ceil(baseSqft / 20.25 sqft)` pages, stickers only when the cut requires weeding | `OWNER_LABOR.weedingPerPage54x54` (-> `OWNER_STANDARDS` -> `WEEDING_STANDARD`) | legacy diagnostics (14C.2) |
| Legacy auto-costing (`auto-costing.server.ts` ~l.99) | caller-supplied `weedingPages` | same | legacy |
| Legacy emergency calculator (`calculator-emergency.server.ts` l.27) | caller-supplied pages | same | legacy |

Differences to note (documented, not changed): the legacy page basis is AREA (20.25 sqft per page) while the canonical basis is FEED LENGTH per run (54 in). Both resolve to the same $/page.

## 3. What does NOT affect weeding today

- Design complexity, contour vs square cut, specialty layers: no multiplier exists. Cutting is a separate stage (machine recovery + operator attention) with its own cut-type benchmark; it does not feed weeding.
- Label quantity directly: only through feed length (more labels -> longer feed -> more pages).
- Application: separate stage, per label.
- Setup: never charged inside weeding.

## 4. Where the current numbers came from

`OWNER_STANDARDS` records the basis text "$20/hour at 15 pages/hour" with status owner_verified and no measurement record or date in the repo beyond the 17D.4A finishing patch (2026-08-19). No timing log, sample count or difficulty breakdown exists in the repo. Treat 15 pages/hour as an owner-stated standard, not a measured one.

## 5. Calibration architecture (Phase 8/9)

- `app/lib/weeding-standard.ts`: the single `WEEDING_STANDARD` object (basis, rate, pages/hr, cost/page, reference page, rounding rule, source, status, effectiveFrom, version, notes). Changing production weeding = editing this object, nothing else.
- `app/lib/weeding-benchmark.ts`: pure analysis. `analyzeWeedingSample({ pages, pieces, elapsedMinutes, difficulty, notes })` -> minutes/page, pages/hour, pieces/minute, seconds/piece, labor cost per page and per piece, % vs the current standard, warnings. `summarizeWeedingBenchmark(samples)` -> time-weighted and median pages/hour, per-difficulty split, and CANDIDATE values (time-weighted, median, conservative, current). `parseWeedingSamplesCsv` reads `id,pages,pieces,minutes,difficulty,notes` lines. It never writes to the standard or the database (test-pinned).
- A "page" in a sample must be 54 in of feed on the loaded roll. Count pages from the RIP feed length, not labels.

## 6. Owner information needed (verbatim list)

For each timed weeding session:
1. Product and label geometry (e.g. Miron 100ml side labels 6.6 x 2.6).
2. Pages: feed length in inches on the roll (or number of 54 in pages).
3. Pieces: number of labels weeded.
4. Elapsed minutes (uninterrupted; note interruptions separately).
5. Difficulty: simple_rect / contour / complex_contour / specialty / mixed.
6. Operator and date.

Three or more sessions across different difficulties are needed before any candidate should be considered. Until the owner approves, production stays at $20/hr at 15 pages/hr.
