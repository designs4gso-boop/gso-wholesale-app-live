# GSO ERP / Shopify App - Codex Instructions

## Project
This is the GSO wholesale / ERP Shopify app.

Repo:
C:\Users\golde\shopify-apps\wholesale-lite-mvp

GitHub:
designs4gso-boop/gso-wholesale-app-live

Render service:
gso-wholesale-app-live

Shop:
942075-2.myshopify.com

## Workflow rules
- Make small patches only.
- Do not rewrite large files unless specifically asked.
- Preserve the existing stock bag configurator and checkout flow.
- Do not reset, delete, or reseed production data unless explicitly asked.
- Do not touch Shopify live product data unless explicitly asked.
- Prefer adding new routes/tools over breaking existing working routes.
- After any code patch, run:
  npm run build
- Before commit, run:
  git status
  git diff --stat
- Use clear commit messages.
- If unsure, stop and ask.

## Current state
Stock bag configurator is already live and working.
Jar ERP foundation is seeded:
- product type profiles
- blank jar materials
- vendor costs
- manufacturer cost tiers
- base sell tiers
- finish pricing matrix
- label zones
- configurator options

Current jar admin route:
- /app/erp/configurator?productFamily=jars

Important jar product types:
- jar_50ml
- jar_100ml_tall
- jar_100ml_wide
- jar_150ml
- jar_250ml
- jar_3oz_clear
- jar_3oz_black_white
- jar_4oz_clear
- jar_4oz_black_white

Do not include jar_5oz_clear in storefront/customer flow yet. It is cost-only/placeholder.

## Next build goals
1. Verify jar admin calculator output.
2. Make jar selections safe.
3. Connect jar quote/configurator output to cart/line item properties later.
4. Update paid order webhook later so jar label zones flow into production job notes.

## Caution
Do not guess database schema fields. Inspect Prisma schema first.
