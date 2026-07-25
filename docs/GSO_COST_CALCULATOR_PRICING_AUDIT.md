# GSO Cost Calculator & Pricing System Audit (Patch 14A)

Audit date: 2026-07-24. READ-ONLY — no formulas, prices, Shopify data, or settings were changed.
Facts below come from code inspection; recommendations are clearly marked as such.

## 1. Executive summary (plain English)

The shop does not have one pricing engine — it has **three ink-cost systems, two full
calculation engines, and several settings pages that look authoritative but are read by
nothing**. Each individual piece mostly works; the problem is that they disagree and the
calculator page is the odd one out:

- **The quote/product path** (`recipe-pricing.server.ts`) is the closest thing to a real
  engine: DB materials, machine ink channels, vendor tiers, recipe tiers with margins,
  and it snapshots into quotes and production jobs. This is the engine to keep.
- **The Cost Calculator page** uses its own separate math (`cost-calculator.server.ts` +
  hardcoded ink "estimate profiles" of $0.50–$2.50/sqft) that never touches the
  verified channel rates or the recipe engine. Two products priced on the calculator
  and via a quote can disagree today.
- **The Admin Settings pricing keys** (default margins, machine recovery $5/hr, labor
  rate, overhead, power) are stored and editable but **read by no pricing code at all**
  (only the setup wizard displays them). They are decorative and one of them
  (defaultMachineRecoveryHr) contradicts the real $8/hr rate.
- **Verified truth exists** for blanks/materials/ink $/ml (13.2.x) and owner labor
  standards are wired into the calculator (13A.3), but ink *usage* (0.0075 ml/sqft/1%)
  is still the uncalibrated seed everywhere the real engine runs.
- **History is safe**: quotes and production items snapshot cost/price JSON at creation,
  so fixing live assumptions will not rewrite old numbers.

The fix is consolidation (14B), not invention: make the recipe engine the single
engine, make the calculator a UI over it, then simplify UX, tiers, and product creation.

## 2. Current calculator flow (fact)

`/app/erp/cost-calculator` (`app/routes/app.erp.cost-calculator.tsx`, engine
`app/lib/cost-calculator.server.ts`):

```
screen inputs (product family, blank item, qty, sqft/label size, material,
  ink estimate profile, application mode, design count, waste %, margin %)
→ route action (in-page compute; nothing persisted)
→ cost-calculator.server.ts helpers:
    blankItemUnitCostAtQty()      ← VendorProduct + VendorProductTier (verified 13.2.x)
    resolvePrintMaterialCostPerSqft() ← Material (verified $/sqft: 0.3156 matte etc.)
    inkEstimateCostPerSqft()      ← HARDCODED route table $0.50–$2.50 by profile
    machine time                  ← MACHINE_RATE_CURRENT $8/hr (shared, correct)
    WIRED_LABOR                   ← owner standards (jar $0.20/app, 4x5 $0.1111/side,
                                    14x16 $1.00/side, design $9.3333, gloss/white $8.3333)
    cutting/weeding/packout       ← legacy fields flagged "review-needed", not owner-verified
    applyWasteDivisor()           ← waste % divisor (shared with engine)
→ suggestedPriceFromMargin(totalCost, marginPct)   ← margin-as-divisor (correct model)
→ display only; “Save” does not exist — results are not written to recipes,
  quotes, products, or Shopify.
```

Dead/misleading elements (fact): the ink profile dropdown implies measured cost but is
a guess table; calculator results cannot be saved as a recipe or pushed anywhere;
margin entered here has no link to RecipeTier margins; no MOQ/min-margin/min-price
fields exist; quantity tiers cannot be generated or previewed side-by-side.

## 3. Source-of-truth map (fact; recommendation in last column)

| Pricing input | Active source | Duplicate source(s) | Which wins today | Pages using it | Risk | Recommended authoritative source |
|---|---|---|---|---|---|---|
| Bag blank cost | VendorProduct(+Tier) — verified 13.2.2/13.2.3 | none | VendorProduct | calculator, cost-verification, vendor-cost-book | low | keep |
| Jar blank cost | VendorProduct(+Tier) Miron/SAFECARE — verified | none | VendorProduct | same | low | keep |
| Material $/sqft | Material (calculated/costPerUnit/purchase fallback chain) — verified | none | Material | calculator, engine, actual-costs media preview | low | keep; document fallback chain |
| Ink $/ml | MachineInkChannel.costPerMl — verified 13.2.4 | none (board legacy removed 13A.7B) | channels | engine, actual costs, calibration | low | keep |
| Ink usage ml/sqft | MachineInkChannel.mlPerSqft1Pct (seeded 0.0075) | **calculator hardcoded $/sqft profiles $0.50–2.50** | engine uses channels; calculator uses profiles | recipe engine vs calculator | **high — two answers for the same job** | channels (calibrated via 13A.8); retire profile table to “fallback when no machine” |
| Coverage % | recipe field per finish | none | recipe | engine | med (guessy) | keep + calibrate |
| Machine $/hr | MACHINE_RATE_CURRENT/machineRatePerHour() = $8 | **erpAdminSetting.defaultMachineRecoveryHr** (decorative) | shared source | calculator, board, writeback, audit | low (dup flagged) | keep shared accessor; delete/repoint admin key |
| Labor rates | WIRED_LABOR (owner standards, calculator only) | recipe labor fields (per-recipe manual $); erpAdminSetting.defaultLaborRateHr (read by nothing) | calculator uses WIRED_LABOR; engine uses per-recipe fields | calculator vs product-setup recipes | **high — engine does not know owner standards** | move WIRED_LABOR into shared engine; recipes reference standards |
| Application rate | WIRED_LABOR (jar/bag) | recipe labor fields | split as above | same | high | same consolidation |
| Cutting/weeding/packout | legacy calculator fields (“review-needed”) + recipe fields | — | both unverified | calculator, recipes | med | owner standards then wire |
| Waste % | recipe.wastePct / calculator input (shared divisor math) | — | consistent formula | both | low | keep |
| Setup fee | designSetupCost (calculator) / recipe setup fields | — | split | both | med | consolidate |
| Packout/supplies | recipe fields only (unverified) | — | recipe | engine | med | verify then keep |
| Shipping/outside | quote line manual + VendorProduct outsourced path | — | manual | quotes | med | keep manual, label clearly |
| Target margin | RecipeTier.marginPct → recipe.targetMarginPct → **hardcoded 40** | erpAdminSetting.defaultWholesaleMarginPct (read by nothing) | tier → recipe → 40 | engine | med (silent 40) | make fallback visible + admin key either wired or removed |
| Minimum margin | none enforced | LOW_MARGIN_THRESHOLD_PCT=40 (quote WARNING only) | nothing enforces | quote margin badge | med | add engine floor (14B decision) |
| Min unit price / min order total | none anywhere | — | n/a | — | med | owner decision |
| MOQ | recipe.minQuantity (warn-only) / configurator MIN_QTY=64 (enforced, storefront) | — | configurator enforces; engine warns | engine, configurator | med | enforce consistently |
| Quantity tiers | RecipeTier (fixed rows; margin/fixedPrice per tier) | jar base-sell-tier seeds; Wholesale Lite PricingRule (separate system, storefront) | RecipeTier for ERP | product-setup, quotes | med | RecipeTier + 14D generator |
| Shopify price | Shopify variant price (manual / margin-review push) | ERP suggested price | Shopify wins (nothing syncs automatically) | margin-review, shopify-links, shopify-cost-audit | med | 14F approved-push |
| Customer-specific pricing | Wholesale Lite tags/PricingRule (storefront discounts) | — | separate system | wholesale routes | low (by design) | keep separate, document |

## 4. Duplicate / conflicting / hardcoded values (classified)

- **Active duplicate (conflict):** calculator ink profiles `$0.50/1.00/1.50/2.00/2.50`
  (route-hardcoded) vs channel-based ink math — the central conflict.
- **Stale duplicates (read by nothing):** `erpAdminSetting` keys
  defaultMachineRecoveryHr ($5-style), defaultLaborRateHr, defaultWholesaleMarginPct,
  defaultRetailMarginPct, defaultMaintenanceCostSqft, defaultPowerRateKwh,
  defaultOverheadPct — editable UI, zero engine readers (only setup-wizard display).
- **Active authoritative constants:** MACHINE_RATE_CURRENT=8 (+env override);
  WIRED_LABOR (owner standards); verified vendor/material/ink rows in DB.
- **Fallbacks:** margin 40 (priceRecipeAtQuantity), vendorProduct.defaultUnitCost,
  material cost chain, `safeNumber(...,0)` zero-fallbacks (silent zero-cost risk when a
  field is missing — engine warns only in some paths).
- **Seed-only:** mlPerSqft1Pct 0.0075 fingerprint; jar base-sell-tier seeds (tools/).
- **Display-only:** MACHINE_RATE_LOW=5 (historical audit label), quote
  LOW_MARGIN_THRESHOLD_PCT=40 (badge), finish-presets preferredMachine strings.
- **Dead/legacy:** ConfiguratorPricingRule (pilot bridge, storefront stock-bags only —
  documented as to-be-retired toward the engine); retired print-log matchers.

## 5. Missing costs (fact)

Cutting/weeding/packout owner standards (flagged review-needed since 13A.3); boxes and
“other media” blank costs (no verified VendorProduct rows); per-family coverage%
calibration; shipping/outside as structured inputs (manual only); any min-margin/
min-price/min-order enforcement; engine-side owner labor standards (calculator-only).

## 6. Product-family coverage (fact)

| Family | Blank cost | Material | Ink | Labor | Tiers | Shopify | Quote | Production | Gaps |
|---|---|---|---|---|---|---|---|---|---|
| Stock sticker bags | ✔ verified | ✔ | profiles/engine split | ✔ wired (4x5, 14x16) | configurator tiers live | ✔ live | ✔ | ✔ | engine/calculator split |
| Blank jars | ✔ Miron/SAFECARE | n/a | n/a | ✔ jar app | jar seed tiers | partial (links) | ✔ | ✔ | 5oz stays cost-only |
| Jar label sets | ✔ | ✔ | split | ✔ | RecipeTier | partial | ✔ | ✔ | coverage guess |
| Stickers / die-cut | — media only | ✔ | split | cutting/weeding unverified | RecipeTier manual | partial | ✔ | ✔ | cut labor standards |
| Banners | — | ✔ 0.2963 | split | unverified | manual | partial | ✔ | ✔ | finishing (hem/grommet) inputs absent |
| DTP pouches | ✔ tiers verified | n/a | n/a | app labor unverified | vendor tiers | partial | ✔ | ✔ | — |
| Die-cut bags / boxes | ✖ no verified blanks | partial | split | unverified | none | ✖ | manual | manual | family effectively unsupported |
| Outsourced items | ✔ vendor path | n/a | n/a | n/a | vendor tiers | ✖ | ✔ | ✔ | — |

## 7. Tier findings (fact)

Stored in `RecipeTier` (minQty/maxQty, marginPct, fixedPrice) — **fixed rows, never
calculated**; no setup-spread-by-quantity; vendor breaks used only for blank cost, not
to shape sell tiers; labor efficiency does not vary by quantity; margins can vary per
tier; MOQ warn-only; fixedPrice can sit **below cost with no guard**; overlapping/gap
tiers possible (getBestRange picks best match, no validator); Shopify variant prices
are not reconciled to tiers automatically (shopify-cost-audit reports drift);
configurator storefront tiers are a separate live system (stock bags). Manual tier
edits are not audited (no event trail).

## 8. New-product workflow findings (fact)

Product Setup + Add Product can: create templates/recipes, attach materials/media/
label zones, set labor fields, machine rule, waste, minQuantity, tiers (manual or
template sync), test-price a recipe, link existing Shopify products, sync variants,
variant rules. **Cannot:** duplicate a recipe; create a Shopify product from a recipe
(creation lives separately in margin-review/shopify-links); auto-generate tiers;
enforce MOQ/min-margin; define packout/shipping structurally; preview family-specific
required inputs (one generic form for all families). New-product-to-live-price is a
multi-page manual journey (recipe → tiers → link Shopify → margin-review push).

## 9–11. Shopify / Quote / Production connections (fact)

- **Shopify:** read+compare via shopify-cost-audit (tolerance 5%); push via
  margin-review (productCreate/Set) and shopify-links; no automatic sync; ERP suggested
  price and Shopify price drift silently between pushes.
- **Quotes:** quote builder prices via the recipe engine and **snapshots**
  costSnapshot/priceSnapshot per line (safe); manual override of unit prices allowed
  with low-margin warning only.
- **Production:** jobs copy item snapshots (estimated) — 13A.7 actuals compare against
  them; estimated cost = qty x unitCost from snapshot time (safe).

## 12. Historical snapshot safety (fact)

Safe (snapshotted): QuoteItem.costSnapshot/priceSnapshot; ProductionJobItem copies;
writeback provenance rows. **Live-dependent (would change if assumptions change):**
calculator screen results (not persisted — fine), margin-review recomputations,
shopify-cost-audit comparisons, any re-priced quote line (re-pricing overwrites that
line's snapshot by design). No path rewrites existing snapshots implicitly. Old
invoices are not modeled in-app.

## 13. UX findings (fact)

One giant calculator form for every family; ink profile dropdown reads as truth but is
a guess; cost vs price vs margin displayed without source labels; no required-field
indicators; legacy cutting/weeding fields sit beside wired standards with equal visual
weight; tier editing lives pages away from price testing; admin-settings pricing keys
look authoritative but do nothing; no “what changed my price” explanation.

**Recommended future layout (recommendation):** three modes — Quick Quote (family →
qty → price, engine-backed), Detailed Costing (full component breakdown with source
badges: verified / seeded / manual / fallback), Product Builder (guided family-specific
creation ending in recipe + tiers + optional Shopify push).

## 14. Recommended authoritative architecture (recommendation)

One shared engine = `recipe-pricing.server.ts`, extended with: WIRED_LABOR standards,
the calculator's verified blank/material resolvers (already shared), machineRatePerHour(),
explicit fallback surfacing (never silent zero/40), MOQ + min-margin enforcement
flags. The calculator page becomes a UI over `priceRecipeAtQuantity` (ad-hoc mode =
transient recipe). Ink profiles demoted to labeled fallback. erpAdminSetting pricing
keys either become the engine's config source or are removed. Shopify price flows only
through an approved push (14F). Wholesale Lite storefront discounts stay a separate,
documented system.

## 15. Patch roadmap (recommendation — see §M of the patch request)

- **14B — One shared cost engine.** Fold calculator math into recipe-pricing; wire
  owner labor standards engine-side; kill silent fallbacks (warn + surface); no UX
  change. Files: recipe-pricing.server.ts, cost-calculator.server.ts/route, tests.
  No migration. Risk: medium (quote prices must stay byte-stable for existing recipes —
  regression-test against current outputs). Owner: confirm cutting/weeding/packout
  standards; confirm the 40% fallback becomes explicit.
- **14C — Calculator UX simplification.** Three modes, source badges, family-aware
  fields. Route-only. No migration. Risk: low. Owner: approve layout.
- **14D — Automatic tier generator.** Generate RecipeTier rows from vendor breaks +
  setup spread + labor efficiency + margin policy; overlap/below-cost validator;
  preview-then-apply gate. Possible tiny migration (tier provenance). Risk: medium.
  Owner: tier policy (break points, floor margin).
- **14E — Product Builder workflow.** Guided creation incl. duplicate-recipe, MOQ/
  min-margin fields, family templates. Risk: medium. Owner: family input lists.
- **14F — Approved Shopify sync.** Recipe→product/variant create+price push with
  phrase gate + drift report. Risk: high (live store). Owner: publish policy.
- **14G — Validate/migrate existing products.** Recompute all recipes on the unified
  engine, diff vs current, owner-gated adoption. Risk: medium.

## 16. Risks & owner decisions

(1) cutting/weeding/packout standards; (2) explicit default margin (keep 40%?);
(3) min-margin / min-unit-price / min-order policy; (4) admin-settings pricing keys:
wire or delete; (5) coverage%/reference-coverage policy (also blocks 13A.8 apply);
(6) box/die-cut-bag family: build or drop; (7) tier policy for 14D; (8) Shopify push
authority for 14F.

## 17. Files / routes / models involved (fact)

Engines: `app/lib/recipe-pricing.server.ts`, `app/lib/cost-calculator.server.ts`,
`app/lib/configurator-pricing.ts`, `app/lib/quote-margin.server.ts`,
`app/lib/rip-actual-costs*.ts`, `app/lib/calibration.server.ts`, `finish-presets.ts`.
Routes: cost-calculator, product-setup, products.new, materials, machines, vendors,
vendor-cost-book, pricing-rules, pricing-health, cost-health, cost-verification,
shopify-cost-audit, margin-review, shopify-links, quotes, configurator*, admin-settings,
actual-costs, calibration. Models: Material, Machine(+InkChannel), VendorProduct(+Tier),
ProductTypeProfile, ProductRecipe(+RecipeTier/materials/addOns/machineRules), PricingRule,
WholesaleRule, ConfiguratorPricingRule, Quote(+Item snapshots), ProductionJob(+Item),
ErpAdminSetting. Seeds: tools/seed-jar-*, seed-product-families, sync-stockbag-*.

## 14C.2 addendum (2026-07-24)
The dual-entry gap flagged in this audit (calculate costs, then re-enter them
in the tier form) is closed: the product calculator now feeds the family tier
engine directly (per-quantity engine reruns; researched curves + 40% floor
unchanged), with customer-price selection and a recomputing draft save.
Sticker bags are data-driven with size-resolved owner application rates.
(A 14C.2 classifier pass that treated SAFE CARE vendor records as Chiron was
overruled by the owner and corrected in 14C.2A before commit — see below.)
Outstanding pricing-data gaps unchanged: Mimaki gloss $/ml, Miron separate-top
records, application standards beyond 4x5/14x16 bags, researched curves for
standard jars and non-4x5 bag sizes.

## 14C.2A addendum (2026-07-24) — owner-authoritative catalog rules
3 oz / 4 oz / 5 oz normal jars = STANDARD jars (SAFE CARE is just the vendor).
Chiron = two explicit records only, FLAT blank cost at every quantity:
Chiron 100 ml $1.80 / Chiron 150 ml $1.90 (seeded via
tools/seed-chiron-jars.mjs; enforceFlatChironCost strips stray tiers). Miron
stays tier-priced with required Top Type. Sticker bags = 4x5/4x6/5x8/6x9/14x16
(OZ excluded); 5x8 + 6x9 have no records and quote Draft Only; the 4x6
record's stale $0.10 seed value was NEUTRALIZED to NO PRICE by 14C.2A1
(tools/neutralize-4x6-bag-cost.mjs) — 4x6/5x8/6x9 all await owner pricing.

## 15C addendum (2026-07-24)
DTP Bags now price from owner-verified Spektra VendorProduct tiers through the
unified engine — the audit-era gap ("dtp-pouches curve existed with no
calculator family") is closed. Freight $85/PO is explicit and separate; GSO
design charge applies without in-house print setup. Remaining DTP items:
multi-line PO freight allocation (future phase) and a structured vendor-level
freight field.

## 15C.2 addendum (2026-07-24)
DTP switched from margin-derived prices to owner selling-price ladders with
live server-computed landed cost, gross margin, and profit safeguards
(30/35/38 floors, $500/$350 profit rules, override gating). The 40% global
floor remains untouched for every other family; DTP uses its owner-approved
band floors with 40% as the visible warning target.
