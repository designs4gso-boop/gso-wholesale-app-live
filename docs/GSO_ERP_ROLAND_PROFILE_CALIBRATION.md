# GSO ERP — Roland Profile Calibration (15F.0J, 2026-07-25)

## L. Current assumptions vs evidence
Calculator (owner-approved provisional, 15F.0G): CMYK 150 sqft/hr baseline;
Gloss/Emboss 110 and White HD 75 sqft/hr PER SELECTED LAYER, additive;
recovery $8/hr; overprint 1x per selected layer. Basis: RIP profile head
speeds (CMYK 1,354 / Gloss 1,016 / White 677 mm/s @ 720x1200 HQ) scaled to
the 150 baseline — head speed is a RATIO hypothesis, not a measurement.
Unknowns the CSV must answer: whether head-speed ratios predict wall time;
layout-width effect (carriage sweeps full width); feed-length vs area
scaling; coverage sensitivity; overprint count effect (some files ran
White Overprint 3); whether setup/curing time is inside logged elapsed;
small-job fixed time; whether stages are truly additive.

## Measured results — PENDING DATA (CSV not in this environment)
| Group | n | median sqft/hr | weighted | IQR | ml/sqft median | confidence |
|---|---|---|---|---|---|---|
| LG-640 CMYK HQ | PENDING | — | — | — | — | — |
| LG-640 White HD (per layer) | PENDING | — | — | — | — | — |
| LG-640 Gloss/Emboss (per layer) | PENDING | — | — | — | — | — |
| LG-640 CMYK+gloss combined | PENDING | — | — | — | — | — |
| LG-540 historical | PENDING | — | — | — | — | — |
Method: GSO_ERP_ROLAND_LOG_FORENSIC_ANALYSIS.md. No rate changes until
groups reach n>=3 (low) with owner approval; n>=10 for high confidence.
Deliverable: recommended model per mode = fixed + layout-driven term, with
additivity verdict for combined jobs and an overprint multiplier check.
