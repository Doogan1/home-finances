-- Payments: bank transactions matched to bills and income, the "not this one"
-- answers, and where a rule's estimate comes from. Purely additive.

-- CreateEnum
CREATE TYPE "EstimateMode" AS ENUM ('FIXED', 'VARIES');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('AUTO', 'PERSON');

-- AlterTable
ALTER TABLE "Rule" ADD COLUMN     "estimateMode" "EstimateMode" NOT NULL DEFAULT 'FIXED';

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "scheduledOn" DATE,
    "source" "PaymentSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchDecline" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "payeeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchDecline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");

-- CreateIndex
CREATE INDEX "Payment_householdId_idx" ON "Payment"("householdId");

-- CreateIndex
CREATE INDEX "Payment_ruleId_scheduledOn_idx" ON "Payment"("ruleId", "scheduledOn");

-- CreateIndex
CREATE INDEX "MatchDecline_householdId_idx" ON "MatchDecline"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchDecline_ruleId_transactionId_key" ON "MatchDecline"("ruleId", "transactionId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_ruleId_householdId_fkey" FOREIGN KEY ("ruleId", "householdId") REFERENCES "Rule"("id", "householdId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecline" ADD CONSTRAINT "MatchDecline_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecline" ADD CONSTRAINT "MatchDecline_ruleId_householdId_fkey" FOREIGN KEY ("ruleId", "householdId") REFERENCES "Rule"("id", "householdId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecline" ADD CONSTRAINT "MatchDecline_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
