import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { daysBetween, type IsoDate } from "@/lib/calendar-date";
import type { OccurrenceEditInput } from "./input";
import { ruleOccurrences } from "./recurrence";
import { dateOf, lockRule, RuleInputError } from "./service";
import { MAX_MOVE_DAYS } from "./versions";

/**
 * The person's edit of one occurrence (status, confirmed amount, a move, a
 * note), keyed by the date the rule produced so it survives a new version.
 * Each write locks the rule's row first, like every version change, so an edit
 * and a "Change from…" never interleave.
 */

export async function saveOccurrenceEdit(
  db: PrismaClient,
  householdId: string,
  userId: string,
  ruleId: string,
  scheduledOn: IsoDate,
  input: OccurrenceEditInput,
): Promise<{ saved: boolean }> {
  const movedTo = input.movedTo === scheduledOn ? null : input.movedTo;
  return db.$transaction(async (tx) => {
    const { versions } = await lockRule(tx, householdId, ruleId);
    if (ruleOccurrences(versions, scheduledOn, scheduledOn).length === 0) throw new RuleInputError("occurrence_not_found");
    if (input.status === "CONFIRMED" && input.confirmedAmount === null) throw new RuleInputError("confirmed_needs_amount");
    if (movedTo !== null && Math.abs(daysBetween(scheduledOn, movedTo)) > MAX_MOVE_DAYS) throw new RuleInputError("move_out_of_range");

    const key = { householdId, ruleId, scheduledOn: dateOf(scheduledOn) };
    if (input.status === "PLANNED" && input.confirmedAmount === null && movedTo === null && input.note === null) {
      // An edit that says nothing is no edit: the occurrence goes back to the rule.
      await tx.occurrenceOverride.deleteMany({ where: key });
      return { saved: false };
    }
    const fields = {
      status: input.status,
      confirmedAmount: input.confirmedAmount,
      movedTo: movedTo === null ? null : dateOf(movedTo),
      note: input.note,
      updatedByUserId: userId,
    };
    await tx.occurrenceOverride.upsert({
      where: { ruleId_scheduledOn: { ruleId, scheduledOn: key.scheduledOn } },
      create: { ...key, ...fields },
      update: fields,
    });
    return { saved: true };
  });
}

/** Reset to rule: deletes the edit, whether or not the rule still produces that date. */
export async function resetOccurrenceEdit(db: PrismaClient, householdId: string, ruleId: string, scheduledOn: IsoDate): Promise<{ removed: number }> {
  return db.$transaction(async (tx) => {
    await lockRule(tx, householdId, ruleId);
    const { count } = await tx.occurrenceOverride.deleteMany({ where: { householdId, ruleId, scheduledOn: dateOf(scheduledOn) } });
    return { removed: count };
  });
}
