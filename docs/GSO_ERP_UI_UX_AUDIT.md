# GSO ERP — UI / UX Audit and Cleanup (2026-10-05 overnight)

Scope: the whole embedded admin (`app/routes/app.*`). Classification is from the route inventory (`app/routes.ts`, nav in `app/routes/app.tsx`) and inbound-link analysis; changes made tonight are marked. Nothing was deleted from the route table; de-navved pages stay reachable from the Dashboard's "Advanced & owner tools" section.

## 1. Navigation — before / after

Before: one flat list of 37 links ("·"-prefix pseudo-groups), three overlapping "is the system ready" entries at the top (Setup Wizard, ERP Walkthrough, Dashboard link farm), purchasing pages missing, six audit pages and nine owner/configurator pages at top level.

After (24 links, grouped by workflow): Dashboard · Sales (Quotes / CRM, Cost Calculator) · Production (Production Board, Print Intake, RIP Imports & Review, Print Logs) · Purchasing (Purchase Requests, Reorder Report) · Operations (Agent Review Queue, Operations Hub) · Reporting (Reports Dashboard) · Pricing (Pricing Settings, Pricing Intelligence, Margin Review) · Audit (Cost Verification) · Setup (Product Setup, Materials, Machines, Vendors, Vendor Cost Book) · Admin (Advanced Tools -> Dashboard#advanced) · Help (Setup Wizard, ERP Walkthrough). Pinned by `tests/erp-navigation-2026-10-05.test.ts`.

## 2. Route inventory and classification

| Route | Class | Tonight |
|---|---|---|
| /app (Dashboard) | DAILY STAFF | rebuilt: "Needs attention today" read-only counts, 5-step workflow, collapsed advanced/owner tools; dead counts removed |
| /app/quotes | DAILY STAFF | copy/grouping pass (see staff flow audit) |
| /app/erp/cost-calculator | DAILY STAFF | cost -> price -> collapsed legacy order; jar pricing basis; owner-ladder note; quantity helper fix |
| /app/erp/production (+ /:id/print, /:id/proof) | DAILY STAFF | at-a-glance row from existing fields; technical clutter collapsed |
| /app/erp/print-intake, rip-imports, rip-import-review, print-logs | DAILY STAFF (one flow) | shared "Print flow" strip, plain headings, empty states; review + logs moved under RIP Imports in nav |
| /app/erp/purchase-requests, reorder-report, purchase-export | DAILY STAFF | first two added to nav (were unlinked); export reachable from requests |
| /app/erp/agent-review-queue (+ /new) | DAILY STAFF / ADVANCED | decision-inbox copy; /new moved to advanced tools |
| /app/erp/ops-hub | ADVANCED-DIAGNOSTIC (kept in Operations) | concise primary view; release-test tools collapsed |
| /app/erp/reports-dashboard | OWNER-MGMT | headings/empty states; unrecorded never shown as zero |
| /app/erp/pricing-settings | OWNER-MGMT | dead controls marked NOT USED; every section classified |
| /app/erp/pricing-intelligence | ADVANCED-DIAGNOSTIC | kept (advisory-only, threshold-gated); no cost/recommendation layer exists yet — see owner checklist |
| /app/erp/margin-review | OWNER-MGMT | moved under Pricing |
| /app/erp/cost-verification | OWNER / AUDIT | production standards + pricing authorities read-only |
| /app/erp/product-setup | SETUP | cost-engine spec card: authority, pricing, MOQ, open decisions |
| /app/erp/products/new | SETUP (DUPLICATE add path) | de-navved; reachable from Product Setup button and advanced tools |
| /app/erp/materials, machines, vendors, vendor-cost-book | SETUP | labels/units/badges/empty states pass |
| /app/erp/cost-health, shopify-cost-audit, actual-costs, calibration, pricing-health, configurator-audit | ADVANCED-DIAGNOSTIC (overlapping audit cluster) | de-navved to advanced tools; shared UI tokens applied to the inline-styled ones |
| /app/erp/admin-settings, agent-security, pricing-rules | OWNER-MGMT | de-navved to advanced tools |
| /app/erp/configurator, configurator-sync, configurator-mapping (LEGACY fallback), configurator-jar-mapping (DUPLICATE), shopify-links | OWNER-MGMT configurator cluster | de-navved to advanced tools |
| /app/erp/setup-wizard, walkthrough | HELP | moved to Help; walkthrough wording matches the new sidebar |
| /app/erp/production-calendar, print-log-settings | DAILY extras / SETUP | advanced tools (linked from their parents) |
| /app/wholesale, /app/wholesale/rules, /app/wholesale/customers | DEAD-UNLINKED / LEGACY (pre-ERP MVP) | untouched; candidates for owner-approved retirement |
| /app/create-wholesale-discount, /app/create-configurator-cart-transform | DEAD-UNLINKED dev one-shots | untouched |
| /app/erp/agent-*-rules, agent-quote-prep-* (5 JSON endpoints) | mis-filed under app.erp.* | untouched (rename to api.* is a later chore) |
| redirect shims (wholesale/calculator, product-costs, create-order) | LEGACY redirect | keep |

Seven overlapping "is the system ready" surfaces exist (Setup Wizard, Walkthrough, Pricing Health, Cost Health, Cost Verification, Configurator Audit, Dashboard). Tonight: Dashboard became the daily start page and Cost Verification the owner audit page; the others are reachable but not promoted. Consolidation is a later owner-approved cleanup.

## 3. Design system

No shared UI module existed; three styling dialects coexist (Polaris in ~25 routes, inline `<style>` + classes in ~10, per-file inline objects in 4). Tonight: `app/lib/erp-ui-tokens.ts` (card / help / table / input / button tokens and ONE status vocabulary: green only for READY TO QUOTE / VERIFIED / COMPLETED, amber for PROVISIONAL / OWNER CONFIRMATION PENDING / NEEDS DECISION, red for BLOCKED / FAILED / EXECUTION BLOCKED, grey INFO) adopted by the inline-styled audit routes; the calculator keeps its own radius but uses the same colours. Polaris routes were left on Polaris.

## 4. Status language and colour

Standardized words used in the touched pages: READY TO QUOTE, BLOCKED, PROVISIONAL, VERIFIED, OWNER CONFIRMATION PENDING, COMPLETED, NEEDS DECISION, EXECUTION BLOCKED. Rule enforced in the token module and by tests: unconfirmed data is never green; harmless diagnostics are never red.

## 5. Forms / inputs

- Calculator jars: quantity-derived helper copy (no stale 128), label set replaces typed dimensions, override collapsed, margin override explained. Numeric guards: zero/negative/text quantities block (adversarial suite).
- Pricing Settings: inactive controls read-only; parsers unchanged.
- Setup pages: unit labels standardized ($ per sqft / per roll / per item, in), verified vs provisional badges, destructive buttons labelled.

## 6. Responsive / accessibility (spot fixes only)

Tables that can be wide sit in `overflow-x: auto` containers (calculator tier tables, cost verification); radio tier pickers carry aria-labels; collapsible sections use native `<details>` so keyboard toggling works. No broad rewrite.

## 7. Dead / duplicate code

See section 8 (TODO / legacy audit) and `docs/GSO_PRICING_POLICY_SANITY_AUDIT.md`. Runtime deletions were avoided tonight: nothing was removed whose absence could change a historical reader, a replay or a test. Candidates for owner-approved retirement: the three `/app/wholesale*` pages, the two dev one-shot routes, `configurator-mapping` (superseded by Configurator Sync per its own copy), `agent-review-queue/new` ("future workflows").

## 8. TODO / FIXME / legacy marker audit (app/lib + app/routes)

- `TODO`, `FIXME`, `coming soon`, `test only`: **zero** hits anywhere in `app/`.
- `not implemented` (4): nesting grouping policy other than default (fail-closed blocker, intentional); PDF geometry parsing in the agent registry (future scope, degrades to NEEDS_DESIGNER); Anthropic reasoning provider (owner decision; fail-closed disabled provider). None is unfinished work.
- `provisional` (224 hits) is mostly the engine's first-class status vocabulary (`TrueCostStatus`), not debt. The genuinely provisional NUMBERS are concentrated and already listed in `GSO_ERP_PRICING_OWNER_DECISIONS.md`: sticker area market floor, family minimum gross profits, provisional universal curve, bag application $0.078125 (superseded), machine recovery $8/hr.
- `legacy` (295 hits): intentional legacy paths that are still load-bearing — `product-driven-costing.server.ts` (prices the live storefront bags/stickers), `calculator-emergency.server.ts` (holds FAMILY_MARGIN_RULES read by the current policy), `owner-standards.ts` LEGACY_CONFLICTING_RATES register, `canonical-quote-authority.server.ts` (the gate that keeps legacy cost out of saved quotes), family alias lists, multi-line label authority, configurator pilot data island (`configurator-pricing.ts`). None can be deleted tonight without changing storefront prices or historical readers.
- Hardcoded runtime values classified: calculator blank-item PRESETS (owner must enter vendor records to retire each); `LABEL_MEDIA_PER_SQFT` re-typed in the canonical engine (fixed tonight: now reads `APPROVED_ROLL_COSTS`); legacy `bag4x5PerSide 20/180` and `glossWhiteSetupPerJob 25/3` in the legacy calculator (registered/owner decision); in-memory rate limiter on the personalization upload endpoint ("TEMPORARY — NOT PRODUCTION GRADE", needs one Prisma model: documented for a later migration); `configurator-audit` asserting MOQ 64 against canonical rows of 50 (fixed tonight).
- Dead-module scan: no `app/lib` module is unimported. Test-only: `ink-calibration.server.ts` (genuine dead candidate), `ops/followup.ts` and `ops/reorder-marketing.ts` (registry-declared, not wired), `slack/socket-mode.server.ts` (pre-go-live), `weeding-benchmark.ts` (analysis-only by design). Dead exports: `bagApplicationCost()`, `JAR_APPLICATION_LABOR_PER_JAR` (test-referenced). Nothing deleted tonight.

## 9. Duplicate sources of truth (surfaced, not consolidated)

| Concept | Verdict | Notes |
|---|---|---|
| Margins | CONFLICT (ordered) | bags-4x5 positional curve vs live bands differ by design; jar curves cite a missing study and are now bypassed by the owner ladder |
| Jar sell prices | CONFLICT | `JAR_BASE_PRICES` (storefront + now ERP) vs RecipeTier / ConfiguratorPricingRule seeds (old sell sheet, 128-based tiers); read paths isolated |
| Cost standards | ONE AUTHORITY for setup/weeding/packout (`OWNER_STANDARDS`); $20/hr labor rate re-typed in 3 modules; legacy bag application + gloss setup literals registered |
| Materials | STRUCTURAL CONFLICT | storefront bag/sticker engine reads DB Material; ERP canonical engine reads the approved constant (values agree today) |
| Jar geometry | INTENTIONAL LEGACY READER | reference rows disclosed, never priced |
| Bag geometry | ONE AUTHORITY | |
| Machine routing | DUPLICATE-AGREES | two implementations of one rule (cost path vs intake path), no mechanical link |
| MOQ | CONFLICT on jars (sales rules 128 vs storefront 50 vs jar-mapping default 128); bags five agreeing 50s | configurator-audit 64 fixed tonight |
| Application labor | CONFLICT | jars: per-size seconds (canonical) vs $0.20 flat (legacy/registry); bags: $0.0556/side (ERP canonical) vs $0.078125/label (storefront legacy engine) |
| Weeding | ONE AUTHORITY | two cosmetic restatements; the "weeded decal 10 min + 8 s" legacy rule is a different basis, flagged |
| Pricing engines | CONFLICT | two cost engines (storefront legacy vs ERP canonical) and three price authorities (commercial policy, jar ladder, RecipeTier `priceRecipeAtQuantity` used by Quotes/Margin Review) |
| Product keys | CONFLICT | five family vocabularies; `jar_5oz_clear` orphan key (dead) |

Consolidation of the two cost engines and of RecipeTier pricing is the largest remaining architectural item and needs owner direction (it changes storefront prices).
