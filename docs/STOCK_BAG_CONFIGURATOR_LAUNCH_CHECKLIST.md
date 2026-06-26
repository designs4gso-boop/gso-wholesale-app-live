# GSO Stock Bag Configurator Launch Checklist

Last updated: 2026-06-26

## Current MVP Status

Status: 99% working / real end-to-end test passed.

Confirmed real flow:

- Shopify stock bag product page loads GSO configurator.
- Customer can choose Material, Finish, Bag Color, and Quantity.
- Minimum quantity is 64.
- Quantity typing works.
- Price breaks display correctly.
- Custom GSO cart drawer works.
- Header cart icon opens GSO cart drawer.
- Checkout creates from configurator cart.
- Checkout carries custom properties:
  - Material
  - Finish
  - Production Finish
  - Bag Color
  - Sides
- Shopify test checkout completed successfully.
- Paid order webhook created ERP Production Job.
- Production Board displays product image and job info.
- Print Work Order displays image, configuration, pricing, and item ticket.

Latest confirmed real test order:

- Product: Ritz Vanilla Cupcake
- Material: Matte
- Finish: 4X Spot Gloss
- Bag Color: Blue
- Qty: 64
- Unit price: $2.80
- Total: $179.20
- Shopify order: #1007
- ERP job created automatically.
- Work order image and clean configuration details displayed correctly.

## Locked Customer Pricing Matrix

Quantity tiers:

- 64-256
- 257-640
- 641-1280
- 1281-1920
- 1921+

### Matte

| Finish | 64-256 | 257-640 | 641-1280 | 1281-1920 | 1921+ |
|---|---:|---:|---:|---:|---:|
| No Spot Gloss | 1.75 | 1.65 | 1.55 | 1.45 | 1.35 |
| 1X Spot Gloss | 2.05 | 1.95 | 1.85 | 1.75 | 1.65 |
| 2X Spot Gloss | 2.15 | 2.05 | 1.95 | 1.85 | 1.75 |
| 3X Spot Gloss | 2.55 | 2.35 | 2.15 | 1.95 | 1.85 |
| 4X Spot Gloss | 2.80 | 2.60 | 2.40 | 2.20 | 2.00 |

### Holographic

| Finish | 64-256 | 257-640 | 641-1280 | 1281-1920 | 1921+ |
|---|---:|---:|---:|---:|---:|
| No Spot Gloss | 1.85 | 1.75 | 1.65 | 1.55 | 1.45 |
| 1X Spot Gloss | 2.25 | 2.10 | 1.95 | 1.85 | 1.75 |
| 2X Spot Gloss | 2.40 | 2.20 | 2.05 | 1.95 | 1.85 |
| 3X Spot Gloss | 2.80 | 2.60 | 2.40 | 2.20 | 2.05 |
| 4X Spot Gloss | 2.85 | 2.65 | 2.45 | 2.25 | 2.10 |

## Production Flow Confirmed

Real paid test order created a production job with:

- Customer / company info
- Product image
- Product title
- Shopify order reference
- Job ticket
- Item ticket
- Material
- Finish
- Production Finish
- Bag Color
- Sides
- Quantity
- Unit price
- Line total
- Print Work Order image
- Print Work Order clean configuration fields

## Key Commits

Latest launch-relevant commits:

- 524b2b4 Show clean configurator details on production jobs
- 461d8b3 Validate production work order image URLs
- b7f6018 Show configurator product images on production work orders
- 7550b05 Add configurator production job simulator
- 062a6d1 Fix configurator production job item mapping
- 2284ce0 Create production jobs from paid configurator orders
- b8e97f0 Lock stock bag finished price matrix
- c95d363 Open GSO cart from theme cart icon

## Files Touched In MVP

Core pricing:

- app/lib/configurator-pricing.ts
- tools/sync-stockbag-configurator-pricing.mjs

Storefront configurator / cart:

- extensions/wholesale-theme/blocks/gso-product-configurator.liquid
- extensions/wholesale-theme/assets/gso-product-configurator.js
- app/routes/apps.wholesale-lite.configurator.ts
- app/routes/apps.wholesale-lite.configurator-checkout.ts

ERP production:

- app/routes/webhooks.orders_paid.tsx
- app/routes/app.erp.production.tsx
- app/routes/app.erp.production.$id.print.tsx
- tools/simulate-paid-configurator-order.mjs

## Pre-Launch Checklist

### Must stay complete before launch

- [x] Configurator Audit green.
- [x] Stock bag products synced into ERP.
- [x] Stock bags have one base Shopify variant.
- [x] Configurator pricing matrix locked.
- [x] DB pricing rows synced: 50 corrected rows.
- [x] Quantity typing works.
- [x] Custom cart drawer works.
- [x] Header cart icon opens GSO cart drawer.
- [x] Checkout creates correctly.
- [x] Checkout properties carry correctly.
- [x] Real Shopify test payment completed.
- [x] Paid order webhook creates production job.
- [x] Production Board shows configured order.
- [x] Print Work Order shows image and clean production details.

### Still polish / non-blocking

- [ ] Checkout order summary image still shows Shopify placeholder sometimes.
- [ ] Cart drawer close/help icon has weird symbol.
- [ ] Mobile layout needs final polish.
- [ ] Add Production Board filter for configurator orders.
- [ ] Add cleanup process for simulator/test jobs.
- [ ] Connect actual Material Center cost mapping.
- [ ] Connect material deduction / usage rules.
- [ ] Add customer artwork upload / file handoff.
- [ ] Add order status automation / customer proof flow.
- [ ] Add launch monitoring checklist.

## Payment Mode

Current recommended status while testing:

- Shopify Payments: active
- Test mode: ON

Before real launch:

- Confirm final test order works.
- Delete or archive test jobs/orders if desired.
- Turn Shopify Payments test mode OFF.
- Place one real low-value internal order or manually verify checkout.
- Monitor Render logs during first real customer order.

## Known Test Payment Note

Successful Shopify Payments test card:

- Card: 4242 4242 4242 4242
- Expiry: 12 / 30
- CVC: 123

Use guest checkout / skip Shop Pay if needed.

## Launch Decision

Do not turn on real payments until these are reviewed:

- Current pricing matrix approved by GSO.
- Current production work order approved by GSO production team.
- Current cart/checkout flow approved on desktop and mobile.
- Current Shopify product collection setup approved.
- Render app is stable.
- Test mode is intentionally turned off only when ready.
