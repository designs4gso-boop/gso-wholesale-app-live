-- 15F.0J.5: PrintIntake identity records (one per unique dropped file).
-- Applied at deploy via `npm run setup` (prisma migrate deploy) — never run
-- against production from a dev session. Rollback: DROP TABLE "PrintIntake";
CREATE TABLE "PrintIntake" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "originalSubfolder" TEXT,
    "fileHashSha256" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'routed',
    "matchedProductionJobId" TEXT,
    "generatedProductionJobId" TEXT,
    "authoritativeTicket" TEXT,
    "printer" TEXT,
    "printMode" TEXT,
    "routingRule" TEXT,
    "routingConfidence" TEXT DEFAULT 'deterministic',
    "routedFilename" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "reprintNumber" INTEGER NOT NULL DEFAULT 0,
    "reviewReason" TEXT,
    "rawParsedHints" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrintIntake_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintIntake_shop_fileHashSha256_key" ON "PrintIntake"("shop", "fileHashSha256");
CREATE INDEX "PrintIntake_shop_idx" ON "PrintIntake"("shop");
CREATE INDEX "PrintIntake_shop_status_idx" ON "PrintIntake"("shop", "status");
CREATE INDEX "PrintIntake_authoritativeTicket_idx" ON "PrintIntake"("authoritativeTicket");
CREATE INDEX "PrintIntake_matchedProductionJobId_idx" ON "PrintIntake"("matchedProductionJobId");
CREATE INDEX "PrintIntake_generatedProductionJobId_idx" ON "PrintIntake"("generatedProductionJobId");
