-- 2026-11-12 — ADDITIVE operational records (owner-approved features).
-- Staged overnight in prisma/migrations-pending; activated 2026-11-12 (Render's
-- Pre-Deploy `prisma migrate deploy` applies it). Every change is additive: new
-- nullable columns or columns with a safe default, two new tables and their
-- indexes. No drops, renames, type changes, foreign keys or data conversion.
-- Rollback = redeploy the previous app commit (the extra columns / tables are
-- ignored); see docs/GSO_OPERATIONAL_MIGRATION_RELEASE_2026-11-12.md.

-- Shipment / pickup / rush / promised date / quoted-vs-actual variance on the job.
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "shippedAt" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "shipCarrier" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "shipTrackingNumber" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "shipPackageCount" INTEGER;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "pickedUpAt" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "pickedUpBy" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "rushRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "rushApprovalStatus" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "rushApprovedBy" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "rushApprovedAt" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "rushNotes" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "promisedDate" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "quotedTrueCost" DOUBLE PRECISION;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "actualVarianceAmount" DOUBLE PRECISION;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "actualVariancePct" DOUBLE PRECISION;

-- Per-item good pieces / spoilage and structured QC + reprint accountability.
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "goodQty" DOUBLE PRECISION;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "spoiledQty" DOUBLE PRECISION;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "spoilageReason" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "qcResult" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "qcBy" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "qcAt" TIMESTAMP(3);
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "qcNote" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "lastReprintReason" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "lastReprintBy" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "lastReprintAt" TIMESTAMP(3);

-- Purchasing accountability.
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "requestedBy" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "approvedBy" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);

-- Quote: customer-requested due date and rush request (NO fee — rush pricing is not approved).
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "requestedDueDate" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "rushRequested" BOOLEAN NOT NULL DEFAULT false;

-- Inventory reservations: reserve expected stock at scheduling, consume actual at
-- completion, release on cancellation. idempotencyKey makes every transition replay-safe.
CREATE TABLE IF NOT EXISTS "InventoryReservation" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "jobItemId" TEXT,
  "quantity" DOUBLE PRECISION NOT NULL,
  "consumedQty" DOUBLE PRECISION,
  "unit" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "idempotencyKey" TEXT NOT NULL,
  "reservedBy" TEXT,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryReservation_shop_idempotencyKey_key" ON "InventoryReservation"("shop", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "InventoryReservation_shop_materialId_status_idx" ON "InventoryReservation"("shop", "materialId", "status");
CREATE INDEX IF NOT EXISTS "InventoryReservation_shop_jobId_idx" ON "InventoryReservation"("shop", "jobId");

-- Notification preferences foundation (configurable, nothing is sent by this table).
CREATE TABLE IF NOT EXISTS "NotificationPreference" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "recipientKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPreference_shop_recipientKey_eventType_channel_key" ON "NotificationPreference"("shop", "recipientKey", "eventType", "channel");
