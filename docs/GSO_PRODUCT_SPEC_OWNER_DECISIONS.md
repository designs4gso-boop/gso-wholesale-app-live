# GSO Product Spec — Owner Decisions Pending (2026-10-05)

Only unresolved items. Each row shows what the system does TODAY while the item is open. Nothing here was changed on the owner's behalf.

**Authority rule in force (release gate 2026-10-05):** every jar label dimension is CANONICAL_COSTING_PENDING_CONFIRMATION — the cost engine keeps pricing with it (no change), staff see it as "CURRENT CANONICAL COSTING GEOMETRY / PHYSICAL DIMENSIONS NEED OWNER CONFIRMATION" (amber), and every quote snapshot records that status. When the owner confirms a size, the change is: record the confirmation (owner record + date) and flip that size to OWNER_CONFIRMED in a reviewed commit; adjust numbers only if the physical check disagrees, with the regression fixtures re-pinned.

| # | Product / area | Missing value | Current fallback | Risk | Owner needs to provide |
|---|---|---|---|---|---|
| 1 | Weeding standard (all weeded families) | Measured pages/hour and difficulty effect | $20/hr at 15 pages/hr, 54 in page, ceil per run (unchanged) | Under/over-recovery of weeding labor on every job; no complexity sensitivity | WAITING FOR OWNER TIMING DATA: per session — product/geometry, feed inches (pages), pieces, elapsed minutes, difficulty, operator, date (see `GSO_WEEDING_COST_AUDIT.md` section 6) |
| 2 | Miron 50ml label geometry | Physical confirmation of side 5.6 x 1.5, lid Ø 1.6, tamper 5.6 x 0.5 | Patch 2A table (cost authority) | Seed estimates differ (5.75 x 1.625 / Ø 1.75); if the seed is right, media/ink/cut are under-costed ~5-10% | Confirm or correct the three dimensions against a physical jar |
| 3 | Miron 100ml Tall geometry | Confirmation of side 6.3 x 3.15 (seed says 6.125 x 3.125) | Patch 2A table | small media/ink variance | Confirm side width/height |
| 4 | Miron 100ml Wide geometry | Confirmation of side 6.6 x 2.6, lid Ø 1.9 (seed 6.43 x 2.6 / Ø 1.875) | Patch 2A table | small variance | Confirm |
| 5 | Miron 250ml geometry | Confirmation of side 9.4 x 2.9, lid Ø 2.1 (seed 9.375 x 2.875 / Ø 2.0) | Patch 2A table | small variance | Confirm |
| 6 | Standard 3oz geometry | Confirmation of side 6.9 x 1.4, lid Ø 2.1 (seed 7.1 x 1.7 / Ø 2.0) | Patch 2A table | side height differs 1.4 vs 1.7 (21%) | Confirm side height especially |
| 7 | Standard 4oz geometry | Confirmation of side 7.125 x 1.4 (seed 7.125 x 2.125) | Patch 2A table | side height differs 1.4 vs 2.125 (52%) — largest conflict | Confirm side height |
| 8 | Chiron 100ml Tall / 100ml Wide / 150ml geometry | Whether Chiron jars share Miron label dimensions | Shared size key -> Miron dimensions | Wrong label size on Chiron jars if they differ | Confirm "same as Miron" or give Chiron-specific dims (no vendor work requested) |
| 9 | 3oz / 4oz tamper band | Application seconds per band | Band BLOCKS the quote (`MISSING_APPLICATION_STANDARD`) | Cannot quote a tamper band on standard jars | Seconds per band applied, or "not offered" |
| 10 | Jar application "~$0.30 per jar" | What the remembered $0.30 covered (per jar? side+lid? including peel?) | Canonical per-label owner seconds at $20/hr (e.g. Miron 100ml Side+Lid = 22 s = $0.1222/jar); legacy flat $0.20/label exists only in legacy paths | If $0.30/jar reflects real labor, application is under-costed on multi-label jars | Confirm basis of $0.30 and whether per-size seconds should be re-timed |
| 11 | 5oz jar | Entire product (geometry, blank cost, application, box count) | Not offered; `jar_5oz_clear` placeholder hidden; quoting blocks | none today | Decide whether a 5oz product exists; if so, all values |
| 12 | RecipeLabelZone seed rows | Whether to retire/realign the admin rows to the Patch 2A table | Rows stay as reference; Product Setup now shows the cost-engine spec above them read-only | Staff confusion only; no pricing effect | Approve a one-time realignment (tooling exists) or leave as is |
| 13 | Jar cutline | Owner-measured jar cutlines | Derived by the GSO -0.0625 in rule (jobs stay PROVISIONAL with `CUT_PATH_ESTIMATE_REQUIRED`) | Cutting slightly overstated | Measured cutlines per size (unchanged from 2D-4D1) |

Items that are NOT open (for clarity): MOQ 50 for 4x5 bags (approved 2026-10-04); jar 1% planned overage (owner-verified 2D-4D3); setup basis (art per design, print per job); packout per-size boxes; canonical routing (CMYK Mimaki, specialty Roland).
