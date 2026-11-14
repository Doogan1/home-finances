-- Build step 1 of the bills and forecast design: accounts can be entered by
-- hand, and balances can be recorded by hand as of a calendar date.
-- Purely additive except that Account's two Plaid fields become optional.
-- Check constraints are in the next migration: Postgres refuses to use an enum
-- value in the same transaction that adds it.

-- AlterEnum
ALTER TYPE "BalanceSource" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "Household" ADD COLUMN "timeZone" TEXT;

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "plaidItemId" DROP NOT NULL,
ALTER COLUMN "externalAccountId" DROP NOT NULL,
ADD COLUMN "ownerLabel" TEXT,
ADD COLUMN "includeInForecast" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "cushion" DECIMAL(19,4),
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BalanceSnapshot" ADD COLUMN "asOfDate" DATE,
ADD COLUMN "note" TEXT;
