-- Task 4: let a link attempt be claimed exactly once and reconciled later.
-- Generated with `prisma migrate diff`. Purely additive, so safe on existing data.

-- AlterEnum
ALTER TYPE "LinkAttemptStatus" ADD VALUE 'EXCHANGING';

-- AlterTable
ALTER TABLE "LinkAttempt" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "providerItemId" TEXT,
ADD COLUMN     "requestedHistoryDays" INTEGER;
