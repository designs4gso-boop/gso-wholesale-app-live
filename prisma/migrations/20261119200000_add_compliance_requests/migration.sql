-- 2026-11-19 — ADDITIVE: one new table that records Shopify privacy webhooks
-- (customers/data_request, customers/redact, shop/redact) for the owner.
-- No existing table is touched. Applied by the Render Pre-Deploy
-- `prisma migrate deploy`. Rollback = redeploy the previous app commit (the
-- table is ignored by the older code).

CREATE TABLE IF NOT EXISTS "ComplianceRequest" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "customerId" TEXT,
  "customerEmail" TEXT,
  "customerPhone" TEXT,
  "ordersRequested" TEXT,
  "status" TEXT NOT NULL DEFAULT 'received',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3),
  "completedBy" TEXT,
  "completedAt" TIMESTAMP(3),
  "resultSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceRequest_shop_webhookId_key" ON "ComplianceRequest"("shop", "webhookId");
CREATE INDEX IF NOT EXISTS "ComplianceRequest_shop_status_idx" ON "ComplianceRequest"("shop", "status");
