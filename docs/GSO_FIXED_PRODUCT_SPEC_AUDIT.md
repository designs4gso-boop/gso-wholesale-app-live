# GSO Fixed-Product Production Spec Audit (2026-10-05)

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
