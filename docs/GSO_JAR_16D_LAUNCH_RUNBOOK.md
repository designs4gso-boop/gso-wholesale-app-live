# 16D Miron Jar Launch — owner activation runbook

Everything is staged and verified server-side. The jar products stay DRAFT
until the theme deploy lands, because the deploy is what closes the legacy
jar native-purchase path (lockout + submit interception now cover jars).

## 1. Deploy the theme extension (required first)
```
shopify app deploy
```
Ships: jar purchase-path lockout (body class + native submit interception
+ CSS), jar field labels (Base Finish / Specialty / Label Material), jar
notice ("Label application is included"). The web app side (pricing engine,
proxy, checkout, order mapping) deploys automatically with the git push via
Render — no action needed there.

## 2. Activate the three launch products
```
node tools/rebuild-jars-16d.mjs --activate
```
Refuses per product unless the canonical shape still verifies (1 variant @
1.00/CONTINUE, tag, type Jars, ERP row variant GID + MOQ 50). Activates:
- 100ml-tall-miron-jars  (jar_100ml_tall)
- 100ml-wide-miron-jars  (jar_100ml_wide)
- 150ml-miron-jars       (jar_150ml)

## 3. Verify (or ask Claude to run the sweep)
- Product page shows the jar configurator (BUILD YOUR JAR), native Add to
  cart hidden, fields: Base Finish (Included) Matte/Gloss, Label Material
  Standard/Holographic, Specialty 0X–8X + 9X+ quote, Quantity min 50.
- Price checks: 150ml @500 = $5.50; + Holographic = $6.60; + Raised — 4X
  = $7.50. 100ml @100 = $4.50. 5,000+ or 9X+ = Request Custom Quote.
- Checkout -> draft order invoice shows the same prices (server-computed).
- Mobile: fields readable, no horizontal scroll, price + Add to Cart
  visible (same block/CSS the live bag fleet already uses on mobile).

## Owner-approved pricing (authority — do not regenerate)
100ml: 50=$4.95 100=$4.50 250=$4.00 500=$3.75 1000=$3.50 2500=$3.35
150ml: 50=$6.50 100=$6.00 250=$5.75 500=$5.50 1000=$5.25 2500=$4.95
Holographic label: +20% of BASE. Specialty: 1X +$0.30, 2X +$0.50, 3X
+$0.70, 4X +$0.90, 5X +$1.10, 6X +$1.30, 7X +$1.50, 8X +$1.75. Matte or
Gloss base finish included. 5,000+ / 9X+ = quote. MOQ 50.

## Held back on purpose
- miron-jars (combined legacy product): REPLACED by the per-size products,
  stays DRAFT permanently (title/media kept for reference).
- 50mml-miron-jars, 250ml-miron-jars, 3oz-jar, 4oz-jar: future sizes —
  add after the first two sizes are production-proven.
