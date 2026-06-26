# Product Family Reuse Decision

Last updated: 2026-06-26

## Final decision

The existing broad ERP product type keys are usable and should not be deleted.

They are the current ERP recipe/material/admin setup layer:

- labels
- sticker_bags
- dtp_bags
- boxes
- dtf_apparel

These are reused as broad internal ERP templates.

Exact sellable product types are used for storefront configurators, Shopify mapping, and customer-facing product setup.

## Existing broad ERP templates

| Broad key | Current use | Decision |
|---|---|---|
| labels | ERP label material/recipe/admin setup | Reuse |
| sticker_bags | ERP sticker bag recipe/material/admin setup | Reuse |
| dtp_bags | ERP DTP bag template/admin setup | Reuse and extend later |
| boxes | ERP box template/admin setup | Reuse and extend later |
| dtf_apparel | ERP DTF/apparel template/admin setup | Keep for future DTF/apparel section |

## Exact sellable/configurator product types

### Applied Label Products

- stock_bag_4x5
- sticker_bag_4x5
- label_only
- jar_50ml
- jar_100ml_tall
- jar_100ml_wide

### DTP / Mylar Pouches

- dtp_normal_bags
- dtp_stock_die_cut
- dtp_custom_die_cut

### Boxes

- tuck_boxes
- box_bag_combos
- specialty_box_finishes

## Build rule

Do not create a second recipe/material/admin system.
Reuse the existing broad templates underneath.
Use exact product type keys for live configurators and Shopify-facing flows.

## Audit proof

The ERP product type reuse audit showed active broad profiles for boxes, dtf_apparel, dtp_bags, labels, and sticker_bags.
The audit also showed the active 4x5 Sticker Bag recipe already has materials, label zones, media options, tiers, and variant rules.
The audit showed old broad keys are not currently powering configurator products/options/pricing rules.

## Practical meaning

When building jars, labels, sticker bags, DTP, boxes, or apparel, first check the broad ERP templates and reuse what already exists.
Only add exact product type records when needed for customer-facing configurator or Shopify-specific behavior.
