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

## 14C.1B — Standard Jars + Premium Jars (Chiron & Miron)
Visible families: 4x5 Sticker Bags / Standard Jars / Premium Jars - Chiron &
Miron / Stickers & Labels / Banners / Custom Item (legacy chiron-jars /
miron-jars URL values still accepted). One shared classifier
(classifyCalculatorProduct: productType slugs > vendor > sku > documented name
fallback; jar_5oz stays hidden) drives every picker. 4x5 bags auto-select the
single verified blank (read-only; >1 shows a picker; 0 shows the configured
message). Standard Jars = jar_standard only (caps included per record, counted
once, no top selector). Premium picker groups CHIRON (cap included) and MIRON;
Miron jar-only records REQUIRE a compatible top (size-token compatibility:
matching 50/100/150/250ml token or universal top; centralized in
mironTopCompatible) - no top = Draft Only via the engine MISSING line; seeded
"jar + lid" Miron sets are detected as lid-included and priced once (labeled
"lid included in set" with a data-cleanup note - the spec top requirement is
waived ONLY for these to prevent double-counting the lid already inside the
verified tier price). Saves re-fetch and re-classify server-side; snapshot
engine 14C.1B-premium-jars records classification, includesTop, and topId.

## 14C.1B1 — Miron top ALWAYS required (owner rule)
The 14C.1B lid-included waiver is REMOVED: every Miron selection renders the
required Top type selector (canonical Standard/Classic and Black metal types
render even when no Vendor Cost Book top records exist). Cost policy
(centralized in resolveMironTopLine, engine 14C.1B1-required-miron-top):
combined jar+lid sets charge the set once; selecting the included standard top
= $0 incremental ("Standard top — included in selected Miron set"); a
different top adds ONLY the verified upgrade difference (top cost minus
included standard cost — both must be verified, else "TOP UPGRADE COST NOT
VERIFIED — DRAFT ONLY", never assumed $0); true jar-only records add the full
qty-tiered top cost. Vendor Cost Book records still needed: separate Standard/
Classic top and Black metal top prices (unlock verified upgrade differences).
