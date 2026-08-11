-- Phase 15H.1 — DB-backed production ticket identity (STAGED, not yet applied).
-- This folder is OUTSIDE prisma/migrations on purpose: Render runs
-- `prisma migrate deploy` at deploy, and the owner directed that this
-- migration must not auto-apply on push. See README.md for activation.
--
-- Exact Prisma-generated DDL (from `prisma migrate diff`), wrapped with
-- IF NOT EXISTS so the file stays safe even if a future `prisma migrate dev`
-- regenerates the same indexes first. Nullable columns stay nullable —
-- Postgres unique indexes treat NULLs as distinct.

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionJob_shop_jobTicket_key" ON "ProductionJob"("shop", "jobTicket");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionJobItem_shop_itemTicket_key" ON "ProductionJobItem"("shop", "itemTicket");
