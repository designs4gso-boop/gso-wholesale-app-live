# GSO Fixed-Product Production Spec Audit (2026-10-05)

> **Release-gate note (2026-10-05, later the same day).** "Canonical costing geometry" does NOT mean "physically owner-confirmed production dimension". The Patch 2A jar table entered the repo in commit 5246607 self-labelled "owner presets" with no OWNER_STANDARDS entry, no dated decision and no measurement record. Every jar dimension is therefore classified **CANONICAL_COSTING_PENDING_CONFIRMATION**: it is what the cost engine prices with today (unchanged), it is NOT labelled owner-confirmed anywhere in the UI, and the authority status rides into every snapshot. Only the 4x5 bag artboard has explicit evidence (2D-4C2A benchmark on the actual artboard; live production) and is classified **OWNER_CONFIRMED**. Unknown products are **UNSUPPORTED** and fail closed.

Read-only audit of where the repo defines "what GSO normally prints" for each fixed product, which definition the canonical cost engine actually uses, and where definitions duplicate or conflict. Nothing in this document is inferred: every value is quoted from a repo file. Anything not found is marked MISSING or OWNER CONFIRMATION REQUIRED.

## 1. Authorities found

| Authority | File | Used by cost? | Notes |
|---|---|---|---|
| Jar label geometry (Patch 2A owner presets) | `app/lib/jar-label-geometry.ts` (extracted 2026-10-05 from `jar-cost-inputs.server.ts`, byte-identical) | YES, the only geometry any cost path reads | side rect, lid circle (diameter), tamper rect, per size key |
| Active jar scope (what GSO sells) | `app/lib/jar-active-scope.ts` | YES (scope gate) | 10 profiles: miron 50/100T/100W/150/250, chiron 100T/100W/150, standard 3oz/4oz |
| Jar application timings | `jar-cost-inputs.server.ts` `JAR_APPLICATION_SECONDS_BY_SIZE` at $20/hr | YES | side 12-15 s, lid 8-10 s, tamper 12 s or null (3oz/4oz) |
| Jar blank set costs | `MIRON_SET_COST`, `CHIRON_SET_COST`, `STANDARD_SET_COST` | YES | not restated here |
| Jar packout | `JAR_UNITS_PER_BOX`, $3.50/box | YES | |
| 4x5 bag artboard | `app/lib/bag-artboard-geometry.ts` (extracted from `bag-cost-inputs.server.ts`) | YES | 4.0 x 5.0 in; cutline 3.875 x 4.875 derived |
| RecipeLabelZone DB rows | seeded by `tools/seed-jar-label-zone-dimensions.mjs`; edited in Product Setup | NO (admin display only; module header in `jar-cost-inputs.server.ts` states "never by a cost path") | self-described "Estimated ... Verify with physical jar" |
| Legacy label rows (typed width/height) | `product-driven-costing.server.ts` `buildLabelRows` | NO (legacy 14C.2 diagnostics only) | this is what forced staff to type jar dimensions |
| Product-spec layer (new) | `app/lib/product-production-spec.ts` | n/a (reads the authorities above; adds no numbers) | `getProductProductionSpec(family, productKey)`, `listProductSpecs()` |

## 2. Jar-by-jar table

Status legend: KNOWN = cost authority holds a value; DUPLICATED = a second source restates it; CONFLICT = the second source disagrees; MISSING = no authority; OCR = OWNER CONFIRMATION REQUIRED.

### 2a. Authority classification per source (release gate)

| Source | Classification | Evidence |
|---|---|---|
| Patch 2A table (`jar-label-geometry.ts`), all 7 size keys | CANONICAL_COSTING_PENDING_CONFIRMATION | commit 5246607 self-labelled; no OWNER_STANDARDS record; `JAR_LABEL_GEOMETRY_AUTHORITY.ownerRecord = null` |
| RecipeLabelZone seed (`tools/seed-jar-label-zone-dimensions.mjs`), now mirrored read-only in `jar-reference-geometry.ts` | CONFLICTING_REFERENCE (NOT a cost authority; no cost module imports it, test-pinned) | seed rows self-described "Estimated ... Verify with physical jar" |
| Chiron 100ml Tall / 100ml Wide / 150ml | CANONICAL_COSTING_PENDING_CONFIRMATION + shared size key | no Chiron-specific geometry exists; costed on the Miron size key; `sharedSizeKeyNote` set |
| 3oz / 4oz tamper band | UNSUPPORTED for costing (no owner timing) | `JAR_APPLICATION_SECONDS_BY_SIZE` tamper = null -> blocks |
| 5oz (`jar_5oz_clear` or any 5oz key) | UNSUPPORTED | not in active scope; spec resolves null; engine refuses |
| 4x5 bag artboard | OWNER_CONFIRMED | 2D-4C2A benchmark on the actual 4x5 artboard vs cutline; live sticker-bag production |

Products marked OWNER_CONFIRMED: `bag-4x5/sticker`, `bag-4x5/stock`. Products marked PENDING: all 10 jar profiles. Blocked: 5oz, any non-active brand/size, 3oz/4oz tamper band.

Exact reference conflicts per selected piece (canonical -> reference): 50ml side 5.6x1.5 -> 5.75x1.625, lid 1.6 -> 1.75, tamper width 5.6 -> 5.75; 100ml Tall side 6.3x3.15 -> 6.125x3.125, tamper width 6.3 -> 6.125; 100ml Wide side width 6.6 -> 6.43, lid 1.9 -> 1.875, tamper width 6.6 -> 6.43; 150ml tamper height 0.6 -> 0.5; 250ml side 9.4x2.9 -> 9.375x2.875, lid 2.1 -> 2.0, tamper 9.4x0.6 -> 9.375x0.5; 3oz side 6.9x1.4 -> 7.1x1.7, lid 2.1 -> 2.0; 4oz side height 1.4 -> 2.125.

| Product (profile key) | Side (cost authority) | Lid Ø (cost authority) | Tamper (cost authority) | RecipeLabelZone seed (admin, estimated) | Status |
|---|---|---|---|---|---|
| Miron 50ml (`miron/50ml`) | 5.6 x 1.5 | 1.6 | 5.6 x 0.5 | side 5.75 x 1.625, lid 1.75, band 5.75 x 0.5 | KNOWN + CONFLICT (seed) -> OCR |
| Miron 100ml Tall (`miron/100ml_tall`) | 6.3 x 3.15 | 1.75 | 6.3 x 0.5 | side 6.125 x 3.125, lid 1.75 | KNOWN + CONFLICT (side) -> OCR |
| Miron 100ml Wide (`miron/100ml_wide`) | 6.6 x 2.6 | 1.9 | 6.6 x 0.5 | side 6.43 x 2.6, lid 1.875 | KNOWN + CONFLICT -> OCR |
| Miron 150ml (`miron/150ml`) | 7.125 x 3.125 | 2.0 | 7.125 x 0.6 | side 7.125 x 3.125, lid 2.0 | KNOWN + DUPLICATED (matches) |
| Miron 250ml (`miron/250ml`) | 9.4 x 2.9 | 2.1 | 9.4 x 0.6 | side 9.375 x 2.875, lid 2.0 | KNOWN + CONFLICT -> OCR |
| Chiron 100ml Tall (`chiron/100ml_tall`) | 6.3 x 3.15 (shares size key) | 1.75 | 6.3 x 0.5 | as 100ml_tall | KNOWN (same size key as Miron; owner has not confirmed Chiron-specific geometry) -> OCR |
| Chiron 100ml Wide (`chiron/100ml_wide`) | 6.6 x 2.6 | 1.9 | 6.6 x 0.5 | as 100ml_wide | KNOWN (shared key) -> OCR |
| Chiron 150ml (`chiron/150ml`) | 7.125 x 3.125 | 2.0 | 7.125 x 0.6 | as 150ml | KNOWN (shared key) |
| Standard 3oz Black/White (`standard/3oz`) | 6.9 x 1.4 | 2.1 | 6.9 x 0.5 (NO application timing -> blocks) | side 7.1 x 1.7, lid 2.0 | KNOWN + CONFLICT; tamper MISSING timing -> OCR |
| Standard 4oz (`standard/4oz`) | 7.125 x 1.4 | 2.1 | 7.125 x 0.5 (NO application timing -> blocks) | side 7.125 x 2.125, lid 2.1 | KNOWN + CONFLICT (side height); tamper MISSING timing -> OCR |
| 5oz placeholder (`jar_5oz_clear`) | none | none | none | 0 x 0 placeholder | MISSING; NOT exposed (not in active scope, not in spec list; test-pinned) |

Observations:
- The cost engine has always priced from the Patch 2A table; the seed values never reached a cost. The conflict is therefore a documentation/admin-display conflict, not a pricing bug, but the owner has never explicitly confirmed the Patch 2A numbers against physical jars. Logged as OCR in `GSO_PRODUCT_SPEC_OWNER_DECISIONS.md`.
- No merge was performed. Both sources remain; the spec layer surfaces the engine's values and discloses the seed conflict in `statusNote`.

## 3. Bags

| Product | Artboard | Cutline | Blank | MOQ | Status |
|---|---|---|---|---|---|
| 4x5 Sticker Bag (`bag-4x5/sticker`) | 4.0 x 5.0 in (`BAG_4X5_ARTBOARD_IN`) | 3.875 x 4.875 (derived) | `BAG_4X5_BLANK_UNIT_COST` | 50 (owner-approved 2026-10-04) | KNOWN |
| 4x5 Stock Bag (`bag-4x5/stock`) | same | same | same | 50 | KNOWN |
| 4x6 / 14x16 bags | not in canonical scope | — | — | — | out of scope today (unchanged) |

DTP pouches and Boxes remain legacy/manual per project authority and were not touched.

## 4. Jar label application cost audit (Phase 6)

| Source | Rate | Basis | Used by |
|---|---|---|---|
| `JAR_APPLICATION_SECONDS_BY_SIZE` + `APPLICATION_LABOR_RATE_PER_HOUR` ($20/hr) | per label per size: side 12-15 s ($0.0667-$0.0833), lid 8-10 s ($0.0444-$0.0556), tamper 12 s ($0.0667) or none | owner per-size timings (2D-4D2) | CANONICAL jar engine (per label, on finished jars) |
| `OWNER_STANDARDS.jarApplicationPerLabel` = $0.20 | per label | "$20/hour at 100 labels/hour" style flat rate, owner_verified status | LEGACY only: `calculator-emergency.server.ts` (`OWNER_LABOR.jarApplicationPer`), `cost-calculator.server.ts`, `product-driven-costing.server.ts` (14C.2 diagnostics), `auto-costing.server.ts` |
| "~$0.30 per jar" (owner memory) | — | NOT FOUND anywhere in the repo or docs | nothing |

Conclusions: the canonical basis is PER LABEL (a Side + Lid jar is two application events), charged on the FINISHED quantity, not the 1% production quantity. There is no per-jar flat rate in the canonical path and no duplicate application charge (one `application` line per job; pinned by `fixed-product-regression.test.ts`). The $0.30/jar figure needs owner confirmation of what it covered before it can be compared; see owner decisions doc.

## 5. Multi-piece cost audit (Phase 5) — 128 jars, Side + Lid

Pinned in `tests/fixed-product-regression.test.ts`:
- 128 side labels + 128 lid labels: `applicationEvents` 256, `physicalItems` 128, `applicationsPerItem` 2.
- Two physical runs (side-body run, lid run); media, ink, cutting, weeding and application are additive across Side Only + Lid Only.
- Charged once per job/jar: blank set, art setup (side+lid = ONE design), print setup (per job), packout, inbound freight. Side + Lid total is strictly less than Side Only + Lid Only.
- No line key is emitted twice; lines sum to the total.
- Inkable area uses the lid CIRCLE (pi r^2) and the side rectangle on the 1% production quantity; nesting uses the lid bounding box.
- Gloss/white: jars route by the shared canonical routing (CMYK -> Mimaki, specialty -> Roland); Mimaki + white/gloss blocks (`MIMAKI_SPECIALTY_UNSUPPORTED`).

## 6. Gaps the spec layer closes (and what it does not)

Closed: one resolver for standard dims; read-only display in the calculator, Product Setup and Cost Verification; explicit custom-size override with fail-closed validation; the spec used (and any override) recorded in every canonical quote snapshot via `diagnostics.productSpec`.

Not closed (owner): confirmation of the Patch 2A table against physical jars; Chiron-specific geometry if it differs from Miron; 3oz/4oz tamper timing; any 5oz product.

## 7. Downstream physical-production impact (release gate)

Consumers of `JAR_LABEL_GEOMETRY` / `jarCutGeometry` / `jarPhysicalRuns` / `diagnostics.productSpec` in `app/`: `canonical-calculator.server.ts`, `canonical-calculator-shared.ts`, `jar-cost-inputs.server.ts`, `jar-label-geometry.ts`, `product-production-spec.ts`, `jar-active-scope.ts`, and the three admin routes (cost calculator, product setup, cost verification). No production-artwork, cut-file, proof-geometry, RIP, art-preflight or production-transition module imports any of them (`productSpec` matches elsewhere are the unrelated `productSpecToken` in product-family-registry). The geometry drove COSTING only before this branch and drives COSTING only after it. Newly introduced physical artifact dependency: NO.

## 8. Live smoke follow-up (2026-10-05, branch costing-jar-live-smoke-fixes-2026-10-05)

Live fixture: Premium Jars, 100ml Tall Miron + lid, Standard top, qty 128, 1 design, Side + Lid, Poseidon Matte, AUTO, CMYK -> canonical 430.0861 / 3.3600 PROVISIONAL (CUT_PATH_ESTIMATE_REQUIRED), 256 application events, 128 physical items, 2 weeding pages. Reproduced exactly offline with production-shaped calibration rows and captured to `tests/fixtures/jar-live-smoke-100ml-tall-2026-10-05.json` BEFORE any change; re-pinned after. Customer price 128 @ $8.00 = $1,024.01 comes from the owner pricing config in the DB and is not reproducible offline; no pricing module was touched.

**CUT_PATH_ESTIMATE_REQUIRED, exact cause.** Cut path is computed per band in `finishing-cost.server.ts` `bandCutPath` and summed in `computeFinishing`; nesting does not change it (separated cuts: qty x perimeter per band). Side rectangle: cutline derived from the artboard by the GSO -0.0625 in rule (6.175 x 3.025 in), perimeter 2 x (w + h), exact, NOT flagged. Lid circle: cut diameter 1.625 in, path pi x d, exact LENGTH, but the contour model is always flagged because the only owner-measured cutter benchmark is the straight-line 130 x 4x5 rectangle job (Mimaki NORMAL 203.27 in/min); the contour RATE is borrowed. The flag therefore applies to any job with a contour band (every jar job that includes a lid; kiss/die-cut labels), not to Side Only jars (which carry no cut-path flag but remain PROVISIONAL for two unrelated pre-existing reasons: operator attention 10% is OWNER_APPROVED_PROVISIONAL and the inbound freight basis is a provisional supplier pallet estimate). Removing the cut-path flag alone therefore could never make a jar job FINAL. Whether the borrowed rate over- or under-states contour time is unknown; it is not conservative by design. PROVISIONAL is preserved; the calculator now explains this in a "WHY CUTTING IS PROVISIONAL" card (`diagnostics.cutPathBasis`). To make lid jobs FINAL the owner must time a contour cut job (pieces, diameter, minutes, machine, mode). The stale comment in `jar-cost-inputs.server.ts` claiming jars fall back to artboard geometry was corrected.

**Application authority (three figures on one quote).**

| Figure | Module | Formula | Rate / basis | Authoritative? | Affects canonical cost? |
|---|---|---|---|---|---|
| 15.6444 | canonical: `resolveJarApplication` (`jar-cost-inputs.server.ts`) -> `application` line | 128 finished jars x (side 12 s + lid 10 s) / 3600 x $20 | $20/hr; owner per-size seconds ("confirmed by GSO jar label size list", 2D-4D2) | YES | YES |
| 51.20 | legacy 14C.2 `product-driven-costing.server.ts` | 256 labels x $0.20 | `OWNER_STANDARDS.jarApplicationPerLabel` ($20/hr at 100 labels/hr) | NO, legacy diagnostic only | NO |
| "$0.078125/label" card | calculator route 15G.3-M trust card, hard-coded text | 256 labels/hr @ $20/hr | `OWNER_STANDARDS.bagApplicationPerLabel4x5`, legacy 4x5 BAG standard | NO, display only; wrong standard on a jar quote | NO |

Fix: the trust card now shows the canonical standard per family from `diagnostics.applicationBreakdown` ("Jar application (owner per-size timings) @ $20/hr — side label 12s ($0.0667/label) · lid label 10s ($0.0556/label)"); the legacy 4x5 line is shown only when no canonical breakdown exists and is labelled legacy. The canonical panel gains an APPLICATION BREAKDOWN table (side / lid / total: seconds per label, $ per label, labels, cost) computed from the same owner seconds as the application line. The legacy 14C.2 application row is suffixed "legacy diagnostic only, not used by canonical quote"; its formula is unchanged. No application number changed.
