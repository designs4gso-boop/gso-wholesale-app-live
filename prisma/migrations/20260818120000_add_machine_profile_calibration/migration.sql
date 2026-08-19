-- Patch 1 (17D.1) — MachineProfileCalibration (STAGED, not applied).
--
-- ADDITIVE ONLY: one new table plus four indexes. No existing table is
-- altered, renamed, or dropped; there is no backfill and no data migration.
-- The self-referencing supersedes FK is declared INLINE in CREATE TABLE, so
-- this file contains no ALTER statement at all and is safe to re-run.
--
-- DEPLOYMENT ORDER REQUIREMENT (owner-confirmed):
--   `prisma migrate deploy` applies ALL pending migrations in one pass, so
--   once this file exists alongside 20260813210000_add_personalization_upload_
--   rate_limit the two can no longer be verified independently by that command.
--   Deploy and verify 20260813210000 FIRST, while the environment is still at
--   the pre-Patch-1 migration state, THEN deploy this one as its own observed
--   step. Patch 1 itself deploys nothing.
--
-- No @@unique: "one current approved record per identity" is enforced in the
-- application transaction so unlimited superseded history can coexist.
-- Contains no money and no PII.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MachineProfileCalibration" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,

    -- calibration identity (all six parts)
    "machineKey" TEXT NOT NULL,
    "inkMode" TEXT NOT NULL,
    "ripProfile" TEXT NOT NULL,
    "qualityMode" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "passConfig" TEXT NOT NULL,

    -- measured values (never money)
    "mlPerSqftPerPass" DOUBLE PRECISION,
    "inkAreaBasis" TEXT,
    "minutesPerSqft" DOUBLE PRECISION,
    "timeAreaBasis" TEXT,
    "fixedMinutes" DOUBLE PRECISION,
    "timeModel" TEXT NOT NULL DEFAULT 'variable_only',
    "coverageBasisPct" DOUBLE PRECISION,

    -- provenance / history
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'approved',
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "supersedesId" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineProfileCalibration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MachineProfileCalibration_supersedesId_fkey"
        FOREIGN KEY ("supersedesId") REFERENCES "MachineProfileCalibration"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex (shop scoping)
CREATE INDEX IF NOT EXISTS "MachineProfileCalibration_shop_idx"
    ON "MachineProfileCalibration"("shop");

-- CreateIndex (the hot path: exact-identity active resolution)
CREATE INDEX IF NOT EXISTS "MachineProfileCalibration_identity_idx"
    ON "MachineProfileCalibration"("shop", "machineKey", "inkMode", "ripProfile", "qualityMode", "resolution", "passConfig", "status", "effectiveFrom");

-- CreateIndex (status sweeps / admin listing)
CREATE INDEX IF NOT EXISTS "MachineProfileCalibration_shop_status_idx"
    ON "MachineProfileCalibration"("shop", "status");

-- CreateIndex (supersede chain walk)
CREATE INDEX IF NOT EXISTS "MachineProfileCalibration_supersedesId_idx"
    ON "MachineProfileCalibration"("supersedesId");
