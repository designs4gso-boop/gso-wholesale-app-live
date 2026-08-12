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

## Hotfix - Configurator sync collection ID search

Purpose:
Fix sync preview returning zero products by querying Shopify with collection_id first, then filtering required tag and product type inside ERP.

Files changed:
- app/routes/app.erp.configurator-sync.tsx

What changed:
- Collection field can accept stock-bags or numeric collection ID.
- If numeric ID is provided, Shopify query uses collection_id.
- Required tag is now filtered inside ERP.
- Product type is filtered inside ERP.
- Added sync debug panel showing raw Shopify returned count and filter counts.

Pilot collection:
- Stock Bags collection ID: 302046380097

## Hotfix - Direct Shopify collection product sync

Purpose:
Replace configurator sync page with direct Shopify collection ID product fetch because tag/product search returned zero even when tags were present.

Files changed:
- app/routes/app.erp.configurator-sync.tsx

What changed:
- Fetches products from collection(id: gid://shopify/Collection/302046380097).
- Filters required tag and product type inside ERP.
- Adds debug panel showing raw Shopify products returned, tag matches, product type matches, and final matches.
- Uses Stock Bags collection ID as default.

## Patch - Storefront product configurator pilot

Purpose:
Add customer-facing GSO Product Configurator theme app block for configurator-pilot products.

Files changed:
- app/routes/apps.wholesale-lite.configurator.ts
- app/routes.ts
- extensions/wholesale-theme/blocks/gso-product-configurator.liquid
- extensions/wholesale-theme/assets/gso-product-configurator.js
- extensions/wholesale-theme/assets/gso-product-configurator.css

What it adds:
- Public app proxy endpoint /apps/wholesale-lite/configurator
- Reads synced ConfiguratorProduct by shop + handle/product GID
- Pulls Material, Finish, Bag Color options from ERP
- Calculates price from ConfiguratorPricingRule
- Shows Price Each, Order Total, Matched Tier
- Adds line item properties for ERP/order sync
- Only renders block for products tagged configurator-pilot

Notes:
- Pilot only.
- Does not remove Shopify variants yet.
- Does not alter order webhook yet.

## Hotfix - Storefront configurator JSON response

Purpose:
Fix Render deploy failure caused by importing json from react-router. This app version does not export json from react-router.

Files changed:
- app/routes/apps.wholesale-lite.configurator.ts

What changed:
- Removed import { json } from react-router.
- Added jsonResponse helper using native Response.
- Replaced return json(...) with return jsonResponse(...).

## Patches 15G.1 - 15Z.1 (2026-08-09 .. 2026-08-12) — consolidated record
Full detail lives in docs/GSO_ERP_PROJECT_STATE.md and
docs/GSO_ERP_JOB_IDENTITY_AND_ROUTING_CONTRACT.md. Sequence:
15G.1/1A security lockdown + credential masking; 15G.2/2A single price
truth; 15G.3 canonical calculator; 15G.4A-C UV market + specialty policy;
15G.5/5A storefront convergence + launch calibration; 15G.5B checkout
hardening (dead originalUnitPrice field + null-rule crash; proxy never
5xx); 15G.5C/5C.1 MOQ 50 cleanup; 15G.5D single purchase path; 15G.5E
1,886 description cleanup; 15H.0 ticket-first forensic audit; 15H.1/1A/1B
DB-unique tickets (+ RR 7.13.2 server/client boundary fixes); 15H.2 strict
RIP identity; 15H.3 review/retry (agent 1.6); 15H.4A/4A.2 order
convergence (orderGid + canonical consumption); 15H.4B manual jobs;
15H.4C merge/link; 15H.5 runs/reprints/QC (agent 1.7); 15Z final audit
(GO WITH MINOR DEBT); 15Z.1 this cleanup. ERP: FUNCTIONALLY COMPLETE.
Next: PHASE 16 — Shopify Store Rebuild & Optimization (16A-16I).

## Phase 16A-16C (2026-08-12) — store safety + product revenue activation
16A read-only store audit (P0s: 31 legacy bags + jars natively purchasable,
misc placeholder products, 277-collection chaos). 16B containment: 39
products drafted (31 legacy bags + 8 jars, rollback artifact), quick-add
suppression CSS, read-only scopes (content/navigation/themes) staged,
owner navigation runbook (docs/GSO_STORE_16B_NAVIGATION_RUNBOOK.md).
16C revenue activation:
- 31 legacy Stock Bags rebuilt to canonical architecture and REACTIVATED
  (tools/rebuild-legacy-bags-16c.mjs + legacy-bag-rebuild-lib.mjs):
  24-variant matrix collapsed to single Default Title variant @1.00
  CONTINUE, options deleted, configurator-pilot tag + templateSuffix,
  ConfiguratorProduct rows (sync-route parity), per-product verification
  before activation. Canary-first gated sequence; rollback artifact in
  tools/rebuild-16c-data/ (gitignored). Store: 1,886 Stock Bags ACTIVE,
  1,886 ERP rows, pricing pins green ($1.80/$180, $1.92/$960, $2.70@50,
  MOQ clamp, 9X+/5000+ quotes) on rebuilt + healthy handles.
- CRITICAL Part C finding: 1,854 healthy bags have templateSuffix=null ->
  default theme template -> NATIVE $1.00 purchase path, no configurator,
  no lockout (only ritz + the 31 rebuilt render the configurator).
  Fix tool committed (tools/fleet-template-16c.mjs, dry-run verified
  1854/0 excluded); execution pending owner:
  `node tools/fleet-template-16c.mjs --execute`.
- 4 misc placeholder products (4x5-custom-pouch, 4x5-sticker-bag 210
  variants, 14x16-sticker-bag, 4x5-box — empty productType, no lockout)
  DRAFTED via tools/misc-containment-16c.mjs with rollback artifact.
- Jars: applied-label ERP layer complete (10 profiles named "with Applied
  Label", 440 pricing rules, 9 ConfiguratorProduct rows) but ALL jar rows
  lack shopifyVariantGid and products stay DRAFT. BLANK jar sell prices do
  not exist anywhere (bare-jar vendor costs + tiers do) — blocked on the
  owner pricing question only, per 16C stop rule.
- Tests 1048 (baseline 1037 + 11 rebuild-lib pins), TS 304 baseline,
  build green. No app-code changes; tools + tests + docs only.

## Phase 16D (2026-08-12) — Miron jar revenue activation (owner pricing authority)
Owner-approved applied-label jar launch (NO blank jars — jar+lid+printed
label+application included; Matte/Gloss base included):
- app/lib/canonical-jar-pricing.ts: THE jar pricing authority. 100ml
  (4.95/4.50/4.00/3.75/3.50/3.35) + 150ml (6.50/6.00/5.75/5.50/5.25/4.95)
  at 50/100/250/500/1000/2500; holographic +20% of BASE (never layered
  subtotal); universal specialty ladder 0X..8X (+0.30/0.50/0.70/0.90/
  1.10/1.30/1.50/1.75); 9X+ and 5,000+ request quote; MOQ 50. Application
  labor $0.20/jar is COST-side only. Never derived from margins/legacy
  rules/competitors.
- Proxy + checkout launch-jar branches (jar_100ml_tall/wide, jar_150ml):
  material control = base finish, labelSet control = label material,
  finish control = specialty ladder; server recomputes at checkout and
  attaches the family-aware `_GSO Canonical` jar snapshot
  (order-canonical.server.ts parseCanonicalJarOrderLine — bag parser and
  jar parser never cross-parse).
- Paid order -> ProductionJob: jar canonical snapshot is authoritative
  (size/qty/base/label/holo/specialtyX/price + warnings); jar
  materialSummary is token-hygienic so 0X+Standard routes Mimaki
  (default CMYK) while specialty layers ("Gloss Layers: NX") and holo
  (technical "White Layers: 1") route Roland via the ONE existing
  decider. All-jar orders take the premium-jars checklist (+ new
  "Labels cut" stage); bag orders keep default byte-identically.
- Theme extension (REQUIRES `shopify app deploy`): lockout body class +
  native-form submit interception now apply to jars (the legacy jar
  native-variant purchase path is closed); jar-aware field labels
  (Base Finish (Included) / Specialty / Label Material); jar notice
  states included application.
- tools/rebuild-jars-16d.mjs: canonicalized 100ml-tall/100ml-wide/150ml
  Miron products (30-variant matrix -> single Default Title @1.00
  CONTINUE, configurator-pilot tag, productType "Jars", template "jar"
  kept, ERP rows: variant GID backfilled + minQuantity 50 + active).
  Products HELD AT DRAFT: --activate only after the owner deploy.
  Rollback artifact tools/rebuild-16c-data/rollback-16d-jars.json.
- Legacy jar disposition: miron-jars (combined 12-variant) = REPLACED,
  stays DRAFT; 50mml/250ml-miron-jars + 3oz/4oz-jar = future sizes,
  stay DRAFT.
- Tests 1076 (28 new jar pins incl. the owner $7.50 stack example);
  TS 304; build green; prisma valid.
