-- DropForeignKey
ALTER TABLE "OccurrenceOverride" DROP CONSTRAINT "OccurrenceOverride_ruleId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Rule_id_householdId_key" ON "Rule"("id", "householdId");

-- AddForeignKey
ALTER TABLE "OccurrenceOverride" ADD CONSTRAINT "OccurrenceOverride_ruleId_householdId_fkey" FOREIGN KEY ("ruleId", "householdId") REFERENCES "Rule"("id", "householdId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Amounts are whole cents (percentages, whole hundredths of a percent). Each
-- check is true when the column is NULL, so optional values pass.

ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_amount_cents" CHECK ("amount" = round("amount", 2));

ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_fixed_cents"
  CHECK ("mode" <> 'FIXED' OR "value" = round("value", 2));

ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_percent_hundredths"
  CHECK ("mode" <> 'PERCENT' OR "value" = round("value", 2));

ALTER TABLE "OccurrenceOverride" ADD CONSTRAINT "OccurrenceOverride_confirmed_cents"
  CHECK ("confirmedAmount" IS NULL OR "confirmedAmount" = round("confirmedAmount", 2));
