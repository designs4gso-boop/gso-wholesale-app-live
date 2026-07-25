# GSO ERP — Calculator Cost-Component Matrix (15F.0, 2026-07-25)

Legend: **INC** included (real dollars) · **EXC** intentionally excluded
(documented reason) · **MISS** missing (should carry dollars, silently $0) ·
**PROV** provisional (labeled estimate) · **BLK** missing-with-blocker
(Draft Only — safe) · — not applicable. Families: SB=Sticker Bags,
SJ=Standard Jars, PJ=Premium Jars (Chiron/Miron), ST=Stickers & Labels,
BA=Banners, CU=Custom Item, DTP=DTP Bags.

| Component | SB | SJ | PJ | ST | BA | CU | DTP |
|---|---|---|---|---|---|---|---|
| Blank/vendor item | INC (0.09/1.00; 4x6+sizes BLK) | INC (code presets, P3-4) | INC (flat Chiron / tiered Miron+top) | — | — | INC (owner-entered, Estimated) | INC (Spektra tiers) |
| Material (media) | INC | INC | INC | INC | INC | INC when dims given | EXC (vendor-finished) |
| CMYK ink | INC (0.6 ml/sqft PROV) | INC | INC | INC | INC | INC when dims | EXC |
| White ink | INC (linear PROV) | INC | INC | INC | INC | INC | EXC |
| Gloss ink | Mimaki BLK / Roland PROV | same | same | same | same | same | EXC |
| Machine recovery | **MISS (P1-1)** | **MISS** | **MISS** | **MISS** | **MISS** | **MISS** | EXC (outsourced) |
| Art/design setup | INC $8.33/design | INC | INC | INC | INC | INC | INC (every design) |
| Print setup | INC $1.00/design | INC | INC | INC | INC | INC | EXC (owner rule — Spektra prints) |
| Cutting time | **MISS (P1-2)** | **MISS** | **MISS** | **MISS** | **MISS** (trim) | **MISS** | EXC |
| Weeding | — | — | — | INC when weeded cut (PROV pages) | — | — | EXC |
| Application labor | INC 4x5/14x16; other sizes BLK | via jar rate $0.20 | INC $0.20/label | — | — | — | EXC |
| Packing/boxes | INC (1000/box rule) | INC (3oz 150 / 4oz 100) | **MISS (P1-4)** | **MISS** | **MISS** | EXC (note) | EXC (vendor ships cases) |
| Freight outbound | **MISS default $0 (P1-3)** | **MISS** | **MISS** | **MISS** | **MISS** | **MISS** | INC $85/PO inbound; outbound MISS |
| Vendor setup/plates | — | — | — | — | — | — | INC $0 verified |
| Spoilage/waste | INC media 10% PROV; blanks NOT wasted (P2-3) | same | same | media only | media only | media only | EXC (in vendor cost) |
| Reprint allowance | MISS-by-design (P2-8; actuals track) | same | same | same | same | same | same |
| Minimum job charge | **MISS (P2-1)** | **MISS** | **MISS** | **MISS** | **MISS** | **MISS** | INC ($500/$350 + floors) |
| Overhead contribution | MISS (P2-6) | MISS | MISS | MISS | MISS | MISS | MISS |
| Payment processing | MISS (P2-6) | MISS | MISS | MISS | MISS | MISS | MISS |
| Duplicated components | none found | none | none (top/cap logic verified single-count) | none | none | none | none (freight single-count verified) |

No DOUBLE-counted component exists in any family (Chiron cap, Miron
set/top upgrade, DTP freight and included features all verified
charged-once by tests). The systematic problem is the MISS column pattern:
machine, cutting, packing (3 families), outbound shipping, and minimum job
economics are $0 across every in-house family while status still reads
Ready.
