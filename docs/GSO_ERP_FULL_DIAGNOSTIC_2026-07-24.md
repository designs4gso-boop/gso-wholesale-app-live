# GSO ERP — Full Diagnostic (Phase 15A, 2026-07-24)

Audit-only: no app code, schema, data, routes, navigation, or pricing logic
was changed. Companion docs: GSO_ERP_PAGE_ROUTE_INVENTORY.md,
GSO_ERP_DATA_OWNERSHIP_MAP.md, GSO_ERP_CONSOLIDATION_PLAN.md,
GSO_ERP_DTP_READINESS_PLAN.md.

## 1. Executive summary

The app is one codebase carrying THREE systems: (1) the original Wholesale
Lite storefront app (approvals, discount function, app-proxy pricing), (2) the
PROTECTED live stock-bag configurator + checkout, and (3) the GSO ERP (the
active build: calculator → quotes → production → imports → audits). The daily
quoting path (14C.2 arc) is in good shape: server-recomputed, engine-versioned,
well-tested. The real problems are ORGANIZATIONAL, not functional: 36 flat nav
links mixing daily/diagnostic/owner pages; product data split across
VendorProduct, Vendor Cost Book (staging), Materials, code presets, and four
independent product-family lists; and owner cost standards (ink, labor,
machine rate) duplicated between code constants and database tables that
disagree in places. Quote→production works through two different creation
paths that carry different fields. DTP/Spektra fits the existing schema with
no migration — enter it as 4 VendorProducts + 16 tiers + add-ons once Phase
15C adds the family to the calculator. Consolidation order: product setup
(15B) → DTP (15C) → production handoff (15D) → actuals loop (15E) → nav/legacy
cleanup (15F) → acceptance (15G).

## 2. Repository baseline (A)

- Branch `main`, clean tree; remote origin github.com/designs4gso-boop/gso-wholesale-app-live.
- HEAD `eb420a3` "Complete product-to-price quoting with corrected jar and bag catalog" (the 14C.2/2A/2A1 arc, committed since the last session); previous: d0df397, 9fb00fe, c8c4810, c28d8ce, 0cc8814, 196db0b, 97b6fb2, d9e2c8b, 0834566.
- Framework: React Router 7.12 SSR + @shopify/shopify-app-react-router 1.2, Polaris 13.9, Prisma 6.19 (SQLite dev / Postgres prod — local .env points at the PRODUCTION Render Postgres), Vite 5.4, Vitest 4.1, TS 5.8.
- Scripts: dev/build/start/setup/prisma:migrate/prisma:generate/typecheck/test.
- Prisma: 55 models; 3 migration folders (0_init, 20260707130000_add_low_margin_approval_fields, 20260707150000_add_quote_customer_tier). `prisma migrate status` was NOT run against the production DB during this audit (deliberate: read-only posture; folder inventory used instead). docs/MIGRATIONS.md exists.
- Tests: 20 files, **467 passing**. TypeScript: **308 errors = accepted baseline** (zero new). Build: clean (client + server). `git diff --check`: clean.

## 3. Architecture map — calculator flow (H)

Family select (ProductDrivenForm, canonical values sticker-bags/standard-jars/
premium-jars/stickers-labels/banners/custom-item; legacy accepted) →
`classifyCalculatorProduct` over VendorProduct + blank Materials + code
presets (dedupe by sku/name; class gates via `blankClassAllowedFor`) →
material picker (`resolvePrintMaterialCostPerSqft`) → printer constants
(printerHasWhite/Gloss in route) → labels/faces (`buildLabelRows`, 1–6, same
or per-row) → sqft (row sum) → waste (recipe null → provisional 10% + owner
override) → ink (INK_RATES + provisional linear layer model) → machine time
($8/hr owner standard × passes) → setup labor (OWNER_LABOR art+print/design)
→ application (`bagApplicationRateFor` by size; jars $0.20 × labels) → packout
(PACKOUT_RULES) → freight (`computeFreight`, separate visible line) →
`computeProductDrivenCost` totals → auto tiers (per-qty engine reruns ×
`marginFamilyKeyFor` → FAMILY_MARGIN_RULES curve, 40% floor, override phrase)
→ customer price selection → save (psearch transport; full server recompute;
snapshot engine 14C.2-multilabel-auto-tiers; topEngine 14C.1B1) →
Quote/QuoteItem (costSnapshot/priceSnapshot JSON).

Files: app/routes/app.erp.cost-calculator.tsx (153KB); app/lib/
product-driven-costing.server.ts, calculator-emergency.server.ts,
cost-calculator.server.ts, auto-costing.server.ts (14B.1 auto path),
recipe-pricing.server.ts (waste divisor), material-classify.ts.

- Hardcoded business rules: INK_RATES, OWNER_LABOR, WIRED_LABOR, MACHINE $8/hr, MATERIAL_ROLLS, PACKOUT_RULES, FAMILY_MARGIN_RULES + 40% floor, SUGGESTED_QUANTITIES, presetBlankItems(), printer capabilities, CHIRON flat-cost guard, REQUIRED_STICKER_BAG_SIZES, canonical Miron tops.
- Database-backed: VendorProduct(+Tier/+AddOn), Material(+children), Machine(+InkChannel — EDITABLE but NOT read by the calculator), ProductRecipe(+8 children), ErpAdminSetting.
- Provisional (labeled): white/gloss linear layer model, 10% waste default, Roland uniform ink rate, weeding estimate, machine minutes/sqft unknown.
- Missing rules: Mimaki gloss $/ml; application standards beyond 4x5/14x16 bags; Miron separate-top prices; researched curves for standard jars and non-4x5 bags; units-per-box beyond 4x5/3oz/4oz.
- Unsafe-input surface: manual fallback accepts client evar/esetup BY DESIGN (labeled manual_override); product mode ignores posted totals everywhere.
- Stable — do not touch: margin curves/floor/gates, freight math, Miron top logic, engine snapshot versioning, storefront proxy routes, configurator checkout.

## 4. Quote-to-production trace (I)

- Calculator save → Quote(status draft)+QuoteItem with snapshots. WORKS.
- Quotes/CRM: statuses draft→sent→approved→production (+Deposit/paid/Completed); low-margin approval gate (phrase + persisted approval fields); deposit/balance/full draft orders + invoice emails (Shopify GraphQL); public /quote/:id customer view (customer-safe field whitelist); /proof/:token approval. WORKS.
- Production creation path 1: quotes intent `createProductionJobFromQuote` — copies quoteId/quoteItemId, recipe, sku, unitCost/unitPrice, **costSnapshot + priceSnapshot**, checklists, events. GOOD.
- Production creation path 2: `webhooks/orders_paid` — creates ProductionJob linked to quote but with a THINNER field set (no recipe/sku/unit pricing fields in the item create; snapshot only partially referenced). DIVERGENT — the two paths can produce different-shaped jobs for the same quote. → Phase 15D: extract ONE shared job-builder function.
- Actual costs: PrintLogEntry attribution → actual-costs/variance/calibration READ-ONLY dashboards exist; guarded writeback (APPLY PRINT LOG ACTUALS phrase) exists. Quoted-vs-actual comparison exists in the variance lib; per-QUOTE-family rollup is the 15E gap.
- Missing transitions: no automatic quote→production on approval (manual button — acceptable); no Customer model (quote-embedded contact fields); deposit/balance state lives on Quote booleans; label-row/config detail reaches the job only inside the snapshot JSON (not first-class fields) — fine for print packet, verify in 15D.

## 5. Duplication audit — top findings with exact locations (F)

1. **Product-family lists ×4**: app/lib/product-driven-costing.server.ts (calculator families) vs calculator-emergency.server.ts FAMILY_MARGIN_RULES (bags-4x5/chiron-jars/... + aliases incl. "safecare") vs app/lib/product-family-sales-rules.ts (jars/sticker-bags/dtp-pouches + MOQs) vs ProductTypeProfile rows from tools/seed-product-families.mjs (stock_bag_4x5/dtp_normal_bags/...). Hand-mapped by marginFamilyKeyFor/resolveMarginFamily/uiFamilyToEngine. VALUES DISAGREE in naming and granularity today. Consolidate → one registry (15B).
2. **4x5 bag application rate ×2**: OWNER_LABOR.bagLabelApplicationPer = 20/256 = $0.078125 (calculator-emergency.server.ts) vs WIRED_LABOR.bag4x5PerSide = 20/180 = $0.1111 (cost-calculator.server.ts). Different eras of owner standards; product engine uses the first, legacy calculator the second. DISAGREE TODAY → owner must pick one (15B standards table).
3. **Ink rates**: INK_RATES constants vs MachineInkChannel.costPerMl (edited in Machines page, read by production/audits, NOT by the calculator). Risk of silent drift → wire calculator to DB after calibration (15E).
4. **Machine rate**: $8/hr constant in calculator vs Machine.costPerHour vs margin-review's private $25/hr labor + $0.15/side constants (app/routes/app.erp.margin-review.tsx lines ~5-8). THREE sources.
5. **Vendor costs ×3 layers**: VendorProduct(+Tier) (truth) vs VendorCostBookItem(+Tier) (staging with manual apply) vs presetBlankItems() in the calculator route (code prices; superseded-by-sku mechanism hides most). Remaining live presets: customer-supplied, OZ bag, soda can.
6. **Two costing engines + a third pricing system**: product-driven engine (quoting) vs recipe-pricing.server.ts + ProductRecipe children (production/cost review) vs PricingRule/ConfiguratorPricingRule (live storefront). Deliberate, but shared inputs (waste, labor, ink) are entered separately in each.
7. **Quote save paths ×2 in one route**: 14B manual/auto pipeline (generateTiers) and 14C.2 product tiers both live in app.erp.cost-calculator.tsx's action with parallel snapshot shapes (engine-labeled; manual is the documented fallback). Extract legacy in 15F.
8. **Job creation ×2**: app.quotes.tsx createProductionJobFromQuote vs webhooks.orders_paid.tsx — different field sets (see §4). Unify in 15D.
9. **Health/audit page overlap**: cost-health vs pricing-health vs cost-verification vs margin-review — four read-only pages computing overlapping cost/margin health over the same models.
10. **Seed scripts vs presets vs docs**: tools/seed-jar-erp-foundation.mjs duplicates presetBlankItems() values (by design, one-time copy — Miron 100ml-tall already drifted: DB $2.78 vs preset $2.86, DB is newer/correct); owner rates repeated in docs (GSO_COST_CALCULATOR_* docs each restate INK_RATES/labor).
11. **Wholesale-lite vs ERP margin concepts**: PricingRule.unitCost vs ProductCost model vs QuoteItem.unitCost — three cost fields for storefront/legacy/quote contexts (documented split, keep, but label in UI).

## 6. Legacy & dead code (G)

- Legacy manual calculator + 14B emergency manual panel inside cost-calculator route: RETAIN AS FALLBACK (owner rule), extract to Advanced route in 15F.
- presetBlankItems(): retire per-item by entering Vendor Cost Book records (OZ bag, soda can, customer-supplied stays).
- Retired redirect stubs (app.wholesale.calculator, app.product-costs, app.erp.product-costs 0KB, app.create-order): SAFE TO DELETE LATER (after link audit); keep for now.
- inkEstimateCostPerSqft profiles + secondsForKnownApplication + cuttingRule/packoutRule legacy heuristics: used only by the legacy calculator — move with it (15F).
- auto-costing.server.ts (14B.1 engine): still reachable via emode=auto; candidate to retire once product mode covers all five families' daily use — CANNOT DETERMINE YET (owner call).
- tools/: clear-jar-finish-pricing-rules.mjs and older jar seeds superseded by current state — ARCHIVE (never run against prod); audit-*.mjs remain useful read-only.
- Docs: _gso_ai_project_context/* (ARCHITECTURE/CURRENT_STATE/KNOWN_ERRORS/NEXT_STEPS/PATCH_LOG) predate the 13A/14 arcs in places — mark historical, fold current truth into GSO_ERP_PROJECT_STATE.md (see §9).
- Tests pin owner-invisible things correctly (source pins) — keep; convert critical ones to behavioral tests over time (§8).

## 7. Security & data integrity (L)

- **High**: RIP upload token rendered in plain text in TWO admin pages (cost-calculator Sync control panel `<code>{uploadToken}</code>` and print-log-settings) together with ready-to-run PowerShell including the token. Any screen-share/screenshot leaks it. Mitigate: mask by default + reveal button (15F); rotate token capability exists.
- **Medium**: legacy/manual pipeline accepts client-posted evar/esetup/eblank as cost basis (labeled manual_override, floor-gated, fallback-only by design). Documented, acceptable, revisit at 15F extraction.
- **Medium**: margin-review page embeds its own labor constants that disagree with owner standards — its outputs can contradict Cost Verification (operator confusion, not exploit).
- **Medium**: no per-user roles — every admin session sees vendor costs and owner overrides ("Owner ·" prefix is labeling, not enforcement). Fine for a single-owner shop; blocker before giving staff/agents admin access.
- **Low**: agent intake API token-authed with scope checks + submission log + lockouts (13A.6D hardening verified); public quote/:id uses an explicit customer-safe field whitelist; proof/:token is unguessable-token gated; webhooks HMAC-verified via authenticate.webhook; owner override phrases enforced server-side; historical snapshots write-once (no update path found); ID spoofing neutralized by class gates + server re-fetch (14C.2).
- No secrets committed: .env git-ignored (verified by git status over the arc); tools/*config.json hold tokens locally and are the documented pattern — confirm .gitignore covers gso-print-intake-agent-config.json (it is untracked-invisible in status, so yes).

## 8. Test coverage (M)

- Strong (behavioral): product-driven costing (66), calculator emergency/tiers (27), cost-calculator lib, recipe pricing, quote margin, customer tiers, RIP parsing (RasterLink + VersaWorks), print-log matching/writeback, intake routing, duration, calibration, variance, agent security, shopify cost audit, rip-import review, jobinfo fallback — 20 files / 467 tests.
- Source-pin-only areas: calculator UI flow (form/optgroups/tier table pins), navigation, snapshot wiring — pins prove presence, not behavior.
- NO tests: quotes/CRM route logic (status transitions, low-margin approval, draft orders), production route, orders_paid webhook, proof/quote public routes, configurator routes (PROTECTED — intentional), purchase-requests, materials/machines/vendors CRUD, Add Product wizard, agent review queue.
- Seed scripts: no automated validation (run-once with console output; audit-*.mjs exist as manual checks).
- Recommended acceptance suite (15G): quote→approve→job→actuals happy path per family; webhook job parity vs button job; low-margin gate; portal field whitelist; DTP tier resolution.

## 9. Documentation audit (N)

- Authoritative today: GSO_ERP_PROJECT_STATE.md (milestone log), GSO_COST_CALCULATOR_INPUT_RULES.md (calculator behavior), GSO_COST_CALCULATOR_PRICING_AUDIT.md (+addenda), GSO_COST_CALCULATOR_EMERGENCY_FIX.md, AGENTS.md, CLAUDE.md, this 15A set.
- Stale/historical: _gso_ai_project_context/* (predates 13A/14 in parts), GSO_ERP_HANDOFF.md, GSO_RIP_ACTUAL_COST_AUTOMATION_PLAN.md (superseded by shipped 13A.5-8), PRODUCT_FAMILY_REUSE_DECISION.md (age unknown — review), STOCK_BAG_CONFIGURATOR_LAUNCH_CHECKLIST.md (launched).
- Conflicts: AGENTS.md still says jar_5oz never customer-facing — owner overruled FOR THE CALCULATOR in 14C.2A (storefront exclusion stands); docs restating rates duplicate constants (see §5.10). Update AGENTS.md wording in the next code patch.
- Missing: owner-data sheet (single table of every owner-verified rate + date), runbooks for the two PowerShell agents (partially in-page), master doc index.
- Proposed structure: keep GSO_ERP_PROJECT_STATE.md as the log; add docs/INDEX.md; archive folder for superseded docs; one OWNER_STANDARDS.md generated from the future standards table (15B).

## 10. Page necessity (K) — summary lists

- KEEP (daily): cost-calculator, quotes, production (+calendar), agent-review-queue, dashboard, reports-dashboard, materials, machines, vendors, vendor-cost-book, product-setup, print intake/logs/RIP pages, purchase-requests.
- MERGE: products/new → product-setup tab; pricing-health → cost-health (or both → cost-verification); production-calendar → production tab; agent rule viewers → one Agent Docs page.
- HIDE UNDER ADVANCED/ADMIN: setup-wizard, walkthrough, admin-settings, agent-security, pricing-rules, all configurator pages, shopify-links, margin-review, print-log-settings, create-* utilities, wholesale admin trio.
- REMOVE LATER (after migration/link audit): retired stubs (4), app.erp.product-costs.tsx (0KB), legacy calculator section (extract first), superseded presets.
- INVESTIGATE: margin-review overlap + private constants; auto-costing 14B.1 retirement; wholesale admin trio ownership (still a live storefront feature with no nav entry).

## 11. Validation (R)

Full tests 467/467 (20 files) · tsc 308 = baseline · build clean (client+server)
· git diff --check clean · no data writes, no seeds, no migrations, no app-code
changes. The only repo changes from 15A are the five docs/ files.
