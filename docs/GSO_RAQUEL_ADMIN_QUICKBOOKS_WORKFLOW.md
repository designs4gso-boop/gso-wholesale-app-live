# QuickBooks → ERP: Admin Workflow and Decisions for Raquel

For review with Raquel. No code knowledge needed. Last updated 2026-11-19.

## Where things stand

- Real orders are invoiced in QuickBooks. The ERP cannot see QuickBooks yet, so production work
  starts with no job in the ERP unless someone types it in with **New Job**.
- The ERP side of the flow below is **built and waiting**: the review screen, the release button
  and the job creation. What is **not** built is the connection that brings invoices in.
- Nothing in the ERP writes to QuickBooks. That does not change.
- No business rule has been chosen for you. Every item under "Decisions" below is open.

## The proposed flow

```
QuickBooks invoice or estimate
        ↓  (copied in, read-only)
Release to Production  — your review screen
        ↓  you mark the lines and click Release
Production job + item tickets
        ↓
Production Board  — production works from here
```

Production never opens QuickBooks and never sees this screen. They receive a job.

## What you would see

**Sales → Release to Production** lists each invoice waiting for you:

- customer, invoice number, date, QuickBooks status
- total and balance (shown to the owner and to managers you have authorized for financials)
- every line on the invoice

An invoice does nothing on its own. It sits there until a person acts on it, even if it is paid.

## What you would click

For each line, choose one:

| Choice | Meaning |
|---|---|
| **Production work** | We have to make this. List what is being made. |
| **Not production** | Discount, shipping, design fee, old balance, and so on. |
| **Not decided yet** | The default. The invoice cannot be released while any line says this. |

**Line splitting.** One invoice line often covers several designs — invoice 1270 has a single
line, "Qty:128 - 20 designs". For a production line you list the real items, one per row:

```
HEATH pouch | 128
SHORTCAKES pouch | 128
MIXED BERRIES pouch | 128
```

Each row becomes its own item ticket on the same job.

Then choose the product type and finish, add a due date and notes if you want, and click
**RELEASE TO PRODUCTION**. You can also **Save review** and come back, or mark the whole invoice
**not production work** with a reason.

Clicking Release twice, or retrying after a timeout, gives the same job — never a duplicate.

## What production receives

- one job with a job ticket, for example `GSO-20261119-0042`
- one item ticket per row you listed (`-01`, `-02`, …)
- the invoice number as the job's reference
- your due date and notes

It appears on the Production Board in **New**, showing **Awaiting files**.

## Until QuickBooks is connected

Use **Production → New Job**. Put the invoice number in **Reference #** and list several items
with the "More items" box. This creates exactly the same kind of job.

## Decisions for you

None of these has been decided. The current behaviour for each is in the right-hand column.

### 1. When may work be released?

| Option | Notes |
|---|---|
| You release each invoice by hand | **This is how it is built today.** Nothing is automatic. |
| When the invoice is created | Fastest; work can start unpaid. |
| When a deposit is paid | Needs a deposit amount or percentage from you. |
| When the invoice is paid in full | Safest for cash; 11 of the last 33 invoices carried a balance. |
| When an estimate is accepted | Only useful if you start using QuickBooks estimates (none in the last five weeks). |

Related: is any balance acceptable before production starts, and does that differ by customer?

### 2. Should release ever become automatic?

If yes: for which customers or products, and after how long on manual release? Today the answer
is "never automatic".

### 3. Void, cancellation and refund

If an invoice is voided or refunded after its job has been released, what should happen to the
job — at each stage: not started, files received, printing, finished?

Today: nothing happens automatically. The job carries on until someone cancels it.

### 4. Which lines are never production?

A list from you (shipping, discounts, design fees, "Old Balance", rush fee, …) would let the
screen pre-select "Not production" for those lines. Today every line starts as "Not decided yet"
and you choose.

### 5. Customer matching

QuickBooks customer names and ERP customer names differ (the CRUD files belong, very probably, to
QuickBooks customer "krud Cafe" — please confirm). Should the ERP remember the QuickBooks customer
and reuse it? It would only ever match on the QuickBooks customer record, never on a similar name.

### 6. Product mapping

Most invoice lines are "Custom Item" with free text. Should named QuickBooks products map to an
ERP product type and finish automatically? Which ones? Today nothing is mapped automatically.

### 7. Who else may release?

Today: the owner and managers. Sales and production cannot. Should managers see invoice totals
and balances, or only the lines?

### 8. Connecting QuickBooks

The connection needs an Intuit developer app and your consent for the ERP to **read** invoices,
estimates and customers. Read-only. Your approval is needed before this is set up.

## Your day-to-day in the ERP (available now, no QuickBooks needed)

You have both the admin side and the production side. Nothing on the production side is hidden
from you.

**Admin**

| Task | Where |
|---|---|
| Quotes and customers | Sales → Quotes & Customers |
| Start a job for an invoiced order | Production → New Job (invoice number in *Reference #*, extra items under *More items*) |
| Due date, priority, who it is assigned to | Open the job → Job settings. Production sees these on every board card but cannot change them. |
| Put a job on hold / take it off | Open the job → status. Write a note saying why; the board shows the note. |
| Reorder | Sales → Reorder a Past Item |
| Reports | Admin → Reports |
| Who has which role | Admin → Staff Access & Readiness |
| Customer privacy requests from Shopify | Admin → Privacy Requests |

**Production support**

| Task | Where |
|---|---|
| See every job and its next step | Production → Production Board |
| QC pass / fail / hold | Open the job → QC step |
| Reprint or remake (with quantity and who pays) | Open the job → QC step → NEEDS REPRINT |
| Reopen a finished job for a reprint | Open the job → More tools |
| Record shipment or pickup, complete the job | Open the job → last steps |
| Link a print file that arrived with no job | Production → Incoming Print Files → Assign to… |
| Job history, every reprint run, reorder history | Open the job |

The Production Lead has the production side and none of the admin side: no quotes, no release
screen, no costs, and cannot change due dates, priorities or assignments.

## Reorders

A reorder is a new sale, not a reprint.

1. **Sales → Reorder a Past Item.** Search the customer, tick the earlier item(s).
2. Enter the **new quantity** and choose **same artwork** or **revised artwork**.
3. **Create reorder quote.** A draft quote is created.
   - It uses **today's price for the new quantity**. The old price is never copied.
   - If today's price cannot be calculated for an item, the quote is held for your price approval.
4. The quote follows the normal steps. When it is released, production gets a **new job with new
   tickets**, and each item shows which earlier item it re-orders.
   - Same artwork: the approved earlier file is listed on the new job for reuse.
   - Revised artwork: a new proof approval is required; the old file is reference only.

The earlier job is never changed.

Questions for you on reorders:

- Should a reorder quote need your approval every time, or only when the price needs approving?
- For invoiced (QuickBooks) reorders: should the reorder be marked on the Release screen, so the
  new job links to the earlier item? The link is supported; the screen does not ask for it yet.

## Reprints that the customer pays for

Production can mark a reprint or remake as **customer-paid**. That only records it. Nothing is
charged and no invoice is created. Decision for you: when that happens, do you invoice it in
QuickBooks as a new invoice, and should the ERP remind you?
