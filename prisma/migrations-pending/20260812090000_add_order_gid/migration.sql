-- Phase 15H.4A — first-class Shopify order linkage (STAGED, not yet applied).
-- Additive + nullable + indexed only; no data rewrite, nothing destructive.
-- IMPORTANT: activate together with the schema patch (see README) — the
-- Prisma client must not declare the column before the database has it,
-- or every ProductionJob read would fail at runtime.

-- AddColumn
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "orderGid" TEXT;

-- CreateIndex (non-unique by design: source-key idempotency already guards
-- one-job-per-order; the live 15H.4A audit found 3 Shopify jobs, 0 duplicates)
CREATE INDEX IF NOT EXISTS "ProductionJob_shop_orderGid_idx" ON "ProductionJob"("shop", "orderGid");
