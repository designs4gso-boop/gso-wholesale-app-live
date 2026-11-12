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
