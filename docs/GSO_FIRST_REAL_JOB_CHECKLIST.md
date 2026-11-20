# First Real Job — Production Checklist (James)

Updated 2026-11-20. This is the production half of the first real job. It starts when Raquel hands
over a job that already exists. Tick each line; if a line does not match, stop and write down what
you saw.

**Status today:** the software is ready and tested with fixtures. It has **not** been proven on the
press. Only this job's own results count — do not import old results to "test" it.

## The handoff point

**Raquel has done:** a real job exists in the ERP with every item on it, and she tells you its job
ticket (for example `GSO-20261120-0001`). You do not create the job and you do not need QuickBooks.

If there is no job yet, production does not start. Files never create a job.

## Before you start (2 minutes)

- [ ] **Production → Incoming Print Files** shows a green line: *The print-file watcher is running*.
      Red or amber → on the RIP PC, sign in to Windows, or start the task **GSO Print Intake Agent**.
- [ ] You can open **Production → Production Board**.

## The sixteen steps

| # | Do this | You should see | If not |
|---|---|---|---|
| 1 | **Open the job** from the Production Board (column **New**). | The job page, with a **NEXT STEP** box and one line under it saying what the system is waiting for. | Job not on the board → ask Raquel for the ticket; it was not released. |
| 2 | **Check the items.** | One row per thing to make, with the right names. | Missing or wrong item → back to Raquel. Do not fix it by renaming files. |
| 3 | **Check the item tickets.** | Each item has its own ticket: job ticket + `-01`, `-02`, … and a **Copy** button. | No ticket on an item → stop, tell Claude. |
| 4 | **Check the quantities.** | Each item's quantity matches the order. | Wrong → back to Raquel. Quantity is never changed on the floor. |
| 5 | **Check printer, finish and layers.** | Each item shows its finish (CMYK, CMYK + Gloss, …) and printer. CMYK and CMYK + Gloss go to the **Mimaki**. White + Gloss goes to the **Roland**. White only: the job says which printer. | "Printer not decided" → pick the printer on the job (owner or production lead). |
| 6 | **Prepare the print files** as you normally do. Layers end in `_CMYK`, `_g` (gloss), `_w` (white). | — | — |
| 7 | **Save them in the right folder.** In **Prints For Today** make a folder named exactly the **job ticket** (*Copy job folder name*). More than one item on the job: start each file name with that item's ticket (*Copy item ticket*). | — | — |
| 8 | **Wait a minute or two.** | The job changes from **Awaiting files** to **print file(s) received**. | Still waiting after 5 minutes → check the watcher line on Incoming Print Files. |
| 9 | **Check the file is on the right item.** Job page → Files. | Each file is listed under the item it belongs to. | File sits in Incoming Print Files as *Needs review — link to job* → **Assign to…**, pick the job and item. |
| 10 | **Check the routed name.** | `<item ticket>__<your file name>.pdf`, for example `GSO-20261120-0001-01__heath_F_CMYK.pdf`. Your original file is untouched. | Any other name → stop, tell Claude. |
| 11 | **Check the printer's folder.** Mimaki: `C:\MijCtrl\Hot\UCJV-300`. Roland: the VersaWorks input folder. | The file (both layers, for CMYK + Gloss) is there, in the **same** printer's folder. | Layers at two different printers → stop. Do not print. |
| 12 | **RIP it** in RasterLink (or VersaWorks) as usual. | The job in the RIP carries the item ticket in its name. | — |
| 13 | **Print.** Then, for the Mimaki: tell Claude the job ticket. Claude runs the result sync once by hand. | The job page shows *Press result — Run 1 — Original* with ink (mL) and time. | Nothing appears → the result had no ticket in its name. Tell Claude. Nothing is guessed. |
| 14 | **Check it landed on the right item and run.** | The press result is on the item you printed, not on the others. Compare the ink with RasterLink's own screen: CMYK matches; gloss / clear = both clear slots added. | Wrong item → real defect. Stop and tell Claude both item tickets. |
| 15 | **QC.** Job page → QC step → **QC PASS** on each item. | Board card shows *QC passed*. | Fails QC → **NEEDS REPRINT** (see below). |
| 16 | **Finish.** Pack → **Ready to ship** or **Ready for pickup** → record the shipment or pickup → **Complete Job**. | Job leaves the board. | "Record shipment first" → a job completes only after shipment or pickup is recorded. |

## Optional but worth doing once: prove a reprint

Only if a piece really needs it — do not invent one. On the item press **NEEDS REPRINT**, enter the
quantity, the reason and who pays. Then put the same files in the job folder again.

- [ ] The files arrive as `…__P1-A1.pdf` — **every** layer of that item, same run mark.
- [ ] The job page shows **Run 2 — Reprint** with its own quantity.
- [ ] The ordered quantity did not change.
- [ ] The item needs a new **QC PASS**.
- [ ] After printing and the sync: Run 2 has its own ink and time, separate from Run 1.

## After steps 13 and 14 pass

Claude runs the same sync a second time: nothing changes (no second result, ink not doubled). Then
the Mimaki result sync is switched on so it runs by itself — see
`docs/GSO_MIMAKI_RESULT_SYNC_ENABLEMENT.md`. Roland stays manual CSV.

## Things that are normal

- Shopify is not updated by the ERP. If the job came from a Shopify order, mark it fulfilled in Shopify by hand.
- The job page shows mL and minutes to production staff, never dollars.
- A file with no job waits in Incoming Print Files. It is never printed and never makes a job.
