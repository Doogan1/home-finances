-- Build step 6 of the bills and forecast design: an account from a connected
-- bank can be attached to a hand-entered one, which then carries its Plaid
-- link. Purely additive.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "attachedAt" TIMESTAMP(3);

-- Only an account with a Plaid link is attached. Detaching clears the link and
-- this date in one update, so the check never sees them apart.
ALTER TABLE "Account" ADD CONSTRAINT "Account_attached_is_linked"
  CHECK ("attachedAt" IS NULL OR "plaidItemId" IS NOT NULL);
