# GSO Financial Action Policy (agents)

**QuickBooks: DEFERRED — NOT CONNECTED.** No QuickBooks code, credential, mapping or connector exists in this repository, and none is planned in this release.

## Ceilings

| Action | Level | Effect |
|---|---|---|
| prepare_purchase_order | AUTO_INTERNAL | draft only, from known vendor data |
| send_purchase_order | DISABLED | humans send POs |
| prepare_invoice | AUTO_INTERNAL | ERP-side readiness summary only |
| send_invoice | DISABLED | humans create/send invoices |
| refund_or_void | OWNER_REQUIRED | owner-only approval; no executor exists yet |
| change_cost_or_price | OWNER_REQUIRED | owner-only; agents never price |
| override_canonical_blocker | DISABLED | never |

## Purchasing (`purchasing.ts`)

- PO_READY_FOR_APPROVAL only when material, quantity, vendor **and a vendor unit cost > 0** are known.
- VENDOR_COST_REQUIRED when the cost is missing/zero — the agent never estimates.
- PURCHASING_INFO_REQUIRED when material/quantity/vendor is missing.
- Freight is always `null` in the draft. Quantities below vendor MOQ are raised to MOQ with a warning. Priority becomes `critical` when needed-by is inside vendor lead time.
- Drafts mirror `PurchaseRequest` columns (`status: "draft"`, `source`, `unitCost`, `estimatedCost`, `neededBy`) but are **not written** to the database in this release.

## Invoicing (`invoice-readiness.ts`)

- INVOICE_READY_FOR_APPROVAL requires: customer/company, billing email, quote in an accepted/won status, ≥1 line with quantity and **approved selling price > 0**, shipping known, tax treatment known, payment terms known; a linked production job should be completed/shipped.
- Anything unknown is listed as `missing` with "(not invented)". Balance due is computed only when ready: subtotal + shipping − deposit on file.
- Output is an approval summary for the owner; no invoice is created anywhere.

## Reporting

Sales reports state "quoted value, not cash collected". No agent claims revenue, cash, margin actuals, or P&L; those are accounting (deferred).

## Never

Discounts, credits, price matching, payment terms, deposits, taxes, freight, vendor costs, margins — none may be invented, promised, or changed by an agent. Customer requests for any of these are escalated (`discount_requested`, `final_price_requested`) to staff/owner.

## OPS-2 update (2026-10-04)

QuickBooks remains **DEFERRED — NOT CONNECTED**. Money actions (`refund_or_void`, `change_cost_or_price`) stay OWNER_REQUIRED and are additionally blocked by the execution kill switch; `send_invoice` and `send_purchase_order` stay DISABLED. The reasoning layer has no financial tool: `getCanonicalCostStatus` returns costability and blockers, never a price; `proposePurchaseRequest` can only create a draft intent from known vendor data and is denied to the sales and marketing specialists by the permission matrix. Models cannot approve money actions (actor type `model` is refused by `decideIntent`).
