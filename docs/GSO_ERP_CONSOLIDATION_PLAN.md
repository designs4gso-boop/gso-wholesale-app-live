# GSO ERP — Consolidation Plan & Finish-Line Roadmap (Phase 15A, 2026-07-24)

Recommendations only — nothing here was implemented. Base data:
docs/GSO_ERP_PAGE_ROUTE_INVENTORY.md and docs/GSO_ERP_DATA_OWNERSHIP_MAP.md.

## A. Proposed navigation (8 groups, 36 nav pages → ~24 visible)

1. **Daily Work**: Cost Calculator · Quotes / CRM · Production (+ calendar as a tab) · Agent Review Queue
2. **Quotes & Sales**: (folded into Daily Work — no separate group needed at current team size)
3. **Production**: Production board · Production Calendar · Print packets/proofs (contextual)
4. **Products & Pricing**: Product Setup (single product home after 15B, absorbing Add Product as its "New Product" tab) · Materials · Machines
5. **Vendors & Costs**: Vendors · Vendor Cost Book · Purchase Requests · Reorder Report · Purchase Export (contextual)
6. **Imports & Automation**: Print Intake · RIP Imports · RIP Import Review · Print Logs · Print Log Settings (currently unlinked — add) · Agent Security
7. **Reports & Audits**: Reports Dashboard · Cost Verification · Cost Health (merge candidate with Pricing Health) · Shopify Cost Audit · Actual Costs · Calibration · Configurator Audit · Margin Review
8. **Admin / Advanced**: Setup Wizard · Walkthrough · Admin Settings · Pricing Rules · Configurator (+Sync/Mapping/Jar Mapping — PROTECTED live checkout) · Shopify Links · Wholesale Lite admin (wholesale/rules/customers — currently ORPHANED from nav; re-link here) · setup utilities · Legacy tools

Navigation problems found (concrete):
- "Setup · Product Setup" vs "Setup · Add Product" read as duplicates; Add Product is actually a wizard that creates a ProductRecipe draft and redirects INTO Product Setup — merge as a tab (15B).
- Seven "Audit ·" links + Reports Dashboard + Margin Review = nine read-only report pages at top level; group and collapse.
- Unlinked-but-active pages: print-log-settings, purchase-requests (44KB workflow!), purchase-export, reorder-report, production-calendar, agent rule viewers, agent-review-queue/new, and the whole Wholesale Lite admin (app/wholesale*) — either link them in their groups or mark internal.
- Naming confusion: "Owner · Pricing Rules" edits the WHOLESALE PricingRule table, not calculator margins; "Cost Health" vs "Pricing Health" vs "Cost Verification" overlap; "Manual Mapping"/"Jar Mapping" are configurator-specific but the labels don't say so.
- Diagnostic-vs-daily mixing: RIP/print pages sit between daily pages in the flat list.

## B. Product-setup consolidation (the 15B core)

Current reality (audit E):
- A NEW CALCULATOR PRODUCT today = a VendorProduct(+tiers) entered in Vendor Cost Book (or seed script), auto-classified by classifyCalculatorProduct — **no code needed for a new record inside an existing family** (proven by 14C.2A Chiron and the 4x6/5x8/6x9 flow). A NEW FAMILY still requires code (UI family list, engine mapping, margin key).
- Product Setup = ProductRecipe builder (production/cost source of truth, 8 child tables).
- Add Product = intake wizard (4 modes incl. new-family + Shopify linkage) that creates a draft recipe → redirects to Product Setup. Not a true duplicate; a front door.
- Vendor Cost Book = cost intake/review staging (VendorCostBookItem+Tier) with explicit apply-to-Material / apply-to-VendorProduct actions and seed-from actions.
- Configurator pages = separate PROTECTED live stock-bag system.

Recommended single "Add/Edit Product" home: **Product Setup**, restructured into tabs:
1. Basics (name/family/status/MOQ — family from ONE registry)
2. Vendor Cost (embedded VendorProduct+Tier editor; Cost Book remains the separate intake/review surface feeding it)
3. Calculator Rules (classification preview, application/packout standards, waste)
4. Features (VendorProductAddOn)
5. Shopify (GID links; current Shopify-links tooling stays owner-level)
6. Production Recipe (existing recipe children)

Product status model to adopt (15B): Draft → Unverified (record exists, cost not owner-verified — today's "NO PRICE — not verified") → Verified (owner-confirmed cost) → Active/Inactive (visibility). Today verification is IMPLICIT (cost>0 = Verified); an explicit verified flag on VendorProduct/VendorCostBookItem.status is the one schema addition worth considering in 15B.
Duplicate prevention: enforce unique normalized vendorSku per shop (already the de-facto key used by seeds/dedupe) + a name-similarity warning in the UI; the 14C.2 picker dedupe (sku/name) already hides mirror Material rows.

## C. Phased finish-line roadmap

**Phase 15B — Consolidate product setup.**
Purpose: one product home + one family registry + explicit verification status.
User-visible: Product Setup tabs; Add Product becomes a tab; family list driven by registry; NO behavior change to live pricing.
Areas: product-setup/products.new routes, product-driven-costing lib (family registry consumption), optional VendorProduct.status field (only schema change candidate).
Risk: medium (touches the biggest routes); mitigated by keeping calculator engines untouched.
Dependencies: none. Tests: registry mapping pins, classifier regression, wizard→tab parity. Exit: owner adds a product record end-to-end without code; 467+ tests green.

**Phase 15C — Add DTP through the unified model.**
Purpose: Custom Printed Pouches / DTP Bags family live per docs/GSO_ERP_DTP_READINESS_PLAN.md.
User-visible: DTP family in the calculator with Spektra sizes, tiers, included features, $85/PO freight preset, dtp-pouches researched curve.
Areas: product-driven-costing (bag_dtp class + family), calculator route, seed-spektra-dtp.mjs, freight preset, tests.
Risk: low-medium (additive; engine versioned). Dependencies: 15B family decision (or accept one code family). Exit: quote a 2500-unit 5x4x2 with correct $0.5419 blank, one $85 freight, Draft-Only-safe behavior for unpriced future sizes.

**Phase 15D — Finish quote-to-production handoff.**
Purpose: close the gaps found in audit I: calculator snapshots flow into ProductionJob; unify the two job-creation paths (quotes button vs orders_paid webhook) on one shared server function; carry label rows/top/config into job items; link deposit/balance states.
Risk: HIGH (touches money + live webhook) — feature-flag + parallel run. Exit: a saved 14C.2 quote reaches the production board with its full config and quoted-cost snapshot attached.

**Phase 15E — Actual-cost feedback loop.**
Purpose: quoted-vs-actual on every completed job using the existing variance/calibration engines; surface per-family calibration deltas back to the calculator's provisional models (layer model, machine minutes) via guarded owner apply.
Risk: medium. Dependencies: 15D snapshot carry-through. Exit: variance report per quote family; calibration apply path with owner gate.

**Phase 15F — Navigation cleanup + legacy retirement.**
Purpose: implement section A; extract the legacy manual calculator + 14B manual panel out of the 153KB calculator route into an Advanced route; retire redirect stubs and the 0KB product-costs file; re-link or explicitly archive the orphaned Wholesale admin.
Risk: low-medium (link breakage; test pins). Exit: nav matches groups; calculator route size cut; all pins updated.

**Phase 15G — Final acceptance audit.**
Purpose: re-run this 15A audit checklist; full acceptance suite (quote→production→actuals happy path per family); security re-check; docs consolidation to one master state doc.
Exit: all criteria green; marketing/sales agents cleared to connect.

**Priority before sales/marketing agents connect to Shopify:** 15B + 15C
(products/pricing correctness), the 15D webhook unification (agents create
orders → jobs must be reliable), and the security items in the diagnostic
(token display, agent scopes) — navigation polish (15F) can trail.

## Phase 15B — SHIPPED (2026-07-24)
Delivered: shared product-family registry (7 entries incl. reserved dtp-bags)
consumed by the calculator (options + URL gates) and Product Setup (vocabulary);
owner-standards registry with legacy-rate quarantine ($0.078125 4x5 standard
authoritative; $0.1111 + $25/hr legacy values documented, fallback-only);
Product Setup grouped as the product home (sections 1-6 + New Product wizard
entry + read-only Vendor Cost status panel); derived product status
(Draft/Unverified/Verified x Active/Inactive) with Cost Book review as the
better-than-cost basis; duplicate warnings on recipe + cost-item creation.
Deferred to later phases: true tab routing, embedded VendorProduct editing in
Product Setup, products.new wizard family list (sales-key based, registry-
indexed via tests), Machines/ErpAdminSetting-backed rates, explicit
VendorProduct.status field (optional 15B+ schema candidate).
