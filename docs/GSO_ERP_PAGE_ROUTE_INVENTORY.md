# GSO ERP — Page & Route Inventory (Phase 15A, 2026-07-24)

Audit-only. 75 route files; 33 embedded-admin nav links; 55 Prisma models.
Status letters: L = loader, A = action, C = component (page).
Dispositions are RECOMMENDATIONS only — nothing was changed.

## Admin pages (in navigation, listed in nav order)

| Route | File | Nav label | Purpose | Reads / writes | Status | Disposition |
|---|---|---|---|---|---|---|
| /app | app._index.tsx | Dashboard | Landing hub: counts (quotes, recipes, materials, machines, vendor products) + links | reads 6 models / writes none | active | keep |
| /app/erp/setup-wizard | app.erp.setup-wizard.tsx | Setup Wizard | Launch-readiness checks over 19 models (blockers vs warnings) | reads 19 models / none | active, diagnostic | keep (Admin group) |
| /app/erp/walkthrough | app.erp.walkthrough.tsx | ERP Walkthrough | Staff SOP, read-only by design | none | active | keep |
| /app/quotes | app.quotes.tsx | Quotes / CRM | Quote CRM: create/edit, status, low-margin approval, deposit/balance draft orders, invoice email, production-job creation | quote, quoteItem, productionJob(+Event/File), pricingRule, productCost, productRecipe | active, core | keep |
| /app/erp/agent-review-queue | app.erp.agent-review-queue.tsx | Agent Review Queue | Review/approve AI-agent submissions | agentReviewQueueItem/Event, productRecipe | active | keep |
| /app/erp/production | app.erp.production.tsx | Production | Production board (95KB): jobs, checklists, materials usage, print-log links | 11 models | active, core | keep |
| /app/erp/reports-dashboard | app.erp.reports-dashboard.tsx | Reports Dashboard | Read-only cross-model reporting | 7 models / none | active | keep |
| /app/erp/print-logs | app.erp.print-logs.tsx | Print Logs | Imported print-log rows + conservative job matching | printLogEntry/Import, productionJob(+Event) | active | keep (group under Imports) |
| /app/erp/rip-imports | app.erp.rip-imports.tsx | RIP Imports | RIP file import status/settings | printLog* + productionJob | active | keep (Imports) |
| /app/erp/rip-import-review | app.erp.rip-import-review.tsx | RIP Import Review | 13A.7C duration/attribution audit + guarded writeback | printLog*, productionJob(+Event/Item) | active | keep (Imports) |
| /app/erp/print-intake | app.erp.print-intake.tsx | Print Intake | Automated intake agent status/instructions (13A.6G) | printLogAutoImportSetting | active | keep (Imports) |
| /app/erp/cost-calculator | app.erp.cost-calculator.tsx | Cost Calculator | THE daily quoting flow (14C.2 arc): product-driven costing → auto tiers → draft quote. Also contains 14B manual fallback + legacy calculator + sync panel | material, vendorProduct, printLog*, quote | active, core (153KB — largest route) | keep; later extract legacy/manual into separate Advanced route |
| /app/erp/product-setup | app.erp.product-setup.tsx | Setup · Product Setup | Recipe Builder (103KB): ProductRecipe + 8 recipe child tables + profile linkage | productTypeProfile, productRecipe, recipe*, sourcedCostTier, machine, material | active, core setup | keep — becomes the single product home (15B) |
| /app/erp/products/new | app.erp.products.new.tsx | Setup · Add Product | Intake wizard (4 modes) → creates ONE ProductRecipe draft (status archived) → redirects into Product Setup | reads pickers; writes productRecipe via $transaction | active, thin front-door | merge into Product Setup as its "New Product" tab (15B) |
| /app/erp/materials | app.erp.materials.tsx | Setup · Materials | Materials master (58KB): variants, vendors, cost history, inventory movements, purchase links | 10 models | active, core setup | keep |
| /app/erp/machines | app.erp.machines.tsx | Setup · Machines | Machines + per-channel ink costs (MachineInkChannel.costPerMl) | machine, machineInkChannel | active | keep — should become the ink-rate source of truth (currently duplicated by INK_RATES constants) |
| /app/erp/vendors | app.erp.vendors.tsx | Setup · Vendors | Vendor master + contacts | vendor, vendorContact, vendorProduct, material, purchaseRequest | active | keep |
| /app/erp/vendor-cost-book | app.erp.vendor-cost-book.tsx | Setup · Vendor Cost Book | Staging/review layer: VendorCostBookItem(+Tier) with applyToMaterial / applyToVendorProduct / seedFrom* actions | vendorCostBook*, vendorProduct(+Tier), material(+History), vendor | active | keep as owner cost-intake surface; long term embed as product "Vendor Cost" tab (15B) |
| /app/erp/cost-verification | app.erp.cost-verification.tsx | Audit · Cost Verification | Read-only cost workbook (68KB) | 10 models | active, diagnostic | keep (Reports & Audits) |
| /app/erp/cost-health | app.erp.cost-health.tsx | Audit · Cost Health | Read-only cost-data health | 8 models | active, diagnostic | keep (Reports & Audits); candidate to merge with Cost Verification |
| /app/erp/shopify-cost-audit | app.erp.shopify-cost-audit.tsx | Audit · Shopify Cost Audit | Read-only Shopify-vs-ERP cost compare (12B.2b) | configuratorProduct, material, productRecipe, vendorProduct | active, diagnostic | keep (Audits) |
| /app/erp/actual-costs | app.erp.actual-costs.tsx | Audit · Actual Costs | Read-only actual-cost dashboard from RIP/print logs (13A.5) | machine, material, printLogEntry, productionJob | active, diagnostic | keep (Audits) |
| /app/erp/calibration | app.erp.calibration.tsx | Audit · Calibration | Read-only calibration recommendations (13A.8A) | erpAdminSetting, machine, printLogEntry, productionJob | active, diagnostic | keep (Audits) |
| /app/erp/pricing-health | app.erp.pricing-health.tsx | Audit · Pricing Health | Read-only pricing-rule/configurator health | 7 models | active, diagnostic | investigate merge with Cost Health (overlapping "health" pages) |
| /app/erp/configurator-audit | app.erp.configurator-audit.tsx | Audit · Configurator Audit | Read-only stock-bag configurator audit | configurator*, recipeVariantRule | active, diagnostic | keep (Audits) |
| /app/erp/admin-settings | app.erp.admin-settings.tsx | Owner · Admin Settings | ErpAdminSetting key/value editor (rates etc.) | erpAdminSetting | active | keep (Admin) |
| /app/erp/agent-security | app.erp.agent-security.tsx | Owner · Agent Security | Agent API credentials + submission log + diagnostics | agentApiCredential, agentSubmissionLog | active | keep (Admin) |
| /app/erp/pricing-rules | app.erp.pricing-rules.tsx | Owner · Pricing Rules | Wholesale-app PricingRule editor (65KB) — the ERP tier-pricing table | pricingRule | active | keep (Admin); clarify naming vs margin curves |
| /app/erp/configurator | app.erp.configurator.tsx | Owner · Configurator | Live stock-bag configurator admin | configurator*, productTypeProfile | active, PROTECTED (live checkout) | keep, do not touch |
| /app/erp/configurator-sync | app.erp.configurator-sync.tsx | Owner · Configurator Sync | Push configurator pricing to Shopify | configuratorProduct | active, PROTECTED | keep |
| /app/erp/configurator-mapping | app.erp.configurator-mapping.tsx | Owner · Manual Mapping | Stock-bag product mapping | configuratorProduct | active | keep (Admin) |
| /app/erp/configurator-jar-mapping | app.erp.configurator-jar-mapping.tsx | Owner · Jar Mapping | Jar configurator mapping (pilot) | configuratorProduct, productTypeProfile | active, pilot | keep (Admin) |
| /app/erp/shopify-links | app.erp.shopify-links.tsx | Owner · Shopify Links | Shopify product/collection link inspector (96KB, GraphQL-heavy) | Shopify API + exceptions marker | active, owner tool | keep (Admin) |
| /app/erp/margin-review | app.erp.margin-review.tsx | Owner · Margin Review | Margin audit over quotes with thresholds (71KB; own hardcoded labor defaults) | marginReviewSetting via libs | active, diagnostic | investigate — overlaps Cost Verification + quote-margin lib; its private defaults (labor $25/hr, $0.15/side) duplicate owner standards |

## Routed pages NOT in the navigation

| Route | Purpose | Status | Disposition |
|---|---|---|---|
| /app/erp/agent-review-queue/new | Manual queue-item entry form | active, reachable from queue page | keep (contextual link) |
| /app/erp/agent-product-rules, agent-intake-rules, agent-quote-prep-rules, agent-quote-prep-draft-shape, agent-review-queue-rules | 5 tiny JSON rule viewers for agent integration | active, diagnostic, unlinked | keep as API-ish docs endpoints; group under Admin or document |
| /app/erp/print-log-settings | RIP/print-log sync settings + token | active, unlinked (referenced by calculator/RIP pages) | keep; link from Imports group |
| /app/erp/production-calendar | Production calendar view | active, unlinked | investigate — link under Production or merge |
| /app/erp/production/:id/print, /:id/proof | Per-job print packet / proof management | active, contextual | keep |
| /app/erp/purchase-requests | Purchase-request workflow (44KB) | active, unlinked | link under Vendors & Costs group |
| /app/erp/purchase-export | Purchase-order export | active, unlinked | keep (contextual) |
| /app/erp/reorder-report | Material reorder report | active, unlinked | link under Reports |
| /app/wholesale, /app/wholesale/rules, /app/wholesale/customers | ORIGINAL Wholesale Lite admin (approvals, discount rules) | active but unlinked — orphaned from nav | investigate: still a live product feature (storefront app proxy depends on rules); add back under Admin or a Wholesale group |

## Non-page routes

| Route | Purpose | Status |
|---|---|---|
| /api/agent/intake | Token-authed agent intake API (26KB) | active |
| /api/print-intake/route-plan, /api/print-intake/report | Intake agent plan (read-only) + outcome recorder | active |
| /api/print-logs/upload, /api/rip-imports/upload, /api/quote-rip-results/sync | Token-authed local-agent uploads | active |
| /apps/wholesale-lite{,/pricing,/configurator,/configurator-checkout,/validate} | PUBLIC storefront app-proxy contracts (configurator + wholesale pricing + cart validate) | active, PROTECTED — do not change |
| /quote/:id | Public customer quote view (customer-safe field selection) | active |
| /proof/:token | Public token-gated proof approval | active |
| /webhooks/orders_paid | Paid order → quote update + ProductionJob creation | active, core bridge |
| /webhooks/app/uninstalled, /webhooks/compliance | Shopify lifecycle | active |
| /auth/*, /auth/login, /_index | OAuth + landing | active |
| /app/create-wholesale-discount, /app/create-configurator-cart-transform | One-shot Shopify setup utilities | utility | keep (Admin utilities) |

## Retired redirect stubs (kept deliberately outside the /app layout)

| Route | Redirects to | Disposition |
|---|---|---|
| /app/wholesale/calculator | cost-calculator | retain stub; safe to delete after link audit |
| /app/product-costs, /app/erp/product-costs | product-setup | retain stub; app.erp.product-costs.tsx is 0KB dead file — safe to delete later |
| /app/create-order | quotes | retain stub |

## Counts
- 75 route files: 36 admin pages in nav, 9 admin pages/forms unlinked, 6 API endpoints, 5 storefront proxy endpoints, 3 public token/customer pages, 4 webhooks/auth, 5 retired stubs, remainder utilities/layout/index.
- No route is dead/unreachable except the 0KB `app.erp.product-costs.tsx` placeholder (routed but empty → renders nothing; its sibling stub at /app/product-costs handles the redirect).
