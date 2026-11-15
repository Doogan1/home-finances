-- Build step 4 of the bills and forecast design: the workbook import records
-- each account's workbook Account ID, so the import can be refused a second
-- time and its accounts told apart. Purely additive.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "importRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Account_householdId_importRef_key" ON "Account"("householdId", "importRef");
