# GSO ERP / Shopify Configurator — Current State

Updated: 2026-08-12 (Phase 16D, Miron jar revenue activation)

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
C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp

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
