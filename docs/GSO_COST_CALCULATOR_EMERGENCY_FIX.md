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

## 14B.1 — Automatic full product costing (engine core)
Pure engine app/lib/auto-costing.server.ts (version 14B.1) computes the full
labeled breakdown for the five priority families (4x5 bags, Chiron, Miron,
stickers/labels, banners): blank/lid (qty-aware inputs; Chiron cap-included and
never duplicated; Miron jar+lid separate), material sqft x verified $/sqft, ink
via channel rates (Roland uniform = provisional; Mimaki gloss = MISSING blocker),
machine at $8/hr, owner-standard art/print setup (spread by tier), family
application labor, weeding, packing, freight as its own line (added ONCE by the
freight panel pipeline), waste divisor applied once to material+ink (no rule ->
ESTIMATED 10% flagged). Missing dims/designs/lid/finishing produce MISSING lines
that block finalization; banners hem/grommet labor = missing. Loader auto mode
(emode=auto + family) feeds computed variable+setup into the tier pipeline and
returns the breakdown; auto-mode DRAFT SAVING is deliberately blocked until
14B.1a adds full server-side recomputation of auto params (client totals are
never trusted). Deferred to 14B.1a: auto-input UI fields + verified-material
picker + auto-save recompute; manual mode remains the labeled fallback.

## 14B.1a — Automatic form + safe auto draft save
Automatic Costing form (Recommended) on the calculator: family + designs/sides/
dims/material/printer/white/gloss/blank/lid/boxes/waste/weeding/hemming fields,
CALCULATE COST (GET -> server computeAutoCost), full breakdown with colored
Verified/Owner standard/Estimated/Missing badges, COST NOT VERIFIED - DRAFT ONLY
banner listing each missing cost, Finalizable indicator, and a copyable Approved
Customer Price summary (product/qty/unit/total/freight/setup note). Auto-mode
DRAFT SAVE now recomputes everything server-side from the posted family inputs
(client evar/esetup ignored; engine "14B.1a-auto"; autoBreakdown lines+missing+
warnings snapshotted). Manual Emergency mode retained as labeled fallback.
Remaining before 14C: DB-record pickers for materials/jars/lids (values are
typed from verified records this patch), per-family field hiding, form-value
retention polish.
