-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "customerTier" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "customerTierLabel" TEXT;

