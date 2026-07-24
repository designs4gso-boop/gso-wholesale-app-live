# Cost Calculator Emergency Stabilization (14B.0)

**What works now:** the calculator has an "Emergency pricing" panel: provisional
tier generator (60/55/50/45/40 curve, editable per tier, highest tier 40%), setup
spread by quantity, per-tier independent pricing (never tier-1 discounts), visible
freight (actual > ESTIMATED allowance; per-unit / by-value / manual allocation),
40% margin floor with `OWNER MARGIN OVERRIDE` + reason gate, missing-cost
finalization block (`COST NOT VERIFIED — OWNER REVIEW REQUIRED`), and **Save as
draft quote** (full tier/freight/override snapshot into a draft Quote; history
untouched). Margin math is divisor-based, identical to the engine (tested).

**Verified inputs:** 4x5 bag $0.09; Chiron 150ml $1.90 cap-incl; Miron qty tiers;
material $/sqft + roll dims (matte/gloss 54x150, holo 50x164, clear 54x50, banner
54x150); Mimaki CMYK+white $0.176/ml; Roland $149/750 (provisional-uniform across
channels, owner-approved); $8/hr machine; owner labor: art $8.3333/design, print
$1.00/design, weeding $1.3333/page, jar $0.20, bag label $0.078125, packout
$2.00/box (all in `calculator-emergency.server.ts` OWNER_LABOR).

**Provisional:** margin curve; Roland uniform channel rate; freight allowance.
**Missing (never guessed):** Mimaki clear/gloss $/ml; cutting/finishing standards;
banner hem/grommet labor; box family blanks.

**Limitations before 14B.1/14C:** legacy in-page calculator math still exists
(ink profiles remain, ESTIMATED); the emergency panel takes per-unit variable
cost + setup as entered numbers rather than recomputing per-family lines; full
family-aware field hiding and per-line source badges deferred to 14C; draft
quotes need finishing in Quotes/CRM.
