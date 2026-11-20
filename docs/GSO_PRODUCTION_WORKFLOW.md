# GSO Production Workflow

How a job moves through the shop. Written for production staff; no code knowledge needed.
Last updated 2026-11-19.

## The one rule

**The job comes first. Files never create a job.**

A job exists because there is a sale (a Shopify order, a quote, an invoice the owner released, or a
job someone entered with New Job). A print file that shows up with no job is not printed and does
not make a job. It waits in **Incoming Print Files** as **Needs review — link to job** until a
person links it.

## 1. The job and its tickets

Every job has one **job ticket** and one **item ticket** for each thing being made.

| | Looks like | Example |
|---|---|---|
| Job ticket | `GSO-YYYYMMDD-NNNN` | `GSO-20261119-0042` |
| Item ticket | job ticket + `-01`, `-02`, … | `GSO-20261119-0042-01` |

The tickets never change — not for a revision, a reprint or a remake.

Open the job from the **Production Board**. The job page shows the **job folder name**, every item
ticket, the finish and printer each item needs, and whether its files have arrived. Each one has a
**Copy** button.

## 2. Saving print files

1. In **Prints For Today**, make a folder named exactly the **job ticket**
   (use *Copy job folder name*).
2. Save the print files in that folder.
   - **One item on the job:** name the files however you normally do.
   - **More than one item:** start each file name with that item's **item ticket**
     (use *Copy item ticket*), for example `GSO-20261119-0042-02 shortcakes_CMYK.pdf`.
3. That's it. The watcher links the file to the job and item and sends it to the right printer.

The job page changes from **Awaiting files** to **print file(s) received** when a file is routed.
The board card shows the same thing, so you can see from the board which jobs are still waiting
for files.

Adding a file link by hand (job page → Files → *Add a file link*): on a job with more than one
item, pick the item the file is for, or leave it as *For the whole job*.

## 3. Layers (CMYK, gloss, white)

One item can need more than one file. Keep the usual endings so the layers pair up:

| Layer | File ending |
|---|---|
| Color | `_CMYK` |
| Gloss | `_g` |
| White | `_w` |

Both layers of an item must be in the same job folder. They are sent to the same printer.

## 4. Which printer

| Item needs | Goes to |
|---|---|
| CMYK only | Mimaki |
| CMYK + Gloss | Mimaki |
| White + Gloss | Roland |
| White only | Auto picks the less busy press when machine load is known; otherwise the job says which |

You do not choose the printer by where you save the file. The job decides. If a file cannot be
routed safely it waits in Incoming Print Files with the reason.

## 5. What the file is called at the press

The watcher renames the copy it sends to the press:

`<item ticket>__<your file name>.pdf`

Example: `crud_HEATH_F_CMYK.pdf` on item `GSO-20261119-0042-01` arrives as
`GSO-20261119-0042-01__crud_HEATH_F_CMYK.pdf`, and its gloss layer as
`GSO-20261119-0042-01__crud_HEATH_F_g.pdf`.

Your original file is not changed and its name is kept on the job.

## 6. Files with no job

If a file is in **Incoming Print Files** as *Needs review — link to job*:

1. Find or create the job (ask the owner / admin if the sale is not in the system yet).
2. Use **Assign to…** and pick the job and the item.
3. The file then routes normally.

Never rename a file to a made-up ticket to get it through.

## 7. Revised artwork

Corrected artwork for the same item: save the new file **with the same file name** in the same job
folder. It routes as revision 2 (`…__R2-A1`). The old file stays in the history.

A different file name on the same item is treated as another layer or side, not a revision.

## 8. QC

Every item needs **QC PASS** before the job can ship, be picked up or be completed.

On the job page, QC step, per item: **QC PASS**, **Needs reprint**, or **Hold / review**.

## 9. Reprints and remakes

Use **NEEDS REPRINT** on the item when a piece has to be made again (banding, color, cut, gloss,
machine failure, shortage, damage, wrong artwork).

You enter:

- **Reason** (pick from the list).
- **How many pieces** to reprint. This is required. The ordered quantity does not change:
  500 ordered and 25 reprinted stays an order of 500.
- **Type:** reprint (print again) or remake (redo the piece).
- **Who pays:** internal — no charge, warranty / replacement — no charge, or customer-paid.
  Nothing is charged from this screen. For a customer-paid replacement the owner / admin creates
  the sale.

What happens next:

- The item keeps its ticket. The reprint is recorded as a new **run** on the same item; the job
  page lists every run with its quantity, reason and result.
- **Every layer file of the item** is sent back to the press, with the run marked at the end of
  the name, for example `…__crud_HEATH_F_CMYK__P1-A1.pdf` and `…__crud_HEATH_F_g__P1-A1.pdf`.
  Put the artwork back into Prints For Today (the originals are in the routed archive).
- The item needs a **new QC PASS**. A second reprint cannot be started until QC is recorded on the
  first.

A finished job that needs a reprint is reopened by the owner or a manager (**More tools → Reopen
for reprint**).

## 10. Reorders

A reorder is a **new sale**, not a reprint. It gets a new job and new item tickets. On the new job
each reordered item shows *Reorder of <old item ticket>* and one of:

- **Same artwork** — the earlier approved file is listed under Files as a reference. Copy it from
  the routed archive into the new job's folder to print it.
- **Revised artwork** — the earlier file is reference only. A new proof approval and a new print
  file are needed. Do not print the old file.

Reorders are created by the owner, a manager or sales. Production sees the history on the job.

## 11. Finishing the job

Cut / laminate / apply → QC → pack → **Ready to ship** or **Ready for pickup** → record
**shipment** or **pickup** → **Complete Job**. The board shows the next step for every job.

- **Ready to ship / Ready for pickup** (job page, last step) means packed and waiting. Every item
  needs QC PASS first. The board card shows *Packed: Ready to ship*.
- Recording the shipment or pickup does **not** update Shopify. If the job came from a Shopify
  order, the job says so: mark the order fulfilled in Shopify by hand.

## 12. Holds and notes

Put a job **On Hold** and write a note saying why. The board shows held jobs at the top with the
note. Due date, priority and who the job is assigned to are set by the owner or a manager and are
shown on every board card.

## 13. Printer results (ink and time)

The RIP results come back by item ticket — which is why the ticket is in the routed file name.
A reprint's result comes back with its run mark (`__P1-A1`), so the job page shows ink and time
for the original and for each reprint separately ("Press result — Run 2 — Reprint: …").
Mimaki results are collected automatically once the sync is switched on; Roland results are
imported from its CSV export by the owner or a manager. Production does not need to enter ink or
time by hand.

## 14. If something goes wrong

| What you see | What to do |
|---|---|
| File sits in Incoming Print Files as *Needs review — link to job* | The job does not exist yet or the folder / file name has no ticket. Create or find the job, then **Assign to…**. |
| File is assigned but not routed | The printer could not be decided (for example white only with no printer chosen). The reason is shown; the owner or production lead picks the printer on the job. |
| Two files with the same name in one job folder | The second is treated as a revision of the first. Use different names for different layers or sides. |
| The press did not receive a file the job says was routed | Drop the same file into the job folder again. It is re-sent as the next attempt (`__A2`); it is never duplicated on the job. |
| NAS or the RIP PC was off | Nothing is lost. Files wait in Prints For Today and are picked up when the watcher is running again. |
| Red banner on Incoming Print Files: "The print-file watcher has not checked in" | The watcher on the RIP PC has stopped. Sign in to Windows on the RIP PC, or start the task **GSO Print Intake Agent**. Tell the owner. |
| Board card says *On press now: Run 2 · Reprint · 25 pcs* | A reprint is open on that job. It needs a new QC PASS before the job can ship. |
| Wrong item on a file | Do not rename it to another ticket. Tell the production lead or owner; the file is re-assigned from Incoming Print Files. |

## Who does what

| | Owner / admin | Manager | Production lead (print operator) | Bagger / finisher | Sales |
|---|---|---|---|---|---|
| Production Board, job pages | Yes | Yes | Yes | Yes | No |
| Incoming Print Files, assign a file | Yes | Yes | Yes | No | No |
| New Job | Yes | Yes | Yes | No | No |
| Choose the printer by hand | Yes | No | Yes | No | No |
| QC, ready to ship / pickup, shipment, pickup, status, notes | Yes | Yes | Yes | Yes | No |
| Reprint / remake, revision | Yes | Yes | Yes | No | No |
| Reopen a finished job for reprint | Yes | Yes | No | No | No |
| Due date, priority, assignment | Yes | Yes | No (can see them) | No (can see them) | No |
| Reorder (new quote) | Yes | Yes | No (can see history) | No | Yes |
| Release to Production (staged invoices) | Yes | Yes | No | No | No |
| Costs, margins, prices | Yes | Only if authorized | No | No | Selling price only |
