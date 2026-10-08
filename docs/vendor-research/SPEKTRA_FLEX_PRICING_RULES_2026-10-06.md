# Spektra / Flex Packaging live pricing rules — 2026-10-06

Research only. Observed in the Cloud Browser on October 6, 2026 (America/Los_Angeles). Source: https://flex-packaging.com/stand-up-bag/. Wholesale discount is the user-supplied 25%; the public calculator did not authenticate or verify account-specific terms. No repository, Shopify, production data, order or payment changes were made.

## Coverage and precision

The CSV contains **1,084 unique directly observed priced rows**, including all 360 base rows (5 sizes × 4 materials × 3 finishes × 6 tiers), all 480 valid Standard/Raised UV rows on Soft Touch/Matte with child-resistant zipper and default features, plus directly observed zipper, feature, SKU and custom-quantity tests. It does not label formula-generated combinations as observed prices.

All amounts are USD. `gso_discount_pct=25` means 25 percentage points. Wholesale total = exact displayed website total × 0.75, without intermediate cent rounding. Wholesale unit = that result ÷ quantity; CSV unit precision is ten decimal places. Fractional cents in wholesale totals are deliberately retained. The displayed website unit price is recorded separately and is never used as the calculation basis. Shipping inclusion is UNVERIFIED, not free or zero.

## Sizes and capacities

| Dimensions, inches (width × height × gusset) | Capacity designation | Catalog mapping |
| --- | --- | --- |
| 3.5 x 4.5 x 2 | 1 g | Standard selectable size |
| 4 x 5 x 2 | 3.5 g | Standard selectable size |
| 5 x 5 x 2 | 7 g | Standard selectable size |
| 6 x 5 x 2 | 14 g | Standard selectable size |
| 8 x 5 x 2 | 28 g | Standard selectable size |


Every standard size uses a 2.0-inch bottom gusset. Site describes dimensions as inches, flat. Capacity designations are site labels, not guaranteed fill-weight performance.

Custom size is also selectable: width 3–8 inches, height 4.5–5 inches, with 0.1-inch input steps and a fixed 2-inch gusset. A typed value alone could leave the mockup and quote stale; using the input spinner/ArrowUp updated the visible custom dimensions. An attempted 5×4 selection became 5×4.5 at the height minimum. Do not use an unchanged quote while typed inputs and mockup dimensions disagree. The continuous custom-size domain was not exhaustively priced; no standard-size mapping is inferred for it.

## Quantity tiers, MOQ and custom quantities

Published tiers: **500; 1,000; 2,500; 5,000; 10,000; 25,000**.

**Ordering MOQ is unresolved.** The page advertises “500 Minimum run” and “Per SKU.” Its quantity helper instead says “min 100.” Typed 50, 100 and 150 all became 250. The minus button from 250 produced 150, then 100, where it disabled. These are calculator behaviors, not confirmation that the vendor accepts a 100- or 250-unit order.

Typed custom quantities 550, 999, 1,100, 1,200 and 7,500 were priced at the entered quantities, rather than rounded to one of the six published tiers. Values do not establish a simple tier-interpolation formula; the site also displays differing printed overrun quantities. Typed 25,100 clamped to 25,000, but the plus button then allowed 26,000. The button step helper changed from 100 at small quantities to 1,000 at 25,000; exact transition thresholds were not exhaustively tested. Typing does not enforce 100-unit multiples.

| Entered/operation | Actual quantity | Website total | Displayed unit |
| --- | --- | --- | --- |
| 50 | 250 | $860.52 | $3.44 |
| 100 | 250 | $860.52 | $3.44 |
| 150 | 250 | $860.52 | $3.44 |
| 550 | 550 | $911.39 | $1.66 |
| 999 | 999 | $982.02 | $0.98 |
| 1100 | 1100 | $996.48 | $0.91 |
| 1200 | 1200 | $1,010.84 | $0.84 |
| 7500 | 7500 | $2,054.13 | $0.27 |
| 25100 | 25000 | $5,019.27 | $0.20 |
| Minus button | 100 | $834.71 | $8.35 |
| Plus from 25,000 | 26000 | $5,139.73 | $0.20 |


These tests used 4×5×2, White PET, Glossy, no spot, child-resistant zipper, No Tear Notch, 1 SKU.

## Materials, finishes and compatibility

Materials: White PET, Silver PET, Hologram, Clear PET. Finishes: Soft Touch, Matte, Glossy. Spot Gloss: None, Standard, Raised UV. Zippers: None, 10 mm, Child resistant. Top-feature control is mutually exclusive: No Tear Notch, Punch Hole, Sombrero. Clear Gusset is a separate toggle and can coexist with a top feature; it also remained selectable with Clear PET.

Glossy disables Standard and Raised UV and resets an active spot selection to None. Exact site message: “Spot gloss can’t go over a glossy laminate — choose Soft Touch or Matte to unlock it.” Soft Touch and Matte both support either spot option. Selecting Sombrero replaces Punch Hole; those are not simultaneous additions. No other disabled/incompatible selections were observed in tested combinations.

## Base wholesale unit ladders

Base for these tables: White PET, no spot, child-resistant zipper, No Tear Notch, Clear Gusset off, 1 SKU. Soft Touch is the initial website finish; Glossy is the lowest-priced finish. Tables show six decimals, while the CSV retains more precision.

### Soft Touch

| Size / capacity | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 / 1 g | $1.369650 | $0.747968 | $0.368163 | $0.241114 | $0.195982 | $0.159110 |
| 4 x 5 x 2 / 3.5 g | $1.394700 | $0.767362 | $0.383280 | $0.254793 | $0.211286 | $0.174687 |
| 5 x 5 x 2 / 7 g | $1.449195 | $0.809625 | $0.416286 | $0.284631 | $0.244684 | $0.207716 |
| 6 x 5 x 2 / 14 g | $1.499955 | $0.848948 | $0.446988 | $0.315357 | $0.275754 | $0.239143 |
| 8 x 5 x 2 / 28 g | $1.618515 | $0.940838 | $0.518730 | $0.381188 | $0.350652 | $0.313086 |


### Matte

| Size / capacity | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 / 1 g | $1.371990 | $0.749782 | $0.369576 | $0.242392 | $0.197420 | $0.160528 |
| 4 x 5 x 2 / 3.5 g | $1.397355 | $0.769418 | $0.384882 | $0.256242 | $0.212914 | $0.176300 |
| 5 x 5 x 2 / 7 g | $1.452480 | $0.812160 | $0.418266 | $0.286420 | $0.246696 | $0.209708 |
| 6 x 5 x 2 / 14 g | $1.503855 | $0.851970 | $0.449346 | $0.317518 | $0.278149 | $0.241522 |
| 8 x 5 x 2 / 28 g | $1.623675 | $0.944828 | $0.521838 | $0.384039 | $0.353837 | $0.316246 |


### Glossy

| Size / capacity | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 / 1 g | $1.334640 | $0.720832 | $0.347013 | $0.222003 | $0.174490 | $0.137904 |
| 4 x 5 x 2 / 3.5 g | $1.355025 | $0.736612 | $0.359313 | $0.233136 | $0.186929 | $0.150578 |
| 5 x 5 x 2 / 7 g | $1.400190 | $0.771645 | $0.386685 | $0.257883 | $0.214603 | $0.177939 |
| 6 x 5 x 2 / 14 g | $1.441620 | $0.803745 | $0.411756 | $0.283042 | $0.239946 | $0.203582 |
| 8 x 5 x 2 / 28 g | $1.541520 | $0.881168 | $0.472224 | $0.338536 | $0.303024 | $0.265846 |


## Material and finish premiums

Premiums vary by size and quantity; no single percentage or flat per-bag premium reproduces them. Use the directly observed full matrix for exact totals. The following are public order-total premiums; multiply by 0.75 for GSO wholesale premiums, then divide by quantity for unit premiums. White PET is lowest, followed by Silver PET, Hologram and Clear PET in the observed base matrix. Glossy is lowest, then Soft Touch, then Matte.

| Size | Change from White PET / Glossy | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 | Silver PET | $4.96 | $7.70 | $14.99 | $27.10 | $60.94 | $150.33 |
| 3.5 x 4.5 x 2 | Hologram | $12.40 | $19.22 | $37.46 | $67.70 | $152.25 | $375.56 |
| 3.5 x 4.5 x 2 | Clear PET | $12.94 | $20.06 | $39.08 | $70.63 | $158.86 | $391.85 |
| 3.5 x 4.5 x 2 | Soft Touch finish | $23.34 | $36.18 | $70.50 | $127.41 | $286.56 | $706.85 |
| 3.5 x 4.5 x 2 | Matte finish | $24.90 | $38.60 | $75.21 | $135.93 | $305.73 | $754.13 |
| 4 x 5 x 2 | Silver PET | $5.45 | $8.44 | $16.46 | $29.75 | $66.91 | $165.57 |
| 4 x 5 x 2 | Hologram | $13.88 | $21.51 | $41.91 | $75.75 | $170.38 | $421.63 |
| 4 x 5 x 2 | Clear PET | $14.31 | $22.18 | $43.22 | $78.12 | $175.70 | $434.79 |
| 4 x 5 x 2 | Soft Touch finish | $26.45 | $41.00 | $79.89 | $144.38 | $324.75 | $803.63 |
| 4 x 5 x 2 | Matte finish | $28.22 | $43.74 | $85.23 | $154.04 | $346.47 | $857.39 |
| 5 x 5 x 2 | Silver PET | $7.18 | $11.12 | $21.68 | $39.19 | $88.14 | $218.12 |
| 5 x 5 x 2 | Hologram | $17.59 | $27.26 | $53.12 | $96.01 | $215.93 | $534.38 |
| 5 x 5 x 2 | Clear PET | $18.58 | $28.78 | $56.09 | $101.38 | $228.01 | $564.27 |
| 5 x 5 x 2 | Soft Touch finish | $32.67 | $50.64 | $98.67 | $178.32 | $401.08 | $992.57 |
| 5 x 5 x 2 | Matte finish | $34.86 | $54.02 | $105.27 | $190.25 | $427.91 | $1,058.96 |
| 6 x 5 x 2 | Silver PET | $8.28 | $12.82 | $24.99 | $45.84 | $101.60 | $252.26 |
| 6 x 5 x 2 | Hologram | $20.67 | $32.03 | $62.41 | $114.49 | $253.73 | $629.95 |
| 6 x 5 x 2 | Clear PET | $21.57 | $33.43 | $65.13 | $119.48 | $264.79 | $657.43 |
| 6 x 5 x 2 | Soft Touch finish | $38.89 | $60.27 | $117.44 | $215.43 | $477.44 | $1,185.36 |
| 6 x 5 x 2 | Matte finish | $41.49 | $64.30 | $125.30 | $229.84 | $509.37 | $1,264.65 |
| 8 x 5 x 2 | Silver PET | $13.32 | $20.65 | $40.22 | $73.78 | $164.77 | $408.58 |
| 8 x 5 x 2 | Hologram | $29.68 | $45.99 | $89.62 | $164.38 | $367.11 | $910.31 |
| 8 x 5 x 2 | Clear PET | $33.26 | $51.55 | $100.44 | $184.23 | $411.47 | $1,020.29 |
| 8 x 5 x 2 | Soft Touch finish | $51.33 | $79.56 | $155.02 | $284.34 | $635.04 | $1,574.66 |
| 8 x 5 x 2 | Matte finish | $54.77 | $84.88 | $165.38 | $303.35 | $677.51 | $1,679.99 |


## Spot Gloss premiums

Exact observed premiums below are relative to White PET / Matte / no spot / child-resistant zipper / No Tear Notch at the same size and quantity. The CSV separately contains every material and both compatible finishes with Standard and Raised UV, so an additive estimate is unnecessary for those combinations.

| Size | Spot option | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 | Standard | $270.00 | $335.98 | $512.39 | $804.95 | $1,623.11 | $3,783.55 |
| 3.5 x 4.5 x 2 | Raised UV | $360.00 | $447.98 | $683.18 | $1,073.26 | $2,164.14 | $5,044.73 |
| 4 x 5 x 2 | Standard | $270.00 | $335.98 | $512.39 | $804.95 | $1,623.10 | $3,795.47 |
| 4 x 5 x 2 | Raised UV | $360.00 | $447.98 | $683.18 | $1,073.26 | $2,164.14 | $5,060.63 |
| 5 x 5 x 2 | Standard | $270.00 | $335.99 | $512.38 | $804.95 | $1,623.11 | $3,795.47 |
| 5 x 5 x 2 | Raised UV | $360.00 | $447.98 | $683.18 | $1,073.26 | $2,164.14 | $5,060.63 |
| 6 x 5 x 2 | Standard | $270.00 | $335.99 | $512.39 | $814.71 | $1,623.11 | $3,807.39 |
| 6 x 5 x 2 | Raised UV | $360.00 | $447.98 | $683.18 | $1,086.28 | $2,164.14 | $5,076.52 |
| 8 x 5 x 2 | Standard | $270.00 | $335.98 | $512.39 | $814.72 | $1,634.59 | $3,831.23 |
| 8 x 5 x 2 | Raised UV | $360.00 | $447.98 | $683.18 | $1,086.29 | $2,179.46 | $5,108.30 |


Raised UV incremental cost over no spot is approximately 4/3 of the Standard increment at the same size/quantity, within displayed-cent rounding in tested rows. This is an observed relationship, not an exact universal formula. Do not round intermediate premiums and claim exact website totals.

## Zipper and feature premiums

The page says a zipper carries $75 setup and Punch Hole/Sombrero carry $25 setup. Those are not the full option premiums: variable charges also increase the total. Both 10 mm and Child resistant had identical prices across 2 sizes × 6 tiers on White PET/Matte and Silver PET/Glossy. Punch Hole and Sombrero also matched on those same tests. Clear Gusset increased price even on Clear PET; it is not automatically free on clear film.

| Size | Change from CR / No Tear Notch / gusset off | 500 | 1,000 | 2,500 | 5,000 | 10,000 | 25,000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.5 x 4.5 x 2 | Remove zipper | $-95.14 | $-106.21 | $-135.82 | $-184.92 | $-322.25 | $-684.86 |
| 3.5 x 4.5 x 2 | Punch Hole (Sombrero equivalent in tests) | $41.00 | $49.80 | $73.32 | $112.33 | $221.42 | $509.47 |
| 3.5 x 4.5 x 2 | Add Clear Gusset | $212.00 | $218.59 | $236.23 | $265.48 | $347.27 | $563.24 |
| 4 x 5 x 2 | Remove zipper | $-97.82 | $-110.37 | $-143.92 | $-199.57 | $-355.19 | $-768.37 |
| 4 x 5 x 2 | Punch Hole (Sombrero equivalent in tests) | $41.00 | $49.80 | $73.32 | $112.33 | $221.41 | $511.06 |
| 4 x 5 x 2 | Add Clear Gusset | $213.60 | $221.07 | $241.05 | $274.20 | $366.88 | $612.98 |
| 5 x 5 x 2 | Remove zipper | $-103.19 | $-118.69 | $-160.13 | $-228.85 | $-421.05 | $-931.38 |
| 5 x 5 x 2 | Punch Hole (Sombrero equivalent in tests) | $41.00 | $49.80 | $73.31 | $112.33 | $221.42 | $511.06 |
| 5 x 5 x 2 | Add Clear Gusset | $216.79 | $226.03 | $250.70 | $291.64 | $406.12 | $710.07 |
| 6 x 5 x 2 | Remove zipper | $-108.55 | $-127.00 | $-176.33 | $-260.87 | $-486.92 | $-1,097.71 |
| 6 x 5 x 2 | Punch Hole (Sombrero equivalent in tests) | $41.00 | $49.80 | $73.32 | $113.63 | $221.41 | $512.66 |
| 6 x 5 x 2 | Add Clear Gusset | $219.99 | $230.98 | $260.36 | $310.71 | $445.35 | $809.16 |
| 8 x 5 x 2 | Remove zipper | $-119.29 | $-143.64 | $-208.74 | $-320.32 | $-622.90 | $-1,433.60 |
| 8 x 5 x 2 | Punch Hole (Sombrero equivalent in tests) | $41.00 | $49.80 | $73.32 | $113.63 | $222.95 | $515.83 |
| 8 x 5 x 2 | Add Clear Gusset | $226.38 | $240.88 | $279.66 | $346.12 | $526.35 | $1,009.21 |


## Additive rule and validation scope

For 1 SKU and published quantities, use the exact material/finish/spot total in the CSV, then apply size-and-quantity-specific zipper and feature deltas from the tables. Switching CR to 10 mm has zero observed delta. Punch Hole and Sombrero are equivalent alternatives, not two charges. Add $185 × (SKU count − 1) for additional designs. Multiply the resulting public total by 0.75 once.

The add-on arithmetic was tested independently on 4×5×2 and 8×5×2 at all six published quantities, across White PET/Matte and Silver PET/Glossy. Combined no-zipper + Sombrero + Clear Gusset was also tested on Hologram/Soft Touch at both sizes and all six tiers. Differences of a cent can occur when adding/subtracting already rounded website totals. These rules are suitable for review/estimation, but an unobserved combination is NOT an exact vendor quote. Request a fresh quote for cent-exact combined options. No unobserved calculated totals have been put in the live CSV.

## SKU / design behavior

For 1, 2, 5 and 10 SKUs, public total = corresponding 1-SKU total + $185 × (SKU count − 1). This held exactly for 4×5×2 and 8×5×2, White PET/Glossy/CR, at all six tiers. GSO extra cost = $138.75 per additional SKU. The quoted tier continues to use total order quantity; it does not reprice each divided SKU at its own smaller tier. The UI displays quantity divided by SKU count: e.g., 500/2 = “250 each” and 100/10 = “10 each.” The advertised 500-per-SKU minimum is not enforced by this calculator. Actual artwork proofing and vendor minimums require confirmation. No art files were uploaded.

| Size | SKUs | 500 total units | 2,500 total units | 10,000 total units |
| --- | --- | --- | --- | --- |
| 4 x 5 x 2 | 1 | $903.35 | $1,197.71 | $2,492.39 |
| 4 x 5 x 2 | 2 | $1,088.35 | $1,382.71 | $2,677.39 |
| 4 x 5 x 2 | 5 | $1,643.35 | $1,937.71 | $3,232.39 |
| 4 x 5 x 2 | 10 | $2,568.35 | $2,862.71 | $4,157.39 |
| 8 x 5 x 2 | 1 | $1,027.68 | $1,574.08 | $4,040.32 |
| 8 x 5 x 2 | 2 | $1,212.68 | $1,759.08 | $4,225.32 |
| 8 x 5 x 2 | 5 | $1,767.68 | $2,314.08 | $4,780.32 |
| 8 x 5 x 2 | 10 | $2,692.68 | $3,239.08 | $5,705.32 |


## Setup, overrun and operational notes

The site states every displayed price includes setup, pre-press, plate and run charges. Do not add those again. At 4×5×2 White PET/Glossy/CR, 500 delivered units showed 1,000 printed and $787.28 of setup/pre-press/plate charges within the $903.35 total. At 7,500 delivered units, it showed 8,650 printed. Discount calculations use delivered quantity, not the printed overrun. Standard production is advertised as 7–10 business days from art approval.

## Shipping, freight, pickup and tax

The configurator has no separate shipping, freight, pickup or tax quote. The public cart at https://flex-packaging.com/cart/ says “Great things are on the horizon” and “Something big is brewing! Our store is in the works and will be launching soon!” No functional cart cost breakdown was available. **SHIPPING NOT PUBLICLY RESOLVABLE BEFORE CHECKOUT** — specifically, the cart itself is a launch placeholder. No address, payment or order was submitted. Tax and pickup are also unresolved. Keep product price and freight separate. The historical $85 assumption is NOT verified and is excluded from all CSV costs.

## Shaped, die-cut, flat and other formats

The home page and pouch menu were inspected. https://flex-packaging.com/pouches/ lists Stand Up Bag with the live calculator. Flat Bag is explicitly “COMING SOON,” described as “Lay-flat pouch, no gusset, simple and economical.” Die Cut Bag is explicitly “COMING SOON,” described as “Custom-shaped pouch cut to a unique outline.” Both cards also display “Get a Quote” but did not expose an active calculator link. No die-cut or flat-bag prices were published there. A separate 3-side-seal format was not identified. The homepage advertises roll stock/film, but its link opens https://flex-packaging.com/products/, which contained only a products heading and standard navigation/footer, with no pricing calculator.

## Quality control and unresolved coverage

Thirty selected-tier checks revisited five configurations, one at every standard size, including non-white films and active Standard/Raised UV. All selected order totals and displayed unit prices matched the captured price-break cards. All 24 supplied old-observed 4×5 public totals matched current live totals. All CSV wholesale calculations were independently checked as total − total/4 as well as total × 0.75. Size, material, finish, active spot selection, zipper and feature state were captured alongside every price ladder.

Not exhaustively priced: the continuous custom-size domain; arbitrary custom quantities; every cross-product of zipper/feature/spot/material combinations; SKU interactions beyond the tested 1/2/5/10 cases; checkout-level pricing; shipping, pickup and tax; unavailable flat/die-cut formats. The full requested standard-size base matrix and full compatible spot matrix ARE directly observed. Add-on rules are scoped above and include rounding limits. Vendor confirmation is needed for actual MOQ, maximum quantity, custom dimensions, account discount and freight before operational ERP adoption.
