-- 2026-11-19 — ADDITIVE production lineage (file -> item link, production runs,
-- reorder lineage, staged business transactions). Applied by the Render
-- Pre-Deploy `prisma migrate deploy`. Every change is additive: new NULLABLE
-- columns, two new tables and their indexes. No drops, renames, type changes,
-- foreign keys, backfills or data conversion. Existing rows keep NULL in every
-- new column. Rollback = redeploy the previous app commit (the extra columns /
-- tables are ignored by the older code).

-- Exact item link on production files and print-intake rows.
ALTER TABLE "ProductionJobFile" ADD COLUMN IF NOT EXISTS "productionJobItemId" TEXT;
ALTER TABLE "ProductionJobFile" ADD COLUMN IF NOT EXISTS "reusedFromFileId" TEXT;
CREATE INDEX IF NOT EXISTS "ProductionJobFile_productionJobItemId_idx" ON "ProductionJobFile"("productionJobItemId");
ALTER TABLE "PrintIntake" ADD COLUMN IF NOT EXISTS "productionJobItemId" TEXT;
CREATE INDEX IF NOT EXISTS "PrintIntake_productionJobItemId_idx" ON "PrintIntake"("productionJobItemId");

-- Reorder lineage (explicit, chosen by staff; never inferred).
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "reorderSourceItemId" TEXT;
ALTER TABLE "ProductionJobItem" ADD COLUMN IF NOT EXISTS "reorderArtworkMode" TEXT;
CREATE INDEX IF NOT EXISTS "ProductionJobItem_reorderSourceItemId_idx" ON "ProductionJobItem"("reorderSourceItemId");
ALTER TABLE "QuoteItem" ADD COLUMN IF NOT EXISTS "reorderSourceItemId" TEXT;
ALTER TABLE "QuoteItem" ADD COLUMN IF NOT EXISTS "reorderArtworkMode" TEXT;

-- Production runs of one item (run 1 = original; reprints / remakes follow).
CREATE TABLE IF NOT EXISTS "ProductionRun" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "runNumber" INTEGER NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'original',
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "reasonCode" TEXT,
  "chargeType" TEXT NOT NULL DEFAULT 'internal',
  "printer" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "requestedBy" TEXT,
  "authorizedBy" TEXT,
  "notes" TEXT,
  "runLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ProductionRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionRun_itemId_runNumber_key" ON "ProductionRun"("itemId", "runNumber");
CREATE INDEX IF NOT EXISTS "ProductionRun_shop_idx" ON "ProductionRun"("shop");
CREATE INDEX IF NOT EXISTS "ProductionRun_shop_jobId_idx" ON "ProductionRun"("shop", "jobId");
CREATE INDEX IF NOT EXISTS "ProductionRun_itemId_idx" ON "ProductionRun"("itemId");

-- Business transactions staged for admin review (nothing is sent to QuickBooks).
CREATE TABLE IF NOT EXISTS "StagedTransaction" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "docNumber" TEXT,
  "externalCustomerId" TEXT,
  "customerName" TEXT,
  "txnDate" TIMESTAMP(3),
  "totalAmount" DOUBLE PRECISION,
  "balance" DOUBLE PRECISION,
  "externalStatus" TEXT,
  "status" TEXT NOT NULL DEFAULT 'staged',
  "lines" TEXT,
  "reviewNotes" TEXT,
  "releasedJobId" TEXT,
  "releasedBy" TEXT,
  "releasedAt" TIMESTAMP(3),
  "dismissedBy" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StagedTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StagedTransaction_shop_source_externalId_key" ON "StagedTransaction"("shop", "source", "externalId");
CREATE INDEX IF NOT EXISTS "StagedTransaction_shop_status_idx" ON "StagedTransaction"("shop", "status");
