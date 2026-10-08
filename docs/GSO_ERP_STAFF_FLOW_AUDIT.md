# GSO ERP — Staff Flow Audit (2026-10-05, overnight finish-line)

Branch `gso-erp-overnight-finishline-2026-10-05`. Documented from the code, not from memory.
Scope of tonight's edits: **display / copy / grouping / collapse only** in four routes —
`app/routes/app.quotes.tsx`, `app/routes/app.erp.production.tsx`,
`app/routes/app.erp.agent-review-queue.tsx`, `app/routes/app.erp.ops-hub.tsx`.
No loader, action, status validation, transition, permission, approval semantics, Slack behaviour or DB
write changed. Every pre-existing form field name and intent value is pinned by
`tests/staff-ux-copy-2026-10-05.test.ts`.

Status vocabulary used across the four pages (same meaning, same colour):

| Word | Colour | Meaning |
|---|---|---|
| READY TO QUOTE / VERIFIED / COMPLETED | green | confirmed data, finished work |
| PROVISIONAL / OWNER CONFIRMATION PENDING / NEEDS DECISION | amber | a human still has to confirm or decide |
| BLOCKED / FAILED / EXECUTION BLOCKED | red | cannot proceed |
| everything else (counts, tickets, informational) | grey | no judgement implied |

---

## Flow A — New customer quote → cost → price → draft

### A1. Cost Calculator (`app.erp.cost-calculator.tsx`, read only — 4440 lines, hand-rolled HTML)

| Step | What staff do | Where |
|---|---|---|
| 1 | Pick **STEP 1 — What are you pricing?** (family select; auto-submits GET) | L3268–3300 |
| 2 | `* Select product / blank item` (jars also `* Top type`, `* Label set`, optional tamper band) | L3300–3348 |
| 3 | `* Quantity`, `* Number of designs` | L3331–3332 |
| 4 | Non-jar: `* Print width/height (in)`, `* Material`, `Printer` (Auto/Mimaki/Roland), white/gloss layers + coverage, cut type | L3470–3564 |
| 5 | **CALCULATE COST** → canonical panel (`VALID` / `PROVISIONAL` / `DRAFT_ONLY`, `BLOCKERS (n)`) | L3593, L3781–3839 |
| 6 | **RECOMMENDED CUSTOMER PRICE** tier table, radio per tier (`READY TO QUOTE` / `BLOCKED` / `BELOW FLOOR — override required`) | L4268–4288 |
| 7 | `Product name`, `Customer (optional)` → **SAVE DRAFT QUOTE** (`intent=saveEmergencyQuoteDraft`, `db.quote.create` with cost/price snapshots) | L4430–4435, L2409 |

Confusing (read-only, NOT fixed tonight — needs the calculator owner):
- No visible page title (the `<h1>` is inside the `?legacytools=1` block); only an `<h3>` "Cost Calculator" (L2676).
- Release-ticket codes in staff copy: `Specialty file prep (15G.4C)`, `Canonical true cost 17D.7`, `legacy 14C.2` (L3503, L4060, L2684).
- Canonical header prints engine routing + version (`{family} → {entry}`, `canonical.version`) and `Ink $/mL` to 7 decimals; all money in that panel to 4 decimals (L3804–3807, L3950, L3790).
- Raw doc paths shown as instructions (`docs/GSO_PRODUCT_SPEC_OWNER_DECISIONS.md`, L3402, L4262).
- Two save forms (`Product name` / `Customer` at L2818 and L4433) and two tier tables (canonical L4268, manual L2787).
- The green "trust card" the staff workflow doc tells people to read sits inside the collapsed "Advanced diagnostics" `<details>` (L2683 → L4059).
- **Handoff gap:** saving a draft shows only a text flash "Open Quotes to finish it." — no link, no redirect to `/app/quotes` (L2434). Product Setup is linked only inside the hidden legacy block.

### A2. Quote Builder (`app.quotes.tsx`, edited)

Click path after tonight's pass (same state and handlers, re-grouped):

| # | Section (heading) | Fields | Notes |
|---|---|---|---|
| 0 | Flow strip: "Building a new quote" / "Editing an existing quote" | **New quote** (primary button), Open Cost Calculator | `resetQuote` unchanged |
| 1 | **1 · Customer** | Customer Name, Company, Email, Phone, Customer tier (+ Custom tier label) | Status select moved out of this row to step 9 |
| — | Advanced: look up a Shopify product (collapsed `<details>`) | Search Shopify products | identity only, never price |
| 2–4 | **2 · Product → 3 · Quantity → 4 · Material / finish** (per item) | Product (from Product Setup) select, Quantity, Label finish / production option or vendor add-ons; button **Calculate cost & price from Product Setup** | was "ERP Recipe / Calculate from ERP" |
| 5–7 | **5 · Cost → 6 · Price → 7 · Margin** | Unit Cost (read-only when canonical), Unit Price, Margin % | manual mode shows the same three fields once, in cost → price → margin order (the duplicate price/cost pair that used to appear twice in manual mode is gone) |
| — | Advanced: product image, artwork link, pricing source (collapsed) | Product image URL, Artwork URL optional, pricing source text | raw `pricingSource` / `recipeName` / `selectedFinish` live here |
| 8–9 | **8 · Notes → 9 · Save** | Quote Notes, Status, Save/Update Quote, Print, Email | margin badge `OWNER CONFIRMATION PENDING — below 40% floor` when under floor |

Status/badge words now: `Priced from Product Setup` / `Manual pricing` (grey), `VERIFIED — cost & price from recipe` (green, only after Calculate), `PROVISIONAL — not calculated yet` (amber), `VERIFIED — canonical true cost` (green, protected snapshot), `BLOCKED — below minimum quantity` (red).

Never hidden (checked): low-margin approval badge + reason box + "Items changed since approval - re-approve." (CRM pipeline), canonical read-only cost help text (both layouts), below-minimum badge, server refusals surfaced via `lastMessage`.

Remaining blockers / not done (would require moving logic):
- Manual-line Unit Cost is unverified by design; the server only protects canonical items (`enforceQuoteItemUnitCost`). A true "cost verified" flag for manual lines needs a schema/owner decision.
- The Shopify picker results still flow into each manual item's select (same handler) — cannot be relocated into the item card without moving `productOptions` state.
- `pricingSource` values (`recipe_pending`, `manual_unsupported`) are still raw in the collapsed Advanced block.
- Client-portal URL is hardcoded to the Render host (L2377+) — out of scope.

---

## Flow B — Quote → production job

| Step | Page | Action | Guard (unchanged) |
|---|---|---|---|
| 1 | Quote Builder → CRM Pipeline card | Move status to Paid (or deposit → balance) | `status` intent refuses Sent/Approved/Won while `marginState.approvalRequired` |
| 2 | Quote card | **Create Production Job** (only when status ∈ paid/production) | `createProductionJobFromSource(db, {type:"erp_quote"})` — advisory lock, idempotent; disabled reasons shown verbatim ("Production: balance must be paid first", "…available after full payment", "…must be approved and paid") |
| 3 | Production Board → "Create production job" card | Alternative path: pick an approved/paid quote → **Create from quote** (`createFromQuote`) | same central service; Slack webhook alert if configured |
| 4 | Production Board | job appears under its status group; badge `Production: <status>` on the quote card is grey (green only when completed) | — |

Confusing / remaining: the quote card shows the production job id link only after creation; there is no "Open Production Job" deep-link filter on the board (`?job=` is passed but the board does not scroll/filter — unchanged). Manual jobs (walk-in) bypass quotes entirely via the collapsed "New Manual Job" details on the board.

---

## Flow C — Production job → print intake / RIP → QC → completion

### C1. Production Board (`app.erp.production.tsx`, edited)

At-a-glance row per job (all values from fields the loader already returns):

| Column | Source field | Tone rule |
|---|---|---|
| Job | `jobTicket` (badge) | grey; "No ticket yet" |
| Customer | `company` / `customerName` | — |
| Product | first item `displayTitle` + "(+N more)" | — |
| Quantity | sum of `items[].quantity` | — |
| Status | `labelForStatus(status)` | completed/shipped green; on_hold/reprint_needed/cancelled red; new/proof_needed/proof_sent/qc amber; others grey (was hard-coded green) |
| Due date | `dueDate` | red when > 1 day overdue and not closed |
| Machine | `items[].machineSummary`, else `writebackPreview.printers` "(from print logs)", else "Not assigned" | — |
| Art / proof | `proofStatus`, `proofApprovedAt`, `artworkUrl`, artwork files | approved green; changes requested red; sent / artwork-only / none amber |
| Material | manual `materialUsages` rows + `stockDeductedQty` | "Not logged" amber; logged grey |
| Next action | first incomplete `checklistItems[]` label | amber |

Collapsed tonight: folder name / RIP name / job & quote ids ("Technical identifiers"), per-item ticket / RIP job name / run identity R-P-A ("Item ticket, RIP name and run identity" — Print file name + Copy stay visible because staff need it for Prints For Today), writeback match diagnostics, events older than the latest 3. Badges fixed: `N active job(s)`, `N print log(s) matched`, `N material row(s)` are grey; Final Actual Cost shows `VERIFIED — finalized` / `PROVISIONAL — open`.

Unchanged and visible: finalize gate box (`READY TO FINALIZE` / `WARNING — REASON REQUIRED` / `BLOCKED`), typed owner phrases (`APPLY PRINT LOG ACTUALS`, `OWNER COST REOPEN`), QC / Reprint / Revision forms, status select (validated by `isStaffProductionStatus`).

### C2. Print pages (read only)

| Page | Staff fields | Status words | Confusing (not fixed) |
|---|---|---|---|
| Print Intake (`app.erp.print-intake.tsx`) | review table only: `Assign to…` select (no visible label), `confirm` checkbox; `rejectReason` is read by the action but no input exists | chips Routed green / Needs review amber / Duplicate / Failed red; review table prints raw `row.status` (`retry_allowed`, `legacy_ledger_blocked`) | patch codes in copy (13A.6G, 15H.3, 15G.1A), raw SHA column, config keys (`GSO_MIMAKI_CMYK_STANDARD`), PowerShell "Agent setup" block, **no link to the Production Board** |
| Print Log Import (`app.erp.print-logs.tsx`) | Print software / source, File name / batch name, Upload CSV/TXT/XML, paste box, Import notes → **Import and match logs** | `N/N matched` badge (warning when unmatched) | raw cuid fallback for unnamed rows, `JSON.stringify(row)` can appear as a job name, developer rationale in UI copy, "(Patch 13A.6E)" |
| Auto Import Settings (`app.erp.print-log-settings.tsx`) | Enable toggle, five folder paths, "Expected job ticket pattern (documentation only)" (does nothing), Notes; **Rotate token** | Enabled green / Disabled red | 420px PowerShell textarea, schtasks instructions, filename + patch id in an `<h2>`, raw `source` slugs |
| Work order (`app.erp.production.$id.print.tsx`) | none (print button only) | plain text | raw `Job ID` / `Quote ID` / recipe cuid printed on paper; full file URLs; status rendered by a generic title-case helper (`Qc`) not the vocabulary; no back link |

How the job moves (code facts): artwork is dropped into `\\SynologyNAS\GSOP\GSOP\Prints For Today` named with the ticket (`GSO-YYYYMMDD-NNNN[-NN]`); the PowerShell agent hashes it and asks `/api/print-intake/route-plan`, which matches on item/job ticket, stored filename or job subfolder only; white/gloss → Roland, CMYK → Mimaki, contradictions → Needs review. RIP logs attach on an exact unique ticket. QC is recorded as **events** (`production_run_qc_passed/hold/failed`) — the checklist "QC passed" item is a second, unreconciled QC record. Completion is only the staff `changeStatus` to `completed` (stamps `completedAt`, status_change event only). Reopen → `reprint_needed`, history immutable.

Remaining blockers: two QC records (event vs checklist) need an owner rule; intake review table needs labels + a reject-reason field (logic change); work order needs the vocabulary helper and no raw ids (separate route, not in tonight's scope).

---

## Flow D — Agent proposes → owner reviews (decision only; execution OFF)

Two surfaces, both edited:

### D1. Agent Review Queue (`app.erp.agent-review-queue.tsx`) — quote-intake proposals

| Column | Shows | Source |
|---|---|---|
| Created | date + `via <source>` | `createdAt`, `source` |
| Customer / Product / Qty | name, company/email; family, type; quantity | item fields |
| Status | `NEEDS DECISION` (new, needs_staff_review), `NEEDS DECISION — cost review`, `BLOCKED — missing info` (red), `READY TO QUOTE` (green), `COMPLETED — draft quote created` (green), `REJECTED` (red), `ARCHIVED` (grey) | `status` |
| What the agent wants / why | Wants: `recommendedStaffAction`; Why: `escalationReasons` or missing fields; Evidence: `customerSafeSummary`; last audit event | loaded fields + `auditByItemId` |
| Risk & what approval does | `NEEDS DECISION (staff)` / `APPROVAL FLAG MISSING`; `AUTO QUOTE RISK` (red) or "No automatic quote" (grey); Risk level = `reviewLevel` in words; eligibility badge `NEEDS DECISION` / `BLOCKED` / `COMPLETED` / `CLOSED` with the reason | `requiresStaffApproval`, `canBecomeRealQuoteAutomatically`, `reviewLevel`, status, recipe count |
| Actions | Details; **Create draft quote** (recipe select) only when ready_to_quote and unconverted; status buttons from `TRANSITIONS` | unchanged forms/fields |

Details row adds "Evidence the agent captured", "What happens if approved" (internal DRAFT quote only — no order, invoice, message, production job), "Execution eligibility right now", and a collapsed technical block with ids/flags. Approval remains a decision: the action still requires `status === "ready_to_quote"`, `requiresStaffApproval === true`, `canBecomeRealQuoteAutomatically === false`, and writes only `quote(status:"draft")` + the queue status (pinned by test).

### D2. Operations Hub (`app.erp.ops-hub.tsx`) — durable ActionIntents

Primary view: "Today at a glance" = Reasoning OFF/ON, Execution OFF/ON, Repository, Slack mode (SANDBOX ONLY / LIVE CHANNELS), Worker trigger, Worker schedule (grey), and counts `NEEDS DECISION` (amber) / `EXECUTION BLOCKED` (red) / `FAILED` (red) / `COMPLETED` (green). Dangerous-state lines and offline-simulation failures stay visible. Provider/tracing/Slack env/durability text moved into a collapsed Diagnostics block. Intent rows read "move production job · job …1234 · proposed by production planner · owner decision required", with ids and the audit trail under "Technical details". Release-test tools and the registry/matrix remain in `<details>` (pinned).

Slack decision semantics (code facts, unchanged): a Slack APPROVE moves `AWAITING_APPROVAL → APPROVED` and records `approvedBy`; REJECT → `CANCELLED`; REQUEST_CHANGES / HOLD are audit lines only. `decideIntent` never calls `executeIntent`; execution needs `GSO_AGENT_EXECUTION_ENABLED=true` (default false) **and** the owner's hub button; the worker can never execute consequential actions. `SLACK_SANDBOX_ONLY` is fail-safe (anything but the literal `"false"` = sandbox). Reviewer-visible text is `reason` + Slack `facts`; `payload` values never leave the engine (audit stores `payloadKeys` only).

Remaining blockers: `approvalPolicy` (the most reviewer-friendly sentence, from the agent registry) is not in `auditSummary` and therefore cannot be shown on the hub without a lib change; the Slack card context line still prints raw agent/action/level/intent ids (lib `slack-blocks.ts`, not in scope).

---

## Flow E — Product setup → cost calculator (read only)

Product Setup (`app.erp.product-setup.tsx`): create (Recipe / product name, SKU / internal code, Product family, Pricing template, Target margin %, Default sell price) → **Open** → "Fix readiness blockers" (Width, Height, Minimum quantity, Preferred machine; attach printed material; optional blank item; tiers) → **Test price** → tick **Use in Quotes / CRM** → **Save recipe**. Quote-ready = `active && useInQuotes && !costReviewNeeded` (L1797); the checkbox is disabled until active and cost review cleared.

Confusing (not fixed): "512MB-safe" / "Memory-safe mode" infra copy; source file paths and release codes in section 3 ("Calculator Rules"); raw enums `in_house` / `outsourced` / `hybrid`; duplicate name/SKU/family/margin/price fields between create and edit; `Recipe materials` rendered twice; jump links "4. Features" / "5. Shopify" point at empty anchors; **no link to the Cost Calculator or Quotes** (and the calculator links back only inside its hidden legacy block). Needs the owner to pick one direction for the handoff.

---

## Flow F — Vendor / material setup → cost verification (read only)

| Page | Create fields | Status words | Confusing |
|---|---|---|---|
| Vendor Center | Vendor name (only validated field), Vendor type, Status, Main contact, Email, Phone, Lead time days, Website, Payment terms, Notes → **Save vendor**; larger edit form adds Address/City/State/Zip + MOQ / Shipping / Quality / General notes | `active` green/critical with the raw status string; "Needs vendor record" warning | raw enums `print_vendor`; contact fields in three places; "TBD"/"n/a" literals; **no links** to Materials / Cost Verification |
| Material Center | Material Name, Material Type, Purchase / Inventory Unit, Purchase Cost, Recipe / Costing Unit, roll width/length or ML per unit, Quantity, Primary Vendor, Vendor Text / Fallback, SKU, Product Families, Stock On Hand, Reorder Point, Lead Time Days, **Cost Review Needed**, **Use in Recipes**, Reason For Cost Change, Notes → **Save Material** | `COST REVIEW` warning, `HIDDEN FROM RECIPES` info, `INACTIVE` warning, `LOW STOCK` critical | costs to 6 decimals; three vendor representations; schema words as labels; **zero outbound links** |
| Cost Verification Workbook | one input: `confirmPhrase` = `APPLY VERIFIED COSTS` → **Apply approved cost updates**; "verified" otherwise = typing `[VERIFIED date inv#]` into a record's Notes on another page | Verified (invoice marker) green / Manually entered / Seeded / Missing; Ready / Needs work tiles; approved-update statuses | patch numbers everywhere; Prisma model names as "Current source"; code paths and doc paths in cells; two colour vocabularies on one page |

What "verified" means in code: (1) display confidence from a `[VERIFIED …]` regex over `notes` (no `verifiedAt/By` columns exist); (2) the apply action overwrites `VendorProduct.defaultUnitCost`, tiers, `Material.purchaseCost/calculatedUnitCost/costPerUnit`, sets `costReviewNeeded:false`, appends the marker, writes `MaterialCostHistory`, and updates `MachineInkChannel` rates. Nothing Shopify/quote/recipe side is touched.

Remaining blockers: a real verification field (`verifiedAt`, `verifiedBy`) is a schema change; Vendor → Material → Cost Verification needs cross-links (routes not in tonight's scope).

---

## What tonight changed, per file (display only)

| File | Change |
|---|---|
| `app.quotes.tsx` | flow strip + primary **New quote**; "1 · Customer" without the status select; Shopify lookup collapsed; item cards re-grouped product → quantity → material/finish → cost → price → margin; duplicate manual price/cost pair removed (fields still rendered once per layout); image/artwork/pricing-source collapsed; "8 · Notes → 9 · Save" with Status + margin-floor badge; plain-language badges; production badge grey |
| `app.erp.production.tsx` | at-a-glance row (job, customer, product, qty, status, due, machine, art/proof, material, next action) from loader fields; status tone rules; technical ids / RIP names / run identity / writeback diagnostics / older events collapsed; informational badges grey; `VERIFIED — finalized` / `PROVISIONAL — open` |
| `app.erp.agent-review-queue.tsx` | decision-inbox columns (what / why / evidence / risk / approval effect / eligibility); status words + tones; "What happens if approved"; technical ids collapsed |
| `app.erp.ops-hub.tsx` | "Today at a glance" with switches + counts; diagnostics collapsed; intent rows in plain words with ids collapsed; list titles NEEDS DECISION / EXECUTION BLOCKED / FAILED / COMPLETED; worker badges grey |

Verification: `tests/staff-ux-copy-2026-10-05.test.ts` (field names, intents, collapsed release tools, approval action pins, headings); `npx tsc --noEmit -p .` — error count moved from 300 to 293 because seven pre-existing Polaris `Badge` children type errors disappeared when the badge text became template strings (no new errors; remaining errors are the pre-existing ones in untouched lines).
