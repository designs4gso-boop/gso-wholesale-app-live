# Cost Calculator Input Rules (14C.1)

**Workflow:** What are you pricing? (family) -> select product/blank from
verified ERP records (price status in the label; NO PRICE never shown as
Verified) -> quantity/designs/print dims -> material picker (verified $/sqft)
-> printer -> white/gloss LAYERS (0-14) -> CALCULATE COST. The server derives
everything: sqft (w x h x qty x faces / 144), waste (recipe rule > Advanced
override(+reason) > PROVISIONAL 10% labeled), boxes (Safe Care rules: 4x5 bags
1000/box, 3oz 150, 4oz 100; ceil; $2/box packing; missing rule = Estimated),
weeding pages (stickers with weeded cut only: ceil(sqft/20.25) x $1.3333,
labeled Estimated), blank/lid costs (qty-tiered, server-resolved), layer ink
(PROVISIONAL LINEAR MODEL: each layer = one extra full-coverage pass at base
ml/sqft; passes = 1 + white + gloss scale machine time; documented in
product-driven-costing.server.ts, replace after 13A.8 calibration).

**Family fields:** bags = Front only / Front and back (1 or 2 labels/bag);
jars = Labels per jar; banners = Single/Double-sided + hemming/grommets
(finishing labor MISSING blocker); stickers = cut type drives weeding; custom
item requires name + cost + source/reason (snapshotted, labeled Estimated).
Miron alone shows the lid picker (jar + lid separate lines); Chiron cap is
included and never double-counted.

**Layer rules:** 0-14 clamped; negatives rejected; white hidden-impact on
printers without the channel (warned); Mimaki gloss layers > 0 = GLOSS INK
COST NOT VERIFIED - DRAFT ONLY (never $0-final); Roland uniform rate labeled
owner-approved provisional.

**Safety:** the save action re-fetches posted record IDs from the DB and
re-runs the engine (14C.1-product snapshot with selections + derived values);
client-posted costs/sqft/boxes/waste are never trusted. Manual $/sqft, blank
cost, blank label, waste %, boxes, and weeding pages are GONE from the normal
form (Advanced overrides require reasons).

**Provisional/remaining:** linear layer model; 0.6 ml/sqft base ink usage;
weeding page estimate; packing-supplies cost; per-family material filtering is
name-based; recipe waste-rule lookup not yet wired (falls to provisional 10%).
