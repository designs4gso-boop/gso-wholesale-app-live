# GSO Production Automation Contract

Code: `production-transitions.ts`, `production-planner.ts`, `production-dispatch.server.ts`, `qa-checklist.server.ts`, `shipping.ts`, `production-status.ts`. Tests: `tests/ops-production-workflow.test.ts`.

## Statuses (the ERP's actual vocabulary)

`new → proof_sent → proof_approved → routed → printing → cutting → production → qc → completed → shipped`, plus `reprint_needed`, `on_hold`, `cancelled` (`canceled` normalised). Groups: new / prepress / printing / qc / completed / hold / cancelled.

## Transition guard (pure, advisory tonight)

| Move | Requires |
|---|---|
| → routed / printing / cutting / production | `artApproved` (final approval on current art version or proof approved); printing also honours `materialReady=false` and `routingDecided=false` as blockers |
| → completed | `qcPassRecorded` |
| → shipped | from `completed` and `shippingRecorded` (tracking or hand-delivery) |
| on_hold → X | X must equal `previousStatus` or be `cancelled` |
| shipped / cancelled → anything | never |

`app.erp.production.tsx`'s `changeStatus` currently accepts any string. **Recommended follow-up (owner approval):** call `evaluateTransition` there and refuse disallowed moves. Not done tonight (production write path untouched).

## Planner

Readiness: READY / IN_PROGRESS / BLOCKED / WAITING_CUSTOMER / ON_HOLD / DONE / CANCELLED. Sort: overdue first, then readiness, priority (critical > rush > high > normal > low), due date. Each job gets `blockers[]`, `nextAction`, `nextStatus`. Read-only.

## Dispatch

`planDispatch(items)` → DISPATCH (`mimaki-ucjv300-130` | `roland-lg-640`) / BLOCK / OUTSOURCED using the existing `decideMachine`: white/gloss → Roland; explicit Mimaki + white/gloss → contradiction → BLOCK; default CMYK → Mimaki. The PowerShell print-intake agent remains the only executor; `dispatch_to_machine` is DISABLED.

## QC

`assessQc({ family, checklist, recorded })` → QC_REQUIRED unless a pass/fail with a named `recordedBy` exists. Required items come from `FAMILY_CHECKLISTS`. A pass with incomplete production steps is accepted but flagged. `record_qc_result` is APPROVAL_REQUIRED.

## Shipping

Ready when status completed, QC pass recorded, packing complete, ship-to known; `canMarkShipped` additionally needs tracking or hand-delivery. Customer update text is a draft for staff. `mark_shipped` APPROVAL_REQUIRED; `send_customer_notification` DISABLED.

## Status answers

`describeJobStatus` never guesses: unknown machine/vendor/proof/purchasing facts are listed under `dataGaps`.
