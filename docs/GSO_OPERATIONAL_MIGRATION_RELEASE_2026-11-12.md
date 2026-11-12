# GSO ERP — Operational records migration release (2026-11-12)

Branch `release/operational-records-migration-2026-11-12` from live `04f26fa`.
Migration `20261112090000_add_operational_records` — activated in the repo, NOT
applied anywhere. Nothing pushed or deployed by this work.

## What the migration does (additive only)

| Table | Added | Nullability / default |
|---|---|---|
| ProductionJob | shippedAt, shipCarrier, shipTrackingNumber, shipPackageCount, pickedUpAt, pickedUpBy, rushApprovalStatus, rushApprovedBy, rushApprovedAt, rushNotes, promisedDate, quotedTrueCost, actualVarianceAmount, actualVariancePct | nullable |
| ProductionJob | rushRequested | NOT NULL DEFAULT false |
| ProductionJobItem | goodQty, spoiledQty, spoilageReason, qcResult, qcBy, qcAt, qcNote, lastReprintReason, lastReprintBy, lastReprintAt | nullable |
| PurchaseRequest | requestedBy, approvedBy, approvedAt | nullable |
| Quote | requestedDueDate | nullable |
| Quote | rushRequested | NOT NULL DEFAULT false (metadata-only on Postgres 11+, no table rewrite) |
| InventoryReservation (new) | id, shop, materialId, jobId, jobItemId?, quantity, consumedQty?, unit, status DEFAULT 'reserved', idempotencyKey, reservedBy?, reservedAt DEFAULT now, consumedAt?, releasedAt?, notes?, createdAt, updatedAt | unique (shop, idempotencyKey); index (shop, materialId, status); index (shop, jobId) |
| NotificationPreference (new) | id, shop, recipientKey, eventType, channel, enabled DEFAULT false, createdAt, updatedAt | unique (shop, recipientKey, eventType, channel) |

No DROP / RENAME / ALTER COLUMN / type change / UPDATE / INSERT / foreign key.
Every statement is `IF NOT EXISTS`-guarded. `prisma migrate diff` (offline,
schema file to schema file) of the patched schema produces exactly these
columns, tables and indexes.

**No backfill**: every new column is nullable or default-backed, the two new
tables start empty, and the unique indexes are only on those empty tables.
Historical shipments / QC / reprints stay in `ProductionJobEvent`, which is
still what the QC and completion guards read.

## Application wiring in this release

| Feature | Wired | Where |
|---|---|---|
| QC → structured record | yes — item qcResult / qcBy / qcAt / qcNote (guards still read qc_result events) | production `qcItem` |
| Reprint → structured record | yes — item lastReprintReason (validated code) / By / At + QC reset | production `reprintItem` |
| Shipment fields | yes — shippedAt, shipCarrier, shipTrackingNumber, shipPackageCount; conditional update (replay = 409, nothing written twice) | production `recordShipment` |
| Pickup fields | yes — pickedUpAt, pickedUpBy (as entered); conditional update | production `recordPickup` |
| Purchasing | yes — requestedBy on create; approvedBy / approvedAt when an approver first orders (markOrdered, markSent, updateRequest → ordered, create-as-ordered) | purchase-requests |
| Actual cost | yes — quotedTrueCost (write-once from the immutable quote-item snapshot), actualVarianceAmount / Pct (null when no estimate) | production `saveFinalCosts` |
| Cancellation → release reservations | yes — same transaction as the status change; exactly once | production `changeStatus` |
| Reserve at scheduling / consume at completion | executors built and tested (`inventory-reservation.server.ts`), NOT triggered automatically — see owner input | — |
| Rush / requested due date | columns only; no write path (no rush fee, no promised turnaround) | — |
| Notification preferences | table only; nothing writes or sends | — |

Financial redaction: `redactJobFinancials` now also nulls quotedTrueCost,
actualVarianceAmount and actualVariancePct for viewers without financial access.

## Deployment-order compatibility

- **Old code + migrated DB** (the window while Render's Pre-Deploy runs
  `prisma migrate deploy` and the old instance still serves): SAFE. The old
  Prisma client names its columns explicitly, never sees the new ones, and its
  inserts get the DB defaults (`rushRequested = false`).
- **New code + un-migrated DB**: NOT safe. The new client selects the new
  columns on ProductionJob / ProductionJobItem / PurchaseRequest / Quote reads
  and would fail with P2022. The migration MUST complete before the new code
  serves. Render guarantees this when the migration runs in **Pre-Deploy**
  (`npx prisma migrate deploy`) or as the start-command prefix
  (`npx prisma migrate deploy && npm run start`), per docs/MIGRATIONS.md: a
  failed migration aborts the deploy and the old instance keeps serving.
  Confirm one of the two is configured before deploying (step 2 below).

## Deployment sequence (owner, after QA sign-off)

1. Render → PostgreSQL `gso_wholesale_db` → **Recovery / Backups**: create a
   manual backup (or note the point-in-time recovery timestamp if the plan
   only offers PITR — the restore point is "just before step 4"). Record:
   database name, backup ID / timestamp (UTC), commit SHA being deployed.
2. Render → web service `gso-wholesale-app-live` → Settings: confirm the
   Pre-Deploy Command is `npx prisma migrate deploy` (or the start command
   begins with it). If neither, STOP — do not deploy this commit.
3. Merge the release commit to `main` (fast-forward) and push.
4. Watch the deploy log: Pre-Deploy must print that
   `20261112090000_add_operational_records` was applied, then the new
   instance starts. A failure here leaves the old instance serving — stop and
   report; no rollback is needed.
5. No `shopify app deploy` and no "Save settings & sync functions" are needed
   (no extension or function change).

## Smoke tests (after deploy)

1. Launch Readiness loads; only the Miron 50ml geometry blocker remains.
2. Production board loads; open an existing job (old jobs show blank new fields, no errors).
3. QC an item (Pass) on a test job → success message; item shows the result.
4. Reprint request with a reason → success; QC resets on that item.
5. Record a shipment on a QC-passed test job → status Shipped; submit the same form again → refused, nothing duplicated. Then mark Completed.
6. Record a pickup on another QC-passed test job → Picked Up.
7. Cancel a test job → "Status updated." (no reservations exist yet, so none released).
8. Purchase Requests: create a request as staff, order it as owner → no error.
9. Save actual costs on a test job (not finalize) → success.
10. As a non-financial staff account (if one is assigned): production board shows no cost / variance figures.
11. Cost Calculator: Split Bag front-only $272.00 and front+back $409.66 unchanged; Quotes page loads; storefront configurator price check unchanged.

## Rollback

- **Level 1 — application rollback (default)**: redeploy `04f26fa` in Render
  (Manual Deploy → that commit, or revert the release commit on `main` and
  push). Leave the new columns / tables in place: the old code never reads
  them and its inserts get the defaults. `prisma migrate deploy` on the old
  commit sees an extra applied migration it does not know and does not touch it.
- **Level 2 — database recovery (only if the migration itself damaged data)**:
  restore the backup / PITR point from step 1 to a NEW database, verify it,
  then repoint `DATABASE_URL`, and redeploy `04f26fa`. Data written after the
  restore point is lost, so this is the last resort.
- No down migration is shipped; columns are not dropped for convenience.

## Owner input still needed

- **Reservation triggers**: there is no "scheduled" production status and no
  per-job expected-material plan. The owner decides which event is
  "scheduling" (e.g. Ready to Print, or a calendar date) and where expected
  quantities come from, and whether completion consumption replaces the
  existing "deduct inventory" checkbox on material usage (both would
  double-deduct). Until then reservations are never created automatically.
- Rush workflow (approval rules, fee policy) and notification provider remain
  unapproved; their columns stay empty.
- Miron 50ml label geometry (owner sample) — unrelated to this migration.
