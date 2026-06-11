# GSO ERP Configurator Architecture

## Core Decision

The configurator should not become a second disconnected pricing app.

Final architecture:

- Product Setup / Recipes = cost and production source of truth
- ERP Tier Pricing = pricing, margin, quantity tier, MOQ, and guardrail source of truth
- Configurator = customer option selector and Shopify order bridge
- Shopify = product display, checkout, and line item property capture

## Current State

The configurator currently has a database-backed pilot pricing table:

- ConfiguratorProduct
- ConfiguratorOption
- ConfiguratorPricingRule

These are useful for the pilot and for proving the workflow, but long-term pricing should be unified with the existing ERP pricing/tier engine.

## Existing ERP Pricing Areas To Preserve

The app already has:

- PricingRule
- ProductTypeProfile
- ProductRecipe
- RecipeTier
- ProductCost
- WholesaleRule

Do not duplicate these systems unless there is a clear migration plan.

## Next Clean Build Direction

1. Keep ConfiguratorProduct as the Shopify/ERP product bridge.
2. Keep ConfiguratorOption for storefront option values.
3. Treat ConfiguratorPricingRule as a pilot bridge only.
4. Move reusable pricing logic into shared services.
5. Connect the configurator calculator to existing ERP pricing/tier rules.
6. Add Shopify collection/tag sync for product mapping.
7. Only after that, add the storefront configurator block.
8. Finally, update the order paid webhook to create ERP production jobs from line item properties.

## Product Sync Direction

Do not manually map thousands of products.

Preferred workflow:

Shopify Collection + Required Tag
-> ERP Sync
-> ConfiguratorProduct rows
-> Product type rules
-> Storefront configurator
-> Shopify line item properties
-> ERP order/production job

Pilot sync recommendation:

- Collection: Stock Bags
- Required tag: configurator-pilot
- Product type: stock_bag_4x5
- Min Qty: 64
- Default sides: Double Sided

Full catalog migration:

- Collection: Stock Bags
- Required tag removed or changed to gso-configurator
- Same product type rules
