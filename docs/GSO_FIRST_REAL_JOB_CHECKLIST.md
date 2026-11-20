# First Real Job — Checklist

One real Mimaki job, entered and printed normally, proves ten things at once. Written 2026-11-20.
Nothing here needs code. Tick each line; if a line does not match, stop and write down what you saw.

**Status today:** the software is ready and tested with fixtures. It has **not** been proven on the
press. Do not import old results to "test" it — only this job's own results count.

## Before you start (2 minutes)

- [ ] **Incoming Print Files** shows a green line: *The print-file watcher is running*.
      Red or amber: on the RIP PC, sign in to Windows or start the task **GSO Print Intake Agent**.
- [ ] You can open **Production → New Job** (owner, manager or print operator).

## The ten checks

| # | What to do | What you should see | Proves |
|---|---|---|---|
| 1 | **Production → New Job.** Customer, first item, quantity, finish. Put the other designs under *More items* (`name \| quantity`, one per line). Invoice number under *More details → Reference #*. | *Job created* with a ticket like `GSO-20261120-0001`. The job is on the Production Board under **New**, showing **Awaiting files**. | Production job |
| 2 | Open the job. | One **item ticket** per item: `…-01`, `…-02`, … each with a **Copy** button. | Item tickets |
| 3 | In **Prints For Today**, make a folder named exactly the job ticket (*Copy job folder name*). Save the print files in it. More than one item: start each file name with its item ticket. | Within a minute or two the job shows **print file(s) received**. On the press PC the file is named `<item ticket>__<your file name>.pdf`. | Routed file name |
| 4 | Save both layers of one item (`…_CMYK.pdf` and `…_g.pdf`) in the same folder. | Both arrive at the **same** printer, both with the same item ticket in front. | CMYK / gloss pairing |
| 5 | Print the job on the Mimaki as usual. | RasterLink writes its result into `…\rasterlink\incoming\UCJV-300` — the result's name contains the item ticket. | RasterLink result |
| 6 | Nothing to do. | In the same RasterLink job folder there is a `JobInfo.ini`. | JobInfo (clear ink) |
| 7 | **Tell Claude the job ticket.** Claude runs the result sync once by hand and reads the outcome. | The job page shows *Press result — Run 1 — Original* on the **right item** (not on the other items of the job). | Correct item |
| 8 | (Optional, strongest proof) On one item press **NEEDS REPRINT**, quantity 1–2, reason, *internal*. Drop the same files in the folder again and print. | The file arrives as `…__P1-A1.pdf`. The job page shows **Run 2 — Reprint** with its own ink and time, separate from Run 1. | Correct run |
| 9 | Compare with RasterLink's own screen. | CMYK mL and clear / gloss mL on the job page match what RasterLink shows for that job (clear = both clear slots added). | Ink totals |
| 10 | Claude runs the same sync a second time. | Nothing changes: no second press result, ink not doubled. | Safe to repeat |

## After all ten pass

- Claude registers the Mimaki result sync so it runs by itself:
  `powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"`
- Patch F is then **live validated**, and RIP actuals for the Mimaki are automatic. Roland stays manual CSV.

## If something does not match

| You see | Most likely | Do |
|---|---|---|
| File stays in Incoming Print Files as *Needs review — link to job* | The folder name is not exactly the job ticket, or a multi-item job's file has no item ticket in front | Use **Assign to…** and pick the job and item. Do not rename the file to a made-up ticket. |
| Job still says *Awaiting files* after 5 minutes | Watcher not running, or the file is still being saved | Check the banner on Incoming Print Files. |
| Press result shows on no item | The result's name has no ticket (file was printed from somewhere else) | Tell Claude. Nothing is guessed: it waits in RIP Import Review. |
| Press result on the wrong item | Stop. This would be a real defect. | Tell Claude the job ticket and both item tickets. |

## What this job also exercises

QC pass per item → **Ready to ship / Ready for pickup** → record shipment or pickup → **Complete Job**.
Shopify is not updated by the ERP: if the job came from a Shopify order, mark it fulfilled in Shopify by hand.
