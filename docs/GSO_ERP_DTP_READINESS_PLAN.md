# GSO ERP — DTP / Custom Printed Pouches Readiness Plan (Phase 15A, 2026-07-24)

Audit conclusion: **DTP fits the existing data model with NO schema change.**
The Miron pattern (VendorProduct + VendorProductTier, classified into a
calculator family, priced through the product-driven engine with researched
margin curves) covers the Spektra rules almost completely. Two items lack a
structured home (flat per-PO freight, and a family registry) and have
no-schema workarounds documented below.

## Verified Spektra facts (owner-provided; enter EXACTLY, never guess)
- Vendor: Spektra, USD. Four sizes, each with four quantity tiers:
  - 4x5x2: 1000 $0.9897 / 2500 $0.4922 / 5000 $0.4033 / 7500 $0.3232
  - 5x4x2: 1000 $1.0504 / 2500 $0.5419 / 5000 $0.4697 / 7500 $0.3818
  - 6x5x2: 1000 $1.1048 / 2500 $0.5864 / 5000 $0.5290 / 7500 $0.4341
  - 8x5x2: 1000 $1.2418 / 2500 $0.6991 / 5000 $0.6799 / 7500 $0.5674
- 4x5x2 and 5x4x2 are DISTINCT structures (zipper location) — separate records, never merged.
- $85 flat freight per Spektra PURCHASE ORDER (not per design); allocate across combined multi-line orders.
- No customs/duty/plates/setup/proof/sample/vendor-art fees; overrun/underrun built into unit cost.
- Child-resistant zipper INCLUDED; tear notch INCLUDED; hang hole OPTIONAL at $0.
- No vendor per-design fee; GSO charges its OWN design fee (existing OWNER_LABOR art+print setup — already implemented).

## Question-by-question answers

1. **Which existing models store this?** `Vendor` (Spektra master record — create via Setup · Vendors), `VendorProduct` ×4 (one per size/structure), `VendorProductTier` ×16 (the exact tier table above), `VendorProductAddOn` (features: pricingType/amount/enabled — CR zipper included $0, tear notch included $0, hang hole optional $0), `ProductTypeProfile` (family profile rows `dtp_normal_bags` etc. already seeded), `FAMILY_MARGIN_RULES` already contains the researched `dtp-pouches` curve (65/58/52/46/42, min 42) and `PRODUCT_FAMILY_SALES_RULES` already contains dtp-pouches (MOQ 1000, agent rules).
2. **What cannot be stored today?** (a) The $85 flat per-PO freight has no structured vendor-level field (Vendor has only shippingNotes text). (b) The calculator family list is code, so exposing "Custom Printed Pouches / DTP Bags" as a family requires a code patch (15C) regardless of data.
3. **Schema change needed?** **No** for launch. Optional later: `Vendor.freightFlatPerOrder` (one nullable Decimal) would make freight fully data-driven; until then use an `ErpAdminSetting` entry (category "freight", key "spektra-flat-per-po", value 85) or the existing freight panel with a documented owner rule. Recommend deferring any migration until after 15B.
4. **Can VendorProduct + VendorProductTier handle DTP sizes/costs?** Yes — exactly the Miron shape (defaultUnitCost = 1000-tier price; four tiers each; moq 1000). Distinct records keep 4x5x2 vs 5x4x2 separate. Suggested stable vendorSkus: `spektra-dtp-4x5x2`, `spektra-dtp-5x4x2`, `spektra-dtp-6x5x2`, `spektra-dtp-8x5x2`.
5. **Where should flat freight live?** Near-term: ErpAdminSetting (owner-editable, no migration) read by the calculator's freight panel as the default "actual freight" for DTP quotes, still displayed as the separate visible freight line. Long-term: Vendor.freightFlatPerOrder.
6. **Where should included/optional features live?** `VendorProductAddOn` rows on each Spektra record (enabled included features at $0 amount; hang hole optional $0). The calculator engine renders included features as $0 verified note lines (same presentation pattern as the Chiron "cap included" note) — small 15C engine addition.
7. **Where do GSO design charges live?** Already solved: OWNER_LABOR art+print setup per design in the calculator (vendor charges none — nothing to add; assert in tests that no vendor design fee line exists).
8. **Multi-line freight allocation?** `computeFreight` already supports allocation modes (per_unit / by_value / manual). Rule for DTP: ONE $85 actual freight entry per Spektra PO allocated across the combined order's units (per_unit over total units, or by_value across lines when sizes mix). 15C should make the DTP family preset "actual freight $85, allocation by merchandise value" and document that multi-design orders on one PO enter freight ONCE.
9. **Can a user add another DTP size without code (after 15B consolidation)?** Yes — that is the 15B acceptance test: add a VendorProduct with vendorSku `spektra-dtp-<size>`, productType "dtp_bag"... note: TODAY the classifier deliberately excludes `dtp` productTypes from sticker bags; 15C introduces a `bag_dtp` class + `dtp-pouches` calculator family so any active Spektra record classifies in automatically (mirror of the sticker-bag data-driven pattern, incl. NO PRICE handling for unpriced sizes).
10. **Exact UI required (15C):** one new family option "Custom Printed Pouches / DTP Bags" → data-driven size picker (the 4 records, verified tier labels) → quantity/designs (MOQ 1000 hint from PRODUCT_FAMILY_SALES_RULES) → print dimensions (or per-size defaults later) → material/printer/layers as today → included-features note lines → freight preset $85/PO → auto tiers on the researched dtp-pouches curve → customer summary/save (engine version bump). NO new pages: reuse the calculator + Vendor Cost Book entry paths.

## Where the DATA should be entered (once 15C ships)
Vendors page (Spektra master) → Vendor Cost Book or direct VendorProduct entry
(4 records + 16 tiers + 3 add-ons each) → calculator picks them up with zero
further code. Until 15B consolidates product setup, the Cost Book remains the
correct entry surface for these records.

## Pre-15C checklist (blockers first)
1. 15B decision on the family registry (or accept one more code-family addition).
2. Confirm freight home (ErpAdminSetting vs schema field) — owner call.
3. Owner confirms whether DTP quotes need per-size print-dimension defaults.
4. Tests to write in 15C: tier resolution at 1000/2500/5000/7500 per size; 4x5x2 ≠ 5x4x2; $85 allocated once per PO across lines; included features $0-verified (never silently dropped, never charged); hang hole optional $0; no vendor design fee; MOQ warning under 1000; unpriced future size = NO PRICE/Draft Only.

## 15C SHIPPED (2026-07-24)
Everything above is implemented: registry family enabled, Spektra data seeded
(records + IDs in GSO_ERP_PROJECT_STATE.md), bag_dtp classification,
vendor-finished engine branch, $85/PO freight (single line, in the margin
basis, override-able by actual entered freight), art-only GSO design charge,
DB-driven feature spec, DTP tier quantities + researched curve, 15C-spektra-dtp
snapshots. Tier semantics: range-based highest-reached tier (documented in
tests), never interpolated. Multi-line PO freight allocation remains the
documented future design: one $85 charge per combined Spektra PO allocated
across all lines by units or merchandise value via computeFreight allocation
modes — build with the multi-line quoting phase (15D+).

## 15C.1 note
DTP margin thresholds are quantity-based (65/58/52/46/42 at 1,000/2,500/
5,000/7,500/10,000) via the shared dtpMarginPctForQuantity() — the four-row
curve compression noted as a 15C limitation is resolved.
