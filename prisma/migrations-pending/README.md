# Staged migrations (owner-applied only)

Migrations here are **deliberately invisible** to `prisma migrate deploy` —
Render runs that command at every deploy, and staging here is how a schema
change ships in code without auto-applying to production on push.

## Currently staged

### 20261112090000_add_operational_records (overnight 2026-11-12) — STAGED, NOT APPLIED
ADDITIVE ONLY (new nullable columns / columns with a safe default, two new
tables, unique + lookup indexes; no drops, renames, type changes or data
conversion). Verified locally: `prisma migrate diff` of the patched schema
produces exactly this SQL, and the patched schema validates.

- `ProductionJob`: shippedAt, shipCarrier, shipTrackingNumber, shipPackageCount,
  pickedUpAt, pickedUpBy, rushRequested (default false), rushApprovalStatus,
  rushApprovedBy, rushApprovedAt, rushNotes, promisedDate, quotedTrueCost,
  actualVarianceAmount, actualVariancePct.
- `ProductionJobItem`: goodQty, spoiledQty, spoilageReason, qcResult, qcBy, qcAt,
  qcNote, lastReprintReason, lastReprintBy, lastReprintAt.
- `PurchaseRequest`: requestedBy, approvedBy, approvedAt.
- `Quote`: requestedDueDate, rushRequested (default false). NO rush fee.
- New `InventoryReservation` (unique `(shop, idempotencyKey)`) and
  `NotificationPreference` (unique `(shop, recipientKey, eventType, channel)`).

Backward compatible: today's code never reads these columns, and the live
schema.prisma does not declare them, so deploying the current code before or
after activation is safe. No backfill is required (all new data starts empty;
existing shipments / QC / reprints stay in ProductionJobEvent history).
Reservation logic is ready in `app/lib/inventory-reservation.ts`; wiring it
into scheduling / completion is a follow-up commit AFTER activation.

**Activation (owner action — ONE commit, after a production DB backup):**
1. `git mv prisma/migrations-pending/20261112090000_add_operational_records prisma/migrations/`
2. `node prisma/migrations-pending/apply-20261112-operational-schema.mjs`
3. `npx prisma validate` (must pass), commit both changes, push — Render runs
   `prisma migrate deploy` and regenerates the client in the same deploy.

Rollback (only if needed; drops ONLY what this migration added):
`DROP TABLE "InventoryReservation"; DROP TABLE "NotificationPreference";`
then `ALTER TABLE "<table>" DROP COLUMN "<column>";` for each column listed
above, revert the schema lines, and delete the row for this migration from
`_prisma_migrations`.

### 20260812090000_add_order_gid (Phase 15H.4A)
Adds `ProductionJob.orderGid` (nullable) + `(shop, orderGid)` index — the
first-class Shopify order linkage. Pre-verified by the 15H.4A read-only
audit (3 Shopify-paid jobs, 0 duplicate/malformed order identities).
The deployed code is capability-guarded: it probes for the column at
runtime and only writes `orderGid` once it exists, so deploying the code
first is safe.

**Activation (owner action — ONE commit):**
1. `git mv prisma/migrations-pending/20260812090000_add_order_gid prisma/migrations/`
2. `node prisma/migrations-pending/apply-15h4a-schema.mjs`  (adds the field
   + index to schema.prisma — the client must not declare the column before
   the database has it, or ProductionJob reads would fail at runtime)
3. `npx prisma validate` (must pass), commit both changes, push — Render
   applies the migration and regenerates the client in the same deploy.
4. Optional afterwards: `node tools/backfill-order-gid.mjs` (dry run), then
   `node tools/backfill-order-gid.mjs --execute` to stamp the 3 existing
   Shopify-paid jobs' orderGid from their quoteId values.

Rollback: `DROP INDEX "ProductionJob_shop_orderGid_idx"; ALTER TABLE
"ProductionJob" DROP COLUMN "orderGid";` and revert the schema lines.

### 20260811120000_add_ticket_uniqueness (Phase 15H.1) — APPLIED ✔
Activated by the owner (92a1435) and applied to production by Render on
2026-08-11 22:23 UTC; the folder now lives under prisma/migrations/. The
notes below are kept for the record.
Adds the two DB unique indexes that make production ticket identity
authoritative: `(shop, jobTicket)` on ProductionJob and `(shop, itemTicket)`
on ProductionJobItem. Pre-verified by `tools/audit-ticket-uniqueness.mjs`
(2026-08-11: 0 duplicates, 0 malformed across 11 jobs / 14 items — safe).
The application code (P2002 retry in the allocator) is already deployed and
is a harmless no-op until these indexes exist.

## How to apply (owner action)

1. Re-run the gate right before applying:
   `node tools/audit-ticket-uniqueness.mjs`  (must print AUDIT: PASS)
2. Move the folder into the live migrations directory:
   `git mv prisma/migrations-pending/20260811120000_add_ticket_uniqueness prisma/migrations/`
3. Commit and push — Render applies it at deploy via `npm run setup`
   (`prisma migrate deploy`).
   (Equivalent alternative: run the SQL directly against the production DB,
   then still move the folder so the migration history records it.)

Apply BEFORE creating any future migration with `prisma migrate dev`, so the
history stays linear (the SQL is IF NOT EXISTS-guarded either way).

## Rollback

The indexes are non-destructive (no data change, nullable preserved).
To roll back after applying:
`DROP INDEX "ProductionJob_shop_jobTicket_key";`
`DROP INDEX "ProductionJobItem_shop_itemTicket_key";`
and revert the two `@@unique` lines in `prisma/schema.prisma`.
