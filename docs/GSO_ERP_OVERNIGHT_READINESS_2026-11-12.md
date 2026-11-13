# GSO ERP — Overnight finalization (2026-11-11 → 11-12)

Branch `overnight/final-operational-readiness-2026-11-11` from live `cfb9a36`. Nothing deployed, pushed, or applied to production. One STAGED (not applied) additive migration.

## What changed (repo only)

| Commit | Area |
|---|---|
| `7aa6b4e` | Employee financial access gaps closed: Purchase Requests / Reorder Report payloads redacted on the server for non-financial roles; PO export, Vendors, Machines, Shopify Links, Configurator Jar Mapping, Admin Settings gated; purchase-request cost-zeroing and posted-"ordered" bypass fixed |
| `669eb5d` | Machine selection: owner + authorized print operator only (managers no longer by default); forged printer field ignored → AUTO; Print Intake review actions need `manageIntake` |
| `fa6c989` | Staged additive migration `20261112090000_add_operational_records` + pure reservation accounting |
| `31aaea4` | Test typing (typecheck back to the 263 baseline) |
| `472a6a9` | Owner-only Staff Access & Launch Readiness page (`/app/erp/owner-readiness`) |
| `19f33ef` | Calibration review rule (owner-configured sample count, never auto-change), customer-notification foundation (never sends), status replay no-op |

## Owner correction 2026-11-12 (live QA) — Split Bag geometry and jar band options

- **Split Bag** has its own owner-measured label: art / print **7.20 x 4.38 in** (artwork area, nesting, media, ink) and cutline **7.07 x 4.26 in** (cut path), used exactly — never the 4x5 artboard or the 4x5 3.79 x 4.81 cutline (`bag-artboard-geometry.ts` SPLIT_BAG_*). $0.25 blank, MOQ 64, 1 label per printed side (front + back = 2, never 4), packout / freight TBD and the provisional price authority are unchanged. The Cost Calculator shows the fixed Split Bag geometry and no longer asks for 4 x 5 dimensions; the Standard 4x5 Sticker Bag shows its own 4.00 x 5.00 / 3.79 x 4.81.
- Qty 500 true cost (test fixture, Mimaki matte): Front only $233.73 -> $272.00; Front + Back $332.22 -> $409.66. Standard 4x5 unchanged ($165.73).
- **Jar Side Lid / tamper band** is now selectable on 3oz (art 7.06 x 0.5, cutline 6.935 x 0.375) and 4oz (art 7.125 x 0.5, cutline 7.0 x 0.375). Print / media / ink / cut are costed; there is still NO owner band application time for 3oz/4oz, so a job with the band stays DRAFT_ONLY (needs review / quote-only). Side / Lid jobs quote normally.

## Live QA regressions 2026-11-12 (after 03c0eed went live)

- Split Bag width / height are never manual inputs: the loader and the save action force the canonical 7.2 x 4.38 (cutline 7.07 x 4.26) whatever the query string says; the form shows a read-only production spec.
- Quantity and Number of designs are independent. The product form now seeds every field from the URL and has `autoComplete="off"` (browser form restoration can restore values by field position, and the field list changes by product). Product / bag-type switches carry pqty and pdesigns as themselves (designs default 1). Qty 500 / 1 design: Front only $272.00, Front + Back $409.66 (test fixture); the live ~$4,929 was designs = 500.
- The 3oz / 4oz side lid band is offered whenever band geometry exists; missing band application time keeps the quote Needs Review with an explicit message. A tab opened before a deploy keeps the old browser code: hard-refresh the embedded admin after each deploy.
- Launch Readiness: jar recipes are dimension-ready when canonical jar geometry is owner-confirmed (the seeded jar recipes never had Product Setup width / height). Unresolved items are named (e.g. "Miron 50ml — label geometry pending owner sample"; "5oz Clear Jar with Applied Label — not an active jar product"). The agent-queue conversion gate is unchanged.

## Launch Readiness routing semantics 2026-11-12

Quote Pipeline readiness for an ACTIVE jar recipe = owner-confirmed label geometry + verified canonical blank cost + at least one compatible press under the canonical routing rules (Mimaki CMYK/White, Roland CMYK/White/Gloss; Primer never). Product Setup preferred machine / width / height are only read by the legacy recipe engine used for automatic agent-queue conversion, so those gaps are listed under Agent Platform (warning) and `blockingConversionIssues` is unchanged. Inactive jar placeholders (5oz) are informational. Miron 50ml (active, geometry pending owner sample) remains the one Quote Pipeline blocker.

## Mimaki White — controlled calibration procedure (DO NOT RUN without owner approval)

No new defensible evidence exists (RasterLink/MijCtrl logs cover ~1 day, no job folder, no coverage data; Profile.db is encrypted). When the owner approves ONE controlled print during normal production:
1. Prepare a test file on the production profile (Generic PVC Matte v3.5, 600x1200, 32 pass, Fast Print High — the pending identity) with KNOWN White coverage: e.g. a 12 x 12 in solid White patch (100%) and a 12 x 12 in 50% White tint, one White layer, no CMYK.
2. Record the RasterLink job ID / name, layout W x L, pass count and resolution exactly as printed.
3. Read White mL for that job from the RasterLink unit log (white1 + white2 channels) and the print duration.
4. Normalized rate = White mL / (patch sqft x coverage x layers). Repeat with two layers if two-layer White is quoted.
5. Owner reviews and approves; only then is a `mimaki-white` MachineProfileCalibration row created (status approved). Never Roland White, never $0, never the raw 1.36 / 1.86 history.

## QuickBooks readiness (no credentials, nothing connected)

| ERP record | QuickBooks entity | Ready today | Missing |
|---|---|---|---|
| Quote customer / Wholesale customer | Customer | name, company, email, phone on Quote | stable customer ID, billing address normalisation |
| Paid quote / Shopify order (draft-order payment) | Sales Receipt or Invoice + Payment | quote items (selling price), payment linkage via verified draft orders | tax mapping, QB item / income account per product family |
| Deposit (50%) / balance | Payment against Invoice (or deposit to Undeposited Funds) | depositAmount / balanceDue, deposit / balance draft order IDs | invoice-first flow decision |
| Shipping | Shipping line / expense | entered actual shipping cost (shipment record) | carrier expense account |
| Purchase request → order | Purchase Order / Bill | PR number, vendor, qty, unit cost (owner-only), CSV export | vendor ↔ QB vendor ID map, approver fields (staged migration) |
| Inventory movements | Inventory Adjustment | atomic movements with cost impact | QB inventory items (non-inventory recommended first) |
| Actual job cost | Journal / class reporting | finalized actual cost + variance snapshot | stored variance columns (staged migration) |

Recommended boundary: one-way ERP → QuickBooks export of paid sales, payments, approved POs and bills, via an owner-approved app connection; exported-at stamps on the ERP side; no QuickBooks → ERP writes. CSV exports stay available.

## AI Sales / Marketing agent readiness

Agents may only receive SALES-SAFE projections: customer, lead, quote status, customer selling price / totals, order status, follow-up state, approved product catalogue / ladders. Never true cost, profit, margin, internal floors (enforce with `stripInternalFinancials` / quote-staff-visibility before any agent payload). Existing guardrails: outbox forbids `send_customer_notification` and `send_purchase_order`; agent actions go through the review queue. Still needed before any agent sends: a permission-checked read API (sales role equivalent), owner approval workflow for outbound messages, a provider (email/SMS) and per-customer consent / preferences (NotificationPreference in the staged migration).

## Owner inputs still needed (only these)
1. 50ml label dimensions (art size). 2. Seconds to apply ONE band on 3oz. 3. Same on 4oz. 4. Banner finishing: hem sec/ft + tape $/ft; sec + $ per grommet (+ spacing); pole pocket sec/ft + material $/ft; double-sided construction; tube cost + banners per tube (the legacy $0.60/ft and $0.30/grommet figures are unmeasured assumptions and stay unused). 5. Mimaki White calibration print approval. 6. Rush surcharge / turnaround / qualification. 7. Split Bag carton packout. 8. Split Bag inbound freight (first real invoice). 9. Minimum job count for calibration review (`GSO_CALIBRATION_REVIEW_MIN_SAMPLES`). 10. Employee Shopify staff IDs + roles. 11. QuickBooks and email/SMS credentials.

## Manual Shopify actions (owner)
1. Discounts → Wholesale Pricing → Deactivate.
2. Stock Bags: confirm every active ConfiguratorProduct has its Shopify product / variant IDs (the readiness page shows RED if any are missing); keep the configurator block on each template; remove native Add to Cart and Quick Add; hide / make raw $1 variants unavailable; test a configurator draft-order checkout end to end; never activate the cart transform.

## Deployment sequence (tomorrow, owner)
1. Review the branch; push it; open a PR to `main`; merge after review (fast-forward from `cfb9a36`).
2. Render deploys the web app (no schema change: the operational migration is staged, so `prisma migrate deploy` applies nothing new).
3. Confirm `GSO_OWNER_SHOPIFY_USER_IDS` is set and `GSO_OWNER_ENFORCEMENT` is not `temporary_all_staff` (owner-only pages refuse everyone if no owner is configured).
4. No `shopify app deploy` is needed (no extension changes).

## Migration sequence (later, separate owner decision)
Only after a production DB backup: `git mv prisma/migrations-pending/20261112090000_add_operational_records prisma/migrations/` → `node prisma/migrations-pending/apply-20261112-operational-schema.mjs` → `npx prisma validate` → commit + push; Render applies it. Then a follow-up code commit wires reservations / structured records. Rollback SQL in `prisma/migrations-pending/README.md`.

## Smoke test after deployment
1. Owner opens `/app/erp/owner-readiness`: identity shows 77055393857 / owner; no RED except items you expect (configurator IDs).
2. Cost Calculator, Reports Dashboard, Margin Review, Machines, Vendors load for the owner.
3. Purchase Requests and Reorder Report load and show costs for the owner.
4. Production board: create a manual test job only if acceptable, else open an existing job and confirm the shipment / pickup forms appear; confirm Completed is refused on a non-shipped job.
5. Paid-order path: no change (no test order needed).
6. Quotes: a quote in production shows "Quote locked".

## Rollback point
`cfb9a36` (current live `main`). The overnight branch adds no applied schema change, so reverting the deploy to `cfb9a36` is sufficient.

## Operational records migration activated 2026-11-12

Branch `release/operational-records-migration-2026-11-12`: `20261112090000_add_operational_records` moved into prisma/migrations and schema.prisma patched by the activation script. QC, reprint, shipment, pickup, purchasing approver and actual-cost/variance writes now also fill the structured columns; cancellation releases active inventory reservations. Reserve-at-scheduling / consume-at-completion triggers await owner definition. Release, smoke-test and rollback steps: docs/GSO_OPERATIONAL_MIGRATION_RELEASE_2026-11-12.md.

## Split Bag final landed cost + owner quote pricing 2026-11-12

**Cost authority** (owner final vendor quote, November 2026 — first real purchase): 5,000 Split Bags at **$0.14** vendor cost ($700 merchandise) + **$120** inbound freight = **$0.024/bag**; landed **$0.164/bag**, landed inventory value **$820**. Vendor carton = 2,500 bags (2 cartons); carton dimensions and weight PENDING owner measurement on receipt. Supersedes the provisional $0.25 (new costing only; saved quote snapshots keep their cost).

- Engine: `blank_sets` carries the $0.14 vendor cost; `inbound_freight` carries the $0.024 lot allocation (`SPLIT_BAG_INBOUND_FREIGHT_LOT` in bag-cost-inputs.server.ts — a future lot changes the freight independently). The $120 is never added to a quote; outbound customer shipping is a separate quote / order charge. The vendor carton is not an outbound packout standard (Split Bag packout stays not modelled).
- Qty 500, 1 design, Mimaki, matte: front only **$228.996** ($0.4580/bag); front + back **$366.659** ($0.7333/bag) — exactly $43.00 below the $0.25 basis (blank $125 -> $70 + $12 freight). Every other line is unchanged.
- Standard 4x5 ($0.11, MOQ 50, no freight line) and Stock Bags are unchanged.

**Selling price**: no Split Bag ladder exists and none was created. A Split Bag quote saves as a PROVISIONAL draft with the canonical true cost ("SPLIT BAG AUTOMATIC SELLING PRICE NOT YET APPROVED"). The OWNER enters a customer unit or total price with Owner Set Price & Approve ("OWNER-SET CUSTOMER PRICE — THIS QUOTE ONLY"); the Quotes page previews customer unit price, total, true cost, expected profit (total - true cost), realized margin (profit / total) and markup while typing. The approval writes only that quote item (and an audit note), never a ladder, tier, product, Material Center row or Shopify price, and never the true cost. Until approved the quote cannot be sent, approved, paid or moved to production. Each approval record keeps quantity, true unit / total cost, customer unit / total price, profit, margin, approver and date, and the cost snapshot keeps the configuration (sides, designs, Split Bag flag) — the data set for a future owner-approved ladder.

**Purchasing / receiving**: PurchaseRequest has no inbound-freight field (no schema change in this release). Record the order as ordered qty 5,000 at $0.14 with "inbound freight $120 (= $0.024/bag)" in the notes, and receive only the real good quantity when the cartons arrive (ordered vs received is already distinct). Stock receipts are valued at the vendor unit cost; the landed $0.164 is applied by the cost engine, not by the inventory valuation.
