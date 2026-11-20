-- 2026-11-20 — ADDITIVE ONLY: customer source (nullable) and an append-only
-- customer history table. No existing row or column is changed. Applied by the
-- Render Pre-Deploy `prisma migrate deploy`. Rollback = redeploy the previous
-- app commit (older code ignores both).

ALTER TABLE "CrmAccount" ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE TABLE IF NOT EXISTS "CrmAccountEvent" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "detail" TEXT,
  "actor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmAccountEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CrmAccountEvent_shop_accountId_createdAt_idx" ON "CrmAccountEvent"("shop", "accountId", "createdAt");
