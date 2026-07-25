# GSO ERP — Pricing Correction Plan (15F.0, 2026-07-25)

Plan only — nothing here is implemented. Order chosen so each step is small,
testable, and independently shippable; owner decisions are flagged where a
number must come from the owner, never invented.

## Correction sequence

**15F.0a — margin by QUANTITY for every family (fixes P0-1).** One shared
`marginPctForQuantity(familyKey, quantity)` generalizing the proven
dtpMarginPctForQuantity: per-family quantity bands map onto the researched
5-point curves; table margins come from each row's QUANTITY, never row
count/position. Proposed default bands = the existing default tier
quantities as thresholds (e.g. stickers: <128 -> 65, <256 -> 58, <640 -> 52,
<1000 -> 46, >=1000 -> 40) — **owner must confirm band edges per family**
(they were never formally specified; today they exist only implicitly as the
5 default table rows). Advanced per-tier owner edits and all floors
unchanged. Immediate effect: 100 x 3x3 stickers -> 65% -> $35.02; tier
tables stop shifting when a quantity is added.

**15F.0b — wire machine time (fixes P1-1).** minutes/sqft = 60 /
Machine.sqftPerHour from the SELECTED printer's DB record (both live
printers: 150 sqft/hr) x passes; rate = one resolved owner rate. **Owner
decision: $5/hr (DB Machine.costPerHour) vs $8/hr (owner-standard
provisional recovery)** — recommend $8 as the recovery rate and retiring $5
or updating the Machine records to match; margin-review's $25 stays
quarantined. Adds ~$0.23 (100 stickers) to ~$5.14 (1,000 bags) of real cost.

**15F.0c — packing + shipping defaults (fixes P1-3/P1-4).** Extend
PACKOUT_RULES (or the future ownerConfig) with sticker mailer/box, banner
tube, Chiron/Miron and 14x16 rules (**owner supplies units-per-box +
supplies cost**); outbound-shipping estimated allowance per family that
must be explicitly zeroed ("customer pickup") instead of silently $0.
Labeled Estimated until verified.

**15F.0d — minimum job economics per family (fixes P2-1, extends 15C.2
model).** Per-family: minimum job price, minimum gross profit, small-order
statuses (READY / WARNING / OVERRIDE REQUIRED with the existing phrase).
**Owner decision on values.** Discussion anchors from the fixtures (NOT
defaults): stickers min job ~$45-65 (competitors price 100 3x3 at ~$50-80);
banners min ~$60; bags/jars already carry blank+application mass so a
profit-based minimum (~$150-250?) may fit better than a price minimum.
Cutting time (P1-2) can ride 15F.0b (a per-sqft cut pass) or 15F.0d as a
per-piece cut standard — owner chooses the model.

**15F.0e — sticker (and later banner) owner PRICE LADDERS (fixes P2-2)**
if the owner prefers market-anchored pricing over cost-plus at volume —
same hybrid mechanism as DTP 15C.2 (ladder price, server-computed landed
cost/margin/profit safeguards). Requires an owner price sheet; slot into
the 15F.2 editable-ladder work (ownerConfig.dtp.ladders generalizes to
ownerConfig.pricing.ladders.<family>).

**Then remaining P2/P3:** blank waste consistency (P2-3, decide: apply the
divisor to blanks in the product flow like the manual pipeline, or document
vendor-replaces-breakage), recipe waste wiring (P2-4), overhead/processing
allowance policy (P2-6), status display honesty (P2-7 — "Ready (3 estimated
$0 lines)"), then resume 15F.1 owner settings so every new rate lands
editable.

## Smallest safe emergency patch (recommended NOW): 15F.0a
Pure function + tests + the two call sites (loader tier map, save tier map)
in app.erp.cost-calculator.tsx; no schema, no route, no UI change; DTP
untouched (already quantity-based); floors/override gates unchanged;
forensic pins updated deliberately (P0-1 pin flips from documenting the bug
to documenting the fix). It raises under-margined small quotes immediately
and stops the tier-table drift, while every other correction waits on owner
numbers. Risk: LOW — margins only move UP or stay (bands >= current
interpolation at every point when band edges = default quantities).

## Exact 15F.0a patch prompt
> PATCH 15F.0a — QUANTITY-BASED FAMILY MARGINS. Read AGENTS.md,
> docs/GSO_ERP_CALCULATOR_FORENSIC_AUDIT.md (P0-1),
> docs/GSO_ERP_PRICING_CORRECTION_PLAN.md first. In
> app/lib/calculator-emergency.server.ts add
> `marginPctForQuantity(rule: FamilyMarginRule, quantity: number): number`
> mapping quantity onto the rule's researched 5-point curve with the band
> edges [OWNER: confirm per family; default = the family's default tier
> quantities 64/128/256/640/1000 as thresholds, last band = last curve
> point], clamped to familyMinPct, mirroring dtpMarginPctForQuantity's
> highest-reached semantics. Replace curveForTierCount/defaultTierMargins
> ONLY where automatic PRODUCT-flow tier margins are derived in
> app/routes/app.erp.cost-calculator.tsx (loader productTiers AND action
> savedTiers; keep posted Advanced margins override and every floor/gate;
> DTP branch untouched; legacy manual/emergency pipeline untouched).
> Update the pinned expectations in
> tests/calculator-forensic-fixtures.test.ts (P0-1 pin, fixture 1 60%->65%,
> fixture 5 48%->band value) and add band-edge unit tests (100->65,
> 128->58, 999->46, 1000->40, 5000->40 for stickers; per-family spot
> checks). Do not change curves, floors, DTP, or any cost line. Run the
> full battery (tests, typecheck vs 306 baseline, build, git diff --check)
> and report with the standard structured completion format including the
> commit command not run.

## Owner decision list (blocking the later steps)
1. Margin band edges per family (15F.0a — recommended defaults above).
2. Machine recovery rate: $8 standard vs $5 DB Machine rows (15F.0b).
3. Cutting-time model: per-sqft pass vs per-piece standard + rates (15F.0b/d).
4. Packing rules: units-per-box + supplies cost for stickers, banners,
   Chiron/Miron, 14x16 (15F.0c).
5. Outbound shipping policy: estimated allowance per family vs always-quoted
   (15F.0c).
6. Minimum job price/profit per family (15F.0d).
7. Sticker market price ladder — provide sheet or keep cost-plus (15F.0e).
8. Overhead/payment-processing allowance policy (later P2-6).
