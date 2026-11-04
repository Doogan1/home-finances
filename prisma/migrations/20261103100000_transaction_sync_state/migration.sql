-- Task 6: state for reliable manual transaction sync. Generated with
-- `prisma migrate diff`. Purely additive.
--   PlaidItem.syncLease*       one sync per connection at a time, crash-safe
--   PlaidItem.syncCursorVersion proves nothing else moved the cursor
--   SyncRun.providerStatus     Plaid's own "how complete is the data" statement

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "syncCursorVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "syncLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "syncLeaseToken" TEXT;

-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN     "pageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerStatus" TEXT;
