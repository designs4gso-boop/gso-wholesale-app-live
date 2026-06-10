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
