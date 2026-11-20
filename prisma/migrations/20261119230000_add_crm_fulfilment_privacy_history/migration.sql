-- 2026-11-19 (night) — ADDITIVE ONLY. New tables: CrmAccount, CrmLead,
-- CrmLeadEvent, ComplianceRequestEvent. New NULLABLE (or defaulted) columns on
-- ProductionJob, StagedTransaction and ComplianceRequest. No column is
-- dropped, renamed or rewritten and no existing row is changed. Applied by the
-- Render Pre-Deploy `prisma migrate deploy`. Rollback = redeploy the previous
-- app commit (older code ignores the new tables and columns).

ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentState" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentReadyAt" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentReadyBy" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentSyncStatus" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentSyncError" TEXT;
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "fulfillmentSyncedAt" TIMESTAMP(3);
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "shopifyFulfillmentId" TEXT;

ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "transactionType" TEXT;
ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "rawReference" TEXT;
ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "mappingState" TEXT NOT NULL DEFAULT 'unmapped';
ALTER TABLE "StagedTransaction" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
CREATE INDEX IF NOT EXISTS "StagedTransaction_shop_accountId_idx" ON "StagedTransaction"("shop", "accountId");

ALTER TABLE "ComplianceRequest" ADD COLUMN IF NOT EXISTS "startedBy" TEXT;
ALTER TABLE "ComplianceRequest" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "ComplianceRequest" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "ComplianceRequestEvent" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "detail" TEXT,
  "actor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceRequestEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ComplianceRequestEvent_shop_requestId_createdAt_idx" ON "ComplianceRequestEvent"("shop", "requestId", "createdAt");

CREATE TABLE IF NOT EXISTS "CrmAccount" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "company" TEXT,
  "contactName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "shopifyCustomerId" TEXT,
  "externalCustomerId" TEXT,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmAccount_shop_idx" ON "CrmAccount"("shop");
CREATE INDEX IF NOT EXISTS "CrmAccount_shop_email_idx" ON "CrmAccount"("shop", "email");
CREATE INDEX IF NOT EXISTS "CrmAccount_shop_company_idx" ON "CrmAccount"("shop", "company");
CREATE INDEX IF NOT EXISTS "CrmAccount_shop_externalCustomerId_idx" ON "CrmAccount"("shop", "externalCustomerId");

CREATE TABLE IF NOT EXISTS "CrmLead" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "company" TEXT,
  "contactName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'new',
  "productInterest" TEXT,
  "notes" TEXT,
  "assignedStaffId" TEXT,
  "assignedStaffName" TEXT,
  "nextFollowUpAt" TIMESTAMP(3),
  "lastContactedAt" TIMESTAMP(3),
  "accountId" TEXT,
  "quoteId" TEXT,
  "sourceQueueItemId" TEXT,
  "outcomeReason" TEXT,
  "wonAt" TIMESTAMP(3),
  "lostAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmLead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CrmLead_shop_sourceQueueItemId_key" ON "CrmLead"("shop", "sourceQueueItemId");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_status_idx" ON "CrmLead"("shop", "status");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_nextFollowUpAt_idx" ON "CrmLead"("shop", "nextFollowUpAt");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_assignedStaffId_idx" ON "CrmLead"("shop", "assignedStaffId");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_accountId_idx" ON "CrmLead"("shop", "accountId");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_quoteId_idx" ON "CrmLead"("shop", "quoteId");
CREATE INDEX IF NOT EXISTS "CrmLead_shop_email_idx" ON "CrmLead"("shop", "email");

CREATE TABLE IF NOT EXISTS "CrmLeadEvent" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "detail" TEXT,
  "actor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmLeadEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmLeadEvent_shop_leadId_createdAt_idx" ON "CrmLeadEvent"("shop", "leadId", "createdAt");

-- Print Intake watcher heartbeat (nullable; stamped by the watcher's own status call).
ALTER TABLE "PrintLogAutoImportSetting" ADD COLUMN IF NOT EXISTS "intakeAgentLastSeenAt" TIMESTAMP(3);
ALTER TABLE "PrintLogAutoImportSetting" ADD COLUMN IF NOT EXISTS "intakeAgentVersion" TEXT;
ALTER TABLE "PrintLogAutoImportSetting" ADD COLUMN IF NOT EXISTS "intakeAgentHost" TEXT;
