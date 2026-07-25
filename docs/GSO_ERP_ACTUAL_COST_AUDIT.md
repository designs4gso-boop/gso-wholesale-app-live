# GSO ERP — Actual Cost & Final Margin Audit (Phase 15E, 2026-07-24)

Audit-only. Baseline commit 53274d6. No behavior changed, no migration.

## A. Cost-field inventory

### Estimated (all live, all authoritative at their layer)
| Fact | Storage | Written by | Read by |
|---|---|---|---|
| Estimated revenue | ProductionJobItem.quantity × unitPrice (columns) + priceSnapshot JSON | central job service (from QuoteItem / order lines) | production board, saveFinalCosts revenue, variance |
| Estimated total cost | ProductionJobItem.unitCost × qty + costSnapshot JSON (engine lines: material/ink/labor/machine/vendor/freight per family) | calculator save → quote → job service | board estimate panel, variance lib |
| Estimated vendor cost / freight / design (DTP) | costSnapshot.productBreakdown.dtp + dtpPricing JSON | 15C.2 save | board, future PO workflow |
| Estimated margin | derived (priceSnapshot tiers + marginRules JSON) | calculator | display only |

### Actual (ProductionJob columns — DB-backed, live)
| Field | Written by | Notes |
|---|---|---|
| actualLaborMinutes / actualLaborRate / actualLaborCost | production `saveFinalCosts` | typed cost OVERRIDES minutes×rate (no double count); **rate defaults to $25/hr — conflicts with owner-standards activity rates** |
| actualPackingCost, actualShippingCost, actualOutsourceCost, actualOtherCost, actualReprintCost | `saveFinalCosts` | free-typed dollars; blank posts become 0 |
| actualTotalCost, actualFinalProfit, actualFinalMargin | `saveFinalCosts` (server-computed) | formula below |
| actualCostNotes, actualCostFinalized, actualCostFinalizedAt, actualCostFinalizedBy | `saveFinalCosts` | finalizedBy is HARDCODED "GSO ERP" (no actor) |
| ProductionMaterialUsage: estimatedQty, pulledQty, usedQty, wasteQty, reprintQty, costPerUnit, totalCost, source, stockDeductedQty/At | `addMaterialUsage` / `pullPrintLogActuals` (source "print_log") / delete intent | totalCost = posted override OR (used‖pulled‖estimated + waste + reprint) × costPerUnit |
| MaterialInventoryMovement: movementType, quantity, before/afterQty, costImpact, source, createdBy | `addMaterialUsage` (deduct checkbox) / `adjustInventory` | audit rows exist for stock, not for cost edits |
| PrintLogEntry: inkMl/cmyk/white/gloss, printMinutes, sqft-ish raw, productionJobId link | upload APIs + review-page confirm | actual ink/runtime source of truth |

Actual print sqft: derived in the writeback/preview engines from log rows (no dedicated job column). Actual machine time: PrintLogEntry.printMinutes → machine line at machineRatePerHour() ($8). Vendor invoices: single actualOutsourceCost field only — no structured invoice/freight/credit split. Final revenue actual: none — revenue is always the estimated item rows (no "actual revenue" concept; acceptable: invoiced price = item rows).

## B. Production-page persistence audit
- `saveFinalCosts` PERSISTS everything listed and RECOMPUTES totals server-side: revenue = Σ item qty×unitPrice (server rows, not client), print component = recorded print_log usage rows if any ELSE live preview number, + manual material rows + labor + the five typed dollar fields. Client-trusted inputs: the typed dollar fields themselves and the optional material totalCost override (by design — they are the actual-entry surface); revenue/print/material components are not client-postable.
- **Finalization is a checkbox with NO gates**: a job can finalize with every actual at zero; nothing distinguishes "actually zero" from "not entered" (spec-L risk confirmed).
- **Estimated-as-actual risk confirmed**: when the owner never runs the guarded writeback, the LIVE PREVIEW print cost silently becomes part of the FINAL total (printCostSource "live_preview" is tracked in the summary but finalize does not require "recorded").
- **Finalized rows are silently editable**: `saveFinalCosts` runs regardless of existing actualCostFinalized; unchecking the box reopens with no reason, no owner gate; prior final figures are OVERWRITTEN (events record new totals — partial audit trail, no snapshot of the prior final state).
- Permissions: any admin session; finalizedBy hardcoded.

## C. Print-log / RIP flow (RasterLink + VersaWorks)
Local agents upload via token-authed APIs → PrintLogImport/PrintLogEntry. Matching is 13A.6E-conservative: EXACT shop-scoped jobTicket equality, single-candidate attach only; ambiguous/zero stay unresolved for the confirm-gated RIP Import Review page (stale-write protected, audited). Duplicate-import prevention lives in the import pipeline (import batches + entry identity); webhook-style retries covered by upsert-by-source-file conventions. Actual ink (per-channel ml), runtime minutes, and job linkage captured. Cost conversion uses the shared verified channel-cost engine + $8/hr machine recovery; the **guarded writeback** ("APPLY PRINT LOG ACTUALS" + reason) writes ink+machine ProductionMaterialUsage rows (source print_log); media/material stays preview-only by design (13A.7B). **15D.1 compatibility: IMPROVED** — every centrally-created job now has jobTicket/itemTicket/ripJobName (the old quotes-page path created ticketless jobs that logs could never match). Families: in-house print families supported; DTP correctly has no log expectation (and no code currently exempts DTP from the "print cost = preview" fallback — it is simply $0, fine).

## D. Material usage & inventory
Formula in code: billable = usedQty ‖ pulledQty ‖ estimatedQty; totalCost = override ‖ (billable + wasteQty + reprintQty) × costPerUnit. This MATCHES the recommended concept (used + waste + reprint) when usedQty is entered; the pulled/estimated fallbacks cover partial entry (pulled≠used is honored when both entered). Inventory deduction is opt-in (checkbox) with deductionQty = deductQty ‖ pulled ‖ (used+waste+reprint); movements record before/after + costImpact + source. Gaps: no negative-stock guard verified; deduction can diverge from the costed quantity (deduct pulled, cost used) with no reconciliation warning; corrections = delete usage row + manual adjustInventory (movement rows persist — auditable but manual).

## E. Labor
Today: one job-level minutes×rate with typed-total override; default rate $25/hr (LEGACY-CONFLICTING vs owner-standards activity rates — quarantined list already flags it). Estimated labor in snapshots uses owner activity standards. Recommendation (smallest safe): keep job-level entry as the actual surface, DEFAULT the rate from OWNER_STANDARDS ($20/hr activity basis is per-piece; for time-entry keep $25 as shop rate ONLY if owner confirms — owner decision item), show the estimate's owner-standard labor beside the entry, and record which was used. Checklist-timestamp or time-clock labor = later phase. Hybrid (per-step) not needed for 15E.1.

## F. DTP actual cost
Estimated: vendor subtotal + $85 freight + art design cost (all in dtp/dtpPricing snapshot). Actual today: ONE actualOutsourceCost field (+ shipping/other). Recommendation: structured entry of vendor invoice subtotal, actual freight, and credits/adjustments IS cleaner and prevents the invoice-includes-freight double count — implement WITHOUT migration as three inputs that sum into actualOutsourceCost and store the breakdown JSON in the finalize snapshot (schema field optional later). DTP must not require print logs / material rows / ink / machine / application — and finalization gating must expect a vendor invoice INSTEAD of a print log for outsourced jobs.

## L. Data-quality risks (confirmed list)
1. Zero-vs-missing: blank inputs coerce to 0 and finalize freely.
2. Live-preview print cost silently in FINAL totals (source tracked but not gated).
3. Labor default $25 vs owner standards; typed override replaces (no double count) but is unaudited.
4. Vendor invoice may include freight while actualShippingCost is also typed (double count) — no structure prevents it.
5. Material totalCost override is client-posted (intended, but unflagged in finals).
6. Inventory deduction qty can diverge from costed qty silently.
7. Reopen/overwrite of finalized figures with no reason/snapshot.
8. finalizedBy not an actor.
9. Estimate snapshots themselves are safe (write-once confirmed); revenue is server-derived (safe).
10. Print-log + manual print cost double count is PREVENTED (source split) — verified.
