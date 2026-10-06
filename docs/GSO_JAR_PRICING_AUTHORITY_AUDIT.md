# GSO Jar Pricing Authority Audit (2026-10-05 overnight)

Purpose: reconstruct what the repository actually knows about premium-jar (Miron / Chiron) and standard-jar CUSTOMER pricing, explain how the live 65 / 58 / 52 / 47 / 45 % Miron margin ladder entered the code, and record the correction made tonight. True manufacturing cost was not changed anywhere. Every statement below cites a repo file; items the owner remembered but that are not in the repo are marked NOT FOUND.

## 1. What the owner asked to verify, and what the repo holds

| Lead | Repo evidence | Verdict |
|---|---|---|
| A. 100ml Wide Miron target schedule 100 -> $5.80, 128 -> $5.75, 250 -> $5.64, 500 -> $5.10, 640 -> $5.08, 1000 -> $4.97 | No file contains this ladder. The individual numbers appear only in unrelated places (Roland machine-log columns; 150ml holographic finish rows). | NOT FOUND |
| B. Beastcoast research (100ml $3.50 all tiers; spot gloss +$0.25; embossed +$0.50; holographic +20%; 150ml $6.00 / $5.85 / $5.70) | Zero hits for "Beastcoast" in the tree and in all git history. Holographic +20% and a specialty ladder DO exist, as the OWNER rule in `canonical-jar-pricing.ts` (16D), not as competitor data. | NOT FOUND (competitor); +20% holo exists as owner rule |
| C. 100ml framework Retail $5.99 / Core $5.10 / Big Client $4.50 | No "retail", "core", "big client" tiers anywhere. | NOT FOUND |
| D. Historical paid order 100ml Tall Miron x128 at $4.85 = $620.80 | $4.85 at 128 is the GSO jar pricing SHEET price (`tools/seed-jar-base-sell-tiers.mjs` lines 12-13: 128-249 -> 4.85, 250 -> 4.15, 500 -> 3.85, 1000 -> 3.75, 2500 -> 3.50). A matching row exists only as a hand-built unit-test fixture (`tests/pricing-intelligence.test.ts:479-486`, shop "shop", customer "C"); the literal 620.80 appears nowhere. The owner declared all pre-launch sales TEST data (`docs/GSO_ERP_PRICING_OWNER_DECISIONS.md:132-142`). | Price-sheet target CONFIRMED; real-order evidence NOT ADMISSIBLE |

No competitor jar price point exists in the repository. The only competitor document (`docs/GSO_ERP_COMPETITOR_MARGIN_STUDY.md`, 2026-07-25) covers sticker bags and labels and states the manual jar quote capture was never performed.

## 2. Jar price authorities that DO exist

| Authority | Status | Where | 100ml values |
|---|---|---|---|
| **16D owner launch ladder** (2026-08-12) | OWNER-APPROVED, "market-driven by owner decision and must never be regenerated from margins, costs, legacy jar rule tables, Pricing Intelligence, or competitor data"; live on the storefront | `app/lib/canonical-jar-pricing.ts` `JAR_BASE_PRICES`; `docs/GSO_JAR_16D_LAUNCH_RUNBOOK.md`; commit 73f46e3 | 50 -> $4.95, 100 -> $4.50, 250 -> $4.00, 500 -> $3.75, 1000 -> $3.50, 2500 -> $3.35 (tall and wide share one table); holographic +20% of base; specialty 1X +$0.30 ... 8X +$1.75; 9X+ and 5,000+ = quote; MOQ 50; application included |
| GSO jar pricing SHEET seed (pre-launch) | Seeded reference, superseded by 16D | `tools/seed-jar-base-sell-tiers.mjs`, `tools/seed-jar-finish-pricing-rules.mjs` | Tall 128 -> $4.85, 250 -> $4.15, 500 -> $3.85, 1000 -> $3.75, 2500 -> $3.50; Wide 128 -> $5.00, 250 -> $4.30, 500 -> $3.95, 1000 -> $3.85, 2500 -> $3.55 |
| Miron margin curve 65/58/52/47/45 (min 45), Chiron 60/55/50/45/40 (min 40) | Labelled "researched, owner-approved" but see section 3 | `app/lib/calculator-emergency.server.ts` `FAMILY_MARGIN_RULES`; bands 1/128/256/640/1000 via `defaultMarginCurvesValues` | price = cost / (1 - margin) |
| Minimum gross profit premium jars $100, standard jars $75; no jar minimum order total; no unit-price floor | Owner decision 2026-07-25 | `commercial-pricing-policy.server.ts` `FAMILY_COMMERCIAL_POLICIES`; `GSO_ERP_PRICING_OWNER_DECISIONS.md:12-13` | |
| Global 40% margin floor + "OWNER MARGIN OVERRIDE" gate | Owner decision 14B.0A | `calculator-emergency.server.ts` `MARGIN_FLOOR_PCT`, `checkMarginGate` | |

## 3. How 65 / 58 / 52 / 47 / 45 entered the code

- Commit `d9e2c8b` (2026-07-24, "Add researched family-specific margin curves with family minimums") added all nine curves at once, each tagged `Source: GSO 2026 competitor and margin study (owner-approved)`.
- That source document does not exist in the repository. The study document written the next day (2026-07-25) has no jar data and says owner-truth margins cluster 58-68% at top quantities, i.e. it does not support the 45-47% top tiers either.
- 2026-07-26 (15F.0K.2-B/K.3): bags were recalibrated to the competitor study; jar tables were explicitly DEFERRED and market targets were validator-rejected for jars. The jar curve was translated 1:1 into quantity bands 1/128/256/640/1000 and never revisited.
- 2026-08-12 (16D): the owner approved the launch ladder for the storefront, bypassing margins entirely. The ERP calculator kept the curve.
- Conclusion: the Miron curve is a FAMILY DEFAULT translated from an unsourced table, not an approved jar-specific commercial study. The 128 band edge (not the 16D break at 100 or 250) produced the cliff: 127 jars at 65% = $9.61 each ($1,220); 128 jars at 58% = $8.00 each ($1,024).

## 4. The correction made tonight (customer pricing only)

Implemented in `app/lib/jar-commercial-pricing.ts`, `commercial-pricing-policy.server.ts` (`ownerLadder` input), and the Cost Calculator loader/save paths:

1. For every jar with a 16D ladder (Miron 50ml/100ml Tall/100ml Wide/150ml/250ml; standard 3oz/4oz), the commercial candidate is the OWNER LADDER PRICE (base + holographic +20% of base + specialty adder, exactly as the storefront computes it). The margin curve is not consulted.
2. The existing MINIMUM MARGIN PROTECTION stays: family minimum (Miron 45%, standard 40%), never below the 40% global floor; plus the owner minimum-profit candidate. Price = max(ladder, cost / (1 - floor), cost + min profit).
3. A QUANTITY-BREAK ENVELOPE: a customer never pays more in total than they would by ordering the next price break. The envelope never caps below the margin floor; where the Miron blank-set cost drops at a vendor tier (production quantity reaches 250 / 500 / 1000 with the 1% overage, i.e. requested 247 / 495 / 990) the row is held at the floor and staff are told the larger order is cheaper.
4. Chiron has no owner ladder: it keeps the 60/55/50/45/40 curve, with the envelope removing its 128/256/640/1000 cliffs.
5. Historical quotes are untouched (snapshot JSON is never rewritten; `resolveMarginPctForQuantity` still returns the old band values so old snapshots stay explainable).

### 100ml Tall Miron, Side + Lid, Poseidon Matte, AUTO, CMYK — before and after

| qty | true job cost | true unit cost | owner ladder | BEFORE (curve) | AFTER (ladder + 45% floor) | realized margin | controlling rule |
|---|---|---|---|---|---|---|---|
| 127 | $427.02 | $3.3624 | $4.50 | $9.61 / $1,220.05 | **$6.11 / $776.40** | 45.0% | Minimum margin protection — 45% family minimum |
| 128 | $430.09 | $3.3600 | $4.50 | $8.00 / $1,024.01 | **$6.11 / $781.97** | 45.0% | same |
| 129 | $433.15 | $3.3578 | $4.50 | $8.00 | $6.11 / $787.55 | 45.0% | same |
| 250 | $762.23 | $3.0489 | $4.00 | $6.35 | $5.54 / $1,385.87 | 45.0% | same |
| 500 | $1,391.07 | $2.7821 | $3.75 | $5.80 | $5.06 / $2,529.21 | 45.0% | same |
| 1000 | $2,599.77 | $2.5998 | $3.50 | $4.73 | $4.73 / $4,726.85 | 45.0% | same |

(Full integer walk 50..1000 and the audit table: `tests/pricing-policy-sanity-2026-10-05.test.ts` -> `docs/generated/jar-pricing-sanity-100ml-tall-miron-2026-10-05.md`.)

The cliff is eliminated: totals are non-decreasing in quantity except at the three vendor cost tiers where the floor binds and the larger order is explicitly offered.

## 5. The owner decision this exposes

At today's true costs the owner's own 16D ladder is BELOW the ERP margin floor at every Miron tier (128 jars: $4.50 ladder = 25% margin on $3.36 cost; 1000 jars: $3.50 ladder = 26%). The calculator therefore quotes the 45% floor price ($6.11 at 128) and shows an amber "OWNER CONFIRMATION PENDING" note with the ladder price, the floor, and the gap. The owner must choose one of:

- (a) adopt a jar-specific minimum margin below 45% (e.g. the 40% global floor gives $5.60 at 128; honouring the $4.50 ladder exactly needs a ~25% jar floor), or
- (b) revise the 16D ladder upward, or
- (c) keep the ERP floor at 45% and accept that ERP quotes sit above the storefront price.

Nothing was invented to resolve this; it is listed in `docs/GSO_ERP_FINAL_OWNER_CHECKLIST.md`.

## 6. Competitor comparison

None possible from repo evidence (no jar competitor data). The pre-launch GSO price sheet ($4.85 at 128 for 100ml Tall) and the 16D ladder ($4.50 at 100-249) are both GSO-internal targets; both sit below the current ERP floor price.
