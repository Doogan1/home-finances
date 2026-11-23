import "server-only";
import type { PlaidEnvironment, Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ClearAnswerInput } from "@/features/rules/input";
import { dateOf, lockRule, RuleInputError } from "@/features/rules/service";
import { MAX_MOVE_DAYS } from "@/features/rules/versions";
import { addDays, daysBetween, todayIn, type IsoDate } from "@/lib/calendar-date";
import { needsAttention, type ClearQuestion } from "./attention";
import { buildForecast } from "./engine";
import { loadForecastInput } from "./queries";

/**
 * "Did it clear?": an open occurrence dated on or before an account's latest
 * balance. Only a question that is open right now can be answered, worked out
 * here from the same forecast Home shows, never from what the browser says.
 */

type Options = { environment: PlaidEnvironment; now?: Date };

export async function openClearQuestions(db: PrismaClient | Prisma.TransactionClient, householdId: string, options: Options): Promise<ClearQuestion[]> {
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
  const scheduled = dateOf(scheduledOn);
  await db.$transaction(async (tx) => {
    // A rule that is not this household's, or is archived, has no open question.
    await lockRule(tx, householdId, ruleId).catch((error: unknown) => {
      if (error instanceof RuleInputError && (error.code === "rule_not_found" || error.code === "rule_archived")) {
        throw new RuleInputError("question_not_found");
      }
      throw error;
    });
    // Checked under the lock, so a second answer or an edit saved meanwhile is seen.
    const question = (await openClearQuestions(tx, householdId, options)).find(
      (q) => q.occurrence.ruleId === ruleId && q.occurrence.scheduledOn === scheduledOn && q.account.id === input.accountId,
    );
    if (!question) throw new RuleInputError("question_not_found");
    let fields: { status: "PAID" } | { movedTo: Date | null };
    if (input.answer === "cleared") fields = { status: "PAID" };
    else {
      // The same rules as any other move: none when it lands on the scheduled date, and never too far from it.
      const movedTo = addDays(question.snapshotDate, 1);
      if (Math.abs(daysBetween(scheduledOn, movedTo)) > MAX_MOVE_DAYS) throw new RuleInputError("move_out_of_range");
      fields = { movedTo: movedTo === scheduledOn ? null : dateOf(movedTo) };
    }
    await tx.occurrenceOverride.upsert({
      where: { ruleId_scheduledOn: { ruleId, scheduledOn: scheduled } },
      create: { householdId, ruleId, scheduledOn: scheduled, ...fields, updatedByUserId: userId },
      update: { ...fields, updatedByUserId: userId },
    });
  });
}
