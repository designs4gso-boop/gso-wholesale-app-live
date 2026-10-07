# Owner decisions before release — 2026-10-07

Only decisions the code cannot make. Everything else is done or listed in `GSO_FINAL_RELEASE_READINESS_2026-10-07.md`. Each answer is a YES / NO or a letter.

## 1. DTP ladders for the remaining sizes — approve the proposals? (see `GSO_DTP_FINAL_PRICING_REVIEW_2026-10-07.md` §4)

- 3.5x4.5x2 $1.35 / $0.70 / $0.45 / $0.36 at 1,000 / 2,500 / 5,000 / 10,000 — **YES / NO / edit**
- 5x5x2 $1.45 / $0.75 / $0.49 / $0.41 — **YES / NO / edit**
- 6x5x2 $1.45 / $0.78 / $0.54 / $0.46 (replaces the July $1.84 / $1.04 / $0.96 / $0.81) — **YES / NO / edit**
- 8x5x2 $1.55 / $0.86 / $0.65 / $0.59 (replaces the July $2.05 / $1.23 / $1.23 / $1.05) — **YES / NO / edit**

Until approved, 6x5x2 / 8x5x2 quote from the July ladders (labelled "owner pricing review pending") and 3.5x4.5x2 / 5x5x2 cannot be quoted automatically.

## 2. 25,000 tier — activate? 

4x5x2 $0.30 (and, with #1, 3.5x4.5x2 $0.29 · 5x5x2 $0.35 · 6x5x2 $0.40 · 8x5x2 $0.52) — **YES / NO / edit**. Until then 25,000+ stays OWNER PRICING REVIEW REQUIRED (blocked, vendor cost shown).

## 3. 1,000-unit acquisition exception for the other sizes

- A. No — normal $500 GP protection everywhere except 4x5x2 (default if unanswered)
- B. Yes, at the listed acquisition prices (3.5x4.5x2 $1.30 · 5x5x2 $1.35 · 6x5x2 $1.40 · 8x5x2 $1.50, GP ≈ $447–466)

## 4. Freight — confirm the Spektra freight basis

- A. Keep the $85 per PO assumption for launch (labelled UNVERIFIED everywhere)
- B. Replace with a confirmed vendor figure: $____ per PO
- C. Make freight a quoted pass-through line (no embedded assumption)

## 5. Legacy 5x4x2

- A. Keep as now: MANUAL / VENDOR REVIEW for new quotes, history untouched (default)
- B. Retire the size (stop offering it)
- C. Approve a mapping to 4x5x2 or 5x5x2 (which: ____) — this changes what a 5x4x2 customer receives

## 6. Durable Die ID registry (shaped bags)

- A. Launch with Die IDs recorded in the quote only (default; no schema change)
- B. Approve a Prisma model + migration for a die registry (post-launch patch)

## 7. Production status discipline (QC / completion)

The staff "Move job to" selector can move a job to any status, including Completed before a QC pass; the transition guard exists but is advisory. Wiring it would make six statuses unreachable until the vocabulary is reconciled.

- A. Launch as-is (staff discipline; QC card now shows disagreement) and reconcile post-launch (default)
- B. Enforce "no Completed without a QC pass" now (SMALL patch; other transitions stay open)

## 8. "Owner-only" controls

No owner identity check exists anywhere in the app; every "owner" control is protected only by admin login + a typed phrase (Margin Review Shopify push, Cost Verification approved updates, Pricing Settings, pilot-data reset).

- A. Launch as-is and keep the typed-phrase gates (default)
- B. Add an owner e-mail allow-list for those pages before release (MEDIUM)

## 9. Mimaki white ink channels

The Mimaki preset installs two ENABLED white channels although routing says the Mimaki never runs white.

- A. Disable the two white channels in the preset (recommended, SMALL)
- B. The Mimaki really does run white — leave them and update the routing policy (OWNER statement needed)

## 10. Machine hourly rate shown in two places

Machines page seed shows $5/hr; pricing uses the owner standard $8/hr (Cost Health and Cost Verification both say so).

- A. $8/hr is correct — update the machine record to $8 (SMALL)
- B. Something else: $____

## 11. Jar sales-rule MOQ text

Sales rules text says "Official MOQ: 128" for jars; the approved jar MOQ in pricing is 50.

- A. Change the text to 50 (SMALL)
- B. 128 is correct for jars — leave it
