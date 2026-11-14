-- Rules the database enforces for hand-entered accounts and balances, so that a
-- bug elsewhere cannot get past them. Prisma does not model check constraints;
-- they live only here.

ALTER TABLE "Account" ADD CONSTRAINT "Account_plaid_link_complete"
  CHECK (("plaidItemId" IS NULL) = ("externalAccountId" IS NULL));

ALTER TABLE "Account" ADD CONSTRAINT "Account_cushion_not_negative"
  CHECK ("cushion" IS NULL OR "cushion" >= 0);

ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_manual_has_date"
  CHECK ("source" <> 'MANUAL' OR "asOfDate" IS NOT NULL);

ALTER TABLE "Household" ADD CONSTRAINT "Household_timeZone_length"
  CHECK ("timeZone" IS NULL OR length("timeZone") BETWEEN 1 AND 64);
