# Decisions for James

> **UPDATE 2026-11-20 (evening) — two sections below now describe the past:**
> - **Section 1 (Stock Bag checklist):** the proposed nine-step Stock Bag checklist is now what a
>   Stock-Bag-only order gets (new jobs only). The one open question is unchanged: **should a proof
>   step be required when the customer uploads a logo or QR?** Today there is none.
> - **Section 4 (Mimaki white):** your rule "Mimaki white is not re-approved" is now enforced
>   everywhere. White + Mimaki is refused or held with the reason; white with no printer chosen goes
>   to the Roland. Gloss / clear on the Mimaki is unchanged. Approving Mimaki white later is still
>   your decision (options B / C in section 4).

**Date:** 2026-11-20. **Nothing was changed** to write this: no code, no price, no timing, no setting.
Every "current" statement was checked in the code; the file and line are in the *Evidence* line under each section.
Jar and bag application timings are frozen. Wherever one appears below it is the value in force today, labelled **PENDING REAL SHOP TIMING VALIDATION**. No new timing is proposed anywhere.

---

## 1. STOCK BAG CHECKLIST

**Decision: approve a Stock Bag checklist, so a paid Stock Bag order stops getting the generic checklist that asks for artwork and a proof it does not have.**

**CURRENT.** A paid order that contains only Stock Bags gets the generic "default" checklist:

1. Artwork received / linked
2. Dieline / size confirmed
3. Proof sent if required
4. Proof approved
5. Material pulled
6. Machine assigned
7. Print complete
8. Cut / laminate / finish complete
9. QC passed
10. Packed and labeled

It has no "labels applied to bags" step at all. Sticker Bags, jars, DTP pouches and stickers each have their own checklist; Stock Bags were never given one.

**PROPOSED.**

1. Stock design, bag colour, sides and quantity checked against the order
2. Customer logo / QR placed on the design (only if one was uploaded)
3. Blank bags pulled and counted
4. Labels printed
5. Labels cut
6. Weeded (if required)
7. Labels applied to bags
8. QC passed
9. Packed and labeled

**WHY.** A Stock Bag is GSO's own premade artwork on a blank bag. There is no customer artwork to receive and no proof to approve unless the customer uploaded a logo or QR code, so the first four steps of the current list are either skipped or ticked without meaning. The step that matters most, applying the labels, is missing.

**Two things to know before you answer.**
- A checklist is fixed when the job is created. Step 2 would appear on every Stock Bag job and be skipped when nothing was uploaded, the same way "Weeded (if required)" works today.
- In the manual New Job form, the choice labelled "Stock Bags" currently gives the Sticker Bag checklist (which also starts with "Artwork received" and "Proof approved"). If you approve the list above, say whether manual Stock Bag jobs should use it too.

**What to say:** "Approve as written", or send your edits to the nine steps. Also answer: when a logo or QR is uploaded, do you want a "Proof approved by customer" step, yes or no?

*Evidence:* `app/lib/production-job-source.server.ts:1013-1029` (order lines are sorted into jar / DTP / sticker bag / sticker / other; no Stock Bag case), `:1031-1043` (anything else gets "default"), `:340-351` (the default steps), `:274-283` (the Sticker Bag steps), `:369-371`, `:380` (manual form label). Stock Bag definition: `app/lib/product-production-spec.ts:170`, `app/lib/product-family-sales-rules.ts:55-73`, `app/lib/bag-cost-inputs.server.ts:262-285`.

---

## 2. BAG AND STICKER PRICE BASIS

**Decision: choose which cost the storefront prices bags and stickers from, and settle the five inputs that make the two costs disagree.**

The full comparison is in `docs/GSO_PRICING_ENGINE_DECISION.md`. This section only explains what drives it, using its audited case:

> **1,000 holographic, 3X gloss, double-sided Sticker Bags.** Live storefront price about **$2,200** (storefront cost $1,318). On the Cost Calculator's cost ($1,707) the same price rules give about **$2,850**. That is about **$650 apart**, and at today's price the job earns about **22%** on the calculator's cost, not the 40% the storefront believes.

Five inputs explain almost all of it. Price effect = what that one input does to the $2,200 if the storefront adopted the calculator's figure (this job is priced at the 40% cost floor, so every $1 of cost moves the price about $1.67). Margin effect = what it does to the margin if the price stays at $2,200.

| # | Component | Storefront uses | Calculator uses | Approved rule, and where it is written | Old / retired rule | Price effect | Margin effect |
|---|---|---|---|---|---|---:|---:|
| 1 | **White ink under holographic** | 1.9 mL per sq ft | 6.0 mL per sq ft at 100% coverage | 6.0 is the approved Roland white calibration (owner plate test 2026-08-18; `docs/GSO_TRUE_COST_CONTRACT.md:366-369`) | 1.9 is the July log median, recorded as superseded (`docs/GSO_ERP_PROJECT_STATE.md:524`). The storefront still uses it. | about +$360 | about -10 points |
| 2 | **Gloss ink, 3X** | 2.83 mL per sq ft per layer | 4.18 mL per sq ft per layer | 4.18 is the approved Roland gloss calibration (same test, same place) | 2.83 is the July log median, recorded as superseded. The storefront still uses it. | about +$255 | about -7 points |
| 3 | **Press time and operator attention** | Roland speed from the machine record at $5/hr; no operator attention | Measured minutes per sq ft per pass at $5/hr, plus operator attention at 10% of press time at $25/hr | $5/hr is OWNER APPROVED 2026-10-07 (`app/lib/owner-standards.ts:130-135`). The 10% attention is "owner-approved provisional", no date (`app/lib/true-cost-engine.server.ts:37-51`) | $8/hr and $25/hr machine rates, both retired | about +$195 | about -5 points |
| 4 | **Application labour (FROZEN)** | 256 labels an hour at $20/hr | Seconds per applied side at $20/hr (the figure in `app/lib/bag-cost-inputs.server.ts:142-150`) | The per-side rule, owner 2026-08-22. **PENDING REAL SHOP TIMING VALIDATION** | 256 labels an hour, marked superseded 2026-08-22 and "legacy calculator only" (`app/lib/owner-standards.ts:45-50`, `:143-147`). The storefront still uses it. | about -$75 | about +2 points |
| 5 | **Cutting and weeding** | $6.53 for every 54 x 54 in cut page | Cutter time from the owner's benchmark at $8/hr plus $2.50/hr attention, plus weeding at $1.33 a page | Benchmark: 130 labels cut in 11.0 minutes, owner measured (`app/lib/finishing-cost.server.ts:151-158`). Weeding: owner standard (`app/lib/weeding-standard.ts:37-56`) | $6.53 a page is the older model, still in use on the storefront | about -$70 | about +2 points |

The rest is small on this job: colour ink (about +$23), label media and gloss mask setup (about -$20 together). The rounded figures add up to a little over $650.

**Stock Bag art setup** does not affect this case (a Sticker Bag carries customer art on both engines), but it is the sixth mismatch: the storefront adds **$8.33** of art setup to every Stock Bag order; your approved rule says a Stock Bag is premade art and carries **$0** (`app/lib/bag-cost-inputs.server.ts:547-565`).

**What the numbers say.** Every increase comes from rows 1 to 3. The two ink figures are approved, but the Roland production audit of 2026-11-11 measured real use at about **2.24** mL for white and **2.05** mL for gloss, roughly a third and a half of the approved figures, and much closer to the storefront's old numbers. The same audit found real press time **slower** than the calculator assumes. Nothing was changed after that audit; it is waiting for you (`docs/GSO_ERP_PROJECT_STATE.md:530`).

### The decisions

1. **Cost basis.** Keep the storefront basis, switch to the calculator basis, or decide after the timing study and the calibration review?
   - Keep: no live price moves.
   - Switch now: plain matte bags do not move; 10 of 48 specialty bag configurations rise by $24 to $1,625 an order; 35 of 72 sticker configurations rise and 20 fall.
   - Later: no live price moves until you decide.
2. **White ink.** Does 6.0 mL per sq ft stand, or do you want it re-measured against the 2026-11-11 audit? And what white coverage should a holographic label be costed at (the comparison assumed 100%; the calculator has no default)?
   - No live price moves either way while the storefront stays on its own basis. After a switch, this one figure is worth about $360 on the example job.
3. **Gloss ink.** Does 4.18 mL per sq ft per layer stand, or re-measure?
   - Same as above; worth about $255 on the example job after a switch.
4. **Press time and operator attention.** Is 10% operator attention at $25/hr final, and should press speed be re-measured (the audit says real runs are slower, which would raise cost further)?
   - No live price moves today. After a switch, about $195 on the example job.
5. **Application labour.** Should the storefront read the per-side rule instead of the retired 256 an hour?
   - **Waits for the timing study.** No change now. If answered yes later, the few floor-priced bag orders drop slightly (about $75 on the example job); plain matte bags do not move.
6. **Stock Bag art setup.** Remove the $8.33 from the storefront's Stock Bag cost, to match your approved rule?
   - Yes: Stock Bag cost falls $8.33 an order. Most Stock Bag prices do not move (they are set by your market targets); the few set by the 40% cost floor fall by about $14 an order.
   - No: nothing moves; the storefront keeps overstating Stock Bag cost.
7. **Cutting.** Keep the $6.53-a-page cutting cost on the storefront, or use the calculator's cutter-time model? And is $8/hr the right rate for cutter time, given presses are approved at $5/hr?
   - Keep: nothing moves. Change: small sticker orders get cheaper, the example job drops about $70.

**Timing.** Decision 5 waits for the timing study. Decisions 2, 3 and 4 wait for a calibration review. Decision 1 is best made after both. Decisions 6 and 7 can be answered now.

*Evidence:* the dollar figures come from `docs/GSO_PRICING_ENGINE_DECISION.md` (per-bag table and headline rows), produced by `tests/pricing-engine-comparison-2026-11-20.test.ts`; they were not re-run here. Storefront inputs: `app/lib/canonical-bag-pricing.server.ts:108-131`, `app/lib/product-driven-costing.server.ts:72-82`, `:156-160`, `:306-317`, `:817-822`, `:842`. Calculator inputs: `tools/seed-machine-profile-calibrations.mjs:42`, `:64`, `:86`, `:108`; `app/lib/finishing-cost.server.ts:38-39`; `app/lib/machine-routing.server.ts:413-416` (white has no default coverage).

---

## 3. PRODUCTION COST RULES — WHAT IS APPROVED AND WHAT IS NOT

**Decision: confirm this table is the true state of your cost rules, then work down the list at the end.**

Status meanings: **OWNER APPROVED** = a decision of yours is recorded. **MEASURED** = comes from a measurement, not a decision. **PROVISIONAL** = in use but explicitly marked not final. **LEGACY** = replaced by a newer rule but still used somewhere. **MISSING** = no rule exists.

| Cost | Current value / rule | Status | Evidence for the status |
|---|---|---|---|
| Art setup | $8.33 per design ($25/hr, 3 designs an hour; cut setup included). Stock Bag base art $0; a logo/QR design counts as one $8.33 | OWNER APPROVED | Owner standards registry, marked owner-verified; no date recorded. Storefront still charges it on plain Stock Bags (section 2, decision 6) |
| Print setup | $1.00 per design ($25/hr, 25 an hour). Jars: once per job | OWNER APPROVED | Owner standards registry; no date recorded |
| Gloss mask setup | $6.25 per gloss design, once, never per layer | OWNER APPROVED | Dated 2026-07-26 |
| Cutting — Cost Calculator, straight cuts on the Mimaki | Cutter time from the benchmark, at $8/hr cutter plus $2.50/hr attention | MEASURED | Owner benchmark: 130 4x5 labels cut in 11.0 minutes. The $8 and $2.50 rates have no dated approval |
| Cutting — Roland cuts, and any contour (jar lid circles, die-cut) | Same method, borrowed rates | PROVISIONAL | Roland piece count was inferred, not confirmed; no contour cutting has ever been timed |
| Cutting — storefront | $6.53 per 54 x 54 in page | LEGACY | Older model; still used by the storefront engine |
| Weeding | $1.33 per 54 x 54 in page ($20/hr, 15 pages an hour) | OWNER APPROVED | Owner-verified, effective 2026-08-19. Your own weeding timing was started 2026-10-05; no results are recorded |
| Jar application — 50, 100 tall, 100 wide, 150, 250 mL, 3 oz, 4 oz (body and lid; band on mL sizes) | Per-size seconds table at $20/hr | OWNER APPROVED | You chose this table as the authority (Aug 2026). No timing study is on record. Frozen 2026-11-19. **PENDING REAL SHOP TIMING VALIDATION** |
| Jar application — MIRON Ceres 50 / 100 mL | Borrowed from the ordinary 50 / 100 mL jars | PROVISIONAL | Marked "not physically timed on a Ceres sample" |
| Jar application — band on 3 oz / 4 oz | None; a quote with that band is blocked | MISSING | No time was ever recorded |
| Jar application — old flat rate | $0.20 per label (100 labels an hour) | LEGACY | Old calculator paths only |
| Bag application — 4x5, Stock Bag, Split Bag | Seconds per applied side at $20/hr | OWNER APPROVED | Owner decision 2026-08-22. **PENDING REAL SHOP TIMING VALIDATION** |
| Bag application — 14x16 | 50 bags an hour single-sided, 30 double-sided, at $20/hr | OWNER APPROVED | Owner final 2026-11-15. **PENDING REAL SHOP TIMING VALIDATION** |
| Bag application — storefront | 256 labels an hour ($0.078 a label); old 14x16 at $1.00 a label | LEGACY | Superseded 2026-08-22; still read by the storefront engine |
| Print labour (operator attention) | 10% of press time at $25/hr. Storefront charges none | PROVISIONAL | Marked "owner-approved provisional"; no date |
| Press time — hourly rate | $5/hr, Roland and Mimaki | OWNER APPROVED | Dated 2026-10-07; replaces $8 and $25 |
| Press time — speed | Mimaki colour 1.444 min per sq ft; Roland colour 0.91, white 1.71, gloss 0.91 | MEASURED | Owner tests 2026-08-18. The 2026-11-11 audit saw slower real runs (about 1.4, 3.6 and 2.2). Not changed |
| Material — 4x5 blank bag | $0.11 each, any colour | OWNER APPROVED | Dated 2026-10-08; replaces $0.09 |
| Material — Split Bag blank | $0.14 each | OWNER APPROVED | Vendor quote, dated 2026-11-12; replaces $0.25 |
| Material — print media | Matte $0.3156 per sq ft, holographic $0.7141 per sq ft | OWNER APPROVED | "Owner-approved roll/ink cost", dated 2026-07-17 |
| Material — jar blanks | Miron price ladders by quantity; Chiron flat ($1.80 / $1.90) | OWNER APPROVED | Dated records for Miron 50 mL, Ceres 50 / 100 mL and Chiron 100 tall / 100 wide / 150 mL. Other Miron sizes carry no dated record in code |
| Ink — price per mL | Mimaki colour and white $0.176; Roland $0.1987; Mimaki clear $0.09 | OWNER APPROVED | 2026-07-17 (Mimaki, Roland); 2026-11-18 (Mimaki clear, landed) |
| Ink — usage, Cost Calculator | Mimaki colour 1.89 mL per sq ft; Roland colour 1.4133, white 6.0, gloss 4.18 | MEASURED | Owner tests 2026-08-18. The 2026-11-11 audit measured white about 2.24 and gloss about 2.05 in real work. Not changed |
| Ink — usage, storefront | Mimaki 0.6; Roland 1.05 / 1.9 / 2.83 | LEGACY | July log medians, recorded as superseded; still used by the storefront |
| Ink — usage, white on the Mimaki | None | MISSING | You signed off 2026-11-11: do not activate a rate from the log evidence |
| Ink — usage, gloss / clear on the Mimaki | None; estimates still cost gloss on the Roland | MISSING | No calibration exists |
| Freight — Miron jar pallet | $315 a pallet, spread over supplier pallet capacity | PROVISIONAL | Marked provisional in code |
| Freight — Chiron / standard jars | $0.089 to $0.16 a jar | PROVISIONAL | Worked out from mixed-shipment invoices; not a carrier rate |
| Freight — MIRON Ceres | None; landed cost stays "pending" | MISSING | Carton and pack data not confirmed by the supplier |
| Freight — 4x5 and 14x16 bag inbound | $0, shown as "not modelled" | MISSING | No freight policy exists |
| Freight — Split Bag inbound | $0.024 a bag ($120 on 5,000) | OWNER APPROVED | Vendor quote, dated 2026-11-12 |
| Freight — DTP pouches / Southwest Cargo | No rule. Freight is typed in per quote. The old $85 a purchase order is marked unverified and is not used | MISSING | Nothing in code |

**Count:** 14 OWNER APPROVED, 3 MEASURED, 5 PROVISIONAL, 4 LEGACY, 6 MISSING (32 rows).

Costs kept only in the database (the 14x16 blank bag, live material records, live calibrations) were not opened for this review. The values above are the ones written in code and in the approved definitions.

**Decisions James still has to make, most important first**

1. White and gloss ink usage on the Roland: do 6.0 and 4.18 stand after the 2026-11-11 audit? (They drive every specialty price increase in section 2.)
2. Which cost basis the storefront prices from (section 2, decision 1).
3. Application times for jars and bags: run the timing study (section 5).
4. Operator attention: is 10% at $25/hr final, or still provisional?
5. Cutter time: is $8/hr correct when presses are approved at $5/hr? And time one contour cut (jar lids) so it stops being borrowed.
6. Inbound freight for 4x5 bags, 14x16 bags, MIRON Ceres and DTP: supply real figures or confirm they stay out of cost.
7. Jar freight: confirm or replace the $315 pallet and the invoice-derived per-jar figures.
8. Weeding: supply the timing you started on 2026-10-05, or confirm 15 pages an hour stands.
9. Mimaki white and Mimaki gloss usage (section 4).

*Evidence:* `app/lib/owner-standards.ts:45-135`, `:141-175`; `app/lib/weeding-standard.ts:37-56`; `app/lib/finishing-cost.server.ts:38-39`, `:151-183`; `app/lib/jar-cost-inputs.server.ts:182-205` (application), `:320-322`, `:363-400` (freight), `:417-420` (Ceres), `:586-597` (blank records); `app/lib/bag-cost-inputs.server.ts:25-50`, `:69-110`, `:142-150`, `:190-212`; `app/lib/product-driven-costing.server.ts:72-82`, `:156-160`; `app/lib/true-cost-engine.server.ts:37-51`; `app/lib/ink-rates-shared.ts:20-25`; `app/lib/approved-cost-updates.server.ts:40-52`; `app/lib/dtp-catalog.ts:61-72`; `app/lib/rip-actual-costs-shared.ts:15-18`; `docs/GSO_TRUE_COST_CONTRACT.md:366-369`; `docs/GSO_ERP_PROJECT_STATE.md:42-48`, `:450`, `:530`.

---

## 4. MIMAKI WHITE

**Decision: say whether white ink is allowed on the Mimaki at all, because the code currently allows it on one path and the written rules disagree with each other.**

### CURRENT BEHAVIOR

**Cost.** Nothing costs white on the Mimaki. Not the storefront, not the Cost Calculator, not the old calculator.
- Storefront: any white, holographic or gloss job is costed on the Roland.
- Cost Calculator, printer set to Mimaki with white: the quote is blocked ("Owner-approved Mimaki White cost calibration, or choose the Roland"). The Roland's white figures are never borrowed.
- Cost Calculator, printer set to Auto with white: it only considers presses that have an approved cost, so it picks the Roland.

**Routing — files arriving through Print Intake.** Safe.
- A white job goes to the Roland. This includes a file whose name ends in `_w`, a filename that says white, and any job whose record says white (including the holographic white underbase).
- White plus gloss goes to the Roland.
- White with the Mimaki explicitly chosen (on the job or in the filename) is **held as a conflict** for a person. It is never sent to the Mimaki.

**Routing — the shared press decision** (manual New Job, the dispatch plan, and the agent status check). **Not safe.**
- Mimaki explicitly chosen on a white job: **accepted**, no warning. The job record says Mimaki.
- No press chosen, white only: it picks **the less busy of the two presses**. When the load figures are complete, that can be the Mimaki. When they are incomplete, it asks the person to choose.
- No press chosen, white plus gloss: Roland.
- This decision reads the job record only. It does not look at `_w` in a filename. A `_w` file on a job whose record does not say white is treated as an ordinary colour job (Mimaki).
- A job that lands on the Mimaki this way is still stopped at Print Intake, because Print Intake sees "white + Mimaki" as a conflict. So the file is not auto-delivered, but the ticket tells the operator Mimaki.

**RIP results.**
- The normal RasterLink result file: both white channels are read, added together and saved as white ink. Actual cost prices it at the Mimaki rate of $0.176 per mL.
- The JobInfo fallback (used when the result file has no ink): reads colour (slots 1 to 4) and clear (slots 136 + 137, priced at the approved $0.09 per mL). **No white slot is read.** White is recorded as 0, and any other slot number is kept as "unknown" and not counted. A Mimaki white job that falls back to JobInfo would show no white ink cost.

**The disagreement in the written rules.** The code and the project notes record an owner correction dated 2026-11-11: "the Mimaki does print White", allowed for routing, blocked for cost until a calibration is approved. The current instruction is that Mimaki white is not approved. Print Intake follows the stricter rule; the shared press decision follows the 2026-11-11 one.

### Does anything route or cost white on the Mimaki without an explicit choice?

- **Cost: no.**
- **Routing: yes, one path.** The shared press decision can assign a white-only job to the Mimaki by load balancing when nobody chose a press. Print Intake will then hold the file, but the job record already says Mimaki.

### OPTIONS

| Option | What it means | Risk |
|---|---|---|
| **A. White on the Roland only** | The shared press decision is tightened to match Print Intake: white always Roland, Mimaki + white is a conflict | More load on the Roland. No cost risk. Needs a small code change you approve |
| **B. Approve Mimaki white for routing only** | White may run on the Mimaki; cost stays blocked | Jobs run with no estimated cost and no margin check. Actual cost can read as zero white when the JobInfo fallback is used. Print Intake would also have to be loosened |
| **C. Approve Mimaki white with a cost calibration** | A controlled plate test on the Mimaki (like the Roland test of 2026-08-18), then you approve the figure | Takes a test and your sign-off. The log evidence so far is 4 usable runs with no coverage data, which you already declined to use. Until the test is done this is option A |

### RECOMMENDATION

**Option A now; option C later if you want the Mimaki's capacity for white.** It matches what Print Intake already does and what you have said, and it removes the one path where a white job can be given to the Mimaki without anyone choosing it. Nothing has been changed. Mimaki white is not switched on, and it should not be switched on without a calibration you approve.

**What to say:** "A", "B" or "C". If A, also say whether a person may still force a white job onto the Mimaki by hand, or whether that should be blocked too.

*Evidence:* shared decision `app/lib/print-intake-routing.server.ts:199-231` (explicit press accepted `:213-218`; white-only load balancing `:228-230`; white + gloss `:227`); Print Intake decision `:333-386` (white + Mimaki conflict `:365`; white requires Roland `:378`); `_w` layer token `:264-273`; white read from the job record only `:294-301`. Manual job: `app/lib/production-job-source.server.ts:461-482`, `:1428`. Dispatch plan and agent check: `app/lib/ops/production-dispatch.server.ts:32`, `app/lib/ops/production-transition-executor.server.ts:70`. Calculator: `app/lib/machine-routing.server.ts:8-23`, `:69-72`, `:140-152`, `:337-347`, `:424-426`; `app/lib/canonical-calculator.server.ts:347-355`, `:1250-1254`. Old calculator: `app/lib/product-driven-costing.server.ts:468-496`. Storefront: `app/lib/canonical-bag-pricing.server.ts:108`. RIP: `app/lib/rasterlink-parse.server.ts:171-192`, `:357-371`; `app/lib/jobinfo-fallback.server.ts:38-42`, `:84-93`, `:386`; `app/lib/rip-actual-costs.server.ts:146-148`; `app/lib/ink-rates-shared.ts:20-25`. Evidence builder (read-only, sets no rate): `app/lib/mimaki-white-evidence.server.ts:1-18`. Notes: `docs/GSO_ERP_PROJECT_STATE.md:444-451`.

---

## 5. WHAT WAITS FOR THE TIMING STUDY

**Decision: none today; hand out the worksheet and send the results back.**

- The worksheet is `docs/GSO_APPLICATION_TIMING_WORKSHEET.md`. Print it and give it to the people who apply labels.
- Until the results come back, every jar and bag application time stays exactly as it is: **PENDING REAL SHOP TIMING VALIDATION**.
- Waiting on it: section 2 decision 5 (which application figure the storefront reads), the jar and bag application rows in section 3, and the missing band time for 3 oz and 4 oz jars.
