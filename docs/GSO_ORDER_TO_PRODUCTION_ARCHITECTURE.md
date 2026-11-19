# GSO ERP — Order → Job → Item → File → Reorder → Reprint architecture

Written 2026-11-19 from a read of the code at `2eb6bd6` plus the changes listed in section 30.
"Verified" means read in code or measured; anything else is labelled as a proposal or an owner decision.
QuickBooks facts come from three read-only lookups through the Claude QuickBooks connector on 2026-11-19
(invoices and estimates dated 2026-10-15 → 2026-11-19, and a customer search). Nothing was written to QuickBooks,
Shopify or the production database.

---

## 1. Executive summary

1. **The canonical job service already exists.** `createProductionJobFromSource`
   (`app/lib/production-job-source.server.ts`) is the only code that creates a `ProductionJob`. Shopify paid
   orders, paid ERP quotes and the New Job form all call it. It creates one master job, one item per line,
   `GSO-YYYYMMDD-NNNN` and `-NN` item tickets, is idempotent per source, locked against concurrent retries and
   shop-scoped. Nothing needs to be rebuilt; new sources plug into it.
2. **The real business is in QuickBooks, and QuickBooks has no path into the ERP.** QuickBooks holds 33 invoices
   for the last five weeks (numbers 1210–1271) and zero estimates. The ERP holds 18 jobs, all tests. The repo
   contains no QuickBooks code at all — only comments saying it is deferred. That gap, not Print Intake, is why
   files arrive with no job.
3. **CRUD work is very probably QuickBooks customer "krud Cafe"**, invoices 1268 (2026-11-13) and 1270
   (2026-11-15). Both were still unpaid while their files were being printed. Owner to confirm the match.
4. **One QuickBooks line is not one production item.** Invoice 1270 line 1 is "Sticker Bag 4x5 … (Qty:128 – 20
   designs)", quantity 2,560, with the design names typed into the description. A job needs 20 items from that
   one line. QuickBooks ingestion therefore needs a human "release to production" step that splits lines into
   items; it cannot be fully automatic from the invoice alone.
5. **The ERP's built-in release rule does not match how invoiced work actually runs.** ERP quotes release
   production only when fully paid. 11 of the 33 QuickBooks invoices carry a balance, and production started
   on at least the krud ones. The release rule for QuickBooks is an owner decision (section 33).
6. **Schema fitness:** master job / item / item ticket is fully supported today. Reorder lineage, a
   file-to-item link, artwork versions and production runs are not modelled; reprints exist as counters and
   events, not as a run record. Proposed additions are all nullable columns or new tables (section 29).
7. **Implemented now (section 30):** routed print files are named `<item ticket>__<staff file name>`; a sibling
   layer is no longer mislabelled as a revision; the New Job form takes several items; the job card shows the
   job folder name.
8. **Recommended order of build:** QuickBooks moves up — it is where the orders are (section 32).

---

## 2. Current-state diagram

```
 Shopify storefront order ──orders/paid webhook──┐  (configurator lines only; automatic)
 ERP quote ─ draft order ─ paid ─ staff click ───┤  (fully paid only; manual click)
 New Job form ───────────────────────────────────┤  (staff; now multi-item)
                                                 ▼
                              createProductionJobFromSource
                                                 ▼
                    ProductionJob  GSO-YYYYMMDD-NNNN
                      └ ProductionJobItem  …-01, …-02
                                                 ▲
 QuickBooks invoices (the real business) ── NO PATH ──✗

 Staff file in PRINTS FOR TODAY ─ watcher ─ route-plan ─┬ exact match → routed to press, recorded on job
                                                        └ no match   → NEEDS REVIEW — LINK TO JOB (no job made)
 Press ─ RIP result ─ (Mimaki sync not registered; Roland manual CSV) ─ PrintLogEntry (job / item)
```

## 3. Desired-state diagram

```
 QuickBooks invoice/estimate ─┐
 ERP quote ───────────────────┤                       ┌ release rule per source (owner-configured)
 Shopify order ───────────────┼─► Source transaction ─┤ lines → production items (auto when 1:1,
 Manual New Job ──────────────┤   (staged, idempotent)│  human split when a line holds many designs)
 Agent-prepared approved quote┘                       └ reorder / revision reference per item (explicit)
                                        ▼
                     createProductionJobFromSource  (the one service)
                                        ▼
              ProductionJob ─ ProductionJobItem ─ ProductionRun (1 = original, 2+ = reprint)
                                   │                    │
                    ProductionJobFile (item, version)   PrintLogEntry (item, run) → actual ink / time
                                   ▲
   Staff saves files in  PRINTS FOR TODAY\GSO-YYYYMMDD-NNNN CUSTOMER\  → matched, renamed, routed
   Reorder = new transaction → new job, items point at the items they repeat
```

---

## 4. Existing job-creation paths (verified)

All three go through `createProductionJobFromSource`. Idempotency key is stored in `ProductionJob.quoteId`
(a quote id, `shopify_order_<id>`, or `manual_<requestId>`); the check-then-create runs inside one transaction
behind a Postgres advisory lock keyed on shop + source type + source id; a ticket collision reruns the whole
transaction.

| | Shopify paid order | ERP quote | New Job form |
|---|---|---|---|
| Trigger | `orders/paid` webhook | staff click "create job" on Quotes or Production page | staff submits form |
| Automatic | yes | no | no |
| Lines that become items | configurator lines only; other lines are listed in a note | every quote item | every entered item |
| Master job / tickets | yes / `-NN` per line | yes / `-NN` per item | yes / `-NN` per item |
| Customer, company | from order (text) | from quote (text) | name typed (text) |
| Quantity, SKU, product, variant | from line | from quote item | typed (SKU optional) |
| Production requirements | canonical line snapshot (finish, add-ons, material summary) | quote cost snapshot, finish, recipe | family, finish, size, notes |
| Printer preference | none stored (decided at intake) | the press the quote was costed on | chosen or Auto → resolved press |
| Source order id | `orderGid` + `shopify_order_<id>` | — | — |
| Source quote id | — | `quoteId` + `QuoteItem` id per item | — (`reference` text → `quoteNumber`) |
| Payment state required | paid (webhook fires on paid) | quote status `paid` or `production` (fully paid) | none |
| Idempotency | stable order id; id-less payload refused | quote id | client `requestId` |
| Retry / duplicate | replay returns the existing job | second click returns the existing job | double submit returns the existing job |
| Fails closed when | no configurator line → review queue item, no job; raw-variant bypass → held | provisional pricing, blocked DTP, missing costs, not fully paid | missing name / quantity / unresolved press |

Paths asked about that do **not** create jobs:

- **Shopify draft order paid** — it arrives as `orders/paid`. If it carries a Quote ID the quote's status moves
  (deposit_paid / paid, verified against the stored draft order); the job still needs the staff click.
- **ERP quote → Shopify draft order** — creates the draft order and invoice link only.
- **Wholesale order** — a normal Shopify order; a job only if it has configurator lines.
- **Repeat / reorder flow** — none exists (section 18).
- **Invoice-related paths** — none. `ops/invoice-readiness.ts` only reports readiness; it is not called by any route.
- **Print Intake** — never creates a job (Patch C). Unchanged.

## 5. Missing job-creation paths

1. **QuickBooks invoice / estimate** — nothing exists. This is the path the business actually uses.
2. **Automatic job from a paid ERP quote** — the webhook marks the quote paid and stops; a person must click.
3. **Reorder** — no action, no lineage field.
4. **Customer-paid replacement** referencing an original item — no model.
5. **Cancellation** — no `orders/cancelled` or refund webhook is registered; a cancelled Shopify order leaves its
   job untouched. No rule is encoded; owner decision.

## 6. Canonical transaction → job service

Keep `createProductionJobFromSource` as the single entry. Recommended extension (not built):

```ts
| { type: "released_transaction";          // QuickBooks, agent-approved quotes, future sources
    sourceSystem: "quickbooks" | "agent";
    sourceRecordId: string;                // QuickBooks invoice/estimate Id (stable)
    sourceDocNumber: string;               // "1270" for staff
    releasedBy: string;                    // person or rule that released it
    customer: { name; company?; email?; phone?; externalCustomerId? };
    items: Array<ManualJobItemInput & {
      sourceLineId?: string;               // QuickBooks line Id
      reorderSourceItemId?: string;        // explicit, never inferred
      artworkBasis?: "new" | "same_as_source" | "revision_of_source";
    }>;
  }
```

It reuses the manual branch's validation and press resolution, keys idempotency on
`quickbooks_invoice_<Id>` (same column, same lock), and writes the source reference. Shopify, quotes, manual,
QuickBooks and agents then all meet in one function; no source gets its own job model.

Already true of the service: idempotent, retry-safe, shop-scoped, duplicate-safe, and it never reads prices or
status from the browser.

## 7. Master job / item model

`ProductionJob` (master) → `ProductionJobItem` (one per production item) is exactly the requested structure and
is live. Customer and order history sit on the job; quantity, product, finish, press, cost snapshot, QC and
reprint markers sit on the item. `PrintLogEntry` carries both `productionJobId` and `productionJobItemId`.

Gaps: `ProductionJobFile` has **no item column** (the item is only written into the notes text), and there is
no customer table — customers are text on each job and quote.

## 8. Ticket generation

`allocateJobTicket` — `GSO-YYYYMMDD-NNNN`, sequence per shop per day, unique index `(shop, jobTicket)` as final
authority, fails loudly rather than minting a non-canonical ticket. Item tickets are `jobTicket-NN` in line
order, unique on `(shop, itemTicket)`. Two limits to know:

- Two digits: an item beyond 99 would not be a valid ticket. The New Job form now caps a job at 50 items. A
  QuickBooks release must enforce the same cap (split into two jobs above it).
- The date is the server's UTC date at job creation, not the invoice date.

Recommendation: keep both formats exactly as they are.

## 9. Production statuses

Existing staff list (`production-status-vocabulary.ts`): new, prepress, proof_needed, proof_sent,
proof_approved, ready_to_print, printing, cutting, laminating, qc, packing, ready_for_pickup, shipped,
picked_up, completed, on_hold, reprint_needed, cancelled. Completion requires a shipment or pickup record and
QC pass on every item.

Mapping to the requested lifecycle — no replacement needed:

| Requested | Today |
|---|---|
| Awaiting production release | not a job status — it is the state of the source transaction before a job exists (section 12) |
| Job created | `new` |
| Awaiting artwork / artwork ready | `prepress`, `proof_needed` → `proof_approved` |
| Files received / routed | derived from `PrintIntake` + `ProductionJobFile`, shown on the job; not a status |
| RIP / printing / finishing | `ready_to_print`, `printing`, `cutting`, `laminating`, `qc`, `packing` |
| Complete | `shipped` / `picked_up` → `completed` |
| Reprint | `reprint_needed` at job level + run record at item level (section 23) |

One proposed addition: a derived "Awaiting files" badge (job is `new`/`prepress` and no routed print file).
A reorder is a normal new job; it needs no status.

## 10. Shopify flow (verified)

`orders/paid` → HMAC-verified webhook → quote-payment branch if the order names a quote → otherwise bypass
check → `createProductionJobFromSource`.

- Paid order: one job, one item per configurator line, canonical snapshot authoritative.
- Draft order: becomes an order when paid; see section 4.
- Replay: same order id → existing job returned, nothing written.
- Multiple lines: yes, one item each. Non-configurator lines are skipped and listed.
- No configurator line: no job; an owner review item is created.
- Raw variant of a configurator-only product: held for review, no job.
- Stock Bag personalization and Zakeke designs: attached as job files inside the same transaction.
- Cancellation / refund: not handled (no webhook). Owner decision.
- There is no ERP "order" record; the job is the order record. No defect found that needed a fix here.

## 11. ERP quote flow (verified)

Quote statuses: draft → sent → approved → deposit_paid → paid → production → completed, plus won / lost /
canceled / expired. Money moves only through Shopify draft orders (deposit, balance or full); the webhook
verifies the paying order against the quote's stored draft order. A job can be created only from `paid` or
`production`, by a click.

Fragmentation found:

- "Quote", "estimate" and "invoice" are three words for two things. In the ERP an invoice is a Shopify draft
  order's payment link. In QuickBooks the invoice is the sale itself and there are no estimates.
- Two release rules exist in practice: ERP = fully paid; QuickBooks practice = invoice issued (often unpaid).
- Paid quote → job needs a manual click; paid Shopify order → job is automatic.

Recommendation: one release transition, "transaction released to production", recorded once per source
transaction with who or what released it, and one rule per source that the owner sets (section 12).

## 12. QuickBooks integration boundary

**What exists in the repo: nothing functional.** No OAuth, no API client, no webhook, no polling, no invoice /
estimate / customer / payment sync, no adapter, no environment variable, no credential setting. The only
mentions are comments and labels: "QuickBooks DEFERRED" in `ops/agent-registry.ts`, `ops/autonomy.ts`
(`send_invoice: "DISABLED"`), `ops/invoice-readiness.ts`, `ops/reporting.ts`, `slack/slack-blocks.ts`, and the
Owner Readiness row "QuickBooks — Not connected (CSV exports only)".

**What QuickBooks looks like (read 2026-11-19):** 33 invoices in five weeks; 0 estimates; 11 with a balance;
most lines use the generic item "Custom Item" (31 lines) with the real specification in free text; some use
structured items ("Sticker Bags:SB - 4x5 - CQ - DS", "100ml Tall Miron Jar - Matte + 3X Spot Gloss - 64-256");
lines also include discounts, shipping, design fees and "Old Balance"; one line can hold many designs.

**Boundary (proposed):**

```
QuickBooks ──(read only)──► ingest ──► SourceTransaction (staged copy, one row per invoice/estimate)
                                            │  release rule + human split of lines into items
                                            ▼
                                 createProductionJobFromSource
```

- The ERP reads QuickBooks. It does not write invoices, payments or customers back.
- Ingest by polling changed invoices first (simple, no public endpoint to secure); webhooks later if wanted.
- Idempotency: `(shop, "quickbooks", docType, Id)` unique on the staged row; the job key is
  `quickbooks_invoice_<Id>`. The same invoice seen again never makes a second job.
- An updated invoice refreshes the staged row and flags a difference against the released job for a person; it
  does not silently change a job that has started.
- Void / delete: flag the job for review. What happens to production is an owner rule (not invented here).
- Release rule: a setting with the values `manual` (a person presses Release — safe default),
  `on_invoice_created`, `on_deposit_received`, `on_invoice_paid`, `on_estimate_accepted`. Only `manual` needs
  no decision.
- Line classification: production / design service / discount / shipping / prior balance / unknown. Stored
  mapping by QuickBooks item Id; "Custom Item" and unmapped items are always classified by a person.
- Customer matching: by stored QuickBooks customer Id only (section 29). No name matching.
- Reorder: a person ticks "reorder of" and picks the prior item at release. Never inferred from customer and
  product alone.

**Needed from the owner before any of it can run:** an Intuit developer app (client id and secret), consent for
the company, and the release rule.

## 13. Manual-job flow

The New Job form stays as the entry for walk-ins, internal work and — until QuickBooks is connected — every
invoiced job. From today it accepts several items in one job and the reference field is labelled for the
invoice number. It needs no payment and invents no price (prices stay 0 = not entered).

## 14. File matching (verified, unchanged)

Order of rules in `decideIntakeRoute`, all exact: (a) item ticket in the file name; (b) job ticket in the file
name, single-item job only; (c) job ticket at the start of the parent folder name, item only if certain;
(d) exact stored print-file name on one item; (e) exact stored job file name, single-item job only. Anything
else → review. A file name ticket that disagrees with its folder → review. Closed job → review.

Kept as is: no job from a file, no fuzzy matching, cutoff and flood cap in the watcher, idempotent
`ProductionJobFile` per job + file hash, source artwork separate from print files, sibling layers decided as
one job, press conflicts to review.

## 15. Auto-renaming (implemented)

Before: every file of an item routed as the bare item ticket (`GSO-…-01.pdf`). The second layer of the same
item collided and the watcher fell back to `GSO-…-01-<hash8>.pdf`; the job recorded a name that was not the
name on disk; and the second layer was numbered as revision 2.

Now, format: `<ITEM TICKET>__<staff file name>[__<run>]<.ext>`

```
crud_HEATH_F_CMYK.pdf  on item GSO-20261119-0042-01  →  GSO-20261119-0042-01__crud_HEATH_F_CMYK.pdf
crud_HEATH_F_g.pdf                                   →  GSO-20261119-0042-01__crud_HEATH_F_g.pdf
```

- Deterministic: same item + same staff name → same routed name; a retry reuses it.
- Staff name kept in its own case; characters outside `A–Z a–z 0–9 . -` become `_`; `__` is reserved as the
  separator; at most 80 characters, keeping the end (layer suffix) when cut; whole name ≤ 120.
- Extension preserved by the watcher. Layer suffix and ROLAND / MIMAKI tag remain in the name.
- A ticket the staff typed is not repeated. A file named only with the ticket keeps the bare name.
- The RIP result still carries the exact item ticket, so results match at item level as before.
- The watcher needed no change: it already uses the name the server returns.
- Items with a custom RIP name (not equal to the item ticket) keep the old behaviour.
- Original staff name stays on `PrintIntake.originalFilename` and `ProductionJobFile.originalFileName`.

## 16. Multi-item matching

Unchanged and correct: the folder identifies the job; the item is taken only from an item ticket in the file
name, an exact stored file name, or a person's assignment. Otherwise NEEDS REVIEW — LINK TO ITEM. The job card
now tells staff to start each file with the item ticket on multi-item jobs.

Proposed next (O3): let staff attach an expected file name to an item ("this item's files are
`crud_HEATH_F_*`" is still a pattern — so store exact names only), or create per-item subfolders
`…\GSO-…-0042 CRUD\01\`. The subfolder option needs a watcher change (it scans one level) and is the more
natural habit for 20-design jobs. Owner preference wanted.

## 17. Artwork / version model

Today: `ProductionJobFile` with `fileType` (artwork, proof, dieline, customer_pdf, print_file, image, other),
`assetRole` (productImage, artwork, proof, printFile, reference), `assetSource` (manual, google_drive, shopify,
zakeke, email, nas, …), `originalFileName`, `sourceRef` (file hash for print files); job-level `artworkUrl`,
`proofUrl`, `printFileUrl`; proof status on the job. Source artwork and routed print files are already distinct
rows. Missing: item link, version number, "supersedes", "approved" marker per file, "reused from".

Proposed columns on `ProductionJobFile` (all nullable): `itemId`, `version` (int), `supersedesFileId`,
`reusedFromFileId`, `approvedAt`, `approvedBy`, `runId`. With them the seven cases are distinct:

| Case | Representation |
|---|---|
| Source artwork | `assetRole=artwork` |
| Approved artwork | same row with `approvedAt` set |
| Production file | `fileType=print_file`, `assetSource=nas` (exists) |
| Revised artwork | new row, `supersedesFileId` → old, `version+1` |
| Reorder reused artwork | new row on the new item, `reusedFromFileId` → old row (old row untouched) |
| Reprint same file | same file row, new run references it |
| Reprint revised file | new version row + new run |

## 18. Reorder architecture

Nothing exists today: no reorder or duplicate action on quotes, jobs or items, no lineage field.
`ops/reorder-marketing.ts` is a library function that lists old jobs for a draft message; no route calls it.
The only "repeat order" notion is the DTP design-fee waiver checkbox in the Cost Calculator.

Design: a reorder is a new sale → new transaction → new master job → new item tickets. Each new item may carry
`reorderSourceItemId` pointing at the item it repeats (explicit choice by a person, or by an agent proposal a
person approved). Old job and files are never modified. The job is created only at the normal release step.

UI (proposed): a Reorder button on a completed job / item → pick items, new quantities, same artwork or
revision, option changes → creates a new **quote** priced now. For QuickBooks-invoiced customers, the same
picker appears at release time ("this line is a reorder of …").

## 19. Reorder file reuse

"Same artwork": the new item gets new `ProductionJobFile` rows with `reusedFromFileId` pointing at the old
approved print files; proof approval is carried as "approved — reused from <old item ticket>". Staff copy the
archived originals into the new job folder (the routed archive keeps them under their staff names); the watcher
routes them under the **new** item ticket, so new ink and time attach to the new item. Automating that copy is
a later watcher feature; it must never move or rename the old job's files.

## 20. Reorder pricing

The reorder creates a quote through the existing Cost Calculator path, so price comes from today's approved
ladder for the new quantity. The old item's `unitPrice` and snapshots are left as history and shown beside the
new price for reference. A staff override follows the existing override rules. No price is copied forward.
(For QuickBooks-invoiced reorders the price is whatever the invoice says; the ERP does not reprice it.)

## 21. Reorder + revision

`artworkBasis = revision_of_source`: the old file is linked as the reference (`supersedesFileId` chain starts
from it), proof status starts at `proof_needed`, and the job cannot reach `ready_to_print` on the old approval.
`same_as_source` is the only case that carries approval forward.

## 22. Reprint / remake architecture

Exists today (verified in `app.erp.production.tsx`):

- `reprintItem`: owner reason category required; one unconfirmed reprint at a time per item; resets QC; bumps
  the `PrintIntake` reprint counter and re-routes the file with a run suffix; never creates a job or ticket.
- `revisionItem`: records that corrected artwork is expected.
- `qcItem`: pass / reprint required / hold per item, with run label.
- `reopenReprint`: reopens a completed job to `reprint_needed`, finalized cost snapshot preserved.
- Item fields `goodQty`, `spoiledQty`, `spoilageReason`, `lastReprintReason/By/At`; job field
  `actualReprintCost`.
- Reasons (`REPRINT_REASONS`, hardcoded, owner-set 2026-11-11): machine error, operator error, artwork /
  prepress error, customer change / error, material defect, color / quality issue, shipping damage, other.

Gaps: reprint quantity is not recorded; only the **last** reprint is structured (earlier ones live in events);
charge type (internal vs customer-paid) is not recorded; the reprint counter lives on one `PrintIntake` row, so
**on a two-layer item only the most recent file is re-routed** — a defect for CMYK + gloss jobs, to fix in O5;
RIP results do not record which run they belong to.

Reason list: the requested list (banding, cut issue, gloss / finish, lamination, shortage, wrong artwork, …) is
finer than the owner's 2026-11-11 categories. Recommendation: keep the eight categories as the stored code and
add an optional detail choice under each, rather than replace an owner decision. Owner to confirm.

## 23. Production-run model (proposed; not applied)

The current schema cannot represent Run 1 = 500, Run 2 = 25 banding, Run 3 = 10 cut issue as records.

```prisma
model ProductionRun {
  id            String   @id @default(cuid())
  shop          String
  jobId         String
  itemId        String
  runNumber     Int                       // 1 = original
  kind          String   @default("original") // original | reprint
  quantity      Int
  reasonCode    String?                   // REPRINT_REASONS value
  reasonDetail  String?
  notes         String?
  authorizedBy  String?
  chargeType    String   @default("internal") // internal | customer_paid
  relatedSourceRef String?                // paid replacement: the new transaction
  fileBasis     String   @default("same_file") // same_file | revised_file
  printer       String?
  operator      String?
  status        String   @default("open") // open | printed | qc_passed | qc_failed | cancelled
  createdAt     DateTime @default(now())
  completedAt   DateTime?
  @@unique([itemId, runNumber])
  @@index([shop, jobId])
}
```

Plus nullable `productionRunId` on `PrintLogEntry`, `PrintIntake` and `ProductionJobFile`. Run 1 is created
lazily for existing items; nothing historical has to be rewritten. `PrintIntake.reprintNumber` already equals
`runNumber − 1`, so the current counters map straight across.

## 24. Reprint costing

- Internal remake: no revenue change; item `quantity` (ordered) stays; run quantity is separate; ink, time and
  material of runs 2+ add to the job's actual cost (the existing `actualReprintCost` bucket) and show as waste
  in profitability.
- Customer-paid replacement: a new transaction and a new job, each item pointing at the original via
  `reorderSourceItemId` with a "replacement" flag — it is revenue, so it is a sale, not a run.
- No financial posting is built or proposed here; this only says where the numbers would attach.

## 25. Reprint naming

Same item ticket, run token at the end — the format the code already uses:

```
GSO-20261119-0042-01__crud_HEATH_F_CMYK__P1-A1.pdf      first reprint
GSO-20261119-0042-01__crud_HEATH_F_CMYK__R2-A1.pdf      revised artwork
GSO-20261119-0042-01__crud_HEATH_F_CMYK__R2-P1-A2.pdf   revision 2, reprint 1, second delivery attempt
```

R = artwork revision, P = reprint, A = delivery attempt; absent = R1 / P0 / A1. This differs from the
conceptual `…-01__R2__name` in one way: the run sits after the staff name, because `parseRunIdentity`,
`applyRunSuffix` and their tests anchor on the end and the original run then keeps a clean name. Item identity,
sibling pairing (same stem, same run token), uniqueness and exact RIP matching are all preserved. If the owner
prefers the run before the name it is a contained change in two functions.

## 26. RIP actual linkage

`PrintLogEntry` already links job and item, stores CMYK / white / gloss mL, print minutes and the RIP window,
and the matcher lifts the exact item ticket out of the routed name. Patch F (JobInfo clear codes 136 + 137,
CMYK codes 1–4, $0.09/mL clear, exact job-folder linkage) is unaffected by the new names. To attach actuals to a
run: parse the run token from the result's file name (`parseRunIdentity` exists) and set `productionRunId`;
results with no token belong to run 1. Mimaki gloss behaviour is unchanged by this work: explicit Roland →
Roland, explicit Mimaki → Mimaki, CMYK and CMYK + gloss default to Mimaki, white rules unchanged, primer separate.

## 27. Fulfillment implications

Shipment / pickup records stay on the master job. A multi-item job ships as one or several packages already.
A reprint run blocks completion through the existing QC guard. A reorder is its own job with its own shipment.
Not designed here: partial shipment per item, and writing fulfillment back to Shopify (neither exists).

## 28. Agent compatibility

Agents get no production path of their own. Lead → quote (draft, staff approves) → payment → the same release
transition → the same service. A reorder agent prepares a "reorder proposal" (prior item, quantity, current
price from the calculator) as a review-queue item; approval creates a normal quote. The existing rule holds:
`ops/production-transitions.ts` fails closed on statuses it does not know, and nothing in the agent code can
create a job.

## 29. Required schema changes (proposed; none applied)

All additive and nullable; no existing column changes meaning.

1. `ProductionJob`: `sourceSystem`, `sourceRecordId`, `sourceDocNumber` (today the source hides inside `quoteId`).
2. `ProductionJobItem`: `sourceLineId`, `reorderSourceItemId`, `artworkBasis`, `isReplacement`.
3. `ProductionJobFile`: `itemId`, `version`, `supersedesFileId`, `reusedFromFileId`, `approvedAt`,
   `approvedBy`, `productionRunId`.
4. `ProductionRun` (new) + `productionRunId` on `PrintLogEntry`, `PrintIntake`.
5. `SourceTransaction` (new): shop, sourceSystem, docType, externalId, docNumber, customer external id and
   name, totals, balance, raw payload, sync token, release state (awaiting_release / released / held / ignored /
   voided), releasedAt / By, productionJobId; unique `(shop, sourceSystem, docType, externalId)`.
6. `CustomerAccount` (new): display name, company, contact, `quickbooksCustomerId`, `shopifyCustomerGid`;
   optional `customerAccountId` on job and quote. There is no customer table today.
7. `ExternalItemMapping` (new): QuickBooks item Id → line kind and production family.
8. Integration credential storage for QuickBooks tokens (encrypted), following the existing agent-credential
   pattern.

## 30. Code changes

**Implemented 2026-11-19 (tests in `tests/order-to-production-routed-names-2026-11-19.test.ts` and
`tests/manual-job-multi-item-2026-11-19.test.ts`):**

- `print-intake-routing.server.ts`: `routedStaffNameSegment`, `ripFileBaseName(item, staffFileName)`; both
  route-plan branches pass the staff name.
- `api.print-intake.route-plan.tsx`: a new file hash on a routed ticket is a revision only when the staff file
  name is the same; a different name is another file of the item (run 1).
- `production-job-source.server.ts`: `parseAdditionalManualItems`, 50-item cap.
- `app.erp.production.tsx`: New Job form "more items" box and invoice reference label; job card shows the job
  folder name with a copy button and the multi-item naming hint; stale gloss sentence corrected.

**Still required:** `released_transaction` source; QuickBooks client, ingest, release screen; file → item
link and backfill from notes; reprint applies to every current file of the item; ProductionRun; reorder action;
result → run attribution; cancellation handling once a rule exists.

## 31. Migration risks

- Every proposed column is nullable, so deploys are safe before and after the migration; old rows stay valid.
- `quoteId` doubles as the idempotency key. Adding `sourceRecordId` must not change that lookup until both are
  written and verified; a unique index on `(shop, quoteId)` should wait for a duplicate check on live data.
- Backfilling `ProductionJobFile.itemId` from the "Item: …" note line is a data repair; run it as a reviewed,
  reversible script, not by hand.
- Routed-name change: files already routed keep their recorded names; only new deliveries use the new format.
  A file re-planned after this deploy gets the new name (deterministic from then on).
- Production currently holds only test jobs, which makes this the cheapest moment for the schema work.

## 32. Implementation phases (resequenced on the evidence)

| Phase | Content | Blocked on |
|---|---|---|
| O1 | Canonical service — **exists**. Add `released_transaction` source + source reference columns. | nothing |
| O2 | Routed filename automation — **done**. | — |
| O3 | Job-first workflow — multi-item New Job and folder name **done**; next: file → item link, expected file names or item subfolders, "Awaiting files" badge, reprint covers all layers. | subfolder preference |
| O4 | **QuickBooks ingestion** (moved up: it is where the orders are). 4a read-only list of invoices without a job + manual Release with line split. 4b automatic release by rule. | Intuit app credentials; release rule for 4b |
| O5 | ProductionRun + reprint quantities, charge type, result → run. | review of section 23 |
| O6 | Reorder action, lineage, file reuse, revision flow. | review of sections 18–21 |
| O7 | Agent integration (reorder proposals, approved quotes into the same release). | O4–O6 |
| O8 | Live validation — but the first live validation should happen **now**: one real job entered, files saved in its folder, first Mimaki result verified (this also closes Patch F). | a real job |

## 33. Owner decisions still required

1. Which QuickBooks state releases production: manual release, invoice created, deposit received, invoice paid,
   or estimate accepted. (Observed practice: production starts on unpaid invoices.)
2. Confirm CRUD = QuickBooks customer "krud Cafe" (invoices 1268, 1270).
3. Intuit developer app and consent for the ERP to read QuickBooks.
4. What a voided / cancelled / refunded transaction does to a job in progress (QuickBooks and Shopify).
5. Should a fully paid ERP quote create its job automatically.
6. Multi-item jobs: item ticket at the start of the file name (works today) or one subfolder per item.
7. Reprint reasons: keep the eight categories with optional detail, or replace with the finer list.
8. Run token position in file names: after the staff name (current) or before it.
9. Customer-paid replacement: new job linked to the original (recommended) — confirm.
10. Whether QuickBooks-invoiced jobs should carry the invoice prices into the ERP for profitability, or stay
    cost-only.
