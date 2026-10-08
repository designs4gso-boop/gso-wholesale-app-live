# GSO ERP — Final Owner Checklist (2026-10-05 overnight build)

Only items the owner must decide or measure. Engineering chores are done; nothing here is a bug.

## Decisions

1. **Jar margin floor vs your own price ladder.** Your 16D storefront ladder (100ml: $4.50 at 100-249, $4.00 at 250+, $3.75 at 500+, $3.50 at 1000+) sits below the ERP's 45% Miron minimum margin at every tier (128 jars: $4.50 = 25% margin on $3.36 true cost). The calculator now quotes the 45% floor price ($6.11 at 128, was $8.00) and flags the gap. Choose: (a) a jar-specific floor (40% global floor gives $5.60 at 128; matching $4.50 needs ~25%), (b) raise the ladder, or (c) keep ERP quotes above the storefront. Where to change: `app/lib/calculator-emergency.server.ts` `miron-jars.familyMinPct` or a Pricing Settings curve minimum.
2. **Quantity cliffs in the other families** (not changed tonight): 4x5 sticker bags 99 -> 100 ($212.85 -> $130.00) and 499 -> 500; 3x3 stickers at 128/256/640/1000 ($10-16 drops); 3x6 banners at 128 (-$621). Say "apply the quantity-break envelope to bags / stickers / banners" and it is a one-line change per family with the same safeguards as jars.
3. **The remembered $0.30 per jar application figure**: not in the repo. Canonical is per-label owner seconds (side 12 s, lid 10 s at $20/hr = $0.12 per Side+Lid jar); the legacy $0.20/label is diagnostic only. Confirm whether $0.30 covered something the per-label timing does not.
4. **Chiron jars**: no owner price ladder and no Chiron-specific label geometry (costed on the Miron size key). Provide either, or confirm "same as Miron".
5. **5oz jar**: stays unsupported unless you say it exists (needs geometry, blank cost, application timing, box count).
6. **RecipeLabelZone admin rows** disagree with the costing geometry for most sizes (e.g. 4oz side height 1.4 vs 2.125). Approve a one-time realignment after the physical check below, or leave as reference.

## Measurements

7. **Physical jar label dimensions** for Miron 50ml, 100ml Tall, 100ml Wide, 250ml and Standard 3oz, 4oz (side w x h, lid diameter, tamper band). 150ml side/lid already agree between sources.
8. **Weeding timing**: per session — product, feed inches (pages = 54 in), pieces, elapsed minutes, difficulty, operator, date. Three or more sessions across difficulties. Rate stays $20/hr at 15 pages/hr until you approve a new one.
9. **Circular contour cutter benchmark** (a timed lid-cut job: pieces, diameter, minutes, machine, mode). Until then every jar job with a lid stays PROVISIONAL (CUT_PATH_ESTIMATE_REQUIRED). Note: operator attention (10%) and inbound freight are also owner-approved provisional, so jar jobs stay PROVISIONAL even after the contour benchmark unless those are confirmed too.
10. **3oz / 4oz tamper band application seconds**, or "not offered".

## Already locked (no action)

MOQ 50 for 4x5 bags; jar 1% planned overage; setup basis; packout boxes; printer routing; worker unscheduled with execution OFF; Slack sandbox.
