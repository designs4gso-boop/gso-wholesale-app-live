WHOLESALE LITE - PHASE 2 OVERLAY PACK

This is an overlay for your existing project:
C:\Users\golde\shopify-apps\wholesale-lite-mvp

WHAT THIS PACK ADDS
- Customer-tag based rule engine
- Quantity tier pricing logic
- Minimum product quantity logic
- Minimum cart quantity logic
- Minimum subtotal validation logic
- Public product page pricing API
- Cart validation API
- Admin pages for settings, rules, customers, dashboard
- Updated theme block + JS

INSTALL
1. Unzip this pack INTO:
   C:\Users\golde\shopify-apps\wholesale-lite-mvp

2. Allow Windows to replace files.

3. Then run:
   npx prisma generate
   npx prisma migrate dev --name wholesale_phase2
   npm run build
   shopify app deploy

TEST
- Keep your Wholesale pricing block in the product template.
- Create at least one pricing rule in the admin app.
- Refresh product page and test quantities 1 / MOQ / next tier.
- Use the cart validation API in later phase to wire cart warnings into your storefront/cart drawer.

IMPORTANT
This pack builds the Phase 2 engine and admin overlay.
Automatic checkout discount enforcement is still a later phase.
