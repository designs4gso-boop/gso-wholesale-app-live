# Patch Log

## Patch 1 - ERP Configurator Pilot Calculator

Commit:
8db8543 - Add ERP configurator pilot calculator

Files changed:
- app/routes.ts
- app/routes/app.tsx
- app/routes/app.erp.configurator.tsx

What it does:
- Adds GSO Product Configurator page
- Loads 5 pilot products
- Uses minimum quantity 64
- Supports typed quantity
- Uses Material, Finish, Bag Color
- Defaults Sides to Double Sided
- Shows price each, cost each, profit each, margin, order total, total cost, total profit
- Uses hardcoded pilot pricing from uploaded pricing sheet for now

Not done yet:
- No Prisma database configurator tables yet
- No Shopify storefront theme changes yet
- No order webhook configurator processing yet
- No full product migration yet

## Patch 2 - Database-backed configurator rules

Purpose:
Move the pilot configurator from hardcoded-only pricing to Prisma/PostgreSQL-backed rules.

Files changed:
- prisma/schema.prisma
- app/routes/app.erp.configurator.tsx

What it adds:
- ConfiguratorProduct model
- ConfiguratorOption model
- ConfiguratorPricingRule model
- Automatic pilot data seeding
- Database-first pricing calculation
- Reset pilot database rules button
- Pricing source indicator: database/fallback

Still not done:
- Shopify storefront product page configurator
- Shopify product mapping
- Shopify line item properties
- Order paid webhook configurator processing
- Production job creation from configured order

## Patch 2.1 - Pricing matrix range label fix

Purpose:
Fix the final database pricing matrix display column so the 1921-2560+ tier displays prices instead of "-".

Files changed:
- app/routes/app.erp.configurator.tsx

Notes:
- No database schema changes.
- No Shopify theme changes.
- No order sync changes.
- Calculator logic was already working from database rules.

## Patch 2.2 - Robust final tier matrix display

Purpose:
Make the pricing matrix display the final 1921-2560+ tier even if the stored database rule key is 1921+, 1921-2560+, or matched by min quantity.

Files changed:
- app/routes/app.erp.configurator.tsx

Notes:
- No schema changes.
- No Shopify theme changes.
- No order sync changes.

## Hotfix - Add missing matrixPrice helper

Purpose:
Fix live configurator page error: ReferenceError matrixPrice is not defined.

Files changed:
- app/routes/app.erp.configurator.tsx

Notes:
- No schema changes.
- No database changes.
- No Shopify theme changes.

## Hotfix 2 - Force insert matrixPrice helper

Purpose:
Fix live configurator page runtime error: ReferenceError matrixPrice is not defined.

Files changed:
- app/routes/app.erp.configurator.tsx

Notes:
- No schema changes.
- No database changes.
- No Shopify theme changes.

## Patch 3 - Shopify product mapping screen

Purpose:
Add an ERP screen for mapping the 5 pilot configurator products to Shopify products and base variants.

Files changed:
- app/routes/app.erp.configurator-mapping.tsx
- app/routes.ts
- app/routes/app.tsx

What it adds:
- /app/erp/configurator-mapping
- Shopify Product GID field
- Shopify Variant GID field
- Shopify Handle field
- Base SKU field
- Active toggle
- Mapping status indicators

Still not done:
- Storefront configurator block
- Shopify line item property submission
- Order webhook configurator processing

## Cleanup Patch - Configurator architecture cleanup

Purpose:
Prevent the configurator from becoming a duplicate pricing system before adding collection sync or storefront changes.

Files changed:
- app/lib/configurator-pricing.ts
- app/routes/app.erp.configurator.tsx
- app/routes/app.erp.configurator-mapping.tsx if present
- app/routes/app.tsx if nav label present
- _gso_ai_project_context/ARCHITECTURE.md
- _gso_ai_project_context/PATCH_LOG.md
- _gso_ai_project_context/NEXT_STEPS.md

What changed:
- Moved pilot constants and helper logic into app/lib/configurator-pricing.ts
- Renamed mapping UI to Manual Mapping / Exceptions if present
- Documented the long-term architecture
- Confirmed configurator should call ERP pricing long-term instead of duplicating pricing

## Hotfix - Cleanup syntax issue in configurator route

Purpose:
Fix build error caused by a leftover corrupted rangeLabel line from the cleanup refactor.

Files changed:
- app/routes/app.erp.configurator.tsx

Notes:
- No schema changes.
- No database changes.
- No Shopify theme changes.
- Fixes Render build failure.

## Patch - Shopify collection/tag configurator sync

Purpose:
Add scalable product sync so thousands of Shopify products do not need manual mapping.

Files changed:
- app/routes/app.erp.configurator-sync.tsx
- app/routes.ts
- app/routes/app.tsx

What it adds:
- /app/erp/configurator-sync
- Preview products by Shopify tag/product type/collection handle
- Sync matched products into ConfiguratorProduct
- Auto-save Shopify Product GID, base Variant GID, handle, SKU
- Apply product type stock_bag_4x5, min qty 64, default sides Double Sided

Notes:
- Collection handle is post-filtered from the product collections list.
- Required tag is used in the Shopify product search query.
- Storefront theme remains untouched.

## Hotfix - Loosen configurator sync Shopify search

Purpose:
Fix product sync preview returning zero products even when pilot products have the configurator-pilot tag.

Files changed:
- app/routes/app.erp.configurator-sync.tsx

What changed:
- Shopify query now searches by required tag only.
- Product type is filtered inside ERP after products are returned.
- Collection matching is more flexible and checks handle, title, and title-as-handle.
- Added no-results tip for testing blank Product Type.

Notes:
- No database schema changes.
- No storefront theme changes.

## Hotfix - Configurator sync trim safety

Purpose:
Fix sync preview app error caused by undefined value being passed into buildShopifyProductSearch and trim().

Files changed:
- app/routes/app.erp.configurator-sync.tsx

What changed:
- cleanText now handles undefined safely
- escapeSearchValue now handles undefined safely
- buildShopifyProductSearch now handles undefined safely
- textMatches now handles undefined safely
- hasMatchingCollection now handles undefined safely

Notes:
- No schema changes.
- No database changes.
- No storefront changes.
