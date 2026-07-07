-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "lowMarginApprovalReason" TEXT,
ADD COLUMN     "lowMarginApprovalThresholdPct" DOUBLE PRECISION,
ADD COLUMN     "lowMarginApprovedAt" TIMESTAMP(3),
ADD COLUMN     "lowMarginApprovedBy" TEXT,
ADD COLUMN     "lowMarginApprovedSnapshot" JSONB;

