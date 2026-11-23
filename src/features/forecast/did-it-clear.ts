import "server-only";
import type { PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";
import type { ClearAnswerInput } from "@/features/rules/input";
import { dateOf, lockRule, RuleInputError } from "@/features/rules/service";
import { addDays, todayIn, type IsoDate } from "@/lib/calendar-date";
import { needsAttention, type ClearQuestion } from "./attention";
import { buildForecast } from "./engine";
import { loadForecastInput } from "./queries";

/**
 * "Did it clear?": an open occurrence dated on or before an account's latest
 * balance. Only a question that is open right now can be answered, worked out
 * here from the same forecast Home shows, never from what the browser says.
 */

type Options = { environment: PlaidEnvironment; now?: Date };

export async function openClearQuestions(db: PrismaClient, householdId: string, options: Options): Promise<ClearQuestion[]> {
  const { timeZone } = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  if (!timeZone) return [];
  const today = todayIn(timeZone, options.now);
  const input = await loadForecastInput(db, householdId, { environment: options.environment, timeZone, today });
  return needsAttention(buildForecast(input), input).didItClear;
}

/** Cleared marks the occurrence Paid; Still pending moves it to the day after that account's balance. */
export async function answerClearQuestion(
  db: PrismaClient,
  householdId: string,
  userId: string,
  ruleId: string,
  scheduledOn: IsoDate,
  input: ClearAnswerInput,
  options: Options,
): Promise<void> {
  const question = (await openClearQuestions(db, householdId, options)).find(
    (q) => q.occurrence.ruleId === ruleId && q.occurrence.scheduledOn === scheduledOn && q.account.id === input.accountId,
  );
  if (!question) throw new RuleInputError("question_not_found");

  const fields = input.answer === "cleared" ? { status: "PAID" as const } : { movedTo: dateOf(addDays(question.snapshotDate, 1)) };
  const scheduled = dateOf(scheduledOn);
  await db.$transaction(async (tx) => {
    await lockRule(tx, householdId, ruleId);
    await tx.occurrenceOverride.upsert({
      where: { ruleId_scheduledOn: { ruleId, scheduledOn: scheduled } },
      create: { householdId, ruleId, scheduledOn: scheduled, ...fields, updatedByUserId: userId },
      update: { ...fields, updatedByUserId: userId },
    });
  });
}
