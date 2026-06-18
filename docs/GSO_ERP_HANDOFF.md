# GSO ERP / Shopify App Handoff

Last updated: 2026-06-17

## Project

Project folder:
C:\Users\golde\shopify-apps\wholesale-lite-mvp

Repo:
designs4gso-boop/gso-wholesale-app-live

Branch:
main

Render service:
gso-wholesale-app-live

Live URL:
https://gso-wholesale-app-live.onrender.com

Shopify store/admin:
942075-2.myshopify.com

Embedded app base:
https://admin.shopify.com/store/942075-2/apps/gso-wholesale-pricing-data-9420752

## Current major workflow

We are converting stock bag Shopify products from the old 210-variant model to the new ERP configurator model.

Pipeline is running a full Stock Bag Configurator V2 migration:

- Full batch: 1,743 products
- Last known progress from prior chat: around 236 / 1743
- It may take all night
- While it runs, do NOT run full ERP sync, Shopify Links sync, or anything that changes Shopify products

## Pipeline responsibility

Pipeline owns Shopify product/artwork/catalog setup only:

- 1 Shopify product per stock bag design
- stable handle
- images/media
- vendor GSO Packaging
- product type Stock Bag
- Stock Bags collection ID 302046380097
- tag configurator-pilot
- useful design metafields
- exactly 1 default/base variant
- no Shopify customer-facing Material/Finish/Gloss/Bag Color/Quantity/Sides options

## ERP app responsibility

ERP app owns:

- ConfiguratorProduct records
- Configurator Sync / Audit
- Shopify Links recipe mapping
- pricing rules
- cost/margin
- storefront configurator
- custom cart drawer
- draft-order checkout
- production/RIP flow

## Stock bag ERP readiness contract

A Shopify stock bag is ERP sync-ready when:

- product_type = Stock Bag
- tag includes configurator-pilot
- belongs to collection ID 302046380097
- product is ACTIVE
- handle exists
- Shopify product GID exists
- one usable default/base variant exists
- Shopify variant GID exists
- option structure is Title / Default Title, or at minimum base variant title is Default Title
- ERP productType maps to stock_bag_4x5
- minQuantity defaults to 64
- defaultSides defaults to Double Sided
- active = true

Important constants:

- PRODUCT_TYPE = stock_bag_4x5
- PRODUCT_TYPE_LABEL = 4x5 Stock Bag
- MIN_QTY = 64
- Stock Bags collection ID = 302046380097
- Required tag = configurator-pilot
- Shopify Product Type = Stock Bag

## Configurator Sync status

File:
app\routes\app.erp.configurator-sync.tsx

Recent commits:

- c7fc382 Show stock bag pipeline readiness details in sync preview
- f348493 Fix stock bag variant readiness count
- 32d3bab Allow default variant fallback for stock bag readiness

Configurator Sync is deployed and working.

Last live preview test:

- Collection ID: 302046380097
- Required tag: configurator-pilot
- Shopify Product Type: Stock Bag
- Max Products To Scan: 50

Result:

- Raw Shopify Products Returned: 50
- Tag Matched: 4
- Product Type Matched: 50
- Final Matched: 4
- ERP Ready: 4
- Pilot products showed Ready for ERP Sync
- Variants: 1
- Base Variant: Default Title

Do not click Sync Products Into ERP until the full pipeline migration finishes and gives a final report.

## Configurator Audit status

File:
app\routes\app.erp.configurator-audit.tsx

Audit upgrade completed and deployed live.

Live route:
https://admin.shopify.com/store/942075-2/apps/gso-wholesale-pricing-data-9420752/app/erp/configurator-audit

Live screenshot confirmed:

- Products: 5
- Ready: 5
- Links Pending: 0
- Needs Setup: 0
- Product Types: 1
- Options: 21
- Pricing Rules: 50

The audit page now checks:

- Shopify Product GID
- Shopify Variant GID
- Shopify Handle
- ERP productType = stock_bag_4x5
- minQuantity = 64
- defaultSides = Double Sided
- active status
- options count
- pricing rules count
- Shopify Links mapping through RecipeVariantRule by product GID or variant GID

Audit statuses now separate:

- Ready
- Ready - Links Pending
- Needs Setup

Audit issue badges include:

- Missing Shopify Product GID
- Missing Shopify Variant GID
- Missing Shopify Handle
- Wrong ERP Product Type
- Wrong Min Qty
- Wrong Default Sides
- Inactive
- Missing options
- Missing pricing rules
- Needs Shopify Links mapping

## Current Shopify/ERP pilot products

- Ritz Vanilla Cupcake
- Ritz Orange Creamsicle
- Bubble Tape Lemonade Lightning
- Bubble Tape Blue Raspberry
- Trolli Worms Pineapple Pop

## Safe tasks while pipeline runs

Safe:

1. Improve read-only reporting.
2. Improve audit UI labels and stats.
3. Improve draft-order checkout/cart UI only if not touching Shopify products.
4. Update project context docs/handoff zip.
5. Plan next sync steps for after pipeline completion.

Do not do while pipeline runs:

- Do not bulk sync all 1,743 products into ERP.
- Do not run Shopify Links full sync.
- Do not delete/recreate Shopify products.
- Do not change Shopify handles.
- Do not create Shopify variants.
- Do not duplicate pipeline CSV/artwork/image handling.

## Next recommended work

After audit completion, next safest work is to improve the app-side storefront configurator/cart flow or prepare post-pipeline verification tools.

Recommended next priorities:

1. Add a post-pipeline verification checklist/report.
2. Improve Configurator Sync help text and remove old 5-product pilot wording.
3. Build a read-only migration completion dashboard.
4. Improve storefront configurator/cart drawer UI.
5. Prepare controlled batch ERP sync process for after the 1,743-product pipeline finishes.

