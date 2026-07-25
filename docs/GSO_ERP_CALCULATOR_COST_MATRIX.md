# GSO ERP — Calculator Cost-Component Matrix (15F.0 CORRECTED ENGINE, 2026-07-25)

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
| Machine recovery | INC ($8/hr x 150 sqft/hr x passes; BLK if no speed) | INC | INC | INC | INC | INC when dims | EXC (outsourced) |
| Art/design setup | INC $8.33/design | INC | INC | INC | INC | INC | INC (every design) |
| Print setup | INC $1.00/design | INC | INC | INC | INC | INC | EXC (owner rule — Spektra prints) |
| Cutting time | INC (label sq-rect $6.53/page) | INC | INC | INC sq-rect + contour bands x1.15/1.35/1.60 PROV; die-irregular BLK | INC (trim) | INC/BLK by cut type | EXC |
| Weeding | — | — | — | INC when weeded cut (PROV pages) | — | — | EXC |
| Application labor | INC 4x5/14x16; other sizes BLK | via jar rate $0.20 | INC $0.20/label | — | — | — | EXC |
| Packing/boxes | INC (1000/box rule; other sizes 5,000/box PROV) | INC (3oz 150 / 4oz 100) | INC (100/box family default PROV) | INC (5,000/box PROV) | INC ($4 tubes, 5/tube PROV) | EXC (note) | EXC (vendor case-packed) |
| Freight outbound | EXC stated ("not included"); entered freight INC | EXC stated | EXC stated | EXC stated | EXC stated | EXC stated | INC $85/PO inbound; outbound EXC stated |
| Vendor setup/plates | — | — | — | — | — | — | INC $0 verified |
| Spoilage/waste | INC media 10% PROV; blanks NOT wasted (P2-3) | same | same | media only | media only | media only | EXC (in vendor cost) |
| Reprint allowance | MISS-by-design (P2-8; actuals track) | same | same | same | same | same | same |
| Minimum job charge | INC PROV ($75 profit) | INC PROV ($75) | INC PROV ($100) | INC PROV ($25 profit + $25 order + AREA floor) | INC PROV ($25 + $40 order) | INC PROV ($25 + $25) | INC ($500/$350 + floors) |
| Overhead contribution | MISS (P2-6) | MISS | MISS | MISS | MISS | MISS | MISS |
| Payment processing | MISS (P2-6) | MISS | MISS | MISS | MISS | MISS | MISS |
| Duplicated components | none found | none | none (top/cap logic verified single-count) | none | none | none | none (freight single-count verified) |

No DOUBLE-counted component exists in any family (Chiron cap, Miron
set/top upgrade, DTP freight, multi-line job packing, and included features
all verified charged-once by tests). 15F.0 closed the MISS column: machine,
cutting, and packing now carry real dollars in every in-house family;
outbound shipping is EXCLUDED-with-statement (never confused with missing);
minimum-job values are policy slots awaiting owner numbers
(docs/GSO_ERP_PRICING_OWNER_DECISIONS.md). Remaining PROV labels (waste 10%,
ink 0.6 ml/sqft, packing defaults) are visible on their lines.

## 15F.0-FINAL addition
Banner finishing: setup $5/job + hems $0.60/ft + grommets $0.30 @24in — INC
PROV for BA (READY); specialty finishing unsupported. Sticker AREA market
floor + family minimum profit/order candidates live in
commercial-pricing-policy (see GSO_ERP_PRODUCTION_READY_PRICING.md).
