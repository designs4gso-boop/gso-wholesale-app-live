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

## 14C.2 — Complete product-to-price quoting flow
Normal flow: choose product -> enter job details once -> CALCULATE COST ->
review breakdown -> automatic pricing tiers appear -> Use this price ->
SAVE DRAFT QUOTE. No second pricing form. Engine/snapshot version:
14C.2-multilabel-auto-tiers (Miron top policy unchanged at
14C.1B1-required-miron-top, recorded as topEngine).

### Families (canonical values for new quotes; legacy URL/snapshot values accepted)
Sticker Bags (sticker-bags; legacy bags-4x5) / Standard Jars (standard-jars) /
Premium Jars — Chiron & Miron (premium-jars; legacy chiron-jars + miron-jars) /
Stickers & Labels (stickers-labels) / Banners (banners) / Custom Item
(custom-item; legacy custom).

### Classifier (as corrected by 14C.2A — owner-authoritative)
classifyCalculatorProduct normalizes vendor/sku to alphanumerics and applies
the precedence: Miron top > Miron jar > Chiron jar (EXPLICIT Chiron branding
only) > standard jar > sticker bag > other. OWNER RULES (14C.2A): 3 oz / 4 oz
/ 5 oz normal jars are STANDARD jars — vendor SAFE CARE alone never implies
Chiron (the original 14C.2 pass wrongly reclassified the Safe Care oz-jars as
Chiron; corrected before commit). Chiron = only the explicit Chiron records
(jar_chiron, cap always included, flat cost, NO Top Type selector). The 5 oz
jar is a normal Standard Jar in the calculator per the owner rule (the
AGENTS.md jar_5oz storefront exclusion still applies to the storefront
configurator, which is separate code).
blankClassAllowedFor() enforces family/class fit at loader AND save, so stale
selections from a family switch are treated as no selection. Empty optgroups
are never rendered. Material rows that mirror a VendorProduct record (same
sku/name) are deduped out of the pickers — the vendor record with tiers wins.

### Sticker Bags (data-driven, renamed from "4x5 Sticker Bags")
Any active record with productType "bag" (dtp_/stock_/die excluded — different
families; OZ bags excluded by owner rule 14C.2A) or a bag-named blank
classifies bag_sticker: today 4x5 ($0.09 verified), 4x6 (cost NEUTRALIZED by
14C.2A1 — NO PRICE — not verified until the owner provides pricing), and 14x16
($1.00 verified); a future size appears with no route change. The
owner-required size list 4x5/4x6/5x8/6x9/14x16 always renders: sizes without a
record (today 5x8 and 6x9) appear as canonical "NO PRICE — not verified"
options (value type:bag-<size>) that quote Draft Only — a cost is never
guessed; a real record for the size automatically replaces the canonical
entry. Unpriced bag records stay visible with the NO PRICE label. Exactly one
real bag -> auto-selected; otherwise picker; no real bags -> the red
"No active sticker-bag products are configured." notice (canonical sizes stay
selectable).
Application labor resolves by BAG SIZE from owner standards only
(bagApplicationRateFor): 4x5 = $0.078125/label, 14x16 = $1.00/label; any other
size is a MISSING blocker — never silently priced at the 4x5 rate. The
researched bags-4x5 margin curve applies only to 4x5 bags; other sizes use the
provisional universal curve labeled FAMILY MARGIN RULE NOT CONFIGURED.

### Jar multi-label builder (Standard, Chiron, Miron)
"How many labels per jar?" (1/2/3/Custom, up to 6) then "Are all label sizes
the same?". Same-size: one width/height applied to every label (pieces =
quantity x labels). Different sizes: one row per label with Label type (Side/
Lid/Bottom/Neck/Tamper/Additional/Custom; defaults 1=Side, 2=+Lid, 3=+Additional,
4+ numbered Additional) and its own required width/height. buildLabelRows() is
the ONE shared builder (loader + save): rows derive strictly from the posted
count, so stale hidden rows are discarded and never affect cost. Terminology:
"Top Type" = the physical Miron component; "Lid label" = printed artwork — the
UI and snapshot never mix them (topId is only recorded for Miron).

### Multi-label server calculation
Per row: pieces, dimensions, sqin, base sqft, material/ink display allocation
(sqft share — shares sum exactly to the costed lines), shared white/gloss
layers, applications. Total base sqft = sum of rows; waste applies ONCE to the
total; application labor = quantity x labels applied (never per jar — this
also fixed the old jar application line, which charged per jar). One material,
printer, and layer count per job in the normal form (per-label overrides are a
known limitation). Missing row dimensions are per-row MISSING blockers.

### Automatic pricing tiers
After CALCULATE COST with a real quantity, the family tier table renders
automatically: existing default quantities (64/128/256/640/1000, editable in
Advanced Pricing Controls) plus the requested quantity, highlighted. Each row
RERUNS the engine at that quantity (blank tiers, boxes, setup spread all
re-resolve), then prices via the researched family curve (marginFamilyKeyFor:
premium+Chiron -> chiron-jars, premium+Miron -> miron-jars, 4x5 bags ->
bags-4x5, stickers/banners direct; standard jars and custom -> provisional
universal, labeled). Freight rides in the margin basis exactly as the manual
pipeline always has. Columns: Quantity, Job Cost, Unit Cost, Margin, Unit
Price, Total Price, Profit, Status (Ready / DRAFT ONLY / BELOW FLOOR). No
zero-value tier rows render before a calculation (auto or manual table).

### Customer price selection + save
"Use this price" selects one row; the customer card shows Product, Quantity,
Configuration, Unit price, Product subtotal, Setup/design (included), Freight
(included in unit pricing, shown for visibility), Total — never internal cost
or profit. SAVE DRAFT QUOTE posts the GET state via one psearch field plus the
selected tier QUANTITY; the action re-fetches every record, rebuilds label
rows, recomputes cost and all tiers, and resolves the selected tier by
quantity — posted totals are ignored. Snapshot (engine
14C.2-multilabel-auto-tiers) records canonical family, selections/IDs,
classification, Miron topId, label rows + same-size flag, derived totals
(pieces/sqft/waste/application count), every cost line, all tier rows, the
selected tier, margin rules and sources, and overrides with reasons.

### Remaining limitations (14C.2)
- No per-label material/printer/layer overrides in the normal form.
- Application-labor standards exist only for 4x5 and 14x16 bags; other bag
  sizes (4x6, OZ) block until the owner sets a standard.
- Standard Jars and non-4x5 bags have no researched margin curve (provisional
  universal, labeled) — margin study extension needed.
- Miron separate-top records still absent from the Vendor Cost Book, so
  non-standard top choices stay Draft Only (14C.1B1 limitation).
- Preset records (OZ bag, soda can) still carry code prices labeled as
  presets; enter them as Vendor Products to supersede.

## 14C.2A — Corrected jar and sticker-bag catalog (owner-authoritative)
STANDARD JARS: all active normal 3 oz / 4 oz / 5 oz variants (clear +
black/white + 5 oz clear; caps counted once; no Top Type selector). These are
NOT Chiron — SAFE CARE is simply the vendor.
CHIRON (Premium Jars, CHIRON group): exactly two records, seeded via
tools/seed-chiron-jars.mjs (stable vendorSkus chiron-100ml / chiron-150ml):
"Chiron 100 ml — cap included — $1.80 — Verified" and "Chiron 150 ml — cap
included — $1.90 — Verified". FLAT cost at every quantity — no tiers exist and
enforceFlatChironCost() strips any stray tiers at loader AND save, so the
blank cost can never drift by quantity (selling margins still vary by tier
normally). No other Chiron sizes appear.
MIRON (Premium Jars, MIRON group): unchanged — tier-priced blank cost from the
configured VendorProduct tiers (verified intact after the Chiron seed), Top
Type always required, 14C.1B1 included-top/upgrade logic untouched.
STICKER BAGS: exactly 4x5, 4x6, 5x8, 6x9, 14x16; OZ bag excluded. Missing-cost
sizes appear as NO PRICE — not verified and stay Draft Only; application labor
standards remain size-specific (4x5 + 14x16 only; other sizes are separate
MISSING blockers). A guessed cost is never assigned.

## 14C.2A1 — Stale 4x6 cost neutralized
The old $0.10 on the 4x6 record was never owner-verified, so
tools/neutralize-4x6-bag-cost.mjs (run once, re-runnable) zeroed
defaultUnitCost and renamed the record "4x6 Sticker Bag" (same record ID and
vendorSku preset:blank-4x6-bag; nothing deleted; historical quote snapshots
untouched). The calculator now shows "4x6 Sticker Bag — NO PRICE — not
verified"; selecting it raises the missing blank-cost blocker and every tier
stays Draft Only. Final statuses: 4x5 $0.09 Verified / 4x6 NO PRICE / 5x8 NO
PRICE / 6x9 NO PRICE / 14x16 $1.00 Verified / OZ excluded. Standard Jars =
3 oz + 4 oz + 5 oz + soda-can preset (the can is treated as a jar, owner
rule); Chiron, Miron, and Miron tops stay excluded. Entering the owner cost in
the Vendor Cost Book makes 4x6 Verified automatically.

## 15C — Custom Printed Pouches / DTP Bags (Spektra, vendor-finished)
Family dtp-bags (alias dtp-pouches). Inputs: DTP size (from Spektra
VendorProduct records; unpriced sizes show NO PRICE and stay Draft Only),
quantity (MOQ 1,000 — below-MOQ is a MISSING blocker), number of designs,
hang hole yes/no ($0), customer name, notes. NO print width/height, material,
printer, layers, labels, weeding, boxes, or application — Spektra delivers
finished pouches. Included spec (from the record's Vendor Cost Book add-ons,
$0 verified, never re-charged): Silver PET; five colors incl. one white;
soft-touch lamination; child-resistant zipper; tear notches; 2-inch gusset.
Cost = vendor tier cost (range-based highest-reached tier: 1000-2499 /
2500-4999 / 5000-7499 / 7500+; never interpolated) + GSO art/design
$8.3333/design (NO in-house print setup — outsourced production) + $85 flat
Spektra freight per PURCHASE ORDER (one line, verified, inside the cost and
margin basis; never per design/size/line; actual entered freight replaces it).
Automatic tiers: 1000/2500/5000/7500 + requested qty on the researched
dtp-pouches curve (65/58/52/46/42, min 42; 40% global floor). Snapshot engine
15C-spektra-dtp; save re-fetches records and recomputes. Add a new DTP size
with ZERO code: create the Spektra VendorProduct + tiers + add-ons in the
Vendor Cost Book and it classifies into the picker automatically.

### 15C.1 — DTP margin is QUANTITY-based (owner-authoritative thresholds)
The generic row-count curve mapping is NOT used for DTP (four vendor rows
would wrongly drop the 52% point). dtpMarginPctForQuantity() maps quantity to
the researched dtp-pouches curve:
  1,000-2,499 -> 65% | 2,500-4,999 -> 58% | 5,000-7,499 -> 52%
  7,500-9,999 -> 46% | 10,000+ -> 42%
Requested quantities use the same rule (3,000 -> 58%, 6,000 -> 52%, 8,000 ->
46%). Above 7,500 the VENDOR unit cost stays on the highest reached Spektra
tier while the customer margin follows these thresholds independently. 42%
family minimum and 40% global floor preserved. Both tier pipelines (calculate
and save) use the one shared function; owner per-tier margin edits in Advanced
still override with the same floor gates. No other family changed.
