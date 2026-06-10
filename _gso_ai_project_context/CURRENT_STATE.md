# GSO ERP / Shopify Configurator Current State

Project:
C:\Users\golde\shopify-apps\wholesale-lite-mvp

Current Git branch:
gso-configurator-pilot

Latest configurator commit:
8db8543 - Add ERP configurator pilot calculator

Goal:
Move GSO stock bags away from 210 Shopify variants per product.

New structure:
- 1 Shopify product per design
- 1 base variant per design
- Material, Finish, Bag Color, Quantity captured as custom options / line item properties
- ERP/CRM owns pricing, cost, margin, production rules, and Shopify order sync

5-product pilot:
1. Ritz Vanilla Cupcake
2. Bubble Tape Lemonade Lightning
3. Trolli Worms Pineapple Pop
4. Bubble Tape Blue Raspberry
5. Ritz Orange Creamsicle

Confirmed decisions:
- Minimum stock bag quantity: 64
- Customer can type quantity
- Hide Sided from customer
- Default Sided to Double Sided
- Customer-facing option name: Finish
- Use live theme only for products tagged configurator-pilot
- Build inside ERP/CRM, not separate app

Patch 1 status:
- Added app/routes/app.erp.configurator.tsx
- Added route for /app/erp/configurator
- Added Configurator nav link in app/routes/app.tsx
- Shopify live theme has not been touched yet
