# Handoff — James (production) to Raquel (admin)

Written 2026-11-20. Plain language; no code knowledge needed.

James's side is the production half of the ERP. Raquel's side is the admin half: customers, the
first real job, releasing work to production, and — after that — QuickBooks. This page says where
James's side stands and what Raquel does next. **No QuickBooks decision is made on this page.**

## Where James's side stands

| Area | State |
|---|---|
| Production software (board, jobs, items, tickets, files, reprints, QC, shipment / pickup) | Built, tested, deployed. Never yet used on a real job. |
| Print-file watcher on the RIP PC | Running. It starts when `golde` signs in to Windows. See `docs/GSO_PRINT_INTAKE_RUNTIME.md`. |
| Old Roland result task | **Disabled.** Roland press results are entered by manual CSV. |
| Mimaki press results | Software ready. Automatic sync is **off** until the first real ticketed job proves it (`docs/GSO_FIRST_REAL_JOB_CHECKLIST.md`). |
| Printer routing | CMYK and CMYK + Gloss → Mimaki. White + Gloss → Roland. A file with no job is held, never printed. |
| Production permissions | Production lead (`print_operator`) has the production screens and none of the admin, pricing or release screens. Checked by tests against the live code. |
| Staff roles on Render | **To be confirmed by an owner** — `docs/GSO_STAFF_ROLE_SETUP.md` (one-minute check inside the ERP). |
| Shop-floor instructions | `docs/GSO_PRODUCTION_WORKFLOW.md` |
| Open production decisions (James) | `docs/GSO_JAMES_DECISIONS.md` — none of them blocks the first job. |

## Raquel — what to do next, in order

1. **Sign in.** Open the ERP from Shopify admin (Apps → GSO ERP).
2. **Check your role.** Open **Admin → Staff Access & Readiness**. If it opens, you are an owner.
   "Owner enforcement" should be green. If the page will not open, stop and tell James — your
   staff ID is not set as an owner yet (`docs/GSO_STAFF_ROLE_SETUP.md`).
3. **Create or choose the customer.** **Sales → Customers**. If the customer is not there, use
   *Add a customer*. Write the company name the way you want it everywhere.
4. **Create the first real job.** QuickBooks is not connected yet, so invoices do not arrive on
   their own. Use **Production → New Job**:
   - *Customer or job name*: the company name, typed **exactly** as on the customer record
     (that is how the job shows up under the customer).
   - First item, quantity, finish.
   - The other items under *More items on this job* — one per line: `name | quantity`.
   - *More details → Reference #*: the invoice number.
   - Due date and notes if you have them.
5. **Check the result.** The job opens with a ticket like `GSO-20261120-0001`. Each item has its
   own ticket (`-01`, `-02`, …) and the right quantity.
6. **Set due date, priority and who it is assigned to** (job page → Job settings). Production sees
   these but cannot change them.
7. **Hand it to James.** Tell him the job ticket. That is the handoff point: "production ready".
   From there he follows `docs/GSO_FIRST_REAL_JOB_CHECKLIST.md`.
8. **Then begin the QuickBooks decisions** in `docs/GSO_RAQUEL_ADMIN_QUICKBOOKS_WORKFLOW.md`.
   Nothing about QuickBooks is decided or connected until you do.

*Release to Production* (Sales menu) is the screen invoices will arrive on once QuickBooks is
connected. It is empty today; that is expected.

## What Raquel needs to have ready for the first job

Business information only — nothing about printers or files.

| Needed | Example |
|---|---|
| Customer / company name | Krud Cafe |
| Contact (optional): name, email, phone | |
| Invoice or reference number | 1270 |
| Each item's name | HEATH pouch |
| Each item's quantity | 128 |
| Product type and finish for the job | 4x5 bag labels · CMYK + Gloss |
| Due date | |
| Priority (normal / rush) | |
| Notes for production | "Customer picks up Friday" |
| For each item: is it a **reorder** of something made before? | yes / no |
| If a reorder: **same artwork** or **revised artwork**? | same |

If an item is a reorder, use **Sales → Reorder a Past Item** instead of New Job: it makes a new
quote at today's price and, later, a new job that is linked to the earlier one.

## What Raquel does **not** need to do

- Choose a printer. The job's finish decides it.
- Name or save print files. Production does that.
- Anything in QuickBooks for this first job. The ERP reads nothing from it and writes nothing to it.

## If something looks wrong

| You see | Do |
|---|---|
| "Quotes, customers and leads are for the owner, managers and sales" | Your role is not set. Tell James your staff ID (Home shows it). |
| New Job refuses "More items" | One item per line, `name | quantity`, whole numbers. |
| The job is not under the customer | The name on the job is not exactly the customer's company name. Edit the customer's company name to match, or leave it — the job itself is fine. |
| You created a job by mistake | Open it and set the status to Cancelled. Nothing is deleted. |
