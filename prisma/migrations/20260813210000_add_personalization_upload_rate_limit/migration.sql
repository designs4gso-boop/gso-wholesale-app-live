-- Phase 2.5 — durable rate limiting for the Stock Bag personalization upload
-- endpoint (STAGED, not yet applied to production).
--
-- Additive only: one new table plus two indexes. Nothing existing is altered,
-- renamed, or dropped, so this is safe to apply while the app is running.
--
-- IMPORTANT (same rule as 20260812090000_add_order_gid): the Prisma client now
-- declares this model, so the durable limiter cannot read the table until this
-- migration is applied. That direction is deliberate — the limiter FAILS CLOSED
-- and refuses uploads rather than silently running unprotected.
--
-- Contains no PII: identityKey is a bounded shop-scoped key (Shopify-signed
-- customer id, or a guest bucket). No IP addresses, filenames, or assets.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PersonalizationUploadRateLimit" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalizationUploadRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (serves the hot path: count rows for one identity inside the window)
CREATE INDEX IF NOT EXISTS "PersonalizationUploadRateLimit_identityKey_createdAt_idx"
    ON "PersonalizationUploadRateLimit"("identityKey", "createdAt");

-- CreateIndex (serves the opportunistic retention sweep)
CREATE INDEX IF NOT EXISTS "PersonalizationUploadRateLimit_createdAt_idx"
    ON "PersonalizationUploadRateLimit"("createdAt");
