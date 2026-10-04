# GSO Agent Operations Runbook (staff)

Applies once the platform is deployed in sandbox mode. Until then everything here runs locally only.

## Where things live

| Need | Go to |
|---|---|
| Review a new lead the agents classified | ERP → Agent Review Queue (`/app/erp/agent-review-queue`) |
| See what agents may do, pending intents, simulation health | ERP → Operations hub (`/app/erp/ops-hub`) |
| Approve / reject an agent intent | Slack card buttons (sandbox channel for now) or the hub |
| Production, purchasing, proofs | existing ERP pages — unchanged |

## Slack cards

Every card that needs a decision shows: agent, action, autonomy level, intent id, status, and buttons **APPROVE / REJECT / REQUEST CHANGES / OPEN IN ERP**. Cards prefixed `SANDBOX — would post to <destination>` are redirected test posts; nothing happened in production.

- **APPROVE** records *your* Slack identity (mapped to your ERP staff id) as approver. If your Slack user is not in `SLACK_STAFF_MAP`, the click is refused.
- **OWNER-required** cards (refund/void, cost/price change) refuse staff approvals.
- Clicking twice is harmless: the second click reports "duplicate click ignored".
- Typing in Slack never does anything. Agents do not read commands from text.

## Statuses you will see

| Area | Values | What staff do |
|---|---|---|
| Quote prep | READY_FOR_STAFF_QUOTE / NEEDS_INFO / CANONICAL_BLOCKED / OUTSOURCED_REVIEW / UNSUPPORTED | build the quote in the Cost Calculator; collect info; escalate blocker to owner; vendor-cost review for DTP/boxes |
| Art preflight | PASS / WARN / FAIL / NEEDS_DESIGNER | WARN = review notes; FAIL = new file; NEEDS_DESIGNER = designer verifies unknowns |
| Art approval | TECHNICAL_PREFLIGHT_PASSED → CUSTOMER_APPROVED (portal) → FINAL_ART_APPROVED (staff) | a new file version resets all three |
| QC | QC_REQUIRED / QC_PASS_RECORDED / QC_FAIL_RECORDED | record pass/fail with your name |
| Purchasing | PO_READY_FOR_APPROVAL / PURCHASING_INFO_REQUIRED / VENDOR_COST_REQUIRED | approve the draft; supply vendor cost; sending POs is manual |
| Invoice | INVOICE_READY_FOR_APPROVAL / ACCOUNTING_INFO_REQUIRED | owner approves; QuickBooks is DEFERRED, invoices are created manually |

## Exceptions and what to do

| Code | Destination | Action |
|---|---|---|
| MISSING_CANONICAL_DATA | sales_quotes | owner/staff supply the missing input; never estimate |
| ART_FAILURE | art_approval | designer fixes or requests a new file |
| MACHINE_MISMATCH | production_exceptions | white/gloss cannot run on the Mimaki; fix the item's machine |
| MATERIAL_SHORTAGE / VENDOR_COST_MISSING | purchasing | review prepared request / obtain vendor cost |
| APPROVAL_MISSING | agent_approvals | decide the pending intent |
| SLACK_FAILURE | agent_approvals | check token/scopes; intents are held, nothing is lost |
| DUPLICATE_WEBHOOK | agent_approvals | none |
| LATE_PRODUCTION | production_exceptions | re-plan; staff contact customer |
| UNTRUSTED_INSTRUCTION | agent_approvals | read the flagged customer text; no agent acted on it |

## If something looks wrong

1. Nothing an agent does moves a job, sends a message, or touches money in this release. If you see otherwise, stop and tell the owner.
2. The hub shows the simulation result; if it reports failures the platform must not be trusted for approvals.
3. Secrets live outside the repo; never paste tokens into Slack, docs or tickets.
