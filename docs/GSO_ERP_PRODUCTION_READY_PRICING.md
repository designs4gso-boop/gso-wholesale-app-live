# GSO ERP — Production-Ready Pricing Engine (Phase 15F.0, 2026-07-25)

The Cost Calculator now produces a CUSTOMER-READY price for every supported
job, or an exact BLOCKED list. Engine/snapshot version:
**15F.0-production-ready-pricing** (cost engine lineage 14C.2 retained in
snapshots; DTP keeps 15C.2-dtp-owner-price-ladders exactly). Historical
quotes/snapshots are untouched.

## Architecture (one pass, three layers)
1. **Complete cost** — `computeProductDrivenCost` (product-driven-costing):
   every line carries amount + status (verified / owner_standard / estimated
   / missing / excluded) + source note + formula where derived. A required
   component can never be silently $0: it is a real amount, a labeled
   estimate, an excluded-with-reason line, or a MISSING blocker.
2. **Commercial price** — `computeCommercialPrice`
   (commercial-pricing-policy): candidates costBasedPrice /
   minimumGrossProfitPrice / minimumOrderTotalPrice / minimumUnitPriceTotal /
   ownerMarketLadderPrice / premiumFinishFloorPrice; **final = max(candidates)**
   with the CONTROLLING RULE named; achieved margin/profit reported.
   marginFloorPrice is reported as the informational floor line.
3. **Readiness gate + presentation** — READY TO QUOTE (green, recommended
   price, "Price based on:", Includes / Does-not-include) or BLOCKED with the
   exact missing-setup list. WARNING is not a pricing state for non-DTP
   families. DTP keeps its owner-approved 15C.2 statuses unchanged.

## Margins (fixes forensic P0-1)
`marginPctForQuantity(rule, quantity)`: researched 5-point curves mapped by
QUANTITY BANDS with edges 64/128/256/640/1000 (the margin study's tier
structure). Row count/position can never shift a margin; the requested
quantity row cannot move standard rows. Loader and save action call the same
resolver. Advanced per-tier owner edits still override, gated by the
unchanged family/global floors + "OWNER MARGIN OVERRIDE".

## Machine recovery (fixes P1-1)
time = waste-adjusted sqft x (60 / printer sqft/hr) x passes; cost = time x
**$8/hr owner recovery standard** (owner-standards registry). Speed comes
from the verified Machine records (both printers 150 sqft/hr), re-fetched at
save; documented 150 sqft/hr standard is the fallback; no speed at all =
BLOCKED. The stale $5/hr Machine.costPerHour is NOT the recovery rate; the
$25/hr legacy value stays quarantined. Advanced minutes/sqft override
remains (manual_override label). Setup/loading is covered by the owner print
setup standard ($1.00/design) — documented, not double-charged.

## Cutting (fixes P1-2)
Cut types: none (excluded line) / **square-rect** (owner-documented model:
15.7 min = $6.53 per 54x54in production page, pages = ceil(base sqft /
20.25), scales with quantity) / kiss-contour / die-complex (NO verified
model -> BLOCKED: "Cutting standard required for this cut type"). Stickers
choose the type in the form (legacy kiss/weeded values map to square-rect);
bag/jar labels and banner trim apply the square-rect model automatically.
Weeding stays its own line (weeded cuts).

## Packing (fixes P1-4)
Verified PACKOUT_RULES first (4x5 bags 1000/box, 3oz 150, 4oz 100 — $2/box
owner standard, boxes ceil'd). New deterministic defaults, labeled
estimated: jar families 100/box (documented Safe Care 4oz density — owner
confirmation listed); all other supported families a single-box job floor
($2). Advanced units-per-box override unchanged. Packing is never silently
$0 and never charged twice (multi-line jobs charge it once at job level).

## Shipping ownership (fixes P1-3 confusion)
Outbound CUSTOMER delivery is excluded from the product price by design —
every non-DTP breakdown carries the excluded line and the customer summary
prints "Does not include: Customer delivery/shipping". Excluded is NEVER
"missing". Delivered pricing = enter freight in the panel (rides the margin
basis as before). Inbound vendor freight stays a production cost — DTP keeps
exactly one $85 Spektra charge per PO.

## Family policies
- **Stickers & Labels**: complete cost x researched curve (65/58/52/46/40);
  any white/gloss layer prices on the researched SPOT-GLOSS premium curve
  (70/62/56/50/45, min 45) via the premiumFinishFloorPrice candidate —
  premium can never price as basic. Multi-design: quantity = TOTAL labels,
  designs share it (per-design setup only), split displayed with remainder.
  Multi-line: different sizes/finishes = separate lines, each on its own
  band/premium curve, packing once, combined price = sum of line prices.
- **Sticker Bags**: verified blank costs (4x5 $0.09 / 14x16 $1.00; other
  sizes NO PRICE -> BLOCKED), size-specific application standards, label
  cutting + machine now included; researched bags-4x5 curve.
- **Jars**: exact Chiron flat / Miron tier + top rules unchanged; label
  production now carries machine + cutting; jar application $0.20/label;
  jar packing default 100/box; researched chiron/miron curves = the jar
  study floors.
- **Banners**: finished-sqft pricing with machine + trim cutting + packing;
  hem/grommet selection still BLOCKS until the owner finishing standard
  exists; researched banners curve.
- **Custom Item**: never auto-Ready without complete owner-entered cost
  (unchanged); prices through the same policy once complete.
- **DTP Bags**: PRESERVED EXACTLY — owner ladders, 30/35/38 floors,
  $500/$350 profit rules, statuses, override phrase, $85 freight.

## Readiness gate (L)
READY TO QUOTE requires: no missing cost lines (machine/cutting/packing/
records/dimensions all present-or-labeled), commercial policy resolved,
price clears floors (structural: final = max includes cost-based at the
band), nonnegative profit (structural), loader/save/snapshot identical
(same functions, parity-pinned). BLOCKED lists exactly what to configure.
No owner review for ordinary supported jobs; owner phrases remain only for
deliberate below-floor overrides and DTP's existing safeguards.

## Parity + snapshot (P)
Save re-fetches records + machine speeds, rebuilds lines, recomputes tiers/
multi-line and resolves the selection by quantity; posted totals ignored.
Snapshot adds `commercialPricing` (candidates, controlling rule, final
figures, shipping-ownership note, version) and `multiLine`/`designSplit`
blocks. QuoteItem stores the selected final figures; the Shopify order and
production estimated revenue flow from the same stored quote values as
before (no payment/production behavior changed).

## Tests
597 passing (579 -> 597): updated forensic pins (corrected engine),
tests/production-ready-pricing.test.ts (policy, premium, multi-design,
multi-line, Chiron fixtures, parity pins), updated route pins. Fixture
book: docs/GSO_ERP_CALCULATOR_QUOTE_FIXTURES.md. Remaining owner decisions:
docs/GSO_ERP_PRICING_OWNER_DECISIONS.md.

## 15F.0-FINAL — employee-ready commercial layer (2026-07-25)
- **Sticker AREA market floor** (fills the market-ladder candidate for
  stickers-labels): $/finished-sqft banded by TOTAL sqft — 8.00 (<10 sqft) /
  6.40 (<25) / 4.80 (<50) / 4.00 (<62.5) / 3.20 (>=62.5) + full setup
  recovery. Anchors = the two documented forensic market references at their
  LOW end; intermediate bands linear interpolation. PROVISIONAL, editable
  15F.1. Area-banding keeps tiny stickers AND large labels safe — no
  universal unit ladder. Material/finish premiums ride the cost-based and
  spot-gloss candidates.
- **Minimum gross profit** (PROVISIONAL, owner $25/hr labor basis): stickers
  $25 / sticker bags $75 / standard jars $75 / premium jars $100 / banners
  $25 / custom $25 / DTP keeps $500-$350. **Minimum order totals**: stickers
  $25 / banners $40 / custom $25 (others none). **Minimum unit price: NONE
  anywhere** — deliberately (area floors are size-safe; a unit floor is not).
- **Contour cutting**: kiss-simple x1.15 / kiss-moderate x1.35 /
  kiss-complex x1.60 of the owner square-rect page standard ($6.53/54x54
  page) — plain-language picker, quotes automatically. Die/irregular stays
  BLOCKED ("Cutting standard required for this cut type"). Legacy values
  map: kiss/weeded to square-rect; 15F.0 kiss-contour to kiss-simple.
- **DTP READY**: a normal owner-ladder quote meeting the hard floor AND the
  $500 target is READY with an informational note — the 40% target never
  triggers routine owner review. Floors, $500/$350, overrides, ladders
  unchanged.
- **Banner finishing** (PROVISIONAL standards): $5 setup/job + hems
  $0.60/perimeter-ft + grommets $0.30 each @24in spacing; trimming = the
  square-rect cut line; banners pack in $4 tubes (5/tube), never sticker
  boxes. Specialty finishing (pole pockets, wind slits) unsupported.
- **Multi-line jobs**: per-line area floors + premium curves; job-level
  packing (ceil(total/5,000) x $2) and job-level minimum-profit/order applied
  ONCE on the combined total (per-line calls suppress them).
- Fixture book + market calibration: GSO_ERP_CALCULATOR_QUOTE_FIXTURES.md.

## Owner-corrected Roland print profiles (2026-07-25)
Machine time now uses PER-MODE RIP speeds (head speeds CMYK 1,354 / Gloss
1,016 / White HD 677 mm/sec): cmykHours = sqft/150 (verified baseline) +
glossHours = sqft/110 x glossLayers + whiteHours = sqft/75 x whiteLayers;
overprint is 1x PER SELECTED LAYER — the Overprint=3 White HD screenshot was
file-specific and no hidden multiplier exists. Minutes display = hours x 60
(factor-of-ten class eliminated; the line shows minutes, hours, and the full
formula). The Advanced minutes/sqft override keeps its documented x-passes
manual semantics. Worked example (fixture 5, 100.74 sqft, 3 gloss):
0.6716 + 2.7475 = 3.4191 hr = 205.1 min = $27.35 at $8/hr.

## 15F.0G.2 — Mimaki UCJV300-130 RasterLink profile (2026-07-25, supersedes G.1)
Two DISTINCT printer architectures, one authoritative resolver (loader,
save action, snapshots, production estimates all flow through it):
- **Mimaki UCJV300-130 = COMBINED RasterLink configuration-throughput**.
  Active owner-verified standard profile: 600x1200 VD / 32 pass /
  Overprint 1 / Bi-direction / Fast Print High / LUS-170. Effective
  throughput by TOTAL production layers: **1 layer 51.6 / 2 layers 18.2 /
  3 layers 11.8 / 4 layers 8.6 sqft/hr**, x **1.15** UCJV300-130
  carriage/turnaround factor applied ONCE to total time (hours =
  sqft / rate x 1.15; minutes = hours x 60; recovery = hours x $8).
  This is the profile for THIS configuration, not a universal Mimaki spec.
  The interim G.1 single-rate figure was incorrect and is fully retired
  (test-enforced: the numeral appears nowhere in engine or route). Layer
  totals of 5+ BLOCK: "Verified Mimaki RasterLink layer profile required".
  Mimaki gloss ink remains BLOCKED: "Verified Mimaki gloss production and
  ink profile required". The stale generic Machine-record speed is
  deliberately unused for Mimaki (engine-owned profile governs).
  Owner-verified examples (test-pinned): 19.26 sqft CMYK ~25.8 min;
  19.26 sqft two-layer ~73.0 min; 100 x 3x3 ~9.29 min ($1.24);
  1,000 x 3x3 ~92.9 min ($12.38).
- **Roland = ADDITIVE mode-time model — unchanged**: CMYK 150 sqft/hr
  verified baseline (Machine record) + Gloss/Emboss 110 and White HD 75
  sqft/hr per selected layer; premium fixture stays 3.4191 hr.
Displays name the real source ("CMYK machine time — 92.9 min (1.55 hr),
51.6 sqft/hr" with the full RasterLink profile in the note; "Combined
2-layer machine time — 18.2 sqft/hr" for two-layer jobs). DTP untouched.

## 15F.0G.3 — provisional Mimaki gloss ink + RIP calibration path (2026-07-25)
Routine Mimaki gloss quotes no longer block (owner decision): gloss ink =
adjustedSqft x 0.6 ml/sqft (CMYK basis) x glossLayers x approvedGlossFactor
(initial 1.00) x $0.176/ml — labeled ESTIMATED with the full formula, never
verified, never $0. BLOCKS remain for 5+ total layers (no RasterLink
throughput), missing ink price/usage basis, and every other missing
component. WHITE keeps its existing VERIFIED rate (the provisional approach
applies only where a cost is missing); whiteFactor (1.00) exists SEPARATELY
for calibration. Every premium Mimaki quote snapshots premiumInkEstimate
(printer, profile, basis, layers, factors, estimated ml/cost, version
15F.0G.3-provisional-ink-estimate) — the immutable record RIP actuals are
compared against. app/lib/ink-calibration.server.ts provides READ-ONLY
comparison (estimate vs actual ml, variance ml/% — quote estimates never
replaced) and owner-review recommendations grouped by printer/profile/ink
type/material family: weightedFactor = sum(actualMl) / sum(base estimated
ml BEFORE factor), minimum 3 finalized comparable jobs, confidence 3-4 low
/ 5-9 medium / 10+ high. Factors change ONLY by owner approval (future
ownerConfig.inkCalibration.mimaki.whiteFactor/.glossFactor, 15F.1);
historical snapshots are never rewritten. Live fixture (585 x 7.13x3.13,
3 designs, 3 gloss, simple contour, Mimaki): machine 13.47 hr / $107.76
(4-layer 8.6 x 1.15), CMYK $10.64, gloss $31.91 estimated, complete cost
$249.65 -> premium 56% -> $567.39 READY TO QUOTE ($0.97/label).
