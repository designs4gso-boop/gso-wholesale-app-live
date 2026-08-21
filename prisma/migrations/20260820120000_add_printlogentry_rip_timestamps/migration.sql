-- Patch 2C-2 (17D.3) — PrintLogEntry RIP timestamps (STAGED, not applied).
--
-- ADDITIVE ONLY: two nullable columns and one index on an existing table.
-- Nothing is renamed, dropped, re-typed or back-filled here. Every existing
-- row keeps NULL in both new columns and behaves exactly as it does today.
--
-- WHY: RasterLink print rows carry no print-execution timestamps
-- (KEY_PRINT_S_TIME / KEY_PRINT_E_TIME are empty), so the row-dedupe natural
-- key degenerated to (sourceJobName, status) and silently collapsed distinct
-- print events of the same artwork. The RIP window IS present and distinct per
-- event, but lived only inside rawRow JSON where a Prisma `where` cannot read
-- it. Promoting it to real columns is what makes the corrected dedupe possible.
--
-- These columns are RIP (spool/rasterise) timing ONLY. They are never mapped
-- into startedAt/completedAt/printMinutes, which remain print-execution timing.
--
-- BACKFILL IS DELIBERATELY NOT DONE HERE. Existing rows already hold the values
-- in rawRow.ripStart/ripEnd, and they are populated by the separate, observable
-- tool `tools/backfill-rasterlink-rip-timestamps.mjs` (dry-run by default) so
-- the operation is previewable, countable and reversible in review — rather
-- than hidden inside a migration that runs unattended during deploy.
--
-- DEPLOYMENT ORDER: `prisma migrate deploy` applies ALL pending migrations in
-- one pass. 20260818120000_add_machine_profile_calibration is already applied
-- in production (4 approved rows verified), so this file is the only pending
-- migration and can be verified on its own.
--
-- ROLLBACK: the columns are nullable and unread by any pre-2C-2 code path, so
-- reverting the application alone is sufficient; dropping them is optional and
-- safe only once no deployed build references them.

-- SQL below is exactly what `prisma migrate diff` emits for this schema change
-- (verified schema-to-schema, no database). The index name is Prisma's own
-- 63-character truncation — Postgres caps identifiers at 63 bytes and the
-- untruncated name would be 65, so hand-writing the full name would create an
-- index Prisma does not recognise and leave the schema permanently drifted.

-- AlterTable
ALTER TABLE "PrintLogEntry" ADD COLUMN     "ripCompletedAt" TIMESTAMP(3),
ADD COLUMN     "ripStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PrintLogEntry_shop_printerSoftware_sourceJobName_ripStarted_idx" ON "PrintLogEntry"("shop", "printerSoftware", "sourceJobName", "ripStartedAt");
