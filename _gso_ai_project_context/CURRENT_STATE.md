# GSO ERP / Shopify Configurator — Current State

Updated: 2026-10-03 (CORE release LIVE as dba23c6; operations agent platform on local branch, NOT deployed)

## OCTOBER 2026 — OPERATIONS AGENT PLATFORM (LOCAL BRANCH, NOT DEPLOYED)
Branch `agents-operations-finishline-2026-10-03` on top of the LIVE CORE
release (`dba23c6` = origin/main on Render). Adds `app/lib/ops/` (21-role
registry, autonomy ceilings, ActionIntent engine, deterministic agents,
simulator) and `app/lib/slack/` (sandbox-only Slack adapter), routes
`api/slack/interactions` (inert until configured) and `app/erp/ops-hub`.
No LLM, no durable store, no worker, no schema change, no production write
path touched. QuickBooks DEFERRED — NOT CONNECTED. Docs: GSO_AGENT_SYSTEM_
CONTRACT, GSO_OPERATIONS_AGENT_ARCHITECTURE, GSO_AGENT_OPERATIONS_RUNBOOK,
GSO_AGENT_DEPLOYMENT_PLAN, GSO_SLACK_INTEGRATION_CONTRACT, GSO_SLACK_SETUP,
GSO_ART_APPROVAL_CONTRACT, GSO_PRODUCTION_AUTOMATION_CONTRACT,
GSO_FINANCIAL_ACTION_POLICY. Owner review pending (PATCH_LOG OPS-1).

## OCTOBER 2026 — COST CALCULATOR CORE RELEASE (LIVE on Render as dba23c6 since 2026-10-03)
Repo moved to `C:\Users\Desig\GSO-ERP-WORKSPACE\wholesale-lite-mvp`
(`C:\Users\golde\...` paths elsewhere in this file are historical).
Release branch: `costing-october-core-release-2026-10-03`. GitHub
`origin/main` is STILL `fd55e51`; nothing after it is on GitHub or Render.
Full record: `docs/GSO_OCTOBER_CORE_RELEASE_RUNBOOK.md`,
`docs/GSO_TRUE_COST_CONTRACT.md` §11, `PATCH_LOG.md` (2D-4C2 → 2D-4E).

PRODUCTION STATE (read-only verified 2026-10-03, dry runs only):
- ALL FOUR approved canonical machine calibrations ALREADY EXIST in
  production (Mimaki cmyk_heavy 32-pass-bidi-op1 1.89 mL/sqft 1.444 min/sqft;
  Roland cmyk hq-default 1.4133 / 0.91; Roland white white-hd-1x 6.0 / 1.71;
  Roland gloss gloss-1x 4.18 / 0.91). Values match the approved definitions
  exactly. DO NOT run `seed-machine-profile-calibrations.mjs --apply`; the
  calibration seed is NOT a deployment blocker and is not needed.
- Chiron 100ml tall VendorProduct row (`chiron-100ml-tall`) is MISSING. The
  seed `tools/seed-chiron-100ml-tall-2d4d2.mjs` is production-only, dry-run
  by default, would CREATE one row at $1.80, and awaits owner approval AFTER
  the application deploy and smoke test. Not applied.

CORE RELEASE CONTENT: the three historical local commits (d2ec32f, 252d99b,
22d91f2) + `cf04eaf` (2D-4C2→2D-4D3 calculator release candidate) +
`1b13758` (2D-4E P0 canonical authority lockdown) + the October docs/fix
commits on the CORE branch. Canonical-authority families: stickers-labels,
sticker-bags, stock-bags, banners, standard-jars, premium-jars. Canonical
true manufacturing cost is the ONLY cost that reaches a Quote for them.
Blocked canonical result = unitCost null, never $0. DTP / Boxes remain
outsourced (LEGACY_OUTSOURCED) and incomplete.

INTENTIONALLY HELD — NOT IN CORE: commit `14a125d` (storefront canonical
manufacturing-cost basis). It changes customer-facing behaviour (5X/7X
specialty prices move; holographic and die-cut become quote-only online)
and needs owner decisions. See `docs/GSO_STOREFRONT_PRICING_DECISION_PACKET.md`
on branch `costing-october-full-review-2026-10-03`. In CORE the storefront
and admin previews still price on the legacy engine, unchanged from today.

Owner-verified locks in code: label cutline -0.0625in offset; 4x5 blank
$0.09 before inbound freight ($0.11 retired; freight not yet modelled);
active jar scope (10 combinations; 100ml→100ml_wide, 100ml tall→100ml_tall);
per-size jar application seconds; art $8.333333 PER_DESIGN / print $1.00
PER_JOB; jar overage 1%; Chiron 100ml tall $1.80; sticker-bag + stock-bag
MOQ 50; routing CMYK→Mimaki, white/gloss→Roland, explicit Mimaki+specialty
BLOCK. Unsupported banner finishing stays fail-closed.

Deployment requirement for CORE (from the origin/main diff): application
code, tests, docs and tools only. No Prisma schema or migration changes, no
extension/function/theme source, no shopify.app.toml, no dependency changes.
Render auto-deploys a push to `main`; `shopify app deploy` and "Save
settings & sync functions" are NOT required for CORE.

## STICKER STATUS AFTER 16F — STAGED (deploy + media gated)
custom-stickers (sticker_regular) + die-cut-stickers (sticker_die_cut)
are created, ERP-linked, live-verified, and carry the 16F.1 holographic
sell floor (HOLO = MAX(canonical, matte x1.2) — live-verified all tiers).
Theme deploy CONFIRMED live (width inputs render). ONLY BLOCKER: product
photos, then rebuild-stickers-16f.mjs --activate. (dimension-driven
pricing through the ERP cost engine + owner margin/floor policy; live 1X
@250 = $0.44 vs the owner's historical $0.45 gloss quote). Both DRAFT:
(1) `shopify app deploy` ships the width/height inputs (required), then
(2) add product imagery, (3) `node tools/rebuild-stickers-16f.mjs
--activate`. Floor-policy note for owner: at floor-controlled tiers
holographic prices equal matte (the AREA floor sets both).

## DTP STATUS AFTER 16E — FAMILY LIVE (1/4 products)
4x5-custom-pouch (dtp_4x5x2) is ACTIVE, priced by the 15C.2 owner
selling-price ladders through canonical-dtp-pricing.server.ts (MOQ 1,000;
>10,000 quote; CR zipper/soft-touch included — no add-ons exist). 5x4x2 /
6x5x2 / 8x5x2 products are created, verified, and MEDIA-BLOCKED at DRAFT
(add imagery -> `node tools/rebuild-dtp-16e.mjs --activate`). Paid all-DTP
orders take the dtp-bags outsourced purchase checklist. GSO prices sit
above Beast Coast at most tiers (flagged for owner review, unchanged).

## JAR STATUS AFTER 16D.1 — FAMILY LIVE
Five applied-label jar products are ACTIVE and selling through the
canonical jar engine (owner tables; holo +20% of base; specialty 0X-8X;
MOQ 50; 5,000+/9X+ quote): 50ml, 100ml tall, 100ml wide, 150ml, 3oz
(Clear/Black/White). Two are technically ready but MEDIA-BLOCKED at
DRAFT: 250ml-miron-jars and 4oz-jar (0 images — add imagery, then
`node tools/rebuild-jars-16d.mjs --activate`). 50mml handle typo fixed
with 301 redirect. GSO sells NO blank jars — application included.

## STOREFRONT STATUS AFTER 16C
1,886 canonical Stock Bags ACTIVE with 1,886 ERP rows; the 31 legacy bags
were rebuilt to canonical single-variant architecture and reactivated;
pricing pins green end-to-end. ONE OWNER COMMAND OUTSTANDING: 1,854
healthy bags still sit on the default theme template (native $1.00
purchase path, no configurator) — run
`node tools/fleet-template-16c.mjs --execute` to flip them to the proven
configurator-pilot template (dry-run verified, rollback artifact).
Jars/DTP/stickers/boxes/banners: see the 16C launch matrix in the phase
report; blank-jar sell pricing is the single jar blocker.

Project root:
C:\Users\Desig\GSO-ERP-WORKSPACE\wholesale-lite-mvp (since 2026-10; previously C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp)

Branch: main (Render auto-deploys pushes; `shopify app deploy` separately
ships theme-extension changes). HEAD before 15Z.1: 710d663.

## ERP STATUS: FUNCTIONALLY COMPLETE
Final audit verdict (15Z, read-only): **GO WITH MINOR DEBT** (~97%).
Live-data integrity: PASS across every check (tickets, linkage, provenance,
orphans, cross-shop — zero defects). Gates: 1036/1036 tests, build green,
prisma schema up to date, TypeScript at the 304 baseline.

## Completed programs
- **Storefront pricing arc (15G.x):** one canonical pricing authority
  (owner standards -> ink rates -> product-driven/commercial engines ->
  canonical bag pricing -> storefront/checkout). Ratified anchors:
  100 double Matte 0X = $1.80/$180; 500 double 3X = $1.92/$960; MOQ 50;
  finish ladder 0X-8X; 9X+ = custom quote. Checkout uses draft orders via
  the app proxy (never 5xx through the proxy; `_GSO Canonical` snapshot on
  every line). 1,886 product descriptions cleaned 64->50. Native purchase
  buttons suppressed on configurator bags. Print-intake token rotated.
- **Production identity program (15H.0-15H.5):** DB-unique GSO tickets
  (GSO-YYYYMMDD-NNNN / -NN items) from ONE allocator; strict exact-only
  RIP identity matching (item-ticket first) with trusted-actuals policy;
  server-authoritative Print Intake review/retry (agent ledger = cache;
  agent 1.7); Shopify order convergence (orderGid + canonical snapshot
  consumption); manual/walk-in jobs (requestId idempotency); shell ->
  commercial merge/link with tombstones; runs/reprints/QC (A/R/P grammar
  __[R#-][P#-]A#, historical __A1 default; QC events; reopen keeps
  finalized snapshots immutable; run-aware actuals grouping).

## Machine routing authority (owner-approved, do not change)
Mimaki UCJV300-130 = CMYK only. Roland LG-640 = white/gloss/specialty.
CMYK defaults to Mimaki unless explicit ROLAND tag/ERP assignment.
Contradictions go to review — never guessed.

## Known safe debt (classified in the 15Z audit)
Unlink/relink workflow; automatic reprint-cost integration; theme JS >10KB
warning; inert cart-transform extension; ConfiguratorPricingRule + legacy
minQuantity=64 compatibility rows; TS baseline (304, Polaris typing);
external Mimaki converter dependency; theme quick-add vector (Phase 16).

## Hazards (permanent)
- Local `.env` DATABASE_URL points at PRODUCTION Postgres — every local
  prisma/tools command is a production command.
- Repo files are CRLF — LF-anchored scripts fail.
- Migrations ship via prisma/migrations-pending staging when Render must
  not auto-apply (see that folder's README).

## NEXT PROGRAM: PHASE 16 — SHOPIFY STORE REBUILD & OPTIMIZATION
16A store/catalog forensic audit -> 16B navigation/architecture ->
16C bulk catalog cleanup -> 16D templates -> 16E SEO/redirects ->
16F mobile/desktop UX -> 16G ERP<->Shopify integrity -> 16H checkout
journey testing -> 16I launch QA.
