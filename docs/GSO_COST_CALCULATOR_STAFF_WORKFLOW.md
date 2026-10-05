# Cost Calculator — Staff Workflow for Fixed Products (2026-10-05)

## Normal jar quote (no typing of dimensions)

1. STEP 1: choose the product family (Standard Jars or Premium Jars).
2. Select the exact product / blank item (e.g. Miron 100ml Wide). Miron jars also need the physical top type.
3. Choose the **Label set**: Side Only, Lid Only, or Side + Lid. On sizes with an owner timing you may tick "Add tamper / lid-side band" (3oz/4oz show "not available").
4. Enter the quantity (finished jars) and number of designs.
5. Read the green **STANDARD PRODUCTION SPEC** box. It shows the dimensions the cost engine will use (e.g. "Side 6.6 x 2.6 in · Lid Ø 1.9 in"). You cannot edit it here.
6. Choose material and finish, leave printer on Auto, and Calculate.

What you get: one label of each selected kind per jar (Side + Lid on 128 jars = 128 side + 128 lid labels), two physical print runs, application charged per label, art setup once for side+lid, print setup once per job, packout and freight per jar.

## When the spec box is RED: "STANDARD PRODUCTION DIMENSIONS NOT CONFIRMED"

The product has no authoritative dimensions (or no product is selected). The quote will block. Do not guess sizes. Either select an exact product, or escalate to the owner via `docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md`.

## Custom size for one job (rare)

1. Open **Advanced / Custom Size Override** under the spec box.
2. Tick **CUSTOM SIZE OVERRIDE**. Enter only the pieces that differ; a blank piece keeps its standard size.
3. Enter a reason (saved with the quote).
4. Calculate. The spec box and the canonical cost panel show a yellow CUSTOM SIZE OVERRIDE badge, and the quote snapshot records both the standard and the override.

The override changes media, ink, cutting and weeding. It does NOT change application labor (owner per-size seconds), setup, blank cost, packout or freight.

Blocked cases (the quote shows a BLOCKER instead of a price): half-entered piece; value outside 0.126-54 in; size entered for a label not in the set; override on with nothing entered; custom values sent without the override tick.

## Warnings you must not ignore

- BLOCKERS in the canonical panel mean there is NO unit cost. The job is not $0.
- PROVISIONAL with `CUT_PATH_ESTIMATE_REQUIRED` is normal for jars today (derived cutlines).
- `MIMAKI_SPECIALTY_UNSUPPORTED`: white or gloss was forced onto the Mimaki. Use Auto or Roland.
- `MISSING_APPLICATION_STANDARD`: a tamper band on 3oz/4oz has no owner timing.

## Bags (4x5 sticker / stock)

Dimensions are fixed at the owner 4x5 artboard; no label set or override exists. MOQ 50.

## What changed for staff on 2026-10-05

- "How many labels per jar?" and "Are all label sizes the same?" plus the per-label width/height boxes are gone for jars. The label set replaces them and the dimensions come from the product spec.
- The legacy 14C.2 breakdown (diagnostics only) still receives the same dimensions automatically.
- Product Setup shows the cost-engine spec for jar recipes read-only above the label zones; label zones remain reference only.
- Cost Verification has a new read-only "Production standards in force" card (weeding, jar application, fixed-product specs).
