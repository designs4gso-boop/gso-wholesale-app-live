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

## 14B.0A — Family-specific margin curves (researched)
Nine researched five-level curves replace the universal curve when a family is
selected (source: GSO 2026 competitor and margin study): bags-4x5 65/58/52/47/45
(min 45); chiron-jars 60/55/50/45/40 (min 40); miron-jars 65/58/52/47/45 (min 45);
stickers-labels 65/58/52/46/40 (min 40); spot-gloss-labels 70/62/56/50/45 (min 45);
banners 60/55/50/45/40 (min 40); dtp-pouches 65/58/52/46/42 (min 42); die-cut-bags
68/60/55/50/45 (min 45); boxes 68/60/54/48/45 (min 45). Global 40% floor stays
absolute. Below family-min (>=40) needs the OWNER MARGIN OVERRIDE phrase+reason;
below 40 uses the same gate with a GLOBAL floor message. Tier-count mapping:
1->[last]; 2->[first,last]; 3->[first,middle,last]; 4->[1,2,4,5]; 5->all; >5 ->
monotonic first->last interpolation clamped at family min. Exact-alias resolver
only (no fuzzy); unknown family = provisional universal curve + "FAMILY MARGIN
RULE NOT CONFIGURED". Edited margins are kept (defaults shown alongside). Draft
snapshots record family, curve, researched defaults, edited margins, family min,
global floor, override reason, timestamp (engine 14B.0A-emergency).
