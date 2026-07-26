# GSO ERP — Quote-to-Invoice Policy (15F.0J-AA, 2026-07-25)

QUOTE: employee-ready single price from approved calibrated assumptions
(may lean conservative); immutable snapshot (engine + commercial versions +
premiumInkEstimate). AFTER RIP (pre-print): capture the RIP layout/profile/
estimated time+ink as the second layer; show INTERNAL variance vs the
quote (never customer-facing, never silent price change); suggest
keep / raise / lower with reasons; adjustments follow customer terms.
FINAL INVOICE: quoted price and final price stored separately with an
adjustment reason; modest permitted adjustments only. ACTUAL COST:
15E finalization owns actual machine/ink/material/labor/reprint cost —
never rewrites the quote. FUTURE PRICE: calibration recommendations
(>=3 comparable finalized jobs; low/med/high confidence) -> owner approval
-> new effective version (ownerConfig) -> only NEW quotes change.
Controls (AB): actor+reason on manual matches, reroutes, invoice
adjustments, duplicate overrides; raw imports immutable; owner-only factor
approvals; versioned pricing; preserved originals; traceable routed copies.
