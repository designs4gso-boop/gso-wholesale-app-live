# GSO ERP — Printer Cost Completeness (15F.0J, 2026-07-25)

Extends GSO_ERP_CALCULATOR_COST_MATRIX.md with the print-floor components.
States: VER verified / OWN owner standard / EST estimated / EXC excluded
with reason / MISS missing / DUP duplicated / BLK blocked.

| Component | ST/SB/SJ/PJ/BA (in-house) | DTP |
|---|---|---|
| Blank/vendor item | VER (rules as documented) | VER |
| Media consumed | EST (finished area + 10% PROV — NOT RIP layout; see O) | EXC |
| CMYK / white ink | EST-OWN (0.6 ml/sqft basis; sample A says ~1.5 ml/sqft CMYK — calibration pending) | EXC |
| Gloss ink | EST (Roland linear; Mimaki provisional G.3) | EXC |
| Primer/optimizer | MISS (not modeled; confirm if used) | EXC |
| Cleaning/purge allowance | MISS | EXC |
| Leading/trailing media | MISS (partially hidden inside 10% waste PROV) | EXC |
| Layout/nesting loss | MISS (same 10% proxy; real utilization unmeasured) | EXC |
| Spoilage/reprint reserve | MISS (tracked in actuals only) | EXC |
| Machine occupancy/recovery | OWN ($8/hr x profile time — profiles PROVISIONAL) | EXC |
| Active operator labor | MISS (see S below — the biggest verified gap) | EXC |
| RIP setup / load-unload / nozzle check / registration / QC / design sorting | MISS (all operator-labor family) | EXC |
| Cutting + cut registration | OWN page model + PROV contour bands; registration MISS | EXC |
| Weeding | EST (weeded cuts) | EXC |
| Application | OWN (bags/jars) | EXC |
| Packing + cartons/tubes | OWN/EST (documented) | EXC |
| Inbound freight | n/a | VER $85 |
| Customer delivery | EXC stated | EXC stated |
| Payment processing | MISS | MISS |
| Min order / min profit | OWN PROV | VER |
| Min profit per MACHINE HOUR | MISS (recommended new candidate) | n/a |
| Commercial market floor | OWN PROV (stickers area floor) | VER ladder |

## S. Operator labor (finding: MISSING everywhere in-house)
Machine recovery ($8/hr) is occupancy, not people. Recommended
deterministic model (owner $25/hr labor basis):
operatorMinutes = fixedSetup (RIP prep + load + nozzle + align, ~10-15 PROV)
+ fixedUnloadQc (~5-10 PROV) + attendedPct x machineMinutes (10-20% PROV;
NOT 100% — machines run unattended) + perDesignHandling (~1-2) +
specialModeSetup (white/gloss ~5 PROV). Fixture impact at 15/7.5/15%/1/5
and $25/hr: 100x3x3 stickers +$10.0 (~+$28 price @65%); 1,000x3x3 +$12.2
(floor absorbs, price unchanged); 2,560 4x5 bags 2-sided +$34 (~+$62
price); Mimaki gloss fixture 15 +$45 (~+$102 premium price). Values are
PROVISIONAL discussion anchors — owner sets before implementation.

## O. Area model finding
ALL runtime/ink/material estimates use finished-label sqft (+10%);
authoritative recommendation: MATERIAL + RUNTIME + INK from RIP LAYOUT
area (scan W x feed L; sample A shows near-100% utilization on a full-width
nest, but narrow/odd jobs will differ), CUTTING from layout pages, WASTE =
measured layout minus finished (replaces the flat 10% once captured),
CALIBRATION strictly layout-based. Requires layout capture (converter).
