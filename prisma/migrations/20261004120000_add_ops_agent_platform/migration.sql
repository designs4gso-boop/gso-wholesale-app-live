-- OPS-2 (2026-10-04) — GSO Operations Agent Platform durable storage.
-- MIGRATION PREPARED — NOT APPLIED. Generated with
--   prisma migrate diff --from-schema-datamodel <pre-OPS-2 schema> --to-schema-datamodel prisma/schema.prisma --script
-- (schema-to-schema; no database was contacted).
--
-- ADDITIVE ONLY: six new tables (OpsActionIntent, OpsActionAuditEvent,
-- OpsExternalEventReceipt, OpsOutboxMessage, OpsSlackStaffIdentity,
-- OpsAgentRun), their indexes and one foreign key. No existing table, column,
-- index or row is touched. Uniqueness: OpsActionIntent.idempotencyKey,
-- OpsOutboxMessage.idempotencyKey, OpsExternalEventReceipt(source, externalId),
-- OpsSlackStaffIdentity.slackUserId. Claim/status queries are covered by
-- (status, nextAttemptAt), (status, createdAt), (status, updatedAt) indexes.
--
-- DEPLOYMENT: applied by the owner via `prisma migrate deploy` as part of the
-- OPS-2 rollout (docs/GSO_OPERATIONS_PRODUCTION_READINESS.md). Until applied,
-- the application runs with GSO_OPS_REPOSITORY=memory and never queries these
-- tables. ROLLBACK: the tables are unread by every pre-OPS-2 code path;
-- reverting the application is sufficient, dropping them is optional.

-- CreateTable
CREATE TABLE "OpsActionIntent" (
    "id" TEXT NOT NULL,
    "shop" TEXT,
    "actionType" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT NOT NULL,
    "autonomyLevel" TEXT NOT NULL,
    "approvalPolicy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdByType" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdBySource" TEXT,
    "approvedByType" TEXT,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedBySource" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "externalReference" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsActionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsActionAuditEvent" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "autonomyLevel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorSource" TEXT,
    "approverType" TEXT,
    "approverId" TEXT,
    "executionResult" TEXT,
    "externalReference" TEXT,
    "error" TEXT,
    "detail" TEXT,
    "payloadKeys" JSONB,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsActionAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsExternalEventReceipt" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "result" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsExternalEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsOutboxMessage" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "intentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsOutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsSlackStaffIdentity" (
    "id" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsSlackStaffIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAgentRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "intentId" TEXT,
    "state" JSONB,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "OpsAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsActionIntent_idempotencyKey_key" ON "OpsActionIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OpsActionIntent_status_createdAt_idx" ON "OpsActionIntent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpsActionIntent_entityType_entityId_idx" ON "OpsActionIntent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "OpsActionIntent_agentId_createdAt_idx" ON "OpsActionIntent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsActionIntent_shop_status_idx" ON "OpsActionIntent"("shop", "status");

-- CreateIndex
CREATE INDEX "OpsActionAuditEvent_intentId_at_idx" ON "OpsActionAuditEvent"("intentId", "at");

-- CreateIndex
CREATE INDEX "OpsActionAuditEvent_at_idx" ON "OpsActionAuditEvent"("at");

-- CreateIndex
CREATE INDEX "OpsActionAuditEvent_actionType_at_idx" ON "OpsActionAuditEvent"("actionType", "at");

-- CreateIndex
CREATE INDEX "OpsExternalEventReceipt_receivedAt_idx" ON "OpsExternalEventReceipt"("receivedAt");

-- CreateIndex
CREATE INDEX "OpsExternalEventReceipt_status_receivedAt_idx" ON "OpsExternalEventReceipt"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsExternalEventReceipt_source_externalId_key" ON "OpsExternalEventReceipt"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OpsOutboxMessage_idempotencyKey_key" ON "OpsOutboxMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OpsOutboxMessage_status_nextAttemptAt_idx" ON "OpsOutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OpsOutboxMessage_intentId_idx" ON "OpsOutboxMessage"("intentId");

-- CreateIndex
CREATE INDEX "OpsOutboxMessage_type_status_idx" ON "OpsOutboxMessage"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpsSlackStaffIdentity_slackUserId_key" ON "OpsSlackStaffIdentity"("slackUserId");

-- CreateIndex
CREATE INDEX "OpsSlackStaffIdentity_staffId_idx" ON "OpsSlackStaffIdentity"("staffId");

-- CreateIndex
CREATE INDEX "OpsAgentRun_status_updatedAt_idx" ON "OpsAgentRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "OpsAgentRun_intentId_idx" ON "OpsAgentRun"("intentId");

-- CreateIndex
CREATE INDEX "OpsAgentRun_agentId_startedAt_idx" ON "OpsAgentRun"("agentId", "startedAt");

-- AddForeignKey
ALTER TABLE "OpsActionAuditEvent" ADD CONSTRAINT "OpsActionAuditEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "OpsActionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

