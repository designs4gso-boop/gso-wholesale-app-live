# GSO ERP — Actual Cost & Final Margin Plan (Phase 15E, 2026-07-24)

Plan only. Companion: GSO_ERP_ACTUAL_COST_AUDIT.md. No migration required for
15E.1 (finalize snapshot + gating fit existing columns/JSON/events).

## H. Authoritative formulas (gross margin, never markup)

- Final revenue = Σ ProductionJobItem.quantity × unitPrice (server rows).
- Final material cost = Σ manual ProductionMaterialUsage.totalCost where
  totalCost = override ‖ (usedQty ‖ pulledQty ‖ estimatedQty + wasteQty + reprintQty) × costPerUnit.
- Final ink/print cost = Σ print_log usage rows (recorded writeback). Live
  preview is ESTIMATE-grade and may only enter finals with an owner override reason.
- Final labor cost = typed total ‖ minutes × rate (rate defaulting decision:
  owner confirms shop time rate; activity standards remain the estimate side).
- Final machine cost = inside the print_log rows (machine-time rows at $8/hr) — never added twice.
- Final packing / shipping / outsource / reprint / other = typed actuals.
  DTP: outsource = vendor invoice subtotal + actual freight − credits
  (structured entry; freight NEVER also in shipping unless genuinely separate shipment).
- Final total cost = print + material + labor + packing + shipping + outsource + other + reprint.
- Final gross profit = revenue − total cost.
- Final gross margin % = profit / revenue × 100 (0 revenue ⇒ margin undefined ⇒ BLOCKED).
- Variance $ = final total cost − estimated total cost (Σ qty × unitCost);
  Variance % = variance / estimated × 100. Revenue variance analogous.

## G. Finalization rules (15E.1 core)

Status computed server-side at finalize time:
- READY: revenue > 0; for in-house print families a recorded print-log cost
  exists (or family needs none); material rows present when the estimate had
  material lines; labor entered (minutes or typed) or explicitly $0-confirmed;
  DTP: vendor invoice entered.
- WARNING (finalize allowed WITH typed reason): expected data missing —
  live-preview print cost instead of recorded; no material rows despite
  estimated materials; labor zero unconfirmed.
- BLOCKED (cannot finalize): revenue ≤ 0; total cost < 0; DTP job without
  vendor invoice; already finalized (must reopen first); inventory deduction
  ≠ costed quantity beyond tolerance without reason.
Finalize writes: recomputed totals + a WRITE-ONCE finalActualSnapshot (JSON in
actualCostNotes-adjacent event payload or a dedicated event record — no
migration: store the full input/component snapshot in the
actual_cost_finalized event message/data and keep columns as the queryable
copy), finalizedAt + ACTOR (session identity, not "GSO ERP"), variance vs
estimate, and blocks `saveFinalCosts` while finalized.
Reopen: explicit intent, owner reason required, audit event with prior totals
embedded, finalized flags cleared — prior final snapshot retained in the
event history (immutable).

## E/I/J/K summaries
- Labor 15E.1: job-level entry kept; owner-standard estimate shown beside it;
  rate default decision surfaced to owner; per-step/time-clock deferred.
- Pricing feedback (owner-reviewed, never automatic): finalized jobs →
  variance rollups by family/product/quantity (existing actual-variance lib
  extends) → suggested standard changes (waste %, machine minutes, vendor
  cost, freight) → owner approves → Vendor Cost Book / owner-standards edit.
  Calibration page (13A.8A) already provides the recommendation engine shape.
- Reports implementable from existing schema NOW: job profitability
  (finalized jobs), estimated-vs-actual variance, jobs finalized with
  override/warning, missing-actual-data list, material waste %, reprint cost,
  DTP vendor invoice variance. Customer profitability needs the future
  Customer model (defer). Margin-leakage = below-floor finals report.
- Permissions: single-role shop today — 15E.1 records the ACTOR on every
  finalize/reopen and gates reopen behind the owner phrase pattern; true
  roles arrive with multi-user auth (later).

## Phase 15E.1 — smallest safe patch (definition)
1. `app/lib/actual-cost-finalize.server.ts`: pure `assessFinalization(job,
   summaries, family)` returning READY/WARNING/BLOCKED + reasons; final
   formulas; variance calc; snapshot builder.
2. production.tsx `saveFinalCosts`: refuse when finalized (new `reopenJobCost`
   intent: owner phrase + reason + audit event with prior totals); finalize
   path requires gate pass or warning reason; actor recorded from session;
   DTP structured outsource entry (three inputs summing; breakdown into the
   finalize snapshot); live-preview print cost demoted to WARNING.
3. Variance surfaced on the board (estimate vs final after finalize).
4. Tests: gate matrix (each READY/WARNING/BLOCKED case incl. DTP invoice,
   preview-vs-recorded, zero-revenue), reopen audit + immutability, actor
   recording, formula reconstruction, double-count guards (freight-in-invoice
   note, labor override), regression on writeback/variance suites.
5. Docs: PROJECT_STATE + this plan updated.
Explicitly out of 15E.1: schema changes, time clock, per-step labor,
automated pricing updates, customer reports.

## Files 15E.1 modifies
NEW app/lib/actual-cost-finalize.server.ts + tests/actual-cost-finalize.test.ts;
MODIFIED app/routes/app.erp.production.tsx (saveFinalCosts + reopen intent +
DTP outsource inputs + status banner), docs (PROJECT_STATE, ACTUAL_COST_PLAN,
DATA_OWNERSHIP_MAP). No schema, no webhook, no calculator changes.
