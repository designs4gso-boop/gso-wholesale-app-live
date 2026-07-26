# GSO ERP — Data-Ownership Map (Phase 15A, 2026-07-24)

Audit-only. For each data type: current storage, editors, readers, duplication,
conflict risk, and the RECOMMENDED canonical owner. "Constant" = hardcoded in
code. Risk: HIGH = values can disagree and affect money today.

| Data type | Model / storage today | Edited by | Read by | Duplicates | Risk | Recommended canonical owner |
|---|---|---|---|---|---|---|
| Product family (calculator) | none — code constants | code only | calculator | FOUR lists: (1) calculator UI families in product-driven-costing.server.ts (sticker-bags/standard-jars/premium-jars/...); (2) FAMILY_MARGIN_RULES keys in calculator-emergency.server.ts (bags-4x5/chiron-jars/miron-jars/dtp-pouches/...); (3) PRODUCT_FAMILY_SALES_RULES in product-family-sales-rules.ts (jars/sticker-bags/dtp-pouches, MOQs, agent rules); (4) ProductTypeProfile rows seeded by seed-product-families.mjs (stock_bag_4x5, dtp_normal_bags, ...). Plus free-string ProductRecipe.productFamily and Material.productFamilies CSV | HIGH — four naming schemes, mapped by hand (marginFamilyKeyFor, resolveMarginFamily aliases) | New: one family registry (likely ProductTypeProfile extended, or a small ProductFamily table in 15B) that the other three consume |
| Product / blank item | VendorProduct (calculator blanks) + Material kind=blank (legacy blanks) + presetBlankItems() code array in cost-calculator route | Vendor Cost Book (apply), Materials page, seeds | Calculator pickers (classified + deduped 14C.2), legacy calculator | presets duplicate DB records (superseded-by-sku mechanism); Material blank rows mirror VendorProduct rows (name/sku dedupe added 14C.2) | MEDIUM | VendorProduct; retire presets by entering OZ bag/soda can as records |
| Vendor product costs + tiers | VendorProduct.defaultUnitCost + VendorProductTier | Vendor Cost Book applyToVendorProduct; seeds (jar foundation, chiron, 4x6 neutralizer) | Calculator (blankItemUnitCostAtQty), recipes (ProductRecipe.vendorProductId), Shopify cost audit | VendorCostBookItem(+Tier) holds a SECOND copy as staging; presets third copy | HIGH if book and product drift — the "apply" step is manual | VendorProduct(+Tier) is truth; Cost Book stays the intake/review buffer, clearly labeled |
| Materials + $/sqft | Material (+Variant/+Vendor/+CostHistory) | Materials page; Cost Book applyToMaterial | Calculator (resolvePrintMaterialCostPerSqft), recipes, production usage | MATERIAL_ROLLS constant (roll dims) in calculator-emergency.server.ts; legacy material presets removed 12B.1a | LOW-MEDIUM | Material |
| Machines / machine rate | Machine.costPerHour, sqftPerHour | Machines page | production, actual costs, calibration | Calculator hardcodes machineRatePerHour: 8 (owner standard 13A.7B) — Machine.costPerHour NOT read by calculator; margin-review has its own $25/hr constant | HIGH (three rate sources) | Machine table (calculator should resolve machine rate from Machine/ErpAdminSetting in a later patch; documented owner standard until then) |
| Printer capabilities | code constants in calculator (printerHasWhite: true, printerHasGloss: printer==="roland") | code | calculator | MachineInkChannel rows describe real channels | MEDIUM | Machine + MachineInkChannel |
| Ink costs | INK_RATES constants (Mimaki 176/1000, gloss null, Roland 149/750) in calculator-emergency.server.ts | code only | calculator engines (14B/14C), tests | MachineInkChannel.costPerMl in DB (Machines page edits it); legacy board rates removed 13A.7B; ink-profile $/sqft presets in legacy calculator | HIGH — DB and constants can disagree; gloss missing in constants but a channel row may exist | MachineInkChannel; keep constants only as verified fallback until a calibration patch wires the DB values |
| Blank component costs (jars/bags) | VendorProduct(+Tier) | Cost Book, seeds | calculator | presets | MEDIUM | VendorProduct |
| Jar lids / Miron tops | modeled as VendorProduct records classified miron_top; canonical type:* pseudo-options in calculator; combined sets detected from names | Cost Book | calculator (resolveMironTopLine) | none yet (no separate top records exist — data gap) | MEDIUM (upgrades stay Draft Only) | VendorProduct records per top type |
| Product recipes | ProductRecipe + 8 child tables (materials, label zones, ink, machine rules, tiers, add-ons, variant rules, media) | Product Setup (+ Add Product wizard creates drafts) | quotes priceRecipe, configurator, cost health/verification | recipe pricing engine (recipe-pricing.server.ts) separate from calculator engine — parallel cost models by design (recipes = production truth; calculator = quoting) | MEDIUM — two costing engines must not diverge on shared inputs | ProductRecipe for production; product-driven engine for quoting; document the split |
| Waste rules | ProductRecipe.wastePct per recipe; calculator uses recipeWastePct: null → provisional 10% + override | Product Setup | both engines | provisional 10% constant; per-preset wastePct in code presets | MEDIUM — calculator does NOT yet read recipe waste (recipeWastePct always null in route) | ProductRecipe.wastePct; wire into calculator in 15B/15C |
| Application labor rates | OWNER_LABOR constants (jar 0.20, 4x5 bag 20/256, packout 2.00) + WIRED_LABOR (bag14x16 1.00, bag4x5 20/180 — DIFFERENT 4x5 value) + bagApplicationRateFor (14C.2) | code only | calculator, legacy calculator | ProductRecipe.applicationLaborSecondsPerUnit exists per recipe; margin-review $0.15/side constant; legacy seconds heuristics (secondsForKnownApplication) | HIGH — WIRED_LABOR.bag4x5PerSide (0.1111) vs OWNER_LABOR.bagLabelApplicationPer (0.078125) disagree today (different owner standards eras); margin-review uses a third number | One owner-standards table (ErpAdminSetting or dedicated model) in 15B; until then document OWNER_LABOR as calculator truth |
| Packout rules | PACKOUT_RULES name-regex constants (4x5 1000/box etc.) | code | calculator | packoutRule() legacy modes in route; ProductRecipe.packingLaborSecondsPerUnit | MEDIUM | units-per-box field on VendorProduct/recipe later; constants documented until then |
| Freight rules | none persisted — per-quote freight panel inputs (efactual/efallow/efalloc) via computeFreight | quote author | tiers, snapshots | Vendor.shippingNotes free text; DTP $85/PO rule currently only in specs/docs | MEDIUM — vendor-level flat freight has no home (blocks DTP automation) | ErpAdminSetting entry or new Vendor.freightFlatPerOrder (15C decision) |
| Margin curves + floors | FAMILY_MARGIN_RULES + MARGIN_FLOOR_PCT=40 + PROVISIONAL_MARGIN_CURVE constants | code only (owner-approved research) | calculator tiers, saves | RecipeTier.marginPct per recipe (recipe engine); PricingRule sell prices (wholesale engine); ProductTypeProfile.defaultMarginPct | HIGH conceptually (three pricing engines) but deliberate: researched curves are calculator truth | Keep constants as owner-approved source; document that RecipeTier/PricingRule serve the other engines |
| Tier quantities | SUGGESTED_QUANTITIES constant (64,128,...) + requested qty | code + per-quote edits | auto tiers | ProductTypeProfile.tierBreakpoints strings ("128,250,500,1000,2500"); RecipeTier rows | MEDIUM | family registry in 15B |
| Design/setup charges | OWNER_LABOR art 25/3 + print 1.00 per design | code | calculator | WIRED_LABOR.designSetupPerDesign (same 9.3333 combined — consistent); prepress presets legacy; ProductRecipe.setupCost/prepressMinutes | LOW (values agree) | owner-standards table in 15B |
| Quotes / quote items | Quote + QuoteItem | Quotes/CRM, calculator draft save | portal, production, webhooks, margin review | none | LOW | Quote/QuoteItem |
| Quote snapshots | QuoteItem.costSnapshot/priceSnapshot JSON (engine-versioned: 14B.0A / 14B.1a / 14C.1-product / 14C.2-multilabel-auto-tiers) | write-once at save | margin review, history | none — immutable by convention (no update path found) | LOW | keep write-once |
| Customers | Quote.customerName/company/email + customerTier fields; WholesaleApplication for storefront wholesale | Quotes page; wholesale admin | portal, invoicing | no dedicated Customer model — quote-embedded | MEDIUM (CRM growth blocked) | dedicated Customer model later (15D+), not now |
| Production jobs | ProductionJob(+Item/File/Event/Checklist/MaterialUsage) | Production page; quotes createProductionJobFromQuote; orders_paid webhook | production board, print logs, intake, actual costs | two creation paths (quote button + webhook) — by design, but field mapping differs | MEDIUM — verify snapshot carry-through (see quote-to-production audit) | ProductionJob |
| Shopify product mappings | ConfiguratorProduct (stock bags), ProductRecipe.productGid/variantGid, PricingRule.productGid, QuoteItem.shopifyProductGid | configurator mapping pages, product setup, shopify-links | proxy routes, sync, audits | four mapping surfaces for different systems | MEDIUM — deliberate split (configurator vs recipes vs wholesale rules) but confusing | document per-system mapping owner; no merge now |
| RIP results / print logs | PrintLogEntry(+Import) + PrintLogAutoImportSetting | upload APIs + review pages (guarded writeback) | actual costs, calibration, calculator actual-mode, production | none | LOW | PrintLogEntry |
| Actual job costs | derived read-only from PrintLogEntry+ProductionJob (actual-costs, actual-variance libs) | nobody (read-only by design) | dashboards, calibration | quoted-vs-actual comparison exists in variance report | LOW | keep derived |
| Admin settings / rates | ErpAdminSetting (category/key/value) | Admin Settings page | calibration, various | overlaps the owner-standard constants above | see rates rows | grow into the owner-standards home (15B) |

## The three pricing engines (deliberate, documented split)
1. **Product-driven calculator** (product-driven-costing.server.ts + calculator-emergency.server.ts): quoting truth. Owner constants + VendorProduct + Material.
2. **Recipe engine** (recipe-pricing.server.ts + ProductRecipe children): production/cost-review truth; feeds quotes via priceRecipe intent.
3. **Wholesale/PricingRule + Configurator pricing** (configurator-pricing.ts, PricingRule, ConfiguratorPricingRule): live storefront prices for stock bags + wholesale discounts. PROTECTED.
Risk is not the split itself but silent drift of SHARED inputs (ink, labor,
machine, waste). Consolidation target: one owner-standards source consumed by
all three (Phase 15B/15E).

## 15B update (2026-07-24)
- Product family: CANONICAL OWNER IS NOW app/lib/product-family-registry.ts
  (calculator options/gates + Product Setup vocabulary consume it; margin and
  sales tables are indexed by marginRuleKey/salesRuleKey; the products.new
  wizard list and ProductTypeProfile seeds remain consumers to converge in a
  later phase — tests enforce key consistency).
- Application/setup/packing/machine standards: CANONICAL OWNER IS NOW
  app/lib/owner-standards.ts (OWNER_LABOR + calculator machine rate wired to
  it). Legacy conflicting rates are quarantined in LEGACY_CONFLICTING_RATES
  (WIRED_LABOR.bag4x5PerSide $0.1111 legacy-calculator-only; margin-review
  $25/hr + $0.15/side report defaults) with tests proving the product engine
  never reads them.
- Product verification status: derived (no schema change) via
  deriveProductVerification — Vendor Cost Book review status (active) is the
  explicit basis; cost>0 alone remains Verified but labeled "implicit".

## 15C update (2026-07-24)
- DTP vendor costs/tiers/features: OWNER = VendorProduct + VendorProductTier +
  VendorProductAddOn (seeded by tools/seed-spektra-dtp.mjs; maintained in the
  Vendor Cost Book). The calculator reads records only — no DTP costs in code
  (tests pin that the route contains no tier dollar values).
- DTP freight: $85/PO rule lives as SPEKTRA_FREIGHT_PER_PO in
  product-driven-costing.server.ts (single documented location) + Vendor
  Spektra shippingNotes; user-entered actual freight overrides per quote.
  Future structured home (Vendor.freightFlatPerOrder or ErpAdminSetting)
  deferred until multi-line ordering.

## 15C.2 update (2026-07-24)
- DTP CUSTOMER selling prices: OWNER = app/lib/dtp-owner-pricing.server.ts
  (ladders keyed by vendorSku + floors + profit rules + design-fee policy;
  displayed read-only in Product Setup). Explicitly NOT VendorProduct tiers
  (vendor cost only) and never route JSX. Next step for no-code editing:
  migrate the table into ErpAdminSetting or a dedicated model.

## 15D audit update (2026-07-24)
- Production jobs: THREE creators today (quotes page function ~line 180 of
  app.quotes.tsx — no jobTicket/assetInboxKey; production page function ~line
  480 — with tickets; orders_paid webhook configurator branch — with tickets,
  no internal cost). Recommended owner: ONE central
  createProductionJobFromSource service (see
  GSO_ERP_QUOTE_TO_PRODUCTION_PLAN.md); quoteId column doubles as the
  idempotency key by convention (real quote id vs shopify_order_<gid>).
- Quote status lifecycle: draft/sent/approved/deposit_paid/paid/production/
  completed — payment webhooks own deposit_paid/paid transitions with
  note-marker idempotency; conversion to production requires paid.

## 15D.1 update (2026-07-24)
- Production-job creation: CANONICAL OWNER IS NOW
  app/lib/production-job-source.server.ts (all three former creators deleted;
  quotes page, production page, and the orders_paid configurator branch call
  it). Idempotency = quoteId sourceKey + pg_advisory_xact_lock inside the
  creation transaction. Family checklists + Shopify order mapping
  (buildShopifyOrderJobPayload) live in the service.

## 15D.2 update (2026-07-24)
- Commercial/product display names: OWNER =
  app/lib/commercial-name-resolver.server.ts (precedence + placeholder
  stripping + safe tokens). QuoteItem.productName stores the RESOLVED name at
  save; quote display names are derived server-side at read time (historical
  rows unchanged).

## 15E audit update (2026-07-24)
- Actual job cost: ProductionJob actual* columns (saveFinalCosts recomputes
  totals server-side; revenue always from item rows). Print actuals =
  PrintLogEntry -> guarded writeback rows (source print_log) — recorded rows
  are authoritative, the live preview is estimate-grade. Material actuals =
  manual ProductionMaterialUsage rows ((used|pulled|estimated)+waste+reprint
  × costPerUnit, override allowed). Known gaps for 15E.1: finalization has no
  gates/actor/immutability; live-preview print cost can silently enter
  finals; vendor invoice vs freight unstructured (DTP); labor default $25
  conflicts with owner standards. See GSO_ERP_ACTUAL_COST_AUDIT.md / _PLAN.md.

## 15E.1 update (2026-07-24)
- Actual-cost finalization: OWNER = app/lib/actual-cost-finalize.server.ts
  (gate + formulas + variance + snapshot + actor resolution). ProductionJob
  actual* columns remain the queryable copy; the immutable finalize/reopen
  events carry the full snapshots. DTP vendor invoice/freight ownership:
  actualOutsourceCost = normalized vendor cost (invoice +/- charges/credit,
  freight backed out when included); actualShippingCost = actual Spektra
  freight — counted once by construction.

## 15E.2 update (2026-07-24)
- Actual-cost reporting/feedback: OWNER = app/lib/actual-cost-reporting.
  server.ts (finalized-only normalization, weighted-margin aggregation,
  LEAKAGE_THRESHOLDS, evidence-gated suggestions). Owner review decisions
  live in ErpAdminSetting (category "pricing-feedback"); pricing/vendor/
  standards data is never auto-written from reports.

## 15E.3 update (2026-07-24)
- Event presentation: OWNER = app/lib/production-event-presenter.server.ts
  (display-only; event records immutable). Historical commercial names:
  stored values remain the immutable record; display cleanup + the dry-run
  audit live on the shared resolver (assessCommercialName); any future
  backfill requires the documented owner-approved per-record process.

## 15F update (2026-07-24)
- Owner-tunable settings: TARGET OWNER = ErpAdminSetting `ownerConfig.*`
  JSON envelopes (schemaVersion/payload/updatedBy/note/previous) read via
  planned app/lib/owner-config.server.ts with code defaults as fallback of
  record. First movers: ownerConfig.standards.labor (15F.1, replaces direct
  OWNER_STANDARDS reads), ownerConfig.dtp.ladders (15F.2, replaces
  DTP_OWNER_PRICE_LADDERS lookups). Researched margin curves, DTP margin
  thresholds, engine versions, gate phrases: REMAIN CODE-OWNED.
- Access: NO role enforcement exists (verified — authenticate.admin only).
  Interim gate = ownerConfig.access.ownerEmails allowlist +
  Session.accountOwner, server-enforced on money-truth mutations only. See
  GSO_ERP_NAVIGATION_PERMISSION_PLAN.md.

## 15F.0 update (2026-07-25)
- Calculator cost inputs VERIFIED against production: material $/sqft OWNER =
  Material.calculatedUnitCost (Poseidon 0.3155556 = $213/675sqft exact); ink
  $/ml OWNER = INK_RATES constants (MATCH MachineInkChannel.costPerMl rows);
  ink usage 0.6 ml/sqft = route constant (MachineInkChannel.mlPerSqft1Pct
  0.0075 x 80% — calibration pending). Machine time: Machine.costPerHour($5)/
  sqftPerHour(150) rows are the UNUSED source; OWNER_STANDARDS $8 provisional
  is the passed-but-inert rate; margin-review $25 quarantined. Blank costs
  OWNER = VendorProduct(+Tier) records (verified exact); standard jars remain
  code presets (P3-4). Waste: provisional 10% route constant — ProductRecipe.
  wastePct (16 records) exists but is never consulted by the product flow.
  Tier margins: FAMILY_MARGIN_RULES curves OWNER-approved; the row-position
  mapping (curveForTierCount) is the P0-1 defect; quantity-band mapping to be
  owned by marginPctForQuantity after 15F.0a.

## 15F.0 corrected-engine update (2026-07-25)
- Commercial price OWNER = app/lib/commercial-pricing-policy.server.ts
  (candidates + max() + controlling rule, version
  15F.0-production-ready-pricing). Margin bands 64/128/256/640/1000 map the
  researched curves by QUANTITY (owner ratification pending); premium
  stickers ride the researched spot-gloss curve. Family minimum values =
  ErpAdminSetting-bound future (15F.1/2); today null (owner decisions doc).
- Machine recovery: rate OWNER = OWNER_STANDARDS.machineRecoveryPerHour
  ($8/hr provisional); time OWNER = Machine.sqftPerHour verified records
  (150), re-fetched at save; $5 record costPerHour and $25 legacy stay
  non-authoritative. Cutting OWNER = CUT_SQUARE_RECT_STANDARD ($6.53/page,
  owner-documented); contour models pending. Packing OWNER = PACKOUT_RULES +
  documented family defaults (jar 100/box, single-box floor) labeled
  estimated. Outbound shipping: excluded from product price by design.

## 15F.0-FINAL update (2026-07-25)
- Commercial floors OWNER = commercial-pricing-policy.server.ts:
  STICKER_MARKET_FLOOR_BANDS (area-banded, PROVISIONAL anchors) +
  FAMILY_COMMERCIAL_POLICIES minimum profit/order values (PROVISIONAL, owner
  $25/hr basis; unit-price floors deliberately none). Contour cutting OWNER =
  CUT_CONTOUR_MULTIPLIERS (x1.15/1.35/1.60 of the $6.53 page standard,
  PROVISIONAL); banner finishing OWNER = BANNER_FINISHING_STANDARDS; packing
  densities STICKER_UNITS_PER_BOX_DEFAULT 5000 / BANNER_TUBE 5@$4 /
  JAR 100 (all PROVISIONAL, 15F.1 editable). DTP READY semantics: the 40%
  target is informational; floors/$500/$350/overrides unchanged in
  dtp-owner-pricing.server.ts.

## 15F.0G.2 update (2026-07-25, supersedes G.1)
- Printer production speeds OWNER = printer-specific registries in
  product-driven-costing.server.ts: MIMAKI_UCJV_RASTERLINK_PROFILE
  (COMBINED-layer table 51.6/18.2/11.8/8.6 sqft/hr x 1.15 turnaround,
  owner-verified for 600x1200 VD / 32-pass / Bi / Fast Print High) and
  ROLAND_CMYK_SQFT_PER_HOUR 150 + ROLAND_PRINT_MODE_SQFT_PER_HOUR 110/75
  (additive). resolvePrinterSpeeds: Roland from the Machine record
  (fallback 150); Mimaki record speed deliberately unused (stale generic;
  the interim single-rate value was retired) — the engine-owned profile
  governs. Mimaki gloss + 5-layer configurations: PROVIDE items.

## 15F.0G.3 update (2026-07-25)
- Mimaki premium-ink ESTIMATE OWNER = MIMAKI_INK_CALIBRATION (whiteFactor /
  glossFactor 1.00, code-backed until ownerConfig.inkCalibration 15F.1) +
  buildMimakiPremiumInkEstimate snapshot block (version
  15F.0G.3-provisional-ink-estimate) in product-driven-costing.server.ts.
  Gloss line = provisional CMYK-basis estimate (never verified); white ink
  rate remains VERIFIED and untouched. ACTUALS OWNER = 15E finalization +
  PrintLogEntry channels; calibration comparisons/recommendations OWNER =
  app/lib/ink-calibration.server.ts (pure, read-only, min 3 jobs, never
  auto-applied). Quote snapshots immutable.

## 15F.0J update (2026-07-25)
- Print intake OWNER = tools/gso-print-intake-agent.ps1 (scheduled task on
  the RasterLink PC) + app/lib/print-intake-routing.server.ts (route
  decisions) + PrintLogAutoImportSetting.notes (rolling outcomes — to be
  replaced by PrintIntake records, 15F.0J.4). Tickets OWNER =
  createProductionJobFromSource (advisory-locked) — never a second system.
- RIP actuals OWNER = PrintLogImport/PrintLogEntry (rawText/rawRow
  immutable source); extended layout/profile fields ride rawRow JSON until
  the deferred migration. Roland actuals: manual VersaWorks export (no
  watcher yet). JobInfo->CSV converter: EXTERNAL/UNLOCATED (owner question).
- Calibration truth: GSO measured logs ONLY (official specs and RIP
  estimates are separate labeled layers); provisional printer tables remain
  code-owned until n>=3 groups + owner approval (15F.0G.3 machinery).

## 15F.0J.4 update (2026-07-26)
- RIP capture OWNER = app/lib/rip-capture.server.ts (VersaWorks parsing,
  fingerprints, quality flags, eligibility, calibration candidates, Mimaki
  widened contract) + app/lib/versaworks-parse.server.ts (active upload
  branch, widened) + print-logs.server.ts (manual path + Mimaki widening +
  fingerprint dedupe + match methods). Raw source stays immutable in
  PrintLogImport.rawText / PrintLogEntry.rawRow (_gso block is additive,
  written once at import). Roland ingestion = rip-logs/roland/* NAS folders
  + a second config instance of tools/gso-rasterlink-sync.ps1 (example
  config in repo; task install owner-authorized separately).
